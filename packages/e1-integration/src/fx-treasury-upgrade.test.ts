import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before, describe } from "node:test";

import { applyMigrations } from "@abos/database";

import { databaseUrl, loadMigrations, MISSING_DATABASE_MESSAGE, withClusterLock } from "./harness.ts";
import { keys, ReportDatabase, type ReportCompany, type Session } from "./report-world.ts";

/**
 * Upgrading a company at 0063 that already holds AFN movements posted under the old rule, where every outflow left Treasury at its day's
 * value. Production has none, so this history is synthetic. Migration 0064 must leave every posted row exactly as it was. The history is
 * not corrected, because that needs a journal. It stays visible, and each state has a stated rule:
 *
 *   native above zero, value above zero: carries on as an ordinary position, and the next full disposal realizes whatever the old rule left
 *   native zero, a value left:           an orphan. It stays on the statement, and a later inflow adds to it
 *   value of the wrong sign:             money cannot leave until an inflow restores the sign, or someone corrects it
 */
const PREDECESSOR = "0063_v1_realized_fx_loan_settlement";
const NEW = ["0064_v1_fx_treasury_carrying_value", "0065_v1_document_vault"];
const AT_70 = "2026-09-14";
const AT_56 = "2026-09-23";
const AT_40 = "2026-09-24";
const AFTER = "2026-09-25";

type Statement = { statement: { closing: { native: string; base: string }; carryingStatus: string } };

if (databaseUrl() === undefined) {
  test("0064 upgrade over AFN history", () => assert.fail(MISSING_DATABASE_MESSAGE));
} else {
  describe("0064 over AFN history posted under the old rule", () => {
    const db = new ReportDatabase();
    let f: ReportCompany; let officer: Session; let serial = 0;
    let orphan: string; let healthy: string; let inverted: string; let repaidFrom: string; let mixed: string; let orphanExpense: string; let loanId: string; let mixedReceipt: string; let mixedSecond: string;

    const fingerprint = async () => (await db.h.pool.query<{ t: string; n: string; h: string }>(`
      SELECT 'journals' AS t, count(*)::text AS n, md5(COALESCE(string_agg(x::text, '|' ORDER BY x.id), '')) AS h FROM abos.journals x
      UNION ALL SELECT 'lines', count(*)::text, md5(COALESCE(string_agg(x::text, '|' ORDER BY x.id), '')) FROM abos.journal_lines x
      UNION ALL SELECT 'subledger', count(*)::text, md5(COALESCE(string_agg(x::text, '|' ORDER BY x.id), '')) FROM abos.subledger_entries x
      UNION ALL SELECT 'intents', count(*)::text, md5(COALESCE(string_agg(x::text, '|' ORDER BY x.id), '')) FROM abos.posting_intents x
      UNION ALL SELECT 'expenses', count(*)::text, md5(COALESCE(string_agg(x::text, '|' ORDER BY x.id), '')) FROM abos.operational_expenses x
      UNION ALL SELECT 'receipts', count(*)::text, md5(COALESCE(string_agg(x::text, '|' ORDER BY x.id), '')) FROM abos.treasury_cash_receipts x
      UNION ALL SELECT 'repayments', count(*)::text, md5(COALESCE(string_agg(x::text, '|' ORDER BY x.id), '')) FROM abos.loan_repayments x
      UNION ALL SELECT 'conversions', count(*)::text, md5(COALESCE(string_agg(x::text, '|' ORDER BY x.id), '')) FROM abos.fx_conversions x
      UNION ALL SELECT 'accounts', count(*)::text, md5(COALESCE(string_agg(x::text, '|' ORDER BY x.id), '')) FROM abos.ledger_accounts x
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
    const account = async () => {
      const ledgerId = await db.ledger(f.e, `LEGACY-AFN-${++serial}`, "ASSET", "CASH", "AFN");
      return db.treasury(f.world, `Synthetic legacy AFN ${serial}`, "SAFE", "AFN", ledgerId);
    };
    const rate = (day: string, value: string) => db.h.pool.query(`INSERT INTO abos.exchange_rates (id,legal_entity_id,rate_date,rate_source,unit_currency_code,quote_currency_code,rate_value,note,entered_by_user_account_id)
      VALUES ($1,$2,$3,'MARKET','USD','AFN',$4,'Synthetic rate',$5)`, [randomUUID(), f.e, day, value, f.u]);
    const receive = (id: string, amount: string, businessDate: string) => db.call<{ journalId: string }>("treasury_receipt_record", officer, { treasuryAccountId: id, amount, currencyCode: "AFN", businessDate,
      payerBusinessPartyId: null, payerName: "Synthetic legacy payer", revenueLedgerAccountId: f.revenue, reference: null, note: null, ...keys() });
    const spend = (id: string, amount: string, businessDate: string) => db.call<{ expense: { journalId: string } }>("operational_expense_create", officer, { treasuryAccountId: id, expenseCategoryId: f.category,
      payeeBusinessPartyId: null, projectId: null, departmentId: null, costCenterId: null, reference: "LEGACY-EXP", description: "Synthetic legacy expense", note: null, businessDate, originalAmount: amount, currencyCode: "AFN",
      exchangeRateId: null, ...keys() });
    const closing = async (id: string) => {
      const s = (await db.call<Statement>("treasury_account_statement", officer, { accountId: id, asOf: "2026-09-30" })).statement;
      return [Number(s.closing.native), Number(s.closing.base), s.carryingStatus];
    };

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
      officer = await db.person(f.world, "Legacy FX Officer", ["treasury.safe.read", "treasury.receipt.record", "treasury.transfer.record", "treasury.payment.record", "finance.expense.create", "finance.expense.read",
        "finance.report.operational.read", "finance.reversal.direct", "finance.fx-policy.manage", "finance.loan.read", "finance.loan.record", "finance.loan.repay"]);
      await db.call("finance_fx_policy_set", officer, { currencyCode: "AFN", effectiveFrom: "2026-09-01", baseScale: 2, roundingMode: "HALF_UP", fxDifferenceLedgerAccountId: f.fxAccount,
        reason: "Synthetic FX policy decision", expectedVersion: 0, correlationId: randomUUID() });
      await rate(AT_56, "56"); await rate(AT_40, "40"); await rate(AFTER, "50");
      await db.ledger(f.e, "2520", "LIABILITY", "LOAN_PAYABLE");
      await db.ledger(f.e, "4910", "REVENUE", "REALIZED_FX_GAIN");
      await db.ledger(f.e, "5910", "EXPENSE", "REALIZED_FX_LOSS");

      orphan = await account();
      await receive(orphan, "70000.00", AT_70);
      orphanExpense = (await spend(orphan, "70000.00", AT_56)).expense.journalId;
      healthy = await account();
      await receive(healthy, "7000.00", AT_70);
      await spend(healthy, "3500.00", AT_56);
      inverted = await account();
      await receive(inverted, "7000.00", AT_70);
      await spend(inverted, "6000.00", AT_40);
      mixed = await account();
      mixedReceipt = (await receive(mixed, "7000.00", AT_70)).journalId;
      mixedSecond = (await receive(mixed, "3500.00", AT_56)).journalId;
      await spend(mixed, "3500.00", AT_40);
      repaidFrom = await account();
      const loan = await db.call<{ loanId: string }>("finance_loan_record", officer, { lenderType: "COMPANY", lenderName: "Synthetic legacy lender", treasuryAccountId: repaidFrom, currencyCode: "AFN", amount: "7000.00",
        businessDate: AT_70, reference: null, note: null, ...keys() });
      loanId = loan.loanId;
      await db.call("finance_loan_repay", officer, { loanId, treasuryAccountId: repaidFrom, amount: "7000.00", businessDate: AT_56, reference: null, note: null, ...keys() });
    });
    after(async () => { await db.close(); });

    test("the upgrade creates no journal and changes no posted row, and a second run applies nothing", async () => {
      const before = await fingerprint();
      assert.ok(Number(before.find((r) => r.t === "journals")?.n) >= 8, "the fixture holds AFN history");
      assert.deepEqual(await run(), NEW);
      assert.deepEqual(await fingerprint(), before);
      assert.deepEqual(await run(), []);
    });

    test("the history stays as posted, and the statement says what it is", async () => {
      assert.deepEqual(await closing(orphan), [0, -250, "ORPHAN"], "1,000 came in and 1,250 went out under the old rule");
      assert.deepEqual(await closing(healthy), [3500, 37.5, "OK"]);
      assert.deepEqual(await closing(inverted), [1000, -50, "INVERTED"]);
      assert.deepEqual(await closing(repaidFrom), [0, -25, "ORPHAN"], "a loan repaid under 0063 credited the day's value");
      const owed = (await db.call<{ loans: { id: string; outstanding: string; baseOutstanding: string }[] }>("finance_loan_workspace", officer)).loans.find((l) => l.id === loanId);
      assert.deepEqual([Number(owed?.outstanding), Number(owed?.baseOutstanding)], [0, 0], "its liability cleared under 0063 and stays cleared");
    });

    test("every report still balances over that history", async () => {
      const sheet = await db.call<{ validation: { balanced: boolean; difference: string } }>("finance_balance_sheet", officer, { asOf: "2026-09-30" });
      assert.deepEqual([sheet.validation.balanced, Number(sheet.validation.difference)], [true, 0]);
      assert.equal((await db.call<{ balanced: boolean }>("finance_trial_balance", officer, { from: "2026-09-01", to: "2026-09-30" })).balanced, true);
    });

    test("a position that survived carries on, and its next full disposal realizes whatever the old rule left", async () => {
      await spend(healthy, "3500.00", AFTER);
      assert.deepEqual(await closing(healthy), [0, 0, "OK"]);
    });

    test("a value of the wrong sign holds money in until an inflow restores it, and nothing is partly posted", async () => {
      const journals = async () => Number((await db.h.pool.query<{ n: string }>("SELECT count(*)::text AS n FROM abos.journals")).rows[0]?.n);
      const before = await journals();
      await assert.rejects(() => spend(inverted, "500.00", AFTER), /TREASURY_CARRYING_CORRECTION_REQUIRED/);
      await assert.rejects(() => spend(inverted, "1000.00", AFTER), /TREASURY_CARRYING_CORRECTION_REQUIRED/);
      assert.equal(await journals(), before);
      await receive(inverted, "7000.00", AFTER);
      assert.deepEqual(await closing(inverted), [8000, 90, "OK"]);
      await spend(inverted, "8000.00", AFTER);
      assert.deepEqual(await closing(inverted), [0, 0, "OK"]);
    });

    test("an old journal reverses from its own posted lines, and the one reversal the invariant forbids is refused before anything is written", async () => {
      assert.deepEqual(await closing(mixed), [7000, 75, "OK"], "100 and 62.50 in, 87.50 out under the old rule");
      const journals = async () => Number((await db.h.pool.query<{ n: string }>("SELECT count(*)::text AS n FROM abos.journals")).rows[0]?.n);
      const before = await journals();
      await assert.rejects(() => db.call("finance_journal_reversal_direct", officer, { journalId: mixedReceipt, reason: "Synthetic unsafe legacy reversal", ...keys() }), /TREASURY_LATER_MOVEMENT/, "native 0 with minus 25 left");
      assert.equal(await journals(), before);
      await db.call("finance_journal_reversal_direct", officer, { journalId: mixedSecond, reason: "Synthetic safe legacy reversal", ...keys() });
      assert.deepEqual(await closing(mixed), [3500, 12.5, "OK"], "a valid position remains, so the exact inverse proceeds");
    });

    test("an orphan is reversed from its own posted lines, and an inflow adds to one until a full disposal clears it", async () => {
      await db.call("finance_journal_reversal_direct", officer, { journalId: orphanExpense, reason: "Synthetic correction of an old posting", ...keys() });
      assert.deepEqual(await closing(orphan), [70000, 1000, "OK"], "the exact inverse of the 1,250 posted, with no new rate");
      await spend(orphan, "70000.00", AFTER);
      assert.deepEqual(await closing(orphan), [0, 0, "OK"]);
      await receive(repaidFrom, "7000.00", AFTER);
      assert.deepEqual(await closing(repaidFrom), [7000, 115, "OK"], "140 came in on top of the orphan of 25");
      await spend(repaidFrom, "7000.00", AFTER);
      assert.deepEqual(await closing(repaidFrom), [0, 0, "OK"]);
    });
  });
}
