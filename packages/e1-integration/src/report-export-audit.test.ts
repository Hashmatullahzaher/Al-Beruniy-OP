import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before, describe } from "node:test";

import {
  accountStatementTable, exportLineCount, ledgerExportFits, reportCsv, safeStatementTable, trialBalanceTable, type AccountStatementView, type TreasuryStatementView,
  type TrialBalanceView
} from "@abos/contracts";

import { databaseUrl, MISSING_DATABASE_MESSAGE } from "./harness.ts";
import { assertAbsent, ReportDatabase, SEPT, type ReportCompany, type ReportEvents, type Session } from "./report-world.ts";

/**
 * Migration 0068: every report export is an audit event. The application exports only what the report function answered for the same session
 * (the CSV is a rendering of that payload), then records the export here. The audit row holds metadata only.
 */

type Audit = { actor: string | null; entity: string; action: string; entityType: string; entityId: string | null; after: Record<string, unknown>; metadata: Record<string, unknown> };
const REFUSED = /valid export details are required|unknown export fields|unknown report kind/;
const DENIED = /current authority is missing|operational password session|sign in with an active account/;

if (databaseUrl() === undefined) {
  test("0068 report export audit", () => assert.fail(MISSING_DATABASE_MESSAGE));
} else {
  describe("0068: report export audit", () => {
    const db = new ReportDatabase();
    let f: ReportCompany; let events: ReportEvents;

    const record = (s: Session, payload: object) => db.call<{ auditId: string }>("finance_report_export_record", s, payload);
    const exportOf = (overrides: object = {}) => ({ kind: "TRIAL_BALANCE", format: "CSV", language: "en", mode: "RANGE", ...SEPT, rowCount: 3, ...overrides });
    const audit = async (id: string): Promise<Audit> => {
      const row = (await db.h.pool.query<Audit>(`SELECT actor_user_account_id AS actor, legal_entity_id AS entity, action, entity_type AS "entityType", entity_id AS "entityId",
        after_state AS after, metadata FROM abos.audit_records WHERE id = $1`, [id])).rows[0];
      assert.ok(row, "the export is recorded"); return row;
    };
    const exports = async () => Number((await db.h.pool.query<{ n: string }>("SELECT count(*) AS n FROM abos.audit_records WHERE action = 'FINANCE_REPORT_EXPORTED'")).rows[0]?.n);
    const sessionOf = async (s: Session) => (await db.h.pool.query<{ id: string; user: string }>(
      "SELECT id, user_account_id AS user FROM abos.sandbox_sessions WHERE token_sha256 IN ($1, $2)", [s.tokenDigest, s.runtimeDigest])).rows[0];

    before(async () => {
      await db.open();
      f = await db.company();
      events = await db.populate(f);
    });
    after(async () => { await db.close(); });

    test("an export by a Finance report reader is recorded with metadata only: who, which company, which report, which range, how many rows", async () => {
      const view = await db.call<TrialBalanceView>("finance_trial_balance", f.reportReader, SEPT);
      const table = trialBalanceTable(view, "fa");
      const { auditId } = await record(f.reportReader, exportOf({ language: "fa", rowCount: exportLineCount(table), includeZero: false }));
      const row = await audit(auditId);
      const session = await sessionOf(f.reportReader);
      assert.equal(row.action, "FINANCE_REPORT_EXPORTED");
      assert.equal(row.entityType, "FINANCE_REPORT");
      assert.equal(row.entity, f.e, "the company comes from the session");
      assert.equal(row.actor, session?.user, "the person comes from the session");
      assert.deepEqual(row.after, { kind: "TRIAL_BALANCE", format: "CSV", language: "fa", mode: "RANGE", from: SEPT.from, to: SEPT.to, includeZero: false,
        rowCount: exportLineCount(table) });
      assert.deepEqual(row.metadata, { source: "v1-report-export", sessionId: session?.id });
      // Nothing of the report itself: no account, amount, name or reference reaches the audit row.
      const csv = reportCsv(table, "fa", "2026-11-08T00:00:00.000Z");
      assert.ok(csv.includes("SYN-RW-INC"), "the export itself carries the report");
      assertAbsent(row, ["SYN-RW", "Synthetic", "2500", "1000.00", "RW-", view.accounts[0]?.accountName ?? "-", view.totals.periodDebit], "the export audit row");
    });

    test("the audit accepts no free text and no shape it does not know", async () => {
      const before = await exports();
      for (const payload of [exportOf({ description: "Synthetic site supplies" }), exportOf({ rowCount: "3" }), exportOf({ rowCount: 3.5 }), exportOf({ rowCount: -1 }),
        exportOf({ rowCount: 5001 }), exportOf({ format: "XLSX" }), exportOf({ language: "de" }), exportOf({ mode: "ALL" }), exportOf({ kind: "BALANCE_SHEET" }),
        exportOf({ from: "2026-09-30", to: "2026-09-01" }), exportOf({ from: "September" }), exportOf({ accountId: f.revenue }), exportOf({ kind: "ACCOUNT_STATEMENT" }),
        exportOf({ kind: "GENERAL_LEDGER", includeZero: true }), exportOf({ includeZero: "yes" }), exportOf({ accountName: "Synthetic Saraf" })]) {
        await assert.rejects(() => record(f.reportReader, payload), REFUSED, JSON.stringify(payload));
      }
      assert.equal(await exports(), before, "a refused export records nothing");
    });

    test("only someone who may read the report may record its export", async () => {
      const before = await exports();
      await assert.rejects(() => record(f.nobody, exportOf()), DENIED);
      await assert.rejects(() => record(f.capitalReader, exportOf()), DENIED);
      await assert.rejects(() => record(f.safeReader, exportOf()), DENIED, "a Safe reader reads no trial balance");
      await assert.rejects(() => record(f.safeReader, exportOf({ kind: "GENERAL_LEDGER" })), DENIED);
      await assert.rejects(() => record(f.nobody, exportOf({ kind: "SAFE_STATEMENT", accountId: f.usdSafe })), DENIED);
      assert.equal(await exports(), before);
      const safe = await record(f.safeReader, exportOf({ kind: "SAFE_STATEMENT", accountId: f.usdSafe, rowCount: 1 }));
      assert.equal((await audit(safe.auditId)).entityId, f.usdSafe);
    });

    test("an export can only name the session's own company's accounts and periods", async () => {
      const other = randomUUID();
      await db.h.pool.query(`INSERT INTO abos.legal_entities (id, company_id, code, name, base_currency_code, currency_policy_status) VALUES ($1,$2,$3,'Synthetic Export Other','USD','APPROVED')`,
        [other, f.world.companyId, `EXP-${other.slice(0, 8)}`]);
      const foreignLedger = await db.ledger(other, "SYN-EXP-OTHER", "ASSET", "CASH");
      const foreignSafe = await db.treasury({ ...f.world, legalEntityId: other }, "Synthetic foreign Safe", "SAFE", "USD", foreignLedger);
      const before = await exports();
      await assert.rejects(() => record(f.reportReader, exportOf({ kind: "ACCOUNT_STATEMENT", accountId: foreignLedger })), /not found in this legal entity/);
      await assert.rejects(() => record(f.reportReader, exportOf({ kind: "GENERAL_LEDGER", accountId: foreignLedger })), /not found in this legal entity/);
      await assert.rejects(() => record(f.reportReader, exportOf({ kind: "SAFE_STATEMENT", accountId: foreignSafe })), /not found in this legal entity/);
      await assert.rejects(() => record(f.reportReader, exportOf({ kind: "SAFE_STATEMENT", accountId: f.revenue })), /not found in this legal entity/, "a ledger account is not a Safe");
      await assert.rejects(() => record(f.reportReader, exportOf({ periodId: randomUUID() })), /not found in this legal entity/);
      // The report itself refuses the other company's account, so there is nothing to export in the first place.
      await assert.rejects(() => db.call("finance_account_statement", f.reportReader, { accountId: foreignLedger, ...SEPT }), /not found in this legal entity/);
      await assert.rejects(() => db.call("treasury_account_statement", f.reportReader, { accountId: foreignSafe, ...SEPT }));
      assert.equal(await exports(), before);
    });

    test("a restricted reader's export is the masked statement they can see, and its audit holds only the row count", async () => {
      // The report reader has no project scope, so the restricted expense keeps its amount and loses its reference and description.
      const statement = await db.call<AccountStatementView>("finance_account_statement", f.reportReader, { accountId: f.world.cashLedgerAccountId, ...SEPT });
      const table = accountStatementTable(statement, "en");
      const csv = reportCsv(table, "en", "2026-11-08T00:00:00.000Z");
      assert.ok(csv.includes("Restricted movement"));
      assert.ok(csv.includes("50.00"), "the restricted movement's amount stays");
      for (const word of ["RW-SECRET", "Synthetic restricted works", events.restricted]) assert.equal(csv.includes(word), false, `the restricted reader's export must not carry ${word}`);
      assert.equal(exportLineCount(table), statement.lines.length, "every line the screen lists, and no other");
      const { auditId } = await record(f.reportReader, { kind: "ACCOUNT_STATEMENT", format: "CSV", language: "en", mode: "RANGE", ...SEPT, accountId: f.world.cashLedgerAccountId,
        rowCount: exportLineCount(table) });
      assert.deepEqual((await audit(auditId)).after, { kind: "ACCOUNT_STATEMENT", format: "CSV", language: "en", mode: "RANGE", from: SEPT.from, to: SEPT.to,
        accountId: f.world.cashLedgerAccountId, rowCount: statement.lines.length });
      // A Safe statement export from the Safe reader: the same payload, so the same masked text.
      const safe = await db.call<TreasuryStatementView>("treasury_account_statement", f.safeReader, { accountId: f.usdSafe, ...SEPT });
      const safeCsv = reportCsv(safeStatementTable(safe, "en") ?? assert.fail("statement"), "en", "x");
      for (const word of ["RW-SECRET", "Synthetic restricted works"]) assert.equal(safeCsv.includes(word), false, `the Safe reader's export must not carry ${word}`);
    });

    test("a statement over 5,000 lines is refused, so it has no export; the General Ledger export stops at the same limit", async () => {
      // 5,001 real receipts into the petty cash, through the product's own function on the restricted login, in October (the other tests read September).
      const OCT = { from: "2026-10-01", to: "2026-10-31" };
      const c = f.creator;
      await db.runtime.query(`SELECT count(abos.treasury_receipt_record($1, $2, $3, jsonb_build_object('treasuryAccountId', $4::uuid, 'amount', '1.00', 'currencyCode', 'USD',
        'businessDate', '2026-10-05', 'payerBusinessPartyId', NULL, 'payerName', 'Synthetic limit payer', 'revenueLedgerAccountId', $5::uuid, 'reference', NULL, 'note', NULL,
        'idempotencyKey', 'limit-' || g, 'correlationId', gen_random_uuid()))) FROM generate_series(1, 5001) g`, [c.proof, c.runtimeDigest, c.tokenDigest, f.secondSafe, f.revenue]);
      await assert.rejects(() => db.call("finance_account_statement", f.reportReader, { accountId: f.secondLedger, ...OCT }), /5001 lines; choose a shorter period/);
      await assert.rejects(() => db.call("treasury_account_statement", f.safeReader, { accountId: f.secondSafe, ...OCT }), /5001 lines; choose a shorter period/);
      const first = (await db.runtime.query<{ value: { totals: { currency: string; debits: string; credits: string; lineCount: string }[] | null } }>(
        "SELECT abos.finance_general_ledger_page($1, $2::date, $3::date, NULL, NULL, 100) AS value", [f.reportReader.token, OCT.from, OCT.to])).rows[0]?.value;
      assert.equal(first?.totals?.[0]?.lineCount, "10002", "every receipt is two posted lines");
      assert.equal(ledgerExportFits(first?.totals ?? null), false, "the web export refuses this range before reading a second page");
      assert.equal(ledgerExportFits((await db.runtime.query<{ value: { totals: { currency: string; debits: string; credits: string; lineCount: string }[] | null } }>(
        "SELECT abos.finance_general_ledger_page($1, $2::date, $3::date, NULL, NULL, 100) AS value", [f.reportReader.token, SEPT.from, SEPT.to])).rows[0]?.value.totals ?? null), true);
      await assert.rejects(() => record(f.reportReader, exportOf({ kind: "GENERAL_LEDGER", ...OCT, rowCount: 5001 })), REFUSED, "nor can an export over the limit be recorded");
    });

    test("the runtime cannot write, change or remove an audit row itself", async () => {
      const { auditId } = await record(f.reportReader, exportOf());
      await assert.rejects(() => db.runtime.query("INSERT INTO abos.audit_records (id, legal_entity_id, correlation_id, action, entity_type) VALUES ($1,$2,$3,'FINANCE_REPORT_EXPORTED','FINANCE_REPORT')",
        [randomUUID(), f.e, randomUUID()]), /permission denied/);
      await assert.rejects(() => db.runtime.query("UPDATE abos.audit_records SET metadata = '{}'::jsonb WHERE id = $1", [auditId]), /permission denied/);
      await assert.rejects(() => db.runtime.query("DELETE FROM abos.audit_records WHERE id = $1", [auditId]), /permission denied/);
      await assert.rejects(() => db.h.pool.query("UPDATE abos.audit_records SET metadata = '{}'::jsonb WHERE id = $1", [auditId]), /append-only|immutable|not allowed|cannot/i,
        "even the migration owner cannot change an audit row");
    });
  });
}
