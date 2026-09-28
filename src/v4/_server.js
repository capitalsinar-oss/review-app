// ---------- v4: staff accounts, stash, admin desk ----------
//
// Settings (Render → Environment)
//   ANTHROPIC_API_KEY   required
//   ADMIN_PASSWORDS     required, e.g.  BN Admin=pass1,HoR Admin=pass2,Owner Admin=pass3  (BN/HoR admins only see their own villas)
//   SESSION_SECRET      optional; a random string so logins survive restarts (one is generated and stored if missing)
//   NOTION_TOKEN        optional; every review is added to the Notion Reviews database, and the confirmed grade written back
//   TOP_SCORES          optional, e.g. "Trip.com=5" (default: Airbnb 5, Google 5, Booking.com 10, Trip.com 10)
//   NAME_BONUS_CHANNELS optional, default "Airbnb,Booking.com,Trip.com,Google" (drop Google if its policy bites)
//   POT_RP / NAME_BONUS_RP   optional, default 600000 / 200000
//   MODEL, DAILY_LIMIT  as before
// Storage: env.STATS (a JSON file on the Render disk). Keys: staff, reviews, payouts, audit, goals, stats, seen:*, job:*

const OPERATORS = [
  { key: "BN",  name: "Balinest",              notion: "Balinest" },
  { key: "HoR", name: "House of Reservations", notion: "House of Reservations" },
];
const operatorByKey = (k) => OPERATORS.find((o) => o.key === k);
const VILLA_LIST = [
  { id: 1002, key: "Kapuk",  name: "Oasis Kapuk",    operator: "BN",  has_supervisor: true },
  { id: 1003, key: "Palem",  name: "Oasis Palem",    operator: "BN",  has_supervisor: true },
  { id: 1004, key: "Jati",   name: "Oasis Jati",     operator: "BN",  has_supervisor: true },
  { id: 1005, key: "Ceylon", name: "Ceylon",         operator: "BN",  has_supervisor: true },
  { id: 1001, key: "ESV",    name: "Endless Summer", operator: "HoR", has_supervisor: false },
];
const villaByKey = (k) => VILLA_LIST.find((v) => v.key === k);
const ROLES = ["host", "supervisor", "housekeeper", "pool", "garden", "security"];
const CHANNEL_META = { "Airbnb": "#FF5A5F", "Booking.com": "#003580", "Trip.com": "#287DFA", "Google": "#34A853" };
const PAYDAYS = [ // month is 1-based; season = the wins confirmed in that window
  { md: [1, 31], label: "31 Jan", season: "Sep–15 Jan" },
  { md: [6, 15], label: "15 Jun", season: "16 Jan–May" },
  { md: [9, 15], label: "15 Sep", season: "Jun–Aug" },
];
const OWNER_NOTES = [
  "Thank you. A family went home talking about how you made them feel. That's the whole job, and you did it beautifully.",
  "This is what we're here for. Someone will remember this stay for years, and you're the reason.",
  "You noticed what mattered before the guest had to ask. That's rare, and it shows.",
  "Every A starts with a small thing done properly. Thank you for doing the small things.",
];

// ---------- money rules ----------
// Each Grade A puts POT_RP into the villa pot. Half is shared equally by everyone on the roster.
// The other half goes by role: host 40%, supervisor 30%, L3 full-time staff (housekeepers and other full-timers) share 30%.
// With no supervisor: host 50%, L3 staff share 50%. L4 support (pool, garden, security) get only the equal half.
// "L3" comes from the Level column in Notion; without it, housekeepers count as L3 and pool/garden/security as L4.
// Rounded to the rupiah; any remainder goes to the host.
function splitPot(pot, roster) {
  const n = roster.length; if (!n) return [];
  const half = pot / 2;
  const equal = Math.floor(half / n);
  const isL3 = (s) => s.role !== "host" && s.role !== "supervisor" && (s.level ? /^L3/i.test(s.level) : s.role === "housekeeper");
  const hosts = roster.filter((s) => s.role === "host"), sups = roster.filter((s) => s.role === "supervisor"), l3 = roster.filter(isL3);
  const hasSup = sups.length > 0;
  const share = (s) => s.role === "host" ? (hosts.length ? Math.floor(half * (hasSup ? 0.4 : 0.5) / hosts.length) : 0)
    : s.role === "supervisor" ? Math.floor(half * 0.3 / sups.length)
    : isL3(s) ? Math.floor(half * (hasSup ? 0.3 : 0.5) / l3.length) : 0;
  const lines = roster.map((s) => ({ staff_id: s.id, amount: equal + share(s) }));
  const remainder = pot - lines.reduce((a, l) => a + l.amount, 0);
  const host = lines.find((l) => roster.find((s) => s.id === l.staff_id).role === "host") || lines[0];
  host.amount += remainder;
  return lines;
}

// ---------- seasons and paydays ----------
function nextPayday(from = new Date()) {
  const y = from.getUTCFullYear();
  const cands = [];
  for (const yy of [y, y + 1]) PAYDAYS.forEach((p) => cands.push({ ...p, date: new Date(Date.UTC(yy, p.md[0] - 1, p.md[1])) }));
  const next = cands.filter((c) => c.date >= new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()))).sort((a, b) => a.date - b.date)[0];
  const days = Math.round((next.date - Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate())) / 86400000);
  return { ...next, days, iso: next.date.toISOString().slice(0, 10) };
}
// A win belongs to the season of the REVIEW date (not the day the admin confirms it): season = the payday that follows that date.
const seasonOf = (d) => nextPayday(new Date(d)).iso;
const seasonLabel = (iso) => { const p = PAYDAYS.find((x) => iso && iso.slice(5) === `${String(x.md[0]).padStart(2, "0")}-${String(x.md[1]).padStart(2, "0")}`); return p ? `${p.season} · paid ${p.label} ${iso.slice(0, 4)}` : iso; };

// ---------- storage helpers ----------
const load = (env, k, fb) => getJSON(env, k, fb);
const save = (env, k, v) => putJSON(env, k, v);
async function ensureSecret(env) {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  let s = await load(env, "secret", null);
  if (!s) { s = crypto.randomUUID() + crypto.randomUUID(); await save(env, "secret", s); }
  return s;
}
async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const b64u = (s) => btoa(unescape(encodeURIComponent(s))).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const unb64u = (s) => decodeURIComponent(escape(atob(s.replace(/-/g, "+").replace(/_/g, "/"))));
async function makeToken(env, payload) {
  const body = b64u(JSON.stringify({ ...payload, exp: Date.now() + 30 * 86400000 }));
  return body + "." + await hmac(await ensureSecret(env), body);
}
async function readToken(env, token) {
  if (!token || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  if (sig !== await hmac(await ensureSecret(env), body)) return null;
  try { const p = JSON.parse(unb64u(body)); return p.exp > Date.now() ? p : null; } catch { return null; }
}
async function pinHash(pin, salt) { return sha256(salt + ":" + String(pin)); }

// ---------- roster ----------
// roster.json in the repo (or the built-in default) creates staff accounts. Names can be edited there; ids never change.
const DEFAULT_ROSTER = (() => {
  const base = (v) => [["host", "Host"], ["supervisor", "Supervisor"], ["housekeeper", "Housekeeper 1"], ["housekeeper", "Housekeeper 2"], ["pool", "Pool"], ["garden", "Garden"]]
    .map(([role, name], i) => ({ id: `${v.toLowerCase()}-${role}-${i + 1}`, name, role, villas: [v] }));
  return [
    ...base("Kapuk").filter((s) => s.role !== "supervisor"), ...base("Palem").filter((s) => s.role !== "supervisor"),
    ...base("Jati").filter((s) => s.role !== "supervisor"), ...base("Ceylon").filter((s) => s.role !== "supervisor"),
    { id: "ceylon-security-7", name: "Security", role: "security", villas: ["Ceylon"] },
    { id: "bn-supervisor-1", name: "Dicky", role: "supervisor", villas: ["Kapuk", "Palem", "Jati", "Ceylon"] },
    ...base("ESV").filter((s) => s.role !== "supervisor"),
  ];
})();
// Live roster: the Notion Staff database (Name, Position, Villas, Operator, Active). The Notion page id is the account id,
// so names can change in Notion without touching PINs or stash. Rows named EXAMPLE… or without a Position/Villas are skipped.
// If Notion is unreachable the last successful sync is used; with no Notion token at all, roster.json is used.
let rosterCache = { at: 0, list: null };
async function notionRoster(env) {
  if (!env.NOTION_TOKEN) return null;
  if (rosterCache.list && Date.now() - rosterCache.at < 120000) return rosterCache.list;
  const list = []; let cursor = null;
  do {
    const q = await notion(env, `databases/${env.NOTION_STAFF_DATABASE_ID || DEFAULT_STAFF_DB}/query`, "POST", { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
    if (!q.ok) { console.log("Staff sync failed:", q.message); return null; }
    for (const pg of q.data.results || []) {
      const P = pg.properties || {};
      const name = (P.Name?.title || []).map((t) => t.plain_text).join("").trim();
      const role = P.Position?.select?.name || "";
      const villas = (P.Villas?.multi_select || []).map((o) => o.name).filter((v) => villaByKey(v));
      const op = OPERATORS.find((o) => o.notion === P.Operator?.select?.name)?.key || villaByKey(villas[0])?.operator || "";
      const active = !!P.Active?.checkbox;
      const level = P.Level?.select?.name || "";
      if (!name || /^EXAMPLE/i.test(name) || !ROLES.includes(role) || !villas.length) continue;
      list.push({ id: pg.id, name, role, villas, operator: op, active, level });
    }
    cursor = q.data.has_more ? q.data.next_cursor : null;
  } while (cursor);
  rosterCache = { at: Date.now(), list };
  await save(env, "roster_sync", { at: new Date().toISOString(), list });
  return list;
}
async function ensureStaff(env) {
  let staff = await load(env, "staff", null) || [];
  let roster = await notionRoster(env);
  let source = "notion";
  if (!roster) { const last = await load(env, "roster_sync", null); if (last && last.list) { roster = last.list; source = "notion-cached"; } }
  if (!roster) { roster = ((typeof ROSTER_JSON !== "undefined" && Array.isArray(ROSTER_JSON) && ROSTER_JSON.length) ? ROSTER_JSON : DEFAULT_ROSTER).map((r) => ({ ...r, operator: r.operator || villaByKey(r.villas[0])?.operator || "", active: true })); source = "roster.json"; }
  let changed = false;
  for (const r of roster) {
    let s = staff.find((x) => x.id === r.id);
    if (!s) {
      const salt = crypto.randomUUID();
      s = { id: r.id, name: r.name, role: r.role, villas: r.villas, operator: r.operator, level: r.level || "", salt, pin_hash: await pinHash("8888", salt), must_change_pin: true, active: r.active, fails: 0, locked_until: 0 };
      staff.push(s); changed = true;
    } else if (s.name !== r.name || JSON.stringify(s.villas) !== JSON.stringify(r.villas) || s.role !== r.role || s.operator !== r.operator || s.active !== r.active || (s.level || "") !== (r.level || "")) {
      Object.assign(s, { name: r.name, villas: r.villas, role: r.role, operator: r.operator, active: r.active, level: r.level || "" }); changed = true;
    }
  }
  // Someone removed from the roster can no longer log in; their past payout lines stay.
  for (const s of staff) if (s.active && !roster.some((r) => r.id === s.id)) { s.active = false; changed = true; }
  if (changed) await save(env, "staff", staff);
  staff.source = source;
  return staff;
}
const pub = (s) => ({ id: s.id, name: s.name, role: s.role, villas: s.villas, operator: s.operator });

// ---------- auth ----------
async function who(request, env) {
  return readToken(env, request.headers.get("x-session") || "");
}
function admins(env) {
  const map = {};
  String(env.ADMIN_PASSWORDS || "").split(",").forEach((p) => { const i = p.indexOf("="); if (i > 0) map[p.slice(0, i).trim()] = p.slice(i + 1).trim(); });
  return map;
}
// Which villas an admin may see: Owner Admin sees everything; "BN Admin" only Balinest villas; "HoR Admin" only House of Reservations.
function adminScope(name) {
  const n = String(name || "").toLowerCase();
  if (/owner|azure/.test(n)) return null;
  if (/hor|house/.test(n)) return "HoR";
  if (/\bbn\b|balinest/.test(n)) return "BN";
  return null;
}
const inScope = (admin, villaKey) => !admin.scope || villaByKey(villaKey)?.operator === admin.scope;
async function audit(env, actor, action, target, extra = {}) {
  const log = await load(env, "audit", []);
  log.unshift({ at: new Date().toISOString(), actor, action, target, ...extra });
  await save(env, "audit", log.slice(0, 2000));
}

async function staffLogin(request, env) {
  const { operator, villa, role, staff_id, pin } = await request.json().catch(() => ({}));
  const staff = await ensureStaff(env);
  const v = villaByKey(villa);
  if (!v || (operator && v.operator !== operator)) return json({ error: "Pick your management company and your villa first." }, 400);
  const s = staff.find((x) => x.id === staff_id && x.active && x.villas.includes(villa) && (!role || x.role === role));
  if (!s) return json({ error: "Pick your company, villa, designation and name, then enter your PIN." }, 400);
  if (s.locked_until > Date.now()) return json({ error: `Too many tries. Wait ${Math.ceil((s.locked_until - Date.now()) / 60000)} minutes, or ask an admin to reset your PIN.` }, 423);
  if (!/^\d{4}$/.test(String(pin || "")) || (await pinHash(pin, s.salt)) !== s.pin_hash) {
    s.fails = (s.fails || 0) + 1;
    if (s.fails >= 5) { s.locked_until = Date.now() + 15 * 60000; s.fails = 0; }
    await save(env, "staff", staff);
    return json({ error: s.locked_until > Date.now() ? "Five wrong tries. Locked for 15 minutes." : "That PIN isn't right. Try again." }, 401);
  }
  s.fails = 0; await save(env, "staff", staff);
  const token = await makeToken(env, { kind: "staff", id: s.id });
  return json({ token, me: pub(s), must_change_pin: !!s.must_change_pin });
}
async function setPin(request, env, me) {
  const { new_pin } = await request.json().catch(() => ({}));
  if (!/^\d{4}$/.test(String(new_pin || "")) || new_pin === "8888" || /^(\d)\1{3}$/.test(new_pin) || new_pin === "1234") return json({ error: "Choose 4 digits that aren't all the same, and not 1234 or 8888." }, 400);
  const staff = await ensureStaff(env);
  const s = staff.find((x) => x.id === me.id);
  s.pin_hash = await pinHash(new_pin, s.salt); s.must_change_pin = false;
  await save(env, "staff", staff);
  return json({ ok: true });
}
async function adminLogin(request, env) {
  const { name, password } = await request.json().catch(() => ({}));
  const a = admins(env);
  if (!Object.keys(a).length) return json({ error: "No admin passwords are set yet. Add ADMIN_PASSWORDS in the site settings." }, 500);
  const key = Object.keys(a).find((k) => k.toLowerCase() === String(name || "").toLowerCase());
  const fails = await load(env, "adminfails", {});
  if ((fails[key] || {}).until > Date.now()) return json({ error: "Too many tries. Wait 15 minutes." }, 423);
  if (!key || a[key] !== password) {
    if (key) { const f = fails[key] || { n: 0 }; f.n++; if (f.n >= 5) { f.until = Date.now() + 15 * 60000; f.n = 0; } fails[key] = f; await save(env, "adminfails", fails); }
    return json({ error: "That name or password isn't right." }, 401);
  }
  return json({ token: await makeToken(env, { kind: "admin", id: key }), me: { name: key } });
}

// ---------- staff views ----------
function stashFor(staffId, payouts, reviews, staff, pot, bonus) {
  const now = new Date();
  const pay = nextPayday(now);
  const mine = payouts.filter((l) => l.staff_id === staffId && !l.paid_at);
  const total = mine.reduce((a, l) => a + l.amount, 0);
  const byVilla = {};
  for (const l of mine) { const v = byVilla[l.villa] || (byVilla[l.villa] = { villa: l.villa, amount: 0, wins: 0, named: 0 }); v.amount += l.amount; if (l.kind === "pot_share") v.wins++; if (l.kind === "name_bonus") v.named++; }
  const me = staff.find((s) => s.id === staffId);
  const wins = reviews.filter((r) => (r.status === "locked" && mine.some((l) => l.review_id === r.id)) || (r.status === "pending" && r.uploaded_by === staffId))
    .map((r) => { const line = mine.find((l) => l.review_id === r.id && l.kind === "pot_share"); const named = mine.find((l) => l.review_id === r.id && l.kind === "name_bonus");
      return { id: r.id, channel: r.platform, villa: r.villa, date: r.date_iso || r.graded_at, status: r.status, grade: r.status === "locked" ? r.confirmed_grade : r.grade, amount: (line ? line.amount : 0) + (named ? named.amount : 0), named: !!named, season: r.season ? seasonLabel(r.season) : "" }; })
    .filter((w) => w.status === "pending" || w.amount > 0)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const nextMillion = Math.max(1, Math.floor(total / 1e6) + 1) * 1e6;
  const shareEstimate = me ? Math.round(splitPot(pot, staff.filter((s) => s.active && s.villas.includes(me.villas[0]))).find((l) => l.staff_id === staffId)?.amount || 0) : 0;
  return { total, by_villa: Object.values(byVilla), wins, payday: pay, next_milestone: nextMillion, share_estimate: shareEstimate, name_bonus: bonus, paydays: PAYDAYS.map((p) => ({ label: p.label, season: p.season, next: p.label === pay.label })) };
}

// ---------- confirm ----------
async function confirmReview(request, env, admin, id) {
  const body = await request.json().catch(() => ({}));
  const grade = ["A", "B", "C"].includes(body.grade) ? body.grade : null;
  if (!grade) return json({ error: "Pick A, B or C." }, 400);
  const reviews = await load(env, "reviews", []);
  const r = reviews.find((x) => x.id === id);
  if (!r) return json({ error: "That review isn't in the queue any more." }, 404);
  if (r.status === "locked") return json({ error: "This grade is locked. Corrections go in as a new entry." }, 409);
  if (!inScope(admin, r.villa)) return json({ error: "That villa isn't under your management company." }, 403);
  const staff = await ensureStaff(env);
  const roster = staff.filter((s) => s.active && s.villas.includes(r.villa));
  const now = new Date().toISOString();
  // Season = the review's own date (falls back to today only when the screenshot showed no usable date).
  const season = seasonOf(validDate(r.date_iso) ? r.date_iso : now);
  const lines = [];
  const pot = Number(env.POT_RP) || 600000, bonus = Number(env.NAME_BONUS_RP) || 200000;
  const eligible = String(env.NAME_BONUS_CHANNELS || "Airbnb,Booking.com,Trip.com,Google").split(",").map((s) => s.trim());
  const mentions = Array.isArray(body.name_mentions) ? body.name_mentions.filter((sid) => roster.some((s) => s.id === sid)) : [];
  if (grade === "A") {
    for (const l of splitPot(pot, roster)) lines.push({ review_id: r.id, staff_id: l.staff_id, villa: r.villa, amount: l.amount, kind: "pot_share", season, created_at: now });
    if (eligible.includes(r.platform)) for (const sid of mentions) lines.push({ review_id: r.id, staff_id: sid, villa: r.villa, amount: bonus, kind: "name_bonus", season, created_at: now });
  }
  Object.assign(r, { status: "locked", confirmed_grade: grade, confirmed_by: admin.id, confirmed_at: now, season, name_mentions: mentions, roster_size: roster.length, changed: grade !== r.grade });
  const payouts = await load(env, "payouts", []);
  await save(env, "payouts", payouts.concat(lines));
  await save(env, "reviews", reviews);
  await audit(env, admin.id, grade !== r.grade ? "change" : "confirm", r.id, { grade, suggested: r.grade, villa: r.villa, mentions, season });
  if (env.NOTION_TOKEN && r.notion_page_id) {
    notion(env, `pages/${r.notion_page_id}`, "PATCH", { properties: { "Verified grade": { select: { name: grade } }, "Verified on": { date: { start: now.slice(0, 10) } } } }).catch(() => {});
  }
  return json({ ok: true, review: r, lines, season: seasonLabel(season) });
}

// ---------- grading job (v4) ----------
function highlightsFor(r) {
  const spans = [];
  const add = (q, type) => { const t = String(q || "").trim(); if (t.length > 3) spans.push({ text: t, type }); };
  (r.specifics || []).forEach((s) => add(s.quote, "praise"));
  if (r.advocacy?.present) add(r.advocacy.quote, "recommends");
  (r.staff_named || []).forEach((s) => add(s.quote, "staff"));
  (r.complaints || []).forEach((c) => add(c.quote, c.severity === "complaint" ? "complaint" : "check"));
  return spans;
}
function checklist(r, env) {
  const top = topScoreFor(env, r.platform);
  const items = [];
  const n = Number(r.rating);
  items.push({ ok: !!(n && top && n >= top), text: n && top ? `${n >= top ? "Top score" : "Not the top score"} for ${r.platform} (${n} of ${top})` : "Rating not visible" });
  items.push({ ok: (r.specifics || []).length > 0, text: (r.specifics || []).length ? "Praises the team or something specific" : "Praise is general" });
  const comps = (r.complaints || []).filter((c) => c.severity === "complaint"), cav = (r.complaints || []).filter((c) => c.severity !== "complaint");
  items.push({ ok: !comps.length && !cav.length, text: comps.length ? "Has a complaint" : cav.length ? 'Has a "but"' : "No complaints" });
  items.push({ ok: !!r.advocacy?.present, text: r.advocacy?.present ? "Recommends or wants to come back" : "Doesn't say they'd return (bonus only)" });
  items.push({ ok: (r.intensity || 0) >= 4, text: `Tone ${r.intensity || "?"}/5 · ${["", "unhappy", "disappointed", "satisfied", "very happy", "delighted"][r.intensity] || ""}` });
  return items;
}

async function runJobV4(env, id, job, payload) {
  const { images, villa, uploader } = payload;
  const model = env.MODEL || DEFAULT_MODEL;
  const today = new Date().toISOString().slice(0, 10);
  const tail = `\nToday's date is ${today}. Include EVERY separate guest review you can see, even when there are several.`;
  const tasks = images.map((im) => [{ type: "image", source: { type: "base64", media_type: im.media_type, data: im.data } }, { type: "text", text: "Grade the guest review(s) in this screenshot." + tail }]);
  try {
    const hashes = await Promise.all(images.map((im) => sha256(im.data)));
    const results = new Array(tasks.length); const todo = [];
    for (let i = 0; i < tasks.length; i++) { const c = await load(env, "seen:" + hashes[i], null); if (c && c.out) results[i] = { ...c, inTok: 0, outTok: 0 }; else todo.push(i); }
    for (let k = 0; k < todo.length; k += 2) {
      const batch = todo.slice(k, k + 2);
      const got = await Promise.all(batch.map((i) => askClaude(env, model, tasks[i])));
      batch.forEach((i, j) => { results[i] = got[j]; if (got[j].out) putJSON(env, "seen:" + hashes[i], { out: got[j].out }, 2592000).catch(() => {}); });
    }
    let inTok = 0, outTok = 0;
    const found = [], notes = [], errors = [], seen = new Set();
    results.forEach((r, i) => {
      const label = images.length > 1 ? `Screenshot ${i + 1}: ` : "";
      inTok += r.inTok || 0; outTok += r.outTok || 0;
      if (r.error) { errors.push(label + r.error); return; }
      if (!r.out) { errors.push(label + "couldn't be read. Try again."); return; }
      const list = (r.out.is_review === false ? [] : Array.isArray(r.out.reviews) ? r.out.reviews : []).filter((rv) => { const why = looksLikeReview(rv); if (why) notes.push(label + `not graded (${why})`); return !why; });
      if (!list.length && !notes.some((x) => label && x.startsWith(label))) notes.push(label + "not a guest review" + (r.out.image_shows ? ` (${r.out.image_shows})` : ""));
      for (const rv of list) { const key = reviewKey(rv); if (seen.has(key)) continue; seen.add(key); rv.key = key; found.push(rv); }
    });
    const [pin, pout] = PRICES[model] || PRICES[DEFAULT_MODEL];
    const usd = (inTok * pin + outTok * pout) / 1e6;
    const reviews = await load(env, "reviews", []);
    const staff = await ensureStaff(env);
    const roster = staff.filter((s) => s.active && s.villas.includes(villa));
    const now = new Date().toISOString();
    const out = [];
    for (const [i, r] of found.entries()) {
      r.detected_villa = r.villa || ""; r.villa = villa; r.villa_id = villaByKey(villa)?.id || "";
      Object.assign(r, gradeReview(r, env), { id: `${id}-${i}`, uploaded_by: uploader.id, team: uploader.name, graded_at: now, status: "pending" });
      r.highlights = highlightsFor(r); r.checklist = checklist(r, env);
      const earlier = await findEarlier(env, r, reviews);
      if (earlier) { r.duplicate_of = earlier; if (earlier.grade) r.grade = earlier.grade; out.push(r); continue; }
      // projected share for the uploader if this becomes a confirmed A
      r.share_estimate = splitPot(Number(env.POT_RP) || 600000, roster).find((l) => l.staff_id === uploader.id)?.amount || 0;
      r.pot = Number(env.POT_RP) || 600000;
      r.owner_note = OWNER_NOTES[Math.floor(Math.random() * OWNER_NOTES.length)];
      const n = await toNotion(env, r);
      if (n.url) { r.notion_url = n.url; r.notion_page_id = n.id || null; } else if (n.error) r.notion_error = n.error;
      reviews.unshift(r); out.push(r);
      await sleep(300);
    }
    await save(env, "reviews", reviews.slice(0, 5000));
    let stats = await readStats(env);
    if (stats) { const fresh = out.filter((r) => !r.duplicate_of).length; stats = { ...stats, since: stats.since || today, reviews: stats.reviews + fresh, requests: stats.requests + tasks.length, input_tokens: stats.input_tokens + inTok, output_tokens: stats.output_tokens + outTok, usd: Math.round((stats.usd + usd) * 1e6) / 1e6 }; await save(env, "stats", stats); }
    if (!out.length && errors.length) await putJSON(env, "job:" + id, { ...job, status: "error", error: errors.join(" · ") }, 172800);
    else await putJSON(env, "job:" + id, { ...job, status: "done", reviews: out.map(({ key, ...rest }) => rest), notes, errors }, 172800);
  } catch (e) {
    console.log("Job failed", e && e.stack);
    await putJSON(env, "job:" + id, { ...job, status: "error", error: "Something went wrong while grading. Try again." }, 172800);
  }
}

async function startUpload(request, env, ctx, me) {
  if (!env.ANTHROPIC_API_KEY) return json({ error: "The site has no API key yet." }, 500);
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: "Send the screenshot again." }, 400);
  const images = Array.isArray(body.images) ? body.images.slice(0, MAX_IMAGES) : [];
  const villa = villaByKey(body.villa) ? body.villa : "";
  if (!villa) return json({ error: "Choose which villa the guest stayed at." }, 400);
  if (!me.villas.includes(villa)) return json({ error: "You're not on that villa's roster." }, 403);
  if (!images.length) return json({ error: "Add a screenshot of the review." }, 400);
  for (const im of images) if (!im || !MEDIA.includes(im.media_type) || typeof im.data !== "string" || im.data.length > MAX_IMAGE_B64) return json({ error: "Use a PNG or JPG screenshot under 5 MB." }, 400);
  const today = new Date().toISOString().slice(0, 10);
  const limit = Number(env.DAILY_LIMIT) || 200;
  const used = Number(await env.STATS.get("day:" + today)) || 0;
  if (used >= limit) return json({ error: `Today's limit of ${limit} gradings is used up. Try again tomorrow.` }, 429);
  await env.STATS.put("day:" + today, String(used + images.length), { expirationTtl: 172800 });
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const job = { id, status: "working", uploaded_by: me.id, villa, images: images.length, started: new Date().toISOString() };
  await putJSON(env, "job:" + id, job, 172800);
  const work = runJobV4(env, id, job, { images, villa, uploader: me });
  if (ctx && ctx.waitUntil) ctx.waitUntil(work); else work.catch(() => {});
  return json({ job: id }, 202);
}

// ---------- router ----------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname, m = request.method;
    if (m === "GET" && (p === "/" || p === "/index.html")) return new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
    if (m === "GET" && p === "/api/villas") {
      const staff = await ensureStaff(env);
      return json({ operators: OPERATORS, roles: ROLES, roster_source: staff.source, villas: VILLA_LIST.map((v) => ({ ...v, staff: staff.filter((s) => s.active && s.villas.includes(v.key)).map((s) => ({ id: s.id, name: s.name, role: s.role })) })), stats: await readStats(env) });
    }
    if (m === "POST" && p === "/api/auth/staff") return staffLogin(request, env);
    if (m === "POST" && p === "/api/auth/admin") return adminLogin(request, env);

    const session = await who(request, env);
    if (!session) return json({ error: "signin" }, 401);
    const staffAll = await ensureStaff(env);

    if (session.kind === "staff") {
      const me = staffAll.find((s) => s.id === session.id && s.active);
      if (!me) return json({ error: "signin" }, 401);
      if (m === "POST" && p === "/api/auth/staff/pin") return setPin(request, env, me);
      if (m === "GET" && p === "/api/me") {
        const [payouts, reviews, goals] = await Promise.all([load(env, "payouts", []), load(env, "reviews", []), load(env, "goals", {})]);
        return json({ me: pub(me), must_change_pin: !!me.must_change_pin, stash: stashFor(me.id, payouts, reviews, staffAll, Number(env.POT_RP) || 600000, Number(env.NAME_BONUS_RP) || 200000), goals, villas: VILLA_LIST.filter((v) => me.villas.includes(v.key)) });
      }
      if (m === "POST" && p === "/api/reviews") return startUpload(request, env, ctx, me);
      if (m === "GET" && p === "/api/job") {
        const job = await load(env, "job:" + (url.searchParams.get("id") || ""), null);
        if (!job || job.uploaded_by !== me.id) return json({ status: "missing" }, 404);
        return json(job);
      }
      return json({ error: "Not found" }, 404);
    }
    if (session.kind === "admin") {
      const admin = { id: session.id, scope: adminScope(session.id) };
      const myVillas = VILLA_LIST.filter((v) => inScope(admin, v.key));
      const myStaff = staffAll.filter((s) => s.villas.some((v) => inScope(admin, v)));
      if (m === "GET" && p === "/api/admin/queue") {
        const reviews = await load(env, "reviews", []);
        const villa = url.searchParams.get("villa") || "";
        const pending = reviews.filter((r) => r.status === "pending" && !r.duplicate_of && inScope(admin, r.villa) && (!villa || r.villa === villa));
        const recent = reviews.filter((r) => r.status === "locked" && inScope(admin, r.villa)).slice(0, 20).map((r) => ({ ...r, season_label: seasonLabel(r.season) }));
        const auditLog = (await load(env, "audit", [])).filter((a) => !admin.scope || !a.villa || inScope(admin, a.villa)).slice(0, 30);
        return json({ me: { name: admin.id, scope: admin.scope, operator: admin.scope ? operatorByKey(admin.scope).name : "all villas" }, pending, recent, audit: auditLog, staff: myStaff.map(pub), villas: myVillas, goals: await load(env, "goals", {}), stats: await readStats(env), roster_source: staffAll.source });
      }
      const conf = p.match(/^\/api\/admin\/reviews\/([^/]+)\/confirm$/);
      if (m === "POST" && conf) return confirmReview(request, env, admin, decodeURIComponent(conf[1]));
      const reset = p.match(/^\/api\/admin\/staff\/([^/]+)\/reset-pin$/);
      if (m === "POST" && reset) {
        const s = myStaff.find((x) => x.id === decodeURIComponent(reset[1]));
        if (!s) return json({ error: "No such person under your management company." }, 404);
        s.pin_hash = await pinHash("8888", s.salt); s.must_change_pin = true; s.fails = 0; s.locked_until = 0;
        await save(env, "staff", staffAll);
        await audit(env, admin.id, "reset_pin", s.id, { name: s.name });
        return json({ ok: true, name: s.name });
      }
      if (m === "POST" && p === "/api/admin/goals") {
        const body = await request.json().catch(() => ({}));
        const goals = await load(env, "goals", {});
        if (villaByKey(body.villa) && inScope(admin, body.villa) && body.channel in CHANNEL_META) {
          goals[body.villa] = goals[body.villa] || {};
          goals[body.villa][body.channel] = { count: Number(body.count) || 0, score: Number(body.score) || 0, updated: new Date().toISOString(), by: admin.id };
          await save(env, "goals", goals);
        }
        return json({ ok: true, goals });
      }
      if (m === "GET" && p === "/api/admin/export") {
        const [payouts, reviews] = await Promise.all([load(env, "payouts", []), load(env, "reviews", [])]);
        const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
        const rows = [["season", "villa", "staff", "role", "kind", "amount", "review", "channel", "guest", "confirmed_at", "confirmed_by"]];
        for (const l of payouts.filter((l) => inScope(admin, l.villa))) { const s = staffAll.find((x) => x.id === l.staff_id) || {}; const r = reviews.find((x) => x.id === l.review_id) || {}; rows.push([l.season, l.villa, s.name, s.role, l.kind, l.amount, l.review_id, r.platform, r.guest, r.confirmed_at, r.confirmed_by]); }
        return new Response("﻿" + rows.map((r) => r.map(q).join(",")).join("\n"), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="payout-lines-${new Date().toISOString().slice(0, 10)}.csv"` } });
      }
      if (m === "POST" && p === "/api/admin/reset-test-data") {
        // Owner only: wipe reviews, payouts and audit (staff and PINs stay). Notion rows added by this site are archived.
        if (!/owner/i.test(admin.id)) return json({ error: "Only the Owner Admin can do this." }, 403);
        let archived = 0;
        if (env.NOTION_TOKEN) { let cursor = null; do {
          const qq = await notion(env, `databases/${env.NOTION_DATABASE_ID || DEFAULT_NOTION_DB}/query`, "POST", { filter: { property: "Notes", rich_text: { contains: "via Review Grader" } }, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
          if (!qq.ok) break;
          for (const pg of qq.data.results || []) { const rr = await notion(env, `pages/${pg.id}`, "PATCH", { archived: true }); if (rr.ok) archived++; await sleep(350); }
          cursor = qq.data.has_more ? qq.data.next_cursor : null; } while (cursor); }
        await save(env, "reviews", []); await save(env, "payouts", []); await save(env, "audit", []);
        await save(env, "stats", { ...EMPTY_STATS, since: new Date().toISOString().slice(0, 10) });
        return json({ ok: true, archived });
      }
      return json({ error: "Not found" }, 404);
    }
    return json({ error: "signin" }, 401);
  },
};
