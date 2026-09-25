import { createHmac } from "node:crypto";

import { cookies } from "next/headers";
import pg from "pg";

import { IdentityError, IdentityService, type IdentityErrorCode, type LoginResult } from "@abos/identity";
import { PostgresExecutor } from "@abos/persistence";
import { readSandboxConfiguration, SandboxAuthenticator } from "@abos/sandbox-auth";

import { assertSameOrigin, json, SESSION_COOKIE, TreasuryUnavailableError } from "@/server/treasury";

/**
 * Server-only identity runtime.
 *
 * Uses its own restricted database login (ABOS_IDENTITY_DATABASE_URL), which inherits only
 * abos_v1_identity_runtime: identity tables, no Treasury, Finance or ledger access. The session
 * token lives only in the httpOnly, SameSite=Strict cookie; the browser never receives it in a body.
 */

pg.types.setTypeParser(1700, (value: string) => value);

interface IdentityRuntime { readonly pool: pg.Pool; readonly service: IdentityService }
const globalRuntime = globalThis as typeof globalThis & { __abosIdentityRuntime?: IdentityRuntime };

export function identityRuntime(): IdentityRuntime {
  if (globalRuntime.__abosIdentityRuntime !== undefined) return globalRuntime.__abosIdentityRuntime;
  const url = process.env.ABOS_IDENTITY_DATABASE_URL;
  if (url === undefined || url.trim() === "") {
    throw new TreasuryUnavailableError("Sign-in is not configured on this server (ABOS_IDENTITY_DATABASE_URL is unset).");
  }
  if (url === process.env.ABOS_DATABASE_URL) {
    throw new TreasuryUnavailableError("Sign-in must use its own restricted database login, not the administration credential.");
  }
  let configuration;
  try {
    configuration = readSandboxConfiguration(process.env);
  } catch (error) {
    throw new TreasuryUnavailableError(error instanceof Error ? error.message : "Sandbox configuration is invalid");
  }
  const pool = new pg.Pool({ connectionString: url, max: 6 });
  const executor = new PostgresExecutor(pool, { runtimeMarker: configuration.runtimeMarker });
  // A separate key for login-attempt digests, derived from the signing secret so no new secret is needed.
  const attemptKeySecret = createHmac("sha256", configuration.signingSecret).update("abos-login-attempt-keys-v1").digest("hex");
  const service = new IdentityService(executor, new SandboxAuthenticator(executor, configuration), { attemptKeySecret });
  globalRuntime.__abosIdentityRuntime = { pool, service };
  return globalRuntime.__abosIdentityRuntime;
}

export async function sessionToken(): Promise<string> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (token === undefined || token.length === 0) throw new IdentityError("AUTHENTICATION_REQUIRED", "Sign in to continue.");
  return token;
}

export async function setSessionCookie(result: LoginResult): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, result.token, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: new Date(result.expiresAt)
  });
}

export async function clearSessionCookie(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}

/**
 * The client address, used only as a throttling key. X-Forwarded-For is client-controlled unless a
 * trusted reverse proxy overwrites it, so it is believed only when ABOS_TRUST_PROXY=1. Otherwise
 * there is no trustworthy address and per-client throttling is skipped (per-account lockout still
 * applies); a shared placeholder key would let one attacker lock everybody out.
 */
export function clientAddress(request: Request): string | null {
  if (process.env.ABOS_TRUST_PROXY !== "1") return null;
  const forwarded = request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim();
  return forwarded && forwarded.length > 0 ? forwarded : null;
}

/** Mutations must be same-origin JSON. */
export function assertMutation(request: Request): void {
  assertSameOrigin(request);
  const type = request.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("application/json")) {
    throw new IdentityError("VALIDATION_FAILED", "Requests must be sent as JSON.");
  }
}

const STATUS: Readonly<Record<IdentityErrorCode, number>> = {
  AUTHENTICATION_REQUIRED: 401,
  INVALID_CREDENTIALS: 401,
  PASSWORD_CHANGE_REQUIRED: 403,
  TEMPORARY_PASSWORD_EXPIRED: 403,
  ACCOUNT_INACTIVE: 403,
  NO_ACCESS_ASSIGNED: 403,
  THROTTLED: 429,
  PERMISSION_DENIED: 403,
  SELF_CHANGE_FORBIDDEN: 403,
  SUPER_ADMIN_REQUIRED: 403,
  LAST_SUPER_ADMIN: 409,
  NOT_FOUND: 404,
  DUPLICATE: 409,
  VALIDATION_FAILED: 422,
  STALE_VERSION: 409
};

export function identityErrorResponse(error: unknown) {
  if (error instanceof IdentityError) {
    return json({ ok: false, error: { code: error.code, message: error.message, details: error.details } }, STATUS[error.code]);
  }
  if (error instanceof TreasuryUnavailableError) {
    console.error("Identity service unavailable:", error.message);
    return json({ ok: false, error: { code: "SERVICE_UNAVAILABLE", message: "Sign-in is temporarily unavailable. Try again later." } }, 503);
  }
  if (error !== null && typeof error === "object" && "code" in error && (error as { code: unknown }).code === "PERMISSION_DENIED") {
    return json({ ok: false, error: { code: "PERMISSION_DENIED", message: (error as unknown as Error).message } }, 403);
  }
  console.error("Unexpected identity failure", error instanceof Error ? error.name : "unknown");
  return json({ ok: false, error: { code: "INTERNAL_ERROR", message: "The request failed unexpectedly. Nothing was changed." } }, 500);
}

export async function readBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await request.json();
    return body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function text(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === "string" ? value : "";
}

export function optionalText(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  return typeof value === "string" ? value : null;
}

export function stringList(body: Record<string, unknown>, key: string): string[] {
  const value = body[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** Developer token sign-in exists only for automated tests and local development. */
export function developerTokenSignInEnabled(): boolean {
  return process.env.ABOS_ALLOW_DEV_TOKEN_SIGNIN === "1" && process.env.NODE_ENV !== "production";
}
