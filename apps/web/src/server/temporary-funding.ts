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
 * Temporary Funding (migration 0037) through the restricted Finance runtime only; there is no
 * in-memory fallback. The browser sends business fields; PostgreSQL derives actor and legal entity
 * from the password session, checks the command's permission and enforces maker-checker, provider
 * independence, idempotency and the payable/Safe journal contracts. Reversal is not available.
 */

export async function temporaryFundingWorkspace(): Promise<TemporaryFundingWorkspace> {
  return restrictedFinanceAuthenticator().temporaryFundingWorkspace(financeHandoffRuntime().executor, await sessionToken());
}

export async function runTemporaryFundingCommand(command: TemporaryFundingCommand): Promise<TemporaryFundingResult> {
  return restrictedFinanceAuthenticator().temporaryFundingCommand(
    financeHandoffRuntime().executor, await sessionToken(), command);
}

const MODES: readonly TemporaryFundingMode[] = ["PROVIDER_PAID_EXPENSE_DIRECTLY", "PROVIDER_FUNDED_SAFE"];
const KINDS: readonly TemporaryFundingProviderKind[] = ["SHAREHOLDER", "EMPLOYEE", "EXTERNAL_OTHER"];

/** Builds exactly one known command from a request body; unknown actions are refused before any database call. */
export function temporaryFundingCommand(body: Record<string, unknown>): TemporaryFundingCommand {
  const nullable = (name: string) => {
    const value = optionalText(body, name);
    return value === null || value.trim() === "" ? null : value.trim();
  };
  // The browser keeps one request identity per filled-in form, so a retry replays instead of doubling.
  const key = () => nullable("idempotencyKey") ?? randomUUID();
  const correlation = () => nullable("correlationId") ?? randomUUID();
  const version = (name: string) => {
    const value = body[name];
    return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0;
  };
  const money = () => {
    const value = body.amount;
    const record = value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
    return { amount: text(record, "amount").trim(), currency: text(record, "currency").trim() };
  };
  const decision = (): TemporaryFundingDecision => {
    const value = text(body, "decision");
    if (value !== "APPROVED" && value !== "REJECTED") throw new IdentityError("VALIDATION_FAILED", "Choose approve or reject.");
    return value;
  };
  const action = text(body, "action");
  switch (action) {
    case "record": {
      const fundingMode = text(body, "fundingMode") as TemporaryFundingMode;
      const providerKind = text(body, "providerKind") as TemporaryFundingProviderKind;
      if (!MODES.includes(fundingMode) || !KINDS.includes(providerKind)) {
        throw new IdentityError("VALIDATION_FAILED", "Choose how the funding was provided and who provided it.");
      }
      return {
        // The provider's user identity is never taken from the request: PostgreSQL binds the provider's
        // current Super Administrator identity profile.
        action, fundingMode, providerKind, providerBusinessPartyId: text(body, "providerBusinessPartyId"),
        expenseCategoryId: nullable("expenseCategoryId"),
        payeeBusinessPartyId: nullable("payeeBusinessPartyId"), projectId: nullable("projectId"),
        departmentId: nullable("departmentId"), costCenterId: nullable("costCenterId"),
        treasuryAccountId: nullable("treasuryAccountId"), reference: text(body, "reference").trim(),
        description: text(body, "description").trim(), note: nullable("note"), businessDate: text(body, "businessDate"),
        amount: money(), idempotencyKey: key(), correlationId: correlation()
      };
    }
    case "decide":
      return { action, temporaryFundingId: text(body, "temporaryFundingId"), expectedVersion: version("expectedVersion"),
        decision: decision(), decisionReason: text(body, "decisionReason"), idempotencyKey: key(), correlationId: correlation() };
    case "request-settlement":
      return { action, temporaryFundingId: text(body, "temporaryFundingId"),
        expectedFundingVersion: version("expectedFundingVersion"), treasuryAccountId: text(body, "treasuryAccountId"),
        amount: money(), businessDate: text(body, "businessDate"), reference: text(body, "reference").trim(),
        note: nullable("note"), idempotencyKey: key(), correlationId: correlation() };
    case "decide-settlement":
      return { action, settlementId: text(body, "settlementId"), expectedVersion: version("expectedVersion"),
        decision: decision(), decisionReason: text(body, "decisionReason"), idempotencyKey: key(), correlationId: correlation() };
    case "configure-mapping":
      return { action, ledgerAccountId: text(body, "ledgerAccountId"),
        evidenceDocumentReference: text(body, "evidenceDocumentReference").trim(),
        evidenceSha256: text(body, "evidenceSha256").trim().toLowerCase(), changeReason: text(body, "changeReason").trim(),
        idempotencyKey: key(), correlationId: correlation() };
    case "configure-provider-identity": {
      const identityMode = text(body, "identityMode");
      if (identityMode !== "ABOS_USER" && identityMode !== "NO_ABOS_USER") {
        throw new IdentityError("VALIDATION_FAILED", "Choose whether the provider uses ABOS.");
      }
      const expected = body.expectedVersion;
      return { action, businessPartyId: text(body, "businessPartyId"),
        expectedVersion: typeof expected === "number" && Number.isInteger(expected) && expected >= 0 ? expected : -1,
        identityMode, userAccountId: identityMode === "ABOS_USER" ? nullable("userAccountId") : null,
        evidenceDocumentReference: text(body, "evidenceDocumentReference").trim(),
        evidenceSha256: text(body, "evidenceSha256").trim().toLowerCase(), changeReason: text(body, "changeReason").trim(),
        idempotencyKey: key(), correlationId: correlation() };
    }
    default:
      throw new IdentityError("VALIDATION_FAILED", "Unknown temporary funding action.");
  }
}

/** Refusals written by migration 0037, translated to stable codes; the page shows them in English or Dari. */
const FUNDING_REFUSALS: readonly { readonly pattern: RegExp; readonly status: number; readonly code: string; readonly message: string }[] = [
  { pattern: /exceeds the outstanding temporary funding payable|would exceed the outstanding/i, status: 422, code: "OVER_SETTLEMENT",
    message: "This repayment is more than the amount still owed to the provider." },
  { pattern: /recorder or the funding provider cannot decide|settlement preparer or the funding provider/i,
    status: 403, code: "SEGREGATION_OF_DUTIES",
    message: "Someone independent of the person who recorded it, and of the provider, must make this decision." },
  { pattern: /provider kind does not match/i, status: 422, code: "PROVIDER_KIND_MISMATCH",
    message: "The provider's roles changed. Reload and record it again." },
  { pattern: /provider identity is not configured/i, status: 422, code: "PROVIDER_IDENTITY_MISSING",
    message: "A Super Administrator must first record whether this provider uses ABOS." },
  { pattern: /provider identity is no longer valid or is ambiguous|current valid identity profile/i, status: 422,
    code: "PROVIDER_IDENTITY_INVALID", message: "This provider's ABOS identity is no longer valid. A Super Administrator must review it." },
  { pattern: /already the current identity of another provider/i, status: 409, code: "PROVIDER_IDENTITY_AMBIGUOUS",
    message: "That ABOS user is already the identity of another provider." },
  { pattern: /ABOS user must be active with a current grant/i, status: 422, code: "PROVIDER_USER_INVALID",
    message: "Choose an active ABOS user of this company." },
  { pattern: /identity mode \(with its user only for ABOS_USER\)/i, status: 422, code: "EVIDENCE_REQUIRED",
    message: "Choose the provider, whether they use ABOS (and which user), the evidence document, its SHA-256 and a reason." },
  { pattern: /provider identity changed; reload/i, status: 409, code: "STALE_VERSION",
    message: "Someone else changed this provider's identity meanwhile. Reload and try again." },
  { pattern: /base-currency only/i, status: 422, code: "BASE_CURRENCY_ONLY",
    message: "Temporary funding can only be recorded in the company's base currency for now." },
  { pattern: /payable mapping is missing|TEMPORARY_FUNDING_PAYABLE liability/i, status: 422, code: "PAYABLE_NOT_CONFIGURED",
    message: "Choose an active Temporary Funding Payable liability account in the base currency first." },
  { pattern: /evidence reference, evidence SHA-256/i, status: 422, code: "EVIDENCE_REQUIRED",
    message: "Enter the authorization document reference, its SHA-256 fingerprint and a reason." },
  { pattern: /not configured as approval-required/i, status: 422, code: "APPROVAL_REQUIRED",
    message: "Temporary funding must require approval. Ask the System Administrator to set it in Workflow approvals." },
  { pattern: /financial year covering .* is closed|cannot be reopened automatically/i, status: 422, code: "PERIOD_CLOSED",
    message: "The financial year of this date is closed. Choose a date in an active financial year." },
  { pattern: /no open accounting period covers|no accounting period covers/i, status: 422, code: "PERIOD_NOT_OPEN",
    message: "No financial year covers this date. Set up the financial year first." },
  { pattern: /cannot be dated before its funding/i, status: 422, code: "DATE_NOT_ALLOWED",
    message: "A repayment cannot be dated before the funding." },
  { pattern: /Treasury account on a CASH asset account is required/i, status: 422, code: "TREASURY_UNAVAILABLE",
    message: "Choose an active Safe or bank account in the base currency." },
  { pattern: /not waiting for approval|only a posted temporary funding/i, status: 409, code: "NOT_PENDING",
    message: "This item is no longer in a state that allows this action." },
  { pattern: /changed; reload/i, status: 409, code: "STALE_VERSION",
    message: "Someone else changed this meanwhile. Reload and try again." },
  { pattern: /idempotency key was already used/i, status: 409, code: "ALREADY_SUBMITTED_DIFFERENTLY",
    message: "This form was already submitted with different details. Start again." },
  { pattern: /not available in this legal entity|not an active business party|expense category is required|user account is not active/i,
    status: 422, code: "NOT_AVAILABLE", message: "One of the chosen records is not available for your company." },
  { pattern: /requires a project, department or cost center|outside the actor's live scope/i, status: 422, code: "DIMENSION_REQUIRED",
    message: "This expense type needs a project, department or cost center that you work with." },
  { pattern: /plain positive decimals/i, status: 422, code: "INVALID_AMOUNT",
    message: "Enter a positive amount such as 250 or 250.50." },
  { pattern: /complete valid|unsupported fields|terminal decision|required/i, status: 422, code: "VALIDATION_FAILED",
    message: "Some details are missing or not valid." }
];

export function temporaryFundingErrorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  const sqlState = error !== null && typeof error === "object" && "code" in error
    ? String((error as { readonly code: unknown }).code) : "";
  // Authority and session failures go through the shared translation; their texts never reach people verbatim.
  if (sqlState === "42501" && /current authority is missing|sign in|password session|proof/i.test(message)) {
    return operationalFinanceErrorResponse(error);
  }
  const known = message === "" ? undefined : FUNDING_REFUSALS.find((refusal) => refusal.pattern.test(message));
  if (known !== undefined) return json({ ok: false, error: { code: known.code, message: known.message } }, known.status);
  return operationalFinanceErrorResponse(error);
}
