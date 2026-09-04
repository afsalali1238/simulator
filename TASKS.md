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
      *(now **100** in memory mode after P0, D1, P1, and Module 8 rules (2026-09-02) — see those sections and `TESTING.md`. DB=pg count last verified at 91 during P1, before Module 8 landed; re-run `DB=pg npm test` to confirm the current pg-mode total — the rules tests are pure functions with no DB dependency, so they should add cleanly.)*

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

### P0 additions — parser/handshake hardening (2026-09-03)  **@protocol-engineer, @ingestion-engineer**

> From the audit `PARSER_HANDSHAKE_REVIEW_2026-09-02.md` (see its **Resolution — 2026-09-03**
> table). The parser/handshake were already correct and fail-closed; this widened the
> **defensive envelope** around them. Each item its own commit with a test + a gate-floor
> bump. No ledger/messaging/tenancy code touched; no invariant relaxed.

- [x] **F6** socket handshake + idle timeouts + optional `maxConnections` (`server.js`); config `INGEST_HANDSHAKE_TIMEOUT_MS` / `INGEST_IDLE_TIMEOUT_MS` / `INGEST_MAX_CONNECTIONS` **@ingestion-engineer**
- [x] **F1** declared-length cap in `readAvlFrame` — throws above `INGEST_MAX_PACKET_BYTES` (default 64 KB) instead of buffering toward ~4 GB **@protocol-engineer**
- [x] **F2** codec-ID allowlist — any codec ∉ {0x08, 0x8E} is refused after CRC, not mis-parsed as Codec 8 **@protocol-engineer**
- [x] **F3** GPS-fix validity flag — `normalize.js` sets `positionValid = satellites > 0`; the P3 geofence rule drops no-fix records so a dropout can't manufacture a spurious exit/enter (decided **before** P3 leans on position) **@protocol-engineer**
- [x] **F4** IMEI 15-digit ASCII validation + frame-length cap; a malformed IMEI is rejected (`reason: malformed_imei`) and counts toward the per-source limiter **@protocol-engineer, @ingestion-engineer**
- [x] **F5** truncated record throws a labelled `malformed record: body shorter than declared`, not a bare `RangeError` **@protocol-engineer**
- [x] **F8** RUNBOOKS §8 documents that the limiter keys on `remoteAddress`; the P4 NLB must preserve client source IP (linked from P4 below) **@ingestion-engineer**
- [ ] **F7** signed-IO decode — **deferred by design**; no signed parameter is in the decode set yet. Revisit when one is added (does not affect billing; AVL 102 is unsigned) **@protocol-engineer**
- [x] Coverage-gap tests the audit flagged (correct-but-unproven): `Number of Data 1 != 2`, non-zero preamble, truncated record **@qa-test-engineer**
- [x] Two new suites — `test/codec-hardening.test.js` (10 pure) + `test/ingestion-hardening.test.js` (4 wire-level); gate floor **135 → 149**, `test:gate` green (149/149, no skips/todos), `npm run demo` green **@qa-test-engineer**

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
- [x] Note the TimescaleDB hypertable migration path for P4 (no interface change) **@database-engineer** — DONE 2026-09-03: `telematics/docs/TIMESCALE_MIGRATION.md`. Only `position_records` + `engine_readings` become hypertables (`ts_ms`, 1-day chunks); the adapter's SQL surface, RLS policies, and the `raw_frames` immutability trigger are untouched; retention policies replace manual deletes (engine_readings retention placeholder pending the coordinator's audit call). The switch is deployed-config-only — no code branch, no compose dependency.
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
- [x] Build Module 5 ledger: utilisation per asset/period from **ECU readings only** **@ledger-owner** — DONE, verified 2026-09-02, built by the ledger owner's explicit sign-off (the person CLAUDE.md's guardrail refers to). `computeUtilisation()` sums positive ECU-meter deltas within [periodStart, periodEnd), scoped to the given asset+tenant; a meter decrease is recorded as a `meter-reset` anomaly and contributes 0, never a negative; a non-'ecu' reading is excluded and recorded as `non-ecu-excluded`, never blended in (invariants 4, 5); no ECU evidence ⇒ `billable: false` with figures `null`, never `0` (invariants 3, 9).
- [x] Build evidence seal: immutable, tamper-evident, reproduces a dispute pack **@ledger-owner** — DONE. `sealUtilisationRecord()` hashes a key-sorted serialisation of the figure chained with each raw frame's id + exact bytes (SHA-256); identical inputs reproduce an identical hash, and mutating one byte of one sealed frame changes it (invariant 8).
- [x] `test:ledger` green (exact utilisation on seed `handover` scenario) + evidence-tamper detection test + test refusing ignition-derived values as billing evidence — **8/8**, met 2026-09-02, including the exact seed figures test (`test/ledger.test.js`, moved up from `test/pending/`). Full gate `npm run test:gate` → **117/117**.
  - Partial credit already banked: the *decode-side* refusal of ignition-derived values is proven now by `test:engine-hours` (AVL 449 and AVL 200 both produce no engine data). The ledger-side half is now proven too (`non-ecu-excluded` anomaly, invariant 5 test).
- [ ] **Human review of the billing math against REAL fleet data before it can emit a real invoice number** **@ledger-owner + coordinator** — the code is correct against its spec and the seed simulator scenario; this is a separate, still-open sign-off gate once real data exists, and is additionally blocked on the D1 hardware half below.
- [ ] Wire the ledger into an actual invoice/API path — deliberately NOT done; not until the item above and the D1 hardware half are both cleared **@ledger-owner**
- [x] **First named real fleet: Mercedes-Benz Actros (flatbed haulage tractor) — one FMC130, no CAN adapter.** Confirmed 2026-09-02: no CAN adapter means AVL 102 is architecturally unavailable for this fleet (D1_CAN_ENGINE_HOURS.md §1 — the adapter, not the FMC130, exposes it), on the Actros or the untracked flatbed trailer, regardless of make/model. Human decision: bill this fleet on **ignition-on duration** instead of engine hours, built as a second, explicitly-labeled billing basis so it can never be confused with the ECU ledger — `src/ledger/ignition-duration.js`, `computeIgnitionOnDuration()`, `source: 'ignition'` never `'ecu'`. `npm run test:ignition-duration` → **9/9**. Full gate → **126/126**. **@ledger-owner**
  - Still needed before this fleet has real seed data (not yet fabricated — deliberately asked of the user rather than invented): Actros model year, the tenant/customer name for this haulage account, a real device IMEI once procured, and whether the flatbed trailer needs its own (untracked) asset row for record-keeping.
- [ ] ⚠ **Human decision needed: the ignition-duration max-gap threshold.** Interval attribution bills a device-offline stretch at its last known state, so an `ignition: true` reading followed by days of silence would bill the whole silence from two records. `computeIgnitionOnDuration()` now takes an opt-in `maxGapSeconds` that caps one ON interval's contribution and records an `oversized-gap-capped` anomaly for review (default: uncapped, behaviour unchanged). **The production number (e.g. 6 h? 24 h?) is a business/billing call and needs the ledger owner's sign-off before it is wired as a default** — one more item only a human can close. **@ledger-owner + coordinator**
- [x] **Ledger correctness review pass, 2026-09-03** — re-read both billing modules against the invariants line by line and closed 3 real coverage gaps with new regression tests (no production behaviour changed, all pre-existing figures unaffected): `computeUtilisation` had no test proving a different asset or a different tenant in the same input array can't leak into a figure (invariants 6, 7) — verified correct by hand, then pinned; the `[periodStart, periodEnd)` boundary was only exercised indirectly via the seed scenario, now has its own synthetic fixture; and a single ECU reading's `billable: true, billableSeconds: 0` case (real evidence vs. no evidence, invariant 3) had no test, unlike the equivalent already-tested case on the ignition-duration basis. `test:ledger` → **11/11**. Full gate → **179/179**. The two open sign-off items above (real-fleet review, the max-gap number) are unchanged by this pass — still only a human can close them.


---

## Phase P3 — Rules & event detection + WhatsApp messaging  **@integration-engineer**  🔒 after P2 gate

- [ ] Grow Module 4 enrichment as needed (trips, geofence membership) **@integration-engineer**
- [x] Build Module 8 rules: geofence in/out, after-hours ignition, idle-too-long, tamper/unplug, low battery **@integration-engineer** — DONE, verified 2026-09-02. All blockers/findings from `RULES_MODULE8_REVIEW_2026-09-01.md` and `HERMES_HANDOFF_RULES_FIXLIST_2026-09-01.md` are resolved: `detectEvents` loads cleanly, `test/rules.test.js` calls it directly and asserts on the returned events, after-hours uses `getUTCHours()` with a daytime negative case, idle threshold is a real 60 min, geofence `eventId` keys per-transition, dead import removed. `npm run test:rules` → **12/12**. Full gate `npm run test:gate` → **100/100, floor 100**, no skips.
- [x] Wire rules → messaging: delivery/dedupe plumbing (`src/messaging/dispatch.js`) — DONE, verified 2026-09-02. `deliverEvents()` maps each rule event type to a (placeholder, unapproved) template name, dedupes on the rule engine's own `eventId` (invariant 2), scopes every send to that event's own tenantId (invariant 7), isolates one failed send from sinking the batch (a failure is NOT marked delivered, so it stays retryable), and reports any event type with no template mapping instead of silently dropping it. `npm run test:messaging` → **9/9**. Deliberately does not send anything real — `sender` is a required, caller-supplied argument with no default, so nothing here can be mistaken for a live send (`HERMES_HANDOFF.md` "don't fake-send" honored). **@integration-engineer**
- [ ] Build Module 7's real sender: WhatsApp Cloud API call, live Meta creds + approved templates — this is the one piece `dispatch.js` was built to plug in without further rework once creds exist **@integration-engineer**
- [ ] **Back `dispatch.js`'s deliveredLog with durable storage** before the real sender goes live: a delivery-receipts table keyed on `eventId` (same pattern as the store adapters — the interface is the contract, the in-memory Set is the zero-setup stand-in). Without it, a process restart re-delivers every already-sent message. Invariant 2 applies to delivery, not just ingestion. **@integration-engineer**
- [x] `test:rules` green (each event type) + de-duplication test — **12/12**, met 2026-09-02
- [x] `test:messaging` green (dedupe, tenant isolation, partial-failure isolation, unmapped-type reporting) — **9/9**, met 2026-09-02
- [ ] **GATE (remaining):** WhatsApp integration test (Meta sandbox) — blocked on live Meta credentials + approved templates. This is the only thing left before P3's gate: everything upstream of the real send (rules, dedupe, tenant scoping, template mapping) is built and tested.

---

## Phase P4 — Deploy to AWS + real-device pilot  **@database-engineer + @integration-engineer**  🔒 after P3 gate

- [ ] RDS for PostgreSQL: schema + RLS + triggers applied; `DATABASE_URL` → RDS **@database-engineer**
- [ ] (If volume warrants) switch to TimescaleDB + hypertable migration **@database-engineer**
- [ ] Ingestion on ECS/Fargate ×N behind a TCP Network Load Balancer **@ingestion-engineer** — the NLB **must preserve the client source IP** (instance/ip targets do this natively), or the handshake rate-limiter — which keys on `remoteAddress` — either blocks the whole fleet together or can't isolate one abuser (F8; see `docs/RUNBOOKS.md` §8)
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
