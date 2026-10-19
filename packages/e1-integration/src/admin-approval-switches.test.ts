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

// Disposable PostgreSQL only. No application/production credentials are consumed.
const MARKER = SYNTHETIC_AUTH_CONFIGURATION.runtimeMarker;
type Session = { token: string; proof: string; runtimeDigest: string; tokenDigest: string };
type Connection = { executor: PostgresExecutor; close(): Promise<void> };
type Account = { id: string; version: number; status: string; reviewState: string; reviews: unknown[];
  approvalPolicyVersion: number | null; approvalRequired: boolean; policyReleasedBy: string | null };
type Fixture = { world: SyntheticWorld; admin: Session; creator: Session; verifier: Session; recorder: Session; approver: Session };

if (databaseUrl() === undefined) {
  test("V1 admin approval switches require real PostgreSQL", () => assert.fail(MISSING_DATABASE_MESSAGE));
} else {
  describe("V1 admin-controlled approval switches (0039)", () => {
    let harness: Harness; let identity: Connection; let finance: Connection; let treasury: Connection;
    before(async () => {
      const target = new URL(databaseUrl() ?? "");
      assert.notEqual(target.port, "55432", "never run acceptance against preserved runtime PostgreSQL");
      assert.notEqual(decodeURIComponent(target.pathname.slice(1)), "abos_v1_local_review");
      harness = await openHarness(MARKER);
      await resetSchema(harness.pool);
      identity = await connect(harness, "identity", "abos_v1_identity_runtime");
      finance = await connect(harness, "finance", "abos_e1_runtime");
      treasury = await connect(harness, "treasury", "abos_e1_treasury_runtime");
    });
    after(async () => { await identity?.close(); await finance?.close(); await treasury?.close(); await harness?.close(); });

    async function setup(): Promise<Fixture> {
      await resetSchema(harness.pool);
      const world = await seedSyntheticWorld(harness.executor);
      await grant(harness.executor, world, world.reverserId, ["admin.finance-workflow.manage"]);
      await grant(harness.executor, world, world.intentCreatorId, ["finance.ledger-account.manage", "finance.capital-receipt.configure",
        "finance.capital-receipt.prepare", "finance.capital-receipt.post", "shareholder.capital-receipt.read"]);
      await grant(harness.executor, world, world.treasuryManagerId, ["shareholder.capital-receipt.record", "shareholder.capital-receipt.read"]);
      await grant(harness.executor, world, world.treasuryApproverId, ["treasury.capital-receipt.verify", "shareholder.capital-receipt.read"]);
      await grant(harness.executor, world, world.approverId, ["finance.capital-receipt.approve", "finance.capital-receipt.post", "shareholder.capital-receipt.read"]);
      return { world, admin: await session(harness, world, world.reverserId), creator: await session(harness, world, world.intentCreatorId),
        recorder: await session(harness, world, world.treasuryManagerId), verifier: await session(harness, world, world.treasuryApproverId),
        approver: await session(harness, world, world.approverId) };
    }
    const policy = (s: Session, workflowType: string, approvalRequired: boolean, expectedVersion: number, extra: object = {}) =>
      command(identity.executor, "finance_workflow_policy_set_command", s, [{ workflowType, approvalRequired, expectedVersion,
        changeReason: "Synthetic owner policy decision for disposable acceptance", ...ids(), ...extra }]);
    const create = (s: Session, code: string, extra: object = {}) => value<{ account: Account }>(finance.executor,
      "SELECT abos.finance_ledger_account_create($1,$2::jsonb,false) AS value", [s.token, JSON.stringify({ code,
        name: `Synthetic ${code}`, type: "EXPENSE", currency: "USD", postingAllowed: true, ...extra })]);

    test("policy changes are durable idempotent immutable append-only commands with true actor and audit", async () => {
      const f = await setup(); const keys = ids();
      const unrelatedBefore = await harness.pool.query("SELECT to_jsonb(p)::text AS row FROM abos.finance_workflow_policy_versions p WHERE workflow_type IN ('EXPENSE','TEMPORARY_FUNDING') ORDER BY id");
      await policy(f.admin, "SHAREHOLDER_CAPITAL_RECEIPT", true, 0);
      await policy(f.admin, "SHAREHOLDER_CAPITAL_RECEIPT", false, 1, keys);
      await policy(f.admin, "SHAREHOLDER_CAPITAL_RECEIPT", false, 1, { ...keys, correlationId: randomUUID() });
      const versions = await harness.pool.query("SELECT version,approval_required,configured_by_user_account_id::text AS actor FROM abos.finance_workflow_policy_versions WHERE workflow_type='SHAREHOLDER_CAPITAL_RECEIPT' ORDER BY version");
      assert.deepEqual(versions.rows, [ { version: 1, approval_required: true, actor: f.world.reverserId }, { version: 2, approval_required: false, actor: f.world.reverserId } ]);
      await assert.rejects(() => policy(f.admin, "SHAREHOLDER_CAPITAL_RECEIPT", true, 1, keys), /idempotency|already used|conflict/i);
      await assert.rejects(() => policy(f.admin, "SHAREHOLDER_CAPITAL_RECEIPT", true, 1), /stale|changed|version/i);
      await policy(f.admin, "SHAREHOLDER_CAPITAL_RECEIPT", true, 2);
      await assert.rejects(() => harness.pool.query("UPDATE abos.finance_workflow_policy_versions SET approval_required=false"), /append-only|cannot be changed/i);
      await assert.rejects(() => harness.pool.query("DELETE FROM abos.finance_workflow_policy_versions"), /append-only|cannot be changed/i);
      const audits = await harness.pool.query("SELECT actor_user_account_id::text AS actor,correlation_id::text AS correlation FROM abos.audit_records WHERE correlation_id=$1", [keys.correlationId]);
      assert.deepEqual(audits.rows, [{ actor: f.world.reverserId, correlation: keys.correlationId }], "replay creates no duplicate audit");
      assert.deepEqual((await harness.pool.query("SELECT to_jsonb(p)::text AS row FROM abos.finance_workflow_policy_versions p WHERE workflow_type IN ('EXPENSE','TEMPORARY_FUNDING') ORDER BY id")).rows, unrelatedBefore.rows);
      await assertNoPosting(harness);
    });

    test("concurrent same-version commands serialize; one version wins without lost update", async () => {
      const f = await setup();
      const results = await Promise.allSettled([policy(f.admin, "CHART_OF_ACCOUNTS", true, 0), policy(f.admin, "CHART_OF_ACCOUNTS", false, 0)]);
      assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
      assert.equal(results.filter(r => r.status === "rejected").length, 1);
      assert.equal((await harness.pool.query("SELECT count(*)::int AS n FROM abos.finance_workflow_policy_versions WHERE workflow_type='CHART_OF_ACCOUNTS'")).rows[0]?.n, 1);
    });

    test("live authorization forbids reader revoked developer Bootstrap forgery and wrong runtime", async () => {
      const f = await setup();
      await assert.rejects(() => policy(f.creator, "CHART_OF_ACCOUNTS", false, 0), /authority|permission/i);
      for (const forged of [{ actorUserAccountId: f.world.bootstrapUserId }, { legalEntityId: randomUUID() }, { effectiveAt: "2000-01-01" }]) {
        await assert.rejects(() => policy(f.admin, "CHART_OF_ACCOUNTS", false, 0, forged), /unsupported|unknown|invalid.*field/i);
      }
      const dev = await new SandboxAuthenticator(harness.executor, SYNTHETIC_AUTH_CONFIGURATION).issueSession({
        userAccountId: f.world.reverserId as never, legalEntityId: f.world.legalEntityId as never });
      await assert.rejects(() => policy(fromToken(dev.token), "CHART_OF_ACCOUNTS", false, 0), /password|operational|session/i);
      await grant(harness.executor, f.world, f.world.bootstrapUserId, ["admin.finance-workflow.manage"]);
      await harness.pool.query("UPDATE abos.user_accounts SET login_identifier=$1 WHERE id=$2",
        [`system.local-bootstrap.${randomUUID()}`, f.world.bootstrapUserId]);
      const bootstrap = await session(harness, f.world, f.world.bootstrapUserId);
      await assert.rejects(() => policy(bootstrap, "CHART_OF_ACCOUNTS", false, 0), /bootstrap|real user|administrat|system/i);
      await harness.pool.query("DELETE FROM abos.user_permission_grants WHERE user_account_id=$1 AND permission_code='admin.finance-workflow.manage'", [f.world.reverserId]);
      await assert.rejects(() => policy(f.admin, "CHART_OF_ACCOUNTS", false, 0), /authority|permission/i);
      await assert.rejects(() => command(finance.executor, "finance_workflow_policy_set_command", f.admin,
        [{ workflowType: "CHART_OF_ACCOUNTS", approvalRequired: false, expectedVersion: 0, changeReason: "Synthetic refused runtime", ...ids() }]), /permission denied/i);
      await assertNoPosting(harness);
    });

    test("revoked sessions and stale idempotent replays cannot regain policy authority", async () => {
      const f = await setup(); const keys = ids();
      await policy(f.admin, "CHART_OF_ACCOUNTS", false, 0, keys);
      await harness.pool.query("UPDATE abos.sandbox_sessions SET revoked_at=clock_timestamp() WHERE runtime_token_sha256=$1", [f.admin.runtimeDigest]);
      await assert.rejects(() => policy(f.admin, "CHART_OF_ACCOUNTS", false, 0, keys), /session|active|password|authority/i);
      const current = await session(harness, f.world, f.world.reverserId);
      await harness.pool.query("DELETE FROM abos.user_permission_grants WHERE user_account_id=$1 AND permission_code='admin.finance-workflow.manage'", [f.world.reverserId]);
      await assert.rejects(() => policy(current, "CHART_OF_ACCOUNTS", false, 0, keys), /authority|permission/i);
      assert.equal((await harness.pool.query("SELECT count(*)::int AS n FROM abos.finance_workflow_policy_versions WHERE workflow_type='CHART_OF_ACCOUNTS'")).rows[0]?.n, 1);
    });

    test("policy entity is session-derived; foreign company versions remain isolated", async () => {
      const f = await setup(); await policy(f.admin, "CHART_OF_ACCOUNTS", false, 0);
      const other = await seedSyntheticWorld(harness.executor);
      await grant(harness.executor, other, other.reverserId, ["admin.finance-workflow.manage"]);
      const otherAdmin = await session(harness, other, other.reverserId);
      await policy(otherAdmin, "CHART_OF_ACCOUNTS", true, 0);
      const result = await harness.pool.query("SELECT legal_entity_id::text AS entity,approval_required FROM abos.finance_workflow_policy_versions WHERE workflow_type='CHART_OF_ACCOUNTS' ORDER BY legal_entity_id");
      assert.deepEqual(result.rows, [{ entity: f.world.legalEntityId, approval_required: false }, { entity: other.legalEntityId, approval_required: true }].sort((a,b) => a.entity.localeCompare(b.entity)));
    });

    test("CoA ON queues review; OFF is NOT_REQUIRED; explicit pending release fabricates no approval", async () => {
      const f = await setup(); await policy(f.admin, "CHART_OF_ACCOUNTS", true, 0);
      const pending = await create(f.creator, "SYN-E-01");
      assert.equal(pending.account.reviewState, "PENDING_REVIEW");
      await assert.rejects(() => value(finance.executor, "SELECT abos.finance_account_policy_reevaluate($1,$2,$3::jsonb) AS value",
        [f.creator.token, pending.account.id, JSON.stringify({ expectedVersion: 1, reason: "Synthetic explicit policy release", ...ids() })]), /approval|policy|review/i);
      await policy(f.admin, "CHART_OF_ACCOUNTS", false, 1);
      const releasePayload = { expectedVersion: pending.account.version, reason: "Synthetic explicit policy release", ...ids() };
      const released = await value<{ account: Account }>(finance.executor, "SELECT abos.finance_account_policy_reevaluate($1,$2,$3::jsonb) AS value",
        [f.creator.token, pending.account.id, JSON.stringify(releasePayload)]);
      assert.equal(released.account.reviewState, "NOT_REQUIRED"); assert.equal(released.account.status, "ACTIVE");
      assert.equal(released.account.approvalRequired, false); assert.equal(released.account.approvalPolicyVersion, 2);
      assert.deepEqual(released.account.reviews, []);
      await value(finance.executor, "SELECT abos.finance_account_policy_reevaluate($1,$2,$3::jsonb) AS value",
        [f.creator.token, pending.account.id, JSON.stringify(releasePayload)]);
      const governance = await harness.pool.query("SELECT created_by_user_account_id::text AS creator,last_reviewed_by_user_account_id, last_reviewed_at FROM abos.ledger_account_governance WHERE ledger_account_id=$1", [pending.account.id]);
      assert.deepEqual(governance.rows[0], { creator: f.world.intentCreatorId, last_reviewed_by_user_account_id: null, last_reviewed_at: null });
      assert.equal((await harness.pool.query("SELECT count(*)::int AS n FROM abos.ledger_account_review_decisions WHERE ledger_account_id=$1", [pending.account.id])).rows[0]?.n, 0);
      const direct = await create(f.creator, "SYN-NEW-OFF"); assert.equal(direct.account.reviewState, "NOT_REQUIRED");
      await assert.rejects(() => create(f.creator, "SYN-BAD-OFF", { type: "LIABILITY", controlType: "CASH" }), /CASH|account type/i);
      await policy(f.admin, "CHART_OF_ACCOUNTS", true, 2);
      assert.equal((await create(f.creator, "SYN-NEW-ON")).account.reviewState, "PENDING_REVIEW");
      await assertNoPosting(harness);
    });

    test("Capital OFF preserves custody mapping period evidence and balanced explicit posting without approval", async () => {
      const f = await setup(); await policy(f.admin, "SHAREHOLDER_CAPITAL_RECEIPT", false, 0);
      const capital = await capitalFixture(harness, f, finance.executor, treasury.executor);
      const prepare = () => command<{ postingIntentId: string; version: number }>(finance.executor, "prepare_shareholder_capital_posting", f.creator,
        [capital.receiptId, { expectedReceiptVersion: 1, accountingEffectiveDate: "2026-09-23", ...ids() }]);
      await assert.rejects(prepare, /custody|verified/i);
      await assert.rejects(() => command(treasury.executor, "verify_shareholder_capital_receipt_custody", f.verifier,
        [capital.receiptId, { expectedReceiptVersion: 1, decision: "VERIFIED", verificationKind: "PHYSICAL_CASH_COUNT", evidenceReferenceId: randomUUID(), decisionReason: null, ...ids() }]), /evidence|reference/i);
      const evidence = await register(treasury.executor, f.verifier, "PHYSICAL_CASH_COUNT", capital.receiptId);
      await command(treasury.executor, "verify_shareholder_capital_receipt_custody", f.verifier, [capital.receiptId,
        { expectedReceiptVersion: 1, decision: "VERIFIED", verificationKind: "PHYSICAL_CASH_COUNT", evidenceReferenceId: evidence, decisionReason: null, ...ids() }]);
      await assert.rejects(prepare, /mapping|configured/i);
      const mappingEvidence = await register(finance.executor, f.creator, "CAPITAL_ACCOUNT_MAPPING", null);
      await command(finance.executor, "configure_shareholder_capital_mapping", f.creator, [{ ledgerAccountId: f.world.capitalLedgerAccountId,
        evidenceReferenceId: mappingEvidence, changeReason: "Synthetic mapping authority", ...ids() }]);
      const prepared = await prepare();
      const intent = await harness.pool.query("SELECT i.status,p.approval_required FROM abos.posting_intents i JOIN abos.finance_workflow_policy_versions p ON p.id=i.finance_workflow_policy_version_id WHERE i.id=$1", [prepared.postingIntentId]);
      assert.deepEqual(intent.rows[0], { status: "VALIDATED", approval_required: false });
      await policy(f.admin, "SHAREHOLDER_CAPITAL_RECEIPT", true, 1);
      await harness.pool.query("UPDATE abos.accounting_periods SET status='PENDING' WHERE id=$1", [f.world.accountingPeriodId]);
      const postPayload = { expectedIntentVersion: prepared.version, ...ids() };
      await assert.rejects(() => command(finance.executor, "post_shareholder_capital_receipt", f.creator, [prepared.postingIntentId, postPayload]), /period|open/i);
      await harness.pool.query("UPDATE abos.accounting_periods SET status='OPEN' WHERE id=$1", [f.world.accountingPeriodId]);
      const posted = await command<{ journalId: string; status: string }>(finance.executor, "post_shareholder_capital_receipt", f.creator, [prepared.postingIntentId, postPayload]);
      assert.equal(posted.status, "POSTED", "bound OFF policy stays OFF after current policy changes ON");
      await command(finance.executor, "post_shareholder_capital_receipt", f.creator, [prepared.postingIntentId, postPayload]);
      assert.equal((await harness.pool.query("SELECT count(*)::int AS n FROM abos.posting_approvals WHERE posting_intent_id=$1", [prepared.postingIntentId])).rows[0]?.n, 0);
      const journal = await harness.pool.query("SELECT count(*)::int AS n,sum(base_debit)::text AS debit,sum(base_credit)::text AS credit FROM abos.journal_lines WHERE journal_id=$1", [posted.journalId]);
      assert.deepEqual(journal.rows[0], { n: 2, debit: "500", credit: "500" });
      const subledger = await harness.pool.query("SELECT count(*)::int AS n,sum(original_amount)::text AS amount FROM abos.subledger_entries WHERE shareholder_capital_receipt_id=$1", [capital.receiptId]);
      assert.deepEqual(subledger.rows[0], { n: 2, amount: "0" });
    });

    test("Capital ON in-flight intent cannot become approval-free by switching current policy OFF", async () => {
      const f = await setup(); await policy(f.admin, "SHAREHOLDER_CAPITAL_RECEIPT", true, 0);
      const c = await capitalFixture(harness, f, finance.executor, treasury.executor);
      const evidence = await register(treasury.executor, f.verifier, "PHYSICAL_CASH_COUNT", c.receiptId);
      await command(treasury.executor, "verify_shareholder_capital_receipt_custody", f.verifier, [c.receiptId,
        { expectedReceiptVersion: 1, decision: "VERIFIED", verificationKind: "PHYSICAL_CASH_COUNT", evidenceReferenceId: evidence, decisionReason: null, ...ids() }]);
      await command(finance.executor, "configure_shareholder_capital_mapping", f.creator, [{ ledgerAccountId: f.world.capitalLedgerAccountId,
        evidenceReferenceId: await register(finance.executor, f.creator, "CAPITAL_ACCOUNT_MAPPING", null), changeReason: "Synthetic mapping authority", ...ids() }]);
      const p = await command<{ postingIntentId: string; version: number }>(finance.executor, "prepare_shareholder_capital_posting", f.creator,
        [c.receiptId, { expectedReceiptVersion: 1, accountingEffectiveDate: "2026-09-23", ...ids() }]);
      await policy(f.admin, "SHAREHOLDER_CAPITAL_RECEIPT", false, 1);
      await assert.rejects(() => command(finance.executor, "post_shareholder_capital_receipt", f.creator,
        [p.postingIntentId, { expectedIntentVersion: p.version, ...ids() }]), /approved|approval|ready|status/i);
      await assertNoPosting(harness);
    });
  });
}

function ids() { return { idempotencyKey: `switch-test-${randomUUID()}`, correlationId: randomUUID() }; }
function fromToken(token: string): Session { return { token, proof: identityDatabaseProof(SYNTHETIC_AUTH_CONFIGURATION.signingSecret),
  runtimeDigest: createHash("sha256").update(token).digest("hex"), tokenDigest: createHmac("sha256", SYNTHETIC_AUTH_CONFIGURATION.signingSecret).update(token).digest("hex") }; }
async function session(h: Harness, w: SyntheticWorld, user: string): Promise<Session> { return fromToken((await issueOperationalSession(h, user, w.legalEntityId)).token); }
async function connect(h: Harness, lane: string, role: string): Promise<Connection> {
  const name = `abos_0039_${lane}_test_login`; const password = `synthetic-0039-${lane}-only-2026`;
  await h.pool.query(`DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='${name}') THEN CREATE ROLE ${name} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION; END IF; END $$`);
  await h.pool.query(`ALTER ROLE ${name} PASSWORD '${password}'`); await h.pool.query(`GRANT ${role} TO ${name}`);
  const url = new URL(databaseUrl() ?? ""); url.username = name; url.password = password;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 3 });
  return { executor: new PostgresExecutor(pool, { runtimeMarker: MARKER }), close: () => pool.end() };
}
async function value<T>(db: PostgresExecutor, sql: string, parameters: readonly unknown[]): Promise<T> {
  const result = await db.query<{ value: T }>(sql, parameters); assert.ok(result.rows[0]); return result.rows[0].value;
}
async function command<T = unknown>(db: PostgresExecutor, fn: string, s: Session, args: readonly unknown[]): Promise<T> {
  const params: unknown[] = [s.proof, s.runtimeDigest, s.tokenDigest];
  const placeholders = ["$1", "$2", "$3"];
  for (const arg of args) { const json = typeof arg === "object" && arg !== null; params.push(json ? JSON.stringify(arg) : arg); placeholders.push(`$${params.length}${json ? "::jsonb" : ""}`); }
  return value<T>(db, `SELECT abos.${fn}(${placeholders.join(",")}) AS value`, params);
}
async function assertNoPosting(h: Harness) {
  const rows = await h.pool.query("SELECT (SELECT count(*) FROM abos.journals)::int AS journals,(SELECT count(*) FROM abos.journal_lines)::int AS lines,(SELECT count(*) FROM abos.posting_intents)::int AS intents");
  assert.deepEqual(rows.rows[0], { journals: 0, lines: 0, intents: 0 });
}
async function register(db: PostgresExecutor, actor: Session, evidenceKind: string, subjectId: string | null) {
  const result = await command<{ evidenceReferenceId: string }>(db, "register_shareholder_capital_evidence", actor,
    [{ evidenceKind, subjectId, documentReference: "Synthetic disposable evidence", sha256: createHash("sha256").update(randomUUID()).digest("hex"), ...ids() }]);
  return result.evidenceReferenceId;
}
async function capitalFixture(h: Harness, f: Fixture, finance: PostgresExecutor, treasury: PostgresExecutor) {
  const contributionId = randomUUID(); const treasuryId = randomUUID();
  await h.pool.query(`INSERT INTO abos.shareholder_contributions
    (id,legal_entity_id,shareholder_profile_id,contribution_type,business_date,description,record_status,receipt_status,valuation_status,amount,currency_code,version,created_by_user_account_id,declared_by_user_account_id,declared_at)
    VALUES($1,$2,$3,'CASH','2026-09-22','Synthetic approval-switch declaration','DECLARED','NOT_RECEIVED','NOT_APPLICABLE',500,'USD',1,$4,$4,clock_timestamp())`,
  [contributionId, f.world.legalEntityId, f.world.shareholderProfileId, f.world.bootstrapUserId]);
  await h.pool.query(`INSERT INTO abos.operational_treasury_accounts
    (id,legal_entity_id,name_en,account_type,currency_code,ledger_account_id,status,version,created_by_user_account_id,last_changed_by_user_account_id)
    VALUES($1,$2,'Synthetic approval-switch Safe','SAFE','USD',$3,'ACTIVE',1,$4,$4)`, [treasuryId, f.world.legalEntityId, f.world.cashLedgerAccountId, f.world.bootstrapUserId]);
  const payload = { contributionId, expectedContributionVersion: 1, amount: { amount: "500", currency: "USD" }, receiptDate: "2026-09-23",
    treasuryDestinationId: treasuryId, paymentReference: "SYN-APPROVAL-SWITCH", evidenceReferenceId: null, ...ids() };
  await assert.rejects(() => command(treasury, "record_shareholder_capital_receipt", f.recorder, [{ ...payload, treasuryDestinationId: randomUUID(), ...ids() }]), /destination|treasury|safe/i);
  const received = await command<{ receipt: { receiptId: string } }>(treasury, "record_shareholder_capital_receipt", f.recorder, [payload]);
  assert.ok(finance); return { receiptId: received.receipt.receiptId, treasuryId, contributionId };
}
