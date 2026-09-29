import type {
  OperationalExpenseCategoryUpsert,
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
  if (["22000", "22008", "22023", "23503", "23514", "23P01", "P0001"].includes(sqlState)) {
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
