import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import test, { after, before, describe } from "node:test";
import pg from "pg";

import { bootstrapSuperAdmin, IdentityService } from "@abos/identity";
import { PostgresExecutor } from "@abos/persistence";
import { identityDatabaseProof, SandboxAuthenticator } from "@abos/sandbox-auth";

import { databaseUrl, MISSING_DATABASE_MESSAGE, openHarness, resetSchema, type Harness } from "./harness.ts";
import { seedSyntheticWorld, SYNTHETIC_AUTH_CONFIGURATION } from "./synthetic-world.ts";

/** Migration 0027: restricted Operational Finance configuration, without posting. */

const MARKER = SYNTHETIC_AUTH_CONFIGURATION.runtimeMarker;
const IDENTITY_LOGIN = {
  name: "abos_v1_operational_config_test_login",
  password: "synthetic-operational-config-runtime-only-2026"
};
const FINANCE_LOGIN = {
  name: "abos_v1_operational_finance_test_login",
  password: "synthetic-operational-finance-runtime-only-2026"
};
const CLIENT = "203.0.113.27";

interface SessionArgs {
  readonly proof: string;
  readonly runtimeDigest: string;
  readonly tokenDigest: string;
}

interface ConfigurationWorkspace {
  readonly legalEntity: { readonly id: string };
  readonly permissions: {
    readonly canManageTreasuryAccounts: boolean;
    readonly canManageExpenseCategories: boolean;
    readonly canManagePeriods: boolean;
  };
  readonly treasuryAccounts: readonly {
    readonly id: string;
    readonly nameEn: string;
    readonly accountType: string;
    readonly version: number;
  }[];
  readonly expenseCategories: readonly {
    readonly id: string;
    readonly ledgerAccountId: string;
  }[];
  readonly periods: readonly {
    readonly id: string;
    readonly status: string;
    readonly version: number;
    readonly openedBy: string | null;
  }[];
}

if (databaseUrl() === undefined) {
  test("V1 Operational Finance configuration", () => assert.fail(MISSING_DATABASE_MESSAGE));
} else {
  describe("V1 Operational Finance configuration (migration 0027)", () => {
    let harness: Harness;
    before(async () => { harness = await openHarness(MARKER); });
    after(async () => { await harness.close(); });

    test("live scoped authority configures valid mappings and opens only a PENDING company period", async () => {
      await resetSchema(harness.pool);
      const world = await seedSyntheticWorld(harness.executor);
      await ensureLogin(harness);
      const identityConnection = await restrictedIdentity();
      const financeConnection = await restrictedFinance();
      const { identity } = identityConnection;
      const { executor } = financeConnection;
      try {
        const bootstrap = await bootstrapSuperAdmin(harness.executor, {
          legalEntityId: world.legalEntityId,
          systemUserAccountId: world.bootstrapUserId,
          loginIdentifier: "operational.config.admin",
          displayName: "Synthetic Operational Config Admin"
        });
        const adminToken = (await identity.changePassword({
          loginIdentifier: "operational.config.admin",
          currentPassword: bootstrap.temporaryPassword,
          newPassword: "Operational configuration administrator 2026",
          clientAddress: CLIENT
        })).token;
        const role = await identity.createRole(adminToken, {
          name: "Operational Finance Configuration",
          description: "Configures Treasury accounts, expense categories and period opening.",
          permissions: [
            "treasury.operational-account.manage",
            "finance.expense-category.manage",
            "finance.period.manage"
          ]
        });
        const user = await identity.createUser(adminToken, {
          loginIdentifier: "operational.config.manager",
          displayName: "Synthetic Operational Config Manager",
          status: "ACTIVE",
          roleIds: [role.id]
        });
        const token = (await identity.changePassword({
          loginIdentifier: "operational.config.manager",
          currentPassword: user.temporaryPassword,
          newPassword: "Operational configuration manager 2026",
          clientAddress: CLIENT
        })).token;
        const session = sessionArgs(token);

        const expenseLedgerId = randomUUID();
        const pendingPeriodId = randomUUID();
        await harness.executor.query(
          `INSERT INTO abos.ledger_accounts
             (id, legal_entity_id, account_code, account_name, account_type,
              posting_allowed, account_currency_code, status)
           VALUES ($1, $2, 'SYN-OP-EXP', 'Synthetic Operational Expense', 'EXPENSE', true, 'USD', 'ACTIVE')`,
          [expenseLedgerId, world.legalEntityId]
        );
        await harness.executor.query(
          `INSERT INTO abos.accounting_periods
             (id, legal_entity_id, period_name, starts_on, ends_on, status)
           VALUES ($1, $2, 'Synthetic October 2026', '2026-10-01', '2026-10-31', 'PENDING')`,
          [pendingPeriodId, world.legalEntityId]
        );

        const initial = await workspace(executor, session);
        assert.deepEqual(initial.permissions, {
          canManageTreasuryAccounts: true,
          canManageExpenseCategories: true,
          canManagePeriods: true
        });
        assert.deepEqual(initial.treasuryAccounts, []);
        assert.deepEqual(initial.expenseCategories, []);

        const treasury = await treasuryUpsert(executor, session, {
          nameEn: "Synthetic Main Safe",
          nameFa: "صندوق اصلی آزمایشی",
          accountType: "SAFE",
          currencyCode: "USD",
          ledgerAccountId: world.cashLedgerAccountId,
          externalReference: "SYN-SAFE-USD",
          status: "ACTIVE",
          expectedVersion: 0
        });
        assert.equal(treasury.treasuryAccounts.length, 1);
        assert.equal(treasury.treasuryAccounts[0]?.accountType, "SAFE");
        assert.equal(treasury.treasuryAccounts[0]?.version, 1);
        const treasuryId = treasury.treasuryAccounts[0]?.id as string;

        const category = await categoryUpsert(executor, session, {
          categoryCode: "SYN-OFFICE",
          nameEn: "Synthetic Office Expense",
          nameFa: "مصرف دفتر آزمایشی",
          ledgerAccountId: expenseLedgerId,
          status: "ACTIVE",
          expectedVersion: 0
        });
        assert.equal(category.expenseCategories.length, 1);
        assert.equal(category.expenseCategories[0]?.ledgerAccountId, expenseLedgerId);
        const categoryId = category.expenseCategories[0]?.id as string;

        // Category labels may be more granular than the Chart of Accounts. Reusing the same
        // expense account is allowed; the immutable category-to-account mapping remains explicit.
        const secondCategory = await categoryUpsert(executor, session, {
          categoryCode: "SYN-STATIONERY",
          nameEn: "Synthetic Stationery Expense",
          nameFa: null,
          ledgerAccountId: expenseLedgerId,
          status: "ACTIVE",
          expectedVersion: 0
        });
        assert.equal(secondCategory.expenseCategories.length, 2);

        const renamed = await treasuryUpsert(executor, session, {
          id: treasuryId,
          nameEn: "Synthetic Main Cash Safe",
          nameFa: "صندوق اصلی نقدی آزمایشی",
          accountType: "SAFE",
          currencyCode: "USD",
          ledgerAccountId: world.cashLedgerAccountId,
          externalReference: "SYN-SAFE-USD",
          status: "ACTIVE",
          expectedVersion: 1
        });
        assert.equal(renamed.treasuryAccounts[0]?.version, 2);
        assert.equal(renamed.treasuryAccounts[0]?.nameEn, "Synthetic Main Cash Safe");

        const treasuryAuditBefore = Number((await harness.executor.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM abos.audit_records WHERE entity_id = $1", [treasuryId]
        )).rows[0]?.count ?? "0");
        await assert.rejects(
          () => treasuryUpsert(executor, session, {
            id: treasuryId,
            nameEn: "Must not change",
            nameFa: null,
            accountType: "SAFE",
            currencyCode: "USD",
            ledgerAccountId: expenseLedgerId,
            externalReference: null,
            status: "ACTIVE",
            expectedVersion: 2
          }),
          /cannot change its type, currency, ledger mapping or Saraf/i
        );
        const treasuryAfterRefusal = (await workspace(executor, session)).treasuryAccounts
          .find((item) => item.id === treasuryId);
        assert.equal(treasuryAfterRefusal?.version, 2);
        assert.equal(Number((await harness.executor.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM abos.audit_records WHERE entity_id = $1", [treasuryId]
        )).rows[0]?.count ?? "0"), treasuryAuditBefore);

        const categoryAuditBefore = Number((await harness.executor.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM abos.audit_records WHERE entity_id = $1", [categoryId]
        )).rows[0]?.count ?? "0");
        await assert.rejects(
          () => categoryUpsert(executor, session, {
            id: categoryId,
            categoryCode: "SYN-CHANGED",
            nameEn: "Must not change",
            nameFa: null,
            ledgerAccountId: world.cashLedgerAccountId,
            status: "ACTIVE",
            expectedVersion: 1
          }),
          /cannot change its code or ledger mapping/i
        );
        assert.equal((await workspace(executor, session)).expenseCategories
          .find((item) => item.id === categoryId)?.ledgerAccountId, expenseLedgerId);
        assert.equal(Number((await harness.executor.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM abos.audit_records WHERE entity_id = $1", [categoryId]
        )).rows[0]?.count ?? "0"), categoryAuditBefore);
        await assert.rejects(
          () => treasuryUpsert(executor, session, {
            id: treasuryId,
            nameEn: "Stale",
            nameFa: null,
            accountType: "SAFE",
            currencyCode: "USD",
            ledgerAccountId: world.cashLedgerAccountId,
            externalReference: null,
            status: "ACTIVE",
            expectedVersion: 1
          }),
          (error: unknown) => databaseError(error, "40001", /changed; reload/i)
        );

        await assert.rejects(
          () => treasuryUpsert(executor, session, {
            nameEn: "Invalid Expense Treasury Mapping",
            nameFa: null,
            accountType: "BANK",
            currencyCode: "USD",
            ledgerAccountId: expenseLedgerId,
            sarafBusinessPartyId: null,
            externalReference: null,
            status: "ACTIVE",
            expectedVersion: 0
          }),
          /CASH asset account|Treasury ledger account/i
        );
        await assert.rejects(
          () => categoryUpsert(executor, session, {
            categoryCode: "SYN-BAD",
            nameEn: "Invalid Cash Expense Category",
            nameFa: null,
            ledgerAccountId: world.cashLedgerAccountId,
            status: "ACTIVE",
            expectedVersion: 0
          }),
          /ACTIVE posting EXPENSE account/i
        );

        const opened = await openPeriod(
          executor, session, pendingPeriodId, 1, "Owner authorized this synthetic test period opening."
        );
        const period = opened.periods.find((item) => item.id === pendingPeriodId);
        assert.equal(period?.status, "OPEN");
        assert.equal(period?.version, 2);
        assert.equal(period?.openedBy, "Synthetic Operational Config Manager");
        await assert.rejects(
          () => openPeriod(executor, session, pendingPeriodId, 2, "A second opening is forbidden."),
          (error: unknown) => databaseError(error, "23514", /only a PENDING/i)
        );

        const audits = await harness.executor.query<{ action: string; actor: string }>(
          `SELECT action, actor_user_account_id AS actor
             FROM abos.audit_records
            WHERE entity_id = ANY($1::uuid[])
            ORDER BY occurred_at`,
          [[treasuryId, categoryId, pendingPeriodId]]
        );
        assert.deepEqual(audits.rows.map((row) => row.action), [
          "OPERATIONAL_TREASURY_ACCOUNT_CREATED",
          "OPERATIONAL_EXPENSE_CATEGORY_CREATED",
          "OPERATIONAL_TREASURY_ACCOUNT_UPDATED",
          "ACCOUNTING_PERIOD_OPENED"
        ]);
        assert.ok(audits.rows.every((row) => row.actor === user.user.id));

        await assert.rejects(
          () => harness.executor.query(
            `UPDATE abos.operational_treasury_accounts
                SET ledger_account_id = $1, version = version + 1,
                    last_changed_at = clock_timestamp()
              WHERE id = $2`,
            [expenseLedgerId, treasuryId]
          ),
          /cannot change its type, currency, ledger mapping/i
        );
        await assert.rejects(
          () => harness.executor.query(
            "DELETE FROM abos.operational_expense_categories WHERE id = $1", [categoryId]
          ),
          /deactivated, never deleted/i
        );

        // A second company cannot be addressed by supplying its record identifiers. Entity scope
        // is derived from the live session and is checked before any mutation.
        const other = await seedSyntheticWorld(harness.executor, { withoutSandboxAuthorization: true });
        const otherPendingPeriod = randomUUID();
        await harness.executor.query(
          `INSERT INTO abos.accounting_periods
             (id, legal_entity_id, period_name, starts_on, ends_on, status)
           VALUES ($1, $2, 'Other Synthetic October', '2026-10-01', '2026-10-31', 'PENDING')`,
          [otherPendingPeriod, other.legalEntityId]
        );
        await assert.rejects(
          () => openPeriod(executor, session, otherPendingPeriod, 1, "Cross-company opening must fail."),
          /does not exist in this legal entity/i
        );
        await assert.rejects(
          () => treasuryUpsert(executor, session, {
            nameEn: "Cross-company mapping",
            nameFa: null,
            accountType: "SAFE",
            currencyCode: "USD",
            ledgerAccountId: other.cashLedgerAccountId,
            externalReference: null,
            status: "ACTIVE",
            expectedVersion: 0
          }),
          /Treasury ledger account must belong to this legal entity/i
        );
        assert.equal((await workspace(executor, session)).legalEntity.id, world.legalEntityId);
      } finally {
        await financeConnection.close();
        await identityConnection.close();
      }
    });

    test("the operational owner and runtime retain the reviewed least-privilege boundary", async () => {
      await resetSchema(harness.pool);
      const world = await seedSyntheticWorld(harness.executor);
      await ensureLogin(harness);
      const identityConnection = await restrictedIdentity();
      const financeConnection = await restrictedFinance();
      const { identity } = identityConnection;
      const { executor } = financeConnection;
      try {
        const bootstrap = await bootstrapSuperAdmin(harness.executor, {
          legalEntityId: world.legalEntityId,
          systemUserAccountId: world.bootstrapUserId,
          loginIdentifier: "operational.attack.admin",
          displayName: "Synthetic Attack Test Admin"
        });
        const adminToken = (await identity.changePassword({
          loginIdentifier: "operational.attack.admin",
          currentPassword: bootstrap.temporaryPassword,
          newPassword: "Operational attack administrator 2026",
          clientAddress: CLIENT
        })).token;
        const noConfigRole = await identity.createRole(adminToken, {
          name: "Operational Report Reader",
          description: "Has no configuration permissions.",
          permissions: ["finance.report.operational.read"]
        });
        const reader = await identity.createUser(adminToken, {
          loginIdentifier: "operational.attack.reader",
          displayName: "Synthetic Unprivileged Reader",
          status: "ACTIVE",
          roleIds: [noConfigRole.id]
        });
        const readerToken = (await identity.changePassword({
          loginIdentifier: "operational.attack.reader",
          currentPassword: reader.temporaryPassword,
          newPassword: "Operational unprivileged reader 2026",
          clientAddress: CLIENT
        })).token;
        const readerSession = sessionArgs(readerToken);

        await assert.rejects(() => workspace(executor, readerSession), /no operational Finance configuration permission/i);
        await assert.rejects(
          () => workspace(executor, { ...readerSession, proof: "f".repeat(64) }),
          /identity runtime proof is invalid/i
        );
        await identity.logout(readerToken);
        await assert.rejects(() => workspace(executor, readerSession), /sign in with an active account/i);

        await assert.rejects(
          () => executor.query("SELECT * FROM abos.operational_treasury_accounts"),
          /permission denied/i
        );
        await assert.rejects(
          () => executor.query("INSERT INTO abos.operational_expense_categories (id) VALUES (gen_random_uuid())"),
          /permission denied/i
        );
        await assert.rejects(
          () => executor.query("SET ROLE abos_v1_operational_finance_owner"),
          /permission denied to set role/i
        );
        await assert.rejects(
          () => executor.query(
            "SELECT abos.operational_finance_actor('x','x','x',NULL)"
          ),
          /permission denied for function operational_finance_actor/i
        );
      } finally {
        await financeConnection.close();
        await identityConnection.close();
      }

      const role = (await harness.executor.query<{
        rolcanlogin: boolean;
        rolsuper: boolean;
        rolcreatedb: boolean;
        rolcreaterole: boolean;
        rolreplication: boolean;
        rolbypassrls: boolean;
        rolinherit: boolean;
      }>(
        `SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole,
                rolreplication, rolbypassrls, rolinherit
           FROM pg_catalog.pg_roles
          WHERE rolname = 'abos_v1_operational_finance_owner'`
      )).rows[0];
      assert.deepEqual(role, {
        rolcanlogin: false,
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolreplication: false,
        rolbypassrls: false,
        rolinherit: false
      });

      const memberships = await harness.executor.query<{ member_name: string; role_name: string }>(
        `SELECT member.rolname AS member_name, granted.rolname AS role_name
           FROM pg_catalog.pg_auth_members membership
           JOIN pg_catalog.pg_roles member ON member.oid = membership.member
           JOIN pg_catalog.pg_roles granted ON granted.oid = membership.roleid
          WHERE member.rolname = 'abos_v1_operational_finance_owner'
             OR granted.rolname = 'abos_v1_operational_finance_owner'`
      );
      assert.deepEqual(memberships.rows, []);

      const ownedTables = await harness.executor.query<{ table_name: string }>(
        `SELECT class.relname AS table_name
           FROM pg_catalog.pg_class class
           JOIN pg_catalog.pg_roles owner ON owner.oid = class.relowner
           JOIN pg_catalog.pg_namespace namespace ON namespace.oid = class.relnamespace
          WHERE namespace.nspname = 'abos' AND class.relkind IN ('r', 'p')
            AND owner.rolname = 'abos_v1_operational_finance_owner'`
      );
      assert.deepEqual(ownedTables.rows, []);

      const publicExecute = await harness.executor.query<{ signature: string }>(
        `SELECT function.oid::regprocedure::text AS signature
           FROM pg_catalog.pg_proc function
           CROSS JOIN LATERAL pg_catalog.aclexplode(
             COALESCE(function.proacl, pg_catalog.acldefault('f', function.proowner))) privilege
          WHERE function.pronamespace = 'abos'::regnamespace
            AND function.proname = ANY(ARRAY[
              'operational_finance_actor',
              'operational_finance_configuration_workspace',
              'operational_treasury_account_upsert',
              'operational_expense_category_upsert',
              'finance_open_accounting_period',
              'guard_operational_treasury_account',
              'guard_operational_expense_category'])
            AND privilege.grantee = 0 AND privilege.privilege_type = 'EXECUTE'`
      );
      assert.deepEqual(publicExecute.rows, []);

      for (const roleName of ["abos_v1_identity_runtime", "abos_e1_treasury_runtime"] as const) {
        await roleStatementRejected(
          harness,
          roleName,
          "SELECT abos.operational_finance_configuration_workspace('x','x','x')",
          /permission denied for function operational_finance_configuration_workspace/i
        );
      }

      for (const [sql, message] of [
        ["SELECT * FROM abos.user_credentials", /permission denied for table user_credentials/i],
        // Migration 0028 (reviewed design, section I) lets the owner READ the ledger tables, because
        // it writes operational journals and its posting validator runs with the owner's rights.
        // It still cannot change ungranted columns or delete anything there.
        ["UPDATE abos.journals SET journal_reference = journal_reference", /permission denied for table journals/i],
        ["DELETE FROM abos.journals", /permission denied for table journals/i],
        ["UPDATE abos.posting_intents SET intent_kind = intent_kind", /permission denied for table posting_intents/i],
        ["DELETE FROM abos.posting_intents", /permission denied for table posting_intents/i]
      ] as const) {
        await ownerStatementRejected(harness, sql, message);
      }
    });
  });
}

async function ensureLogin(harness: Harness): Promise<void> {
  await harness.executor.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${IDENTITY_LOGIN.name}') THEN
      CREATE ROLE ${IDENTITY_LOGIN.name} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
    END IF; END $$`);
  await harness.executor.query(
    `ALTER ROLE ${IDENTITY_LOGIN.name} LOGIN PASSWORD '${IDENTITY_LOGIN.password}'`
  );
  await harness.executor.query(`GRANT abos_v1_identity_runtime TO ${IDENTITY_LOGIN.name}`);
  await harness.executor.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${FINANCE_LOGIN.name}') THEN
      CREATE ROLE ${FINANCE_LOGIN.name} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
    END IF; END $$`);
  await harness.executor.query(
    `ALTER ROLE ${FINANCE_LOGIN.name} LOGIN PASSWORD '${FINANCE_LOGIN.password}'`
  );
  await harness.executor.query(`GRANT abos_e1_runtime TO ${FINANCE_LOGIN.name}`);
}

async function restrictedIdentity(): Promise<{
  readonly identity: IdentityService;
  readonly executor: PostgresExecutor;
  close(): Promise<void>;
}> {
  const url = new URL(databaseUrl() ?? "");
  url.username = IDENTITY_LOGIN.name;
  url.password = IDENTITY_LOGIN.password;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
  const executor = new PostgresExecutor(pool, { runtimeMarker: MARKER });
  return {
    executor,
    identity: new IdentityService(
      executor,
      new SandboxAuthenticator(executor, SYNTHETIC_AUTH_CONFIGURATION),
      { attemptKeySecret: "synthetic-operational-config-attempt-key-secret" }
    ),
    close: () => pool.end()
  };
}

async function restrictedFinance(): Promise<{
  readonly executor: PostgresExecutor;
  close(): Promise<void>;
}> {
  const url = new URL(databaseUrl() ?? "");
  url.username = FINANCE_LOGIN.name;
  url.password = FINANCE_LOGIN.password;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
  return {
    executor: new PostgresExecutor(pool, { runtimeMarker: MARKER }),
    close: () => pool.end()
  };
}

function sessionArgs(token: string): SessionArgs {
  return {
    proof: identityDatabaseProof(SYNTHETIC_AUTH_CONFIGURATION.signingSecret),
    runtimeDigest: createHash("sha256").update(token).digest("hex"),
    tokenDigest: createHmac("sha256", SYNTHETIC_AUTH_CONFIGURATION.signingSecret)
      .update(token).digest("hex")
  };
}

async function workspace(
  executor: PostgresExecutor, session: SessionArgs
): Promise<ConfigurationWorkspace> {
  const result = await executor.query<{ value: ConfigurationWorkspace }>(
    "SELECT abos.operational_finance_configuration_workspace($1,$2,$3) AS value",
    [session.proof, session.runtimeDigest, session.tokenDigest]
  );
  assert.ok(result.rows[0]);
  return result.rows[0].value;
}

async function treasuryUpsert(
  executor: PostgresExecutor, session: SessionArgs, payload: Record<string, unknown>
): Promise<ConfigurationWorkspace> {
  const result = await executor.query<{ value: ConfigurationWorkspace }>(
    "SELECT abos.operational_treasury_account_upsert($1,$2,$3,$4::jsonb) AS value",
    [session.proof, session.runtimeDigest, session.tokenDigest, JSON.stringify(payload)]
  );
  assert.ok(result.rows[0]);
  return result.rows[0].value;
}

async function categoryUpsert(
  executor: PostgresExecutor, session: SessionArgs, payload: Record<string, unknown>
): Promise<ConfigurationWorkspace> {
  const result = await executor.query<{ value: ConfigurationWorkspace }>(
    "SELECT abos.operational_expense_category_upsert($1,$2,$3,$4::jsonb) AS value",
    [session.proof, session.runtimeDigest, session.tokenDigest, JSON.stringify(payload)]
  );
  assert.ok(result.rows[0]);
  return result.rows[0].value;
}

async function openPeriod(
  executor: PostgresExecutor,
  session: SessionArgs,
  periodId: string,
  expectedVersion: number,
  reason: string
): Promise<ConfigurationWorkspace> {
  const result = await executor.query<{ value: ConfigurationWorkspace }>(
    "SELECT abos.finance_open_accounting_period($1,$2,$3,$4,$5,$6) AS value",
    [session.proof, session.runtimeDigest, session.tokenDigest, periodId, expectedVersion, reason]
  );
  assert.ok(result.rows[0]);
  return result.rows[0].value;
}

function databaseError(error: unknown, code: string, message: RegExp): boolean {
  const candidate = error as { code?: string; message?: string };
  assert.equal(candidate.code, code, candidate.message);
  assert.match(candidate.message ?? "", message);
  return true;
}

/** Each expected PostgreSQL error gets its own transaction because an error aborts that transaction. */
async function ownerStatementRejected(harness: Harness, sql: string, message: RegExp): Promise<void> {
  return roleStatementRejected(harness, "abos_v1_operational_finance_owner", sql, message);
}

async function roleStatementRejected(
  harness: Harness,
  role: string,
  sql: string,
  message: RegExp
): Promise<void> {
  const client = await harness.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL ROLE ${role}`);
    await assert.rejects(() => client.query(sql), message);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}
