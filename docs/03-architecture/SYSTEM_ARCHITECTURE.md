# System Architecture
Modular API-first platform. Layers: web/mobile/portals → API gateway/identity → shared authorization/workflow → domain services (Sales, Collections, Projects/Construction/Cost, Procurement, Inventory, Supplier, Contractor, Finance, HR, Payroll, Expense/Assets, Documents, BI/AI) → event/message layer → OLTP/master data/object store/DWH/vector store → external connectors. Finance is authoritative for accounting; domain services enforce rules below UI; events are idempotent; company/project scope is explicit.

## AI Core Control Plane
ABOS includes a cross-cutting AI Core above/across the domain layer rather than treating AI as a late isolated feature.

Logical stack:

**Web / Mobile / Telegram / Portals / Executive Command Center**
→ **AI Core / Intelligence Control Plane**
→ **Permission & Policy Gateway**
→ **Typed Tool Registry / Domain Services**
→ **Workflow / Finance / Documents / Notifications / BI**
→ **OLTP / Object Store / DWH / Knowledge Index**

AI Core components:
- Model Gateway for provider-neutral LLM connectivity
- Enterprise Knowledge Plane
- AI Orchestrator / Agent Runtime
- typed Tool Registry
- AI Security & Policy Gateway
- conversation/task memory
- AI audit/observability
- channel adapters including Telegram

The Knowledge Plane consumes approved documents, master data, domain events, source-linked read models and BI semantics. Vector/search indexes are secondary read structures only; domain services and Finance remain authoritative systems of record.

Every module must publish an AI exposure contract: typed tools, events/read projections, source IDs, deep links, permission metadata and audit hooks.

See `AI_CORE.md` and `TELEGRAM_INTEGRATION.md`.

