/**
 * V1 Temporary Funding (migration 0037). A person or organization that temporarily funds the business
 * creates an explicit per-provider liability (control type TEMPORARY_FUNDING_PAYABLE). It is never
 * shareholder capital and never negative Safe cash. First slice: base currency only, no reversal.
 */

export type TemporaryFundingMode = "PROVIDER_PAID_EXPENSE_DIRECTLY" | "PROVIDER_FUNDED_SAFE";
export type TemporaryFundingProviderKind = "SHAREHOLDER" | "EMPLOYEE_OFFICER" | "INDIVIDUAL" | "ORGANIZATION";
export type TemporaryFundingStatus = "PENDING_APPROVAL" | "REJECTED" | "POSTED";
/** Stored status plus derived settlement progress. */
export type TemporaryFundingLifecycleStatus = TemporaryFundingStatus | "PARTIALLY_SETTLED" | "SETTLED";
export type TemporaryFundingSettlementStatus = "PENDING_APPROVAL" | "REJECTED" | "POSTED";
export type TemporaryFundingDecision = "APPROVED" | "REJECTED";

/** Typed source discriminators carried by posting intents, journal lines and subledger entries. */
export const TEMPORARY_FUNDING_SOURCE_TYPES = ["TEMPORARY_FUNDING", "TEMPORARY_FUNDING_SETTLEMENT"] as const;

export const TEMPORARY_FUNDING_PERMISSIONS = [
  "finance.temporary-funding.read",
  "finance.temporary-funding.record",
  "finance.temporary-funding.approve",
  "finance.temporary-funding.settle",
  "finance.temporary-funding.settle-approve",
  "finance.temporary-funding.configure"
] as const;

export type TemporaryFundingPermission = (typeof TEMPORARY_FUNDING_PERMISSIONS)[number];

export interface TemporaryFundingMoney {
  readonly amount: string;
  readonly currency: string;
}

interface NamedAccount {
  readonly id: string;
  readonly nameEn: string;
  readonly nameFa: string | null;
  readonly accountType: string;
}

export interface TemporaryFundingDecisionView {
  readonly decision: TemporaryFundingDecision;
  readonly reason: string;
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

export interface TemporaryFundingView {
  readonly id: string;
  readonly fundingMode: TemporaryFundingMode;
  readonly providerKind: TemporaryFundingProviderKind;
  readonly provider: { readonly id: string; readonly name: string };
  readonly providerUserAccountId: string | null;
  readonly expenseCategory: { readonly id: string; readonly code: string; readonly nameEn: string; readonly nameFa: string | null } | null;
  readonly payee: { readonly id: string; readonly name: string } | null;
  readonly treasuryAccount: NamedAccount | null;
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
  readonly mappingVersionId: string;
  readonly workflowPolicyVersionId: string;
  readonly createdBy: string;
  readonly createdByUserAccountId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly decision: TemporaryFundingDecisionView | null;
  readonly settlements: readonly TemporaryFundingSettlementView[];
}

export interface TemporaryFundingProviderSummary {
  readonly businessPartyId: string;
  readonly name: string;
  readonly providerKinds: readonly TemporaryFundingProviderKind[];
  readonly fundedAmount: string;
  readonly settledAmount: string;
  /** From the posted TEMPORARY_FUNDING_PAYABLE subledger: the authoritative amount owed. */
  readonly outstandingAmount: string;
  readonly status: "OUTSTANDING" | "PARTIALLY_SETTLED" | "SETTLED";
}

export interface TemporaryFundingSafePosition {
  readonly treasuryAccountId: string;
  readonly nameEn: string;
  readonly nameFa: string | null;
  readonly accountType: string;
  readonly currencyCode: string;
  /** Sum of posted Operational V1 movements. Not a balance: no opening balance is approved yet. */
  readonly postedMovementTotal: string;
  readonly temporaryFundingInflow: string;
  readonly temporaryFundingSettlementOutflow: string;
}

export type TemporaryFundingCapabilityReason =
  | "BASE_CURRENCY_NOT_APPROVED" | "POLICY_NOT_CONFIGURED" | "APPROVAL_MUST_BE_REQUIRED"
  | "PAYABLE_MAPPING_NOT_CONFIGURED" | "PAYABLE_MAPPING_INVALID";

export interface TemporaryFundingWorkspace {
  readonly legalEntityId: string;
  readonly baseCurrency: string | null;
  readonly actorUserAccountId: string;
  readonly permissions: {
    readonly canRead: boolean;
    readonly canRecord: boolean;
    readonly canApprove: boolean;
    readonly canSettle: boolean;
    readonly canApproveSettlement: boolean;
    readonly canConfigure: boolean;
  };
  readonly capability: {
    readonly state: "OPERATIONAL" | "NOT_OPERATIONAL";
    readonly reason: TemporaryFundingCapabilityReason | null;
    readonly reversalAvailable: false;
    readonly safeNonNegativeGuardActive: false;
    readonly requiredSessionProvenance: "PASSWORD_OPERATIONAL";
  };
  readonly configuration: {
    readonly mapping: null | {
      readonly id: string;
      readonly version: number;
      readonly configuredAt: string;
      readonly evidenceDocumentReference: string;
      readonly valid: boolean;
      readonly payableLedgerAccount: { readonly id: string; readonly code: string; readonly name: string };
    };
    readonly policy: null | { readonly id: string; readonly version: number; readonly approvalRequired: boolean };
  };
  readonly providers: readonly TemporaryFundingProviderSummary[];
  readonly payableTotal: string;
  readonly safePositions: readonly TemporaryFundingSafePosition[];
  readonly fundings: readonly TemporaryFundingView[];
  readonly options: {
    readonly safeAccounts: readonly (NamedAccount & { readonly currencyCode: string })[];
    readonly settlementSources: readonly (NamedAccount & { readonly currencyCode: string })[];
    readonly expenseCategories: readonly { readonly id: string; readonly code: string; readonly nameEn: string; readonly nameFa: string | null }[];
    readonly parties: readonly { readonly id: string; readonly name: string; readonly shareholder: boolean }[];
    /** Active users of this company, for recording the provider's own ABOS user (excluded from approvals). */
    readonly users: readonly { readonly id: string; readonly name: string }[];
    readonly payableLedgerAccounts: readonly { readonly id: string; readonly code: string; readonly name: string }[];
  };
}

export interface TemporaryFundingRecord {
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
  readonly amount: TemporaryFundingMoney;
  readonly idempotencyKey: string;
  readonly correlationId: string;
}

export interface TemporaryFundingDecide {
  readonly expectedVersion: number;
  readonly decision: TemporaryFundingDecision;
  readonly decisionReason: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
}

export interface TemporaryFundingSettlementRequest {
  readonly temporaryFundingId: string;
  readonly expectedFundingVersion: number;
  readonly treasuryAccountId: string;
  readonly amount: TemporaryFundingMoney;
  readonly businessDate: string;
  readonly reference: string;
  readonly note: string | null;
  readonly idempotencyKey: string;
  readonly correlationId: string;
}

export interface TemporaryFundingMappingConfigure {
  readonly ledgerAccountId: string;
  readonly evidenceDocumentReference: string;
  readonly evidenceSha256: string;
  readonly changeReason: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
}

/** One Temporary Funding command, as the API accepts it. Reversal is not available in this slice. */
export type TemporaryFundingCommand =
  | ({ readonly action: "record" } & TemporaryFundingRecord)
  | ({ readonly action: "decide"; readonly temporaryFundingId: string } & TemporaryFundingDecide)
  | ({ readonly action: "request-settlement" } & TemporaryFundingSettlementRequest)
  | ({ readonly action: "decide-settlement"; readonly settlementId: string } & TemporaryFundingDecide)
  | ({ readonly action: "configure-mapping" } & TemporaryFundingMappingConfigure);

export type TemporaryFundingAction = TemporaryFundingCommand["action"];

export interface TemporaryFundingResult {
  readonly replayed: boolean;
  readonly funding?: TemporaryFundingView;
  readonly settlement?: TemporaryFundingSettlementView;
  readonly [key: string]: unknown;
}
