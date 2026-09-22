import type { Money, PostedJournal, ReconciliationResult } from "@abos/contracts";
import { ExactDecimal } from "./decimal.ts";

export function reconcileCapitalReceipt(input: {
  readonly sourceAmount: Money;
  readonly treasuryAmount: Money;
  readonly shareholderPostedAmount: Money;
  readonly journal: PostedJournal;
}): ReconciliationResult {
  const debit = input.journal.lines.reduce((sum, line) => sum.add(ExactDecimal.parse(line.debitBase ?? "0")), ExactDecimal.parse("0"));
  const credit = input.journal.lines.reduce((sum, line) => sum.add(ExactDecimal.parse(line.creditBase ?? "0")), ExactDecimal.parse("0"));
  const amounts = [input.sourceAmount, input.treasuryAmount, input.shareholderPostedAmount];
  const source = ExactDecimal.parse(input.sourceAmount.amount);
  const reconciled =
    amounts.every((money) => money.currency === input.journal.baseCurrency) &&
    amounts.every((money) => ExactDecimal.parse(money.amount).compare(source) === 0) &&
    debit.compare(source) === 0 && credit.compare(source) === 0;
  return {
    legalEntityId: input.journal.legalEntityId,
    currency: input.journal.baseCurrency,
    sourceCount: 1,
    journalCount: 1,
    sourceTotal: input.sourceAmount,
    ledgerTotal: { amount: debit.toString() as Money["amount"], currency: input.journal.baseCurrency },
    reconciled,
    scope: "FIRST_CAPITAL_RECEIPT_OPERATIONAL_SLICE"
  };
}
