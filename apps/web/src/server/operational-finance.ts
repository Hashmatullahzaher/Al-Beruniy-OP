import type {
  OperationalExpenseApproveBody,
  OperationalExpenseCategoryUpsert,
  OperationalExpenseCreate,
  OperationalExpenseMutationResult,
  OperationalExpenseWorkspace,
  OperationalExpenseWorkspaceQuery,
  OperationalFinanceConfigurationWorkspace,
  OperationalPeriodOpen,
  OperationalTreasuryAccountUpsert
} from "@abos/contracts";
import { IdentityError } from "@abos/identity";
import { cookies } from "next/headers";
import {
  readSandboxConfiguration,
  SandboxAuthenticator,
  SandboxAuthError
} from "@abos/sandbox-auth";

import { financeHandoffRuntime } from "@/server/finance-handoff";
import { json, SESSION_COOKIE, TreasuryUnavailableError } from "@/server/treasury";

/**
 * Server-only adapter for the protected Operational V1 Finance configuration functions.
 *
 * The existing restricted ABOS_FINANCE_DATABASE_URL is reused. The browser supplies only the
 * httpOnly session cookie and validated business fields; the proof and both token digests are
 * created on the server by SandboxAuthenticator. Actor and legal entity are resolved in PostgreSQL.
 */
interface OperationalFinanceRuntime {
  readonly authenticator: SandboxAuthenticator;
}

const globalRuntime = globalThis as typeof globalThis & {
  __abosOperationalFinanceRuntime?: OperationalFinanceRuntime;
};

function operationalFinanceRuntime(): OperationalFinanceRuntime {
  if (globalRuntime.__abosOperationalFinanceRuntime !== undefined) {
    return globalRuntime.__abosOperationalFinanceRuntime;
  }
  const url = process.env.ABOS_FINANCE_DATABASE_URL;
  if (url === undefined || url.trim() === "" || url === process.env.ABOS_DATABASE_URL) {
    throw new TreasuryUnavailableError(
      "Operational Finance requires its dedicated restricted database credential."
    );
  }
  const finance = financeHandoffRuntime();
  let configuration;
  try {
    configuration = readSandboxConfiguration(process.env);
  } catch (error) {
    throw new TreasuryUnavailableError(
      error instanceof Error ? error.message : "Operational Finance configuration is invalid."
    );
  }
  const runtime = { authenticator: new SandboxAuthenticator(finance.executor, configuration) };
  globalRuntime.__abosOperationalFinanceRuntime = runtime;
  return runtime;
}

async function operationalFinanceToken(): Promise<string> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (token === undefined || token.length === 0) {
    throw new IdentityError("AUTHENTICATION_REQUIRED", "Sign in to use Operational Finance.");
  }
  return token;
}

export async function operationalFinanceConfiguration(): Promise<OperationalFinanceConfigurationWorkspace> {
  const finance = financeHandoffRuntime();
  return operationalFinanceRuntime().authenticator.operationalFinanceConfiguration(
    finance.executor,
    await operationalFinanceToken()
  );
}

export async function upsertOperationalTreasuryAccount(
  input: OperationalTreasuryAccountUpsert
): Promise<OperationalFinanceConfigurationWorkspace> {
  const finance = financeHandoffRuntime();
  return operationalFinanceRuntime().authenticator.upsertOperationalTreasuryAccount(
    finance.executor,
    await operationalFinanceToken(),
    input
  );
}

export async function upsertOperationalExpenseCategory(
  input: OperationalExpenseCategoryUpsert
): Promise<OperationalFinanceConfigurationWorkspace> {
  const finance = financeHandoffRuntime();
  return operationalFinanceRuntime().authenticator.upsertOperationalExpenseCategory(
    finance.executor,
    await operationalFinanceToken(),
    input
  );
}

export async function openOperationalFinancePeriod(
  input: OperationalPeriodOpen
): Promise<OperationalFinanceConfigurationWorkspace> {
  const finance = financeHandoffRuntime();
  return operationalFinanceRuntime().authenticator.openOperationalFinancePeriod(
    finance.executor,
    await operationalFinanceToken(),
    input
  );
}

export async function operationalExpenseWorkspace(
  query: OperationalExpenseWorkspaceQuery
): Promise<OperationalExpenseWorkspace> {
  const finance = financeHandoffRuntime();
  return operationalFinanceRuntime().authenticator.operationalExpenseWorkspace(
    finance.executor,
    await operationalFinanceToken(),
    query
  );
}

export async function createOperationalExpense(
  input: OperationalExpenseCreate
): Promise<OperationalExpenseMutationResult> {
  const finance = financeHandoffRuntime();
  return operationalFinanceRuntime().authenticator.createOperationalExpense(
    finance.executor,
    await operationalFinanceToken(),
    input
  );
}

export async function approveOperationalExpense(
  expenseId: string,
  input: OperationalExpenseApproveBody
): Promise<OperationalExpenseMutationResult> {
  const finance = financeHandoffRuntime();
  return operationalFinanceRuntime().authenticator.approveOperationalExpense(
    finance.executor,
    await operationalFinanceToken(),
    expenseId,
    input
  );
}

/**
 * Expense refusals the person can act on, matched on the database's own refusal messages (defined in
 * migration 0028 and the 0016 rate-snapshot helper). Anything else falls through to the generic
 * translation below, which never returns PostgreSQL internals.
 */
const EXPENSE_REFUSALS: readonly {
  readonly pattern: RegExp;
  readonly status: number;
  readonly code: string;
  readonly message: string;
}[] = [
  { pattern: /exchange rate is recorded for/i, status: 422, code: "RATE_MISSING",
    message: "No exchange rate is recorded for this date. Record the day's rate first." },
  { pattern: /choose which rate this transaction uses/i, status: 422, code: "RATE_CHOICE_REQUIRED",
    message: "Several exchange rates exist for this date. Choose which rate this expense uses." },
  { pattern: /not a current .* rate for/i, status: 422, code: "RATE_INVALID",
    message: "The chosen exchange rate is not a current rate for this date." },
  { pattern: /not exact; rounding policy is not approved/i, status: 422, code: "CONVERSION_NOT_EXACT",
    message: "This amount cannot be converted exactly at the chosen rate, and rounding rules are not approved yet." },
  { pattern: /open accounting period must cover|no open accounting period covers/i, status: 422, code: "PERIOD_NOT_OPEN",
    message: "No open accounting period covers this date." },
  { pattern: /approval policy is not configured/i, status: 422, code: "POLICY_NOT_CONFIGURED",
    message: "Expense approval settings are not configured for this company yet." },
  { pattern: /no approved base currency/i, status: 422, code: "BASE_CURRENCY_NOT_APPROVED",
    message: "The company's base currency is not approved yet." },
  { pattern: /same-entity Treasury account and expense category/i, status: 422, code: "ACCOUNT_OR_CATEGORY_UNAVAILABLE",
    message: "Choose an active Treasury account in the expense currency and an active expense category." },
  { pattern: /payee is not an active business party/i, status: 422, code: "PAYEE_UNAVAILABLE",
    message: "The selected payee is not active." },
  { pattern: /idempotency key was already used/i, status: 409, code: "ALREADY_SUBMITTED_DIFFERENTLY",
    message: "This expense was already submitted with different details. Start a new expense." },
  { pattern: /creator cannot approve/i, status: 403, code: "SEGREGATION_OF_DUTIES",
    message: "You cannot approve an expense you recorded." },
  { pattern: /outside the (actor|approver)'s live scope/i, status: 403, code: "OUTSIDE_SCOPE",
    message: "This expense is outside the projects, departments or cost centers you work with." },
  { pattern: /not waiting for approval/i, status: 409, code: "NOT_PENDING",
    message: "This expense is no longer waiting for approval." },
  { pattern: /expense changed; reload/i, status: 409, code: "STALE_VERSION",
    message: "This expense changed. Reload it and try again." },
  { pattern: /not available in this legal entity/i, status: 404, code: "NOT_FOUND",
    message: "The expense was not found." }
];

/** Translate an expense-entry-point failure into business language; unknown failures stay opaque. */
export function operationalExpenseErrorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  const known = message === "" ? undefined : EXPENSE_REFUSALS.find((refusal) => refusal.pattern.test(message));
  if (known !== undefined) {
    return json({ ok: false, error: { code: known.code, message: known.message } }, known.status);
  }
  return operationalFinanceErrorResponse(error);
}

/**
 * Security-sensitive API failures are intentionally translated without returning PostgreSQL
 * internals. Configuration and authority failures are actionable; unknown failures remain opaque.
 */
export function operationalFinanceErrorResponse(error: unknown) {
  if (error instanceof IdentityError) {
    const status = error.code === "AUTHENTICATION_REQUIRED" ? 401
      : error.code === "PERMISSION_DENIED" ? 403
        : error.code === "STALE_VERSION" ? 409
          : 422;
    return json({ ok: false, error: { code: error.code, message: error.message } }, status);
  }
  if (error instanceof TreasuryUnavailableError) {
    console.error("Operational Finance unavailable:", error.message);
    return json({ ok: false, error: {
      code: "SERVICE_UNAVAILABLE",
      message: "Operational Finance configuration is temporarily unavailable."
    } }, 503);
  }
  if (error instanceof SandboxAuthError) {
    const status = error.code === "AUTHENTICATION_REQUIRED" ? 401 : 403;
    return json({ ok: false, error: {
      code: error.code,
      message: status === 401 ? "Your session has ended. Sign in again." : "You do not have authority for this Finance configuration."
    } }, status);
  }

  const sqlState = error !== null && typeof error === "object" && "code" in error
    ? String((error as { readonly code: unknown }).code)
    : "";
  const message = error instanceof Error ? error.message : "";
  if (sqlState === "42501") {
    const sessionEnded = /session|credential|authorization is not active/i.test(message);
    return json({ ok: false, error: {
      code: sessionEnded ? "AUTHENTICATION_REQUIRED" : "PERMISSION_DENIED",
      message: sessionEnded ? "Your session has ended. Sign in again." : "You do not have authority for this Finance configuration."
    } }, sessionEnded ? 401 : 403);
  }
  if (sqlState === "40001") {
    return json({ ok: false, error: {
      code: "STALE_VERSION",
      message: "This configuration changed. Reload it and try again."
    } }, 409);
  }
  if (sqlState === "23505") {
    return json({ ok: false, error: {
      code: "DUPLICATE",
      message: "That account, mapping, reference, or category code is already in use."
    } }, 409);
  }
  if (sqlState === "P0002") {
    return json({ ok: false, error: {
      code: "NOT_FOUND",
      message: "The requested operational Finance record was not found."
    } }, 404);
  }
  if (["22000", "22008", "22023", "22P02", "23503", "23514", "23P01", "P0001"].includes(sqlState)) {
    return json({ ok: false, error: {
      code: "VALIDATION_FAILED",
      message: "The configuration was refused because it does not satisfy the operational Finance rules."
    } }, 422);
  }
  if (sqlState === "42P01" || sqlState === "42883") {
    return json({ ok: false, error: {
      code: "SERVICE_UNAVAILABLE",
      message: "Operational Finance configuration is not installed on this server."
    } }, 503);
  }
  console.error("Unexpected Operational Finance failure", sqlState || (error instanceof Error ? error.name : "unknown"));
  return json({ ok: false, error: {
    code: "INTERNAL_ERROR",
    message: "The request failed unexpectedly. Nothing was changed."
  } }, 500);
}
