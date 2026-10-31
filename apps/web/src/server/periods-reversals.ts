import { randomUUID } from "node:crypto";

import type { JournalReversalCommand } from "@abos/contracts";
import { IdentityError } from "@abos/identity";

import { financeHandoffRuntime } from "@/server/finance-handoff";
import { assertMutation, readBody, sessionToken } from "@/server/identity";
import { operationalFinanceErrorResponse, restrictedFinanceAuthenticator } from "@/server/operational-finance";

/**
 * Closing a financial year (migration 0052) and reversing posted journals (migration 0050), through the restricted
 * Finance runtime only. PostgreSQL derives actor and company from the password session, checks the permission, the
 * Simple / Advanced setting and segregation of duties, and posts every reversal through the REVERSAL source of the
 * posting kernel. Months are never closed or reopened by a user: they close with their financial year.
 */

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-ABOS-Data": "operational" } });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function reader(body: Record<string, unknown>) {
  const text = (name: string) => (typeof body[name] === "string" ? (body[name] as string).trim() : "");
  const id = (name: string, message: string) => {
    const value = text(name);
    if (!UUID.test(value)) throw new IdentityError("VALIDATION_FAILED", message);
    return value;
  };
  const version = () => {
    const value = body.expectedVersion;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new IdentityError("VALIDATION_FAILED", "Reload and try again.");
    return value;
  };
  return { text, id, version };
}

/** Builds exactly one known reversal command. */
export function journalReversalCommand(body: Record<string, unknown>): JournalReversalCommand {
  const { text, id, version } = reader(body);
  switch (text("action")) {
    case "reverse": return { action: "reverse", journalId: id("journalId", "Choose a transaction."), reason: text("reason"),
      // The browser keeps one request identity per filled-in form, so a retry replays instead of reversing twice.
      idempotencyKey: text("idempotencyKey") || `reversal-${randomUUID()}`, correlationId: UUID.test(text("correlationId")) ? text("correlationId") : randomUUID() };
    case "request": return { action: "request", journalId: id("journalId", "Choose a transaction."), reason: text("reason") };
    case "decide": {
      const decision = text("decision");
      if (decision !== "APPROVED" && decision !== "REJECTED") throw new IdentityError("VALIDATION_FAILED", "Choose a decision.");
      return { action: "decide", requestId: id("requestId", "Choose a request."), expectedVersion: version(), decision, note: text("note") || null };
    }
    case "post-approved": return { action: "post-approved", requestId: id("requestId", "Choose a request.") };
    case "withdraw": return { action: "withdraw", requestId: id("requestId", "Choose a request."), expectedVersion: version() };
    default: throw new IdentityError("VALIDATION_FAILED", "Unknown reversal action.");
  }
}

const runtime = () => financeHandoffRuntime().executor;

export async function financialYearsGet(): Promise<Response> {
  try { return json({ ok: true, data: await restrictedFinanceAuthenticator().financialYearsWorkspace(runtime(), await sessionToken()) }); }
  catch (error) { return slice5ErrorResponse(error); }
}

export async function financialYearPreviewGet(fiscalYearId: string): Promise<Response> {
  try {
    if (!UUID.test(fiscalYearId)) throw new IdentityError("VALIDATION_FAILED", "Choose a financial year.");
    return json({ ok: true, data: await restrictedFinanceAuthenticator().financialYearClosePreview(runtime(), await sessionToken(), fiscalYearId) });
  } catch (error) { return slice5ErrorResponse(error); }
}

/** { fiscalYearId, correlationId? }: closes the year (a repeated close replays); returns the refreshed workspace. */
export async function financialYearClosePost(request: Request): Promise<Response> {
  try {
    assertMutation(request);
    const token = await sessionToken();
    const { text, id } = reader(await readBody(request));
    const command = { fiscalYearId: id("fiscalYearId", "Choose a financial year."),
      correlationId: UUID.test(text("correlationId")) ? text("correlationId") : randomUUID() };
    const result = await restrictedFinanceAuthenticator().financialYearClose(runtime(), token, command);
    return json({ ok: true, data: { result, workspace: await restrictedFinanceAuthenticator().financialYearsWorkspace(runtime(), token) } });
  } catch (error) { return slice5ErrorResponse(error); }
}

export async function reversalsGet(): Promise<Response> {
  try { return json({ ok: true, data: await restrictedFinanceAuthenticator().journalReversalWorkspace(runtime(), await sessionToken()) }); }
  catch (error) { return slice5ErrorResponse(error); }
}

export async function reversalsPost(request: Request): Promise<Response> {
  try {
    assertMutation(request);
    const token = await sessionToken();
    const result = await restrictedFinanceAuthenticator().journalReversalCommand(runtime(), token, journalReversalCommand(await readBody(request)));
    return json({ ok: true, data: { result, workspace: await restrictedFinanceAuthenticator().journalReversalWorkspace(runtime(), token) } },
      result.replayed ? 200 : 201);
  } catch (error) { return slice5ErrorResponse(error); }
}

/** Refusals written by 0050 and 0052 (and the guards they rely on), as stable codes; the pages show English or Dari. */
const REFUSALS: readonly { readonly pattern: RegExp; readonly status: number; readonly code: string; readonly message: string }[] = [
  { pattern: /not enough money in .* its balance would fall below zero/i, status: 422, code: "INSUFFICIENT_FUNDS",
    message: "Reversing this would take the Safe below zero. A Safe, cash box or petty cash can never go below zero." },
  { pattern: /requires an approved request for reversals/i, status: 422, code: "APPROVAL_REQUIRED",
    message: "Your company requires an approved request for reversals. Send a reversal request." },
  { pattern: /second person must confirm|person who requested a reversal cannot|requested a reversal cannot decide|only the person who asked/i, status: 403,
    code: "SECOND_PERSON_REQUIRED", message: "A different person must decide this request." },
  { pattern: /whoever prepared, approved or posted a journal|actor who posted a journal cannot/i, status: 403, code: "PARTICIPANT",
    message: "Whoever prepared, approved or posted a transaction cannot reverse it, ask for its reversal or decide it." },
  { pattern: /already been reversed/i, status: 409, code: "ALREADY_REVERSED", message: "This transaction has already been reversed." },
  { pattern: /itself a reversal/i, status: 422, code: "IS_REVERSAL", message: "This is a reversal; a reversal is not reversed again." },
  { pattern: /cannot be reversed yet|kind of journal cannot be reversed/i, status: 422, code: "NOT_REVERSIBLE",
    message: "This kind of transaction cannot be reversed yet." },
  { pattern: /has a reversal request; decide that request/i, status: 409, code: "OPEN_REQUEST",
    message: "This transaction already has a reversal request. Decide that request instead." },
  { pattern: /journal_reversal_requests_one_open|duplicate key value/i, status: 409, code: "OPEN_REQUEST",
    message: "This transaction already has an open reversal request." },
  { pattern: /financial year covering .* is closed|cannot be reopened automatically|no accounting period covers/i, status: 422, code: "PERIOD_CLOSED",
    message: "Today's financial year is closed or not set up, so the reversal has nowhere to post. Set up the current financial year first." },
  { pattern: /journal that is not posted/i, status: 422, code: "UNPOSTED_JOURNAL",
    message: "The financial year has a journal that is not posted, so it cannot be closed." },
  { pattern: /has no months to close/i, status: 422, code: "NO_MONTHS", message: "This financial year has no months set up, so there is nothing to close." },
  { pattern: /changed; reload|changed by someone else/i, status: 409, code: "STALE_VERSION", message: "This changed in the meantime. Reload and try again." },
  { pattern: /was already (approved|rejected|withdrawn|confirmed)/i, status: 409, code: "ALREADY_DECIDED", message: "This request was already decided." },
  { pattern: /reason for the reversal/i, status: 422, code: "REASON_REQUIRED", message: "Write the reason." },
  { pattern: /say why/i, status: 422, code: "NOTE_REQUIRED", message: "Say why the request is rejected." },
  { pattern: /not found|does not exist in this legal entity/i, status: 404, code: "NOT_FOUND", message: "That is not available for your company." },
  { pattern: /unknown (reversal|financial year) fields|choose a valid/i, status: 422, code: "VALIDATION_FAILED", message: "Some details are missing or not valid." }
];

export function slice5ErrorResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : "";
  const sqlState = error !== null && typeof error === "object" && "code" in error ? String((error as { readonly code: unknown }).code) : "";
  const known = message === "" || error instanceof IdentityError ? undefined : REFUSALS.find((refusal) => refusal.pattern.test(message));
  if (known !== undefined && !(sqlState === "42501" && known.status !== 403)) {
    return json({ ok: false, error: { code: known.code, message: known.message } }, known.status);
  }
  return operationalFinanceErrorResponse(error);
}
