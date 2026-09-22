import type { TransactionDimensions } from "./dimensions.ts";
import type { EvidenceReference } from "./evidence.ts";
import type {
  BusinessPartyId,
  CapitalAgreementId,
  CapitalInstallmentId,
  CapitalReceiptIntentId,
  CashLocationCurrencyAccountId
} from "./ids.ts";
import type { Money, SupportedCurrency } from "./money.ts";

export type CapitalAgreementStatus = "DRAFT" | "APPROVED" | "SUSPENDED" | "CLOSED";

export interface CapitalAgreementSummary {
  readonly id: CapitalAgreementId;
  readonly shareholderPartyId: BusinessPartyId;
  readonly dimensions: TransactionDimensions;
  readonly denominationCurrency: SupportedCurrency;
  readonly committedAmount: Money;
  readonly contributedAmount: Money;
  readonly partialInstallmentsAllowed: boolean;
  readonly status: CapitalAgreementStatus;
  readonly registrationEvidence?: EvidenceReference;
  readonly version: number;
}

export interface CapitalInstallmentEligibility {
  readonly installmentId: CapitalInstallmentId;
  readonly agreementId: CapitalAgreementId;
  readonly eligibleAmount: Money;
  readonly agreementStatus: CapitalAgreementStatus;
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
