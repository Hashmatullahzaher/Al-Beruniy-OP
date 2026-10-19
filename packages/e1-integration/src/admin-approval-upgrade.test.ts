import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before, describe } from "node:test";
import type pg from "pg";

import { applyMigrations, type SqlExecutor } from "@abos/database";

import { databaseUrl, loadMigrations, MISSING_DATABASE_MESSAGE, openHarness, withClusterLock, type Harness } from "./harness.ts";
import { seedSyntheticWorld, SYNTHETIC_AUTH_CONFIGURATION } from "./synthetic-world.ts";

const PREDECESSOR = "0038_v1_shareholder_capital_activation";
const MIGRATION = "0039_v1_admin_approval_controls";
const NEW_TABLES = ["finance_workflow_policy_commands", "ledger_account_policy_releases"] as const;
const NEW_GOVERNANCE_COLUMNS = [
  "finance_workflow_policy_version_id", "approval_required", "policy_released_by_user_account_id",
  "policy_released_at", "policy_release_reason"
] as const;

if (databaseUrl() === undefined) {
  test("0039 Admin approval controls historical upgrade", () => assert.fail(MISSING_DATABASE_MESSAGE));
} else {
  describe("0038 to 0039 Admin approval controls historical upgrade", () => {
    let harness: Harness;
    before(async () => { harness = await openHarness(SYNTHETIC_AUTH_CONFIGURATION.runtimeMarker); });
    after(async () => { await harness?.close(); });

    test("normal runner preserves all business rows and history, adds only protective governance defaults, and grants no runtime table access", async () => {
      await withClusterLock(harness.pool, async () => {
        const client = await harness.pool.connect();
        try {
          await client.query("BEGIN");
          await client.query("DROP SCHEMA IF EXISTS abos CASCADE");
          const migrations = await loadMigrations();
          const index = migrations.findIndex((migration) => migration.id === MIGRATION);
          assert.ok(index > 0, "0039 is registered after its accepted predecessors");
          assert.equal(migrations[index - 1]?.id, PREDECESSOR);
          assert.equal(migrations[index - 1]?.checksumSha256, "7b86dd4aa0ded7450d7c8d34f78bc569903c3b2079e9a61edc88462f0bfb995d");
          assert.equal(migrations.find((migration) => migration.id === "0037_v1_temporary_funding")?.checksumSha256,
            "b6b9de5be6807cb1c7952da13a58cf7a158d457c379eb1b61eaf8460cf49f285");
          assert.equal(migrations.find((migration) => migration.id === "0036_v1_shareholder_finance_bridge")?.checksumSha256,
            "669c8afb6938d135800d6c96c74110038c21dded2312f2055517f2a736493a3d");
          // The current runner refuses truncated catalogs. Reconstruct the accepted historical
          // registry as a whole, then exercise the real runner for the actual upgrade.
          await client.query(`CREATE SCHEMA abos; CREATE TABLE abos.schema_migrations (
            migration_id text PRIMARY KEY,
            checksum_sha256 text NOT NULL CHECK(checksum_sha256 ~ '^[0-9a-f]{64}$'),
            applied_at timestamptz NOT NULL DEFAULT clock_timestamp())`);
          for (const predecessor of migrations.slice(0, index)) {
            await client.query(predecessor.sql);
            await client.query("INSERT INTO abos.schema_migrations(migration_id,checksum_sha256) VALUES($1,$2)",
              [predecessor.id, predecessor.checksumSha256]);
          }
          const tx: SqlExecutor = {
            query: async <Row extends object>(sql: string, parameters: readonly unknown[] = []) => {
              const result = await client.query(sql, [...parameters]);
              return { rows: result.rows as Row[], rowCount: result.rowCount ?? 0 };
            }, transaction: async (work) => work(tx)
          };
          await client.query("SELECT set_config('abos.runtime_marker',$1,true)", [SYNTHETIC_AUTH_CONFIGURATION.runtimeMarker]);
          const world = await seedSyntheticWorld(tx, { withoutSandboxAuthorization: true });
          await client.query(`INSERT INTO abos.shareholder_contributions
            (id,legal_entity_id,shareholder_profile_id,contribution_type,business_date,description,
             record_status,receipt_status,valuation_status,amount,currency_code,version,
             created_by_user_account_id,declared_by_user_account_id,declared_at)
            VALUES($1,$2,$3,'CASH','2026-10-01','Synthetic pre-0039 preserved declaration',
              'DECLARED','NOT_RECEIVED','NOT_APPLICABLE',50000,'USD',1,$4,$4,clock_timestamp())`,
          [randomUUID(), world.legalEntityId, world.shareholderProfileId, world.bootstrapUserId]);
          // Exercise populated old governance states and real historical review decisions.
          for (const [id, state] of [[world.capitalLedgerAccountId, "PENDING_REVIEW"],
            [world.cashLedgerAccountId, "REVIEWED"], [world.afnCashLedgerAccountId, "FLAGGED"]] as const) {
            await client.query(`INSERT INTO abos.ledger_account_governance
              (ledger_account_id,legal_entity_id,origin,created_by_user_account_id,created_at,
               last_changed_by_user_account_id,last_changed_at,version,review_state,review_reason)
              VALUES($1,$2,'APP',$3,clock_timestamp(),$3,clock_timestamp(),1,$4,'CREATED')`,
            [id, world.legalEntityId, world.bootstrapUserId, state]);
            if (state !== "PENDING_REVIEW") {
              await client.query(`INSERT INTO abos.ledger_account_review_decisions
                (id,ledger_account_id,legal_entity_id,account_version,decision,note,reviewer_user_account_id)
                VALUES($1,$2,$3,1,$4,'Synthetic historical review preserved',$5)`,
              [randomUUID(), id, world.legalEntityId, state, world.approverId]);
            }
          }
          for (const [workflow, version, required] of [
            ["SHAREHOLDER_CAPITAL_RECEIPT", 1, true], ["SHAREHOLDER_CAPITAL_RECEIPT", 2, false],
            ["SHAREHOLDER_CAPITAL_RECEIPT", 3, true], ["TEMPORARY_FUNDING", 1, true], ["EXPENSE", 1, false]
          ] as const) {
            await client.query(`INSERT INTO abos.finance_workflow_policy_versions
              (id,legal_entity_id,workflow_type,version,approval_required,configured_by_user_account_id,change_reason)
              VALUES($1,$2,$3,$4,$5,$6,'Synthetic historical owner choice preserved')`,
            [randomUUID(), world.legalEntityId, workflow, version, required, world.bootstrapUserId]);
          }
          const beforeTables = await tableNames(client);
          const beforeBusiness = await snapshots(client, beforeTables);
          const beforeRegistry = (await client.query("SELECT * FROM abos.schema_migrations ORDER BY migration_id")).rows;
          const governanceBefore = (await client.query("SELECT to_jsonb(g) AS row FROM abos.ledger_account_governance g ORDER BY ledger_account_id")).rows;
          assert.equal(governanceBefore.length, 3);
          assert.deepEqual(await applyMigrations(tx, migrations), [MIGRATION]);
          const afterTables = await tableNames(client);
          assert.deepEqual(afterTables.filter((name) => !beforeTables.includes(name)), [...NEW_TABLES].sort());
          assert.deepEqual(await snapshots(client, beforeTables), beforeBusiness,
            "all historical columns in every business/security table are byte-for-byte preserved");
          assert.deepEqual((await client.query("SELECT * FROM abos.schema_migrations WHERE migration_id<>$1 ORDER BY migration_id", [MIGRATION])).rows,
            beforeRegistry, "all 0001-0038 registry values, checksums and timestamps are unchanged");
          const upgraded = (await client.query("SELECT checksum_sha256 FROM abos.schema_migrations WHERE migration_id=$1", [MIGRATION])).rows;
          assert.equal(upgraded.length, 1, "0039 recorded exactly once");
          assert.equal(upgraded[0]?.checksum_sha256, migrations[index]?.checksumSha256);
          assert.equal(Number((await client.query("SELECT count(*) AS n FROM abos.schema_migrations")).rows[0]?.n), beforeRegistry.length + 1);
          assert.deepEqual((await client.query(`SELECT to_jsonb(g)-$1::text[] AS row
            FROM abos.ledger_account_governance g ORDER BY ledger_account_id`, [NEW_GOVERNANCE_COLUMNS])).rows, governanceBefore);
          const governanceAdded = (await client.query(`SELECT approval_required,finance_workflow_policy_version_id,
            policy_released_by_user_account_id,policy_released_at,policy_release_reason
            FROM abos.ledger_account_governance ORDER BY ledger_account_id`)).rows;
          assert.deepEqual(governanceAdded, Array.from({ length: 3 }, () => ({ approval_required: true,
            finance_workflow_policy_version_id: null, policy_released_by_user_account_id: null,
            policy_released_at: null, policy_release_reason: null })),
          "only the protective default is added; old records are not rebound, released or approved");
          const newWorkflow = (await client.query("SELECT * FROM abos.finance_workflow_types WHERE workflow_type='CHART_OF_ACCOUNTS'")).rows;
          assert.equal(newWorkflow.length, 1, "exactly one canonical workflow definition added");
          assert.equal(newWorkflow[0]?.active, true);
          assert.equal(Number((await client.query("SELECT count(*) AS n FROM abos.finance_workflow_policy_versions WHERE workflow_type='CHART_OF_ACCOUNTS'")).rows[0]?.n), 0,
            "no client CoA policy choice is created by schema deployment");
          for (const table of NEW_TABLES) {
            assert.equal(Number((await client.query(`SELECT count(*) AS n FROM abos.${table}`)).rows[0]?.n), 0,
              `${table} has no backfilled commands or automatic releases`);
            for (const runtime of ["abos_e1_runtime", "abos_e1_treasury_runtime", "abos_v1_identity_runtime"]) {
              const privileges = (await client.query(`SELECT
                has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') AS table_access,
                has_any_column_privilege($1,$2,'SELECT,INSERT,UPDATE') AS column_access`, [runtime, `abos.${table}`])).rows[0];
              assert.deepEqual(privileges, { table_access: false, column_access: false }, `${runtime} has no direct access to ${table}`);
            }
          }
          const afterAll = await snapshots(client, afterTables);
          const afterRegistry = (await client.query("SELECT * FROM abos.schema_migrations ORDER BY migration_id")).rows;
          assert.deepEqual(await applyMigrations(tx, migrations), [], "repeating the reviewed runner is a no-op");
          assert.deepEqual(await snapshots(client, afterTables), afterAll);
          assert.deepEqual((await client.query("SELECT * FROM abos.schema_migrations ORDER BY migration_id")).rows, afterRegistry);
        } finally {
          await client.query("ROLLBACK");
          client.release();
        }
      });
    });
  });
}

async function tableNames(client: pg.PoolClient): Promise<string[]> {
  return (await client.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='abos' AND tablename<>'schema_migrations' ORDER BY tablename")).rows.map((row) => row.tablename);
}

async function snapshots(client: pg.PoolClient, tables: readonly string[]): Promise<readonly unknown[]> {
  const result: unknown[] = [];
  for (const table of tables) {
    assert.match(table, /^[a-z_]+$/);
    // New governance columns have separately asserted protective defaults. The single workflow
    // catalogue row is schema metadata, not a policy or authorization for any real company.
    const projection = table === "ledger_account_governance" ? "to_jsonb(t)-$1::text[]" : "to_jsonb(t)";
    const parameters = table === "ledger_account_governance" ? [NEW_GOVERNANCE_COLUMNS] : [];
    const filter = table === "finance_workflow_types" ? " WHERE workflow_type<>'CHART_OF_ACCOUNTS'" : "";
    const row = (await client.query(`SELECT count(*)::text AS count,
      md5(COALESCE(string_agg((${projection})::text,'' ORDER BY (${projection})::text),'')) AS hash
      FROM abos.${table} t${filter}`, parameters)).rows[0];
    result.push([table, row]);
  }
  return result;
}
