import { randomUUID } from "node:crypto";

import type {
  ShareholderCapitalCustodyDecisionRequest,
  ShareholderCapitalMappingConfigureRequest,
  ShareholderCapitalPostingDecisionRequest,
  ShareholderCapitalPostingPostRequest,
  ShareholderCapitalPostingPrepareRequest,
  ShareholderCapitalReceiptRecordRequest,
  ShareholderFinanceCapability
} from "@abos/contracts";
import { cookies } from "next/headers";
import { SandboxAuthenticator } from "@abos/sandbox-auth";

import { financeHandoffRuntime } from "@/server/finance-handoff";
import { restrictedFinanceAuthenticator, operationalFinanceErrorResponse } from "@/server/operational-finance";
import { SESSION_COOKIE, treasuryRuntime } from "@/server/treasury";

const unavailable: ShareholderFinanceCapability = {
  state: "SCHEMA_NOT_AVAILABLE", schemaInstalled: false, mutationAvailable: false,
  reviewModeAvailable: false, requiredSessionProvenance: "PASSWORD_OPERATIONAL",
  reason: "The coordinated Shareholders to Finance database capability is not installed."
};

async function token(): Promise<string> {
  const value = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!value) throw Object.assign(new Error("Your session has ended."), { code: "42501" });
  return value;
}

function commandMeta(request: Request) {
  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  const correlationId = request.headers.get("x-correlation-id")?.trim() || randomUUID();
  if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 200) {
    throw Object.assign(new Error("A stable idempotency key is required."), { code: "22023" });
  }
  return { idempotencyKey, correlationId };
}

function schemaMissing(error: unknown): boolean {
  const code = error !== null && typeof error === "object" && "code" in error
    ? String((error as { code: unknown }).code) : "";
  return code === "42883" || code === "42P01";
}

export async function shareholderFinanceCapability(): Promise<ShareholderFinanceCapability> {
  if (process.env.NODE_ENV !== "production" && process.env.ABOS_SHAREHOLDER_FINANCE_REVIEW_MODE === "1") {
    return { ...unavailable, reviewModeAvailable: true };
  }
  try {
    const finance = financeHandoffRuntime();
    return await restrictedFinanceAuthenticator().shareholderFinanceCapability(finance.executor, await token());
  } catch (error) {
    if (schemaMissing(error) || (error instanceof Error && error.name === "TreasuryUnavailableError")) return unavailable;
    throw error;
  }
}

export async function configureCapitalMapping(request: Request, input: ShareholderCapitalMappingConfigureRequest) {
  const finance = financeHandoffRuntime();
  return restrictedFinanceAuthenticator().configureShareholderCapitalMapping(
    finance.executor, await token(), { ...input, ...commandMeta(request) });
}

export async function recordCapitalReceipt(request: Request, input: ShareholderCapitalReceiptRecordRequest) {
  const runtime = treasuryRuntime();
  const authenticator = new SandboxAuthenticator(runtime.executor, runtime.configuration);
  return authenticator.recordShareholderCapitalReceipt(
    runtime.executor, await token(), { ...input, ...commandMeta(request) });
}

export async function verifyCapitalCustody(request: Request, receiptId: string,
  input: ShareholderCapitalCustodyDecisionRequest) {
  const runtime = treasuryRuntime();
  const authenticator = new SandboxAuthenticator(runtime.executor, runtime.configuration);
  return authenticator.verifyShareholderCapitalCustody(
    runtime.executor, await token(), receiptId, { ...input, ...commandMeta(request) });
}

export async function prepareCapitalPosting(request: Request, receiptId: string,
  input: ShareholderCapitalPostingPrepareRequest) {
  const finance = financeHandoffRuntime();
  return restrictedFinanceAuthenticator().prepareShareholderCapitalPosting(
    finance.executor, await token(), receiptId, { ...input, ...commandMeta(request) });
}

export async function decideCapitalPosting(request: Request, postingIntentId: string,
  input: ShareholderCapitalPostingDecisionRequest) {
  const finance = financeHandoffRuntime();
  return restrictedFinanceAuthenticator().decideShareholderCapitalPosting(
    finance.executor, await token(), postingIntentId, { ...input, ...commandMeta(request) });
}

export async function postCapitalReceipt(request: Request, postingIntentId: string,
  input: ShareholderCapitalPostingPostRequest) {
  const finance = financeHandoffRuntime();
  return restrictedFinanceAuthenticator().postShareholderCapitalReceipt(
    finance.executor, await token(), postingIntentId, { ...input, ...commandMeta(request) });
}

export async function capitalTrace(contributionId: string) {
  const finance = financeHandoffRuntime();
  return restrictedFinanceAuthenticator().shareholderCapitalTrace(
    finance.executor, await token(), contributionId);
}

export async function shareholderFinanceCapabilityResponse(request?: Request): Promise<Response> {
  const correlationId = request?.headers.get("x-correlation-id")?.trim() || randomUUID();
  try {
    const capability = await shareholderFinanceCapability();
    if (capability.state === "SCHEMA_NOT_AVAILABLE") {
      return Response.json({ ok: false, error: { code: capability.state, message: capability.reason,
        retryable: false }, capability, correlationId }, { status: 503, headers: { "cache-control": "no-store" } });
    }
    return Response.json({ ok: true, data: capability, correlationId },
      { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return operationalFinanceErrorResponse(error);
  }
}

/**
 * Configuration must remain reachable after 0036 is installed but before the operational
 * prerequisites are complete. The restricted database function still derives the live actor and
 * legal entity and requires finance.capital-receipt.configure; this check only distinguishes an
 * absent schema from an intentionally NOT_OPERATIONAL configuration state.
 */
export async function shareholderFinanceSchemaUnavailableResponse(request?: Request): Promise<Response | undefined> {
  const correlationId = request?.headers.get("x-correlation-id")?.trim() || randomUUID();
  try {
    const capability = await shareholderFinanceCapability();
    if (capability.schemaInstalled) return undefined;
    return Response.json({ ok: false, error: { code: capability.state, message: capability.reason,
      retryable: false }, capability, correlationId }, { status: 503, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return operationalFinanceErrorResponse(error);
  }
}

/**
 * Keep every operational bridge route closed when 0036 is unavailable. This check intentionally
 * runs before body parsing so review-mode routes cannot accidentally expose a partial in-memory
 * implementation; the database entry point still performs its own live permission checks.
 */
export async function shareholderFinanceUnavailableResponse(request?: Request): Promise<Response | undefined> {
  const correlationId = request?.headers.get("x-correlation-id")?.trim() || randomUUID();
  try {
    const capability = await shareholderFinanceCapability();
    if (capability.state === "OPERATIONAL" && capability.schemaInstalled && capability.mutationAvailable) {
      return undefined;
    }
    return Response.json({ ok: false, error: { code: capability.state, message: capability.reason,
      retryable: false }, capability, correlationId }, { status: 503, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return operationalFinanceErrorResponse(error);
  }
}

export { operationalFinanceErrorResponse as shareholderFinanceErrorResponse };
