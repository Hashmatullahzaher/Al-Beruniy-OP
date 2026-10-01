import assert from "node:assert/strict";
import test from "node:test";
import type { LegalEntityId, UserAccountId } from "@abos/contracts";
import type { SqlExecutor } from "@abos/database";
import { SandboxAuthenticator } from "@abos/sandbox-auth";
import { databaseUrl, loadMigrations, MISSING_DATABASE_MESSAGE, openHarness, withClusterLock } from "./harness.ts";
import { seedSyntheticWorld, SYNTHETIC_AUTH_CONFIGURATION } from "./synthetic-world.ts";

test("0031 to 0032 upgrades a populated disposable copy without changing business data or runtime table privileges", async () => {
  assert.ok(databaseUrl(), MISSING_DATABASE_MESSAGE);
  const harness = await openHarness(SYNTHETIC_AUTH_CONFIGURATION.runtimeMarker);
  try {
    await withClusterLock(harness.pool, async () => {
      const client = await harness.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("DROP SCHEMA IF EXISTS abos CASCADE");
        const migrations = await loadMigrations();
        const separationIndex = migrations.findIndex((migration) => migration.id === "0032_v1_operational_gate_separation");
        assert.ok(separationIndex > 0, "0032 is present after its predecessors");
        const separation = migrations[separationIndex];
        for (const migration of migrations.slice(0, separationIndex)) await client.query(migration.sql);
        await client.query("SELECT set_config('abos.runtime_marker',$1,true)", [SYNTHETIC_AUTH_CONFIGURATION.runtimeMarker]);
        const tx: SqlExecutor = {
          query: async <Row extends object>(sql: string, parameters: readonly unknown[] = []) => {
            const result = await client.query(sql, [...parameters]);
            return { rows: result.rows as Row[], rowCount: result.rowCount ?? 0 };
          },
          transaction: async (work) => work(tx)
        };
        const world = await seedSyntheticWorld(tx);
        const oldSession = await new SandboxAuthenticator(tx, SYNTHETIC_AUTH_CONFIGURATION).issueSession({
          userAccountId: world.treasuryManagerId as UserAccountId,
          legalEntityId: world.legalEntityId as LegalEntityId
        });
        const tables = (await client.query<{ name: string }>(
          "SELECT tablename AS name FROM pg_tables WHERE schemaname='abos' AND tablename <> 'sandbox_sessions' ORDER BY tablename"
        )).rows;
        const snapshot = async () => Promise.all(tables.map(async ({ name }) => {
          const quoted = `"${name.replaceAll('"', '""')}"`;
          const result = await client.query<{ data: string | null }>(
            `SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text AS data FROM abos.${quoted} t`
          );
          return [name, result.rows[0]?.data];
        }));
        const before = await snapshot();
        const oldFunctions = await client.query("SELECT count(*)::int AS count FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='abos' AND p.prosecdef");
        assert.equal(oldFunctions.rows[0]?.count, 63);
        await client.query(separation!.sql);
        assert.deepEqual(await snapshot(), before, "0032 preserves all populated business records");
        const revoked = await client.query<{ revoked: boolean; provenance: string }>(
          `SELECT revoked_at IS NOT NULL AS revoked, session_provenance AS provenance
             FROM abos.sandbox_sessions WHERE id=$1`,
          [oldSession.sessionId]
        );
        assert.deepEqual(revoked.rows[0], {
          revoked: true,
          provenance: "SYNTHETIC_DEVELOPER"
        }, "0032 logs out every pre-upgrade session and never promotes it to operational provenance");
        const privileges = await client.query(
          `SELECT role, tablename FROM unnest(ARRAY['abos_e1_runtime','abos_e1_treasury_runtime','abos_v1_identity_runtime']) role
             CROSS JOIN pg_tables WHERE schemaname='abos'
               AND has_table_privilege(role, 'abos.' || quote_ident(tablename), 'INSERT,UPDATE,DELETE')`
        );
        assert.deepEqual(privileges.rows, []);
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });
  } finally {
    await harness.close();
  }
});
