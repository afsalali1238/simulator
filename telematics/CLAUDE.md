# telematics/ — Kasper GPS simulation + ingestion harness

This folder is the first working slice of the Kasper GPS/telematics build: a local,
free, zero-cloud harness that emits and receives **real Teltonika Codec 8/8E binary
over TCP**, decodes it into tenant-attributed telemetry, stores it, and serves it.
It exists because we don't have a physical Teltonika unit yet — the simulator sends
the exact bytes a real FMC130/FMC920 sends, so a real device drops in later with no
server change. It is meant to be handed to the development team to wire into AWS.

**Everything is in this one folder by design. Keep it that way** — new modules go
under `src/<module>/`, not elsewhere in the repo.

## Scope

GPS/telematics only. Nothing here touches the Marketplace, Vendor OS, or any other
Kasper product. If a change seems to reach outside telematics, stop and ask.

## Commands (all verified working)

```bash
# zero-setup — needs only Node ≥ 20, no install, no Docker (default DB=memory)
npm run demo            # full pipeline end-to-end with a proof summary
npm test                # all 83 tests, run serially
npm run test:gate       # THE MERGE GATE: the suite + count/skip enforcement
npm run verify          # spawn real servers, replay a scenario, SIGTERM them

# per module (each is independently testable)
npm run test:crc        npm run test:codec      npm run test:store
npm run test:decode     npm run test:tenancy    npm run test:ingestion
npm run test:api        npm run test:scenarios  npm run test:replay
npm run test:operability  npm run test:config   npm run test:engine-hours

# run the pieces
npm run start:ingest    # TCP ingestion server
npm run start:api       # HTTP read API
npm run sim:list        # every named scenario + what it proves
npm run sim -- --scenario handover    # replay the D1 handover story
npm run sim -- --stream --devices 2   # legacy indefinite soak stream

# Postgres mode (real RLS + triggers): needs Docker + `npm install` — phase P1
npm install && npm run db:up && npm run db:reset
DB=pg npm run demo
DB=pg npm run test:tenancy
npm run db:down
```

There is **no build step and no linter** — plain Node ESM. Don't invent one.

`npm test` is for humans; **`npm run test:gate` is the gate** and is what CI runs.
It also fails if the test count drops below the floor in `src/tools/test-gate.js`
or if anything is skipped — deleting a test would otherwise silently retire an
invariant's proof. Raise the floor in the same commit when you add tests.

Operational procedures (reading the logs, `/health` states, graceful restart,
troubleshooting) are in `docs/RUNBOOKS.md`.

## Store modes

One store interface (`src/store/index.js`), two adapters chosen by the `DB` env var:
- `DB=memory` (default) — in-process, zero dependencies, runs anywhere. Models the
  invariants at the application layer.
- `DB=pg` — real PostgreSQL; tenancy is enforced by **row-level security** and
  evidence immutability by a **trigger**, in the database itself.

Both pass the same tests. `pg` is imported only on the pg path, so memory mode needs
no `npm install`.

## The nine correctness invariants (non-negotiable)

These are the whole reason the code is shaped the way it is. Don't "simplify" past them.

1. **ACK only after a durable write.** The ingestion server ACKs a packet only once
   its records are committed. (`test:ingestion`, `test:store` via `FAIL_BEFORE_COMMIT`)
2. **Idempotent ingest.** A resent packet never double-counts — unique on
   `(device, ts)` for positions, `(asset, ts, source)` for engine readings.
3. **NULL ≠ zero.** An absent IO is `null`, never `0`. (`test:decode`)
4. **ecu vs estimated never merge.** CAN-derived engine hours are always
   `source: 'ecu'`; estimated values are produced elsewhere and never mixed in.
5. **Ignition counters are never billing evidence.** Only ECU engine readings back
   an invoice (enforced in the ledger module — Module 5, defined-only).
6. **Attribution at each record's own timestamp**, never "as of now". A device that
   changes hands mid-period splits correctly. (`test:tenancy`)
7. **Tenancy always.** Every read is tenant-scoped; app-level in memory, RLS in pg.
   (`test:store`, `test:tenancy`, `test:api`)
8. **Sealed, immutable evidence chain.** Raw frames are append-only (a trigger blocks
   mutation in pg); they are the root of any dispute pack.
9. **Unlisted machine ⇒ position + ignition only.** No CAN program ⇒ no engine hours.
   (`test:tenancy`, `test:decode`)

## Real vs. simulated

Real and device-accurate: TCP framing, IMEI handshake, Codec 8/8E record layout,
CRC-16/IBM, the 4-byte ACK, IO IDs 239/240/69 — **and engine hours: AVL 102 "Engine
Worktime", in MINUTES** (decision **D1**, resolved at the parameter level).

Three engine-hours look-alikes are refused, not billed: **AVL 103** (counted by the
tracker, not the machine), **AVL 449** (ignition-on seconds, invariant 5), and **AVL
200** (the retired stand-in — really `Sleep Mode`). The conversion minutes → seconds
lives in exactly one place, `src/decode/engine-hours.js`; getting it wrong is a 60×
billing error that no invariant test would catch, which is why
`npm run test:engine-hours` asserts it arithmetically.

**Still not verified on hardware:** a reading becomes evidence only after
`reconcile()` agrees with the machine's physical hour-meter. See `docs/PROTOCOL.md`
and `../D1_CAN_ENGINE_HOURS.md`.

## Module map & docs

`README.md` (how to run/test + hand-off notes), `docs/MODULES.md` (the nine modules,
in-slice vs defined-only, how to test each), `docs/PROTOCOL.md` (byte-level framing),
`docs/RUNBOOKS.md` (operating it: logs, `/health`, graceful restart, troubleshooting).
The broader GPS Build Handbook, PRD, and invariants doc are in `../context/`

## The simulator is the test bench — keep it honest

`src/simulator/` is not a toy. The ledger, the rules engine, D1, and soak tests all
replay against it, so two properties are load-bearing:

- **Determinism.** `phases.js` uses a seeded PRNG. No `Math.random`, no `Date.now`.
  Same scenario + seed ⇒ byte-identical records, so tests can pin exact values.
- **Absence is not zero.** A signal with no reading is `null` and its IO element is
  **omitted**, never sent as `0`. That is how invariant 3 gets exercised at all.

`npm run sim:list` shows the named scenarios. `handover` is the important one: one
device, records either side of `2025-06-01T00:00:00Z`, still emitting AVL 102 after
the handover — so the system has to *choose* not to produce engine data for a
non-CAN asset. That is invariant 9's trap, and it is deliberate. Don't "fix" it.


Modules 5 (ledger) and 7 (messaging) are deliberately defined-only stubs that throw
— the ledger because a wrong number there is a wrong invoice (a human must own it),
messaging because it needs live WhatsApp credentials. Don't wire them into anything
until they're built for real.
