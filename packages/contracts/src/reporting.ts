/**
 * Slice 7 (migration 0053): reports derived only from posted journals and their lines. Amounts are exact decimal text in
 * the accounting currency unless a field says it is native. Restricted detail is masked; amounts are never hidden.
 */

export type ReportRangeMode = "PERIOD" | "RANGE" | "AS_OF";

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
