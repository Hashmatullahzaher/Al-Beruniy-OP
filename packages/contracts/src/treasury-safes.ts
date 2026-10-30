import type { FxSetupView } from "./fx-policy.ts";

/**
 * Safes (migrations 0045 and 0046): one canonical Treasury account model whose balances are always
 * derived from posted movements, and an opening balance that is a real posting (Dr the Safe, Cr
 * opening balance equity). Amounts are exact decimal strings; nothing here is ever a stored balance.
 */

export type SafeAccountType = "SAFE" | "CASH_BOX" | "PETTY_CASH" | "BANK" | "SARAF" | "OTHER";
export type SafeStatus = "ACTIVE" | "INACTIVE" | "CLOSED";
export type OpeningEquityStatus = "READY" | "MISSING" | "AMBIGUOUS" | "INVALID";

export interface SafeBalance {
  /** Movements recorded by the opening-balance source, net of their reversals (the effective opening balance, 0050). */
  readonly opening: string;
  /** Other money in, as a positive figure. */
  readonly inflows: string;
  /** Other money out, as a positive figure. */
  readonly outflows: string;
  /** opening + inflows - outflows: the sum of every posted movement of the Safe. */
  readonly book: string;
  /** 0051: the same movements in the accounting currency (each valued at its own posted rate snapshot). */
  readonly baseBook?: string;
  readonly movementCount: number;
  readonly lastMovementDate: string | null;
}

export interface SafeMovement {
  readonly journalId: string;
  readonly date: string;
  readonly direction: "IN" | "OUT";
  readonly amount: string;
  readonly sourceType: string;
  /** Hidden (null) when the movement carries a project, department or cost centre outside the reader's scope. */
  readonly reference: string | null;
  readonly restricted: boolean;
}

export interface SafeOpeningBalance {
  readonly id: string;
  readonly amount: string;
  readonly currencyCode: string;
  readonly asOfDate: string;
  readonly reference: string | null;
  readonly note: string | null;
  readonly transactionReference: string;
  readonly journalId: string;
  readonly recordedAt: string;
  /** 0050: the opening balance was reversed; the Safe's opening figure is then the effective amount (0 when fully reversed). */
  readonly reversal?: { readonly journalId: string; readonly reference: string; readonly date: string; readonly reason: string };
}

export interface SafeView {
  readonly id: string;
  readonly nameEn: string;
  readonly nameFa: string | null;
  readonly accountType: SafeAccountType;
  readonly currencyCode: string;
  readonly status: SafeStatus;
  readonly version: number;
  readonly ledgerAccount: { readonly id: string; readonly code: string; readonly name: string };
  readonly balance: SafeBalance;
  readonly openingBalance: SafeOpeningBalance | null;
  readonly responsibles: readonly { readonly userAccountId: string; readonly displayName: string }[];
  /** The frozen legacy cash location that shares this Safe's ledger account, if any (read only). */
  readonly legacyLink: { readonly locationName: string; readonly activationStatus: string } | null;
  readonly movements: readonly SafeMovement[];
}

export interface SafesWorkspace {
  /** The Kabul business day: the latest allowed as-of date. */
  readonly today: string;
  readonly baseCurrency: string;
  readonly canRecordOpeningBalance: boolean;
  readonly canManageSafes: boolean;
  readonly canOpenLedger: boolean;
  readonly openingEquity: {
    readonly status: OpeningEquityStatus;
    readonly count?: number;
    readonly account?: { readonly id: string; readonly code: string; readonly name: string; readonly currency: string };
  };
  readonly safes: readonly SafeView[];
  readonly assignableUsers: readonly { readonly userAccountId: string; readonly displayName: string }[];
}

export interface SafeOpeningBalanceCommand {
  readonly action: "record-opening-balance";
  readonly treasuryAccountId: string;
  readonly amount: string;
  readonly currencyCode: string;
  readonly asOfDate: string;
  readonly reference: string | null;
  readonly note: string | null;
  /** 0051: the as-of day's rate to use when that day has several (a foreign-currency Safe only). */
  readonly exchangeRateId?: string | null;
  readonly idempotencyKey: string;
  readonly correlationId: string;
}

export interface SafeResponsiblesCommand {
  readonly action: "set-responsibles";
  readonly treasuryAccountId: string;
  readonly userAccountIds: readonly string[];
}

export type SafesCommand = SafeOpeningBalanceCommand | SafeResponsiblesCommand;

export interface SafeOpeningBalanceResult {
  readonly openingBalanceId: string;
  readonly journalId: string;
  readonly reference: string;
  readonly baseAmount?: string;
  readonly fxConversionId?: string | null;
  readonly status: "POSTED";
  readonly replayed: boolean;
}

export const SAFE_PERMISSIONS = ["treasury.safe.read", "treasury.opening-balance.record"] as const;

/** Slice 4 (0047): receive cash, transfer and pay against a payable, each one save through the posting kernel. */
/** A missing setting is READY: Simple Mode records in one save (0049). */
export type MoneySettingStatus = "READY" | "APPROVAL_REQUIRED";
export type PaymentKind = "SUPPLIER" | "CONTRACTOR" | "SALARY" | "OTHER";
export const PAYMENT_KINDS: readonly PaymentKind[] = ["SUPPLIER", "CONTRACTOR", "SALARY", "OTHER"];

export interface MoneyOptions {
  readonly baseCurrency: string | null;
  readonly today: string;
  readonly canReceive: boolean;
  readonly canTransfer: boolean;
  readonly canPay: boolean;
  readonly canRecordExpense: boolean;
  /** Approval setting per workflow type: OTHER_INCOME, TREASURY_TRANSFER, SUPPLIER_PAYMENT, SALARY_PAYMENT. */
  readonly settings: Readonly<Record<string, MoneySettingStatus>>;
  readonly treasuryAccounts: readonly { readonly id: string; readonly nameEn: string; readonly nameFa: string | null; readonly accountType: SafeAccountType; readonly currencyCode: string }[];
  readonly incomeAccounts: readonly { readonly id: string; readonly code: string; readonly name: string }[];
  /** requiresParty: an accounts-payable control account, kept per supplier, so a free-text payee is not enough. */
  readonly payableAccounts: readonly { readonly id: string; readonly code: string; readonly name: string; readonly requiresParty: boolean }[];
  readonly parties: readonly { readonly id: string; readonly name: string }[];
  /** 0051: the FX setup of each foreign currency held by an active account; SETUP_REQUIRED cannot post yet. */
  readonly fx: readonly FxSetupView[];
}

interface MoneyRequest {
  readonly amount: string;
  readonly currencyCode: string;
  readonly businessDate: string;
  readonly reference: string | null;
  readonly note: string | null;
  /** 0051: the day's rate to use when that day has several (a foreign-currency movement only). */
  readonly exchangeRateId?: string | null;
  readonly idempotencyKey: string;
  readonly correlationId: string;
}

export interface ReceiveCashCommand extends MoneyRequest {
  readonly action: "receive-cash";
  readonly treasuryAccountId: string;
  readonly payerBusinessPartyId: string | null;
  readonly payerName: string | null;
  readonly revenueLedgerAccountId: string;
}

export interface TransferCommand extends MoneyRequest {
  readonly action: "transfer";
  readonly sourceTreasuryAccountId: string;
  readonly destinationTreasuryAccountId: string;
}

export interface PayPayableCommand extends MoneyRequest {
  readonly action: "pay-payable";
  readonly treasuryAccountId: string;
  readonly paymentKind: PaymentKind;
  readonly payeeBusinessPartyId: string | null;
  readonly payeeName: string | null;
  readonly payableLedgerAccountId: string;
}

export type MoneyCommand = ReceiveCashCommand | TransferCommand | PayPayableCommand;

export interface MoneyResult {
  readonly movementId: string;
  readonly journalId: string;
  readonly reference: string;
  /** 0051: the native amount and currency, and the accounting amount posted. */
  readonly currencyCode?: string;
  readonly amount?: string;
  readonly baseAmount?: string;
  readonly fxConversionId?: string | null;
  readonly status: "POSTED";
  readonly replayed: boolean;
}

export const MONEY_PERMISSIONS = ["treasury.receipt.record", "treasury.transfer.record", "treasury.payment.record"] as const;
