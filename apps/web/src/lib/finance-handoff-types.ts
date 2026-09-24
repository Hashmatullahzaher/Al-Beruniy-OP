export type FinanceWorkflowStage = "HANDED_TO_FINANCE" | "PENDING_APPROVAL" | "APPROVED" | "POSTED";

export interface FinanceActorView {
  readonly userAccountId: string;
  readonly displayName: string;
  readonly permissions: readonly string[];
  readonly sessionExpiresAt: string;
}

export interface FinanceHandoffSummary {
  readonly id: string;
  readonly receiptId: string;
  readonly receiptReference: string;
  readonly shareholder: string;
  readonly agreementReference: string;
  readonly installmentSequence: number;
  readonly amount: string;
  readonly currency: "USD" | "AFN";
  readonly receivingAccount: string;
  readonly handedOffAt: string;
  readonly stage: FinanceWorkflowStage;
  readonly postingIntentId?: string;
  readonly journalId?: string;
}

export interface FinancePeriodView {
  readonly id: string;
  readonly label: string;
  readonly startsOn: string;
  readonly endsOn: string;
}

export interface FinanceHandoffWorkspaceView {
  readonly actor: FinanceActorView;
  readonly handoffs: readonly FinanceHandoffSummary[];
  readonly openPeriods: readonly FinancePeriodView[];
}

export interface FinanceHandoffTraceView extends FinanceHandoffSummary {
  readonly agreementId: string;
  readonly installmentId: string;
  readonly receivingSafe: string;
  readonly physicalCount: { readonly amount: string; readonly countedBy: string; readonly confirmedBy: string; readonly evidence: string };
  readonly receiptEvidence: string;
  readonly verifier: string;
  readonly handedOffBy: string;
  readonly postingIntent?: { readonly id: string; readonly status: string; readonly createdBy: string; readonly accountingEffectiveDate: string };
  readonly approval?: { readonly id: string; readonly approver: string; readonly approvedAt: string; readonly evidence: string };
  readonly journal?: { readonly id: string; readonly reference: string; readonly status: string; readonly debit: string; readonly credit: string; readonly postedAt: string };
  readonly reconciliation: { readonly sourceStatus: string; readonly receiptStatus: string; readonly journalStatus: string };
}

export type FinanceApiResponse<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };
