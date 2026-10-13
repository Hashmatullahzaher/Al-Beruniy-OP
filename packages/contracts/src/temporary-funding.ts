/**
 * P2 Temporary Funding (isolated schema proposal infrastructure/database/proposals/p2_temporary_funding.sql).
 *
 * A person or organization that temporarily funds the business creates an explicit liability,
 * TEMPORARY_FUNDING_PAYABLE, per provider. It is never shareholder capital and never negative Safe cash.
 */

export type TemporaryFundingMode = "PROVIDER_PAID_EXPENSE" | "PROVIDER_FUNDED_SAFE";
export type TemporaryFundingProviderKind = "SHAREHOLDER" | "EMPLOYEE_OFFICER" | "OTHER_PERSON" | "ORGANIZATION";
export type TemporaryFundingStatus = "PENDING_APPROVAL" | "REJECTED" | "CANCELLED" | "POSTED" | "REVERSED";
/** Stored status plus derived settlement progress. */
export type TemporaryFundingLifecycleStatus = TemporaryFundingStatus | "PARTIALLY_SETTLED" | "SETTLED";
export type TemporaryFundingSettlementStatus = "PENDING_APPROVAL" | "REJECTED" | "CANCELLED" | "POSTED";
export type TemporaryFundingDecision = "APPROVED" | "REJECTED";

export const TEMPORARY_FUNDING_PERMISSIONS = [
  "finance.temporary-funding.read",
  "finance.temporary-funding.create",
  "finance.temporary-funding.approve",
  "finance.temporary-funding.settle",
  "finance.temporary-funding.settle-approve",
  "finance.temporary-funding.reverse",
  "finance.temporary-funding.configure"
] as const;

export type TemporaryFundingPermission = (typeof TEMPORARY_FUNDING_PERMISSIONS)[number];

interface NamedAccount {
  readonly id: string;
  readonly nameEn: string;
  readonly nameFa: string | null;
  readonly accountType: string;
}

export interface TemporaryFundingDecisionView {
  readonly decision: TemporaryFundingDecision;
  readonly note: string;
  readonly decidedBy: string;
  readonly decidedAt: string;
}

export interface TemporaryFundingSettlementView {
  readonly id: string;
  readonly temporaryFundingId: string;
  readonly treasuryAccount: NamedAccount;
  readonly reference: string;
  readonly note: string | null;
  readonly businessDate: string;
  readonly amount: string;
  readonly currencyCode: string;
  readonly status: TemporaryFundingSettlementStatus;
  readonly statusReason: string | null;
  readonly version: number;
  readonly journalId: string | null;
  readonly createdBy: string;
  readonly createdByUserAccountId: string;
  readonly createdAt: string;
  readonly decision: TemporaryFundingDecisionView | null;
}

export interface TemporaryFundingReversalView {
  readonly id: string;
  readonly status: "REQUESTED" | "REJECTED" | "POSTED";
  readonly version: number;
  readonly reversalDate: string;
  readonly reason: string;
  readonly requestedBy: string;
  readonly requestedByUserAccountId: string;
  readonly requestedAt: string;
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
  readonly decisionNote: string | null;
  readonly reversalJournalId: string | null;
}

export interface TemporaryFundingView {
  readonly id: string;
  readonly fundingMode: TemporaryFundingMode;
  readonly providerKind: TemporaryFundingProviderKind;
  readonly provider: { readonly id: string; readonly name: string };
  readonly providerUserAccountId: string | null;
  readonly expenseCategory: { readonly id: string; readonly code: string; readonly nameEn: string; readonly nameFa: string | null } | null;
  readonly payee: { readonly id: string; readonly name: string } | null;
  readonly treasuryAccount: NamedAccount | null;
  readonly projectId: string | null;
  readonly departmentId: string | null;
  readonly costCenterId: string | null;
  readonly reference: string;
  readonly description: string;
  readonly note: string | null;
  readonly businessDate: string;
  readonly amount: string;
  readonly currencyCode: string;
  readonly status: TemporaryFundingStatus;
  readonly statusReason: string | null;
  readonly version: number;
  readonly lifecycleStatus: TemporaryFundingLifecycleStatus;
  readonly settledAmount: string;
  readonly pendingSettlementAmount: string;
  readonly outstandingAmount: string;
  readonly journalId: string | null;
  readonly createdBy: string;
  readonly createdByUserAccountId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly decision: TemporaryFundingDecisionView | null;
  readonly settlements: readonly TemporaryFundingSettlementView[];
  readonly reversal: TemporaryFundingReversalView | null;
}

export interface TemporaryFundingProviderSummary {
  readonly businessPartyId: string;
  readonly name: string;
  readonly providerKinds: readonly TemporaryFundingProviderKind[];
  readonly fundedAmount: string;
  readonly settledAmount: string;
  readonly reversedAmount: string;
  /** From the posted TEMPORARY_FUNDING_PAYABLE subledger: the authoritative amount owed. */
  readonly outstandingAmount: string;
  readonly openFundings: number;
  readonly status: "OUTSTANDING" | "PARTIALLY_SETTLED" | "SETTLED";
}

export interface TemporaryFundingSafePosition {
  readonly treasuryAccountId: string;
  readonly nameEn: string;
  readonly nameFa: string | null;
  readonly accountType: string;
  readonly currencyCode: string;
  /** Sum of posted Operational V1 movements. Not a balance unless an opening is approved. */
  readonly postedMovementTotal: string;
  readonly temporaryFundingInflow: string;
  readonly temporaryFundingSettlementOutflow: string;
  readonly cashControl: null | { readonly openingAmount: string; readonly openingAsOf: string; readonly recordedCash: string };
  readonly nonNegativeEnforced: boolean;
}

export interface TemporaryFundingWorkspace {
  readonly legalEntityId: string;
  readonly baseCurrency: string | null;
  readonly actorUserAccountId: string;
  readonly permissions: {
    readonly canRead: boolean;
    readonly canCreate: boolean;
    readonly canApprove: boolean;
    readonly canSettle: boolean;
    readonly canApproveSettlement: boolean;
    readonly canReverse: boolean;
    readonly canConfigure: boolean;
  };
  readonly configuration: {
    readonly mapping: null | {
      readonly id: string;
      readonly version: number;
      readonly payableLedgerAccount: { readonly id: string; readonly code: string; readonly name: string };
      readonly configuredAt: string;
    };
    readonly policy: null | { readonly id: string; readonly version: number; readonly approvalRequired: boolean };
  };
  readonly providers: readonly TemporaryFundingProviderSummary[];
  readonly payableTotal: string;
  readonly safePositions: readonly TemporaryFundingSafePosition[];
  readonly fundings: readonly TemporaryFundingView[];
  readonly options: {
    readonly treasuryAccounts: readonly (NamedAccount & { readonly currencyCode: string })[];
    readonly expenseCategories: readonly { readonly id: string; readonly code: string; readonly nameEn: string; readonly nameFa: string | null }[];
    readonly parties: readonly { readonly id: string; readonly name: string; readonly roles: readonly string[] }[];
    readonly payableLedgerAccounts: readonly { readonly id: string; readonly code: string; readonly name: string }[];
  };
}

export interface TemporaryFundingCreate {
  readonly fundingMode: TemporaryFundingMode;
  readonly providerKind: TemporaryFundingProviderKind;
  readonly providerBusinessPartyId: string;
  readonly providerUserAccountId: string | null;
  readonly expenseCategoryId: string | null;
  readonly payeeBusinessPartyId: string | null;
  readonly projectId: string | null;
  readonly departmentId: string | null;
  readonly costCenterId: string | null;
  readonly treasuryAccountId: string | null;
  readonly reference: string;
  readonly description: string;
  readonly note: string | null;
  readonly businessDate: string;
  readonly originalAmount: string;
  readonly currencyCode: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
}

export interface TemporaryFundingSettlementCreate {
  readonly temporaryFundingId: string;
  readonly treasuryAccountId: string;
  readonly reference: string;
  readonly note: string | null;
  readonly businessDate: string;
  readonly originalAmount: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
}

export interface TemporaryFundingReversalRequest {
  readonly temporaryFundingId: string;
  readonly reversalDate: string;
  readonly reason: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
}

/** One Temporary Funding command, as the API accepts it. */
export type TemporaryFundingCommand =
  | ({ readonly action: "create" } & TemporaryFundingCreate)
  | { readonly action: "decide"; readonly temporaryFundingId: string; readonly expectedVersion: number;
      readonly decision: TemporaryFundingDecision; readonly note: string }
  | { readonly action: "cancel"; readonly temporaryFundingId: string; readonly expectedVersion: number;
      readonly reason: string }
  | ({ readonly action: "settlement-create" } & TemporaryFundingSettlementCreate)
  | { readonly action: "settlement-decide"; readonly settlementId: string; readonly expectedVersion: number;
      readonly decision: TemporaryFundingDecision; readonly note: string }
  | { readonly action: "settlement-cancel"; readonly settlementId: string; readonly expectedVersion: number;
      readonly reason: string }
  | ({ readonly action: "reversal-request" } & TemporaryFundingReversalRequest)
  | { readonly action: "reversal-decide"; readonly reversalId: string; readonly expectedVersion: number;
      readonly decision: TemporaryFundingDecision; readonly note: string }
  | { readonly action: "configure"; readonly payableLedgerAccountId: string; readonly expectedVersion: number;
      readonly changeReason: string };

export type TemporaryFundingAction = TemporaryFundingCommand["action"];

export interface TemporaryFundingResult {
  readonly replayed: boolean;
  readonly funding?: TemporaryFundingView;
  readonly settlement?: TemporaryFundingSettlementView;
  readonly [key: string]: unknown;
}
