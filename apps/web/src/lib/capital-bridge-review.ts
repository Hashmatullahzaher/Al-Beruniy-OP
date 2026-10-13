import type {
  CapitalContributionDeclaration,
  CapitalContributionFinanceSummary,
  CapitalReceiptRecord,
  DecimalString,
  LegalEntityId,
  UserAccountId
} from "@abos/contracts";

/** Presentation-only state. No adapter, database, real session or financial command uses this file. */
export type BridgeReviewRole = "OBSERVER" | "TREASURY_RECORDER" | "FINANCE_REVIEWER";

export interface BridgeReviewContribution extends CapitalContributionDeclaration {
  readonly holderEn: string;
  readonly holderFa: string;
}

export const REVIEW_ACTORS: Readonly<Record<BridgeReviewRole, UserAccountId>> = {
  OBSERVER: "review-observer" as UserAccountId,
  TREASURY_RECORDER: "review-treasury-recorder" as UserAccountId,
  FINANCE_REVIEWER: "review-finance-reviewer" as UserAccountId
};

export function bridgeReviewFixtures(): readonly BridgeReviewContribution[] {
  const declaration = (id: string, holder: "A" | "B", amount: string, date: string): BridgeReviewContribution => ({
    id,
    legalEntityId: "review-entity" as LegalEntityId,
    shareholderProfileId: `review-holder-${holder}`,
    holderEn: `Synthetic Shareholder ${holder}`,
    holderFa: `سهامدار آزمایشی ${holder}`,
    contributionType: "CASH",
    recordStatus: "DECLARED",
    businessDate: date,
    amount: { amount: amount as DecimalString, currency: "USD" },
    documentVersion: null,
    sourceModel: "CONTRIBUTION_0035"
  });
  return [
    declaration("SYN-C1", "A", "50000", "2026-10-06"),
    declaration("SYN-C2", "A", "50000", "2026-10-07"),
    declaration("SYN-C3", "B", "20000", "2026-10-07")
  ];
}

/** Exact decimal addition/subtraction for UI projection; no floating-point money or FX conversion. */
export function reviewDecimal(values: readonly string[], subtract: readonly string[] = []): DecimalString {
  const all = [...values, ...subtract];
  if (all.some((value) => !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) || value.length > 256)) {
    throw new Error("INVALID_AMOUNT");
  }
  const scale = Math.max(0, ...all.map((value) => value.split(".")[1]?.length ?? 0));
  const integer = (value: string) => {
    const [whole = "0", fraction = ""] = value.split(".");
    return BigInt(whole + fraction.padEnd(scale, "0"));
  };
  const sum = values.reduce((total, value) => total + integer(value), 0n)
    - subtract.reduce((total, value) => total + integer(value), 0n);
  if (sum < 0n) throw new Error("OVER_RECEIPT");
  const digits = sum.toString().padStart(scale + 1, "0");
  const result = scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/0+$/, "").replace(/\.$/, "");
  return result as DecimalString;
}

export function reviewContributionSummary(
  contribution: BridgeReviewContribution,
  receipts: readonly CapitalReceiptRecord[]
): CapitalContributionFinanceSummary {
  if (!contribution.amount) throw new Error("NOT_CASH");
  const relevant = receipts.filter((receipt) => receipt.contributionId === contribution.id && receipt.receiptState === "RECORDED");
  if (relevant.some((receipt) => receipt.amount.currency !== contribution.amount?.currency)) throw new Error("CURRENCY_MISMATCH");
  const received = reviewDecimal(relevant.map((receipt) => receipt.amount.amount));
  const posted = reviewDecimal(relevant.filter((receipt) => receipt.postingState === "POSTED").map((receipt) => receipt.amount.amount));
  const currency = contribution.amount.currency;
  return {
    contributionId: contribution.id,
    declared: contribution.amount,
    received: { amount: received, currency },
    outstanding: { amount: reviewDecimal([contribution.amount.amount], [received]), currency },
    posted: { amount: posted, currency },
    receiptCount: relevant.length,
    approvalState: relevant.length === 0 ? "NOT_RECEIVED" : relevant.some((receipt) => receipt.approvalState === "PENDING") ? "PENDING"
      : relevant.some((receipt) => receipt.approvalState === "REJECTED") ? "REJECTED" : "APPROVED",
    postingState: relevant.some((receipt) => receipt.postingState === "POSTED") ? "POSTED" : "NOT_POSTED"
  };
}

/** Illustrative action visibility only. Production authorization belongs to the secure service. */
export function reviewReceiptActions(receipt: CapitalReceiptRecord, role: BridgeReviewRole, configurationReady: boolean) {
  const independentFinance = role === "FINANCE_REVIEWER" && receipt.recordedBy !== REVIEW_ACTORS[role];
  const pending = receipt.receiptState === "RECORDED" && receipt.approvalState === "PENDING" && receipt.postingState === "NOT_POSTED";
  return {
    canReview: independentFinance && pending,
    canApprove: independentFinance && pending,
    canPost: independentFinance && receipt.receiptState === "RECORDED" && receipt.approvalState === "APPROVED"
      && receipt.approvedBy === REVIEW_ACTORS[role] && receipt.postingState === "NOT_POSTED" && configurationReady,
    canReverse: false
  } as const;
}
