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
      *(now **85** in memory mode and **91** under `DB=pg` after P0, D1, and P1 — see those sections and `TESTING.md`)*

---

## Phase P0 — Harden the slice  **@qa-test-engineer (lead), @integration-engineer**

- [x] Stand up CI: `.github/workflows/telematics-tests.yml`, Node 20+22 matrix, memory mode, runs `test:gate` + `demo` + a live scenario replay with a SIGTERM check **@qa-test-engineer**
  - [x] Merge gate is **count- and skip-proof** (`npm run test:gate`, floor in `src/tools/test-gate.js`); verified it fails when the floor is raised
  - [x] ✅ **RESOLVED.** `gps-build` is its own repo — **github.com/afsalali1238/simulator** — so the workflow sits at the repository root's `.github/workflows/`, which is the only place GitHub Actions reads from. Two commits have run green on Node 20 **and** 22 on GitHub's runners. See `TESTING.md` § CI.
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
- [x] **GATE:** `test:gate` green (no skips) on a non-build machine + `npm run demo` shows ACK 20/5/0-new + `npm run verify` 14/14
  - [x] ✅ Met **in CI**, not just locally: GitHub-hosted runners, Node 20 and 22, both green — a genuinely clean checkout on a machine that is not the build machine. Also green locally on Windows/Node 24 and WSL2 Linux/Node 18.

### P0 additions to Module 9 (simulator → scenario engine)

- [x] `src/simulator/phases.js` — phase vocabulary (`off`/`startup`/`travel`/`work`/`idle`/`shutdown`/`unplugged`), seeded PRNG, track geometry. Deterministic: no `Math.random`, no `Date.now` **@integration-engineer**
- [x] `src/simulator/scenarios.js` — named scenario registry: `day-cycle`, `handover`, `yard-idle`, `after-hours`, `geofence-cross`, `tamper` **@integration-engineer**
- [x] `handover` emits on **both sides** of the seeded instant `2025-06-01T00:00:00Z` from one IMEI, and keeps sending AVL 102 afterwards so invariant 9 is genuinely exercised **@integration-engineer**
- [x] CLI: `--scenario` / `--list` / `--interval` / `--records` / `--seed` / `--codec` / `--stream`, plus `SIM_*` env equivalents; graceful shutdown retained **@integration-engineer**
- [x] `test:scenarios` (10) + `test:replay` (5, whole pipeline over real TCP) — invariants 6 and 9 are now proven **end-to-end**, not just as unit calls **@qa-test-engineer**
- [x] Legacy `makeScenario()` kept byte-identical, so `npm run demo` and `test:ingestion` output did not move **@integration-engineer**

---

## Phase P1 — Real PostgreSQL  **@database-engineer**  ✅ GATE MET

> Ran on **Docker Desktop 4.88.1** + `postgres:16` (PostgreSQL 16.15) on this
> machine. `DB=pg npm test` → **91/91**, gate green in both modes, pg demo
> byte-identical to memory. Both DB-layer enforcement tests were verified by
> dropping the policy/trigger and watching them fail. Full transcript in
> `TESTING.md` § "Testing against real Postgres".

- [x] `npm install`, `db:up`, `db:reset` on a real Docker host — container healthy in 1s; schema + seed applied **@database-engineer**
- [x] Run `DB=pg npm test` — **91/91 pass, 0 fail, 0 skipped** (85 in memory mode; the two pg-only suites add 4 tests each) **@database-engineer**
- [x] New test: **RLS blocks cross-tenant reads** at the DB layer — `test/rls.test.js`, 4 tests. Proven load-bearing: dropping the three policies + `DISABLE ROW LEVEL SECURITY` fails 3 of 4 (the 4th is the role-privilege guard) **@database-engineer**
- [x] New test: **`raw_frames` UPDATE/DELETE rejected** by the immutability trigger — `test/immutability.test.js`, 4 tests, run as the **owner** (the restricted role would fail on privileges alone, which is a false proof). Dropping the trigger fails 3 of 4 **@database-engineer**
- [x] `DB=pg npm run demo` matches memory-mode output byte-for-byte — verified by literal `diff`, not by eye **@database-engineer**
- [ ] Note the TimescaleDB hypertable migration path for P4 (no interface change) **@database-engineer**
- [x] **GATE:** `DB=pg npm test` green + both DB-layer enforcement tests green + demo matches ✅

> **Found by running it:** `test:config`'s "works with no `.env`" test asserted
> `config.db === 'memory'` against the *ambient* environment, so it failed under
> `DB=pg` — the test meant to prove zero-setup was broken by the environment it ran
> in. It now loads `config.js` in a child process with every documented env var
> stripped. Passes in both modes.

---

## Phase P2 — Resolve D1, build ledger + evidence  **@ledger-owner (human-led), @protocol-engineer**  🔒 after P1 gate

> Start D1 investigation on **day one** regardless of active phase — it is the
> critical path and the longest-lead item.

- [x] **D1 (desk half):** the billing parameter is **AVL 102 "Engine Worktime", 4 bytes, in MINUTES**, exposed by LV-CAN200 / ALL-CAN300 / CAN-CONTROL; program number reported live as AVL 100. Verified against Teltonika's official FMC130 parameter table, cross-checked against flespi and the FMC650 table. Refusal lists established: AVL 103 (tracker-counted), AVL 449 (ignition counter), AVL 200 (`Sleep Mode` — the retired stand-in). Per-machine program numbers drafted from the ALL-CAN300 supported-vehicle list; **all 200 construction-machinery entries expose the parameter**. Write-up: `D1_CAN_ENGINE_HOURS.md` **@protocol-engineer**
- [x] Real IDs mapped in the decoder (`src/decode/engine-hours.js`); simulator emits AVL 102 in minutes + AVL 100; contract unchanged; 14 tests in `test:engine-hours` **@protocol-engineer**
- [ ] 🔒 **D1 (hardware half) — needs an installed adapter, cannot be done at a desk:** read AVL 102 back live per brand via Configurator/Traccar, confirm the program number and unit for that exact make/model/year, then **reconcile against the machine's physical hour-meter** with `reconcile()`. Only then is a row *verified* and billable **@protocol-engineer + auto-electrician**
- [ ] ⚠ **Blocked on us:** name the real fleet (exact make/model/**year**). Every program-number row is a candidate until someone confirms the machines Dozr will deploy on. Also confirm 4- vs 5-digit program numbers — adapters made after 2018-01-01 prefix a `1` (`1261 → 11261`) **@coordinator**
- [ ] Ask Teltonika/distributor: confirm FMC130 + ALL-CAN300 for our asset mix; confirm "Engine lifetime" in the vehicle list *is* AVL 102; lifetime-delta vs session counter for a billing period **@coordinator**
- [ ] Build Module 5 ledger: utilisation per asset/period from **ECU readings only** **@ledger-owner**
- [ ] Build evidence seal: immutable, tamper-evident, reproduces a dispute pack **@ledger-owner**
- [ ] Human review of the billing math before it can emit a real number **@ledger-owner + coordinator**
- [ ] **GATE:** `test:ledger` green (exact utilisation on seed scenario) + evidence-tamper detection test + test refusing ignition-derived values as billing evidence
  - Partial credit already banked: the *decode-side* refusal of ignition-derived values is proven now by `test:engine-hours` (AVL 449 and AVL 200 both produce no engine data). The ledger-side half still needs Module 5.

---

## Phase P3 — Rules & event detection + WhatsApp messaging  **@integration-engineer**  🔒 after P2 gate

- [ ] Grow Module 4 enrichment as needed (trips, geofence membership) **@integration-engineer**
- [ ] Build Module 8 rules: geofence in/out, after-hours ignition, idle-too-long, tamper/unplug, low battery **@integration-engineer** — IN PROGRESS, red: first delivery reviewed in `RULES_MODULE8_REVIEW_2026-09-01.md`, re-verified and the remaining fix list handed off in `HERMES_HANDOFF_RULES_FIXLIST_2026-09-01.md` (2026-09-01). `test/rules.test.js` is 3/6 passing today; logic for rules 1-3 is sound once wired, rules 4-5 already implemented, spec still doesn't call `detectEvents`.
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

- **D1 (critical path) — parameter resolved, hardware verification open.** Engine hours
  are **AVL 102 "Engine Worktime", in minutes**; mapped in `src/decode/engine-hours.js`,
  documented in `D1_CAN_ENGINE_HOURS.md`. Owner **@protocol-engineer**. What still
  blocks a real invoice: the real fleet list, per-machine program-number confirmation,
  and a live reading reconciled against the machine's own hour-meter.
- **Time-series store:** plain Postgres now; TimescaleDB in P4 if volume warrants.
  Owner **@database-engineer**. Interface unchanged either way.
- **Pilot ingestion:** hand-written server vs. Traccar for the first weeks. Expert
  review favours Traccar to de-risk; our server stays the reference + test harness.
