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
type Fixture = { world: SyntheticWorld; actor: Session; safe: string };
type Creation = { shareholderProfileId: string; contributionId: string };
type Receipt = { receiptId: string; journalId: string; reference: string; status: string; replayed: boolean };
type Workspace = { shareholders: { id: string; name: string; capitals: {
  currency: string; total: string; received: string; outstanding: string; available: string }[] }[];
  destinations: { id: string; name: string; currency: string; balance: string | null }[] };

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
      return { world, safe, actor: await session(world, world.intentCreatorId) };
    }
    async function session(world: SyntheticWorld, actor: string): Promise<Session> {
      const issued = await issueOperationalSession(h, actor, world.legalEntityId);
      return args(issued.token, issued.sessionId);
    }
    async function call<T>(name: string, s: Session, payload?: object, db = runtime): Promise<T> {
      const parameters: unknown[] = [s.proof, s.runtimeDigest, s.tokenDigest];
      if (payload !== undefined) parameters.push(JSON.stringify(payload));
      const result = await db.query<{ value: T }>(
        `SELECT abos.${name}($1,$2,$3${payload === undefined ? "" : ",$4::jsonb"}) AS value`, parameters);
      assert.ok(result.rows[0]); return result.rows[0].value;
    }
    const create = (f: Fixture, extra: object = {}) => call<Creation>("direct_shareholder_create", f.actor, {
      displayName: `Synthetic Direct Shareholder ${randomUUID()}`, totalCapital: "100000", currencyCode: "USD",
      ownershipPercent: null, externalReference: null, note: null, businessDate: "2026-09-22", ...keys(), ...extra });
    const payload = (f: Fixture, id: string, extra: object = {}) => ({ shareholderProfileId: id, amount: "20000",
      currencyCode: "USD", receiptDate: "2026-09-23", destinationAccountId: f.safe,
      paymentReference: "SYNTHETIC-RECEIPT", note: null, ...keys(), ...extra });
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
      const f = await fixture(); const created = await create(f, { ownershipPercent: "12.5", note: "Synthetic owner note" });
      assert.ok(created.shareholderProfileId); assert.ok(created.contributionId);
      await zero();
      const row = await h.pool.query(`SELECT p.ownership_percentage::text AS ownership,p.capital_note,
        c.record_status,c.receipt_status,c.amount::text AS amount FROM abos.shareholder_profiles p
        JOIN abos.shareholder_contributions c ON c.shareholder_profile_id=p.id WHERE p.id=$1`, [created.shareholderProfileId]);
      assert.deepEqual(row.rows[0], { ownership: "12.5", capital_note: "Synthetic owner note",
        record_status: "DECLARED", receipt_status: "NOT_RECEIVED", amount: "100000" });
      const view = (await workspace(f.actor)).shareholders.find(s => s.id === created.shareholderProfileId);
      assert.ok(view); assert.equal(Number(view.capitals[0]?.total), 100000);
      assert.equal(Number(view.capitals[0]?.received), 0); assert.equal(Number(view.capitals[0]?.outstanding), 100000);
      assert.equal((await h.pool.query("SELECT count(*)::int AS n FROM abos.sandbox_authorizations")).rows[0]?.n, 0);
    });

    test("creation retries preserve one shareholder and one declaration; invalid capital rolls back the profile", async () => {
      const f = await fixture(); const k = keys(); const input = { displayName: "Synthetic idempotent shareholder", ...k };
      const first = await create(f, input); const replay = await create(f, input);
      assert.equal(replay.shareholderProfileId, first.shareholderProfileId);
      assert.equal(replay.contributionId, first.contributionId);
      await assert.rejects(() => create(f, { ...input, totalCapital: "110000" }), /idempotency|conflict|already used/i);
      const before = await h.pool.query("SELECT count(*)::int AS n FROM abos.shareholder_profiles");
      await assert.rejects(() => create(f, { totalCapital: "0" }), /amount|positive/i);
      assert.deepEqual((await h.pool.query("SELECT count(*)::int AS n FROM abos.shareholder_profiles")).rows, before.rows);
      await assert.rejects(() => create(f, { ownershipPercent: "101" }), /ownership|percentage/i);
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
      assert.ok(cap); assert.equal(Number(cap.received), 30000); assert.equal(Number(cap.outstanding), 70000);
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

    test("over-receipt rolls back every financial row; concurrent oversubscription has one winner", async () => {
      const f = await fixture(); const s = await create(f);
      await assert.rejects(() => receive(f, s.shareholderProfileId, { amount: "100000.01" }), /outstanding|exceeds|available/i);
      await zero();
      const results = await Promise.allSettled([receive(f, s.shareholderProfileId, { amount: "60000" }), receive(f, s.shareholderProfileId, { amount: "60000" })]);
      assert.equal(results.filter(x => x.status === "fulfilled").length, 1);
      assert.equal(results.filter(x => x.status === "rejected").length, 1);
      assert.deepEqual(await counts(), { receipts: 1, allocations: 1, journals: 1, lines: 2, intents: 1, subledgers: 2 });
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
      await assert.rejects(() => receive(f, s.shareholderProfileId, { amount: "30000.01" }), /outstanding|exceeds|available/i);
    });

    test("direct and existing receipt lanes share the same outstanding capital limit", async () => {
      const f = await fixture(); const s = await create(f);
      await receive(f, s.shareholderProfileId, { amount: "60000" });
      await assert.rejects(() => legacyReceive(f, s.contributionId, "40000.01"), /outstanding|exceed|available|allocated/i);
      await legacyReceive(f, s.contributionId, "40000");
      await assert.rejects(() => receive(f, s.shareholderProfileId, { amount: "0.01" }), /outstanding|exceed|available/i);
      assert.deepEqual(await counts(), { receipts: 1, allocations: 1, journals: 1, lines: 2, intents: 1, subledgers: 2 });
      const legacy = await h.pool.query("SELECT original_amount::text AS amount FROM abos.shareholder_capital_receipts WHERE contribution_id=$1", [s.contributionId]);
      assert.deepEqual(legacy.rows, [{ amount: "40000" }]);
    });

    test("concurrent direct and legacy receipts cannot oversubscribe a shared declaration", async () => {
      const f = await fixture(); const s = await create(f);
      const results = await Promise.allSettled([receive(f, s.shareholderProfileId, { amount: "60000" }), legacyReceive(f, s.contributionId, "60000")]);
      assert.equal(results.filter(x => x.status === "fulfilled").length, 1);
      assert.equal(results.filter(x => x.status === "rejected").length, 1);
      const total = await h.pool.query(`SELECT
        COALESCE((SELECT sum(amount) FROM abos.direct_capital_receipt_allocations WHERE contribution_id=$1),0)
        +COALESCE((SELECT sum(original_amount) FROM abos.shareholder_capital_receipts WHERE contribution_id=$1 AND record_state='RECORDED'),0) AS amount`, [s.contributionId]);
      assert.equal(total.rows[0]?.amount, "60000");
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
        /direct capital requires exact Safe debit and shareholder equity credit/);
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
      assert.equal(cap?.received, "30000"); assert.equal(cap?.outstanding, "70000");
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
      await h.pool.query("UPDATE abos.accounting_periods SET status='PENDING' WHERE id=$1", [f.world.accountingPeriodId]);
      await assert.rejects(() => receive(f, s.shareholderProfileId), /period|open/i);
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

    test("runtime cannot bypass the functions with direct table DML or privileged helper execution", async () => {
      const f = await fixture(); const s = await create(f);
      for (const table of ["direct_capital_receipts", "direct_capital_receipt_allocations", "journals", "journal_lines", "posting_intents", "subledger_entries"]) {
        await assert.rejects(() => runtime.query(`SELECT * FROM abos.${table}`), /permission denied/i);
        await assert.rejects(() => runtime.query(`DELETE FROM abos.${table} WHERE false`), /permission denied/i);
        await assert.rejects(() => runtime.query(`INSERT INTO abos.${table} DEFAULT VALUES`), /permission denied/i);
      }
      await assert.rejects(() => runtime.query("UPDATE abos.shareholder_profiles SET ownership_percentage=100 WHERE id=$1", [s.shareholderProfileId]), /permission denied/i);
      await assert.rejects(() => runtime.query("SET ROLE abos_v1_operational_finance_owner"), /permission denied/i);
      await assert.rejects(() => runtime.query("SELECT abos.direct_capital_equity($1,'USD')", [f.world.legalEntityId]), /permission denied/i);
      const publicExec = await h.pool.query(`SELECT p.proname FROM pg_proc p CROSS JOIN LATERAL
        aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
        WHERE p.pronamespace='abos'::regnamespace AND p.proname LIKE 'direct_%'
        AND a.grantee=0 AND a.privilege_type='EXECUTE'`);
      assert.deepEqual(publicExec.rows, []);
      const unsafeOwners = await h.pool.query(`SELECT p.proname,r.rolname FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
        WHERE p.pronamespace='abos'::regnamespace AND p.proname IN
          ('direct_shareholder_create','direct_shareholder_receive','direct_shareholder_capital_workspace','direct_shareholder_document_holder')
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
