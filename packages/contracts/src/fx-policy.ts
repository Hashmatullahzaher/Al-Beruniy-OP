/**
 * Slice 6 (migration 0051): the FX policy per company and currency, and the conversion every foreign-currency
 * movement uses. Amounts and rates are exact decimal strings; nothing here is ever a floating-point number.
 */

export type FxRoundingMode = "HALF_UP" | "EXACT_ONLY";

/** The policy in force for a currency on a day: a saved version, or the default (HALF_UP, 2 decimal places). */
export interface FxPolicyInForce {
  readonly versionId: string | null;
  readonly version: number;
  readonly effectiveFrom: string | null;
  readonly roundingMode: FxRoundingMode;
  readonly baseScale: number;
  readonly fxDifferenceAccountId: string;
  readonly isDefault: boolean;
}

/** SETUP_REQUIRED: no usable FX difference account, so the currency cannot post yet; message says what to do. */
export interface FxSetupView {
  readonly currencyCode: string;
  readonly status: "READY" | "SETUP_REQUIRED";
  readonly policy?: FxPolicyInForce;
  readonly fxDifferenceAccount?: { readonly id: string; readonly code: string; readonly name: string } | null;
  readonly message?: string;
}

export interface FxPolicyVersionView {
  readonly id: string;
  readonly version: number;
  readonly effectiveFrom: string;
  readonly roundingMode: FxRoundingMode;
  readonly baseScale: number;
  readonly reason: string;
  readonly createdAt: string;
  readonly createdBy: string | null;
  readonly fxDifferenceAccount: { readonly id: string; readonly code: string; readonly name: string } | null;
}

export interface FxPolicyWorkspace {
  readonly today: string;
  readonly baseCurrency: string | null;
  readonly canManage: boolean;
  readonly defaultPolicy: { readonly roundingMode: FxRoundingMode; readonly baseScale: number };
  readonly fxDifference: { readonly status: "READY" | "MISSING" | "AMBIGUOUS" | "INVALID"; readonly count: number;
    readonly account?: { readonly id: string; readonly code: string; readonly name: string; readonly currency: string | null } };
  readonly fxDifferenceAccounts: readonly { readonly id: string; readonly code: string; readonly name: string; readonly accountType: string;
    readonly currency: string | null; readonly ready: boolean }[];
  readonly currencies: readonly { readonly currencyCode: string; readonly name: string; readonly current: FxSetupView;
    readonly versions: readonly FxPolicyVersionView[] }[];
}

export interface FxPolicyCommand {
  readonly currencyCode: string;
  readonly effectiveFrom: string;
  readonly baseScale: number;
  readonly roundingMode: FxRoundingMode;
  readonly fxDifferenceLedgerAccountId: string;
  readonly reason: string;
  /** The latest version the screen showed (0 when none); a stale screen is refused. */
  readonly expectedVersion: number;
  readonly correlationId: string;
}

export interface FxPolicyResult {
  readonly versionId: string;
  readonly currencyCode: string;
  readonly version: number;
  readonly effectiveFrom: string;
  readonly baseScale: number;
  readonly roundingMode: FxRoundingMode;
  readonly status: "SAVED";
}

/** Before saving a foreign-currency movement: the day's current rates and the accounting amount it would post. */
export interface FxPreview {
  readonly currencyCode: string;
  readonly baseCurrency: string;
  readonly businessDate: string;
  readonly setup: FxSetupView | null;
  readonly rates: readonly { readonly id: string; readonly source: "MARKET" | "SARAF"; readonly sarafName: string | null;
    readonly unitCurrency: string; readonly quoteCurrency: string; readonly rate: string }[];
  readonly preview: { readonly exact: string; readonly base: string; readonly difference: string; readonly exchangeRateId: string }
    | { readonly error: string } | null;
}

export const FX_POLICY_PERMISSIONS = ["finance.fx-policy.manage"] as const;
