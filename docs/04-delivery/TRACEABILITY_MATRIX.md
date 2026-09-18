# AL-BERUNIY Operating System — Traceability Matrix

**Document ID:** ABOS-TRC-001  
**Purpose:** Map blueprint intent and acceptance domains to implementation phases/work packages and proof.

| Domain / Capability | Blueprint | Acceptance | Build Phase / Work Packages | Required Proof |
|---|---|---|---|---|
| Identity / User Account | BP-02, BP-23 | A1 | F1 / WP-0101 | login/session/MFA-ready, negative auth tests |
| Roles / Permissions | BP-02, BP-23 | A1 | WP-0103 | permission matrix + server-side denial |
| Project Scope | BP-02, BP-03, BP-23 | A1/A2 | WP-0104, WP-0208 | cross-project denial + corporate rollup |
| Approval Authority / SoD | BP-02, BP-17 | A1/A8 | WP-0105, WP-0107..0108 | creator/approver/payer conflict tests |
| Audit | BP-23, BP-26 | A1/A8/A10 | WP-0106 | immutable event chain |
| Workflow | BP-17 | A8 | WP-0107..0108 | sequential/parallel/conditional/tiered flows |
| Documents | BP-16 | A8 | WP-0109..0110 | version/approval/sign/archive/source links |
| Master Data | BP-21 | A2 | F2 | governed masters + duplicate controls |
| Multi-Project | BP-03 | A2 | WP-0202, WP-0207..0208 | isolated project data + consolidated query |
| Finance / GL | BP-04 | A4 | F3 | balanced posting, reversal, period lock |
| AR | BP-04, BP-06 | A3/A4 | WP-0305, F5 | AR-control reconciliation |
| AP | BP-04, BP-09 | A4/A6 | WP-0306, F7 | AP-control reconciliation |
| Cash / Bank | BP-04 | A4 | WP-0307..0308 | bank/cash ledger + reconciliation |
| Budget / Project Accounting | BP-04, BP-08 | A4/A5 | WP-0309..0310, F6 | budget/commitment/actual/project P&L |
| Fixed Assets | BP-04 | A4 | WP-0311, WP-0921..0922 | asset→depreciation→GL |
| Sales / CRM | BP-05 | A3 | F4 | lead→contract with unit-state control |
| Installments / Collections | BP-06 | A3 | F5 | schedule→receipt→AR→bank→GL |
| Handover | BP-05, BP-06 | A3 | WP-0411, WP-0511 | eligibility gate |
| Construction | BP-07 | A5 | F6 | WBS/schedule/progress/quality/variation |
| BOQ / Cost | BP-08 | A5 | F6 | BAC→commit→actual→CTC→EAC |
| Procurement | BP-09 | A6 | F7 | PR→RFQ→PO→GRN→match→pay |
| Supplier | BP-10 | A6 | F7 | KYC/prequal/performance/AP linkage |
| Warehouse | BP-12 | A6 | F7 | stock movement + project-cost posting |
| Contractor / IPC | BP-11 | A6 | F8 | measure→IPC→retention→payable→payment |
| Expense | BP-13 | A4/A7 | F9 | request→budget→approval→payment→GL |
| HR | BP-14 | A7 | F9 | employee lifecycle + field security |
| Payroll | BP-15 | A7 | F9 | deterministic calc→dual approval→allocation→GL |
| BI | BP-19 | A9 | F10 | secured/reconciled dashboards |
| Executive Command Center | BP-18 | A9 | F10 | company/project KPI + drilldown |
| AI Core / LLM Gateway | BP-20, BP-22 | A9 | F1A + F11 | provider connection, knowledge ingestion, typed tools, source grounding, AI audit |
| Data / Integration | BP-22 | A9/A10 | F11 | idempotency/retry/DLQ/audit |
| Telegram AI Channel | BP-20, BP-22 | A9 | F1A + F11 | identity binding, webhook security, permission-trimmed AI, step-up/workflow, message audit |
| External Portals | BP-24 | A9 | F11 | own-party security |
| Cross-System Relationships | BP-25 | A0-A9 | all | no orphan module; finance/workflow/docs/audit links |
| Transaction Traceability | BP-26 | A3-A9 | all, especially F10 | forward + reverse trace J1–J6 |
| Security Hardening / DR / UAT | BP-23 | A10 | F12 | scans, restore, UAT, release SHA |

---

## Canonical Requirement IDs

Builders should attach requirement IDs to tests/PR notes where possible.

### Governance / Access
- REQ-AUTH-001 User, party and ledger account objects remain distinct.
- REQ-AUTH-002 Authorization is server-side.
- REQ-AUTH-003 Project isolation is enforced.
- REQ-AUTH-004 Department/field scope is enforced where configured.
- REQ-AUTH-005 Approval authority is scope/amount aware.
- REQ-AUTH-006 SoD blocks conflicting duties.

### Financial Integrity
- REQ-FIN-001 Every posted journal balances.
- REQ-FIN-002 Posted journals are immutable.
- REQ-FIN-003 Correction uses reversal/adjustment.
- REQ-FIN-004 Subledgers reconcile to control accounts.
- REQ-FIN-005 Project/department/cost-center dimensions propagate.
- REQ-FIN-006 Closed periods reject posting.
- REQ-FIN-007 Financial writes are idempotent.

### Traceability
- REQ-TRC-001 Source→workflow→document→posting→ledger trace exists.
- REQ-TRC-002 KPI→transaction→source reverse trace exists.
- REQ-TRC-003 Creator/approver/party/project/cost-center are recoverable.
- REQ-TRC-004 Supporting evidence is linked where required.

### Portal / AI
- REQ-PORT-001 Portal user sees own party only.
- REQ-AI-001 AI uses permission-trimmed context.
- REQ-AI-002 AI actions use typed domain tools/services.
- REQ-AI-003 AI cannot post directly or run arbitrary SQL.
- REQ-AI-004 AI prompt/context/output audit is retained.
- REQ-AI-005 All LLM providers are accessed only through the central Model Gateway.
- REQ-AI-006 Enterprise Knowledge Plane objects retain source/version/security tags and are re-authorized at query time.
- REQ-AI-007 Every major domain exposes typed AI tools and AI-indexable events/read projections.
- REQ-TG-001 Telegram identity is bound to an authenticated ABOS Type A UserAccount.
- REQ-TG-002 Telegram requests reuse ABOS RBAC/project/department/field/party authorization.
- REQ-TG-003 High-risk Telegram actions cannot bypass step-up/workflow/SoD.
- REQ-TG-004 Telegram webhook/message/action delivery is idempotent and audited.

### Operations
- REQ-OPS-001 Releases identify exact Git SHA.
- REQ-OPS-002 Backups are restorable.
- REQ-OPS-003 Production secrets are externalized.
- REQ-OPS-004 Migration is reconcilable.
- REQ-OPS-005 Blocker defects prevent release.

---

## Journey Coverage

| Journey | Required Packages | Acceptance Evidence |
|---|---|---|
| J1 Sale→Cash | F2, F3, F4, F5 | contract/unit lock, AR, receipt, bank, journal, handover, dashboard |
| J2 Procure→Pay | F2, F3, F6, F7 | PR approval, PO commitment, GRN, stock, issue cost, invoice match, AP/payment |
| J3 IPC→Payment | F3, F6, F8 | measurement, certification, retention/advance, payable/payment/project cost |
| J4 Payroll→Allocation | F2, F3, F9 | attendance inputs, deterministic payroll, approval, bank, allocation, GL |
| J5 Executive Reverse Trace | F10 + all source modules | KPI→source→party→docs→approvers→payment→journal→ledger |
| J6 Telegram AI Channel | F1A + F11 + relevant domains | Telegram identity→AI run→source/tool→domain/workflow→audit→response |

---

## Completion Standard

No acceptance domain is complete until the corresponding rows above have:
- working implementation,
- automated tests where feasible,
- negative authorization tests where relevant,
- reconciliation proof where financial,
- browser/E2E proof for key user journeys,
- exact SHA recorded in the handoff.
