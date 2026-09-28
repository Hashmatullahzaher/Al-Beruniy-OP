import { IdentityError } from "@abos/identity";

import { financeHandoffRuntime, financeToken } from "@/server/finance-handoff";
import { errorResponse, json } from "@/server/treasury";

/**
 * Controlled reversal requests (backlog #17, migration 0023) through the restricted Finance login
 * only. The session token is the only identity passed to the database; the actor, the company,
 * scope and segregation of duties are all decided there.
 *
 * Posting an approved reversal is deliberately not implemented: the reversal date and period, the
 * evidence it needs and its effect on source records await the Finance Manager's policy. Amounts
 * cross this module as decimal text and are never converted to numbers.
 */

export type ReversalStatus = "REQUESTED" | "APPROVED" | "REJECTED" | "WITHDRAWN";
export type ReversalDecision = "APPROVED" | "REJECTED";

export interface ReversalJournalLine {
  readonly lineNumber: number; readonly accountCode: string; readonly accountName: string;
  readonly baseCurrency: string; readonly baseDebit: string; readonly baseCredit: string;
  readonly originalCurrency: string | null; readonly originalAmount: string | null;
}

export interface ReversalJournal {
  readonly id: string; readonly reference: string; readonly status: string;
  readonly accountingEffectiveDate: string; readonly accountingPeriodId: string; readonly postedAt: string | null;
  readonly baseCurrency: string; readonly intentKind: string; readonly sourceType: string; readonly postedBy: string | null;
  readonly viewerIsParticipant: boolean;
  readonly lines: readonly ReversalJournalLine[];
  readonly totals: readonly { readonly currency: string; readonly debits: string; readonly credits: string }[];
}

export interface ReversalRequestView {
  readonly id: string; readonly status: ReversalStatus; readonly reason: string; readonly version: number;
  readonly requestedBy: string; readonly requestedAt: string;
  readonly decidedBy: string | null; readonly decidedAt: string | null; readonly decisionNote: string | null;
  readonly viewerIsRequester: boolean; readonly viewerIsDecider: boolean;
  readonly posting: { readonly status: "AWAITING_POSTING_POLICY" | "NOT_APPLICABLE"; readonly reversalJournalId: null };
  readonly journal: ReversalJournal;
}

export interface ReversalWorkspaceView {
  readonly syntheticOnly: true;
  readonly canRequest: boolean; readonly canApprove: boolean;
  readonly actor: { readonly displayName: string } | null;
  readonly legalEntity: { readonly id: string; readonly name: string; readonly baseCurrency: string | null };
  readonly posting: { readonly available: false; readonly status: "AWAITING_POSTING_POLICY"; readonly pendingDecisions: readonly string[] };
  readonly conservativeRules: readonly string[];
  readonly requests: readonly ReversalRequestView[];
  readonly eligibleJournals: readonly ReversalJournal[];
  readonly eligibleLimit: number;
  readonly eligibleHasMore: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isReversalId(value: string): boolean {
  return UUID.test(value);
}

/** An integer version from a JSON body, or -1 (which the database refuses as stale). */
export function expectedVersion(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value < 2 ** 31 ? value : -1;
}

async function call<T>(sql: string, parameters: readonly unknown[]): Promise<T> {
  const result = await financeHandoffRuntime().executor.query<{ value: T }>(sql, parameters);
  const value = result.rows[0]?.value;
  if (value === undefined) throw new Error("The reversal function returned no result.");
  return value;
}

export async function reversalWorkspace(): Promise<ReversalWorkspaceView> {
  return call("SELECT abos.finance_reversal_requests_view($1) AS value", [await financeToken()]);
}

export async function requestReversal(journalId: string, reason: string): Promise<{ request: ReversalRequestView; created: boolean }> {
  return call("SELECT abos.finance_reversal_request_create($1, $2::uuid, $3) AS value", [await financeToken(), journalId, reason]);
}

export async function decideReversal(requestId: string, version: number, decision: string, note: string | null): Promise<{ request: ReversalRequestView; changed: boolean }> {
  return call("SELECT abos.finance_reversal_request_decide($1, $2::uuid, $3, $4, $5) AS value", [await financeToken(), requestId, version, decision, note]);
}

export async function withdrawReversal(requestId: string, version: number, note: string | null): Promise<{ request: ReversalRequestView; changed: boolean }> {
  return call("SELECT abos.finance_reversal_request_withdraw($1, $2::uuid, $3, $4) AS value", [await financeToken(), requestId, version, note]);
}

export function reversalNotFound() {
  return json({ ok: false, error: { code: "NOT_FOUND", message: "That journal or reversal request was not found." } }, 404);
}

/** Database refusals become readable, typed API errors. */
export function reversalErrorResponse(error: unknown) {
  if (error instanceof IdentityError) {
    return json({ ok: false, error: { code: error.code, message: error.message } }, error.code === "VALIDATION_FAILED" ? 415 : 400);
  }
  const code = error !== null && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
  const message = error instanceof Error ? error.message : "";
  if (code === "42501" && /session is invalid|authorization is not active|bearer credential/.test(message)) {
    return json({ ok: false, error: { code: "AUTHENTICATION_REQUIRED", message: "Your session has ended. Sign in again." } }, 401);
  }
  if (code === "42501" && /authority is missing/.test(message)) {
    return json({ ok: false, error: { code: "PERMISSION_DENIED", message: "You do not have permission to do this with reversals." } }, 403);
  }
  if (code === "ABR01") return json({ ok: false, error: { code: "REVERSAL_INDEPENDENCE", message } }, 403);
  if (code === "ABR02") return json({ ok: false, error: { code: "REVERSAL_STATE", message } }, 409);
  if (code === "23505") return json({ ok: false, error: { code: "REVERSAL_ALREADY_OPEN", message } }, 409);
  if (code === "40001") return json({ ok: false, error: { code: "STALE_VERSION", message } }, 409);
  if (code === "P0002") return reversalNotFound();
  if (code === "23514" || code === "22023" || code === "22P02") {
    return json({ ok: false, error: { code: "REVERSAL_VALIDATION", message } }, 422);
  }
  return errorResponse(error);
}
