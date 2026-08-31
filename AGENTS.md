# AGENTS.md — team roster & ownership

Who owns what in the GPS/telematics build, and how a contributor (human or AI agent)
picks up work. The full brief for each agent — scope, files owned, invariants guarded,
done-criteria — is in `.claude/agents/<name>.md`. This file is the map; those files
are the detail.

---

## The roster

| Agent | Owns (modules) | Guards invariants | Leads phases |
|-------|----------------|-------------------|--------------|
| **protocol-engineer** | 0 Protocol (Codec 8/8E, CRC) | 3 (NULL≠zero at decode boundary) | P2 (D1 CAN mapping) |
| **ingestion-engineer** | 1 Ingestion (TCP server) | 1 (ACK-after-write), 2 (idempotent) | P0, P4 (scale) |
| **database-engineer** | 3 Store & tenancy, `db/` | 2, 7 (tenancy/RLS), 8 (immutability) | P1, P4 (RDS) |
| **api-engineer** | 6 Read API | 7 (tenant-scoped reads) | P0 |
| **ledger-owner** *(human-led)* | 5 Ledger & evidence | 4, 5 (billing evidence), 8 | P2 |
| **integration-engineer** | 4 Enrichment, 7 Messaging, 8 Rules, 9 Simulator | 6 (attribution end-to-end) | P3, P4 (deploy) |
| **qa-test-engineer** | the test suite, CI, the gates | **all nine** (owns the invariant→test map) | every phase gate |

**Coordinator** (human): sequences phases, resolves cross-agent decisions, signs off
each phase gate. Per the expert review, the whole build is meant to run lean —
roughly **2 engineers + a coordinator**, with a human owning anything that bills.

---

## Ownership, in words

- **protocol-engineer** owns the bytes. The Teltonika wire format is a pure codec with
  no I/O, so it's the most testable thing in the repo — keep it that way. Owns
  resolving **D1** (which CAN program / IO ID carries real engine hours per machine),
  the single longest-lead decision in the build.
- **ingestion-engineer** owns the front door: the TCP server, the handshake, reframing
  the byte stream, and the rule that makes everything else safe — **ACK only after a
  durable write**. Owns the ingestion tier's behaviour at scale (NLB, N instances).
- **database-engineer** owns the store interface and both adapters, the schema, and —
  critically — proving that **RLS and the immutability trigger** enforce tenancy and
  evidence-sealing in Postgres, not just in application code. Owns RDS in P4.
- **api-engineer** owns the read surfaces the dashboards call. Small, zero-framework,
  and every data endpoint tenant-scoped with a mandatory `X-Tenant-Id`.
- **ledger-owner** is **human-led by design.** Owns the utilisation ledger and the
  evidence seal. Its failure mode is a silently wrong invoice, so it is built and
  reviewed by a person and consumes **only** sealed ECU readings.
- **integration-engineer** owns the pieces that connect the system to the outside
  world and to itself: enrichment (state/trips/geofences), the rules engine, WhatsApp
  messaging, the simulator, and the AWS deployment glue.
- **qa-test-engineer** owns correctness as a whole. Keeps the **invariant→test map**
  in `TESTING.md` honest, runs the phase gates, and blocks a merge that drops a test
  or relaxes an invariant.

---

## How to claim and do a task

1. **Open `TASKS.md`.** Find a task that is unchecked and whose dependencies (the
   phase before it, or a named blocker) are met. Work phases in order — don't start
   P2 work while the P1 gate is red.
2. **Check ownership.** The task names an owner agent; confirm it matches your brief
   in `.claude/agents/`. If you're an AI agent, load that brief and follow its
   files-owned / invariants-guarded / done-criteria.
3. **Mark it in-progress** in `TASKS.md` (put your name/agent next to it).
4. **Do the work inside the boundary.** Stay in the files your brief owns. If you need
   a change in another agent's files, that's a hand-off — note it, don't reach across.
5. **Prove it.** Add/adjust tests in the matching suite. If the task touches an
   invariant, the invariant→test map in `TESTING.md` must still hold — the test must
   fail if you deliberately break the behaviour.
6. **Meet the gate.** `npm test` green, `npm run demo` still passes, and the phase's
   testing gate (in `BUILD_PLAN.md` / `TESTING.md`) is satisfied.
7. **Mark it done** in `TASKS.md`. Anything touching **billing or tenancy** needs a
   human review checkbox before it counts as done.

## Rules that bind every agent

- Stay in scope: **GPS/telematics only**, and `telematics/` code stays in its one
  folder. Reach outside → stop and ask.
- **Never relax an invariant to make a test pass.** Fix the code, or raise it with the
  coordinator and update `context/invariants/Dozr_GPS_CLAUDE.md` first.
- **Don't build the ledger or messaging speculatively** — they're throwing stubs until
  their phase (P2, P3). The ledger is human-led.
- Full guardrails: `CLAUDE.md`.
