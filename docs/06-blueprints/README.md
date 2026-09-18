# AL-BERUNIY OPERATING SYSTEM — Enterprise Architecture Blueprint Package

A print-ready set of **27 A3 landscape blueprints** (420 mm × 297 mm) describing a world-class
Enterprise Operating System for **AL-BERUNIY**, a real-estate development & construction company.

Design lineage (concepts synthesised, not copied): Oracle Fusion Cloud ERP · SAP S/4HANA ·
Primavera / Unifier · Microsoft Dynamics 365 · Procore · Farvision · StrategicERP · ePROMIS.

## How to open
- **Double-click `index.html`** in any modern browser (Chrome / Edge). The cover page links to every sheet;
  a top navigation bar is on every page. Relative CSS (`assets/blueprint.css`) loads automatically.
- All sheets are vector HTML + SVG, so text stays crisp at any zoom and when printed.

## How to export to PDF (one A3 page per blueprint)
1. Open a blueprint (or use the browser's "print" from any sheet).
2. Print → **Destination: Save as PDF**.
3. **Paper size: A3**, **Orientation: Landscape**, **Margins: None**, **Background graphics: ON**.
4. Each `.page` prints as its own A3 sheet (page-break enforced in `@media print`).

> Tip: to produce the whole book as one PDF, print each file, or open them in sequence. Each file is
> independently printable, as required.

## Package contents
| # | Sheet | Connector |
|---|-------|-----------|
| 00 | Package Index (cover + TOC) | — |
| 01 | Enterprise Master Map | — |
| 02 | Organization & Access Architecture | — |
| 03 | Multi-Project Architecture | PROJ-01 |
| 04 | Financial Architecture | FIN-GL-01 |
| 05 | Sales & CRM | SALE-01 |
| 06 | Installments & Collections | COLL-01 |
| 07 | Construction & Project Control | CONST-01 |
| 08 | BOQ & Cost Control | COST-01 |
| 09 | Procurement | PROC-01 |
| 10 | Supplier Management | SUP-01 |
| 11 | Contractor Management | CON-01 |
| 12 | Inventory & Warehouse | WH-01 |
| 13 | Expense Management | EXP-01 |
| 14 | Human Resources | HR-01 |
| 15 | Payroll & Finance | PAY-01 |
| 16 | Document Management | DOC-01 |
| 17 | Workflow & Approvals | WF-01 |
| 18 | Executive Command Center | EXEC-01 |
| 19 | Business Intelligence | BI-01 |
| 20 | AI Core / Intelligence Control Plane | AI-01 |
| 21 | Master Data | MDM-01 |
| 22 | Data & Integration | INT-01 |
| 23 | Security Architecture | SEC-01 |
| 24 | External Portals | PORT-01 |
| 25 | Cross-System Relationship Map | REL-01 |
| 26 | End-to-End Transaction Traceability | TRACE-01 |

## Reading conventions
- **Connector IDs** (e.g. `FIN-AR-01`, `PROC-01`) link a process across sheets — `OUT ▸` leaves a sheet,
  `IN ◂` receives it — so the package works as one interconnected architecture.
- **Three account types are never mixed:** Type A = User/login, Type B = Business Party
  (customer/supplier/contractor/employee), Type C = Financial Ledger account.
- **Color language:** Navy = Governance · Blue = Sales/CRM · Orange = Finance · Red = Construction ·
  Purple = Procurement · Green = Warehouse · Gold = HR · Teal = Data/AI · Gray = Infrastructure.
- Every module sheet carries the same 16-facet strip (Actors → Security) for consistent validation.

## Design principles baked in
IFRS-ready finance · segregation of duties · full audit trail · project data isolation + corporate
consolidation · multi-company / multi-currency / multi-project / multi-language readiness · API-first
integration · RBAC-bounded AI (AI never bypasses permissions) · cloud/HA/DR readiness.

---
*Version 1.0 · 2026-09-17 · Confidential — internal architecture review.*

## Repository location
This package lives under `docs/06-blueprints/`. Open `index.html`; shared stylesheet is `assets/blueprint.css`.


## AI Core / Telegram blueprint update
- Blueprint 20 is the **AI Core / Enterprise Intelligence Control Plane**, spanning every module.
- Blueprint 22 includes the **LLM Model Gateway** and **Telegram Bot API** as first-class integrations.
- The Master Network Workflow shows **Web / Telegram → Identity → AI Core → Knowledge / Typed Tools → Domain Services**.
- AI Core is foundational and evolves with every domain, not a late-stage standalone feature.
