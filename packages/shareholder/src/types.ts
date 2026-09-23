import type {
  BusinessPartyId,
  CanonicalCapitalAgreementStatus,
  CapitalAgreementFundingPolicy,
  CapitalAgreementId,
  CapitalInstallmentId,
  CapitalReceiptIntentId,
  CashLocationCurrencyAccountId,
  CorrelationId,
  DocumentId,
  EvidenceReference,
  IdempotencyKey,
  LegalEntityId,
  Money,
  ShareholderProfileId,
  SupportedCurrency,
  TransactionDimensions,
  UserAccountId
} from "@abos/contracts";

/**
 * Shareholder domain records.
 *
 * Invariants this module exists to protect:
 *  - a shareholder is a Business Party (Type B). It is never a UserAccount (Type A) and never a
 *    LedgerAccount (Type C). The types below deliberately make that unrepresentable.
 *  - capital contributions and shareholder loans are separate agreements with separate records.
 *  - this domain never mutates Treasury balances and never writes to the General Ledger.
 */

/** A shareholder party registered in one legal entity. */
export interface ShareholderProfile {
  readonly id: ShareholderProfileId;
  /** Type B business party. Never a UserAccountId and never a LedgerAccountId. */
  readonly businessPartyId: BusinessPartyId;
  readonly legalEntityId: LegalEntityId;
  readonly displayName: string;
  readonly status: "DRAFT" | "ACTIVE" | "SUSPENDED" | "ARCHIVED";
  readonly version: number;
}

export type AgreementKind = "CAPITAL_CONTRIBUTION" | "SHAREHOLDER_LOAN";

/**
 * The canonical agreement vocabulary (`stage1-e0-v2`), which is the persisted one.
 *
 * Finding F-1 is resolved by adopting it rather than by translating `ELIGIBLE` into `APPROVED`.
 * Whether a given status may fund an installment is a separate, recorded decision — see
 * `CapitalAgreementFundingPolicy` and `schema-divergence.ts`.
 */
export type ContractAgreementStatus = CanonicalCapitalAgreementStatus;

/** Terms of a shareholder loan. Structure only — no posting or interest rule is defined here. */
export interface ShareholderLoanTerms {
  readonly principal: Money;
  /** The currency the loan was originally advanced in. */
  readonly originalCurrency: SupportedCurrency;
  readonly repaymentTerms: string;
  /** Whether the agreement permits repayment in a currency other than the original. */
  readonly crossCurrencyRepaymentPermitted: boolean;
  /**
   * Deliberately absent: conversion basis, interest, penalties and the accounting treatment of a
   * cross-currency repayment. Those are Finance Manager policy decisions and are out of E1 scope.
   */
  readonly policyDecisionsOutstanding: readonly string[];
}

export interface CapitalAgreementRecord {
  readonly id: CapitalAgreementId;
  readonly legalEntityId: LegalEntityId;
  readonly shareholderPartyId: BusinessPartyId;
  readonly agreementKind: AgreementKind;
  readonly agreementReference: string;
  readonly dimensions: TransactionDimensions;
  readonly denominationCurrency: SupportedCurrency;
  readonly committedAmount: Money;
  readonly partialInstallmentsAllowed: boolean;
  readonly status: ContractAgreementStatus;
  /**
   * The funding decision in force for this agreement's legal entity, read from persisted state.
   * `undefined` means no decision is recorded, and nothing is fundable.
   */
  readonly fundingPolicy?: CapitalAgreementFundingPolicy;
  /** Set only for `SHAREHOLDER_LOAN`; a capital contribution must not carry loan terms. */
  readonly loanTerms?: ShareholderLoanTerms;
  readonly version: number;
}

/**
 * Formal capital-registration evidence. A contribution received before this exists is NOT paid-in
 * share capital, and is NOT automatically a refundable liability — see `ContributionClassification`.
 */
export interface RegistrationEvidenceRecord {
  readonly agreementId: CapitalAgreementId;
  readonly legalEntityId: LegalEntityId;
  readonly evidence: EvidenceReference;
  readonly status: "PENDING" | "VERIFIED" | "REJECTED" | "SUPERSEDED";
  readonly verifiedByUserAccountId?: UserAccountId;
  readonly verifiedAt?: string;
}

export interface CapitalInstallmentRecord {
  readonly id: CapitalInstallmentId;
  readonly agreementId: CapitalAgreementId;
  readonly legalEntityId: LegalEntityId;
  readonly sequenceNumber: number;
  readonly expectedAmount: Money;
  readonly status:
    | "DRAFT"
    | "PENDING_RECEIPT"
    | "RECEIVED_PENDING_APPROVAL"
    | "POSTED"
    | "REVERSED"
    | "CANCELLED";
  readonly version: number;
}

/** Supporting document attached to an agreement or installment. */
export interface ControlledDocumentReference {
  readonly documentId: DocumentId;
  readonly evidence: EvidenceReference;
  readonly legalEntityId: LegalEntityId;
}

/**
 * How a received contribution is classified for accounting.
 *
 * `UNDETERMINED_PENDING_POLICY` is the honest default when formal registration is not yet complete.
 * The domain does NOT decide between paid-in capital and a refundable liability — that depends on the
 * applicable agreement and an approved accounting policy that does not exist yet.
 */
export type ContributionClassification =
  | "PAID_IN_SHARE_CAPITAL"
  | "UNDETERMINED_PENDING_POLICY"
  | "SHAREHOLDER_LOAN_PRINCIPAL";

/** Business and accounting workflow state of one contribution, kept explicitly distinct. */
export type ContributionState = "PENDING" | "VERIFIED" | "APPROVED" | "POSTED" | "REJECTED";

export interface ContributionHistoryEntry {
  readonly intentId: CapitalReceiptIntentId;
  readonly agreementId: CapitalAgreementId;
  readonly installmentId: CapitalInstallmentId;
  readonly shareholderPartyId: BusinessPartyId;
  readonly legalEntityId: LegalEntityId;
  readonly amount: Money;
  readonly state: ContributionState;
  readonly classification: ContributionClassification;
  readonly businessEventAt: string;
  /** Present once Treasury has verified a physical receipt against this intent. */
  readonly treasuryReceiptId?: string;
  /** Present once Finance has posted. Recorded here for traceability only — never written by us. */
  readonly journalId?: string;
}

/** Stable identity of the source transaction, used for idempotency across the Treasury boundary. */
export interface SourceTransactionIdentity {
  readonly legalEntityId: LegalEntityId;
  readonly idempotencyKey: IdempotencyKey;
  readonly correlationId: CorrelationId;
}

export interface CreateCapitalReceiptIntentCommand {
  readonly legalEntityId: LegalEntityId;
  readonly shareholderPartyId: BusinessPartyId;
  readonly agreementId: CapitalAgreementId;
  readonly installmentId: CapitalInstallmentId;
  readonly amount: Money;
  readonly expectedDestinationAccountId: CashLocationCurrencyAccountId;
  readonly businessEventAt: string;
  readonly source: SourceTransactionIdentity;
  readonly evidence: readonly EvidenceReference[];
}
