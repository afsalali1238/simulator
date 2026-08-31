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
npm test        # the full suite (68 tests)
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
modes. Postgres mode is where you confirm the schema itself is correct.

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

## Testing

```bash
npm test                 # everything, run serially (68 tests)
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
- **The one module a human must own:** the utilisation **ledger** (`src/ledger/`)
  is deliberately a defined-only stub. Its failure mode is a silently wrong invoice,
  so it must be built and reviewed by a person, not generated. See `docs/MODULES.md`.
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
