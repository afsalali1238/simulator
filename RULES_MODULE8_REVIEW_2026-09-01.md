# Module 8 (Rules Engine) — build review — 2026-09-01

**Reviewer:** Claude (docs / review role).
**Scope:** the P3 rules slice delivered against `HERMES_HANDOFF_RULES.md` —
`telematics/src/rules/detectEvents.js` and `telematics/test/pending/rules.test.js`
(both under `gps-build/`).

---

## Verdict — read this first

The delivery is a **non-functional first attempt**, not a finished module.

- The rule module **does not load** — `detectEvents.js` throws a `SyntaxError` at
  import time.
- Its "proof" test **never runs** — `rules.test.js` crashes on module resolution
  before a single assertion executes, and even if that were fixed it does not call
  the rules engine at all.
- The two claims that *do* hold — **85/85 gate-safe** and **boundaries respected** —
  hold precisely *because* the new code is entirely invisible to the gate. Gate
  safety here is real but says nothing about whether the rules work.

The good news: the **logic of the three "ready" rules is sound**. In a corrected
scratch harness they fire correctly (geofence 2, after-hours 15, idle 8/1). So this
is a **wiring + test problem, not a redesign** — the fixes below are small and
well-bounded.

**Do not** mark Module 8 delivered, and **do not** move the spec into the gate,
until Blockers 1–3 are fixed and the spec actually exercises `detectEvents`.

---

## What I verified (commands + actual results)

| Check | Command | Result |
|---|---|---|
| Merge gate still green | `npm test` / `npm run test:gate` | **85/85, GATE PASSED, floor 85** — claim TRUE |
| Does the module load? | `import('./src/rules/detectEvents.js')` | **SyntaxError** — does not load |
| Does the spec run? | `node --test test/pending/rules.test.js` | **ERR_MODULE_NOT_FOUND** — `# tests 1 # fail 1`, 0 of 6 assertions execute |
| Is the rule *logic* sound? | corrected scratch harness (outside the repo) | geofence **2**, after-hours **15**, idle **8** (@60s) / **1** (@60s) — logic works once wired |

---

## Findings, by severity

### Blocker 1 — `detectEvents.js` does not load *(Critical)*

`src/rules/detectEvents.js:12` imports `SITE_JEBEL_ALI` from
`../simulator/phases.js`, but that constant is exported from
`../simulator/scenarios.js` (`phases.js` exports only `PHASES, advance,
distanceMeters, hashString, makeRng, runPhasePlan`). ES-module linking fails:

```
SyntaxError: The requested module '../simulator/phases.js'
does not provide an export named 'SITE_JEBEL_ALI'
```

Any file that imports `detectEvents` crashes on load. This is exactly what
`HERMES_HANDOFF_RULES.md` §2 warned about ("`SITE_JEBEL_ALI` — import it in both the
rule and the test", named as a `scenarios.js` export).

**Fix:** import `SITE_JEBEL_ALI` from `../simulator/scenarios.js`. `distanceMeters`
can stay from `phases.js`, or import both from `scenarios.js` (it re-exports
`distanceMeters`).

### Blocker 2 — the pending spec never runs *(Critical)*

`test/pending/rules.test.js:13–16` import from `../src/...` — one level up from
`test/pending/`, i.e. `test/src/...`, which does not exist. The proven template,
`ledger.test.js`, correctly uses `../../src/...` (two levels). Result:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module
.../telematics/test/src/simulator/scenarios.js
```

The file fails to load; node reports it as one failing test; **none of the six
tests execute**. So "6-test pending spec (same pattern as ledger.test.js)" is not
accurate — it is a file that crashes on import.

**Fix:** `../src/` → `../../src/` on all four imports.

### Blocker 3 — even fixed, the spec does not test the rules *(High)*

`rules.test.js` never imports or calls `detectEvents`. Its `seedEcuReadings()`
normalizes each scenario record, then the assertions look for
`r.canonical.type === 'geofence-enter'` (and the other event types). But a
**normalized record has no `.type` field** — only the *events returned by
`detectEvents`* do. So `canonical.type` is always `undefined`:

- the three "≥ 1 event" assertions (geofence, after-hours, idle) can only ever
  **fail** (count is always 0);
- the three tamper / dedupe assertions filter on `canonical._phase === 'unplugged'`
  (also absent on the canonical record) and so **pass vacuously**, testing nothing.

Zero of the six exercise the module under test. By contrast `ledger.test.js`
imports and calls `computeUtilisation` / `sealUtilisationRecord` directly — that is
the shape this spec was supposed to copy.

**Fix:** import `detectEvents`, feed it the normalized (canonical) records, and
assert on the returned events array. Skeleton at the end of this doc.

### Finding 4 — after-hours uses ambient local time *(High)*

`detectEvents.js:122` computes the hour with `new Date(localMs).getHours()` after
manually adding a +4h offset. `getHours()` returns the hour in the **test runner's**
timezone, so the verdict depends on where it runs. Demonstrated on this machine
(Asia/Dubai) for a record at **14:00 GST — normal working hours**:

| | value | window verdict |
|---|---|---|
| `getHours()` (as written) | **18** | **fires a false after-hours alert** |
| `getUTCHours()` (correct) | 14 | correctly silent |

This reintroduces exactly the ambient-clock nondeterminism that `phases.js` and
`scenarios.js` forbid ("no `Date.now`"). Note the `after-hours` scenario (23:30 GST)
**cannot catch this** — both branches classify 23:30 as "outside" — so the current
scenario would pass even with the bug.

**Fix:** use `getUTCHours()` (the code already applies the +4h offset manually).
Add a **daytime negative case** (a working-hours record that must *not* fire).

### Finding 5 — idle threshold is mislabeled and scenario-mismatched *(Medium)*

`detectEvents.js:17`: `DEFAULT_IDLE_TOO_LONG_MS = 60_000` with the comment
`// 60 min of consecutive idle`. **60,000 ms is 1 minute, not 60.** And it is
load-bearing: at a real 60-minute threshold the compressed scenarios produce idle
spells of only a few minutes, so `idle-too-long` fires **0×** on both `day-cycle`
and `yard-idle` — the intended `dayEvents >= 1` proof would fail.

**Fix / decision:** set the production default to a real 60 min
(`3_600_000`), fix the comment, and have the test pass
`config.idleTooLongMs` sized to the compressed scenarios (~1 min). A mislabeled
minutes/seconds constant is the precise class of bug this codebase guards against
elsewhere (the "60× billing error" note in `engine-hours.js`).

### Finding 6 — geofence `eventId` collides across crossings *(Medium)*

`detectEvents.js:89,99` build the dedupe id with a **constant** window key,
`'transition'`. So every `geofence-enter` for an asset hashes to the *same*
`eventId` (likewise every exit). Two enters in one stream would be treated as
duplicates and one silently dropped. It does not bite `geofence-cross` (one exit +
one enter, different types), but it is latent for any multi-crossing stream and
defeats the dedupe guarantee the handoff's §3 asked for.

**Fix:** make the window key per-transition (e.g. the transition record's `tsMs`
or a transition index), as the handoff's dedupe note intended.

### Finding 7 — dead import *(Low)*

`detectEvents.js:10` imports `IO` from `config.js`; it is never used. Remove it.

---

## What is genuinely right (credit where due)

- **Gate safety is correct and real.** `src/tools/test-files.js` collects tests with
  a non-recursive `readdirSync(test/)`, so `test/pending/` is excluded; `npm test`
  and `test:gate` hold at 85/85. The mechanism is used exactly as intended.
- **Rules 4 and 5 are correctly deferred** as comment stubs, with the invariant-3
  trap ("a missing battery reading is null, never 0") called out in the right place.
- **Boundaries respected:** messaging stays stubbed, ledger untouched, no new
  dependencies, `node:` built-ins only — all as `HERMES_HANDOFF_RULES.md` required.
- **The core design is right:** the canonical-record shape `detectEvents` consumes
  matches `normalize.js`, the `sha256(tenant, asset, type, windowKey)` dedupe idea is
  sound, and rules 1–3 produce the correct events once wired (proven).

---

## Recommended sequence to green

For `@integration-engineer` (or whichever tool applies the code — this review does
not apply fixes):

1. Fix the import source (Blocker 1) and the spec's import depth (Blocker 2).
2. Rewrite the spec to call `detectEvents` on the normalized records and assert on
   the returned events; add a per-event-type case **and** a dedupe case. Add a
   `test:rules` script to `package.json`.
3. Switch after-hours to `getUTCHours()` and add a daytime negative case (Finding 4).
4. Decide the idle threshold: 60-min production default + test override; fix the
   comment (Finding 5).
5. Fix the geofence `eventId` window key (Finding 6); drop the dead import (Finding 7).
6. **Only then** move `rules.test.js` up to `test/` and raise `DEFAULT_MIN_TESTS` in
   `src/tools/test-gate.js` in the same commit — the deliberate, reviewable act the
   gate is designed around.
7. Rules 4–5 (tamper, low-battery) stay blocked until the three power signals reach
   the canonical record — handed to `@protocol-engineer` in
   `HERMES_HANDOFF_POWER_SIGNALS.md`.

---

## Corrected spec skeleton (illustrative — not applied)

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildScenario, scenarioRecords } from '../../src/simulator/scenarios.js'; // ../../
import { resolveAssignment, DEVICES } from '../../src/store/seed-data.js';
import { normalizeRecord } from '../../src/decode/normalize.js';
import { detectEvents } from '../../src/rules/detectEvents.js';           // <-- the module under test

// scenario name -> canonical records, in timestamp order (the rules' real input)
function canonicalRecords(name) {
  return scenarioRecords(buildScenario(name)).map((r) => {
    const device = DEVICES.find((d) => d.imei === r.imei);
    const assignment = resolveAssignment(device.id, r.timestampMs); // by id, like ledger.test.js
    return normalizeRecord(r, { device, assignment });
  });
}

test('geofence: one exit and one enter on geofence-cross', () => {
  const events = detectEvents(canonicalRecords('geofence-cross'), {});
  assert.equal(events.filter((e) => e.type === 'geofence-exit').length, 1);
  assert.equal(events.filter((e) => e.type === 'geofence-enter').length, 1);
});

test('after-hours: fires on the 23:30 GST scenario, and only on ignition===true', () => {
  const events = detectEvents(canonicalRecords('after-hours'), {});
  assert.ok(events.some((e) => e.type === 'after-hours-ignition'));
});

test('idle-too-long: fires on day-cycle at a scenario-sized threshold', () => {
  const events = detectEvents(canonicalRecords('day-cycle'), { config: { idleTooLongMs: 60_000 } });
  assert.ok(events.filter((e) => e.type === 'idle-too-long').length >= 1);
});

test('dedupe: re-running detection yields identical eventIds and no duplicates', () => {
  const recs = canonicalRecords('geofence-cross');
  const a = detectEvents(recs, {}).map((e) => e.eventId);
  const b = detectEvents(recs, {}).map((e) => e.eventId);
  assert.deepEqual(a, b);
  assert.equal(new Set(a).size, a.length); // this fails today for multi-crossing streams — Finding 6
});
```

---

## Docs to refresh (follow-ups)

- `telematics/docs/MODULES.md` still lists Module 8 as *"not yet scaffolded ⛔"* —
  update it once the rework lands (left as-is for now; it is a repo doc afzl owns).
- The Build Dashboard (`Kasper_Build_Dashboard.html`) and session memory were updated
  on 2026-09-01 to reflect this review.

*Scope note: this review covers Module 8 (rules) only. Messaging (Module 7) stays a
credential-blocked stub; the ledger (Module 5) is human-owned P2 — neither is in
scope here.*
