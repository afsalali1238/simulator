# Testing

How this system is tested, and — more importantly — **how each correctness invariant
is tied to a test that fails if the invariant breaks.** In a billing-and-tenancy
system the tests are not a formality; they are the definition of "correct".

The test suite runs with **zero setup** in memory mode (Node's built-in `node:test`,
no install, no Docker) and again against **real Postgres** to prove the invariants at
the database layer.

---

## How to run

```bash
cd telematics

npm test                 # everything, serially — 85 tests (91 under DB=pg)
npm run test:gate        # what CI runs: the same suite + count/skip enforcement
npm run demo             # end-to-end proof on live data
npm run verify           # real processes, real SIGTERM, /health probes

# one module at a time (each module is independently testable):
npm run test:crc         # CRC-16/IBM vs Teltonika's documented canonical packet
npm run test:codec       # Codec 8 & 8E encode/decode round-trips, byte-identical
npm run test:store       # atomic/durable/idempotent writes, tenant-scoped reads
npm run test:decode      # NULL≠zero, ecu-only engine hours, attribution (pure fns)
npm run test:tenancy     # a device changing hands → correct tenant per timestamp
npm run test:ingestion   # real TCP: handshake, ACK-after-durable-write, resend
npm run test:api         # HTTP contract, mandatory X-Tenant-Id, isolation
npm run test:scenarios   # the simulator's scenario engine (pure, deterministic)
npm run test:replay      # scenarios driven through the WHOLE pipeline over TCP
npm run test:operability # logging redaction, graceful drain, LB-shaped /health
npm run test:config      # .env.example is complete; no secrets committed
npm run test:engine-hours # D1: the CAN engine-hours mapping, units, and refusals
npm run test:imei        # fleet device identity: Luhn, uniqueness, determinism
npm run test:fleet       # unique-IMEI full-process sim over real TCP (memory mode)

# P1 — these register tests ONLY under DB=pg (they need a real database)
DB=pg npm run test:rls          # tenant isolation enforced by the DB, not the app
DB=pg npm run test:immutability # raw_frames is append-only, enforced by a trigger
```

Tests run **serially** (`--test-concurrency=1`) because several bind real TCP/HTTP
sockets; concurrency would cause port races. This is deliberate, not a limitation.

The test files are enumerated in JavaScript (`src/tools/test-files.js`), not by a
shell glob or a directory argument. Both of those are unportable: Node 20 cannot
expand `"test/*.test.js"` itself, Node 24 rejects `--test test/` outright, and
cmd.exe does not glob at all. A merge gate whose test count depends on the runner
is not a gate.

### `npm test` vs `npm run test:gate`

`npm test` is for humans — it fails when a test fails. **`npm run test:gate` is
the merge gate**, and it additionally fails when:

- the number of passing tests drops **below the floor** (`DEFAULT_MIN_TESTS` in
  `src/tools/test-gate.js`, currently **85** — the memory-mode count, since that
  is what CI gates on), or
- anything is **skipped** or marked **todo** — a skip is not a pass.

That is there because the quiet failure mode in this repo is not a red test; it
is a *deleted* test. Removing one silently retires an invariant's proof and
nothing goes red. If you legitimately change the suite size, change the floor in
the same commit so it shows up in review. Verify the gate still bites with
`MIN_TESTS=999 npm run test:gate` (expect exit 1).

### `npm run verify` — what the in-process suite cannot cover

Every test above runs inside one process, so three P0 claims would otherwise go
unproven: that `npm run start:ingest` / `start:api` actually bind when spawned as
their own processes, that **SIGTERM drains and exits 0** (the ECS/NLB contract),
and that a scenario replays over a real socket between two processes.
`src/tools/verify-runtime.js` spawns them for real and checks all of it — 14
checks. On Windows the 4 signal checks are **skipped and say so**, because
Windows emulates POSIX signals and never runs the handlers; run it on Linux/macOS
or in CI for the full set.

---

## The test suites (85 memory / 91 under DB=pg)

| Suite | Tests | What it covers |
|-------|------:|----------------|
| `test/crc.test.js` | 5 | CRC-16/IBM against Teltonika's own documented canonical packet (`0xC7CF`), and decode of that packet. |
| `test/codec.test.js` | 8 | Codec 8 **and** 8E: encode→decode round-trips are byte-identical; header layout; IO grouping; the 8E variable-length group. |
| `test/store.test.js` | 5 | Durable/atomic writes + evidence; idempotency; tenant-scoped reads; latest-ECU lookup; `FAIL_BEFORE_COMMIT` leaves nothing stored. |
| `test/decode.test.js` | 6 | NULL≠zero (and present-zero is still `false`, not absent); engine hours ecu-only for CAN assets; attribution fallback to owner tenant; state derivation. |
| `test/tenancy.test.js` | 2 | The same device attributes to different tenants by record timestamp; an unassigned device is scoped to its owner with position+ignition only. |
| `test/ingestion.test.js` | 5 | Real loopback TCP: handshake accept + ACK; reject unknown IMEI; Codec 8 & 8E; idempotent resend; `FAIL_BEFORE_COMMIT` → no ACK, nothing persisted, then clean recovery. |
| `test/api.test.js` | 6 | `/health`; 400 without `X-Tenant-Id`; tenant-scoped positions; engine-hours latest + `null` for a no-CAN asset; `/devices`; 404. |
| `test/scenarios.test.js` | 10 | **P0.** The simulator's scenario engine, in isolation: every scenario is deterministic and uses seeded IMEIs; `handover` straddles the boundary and resolves to two tenants; `yard-idle` omits the engine IO entirely; `tamper` reports `null` not `false`; `geofence-cross` really crosses; the hour-meter is monotonic and only advances while the engine runs; the handover constant matches the store fixtures. |
| `test/replay.test.js` | 5 | **P0.** The same scenarios driven through the **whole pipeline** over real TCP (device → ingestion → store → API): the handover splits one device between two tenants *by timestamp*; identical wire data yields ECU hours for the CAN asset and none for the non-CAN one; `yard-idle` falls back to the owner tenant; a replayed track is idempotent; Codec 8 also works. |
| `test/operability.test.js` | 11 | **P0.** Structured logging (shape, levels, credential/secret redaction, no tenant payloads, no probe spam); graceful shutdown (runs once, bounded by the deadline, reports a failed drain); `/health` (200 ready / 503 draining, **zero** store I/O on the probe path); the API drain waits for in-flight requests; the ingestion drain finishes an in-flight write **and** its ACK, and refuses a device that arrives mid-drain. |
| `test/config.test.js` | 5 | **P0.** `.env.example` documents every env var the code reads and nothing it doesn't; the slice has working defaults with no `.env`; `.env` is git-ignored and no real credentials are committed; the shutdown deadline stays under a 30s orchestrator grace period. |
| `test/engine-hours.test.js` | 14 | **D1.** The CAN engine-hours mapping, where every failure mode is silent: the documented FMC130 IDs are what the code uses; only **AVL 102** (the machine's own hour-meter) is billable; the retired **AVL 200** stand-in produces nothing (200 is `Sleep Mode`); **102 is minutes** — asserted with exact arithmetic, because reading it as seconds is a 60× billing error no other test would catch; **AVL 103** (tracker-counted) is refused, not relabelled `ecu`; **AVL 449** (ignition counter) is forbidden as billing evidence; invariant 9 still gates everything; and `reconcile()` catches a unit error against the dashboard hour-meter and **names** it. |
| `test/imei.test.js` | 12 | **Fleet sim.** Device identity (`src/simulator/imei.js`): the Luhn implementation pinned to the seed (D1 `356307042441013` valid; hand-typed D2 `356307042441099` invalid — its real check digit is 6); `makeImei`/`generateFleet` produce 15-digit, TAC-`35630704`, Luhn-valid, unique, deterministic IMEIs, disjoint from the seed, that also clear codec.js's format-only `isValidImei` gate. |
| `test/fleet.test.js` | 8 | **Fleet sim.** The unique-IMEI full process over real loopback TCP (`src/simulator/run-fleet.js` + `provision.js`): a **provisioned** generated IMEI handshakes `0x01` and persists; an **unprovisioned** well-formed one is rejected at the registry gate; the owner-tenant-only fleet is position + ignition only with **no engine data** (inv 9), every record attributed to the owner and none leaking to A/B (inv 7), idempotent on resend (inv 2), a bad-Luhn IMEI refused before the registry, and `runMemory` end-to-end returns an all-pass summary. |
| `test/rls.test.js` | 4 *(DB=pg only)* | **P1.** Tenant isolation enforced by **the database**, not by application code. RLS is `ENABLED` on all three tenant-scoped tables; the reader role is neither SUPERUSER nor BYPASSRLS (so RLS actually applies — a mis-pointed `APP_DATABASE_URL` would otherwise make every assertion vacuous); with **no** tenant context set the app role sees **zero** rows (default-deny, not all rows); and each tenant sees its own side of the D1 handover and not the other's, asserted both through the store's read path and with bare `SELECT count(*)` at the DB layer. |
| `test/immutability.test.js` | 4 *(DB=pg only)* | **P1.** `raw_frames` is append-only, enforced by a trigger. INSERT is allowed; UPDATE and DELETE are both rejected with an error matching `/append-only/` (proving it is the *trigger*, not a permission error); and the sealed row is byte-unchanged afterwards. Runs as the **owner**, not the restricted role — a `dozr_app` mutation would fail on privileges alone and would still fail with the trigger removed, which is a false proof. |

---

## Invariant → test map

This is the table that matters. Every invariant that can be exercised in the current
slice has at least one test that fails if the invariant is violated. The two that
depend on not-yet-built modules (5) or on the database layer (8's trigger) have their
**full** enforcement test scheduled in a named build phase — called out honestly below.

| # | Invariant | Proven by | Status |
|---|-----------|-----------|--------|
| 1 | **ACK only after durable write** | `test:ingestion` (`FAIL_BEFORE_COMMIT` → no ACK, nothing persisted, recovery) · `test:store` (fail-before-commit leaves store unchanged) · `test:operability` (a graceful drain finishes the in-flight write **and** its ACK; a device arriving mid-drain is refused) · `verify` (SIGTERM on a real process exits 0 without a forced drain) | ✅ proven now |
| 2 | **Idempotent ingest** | `test:store` (resend doesn't double-count) · `test:ingestion` (idempotent resend over TCP) · `test:replay` (a replayed scenario track re-sent over TCP adds nothing) · `test:fleet` (a fleet device's resent packet adds nothing) | ✅ proven now |
| 3 | **NULL ≠ zero** | `test:decode` (absent IO → `null`; present-zero stays `false`) · `test:scenarios` (`yard-idle` omits the engine IO entirely; `tamper` reports ignition `null`, not `false`, and state `unknown`) | ✅ proven now |
| 4 | **ecu vs estimated never merge** | `test:decode` (engine hours only produced for CAN assets, always tagged `source: 'ecu'`) · `test:replay` (the only readings that reach the API are `source: 'ecu'`) · `test:engine-hours` (a **tracker-counted** meter, AVL 103, is dropped rather than relabelled `ecu`) | ✅ proven now |
| 5 | **Ignition counters never billing evidence** | `test:engine-hours` (**AVL 449 `Ignition On Counter` is refused by the decoder**, and the retired AVL 200 stand-in produces nothing) — the ingestion-side half is now proven. Turning a refused signal into an invoice is still `test:ledger` | 🟡 decode side proven now; ledger side 🔒 **P2** |
| 6 | **Attribution at each record's own timestamp** | `test:tenancy` (D1 splits between Tenant A and B by timestamp) · `test:decode` (attribution fallback) · `test:scenarios` (the `handover` scenario emits either side of `2025-06-01T00:00:00Z` and resolves to two different tenants) · `test:replay` (**end-to-end over TCP**: every record each tenant can see is on its own side of the boundary) | ✅ proven now, end-to-end |
| 7 | **Tenancy always** | `test:store` (tenant-scoped reads) · `test:tenancy` · `test:api` (400 without header, isolated positions) · `test:replay` (the two tenants' record sets are disjoint; an unassigned device falls back to its owner) · `test:operability` (no tenant id ever reaches a log line) · `test:fleet` (a whole generated fleet falls back to its owner tenant; contractors A and B see none) · **`test:rls` under `DB=pg` (RLS enabled, default-deny with no tenant context, cross-tenant read blocked by the database itself)** | ✅ proven now at **both** layers |
| 8 | **Sealed, immutable evidence chain** | `test:store` (raw frame persisted as evidence) · `test:replay` (a de-duplicated resend still seals its own frame) · **`test:immutability` under `DB=pg` (UPDATE and DELETE on `raw_frames` rejected by the trigger, even as the owner; row byte-unchanged)** | ✅ proven now, trigger-enforced |
| 9 | **Unlisted machine ⇒ position + ignition only** | `test:tenancy` (unassigned D2 → no engine hours) · `test:decode` (no CAN ⇒ no engine hours) · `test:scenarios` + `test:replay` (**the trap**: after the handover the device keeps sending AVL 102, and the system still produces no engine data for Generator Y) · `test:fleet` (the owner-only fleet produces no engine data over real TCP) · `test:engine-hours` (the gate holds for every billable ID) | ✅ proven now, end-to-end |

**What D1 changed here.** Invariant 5 was previously "enforced by design" — nothing
in the code turned ignition into billing, but nothing stopped it either. The decoder
now holds an explicit refusal list (`FORBIDDEN_AS_BILLING_EVIDENCE`: AVL 449 ignition
counter, AVL 200 sleep mode) and a *near-miss* list (AVL 103, a tracker-counted hour
meter that looks exactly like usable ECU data), each with a test that fails if the
refusal is removed. Invariant 4 gained the same protection from the other direction:
a refused parameter must be **dropped**, never relabelled `source: 'ecu'`.

`test:engine-hours` also guards a failure mode no invariant test could see: AVL 102
is in **minutes**, and the canonical row is in **seconds**. Getting that conversion
wrong bills 60× wrong while every other test stays green, because the pipeline is
unit-agnostic. The unit is now asserted with exact arithmetic in both the decoder and
the simulator's wire output.

**Honest reading of this table:** eight invariants (1, 2, 3, 4, 6, 7, 8, 9) are fully
proven today, and 7 and 8 are proven at **both** layers — application code in memory
mode and the database itself under `DB=pg`. Invariant 5 is half done: the decoder now
*refuses* ignition-derived and tracker-counted values (`test:engine-hours`), but
proving nothing forbidden can reach an invoice needs the ledger, which is **P2** by
design (Module 5 is a throwing stub until a human builds it). Nothing is hand-waved:
the one remaining gap is named and scheduled in `BUILD_PLAN.md`.

### The P1 negative tests — proven by deliberately breaking the database

An enforcement test that would pass with the enforcement removed is worthless. Both
P1 suites were checked by dropping the thing they test, against the live Postgres:

| What was dropped | Result |
|---|---|
| `DROP POLICY` ×3 + `DISABLE ROW LEVEL SECURITY` ×3 | `test:rls` **3 of 4 failed** (the 4th is the role-privilege guard, which is unrelated to the policies) — exit 1 |
| `DROP TRIGGER raw_frames_immutable` | `test:immutability` **3 of 4 failed** (the 4th asserts INSERT is *allowed*, which it still is) — the owner's UPDATE and DELETE both succeeded, and the sealed row changed |

`npm run db:reset` restored both, and each suite went back to 4/4. So the tests are
load-bearing, not decorative.

**What P0 changed here.** Invariants 6 and 9 were previously proven by *unit*
tests calling `resolveAssignment` and `normalizeRecord` directly. They are now
also proven **end-to-end**: the `handover` scenario puts genuine Codec 8E bytes on
a real socket from one IMEI across the handover instant, and `test:replay` asserts
the split lands on the right tenants at the API. Invariant 1 gained a
shutdown-shaped proof — a drain must never cut between commit and ACK — which is
the failure mode a rolling deploy or an NLB target drain would otherwise expose.

---

## Testing against real Postgres (P1 gate — MET)

Memory mode models the invariants at the application layer. Postgres mode proves the
schema itself enforces them.

```bash
cd telematics
npm install                       # pulls `pg` (the only dependency)
npm run db:up                     # docker compose: postgres:16
npm run db:reset                  # apply db/schema.sql then db/seed.sql
DB=pg npm test                    # the whole suite against the real database
DB=pg npm run test:rls            # tenant isolation, enforced by the DB
DB=pg npm run test:immutability   # raw_frames append-only, enforced by a trigger
DB=pg npm run demo                # matches memory-mode output exactly
npm run db:down
```

`test/rls.test.js` and `test/immutability.test.js` are the two DB-layer suites the P1
gate calls for. They register their tests **only** when `config.db === 'pg'`: in memory
mode each file contributes zero subtests and zero skips, so the memory-mode merge gate
stays green and needs no services. `pg` is dynamic-imported on the pg path only, so
memory mode still needs no `npm install`.

Two design notes worth knowing before editing them:

1. **`rls.test.js` reads as `dozr_app`** and asserts that role is neither SUPERUSER nor
   BYPASSRLS. Without that guard, a mis-pointed `APP_DATABASE_URL` (aimed at the owner)
   would bypass RLS and make every isolation assertion pass vacuously.
2. **`immutability.test.js` mutates as the OWNER**, not as `dozr_app`. The restricted
   role has no privileges on `raw_frames`, so its UPDATE would fail on permissions —
   which would pass `assert.rejects` even with the trigger dropped. Testing as the owner
   proves the *trigger* stops even the most privileged connection, and the assertions
   match `/append-only/` so it is provably the trigger raising.

### Executed on this machine

Docker Desktop 4.88.1, `postgres:16` → **PostgreSQL 16.15**, Windows/Node v24.13.0:

```
npm run db:up                → dozr_telematics_db healthy in 1s
npm run db:reset             → ✔ db/schema.sql  ✔ db/seed.sql
npm test                     → 85/85 pass, 0 fail, 0 skipped   (memory)
DB=pg npm test               → 91/91 pass, 0 fail, 0 skipped   (real Postgres)
npm run test:gate            → gate: store=memory pass=85 floor=85  GATE PASSED
DB=pg npm run test:gate      → gate: store=pg     pass=91 floor=85  GATE PASSED
DB=pg npm run demo           → byte-identical to memory-mode demo output (diff clean)
```

The demo comparison is a literal `diff` of both runs' ACK/positions/engine-hours lines,
not an eyeball: ACK 20 / 5 / 0-new, Tenant A 20 positions + 1.0000 h `source=ecu`,
Tenant B 5 positions and no engine hours, missing `X-Tenant-Id` → HTTP 400.

**One real bug found by running it.** `test:config`'s "the whole slice has working
defaults with no `.env`" asserted `config.db === 'memory'` against the *ambient*
environment, so it failed under `DB=pg` — the test meant to prove zero-setup works was
broken by the environment it was run in. It now loads `config.js` in a child process
with every documented env var stripped, which is the claim it was always trying to
make. Passes in both modes.

**Re-verified 2026-09-04** (same Docker/`postgres:16` setup, after the 2026-09-04
review fixes added `position_valid` / `external_voltage_mv` / `battery_pct` / `unplug`
to `position_records`): `npm run db:reset` clean, `DB=pg npm run test:gate` →
**196/196, floor 190, GATE PASSED**, `DB=pg npm run demo` green. The four new columns
were round-tripped through the pg adapter's write + tenant-scoped read to confirm an
absent signal stays `NULL` rather than becoming `0` (invariant 3).

---

## Acceptance criteria per phase (the gates)

Copied from `BUILD_PLAN.md` so QA has them in one place. A phase is not done until its
gate is green.

| Phase | Testing gate |
|-------|--------------|
| **P0 Harden** | ✅ **MET.** `npm run test:gate` green (no skips, floor enforced) on a clean checkout that is not the build machine + `npm run demo` shows ACK counts 20 / 5 / 0-new + `npm run verify` green (14/14 on Linux/macOS: both servers spawn, replay a scenario over TCP, SIGTERM drains and exits 0). Enforced **in CI** since the repo went live — see below. |
| **P1 Postgres** | ✅ **MET.** `DB=pg npm test` 91/91 + `test:rls` (RLS cross-tenant block, 4 tests) + `test:immutability` (`raw_frames` trigger, 4 tests) + `DB=pg npm run demo` byte-identical to memory output. Both DB-layer suites verified by dropping the policy/trigger and watching them fail. |
| **P2 Ledger + D1** | 🟡 D1 resolved at the parameter level (AVL 102, minutes — `test:engine-hours`, 14 tests) and the decode-side refusal of ignition-derived values is proven. Still open: `test:ledger` (exact utilisation from ECU-only on the seed scenario), evidence-tamper detection, and per-machine hardware verification. |
| **P3 Rules + Messaging** | `test:rules` green (each event type on a crafted scenario) + WhatsApp integration test against a Meta sandbox + alert de-duplication test. |
| **P4 AWS + pilot** | End-to-end acceptance with real hardware (or a production-rate simulator soak): zero lost/duplicated records across an instance restart, correct attribution, reproducible dispute pack. |

---

## CI (P0)

The workflow exists: **`.github/workflows/telematics-tests.yml`**. It runs on push
and pull request, on a **Node 20 and 22 matrix**, in memory mode — no services, no
install, no secrets, which is the whole point of the two-adapter design. Steps:

1. `npm run test:gate` — the suite plus count/skip enforcement.
2. `npm run demo` — the end-to-end proof.
3. Start `start:ingest` as its own process, wait for the port (no blind sleep),
   replay the `handover` scenario against it, then `kill -TERM` and require exit 0.

A second, **opt-in** job brings up a `postgres:16` service and runs the same gate
under `DB=pg`. It is `continue-on-error` and triggers only on `workflow_dispatch`
or a `[pg]` commit message, because Postgres mode is the **P1** gate and must not
block a P0 merge.

### The gate is live in CI

`gps-build` is now its own repository — **github.com/afsalali1238/simulator** — which is
what the workflow's path assumed and what `README.md` always intended ("can be zipped
and handed to a development team as-is"). So the file sits at the repository root's
`.github/workflows/`, the only place GitHub Actions reads from, and the gate actually
gates.

Two runs, both green, both on GitHub's runners rather than this machine — which is
exactly what the P0 gate asks for ("a clean checkout that is not the build machine"):

| Commit | What | Node 20 | Node 22 |
|---|---|---|---|
| `bb0f4f2` | P0 hardening | ✅ | ✅ |
| `ac7ac9a` | D1 mapping | ✅ | ✅ |

Every step passed in both: the test gate, the demo, and the live-server replay ending
in a `kill -TERM` that must exit 0. The `postgres` job shows as `skipped`, which is
correct — it is opt-in via `workflow_dispatch` or a `[pg]` commit message so the P1
gate cannot block a P0 merge.

P1 was instead run locally against real Docker Postgres; see "Executed on this machine"
above. Running it in CI too is a `[pg]` commit away.

---

## P0 evidence — what was actually executed

Recorded because the P0 gate says "on a machine that is not this one", and because
a claim in a testing doc is worth nothing without the run behind it. Everything
below is real tool output, not a description of expected output.

**Windows (Node v24.13.0), `gps-build/telematics/`:**

```
npm test          →  tests 68  pass 68  fail 0  skipped 0  todo 0
npm run test:gate →  gate: store=memory pass=68 fail=0 skipped=0 todo=0 floor=68
                     GATE PASSED
npm run demo      →  ACK=20 / ACK=5 / resend ACK=5, stored 0 new
                     Tenant A: 20 positions, 1.0056 h source=ecu
                     Tenant B: 5 positions, engine hours: none
                     no X-Tenant-Id → HTTP 400
npm run verify    →  10/10 checks passed (4 signal checks skipped: Windows)
```

**Linux (Node v18.19.1, WSL2 Ubuntu 24.04) — a genuinely different machine and a
*lower* Node than the slice was built on:**

```
npm test          →  tests 68  pass 68  fail 0  skipped 0  todo 0
npm run test:gate →  GATE PASSED (floor=68)
npm run demo      →  Demo complete, same ACK pattern
npm run verify    →  14/14 checks passed
                     · api exited 0 on SIGTERM
                     · ingestion exited 0 on SIGTERM
                     · shutdown_started → shutdown_complete
                     · the drain was not forced by the deadline
                     · the ingestion port is released
```

The gate was also confirmed to **fail** when it should:
`MIN_TESTS=99 npm run test:gate` → exit 1, "only 68 tests passed, expected at
least 99". A gate that has never failed is not known to work.

Two bugs were found by running this rather than by reading it, both now fixed:

1. **`npm run start:ingest` and `start:api` silently did nothing on Windows.** The
   direct-run guard used `import.meta.url === \`file://${process.argv[1]}\``, which
   never matches on Windows (`C:\...` vs `file:///C:/...`). Both scripts exited 0
   without ever binding a port. Replaced with `isEntrypoint()` in
   `src/lifecycle/shutdown.js`.
2. **The drain deadlock / stranded-promise pair.** `server.close(cb)` only calls
   back once every connection has closed, so awaiting it *before* draining hung
   whenever a device was connected — which is precisely when a drain matters. And
   the `unref()`ed deadline timers let the event loop empty with a drain still
   pending, which stranded the caller's promise on Node 18 (6 tests cancelled).
   Both orderings corrected; the tests that caught it are in `test:operability`.

**Executed under `DB=pg`, and claimed.** Docker Desktop 4.88.1 + `postgres:16`
(PostgreSQL 16.15) now run on this machine: 91/91 under `DB=pg`, the gate green in
both modes, and the pg demo byte-identical to memory. See "Testing against real
Postgres" above for the full transcript and the two negative tests.

---

## Definition of done (any change in this folder)

A change is done when **all** of these hold:

1. `npm run test:gate` is green (**85/85** in memory mode today, **91/91** under
   `DB=pg`; more as modules land) — no skipped tests, and the floor in
   `src/tools/test-gate.js` was raised if you added tests. The floor tracks the
   **memory** count, because that is what CI gates on.
2. No invariant lost its test. If you touched decode, store, ingestion, or attribution,
   the relevant invariant test still fails when you deliberately break the behaviour.
3. New behaviour has a test in the matching suite, and (if it touches an invariant) a
   row in the invariant→test map above.
4. `npm run demo` still completes with the expected proof summary.
5. Anything touching **billing or tenancy** was reviewed by a human, not just
   generated — per the guardrails in `CLAUDE.md`.
