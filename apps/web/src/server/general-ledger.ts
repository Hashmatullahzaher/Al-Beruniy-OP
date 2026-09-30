import { financeHandoffRuntime, financeToken } from "@/server/finance-handoff";
import { errorResponse, json } from "@/server/treasury";

/** Read-only posted activity through the restricted Finance database credential. */
export interface GeneralLedgerLine {
  readonly journalId: string;
  readonly journalReference: string;
  readonly lineNumber: number;
  readonly accountId: string;
  readonly accountCode: string;
  readonly accountName: string;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly accountingPeriodId: string;
  readonly accountingEffectiveDate: string;
  readonly postedAt: string;
  readonly originalCurrency: string | null;
  readonly originalAmount: string | null;
  readonly baseCurrency: string;
  readonly baseDebit: string;
  readonly baseCredit: string;
}

export interface GeneralLedgerTotal {
  readonly currency: string;
  readonly debits: string;
  readonly credits: string;
  readonly lineCount: string;
}

/**
 * One page of posted lines in the fixed order (accounting date DESC, posted at DESC, journal DESC,
 * line number ASC). `nextCursor` is an opaque position for the following page, or null at the end.
 * `totals` covers the whole filtered range and is present on the first page only (null afterwards).
 */
export interface GeneralLedgerView {
  readonly syntheticOnly: false;
  readonly legalEntityId: string;
  readonly from: string;
  readonly to: string;
  readonly accountId: string | null;
  readonly order: string;
  readonly pageLimit: number;
  readonly returnedLineCount: number;
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
  readonly lines: readonly GeneralLedgerLine[];
  readonly totals: readonly GeneralLedgerTotal[] | null;
}

export interface AccountActivityAmounts {
  readonly debitTotal: string;
  readonly creditTotal: string;
  /** Debit total minus credit total within the range. Not a balance. */
  readonly net: string;
  readonly lineCount: string;
}

/** Posted activity of one ledger account in one base currency within the selected range. */
export interface AccountActivityRow extends AccountActivityAmounts {
  readonly accountId: string;
  readonly accountCode: string;
  readonly accountName: string;
  readonly baseCurrency: string;
  /** Original-currency amounts of the same lines, grouped by original currency, never converted. */
  readonly originalCurrencies: readonly (AccountActivityAmounts & { readonly currency: string })[];
}

/**
 * Posted debit/credit activity per account inside [from, to]. It is not a balance: opening balances
 * are not imported yet (#18) and no period is closed, so `isBalance` is always false.
 */
export interface GeneralLedgerActivityView {
  readonly syntheticOnly: false;
  readonly legalEntityId: string;
  readonly from: string;
  readonly to: string;
  readonly accountId: string | null;
  readonly basis: "POSTED_ACTIVITY_IN_RANGE";
  readonly isBalance: false;
  readonly openingBalancesIncluded: false;
  readonly accounts: readonly AccountActivityRow[];
  readonly currencyTotals: readonly (AccountActivityAmounts & { readonly baseCurrency: string; readonly accountCount: string })[];
}

async function financeJson<T>(sql: string, parameters: readonly unknown[], what: string): Promise<T> {
  const result = await financeHandoffRuntime().executor.query<{ readonly value: T }>(sql, parameters);
  const value = result.rows[0]?.value;
  if (!value) throw new Error(`The ${what} function returned no result.`);
  return value;
}

export async function generalLedgerView(
  from: string, to: string, accountId: string | null, cursor: string | null = null, pageSize = 100
): Promise<GeneralLedgerView> {
  const token = await financeToken();
  return financeJson<GeneralLedgerView>(
    "SELECT abos.finance_general_ledger_page($1, $2::date, $3::date, $4::uuid, $5, $6::integer) AS value",
    [token, from, to, accountId, cursor, pageSize], "General Ledger");
}

export async function generalLedgerActivity(from: string, to: string, accountId: string | null): Promise<GeneralLedgerActivityView> {
  const token = await financeToken();
  return financeJson<GeneralLedgerActivityView>(
    "SELECT abos.finance_general_ledger_activity($1, $2::date, $3::date, $4::uuid) AS value",
    [token, from, to, accountId], "General Ledger activity");
}

// ---- Request validation and error mapping shared by the General Ledger routes ----------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURSOR = /^[A-Za-z0-9_-]{1,400}$/;
const PAGE_SIZE = /^(?:[1-9]\d?|100)$/;

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export interface LedgerQuery {
  readonly from: string;
  readonly to: string;
  readonly accountId: string | null;
  readonly cursor: string | null;
  readonly pageSize: number;
}

/** Strict query parsing; returns null when any parameter is malformed. */
export function parseLedgerQuery(params: URLSearchParams, paging: boolean): LedgerQuery | null {
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";
  const accountId = params.get("accountId")?.trim() || null;
  if (!validDate(from) || !validDate(to) || from > to || (accountId !== null && !UUID.test(accountId))) return null;
  const rawCursor = params.get("cursor");
  const rawPageSize = params.get("pageSize");
  if (!paging) return rawCursor === null && rawPageSize === null ? { from, to, accountId, cursor: null, pageSize: 100 } : null;
  if (rawCursor !== null && !CURSOR.test(rawCursor)) return null;
  if (rawPageSize !== null && !PAGE_SIZE.test(rawPageSize)) return null;
  return { from, to, accountId, cursor: rawCursor, pageSize: rawPageSize === null ? 100 : Number.parseInt(rawPageSize, 10) };
}

export function ledgerValidationFailed() {
  return json({ ok: false, error: { code: "VALIDATION_FAILED", message: "Choose a valid inclusive date range and account." } }, 422);
}

export function ledgerErrorResponse(error: unknown) {
  const code = error !== null && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
  const message = error instanceof Error ? error.message : "";
  if (code === "42501") {
    const expired = /session is invalid|authorization is not active|bearer credential/i.test(message);
    return json({ ok: false, error: { code: expired ? "AUTHENTICATION_REQUIRED" : "PERMISSION_DENIED", message: expired ? "Your session has ended. Sign in again." : "General Ledger access is not available for this identity or legal entity." } }, expired ? 401 : 403);
  }
  if (code === "22023") {
    return json({ ok: false, error: { code: "VALIDATION_FAILED", message: "The requested page position or range is not valid. Start again from the first page." } }, 422);
  }
  return errorResponse(error);
}
