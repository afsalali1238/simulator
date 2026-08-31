# Modules

The harness is split into nine modules so each one can be built, understood, and
**tested in isolation**. Seven are implemented in this thin slice (enough to carry
one record from a simulated device all the way to the API); two are *defined-only*
stubs that throw, because they must not be half-built — they need either a human
owner or live external credentials. This maps onto the functional areas in the GPS
PRD (`../context/requirements/`).

| # | Module | Folder | In this slice? | Test |
|---|--------|--------|----------------|------|
| 0 | Protocol (Codec 8/8E + CRC) | `src/protocol/` | ✅ yes | `test:crc`, `test:codec` |
| 1 | Ingestion (TCP endpoint) | `src/ingestion/` | ✅ yes | `test:ingestion` |
| 2 | Decode / normalise | `src/decode/` | ✅ yes | `test:decode` |
| 3 | Data model & tenancy (store) | `src/store/`, `db/` | ✅ yes | `test:store`, `test:tenancy` |
| 4 | Enrichment (state) | `src/enrichment/` | ✅ yes (minimal) | via `test:decode` |
| 5 | Utilisation ledger & evidence | `src/ledger/` | ⛔ defined-only | (contract in this doc) |
| 6 | Surfaces (read API) | `src/api/` | ✅ yes (read side) | `test:api` |
| 7 | Messaging (WhatsApp) | `src/messaging/` | ⛔ defined-only | (contract in this doc) |
| 8 | Rules & event detection | *(not yet scaffolded)* | ⛔ defined-only | (contract in this doc) |
| 9 | Simulator / device bench | `src/simulator/` | ✅ yes | `test:scenarios`, `test:replay` |

Also in the slice, added in P0 (operability, not product modules):

| Area | Folder | What |
|------|--------|------|
| Structured logging | `src/logging/` | One JSON/kv line per event; redacts secrets, never logs tenant payloads. `test:operability` |
| Lifecycle | `src/lifecycle/` | SIGINT/SIGTERM drain with a hard deadline, and the cross-platform `isEntrypoint()` guard. `test:operability` |
| Tooling | `src/tools/` | `demo`, `test:gate` (count/skip-proof merge gate), `verify` (real processes + signals), portable test enumeration |

Numbering starts at 0 for the protocol because it is a pure codec that every other
module depends on and has no I/O of its own.

---

## Module 0 — Protocol (`src/protocol/codec.js`)

The Teltonika wire format, as pure functions: `crc16`, `encodeImei`/`readImeiFrame`,
`encodeRecord`, `encodeAvlPacket`/`readAvlFrame`, `encodeAck`, for both Codec 8
(`0x08`) and Codec 8 Extended (`0x8E`). No sockets, no state — just bytes in, bytes
or objects out. `readAvlFrame` returns `null` for an incomplete buffer and **throws**
on a bad preamble or a CRC mismatch.

**How to test:** `npm run test:crc` checks the CRC against Teltonika's own
documented canonical packet (expected `0xC7CF`) and decodes it. `npm run test:codec`
round-trips synthetic records through both codecs and asserts the re-encode is
byte-identical. Full detail in `docs/PROTOCOL.md`.

## Module 1 — Ingestion (`src/ingestion/server.js`)

The TCP server a device connects to. Handles the IMEI handshake (accept `0x01` /
reject `0x00`), reframes the TCP byte stream into complete AVL packets, and — the
whole point — **ACKs a packet only after its records are durably written**. If the
write throws, it does not ACK and drops the connection; the device resends.

**How to test:** `npm run test:ingestion` drives it over a real loopback TCP socket
with the simulator: handshake accept/reject, Codec 8 *and* 8E, idempotent resend,
and the durability contract (with `FAIL_BEFORE_COMMIT` set, nothing is stored
and nothing is ACKed, then a reconnect recovers cleanly).

## Module 2 — Decode / normalise (`src/decode/normalize.js`, `src/decode/engine-hours.js`)

Turns one decoded AVL record into a canonical fact row. Pure function, so every
correctness rule it enforces is unit-testable with zero I/O: an absent IO becomes
`null` (never `0`), engine hours are produced only for CAN-supported assets and are
always tagged `source: 'ecu'`, and each record is attributed to whichever tenant
held the device **at that record's own timestamp**.

`engine-hours.js` is **decision D1**, resolved: which AVL ID carries engine hours,
in what unit, and which candidates must never be billed.

| AVL ID | What | Billable? |
|---|---|---|
| **102** Engine Worktime | The machine's own lifetime hour-meter, **in minutes** | ✅ the billing parameter |
| 103 Engine Worktime (counted) | Counted by the *tracker* from adapter installation | ⛔ refused — not reconcilable, resets on adapter swap |
| 449 Ignition On Counter | Accumulated ignition-on seconds | ⛔ forbidden (invariant 5) |
| 200 | `Sleep Mode` — the retired stand-in | ⛔ refused |

Two things this module exists to prevent, both silent: reading the **minutes** value
as seconds (a 60× billing error no invariant test would catch), and relabelling a
tracker-side accumulator as an ECU meter. It also owns `reconcile()`, which compares
a decoded value against the machine's physical hour-meter and *names* a unit error
rather than just failing — a reading that has not been reconciled is not evidence.

**How to test:** `npm run test:decode` and `npm run test:engine-hours`. Full
write-up: `../../D1_CAN_ENGINE_HOURS.md`.

## Module 3 — Data model & tenancy (`src/store/`, `db/`)

The storage port and its two adapters. `memory-store.js` runs in-process with zero
dependencies; `pg-store.js` is the same contract against PostgreSQL, where tenancy
is enforced by **row-level security** and evidence immutability by a **trigger**.
`db/schema.sql` and `db/seed.sql` define and seed the real database; `seed-data.js`
mirrors the seed exactly for the memory adapter.

**How to test:** `npm run test:store` (atomic/durable/idempotent writes, tenant-
scoped reads) and `npm run test:tenancy` (a device that changes hands mid-2025 →
correct tenant and correct engine-hours behaviour per timestamp). Re-run either
under `DB=pg` to exercise RLS and the trigger.

## Module 4 — Enrichment (`src/enrichment/state.js`)

Derives a coarse machine state (`off` / `idle` / `moving` / `unknown`) from
ignition, movement, and speed. Minimal on purpose — it is where trip segmentation,
geofence membership, and idle detection will grow.

**How to test:** exercised through `npm run test:decode`.

## Module 5 — Utilisation ledger & evidence (`src/ledger/`) — DEFINED-ONLY

Computes billable utilisation per asset per period from **ECU engine readings only**
(estimated values may inform a display but may never back an invoice), and seals each
period into an immutable, tamper-evident record able to produce a dispute pack.

Stubbed and throwing on purpose. Its failure mode is a silently wrong *billing*
number, so it must be built and reviewed by a human, not generated. Contract:
PRD `FR-LED-*` / `FR-EVID-*`.

## Module 6 — Surfaces / read API (`src/api/server.js`)

A tiny zero-framework HTTP API the dashboard calls instead of mock data:
`/health`, `/devices`, `/positions`, `/assets/:id/engine-hours`. Every data endpoint
requires an `X-Tenant-Id` header and is tenant-scoped by the store.

**How to test:** `npm run test:api`.

## Module 7 — Messaging / WhatsApp (`src/messaging/`) — DEFINED-ONLY

Turns telematics events into WhatsApp Cloud API messages on the same WhatsApp-native
spine the Marketplace uses. Out of the local slice because it needs live Meta
credentials and approved message templates. Contract: PRD `FR-MSG-*`.

## Module 8 — Rules & event detection — DEFINED-ONLY (not yet scaffolded)

Consumes enriched telemetry and raises the events messaging delivers: geofence
enter/exit, ignition outside working hours, idle-too-long, tamper/unplug, low
battery. Deferred until enrichment is richer; listed here so the shape is explicit.

## Module 9 — Simulator / device bench (`src/simulator/`)

Stands in for physical hardware, and doubles as the **test bench** everything
downstream replays against. Three files:

- `device.js` — a Teltonika unit as a TCP client: IMEI handshake, framed Codec
  8/8E packets, waits for the 4-byte ACK, `sendNoWait()` for the durability test.
  Because this is the genuine wire protocol, swapping it for a real unit needs no
  server change.
- `phases.js` — the behaviour **vocabulary**. A phase answers "what is the
  machine doing this tick?" and returns signals only: `off`, `startup`, `travel`,
  `work`, `idle`, `shutdown`, `unplugged`. Plus a seeded PRNG (mulberry32) and
  the track geometry helpers, so output is deterministic — no `Math.random`, no
  `Date.now`.
- `scenarios.js` — the **scenario registry**. Walks a phase plan into concrete
  AVL records: advances the GPS track, ticks the engine hour-meter, assembles the
  IO elements.

Named scenarios (`npm run sim:list` prints them with what each proves):

| Scenario | The story | Exercises |
|---|---|---|
| `day-cycle` (default) | A believable working day for D1 on Excavator X | hour-meter advances only while the engine runs |
| `handover` | **The important one.** D1 changes hands at `2025-06-01T00:00:00Z`: Excavator X / Tenant A → Generator Y / Tenant B, records on both sides | invariants **6** and **9** |
| `yard-idle` | The unassigned D2 in Kasper's yard | invariants **3**, **7**, **9** |
| `after-hours` | Ignition late in the evening | data for the P3 after-hours rule |
| `geofence-cross` | Leaves and re-enters the Jebel Ali site circle | data for the P3 geofence rule |
| `tamper` | Harness pulled: external voltage collapses, ignition becomes `null` | invariant **3** |
| `ecu-counted-only` | The CAN program exposes only AVL 103 (tracker-counted hours) | invariants **4**, **5** — it must be refused, not relabelled `ecu` |

Two properties the registry guarantees, because downstream tests depend on them:
**determinism** (same scenario + seed ⇒ byte-identical records) and **absence is
not zero** — a signal with no reading is `null` and its IO element is omitted
entirely, never sent as `0`.

`handover` deliberately keeps reporting AVL 102 *after* the handover: the device
really would carry its meter to the next machine, and the system must still
produce no engine data for a non-CAN asset. That is invariant 9's trap, baited.

`run-simulator.js` is the CLI: `--scenario <name>`, `--list`, `--interval`,
`--records`, `--seed`, `--codec`, `--stream` (the legacy indefinite soak stream).
All have `SIM_*` env equivalents in `.env.example`.

**How to test:** `npm run test:scenarios` (generated records, pure) and
`npm run test:replay` (the same scenarios driven through ingestion → store → API
over real TCP). Also exercised by `npm run test:ingestion` and `npm run demo`.

> The simulator emits the **real** parameters: AVL 102 (engine hours, converted to
> the minutes a real unit puts on the wire) and AVL 100 (the CAN program number).
> Emitting 102 claims only "a CAN adapter is fitted and reporting its hour-meter",
> never that the value is billable: whether it becomes engine data is decided by the
> *asset's* `hasEngineData` in Module 2, and whether it can back an invoice is
> Module 5's gate. The retired IO-200 stand-in is gone — see
> `../../D1_CAN_ENGINE_HOURS.md`.

