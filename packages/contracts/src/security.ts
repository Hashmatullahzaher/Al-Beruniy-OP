import type {
  CostCenterId,
  DepartmentId,
  LegalEntityId,
  ProjectId,
  UserAccountId
} from "./ids.ts";
import type { TreasuryPermission } from "./treasury.ts";

export type FinancePermission =
  | "finance.posting-intent.create"
  | "finance.posting-intent.approve"
  | "finance.journal.post"
  | "finance.journal.reverse"
  | "finance.report.operational.read"
  | "finance.expense-category.manage"
  | "finance.expense.create"
  | "finance.expense.read"
  | "finance.expense.approve"
  | "finance.period.manage"
  | "shareholder.capital-receipt.read"
  | "finance.capital-receipt.configure"
  | "finance.capital-receipt.prepare"
  | "finance.capital-receipt.approve"
  | "finance.capital-receipt.post"
  | "finance.temporary-funding.read"
  | "finance.temporary-funding.record"
  | "finance.temporary-funding.approve"
  | "finance.temporary-funding.settle"
  | "finance.temporary-funding.settle-approve"
  | "finance.temporary-funding.configure";

export interface ServerActorContext {
  readonly userAccountId: UserAccountId;
  readonly permissions: readonly FinancePermission[];
  readonly legalEntityIds: readonly LegalEntityId[];
  readonly projectIds: readonly ProjectId[];
  readonly departmentIds: readonly DepartmentId[];
  /**
   * `stage1-e0-v2`. Cost-centre scope, enforced for cost-centre-scoped transactions - finding F-8.
   * Absent means "no cost centre is in scope", so a cost-centre-scoped transaction is refused.
   * Corporate capital is COMPANY_LEVEL and carries no cost centre, so it is unaffected.
   */
  readonly costCenterIds?: readonly CostCenterId[];
  /**
   * `stage1-e1-treasury-v1`. Treasury authority, kept separate from `permissions` so a Treasury
   * grant can never be read as a Finance one. Resolved from persisted grants only.
   */
  readonly treasuryPermissions?: readonly TreasuryPermission[];
  readonly authenticatedAt: string;
  readonly stepUpVerifiedAt?: string;
  /**
   * `stage1-e0-v2`. Identifies the server-side session this context was derived from. A context
   * assembled from a request payload has none, and the sandbox boundary refuses it.
   */
  readonly sessionId?: string;
  /** `stage1-e0-v2`. Expiry of the issuing session; a context outliving it is refused. */
  readonly expiresAt?: string;
}

/**
 * Permission codes retired with migration 0041 (`abos.permission_retirements`), plus the monthly reopen
 * retired by 0052 (Al-Beruniy closes a financial year, never a month). The 0041 codes belong only to
 * the frozen E1 synthetic lane. For all of them the catalogue rows and every existing grant stay exactly as they
 * are, but a retired code cannot be added to a role, the role editor shows it as retired, and the
 * dashboard no longer lists it. The integration suite asserts this list equals the register.
 */
export const RETIRED_PERMISSION_CODES: ReadonlySet<string> = new Set([
  "treasury.read",
  "treasury.cash-receipt.record",
  "treasury.cash-count.record",
  "treasury.cash-receipt.verify",
  "treasury.handoff.create",
  "treasury.cash-account.reconcile",
  "treasury.cash-account.approve",
  "shareholder.capital-request.create",
  "shareholder.capital-intent.create",
  "finance.posting-intent.create",
  "finance.posting-intent.approve",
  "finance.journal.post",
  "finance.period.reopen"
]);
