import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import type { LegalEntityId } from "@abos/contracts";
import { SandboxAuthenticator } from "@abos/sandbox-auth";
import type { PoolClient } from "pg";
import { databaseUrl, MISSING_DATABASE_MESSAGE, openHarness, resetSchema, type Harness } from "./harness.ts";
import { seedSyntheticWorld, type SyntheticWorld } from "./synthetic-world.ts";

/**
 * The migration identity owns the schema; the runtime identity must never inherit its powers.
 * A role allowed to write journals directly could present a copied runtime marker and bypass
 * application authorization, so the restricted E1 role intentionally has no raw write grants.
 */
if (databaseUrl() === undefined) {
  test("E1 restricted PostgreSQL role", () => assert.fail(MISSING_DATABASE_MESSAGE));
} else {
  describe("E1 restricted PostgreSQL role", () => {
    let harness: Harness;
    let world: SyntheticWorld;

    before(async () => {
      harness = await openHarness("synthetic-e1-sandbox-marker");
      await resetSchema(harness.pool);
      world = await seedSyntheticWorld(harness.executor);
    });

    after(async () => {
      await harness.close();
    });

    test("migration and runtime identities are separate; runtime has only the posting capability", async () => {
      await asRuntime(harness, async (client) => {
        const identity = await client.query<{ current_user: string }>("SELECT current_user");
        assert.equal(identity.rows[0]?.current_user, "abos_e1_runtime");

        const privileges = await client.query<{
          can_read_sessions: boolean;
          can_insert_journal: boolean;
          can_update_journal: boolean;
          can_grant_permission: boolean;
          can_edit_gate: boolean;
          can_create_in_schema: boolean;
          can_execute_secure_post: boolean;
        }>(
          `SELECT has_table_privilege(current_user, 'abos.sandbox_sessions', 'SELECT') AS can_read_sessions,
                  has_table_privilege(current_user, 'abos.journals', 'INSERT') AS can_insert_journal,
                  has_table_privilege(current_user, 'abos.journals', 'UPDATE') AS can_update_journal,
                  has_table_privilege(current_user, 'abos.user_permission_grants', 'INSERT') AS can_grant_permission,
                  has_table_privilege(current_user, 'abos.sandbox_authorizations', 'UPDATE') AS can_edit_gate,
                  has_schema_privilege(current_user, 'abos', 'CREATE') AS can_create_in_schema,
                  has_function_privilege(current_user,
                    'abos.post_synthetic_capital_receipt(text,uuid,uuid)', 'EXECUTE')
                    AS can_execute_secure_post`
        );
        assert.deepEqual(privileges.rows[0], {
          can_read_sessions: false,
          can_insert_journal: false,
          can_update_journal: false,
          can_grant_permission: false,
          can_edit_gate: false,
          can_create_in_schema: false,
          can_execute_secure_post: true
        });
      });
    });

    test("runtime cannot disable integrity triggers or replace a guard function", async () => {
      await denied(harness, "ALTER TABLE abos.journals DISABLE TRIGGER ALL");
      await denied(
        harness,
        `CREATE OR REPLACE FUNCTION abos.assert_sandbox_mutation_authorized(uuid)
         RETURNS void LANGUAGE sql AS 'SELECT NULL::void'`
      );
    });

    test("copied runtime marker never gives the restricted role a finance write capability", async () => {
      await asRuntime(harness, async (client) => {
        await client.query("SELECT set_config('abos.runtime_marker', $1, true)", [world.runtimeMarker]);
        await assert.rejects(
          () => client.query("INSERT INTO abos.journals DEFAULT VALUES"),
          /permission denied/i
        );
      });
      await denied(harness, "UPDATE abos.journals SET status = 'DRAFT' WHERE false");
    });

    test("runtime cannot grant Finance authority or edit the sandbox authorization", async () => {
      await denied(
        harness,
        `INSERT INTO abos.user_permission_grants
           (user_account_id, legal_entity_id, permission_code, granted_by_user_account_id)
         VALUES ($1, $2, 'finance.journal.post', $3)`,
        [world.cashierId, world.legalEntityId, world.bootstrapUserId]
      );
      await denied(
        harness,
        "UPDATE abos.sandbox_authorizations SET runtime_marker = 'another-sandbox-marker' WHERE singleton"
      );
      await denied(
        harness,
        "UPDATE abos.sandbox_authorizations SET real_posting_enabled = true WHERE singleton"
      );
      const gate = await harness.executor.query<{ real_posting_enabled: boolean; runtime_marker: string }>(
        "SELECT real_posting_enabled, runtime_marker FROM abos.sandbox_authorizations WHERE singleton"
      );
      assert.equal(gate.rows[0]?.real_posting_enabled, false);
      assert.equal(gate.rows[0]?.runtime_marker, world.runtimeMarker);
    });

    test("runtime cannot directly mutate journals or subledger entries", async () => {
      await denied(harness, "DELETE FROM abos.journals WHERE false");
      await denied(harness, "INSERT INTO abos.subledger_entries DEFAULT VALUES");
      const totals = await harness.executor.query<{ journal_count: string; subledger_count: string }>(
        `SELECT (SELECT count(*) FROM abos.journals)::text AS journal_count,
                (SELECT count(*) FROM abos.subledger_entries)::text AS subledger_count`
      );
      assert.deepEqual(totals.rows[0], { journal_count: "0", subledger_count: "0" });
    });

    test("a session authenticated before Finance grant revocation cannot pass commit-time revalidation", async () => {
      const authenticator = new SandboxAuthenticator(harness.executor, {
        environment: "test",
        runtimeMarker: world.runtimeMarker,
        signingSecret: "synthetic-test-only-revalidation-secret-1234567890",
        maxSessionSeconds: 900
      });
      const legalEntityId = world.legalEntityId as LegalEntityId;
      const session = await authenticator.issueSession({
        userAccountId: world.approverId as never,
        legalEntityId
      });
      const actor = await authenticator.authenticate(session.token);
      const input = {
        bearerToken: session.token,
        actor,
        legalEntityId,
        dimensions: {
          scope: "COMPANY_LEVEL" as const,
          legalEntityId,
          companyLevelReason: "CORPORATE_CAPITAL" as const
        }
      };
      await harness.executor.transaction((transaction) =>
        authenticator.revalidatePostingAuthority(transaction, input)
      );

      await harness.executor.query(
        `UPDATE abos.user_permission_grants SET revoked_at = clock_timestamp()
          WHERE user_account_id = $1 AND legal_entity_id = $2
            AND permission_code = 'finance.journal.post'`,
        [world.approverId, world.legalEntityId]
      );
      await assert.rejects(
        () => harness.executor.transaction((transaction) =>
          authenticator.revalidatePostingAuthority(transaction, input)
        ),
        /Current Finance authority is missing finance\.journal\.post/
      );
      const journals = await harness.executor.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM abos.journals"
      );
      assert.equal(journals.rows[0]?.count, "0");
    });
  });
}

async function denied(harness: Harness, sql: string, parameters: readonly unknown[] = []): Promise<void> {
  await asRuntime(harness, async (client) => {
    await assert.rejects(() => client.query(sql, [...parameters]), /permission denied|must be owner/i);
  });
}

async function asRuntime(
  harness: Harness,
  operation: (client: PoolClient) => Promise<void>
): Promise<void> {
  const client = await harness.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE abos_e1_runtime");
    await operation(client);
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
  }
}
