# TASKS.md — the build board

The live task board for the GPS/telematics build. Tasks are grouped by phase
(`BUILD_PLAN.md`), tagged with an owner agent (`AGENTS.md`), and gated: **finish a
phase's gate before starting the next phase.** Check a box only when the task's
done-criteria are met and its tests are green.

Legend: `[ ]` open · `[~]` in progress · `[x]` done · **@agent** owner ·
🔒 blocked-until

---

## ✅ Phase P-now — the slice (DONE)

- [x] Module 0 Protocol — Codec 8/8E, CRC-16/IBM, IMEI, ACK **@protocol-engineer**
- [x] Module 1 Ingestion — handshake, reframing, ACK-after-durable-write **@ingestion-engineer**
- [x] Module 2 Decode/normalise — NULL≠zero, ecu-only, attribution **@protocol-engineer**
- [x] Module 3 Store — memory + pg adapters, schema, seed **@database-engineer**
- [x] Module 4 Enrichment — coarse state (minimal) **@integration-engineer**
- [x] Module 6 Read API — tenant-scoped HTTP **@api-engineer**
- [x] Module 9 Simulator — device client + scenarios + runner **@integration-engineer**
- [x] Modules 5 & 7 defined-only throwing stubs **@ledger-owner / @integration-engineer**
- [x] 37 tests green in memory mode; `npm run demo` proves invariants 1,2,6,7,9 **@qa-test-engineer**
      *(now 68 after P0 — see the P0 section and `TESTING.md`)*

---

## Phase P0 — Harden the slice  **@qa-test-engineer (lead), @integration-engineer**

- [x] Stand up CI: `.github/workflows/telematics-tests.yml`, Node 20+22 matrix, memory mode, runs `test:gate` + `demo` + a live scenario replay with a SIGTERM check **@qa-test-engineer**
  - [x] Merge gate is **count- and skip-proof** (`npm run test:gate`, floor in `src/tools/test-gate.js`); verified it fails when the floor is raised
  - [ ] 🔒 **BLOCKED — needs a human decision.** `gps-build/` is **untracked in git** (`git ls-files gps-build` → 0 files) and the workflow sits at `gps-build/.github/`, which GitHub only reads from a **repo root**. Own repo, or subfolder with the workflow moved up? Until then the gate runs locally only. See `TESTING.md` § CI.
- [x] Confirm `.env.example` complete; no secrets committed; ports/codec configurable **@integration-engineer**
  - [x] Enforced by a test, not by eye: `test:config` fails on an undocumented var, a fossil var, a real-looking password, or `.env` not being git-ignored
- [x] Structured logging + LB-shaped `/health` probe **@ingestion-engineer**
  - [x] `src/logging/logger.js`: one JSON/kv line per event, secret + credential-URI redaction, no tenant payloads, `/health` probes unlogged
  - [x] `/health`: 200 `ready` / 503 `draining` / 503 `unavailable`, **zero store I/O on the probe path** (asserted by a trip-wire test)
- [x] Graceful shutdown (drain + close sockets) on ingestion + API servers **@ingestion-engineer**
  - [x] `src/lifecycle/shutdown.js`: one drain per process, hard `SHUTDOWN_TIMEOUT_MS` deadline, exit 0
  - [x] Ingestion drain finishes the in-flight write **and** its ACK (invariant 1), refuses connections mid-drain
  - [x] Verified on real processes with real signals: `npm run verify` → 14/14 on Linux
- [x] Run-books: run a single sim device against a live server; how to read demo output **@integration-engineer**
  - [x] `telematics/docs/RUNBOOKS.md` — 8 sections; every command in it was executed, and §3 documents the memory-mode gotcha found by doing so
- [x] **GATE:** `test:gate` green (68/68, no skips) on a non-build machine (WSL2 Linux, Node 18) + `npm run demo` shows ACK 20/5/0-new + `npm run verify` 14/14
  - [ ] ⚠ Gate met **locally on two platforms**; not yet met *in CI*, which is blocked on the git/repo decision above. `@qa-test-engineer` to sign off once CI runs.

### P0 additions to Module 9 (simulator → scenario engine)

- [x] `src/simulator/phases.js` — phase vocabulary (`off`/`startup`/`travel`/`work`/`idle`/`shutdown`/`unplugged`), seeded PRNG, track geometry. Deterministic: no `Math.random`, no `Date.now` **@integration-engineer**
- [x] `src/simulator/scenarios.js` — named scenario registry: `day-cycle`, `handover`, `yard-idle`, `after-hours`, `geofence-cross`, `tamper` **@integration-engineer**
- [x] `handover` emits on **both sides** of the seeded instant `2025-06-01T00:00:00Z` from one IMEI, and keeps sending IO 200 afterwards so invariant 9 is genuinely exercised **@integration-engineer**
- [x] CLI: `--scenario` / `--list` / `--interval` / `--records` / `--seed` / `--codec` / `--stream`, plus `SIM_*` env equivalents; graceful shutdown retained **@integration-engineer**
- [x] `test:scenarios` (10) + `test:replay` (5, whole pipeline over real TCP) — invariants 6 and 9 are now proven **end-to-end**, not just as unit calls **@qa-test-engineer**
- [x] Legacy `makeScenario()` kept byte-identical, so `npm run demo` and `test:ingestion` output did not move **@integration-engineer**

---

## Phase P1 — Real PostgreSQL  **@database-engineer**  🔒 after P0 gate

> P0's code work is done and its gate passes locally on two platforms; the only
> thing outstanding is the **git/CI decision** noted above. P1 also needs a host
> decision: this machine has **no Docker and no PostgreSQL** (`docker: command not
> found`), so `db:up` cannot run here. Options: install Docker Desktop, install
> Postgres 16 natively and skip `db:up`, or point `DATABASE_URL` at a hosted
> instance (Supabase is already used elsewhere in Kasper).

- [ ] `npm install`, `db:up`, `db:reset` on a real Docker host **@database-engineer**
- [ ] Run `DB=pg npm test`; focus `test:tenancy` + `test:ingestion` **@database-engineer**
- [ ] New test: **RLS blocks cross-tenant reads** at the DB layer (fails if policy removed) **@database-engineer**
- [ ] New test: **`raw_frames` UPDATE/DELETE rejected** by the immutability trigger **@database-engineer**
- [ ] `DB=pg npm run demo` matches memory-mode output byte-for-byte **@database-engineer**
- [ ] Note the TimescaleDB hypertable migration path for P4 (no interface change) **@database-engineer**
- [ ] **GATE:** `DB=pg npm test` green + both DB-layer enforcement tests green + demo matches

---

## Phase P2 — Resolve D1, build ledger + evidence  **@ledger-owner (human-led), @protocol-engineer**  🔒 after P1 gate

> Start D1 investigation on **day one** regardless of active phase — it is the
> critical path and the longest-lead item.

- [ ] **D1:** identify CAN program + real engine-hours IO ID(s) per machine make/model/year **@protocol-engineer**
- [ ] Map real IO ID(s) in the decoder; simulator emits them; contract unchanged **@protocol-engineer**
- [ ] Build Module 5 ledger: utilisation per asset/period from **ECU readings only** **@ledger-owner**
- [ ] Build evidence seal: immutable, tamper-evident, reproduces a dispute pack **@ledger-owner**
- [ ] Human review of the billing math before it can emit a real number **@ledger-owner + coordinator**
- [ ] **GATE:** `test:ledger` green (exact utilisation on seed scenario) + evidence-tamper detection test + test refusing ignition-derived values as billing evidence

---

## Phase P3 — Rules & event detection + WhatsApp messaging  **@integration-engineer**  🔒 after P2 gate

- [ ] Grow Module 4 enrichment as needed (trips, geofence membership) **@integration-engineer**
- [ ] Build Module 8 rules: geofence in/out, after-hours ignition, idle-too-long, tamper/unplug, low battery **@integration-engineer**
- [ ] Build Module 7 messaging: WhatsApp Cloud API, live Meta creds + approved templates **@integration-engineer**
- [ ] Wire rules → messaging with idempotent (de-duplicated) event delivery **@integration-engineer**
- [ ] **GATE:** `test:rules` green (each event type) + WhatsApp integration test (Meta sandbox) + de-duplication test

---

## Phase P4 — Deploy to AWS + real-device pilot  **@database-engineer + @integration-engineer**  🔒 after P3 gate

- [ ] RDS for PostgreSQL: schema + RLS + triggers applied; `DATABASE_URL` → RDS **@database-engineer**
- [ ] (If volume warrants) switch to TimescaleDB + hypertable migration **@database-engineer**
- [ ] Ingestion on ECS/Fargate ×N behind a TCP Network Load Balancer **@ingestion-engineer**
- [ ] Deploy read API + ledger (scheduled) + rules/messaging as services **@integration-engineer**
- [ ] Real-device pilot: point a physical FMC130/FMC920 at the ingestion NLB (no server change) **@integration-engineer**
- [ ] (De-risk) run Traccar alongside as the off-the-shelf ingestion option for the first weeks **@integration-engineer**
- [ ] Observability: ingestion rate, ACK latency, write failures, per-tenant volume **@integration-engineer**
- [ ] **GATE:** real-hardware (or production-rate soak) acceptance — zero lost/duplicated records across an instance restart, correct attribution, reproducible dispute pack

---

## Open decisions

- **D1 (critical path):** CAN program + engine-hours IO ID mapping per machine.
  Owner **@protocol-engineer**. Blocks real billing data. Sources: `context/teltonika/`.
- **Time-series store:** plain Postgres now; TimescaleDB in P4 if volume warrants.
  Owner **@database-engineer**. Interface unchanged either way.
- **Pilot ingestion:** hand-written server vs. Traccar for the first weeks. Expert
  review favours Traccar to de-risk; our server stays the reference + test harness.
