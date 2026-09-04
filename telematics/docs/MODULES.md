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

**Handshake rate limiting (P0 hardening, `src/ingestion/handshake-limiter.js`).**
The IMEI handshake is the only gate on this port, and an IMEI is not a secret —
without a limit, a source can try IMEIs against it indefinitely. After
`HANDSHAKE_MAX_FAILURES` failed (unknown-IMEI) handshakes from one source IP
within `HANDSHAKE_WINDOW_MS`, that IP is refused outright — no reject byte, the
connection is closed before the handshake is even read — for
`HANDSHAKE_BLOCK_MS`. It blocks the *source*, not the IMEI it tried: switching
to a different (even valid) IMEI from a blocked IP does not buy more attempts.
A successful handshake clears the source's record, so a device that mistyped
its own IMEI a few times is never punished for it. Defaults: 5 / 60s / 5min
(`.env.example`). Pure and dependency-free, tested in isolation with a fake
clock (`npm run test:handshake-limiter`) and over a real TCP socket
(`npm run test:ingestion-rate-limit`).

This throttles the worst of an open port; it is not device authentication. A
public deployment should still pair it with TLS or a pre-shared token per
device before going live — see the gap list in `BUILD_PLAN.md`.

**Concurrency / load test (`src/tools/load-test.js`).** A capacity harness, not a correctness check — deliberately outside `npm run test:gate` (see the file's header). It spins up synthetic devices (reserved `900...` IMEI range) and drives them over real TCP against either an embedded in-memory server or an external one (`--host`/`--port`), ramping connections in over a configurable window (or all at once with `--ramp-ms 0`), then reports connect/ACK latency percentiles, peak RSS, and event-loop lag against pass/fail thresholds. Run with `npm run loadtest` (or `npm run loadtest -- --connections 500 --records 10`). Measured on this project's dev machine, embedded/memory-store mode: 300 connections ramped over 3s and 1000 connections in a single burst both passed cleanly with zero connect/send errors (1000-burst: connect p95 ≈ 1.1s, ACK p95 ≈ 7ms, peak RSS ≈ 85MB) — the harness itself is proven by `npm run test:load-test-smoke`, a tiny deterministic suite that runs in the gate's spirit without pinning a performance number to CI.

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

## Module 5 — Utilisation ledger & evidence (`src/ledger/index.js`) — BUILT (not yet wired to invoicing)

Computes billable utilisation per asset per period from **ECU engine readings only**
(estimated values may inform a display but may never back an invoice), and seals each
period into an immutable, tamper-evident record able to produce a dispute pack.
Contract: PRD `FR-LED-*` / `FR-EVID-*`.

Built 2026-09-02 by the ledger owner's explicit sign-off — the human CLAUDE.md's
guardrail requires, not speculative generation. `computeUtilisation(readings,
{ assetId, tenantId, periodStartMs, periodEndMs })` sums positive deltas between
consecutive ECU (AVL 102) readings, scoped to the given asset/tenant/period; a
meter decrease is a `meter-reset` anomaly (adapter/ECU swap), never negative
usage; a non-`'ecu'` reading is excluded and recorded as `non-ecu-excluded`,
never blended in; no ECU evidence at all means `billable: false` with the
figures `null` — never a zero that looks like real evidence.
`sealUtilisationRecord(utilisation, rawFrames)` produces a deterministic,
tamper-evident SHA-256 manifest hash over the figure and the exact evidence
bytes it derives from.

**What is still open before a number here can back a real invoice** (both
tracked in `TASKS.md` Phase P2, neither is a code problem):
- the **D1 hardware half** — a real installed adapter's AVL 102 reading
  reconciled against the machine's own physical hour-meter, per confirmed
  program number, per exact make/model/year;
- **human review of the billing math against real fleet data** — this module
  is proven correct against its spec and the seed `handover` scenario, which is
  a different bar than reviewed-and-signed-off on real numbers.

**How to test:** `npm run test:ledger` (8 tests, moved up from
`test/pending/ledger.test.js`) — the sum-of-positive-deltas rule with an exact
figure, the seed `handover` scenario's exact utilisation for Tenant A, a meter
reset never billed as negative, estimated readings excluded (and a period with
only estimated evidence is not billable at all), no-ECU-evidence is not
billable with null (not zero) figures, and the evidence seal's determinism +
tamper sensitivity. Included in `npm run test:gate`'s floor.

## Module 6 — Surfaces / read API (`src/api/server.js`)

A tiny zero-framework HTTP API the dashboard calls instead of mock data:
`/health`, `/devices`, `/positions`, `/assets/:id/engine-hours`. Every data endpoint
requires an `X-Tenant-Id` header and is tenant-scoped by the store.

**How to test:** `npm run test:api`.

## Module 7 — Messaging / WhatsApp (`src/messaging/`) — PLUMBING BUILT, SEND CREDENTIAL-GATED

Turns telematics events into WhatsApp Cloud API messages on the same WhatsApp-native
spine the Marketplace uses (PRD `FR-MSG-*`). Split into two pieces:

- **`dispatch.js` — BUILT.** `deliverEvents(events, { sender, deliveredLog })` is the
  real delivery/dedupe layer: maps each rule event type to a (placeholder, not yet
  Meta-approved) template name, dedupes on the rule engine's own `eventId`
  (invariant 2), scopes every send to that event's own `tenantId` (invariant 7), and
  isolates one failed send from sinking the whole batch (a failure is not marked
  delivered, so it stays retryable). `sender` is a required argument with no
  default — this file cannot send anything by itself.
- **`index.js`'s `notify()` — still DEFINED-ONLY, throws.** This is where the real
  WhatsApp Cloud API call goes once there are live Meta credentials and approved
  templates. `dispatch.js` was built so plugging that in later is a matter of
  writing `sender` and passing it in — no rework of the dedupe/tenancy/mapping
  logic above it.

**How to test:** `npm run test:messaging` (9 tests) — template mapping, no-sender
guard (nothing sends without one), idempotent redelivery, within-batch dedupe,
tenant isolation, partial-failure isolation, unmapped-event reporting. Every test
injects its own mock sender; nothing here calls a real API. Included in
`npm run test:gate`'s floor.

### A second billing basis: ignition-on duration (`src/ledger/ignition-duration.js`)

Not every asset can ever produce an ECU reading — a fleet running FMC130 with NO
CAN adapter (LV-CAN200 / ALL-CAN300 / CAN-CONTROL) architecturally cannot expose
AVL 102, on any vehicle, regardless of engine type (see
`D1_CAN_ENGINE_HOURS.md` §1). For that fleet (first case: a Mercedes-Benz Actros
tractor + flatbed trailer, tracker on the Actros only, added 2026-09-02), the
human-approved billing basis is **ignition-on duration** instead of engine
hours — a deliberately different, honestly-labeled figure, not a workaround for
missing ECU data.

`computeIgnitionOnDuration(records, { assetId, tenantId, periodStartMs,
periodEndMs })` sums the observed intervals where the prior reading's ignition
was `true`; an unknown (`null`) reading excludes that interval and is flagged,
never read as on or off (invariant 3); no readings in scope is not billable
(null figures, never zero); a single reading is genuinely billable at 0 seconds
(real evidence, just nothing to compare it to yet). Returns `source: 'ignition'`
— **never** `'ecu'` — so this can never be confused with, or presented as, the
ECU ledger above. Reuses `sealUtilisationRecord` (schema-agnostic) for the same
tamper-evident manifest hash.

**How to test:** `npm run test:ignition-duration` (9 tests, all hand-computed
figures). Included in `npm run test:gate`'s floor.

## Module 8 — Rules & event detection (`src/rules/detectEvents.js`) — BUILT

Consumes canonical (normalized) records in timestamp order and raises the events
messaging will deliver: `geofence-enter`/`geofence-exit`, `after-hours-ignition`,
`idle-too-long`, `tamper-unplug`, `low-battery`. Pure function
`detectEvents(records, { assetId?, tenantId?, config? })` — no I/O, no clock reads
(after-hours math is done on the record's own `tsMs`, not ambient time). Each event
carries a deterministic `eventId` (`sha256(tenantId, assetId, type, windowKey)`) so
downstream delivery can dedupe (invariant 2). Tamper and low-battery are
episode-based with hysteresis on recovery, so a repeat incident gets its own event
instead of being swallowed by a stuck "still active" flag. Invariant 3 is enforced
throughout: a `null` unplug/voltage/battery reading is absence, never treated as a
bad reading.

**How to test:** `npm run test:rules` (12 tests) — geofence enter/exit, after-hours
positive + a daytime negative case, idle-too-long at a real 60-minute default,
dedupe determinism (including no-collision across multiple transitions), and both
tamper/low-battery episode + re-arm + invariant-3-null cases. Included in
`npm run test:gate`'s floor.

Wired to Module 7's delivery plumbing (`src/messaging/dispatch.js`) — see above.
The only thing still blocked on Module 7 needing live Meta credentials is the
actual send call itself, per `CLAUDE.md`.

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

