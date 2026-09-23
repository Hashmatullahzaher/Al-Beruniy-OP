import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { SqlExecutor } from "@abos/database";
import { sandboxGateFingerprint } from "@abos/contracts";
import type {
  CostCenterId,
  DepartmentId,
  FinancePermission,
  LegalEntityId,
  ProjectId,
  SandboxAuthorization,
  SandboxLegalEntityScope,
  SandboxPostingGate,
  ServerActorContext,
  SupportedCurrency,
  UserAccountId
} from "@abos/contracts";
import type { SandboxAuthConfiguration } from "./configuration.ts";
import { assertSandbox, SandboxAuthError } from "./errors.ts";

export interface IssuedSandboxSession {
  readonly sessionId: string;
  /** Returned once. Only its peppered digest is stored. */
  readonly token: string;
  readonly userAccountId: UserAccountId;
  readonly legalEntityId: LegalEntityId;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

interface AuthorizationRow {
  readonly environment: "development" | "test";
  readonly configuration_state: "SYNTHETIC_TEST_ONLY";
  readonly policy_version_id: string;
  readonly real_posting_enabled: boolean;
  readonly runtime_marker: string;
  readonly authorized_by_user_account_id: UserAccountId;
  readonly authorized_at: Date | string;
  readonly expires_at: Date | string;
}

interface SessionRow {
  readonly id: string;
  readonly user_account_id: UserAccountId;
  readonly legal_entity_id: LegalEntityId;
  readonly issued_at: Date | string;
  readonly expires_at: Date | string;
  readonly revoked_at: Date | string | null;
  readonly user_status: string;
}

/**
 * Server-side authentication for the E1 sandbox.
 *
 * Three properties this exists to guarantee:
 *
 *  1. An actor's permissions and scopes are read from the database, never from the request. A
 *     caller cannot present a `ServerActorContext`; it can only present an opaque bearer token,
 *     and this module builds the context from persisted grants.
 *  2. There is no permissive default user, no hard-coded Finance superuser and no default signing
 *     secret. Every path that cannot prove authority throws.
 *  3. The sandbox gate is resolved from the target database, so the database decides whether it is
 *     a sandbox. This is finding F-3: `assertPolicyAllowsKernel` previously trusted a caller-
 *     supplied policy object.
 *
 * This is a sandbox adapter, not production identity. It has no password handling, no MFA, no
 * federation and no account lifecycle, and it must not be presented as production-ready.
 */
export class SandboxAuthenticator {
  private readonly database: SqlExecutor;
  private readonly configuration: SandboxAuthConfiguration;
  private readonly now: () => Date;

  constructor(
    database: SqlExecutor,
    configuration: SandboxAuthConfiguration,
    now: () => Date = () => new Date()
  ) {
    this.database = database;
    this.configuration = configuration;
    this.now = now;
  }

  /**
   * Resolves the gate from the database. Throws unless the database itself carries an unexpired
   * synthetic-only authorization whose runtime marker matches this process, and unless the legal
   * entity is inside the authorized scope.
   */
  async resolveGate(legalEntityId: LegalEntityId): Promise<SandboxPostingGate> {
    const authorization = await this.loadAuthorization();
    const scope = await this.database.query<{
      readonly legal_entity_id: LegalEntityId;
      readonly base_currency_code: SupportedCurrency;
      readonly authorized_at: Date | string;
    }>(
      `SELECT legal_entity_id, base_currency_code, authorized_at
         FROM abos.sandbox_legal_entity_scopes
        WHERE legal_entity_id = $1`,
      [legalEntityId]
    );
    const row = scope.rows[0];
    assertSandbox(
      row !== undefined,
      "SCOPE_MISMATCH",
      `Legal entity ${legalEntityId} is not inside the authorized E1 sandbox scope`
    );
    const entityScope: SandboxLegalEntityScope = {
      legalEntityId: row.legal_entity_id,
      baseCurrency: row.base_currency_code,
      authorizedAt: iso(row.authorized_at)
    };
    const unsigned = {
      authorization,
      scope: entityScope,
      resolvedAt: this.now().toISOString()
    };
    return Object.freeze({ ...unsigned, signature: this.signGate(unsigned) });
  }

  /**
   * Issues a short-lived sandbox credential. Requires an already-authorized sandbox, an ACTIVE
   * user account, and at least one non-revoked permission grant in the requested legal entity - a
   * user with no grants gets no session rather than an empty one.
   */
  async issueSession(input: {
    readonly userAccountId: UserAccountId;
    readonly legalEntityId: LegalEntityId;
    readonly ttlSeconds?: number;
  }): Promise<IssuedSandboxSession> {
    await this.resolveGate(input.legalEntityId);

    const ttl = input.ttlSeconds ?? this.configuration.maxSessionSeconds;
    assertSandbox(
      Number.isInteger(ttl) && ttl > 0 && ttl <= this.configuration.maxSessionSeconds,
      "POLICY_CONFIGURATION_PENDING",
      `Session lifetime must be between 1 and ${this.configuration.maxSessionSeconds} seconds`
    );

    const account = await this.database.query<{ readonly status: string }>(
      "SELECT status FROM abos.user_accounts WHERE id = $1",
      [input.userAccountId]
    );
    assertSandbox(account.rows[0] !== undefined, "AUTHENTICATION_REQUIRED", "Unknown user account");
    assertSandbox(
      account.rows[0].status === "ACTIVE",
      "AUTHENTICATION_REQUIRED",
      `User account is ${account.rows[0].status}`
    );

    const grants = await this.loadPermissions(input.userAccountId, input.legalEntityId);
    assertSandbox(
      grants.length > 0,
      "PERMISSION_DENIED",
      "User account holds no permission in this legal entity"
    );

    const issuedAt = this.now();
    const expiresAt = new Date(issuedAt.getTime() + ttl * 1000);
    const token = randomBytes(32).toString("base64url");
    const sessionId = randomUUID();

    await this.database.query(
      `INSERT INTO abos.sandbox_sessions
         (id, user_account_id, token_sha256, legal_entity_id, issued_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        sessionId,
        input.userAccountId,
        this.digest(token),
        input.legalEntityId,
        issuedAt.toISOString(),
        expiresAt.toISOString()
      ]
    );

    return {
      sessionId,
      token,
      userAccountId: input.userAccountId,
      legalEntityId: input.legalEntityId,
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString()
    };
  }

  /**
   * Turns an opaque bearer token into a `ServerActorContext` assembled entirely from persisted
   * grants. The caller contributes nothing to the result except the token.
   */
  async authenticate(token: string): Promise<ServerActorContext> {
    assertSandbox(
      typeof token === "string" && token.trim().length > 0,
      "AUTHENTICATION_REQUIRED",
      "A sandbox bearer token is required"
    );

    const sessions = await this.database.query<SessionRow>(
      `SELECT s.id, s.user_account_id, s.legal_entity_id, s.issued_at, s.expires_at, s.revoked_at,
              u.status AS user_status
         FROM abos.sandbox_sessions s
         JOIN abos.user_accounts u ON u.id = s.user_account_id
        WHERE s.token_sha256 = $1`,
      [this.digest(token)]
    );
    const session = sessions.rows[0];
    assertSandbox(session !== undefined, "AUTHENTICATION_REQUIRED", "Unknown sandbox session");
    assertSandbox(session.revoked_at === null, "AUTHENTICATION_REQUIRED", "Sandbox session was revoked");
    assertSandbox(
      new Date(iso(session.expires_at)).getTime() > this.now().getTime(),
      "AUTHENTICATION_REQUIRED",
      "Sandbox session expired"
    );
    assertSandbox(
      session.user_status === "ACTIVE",
      "AUTHENTICATION_REQUIRED",
      `User account is ${session.user_status}`
    );

    // The gate is re-resolved on every authentication: revoking the sandbox authorization
    // invalidates outstanding sessions immediately.
    await this.resolveGate(session.legal_entity_id);

    const permissions = await this.loadPermissions(session.user_account_id, session.legal_entity_id);
    const scopes = await this.loadScopes(session.user_account_id, session.legal_entity_id);

    return Object.freeze({
      userAccountId: session.user_account_id,
      permissions: Object.freeze(permissions),
      legalEntityIds: Object.freeze([session.legal_entity_id]),
      projectIds: Object.freeze(scopes.projectIds),
      departmentIds: Object.freeze(scopes.departmentIds),
      costCenterIds: Object.freeze(scopes.costCenterIds),
      authenticatedAt: this.now().toISOString(),
      sessionId: session.id,
      expiresAt: iso(session.expires_at)
    }) satisfies ServerActorContext;
  }

  /**
   * Verifies that a gate was produced by this process's `resolveGate`.
   *
   * Injected into `FinancePostingService` so the kernel can refuse a hand-built gate object. It
   * does not re-read the database; it only proves provenance. Freshness is bounded by the
   * authorization's own expiry, which is part of the signed fingerprint.
   */
  verifyGate = (gate: SandboxPostingGate): void => {
    const { signature, ...unsigned } = gate;
    assertSandbox(
      typeof signature === "string" && signature.length > 0,
      "POLICY_CONFIGURATION_PENDING",
      "The sandbox gate carries no signature and was not resolved by the server"
    );
    assertSandbox(
      equalsConstantTime(signature, this.signGate(unsigned)),
      "POLICY_CONFIGURATION_PENDING",
      "The sandbox gate signature is invalid; this gate was not resolved from the database"
    );
    assertSandbox(
      new Date(gate.authorization.expiresAt).getTime() > this.now().getTime(),
      "POLICY_CONFIGURATION_PENDING",
      "The sandbox authorization behind this gate has expired"
    );
  };

  private signGate(gate: Omit<SandboxPostingGate, "signature">): string {
    return createHmac("sha256", this.configuration.signingSecret)
      .update(sandboxGateFingerprint(gate))
      .digest("hex");
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.database.query(
      "UPDATE abos.sandbox_sessions SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL",
      [sessionId, this.now().toISOString()]
    );
  }

  /**
   * Presents this process's runtime marker to the current transaction.
   *
   * Every finance mutation trigger installed by migration 0002 reads
   * `current_setting('abos.runtime_marker', true)`, so a transaction that has not called this
   * cannot write finance data even with a valid connection and a valid actor. `SET LOCAL` scopes
   * the value to the transaction, so it never leaks to the next user of a pooled connection.
   */
  async presentRuntimeMarker(transaction: SqlExecutor): Promise<void> {
    await transaction.query("SELECT set_config('abos.runtime_marker', $1, true)", [
      this.configuration.runtimeMarker
    ]);
  }

  private async loadAuthorization(): Promise<SandboxAuthorization> {
    const result = await this.database.query<AuthorizationRow>(
      `SELECT environment, configuration_state, policy_version_id, real_posting_enabled,
              runtime_marker, authorized_by_user_account_id, authorized_at, expires_at
         FROM abos.sandbox_authorizations
        WHERE singleton`
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new SandboxAuthError(
        "POLICY_CONFIGURATION_PENDING",
        "This database carries no sandbox authorization. E1 finance mutation is impossible here."
      );
    }
    if (new Date(iso(row.expires_at)).getTime() <= this.now().getTime()) {
      throw new SandboxAuthError(
        "POLICY_CONFIGURATION_PENDING",
        `Sandbox authorization expired at ${iso(row.expires_at)}`
      );
    }
    if (row.environment !== this.configuration.environment) {
      throw new SandboxAuthError(
        "POLICY_CONFIGURATION_PENDING",
        `Database is authorized for ${row.environment} but this process declares ${this.configuration.environment}`
      );
    }
    if (!equalsConstantTime(row.runtime_marker, this.configuration.runtimeMarker)) {
      throw new SandboxAuthError(
        "POLICY_CONFIGURATION_PENDING",
        "This process's runtime marker does not match the database's sandbox authorization"
      );
    }
    if (row.real_posting_enabled) {
      throw new SandboxAuthError(
        "POLICY_CONFIGURATION_PENDING",
        "Real posting is enabled on this database; E1 refuses to run against it"
      );
    }
    return {
      singleton: true,
      environment: row.environment,
      configurationState: row.configuration_state,
      policyVersionId: row.policy_version_id,
      realPostingEnabled: false,
      runtimeMarker: row.runtime_marker,
      authorizedByUserAccountId: row.authorized_by_user_account_id,
      authorizedAt: iso(row.authorized_at),
      expiresAt: iso(row.expires_at)
    };
  }

  private async loadPermissions(
    userAccountId: UserAccountId,
    legalEntityId: LegalEntityId
  ): Promise<FinancePermission[]> {
    const result = await this.database.query<{ readonly permission_code: string }>(
      `SELECT permission_code
         FROM abos.user_permission_grants
        WHERE user_account_id = $1 AND legal_entity_id = $2 AND revoked_at IS NULL
        ORDER BY permission_code`,
      [userAccountId, legalEntityId]
    );
    // Only codes the contract knows about become permissions; a Treasury grant is not a Finance one.
    return result.rows
      .map((row) => row.permission_code)
      .filter((code): code is FinancePermission => FINANCE_PERMISSIONS.has(code));
  }

  private async loadScopes(
    userAccountId: UserAccountId,
    legalEntityId: LegalEntityId
  ): Promise<{
    readonly projectIds: ProjectId[];
    readonly departmentIds: DepartmentId[];
    readonly costCenterIds: CostCenterId[];
  }> {
    const result = await this.database.query<{
      readonly scope_kind: "PROJECT" | "DEPARTMENT" | "COST_CENTER";
      readonly scope_id: string;
    }>(
      `SELECT scope_kind, scope_id
         FROM abos.user_scope_grants
        WHERE user_account_id = $1 AND legal_entity_id = $2 AND revoked_at IS NULL
        ORDER BY scope_kind, scope_id`,
      [userAccountId, legalEntityId]
    );
    return {
      projectIds: pick(result.rows, "PROJECT") as ProjectId[],
      departmentIds: pick(result.rows, "DEPARTMENT") as DepartmentId[],
      costCenterIds: pick(result.rows, "COST_CENTER") as CostCenterId[]
    };
  }

  private digest(token: string): string {
    return createHmac("sha256", this.configuration.signingSecret).update(token).digest("hex");
  }
}

const FINANCE_PERMISSIONS: ReadonlySet<string> = new Set<FinancePermission>([
  "finance.posting-intent.approve",
  "finance.journal.post",
  "finance.journal.reverse",
  "finance.report.operational.read"
]);

function pick(
  rows: readonly { readonly scope_kind: string; readonly scope_id: string }[],
  kind: string
): string[] {
  return rows.filter((row) => row.scope_kind === kind).map((row) => row.scope_id);
}

function equalsConstantTime(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
