import type { TransactionDimensions } from "./dimensions.ts";
import type { EvidenceReference } from "./evidence.ts";
import type {
  AccountingPeriodId,
  CapitalAgreementId,
  CapitalInstallmentId,
  CapitalReceiptIntentId,
  CashLocationCurrencyAccountId,
  CashReceiptId,
  FinanceApprovalId,
  FxRateSnapshotId,
  JournalId,
  JournalLineId,
  LedgerAccountId,
  PostingIntentId,
  UserAccountId
} from "./ids.ts";
import type { DecimalString, Money, SupportedCurrency } from "./money.ts";

export interface FinancePolicyGate {
  readonly environment: "development" | "test" | "staging" | "production";
  readonly configurationState: "SYNTHETIC_TEST_ONLY" | "OWNER_PROVISIONAL" | "CLIENT_FINANCE_APPROVED";
  readonly policyVersionId: string;
  readonly baseCurrency: SupportedCurrency;
  readonly realPostingEnabled: boolean;
}

export interface FinanceApproval {
  readonly id: FinanceApprovalId;
  readonly postingIntentId: PostingIntentId;
  readonly approvedByUserAccountId: UserAccountId;
  readonly approvedAt: string;
  readonly evidence: readonly EvidenceReference[];
  readonly status: "APPROVED" | "REJECTED" | "REVOKED";
}

export interface CapitalPostingIntent {
  readonly id: PostingIntentId;
  readonly sourceType: "SHAREHOLDER_CAPITAL_INSTALLMENT";
  readonly sourceIntentId: CapitalReceiptIntentId;
  readonly agreementId: CapitalAgreementId;
  readonly installmentId: CapitalInstallmentId;
  readonly treasuryReceiptId: CashReceiptId;
  readonly dimensions: TransactionDimensions;
  readonly originalAmount: Money;
  readonly baseAmount: Money;
  readonly fxRateSnapshotId?: FxRateSnapshotId;
  readonly destinationAccountId: CashLocationCurrencyAccountId;
  readonly debitLedgerAccountId: LedgerAccountId;
  readonly creditLedgerAccountId: LedgerAccountId;
  readonly accountingPeriodId: AccountingPeriodId;
  readonly cashierUserAccountId: UserAccountId;
  readonly evidence: readonly EvidenceReference[];
  readonly status: "PENDING_APPROVAL" | "APPROVED" | "POSTED" | "REJECTED";
}

export interface JournalLineDraft {
  readonly id: JournalLineId;
  readonly ledgerAccountId: LedgerAccountId;
  readonly dimensions: TransactionDimensions;
  readonly originalAmount: Money;
  readonly debitBase?: DecimalString;
  readonly creditBase?: DecimalString;
  readonly subledgerType?: "CASH_LOCATION" | "SHAREHOLDER_CAPITAL";
  readonly subledgerId?: string;
}

export interface PostedJournal {
  readonly id: JournalId;
  readonly legalEntityId: TransactionDimensions["legalEntityId"];
  readonly accountingPeriodId: AccountingPeriodId;
  readonly baseCurrency: SupportedCurrency;
  readonly sourceType: CapitalPostingIntent["sourceType"] | "REVERSAL";
  readonly sourceId: string;
  readonly postedByUserAccountId: UserAccountId;
  readonly postedAt: string;
  readonly lines: readonly JournalLineDraft[];
  readonly reversalOfJournalId?: JournalId;
  readonly status: "POSTED";
}

export interface ReconciliationResult {
  readonly legalEntityId: TransactionDimensions["legalEntityId"];
  readonly currency: SupportedCurrency;
  readonly sourceCount: number;
  readonly journalCount: number;
  readonly sourceTotal: Money;
  readonly ledgerTotal: Money;
  readonly reconciled: boolean;
  readonly scope: "FIRST_CAPITAL_RECEIPT_OPERATIONAL_SLICE";
}
