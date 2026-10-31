import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import test, { after, before, describe } from "node:test";
import pg from "pg";

import { PostgresExecutor } from "@abos/persistence";
import { identityDatabaseProof, SandboxAuthenticator } from "@abos/sandbox-auth";

import { addSyntheticSaraf, grant } from "./currency-fixtures.ts";
import { databaseUrl, MISSING_DATABASE_MESSAGE, openHarness, resetSchema, type Harness } from "./harness.ts";
import { issueOperationalSession } from "./operational-session.ts";
import { seedSyntheticWorld, SYNTHETIC_AUTH_CONFIGURATION, type SyntheticWorld } from "./synthetic-world.ts";

/**
 * Migration 0051 (Slice 6): the FX policy per company and currency, one exact conversion for every lane, and AFN
 * operational posting through the one posting kernel and the one Treasury model. Synthetic data only.
 * Rates are entered as 1 USD = N AFN (unit USD, quote AFN), the way the daily market rate is recorded.
 */

const MARKER = SYNTHETIC_AUTH_CONFIGURATION.runtimeMarker;
const MONEY = ["treasury.safe.read", "treasury.receipt.record", "treasury.transfer.record", "treasury.payment.record",
  "treasury.opening-balance.record", "finance.expense.create", "finance.expense.read", "finance.report.operational.read",
  "finance.fx-policy.manage", "finance.reversal.direct"];
const POLICIES = ["OTHER_INCOME", "TREASURY_TRANSFER", "SUPPLIER_PAYMENT", "SALARY_PAYMENT", "EXPENSE"];

type Session = { proof: string; runtimeDigest: string; tokenDigest: string };
type Posted = { movementId: string; journalId: string; reference: string; currencyCode: string; amount: string; baseAmount: string;
  fxConversionId: string | null; status: string; replayed: boolean };
type Fixture = { world: SyntheticWorld; e: string; actor: Session; afnSafe: string; afnLedger: string; afnSaraf: string; usdSafe: string;
  revenue: string; payable: string; equity: string; category: string; fxAccount: string | null; party: string };

function args(token: string): Session {
  return { proof: identityDatabaseProof(SYNTHETIC_AUTH_CONFIGURATION.signingSecret),
    runtimeDigest: createHash("sha256").update(token).digest("hex"),
    tokenDigest: createHmac("sha256", SYNTHETIC_AUTH_CONFIGURATION.signingSecret).update(token).digest("hex") };
}

if (databaseUrl() === undefined) {
  test("0051 FX policy and AFN posting", () => assert.fail(MISSING_DATABASE_MESSAGE));
} else {
  describe("0051: FX policy and AFN operational posting", () => {
    let h: Harness; let runtime: PostgresExecutor; let runtimePool: pg.Pool;
    const login = `abos_fx_${randomUUID().replaceAll("-", "")}`;

    before(async () => {
      const target = new URL(databaseUrl() ?? "");
      assert.notEqual(target.port, "55432", "preserved runtime PostgreSQL is forbidden");
      assert.notEqual(decodeURIComponent(target.pathname.slice(1)), "abos_v1_local_review");
      h = await openHarness(MARKER);
      await resetSchema(h.pool);
      const password = `disposable-${randomUUID()}`;
      await h.pool.query(`CREATE ROLE ${login} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${password}'`);
      const url = new URL(databaseUrl() ?? ""); url.username = login; url.password = password;
      runtimePool = new pg.Pool({ connectionString: url.toString(), max: 6 });
      runtime = new PostgresExecutor(runtimePool, { runtimeMarker: MARKER });
    });
    after(async () => {
      await runtimePool?.end();
      if (h !== undefined) { await resetSchema(h.pool); await h.pool.query(`DROP ROLE IF EXISTS ${login}`); await h.close(); }
    });

    const ledger = async (entity: string, code: string, type: string, control: string | null, currency = "USD") => {
      const id = randomUUID();
      await h.pool.query(`INSERT INTO abos.ledger_accounts (id,legal_entity_id,account_code,account_name,account_type,control_account_type,posting_allowed,account_currency_code,status)
        VALUES ($1,$2,$3,$4,$5,$6,true,$7,'ACTIVE')`, [id, entity, code, `Synthetic ${code}`, type, control, currency]);
      return id;
    };
    const treasury = async (entity: string, user: string, name: string, type: string, currency: string, ledgerId: string, saraf: string | null = null) => {
      const id = randomUUID();
      await h.pool.query(`INSERT INTO abos.operational_treasury_accounts (id,legal_entity_id,name_en,account_type,currency_code,ledger_account_id,saraf_business_party_id,
        status,version,created_by_user_account_id,last_changed_by_user_account_id) VALUES($1,$2,$3,$4,$5,$6,$7,'ACTIVE',1,$8,$8)`,
      [id, entity, name, type, currency, ledgerId, saraf, user]);
      return id;
    };
    const rate = async (entity: string, user: string, day: string, value: string, unit = "USD", quote = "AFN", source = "MARKET", saraf: string | null = null) => {
      const id = randomUUID();
      await h.pool.query(`INSERT INTO abos.exchange_rates (id,legal_entity_id,rate_date,rate_source,saraf_business_party_id,unit_currency_code,quote_currency_code,
        rate_value,note,entered_by_user_account_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'Synthetic rate',$9)`, [id, entity, day, source, saraf, unit, quote, value, user]);
      return id;
    };

    async function fixture(options: { fxAccount?: boolean } = {}): Promise<Fixture> {
      await resetSchema(h.pool);
      await h.pool.query(`GRANT abos_e1_runtime TO ${login}`);
      const world = await seedSyntheticWorld(h.executor);
      await h.pool.query("DELETE FROM abos.sandbox_legal_entity_scopes");
      await h.pool.query("DELETE FROM abos.sandbox_authorizations");
      await grant(h.executor, world, world.intentCreatorId, MONEY);
      const e = world.legalEntityId; const u = world.bootstrapUserId;
      const afnLedger = await ledger(e, "SYN-CASH-AFN", "ASSET", "CASH", "AFN");
      const afnSafe = await treasury(e, u, "Synthetic AFN Safe", "SAFE", "AFN", afnLedger);
      const sarafParty = await addSyntheticSaraf(h.executor, world);
      const afnSaraf = await treasury(e, u, "Synthetic AFN Saraf", "SARAF", "AFN", await ledger(e, "SYN-SARAF-AFN", "ASSET", "SARAF", "AFN"), sarafParty);
      const usdSafe = await treasury(e, u, "Synthetic USD Safe", "SAFE", "USD", world.cashLedgerAccountId);
      const expenseAccount = await ledger(e, "SYN-FX-EXP", "EXPENSE", null);
      const category = randomUUID();
      await h.pool.query(`INSERT INTO abos.operational_expense_categories (id,legal_entity_id,category_code,name_en,ledger_account_id,status,version,created_by_user_account_id,last_changed_by_user_account_id)
        VALUES($1,$2,'SYN-FX','Synthetic site supplies',$3,'ACTIVE',1,$4,$4)`, [category, e, expenseAccount, u]);
      for (const workflow of POLICIES) {
        await h.pool.query(`INSERT INTO abos.finance_workflow_policy_versions (id,legal_entity_id,workflow_type,version,approval_required,configured_by_user_account_id,change_reason)
          VALUES($1,$2,$3,1,false,$4,'Synthetic Simple Mode setting')`, [randomUUID(), e, workflow, u]);
      }
      for (const day of ["2026-09-10", "2026-09-11", "2026-09-12"]) await rate(e, u, day, "70");
      const fxAccount = options.fxAccount === false ? null : await ledger(e, "SYN-FX-DIFF", "EXPENSE", "FX_DIFFERENCE");
      const actor = args((await issueOperationalSession(h, world.intentCreatorId, e)).token);
      return { world, e, actor, afnSafe, afnLedger, afnSaraf, usdSafe, revenue: await ledger(e, "SYN-FX-INC", "REVENUE", null),
        payable: await ledger(e, "SYN-FX-PAY", "LIABILITY", null), equity: await ledger(e, "SYN-FX-OBE", "EQUITY", "OPENING_BALANCE_EQUITY"),
        category, fxAccount, party: world.businessPartyId };
    }
    async function call<T>(name: string, s: Session, payload?: object): Promise<T> {
      const result = payload === undefined
        ? await runtime.query<{ value: T }>(`SELECT abos.${name}($1,$2,$3) AS value`, [s.proof, s.runtimeDigest, s.tokenDigest])
        : await runtime.query<{ value: T }>(`SELECT abos.${name}($1,$2,$3,$4::jsonb) AS value`, [s.proof, s.runtimeDigest, s.tokenDigest, JSON.stringify(payload)]);
      assert.ok(result.rows[0]); return result.rows[0].value;
    }
    const keys = () => ({ idempotencyKey: `fx-${randomUUID()}`, correlationId: randomUUID() });
    const receive = (f: Fixture, amount: string, extra: object = {}, s = f.actor) => call<Posted>("treasury_receipt_record", s, {
      treasuryAccountId: f.afnSafe, amount, currencyCode: "AFN", businessDate: "2026-09-10", payerBusinessPartyId: null,
      payerName: "Synthetic AFN customer", revenueLedgerAccountId: f.revenue, reference: null, note: null, ...keys(), ...extra });
    const pay = (f: Fixture, amount: string, extra: object = {}) => call<Posted>("treasury_payment_record", f.actor, {
      treasuryAccountId: f.afnSafe, paymentKind: "SUPPLIER", payeeBusinessPartyId: null, payeeName: "Synthetic AFN supplier",
      payableLedgerAccountId: f.payable, amount, currencyCode: "AFN", businessDate: "2026-09-12", reference: null, note: null, ...keys(), ...extra });
    const transfer = (f: Fixture, amount: string, extra: object = {}) => call<Posted>("treasury_transfer_record", f.actor, {
      sourceTreasuryAccountId: f.afnSafe, destinationTreasuryAccountId: f.afnSaraf, amount, currencyCode: "AFN",
      businessDate: "2026-09-11", reference: null, note: null, ...keys(), ...extra });
    const expense = (f: Fixture, amount: string, extra: object = {}) => call<{ expense: { id: string; journalId: string; baseAmount: string } }>(
      "operational_expense_create", f.actor, { treasuryAccountId: f.afnSafe, expenseCategoryId: f.category, payeeBusinessPartyId: null,
        projectId: null, departmentId: null, costCenterId: null, reference: "FX-EXP", description: "Synthetic AFN site supplies", note: null,
        businessDate: "2026-09-11", originalAmount: amount, currencyCode: "AFN", exchangeRateId: null, ...keys(), ...extra });
    const setPolicy = (f: Pick<Fixture, "actor" | "fxAccount">, extra: object) => call<{ versionId: string; version: number }>("finance_fx_policy_set", f.actor, {
      currencyCode: "AFN", effectiveFrom: "2026-09-01", baseScale: 2, roundingMode: "HALF_UP", fxDifferenceLedgerAccountId: f.fxAccount,
      reason: "Synthetic FX policy decision", expectedVersion: 0, correlationId: randomUUID(), ...extra });
    const balance = async (f: Fixture, account: string) => (await h.pool.query<{ book: string; opening: string }>(
      "SELECT book_balance::text AS book, opening_balance::text AS opening FROM abos.treasury_account_balances($1,NULL,$2)", [f.e, account])).rows[0];
    const baseBook = async (f: Fixture, account: string) => (await h.pool.query<{ b: string }>(`SELECT COALESCE(sum(e.base_amount),0)::text AS b
      FROM abos.subledger_entries e JOIN abos.journal_lines l ON l.id = e.journal_line_id JOIN abos.journals j ON j.id = l.journal_id AND j.status = 'POSTED'
      WHERE e.operational_treasury_account_id = $1`, [account])).rows[0]?.b;
    const linesOf = async (journal: string) => (await h.pool.query(`SELECT l.line_number AS n, l.original_amount::text AS native, l.original_currency_code AS cur,
        l.base_debit::text AS dr, l.base_credit::text AS cr, l.conversion_snapshot_reference AS snap, e.original_amount::text AS sub_native, e.base_amount::text AS sub_base
      FROM abos.journal_lines l LEFT JOIN abos.subledger_entries e ON e.journal_line_id = l.id WHERE l.journal_id = $1 ORDER BY l.line_number`, [journal])).rows;
    const conversion = async (id: string) => (await h.pool.query(`SELECT source_type, original_amount::text AS native, original_currency_code AS cur,
        exact_base_amount::text AS exact, base_amount::text AS base, rounding_difference::text AS diff, rounding_mode AS mode, base_scale AS scale,
        fx_policy_version_id AS policy, fx_difference_ledger_account_id AS fx, exchange_rate_snapshot_id AS snapshot FROM abos.fx_conversions WHERE id = $1`, [id])).rows[0];
    const counts = async () => (await h.pool.query<{ v: string }>(`SELECT (SELECT count(*) FROM abos.journals)||'/'||(SELECT count(*) FROM abos.fx_conversions)||'/'||
      (SELECT count(*) FROM abos.exchange_rate_snapshots)||'/'||(SELECT count(*) FROM abos.treasury_cash_receipts)||'/'||(SELECT count(*) FROM abos.treasury_payments) AS v`)).rows[0]?.v;

    test("an AFN receipt keeps the native AFN amount, posts USD at the day's rate and freezes the rate snapshot", async () => {
      const f = await fixture();
      const r = await receive(f, "7000.00");
      assert.deepEqual([r.status, r.currencyCode, r.amount, r.baseAmount], ["POSTED", "AFN", "7000.00", "100.00"]);
      const c = await conversion(r.fxConversionId as string);
      assert.deepEqual([c.source_type, c.native, c.cur, c.exact, c.base, c.diff, c.mode, c.scale, c.policy, c.fx],
        ["CASH_RECEIPT", "7000.00", "AFN", "100.00000000000000000000", "100.00", "0.00000000000000000000", "HALF_UP", 2, null, f.fxAccount]);
      assert.deepEqual(await linesOf(r.journalId), [
        { n: 1, native: "7000.00", cur: "AFN", dr: "100.00", cr: "0", snap: c.snapshot, sub_native: "7000.00", sub_base: "100.00" },
        { n: 2, native: "7000.00", cur: "AFN", dr: "0", cr: "100.00", snap: c.snapshot, sub_native: null, sub_base: null }]);
      const intent = (await h.pool.query("SELECT original_amount::text AS a, base_amount::text AS b, conversion_snapshot_reference AS s FROM abos.posting_intents WHERE source_id = $1",
        [r.movementId])).rows[0];
      assert.deepEqual(intent, { a: "7000.00", b: "100.00", s: c.snapshot });
      const snapshot = (await h.pool.query("SELECT source_type, source_id, rate_value::text AS rate, exchange_rate_id AS id FROM abos.exchange_rate_snapshots WHERE id = $1",
        [c.snapshot])).rows[0];
      assert.deepEqual([snapshot.source_type, snapshot.source_id, snapshot.rate], ["CASH_RECEIPT", r.movementId, "70"]);
      // A later correction of the day's rate changes nothing that was posted; snapshots and conversions are immutable.
      await h.pool.query(`INSERT INTO abos.exchange_rates (id,legal_entity_id,rate_date,rate_source,unit_currency_code,quote_currency_code,rate_value,
        supersedes_exchange_rate_id,correction_reason,entered_by_user_account_id) VALUES ($1,$2,'2026-09-10','MARKET','USD','AFN',71,$3,'Synthetic correction',$4)`,
      [randomUUID(), f.e, snapshot.id, f.world.bootstrapUserId]);
      assert.equal((await conversion(r.fxConversionId as string)).base, "100.00");
      await assert.rejects(() => h.pool.query("UPDATE abos.fx_conversions SET base_amount = 1 WHERE id = $1", [r.fxConversionId]), /immutable/);
      await assert.rejects(() => h.pool.query("DELETE FROM abos.fx_conversions"), /immutable/);
      assert.deepEqual(await balance(f, f.afnSafe), { book: "7000.00", opening: "0" }, "the Safe holds its native AFN balance");
      assert.equal(await baseBook(f, f.afnSafe), "100.00");
      const ws = await call<{ safes: { id: string; currencyCode: string; balance: { book: string; baseBook: string } }[] }>("treasury_safes_workspace", f.actor);
      assert.deepEqual(ws.safes.find((s) => s.id === f.afnSafe)?.balance && { book: ws.safes.find((s) => s.id === f.afnSafe)?.balance.book,
        baseBook: ws.safes.find((s) => s.id === f.afnSafe)?.balance.baseBook }, { book: "7000.00", baseBook: "100.00" });
    });

    test("rounding: HALF_UP by default (a half rounds up), exact-only and scale policies, too-small amounts and direct-quoted rates", async () => {
      const f = await fixture();
      const u = f.world.bootstrapUserId;
      await rate(f.e, u, "2026-09-13", "8");
      const half = await receive(f, "1.00", { businessDate: "2026-09-13" });
      assert.equal(half.baseAmount, "0.13", "1 AFN at 8 AFN per USD is 0.125, which rounds half up to 0.13");
      const hc = await conversion(half.fxConversionId as string);
      assert.deepEqual([hc.exact, hc.base, hc.diff], ["0.12500000000000000000", "0.13", "0.00500000000000000000"]);
      const odd = await receive(f, "1000.00");
      assert.equal(odd.baseAmount, "14.29", "1000 AFN at 70 is 14.285714…, 14.29");
      // EXACT_ONLY from the 14th: an inexact result is refused before anything is written; an exact one posts with that version.
      for (const day of ["2026-09-14", "2026-09-15"]) await rate(f.e, u, day, "70");
      const exactOnly = await setPolicy(f, { effectiveFrom: "2026-09-14", roundingMode: "EXACT_ONLY" });
      const before = await counts();
      await assert.rejects(() => receive(f, "1000.00", { businessDate: "2026-09-14" }), /not exact to 2 decimal places at this rate, and the AFN FX policy is exact-only/);
      assert.equal(await counts(), before, "a refused conversion writes nothing");
      const exact = await receive(f, "7000.00", { businessDate: "2026-09-14" });
      assert.equal((await conversion(exact.fxConversionId as string)).policy, exactOnly.versionId);
      assert.equal((await receive(f, "1000.00", { businessDate: "2026-09-12" })).baseAmount, "14.29", "an earlier day keeps the default policy");
      // Scale 0 from the 15th; an amount that rounds to zero is refused.
      await setPolicy(f, { effectiveFrom: "2026-09-15", baseScale: 0, expectedVersion: 1 });
      assert.equal((await receive(f, "1000.00", { businessDate: "2026-09-15" })).baseAmount, "14");
      await assert.rejects(() => receive(f, "0.10", { businessDate: "2026-09-15" }), /too small to convert: it rounds to zero USD/);
      // A rate entered the other way round (1 AFN = 0.0143 USD) converts by multiplication.
      await rate(f.e, u, "2026-09-16", "0.0143", "AFN", "USD");
      await setPolicy(f, { effectiveFrom: "2026-09-16", expectedVersion: 2 });
      assert.equal((await receive(f, "7000.00", { businessDate: "2026-09-16" })).baseAmount, "100.10");
      const history = await call<{ currencies: { currencyCode: string; versions: { version: number; roundingMode: string; baseScale: number }[] }[] }>(
        "finance_fx_policy_workspace", f.actor);
      assert.deepEqual(history.currencies.find((c) => c.currencyCode === "AFN")?.versions.map((v) => [v.version, v.roundingMode, v.baseScale]),
        [[3, "HALF_UP", 2], [2, "HALF_UP", 0], [1, "EXACT_ONLY", 2]], "every version is kept");
      await assert.rejects(() => h.pool.query("UPDATE abos.fx_policy_versions SET base_scale = 3"), /immutable/);
    });

    test("FX difference account: ordinary AFN postings never need it; a difference-producing source would get a clear setup error", async () => {
      // Owner decision of 2026-10-31: one snapshot per event and an exactly balancing journal produce no FX difference.
      const f = await fixture({ fxAccount: false });
      const r = await receive(f, "7000.00");
      assert.equal(r.baseAmount, "100.00");
      assert.equal((await conversion(r.fxConversionId as string)).fx, null, "no FX difference account is recorded when none exists");
      assert.equal((await expense(f, "700.00")).expense.baseAmount, "10.00");
      assert.equal((await pay(f, "700.00")).baseAmount, "10.00");
      assert.equal((await transfer(f, "700.00")).baseAmount, "10.00");
      assert.equal(Number((await h.pool.query("SELECT count(*) FROM abos.ledger_accounts WHERE control_account_type = 'FX_DIFFERENCE'")).rows[0]?.count), 0,
        "no account is created silently");
      const options = await call<{ fx: { currencyCode: string; status: string; fxDifferenceStatus: string }[] }>("treasury_money_options", f.actor);
      assert.deepEqual(options.fx.map((x) => [x.currencyCode, x.status, x.fxDifferenceStatus]), [["AFN", "READY", "MISSING"]]);
      // A future source that produces an FX difference must resolve the account, and is refused clearly without one.
      const requiredFor = () => h.pool.query("SELECT abos.fx_difference_account_for($1, 'AFN', '2026-09-10') AS id", [f.e]);
      await assert.rejects(requiredFor,
        /FX setup: no FX difference account\. Create one active income or expense account in USD with control FX_DIFFERENCE before posting an FX difference in AFN/);
      // The Chart of Accounts accepts the control only on an income or expense account.
      await assert.rejects(() => h.pool.query("SELECT abos.coa_validate('FX-1','Synthetic FX','د','d','ASSET','FX_DIFFERENCE','USD',true,'ACTIVE')"),
        /FX_DIFFERENCE control account cannot have account type ASSET/);
      const first = await ledger(f.e, "SYN-FX-GAIN", "REVENUE", "FX_DIFFERENCE");
      const second = await ledger(f.e, "SYN-FX-LOSS", "EXPENSE", "FX_DIFFERENCE");
      // Several accounts: ordinary postings still record; a difference-producing source needs a policy naming one.
      assert.equal((await conversion((await receive(f, "70.00")).fxConversionId as string)).fx, null);
      await assert.rejects(requiredFor, /FX setup: several active accounts carry control FX_DIFFERENCE; save an FX policy for AFN that names one/);
      // A policy may be saved without an account; when it names one it must be an FX difference account; stale screens are refused.
      await setPolicy({ ...f, fxAccount: null }, { roundingMode: "HALF_UP", baseScale: 2 });
      await assert.rejects(() => setPolicy({ ...f, fxAccount: f.revenue }, { expectedVersion: 1 }),
        /choose an active income or expense account in USD with control FX_DIFFERENCE/);
      await assert.rejects(() => setPolicy({ ...f, fxAccount: second }, {}), /changed by someone else; reload/);
      await assert.rejects(() => setPolicy({ ...f, fxAccount: second }, { expectedVersion: 1, reason: "no" }), /write the reason/);
      await setPolicy({ ...f, fxAccount: second }, { expectedVersion: 1 });
      assert.equal((await conversion((await receive(f, "70.00")).fxConversionId as string)).fx, second);
      assert.equal((await requiredFor()).rows[0]?.id, second);
      assert.equal(Number((await h.pool.query("SELECT count(*) FROM abos.audit_records WHERE action = 'FX_POLICY_SAVED'")).rows[0]?.count), 2);
      // The named account becomes unusable: ordinary postings continue; the difference-producing source is refused, never redirected.
      await h.pool.query("UPDATE abos.ledger_accounts SET status = 'INACTIVE' WHERE id = $1", [second]);
      assert.equal((await conversion((await receive(f, "70.00")).fxConversionId as string)).fx, null);
      await assert.rejects(requiredFor, /FX setup: the FX difference account for AFN must be an active income or expense account in USD/);
      assert.equal(Number((await h.pool.query("SELECT count(*) FROM abos.ledger_accounts WHERE control_account_type = 'FX_DIFFERENCE'")).rows[0]?.count), 2);
      void first;
      // The permission catalogue: the FX policy permission (v14) next to the Slice 5 reversal permissions, all active.
      const catalogue = (await h.pool.query(`SELECT permission_code AS code, catalogue_version AS v, category, availability FROM abos.permission_catalogue
        WHERE permission_code IN ('finance.fx-policy.manage','finance.reversal.direct','finance.reversal.request','finance.reversal.approve') ORDER BY 1`)).rows;
      assert.deepEqual(catalogue.map((row) => [row.code, row.category, row.availability]), [["finance.fx-policy.manage", "FINANCE", "ACTIVE"],
        ["finance.reversal.approve", "FINANCE", "ACTIVE"], ["finance.reversal.direct", "FINANCE", "ACTIVE"], ["finance.reversal.request", "FINANCE", "ACTIVE"]]);
      assert.equal(catalogue.find((row) => row.code === "finance.fx-policy.manage")?.v, 14);
    });

    test("AFN Safes and Saraf accounts receive, hold, pay, transfer and fund expenses; the AFN balance can never go below zero", async () => {
      const f = await fixture();
      await receive(f, "7000.00");
      const spent = await expense(f, "1400.00");
      assert.equal(spent.expense.baseAmount, "20.00");
      const p = await pay(f, "700.00");
      assert.deepEqual([p.currencyCode, p.baseAmount], ["AFN", "10.00"]);
      assert.deepEqual(await linesOf(p.journalId), [
        { n: 1, native: "700.00", cur: "AFN", dr: "10.00", cr: "0", snap: (await conversion(p.fxConversionId as string)).snapshot, sub_native: null, sub_base: null },
        { n: 2, native: "700.00", cur: "AFN", dr: "0", cr: "10.00", snap: (await conversion(p.fxConversionId as string)).snapshot, sub_native: "-700.00", sub_base: "-10.00" }]);
      const t = await transfer(f, "1000.00");
      assert.equal(t.baseAmount, "14.29");
      assert.deepEqual([(await balance(f, f.afnSafe))?.book, (await balance(f, f.afnSaraf))?.book], ["3900.00", "1000.00"]);
      assert.deepEqual([await baseBook(f, f.afnSafe), await baseBook(f, f.afnSaraf)], ["55.71", "14.29"]);
      const before = await counts();
      await assert.rejects(() => pay(f, "3900.01"), /not enough money in Synthetic AFN Safe/);
      await assert.rejects(() => expense(f, "5000.00"), /not enough money in Synthetic AFN Safe/);
      await assert.rejects(() => pay(f, "10.00", { currencyCode: "USD" }), /holds AFN, not USD/);
      await assert.rejects(() => transfer(f, "10.00", { destinationTreasuryAccountId: f.usdSafe }), /holds USD, not AFN/,
        "a transfer between currencies is a currency exchange, not a transfer");
      assert.equal(await counts(), before);
      // A Saraf account may go negative (an amount owed to the Saraf), in AFN as well.
      await pay(f, "1500.00", { treasuryAccountId: f.afnSaraf });
      assert.equal((await balance(f, f.afnSaraf))?.book, "-500.00");
    });

    test("replay returns the first result without a second snapshot; concurrent AFN payments never overdraw the Safe", async () => {
      const f = await fixture();
      const request = keys();
      const first = await receive(f, "7000.00", request);
      const again = await receive(f, "7000.00", request);
      assert.deepEqual([again.replayed, again.movementId, again.fxConversionId], [true, first.movementId, first.fxConversionId]);
      assert.equal(await counts(), "1/1/1/1/0");
      const results = await Promise.allSettled(Array.from({ length: 5 }, () => pay(f, "2000.00")));
      const posted = results.filter((x) => x.status === "fulfilled").length;
      assert.equal(posted, 3, "7000 AFN pays three 2000 AFN payments and refuses the other two");
      for (const x of results) if (x.status === "rejected") assert.match(String(x.reason), /not enough money/);
      assert.equal((await balance(f, f.afnSafe))?.book, "1000.00");
      assert.equal(Number((await h.pool.query("SELECT count(*) FROM abos.fx_conversions WHERE source_type = 'PAYMENT'")).rows[0]?.count), 3,
        "refused payments leave no conversion behind");
    });

    test("a closed month, another company's Safe or rate, and a synthetic session are refused", async () => {
      const f = await fixture();
      await receive(f, "7000.00");
      // Another company's AFN Safe and rate are unusable.
      const other = randomUUID();
      await h.pool.query(`INSERT INTO abos.legal_entities (id, company_id, code, name, base_currency_code, currency_policy_status)
        VALUES ($1,$2,$3,'Synthetic Other Company','USD','APPROVED')`, [other, f.world.companyId, `SFX-${other.slice(0, 8)}`]);
      const otherSafe = await treasury(other, f.world.bootstrapUserId, "Other AFN Safe", "SAFE", "AFN", await ledger(other, "OTH-CASH-AFN", "ASSET", "CASH", "AFN"));
      const otherRate = await rate(other, f.world.bootstrapUserId, "2026-09-10", "70");
      await assert.rejects(() => receive(f, "70.00", { treasuryAccountId: otherSafe }), /not found in this legal entity/);
      await assert.rejects(() => receive(f, "70.00", { exchangeRateId: otherRate }), /not a current USD\/AFN rate for 2026-09-10/);
      // Several current rates for a day need a choice; the chosen Saraf rate is the one snapshotted.
      const sarafParty = (await h.pool.query("SELECT saraf_business_party_id AS p FROM abos.operational_treasury_accounts WHERE id = $1", [f.afnSaraf])).rows[0]?.p;
      await h.pool.query("UPDATE abos.business_party_roles SET effective_from = '2026-01-01' WHERE business_party_id = $1 AND role_code = 'SARAF'", [sarafParty]);
      const sarafRate = await rate(f.e, f.world.bootstrapUserId, "2026-09-10", "72", "USD", "AFN", "SARAF", sarafParty);
      await assert.rejects(() => receive(f, "720.00"), /2 current USD\/AFN rates are recorded for 2026-09-10; choose which rate/);
      assert.equal((await receive(f, "720.00", { exchangeRateId: sarafRate })).baseAmount, "10.00");
      // A synthetic sandbox session cannot post or preview money.
      await h.pool.query(`INSERT INTO abos.sandbox_authorizations(singleton,environment,configuration_state,policy_version_id,
        runtime_marker,authorized_by_user_account_id,authorized_at,expires_at)
        VALUES(true,'test','SYNTHETIC_TEST_ONLY',$1,$2,$3,clock_timestamp(),clock_timestamp()+interval '1 day')`, [f.world.policyVersionId, MARKER, f.world.bootstrapUserId]);
      await h.pool.query("INSERT INTO abos.sandbox_legal_entity_scopes(legal_entity_id,base_currency_code,authorized_by_user_account_id) VALUES($1,'USD',$2)",
        [f.e, f.world.bootstrapUserId]);
      const developer = args((await new SandboxAuthenticator(h.executor, SYNTHETIC_AUTH_CONFIGURATION).issueSession({
        userAccountId: f.world.intentCreatorId as never, legalEntityId: f.e as never })).token);
      await assert.rejects(() => receive(f, "70.00", {}, developer), /operational password session is required|sign in/);
      await assert.rejects(() => call("treasury_fx_preview", developer, { currencyCode: "AFN", businessDate: "2026-09-10" }),
        /operational password session is required|sign in/);
      await assert.rejects(() => call("finance_fx_policy_set", developer, {}), /sign in|missing|password/);
      // A month row left CLOSED (as by the retired 0050 monthly close; the fixture month has no financial year) still
      // refuses an AFN posting dated in it; it is never reopened automatically. Year close is financial-year-close.test.ts.
      await h.executor.query("UPDATE abos.accounting_periods SET status = 'CLOSED', closed_at = clock_timestamp(), closed_by_user_account_id = opened_by_user_account_id WHERE id = $1",
        [f.world.accountingPeriodId]);
      await assert.rejects(() => receive(f, "70.00"), /cannot be reopened automatically|is closed|open accounting period/);
      await assert.rejects(() => pay(f, "70.00"), /cannot be reopened automatically|is closed|open accounting period/);
    });

    test("an AFN opening balance, statements and reports agree in both currencies; a reversal keeps the historical rate", async () => {
      const f = await fixture();
      const opening = await call<{ journalId: string; baseAmount: string; fxConversionId: string }>("treasury_opening_balance_record", f.actor, {
        treasuryAccountId: f.afnSafe, amount: "35000.00", currencyCode: "AFN", asOfDate: "2026-09-10", reference: "OB-AFN", note: null, ...keys() });
      assert.equal(opening.baseAmount, "500.00");
      const r = await receive(f, "7000.00", { businessDate: "2026-09-11" });
      await expense(f, "1400.00");
      await pay(f, "700.00");
      // The reversal posts the exact inverse with the original's accounting amount, not today's rate.
      await rate(f.e, f.world.bootstrapUserId, (await h.pool.query<{ d: string }>("SELECT abos.business_today()::text AS d")).rows[0]?.d as string, "80");
      const reversal = await call<{ reversalJournalId: string }>("finance_journal_reversal_direct", f.actor,
        { journalId: r.journalId, reason: "Synthetic duplicate receipt", ...keys() });
      const reversed = await linesOf(reversal.reversalJournalId);
      assert.deepEqual(reversed.map((l) => [l.n, l.native, l.cur, l.dr, l.cr, l.sub_native, l.sub_base]), [
        [1, "7000.00", "AFN", "0", "100.00", "-7000.00", "-100.00"], [2, "7000.00", "AFN", "100.00", "0", null, null]]);
      // Native statement: 35000 + 7000 - 1400 - 700 - 7000.
      assert.deepEqual(await balance(f, f.afnSafe), { book: "32900.00", opening: "35000.00" });
      assert.equal(await baseBook(f, f.afnSafe), "470.00");
      // The general ledger (accounting currency) agrees with the Safe's accounting book, and every journal balances.
      const gl = (await h.pool.query<{ b: string }>(`SELECT (sum(l.base_debit) - sum(l.base_credit))::text AS b FROM abos.journal_lines l
        JOIN abos.journals j ON j.id = l.journal_id AND j.status = 'POSTED' WHERE l.ledger_account_id = $1`, [f.afnLedger])).rows[0]?.b;
      assert.equal(gl, "470.00");
      const unbalanced = Number((await h.pool.query(`SELECT count(*) FROM (SELECT journal_id FROM abos.journal_lines GROUP BY journal_id
        HAVING sum(base_debit) <> sum(base_credit)) x`)).rows[0]?.count);
      assert.equal(unbalanced, 0);
      // Every non-base posting has exactly one conversion whose accounting amount is the one posted.
      const mismatched = Number((await h.pool.query(`SELECT count(*) FROM abos.posting_intents i WHERE i.original_currency_code = 'AFN'
        AND i.source_type <> 'REVERSAL' AND NOT EXISTS (SELECT 1 FROM abos.fx_conversions c WHERE c.source_id = i.source_id
        AND c.base_amount = i.base_amount AND c.exchange_rate_snapshot_id::text = i.conversion_snapshot_reference)`)).rows[0]?.count);
      assert.equal(mismatched, 0);
      // The preview shows the same figures a posting would use, and writes nothing.
      const before = await counts();
      const preview = await call<{ rates: { rate: string }[]; setup: { status: string }; preview: { base: string } }>("treasury_fx_preview", f.actor,
        { currencyCode: "AFN", businessDate: "2026-09-12", amount: "1000" });
      assert.deepEqual([preview.setup.status, preview.rates.map((x) => x.rate), preview.preview.base], ["READY", ["70"], "14.29"]);
      assert.equal(await counts(), before);
    });
  });
}
