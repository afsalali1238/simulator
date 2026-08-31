# Kasper GPS / Telematics — Development Folder

This is the **self-contained build folder** for the Kasper GPS/telematics platform:
the hardware-fed system that ingests Teltonika device data, attributes every reading
to the right tenant at the right moment in time, stores it as sealed evidence, and
serves it to dashboards and (eventually) invoices.

It contains three things and nothing else:

1. **`telematics/`** — a working, tested code slice. It emits and receives **real
   Teltonika Codec 8/8E binary over TCP**, decodes it, stores it, and serves it over
   HTTP. It runs today with zero setup (`npm run demo`, `npm test` — 68 tests green).
2. **`context/`** — every reference document the build depends on: the PRD, the BRD,
   the architecture set, the expert reviews, the Teltonika technical packs, and the
   correctness invariants. Indexed in `context/README.md`.
3. **Build governance** — the docs and agent definitions that tell a team (human or
   AI) *what* to build, *in what order*, *how it's tested*, and *who owns what*:
   `ARCHITECTURE.md`, `BUILD_PLAN.md`, `TESTING.md`, `TASKS.md`, `AGENTS.md`,
   `CLAUDE.md`, and `.claude/agents/`.

Everything needed to understand, build, test, and ship this system is inside this
folder. It can be zipped and handed to a development team as-is.

---

## Scope — read this first

**This folder is GPS/telematics only.** It does not touch the Kasper Marketplace,
Vendor OS, or any other product. If a task seems to reach outside telematics, stop
and ask. The wider Kasper repo lives one level up; this folder is deliberately walled
off so it can be handed off independently.

---

## Start here (reading order)

| If you are… | Read, in this order |
|-------------|---------------------|
| **New to the project** | `context/invariants/Dozr_GPS_Leaders_Field_Guide.html` → this README → `ARCHITECTURE.md` |
| **About to write code** | `CLAUDE.md` → `ARCHITECTURE.md` → `telematics/README.md` → your agent brief in `.claude/agents/` → `TASKS.md` |
| **Picking up a task** | `TASKS.md` (find an unblocked task) → `AGENTS.md` (which agent owns it) → the module's entry in `ARCHITECTURE.md` |
| **Reviewing / QA** | `TESTING.md` → `telematics/docs/MODULES.md` → run `npm test` in `telematics/` |
| **Planning / management** | `BUILD_PLAN.md` (phases, gates, done-criteria) → `context/reviews/` |

---

## The one-paragraph explanation

A Teltonika GPS box is bolted to a piece of construction equipment. Over a mobile
connection it dials into our **ingestion server** and streams binary packets — GPS
fixes, ignition, movement, and (on CAN-equipped machines) engine hours. We decode
those packets, figure out **which customer was renting that machine at the exact
moment each reading was taken**, store the raw bytes as tamper-evident evidence, and
expose clean data to dashboards. Later, sealed engine-hours become the basis for
**utilisation billing**, and events (geofence breach, after-hours use) become
**WhatsApp alerts**. The hard parts are the device protocol and the correctness
rules around billing and tenancy — which is exactly what the `telematics/` slice
already proves.

---

## Folder map

```
gps-build/
├── README.md                ← you are here: entry point + reading order
├── CLAUDE.md                ← operating rules for any agent working in this folder
├── AGENTS.md                ← team roster: who owns what, how to claim a task
├── ARCHITECTURE.md          ← the system: 9 modules, data model, data flow, invariants, AWS target
├── BUILD_PLAN.md            ← phased path to production (P0→P4) with a testing gate per phase
├── TESTING.md               ← test strategy, invariant→test map, acceptance criteria, CI
├── TASKS.md                 ← the live task board (checkbox list, phased, with owners)
│
├── .claude/
│   └── agents/              ← GPS specialist agent definitions (protocol, ingestion, db, api, …)
│
├── .github/workflows/       ← CI: the merge gate (see the note in TESTING.md § CI)
│
├── telematics/              ← THE CODE (working, tested — see telematics/README.md)
│   ├── src/                 ← modules 0–9 + logging/, lifecycle/, tools/
│   ├── test/                ← 68 tests, each suite independently runnable
│   ├── db/                  ← Postgres schema (RLS + immutability triggers) + seed
│   ├── docs/                ← MODULES.md, PROTOCOL.md (byte-level), RUNBOOKS.md
│   └── README.md, CLAUDE.md
│
└── context/                 ← ALL reference docs (see context/README.md for the index)
    ├── requirements/        ← PRD, BRD, functional spec, product specs
    ├── architecture/        ← build handbook, platform + GPS architecture, IoT diagram
    ├── reviews/             ← expert build reviews, proposal review, dev-team Q&A, estimates
    ├── teltonika/           ← Teltonika technical pack, feature requirements, supplier shortlist
    └── invariants/          ← the codebase CLAUDE.md (9 invariants) + Leader's Field Guide
```

---

## Run the code right now (zero setup)

Requires only **Node.js ≥ 20** (built on 22). No Docker, no Postgres, no install.

```bash
cd telematics
npm run demo      # simulator → ingestion → store → API, end-to-end, with a proof summary
npm test          # 68 tests: protocol, decode, store, tenancy, ingestion, API, scenarios, operability
npm run verify    # spawn the servers for real, replay a scenario, SIGTERM them
npm run sim:list  # the named device scenarios and what each one proves
```

`npm run demo` streams two work sessions from one device that changes hands mid-2025,
then queries the API as each tenant — so you watch attribution and tenant isolation
happen on live data. Full detail in `telematics/README.md`; operating procedures in
`telematics/docs/RUNBOOKS.md`.

---

## What is real vs. simulated (the one thing everyone must know)

**Real and device-accurate** — do not "simplify" these: the TCP framing, the IMEI
handshake, the Codec 8/8E record layout, the CRC-16/IBM, the 4-byte ACK, and the
standard IO IDs 239 (ignition), 240 (movement), 69 (GNSS).

**Simulated placeholder** — needs a hardware decision: total **engine hours**. On
real machines these arrive over the vehicle **CAN bus**, and the IO ID that carries
them depends on the FMC model + CAN adapter *program* for that exact make/model/year.
Choosing and mapping those programs is **open decision D1** (see `ARCHITECTURE.md`
and `BUILD_PLAN.md`). Until D1 is resolved, engine hours are a stand-in counter under
IO ID 200. **Everything else is production-shaped.**

---

## The non-negotiables

Two rules protect real money and real customer data. They are enforced by tests and
must never be "optimised" away:

- **Only sealed ECU engine readings can back an invoice.** Estimated or
  ignition-derived values may inform a display, never a bill.
- **Every read is tenant-scoped, and attribution is resolved at each record's own
  timestamp** — never "as of now". A machine that changed hands mid-month splits
  correctly between the two renters.

The full set of nine correctness invariants lives in `CLAUDE.md` and
`context/invariants/Dozr_GPS_CLAUDE.md`, and each maps to a test in `TESTING.md`.
