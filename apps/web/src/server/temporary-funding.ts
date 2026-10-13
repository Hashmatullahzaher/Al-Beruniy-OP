import { randomUUID } from "node:crypto";

import type {
  TemporaryFundingCommand,
  TemporaryFundingDecision,
  TemporaryFundingMode,
  TemporaryFundingProviderKind,
  TemporaryFundingResult,
  TemporaryFundingWorkspace
} from "@abos/contracts";
import { IdentityError } from "@abos/identity";

import { financeHandoffRuntime } from "@/server/finance-handoff";
import { optionalText, sessionToken, text } from "@/server/identity";
import { operationalFinanceErrorResponse, restrictedFinanceAuthenticator } from "@/server/operational-finance";
import { json } from "@/server/treasury";

/**
 * P2 Temporary Funding through the restricted Finance runtime only (isolated schema proposal, not a
 * migration). The browser sends business fields; PostgreSQL derives actor and legal entity, checks the
 * command's permission, enforces maker-checker, idempotency and the payable/Safe journal rules.
 */

export async function temporaryFundingWorkspace(): Promise<TemporaryFundingWorkspace> {
  return restrictedFinanceAuthenticator().temporaryFundingWorkspace(financeHandoffRuntime().executor, await sessionToken());
}

export async function runTemporaryFundingCommand(command: TemporaryFundingCommand): Promise<TemporaryFundingResult> {
  return restrictedFinanceAuthenticator().temporaryFundingCommand(
    financeHandoffRuntime().executor, await sessionToken(), command);
}

const MODES: readonly TemporaryFundingMode[] = ["PROVIDER_PAID_EXPENSE", "PROVIDER_FUNDED_SAFE"];
const KINDS: readonly TemporaryFundingProviderKind[] = ["SHAREHOLDER", "EMPLOYEE_OFFICER", "OTHER_PERSON", "ORGANIZATION"];

/** Builds exactly one known command from a request body; unknown actions are refused before any database call. */
export function temporaryFundingCommand(body: Record<string, unknown>): TemporaryFundingCommand {
  const nullable = (name: string) => {
    const value = optionalText(body, name);
    return value === null || value.trim() === "" ? null : value.trim();
  };
  // The browser keeps one request identity per filled-in form, so a retry replays instead of doubling.
  const key = () => nullable("idempotencyKey") ?? randomUUID();
  const correlation = () => nullable("correlationId") ?? randomUUID();
  const version = () => {
    const value = body.expectedVersion;
    return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : -1;
  };
  const decision = (): TemporaryFundingDecision => {
    const value = text(body, "decision");
    if (value !== "APPROVED" && value !== "REJECTED") throw new IdentityError("VALIDATION_FAILED", "Choose approve or reject.");
    return value;
  };
  const action = text(body, "action");
  switch (action) {
    case "create": {
      const fundingMode = text(body, "fundingMode") as TemporaryFundingMode;
      const providerKind = text(body, "providerKind") as TemporaryFundingProviderKind;
      if (!MODES.includes(fundingMode) || !KINDS.includes(providerKind)) {
        throw new IdentityError("VALIDATION_FAILED", "Choose how the funding was provided and who provided it.");
      }
      return {
        action, fundingMode, providerKind, providerBusinessPartyId: text(body, "providerBusinessPartyId"),
        providerUserAccountId: nullable("providerUserAccountId"), expenseCategoryId: nullable("expenseCategoryId"),
        payeeBusinessPartyId: nullable("payeeBusinessPartyId"), projectId: nullable("projectId"),
        departmentId: nullable("departmentId"), costCenterId: nullable("costCenterId"),
        treasuryAccountId: nullable("treasuryAccountId"), reference: text(body, "reference").trim(),
        description: text(body, "description").trim(), note: nullable("note"), businessDate: text(body, "businessDate"),
        originalAmount: text(body, "originalAmount").trim(), currencyCode: text(body, "currencyCode"),
        correlationId: correlation(), idempotencyKey: key()
      };
    }
    case "decide":
      return { action, temporaryFundingId: text(body, "temporaryFundingId"), expectedVersion: version(),
        decision: decision(), note: text(body, "note") };
    case "cancel":
      return { action, temporaryFundingId: text(body, "temporaryFundingId"), expectedVersion: version(),
        reason: text(body, "reason") };
    case "settlement-create":
      return { action, temporaryFundingId: text(body, "temporaryFundingId"), treasuryAccountId: text(body, "treasuryAccountId"),
        reference: text(body, "reference").trim(), note: nullable("note"), businessDate: text(body, "businessDate"),
        originalAmount: text(body, "originalAmount").trim(), correlationId: correlation(), idempotencyKey: key() };
    case "settlement-decide":
      return { action, settlementId: text(body, "settlementId"), expectedVersion: version(), decision: decision(),
        note: text(body, "note") };
    case "settlement-cancel":
      return { action, settlementId: text(body, "settlementId"), expectedVersion: version(), reason: text(body, "reason") };
    case "reversal-request":
      return { action, temporaryFundingId: text(body, "temporaryFundingId"), reversalDate: text(body, "reversalDate"),
        reason: text(body, "reason").trim(), correlationId: correlation(), idempotencyKey: key() };
    case "reversal-decide":
      return { action, reversalId: text(body, "reversalId"), expectedVersion: version(), decision: decision(),
        note: text(body, "note") };
    case "configure":
      return { action, payableLedgerAccountId: text(body, "payableLedgerAccountId"), expectedVersion: version(),
        changeReason: text(body, "changeReason") };
    default:
      throw new IdentityError("VALIDATION_FAILED", "Unknown temporary funding action.");
  }
}

/** Refusals written by the P2 proposal, translated to stable codes; the page shows them in English or Dari. */
const FUNDING_REFUSALS: readonly { readonly pattern: RegExp; readonly status: number; readonly code: string; readonly message: string }[] = [
  { pattern: /insufficient recorded cash/i, status: 422, code: "INSUFFICIENT_CASH",
    message: "The Safe does not hold enough recorded cash for this payment. Record a temporary funding instead." },
  { pattern: /settlement (exceeds|would exceed) the outstanding/i, status: 422, code: "OVER_SETTLEMENT",
    message: "This settlement is more than the amount still owed to the provider." },
  { pattern: /pending or posted settlements cannot be reversed/i, status: 409, code: "HAS_SETTLEMENTS",
    message: "A funding that has settlements cannot be reversed." },
  { pattern: /independent of the request|creator or the funding provider cannot decide|settlement creator or the funding provider/i,
    status: 403, code: "SEGREGATION_OF_DUTIES",
    message: "Someone independent of this request and of the provider must make this decision." },
  { pattern: /provider kind does not match/i, status: 422, code: "PROVIDER_KIND_MISMATCH",
    message: "The provider type does not match this person's or organization's role." },
  { pattern: /base-currency only/i, status: 422, code: "BASE_CURRENCY_ONLY",
    message: "Temporary funding can only be recorded in the company's base currency for now." },
  { pattern: /payable account is not configured|LIABILITY account in the base currency/i, status: 422, code: "PAYABLE_NOT_CONFIGURED",
    message: "Choose an active liability account for temporary funding first." },
  { pattern: /approval policy is not configured/i, status: 422, code: "POLICY_NOT_CONFIGURED",
    message: "The temporary funding approval setting is not configured for this company yet." },
  { pattern: /no open accounting period covers/i, status: 422, code: "PERIOD_NOT_OPEN",
    message: "No open accounting period covers this date." },
  { pattern: /cannot be dated before its funding|on or before the approved opening date/i, status: 422, code: "DATE_NOT_ALLOWED",
    message: "Choose a later date." },
  { pattern: /reversal is (already )?waiting for a decision/i, status: 409, code: "REVERSAL_PENDING",
    message: "A reversal of this funding is already waiting for a decision." },
  { pattern: /not waiting for (approval|a decision)|only a pending|only a posted|posted, unreversed/i, status: 409, code: "NOT_PENDING",
    message: "This item is no longer in a state that allows this action." },
  { pattern: /changed; reload/i, status: 409, code: "STALE_VERSION",
    message: "Someone else changed this meanwhile. Reload and try again." },
  { pattern: /already used for different details/i, status: 409, code: "ALREADY_SUBMITTED_DIFFERENTLY",
    message: "This form was already submitted with different details. Start again." },
  { pattern: /still in progress/i, status: 409, code: "IN_PROGRESS",
    message: "This request is still being processed. Try again in a moment." },
  { pattern: /only the creator can cancel/i, status: 403, code: "NOT_CREATOR",
    message: "Only the person who recorded it can cancel it." },
  { pattern: /not available in this legal entity|not an active business party|Safe, cash box or petty cash|same-currency Safe or bank|expense category is required/i,
    status: 422, code: "NOT_AVAILABLE", message: "One of the chosen records is not available for your company." },
  { pattern: /plain positive decimals/i, status: 422, code: "INVALID_AMOUNT",
    message: "Enter a positive amount such as 250 or 250.50." },
  { pattern: /required|unknown .* fields/i, status: 422, code: "VALIDATION_FAILED",
    message: "Some details are missing or not valid." }
];

export function temporaryFundingErrorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  const sqlState = error !== null && typeof error === "object" && "code" in error
    ? String((error as { readonly code: unknown }).code) : "";
  // Authority and session failures first: their messages never reach the person verbatim.
  if (sqlState === "42501" && /current authority is missing|sign in/i.test(message)) {
    return operationalFinanceErrorResponse(error);
  }
  const known = message === "" ? undefined : FUNDING_REFUSALS.find((refusal) => refusal.pattern.test(message));
  if (known !== undefined) return json({ ok: false, error: { code: known.code, message: known.message } }, known.status);
  return operationalFinanceErrorResponse(error);
}
