# FMC130 fidelity plan (Module 9 — Simulator)

Status: **§3's permanent I/O elements are now shipped for D1 (see §2b). The
event/feature work in §4 is still planning only.** Written
in response to the ask "make sure this simulator does everything as an
FMC130," using the FMC130 datasheet (uploaded, Teltonika, copyright 2022) and
the `wiki.teltonika-gps.com` FMC130-specific pages as primary sources. Follows
the same verify-before-code discipline as `D1_CAN_ENGINE_HOURS.md` and the
AVL-254 correction in `VEHICLE_SCENARIOS_PLAN.md`: every ID below is either
**confirmed** (checked against an FMC130-specific or AVL-ID-reference primary
source this session) or **needs verification** (a named gap, not a guess).

---

## 1. What "FMC130" already means in this codebase

D1 (IMEI `356307042441013`) is already labelled FMC130 in `scenarios.js` — the
excavator/generator device with a CAN adapter, which is exactly the FMC130's
documented "CAN Adapter Inputs: 1" hardware. D2 (`FMC920`) is a different,
simpler model and is correctly *not* in scope for this doc — it never claimed
to be an FMC130 and has no CAN adapter (`emitEngine: false` everywhere).

So "make the simulator do everything as an FMC130" means: make D1's data
stream a complete, accurate FMC130 emulation — not just the CAN
engine-hours slice that D1_CAN_ENGINE_HOURS.md already resolved.

---

## 2. Confirmed correct today (no change needed)

| AVL ID | Name | Confirmed against |
|---|---|---|
| 239 | Ignition | FMC130 permanent I/O table (this session) |
| 240 | Movement | FMC130 permanent I/O table |
| 69 | GNSS Status | FMC130 permanent I/O table |
| 100 | CAN Program Number | D1_CAN_ENGINE_HOURS.md |
| 102 | Engine Worktime (min) | D1_CAN_ENGINE_HOURS.md |
| 103 | Engine Worktime, counted (min) | D1_CAN_ENGINE_HOURS.md |
| 66 | External Voltage | HERMES_HANDOFF_POWER_SIGNALS.md |
| 113 | Battery Level (%) | **re-confirmed this session** — FMB_battery wiki page: "Value: 100 means battery level is 100%," 1 byte, 0-100, "%" — matches this repo's existing implementation exactly |
| 252 | Unplug Detected | HERMES_HANDOFF_POWER_SIGNALS.md |
| 449 | Ignition-on counter (s) | already present, correctly never used as billing evidence |
| 253 | Green Driving Type | re-confirmed this session against the FMC130 permanent table |
| 254 | Green Driving Value (g×100) | re-confirmed this session — see VEHICLE_SCENARIOS_PLAN.md's correction note |
| 200 | *(retired stand-in, not emitted)* | this repo's own comment already correctly identifies 200 as real Sleep Mode on FMC130 firmware — no conflict, nothing to fix |

---

## 2b. Shipped this session — permanent I/O elements, D1 only

Every ID in §3's table below is now emitted on every D1 record except the two
explicitly not implemented (next paragraph) — `buildIo()`/`materializeTrack()`
in `scenarios.js`, gated on `track.imei === D1` so D2 (FMC920) is untouched.
Test: `test/scenarios.test.js` — "D1 (FMC130) carries the new permanent I/O
elements on every record; D2 does not."

Deliberately still NOT implemented, with reasons (not gaps — decisions):
- **AVL 12/13 (Fuel Used/Rate GPS)** — GPS-speed-based fuel estimation has no
  physical basis for D1, which is heavy machinery (an excavator/generator),
  not a road vehicle. Its real fuel/engine data source is the CAN adapter.
  Fabricating a GPS-fuel figure for it would be exactly the invented-signal
  mistake invariant 3 exists to prevent.
- **AVL 10 (SD Status)** — the FMC130 datasheet's own Interface table lists no
  SD card slot (128MB internal flash only, per page 3 of the datasheet).
  This ID is on the generic cross-model wiki table but does not apply to this
  specific SKU.

**Lesson learned while implementing (same class as the AVL-254 bug):** Axis
X/Y/Z (17/18/19) are documented as SIGNED, -8000..8000 mG — but this
codebase's `encodeRecord()` writes every IO element through a raw unsigned
`Buffer.writeUIntBE`, and passing it a negative value crashed the full test
suite (`RangeError: value out of range... Received -17`, first surfaced by
`npm test`, not by the new unit test — the existing `operability.test.js`
integration test happened to hit a negative jitter value first). Fixed by
two's-complementing negative axis values into the unsigned 16-bit range
before pushing them into the IO array (`u16()` helper in `buildIo()`), the
same thing a real device's own encoder does — the sign is a decoding
convention, not a wire-format one. Covered by a dedicated round-trip test
so a future signed field doesn't reintroduce this silently.

---

## 3. Confirmed gaps — permanent I/O elements FMC130 sends that this
## simulator never emits

Straight from the FMC130 permanent I/O elements table (`wiki.teltonika-gps.com/view/FMC130_Teltonika_Data_Sending_Parameters_ID`,
fetched this session):

| AVL ID | Name | Bytes | Notes |
|---|---|---|---|
| 80 | Data Mode | 1 | network/service mode |
| 21 | GSM Signal | 1 | 0-5 signal strength |
| 181 | GNSS PDOP | 2 | ×0.1 |
| 182 | GNSS HDOP | 2 | ×0.1 |
| 24 | Speed | 2 | km/h — separate from the GPS element's own speed field; real devices send both |
| 205 | GSM Cell ID | 2 | |
| 206 | GSM Area Code | 2 | |
| 67 | Battery Voltage | 2 | ×0.001 V — distinct from AVL 113 (%), currently unimplemented |
| 68 | Battery Current | 2 | ×0.001 A |
| 241 | Active GSM Operator | 4 | |
| 199 | Trip Odometer | 4 | metres |
| 16 | Total Odometer | 4 | metres |
| 1 | Digital Input 1 | 1 | FMC130 has 3 DIN total (DIN1 negative-input-capable, DIN1/DIN2 impulse-capable) |
| 2 | Digital Input 2 | 1 | |
| 9 | Analog Input 1 | 2 | FMC130 has 2 AIN total |
| 179 | Digital Output 1 | 1 | FMC130 has 3 DOUT total |
| 12 | Fuel Used GPS | 4 | ×0.001 l |
| 13 | Fuel Rate GPS | 2 | ×0.01 l/100km |
| 17/18/19 | Axis X/Y/Z | 2 each | mG — FMC130's accelerometer, feeds Green Driving, crash, towing |
| 11 | ICCID1 | 8 | SIM identifier |
| 10 | SD Status | 1 | FMC130 has no SD slot per the datasheet's Interface table — **flag for verification**, this ID may not actually apply to this model despite appearing in the generic table |
| 200 | Sleep Mode | 1 | genuinely unimplemented (see §2 — not a bug, just not built) |

Digital I/O 2 and 3, and Analog Input 2, follow the same IDs as other
FMB-series devices per Teltonika's numbering convention but were not directly
confirmed on the FMC130 page this session — **needs verification** before
implementing DIN3/DOUT2/DOUT3/AIN2.

---

## 4. Confirmed gaps — event/feature I/O elements

The datasheet's own "Scenarios" row lists: Green Driving (done), Over
Speeding detection, GNSS Fuel Counter, DOUT Control Via Call, Excessive
Idling detection, Immobilizer, iButton Read Notification, Unplug detection
(done), Towing detection, Crash detection, Auto Geofence, Manual Geofence,
Trip, Jamming detection (SLM320-E/LA modules only).

Confirmed this session:

| AVL ID | Name | Size | Values | Source |
|---|---|---|---|---|
| 318 | GNSS Jamming | — | 0 no jamming / 1 warning / 2 critical | `FMC130_Features_settings` wiki page |
| 255 | Over Speeding | — | event record on threshold+3% breach | `FMC130_Features_settings` wiki page |
| 78 | iButton ID | 8 | SIM/iButton identifier | AVL ID reference table |

**Needs verification before any code** (same rule as Tier 3 in
VEHICLE_SCENARIOS_PLAN.md — do not hardcode from memory or an LLM-summarized
fetch, confirm the exact ID/structure against the primary wiki table first):

- Crash Detection — Teltonika documents this as a bundled structure (event
  flag + accelerometer trace), not a single scalar; the FMC130 Features page
  did not surface its ID this session.
- Towing Detection — not found this session; likely reuses the accelerometer
  axis data (17/18/19) plus a dedicated status ID, needs confirming.
- Excessive Idling — the FMC130 Features page only describes this indirectly
  via SECO/fuel-consumption-on-idling; the actual event AVL ID wasn't
  surfaced.
- Trip (start/end event) — not confirmed this session.
- GNSS Fuel Counter — not confirmed this session; likely distinct from AVL
  12/13 (Fuel Used/Rate GPS, which are simpler consumption estimates).
- Auto Geofence / Manual Geofence event IDs — not confirmed this session
  (note: this repo's existing `geofence-cross` scenario proves geofence
  *behaviour* against a site boundary computed in test code, not against a
  device-native geofence AVL event ID — those are two different things).
- Immobilizer status — not confirmed this session.
- DOUT Control Via Call — this is an inbound feature (network calls the
  device to trigger a DOUT), not something the simulator would ever need to
  emit; likely out of scope for a device *simulator* regardless.

---

## 5. Codec / protocol-level fidelity (separate from IO content)

Everything already implemented in `codec.js` matches Codec 8 / Codec 8
Extended exactly (re-confirmed against the wiki's Codec page this session:
preamble/length/codec-ID/record-count/CRC-16-IBM/IMEI-handshake all correct).
One real gap, already flagged in `VEHICLE_SCENARIOS_PLAN.md` §4 Tier 4 and
unchanged by this research: every scenario sends exactly one AVL record per
TCP packet; a real FMC130 buffers and bursts multiple records after a
connectivity gap. Not new to this doc, just restating it's still open.

Codec 16 is out of scope — Teltonika's own page says it's supported "from
firmware 00.03.xx and newer (FMB630/FM63XY)," not documented for FMC130.

---

## 6. What this doc is asking

This is a large amount of surface area — full permanent-IO parity (§3),
several event features each needing their own primary-source cross-check
before implementation (§4), and the standing multi-record-packet gap (§5).
Building all of it is a multi-session effort, not one commit. The next step
is picking a build order, the same way VEHICLE_SCENARIOS_PLAN.md §5 did for
the vehicle scenarios.

---

## 7. Sources

- `DatasheetFMC130_1_1.pdf` — official Teltonika FMC130 datasheet (uploaded
  this session; module/GNSS/cellular/power/interface/features tables read
  directly, pages 1-4).
- `wiki.teltonika-gps.com/view/FMC130_Teltonika_Data_Sending_Parameters_ID` —
  FMC130 permanent I/O elements table (fetched this session; truncated before
  the Eventual I/O elements section — needs a follow-up fetch/manual check).
- `wiki.teltonika-gps.com/view/FMC130_Features_settings` — Jamming (AVL 318),
  Over Speeding (AVL 255), Immobilizer behaviour description.
- `wiki.teltonika-gps.com/view/FMB_battery` — AVL 113 Battery Level
  confirmation.
- `wiki.teltonika-gps.com/view/Full_AVL_ID_List_(Mobility)` — AVL 113 and 78
  cross-reference (generic table, used only to corroborate FMC130-specific
  pages, per this repo's existing rule that a generic table alone is not
  sufficient — see VEHICLE_SCENARIOS_PLAN.md's lesson on this exact point).
- `wiki.teltonika-gps.com/view/Codec` — Codec 8 / 8E / 16 structure
  re-confirmation.
- `VEHICLE_SCENARIOS_PLAN.md`, `D1_CAN_ENGINE_HOURS.md`,
  `context/teltonika/DATASHEET_CROSSCHECK.md` — the process this doc follows.
