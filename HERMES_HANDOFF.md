# HERMES — Handoff: Simulator scenario-engine + P0 hardening

> **Who this is for:** the agent (or developer) we're calling **hermes**. This is a
> standalone brief — a Claude sub-agent, Claude Code, or a human dev can all pick it up
> cold. You do **not** need any other conversation; everything you need is in this folder.
>
> **Your job in one sentence:** turn the simulator from a one-note demo into a real
> **scenario engine** that can replay the seed fleet's whole story, and finish **all of
> P0** (the operability hardening that makes this slice safe to run unattended and safe
> to merge into).
>
> **Time-box mindset:** P0 is "make what already works trustworthy and repeatable." You
> are **not** adding product features (no Postgres, no ledger, no WhatsApp). If you find
> yourself changing billing or storage internals, stop — that's another agent's phase.

---

## 0. TL;DR — the two tracks you own

| Track | What | Why it's P0 | Definition of done |
|---|---|---|---|
| **A. Simulator → scenario engine** | Grow `src/simulator/` so it can emit the *full seed story*: D1 changing hands (Excavator X → Generator Y), D2 idle in the yard, plus realistic day-cycles (startup/travel/work/idle/after-hours) and a couple of anomaly scenarios (geofence cross, tamper/unplug). | The simulator is the **test bench** for everything downstream — the ledger, the rules engine, D1, and soak tests all replay against it. If it can only model one flat session, we can't prove invariant 6 (attribution on handover) or 9 (no engine data on a non-CAN asset) end-to-end. | Named scenarios selectable from the CLI; replaying the "handover" scenario produces records on both sides of `2025-06-01T00:00:00Z`; the simulator still speaks the **genuine Teltonika protocol** (real hardware swaps in unchanged); new scenario logic has tests. |
| **B. P0 hardening** | CI that locks the 37 tests as a merge gate · config hygiene (`.env.example` is the contract) · structured logging · a load-balancer-shaped `/health` · graceful shutdown (SIGINT/SIGTERM) on the **ingestion** and **API** servers · run-books. | This slice is going to be handed to more agents and eventually run on a pilot box. Right now a crash mid-write, an un-probeable health check, or a CI-less repo would all be silent risks. P0 removes them **without** touching correctness. | The P0 gate below is green: **CI 37/37 on a clean non-build machine**, `npm run demo` shows the expected ACK pattern, both servers shut down cleanly on a signal, `/health` is LB-usable, and there's a run-book a human can follow at 2am. |

**Runs in parallel, NOT yours:** the **D1 investigation** (mapping real CAN engine-hours
off the vehicle bus) starts day one and is owned by **protocol-engineer**. You keep the
simulated stand-in (IO ID `200`, "engine-on seconds") working; you do **not** try to make
it "real." See §6.

---

## 1. Before you touch anything (required reading, in order)

Read these top-to-bottom before writing code. They are all in this folder.

1. **`CLAUDE.md`** (this folder) — the operating rules and the **nine invariants**. Non-negotiable.
2. **`ARCHITECTURE.md`** — the 9 modules, the data model, the data flow, and the seed scenario. You mainly touch **Module 9 (Simulator)** and the operability edges of Modules 1 & 6.
3. **`BUILD_PLAN.md`** — read the **P0** section; it's your scope. Skim P1–P4 so you don't accidentally build ahead.
4. **`TESTING.md`** — this is your playbook for the gate. Note the invariant→test map and the honest "gated to Px" rows.
5. **The current simulator source** — `telematics/src/simulator/scenarios.js`, `device.js`, `run-simulator.js`. You are evolving these.
6. **`telematics/src/store/seed-data.js`** — the canonical fixtures (the fleet, the assets, the assignments). Your scenarios must line up with these exactly; the IMEIs the simulator dials in with have to be known to the store.
7. **`telematics/.env.example`** — the config contract you're formalizing in Track B.

If anything in the code and the invariants doc disagree, **the invariants win and the code is the bug** — flag it, don't quietly "fix" it by relaxing a rule.

---

## 2. Ground truth — what exists today (don't rebuild it)

The slice **works**: **37/37 tests green**, `npm run demo` runs clean, all on `memory`
store with zero external services. Your job builds *on top of* this, it does not redo it.

### The simulator, as it stands

`src/simulator/scenarios.js` (~55 lines) models exactly **one** behaviour:

```js
// makeScenario() -> step(i): one record per tick
const ignition = true;               // always on — never starts, never stops
const movement = i % 10 !== 0;       // a mechanical "idle every 10th tick"
if (ignition) engineSeconds += 1;    // engine-seconds tick up forever
const speed = movement ? 18 + (i % 6) : 0;
// IO built by buildIo({ ignition, movement, engineSeconds }):
//   239 IGNITION (1B) · 240 MOVEMENT (1B) · 200 ENGINE_HOURS_S (4B, simulated)
```

That's the whole repertoire: one device, ignition wired on, a regular idle blip, engine
hours that only ever climb. It's enough to prove the pipe carries data. It is **not**
enough to exercise the invariants or to be a test bench. That's the gap you close.

`src/simulator/device.js` — `SimDevice`, a **real TCP client** that speaks genuine
Teltonika Codec 8/8E: IMEI handshake, framed AVL records, reads the 4-byte ACK back.
`send(records)` returns the ACK count; `sendNoWait()` exists for the durability test;
`close()` tears down. **Keep this honest** — it must stay byte-compatible with a real
FMC130/FMC920 so hardware drops in with no server change. Don't let it drift into a mock
only our server understands.

`src/simulator/run-simulator.js` — the CLI. Spins up N devices (capped at the roster
length), `setInterval` sends one record per tick, and it **already** handles
SIGINT/SIGTERM (stop → clear interval → close sockets). Use it as the reference for the
graceful-shutdown work in Track B — the ingestion and API servers need to reach the same bar.

### The servers you'll harden (Track B)

- **Ingestion** `src/ingestion/server.js` — receives device frames, and **only ACKs after
  the write is durably committed** (invariant 1). Its library form has `listen()/close()/
  address()`, but the **direct-run block** (the `import.meta.url` guard) has **no
  SIGINT/SIGTERM handler** — a P0 target. Logging is ad-hoc `logger.info?.()/warn?.()`.
- **API** `src/api/server.js` — `GET /health` returns `{ ok: true, store: store.kind }`
  (your LB-probe target); every data endpoint requires an `X-Tenant-Id` header (400 if
  missing — invariant 7). Same graceful-shutdown and logging gaps to close.

### The tests (your merge gate)

Seven suites, **37 tests**, run **serially** (`--test-concurrency=1`, because several bind
real TCP/HTTP sockets — don't "parallelize" them into port races):

```
crc.test.js · codec.test.js · store.test.js · decode.test.js
tenancy.test.js · ingestion.test.js · api.test.js
```

Commands: `npm test` (all), `npm run demo` (the end-to-end ACK demo). Node **≥20** (built
on 22), ESM, `node:test`. No build step, `pg` is the only dependency.

---

## 3. Track A — Simulator → scenario engine (detailed)

**Goal:** a small, named library of scenarios that the CLI can pick from, each emitting a
realistic stream of records for one or more devices, all speaking the real protocol. The
bar is "a human can say `--scenario handover` and watch the seed story replay," and
"downstream agents can point the ledger/rules tests at a scenario and get deterministic,
invariant-exercising data."

### 3.1 The seed story your scenarios must be able to tell

From `src/store/seed-data.js` — these are the fixtures the store already knows, so your
scenarios must use **these exact IMEIs and timestamps**:

| Device | IMEI | The story it needs to tell | Invariants it proves |
|---|---|---|---|
| **D1** FMC130 | `356307042441013` | **Jan–Jun 2025:** on **Excavator X** (CAT 320, CAN-supported, `hasEngineData: true`) → billed to **Tenant A**. **From 2025-06-01T00:00:00Z:** moved to **Generator Y** (Genericorp G-500, **no CAN program**, `hasEngineData: false`) → billed to **Tenant B**. | **6** (a record's owner depends on *when* it happened — records at `05:59Z` vs `06:01Z` on 2025-06-01 attribute to different tenants) and **9** (once on Generator Y, **no engine-hours must be produced** — the device can still send IO 200, but a non-CAN asset must not yield billable engine data). |
| **D2** FMC920 | `356307042441099` | **Unassigned** — sitting in Kasper's yard. Emits **position + ignition only**, scoped to the owner tenant. | **7** (tenant scoping) and **9** (an unlisted/unassigned machine yields position + ignition only, never engine data). |

> The **handover instant** (`2025-06-01T00:00:00Z`) is the single most important moment in
> the whole test bench. A scenario that emits records straddling it — and lets a
> downstream test confirm the split lands on the right tenants — is what makes invariant 6
> provable end-to-end. Today's simulator can't do this at all (single device, single
> flat session). Make it possible.

### 3.2 Scenario vocabulary to build

Model realistic machine behaviour as composable **phases** rather than one flat loop.
Suggested set (name them clearly; keep each one deterministic given a seed):

- **`day-cycle`** — a believable working day: **off → startup** (ignition on, engine
  warms, not moving) **→ travel** (moving, speed varies) **→ work** (on-site: ignition on,
  intermittent movement, engine-seconds climbing) **→ idle** (on, stationary, engine still
  running) **→ shutdown** (ignition off, engine-seconds hold). Contrast with today's
  "ignition always on."
- **`after-hours`** — ignition on outside working hours (feeds the rules engine's
  after-hours-use alert later — you don't build the rule, you make the *data* that trips it).
- **`handover`** — the D1 story in §3.1: same device, assignment flips at the seed
  timestamp. Must emit on both sides of the boundary.
- **`yard-idle`** — the D2 story: unassigned device, position + ignition only, no engine data.
- **`geofence-cross`** — a track that leaves and re-enters a site boundary (data for the
  geofence in/out event).
- **`tamper`** — an unplug/power-loss pattern (data for the tamper alert).

Each scenario is a function of tick index (like today's `step(i)`) or of wall-clock offset —
your call, but keep it **pure/deterministic** so tests can assert exact output. Reuse the
existing `buildIo({ ignition, movement, engineSeconds })` helper and the `IO` map from
`config.js` (`IGNITION 239`, `MOVEMENT 240`, `GNSS_STATUS 69`, `ENGINE_HOURS_S 200`).

### 3.3 CLI

Extend `run-simulator.js` (and/or add config knobs to `.env.example`) so a scenario is
selectable, e.g. `SIM_SCENARIO=handover npm run sim` or `--scenario handover`. Keep the
existing multi-device spin-up and the **graceful SIGINT/SIGTERM shutdown that's already
there** — it's your reference implementation for Track B.

### 3.4 Hard constraints for Track A

- **Speak the real protocol.** All output goes through `SimDevice`, which frames genuine
  Codec 8/8E. No shortcut encodings.
- **Line up with the seed.** IMEIs, asset/assignment timestamps must match `seed-data.js`.
  If you need a new fixture, coordinate with **database-engineer** (who owns the store and
  the SQL seed that must mirror it) — don't fork the fixtures.
- **`NULL ≠ 0` (invariant 3).** A device on a non-CAN asset (Generator Y, D2) must **not**
  fabricate `engineSeconds: 0` and pass it off as data. Absence is `null`, not zero.
- **Simulated engine data stays labelled simulated.** IO ID 200 is a stand-in for real
  CAN. Don't let a scenario imply it's `source: 'ecu'` billable truth — that's D1's job
  (protocol-engineer) and the ledger's gate (ledger-owner), not the simulator's.
- **Determinism.** Given the same scenario + seed, output is identical run-to-run, so tests
  can pin it.

---

## 4. Track B — P0 hardening (detailed)

Six items. None of them touch correctness logic — they make the working slice **operable,
repeatable, and safe to merge into.** Do them in roughly this order.

### 4.1 CI — lock the 37 as a merge gate  *(highest value; do first)*

There is **no `.github/workflows/` yet.** Add one. It must:
- run on push / PR,
- use Node ≥20,
- run `npm ci` (or `npm install`) then **`npm test`** in **`memory` mode** — which needs
  **no Postgres, no services** (that's the whole point of the memory adapter),
- **fail the build if the count drops below 37 or any test is skipped.**
- Keep the serial execution (`--test-concurrency=1`) — don't let CI reintroduce port races.

Postgres-mode tests (`DB=pg npm test`) are a **P1** gate (they need a DB service); you can
scaffold a *separate, optional* job for them, but P0 only requires the memory-mode gate to
be green on a clean machine.

### 4.2 Config hygiene — make `.env.example` the contract

`.env.example` already exists and is good (DB URLs, `INGEST_PORT=5027`, `API_PORT=8080`,
`SIM_*`, `FAIL_BEFORE_COMMIT`). Your job: make sure **every** env var the code reads is
represented there with a comment, add any new `SIM_SCENARIO` knob from Track A, and
confirm `config.js` has sane defaults so the demo runs with **no `.env` at all** (it uses
`process.loadEnvFile` in a try/catch today — keep that; don't add a `dotenv` dependency).

### 4.3 Structured logging

Servers currently log via optional-chaining calls (`logger.info?.() / warn?.() / error?.()`).
Formalize a tiny logger (no new dependency — a thin wrapper over `console` is fine) that
emits **structured** lines (JSON or key=value) with at least: timestamp, level, module,
and event. Route the ingestion and API servers through it. Goal: when this runs on a pilot
box, the logs are greppable and shippable — not free-text. **Never log tenant data payloads
or secrets.**

### 4.4 Load-balancer-shaped `/health`

`GET /health` returns `{ ok: true, store: store.kind }` today — good start. Make it
**LB-usable**: fast, dependency-light, returns non-200 when the process can't serve (e.g.
store not initialized), so an ALB/NLB target group or ECS health check can drain a bad
instance. Add/verify a test in `api.test.js`. Don't make it query the DB on every probe
(that turns a health check into a load source).

### 4.5 Graceful shutdown (SIGINT/SIGTERM) on ingestion + API

`run-simulator.js` already does this right — copy the pattern. On signal:
- **stop accepting** new connections/requests (`server.close()`),
- let in-flight work finish (critically for ingestion: **don't drop a frame mid-write —
  invariant 1 says we only ACK after a durable commit, so never ACK-then-die**),
- close the store/pool cleanly,
- exit 0.

This matters most for the **ingestion** server: a hard kill mid-packet must not leave a
device believing a record was accepted when it wasn't. Add a test if feasible (the
`FAIL_BEFORE_COMMIT` hook and `sendNoWait()` already model the "ACK only after commit"
property — lean on them).

### 4.6 Run-books

Short, literal, 2am-proof markdown a human can follow without context. At minimum:
- **Run it locally** (memory mode, zero setup): the exact commands, expected output.
- **Run the demo / a scenario**: `npm run demo`, `SIM_SCENARIO=handover ...`, what "good" looks like.
- **Read the logs / interpret `/health`**: what a healthy vs draining instance looks like.
- **Graceful restart**: how to stop and start without dropping data.

Put these under `telematics/docs/` (where `MODULES.md` already lives) or a `RUNBOOKS.md` —
coordinate the location with the folder's existing docs, don't scatter.

---

## 5. Definition of done — the P0 gate

You are done with P0 when **all** of these hold (this is the gate `qa-test-engineer` will
enforce; see `TESTING.md`):

- [ ] **CI is green: `npm test` = 37/37, no skips, on a clean non-build machine** (memory mode, no services).
- [ ] **`npm run demo` shows the documented ACK counts `20 / 5 / 0-new`** (per `TESTING.md` §gates and `BUILD_PLAN.md` P0 — the third batch is a resend, so 0 *new* records ACK'd proves idempotent ingest).
- [ ] **The simulator can replay the `handover` and `yard-idle` scenarios**, emitting records that straddle `2025-06-01T00:00:00Z` for D1 and position+ignition-only for D2 — and there's a **test** asserting the scenario output.
- [ ] **Ingestion and API servers shut down cleanly on SIGINT/SIGTERM** — no ACK-without-commit, no dropped in-flight write.
- [ ] **`/health` is LB-usable** (fast, returns non-200 when unhealthy) with a test.
- [ ] **`.env.example` covers every env var read by the code**; demo runs with no `.env`.
- [ ] **Structured logging** in both servers; no secrets/tenant payloads logged.
- [ ] **Run-books** exist and a person unfamiliar with the code could follow them.
- [ ] **No invariant lost its test; no invariant was relaxed to make anything green.**
- [ ] **Still a single folder, no new runtime dependency, no build step.**

---

## 6. What is NOT yours (boundaries — read these twice)

- **D1 (real CAN engine-hours) is a parallel track owned by `protocol-engineer`.** It
  starts day one alongside you. You keep the **simulated** IO-ID-200 stand-in working; you
  do **not** try to make it real or wire it into billing. When protocol-engineer lands the
  real mapping, your scenarios adopt it — but that's later.
- **Ledger (Module 5) is a throwing stub, human-led, and gated to P2.** Don't build against
  it, don't remove the throw, don't feed it simulated engine data as if it were billable.
  A wrong invoice is worse than a late one. Owner: `ledger-owner`.
- **Messaging (Module 7 / WhatsApp) is a throwing stub, gated to P3.** It needs live Meta
  creds and approved templates. Don't fake-send. Owner: `integration-engineer` (that's the
  same lane as the simulator — but messaging is a *later phase*, not P0).
- **Storage internals & the SQL seed** belong to `database-engineer`. If a scenario needs a
  new fixture, coordinate — the memory store and `db/seed.sql` must mirror each other.
- **Postgres mode / RLS** is **P1**, not P0. Your CI proves memory mode; leave the pg job
  optional.
- **Don't relax an invariant to pass a test.** If the code and `context/invariants/…` (or
  `CLAUDE.md`) disagree, the doc wins and the code is the bug — hand it to the owner.
- **Single folder, no new deps, no build step.** The whole slice stays `telematics/` with
  `pg` as the only dependency and `node:*` builtins otherwise.

---

## 7. The invariants your work must respect

All nine are in `CLAUDE.md`; these are the ones your two tracks touch most:

- **1 — ACK only after a durable write.** Your graceful-shutdown work must never break this
  (no ACK-then-die).
- **3 — `NULL ≠ 0`.** Simulator must not fabricate `0` engine-seconds for a non-CAN asset.
- **6 — attribution at each record's own timestamp.** The `handover` scenario is the whole
  point: records attribute by *when they happened*, not "as of now."
- **9 — an unlisted/non-CAN machine yields position + ignition only.** Generator Y and the
  unassigned D2 must not produce engine data.
- **7 — tenancy always.** `/health` is the only endpoint without `X-Tenant-Id`; keep it
  that way, and don't add an endpoint that leaks across tenants.

CI (Track B) is what keeps **all nine** honest — that's why it's the highest-value item.

---

## 8. Suggested order of operations

1. **Read** §1's list. Run `npm test` and `npm run demo` yourself first — confirm 37/37
   green from *your* checkout before you change anything. (If it's not green on arrival,
   that's a finding — report it, don't build on sand.)
2. **CI (4.1)** — get the merge gate up immediately so every later change is protected.
3. **Graceful shutdown (4.5)** + **`/health` (4.4)** — small, high-value operability wins;
   copy the simulator's signal-handling pattern.
4. **Structured logging (4.3)** + **config hygiene (4.2)** — tidy the operational surface.
5. **Scenario engine (Track A)** — the biggest piece; build the phase vocabulary, then the
   named scenarios, `handover` and `yard-idle` first (they prove the invariants), then
   `day-cycle`, then the anomaly scenarios. Add tests as you go.
6. **Run-books (4.6)** — write them last, from the commands you actually ran.
7. **Re-run the full gate (§5)** and hand to `qa-test-engineer` to call the P0 gate.

---

## 9. Hand-offs — who to talk to for what

| If you need… | Go to |
|---|---|
| Real CAN engine-hours (D1), codec/decode internals | **protocol-engineer** |
| A new store fixture, SQL seed change, storage behaviour | **database-engineer** |
| Socket/ACK semantics of the ingestion tier | **ingestion-engineer** |
| New API query shapes / response contracts | **api-engineer** |
| Anything billing / evidence-seal | **ledger-owner** (human-led) |
| To call the P0 gate / a failing test's owner | **qa-test-engineer** |

Roster and ownership detail: `AGENTS.md`. The task board (claim your P0 items there):
`TASKS.md`.

---

*This handoff is scoped to GPS/telematics only. It does not touch the Marketplace, Vendor
OS, or any other Kasper product. When P0's gate is green, the next phase (P1 — Postgres) is
picked up per `BUILD_PLAN.md`.*
