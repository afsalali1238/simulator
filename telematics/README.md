# Kasper Telematics — local simulation + ingestion harness

A self-contained harness that emits and receives **real Teltonika Codec 8 / 8E
binary over TCP** — the exact wire protocol an FMC130/FMC920 speaks — decodes it
into tenant-attributed telemetry, stores it, and serves it over a small HTTP API.

We don't have a physical Teltonika unit yet, so `src/simulator/` *is* the device:
it performs the IMEI handshake, frames records with a correct CRC, waits for the
server's ACK, and resends on a miss — byte-for-byte what real hardware does. When
a real unit arrives, you point it at the same ingestion port and change nothing
on the server.

Everything lives in this **one folder** by design, so it can be zipped and handed
to the development team to wire into AWS (RDS, ECS/Fargate, IoT/NLB) later.

---

## Quick start (zero setup — nothing to install)

Requires only **Node.js ≥ 20** (built and verified on 22). No Docker, no Postgres,
no `npm install`. The default store is an in-process memory adapter.

```bash
npm run demo    # simulator → ingestion → store → API, end-to-end, with a proof summary
npm test        # the full suite (185 tests in memory mode)
npm run verify  # spawn the servers for real, replay a scenario, SIGTERM them
```

`npm run demo` streams two work sessions from one device that changes hands
mid-2025 and then queries the API as each tenant, so you can see attribution and
isolation happen on real data.

Day-to-day operating procedures — replaying a specific scenario, reading the
structured logs, what each `/health` state means, restarting without dropping
data, troubleshooting — are in **`docs/RUNBOOKS.md`**.

---

## The two run modes

The system talks to storage through one interface (`src/store/index.js`) with two
interchangeable adapters. Pick with the `DB` environment variable.

| Mode | `DB` | Needs | What it proves |
|------|------|-------|----------------|
| **Memory** (default) | `memory` | nothing | The whole pipeline + invariants, at the application layer. This is what runs in a bare sandbox. |
| **Postgres** | `pg` | Docker + `npm install pg` | The same pipeline with the invariants enforced **in the database** — row-level security for tenancy, triggers for evidence immutability, unique keys for idempotency. |

The memory adapter faithfully models what Postgres enforces, so tests pass in both
modes. Postgres mode is where you confirm the schema itself is correct — and it has
been: `DB=pg npm test` is **91/91**, with `test:rls` and `test:immutability` proving
that RLS and the immutability trigger, not application code, do the enforcing. Both
were checked by dropping the policy/trigger and confirming the suites fail.

---

## Running the pieces individually

```bash
# terminal 1 — the ingestion server (the "cell tower" the devices dial into)
npm run start:ingest

# terminal 2 — the read API for the dashboard
npm run start:api

# terminal 3 — one or more simulated Teltonika units
npm run sim
SIM_DEVICES=2 SIM_CODEC=8 npm run sim     # two units, older Codec 8
```

Copy `.env.example` to `.env` to change ports, device count, send interval, or codec.

---

## The scenario engine

The simulator is the **test bench** the ledger, the rules engine, and soak tests
all replay against, so it models named stories rather than one flat session:

```bash
npm run sim:list                          # every scenario + what it proves
npm run sim -- --scenario handover        # THE one: D1 changes hands mid-2025
npm run sim -- --scenario yard-idle       # the unassigned D2 in the yard
npm run sim -- --scenario tamper          # harness pulled mid-shift
npm run sim -- --scenario day-cycle --interval 0
npm run sim -- --stream --devices 2       # legacy indefinite soak stream
```

Also `after-hours` and `geofence-cross`. Every scenario is **deterministic** (seeded
PRNG — same scenario + seed gives byte-identical records) and honest about absence:
a signal with no reading is omitted from the packet, never sent as `0`.

`handover` is the important one. It replays one physical device either side of
`2025-06-01T00:00:00Z` — Excavator X / Tenant A before, Generator Y / Tenant B
after — and **keeps reporting its engine counter across the boundary**, because a
real unit would. The system must still produce no engine data for Generator Y. That
is invariants 6 and 9, proven end-to-end rather than asserted.

Full detail: `docs/MODULES.md` § Module 9.

---

## One named device to hand out (e.g. to interns, or a third-party parser)

`npm run sim:actros` streams a single, FIXED, memorable unit — the Mercedes-Benz
Actros flatbed haulage tractor referenced in `TASKS.md` Phase P2 (FMC130, no CAN
adapter, billed on ignition-on duration, never engine hours). Same IMEI every
time:

```
IMEI  : 356307045000006   (Luhn-valid, FMC130 TAC)
Codec : 8E
```

Run it with nothing else running and it spins its own throwaway server, prints
the connection details, and streams a believable shift (zero setup):

```bash
npm run sim:actros
```

Or point it at any OTHER real Teltonika-protocol receiver — including a real
**Traccar** instance, to prove interop with something outside this repo — by
setting where it connects:

```bash
SIM_SERVER_HOST=127.0.0.1 SIM_SERVER_PORT=5027 npm run sim:actros
```

Register the IMEI above as a device in Traccar FIRST (Settings → Devices → Add,
Identifier = the IMEI — Traccar auto-detects the Teltonika protocol from the
handshake), or Traccar will just ignore the unknown unit, the same way our own
device registry would reject an unprovisioned one (try it against
`npm run start:ingest` without registering it first — you'll see exactly that
rejection, which is itself worth seeing).

Also `npm run sim:fleet` — a batch of DISTINCT, Luhn-valid IMEIs, each onboarded
into the registry and streamed end-to-end over real TCP (`--count`, `--records`,
`--pg` for the Postgres multi-process topology).

---

## Testing

```bash
npm test                 # everything, run serially (185 tests in memory mode; re-verify DB=pg count, last checked 91 before Module 8/7/5 landed)
npm run test:gate        # THE MERGE GATE: also fails on a dropped count or any skip
npm run verify           # real processes, real SIGTERM, /health probes

# or one module at a time — each module is independently testable:
npm run test:crc         # CRC-16/IBM against Teltonika's documented canonical packet
npm run test:codec       # Codec 8 & 8E encode/decode round-trips, byte-identical
npm run test:store       # atomic/durable/idempotent writes, tenant-scoped reads
npm run test:decode      # NULL≠zero, ecu-only engine hours, attribution (pure functions)
npm run test:tenancy     # a device changing hands → correct tenant per timestamp
npm run test:ingestion   # real TCP: handshake, ACK-after-durable-write, idempotent resend
npm run test:api         # HTTP contract, mandatory X-Tenant-Id, isolation
npm run test:scenarios   # the scenario engine: determinism, the handover boundary
npm run test:replay      # scenarios through the WHOLE pipeline over real TCP
npm run test:operability # logging redaction, graceful drain, LB-shaped /health
npm run test:config      # .env.example is complete; no secrets committed
npm run test:engine-hours # D1: AVL 102 is minutes; 103/449/200 are refused

# P1 — register tests only under DB=pg (they need a real database)
DB=pg npm run test:rls          # tenant isolation enforced by the DB, not the app
DB=pg npm run test:immutability # raw_frames append-only, enforced by a trigger
```

`npm test` is for humans. **`npm run test:gate` is what CI runs** — it fails the
build if the passing count drops below the floor in `src/tools/test-gate.js` or if
anything is skipped, because a deleted test silently retires an invariant's proof.

### Running the tests against Postgres

```bash
npm install                       # pulls `pg` (the only dependency)
npm run db:up                     # docker compose: postgres:16
npm run db:reset                  # apply db/schema.sql then db/seed.sql
DB=pg APP_DATABASE_URL=postgres://dozr_app:dozr_app@localhost:5432/dozr_telematics npm run test:tenancy
DB=pg npm run demo
npm run db:down
```

`test:tenancy` and `test:ingestion` are the ones worth re-running under `DB=pg`:
that is where row-level security and the evidence-immutability trigger actually
do the work instead of the application.

---

## What is real vs. simulated

**Real** (device-accurate — do not "simplify" these): the TCP framing, the IMEI
handshake, the Codec 8/8E record layout, the CRC-16/IBM, and the 4-byte ACK. The
standard IO IDs 239 (ignition), 240 (movement), 69 (GNSS status) are the genuine
Teltonika IDs.

**Simulated / placeholder — needs a hardware decision:** the total-engine-hours
signal. Real engine hours arrive over the vehicle **CAN bus**, and which IO ID
carries them depends on the FMC model + CAN adapter *program* for that exact
make/model/year of machine. That mapping is open decision **D1** in the build
docs. Here it is carried as a 4-byte "engine-on seconds" counter under IO ID 200
so the simulator and decoder agree; the dev team replaces this with the real
per-program mapping. See `docs/PROTOCOL.md`.

---

## Hand-off notes for the development team

- **Storage:** implement nothing new — `src/store/pg-store.js` already mirrors the
  memory adapter against Postgres. On AWS, point `DATABASE_URL` at RDS. For
  time-series scale, swap the base image in `docker-compose.yml` for TimescaleDB
  (noted inline) and add a hypertable migration; the store interface does not change.
- **Ingestion at scale:** `src/ingestion/server.js` is a single Node process. In
  production, front it with a Network Load Balancer and run N instances; ACK-after-
  durable-write + idempotency mean a device can safely reconnect to any instance.
- **The utilisation ledger** (`src/ledger/`) is now built — by the ledger
  owner's explicit sign-off, since its failure mode is a silently wrong invoice
  and CLAUDE.md gates it behind a human, not speculative generation. It is
  correct against its spec and the seed `handover` scenario (`npm run
  test:ledger`, 11/11) but is NOT yet wired to any real invoice path: that
  still needs the D1 hardware half and a human review of the billing math on
  real fleet data. See `docs/MODULES.md`. A second, explicitly-labeled billing
  basis — **ignition-on duration** (`src/ledger/ignition-duration.js`,
  `source: 'ignition'`, never `'ecu'`) — covers fleets with no CAN adapter at
  all, such as the Actros haulage tractor above; its production max-gap
  threshold is still an open sign-off (`TASKS.md`).
- **Hardening:** the IMEI handshake is rate-limited per source IP
  (`src/ingestion/handshake-limiter.js`), oversized/malformed packets are
  refused rather than buffered, and idle/silent sockets are timed out — see
  `docs/MODULES.md` § Module 1. A concurrency harness
  (`npm run loadtest`) has verified 1,000 simultaneous connections with zero
  errors.
- **The one decision that blocks real data:** D1 (CAN engine-hours mapping). Until
  it's made, engine hours are simulated. Everything else is production-shaped.

---

## Where to read more

- `docs/MODULES.md` — the nine modules, what each does, what's in this slice vs.
  defined-only, and how to test each.
- `docs/PROTOCOL.md` — the exact Teltonika framing implemented, field by field.
- `CLAUDE.md` — build/test commands and the correctness invariants, for any agent
  or engineer working in this folder.
- `../context/` — the GPS Build Handbook, PRD, expert reviews, Teltonika packs, and
  the invariants doc this harness is the first slice of (index: `../context/README.md`).
