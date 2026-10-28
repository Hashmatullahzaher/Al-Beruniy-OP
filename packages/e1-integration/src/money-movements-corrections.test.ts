import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import test, { after, before, describe } from "node:test";
import pg from "pg";

import { PostgresExecutor } from "@abos/persistence";
import { identityDatabaseProof } from "@abos/sandbox-auth";

import { addSecondEntity, addSyntheticSaraf, grant } from "./currency-fixtures.ts";
import { databaseUrl, MISSING_DATABASE_MESSAGE, openHarness, resetSchema, type Harness } from "./harness.ts";
import { issueOperationalSession } from "./operational-session.ts";
import { seedSyntheticWorld, SYNTHETIC_AUTH_CONFIGURATION, type SyntheticWorld } from "./synthetic-world.ts";

/**
 * Migration 0049, the Slice 4 corrections:
 * 1. a Safe, cash box or petty-cash account never goes below zero, whichever lane takes money out,
 *    including under concurrency; a Saraf account may;
 * 2. a workflow without a saved approval setting records in one save (Simple Mode), an explicit setting
 *    is never weakened, and an expense needs approval when its EXPENSE or payment-kind setting is ON;
 * 3. approval ON cannot be saved for a workflow whose lane has no approval path yet.
 */

const MARKER = SYNTHETIC_AUTH_CONFIGURATION.runtimeMarker;
const MONEY = ["treasury.safe.read", "treasury.receipt.record", "treasury.transfer.record", "treasury.payment.record",
  "finance.expense.create", "finance.expense.read", "finance.report.operational.read"];
const INSUFFICIENT = /not enough money in .* for this movement: its balance would fall below zero/;

type Session = { proof: string; runtimeDigest: string; tokenDigest: string };
type Result = { movementId: string; journalId: string; reference: string; status: string; replayed: boolean };
type Expense = { expense: Record<string, unknown> & { id: string; version: number; status: string; workflowPolicyVersionId: string | null } };
type Fixture = { world: SyntheticWorld; actor: Session; approver: Session; admin: Session; safe: string; petty: string; saraf: string;
  revenue: string; payable: string; category: string };

function session(token: string): Session {
  return { proof: identityDatabaseProof(SYNTHETIC_AUTH_CONFIGURATION.signingSecret),
    runtimeDigest: createHash("sha256").update(token).digest("hex"),
    tokenDigest: createHmac("sha256", SYNTHETIC_AUTH_CONFIGURATION.signingSecret).update(token).digest("hex") };
}

if (databaseUrl() === undefined) {
  test("0049 Slice 4 corrections", () => assert.fail(MISSING_DATABASE_MESSAGE));
} else {
  describe("0049: sufficient funds, Simple Mode defaults and approval switches", () => {
    let h: Harness; let runtime: PostgresExecutor; let runtimePool: pg.Pool; let identity: PostgresExecutor; let identityPool: pg.Pool;
    const login = `abos_funds_${randomUUID().replaceAll("-", "")}`;
    const identityLogin = `abos_funds_id_${randomUUID().replaceAll("-", "")}`;

    before(async () => {
      const target = new URL(databaseUrl() ?? "");
      assert.notEqual(target.port, "55432", "preserved runtime PostgreSQL is forbidden");
      assert.notEqual(decodeURIComponent(target.pathname.slice(1)), "abos_v1_local_review");
      h = await openHarness(MARKER);
      await resetSchema(h.pool);
      const pools: pg.Pool[] = [];
      for (const name of [login, identityLogin]) {
        const password = `disposable-${randomUUID()}`;
        await h.pool.query(`CREATE ROLE ${name} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${password}'`);
        const url = new URL(databaseUrl() ?? ""); url.username = name; url.password = password;
        pools.push(new pg.Pool({ connectionString: url.toString(), max: 6 }));
      }
      [runtimePool, identityPool] = pools as [pg.Pool, pg.Pool];
      runtime = new PostgresExecutor(runtimePool, { runtimeMarker: MARKER });
      identity = new PostgresExecutor(identityPool, { runtimeMarker: MARKER });
    });
    after(async () => {
      await runtimePool?.end(); await identityPool?.end();
      if (h !== undefined) {
        await resetSchema(h.pool);
        await h.pool.query(`DROP ROLE IF EXISTS ${login}`); await h.pool.query(`DROP ROLE IF EXISTS ${identityLogin}`);
        await h.close();
      }
    });

    const ledger = async (entity: string, code: string, type: string, control: string | null) => {
      const id = randomUUID();
      await h.pool.query(`INSERT INTO abos.ledger_accounts (id,legal_entity_id,account_code,account_name,account_type,control_account_type,posting_allowed,account_currency_code,status)
        VALUES ($1,$2,$3,$4,$5,$6,true,'USD','ACTIVE')`, [id, entity, code, `Synthetic ${code}`, type, control]);
      return id;
    };
    const treasury = async (world: SyntheticWorld, name: string, type: string, ledgerId: string, saraf: string | null = null) => {
      const id = randomUUID();
      await h.pool.query(`INSERT INTO abos.operational_treasury_accounts (id,legal_entity_id,name_en,account_type,currency_code,ledger_account_id,saraf_business_party_id,
        status,version,created_by_user_account_id,last_changed_by_user_account_id) VALUES($1,$2,$3,$4,'USD',$5,$6,'ACTIVE',1,$7,$7)`,
      [id, world.legalEntityId, name, type, ledgerId, saraf, world.bootstrapUserId]);
      return id;
    };
    const policy = async (world: SyntheticWorld, workflow: string, approval: boolean) => {
      const version = Number((await h.pool.query("SELECT COALESCE(max(version),0)+1 AS v FROM abos.finance_workflow_policy_versions WHERE legal_entity_id=$1 AND workflow_type=$2",
        [world.legalEntityId, workflow])).rows[0]?.v);
      const id = randomUUID();
      await h.pool.query(`INSERT INTO abos.finance_workflow_policy_versions (id,legal_entity_id,workflow_type,version,approval_required,configured_by_user_account_id,change_reason)
        VALUES($1,$2,$3,$4,$5,$6,'Synthetic explicit setting')`, [id, world.legalEntityId, workflow, version, approval, world.bootstrapUserId]);
      return id;
    };

    /** A company with no saved approval setting at all: Simple Mode. */
    async function fixture(): Promise<Fixture> {
      await resetSchema(h.pool);
      await h.pool.query(`GRANT abos_e1_runtime TO ${login}`);
      await h.pool.query(`GRANT abos_v1_identity_runtime TO ${identityLogin}`);
      const world = await seedSyntheticWorld(h.executor);
      await h.pool.query("DELETE FROM abos.sandbox_legal_entity_scopes");
      await h.pool.query("DELETE FROM abos.sandbox_authorizations");
      await grant(h.executor, world, world.intentCreatorId, MONEY);
      await grant(h.executor, world, world.approverId, ["finance.expense.approve", "finance.expense.read"]);
      await grant(h.executor, world, world.reverserId, ["admin.finance-workflow.manage"]);
      const e = world.legalEntityId;
      const safe = await treasury(world, "Synthetic main Safe", "SAFE", world.cashLedgerAccountId);
      const petty = await treasury(world, "Synthetic petty cash", "PETTY_CASH", await ledger(e, "SYN-PETTY", "ASSET", "CASH"));
      const saraf = await treasury(world, "Synthetic Saraf", "SARAF", await ledger(e, "SYN-SARAF", "ASSET", "SARAF"), await addSyntheticSaraf(h.executor, world));
      const revenue = await ledger(e, "SYN-INC", "REVENUE", null);
      const payable = await ledger(e, "SYN-PAY", "LIABILITY", null);
      const category = randomUUID();
      await h.pool.query(`INSERT INTO abos.operational_expense_categories (id,legal_entity_id,category_code,name_en,ledger_account_id,status,version,created_by_user_account_id,last_changed_by_user_account_id)
        VALUES($1,$2,'SYN-FUNDS','Synthetic supplies',$3,'ACTIVE',1,$4,$4)`, [category, e, await ledger(e, "SYN-EXP", "EXPENSE", null), world.bootstrapUserId]);
      return { world, safe, petty, saraf, revenue, payable, category,
        actor: session((await issueOperationalSession(h, world.intentCreatorId, e)).token),
        approver: session((await issueOperationalSession(h, world.approverId, e)).token),
        admin: session((await issueOperationalSession(h, world.reverserId, e)).token) };
    }
    async function call<T>(db: PostgresExecutor, name: string, s: Session, ...extra: unknown[]): Promise<T> {
      const params = [s.proof, s.runtimeDigest, s.tokenDigest, ...extra.map((x) => (typeof x === "object" && x !== null ? JSON.stringify(x) : x))];
      const marks = params.map((_, i) => `$${i + 1}${i >= 3 && typeof extra[i - 3] === "object" && extra[i - 3] !== null ? "::jsonb" : ""}`);
      const result = await db.query<{ value: T }>(`SELECT abos.${name}(${marks.join(",")}) AS value`, params);
      assert.ok(result.rows[0]); return result.rows[0].value;
    }
    const keys = () => ({ idempotencyKey: `funds-${randomUUID()}`, correlationId: randomUUID() });
    const receive = (f: Fixture, amount: string, extra: object = {}) => call<Result>(runtime, "treasury_receipt_record", f.actor, {
      treasuryAccountId: f.safe, amount, currencyCode: "USD", businessDate: "2026-09-10", payerBusinessPartyId: null,
      payerName: "Synthetic walk-in customer", revenueLedgerAccountId: f.revenue, reference: null, note: null, ...keys(), ...extra });
    const transfer = (f: Fixture, amount: string, extra: object = {}) => call<Result>(runtime, "treasury_transfer_record", f.actor, {
      sourceTreasuryAccountId: f.safe, destinationTreasuryAccountId: f.petty, amount, currencyCode: "USD", businessDate: "2026-09-11",
      reference: null, note: null, ...keys(), ...extra });
    const pay = (f: Fixture, amount: string, extra: object = {}) => call<Result>(runtime, "treasury_payment_record", f.actor, {
      treasuryAccountId: f.safe, paymentKind: "SUPPLIER", payeeBusinessPartyId: null, payeeName: "Synthetic supplier", payableLedgerAccountId: f.payable,
      amount, currencyCode: "USD", businessDate: "2026-09-12", reference: null, note: null, ...keys(), ...extra });
    const expense = (f: Fixture, amount: string, extra: object = {}) => call<Expense>(runtime, "operational_expense_create", f.actor, {
      treasuryAccountId: f.safe, expenseCategoryId: f.category, payeeBusinessPartyId: null, projectId: null, departmentId: null, costCenterId: null,
      reference: `FUNDS-${randomUUID().slice(0, 6)}`, description: "Synthetic funds expense", note: null, businessDate: "2026-09-12",
      originalAmount: amount, currencyCode: "USD", exchangeRateId: null, ...keys(), ...extra });
    const book = async (f: Fixture, id: string) => (await h.pool.query<{ b: string }>("SELECT book_balance::text AS b FROM abos.treasury_account_balances($1,NULL,$2)",
      [f.world.legalEntityId, id])).rows[0]?.b;
    const written = async () => (await h.pool.query<{ v: string }>(`SELECT (SELECT count(*) FROM abos.journals)||'/'||(SELECT count(*) FROM abos.treasury_cash_receipts)||'/'||
      (SELECT count(*) FROM abos.treasury_transfers)||'/'||(SELECT count(*) FROM abos.treasury_payments)||'/'||(SELECT count(*) FROM abos.operational_expenses) AS v`)).rows[0]?.v;

    test("a Safe can be spent to exactly zero, never one cent below, by payment, transfer or expense", async () => {
      const f = await fixture();
      await receive(f, "100.00");
      const before = await written();
      await assert.rejects(() => pay(f, "100.01"), INSUFFICIENT);
      await assert.rejects(() => transfer(f, "100.01"), INSUFFICIENT);
      await assert.rejects(() => expense(f, "100.01"), INSUFFICIENT);
      assert.equal(await written(), before, "a refused movement writes nothing");
      await transfer(f, "40.00");
      await pay(f, "50.00");
      await expense(f, "10.00");
      assert.equal(await book(f, f.safe), "0.00");
      await assert.rejects(() => pay(f, "0.01"), INSUFFICIENT);
      await assert.rejects(() => transfer(f, "0.01", { sourceTreasuryAccountId: f.petty, destinationTreasuryAccountId: f.safe, amount: "40.01" }), INSUFFICIENT,
        "petty cash is cash-like too");
      // Receiving money is never limited.
      await receive(f, "5.00");
      assert.equal(await book(f, f.safe), "5.00");
    });

    test("a backdated spend cannot overdraw the day it is dated, even when today's balance covers it", async () => {
      const f = await fixture();
      await receive(f, "100.00", { businessDate: "2026-09-10" });
      await assert.rejects(() => pay(f, "10.00", { businessDate: "2026-09-09" }), INSUFFICIENT);
      await pay(f, "100.00", { businessDate: "2026-09-10" });
      await assert.rejects(() => receive(f, "1.00", { businessDate: "2026-09-12" }).then(() => pay(f, "1.00", { businessDate: "2026-09-11" })), INSUFFICIENT,
        "money that arrives later does not fund an earlier day");
    });

    test("an expense waiting for approval is refused at approval when the Safe no longer holds the money", async () => {
      const f = await fixture();
      await policy(f.world, "EXPENSE", true);
      await receive(f, "100.00");
      const pending = await expense(f, "80.00");
      assert.equal(pending.expense.status, "PENDING_APPROVAL");
      await pay(f, "30.00");
      await assert.rejects(() => call(runtime, "operational_expense_approve", f.approver, pending.expense.id, pending.expense.version, "Synthetic approval"), INSUFFICIENT);
      assert.equal(await book(f, f.safe), "70.00");
    });

    test("concurrent spenders queue on the Safe: together they can never overdraw it", async () => {
      const f = await fixture();
      await receive(f, "100.00");
      // Hold every posting open for a moment after its funds check, so a check without the lock would
      // see the same 100 twice. Disposable: the schema is reset after the test.
      await h.pool.query(`CREATE FUNCTION abos.zz_test_pause_after_post() RETURNS trigger LANGUAGE plpgsql AS $p$ BEGIN PERFORM pg_sleep(0.6); RETURN NULL; END $p$`);
      await h.pool.query(`CREATE TRIGGER zz_test_pause_after_post AFTER UPDATE ON abos.journals FOR EACH ROW WHEN (NEW.status = 'POSTED')
        EXECUTE FUNCTION abos.zz_test_pause_after_post()`);
      const settle = async (attempts: Promise<unknown>[]) => (await Promise.allSettled(attempts)).map((r) =>
        r.status === "fulfilled" ? "ok" : INSUFFICIENT.test(String((r.reason as Error).message)) ? "insufficient" : `other: ${(r.reason as Error).message}`);
      assert.deepEqual((await settle([expense(f, "60.00"), expense(f, "60.00")])).sort(), ["insufficient", "ok"], "two expenses");
      assert.equal(await book(f, f.safe), "40.00");
      assert.deepEqual((await settle([pay(f, "30.00"), expense(f, "30.00")])).sort(), ["insufficient", "ok"], "a payment and an expense");
      assert.equal(await book(f, f.safe), "10.00");
      assert.deepEqual((await settle([transfer(f, "6.00"), transfer(f, "6.00"), pay(f, "6.00")])).sort(), ["insufficient", "insufficient", "ok"],
        "transfers and a payment");
      assert.equal(await book(f, f.safe), "4.00");
      await h.pool.query("DROP TRIGGER zz_test_pause_after_post ON abos.journals");
    });

    test("a replay returns the first result and never spends twice, even once the Safe is empty", async () => {
      const f = await fixture();
      await receive(f, "100.00");
      const request = keys();
      const first = await pay(f, "100.00", request);
      const again = await pay(f, "100.00", request);
      assert.deepEqual({ ...again, replayed: false }, first);
      assert.equal(again.replayed, true);
      assert.equal(await book(f, f.safe), "0.00");
      assert.equal(await written(), "2/1/0/1/0");
    });

    test("a Saraf account may go below zero: the negative position is what is owed to the Saraf", async () => {
      const f = await fixture();
      await transfer(f, "50.00", { sourceTreasuryAccountId: f.saraf, destinationTreasuryAccountId: f.safe });
      assert.equal(await book(f, f.saraf), "-50.00");
      assert.equal(await book(f, f.safe), "50.00");
      await pay(f, "25.00", { treasuryAccountId: f.saraf });
      assert.equal(await book(f, f.saraf), "-75.00");
    });

    test("another company and people without the permission still cannot spend the Safe", async () => {
      const f = await fixture();
      await receive(f, "100.00");
      const other = await addSecondEntity(h.executor, f.world, MONEY);
      const outsider = session((await issueOperationalSession(h, other.userId, other.legalEntityId)).token);
      await assert.rejects(() => call(runtime, "treasury_payment_record", outsider, { treasuryAccountId: f.safe, paymentKind: "SUPPLIER",
        payeeBusinessPartyId: null, payeeName: "Synthetic", payableLedgerAccountId: f.payable, amount: "1.00", currencyCode: "USD",
        businessDate: "2026-09-12", reference: null, note: null, ...keys() }), /not found in this legal entity|choose an active payable account/);
      const reader = session((await issueOperationalSession(h, f.world.approverId, f.world.legalEntityId)).token);
      await assert.rejects(() => call(runtime, "treasury_payment_record", reader, { treasuryAccountId: f.safe, paymentKind: "SUPPLIER",
        payeeBusinessPartyId: null, payeeName: "Synthetic", payableLedgerAccountId: f.payable, amount: "1.00", currencyCode: "USD",
        businessDate: "2026-09-12", reference: null, note: null, ...keys() }), /treasury\.payment\.record/);
      assert.equal(await book(f, f.safe), "100.00");
      const helpers = (await h.pool.query(`SELECT p.proname AS name, has_function_privilege('abos_e1_runtime', p.oid, 'EXECUTE') AS runtime,
          has_function_privilege('public', p.oid, 'EXECUTE') AS everyone FROM pg_proc p WHERE p.pronamespace = 'abos'::regnamespace
          AND p.proname IN ('treasury_require_funds', 'workflow_policy_allows_direct', 'finance_workflow_approval_available') ORDER BY 1`)).rows;
      assert.deepEqual(helpers.map((r) => [r.name, r.runtime, r.everyone]), [["finance_workflow_approval_available", false, false],
        ["treasury_require_funds", false, false], ["workflow_policy_allows_direct", false, false]]);
    });

    test("Simple Mode: without any saved setting every money movement and expense records in one save", async () => {
      const f = await fixture();
      assert.equal(Number((await h.pool.query("SELECT count(*) FROM abos.finance_workflow_policy_versions")).rows[0]?.count), 0);
      const options = await call<{ settings: Record<string, string> }>(runtime, "treasury_money_options", f.actor);
      assert.deepEqual(options.settings, { OTHER_INCOME: "READY", TREASURY_TRANSFER: "READY", SUPPLIER_PAYMENT: "READY", SALARY_PAYMENT: "READY" });
      const entry = await call<{ policyConfigured: boolean; approvalRequired: boolean }>(runtime, "operational_expense_entry_options", f.actor, "2026-09-12");
      assert.deepEqual([entry.policyConfigured, entry.approvalRequired], [false, false]);
      await receive(f, "500.00");
      await transfer(f, "10.00");
      await pay(f, "10.00");
      await pay(f, "10.00", { paymentKind: "SALARY", payeeName: "Synthetic employee" });
      const plain = await expense(f, "10.00");
      const salary = await expense(f, "10.00", { paymentKind: "SALARY" });
      assert.deepEqual([plain.expense.status, salary.expense.status], ["POSTED", "POSTED"]);
      const references = (await h.pool.query(`SELECT (SELECT count(*) FROM abos.treasury_cash_receipts WHERE workflow_policy_version_id IS NULL)::int
          + (SELECT count(*) FROM abos.treasury_transfers WHERE workflow_policy_version_id IS NULL)::int
          + (SELECT count(*) FROM abos.treasury_payments WHERE workflow_policy_version_id IS NULL)::int
          + (SELECT count(*) FROM abos.operational_expenses WHERE workflow_policy_version_id IS NULL AND NOT approval_required)::int AS n`)).rows[0]?.n;
      assert.equal(references, 6, "every record carries the Simple Mode default, not an invented setting");
      assert.equal(Number((await h.pool.query("SELECT count(*) FROM abos.finance_workflow_policy_versions")).rows[0]?.count), 0, "nothing was seeded");
    });

    test("an explicit setting is never weakened: OFF is referenced, ON still governs, and a kind cannot bypass EXPENSE", async () => {
      const f = await fixture();
      await receive(f, "500.00");
      const off = await policy(f.world, "OTHER_INCOME", false);
      await receive(f, "1.00");
      assert.equal((await h.pool.query("SELECT workflow_policy_version_id AS p FROM abos.treasury_cash_receipts ORDER BY created_at DESC LIMIT 1")).rows[0]?.p, off);
      await policy(f.world, "TREASURY_TRANSFER", true);
      await assert.rejects(() => transfer(f, "1.00"), /the TREASURY_TRANSFER setting requires approval, which is not available/);
      const expenseOn = await policy(f.world, "EXPENSE", true);
      const supplier = await expense(f, "5.00", { paymentKind: "SUPPLIER" });
      assert.deepEqual([supplier.expense.status, supplier.expense.workflowPolicyVersionId], ["PENDING_APPROVAL", expenseOn],
        "EXPENSE approval ON governs an expense paid as a supplier payment");
      await policy(f.world, "EXPENSE", false);
      const salaryOn = await policy(f.world, "SALARY_PAYMENT", true);
      const salary = await expense(f, "5.00", { paymentKind: "SALARY" });
      assert.deepEqual([salary.expense.status, salary.expense.workflowPolicyVersionId], ["PENDING_APPROVAL", salaryOn]);
      assert.equal((await expense(f, "5.00", { paymentKind: "OTHER" })).expense.status, "POSTED");
    });

    test("approval ON cannot be saved where the lane has no approval path; OFF always can", async () => {
      const f = await fixture();
      const set = (workflowType: string, approvalRequired: boolean, expectedVersion = 0) => call<{ policies: { workflowType: string; approvalAvailable: boolean }[] }>(
        identity, "finance_workflow_policy_set_command", f.admin, { workflowType, approvalRequired, expectedVersion,
          changeReason: "Synthetic owner decision", ...keys() });
      for (const workflow of ["OTHER_INCOME", "TREASURY_TRANSFER", "SUPPLIER_PAYMENT", "SALARY_PAYMENT", "CUSTOMER_RECEIPT"]) {
        await assert.rejects(() => set(workflow, true), new RegExp(`approval is not available for ${workflow} yet`), workflow);
        await set(workflow, false);
      }
      const workspace = await set("EXPENSE", true);
      assert.deepEqual(Object.fromEntries(workspace.policies.map((p) => [p.workflowType, p.approvalAvailable])), {
        CHART_OF_ACCOUNTS: true, SHAREHOLDER_CAPITAL_RECEIPT: true, CUSTOMER_RECEIPT: false, OTHER_INCOME: false, EXPENSE: true,
        SUPPLIER_PAYMENT: false, SALARY_PAYMENT: false, TREASURY_TRANSFER: false, TEMPORARY_FUNDING: true });
    });
  });
}
