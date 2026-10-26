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

// All fixture writes target a disposable test database. Never consume local runtime credentials.
const MARKER = SYNTHETIC_AUTH_CONFIGURATION.runtimeMarker;
const WRITE_PERMISSIONS = ["shareholder.setup.manage", "shareholder.capital-receipt.read",
  "shareholder.capital-receipt.record", "finance.capital-receipt.prepare", "finance.capital-receipt.post"];
type Session = { proof: string; runtimeDigest: string; tokenDigest: string; sessionId: string };
type Fixture = { world: SyntheticWorld; actor: Session; safe: string; assetAccount: string; billAccount: string };
type Creation = { shareholderProfileId: string; contributionId: string | null;
  agreedTotal: string | null; firstReceipt: Receipt | null };
type Receipt = { receiptId: string; journalId: string; reference: string; status: string; replayed: boolean };
type Workspace = { shareholders: { id: string; name: string; note: string | null; capitals: {
  currency: string; contributed: string; agreedTotal: string | null; remaining: string | null }[];
  transactions: { id: string; method: string; destination: string | null; providerName: string | null;
    itemDescription: string | null; debitAccount: string | null; amount: string }[] }[];
  destinations: { id: string; name: string; currency: string; balance: string | null }[];
  assetAccountReady: boolean; expenseAccounts: { id: string; code: string; name: string }[] };

if (databaseUrl() === undefined) {
  test("direct shareholder capital requires real PostgreSQL", () => assert.fail(MISSING_DATABASE_MESSAGE));
} else {
  describe("direct shareholder capital: restricted PostgreSQL acceptance and attack paths", () => {
    let h: Harness; let runtime: PostgresExecutor; let runtimePool: pg.Pool;
    let treasury: PostgresExecutor; let treasuryPool: pg.Pool;
    const login = `abos_direct_capital_${randomUUID().replaceAll("-", "")}`;
    const treasuryLogin = `abos_direct_treasury_${randomUUID().replaceAll("-", "")}`;
    before(async () => {
      const target = new URL(databaseUrl() ?? "");
      assert.notEqual(target.port, "55432", "preserved runtime PostgreSQL is forbidden");
      assert.notEqual(decodeURIComponent(target.pathname.slice(1)), "abos_v1_local_review");
      h = await openHarness(MARKER);
      await resetSchema(h.pool);
      const password = `disposable-${randomUUID()}`;
      await h.pool.query(`CREATE ROLE ${login} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${password}'`);
      await h.pool.query(`GRANT abos_e1_runtime TO ${login}`);
      const url = new URL(databaseUrl() ?? ""); url.username = login; url.password = password;
      runtimePool = new pg.Pool({ connectionString: url.toString(), max: 4 });
      runtime = new PostgresExecutor(runtimePool, { runtimeMarker: MARKER });
      await h.pool.query(`CREATE ROLE ${treasuryLogin} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${password}'`);
      await h.pool.query(`GRANT abos_e1_treasury_runtime TO ${treasuryLogin}`);
      url.username = treasuryLogin;
      treasuryPool = new pg.Pool({ connectionString: url.toString(), max: 3 });
      treasury = new PostgresExecutor(treasuryPool, { runtimeMarker: MARKER });
    });
    after(async () => {
      await runtimePool?.end();
      await treasuryPool?.end();
      if (h !== undefined) {
        await h.pool.query(`DROP ROLE IF EXISTS ${login}`);
        await h.pool.query(`DROP ROLE IF EXISTS ${treasuryLogin}`);
        await h.close();
      }
    });

    async function fixture(): Promise<Fixture> {
      await resetSchema(h.pool);
      const world = await seedSyntheticWorld(h.executor);
      // Seed setup uses the historical sandbox. Operational calls below deliberately cannot.
      await h.pool.query("DELETE FROM abos.sandbox_legal_entity_scopes");
      await h.pool.query("DELETE FROM abos.sandbox_authorizations");
      await grant(h.executor, world, world.intentCreatorId, WRITE_PERMISSIONS);
      await grant(h.executor, world, world.intentCreatorId, ["finance.report.operational.read"]);
      const safe = randomUUID();
      await h.pool.query(`INSERT INTO abos.operational_treasury_accounts
        (id,legal_entity_id,name_en,account_type,currency_code,ledger_account_id,status,version,
         created_by_user_account_id,last_changed_by_user_account_id)
        VALUES($1,$2,'Synthetic direct-capital Safe','SAFE','USD',$3,'ACTIVE',1,$4,$4)`,
      [safe, world.legalEntityId, world.cashLedgerAccountId, world.bootstrapUserId]);
      await h.pool.query(`INSERT INTO abos.finance_workflow_policy_versions
        (id,legal_entity_id,workflow_type,version,approval_required,configured_by_user_account_id,change_reason)
        VALUES($1,$2,'SHAREHOLDER_CAPITAL_RECEIPT',1,false,$3,'Synthetic direct-capital test policy')`,
      [randomUUID(), world.legalEntityId, world.bootstrapUserId]);
      const assetAccount = randomUUID();
      await h.pool.query(`INSERT INTO abos.ledger_accounts
        (id,legal_entity_id,account_code,account_name,account_type,control_account_type,
         posting_allowed,account_currency_code,status)
        VALUES($1,$2,'SYN-CONTRIB-ASSET','Synthetic shareholder contributed assets','ASSET',
               'SHAREHOLDER_CONTRIBUTED_ASSETS',true,'USD','ACTIVE')`,
      [assetAccount, world.legalEntityId]);
      const billAccount = randomUUID();
      await h.pool.query(`INSERT INTO abos.ledger_accounts
        (id,legal_entity_id,account_code,account_name,account_type,posting_allowed,account_currency_code,status)
        VALUES($1,$2,'SYN-DIRECT-BILL','Synthetic bill a shareholder paid','EXPENSE',true,'USD','ACTIVE')`,
      [billAccount, world.legalEntityId]);
      return { world, safe, assetAccount, billAccount, actor: await session(world, world.intentCreatorId) };
    }
    async function session(world: SyntheticWorld, actor: string): Promise<Session> {
      const issued = await issueOperationalSession(h, actor, world.legalEntityId);
      return args(issued.token, issued.sessionId);
    }
    async function call<T>(name: string, s: Session, payload?: object, db = runtime, date?: string): Promise<T> {
      const parameters: unknown[] = [s.proof, s.runtimeDigest, s.tokenDigest];
      if (payload !== undefined) parameters.push(JSON.stringify(payload));
      if (date !== undefined) parameters.push(date);
      const tail = payload !== undefined ? ",$4::jsonb" : date !== undefined ? ",$4::date" : "";
      const result = await db.query<{ value: T }>(
        `SELECT abos.${name}($1,$2,$3${tail}) AS value`, parameters);
      assert.ok(result.rows[0]); return result.rows[0].value;
    }
    // One save. An agreed total is optional, and so is the money recorded with it.
    const add = (f: Fixture, extra: object = {}) => call<Creation>("direct_shareholder_add", f.actor, {
      displayName: `Synthetic Direct Shareholder ${randomUUID()}`, agreedTotal: "100000", currencyCode: "USD",
      externalReference: null, note: null, businessDate: "2026-09-22", ...keys(), ...extra });
    const create = add;
    const payload = (f: Fixture, id: string, extra: object = {}) => ({ shareholderProfileId: id,
      fundingMethod: "CASH", amount: "20000",
      currencyCode: "USD", receiptDate: "2026-09-23", destinationAccountId: f.safe,
      paymentReference: "SYNTHETIC-RECEIPT", note: null, ...keys(), ...extra });
    const contribution = (f: Fixture, extra: object = {}) => ({ fundingMethod: "CASH", amount: "20000",
      currencyCode: "USD", receiptDate: "2026-09-23", destinationAccountId: f.safe,
      paymentReference: "SYNTHETIC-FIRST", note: null, ...extra });
    const receive = (f: Fixture, id: string, extra: object = {}) =>
      call<Receipt>("direct_shareholder_receive", f.actor, payload(f, id, extra));
    const legacyReceive = (f: Fixture, contributionId: string, amount: string) =>
      call("record_shareholder_capital_receipt", f.actor, { contributionId, expectedContributionVersion: 1,
        amount: { amount, currency: "USD" }, receiptDate: "2026-09-23", treasuryDestinationId: f.safe,
        paymentReference: "SYNTHETIC-LEGACY-RESERVATION", evidenceReferenceId: null, ...keys() }, treasury);
    const workspace = (s: Session) => call<Workspace>("direct_shareholder_capital_workspace", s);
    async function counts() {
      const result = await h.pool.query(`SELECT
        (SELECT count(*)::int FROM abos.direct_capital_receipts) AS receipts,
        (SELECT count(*)::int FROM abos.direct_capital_receipt_allocations) AS allocations,
        (SELECT count(*)::int FROM abos.journals) AS journals,
        (SELECT count(*)::int FROM abos.journal_lines) AS lines,
        (SELECT count(*)::int FROM abos.posting_intents) AS intents,
        (SELECT count(*)::int FROM abos.subledger_entries) AS subledgers`);
      return result.rows[0];
    }
    async function zero() {
      assert.deepEqual(await counts(), { receipts: 0, allocations: 0, journals: 0, lines: 0, intents: 0, subledgers: 0 });
    }

    test("shareholder creation and declaration remain non-financial without any sandbox authorization", async () => {
      const f = await fixture(); const created = await create(f, { note: "Synthetic owner note" });
      assert.ok(created.shareholderProfileId); assert.ok(created.contributionId);
      await zero();
      const row = await h.pool.query(`SELECT p.capital_note,
        c.record_status,c.receipt_status,c.amount::text AS amount FROM abos.shareholder_profiles p
        JOIN abos.shareholder_contributions c ON c.shareholder_profile_id=p.id WHERE p.id=$1`, [created.shareholderProfileId]);
      assert.deepEqual(row.rows[0], { capital_note: "Synthetic owner note",
        record_status: "DECLARED", receipt_status: "NOT_RECEIVED", amount: "100000" });
      const view = (await workspace(f.actor)).shareholders.find(s => s.id === created.shareholderProfileId);
      assert.ok(view); assert.equal(Number(view.capitals[0]?.agreedTotal), 100000);
      assert.equal(Number(view.capitals[0]?.contributed), 0); assert.equal(Number(view.capitals[0]?.remaining), 100000);
      assert.equal((await h.pool.query("SELECT count(*)::int AS n FROM abos.sandbox_authorizations")).rows[0]?.n, 0);
    });

    test("creation retries preserve one shareholder and one declaration; invalid capital rolls back the profile", async () => {
      const f = await fixture(); const k = keys(); const input = { displayName: "Synthetic idempotent shareholder", ...k };
      const first = await create(f, input); const replay = await create(f, input);
      assert.equal(replay.shareholderProfileId, first.shareholderProfileId);
      assert.equal(replay.contributionId, first.contributionId);
      await assert.rejects(() => create(f, { ...input, agreedTotal: "110000" }), /idempotency|conflict|already used/i);
      const before = await h.pool.query("SELECT count(*)::int AS n FROM abos.shareholder_profiles");
      await assert.rejects(() => create(f, { agreedTotal: "0" }), /amount|positive/i);
      assert.deepEqual((await h.pool.query("SELECT count(*)::int AS n FROM abos.shareholder_profiles")).rows, before.rows);
      await assert.rejects(() => create(f, { agreedTotal: "100000", currencyCode: null }), /currency/i);
      await zero();
    });

    test("optional private document holder is stable, remains DRAFT and is not a receipt prerequisite", async () => {
      const f = await fixture(); const s = await create(f);
      const p = { shareholderProfileId: s.shareholderProfileId };
      const first = await call<{ capitalAgreementId: string }>("direct_shareholder_document_holder", f.actor, p);
      const again = await call<{ capitalAgreementId: string }>("direct_shareholder_document_holder", f.actor, p);
      assert.equal(again.capitalAgreementId, first.capitalAgreementId);
      const row = await h.pool.query("SELECT status FROM abos.capital_agreements WHERE id=$1", [first.capitalAgreementId]);
      assert.equal(row.rows[0]?.status, "DRAFT");
      assert.equal((await h.pool.query("SELECT count(*)::int AS n FROM abos.capital_agreement_document_files WHERE capital_agreement_id=$1", [first.capitalAgreementId])).rows[0]?.n, 0);
      await assert.rejects(() => call("direct_shareholder_document_holder", f.actor, { shareholderProfileId: randomUUID() }), /shareholder|entity|found/i);
      await zero();
      const receipt = await receive(f, s.shareholderProfileId);
      assert.equal(receipt.status, "POSTED", "missing optional physical agreement does not block receipt");
      assert.equal((await h.pool.query("SELECT status FROM abos.capital_agreements WHERE id=$1", [first.capitalAgreementId])).rows[0]?.status, "DRAFT");
    });

    test("20,000 then 10,000 receipts produce exactly balanced linked journals and accurate remaining capital", async () => {
      const f = await fixture(); const s = await create(f);
      const first = await receive(f, s.shareholderProfileId); const second = await receive(f, s.shareholderProfileId, { amount: "10000" });
      assert.equal(first.status, "POSTED"); assert.notEqual(first.journalId, second.journalId);
      assert.deepEqual(await counts(), { receipts: 2, allocations: 2, journals: 2, lines: 4, intents: 2, subledgers: 4 });
      const lines = await h.pool.query(`SELECT ledger_account_id::text AS ledger,sum(base_debit)::text AS debit,
        sum(base_credit)::text AS credit FROM abos.journal_lines GROUP BY ledger_account_id ORDER BY ledger_account_id`);
      assert.deepEqual(lines.rows, [{ ledger: f.world.cashLedgerAccountId, debit: "30000", credit: "0" },
        { ledger: f.world.capitalLedgerAccountId, debit: "0", credit: "30000" }].sort((a,b) => a.ledger.localeCompare(b.ledger)));
      const links = await h.pool.query(`SELECT r.id::text AS receipt,r.journal_id::text AS journal,
        i.source_type,i.processing_model,i.status,count(s.id)::int AS subledgers
        FROM abos.direct_capital_receipts r JOIN abos.posting_intents i ON i.direct_capital_receipt_id=r.id
        JOIN abos.subledger_entries s ON s.direct_capital_receipt_id=r.id GROUP BY r.id,i.id ORDER BY r.id`);
      assert.equal(links.rows.length, 2);
      for (const row of links.rows) {
        assert.equal(row.source_type, "DIRECT_SHAREHOLDER_CAPITAL"); assert.equal(row.processing_model, "OPERATIONAL_V1");
        assert.equal(row.status, "POSTED"); assert.equal(row.subledgers, 2);
      }
      assert.deepEqual((await h.pool.query(`SELECT subledger_type,sum(original_amount)::text AS amount
        FROM abos.subledger_entries GROUP BY subledger_type ORDER BY subledger_type`)).rows,
      [{ subledger_type: "OPERATIONAL_TREASURY", amount: "30000" }, { subledger_type: "SHAREHOLDER_CAPITAL", amount: "-30000" }]);
      assert.equal((await h.pool.query("SELECT sum(original_amount)::text AS amount FROM abos.subledger_entries")).rows[0]?.amount, "0");
      const view = await workspace(f.actor); const cap = view.shareholders.find(x => x.id === s.shareholderProfileId)?.capitals[0];
      assert.ok(cap); assert.equal(Number(cap.contributed), 30000); assert.equal(Number(cap.remaining), 70000);
      assert.equal(Number(view.destinations.find(x => x.id === f.safe)?.balance), 30000);
      assert.equal((await h.pool.query("SELECT count(*)::int AS n FROM abos.posting_approvals")).rows[0]?.n, 0);
      assert.equal((await h.pool.query("SELECT count(*)::int AS n FROM abos.shareholder_capital_receipt_custody_verifications")).rows[0]?.n, 0);
    });

    test("same-key retry is durable; changed payload is refused without duplicate journal or audit", async () => {
      const f = await fixture(); const s = await create(f); const p = payload(f, s.shareholderProfileId);
      const first = await call<Receipt>("direct_shareholder_receive", f.actor, p);
      const audit = await h.pool.query("SELECT count(*)::int AS n FROM abos.audit_records");
      const retry = await call<Receipt>("direct_shareholder_receive", f.actor, { ...p, correlationId: randomUUID() });
      assert.equal(retry.receiptId, first.receiptId); assert.equal(retry.journalId, first.journalId);
      assert.deepEqual(await counts(), { receipts: 1, allocations: 1, journals: 1, lines: 2, intents: 1, subledgers: 2 });
      assert.deepEqual((await h.pool.query("SELECT count(*)::int AS n FROM abos.audit_records")).rows, audit.rows);
      await assert.rejects(() => call("direct_shareholder_receive", f.actor, { ...p, amount: "20001" }), /idempotency|already used|conflict/i);
    });

    test("double-submit concurrently resolves to a single durable receipt", async () => {
      const f = await fixture(); const s = await create(f); const p = payload(f, s.shareholderProfileId);
      const results = await Promise.all([call<Receipt>("direct_shareholder_receive", f.actor, p), call<Receipt>("direct_shareholder_receive", f.actor, p)]);
      assert.equal(results[0]?.receiptId, results[1]?.receiptId);
      assert.deepEqual(await counts(), { receipts: 1, allocations: 1, journals: 1, lines: 2, intents: 1, subledgers: 2 });
    });

    test("money beyond an optional agreed total is recorded, not refused, and never over-allocates", async () => {
      const f = await fixture(); const s = await create(f);
      const posted = await receive(f, s.shareholderProfileId, { amount: "100000.01" });
      assert.equal(posted.status, "POSTED");
      // The declaration absorbs exactly its own amount; the extra cent stays unallocated capital.
      assert.equal((await h.pool.query("SELECT sum(amount)::text AS amount FROM abos.direct_capital_receipt_allocations")).rows[0]?.amount, "100000");
      const cap = (await workspace(f.actor)).shareholders.find(x => x.id === s.shareholderProfileId)?.capitals[0];
      assert.equal(cap?.contributed, "100000.01"); assert.equal(cap?.agreedTotal, "100000");
      assert.equal(cap?.remaining, "-0.01", "contributing more than agreed shows a negative remainder, not an error");
      const results = await Promise.allSettled([receive(f, s.shareholderProfileId, { amount: "60000" }), receive(f, s.shareholderProfileId, { amount: "60000" })]);
      assert.equal(results.filter(x => x.status === "fulfilled").length, 2, "two genuine arrivals both post");
      assert.deepEqual(await counts(), { receipts: 3, allocations: 1, journals: 3, lines: 6, intents: 3, subledgers: 6 });
    });

    test("a shareholder with no agreed total records capital with no declaration behind it", async () => {
      const f = await fixture(); const s = await create(f, { agreedTotal: null, currencyCode: null });
      assert.equal(s.contributionId, null);
      assert.equal((await h.pool.query("SELECT count(*)::int AS n FROM abos.shareholder_contributions WHERE shareholder_profile_id=$1", [s.shareholderProfileId])).rows[0]?.n, 0);
      const posted = await receive(f, s.shareholderProfileId, { amount: "7500" });
      assert.equal(posted.status, "POSTED");
      assert.deepEqual(await counts(), { receipts: 1, allocations: 0, journals: 1, lines: 2, intents: 1, subledgers: 2 });
      const cap = (await workspace(f.actor)).shareholders.find(x => x.id === s.shareholderProfileId)?.capitals[0];
      assert.equal(cap?.contributed, "7500");
      assert.equal(cap?.agreedTotal, null); assert.equal(cap?.remaining, null, "no target means nothing outstanding");
    });

    test("one receipt can allocate across existing declarations without agreements or mandatory installments", async () => {
      const f = await fixture(); const s = await create(f);
      await call("shareholder_contribution_create", f.actor, { shareholderProfileId: s.shareholderProfileId,
        contributionType: "CASH", businessDate: "2026-09-22", amount: "50000", currencyCode: "USD",
        description: "Synthetic additional declaration", reference: null, declare: true, ...keys() });
      const before = await h.pool.query("SELECT (SELECT count(*) FROM abos.capital_agreements)::int AS agreements,(SELECT count(*) FROM abos.capital_installments)::int AS installments");
      await receive(f, s.shareholderProfileId, { amount: "120000" });
      assert.deepEqual(await counts(), { receipts: 1, allocations: 2, journals: 1, lines: 2, intents: 1, subledgers: 2 });
      assert.deepEqual((await h.pool.query("SELECT (SELECT count(*) FROM abos.capital_agreements)::int AS agreements,(SELECT count(*) FROM abos.capital_installments)::int AS installments")).rows, before.rows);
      const allocations = await h.pool.query("SELECT sum(amount)::text AS amount FROM abos.direct_capital_receipt_allocations");
      assert.equal(allocations.rows[0]?.amount, "120000");
      // Declarations are now fully consumed, so further genuine money is recorded unallocated.
      assert.equal((await receive(f, s.shareholderProfileId, { amount: "30000.01" })).status, "POSTED");
      assert.equal(allocations.rows[0]?.amount, "120000");
    });

    test("the existing receipt lane still cannot exceed a declaration the direct lane has consumed", async () => {
      const f = await fixture(); const s = await create(f);
      assert.ok(s.contributionId);
      await receive(f, s.shareholderProfileId, { amount: "60000" });
      await assert.rejects(() => legacyReceive(f, s.contributionId ?? "", "40000.01"), /outstanding|exceed|available|allocated/i);
      await legacyReceive(f, s.contributionId ?? "", "40000");
      // The legacy lane only reserves; it posts nothing by itself, so the ledger is untouched.
      assert.deepEqual(await counts(), { receipts: 1, allocations: 1, journals: 1, lines: 2, intents: 1, subledgers: 2 });
      const legacy = await h.pool.query("SELECT original_amount::text AS amount FROM abos.shareholder_capital_receipts WHERE contribution_id=$1", [s.contributionId]);
      assert.deepEqual(legacy.rows, [{ amount: "40000" }]);
      const cap = (await workspace(f.actor)).shareholders.find(x => x.id === s.shareholderProfileId)?.capitals[0];
      assert.equal(cap?.contributed, "60000", "a reserved but unposted legacy receipt is not contributed capital");
      assert.equal(cap?.remaining, "40000");
    });

    test("concurrent direct and legacy receipts cannot over-allocate a shared declaration", async () => {
      const f = await fixture(); const s = await create(f);
      await Promise.allSettled([receive(f, s.shareholderProfileId, { amount: "60000" }), legacyReceive(f, s.contributionId ?? "", "60000")]);
      const total = await h.pool.query(`SELECT
        COALESCE((SELECT sum(amount) FROM abos.direct_capital_receipt_allocations WHERE contribution_id=$1),0)
        +COALESCE((SELECT sum(original_amount) FROM abos.shareholder_capital_receipts WHERE contribution_id=$1 AND record_state='RECORDED'),0) AS amount`, [s.contributionId]);
      assert.ok(Number(total.rows[0]?.amount) <= 100000, "the declaration is never allocated beyond its amount");
    });

    test("a late posting failure rolls back source, journal, subledgers, audit and idempotency together", async () => {
      const f = await fixture(); const s = await create(f); const p = payload(f, s.shareholderProfileId);
      const before = await h.pool.query("SELECT (SELECT count(*) FROM abos.audit_records)::int AS audits,(SELECT count(*) FROM abos.idempotency_records)::int AS commands");
      await h.pool.query(`CREATE FUNCTION abos.test_direct_post_failure() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.status='POSTED' THEN RAISE EXCEPTION 'disposable late posting failure'; END IF; RETURN NEW; END $$`);
      await h.pool.query("CREATE TRIGGER zz_test_direct_post_failure BEFORE UPDATE ON abos.journals FOR EACH ROW EXECUTE FUNCTION abos.test_direct_post_failure()");
      await assert.rejects(() => call("direct_shareholder_receive", f.actor, p), /disposable late posting failure/);
      await zero();
      assert.deepEqual((await h.pool.query("SELECT (SELECT count(*) FROM abos.audit_records)::int AS audits,(SELECT count(*) FROM abos.idempotency_records)::int AS commands")).rows, before.rows);
      await h.pool.query("DROP TRIGGER zz_test_direct_post_failure ON abos.journals");
      const retry = await call<Receipt>("direct_shareholder_receive", f.actor, p);
      assert.equal(retry.status, "POSTED");
    });

    test("a NULL shareholder credit party is rejected by exact journal validation and leaves no financial rows", async () => {
      const f = await fixture(); const s = await create(f); const p = payload(f, s.shareholderProfileId);
      // Disposable fault injection models a future broken writer. No runtime has this DDL authority.
      await h.pool.query(`CREATE FUNCTION abos.test_direct_null_credit_party() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.source_type='DIRECT_SHAREHOLDER_CAPITAL' AND NEW.line_number=2 THEN
          NEW.business_party_id:=NULL; END IF; RETURN NEW; END $$`);
      await h.pool.query(`CREATE TRIGGER test_direct_null_credit_party BEFORE INSERT ON abos.journal_lines
        FOR EACH ROW EXECUTE FUNCTION abos.test_direct_null_credit_party()`);
      await assert.rejects(() => call("direct_shareholder_receive", f.actor, p),
        /direct capital requires its exact method debit and shareholder equity credit/);
      await zero();
      await h.pool.query("DROP TRIGGER test_direct_null_credit_party ON abos.journal_lines");
      assert.equal((await call<Receipt>("direct_shareholder_receive", f.actor, p)).status, "POSTED");
    });

    test("received capital is visible in Daily Report and spendable through the ordinary expense lane", async () => {
      const f = await fixture(); const s = await create(f);
      await grant(h.executor, f.world, f.world.intentCreatorId, ["finance.expense.create", "finance.expense.read"]);
      await receive(f, s.shareholderProfileId); await receive(f, s.shareholderProfileId, { amount: "10000" });
      const report = async () => {
        const result = await runtime.query<{ value: { treasuryMovements: { treasuryAccountId: string; before: string; day: string; after: string }[] } }>(
          "SELECT abos.operational_finance_daily_report($1,$2,$3,$4::date) AS value",
          [f.actor.proof, f.actor.runtimeDigest, f.actor.tokenDigest, "2026-09-23"]);
        return result.rows[0]?.value.treasuryMovements.find(x => x.treasuryAccountId === f.safe);
      };
      assert.deepEqual(await report(), { treasuryAccountId: f.safe, nameEn: "Synthetic direct-capital Safe", nameFa: null,
        currency: "USD", status: "ACTIVE", before: "0", day: "30000", after: "30000" });
      const ledger = randomUUID(); const category = randomUUID();
      await h.pool.query(`INSERT INTO abos.ledger_accounts(id,legal_entity_id,account_code,account_name,account_type,posting_allowed,account_currency_code,status)
        VALUES($1,$2,'SYN-DIRECT-EXP','Synthetic direct capital funded expense','EXPENSE',true,'USD','ACTIVE')`, [ledger, f.world.legalEntityId]);
      await h.pool.query(`INSERT INTO abos.operational_expense_categories(id,legal_entity_id,category_code,name_en,ledger_account_id,status,version,created_by_user_account_id,last_changed_by_user_account_id)
        VALUES($1,$2,'SYN-DIRECT','Synthetic funded expense',$3,'ACTIVE',1,$4,$4)`, [category, f.world.legalEntityId, ledger, f.world.bootstrapUserId]);
      await h.pool.query(`INSERT INTO abos.finance_workflow_policy_versions(id,legal_entity_id,workflow_type,version,approval_required,configured_by_user_account_id,change_reason)
        VALUES($1,$2,'EXPENSE',1,false,$3,'Synthetic funded expense policy')`, [randomUUID(), f.world.legalEntityId, f.world.bootstrapUserId]);
      const expense = await call<{ expense: { status: string } }>("operational_expense_create", f.actor, {
        treasuryAccountId: f.safe, expenseCategoryId: category, payeeBusinessPartyId: null, projectId: null,
        departmentId: null, costCenterId: null, reference: `SYN-DIRECT-SPEND-${randomUUID()}`,
        description: "Synthetic expense funded by received capital", note: null, businessDate: "2026-09-23",
        originalAmount: "5000", currencyCode: "USD", exchangeRateId: null, ...keys() });
      assert.equal(expense.expense.status, "POSTED");
      assert.equal((await report())?.after, "25000");
      assert.equal((await workspace(f.actor)).destinations.find(x => x.id === f.safe)?.balance, "25000");
      const cap = (await workspace(f.actor)).shareholders.find(x => x.id === s.shareholderProfileId)?.capitals[0];
      assert.equal(cap?.contributed, "30000"); assert.equal(cap?.remaining, "70000");
      await grant(h.executor, f.world, f.world.cashierId, ["shareholder.setup.manage"]);
      const reader = await session(f.world, f.world.cashierId);
      assert.equal((await workspace(reader)).destinations.find(x => x.id === f.safe)?.balance, null,
        "shareholder setup permission cannot disclose financial account activity");
      await grant(h.executor, f.world, f.world.cashierId, ["finance.report.operational.read"]);
      assert.equal((await workspace(reader)).destinations.find(x => x.id === f.safe)?.balance, "25000");
      const hiddenProject = randomUUID();
      await h.pool.query("INSERT INTO abos.projects(id,legal_entity_id,code,name,active) VALUES($1,$2,'SYN-DIRECT-HIDDEN','Synthetic hidden project',true)", [hiddenProject, f.world.legalEntityId]);
      await h.pool.query(`INSERT INTO abos.user_scope_grants(user_account_id,legal_entity_id,scope_kind,scope_id,granted_by_user_account_id)
        VALUES($1,$2,'PROJECT',$3,$4)`, [f.world.intentCreatorId, f.world.legalEntityId, hiddenProject, f.world.bootstrapUserId]);
      await call("operational_expense_create", f.actor, {
        treasuryAccountId: f.safe, expenseCategoryId: category, payeeBusinessPartyId: null, projectId: hiddenProject,
        departmentId: null, costCenterId: null, reference: `SYN-HIDDEN-${randomUUID()}`,
        description: "Synthetic expense restricted by project", note: null, businessDate: "2026-09-23",
        originalAmount: "1000", currencyCode: "USD", exchangeRateId: null, ...keys() });
      assert.equal((await workspace(f.actor)).destinations.find(x => x.id === f.safe)?.balance, "24000");
      assert.equal((await workspace(reader)).destinations.find(x => x.id === f.safe)?.balance, "25000",
        "report permission alone cannot infer activity from an ungranted project");
    });

    test("missing, inactive, foreign and currency-mismatched Safes cannot receive", async () => {
      const f = await fixture(); const s = await create(f);
      await assert.rejects(() => receive(f, s.shareholderProfileId, { destinationAccountId: randomUUID() }), /treasury|safe|account|destination/i);
      await h.pool.query("UPDATE abos.operational_treasury_accounts SET status='INACTIVE',version=version+1,last_changed_at=clock_timestamp(),last_changed_by_user_account_id=$2 WHERE id=$1", [f.safe, f.world.intentCreatorId]);
      await assert.rejects(() => receive(f, s.shareholderProfileId), /treasury|safe|active/i);
      await h.pool.query("UPDATE abos.operational_treasury_accounts SET status='ACTIVE',version=version+1,last_changed_at=clock_timestamp(),last_changed_by_user_account_id=$2 WHERE id=$1", [f.safe, f.world.intentCreatorId]);
      await assert.rejects(() => receive(f, s.shareholderProfileId, { currencyCode: "AFN" }), /currency|accounting/i);
      const other = await seedSyntheticWorld(h.executor, { withoutSandboxAuthorization: true }); const otherSafe = randomUUID();
      await h.pool.query(`INSERT INTO abos.operational_treasury_accounts(id,legal_entity_id,name_en,account_type,currency_code,
        ledger_account_id,status,version,created_by_user_account_id,last_changed_by_user_account_id)
        VALUES($1,$2,'Synthetic foreign Safe','SAFE','USD',$3,'ACTIVE',1,$4,$4)`,
      [otherSafe, other.legalEntityId, other.cashLedgerAccountId, other.bootstrapUserId]);
      await assert.rejects(() => receive(f, s.shareholderProfileId, { destinationAccountId: otherSafe }), /treasury|safe|account|destination/i);
      await assert.rejects(() => receive(f, other.shareholderProfileId), /shareholder|entity|found/i);
      assert.equal((await workspace(f.actor)).shareholders.some(x => x.id === other.shareholderProfileId), false);
      await zero();
    });

    test("revoked read and write scope is checked again before an otherwise valid idempotent replay", async () => {
      const f = await fixture(); const s = await create(f); const p = payload(f, s.shareholderProfileId);
      await call<Receipt>("direct_shareholder_receive", f.actor, p);
      const before = await counts();
      await h.pool.query("UPDATE abos.user_permission_grants SET revoked_at=clock_timestamp() WHERE user_account_id=$1", [f.world.intentCreatorId]);
      await assert.rejects(() => call("direct_shareholder_receive", f.actor, p), denied);
      await assert.rejects(() => workspace(f.actor), denied);
      await assert.rejects(() => create(f), denied);
      assert.deepEqual(await counts(), before);
    });

    test("invalid amount, future date, missing date and unknown fields fail atomically", async () => {
      const f = await fixture(); const s = await create(f);
      for (const amount of ["0", "-1", "NaN", "Infinity", "1".repeat(41), "not-a-number"]) {
        await assert.rejects(() => receive(f, s.shareholderProfileId, { amount }), /amount|numeric|precision|invalid|positive/i);
      }
      for (const receiptDate of [null, "not-a-date", "2999-01-01"]) {
        await assert.rejects(() => receive(f, s.shareholderProfileId, { receiptDate }), /date|valid/i);
      }
      for (const idempotencyKey of [null, "", "short"]) {
        await assert.rejects(() => receive(f, s.shareholderProfileId, { idempotencyKey }), /idempotency|correlation|required/i);
      }
      await assert.rejects(() => receive(f, s.shareholderProfileId, { actorUserAccountId: f.world.bootstrapUserId }), /unknown|field/i);
      await zero();
    });

    test("decimal receipt amounts retain their exact precision through all accounting records", async () => {
      const f = await fixture(); const s = await create(f); const r = await receive(f, s.shareholderProfileId, { amount: "1.001" });
      assert.equal((await h.pool.query("SELECT original_amount::text AS amount FROM abos.direct_capital_receipts WHERE id=$1", [r.receiptId])).rows[0]?.amount, "1.001");
      const lines = await h.pool.query("SELECT sum(base_debit)::text AS debit,sum(base_credit)::text AS credit FROM abos.journal_lines WHERE journal_id=$1", [r.journalId]);
      assert.deepEqual(lines.rows[0], { debit: "1.001", credit: "1.001" });
      assert.deepEqual((await h.pool.query("SELECT original_amount::text AS amount FROM abos.subledger_entries WHERE direct_capital_receipt_id=$1 ORDER BY subledger_type", [r.receiptId])).rows, [{ amount: "1.001" }, { amount: "-1.001" }]);
    });

    test("closed period, approval ON and ambiguous capital ledger fail closed", async () => {
      const f = await fixture(); const s = await create(f);
      await h.pool.query("UPDATE abos.accounting_periods SET status='SOFT_CLOSED' WHERE id=$1", [f.world.accountingPeriodId]);
      await assert.rejects(() => receive(f, s.shareholderProfileId), /period|reopen|cannot/i);
      await h.pool.query("UPDATE abos.accounting_periods SET status='OPEN' WHERE id=$1", [f.world.accountingPeriodId]);
      await h.pool.query(`INSERT INTO abos.finance_workflow_policy_versions
        (id,legal_entity_id,workflow_type,version,approval_required,configured_by_user_account_id,change_reason)
        VALUES($1,$2,'SHAREHOLDER_CAPITAL_RECEIPT',2,true,$3,'Synthetic ON policy')`,
      [randomUUID(), f.world.legalEntityId, f.world.bootstrapUserId]);
      await assert.rejects(() => receive(f, s.shareholderProfileId), /approval|OFF/i);
      await h.pool.query(`INSERT INTO abos.finance_workflow_policy_versions
        (id,legal_entity_id,workflow_type,version,approval_required,configured_by_user_account_id,change_reason)
        VALUES($1,$2,'SHAREHOLDER_CAPITAL_RECEIPT',3,false,$3,'Synthetic OFF policy')`,
      [randomUUID(), f.world.legalEntityId, f.world.bootstrapUserId]);
      await h.pool.query(`INSERT INTO abos.ledger_accounts(id,legal_entity_id,account_code,account_name,account_type,
        control_account_type,posting_allowed,account_currency_code,status)
        VALUES($1,$2,'SYN-EQUITY-2','Synthetic conflicting equity','EQUITY','SHAREHOLDER_CAPITAL',true,'USD','ACTIVE')`,
      [randomUUID(), f.world.legalEntityId]);
      await assert.rejects(() => receive(f, s.shareholderProfileId), /one|equity|capital account/i);
      await zero();
    });

    test("live permissions, entity scope, session expiry and forged proof block direct posting", async () => {
      const f = await fixture(); const s = await create(f); const p = payload(f, s.shareholderProfileId);
      await assert.rejects(() => call("direct_shareholder_receive", { ...f.actor, proof: "f".repeat(64) }, p), /proof|identity/i);
      for (const permission of WRITE_PERMISSIONS.filter(x => x !== "shareholder.setup.manage" && x !== "shareholder.capital-receipt.read")) {
        await h.pool.query("UPDATE abos.user_permission_grants SET revoked_at=clock_timestamp() WHERE user_account_id=$1 AND permission_code=$2", [f.world.intentCreatorId, permission]);
        await assert.rejects(() => receive(f, s.shareholderProfileId), /authority|permission/i);
        await h.pool.query("UPDATE abos.user_permission_grants SET revoked_at=NULL WHERE user_account_id=$1 AND permission_code=$2", [f.world.intentCreatorId, permission]);
      }
      await h.pool.query("UPDATE abos.sandbox_sessions SET issued_at=now()-interval '2 hours',expires_at=now()-interval '1 hour' WHERE id=$1", [f.actor.sessionId]);
      await assert.rejects(() => receive(f, s.shareholderProfileId), /session|active|sign in|expired/i);
      await zero();
    });

    test("synthetic provenance cannot enter operational create, read or post entry points", async () => {
      const f = await fixture(); const s = await create(f);
      // The issuer needs its fixture authorization; provenance is still deliberately synthetic.
      await h.pool.query(`INSERT INTO abos.sandbox_authorizations(singleton,environment,configuration_state,policy_version_id,
        runtime_marker,authorized_by_user_account_id,authorized_at,expires_at)
        VALUES(true,'test','SYNTHETIC_TEST_ONLY',$1,$2,$3,clock_timestamp(),clock_timestamp()+interval '1 day')`,
      [f.world.policyVersionId, MARKER, f.world.bootstrapUserId]);
      await h.pool.query("INSERT INTO abos.sandbox_legal_entity_scopes(legal_entity_id,base_currency_code,authorized_by_user_account_id) VALUES($1,'USD',$2)", [f.world.legalEntityId, f.world.bootstrapUserId]);
      const issued = await new SandboxAuthenticator(h.executor, SYNTHETIC_AUTH_CONFIGURATION).issueSession({
        userAccountId: f.world.intentCreatorId as never, legalEntityId: f.world.legalEntityId as never });
      const developer = args(issued.token, "unused");
      await assert.rejects(() => workspace(developer), /password|operational|session|active/i);
      await assert.rejects(() => call("direct_shareholder_receive", developer, payload(f, s.shareholderProfileId)), /password|operational|session|active/i);
      await assert.rejects(() => create({ ...f, actor: developer }), /password|operational|session|active/i);
      await zero();
    });

    test("posted financial records and source allocations remain immutable", async () => {
      const f = await fixture(); const s = await create(f); const r = await receive(f, s.shareholderProfileId);
      for (const sql of [
        "UPDATE abos.direct_capital_receipts SET original_amount=1 WHERE id=$1",
        "DELETE FROM abos.direct_capital_receipts WHERE id=$1",
        "UPDATE abos.direct_capital_receipt_allocations SET amount=1 WHERE receipt_id=$1",
        "DELETE FROM abos.direct_capital_receipt_allocations WHERE receipt_id=$1"
      ]) await assert.rejects(() => h.pool.query(sql, [r.receiptId]), /immutable|append-only|cannot be changed|audit/i);
      await assert.rejects(() => h.pool.query("UPDATE abos.journal_lines SET base_debit=1 WHERE journal_id=$1", [r.journalId]), denied);
      await assert.rejects(() => h.pool.query("DELETE FROM abos.journals WHERE id=$1", [r.journalId]), /immutable|posted|cannot|restricted operational/i);
      const client = await h.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE abos_v1_operational_finance_owner");
        await assert.rejects(() => client.query("UPDATE abos.journals SET status='DRAFT' WHERE id=$1", [r.journalId]), /immutable|posted|cannot/i);
      } finally { await client.query("ROLLBACK"); client.release(); }
    });

    test("one save records the shareholder and the first money together, or neither", async () => {
      const f = await fixture();
      const created = await add(f, { agreedTotal: null, currencyCode: null, firstContribution: contribution(f) });
      assert.ok(created.firstReceipt); assert.equal(created.firstReceipt?.status, "POSTED");
      assert.deepEqual(await counts(), { receipts: 1, allocations: 0, journals: 1, lines: 2, intents: 1, subledgers: 2 });
      const holder = (await workspace(f.actor)).shareholders.find(x => x.id === created.shareholderProfileId);
      assert.equal(holder?.capitals[0]?.contributed, "20000");
      assert.equal(holder?.transactions[0]?.method, "CASH");
      // A contribution that cannot post takes the whole save with it: no orphan shareholder.
      const before = await h.pool.query("SELECT count(*)::int AS n FROM abos.shareholder_profiles");
      await assert.rejects(() => add(f, { displayName: "Synthetic rolled back shareholder",
        agreedTotal: null, currencyCode: null, firstContribution: contribution(f, { destinationAccountId: randomUUID() }) }),
      /treasury|safe|account|destination/i);
      assert.deepEqual((await h.pool.query("SELECT count(*)::int AS n FROM abos.shareholder_profiles")).rows, before.rows);
      assert.deepEqual(await counts(), { receipts: 1, allocations: 0, journals: 1, lines: 2, intents: 1, subledgers: 2 });
    });

    test("a hawala contribution lands in the chosen Safe and keeps the saraf and reference on the record", async () => {
      const f = await fixture(); const s = await create(f, { agreedTotal: null, currencyCode: null });
      const posted = await receive(f, s.shareholderProfileId, { fundingMethod: "HAWALA",
        providerName: "Synthetic Saraf Mahmood", paymentReference: "HAWALA-77421", amount: "12000" });
      assert.equal(posted.status, "POSTED");
      const row = await h.pool.query(`SELECT funding_method,provider_name,payment_reference,
        operational_treasury_account_id::text AS safe,debit_ledger_account_id::text AS debit
        FROM abos.direct_capital_receipts WHERE id=$1`, [posted.receiptId]);
      assert.deepEqual(row.rows[0], { funding_method: "HAWALA", provider_name: "Synthetic Saraf Mahmood",
        payment_reference: "HAWALA-77421", safe: f.safe, debit: f.world.cashLedgerAccountId });
      assert.deepEqual((await h.pool.query(`SELECT subledger_type,original_amount::text AS amount
        FROM abos.subledger_entries WHERE direct_capital_receipt_id=$1 ORDER BY subledger_type`, [posted.receiptId])).rows,
      [{ subledger_type: "OPERATIONAL_TREASURY", amount: "12000" }, { subledger_type: "SHAREHOLDER_CAPITAL", amount: "-12000" }]);
      assert.equal(Number((await workspace(f.actor)).destinations.find(x => x.id === f.safe)?.balance), 12000);
      await assert.rejects(() => receive(f, s.shareholderProfileId, { fundingMethod: "HAWALA", providerName: null }), /saraf/i);
      await assert.rejects(() => receive(f, s.shareholderProfileId, { providerName: "Synthetic Saraf" }), /saraf/i);
    });

    test("a contributed asset debits the contributed-assets account and moves no Safe", async () => {
      const f = await fixture(); const s = await create(f, { agreedTotal: null, currencyCode: null });
      const posted = await receive(f, s.shareholderProfileId, { fundingMethod: "ASSET", destinationAccountId: null,
        itemDescription: "Synthetic Hilux pickup, 2019", amount: "35000", paymentReference: null });
      assert.equal(posted.status, "POSTED");
      const row = await h.pool.query(`SELECT funding_method,item_description,
        operational_treasury_account_id::text AS safe,debit_ledger_account_id::text AS debit
        FROM abos.direct_capital_receipts WHERE id=$1`, [posted.receiptId]);
      assert.deepEqual(row.rows[0], { funding_method: "ASSET", item_description: "Synthetic Hilux pickup, 2019",
        safe: null, debit: f.assetAccount });
      assert.deepEqual((await h.pool.query(`SELECT subledger_type,original_amount::text AS amount
        FROM abos.subledger_entries WHERE direct_capital_receipt_id=$1`, [posted.receiptId])).rows,
      [{ subledger_type: "SHAREHOLDER_CAPITAL", amount: "-35000" }]);
      const lines = await h.pool.query(`SELECT ledger_account_id::text AS ledger,base_debit::text AS debit,base_credit::text AS credit
        FROM abos.journal_lines WHERE journal_id=$1 ORDER BY line_number`, [posted.journalId]);
      assert.deepEqual(lines.rows, [{ ledger: f.assetAccount, debit: "35000", credit: "0" },
        { ledger: f.world.capitalLedgerAccountId, debit: "0", credit: "35000" }]);
      assert.equal(Number((await workspace(f.actor)).destinations.find(x => x.id === f.safe)?.balance), 0,
        "an asset contribution never moves recorded cash");
      assert.equal((await workspace(f.actor)).assetAccountReady, true);
      await assert.rejects(() => receive(f, s.shareholderProfileId, { fundingMethod: "ASSET", itemDescription: "Synthetic asset" }),
        /Safe/i, "an asset contribution may not name a Safe");
      await assert.rejects(() => receive(f, s.shareholderProfileId, { fundingMethod: "ASSET", destinationAccountId: null, itemDescription: null }), /asset|bill/i);
    });

    test("a bill the shareholder paid directly debits the chosen expense account only", async () => {
      const f = await fixture(); const s = await create(f, { agreedTotal: null, currencyCode: null });
      const posted = await receive(f, s.shareholderProfileId, { fundingMethod: "BILL_PAYMENT", destinationAccountId: null,
        itemDescription: "Synthetic generator fuel invoice", expenseLedgerAccountId: f.billAccount,
        amount: "1800", paymentReference: null });
      assert.equal(posted.status, "POSTED");
      const lines = await h.pool.query(`SELECT ledger_account_id::text AS ledger,base_debit::text AS debit,base_credit::text AS credit
        FROM abos.journal_lines WHERE journal_id=$1 ORDER BY line_number`, [posted.journalId]);
      assert.deepEqual(lines.rows, [{ ledger: f.billAccount, debit: "1800", credit: "0" },
        { ledger: f.world.capitalLedgerAccountId, debit: "0", credit: "1800" }]);
      assert.equal(Number((await workspace(f.actor)).destinations.find(x => x.id === f.safe)?.balance), 0);
      assert.ok((await workspace(f.actor)).expenseAccounts.some(x => x.id === f.billAccount));
      // Only an ordinary expense account of this company may be debited this way.
      await assert.rejects(() => receive(f, s.shareholderProfileId, { fundingMethod: "BILL_PAYMENT", destinationAccountId: null,
        itemDescription: "Synthetic bill", expenseLedgerAccountId: f.world.cashLedgerAccountId }), /expense account/i);
      await assert.rejects(() => receive(f, s.shareholderProfileId, { fundingMethod: "BILL_PAYMENT", destinationAccountId: null,
        itemDescription: "Synthetic bill", expenseLedgerAccountId: randomUUID() }), /expense account/i);
      await assert.rejects(() => receive(f, s.shareholderProfileId, { expenseLedgerAccountId: f.billAccount }), /paid bill/i);
      await assert.rejects(() => receive(f, s.shareholderProfileId, { fundingMethod: "GIFT" }), /funding method/i);
    });

    test("a pending month inside the financial year opens itself once, audited, and closed books still refuse", async () => {
      const f = await fixture(); const s = await create(f);
      const fiscalYear = randomUUID(); const october = randomUUID();
      await h.pool.query(`INSERT INTO abos.fiscal_years(id,legal_entity_id,calendar_kind,fiscal_year,label_en,label_fa,
        starts_on,ends_on,generated_by_user_account_id)
        VALUES($1,$2,'GREGORIAN',2026,'FY 2026','۱۴۰۵','2026-10-01','2026-10-31',$3)`,
      [fiscalYear, f.world.legalEntityId, f.world.bootstrapUserId]);
      await h.pool.query(`INSERT INTO abos.accounting_periods(id,legal_entity_id,period_name,starts_on,ends_on,status,
        fiscal_year_id,period_sequence,period_name_fa)
        VALUES($1,$2,'2026-10','2026-10-01','2026-10-31','PENDING',$3,1,'میزان')`,
      [october, f.world.legalEntityId, fiscalYear]);
      const audits = await h.pool.query("SELECT count(*)::int AS n FROM abos.audit_records WHERE action='ACCOUNTING_PERIOD_OPENED'");
      const posted = await receive(f, s.shareholderProfileId, { receiptDate: "2026-10-05" });
      assert.equal(posted.status, "POSTED");
      const row = await h.pool.query("SELECT status,opened_by_user_account_id::text AS opener FROM abos.accounting_periods WHERE id=$1", [october]);
      assert.deepEqual(row.rows[0], { status: "OPEN", opener: f.world.intentCreatorId });
      assert.equal((await h.pool.query("SELECT count(*)::int AS n FROM abos.audit_records WHERE action='ACCOUNTING_PERIOD_OPENED'")).rows[0]?.n,
        (audits.rows[0]?.n ?? 0) + 1, "opening a month is audited exactly once");
      await receive(f, s.shareholderProfileId, { receiptDate: "2026-10-06", amount: "500" });
      assert.equal((await h.pool.query("SELECT count(*)::int AS n FROM abos.audit_records WHERE action='ACCOUNTING_PERIOD_OPENED'")).rows[0]?.n,
        (audits.rows[0]?.n ?? 0) + 1, "an already open month is not reopened");
      await h.pool.query("UPDATE abos.accounting_periods SET status='CLOSED',closed_by_user_account_id=$2,closed_at=clock_timestamp() WHERE id=$1",
        [october, f.world.bootstrapUserId]);
      await assert.rejects(() => receive(f, s.shareholderProfileId, { receiptDate: "2026-10-07" }), /period|reopen|cannot/i);
      // A date no period covers is still refused; no period or financial year is invented.
      await assert.rejects(() => receive(f, s.shareholderProfileId, { receiptDate: "2025-03-04" }), /period|financial year/i);
      // A pending month with no financial year behind it is not opened automatically either.
      const orphan = randomUUID();
      await h.pool.query(`INSERT INTO abos.accounting_periods(id,legal_entity_id,period_name,starts_on,ends_on,status)
        VALUES($1,$2,'2026-08','2026-08-01','2026-08-31','PENDING')`, [orphan, f.world.legalEntityId]);
      await assert.rejects(() => receive(f, s.shareholderProfileId, { receiptDate: "2026-08-11" }), /period|reopen|cannot/i);
    });

    test("the expense lane opens a pending month through its own entry point and refuses a closed one", async () => {
      const f = await fixture();
      await grant(h.executor, f.world, f.world.intentCreatorId, ["finance.expense.create", "finance.expense.read"]);
      const fiscalYear = randomUUID(); const october = randomUUID();
      await h.pool.query(`INSERT INTO abos.fiscal_years(id,legal_entity_id,calendar_kind,fiscal_year,label_en,label_fa,
        starts_on,ends_on,generated_by_user_account_id)
        VALUES($1,$2,'GREGORIAN',2026,'FY 2026','۱۴۰۵','2026-10-01','2026-10-31',$3)`,
      [fiscalYear, f.world.legalEntityId, f.world.bootstrapUserId]);
      await h.pool.query(`INSERT INTO abos.accounting_periods(id,legal_entity_id,period_name,starts_on,ends_on,status,
        fiscal_year_id,period_sequence,period_name_fa)
        VALUES($1,$2,'2026-10','2026-10-01','2026-10-31','PENDING',$3,1,'میزان')`,
      [october, f.world.legalEntityId, fiscalYear]);
      const ledger = randomUUID(); const category = randomUUID();
      await h.pool.query(`INSERT INTO abos.ledger_accounts(id,legal_entity_id,account_code,account_name,account_type,posting_allowed,account_currency_code,status)
        VALUES($1,$2,'SYN-PERIOD-EXP','Synthetic auto-open expense','EXPENSE',true,'USD','ACTIVE')`, [ledger, f.world.legalEntityId]);
      await h.pool.query(`INSERT INTO abos.operational_expense_categories(id,legal_entity_id,category_code,name_en,ledger_account_id,status,version,created_by_user_account_id,last_changed_by_user_account_id)
        VALUES($1,$2,'SYN-PERIOD','Synthetic auto-open expense',$3,'ACTIVE',1,$4,$4)`, [category, f.world.legalEntityId, ledger, f.world.bootstrapUserId]);
      await h.pool.query(`INSERT INTO abos.finance_workflow_policy_versions(id,legal_entity_id,workflow_type,version,approval_required,configured_by_user_account_id,change_reason)
        VALUES($1,$2,'EXPENSE',1,false,$3,'Synthetic auto-open expense policy')`, [randomUUID(), f.world.legalEntityId, f.world.bootstrapUserId]);
      const expense = (extra: object = {}) => call<{ expense: { status: string } }>("operational_expense_create", f.actor, {
        treasuryAccountId: f.safe, expenseCategoryId: category, payeeBusinessPartyId: null, projectId: null,
        departmentId: null, costCenterId: null, reference: `SYN-PERIOD-${randomUUID()}`,
        description: "Synthetic expense on an unopened month", note: null, businessDate: "2026-10-05",
        originalAmount: "25", currencyCode: "USD", exchangeRateId: null, ...keys(), ...extra });
      // Without the period step the expense lane still refuses, exactly as before.
      await assert.rejects(() => expense(), /period|open/i);
      const opened = await call<{ accountingPeriodId: string; periodName: string }>(
        "operational_period_ensure_open", f.actor, undefined, runtime, "2026-10-05");
      assert.equal(opened.accountingPeriodId, october); assert.equal(opened.periodName, "2026-10");
      assert.equal((await h.pool.query("SELECT status FROM abos.accounting_periods WHERE id=$1", [october])).rows[0]?.status, "OPEN");
      // Capital first, so the Safe actually holds the money this expense pays out.
      const s = await create(f);
      await receive(f, s.shareholderProfileId, { receiptDate: "2026-10-05", amount: "500" });
      assert.equal((await expense()).expense.status, "POSTED");
      await h.pool.query("UPDATE abos.accounting_periods SET status='CLOSED',closed_by_user_account_id=$2,closed_at=clock_timestamp() WHERE id=$1",
        [october, f.world.bootstrapUserId]);
      await assert.rejects(() => call("operational_period_ensure_open", f.actor, undefined, runtime, "2026-10-05"), /period|reopen|cannot/i);
      // Opening a month is Finance work: expense authority is required, and a synthetic session is not.
      const reader = await session(f.world, f.world.cashierId);
      await assert.rejects(() => call("operational_period_ensure_open", reader, undefined, runtime, "2026-09-10"), denied);
    });

    test("runtime cannot bypass the functions with direct table DML or privileged helper execution", async () => {
      const f = await fixture(); const s = await create(f);
      for (const table of ["direct_capital_receipts", "direct_capital_receipt_allocations", "journals", "journal_lines", "posting_intents", "subledger_entries"]) {
        await assert.rejects(() => runtime.query(`SELECT * FROM abos.${table}`), /permission denied/i);
        await assert.rejects(() => runtime.query(`DELETE FROM abos.${table} WHERE false`), /permission denied/i);
        await assert.rejects(() => runtime.query(`INSERT INTO abos.${table} DEFAULT VALUES`), /permission denied/i);
      }
      await assert.rejects(() => runtime.query("UPDATE abos.shareholder_profiles SET capital_note='x' WHERE id=$1", [s.shareholderProfileId]), /permission denied/i);
      await assert.rejects(() => runtime.query("SET ROLE abos_v1_operational_finance_owner"), /permission denied/i);
      await assert.rejects(() => runtime.query("SELECT abos.direct_capital_equity($1,'USD')", [f.world.legalEntityId]), /permission denied/i);
      const publicExec = await h.pool.query(`SELECT p.proname FROM pg_proc p CROSS JOIN LATERAL
        aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
        WHERE p.pronamespace='abos'::regnamespace AND p.proname LIKE 'direct_%'
        AND a.grantee=0 AND a.privilege_type='EXECUTE'`);
      assert.deepEqual(publicExec.rows, []);
      const unsafeOwners = await h.pool.query(`SELECT p.proname,r.rolname FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
        WHERE p.pronamespace='abos'::regnamespace AND p.proname IN
          ('direct_shareholder_add','direct_shareholder_receive','direct_shareholder_capital_workspace','direct_shareholder_document_holder')
          AND (r.rolcanlogin OR r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolbypassrls)`);
      assert.deepEqual(unsafeOwners.rows, []);
      const directDml = await h.pool.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='abos' AND c.relkind='r' AND
          (has_table_privilege($1,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE') OR
           has_any_column_privilege($1,c.oid,'INSERT,UPDATE'))`, [login]);
      assert.deepEqual(directDml.rows, [], "restricted Finance credential gains no financial or other direct table writes");
      await zero();
    });
  });
}

function keys() { return { idempotencyKey: `direct-test-${randomUUID()}`, correlationId: randomUUID() }; }
function args(token: string, sessionId: string): Session {
  return { sessionId, proof: identityDatabaseProof(SYNTHETIC_AUTH_CONFIGURATION.signingSecret),
    runtimeDigest: createHash("sha256").update(token).digest("hex"),
    tokenDigest: createHmac("sha256", SYNTHETIC_AUTH_CONFIGURATION.signingSecret).update(token).digest("hex") };
}
function denied(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "42501"
    && /authority|permission|active account|restricted operational|sign in/i.test(error.message);
}
