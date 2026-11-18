import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before, describe } from "node:test";

import { applyMigrations } from "@abos/database";

import { databaseUrl, loadMigrations, MISSING_DATABASE_MESSAGE, withClusterLock } from "./harness.ts";
import { keys, ReportDatabase, SEPT, type ReportCompany, type ReportEvents } from "./report-world.ts";

/**
 * Upgrading a company at 0060 that already holds posted temporary funding and its settlement. Migrations 0061 and 0062 must leave every
 * posted row exactly as it was, and the legacy records must keep reporting, drilling down and refusing reversal as they did.
 */
const PREDECESSOR = "0060_v1_reversal_confidentiality";
const NEW = ["0061_v1_loan_model_and_lanes", "0062_v1_loan_reporting", "0063_v1_realized_fx_loan_settlement", "0064_v1_fx_treasury_carrying_value", "0065_v1_document_vault", "0066_v1_document_scanning", "0067_v1_agreement_documents", "0068_v1_report_export_audit"];

if (databaseUrl() === undefined) {
  test("0061 upgrade with legacy temporary funding", () => assert.fail(MISSING_DATABASE_MESSAGE));
} else {
  describe("0061 and 0062 over legacy temporary funding", () => {
    const db = new ReportDatabase();
    let f: ReportCompany; let j: ReportEvents;

    const fingerprint = async () => (await db.h.pool.query<{ t: string; n: string; h: string }>(`
      SELECT 'journals' AS t, count(*)::text AS n, md5(COALESCE(string_agg(x::text, '|' ORDER BY x.id), '')) AS h FROM abos.journals x
      UNION ALL SELECT 'lines', count(*)::text, md5(COALESCE(string_agg(x::text, '|' ORDER BY x.id), '')) FROM abos.journal_lines x
      UNION ALL SELECT 'subledger', count(*)::text, md5(COALESCE(string_agg(x::text, '|' ORDER BY x.id), '')) FROM abos.subledger_entries x
      UNION ALL SELECT 'fundings', count(*)::text, md5(COALESCE(string_agg(x::text, '|' ORDER BY x.id), '')) FROM abos.temporary_fundings x
      UNION ALL SELECT 'settlements', count(*)::text, md5(COALESCE(string_agg(x::text, '|' ORDER BY x.id), '')) FROM abos.temporary_funding_settlements x
      UNION ALL SELECT 'links', count(*)::text, md5(COALESCE(string_agg(x::text, '|' ORDER BY x.reversal_journal_id), '')) FROM abos.journal_reversal_links x
      ORDER BY 1`)).rows;
    const run = () => withClusterLock(db.h.pool, async () => {
      const client = await db.h.pool.connect();
      const tx = { query: async (sql: string, parameters: readonly unknown[] = []) => { const result = await client.query(sql, [...parameters]); return { rows: result.rows, rowCount: result.rowCount ?? 0 }; } };
      try {
        return await applyMigrations({ ...tx, transaction: async (work: (t: typeof tx) => Promise<unknown>) => {
          await client.query("BEGIN");
          try { const result = await work(tx); await client.query("COMMIT"); return result; } catch (error) { await client.query("ROLLBACK"); throw error; }
        } } as never, await loadMigrations());
      } finally { client.release(); }
    });

    before(async () => {
      await db.open();
      const migrations = await loadMigrations();
      const index = migrations.findIndex((m) => m.id === PREDECESSOR);
      assert.ok(index > 0);
      await withClusterLock(db.h.pool, async () => {
        const client = await db.h.pool.connect();
        try {
          await client.query("BEGIN");
          await client.query("DROP SCHEMA IF EXISTS abos CASCADE");
          await client.query(`CREATE SCHEMA abos; CREATE TABLE abos.schema_migrations (migration_id text PRIMARY KEY, checksum_sha256 text NOT NULL CHECK(checksum_sha256 ~ '^[0-9a-f]{64}$'),
            applied_at timestamptz NOT NULL DEFAULT clock_timestamp())`);
          for (const migration of migrations.slice(0, index + 1)) {
            await client.query(migration.sql);
            await client.query("INSERT INTO abos.schema_migrations(migration_id,checksum_sha256) VALUES($1,$2)", [migration.id, migration.checksumSha256]);
          }
          await client.query("COMMIT");
        } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
      });
      f = await db.company({ keepSchema: true });
      j = await db.populate(f);
    });
    after(async () => { await db.close(); });

    test("the upgrade creates no journal, changes no posted row and a second run applies nothing", async () => {
      const before = await fingerprint();
      assert.ok(Number(before.find((r) => r.t === "fundings")?.n) >= 2, "the fixture holds legacy funding");
      assert.ok(Number(before.find((r) => r.t === "settlements")?.n) >= 1, "and a legacy settlement");
      assert.deepEqual(await run(), NEW);
      assert.deepEqual(await fingerprint(), before);
      assert.deepEqual(await run(), []);
      const empty = await db.h.pool.query<{ n: string }>("SELECT (SELECT count(*) FROM abos.loans) + (SELECT count(*) FROM abos.loan_repayments) AS n");
      assert.equal(empty.rows[0]?.n, "0", "nothing was backfilled into the new tables");
    });

    test("legacy funding keeps reporting and reconciling as a loan", async () => {
      const people = await db.call<{ totals: { loans: { outstanding: string }[] }; reconciliation: { loans: { matches: boolean } } }>("finance_shareholder_statement", f.creator, SEPT);
      assert.equal(Number(people.totals.loans[0]?.outstanding), 500);
      assert.equal(people.reconciliation.loans.matches, true);
      const sheet = await db.call<{ validation: { balanced: boolean }; accounts: { accountId: string; group: string; amount: string }[] }>("finance_balance_sheet", f.creator, { asOf: "2026-09-30" });
      assert.equal(sheet.validation.balanced, true);
      assert.deepEqual(sheet.accounts.filter((a) => a.accountId === f.loanLedger).map((a) => [a.group, Number(a.amount)]), [["LOANS", 500]]);
      const summary = await db.call<{ base: { closing: string; loansReceived: string; loanRepayments: string } }>("finance_management_summary", f.creator, SEPT);
      assert.deepEqual([Number(summary.base.closing), Number(summary.base.loansReceived), Number(summary.base.loanRepayments)], [5080, 600, 250]);
    });

    test("legacy funding still drills down, and its reversal stays refused", async () => {
      const detail = await db.call<{ source: { type: string; route: string | null } }>("finance_journal_detail", f.creator, j.loan);
      assert.deepEqual([detail.source.type, detail.source.route], ["TEMPORARY_FUNDING", "/finance/temporary-funding"]);
      await assert.rejects(() => db.call("finance_journal_reversal_direct", f.creator, { journalId: j.loan, reason: "Synthetic legacy reversal", ...keys() }), /cannot be reversed yet/);
    });

    test("a pending legacy record can still finish, and new loans sit beside it without touching it", async () => {
      const safeBefore = await db.h.pool.query<{ source: string }>("SELECT source_type AS source FROM abos.posting_sources WHERE source_type = 'TEMPORARY_FUNDING' AND status = 'ACTIVE' AND compatibility_only");
      assert.equal(safeBefore.rowCount, 1, "still ACTIVE, marked as compatibility only");
      const account = randomUUID();
      await db.h.pool.query(`INSERT INTO abos.ledger_accounts (id,legal_entity_id,account_code,account_name,account_type,control_account_type,posting_allowed,status)
        VALUES ($1,$2,'2599','Synthetic new loans','LIABILITY','LOAN_PAYABLE',true,'ACTIVE')`, [account, f.e]);
      const officer = await db.person(f.world, "Upgrade Officer", ["finance.loan.record", "finance.loan.read", "finance.report.operational.read"]);
      await db.call("finance_loan_record", officer, { lenderType: "COMPANY", lenderName: "Synthetic New Bank", treasuryAccountId: f.usdSafe, amount: "100.00", currencyCode: "USD", businessDate: "2026-09-25", reference: null, note: null, ...keys() });
      const people = await db.call<{ totals: { loans: { outstanding: string }[] }; reconciliation: { loans: { matches: boolean } } }>("finance_shareholder_statement", officer, SEPT);
      assert.equal(Number(people.totals.loans[0]?.outstanding), 600, "500 legacy and 100 new, in one debt total");
      assert.equal(people.reconciliation.loans.matches, true);
    });
  });
}
