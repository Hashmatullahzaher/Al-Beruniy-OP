/**
 * Slice 5 (migration 0050): closing and reopening accounting months, and reversing posted journals
 * through the one posting kernel. Amounts are exact decimal strings.
 */

export type AccountingPeriodStatus = "PENDING" | "OPEN" | "SOFT_CLOSED" | "CLOSED";

export interface PeriodReopenRequestView {
  readonly id: string;
  readonly reason: string;
  readonly version: number;
  readonly requestedBy: string | null;
  readonly requestedAt: string;
  readonly viewerIsRequester: boolean;
}

export interface AccountingPeriodView {
  readonly id: string;
  readonly name: string;
  readonly nameFa: string | null;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly status: AccountingPeriodStatus;
  readonly version: number;
  readonly openedBy: string | null;
  readonly openedAt: string | null;
  readonly closedBy: string | null;
  readonly closedAt: string | null;
  readonly reopenCount: number;
  readonly postedJournals: number;
  readonly reopenRequest: PeriodReopenRequestView | null;
}

export type PeriodEventAction = "CLOSED" | "REOPENED" | "REOPEN_REQUESTED" | "REOPEN_REJECTED" | "REOPEN_WITHDRAWN";

export interface PeriodsWorkspace {
  readonly today: string;
  /** Advanced Mode: the PERIOD_REOPEN setting is ON, so a second person confirms every reopen. */
  readonly reopenNeedsSecondPerson: boolean;
  readonly canClose: boolean;
  readonly canReopen: boolean;
  readonly periods: readonly AccountingPeriodView[];
  readonly history: readonly {
    readonly periodName: string; readonly periodNameFa: string | null; readonly action: PeriodEventAction;
    readonly fromStatus: string; readonly toStatus: string; readonly reason: string | null; readonly actor: string | null; readonly at: string;
  }[];
}

export type PeriodCloseWarning = "EARLIER_MONTH_OPEN" | "CONTAINS_TODAY" | "NO_POSTING";

export interface PeriodClosePreview {
  readonly period: { readonly id: string; readonly name: string; readonly nameFa: string | null; readonly startsOn: string; readonly endsOn: string;
    readonly status: AccountingPeriodStatus; readonly version: number };
  readonly summary: { readonly postedJournals: number; readonly debits: string; readonly credits: string };
  /** A journal of the month that is not posted: the one integrity problem that refuses a close. */
  readonly unpostedJournals: number;
  readonly pending: { readonly expensesAwaitingApproval: number; readonly reversalRequests: number; readonly temporaryFundingDecisions: number };
  readonly warnings: readonly PeriodCloseWarning[];
}

export type PeriodCommand =
  | { readonly action: "close"; readonly periodId: string; readonly expectedVersion: number }
  | { readonly action: "reopen"; readonly periodId: string; readonly expectedVersion: number; readonly reason: string }
  | { readonly action: "request-reopen"; readonly periodId: string; readonly expectedVersion: number; readonly reason: string }
  | { readonly action: "decide-reopen"; readonly requestId: string; readonly expectedVersion: number;
      readonly decision: "CONFIRMED" | "REJECTED" | "WITHDRAWN"; readonly note: string | null };

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
