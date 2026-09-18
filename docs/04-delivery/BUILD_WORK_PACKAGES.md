# AL-BERUNIY Operating System — Build Work Packages

**Document ID:** ABOS-WP-001  
**Purpose:** Exact execution queue for builders. Work must move in this order unless a dependency exception is explicitly approved.

---

## Execution Rules

For every work package:

1. Read the referenced blueprint/domain/architecture docs.
2. Map acceptance criteria and open items.
3. Implement working code, migrations, APIs, UI and tests.
4. Self-audit against the package finish conditions.
5. Fix failures before handoff.
6. Commit only the work-package scope.
7. Report exact branch + SHA + tests + known gaps.

Do not begin a downstream work package if its hard predecessor has not passed.

## Cross-Cutting AI Exposure Rule
Beginning with F1A, every domain work package must also preserve the AI contract:
- publish/update typed read tools
- publish draft/action tools where appropriate
- emit domain events
- maintain an AI-indexable read projection
- include source IDs/deep links
- carry permission/security metadata
- link documents/evidence
- write AI/tool audit hooks

AI enablement is therefore built with each module, not postponed until the end.

---

# PHASE F0 — Engineering Foundation

## WP-0001 Repository / Application Skeleton
**Depends on:** none  
**Scope:**
- application workspace
- module/package layout
- environment config
- dev/staging/prod profiles
- exact-SHA build metadata
- health/readiness endpoint
- base README/developer run instructions

**Finish condition:** clean clone can install/build/start locally.

## WP-0002 Database & Migration Foundation
**Depends on:** WP-0001  
**Scope:**
- primary OLTP database connection
- migration tooling
- transaction pattern
- deterministic decimal type usage
- test database strategy
- seed/factory strategy

**Finish condition:** migrations can run up/down or forward with documented rollback/restore strategy.

## WP-0003 API / Service Boundary
**Depends on:** WP-0001, WP-0002  
**Scope:**
- API routing/versioning
- validation/error contract
- correlation IDs
- service/domain separation
- background job foundation
- idempotency-key support

## WP-0004 Events / Outbox / Jobs
**Depends on:** WP-0002, WP-0003  
**Scope:**
- transactional outbox
- domain event envelope
- retry
- dead-letter pattern
- job runner
- event audit metadata

## WP-0005 CI / Quality / Test Harness
**Depends on:** WP-0001  
**Scope:**
- lint/type/schema checks
- unit/integration/E2E setup
- secret/dependency scanning hooks
- CI pipeline
- test reports

**F0 Gate:** WP-0001..0005 all pass.

---

# PHASE F1 — Identity, Access, Workflow, Audit, Documents

## WP-0101 Identity / User Account
**Depends on:** F0  
**Blueprint:** BP-02, BP-23  
**Scope:** UserAccount, login/session, disable/revoke, MFA/SSO-ready interfaces, login audit.

## WP-0102 Organization / Department
**Depends on:** WP-0101  
**Blueprint:** BP-02  
**Scope:** company/legal entity shell, department hierarchy, user department membership.

## WP-0103 Role / Permission Engine
**Depends on:** WP-0101  
**Blueprint:** BP-02, BP-23  
**Scope:** Role, Permission, UserRole, server-side authorization, permission tests.

## WP-0104 Project Assignment & Data Scope
**Depends on:** WP-0103  
**Blueprint:** BP-02, BP-03, BP-23  
**Scope:** User↔Project N:N, project scope enforcement, department scope hooks, field-scope framework.

## WP-0105 Approval Authority & SoD
**Depends on:** WP-0103, WP-0104  
**Blueprint:** BP-02, BP-17  
**Scope:** approval authority, amount/scope policy, conflicting-duty checks.

## WP-0106 Audit Foundation
**Depends on:** WP-0101..0105  
**Blueprint:** BP-23, BP-26  
**Scope:** immutable audit record, actor/context/source metadata, before/after where safe.

## WP-0107 Workflow Engine Core
**Depends on:** WP-0105, WP-0106  
**Blueprint:** BP-17  
**Scope:** definitions, instances, steps, sequential/parallel/conditional routing.

## WP-0108 Workflow Actions / Inbox
**Depends on:** WP-0107  
**Scope:** approve/reject/return/delegate/cancel/escalate, inbox, SLA/timeout, notifications.

## WP-0109 Document Core
**Depends on:** WP-0106  
**Blueprint:** BP-16  
**Scope:** upload metadata, object-store adapter, versioning, source links, access.

## WP-0110 Document Approval / Signature / Archive
**Depends on:** WP-0107, WP-0109  
**Scope:** review/comments, approval, signature hook, publish/supersede/archive/retention fields.

**F1 Gate:** real user authenticates, is scoped, submits approval with document evidence, and produces audit; unauthorized/SoD negative tests pass.

---

# PHASE F1A — AI Core Foundation / LLM / Telegram

## WP-0111 AI Model Gateway / Provider Connections
**Depends on:** WP-0101, WP-0103, WP-0106  
**Blueprint:** BP-20, BP-22  
**Scope:** provider/model registry, API-key/service-account/OAuth-provider-sign-in/private-endpoint abstraction, secret references, model health, routing/fallback, cost/rate policy hooks.

## WP-0112 AI Orchestrator / Agent Runtime
**Depends on:** WP-0111  
**Scope:** conversation/run/task model, intent routing, task planning, human confirmation, response grounding.

## WP-0113 Typed Tool Registry / Authorization Proxy
**Depends on:** WP-0103..0106, WP-0112  
**Scope:** typed schemas, tool allowlists, permission checks, domain-service invocation, source IDs, audit.

## WP-0114 Enterprise Knowledge Plane
**Depends on:** WP-0109, WP-0112  
**Scope:** knowledge-source registry, document/system-metadata ingestion, vector/search index abstraction, security tags, source/version links, event-refresh interface, reconciliation/rebuild jobs.

## WP-0115 AI Security / Audit / Observability
**Depends on:** WP-0111..0114  
**Scope:** model/provider/version audit, prompt/intent metadata, retrieved sources, tool calls, policy decisions, DLP/redaction hooks, prompt-injection controls, token/cost/latency telemetry.

## WP-0116 In-App AI Copilot Shell
**Depends on:** WP-0112..0115  
**Scope:** persistent Copilot entry, current company/project/page context, source-grounded documentation/system-metadata Q&A, permission-aware response rendering.

## WP-0117 Telegram Bot Gateway / Identity Binding
**Depends on:** WP-0101, WP-0103, WP-0112..0115  
**Blueprint:** BP-20, BP-22  
**Scope:** bot config/managed-secret reference, HTTPS webhook adapter, webhook-secret verification, idempotency/replay protection, one-time ABOS↔Telegram identity linking/revocation, AI routing, notification routing, message/audit model, secure-deep-link/step-up pattern.

**F1A Gate:** one approved LLM provider connects through the Model Gateway; source-grounded AI works over docs/system metadata; typed-tool authorization is proven; unauthorized AI retrieval is denied; a securely linked Telegram user reaches the same AI Core.

---

# PHASE F2 — Master Data & Multi-Project

## WP-0201 Company / Legal Entity Master
**Depends on:** F1 + F1A  
**Blueprint:** BP-03, BP-21

## WP-0202 Project Hierarchy
**Depends on:** WP-0201  
**Scope:** Project, Phase, Zone, Block/Tower/Building, Floor, Unit.

## WP-0203 Department / Cost Center / Currency / Bank Masters
**Depends on:** WP-0201

## WP-0204 Party Master Foundation
**Depends on:** F1 + F1A  
**Scope:** BusinessParty base + profile-type extension pattern.

## WP-0205 Material / Service / Warehouse Masters
**Depends on:** F1 + F1A

## WP-0206 MDM Governance
**Depends on:** WP-0201..0205  
**Blueprint:** BP-21  
**Scope:** request→validate→approve→activate, dedupe, history, stewardship.

## WP-0207 Project Context / Project Switcher
**Depends on:** WP-0202, WP-0104  
**Scope:** shell project context, route/session context, company/project view switch foundations.

## WP-0208 Project Isolation / Consolidated Query Tests
**Depends on:** WP-0207  
**Scope:** cross-project denial tests, authorized multi-project rollup tests.

**F2 Gate:** project isolation + authorized consolidation proven.

---

# PHASE F3 — Finance Kernel

## WP-0301 Chart of Accounts
**Depends on:** F2  
**Blueprint:** BP-04

## WP-0302 Accounting Periods & Posting Controls
**Depends on:** WP-0301

## WP-0303 Journal Domain
**Depends on:** WP-0301, WP-0302  
**Scope:** journal/lines, dimensions, balancing, draft/approve/post.

## WP-0304 Reversal / Immutable Posting
**Depends on:** WP-0303

## WP-0305 AR Subledger
**Depends on:** WP-0303

## WP-0306 AP + Contractor + Employee Payable Foundations
**Depends on:** WP-0303

## WP-0307 Cash / Bank
**Depends on:** WP-0303

## WP-0308 Reconciliation
**Depends on:** WP-0307

## WP-0309 Budget / Commitment Ledger
**Depends on:** WP-0303

## WP-0310 Project Accounting / Cost Center Reporting
**Depends on:** WP-0303, WP-0309

## WP-0311 Fixed Asset Foundation
**Depends on:** WP-0303

## WP-0312 Multi-Currency / Tax Policy Extension
**Depends on:** WP-0303  
**Note:** no invented rates/rules.

## WP-0313 Finance Reports
**Depends on:** WP-0303..0312  
**Scope:** account activity, trial balance, project TB, P&L, balance sheet foundation.

## WP-0314 Finance Reconciliation Test Suite
**Depends on:** WP-0305, WP-0306, WP-0307, WP-0313

**F3 Gate:** balanced journal, reversal, period lock, subledger-control reconciliation, project TB/P&L proven.

---

# PHASE F4 — Sales & CRM

## WP-0401 Lead / Opportunity
## WP-0402 Customer 360 / KYC
## WP-0403 Unit Inventory / Availability
## WP-0404 Price Lists
## WP-0405 Quotation
## WP-0406 Discount Workflow
## WP-0407 Reservation / Expiry / Release
## WP-0408 Sales Contract
## WP-0409 Contract Amendment / Cancellation / Transfer
## WP-0410 Commission Foundation
## WP-0411 Handover Foundation
## WP-0412 Sales Reporting / Pipeline
## WP-0413 Sales→Finance Integration Tests

**Dependencies:** F3 + F2 + F1  
**Blueprint:** BP-05

**F4 Gate:** customer can progress lead→contract without conflicting unit sale; approvals/documents/audit/finance linkage work.

---

# PHASE F5 — Installments & Collections

## WP-0501 Installment Schedule Builder
## WP-0502 Receivable Generation
## WP-0503 Collection Work Queue
## WP-0504 Receipt & Allocation
## WP-0505 Partial / Advance Payment
## WP-0506 Overdue / Aging / Reminder
## WP-0507 Penalty / Waiver
## WP-0508 Reschedule / Reapproval
## WP-0509 Promise-to-Pay / Escalation
## WP-0510 Customer Statement / History
## WP-0511 Handover Eligibility
## WP-0512 Collection→Bank/AR/GL Reconciliation Tests

**Dependencies:** F4 + F3  
**Blueprint:** BP-06

**F5 Gate:** end-to-end customer sale-to-cash journey J1 passes.

---

# PHASE F6 — Construction / BOQ / Cost

## WP-0601 WBS
## WP-0602 Schedule / Baseline / Milestones
## WP-0603 Daily Reports
## WP-0604 Progress Measurement
## WP-0605 RFI
## WP-0606 Submittals
## WP-0607 QA/QC + NCR
## WP-0608 HSE
## WP-0609 Variations / Change Orders
## WP-0610 Claims / EOT
## WP-0611 BOQ / Rate Build-Up
## WP-0612 Cost Budget / Revisions
## WP-0613 Commitment / Actual Cost Model
## WP-0614 CTC / EAC / Variance
## WP-0615 EVM / CPI / SPI
## WP-0616 Cost Traceability / Overrun Alerts

**Dependencies:** F3 + F2  
**Blueprint:** BP-07, BP-08

**F6 Gate:** WBS/BOQ/BAC/committed/actual/CTC/EAC relationships work with source drilldown.

---

# PHASE F7 — Procurement / Supplier / Warehouse

## WP-0701 Supplier 360 / KYC / Prequalification
## WP-0702 Purchase Requisition
## WP-0703 RFQ
## WP-0704 Supplier Quotation
## WP-0705 Technical / Commercial Evaluation
## WP-0706 Bid Comparison / Award
## WP-0707 Purchase Order / Commitment
## WP-0708 Delivery / Inspection
## WP-0709 GRN / Stock In
## WP-0710 Warehouse / Bin / Stock Ledger
## WP-0711 Material Request / Issue
## WP-0712 Transfer / Return
## WP-0713 Adjustment / Scrap
## WP-0714 Inventory Count / Variance
## WP-0715 Supplier Invoice
## WP-0716 3-Way Match
## WP-0717 AP / Payment Handoff
## WP-0718 Supplier Performance
## WP-0719 Procure-to-Pay E2E Tests
## WP-0720 Material Consumption / Cost E2E Tests

**Dependencies:** F6 + F3  
**Blueprint:** BP-09, BP-10, BP-12

**F7 Gate:** journey J2 passes with SoD and correct commitment/inventory/cost/AP/GL effects.

---

# PHASE F8 — Contractor / IPC

## WP-0801 Contractor 360 / Prequalification
## WP-0802 Tender / Evaluation / Award
## WP-0803 Contractor Contract / BOQ
## WP-0804 Mobilization Advance
## WP-0805 Measurement
## WP-0806 IPC Build-Up
## WP-0807 IPC Approval Chain
## WP-0808 Retention / Advance Recovery
## WP-0809 Claims / Variations Integration
## WP-0810 Completion / DLP
## WP-0811 Retention Release / Final Account
## WP-0812 Contractor Accounting Reconciliation
## WP-0813 Contractor E2E Tests

**Dependencies:** F6 + F3 + F1  
**Blueprint:** BP-11

**F8 Gate:** journey J3 passes.

---

# PHASE F9 — HR / Payroll / Expense / Assets

## WP-0901 Recruitment
## WP-0902 Employee 360
## WP-0903 Employee/User/Party Separation
## WP-0904 Project Assignments
## WP-0905 Attendance / Shift / Roster
## WP-0906 Leave
## WP-0907 Overtime
## WP-0908 Performance / Training
## WP-0909 Employee Loans / Advances
## WP-0910 Discipline / Exit / Clearance
## WP-0911 ESS
## WP-0912 Salary Structures / Pay Components
## WP-0913 Payroll Calculation
## WP-0914 Payroll Dual Approval / Lock
## WP-0915 Payslip / Bank File
## WP-0916 Payroll Project Allocation
## WP-0917 Payroll Journal / Payment
## WP-0918 Off-Cycle Correction
## WP-0919 Expense Request / Budget Check
## WP-0920 Expense Approval / Payment / Posting
## WP-0921 Asset Register / Acquisition
## WP-0922 Depreciation / Transfer / Disposal Foundation
## WP-0923 HR/Payroll/Expense E2E Tests

**Dependencies:** F3 + F2 + F1  
**Blueprint:** BP-13, BP-14, BP-15

**F9 Gate:** journey J4 passes; salary fields remain protected.

---

# PHASE F10 — BI / Reporting / Executive Command Center

## WP-1001 Analytics Ingestion / CDC Foundation
## WP-1002 Conformed Dimensions
## WP-1003 Semantic Measures / Security
## WP-1004 Finance Dashboards
## WP-1005 Sales / Collection Dashboards
## WP-1006 Construction / Cost Dashboards
## WP-1007 Procurement / Warehouse Dashboards
## WP-1008 HR / Payroll Dashboards
## WP-1009 Supplier / Contractor Dashboards
## WP-1010 Report Catalog / Export / Schedule
## WP-1011 Data Quality / Freshness / GL Reconciliation
## WP-1012 Executive Command Center
## WP-1013 Portfolio / Project Toggle
## WP-1014 Executive Drilldown / Traceability
## WP-1015 Rule-Based Risk & Attention Center
## WP-1016 Executive Reverse-Trace E2E Test

**Dependencies:** stable core transactions  
**Blueprint:** BP-18, BP-19, BP-26

**F10 Gate:** journey J5 passes.

---

# PHASE F11 — Portals / Integrations / Advanced AI & Telegram

## WP-1101 Portal Identity Boundary
## WP-1102 Customer Portal
## WP-1103 Supplier Portal
## WP-1104 Contractor Portal
## WP-1105 Own-Party Security Negative Tests
## WP-1106 API Gateway Hardening
## WP-1107 Webhooks / Retry / DLQ / Replay
## WP-1108 Bank Adapter
## WP-1109 Payment Gateway Adapter
## WP-1110 Messaging Adapter
## WP-1111 Primavera/MS Project Adapter
## WP-1112 BIM/Revit Adapter
## WP-1113 Biometric Adapter
## WP-1114 Barcode/QR Adapter
## WP-1115 Government/Tax Extension
## WP-1116 Legacy Import/Migration Interface
## WP-1117 AI Permission Gateway Hardening / Domain Coverage
## WP-1118 Cross-Domain Typed AI Tool Coverage
## WP-1119 Contextual Copilot Domain Rollout
## WP-1120 Executive AI Briefing
## WP-1121 Document AI Hooks
## WP-1122 Prediction / Risk Interfaces
## WP-1123 AI Audit / Explainability / Usage Operations
## WP-1124 AI Authorization / Prompt-Injection Negative Tests
## WP-1125 Telegram Production Channel
**Scope:** production webhook, private-chat policies, notifications, secure deep links, Document-Service attachment intake, operational monitoring, rate/retry/delivery controls.
## WP-1126 Telegram Domain Query / Draft Coverage
**Scope:** authorized cross-module query, approvals/tasks summary, record lookup, low-risk draft tools; high-risk execution remains step-up/workflow governed.
## WP-1127 Telegram Security / E2E Tests
**Scope:** unlinked/disabled user denial, project/field denial, group restrictions, duplicate webhook idempotency, high-risk step-up, audit chain.
## WP-1128 AI Knowledge Completeness / Domain Exposure Audit
**Scope:** verify every major module has typed tools, events/read projection, source/deep links, permission metadata and knowledge freshness.

**Dependencies:** relevant internal services + F1A  
**Blueprint:** BP-20, BP-22, BP-24

**F11 Gate:** portals cannot cross party boundaries; AI cannot cross user authorization; Telegram identity/channel security passes; integrations are idempotent/audited; cross-module AI knowledge/tool coverage is complete.

---

# PHASE F12 — Hardening / Migration / UAT / Release

## WP-1201 Performance / Load
## WP-1202 Security Negative / Penetration Review
## WP-1203 Dependency / Secret Review
## WP-1204 Migration Mapping / Dry Run
## WP-1205 Financial Reconciliation after Migration
## WP-1206 Backup / Restore Test
## WP-1207 DR Runbook / RPO-RTO after policy approval
## WP-1208 Monitoring / Alerts / Support Runbooks
## WP-1209 Browser / Accessibility Review
## WP-1210 UAT Dataset / Training
## WP-1211 UAT J1 Sale→Cash
## WP-1212 UAT J2 Procure→Pay
## WP-1213 UAT J3 IPC→Payment
## WP-1214 UAT J4 Payroll→Allocation
## WP-1215 UAT J5 Executive Reverse Drilldown
## WP-1216 AI Core / Telegram / Unauthorized Access UAT
## WP-1217 Remediation
## WP-1218 Release Candidate / Exact SHA
## WP-1219 Rollback Verification
## WP-1220 Production Readiness Sign-Off

**F12 Gate:** no blocker defect; release SHA explicitly approved.

---

# Parallelization Rules

Parallel work is allowed only where domain coupling is low.

Safe examples after foundations:
- RFI and Submittals can run in parallel.
- Supplier 360 and warehouse location screens can run in parallel.
- Recruitment and performance can run in parallel.
- Domain dashboards can run in parallel once semantic/security foundations are stable.

Unsafe examples:
- Do not build collections posting before AR/journal kernel.
- Do not build material issue accounting before inventory valuation/cost-posting contracts.
- Do not build IPC posting before contractor payable/retention/advance model.
- Do not build portals before own-party authorization foundation.
- Do not build domain AI tools before permission-trimmed service layer.
- Do not postpone the AI Core itself until F11; F1A is a hard platform foundation.
- Do not connect Telegram directly to domain databases/services without ABOS identity, AI/tool authorization and audit.

---

# Work Package Handoff Template

Each builder handoff must contain:

```
Work Package:
Branch:
Commit SHA:
Blueprint(s):
Acceptance criteria:
Implemented:
Migrations:
Tests run:
Test result:
Security/SoD evidence:
Finance reconciliation evidence:
Known non-blocking gaps:
Open items:
Next package:
```

---

# Build Start / End

**Start at:** WP-0001  
**Do not skip directly into business modules.**

**Release-1 end at:** WP-1220 after J1–J6, AI Core/Telegram, security/SoD, finance reconciliation, migration, restore and UAT gates pass.
