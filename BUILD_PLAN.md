# Build Plan — from working slice to production

The path from what exists today (a tested `telematics/` slice running in memory mode)
to a production GPS/telematics platform on AWS, billing real customers from real
device data.

Five phases, **P0 → P4**. Each has a goal, work items, an **owner**, explicit
**done-criteria**, and a **testing gate** that must be green before the next phase
starts. The gate is the point of this document: no phase is "done" because the code
was written — it's done when its gate passes.

Task-level checkboxes live in `TASKS.md`. Agent ownership is defined in `AGENTS.md`.

---

## Guiding decisions (from the expert build review)

These come from `context/reviews/Dozr_GPS_IoT_Expert_Build_Review.html` (30 Aug 2026)
and shape the plan:

- **Lean team.** The system needs ~**2 engineers + a coordinator**, not the larger
  team originally proposed. This plan assumes a hybrid: **Claude + one backend
  engineer**, with a human owning anything that touches billing.
- **Buy/borrow the first ~6 weeks.** Don't build bespoke infrastructure for the
  device pilot. **Traccar** is the recommended off-the-shelf ingestion option to get
  real devices reporting fast; our hand-written parser stays the reference impl and
  test harness.
- **D1 is the critical path.** Real engine hours (the CAN mapping) block real billing
  data. Resolving D1 is scheduled as early as it can be (P2) and started in parallel
  from day one.
- **Don't hand the whole thing to an external dev team.** Keep it in-house/hybrid;
  the invariants are too easy to break for a black-box handoff.

---

## Status today

✅ **P0 code complete; its gate passes locally on two platforms.** **68 tests pass**
(37 → 68), `npm run demo` proves invariants 1, 2, 6, 7, 9 on live data, and
`npm run verify` proves the operability claims on real processes with real signals
(14/14 on Linux). Verified on Windows/Node 24 **and** WSL2 Linux/Node 18 — a
different machine and a lower Node than the slice was built on.

P0 added: the simulator scenario engine (6 named scenarios, deterministic —
`handover` and `yard-idle` are the ones that prove invariants 6 and 9 **end-to-end
over real TCP**), structured logging with secret redaction, an LB-shaped `/health`,
graceful SIGTERM drains that cannot cut between commit and ACK, a count- and
skip-proof merge gate, and `docs/RUNBOOKS.md`.

Modules 0–4, 6, 9 implemented; 5, 7 remain throwing stubs; 8 is specified. The pg
adapter is still **code-complete but not executed** — no Docker or PostgreSQL on
this machine.

⚠ **One P0 item is blocked on a human decision, not on code:** `gps-build/` is not
tracked by git, so the CI workflow has never run and the phase gates remain
honour-system. See `TASKS.md` P0 and `TESTING.md` § CI.

---

## Phase P0 — Harden the slice  ✅ code complete (CI blocked on a git decision)

**Goal:** make what already exists production-grade and CI-gated, so every later
change is protected. No new features.

**Owner:** `qa-test-engineer` (lead), `integration-engineer`

**Work items**

- ✅ **CI** — `.github/workflows/telematics-tests.yml`: Node 20 + 22 matrix, memory
  mode, `test:gate` → `demo` → a live scenario replay ending in a SIGTERM
  exit-code check. The gate is `npm run test:gate`, not a bare `npm test`: it also
  fails if the passing-test count drops below the floor or if anything is skipped
  or todo, because the quiet failure mode here is a *deleted* test, not a red one.
- ✅ **Config hygiene** — `.env.example` documents every var the code reads, and
  `test:config` **enforces** it: the suite fails on an undocumented var, a fossil
  var, a real-looking password, or `.env` not being git-ignored.
- ✅ **Structured logging** — `src/logging/logger.js`: one JSON (or `kv`) line per
  event with `ts`/`level`/`module`/`event`, secret fields and credential URIs
  redacted, tenant payloads never logged, `/health` probes not logged at all.
- ✅ **LB-shaped `/health`** — 200 `ready`, 503 `draining`, 503 `unavailable`, and
  **zero store I/O on the probe path** (a probe must not become load on the
  database). Asserted by a trip-wire test that counts store calls.
- ✅ **Graceful shutdown** — `src/lifecycle/shutdown.js`: one drain per process,
  bounded by `SHUTDOWN_TIMEOUT_MS`, exit 0. The ingestion drain finishes an
  in-flight packet's write **and** its ACK before closing, which is what keeps
  invariant 1 true across a rolling deploy or an NLB target drain.
- ✅ **Run-books** — `telematics/docs/RUNBOOKS.md`: first run, replaying a
  scenario, running the pieces separately, reading the logs, interpreting
  `/health`, graceful restart, the gate, and troubleshooting. Every command in it
  was executed.
- ✅ **Simulator → scenario engine** (Module 9) — `phases.js` (behaviour vocabulary
  + seeded PRNG) and a named registry in `scenarios.js`: `day-cycle`, `handover`,
  `yard-idle`, `after-hours`, `geofence-cross`, `tamper`. Deterministic by
  construction, aligned with the seed fixtures, and honest about absence (a signal
  with no reading is omitted, never sent as `0`).

**Done-criteria:** met, except CI actually running. 68 tests green from a clean
checkout on a second machine; a new engineer can go from clone to `npm run demo`
with no install and no `.env`; no secret material in the repo.

**Testing gate:** ✅ locally — `npm run test:gate` 68/68 with no skips, `npm run
demo` showing ACK 20 / 5 / 0-new, and `npm run verify` 14/14, on **WSL2 Linux with
Node 18** as well as Windows with Node 24. ⚠ **Not yet green *in CI*.**

> **The one thing still open, and it needs you, not code.** `gps-build/` is
> **untracked in git** — `git ls-files gps-build` returns nothing. No commit means
> no push means the workflow has never run, so every gate in this document is
> currently an honour-system checkbox. Also, GitHub only reads workflows from
> `.github/workflows/` at a **repository root**; the file is at
> `gps-build/.github/workflows/`, which is right if gps-build becomes its own repo
> (what `README.md` intends) and wrong if it stays a subfolder — in which case move
> it up and keep `working-directory: gps-build/telematics`.
>
> **Two things found by running the code rather than reading it**, both fixed:
> `npm run start:ingest` and `start:api` silently exited 0 without binding on
> Windows (the `import.meta.url === \`file://${process.argv[1]}\`` idiom never
> matches there — now `isEntrypoint()`); and the drain awaited `server.close()`'s
> callback before draining, which deadlocks precisely when a device is connected.

---

## Phase P1 — Real PostgreSQL (prove the invariants in the database)

**Goal:** run the `pg` adapter for real and confirm the invariants are enforced by
**the database itself** — row-level security for tenancy, the trigger for evidence
immutability, unique keys for idempotency — not just by application code.

**Owner:** `database-engineer`

**Work items**

- `npm install` (pulls `pg`), `npm run db:up` (Docker Postgres 16), `npm run db:reset`
  (apply `db/schema.sql` + `db/seed.sql`).
- Run the suite under `DB=pg`, especially `test:tenancy` and `test:ingestion` — the
  two that actually exercise RLS and the immutability trigger.
- Add a test that **proves RLS blocks cross-tenant reads** at the DB layer (not just
  app layer) and that **UPDATE/DELETE on `raw_frames` is rejected** by the trigger.
- Confirm `DB=pg npm run demo` produces byte-identical results to memory mode.
- Decide the time-series path: plain Postgres now; note the TimescaleDB hypertable
  migration for P4 (interface unchanged).

**Done-criteria:** every test that passes in memory mode also passes under `DB=pg`;
RLS and the immutability trigger are demonstrably doing the enforcement (a test fails
if you remove the policy/trigger).

**Testing gate:** `DB=pg npm test` green + the two new DB-layer enforcement tests
green + `DB=pg npm run demo` matches memory-mode output.

---

## Phase P2 — Resolve D1, build the ledger + evidence (the money path)

**Goal:** turn sealed ECU engine readings into **billable utilisation** with a
tamper-evident dispute pack. This is the phase that unlocks revenue, and the one
that must be owned by a human.

**Owner:** `ledger-owner` (human-led) with `protocol-engineer` (for D1)

**Work items**

- **Resolve D1 (critical path, start immediately, in parallel with P0/P1):** for each
  machine make/model/year we'll deploy on, identify the CAN adapter **program** and
  the real IO ID(s) carrying engine hours. Source: `context/teltonika/` +
  Teltonika/CAN adapter documentation. Map them in the decoder; the decoder's
  contract does **not** change (engine hours only for CAN assets, always
  `source: 'ecu'`).
- Replace the simulated IO-ID-200 stand-in with the real per-program mapping. Keep
  the simulator able to emit the real IDs so tests stay meaningful.
- Build **Module 5 (ledger)** for real: compute utilisation per asset per period from
  **ECU readings only** (invariant 5 — ignition counters are never billing evidence).
- Build the **evidence seal**: each billed period sealed into an immutable,
  tamper-evident record able to reproduce a dispute pack from the sealed raw frames
  (invariant 8).
- Human review of the billing math before it can produce a real number.

**Done-criteria:** ledger produces a correct utilisation figure for the seeded
scenario using only ECU readings; a dispute pack can be reproduced from sealed frames
and verified; D1 mapping documented per program; no estimated/ignition value can
reach an invoice.

**Testing gate:** new `test:ledger` green (utilisation from ECU-only, exact figures
on the seed scenario) + an evidence-tamper test (mutating a sealed frame is detected/
rejected) + a test asserting ignition-derived values are refused as billing evidence.

---

## Phase P3 — Rules & event detection + WhatsApp messaging

**Goal:** detect the events that matter and deliver them on the WhatsApp-native spine.

**Owner:** `integration-engineer`

**Work items**

- Build **Module 8 (rules)**: geofence enter/exit, ignition outside working hours,
  idle-too-long, tamper/unplug, low battery — consuming enriched telemetry from
  Module 4. Grow Module 4 (enrichment) as needed for trips/geofence membership.
- Build **Module 7 (messaging)** against the **WhatsApp Cloud API** with live Meta
  credentials and Meta-approved templates (the reason it was stubbed). Same spine the
  Marketplace uses.
- Wire rules → messaging with idempotent event delivery (don't double-send on retry).

**Done-criteria:** each rule fires correctly on simulated scenarios; messaging sends
a real templated WhatsApp message in a test environment; no duplicate alerts on retry.

**Testing gate:** `test:rules` green (each event type on a crafted scenario) +
messaging integration test against a Meta sandbox/number + a de-duplication test.

---

## Phase P4 — Deploy to AWS + real-device pilot

**Goal:** run the system in production and prove it with real Teltonika hardware.

**Owner:** `database-engineer` + `integration-engineer` (coordinator oversees)

**Work items**

- **RDS for PostgreSQL:** point `DATABASE_URL` at RDS; apply schema + RLS + triggers.
  If time-series volume warrants, switch to **TimescaleDB** + hypertable migration
  (store interface unchanged).
- **Ingestion:** deploy the Node server on **ECS/Fargate**, ×N instances, behind a
  **TCP Network Load Balancer**. ACK-after-durable-write + idempotency make
  reconnect-to-any-instance safe.
- **Read API + ledger + rules/messaging** deployed as their own services; ledger runs
  as a scheduled job.
- **Real-device pilot:** point a physical FMC130/FMC920 at the ingestion NLB. Because
  the simulator already speaks the genuine protocol, **no server change is needed.**
  Per the expert review, **Traccar** can run alongside as the fast off-the-shelf
  ingestion option to de-risk the first weeks.
- Observability: dashboards for ingestion rate, ACK latency, write failures, per-tenant
  volume.

**Done-criteria:** a real device reports into the deployed stack and its data appears,
correctly tenant-attributed, in the dashboard; failover works (kill an instance, the
device reconnects and no data is lost or double-counted); billing runs on real ECU data.

**Testing gate:** an end-to-end acceptance run with real hardware (or a soak test with
the simulator at production-like rate) showing zero lost/duplicated records across an
instance restart, correct attribution, and a reproducible dispute pack.

---

## Dependency order at a glance

```
P0 Harden ──▶ P1 Postgres ──▶ P2 D1 + Ledger + Evidence ──▶ P3 Rules + Messaging ──▶ P4 AWS + pilot
   │                                  ▲
   └── D1 investigation starts here ──┘  (runs in parallel; it is the critical path)
```

P0 and P1 can overlap. **D1 investigation should start on day one** regardless of
which phase is active — it is the longest-lead item and everything about real billing
data waits on it.

---

## What "done" means for the whole build

The platform is production-done when: real devices report through a load-balanced,
failover-safe ingestion tier into Postgres with RLS and sealed evidence; utilisation
billing runs on real ECU engine hours with a reproducible dispute pack; events reach
customers over WhatsApp; and every one of the nine invariants is still enforced by a
passing test. Nothing in this plan relaxes an invariant — they are the definition of
correct.
