import { checkAgreementMayFund } from "@abos/contracts";
import type {
  CapitalAgreementFundingPolicy,
  CapitalInstallmentEligibility,
  Money,
  SupportedCurrency
} from "@abos/contracts";
import { assertShareholder } from "./errors.ts";
import type {
  CapitalAgreementRecord,
  CapitalInstallmentRecord,
  ContributionHistoryEntry,
  RegistrationEvidenceRecord
} from "./types.ts";

/**
 * Minimal exact decimal, duplicated deliberately.
 *
 * `@abos/finance` exports `ExactDecimal`, but the shareholder domain must not depend on the Finance
 * package — that dependency is what would let a future edit reach a posting function. The arithmetic
 * is ~20 lines and is covered by its own tests.
 */
class Exact {
  readonly coefficient: bigint;
  readonly scale: number;

  private constructor(coefficient: bigint, scale: number) {
    this.coefficient = coefficient;
    this.scale = scale;
  }

  static parse(value: string): Exact {
    assertShareholder(
      /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) && value.length <= 256,
      "CURRENCY_MISMATCH",
      `Amount ${value} is not a canonical non-negative decimal string`
    );
    const [whole = "0", fraction = ""] = value.split(".");
    return new Exact(BigInt(`${whole}${fraction}`), fraction.length);
  }

  private at(scale: number): bigint {
    return this.coefficient * 10n ** BigInt(scale - this.scale);
  }

  add(other: Exact): Exact {
    const scale = Math.max(this.scale, other.scale);
    return new Exact(this.at(scale) + other.at(scale), scale);
  }

  subtract(other: Exact): Exact {
    const scale = Math.max(this.scale, other.scale);
    return new Exact(this.at(scale) - other.at(scale), scale);
  }

  compare(other: Exact): number {
    const scale = Math.max(this.scale, other.scale);
    const left = this.at(scale);
    const right = other.at(scale);
    return left < right ? -1 : left > right ? 1 : 0;
  }

  isPositive(): boolean {
    return this.coefficient > 0n;
  }

  isNegative(): boolean {
    return this.coefficient < 0n;
  }

  toString(): string {
    const negative = this.coefficient < 0n;
    const digits = (negative ? -this.coefficient : this.coefficient).toString();
    if (this.scale === 0) return `${negative ? "-" : ""}${digits}`;
    const padded = digits.padStart(this.scale + 1, "0");
    const splitAt = padded.length - this.scale;
    return `${negative ? "-" : ""}${padded.slice(0, splitAt)}.${padded.slice(splitAt)}`;
  }
}

export const exact = {
  parse: (value: string) => Exact.parse(value)
};

function money(amount: Exact, currency: SupportedCurrency): Money {
  return { amount: amount.toString() as Money["amount"], currency };
}

/** States that consume capital commitment. A rejected contribution releases its amount. */
const CONSUMING_STATES = new Set(["PENDING", "VERIFIED", "APPROVED", "POSTED"]);

export interface EligibilityInput {
  readonly agreement: CapitalAgreementRecord;
  readonly installment: CapitalInstallmentRecord;
  readonly registration: RegistrationEvidenceRecord | undefined;
  readonly contributions: readonly ContributionHistoryEntry[];
  /** Excluded from the consumed total, so an intent can be re-evaluated without self-blocking. */
  readonly excludeIntentId?: string;
  /**
   * The recorded decision on which canonical statuses may fund an installment - finding F-1.
   * Read from persisted state by the caller. `undefined` means nothing is fundable.
   */
  readonly fundingPolicy?: CapitalAgreementFundingPolicy;
}

export interface EligibilityAssessment extends CapitalInstallmentEligibility {
  /** Commitment not yet consumed by a pending, verified, approved or posted contribution. */
  readonly remainingEligibleAmount: Money;
  readonly partialInstallmentsAllowed: boolean;
}

/**
 * Computes eligibility from persisted state. Never accepts a caller-supplied eligible amount —
 * finding F-4 of the Finance review is precisely that the kernel does trust one.
 */
export function assessInstallmentEligibility(input: EligibilityInput): EligibilityAssessment {
  const { agreement, installment, registration, contributions } = input;

  assertShareholder(
    agreement.agreementKind === "CAPITAL_CONTRIBUTION",
    "CAPITAL_AGREEMENT_REQUIRED",
    "A shareholder loan agreement cannot fund a capital contribution"
  );
  assertShareholder(
    installment.agreementId === agreement.id,
    "CAPITAL_AGREEMENT_REQUIRED",
    "Installment belongs to a different capital agreement"
  );
  assertShareholder(
    installment.legalEntityId === agreement.legalEntityId,
    "SCOPE_MISMATCH",
    "Installment and agreement are in different legal entities"
  );
  assertShareholder(
    installment.expectedAmount.currency === agreement.denominationCurrency,
    "CURRENCY_MISMATCH",
    "Installment currency differs from the agreement denomination currency"
  );

  const committed = Exact.parse(agreement.committedAmount.amount);
  let consumed = Exact.parse("0");
  for (const entry of contributions) {
    if (entry.agreementId !== agreement.id) continue;
    if (input.excludeIntentId !== undefined && entry.intentId === input.excludeIntentId) continue;
    if (!CONSUMING_STATES.has(entry.state)) continue;
    assertShareholder(
      entry.amount.currency === agreement.denominationCurrency,
      "CURRENCY_MISMATCH",
      "Recorded contribution currency differs from the agreement denomination currency"
    );
    consumed = consumed.add(Exact.parse(entry.amount.amount));
  }

  const remaining = committed.subtract(consumed);
  const remainingAmount = remaining.isNegative() ? Exact.parse("0") : remaining;

  // The eligible amount for THIS installment is the lesser of its expected amount and what is left
  // of the commitment. Whether the agreement may fund anything at all is decided by the recorded
  // funding policy, never by the status name - finding F-1. With no policy recorded, nothing is
  // eligible, so the domain fails closed rather than guessing what ELIGIBLE means.
  const expected = Exact.parse(installment.expectedAmount.amount);
  const fundable =
    checkAgreementMayFund(agreement.status, input.fundingPolicy ?? agreement.fundingPolicy) ===
    undefined;
  const capped = expected.compare(remainingAmount) <= 0 ? expected : remainingAmount;
  const eligible = fundable ? capped : Exact.parse("0");

  return {
    installmentId: installment.id,
    agreementId: agreement.id,
    eligibleAmount: money(eligible, agreement.denominationCurrency),
    canonicalAgreementStatus: agreement.status,
    ...(registration?.status === "VERIFIED" ? { registrationEvidence: registration.evidence } : {}),
    remainingEligibleAmount: money(remainingAmount, agreement.denominationCurrency),
    partialInstallmentsAllowed: agreement.partialInstallmentsAllowed
  };
}

/**
 * Validates a proposed amount against an assessment.
 * A partial payment is permitted only when the agreement allows it.
 */
export function assertAmountIsAuthorized(
  assessment: EligibilityAssessment,
  proposed: Money,
  installment: CapitalInstallmentRecord
): void {
  assertShareholder(
    proposed.currency === assessment.eligibleAmount.currency,
    "CURRENCY_MISMATCH",
    "Proposed amount currency differs from the eligible amount currency"
  );
  const value = Exact.parse(proposed.amount);
  assertShareholder(value.isPositive(), "INSTALLMENT_EXCEEDS_ELIGIBLE_AMOUNT", "Amount must be positive");
  assertShareholder(
    value.compare(Exact.parse(assessment.eligibleAmount.amount)) <= 0,
    "INSTALLMENT_EXCEEDS_ELIGIBLE_AMOUNT",
    "Installment exceeds the eligible capital amount"
  );

  const isPartial = value.compare(Exact.parse(installment.expectedAmount.amount)) < 0;
  assertShareholder(
    !isPartial || assessment.partialInstallmentsAllowed,
    "CAPITAL_AGREEMENT_REQUIRED",
    "This agreement does not authorize partial installments"
  );
}
