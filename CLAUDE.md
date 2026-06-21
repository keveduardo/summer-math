# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Beach Math** — a gamified math-practice web app built for a single user (a rising 7th grader) to review Accelerated Math 6 over the summer. Auth is by shared *code word*, progress syncs across devices via Cloudflare KV, and each answered question is optionally logged to a Google Sheet. Themed around Junior Lifeguards / Beach FC / candy (XP, lifeguard-rank levels, streaks, mastery "treats").

## Architecture

A Cloudflare **Worker** with two responsibilities, split in `src/index.js`'s single `fetch` handler:
- `/api/*` → `handleApi()` (the JSON API)
- everything else → `env.ASSETS.fetch(request)` serves the static site from `public/`

### `src/index.js` — the Worker (~136 lines, no dependencies)
- **Auth** is an HMAC-SHA256 signed session cookie (`bm_session`, 120-day expiry) built with Web Crypto. `sign`/`verify` handle base64url + expiry. There is no DB of sessions — the cookie *is* the session.
- **Routes:** `POST /api/login` (matches `{code}` against `USERS_JSON`, sets cookie), `GET /api/me`, `POST /api/logout`, `POST /api/log` (forwards an event row to `SHEET_URL`), `GET /api/load` / `POST /api/save` (KV-backed progress at key `progress:<id>`).
- **Security invariant:** code words and the Sheet URL never reach the browser; the `name` written to the Sheet/log is taken from the *signed token*, not the request body, so it can't be spoofed. Every authenticated route re-verifies the cookie before touching KV or the Sheet.

### `public/index.html` — the entire frontend (~1275 lines, single file)
- React 18 (UMD) + Babel-standalone loaded from CDN; **JSX is transpiled in the browser**. There is no build step and no bundler.
- **Question generators** (~26 pure `genX()` functions) each return `{type, prompt, value, tol, display, explain}`; `type` is `numeric`, `fraction`, or `choice`.
- **`TOPICS`** table (25 topics across 6 units) wires each topic to its generator; **`SCHEDULE`** defines the 8-week plan, gated by week via `START` date (`2026-06-15`).
- **Adaptive engine:** `weightedTopic`/`drawSmart` bias question selection toward weak/under-practiced topics, ease off mastered ones (≥`MASTERY_GOAL` correct), and resurface a *review-miss queue* (a missed question must be answered correctly twice to clear).
- **Dual storage:** `localStorage` (via the `Store` wrapper, with in-memory fallback) for offline resilience; server KV is the source of truth. On load, `Game` fetches `/api/load` and falls back to localStorage. Saves are written to localStorage immediately and `POST /api/save` is **debounced 700ms**.

### Request flow
Page load → Worker serves `index.html` → React calls `GET /api/me` → render `Gate` (login) or `Game`. Login → `POST /api/login` sets the cookie. In `Game`: `GET /api/load` hydrates progress; each answer updates state, writes localStorage, debounce-saves to KV, and fire-and-forgets `POST /api/log` to the Sheet.

### Avatar + World Cup kit rewards (in `public/index.html`)
A reward loop layered on the existing streak/daily-goal fields. No Worker changes — it all rides the opaque `progress` JSON through `/api/save`/`/api/load`.
- **Data:** `progress.avatar` `{skin,hair,hairColor,face}` (indices into `SKINS`/`HAIR_STYLES`/`HAIR_COLORS`/`FACES`) and `progress.kit` `{pieces,closet,team,tokens,milestones,lastPrizeDay,lastUnlock}`. Defaults live in `DEFAULT_AVATAR`/`DEFAULT_KIT`. **`normalizeProgress()` deep-fills these** and is applied on *both* load paths — required because the KV/`/api/load` object is raw and pre-feature saves lack the nested fields.
- **Reward engine:** all in the pure `applyAnswer`. Completing the daily goal (`today.count >= DAILY_GOAL`, guarded once-per-day by `kit.lastPrizeDay`) grants the next base piece via `nextKitPiece` (`boots→socks→shorts→jersey`). Streak milestones from `streakMilestones()` (3/7/14/30, then +10) grant a jersey **token** + perk. `kit.lastUnlock` is a marker object whose *reference* only changes on a fresh unlock — `submit` diffs it to pop `PrizeModal`.
- **Jerseys:** `TEAMS` (all 48 2026 World Cup nations) with `{primary,secondary,accent,pattern}`; `pattern ∈ solid|vstripes|checkers|halves|sash`. Colors are stylized approximations of home kits (editable). Tokens are spent in the Locker Room to **claim** a team into `kit.closet`; `kit.team` is the **equipped** one (must be null or in closet), worn persistently.
- **Rendering:** `PlayerAvatar` (chibi layered SVG, CSS-animated via `.av-idle`/`.av-cel`) and `MiniJersey` (closet/picker chip). `LockerView` (`view==="locker"`) holds customization + closet + the 48-team picker grouped by `CONF_ORDER`. Entry points: small avatar in the header and a CTA banner atop `MapView`.

## Cloudflare bindings (`wrangler.jsonc`)

- **Assets** binding `ASSETS` → `./public`
- **KV namespace** `BEACH_MATH_KV` (id `79610e8128904ad48a65270b7bbf9e89`) — progress storage
- No D1, no R2.

### Required secrets / vars (Worker → Settings → Variables and Secrets)
- `USERS_JSON` — e.g. `{"beachfc":{"id":"madeleine","name":"Madeleine"},"test":{"id":"test","name":"Test"}}`; maps code word → profile. Change `beachfc` to the real code.
- `TOKEN_SECRET` — long random string that signs the session cookie. **Changing it invalidates all sessions.**
- `SHEET_URL` — Apps Script Web App URL ending in `/exec`; receives logged rows.

The code degrades gracefully if a binding/var is missing (returns `{note: "no kv bound"}` etc.) rather than erroring.

## Run & deploy

There is no `package.json`; use `wrangler` directly (via `npx wrangler` or a global install). Load the **wrangler** skill before running commands.

- **Local dev:** `npx wrangler dev` — serves `public/` and the API; uses a local Miniflare KV (state under `.wrangler/`, git-ignored). API routes needing `USERS_JSON`/`TOKEN_SECRET`/`SHEET_URL` require a local `.dev.vars` file or they fall back to defaults (login won't work without `USERS_JSON`).
- **Deploy:** `npx wrangler deploy`. Variable/binding changes only take effect on a new deployment.
- **Secrets:** set via the dashboard, or `npx wrangler secret put TOKEN_SECRET` (etc.).

## Gotchas for future sessions

- **The README is stale on architecture.** It describes a Cloudflare **Pages** project with `functions/api/[[path]].js` and `Code.gs`; the project was migrated to a **Worker** (`src/index.js` + `wrangler.jsonc`). The README's setup steps reference the Pages UI but the secrets/bindings/Sheet info is still accurate. Don't reintroduce a `functions/` folder.
- **No tests, no lint, no build.** Generator correctness was validated out-of-band (README claims 600k generated, 0 errors). If you change a generator, manually verify `value`/`display`/`explain` agree.
- Frontend is one file with inline styles (`S`, `CSS`); keep changes self-contained there.
