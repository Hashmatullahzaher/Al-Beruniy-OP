# AL-BERUNIY Operating System — Master Implementation Plan

**Document ID:** ABOS-IMP-001  
**Purpose:** Governing implementation contract for the complete AL-BERUNIY Operating System (ABOS).  
**Blueprint baseline:** repository commit `3e3d96bbb3c1ec2cbed0b25444d474525c588444` and the blueprint package under `docs/06-blueprints/`.  
**Status:** Build-ready functional implementation plan; unresolved official policies remain configuration/open items and must not be invented.

---

## 1. Objective

Build one integrated, modular enterprise operating system for AL-BERUNIY that supports independent project operations and financials while also providing authorized corporate consolidation.

The implementation must cover the full approved operating model:

- Executive Command Center
- Organization, identity, users, roles, permissions, project assignments and approval authority
- Multi-company / legal-entity / multi-project hierarchy
- Sales, CRM, unit inventory, pricing, quotations, reservations, contracts and handover
- Installments, collections, receipts, overdue management, customer statements and AR settlement
- Finance: CoA, GL, journals, AR, AP, cash/bank, reconciliation, budgeting, project accounting, cost centers, assets, periods and multi-currency foundations
- Construction and project control
- WBS, schedule, progress, RFI, submittals, QA/QC, HSE, variations, claims and EVM
- BOQ and cost control
- Procurement, supplier management and warehouse/inventory
- Contractor lifecycle, measurement, IPC, retention and advance recovery
- Expense management
- HR, attendance, leave, overtime, payroll and employee self-service
- Documents, versioning, approval, signature, retention and evidence linkage
- Shared workflow and approval engine
- Master data governance
- BI / DWH / reporting
- Permission-bounded AI
- Customer, supplier and contractor portals
- Integration backbone
- Security, audit, migration, backup/restore, UAT and production readiness

No module may be implemented as an isolated application. Every material transaction must connect to identity/access, project scope, workflow, documents where required, finance where applicable, audit, reporting and traceability.

---

## 2. Source-of-Truth and Conflict Order

Builders MUST resolve conflicts in this order:

1. `docs/04-delivery/ACCEPTANCE_CONTRACT.md`
2. `docs/02-domain/BUSINESS_RULES.md`
3. `docs/01-product/PRODUCT_REQUIREMENTS.md`
4. `docs/06-blueprints/`
5. `docs/03-architecture/`
6. this implementation plan and its companion delivery documents
7. implementation code
8. comments / chat / informal notes

When a required policy is unknown, do not guess. Add or preserve it in `docs/00-governance/OPEN_ITEMS.md`, implement it as configuration where possible, and block only the dependent behavior.

---

## 3. Non-Negotiable System Invariants

These rules apply to every phase and every module.

### 3.1 Account separation
Keep the three account concepts separate:

- **Type A — User Account:** authentication/login only.
- **Type B — Business Party:** customer, supplier, contractor, employee.
- **Type C — Financial Ledger Account:** cash, bank, AR, AP, revenue, expense, asset, liability, equity.

A portal login may be linked to one party, and a party may map to a control ledger/subledger relationship, but these objects are never merged.

### 3.2 Mandatory transaction dimensions
Every applicable transaction stores and preserves:

- Company / Legal Entity
- Project
- Department
- Cost Center
- Currency
- Party, when applicable
- Creator
- Approver(s)
- Date/time
- Source record
- Supporting document reference(s), when required
- Workflow status
- Accounting status
- Audit lineage

### 3.3 Financial integrity
- All posted accounting events use balanced double-entry.
- Finance is the authoritative posting engine.
- Posted financial records are immutable.
- Corrections use linked reversal/adjustment records.
- Subledgers reconcile to GL control accounts.
- Project, department and cost-center dimensions propagate into journal lines.
- Financial calculations use deterministic decimal arithmetic.
- External/batch financial writes are idempotent.

### 3.4 Authorization and segregation of duties
- Authorization is enforced server-side below the UI.
- Effective access = role permissions ∩ project assignment ∩ department scope ∩ field-level rules.
- Approval authority includes amount/scope limits.
- Creator, approver, receiver and payer conflicts are blocked where SoD applies.
- Portal users can see only their own party data.
- AI sees only security-trimmed data.

### 3.5 Workflow and side effects
A material side effect may execute only after the required workflow reaches approval. Examples include PO approval, financial posting, payment, discount, cancellation, budget revision, IPC certification, payroll approval and master-data activation.

### 3.6 Traceability
Every material transaction must support both:

- **Forward trace:** source operation → approvals → documents → posting → ledger → report/dashboard.
- **Reverse trace:** KPI/report → transaction → source → party → creator/approver → payment → journal/ledger.

---

## 4. Implementation Method

Every work package follows exactly:

**READ → MAP → IMPLEMENT → TEST → SELF-AUDIT → FIX → COMMIT → HANDOFF**

Before starting a work package, the builder reads:

1. README
2. Acceptance Contract
3. this Implementation Plan
4. `FUNCTIONAL_SCOPE.md`
5. `BUILD_WORK_PACKAGES.md`
6. relevant domain document(s)
7. relevant architecture document(s)
8. relevant blueprint(s)
9. `OPEN_ITEMS.md`

A work package is not complete because screens exist. It is complete only when domain rules, authorization, persistence, workflow, audit, tests and traceability relevant to that package work end-to-end.

---

## 5. Build Line — Start to Finish

The build is intentionally sequenced so downstream modules reuse stable shared foundations.

### F0 — Engineering & Repository Foundation
**Start:** documentation baseline only; no production application foundation.  
**End:** reproducible development environment, application shell, CI quality gates, database migration framework, test harness, configuration/secrets pattern, observability baseline and deployment skeleton exist.

Deliver:
- application workspace / modular project structure
- environment configuration pattern
- dev/staging/prod separation
- database + migration mechanism
- object/document storage abstraction
- API boundary / gateway pattern
- event/outbox pattern for reliable domain events
- background jobs
- logging, correlation IDs and error handling
- unit/integration/E2E test harnesses
- lint/type/schema/secret checks
- seed strategy for non-production data
- health/readiness endpoints
- release metadata carrying exact Git SHA

**Gate F0:** a blank but secure application can build, migrate, test and deploy reproducibly.

### F1 — Identity, Organization, Authorization, Security, Audit, Workflow & Document Foundations
**Start:** F0 gate passed.  
**End:** a real user can authenticate, receive scoped permissions, act only inside authorized company/project/department boundaries, submit an approval, attach/version evidence and produce an immutable audit trail.

Deliver:
- UserAccount
- Role
- Permission
- UserRole
- Department
- ProjectAssignment
- ApprovalAuthority
- authentication/session lifecycle
- MFA/SSO-ready interfaces
- permission engine
- project/department/field access enforcement
- SoD policy engine
- audit records
- login/activity/security logs
- notification foundation
- workflow definition + instance + step + action
- sequential / parallel / conditional / amount / project / department / role routing
- reject / return / cancel / delegate / escalate
- document metadata, upload, versioning, review, approval, signature hooks, publish/supersede/archive, retention metadata
- approval inbox

**Gate F1:** negative authorization tests fail closed; a requester cannot approve a conflicting own transaction; all approval/document actions are traceable.

### F2 — Master Data & Multi-Project Operating Structure
**Start:** F1 passed.  
**End:** governed master data and the complete AL-BERUNIY project hierarchy are available to all modules with project isolation and authorized consolidation.

Deliver:
- Company / LegalEntity
- Project → Phase → Zone → Block/Tower/Building → Floor → Unit
- Department
- CostCenter
- Currency
- Bank
- Material / Service
- Warehouse
- DocumentType
- Party master foundation
- configurable policy/master registries
- data-steward ownership
- master approval/activation lifecycle
- deduplication controls
- version/effective-date history where required
- project switcher and project context
- corporate/project view context
- project-scoped query enforcement

**Gate F2:** two projects can operate without cross-project data leakage, while an authorized corporate role can query both.

### F3 — Finance Kernel
**Start:** F2 passed.  
**End:** all subsequent modules have a production-grade posting target.

Deliver:
- corporate Chart of Accounts
- legal-entity books
- LedgerAccount
- Journal / JournalLine
- journal validation, approval, posting and reversal
- accounting periods open/close
- AR subledger foundation
- AP subledger foundation
- contractor payable / retention / advance ledgers
- employee payable foundation
- cash and bank accounts
- bank transaction/reconciliation foundation
- budget and commitment ledger
- project accounting
- cost-center accounting
- multi-currency transaction fields and FX extension points
- tax-code extension points
- asset register + depreciation framework
- accrual/prepayment/advance primitives
- accounting rule registry used by domain modules
- finance drill-down to source

**Gate F3:** balanced journals post and reverse correctly; closed periods reject posting; subledger control totals reconcile; project trial balance and P&L can be generated from seeded transactions.

### F4 — Sales, CRM, Unit Inventory, Pricing & Contracts
**Start:** F3 passed.  
**End:** a lead can become a contracted buyer against controlled unit inventory and produce the required AR/accounting intent.

Deliver:
- lead management and assignment
- qualification / KYC
- opportunity
- customer party profile
- live unit availability
- price lists
- quotation
- discount request/approval
- reservation + expiry behavior
- sales contract
- contract documents/e-signature integration
- contract amendment/versioning
- cancellation/refund workflow hooks
- unit transfer workflow
- commission basis
- customer-service case/ticket foundation
- unit status transitions: Available → Reserved → Sold → Handed-over
- sales-to-finance posting command/events
- sales reports and pipeline
- role restrictions for sales users

**Gate F4:** duplicate/conflicting unit sale is prevented; discount authority is enforced; contract traces to customer, unit, project, documents, approvals and finance.

### F5 — Installments, Collections, Receipts, AR Settlement & Handover Gate
**Start:** F4 passed.  
**End:** contract value can be scheduled, collected, reconciled and evaluated for handover eligibility.

Deliver:
- installment plan construction
- dated installment schedule
- down payment/frequency/custom schedule support
- receivable generation
- collection work queue
- receipt numbering
- bank/cash receipt
- partial payment allocation
- advance payment handling
- outstanding/overdue/aging
- reminder/escalation
- promise-to-pay
- configurable penalty
- waiver approval
- rescheduling/re-amortization + reapproval
- bounced/disputed collection exception handling
- customer statement
- collection history timeline
- legal-escalation hooks
- AR settlement
- handover eligibility gate
- receipt → finance posting and reverse trace

**Gate F5:** receipt updates AR and bank/cash correctly; subledger reconciles to GL; handover remains blocked when configured eligibility conditions are not satisfied.

### F6 — Construction, WBS, BOQ, Budget & Cost Control
**Start:** F5 and finance kernel stable.  
**End:** physical project progress and financial project cost are connected.

Deliver:
- WBS and activities
- baseline and schedule
- milestone structure
- resource references
- daily reports
- progress measurement
- RFI
- submittals
- QA/QC inspections and NCR
- HSE permits/incidents
- site instructions
- variation/change orders
- claims and delay/EOT records
- forecasting and CTC
- EVM measures: PV, EV, AC, EAC; CPI/SPI where inputs exist
- BOQ and BOQ items
- quantity × unit × rate
- rate build-up structure
- budget baseline and revision
- committed / actual / forecast / EAC model
- overrun alerts
- source-cost drill-down

**Gate F6:** budget, commitments, actuals and forecast are traceable to project/WBS/BOQ/source transactions; variation approval updates the intended budget/contract state.

### F7 — Procurement, Supplier & Warehouse
**Start:** F6 passed.  
**End:** a site requirement can become a paid supplier purchase, with goods physically received, stored, issued and costed.

Deliver:
- purchase requisition
- PR approval
- RFQ
- supplier invitations
- quotations
- technical/commercial evaluation
- bid comparison
- supplier selection
- PO/contract
- commitment creation
- supplier registration/KYC/category/prequalification
- supplier status: approved/suspended/blacklisted with approval
- supplier performance
- delivery
- inspection
- GRN
- supplier invoice
- duplicate-invoice controls
- 3-way match
- mismatch/hold/resolution flow
- supplier AP/payment status
- material master
- warehouses/locations/bins
- stock in/out
- material request
- issue to project/WBS
- transfer
- return
- adjustment
- damaged/scrap
- reorder trigger
- reserved stock
- batch/serial support
- barcode/QR extension
- counts and variances
- valuation-policy extension point
- inventory/project-cost postings

**Gate F7:** PR → RFQ → PO → GRN → invoice → 3-way match → payment completes with SoD and all expected commitment/inventory/AP/GL effects.

### F8 — Contractor Lifecycle & IPC
**Start:** F6 and F3 stable; F7 may already be complete.  
**End:** measured contractor work becomes certified payable, deductions and payment with project-cost traceability.

Deliver:
- contractor party/KYC/prequalification
- tender / bid / award
- contractor contract and BOQ scope
- mobilization advance
- work/progress linkage
- QS measurement
- engineer verification
- PM certification
- IPC build-up
- retention
- advance recovery
- approved variation inclusion
- penalty/LD extension point
- claims
- completion / DLP
- retention release
- final payment
- contractor evaluation
- contractor portal-facing data services
- accounting postings for advance, IPC, retention, recovery and payment

**Gate F8:** QS → Engineer → PM → Finance → CFO chain can certify and pay an IPC; retained/advance balances reconcile and drill back to the certificate and measurements.

### F9 — HR, Payroll, Expense & Assets
**Start:** F3, F1 and F2 stable.  
**End:** employee lifecycle, payroll and operating expenses post correctly by project/department/cost center.

Deliver HR:
- recruitment requisition/vacancy
- candidate
- screening/interview
- offer/onboarding
- employee party + optional user/ESS
- employee contract
- position
- department/project assignments
- attendance
- shift/roster
- leave
- overtime
- performance
- training
- disciplinary records
- loan/advance
- exit/clearance
- employee documents
- ESS views/actions

Deliver Payroll:
- salary structure
- pay components
- period inputs
- deterministic calculation
- gross/net output
- deductions/allowances/loan recovery
- HR + Finance dual approval
- payslip
- bank file
- project/department/cost-center allocation
- payroll journal
- employee payable and payment
- locked-run behavior and off-cycle correction

Deliver Expense:
- request
- project/department/cost-center tagging
- evidence
- budget check
- tiered approval
- finance coding review
- cash/bank/payable settlement
- staff-advance settlement

Deliver Assets:
- asset register
- acquisition
- project/location assignment
- depreciation framework
- transfer/disposal extension points
- accounting linkage

**Gate F9:** payroll and expenses reconcile to finance, confidential fields are protected, and project cost allocation is traceable.

### F10 — BI, Reporting & Executive Command Center
**Start:** core transactional modules produce stable data.  
**End:** management can consume reconciled project/corporate information and drill down to source.

Deliver:
- operational reporting layer
- DWH/analytics ingestion foundation
- conformed dimensions
- semantic measures
- row/field/project security in analytics
- executive portfolio dashboard
- finance dashboards
- sales dashboards
- collections aging/DSO
- construction progress/SPI/CPI
- cost BAC/committed/actual/CTC/EAC
- procurement spend/cycle time
- warehouse stock value/turns/variance
- HR/payroll analytics
- supplier/contractor scorecards
- filters, project/period comparison
- exports
- scheduled reports
- data freshness/completeness checks
- GL reconciliation checks
- Executive Command Center
- Project-Level ↔ Corporate Consolidated toggle
- Company → Project → Department/Cost Center → Transaction drill-down
- risk/attention panel using rules before predictive AI is enabled

**Gate F10:** headline KPIs reconcile to source transactions and GL where applicable; every material executive number drills to evidence and audit lineage.

### F11 — External Portals, Integrations & AI
**Start:** relevant internal domain services are stable.  
**End:** external users and connected systems use the same governed domain rules; AI operates only within permissions.

Customer Portal:
- contracts
- installments/balance
- payments
- statements
- receipts
- own documents
- support
- notifications

Supplier Portal:
- RFQs
- quotations
- POs
- delivery notices
- invoices
- payment status
- own documents
- performance

Contractor Portal:
- contracts/BOQ
- progress/measurement submission
- IPC visibility
- variations/claims
- payment status
- documents

Integration Backbone:
- API gateway/versioning/rate limiting
- OAuth2/OIDC integration boundary
- event bus/message queue
- webhook security/retries
- idempotency
- dead-letter/replay
- bank statement/payment file adapters
- payment-gateway adapter
- email/SMS/WhatsApp adapter
- schedule (Primavera/MS Project) adapter
- BIM/Revit adapter
- biometric attendance adapter
- barcode/QR adapter
- government/tax adapter extension points
- legacy migration/import interfaces

AI:
- User → Permission Engine → typed tool/domain service → authorized data
- contextual copilot
- natural-language query over authorized data
- executive summaries
- document AI hooks
- cash-flow/sales/collection/cost/delay/supplier-risk model interfaces
- anomaly and duplicate-invoice signals
- explanation/source references
- prompt/output/scope audit
- human-in-the-loop for every action
- no arbitrary SQL and no direct accounting posting

**Gate F11:** portal own-party negative tests pass; integrations are secure/idempotent/audited; AI cannot retrieve or act outside the user's authorization.

### F12 — Hardening, Migration, UAT & Production Readiness
**Start:** F0–F11 gates passed for target release scope.  
**End:** exact-SHA release approved for production with rollback/restore evidence.

Deliver:
- performance/load tests
- authorization penetration/negative test suite
- dependency/secret scanning
- accessibility/browser review for required workflows
- migration dry runs
- data-quality/reconciliation reports
- backup + isolated restore test
- DR procedure after RPO/RTO policy is approved
- logging/metrics/alerts
- support/runbooks
- admin/security operating procedures
- access recertification procedure
- release/rollback procedure
- end-user training/UAT data
- browser UAT of the five primary end-to-end journeys
- severity triage and remediation
- exact-SHA release candidate
- production verification checklist

**Gate F12 / Release:** no blocker-level security, financial-integrity, data-loss, privacy or unrecoverable correctness defect remains open.

---

## 6. Canonical End-to-End Build Journeys

The following journeys are mandatory integration milestones and cannot be replaced with isolated module demos.

### J1 — Customer sale to cash
Lead → Customer/KYC → Unit → Quote/Discount Approval → Reservation → Contract → Installment Schedule → Receivable → Receipt → Bank/Cash → AR Settlement → Journal → GL → Customer Statement → Handover Eligibility → Executive Dashboard.

### J2 — Procure to pay and consume
Site Material Request → PR → Approval → RFQ → Supplier Quote → Bid Comparison → Supplier Selection → PO → Commitment → Delivery → Inspection → GRN → Inventory → Material Issue → Project Cost → Supplier Invoice → 3-Way Match → AP → Payment → Bank → GL → Cost/Executive Dashboard.

### J3 — Contractor work to payment
Contractor → Contract/BOQ → Work → Measurement → Engineer Verification → PM Certification → IPC → Retention/Advance Recovery → Contractor Payable → Payment → Project Cost → GL → EAC/Executive Dashboard.

### J4 — Employee to payroll
Employee → Attendance/OT/Leave → Payroll Calculation → HR Approval → Finance Approval → Payslip → Employee Payable → Bank Payment → Project/Department/Cost-Center Allocation → Payroll Expense → GL → Executive/Cost Dashboard.

### J5 — Executive reverse drill-down
KPI → Project → Department/Cost Center → Transaction → Source Request/Contract/PO/GRN/Invoice/IPC/Receipt → Party → Supporting Document → Creator → Approver → Payment/Bank Transaction → Journal → Ledger Account.

---

## 7. Shared UX/Application Shell Requirements

The complete application shell must provide:

- Company / Legal Entity context when applicable
- Project Switcher
- Current Project indicator on all project-scoped transactional pages
- Module navigation
- breadcrumb
- global search
- recent/favorites extension point
- notification center
- Approval Inbox
- task/work queue
- contextual documents
- contextual activity/audit timeline
- contextual AI entry point after F11
- user/session menu
- authorization-aware action visibility

UI visibility is convenience only; API/domain authorization remains authoritative.

---

## 8. State, Status and Action Discipline

Every controlled entity must define:

- lifecycle state
- allowed transition
- actor/permission required
- validation preconditions
- workflow requirement
- side effects
- accounting effect
- document requirement
- audit event
- reversal/correction path

No builder may implement a status as a cosmetic label without enforcing its transition rules.

At minimum, shared controlled records support the concepts needed by the blueprints: Draft/Submitted/In Review/Approved/Rejected/Returned/Cancelled/Executed or domain equivalents. Financial posting adds Posted/Reversed. Documents add Approved/Signed/Published/Superseded/Archived. Exact domain state names belong in the functional specification and code schema; they must not weaken the approved lifecycle.

---

## 9. Configuration vs Code

The following must be configuration/policy driven rather than hard-coded because official values remain unresolved:

- approval thresholds
- final role matrix and approval authorities
- fiscal calendar/base currencies
- final CoA/cost centers
- IFRS revenue-recognition election/rules
- inventory valuation policy
- tax/statutory rules
- reservation/discount/penalty/waiver/refund/reschedule rules
- handover policy
- RFQ/bid rules
- 3-way-match tolerances
- contractor retention/advance/DLP rules
- payroll/leave/overtime policies
- cloud/region/IdP/provider choices
- bank/payment/messaging/BIM/biometric connectors
- RPO/RTO
- AI provider/data-residency constraints

The code must provide safe extension/configuration points and sensible validation, but must not fabricate official numbers or legal/accounting policy.

---

## 10. Definition of Ready (DoR)

A work package may start only when:

- predecessor work packages are merged
- required blueprint/domain sections are identified
- required entities/actions are listed
- open items are identified
- no unresolved item prevents the core behavior
- expected tests are listed
- required accounting/authorization/workflow effects are mapped

---

## 11. Definition of Done (DoD)

A work package is done only when all applicable items are true:

- schema/migrations implemented
- domain model and invariants implemented
- service/API behavior implemented
- authorization enforced server-side
- project/department/field scope enforced
- workflow integrated when required
- documents/evidence integrated when required
- accounting command/posting integrated when required
- audit emitted
- notifications emitted when required
- UI screens/actions operational
- empty/loading/error/no-permission states handled
- unit tests pass
- integration tests pass
- E2E/browser tests pass for the package
- negative authorization/SoD tests pass
- financial reconciliation tests pass where applicable
- forward/reverse trace works where applicable
- no secrets/hard-coded official policy
- documentation updated
- self-audit completed
- exact commit SHA recorded

---

## 12. Blocker Classification

A defect is a release/build blocker when it can cause:

- unauthorized access or cross-project/party leakage
- bypass of SoD or approval authority
- unbalanced or duplicate financial posting
- silent loss/corruption of transactional data
- inability to trace posted finance to its source
- editing posted financial history instead of reversal
- portal access to another party's data
- AI access beyond the user's scope
- unrecoverable migration/restore failure
- payroll or collection calculation corruption
- stock/cost quantities becoming materially inconsistent without trace
- production secrets exposed in source/logs

---

## 13. Build Governance & Commit Discipline

Each work package commit/handoff reports:

- Work Package ID
- implemented scope
- relevant Blueprint IDs
- acceptance criteria addressed
- migrations introduced
- tests run + results
- known non-blocking gaps
- open items
- exact branch
- exact commit SHA

Do not mix unrelated modules in one implementation commit unless the work package explicitly spans them.

---

## 14. Companion Delivery Documents

This master plan is intentionally split from the exhaustive page/action matrix and the exact agent execution queue:

- `docs/04-delivery/FUNCTIONAL_SCOPE.md` — every module/page and the functional responsibility/actions it must include.
- `docs/04-delivery/BUILD_WORK_PACKAGES.md` — exact sequential work-package queue with dependencies and finish conditions.
- `docs/04-delivery/TRACEABILITY_MATRIX.md` — blueprint/acceptance/build mapping.
- `docs/00-governance/OPEN_ITEMS.md` — unresolved official policies that builders must not invent.

Together these documents define where implementation starts, what is built at each step, what "complete" means, and where the first production release line ends.

---

## 15. Final Build Boundary

**Implementation START:** F0/WP-0001 after this plan and supporting scope/work-package documents are accepted as the build contract.

**Implementation END:** F12 release gate after all in-scope work packages are complete, integration journeys J1–J5 pass, security/financial reconciliation/restore/UAT evidence is accepted, and an exact Git SHA is approved for release.

Anything beyond that boundary is a controlled next release, not an undocumented extension of Release 1.
