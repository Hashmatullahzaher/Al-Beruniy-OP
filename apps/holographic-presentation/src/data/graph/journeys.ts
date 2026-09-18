import type { Journey } from './types';

// End-to-end traceable journeys — BP-26 Scenarios 1–5 + Reverse Trace A, expressed as ordered
// node ids through the 3D world (subnodes are auto-expanded when a journey is traced).
export const JOURNEYS: Journey[] = [
  {
    id: 'j1', code: 'J1', title: 'Sale to Cash', ref: 'BP-26 Scenario 1 · BP-05 · BP-06 · BP-04',
    steps: ['lead', 'customer', 'unit', 'reservation', 'contract', 'installment', 'receipt', 'ar', 'cash_bank', 'journal', 'gl', 'kpi'],
  },
  {
    id: 'j2', code: 'J2', title: 'Procure to Pay', ref: 'BP-26 Scenario 2 · BP-09 · BP-12 · BP-04',
    steps: ['site_material_request', 'pr', 'rfq', 'supplier_party', 'po', 'grn', 'stock', 'material_issue', 'actual_cost', 'supplier_invoice', 'ap', 'cash_bank', 'gl'],
  },
  {
    id: 'j3', code: 'J3', title: 'Contractor Certification', ref: 'BP-26 Scenario 3 · BP-11 · BP-08 · BP-04',
    steps: ['contractor_party', 'contractor_contract', 'measurement', 'ipc', 'retention_advance', 'ap', 'cash_bank', 'actual_cost', 'gl'],
  },
  {
    id: 'j4', code: 'J4', title: 'Payroll', ref: 'BP-26 Scenario 4 · BP-14 · BP-15 · BP-04',
    steps: ['employee', 'attendance', 'payroll_run', 'payroll_approval', 'bank_payment', 'allocation', 'project_accounting', 'gl'],
  },
  {
    id: 'j5', code: 'J5', title: 'Executive Reverse Trace', ref: 'BP-26 Reverse Trace A · BP-18',
    steps: ['kpi', 'project', 'cost_centers', 'expense_request', 'po', 'supplier_party', 'supplier_invoice', 'grn', 'requester', 'approver', 'cash_bank', 'journal', 'gl'],
  },
  {
    id: 'j6', code: 'J6', title: 'Telegram → AI Core', ref: 'BP-26 Scenario 5 · TELEGRAM_INTEGRATION.md · AI_CORE.md',
    steps: ['tg_bot_api', 'tg_gateway', 'identity_binding', 'permission_context', 'guardrails', 'orchestrator', 'knowledge_plane', 'tool_registry', 'expense_request', 'requester', 'approver', 'ai_audit', 'tg_notifications'],
  },
];
