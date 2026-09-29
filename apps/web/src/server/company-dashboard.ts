import type { CompanyDashboardSummary } from "@abos/contracts";
import { IdentityError } from "@abos/identity";
import { SandboxAuthError } from "@abos/sandbox-auth";

import { identityRuntime, sessionToken } from "@/server/identity";
import { restrictedFinanceAuthenticator } from "@/server/operational-finance";
import { financeHandoffRuntime } from "@/server/finance-handoff";
import { json } from "@/server/treasury";

export const COMPANY_DASHBOARD_PERMISSION = "company.dashboard.read";

/**
 * Where the company dashboard at "/" may go for the current request, decided on the server before
 * anything is rendered: signed-out visitors sign in, people without the permission go to their own
 * workspace, and only permitted people see the dashboard.
 */
export async function companyDashboardAccess(): Promise<"allowed" | "sign-in" | "own-workspace"> {
  let token: string;
  try {
    token = await sessionToken();
  } catch {
    return "sign-in";
  }
  try {
    const user = await identityRuntime().service.currentUser(token);
    return user.permissions.includes(COMPANY_DASHBOARD_PERMISSION) ? "allowed" : "own-workspace";
  } catch {
    return "sign-in";
  }
}

/** Aggregate figures; PostgreSQL refuses anyone without company.dashboard.read. */
export async function companyDashboardSummary(): Promise<CompanyDashboardSummary> {
  const token = await sessionToken();
  return restrictedFinanceAuthenticator().companyDashboardSummary(financeHandoffRuntime().executor, token);
}

export function companyDashboardErrorResponse(error: unknown) {
  if (error instanceof IdentityError && error.code === "AUTHENTICATION_REQUIRED") {
    return json({ ok: false, error: { code: "AUTHENTICATION_REQUIRED", message: "Sign in to continue." } }, 401);
  }
  if (error instanceof SandboxAuthError) {
    const status = error.code === "AUTHENTICATION_REQUIRED" ? 401 : 403;
    return json({ ok: false, error: { code: status === 401 ? "AUTHENTICATION_REQUIRED" : "PERMISSION_DENIED",
      message: status === 401 ? "Sign in to continue." : "You do not have access to the company dashboard." } }, status);
  }
  const sqlState = error !== null && typeof error === "object" && "code" in error
    ? String((error as { readonly code: unknown }).code) : "";
  const message = error instanceof Error ? error.message : "";
  if (sqlState === "42501") {
    const sessionEnded = /sign in|session|proof/i.test(message);
    return json({ ok: false, error: sessionEnded
      ? { code: "AUTHENTICATION_REQUIRED", message: "Sign in to continue." }
      : { code: "PERMISSION_DENIED", message: "You do not have access to the company dashboard." } },
    sessionEnded ? 401 : 403);
  }
  if (sqlState === "42883" || sqlState === "42P01") {
    return json({ ok: false, error: { code: "SERVICE_UNAVAILABLE", message: "The company dashboard is not installed on this server." } }, 503);
  }
  console.error("Unexpected company dashboard failure", sqlState || (error instanceof Error ? error.name : "unknown"));
  return json({ ok: false, error: { code: "INTERNAL_ERROR", message: "The dashboard could not be loaded." } }, 500);
}
