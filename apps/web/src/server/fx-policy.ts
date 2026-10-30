import { randomUUID } from "node:crypto";

import type { FxPolicyCommand, FxRoundingMode } from "@abos/contracts";
import { IdentityError } from "@abos/identity";

import { financeHandoffRuntime } from "@/server/finance-handoff";
import { assertMutation, readBody, sessionToken } from "@/server/identity";
import { fxRefusal } from "@/server/fx-refusals";
import { operationalFinanceErrorResponse, restrictedFinanceAuthenticator } from "@/server/operational-finance";

/**
 * The FX policy per currency and the conversion preview (migration 0051), through the restricted Finance runtime
 * only. PostgreSQL derives actor and company from the password session and checks the permission; every
 * foreign-currency movement converts in the database, never here.
 */

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-ABOS-Data": "operational" } });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const AMOUNT = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;

const POLICY_REFUSALS: readonly { readonly pattern: RegExp; readonly status: number; readonly code: string; readonly message: string }[] = [
  { pattern: /changed by someone else; reload/i, status: 409, code: "STALE_VERSION", message: "The FX policy changed in the meantime. Reload and try again." },
  { pattern: /write the reason/i, status: 422, code: "REASON_REQUIRED", message: "Write the reason for this FX policy (5 to 500 characters)." },
  { pattern: /choose an active income or expense account .* FX_DIFFERENCE/i, status: 422, code: "FX_ACCOUNT_REQUIRED",
    message: "Choose an active income or expense account in the accounting currency with the control “FX difference”." },
  { pattern: /scale must be 0 to 6/i, status: 422, code: "VALIDATION_FAILED", message: "The scale must be 0 to 6 decimal places." },
  { pattern: /an FX policy is saved for an enabled currency/i, status: 422, code: "CURRENCY_NOT_AVAILABLE",
    message: "An FX policy is saved for an enabled currency other than the accounting currency." },
  { pattern: /unknown FX policy fields|choose a valid|choose the rounding mode/i, status: 422, code: "VALIDATION_FAILED",
    message: "Some details are missing or not valid." }
];

/** Builds the one FX policy command from a request body; anything malformed is refused before any database call. */
export function fxPolicyCommand(body: Record<string, unknown>): FxPolicyCommand {
  const text = (name: string) => (typeof body[name] === "string" ? (body[name] as string).trim() : "");
  const mode = text("roundingMode") as FxRoundingMode;
  const scale = body.baseScale; const expected = body.expectedVersion;
  if (!/^[A-Z]{3}$/.test(text("currencyCode")) || !DAY.test(text("effectiveFrom")) || (mode !== "HALF_UP" && mode !== "EXACT_ONLY")
      || typeof scale !== "number" || !Number.isInteger(scale) || scale < 0 || scale > 6
      || typeof expected !== "number" || !Number.isInteger(expected) || expected < 0 || !UUID.test(text("fxDifferenceLedgerAccountId"))) {
    throw new IdentityError("VALIDATION_FAILED", "Some details are missing or not valid.");
  }
  return { currencyCode: text("currencyCode"), effectiveFrom: text("effectiveFrom"), baseScale: scale, roundingMode: mode,
    fxDifferenceLedgerAccountId: text("fxDifferenceLedgerAccountId"), reason: text("reason"), expectedVersion: expected,
    correlationId: UUID.test(text("correlationId")) ? text("correlationId") : randomUUID() };
}

export function fxErrorResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : "";
  const sqlState = error !== null && typeof error === "object" && "code" in error ? String((error as { readonly code: unknown }).code) : "";
  if (sqlState === "42501") return operationalFinanceErrorResponse(error);
  const known = fxRefusal(error) ?? (message === "" || error instanceof IdentityError ? undefined : POLICY_REFUSALS.find((refusal) => refusal.pattern.test(message)));
  if (known !== undefined) return json({ ok: false, error: { code: known.code, message: known.message } }, known.status);
  return operationalFinanceErrorResponse(error);
}

export async function fxPolicyGet(): Promise<Response> {
  try {
    return json({ ok: true, data: await restrictedFinanceAuthenticator().fxPolicyWorkspace(financeHandoffRuntime().executor, await sessionToken()) });
  } catch (error) { return fxErrorResponse(error); }
}

export async function fxPolicyPost(request: Request): Promise<Response> {
  try {
    assertMutation(request);
    const token = await sessionToken();
    const result = await restrictedFinanceAuthenticator().fxPolicySet(financeHandoffRuntime().executor, token, fxPolicyCommand(await readBody(request)));
    return json({ ok: true, data: { result, workspace: await restrictedFinanceAuthenticator().fxPolicyWorkspace(financeHandoffRuntime().executor, token) } }, 201);
  } catch (error) { return fxErrorResponse(error); }
}

/** GET ?currencyCode=AFN&businessDate=2026-10-29[&amount=7000][&exchangeRateId=…]: rates and the accounting amount; writes nothing. */
export async function fxPreviewGet(request: Request): Promise<Response> {
  try {
    const query = new URL(request.url).searchParams;
    const currencyCode = query.get("currencyCode") ?? ""; const businessDate = query.get("businessDate") ?? "";
    const amount = query.get("amount"); const exchangeRateId = query.get("exchangeRateId");
    if (!/^[A-Z]{3}$/.test(currencyCode) || !DAY.test(businessDate) || (amount !== null && amount !== "" && !AMOUNT.test(amount))
        || (exchangeRateId !== null && exchangeRateId !== "" && !UUID.test(exchangeRateId))) {
      throw new IdentityError("VALIDATION_FAILED", "Some details are missing or not valid.");
    }
    return json({ ok: true, data: await restrictedFinanceAuthenticator().fxPreview(financeHandoffRuntime().executor, await sessionToken(),
      { currencyCode, businessDate, amount: amount || null, exchangeRateId: exchangeRateId || null }) });
  } catch (error) { return fxErrorResponse(error); }
}
