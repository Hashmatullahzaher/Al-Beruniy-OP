import { financeHandoffRuntime, financeToken } from "@/server/finance-handoff";

/** Read-only posted activity through the restricted Finance database credential. */
export interface GeneralLedgerLine {
  readonly journalId: string;
  readonly journalReference: string;
  readonly lineNumber: number;
  readonly accountId: string;
  readonly accountCode: string;
  readonly accountName: string;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly accountingPeriodId: string;
  readonly accountingEffectiveDate: string;
  readonly postedAt: string;
  readonly originalCurrency: string | null;
  readonly originalAmount: string | null;
  readonly baseCurrency: string;
  readonly baseDebit: string;
  readonly baseCredit: string;
}

export interface GeneralLedgerView {
  readonly syntheticOnly: true;
  readonly legalEntityId: string;
  readonly from: string;
  readonly to: string;
  readonly accountId: string | null;
  readonly pageLimit: number;
  readonly returnedLineCount: number;
  readonly hasMore: boolean;
  readonly lines: readonly GeneralLedgerLine[];
  readonly totals: readonly {
    readonly currency: string;
    readonly debits: string;
    readonly credits: string;
    readonly lineCount: string;
  }[];
}

export async function generalLedgerView(from: string, to: string, accountId: string | null): Promise<GeneralLedgerView> {
  const token = await financeToken();
  const result = await financeHandoffRuntime().executor.query<{ readonly value: GeneralLedgerView }>(
    "SELECT abos.finance_general_ledger($1, $2::date, $3::date, $4::uuid) AS value",
    [token, from, to, accountId]
  );
  const value = result.rows[0]?.value;
  if (!value) throw new Error("The General Ledger function returned no result.");
  return value;
}
