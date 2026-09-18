# AL-BERUNIY OPERATING SYSTEM — Enterprise Architecture Blueprint Package

**Revision v1.2 — CLIENT APPROVAL CANDIDATE — 2026-09-18**

A print-ready set of **28 A3 landscape blueprints** (420 mm × 297 mm): a client approval cover/index,
the Master Network Workflow, and Blueprints 01–26 describing the AL-BERUNIY Operating System (ABOS)
for a real-estate development & construction company.

This is the **one current blueprint package**. Older revisions live only in git history.

## What changed in v1.2 (the client is approving these changes)
1. AI is now a **system-wide Enterprise Intelligence Core** (BP-20), not a late-stage chatbot.
2. **Every module** connects to the AI Core — each domain sheet (BP-03…BP-15, 21, 24) carries an
   *AI Core & Telegram Contract* strip: typed read tools · draft/action tools → workflow · events → Knowledge Plane · Telegram queries & notifications · hard guardrail.
3. AI knowledge is **security-tagged and permission-controlled** (Enterprise Knowledge Plane, BP-16/20).
4. LLM providers connect only through a central **Model Gateway** (BP-20/22).
5. **Telegram** is a governed operating / AI channel (BP-22, Master Network).
6. Telegram users are **bound to ABOS Type-A identities** via a one-time revocable link (BP-02/23).
7. AI and Telegram **cannot bypass** Finance, workflow, SoD, permissions or audit (BP-04/17/23).
8. AI / Telegram actions are **traceable** to user, model, sources, tool and resulting transaction (BP-26, Scenario 5 + reverse trace B).
9. **All previous business modules remain intact**; Finance remains the only accounting engine.

## New connector IDs (defined in BP-20)
`AI-01` AI Core · `MG-01` Model Gateway · `KP-01` Enterprise Knowledge Plane · `TOOL-01` Typed Tool Registry ·
`MID-01` Machine Identity · `TG-01` Telegram Gateway.

## Arrow semantics (never colour alone)
solid = business process · thick = financial posting · double = master-data sync · dashed = information/reference ·
dotted = notification / audit / AI event · dash-dot = Telegram / channel.

## How to open
- Open `index.html` in Chrome / Edge — the approval cover links to every sheet; a nav bar is on every page.
- All sheets are vector HTML + SVG; relative CSS (`assets/blueprint.css`) loads automatically.

## How to export to PDF (one A3 page per blueprint)
Print → Save as PDF → **A3 · Landscape · Margins None · Background graphics ON**.
Each `.page` prints as its own A3 sheet. No automated export pipeline exists in this repository; the HTML
under `docs/06-blueprints/` is the authoritative editable source.

## Package contents
| # | Sheet | Connector | v1.2 change |
|---|-------|-----------|-------------|
| 00 | Client Approval Cover & Index | — | rewritten: what-changed summary |
| MNW | Master Network Workflow | — | AI Core plane band · Telegram channel · Path E |
| 01 | Enterprise Master Map | — | AI control plane layer · Telegram · Model Gateway |
| 02 | Organization & Access | ORG-01 | AI roles · Machine Identity · Telegram binding |
| 03 | Multi-Project Architecture | PROJ-01 | contract strip: project-scoped AI |
| 04 | Financial Architecture | FIN-01 | contract strip: AI reads, never posts |
| 05 | Sales & CRM | SALE-01 | contract strip |
| 06 | Installments & Collections | COLL-01 | contract strip: risk · Telegram reminders |
| 07 | Construction & Project Control | CONST-01 | contract strip |
| 08 | BOQ & Cost Control | COST-01 | contract strip |
| 09 | Procurement | PROC-01 | contract strip: bid comparison |
| 10 | Supplier Management | SUP-01 | contract strip |
| 11 | Contractor Management | CON-01 | contract strip |
| 12 | Inventory & Warehouse | WH-01 | contract strip |
| 13 | Expense Management | EXP-01 | contract strip |
| 14 | Human Resources | HR-01 | contract strip: protected HR data |
| 15 | Payroll | PAY-01 | contract strip: no AI action tools |
| 16 | Document Management | DOC-01 | rewritten: Knowledge ingestion · Telegram attachments |
| 17 | Workflow & Approvals | WF-01 | rewritten: AI proposal · Telegram approval |
| 18 | Executive Command Center | EXEC-01 | rewritten: Executive AI Copilot |
| 19 | Business Intelligence | BI-01 | rewritten: semantics → Knowledge Plane |
| 20 | AI Core / Enterprise Intelligence Control Plane | AI-01 | **fully reworked** |
| 21 | Master Data | MDM-01 | contract strip |
| 22 | Data · AI Core · Integration Architecture | INT-01 | **fully reworked**: five traffic classes |
| 23 | Security Architecture | SEC-01 | rewritten: AI & Telegram controls |
| 24 | External Portals | PORT-01 | contract strip: own-party Telegram |
| 25 | Cross-System Relationship Map | REL-01 | rewritten: sixth AI/channel flow |
| 26 | End-to-End Transaction Traceability | TRACE-01 | rewritten: Scenario 5 + reverse trace B |

## Reading conventions
- **Three account types** are never mixed: Type A = User/login, Type B = Business Party, Type C = Ledger.
  Telegram binds to Type A; Telegram is not a party; AI provider accounts are not ABOS users; Machine Identity is its own concept.
- **Colour language:** Navy = Governance · Blue = Sales · Orange = Finance · Red = Construction · Purple = Procurement ·
  Green = Warehouse · Gold = HR · Teal = AI Core / Data · Sky = Telegram · Violet = Model Gateway · Gray = Infrastructure.

## Sources of truth
`docs/03-architecture/AI_CORE.md`, `AI_AGENT.md`, `TELEGRAM_INTEGRATION.md`, `SYSTEM_ARCHITECTURE.md`, `SECURITY.md`,
`INTEGRATIONS.md`, `TRACEABILITY.md`, `docs/01-product/USER_ROLES.md`, `docs/00-governance/DECISIONS.md`, `GLOSSARY.md`.
Approval gate: `docs/04-delivery/BLUEPRINT_APPROVAL.md`.

---
*v1.2 · 2026-09-18 · Client Approval Candidate · Confidential.*
