import type { AccountStatementView, TreasuryStatementView, TrialBalanceView } from "@abos/contracts";
import { IdentityError } from "@abos/identity";

import { financeHandoffRuntime } from "@/server/finance-handoff";
import { sessionToken } from "@/server/identity";
import { operationalFinanceErrorResponse, restrictedFinanceAuthenticator } from "@/server/operational-finance";

/**
 * The trial balance, account statements and journal detail (migration 0053) through the restricted Finance runtime
 * only. Every figure is computed in PostgreSQL from posted journals; this layer only validates the query.
 */

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-ABOS-Data": "operational" } });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Exactly one of periodId, fiscalYearId, from + to, or asOf, taken from the query string; the database enforces the same rule. */
export function reportRange(query: URLSearchParams): Record<string, string> {
  const periodId = query.get("periodId"); const from = query.get("from"); const to = query.get("to"); const asOf = query.get("asOf"); const fiscalYearId = query.get("fiscalYearId");
  const modes = [periodId, from ?? to, asOf, fiscalYearId].filter((value) => value !== null && value !== "").length;
  if (modes !== 1) throw new IdentityError("VALIDATION_FAILED", "Choose a period, a date range or an as-of date.");
  if (periodId) {
    if (!UUID.test(periodId)) throw new IdentityError("VALIDATION_FAILED", "Choose a valid period.");
    return { periodId };
  }
  if (fiscalYearId) {
    if (!UUID.test(fiscalYearId)) throw new IdentityError("VALIDATION_FAILED", "Choose a valid financial year.");
    return { fiscalYearId };
  }
  if (asOf) {
    if (!DAY.test(asOf)) throw new IdentityError("VALIDATION_FAILED", "Choose a valid date.");
    return { asOf };
  }
  if (!from || !to || !DAY.test(from) || !DAY.test(to) || from > to) throw new IdentityError("VALIDATION_FAILED", "Choose valid dates.");
  return { from, to };
}

const REFUSALS: readonly { readonly pattern: RegExp; readonly status: number; readonly code: string; readonly message: string }[] = [
  { pattern: /choose one: a period, a date range or an as-of date|choose a valid period or valid dates|choose a valid account|unknown report fields/i,
    status: 422, code: "VALIDATION_FAILED", message: "Choose a period, a date range or an as-of date." },
  { pattern: /choose a valid account/i, status: 422, code: "VALIDATION_FAILED", message: "Choose an account." },
  { pattern: /choose a valid shareholder/i, status: 422, code: "VALIDATION_FAILED", message: "Choose a shareholder." },
  { pattern: /was not found in this legal entity/i, status: 404, code: "NOT_FOUND", message: "That is not available for your company." },
  { pattern: /choose a shorter period/i, status: 422, code: "TOO_MANY_LINES", message: "This statement is too long. Choose a shorter period." }
];

export function reportingErrorResponse(error: unknown): Response {
  const message = error instanceof Error && !(error instanceof IdentityError) ? error.message : "";
  const sqlState = error !== null && typeof error === "object" && "code" in error ? String((error as { readonly code: unknown }).code) : "";
  const known = message === "" || sqlState === "42501" ? undefined : REFUSALS.find((refusal) => refusal.pattern.test(message));
  if (known !== undefined) return json({ ok: false, error: { code: known.code, message: known.message } }, known.status);
  return operationalFinanceErrorResponse(error);
}

// The screens and the exports read through these same functions, so an export is always the payload the screen received for the same query.

export async function trialBalanceData(query: URLSearchParams): Promise<TrialBalanceView> {
  const payload: Record<string, unknown> = reportRange(query);
  if (query.get("includeZero") === "true") payload.includeZero = true;
  return restrictedFinanceAuthenticator().trialBalance(financeHandoffRuntime().executor, await sessionToken(), payload);
}

export async function accountStatementData(query: URLSearchParams): Promise<AccountStatementView> {
  const accountId = query.get("accountId") ?? "";
  if (!UUID.test(accountId)) throw new IdentityError("VALIDATION_FAILED", "Choose an account.");
  return restrictedFinanceAuthenticator().accountStatement(financeHandoffRuntime().executor, await sessionToken(), { accountId, ...reportRange(query) });
}

export async function safeStatementData(query: URLSearchParams): Promise<TreasuryStatementView> {
  const accountId = query.get("accountId");
  if (accountId !== null && !UUID.test(accountId)) throw new IdentityError("VALIDATION_FAILED", "Choose an account.");
  return restrictedFinanceAuthenticator().treasuryStatement(financeHandoffRuntime().executor, await sessionToken(),
    accountId === null ? {} : { accountId, ...reportRange(query) });
}

export async function trialBalanceGet(request: Request): Promise<Response> {
  try { return json({ ok: true, data: await trialBalanceData(new URL(request.url).searchParams) }); } catch (error) { return reportingErrorResponse(error); }
}

export async function accountStatementGet(request: Request): Promise<Response> {
  try { return json({ ok: true, data: await accountStatementData(new URL(request.url).searchParams) }); } catch (error) { return reportingErrorResponse(error); }
}

export async function safeStatementGet(request: Request): Promise<Response> {
  try { return json({ ok: true, data: await safeStatementData(new URL(request.url).searchParams) }); } catch (error) { return reportingErrorResponse(error); }
}

export async function financialSummaryGet(request: Request): Promise<Response> {
  try {
    return json({ ok: true, data: await restrictedFinanceAuthenticator().managementSummary(financeHandoffRuntime().executor, await sessionToken(),
      reportRange(new URL(request.url).searchParams)) });
  } catch (error) { return reportingErrorResponse(error); }
}

export async function shareholderStatementGet(request: Request): Promise<Response> {
  try {
    const query = new URL(request.url).searchParams;
    const partyId = query.get("partyId");
    if (partyId !== null && !UUID.test(partyId)) throw new IdentityError("VALIDATION_FAILED", "Choose a shareholder.");
    return json({ ok: true, data: await restrictedFinanceAuthenticator().shareholderStatement(financeHandoffRuntime().executor, await sessionToken(),
      { ...(partyId === null ? {} : { partyId }), ...reportRange(query) }) });
  } catch (error) { return reportingErrorResponse(error); }
}

export async function incomeStatementGet(request: Request): Promise<Response> {
  try {
    return json({ ok: true, data: await restrictedFinanceAuthenticator().incomeStatement(financeHandoffRuntime().executor, await sessionToken(),
      reportRange(new URL(request.url).searchParams)) });
  } catch (error) { return reportingErrorResponse(error); }
}

export async function balanceSheetGet(request: Request): Promise<Response> {
  try {
    return json({ ok: true, data: await restrictedFinanceAuthenticator().balanceSheet(financeHandoffRuntime().executor, await sessionToken(),
      reportRange(new URL(request.url).searchParams)) });
  } catch (error) { return reportingErrorResponse(error); }
}

export async function journalDetailGet(journalId: string): Promise<Response> {
  try {
    if (!UUID.test(journalId)) throw new IdentityError("VALIDATION_FAILED", "Choose a journal.");
    return json({ ok: true, data: await restrictedFinanceAuthenticator().journalDetail(financeHandoffRuntime().executor, await sessionToken(), journalId) });
  } catch (error) { return reportingErrorResponse(error); }
}
