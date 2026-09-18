# AL-BERUNIY Operating System — Functional Scope

**Document ID:** ABOS-FUNC-001  
**Purpose:** Exhaustive functional scope for Release 1. Every page, action and responsibility below is part of the build contract unless explicitly marked configurable/extension.

---

## 1. Global Application Shell

### 1.1 Global navigation
Must include:
- Company / Legal Entity selector where user is authorized for more than one
- Project Switcher
- Current Project badge/context banner
- Module navigation
- Breadcrumbs
- Global search
- Notifications
- Approval Inbox
- Tasks / Work Queue
- Favorites / Recent items
- Help / documentation entry
- User/session menu
- Contextual AI entry after AI phase
- Contextual document and audit access

### 1.2 Global data-grid behavior
All high-volume list pages must support as applicable:
- search
- filter
- date/project/department/cost-center filtering
- sort
- pagination
- saved views
- column visibility/order
- export
- bulk actions
- row actions
- status filters
- drill-down
- permission-aware actions
- empty/loading/error/no-permission states

### 1.3 Global form behavior
Transactional forms must support as applicable:
- draft save
- validation
- attachments
- project/department/cost-center context
- currency and amount
- party selection
- approval summary
- workflow status
- accounting status
- audit history
- cancellation/return/reject reason
- submission confirmation

---

# 2. Administration, Organization, Identity & Access

## 2.1 Company / Legal Entity
Pages:
- Company List
- Company Detail
- Legal Entity List
- Legal Entity Detail

Functions:
- create/edit inactive pre-transaction configuration
- status activate/deactivate
- base currency
- fiscal/calendar references
- legal identifiers
- default accounting/config references
- authorized project rollup
- audit trail

## 2.2 Departments
Pages:
- Department List
- Department Detail / Org Tree

Functions:
- parent-child hierarchy
- manager assignment
- active/inactive
- user membership
- cost-center mapping
- project relevance
- approval-routing use

## 2.3 Users
Pages:
- User List
- User Detail
- Login Activity
- Active Sessions

Functions:
- create/invite
- enable/disable
- MFA/SSO-ready auth methods
- session revoke
- department assignment
- role assignment
- project assignment
- field-level access flags
- approval authority links
- audit/login history

## 2.4 Roles & Permissions
Pages:
- Role List
- Role Detail
- Permission Matrix

Functions:
- role creation
- permission bundle assignment
- module/action permission mapping
- read/create/update/delete/submit/approve/post/pay/export controls
- sensitive-field permissions
- role duplication
- effective-access preview
- SoD conflict checks

## 2.5 Project Assignments
Pages:
- User Project Assignments
- Project Team

Functions:
- many-to-many assignment
- effective dates
- project role
- default project
- revoke
- audit

## 2.6 Approval Authority
Pages:
- Authority Matrix
- User Authority Detail

Functions:
- approval scope by module/action
- project scope
- amount tier
- currency handling
- effective dates
- delegation
- escalation target
- policy version
- no hard-coded official thresholds

## 2.7 Audit & Security Administration
Pages:
- Audit Log
- Security Events
- Login Log
- Access Review
- SoD Conflict Report

Functions:
- filter by user/module/project/action/date
- immutable event display
- before/after values where applicable
- export by permission
- failed-login review
- session/admin changes
- access recertification evidence

---

# 3. Project & Portfolio Management

## 3.1 Project Portfolio
Pages:
- Project Portfolio
- Project List
- Project Detail
- Project Setup

Functions:
- create project
- project code/name/type/status
- legal entity
- currency/context
- project manager
- start/end dates
- project bank/cash references
- budget context
- project health summary
- project team
- project documents
- project KPIs
- project-level permissions

## 3.2 Spatial / Property Hierarchy
Pages:
- Phase List/Detail
- Zone List/Detail
- Block/Tower/Building List/Detail
- Floor List/Detail
- Unit List/Detail

Functions:
- hierarchical parent-child assignment
- code/name
- status
- unit type
- area
- sales attributes
- availability status
- project linkage
- bulk import/template
- audit history

## 3.3 Corporate Consolidation
Pages:
- Portfolio Consolidated View
- Project Comparison

Functions:
- authorized multi-project rollup
- project filter
- period filter
- project-to-corporate reconciliation
- no data movement required; same underlying records

---

# 4. Master Data Management

## 4.1 Master Registry
Pages:
- Master Data Dashboard
- Master Requests
- Master Detail

Managed masters:
- projects
- units
- customers
- suppliers
- contractors
- employees
- materials
- services
- assets
- warehouses
- departments
- cost centers
- chart of accounts
- banks
- currencies
- tax codes
- document types
- approval policies
- price lists
- pay components

Functions:
- request new
- validate
- approve
- activate
- inactive/archive
- version/effective date
- duplicate detection
- merge where safe
- steward ownership
- usage references
- publish change event

---

# 5. Finance & Accounting

## 5.1 Finance Overview
Pages:
- Finance Dashboard
- Period Status
- Reconciliation Summary

Functions:
- cash/bank
- AR/AP
- revenue/expense
- project P&L
- budget variance
- open periods
- unreconciled items
- approval/posting queues

## 5.2 Chart of Accounts
Pages:
- CoA Tree
- Ledger Account Detail

Functions:
- account type/category
- hierarchy
- control-account flag
- posting allowed flag
- project/department/cost-center requirements
- currency behavior
- active/inactive
- IFRS mapping field
- audit

## 5.3 Journals
Pages:
- Journal List
- Journal Entry
- Journal Detail
- Reversal

Functions:
- manual journal draft
- lines with debit/credit
- dimensions
- supporting documents
- validation
- approval
- post
- reverse
- copy
- source-system linkage
- period lock enforcement
- balanced-entry enforcement
- immutable posted record

## 5.4 General Ledger
Pages:
- GL Inquiry
- Account Activity
- Trial Balance
- Project Trial Balance
- P&L
- Balance Sheet
- Cash Flow foundation

Functions:
- filter period/project/entity/cost center/department
- drill to journal/source
- opening/period/closing balances
- export

## 5.5 Accounts Receivable
Pages:
- AR Dashboard
- Customer AR Detail
- Aging
- Receipt Settlement
- Customer Statement

Functions:
- receivable entries
- settlements
- outstanding
- aging buckets
- advances
- adjustments/reversals
- reconcile AR control

## 5.6 Accounts Payable
Pages:
- AP Dashboard
- Supplier AP Detail
- Contractor Payable Detail
- Employee Payable Detail
- Aging
- Payment Queue

Functions:
- payable entries
- holds
- due dates
- advances
- retention
- settlements
- payment approval handoff
- reconcile AP/control balances

## 5.7 Cash & Bank
Pages:
- Bank Accounts
- Cash Accounts
- Bank Transactions
- Reconciliation
- Payment Run

Functions:
- account register
- statement import adapter
- match/unmatch
- reconciliation status
- payment instruction
- cash receipt/payment
- transfer
- project-bank association

## 5.8 Budgeting
Pages:
- Budget List
- Budget Detail
- Budget Revision
- Budget vs Actual

Functions:
- project/department/cost-center budgets
- baseline
- revisions
- commitment consumption
- actual consumption
- available balance
- workflow approval
- version history

## 5.9 Project Accounting
Pages:
- Project P&L
- Project Cost Summary
- Project Cash Flow
- Project Ledger

Functions:
- project dimension reporting
- revenue/cost drilldown
- committed/actual
- balance reconciliation

## 5.10 Cost Centers
Pages:
- Cost Center List
- Cost Center Detail

Functions:
- hierarchy
- owner
- project applicability
- active/inactive
- budget links

## 5.11 Fixed Assets
Pages:
- Asset Register
- Asset Detail
- Depreciation Run
- Asset Transfer/Disposal

Functions:
- acquisition
- category
- project/location
- useful-life policy field
- depreciation
- transfer
- disposal
- document evidence
- GL posting

## 5.12 Multi-Currency / Tax / Period Control
Pages:
- Currencies
- FX Rates
- Tax Codes
- Accounting Periods

Functions:
- configuration only where official policy exists
- rate source/version
- open/close/reopen with approval
- tax-code posting mappings
- FX extension/revaluation hooks

---

# 6. Sales & CRM

## 6.1 Leads
Pages:
- Lead List
- Lead Detail
- Lead Assignment

Functions:
- source/campaign
- contact
- score
- owner
- status
- notes/tasks
- qualification
- conversion to opportunity/customer

## 6.2 Customers / KYC
Pages:
- Customer List
- Customer 360
- KYC
- Customer Documents

Functions:
- Type B party profile
- contacts
- identity/company data
- KYC status
- addresses
- related contracts
- collections
- statements
- documents
- support cases

## 6.3 Opportunities
Pages:
- Opportunity Pipeline
- Opportunity Detail

Functions:
- project/unit interests
- stage
- value
- expected close
- activities
- owner
- quote generation

## 6.4 Unit Inventory
Pages:
- Unit Inventory
- Availability Matrix
- Unit Detail

Functions:
- project/building/floor filters
- Available/Reserved/Sold/Handed-over state
- price references
- dimensions/area
- customer/contract relationship
- prevent conflicting reservation/sale

## 6.5 Price Lists
Pages:
- Price List
- Price List Detail

Functions:
- project/phase/unit-type scope
- effective dates
- price components
- approval/versioning
- active/inactive

## 6.6 Quotations
Pages:
- Quote List
- Quote Builder
- Quote Detail

Functions:
- customer
- units
- pricing
- charges
- discount
- validity
- documents
- submit/approve
- convert to reservation

## 6.7 Discounts
Pages:
- Discount Requests
- Discount Approval Detail

Functions:
- percentage/value
- reason
- authority check
- workflow
- approval history
- no hard-coded thresholds

## 6.8 Reservations
Pages:
- Reservation List
- Reservation Detail

Functions:
- customer/unit
- booking amount
- start/expiry
- state
- hold unit
- release on expiry/cancel
- convert to contract
- document/evidence

## 6.9 Sales Contracts
Pages:
- Contract List
- Contract Builder
- Contract Detail
- Contract Amendment

Functions:
- customer
- project
- one-or-many units
- prices/charges
- installment terms
- legal docs
- approval
- e-sign hook
- versioning
- amendment
- cancellation
- transfer
- finance event

## 6.10 Handover
Pages:
- Handover Queue
- Handover Detail

Functions:
- eligibility check
- outstanding balance
- required docs
- approval
- handover record
- unit status update
- title/legal integration hook

## 6.11 Commission
Pages:
- Commission Rules
- Commission Accruals

Functions:
- rule/config basis
- agent/contract linkage
- accrual
- approval
- payroll/AP handoff

---

# 7. Installments & Collections

## 7.1 Installment Plans
Pages:
- Installment Plan
- Schedule Builder
- Schedule Detail

Functions:
- contract value
- down payment
- monthly/quarterly/custom schedule
- due dates
- grace configuration
- amount validation
- receivable generation
- reschedule

## 7.2 Collection Workbench
Pages:
- Collection Dashboard
- Officer Queue
- Upcoming Dues
- Overdue Accounts

Functions:
- assignment
- call/activity log
- reminder
- promise-to-pay
- escalation
- legal handoff

## 7.3 Receipts
Pages:
- Receipt List
- Record Receipt
- Receipt Detail

Functions:
- numbered receipt
- customer/contract
- bank/cash
- amount/currency
- payment reference
- allocation
- partial payment
- advance
- bounce/reversal
- e-receipt
- accounting posting

## 7.4 Penalty / Waiver
Pages:
- Penalty Charges
- Waiver Request

Functions:
- policy-driven charge
- approval
- reason
- posting
- reversal

## 7.5 Reschedule
Pages:
- Reschedule Request
- Revised Schedule

Functions:
- existing schedule snapshot
- proposed terms
- approval
- effective date
- re-amortization
- audit/version

## 7.6 Customer Statements
Pages:
- Statement
- Collection History

Functions:
- receivables
- receipts
- penalties/waivers
- balances
- export/download

---

# 8. Construction & Project Control

## 8.1 WBS
Pages:
- WBS Tree
- WBS Detail

Functions:
- hierarchical work packages
- code/name
- project
- BOQ links
- schedule/activity links
- budget links

## 8.2 Schedule / Milestones
Pages:
- Schedule
- Milestones
- Baselines

Functions:
- activity dates
- dependencies
- baseline
- actual dates
- progress
- external schedule-sync hooks

## 8.3 Daily Reports
Pages:
- Daily Report List
- Daily Report Entry

Functions:
- date/weather
- manpower
- equipment
- work completed
- issues
- photos/docs
- project/activity

## 8.4 Progress Measurement
Pages:
- Progress List
- Measurement Detail

Functions:
- WBS/BOQ item
- quantity
- percent complete
- period
- measured by
- evidence
- certification workflow

## 8.5 RFI
Pages:
- RFI List
- RFI Detail

Functions:
- question
- drawing/reference
- assignee
- due date
- response
- status
- documents

## 8.6 Submittals
Pages:
- Submittal Register
- Submittal Detail

Functions:
- material/shop drawing
- revision
- review
- approval/reject/revise
- due dates

## 8.7 QA/QC
Pages:
- Inspection Requests
- Inspection Detail
- NCR List/Detail

Functions:
- checklist
- pass/fail
- evidence
- NCR
- corrective action
- reinspection

## 8.8 HSE
Pages:
- HSE Dashboard
- Permit
- Incident

Functions:
- permit-to-work record
- incident
- severity
- actions
- investigation
- closure

## 8.9 Variations & Change Orders
Pages:
- Variation List
- Variation Detail

Functions:
- scope
- cost impact
- time impact
- contractor/customer linkage if applicable
- approval
- budget/contract update

## 8.10 Claims / EOT
Pages:
- Claim List
- Claim Detail

Functions:
- basis
- amount/time
- evidence
- review
- determination
- status

## 8.11 EVM / Forecast
Pages:
- EVM Dashboard
- Forecast

Functions:
- PV/EV/AC
- CPI/SPI
- CTC/EAC
- variance
- source drilldown

---

# 9. BOQ & Cost Control

## 9.1 BOQ
Pages:
- BOQ List
- BOQ Detail
- BOQ Item

Functions:
- WBS link
- quantity
- unit
- rate
- amount
- resource build-up
- version
- approval

## 9.2 Budget
Pages:
- Project Cost Budget
- Budget Revision

Functions:
- baseline
- revisions
- workflow
- history

## 9.3 Commitments
Pages:
- Commitment Register
- Commitment Detail

Sources:
- PO
- subcontract
- approved variation

Functions:
- open/consumed/closed
- source link
- project/WBS/BOQ dimensions

## 9.4 Actual Costs
Pages:
- Actual Cost Register
- Cost Transaction Detail

Sources:
- material issues
- IPC
- payroll
- expenses
- asset/equipment charges if configured

## 9.5 Forecast / EAC
Pages:
- Cost Forecast
- EAC Analysis

Functions:
- BAC
- committed
- actual
- CTC
- EAC
- variance
- overrun alerts

---

# 10. Procurement

## 10.1 Purchase Requisitions
Pages:
- PR List
- Create PR
- PR Detail

Functions:
- requester
- project/WBS
- material/service
- quantity
- required date
- budget check
- approval
- status

## 10.2 RFQ
Pages:
- RFQ List
- RFQ Detail

Functions:
- suppliers invited
- items
- due date
- attachments
- issue/send
- supplier responses

## 10.3 Supplier Quotations
Pages:
- Quote Register
- Quote Detail

Functions:
- price
- delivery
- terms
- validity
- documents
- revision

## 10.4 Bid Comparison
Pages:
- Bid Comparison
- Evaluation Detail

Functions:
- technical score
- commercial score
- normalization
- recommendation
- approval trail

## 10.5 Purchase Orders
Pages:
- PO List
- PO Builder
- PO Detail

Functions:
- supplier
- project
- items
- price/tax/terms
- delivery schedule
- commitment
- approval
- amendment
- cancellation

## 10.6 Delivery / GRN
Pages:
- Delivery List
- GRN List
- GRN Detail

Functions:
- PO matching
- quantities
- inspection
- accepted/rejected
- warehouse/location
- stock posting
- documents

## 10.7 Supplier Invoice & 3-Way Match
Pages:
- Supplier Invoice List
- Invoice Detail
- Match Workbench

Functions:
- invoice registration
- duplicate detection
- PO/GRN/invoice comparison
- tolerance configuration
- mismatch hold
- resolution
- AP posting

## 10.8 Payment Status
Pages:
- Supplier Payment Queue
- Payment Detail

Functions:
- due
- holds
- approvals
- treasury handoff
- remittance

---

# 11. Supplier Management

## 11.1 Supplier 360
Pages:
- Supplier List
- Supplier 360
- KYC/Prequalification
- Supplier Performance

Functions:
- legal/contact/bank
- categories
- documents
- qualification
- approved/suspended/blacklisted
- quotes
- POs
- deliveries
- invoices
- payments
- spend
- on-time %
- rejection/quality %
- risk signals

---

# 12. Warehouse & Inventory

## 12.1 Warehouses
Pages:
- Warehouse List
- Warehouse Detail
- Bin/Location

Functions:
- central/project store
- locations
- responsible users
- active/inactive

## 12.2 Stock
Pages:
- Stock On Hand
- Stock Ledger
- Material Detail

Functions:
- quantity
- available/reserved
- valuation
- batch/serial
- movement history

## 12.3 Material Requests
Pages:
- Material Request List
- Material Request Detail

Functions:
- project/WBS
- item/qty
- need date
- approval
- issue/procurement route

## 12.4 Material Issues
Pages:
- Issue List
- Issue Detail

Functions:
- warehouse
- project/WBS
- qty
- recipient
- stock decrement
- project cost posting

## 12.5 Transfers
Pages:
- Transfer List
- Transfer Detail

Functions:
- source/destination
- transit
- receive
- quantity reconciliation

## 12.6 Returns
Pages:
- Return List
- Return Detail

Functions:
- project/site to store
- reason
- inspection
- inventory/cost reversal

## 12.7 Adjustments / Scrap
Pages:
- Adjustment List
- Adjustment Detail
- Scrap/Damage

Functions:
- reason
- approval
- count/source
- accounting effect

## 12.8 Inventory Counts
Pages:
- Count Plan
- Count Sheet
- Variance Review

Functions:
- cycle/full count
- freeze/snapshot
- counted qty
- variance
- approval/posting

---

# 13. Contractor Management

## 13.1 Contractor 360
Pages:
- Contractor List
- Contractor Detail
- Prequalification

Functions:
- profile/KYC
- capabilities
- documents
- performance
- contracts
- advances
- IPC
- retention
- claims
- payments

## 13.2 Tender / Award
Pages:
- Tender List
- Bid Evaluation
- Award Detail

Functions:
- invited contractors
- bids
- evaluation
- recommendation
- approval

## 13.3 Contractor Contract
Pages:
- Contract List
- Contract Detail

Functions:
- scope/BOQ
- rates
- value
- dates
- retention/advance fields
- documents
- variations
- approval

## 13.4 Advance
Pages:
- Advance Request
- Advance Balance

Functions:
- approved amount
- payment
- recovery schedule
- outstanding

## 13.5 Measurement
Pages:
- Measurement List
- Measurement Sheet

Functions:
- BOQ item
- qty
- period
- evidence
- QS measurement
- engineer verification

## 13.6 IPC
Pages:
- IPC List
- IPC Builder
- IPC Detail

Functions:
- current/cumulative work
- retention
- advance recovery
- variations
- penalties extension
- previous payments
- net payable
- approval chain
- accounting posting

## 13.7 Completion / DLP
Pages:
- Completion
- Defects
- Retention Release
- Final Account

Functions:
- completion record
- DLP start/end
- defect tracking
- final measurement
- final payment
- retention release

---

# 14. Expense Management

Pages:
- Expense Dashboard
- Expense Request List
- Create Expense
- Expense Detail
- Expense Payment
- Expense Categories

Functions:
- project/department/cost-center
- category
- amount/currency
- evidence
- budget check
- approval
- finance coding
- cash/bank/payable
- staff-advance settlement
- posting
- reversal/correction
- spend vs budget

---

# 15. Human Resources

## 15.1 Recruitment
Pages:
- Requisitions
- Vacancies
- Candidates
- Interviews
- Offer

## 15.2 Employees
Pages:
- Employee List
- Employee Profile
- Employment Contract
- Employee Documents
- Project Assignments

Functions:
- party/user separation
- personal/job data
- department/position
- project assignments
- salary-sensitive field protection

## 15.3 Attendance
Pages:
- Attendance Dashboard
- Attendance Register
- Shift/Roster
- Attendance Correction

Functions:
- in/out
- source/manual/device
- absence
- late/early
- correction approval

## 15.4 Leave
Pages:
- Leave Balance
- Leave Request
- Leave Approval
- Leave Calendar

## 15.5 Overtime
Pages:
- OT Request
- OT Approval
- OT Register

## 15.6 Performance & Training
Pages:
- Appraisal Cycles
- Appraisal
- Training Plan/Record

## 15.7 Loans / Advances
Pages:
- Employee Loan/Advance
- Recovery Schedule

## 15.8 Discipline / Exit
Pages:
- Disciplinary Case
- Exit Request
- Clearance
- Final Settlement Inputs

## 15.9 ESS
Pages:
- My Profile
- My Attendance
- My Leave
- My Payslips
- My Documents
- My Requests

---

# 16. Payroll

Pages:
- Payroll Dashboard
- Pay Components
- Salary Structure
- Payroll Run List
- Payroll Run
- Employee Calculation
- Payroll Approval
- Payslip
- Bank File
- Payroll Journal
- Off-Cycle Payroll

Functions:
- deterministic calc
- attendance/OT/leave inputs
- recurring/one-off allowance
- deductions
- loans
- gross/net
- statutory/tax extension point
- project allocation
- HR approval
- finance approval
- lock run
- payslip publish
- bank payment
- journal posting
- off-cycle correction

---

# 17. Document Management

Pages:
- Document Library
- Folder/Classification View
- Document Detail
- Version History
- Review/Comments
- Signature Queue
- Retention/Archive
- Expiring Documents

Functions:
- upload
- metadata
- module/source link
- project/department/type
- version
- compare metadata
- review/comments
- workflow
- signature hook
- publish/supersede
- archive
- retention/legal hold field
- download/view permission
- watermark/access logging
- portal-limited sharing

---

# 18. Workflow & Approvals

Pages:
- Approval Inbox
- My Submitted Requests
- Workflow Definitions
- Workflow Instances
- Approval Detail
- Delegations
- Escalation/SLA
- Authority Matrix

Functions:
- sequential
- parallel
- conditional
- amount
- project
- department
- role
- approve
- reject
- return
- delegate
- cancel
- escalation
- timeout
- comments
- attachments
- SoD checks
- authority limit checks
- full timeline

---

# 19. Business Intelligence & Reporting

Pages:
- BI Home
- Executive
- Finance
- Sales
- Collections
- Construction
- Cost
- Procurement
- Warehouse
- HR
- Payroll
- Supplier/Contractor
- Report Catalog
- Scheduled Reports

Functions:
- near-live metrics
- DWH-backed heavy analytics
- filters
- compare projects/periods
- drilldown
- export PDF/XLS/CSV where authorized
- schedule
- row/field/project security
- freshness/completeness indicator
- reconcile-to-GL checks

---

# 20. Executive Command Center

Pages:
- Executive Command Center
- Portfolio Health
- Project Drilldown
- Risk & Attention Center

Headline capabilities:
- active projects
- development value
- project health
- construction progress
- total/available/reserved/sold units
- sales value
- cash collected
- outstanding receivables
- upcoming installments
- overdue
- revenue
- expenses
- P&L
- cash flow
- project cost
- budget variance
- AP
- contractor payable
- payroll
- procurement commitments
- warehouse value
- approval workload
- top risks
- company/project toggle
- drill to transaction/source/evidence/user/approver/payment/journal

---

# 21. AI Intelligence Layer

Pages/Surfaces:
- Contextual Copilot
- Executive AI Briefing
- AI Search
- AI Insight/Alert Detail
- AI Audit Log
- Model/Provider Configuration (admin)

Functions:
- permission-trimmed context
- typed tool/domain-service calls
- NLQ
- executive narrative
- document extraction/analysis hooks
- collection risk
- cash-flow prediction
- sales forecast
- cost-overrun signal
- delay signal
- supplier risk
- duplicate invoice/anomaly signal
- source citations/record links
- confidence/explanation
- human approval for actions
- prompt/output/context-scope audit
- no arbitrary SQL
- no direct posting

---

# 22. External Portals

## 22.1 Customer Portal
Pages:
- Home
- Contracts
- Installments
- Payments
- Statements
- Receipts
- Documents
- Support
- Notifications

## 22.2 Supplier Portal
Pages:
- Home
- RFQs
- Quotations
- POs
- Deliveries
- Invoices
- Payments
- Documents
- Performance

## 22.3 Contractor Portal
Pages:
- Home
- Contracts
- BOQ
- Progress/Measurements
- IPC
- Variations
- Claims
- Payments
- Documents

Security:
- external Type A login bound to exactly one authorized Type B party context
- own-party row security
- no internal HR/finance/other-party views

---

# 23. Integrations

Admin Pages:
- Integration Catalog
- Connector Detail
- Webhook Logs
- Event/Message Monitor
- Dead-Letter Queue
- Import Jobs

Integration targets:
- banks
- payment gateways
- email/SMS/WhatsApp
- Primavera/MS Project
- BIM/Revit
- biometric devices
- barcode/QR
- government/tax
- legacy migration/import

Required behavior:
- authentication/secrets
- mapping
- idempotency
- retry
- dead-letter
- replay
- correlation ID
- audit
- failure visibility
- no silent partial posting

---

# 24. Notifications & Tasks

Pages:
- Notification Center
- My Tasks
- Notification Preferences

Functions:
- approval assignments
- reminders
- overdue
- document expiry
- low stock
- payment due
- project delay/cost alert
- payroll/receipt notifications
- read/unread
- deep link to source
- channel preference extension

---

# 25. System Administration & Configuration

Pages:
- System Settings
- Number Sequences
- Policy Registry
- Feature Flags
- Data Import
- Job Monitor
- Health/Diagnostics
- Reference Data

Functions:
- numbering formats
- configurable policies
- no direct data bypass
- imports validated and audited
- background-job status
- environment-safe configuration
- sensitive settings permission-restricted

---

# 26. Required Cross-Module Relationships

Every implementation must preserve these links:

- Customer ↔ Sales Contract ↔ Unit ↔ Installment ↔ Receipt ↔ AR ↔ Bank ↔ Journal
- Supplier ↔ RFQ/PO ↔ Delivery/GRN ↔ Invoice ↔ AP ↔ Payment ↔ Journal
- Warehouse Issue ↔ Project/WBS/BOQ ↔ Project Cost ↔ Journal
- Contractor ↔ Contract/BOQ ↔ Measurement ↔ IPC ↔ Retention/Advance ↔ Payable ↔ Payment
- Employee ↔ Attendance/OT/Leave ↔ Payroll ↔ Project Allocation ↔ Employee Payable ↔ Payment
- Expense ↔ Project/Department/Cost Center ↔ Budget ↔ Approval ↔ Payment ↔ Journal
- Every controlled transaction ↔ Workflow
- Every evidence-requiring transaction ↔ Document
- Every material transaction ↔ Audit
- Every report/KPI ↔ source transaction
- Every external portal record ↔ own party
- Every AI answer/action ↔ user authorization context

---

# 27. Functional Completion Rule

A page is not considered implemented if it is only visual. It must have, as applicable:

- persistence
- validation
- status transitions
- authorization
- project scope
- workflow
- documents
- accounting side effect
- audit
- notifications
- reports
- error/empty/no-permission states
- tests

Release 1 is functionally complete only when the pages and capabilities in this document are covered by working software or explicitly accepted as deferred in a controlled release decision.
