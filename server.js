// server.js — Review Studio backend
// Holds your secret keys, talks to Claude + Resend. Never expose keys in the browser.

const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// --- lightweight config storage (JSON file) ---
// Each property gets a short ID; the QR only needs to hold that ID,
// keeping the code sparse and easy to scan. Editing config later keeps
// the same QR. On Render's free tier the filesystem resets on redeploy,
// so this persists between visits but not across redeploys — fine for
// launch; swap to a real DB later for permanence.
// On Render, mount a persistent disk at /data so storage survives restarts.
// Locally it falls back to ./data. Override with DATA_DIR if needed.
const DATA_DIR = process.env.DATA_DIR || (fs.existsSync("/data") ? "/data" : path.join(__dirname, "data"));
const STORE_FILE = path.join(DATA_DIR, "configs.json");
function loadStore() {
  try { return JSON.parse(fs.readFileSync(STORE_FILE, "utf8")); }
  catch (e) { return {}; }
}
function saveStore(obj) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STORE_FILE, JSON.stringify(obj, null, 2));
    return true;
  } catch (e) { console.error("save failed:", e.message); return false; }
}
function shortId() {
  return crypto.randomBytes(4).toString("hex").slice(0, 6); // e.g. "a7f3c1"
}
// Stable ID derived from the Google Place ID, so the SAME villa always maps to
// the SAME short URL/QR — owners can edit info forever without the link changing.
function idFromPlaceId(placeId) {
  return crypto.createHash("sha256").update(String(placeId)).digest("hex").slice(0, 8);
}

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const RESEND_KEY    = process.env.RESEND_API_KEY;
const GOOGLE_KEY    = process.env.GOOGLE_MAPS_API_KEY; // for live Google reviews
const FROM_EMAIL    = process.env.FROM_EMAIL || "feedback@yourdomain.com";
const ADMIN_TOKEN   = process.env.ADMIN_TOKEN || ""; // exports refuse without matching token
const MODEL         = "claude-sonnet-4-6"; // current model (Sonnet 4.6)

// --- middleware: admin-only guard for CRM exports ---
function requireAdmin(req, res, next) {
  const provided = req.query.token || req.headers["x-admin-token"] || "";
  if (!ADMIN_TOKEN) return res.status(500).send("Admin token not configured on server.");
  if (provided !== ADMIN_TOKEN) return res.status(401).send("Unauthorized. Add ?token=YOUR_ADMIN_TOKEN to the URL.");
  next();
}


// --- helper: fetch & strip a public web page to plain text ---
// Works for normal sites (e.g. your Wix site). Sites that block bots
// (Airbnb, Booking) will fail here on purpose — those use manual paste.
async function fetchWebsiteText(url) {
  try {
    if (!/^https?:\/\//i.test(url)) url = "https://" + url;
    const r = await fetch(url, {
      headers: { "user-agent": "Mozilla/5.0 (compatible; ReviewStudio/1.0)" },
      redirect: "follow",
    });
    if (!r.ok) return "";
    let html = await r.text();
    // crude but effective text extraction
    html = html.replace(/<script[\s\S]*?<\/script>/gi, " ")
               .replace(/<style[\s\S]*?<\/style>/gi, " ")
               .replace(/<[^>]+>/g, " ")
               .replace(/&nbsp;/g, " ")
               .replace(/&amp;/g, "&")
               .replace(/\s+/g, " ")
               .trim();
    return html.slice(0, 12000); // keep prompt sane
  } catch (e) {
    console.error("website fetch failed:", e.message);
    return "";
  }
}

// --- helper: try to find a logo/brand image on a website ---
// Looks for og:image, apple-touch-icon, then favicon. Returns an absolute URL.
async function fetchWebsiteLogo(url) {
  try {
    if (!/^https?:\/\//i.test(url)) url = "https://" + url;
    const r = await fetch(url, {
      headers: { "user-agent": "Mozilla/5.0 (compatible; ReviewStudio/1.0)" },
      redirect: "follow",
    });
    if (!r.ok) return "";
    const html = await r.text();
    const base = new URL(r.url || url);
    const abs = (u) => { try { return new URL(u, base).href; } catch { return ""; } };

    // 1) og:image (usually the brand/preview image)
    let m = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
         || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    if (m) return abs(m[1]);
    // 2) apple-touch-icon (usually a clean square logo)
    m = html.match(/<link[^>]+rel=["'][^"']*apple-touch-icon[^"']*["'][^>]+href=["']([^"']+)["']/i);
    if (m) return abs(m[1]);
    // 3) any icon / favicon
    m = html.match(/<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]+href=["']([^"']+)["']/i);
    if (m) return abs(m[1]);
    // 4) default favicon location
    return abs("/favicon.ico");
  } catch (e) {
    console.error("logo fetch failed:", e.message);
    return "";
  }
}

// --- helper: follow a Google Maps share link and extract place name + coords ---
// Handles maps.app.goo.gl short links and full /place/ URLs.
async function resolveMapsLink(url) {
  try {
    if (!/^https?:\/\//i.test(url)) url = "https://" + url;
    const r = await fetch(url, {
      headers: { "user-agent": "Mozilla/5.0 (compatible; ReviewStudio/1.0)" },
      redirect: "follow",
    });
    const finalUrl = r.url || url;
    // /place/NAME/@lat,lng  → pull the name segment and coords
    let name = "";
    const placeMatch = finalUrl.match(/\/place\/([^/@]+)/);
    if (placeMatch) {
      name = decodeURIComponent(placeMatch[1].replace(/\+/g, " ")).trim();
    }
    let lat = "", lng = "";
    const coordMatch = finalUrl.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
    if (coordMatch) { lat = coordMatch[1]; lng = coordMatch[2]; }
    return { name, lat, lng, finalUrl };
  } catch (e) {
    console.error("maps link resolve failed:", e.message);
    return { name: "", lat: "", lng: "", finalUrl: "" };
  }
}

// --- helper: resolve a current Place ID from a business name + location ---
// Text Search returns the live Place ID, avoiding stale/cached IDs.
async function resolvePlaceId(name, loc) {
  if (!GOOGLE_KEY || !name) return "";
  try {
    const r = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Goog-Api-Key": GOOGLE_KEY,
        "X-Goog-FieldMask": "places.id,places.displayName",
      },
      body: JSON.stringify({ textQuery: [name, loc].filter(Boolean).join(" ") }),
    });
    if (!r.ok) { console.error("Text Search", r.status, await r.text()); return ""; }
    const d = await r.json();
    return (d.places && d.places[0] && d.places[0].id) ? d.places[0].id : "";
  } catch (e) {
    console.error("place lookup failed:", e.message);
    return "";
  }
}

// --- helper: pull live Google reviews via Places API (New) ---
// If no placeId given, looks one up from name+loc first.
async function fetchGoogleReviews(placeId, name, loc) {
  if (!GOOGLE_KEY) return { text: "", placeId: "" };
  try {
    let id = placeId;
    // If no ID, or the given ID fails, resolve fresh from the name.
    if (!id) id = await resolvePlaceId(name, loc);
    if (!id) return { text: "", placeId: "" };

    let r = await fetch("https://places.googleapis.com/v1/places/" + encodeURIComponent(id), {
      headers: {
        "X-Goog-Api-Key": GOOGLE_KEY,
        "X-Goog-FieldMask": "displayName,rating,userRatingCount,reviews",
      },
    });
    // Stale/invalid ID? Re-resolve by name and retry once.
    if (r.status === 404 || r.status === 400) {
      const fresh = await resolvePlaceId(name, loc);
      if (fresh && fresh !== id) {
        id = fresh;
        r = await fetch("https://places.googleapis.com/v1/places/" + encodeURIComponent(id), {
          headers: {
            "X-Goog-Api-Key": GOOGLE_KEY,
            "X-Goog-FieldMask": "displayName,rating,userRatingCount,reviews",
          },
        });
      }
    }
    if (!r.ok) { console.error("Places API", r.status, await r.text()); return { text: "", placeId: id }; }
    const d = await r.json();
    const reviews = (d.reviews || [])
      .map(rv => (rv.text && rv.text.text) ? rv.text.text : "")
      .filter(Boolean);
    return { text: reviews.join("\n\n"), placeId: id };
  } catch (e) {
    console.error("google reviews failed:", e.message);
    return { text: "", placeId: "" };
  }
}

// --- helper: call Claude ---
async function callClaude(prompt) {
  if (!ANTHROPIC_KEY) {
    const err = new Error("no_key");
    err.userMessage = "The review writer isn't configured yet (missing API key).";
    throw err;
  }
  let lastErr;
  // Retry once on transient failures (network blip, 429, 5xx).
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": ANTHROPIC_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 1024,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      if (r.ok) {
        const data = await r.json();
        return data.content.filter(b => b.type === "text").map(b => b.text).join("").trim();
      }
      const body = await r.text();
      const err = new Error("Anthropic " + r.status + ": " + body);
      // Classify into a friendly message
      if (r.status === 401) err.userMessage = "The review writer's API key is invalid.";
      else if (r.status === 400 && /credit|billing/i.test(body)) err.userMessage = "The review writer is out of credit. Please top up the Anthropic account.";
      else if (r.status === 429) err.userMessage = "The writer is busy right now — please try again in a moment.";
      else if (r.status >= 500) err.userMessage = "The writer had a temporary glitch — please try again.";
      else err.userMessage = "Couldn't write the review just now — please try again.";
      // Retry only on transient (429/5xx); otherwise fail fast
      if (r.status === 429 || r.status >= 500) { lastErr = err; continue; }
      throw err;
    } catch (e) {
      lastErr = e;
      if (e.userMessage && !/try again/i.test(e.userMessage)) throw e; // non-transient
      // network error or transient — loop will retry once
    }
  }
  if (!lastErr.userMessage) lastErr.userMessage = "Couldn't reach the writer — please check the connection and try again.";
  throw lastErr;
}

// === 0. RESOLVE a Google Maps link → name, address, rating, placeId ===
app.post("/api/resolve-maps", async (req, res) => {
  try {
    const { mapsUrl } = req.body;
    if (!mapsUrl) return res.status(400).json({ error: "no maps url" });

    // 1) follow the link to get the place name
    const linkInfo = await resolveMapsLink(mapsUrl);
    if (!linkInfo.name) {
      return res.json({ ok: false, reason: "Couldn't read a place name from that link." });
    }

    // 2) resolve to a live Place ID + identity via Text Search (this works on your key)
    if (!GOOGLE_KEY) return res.json({ ok: false, reason: "No Google key configured." });

    // Build request body. If we have coordinates from the Maps link, bias the
    // search tightly around them so we get THIS villa, not a same-named place
    // in another country.
    const searchBody = { textQuery: linkInfo.name };
    if (linkInfo.lat && linkInfo.lng) {
      searchBody.locationBias = {
        circle: {
          center: { latitude: parseFloat(linkInfo.lat), longitude: parseFloat(linkInfo.lng) },
          radius: 500.0, // metres — tight, since we know the exact spot
        },
      };
    }

    const r = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Goog-Api-Key": GOOGLE_KEY,
        "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.userRatingCount,places.websiteUri,places.primaryTypeDisplayName",
      },
      body: JSON.stringify(searchBody),
    });
    if (!r.ok) { const t = await r.text(); return res.json({ ok: false, reason: "Google lookup failed: " + t }); }
    const d = await r.json();

    // Pick the result closest to the link's coordinates, not just the first.
    let p = d.places && d.places[0];
    if (linkInfo.lat && linkInfo.lng && d.places && d.places.length > 1) {
      const tLat = parseFloat(linkInfo.lat), tLng = parseFloat(linkInfo.lng);
      let best = null, bestDist = Infinity;
      for (const cand of d.places) {
        if (cand.location) {
          const dLat = cand.location.latitude - tLat, dLng = cand.location.longitude - tLng;
          const dist = dLat * dLat + dLng * dLng;
          if (dist < bestDist) { bestDist = dist; best = cand; }
        }
      }
      if (best) p = best;
    }
    if (!p) return res.json({ ok: false, reason: "Place not found on Google." });

    // Try to grab a logo from the listing's website (best-effort, non-blocking on failure)
    const websiteUri = p.websiteUri || "";
    const logo = websiteUri ? await fetchWebsiteLogo(websiteUri) : "";

    res.json({
      ok: true,
      name: (p.displayName && p.displayName.text) || linkInfo.name,
      address: p.formattedAddress || "",
      rating: p.rating || null,
      reviewCount: p.userRatingCount || 0,
      website: websiteUri,
      logo: logo,
      type: (p.primaryTypeDisplayName && p.primaryTypeDisplayName.text) || "",
      placeId: p.id || "",
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// === SAVE a property config → returns a short id for the QR ===
app.post("/api/save-config", (req, res) => {
  try {
    const cfg = req.body && req.body.config;
    if (!cfg || !cfg.name) return res.status(400).json({ error: "missing config" });
    const store = loadStore();
    // Prefer a STABLE id tied to the Google Place ID, so the same property always
    // gets the same URL/QR and editing just updates the existing record.
    let id;
    if (cfg.placeId) {
      id = idFromPlaceId(cfg.placeId);
    } else if (req.body.id && store[req.body.id]) {
      id = req.body.id; // editing an existing record with no placeId
    } else {
      id = shortId();
      while (store[id]) id = shortId();
    }
    // Preserve any existing guest submissions on this property when updating config.
    const existing = store[id] || {};
    store[id] = Object.assign({}, existing, cfg, {
      submissions: existing.submissions || [],
    });
    if (!saveStore(store)) return res.status(500).json({ error: "could not save" });
    res.json({ id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// === GET a property config by short id (guest scan) ===
app.get("/api/config/:id", (req, res) => {
  const store = loadStore();
  const cfg = store[req.params.id];
  if (!cfg) return res.status(404).json({ error: "not found" });
  // Never send the stored submissions (other guests' data) to a guest's browser.
  const { submissions, ...publicCfg } = cfg;
  res.json({ config: publicCfg });
});

// === LOG a guest submission for CRM (rating, chips, review, feedback) ===
app.post("/api/log-submission", (req, res) => {
  try {
    const { propertyId, rating, chips, review, feedback, posted, lang } = req.body || {};
    if (!propertyId) return res.status(400).json({ error: "no propertyId" });
    const store = loadStore();
    const rec = store[propertyId];
    if (!rec) return res.status(404).json({ error: "unknown property" });
    if (!rec.submissions) rec.submissions = [];
    rec.submissions.push({
      at: new Date().toISOString(),
      rating: rating || null,
      chips: chips || [],
      review: review || "",
      feedback: feedback || "",
      posted: posted || "",      // "public" | "private" | "rating-only"
      lang: lang || "",
    });
    saveStore(store);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// === OWNER: retrieve collected submissions (CRM) for a property ===
app.get("/api/submissions/:id", (req, res) => {
  const store = loadStore();
  const rec = store[req.params.id];
  if (!rec) return res.status(404).json({ error: "not found" });
  const subs = rec.submissions || [];
  // simple rollup for quick CRM insight
  const rated = subs.filter(s => s.rating);
  const avg = rated.length ? (rated.reduce((a, s) => a + s.rating, 0) / rated.length).toFixed(2) : null;
  res.json({
    property: rec.name,
    total: subs.length,
    averageRating: avg,
    byOutcome: subs.reduce((m, s) => { m[s.posted] = (m[s.posted] || 0) + 1; return m; }, {}),
    submissions: subs,
  });
});

// --- helper: turn rows into CSV safely (quotes, commas, newlines handled) ---
function toCsv(headers, rows) {
  const esc = (v) => {
    const s = (v === null || v === undefined) ? "" : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [headers.join(",")];
  for (const r of rows) lines.push(headers.map(h => esc(r[h])).join(","));
  return lines.join("\n");
}

// === OWNER: download CSV of one property's submissions ===
app.get("/api/export/:id.csv", requireAdmin, (req, res) => {
  const store = loadStore();
  const rec = store[req.params.id];
  if (!rec) return res.status(404).send("not found");
  const rows = (rec.submissions || []).map(s => ({
    property: rec.name,
    date: s.at,
    rating: s.rating,
    outcome: s.posted,
    language: s.lang,
    chips: (s.chips || []).join("; "),
    review: s.review,
    private_feedback: s.feedback,
  }));
  const csv = toCsv(["property","date","rating","outcome","language","chips","review","private_feedback"], rows);
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="${(rec.name||"property").replace(/[^a-z0-9]+/gi,"_")}_reviews.csv"`);
  res.send(csv);
});

// === OWNER: download CSV of ALL properties' submissions ===
app.get("/api/export-all.csv", requireAdmin, (req, res) => {
  const store = loadStore();
  const rows = [];
  for (const id of Object.keys(store)) {
    const rec = store[id];
    for (const s of (rec.submissions || [])) {
      rows.push({
        property: rec.name,
        property_id: id,
        date: s.at,
        rating: s.rating,
        outcome: s.posted,
        language: s.lang,
        chips: (s.chips || []).join("; "),
        review: s.review,
        private_feedback: s.feedback,
      });
    }
  }
  const csv = toCsv(["property","property_id","date","rating","outcome","language","chips","review","private_feedback"], rows);
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", 'attachment; filename="all_reviews.csv"');
  res.send(csv);
});

// === 1. EXTRACTION: combine website + Google reviews + pasted text into chips ===
app.post("/api/extract", async (req, res) => {
  try {
    const { name, type, loc, source: rawSource, websiteUrl, placeId } = req.body;
    // Cap the pasted reviews so a huge paste can't dominate by sheer volume.
    const source = rawSource ? String(rawSource).slice(0, 6000) : "";

    // Gather all three sources in parallel
    const [siteText, googleResult] = await Promise.all([
      websiteUrl ? fetchWebsiteText(websiteUrl) : Promise.resolve(""),
      fetchGoogleReviews(placeId, name, loc),
    ]);
    const googleText = googleResult.text;

    // Label each source and note which are present, so we can instruct balance.
    const present = [];
    if (siteText) present.push("the website");
    if (googleText) present.push("Google reviews");
    if (source) present.push("Airbnb/Booking reviews");
    const balanceNote = present.length > 1
      ? `\nIMPORTANT — BALANCE THE SOURCES: You have ${present.length} sources (${present.join(", ")}). Draw chips fairly from ALL of them, not just whichever is longest. The website describes the property's features and character; the reviews capture what guests actually felt and praised. A good set blends both: concrete features/amenities (often from the website) AND experiential, emotional, or service themes (often from reviews). Aim for a roughly even spread across sources — do not let the source with the most text dominate.\n`
      : "";

    const combined = [
      siteText   ? "=== WEBSITE CONTENT (property features & character) ===\n" + siteText : "",
      googleText ? "=== LIVE GOOGLE REVIEWS (guest experiences) ===\n" + googleText : "",
      source     ? "=== PASTED AIRBNB/BOOKING REVIEWS (guest experiences) ===\n" + source : "",
    ].filter(Boolean).join("\n\n");

    const prompt =
`You are setting up a review tool for "${name}", a ${type} in ${loc}.
Below is source material drawn from the business's own website, its live Google reviews, and reviews the owner pasted from other platforms.

SOURCE:
${combined || "(none available — use sensible defaults for this type of business)"}
${balanceNote}
Identify the SPECIFIC things guests love and mention repeatedly — real features, named staff, signature dishes, specific experiences, the genuine character of this place. Turn them into short tappable chips (2-4 words each) a future guest could tap to describe their own visit.

Group into 3-4 themed categories. Prefer specific over generic ("Rock-climbing wall" beats "good facilities"; "Gus Bayu's hospitality" beats "friendly staff") — but only use specifics that actually appear in the source.

Return ONLY valid JSON, no markdown fences, in this exact shape:
{"groups":[{"h":"Category name","c":["chip","chip","chip","chip","chip","chip"]}]}`;

    let t = await callClaude(prompt);
    t = t.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(t);
    // report back what we managed to read, for owner transparency
    res.json({
      groups: parsed.groups,
      resolvedPlaceId: googleResult.placeId || placeId || "",
      sources: {
        website: !!siteText,
        google: !!googleText,
        pasted: !!source,
      },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// === 2. REVIEW GENERATION ===
app.post("/api/generate", async (req, res) => {
  try {
    const { name, type, loc, rating, chips, note, tone, lang } = req.body;
    const typeWord = type === "restaurant" ? "restaurant/café"
                   : type === "villa" ? "villa / holiday stay" : "business";
    const prompt =
`Help a guest write an authentic Google review they'll post under their own name.

Business: ${name} (${typeWord}) in ${loc}.
Stars: ${rating}/5.
Things they tapped: ${(chips && chips.length) ? chips.join(", ") : "(none)"}.
Their own words: ${note ? `"${note}"` : "(none)"}.
Their writing voice: ${tone}.
Write the review in this language: ${lang}.

Rules:
- 70-110 words. Specific, warm, genuinely human — not marketing copy.
- Strongly match the requested voice (${tone}). If "short and to the point", keep it ~45 words.
- If they gave their own words, make that the emotional centre and mirror their phrasing.
- Weave tapped items in naturally; never list them.
- Match honesty to ${rating} stars — don't gush if under 5.
- No emojis, hashtags, or sign-off. Output ONLY the review, in ${lang}.`;
    const review = await callClaude(prompt);
    res.json({ review });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message, userMessage: e.userMessage || "Couldn't write the review just now — please try again." });
  }
});

// === 3. PRIVATE FEEDBACK → email the owner via Resend ===
app.post("/api/feedback", async (req, res) => {
  try {
    const { ownerEmail, businessName, rating, message, chips, guestReview } = req.body;
    if (!ownerEmail) return res.status(400).json({ error: "no owner email configured" });

    const html = `
      <div style="font-family:Georgia,serif;color:#33352f;max-width:560px">
        <h2 style="color:#2f3b32">Private guest feedback — ${businessName}</h2>
        <p style="font-size:18px;color:#b08f6a">${"★".repeat(rating||0)}${"☆".repeat(5-(rating||0))}</p>
        ${message ? `<p><b>What could be better:</b><br>${escapeHtml(message)}</p>` : ""}
        ${guestReview ? `<p><b>Their review text:</b><br>${escapeHtml(guestReview)}</p>` : ""}
        ${chips && chips.length ? `<p><b>They tapped:</b> ${chips.map(escapeHtml).join(", ")}</p>` : ""}
        <hr style="border:none;border-top:1px solid #ddd3c2">
        <p style="font-size:12px;color:#7d7a6f">Sent privately via your Review Studio. The guest chose not to post this publicly.</p>
      </div>`;

    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + RESEND_KEY,
      },
      body: JSON.stringify({
        from: `Review Studio <${FROM_EMAIL}>`,
        to: [ownerEmail],
        subject: `Private feedback (${rating}★) — ${businessName}`,
        html,
      }),
    });
    if (!r.ok) {
      const t = await r.text();
      throw new Error("Resend " + r.status + ": " + t);
    }
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// =====================================================================
// FUTURE FAMILY HOLIDAYS — the Endless Summer family game, served at /play
// Plays are saved on the same /data disk as the review configs.
// Team download: /api/ffh/export.csv?token=ADMIN_TOKEN
// Optional env: PUBLIC_URL (e.g. https://endlesssummerbali.com) for link
// previews, META_PIXEL_ID to switch on the Meta pixel, META_CAPI_TOKEN to
// also send the key milestones to Meta server-side (Conversions API),
// META_TEST_EVENT_CODE while testing in Events Manager.
// Funnel + drop-off stats page: /play/stats?token=ADMIN_TOKEN
// =====================================================================
app.set("trust proxy", true);
const FFH_DIR   = path.join(__dirname, "ffh");
const FFH_FILE  = path.join(DATA_DIR, "ffh-plays.json");
const PIXEL_ID  = (process.env.META_PIXEL_ID || "").replace(/[^0-9]/g, "");
let ffhPage = null;
function ffhHtml(req) {
  if (!ffhPage) ffhPage = fs.readFileSync(path.join(FFH_DIR, "index.html"), "utf8");
  const base = (process.env.PUBLIC_URL || (req.protocol + "://" + req.get("host"))).replace(/\/$/, "");
  const pixel = PIXEL_ID ? `<script>(function(){try{if(localStorage.getItem('esv_ffh_noads'))return}catch(e){}!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','${PIXEL_ID}');fbq('track','PageView');})();</script>` : "";
  return ffhPage.split("{{BASE}}").join(base).replace("<!--PIXEL-->", pixel);
}
app.get(["/play", "/play/", "/play/index.html"], (req, res) => {
  try { res.set("Cache-Control", "no-cache").type("html").send(ffhHtml(req)); }
  catch (e) { console.error(e); res.status(500).send("Game not found"); }
});
app.use("/play", express.static(FFH_DIR, { maxAge: "7d", index: false }));

function loadPlays() { try { return JSON.parse(fs.readFileSync(FFH_FILE, "utf8")); } catch (e) { return {}; } }
function savePlays(obj) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = FFH_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, FFH_FILE);
    return true;
  } catch (e) { console.error("ffh save failed:", e.message); return false; }
}

// === GAME: save (or update) one play — called as the family goes through the cards ===
app.post("/api/ffh/play", (req, res) => {
  try {
    const { device, run } = req.body || {};
    const playId = run && String(run.playId || "").slice(0, 80);
    if (!playId) return res.status(400).json({ error: "no playId" });
    const plays = loadPlays();
    const now = new Date().toISOString();
    const prev = plays[playId];
    plays[playId] = { device: String(device || "").slice(0, 80), firstAt: prev ? prev.firstAt : now, updatedAt: now, run };
    savePlays(plays);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// === TEAM: every play as a spreadsheet ===
app.get("/api/ffh/export.csv", requireAdmin, (req, res) => {
  const plays = loadPlays();
  const j = v => (v === undefined || v === null) ? "" : (typeof v === "string" ? v : JSON.stringify(v));
  const rows = Object.entries(plays).map(([id, p]) => {
    const r = p.run || {}, lead = r.lead || {};
    return {
      started: r.startedAt || p.firstAt, last_update: p.updatedAt, finished: r.finishedAt || "", completed: r.completed ? "yes" : "no",
      play_id: id, device: p.device, mode: r.mode, kids_ages: j(r.ages), city: r.city,
      persona: r.personaName || r.persona, second_persona: r.secondary, agreement: j(r.agreement),
      instagram_or_email: lead.contact || "", is_email: lead.isEmail ? "yes" : "", prize_entry: lead.consent ? "yes" : "",
      picks: j(r.picks), votes: j(r.players), beliefs: j(r.beliefs), sorted_items: j(r.ease), comments: j(r.notes),
      source: (r.utm || {}).utm_source || (r.utm || {}).ref || "", campaign: (r.utm || {}).utm_campaign || "", ad: (r.utm || {}).utm_content || "", from_meta_ad: (r.utm || {}).fbclid ? "yes" : "",
      villa_click: r.villaClicked ? "yes" : "",
      card_saved: r.imageSaved ? "yes" : "", caption_copied: r.shareCopied ? "yes" : "", music: r.music ? "on" : "off", read_aloud: r.readAloud ? "on" : "off",
    };
  }).sort((a, b) => String(b.started).localeCompare(String(a.started)));
  const headers = ["started","last_update","finished","completed","play_id","device","mode","kids_ages","city","persona","second_persona","agreement","instagram_or_email","is_email","prize_entry","picks","votes","beliefs","sorted_items","comments","source","campaign","ad","from_meta_ad","villa_click","card_saved","caption_copied","music","read_aloud"];
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", 'attachment; filename="future_family_holidays_plays.csv"');
  res.send(toCsv(headers, rows));
});
app.get("/api/ffh/export.json", requireAdmin, (req, res) => res.json(loadPlays()));

// === GAME: anonymous behaviour events (screens, cards, time, where people leave) ===
const FFH_EVENTS = path.join(DATA_DIR, "ffh-events.jsonl");
const CAPI_TOKEN = process.env.META_CAPI_TOKEN || "";
const CAPI_TEST  = process.env.META_TEST_EVENT_CODE || "";
const CAPI_MAP   = { game_complete: "CompleteRegistration", lead: "Lead", game_start: "GameStart" };
const clip = (v, n) => String(v === undefined || v === null ? "" : v).slice(0, n);
function sendToMeta(ev, ctx, req) {
  const name = CAPI_MAP[ev.name];
  if (!PIXEL_ID || !CAPI_TOKEN || !name || ev.phase === "kid") return;
  const user_data = { client_ip_address: req.ip, client_user_agent: clip(req.get("user-agent"), 400) };
  if (ctx.fbp) user_data.fbp = ctx.fbp;
  if (ctx.fbc) user_data.fbc = ctx.fbc;
  if (ctx.device) user_data.external_id = [crypto.createHash("sha256").update(ctx.device).digest("hex")];
  const body = { data: [{ event_name: name, event_time: Math.floor(Date.now() / 1000), event_id: ev.eventId, action_source: "website", event_source_url: ctx.page, user_data, custom_data: { content_name: "Future Family Holidays" } }] };
  if (CAPI_TEST) body.test_event_code = CAPI_TEST;
  fetch(`https://graph.facebook.com/v21.0/${PIXEL_ID}/events?access_token=${encodeURIComponent(CAPI_TOKEN)}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }).then(r => { if (!r.ok) r.text().then(t => console.error("Meta CAPI", r.status, t.slice(0, 300))); }).catch(e => console.error("Meta CAPI", e.message));
}
app.post("/api/ffh/events", (req, res) => {
  try {
    const b = req.body || {};
    const ctx = { device: clip(b.device, 80), session: clip(b.session, 60), fbp: clip(b.fbp, 120), fbc: clip(b.fbc, 300), page: clip(b.page, 300) };
    const utm = {};
    for (const k of ["utm_source","utm_medium","utm_campaign","utm_content","utm_term","ref"]) if (b.utm && b.utm[k]) utm[k] = clip(b.utm[k], 120);
    if (b.utm && b.utm.fbclid) utm.fbclid = "yes";
    const events = Array.isArray(b.events) ? b.events.slice(0, 50) : [];
    if (!events.length) return res.json({ ok: true });
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const lines = events.map(ev => JSON.stringify({
      at: new Date().toISOString(), device: ctx.device, session: ctx.session, utm,
      name: clip(ev.name, 40), t: Number(ev.t) || 0, playId: clip(ev.playId, 80), phase: clip(ev.phase, 20), idx: ev.idx, props: ev.props || {},
    })).join("\n") + "\n";
    fs.appendFileSync(FFH_EVENTS, lines);
    events.forEach(ev => sendToMeta(ev, ctx, req));
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});
function loadEvents() {
  try { return fs.readFileSync(FFH_EVENTS, "utf8").split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean); }
  catch (e) { return []; }
}
app.get("/api/ffh/events.csv", requireAdmin, (req, res) => {
  const rows = loadEvents().map(e => ({ at: e.at, session: e.session, play_id: e.playId, event: e.name, round: e.phase, card_no: e.idx, seconds_in: Math.round((e.t || 0) / 1000), details: JSON.stringify(e.props || {}), source: e.utm.utm_source || e.utm.ref || "", campaign: e.utm.utm_campaign || "", ad: e.utm.utm_content || "" }));
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", 'attachment; filename="future_family_holidays_events.csv"');
  res.send(toCsv(["at","session","play_id","event","round","card_no","seconds_in","details","source","campaign","ad"], rows));
});

// === TEAM: funnel, drop-off and time-per-card page ===
app.get("/play/stats", requireAdmin, (req, res) => {
  const evs = loadEvents();
  const days = Math.max(1, Math.min(365, parseInt(req.query.days, 10) || 90));
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const recent = evs.filter(e => e.at >= since);
  const sess = new Map();
  for (const e of recent) {
    let s = sess.get(e.session);
    if (!s) { s = { names: new Set(), parts: new Set(), utm: e.utm || {}, last: null, cards: 0 }; sess.set(e.session, s); }
    s.names.add(e.name);
    if (e.name === "part_reached") s.parts.add((e.props.round || "") + ":" + e.props.part);
    if (e.name === "card_answer") s.cards++;
    if (e.name === "leave" || e.name === "card_view" || e.name === "screen") s.last = e;
    if (e.utm && Object.keys(e.utm).length) s.utm = e.utm;
  }
  const all = [...sess.values()];
  const has = (s, n) => s.names.has(n);
  const steps = [
    ["Opened the game", s => has(s, "landing")],
    ["Tapped Let's play", s => has(s, "game_start")],
    ["Chose who's playing", s => has(s, "mode_chosen")],
    ["Finished ages & city", s => has(s, "ages_done")],
    ["Started the cards", s => s.parts.size > 0],
    ["Answered 5+ cards", s => s.cards >= 5],
    ["Answered 15+ cards", s => s.cards >= 15],
    ["Reached the last part", s => [...s.parts].some(p => /:(ease)$/.test(p))],
    ["Finished (saw persona)", s => has(s, "game_complete")],
    ["Entered the prize", s => has(s, "lead")],
    ["Saved / shared card", s => has(s, "card_shared")],
    ["Clicked to the villa", s => has(s, "villa_click")],
  ];
  const top = all.filter(s => has(s, "landing")).length || all.length || 1;
  const funnel = steps.map(([label, fn]) => { const n = all.filter(fn).length; return { label, n, pct: Math.round(n * 100 / top) }; });
  // where unfinished games stopped
  const stops = {};
  for (const s of all) {
    if (has(s, "game_complete") || !s.last) continue;
    const l = s.last, p = l.props || {};
    const SCREENS = { "s-intro": "Landing page", "s-pass": "Pass-the-phone page", "s-who": "Who's playing", "s-ages": "Ages & city", "s-section": "Part intro page", "s-deck": "Cards", "s-result": "Results page" };
    const cardName = `${p.title || p.card} (${l.phase === "kid" ? "kid round" : l.phase || ""})`;
    const key = (l.name === "leave" || l.name === "card_view") && p.card ? cardName : (SCREENS[p.screen || p.id] || p.screen || p.id);
    stops[key] = (stops[key] || 0) + 1;
  }
  const stopRows = Object.entries(stops).sort((a, b) => b[1] - a[1]).slice(0, 25);
  // time per card
  const times = {};
  for (const e of recent) if (e.name === "card_answer" && e.props.ms > 0 && e.props.ms < 300000) { const k = (e.props.title || e.props.card) + " · " + (e.phase === "kid" ? "kid round" : e.phase || ""); (times[k] = times[k] || []).push(e.props.ms); }
  const med = a => { const b = a.slice().sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
  const timeRows = Object.entries(times).map(([k, a]) => [k, med(a) / 1000, a.length]).sort((a, b) => b[1] - a[1]).slice(0, 30);
  const durs = recent.filter(e => e.name === "game_complete" && e.props.secs).map(e => e.props.secs);
  // by source
  const src = {};
  for (const s of all) {
    const k = (s.utm.utm_source || s.utm.ref || "direct") + (s.utm.utm_campaign ? " / " + s.utm.utm_campaign : "") + (s.utm.utm_content ? " / " + s.utm.utm_content : "");
    const r = src[k] = src[k] || { open: 0, start: 0, done: 0, lead: 0, share: 0 };
    if (has(s, "landing")) r.open++; if (has(s, "game_start")) r.start++; if (has(s, "game_complete")) r.done++; if (has(s, "lead")) r.lead++; if (has(s, "card_shared")) r.share++;
  }
  const srcRows = Object.entries(src).sort((a, b) => b[1].open - a[1].open);
  const modes = {}; recent.filter(e => e.name === "mode_chosen").forEach(e => modes[e.props.mode] = (modes[e.props.mode] || 0) + 1);
  const e = escapeHtml, tok = encodeURIComponent(req.query.token || "");
  res.type("html").send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Game stats · Future Family Holidays</title>
<style>body{font:15px/1.45 -apple-system,system-ui,sans-serif;margin:0;background:#FAF6EE;color:#1E1A16}main{max-width:860px;margin:0 auto;padding:20px 16px 60px}h1{font-size:24px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 8px}p.m{color:#6B5F53;margin:0 0 14px}table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #E2D6C2;border-radius:10px;overflow:hidden}td,th{padding:7px 10px;border-bottom:1px solid #EFE6D6;text-align:left;font-variant-numeric:tabular-nums}th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#6B5F53;background:#FAF6EE}.bar{height:10px;background:#FF851B;border-radius:5px}.r{text-align:right}a{color:#C45F0E}.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}.tile{background:#fff;border:1px solid #E2D6C2;border-radius:10px;padding:12px}.tile b{display:block;font-size:24px}</style></head><body><main>
<h1>Future Family Holidays · game stats</h1><p class="m">Last ${days} days · ${all.length} visits · <a href="?token=${tok}&days=7">7d</a> · <a href="?token=${tok}&days=30">30d</a> · <a href="?token=${tok}&days=90">90d</a> · <a href="/api/ffh/export.csv?token=${tok}">plays CSV</a> · <a href="/api/ffh/events.csv?token=${tok}">events CSV</a></p>
<div class="tiles"><div class="tile">Finished<b>${funnel[8].n}</b>${funnel[8].pct}% of visits</div><div class="tile">Prize entries<b>${funnel[9].n}</b>${funnel[9].pct}% of visits</div><div class="tile">Median time to finish<b>${durs.length ? Math.round(med(durs) / 60 * 10) / 10 + " min" : "–"}</b>${durs.length} finished games</div><div class="tile">Who played<b style="font-size:15px;margin-top:6px">${Object.entries(modes).map(([k, v]) => e(k) + " " + v).join(" · ") || "–"}</b></div></div>
<h2>Funnel</h2><table><tr><th>Step</th><th class="r">Visits</th><th class="r">%</th><th style="width:40%"></th></tr>${funnel.map(f => `<tr><td>${e(f.label)}</td><td class="r">${f.n}</td><td class="r">${f.pct}%</td><td><div class="bar" style="width:${f.pct}%"></div></td></tr>`).join("")}</table>
<h2>Where unfinished games stopped</h2><p class="m">The last screen or card before someone left without finishing.</p><table><tr><th>Last seen</th><th class="r">Visits</th></tr>${stopRows.map(([k, v]) => `<tr><td>${e(k)}</td><td class="r">${v}</td></tr>`).join("") || "<tr><td colspan=2>No data yet</td></tr>"}</table>
<h2>Slowest cards</h2><p class="m">Median seconds people spent before answering. Long times can mean "interesting" or "confusing".</p><table><tr><th>Card · round</th><th class="r">Median sec</th><th class="r">Answers</th></tr>${timeRows.map(([k, m, n]) => `<tr><td>${e(k)}</td><td class="r">${m.toFixed(1)}</td><td class="r">${n}</td></tr>`).join("") || "<tr><td colspan=3>No data yet</td></tr>"}</table>
<h2>By source / campaign / ad</h2><p class="m">From the utm_ tags on your links. DMs and bio links show as "direct" unless tagged.</p><table><tr><th>Source / campaign / ad</th><th class="r">Opened</th><th class="r">Started</th><th class="r">Finished</th><th class="r">Entered</th><th class="r">Shared</th></tr>${srcRows.map(([k, r]) => `<tr><td>${e(k)}</td><td class="r">${r.open}</td><td class="r">${r.start}</td><td class="r">${r.done}</td><td class="r">${r.lead}</td><td class="r">${r.share}</td></tr>`).join("")}</table>
</main></body></html>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Review Studio running on port " + PORT));
