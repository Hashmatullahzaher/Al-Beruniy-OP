/**
 * Slice 5 (migration 0050): reversing posted journals through the one posting kernel, and (migration 0052) closing a
 * financial year. Al-Beruniy closes a financial year, never a month: months only group dates for reporting and the
 * fiscal calendar, open themselves when something is recorded, and close with their year. Amounts are exact decimal
 * strings.
 */

/** A month's internal state, for the calendar and reporting only. Users never close or reopen a month. */
export type AccountingPeriodStatus = "PENDING" | "OPEN" | "SOFT_CLOSED" | "CLOSED";

/**
 * ACTIVE: transactions dated in the year may be recorded. CLOSED: the year was closed (stored on the year itself,
 * fiscal_years.closed_at); every posting dated in it is refused by the journal guard, whatever its month rows say.
 */
export type FinancialYearStatus = "ACTIVE" | "CLOSED";

export interface FinancialYearView {
  readonly id: string;
  readonly label: string;
  readonly labelFa: string | null;
  readonly calendarKind: "GREGORIAN" | "SOLAR_HIJRI" | "CUSTOM";
  readonly startsOn: string;
  readonly endsOn: string;
  readonly status: FinancialYearStatus;
  readonly closedAt: string | null;
  readonly closedBy: string | null;
  readonly postedJournals: number;
  /** The year's months, for reporting only. */
  readonly months: readonly { readonly id: string; readonly name: string; readonly nameFa: string | null; readonly startsOn: string; readonly endsOn: string }[];
}

export interface FinancialYearsWorkspace {
  readonly today: string;
  readonly canClose: boolean;
  readonly years: readonly FinancialYearView[];
}

export type FinancialYearCloseWarning = "YEAR_NOT_ENDED" | "EARLIER_YEAR_ACTIVE";

export interface FinancialYearClosePreview {
  readonly year: FinancialYearView;
  readonly summary: { readonly postedJournals: number; readonly debits: string; readonly credits: string };
  /** A journal of the year that is not posted: the one integrity problem that refuses a close. */
  readonly unpostedJournals: number;
  readonly pending: { readonly expensesAwaitingApproval: number; readonly reversalRequests: number; readonly temporaryFundingDecisions: number };
  readonly warnings: readonly FinancialYearCloseWarning[];
}

export interface FinancialYearCloseResult {
  readonly fiscalYearId: string;
  readonly status: "CLOSED";
  readonly replayed: boolean;
  readonly year: FinancialYearView;
}

export type ReversalBlocker = "NOT_FOUND" | "NOT_POSTED" | "IS_REVERSAL" | "ALREADY_REVERSED" | "APPROVED_REQUEST" | "OPEN_REQUEST";

export interface ReversibleJournalView {
  readonly id: string;
  readonly reference: string;
  readonly date: string;
  readonly sourceType: string;
  readonly amount: string;
  readonly currency: string;
  readonly postedBy: string | null;
  readonly periodStatus: AccountingPeriodStatus;
  readonly blocker: ReversalBlocker | null;
  /** The viewer prepared, approved or posted it. Simple Mode: the viewer may still reverse it directly (a flagged self-correction).
   *  Advanced Mode: the viewer can neither ask for its reversal nor decide or post it. */
  readonly viewerIsParticipant: boolean;
  readonly lines: readonly { readonly lineNumber: number; readonly accountCode: string; readonly accountName: string; readonly debit: string; readonly credit: string }[];
  readonly reversal: { readonly journalId: string; readonly reference: string; readonly date: string; readonly reason: string;
    /** Simple Mode self-correction: the reverser had recorded or approved the original. */
    readonly selfReversal: boolean; readonly mode: "DIRECT" | "APPROVED_REQUEST" } | null;
}

export type JournalReversalRequestStatus = "REQUESTED" | "APPROVED" | "REJECTED" | "WITHDRAWN";

export interface JournalReversalRequestView {
  readonly id: string;
  readonly journalId: string;
  readonly journalReference: string;
  readonly status: JournalReversalRequestStatus;
  readonly reason: string;
  readonly version: number;
  readonly requestedBy: string | null;
  readonly requestedAt: string;
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
  readonly decisionNote: string | null;
  readonly viewerIsRequester: boolean;
  readonly viewerIsParticipant: boolean;
  readonly reversalJournalId: string | null;
}

export interface JournalReversalWorkspace {
  readonly today: string;
  /** Advanced Mode: the JOURNAL_REVERSAL setting is ON, so every reversal is requested and approved. */
  readonly approvalRequired: boolean;
  readonly canReverseDirectly: boolean;
  readonly canRequest: boolean;
  readonly canApprove: boolean;
  readonly journals: readonly ReversibleJournalView[];
  readonly requests: readonly JournalReversalRequestView[];
}

export type JournalReversalCommand =
  | { readonly action: "reverse"; readonly journalId: string; readonly reason: string; readonly idempotencyKey: string; readonly correlationId: string }
  | { readonly action: "request"; readonly journalId: string; readonly reason: string }
  | { readonly action: "decide"; readonly requestId: string; readonly expectedVersion: number; readonly decision: "APPROVED" | "REJECTED"; readonly note: string | null }
  | { readonly action: "post-approved"; readonly requestId: string }
  | { readonly action: "withdraw"; readonly requestId: string; readonly expectedVersion: number };

export interface JournalReversalResult {
  readonly reversalJournalId?: string;
  readonly reference?: string;
  readonly effectiveDate?: string;
  /** false: the original month was closed, so the reversal posted on the business day in the current month. */
  readonly postedInOriginalPeriod?: boolean;
  readonly selfReversal?: boolean;
  readonly requestId?: string;
  readonly status: string;
  readonly replayed: boolean;
}

export const PERIOD_PERMISSIONS = ["finance.period.manage", "finance.period.reopen"] as const;
export const REVERSAL_PERMISSIONS = ["finance.reversal.direct", "finance.reversal.request", "finance.reversal.approve"] as const;
