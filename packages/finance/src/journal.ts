import type { JournalLineDraft, LedgerAccountId, LegalEntityId, SupportedCurrency } from "@abos/contracts";
import { ExactDecimal } from "./decimal.ts";
import { assertFinance } from "./errors.ts";

export interface LedgerAccountPolicy {
  readonly id: LedgerAccountId;
  readonly legalEntityId: LegalEntityId;
  readonly status: "ACTIVE" | "INACTIVE";
  readonly postable: boolean;
}

export function validateJournalLines(input: {
  readonly lines: readonly JournalLineDraft[];
  readonly legalEntityId: LegalEntityId;
  readonly baseCurrency: SupportedCurrency;
  readonly accounts: ReadonlyMap<LedgerAccountId, LedgerAccountPolicy>;
}): void {
  assertFinance(input.lines.length >= 2, "JOURNAL_UNBALANCED", "A journal requires at least two lines");
  let debitTotal = ExactDecimal.parse("0");
  let creditTotal = ExactDecimal.parse("0");

  for (const line of input.lines) {
    const hasDebit = line.debitBase !== undefined;
    const hasCredit = line.creditBase !== undefined;
    assertFinance(hasDebit !== hasCredit, "JOURNAL_UNBALANCED", "Each line requires exactly one debit or credit");
    const amount = ExactDecimal.parse((line.debitBase ?? line.creditBase) as string);
    assertFinance(amount.isPositive(), "JOURNAL_UNBALANCED", "Journal line amounts must be positive");
    assertFinance(line.originalAmount.currency === input.baseCurrency, "CURRENCY_MISMATCH", "Original and base currency must match in this slice");
    assertFinance(line.dimensions.legalEntityId === input.legalEntityId, "SCOPE_MISMATCH", "Journal line legal entity mismatch");
    const account = input.accounts.get(line.ledgerAccountId);
    assertFinance(account, "NOT_FOUND", "Ledger account was not found in approved configuration");
    assertFinance(account.legalEntityId === input.legalEntityId, "SCOPE_MISMATCH", "Ledger account legal entity mismatch");
    assertFinance(account.status === "ACTIVE" && account.postable, "POLICY_CONFIGURATION_PENDING", "Ledger account is not active and postable");
    if (hasDebit) debitTotal = debitTotal.add(amount);
    if (hasCredit) creditTotal = creditTotal.add(amount);
  }
  assertFinance(debitTotal.compare(creditTotal) === 0, "JOURNAL_UNBALANCED", `Journal is unbalanced: debit ${debitTotal.toString()} credit ${creditTotal.toString()}`);
}
