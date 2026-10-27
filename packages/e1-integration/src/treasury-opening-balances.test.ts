import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import test, { after, before, describe } from "node:test";
import pg from "pg";

import { PostgresExecutor } from "@abos/persistence";
import { identityDatabaseProof, SandboxAuthenticator } from "@abos/sandbox-auth";

import { grant } from "./currency-fixtures.ts";
import { databaseUrl, MISSING_DATABASE_MESSAGE, openHarness, resetSchema, type Harness } from "./harness.ts";
import { issueOperationalSession } from "./operational-session.ts";
import { seedSyntheticWorld, SYNTHETIC_AUTH_CONFIGURATION, type SyntheticWorld } from "./synthetic-world.ts";

/**
 * Migration 0046: one Safe model with real opening balances. An opening balance is a posting through
 * the kernel (Dr the Safe, Cr opening balance equity); a Safe's balance is always derived from posted
 * movements; lifecycle ACTIVE / INACTIVE / CLOSED; optional responsible people.
 */

const MARKER = SYNTHETIC_AUTH_CONFIGURATION.runtimeMarker;
const ALL = ["shareholder.setup.manage", "shareholder.capital-receipt.read", "shareholder.capital-receipt.record",
  "finance.capital-receipt.prepare", "finance.capital-receipt.post", "finance.report.operational.read",
  "finance.expense.create", "finance.expense.read", "treasury.safe.read", "treasury.opening-balance.record",
  "treasury.operational-account.manage"];
const ENTRY_POINTS = ["abos.treasury_opening_balance_record(text,text,text,jsonb)", "abos.treasury_safes_workspace(text,text,text)",
  "abos.treasury_safe_responsibles_set(text,text,text,jsonb)"];

type Session = { proof: string; runtimeDigest: string; tokenDigest: string };
type Money = { opening: string; inflows: string; outflows: string; book: string; movementCount: number; lastMovementDate: string | null };
type Safe = { id: string; status: string; version: number; currencyCode: string; balance: Money;
  openingBalance: { id: string; amount: string; asOfDate: string; journalId: string } | null;
  responsibles: { userAccountId: string }[]; legacyLink: { locationName: string; activationStatus: string } | null;
  movements: { direction: string; amount: string; sourceType: string; reference: string | null; restricted: boolean }[];
  ledgerAccount: { id: string } };
type Workspace = { today: string; baseCurrency: string; canRecordOpeningBalance: boolean; canManageSafes: boolean;
  openingEquity: { status: string; account?: { id: string } }; safes: Safe[]; assignableUsers: { userAccountId: string }[] };
type Fixture = { world: SyntheticWorld; actor: Session; safe: string; second: string; secondLedger: string; equity: string | null;
  category: string; shareholder: string };

function args(token: string): Session {
  return { proof: identityDatabaseProof(SYNTHETIC_AUTH_CONFIGURATION.signingSecret),
    runtimeDigest: createHash("sha256").update(token).digest("hex"),
    tokenDigest: createHmac("sha256", SYNTHETIC_AUTH_CONFIGURATION.signingSecret).update(token).digest("hex") };
}

if (databaseUrl() === undefined) {
  test("0046 treasury opening balances", () => assert.fail(MISSING_DATABASE_MESSAGE));
} else {
  describe("0046: one Safe model, opening balances and derived balances", () => {
    let h: Harness; let runtime: PostgresExecutor; let runtimePool: pg.Pool; let behindPool: pg.Pool; let behind: PostgresExecutor;
    const login = `abos_safes_${randomUUID().replaceAll("-", "")}`;

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
      // A session a day behind Kabul (UTC-12) reproduces the 00:00-04:30 window deterministically.
      behindPool = new pg.Pool({ connectionString: url.toString(), max: 1, options: "-c TimeZone=Etc/GMT+12" });
      behind = new PostgresExecutor(behindPool, { runtimeMarker: MARKER });
    });
    after(async () => {
      await runtimePool?.end(); await behindPool?.end();
      if (h !== undefined) { await resetSchema(h.pool); await h.pool.query(`DROP ROLE IF EXISTS ${login}`); await h.close(); }
    });

    async function fixture(options: { equity?: boolean } = {}): Promise<Fixture> {
      await resetSchema(h.pool);
      await h.pool.query(`GRANT abos_e1_runtime TO ${login}`);
      const world = await seedSyntheticWorld(h.executor);
      await h.pool.query("DELETE FROM abos.sandbox_legal_entity_scopes");
      await h.pool.query("DELETE FROM abos.sandbox_authorizations");
      await grant(h.executor, world, world.intentCreatorId, ALL);
      const safe = randomUUID(); const second = randomUUID(); const secondLedger = randomUUID(); const category = randomUUID(); const expenseLedger = randomUUID();
      await h.pool.query(`INSERT INTO abos.ledger_accounts (id,legal_entity_id,account_code,account_name,account_type,control_account_type,posting_allowed,account_currency_code,status)
        VALUES ($1,$3,'SYN-SAFE-2','Synthetic second Safe cash','ASSET','CASH',true,'USD','ACTIVE'),
               ($2,$3,'SYN-OB-EXP','Synthetic opening expense','EXPENSE',NULL,true,'USD','ACTIVE')`, [secondLedger, expenseLedger, world.legalEntityId]);
      for (const [id, name, ledger] of [[safe, "Synthetic main Safe", world.cashLedgerAccountId], [second, "Synthetic petty Safe", secondLedger]] as const) {
        await h.pool.query(`INSERT INTO abos.operational_treasury_accounts
          (id,legal_entity_id,name_en,account_type,currency_code,ledger_account_id,status,version,created_by_user_account_id,last_changed_by_user_account_id)
          VALUES($1,$2,$3,'SAFE','USD',$4,'ACTIVE',1,$5,$5)`, [id, world.legalEntityId, name, ledger, world.bootstrapUserId]);
      }
      let equity: string | null = null;
      if (options.equity !== false) {
        equity = randomUUID();
        await h.pool.query(`INSERT INTO abos.ledger_accounts (id,legal_entity_id,account_code,account_name,account_type,control_account_type,posting_allowed,account_currency_code,status)
          VALUES ($1,$2,'SYN-OBE','Synthetic opening balance equity','EQUITY','OPENING_BALANCE_EQUITY',true,'USD','ACTIVE')`, [equity, world.legalEntityId]);
      }
      await h.pool.query(`INSERT INTO abos.operational_expense_categories
        (id,legal_entity_id,category_code,name_en,ledger_account_id,status,version,created_by_user_account_id,last_changed_by_user_account_id)
        VALUES($1,$2,'SYN-OB','Synthetic opening category',$3,'ACTIVE',1,$4,$4)`, [category, world.legalEntityId, expenseLedger, world.bootstrapUserId]);
      for (const workflow of ["SHAREHOLDER_CAPITAL_RECEIPT", "EXPENSE"]) {
        await h.pool.query(`INSERT INTO abos.finance_workflow_policy_versions
          (id,legal_entity_id,workflow_type,version,approval_required,configured_by_user_account_id,change_reason)
          VALUES($1,$2,$3,1,false,$4,'Synthetic opening-balance test policy')`, [randomUUID(), world.legalEntityId, workflow, world.bootstrapUserId]);
      }
      const actor = args((await issueOperationalSession(h, world.intentCreatorId, world.legalEntityId)).token);
      const created = await call<{ shareholderProfileId: string }>("direct_shareholder_add", actor, {
        displayName: "Synthetic Opening Holder", agreedTotal: null, currencyCode: null, externalReference: null, note: null,
        businessDate: "2026-09-02", firstContribution: null, ...keys() });
      return { world, actor, safe, second, secondLedger, equity, category, shareholder: created.shareholderProfileId };
    }
    async function call<T>(name: string, s: Session, payload?: object, db: PostgresExecutor = runtime): Promise<T> {
      const result = payload === undefined
        ? await db.query<{ value: T }>(`SELECT abos.${name}($1,$2,$3) AS value`, [s.proof, s.runtimeDigest, s.tokenDigest])
        : await db.query<{ value: T }>(`SELECT abos.${name}($1,$2,$3,$4::jsonb) AS value`, [s.proof, s.runtimeDigest, s.tokenDigest, JSON.stringify(payload)]);
      assert.ok(result.rows[0]); return result.rows[0].value;
    }
    const keys = () => ({ idempotencyKey: `opening-${randomUUID()}`, correlationId: randomUUID() });
    type Opening = { openingBalanceId: string; journalId: string; reference: string; status: string; replayed: boolean };
    const open = (f: Fixture, extra: object = {}, s: Session = f.actor, db: PostgresExecutor = runtime) => call<Opening>("treasury_opening_balance_record", s, {
      treasuryAccountId: f.safe, amount: "2500.00", currencyCode: "USD", asOfDate: "2026-09-01", reference: "Counted on day one",
      note: null, ...keys(), ...extra }, db);
    const workspace = (s: Session) => call<Workspace>("treasury_safes_workspace", s);
    const safeOf = async (f: Fixture, id = f.safe, s: Session = f.actor) => (await workspace(s)).safes.find((x) => x.id === id)!;
    const capital = (f: Fixture, amount: string) => call("direct_shareholder_receive", f.actor, {
      shareholderProfileId: f.shareholder, fundingMethod: "CASH", amount, currencyCode: "USD", receiptDate: "2026-09-03",
      destinationAccountId: f.safe, providerName: null, itemDescription: null, expenseLedgerAccountId: null,
      paymentReference: "SYN-OB-CAP", note: null, ...keys() });
    const expense = (f: Fixture, amount: string) => call("operational_expense_create", f.actor, {
      treasuryAccountId: f.safe, expenseCategoryId: f.category, payeeBusinessPartyId: null, projectId: null, departmentId: null,
      costCenterId: null, reference: `SYN-OB-${randomUUID().slice(0, 8)}`, description: "Synthetic expense after opening", note: null,
      businessDate: "2026-09-04", originalAmount: amount, currencyCode: "USD", exchangeRateId: null, ...keys() });
    const counts = async () => (await h.pool.query<{ v: string }>(`SELECT (SELECT count(*) FROM abos.treasury_opening_balances)||'/'||
      (SELECT count(*) FROM abos.journals)||'/'||(SELECT count(*) FROM abos.subledger_entries) AS v`)).rows[0]?.v ?? "";
    const upsert = (f: Fixture, id: string, ledger: string, status: string, version: number) => call("operational_treasury_account_upsert", f.actor, {
      id, nameEn: "Synthetic Safe", nameFa: null, accountType: "SAFE", currencyCode: "USD", ledgerAccountId: ledger,
      sarafBusinessPartyId: null, externalReference: null, status, expectedVersion: version });

    test("an opening balance posts Dr Safe / Cr opening balance equity through the kernel; capital adds and expense subtracts", async () => {
      const f = await fixture();
      const empty = await safeOf(f);
      assert.equal(empty.openingBalance, null);
      assert.deepEqual(empty.balance, { opening: "0", inflows: "0", outflows: "0", book: "0", movementCount: 0, lastMovementDate: null });
      assert.deepEqual(empty.legacyLink, { locationName: (await h.pool.query("SELECT location_name FROM abos.cash_locations WHERE id=$1", [f.world.cashLocationId])).rows[0]?.location_name,
        activationStatus: (await h.pool.query("SELECT activation_status FROM abos.cash_location_currency_accounts WHERE id=$1", [f.world.cashAccountId])).rows[0]?.activation_status },
      "the legacy account on the same ledger is linked, read-only");
      const posted = await open(f);
      assert.equal(posted.status, "POSTED"); assert.equal(posted.replayed, false);
      assert.match(posted.reference, /^OB-20260901-[0-9A-F]{32}$/);
      const lines = (await h.pool.query<{ n: number; ledger: string; debit: string; credit: string; source: string }>(
        `SELECT line_number AS n, ledger_account_id AS ledger, base_debit::text AS debit, base_credit::text AS credit, source_type AS source
           FROM abos.journal_lines WHERE journal_id = $1 ORDER BY line_number`, [posted.journalId])).rows;
      assert.deepEqual(lines, [
        { n: 1, ledger: f.world.cashLedgerAccountId, debit: "2500.00", credit: "0", source: "OPENING_BALANCE" },
        { n: 2, ledger: f.equity, debit: "0", credit: "2500.00", source: "OPENING_BALANCE" }]);
      const subledger = (await h.pool.query(`SELECT e.subledger_type AS type, e.operational_treasury_account_id AS safe, e.base_amount::text AS amount, l.line_number AS line
        FROM abos.subledger_entries e JOIN abos.journal_lines l ON l.id = e.journal_line_id WHERE l.journal_id = $1`, [posted.journalId])).rows;
      assert.deepEqual(subledger, [{ type: "OPERATIONAL_TREASURY", safe: f.safe, amount: "2500.00", line: 1 }]);
      const intent = (await h.pool.query(`SELECT i.intent_kind, i.status, i.treasury_opening_balance_id = i.source_id AS linked, j.status AS journal, j.posted_by_user_account_id AS poster
        FROM abos.journals j JOIN abos.posting_intents i ON i.id = j.posting_intent_id WHERE j.id = $1`, [posted.journalId])).rows[0];
      assert.deepEqual(intent, { intent_kind: "OPENING_BALANCE", status: "POSTED", linked: true, journal: "POSTED", poster: f.world.intentCreatorId });
      assert.equal((await h.pool.query("SELECT count(*)::int AS n FROM abos.audit_records WHERE action = 'TREASURY_OPENING_BALANCE_POSTED' AND entity_id = $1", [posted.openingBalanceId])).rows[0]?.n, 1);
      assert.equal((await h.pool.query("SELECT count(*)::int AS n FROM abos.outbox_events WHERE event_type = 'finance.treasury-opening-balance.posted' AND aggregate_id = $1", [posted.openingBalanceId])).rows[0]?.n, 1);

      let safe = await safeOf(f);
      assert.deepEqual(safe.balance, { opening: "2500.00", inflows: "0", outflows: "0", book: "2500.00", movementCount: 1, lastMovementDate: "2026-09-01" });
      assert.deepEqual(safe.openingBalance && [safe.openingBalance.amount, safe.openingBalance.asOfDate, safe.openingBalance.journalId], ["2500.00", "2026-09-01", posted.journalId]);
      await capital(f, "1000");
      await expense(f, "125.50");
      safe = await safeOf(f);
      assert.deepEqual(safe.balance, { opening: "2500.00", inflows: "1000", outflows: "125.50", book: "3374.50", movementCount: 3, lastMovementDate: "2026-09-04" });
      assert.deepEqual(safe.movements.map((m) => [m.direction, m.amount, m.sourceType]),
        [["OUT", "125.50", "OPERATIONAL_EXPENSE"], ["IN", "1000", "DIRECT_SHAREHOLDER_CAPITAL"], ["IN", "2500.00", "OPENING_BALANCE"]]);
      // The ledger agrees with the Safe.
      const ledger = (await h.pool.query<{ net: string }>("SELECT net_balance::text AS net FROM abos.ledger_account_balances($1, NULL, NULL) WHERE ledger_account_id = $2",
        [f.world.legalEntityId, f.world.cashLedgerAccountId])).rows[0];
      assert.deepEqual(ledger, { net: "3374.50" });
      // No balance is stored anywhere: the Safe table has no balance column, the workspace derives it.
      const balanceColumns = (await h.pool.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'abos'
        AND table_name IN ('operational_treasury_accounts', 'treasury_opening_balances') AND column_name ~ 'balance'`)).rows;
      assert.deepEqual(balanceColumns, []);
    });

    test("an identical request replays; a second opening balance and a concurrent duplicate are refused", async () => {
      const f = await fixture();
      const request = { ...keys() };
      const first = await open(f, request);
      const again = await open(f, request);
      assert.deepEqual({ ...again, replayed: false }, first);
      assert.equal(again.replayed, true);
      await assert.rejects(() => open(f, { ...request, amount: "1" }), /idempotency key was already used/);
      await assert.rejects(() => open(f), /this Safe already has an opening balance; a posted opening balance is corrected by reversal/);
      const results = await Promise.allSettled([open(f, { treasuryAccountId: f.second }), open(f, { treasuryAccountId: f.second })]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1, "exactly one of two concurrent attempts posts");
      const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
      assert.match(String(refused.reason), /already has an opening balance/);
      assert.equal((await h.pool.query("SELECT count(*)::int AS n FROM abos.treasury_opening_balances")).rows[0]?.n, 2);
      assert.equal((await h.pool.query("SELECT count(*)::int AS n FROM abos.journals")).rows[0]?.n, 2);
    });

    test("wrong currency, future date, inactive Safe, foreign company, malformed amounts and periods are refused with nothing written", async () => {
      const f = await fixture();
      const before = await counts();
      await assert.rejects(() => open(f, { currencyCode: "AFN" }), /must be in the Safe currency USD/);
      const { rows: [{ today, tomorrow }] } = await h.pool.query("SELECT abos.business_today()::text AS today, (abos.business_today() + 1)::text AS tomorrow");
      await assert.rejects(() => open(f, { asOfDate: tomorrow }), /cannot be dated after today/);
      for (const amount of ["0", "-5", "1e3", "abc", ""]) await assert.rejects(() => open(f, { amount }), /positive|amount|decimal/i, `amount ${JSON.stringify(amount)}`);
      await assert.rejects(() => open(f, { surprise: true }), /unknown opening balance fields/);
      await assert.rejects(() => open(f, { treasuryAccountId: "not-a-uuid" }), /a Safe, an amount, an as-of date and a request key are required/);
      await assert.rejects(() => open(f, { asOfDate: "2026-02-31" }), /a Safe, an amount, an as-of date and a request key are required/);
      await assert.rejects(() => open(f, { treasuryAccountId: randomUUID() }), /the Safe was not found in this legal entity/);
      // Another company's Safe is not found from this session.
      const other = await seedSyntheticWorld(h.executor, { withoutSandboxAuthorization: true });
      const foreign = randomUUID();
      await h.pool.query(`INSERT INTO abos.operational_treasury_accounts (id,legal_entity_id,name_en,account_type,currency_code,ledger_account_id,status,version,created_by_user_account_id,last_changed_by_user_account_id)
        VALUES($1,$2,'Foreign Safe','SAFE','USD',$3,'ACTIVE',1,$4,$4)`, [foreign, other.legalEntityId, other.cashLedgerAccountId, other.bootstrapUserId]);
      await assert.rejects(() => open(f, { treasuryAccountId: foreign }), /the Safe was not found in this legal entity/);
      // Periods: none for July; a PENDING month outside a financial year is never opened automatically.
      await assert.rejects(() => open(f, { asOfDate: "2026-07-05" }), /no accounting period covers 2026-07-05/);
      await h.pool.query(`INSERT INTO abos.accounting_periods (id, legal_entity_id, period_name, starts_on, ends_on, status)
        VALUES ($1, $2, '2026-08', '2026-08-01', '2026-08-31', 'PENDING')`, [randomUUID(), f.world.legalEntityId]);
      await assert.rejects(() => open(f, { asOfDate: "2026-08-11" }), /cannot be reopened automatically/);
      // Inactive Safe.
      await upsert(f, f.second, f.secondLedger, "INACTIVE", 1);
      await assert.rejects(() => open(f, { treasuryAccountId: f.second }), /an opening balance needs an active Safe/);
      assert.equal(await counts(), before, "nothing was written");
      void today;
    });

    test("a PENDING month inside the financial year opens itself; the Kabul business day is the ceiling even a day behind UTC", async () => {
      const f = await fixture();
      const fiscalYear = randomUUID();
      await h.pool.query(`INSERT INTO abos.fiscal_years(id,legal_entity_id,calendar_kind,fiscal_year,label_en,label_fa,starts_on,ends_on,generated_by_user_account_id)
        VALUES($1,$2,'GREGORIAN',2026,'FY 2026','۱۴۰۵','2026-10-01','2026-12-31',$3)`, [fiscalYear, f.world.legalEntityId, f.world.bootstrapUserId]);
      const { rows: [{ today, tomorrow, start, end }] } = await h.pool.query(`SELECT abos.business_today()::text AS today, (abos.business_today() + 1)::text AS tomorrow,
        date_trunc('month', abos.business_today())::date::text AS start, (date_trunc('month', abos.business_today()) + interval '1 month - 1 day')::date::text AS "end"`);
      await h.pool.query(`INSERT INTO abos.accounting_periods(id,legal_entity_id,period_name,starts_on,ends_on,status,fiscal_year_id,period_sequence,period_name_fa)
        VALUES($1,$2,'Current month',$3,$4,'PENDING',$5,1,'ماه جاری')`, [randomUUID(), f.world.legalEntityId, start, end, fiscalYear]);
      const behindActor = args((await issueOperationalSession(h, f.world.intentCreatorId, f.world.legalEntityId)).token);
      const sessionDay = (await behindPool.query<{ d: string }>("SELECT current_date::text AS d")).rows[0]?.d;
      await assert.rejects(() => open(f, { asOfDate: tomorrow }, behindActor, behind), /cannot be dated after today/);
      const posted = await open(f, { asOfDate: today }, behindActor, behind);
      assert.equal(posted.status, "POSTED", `accepted on the Kabul day ${today} while the session date is ${sessionDay}`);
      assert.equal((await h.pool.query("SELECT status FROM abos.accounting_periods WHERE starts_on = $1 AND legal_entity_id = $2", [start, f.world.legalEntityId])).rows[0]?.status, "OPEN");
    });

    test("opening balance equity must resolve to exactly one active account", async () => {
      const f = await fixture({ equity: false });
      assert.equal((await workspace(f.actor)).openingEquity.status, "MISSING");
      await assert.rejects(() => open(f), /opening balance equity is not set up/);
      const one = randomUUID(); const two = randomUUID();
      await h.pool.query(`INSERT INTO abos.ledger_accounts (id,legal_entity_id,account_code,account_name,account_type,control_account_type,posting_allowed,account_currency_code,status)
        VALUES ($1,$2,'SYN-OBE-AFN','Synthetic AFN opening equity','EQUITY','OPENING_BALANCE_EQUITY',true,'AFN','ACTIVE')`, [one, f.world.legalEntityId]);
      assert.equal((await workspace(f.actor)).openingEquity.status, "INVALID");
      await assert.rejects(() => open(f), /must be an EQUITY account that accepts postings in USD/);
      await h.pool.query(`INSERT INTO abos.ledger_accounts (id,legal_entity_id,account_code,account_name,account_type,control_account_type,posting_allowed,account_currency_code,status)
        VALUES ($1,$2,'SYN-OBE-2','Synthetic second opening equity','EQUITY','OPENING_BALANCE_EQUITY',true,'USD','ACTIVE')`, [two, f.world.legalEntityId]);
      assert.equal((await workspace(f.actor)).openingEquity.status, "AMBIGUOUS");
      await assert.rejects(() => open(f), /opening balance equity is ambiguous: 2 active accounts/);
      assert.equal((await h.pool.query("SELECT count(*)::int AS n FROM abos.journals")).rows[0]?.n, 0);
      // The Chart of Accounts accepts the control only on an EQUITY account.
      await assert.rejects(() => h.pool.query("SELECT abos.coa_validate('OBE-1','Opening balance equity',NULL,NULL,'ASSET','OPENING_BALANCE_EQUITY','USD',true,'ACTIVE')"),
        /a OPENING_BALANCE_EQUITY control account cannot have account type ASSET/);
      await h.pool.query("SELECT abos.coa_validate('OBE-1','Opening balance equity',NULL,NULL,'EQUITY','OPENING_BALANCE_EQUITY','USD',true,'ACTIVE')");
    });

    test("authority: synthetic sessions, missing permissions and other runtimes are refused; a responsible person reads only their Safe", async () => {
      const f = await fixture();
      await open(f);
      await capital(f, "400");
      // Synthetic provenance.
      await h.pool.query(`INSERT INTO abos.sandbox_authorizations(singleton,environment,configuration_state,policy_version_id,
        runtime_marker,authorized_by_user_account_id,authorized_at,expires_at)
        VALUES(true,'test','SYNTHETIC_TEST_ONLY',$1,$2,$3,clock_timestamp(),clock_timestamp()+interval '1 day')`, [f.world.policyVersionId, MARKER, f.world.bootstrapUserId]);
      await h.pool.query("INSERT INTO abos.sandbox_legal_entity_scopes(legal_entity_id,base_currency_code,authorized_by_user_account_id) VALUES($1,'USD',$2)", [f.world.legalEntityId, f.world.bootstrapUserId]);
      const developer = args((await new SandboxAuthenticator(h.executor, SYNTHETIC_AUTH_CONFIGURATION).issueSession({
        userAccountId: f.world.intentCreatorId as never, legalEntityId: f.world.legalEntityId as never })).token);
      await assert.rejects(() => workspace(developer), /operational password session is required|sign in/);
      await assert.rejects(() => open(f, { treasuryAccountId: f.second }, developer), /operational password session is required|sign in/);
      // An operational user without the permissions.
      const plain = args((await issueOperationalSession(h, f.world.approverId, f.world.legalEntityId)).token);
      await assert.rejects(() => workspace(plain), /current authority is missing treasury\.safe\.read/);
      await assert.rejects(() => open(f, { treasuryAccountId: f.second }, plain), /current authority is missing treasury\.opening-balance\.record/);
      await assert.rejects(() => call("treasury_safe_responsibles_set", plain, { treasuryAccountId: f.safe, userAccountIds: [] }),
        /current authority is missing treasury\.operational-account\.manage/);
      // A responsible person without company-wide Safe access sees exactly that Safe, with its full balance
      // (including shareholder capital they cannot read anywhere else).
      const assigned = await call<Workspace>("treasury_safe_responsibles_set", f.actor, { treasuryAccountId: f.safe, userAccountIds: [f.world.approverId] });
      assert.deepEqual(assigned.safes.find((s) => s.id === f.safe)?.responsibles.map((r) => r.userAccountId), [f.world.approverId]);
      const theirs = await workspace(plain);
      assert.deepEqual(theirs.safes.map((s) => [s.id, s.balance.book]), [[f.safe, "2900.00"]]);
      assert.equal(theirs.canRecordOpeningBalance, false);
      await assert.rejects(() => call("treasury_safe_responsibles_set", f.actor, { treasuryAccountId: f.safe, userAccountIds: [randomUUID()] }),
        /a responsible person must be an active user of this company/);
      await call("treasury_safe_responsibles_set", f.actor, { treasuryAccountId: f.safe, userAccountIds: [] });
      await assert.rejects(() => workspace(plain), /current authority is missing treasury\.safe\.read/, "revoking the responsibility removes access");
      // Runtimes and PUBLIC.
      for (const routine of ENTRY_POINTS) {
        const may = async (role: string) => (await h.pool.query<{ ok: boolean }>("SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok", [role, routine])).rows[0]?.ok;
        assert.equal(await may("abos_e1_runtime"), true, routine);
        for (const role of ["abos_e1_treasury_runtime", "abos_v1_identity_runtime", "abos_e1_frozen_lane"]) assert.equal(await may(role), false, `${role}: ${routine}`);
        const owner = (await h.pool.query<{ owner: string; secdef: boolean; pub: number }>(`SELECT pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS secdef,
          (SELECT count(*)::int FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0) AS pub FROM pg_proc p WHERE p.oid = $1::regprocedure`, [routine])).rows[0];
        assert.deepEqual(owner, { owner: "abos_v1_operational_finance_owner", secdef: true, pub: 0 }, routine);
      }
      for (const table of ["treasury_opening_balances", "operational_treasury_account_responsibles", "treasury_account_legacy_links"]) {
        for (const role of ["abos_e1_runtime", "abos_e1_treasury_runtime", "abos_v1_identity_runtime"]) {
          assert.equal((await h.pool.query<{ ok: boolean }>("SELECT has_table_privilege($1, $2, 'SELECT,INSERT,UPDATE,DELETE') AS ok", [role, `abos.${table}`])).rows[0]?.ok, false, `${role} on ${table}`);
        }
      }
      await assert.rejects(() => h.pool.query("UPDATE abos.treasury_opening_balances SET amount = 1"), /append-only/);
    });

    test("lifecycle: CLOSED only at a zero book balance, terminal; a closed or inactive Safe takes no opening balance", async () => {
      const f = await fixture();
      await open(f);
      await assert.rejects(() => upsert(f, f.safe, f.world.cashLedgerAccountId, "CLOSED", 1), /a Treasury account can be closed only at a zero book balance/);
      await upsert(f, f.second, f.secondLedger, "CLOSED", 1);
      assert.equal((await safeOf(f, f.second)).status, "CLOSED");
      await assert.rejects(() => upsert(f, f.second, f.secondLedger, "ACTIVE", 2), /a closed Treasury account cannot change/);
      await assert.rejects(() => open(f, { treasuryAccountId: f.second }), /an opening balance needs an active Safe/);
      await assert.rejects(() => h.pool.query(`INSERT INTO abos.operational_treasury_accounts (id,legal_entity_id,name_en,account_type,currency_code,ledger_account_id,status,version,created_by_user_account_id,last_changed_by_user_account_id)
        VALUES($1,$2,'Born closed','SAFE','USD',$3,'CLOSED',1,$4,$4)`, [randomUUID(), f.world.legalEntityId, f.secondLedger, f.world.bootstrapUserId]),
      /created ACTIVE or INACTIVE|duplicate key/);
      const ws = await workspace(f.actor);
      assert.deepEqual(ws.safes.map((s) => s.status), ["ACTIVE", "CLOSED"], "active Safes first, closed last");
    });
  });
}
