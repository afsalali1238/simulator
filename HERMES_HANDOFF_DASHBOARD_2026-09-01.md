# HERMES — Handoff: local live dashboard, dev-server duplication, CORS fix

> **Who this is for:** the agent (or developer) we're calling **hermes**. Standalone
> brief — you don't need the rest of this conversation. Everything you need is in this
> folder and this doc.
>
> **Your job in one sentence:** reconcile two duplicate "shared-store dev server"
> scripts down to one, decide whether the CORS fix in `src/api/server.js` should be
> folded into that commit or its own, and leave the local live-dashboard workflow in a
> committed, non-conflicting state.
>
> **Time-box mindset:** this is cleanup + a small real bug fix, not new product work.
> Don't touch Module 8 rules (separate, already-documented, still broken — see
> `HERMES_HANDOFF_RULES_FIXLIST_2026-09-01.md`) and don't touch the ledger.

---

## 0. TL;DR

The owner (afzl) wanted to *see* the simulator working — watch a vehicle's state
live instead of reading test output. That surfaced two real things:

1. **A genuine bug in `src/api/server.js`**: it required `X-Tenant-Id` on every
   request, including CORS preflight (`OPTIONS`), which never carries that header.
   Any browser client hitting this API was silently blocked before ever making a
   real `GET`. **Fixed and verified** — see §2.
2. **A design gap, not a bug**: `npm run start:ingest` and `npm run start:api` are
   separate processes, and the zero-setup memory store lives in-process — so run
   them separately (as you would in a real deployment) and the API can never see
   what ingestion just stored. Two people independently wrote the same fix this
   session: `src/tools/dev-server.js` (mine) and `src/tools/live-dashboard.js`
   (found already on disk, already wired to `npm run dashboard` in
   `package.json`, not written by me). **These need to become one file.** See §3.

Nothing here is committed. `git status --short` at the repo root shows both files
untracked, plus a new `telematics/dashboard/` folder (the browser dashboard itself),
alongside older uncommitted work (Module 8 rules, in progress and broken — not
yours to fix, just don't let it block your commit).

---

## 1. Ground truth right now

Verified by actually running things this session, not just reading docs:

- `npm test` (memory mode): **88/91 pass, 3 fail** — all 3 failures are in
  `telematics/test/rules.test.js` (Module 8, separate in-flight work, see the rules
  fixlist doc). Not your problem to fix, just don't let your commit get blamed for
  it — it was already broken before you touch anything.
- `npm run test:scenarios` (11/11), `npm run test:replay` (5/5), `npm run test:api`
  (6/6, **after** the CORS fix — reran clean) — all green.
- `npm run demo` — clean, matches documented output.
- Live end-to-end proof (simulator → real TCP → shared-store server → HTTP API →
  browser dashboard) — done manually this session, works.

---

## 2. The CORS fix — already applied, verify don't redo

**File:** `telematics/src/api/server.js`, inside the `http.createServer(async (req,
res) => { ... })` handler, right after `path = url.pathname;` and before the
`/health` check.

**What changed:** added an early return for `req.method === 'OPTIONS'` that
responds `204` with `access-control-allow-origin: *`,
`access-control-allow-headers: x-tenant-id`, `access-control-allow-methods:
GET,OPTIONS`, `access-control-max-age: 600` — **before** the tenant-header check
that was rejecting every preflight with `400`.

**Why it was real, not a dashboard quirk:** any browser-based client (not just this
one dashboard) sends a CORS preflight before a cross-origin request with a custom
header like `X-Tenant-Id`. The preflight never carries that header by spec. The old
code demanded it on every request path with no exception, so preflights always got
`400` and the browser never sent the real `GET`. Confirmed via `curl -X OPTIONS`
before/after — see the conversation transcript if you want the exact repro, but the
short version: before the fix, `OPTIONS /positions` → `400`; after, `204` with the
right headers, and the dashboard went from permanently "checking…" to "connected."

**Verification:**
```bash
cd telematics
npm run test:api          # 6/6, unaffected
node src/tools/dev-server.js &     # or live-dashboard.js, see §3
curl -si -X OPTIONS http://localhost:8080/positions \
  -H "Origin: null" -H "Access-Control-Request-Method: GET" \
  -H "Access-Control-Request-Headers: x-tenant-id"
# expect: HTTP/1.1 204, with access-control-allow-* headers
```

This fix should ship regardless of what you do with §3 — it's correct on its own
merits and has nothing to do with the duplicate-script cleanup.

---

## 3. The duplicate dev-server — pick one, delete the other

Two files, same purpose, written independently in parallel this session:

| | `src/tools/dev-server.js` | `src/tools/live-dashboard.js` |
|---|---|---|
| Wired to a script? | No | Yes — `"dashboard": "node src/tools/live-dashboard.js"` in `package.json` |
| Ports | `INGEST_PORT`/`API_PORT` env-configurable, defaults 5027/8080 | Hardcoded 5027/8080 |
| Store | `makeStore(config.db)` — respects `DB=pg` | `makeStore('memory')` — memory-only, ignores `DB` env |
| Graceful shutdown | Uses `ingest.drain()` / `api.drain()` (the real P0 drain contract — finishes in-flight work) | Uses `ingest.close()` / `api.close()` (immediate close, no drain) |
| Startup banner | Ports + next-step commands | Ports + next-step commands + prints the known tenant/asset IDs (nice touch for someone new to the seed data) |

**Recommendation:** keep `live-dashboard.js` as the base (it's already wired to
`npm run dashboard`, and its tenant/asset ID printout is genuinely more useful for
someone who hasn't memorized the seed fixtures), but port over two things from
`dev-server.js` before deleting it:

1. **Respect `DB=pg`.** `makeStore('memory')` hardcoded means this tool silently
   can't be used to sanity-check the pg path. Change to `makeStore(config.db)`
   (import `{ config }` from `'../config.js'`, same as `dev-server.js` does).
2. **Use `drain()`, not `close()`**, for the SIGINT handler. `close()` doesn't wait
   for in-flight requests or apply the `SHUTDOWN_TIMEOUT_MS` contract the rest of
   the P0 hardening established for both servers — using it here is a small
   inconsistency with everything Phase P0 already proved out (see `TASKS.md` P0
   section, `src/lifecycle/shutdown.js`).

After merging those two changes into `live-dashboard.js`, delete `dev-server.js`
entirely — don't leave both on disk even as "just in case."

**Don't** add a second npm script for this — `npm run dashboard` already exists and
is the right name; just make sure whichever file survives is the one it points to.

---

## 4. The dashboard itself (`telematics/dashboard/index.html`)

New, untracked, not written by you but part of the same story — no action needed
unless you spot something wrong. Single self-contained HTML/CSS/JS file (matches
this repo's zero-framework convention for the API), polls `/devices` and
`/positions` every second against a configurable API base + tenant dropdown (all
three seed tenants pre-filled), renders: vehicle state panel (device/asset, last
update, ignition, movement, coarse state, speed, lat/lon, ECU engine hours),
devices-visible-to-tenant list, a canvas-drawn lat/lon track, and a scrolling raw
feed. Ignition/movement render `null` as "unknown (null)" explicitly, in amber —
not coerced to off — because that distinction (invariant 3) is the whole point of
several scenarios (`tamper` especially). Leave that rendering choice alone if you
touch this file.

---

## 5. What "done" looks like for this handoff

- [ ] CORS fix in `src/api/server.js` is in a commit (own commit, or folded with
      the dashboard work — owner's call, not yet decided as of this doc).
- [ ] Exactly one of `dev-server.js` / `live-dashboard.js` exists, with the two
      improvements from §3 folded in, and `npm run dashboard` points at it.
- [ ] `npm test` still shows the same 88/91 (3 known rules failures, untouched).
- [ ] `npm run test:api` still 6/6.
- [ ] Manual smoke test: `npm run dashboard` in one terminal, `npm run sim --
      --scenario day-cycle` in another, `dashboard/index.html` open in a browser,
      shows live data (not just "connected" — actual position/state updates).
- [ ] Commit message(s) make clear this is dev-tooling + a CORS bug fix, not
      product work — keep it out of whatever commit eventually lands the Module 8
      rules fix, they're unrelated.

## Explicitly not in scope for this handoff

- Module 8 rules (`src/rules/`, `test/rules.test.js`) — separate, already
  documented, still 3/6 failing. See `HERMES_HANDOFF_RULES_FIXLIST_2026-09-01.md`.
- Anything in `src/ledger/` — human-owned, P2, untouched.
- Pushing to GitHub / deploying anywhere (Vercel, AWS) — explicitly deferred by the
  owner ("we can push others later"). Don't push unless asked again.
