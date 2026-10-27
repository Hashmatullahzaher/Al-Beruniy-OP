import { randomUUID } from "node:crypto";

import { PAYMENT_KINDS, type MoneyCommand, type PaymentKind } from "@abos/contracts";
import { IdentityError } from "@abos/identity";

import { financeHandoffRuntime } from "@/server/finance-handoff";
import { assertMutation, readBody, sessionToken } from "@/server/identity";
import { operationalFinanceErrorResponse, restrictedFinanceAuthenticator } from "@/server/operational-finance";

/**
 * Receive cash, transfer and pay against a payable (migration 0047) through the restricted Finance runtime
 * only. PostgreSQL derives actor and company from the password session, checks the movement's permission
 * and approval setting, and posts through the posting kernel. Paying for an expense uses the expense API
 * with a payment kind (0048), not this route.
 */

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-ABOS-Data": "operational" } });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Builds exactly one known command from a request body; unknown actions are refused before any database call. */
export function moneyCommand(body: Record<string, unknown>): MoneyCommand {
  const text = (name: string) => (typeof body[name] === "string" ? (body[name] as string).trim() : "");
  const nullable = (name: string) => (text(name) === "" ? null : text(name));
  const id = (name: string, message: string) => {
    const value = text(name);
    if (!UUID.test(value)) throw new IdentityError("VALIDATION_FAILED", message);
    return value;
  };
  const optionalId = (name: string) => {
    const value = nullable(name);
    if (value !== null && !UUID.test(value)) throw new IdentityError("VALIDATION_FAILED", "Choose from the list.");
    return value;
  };
  const common = {
    amount: text("amount"), currencyCode: text("currencyCode"), businessDate: text("businessDate"),
    reference: nullable("reference"), note: nullable("note"),
    // The browser keeps one request identity per filled-in form, so a retry replays instead of doubling.
    idempotencyKey: nullable("idempotencyKey") ?? `money-${randomUUID()}`,
    correlationId: UUID.test(text("correlationId")) ? text("correlationId") : randomUUID()
  };
  switch (text("action")) {
    case "receive-cash":
      return { action: "receive-cash", ...common, treasuryAccountId: id("treasuryAccountId", "Choose the Safe."),
        payerBusinessPartyId: optionalId("payerBusinessPartyId"), payerName: nullable("payerName"),
        revenueLedgerAccountId: id("revenueLedgerAccountId", "Choose the income account.") };
    case "transfer":
      return { action: "transfer", ...common, sourceTreasuryAccountId: id("sourceTreasuryAccountId", "Choose where the money comes from."),
        destinationTreasuryAccountId: id("destinationTreasuryAccountId", "Choose where the money goes.") };
    case "pay-payable": {
      const kind = text("paymentKind") as PaymentKind;
      if (!PAYMENT_KINDS.includes(kind)) throw new IdentityError("VALIDATION_FAILED", "Choose what kind of payment this is.");
      return { action: "pay-payable", ...common, treasuryAccountId: id("treasuryAccountId", "Choose the Safe."), paymentKind: kind,
        payeeBusinessPartyId: optionalId("payeeBusinessPartyId"), payeeName: nullable("payeeName"),
        payableLedgerAccountId: id("payableLedgerAccountId", "Choose the payable account.") };
    }
    default:
      throw new IdentityError("VALIDATION_FAILED", "Unknown money movement.");
  }
}

export async function moneyGet(): Promise<Response> {
  try {
    return json({ ok: true, data: await restrictedFinanceAuthenticator().moneyOptions(financeHandoffRuntime().executor, await sessionToken()) });
  } catch (error) { return moneyErrorResponse(error); }
}

export async function moneyPost(request: Request): Promise<Response> {
  try {
    assertMutation(request);
    const token = await sessionToken();
    const command = moneyCommand(await readBody(request));
    const result = await restrictedFinanceAuthenticator().moneyCommand(financeHandoffRuntime().executor, token, command);
    return json({ ok: true, data: result }, result.replayed ? 200 : 201);
  } catch (error) { return moneyErrorResponse(error); }
}

/** Refusals written by 0047, translated to stable codes; the page shows them in English or Dari. */
const MONEY_REFUSALS: readonly { readonly pattern: RegExp; readonly status: number; readonly code: string; readonly message: string }[] = [
  { pattern: /approval setting has not been saved yet/i, status: 422, code: "SETTING_NOT_SAVED",
    message: "Its approval setting has not been saved yet. The System Administrator saves it in Workflow approvals." },
  { pattern: /setting requires approval, which is not available/i, status: 422, code: "APPROVAL_NOT_AVAILABLE",
    message: "The company requires approval for this, which is not available for it yet. Turn approval off in Workflow approvals to record it in one save." },
  { pattern: /needs two different accounts/i, status: 422, code: "SAME_ACCOUNT", message: "Choose two different accounts." },
  { pattern: /holds [A-Z]{3}, not/i, status: 422, code: "CURRENCY_MISMATCH", message: "Both accounts must hold the same currency." },
  { pattern: /approved accounting currency only/i, status: 422, code: "BASE_CURRENCY_ONLY",
    message: "This is available in the company's accounting currency for now." },
  { pattern: /Safe or Saraf account .* is not active|posts? only (to|from|between) (an )?active Safe/i, status: 422, code: "ACCOUNT_NOT_ACTIVE",
    message: "The chosen Safe or Saraf account is not active." },
  { pattern: /was not found in this legal entity/i, status: 404, code: "ACCOUNT_NOT_FOUND", message: "That account is not available for your company." },
  { pattern: /choose an active income account/i, status: 422, code: "INCOME_ACCOUNT_REQUIRED",
    message: "Choose an active income account in the accounting currency." },
  { pattern: /choose an active payable account/i, status: 422, code: "PAYABLE_ACCOUNT_REQUIRED",
    message: "Choose an active payable account in the accounting currency." },
  { pattern: /accounts payable needs the person or organization/i, status: 422, code: "SUPPLIER_REQUIRED",
    message: "A payment against accounts payable needs the person or organization it was owed to; choose them from the list." },
  { pattern: /name who the money came from or went to/i, status: 422, code: "COUNTERPARTY_REQUIRED", message: "Say who paid or who was paid." },
  { pattern: /not active in this legal entity/i, status: 422, code: "PARTY_NOT_AVAILABLE", message: "The chosen person or organization is not available." },
  { pattern: /cannot be dated after today/i, status: 422, code: "DATE_IN_FUTURE", message: "The date cannot be after today." },
  { pattern: /no accounting period covers/i, status: 422, code: "PERIOD_MISSING",
    message: "No month in your financial year covers this date. Generate the financial year first." },
  { pattern: /cannot be reopened automatically/i, status: 422, code: "PERIOD_CLOSED", message: "The month covering this date is closed. Choose another date." },
  { pattern: /idempotency key was already used/i, status: 409, code: "ALREADY_SUBMITTED_DIFFERENTLY",
    message: "This form was already submitted with different details. Start again." },
  { pattern: /plain positive decimals|positive/i, status: 422, code: "INVALID_AMOUNT", message: "Enter a positive amount such as 250 or 250.50." },
  { pattern: /unknown movement fields|valid date and request identity|choose/i, status: 422, code: "VALIDATION_FAILED",
    message: "Some details are missing or not valid." }
];

export function moneyErrorResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : "";
  const sqlState = error !== null && typeof error === "object" && "code" in error ? String((error as { readonly code: unknown }).code) : "";
  if (sqlState === "42501") return operationalFinanceErrorResponse(error);
  const known = message === "" || error instanceof IdentityError ? undefined : MONEY_REFUSALS.find((refusal) => refusal.pattern.test(message));
  if (known !== undefined) return json({ ok: false, error: { code: known.code, message: known.message } }, known.status);
  return operationalFinanceErrorResponse(error);
}
