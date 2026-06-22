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
- **Hardening:** `/api/login` is soft rate-limited per IP via KV (`rl:login:<ip>`, ~10/10min, fails open). `withSecurityHeaders` adds HSTS/`X-Frame-Options`/`nosniff`/`Referrer-Policy` to **Worker** responses (`/api/*`); static assets get the same headers via `public/_headers` (Workers Assets serves matching files *before* the Worker, so Worker headers don't reach them). No CSP — the page loads CDN scripts (with SRI hashes) and runs Babel `eval`. Full HTTPS redirect still needs Cloudflare "Always Use HTTPS" (assets bypass the Worker's redirect).

### `public/index.html` — the entire frontend (~1275 lines, single file)
- React 18 (UMD) + Babel-standalone loaded from CDN; **JSX is transpiled in the browser**. There is no build step and no bundler.
- **Question generators** (~31 pure `genX(level)` functions) each return `{type, prompt, value, tol, display, explain}`; `type` is `numeric`, `fraction`, `inequality`, or `choice`. Every generator takes a **difficulty tier** `level` (1 easy → 2 standard → 3 multi-step → 4 word problem) and self-clamps via `clampLvl(level, max)`. Word problems are the top tier where they make sense. Two-step equations/inequalities live as the L3/L4 tiers of `genOneStepEq`/`genOneStepIneq`.
- **`TOPICS`** table (29 topics across 6 units: 24 core Math 6 + 5 Grade 7) wires each topic to its generator and declares **`max`** (highest tier: 4 = has a word-problem tier, 3 = multi-step only, 2 = limited) and optional **`g7: true`** (a Grade 7 extension topic). **`SCHEDULE`** defines the 8-week plan, gated by week via `START` date (`2026-06-15`).
- **Grade 7 expansion / gating.** Five `g7` topics — `scale` (U4), `angles` + `solids` (U5), `probability` + `populations` (U6) — plus two-step equations/inequalities and added percent/expression/proportion tiers bring coverage up to PA Core / CCSS **Grade 7**. The `g7` topics stay **locked** until the student masters `G7_UNLOCK_AT` (12) of the `CORE_IDS` (the 24 Math 6 topics); `g7Unlocked(progress)`/`unlockedIds(ids, progress)` gate them out of practice pools (`startMix`/`startWeek`/`startReview`) and the placement test, and `MapView` renders locked `TopicCard`s ("Unlocks when you master N more"). No prereq graph — a single global threshold. Acing placement seeds enough mastery to unlock them immediately.
- **Adaptive engine — two axes.** *Which topic:* `weightedTopic`/`drawSmart` bias selection toward weak/under-practiced topics, ease off mastered ones (≥`MASTERY_GOAL` correct), and resurface a *review-miss queue* (a missed question must be answered correctly twice to clear). *How hard:* each topic carries its own difficulty in `progress.topics[id].level` (+`run`); in `applyAnswer`, `LEVEL_UP_RUN` (3) consecutive correct steps the level up (capped at `topic.max`), any miss steps it down. `makeProblem(tid, progress)` reads the level via `topicLevel()` and passes it to the generator; `makeLeveledProblem(tid, level)` builds at an explicit level (placement only).
- **Baseline placement (`PlacementView`, `view==="placement"`):** a compact adaptive assessment — one question per topic (unit-ordered), where the offered difficulty rises after a correct answer and falls after a miss *within each unit*. Results **seed** each topic's starting `level`; a topic aced at its top tier is seeded as mastered (`correct/attempts` bumped to `MASTERY_GOAL`) so it "starts advanced but still reviews" via the normal weighting. It is **gated on `progress.placement`** (added to `DEFAULT_PROGRESS`, `null` until taken): absent on every pre-feature save, so existing students get it on next login; a "Retake placement" link in the footer re-runs it. Seeding is **non-destructive** — it never lowers existing `correct`/`attempts`.
- **Dual storage:** `localStorage` (via the `Store` wrapper, with in-memory fallback) for offline resilience; server KV is the source of truth. On load, `Game` fetches `/api/load` and falls back to localStorage. Saves are written to localStorage immediately and `POST /api/save` is **debounced 700ms**.

### Request flow
Page load → Worker serves `index.html` → React calls `GET /api/me` → render `Gate` (login) or `Game`. Login → `POST /api/login` sets the cookie. In `Game`: `GET /api/load` hydrates progress; each answer updates state, writes localStorage, debounce-saves to KV, and fire-and-forgets `POST /api/log` to the Sheet.

### Avatar + World Cup kit rewards (in `public/index.html`)
A reward loop layered on the existing streak/daily-goal fields. No Worker changes — it all rides the opaque `progress` JSON through `/api/save`/`/api/load`.
- **Data:** `progress.avatar` `{skin,hair,hairColor,face,body}` (indices into `SKINS`/`HAIR_STYLES`/`HAIR_COLORS`/`FACES`/`BODY_TYPES`) and `progress.kit` `{pieces,closet,team,variant,tokens,milestones,lastPrizeDay,prizeCount,lastUnlock}`. Defaults live in `DEFAULT_AVATAR`/`DEFAULT_KIT`. **`normalizeProgress()` deep-fills these** and is applied on *both* load paths — required because the KV/`/api/load` object is raw and pre-feature saves lack the nested fields. New fields are always appended to defaults and arrays (e.g. `HAIR_STYLES`) so persisted indices never shift.
- **Reward engine:** all in the pure `applyAnswer`. Completing the daily goal (`today.count >= DAILY_GOAL`) grants the next base piece via `nextKitPiece` (`boots→socks→shorts→jersey`), **up to `MAX_DAILY_PRIZES` (2) per day** — one per completed goal, tracked by `kit.prizeCount`/`lastPrizeDay` (resets daily). Streak milestones from `streakMilestones()` (3/7/14/30, then +10) grant a jersey **token** + perk. `kit.lastUnlock` is a marker whose *reference* only changes on a fresh unlock — `submit` diffs it to pop `PrizeModal`.
- **Jerseys:** `TEAMS` (all 48 2026 nations) each have **`home` and `away`** kits built with `K(pattern, primary, secondary, shorts, socks, trim)`; `pattern ∈ solid|vstripes|checkers|halves|sash`. Distinct `shorts`/`socks`/`trim` keep similar shirts apart (e.g. Colombia vs Ecuador). Claiming a team owns **both** kits (`kit.closet`); `kit.team`+`kit.variant` ('home'|'away') is the equipped kit, worn persistently. `GENERIC_KIT` is the default look. Colors are stylized approximations (home grounded in real kits, away realistic alternates) — easily editable.
- **Rendering:** `PlayerAvatar` resolves the equipped variant kit and renders shirt pattern + `shorts`/`socks`/`trim` (collar, cuffs, hem, crest, number, fabric shading). `MiniJersey({kit})` is the closet/picker chip (shirt only). `LockerView` (`view==="locker"`) holds customization, the closet (home+away per owned team), and the 48-team picker grouped by `CONF_ORDER`. Entry points: small avatar in the header and a CTA banner atop `MapView`. To preview kit art without a browser, rasterize the SVG with `@resvg/resvg-js` (Windows `convert` is the filesystem tool, not ImageMagick).

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
- **Tests, but no lint/build.** `npm test` (`test/run-tests.mjs`) extracts the inline `<script type="text/babel">`, transpiles it with esbuild, runs it in a Node `vm` with a React stub, and asserts on the pure functions. It sweeps **every topic at every level** (value/display must agree, no NaN/empty), re-solves the inequality generator's math, and checks the level-up engine + placement-adjacent logic + 48-team kit data. CI runs it on push/PR (`.github/workflows/test.yml`). If you change a generator, run `npm test` — the sweep catches `value`/`display` mismatches. (There's no browser harness; React rendering can't be verified headlessly.)
- Frontend is one file with inline styles (`S`, `CSS`); keep changes self-contained there.
