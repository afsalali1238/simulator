# Hermes handoff — Module 8, the rules engine (the P3 rules slice)

> **Who this is for:** the next agent (a Claude sub-agent, Claude Code, or a human
> dev — it should read the same either way) picking up **Module 8, Rules & event
> detection**. Owner on the roster: `@integration-engineer` (see
> `.claude/agents/integration-engineer.md`).
>
> **Your job in one sentence:** turn the enriched telemetry the system already
> produces into a small set of **deterministic, pure event detectors** — geofence
> enter/exit, ignition outside working hours, idle-too-long, tamper/unplug, low
> battery — proven against the simulator scenarios that already exist to feed them.
>
> **Time-box mindset:** this is *not* a green-field build. The test bench, the
> scenarios, the enrichment seam, and the failing-spec pattern you'll copy are all
> already in the repo. Most of your risk is in **respecting boundaries and
> invariants**, not in writing detection logic. Read §6 and §8 twice.

---

## 0. TL;DR — the work in one table

Module 8 has **no code and no test yet** — there is no `src/rules/` directory and no
`test/rules.test.js`. You are creating the module from scratch. Two tracks:

| Track | What | Can start now? |
|---|---|---|
| **A — the five rules** (Module 8) | `src/rules/` — pure detectors returning event objects, one per rule, plus a stable dedupe identity. Prove each on its scenario. | **3 of 5 immediately** (geofence, after-hours, idle). The other 2 (tamper/unplug, low-battery) need one small upstream change — see Track B. |
| **B — grow Module 4 enrichment** (`src/enrichment/`) | Add only what the rules need: a working-hours check (timezone!), geofence membership, idle dwell. **And** get three power signals across the decode boundary so the tamper + low-battery rules have something to read. | Working-hours/geofence/idle: now. Power signals: needs a `@protocol-engineer` coordination (small). |

**Not yours right now (and this is the important one):** **do not un-stub messaging
(Module 7).** It throws on purpose — it needs live Meta/WhatsApp Cloud API
credentials and approved templates, which this local build does not have. You build
the rules and the *idempotent event identity*; the actual WhatsApp send stays a stub
until the credentials exist. The full P3 gate has a Meta-sandbox leg you **cannot**
close here; §5 splits the gate honestly so you know exactly where to stop.

**Scheduling note:** the roadmap lists P3 as gated behind the P2 ledger. The *rules
half* is not — it depends only on Module 4 enrichment and the simulator, both of
which exist and are green. You can build this in parallel with the human-led ledger
work. See §7.

---

## 1. Before you touch anything — required reading, in this order

Read these first. They are short, and every one of them will stop you from making a
wrong assumption.

1. **`CLAUDE.md`** (folder root) — the operating rules and the nine invariants in
   brief. The brand is **Kasper**, not Dozr; some filenames still carry a `Dozr_`
   prefix on purpose (don't rename them, don't reintroduce the name in new work).
2. **`context/invariants/Dozr_GPS_CLAUDE.md`** — the *source* of the nine invariants.
   If code and this doc ever disagree, this doc wins. Your rules touch invariants
   **3, 6, 7, 9** directly, and **5** tangentially — §6 spells out how.
3. **`ARCHITECTURE.md`** — find Module 4 (Enrichment, "where trips, geofence
   membership, idle detection will grow") and Module 8 (Rules, "not scaffolded ⛔").
   Note the data flow: decode → normalize → **enrichment → rules → messaging**.
4. **`BUILD_PLAN.md` § Phase P3** — the goal, the work items, and the **testing
   gate**, verbatim. Your Definition of Done in §5 quotes it.
5. **`TESTING.md`** — the invariant→test map, the honest "proven now vs gated"
   split, and the **gate mechanics** (test-count floor + no-skips). You will raise
   that floor; do it the way this doc describes.
6. **`telematics/src/simulator/scenarios.js`** and **`.../phases.js`** — your test
   bench. This is where the evidence each rule fires on is *manufactured*,
   deterministically. §2 maps each scenario to the rule it feeds.
7. **`telematics/src/enrichment/state.js`** — Module 4 as it stands today (one pure
   `deriveState()`; ~19 lines). This is the seam you grow, and the model for "pure
   and testable."
8. **`telematics/src/decode/normalize.js`** — the **canonical record your rules
   consume**. Read the exact field list; note what is *not* on it (power signals).
9. **`telematics/src/config.js`** — the IO-ID map and the comment block noting the
   power/tamper signals "the P3 rules engine has." Note there is **no working-hours
   config yet** — you add one, and it must be registered in `.env.example` (step 11).
10. **`telematics/test/scenarios.test.js`** and **`telematics/test/pending/ledger.test.js`**
    — the two test idioms you copy. `ledger.test.js` is the gold template: a
    **failing spec parked in `test/pending/`**, replaying a real scenario through the
    real decode pipeline. Your `rules.test.js` is the same shape.
11. **`telematics/.env.example`** — read the header: it is *the config contract*, and
    `test:config` fails on any undocumented var. If you add a working-hours or
    threshold knob to `config.js`, you add it here **in the same commit**.
12. **`telematics/src/messaging/index.js`** — the throwing stub you must **not**
    un-stub. Its comment already documents the event→template→dedupe→deliver contract
    you are the upstream half of.

---

## 2. Ground truth — what already exists (do not rebuild it)

**The scenarios are your test bench, and they already emit exactly what each rule
needs.** They are deterministic by construction (seeded PRNG, fixed timestamps), so a
rule test can pin *exact* events. Each scenario's `proves` array already names the
invariants it exercises, and several say in as many words "the rule itself is P3;
this scenario only produces the evidence" — that rule is you.

| Scenario | Device | What it emits (the evidence) | The rule it feeds |
|---|---|---|---|
| `geofence-cross` | D1 | Leaves and re-enters `SITE_JEBEL_ALI` (a circle: lat 25.0157, lon 55.0611, **radiusM 400**); `headingFlipAtTick: 12`. The scenario carries `site: SITE_JEBEL_ALI`. | **geofence enter/exit** |
| `after-hours` | D1 | Ignition **on** at `2025-03-05T19:30:00Z` — which is **23:30 Gulf Standard Time** (UAE is UTC+4, no DST). | **ignition outside working hours** |
| `yard-idle` + the `idle` phase in `day-cycle` | D2 / D1 | Ignition **true**, movement **false**, engine running — "the pattern an idle-too-long rule fires on." `yard-idle` is the non-CAN Generator, so it proves the rule works without engine data (invariant 9). | **idle-too-long** |
| `tamper` | D1 | `unplugged` phase ×5: `UNPLUG_DETECTED` (IO 252) fires on the first tick, external voltage collapses to 0, ignition → **null**, `batteryPct` drains from 100 at 8%/tick, priority 1. | **tamper/unplug** *and* **low battery** |

Two things are **exported specifically so your rule and your test assert against the
same numbers** — use them, do not redefine them:

- `SITE_JEBEL_ALI` — the geofence circle. Import it in both the rule and the test.
- `distanceMeters(a, b)` — the great-circle helper (re-exported from `scenarios.js`).
  Your geofence rule computes membership as `distanceMeters(pos, SITE_JEBEL_ALI) <=
  SITE_JEBEL_ALI.radiusM`. **No geo library** — this helper is the whole toolkit.

**The canonical record your rules read** (from `normalizeRecord`, one per decoded
frame, already tenant-attributed at its own timestamp):

```
{ deviceId, imei, tenantId, assetId, tsMs, lat, lon, speed, angle, altitude,
  satellites, priority,
  ignition (bool | null),      // null = unknown, NOT off — invariant 3
  movement (bool | null),
  state ('off' | 'idle' | 'moving' | 'unknown'),   // deriveState() output
  engine ({ seconds, hours, source:'ecu', … } | null) }
```

**What is NOT on that record yet — and this is the one real gap:** external voltage
(IO 66), battery level (IO 113), and unplug (IO 252). The simulator *emits* them on
the wire (that's why the `tamper` scenario works), but `normalize.js` currently drops
them — `config.js` says so directly: those signals are "NOT decoded into canonical
rows yet, so nothing downstream depends on them." So **geofence, after-hours, and
idle can be built against today's record immediately; tamper/unplug and low-battery
cannot fire until those three signals cross the decode boundary.** That's Track B, and
it's a `@protocol-engineer` touch (`normalize.js` is Module 2) — see §4 and §9.

**The gate mechanics you'll operate inside** (from `TESTING.md` + `src/tools/`):

- The suite is **85 tests in memory mode, 91 under `DB=pg`** today. All green in CI.
- `src/tools/test-files.js` enumerates tests with a **non-recursive**
  `readdirSync(test/)`. A file in `test/pending/` is therefore **not** collected —
  which is exactly why the ledger's failing spec can live there without breaking the
  gate. You'll use the same trick.
- `src/tools/test-gate.js` fails if the passing count drops below `DEFAULT_MIN_TESTS`
  (currently **85**) or if **anything is skipped or todo**. When your rules go green,
  move `rules.test.js` up into `test/` and **raise the floor in the same commit** —
  folding a proof into the gate is meant to be a deliberate, reviewable act.
- `test:config` enforces `.env.example`. A new config var that isn't documented there
  fails the suite. (This bites the after-hours rule — see §4.)

**Messaging (Module 7) is a throwing stub, and stays one.** Its own comment already
lays out the contract you feed: "subscribe to enriched events … map event → approved
WhatsApp template, throttle/deduplicate, deliver." You build everything up to and
including *deduplicate*; the deliver half waits on live Meta credentials.

---

## 3. Track A — the rules engine (Module 8), in detail

Build `src/rules/` as **pure functions over an ordered, per-asset sequence of
enriched records**. Same ethos as `deriveState()` and the ledger's
`computeUtilisation`: no I/O, no `Date.now()`, deterministic — so a test can replay a
scenario and assert the exact events. Suggested shape (yours to finalize — like the
ledger, the *shape* is the owner's call, the *behaviours* below are not):

```
detectEvents(records, { asset, tenant, config }) -> Event[]

Event = {
  type: 'geofence-enter' | 'geofence-exit' | 'after-hours-ignition'
      | 'idle-too-long'  | 'tamper-unplug' | 'low-battery',
  assetId, tenantId,   // read off the triggering record — attributed at ITS time (inv 6, 7)
  tsMs,                // the record time the event is attributed to
  eventId,             // DETERMINISTIC stable identity → the dedupe key (see below)
  detail: { … }        // rule-specific: { site } | { idleSeconds } | { batteryPct } | …
}
```

**`records` is the same input the ledger test builds:** replay a scenario
(`buildScenario` → `scenarioRecords`), normalize each frame through the real pipeline
(`resolveAssignment` + `normalizeRecord`), keep them in timestamp order, feed them in.
Copy `seedEcuReadings()` in `test/pending/ledger.test.js` almost verbatim — it is the
proven idiom for this exact thing.

The five rules:

1. **Geofence enter/exit.** Track membership across the sequence:
   `inside = distanceMeters(record, SITE_JEBEL_ALI) <= SITE_JEBEL_ALI.radiusM`. Emit
   `geofence-exit` on a true→false transition, `geofence-enter` on false→true. The
   `geofence-cross` scenario should yield exactly one exit then one enter. Guard the
   first record (no prior membership → no spurious event). A record with no fix
   (missing lat/lon) is *unknown membership*, not "outside" — don't fire on it.

2. **Ignition outside working hours.** Fire `after-hours-ignition` when `ignition ===
   true` **and** the record's local time is outside the working window. The
   `after-hours` scenario sits at 23:30 GST. You need a working-hours definition in
   **local time (Asia/Dubai, UTC+4, no DST)** — see §4 for the config. **Invariant 3
   trap:** fire on `ignition === true` only. `ignition === null` (which the `tamper`
   scenario produces) is *unknown* — you cannot assert the engine is on, so you do not
   fire an after-hours-ignition alert on it.

3. **Idle-too-long.** Fire `idle-too-long` when `state === 'idle'` has persisted
   longer than a threshold (compute dwell from consecutive idle records' `tsMs`; fire
   once per idle spell, not once per record). Keys off `state`, which comes from
   ignition + movement + speed — **not** from engine hours — so it works for the
   non-CAN Generator in `yard-idle` (invariant 9). Don't treat `state === 'unknown'`
   as idle.

4. **Tamper/unplug.** Fire `tamper-unplug` on the unplug signal (IO 252 = 1) and/or
   external voltage collapsing to ~0 while on external power. **Blocked until Track B
   surfaces those signals onto the record.** In the `tamper` scenario the same tick
   also drops ignition to null — do **not** read that null as "engine off"; the tamper
   event is about power, not ignition.

5. **Low battery.** Fire `low-battery` when battery level (IO 113) is below a
   threshold. **Also blocked on Track B.** **Invariant 3 trap:** a *missing* battery
   reading is `null`, not `0` — never raise a "flat battery" alert because the signal
   was absent. Only a real reading below threshold fires.

**The dedupe identity — this is what the P3 gate's "de-duplication test" checks.**
Every event needs a **deterministic `eventId`** so that re-running detection over the
same records (or a superset that includes a *resent* packet — remember ingest is
idempotent, invariant 2) yields the **same** eventIds and downstream delivery can drop
duplicates. Build `eventId` as a pure function of stable facts — e.g.
`hash(tenantId, assetId, type, <a stable window key>)`, where the window key is
something like the transition tick, the ignition-session start, or the idle-spell
start. Use `node:crypto`. **Never** use `Date.now()`, a random value, or an array
index — any of those breaks both determinism and the dedupe test. This idempotency
lives in *your* layer; it's what lets messaging stay a dumb sink later.

**Constraints (same as the rest of the slice):** `telematics/` stays a single folder,
**no new dependencies**, **no build step**, `node:` built-ins only. Geofence uses the
exported `distanceMeters`; hashing uses `node:crypto`. The `_phase` field on simulator
records is a **debug annotation, not on the wire** — derive everything from real
signals (`ignition`/`movement`/`speed`/`state`/IO), never from `_phase`.

---

## 4. Track B — grow Module 4 enrichment (only as the rules need it)

`ARCHITECTURE.md` calls Module 4 the place "where trips, geofence membership, idle
detection will grow." Grow it here — but keep every derivation a **pure, testable
function**, the way `deriveState()` is. Three pieces:

- **Working-hours check (for the after-hours rule).** There is no working-hours or
  timezone config today. Add one to `config.js` — e.g. a working-window start/end hour
  and the UAE offset (UTC+4). **Then register it in `.env.example` in the same
  commit**, or `test:config` will fail (it enforces that every var the code reads is
  documented — this is a P0 rule that is still live). Keep the check pure: pass the
  record's `tsMs` in, get inside/outside out; no ambient clock.

- **Geofence membership.** A pure helper over `(record, site)` returning inside/outside
  using the exported `distanceMeters`. The rule consumes it. `SITE_JEBEL_ALI` is the
  only site defined today; if you generalize to a site list, keep the single-circle
  behaviour identical so the `geofence-cross` scenario still pins.

- **Idle dwell.** Either the rule computes dwell from the record stream directly, or
  enrichment annotates a running idle-duration. Either is fine; keep it pure and
  keep it out of `state.js` if it complicates that function — a new small module is
  cleaner than overloading `deriveState`.

- **⚠ The power signals — the one cross-boundary dependency.** The tamper/unplug and
  low-battery rules cannot fire until external voltage (66), battery (113), and unplug
  (252) reach the record. Today `normalize.js` drops them. `normalize.js` is **Module 2
  (decode), owned by `@protocol-engineer`** — so surfacing these is a coordination
  point, not something to reach across and do silently. Agree the exact field names
  with them (so the rule and the decoder match, the way `SITE_JEBEL_ALI` is shared),
  and whichever way it's done, **invariant 3 governs**: a signal that's absent on a
  given frame is `null`, never `0`/`false`. Until that lands, build and ship rules
  1–3; leave 4–5 as a written, tested-once-unblocked follow-up. This is the honest
  two-track split, and it's exactly why §5 separates "doable now" from "blocked."

---

## 5. Definition of done — the P3 gate, split honestly

The P3 testing gate, **verbatim** from `BUILD_PLAN.md` §P3:

> `test:rules` green (each event type on a crafted scenario) + messaging integration
> test against a Meta sandbox/number + a de-duplication test.

Here is what you can and cannot close, and why:

**✅ Yours to finish now (the rules slice):**

- [ ] `src/rules/` exists; the five detectors are pure and deterministic.
- [ ] `test:rules` green — **each event type on its scenario**: geofence enter+exit on
      `geofence-cross`, after-hours on `after-hours`, idle-too-long on
      `yard-idle`/`day-cycle`, tamper-unplug and low-battery on `tamper`.
- [ ] **De-duplication test** — re-running detection over the same (or a resent-superset)
      record stream produces identical `eventId`s and **no duplicate events**.
- [ ] Enrichment growth (working-hours, geofence membership, idle dwell) is pure and
      unit-tested; any new config var is in `.env.example` and `test:config` is green.
- [ ] Written the spec first as **`test/pending/rules.test.js`** (red, uncollected by
      the gate), built to green, then **moved it up to `test/rules.test.js` and raised
      `DEFAULT_MIN_TESTS` in the same commit**. Add a `test:rules` script to
      `package.json` alongside the others.
- [ ] All nine invariants still enforced; §6 traps handled. Nothing relaxed to pass.

**⛔ Blocked — do NOT fake it to make the gate green:**

- [ ] *Messaging integration test against a Meta sandbox* and *un-stubbing Module 7* —
      needs **live Meta/WhatsApp Cloud API credentials + approved templates** this build
      does not have. Leave `messaging/index.js` throwing. Define the event→message
      contract in comments/types; don't send. This leg of the gate closes when the
      credentials exist — flag it to afzl, don't paper over it.

**⚠ Cross-boundary — needs `@protocol-engineer` first:** tamper-unplug and low-battery
can't reach green until the three power signals cross the decode boundary (§4). If that
change hasn't landed when you finish rules 1–3, ship those three green and leave 4–5 as
a tested-once-unblocked follow-up rather than forcing them.

"Done" for *your* package = the rules slice above is green in CI and the messaging leg
is honestly documented as credential-blocked. That is the same shape as how P0 and the
ledger handled their physical/external blockers — scope to what's real, flag the rest.

---

## 6. The invariants your work must respect

Your layer touches these directly:

- **3 — NULL is not zero.** The sharpest trap for rules. `ignition: null` (the `tamper`
  scenario) is *unknown*, not off and not on: the after-hours rule fires only on
  `ignition === true`; the idle rule never treats `state: 'unknown'` as idle. A missing
  battery reading is `null`, never `0` — never raise low-battery because the signal was
  absent. A record with no GPS fix is *unknown* geofence membership, not "outside."
- **6 — attribution at each record's own timestamp.** Read `tenantId`/`assetId` off the
  *triggering record* (they were resolved at that record's time by `resolveAssignment`).
  An event during the D1 handover window attributes to whoever held the asset **then**,
  never to the "current" owner. Don't re-resolve assignment yourself.
- **7 — tenancy, always.** Events are tenant-scoped. When they flow to messaging, tenant
  A must never be told about tenant B's asset. No cross-tenant routing, ever.
- **9 — unlisted / non-CAN asset ⇒ position + ignition only.** Good news: four of your
  five rules key off position/ignition/power, which even a non-CAN asset has, so they
  work for the Generator in `yard-idle`. The trap is the other direction: **don't invent
  a rule that needs engine hours** (e.g. "run-time too long" from AVL 102) — it would
  silently do nothing for non-CAN assets and look broken.
- **5 — ignition counters are never billing evidence** (tangential but worth stating): an
  "after-hours ignition" event is an *alert*, not a meter reading. It informs a person;
  it never feeds an invoice. Keep the rules layer and the ledger strictly separate.

---

## 7. Suggested order of operations

1. **Read §1's list.** Especially `ledger.test.js` — it's the template for everything
   below.
2. **Write `test/pending/rules.test.js` first**, red on purpose. Pin each event type
   against its scenario using the `seedEcuReadings` replay idiom. State the assumed
   `Event`/`detectEvents` contract in the header comment (owner-confirmable shape,
   non-negotiable behaviours), exactly as the ledger spec does. Add a `test:rules`
   script. Confirm the memory gate is still **85/85** (the pending file isn't collected).
3. **Build rules 1–3 (geofence, after-hours, idle)** against today's canonical record.
   Grow enrichment (working-hours + config in `.env.example`, geofence membership, idle
   dwell) only as these need it. Get them green.
4. **Build the dedupe identity** and its test (re-run → identical eventIds, no dupes).
5. **Coordinate with `@protocol-engineer`** to surface IO 66/113/252 onto the record
   (invariant 3: null-or-value). When it lands, build rules 4–5 (tamper, low-battery)
   green. If it hasn't landed, ship 1–3 + dedupe and leave 4–5 as a documented follow-up.
6. **Promote the spec:** move `rules.test.js` up to `test/`, raise `DEFAULT_MIN_TESTS`
   in `src/tools/test-gate.js` **in the same commit**. Confirm the gate is green at the
   new floor.
7. **Document the messaging leg as credential-blocked** (§5). Hand back to afzl.

You can run steps 2–4 **in parallel with the P2 ledger work** — the rules slice does
not depend on Module 5 or on D1 hardware.

---

## 8. What the handoff does not cover (boundaries)

The one hard boundary: **messaging stays stubbed.** You will not un-stub Module 7 in
this handoff. Its comment already documents the event→template→dedupe→deliver contract
you are the upstream half of. The actual WhatsApp send waits on live Meta credentials.
Leave `messaging/index.js` throwing.

Also: **do not build the ledger** (Module 5). It stays a throwing stub (P2, human-led).
Do not route any rule event into billing (invariant 5). The rule→ledger hand-off is
intentionally not built here — that's a later phase.

The rest of what's off-limits:

- **The decode boundary (`src/decode/normalize.js`, `engine-hours.js`).** Module 2,
  `@protocol-engineer`. You *coordinate* the power-signal surfacing; you don't rewrite
  the decoder. Don't change how engine hours (AVL 102) decode — that's D1, settled.
- **The store schema (`db/schema.sql`).** There is **no events table**, and you don't
  need one for the gate — rules are pure detectors. If durable event persistence is
  wanted later, that's a **`@database-engineer`** change (new table + RLS + tests),
  not something you add here. Flag it; don't build it speculatively.
- **Tenancy / RLS and evidence immutability.** Proven at the DB layer (invariants 7, 8).
  Don't touch the policies or the trigger.
- **Git / infra.** afzl runs git and owns build/infra decisions himself. Produce the
  code and the diffs; **do not commit, push, or stand up infrastructure** on your own.
- **Any invariant.** Never relax one to make a test pass. If a rule seems to require it,
  the rule is wrong — stop and flag it.

---

## Quick reference: the five rules and when they fire

| Rule | Fires on | Ready to build? |
|---|---|---|
| **1. Geofence enter/exit** | `geofence-cross` — D1 leaves and re-enters `SITE_JEBEL_ALI` (radius 400 m). | ✅ Now. |
| **2. After-hours ignition** | `after-hours` — ignition on at 23:30 GST. | ✅ Now — you add the working-hours config (Asia/Dubai, UTC+4, no DST). |
| **3. Idle-too-long** | `yard-idle` / the `day-cycle` idle phase — dwell computed from consecutive `tsMs`. | ✅ Now. |
| **4. Tamper/unplug** | `tamper` — IO 252 fires, external voltage → 0, ignition → null on the same tick. | ⛔ Needs the three power signals on the record first (`@protocol-engineer`). |
| **5. Low battery** | battery level (IO 113) below threshold. | ⛔ Needs the three power signals on the record first (`@protocol-engineer`). |

---

## 9. Hand-offs

| To whom | What | When |
|---|---|---|
| **`@protocol-engineer`** | Surface external voltage (66), battery (113), unplug (252) onto the canonical record via `normalize.js`, as null-or-value (invariant 3). Agree field names with them. | Before rules 4–5 (tamper, low-battery) can fire. |
| **afzl (human)** | The messaging integration leg of the P3 gate is blocked on **live Meta/WhatsApp Cloud API credentials + approved templates**. Module 7 stays stubbed until those exist. | At sign-off — flag it, don't hide it. |
| **`@database-engineer`** | *Only if* durable event persistence is later wanted: a new events table + RLS + tests. Not needed for this gate (rules are pure). | Deferred / on request. |
| **`@ledger-owner` (human, P2)** | No overlap by design — confirm no rule event is being routed into billing (invariant 5). | Sanity check at review. |

---

*This handoff is scoped to the Kasper GPS/telematics build only — specifically Module 8
(rules) and the enrichment it needs. It deliberately stops at the messaging boundary.
The completed simulator + P0 work is recorded separately in `HERMES_HANDOFF.md`; this
file is its successor for the P3 rules slice.*
