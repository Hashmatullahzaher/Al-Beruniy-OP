import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import test, { after, before, describe } from "node:test";
import pg from "pg";

import type { LegalEntityId, UserAccountId } from "@abos/contracts";
import { PostgresExecutor } from "@abos/persistence";
import { identityDatabaseProof, SandboxAuthenticator } from "@abos/sandbox-auth";

import { databaseUrl, MISSING_DATABASE_MESSAGE, openHarness, resetSchema, type Harness } from "./harness.ts";
import { seedSyntheticWorld, SYNTHETIC_AUTH_CONFIGURATION, type SyntheticWorld } from "./synthetic-world.ts";

/** Migration 0030: the company dashboard permission and its aggregate-only read model. */

const MARKER = SYNTHETIC_AUTH_CONFIGURATION.runtimeMarker;
const LOGIN = { name: "abos_v1_company_dashboard_test_login", password: "synthetic-company-dashboard-runtime-only-2026" };
const OWNER = "abos_v1_company_dashboard_owner";

interface SessionArgs { readonly proof: string; readonly runtimeDigest: string; readonly tokenDigest: string }
interface Summary { readonly legalEntityName: string | null; readonly projects: { readonly active: number; readonly total: number } }

if (databaseUrl() === undefined) {
  test("V1 company dashboard", () => assert.fail(MISSING_DATABASE_MESSAGE));
} else {
  describe("V1 company dashboard (migration 0030)", () => {
    let harness: Harness;
    before(async () => { harness = await openHarness(MARKER); });
    after(async () => { await harness.close(); });

    test("the permission is explicit: catalogued under Company, held by nobody until a role grants it", async () => {
      await resetSchema(harness.pool);
      await seedSyntheticWorld(harness.executor);
      const row = (await harness.executor.query<{ category: string; availability: string; administrative: boolean; independence_enforced: boolean }>(
        `SELECT category, availability, administrative, independence_enforced
           FROM abos.permission_catalogue WHERE permission_code = 'company.dashboard.read'`)).rows[0];
      assert.deepEqual(row, { category: "COMPANY", availability: "ACTIVE", administrative: false, independence_enforced: false });
      const holders = await harness.executor.query<{ n: string }>(
        `SELECT (SELECT count(*) FROM abos.user_permission_grants WHERE permission_code = 'company.dashboard.read')
              + (SELECT count(*) FROM abos.access_role_permissions WHERE permission_code = 'company.dashboard.read') AS n`);
      assert.equal(Number(holders.rows[0]?.n), 0, "no existing role or user receives it automatically");
    });

    test("only a live session holding the permission gets figures, from its own company only; an empty database reports zero", async () => {
      await resetSchema(harness.pool);
      const world = await seedSyntheticWorld(harness.executor);
      await ensureLogin(harness);
      const connection = await restrictedFinance();
      try {
        const viewer = await sessionFor(harness, world, world.reverserId);
        // Signed in, but without the permission: refused before anything is read.
        await assert.rejects(() => summary(connection.executor, viewer.args), /missing company\.dashboard\.read/i);
        await assert.rejects(() => summary(connection.executor, { ...viewer.args, proof: "f".repeat(64) }), /identity runtime proof is invalid/i);
        await assert.rejects(() => summary(connection.executor, sessionArgs(`forged-${randomUUID()}`)), /sign in with an active account/i);

        await grant(harness, world, world.reverserId);
        const empty = await summary(connection.executor, viewer.args);
        assert.deepEqual(empty.projects, { active: 0, total: 0 }, "no projects recorded: zero, never a sample figure");
        assert.ok(empty.legalEntityName);

        // Real records of this company are counted; another company's are not.
        for (const [code, active] of [["SYN-P1", true], ["SYN-P2", true], ["SYN-P3", false]] as const) {
          await harness.executor.query("INSERT INTO abos.projects (id, legal_entity_id, code, name, active) VALUES ($1,$2,$3,$4,$5)",
            [randomUUID(), world.legalEntityId, code, `Synthetic project ${code}`, active]);
        }
        const other = await seedSyntheticWorld(harness.executor, { withoutSandboxAuthorization: true });
        await harness.executor.query("INSERT INTO abos.projects (id, legal_entity_id, code, name, active) VALUES ($1,$2,'SYN-OTHER','Other company project',true)",
          [randomUUID(), other.legalEntityId]);
        assert.deepEqual((await summary(connection.executor, viewer.args)).projects, { active: 2, total: 3 });

        // Revoking the permission, or ending the session, removes access at once.
        await harness.executor.query(
          "UPDATE abos.user_permission_grants SET revoked_at = clock_timestamp() WHERE user_account_id = $1 AND permission_code = 'company.dashboard.read'",
          [world.reverserId]);
        await assert.rejects(() => summary(connection.executor, viewer.args), /missing company\.dashboard\.read/i);
        const second = await sessionFor(harness, world, world.counterId);
        await grant(harness, world, world.counterId);
        assert.equal((await summary(connection.executor, second.args)).projects.total, 3);
        await harness.executor.query("UPDATE abos.sandbox_sessions SET revoked_at = clock_timestamp() WHERE id = $1", [second.sessionId]);
        await assert.rejects(() => summary(connection.executor, second.args), /sign in with an active account/i);
      } finally {
        await connection.close();
      }
    });

    test("least privilege: the owner reads only project counts and the company name; only the Finance runtime may call it", async () => {
      await resetSchema(harness.pool);
      await seedSyntheticWorld(harness.executor);
      const role = (await harness.executor.query<Record<string, boolean>>(
        `SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolinherit
           FROM pg_catalog.pg_roles WHERE rolname = $1`, [OWNER])).rows[0];
      assert.deepEqual(role, { rolcanlogin: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false,
        rolreplication: false, rolbypassrls: false, rolinherit: false });
      const memberships = await harness.executor.query(
        `SELECT 1 FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles r ON r.oid IN (m.member, m.roleid) WHERE r.rolname = $1`, [OWNER]);
      assert.equal(memberships.rowCount, 0);
      const owned = await harness.executor.query(
        `SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'abos' AND pg_catalog.pg_get_userbyid(c.relowner) = $1`, [OWNER]);
      assert.equal(owned.rowCount, 0, "owns no table");
      const tableGrants = await harness.executor.query(
        "SELECT table_name, privilege_type FROM information_schema.role_table_grants WHERE grantee = $1", [OWNER]);
      assert.deepEqual(tableGrants.rows, [], "no table-level grants at all");
      const columnGrants = await harness.executor.query<{ grant: string }>(
        `SELECT table_name || '.' || column_name || ':' || privilege_type AS grant FROM information_schema.column_privileges
          WHERE grantee = $1 ORDER BY 1`, [OWNER]);
      assert.deepEqual(columnGrants.rows.map((row) => row.grant), [
        "legal_entities.id:SELECT", "legal_entities.name:SELECT",
        "projects.active:SELECT", "projects.id:SELECT", "projects.legal_entity_id:SELECT"
      ]);
      const callers = await harness.executor.query<{ role: string }>(
        `SELECT role FROM unnest(ARRAY['abos_e1_runtime', 'abos_e1_treasury_runtime', 'abos_v1_identity_runtime', 'public']) role
          WHERE has_function_privilege(role, 'abos.company_dashboard_summary(text,text,text)', 'EXECUTE') ORDER BY 1`);
      assert.deepEqual(callers.rows.map((row) => row.role), ["abos_e1_runtime"]);
      for (const statement of ["SELECT * FROM abos.user_credentials", "SELECT * FROM abos.journals",
        "SELECT * FROM abos.operational_expenses", "SELECT name FROM abos.projects"]) {
        await ownerRefused(harness, statement);
      }
    });
  });
}

async function summary(executor: PostgresExecutor, session: SessionArgs): Promise<Summary> {
  const result = await executor.query<{ value: Summary }>("SELECT abos.company_dashboard_summary($1,$2,$3) AS value",
    [session.proof, session.runtimeDigest, session.tokenDigest]);
  assert.ok(result.rows[0]);
  return result.rows[0].value;
}

async function grant(harness: Harness, world: SyntheticWorld, userId: string): Promise<void> {
  await harness.executor.query(
    `INSERT INTO abos.user_permission_grants (user_account_id, legal_entity_id, permission_code, granted_by_user_account_id)
     VALUES ($1,$2,'company.dashboard.read',$3)`, [userId, world.legalEntityId, world.bootstrapUserId]);
}

async function ownerRefused(harness: Harness, statement: string): Promise<void> {
  const client = await harness.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL ROLE ${OWNER}`);
    await assert.rejects(() => client.query(statement), /permission denied/i, statement);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

async function ensureLogin(harness: Harness): Promise<void> {
  await harness.executor.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${LOGIN.name}') THEN
      CREATE ROLE ${LOGIN.name} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
    END IF; END $$`);
  await harness.executor.query(`ALTER ROLE ${LOGIN.name} LOGIN PASSWORD '${LOGIN.password}'`);
  await harness.executor.query(`GRANT abos_e1_runtime TO ${LOGIN.name}`);
}

async function restrictedFinance(): Promise<{ readonly executor: PostgresExecutor; close(): Promise<void> }> {
  const url = new URL(databaseUrl() ?? "");
  url.username = LOGIN.name;
  url.password = LOGIN.password;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 2 });
  return { executor: new PostgresExecutor(pool, { runtimeMarker: MARKER }), close: () => pool.end() };
}

async function sessionFor(harness: Harness, world: SyntheticWorld, userId: string): Promise<{ sessionId: string; args: SessionArgs }> {
  const authenticator = new SandboxAuthenticator(harness.executor, SYNTHETIC_AUTH_CONFIGURATION);
  const session = await authenticator.issueSession({ userAccountId: userId as UserAccountId, legalEntityId: world.legalEntityId as LegalEntityId });
  return { sessionId: session.sessionId, args: sessionArgs(session.token) };
}

function sessionArgs(token: string): SessionArgs {
  return {
    proof: identityDatabaseProof(SYNTHETIC_AUTH_CONFIGURATION.signingSecret),
    runtimeDigest: createHash("sha256").update(token).digest("hex"),
    tokenDigest: createHmac("sha256", SYNTHETIC_AUTH_CONFIGURATION.signingSecret).update(token).digest("hex")
  };
}
