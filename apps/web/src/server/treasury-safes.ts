import { randomUUID } from "node:crypto";

import type { SafeOpeningBalanceResult, SafesCommand, SafesWorkspace } from "@abos/contracts";
import { IdentityError } from "@abos/identity";

import { financeHandoffRuntime } from "@/server/finance-handoff";
import { assertMutation, readBody, sessionToken } from "@/server/identity";
import { operationalFinanceErrorResponse, restrictedFinanceAuthenticator } from "@/server/operational-finance";
import { fxRefusal } from "@/server/fx-refusals";

/**
 * Safes (migrations 0045/0046) through the restricted Finance runtime only. PostgreSQL derives the
 * actor and company from the password session, checks authority, derives every balance from posted
 * movements and posts an opening balance through the posting kernel. The browser sends business
 * fields only; there is no balance it could send.
 */

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-ABOS-Data": "operational" } });
}

export async function safesWorkspace(): Promise<SafesWorkspace> {
  return restrictedFinanceAuthenticator().safesWorkspace(financeHandoffRuntime().executor, await sessionToken());
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Builds exactly one known command from a request body; unknown actions are refused before any database call. */
export function safesCommand(body: Record<string, unknown>): SafesCommand {
  const text = (name: string) => (typeof body[name] === "string" ? (body[name] as string).trim() : "");
  const nullable = (name: string) => (text(name) === "" ? null : text(name));
  const id = (name: string) => {
    const value = text(name);
    if (!UUID.test(value)) throw new IdentityError("VALIDATION_FAILED", "Choose a Safe.");
    return value;
  };
  switch (text("action")) {
    case "record-opening-balance":
      return { action: "record-opening-balance", treasuryAccountId: id("treasuryAccountId"), amount: text("amount"),
        currencyCode: text("currencyCode"), asOfDate: text("asOfDate"), reference: nullable("reference"), note: nullable("note"),
        exchangeRateId: UUID.test(text("exchangeRateId")) ? text("exchangeRateId") : null,
        // The browser keeps one request identity per filled-in form, so a retry replays instead of doubling.
        idempotencyKey: nullable("idempotencyKey") ?? `opening-${randomUUID()}`,
        correlationId: UUID.test(text("correlationId")) ? text("correlationId") : randomUUID() };
    case "set-responsibles": {
      const users = Array.isArray(body.userAccountIds) ? body.userAccountIds : null;
      if (users === null || users.some((user) => typeof user !== "string" || !UUID.test(user))) {
        throw new IdentityError("VALIDATION_FAILED", "Choose the responsible people from the list.");
      }
      return { action: "set-responsibles", treasuryAccountId: id("treasuryAccountId"), userAccountIds: users as string[] };
    }
    default:
      throw new IdentityError("VALIDATION_FAILED", "Unknown Safe action.");
  }
}

export async function safesGet(): Promise<Response> {
  try {
    return json({ ok: true, data: await safesWorkspace() });
  } catch (error) { return safesErrorResponse(error); }
}

export async function safesPost(request: Request): Promise<Response> {
  try {
    assertMutation(request);
    const command = safesCommand(await readBody(request));
    const token = await sessionToken();
    const executor = financeHandoffRuntime().executor;
    const authenticator = restrictedFinanceAuthenticator();
    // Read authority is checked before the mutation: a permitted writer must not post an opening balance
    // and then fail only because it cannot read the resulting Safe.
    await authenticator.safesWorkspace(executor, token);
    const result = await authenticator.safesCommand(executor, token, command);
    if (command.action === "set-responsibles") return json({ ok: true, data: { workspace: result as SafesWorkspace } });
    const posted = result as SafeOpeningBalanceResult;
    const workspace = await authenticator.safesWorkspace(executor, token);
    return json({ ok: true, data: { ...posted, workspace } }, posted.replayed ? 200 : 201);
  } catch (error) { return safesErrorResponse(error); }
}

/** Refusals written by 0045/0046, translated to stable codes; the page shows them in English or Dari. */
const SAFE_REFUSALS: readonly { readonly pattern: RegExp; readonly status: number; readonly code: string; readonly message: string }[] = [
  { pattern: /already has an opening balance/i, status: 409, code: "OPENING_EXISTS",
    message: "This Safe already has an opening balance. A posted opening balance is corrected by reversal, never edited." },
  { pattern: /opening balance equity is not set up/i, status: 422, code: "OPENING_EQUITY_MISSING",
    message: "Create one active Equity account with the control \"Opening balance equity\" in the Chart of Accounts first." },
  { pattern: /opening balance equity is ambiguous/i, status: 422, code: "OPENING_EQUITY_AMBIGUOUS",
    message: "More than one active account is marked \"Opening balance equity\". Keep exactly one." },
  { pattern: /opening balance equity account must be/i, status: 422, code: "OPENING_EQUITY_INVALID",
    message: "The \"Opening balance equity\" account must be an Equity account that accepts postings in the accounting currency." },
  { pattern: /cannot be dated after today/i, status: 422, code: "DATE_IN_FUTURE", message: "The as-of date cannot be after today." },
  { pattern: /must be in the Safe currency/i, status: 422, code: "CURRENCY_MISMATCH", message: "The opening balance must be in the Safe's currency." },
  { pattern: /other than the approved accounting currency/i, status: 422, code: "FOREIGN_CURRENCY_NOT_AVAILABLE",
    message: "Opening balances are available for Safes in the company's accounting currency for now." },
  { pattern: /needs an active Safe/i, status: 422, code: "SAFE_NOT_ACTIVE", message: "Only an active Safe can receive an opening balance." },
  { pattern: /Safe was not found/i, status: 404, code: "SAFE_NOT_FOUND", message: "That Safe is not available for your company." },
  { pattern: /no accounting period covers/i, status: 422, code: "PERIOD_MISSING",
    message: "No month in your financial year covers this date. Generate the financial year first." },
  { pattern: /financial year covering .* is closed|cannot be reopened automatically/i, status: 422, code: "PERIOD_CLOSED",
    message: "The financial year of this date is closed. Choose a date in an active financial year." },
  { pattern: /idempotency key was already used/i, status: 409, code: "ALREADY_SUBMITTED_DIFFERENTLY",
    message: "This form was already submitted with different details. Start again." },
  { pattern: /responsible person must be an active user/i, status: 422, code: "USER_NOT_AVAILABLE",
    message: "Choose active people of this company." },
  { pattern: /plain positive decimals|positive amount|amount/i, status: 422, code: "INVALID_AMOUNT",
    message: "Enter a positive amount such as 2500 or 2500.50." },
  { pattern: /are required|unknown opening balance fields|choose a Safe and its responsible people/i, status: 422, code: "VALIDATION_FAILED",
    message: "Some details are missing or not valid." }
];

export function safesErrorResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : "";
  const sqlState = error !== null && typeof error === "object" && "code" in error ? String((error as { readonly code: unknown }).code) : "";
  // Authority and session failures go through the shared translation; their texts never reach people verbatim.
  if (sqlState === "42501") return operationalFinanceErrorResponse(error);
  const known = message === "" ? undefined : fxRefusal(error) ?? SAFE_REFUSALS.find((refusal) => refusal.pattern.test(message));
  if (known !== undefined) return json({ ok: false, error: { code: known.code, message: known.message } }, known.status);
  return operationalFinanceErrorResponse(error);
}
