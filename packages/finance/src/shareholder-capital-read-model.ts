import type {
  DecimalString,
  Money,
  ShareholderCapitalContributionTrace,
  ShareholderCapitalLegacyAgreementTrace,
  ShareholderCapitalReceiptTrace,
  ShareholderCapitalTraceReadModel,
  ShareholderFinanceCapability
} from "@abos/contracts";

import { ExactDecimal } from "./decimal.ts";
import { assertFinance } from "./errors.ts";

export interface ShareholderCapitalDeclarationProjection {
  readonly contributionId: string;
  readonly shareholderProfileId: string;
  readonly shareholderBusinessPartyId: string;
  readonly shareholderDisplayName: string;
  readonly declarationDate: string;
  readonly declaredAmount: Money;
}

/**
 * Pure read projection. Declaration, custody, approval and posting stay separate and legacy
 * agreements never enter contribution totals.
 */
export function buildShareholderCapitalTraceReadModel(input: {
  readonly capability: ShareholderFinanceCapability;
  readonly declaration: ShareholderCapitalDeclarationProjection;
  readonly receipts: readonly ShareholderCapitalReceiptTrace[];
  readonly legacyAgreements?: readonly ShareholderCapitalLegacyAgreementTrace[];
}): ShareholderCapitalTraceReadModel {
  const { declaration } = input;
  const currency = declaration.declaredAmount.currency;
  const relevant = input.receipts.filter((receipt) => receipt.contributionId === declaration.contributionId);
  assertFinance(relevant.length === input.receipts.length, "SCOPE_MISMATCH", "Receipt trace belongs to another contribution.");
  assertFinance(relevant.every((receipt) => receipt.amount.currency === currency), "CURRENCY_MISMATCH", "Receipt trace currency differs from its declaration.");

  const received = total(relevant.map((receipt) => receipt.amount.amount));
  const verified = total(relevant.filter((receipt) => receipt.custodyState === "VERIFIED").map((receipt) => receipt.amount.amount));
  const approved = total(relevant.filter((receipt) => receipt.approvalState === "APPROVED").map((receipt) => receipt.amount.amount));
  const posted = total(relevant.filter((receipt) => receipt.postingState === "POSTED").map((receipt) => receipt.amount.amount));
  const declared = ExactDecimal.parse(declaration.declaredAmount.amount);
  assertFinance(received.compare(declared) <= 0, "INSTALLMENT_EXCEEDS_ELIGIBLE_AMOUNT", "Receipt trace exceeds its declaration.");
  assertFinance(verified.compare(received) <= 0 && approved.compare(verified) <= 0 && posted.compare(approved) <= 0,
    "POLICY_CONFIGURATION_PENDING", "Receipt trace state amounts are inconsistent.");

  const contribution: ShareholderCapitalContributionTrace = {
    ...declaration,
    receivedAmount: money(received.toString(), currency),
    custodyVerifiedAmount: money(verified.toString(), currency),
    approvedAmount: money(approved.toString(), currency),
    postedAmount: money(posted.toString(), currency),
    outstandingAmount: money(declared.subtract(received).toString(), currency),
    status: posted.isPositive() ? "POSTED" : approved.isPositive() ? "APPROVED"
      : verified.isPositive() ? "VERIFIED" : received.isPositive() ? "RECEIVED" : "DECLARED",
    receipts: relevant
  };
  return {
    capability: input.capability,
    contribution,
    legacyAgreements: input.legacyAgreements ?? []
  };
}

function total(values: readonly string[]): ExactDecimal {
  return values.reduce((sum, value) => sum.add(ExactDecimal.parse(value)), ExactDecimal.parse("0"));
}

function money(amount: string, currency: Money["currency"]): Money {
  return { amount: amount as DecimalString, currency };
}
