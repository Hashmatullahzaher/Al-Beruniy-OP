import type { WorldNode } from './types';

// ------------------------------------------------------------------
// TOP-LEVEL NODES — all 26 blueprint sections + governed external nodes.
// Positions are intentional 3D placements (x right, y up, z toward camera).
// AI Core sits at the origin; Finance sits low-front so postings converge on it.
// ------------------------------------------------------------------
export const TOP_NODES: WorldNode[] = [
  { id: 'ai_core', label: 'AI Core', short: 'AI CORE', code: 'AI-01', bp: '20', zone: 'core', kind: 'ai_core', pos: [0, 0, 0],
    purpose: 'Enterprise Intelligence Control Plane — knowledge · typed tools · model gateway · never above the rules' },

  // FINANCE — authoritative
  { id: 'finance', label: 'Finance', short: 'FINANCE', code: 'FIN-01', bp: '04', zone: 'finance', kind: 'finance_engine', pos: [0, -3.6, 8.5],
    purpose: 'Authoritative accounting engine — every posting converges here; AI reads, never posts' },

  // REVENUE
  { id: 'sales', label: 'Sales & CRM', short: 'SALES', code: 'SALE-01', bp: '05', zone: 'revenue', kind: 'module', pos: [-12.5, 1.6, 4.5],
    purpose: 'Lead → Customer → Unit → Reservation → Contract → Handover' },
  { id: 'collections', label: 'Installments & Collections', short: 'COLLECTIONS', code: 'COLL-01', bp: '06', zone: 'revenue', kind: 'module', pos: [-9, -1.8, 10],
    purpose: 'Schedules · receipts · overdue · AI risk · Telegram reminders' },

  // DELIVERY / SUPPLY
  { id: 'construction', label: 'Construction', short: 'CONSTRUCTION', code: 'CONST-01', bp: '07', zone: 'delivery', kind: 'module', pos: [12.5, 2.2, 4.5],
    purpose: 'WBS · schedule · progress · RFI · QA/QC · variations' },
  { id: 'boq_cost', label: 'BOQ & Cost Control', short: 'BOQ / COST', code: 'COST-01', bp: '08', zone: 'delivery', kind: 'module', pos: [9, -0.6, 10],
    purpose: 'Budget → committed → actual → EAC · variance explained' },
  { id: 'procurement', label: 'Procurement', short: 'PROCUREMENT', code: 'PROC-01', bp: '09', zone: 'delivery', kind: 'module', pos: [15, -2.2, -0.5],
    purpose: 'PR → RFQ → bid comparison → PO → GRN → 3-way match' },
  { id: 'suppliers', label: 'Supplier Management', short: 'SUPPLIERS', code: 'SUP-01', bp: '10', zone: 'delivery', kind: 'module', pos: [18, 0.6, -6],
    purpose: 'KYC · performance · risk · supplier portal' },
  { id: 'contractors', label: 'Contractor Management', short: 'CONTRACTORS', code: 'CON-01', bp: '11', zone: 'delivery', kind: 'module', pos: [15.5, 4.4, -1.5],
    purpose: 'Contract · measurement · IPC · retention · claims' },
  { id: 'warehouse', label: 'Inventory & Warehouse', short: 'WAREHOUSE', code: 'WH-01', bp: '12', zone: 'delivery', kind: 'module', pos: [10.5, -3.8, -4.5],
    purpose: 'GRN → stock → issue → project cost' },

  // PEOPLE
  { id: 'hr', label: 'Human Resources', short: 'HR', code: 'HR-01', bp: '14', zone: 'people', kind: 'module', pos: [-13.5, -2.6, -3],
    purpose: 'Employee lifecycle · attendance · leave — sensitive fields protected' },
  { id: 'payroll', label: 'Payroll', short: 'PAYROLL', code: 'PAY-01', bp: '15', zone: 'people', kind: 'module', pos: [-9.5, -4.4, -8.5],
    purpose: 'Run → approval → payslip → bank · allocated to project / CC' },
  { id: 'expense', label: 'Expense & Assets', short: 'EXPENSE', code: 'EXP-01', bp: '13', zone: 'people', kind: 'module', pos: [-5, -4.8, 5.5],
    purpose: 'Request → budget check → approval → payment · asset register' },

  // GOVERNANCE / CONTROL (cross-cutting)
  { id: 'workflow', label: 'Workflow & Approvals', short: 'WORKFLOW', code: 'WF-01', bp: '17', zone: 'governance', kind: 'control', pos: [4.5, 5.6, 3],
    purpose: 'One approval engine — AI proposes, humans decide, Telegram never bypasses' },
  { id: 'security', label: 'Security', short: 'SECURITY', code: 'SEC-01', bp: '23', zone: 'governance', kind: 'control', pos: [-4.5, 5.6, 3],
    purpose: 'AuthN · RBAC · project/field · SoD · AI query-time authz · Telegram binding' },
  { id: 'documents', label: 'Documents', short: 'DOCUMENTS', code: 'DOC-01', bp: '16', zone: 'governance', kind: 'control', pos: [8.5, 6.2, -6.5],
    purpose: 'Versions · e-sign · published → Knowledge Plane · Telegram files' },
  { id: 'master_data', label: 'Master Data', short: 'MASTER DATA', code: 'MDM-01', bp: '21', zone: 'governance', kind: 'control', pos: [-11.5, 5.2, -12],
    purpose: 'Golden records — feeds domains, BI and the Knowledge Plane' },
  { id: 'org_access', label: 'Organization & Access', short: 'ORG / ACCESS', code: 'ORG-01', bp: '02', zone: 'governance', kind: 'control', pos: [-7.5, 6.4, -6.5],
    purpose: 'User ≠ Role ≠ Department ≠ Project ≠ Permission ≠ Authority ≠ Binding' },
  { id: 'multi_project', label: 'Multi-Project', short: 'PROJECTS', code: 'PROJ-01', bp: '03', zone: 'governance', kind: 'module', pos: [0, 7.8, -10.5],
    purpose: 'Company → Project → Phase → Block → Floor → Unit · isolated, consolidated' },
  { id: 'master_map', label: 'Enterprise Master Map', short: 'MASTER MAP', bp: '01', zone: 'governance', kind: 'control', pos: [0, 10.8, -17],
    purpose: 'AL-BERUNIY Group — the whole company as one platform' },
  { id: 'relationship_map', label: 'Cross-System Relationship Map', short: 'RELATIONSHIPS', code: 'REL-01', bp: '25', zone: 'governance', kind: 'control', pos: [7.5, 9.4, -15],
    purpose: 'The wiring you are looking at — six flow dimensions, zero orphans' },
  { id: 'traceability', label: 'Transaction Traceability', short: 'TRACEABILITY', code: 'TRACE-01', bp: '26', zone: 'governance', kind: 'control', pos: [-7.5, 9.4, -15],
    purpose: 'Forward & reverse trace — human, AI and Telegram journeys' },

  // INTELLIGENCE / EXTERNAL
  { id: 'exec_center', label: 'Executive Command Center', short: 'EXECUTIVE', code: 'EXEC-01', bp: '18', zone: 'intelligence', kind: 'module', pos: [0, 5.2, -3.5],
    purpose: 'KPIs · AI briefing · drill-down to source' },
  { id: 'bi', label: 'Business Intelligence', short: 'BI', code: 'BI-01', bp: '19', zone: 'intelligence', kind: 'module', pos: [5.5, 1.2, -12.5],
    purpose: 'DWH → semantic layer → dashboards → AI inputs' },
  { id: 'data_integration', label: 'Data · AI · Integration', short: 'INTEGRATION', code: 'INT-01', bp: '22', zone: 'intelligence', kind: 'control', pos: [12.5, -1.2, -12.5],
    purpose: 'API gateway · events · stores · connectors · five traffic classes' },
  { id: 'portals', label: 'External Portals', short: 'PORTALS', code: 'PORT-01', bp: '24', zone: 'external', kind: 'channel', pos: [-16, 1.2, -10],
    purpose: 'Customer · Supplier · Contractor — own-party only' },
  { id: 'telegram', label: 'Telegram Channel', short: 'TELEGRAM', code: 'TG-01', zone: 'external', kind: 'channel', pos: [-17, 4.6, -2],
    purpose: 'Governed channel — bound identity → AI Core; no own logic, no direct DB' },
  { id: 'llm_providers', label: 'LLM Providers', short: 'LLM PROVIDERS', code: 'MG-01', zone: 'external', kind: 'external', pos: [19, 6.2, -12],
    purpose: 'External / private models — reachable only through the Model Gateway' },
];

// ------------------------------------------------------------------
// SUBNODES — appear spatially around their parent when it is selected.
// ------------------------------------------------------------------
const sub = (parent: string, id: string, label: string, purpose?: string): WorldNode => ({
  id, label, parent, zone: TOP_NODES.find(n => n.id === parent)?.zone ?? 'governance', kind: 'sub', purpose,
});

export const SUB_NODES: WorldNode[] = [
  // AI CORE internals (BP-20)
  sub('ai_core', 'model_gateway', 'Model Gateway', 'provider-neutral · routing · quotas · residency · audit'),
  sub('ai_core', 'orchestrator', 'AI Orchestrator', 'intent · plan · ground · propose · hand-off'),
  sub('ai_core', 'knowledge_plane', 'Enterprise Knowledge Plane', 'security-tagged index — never a system of record'),
  sub('ai_core', 'tool_registry', 'Typed Tool Registry', 'schema-defined operations only'),
  sub('ai_core', 'memory', 'Memory', 'enterprise · entity · conversation (never shared) · task'),
  sub('ai_core', 'guardrails', 'Security / Guardrails', 'prompt-injection · allow-lists · DLP · confirmation'),
  sub('ai_core', 'ai_audit', 'Audit / Observability', 'run · identity · model · sources · tools · cost'),
  sub('ai_core', 'doc_intel', 'Document Intelligence', 'extraction · contract analysis · citations'),
  sub('ai_core', 'prediction', 'Prediction / Risk', 'cash-flow · collection risk · delay · overrun · anomaly'),

  // FINANCE (BP-04)
  sub('finance', 'gl', 'General Ledger'),
  sub('finance', 'ar', 'Accounts Receivable'),
  sub('finance', 'ap', 'Accounts Payable'),
  sub('finance', 'cash_bank', 'Cash & Bank'),
  sub('finance', 'journal', 'Journal Entries'),
  sub('finance', 'budget', 'Budgeting'),
  sub('finance', 'project_accounting', 'Project Accounting'),
  sub('finance', 'cost_centers', 'Cost Centers'),
  sub('finance', 'fixed_assets', 'Fixed Assets'),

  // SALES (BP-05)
  sub('sales', 'lead', 'Lead'),
  sub('sales', 'customer', 'Customer (Party B)'),
  sub('sales', 'unit', 'Unit'),
  sub('sales', 'quotation', 'Quotation / Discount'),
  sub('sales', 'reservation', 'Reservation'),
  sub('sales', 'contract', 'Sales Contract'),

  // COLLECTIONS (BP-06)
  sub('collections', 'installment', 'Installment Schedule'),
  sub('collections', 'receipt', 'Receipt'),
  sub('collections', 'overdue', 'Overdue / Aging'),
  sub('collections', 'penalty_waiver', 'Penalty / Waiver'),
  sub('collections', 'reschedule', 'Reschedule'),
  sub('collections', 'escalation', 'Escalation / Legal'),

  // CONSTRUCTION (BP-07)
  sub('construction', 'wbs', 'WBS'),
  sub('construction', 'schedule', 'Schedule / Milestones'),
  sub('construction', 'daily_report', 'Daily Report'),
  sub('construction', 'rfi', 'RFI'),
  sub('construction', 'submittal', 'Submittal'),
  sub('construction', 'qaqc', 'QA / QC / HSE'),
  sub('construction', 'progress', 'Progress / Measurement'),
  sub('construction', 'site_material_request', 'Site Material Request'),

  // BOQ / COST (BP-08)
  sub('boq_cost', 'boq_item', 'BOQ Item'),
  sub('boq_cost', 'budget_cost', 'Budget Cost'),
  sub('boq_cost', 'committed', 'Committed Cost'),
  sub('boq_cost', 'actual_cost', 'Actual Cost'),
  sub('boq_cost', 'eac', 'Forecast / EAC'),
  sub('boq_cost', 'variation', 'Variation Order'),

  // PROCUREMENT (BP-09)
  sub('procurement', 'pr', 'Purchase Requisition'),
  sub('procurement', 'rfq', 'RFQ'),
  sub('procurement', 'bid_comparison', 'Bid Comparison'),
  sub('procurement', 'po', 'Purchase Order'),
  sub('procurement', 'grn', 'Goods Receipt (GRN)'),
  sub('procurement', 'supplier_invoice', 'Supplier Invoice · 3-way'),

  // SUPPLIERS (BP-10)
  sub('suppliers', 'supplier_party', 'Supplier (Party B)'),
  sub('suppliers', 'supplier_kyc', 'KYC / Prequalification'),
  sub('suppliers', 'supplier_performance', 'Performance / Risk'),

  // CONTRACTORS (BP-11)
  sub('contractors', 'contractor_party', 'Contractor (Party B)'),
  sub('contractors', 'contractor_contract', 'Contract / BOQ'),
  sub('contractors', 'measurement', 'Progress Measurement'),
  sub('contractors', 'ipc', 'IPC / Payment Certificate'),
  sub('contractors', 'retention_advance', 'Retention / Advance'),
  sub('contractors', 'claims', 'Claims / Variations'),

  // WAREHOUSE (BP-12)
  sub('warehouse', 'stock', 'Stock on Hand'),
  sub('warehouse', 'material_request', 'Material Request'),
  sub('warehouse', 'material_issue', 'Material Issue'),
  sub('warehouse', 'transfer_return', 'Transfer / Return'),
  sub('warehouse', 'count_valuation', 'Count / Valuation'),

  // HR (BP-14)
  sub('hr', 'employee', 'Employee (Party B)'),
  sub('hr', 'attendance', 'Attendance'),
  sub('hr', 'leave', 'Leave / Overtime'),
  sub('hr', 'performance', 'Performance / Training'),

  // PAYROLL (BP-15)
  sub('payroll', 'payroll_run', 'Payroll Run'),
  sub('payroll', 'payroll_approval', 'Payroll Approval'),
  sub('payroll', 'payslip', 'Payslip'),
  sub('payroll', 'bank_payment', 'Bank Payment'),
  sub('payroll', 'allocation', 'Project / CC Allocation'),

  // EXPENSE (BP-13)
  sub('expense', 'expense_request', 'Expense Request'),
  sub('expense', 'budget_check', 'Budget Check'),
  sub('expense', 'expense_payment', 'Expense Payment'),
  sub('expense', 'asset_register', 'Fixed Asset Register'),

  // DOCUMENTS (BP-16)
  sub('documents', 'doc_version', 'Version / Revision'),
  sub('documents', 'doc_approval', 'Approval / e-Sign'),
  sub('documents', 'classification', 'Classification / ACL'),
  sub('documents', 'knowledge_ingestion', 'Knowledge Ingestion'),
  sub('documents', 'tg_attachments', 'Telegram Attachments'),

  // WORKFLOW (BP-17)
  sub('workflow', 'requester', 'Requester'),
  sub('workflow', 'reviewer', 'Reviewer'),
  sub('workflow', 'approver', 'Approver'),
  sub('workflow', 'final_approver', 'Final Approver'),
  sub('workflow', 'execution', 'Execution'),
  sub('workflow', 'ai_proposal', 'AI Action Proposal'),

  // SECURITY (BP-23)
  sub('security', 'authn', 'Authentication / MFA'),
  sub('security', 'rbac', 'RBAC'),
  sub('security', 'project_scope', 'Project / Dept Scope'),
  sub('security', 'field_security', 'Field-level Security'),
  sub('security', 'sod', 'Segregation of Duties'),
  sub('security', 'ai_authz', 'AI Query-time Authz'),
  sub('security', 'audit_log', 'Audit Log'),

  // MASTER DATA (BP-21)
  sub('master_data', 'md_projects', 'Projects / Units'),
  sub('master_data', 'md_parties', 'Customers / Suppliers / Contractors'),
  sub('master_data', 'md_materials', 'Materials / Services'),
  sub('master_data', 'md_coa', 'Chart of Accounts / CC'),
  sub('master_data', 'md_policies', 'Approval Policies'),

  // ORG & ACCESS (BP-02)
  sub('org_access', 'user_account', 'User Account (Type A)'),
  sub('org_access', 'role', 'Role'),
  sub('org_access', 'permission', 'Permission'),
  sub('org_access', 'department', 'Department'),
  sub('org_access', 'project_assignment', 'Project Assignment'),
  sub('org_access', 'approval_authority', 'Approval Authority'),
  sub('org_access', 'machine_identity', 'Machine Identity'),

  // MULTI-PROJECT (BP-03)
  sub('multi_project', 'company', 'Company'),
  sub('multi_project', 'legal_entity', 'Legal Entity'),
  sub('multi_project', 'project', 'Project'),
  sub('multi_project', 'block', 'Block / Tower'),
  sub('multi_project', 'floor', 'Floor'),
  sub('multi_project', 'unit_md', 'Unit'),

  // EXEC CENTER (BP-18)
  sub('exec_center', 'kpi', 'Executive KPI'),
  sub('exec_center', 'ai_briefing', 'AI Briefing'),
  sub('exec_center', 'drilldown', 'Drill-down'),
  sub('exec_center', 'approval_inbox', 'Needs your decision'),

  // BI (BP-19)
  sub('bi', 'dwh', 'Data Warehouse'),
  sub('bi', 'semantic', 'Semantic Layer'),
  sub('bi', 'dashboard', 'Dashboards'),
  sub('bi', 'ai_features', 'AI Feature Store'),

  // DATA / INTEGRATION (BP-22)
  sub('data_integration', 'api_gateway', 'API Gateway'),
  sub('data_integration', 'event_bus', 'Event Bus'),
  sub('data_integration', 'oltp', 'OLTP (system of record)'),
  sub('data_integration', 'object_store', 'Object Store'),
  sub('data_integration', 'knowledge_store', 'Knowledge / Vector Store'),
  sub('data_integration', 'connectors', 'Banks · Payments · Biometric · BIM'),

  // PORTALS (BP-24)
  sub('portals', 'customer_portal', 'Customer Portal'),
  sub('portals', 'supplier_portal', 'Supplier Portal'),
  sub('portals', 'contractor_portal', 'Contractor Portal'),

  // TELEGRAM (TG-01)
  sub('telegram', 'tg_bot_api', 'Telegram Bot API'),
  sub('telegram', 'tg_gateway', 'Telegram Gateway'),
  sub('telegram', 'identity_binding', 'Identity Binding (Type A)'),
  sub('telegram', 'permission_context', 'Permission Context'),
  sub('telegram', 'webhook_security', 'Webhook · Replay · Rate limit'),
  sub('telegram', 'step_up', 'Step-up / Secure Deep Link'),
  sub('telegram', 'tg_notifications', 'Notifications'),

  // LLM PROVIDERS
  sub('llm_providers', 'provider_a', 'External Provider A'),
  sub('llm_providers', 'provider_b', 'External Provider B'),
  sub('llm_providers', 'private_model', 'Private / Self-hosted Model'),

  // TRACEABILITY / RELATIONSHIP MAP / MASTER MAP
  sub('traceability', 'forward_trace', 'Forward trace'),
  sub('traceability', 'reverse_trace', 'Reverse trace'),
  sub('traceability', 'ai_trace', 'AI / Telegram trace'),
  sub('relationship_map', 'flow_financial', 'Financial flow'),
  sub('relationship_map', 'flow_data', 'Data flow'),
  sub('relationship_map', 'flow_document', 'Document flow'),
  sub('relationship_map', 'flow_approval', 'Approval flow'),
  sub('relationship_map', 'flow_user', 'User flow'),
  sub('relationship_map', 'flow_ai', 'AI / channel flow'),
  sub('master_map', 'stakeholders', 'Stakeholders'),
  sub('master_map', 'channels', 'Channels'),
  sub('master_map', 'engines', 'Shared engines'),
  sub('master_map', 'platform', 'Platform / infrastructure'),
];

export const ALL_NODES: WorldNode[] = [...TOP_NODES, ...SUB_NODES];
export const NODE_BY_ID: Record<string, WorldNode> = Object.fromEntries(ALL_NODES.map(n => [n.id, n]));
export const childrenOf = (id: string) => SUB_NODES.filter(n => n.parent === id);
export const topOf = (id: string): string => NODE_BY_ID[id]?.parent ?? id;
