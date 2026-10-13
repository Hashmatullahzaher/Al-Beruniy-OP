import type { AccountingPeriodId, JournalId, LedgerAccountId, LegalEntityId, UserAccountId } from "./ids.ts";
import type { Money, SupportedCurrency } from "./money.ts";

/**
 * Application contract for the reviewed Shareholders -> Finance bridge.
 *
 * A contribution is a declaration. Receipts, approvals and postings are separate immutable facts.
 * This contract intentionally has no database adapter: migration 0036 remains a proposal.
 */
export type CapitalReceiptState = "RECORDED" | "CANCELLED";
export type CapitalReceiptApprovalState = "PENDING" | "APPROVED" | "REJECTED";
export type CapitalReceiptPostingState = "NOT_POSTED" | "POSTED" | "REVERSED";

export interface CapitalContributionDeclaration {
  readonly id: string;
  readonly legalEntityId: LegalEntityId;
  readonly shareholderProfileId: string;
  readonly contributionType: "CASH" | "IN_KIND" | "CREDIT";
  /** Exact 0035 source lifecycle. Receipt/approval/posting states are held separately. */
  readonly recordStatus: "DRAFT" | "DECLARED" | "CANCELLED";
  readonly businessDate: string;
  readonly amount: Money | null;
  readonly documentVersion: number | null;
  /** Legacy agreements are displayed beside declarations but never copied into this collection. */
  readonly sourceModel: "CONTRIBUTION_0035";
}

export interface CapitalReceiptRecord {
  readonly id: string;
  readonly legalEntityId: LegalEntityId;
  readonly contributionId: string;
  /** Immutable binding of declaration identity, shareholder, date, type and original amount. */
  readonly sourceFingerprint: string;
  readonly amount: Money;
  readonly receiptDate: string;
  readonly treasuryDestinationId: string;
  readonly paymentReference: string | null;
  readonly evidenceReferenceId: string | null;
  readonly receiptState: CapitalReceiptState;
  readonly approvalState: CapitalReceiptApprovalState;
  readonly postingState: CapitalReceiptPostingState;
  readonly recordedBy: UserAccountId;
  readonly recordedAt: string;
  readonly approvedBy: UserAccountId | null;
  readonly approvedAt: string | null;
  readonly rejectedBy: UserAccountId | null;
  readonly rejectedAt: string | null;
  readonly rejectionReason: string | null;
  readonly journalId: JournalId | null;
  readonly reversedByJournalId: JournalId | null;
  readonly version: number;
}

export interface CapitalReceiptPostingConfiguration {
  readonly legalEntityId: LegalEntityId;
  readonly baseCurrency: SupportedCurrency;
  readonly policyVersionId: string;
  readonly accountingPeriodId: AccountingPeriodId;
  readonly periodStatus: "OPEN" | "CLOSED";
  readonly periodStartsOn: string;
  readonly periodEndsOn: string;
  /** Resolved configuration identifiers. The bridge never invents account codes. */
  readonly receivingLedgerAccountId: LedgerAccountId | null;
  readonly paidInCapitalLedgerAccountId: LedgerAccountId | null;
  readonly treasuryDestinationId: string;
  /** Explicit isolated fixture policy. A declaration/document hash cannot establish this. */
  readonly paidInEquityRecognitionApproved: boolean;
  readonly receiptEvidenceRequired: boolean;
  /** False until a separately approved reversal policy exists. */
  readonly reversalPostingEnabled: boolean;
}

export interface CapitalReceiptPostingIntentRecord {
  readonly id: string;
  readonly legalEntityId: LegalEntityId;
  readonly sourceType: "SHAREHOLDER_CAPITAL_CONTRIBUTION_RECEIPT";
  readonly sourceReceiptId: string;
  readonly contributionId: string;
  readonly originalAmount: Money;
  readonly baseAmount: Money;
  readonly treasuryDestinationId: string;
  readonly debitLedgerAccountId: LedgerAccountId;
  readonly creditLedgerAccountId: LedgerAccountId;
  readonly accountingPeriodId: AccountingPeriodId;
  readonly policyVersionId: string;
  readonly status: "APPROVED" | "POSTED" | "REVERSED";
}

export interface CapitalBridgeAuditEntry {
  readonly id: string;
  readonly legalEntityId: LegalEntityId;
  readonly contributionId: string;
  readonly receiptId: string;
  readonly actorUserAccountId: UserAccountId;
  readonly action:
    | "CAPITAL_RECEIPT_RECORDED"
    | "CAPITAL_RECEIPT_CANCELLED"
    | "CAPITAL_RECEIPT_APPROVED"
    | "CAPITAL_RECEIPT_REJECTED"
    | "CAPITAL_RECEIPT_POSTED"
    | "CAPITAL_RECEIPT_REVERSED";
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly details: Readonly<Record<string, string>>;
}

export interface CapitalContributionFinanceSummary {
  readonly contributionId: string;
  readonly declared: Money;
  readonly received: Money;
  readonly outstanding: Money;
  readonly posted: Money;
  readonly receiptCount: number;
  readonly approvalState: CapitalReceiptApprovalState | "NOT_RECEIVED";
  readonly postingState: CapitalReceiptPostingState;
}
