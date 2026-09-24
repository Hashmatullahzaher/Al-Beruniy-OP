import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import pg from "pg";

import type { LegalEntityId, ServerActorContext, TreasuryPermission, UserAccountId } from "@abos/contracts";
import {
  PostgresExecutor, RestrictedTreasuryGateway, RestrictedTreasuryRepository
} from "@abos/persistence";
import {
  readSandboxConfiguration,
  SandboxAuthError,
  type SandboxAuthConfiguration
} from "@abos/sandbox-auth";
import { TreasuryDomainError, TreasuryService, type TreasuryActor } from "@abos/treasury";

/**
 * Server-only Treasury runtime for the web app.
 *
 * Imported by route handlers only. The browser never sees a database URL, a signing secret or a
 * bearer token: the token lives in an httpOnly, SameSite=Strict cookie, and every request rebuilds
 * the actor from persisted grants. Nothing here falls back to a default user, a default secret or
 * a default database - an unconfigured server answers 503, not a demo.
 */

export const SESSION_COOKIE = "abos_sandbox_session";

// numeric stays exact decimal text end to end.
pg.types.setTypeParser(1700, (value: string) => value);

interface TreasuryRuntime {
  readonly pool: pg.Pool;
  readonly executor: PostgresExecutor;
  readonly gateway: RestrictedTreasuryGateway;
  readonly configuration: SandboxAuthConfiguration;
}

export class TreasuryUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TreasuryUnavailableError";
  }
}

const globalRuntime = globalThis as typeof globalThis & { __abosTreasuryRuntime?: TreasuryRuntime };

export function treasuryRuntime(): TreasuryRuntime {
  if (globalRuntime.__abosTreasuryRuntime !== undefined) return globalRuntime.__abosTreasuryRuntime;
  const url = process.env.ABOS_TREASURY_DATABASE_URL;
  if (url === undefined || url.trim() === "") {
    throw new TreasuryUnavailableError("The E1 Treasury sandbox requires ABOS_TREASURY_DATABASE_URL with the restricted Treasury credential.");
  }
  let configuration: SandboxAuthConfiguration;
  try {
    configuration = readSandboxConfiguration(process.env);
  } catch (error) {
    throw new TreasuryUnavailableError(error instanceof Error ? error.message : "Sandbox configuration is invalid");
  }
  const pool = new pg.Pool({ connectionString: url, max: 6 });
  const executor = new PostgresExecutor(pool, { runtimeMarker: configuration.runtimeMarker });
  const runtime = { pool, executor, configuration, gateway: new RestrictedTreasuryGateway(executor) };
  globalRuntime.__abosTreasuryRuntime = runtime;
  return runtime;
}

export interface TreasuryRequestContext {
  readonly runtime: TreasuryRuntime;
  readonly context: ServerActorContext;
  readonly actor: TreasuryActor;
  readonly displayName: string;
  readonly service: TreasuryService;
  readonly reader: RestrictedTreasuryRepository;
}

/** Authenticates the session cookie. Throws AUTHENTICATION_REQUIRED when there is none. */
export async function currentTreasury(): Promise<TreasuryRequestContext> {
  const runtime = treasuryRuntime();
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (token === undefined || token.length === 0) {
    throw new SandboxAuthError("AUTHENTICATION_REQUIRED", "Sign in with a sandbox session token to use Treasury.");
  }
  const session = await runtime.gateway.context(token);
  const legalEntityId = session.legalEntityId as LegalEntityId;
  const treasuryPermissions = session.treasuryPermissions as readonly TreasuryPermission[];
  const context: ServerActorContext = {
    userAccountId: session.userAccountId as UserAccountId,
    legalEntityIds: [legalEntityId], projectIds: [], departmentIds: [], costCenterIds: [],
    permissions: [], treasuryPermissions, authenticatedAt: new Date().toISOString(),
    sessionId: session.sessionId, expiresAt: session.expiresAt
  };
  const actor: TreasuryActor = {
    userAccountId: context.userAccountId,
    legalEntityId,
    treasuryPermissions,
    sessionId: context.sessionId ?? ""
  };
  const repository = new RestrictedTreasuryRepository(
    runtime.gateway, { bearerToken: token, legalEntityId }
  );
  return {
    runtime,
    context,
    actor,
    displayName: session.displayName,
    service: new TreasuryService(repository),
    reader: repository
  };
}

export function hasTreasuryPermission(actor: TreasuryActor, permission: TreasuryPermission): boolean {
  return actor.treasuryPermissions.includes(permission);
}

export async function displayNames(reader: RestrictedTreasuryRepository, entity: LegalEntityId, ids: readonly string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id) => id.length > 0))];
  if (unique.length === 0) return new Map();
  const rows = await reader.listUsers(entity);
  return new Map(rows.filter((row) => unique.includes(String(row.id)))
    .map((row) => [row.id as UserAccountId, String(row.display_name)]));
}

/**
 * Rejects cross-site writes. The session cookie is SameSite=Strict already; this also refuses a
 * request whose Origin is present and is not this host.
 */
export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (origin !== null && host !== null && new URL(origin).host !== host) {
    throw new SandboxAuthError("PERMISSION_DENIED", "Cross-origin Treasury requests are refused.");
  }
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await request.json();
    return body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === "string" ? value : "";
}

const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  AUTHENTICATION_REQUIRED: 401,
  PERMISSION_DENIED: 403,
  SEGREGATION_OF_DUTIES_VIOLATION: 403,
  SCOPE_MISMATCH: 403,
  NOT_FOUND: 404,
  IDEMPOTENCY_CONFLICT: 409,
  POSTED_RECORD_IMMUTABLE: 409,
  POLICY_CONFIGURATION_PENDING: 503
};

/**
 * Every refusal is reported as what it is. A database guard's own message is returned, because it
 * was written to be read; an unexpected failure is reported as one, without internals.
 */
export function errorResponse(error: unknown): NextResponse {
  if (error instanceof TreasuryUnavailableError) {
    return json({ ok: false, error: { code: "TREASURY_UNAVAILABLE", message: error.message } }, 503);
  }
  if (error instanceof TreasuryDomainError || error instanceof SandboxAuthError) {
    return json({ ok: false, error: { code: error.code, message: error.message } }, STATUS_BY_CODE[error.code] ?? 422);
  }
  const sqlState = error !== null && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
  const message = error instanceof Error ? error.message : "Unknown error";
  if (sqlState === "P0001" || sqlState === "23514" || sqlState === "42501") {
    return json({ ok: false, error: { code: "REFUSED_BY_DATABASE", message } }, 422);
  }
  if (sqlState === "23505") {
    return json({ ok: false, error: { code: "IDEMPOTENCY_CONFLICT", message: "This record already exists." } }, 409);
  }
  if (sqlState === "23503") {
    return json({ ok: false, error: { code: "REFUSED_BY_DATABASE", message: "A referenced record does not exist or belongs elsewhere." } }, 422);
  }
  console.error("Unexpected Treasury failure", error);
  return json({ ok: false, error: { code: "INTERNAL_ERROR", message: "The Treasury request failed unexpectedly. Nothing was reported as successful." } }, 500);
}

export function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store", "X-ABOS-Data": "synthetic-sandbox" }
  });
}
