import { IdentityError } from "@abos/identity";

import { financeHandoffRuntime, financeToken } from "@/server/finance-handoff";
import { errorResponse, json } from "@/server/treasury";

/**
 * User-managed Chart of Accounts through the restricted Finance login only (migration 0014). The
 * session token is the only identity passed to the database; every rule is enforced there.
 */

export type AccountType = "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE";
export type ControlType = "CASH" | "SARAF" | "SHAREHOLDER_CAPITAL" | "SHAREHOLDER_LOAN" | "AR" | "AP" | "OTHER";
export type ReviewState = "PENDING_REVIEW" | "REVIEWED" | "FLAGGED";

export interface DuplicateWarning {
  readonly accountId: string; readonly code: string; readonly name: string; readonly nameFa: string | null;
  readonly type: AccountType; readonly currency: string | null; readonly controlType: ControlType | null; readonly status: string;
  readonly similarity: number; readonly reasons: readonly string[]; readonly severity: "LIKELY" | "POSSIBLE";
}

export interface AccountUsage {
  readonly inUse: boolean; readonly journalLines: number; readonly postedJournalLines: number; readonly safeAccounts: number;
  readonly openSafeAccounts: number; readonly references: readonly string[]; readonly pendingPostingIntents: number;
  readonly children: number; readonly activeChildren: number;
}

export interface LedgerAccountView {
  readonly id: string; readonly code: string; readonly name: string; readonly nameFa: string | null; readonly description: string | null;
  readonly type: AccountType; readonly controlType: ControlType | null; readonly currency: string | null; readonly parentId: string | null;
  readonly postingAllowed: boolean; readonly requiresProject: boolean; readonly requiresDepartment: boolean; readonly requiresCostCenter: boolean;
  readonly status: "DRAFT" | "ACTIVE" | "INACTIVE"; readonly createdAt: string; readonly origin: "APP" | "PRE_EXISTING"; readonly version: number;
  readonly reviewState: ReviewState | null; readonly reviewReason: "CREATED" | "CHANGED" | null;
  readonly createdBy: string | null; readonly lastChangedBy: string | null; readonly lastChangedAt: string | null;
  readonly lastReviewedBy: string | null; readonly lastReviewedAt: string | null; readonly lastReviewNote: string | null;
  readonly duplicateWarnings: readonly DuplicateWarning[]; readonly viewerIsParticipant: boolean; readonly usage: AccountUsage;
  readonly reviews: readonly { readonly decision: "REVIEWED" | "FLAGGED"; readonly note: string | null; readonly version: number; readonly reviewer: string; readonly decidedAt: string }[];
}

export interface ChartOfAccountsView {
  readonly canManage: boolean; readonly canReview: boolean;
  readonly actor: { readonly displayName: string } | null;
  readonly legalEntity: { readonly id: string; readonly name: string; readonly baseCurrency: string | null };
  readonly currencies: readonly { readonly code: string; readonly name: string }[];
  readonly accounts: readonly LedgerAccountView[];
  readonly reviewQueue: number;
}

/** The fields a person may set. Absent keys are left unchanged on an edit. */
export interface AccountInput {
  readonly code?: string; readonly name?: string; readonly nameFa?: string | null; readonly description?: string | null;
  readonly type?: string; readonly controlType?: string | null; readonly currency?: string | null; readonly parentId?: string | null;
  readonly postingAllowed?: boolean; readonly requiresProject?: boolean; readonly requiresDepartment?: boolean; readonly requiresCostCenter?: boolean;
}

const TEXT_FIELDS = ["code", "name", "nameFa", "description", "type", "controlType", "currency", "parentId"] as const;
const BOOLEAN_FIELDS = ["postingAllowed", "requiresProject", "requiresDepartment", "requiresCostCenter"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Keeps only known fields of the right JSON type; the database refuses anything else anyway. */
export function accountInput(value: unknown): AccountInput {
  const source = value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const result: Record<string, string | boolean | null> = {};
  for (const key of TEXT_FIELDS) {
    if (!(key in source)) continue;
    const field = source[key];
    if (typeof field === "string" || field === null) result[key] = field;
  }
  for (const key of BOOLEAN_FIELDS) {
    if (typeof source[key] === "boolean") result[key] = source[key];
  }
  return result as AccountInput;
}

export function isAccountId(value: string): boolean {
  return UUID.test(value);
}

async function call<T>(sql: string, parameters: readonly unknown[]): Promise<T> {
  const result = await financeHandoffRuntime().executor.query<{ value: T }>(sql, parameters);
  const value = result.rows[0]?.value;
  if (value === undefined) throw new Error("The Chart of Accounts function returned no result.");
  return value;
}

export async function chartOfAccountsView(): Promise<ChartOfAccountsView> {
  return call("SELECT abos.finance_ledger_accounts_view($1) AS value", [await financeToken()]);
}

export async function checkAccount(account: AccountInput, accountId: string | null): Promise<{ codeTaken: { accountId: string; code: string; name: string } | null; warnings: readonly DuplicateWarning[] }> {
  return call("SELECT abos.finance_ledger_account_check($1, $2::jsonb, $3) AS value",
    [await financeToken(), JSON.stringify(account), accountId !== null && isAccountId(accountId) ? accountId : null]);
}

export async function createAccount(account: AccountInput, confirmDuplicates: boolean): Promise<{ account: LedgerAccountView; warnings: readonly DuplicateWarning[] }> {
  return call("SELECT abos.finance_ledger_account_create($1, $2::jsonb, $3) AS value", [await financeToken(), JSON.stringify(account), confirmDuplicates]);
}

export async function updateAccount(accountId: string, expectedVersion: number, changes: AccountInput, confirmDuplicates: boolean): Promise<{ account: LedgerAccountView; warnings: readonly DuplicateWarning[]; changed: boolean }> {
  return call("SELECT abos.finance_ledger_account_update($1, $2, $3, $4::jsonb, $5) AS value",
    [await financeToken(), accountId, expectedVersion, JSON.stringify(changes), confirmDuplicates]);
}

export async function setAccountStatus(accountId: string, expectedVersion: number, status: string, reason: string | null): Promise<{ account: LedgerAccountView; changed: boolean }> {
  return call("SELECT abos.finance_ledger_account_set_status($1, $2, $3, $4, $5) AS value", [await financeToken(), accountId, expectedVersion, status, reason]);
}

export async function reviewAccount(accountId: string, expectedVersion: number, decision: string, note: string | null): Promise<{ account: LedgerAccountView }> {
  return call("SELECT abos.finance_ledger_account_review($1, $2, $3, $4, $5) AS value", [await financeToken(), accountId, expectedVersion, decision, note]);
}

export function accountNotFound() {
  return json({ ok: false, error: { code: "ACCOUNT_NOT_FOUND", message: "Ledger account not found." } }, 404);
}

function warningsFrom(detail: unknown): readonly DuplicateWarning[] {
  if (typeof detail !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(detail);
    return Array.isArray(parsed) ? parsed as DuplicateWarning[] : [];
  } catch {
    return [];
  }
}

/** Database refusals become readable, typed API errors. */
export function chartErrorResponse(error: unknown) {
  if (error instanceof IdentityError) {
    return json({ ok: false, error: { code: error.code, message: error.message } }, error.code === "VALIDATION_FAILED" ? 415 : 400);
  }
  const code = error !== null && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
  const message = error instanceof Error ? error.message : "";
  if (code === "42501" && /session is invalid|authorization is not active|bearer credential/.test(message)) {
    return json({ ok: false, error: { code: "AUTHENTICATION_REQUIRED", message: "Your session has ended. Sign in again." } }, 401);
  }
  if (code === "42501" && /authority is missing/.test(message)) {
    return json({ ok: false, error: { code: "PERMISSION_DENIED", message: "You do not have permission to do this in the Chart of Accounts." } }, 403);
  }
  if (code === "ABC01") {
    const detail = (error as { detail?: unknown }).detail;
    return json({ ok: false, error: { code: "DUPLICATE_CONFIRMATION_REQUIRED", message, warnings: warningsFrom(detail) } }, 409);
  }
  if (code === "ABC02") return json({ ok: false, error: { code: "ACCOUNT_IN_USE", message } }, 409);
  if (code === "ABC03") return json({ ok: false, error: { code: "REVIEW_INDEPENDENCE", message } }, 403);
  if (code === "23505") return json({ ok: false, error: { code: "ACCOUNT_CODE_TAKEN", message } }, 409);
  if (code === "40001") return json({ ok: false, error: { code: "STALE_VERSION", message } }, 409);
  if (code === "P0002") return accountNotFound();
  if (code === "23514" || code === "23503" || code === "22023" || code === "22P02") {
    return json({ ok: false, error: { code: "ACCOUNT_VALIDATION", message } }, 422);
  }
  return errorResponse(error);
}
