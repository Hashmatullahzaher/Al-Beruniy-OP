import type { TransactionDimensions } from "./dimensions.ts";
import type { EvidenceReference } from "./evidence.ts";
import type {
  BusinessPartyId,
  CapitalAgreementId,
  CapitalInstallmentId,
  CapitalReceiptIntentId,
  CashLocationCurrencyAccountId
} from "./ids.ts";
import type { CanonicalCapitalAgreementStatus } from "./capital-status.ts";
import type { Money, SupportedCurrency } from "./money.ts";

/**
 * @deprecated `stage1-e0-v1` vocabulary. It cannot be persisted — `abos.capital_agreements.status`
 * has never had an `APPROVED` value. Use `CanonicalCapitalAgreementStatus` (`stage1-e0-v2`).
 * Retained only so v1 consumers still compile while they migrate; see `capital-status.ts`.
 */
export type CapitalAgreementStatus = "DRAFT" | "APPROVED" | "SUSPENDED" | "CLOSED";

export interface CapitalAgreementSummary {
  readonly id: CapitalAgreementId;
  readonly shareholderPartyId: BusinessPartyId;
  readonly dimensions: TransactionDimensions;
  readonly denominationCurrency: SupportedCurrency;
  readonly committedAmount: Money;
  readonly contributedAmount: Money;
  readonly partialInstallmentsAllowed: boolean;
  /** @deprecated v1 field. Read `canonicalStatus` instead. */
  readonly status?: CapitalAgreementStatus;
  /** `stage1-e0-v2`. The persisted vocabulary, which is now the canonical one. */
  readonly canonicalStatus: CanonicalCapitalAgreementStatus;
  readonly registrationEvidence?: EvidenceReference;
  readonly version: number;
}

export interface CapitalInstallmentEligibility {
  readonly installmentId: CapitalInstallmentId;
  readonly agreementId: CapitalAgreementId;
  readonly eligibleAmount: Money;
  /** @deprecated v1 field. Read `canonicalAgreementStatus` instead. */
  readonly agreementStatus?: CapitalAgreementStatus;
  /** `stage1-e0-v2`. Canonical persisted vocabulary. */
  readonly canonicalAgreementStatus: CanonicalCapitalAgreementStatus;
  /**
   * `stage1-e0-v2`. Commitment not yet consumed by a pending, verified, approved or posted
   * contribution, computed server-side from persisted records. Finance must validate an installment
   * against this, never against a caller-supplied eligible amount — finding F-4.
   */
  readonly remainingEligibleAmount: Money;
  /** `stage1-e0-v2`. Whether the agreement authorises an installment below the expected amount. */
  readonly partialInstallmentsAllowed: boolean;
  readonly registrationEvidence?: EvidenceReference;
}

export interface CapitalReceiptIntent {
  readonly id: CapitalReceiptIntentId;
  readonly shareholderPartyId: BusinessPartyId;
  readonly agreementId: CapitalAgreementId;
  readonly installmentId: CapitalInstallmentId;
  readonly dimensions: TransactionDimensions;
  readonly expectedDestinationAccountId: CashLocationCurrencyAccountId;
  readonly amount: Money;
  readonly status: "DRAFT" | "ELIGIBLE" | "REJECTED" | "TREASURY_VERIFIED" | "POSTED";
  readonly evidence: readonly EvidenceReference[];
  readonly businessEventAt: string;
  readonly version: number;
}
