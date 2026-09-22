import type {
  AccountingPeriodId,
  BusinessPartyId,
  CapitalAgreementId,
  CapitalInstallmentId,
  CapitalReceiptIntentId,
  CashLocationCurrencyAccountId,
  CashLocationId,
  CashReceiptId,
  CompanyId,
  CorrelationId,
  CostCenterId,
  DepartmentId,
  JournalId,
  JournalLineId,
  LedgerAccountId,
  LegalEntityId,
  PostingIntentId,
  ProjectId,
  ShareholderProfileId,
  SupportedCurrency,
  UserAccountId
} from "@abos/contracts";

/**
 * Persistence-facing values. Monetary values remain decimal text at the
 * application boundary and PostgreSQL NUMERIC in storage; never coerce them to
 * JavaScript number.
 */
export type DecimalText = string;
export type StageOneTransactionCurrency = SupportedCurrency;
export type IsoDate = string;
export type IsoTimestamp = string;

export interface MoneyColumns {
  readonly amount: DecimalText;
  readonly currencyCode: StageOneTransactionCurrency;
}

export interface CompanyRow {
  readonly id: CompanyId;
  readonly code: string;
  readonly name: string;
  readonly status: "DRAFT" | "ACTIVE" | "SUSPENDED" | "ARCHIVED";
  readonly createdAt: IsoTimestamp;
}

export interface LegalEntityRow {
  readonly id: LegalEntityId;
  readonly companyId: CompanyId;
  readonly code: string;
  readonly name: string;
  readonly baseCurrencyCode: StageOneTransactionCurrency | null;
  readonly currencyPolicyStatus: "PENDING" | "APPROVED" | "SUSPENDED";
  readonly createdAt: IsoTimestamp;
}

export interface DimensionColumns {
  readonly legalEntityId: LegalEntityId;
  readonly projectId: ProjectId | null;
  readonly departmentId: DepartmentId | null;
  readonly costCenterId: CostCenterId | null;
}

export interface UserAccountRow {
  readonly id: UserAccountId;
  readonly loginIdentifier: string;
  readonly displayName: string;
  readonly status: "INVITED" | "ACTIVE" | "DISABLED" | "REVOKED";
  readonly createdAt: IsoTimestamp;
  readonly disabledAt: IsoTimestamp | null;
}

export interface BusinessPartyRow {
  readonly id: BusinessPartyId;
  readonly legalEntityId: LegalEntityId;
  readonly displayName: string;
  readonly externalReference: string | null;
  readonly status: "DRAFT" | "ACTIVE" | "SUSPENDED" | "ARCHIVED";
  readonly createdAt: IsoTimestamp;
}

export interface LedgerAccountRow {
  readonly id: LedgerAccountId;
  readonly legalEntityId: LegalEntityId;
  readonly parentLedgerAccountId: LedgerAccountId | null;
  readonly accountCode: string;
  readonly accountName: string;
  readonly accountType: "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE";
  readonly controlAccountType:
    | "CASH"
    | "SHAREHOLDER_CAPITAL"
    | "SHAREHOLDER_LOAN"
    | "AR"
    | "AP"
    | "OTHER"
    | null;
  readonly postingAllowed: boolean;
  readonly accountCurrencyCode: StageOneTransactionCurrency | null;
  readonly status: "DRAFT" | "ACTIVE" | "INACTIVE";
}

export interface CapitalAgreementRow {
  readonly id: CapitalAgreementId;
  readonly legalEntityId: LegalEntityId;
  readonly shareholderProfileId: ShareholderProfileId;
  readonly agreementReference: string;
  readonly agreementKind: "CAPITAL_CONTRIBUTION" | "SHAREHOLDER_LOAN";
  readonly committedAmount: DecimalText;
  readonly currencyCode: StageOneTransactionCurrency;
  readonly effectiveOn: IsoDate;
  readonly status: "DRAFT" | "PENDING_EVIDENCE" | "ELIGIBLE" | "SUSPENDED" | "CLOSED";
}

export interface CapitalInstallmentRow {
  readonly id: CapitalInstallmentId;
  readonly legalEntityId: LegalEntityId;
  readonly capitalAgreementId: CapitalAgreementId;
  readonly sequenceNumber: number;
  readonly expectedAmount: DecimalText;
  readonly currencyCode: StageOneTransactionCurrency;
  readonly dueOn: IsoDate | null;
  readonly businessEventAt: IsoTimestamp | null;
  readonly status:
    | "DRAFT"
    | "PENDING_RECEIPT"
    | "RECEIVED_PENDING_APPROVAL"
    | "POSTED"
    | "REVERSED"
    | "CANCELLED";
}

export interface CashLocationCurrencyAccountRow {
  readonly id: CashLocationCurrencyAccountId;
  readonly legalEntityId: LegalEntityId;
  readonly cashLocationId: CashLocationId;
  readonly currencyCode: StageOneTransactionCurrency;
  readonly ledgerAccountId: LedgerAccountId;
  readonly activationStatus:
    | "DRAFT"
    | "RECONCILED"
    | "APPROVED"
    | "ACTIVE"
    | "BLOCKED";
  readonly reconciliationEvidenceReference: string | null;
  readonly activatedByUserAccountId: UserAccountId | null;
  readonly activatedAt: IsoTimestamp | null;
}

export interface PostingIntentRow extends DimensionColumns {
  readonly id: PostingIntentId;
  readonly sourceType: string;
  readonly sourceId: CapitalReceiptIntentId | JournalId;
  readonly treasuryCashReceiptId: CashReceiptId | null;
  readonly intentKind:
    | "SHAREHOLDER_CAPITAL_RECEIPT"
    | "SHAREHOLDER_LOAN_RECEIPT"
    | "REVERSAL";
  readonly originalAmount: DecimalText;
  readonly originalCurrencyCode: StageOneTransactionCurrency;
  readonly baseAmount: DecimalText | null;
  readonly baseCurrencyCode: StageOneTransactionCurrency | null;
  readonly conversionSnapshotReference: string | null;
  readonly accountingEffectiveDate: IsoDate;
  readonly correlationId: CorrelationId;
  readonly idempotencyKey: string;
  readonly status: "DRAFT" | "PENDING_APPROVAL" | "APPROVED" | "REJECTED" | "POSTED" | "CANCELLED";
}

export interface JournalRow {
  readonly id: JournalId;
  readonly legalEntityId: LegalEntityId;
  readonly accountingPeriodId: AccountingPeriodId;
  readonly postingIntentId: PostingIntentId;
  readonly journalReference: string;
  readonly accountingEffectiveDate: IsoDate;
  readonly baseCurrencyCode: StageOneTransactionCurrency;
  readonly status: "DRAFT" | "VALIDATED" | "POSTED";
  readonly postedByUserAccountId: UserAccountId | null;
  readonly postedAt: IsoTimestamp | null;
}

export interface JournalLineRow extends DimensionColumns {
  readonly id: JournalLineId;
  readonly journalId: JournalId;
  readonly lineNumber: number;
  readonly ledgerAccountId: LedgerAccountId;
  readonly businessPartyId: BusinessPartyId | null;
  readonly originalAmount: DecimalText | null;
  readonly originalCurrencyCode: StageOneTransactionCurrency | null;
  readonly baseDebit: DecimalText;
  readonly baseCredit: DecimalText;
  readonly baseCurrencyCode: StageOneTransactionCurrency;
  readonly conversionSnapshotReference: string | null;
  readonly sourceType: string;
  readonly sourceId: CapitalReceiptIntentId | JournalId;
}
