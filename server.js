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
const ADMIN_TOKEN   = process.env.ADMIN_TOKEN || ""; // owner-only routes refuse without matching token
const MODEL         = "claude-sonnet-4-6"; // current model (Sonnet 4.6)

// Google Sheets mirror (optional). Set both to enable.
// SHEETS_WEBHOOK_URL is the /exec URL of the Apps Script web app; SHEETS_SECRET is
// a shared string that script checks, so a stranger who finds the URL can't write rows.
const SHEETS_WEBHOOK_URL = process.env.SHEETS_WEBHOOK_URL || "";
const SHEETS_SECRET      = process.env.SHEETS_SECRET || "";

// --- middleware: admin-only guard for owner routes (config writes, CRM reads, exports) ---
// Constant-time compare so the token can't be guessed a character at a time.
function tokenMatches(provided) {
  const a = Buffer.from(String(provided));
  const b = Buffer.from(ADMIN_TOKEN);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
function requireAdmin(req, res, next) {
  const provided = req.query.token || req.headers["x-admin-token"] || "";
  if (!ADMIN_TOKEN) return res.status(500).send("Admin token not configured on server.");
  if (!tokenMatches(provided)) return res.status(401).send("Unauthorized. Add ?token=YOUR_ADMIN_TOKEN to the URL.");
  next();
}

// --- crude in-memory rate limit -------------------------------------------
// /api/generate must stay open to guests (they arrive by QR with no credentials),
// so it's the one route a stranger could hammer to burn Anthropic credit.
// Cap each IP to a sane number of generations per window. Resets on restart,
// which is fine — this is a cost guard, not a security boundary.
const RATE = { windowMs: 10 * 60 * 1000, max: 20, hits: new Map() };
function rateLimit(req, res, next) {
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.ip || "unknown";
  const now = Date.now();
  const rec = RATE.hits.get(ip);
  if (!rec || now > rec.reset) {
    RATE.hits.set(ip, { count: 1, reset: now + RATE.windowMs });
  } else {
    rec.count++;
    if (rec.count > RATE.max) {
      return res.status(429).json({
        error: "rate_limited",
        userMessage: "That's a lot of rewrites in a short time — please wait a few minutes and try again.",
      });
    }
  }
  // Keep the map from growing forever on a long-lived process.
  if (RATE.hits.size > 5000) {
    for (const [k, v] of RATE.hits) if (now > v.reset) RATE.hits.delete(k);
  }
  next();
}

// --- helper: mirror one submission into the Google Sheet -------------------
// Fire-and-forget: a Sheets outage must never break a guest's submission, so
// failures are logged and swallowed. The sheet is a mirror, not the source of
// truth — configs.json on the persistent disk stays authoritative.
async function pushToSheet(row) {
  if (!SHEETS_WEBHOOK_URL) return { ok: false, reason: "not configured" };
  try {
    const r = await fetch(SHEETS_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(Object.assign({ secret: SHEETS_SECRET }, row)),
      redirect: "follow", // Apps Script /exec always 302s to its script.googleusercontent.com runner
    });
    if (!r.ok) {
      console.error("sheet push failed:", r.status, (await r.text()).slice(0, 300));
      return { ok: false, reason: "http " + r.status };
    }
    return { ok: true };
  } catch (e) {
    console.error("sheet push error:", e.message);
    return { ok: false, reason: e.message };
  }
}

// One shape for a sheet row, used by both the live append and the backfill,
// so the columns can never drift apart between the two paths.
function sheetRow(propertyId, rec, s) {
  return {
    date: s.at,
    property: rec.name || "",
    property_id: propertyId,
    rating: s.rating || "",
    outcome: s.posted || "",
    language: s.lang || "",
    chips: (s.chips || []).join("; "),
    review: s.review || "",
    private_feedback: s.feedback || "",
  };
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
// Owner-only: setup step, and it spends Google Places credit.
app.post("/api/resolve-maps", requireAdmin, async (req, res) => {
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
// Owner-only: an open version of this lets a stranger repoint any property's
// owner email (stealing the private feedback) or its Google review link.
app.post("/api/save-config", requireAdmin, (req, res) => {
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
    const entry = {
      at: new Date().toISOString(),
      rating: rating || null,
      chips: chips || [],
      review: review || "",
      feedback: feedback || "",
      posted: posted || "",      // "public" | "private" | "rating-only"
      lang: lang || "",
    };
    rec.submissions.push(entry);
    saveStore(store);
    // Mirror to the Google Sheet without making the guest wait on it.
    pushToSheet(sheetRow(propertyId, rec, entry));
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// === OWNER: retrieve collected submissions (CRM) for a property ===
// Owner-only: property IDs travel in the public QR URL, so without this guard
// anyone who scanned a code could read every guest's private feedback.
app.get("/api/submissions/:id", requireAdmin, (req, res) => {
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

// === OWNER: replay every stored submission into the Google Sheet ===
// Use after first connecting a sheet, or if the sheet ever falls behind.
// The Apps Script de-duplicates on (property_id, date), so running this twice
// is safe and will not double up rows.
app.get("/api/sync-sheet", requireAdmin, async (req, res) => {
  if (!SHEETS_WEBHOOK_URL) return res.status(400).json({ error: "SHEETS_WEBHOOK_URL not set on the server." });
  const store = loadStore();
  const rows = [];
  for (const id of Object.keys(store)) {
    const rec = store[id];
    for (const s of (rec.submissions || [])) rows.push(sheetRow(id, rec, s));
  }
  if (!rows.length) return res.json({ ok: true, sent: 0, note: "No submissions stored yet." });
  // Send in batches so one huge POST can't time out.
  let sent = 0;
  const failures = [];
  for (let i = 0; i < rows.length; i += 100) {
    const batch = rows.slice(i, i + 100);
    const r = await pushToSheet({ rows: batch });
    if (r.ok) sent += batch.length; else failures.push(r.reason);
  }
  res.json({ ok: failures.length === 0, sent, total: rows.length, failures });
});

// === 1. EXTRACTION: combine website + Google reviews + pasted text into chips ===
// Owner-only: this is a setup step, and it spends Anthropic + Google Places credit.
app.post("/api/extract", requireAdmin, async (req, res) => {
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
app.post("/api/generate", rateLimit, async (req, res) => {
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
        <h2 style="color:#2f3b32">Private guest feedback — ${escapeHtml(businessName || "")}</h2>
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Review Studio running on port " + PORT));
