import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";

import { databaseUrl, openHarness, resetSchema, type Harness } from "./harness.ts";

/**
 * Prepared PostgreSQL acceptance harness for the coordinated bridge migration.
 *
 * It is intentionally gated because migrations end at 0035 on this branch. Setting the switch
 * before the coordinated migration exists makes the suite fail on the capability probe; it never
 * invents tables or installs fixture SQL. The future schema coordinator should replace each
 * gated case with the executable fixture command while preserving these names and invariants.
 */
const ENABLED = process.env.ABOS_SHAREHOLDER_FINANCE_SCHEMA_TESTS === "1";
const GATE_REASON = "Set ABOS_SHAREHOLDER_FINANCE_SCHEMA_TESTS=1 only on a disposable database after the coordinated bridge migration is installed.";

if (!ENABLED) {
  for (const name of [
    "upgrade from 0035 preserves business rows and creates zero receipt backfill",
    "legacy E1 capital custody and posting remain unchanged",
    "Operational V1 expense posting remains unchanged",
    "same-currency shareholder receipt follows receipt to custody to approval to posting",
    "one receipt produces one intent and one journal",
    "posted capital journal has exactly two balanced lines",
    "posted capital journal has exactly two matching subledger entries",
    "entity-qualified source destination evidence approval and journal links reject cross-entity data",
    "restricted Treasury and Finance runtimes have no direct protected-table mutation",
    "same-key retries replay and conflicting keys or payloads cannot duplicate receipt or posting",
    "stale versions over-receipts and concurrent posts fail closed",
    "cross-currency refunds reversals in-kind and credit posting remain unavailable"
  ]) test(name, { skip: GATE_REASON }, () => undefined);
} else if (databaseUrl() === undefined) {
  test("shareholder finance schema harness requires a disposable PostgreSQL URL", () => {
    assert.fail("ABOS_TEST_DATABASE_URL is required when ABOS_SHAREHOLDER_FINANCE_SCHEMA_TESTS=1.");
  });
} else {
  describe("coordinated Shareholders to Finance PostgreSQL capability", () => {
    let harness: Harness;
    before(async () => { harness = await openHarness("shareholder-finance-schema-tests"); });
    after(async () => { await harness.close(); });

    test("coordinated schema objects are installed before functional cases run", async () => {
      await resetSchema(harness.pool);
      const result = await harness.pool.query<{ receipts: string | null; custody: string | null; mappings: string | null }>(`
        SELECT to_regclass('abos.shareholder_capital_receipts')::text AS receipts,
               to_regclass('abos.shareholder_capital_receipt_custody_verifications')::text AS custody,
               to_regclass('abos.shareholder_capital_account_mapping_versions')::text AS mappings
      `);
      assert.deepEqual(result.rows[0], {
        receipts: "abos.shareholder_capital_receipts",
        custody: "abos.shareholder_capital_receipt_custody_verifications",
        mappings: "abos.shareholder_capital_account_mapping_versions"
      });
    });

    test("fresh installation performs zero shareholder receipt backfill", async () => {
      const result = await harness.pool.query<{ receipts: string; custody: string }>(`
        SELECT (SELECT count(*)::text FROM abos.shareholder_capital_receipts) AS receipts,
               (SELECT count(*)::text FROM abos.shareholder_capital_receipt_custody_verifications) AS custody
      `);
      assert.deepEqual(result.rows[0], { receipts: "0", custody: "0" });
    });

    test("restricted runtime roles have no direct mutation on bridge and protected GL tables", async () => {
      const result = await harness.pool.query<{ role_name: string; table_name: string; may_mutate: boolean }>(`
        SELECT role_name, table_name,
               has_table_privilege(role_name, 'abos.' || table_name, 'INSERT,UPDATE,DELETE') AS may_mutate
          FROM unnest(ARRAY['abos_e1_runtime','abos_e1_treasury_runtime']) role_name
          CROSS JOIN unnest(ARRAY['shareholder_capital_receipts','shareholder_capital_receipt_custody_verifications',
                                  'posting_intents','posting_approvals','journals','journal_lines','subledger_entries']) table_name
      `);
      assert.ok(result.rows.every((row) => row.may_mutate === false), JSON.stringify(result.rows));
    });
  });
}
