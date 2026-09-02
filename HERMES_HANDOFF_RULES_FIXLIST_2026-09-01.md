# Module 8 (Rules Engine) — verified fix list handoff — 2026-09-01

**From:** coordinator/supervisor role (this session).
**To:** `@integration-engineer` (owns Module 8 per `AGENTS.md`).
**Do not hand this to `@qa-test-engineer`** until `npm run test:gate` is green —
their job starts at raising the floor, not at fixing the spec.

**Scope:** this is a status re-verification of `RULES_MODULE8_REVIEW_2026-09-01.md`
against the code as it stands right now, plus the exact remaining edits. It does not
replace that review — read it first for the *why*. This doc is the *what's left*.

---

## What's already fixed (verified just now, don't redo)

- **Blocker 1** (`SITE_JEBEL_ALI` import from the wrong module) — **fixed.**
  `src/rules/detectEvents.js:4` now imports it from `../simulator/scenarios.js`.
  Confirmed by direct import: `node -e "import('./src/rules/detectEvents.js')"`
  loads cleanly, no `SyntaxError`.
- **Blocker 2** (spec import depth) — **fixed.** The spec has also since been moved
  from `test/pending/rules.test.js` up to `test/rules.test.js`, and the gate floor
  in `src/tools/test-gate.js` raised to `DEFAULT_MIN_TESTS = 91` in anticipation.
  **This move was premature** — see Blocker 3 below, still open — but don't move it
  back down; just fix it in place.

## What's still open (verified just now — exact current state)

Ran `node --test test/rules.test.js` directly: **3 pass / 3 fail**, right where the
review's "even if fixed" prediction said it would land once the import errors were
cleared. The gate (`npm run test:gate`) is currently failing because of this file —
confirm that's the only red spot before re-running the full gate after fixes.

### Blocker 3 — the spec still doesn't call `detectEvents` *(Critical, unfixed)*

`test/rules.test.js` builds `canonical` records via `normalizeRecord` and asserts on
`r.canonical.type`, `r.canonical.eventId`, `r.canonical._phase` — none of which exist
on a normalized record (`normalizeRecord`'s actual return shape is in
`src/decode/normalize.js:97-113`: `deviceId, imei, tenantId, assetId, tsMs, lat, lon,
speed, angle, altitude, satellites, priority, ignition, movement, state, engine,
externalVoltageMv, batteryPct, unplug` — no `type`, no `eventId`, no `_phase`).
`detectEvents` is imported nowhere in the file. The 3 failing tests (geofence,
after-hours, idle) are checking counts that can only ever be 0; the 3 passing tests
pass vacuously by filtering on a field (`_phase`) that's always `undefined`.

Also worth fixing while rewriting (not in the original review, found on this pass):
the spec's `resolveAssignment(r.imei, r.timestampMs)` call passes an IMEI where
`resolveAssignment(deviceId, tsMs, ...)` (`src/store/seed-data.js:92`) expects the
device's `id`. `ASSIGNMENTS` rows key on `DEVICES[0].id`, not IMEI strings, so every
assignment resolves to `null` today — assetId/tenantId silently fall back to
`device.ownerTenantId` on every record. It doesn't currently break the 3 passing
tests (they don't depend on assetId), but fix it together with Blocker 3 rather than
leaving a second latent bug. The corrected pattern (`device.id`, matching
`test/pending/ledger.test.js`'s idiom) is already in the review's skeleton at the
bottom of `RULES_MODULE8_REVIEW_2026-09-01.md` — use that skeleton as the base,
it's still accurate.

**Fix:** rewrite the spec to build canonical records via `resolveAssignment(device.id,
tsMs)` + `normalizeRecord`, then call `detectEvents(records, {})` and assert on the
**returned events array** (`type`, `assetId`, `tenantId`, `eventId`, `detail`) — not
on the canonical records. Keep it to 6+ cases: geofence (≥1 enter, ≥1 exit),
after-hours positive (23:30 GST fires) **and** the new negative case below, idle
(day-cycle fires at a scenario-sized threshold), dedupe (identical eventIds across
two runs, **and** no collisions within one run — this second assertion is what
catches Finding 6 below; it fails today even after Finding 6 is fixed if the window
key logic is wrong, so don't skip it).

### Finding 4 — after-hours uses ambient local time *(High, unfixed)*

`src/rules/detectEvents.js:114`: `localDate.getHours()`. Still wall-clock-dependent —
confirmed the file is unchanged there since the review (same line content, same bug).
**Fix:** `getUTCHours()` (the +4h GST offset is already added manually at line ~112,
so UTC-hours-of-the-shifted-timestamp is exactly the local hour). **Add a daytime
negative case** to the rewritten spec — a working-hours (e.g. 14:00 GST) record with
`ignition: true` that must produce zero `after-hours-ignition` events. Per the
review, the existing `after-hours` scenario (23:30 GST) cannot catch this bug on its
own because both the broken and fixed code classify 23:30 as "outside" — the
negative case is what makes this fix provable.

### Finding 5 — idle threshold mislabeled *(Medium, unfixed)*

`src/rules/detectEvents.js:9`: `DEFAULT_IDLE_TOO_LONG_MS = 60_000` commented
`// 60 min of consecutive idle`. Still 1 minute, not 60 — unchanged since the review.
**Fix:** set the production default to `3_600_000` (a real 60 min) and correct the
comment. In the rewritten spec, pass `config: { idleTooLongMs: 60_000 }` (or whatever
value the `day-cycle` scenario's actual idle-spell lengths support — verify with a
scratch run before picking the number, the scenario is compressed) so the test
exercises the real threshold logic at a scenario-appropriate scale rather than
silently depending on the mislabeled default.

### Finding 6 — geofence `eventId` collides across crossings *(Medium, unfixed)*

`src/rules/detectEvents.js:81,91`: window key is still the literal string
`'transition'` for every enter/every exit — unchanged since the review. Two enters
in one stream hash to the same `eventId` and the second is indistinguishable from a
resend. **Fix:** use a per-transition key — the transition record's own `tsMs` is
simplest and is already in scope at that point in the loop (`r.tsMs`). Confirm the
rewritten dedupe test's "no collisions within one run" assertion actually exercises
a multi-crossing scenario, or this regresses silently again.

### Finding 7 — dead import *(Low, unfixed)*

`src/rules/detectEvents.js:2`: `import { IO } from '../config.js';` — still unused
(confirmed via grep, `IO` doesn't appear anywhere else in the file). **Fix:** delete
the import line.

---

## Also needed before this counts as done

- **`package.json` has no `test:rules` script.** `TASKS.md`'s P3 gate (line 106)
  reads: `**GATE:** test:rules green (each event type) + WhatsApp integration test
  (Meta sandbox) + de-duplication test`. Add
  `"test:rules": "node --test test/rules.test.js"` alongside the other `test:*`
  scripts in `package.json`.
- Rules 4–5 (tamper-unplug, low-battery) are already implemented in
  `detectEvents.js` (not stubs, contrary to the original review's "correctly
  deferred as comment stubs" note — the power-signal fields landed and this got
  built ahead of that note). They're in scope for the rewritten spec too: add at
  least one assertion per rule using the `tamper` scenario, respecting invariant 3
  (a missing `batteryPct`/`unplug` must never fire — the null case, not the falsy
  case).
- Once `node --test test/rules.test.js` is green standalone, run
  `npm run test:gate` for the full-suite verdict before calling this done. The
  floor is already at 91 (raised ahead of time) — don't raise it again.

## Explicitly not in scope for this handoff

- Wiring rules → messaging (`TASKS.md` P3, separate task, messaging is still a
  credential-blocked stub per `CLAUDE.md`).
- Anything in `src/ledger/` — human-owned, P2, untouched.

## Verification the coordinator will re-run before sign-off

```bash
cd telematics
node -e "import('./src/rules/detectEvents.js').then(()=>console.log('loads ok'))"
node --test test/rules.test.js        # expect 0 fail
npm run test:rules                    # new script, same result
npm run test:gate                     # full gate, 91+ pass, no skips
npm run demo                          # unaffected, sanity check
```
