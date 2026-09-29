import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { SqlExecutor } from "@abos/database";
import { sandboxGateFingerprint, TREASURY_PERMISSIONS } from "@abos/contracts";
import type {
  CostCenterId,
  DepartmentId,
  FinancePermission,
  CompanyDashboardSummary,
  FinanceWorkflowPolicyWorkspace,
  FinanceWorkflowType,
  LegalEntityId,
  OperationalExpenseApproveBody,
  OperationalExpenseCategoryUpsert,
  OperationalExpenseCreate,
  OperationalExpenseMutationResult,
  OperationalExpenseEntryOptions,
  OperationalExpenseWorkspace,
  OperationalExpenseWorkspaceQuery,
  OperationalFinanceDailyReport,
  OperationalFinanceConfigurationWorkspace,
  OperationalPeriodOpen,
  OperationalTreasuryAccountUpsert,
  ProjectId,
  SandboxAuthorization,
  SandboxLegalEntityScope,
  SandboxPostingGate,
  ServerActorContext,
  ShareholderSetupAction,
  ShareholderSetupCommand,
  ShareholderSetupResult,
  ShareholderSetupWorkspace,
  SupportedCurrency,
  TransactionDimensions,
  TreasuryPermission,
  UserAccountId
} from "@abos/contracts";
import type { SandboxAuthConfiguration } from "./configuration.ts";
import { assertSandbox, SandboxAuthError } from "./errors.ts";

/** Fixed allow-list: a command name never reaches SQL except through this map. */
const SHAREHOLDER_SETUP_ENTRY_POINTS: Readonly<Record<ShareholderSetupAction, string>> = {
  "create-shareholder": "shareholder_setup_create_shareholder",
  "correct-shareholder": "shareholder_setup_correct_shareholder",
  "create-agreement": "shareholder_setup_create_agreement",
  "update-agreement": "shareholder_setup_update_agreement",
  "add-installment": "shareholder_setup_add_installment",
  "update-installment": "shareholder_setup_update_installment",
  "cancel-installment": "shareholder_setup_cancel_installment",
  "record-agreement-document": "shareholder_setup_record_agreement_evidence"
};

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
  async resolveGate(legalEntityId: LegalEntityId, executor: SqlExecutor = this.database): Promise<SandboxPostingGate> {
    const authorization = await this.loadAuthorization(executor);
    const scope = await executor.query<{
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
    /** Identity login only: the credential hash that was verified before this transaction. */
    readonly expectedPasswordHash?: string;
  }, executor: SqlExecutor = this.database): Promise<IssuedSandboxSession> {
    await this.resolveGate(input.legalEntityId, executor);

    const ttl = input.ttlSeconds ?? this.configuration.maxSessionSeconds;
    assertSandbox(
      Number.isInteger(ttl) && ttl > 0 && ttl <= this.configuration.maxSessionSeconds,
      "POLICY_CONFIGURATION_PENDING",
      `Session lifetime must be between 1 and ${this.configuration.maxSessionSeconds} seconds`
    );

    const context = await executor.query<{
      readonly value: {
        readonly status: string | null; readonly grantCount: number;
        readonly credentialCurrent: boolean;
      };
    }>("SELECT abos.identity_issue_session_context($1,$2,$3,$4) AS value", [
      this.identityDatabaseProof(), input.userAccountId, input.legalEntityId,
      input.expectedPasswordHash ?? null
    ]);
    const account = context.rows[0]?.value;
    assertSandbox(account?.status !== null && account?.status !== undefined, "AUTHENTICATION_REQUIRED", "Unknown user account");
    assertSandbox(
      account.status === "ACTIVE",
      "AUTHENTICATION_REQUIRED",
      `User account is ${account.status}`
    );

    // Any current grant counts, including administration: an administrator who holds no Treasury
    // or Finance permission still needs a session, and still gets no Treasury or Finance authority.
    assertSandbox(
      account.grantCount > 0,
      "PERMISSION_DENIED",
      "User account holds no permission in this legal entity"
    );
    assertSandbox(
      input.expectedPasswordHash === undefined || account.credentialCurrent,
      "AUTHENTICATION_REQUIRED",
      "Credentials changed before the session could be issued"
    );

    const issuedAt = this.now();
    const expiresAt = new Date(issuedAt.getTime() + ttl * 1000);
    const token = randomBytes(32).toString("base64url");
    const sessionId = randomUUID();

    await this.identityCommand(executor, "ISSUE_SESSION", {
      id: sessionId,
      userAccountId: input.userAccountId,
      tokenSha256: this.digest(token),
      runtimeTokenSha256: createHash("sha256").update(token).digest("hex"),
      legalEntityId: input.legalEntityId,
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString()
    });

    return {
      sessionId,
      token,
      userAccountId: input.userAccountId,
      legalEntityId: input.legalEntityId,
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString()
    };
  }

  /** Atomically replace one live session. The database locks and revokes the old row. */
  async rotateSession(executor: SqlExecutor, oldToken: string): Promise<IssuedSandboxSession> {
    const issuedAt = this.now();
    const expiresAt = new Date(issuedAt.getTime() + this.configuration.maxSessionSeconds * 1000);
    const token = randomBytes(32).toString("base64url");
    const sessionId = randomUUID();
    const result = await this.identityCommand(executor, "ROTATE_SESSION", {
      oldRuntimeTokenSha256: createHash("sha256").update(oldToken).digest("hex"),
      oldTokenSha256: this.digest(oldToken), id: sessionId,
      tokenSha256: this.digest(token),
      runtimeTokenSha256: createHash("sha256").update(token).digest("hex"),
      issuedAt: issuedAt.toISOString(), expiresAt: expiresAt.toISOString()
    }) as { readonly affected: number; readonly userAccountId: UserAccountId; readonly legalEntityId: LegalEntityId };
    assertSandbox(result.affected === 1, "AUTHENTICATION_REQUIRED", "Sandbox session was already rotated");
    return {
      sessionId, token, userAccountId: result.userAccountId, legalEntityId: result.legalEntityId,
      issuedAt: issuedAt.toISOString(), expiresAt: expiresAt.toISOString()
    };
  }

  async identityActorContext(executor: SqlExecutor, token: string): Promise<{
    readonly id: string; readonly userAccountId: string; readonly legalEntityId: string;
    readonly live: boolean; readonly status: string; readonly loginIdentifier: string;
    readonly mustChangePassword: boolean; readonly permissions: readonly string[];
  } | null> {
    const result = await executor.query<{ readonly value: {
      readonly id: string; readonly userAccountId: string; readonly legalEntityId: string;
      readonly live: boolean; readonly status: string; readonly loginIdentifier: string;
      readonly mustChangePassword: boolean; readonly permissions: readonly string[];
    } | null }>("SELECT abos.identity_actor_context($1,$2,$3) AS value", [
      this.identityDatabaseProof(),
      createHash("sha256").update(token).digest("hex"), this.digest(token)
    ]);
    return result.rows[0]?.value ?? null;
  }

  /** Read legal-entity workflow policy through the narrow configuration-owner boundary. */
  async financeWorkflowPolicies(
    executor: SqlExecutor,
    token: string
  ): Promise<FinanceWorkflowPolicyWorkspace> {
    const result = await executor.query<{ readonly value: FinanceWorkflowPolicyWorkspace }>(
      "SELECT abos.finance_workflow_policy_workspace($1,$2,$3) AS value",
      [this.identityDatabaseProof(),
       createHash("sha256").update(token).digest("hex"), this.digest(token)]
    );
    const value = result.rows[0]?.value;
    assertSandbox(value !== undefined, "POLICY_CONFIGURATION_PENDING", "Workflow policy configuration is unavailable");
    return value;
  }

  /** Append one policy version; actor, entity and permission are resolved inside PostgreSQL. */
  async setFinanceWorkflowPolicy(
    executor: SqlExecutor,
    token: string,
    input: {
      readonly workflowType: FinanceWorkflowType;
      readonly approvalRequired: boolean;
      readonly expectedVersion: number;
      readonly changeReason: string;
    }
  ): Promise<FinanceWorkflowPolicyWorkspace> {
    const result = await executor.query<{ readonly value: FinanceWorkflowPolicyWorkspace }>(
      "SELECT abos.finance_workflow_policy_set($1,$2,$3,$4,$5,$6,$7) AS value",
      [this.identityDatabaseProof(),
       createHash("sha256").update(token).digest("hex"), this.digest(token),
       input.workflowType, input.approvalRequired, input.expectedVersion, input.changeReason]
    );
    const value = result.rows[0]?.value;
    assertSandbox(value !== undefined, "POLICY_CONFIGURATION_PENDING", "Workflow policy update returned no result");
    return value;
  }

  /** Read operational Finance configuration through the restricted Finance runtime. */
  async operationalFinanceConfiguration(
    executor: SqlExecutor,
    token: string
  ): Promise<OperationalFinanceConfigurationWorkspace> {
    return this.operationalFinanceFunction<OperationalFinanceConfigurationWorkspace>(
      executor,
      "SELECT abos.operational_finance_configuration_workspace($1,$2,$3) AS value",
      token,
      [],
      "Operational Finance configuration is unavailable"
    );
  }

  /** Create or update one Treasury account; the database derives actor and legal entity. */
  async upsertOperationalTreasuryAccount(
    executor: SqlExecutor,
    token: string,
    input: OperationalTreasuryAccountUpsert
  ): Promise<OperationalFinanceConfigurationWorkspace> {
    return this.operationalFinanceFunction<OperationalFinanceConfigurationWorkspace>(
      executor,
      "SELECT abos.operational_treasury_account_upsert($1,$2,$3,$4::jsonb) AS value",
      token,
      [JSON.stringify(input)],
      "Treasury account configuration returned no result"
    );
  }

  /** Create or update one expense category; the database derives actor and legal entity. */
  async upsertOperationalExpenseCategory(
    executor: SqlExecutor,
    token: string,
    input: OperationalExpenseCategoryUpsert
  ): Promise<OperationalFinanceConfigurationWorkspace> {
    return this.operationalFinanceFunction<OperationalFinanceConfigurationWorkspace>(
      executor,
      "SELECT abos.operational_expense_category_upsert($1,$2,$3,$4::jsonb) AS value",
      token,
      [JSON.stringify(input)],
      "Expense category configuration returned no result"
    );
  }

  /** Open one pending period through the separately permissioned database entry point. */
  async openOperationalFinancePeriod(
    executor: SqlExecutor,
    token: string,
    input: OperationalPeriodOpen
  ): Promise<OperationalFinanceConfigurationWorkspace> {
    return this.operationalFinanceFunction<OperationalFinanceConfigurationWorkspace>(
      executor,
      "SELECT abos.finance_open_accounting_period($1,$2,$3,$4::uuid,$5::integer,$6) AS value",
      token,
      [input.periodId, input.expectedVersion, input.reason],
      "Opening the accounting period returned no result"
    );
  }

  /** Read scoped operational expenses through the restricted Finance runtime. */
  async operationalExpenseWorkspace(
    executor: SqlExecutor,
    token: string,
    query: OperationalExpenseWorkspaceQuery
  ): Promise<OperationalExpenseWorkspace> {
    return this.operationalFinanceFunction<OperationalExpenseWorkspace>(
      executor,
      "SELECT abos.operational_expense_workspace($1,$2,$3,$4::date,$5::date) AS value",
      token,
      [query.from, query.to],
      "Operational expense workspace is unavailable"
    );
  }

  /** Create, value and route one operational expense; identity is always database-derived. */
  async createOperationalExpense(
    executor: SqlExecutor,
    token: string,
    input: OperationalExpenseCreate
  ): Promise<OperationalExpenseMutationResult> {
    return this.operationalFinanceFunction<OperationalExpenseMutationResult>(
      executor,
      "SELECT abos.operational_expense_create($1,$2,$3,$4::jsonb) AS value",
      token,
      [JSON.stringify(input)],
      "Operational expense creation returned no result"
    );
  }

  /** Approve and post one expense through the independent Finance approval entry point. */
  async approveOperationalExpense(
    executor: SqlExecutor,
    token: string,
    expenseId: string,
    input: OperationalExpenseApproveBody
  ): Promise<OperationalExpenseMutationResult> {
    return this.operationalFinanceFunction<OperationalExpenseMutationResult>(
      executor,
      "SELECT abos.operational_expense_approve($1,$2,$3,$4::uuid,$5::integer,$6) AS value",
      token,
      [expenseId, input.expectedVersion, input.note],
      "Operational expense approval returned no result"
    );
  }

  /** Shareholders, capital agreements, installments and documents (shareholder.setup.manage or shareholder.read). */
  async shareholderSetupWorkspace(executor: SqlExecutor, token: string): Promise<ShareholderSetupWorkspace> {
    return this.operationalFinanceFunction<ShareholderSetupWorkspace>(
      executor,
      "SELECT abos.shareholder_setup_workspace($1,$2,$3) AS value",
      token,
      [],
      "Shareholder setup is unavailable"
    );
  }

  /**
   * One shareholder setup command through its reviewed entry point. The database derives actor and
   * legal entity, checks shareholder.setup.manage and refuses anything outside DRAFT setup.
   */
  async shareholderSetupCommand(executor: SqlExecutor, token: string, command: ShareholderSetupCommand): Promise<ShareholderSetupResult> {
    const { action, ...payload } = command;
    const entryPoint = SHAREHOLDER_SETUP_ENTRY_POINTS[action];
    assertSandbox(entryPoint !== undefined, "POLICY_CONFIGURATION_PENDING", "Unknown shareholder setup command");
    return this.operationalFinanceFunction<ShareholderSetupResult>(
      executor,
      `SELECT abos.${entryPoint}($1,$2,$3,$4::jsonb) AS value`,
      token,
      [JSON.stringify(payload)],
      "Shareholder setup returned no result"
    );
  }

  /** Aggregate company dashboard figures; refused without company.dashboard.read (read only). */
  async companyDashboardSummary(executor: SqlExecutor, token: string): Promise<CompanyDashboardSummary> {
    return this.operationalFinanceFunction<CompanyDashboardSummary>(
      executor,
      "SELECT abos.company_dashboard_summary($1,$2,$3) AS value",
      token,
      [],
      "The company dashboard is unavailable"
    );
  }

  /** Options for recording an expense on one business date (read only). */
  async operationalExpenseEntryOptions(
    executor: SqlExecutor,
    token: string,
    date: string
  ): Promise<OperationalExpenseEntryOptions> {
    return this.operationalFinanceFunction<OperationalExpenseEntryOptions>(
      executor,
      "SELECT abos.operational_expense_entry_options($1,$2,$3,$4::date) AS value",
      token,
      [date],
      "Operational expense options are unavailable"
    );
  }

  /** The Daily Financial Report for one date, in the actor's live scope (read only). */
  async operationalFinanceDailyReport(
    executor: SqlExecutor,
    token: string,
    date: string
  ): Promise<OperationalFinanceDailyReport> {
    return this.operationalFinanceFunction<OperationalFinanceDailyReport>(
      executor,
      "SELECT abos.operational_finance_daily_report($1,$2,$3,$4::date) AS value",
      token,
      [date],
      "The daily financial report is unavailable"
    );
  }

  private async operationalFinanceFunction<T>(
    executor: SqlExecutor,
    sql: string,
    token: string,
    parameters: readonly unknown[],
    missingMessage: string
  ): Promise<T> {
    const result = await executor.query<{ readonly value: T }>(sql, [
      this.identityDatabaseProof(),
      createHash("sha256").update(token).digest("hex"),
      this.digest(token),
      ...parameters
    ]);
    const value = result.rows[0]?.value;
    assertSandbox(value !== undefined, "POLICY_CONFIGURATION_PENDING", missingMessage);
    return value;
  }

  /** Acquire a finite, owner-held identity row lock without granting table UPDATE to the runtime. */
  async identityLock(
    executor: SqlExecutor,
    operation: "LEGAL_ENTITY_PROFILE" | "USER_ACCOUNT" | "USER_ASSIGNMENTS" | "ACCESS_ROLE" | "ACCESS_ROLES",
    payload: Readonly<Record<string, unknown>>
  ): Promise<number> {
    const result = await executor.query<{ readonly affected: number }>(
      "SELECT abos.identity_runtime_lock($1,$2,$3::jsonb) AS affected",
      [this.identityDatabaseProof(), operation, JSON.stringify(payload)]
    );
    return result.rows[0]?.affected ?? 0;
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
    const treasuryPermissions = await this.loadTreasuryPermissions(
      session.user_account_id,
      session.legal_entity_id
    );
    const scopes = await this.loadScopes(session.user_account_id, session.legal_entity_id);

    return Object.freeze({
      userAccountId: session.user_account_id,
      permissions: Object.freeze(permissions),
      treasuryPermissions: Object.freeze(treasuryPermissions),
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
   * Re-read Treasury authority inside the transaction that performs a Treasury write.
   *
   * Session, user, sandbox gate and the specific grant are locked FOR SHARE, so a concurrent
   * revocation is ordered against the write instead of racing it. The database triggers from
   * migration 0006 check the grant again against the stored row; this adds the session and gate,
   * which the database cannot see.
   */
  async revalidateTreasuryAuthority(
    transaction: SqlExecutor,
    input: {
      readonly bearerToken: string;
      readonly userAccountId: UserAccountId;
      readonly sessionId: string;
      readonly legalEntityId: LegalEntityId;
      readonly permission: TreasuryPermission;
    }
  ): Promise<void> {
    assertSandbox(
      typeof input.bearerToken === "string" && input.bearerToken.length > 0,
      "AUTHENTICATION_REQUIRED",
      "A sandbox bearer token is required for a Treasury action"
    );
    const sessions = await transaction.query<SessionRow>(
      `SELECT s.id, s.user_account_id, s.legal_entity_id, s.issued_at, s.expires_at,
              s.revoked_at, u.status AS user_status
         FROM abos.sandbox_sessions s
         JOIN abos.user_accounts u ON u.id = s.user_account_id
        WHERE s.token_sha256 = $1
        FOR SHARE OF s, u`,
      [this.digest(input.bearerToken)]
    );
    const session = sessions.rows[0];
    assertSandbox(session !== undefined, "AUTHENTICATION_REQUIRED", "Unknown sandbox session");
    assertSandbox(session.revoked_at === null, "AUTHENTICATION_REQUIRED", "Sandbox session was revoked");
    assertSandbox(
      new Date(iso(session.expires_at)).getTime() > this.now().getTime(),
      "AUTHENTICATION_REQUIRED",
      "Sandbox session expired"
    );
    assertSandbox(session.user_status === "ACTIVE", "AUTHENTICATION_REQUIRED", "User account is inactive");
    assertSandbox(
      session.id === input.sessionId && session.user_account_id === input.userAccountId,
      "AUTHENTICATION_REQUIRED",
      "Treasury actor does not match the current sandbox session"
    );
    assertSandbox(
      session.legal_entity_id === input.legalEntityId,
      "SCOPE_MISMATCH",
      "Treasury actor is outside the legal-entity scope"
    );
    const gate = await transaction.query<{ readonly ok: boolean }>(
      `SELECT (expires_at > clock_timestamp()) AS ok
         FROM abos.sandbox_authorizations WHERE singleton FOR SHARE`
    );
    assertSandbox(gate.rows[0]?.ok === true, "POLICY_CONFIGURATION_PENDING", "Sandbox authorization is no longer current");
    const grant = await transaction.query<{ readonly permission_code: string }>(
      `SELECT permission_code FROM abos.user_permission_grants
        WHERE user_account_id = $1 AND legal_entity_id = $2 AND permission_code = $3
          AND revoked_at IS NULL
        FOR SHARE`,
      [input.userAccountId, input.legalEntityId, input.permission]
    );
    assertSandbox(grant.rows.length === 1, "PERMISSION_DENIED", `Current Treasury authority is missing ${input.permission}`);
  }

  /**
   * Re-read posting authority on the same connection and inside the same transaction that will
   * insert the journal. Row locks serialize a concurrent grant/session/user/gate revocation with
   * posting; under REPEATABLE READ a changed row raises a serialization error and the entire
   * transaction must retry. A context captured at request authentication is never sufficient.
   */
  async revalidatePostingAuthority(
    transaction: SqlExecutor,
    input: {
      readonly bearerToken: string;
      readonly actor: ServerActorContext;
      readonly legalEntityId: LegalEntityId;
      readonly dimensions: TransactionDimensions;
    }
  ): Promise<void> {
    assertSandbox(
      typeof input.bearerToken === "string" && input.bearerToken.length > 0,
      "AUTHENTICATION_REQUIRED",
      "A sandbox bearer token is required at posting"
    );
    assertSandbox(
      input.dimensions.legalEntityId === input.legalEntityId,
      "SCOPE_MISMATCH",
      "Posting dimensions belong to another legal entity"
    );

    const sessions = await transaction.query<SessionRow>(
      `SELECT s.id, s.user_account_id, s.legal_entity_id, s.issued_at, s.expires_at,
              s.revoked_at, u.status AS user_status
         FROM abos.sandbox_sessions s
         JOIN abos.user_accounts u ON u.id = s.user_account_id
        WHERE s.token_sha256 = $1
        FOR SHARE OF s, u`,
      [this.digest(input.bearerToken)]
    );
    const session = sessions.rows[0];
    assertSandbox(session !== undefined, "AUTHENTICATION_REQUIRED", "Unknown sandbox session");
    assertSandbox(session.revoked_at === null, "AUTHENTICATION_REQUIRED", "Sandbox session was revoked");
    assertSandbox(
      new Date(iso(session.expires_at)).getTime() > this.now().getTime(),
      "AUTHENTICATION_REQUIRED",
      "Sandbox session expired"
    );
    assertSandbox(session.user_status === "ACTIVE", "AUTHENTICATION_REQUIRED", "User account is inactive");
    assertSandbox(
      session.id === input.actor.sessionId && session.user_account_id === input.actor.userAccountId,
      "AUTHENTICATION_REQUIRED",
      "Posting actor does not match the current sandbox session"
    );
    assertSandbox(
      session.legal_entity_id === input.legalEntityId &&
        input.actor.legalEntityIds.includes(input.legalEntityId),
      "SCOPE_MISMATCH",
      "Posting actor is outside the legal-entity scope"
    );

    // Lock both rows; a concurrent operator revocation must complete before or after this commit.
    const authorization = await transaction.query<AuthorizationRow>(
      `SELECT environment, configuration_state, policy_version_id, real_posting_enabled,
              runtime_marker, authorized_by_user_account_id, authorized_at, expires_at
         FROM abos.sandbox_authorizations WHERE singleton FOR SHARE`
    );
    const gate = authorization.rows[0];
    assertSandbox(gate !== undefined, "POLICY_CONFIGURATION_PENDING", "Sandbox authorization is absent");
    assertSandbox(
      gate.configuration_state === "SYNTHETIC_TEST_ONLY" &&
        gate.environment === this.configuration.environment &&
        gate.real_posting_enabled === false &&
        equalsConstantTime(gate.runtime_marker, this.configuration.runtimeMarker) &&
        new Date(iso(gate.expires_at)).getTime() > this.now().getTime(),
      "POLICY_CONFIGURATION_PENDING",
      "Sandbox authorization is no longer current"
    );
    const scope = await transaction.query<{ readonly legal_entity_id: LegalEntityId }>(
      `SELECT legal_entity_id FROM abos.sandbox_legal_entity_scopes
        WHERE legal_entity_id = $1 FOR SHARE`,
      [input.legalEntityId]
    );
    assertSandbox(scope.rows.length === 1, "SCOPE_MISMATCH", "Legal entity is outside the sandbox gate");

    const required: readonly FinancePermission[] = [
      "finance.posting-intent.approve",
      "finance.journal.post"
    ];
    const grants = await transaction.query<{ readonly permission_code: FinancePermission }>(
      `SELECT permission_code FROM abos.user_permission_grants
        WHERE user_account_id = $1 AND legal_entity_id = $2
          AND permission_code = ANY($3::text[]) AND revoked_at IS NULL
        FOR SHARE`,
      [session.user_account_id, input.legalEntityId, required]
    );
    for (const permission of required) {
      assertSandbox(
        input.actor.permissions.includes(permission) &&
          grants.rows.some((grant) => grant.permission_code === permission),
        "PERMISSION_DENIED",
        `Current Finance authority is missing ${permission}`
      );
    }

    const dimensions = input.dimensions;
    const requiredScopes: readonly (readonly ["PROJECT" | "DEPARTMENT" | "COST_CENTER", string])[] = [
      ...(dimensions.scope === "PROJECT_LEVEL" ? [["PROJECT", dimensions.projectId] as const] : []),
      ...(dimensions.departmentId === undefined ? [] : [["DEPARTMENT", dimensions.departmentId] as const]),
      ...(dimensions.costCenterId === undefined ? [] : [["COST_CENTER", dimensions.costCenterId] as const])
    ];
    if (requiredScopes.length > 0) {
      const scopes = await transaction.query<{
        readonly scope_kind: "PROJECT" | "DEPARTMENT" | "COST_CENTER";
        readonly scope_id: string;
      }>(
        `SELECT scope_kind, scope_id FROM abos.user_scope_grants
          WHERE user_account_id = $1 AND legal_entity_id = $2 AND revoked_at IS NULL
          FOR SHARE`,
        [session.user_account_id, input.legalEntityId]
      );
      for (const [kind, id] of requiredScopes) {
        const actorIds: readonly string[] =
          kind === "PROJECT" ? input.actor.projectIds :
          kind === "DEPARTMENT" ? input.actor.departmentIds : input.actor.costCenterIds ?? [];
        assertSandbox(
          actorIds.includes(id) && scopes.rows.some((row) => row.scope_kind === kind && row.scope_id === id),
          "SCOPE_MISMATCH",
          `Current ${kind.toLowerCase()} grant is missing`
        );
      }
    }
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

  /** Bind identity-service session reads to the process-held pepper as well as the runtime hash. */
  sessionTokenDigest(token: string): string {
    return this.digest(token);
  }

  /** Execute one whitelisted identity mutation after proving possession of the server secret. */
  async identityCommand(
    executor: SqlExecutor,
    operation: string,
    payload: Readonly<Record<string, unknown>>
  ): Promise<{ readonly affected: number }> {
    const result = await executor.query<{ readonly value: { readonly affected: number } }>(
      "SELECT abos.identity_runtime_command($1, $2, $3::jsonb) AS value",
      [this.identityDatabaseProof(), operation, JSON.stringify(payload)]
    );
    return result.rows[0]?.value ?? { affected: 0 };
  }

  private signGate(gate: Omit<SandboxPostingGate, "signature">): string {
    return createHmac("sha256", this.configuration.signingSecret)
      .update(sandboxGateFingerprint(gate))
      .digest("hex");
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.identityCommand(this.database, "REVOKE_SESSION_ID", { sessionId });
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

  private async loadAuthorization(executor: SqlExecutor = this.database): Promise<SandboxAuthorization> {
    const result = await executor.query<AuthorizationRow>(
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

  private async loadTreasuryPermissions(
    userAccountId: UserAccountId,
    legalEntityId: LegalEntityId
  ): Promise<TreasuryPermission[]> {
    const result = await this.database.query<{ readonly permission_code: string }>(
      `SELECT permission_code
         FROM abos.user_permission_grants
        WHERE user_account_id = $1 AND legal_entity_id = $2 AND revoked_at IS NULL
        ORDER BY permission_code`,
      [userAccountId, legalEntityId]
    );
    // Kept apart from Finance permissions: a Treasury grant never authorizes posting.
    return result.rows
      .map((row) => row.permission_code)
      .filter((code): code is TreasuryPermission => TREASURY_CODES.has(code));
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

  /**
   * The proof the identity database functions accept. It is derived from, but is not, the signing
   * secret: the raw key also signs gates and peppers token digests, and it never leaves the process.
   */
  private identityDatabaseProof(): string {
    return identityDatabaseProof(this.configuration.signingSecret);
  }

  private digest(token: string): string {
    return createHmac("sha256", this.configuration.signingSecret).update(token).digest("hex");
  }
}

const IDENTITY_DATABASE_PROOF_CONTEXT = "abos-identity-database-proof-v1";

/** Domain-separated proof sent to the identity SECURITY DEFINER functions instead of the raw secret. */
export function identityDatabaseProof(signingSecret: string): string {
  return createHmac("sha256", signingSecret).update(IDENTITY_DATABASE_PROOF_CONTEXT).digest("hex");
}

/** The SHA-256 digest an owner connection provisions in `abos.identity_runtime_configuration`. */
export function identityDatabaseProofDigest(signingSecret: string): string {
  return createHash("sha256").update(identityDatabaseProof(signingSecret), "utf8").digest("hex");
}

const TREASURY_CODES: ReadonlySet<string> = new Set<string>(TREASURY_PERMISSIONS);

const FINANCE_PERMISSIONS: ReadonlySet<string> = new Set<FinancePermission>([
  "finance.posting-intent.create",
  "finance.posting-intent.approve",
  "finance.journal.post",
  "finance.journal.reverse",
  "finance.report.operational.read",
  "finance.expense-category.manage",
  "finance.expense.create",
  "finance.expense.read",
  "finance.expense.approve",
  "finance.period.manage"
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
