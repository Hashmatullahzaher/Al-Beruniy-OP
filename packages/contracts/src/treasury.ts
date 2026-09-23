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

/**
 * `stage1-e1-treasury-v1` - additive Treasury contract.
 *
 * Treasury owns physical cash custody: where cash is held, which currency account inside a safe it
 * belongs to, who may receive it, who counted it and who independently verified the count. It
 * never owns the General Ledger. The only thing Treasury hands to Finance is a
 * `TreasuryFinanceHandoff`, which names one verified receipt; Finance decides whether to post it.
 */
export type TreasuryPermission =
  | "treasury.read"
  | "treasury.cash-location.manage"
  | "treasury.cash-account.reconcile"
  | "treasury.cash-account.approve"
  | "treasury.cash-receipt.record"
  | "treasury.cash-count.record"
  | "treasury.cash-receipt.verify"
  | "treasury.handoff.create";

export const TREASURY_PERMISSIONS: readonly TreasuryPermission[] = [
  "treasury.read",
  "treasury.cash-location.manage",
  "treasury.cash-account.reconcile",
  "treasury.cash-account.approve",
  "treasury.cash-receipt.record",
  "treasury.cash-count.record",
  "treasury.cash-receipt.verify",
  "treasury.handoff.create"
];

export type CashLocationKind = "OFFICE_SAFE";

export interface CashLocationSummary {
  readonly id: CashLocationId;
  readonly legalEntityId: string;
  readonly name: string;
  readonly kind: CashLocationKind;
  readonly status: "DRAFT" | "ACTIVE" | "INACTIVE";
  readonly responsibleCashierUserAccountId: UserAccountId;
}

/** Lifecycle of a physical receipt. `COUNTED` plus `submittedForVerificationAt` means pending. */
export type TreasuryReceiptStatus = "DRAFT" | "COUNTED" | "VERIFIED" | "VOIDED";

export interface TreasuryReceiptRecord {
  readonly id: CashReceiptId;
  readonly legalEntityId: string;
  readonly capitalReceiptIntentId: CapitalReceiptIntentId;
  readonly capitalInstallmentId: string;
  readonly cashLocationId: CashLocationId;
  readonly cashAccountId: CashLocationCurrencyAccountId;
  readonly receiptReference: string;
  readonly amount: Money;
  readonly businessEventAt: string;
  readonly receivedByUserAccountId: UserAccountId;
  readonly physicalCashCountId?: PhysicalCashCountId;
  readonly evidenceReferenceId?: string;
  readonly submittedForVerificationAt?: string;
  readonly verifiedByUserAccountId?: UserAccountId;
  readonly verifiedAt?: string;
  readonly status: TreasuryReceiptStatus;
}

/**
 * The one object Treasury gives Finance. It references a verified receipt and its source intent;
 * it carries no journal, no ledger account and no balance.
 */
export interface TreasuryFinanceHandoff {
  readonly id: string;
  readonly legalEntityId: string;
  readonly cashReceiptId: CashReceiptId;
  readonly capitalReceiptIntentId: CapitalReceiptIntentId;
  readonly handedOffByUserAccountId: UserAccountId;
  readonly handedOffAt: string;
  readonly status: "READY_FOR_FINANCE";
}

export type SupportedTreasuryCurrency = SupportedCurrency;
