# Dozr GPS / Telematics — device-data backend

The backend that receives data from Teltonika devices on construction machines,
turns it into trustworthy records, and serves them to the `fleet-v2` dashboard.
Its reason to exist is a **billing-grade utilisation number that survives a
dispute** — not a map with dots on it.

> **Where this file goes.** This is the intended `CLAUDE.md` for the GPS code
> repository. It currently lives in `LOGISTICS/03_Engineering/` as a draft
> alongside its companion docs. Copy it to the root of the GPS code directory
> (see "Where things live") as `CLAUDE.md` once that directory is scaffolded —
> **confirm the location and stack with afzl before scaffolding.**

## Scope

- **Device-data layer only.** This is NOT the Marketplace or Vendor OS — those
  are separate products with their own specs. Don't pull their concerns in here.
- **The dashboard already exists.** `fleet-v2/` is a finished 9-screen frontend
  (Fleet Map, Fuel, Maintenance, Geofences, Utilisation, Cost & ROI, Reports,
  Timesheet, Alerts Center) running on mock data with Dozr brand tokens. The job
  is to feed it real data — **wire it to the live API, don't rebuild it.**
- **The backend is greenfield.** Nothing is committed in code yet.

## Companion documents (read before non-trivial work)

- `Dozr_GPS_PRD.html` — **what** to build: requirements by module (FR-* IDs),
  non-functional targets, data model outline, acceptance criteria, open
  decisions D1–D11. Authoritative on scope.
- `Dozr_GPS_Build_Handbook.html` — **who and how**: resources, roles, modules,
  the plan, the tools/open-source catalog, and the build-vs-buy recommendation.
- `Dozr_GPS_IoT_Expert_Build_Review.html` — the **why** behind the architecture.
- This file (`CLAUDE.md`) — the **invariants** any change must preserve.
  When the PRD and this file appear to conflict: PRD wins on scope, this file
  wins on the correctness invariants below.

## Where things live (PROPOSED — confirm before scaffolding)

```
telematics/                 # GPS/telematics backend (proposed name)
  ingestion/                # device socket, Codec 8E parse, ACK-after-durable-write
  decode/                   # AVL + CAN decode, program numbers, normalization
  model/                    # Postgres schema, RLS, dated assignment windows
  enrichment/               # geofence, state detection, rules, alerts
  ledger/                   # utilisation computation + sealed evidence records
  api/                      # read API the dashboard consumes (via Supabase)
  messaging/                # WhatsApp Cloud API integration
  infra/                    # Docker Compose, CI, observability config
  tests/                    # traffic simulator, durability/RLS/reconciliation tests
fleet-v2/                   # EXISTING dashboard (9 screens) — consumer of the API
```

This layout mirrors the module decomposition in the handbook (modules 1–9).
`telematics/` is a working name — confirm it, and the repo boundary (same repo as
`fleet-v2/` vs separate), before creating anything.

## Stack (RECOMMENDED, not yet committed — see ROADMAP.md / the review)

- **Ingestion:** Traccar (Apache-2.0) terminates Codec 8/8E out of the box for
  the pilot. Migrate to a custom Go gateway ONLY when engine hours bill
  externally (a later phase, not pilot scope).
- **Data:** PostgreSQL + PostGIS + TimescaleDB hypertable for position history;
  immutable object storage (S3-compatible) for the raw/evidence cold tier.
- **App layer:** Supabase (auth, Postgres, row-level security, storage, APIs) —
  matches the three existing Dozr MVPs. Lowest-friction choice; stay on it.
- **Frontend:** Vanilla HTML/CSS/JS + MapLibre GL JS, consistent with `fleet-v2/`
  and the other MVPs. No framework, no build step unless a real need appears.
- **Packaging:** Docker + Docker Compose. **Region is decision D3** (DigitalOcean
  vs AWS `me-central-1`/`me-south-1` for UAE data residency) — don't hardcode it.

## The telemetry contract — invariants you must NEVER break

These are the properties that make the product sellable. Breaking any one
produces a *silently wrong billing number*, which is worse than an outage. Treat
them as non-negotiable; if a change appears to require breaking one, stop and
flag it.

1. **Acknowledge only after durable write.** The device deletes its only copy of
   a record when the server ACKs. Never ACK a frame until all its records are
   durably persisted. A premature ACK is permanent, invisible data loss. (FR-ING-3)
2. **Idempotent ingest.** A device re-sends its buffer after a missed ACK.
   Dedupe on record identity so this never double-counts. (FR-ING-4)
3. **NULL ≠ zero.** "We didn't receive a value" is not "the value was zero."
   Preserve and surface the distinction everywhere. (FR-DEC-5)
4. **`ecu` and `estimated` engine hours never merge.** Label every engine-hours
   value by source. CAN-derived (`ecu`) and derived/`estimated` are different
   kinds of fact and must stay separated in storage and on screen. (FR-DEC-4)
5. **The ignition-counter fallback is never billing evidence.** Utilisation
   billed to a customer must come from `ecu` engine hours. Estimated values may
   inform a display; they may never back an invoice. (FR-LED-1)
6. **Resolve attribution at each record's own timestamp.** A machine changes
   hands mid-period; bill each party only for their window. Attribute every
   record using the assignment that was in force at *that record's* `ts_ms` —
   never "as of now." (FR-MOD-2)
7. **Row-level security, always, no exception path.** Every read and write is
   tenant-scoped. One tenant seeing or being billed for another's assets is
   trust-ending. (FR-MOD-1)
8. **Sealed utilisation records are immutable, with a provable evidence chain.**
   A sealed record links to its raw frames via a tamper-evident manifest, is
   retained 7 years, and can produce a full dispute pack on demand. Never mutate
   a sealed record. (FR-LED-3, FR-EVID-1/2/3)
9. **Unlisted machine ⇒ position + ignition only.** If a make/model/year has no
   supported CAN program (D1), store location and ignition and flag the asset
   "no engine data" — do not fabricate or infer engine hours for it. (FR-DEC-2)

## Brand tokens (for any fleet screen work — NON-NEGOTIABLE)

Match `LOGISTICS/05_Brand_Design/Dozr_Brand_Guidelines.html` and `fleet-v2/`.

- Colors: ink `#141518` · yellow `#FFC400` (accent, sparingly) · yellow-tint
  `#FFF6D6` · yellow-dark `#E6AF00` · canvas `#F6F6F3` · surface `#FFFFFF` ·
  slate `#5B5F66` · line `#E8E8E3` · green `#1F9A6D` · error `#D64545`
- Type: **Space Grotesk** (headings) · **Hanken Grotesk** (body) · **Space Mono**
  (labels/technical UI)
- Radius: buttons `10px` · cards `16px` · chips `999px`. Spacing grid: `8px`.
- Never invent colors/fonts outside this set. If a design needs something not
  listed, flag it — don't improvise and call it brand-compliant.

## Build / test

No build, lint, or test commands exist yet — this is pre-code. **Do not invent
them.** When the repo is scaffolded, add the real commands here so future agents
use the project's actual workflow. The PRD names the four tests that matter and
should exist before pilot acceptance: a device-traffic simulator, a
kill-the-server-mid-stream durability test, an RLS isolation test, and an
engine-hours reconciliation against the machine's own meter.

## Working style

- **afzl builds it himself.** Claude's role is research, wireframes, and expert
  review at each step — not unilateral execution. Propose and confirm; don't
  scaffold or make architectural commitments alone.
- **Stay in GPS scope.** This track is GPS/telematics only — not Marketplace or
  Vendor OS.
- **Confirm before scaffolding** any new directory, dependency, or stack choice.
- **Kasper-named legacy docs are historical** (pre-rebrand), not wrong — don't
  rename or rewrite them without asking.
- **External figures are unconfirmed.** Device/adapter prices, SIM tariffs, and
  throughput numbers in the companion docs were prepared without web access —
  confirm at source (Teltonika, telco, project quotes) before they drive a spend.
