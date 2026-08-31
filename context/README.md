# Context — reference documents

Every document the GPS/telematics build depends on, copied here so this folder is
self-contained. Nothing in here is code; it is the *why* and the *what* behind the
code in `../telematics/`.

## How to read the naming

Two eras of documents live side by side, and **both are valid**:

- **`Dozr_*`** — current, post-rebrand. These are authoritative where they exist.
- **`Kasper_*`** — pre-rebrand (Kasper Technologies FZ-LLC was the old name). The
  branding is historical but **the content is not wrong** — these are the detailed
  requirements, architecture, and reviews the current docs were built from. Do not
  rename or rewrite them without asking; treat them as the deep reference behind the
  Dozr-branded summaries.

When a Dozr doc and a Kasper doc cover the same ground, the **Dozr doc wins** on
naming, branding, and current decisions; the Kasper doc usually has more depth.

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
| `Dozr_Platform_Architecture.html` | How GPS fits the wider Dozr platform (Marketplace, Vendor OS, shared spine). |
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
| `Kasper_Teltonika_Technical_Pack.pdf` | **The Teltonika reference.** Device/protocol technical detail behind `../telematics/src/protocol/` and `docs/PROTOCOL.md`. Consult when resolving D1 or adding IO IDs. |
| `Kasper_Teltonika_Feature_Requirements.docx` | What we need the Teltonika units to do (feature-level). |
| `Kasper_IoT_Feature_List.pdf` | Full IoT feature list. |
| `Kasper_Telematics_Supplier_Shortlist.html` | Hardware/connectivity supplier shortlist and comparison. |
| `teltonika_telematics_briefing.docx` | Plain-language briefing on Teltonika telematics. |

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
