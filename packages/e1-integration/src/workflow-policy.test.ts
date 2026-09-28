import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import pg from "pg";

import { bootstrapSuperAdmin, IdentityError, IdentityService, type IdentityErrorCode } from "@abos/identity";
import { PostgresExecutor } from "@abos/persistence";
import { SandboxAuthenticator } from "@abos/sandbox-auth";

import { databaseUrl, MISSING_DATABASE_MESSAGE, openHarness, resetSchema, type Harness } from "./harness.ts";
import { seedSyntheticWorld, SYNTHETIC_AUTH_CONFIGURATION } from "./synthetic-world.ts";

/** Migration 0025: append-only per-entity workflow policy through a restricted identity login. */

const MARKER = SYNTHETIC_AUTH_CONFIGURATION.runtimeMarker;
const LOGIN = { name: "abos_v1_identity_runtime_test_login", password: "synthetic-identity-runtime-only-2026" };
const CLIENT = "203.0.113.25";

if (databaseUrl() === undefined) {
  test("V1 finance workflow policy", () => assert.fail(MISSING_DATABASE_MESSAGE));
} else {
  describe("V1 finance workflow policy (migration 0025)", () => {
    let harness: Harness;
    before(async () => { harness = await openHarness(MARKER); });
    after(async () => { await harness.close(); });

    test("policy is explicit, versioned and administered without granting Finance authority", async () => {
      await resetSchema(harness.pool);
      const world = await seedSyntheticWorld(harness.executor);
      await ensureLogin(harness);
      const bootstrap = await bootstrapSuperAdmin(harness.executor, {
        legalEntityId: world.legalEntityId,
        systemUserAccountId: world.bootstrapUserId,
        loginIdentifier: "policy.admin",
        displayName: "Synthetic Policy Super Admin"
      });
      const { identity, executor, close } = await restrictedIdentity();
      try {
        const admin = (await identity.changePassword({
          loginIdentifier: "policy.admin", currentPassword: bootstrap.temporaryPassword,
          newPassword: "Policy administrator passphrase 2026", clientAddress: CLIENT
        })).token;

        const initial = await identity.financeWorkflowPolicies(admin);
        assert.equal(initial.canManage, false, "Super Administrator does not receive policy authority implicitly");
        assert.equal(initial.policies.length, 7);
        assert.ok(initial.policies.every((policy) => !policy.configured && policy.approvalRequired === null));

        const policyRole = await identity.createRole(admin, {
          name: "Finance Workflow Administrator",
          description: "Configures whether a workflow requires independent approval.",
          permissions: ["admin.finance-workflow.manage"]
        });
        const readerRole = await identity.createRole(admin, {
          name: "Policy Reader", description: "No configuration authority.", permissions: ["treasury.read"]
        });
        const editor = await identity.createUser(admin, {
          loginIdentifier: "policy.editor", displayName: "Synthetic Policy Editor",
          status: "ACTIVE", roleIds: [policyRole.id]
        });
        const reader = await identity.createUser(admin, {
          loginIdentifier: "policy.reader", displayName: "Synthetic Policy Reader",
          status: "ACTIVE", roleIds: [readerRole.id]
        });
        const editorToken = (await identity.changePassword({
          loginIdentifier: "policy.editor", currentPassword: editor.temporaryPassword,
          newPassword: "Policy editor passphrase 2026", clientAddress: CLIENT
        })).token;
        const readerToken = (await identity.changePassword({
          loginIdentifier: "policy.reader", currentPassword: reader.temporaryPassword,
          newPassword: "Policy reader passphrase 2026", clientAddress: CLIENT
        })).token;

        const editorSession = await identity.currentUser(editorToken);
        assert.deepEqual(editorSession.permissions, ["admin.finance-workflow.manage"]);
        assert.equal(editorSession.permissions.some((permission) => permission.startsWith("finance.")), false);

        const off = await identity.setFinanceWorkflowPolicy(editorToken, {
          workflowType: "EXPENSE", approvalRequired: false, expectedVersion: 0,
          changeReason: "Owner approved direct posting for normal Al-Beruniy expenses."
        });
        const expenseV1 = off.policies.find((policy) => policy.workflowType === "EXPENSE");
        assert.equal(expenseV1?.configured, true);
        assert.equal(expenseV1?.approvalRequired, false);
        assert.equal(expenseV1?.version, 1);
        assert.equal(expenseV1?.history.length, 1);

        const on = await identity.setFinanceWorkflowPolicy(editorToken, {
          workflowType: "EXPENSE", approvalRequired: true, expectedVersion: 1,
          changeReason: "Temporary independent approval requested by the owner."
        });
        const expenseV2 = on.policies.find((policy) => policy.workflowType === "EXPENSE");
        assert.equal(expenseV2?.approvalRequired, true);
        assert.equal(expenseV2?.version, 2);
        assert.deepEqual(expenseV2?.history.map((item) => item.approvalRequired), [true, false]);
        await rejects("STALE_VERSION", () => identity.setFinanceWorkflowPolicy(editorToken, {
          workflowType: "EXPENSE", approvalRequired: false, expectedVersion: 1,
          changeReason: "This update started from an obsolete version."
        }));
        await rejects("VALIDATION_FAILED", () => identity.setFinanceWorkflowPolicy(editorToken, {
          workflowType: "UNKNOWN", approvalRequired: false, expectedVersion: 0, changeReason: "Invalid workflow."
        }));
        await rejects("PERMISSION_DENIED", () => identity.setFinanceWorkflowPolicy(readerToken, {
          workflowType: "OTHER_INCOME", approvalRequired: false, expectedVersion: 0,
          changeReason: "Reader must not configure company policy."
        }));
        assert.equal((await identity.financeWorkflowPolicies(readerToken)).canManage, false);

        const stored = await harness.executor.query<{ version: number; approval_required: boolean }>(
          `SELECT version, approval_required FROM abos.finance_workflow_policy_versions
            WHERE legal_entity_id = $1 AND workflow_type = 'EXPENSE' ORDER BY version`,
          [world.legalEntityId]
        );
        assert.deepEqual(stored.rows, [
          { version: 1, approval_required: false },
          { version: 2, approval_required: true }
        ]);
        await assert.rejects(
          () => harness.executor.query("UPDATE abos.finance_workflow_policy_versions SET approval_required = false"),
          /append-only|cannot be changed/i
        );
        await assert.rejects(
          () => executor.query("SELECT * FROM abos.finance_workflow_policy_versions"),
          /permission denied/i
        );
        await assert.rejects(
          () => executor.query("INSERT INTO abos.finance_workflow_policy_versions (id) VALUES (gen_random_uuid())"),
          /permission denied/i
        );

        // A policy is resolved from the live identity session's legal entity. A second legal
        // entity can choose the opposite setting without seeing or changing the first entity.
        const otherWorld = await seedSyntheticWorld(harness.executor, { withoutSandboxAuthorization: true });
        await harness.executor.query(
          `INSERT INTO abos.sandbox_legal_entity_scopes
             (legal_entity_id, base_currency_code, authorized_by_user_account_id)
           VALUES ($1, 'USD', $2)`,
          [otherWorld.legalEntityId, otherWorld.bootstrapUserId]
        );
        const otherBootstrap = await bootstrapSuperAdmin(harness.executor, {
          legalEntityId: otherWorld.legalEntityId,
          systemUserAccountId: otherWorld.bootstrapUserId,
          loginIdentifier: "policy.other.admin",
          displayName: "Other Entity Policy Super Admin"
        });
        const otherAdminToken = (await identity.changePassword({
          loginIdentifier: "policy.other.admin",
          currentPassword: otherBootstrap.temporaryPassword,
          newPassword: "Other policy administrator passphrase 2026",
          clientAddress: CLIENT
        })).token;
        const otherPolicyRole = await identity.createRole(otherAdminToken, {
          name: "Finance Workflow Administrator",
          description: "Configures approval policy only within this legal entity.",
          permissions: ["admin.finance-workflow.manage"]
        });
        const otherEditor = await identity.createUser(otherAdminToken, {
          loginIdentifier: "policy.other.editor",
          displayName: "Other Entity Policy Editor",
          status: "ACTIVE",
          roleIds: [otherPolicyRole.id]
        });
        const otherEditorToken = (await identity.changePassword({
          loginIdentifier: "policy.other.editor",
          currentPassword: otherEditor.temporaryPassword,
          newPassword: "Other policy editor passphrase 2026",
          clientAddress: CLIENT
        })).token;
        const otherOff = await identity.setFinanceWorkflowPolicy(otherEditorToken, {
          workflowType: "EXPENSE",
          approvalRequired: false,
          expectedVersion: 0,
          changeReason: "The other legal entity independently selected direct expense posting."
        });
        assert.equal(otherOff.legalEntityId, otherWorld.legalEntityId);
        assert.equal(otherOff.policies.find((policy) => policy.workflowType === "EXPENSE")?.approvalRequired, false);

        const originalEntity = await identity.financeWorkflowPolicies(editorToken);
        assert.equal(originalEntity.legalEntityId, world.legalEntityId);
        assert.equal(originalEntity.policies.find((policy) => policy.workflowType === "EXPENSE")?.approvalRequired, true);
        assert.equal(
          originalEntity.policies.find((policy) => policy.workflowType === "EXPENSE")?.history.length,
          2,
          "the other entity's version is not visible in the first entity"
        );
        const entityPolicies = await harness.executor.query<{
          legal_entity_id: string;
          approval_required: boolean;
          versions: string;
        }>(
          `SELECT legal_entity_id, (array_agg(approval_required ORDER BY version DESC))[1] AS approval_required,
                  count(*)::text AS versions
             FROM abos.finance_workflow_policy_versions
            WHERE workflow_type = 'EXPENSE'
            GROUP BY legal_entity_id
            ORDER BY legal_entity_id`
        );
        assert.deepEqual(
          entityPolicies.rows.map((row) => ({
            legalEntityId: row.legal_entity_id,
            approvalRequired: row.approval_required,
            versions: row.versions
          })).sort((left, right) => left.legalEntityId.localeCompare(right.legalEntityId)),
          [
            { legalEntityId: world.legalEntityId, approvalRequired: true, versions: "2" },
            { legalEntityId: otherWorld.legalEntityId, approvalRequired: false, versions: "1" }
          ].sort((left, right) => left.legalEntityId.localeCompare(right.legalEntityId))
        );
      } finally {
        await close();
      }
    });

    test("policy owner and entry points retain the exact least-privilege boundary", async () => {
      await resetSchema(harness.pool);
      await ensureLogin(harness);

      const role = (await harness.executor.query<{
        rolcanlogin: boolean;
        rolsuper: boolean;
        rolcreatedb: boolean;
        rolcreaterole: boolean;
        rolreplication: boolean;
        rolbypassrls: boolean;
        rolinherit: boolean;
      }>(
        `SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication,
                rolbypassrls, rolinherit
           FROM pg_catalog.pg_roles
          WHERE rolname = 'abos_v1_workflow_policy_owner'`
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
          WHERE member.rolname = 'abos_v1_workflow_policy_owner'
             OR granted.rolname = 'abos_v1_workflow_policy_owner'`
      );
      assert.deepEqual(memberships.rows, [], "the owner inherits nothing and no runtime can SET ROLE to it");

      const ownedTables = await harness.executor.query<{ table_name: string }>(
        `SELECT class.relname AS table_name
           FROM pg_catalog.pg_class class
           JOIN pg_catalog.pg_roles owner ON owner.oid = class.relowner
           JOIN pg_catalog.pg_namespace namespace ON namespace.oid = class.relnamespace
          WHERE namespace.nspname = 'abos'
            AND class.relkind IN ('r', 'p')
            AND owner.rolname = 'abos_v1_workflow_policy_owner'`
      );
      assert.deepEqual(ownedTables.rows, [], "the function owner owns no protected table");

      const tableGrants = await harness.executor.query<{ table_name: string; privilege_type: string }>(
        `SELECT table_name, privilege_type
           FROM information_schema.role_table_grants
          WHERE grantee = 'abos_v1_workflow_policy_owner'
          ORDER BY table_name, privilege_type`
      );
      assert.deepEqual(tableGrants.rows, [
        { table_name: "finance_workflow_policy_versions", privilege_type: "SELECT" },
        { table_name: "finance_workflow_types", privilege_type: "SELECT" }
      ]);

      const selectColumns = await harness.executor.query<{ table_name: string; column_name: string }>(
        `SELECT table_name, column_name
           FROM information_schema.column_privileges
          WHERE grantee = 'abos_v1_workflow_policy_owner'
            AND privilege_type = 'SELECT'
            AND table_name = 'user_accounts'
          ORDER BY table_name, column_name`
      );
      assert.deepEqual(selectColumns.rows, [
        { table_name: "user_accounts", column_name: "display_name" },
        { table_name: "user_accounts", column_name: "id" }
      ]);

      const insertColumns = await harness.executor.query<{ table_name: string; column_name: string }>(
        `SELECT table_name, column_name
           FROM information_schema.column_privileges
          WHERE grantee = 'abos_v1_workflow_policy_owner'
            AND privilege_type = 'INSERT'
          ORDER BY table_name, column_name`
      );
      assert.deepEqual(insertColumns.rows, [
        { table_name: "audit_records", column_name: "action" },
        { table_name: "audit_records", column_name: "actor_user_account_id" },
        { table_name: "audit_records", column_name: "after_state" },
        { table_name: "audit_records", column_name: "before_state" },
        { table_name: "audit_records", column_name: "correlation_id" },
        { table_name: "audit_records", column_name: "entity_id" },
        { table_name: "audit_records", column_name: "entity_type" },
        { table_name: "audit_records", column_name: "id" },
        { table_name: "audit_records", column_name: "legal_entity_id" },
        { table_name: "audit_records", column_name: "metadata" },
        { table_name: "finance_workflow_policy_versions", column_name: "approval_required" },
        { table_name: "finance_workflow_policy_versions", column_name: "change_reason" },
        { table_name: "finance_workflow_policy_versions", column_name: "configured_by_user_account_id" },
        { table_name: "finance_workflow_policy_versions", column_name: "id" },
        { table_name: "finance_workflow_policy_versions", column_name: "legal_entity_id" },
        { table_name: "finance_workflow_policy_versions", column_name: "version" },
        { table_name: "finance_workflow_policy_versions", column_name: "workflow_type" }
      ]);

      const forbiddenGrants = await harness.executor.query<{ privilege_type: string }>(
        `SELECT privilege_type
           FROM information_schema.column_privileges
          WHERE grantee = 'abos_v1_workflow_policy_owner'
            AND privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')
         UNION ALL
         SELECT privilege_type
           FROM information_schema.role_table_grants
          WHERE grantee = 'abos_v1_workflow_policy_owner'
            AND privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')`
      );
      assert.deepEqual(forbiddenGrants.rows, []);

      const publicExecute = await harness.executor.query<{ signature: string }>(
        `SELECT function.oid::regprocedure::text AS signature
           FROM pg_catalog.pg_proc function
           CROSS JOIN LATERAL pg_catalog.aclexplode(
             COALESCE(function.proacl, pg_catalog.acldefault('f', function.proowner))) privilege
          WHERE function.pronamespace = 'abos'::regnamespace
            AND function.proname = ANY(ARRAY[
              'finance_workflow_policy_actor',
              'finance_workflow_policy_workspace',
              'finance_workflow_policy_set'
            ])
            AND privilege.grantee = 0
            AND privilege.privilege_type = 'EXECUTE'`
      );
      assert.deepEqual(publicExecute.rows, [], "PUBLIC cannot execute an internal helper or entry point");

      const identityExecution = (await harness.executor.query<{
        actor: boolean;
        workspace: boolean;
        policy_set: boolean;
        can_assume_owner: boolean;
      }>(
        `SELECT
           pg_catalog.has_function_privilege(
             'abos_v1_identity_runtime',
             'abos.finance_workflow_policy_actor(text,text,text,text)', 'EXECUTE') AS actor,
           pg_catalog.has_function_privilege(
             'abos_v1_identity_runtime',
             'abos.finance_workflow_policy_workspace(text,text,text)', 'EXECUTE') AS workspace,
           pg_catalog.has_function_privilege(
             'abos_v1_identity_runtime',
             'abos.finance_workflow_policy_set(text,text,text,text,boolean,integer,text)', 'EXECUTE') AS policy_set,
           pg_catalog.pg_has_role(
             'abos_v1_identity_runtime', 'abos_v1_workflow_policy_owner', 'MEMBER') AS can_assume_owner`
      )).rows[0];
      assert.deepEqual(identityExecution, {
        actor: false,
        workspace: true,
        policy_set: true,
        can_assume_owner: false
      });

      const { executor, close } = await restrictedIdentity();
      try {
        await assert.rejects(
          () => executor.query("SET ROLE abos_v1_workflow_policy_owner"),
          /permission denied to set role/i
        );
        await assert.rejects(
          () => executor.query(
            "SELECT abos.finance_workflow_policy_actor('x', 'x', 'x', NULL)"
          ),
          /permission denied for function finance_workflow_policy_actor/i
        );
      } finally {
        await close();
      }

      const client = await harness.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE abos_v1_workflow_policy_owner");
        await assert.rejects(
          () => client.query("SELECT * FROM abos.user_credentials"),
          /permission denied for table user_credentials/i
        );
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });
  });
}

async function ensureLogin(harness: Harness): Promise<void> {
  await harness.executor.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${LOGIN.name}') THEN
    CREATE ROLE ${LOGIN.name} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION; END IF; END $$`);
  await harness.executor.query(`ALTER ROLE ${LOGIN.name} LOGIN PASSWORD '${LOGIN.password}'`);
  await harness.executor.query(`GRANT abos_v1_identity_runtime TO ${LOGIN.name}`);
}

async function restrictedIdentity(): Promise<{
  readonly identity: IdentityService;
  readonly executor: PostgresExecutor;
  close(): Promise<void>;
}> {
  const url = new URL(databaseUrl() ?? "");
  url.username = LOGIN.name;
  url.password = LOGIN.password;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
  const executor = new PostgresExecutor(pool, { runtimeMarker: MARKER });
  return {
    executor,
    identity: new IdentityService(
      executor,
      new SandboxAuthenticator(executor, SYNTHETIC_AUTH_CONFIGURATION),
      { attemptKeySecret: "synthetic-login-attempt-key-secret-for-tests-only" }
    ),
    close: () => pool.end()
  };
}

async function rejects(code: IdentityErrorCode, run: () => Promise<unknown>): Promise<void> {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof IdentityError, String(error));
    assert.equal(error.code, code, error.message);
    return true;
  });
}
