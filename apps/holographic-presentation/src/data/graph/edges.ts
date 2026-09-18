import type { WorldEdge } from './types';

// ------------------------------------------------------------------
// RELATIONSHIP DATASET
// Extracted from: BP-25 (six flow dimensions), BP-26 (five journeys + reverse traces),
// Master Network Workflow (labelled edges), per-domain AI Core & Telegram contract strips,
// docs/03-architecture/AI_CORE.md, TELEGRAM_INTEGRATION.md, SECURITY.md, TRACEABILITY.md,
// docs/02-domain/MODULE_CONTRACTS.md.
// Every edge: source · target · kind · label · direction · reference.
// ------------------------------------------------------------------

const E = (source: string, target: string, kind: WorldEdge['kind'], label: string, ref: string, dir: WorldEdge['dir'] = 'forward'): WorldEdge =>
  ({ source, target, kind, label, ref, dir });

export const TOP_EDGES: WorldEdge[] = [
  // ===== FINANCIAL POSTINGS — every operational domain feeds Finance (BP-04, BP-25, MNW) =====
  E('collections', 'finance', 'financial', 'receipt · Dr Bank / Cr AR', 'MNW · BP-06'),
  E('sales', 'finance', 'financial', 'contract → receivable (Dr AR / Cr Revenue · policy)', 'BP-04 · BP-05'),
  E('warehouse', 'finance', 'financial', 'issue · Dr Project Cost / Cr Inventory', 'MNW · BP-12'),
  E('contractors', 'finance', 'financial', 'IPC · Dr WIP / Cr Contractor Payable · retention', 'MNW · BP-11'),
  E('procurement', 'finance', 'financial', 'GRN · Dr Inventory / Cr GRNI · PO → commitment', 'BP-09 · BP-04'),
  E('suppliers', 'finance', 'financial', 'invoice · Dr GRNI / Cr AP · payment settles AP', 'MNW · BP-10'),
  E('payroll', 'finance', 'financial', 'payroll · Dr Expense / Cr Employee Payable', 'MNW · BP-15'),
  E('expense', 'finance', 'financial', 'expense · Dr Expense / Cr Cash · asset → register', 'MNW · BP-13'),
  E('boq_cost', 'finance', 'financial', 'commitment / actual / EAC ↔ project accounting', 'BP-08 · BP-04', 'both'),

  // ===== BUSINESS PROCESS — direct inter-module flow (MNW, BP-26) =====
  E('sales', 'collections', 'process', 'contract → installment schedule (1:N)', 'MNW'),
  E('warehouse', 'construction', 'process', 'issues material to site', 'MNW · BP-12'),
  E('contractors', 'boq_cost', 'process', 'certified IPC → actual cost', 'MNW · BP-11'),
  E('procurement', 'suppliers', 'process', 'PO placed on supplier (1:N)', 'MNW · BP-09'),
  E('hr', 'payroll', 'process', 'attendance · salary structure', 'MNW · BP-14'),
  E('multi_project', 'expense', 'process', 'tags project · cost center', 'MNW'),
  E('construction', 'contractors', 'process', 'subcontracts work', 'MNW · BP-07'),
  E('procurement', 'warehouse', 'process', 'delivery → GRN', 'MNW · BP-09'),
  E('construction', 'boq_cost', 'process', 'progress → cost', 'MNW · BP-07'),
  E('construction', 'procurement', 'process', 'site material request → PR', 'BP-26 J2'),
  E('multi_project', 'sales', 'process', 'units for sale', 'BP-03'),
  E('multi_project', 'construction', 'process', 'project · WBS · budget', 'BP-03'),
  E('collections', 'sales', 'process', 'handover eligibility (balance = 0)', 'BP-06', 'forward'),
  E('payroll', 'boq_cost', 'process', 'labour cost by project / CC', 'BP-15 · BP-08'),
  E('expense', 'boq_cost', 'process', 'site expense → project cost', 'BP-13'),

  // ===== APPROVAL / WORKFLOW — the ring every side-effect passes (BP-17) =====
  E('workflow', 'sales', 'approval', 'discount · contract · waiver', 'MNW · BP-17'),
  E('workflow', 'construction', 'approval', 'variation · progress', 'MNW · BP-17'),
  E('workflow', 'boq_cost', 'approval', 'budget revision · IPC', 'MNW · BP-17'),
  E('workflow', 'procurement', 'approval', 'PR · PO · payment', 'MNW · BP-17'),
  E('workflow', 'hr', 'approval', 'leave · offer', 'MNW · BP-17'),
  E('workflow', 'payroll', 'approval', 'payroll run · HR + Finance', 'BP-15 · BP-17'),
  E('workflow', 'contractors', 'approval', 'IPC certification chain', 'BP-11 · BP-17'),
  E('workflow', 'expense', 'approval', 'tiered by amount', 'BP-13 · BP-17'),
  E('workflow', 'collections', 'approval', 'waiver · reschedule', 'BP-06 · BP-17'),
  E('workflow', 'finance', 'approval', 'payment release · journal post', 'BP-04 · BP-17'),
  E('workflow', 'master_data', 'approval', 'master change · steward', 'BP-21 · BP-17'),
  E('ai_core', 'workflow', 'approval', 'AI action proposal → workflow (never approves)', 'MNW · BP-17 · AI_CORE.md'),
  E('telegram', 'workflow', 'approval', 'approval notice → deep link / step-up', 'BP-17 · TELEGRAM_INTEGRATION.md'),

  // ===== SECURITY / AUTHORIZATION CONTEXT (BP-02, BP-23) =====
  E('org_access', 'security', 'security', 'roles · scope · authority → enforcement', 'BP-02 · BP-23'),
  E('security', 'ai_core', 'security', 'permission & policy gateway · query-time authz', 'BP-20 · BP-23'),
  E('security', 'workflow', 'security', 'approval authority · SoD', 'BP-17 · BP-23'),
  E('security', 'telegram', 'security', 'identity binding · step-up · group restriction', 'BP-23 · TG'),
  E('security', 'portals', 'security', 'own-party boundary', 'BP-24 · BP-23'),
  E('org_access', 'telegram', 'security', 'TelegramIdentityBinding → Type-A user', 'BP-02'),
  E('org_access', 'multi_project', 'security', 'project assignment scopes data', 'BP-02 · BP-03'),
  E('security', 'finance', 'security', 'field-level · immutable posting', 'BP-04 · BP-23'),
  E('security', 'hr', 'security', 'restricted HR fields masked', 'BP-14 · BP-23'),

  // ===== DOCUMENT / EVIDENCE (BP-16) =====
  E('sales', 'documents', 'document', 'contracts · quotes · receipts', 'BP-16'),
  E('procurement', 'documents', 'document', 'RFQ · PO · GRN', 'BP-16'),
  E('contractors', 'documents', 'document', 'contract · IPC · measurement', 'BP-16'),
  E('finance', 'documents', 'document', 'invoices · vouchers · bank docs', 'BP-16'),
  E('construction', 'documents', 'document', 'drawings · RFI · NCR · BOQ', 'BP-16'),
  E('hr', 'documents', 'document', 'employee files (Restricted)', 'BP-16'),
  E('expense', 'documents', 'document', 'receipts via Document Service', 'BP-13 · BP-16'),
  E('telegram', 'documents', 'document', 'attachments only via Document Service', 'TELEGRAM_INTEGRATION.md §8'),
  E('documents', 'workflow', 'document', 'evidence attached to every approval', 'BP-17'),

  // ===== MASTER DATA (BP-21) =====
  E('master_data', 'sales', 'master_data', 'customers · units · price lists', 'BP-21'),
  E('master_data', 'procurement', 'master_data', 'materials · suppliers', 'BP-21'),
  E('master_data', 'finance', 'master_data', 'chart of accounts · cost centers · banks', 'BP-21'),
  E('master_data', 'payroll', 'master_data', 'employees · pay components', 'BP-21'),
  E('master_data', 'construction', 'master_data', 'WBS · rate library', 'BP-21'),
  E('master_data', 'multi_project', 'master_data', 'project structure', 'BP-21 · BP-03'),
  E('master_data', 'bi', 'master_data', 'conformed dimensions', 'BP-19 · BP-21'),

  // ===== DOMAIN EVENT / DATA (BP-22 event bus, BP-19) =====
  E('finance', 'bi', 'event', 'feeds data warehouse', 'MNW · BP-19'),
  E('sales', 'bi', 'event', 'pipeline · conversion', 'BP-19'),
  E('collections', 'bi', 'event', 'DSO · aging', 'BP-19'),
  E('construction', 'bi', 'event', 'progress · SPI / CPI', 'BP-19'),
  E('procurement', 'bi', 'event', 'spend · cycle time', 'BP-19'),
  E('warehouse', 'bi', 'event', 'stock value · turns', 'BP-19'),
  E('hr', 'bi', 'event', 'headcount · cost by project', 'BP-19'),
  E('bi', 'exec_center', 'event', 'reports to ▲ KPI → report → transaction', 'MNW · BP-18'),
  E('finance', 'exec_center', 'event', 'cash · receivables · P&L', 'BP-18'),
  E('data_integration', 'bi', 'event', 'CDC / ELT → DWH', 'BP-22'),
  E('data_integration', 'finance', 'event', 'events → Finance posting', 'BP-22'),

  // ===== AI KNOWLEDGE INGESTION — modules → Knowledge Plane (INTO AI Core) =====
  E('sales', 'ai_core', 'ai_knowledge', 'LeadCreated · ContractApproved → projection', 'BP-05 contract'),
  E('collections', 'ai_core', 'ai_knowledge', 'InstallmentDue · ReceiptPosted → projection', 'BP-06 contract'),
  E('construction', 'ai_core', 'ai_knowledge', 'ProgressUpdated · RFIRaised → projection', 'BP-07 contract'),
  E('boq_cost', 'ai_core', 'ai_knowledge', 'CommitmentCreated · EAC → projection', 'BP-08 contract'),
  E('procurement', 'ai_core', 'ai_knowledge', 'PRApproved · POIssued · GRNPosted → projection', 'BP-09 contract'),
  E('suppliers', 'ai_core', 'ai_knowledge', 'performance · document expiry → projection', 'BP-10 contract'),
  E('contractors', 'ai_core', 'ai_knowledge', 'IPCCertified · ClaimLodged → projection', 'BP-11 contract'),
  E('warehouse', 'ai_core', 'ai_knowledge', 'MaterialIssued · StockAdjusted → projection', 'BP-12 contract'),
  E('expense', 'ai_core', 'ai_knowledge', 'ExpenseSubmitted / Approved → projection', 'BP-13 contract'),
  E('hr', 'ai_core', 'ai_knowledge', 'field-restricted projection', 'BP-14 contract'),
  E('payroll', 'ai_core', 'ai_knowledge', 'aggregate projection only', 'BP-15 contract'),
  E('finance', 'ai_core', 'ai_knowledge', 'JournalPosted · PeriodClosed → source-grounded projection', 'BP-04 contract'),
  E('documents', 'ai_core', 'ai_knowledge', 'published docs → Knowledge Plane (classified · ACL)', 'MNW · BP-16'),
  E('master_data', 'ai_core', 'ai_knowledge', 'golden records → entity graph', 'MNW · BP-21'),
  E('bi', 'ai_core', 'ai_knowledge', 'semantic measures · AI features', 'BP-19'),
  E('multi_project', 'ai_core', 'ai_knowledge', 'project KPIs → tagged projection', 'BP-03 contract'),
  E('workflow', 'ai_core', 'ai_knowledge', 'workflow state', 'AI_CORE.md §2.2'),

  // ===== AI TYPED TOOL INVOCATION — AI Core → domain services (OUT of AI Core) =====
  E('ai_core', 'finance', 'ai_tool', 'get_project_financial_summary · explain_variance · never posts', 'BP-04 contract'),
  E('ai_core', 'sales', 'ai_tool', 'get_available_units · get_lead_pipeline · draft_quotation', 'BP-05 contract'),
  E('ai_core', 'collections', 'ai_tool', 'get_overdue_installments · predict_late_payment', 'BP-06 contract'),
  E('ai_core', 'construction', 'ai_tool', 'get_schedule_status · summarize_delays · draft_rfi', 'BP-07 contract'),
  E('ai_core', 'boq_cost', 'ai_tool', 'get_eac · explain_variance(wbs)', 'BP-08 contract'),
  E('ai_core', 'procurement', 'ai_tool', 'compare_quotations · draft_purchase_requisition', 'BP-09 contract'),
  E('ai_core', 'suppliers', 'ai_tool', 'score_supplier_risk · get_supplier_performance', 'BP-10 contract'),
  E('ai_core', 'contractors', 'ai_tool', 'get_ipc_status · summarize_claims', 'BP-11 contract'),
  E('ai_core', 'warehouse', 'ai_tool', 'get_stock_on_hand · suggest_reorder_requisition', 'BP-12 contract'),
  E('ai_core', 'expense', 'ai_tool', 'detect_duplicate_expense · draft_expense_request', 'BP-13 contract'),
  E('ai_core', 'hr', 'ai_tool', 'workforce_analytics (authorized) · draft_leave_request', 'BP-14 contract'),
  E('ai_core', 'payroll', 'ai_tool', 'detect_payroll_anomaly — read only, no action tools', 'BP-15 contract'),
  E('ai_core', 'exec_center', 'ai_tool', 'executive briefing · source-linked answers', 'BP-18'),
  E('ai_core', 'multi_project', 'ai_tool', 'get_project_summary · compare_projects (scoped)', 'BP-03 contract'),
  E('ai_core', 'master_data', 'ai_tool', 'suggest_duplicate_merge → steward approves', 'BP-21 contract'),
  E('ai_core', 'documents', 'ai_tool', 'semantic search · cited retrieval', 'BP-16'),

  // ===== TELEGRAM CHANNEL (TG-01) =====
  E('telegram', 'ai_core', 'integration', 'bound user → permission context → AI Core', 'TELEGRAM_INTEGRATION.md §1'),
  E('ai_core', 'telegram', 'notification', 'grounded response · secure deep link', 'TELEGRAM_INTEGRATION.md §1'),
  E('collections', 'telegram', 'notification', 'installment reminders · officer alerts', 'BP-06 contract'),
  E('construction', 'telegram', 'notification', 'site / delay alerts', 'BP-07 contract'),
  E('procurement', 'telegram', 'notification', 'procurement delay · PO notices', 'BP-09 contract'),
  E('contractors', 'telegram', 'notification', 'IPC status', 'BP-11 contract'),
  E('warehouse', 'telegram', 'notification', 'low-stock alerts', 'BP-12 contract'),
  E('exec_center', 'telegram', 'notification', 'daily briefing · risk alerts', 'BP-18'),
  E('workflow', 'telegram', 'notification', 'approval assigned / returned', 'BP-17'),
  E('hr', 'telegram', 'notification', 'ESS notices — no sensitive data', 'BP-14 contract'),
  E('data_integration', 'telegram', 'integration', 'Telegram Gateway · webhook · replay protection', 'BP-22'),

  // ===== MODEL GATEWAY ↔ LLM PROVIDERS =====
  E('ai_core', 'llm_providers', 'integration', 'Model Gateway → provider (API key · service account · OAuth · private)', 'BP-20 · INTEGRATIONS.md', 'both'),

  // ===== PORTALS (BP-24) =====
  E('portals', 'sales', 'integration', 'customer portal: contracts · installments · payments', 'BP-24'),
  E('portals', 'collections', 'integration', 'online payment → receipt (payment gateway)', 'BP-24 · BP-22'),
  E('portals', 'procurement', 'integration', 'supplier portal: RFQ · quotations · invoices', 'BP-24'),
  E('portals', 'contractors', 'integration', 'contractor portal: progress · IPC · claims', 'BP-24'),
  E('portals', 'ai_core', 'integration', 'party-scoped AI answers', 'BP-24 contract'),
  E('portals', 'telegram', 'integration', 'optional own-party Telegram binding', 'BP-24 contract'),

  // ===== DATA / INTEGRATION BACKBONE (BP-22) =====
  E('data_integration', 'ai_core', 'integration', 'event bus → Knowledge ingestion · API gateway', 'BP-22'),
  E('data_integration', 'procurement', 'integration', 'banks · payment gateway · connectors', 'BP-22'),
  E('data_integration', 'hr', 'integration', 'biometric attendance', 'BP-22'),
  E('data_integration', 'warehouse', 'integration', 'barcode / QR', 'BP-22'),
  E('data_integration', 'construction', 'integration', 'Primavera · MS Project · BIM', 'BP-22'),
  E('data_integration', 'portals', 'integration', 'API gateway · identity', 'BP-22'),

  // ===== AUDIT / TRACE (BP-23, BP-26) =====
  E('finance', 'traceability', 'audit', 'immutable JE lineage', 'BP-26'),
  E('workflow', 'traceability', 'audit', 'approval trail · channel · AI-run ID', 'BP-17 · BP-26'),
  E('ai_core', 'traceability', 'audit', 'AI run: identity · model · sources · tools · cost', 'AI_CORE.md §2.6'),
  E('telegram', 'traceability', 'audit', 'message ↔ AI run ↔ tool ↔ transaction', 'TELEGRAM_INTEGRATION.md §11'),
  E('security', 'traceability', 'audit', 'login · activity · access logs', 'BP-23'),
  E('documents', 'traceability', 'audit', 'version · access log', 'BP-16'),
  E('exec_center', 'traceability', 'audit', 'reverse trace: KPI → source', 'BP-18 · BP-26'),
  E('traceability', 'relationship_map', 'audit', 'journeys prove the wiring', 'BP-25 · BP-26'),
  E('relationship_map', 'master_map', 'audit', 'six flow dimensions · zero orphans', 'BP-01 · BP-25'),
  E('master_map', 'multi_project', 'process', 'Company → Legal Entity → Project', 'BP-01 · BP-03'),
  E('master_map', 'org_access', 'process', 'stakeholders · departments · roles', 'BP-01 · BP-02'),
];

// ------------------------------------------------------------------
// SUB-LEVEL EDGES — relationships between expanded child nodes (used when a domain is
// selected and by trace mode). Sources: BP-04 posting matrix, BP-05/06/07/09/11/15 chains,
// BP-20 stack, TELEGRAM_INTEGRATION.md §1/§3.
// ------------------------------------------------------------------
export const SUB_EDGES: WorldEdge[] = [
  // AI Core internal stack (BP-20)
  E('guardrails', 'orchestrator', 'security', 'policy gate before retrieval / tools', 'BP-20'),
  E('orchestrator', 'knowledge_plane', 'ai_knowledge', 'retrieval', 'BP-20'),
  E('orchestrator', 'tool_registry', 'ai_tool', 'tool selection', 'BP-20'),
  E('orchestrator', 'model_gateway', 'integration', 'model request', 'BP-20'),
  E('model_gateway', 'llm_providers', 'integration', 'selected provider', 'BP-20', 'both'),
  E('orchestrator', 'memory', 'event', 'conversation · task memory', 'BP-20'),
  E('orchestrator', 'ai_audit', 'audit', 'every run logged', 'BP-20'),
  E('knowledge_plane', 'doc_intel', 'ai_knowledge', 'documents · citations', 'BP-20'),
  E('knowledge_plane', 'prediction', 'ai_knowledge', 'features · signals', 'BP-20'),
  E('tool_registry', 'workflow', 'approval', 'draft / action → workflow', 'BP-20'),

  // Sales chain (BP-05) → Collections (BP-06) → Finance (BP-04)
  E('lead', 'customer', 'process', 'qualify · KYC', 'BP-05'),
  E('customer', 'unit', 'process', 'availability', 'BP-05'),
  E('unit', 'quotation', 'process', 'price · discount', 'BP-05'),
  E('quotation', 'reservation', 'approval', 'discount approval', 'BP-05 · BP-17'),
  E('reservation', 'contract', 'process', 'convert · e-sign', 'BP-05'),
  E('contract', 'installment', 'process', 'generates schedule (1:N)', 'BP-05 · BP-06'),
  E('contract', 'ar', 'financial', 'creates receivable', 'BP-04'),
  E('installment', 'receipt', 'process', 'payment posting', 'BP-06'),
  E('installment', 'overdue', 'event', 'aging buckets', 'BP-06'),
  E('overdue', 'penalty_waiver', 'approval', 'waiver needs FM', 'BP-06'),
  E('overdue', 'escalation', 'process', 'reminder → officer → legal', 'BP-06'),
  E('overdue', 'reschedule', 'approval', 're-amortize · re-approve', 'BP-06'),
  E('receipt', 'ar', 'financial', 'settles receivable', 'BP-04 · BP-06'),
  E('receipt', 'cash_bank', 'financial', 'Dr Bank', 'BP-04'),
  E('cash_bank', 'journal', 'financial', 'auto journal', 'BP-04'),
  E('ar', 'journal', 'financial', 'sub-ledger → control', 'BP-04'),
  E('ap', 'journal', 'financial', 'sub-ledger → control', 'BP-04'),
  E('journal', 'gl', 'financial', 'posts to General Ledger', 'BP-04'),
  E('gl', 'project_accounting', 'financial', 'project dimension', 'BP-04'),
  E('gl', 'cost_centers', 'financial', 'cost center dimension', 'BP-04'),
  E('gl', 'budget', 'financial', 'budget vs actual', 'BP-04'),
  E('gl', 'kpi', 'event', 'financial statements → dashboard', 'BP-04 · BP-18'),
  E('gl', 'dwh', 'event', 'feeds warehouse', 'BP-19'),

  // Procure to pay (BP-09 / BP-12 / BP-10 / BP-04)
  E('site_material_request', 'pr', 'process', 'requirement → PR', 'BP-26 J2'),
  E('material_request', 'pr', 'process', 'reorder suggestion → PR', 'BP-12'),
  E('pr', 'rfq', 'approval', 'PR approved → RFQ', 'BP-09 · BP-17'),
  E('rfq', 'supplier_party', 'process', 'invites suppliers', 'BP-09'),
  E('supplier_party', 'bid_comparison', 'process', 'quotations', 'BP-09'),
  E('rfq', 'bid_comparison', 'process', 'technical + commercial evaluation', 'BP-09'),
  E('bid_comparison', 'po', 'approval', 'award → PO (SoD)', 'BP-09 · BP-17'),
  E('po', 'committed', 'financial', 'creates commitment', 'BP-08'),
  E('po', 'grn', 'process', 'delivery', 'BP-09'),
  E('grn', 'stock', 'financial', 'Dr Inventory / Cr GRNI', 'BP-12 · BP-04'),
  E('stock', 'material_issue', 'process', 'material request → issue', 'BP-12'),
  E('material_issue', 'actual_cost', 'financial', 'Dr Project Cost / Cr Inventory', 'BP-12 · BP-08'),
  E('grn', 'supplier_invoice', 'process', '3-way match', 'BP-09'),
  E('supplier_invoice', 'ap', 'financial', 'Dr GRNI / Cr AP', 'BP-04'),
  E('ap', 'cash_bank', 'financial', 'payment · Dr AP / Cr Bank', 'BP-04'),

  // Contractor (BP-11)
  E('contractor_contract', 'measurement', 'process', 'work executed · measured', 'BP-11'),
  E('measurement', 'ipc', 'approval', 'QS → Engineer → PM certify', 'BP-11 · BP-17'),
  E('ipc', 'retention_advance', 'financial', 'retention held · advance recovered', 'BP-11'),
  E('ipc', 'actual_cost', 'financial', 'Dr Project Cost (WIP)', 'BP-11 · BP-08'),
  E('ipc', 'ap', 'financial', 'Cr Contractor Payable', 'BP-04'),
  E('claims', 'variation', 'approval', 'claim → variation order', 'BP-11 · BP-08'),

  // Construction (BP-07 / BP-08)
  E('wbs', 'schedule', 'process', 'activities · milestones', 'BP-07'),
  E('wbs', 'boq_item', 'process', 'work package → BOQ item', 'BP-08'),
  E('schedule', 'daily_report', 'process', 'site activity', 'BP-07'),
  E('daily_report', 'progress', 'process', 'quantity tracking', 'BP-07'),
  E('qaqc', 'progress', 'approval', 'inspection passed?', 'BP-07'),
  E('progress', 'actual_cost', 'process', 'progress → actual cost', 'BP-07 · BP-08'),
  E('budget_cost', 'committed', 'process', 'budget → committed', 'BP-08'),
  E('committed', 'actual_cost', 'process', 'committed → actual', 'BP-08'),
  E('actual_cost', 'eac', 'process', 'EAC = AC + CTC', 'BP-08'),
  E('variation', 'budget_cost', 'approval', 'approved VO revises budget', 'BP-08'),

  // Payroll (BP-14 / BP-15)
  E('employee', 'attendance', 'process', 'biometric · shifts', 'BP-14'),
  E('attendance', 'payroll_run', 'process', 'period inputs', 'BP-15'),
  E('leave', 'payroll_run', 'process', 'deductions', 'BP-15'),
  E('payroll_run', 'payroll_approval', 'approval', 'HR Mgr + Finance dual approval', 'BP-15 · BP-17'),
  E('payroll_approval', 'payslip', 'process', 'ESS distribution', 'BP-15'),
  E('payroll_approval', 'bank_payment', 'financial', 'bank file after approval only', 'BP-15'),
  E('bank_payment', 'cash_bank', 'financial', 'Dr Employee Payable / Cr Bank', 'BP-04'),
  E('payroll_run', 'allocation', 'financial', 'split by project / dept / CC', 'BP-15'),
  E('allocation', 'project_accounting', 'financial', 'Dr Payroll Expense by project', 'BP-15 · BP-04'),

  // Expense (BP-13)
  E('expense_request', 'budget_check', 'process', 'budget availability', 'BP-13'),
  E('budget_check', 'expense_payment', 'approval', 'tiered approval', 'BP-13 · BP-17'),
  E('expense_payment', 'cash_bank', 'financial', 'Dr Expense / Cr Cash · Bank', 'BP-04'),

  // Telegram path (TELEGRAM_INTEGRATION.md §1, §3)
  E('tg_bot_api', 'tg_gateway', 'integration', 'HTTPS webhook', 'TG §2'),
  E('webhook_security', 'tg_gateway', 'security', 'secret · replay · rate limit', 'TG §2'),
  E('tg_gateway', 'identity_binding', 'security', 'resolve TelegramIdentityBinding', 'TG §3'),
  E('identity_binding', 'user_account', 'security', 'binds to Type-A account', 'TG §3 · BP-02'),
  E('identity_binding', 'permission_context', 'security', 'role · project · dept · field · authority', 'TG §3'),
  E('permission_context', 'ai_core', 'integration', 'AI Core (same runtime as web)', 'TG §1'),
  E('step_up', 'workflow', 'approval', 'high-risk → deep link + step-up', 'TG §4'),
  E('tg_notifications', 'tg_bot_api', 'notification', 'Notification Service → chat', 'TG §7'),
  E('tg_attachments', 'doc_version', 'document', 'validated · scanned → document record', 'TG §8'),

  // Documents (BP-16)
  E('doc_version', 'doc_approval', 'approval', 'review · approve · sign', 'BP-16'),
  E('doc_approval', 'classification', 'security', 'classify · ACL · party · project', 'BP-16'),
  E('classification', 'knowledge_ingestion', 'ai_knowledge', 'published only → index', 'BP-16'),
  E('knowledge_ingestion', 'knowledge_plane', 'ai_knowledge', 'security-tagged chunks', 'BP-16 · BP-20'),

  // Workflow pipeline (BP-17)
  E('requester', 'reviewer', 'approval', 'validation · SoD', 'BP-17'),
  E('reviewer', 'approver', 'approval', 'by tier & scope', 'BP-17'),
  E('approver', 'final_approver', 'approval', 'threshold cap', 'BP-17'),
  E('final_approver', 'execution', 'approval', 'post · pay · commit', 'BP-17'),
  E('ai_proposal', 'requester', 'ai_tool', 'draft attributed to a user', 'BP-17'),

  // Security chain (BP-23)
  E('authn', 'rbac', 'security', 'session → role', 'BP-23'),
  E('rbac', 'project_scope', 'security', 'row-level', 'BP-23'),
  E('project_scope', 'field_security', 'security', 'field-level', 'BP-23'),
  E('field_security', 'sod', 'security', 'authority · SoD', 'BP-23'),
  E('sod', 'ai_authz', 'security', 'AI query-time re-authorization', 'BP-23'),
  E('ai_authz', 'audit_log', 'audit', 'every decision logged', 'BP-23'),
  E('machine_identity', 'knowledge_ingestion', 'security', 'indexing under scoped identity', 'BP-02 · BP-20'),

  // Executive (BP-18) & BI (BP-19)
  E('dwh', 'semantic', 'event', 'conformed measures', 'BP-19'),
  E('semantic', 'dashboard', 'event', 'role-secured dashboards', 'BP-19'),
  E('semantic', 'ai_features', 'ai_knowledge', 'features → Knowledge Plane', 'BP-19'),
  E('dashboard', 'kpi', 'event', 'executive KPIs', 'BP-18'),
  E('kpi', 'ai_briefing', 'ai_tool', 'AI analysis with sources', 'BP-18'),
  E('ai_briefing', 'drilldown', 'event', 'source links → transaction / document', 'BP-18'),
  E('approval_inbox', 'workflow', 'approval', 'top-tier approvals', 'BP-18 · BP-17'),

  // Multi-project hierarchy (BP-03)
  E('company', 'legal_entity', 'master_data', '1:N', 'BP-03'),
  E('legal_entity', 'project', 'master_data', '1:N', 'BP-03'),
  E('project', 'block', 'master_data', '1:N', 'BP-03'),
  E('block', 'floor', 'master_data', '1:N', 'BP-03'),
  E('floor', 'unit_md', 'master_data', '1:N', 'BP-03'),

  // Org & access (BP-02)
  E('user_account', 'role', 'security', 'assigned to (N:N)', 'BP-02'),
  E('role', 'permission', 'security', 'contains', 'BP-02'),
  E('user_account', 'department', 'security', 'belongs to (1)', 'BP-02'),
  E('user_account', 'project_assignment', 'security', 'assigned to (N:N)', 'BP-02'),
  E('user_account', 'approval_authority', 'security', 'receives limits', 'BP-02'),

  // Data / integration (BP-22)
  E('api_gateway', 'oltp', 'process', 'business API → system of record', 'BP-22'),
  E('oltp', 'event_bus', 'event', 'domain events', 'BP-22'),
  E('event_bus', 'knowledge_store', 'ai_knowledge', 'knowledge ingestion', 'BP-22'),
  E('event_bus', 'dwh', 'event', 'CDC / ELT', 'BP-22'),
  E('connectors', 'api_gateway', 'integration', 'banks · payments · devices', 'BP-22'),

  // Portals (BP-24)
  E('customer_portal', 'customer', 'security', 'own-party only', 'BP-24'),
  E('supplier_portal', 'supplier_party', 'security', 'own-party only', 'BP-24'),
  E('contractor_portal', 'contractor_party', 'security', 'own-party only', 'BP-24'),
];

export const ALL_EDGES: WorldEdge[] = [...TOP_EDGES, ...SUB_EDGES].map((e, i) => ({ ...e, id: e.id ?? `e${i}` }));
