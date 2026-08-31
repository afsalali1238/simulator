# CLAUDE.md — operating rules for the GPS build folder

Read this before doing anything in `gps-build/`. It governs the whole folder. The
code inside `telematics/` also has its own `telematics/CLAUDE.md` with build/test
specifics — when you work in there, **both apply**.

---

## What this folder is

The self-contained development folder for the Kasper GPS/telematics platform: a tested
code slice (`telematics/`), all reference docs (`context/`), and the governance to
build it out (this file, `ARCHITECTURE.md`, `BUILD_PLAN.md`, `TESTING.md`, `TASKS.md`,
`AGENTS.md`, `.claude/agents/`). Full orientation is in `README.md`.

## Scope — hard boundary

**GPS/telematics only.** Nothing here touches the Kasper Marketplace, Vendor OS, or any
other product. If a change seems to reach outside `gps-build/`, **stop and ask.** The
`telematics/` code additionally stays in its **one folder** — new modules go under
`telematics/src/<module>/`, never scattered elsewhere.

## The nine correctness invariants (non-negotiable)

These are the reason the code is shaped the way it is. They are enforced by tests
(`TESTING.md`) and are the source of truth in `context/invariants/Dozr_GPS_CLAUDE.md`.
**Never design around them or "simplify" past them.**

1. **ACK only after a durable write.**
2. **Idempotent ingest** — a resent packet never double-counts.
3. **NULL ≠ zero** — an absent IO is `null`, never `0`.
4. **ecu vs estimated never merge** — CAN engine hours are always `source: 'ecu'`.
5. **Ignition counters are never billing evidence** — only sealed ECU readings bill.
6. **Attribution at each record's own timestamp** — never "as of now".
7. **Tenancy always** — every read is tenant-scoped (app-level in memory, RLS in pg).
8. **Sealed, immutable evidence chain** — raw frames are append-only.
9. **Unlisted machine ⇒ position + ignition only** — no CAN program ⇒ no engine hours.

If code and `context/invariants/Dozr_GPS_CLAUDE.md` ever disagree, **the doc wins and
the code is a bug.**

## Guardrails

- **Two modules are throwing stubs on purpose.** The **ledger** (`src/ledger/`,
  Module 5) and **messaging** (`src/messaging/`, Module 7) throw if called. Do **not**
  wire them into anything or "finish" them speculatively. The ledger is built by a
  **human** in phase P2 (a wrong number there is a wrong invoice); messaging needs
  live Meta credentials + approved templates in P3. See `BUILD_PLAN.md`.
- **Anything touching billing or tenancy is human-reviewed**, not just generated.
- **Don't relax an invariant to make a test pass.** Fix the code, or if the invariant
  is genuinely wrong, raise it with the human owner and update the invariants doc first.
- **D1 (CAN engine-hours mapping) is simulated until decided.** Engine hours under IO
  ID 200 are a stand-in. Don't treat simulated engine hours as real billing data.
- **No new dependencies without a reason.** The design is deliberately near-zero-dep
  (`pg` only). No build step, no linter framework — plain Node ESM. Don't invent one.
- **Kasper-named docs in `context/` are historical, not wrong.** Don't rename or
  rewrite them without asking. `context/README.md` explains the naming.

## Commands (all from inside `telematics/`)

```bash
npm run demo            # full pipeline end-to-end with a proof summary (zero setup)
npm test                # all tests, serially (68 today)
npm run test:gate       # THE MERGE GATE — adds count + no-skip enforcement
npm run verify          # spawn real servers, replay a scenario, SIGTERM them
npm run test:crc | test:codec | test:store | test:decode | test:tenancy | test:ingestion | test:api
npm run test:scenarios | test:replay | test:operability | test:config
npm run start:ingest    # TCP ingestion server
npm run start:api       # HTTP read API
npm run sim:list        # named scenarios + what each proves
npm run sim -- --scenario handover     # replay the D1 handover story
# Postgres mode (needs Docker + npm install) — phase P1:
npm install && npm run db:up && npm run db:reset && DB=pg npm test && npm run db:down
```

Requires **Node ≥ 20** (built on 22; also verified on 18 and 24). Memory mode needs
no install and no Docker.

**`npm test` is for humans; `npm run test:gate` is the gate.** It also fails if the
passing-test count drops below the floor in `telematics/src/tools/test-gate.js`, or
if anything is skipped or marked todo. Deleting a test would otherwise silently
retire an invariant's proof and nothing would go red. Raise the floor in the same
commit when you add tests.

Operating procedures — reading the structured logs, what each `/health` state means,
how to restart without dropping data, troubleshooting — are in
`telematics/docs/RUNBOOKS.md`.

## How work is organised

- **`ARCHITECTURE.md`** — the system: modules, data model, data flow, AWS target.
- **`BUILD_PLAN.md`** — phased path to production (P0→P4), each with a testing gate.
- **`TESTING.md`** — test strategy + the invariant→test map + definition of done.
- **`TASKS.md`** — the live task board. Claim an unblocked task, mark it in-progress,
  do it, mark it done. Don't start a task whose dependencies aren't met.
- **`AGENTS.md`** — which specialist owns which module/phase.
- **`.claude/agents/`** — the specialist briefs. If a task matches your brief, follow
  the files-owned / invariants-guarded / done-criteria in it.

## Definition of done (every change)

`npm test` green with no skips · no invariant lost its test · new behaviour has a test ·
`npm run demo` still passes · billing/tenancy changes were human-reviewed. Full version
in `TESTING.md`.

## Path note

If you're an agent running with shell access, the user's paths map to a Linux mount —
never expose raw `/sessions/...` paths back to the user; refer to files by their
in-folder path (e.g. `telematics/src/...`).
