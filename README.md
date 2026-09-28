# Review Grader v4 — staff accounts, stash and admin desk

Staff log in with management company → villa → designation → name → 4-digit PIN, upload a screenshot of a guest review, and see a Grade A / B / C result.
A confirmed Grade A puts Rp 600.000 into that villa's pot, split across the roster; a guest naming someone adds Rp 200.000 to that person.
Admins confirm grades, reset PINs and enter the review-goal numbers shown on Home. **BN Admin** sees only Balinest villas, **HoR Admin** only Endless Summer, **Owner Admin** everything.

Runs on Render (Node 18+) with a small JSON store on the Render disk. Every review is also added to the Notion Reviews database,
and the confirmed grade is written back into "Verified grade".

## Settings (Render → your service → Environment)

| Key | Required | Value |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes | your key from platform.claude.com |
| `ADMIN_PASSWORDS` | yes | `BN Admin=password1,HoR Admin=password2,Owner Admin=password3` |
| `SESSION_SECRET` | recommended | any long random text (Render can generate it) |
| `NOTION_TOKEN` | yes (for the live roster) | Notion integration secret. Share the **Reviews** and **Staff** databases with it |
| `TOP_SCORES` | optional | e.g. `Trip.com=5` if Trip.com turns out to use 5 stars (default: Airbnb 5, Google 5, Booking.com 10, Trip.com 10) |
| `NAME_BONUS_CHANNELS` | optional | default `Airbnb,Booking.com,Trip.com,Google`; drop Google if its policy bites |
| `POT_RP`, `NAME_BONUS_RP` | optional | default 600000 and 200000 |
| `DAILY_LIMIT`, `MODEL`, `STATS_FILE` | as before | |

## Roster (live from Notion)

The staff list comes from the Notion **Staff** database and refreshes within two minutes of any edit there. Each row needs:
`Name`, `Position` (host / supervisor / housekeeper / pool / garden / security), `Villas` (one or more), `Operator` (Balinest / House of Reservations) and `Active` ticked.
Rows named `EXAMPLE…`, or missing a Position or Villa, are ignored. Untick `Active` to remove someone from login and future splits; their past payout lines stay.
The Notion page is the account, so renaming someone keeps their PIN and stash. Every new row starts with PIN 8888 and must choose a new PIN at first login.
Give the BN admin edit access to the Staff database for Balinest rows and the HoR admin for House of Reservations rows (Notion can't restrict rows per person, so this is a trust rule, not a lock).
If Notion is unreachable the last successful sync is used; with no `NOTION_TOKEN` at all, `roster.json` in the repo is used instead.

## Money rules (from the 29 Sep 2026 handoff)

- Grade A: the channel's top score, a delighted guest, praise for the team or something specific, and no complaint or "but".
- Rp 600.000 per confirmed A into the villa pot. 50% shared equally by everyone on the roster; 50% by role (host 40%, supervisor 30%, L3 full-time staff — housekeepers and other full-timers — share 30%; with no supervisor, host 50% / L3 staff share 50%). L4 support (pool, garden, security) get the equal half only. L3/L4 comes from the **Level** column in Notion. Rounded to the rupiah, remainder to the host.
- Rp 200.000 to each staff member the guest names, ticked by the admin on confirm.
- A win belongs to the season of the **review date** (not the day the admin confirms it). Paydays: 31 Jan (Sep–15 Jan), 15 Jun (16 Jan–May), 15 Sep (Jun–Aug). A review confirmed after its payday still shows in the stash until it's paid.
- Channel top scores: Airbnb 5, Google 5, Booking.com 10, Trip.com 10. Name bonus on all four channels, Google included.
- Nothing is ever deducted. Confirmed grades are locked; corrections go in as a new entry. Every confirm and PIN reset is logged.

## Admin desk

Welcome → "Admin login". Queue shows each pending review with the suggested grade, the highlighted full text and a checklist.
Confirm, or Change grade. Tick who the guest named. Reset a PIN (back to 8888). Enter each villa's channel review count and score. BN and HoR admins only see and act on their own villas and people.
"Download payout lines (CSV)" exports every payout line for payday. Owner Admin also has "Reset test data" (wipes reviews, payouts and audit; PINs stay).

## Changing things

- Rebuild after any edit in `src/v4/`: `python3 build.py`, then commit `dist/worker.js` and `public/index.html` too.
- Grading prompt: `SYSTEM` in `src/v4/_grader_core.js`. Grade rules: `gradeReview` there. Split: `splitPot` in `src/v4/_server.js`. Owner's notes on the Grade A screen: `OWNER_NOTES` in `_server.js`.
- Files: `server.js` (Render entry), `dist/worker.js` (built server + page), `public/index.html` (page only), `src/v4/` (sources), `roster.json` (fallback only).
