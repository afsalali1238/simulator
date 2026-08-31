# D1 — CAN engine-hours mapping

**Owner:** `protocol-engineer` · **Status: RESOLVED at the parameter level; per-machine rows drafted; hardware verification outstanding.**

D1 was the open decision blocking real billing data: *which CAN parameter, in which
unit, on which machine* carries true engine hours. The parameter-level answer is now
in the code and enforced by tests. What remains is physical: install an adapter,
read the value back, reconcile it against the machine's own hour-meter.

---

## 1. The answer

| | |
|---|---|
| **Billing parameter** | **AVL ID 102 — "Engine Worktime"** |
| **Native unit** | **MINUTES** (4-byte unsigned) |
| **Conversion** | `seconds = minutes × 60` |
| **What it is** | The **machine's own lifetime hour-meter**, read off the CAN bus |
| **Adapters** | LV-CAN200, ALL-CAN300, CAN-CONTROL |
| **Program number** | reported live as **AVL ID 100** |

And the parameter that must **not** be billed:

| | |
|---|---|
| **AVL ID 103 — "Engine Worktime (counted)"** | Also minutes, also 4 bytes, also from CAN. But **counted by the tracker from zero** starting when the adapter was installed. |

Source: Teltonika's own FMC130 parameter table, retrieved 2026-08-31 from
`wiki.teltonika-gps.com/view/FMC130_Teltonika_Data_Sending_Parameters_ID`. Verbatim
rows:

```
102  Engine Worktime             4  Unsigned  0  1677215  -  min  Engine work time
                                                   Devices: LVCAN200, ALLCAN300, CANCONTROL
103  Engine Worktime (counted)   4  Unsigned  0  1677215  -  min  Total engine work time
                                                   Devices: ALLCAN300, CANCONTROL
100  Program Number              4  Unsigned  0  99999    -   -   Value: Min – 0, Max – 99999
```

---

## 2. Three findings that change what the code does

### 2.1 The previous stand-in was pointed at Sleep Mode

The harness carried engine hours on **IO 200** as "engine-on seconds". On real
Teltonika firmware **AVL 200 is `Sleep Mode`** (1 byte, permanent I/O, range 0–4).
Shipping that mapping would have read a sleep-state enum as an hour-meter.

The stand-in is removed. AVL 200 is now named `RETIRED_ENGINE_HOURS_STANDIN_ID` and
the decoder **refuses** it — a record carrying IO 200 on a fully CAN-supported asset
now produces no engine data, and a test asserts exactly that. Previously the same
record yielded 2.0 billable hours.

### 2.2 The unit is minutes, and the old code assumed seconds

The decoder did `hours = seconds / 3600` on the raw value. The real parameter is in
**minutes**. Left alone, every billed figure would have been wrong **by 60×** — and
**every existing invariant test would still have passed**, because the pipeline is
unit-agnostic. Nothing in the repo was watching the unit.

Conversion now happens in exactly one audited place
(`src/decode/engine-hours.js`), and each engine row carries `sourceAvlId` and
`nativeUnit` so a dispute pack can state which parameter and unit produced a number
instead of asking someone to trust it.

Visible effect: `npm run demo` now reports **1.0000 h** for the seeded session
instead of 1.0056 h. That is the fix, not a regression — the old figure was a
seconds value billed as if the parameter were seconds.

### 2.3 102 vs 103 is a billing-evidence distinction, not a preference

Both are "engine hours from CAN", both in minutes, both plausible. But 103 is a
**tracker-side accumulator**: it starts at zero at adapter installation, it cannot be
reconciled against the dashboard hour-meter, and it resets if the adapter is swapped.
Billing from it is the same class of error as billing an ignition counter — which
invariant 5 forbids by name.

So the decoder consumes **102 only**. If a machine's program exposes only 103, the
honest outcome is **no engine data for that machine** until it is fixed. It is not
relabelled `source: 'ecu'`. There is a scenario (`ecu-counted-only`) and a test for
this, because "we found a number that looked right" is precisely how a wrong invoice
happens.

> **A trap in our own internal briefing.** `context/teltonika/teltonika_telematics_briefing.docx`
> offers engine-hours tracking as *"CAN AVL ID 253 **or ignition state accumulation
> in TSDB**"*. Both halves are wrong: **AVL 253 is `Green driving type`** (1 byte,
> eventual I/O, values 1–3) on the official table, and ignition accumulation is
> forbidden as billing evidence by invariant 5. The briefing's ID table is
> illustrative and demonstrably unreliable — it also claims ID 12 is Engine RPM,
> where the official table says **ID 12 is `Fuel Used GPS`** (a GNSS estimate) and
> **ID 85 is Engine RPM**. Treat that document as background, not as a parameter
> reference.

Also mapped so nobody rediscovers it as a shortcut: **AVL 449 `Ignition On Counter`**
(4 bytes, **seconds**) is real, tempting, and explicitly refused
(`FORBIDDEN_AS_BILLING_EVIDENCE`).

---

## 3. Per-machine program numbers

Program numbers come from the official ALL-CAN300 supported-vehicle list. The
construction-machinery section was parsed by coordinate (the PDF is a rotated
tick-matrix, so plain text extraction misaligns the columns — the parse resolves each
`+` mark's x-position against its rotated column header).

**All 247 construction-machinery entries expose `Engine lifetime`** — the list's name
for the parameter surfaced as AVL 102. (Across the whole 75-page list, 1883 of 1916
non-construction rows carry it too.) That is the single most useful finding for the
pilot: engine hours are not the scarce signal on heavy plant. What varies per machine
is the **program number**, not whether the parameter exists.

Excavators relevant to the Dozr fleet:

| Make | Model | Year from | Program № | Engine lifetime |
|---|---|---|---|---|
| CAT | 320D | 2006⇒ | **1261** | ✅ |
| CAT | 320D L | 2006⇒ | 1261 | ✅ |
| CAT | 320E | 2011⇒ | 1364 | ✅ |
| CAT | 323D L | 2007⇒ | 1261 | ✅ |
| CAT | 336D L | 2008⇒ | 1261 | ✅ |
| CAT | 313F L GC | 2015⇒ | 1788 | ✅ |
| CAT | 315D | 2007⇒ | 1272 | ✅ |
| CAT | 315C | 2003⇒ | 1237 **or** 1368 | ✅ (two programs listed — must be confirmed per unit) |
| CAT | 336E LH | 2013⇒ | 1364 | ✅ |
| CAT | 323E | 2011⇒ | 1364 | ✅ |
| CAT | M318D (wheeled) | 2007⇒ | 1284 | ✅ |
| KOMATSU | PC210LC-8 | 2006⇒ | **1438** | ✅ |
| KOMATSU | PC240LC-8 | 2006⇒ | 1438 | ✅ |
| KOMATSU | PC300-8 | 2008⇒ | 1438 | ✅ |
| KOMATSU | PC400-7 | 2007⇒ | 1558 | ✅ |
| JCB | JS160 NLC | 2012⇒ | **1612** | ✅ |
| JCB | JS200 LC / NLC | 2012⇒ | 1612 | ✅ |
| JCB | 3CX / 4CX ECO | 2010⇒ | 1254 | ✅ |
| HITACHI | ZX 270LC-3 | 2007⇒ | **1326** | ✅ |
| HITACHI | ZX 180LCN-5 | 2013⇒ | 1954 | ✅ |
| HYUNDAI | R 250LC-7A | 2007⇒ | 1379 | ✅ |
| DOOSAN | DX 300 LCA | 2013⇒ | 1731 | ✅ |
| VOLVO | A25F/A30F (hauler) | 2011⇒ | 1248 | ✅ |

Loaders, graders, rollers, bulldozers, telehandlers and backhoes are in the same
section and all carry the parameter too; the full list is in the source xlsx.

⚠ **Two caveats on these numbers.**

1. **Program-number digit count changed.** Per the ALL-CAN300 wiki: adapters
   manufactured **from 2018-01-01** use **5-digit** program numbers formed by
   prefixing `1` to the old 4-digit number (`1882 → 11882`). The list above is the
   4-digit era. A newly purchased adapter will want **`11261`**, not `1261`. Confirm
   against the adapter's own manufacture date.
2. **No CAT 320 (plain) row exists** — the list has 320D / 320D L / 320E. Our seed
   fixture's "CAT 320, 2021" is test data, and 2021 is beyond every year range in the
   parsed list. The real fleet's exact models and years have to be matched
   individually; do not assume 1261 for a machine nobody has checked.

---

## 4. What the code now does

`src/decode/engine-hours.js` — the whole mapping, in one file:

```js
ENGINE_HOURS_SOURCES        // 102 (billable) and 103 (not), with units + why
FORBIDDEN_AS_BILLING_EVIDENCE  // 449 ignition counter, 200 sleep mode
toCanonicalSeconds(id, raw) // minutes → seconds, refuses non-billable IDs
selectEngineHours(io)       // picks 102; returns null rather than guessing
explainNoEngineHours(io)    // why there is no reading, for logs/disputes
reconcile(ecuHours, dashboardHours)  // the step that makes it evidence
```

`reconcile()` does not just pass/fail. When a reading is off by ~60× it says
`verdict: 'unit-error'` and names the likely cause; a non-factor discrepancy comes
back as `'mismatch'` with "do not bill from this". A wrong parameter or wrong program
number looks like a mismatch, not like a rounding problem.

The decoder contract is unchanged, as `BUILD_PLAN.md` P2 requires: engine readings
are still produced only for `hasEngineData` assets (invariant 9) and are still always
`source: 'ecu'` (invariant 4). Two fields were **added** to the engine row —
`sourceAvlId` and `nativeUnit` — so a billed figure can be traced to its parameter.

The simulator emits the real IDs: AVL 102 in minutes, AVL 100 for the program number,
and a new **`ecu-counted-only`** scenario that emits only AVL 103 to prove it is
refused.

---

## 5. Tests

`npm run test:engine-hours` — 14 tests. The suite exists because every D1 failure
mode is silent:

- the retired AVL 200 stand-in produces **no** engine hours
- AVL 102 is minutes: `90 → 5400 s / 1.5 h`, `1440 → 24 h`, exact arithmetic
- AVL 103 is refused, not relabelled; when both are present, 102 wins
- AVL 449 (ignition counter) is refused as billing evidence
- invariant 9 still gates everything; absent ≠ zero
- reconciliation catches and **names** a 60× unit error, and a 3600× one
- a non-factor mismatch is reported as a mismatch, not guessed at

Plus, in the wider suite: `scenarios` now asserts the wire value is ~60 minutes (not
~3600) on a track starting at one hour — that assertion would catch a re-introduced
unit error — and `ecu-counted-only` is driven through the decoder.

**Whole suite: 83/83 pass** (was 68). `npm run demo` still shows ACK 20 / 5 / 0-new.

---

## 6. What is still open — and it needs hardware, not code

D1 is resolved at the parameter level. A machine type is **verified** only when:

1. an FMC130 + adapter is installed on one machine **per brand** (auto-electrician;
   the expert review flags install as the real bottleneck, not software),
2. the live value is read back via Configurator/Traccar, confirming **AVL 102 is
   present and in minutes** for that program,
3. `reconcile()` agrees with the machine's **physical dashboard hour-meter** within
   tolerance.

Until step 3 passes for a machine type, its row stays unverified and the ledger stays
human-reviewed. A number that has not been reconciled is a reading, not evidence.

**Questions for Teltonika / the distributor**, now much narrower than before:

1. Confirm **FMC130 + ALL-CAN300** for our asset mix (their own doc invited this).
2. For each machine in the real fleet — exact make/model/**year** — the program
   number, and whether it is 4- or 5-digit for the adapters we are buying.
3. Confirm that "Engine lifetime" in the supported-vehicle list is the parameter
   delivered as **AVL 102** (the naming differs between the two documents; the
   mapping is inferred and should be stated by them, not by us).
4. Should the ledger bill from **lifetime** hours (delta across a period) or a
   session/trip counter? This changes how P2 computes a period. Lifetime + delta is
   the reconcilable option and what the code currently assumes.

**Blocked on us, not them:** the real fleet list. Every row in §3 is a candidate
until someone names the machines Dozr will actually deploy on.

---

## 7. Sources

- **FMC130 Data Sending Parameters ID** — `wiki.teltonika-gps.com/view/FMC130_Teltonika_Data_Sending_Parameters_ID` (retrieved 2026-08-31). The authoritative ID → name → bytes → unit table. 630 parameter rows parsed; 310 are CAN-adapter rows.
- **CAN adapter supported vehicles** — `wiki.teltonika-gps.com/view/CAN_adapter_supported_vehicles` → ALL-CAN300 list.
- **ALL-CAN300 product page** — `wiki.teltonika-gps.com/view/ALL-CAN300`, for the program-number digit-count change (2018-01-01).
- **ALL-CAN300 supported-vehicle PDF** — 75 pages, 2163 machine rows. Construction machinery (247 rows) on pp. 61–68. Parsed by word coordinate: the tick matrix is a grid of `+` marks under **rotated** column headers, so text extraction misaligns the columns entirely. Each mark's x-position is resolved against its header's x (offset ~1.8pt, matched within 4pt); the parse decodes every mark on every construction row with none left unattributed, and a light-vehicle page was used as a control.
- Cross-checks against `flespi.com/devices/teltonika-fmc130` (independent parameter catalogue) and the FMC650 table, which labels the same parameter *"Engine work time in minutes"* — corroborating the unit.
- **Contradicted by the above:** `context/teltonika/teltonika_telematics_briefing.docx` (ID 253, ID 12, ignition accumulation). Historical context only.
- Invariants: `context/invariants/Dozr_GPS_CLAUDE.md` (3, 4, 5, 9; hour-meter reconciliation).
