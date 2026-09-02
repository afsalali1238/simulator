# Datasheet cross-check vs the D1 resolution

**What this is:** a claim-by-claim check of the two official Teltonika datasheets
(filed alongside this file) against the D1 engine-hours resolution in
`../../D1_CAN_ENGINE_HOURS.md`. Primary sources, provided by afzl 2026-09-01:

- `Datasheet-FMC130.pdf` — the tracker (Teltonika, © 2022).
- `Datasheet-ALL-CAN300.pdf` — the CAN adapter (Teltonika, © 2019).

**Bottom line:** the datasheets **corroborate the hardware layer** the D1 mapping
assumes and surface **no contradiction**. They do **not**, by themselves, prove the
billing specifics — "engine hours = AVL 102, in minutes" still rests on the FMC130
*Data Sending Parameters ID* wiki + flespi + the FMC650 table (see D1 doc §7), because
a 2–4 page datasheet carries no AVL-ID table. One naming gap is confirmed and stays an
open question for Teltonika.

---

## 1. Claim-by-claim

| D1 claim (from code / D1 doc) | What the datasheets actually say | Verdict |
|---|---|---|
| FMC130 takes a CAN adapter | FMC130 **"CAN Adapter Inputs: 1"** | ✅ Confirmed |
| Adapters are LV-CAN200 / ALL-CAN300 / CAN-CONTROL (matches `ENGINE_HOURS_SOURCES[*].adapters`) | FMC130 **"Fuel monitoring: LLS (Analog), LV-CAN200, ALL-CAN300, CAN-CONTROL, OBDII dongle"** | ✅ Confirmed |
| ALL-CAN300 works with the FMC130 | ALL-CAN300 **"Supported by … FMC1YX …"** (FMC130 is FMC1YX) | ✅ Confirmed |
| The billing parameter is the machine's own lifetime meter | ALL-CAN300 intro: reads *"basic and additional 100 parameters … such as … **engine lifetime** …"* | ✅ Confirmed a lifetime-hours parameter exists (naming caveat below) |
| Available parameters vary per machine → per-machine program numbers, don't assume | ALL-CAN300 Features footnote: **"*Number of parameters depends on vehicle model, year and equipment."** | ✅ Confirmed the variance; reinforces the "confirm per program" rule |
| RPM is a real CAN signal (D1: AVL 85), not the billing meter | ALL-CAN300 lists **"Engine speed (RPM)"**; FMC130 ignition detection lists **"Engine RPM (CAN Adapters, OBDII dongle)"** | ✅ Confirmed RPM is reported (datasheet gives no AVL ID) |
| AVL 200 was wrongly used as an "engine-on" stand-in; on real firmware it's **Sleep Mode** → retired | FMC130 **"Sleep modes: GPS Sleep, Online Deep Sleep, Deep Sleep, Ultra Deep Sleep"** | ✅ Consistent — the device genuinely has sleep states, so a "Sleep Mode" AVL is plausible and is not an hour meter |
| Estimated fuel is a GNSS estimate, kept separate from ECU (inv 4) | FMC130 scenarios list **"GNSS Fuel Counter"**; ALL-CAN300 lists CAN **"Total fuel consumption / Fuel level (Dashboard)"** separately | ✅ Consistent — GNSS-estimated vs CAN-reported fuel are distinct sources |
| Codec 8/8E is the wire format | (Cross-doc) the DSM instructions note *"turn on codec 8E … required for the extra information of AVL IDs"* | ✅ Consistent |
| Readback tooling for the open hardware step exists | FMC130 config via **Teltonika Configurator (USB, Bluetooth), FOTA Web** | ✅ Confirms how AVL 102 gets read back on a real unit |

## 2. The one naming gap (open question, not a contradiction)

The ALL-CAN300 datasheet calls the parameter **"engine lifetime."** The FMC130
*Data Sending Parameters ID* wiki calls it **"Engine Worktime" (AVL 102)**. Same
concept, two names, across two Teltonika documents. The D1 doc already flags this and
treats the `"engine lifetime" ↔ AVL 102` mapping as **inferred**. These datasheets
reproduce the inconsistency rather than resolve it, so it stays open question for
Teltonika/the distributor:

> Confirm that the supported-vehicle list's *"engine lifetime"* is delivered on the
> wire as **AVL ID 102**, and that its unit is **minutes**.

Until they state that, the code's fail-safe behaviour is the right posture: bill only
AVL 102, refuse everything else, and mark a machine "verified" only after readback +
hour-meter reconciliation.

## 3. What the datasheets do NOT cover (so don't over-claim)

- **No AVL-ID table.** Neither datasheet lists parameter IDs. "AVL 102", "AVL 103
  counted", "AVL 449 ignition counter", "AVL 200 Sleep Mode" all come from the
  parameters-ID wiki, not from these PDFs.
- **No unit statement.** Neither says the lifetime parameter is in minutes. The
  **minutes** finding (and the latent 60× trap it fixed) rests on the parameters-ID
  wiki + flespi + the FMC650 table, per D1 doc §7. This is the single most
  billing-critical fact and it is **not** independently corroborated by these two
  files.
- **No per-machine program numbers.** Those are in the ALL-CAN300 *supported-vehicle
  list* (the 75-page PDF / xlsx), not this 2-page datasheet.

## 4. Contradictions found

None. Every datasheet statement is consistent with the D1 resolution and the code in
`../../telematics/src/decode/engine-hours.js`. The datasheets *strengthen* the case
that `teltonika_telematics_briefing.docx` is unreliable on parameters (it claims AVL
253 = engine hours and AVL 12 = RPM; the official table says 253 = Green driving type
and 12 = Fuel Used GPS) — treat that briefing as background only.

## 5. Note on the third uploaded file (not filed here)

The upload set also included **`397406_DSM_test_instructions`**, which is a different
product: Teltonika's **DSM driver-safety camera** (drowsiness / distraction / phone /
smoking / seatbelt detection, NTSC/PAL video) wired to an **FMX640** over RS232/RS485.
Its AVL references are camera error codes and event masks, not CAN engine parameters,
and it targets a different device family than the FMC130. It is **out of scope** for
utilisation billing and was deliberately **not** filed into `teltonika/`. If driver
cameras become a real direction for the logistics/movement side, scope it separately.

---

**See also:** `../../D1_CAN_ENGINE_HOURS.md` (the resolution),
`../invariants/Dozr_GPS_CLAUDE.md` (invariants 4/5/9 the mapping protects),
`../../telematics/src/decode/engine-hours.js` (the code).
