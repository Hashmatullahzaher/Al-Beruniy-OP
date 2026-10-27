import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before, describe } from "node:test";
import type pg from "pg";

import { applyMigrations, type SqlExecutor } from "@abos/database";

import { databaseUrl, loadMigrations, MISSING_DATABASE_MESSAGE, openHarness, withClusterLock, type Harness } from "./harness.ts";
import { seedSyntheticWorld, SYNTHETIC_AUTH_CONFIGURATION } from "./synthetic-world.ts";

const PREDECESSOR = "0038_v1_shareholder_capital_activation";
const MIGRATION = "0039_v1_admin_approval_controls";
const NEW_TABLES = ["finance_workflow_policy_commands", "ledger_account_policy_releases", "direct_capital_receipts", "direct_capital_receipt_allocations",
  "permission_retirements", "posting_sources", "treasury_opening_balances", "operational_treasury_account_responsibles",
  "treasury_cash_receipts", "treasury_transfers", "treasury_payments"] as const;
// 0041 seeds the retirement register (schema metadata, like the workflow catalogue row) and lets only the
// identity runtime read it; every other new table stays empty and unreachable from every runtime.
const SEEDED_ROWS: Readonly<Record<string, number>> = { permission_retirements: 12, posting_sources: 11 };
const READ_ONLY_RUNTIME: Readonly<Record<string, string>> = { permission_retirements: "abos_v1_identity_runtime" };
const NEW_GOVERNANCE_COLUMNS = [
  "finance_workflow_policy_version_id", "approval_required", "policy_released_by_user_account_id",
  "policy_released_at", "policy_release_reason"
] as const;

if (databaseUrl() === undefined) {
  test("0039 Admin approval controls historical upgrade", () => assert.fail(MISSING_DATABASE_MESSAGE));
} else {
  describe("0038 through 0042 approval controls, direct-capital, synthetic-lane retirement and business-day zero-backfill upgrade", () => {
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
          assert.deepEqual(await applyMigrations(tx, migrations), [MIGRATION, "0040_v1_direct_shareholder_capital", "0041_v1_retire_synthetic_lane", "0042_v1_shareholder_business_day", "0043_v1_posting_kernel", "0044_v1_posting_kernel_writer", "0045_v1_subledger_sign_and_balances", "0046_v1_treasury_opening_balances", "0047_v1_basic_money_movements", "0048_v1_expense_payment_kind"]);
          const afterTables = await tableNames(client);
          assert.deepEqual(afterTables.filter((name) => !beforeTables.includes(name)), [...NEW_TABLES].sort());
          assert.deepEqual(await snapshots(client, beforeTables), beforeBusiness,
            "all historical columns in every business/security table are byte-for-byte preserved");
          assert.deepEqual((await client.query("SELECT * FROM abos.schema_migrations WHERE migration_id<>ALL($1::text[]) ORDER BY migration_id", [[MIGRATION, "0040_v1_direct_shareholder_capital", "0041_v1_retire_synthetic_lane", "0042_v1_shareholder_business_day", "0043_v1_posting_kernel", "0044_v1_posting_kernel_writer", "0045_v1_subledger_sign_and_balances", "0046_v1_treasury_opening_balances", "0047_v1_basic_money_movements", "0048_v1_expense_payment_kind"]])).rows,
            beforeRegistry, "all 0001-0038 registry values, checksums and timestamps are unchanged");
          const upgraded = (await client.query("SELECT checksum_sha256 FROM abos.schema_migrations WHERE migration_id=$1", [MIGRATION])).rows;
          assert.equal(upgraded.length, 1, "0039 recorded exactly once");
          assert.equal(upgraded[0]?.checksum_sha256, migrations[index]?.checksumSha256);
          assert.equal(Number((await client.query("SELECT count(*) AS n FROM abos.schema_migrations")).rows[0]?.n), beforeRegistry.length + 10);
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
            assert.equal(Number((await client.query(`SELECT count(*) AS n FROM abos.${table}`)).rows[0]?.n), SEEDED_ROWS[table] ?? 0,
              `${table} has no backfilled commands or automatic releases`);
            for (const runtime of ["abos_e1_runtime", "abos_e1_treasury_runtime", "abos_v1_identity_runtime"]) {
              const privileges = (await client.query(`SELECT
                has_table_privilege($1,$2,'SELECT') AS read_access,
                has_table_privilege($1,$2,'INSERT,UPDATE,DELETE,TRUNCATE') AS write_access,
                has_any_column_privilege($1,$2,'INSERT,UPDATE') AS column_write_access`, [runtime, `abos.${table}`])).rows[0];
              const readOnly = READ_ONLY_RUNTIME[table] === runtime;
              assert.deepEqual(privileges, { read_access: readOnly, write_access: false, column_write_access: false }, `${runtime} access to ${table}`);
            }
          }
          // 0041: every frozen E1 entry point still exists, no runtime may execute any of them, and the
          // register names exactly the twelve retired codes while their catalogue rows and grants are untouched.
          const lanes = (await client.query(`SELECT count(*)::int AS n, bool_and(function_exists) AS present,
            bool_or(finance_runtime_can_execute OR treasury_runtime_can_execute OR identity_runtime_can_execute) AS runtime,
            bool_and(frozen_lane_can_execute) AS holder FROM abos.frozen_lanes`)).rows[0];
          assert.deepEqual(lanes, { n: 14, present: true, runtime: false, holder: true });
          assert.equal(Number((await client.query(`SELECT count(*) AS n FROM abos.permission_retirements r
            JOIN abos.permission_catalogue c USING (permission_code)`)).rows[0]?.n), 12);
          // 0046: the two new codes, and OPENING_BALANCE is the one registry source it activates.
          assert.deepEqual((await client.query(`SELECT permission_code, category, availability FROM abos.permission_catalogue
            WHERE permission_code IN ('treasury.safe.read','treasury.opening-balance.record') ORDER BY 1`)).rows,
          [{ permission_code: "treasury.opening-balance.record", category: "TREASURY", availability: "ACTIVE" },
            { permission_code: "treasury.safe.read", category: "TREASURY", availability: "ACTIVE" }]);
          assert.deepEqual((await client.query("SELECT source_type FROM abos.posting_sources WHERE status='ACTIVE' ORDER BY 1")).rows.map((r) => r.source_type),
            ["CASH_RECEIPT", "DIRECT_SHAREHOLDER_CAPITAL", "OPENING_BALANCE", "OPERATIONAL_EXPENSE", "PAYMENT", "TEMPORARY_FUNDING", "TEMPORARY_FUNDING_SETTLEMENT", "TREASURY_TRANSFER"]);
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
    const addedColumns = table === "ledger_account_governance" ? [...NEW_GOVERNANCE_COLUMNS]
      : table === "shareholder_profiles" ? ["capital_note", "capital_document_agreement_id"]
      : table === "posting_intents" ? ["direct_capital_receipt_id", "treasury_opening_balance_id", "treasury_receipt_id", "treasury_transfer_id", "treasury_payment_id"]
      : table === "operational_expenses" ? ["payment_kind"]
      : table === "subledger_entries" ? ["direct_capital_receipt_id"] : [];
    const projection = addedColumns.length ? "to_jsonb(t)-$1::text[]" : "to_jsonb(t)";
    const parameters = addedColumns.length ? [addedColumns] : [];
    // 0046 adds two permission codes to the catalogue (asserted separately); every other row is untouched.
    const filter = table === "finance_workflow_types" ? " WHERE workflow_type<>'CHART_OF_ACCOUNTS'"
      : table === "permission_catalogue" ? " WHERE permission_code NOT IN ('treasury.safe.read','treasury.opening-balance.record','treasury.receipt.record','treasury.transfer.record','treasury.payment.record')" : "";
    const row = (await client.query(`SELECT count(*)::text AS count,
      md5(COALESCE(string_agg((${projection})::text,'' ORDER BY (${projection})::text),'')) AS hash
      FROM abos.${table} t${filter}`, parameters)).rows[0];
    result.push([table, row]);
  }
  return result;
}
