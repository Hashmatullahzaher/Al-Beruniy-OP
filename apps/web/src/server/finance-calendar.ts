import { IdentityError } from "@abos/identity";

import { financeHandoffRuntime, financeToken } from "@/server/finance-handoff";
import { errorResponse, json } from "@/server/treasury";

/**
 * Financial calendar through the restricted Finance login only (migration 0012). The session token
 * is the only identity passed to the database; every rule is enforced there.
 */

export type CalendarKind = "SOLAR_HIJRI" | "GREGORIAN" | "CUSTOM";

export interface CalendarPeriodView { readonly sequence: number; readonly nameEn: string; readonly nameFa: string; readonly startsOn: string; readonly endsOn: string; readonly status: string }
export interface FiscalYearView {
  readonly id: string; readonly calendarKind: CalendarKind; readonly fiscalYear: number; readonly labelEn: string; readonly labelFa: string;
  readonly startsOn: string; readonly endsOn: string; readonly generatedAt: string; readonly periods: readonly CalendarPeriodView[];
}
export interface FinanceCalendarView {
  readonly canManage: boolean;
  readonly legalEntity: { readonly id: string; readonly name: string; readonly baseCurrency: string | null };
  readonly settings: {
    readonly calendarKind: CalendarKind; readonly customStartMonth: number | null; readonly customStartDay: number | null;
    readonly reportingCalendars: readonly ("SOLAR_HIJRI" | "GREGORIAN")[]; readonly version: number; readonly updatedAt: string; readonly updatedBy: string | null;
  } | null;
  readonly fiscalYears: readonly FiscalYearView[];
  readonly otherPeriods: readonly { readonly name: string; readonly startsOn: string; readonly endsOn: string; readonly status: string }[];
}

export async function calendarView(): Promise<FinanceCalendarView> {
  const token = await financeToken();
  const result = await financeHandoffRuntime().executor.query<{ value: FinanceCalendarView }>("SELECT abos.finance_calendar_view($1) AS value", [token]);
  const value = result.rows[0]?.value;
  if (value === undefined) throw new Error("The calendar function returned no result.");
  return value;
}

export async function configureCalendar(input: {
  readonly calendarKind: string; readonly customStartMonth: number | null; readonly customStartDay: number | null;
  readonly reportingCalendars: readonly string[]; readonly expectedVersion: number;
}): Promise<number> {
  const token = await financeToken();
  const result = await financeHandoffRuntime().executor.query<{ version: number }>(
    "SELECT abos.finance_calendar_configure($1, $2, $3, $4, $5::text[], $6) AS version",
    [token, input.calendarKind, input.customStartMonth, input.customStartDay, [...input.reportingCalendars], input.expectedVersion]);
  return result.rows[0]?.version ?? 0;
}

export async function generateFiscalYear(fiscalYear: number): Promise<string> {
  const token = await financeToken();
  const result = await financeHandoffRuntime().executor.query<{ id: string }>(
    "SELECT abos.finance_generate_fiscal_year($1, $2) AS id", [token, fiscalYear]);
  return result.rows[0]?.id ?? "";
}

/** Database refusals are reported as readable conflicts; a missing grant is a 403. */
export function calendarErrorResponse(error: unknown) {
  if (error instanceof IdentityError) {
    return json({ ok: false, error: { code: error.code, message: error.message } }, error.code === "VALIDATION_FAILED" ? 415 : 400);
  }
  const code = error !== null && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
  const message = error instanceof Error ? error.message : "";
  if (code === "42501" && /session is invalid|authorization is not active|bearer credential/.test(message)) {
    return json({ ok: false, error: { code: "AUTHENTICATION_REQUIRED", message: "Your session has ended. Sign in again." } }, 401);
  }
  if (code === "42501" && /authority is missing/.test(message)) {
    return json({ ok: false, error: { code: "PERMISSION_DENIED", message: "You do not have permission to manage the financial calendar." } }, 403);
  }
  if (code === "40001") return json({ ok: false, error: { code: "STALE_VERSION", message } }, 409);
  if (code === "23P01") return json({ ok: false, error: { code: "PERIOD_OVERLAP", message } }, 409);
  if (code === "22000" || code === "22023" || code === "22008") return json({ ok: false, error: { code: "VALIDATION_FAILED", message } }, 422);
  return errorResponse(error);
}
