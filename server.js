// Review Grader — Node server for Render (or any Node 18+ host).
// Runs the same code as the Cloudflare version (dist/worker.js); only the storage differs:
// the counter is kept in a small JSON file (STATS_FILE). On Render, attach a disk so it survives restarts.
//
// Environment variables (Render → your service → Environment):
//   ANTHROPIC_API_KEY  required
//   ADMIN_PASSWORDS    "BN Admin=pass1,HoR Admin=pass2,Owner Admin=pass3"
//   SESSION_SECRET     any long random string (keeps logins valid across restarts)
//   NOTION_TOKEN       optional, Notion integration secret; graded reviews are added to the Reviews database
//   MODEL              optional, default "claude-sonnet-5"
//   DAILY_LIMIT        optional, default 200
//   STATS_FILE         optional, default ./data/stats.json (use /var/data/stats.json with a Render disk)

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import worker from "./dist/worker.js";

const STATS_FILE = process.env.STATS_FILE || path.join(process.cwd(), "data", "stats.json");
const MAX_BODY = 30 * 1024 * 1024;

// A tiny key-value store with the same get/put shape as Cloudflare KV.
function fileKV(file) {
  let data = {};
  try { data = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  const save = () => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, file);
    } catch (e) { console.error("Couldn't save stats:", e.message); }
  };
  return {
    async get(key, type) {
      const v = data[key];
      if (v === undefined) return null;
      return type === "json" ? JSON.parse(v) : v;
    },
    async put(key, value) {
      data[key] = String(value);
      // Keep only the last few daily counters and the last 300 grading jobs.
      const days = Object.keys(data).filter((k) => k.startsWith("day:")).sort();
      days.slice(0, Math.max(0, days.length - 3)).forEach((k) => delete data[k]);
      const jobs = Object.keys(data).filter((k) => k.startsWith("job:"));
      if (jobs.length > 300) jobs.sort((a, b) => (JSON.parse(data[a]).started || "").localeCompare(JSON.parse(data[b]).started || "")).slice(0, jobs.length - 300).forEach((k) => delete data[k]);
      save();
    },
  };
}

const env = {
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  ADMIN_PASSWORDS: process.env.ADMIN_PASSWORDS,
  SESSION_SECRET: process.env.SESSION_SECRET,
  TOP_SCORES: process.env.TOP_SCORES,
  NAME_BONUS_CHANNELS: process.env.NAME_BONUS_CHANNELS,
  POT_RP: process.env.POT_RP,
  NAME_BONUS_RP: process.env.NAME_BONUS_RP,
  NOTION_TOKEN: process.env.NOTION_TOKEN,
  NOTION_DATABASE_ID: process.env.NOTION_DATABASE_ID,
  NOTION_STAFF_DATABASE_ID: process.env.NOTION_STAFF_DATABASE_ID,
  MODEL: process.env.MODEL,
  DAILY_LIMIT: process.env.DAILY_LIMIT,
  STATS: fileKV(STATS_FILE),
};

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === "/healthz") { res.writeHead(200); res.end("ok"); return; }
    // Logo: put logo.png (or logo.svg) in the public folder.
    const logo = { "/logo.png": ["logo.png", "image/png"], "/logo.svg": ["logo.svg", "image/svg+xml"] }[req.url];
    if (logo) {
      const f = path.join(process.cwd(), "public", logo[0]);
      if (fs.existsSync(f)) { res.writeHead(200, { "content-type": logo[1], "cache-control": "public, max-age=86400" }); res.end(fs.readFileSync(f)); }
      else { res.writeHead(404); res.end(); }
      return;
    }
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > MAX_BODY) { res.writeHead(413, { "content-type": "application/json" }); res.end('{"error":"Screenshots are too large. Upload fewer at once."}'); return; }
      chunks.push(c);
    }
    const host = req.headers.host || "localhost";
    const request = new Request(`http://${host}${req.url}`, {
      method: req.method,
      headers: req.headers,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks),
    });
    const response = await worker.fetch(request, env, { waitUntil: (p) => p.catch((e) => console.error(e)) });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (e) {
    console.error(e);
    res.writeHead(500, { "content-type": "application/json" });
    res.end('{"error":"Something went wrong on the server. Try again."}');
  }
});

const port = Number(process.env.PORT) || 3000;
server.listen(port, () => console.log(`Review Grader running on port ${port}. Counter file: ${STATS_FILE}`));
