import { randomUUID } from "node:crypto";

import type { LenderType, LoanCommand, LoanCommandResult, LoanStatementView, LoanWorkspace } from "@abos/contracts";
import { IdentityError } from "@abos/identity";

import { financeHandoffRuntime } from "@/server/finance-handoff";
import { assertMutation, optionalText, readBody, sessionToken, text } from "@/server/identity";
import { operationalExpenseErrorResponse, restrictedFinanceAuthenticator } from "@/server/operational-finance";
import { reportRange } from "@/server/reporting";
import { json } from "@/server/treasury";

/**
 * Loans (migrations 0061 and 0062) through the restricted Finance runtime only. The browser sends business fields; PostgreSQL derives the
 * actor and legal entity from the password session, checks each permission and posts through the posting kernel.
 */

const LENDER_TYPES: readonly LenderType[] = ["SHAREHOLDER", "INDIVIDUAL", "SUPPLIER", "COMPANY", "OTHER"];

/** Builds exactly one known command from a request body; unknown actions are refused before any database call. */
export function loanCommand(body: Record<string, unknown>): LoanCommand {
  const nullable = (name: string) => {
    const value = optionalText(body, name);
    return value === null || value.trim() === "" ? null : value.trim();
  };
  // The browser keeps one request identity per filled-in form, so a retry replays instead of doubling.
  const identity = { idempotencyKey: nullable("idempotencyKey") ?? randomUUID(), correlationId: nullable("correlationId") ?? randomUUID() };
  const action = text(body, "action");
  switch (action) {
    case "record": {
      const lenderType = text(body, "lenderType") as LenderType;
      if (!LENDER_TYPES.includes(lenderType)) throw new IdentityError("VALIDATION_FAILED", "Choose who lent the money.");
      return { action, lenderType, lenderBusinessPartyId: nullable("lenderBusinessPartyId"), lenderName: nullable("lenderName"), shareholderProfileId: nullable("shareholderProfileId"),
        liabilityLedgerAccountId: nullable("liabilityLedgerAccountId"), treasuryAccountId: text(body, "treasuryAccountId"), amount: text(body, "amount").trim(),
        currencyCode: text(body, "currencyCode").trim(), businessDate: text(body, "businessDate"), reference: nullable("reference"), note: nullable("note"),
        exchangeRateId: nullable("exchangeRateId"), ...identity };
    }
    case "repay":
      return { action, loanId: text(body, "loanId"), treasuryAccountId: text(body, "treasuryAccountId"), amount: text(body, "amount").trim(), businessDate: text(body, "businessDate"),
        reference: nullable("reference"), note: nullable("note"), exchangeRateId: nullable("exchangeRateId"), ...identity };
    case "decide": {
      const kind = text(body, "kind"); const decision = text(body, "decision");
      if ((kind !== "LOAN" && kind !== "REPAYMENT") || (decision !== "APPROVED" && decision !== "REJECTED")) throw new IdentityError("VALIDATION_FAILED", "Choose approve or reject.");
      return { action, kind, id: text(body, "id"), decision, reason: nullable("reason"), ...identity };
    }
    default:
      throw new IdentityError("VALIDATION_FAILED", "Unknown loan action.");
  }
}

export async function loansGet(): Promise<Response> {
  try {
    const data: LoanWorkspace = await restrictedFinanceAuthenticator().loanWorkspace(financeHandoffRuntime().executor, await sessionToken());
    return json({ ok: true, data });
  } catch (error) {
    return operationalExpenseErrorResponse(error);
  }
}

export async function loansPost(request: Request): Promise<Response> {
  try {
    assertMutation(request);
    const command = loanCommand(await readBody(request));
    const data: LoanCommandResult = await restrictedFinanceAuthenticator().loanCommand(financeHandoffRuntime().executor, await sessionToken(), command);
    return json({ ok: true, data }, data.replayed === false ? 201 : 200);
  } catch (error) {
    return operationalExpenseErrorResponse(error);
  }
}

export async function loanStatementGet(request: Request): Promise<Response> {
  try {
    const query = new URL(request.url).searchParams;
    const payload = { loanId: query.get("loanId") ?? "", ...reportRange(query) };
    const data: LoanStatementView = await restrictedFinanceAuthenticator().loanStatement(financeHandoffRuntime().executor, await sessionToken(), payload);
    return json({ ok: true, data });
  } catch (error) {
    return operationalExpenseErrorResponse(error);
  }
}
