import { z } from "zod";

export const FINANCE_WORKFLOW_TYPES = [
  "CHART_OF_ACCOUNTS",
  "SHAREHOLDER_CAPITAL_RECEIPT",
  "CUSTOMER_RECEIPT",
  "OTHER_INCOME",
  "EXPENSE",
  "SUPPLIER_PAYMENT",
  "SALARY_PAYMENT",
  "TREASURY_TRANSFER",
  "TEMPORARY_FUNDING",
  "PERIOD_REOPEN",
  "JOURNAL_REVERSAL"
] as const;

export type FinanceWorkflowType = (typeof FINANCE_WORKFLOW_TYPES)[number];

export const financeWorkflowTypeSchema = z.enum(FINANCE_WORKFLOW_TYPES);

/** 0049 Simple Mode: these workflows record in one save (approval OFF) until a setting is saved. */
export const SIMPLE_MODE_DEFAULT_WORKFLOWS: readonly FinanceWorkflowType[] = ["OTHER_INCOME", "EXPENSE", "SUPPLIER_PAYMENT", "SALARY_PAYMENT", "TREASURY_TRANSFER",
  "PERIOD_REOPEN", "JOURNAL_REVERSAL"];

export const financeWorkflowPolicyUpdateSchema = z.object({
  approvalRequired: z.boolean(),
  expectedVersion: z.number().int().min(0),
  changeReason: z.string().trim().min(5).max(500),
  idempotencyKey: z.string().trim().min(8).max(200),
  correlationId: z.uuid()
}).strict();

export interface FinanceWorkflowPolicyHistoryItem {
  readonly policyVersionId: string;
  readonly version: number;
  readonly approvalRequired: boolean;
  readonly changeReason: string;
  readonly configuredAt: string;
  readonly configuredBy: string;
}

export interface FinanceWorkflowPolicy {
  readonly workflowType: FinanceWorkflowType;
  readonly labelEn: string;
  readonly labelFa: string;
  /** 0049: false where the lane has no approval path yet; ON cannot be saved there. */
  readonly approvalAvailable: boolean;
  readonly configured: boolean;
  readonly policyVersionId: string | null;
  readonly version: number;
  readonly approvalRequired: boolean | null;
  readonly changeReason: string | null;
  readonly configuredAt: string | null;
  readonly configuredBy: string | null;
  readonly history: readonly FinanceWorkflowPolicyHistoryItem[];
}

export interface FinanceWorkflowPolicyWorkspace {
  readonly replayed?: boolean;
  readonly legalEntityId: string;
  readonly canManage: boolean;
  readonly policies: readonly FinanceWorkflowPolicy[];
}
