# User Roles

Governance: Chairman, Board, CEO, COO, CFO, Auditor.

Finance: Finance Director/Manager, Accountant, AP/AR, Treasury, Collection Officer.

Projects: Project Director/Manager, Construction Manager, Site Engineer, QS, Architect, QA/QC, HSE.

Procurement/Warehouse: Procurement Manager/Officer, Warehouse Manager, Storekeeper.

Sales: Sales Director/Manager/Agent, Customer Service.

HR: HR Manager/Officer, Employee/ESS.

Legal/Documents/Admin: Legal Officer, Document Controller, System/Company/Project/Department Admin.

AI / Integration administration:
- AI Platform Admin — manages provider connections, model routing, usage policies and AI health; does not automatically gain unrestricted business-data access.
- AI Knowledge Steward — manages approved knowledge sources/index freshness/classification.
- Integration Admin — manages connectors/webhooks/events without bypassing business permissions.
- Telegram Bot Admin — manages bot/webhook/channel configuration and delivery operations; cannot impersonate business users.

Machine roles:
- AI Indexer / Knowledge Sync Machine Identity — explicitly scoped service identity for ingestion/indexing.
- Integration Service Identity — scoped credentials for external connectors.

External: Customer, Supplier, Contractor portal users.

Roles are permission bundles; one user may hold multiple roles and project assignments. Administrative access to AI or Telegram infrastructure never automatically grants access to protected Finance, HR, project or party data.
