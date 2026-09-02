# Handoff → @integration-engineer — build out vehicle scenario coverage (Module 9)

**From:** simulator work session, 2026-09-02 (the `dic-to-reem` scenario + this
planning pass).
**Owner of this work:** `@integration-engineer` (Module 9 — Simulator, per
`AGENTS.md`).
**Blocks:** nothing downstream directly — every item here is simulator-side
only. It unblocks *future* P3 rules work (speeding, harsh-driving,
towing/unauthorized-movement rules all need a scenario to test against before
they can be written credibly) the same way `tamper` unblocked the
tamper/unplug rule.
**Companion doc:** `context/simulator/VEHICLE_SCENARIOS_PLAN.md` — full
gap analysis, AVL ID table, and the four-tier build order this handoff
follows.

---

## The ask, in one sentence

`dic-to-reem` proved D2 can be a real moving vehicle with one event type
(harsh braking); build out the rest of the vehicle behaviour set — harsh
accel/cornering, overspeed, towing, GNSS loss, buffered-offline bursts — in
the priority order the plan doc lays out, and stop before Tier 3 (crash /
fuel / jamming) until those get their own desk investigation.

## Why this is scoped the way it is

This session already did the highest-risk part: verifying AVL 253/254 (Green
Driving) against the official table and building the `harshEventType` /
`buildIo()` plumbing generically enough that accel and cornering are a
copy-paste of the braking pattern, not new engineering. What's left is mostly
composition (new phase plans using existing primitives) plus two genuinely
new phases (`towed`, and whatever GNSS-loss needs) — none of it touches
`src/decode/`, `src/rules/`, or any other module's files, so it stays inside
the Module 9 boundary `AGENTS.md` sets.

## Exact scope, tier by tier (detail in the plan doc)

1. **Tier 1 (do first):** harsh acceleration, harsh cornering, sustained
   overspeed. All reuse existing IO (253/254) or none at all.
2. **Tier 2:** a `towed` phase (`movement=true`, `ignition=false/null` — not
   the same failure mode as `tamper`, don't collapse the two into one
   phase); a GNSS-loss phase (`satellites`→0, `GNSS_STATUS` no-fix, while
   ignition/movement stay known).
3. **Tier 4 infrastructure, not a scenario:** a buffered-offline-burst
   scenario that actually sends multiple records in one packet through
   `run-simulator.js` — flagged in the plan doc as the biggest current
   fidelity gap ("acting exactly like a Teltonika device" is not fully true
   yet, because every scenario today sends one record per packet and a real
   unit bursts buffered records after a connectivity gap). Worth pulling
   forward even though it's listed after Tier 2 in the plan doc's numbered
   order, if you have to pick one thing to prioritize.
4. **Do NOT start Tier 3** (crash detection, fuel level, GPS jamming) without
   first writing the equivalent of `DATASHEET_CROSSCHECK.md` for whichever
   one you pick — cross-check the candidate AVL ID/structure against
   `context/teltonika/` or a fresh primary source before it goes in code.
   This is not optional process — `teltonika_telematics_briefing.docx`
   already got AVL 253 wrong once in this same project by skipping it.

## Acceptance criteria

Same bar `dic-to-reem` was held to, per scenario added:

- Deterministic (seeded PRNG only) and passes
  `scenarios: every registered scenario builds, is deterministic, and uses
  seeded IMEIs` in `test/scenarios.test.js` without modification.
- A dedicated assertion block in `test/scenarios.test.js` for anything
  scenario-specific (event fires once, IO values are correct, priority
  raised on the event record) — follow the `dic-to-reem` test as the
  template: it checks the event count, type, value threshold, the GPS speed
  either side of the event, and (for that scenario specifically) rough
  real-world start/end coordinates.
- `DEFAULT_MIN_TESTS` in `src/tools/test-gate.js` raised in the **same
  commit** as the new test(s) — verify locally with `npm test` before
  bumping it, the way this session's commit message documented "85 → 86,
  verified 86/86" rather than just asserting a number.
- Verify live at least once with a real ingestion server running (`npm run
  start:ingest` + `npm run sim -- --scenario <name>`), not just the unit
  test — that's what caught the stepMs-derived-deceleration bug in this
  session's own first draft of `brake` (deriving harshness from the 60s tick
  interval computed a physically tame ~0.5 m/s², not a harsh-braking value).

## Boundaries

- **Stay in `src/simulator/`, `src/config.js` (IO map only), and
  `test/scenarios.test.js`.** If a scenario needs a decoder change to be
  useful (e.g. GNSS-loss is only provable if `normalize.js` doesn't
  fabricate a position), that's a hand-off to `@protocol-engineer` — write
  it up the way `HERMES_HANDOFF_POWER_SIGNALS.md` did, don't reach into
  `src/decode/` yourself.
- **Don't build the rules that would consume these signals** (speeding,
  towing/unauthorized-movement, harsh-driving alerts) — that's Module 8,
  P3, a different owner's work, and it's already mid-flight with its own
  fix list (`HERMES_HANDOFF_RULES_FIXLIST_2026-09-01.md`). A scenario
  producing a signal is not permission to also write the rule.
- **Don't touch engine-hours or the power/tamper signals** — both settled,
  leave them alone.
- Keep every new phase pure and deterministic, same as `phases.js`'s
  existing rule: no `Math.random`, no `Date.now`.
