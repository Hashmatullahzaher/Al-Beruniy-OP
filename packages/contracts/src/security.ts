import type {
  CostCenterId,
  DepartmentId,
  LegalEntityId,
  ProjectId,
  UserAccountId
} from "./ids.ts";
import type { TreasuryPermission } from "./treasury.ts";

export type FinancePermission =
  | "finance.posting-intent.approve"
  | "finance.journal.post"
  | "finance.journal.reverse"
  | "finance.report.operational.read";

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
