# Review Studio — setup guide

A QR-based review tool: guests scan, tap a few chips, optionally speak/type a
detail, pick a tone + language, and Claude writes the review. They post it to
Google in their own account (paste + tap), or send it — and any "what could be
better" feedback — privately to the owner by email.

This is a real app with a small backend, because three things are impossible
from a plain web page: calling the Claude API (needs a secret key), sending
email, and keeping those keys off the user's phone. The server handles all three.

---

## What's in here

- `server.js`        — the backend (Claude calls + Resend email). Holds your keys.
- `public/index.html`— the whole front-end (owner setup + guest flow).
- `sheets-sync.gs`   — Apps Script for the Google Sheets mirror (see below).
- `package.json`     — dependencies.
- `.env.example`     — copy to `.env` and add your keys.

---

## Who can call what

Guests arrive by QR at `?v=<id>` and never see the owner screen. Only three
routes are open to them — reading a property's public config, generating a
review, and sending private feedback. Everything else requires `ADMIN_TOKEN`,
sent as an `x-admin-token` header or a `?token=` query parameter:

| Route | Who |
|---|---|
| `GET /api/config/:id` | public — guest's own property, submissions stripped |
| `POST /api/generate` | public — rate-limited to 20 per IP per 10 min |
| `POST /api/feedback` | public |
| `POST /api/log-submission` | public |
| `POST /api/resolve-maps` | **owner** — spends Google Places credit |
| `POST /api/extract` | **owner** — spends Anthropic + Places credit |
| `POST /api/save-config` | **owner** — could repoint an owner email otherwise |
| `GET /api/submissions/:id` | **owner** — every guest's private feedback |
| `GET /api/export/:id.csv` | **owner** |
| `GET /api/export-all.csv` | **owner** |
| `GET /api/sync-sheet` | **owner** |

Set `ADMIN_TOKEN` to a long random string (`openssl rand -hex 24`). The owner
screen asks for it once and keeps it in that browser's local storage.

**Without `ADMIN_TOKEN` set, every owner route returns 500 and setup won't run.**
That's deliberate — a blank token must never mean "open to everyone."

---

## Google Sheets sync

Mirrors every submission into a sheet, so you and your team can read the data
without the admin token and without downloading CSVs. The sheet is a mirror:
`configs.json` on the Render disk stays the source of truth, and a Sheets
outage can never break a guest's submission.

1. Make a new Google Sheet. **Extensions → Apps Script**.
2. Delete the placeholder code, paste in all of `sheets-sync.gs`, save.
3. **Project Settings → Script Properties → Add script property**:
   key `SHEETS_SECRET`, value a long random string.
4. **Deploy → New deployment → Web app**.
   - Execute as: **Me**
   - Who has access: **Anyone**  ← required; the secret is what actually guards it
   - Deploy, authorise, copy the `/exec` URL.
5. On Render, add two environment variables:
   - `SHEETS_WEBHOOK_URL` = the `/exec` URL
   - `SHEETS_SECRET` = the same string as step 3
6. Redeploy, then backfill everything already collected:
   `https://your-app.onrender.com/api/sync-sheet?token=YOUR_ADMIN_TOKEN`

Rows de-duplicate on (property_id, date), so step 6 is safe to re-run any time
the sheet falls behind. Re-deploying the Apps Script creates a *new* `/exec`
URL — update `SHEETS_WEBHOOK_URL` when you do.

---

## Run it locally (5 minutes)

1. Install Node.js 18+ if you don't have it: https://nodejs.org

2. In this folder:
   ```
   npm install
   ```

3. Get your two keys:
   - **Anthropic**: console.anthropic.com → API Keys → create key (starts `sk-ant-`)
   - **Resend**: resend.com → sign up (free, 3,000 emails/mo) → API Keys → create (starts `re_`)

4. Copy `.env.example` to `.env` and paste your keys in.
   - For `FROM_EMAIL`, you can use `onboarding@resend.dev` to test immediately.
     To send from your own domain (e.g. feedback@oasisvillas.com), verify that
     domain in Resend first (DNS records — takes a few minutes).

5. Start it:
   ```
   node --env-file=.env server.js
   ```
   (Node 20+. On Node 18, use a tiny loader or set the vars in your shell.)

6. Open http://localhost:3000

You'll land on **Owner setup**. Fill in a property, paste some real reviews,
hit "Read it & build my chips," refine, generate the QR. Toggle to
**Guest preview** (top right) to walk the guest flow. Try a 1–2★ rating to see
the private-feedback branch, and a 4–5★ to see AI writing + the public/private
choice on the result screen.

---

## Put it online

Any Node host works. Easiest options:

- **Render.com** (free tier): New Web Service → connect repo → build `npm install`,
  start `node server.js` → add ANTHROPIC_API_KEY, RESEND_API_KEY, FROM_EMAIL as
  environment variables in the dashboard.
- **Railway / Fly.io / a small VPS**: same idea — set the three env vars, run
  `npm start`.

Once hosted at e.g. `https://reviews.oasisvillas.com`, the QR codes generated by
the owner screen will point there automatically (they use the page's own URL).

---

## How each piece maps to a decision we made

- **Property-specific chips**: `/api/extract` reads pasted reviews/website and
  returns themed chips. Paste-in is deliberate — Google/Booking/Airbnb don't
  permit auto-import, so a one-time copy-paste keeps you compliant.
- **Balance / negatives**: 1–2★ routes to a private "what could be better"
  screen first (public posting still offered). On any result, the guest chooses
  Public (Google) or Private (emails the owner). Negatives never get
  auto-pushed to Google.
- **Tone & character**: a one-tap voice selector + the guest's own words/voice
  note drive the writing style.
- **Multilingual**: 10 languages; the review is composed natively in the chosen
  language.
- **Private feedback → email**: `/api/feedback` sends it to the owner email via
  Resend.

---

## Honest limits / next steps

- **No database.** Per-property config travels inside the QR link; private
  feedback is emailed, not stored. If you later want an owner dashboard with a
  "this month guests loved X, flagged Y" digest, that's the point where adding a
  database (e.g. Postgres) makes sense.
- **Compliance:** the final Google post stays a manual paste+tap on purpose —
  that's what keeps reviews organic and counted. Don't add incentives for
  reviews; Google filters incentivized ones.
- **Domain email:** verify your sending domain in Resend before going live so
  feedback emails don't land in spam.
