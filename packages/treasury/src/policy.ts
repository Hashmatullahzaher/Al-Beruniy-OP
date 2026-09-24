import type { TreasuryPermission, UserAccountId } from "@abos/contracts";
import { assertTreasury } from "./errors.ts";
import type {
  CapitalReceiptSource,
  CashAccountRecord,
  CashLocationRecord,
  PhysicalCashCountRecord,
  ReceiptStage,
  TreasuryActor,
  TreasuryHandoffRecord,
  TreasuryReceipt
} from "./types.ts";

/**
 * Pure Treasury rules.
 *
 * Every rule here is also enforced by the database (migration 0006). They are stated here so the
 * application refuses early with a typed, explainable error instead of surfacing a constraint
 * violation, and so they can be unit-tested without a database. They are never the only guard.
 */

export function requirePermission(actor: TreasuryActor, permission: TreasuryPermission): void {
  assertTreasury(
    actor.treasuryPermissions.includes(permission),
    "PERMISSION_DENIED",
    `This action requires the Treasury permission ${permission}`
  );
}

/** A decimal string as the database stores it: non-negative, no exponent, no sign. */
const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/;

export function assertAmount(value: string, label: string): void {
  assertTreasury(
    typeof value === "string" && DECIMAL.test(value),
    "CURRENCY_MISMATCH",
    `${label} must be a non-negative decimal with at most six places, got "${value}"`
  );
}

/** Compares two canonical decimal strings exactly, without floating point. */
export function compareDecimal(left: string, right: string): number {
  const [leftWhole = "0", leftFraction = ""] = left.split(".");
  const [rightWhole = "0", rightFraction = ""] = right.split(".");
  const scale = Math.max(leftFraction.length, rightFraction.length);
  const a = BigInt(leftWhole + leftFraction.padEnd(scale, "0"));
  const b = BigInt(rightWhole + rightFraction.padEnd(scale, "0"));
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A receipt can be recorded only into an ACTIVE account of an ACTIVE safe. */
export function assertAccountCanReceive(
  account: CashAccountRecord | undefined,
  location: CashLocationRecord | undefined
): asserts account is CashAccountRecord {
  assertTreasury(account, "NOT_FOUND", "The destination cash account does not exist");
  assertTreasury(location, "NOT_FOUND", "The destination cash location does not exist");
  assertTreasury(
    location.status === "ACTIVE",
    "CASH_ACCOUNT_INACTIVE",
    `Cash location ${location.name} is ${location.status}`
  );
  assertTreasury(
    account.status === "ACTIVE",
    "CASH_ACCOUNT_INACTIVE",
    `The ${account.currency} account of ${location.name} is ${account.status}, not ACTIVE`
  );
}

/**
 * The source must be eligible and must name this account. Treasury does not choose the amount,
 * currency or destination: it takes them from the shareholder intent, so nothing can drift.
 */
export function assertSourceCanBeReceived(
  source: CapitalReceiptSource | undefined,
  account: CashAccountRecord
): asserts source is CapitalReceiptSource {
  assertTreasury(source, "NOT_FOUND", "The shareholder capital receipt intent does not exist");
  assertTreasury(
    source.legalEntityId === account.legalEntityId,
    "SCOPE_MISMATCH",
    "The capital receipt intent belongs to another legal entity"
  );
  assertTreasury(
    source.status === "ELIGIBLE",
    "CAPITAL_AGREEMENT_REQUIRED",
    `The capital receipt intent is ${source.status}; only an ELIGIBLE intent can be received`
  );
  assertTreasury(
    source.destinationCashAccountId === account.id,
    "SCOPE_MISMATCH",
    "The capital receipt intent names a different cash account"
  );
  assertTreasury(
    source.amount.currency === account.currency,
    "CURRENCY_MISMATCH",
    `The intent is in ${source.amount.currency} but the account holds ${account.currency}`
  );
}

export function assertAssignedCashier(
  actor: TreasuryActor,
  assignedCashiers: readonly UserAccountId[]
): void {
  assertTreasury(
    assignedCashiers.includes(actor.userAccountId),
    "PERMISSION_DENIED",
    "Only a cashier assigned to this safe can receive or count cash into it"
  );
}

/**
 * The physical count must cover the receipt. Whether a count is of the cash received or of the
 * whole safe after receipt is still an open Treasury question (handoff, section 9); `>=` is the
 * reading that holds either way, so it is the one enforced.
 */
export function assertCountCoversReceipt(countedAmount: string, receiptAmount: string): void {
  assertAmount(countedAmount, "The counted amount");
  assertTreasury(
    compareDecimal(countedAmount, receiptAmount) >= 0,
    "EVIDENCE_REQUIRED",
    `The physical count ${countedAmount} is below the received amount ${receiptAmount}`
  );
}

/** Verification is independent: not by the person who received the cash, nor who counted it. */
export function assertIndependentVerifier(
  actor: TreasuryActor,
  receipt: TreasuryReceipt,
  count: PhysicalCashCountRecord | undefined
): asserts count is PhysicalCashCountRecord {
  assertTreasury(count, "EVIDENCE_REQUIRED", "The receipt has no physical cash count to verify");
  assertTreasury(
    actor.userAccountId !== receipt.receivedByUserAccountId,
    "SEGREGATION_OF_DUTIES_VIOLATION",
    "The cashier who received the cash cannot verify it"
  );
  assertTreasury(
    actor.userAccountId !== count.countedByUserAccountId,
    "SEGREGATION_OF_DUTIES_VIOLATION",
    "The person who counted the cash cannot verify the count"
  );
}

export function assertReceiptStatus(
  receipt: TreasuryReceipt | undefined,
  expected: TreasuryReceipt["status"],
  action: string
): asserts receipt is TreasuryReceipt {
  assertTreasury(receipt, "NOT_FOUND", "The cash receipt does not exist");
  assertTreasury(
    receipt.status === expected,
    receipt.status === "VERIFIED" || receipt.status === "VOIDED"
      ? "POSTED_RECORD_IMMUTABLE"
      : "TREASURY_RECEIPT_NOT_VERIFIED",
    `Cannot ${action}: the receipt is ${receipt.status}`
  );
}

/** The single derived stage shown to a user. It never claims more than the rows record. */
export function receiptStage(
  receipt: TreasuryReceipt,
  handoff: TreasuryHandoffRecord | undefined,
  postedJournalId: string | undefined
): ReceiptStage {
  if (receipt.status === "VOIDED") return "VOIDED";
  if (receipt.status === "VERIFIED") {
    if (postedJournalId !== undefined) return "POSTED_BY_FINANCE";
    if (handoff !== undefined) return "HANDED_TO_FINANCE";
    return "VERIFIED";
  }
  if (receipt.status === "COUNTED") {
    return receipt.submittedForVerificationAt === undefined ? "COUNTED" : "PENDING_VERIFICATION";
  }
  return "DRAFT";
}

/** Opening reconciliation separates who counted, who reconciled and who approved. */
export function assertOpeningApprover(
  actor: TreasuryActor,
  reconciledBy: UserAccountId,
  countedBy: UserAccountId
): void {
  assertTreasury(
    actor.userAccountId !== reconciledBy,
    "SEGREGATION_OF_DUTIES_VIOLATION",
    "The person who reconciled the opening position cannot approve it"
  );
  assertTreasury(
    actor.userAccountId !== countedBy,
    "SEGREGATION_OF_DUTIES_VIOLATION",
    "The person who counted the opening cash cannot approve it"
  );
}
