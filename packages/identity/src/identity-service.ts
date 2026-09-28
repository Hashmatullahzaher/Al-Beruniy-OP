import { createHash, createHmac, randomUUID } from "node:crypto";

import {
  financeWorkflowPolicyUpdateSchema,
  financeWorkflowTypeSchema,
  type FinanceWorkflowPolicyWorkspace,
  type FinanceWorkflowType,
  type LegalEntityId,
  type UserAccountId
} from "@abos/contracts";
import type { SqlExecutor } from "@abos/database";
import { SandboxAuthError, type SandboxAuthenticator } from "@abos/sandbox-auth";

import { assertIdentity, IdentityError } from "./errors.ts";
import {
  decoyPasswordHash, generateTemporaryPassword, hashPassword, passwordProblems, verifyPassword
} from "./password.ts";

/**
 * Employee sign-in and access administration for the V1 client preview.
 *
 * Every administrative call starts from an opaque session token and derives the actor, the legal
 * entity and the actor's current grants from the database inside the same transaction. A request
 * can never name its own actor. Effective permissions are written into abos.user_permission_grants,
 * which the Treasury and Finance database functions read on every call; this service never touches
 * Treasury, Finance or ledger tables, and its database role cannot.
 */

export const ADMIN_USERS = "admin.users.manage";
export const ADMIN_ROLES = "admin.roles.manage";
const ADMIN_PERMISSIONS = new Set([ADMIN_USERS, ADMIN_ROLES]);

const LOGIN_PATTERN = /^[a-z0-9][a-z0-9._-]{2,63}$/;
export const MAX_FAILED_ATTEMPTS = 5;
export const LOCKOUT_MINUTES = 15;
export const CLIENT_FAILURE_LIMIT = 30;
export const TEMPORARY_PASSWORD_HOURS = 72;
const MAX_PASSWORD_INPUT = 1024;

export type AccountStatus = "ACTIVE" | "DISABLED" | "INVITED" | "REVOKED";

export interface CatalogueEntry {
  readonly code: string;
  readonly category: "ADMINISTRATION" | "SHAREHOLDER" | "TREASURY" | "FINANCE";
  readonly availability: "ACTIVE" | "UNAVAILABLE_IN_PREVIEW";
  readonly independenceEnforced: boolean;
  readonly administrative: boolean;
  readonly catalogueVersion: number;
}

export interface SessionUser {
  readonly userAccountId: string;
  readonly loginIdentifier: string;
  readonly displayName: string;
  readonly jobTitle: string | null;
  readonly legalEntityId: string;
  readonly legalEntityName: string;
  readonly permissions: readonly string[];
  readonly sessionExpiresAt: string;
}

export interface UserSummary {
  readonly id: string;
  readonly loginIdentifier: string;
  readonly displayName: string;
  readonly jobTitle: string | null;
  readonly contactEmail: string | null;
  readonly contactPhone: string | null;
  readonly status: AccountStatus;
  readonly canSignIn: boolean;
  readonly mustChangePassword: boolean;
  readonly roles: readonly { readonly id: string; readonly name: string }[];
  readonly permissions: readonly string[];
  readonly activeSessions: number;
  readonly isYou: boolean;
  readonly createdAt: string;
}

export interface UserDetail extends UserSummary {
  readonly effectivePermissions: readonly { readonly code: string; readonly viaRoles: readonly string[] }[];
  readonly recentActivity: readonly AuditEntry[];
}

export interface RoleView {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly status: "ACTIVE" | "INACTIVE";
  readonly version: number;
  readonly permissions: readonly string[];
  readonly holders: readonly { readonly id: string; readonly displayName: string; readonly status: AccountStatus }[];
  readonly youHoldThis: boolean;
  readonly createdAt: string;
}

export interface AuditEntry {
  readonly id: string;
  readonly occurredAt: string;
  readonly action: string;
  readonly actor: string;
  readonly entityType: string;
  readonly target: string;
  readonly summary: Readonly<Record<string, unknown>>;
}

export interface CompanyProfileView {
  readonly legalEntity: { readonly id: string; readonly code: string; readonly name: string; readonly baseCurrency: string | null };
  readonly profile: {
    readonly legalName: string | null; readonly registrationNumber: string | null; readonly goLiveDate: string | null;
    readonly version: number; readonly updatedAt: string | null; readonly updatedBy: string | null;
  };
  readonly currencies: readonly { readonly code: string; readonly name: string; readonly enabled: boolean }[];
  readonly calendar: { readonly calendarKind: string; readonly reportingCalendars: readonly string[] } | null;
  readonly canManage: boolean;
}

export interface CreateUserInput {
  readonly loginIdentifier: string;
  readonly displayName: string;
  readonly jobTitle?: string | null;
  readonly contactEmail?: string | null;
  readonly contactPhone?: string | null;
  readonly status: "ACTIVE" | "DISABLED";
  readonly roleIds: readonly string[];
}

export interface ProfileInput {
  readonly displayName: string;
  readonly jobTitle?: string | null;
  readonly contactEmail?: string | null;
  readonly contactPhone?: string | null;
}

export interface RoleInput {
  readonly name: string;
  readonly description: string;
  readonly permissions: readonly string[];
}

export interface RoleUpdateInput extends RoleInput {
  readonly status: "ACTIVE" | "INACTIVE";
  readonly expectedVersion: number;
}

export interface LoginResult {
  readonly token: string;
  readonly expiresAt: string;
  readonly user: SessionUser;
}

interface Actor {
  readonly userAccountId: string;
  readonly legalEntityId: string;
  readonly sessionId: string;
  readonly permissions: ReadonlySet<string>;
}

interface IdentityServiceOptions {
  /** Keys the digests of login identifiers and client addresses in login_attempts. */
  readonly attemptKeySecret: string;
  readonly now?: () => Date;
}

type LoginOutcome =
  | { readonly kind: "ok"; readonly userAccountId: string; readonly legalEntityId: string; readonly verifiedHash: string }
  | { readonly kind: "error"; readonly error: IdentityError };

export class IdentityService {
  private readonly database: SqlExecutor;
  private readonly authenticator: SandboxAuthenticator;
  private readonly attemptKeySecret: string;
  private readonly now: () => Date;

  constructor(database: SqlExecutor, authenticator: SandboxAuthenticator, options: IdentityServiceOptions) {
    assertIdentity(options.attemptKeySecret.length >= 32, "VALIDATION_FAILED", "Attempt key secret is too short");
    this.database = database;
    this.authenticator = authenticator;
    this.attemptKeySecret = options.attemptKeySecret;
    this.now = options.now ?? (() => new Date());
  }

  // -------------------------------------------------------------------------------------------
  // Sign-in
  // -------------------------------------------------------------------------------------------

  async login(input: { readonly loginIdentifier: string; readonly password: string; readonly clientAddress: string | null }): Promise<LoginResult> {
    const outcome = await this.checkCredentials(input, { allowPasswordChange: false });
    if (outcome.kind === "error") throw outcome.error;
    return this.openSession(outcome.userAccountId, outcome.legalEntityId, outcome.verifiedHash);
  }

  /** Used for a required first change and for a voluntary change; either way, all old sessions end. */
  async changePassword(input: {
    readonly loginIdentifier: string; readonly currentPassword: string; readonly newPassword: string; readonly clientAddress: string | null;
  }): Promise<LoginResult> {
    const login = normalizeLogin(input.loginIdentifier);
    const problems = passwordProblems(input.newPassword, login);
    assertIdentity(problems.length === 0, "VALIDATION_FAILED", "The new password does not meet the password rules.", { problems });
    assertIdentity(input.newPassword !== input.currentPassword, "VALIDATION_FAILED", "The new password must be different from the current one.", { problems: ["SAME_AS_CURRENT"] });
    const outcome = await this.checkCredentials(
      { loginIdentifier: input.loginIdentifier, password: input.currentPassword, clientAddress: input.clientAddress },
      { allowPasswordChange: true }
    );
    if (outcome.kind === "error") throw outcome.error;
    const hash = await hashPassword(input.newPassword);
    await this.database.transaction(async (tx) => {
      // Compare-and-set: if an administrator reset the password after it was checked, nothing is written.
      const updated = await this.command(tx, "CHANGE_PASSWORD", {
        userAccountId: outcome.userAccountId, newPasswordHash: hash,
        expectedPasswordHash: outcome.verifiedHash
      });
      assertIdentity(updated.affected === 1, "AUTHENTICATION_REQUIRED", "Your password was changed elsewhere. Sign in again.");
      const revoked = await revokeAllSessions(tx, this.authenticator, outcome.userAccountId);
      await writeAudit(tx, this.authenticator, {
        actor: outcome.userAccountId, legalEntityId: outcome.legalEntityId, action: "PASSWORD_CHANGED",
        entityType: "USER_ACCOUNT", entityId: outcome.userAccountId, after: { sessionsRevoked: revoked }
      });
      await this.recordAttempt(tx, login, input.clientAddress, outcome.userAccountId, true);
    });
    return this.openSession(outcome.userAccountId, outcome.legalEntityId, hash);
  }

  async logout(token: string): Promise<void> {
    if (typeof token !== "string" || token.length < 32) return;
    await this.command(this.database, "REVOKE_SESSION_TOKEN", { runtimeTokenSha256: sha256(token) });
  }

  /** Rotate one live session. The old token is revoked in the same transaction that stores the new one. */
  async refreshSession(token: string, clientAddress: string | null): Promise<LoginResult> {
    // Retained in the public boundary for future session telemetry; rotation authority comes only
    // from the opaque token and database state.
    void clientAddress;
    assertIdentity(typeof token === "string" && token.length >= 32, "AUTHENTICATION_REQUIRED", "Sign in to continue.");
    let issued;
    try {
      issued = await this.database.transaction(async (tx) => {
        // The SECURITY DEFINER command owns the row locks and performs validation, insertion and
        // revocation atomically. The restricted runtime credential never receives direct write
        // privileges on the session or credential tables.
        return this.authenticator.rotateSession(tx, token);
      });
    } catch (error) {
      if (error instanceof SandboxAuthError) {
        throw new IdentityError("AUTHENTICATION_REQUIRED", "Your session has ended. Sign in again.");
      }
      throw error;
    }
    return { token: issued.token, expiresAt: issued.expiresAt, user: await this.currentUser(issued.token) };
  }

  async currentUser(token: string): Promise<SessionUser> {
    return this.database.transaction(async (tx) => {
      const actor = await this.actor(tx, token);
      return this.sessionUser(tx, actor);
    });
  }

  /**
   * The password is checked outside any transaction, so a slow hash never holds a connection or a
   * row lock. Lockout is a count of recent failures in login_attempts, so it decays by itself. A
   * locked account and an unknown username get exactly the same answer.
   */
  private async checkCredentials(
    input: { readonly loginIdentifier: string; readonly password: string; readonly clientAddress: string | null },
    options: { readonly allowPasswordChange: boolean }
  ): Promise<LoginOutcome> {
    const login = normalizeLogin(input.loginIdentifier);
    const invalid = new IdentityError("INVALID_CREDENTIALS",
      `The username or password is not correct, or the account is locked for ${LOCKOUT_MINUTES} minutes after repeated attempts.`);
    const clientKey = this.key(`client:${input.clientAddress ?? "unverified"}`);
    const record = (userId: string | null, succeeded: boolean) =>
      this.database.transaction((tx) => this.recordAttempt(tx, login, input.clientAddress, userId, succeeded));

    if (typeof input.password !== "string" || input.password.length === 0 || input.password.length > MAX_PASSWORD_INPUT || login.length === 0 || login.length > 64) {
      return { kind: "error", error: invalid };
    }

    // Per-client throttling only with a trustworthy address; per-account lockout always applies.
    const clientFailures = input.clientAddress === null ? { rows: [{ failures: "0" }] } : await this.database.query<{ readonly failures: string }>(
      `SELECT count(*)::text AS failures FROM abos.login_attempts
        WHERE client_key = $1 AND NOT succeeded AND attempted_at > clock_timestamp() - make_interval(mins => $2::int)`,
      [clientKey, LOCKOUT_MINUTES]
    );
    if (Number(clientFailures.rows[0]?.failures ?? "0") >= CLIENT_FAILURE_LIMIT) {
      return { kind: "error", error: throttled() };
    }

    const found = await this.database.query<{
      readonly id: string; readonly status: AccountStatus; readonly primary_legal_entity_id: string | null;
      readonly password_hash: string; readonly must_change_password: boolean; readonly temporary_expired: boolean;
      readonly recent_failures: string;
    }>(
      `SELECT u.id, u.status, u.primary_legal_entity_id, c.password_hash, c.must_change_password,
              (c.must_change_password AND c.password_set_at < clock_timestamp() - make_interval(hours => $2::int)) AS temporary_expired,
              (SELECT count(*)::text FROM abos.login_attempts a
                WHERE a.user_account_id = u.id AND NOT a.succeeded
                  AND a.attempted_at > greatest(clock_timestamp() - make_interval(mins => $3::int), c.password_set_at,
                        coalesce((SELECT max(s.attempted_at) FROM abos.login_attempts s WHERE s.user_account_id = u.id AND s.succeeded), '-infinity'))
              ) AS recent_failures
         FROM abos.user_accounts u
         JOIN abos.user_credentials c ON c.user_account_id = u.id
        WHERE lower(u.login_identifier) = $1`,
      [login, TEMPORARY_PASSWORD_HOURS, LOCKOUT_MINUTES]
    );
    const account = found.rows[0];
    if (account === undefined) {
      await verifyPassword(input.password, await decoyPasswordHash());
      await record(null, false);
      return { kind: "error", error: invalid };
    }
    // Counted as a failure before the (slow) check, so a burst of parallel guesses is all counted;
    // a success recorded afterwards starts a new window.
    await record(account.id, false);
    if (Number(account.recent_failures) >= MAX_FAILED_ATTEMPTS) {
      await verifyPassword(input.password, await decoyPasswordHash());
      return { kind: "error", error: invalid };
    }
    if (!(await verifyPassword(input.password, account.password_hash))) {
      return { kind: "error", error: invalid };
    }
    if (account.status !== "ACTIVE") {
      return { kind: "error", error: new IdentityError("ACCOUNT_INACTIVE", "This account is suspended. Contact your administrator.") };
    }
    if (account.temporary_expired) {
      return { kind: "error", error: new IdentityError("TEMPORARY_PASSWORD_EXPIRED", "This temporary password has expired. Ask your administrator for a new one.") };
    }
    if (account.must_change_password && !options.allowPasswordChange) {
      await record(account.id, true);
      return { kind: "error", error: new IdentityError("PASSWORD_CHANGE_REQUIRED", "Choose a new password before you continue.") };
    }
    const entity = await this.database.query<{ readonly legal_entity_id: string }>(
      `SELECT legal_entity_id FROM abos.user_permission_grants
        WHERE user_account_id = $1 AND revoked_at IS NULL
        GROUP BY legal_entity_id
        ORDER BY (legal_entity_id = $2) DESC, legal_entity_id
        LIMIT 1`,
      [account.id, account.primary_legal_entity_id]
    );
    const legalEntityId = entity.rows[0]?.legal_entity_id;
    if (legalEntityId === undefined) {
      return { kind: "error", error: new IdentityError("NO_ACCESS_ASSIGNED", "Your account has no access assigned yet. Contact your administrator.") };
    }
    // A required first change records its success only once the new password is stored.
    if (!account.must_change_password) await record(account.id, true);
    return { kind: "ok", userAccountId: account.id, legalEntityId, verifiedHash: account.password_hash };
  }

  private async recordAttempt(tx: SqlExecutor, login: string, clientAddress: string | null, userId: string | null, succeeded: boolean): Promise<void> {
    await this.command(tx, "RECORD_ATTEMPT", {
      id: randomUUID(), loginKey: this.key(`login:${login}`),
      clientKey: this.key(`client:${clientAddress ?? "unverified"}`),
      userAccountId: userId, succeeded
    });
  }

  private async openSession(userAccountId: string, legalEntityId: string, expectedPasswordHash: string): Promise<LoginResult> {
    let issued;
    try {
      issued = await this.database.transaction((tx) => this.authenticator.issueSession({
        userAccountId: userAccountId as UserAccountId,
        legalEntityId: legalEntityId as LegalEntityId,
        expectedPasswordHash
      }, tx));
    } catch (error) {
      if (error instanceof SandboxAuthError && error.code === "PERMISSION_DENIED") {
        throw new IdentityError("NO_ACCESS_ASSIGNED", "Your account has no access assigned yet. Contact your administrator.");
      }
      throw error;
    }
    const user = await this.currentUser(issued.token);
    return { token: issued.token, expiresAt: issued.expiresAt, user };
  }

  private async sessionUser(tx: SqlExecutor, actor: Actor): Promise<SessionUser> {
    const row = await tx.query<{
      readonly login_identifier: string; readonly display_name: string; readonly job_title: string | null;
      readonly entity_name: string; readonly expires_at: Date | string;
    }>(
      `SELECT u.login_identifier, u.display_name, u.job_title, e.name AS entity_name, s.expires_at
         FROM abos.user_accounts u
         JOIN abos.sandbox_sessions s ON s.id = $2
         JOIN abos.legal_entities e ON e.id = $3
        WHERE u.id = $1`,
      [actor.userAccountId, actor.sessionId, actor.legalEntityId]
    );
    const user = row.rows[0];
    assertIdentity(user !== undefined, "AUTHENTICATION_REQUIRED", "Sign in to continue.");
    return {
      userAccountId: actor.userAccountId,
      loginIdentifier: user.login_identifier,
      displayName: user.display_name,
      jobTitle: user.job_title,
      legalEntityId: actor.legalEntityId,
      legalEntityName: user.entity_name,
      permissions: [...actor.permissions].sort(),
      sessionExpiresAt: iso(user.expires_at)
    };
  }

  // -------------------------------------------------------------------------------------------
  // Actor derivation
  // -------------------------------------------------------------------------------------------

  /**
   * The actor comes from the session token alone. Session, account and grants are read FOR SHARE
   * in the caller's transaction, so a concurrent suspension or revocation is ordered against it.
   */
  private async actor(tx: SqlExecutor, token: string): Promise<Actor> {
    assertIdentity(typeof token === "string" && token.length >= 32, "AUTHENTICATION_REQUIRED", "Sign in to continue.");
    const session = await this.authenticator.identityActorContext(tx, token);
    assertIdentity(
      session !== null && session.live && session.status === "ACTIVE" && !session.mustChangePassword,
      "AUTHENTICATION_REQUIRED",
      "Your session has ended. Sign in again."
    );
    // The sandbox gate is checked on this same connection and transaction. Borrowing a second pooled
    // connection here deadlocked the pool when enough requests held a transaction at once.
    const gate = await tx.query<{ readonly ok: boolean }>(
      `SELECT (a.environment IN ('development', 'test') AND a.configuration_state = 'SYNTHETIC_TEST_ONLY'
               AND NOT a.real_posting_enabled AND a.expires_at > clock_timestamp()
               AND a.runtime_marker = current_setting('abos.runtime_marker', true)
               AND EXISTS (SELECT 1 FROM abos.sandbox_legal_entity_scopes s WHERE s.legal_entity_id = $1)) AS ok
         FROM abos.sandbox_authorizations a WHERE a.singleton`,
      [session.legalEntityId]
    );
    assertIdentity(gate.rows[0]?.ok === true, "AUTHENTICATION_REQUIRED", "The preview environment is not currently authorized. Sign in again later.");
    return {
      userAccountId: session.userAccountId,
      legalEntityId: session.legalEntityId,
      sessionId: session.id,
      permissions: new Set(session.permissions)
    };
  }

  private async admin(tx: SqlExecutor, token: string, permission: string): Promise<Actor> {
    const actor = await this.actor(tx, token);
    assertIdentity(actor.permissions.has(permission), "PERMISSION_DENIED", "You do not have permission to manage access.");
    return actor;
  }

  // -------------------------------------------------------------------------------------------
  // Catalogue and audit
  // -------------------------------------------------------------------------------------------

  async catalogue(token: string): Promise<readonly CatalogueEntry[]> {
    return this.database.transaction(async (tx) => {
      const actor = await this.actor(tx, token);
      assertIdentity(actor.permissions.has(ADMIN_USERS) || actor.permissions.has(ADMIN_ROLES), "PERMISSION_DENIED", "You do not have permission to manage access.");
      return loadCatalogue(tx);
    });
  }

  async auditTrail(token: string, limit = 100): Promise<readonly AuditEntry[]> {
    return this.database.transaction(async (tx) => {
      const actor = await this.actor(tx, token);
      assertIdentity(actor.permissions.has(ADMIN_USERS) || actor.permissions.has(ADMIN_ROLES), "PERMISSION_DENIED", "You do not have permission to review access changes.");
      return loadAudit(tx, actor.legalEntityId, null, Math.min(Math.max(limit, 1), 500));
    });
  }

  // -------------------------------------------------------------------------------------------
  // Company profile (#8). Legal name, registration number and go-live date are owner data: stored
  // only when a Super Administrator enters them, shown as pending until then.
  // -------------------------------------------------------------------------------------------

  async companyProfile(token: string): Promise<CompanyProfileView> {
    return this.database.transaction(async (tx) => {
      const actor = await this.actor(tx, token);
      return loadCompanyProfile(tx, actor);
    });
  }

  async updateCompanyProfile(token: string, input: {
    readonly legalName: string | null; readonly registrationNumber: string | null; readonly goLiveDate: string | null; readonly expectedVersion: number;
  }): Promise<CompanyProfileView> {
    const legalName = optionalText(input.legalName);
    const registrationNumber = optionalText(input.registrationNumber);
    const goLiveDate = optionalText(input.goLiveDate);
    assertIdentity(legalName === null || (legalName.length >= 2 && legalName.length <= 200), "VALIDATION_FAILED", "Enter the legal name (2-200 characters) or leave it pending.", { field: "legalName" });
    assertIdentity(registrationNumber === null || registrationNumber.length <= 100, "VALIDATION_FAILED", "The registration number is too long.", { field: "registrationNumber" });
    assertIdentity(goLiveDate === null || (/^\d{4}-\d{2}-\d{2}$/.test(goLiveDate) && !Number.isNaN(Date.parse(goLiveDate))), "VALIDATION_FAILED", "Enter the go-live date as YYYY-MM-DD or leave it pending.", { field: "goLiveDate" });
    return this.mutate(async (tx) => {
      const actor = await this.admin(tx, token, "admin.company.manage");
      await this.authenticator.identityLock(tx, "LEGAL_ENTITY_PROFILE", { legalEntityId: actor.legalEntityId });
      const current = await tx.query<{ legal_name: string | null; registration_number: string | null; go_live_date: string | null; version: number }>(
        "SELECT legal_name, registration_number, go_live_date::text AS go_live_date, version FROM abos.legal_entity_profiles WHERE legal_entity_id = $1",
        [actor.legalEntityId]);
      const before = current.rows[0];
      assertIdentity((before?.version ?? 0) === input.expectedVersion, "STALE_VERSION", "Someone else changed the company details. Reload and try again.");
      await this.command(tx, "UPSERT_COMPANY_PROFILE", {
        legalEntityId: actor.legalEntityId, legalName, registrationNumber, goLiveDate,
        updatedByUserAccountId: actor.userAccountId
      });
      await this.command(tx, "WRITE_AUDIT", {
        id: randomUUID(), actorUserAccountId: actor.userAccountId,
        legalEntityId: actor.legalEntityId, correlationId: randomUUID(),
        action: "COMPANY_PROFILE_UPDATED", entityType: "COMPANY_PROFILE",
        entityId: actor.legalEntityId,
        before: before === undefined ? null : { legalName: before.legal_name, registrationNumber: before.registration_number, goLiveDate: before.go_live_date },
        after: { legalName, registrationNumber, goLiveDate }, metadata: { source: "v1-company-profile" }
      });
      return loadCompanyProfile(tx, actor);
    });
  }

  // -------------------------------------------------------------------------------------------
  // Finance workflow policy. This is administrative configuration, never Finance authority.
  // Actor, legal entity and permission are resolved again in the narrow PostgreSQL boundary.
  // -------------------------------------------------------------------------------------------

  async financeWorkflowPolicies(token: string): Promise<FinanceWorkflowPolicyWorkspace> {
    return this.mutate((tx) => this.authenticator.financeWorkflowPolicies(tx, token));
  }

  async setFinanceWorkflowPolicy(token: string, input: {
    readonly workflowType: string;
    readonly approvalRequired: unknown;
    readonly expectedVersion: unknown;
    readonly changeReason: unknown;
  }): Promise<FinanceWorkflowPolicyWorkspace> {
    const workflow = financeWorkflowTypeSchema.safeParse(input.workflowType);
    const update = financeWorkflowPolicyUpdateSchema.safeParse({
      approvalRequired: input.approvalRequired,
      expectedVersion: input.expectedVersion,
      changeReason: input.changeReason
    });
    assertIdentity(workflow.success, "VALIDATION_FAILED", "Choose a supported finance workflow.", { field: "workflowType" });
    assertIdentity(update.success, "VALIDATION_FAILED", "Choose On or Off, use the current version, and enter a 5–500 character reason.");
    return this.mutate((tx) => this.authenticator.setFinanceWorkflowPolicy(tx, token, {
      workflowType: workflow.data as FinanceWorkflowType,
      ...update.data
    }));
  }

  // -------------------------------------------------------------------------------------------
  // Users
  // -------------------------------------------------------------------------------------------

  async listUsers(token: string): Promise<readonly UserSummary[]> {
    return this.database.transaction(async (tx) => {
      const actor = await this.admin(tx, token, ADMIN_USERS);
      return loadUsers(tx, actor, null);
    });
  }

  async userDetail(token: string, userId: string): Promise<UserDetail> {
    return this.database.transaction(async (tx) => {
      const actor = await this.admin(tx, token, ADMIN_USERS);
      return this.detail(tx, actor, userId);
    });
  }

  async createUser(token: string, input: CreateUserInput): Promise<{ readonly user: UserDetail; readonly temporaryPassword: string }> {
    const login = normalizeLogin(input.loginIdentifier);
    assertIdentity(LOGIN_PATTERN.test(login), "VALIDATION_FAILED", "The username must be 3–64 characters: lowercase letters, digits, dot, dash or underscore, starting with a letter or digit.", { field: "loginIdentifier" });
    const profile = validateProfile(input);
    assertIdentity(input.status === "ACTIVE" || input.status === "DISABLED", "VALIDATION_FAILED", "Choose Active or Suspended.", { field: "status" });
    const temporaryPassword = temporaryPasswordFor(login);
    const hash = await hashPassword(temporaryPassword);

    return this.mutate(async (tx) => {
      const actor = await this.admin(tx, token, ADMIN_USERS);
      const roles = await loadRolesById(tx, this.authenticator, actor.legalEntityId, input.roleIds);
      assertIdentity(roles.length === new Set(input.roleIds).size, "NOT_FOUND", "One of the selected roles does not exist.");
      for (const role of roles) {
        assertIdentity(role.status === "ACTIVE", "VALIDATION_FAILED", `The role “${role.name}” is inactive.`);
        requireSuperAdminFor(actor, role.permissions);
      }
      const duplicate = await tx.query("SELECT 1 FROM abos.user_accounts WHERE lower(login_identifier) = $1", [login]);
      assertIdentity(duplicate.rows.length === 0, "DUPLICATE", "That username is already in use.", { field: "loginIdentifier" });

      const userId = randomUUID();
      await this.command(tx, "CREATE_USER", {
        id: userId, loginIdentifier: login, displayName: profile.displayName, status: input.status,
        jobTitle: profile.jobTitle, contactEmail: profile.contactEmail, contactPhone: profile.contactPhone,
        legalEntityId: actor.legalEntityId, createdByUserAccountId: actor.userAccountId
      });
      await this.command(tx, "UPSERT_CREDENTIAL", {
        userAccountId: userId, passwordHash: hash, mustChangePassword: true,
        setByUserAccountId: actor.userAccountId
      });
      await writeAudit(tx, this.authenticator, {
        actor: actor.userAccountId, legalEntityId: actor.legalEntityId, action: "USER_CREATED",
        entityType: "USER_ACCOUNT", entityId: userId,
        after: { loginIdentifier: login, ...profile, status: input.status, mustChangePassword: true }
      });
      for (const role of roles) {
        await this.command(tx, "ASSIGN_ROLE", {
          id: randomUUID(), userAccountId: userId, roleId: role.id,
          legalEntityId: actor.legalEntityId, assignedByUserAccountId: actor.userAccountId
        });
        await writeAudit(tx, this.authenticator, {
          actor: actor.userAccountId, legalEntityId: actor.legalEntityId, action: "ROLE_ASSIGNED",
          entityType: "USER_ACCOUNT", entityId: userId, after: { roleId: role.id, roleName: role.name }
        });
      }
      await syncGrants(tx, this.authenticator, actor, userId);
      return { user: await this.detail(tx, actor, userId), temporaryPassword };
    });
  }

  async updateProfile(token: string, userId: string, input: ProfileInput): Promise<UserDetail> {
    const profile = validateProfile(input);
    return this.mutate(async (tx) => {
      const actor = await this.admin(tx, token, ADMIN_USERS);
      const before = await requireUser(tx, this.authenticator, actor, userId);
      requireSuperAdminFor(actor, await activeGrants(tx, userId, actor.legalEntityId));
      await this.command(tx, "UPDATE_USER_PROFILE", {
        userAccountId: userId, displayName: profile.displayName, jobTitle: profile.jobTitle,
        contactEmail: profile.contactEmail, contactPhone: profile.contactPhone
      });
      await writeAudit(tx, this.authenticator, {
        actor: actor.userAccountId, legalEntityId: actor.legalEntityId, action: "USER_PROFILE_UPDATED",
        entityType: "USER_ACCOUNT", entityId: userId,
        before: { displayName: before.display_name, jobTitle: before.job_title, contactEmail: before.contact_email, contactPhone: before.contact_phone },
        after: profile
      });
      return this.detail(tx, actor, userId);
    });
  }

  async setStatus(token: string, userId: string, status: "ACTIVE" | "DISABLED"): Promise<UserDetail> {
    assertIdentity(status === "ACTIVE" || status === "DISABLED", "VALIDATION_FAILED", "Choose Active or Suspended.");
    return this.mutate(async (tx) => {
      const actor = await this.admin(tx, token, ADMIN_USERS);
      assertIdentity(userId !== actor.userAccountId, "SELF_CHANGE_FORBIDDEN", "You cannot change the status of your own account. Another administrator must do it.");
      const before = await requireUser(tx, this.authenticator, actor, userId);
      assertIdentity(before.status === "ACTIVE" || before.status === "DISABLED", "VALIDATION_FAILED", "This account cannot be changed.");
      const targetPermissions = await activeGrants(tx, userId, actor.legalEntityId);
      requireSuperAdminFor(actor, targetPermissions);
      if (before.status === status) return this.detail(tx, actor, userId);
      await this.command(tx, "SET_USER_STATUS", { userAccountId: userId, status });
      const revoked = status === "DISABLED" ? await revokeAllSessions(tx, this.authenticator, userId) : 0;
      await writeAudit(tx, this.authenticator, {
        actor: actor.userAccountId, legalEntityId: actor.legalEntityId,
        action: status === "DISABLED" ? "USER_SUSPENDED" : "USER_ACTIVATED",
        entityType: "USER_ACCOUNT", entityId: userId, before: { status: before.status }, after: { status, sessionsRevoked: revoked }
      });
      return this.detail(tx, actor, userId);
    });
  }

  async setRoles(token: string, userId: string, roleIds: readonly string[]): Promise<UserDetail> {
    return this.mutate(async (tx) => {
      const actor = await this.admin(tx, token, ADMIN_USERS);
      assertIdentity(userId !== actor.userAccountId, "SELF_CHANGE_FORBIDDEN", "You cannot change your own roles. Another administrator must do it.");
      await requireUser(tx, this.authenticator, actor, userId);
      const wanted = new Set(roleIds);
      const roles = await loadRolesById(tx, this.authenticator, actor.legalEntityId, [...wanted]);
      assertIdentity(roles.length === wanted.size, "NOT_FOUND", "One of the selected roles does not exist.");
      await this.authenticator.identityLock(tx, "USER_ASSIGNMENTS", {
        userAccountId: userId, legalEntityId: actor.legalEntityId
      });
      const current = await tx.query<{ readonly id: string; readonly role_id: string }>(
        `SELECT id, role_id FROM abos.user_role_assignments
          WHERE user_account_id = $1 AND legal_entity_id = $2 AND revoked_at IS NULL`,
        [userId, actor.legalEntityId]
      );
      const currentRoleIds = new Set(current.rows.map((row) => row.role_id));
      const added = roles.filter((role) => !currentRoleIds.has(role.id));
      const removed = current.rows.filter((row) => !wanted.has(row.role_id));
      const removedRoles = await loadRolesById(tx, this.authenticator, actor.legalEntityId, removed.map((row) => row.role_id));
      for (const role of [...added, ...removedRoles]) requireSuperAdminFor(actor, role.permissions);
      for (const role of added) assertIdentity(role.status === "ACTIVE", "VALIDATION_FAILED", `The role “${role.name}” is inactive.`);
      if (added.length === 0 && removed.length === 0) return this.detail(tx, actor, userId);

      for (const row of removed) {
        await this.command(tx, "REVOKE_ROLE", {
          assignmentId: row.id, revokedByUserAccountId: actor.userAccountId
        });
        const role = removedRoles.find((item) => item.id === row.role_id);
        await writeAudit(tx, this.authenticator, {
          actor: actor.userAccountId, legalEntityId: actor.legalEntityId, action: "ROLE_REMOVED",
          entityType: "USER_ACCOUNT", entityId: userId, before: { roleId: row.role_id, roleName: role?.name ?? null }
        });
      }
      for (const role of added) {
        await this.command(tx, "ASSIGN_ROLE", {
          id: randomUUID(), userAccountId: userId, roleId: role.id,
          legalEntityId: actor.legalEntityId, assignedByUserAccountId: actor.userAccountId
        });
        await writeAudit(tx, this.authenticator, {
          actor: actor.userAccountId, legalEntityId: actor.legalEntityId, action: "ROLE_ASSIGNED",
          entityType: "USER_ACCOUNT", entityId: userId, after: { roleId: role.id, roleName: role.name }
        });
      }
      const beforeGrants = await activeGrants(tx, userId, actor.legalEntityId);
      await syncGrants(tx, this.authenticator, actor, userId);
      const afterGrants = await activeGrants(tx, userId, actor.legalEntityId);
      const revoked = await revokeAllSessions(tx, this.authenticator, userId);
      await writeAudit(tx, this.authenticator, {
        actor: actor.userAccountId, legalEntityId: actor.legalEntityId, action: "USER_PERMISSIONS_CHANGED",
        entityType: "USER_ACCOUNT", entityId: userId,
        before: { permissions: beforeGrants }, after: { permissions: afterGrants, reason: "ROLES_CHANGED", sessionsRevoked: revoked }
      });
      return this.detail(tx, actor, userId);
    });
  }

  async resetPassword(token: string, userId: string): Promise<{ readonly user: UserDetail; readonly temporaryPassword: string }> {
    // Hashed before any transaction or row lock; the rules for the username are applied below.
    const temporaryPassword = generateTemporaryPassword();
    const hash = await hashPassword(temporaryPassword);
    return this.mutate(async (tx) => {
      const actor = await this.admin(tx, token, ADMIN_USERS);
      assertIdentity(userId !== actor.userAccountId, "SELF_CHANGE_FORBIDDEN", "Use “Change my password” for your own account.");
      const target = await requireUser(tx, this.authenticator, actor, userId);
      requireSuperAdminFor(actor, await activeGrants(tx, userId, actor.legalEntityId));
      assertIdentity(passwordProblems(temporaryPassword, target.login_identifier).length === 0, "VALIDATION_FAILED", "Please try again.");
      await this.command(tx, "UPSERT_CREDENTIAL", {
        userAccountId: userId, passwordHash: hash, mustChangePassword: true,
        setByUserAccountId: actor.userAccountId
      });
      const revoked = await revokeAllSessions(tx, this.authenticator, userId);
      await writeAudit(tx, this.authenticator, {
        actor: actor.userAccountId, legalEntityId: actor.legalEntityId, action: "PASSWORD_RESET",
        entityType: "USER_ACCOUNT", entityId: userId, after: { mustChangePassword: true, sessionsRevoked: revoked }
      });
      return { user: await this.detail(tx, actor, userId), temporaryPassword };
    });
  }

  async revokeSessions(token: string, userId: string): Promise<UserDetail> {
    return this.mutate(async (tx) => {
      const actor = await this.admin(tx, token, ADMIN_USERS);
      await requireUser(tx, this.authenticator, actor, userId);
      if (userId !== actor.userAccountId) requireSuperAdminFor(actor, await activeGrants(tx, userId, actor.legalEntityId));
      const revoked = await revokeAllSessions(tx, this.authenticator, userId);
      await writeAudit(tx, this.authenticator, {
        actor: actor.userAccountId, legalEntityId: actor.legalEntityId, action: "SESSIONS_REVOKED",
        entityType: "USER_ACCOUNT", entityId: userId, after: { reason: "ADMINISTRATOR_REQUEST", sessionsRevoked: revoked }
      });
      return this.detail(tx, actor, userId);
    });
  }

  private async detail(tx: SqlExecutor, actor: Actor, userId: string): Promise<UserDetail> {
    const summary = (await loadUsers(tx, actor, userId))[0];
    assertIdentity(summary !== undefined, "NOT_FOUND", "That employee account does not exist in your company.");
    const sources = await tx.query<{ readonly permission_code: string; readonly role_name: string | null }>(
      `SELECT g.permission_code, r.role_name
         FROM abos.user_permission_grants g
         LEFT JOIN abos.user_role_assignments a
           ON a.user_account_id = g.user_account_id AND a.legal_entity_id = g.legal_entity_id AND a.revoked_at IS NULL
         LEFT JOIN abos.access_roles r ON r.id = a.role_id AND r.status = 'ACTIVE'
          AND EXISTS (SELECT 1 FROM abos.access_role_permissions rp WHERE rp.role_id = r.id AND rp.permission_code = g.permission_code)
        WHERE g.user_account_id = $1 AND g.legal_entity_id = $2 AND g.revoked_at IS NULL
        ORDER BY g.permission_code, r.role_name`,
      [userId, actor.legalEntityId]
    );
    const byCode = new Map<string, string[]>();
    for (const row of sources.rows) {
      const list = byCode.get(row.permission_code) ?? [];
      if (row.role_name !== null) list.push(row.role_name);
      byCode.set(row.permission_code, list);
    }
    return {
      ...summary,
      effectivePermissions: [...byCode.entries()].map(([code, viaRoles]) => ({ code, viaRoles })),
      recentActivity: await loadAudit(tx, actor.legalEntityId, userId, 25)
    };
  }

  // -------------------------------------------------------------------------------------------
  // Roles
  // -------------------------------------------------------------------------------------------

  async listRoles(token: string): Promise<readonly RoleView[]> {
    return this.database.transaction(async (tx) => {
      const actor = await this.actor(tx, token);
      assertIdentity(actor.permissions.has(ADMIN_ROLES) || actor.permissions.has(ADMIN_USERS), "PERMISSION_DENIED", "You do not have permission to manage access.");
      return loadRoleViews(tx, actor, null);
    });
  }

  async createRole(token: string, input: RoleInput): Promise<RoleView> {
    const role = validateRole(input);
    return this.mutate(async (tx) => {
      const actor = await this.admin(tx, token, ADMIN_ROLES);
      await requireAvailablePermissions(tx, role.permissions);
      requireSuperAdminFor(actor, role.permissions);
      const duplicate = await tx.query(
        "SELECT 1 FROM abos.access_roles WHERE legal_entity_id = $1 AND lower(btrim(role_name)) = lower(btrim($2))",
        [actor.legalEntityId, role.name]
      );
      assertIdentity(duplicate.rows.length === 0, "DUPLICATE", "A role with that name already exists.", { field: "name" });
      const roleId = randomUUID();
      await this.command(tx, "CREATE_ROLE", {
        id: roleId, legalEntityId: actor.legalEntityId, name: role.name,
        description: role.description, createdByUserAccountId: actor.userAccountId
      });
      for (const code of role.permissions) {
        await this.command(tx, "ADD_ROLE_PERMISSION", {
          roleId, permissionCode: code, addedByUserAccountId: actor.userAccountId
        });
      }
      await writeAudit(tx, this.authenticator, {
        actor: actor.userAccountId, legalEntityId: actor.legalEntityId, action: "ROLE_CREATED",
        entityType: "ACCESS_ROLE", entityId: roleId, after: { name: role.name, description: role.description, permissions: role.permissions }
      });
      const view = (await loadRoleViews(tx, actor, roleId))[0];
      assertIdentity(view !== undefined, "NOT_FOUND", "The role was not found after creation.");
      return view;
    });
  }

  async updateRole(token: string, roleId: string, input: RoleUpdateInput): Promise<RoleView> {
    const role = validateRole(input);
    assertIdentity(input.status === "ACTIVE" || input.status === "INACTIVE", "VALIDATION_FAILED", "Choose Active or Inactive.");
    return this.mutate(async (tx) => {
      const actor = await this.admin(tx, token, ADMIN_ROLES);
      await this.authenticator.identityLock(tx, "ACCESS_ROLE", {
        roleId, legalEntityId: actor.legalEntityId
      });
      const existing = await tx.query<{ readonly role_name: string; readonly description: string; readonly status: "ACTIVE" | "INACTIVE"; readonly version: number }>(
        "SELECT role_name, description, status, version FROM abos.access_roles WHERE id = $1 AND legal_entity_id = $2",
        [roleId, actor.legalEntityId]
      );
      const before = existing.rows[0];
      assertIdentity(before !== undefined, "NOT_FOUND", "That role does not exist in your company.");
      assertIdentity(before.version === input.expectedVersion, "STALE_VERSION", "Someone else changed this role. Reload it and try again.");
      const currentPermissions = (await tx.query<{ readonly permission_code: string }>(
        "SELECT permission_code FROM abos.access_role_permissions WHERE role_id = $1 ORDER BY permission_code", [roleId]
      )).rows.map((row) => row.permission_code);
      const added = role.permissions.filter((code) => !currentPermissions.includes(code));
      const removed = currentPermissions.filter((code) => !role.permissions.includes(code));
      const accessChanged = added.length > 0 || removed.length > 0 || before.status !== input.status;

      const holders = (await tx.query<{ readonly user_account_id: string }>(
        "SELECT DISTINCT user_account_id FROM abos.user_role_assignments WHERE role_id = $1 AND revoked_at IS NULL", [roleId]
      )).rows.map((row) => row.user_account_id);
      assertIdentity(!accessChanged || !holders.includes(actor.userAccountId), "SELF_CHANGE_FORBIDDEN",
        "You hold this role, so you cannot change what it allows. Another administrator must do it.");
      await requireAvailablePermissions(tx, added);
      requireSuperAdminFor(actor, [...currentPermissions, ...role.permissions]);
      if (role.name.toLowerCase() !== before.role_name.trim().toLowerCase()) {
        const duplicate = await tx.query(
          "SELECT 1 FROM abos.access_roles WHERE legal_entity_id = $1 AND lower(btrim(role_name)) = lower(btrim($2)) AND id <> $3",
          [actor.legalEntityId, role.name, roleId]
        );
        assertIdentity(duplicate.rows.length === 0, "DUPLICATE", "A role with that name already exists.", { field: "name" });
      }

      await this.command(tx, "UPDATE_ROLE", {
        roleId, name: role.name, description: role.description, status: input.status,
        updatedByUserAccountId: actor.userAccountId
      });
      for (const code of removed) await this.command(tx, "REMOVE_ROLE_PERMISSION", { roleId, permissionCode: code });
      for (const code of added) {
        await this.command(tx, "ADD_ROLE_PERMISSION", {
          roleId, permissionCode: code, addedByUserAccountId: actor.userAccountId
        });
      }
      await writeAudit(tx, this.authenticator, {
        actor: actor.userAccountId, legalEntityId: actor.legalEntityId,
        action: before.status !== input.status ? (input.status === "INACTIVE" ? "ROLE_DEACTIVATED" : "ROLE_REACTIVATED") : "ROLE_UPDATED",
        entityType: "ACCESS_ROLE", entityId: roleId,
        before: { name: before.role_name, description: before.description, status: before.status, permissions: currentPermissions },
        after: { name: role.name, description: role.description, status: input.status, permissions: role.permissions, added, removed }
      });
      if (accessChanged) {
        for (const holder of holders) {
          const beforeGrants = await activeGrants(tx, holder, actor.legalEntityId);
          await syncGrants(tx, this.authenticator, actor, holder);
          const afterGrants = await activeGrants(tx, holder, actor.legalEntityId);
          const revoked = await revokeAllSessions(tx, this.authenticator, holder);
          await writeAudit(tx, this.authenticator, {
            actor: actor.userAccountId, legalEntityId: actor.legalEntityId, action: "USER_PERMISSIONS_CHANGED",
            entityType: "USER_ACCOUNT", entityId: holder,
            before: { permissions: beforeGrants }, after: { permissions: afterGrants, viaRoleId: roleId, sessionsRevoked: revoked }
          });
        }
      }
      const view = (await loadRoleViews(tx, actor, roleId))[0];
      assertIdentity(view !== undefined, "NOT_FOUND", "That role does not exist in your company.");
      return view;
    });
  }

  // -------------------------------------------------------------------------------------------

  private command(
    executor: SqlExecutor,
    operation: string,
    payload: Readonly<Record<string, unknown>>
  ): Promise<{ readonly affected: number }> {
    return this.authenticator.identityCommand(executor, operation, payload);
  }

  /** Runs a mutation and turns the database's own refusals into readable errors. */
  private async mutate<Result>(operation: (tx: SqlExecutor) => Promise<Result>): Promise<Result> {
    try {
      return await this.database.transaction(operation);
    } catch (error) {
      throw translateDatabaseError(error);
    }
  }

  private key(value: string): string {
    return createHmac("sha256", this.attemptKeySecret).update(value).digest("hex");
  }
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

export function normalizeLogin(value: string): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function throttled(): IdentityError {
  return new IdentityError("THROTTLED", `Too many unsuccessful attempts. Wait ${LOCKOUT_MINUTES} minutes and try again.`);
}

function temporaryPasswordFor(login: string): string {
  for (;;) {
    const candidate = generateTemporaryPassword();
    if (passwordProblems(candidate, login).length === 0) return candidate;
  }
}

function optionalText(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function validateProfile(input: ProfileInput): { displayName: string; jobTitle: string | null; contactEmail: string | null; contactPhone: string | null } {
  const displayName = typeof input.displayName === "string" ? input.displayName.trim() : "";
  assertIdentity(displayName.length >= 2 && displayName.length <= 120, "VALIDATION_FAILED", "Enter the employee’s full name (2–120 characters).", { field: "displayName" });
  const jobTitle = optionalText(input.jobTitle);
  assertIdentity(jobTitle === null || jobTitle.length <= 120, "VALIDATION_FAILED", "The job title is too long.", { field: "jobTitle" });
  const contactEmail = optionalText(input.contactEmail)?.toLowerCase() ?? null;
  assertIdentity(contactEmail === null || (contactEmail.length <= 200 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contactEmail)), "VALIDATION_FAILED", "Enter a valid email address or leave it empty.", { field: "contactEmail" });
  const contactPhone = optionalText(input.contactPhone);
  assertIdentity(contactPhone === null || /^\+?[0-9][0-9 ()-]{5,22}$/.test(contactPhone), "VALIDATION_FAILED", "Enter a valid phone number or leave it empty.", { field: "contactPhone" });
  return { displayName, jobTitle, contactEmail, contactPhone };
}

function validateRole(input: RoleInput): { name: string; description: string; permissions: string[] } {
  const name = typeof input.name === "string" ? input.name.trim().replace(/\s+/g, " ") : "";
  assertIdentity(name.length >= 2 && name.length <= 80, "VALIDATION_FAILED", "Enter a role name (2–80 characters).", { field: "name" });
  const description = typeof input.description === "string" ? input.description.trim() : "";
  assertIdentity(description.length <= 500, "VALIDATION_FAILED", "The description is too long (500 characters at most).", { field: "description" });
  assertIdentity(Array.isArray(input.permissions) && input.permissions.every((code) => typeof code === "string"), "VALIDATION_FAILED", "Choose permissions from the list.", { field: "permissions" });
  return { name, description, permissions: [...new Set(input.permissions)].sort() };
}

/**
 * Administration access, and access that carries an independence rule (every catalogue permission
 * with independence_enforced = true), can only be given, taken away or have its password reset by a
 * Super Administrator. A user administrator therefore cannot take over an approver's account.
 * `identity-admin.test.ts` fails if this list drifts from the database catalogue.
 */
export const INDEPENDENCE_PERMISSIONS: ReadonlySet<string> = new Set([
  "treasury.cash-account.reconcile", "treasury.cash-account.approve", "treasury.cash-receipt.verify",
  "treasury.saraf-account.manage",
  "finance.posting-intent.approve", "finance.journal.post", "finance.journal.reverse",
  "finance.ledger-account.review", "finance.reversal.request", "finance.reversal.approve"
]);

function requireSuperAdminFor(actor: Actor, permissions: Iterable<string>): void {
  const sensitive = [...permissions].some((code) => ADMIN_PERMISSIONS.has(code) || code.startsWith("admin.") || INDEPENDENCE_PERMISSIONS.has(code));
  const isSuperAdmin = actor.permissions.has(ADMIN_USERS) && actor.permissions.has(ADMIN_ROLES);
  assertIdentity(!sensitive || isSuperAdmin, "SUPER_ADMIN_REQUIRED",
    "Only a Super Administrator can give, change or take away administration or approval access, or reset the password of someone who holds it.");
}

async function requireAvailablePermissions(tx: SqlExecutor, codes: readonly string[]): Promise<void> {
  if (codes.length === 0) return;
  const found = await tx.query<{ readonly permission_code: string }>(
    "SELECT permission_code FROM abos.permission_catalogue WHERE permission_code = ANY($1::text[]) AND availability = 'ACTIVE'",
    [codes]
  );
  const available = new Set(found.rows.map((row) => row.permission_code));
  const unavailable = codes.filter((code) => !available.has(code));
  assertIdentity(unavailable.length === 0, "VALIDATION_FAILED", "Some selected permissions are not available in this version.", { unavailable });
}

async function loadCompanyProfile(tx: SqlExecutor, actor: Actor): Promise<CompanyProfileView> {
  const row = (await tx.query<{
    id: string; code: string; name: string; base_currency_code: string | null; legal_name: string | null; registration_number: string | null;
    go_live_date: string | null; version: number | null; updated_at: Date | string | null; updated_by: string | null;
    calendar_kind: string | null; reporting_calendars: string[] | null;
  }>(
    `SELECT e.id, e.code, e.name, e.base_currency_code, p.legal_name, p.registration_number, p.go_live_date::text AS go_live_date,
            p.version, p.updated_at, u.display_name AS updated_by, c.calendar_kind, c.reporting_calendars
       FROM abos.legal_entities e
       LEFT JOIN abos.legal_entity_profiles p ON p.legal_entity_id = e.id
       LEFT JOIN abos.user_accounts u ON u.id = p.updated_by_user_account_id
       LEFT JOIN abos.financial_calendar_settings c ON c.legal_entity_id = e.id
      WHERE e.id = $1`, [actor.legalEntityId])).rows[0];
  assertIdentity(row !== undefined, "NOT_FOUND", "The company was not found.");
  const currencies = await tx.query<{ code: string; name: string; enabled: boolean }>("SELECT code, name, enabled FROM abos.currencies ORDER BY code");
  return {
    legalEntity: { id: row.id, code: row.code, name: row.name, baseCurrency: row.base_currency_code },
    profile: {
      legalName: row.legal_name, registrationNumber: row.registration_number, goLiveDate: row.go_live_date,
      version: row.version ?? 0, updatedAt: row.updated_at === null ? null : iso(row.updated_at), updatedBy: row.updated_by
    },
    currencies: currencies.rows,
    calendar: row.calendar_kind === null ? null : { calendarKind: row.calendar_kind, reportingCalendars: row.reporting_calendars ?? [] },
    canManage: actor.permissions.has("admin.company.manage")
  };
}

async function loadCatalogue(tx: SqlExecutor): Promise<CatalogueEntry[]> {
  const rows = await tx.query<{
    readonly permission_code: string; readonly category: CatalogueEntry["category"]; readonly availability: CatalogueEntry["availability"];
    readonly independence_enforced: boolean; readonly administrative: boolean; readonly catalogue_version: number;
  }>("SELECT * FROM abos.permission_catalogue ORDER BY sort_order");
  return rows.rows.map((row) => ({
    code: row.permission_code, category: row.category, availability: row.availability,
    independenceEnforced: row.independence_enforced, administrative: row.administrative, catalogueVersion: row.catalogue_version
  }));
}

async function activeGrants(tx: SqlExecutor, userId: string, legalEntityId: string): Promise<string[]> {
  const rows = await tx.query<{ readonly permission_code: string }>(
    `SELECT permission_code FROM abos.user_permission_grants
      WHERE user_account_id = $1 AND legal_entity_id = $2 AND revoked_at IS NULL ORDER BY permission_code`,
    [userId, legalEntityId]
  );
  return rows.rows.map((row) => row.permission_code);
}

async function syncGrants(
  tx: SqlExecutor,
  authenticator: SandboxAuthenticator,
  actor: Actor,
  userId: string
): Promise<void> {
  await authenticator.identityCommand(tx, "SYNC_GRANTS", {
    userAccountId: userId, legalEntityId: actor.legalEntityId,
    actorUserAccountId: actor.userAccountId
  });
}

async function revokeAllSessions(
  tx: SqlExecutor,
  authenticator: SandboxAuthenticator,
  userId: string
): Promise<number> {
  const result = await authenticator.identityCommand(tx, "REVOKE_USER_SESSIONS", { userAccountId: userId });
  return result.affected;
}

interface UserRow {
  readonly id: string; readonly login_identifier: string; readonly display_name: string; readonly status: AccountStatus;
  readonly job_title: string | null; readonly contact_email: string | null; readonly contact_phone: string | null;
}

/** A target account must belong to the actor's legal entity. */
async function requireUser(
  tx: SqlExecutor, authenticator: SandboxAuthenticator, actor: Actor, userId: string
): Promise<UserRow> {
  assertIdentity(/^[0-9a-f-]{36}$/i.test(userId), "NOT_FOUND", "That employee account does not exist in your company.");
  await authenticator.identityLock(tx, "USER_ACCOUNT", {
    userAccountId: userId, legalEntityId: actor.legalEntityId
  });
  const rows = await tx.query<UserRow>(
    `SELECT u.id, u.login_identifier, u.display_name, u.status, u.job_title, u.contact_email, u.contact_phone
       FROM abos.user_accounts u
      WHERE u.id = $1 AND ${memberOfEntity("u", "$2")}`,
    [userId, actor.legalEntityId]
  );
  const row = rows.rows[0];
  assertIdentity(row !== undefined, "NOT_FOUND", "That employee account does not exist in your company.");
  return row;
}

/**
 * An employee account is administered only in its primary legal entity. Password, status and
 * sessions are global to the account, so an account that also holds access in another legal entity
 * is refused here and must be managed with authority over both.
 */
function memberOfEntity(alias: string, entityParameter: string): string {
  return `(${alias}.primary_legal_entity_id = ${entityParameter}
    AND NOT EXISTS (SELECT 1 FROM abos.user_permission_grants og WHERE og.user_account_id = ${alias}.id
                     AND og.legal_entity_id <> ${entityParameter} AND og.revoked_at IS NULL)
    AND NOT EXISTS (SELECT 1 FROM abos.user_role_assignments oa WHERE oa.user_account_id = ${alias}.id
                     AND oa.legal_entity_id <> ${entityParameter} AND oa.revoked_at IS NULL))`;
}

async function loadUsers(tx: SqlExecutor, actor: Actor, userId: string | null): Promise<UserSummary[]> {
  const rows = await tx.query<UserRow & {
    readonly created_at: Date | string; readonly has_credential: boolean; readonly must_change_password: boolean | null;
    readonly roles: { id: string; name: string }[]; readonly permissions: string[]; readonly active_sessions: number;
  }>(
    `SELECT u.id, u.login_identifier, u.display_name, u.status, u.job_title, u.contact_email, u.contact_phone, u.created_at,
            (c.user_account_id IS NOT NULL) AS has_credential, c.must_change_password,
            coalesce((SELECT jsonb_agg(jsonb_build_object('id', r.id, 'name', r.role_name) ORDER BY r.role_name)
                        FROM abos.user_role_assignments a JOIN abos.access_roles r ON r.id = a.role_id
                       WHERE a.user_account_id = u.id AND a.legal_entity_id = $1 AND a.revoked_at IS NULL), '[]'::jsonb) AS roles,
            coalesce((SELECT jsonb_agg(g.permission_code ORDER BY g.permission_code) FROM abos.user_permission_grants g
                       WHERE g.user_account_id = u.id AND g.legal_entity_id = $1 AND g.revoked_at IS NULL), '[]'::jsonb) AS permissions,
            (SELECT count(*)::int FROM abos.sandbox_sessions s
              WHERE s.user_account_id = u.id AND s.revoked_at IS NULL AND s.expires_at > clock_timestamp()) AS active_sessions
       FROM abos.user_accounts u
       LEFT JOIN abos.user_credentials c ON c.user_account_id = u.id
      WHERE ${memberOfEntity("u", "$1")} AND ($2::uuid IS NULL OR u.id = $2::uuid)
      ORDER BY u.display_name`,
    [actor.legalEntityId, userId]
  );
  return rows.rows.map((row) => ({
    id: row.id,
    loginIdentifier: row.login_identifier,
    displayName: row.display_name,
    jobTitle: row.job_title,
    contactEmail: row.contact_email,
    contactPhone: row.contact_phone,
    status: row.status,
    canSignIn: row.has_credential && row.status === "ACTIVE" && row.permissions.length > 0,
    mustChangePassword: row.must_change_password === true,
    roles: row.roles,
    permissions: row.permissions,
    activeSessions: row.active_sessions,
    isYou: row.id === actor.userAccountId,
    createdAt: iso(row.created_at)
  }));
}

interface RoleRow { readonly id: string; readonly name: string; readonly status: "ACTIVE" | "INACTIVE"; readonly permissions: string[] }

async function loadRolesById(
  tx: SqlExecutor, authenticator: SandboxAuthenticator, legalEntityId: string, ids: readonly string[]
): Promise<RoleRow[]> {
  if (ids.length === 0) return [];
  assertIdentity(ids.every((id) => /^[0-9a-f-]{36}$/i.test(id)), "NOT_FOUND", "One of the selected roles does not exist.");
  // Lock first. A concurrent role edit holds the role row FOR UPDATE until it commits; the
  // permissions are read afterwards, in a new statement, so they are the committed ones.
  await authenticator.identityLock(tx, "ACCESS_ROLES", { legalEntityId, roleIds: ids });
  const locked = await tx.query<{ readonly id: string; readonly name: string; readonly status: "ACTIVE" | "INACTIVE" }>(
    `SELECT r.id, r.role_name AS name, r.status FROM abos.access_roles r
      WHERE r.legal_entity_id = $1 AND r.id = ANY($2::uuid[])`,
    [legalEntityId, ids]
  );
  const permissions = await tx.query<{ readonly role_id: string; readonly permission_code: string }>(
    "SELECT role_id, permission_code FROM abos.access_role_permissions WHERE role_id = ANY($1::uuid[]) ORDER BY permission_code",
    [locked.rows.map((row) => row.id)]
  );
  return locked.rows.map((row) => ({ ...row, permissions: permissions.rows.filter((item) => item.role_id === row.id).map((item) => item.permission_code) }));
}

async function loadRoleViews(tx: SqlExecutor, actor: Actor, roleId: string | null): Promise<RoleView[]> {
  const rows = await tx.query<{
    readonly id: string; readonly role_name: string; readonly description: string; readonly status: "ACTIVE" | "INACTIVE";
    readonly version: number; readonly created_at: Date | string; readonly permissions: string[];
    readonly holders: { id: string; displayName: string; status: AccountStatus }[];
  }>(
    `SELECT r.id, r.role_name, r.description, r.status, r.version, r.created_at,
            coalesce((SELECT jsonb_agg(rp.permission_code ORDER BY rp.permission_code) FROM abos.access_role_permissions rp
                       WHERE rp.role_id = r.id), '[]'::jsonb) AS permissions,
            coalesce((SELECT jsonb_agg(jsonb_build_object('id', u.id, 'displayName', u.display_name, 'status', u.status) ORDER BY u.display_name)
                        FROM abos.user_role_assignments a JOIN abos.user_accounts u ON u.id = a.user_account_id
                       WHERE a.role_id = r.id AND a.revoked_at IS NULL), '[]'::jsonb) AS holders
       FROM abos.access_roles r
      WHERE r.legal_entity_id = $1 AND ($2::uuid IS NULL OR r.id = $2::uuid)
      ORDER BY r.status, r.role_name`,
    [actor.legalEntityId, roleId]
  );
  return rows.rows.map((row) => ({
    id: row.id, name: row.role_name, description: row.description, status: row.status, version: row.version,
    permissions: row.permissions, holders: row.holders,
    youHoldThis: row.holders.some((holder) => holder.id === actor.userAccountId),
    createdAt: iso(row.created_at)
  }));
}

async function loadAudit(tx: SqlExecutor, legalEntityId: string, userId: string | null, limit: number): Promise<AuditEntry[]> {
  const rows = await tx.query<{
    readonly id: string; readonly occurred_at: Date | string; readonly action: string; readonly entity_type: string;
    readonly actor_name: string | null; readonly target_name: string | null; readonly before_state: Record<string, unknown> | null;
    readonly after_state: Record<string, unknown> | null;
  }>(
    `SELECT a.id, a.occurred_at, a.action, a.entity_type, actor.display_name AS actor_name,
            coalesce(target_user.display_name, target_role.role_name) AS target_name, a.before_state, a.after_state
       FROM abos.access_audit_records a
       LEFT JOIN abos.user_accounts actor ON actor.id = a.actor_user_account_id
       LEFT JOIN abos.user_accounts target_user ON a.entity_type = 'USER_ACCOUNT' AND target_user.id = a.entity_id
       LEFT JOIN abos.access_roles target_role ON a.entity_type = 'ACCESS_ROLE' AND target_role.id = a.entity_id
      WHERE a.legal_entity_id = $1 AND a.entity_type IN ('USER_ACCOUNT', 'ACCESS_ROLE', 'COMPANY_PROFILE')
        AND ($2::uuid IS NULL OR a.entity_id = $2::uuid)
      ORDER BY a.occurred_at DESC, a.id
      LIMIT $3`,
    [legalEntityId, userId, limit]
  );
  return rows.rows.map((row) => ({
    id: row.id, occurredAt: iso(row.occurred_at), action: row.action, entityType: row.entity_type,
    actor: row.actor_name ?? "System", target: row.target_name ?? "—",
    summary: { before: row.before_state ?? null, after: row.after_state ?? null }
  }));
}

async function writeAudit(tx: SqlExecutor, authenticator: SandboxAuthenticator, input: {
  readonly actor: string; readonly legalEntityId: string; readonly action: string; readonly entityType: "USER_ACCOUNT" | "ACCESS_ROLE";
  readonly entityId: string; readonly before?: Record<string, unknown>; readonly after?: Record<string, unknown>;
}): Promise<void> {
  await authenticator.identityCommand(tx, "WRITE_AUDIT", {
    id: randomUUID(), actorUserAccountId: input.actor, legalEntityId: input.legalEntityId,
    correlationId: randomUUID(), action: input.action, entityType: input.entityType,
    entityId: input.entityId, before: input.before ?? null, after: input.after ?? null,
    metadata: { source: "v1-identity-admin" }
  });
}

function translateDatabaseError(error: unknown): unknown {
  if (error instanceof IdentityError) return error;
  const code = error !== null && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
  const message = error instanceof Error ? error.message : "";
  if (code === "42501" && /sign in with an active account/.test(message)) {
    return new IdentityError("AUTHENTICATION_REQUIRED", "Your session has ended. Sign in again.");
  }
  if (code === "42501" && /current authority is missing/.test(message)) {
    return new IdentityError("PERMISSION_DENIED", "You do not have permission to manage finance workflows.");
  }
  if (code === "23514" && /workflow policy changed/.test(message)) {
    return new IdentityError("STALE_VERSION", "Someone else changed this workflow. Reload it and try again.");
  }
  if (code === "22023" && /workflow|approval flag/.test(message)) {
    return new IdentityError("VALIDATION_FAILED", "The workflow policy change is not valid.");
  }
  if (code === "23514" && /last active super administrator/.test(message)) {
    return new IdentityError("LAST_SUPER_ADMIN", "This would leave the company without an active Super Administrator. Appoint another one first.");
  }
  if (code === "23514" && /user_permission_grants_check|user_role_assignments_check/.test(message + String((error as { constraint?: unknown }).constraint ?? ""))) {
    return new IdentityError("SELF_CHANGE_FORBIDDEN", "Nobody can give access to themselves. Another administrator must do it.");
  }
  if (code === "23505") return new IdentityError("DUPLICATE", "That name is already in use.");
  if (code === "23514" && /only a super administrator can grant administration/.test(message)) {
    return new IdentityError("SUPER_ADMIN_REQUIRED", "Only a Super Administrator can give administration access.");
  }
  if (code === "23514" && /not available/.test(message)) {
    return new IdentityError("VALIDATION_FAILED", "Some selected permissions are not available in this version.");
  }
  return error;
}
