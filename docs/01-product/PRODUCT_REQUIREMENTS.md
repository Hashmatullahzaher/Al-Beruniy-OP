# Product Requirements
ABOS is a modular enterprise OS supporting tens/hundreds of concurrent projects and two views: independent project operations/financials and corporate consolidation. Required domains: Executive Command Center; organization/users/RBAC/project assignments/approval authority; Sales/CRM/unit inventory/contracts/installments/collections/handover; Finance/GL/AR/AP/cash-bank/budget/project accounting/cost centers/assets/multi-currency; Construction/WBS/schedule/progress/RFI/QA-QC/HSE/variations/EVM; BOQ/cost control; Procurement/suppliers/warehouse; Contractor IPC/retention/advance; Expenses; HR/attendance/payroll; Documents; Workflow; Master Data; BI/DWH; AI; external portals; integrations; security/audit. Nonfunctional: API-first, multi-company/project/currency/language-ready, encrypted, auditable, backup/DR capable, desktop-first with targeted mobile workflows.

## Mandatory Multi-Currency Capability
Multi-currency support is foundational across all applicable domains. AFN and USD are required transaction currencies. Every monetary event must retain its original currency and amount and, when posted, its approved base-currency accounting amount and immutable exchange-rate reference. The platform must never silently aggregate different currencies. Legal-entity base currencies, reporting currencies, additional supported currencies, rate sources, precision, revaluation and accounting treatment require explicit owner/client approval before implementation.

## AI Core Product Requirement
ABOS requires a system-wide AI Core that sits logically above/across all modules and continuously maintains governed awareness of the operating system through documentation, master data, events, documents, BI measures and authorized transactional projections. The Core must expose an in-app copilot and contextual AI in every major domain.

Required AI platform capabilities:
- provider-neutral LLM Model Gateway
- LLM connection through approved API credentials, service accounts, OAuth/provider sign-in where supported, or private endpoints
- enterprise knowledge ingestion/indexing
- cross-module semantic search and source-grounded answers
- typed read/action tools over domain services
- conversation/task memory scoped to identity
- AI audit/observability
- model routing/fallback/health/cost controls
- human-in-the-loop actions
- permission/project/department/field/party security at retrieval and tool execution

ABOS also requires a Telegram Bot channel connected to the same AI Core for secure queries, alerts, document intake and policy-approved actions. Telegram identity must be bound to a Type A UserAccount and must not bypass RBAC, SoD, workflow, finance or audit.

