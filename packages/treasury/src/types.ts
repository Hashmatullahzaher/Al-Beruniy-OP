import type {
  CapitalReceiptIntentId,
  CashLocationCurrencyAccountId,
  CashLocationId,
  CashReceiptId,
  LegalEntityId,
  Money,
  PhysicalCashCountId,
  SupportedCurrency,
  TreasuryPermission,
  TreasuryReceiptStatus,
  UserAccountId
} from "@abos/contracts";

/**
 * Treasury domain records.
 *
 * Invariants this package exists to protect:
 *  - Treasury holds custody of physical cash. It never writes a journal, a ledger balance or a
 *    ledger account; the only thing it gives Finance is a handoff naming one verified receipt.
 *  - Each currency inside a safe is its own account with its own lifecycle.
 *  - Whoever receives cash, whoever counts it and whoever verifies it are recorded separately,
 *    and the verifier is never the cashier or the counter.
 *  - A receipt answers exactly one eligible shareholder capital receipt intent and preserves its
 *    shareholder, agreement, installment, currency, amount and destination.
 */

/** The authenticated person acting, resolved server-side from a sandbox session. */
export interface TreasuryActor {
  readonly userAccountId: UserAccountId;
  readonly legalEntityId: LegalEntityId;
  readonly treasuryPermissions: readonly TreasuryPermission[];
  readonly sessionId: string;
}

export type CashAccountStatus = "DRAFT" | "RECONCILED" | "APPROVED" | "ACTIVE" | "BLOCKED";

export interface CashLocationRecord {
  readonly id: CashLocationId;
  readonly legalEntityId: LegalEntityId;
  readonly name: string;
  readonly kind: "OFFICE_SAFE";
  readonly status: "DRAFT" | "ACTIVE" | "INACTIVE";
  readonly responsibleCashierUserAccountId: UserAccountId;
}

export interface CashAccountRecord {
  readonly id: CashLocationCurrencyAccountId;
  readonly legalEntityId: LegalEntityId;
  readonly cashLocationId: CashLocationId;
  readonly currency: SupportedCurrency;
  readonly ledgerAccountId: string;
  readonly status: CashAccountStatus;
  readonly activatedByUserAccountId?: UserAccountId;
  readonly activatedAt?: string;
}

export interface CashierAssignmentRecord {
  readonly id: string;
  readonly legalEntityId: LegalEntityId;
  readonly cashLocationId: CashLocationId;
  readonly userAccountId: UserAccountId;
  readonly assignedByUserAccountId: UserAccountId;
  readonly assignedAt: string;
  readonly revokedAt?: string;
}

export interface PhysicalCashCountRecord {
  readonly id: PhysicalCashCountId;
  readonly legalEntityId: LegalEntityId;
  readonly cashAccountId: CashLocationCurrencyAccountId;
  readonly currency: SupportedCurrency;
  readonly countedAmount: string;
  readonly countedAt: string;
  readonly countedByUserAccountId: UserAccountId;
  readonly evidenceReferenceId: string;
  readonly purpose: "OPENING" | "RECEIPT";
  readonly status: "RECORDED" | "CONFIRMED" | "DISCREPANCY" | "VOIDED";
  readonly confirmedByUserAccountId?: UserAccountId;
  readonly confirmedAt?: string;
}

export interface CashAccountOpeningRecord {
  readonly cashAccountId: CashLocationCurrencyAccountId;
  readonly legalEntityId: LegalEntityId;
  readonly currency: SupportedCurrency;
  readonly openingCountedAmount: string;
  readonly physicalCashCountId: PhysicalCashCountId;
  readonly reconciliationEvidenceReferenceId: string;
  readonly reconciledByUserAccountId: UserAccountId;
  readonly approvedByUserAccountId?: UserAccountId;
  readonly status: "RECONCILED" | "APPROVED";
}

/** What Treasury needs to know about a shareholder source. Read-only from Treasury's side. */
export interface CapitalReceiptSource {
  readonly id: CapitalReceiptIntentId;
  readonly legalEntityId: LegalEntityId;
  readonly shareholderBusinessPartyId: string;
  readonly shareholderDisplayName: string;
  readonly capitalAgreementId: string;
  readonly agreementReference: string;
  readonly capitalInstallmentId: string;
  readonly installmentSequence: number;
  readonly amount: Money;
  readonly destinationCashAccountId: CashLocationCurrencyAccountId;
  readonly status: "DRAFT" | "ELIGIBLE" | "REJECTED" | "TREASURY_VERIFIED" | "POSTED";
  readonly treasuryCashReceiptId?: CashReceiptId;
  readonly journalId?: string;
  readonly businessEventAt: string;
  readonly evidenceReferenceId: string;
}

export interface TreasuryReceipt {
  readonly id: CashReceiptId;
  readonly legalEntityId: LegalEntityId;
  readonly capitalReceiptIntentId: CapitalReceiptIntentId;
  readonly capitalInstallmentId: string;
  readonly cashAccountId: CashLocationCurrencyAccountId;
  readonly cashLocationId: CashLocationId;
  readonly receiptReference: string;
  readonly amount: Money;
  readonly businessEventAt: string;
  readonly receivedByUserAccountId: UserAccountId;
  readonly physicalCashCountId?: PhysicalCashCountId;
  readonly evidenceReferenceId?: string;
  readonly submittedForVerificationAt?: string;
  readonly verifiedByUserAccountId?: UserAccountId;
  readonly verifiedAt?: string;
  readonly voidReason?: string;
  readonly status: TreasuryReceiptStatus;
}

export interface TreasuryHandoffRecord {
  readonly id: string;
  readonly legalEntityId: LegalEntityId;
  readonly cashReceiptId: CashReceiptId;
  readonly capitalReceiptIntentId: CapitalReceiptIntentId;
  readonly handedOffByUserAccountId: UserAccountId;
  readonly handedOffAt: string;
  readonly status: "READY_FOR_FINANCE";
}

export interface TreasuryEventRecord {
  readonly id: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly operation: "INSERT" | "UPDATE";
  readonly fromStatus?: string;
  readonly toStatus?: string;
  readonly actorUserAccountId: UserAccountId;
  readonly actorDisplayName: string;
  readonly occurredAt: string;
}

/** Everything a reviewer needs to follow one receipt back to its shareholder installment. */
export interface ReceiptTrace {
  readonly receipt: TreasuryReceipt;
  readonly source: CapitalReceiptSource;
  readonly count?: PhysicalCashCountRecord;
  readonly handoff?: TreasuryHandoffRecord;
  /** Present only once Finance has posted. Treasury reads it; it never writes it. */
  readonly postedJournalId?: string;
  readonly events: readonly TreasuryEventRecord[];
}

/**
 * Presentation state, derived and never stored. "Pending verification" is `COUNTED` with a
 * submission timestamp; it is a view of the persisted row, not a separate status.
 */
export type ReceiptStage =
  | "DRAFT"
  | "COUNTED"
  | "PENDING_VERIFICATION"
  | "VERIFIED"
  | "HANDED_TO_FINANCE"
  | "POSTED_BY_FINANCE"
  | "VOIDED";
