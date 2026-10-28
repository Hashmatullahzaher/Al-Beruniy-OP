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
 * Migrations 0047 and 0048: receive cash, transfer and pay against a payable as three posting sources
 * through the posting kernel, and the expense lane's payment kind. One save each; balances from posted
 * movements only; no approval setting can be bypassed.
 */

const MARKER = SYNTHETIC_AUTH_CONFIGURATION.runtimeMarker;
const ALL = ["treasury.safe.read", "treasury.receipt.record", "treasury.transfer.record", "treasury.payment.record",
  "finance.expense.create", "finance.expense.read", "finance.report.operational.read"];
const ENTRY_POINTS = ["abos.treasury_receipt_record(text,text,text,jsonb)", "abos.treasury_transfer_record(text,text,text,jsonb)",
  "abos.treasury_payment_record(text,text,text,jsonb)", "abos.treasury_money_options(text,text,text)"];
const POLICIES = ["OTHER_INCOME", "TREASURY_TRANSFER", "SUPPLIER_PAYMENT", "SALARY_PAYMENT", "EXPENSE"];

type Session = { proof: string; runtimeDigest: string; tokenDigest: string };
type Result = { movementId: string; journalId: string; reference: string; status: string; replayed: boolean };
type Fixture = { world: SyntheticWorld; actor: Session; safe: string; second: string; secondLedger: string; afnSafe: string; saraf: string;
  revenue: string; payableAp: string; payablePlain: string; tfp: string; expenseAccount: string; category: string; party: string };

function args(token: string): Session {
  return { proof: identityDatabaseProof(SYNTHETIC_AUTH_CONFIGURATION.signingSecret),
    runtimeDigest: createHash("sha256").update(token).digest("hex"),
    tokenDigest: createHmac("sha256", SYNTHETIC_AUTH_CONFIGURATION.signingSecret).update(token).digest("hex") };
}

if (databaseUrl() === undefined) {
  test("0047/0048 money movements", () => assert.fail(MISSING_DATABASE_MESSAGE));
} else {
  describe("0047/0048: receive cash, transfer, pay", () => {
    let h: Harness; let runtime: PostgresExecutor; let runtimePool: pg.Pool;
    const login = `abos_money_${randomUUID().replaceAll("-", "")}`;

    before(async () => {
      const target = new URL(databaseUrl() ?? "");
      assert.notEqual(target.port, "55432", "preserved runtime PostgreSQL is forbidden");
      assert.notEqual(decodeURIComponent(target.pathname.slice(1)), "abos_v1_local_review");
      h = await openHarness(MARKER);
      await resetSchema(h.pool);
      const password = `disposable-${randomUUID()}`;
      await h.pool.query(`CREATE ROLE ${login} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${password}'`);
      const url = new URL(databaseUrl() ?? ""); url.username = login; url.password = password;
      runtimePool = new pg.Pool({ connectionString: url.toString(), max: 4 });
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
    const treasury = async (world: SyntheticWorld, name: string, type: string, currency: string, ledgerId: string, saraf: string | null = null) => {
      const id = randomUUID();
      await h.pool.query(`INSERT INTO abos.operational_treasury_accounts (id,legal_entity_id,name_en,account_type,currency_code,ledger_account_id,saraf_business_party_id,
        status,version,created_by_user_account_id,last_changed_by_user_account_id) VALUES($1,$2,$3,$4,$5,$6,$7,'ACTIVE',1,$8,$8)`,
      [id, world.legalEntityId, name, type, currency, ledgerId, saraf, world.bootstrapUserId]);
      return id;
    };
    const policy = async (world: SyntheticWorld, workflow: string, approval: boolean) => {
      const version = Number((await h.pool.query("SELECT COALESCE(max(version),0)+1 AS v FROM abos.finance_workflow_policy_versions WHERE legal_entity_id=$1 AND workflow_type=$2",
        [world.legalEntityId, workflow])).rows[0]?.v);
      await h.pool.query(`INSERT INTO abos.finance_workflow_policy_versions (id,legal_entity_id,workflow_type,version,approval_required,configured_by_user_account_id,change_reason)
        VALUES($1,$2,$3,$4,$5,$6,'Synthetic money-movement policy')`, [randomUUID(), world.legalEntityId, workflow, version, approval, world.bootstrapUserId]);
    };

    async function fixture(options: { policies?: boolean } = {}): Promise<Fixture> {
      await resetSchema(h.pool);
      await h.pool.query(`GRANT abos_e1_runtime TO ${login}`);
      const world = await seedSyntheticWorld(h.executor);
      await h.pool.query("DELETE FROM abos.sandbox_legal_entity_scopes");
      await h.pool.query("DELETE FROM abos.sandbox_authorizations");
      await grant(h.executor, world, world.intentCreatorId, ALL);
      const e = world.legalEntityId;
      const secondLedger = await ledger(e, "SYN-CASH-2", "ASSET", "CASH");
      const safe = await treasury(world, "Synthetic main Safe", "SAFE", "USD", world.cashLedgerAccountId);
      const second = await treasury(world, "Synthetic petty Safe", "PETTY_CASH", "USD", secondLedger);
      const afnSafe = await treasury(world, "Synthetic AFN Safe", "SAFE", "AFN", await ledger(e, "SYN-CASH-AFN", "ASSET", "CASH", "AFN"));
      const sarafParty = await addSyntheticSaraf(h.executor, world);
      const saraf = await treasury(world, "Synthetic Saraf", "SARAF", "USD", await ledger(e, "SYN-SARAF", "ASSET", "SARAF"), sarafParty);
      const revenue = await ledger(e, "SYN-INC", "REVENUE", null);
      const payableAp = await ledger(e, "SYN-AP", "LIABILITY", "AP");
      const payablePlain = await ledger(e, "SYN-SAL-PAY", "LIABILITY", null);
      const tfp = await ledger(e, "SYN-TFP", "LIABILITY", "TEMPORARY_FUNDING_PAYABLE");
      const expenseAccount = await ledger(e, "SYN-EXP", "EXPENSE", null);
      const category = randomUUID();
      await h.pool.query(`INSERT INTO abos.operational_expense_categories (id,legal_entity_id,category_code,name_en,ledger_account_id,status,version,created_by_user_account_id,last_changed_by_user_account_id)
        VALUES($1,$2,'SYN-MM','Synthetic salaries',$3,'ACTIVE',1,$4,$4)`, [category, e, expenseAccount, world.bootstrapUserId]);
      if (options.policies !== false) for (const workflow of POLICIES) await policy(world, workflow, false);
      const actor = args((await issueOperationalSession(h, world.intentCreatorId, e)).token);
      return { world, actor, safe, second, secondLedger, afnSafe, saraf, revenue, payableAp, payablePlain, tfp, expenseAccount, category,
        party: world.businessPartyId };
    }
    async function call<T>(name: string, s: Session, payload?: object): Promise<T> {
      const result = payload === undefined
        ? await runtime.query<{ value: T }>(`SELECT abos.${name}($1,$2,$3) AS value`, [s.proof, s.runtimeDigest, s.tokenDigest])
        : await runtime.query<{ value: T }>(`SELECT abos.${name}($1,$2,$3,$4::jsonb) AS value`, [s.proof, s.runtimeDigest, s.tokenDigest, JSON.stringify(payload)]);
      assert.ok(result.rows[0]); return result.rows[0].value;
    }
    const keys = () => ({ idempotencyKey: `money-${randomUUID()}`, correlationId: randomUUID() });
    const receive = (f: Fixture, extra: object = {}, s = f.actor) => call<Result>("treasury_receipt_record", s, {
      treasuryAccountId: f.safe, amount: "1000.00", currencyCode: "USD", businessDate: "2026-09-10", payerBusinessPartyId: null,
      payerName: "Synthetic walk-in customer", revenueLedgerAccountId: f.revenue, reference: "RCPT-1", note: null, ...keys(), ...extra });
    const transfer = (f: Fixture, extra: object = {}, s = f.actor) => call<Result>("treasury_transfer_record", s, {
      sourceTreasuryAccountId: f.safe, destinationTreasuryAccountId: f.second, amount: "250.00", currencyCode: "USD",
      businessDate: "2026-09-11", reference: null, note: null, ...keys(), ...extra });
    const pay = (f: Fixture, extra: object = {}, s = f.actor) => call<Result>("treasury_payment_record", s, {
      treasuryAccountId: f.safe, paymentKind: "SUPPLIER", payeeBusinessPartyId: f.party, payeeName: null, payableLedgerAccountId: f.payableAp,
      amount: "100.00", currencyCode: "USD", businessDate: "2026-09-12", reference: "INV-77", note: null, ...keys(), ...extra });
    const book = async (f: Fixture, id: string) => (await h.pool.query<{ b: string }>("SELECT book_balance::text AS b FROM abos.treasury_account_balances($1,NULL,$2)",
      [f.world.legalEntityId, id])).rows[0]?.b;
    const lines = async (journal: string) => (await h.pool.query(`SELECT l.line_number AS n, l.ledger_account_id AS ledger, l.base_debit::text AS dr, l.base_credit::text AS cr,
        l.business_party_id AS party, e.subledger_type AS sub, e.operational_treasury_account_id AS safe, e.base_amount::text AS amount
      FROM abos.journal_lines l LEFT JOIN abos.subledger_entries e ON e.journal_line_id = l.id WHERE l.journal_id = $1 ORDER BY l.line_number`, [journal])).rows;
    const counts = async () => (await h.pool.query<{ v: string }>(`SELECT (SELECT count(*) FROM abos.journals)||'/'||(SELECT count(*) FROM abos.treasury_cash_receipts)||'/'||
      (SELECT count(*) FROM abos.treasury_transfers)||'/'||(SELECT count(*) FROM abos.treasury_payments) AS v`)).rows[0]?.v;

    test("receive cash posts Dr the Safe / Cr income with the Safe's inflow, once per request", async () => {
      const f = await fixture();
      const r = await receive(f);
      assert.equal(r.status, "POSTED"); assert.match(r.reference, /^RC-20260910-[0-9A-F]{32}$/);
      assert.deepEqual(await lines(r.journalId), [
        { n: 1, ledger: f.world.cashLedgerAccountId, dr: "1000.00", cr: "0", party: null, sub: "OPERATIONAL_TREASURY", safe: f.safe, amount: "1000.00" },
        { n: 2, ledger: f.revenue, dr: "0", cr: "1000.00", party: null, sub: null, safe: null, amount: null }]);
      assert.equal(await book(f, f.safe), "1000.00");
      const fromParty = await receive(f, { payerBusinessPartyId: f.party, payerName: null, amount: "5" });
      assert.equal((await lines(fromParty.journalId))[1]?.party, f.party, "the income line carries the payer party");
      const request = keys();
      const first = await receive(f, request);
      const again = await receive(f, request);
      assert.equal(again.replayed, true); assert.equal(again.movementId, first.movementId);
      assert.equal(await book(f, f.safe), "2005.00");
      const audit = (await h.pool.query("SELECT count(*)::int AS n FROM abos.audit_records WHERE action='TREASURY_CASH_RECEIPT_POSTED'")).rows[0]?.n;
      const outbox = (await h.pool.query("SELECT count(*)::int AS n FROM abos.outbox_events WHERE event_type='finance.treasury-cash-receipt-posted'")).rows[0]?.n;
      assert.deepEqual([audit, outbox], [3, 3]);
    });

    test("transfer posts Dr destination / Cr source with both Treasury movements, including Saraf, and opposite transfers never deadlock", async () => {
      const f = await fixture();
      await receive(f, { amount: "1000.00" });
      const t = await transfer(f);
      assert.match(t.reference, /^TR-20260911-/);
      assert.deepEqual(await lines(t.journalId), [
        { n: 1, ledger: f.secondLedger, dr: "250.00", cr: "0", party: null, sub: "OPERATIONAL_TREASURY", safe: f.second, amount: "250.00" },
        { n: 2, ledger: f.world.cashLedgerAccountId, dr: "0", cr: "250.00", party: null, sub: "OPERATIONAL_TREASURY", safe: f.safe, amount: "-250.00" }]);
      assert.deepEqual([await book(f, f.safe), await book(f, f.second)], ["750.00", "250.00"]);
      await transfer(f, { destinationTreasuryAccountId: f.saraf, amount: "100" });
      await transfer(f, { sourceTreasuryAccountId: f.saraf, destinationTreasuryAccountId: f.second, amount: "40" });
      assert.deepEqual([await book(f, f.safe), await book(f, f.saraf), await book(f, f.second)], ["650.00", "60", "290.00"]);
      const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => transfer(f, i % 2 === 0
        ? { sourceTreasuryAccountId: f.safe, destinationTreasuryAccountId: f.second, amount: "1" }
        : { sourceTreasuryAccountId: f.second, destinationTreasuryAccountId: f.safe, amount: "1" })));
      assert.deepEqual(results.map((r) => r.status), Array(6).fill("fulfilled"), "opposite transfers serialize without deadlock");
      assert.deepEqual([await book(f, f.safe), await book(f, f.second)], ["650.00", "290.00"]);
    });

    test("pay against a payable posts Dr payable / Cr the Safe; salary follows SALARY_PAYMENT, others SUPPLIER_PAYMENT", async () => {
      const f = await fixture();
      await receive(f, { amount: "500" });
      const p = await pay(f);
      assert.match(p.reference, /^PY-20260912-/);
      assert.deepEqual(await lines(p.journalId), [
        { n: 1, ledger: f.payableAp, dr: "100.00", cr: "0", party: f.party, sub: null, safe: null, amount: null },
        { n: 2, ledger: f.world.cashLedgerAccountId, dr: "0", cr: "100.00", party: null, sub: "OPERATIONAL_TREASURY", safe: f.safe, amount: "-100.00" }]);
      await pay(f, { paymentKind: "SALARY", payeeBusinessPartyId: null, payeeName: "Synthetic employee", payableLedgerAccountId: f.payablePlain, amount: "50" });
      assert.equal(await book(f, f.safe), "350.00");
      const kinds = (await h.pool.query(`SELECT p.payment_kind AS k, v.workflow_type AS w FROM abos.treasury_payments p
        JOIN abos.finance_workflow_policy_versions v ON v.id = p.workflow_policy_version_id ORDER BY p.created_at`)).rows;
      assert.deepEqual(kinds, [{ k: "SUPPLIER", w: "SUPPLIER_PAYMENT" }, { k: "SALARY", w: "SALARY_PAYMENT" }]);
      await policy(f.world, "SALARY_PAYMENT", true);
      await assert.rejects(() => pay(f, { paymentKind: "SALARY", payableLedgerAccountId: f.payablePlain }),
        /the SALARY_PAYMENT setting requires approval, which is not available for this movement yet/);
      await pay(f, { paymentKind: "CONTRACTOR", payableLedgerAccountId: f.payablePlain, amount: "1" });
      await assert.rejects(() => pay(f, { payableLedgerAccountId: f.tfp }), /choose an active payable account/, "temporary-funding payable has its own lane");
      await assert.rejects(() => pay(f, { payableLedgerAccountId: f.expenseAccount }), /choose an active payable account/, "an expense goes through the expense lane");
      await assert.rejects(() => pay(f, { paymentKind: "GIFT" }), /choose what kind of payment this is/);
      await assert.rejects(() => pay(f, { payeeBusinessPartyId: null, payeeName: "Synthetic typed supplier" }),
        /accounts payable needs the person or organization it was owed to/, "accounts payable is kept per supplier");
    });

    test("refusals: wrong account kinds, currencies, dates, inactive or foreign accounts, approval settings - nothing written", async () => {
      // 0049: an unsaved setting is the Simple Mode default and records in one save (money-movements-corrections).
      const f = await fixture({ policies: false });
      const before = await counts();
      for (const workflow of POLICIES) await policy(f.world, workflow, false);
      await policy(f.world, "TREASURY_TRANSFER", true);
      await assert.rejects(() => transfer(f), /the TREASURY_TRANSFER setting requires approval/);
      await policy(f.world, "TREASURY_TRANSFER", false);
      await assert.rejects(() => receive(f, { revenueLedgerAccountId: f.expenseAccount }), /choose an active income account/);
      await assert.rejects(() => receive(f, { payerName: null }), /name who the money came from or went to/);
      await assert.rejects(() => receive(f, { surprise: 1 }), /unknown movement fields: surprise/);
      await assert.rejects(() => receive(f, { amount: "1e3" }), /positive|decimal/i);
      await assert.rejects(() => receive(f, { treasuryAccountId: "nope" }), /choose a valid treasuryAccountId/);
      const { rows: [{ tomorrow }] } = await h.pool.query("SELECT (abos.business_today() + 1)::text AS tomorrow");
      await assert.rejects(() => receive(f, { businessDate: tomorrow }), /a movement cannot be dated after today/);
      await assert.rejects(() => receive(f, { treasuryAccountId: f.afnSafe, currencyCode: "AFN" }), /approved accounting currency only/);
      await assert.rejects(() => transfer(f, { destinationTreasuryAccountId: f.afnSafe }), /holds AFN, not USD/);
      await assert.rejects(() => transfer(f, { destinationTreasuryAccountId: f.safe }), /a transfer needs two different accounts/);
      await assert.rejects(() => receive(f, { businessDate: "2026-07-05" }), /no accounting period covers 2026-07-05/);
      await h.pool.query("UPDATE abos.operational_treasury_accounts SET status='INACTIVE', version=version+1, last_changed_at=clock_timestamp() WHERE id=$1", [f.second]);
      await assert.rejects(() => transfer(f), /is not active/);
      const other = await seedSyntheticWorld(h.executor, { withoutSandboxAuthorization: true });
      const foreign = await treasury(other, "Foreign Safe", "SAFE", "USD", other.cashLedgerAccountId);
      await assert.rejects(() => receive(f, { treasuryAccountId: foreign }), /was not found in this legal entity/);
      assert.equal(await counts(), before, "nothing was written");
    });

    test("an expense paid as salary follows SALARY_PAYMENT; other kinds and none follow their settings; the kind is immutable", async () => {
      const f = await fixture();
      await receive(f, { amount: "500.00", businessDate: "2026-09-10" });
      const expense = (extra: object) => call<{ expense: { id: string; status: string; paymentKind?: string } }>("operational_expense_create", f.actor, {
        treasuryAccountId: f.safe, expenseCategoryId: f.category, payeeBusinessPartyId: null, projectId: null, departmentId: null, costCenterId: null,
        reference: `SAL-${randomUUID().slice(0, 6)}`, description: "Synthetic salary", note: null, businessDate: "2026-09-13", originalAmount: "30.00",
        currencyCode: "USD", exchangeRateId: null, ...keys(), ...extra });
      const plain = await expense({});
      // Without a kind the expense reads exactly as before 0048: no paymentKind key at all.
      assert.equal(plain.expense.status, "POSTED");
      assert.equal("paymentKind" in plain.expense, false);
      await policy(f.world, "SALARY_PAYMENT", true);
      const salary = await expense({ paymentKind: "SALARY" });
      assert.deepEqual([salary.expense.status, salary.expense.paymentKind], ["PENDING_APPROVAL", "SALARY"],
        "a salary recorded as an expense waits for the salary approval instead of posting under the expense setting");
      const supplier = await expense({ paymentKind: "SUPPLIER" });
      assert.deepEqual([supplier.expense.status, supplier.expense.paymentKind], ["POSTED", "SUPPLIER"]);
      await policy(f.world, "EXPENSE", true);
      assert.equal((await expense({ paymentKind: "OTHER" })).expense.status, "PENDING_APPROVAL", "OTHER follows the expense setting");
      await assert.rejects(() => expense({ paymentKind: "GIFT" }), /complete valid expense details are required/);
      const routes = (await h.pool.query(`SELECT e.payment_kind AS k, v.workflow_type AS w FROM abos.operational_expenses e
        JOIN abos.finance_workflow_policy_versions v ON v.id = e.workflow_policy_version_id ORDER BY e.created_at`)).rows;
      // 0049: the stored route is the deciding setting. Salary approval ON decides the salary expense; with
      // the EXPENSE and supplier settings both OFF, the EXPENSE setting is the one referenced.
      assert.deepEqual(routes.map((r) => [r.k, r.w]), [[null, "EXPENSE"], ["SALARY", "SALARY_PAYMENT"], ["SUPPLIER", "EXPENSE"], ["OTHER", "EXPENSE"]]);
      await assert.rejects(() => h.pool.query("UPDATE abos.operational_expenses SET payment_kind='OTHER', version=version+1, updated_at=clock_timestamp() WHERE id=$1",
        [salary.expense.id]), /accounting identity of an operational expense cannot change/);
    });

    test("authority, options and privileges", async () => {
      const f = await fixture();
      const options = await call<{ canReceive: boolean; settings: Record<string, string>; incomeAccounts: { id: string }[]; payableAccounts: { id: string }[];
        treasuryAccounts: { id: string }[] }>("treasury_money_options", f.actor);
      assert.equal(options.canReceive, true);
      assert.deepEqual(options.settings, { OTHER_INCOME: "READY", SALARY_PAYMENT: "READY", SUPPLIER_PAYMENT: "READY", TREASURY_TRANSFER: "READY" });
      assert.deepEqual(options.incomeAccounts.map((a) => a.id), [f.revenue]);
      assert.deepEqual(options.payableAccounts.map((a) => a.id).sort(), [f.payableAp, f.payablePlain].sort());
      assert.deepEqual(Object.fromEntries((options.payableAccounts as { id: string; requiresParty?: boolean }[]).map((a) => [a.id, a.requiresParty])),
        { [f.payableAp]: true, [f.payablePlain]: false });
      assert.equal(options.treasuryAccounts.length, 4);
      const plain = args((await issueOperationalSession(h, f.world.approverId, f.world.legalEntityId)).token);
      await assert.rejects(() => receive(f, {}, plain), /current authority is missing treasury\.receipt\.record/);
      await assert.rejects(() => transfer(f, {}, plain), /current authority is missing treasury\.transfer\.record/);
      await assert.rejects(() => pay(f, {}, plain), /current authority is missing treasury\.payment\.record/);
      await assert.rejects(() => call("treasury_money_options", plain), /current authority is missing/);
      await h.pool.query(`INSERT INTO abos.sandbox_authorizations(singleton,environment,configuration_state,policy_version_id,runtime_marker,authorized_by_user_account_id,authorized_at,expires_at)
        VALUES(true,'test','SYNTHETIC_TEST_ONLY',$1,$2,$3,clock_timestamp(),clock_timestamp()+interval '1 day')`, [f.world.policyVersionId, MARKER, f.world.bootstrapUserId]);
      await h.pool.query("INSERT INTO abos.sandbox_legal_entity_scopes(legal_entity_id,base_currency_code,authorized_by_user_account_id) VALUES($1,'USD',$2)", [f.world.legalEntityId, f.world.bootstrapUserId]);
      const developer = args((await new SandboxAuthenticator(h.executor, SYNTHETIC_AUTH_CONFIGURATION).issueSession({
        userAccountId: f.world.intentCreatorId as never, legalEntityId: f.world.legalEntityId as never })).token);
      await assert.rejects(() => receive(f, {}, developer), /operational password session is required|sign in/);
      for (const routine of ENTRY_POINTS) {
        const row = (await h.pool.query<{ owner: string; secdef: boolean; pub: number; runtime: boolean; treasury: boolean; identity: boolean }>(`SELECT pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS secdef,
          (SELECT count(*)::int FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0) AS pub,
          has_function_privilege('abos_e1_runtime', p.oid, 'EXECUTE') AS runtime, has_function_privilege('abos_e1_treasury_runtime', p.oid, 'EXECUTE') AS treasury,
          has_function_privilege('abos_v1_identity_runtime', p.oid, 'EXECUTE') AS identity FROM pg_proc p WHERE p.oid = $1::regprocedure`, [routine])).rows[0];
        assert.deepEqual(row, { owner: "abos_v1_operational_finance_owner", secdef: true, pub: 0, runtime: true, treasury: false, identity: false }, routine);
      }
      await receive(f); await transfer(f); await pay(f);
      for (const table of ["treasury_cash_receipts", "treasury_transfers", "treasury_payments"]) {
        const write = (await h.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM information_schema.role_table_grants WHERE table_schema='abos' AND table_name=$1
          AND privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE') AND grantee NOT IN (SELECT rolname FROM pg_roles WHERE rolsuper)`, [table])).rows[0]?.n;
        assert.equal(write, 0, `${table}: no table-wide write grant`);
        for (const role of ["abos_e1_runtime", "abos_e1_treasury_runtime", "abos_v1_identity_runtime"]) {
          assert.equal((await h.pool.query<{ ok: boolean }>("SELECT has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE') AS ok", [role, `abos.${table}`])).rows[0]?.ok, false);
        }
        await assert.rejects(() => h.pool.query(`DELETE FROM abos.${table}`), /append-only/);
      }
    });
  });
}
