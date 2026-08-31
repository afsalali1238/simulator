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

npm test                 # everything, serially — 68 tests today
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
  `src/tools/test-gate.js`, currently **68**), or
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

## The test suites (68 tests today)

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

---

## Invariant → test map

This is the table that matters. Every invariant that can be exercised in the current
slice has at least one test that fails if the invariant is violated. The two that
depend on not-yet-built modules (5) or on the database layer (8's trigger) have their
**full** enforcement test scheduled in a named build phase — called out honestly below.

| # | Invariant | Proven by | Status |
|---|-----------|-----------|--------|
| 1 | **ACK only after durable write** | `test:ingestion` (`FAIL_BEFORE_COMMIT` → no ACK, nothing persisted, recovery) · `test:store` (fail-before-commit leaves store unchanged) · `test:operability` (a graceful drain finishes the in-flight write **and** its ACK; a device arriving mid-drain is refused) · `verify` (SIGTERM on a real process exits 0 without a forced drain) | ✅ proven now |
| 2 | **Idempotent ingest** | `test:store` (resend doesn't double-count) · `test:ingestion` (idempotent resend over TCP) · `test:replay` (a replayed scenario track re-sent over TCP adds nothing) | ✅ proven now |
| 3 | **NULL ≠ zero** | `test:decode` (absent IO → `null`; present-zero stays `false`) · `test:scenarios` (`yard-idle` omits the engine IO entirely; `tamper` reports ignition `null`, not `false`, and state `unknown`) | ✅ proven now |
| 4 | **ecu vs estimated never merge** | `test:decode` (engine hours only produced for CAN assets, always tagged `source: 'ecu'`) · `test:replay` (the only readings that reach the API are `source: 'ecu'`) | ✅ proven now |
| 5 | **Ignition counters never billing evidence** | Enforced by design today (no code path turns ignition into billing). Full test = `test:ledger` | 🔒 gated to **P2** (ledger built) |
| 6 | **Attribution at each record's own timestamp** | `test:tenancy` (D1 splits between Tenant A and B by timestamp) · `test:decode` (attribution fallback) · `test:scenarios` (the `handover` scenario emits either side of `2025-06-01T00:00:00Z` and resolves to two different tenants) · `test:replay` (**end-to-end over TCP**: every record each tenant can see is on its own side of the boundary) | ✅ proven now, end-to-end |
| 7 | **Tenancy always** | `test:store` (tenant-scoped reads) · `test:tenancy` · `test:api` (400 without header, isolated positions) · `test:replay` (the two tenants' record sets are disjoint; an unassigned device falls back to its owner) · `test:operability` (no tenant id ever reaches a log line) | ✅ proven now (app layer); DB-layer RLS proven in **P1** |
| 8 | **Sealed, immutable evidence chain** | `test:store` (raw frame persisted as evidence) · `test:replay` (a de-duplicated resend still seals its own frame) . Trigger-enforced immutability = a DB-layer test | ✅ evidence written now; 🔒 trigger enforcement gated to **P1** (pg mode) |
| 9 | **Unlisted machine ⇒ position + ignition only** | `test:tenancy` (unassigned D2 → no engine hours) · `test:decode` (no CAN ⇒ no engine hours) · `test:scenarios` + `test:replay` (**the trap**: after the handover the device keeps sending IO 200, and the system still produces no engine data for Generator Y) | ✅ proven now, end-to-end |

**Honest reading of this table:** seven invariants (1, 2, 3, 4, 6, 7, 9) are fully
proven today in memory mode. Invariant 7's *database-level* enforcement (RLS) and
invariant 8's *trigger-level* immutability are code-complete but only execute under
`DB=pg` — proving them is the **P1 testing gate**. Invariant 5's live test needs the
ledger, which is **P2** by design (the ledger is a throwing stub until a human builds
it). Nothing is hand-waved: the gaps are named and scheduled in `BUILD_PLAN.md`.

**What P0 changed here.** Invariants 6 and 9 were previously proven by *unit*
tests calling `resolveAssignment` and `normalizeRecord` directly. They are now
also proven **end-to-end**: the `handover` scenario puts genuine Codec 8E bytes on
a real socket from one IMEI across the handover instant, and `test:replay` asserts
the split lands on the right tenants at the API. Invariant 1 gained a
shutdown-shaped proof — a drain must never cut between commit and ACK — which is
the failure mode a rolling deploy or an NLB target drain would otherwise expose.

---

## Testing against real Postgres (P1 gate)

Memory mode models the invariants at the application layer. Postgres mode proves the
schema itself enforces them.

```bash
cd telematics
npm install                       # pulls `pg` (the only dependency)
npm run db:up                     # docker compose: postgres:16
npm run db:reset                  # apply db/schema.sql then db/seed.sql
DB=pg APP_DATABASE_URL=postgres://dozr_app:dozr_app@localhost:5432/dozr_telematics npm run test:tenancy
DB=pg npm run test:ingestion
DB=pg npm run demo                # should match memory-mode output exactly
npm run db:down
```

`test:tenancy` and `test:ingestion` are the two worth re-running under `DB=pg` —
that's where **row-level security** and the **evidence-immutability trigger** do the
work instead of the application. The P1 gate adds two explicit DB-layer tests:

1. **RLS blocks cross-tenant reads** — a query as Tenant A cannot see Tenant B's rows,
   proven to fail if the RLS policy is removed.
2. **`raw_frames` is append-only** — an UPDATE or DELETE against a sealed frame is
   rejected by the trigger, proven to fail if the trigger is removed.

> ⚠️ Postgres mode was **not** executed in the build sandbox (no Docker, npm registry
> blocked). The pg adapter, `db/schema.sql` (RLS + trigger), `db/seed.sql`, and
> `docker-compose.yml` are code-complete and pass `node --check`, but running them on
> a real machine is the first task of P1.

---

## Acceptance criteria per phase (the gates)

Copied from `BUILD_PLAN.md` so QA has them in one place. A phase is not done until its
gate is green.

| Phase | Testing gate |
|-------|--------------|
| **P0 Harden** | `npm run test:gate` green (**68/68**, no skips, floor enforced) on a clean checkout that is not the build machine + `npm run demo` shows ACK counts 20 / 5 / 0-new + `npm run verify` green (14/14 on Linux/macOS: both servers spawn, replay a scenario over TCP, SIGTERM drains and exits 0). |
| **P1 Postgres** | `DB=pg npm test` green + RLS cross-tenant-block test + `raw_frames` immutability-trigger test + `DB=pg npm run demo` matches memory output. |
| **P2 Ledger + D1** | `test:ledger` green (exact utilisation from ECU-only on the seed scenario) + evidence-tamper detection test + a test refusing ignition-derived values as billing evidence. |
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

> ### ⚠ The workflow is not enforcing anything yet
>
> Two things are still true and neither is fixable from inside this folder:
>
> 1. **`gps-build/` is not tracked by git.** `git ls-files gps-build` returns
>    nothing; the parent Kasper repo lists it as untracked. There is no commit, so
>    there is no push, so the workflow has never run.
> 2. **GitHub Actions only reads `.github/workflows/` at the repository root.**
>    This file sits at `gps-build/.github/workflows/`, which is correct if
>    gps-build becomes its own repo (as `README.md` intends — "can be zipped and
>    handed to a development team as-is"). If it is instead committed as a
>    subfolder, the file must move to the parent repo's root and keep
>    `working-directory: gps-build/telematics`.
>
> Until one of those is resolved, every gate in `BUILD_PLAN.md` is an honour-system
> checkbox. The gate script itself is real and runs locally — see the P0 evidence
> below.

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

**Not executed, and not claimed:** anything under `DB=pg`. There is no Docker and
no PostgreSQL on this machine (`docker: command not found`). That is the P1 gate,
unchanged.

---

## Definition of done (any change in this folder)

A change is done when **all** of these hold:

1. `npm run test:gate` is green (**68/68** today; more as modules land) — no
   skipped tests, and the floor in `src/tools/test-gate.js` was raised if you
   added tests.
2. No invariant lost its test. If you touched decode, store, ingestion, or attribution,
   the relevant invariant test still fails when you deliberately break the behaviour.
3. New behaviour has a test in the matching suite, and (if it touches an invariant) a
   row in the invariant→test map above.
4. `npm run demo` still completes with the expected proof summary.
5. Anything touching **billing or tenancy** was reviewed by a human, not just
   generated — per the guardrails in `CLAUDE.md`.
