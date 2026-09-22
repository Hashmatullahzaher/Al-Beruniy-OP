import type { DepartmentId, LegalEntityId, ProjectId, UserAccountId } from "./ids.ts";

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
  readonly authenticatedAt: string;
  readonly stepUpVerifiedAt?: string;
}
