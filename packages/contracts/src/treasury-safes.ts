/**
 * Safes (migrations 0045 and 0046): one canonical Treasury account model whose balances are always
 * derived from posted movements, and an opening balance that is a real posting (Dr the Safe, Cr
 * opening balance equity). Amounts are exact decimal strings; nothing here is ever a stored balance.
 */

export type SafeAccountType = "SAFE" | "CASH_BOX" | "PETTY_CASH" | "BANK" | "SARAF" | "OTHER";
export type SafeStatus = "ACTIVE" | "INACTIVE" | "CLOSED";
export type OpeningEquityStatus = "READY" | "MISSING" | "AMBIGUOUS" | "INVALID";

export interface SafeBalance {
  /** Movements recorded by the opening-balance source. */
  readonly opening: string;
  /** Other money in, as a positive figure. */
  readonly inflows: string;
  /** Other money out, as a positive figure. */
  readonly outflows: string;
  /** opening + inflows - outflows: the sum of every posted movement of the Safe. */
  readonly book: string;
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
  readonly status: "POSTED";
  readonly replayed: boolean;
}

export const SAFE_PERMISSIONS = ["treasury.safe.read", "treasury.opening-balance.record"] as const;
