# Context — reference documents

Every document the GPS/telematics build depends on, copied here so this folder is
self-contained. Nothing in here is code; it is the *why* and the *what* behind the
code in `../telematics/`.

## How to read the naming

**The brand is Kasper.** A short-lived "Dozr" rebrand was reversed on 2026-08-31, so
the `Dozr` you see in some filenames is a naming leftover, **not** current branding —
don't read it as authoritative and don't reintroduce "Dozr" in new work. The
filenames are intentionally left as-is; **do not rename or rewrite these files without
asking.**

Two eras of documents live side by side, and **both are valid content**:

- **`Dozr_*`** — written during the brief Dozr period, so these hold the **most recent
  content** (the current handbook, PRD, expert review, invariants). Treat the content
  as current; ignore the "Dozr" in the name.
- **`Kasper_*`** — the older, pre-rebrand docs (Kasper Technologies FZ-LLC). Also
  valid, and usually **deeper** — the detailed requirements, architecture, and reviews
  the newer summaries were built from.

The prefix no longer signals authority. Where a `Dozr_` and a `Kasper_` doc overlap,
the `Dozr_` one is the more recent summary and wins on current decisions; the
`Kasper_` one usually has more depth. New files use plain names (e.g.
`DATASHEET_CROSSCHECK.md`) or their real vendor names (e.g. `Datasheet-FMC130.pdf`).

---

## `requirements/` — what we're building and why

| File | What it is |
|------|------------|
| `Dozr_GPS_PRD.html` | **Current PRD.** The product requirements for the GPS platform — features, `FR-*` requirement IDs the modules map to. Start here for scope. |
| `Dozr_IoT_BRD_Draft_Review.docx` | Business requirements draft/review — the commercial framing (utilisation billing, GPS-as-a-service). Recent. |
| `Kasper_Telematics_Functional_Spec.html` | The **deepest** functional spec (largest doc here). Screen-by-screen and behaviour-level detail. The reference when the PRD is too high-level. |
| `Kasper_GPS_Requirements.html` | Detailed requirements list (pre-rebrand). |
| `03_Kasper_GPS_as_a_Service.docx` | Product spec for the GPS-as-a-Service offering. |
| `04_Kasper_Telematics.docx` | Product spec for the telematics offering. |

## `architecture/` — how the system is shaped

| File | What it is |
|------|------------|
| `Dozr_GPS_Build_Handbook.html` | **Current build handbook.** The engineering north star — components, decisions, sequencing. Read alongside `../ARCHITECTURE.md`. |
| `Dozr_Platform_Architecture.html` | How GPS fits the wider Kasper platform (Marketplace, Vendor OS, shared spine). |
| `Kasper_GPS_Architecture.html` | The **most detailed** architecture doc (pre-rebrand) — deep component and data-flow detail. |
| `Kasper_GPS_Delivery_Plan.html` | Delivery plan / phasing (pre-rebrand). Cross-check against `../BUILD_PLAN.md`. |
| `Dozr_IoT_Architecture.drawio` | Editable architecture diagram (open in diagrams.net / draw.io). |

## `reviews/` — expert scrutiny and open questions

| File | What it is |
|------|------------|
| `Dozr_GPS_IoT_Expert_Build_Review.html` | **Current expert build review (30 Aug 2026).** Key positions: proposed team is ~5× too large (2 engineers + a coordinator is enough), prefer lean Traccar over a full IoT-Core stack, **D1 (CAN engine-hours) is the critical path**, and buy/borrow the first ~6 weeks. Read before staffing or estimating. |
| `Kasper_GPS_Expert_Review.html` | Earlier expert review (pre-rebrand) — background to the current one. |
| `Kasper_GPS_Proposal_Review.html` | Review of an external build proposal. |
| `Kasper_GPS_Dev_Team_Questions.html` | Questions raised by the dev team — useful for anticipating unknowns. |
| `TechTeam_Estimate_Questions.md` | Open questions on the tech team's cost/effort estimate. |

## `teltonika/` — the hardware and the protocol

| File | What it is |
|------|------------|
| `Datasheet-FMC130.pdf` | **Official FMC130 datasheet (primary source, Teltonika © 2022).** The tracker D1 targets: 1 CAN Adapter Input, supports LV-CAN200/ALL-CAN300/CAN-CONTROL, codec 8/8E, Configurator + FOTA. Corroborates the D1 hardware layer. |
| `Datasheet-ALL-CAN300.pdf` | **Official ALL-CAN300 datasheet (primary source, Teltonika © 2019).** The CAN adapter: "Supported by FMC1YX", reads ~100 parameters incl. **"engine lifetime"**, RPM, fuel. Note the per-machine variance caveat. |
| `DATASHEET_CROSSCHECK.md` | **Claim-by-claim verify of the two datasheets against the D1 resolution.** Bottom line: they confirm the hardware layer, no contradictions; the "engine lifetime" ↔ AVL 102 naming gap stays an open Teltonika question; datasheets carry no AVL-ID table, so "102 in minutes" still rests on the parameters-ID wiki. Read with `../../D1_CAN_ENGINE_HOURS.md`. |
| `Kasper_Teltonika_Technical_Pack.pdf` | **The Teltonika reference.** Device/protocol technical detail behind `../telematics/src/protocol/` and `docs/PROTOCOL.md`. Consult when resolving D1 or adding IO IDs. |
| `Kasper_Teltonika_Feature_Requirements.docx` | What we need the Teltonika units to do (feature-level). |
| `Kasper_IoT_Feature_List.pdf` | Full IoT feature list. |
| `Kasper_Telematics_Supplier_Shortlist.html` | Hardware/connectivity supplier shortlist and comparison. |
| `teltonika_telematics_briefing.docx` | Plain-language briefing on Teltonika telematics. ⚠ **Unreliable on parameter IDs** — the D1 work found it wrong (claims AVL 253 = engine hours, AVL 12 = RPM; the official table says 253 = Green driving type, 12 = Fuel Used GPS) and it proposes ignition-time accumulation, which invariant 5 forbids. Treat as background narrative only, not a parameter source. |

## `simulator/` — scenario coverage planning for Module 9

| File | What it is |
|------|------------|
| `VEHICLE_SCENARIOS_PLAN.md` | **Gap analysis: what a real vehicle-mounted Teltonika unit generates that the simulator doesn't yet.** Four tiers by build-readiness (quick wins → needs a new phase but known IDs → needs a D1-style desk investigation first → infrastructure gaps like multi-record packet bursts). Companion to `../../HERMES_HANDOFF_VEHICLE_SCENARIOS_2026-09-02.md`. |

## `invariants/` — the rules that protect money and data

| File | What it is |
|------|------------|
| `Dozr_GPS_CLAUDE.md` | **The source of the nine correctness invariants.** Same rules enforced by the code and mirrored in `../CLAUDE.md`. If code and this doc ever disagree, this doc wins and the code is a bug. |
| `Dozr_GPS_Leaders_Field_Guide.html` | Plain-language teaching guide (living document). The gentlest on-ramp for someone new to the system — start here if the architecture docs feel dense. |

---

## Not included here (and why)

The `LOGISTICS/03_Engineering/Correspondence/` folder from the main repo — vendor
pricing, procurement threads, AWS/SUDO/Teltonika negotiations, internal notes — was
**deliberately left out**. It is commercially sensitive and not needed to build or
test the system. If a procurement detail is ever required (e.g. a confirmed hardware
SKU or a negotiated price), pull it from the main repo rather than duplicating it
into this build folder.
