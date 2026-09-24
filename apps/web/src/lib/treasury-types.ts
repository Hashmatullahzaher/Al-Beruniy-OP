/**
 * Treasury view model shared by the API and the page. Client-safe: types only, no server imports.
 *
 * Amounts are exact decimal strings exactly as stored. The view never computes a balance: it
 * shows statuses, counts, receipts and their evidence, because Treasury does not keep a balance
 * and inventing one for display would be a fabricated figure.
 */

export type ReceiptStageView =
  | "DRAFT"
  | "COUNTED"
  | "PENDING_VERIFICATION"
  | "VERIFIED"
  | "HANDED_TO_FINANCE"
  | "APPROVED_BY_FINANCE"
  | "REJECTED_BY_FINANCE"
  | "POSTED_BY_FINANCE"
  | "VOIDED";

export interface TreasuryActorView {
  readonly userAccountId: string;
  readonly displayName: string;
  readonly treasuryPermissions: readonly string[];
  readonly sessionExpiresAt: string;
}

export interface CashAccountView {
  readonly id: string;
  readonly currency: "USD" | "AFN";
  readonly status: "DRAFT" | "RECONCILED" | "APPROVED" | "ACTIVE" | "BLOCKED";
  readonly openingStatus: "NOT_RECONCILED" | "RECONCILED" | "APPROVED";
  readonly openingCountedAmount?: string;
  readonly activatedBy?: string;
  readonly activatedAt?: string;
}

export interface CashLocationView {
  readonly id: string;
  readonly name: string;
  readonly kind: "OFFICE_SAFE";
  readonly status: "DRAFT" | "ACTIVE" | "INACTIVE";
  readonly accounts: readonly CashAccountView[];
  readonly cashiers: readonly { readonly userAccountId: string; readonly displayName: string }[];
}

export interface SourceView {
  readonly id: string;
  readonly shareholder: string;
  readonly agreementReference: string;
  readonly installmentSequence: number;
  readonly amount: string;
  readonly currency: "USD" | "AFN";
  readonly destinationAccountId: string;
  readonly destinationLabel: string;
  readonly status: "DRAFT" | "ELIGIBLE" | "REJECTED" | "TREASURY_VERIFIED" | "POSTED";
  readonly hasLiveReceipt: boolean;
}

export interface ReceiptView {
  readonly id: string;
  readonly reference: string;
  readonly sourceId: string;
  readonly shareholder: string;
  readonly agreementReference: string;
  readonly installmentSequence: number;
  readonly amount: string;
  readonly currency: "USD" | "AFN";
  readonly destinationLabel: string;
  readonly stage: ReceiptStageView;
  readonly receivedBy: string;
  readonly receivedByUserAccountId: string;
  readonly countedBy?: string;
  readonly countedByUserAccountId?: string;
  readonly verifiedBy?: string;
  readonly voidReason?: string;
}

export interface EvidenceOption {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly capitalReceiptIntentId: string;
}

export interface TreasuryOverview {
  readonly actor: TreasuryActorView;
  readonly locations: readonly CashLocationView[];
  readonly sources: readonly SourceView[];
  readonly receipts: readonly ReceiptView[];
  readonly evidence: {
    readonly cashReceipt: readonly EvidenceOption[];
    readonly physicalCount: readonly EvidenceOption[];
  };
}

export interface TraceEventView {
  readonly id: string;
  readonly aggregate: string;
  readonly operation: string;
  readonly fromStatus?: string;
  readonly toStatus?: string;
  readonly actor: string;
  readonly occurredAt: string;
}

export interface ReceiptTraceView {
  readonly receipt: ReceiptView;
  readonly source: {
    readonly id: string;
    readonly status: string;
    readonly shareholder: string;
    readonly shareholderBusinessPartyId: string;
    readonly agreementId: string;
    readonly agreementReference: string;
    readonly installmentId: string;
    readonly installmentSequence: number;
    readonly amount: string;
    readonly currency: string;
  };
  readonly count?: {
    readonly id: string;
    readonly countedAmount: string;
    readonly countedBy: string;
    readonly countedAt: string;
    readonly status: string;
    readonly confirmedBy?: string;
    readonly confirmedAt?: string;
    readonly evidenceLabel: string;
  };
  readonly receiptEvidenceLabel?: string;
  readonly handoff?: { readonly id: string; readonly handedOffBy: string; readonly handedOffAt: string };
  /** Finance's own state, read-only. Treasury never writes it. */
  readonly finance: {
    readonly postingIntentStatus?: string;
    readonly decision: "NONE" | "APPROVED" | "REJECTED";
    readonly decidedBy?: string;
    readonly decidedAt?: string;
  };
  readonly postedJournalId?: string;
  readonly events: readonly TraceEventView[];
}

export type ApiResponse<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };
