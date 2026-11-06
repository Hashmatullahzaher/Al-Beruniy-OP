/**
 * Loans (migrations 0061 and 0062). Money lent to the company by a shareholder or anyone else: Dr Treasury, Cr a loan liability, and
 * repaid by the inverse. A loan is debt and never capital, so a person who is both keeps two separate positions. Outstanding amounts
 * are derived from posted journals; nothing here is a stored balance.
 *
 * A repayment removes carrying value, and any difference from the cash paid is a realized FX gain or loss in the same journal (0063).
 */

export type LenderType = "SHAREHOLDER" | "INDIVIDUAL" | "SUPPLIER" | "COMPANY" | "OTHER";
export type LoanStatus = "PENDING_APPROVAL" | "REJECTED" | "POSTED";

export interface LoanTreasuryRef { readonly id: string; readonly nameEn: string; readonly nameFa: string | null }

export interface LoanView {
  readonly id: string;
  readonly transactionReference: string;
  readonly reference: string | null;
  readonly note: string | null;
  readonly status: LoanStatus;
  readonly decisionReason: string | null;
  readonly lenderType: LenderType;
  readonly lender: { readonly id: string; readonly name: string };
  readonly shareholderProfileId: string | null;
  readonly currency: string;
  readonly principal: string;
  readonly basePrincipal: string;
  readonly date: string;
  readonly outstanding: string;
  readonly baseOutstanding: string;
  readonly repaid: string;
  readonly pendingRepayments: string;
  readonly reversed: boolean;
  readonly treasury: LoanTreasuryRef;
  readonly liability: { readonly id: string; readonly code: string; readonly name: string };
  readonly journalId: string | null;
  readonly createdBy: string | null;
}

export interface PendingLoanRepayment {
  readonly id: string;
  readonly loanId: string;
  readonly transactionReference: string;
  readonly reference: string | null;
  readonly lender: string;
  readonly currency: string;
  readonly amount: string;
  readonly date: string;
  readonly treasury: LoanTreasuryRef;
  readonly createdBy: string | null;
}

export interface LoanOptions {
  readonly treasuryAccounts: readonly (LoanTreasuryRef & { readonly accountType: string; readonly currencyCode: string })[];
  readonly liabilityAccounts: readonly { readonly id: string; readonly code: string; readonly name: string; readonly control: "SHAREHOLDER_LOAN" | "LOAN_PAYABLE" }[];
  readonly shareholders: readonly { readonly id: string; readonly name: string }[];
  readonly lenders: readonly { readonly id: string; readonly name: string }[];
}

export interface LoanWorkspace {
  readonly legalEntityId: string;
  readonly baseCurrency: string;
  readonly today: string;
  readonly approvalRequired: boolean;
  readonly permissions: { readonly canRead: boolean; readonly canRecord: boolean; readonly canRepay: boolean; readonly canApprove: boolean };
  readonly loans: readonly LoanView[] | null;
  readonly pendingRepayments: readonly PendingLoanRepayment[] | null;
  readonly options: LoanOptions | null;
}

export type LoanStatementLineKind = "RECEIPT" | "REPAYMENT" | "RECEIPT_REVERSAL" | "REPAYMENT_REVERSAL";

export interface LoanStatementView {
  readonly legalEntityId: string;
  readonly range: { readonly from: string; readonly to: string };
  readonly loan: Pick<LoanView, "id" | "transactionReference" | "reference" | "note" | "status" | "lenderType" | "lender" | "currency" | "principal" | "basePrincipal" | "date" | "liability" | "journalId">;
  readonly opening: { readonly native: string; readonly base: string };
  readonly closing: { readonly native: string; readonly base: string };
  readonly lines: readonly {
    readonly journalId: string;
    readonly date: string;
    readonly kind: LoanStatementLineKind;
    readonly reference: string;
    readonly amount: string;
    /** The carrying value this movement added or removed. */
    readonly baseAmount: string;
    /** The cash at its own frozen rate, which differs from the carrying value when a difference was realized. */
    readonly treasuryBaseAmount: string | null;
    /** Positive is a gain, negative is a loss. A reversal shows the opposite. */
    readonly realizedFx: string;
    readonly effect: string;
    readonly balance: string;
    readonly treasury: LoanTreasuryRef | null;
  }[];
  readonly realizedFx: string;
  readonly reconciliation: { readonly loansBase: string; readonly ledgerBase: string; readonly matches: boolean };
}

export type LoanCommand =
  | { readonly action: "record"; readonly lenderType: LenderType; readonly lenderBusinessPartyId: string | null; readonly lenderName: string | null;
      readonly shareholderProfileId: string | null; readonly liabilityLedgerAccountId: string | null; readonly treasuryAccountId: string; readonly amount: string;
      readonly currencyCode: string; readonly businessDate: string; readonly reference: string | null; readonly note: string | null; readonly exchangeRateId: string | null;
      readonly idempotencyKey: string; readonly correlationId: string }
  | { readonly action: "repay"; readonly loanId: string; readonly treasuryAccountId: string; readonly amount: string; readonly businessDate: string;
      readonly reference: string | null; readonly note: string | null; readonly exchangeRateId: string | null; readonly idempotencyKey: string; readonly correlationId: string }
  | { readonly action: "decide"; readonly kind: "LOAN" | "REPAYMENT"; readonly id: string; readonly decision: "APPROVED" | "REJECTED"; readonly reason: string | null;
      readonly idempotencyKey: string; readonly correlationId: string };

export interface LoanCommandResult {
  readonly status: LoanStatus;
  readonly journalId: string | null;
  readonly reference?: string;
  readonly loanId?: string;
  readonly repaymentId?: string;
  readonly replayed: boolean;
  /** Known once a repayment is posted: a pending one settles what is owed when it is approved. */
  readonly carryingAmount?: string;
  /** Positive is a gain, negative is a loss. */
  readonly realizedFx?: string;
}

export const LOAN_PERMISSIONS = ["finance.loan.read", "finance.loan.record", "finance.loan.repay", "finance.loan.approve"] as const;
export type LoanPermission = (typeof LOAN_PERMISSIONS)[number];
export type LoanAccountControl = "SHAREHOLDER_LOAN" | "LOAN_PAYABLE" | "REALIZED_FX_GAIN" | "REALIZED_FX_LOSS";
export type LoanAccountStatus = "READY" | "MISSING" | "AMBIGUOUS" | "INVALID";

/** What the loan screens still need. It names account roles and the reader's own permissions, and nothing about any lender or loan. */
export interface LoanReadiness {
  readonly legalEntityId: string;
  readonly baseCurrency: string;
  readonly approvalRequired: boolean;
  readonly accounts: readonly { readonly control: LoanAccountControl; readonly accountType: "LIABILITY" | "REVENUE" | "EXPENSE"; readonly status: LoanAccountStatus }[];
  readonly permissions: LoanWorkspace["permissions"];
  readonly canManageAccounts: boolean;
  readonly canManageRoles: boolean;
}

/** The parts of a role that decide whether a loan permission reaches anyone. */
export interface LoanReadinessRole {
  readonly status: string;
  readonly permissions: readonly string[];
  readonly holders: readonly { readonly status: string }[];
}

const HELD: Readonly<Record<LoanPermission, keyof LoanWorkspace["permissions"]>> = {
  "finance.loan.read": "canRead", "finance.loan.record": "canRecord", "finance.loan.repay": "canRepay", "finance.loan.approve": "canApprove"
};

/**
 * What is missing. Someone who can read roles sees which permissions reach nobody, all four of them, since that is what they can fix.
 * Anyone else sees what they themselves lack, and approval only when the company requires it.
 */
export function loanReadinessGaps(readiness: LoanReadiness, roles: readonly LoanReadinessRole[] | null = null) {
  const reaches = (code: LoanPermission) => (roles ?? []).some((role) => role.status === "ACTIVE" && role.permissions.includes(code) && role.holders.some((holder) => holder.status === "ACTIVE"));
  return {
    accounts: readiness.accounts.filter((account) => account.status !== "READY"),
    permissions: LOAN_PERMISSIONS.filter((code) => roles !== null ? !reaches(code)
      : !readiness.permissions[HELD[code]] && (code !== "finance.loan.approve" || readiness.approvalRequired))
  };
}
