import { randomUUID } from "node:crypto";

import type { ShareholderSetupCommand, ShareholderSetupResult, ShareholderSetupWorkspace } from "@abos/contracts";
import { IdentityError } from "@abos/identity";
import { SandboxAuthError } from "@abos/sandbox-auth";

import { financeHandoffRuntime } from "@/server/finance-handoff";
import { optionalText, sessionToken, text } from "@/server/identity";
import { restrictedFinanceAuthenticator } from "@/server/operational-finance";
import { json, TreasuryUnavailableError } from "@/server/treasury";

/**
 * Shareholder master data and DRAFT capital agreement setup (migration 0031), through the restricted
 * Finance runtime only. The browser sends business fields; PostgreSQL derives actor and legal
 * entity, checks shareholder.setup.manage, and refuses anything outside DRAFT setup. Nothing here
 * receives money or touches Treasury, posting or the General Ledger.
 */

export async function shareholderSetupWorkspace(): Promise<ShareholderSetupWorkspace> {
  return restrictedFinanceAuthenticator().shareholderSetupWorkspace(financeHandoffRuntime().executor, await sessionToken());
}

export async function runShareholderSetupCommand(command: ShareholderSetupCommand): Promise<ShareholderSetupResult> {
  return restrictedFinanceAuthenticator().shareholderSetupCommand(financeHandoffRuntime().executor, await sessionToken(), command);
}

/** Builds exactly one known command from a request body; unknown actions are refused before any database call. */
export function shareholderSetupCommand(body: Record<string, unknown>): ShareholderSetupCommand {
  const key = () => optionalText(body, "idempotencyKey") || randomUUID();
  const nullable = (name: string) => {
    const value = optionalText(body, name);
    return value === null || value.trim() === "" ? null : value;
  };
  const flag = (name: string) => body[name] === true;
  const action = text(body, "action");
  switch (action) {
    case "create-shareholder":
      return { action, displayName: text(body, "displayName"), externalReference: nullable("externalReference"),
        shareholderSince: text(body, "shareholderSince"), idempotencyKey: key(), correlationId: randomUUID() };
    case "correct-shareholder":
      return { action, shareholderProfileId: text(body, "shareholderProfileId"), displayName: text(body, "displayName"),
        externalReference: nullable("externalReference") };
    case "create-agreement":
      return { action, shareholderProfileId: text(body, "shareholderProfileId"), agreementReference: text(body, "agreementReference"),
        committedAmount: text(body, "committedAmount"), currencyCode: text(body, "currencyCode"), effectiveOn: text(body, "effectiveOn"),
        partialInstallmentsAllowed: flag("partialInstallmentsAllowed"), idempotencyKey: key(), correlationId: randomUUID() };
    case "update-agreement":
      return { action, capitalAgreementId: text(body, "capitalAgreementId"), agreementReference: text(body, "agreementReference"),
        committedAmount: text(body, "committedAmount"), currencyCode: text(body, "currencyCode"), effectiveOn: text(body, "effectiveOn"),
        partialInstallmentsAllowed: flag("partialInstallmentsAllowed") };
    case "add-installment":
      return { action, capitalAgreementId: text(body, "capitalAgreementId"), expectedAmount: text(body, "expectedAmount"),
        dueOn: nullable("dueOn"), idempotencyKey: key(), correlationId: randomUUID() };
    case "update-installment":
      return { action, capitalInstallmentId: text(body, "capitalInstallmentId"), expectedAmount: text(body, "expectedAmount"),
        dueOn: nullable("dueOn") };
    case "cancel-installment":
      return { action, capitalInstallmentId: text(body, "capitalInstallmentId"), reason: text(body, "reason") };
    case "record-agreement-document":
      return { action, capitalAgreementId: text(body, "capitalAgreementId"), documentReference: text(body, "documentReference"),
        documentDate: text(body, "documentDate"), sha256: text(body, "sha256"), idempotencyKey: key(), correlationId: randomUUID() };
    default:
      throw new IdentityError("VALIDATION_FAILED", "Unknown shareholder setup action.");
  }
}

/** Refusals written by migration 0031, translated to stable codes; the page shows them in English or Dari. */
const SETUP_REFUSALS: readonly { readonly pattern: RegExp; readonly status: number; readonly code: string; readonly message: string }[] = [
  { pattern: /already used by another business party/i, status: 409, code: "REFERENCE_IN_USE",
    message: "This reference is already used by another business party of your company." },
  { pattern: /agreement_reference/i, status: 409, code: "AGREEMENT_REFERENCE_IN_USE",
    message: "Another capital agreement already uses this reference." },
  { pattern: /already has posted capital/i, status: 409, code: "SHAREHOLDER_HAS_POSTED_CAPITAL",
    message: "This shareholder already has posted capital, so their details can no longer be corrected here." },
  { pattern: /only a DRAFT|only while the agreement is DRAFT|only before the agreement is eligible/i, status: 409, code: "NOT_DRAFT",
    message: "Only DRAFT agreements and installments can be changed here." },
  { pattern: /installments would plan/i, status: 422, code: "PLAN_EXCEEDS_COMMITMENT",
    message: "The installments would plan more than the committed capital." },
  { pattern: /cannot be reduced below/i, status: 422, code: "COMMITMENT_BELOW_PLAN",
    message: "The committed capital cannot be lower than the installments already planned." },
  { pattern: /currency cannot change once installments exist/i, status: 422, code: "CURRENCY_FIXED",
    message: "The currency cannot change once installments exist." },
  { pattern: /currency \S+ is not enabled/i, status: 422, code: "CURRENCY_NOT_ENABLED",
    message: "This currency is not enabled." },
  { pattern: /cannot be in the future/i, status: 422, code: "FUTURE_DATE",
    message: "This date cannot be in the future." },
  { pattern: /plain positive decimals/i, status: 422, code: "INVALID_AMOUNT",
    message: "Enter a positive amount such as 25000 or 25000.50." },
  { pattern: /SHA-256/i, status: 422, code: "INVALID_DOCUMENT",
    message: "Enter the document reference, its date and its 64-character SHA-256 fingerprint." },
  { pattern: /already used for different details/i, status: 409, code: "ALREADY_SUBMITTED_DIFFERENTLY",
    message: "This form was already submitted with different details. Reload and try again." },
  { pattern: /still in progress/i, status: 409, code: "IN_PROGRESS",
    message: "This request is still being processed. Try again in a moment." },
  { pattern: /not found in this legal entity|not an active shareholder of this legal entity/i, status: 404, code: "NOT_FOUND",
    message: "This record was not found for your company." },
  { pattern: /required|characters|unknown or missing/i, status: 422, code: "VALIDATION_FAILED",
    message: "Some details are missing or too long." }
];

export function shareholderSetupErrorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  const sqlState = error !== null && typeof error === "object" && "code" in error
    ? String((error as { readonly code: unknown }).code) : "";
  if (sqlState === "42501" || error instanceof SandboxAuthError || (error instanceof IdentityError && error.code === "AUTHENTICATION_REQUIRED")) {
    const sessionEnded = error instanceof IdentityError || (error instanceof SandboxAuthError && error.code === "AUTHENTICATION_REQUIRED")
      || /sign in|session|proof/i.test(message);
    return json({ ok: false, error: sessionEnded
      ? { code: "AUTHENTICATION_REQUIRED", message: "Sign in to continue." }
      : { code: "PERMISSION_DENIED", message: "You do not have permission to manage shareholders." } }, sessionEnded ? 401 : 403);
  }
  if (error instanceof IdentityError) {
    return json({ ok: false, error: { code: "VALIDATION_FAILED", message: error.message } }, 422);
  }
  const known = message === "" ? undefined : SETUP_REFUSALS.find((refusal) => refusal.pattern.test(message));
  if (known !== undefined) return json({ ok: false, error: { code: known.code, message: known.message } }, known.status);
  if (sqlState === "40001") {
    return json({ ok: false, error: { code: "STALE_VERSION", message: "Someone else changed this meanwhile. Reload and try again." } }, 409);
  }
  if (["22P02", "22007", "22008", "22023", "23514", "23503"].includes(sqlState)) {
    return json({ ok: false, error: { code: "VALIDATION_FAILED", message: "Some details are not valid." } }, 422);
  }
  if (sqlState === "23505") {
    return json({ ok: false, error: { code: "DUPLICATE", message: "This record already exists." } }, 409);
  }
  if (error instanceof TreasuryUnavailableError || sqlState === "42883" || sqlState === "42P01") {
    return json({ ok: false, error: { code: "SERVICE_UNAVAILABLE", message: "Shareholder setup is not installed on this server." } }, 503);
  }
  console.error("Unexpected shareholder setup failure", sqlState || (error instanceof Error ? error.name : "unknown"));
  return json({ ok: false, error: { code: "INTERNAL_ERROR", message: "The request failed unexpectedly. Nothing was changed." } }, 500);
}
