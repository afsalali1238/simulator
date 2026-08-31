# Architecture

How the Kasper GPS/telematics system is put together: the modules, how data flows
through them, the data model, the correctness invariants that shape every design
choice, and the target production topology on AWS.

This document describes the **whole system**. The `telematics/` slice already
implements the load-bearing parts of it (marked ✅ below); the rest is specified
here and scheduled in `BUILD_PLAN.md`.

---

## 1. The system in one picture

```
   ┌──────────────┐   Teltonika Codec 8/8E over TCP    ┌───────────────────┐
   │ GPS device   │  (IMEI handshake → AVL packets →   │  Ingestion server │
   │ on machine   │───────────  ← 4-byte ACK) ────────▶│   (Module 1)      │
   │ (FMC130/920) │                                     └─────────┬─────────┘
   └──────────────┘                                               │ raw frame + decoded records
          ▲                                                       ▼
          │ (real hardware drops in here                ┌───────────────────┐
          │  with no server change)                     │ Decode / normalise│
   ┌──────────────┐                                     │   (Module 2)      │
   │  Simulator   │ ── stands in for the device today   └─────────┬─────────┘
   │  (Module 9)  │                                               │ canonical facts
   └──────────────┘                                               ▼
                                                        ┌───────────────────┐
                                                        │  Enrichment       │
                                                        │   (Module 4)      │
                                                        └─────────┬─────────┘
                                                                  ▼
   ┌───────────────────────────────────────────────────────────────────────┐
   │  Store (Module 3) — one interface, two adapters (memory | Postgres)     │
   │  positions · engine_readings · raw_frames (sealed) · devices/assets/…   │
   │  tenancy = row-level security · evidence = immutability trigger         │
   └───────┬───────────────────────────────┬───────────────────────┬────────┘
           │                                │                       │
           ▼                                ▼                       ▼
   ┌───────────────┐              ┌───────────────────┐   ┌───────────────────┐
   │ Read API      │              │ Utilisation ledger│   │ Rules & events    │
   │ (Module 6) ✅ │              │ + evidence (M5) ⛔ │   │   (Module 8) ⛔    │
   └──────┬────────┘              └─────────┬─────────┘   └─────────┬─────────┘
          │ tenant-scoped JSON              │ sealed invoice basis  │ events
          ▼                                 ▼                       ▼
   ┌───────────────┐                                      ┌───────────────────┐
   │ Dashboards    │                                      │ Messaging /       │
   │ (Vendor OS,   │                                      │ WhatsApp (M7) ⛔  │
   │  Marketplace) │                                      └───────────────────┘
   └───────────────┘
```

✅ = implemented and tested in `telematics/`  ⛔ = specified, deliberately not yet built

---

## 2. The nine modules

Numbering starts at 0 because the protocol is a pure codec every other module
depends on. Each module is built to be **independently testable**. Full per-module
detail and test commands are in `telematics/docs/MODULES.md`.

| # | Module | Folder | Status | Responsibility |
|---|--------|--------|--------|----------------|
| 0 | **Protocol** | `src/protocol/` | ✅ done | Teltonika Codec 8/8E wire format as pure functions: CRC-16/IBM, IMEI handshake, AVL record encode/decode, ACK. No I/O. |
| 1 | **Ingestion** | `src/ingestion/` | ✅ done | The TCP server a device dials into. Handshake, reframe the byte stream into packets, **ACK only after a durable write**, drop-and-let-resend on failure. |
| 2 | **Decode / normalise** | `src/decode/` | ✅ done | One decoded AVL record → one canonical fact row. Enforces NULL≠zero, ecu-only engine hours, and attribution at the record's own timestamp. Pure function. |
| 3 | **Store & tenancy** | `src/store/`, `db/` | ✅ done | One storage interface, two adapters (memory, Postgres). Idempotent writes, tenant-scoped reads, sealed raw frames. RLS + triggers in Postgres. |
| 4 | **Enrichment** | `src/enrichment/` | ✅ minimal | Derives coarse machine state (off/idle/moving/unknown) from ignition, movement, speed. Where trips, geofence membership, idle detection will grow. |
| 5 | **Utilisation ledger & evidence** | `src/ledger/` | ⛔ defined-only | Billable utilisation per asset per period from **ECU readings only**; seals each period into a tamper-evident record that can produce a dispute pack. |
| 6 | **Read API (surfaces)** | `src/api/` | ✅ done | Zero-framework HTTP API dashboards call instead of mock data. Every data endpoint requires `X-Tenant-Id` and is tenant-scoped. |
| 7 | **Messaging (WhatsApp)** | `src/messaging/` | ⛔ defined-only | Turns events into WhatsApp Cloud API messages on the same WhatsApp-native spine the Marketplace uses. Needs live Meta creds + approved templates. |
| 8 | **Rules & event detection** | *(not scaffolded)* | ⛔ specified | Consumes enriched telemetry, raises events: geofence enter/exit, after-hours ignition, idle-too-long, tamper/unplug, low battery. |
| 9 | **Simulator / device bench** | `src/simulator/` | ✅ done | Stands in for physical hardware — speaks the genuine protocol, so a real unit swaps in with no server change. Since P0 it is a **scenario engine**: `phases.js` (behaviour vocabulary + seeded PRNG) plus a registry of named, deterministic scenarios (`handover`, `yard-idle`, `day-cycle`, `after-hours`, `geofence-cross`, `tamper`). |

Plus the P0 operability layer — not product modules, but the reason this slice is
safe to run unattended: `src/logging/` (structured, secret-redacting logs),
`src/lifecycle/` (SIGINT/SIGTERM drains bounded by a deadline), `src/tools/` (the
demo, the merge gate, and `verify-runtime.js`).

### Why 5 and 7 are deliberately *not* built

They are stubs that **throw** if called. This is intentional, not incomplete work:

- **Ledger (5)** — its failure mode is a *silently wrong invoice*. A human must own
  and review the billing math; it must not be generated speculatively and wired in.
- **Messaging (7)** — needs live Meta/WhatsApp credentials and Meta-approved message
  templates that don't exist yet. Building it now would be untestable guesswork.

Leaving them as throwing stubs means nobody can accidentally depend on half-built
behaviour. See `BUILD_PLAN.md` for when they get built for real.

---

## 3. Data flow, step by step

1. **Connect + identify.** The device (or simulator) opens a TCP connection and
   sends its IMEI. The ingestion server accepts (`0x01`) only IMEIs in the device
   registry; unknown IMEIs are rejected (`0x00`) and the socket is closed.
2. **Stream packets.** The device sends AVL packets (Codec 8 or 8E). TCP is a byte
   stream, so the server buffers and reframes into complete packets, validating the
   preamble and CRC. A bad frame → drop the connection, do **not** ACK.
3. **Decode.** Each record is decoded into GPS + IO values. An **absent** IO is
   `null`, never `0` (invariant 3).
4. **Attribute.** For each record, resolve *which assignment was in force at that
   record's own timestamp* (invariant 6) — that yields the tenant and asset. If no
   assignment covers that moment, the record is scoped to the device's **owner**
   tenant with position + ignition only (invariants 7, 9).
5. **Normalise.** Engine hours are produced **only** for CAN-supported assets and
   are always tagged `source: 'ecu'` (invariants 4, 9). Everything becomes canonical
   fact rows.
6. **Persist durably + idempotently.** The store writes the raw frame (sealed),
   positions, and engine readings in one atomic unit. A resent packet does not
   double-count (invariant 2). Writes are unique on `(device, ts)` for positions and
   `(asset, ts, source)` for engine readings.
7. **ACK.** *Only now* — after the durable write — does the server send the 4-byte
   ACK of accepted record count (invariant 1). A missed ACK is safe: the device
   resends and idempotency absorbs it.
8. **Serve.** The read API returns tenant-scoped data. Later, the ledger reads sealed
   ECU readings to compute billable utilisation, and the rules engine raises events
   that messaging delivers.

---

## 4. Data model

The canonical tables (Postgres names; the memory adapter mirrors them exactly). Full
DDL with constraints, RLS policies, and triggers is in `telematics/db/schema.sql`.

| Table | Holds | Key correctness property |
|-------|-------|---------------------------|
| `tenants` | The owner (Kasper) and each contractor customer | Root of all tenancy scoping |
| `devices` | Physical Teltonika units, by IMEI + model | Each has an `owner_tenant_id` |
| `assets` | Machines (excavator, generator, …) incl. `program_number` | `has_engine_data` gates engine hours (invariant 9) |
| `assignments` | Which device is on which asset, for which tenant, **over a time range** (`valid_from` / `valid_to`) | The source of time-based attribution (invariant 6) |
| `positions` | GPS fixes + ignition/movement/state | Unique `(device_id, ts)` → idempotent (invariant 2); tenant-scoped read (invariant 7) |
| `engine_readings` | Engine-hours readings | `source` column ('ecu'); unique `(asset_id, ts, source)`; only for CAN assets (invariants 4, 5, 9) |
| `raw_frames` | The exact bytes received, per packet | **Append-only** — an immutability trigger blocks UPDATE/DELETE in Postgres (invariant 8) |

### The reference scenario (seeded in both adapters)

The seed data is built to exercise the invariants, not to look tidy:

- **Device D1** (FMC130, IMEI `356307042441013`) **changes hands mid-2025**:
  Jan–Jun 2025 it's on **Excavator X** (CAT 320, CAN-supported) billed to **Tenant A
  (Al Naboodah)**; from Jun 2025 it's on **Generator Y** (no CAN program) billed to
  **Tenant B (Dutco)**. So the *same device's* records split between two tenants by
  timestamp, and engine hours must stop once it's on the generator.
- **Device D2** (FMC920, IMEI `356307042441099`) is **unassigned**, sitting in Kasper's
  yard → position + ignition only, scoped to the owner tenant.

This is exactly what `npm run demo` walks through, and what the simulator's
`handover` and `yard-idle` scenarios replay over real TCP (`npm run sim:list`).

The **handover instant `2025-06-01T00:00:00Z`** is the single most important moment
in the test bench: it is where invariant 6 stops being a claim and becomes a
measurement. `test:replay` sends one device's records either side of it and asserts
that each tenant's API can see only its own side. The device deliberately keeps
reporting its engine counter *after* the handover — as real hardware would — so
invariant 9 has to actively suppress engine data for a machine with no CAN program
rather than merely never being asked.

---

## 5. The nine correctness invariants

These are the reason the code is shaped the way it is. They are enforced by tests
(see `TESTING.md` for the invariant→test map) and mirrored in `CLAUDE.md` and
`context/invariants/Dozr_GPS_CLAUDE.md`. **Do not design around them or "simplify"
past them.**

1. **ACK only after a durable write.** No ACK until records are committed.
2. **Idempotent ingest.** A resent packet never double-counts.
3. **NULL ≠ zero.** An absent IO is `null`, never `0`.
4. **ecu vs estimated never merge.** CAN-derived engine hours are always
   `source: 'ecu'`; estimates are produced elsewhere and never mixed in.
5. **Ignition counters are never billing evidence.** Only sealed ECU engine readings
   back an invoice.
6. **Attribution at each record's own timestamp** — never "as of now".
7. **Tenancy always.** Every read is tenant-scoped (app-level in memory, RLS in pg).
8. **Sealed, immutable evidence chain.** Raw frames are append-only; they are the
   root of any dispute pack.
9. **Unlisted machine ⇒ position + ignition only.** No CAN program ⇒ no engine hours.

---

## 6. Real vs. simulated, and the one open decision (D1)

**Production-accurate today:** TCP framing, IMEI handshake, Codec 8/8E record layout,
CRC-16/IBM, the 4-byte ACK, and IO IDs 239 (ignition), 240 (movement), 69 (GNSS).

**Simulated placeholder — decision D1:** total **engine hours**. Real engine hours
arrive over the vehicle **CAN bus**, and the IO ID that carries them depends on the
FMC model + CAN adapter **program** for that exact make/model/year of machine. The
harness carries a stand-in "engine-on seconds" counter under IO ID 200 so simulator
and decoder agree. **D1 is the critical path to real billing data** (per the expert
review). When it's resolved, the dev team maps the real per-program IO ID(s); the
decoder's contract (engine hours only for CAN assets, always `source: 'ecu'`) does
**not** change. Detail: `telematics/docs/PROTOCOL.md`.

---

## 7. Stack

| Layer | Choice | Notes |
|-------|--------|-------|
| Runtime | **Node.js ≥ 20** (built on 22), ESM | No build step, no transpile. Uses `node:net`, `node:http`, `node:test`, `process.loadEnvFile`. |
| Ingestion | Hand-written Codec 8/8E parser over `node:net` TCP | Reference implementation + test harness. **Traccar** stays the recommended off-the-shelf option for the real-device pilot (expert review); this parser proves ACK-after-durable-write directly. |
| Store | Ports-and-adapters: memory (default) \| **PostgreSQL** | `pg` imported only on the pg path, so memory mode needs zero install. |
| Tenancy | Postgres **row-level security** | App-level enforcement in the memory adapter mirrors it. |
| Evidence | Postgres **immutability trigger** on `raw_frames` | Blocks UPDATE/DELETE. |
| API | Zero-framework `node:http` | Small on purpose; swap for a framework at scale if wanted. |
| Dependencies | **`pg` only** | Deliberately minimal for a clean handoff. |

The stack matches the rest of Kasper (Vanilla + Supabase/Postgres + Vercel lineage):
lowest risk, fastest to ship, no build-step friction.

---

## 8. Target production topology (AWS)

The slice is shaped so this is a deployment exercise, not a rewrite. Nothing below
changes the module boundaries or the invariants.

```
        GPS devices (mobile network)
                 │  Codec 8/8E over TCP
                 ▼
        Network Load Balancer (TCP)         ← devices can reconnect to any instance;
                 │                            ACK-after-durable-write + idempotency
                 ▼                            make that safe
        Ingestion service  ×N
        (ECS/Fargate, the Node server)
                 │
                 ▼
        Amazon RDS for PostgreSQL           ← swap base image for TimescaleDB and add a
        (positions / engine_readings /        hypertable migration for time-series scale;
         raw_frames, RLS + triggers)          the store interface does NOT change
                 │
        ┌────────┼─────────────┐
        ▼        ▼             ▼
   Read API   Ledger +     Rules → Messaging
  (ECS/      evidence      (events → WhatsApp
   Fargate)  (scheduled)    Cloud API)
        │
        ▼
   Dashboards (Vendor OS / Marketplace)
```

Hand-off specifics (also in `telematics/README.md`):

- **Storage:** implement nothing new — `src/store/pg-store.js` already mirrors the
  memory adapter against Postgres. Point `DATABASE_URL` at RDS.
- **Ingestion at scale:** front the Node server with a TCP NLB and run N instances.
- **Time-series scale:** swap the Postgres image for TimescaleDB (noted inline in
  `docker-compose.yml`) and add a hypertable migration. Interface unchanged.
- **Ledger:** a human owns it; run it as a scheduled job over sealed ECU readings.
- **The blocker for real data:** D1. Until it's decided, engine hours are simulated.

---

## 9. Where the detail lives

- **Byte-level protocol:** `telematics/docs/PROTOCOL.md`
- **Per-module detail + test commands:** `telematics/docs/MODULES.md`
- **The invariants, canonical:** `context/invariants/Dozr_GPS_CLAUDE.md`
- **The build handbook (engineering north star):** `context/architecture/Dozr_GPS_Build_Handbook.html`
- **Deepest architecture reference:** `context/architecture/Kasper_GPS_Architecture.html`
- **The plan and gates:** `BUILD_PLAN.md` · **the tests:** `TESTING.md`
