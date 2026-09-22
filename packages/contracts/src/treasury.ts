import type { EvidenceReference } from "./evidence.ts";
import type {
  CashLocationCurrencyAccountId,
  CashLocationId,
  CashReceiptId,
  CapitalReceiptIntentId,
  PhysicalCashCountId,
  UserAccountId
} from "./ids.ts";
import type { Money, SupportedCurrency } from "./money.ts";

export interface CashLocationCurrencyAccount {
  readonly id: CashLocationCurrencyAccountId;
  readonly cashLocationId: CashLocationId;
  readonly currency: SupportedCurrency;
  readonly status: "DRAFT" | "RECONCILED" | "APPROVED" | "ACTIVE" | "BLOCKED";
  readonly openingPositionApproved: boolean;
  readonly responsibleCashierUserAccountId: UserAccountId;
  readonly activationEvidence: readonly EvidenceReference[];
  readonly version: number;
}

export interface VerifiedTreasuryReceipt {
  readonly id: CashReceiptId;
  readonly capitalReceiptIntentId: CapitalReceiptIntentId;
  readonly destinationType: "CASH_LOCATION";
  readonly destinationAccountId: CashLocationCurrencyAccountId;
  readonly physicalCashCountId: PhysicalCashCountId;
  readonly amount: Money;
  readonly cashierUserAccountId: UserAccountId;
  readonly evidence: readonly EvidenceReference[];
  readonly verifiedAt: string;
  readonly status: "VERIFIED";
}
