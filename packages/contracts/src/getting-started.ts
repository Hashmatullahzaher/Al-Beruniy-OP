import type { FinanceWorkflowPolicy, FinanceWorkflowType } from "./workflow-policy.ts";

/**
 * Getting started (first run). The wizard is an orchestration layer: every choice below is saved through the
 * existing commands (workflow policy versions, the calendar, Chart of Accounts, Treasury setup, shareholder
 * capital), and every step's progress is derived from what really exists, never from a stored "done" flag.
 */

export type OperatingMode = "SIMPLE" | "ADVANCED";

/** The workflow settings each operating mode saves, through the ordinary versioned policy command. */
export const OPERATING_MODE_POLICIES: Readonly<Record<OperatingMode, readonly { readonly workflowType: FinanceWorkflowType; readonly approvalRequired: boolean }[]>> = {
  SIMPLE: [
    { workflowType: "CHART_OF_ACCOUNTS", approvalRequired: false },
    { workflowType: "SHAREHOLDER_CAPITAL_RECEIPT", approvalRequired: false },
    { workflowType: "EXPENSE", approvalRequired: false },
    { workflowType: "JOURNAL_REVERSAL", approvalRequired: false }
  ],
  ADVANCED: [
    { workflowType: "CHART_OF_ACCOUNTS", approvalRequired: true },
    { workflowType: "SHAREHOLDER_CAPITAL_RECEIPT", approvalRequired: true },
    { workflowType: "EXPENSE", approvalRequired: true },
    { workflowType: "JOURNAL_REVERSAL", approvalRequired: true }
  ]
};

/** The audit reason every policy version saved by Getting started carries. */
export const OPERATING_MODE_REASON: Readonly<Record<OperatingMode, string>> = {
  SIMPLE: "Configured by Getting Started — Simple / Single Operator",
  ADVANCED: "Configured by Getting Started — Advanced Controls"
};

export interface OperatingModePlanItem {
  readonly workflowType: FinanceWorkflowType;
  readonly approvalRequired: boolean;
  /** The version the save must expect (optimistic concurrency of the existing command). */
  readonly expectedVersion: number;
}

export interface OperatingModePlan {
  /** Versions still to save; empty when the mode is already in force. */
  readonly saves: readonly OperatingModePlanItem[];
  /** Workflows the mode would set ON but that have no approval lane yet: left untouched, never saved ON. */
  readonly unavailable: readonly FinanceWorkflowType[];
  /** Workflows the company does not have (older installations): reported, never invented. */
  readonly missing: readonly FinanceWorkflowType[];
}

/** What choosing a mode would save: only the settings not already explicitly in force, never an unusable ON. */
export function operatingModePlan(mode: OperatingMode, policies: readonly FinanceWorkflowPolicy[]): OperatingModePlan {
  const saves: OperatingModePlanItem[] = []; const unavailable: FinanceWorkflowType[] = []; const missing: FinanceWorkflowType[] = [];
  for (const target of OPERATING_MODE_POLICIES[mode]) {
    const policy = policies.find((item) => item.workflowType === target.workflowType);
    if (policy === undefined) { missing.push(target.workflowType); continue; }
    if (target.approvalRequired && !policy.approvalAvailable) { unavailable.push(target.workflowType); continue; }
    if (policy.configured && policy.approvalRequired === target.approvalRequired) continue;
    saves.push({ workflowType: target.workflowType, approvalRequired: target.approvalRequired, expectedVersion: policy.version });
  }
  return { saves, unavailable, missing };
}

/** The mode in force: every setting of a mode explicitly saved (unavailable ON settings excepted), else MIXED or NOT_CHOSEN. */
export function operatingModeInForce(policies: readonly FinanceWorkflowPolicy[]): OperatingMode | "MIXED" | "NOT_CHOSEN" {
  for (const mode of ["SIMPLE", "ADVANCED"] as const) {
    const plan = operatingModePlan(mode, policies);
    if (plan.saves.length === 0 && plan.missing.length === 0) return mode;
  }
  const touched = OPERATING_MODE_POLICIES.SIMPLE.some((target) => policies.find((item) => item.workflowType === target.workflowType)?.configured);
  return touched ? "MIXED" : "NOT_CHOSEN";
}

/**
 * The single-operator Finance role a Super Administrator can create from Roles & permissions in one save. It is a
 * template: the administrator still sees every permission before creating it, and nobody receives it implicitly.
 */
export const FINANCE_MANAGER_ROLE_TEMPLATE = {
  name: "Finance Manager",
  description: "Single-operator Finance: setup, money in and out, reports, reversals and year close.",
  permissions: [
    "admin.finance-workflow.manage", "company.dashboard.read",
    "finance.calendar.manage", "finance.period.manage", "finance.report.operational.read",
    "finance.ledger-account.manage", "finance.ledger-account.review",
    "finance.capital-receipt.prepare", "finance.capital-receipt.approve", "finance.capital-receipt.post", "finance.capital-receipt.configure",
    "finance.expense-category.manage", "finance.expense.create", "finance.expense.read", "finance.expense.approve",
    "finance.exchange-rate.record", "finance.fx-policy.manage",
    "finance.reversal.request", "finance.reversal.approve", "finance.reversal.direct",
    "finance.temporary-funding.read", "finance.temporary-funding.record", "finance.temporary-funding.approve",
    "finance.temporary-funding.configure", "finance.temporary-funding.settle", "finance.temporary-funding.settle-approve",
    "finance.loan.read", "finance.loan.record", "finance.loan.repay", "finance.loan.approve",
    "shareholder.read", "shareholder.setup.manage", "shareholder.capital-receipt.read", "shareholder.capital-receipt.record",
    "treasury.safe.read", "treasury.cash-location.manage", "treasury.operational-account.manage", "treasury.saraf-account.manage",
    "treasury.opening-balance.record", "treasury.receipt.record", "treasury.payment.record", "treasury.transfer.record",
    "treasury.capital-receipt.verify"
  ]
} as const;

/** What each Getting started step needs the signed-in person to hold. The database checks every command again. */
export const GETTING_STARTED_PERMISSIONS = {
  operatingMode: ["admin.finance-workflow.manage"],
  financialYear: ["finance.calendar.manage"],
  accounts: ["finance.ledger-account.manage"],
  treasury: ["treasury.operational-account.manage", "finance.expense-category.manage"],
  firstMoney: ["shareholder.setup.manage", "shareholder.capital-receipt.record"],
  reports: ["finance.report.operational.read"]
} as const;

/** Every permission the Getting started steps use: a Finance operator holding all of them can finish setup alone. */
export const GETTING_STARTED_FINANCE_PERMISSIONS: readonly string[] = [...new Set(Object.values(GETTING_STARTED_PERMISSIONS).flat())];

export type RequiredAccountKind = "CASH" | "SHAREHOLDER_CAPITAL" | "EXPENSE";

export interface AccountReadinessInput {
  readonly id: string; readonly code: string; readonly name: string; readonly type: string; readonly controlType: string | null;
  readonly currency: string | null; readonly status: string; readonly postingAllowed: boolean; readonly reviewState: string | null;
}

export interface AccountReadiness {
  readonly kind: RequiredAccountKind;
  /** READY: usable now. WAITING: exists but waits for review. MISSING: none exists. */
  readonly state: "READY" | "WAITING" | "MISSING";
  readonly account: AccountReadinessInput | null;
}

/** Whether a posting can use the account now: no review is pending (an account created outside the app has no review state). */
function usable(account: AccountReadinessInput): boolean {
  return account.reviewState === null || account.reviewState === "REVIEWED" || account.reviewState === "NOT_REQUIRED";
}

/** The three accounts a first capital receipt and a first expense need, matched in the company's base currency. */
export function requiredAccounts(accounts: readonly AccountReadinessInput[], baseCurrency: string | null): readonly AccountReadiness[] {
  const matches: Readonly<Record<RequiredAccountKind, (account: AccountReadinessInput) => boolean>> = {
    CASH: (a) => a.type === "ASSET" && a.controlType === "CASH" && a.currency === baseCurrency,
    SHAREHOLDER_CAPITAL: (a) => a.type === "EQUITY" && a.controlType === "SHAREHOLDER_CAPITAL" && a.currency === baseCurrency,
    EXPENSE: (a) => a.type === "EXPENSE" && a.controlType === null
  };
  return (["CASH", "SHAREHOLDER_CAPITAL", "EXPENSE"] as const).map((kind) => {
    const candidates = accounts.filter((account) => account.status === "ACTIVE" && account.postingAllowed && matches[kind](account));
    const ready = candidates.find(usable);
    if (ready) return { kind, state: "READY", account: ready };
    const waiting = candidates.find((account) => account.reviewState === "PENDING_REVIEW");
    return waiting ? { kind, state: "WAITING", account: waiting } : { kind, state: "MISSING", account: null };
  });
}

/** The suggested first financial year: the one containing today, never next year, unless that one already exists. */
export function suggestedFirstYear(todayYear: number, existingYears: readonly number[]): number {
  if (!existingYears.includes(todayYear)) return todayYear;
  return Math.max(...existingYears) + 1;
}
