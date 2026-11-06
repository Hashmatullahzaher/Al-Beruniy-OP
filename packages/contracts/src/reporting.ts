/**
 * Slice 7 (migration 0053): reports derived only from posted journals and their lines. Amounts are exact decimal text in
 * the accounting currency unless a field says it is native. Restricted detail is masked; amounts are never hidden.
 */

export type ReportRangeMode = "PERIOD" | "RANGE" | "AS_OF" | "YEAR";

/** Exactly one of periodId, from + to, or asOf. */
export type ReportRangeRequest =
  | { readonly periodId: string }
  | { readonly from: string; readonly to: string }
  | { readonly asOf: string };

export interface ReportPeriodRef {
  readonly id: string;
  readonly name: string;
  readonly nameFa: string | null;
}

export interface ReportRange {
  readonly mode: ReportRangeMode;
  readonly from: string;
  readonly to: string;
  readonly period: ReportPeriodRef | null;
  readonly fiscalYear: { readonly id: string; readonly calendarKind: string; readonly label: string; readonly labelFa: string;
    readonly startsOn: string; readonly endsOn: string;
    /** 0052: closed financial years refuse every posting, so their figures are final. */
    readonly closed: boolean } | null;
  /** Every month overlapping the range, for date grouping only (months are never closed or reopened by users). */
  readonly periods: readonly (ReportPeriodRef & { readonly startsOn: string; readonly endsOn: string })[];
  /** 0058: the company's financial years, for choosing a whole year. */
  readonly fiscalYears: readonly { readonly id: string; readonly label: string; readonly labelFa: string; readonly startsOn: string;
    readonly endsOn: string; readonly closed: boolean }[];
}

export interface TrialBalanceRow {
  readonly accountId: string;
  readonly accountCode: string;
  readonly accountName: string;
  readonly accountType: "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE";
  readonly controlType: string | null;
  readonly accountCurrency: string | null;
  readonly status: string;
  readonly parentId: string | null;
  readonly openingDebit: string;
  readonly openingCredit: string;
  readonly periodDebit: string;
  readonly periodCredit: string;
  readonly endingDebit: string;
  readonly endingCredit: string;
  /** Native detail of lines in another original currency (information only, never in the totals). */
  readonly native: readonly { readonly currency: string; readonly openingNet: string; readonly periodDebit: string;
    readonly periodCredit: string; readonly endingNet: string }[];
}

export interface TrialBalanceTotals {
  readonly openingDebit: string;
  readonly openingCredit: string;
  readonly periodDebit: string;
  readonly periodCredit: string;
  readonly endingDebit: string;
  readonly endingCredit: string;
}

export interface TrialBalanceView {
  readonly legalEntityId: string;
  readonly baseCurrency: string;
  readonly range: ReportRange;
  readonly includeZero: boolean;
  readonly accounts: readonly TrialBalanceRow[];
  readonly totals: TrialBalanceTotals;
  /** Opening, period and ending debits equal credits, and no posted journal is unbalanced. */
  readonly balanced: boolean;
  readonly unbalancedJournals: number;
}

export interface ReportSource {
  /** The posting source, or RESTRICTED when the line is outside the reader's scope. */
  readonly type: string;
  readonly id: string | null;
  readonly label: { readonly en: string; readonly fa: string };
  readonly route: string | null;
  readonly counterparty: string | null;
  /** The reader may not read the source module, so its detail is withheld (the amount never is). */
  readonly detailRestricted?: boolean;
  /** 0055: what the source was, e.g. an expense's "EXP-001 — Office supplies", when the reader may read it; otherwise null. */
  readonly detail?: { readonly en: string; readonly fa: string } | null;
  /** 0057: what the people recording it wrote, for a reader of that source module only. */
  readonly reference?: string | null;
  readonly description?: string | null;
  /** 0057: on General Ledger sources, the journal reference this reader may see. */
  readonly journalReference?: string | null;
}

export interface ReportJournalLink {
  readonly journalId: string;
  readonly reference: string | null;
  readonly date: string;
}

export interface AccountStatementLine {
  readonly journalId: string;
  readonly lineNumber: number;
  readonly date: string;
  readonly postedAt: string;
  readonly debit: string;
  readonly credit: string;
  /** Debit-positive running balance after this line. */
  readonly balance: string;
  readonly originalAmount: string;
  readonly originalCurrency: string;
  readonly rate: { readonly rate: string; readonly unitCurrency: string; readonly quoteCurrency: string; readonly rateDate: string;
    readonly source: string } | null;
  readonly restricted: boolean;
  readonly journalReference: string | null;
  readonly source: ReportSource | null;
  readonly reversedBy: ReportJournalLink | null;
  readonly reverses: ReportJournalLink | null;
}

export interface ReportPosition {
  readonly debit: string;
  readonly credit: string;
  readonly net: string;
}

export interface AccountStatementView {
  readonly legalEntityId: string;
  readonly range: ReportRange;
  readonly account: { readonly id: string; readonly code: string; readonly name: string; readonly type: string;
    readonly controlType: string | null; readonly currency: string | null; readonly status: string };
  readonly opening: ReportPosition;
  readonly lines: readonly AccountStatementLine[];
  readonly periodDebit: string;
  readonly periodCredit: string;
  readonly closing: ReportPosition;
}

/** 0057: a statement of one Safe, cash box, petty cash or Saraf. Native currency is the balance; the accounting value is secondary. */
export interface TreasuryStatementFx {
  readonly rate: string;
  readonly unitCurrency: string;
  readonly quoteCurrency: string;
  readonly rateDate: string;
  readonly source: string;
  readonly policyVersionId: string | null;
  readonly roundingMode: string | null;
  readonly baseScale: number | null;
  /** 0064: this movement's value at its own rate. It is not what the account carries. */
  readonly transactionBaseAmount: string | null;
  readonly exactBaseAmount: string | null;
  readonly roundingDifference: string | null;
}

export interface TreasuryStatementLine {
  readonly id: string;
  readonly date: string;
  readonly postedAt: string;
  readonly moneyIn: string;
  readonly moneyOut: string;
  /** Native running balance after this movement. A Saraf may be negative. */
  readonly balance: string;
  readonly currency: string;
  /** Signed carrying value this movement added or removed. */
  readonly baseAmount: string;
  /** Carrying value of the account after this movement. */
  readonly runningBase: string;
  readonly restricted: boolean;
  /** TRANSFER covers a transfer and its reversal: internal movement, never company money in or out. */
  readonly kind: "EXTERNAL" | "TRANSFER" | "OPENING";
  readonly isReversal: boolean;
  readonly fx: TreasuryStatementFx | null;
  /** Null without Finance report permission or outside the reader's scope. */
  readonly journalId: string | null;
  readonly journalReference: string | null;
  readonly source: ReportSource | null;
  readonly transferPeer: { readonly en: string; readonly fa: string } | null;
  readonly reversedBy: { readonly journalId: string | null; readonly reference: string | null; readonly date: string } | null;
  readonly reverses: { readonly journalId: string | null; readonly reference: string | null; readonly date: string } | null;
}

export interface TreasuryStatementAccount {
  readonly id: string;
  readonly nameEn: string;
  readonly nameFa: string | null;
  readonly accountType: string;
  readonly currencyCode: string;
  readonly status: string;
}

export interface TreasuryStatement {
  readonly range: ReportRange;
  readonly canOpenLedger: boolean;
  readonly account: TreasuryStatementAccount & { readonly ledgerAccount: { readonly id: string; readonly code: string; readonly name: string } | null };
  readonly opening: { readonly native: string; readonly base: string };
  readonly closing: { readonly native: string; readonly base: string };
  /** Anything but OK can only come from a history posted before 0064. */
  readonly carryingStatus: "OK" | "ORPHAN" | "INVERTED";
  readonly totals: { readonly moneyIn: string; readonly moneyOut: string; readonly transfersIn: string; readonly transfersOut: string;
    readonly reversalsIn: string; readonly reversalsOut: string; readonly movementCount: number };
  readonly lines: readonly TreasuryStatementLine[];
  /** The Treasury accounting value against the ledger account: they must be equal. */
  readonly reconciliation: { readonly treasuryBase: string; readonly ledgerBase: string; readonly difference: string; readonly matches: boolean };
}

export interface TreasuryStatementView {
  readonly legalEntityId: string;
  readonly baseCurrency: string;
  readonly accounts: readonly TreasuryStatementAccount[];
  readonly statement: TreasuryStatement | null;
}

/** 0058: one currency's movement in the Financial summary. Every figure is net of its reversals. */
export interface SummaryFigures {
  readonly opening: string;
  readonly closing: string;
  readonly capitalReceived: string;
  readonly loansReceived: string;
  readonly otherReceipts: string;
  readonly moneyReceived: string;
  readonly expensesPaid: string;
  readonly paymentsMade: string;
  readonly loanRepayments: string;
  readonly moneyPaid: string;
  readonly openingBalancesRecorded: string;
  /** Internal movement: never part of money received or paid. */
  readonly transfersIn: string;
  readonly transfersOut: string;
  readonly unclassified: string;
  readonly reversalsIn: string;
  readonly reversalsOut: string;
  readonly reversalCount: number;
  readonly flowsClosing: string;
}

export interface ManagementSummaryView {
  readonly legalEntityId: string;
  readonly baseCurrency: string;
  readonly range: ReportRange;
  readonly accounts: readonly { readonly id: string; readonly nameEn: string; readonly nameFa: string | null; readonly accountType: string; readonly currency: string;
    readonly status: string; readonly opening: string; readonly closing: string; readonly baseOpening: string; readonly baseClosing: string }[];
  /** The accounting currency. Absent only for a company with no Treasury account. */
  readonly base: SummaryFigures | null;
  readonly currencies: Readonly<Record<string, SummaryFigures>>;
  /** Income and expenses leave realized FX out, so it reads as neither. The net result includes it. */
  readonly profit: { readonly income: string; readonly expenses: string; readonly realizedFxGain: string; readonly realizedFxLoss: string; readonly netResult: string };
  readonly reconciliation: { readonly treasuryClosing: string; readonly flowsClosing: string; readonly ledgerClosing: string; readonly matches: boolean };
}

/** 0058: one person's equity and debt. They are separate figures and are never added together. */
export interface ShareholderTransaction {
  readonly id: string;
  readonly date: string;
  readonly kind: "CAPITAL_RECEIVED" | "CAPITAL_REVERSAL" | "LOAN_RECEIVED" | "LOAN_REPAID" | "LOAN_REVERSAL";
  readonly section: "CAPITAL" | "LOAN";
  readonly amount: string;
  readonly effect: string;
  readonly balance: string;
  readonly currency: string;
  readonly baseAmount: string;
  readonly restricted: boolean;
  readonly source: ReportSource | null;
  readonly journalId: string | null;
  readonly journalReference: string | null;
  readonly safe: { readonly id: string; readonly nameEn: string; readonly nameFa: string | null } | null;
  readonly reversedBy: { readonly journalId: string | null; readonly reference: string | null; readonly date: string } | null;
  readonly reverses: { readonly journalId: string | null; readonly reference: string | null; readonly date: string } | null;
}

export interface ShareholderCapitalPosition {
  readonly currency: string;
  /** Information only: never decides a balance. */
  readonly agreed: string | null;
  readonly opening: string;
  readonly received: string;
  readonly reversed: string;
  readonly effective: string;
  readonly baseEffective: string;
  readonly outstanding: string | null;
}

export interface ShareholderLoanPosition {
  readonly currency: string;
  readonly opening: string;
  readonly received: string;
  readonly repaid: string;
  readonly outstanding: string;
  readonly baseOutstanding: string;
}

export interface ShareholderStatementView {
  readonly legalEntityId: string;
  readonly baseCurrency: string;
  readonly range: ReportRange;
  readonly canReadCapital: boolean;
  readonly canReadLoans: boolean;
  /** Company totals: arithmetic with no person in it. Null when the reader may not see that section. */
  readonly totals: { readonly capital: readonly { readonly currency: string; readonly effective: string; readonly baseEffective: string }[] | null;
    readonly loans: readonly { readonly currency: string; readonly outstanding: string; readonly baseOutstanding: string }[] | null };
  readonly people: readonly { readonly partyId: string; readonly name: string; readonly isShareholder: boolean;
    readonly capital: readonly { readonly currency: string; readonly effective: string; readonly baseEffective: string }[] | null;
    readonly loans: readonly { readonly currency: string; readonly outstanding: string; readonly baseOutstanding: string }[] | null }[];
  readonly reconciliation: { readonly capital: { readonly subledgerBase: string; readonly ledgerBase: string; readonly matches: boolean } | null;
    readonly loans: { readonly subledgerBase: string; readonly ledgerBase: string; readonly matches: boolean } | null };
  readonly statement: { readonly party: { readonly id: string; readonly name: string; readonly shareholderProfileId: string | null };
    readonly capital: readonly ShareholderCapitalPosition[] | null; readonly loans: readonly ShareholderLoanPosition[] | null;
    readonly transactions: readonly ShareholderTransaction[]; readonly canOpenLedger: boolean } | null;
}

/** 0059: the financial statements, from classified ledger accounts in the accounting currency. */
export interface IncomeStatementAccount {
  readonly accountId: string;
  readonly code: string;
  readonly name: string;
  readonly class: "REVENUE" | "EXPENSE";
  readonly status: string;
  readonly parent: { readonly id: string; readonly code: string; readonly name: string } | null;
  readonly amount: string;
}

export interface IncomeStatementView {
  readonly legalEntityId: string;
  readonly baseCurrency: string;
  readonly range: ReportRange;
  readonly income: readonly IncomeStatementAccount[];
  readonly expenses: readonly IncomeStatementAccount[];
  readonly totalIncome: string;
  readonly totalExpenses: string;
  readonly netResult: string;
  readonly yearToDate: { readonly from: string; readonly to: string; readonly income: string; readonly expenses: string; readonly netResult: string };
}

export interface BalanceSheetAccount {
  readonly accountId: string;
  readonly code: string;
  readonly name: string;
  readonly class: "ASSET" | "LIABILITY" | "EQUITY";
  readonly control: string | null;
  readonly status: string;
  readonly parent: { readonly id: string; readonly code: string; readonly name: string } | null;
  readonly group: "TREASURY" | "OTHER_ASSETS" | "LOANS" | "PAYABLES" | "SARAF_PAYABLE" | "OTHER_LIABILITIES" | "SHAREHOLDER_CAPITAL" | "OPENING_BALANCE_EQUITY" | "OTHER_EQUITY";
  /** What the statement shows. */
  readonly amount: string;
  /** The natural-side balance the ledger holds. Differs from amount only when the row is reclassified. */
  readonly bookAmount: string;
  /** A negative ASSET-type Saraf presented as a liability. Presentation only: no journal exists. */
  readonly reclassified: boolean;
}

export interface BalanceSheetView {
  readonly legalEntityId: string;
  readonly baseCurrency: string;
  readonly range: ReportRange;
  readonly asOf: string;
  readonly yearStart: string;
  readonly accounts: readonly BalanceSheetAccount[];
  readonly totalAssets: string;
  readonly totalLiabilities: string;
  /** Added to both total assets and total liabilities by presenting negative Sarafs as amounts owed. */
  readonly reclassifiedSaraf: string;
  readonly equityAccounts: string;
  /** Derived for presentation: no closing journal exists. */
  readonly earlierYearsResult: string;
  readonly currentYearResult: string;
  readonly totalEquity: string;
  readonly totalLiabilitiesAndEquity: string;
  readonly validation: { readonly difference: string; readonly balanced: boolean; readonly unbalancedJournals: number };
  readonly treasury: { readonly treasuryBase: string; readonly ledgerBase: string; readonly matches: boolean };
}

export interface JournalDetailView {
  readonly journalId: string;
  readonly reference: string | null;
  readonly restricted: boolean;
  readonly date: string;
  readonly postedAt: string;
  readonly baseCurrency: string;
  readonly postedBy: string | null;
  readonly period: ReportPeriodRef | null;
  readonly source: ReportSource | null;
  readonly lines: readonly { readonly lineNumber: number; readonly accountId: string; readonly accountCode: string;
    readonly accountName: string; readonly accountType: string; readonly debit: string; readonly credit: string;
    readonly originalAmount: string; readonly originalCurrency: string }[];
  readonly fx: { readonly rate: string; readonly unitCurrency: string; readonly quoteCurrency: string; readonly rateDate: string;
    readonly source: string; readonly roundingMode: string | null; readonly baseScale: number | null; readonly exactBaseAmount: string | null;
    readonly roundingDifference: string | null; readonly policyVersionId: string | null } | null;
  readonly reversedBy: (ReportJournalLink & { readonly reason: string | null }) | null;
  readonly reverses: (ReportJournalLink & { readonly reason: string | null }) | null;
}

export const REPORTING_PERMISSIONS = ["finance.report.operational.read"] as const;
