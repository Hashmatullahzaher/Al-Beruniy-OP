# Module Contracts
## Finance
Corporate CoA → Legal Entity → Project → Cost Center → Department → Transaction. Subledgers: customer AR, supplier AP, contractor payable/retention/advance, employee payable, cash/bank, assets/prepayments/accruals. Example postings: receipt Dr Bank/Cr AR; GRN Dr Inventory/WIP/Cr GRNI; supplier invoice Dr GRNI/Cr AP; payment Dr AP/Cr Bank; material issue Dr Project Cost/Cr Inventory; IPC Dr WIP/Cr Contractor Payable; payroll Dr Payroll Expense/Cr Employee Payable.
## Sales & Collections
Lead → qualification → opportunity → availability → quotation → discount approval → reservation → contract → installment schedule → collection → handover. Customer 1:N contracts; contract 1:N installments; receipts settle AR. Partial/advance, overdue, penalties, waivers, reschedule and legal escalation supported.
## Projects/Construction/Cost
Company → Project → Phase → Zone → Block/Tower → Floor → Unit. Construction: initiation → design → WBS/BOQ/budget/schedule → execution → measure → control/EVM → closure. Track BAC, committed, actual, CTC, EAC and variance.
## Procurement/Suppliers/Warehouse
PR → approval → RFQ → quote/evaluation → supplier selection → PO → delivery/inspection/GRN → invoice → 3-way match → payment. Supplier lifecycle includes KYC/prequalification/performance. Warehouse supports receipt, issue, transfer, return, adjustment, counts, barcode/QR and valuation.
## Contractors
Prequalify → tender → contract/BOQ → advance → work → measurement → IPC → retention/advance recovery/variation/claim → completion/DLP → final payment. QS → engineer → PM → Finance approval chain.
## HR/Payroll
Recruit → hire → employee → department/position/project assignments → attendance/leave/OT → performance → payroll → exit. Payroll is deterministic, dual-approved, allocated by project/department/cost center and field-level protected.
## Documents/Workflow
Documents are versioned/classified/approved/signed/retained with audit. Workflow supports sequential/parallel/conditional/amount/project/department/role routing, delegation, escalation, reject and return.
## BI/AI/Portals
Operational data → DWH/semantic layer → secured dashboards with drilldown. AI follows User → Permission Engine → typed tool/domain service → authorized data. External portal identities are bound to one party and see own-party data only.

## AI Core / LLM / Telegram
**AI Core contract:** every module exposes explicit AI-safe read tools and, where appropriate, draft/action tools through its domain service. Each tool carries typed input/output schemas, permission checks, source IDs, project/party scope, validation and audit. Modules publish events/read models for knowledge refresh.

**Knowledge contract:** documents, entities, events and metrics indexed for AI carry company/legal entity, project, department, party scope where applicable, sensitivity/classification, source ID/version and ACL/security tags.

**LLM contract:** modules never call external LLMs directly. Model requests use the central Model Gateway, which controls provider credentials, routing, model/version, data policy, retries, quotas, fallback and audit.

**Telegram contract:** Telegram → Gateway → UserAccount binding → Permission Engine → AI Core → typed tool/domain service. Outbound notifications use Notification Service → Telegram Gateway. High-risk approvals/postings/payments cannot bypass ABOS workflow/step-up controls.

