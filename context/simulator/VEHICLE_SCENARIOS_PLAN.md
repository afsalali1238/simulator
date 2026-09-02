# Vehicle scenario coverage plan (Module 9 — Simulator)

Status: **planning only — nothing in this doc is built yet, except §2 which is
already shipped.** Written after `dic-to-reem` (D2's Dubai Internet City → Al
Reem Island drive with a harsh-braking event) landed, as the map of what a
real vehicle-mounted Teltonika unit generates that the simulator does not yet
produce. Companion to `HERMES_HANDOFF_VEHICLE_SCENARIOS_2026-09-02.md` (repo
root), which turns this into a claimable task list.

---

## 1. Why this doc exists, and what it is not

Every scenario built so far models **D1, heavy machinery** (an excavator/
generator with a CAN adapter) or **D2 sitting still** (`yard-idle`). Only
`dic-to-reem` puts D2 on the road as a moving **vehicle** — and it proves
exactly one behaviour (a harsh-braking event on a long highway drive). A real
fleet vehicle generates a much wider behaviour set: speeding, harsh
acceleration and cornering, being towed with the ignition off, losing GNSS
fix in a tunnel or parking structure, dropping off the network mid-drive and
bursting buffered records on reconnect. None of that exists yet.

This is **not** a request for new AVL IDs speculatively invented to sound
plausible — the D1 investigation exists precisely because that failure mode
already happened once in this project (`context/README.md`, the
`teltonika/` table entry for `teltonika_telematics_briefing.docx`: it
claims AVL 253 = engine hours; the official table says 253 = Green driving
type). Every ID below is marked
**verified** (already implemented and checked against a primary source) or
**needs verification** (a plausible candidate that must be checked against
`context/teltonika/` — or a fresh Teltonika source — before it goes in code,
the same way D1 was resolved before `ENGINE_WORKTIME_MIN` was hardcoded).

---

## 2. What's built today (shipped, not part of this plan)

| Scenario | Device | Proves |
|---|---|---|
| `day-cycle` | D1 (machinery) | engine hours accrue only while running; state transitions |
| `after-hours` | D1 | ignition outside working hours is visible in the stream |
| `handover` | D1 | attribution by timestamp (inv. 6); non-CAN asset yields no engine data (inv. 9) |
| `yard-idle` | D2 (stationary) | unassigned → owner tenant (inv. 7); no CAN → no engine IO (inv. 3, 9) |
| `geofence-cross` | D1 | a track that leaves and re-enters a named site circle |
| `ecu-counted-only` | D1 | AVL 103 (tracker-counted) is refused as billing evidence (inv. 4, 5) |
| `tamper` | D1 | a power-cut is `null`, never `false` (inv. 3); the pattern rule 4 fires on |
| `dic-to-reem` | D2 (vehicle) | a real multi-leg highway drive; one harsh-braking event (AVL 253/254), consistent with the GPS speed either side of it |

All eight are deterministic (seeded PRNG), registered in `SCENARIOS`
(`src/simulator/scenarios.js`), and covered by `test/scenarios.test.js`.

---

## 3. AVL IDs already verified and in use

| AVL ID | Name | Size | Status |
|---|---|---|---|
| 239 | Ignition | 1B | verified — Teltonika standard, in every scenario |
| 240 | Movement | 1B | verified — Teltonika standard |
| 69 | GNSS Status | 1B | verified — Teltonika standard (1 = fix) |
| 100 | CAN program number | 4B | verified — D1 (`D1_CAN_ENGINE_HOURS.md`) |
| 102 | Engine Worktime (minutes) | 4B | verified — D1, the billing parameter |
| 103 | Engine Worktime, tracker-counted (minutes) | 4B | verified — D1, refused as billing evidence |
| 66 | External Voltage (mV) | 2B | verified — `HERMES_HANDOFF_POWER_SIGNALS.md` |
| 113 | Battery Level (%) | 1B | verified — `HERMES_HANDOFF_POWER_SIGNALS.md` |
| 252 | Unplug Detected | 1B | verified — `HERMES_HANDOFF_POWER_SIGNALS.md` |
| 253 | Green Driving Type (1 accel / 2 brake / 3 corner) | 1B | verified — corroborated by the same official-table cross-check that caught the briefing doc's error on this exact ID |
| 254 | Green Driving Value (g × 100, e.g. 75 = 0.75g) | 1B | verified — see correction note below |
| 200 | *(Sleep Mode — retired stand-in)* | — | explicitly refused, not a real signal in this harness |
| 449 | Ignition-on counter (seconds) | 4B | verified — present, never used as billing evidence (inv. 5) |

> **Correction, 2026-09-02 (same day):** the version of this table shipped
> alongside `dic-to-reem` marked AVL 254 "verified" on the strength of only
> confirming AVL 253's ID against `context/README.md`'s note — 254's byte
> width and unit were never actually checked against a primary source, and
> the implementation shipped with both wrong (2 bytes, deci-m/s² instead of
> 1 byte, g×100). Caught on a follow-up deep review and fixed against two
> independent primary sources: `wiki.teltonika-gps.com`'s "Green Driving
> Solution" page and the FTC921 parameter table (both agree: 1 byte, 0.01
> multiplier, "g*100"). The lesson generalizes: "verified" in this table
> must mean the specific field checked, not the ID as a whole — 253's ID
> being right said nothing about 254's encoding.

---

## 4. Gap analysis, by how ready each item is to build

### Tier 1 — quick wins, the IO plumbing already exists

`buildIo()`'s `harshEventTypeId`/`harshEventValue` path and the
`GREEN_DRIVING_TYPE_ID` map (`accel`/`brake`/`corner`) were built generically
for `dic-to-reem`'s braking event — accel and corner are already wired to the
same AVL 253/254 pair, unused only because no scenario has fired them yet.

- **Harsh acceleration** — pulling away hard from a stop or a light. New
  `brake`-sibling phase (or a `harshEventType: 'accel'` option on an existing
  phase), same one-shot-event contract, no new AVL research.
- **Harsh cornering** — same pattern, `harshEventType: 'corner'`, paired with
  a sharper `headingDelta` at the same tick so the turn is visible in the GPS
  track, not just asserted in the IO.
- **Sustained overspeed** — no new IO at all. A `travel` phase with
  `speedKmh` well above a plausible posted limit for several ticks. This is
  scenario composition, not new engineering.

### Tier 2 — one new phase, but the AVL IDs are ones already trusted

- **Towing / unauthorized movement.** `movement=true` while `ignition` is
  `false`/`null` — meaningfully different from `tamper` (that's a power
  cut with no ignition reading at all; this is "the engine is definitively
  off and the vehicle is moving anyway"). Needs a new phase (`towed`) but
  reuses IO 239/240 exactly as documented — no new AVL IDs.
- **GNSS loss** (tunnel, underground parking, urban canyon). `satellites`
  drops toward 0 and `GNSS_STATUS` (AVL 69) reports no-fix while `ignition`/
  `movement` stay known — the inverse of `tamper`'s failure mode (there it's
  the vehicle bus that goes dark; here it's the antenna). The point of this
  scenario is checking the decoder doesn't fabricate or freeze a position
  when there's no fix (invariant 3 again, different signal). No new AVL IDs.

### Tier 3 — needs a desk investigation first, same rigor as D1

Do **not** hardcode these IDs from memory or a secondary source. Cross-check
against `context/teltonika/` (the two official datasheets plus
`Kasper_Teltonika_Technical_Pack.pdf`) or request a fresh primary source, the
same process `D1_CAN_ENGINE_HOURS.md` and `DATASHEET_CROSSCHECK.md` used, and
write the equivalent short cross-check doc before implementing.

| Candidate scenario | What it needs | Why it's Tier 3, not Tier 2 |
|---|---|---|
| Crash detection | The accelerometer axis/crash-event AVL group | Teltonika documents this as a bundled data structure (event flag + trace data), not a single scalar like Green Driving — needs the actual layout confirmed, not assumed |
| Fuel level / consumption | OBD-II PIDs, not CAN-adapter IO | D2 has no CAN adapter (established across every scenario); a fuel scenario implies a *different* data source (an OBD-II dongle) — a scoping question before an ID question |
| GPS jamming / spoofing | The jamming-alarm IO | Security-relevant; a wrong ID here would be worse than no scenario at all |

### Tier 4 — infrastructure gaps, not scenarios themselves

- **Multi-record packets.** Every scenario today sends exactly one record
  per TCP packet (`dev.send([record])` in `run-simulator.js`'s
  `replayTrack`). A real unit buffers locally and sends **several** buffered
  records in a single packet after any connectivity gap — `encodeAvlPacket`
  and the decoder already support N records per packet (the legacy demo
  exercises 20-in-a-batch), but the *scenario engine* has never driven that
  path. A **buffered-offline-burst** scenario (device stops transmitting for
  several ticks while still "recording", then sends 5-10 records in one
  packet on reconnect) would close this gap and is high-value precisely
  because nothing currently tests it end-to-end through named scenarios.
- **Loop-forever mode for a named scenario.** `--stream` only replays the
  legacy flat generator forever; a named scenario (e.g. `dic-to-reem`) sends
  its fixed record count once and disconnects. Useful for a live-dashboard
  demo that should just keep a vehicle driving around Dubai indefinitely.
- **Concurrent multi-vehicle scenarios.** The engine already supports
  multiple tracks per scenario (`handover` uses two) — a fleet scenario with
  2-3 vehicles on different routes at once is a scenario-definition exercise
  with the existing engine, not new plumbing.

---

## 5. Recommended build order

1. Harsh acceleration + harsh cornering (Tier 1) — cheapest, extends the
   pattern `dic-to-reem` already proved out.
2. Sustained overspeed (Tier 1) — no new IO, immediate value for a future
   speeding rule.
3. Towing / unauthorized movement (Tier 2) — security-relevant, known IDs.
4. GNSS loss (Tier 2) — protects invariant 3 against a real, specific failure
   mode (position fabrication) that nothing currently tests.
5. Buffered-offline-burst (Tier 4) — closes the multi-record-packet gap;
   arguably should move earlier since it's the biggest "acting exactly like
   a Teltonika device" fidelity hole found so far.
6. Loop-forever mode (Tier 4) — infra convenience, do whenever a live demo
   needs it.
7. Crash / fuel / jamming (Tier 3) — blocked on a desk investigation each,
   do not schedule until that investigation is written up.

---

## 6. What is still open

- Tier 3's three candidates each need their own short cross-check doc before
  any code — do not skip this step even under time pressure; it is exactly
  the step `teltonika_telematics_briefing.docx` skipped, and it produced a
  wrong AVL ID that made it into a reference document.
- Fuel level specifically raises a scoping question above the AVL-ID
  question: does D2 (or a future vehicle device) actually carry an OBD-II
  dongle, or is fuel out of scope for the vehicle profile entirely? Needs a
  decision, not just research.
- None of this changes `src/decode/normalize.js` or the P3 rules engine —
  every item here is simulator-side (Module 9) only, same as `dic-to-reem`.
  A scenario producing a signal is not the same as a rule consuming it; see
  `HERMES_HANDOFF_POWER_SIGNALS.md` for how that hand-off worked for the
  power/tamper signals.

---

## 7. Sources

- `context/teltonika/Datasheet-FMC130.pdf`, `Datasheet-ALL-CAN300.pdf` —
  official Teltonika datasheets (already in this repo).
- `context/teltonika/Kasper_Teltonika_Technical_Pack.pdf` — the deeper
  protocol reference.
- `context/README.md`, `teltonika/` table — the note that
  `teltonika_telematics_briefing.docx` is wrong on AVL 253 and proposes an
  invariant-5-violating billing method; treat as background narrative only.
- `D1_CAN_ENGINE_HOURS.md`, `context/teltonika/DATASHEET_CROSSCHECK.md` —
  the process this plan's Tier 3 items should follow.
- `HERMES_HANDOFF_POWER_SIGNALS.md` — the most recent precedent for adding a
  new signal group (external voltage/battery/unplug) end to end.
