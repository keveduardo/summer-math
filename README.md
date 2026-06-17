# Beach Math — setup & guide

A summer review program for a rising 7th grader, mirroring her **Accelerated Math 6** course
(Mrs. Wimberly, Calle Mayor) across all 6 units. Themed around Junior Lifeguards, Beach FC, and candy.

## How it's wired
- `index.html` — the app (static; no secrets inside it).
- `functions/api/[[path]].js` — a **Cloudflare Pages Function** that handles the code-word check (signed
  session cookie), proxies results to your Google Sheet, and **syncs progress to Cloudflare KV** so it follows
  her across devices. Code words and the Sheet URL live in env vars, not the page.
- `Code.gs` — Apps Script that appends rows to the Sheet (unchanged).
- `SCHEDULE.md` — printable 8-week plan.

Because the function runs same-origin with the page, hosting must be **Cloudflare Pages** (not GitHub Pages).

## Sign-in & sync
Code words map to profiles **server-side**: Madeleine's code (you choose it) → her tracked progress; `test` →
a throwaway profile. Sign in with her code on any device and her XP, streak, mastery, treats, and Review Misses
**load from KV** — same progress everywhere. Session lasts ~120 days. (The in-chat preview has no backend, so only
`test` works there, saved locally.)

---

## 1. Deploy on Cloudflare Pages
1. Put `index.html` and the `functions/` folder in a repo (or use Direct Upload).
2. Cloudflare → **Workers & Pages → Create → Pages** → connect the repo (build command: none; output dir: `/`).

## 2. Create a KV namespace and bind it
1. **Storage & Databases → KV → Create namespace** (e.g. `beach-math`).
2. Pages project → **Settings → Bindings → Add → KV namespace** →
   Variable name **`BEACH_MATH_KV`** → select the namespace.

## 3. Set the secrets
Pages → **Settings → Variables and Secrets** → add (mark the last two **Secret/Encrypted**):

| Name | Value |
|------|-------|
| `USERS_JSON` | `{"beachfc":{"id":"madeleine","name":"Madeleine"},"test":{"id":"test","name":"Test"}}` — change `beachfc` to her real code word |
| `TOKEN_SECRET` | a long random string (signs the session cookie) |
| `SHEET_URL` | your Apps Script Web App URL ending in `/exec` |

Then **re-deploy** (variable/binding changes only take effect on a new deployment).

## 4. Custom domain
Pages → **Custom domains → Set up** → `math.brisaloca.com`. DNS is already on Cloudflare, so it's ~one click.

## 5. Google Sheet (if not done yet)
New Sheet → **Extensions → Apps Script** → paste `Code.gs` → **Deploy → Web app**, Execute as **Me**,
Who has access **Anyone** → copy the `/exec` URL into `SHEET_URL`. The URL is now private (only the function
calls it). Optional hardening: have the function send a shared secret header and check it in `Code.gs`.

---

## Security summary
- ✅ Code words never appear in the page source (checked server-side).
- ✅ Sheet URL hidden; only signed-in sessions can write; the name written is taken from the signed token (can't be spoofed).
- ✅ Progress lives in **KV**, keyed to her profile — cross-device and not editable from the browser. (A local copy is
  also cached so the app still works if the network blips.)
- ⚠️ Anyone who knows the code word can sign in (by design). Use Cloudflare Access only if you ever want the site fully private.

## How practice adapts
- **Daily Patrol is smart:** it weights questions toward her weakest topics (lowest accuracy) and under-practiced
  ones, eases off mastered topics, and mixes in due items from the Review Misses pile. Topic-specific practice
  stays pure (only that topic).
- **Review Misses:** a missed question is saved and must be answered correctly twice to clear — whether she meets it
  again in the 🎯 pile or it resurfaces during Daily Patrol.

## Quality checks
- Questions: 600,000+ generated and independently re-derived by a separate math engine — 0 errors.
- Auth: session-token signing/verification passed 7/7 (wrong secret, tampered payload/signature, expired, malformed all rejected).
- Adaptive selection: verified to bias toward weak/under-practiced topics and cap review-miss surfacing as intended.
