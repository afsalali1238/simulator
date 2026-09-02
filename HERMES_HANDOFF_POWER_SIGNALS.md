# Handoff → @protocol-engineer — surface the three power signals on the canonical record

**From:** Module 8 rules review (2026-09-01).
**Owner of this work:** `@protocol-engineer` (Module 2 — decode / `normalize.js`).
**Blocks:** Module 8 rules 4 (tamper/unplug) and 5 (low-battery). Nothing else waits on it.
**Companion doc:** `RULES_MODULE8_REVIEW_2026-09-01.md` (findings), `HERMES_HANDOFF_RULES.md` §4, §9.

---

## The ask, in one sentence

Decode three IO signals the simulator already emits — external voltage, battery
level, and the unplug flag — onto the canonical normalized record, so the two
deferred rules have something to read. Today they are dropped on the floor.

## Why this is blocked on you, not on the rules

`detectEvents.js` rules 4 and 5 are correctly stubbed with a comment: they can't be
written because the values never reach them. The record `normalize.js` produces
carries ignition / movement / state / engine, but **no power fields**. `config.js`
itself flags this (the note near the IO map: signals 66 / 113 / 252 are *"NOT
decoded into canonical rows yet"*). So the rules author is stuck until decode grows
these fields. This is a Module 2 change, which is your surface — not the rules
author's.

## Exact change

In `src/decode/normalize.js`, read the three IO values and add three canonical
fields. IDs are already named in `src/config.js`:

| IO id | `config.js` name | new canonical field (proposed) | type |
|---|---|---|---|
| 66 | `EXTERNAL_VOLTAGE_MV` | `externalVoltageMv` | `number \| null` |
| 113 | `BATTERY_LEVEL_PCT` | `batteryPct` | `number \| null` |
| 252 | `UNPLUG_DETECTED` | `unplug` | `boolean \| null` |

Use the same `ioValue()` accessor the existing fields use. **Invariant 3 is the
whole point of this task:** when an IO element is absent, the field is `null` —
never `0`, never `false`. Map an absent voltage/battery to `null`; map `unplug` the
way `ignition` is mapped (present 0/1 → boolean, absent → `null`). A flat-looking
`0` that is really "no reading" is exactly the false tamper/low-battery alert the
rule must never raise.

## Field-name contract (please confirm before you build)

The rule author and the decoder must agree on the field names, the same way
`SITE_JEBEL_ALI` is shared between rule and test. The import mismatch that broke the
first rules delivery (a symbol imported from the wrong module) is the failure mode
to avoid here. The three names above are a proposal — lock them with
`@integration-engineer`, then both sides code to the same contract.

## Acceptance criteria

Add a decode test (its own `.test.js`, so the merge gate picks it up) that replays
the **`tamper`** scenario through `normalizeRecord` and asserts:

1. **Work phase (plugged in):** `externalVoltageMv` ≈ 27400 and `batteryPct` === 100.
2. **Unplug tick:** `unplug` === `true` and `externalVoltageMv` collapses to ~0.
3. **Invariant 3:** a record from a scenario with **no** power IO at all (e.g.
   `day-cycle`) has `externalVoltageMv === null`, `batteryPct === null`,
   `unplug === null` — asserted as `null`, not `0`/`false`.

When the test lands, raise `DEFAULT_MIN_TESTS` in `src/tools/test-gate.js` in the
**same commit** (the gate's standing rule: a new proof and its floor bump ship
together). Until then, the 85/85 gate is unaffected.

## Boundaries (unchanged from HERMES_HANDOFF_RULES.md)

- **Don't write the rules.** Rules 4/5 belong to `@integration-engineer`; your job
  ends at putting the three values on the record.
- **Don't touch engine-hours.** The D1 mapping (AVL 102, minutes ×60; 200 retired;
  103/449 forbidden as billing sources) is settled — leave it alone.
- Keep `normalizeRecord` a pure function: no new npm deps, `node:` built-ins only,
  no `Date.now()`.
- Don't un-stub messaging (Module 7) or build the ledger (Module 5).

## ✅ Delivered & verified — 2026-09-01

`normalize.js` now surfaces the three fields, and I verified the change
independently — replaying the `tamper` and `day-cycle` scenarios through
`normalizeRecord`, plus the gate — rather than trusting the delivery report.
Confirmed on the `tamper` replay:

| record | phase | externalVoltageMv | batteryPct | unplug |
|---|---|---|---|---|
| #0–#7 | startup / work (plugged in) | 27400 | 100 | `null` |
| **#8** | **unplugged — event tick** | **0** | **100** | **`1`** |
| #9–#12 | unplugged (draining) | 0 | 92 → 68 | `null` |

`day-cycle` (no power IO): all 48 records `null` on all three fields — invariant 3
holds. Gate unchanged: `npm test` 85/85, `test:gate` GATE PASSED, floor 85.

## Two notes for @integration-engineer before you build rules 4 & 5

1. **`unplug` is `number | null` (values `1` / `null`), not boolean.** A rule that
   checks `unplug === true` gets **zero** hits — proven: the tamper replay has one
   record with `unplug === 1` and none with `unplug === true`. Check `unplug === 1`
   (or truthy). Rule 4 fires on that transition and/or on `externalVoltageMv`
   collapsing to ~0 while previously on external supply.
2. **The `tamper` scenario cannot trip a 20% low-battery threshold.** Its battery
   drains only 100 → 68 across the 5 unplugged ticks (8%/tick), so `batteryPct`
   never falls below 68. To exercise rule 5 you need a longer unplugged phase
   (~11 ticks to reach ≤ 20%) or a test-time threshold/drain override — don't assume
   the current scenario already crosses the line.

Both rules stay parked in `test/pending/` under the same replay idiom as the other
rules until green; move the spec up and raise `DEFAULT_MIN_TESTS` in the same commit.
