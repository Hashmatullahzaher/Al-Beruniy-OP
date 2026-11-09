import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before, describe } from "node:test";

import {
  accountStatementTable, exportLineCount, ledgerExportFits, ledgerLineCount, reportCsv, safeStatementTable, trialBalanceTable, type AccountStatementView,
  type TreasuryStatementView, type TrialBalanceView
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
      // The person responsible for a Safe reads that Safe's statement without any report permission (0057), so may export it, and only it.
      const keeper = await db.person(f.world, "Safe Keeper", ["treasury.receipt.record"]);
      const keeperId = (await db.h.pool.query<{ id: string }>("SELECT id FROM abos.user_accounts WHERE display_name = 'Synthetic Safe Keeper'")).rows[0]?.id;
      await db.h.pool.query(`INSERT INTO abos.operational_treasury_account_responsibles (legal_entity_id, operational_treasury_account_id, user_account_id, assigned_by_user_account_id)
        VALUES ($1,$2,$3,$4)`, [f.e, f.secondSafe, keeperId, f.u]);
      await db.call("treasury_account_statement", keeper, { accountId: f.secondSafe, ...SEPT });
      const kept = await record(keeper, exportOf({ kind: "SAFE_STATEMENT", accountId: f.secondSafe, rowCount: 1 }));
      assert.equal((await audit(kept.auditId)).actor, keeperId);
      await assert.rejects(() => db.call("treasury_account_statement", keeper, { accountId: f.usdSafe, ...SEPT }));
      await assert.rejects(() => record(keeper, exportOf({ kind: "SAFE_STATEMENT", accountId: f.usdSafe })), DENIED, "another Safe is not theirs");
      await assert.rejects(() => record(keeper, exportOf({ kind: "SAFE_STATEMENT", accountId: randomUUID() })), DENIED, "an unknown id is refused the same way");
      await assert.rejects(() => record(f.nobody, exportOf({ kind: "SAFE_STATEMENT", accountId: randomUUID() })), DENIED);
      await assert.rejects(() => record(keeper, exportOf()), DENIED, "nor is the trial balance");
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

    test("a statement of exactly 5,000 lines is exported whole; one line more is refused, and nothing is recorded for it", async () => {
      // The petty cash has one September movement (the 300.00 transfer on the 13th). 4,999 real receipts on the 25th make exactly 5,000 lines,
      // and one more on the 26th makes 5,001. Each goes through the product's own function on the restricted login.
      const c = f.creator;
      const receive = (count: number, day: string, tag: string) => db.runtime.query(`SELECT count(abos.treasury_receipt_record($1, $2, $3, jsonb_build_object(
        'treasuryAccountId', $4::uuid, 'amount', '1.00', 'currencyCode', 'USD', 'businessDate', $6::text, 'payerBusinessPartyId', NULL, 'payerName', 'Synthetic limit payer',
        'revenueLedgerAccountId', $5::uuid, 'reference', NULL, 'note', NULL, 'idempotencyKey', $7::text || g, 'correlationId', gen_random_uuid())))
        FROM generate_series(1, $8::integer) g`, [c.proof, c.runtimeDigest, c.tokenDigest, f.secondSafe, f.revenue, day, `limit-${tag}-`, count]);
      type Lines = { lines: unknown[] };
      const TO_25 = { from: SEPT.from, to: "2026-09-25" };
      assert.equal((await db.call<Lines>("finance_account_statement", f.reportReader, { accountId: f.secondLedger, ...SEPT })).lines.length, 1);
      await receive(4999, "2026-09-25", "a");

      // Just below the limit: the 25th alone is 4,999 lines.
      const below = await db.call<AccountStatementView>("finance_account_statement", f.reportReader, { accountId: f.secondLedger, from: "2026-09-25", to: "2026-09-25" });
      assert.equal(below.lines.length, 4999);
      // At the limit: the statement answers, the export carries every line, and its audit says 5,000.
      const atLimit = await db.call<AccountStatementView>("finance_account_statement", f.reportReader, { accountId: f.secondLedger, ...SEPT });
      assert.equal(atLimit.lines.length, 5000);
      const table = accountStatementTable(atLimit, "en");
      assert.equal(exportLineCount(table), 5000);
      assert.equal(reportCsv(table, "en", "x").split("\r\n").filter((line) => line.startsWith("\"2026-09-25\"")).length, 4999);
      const recorded = await record(f.reportReader, exportOf({ kind: "ACCOUNT_STATEMENT", accountId: f.secondLedger, rowCount: exportLineCount(table) }));
      assert.equal((await audit(recorded.auditId)).after.rowCount, 5000);
      const safeAtLimit = await db.call<TreasuryStatementView>("treasury_account_statement", f.safeReader, { accountId: f.secondSafe, ...SEPT });
      assert.equal(safeAtLimit.statement?.lines.length, 5000);

      // One line above: the reports themselves refuse, so the export has nothing to render and records nothing.
      await receive(1, "2026-09-26", "b");
      const before = await exports();
      await assert.rejects(() => db.call("finance_account_statement", f.reportReader, { accountId: f.secondLedger, ...SEPT }), /5001 lines; choose a shorter period/);
      await assert.rejects(() => db.call("treasury_account_statement", f.safeReader, { accountId: f.secondSafe, ...SEPT }), /5001 lines; choose a shorter period/);
      await assert.rejects(() => record(f.reportReader, exportOf({ kind: "ACCOUNT_STATEMENT", accountId: f.secondLedger, rowCount: 5001 })), REFUSED,
        "nor can an export over the limit be recorded");
      assert.equal(await exports(), before);
      // A shorter period is still served, as the refusal tells the reader.
      assert.equal((await db.call<Lines>("finance_account_statement", f.reportReader, { accountId: f.secondLedger, ...TO_25 })).lines.length, 5000);

      // The General Ledger has no limit of its own (it pages), so the export applies the statements' limit to the whole range, from the first page's totals.
      type Page = { value: { totals: { currency: string; debits: string; credits: string; lineCount: string }[] | null } };
      const totalsOf = async (range: { from: string; to: string }, accountId: string | null) => (await db.runtime.query<Page>(
        "SELECT abos.finance_general_ledger_page($1, $2::date, $3::date, $4::uuid, NULL, 100) AS value", [f.reportReader.token, range.from, range.to, accountId])).rows[0]?.value.totals ?? null;
      assert.equal(ledgerLineCount(await totalsOf(SEPT, f.secondLedger)), 5001, "the ledger account has the same 5,001 lines the statement counted");
      assert.equal(ledgerExportFits(await totalsOf(SEPT, f.secondLedger)), false);
      assert.equal(ledgerLineCount(await totalsOf(TO_25, f.secondLedger)), 5000);
      assert.equal(ledgerExportFits(await totalsOf(TO_25, f.secondLedger)), true);
      assert.equal(ledgerExportFits(await totalsOf(SEPT, null)), false, "the whole September ledger is now far over the limit");
      assert.equal(ledgerExportFits(await totalsOf({ from: SEPT.from, to: "2026-09-24" }, null)), true);
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
