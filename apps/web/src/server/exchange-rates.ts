import { IdentityError } from "@abos/identity";

import { financeHandoffRuntime, financeToken } from "@/server/finance-handoff";
import { errorResponse, json } from "@/server/treasury";

/**
 * Daily exchange rates through the restricted Finance login only (migration 0016). The session token
 * is the only identity passed to the database; every rule is enforced there. Rates cross the API as
 * decimal strings, exactly as entered, and are never converted here.
 */

export type RateSource = "MARKET" | "SARAF";

export interface ExchangeRateView {
  readonly id: string; readonly rateDate: string; readonly source: RateSource;
  readonly sarafPartyId: string | null; readonly sarafName: string | null;
  readonly unitCurrency: string; readonly quoteCurrency: string; readonly rate: string; readonly note: string | null;
  readonly supersedesId: string | null; readonly supersededById: string | null; readonly correctionReason: string | null;
  readonly current: boolean; readonly enteredBy: string | null; readonly enteredAt: string; readonly snapshotCount: number;
}

export interface ExchangeRatesWorkspaceView {
  readonly canRecord: boolean;
  readonly today: string;
  readonly range: { readonly from: string; readonly to: string };
  readonly legalEntity: { readonly id: string; readonly name: string; readonly baseCurrency: string | null };
  readonly currencies: readonly string[];
  readonly sarafParties: readonly { readonly id: string; readonly name: string }[];
  readonly rates: readonly ExchangeRateView[];
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function dateOrNull(value: string | null): string | null {
  return value !== null && DATE.test(value) ? value : null;
}

export async function exchangeRatesView(from: string | null, to: string | null): Promise<ExchangeRatesWorkspaceView> {
  const token = await financeToken();
  const result = await financeHandoffRuntime().executor.query<{ value: ExchangeRatesWorkspaceView }>(
    "SELECT abos.finance_exchange_rates_view($1, $2::date, $3::date) AS value", [token, dateOrNull(from), dateOrNull(to)]);
  const value = result.rows[0]?.value;
  if (value === undefined) throw new Error("The exchange-rate function returned no result.");
  return value;
}

export async function recordExchangeRate(input: {
  readonly rateDate: string; readonly source: string; readonly sarafPartyId: string | null;
  readonly unitCurrency: string; readonly quoteCurrency: string; readonly rate: string; readonly note: string | null;
}): Promise<string> {
  const token = await financeToken();
  const result = await financeHandoffRuntime().executor.query<{ id: string }>(
    "SELECT abos.finance_record_exchange_rate($1, $2::date, $3, $4::uuid, $5, $6, $7, $8) AS id",
    [token, DATE.test(input.rateDate) ? input.rateDate : null, input.source,
      input.sarafPartyId !== null && /^[0-9a-f-]{36}$/i.test(input.sarafPartyId) ? input.sarafPartyId : null, input.unitCurrency, input.quoteCurrency, input.rate, input.note]);
  return result.rows[0]?.id ?? "";
}

export async function correctExchangeRate(rateId: string, rate: string, reason: string): Promise<string> {
  const token = await financeToken();
  const result = await financeHandoffRuntime().executor.query<{ id: string }>(
    "SELECT abos.finance_correct_exchange_rate($1, $2::uuid, $3, $4) AS id",
    [token, /^[0-9a-f-]{36}$/i.test(rateId) ? rateId : null, rate, reason]);
  return result.rows[0]?.id ?? "";
}

/**
 * Database refusals become readable responses. Shared with the shareholder requests, which call
 * restricted functions the same way.
 */
export function currencyErrorResponse(error: unknown, deniedMessage: string) {
  if (error instanceof IdentityError) {
    return json({ ok: false, error: { code: error.code, message: error.message } }, error.code === "VALIDATION_FAILED" ? 422 : 400);
  }
  const code = error !== null && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
  const message = error instanceof Error ? error.message : "";
  if (code === "42501" && /session is invalid|authorization is not active|bearer credential/.test(message)) {
    return json({ ok: false, error: { code: "AUTHENTICATION_REQUIRED", message: "Your session has ended. Sign in again." } }, 401);
  }
  if (code === "42501" && /authority is missing/.test(message)) {
    return json({ ok: false, error: { code: "PERMISSION_DENIED", message: deniedMessage } }, 403);
  }
  if (code === "P0002") return json({ ok: false, error: { code: "RATE_MISSING", message } }, 422);
  if (code === "P0003") return json({ ok: false, error: { code: "RATE_AMBIGUOUS", message } }, 409);
  if (code === "23505") return json({ ok: false, error: { code: "ALREADY_EXISTS", message } }, 409);
  if (code === "23514" || code === "42501") return json({ ok: false, error: { code: "REFUSED_BY_DATABASE", message } }, 422);
  if (code === "22P02" || code === "22007" || code === "22008") {
    return json({ ok: false, error: { code: "REFUSED_BY_DATABASE", message: "A value in the request is not valid." } }, 422);
  }
  return errorResponse(error);
}
