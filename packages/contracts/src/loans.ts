/**
 * Loans (migrations 0061 and 0062). Money lent to the company by a shareholder or anyone else: Dr Treasury, Cr a loan liability, and
 * repaid by the inverse. A loan is debt and never capital, so a person who is both keeps two separate positions. Outstanding amounts
 * are derived from posted journals; nothing here is a stored balance.
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
    readonly baseAmount: string;
    readonly effect: string;
    readonly balance: string;
    readonly treasury: LoanTreasuryRef | null;
  }[];
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
}
