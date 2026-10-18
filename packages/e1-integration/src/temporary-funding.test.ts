import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import test, { after, before, describe } from "node:test";
import pg from "pg";

import type { LegalEntityId, UserAccountId } from "@abos/contracts";
import { calculateMigrationChecksum } from "@abos/database";
import { PostgresExecutor } from "@abos/persistence";
import { identityDatabaseProof, SandboxAuthenticator } from "@abos/sandbox-auth";

import {
  databaseUrl,
  loadMigrations,
  MISSING_DATABASE_MESSAGE,
  openHarness,
  resetSchema,
  withClusterLock,
  type Harness
} from "./harness.ts";
import { issueOperationalSession } from "./operational-session.ts";
import { seedSyntheticWorld, SYNTHETIC_AUTH_CONFIGURATION, type SyntheticWorld } from "./synthetic-world.ts";

/** Migration 0037: real PostgreSQL proof for V1 Temporary Funding. Disposable, synthetic data only. */

const MARKER = SYNTHETIC_AUTH_CONFIGURATION.runtimeMarker;
const LOGIN = { name: "abos_v1_temporary_funding_test_login", password: "synthetic-temporary-funding-runtime-only-2026" };
const DATE = "2026-09-22";
const MIGRATION_0036_CHECKSUM = "669c8afb6938d135800d6c96c74110038c21dded2312f2055517f2a736493a3d";
const FUNDING_TABLES = ["temporary_funding_provider_identity_versions", "temporary_fundings", "temporary_funding_decisions", "temporary_funding_settlements",
  "temporary_funding_settlement_decisions", "temporary_funding_account_mapping_versions"] as const;

interface SessionArgs { readonly proof: string; readonly runtimeDigest: string; readonly tokenDigest: string }

interface Funding {
  readonly id: string; readonly status: string; readonly lifecycleStatus: string; readonly version: number;
  readonly journalId: string | null; readonly amount: string; readonly settledAmount: string;
  readonly outstandingAmount: string; readonly pendingSettlementAmount: string;
  readonly mappingVersionId: string; readonly workflowPolicyVersionId: string;
  readonly settlements: readonly { id: string; status: string; version: number; amount: string }[];
}
interface Settlement { readonly id: string; readonly status: string; readonly version: number; readonly journalId: string | null }

interface Sessions {
  readonly creator: SessionArgs; readonly approver: SessionArgs; readonly secondApprover: SessionArgs;
  readonly settler: SessionArgs; readonly settleApprover: SessionArgs; readonly configurer: SessionArgs;
  readonly outsider: SessionArgs; readonly identityAdmin: SessionArgs;
}

interface Fixture {
  readonly world: SyntheticWorld;
  readonly safeId: string; readonly bankId: string; readonly categoryId: string;
  readonly expenseLedgerId: string; readonly payableLedgerId: string; readonly mappingVersionId: string;
  readonly policyId: string;
  readonly shareholderPartyId: string; readonly employeePartyId: string; readonly individualPartyId: string;
  readonly organizationPartyId: string; readonly payeePartyId: string;
  readonly sessions: Sessions; readonly executor: PostgresExecutor; close(): Promise<void>;
}

if (databaseUrl() === undefined) {
  test("V1 temporary funding", () => assert.fail(MISSING_DATABASE_MESSAGE));
} else {
  describe("V1 temporary funding (migration 0037)", () => {
    let harness: Harness;

    before(async () => { harness = await openHarness(MARKER); });
    after(async () => { await harness.close(); });

    test("upgrade 0036 -> 0037 preserves every posted row and backfills nothing", async () => {
      const migrations = await loadMigrations();
      const index = migrations.findIndex((migration) => migration.id === "0037_v1_temporary_funding");
      const m0036 = migrations[index - 1]; const m0037 = migrations[index];
      assert.ok(m0036 && m0037 && m0036.id === "0036_v1_shareholder_finance_bridge");
      assert.equal(calculateMigrationChecksum(m0036.sql), MIGRATION_0036_CHECKSUM);
      assert.equal(m0036.checksumSha256, MIGRATION_0036_CHECKSUM);
      await withClusterLock(harness.pool, async () => {
        const client = await harness.pool.connect();
        try {
          await client.query("BEGIN");
          await client.query("DROP SCHEMA IF EXISTS abos CASCADE");
          for (const predecessor of migrations.slice(0, index)) await client.query(predecessor.sql);
          await client.query("COMMIT");
        } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
      });
      // Real 0036-era business history: a posted Operational V1 expense and liability accounts of other kinds.
      const world = await seedSyntheticWorld(harness.executor);
      const expense = await configureExpenseLane(harness, world);
      await ensureLogin(harness);
      const runtime = restricted();
      try {
        const creator = await sessionFor(harness, world, world.intentCreatorId);
        const approver = await sessionFor(harness, world, world.approverId);
        const created = await call<{ expense: { id: string; version: number } }>(runtime.executor,
          "SELECT abos.operational_expense_create($1,$2,$3,$4::jsonb) AS value",
          [...args(creator), JSON.stringify(expensePayload(expense.safeId, expense.categoryId, "70.00"))]);
        const posted = await call<{ expense: { status: string } }>(runtime.executor,
          "SELECT abos.operational_expense_approve($1,$2,$3,$4,$5,$6) AS value",
          [...args(approver), created.expense.id, created.expense.version, "Synthetic pre-0037 approval"]);
        assert.equal(posted.expense.status, "POSTED");
      } finally { await runtime.close(); }
      for (const [code, control] of [["SYN-AP", "AP"], ["SYN-OTHER", "OTHER"], ["SYN-NULL", null]] as const) {
        await harness.executor.query(`INSERT INTO abos.ledger_accounts (id, legal_entity_id, account_code, account_name,
            account_type, control_account_type, posting_allowed, account_currency_code, status)
          VALUES (gen_random_uuid(), $1, $2, 'Synthetic liability', 'LIABILITY', $3, true, 'USD', 'ACTIVE')`,
        [world.legalEntityId, code, control]);
      }
      const snapshot = async () => (await harness.pool.query<{ name: string; rows: string; digest: string }>(`
        SELECT name, rows::text, digest FROM (
          SELECT 'ledger_accounts' AS name, count(*) AS rows, md5(COALESCE(string_agg(to_jsonb(t)::text, ',' ORDER BY id), '')) AS digest FROM abos.ledger_accounts t
          UNION ALL SELECT 'journals', count(*), md5(COALESCE(string_agg(to_jsonb(t)::text, ',' ORDER BY id), '')) FROM abos.journals t
          UNION ALL SELECT 'journal_lines', count(*), md5(COALESCE(string_agg(to_jsonb(t)::text, ',' ORDER BY id), '')) FROM abos.journal_lines t
          UNION ALL SELECT 'posting_intents', count(*), md5(COALESCE(string_agg((to_jsonb(t) - ARRAY['temporary_funding_id','temporary_funding_settlement_id','temporary_funding_mapping_version_id'])::text, ',' ORDER BY id), '')) FROM abos.posting_intents t
          UNION ALL SELECT 'subledger_entries', count(*), md5(COALESCE(string_agg((to_jsonb(t) - ARRAY['temporary_funding_id','temporary_funding_settlement_id'])::text, ',' ORDER BY id), '')) FROM abos.subledger_entries t
          UNION ALL SELECT 'operational_expenses', count(*), md5(COALESCE(string_agg(to_jsonb(t)::text, ',' ORDER BY id), '')) FROM abos.operational_expenses t
          UNION ALL SELECT 'evidence_references', count(*), md5(COALESCE(string_agg(to_jsonb(t)::text, ',' ORDER BY id), '')) FROM abos.evidence_references t
          UNION ALL SELECT 'business_parties', count(*), md5(COALESCE(string_agg(to_jsonb(t)::text, ',' ORDER BY id), '')) FROM abos.business_parties t
          UNION ALL SELECT 'finance_workflow_policy_versions', count(*), md5(COALESCE(string_agg(to_jsonb(t)::text, ',' ORDER BY id), '')) FROM abos.finance_workflow_policy_versions t
        ) s ORDER BY name`)).rows;
      const before = await snapshot();
      assert.ok(Number(before.find((row) => row.name === "journals")?.rows) >= 1, "a posted journal exists before the upgrade");
      const catalogueBefore = await scalar(harness, "SELECT count(*) FROM abos.permission_catalogue");
      await withClusterLock(harness.pool, async () => {
        const client = await harness.pool.connect();
        try { await client.query("BEGIN"); await client.query(m0037.sql); await client.query("COMMIT"); }
        catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
      });
      assert.deepEqual(await snapshot(), before, "0037 changes no existing financial, ledger, evidence or policy row");
      for (const table of FUNDING_TABLES) {
        assert.equal(await scalar(harness, `SELECT count(*) FROM abos.${table}`), 0, `${table} is created empty`);
      }
      assert.equal(await scalar(harness, `SELECT count(*) FROM abos.posting_intents
        WHERE temporary_funding_id IS NOT NULL OR temporary_funding_settlement_id IS NOT NULL
           OR temporary_funding_mapping_version_id IS NOT NULL`), 0);
      assert.equal(await scalar(harness, "SELECT count(*) FROM abos.subledger_entries WHERE temporary_funding_id IS NOT NULL"), 0);
      assert.equal(await scalar(harness,
        "SELECT count(*) FROM abos.ledger_accounts WHERE control_account_type = 'TEMPORARY_FUNDING_PAYABLE'"), 0,
      "no ledger account is converted or classified");
      assert.equal(await scalar(harness, "SELECT count(*) FROM abos.permission_catalogue") - catalogueBefore, 6);
      assert.equal(await scalar(harness, "SELECT count(*) FROM abos.shareholder_capital_receipts"), 0,
        "Shareholder Capital remains zero-backfilled");
    });

    test("fresh install 0001 -> 0037: catalogue, controls and inactive paths", async () => {
      await resetSchema(harness.pool);
      const applied = await harness.pool.query<{ checksum_sha256: string; migration_id: string }>(
        `SELECT migration_id, checksum_sha256 FROM abos.schema_migrations
          WHERE migration_id IN ('0036_v1_shareholder_finance_bridge','0037_v1_temporary_funding') ORDER BY migration_id`);
      assert.deepEqual(applied.rows.map((row) => row.migration_id), ["0036_v1_shareholder_finance_bridge", "0037_v1_temporary_funding"]);
      assert.equal(applied.rows[0]?.checksum_sha256, MIGRATION_0036_CHECKSUM);
      for (const table of FUNDING_TABLES) {
        assert.equal(await scalar(harness, `SELECT count(*) FROM abos.${table}`), 0, `${table} starts empty`);
      }
      const codes = await harness.pool.query<{ permission_code: string; independence_enforced: boolean; catalogue_version: number; sort_order: number; category: string }>(
        `SELECT permission_code, independence_enforced, catalogue_version, sort_order, category FROM abos.permission_catalogue
          WHERE permission_code LIKE 'finance.temporary-funding.%' ORDER BY sort_order`);
      assert.deepEqual(codes.rows.map((row) => [row.permission_code, row.independence_enforced, row.catalogue_version, row.sort_order, row.category]), [
        ["finance.temporary-funding.read", false, 10, 600, "FINANCE"],
        ["finance.temporary-funding.record", false, 10, 610, "FINANCE"],
        ["finance.temporary-funding.approve", true, 10, 620, "FINANCE"],
        ["finance.temporary-funding.settle", false, 10, 630, "FINANCE"],
        ["finance.temporary-funding.settle-approve", true, 10, 640, "FINANCE"],
        ["finance.temporary-funding.configure", false, 10, 650, "FINANCE"]
      ]);
      const capital = await scalar(harness,
        "SELECT count(*) FROM abos.permission_catalogue WHERE catalogue_version = 9 AND sort_order BETWEEN 530 AND 590");
      assert.equal(capital, 7, "0036 capital permissions are untouched");
      const type = await harness.pool.query<{ label_en: string; label_fa: string }>(
        "SELECT label_en, label_fa FROM abos.finance_workflow_types WHERE workflow_type = 'TEMPORARY_FUNDING'");
      assert.deepEqual(type.rows[0], { label_en: "Temporary funding", label_fa: "تمویل موقت" });
      // Reversal and the Safe non-negative guard are not available in this slice.
      assert.equal(await scalar(harness, `SELECT count(*) FROM pg_proc WHERE pronamespace = 'abos'::regnamespace
        AND (proname ~ 'temporary_funding.*revers' AND proname <> 'refuse_temporary_funding_reversal_link'
             OR proname ~ 'cash_guard|recorded_cash')`), 0);
      assert.equal(await scalar(harness, `SELECT count(*) FROM pg_class WHERE relnamespace = 'abos'::regnamespace
        AND relname IN ('temporary_funding_reversals', 'operational_treasury_cash_controls')`), 0);
      assert.equal(await scalar(harness,
        "SELECT count(*) FROM abos.permission_catalogue WHERE permission_code LIKE '%temporary-funding.revers%'"), 0);
      // No reserved Shareholder-Finance name is reused and validators keep every 0036 branch.
      const definition = await harness.pool.query<{ definition: string }>(
        "SELECT pg_get_functiondef('abos.validate_operational_journal_posting()'::regprocedure) AS definition");
      for (const marker of ["OPERATIONAL_EXPENSE", "SHAREHOLDER_CAPITAL_CONTRIBUTION_RECEIPT", "TEMPORARY_FUNDING_SETTLEMENT"]) {
        assert.match(definition.rows[0]?.definition ?? "", new RegExp(marker));
      }
      const triggers = await harness.pool.query<{ tgname: string }>(`SELECT tgname FROM pg_trigger
        WHERE tgrelid = 'abos.journals'::regclass AND tgname LIKE 'journals_operational%' ORDER BY tgname`);
      assert.deepEqual(triggers.rows.map((row) => row.tgname), [
        "journals_operational_capital_posting_guard", "journals_operational_posting_guard",
        "journals_operational_temporary_funding_posting_guard"]);
    });

    test("payable mapping accepts only a controlled LIABILITY and is evidence-backed and append-only", async () => {
      const fixture = await setupFixture(harness);
      try {
        const world = fixture.world;
        for (const [code, type, control] of [["SYN-AP2", "LIABILITY", "AP"], ["SYN-OTH2", "LIABILITY", "OTHER"],
          ["SYN-NUL2", "LIABILITY", null]] as const) {
          const id = await ledger(harness, world, code, type, control);
          await assert.rejects(() => configure(fixture, id), /TEMPORARY_FUNDING_PAYABLE liability/);
        }
        await assert.rejects(() => configure(fixture, world.capitalLedgerAccountId), /TEMPORARY_FUNDING_PAYABLE liability/);
        await assert.rejects(() => call(fixture.executor, "SELECT abos.configure_temporary_funding_mapping($1,$2,$3,$4::jsonb) AS value",
          [...args(fixture.sessions.configurer), JSON.stringify({ ledgerAccountId: fixture.payableLedgerId,
            evidenceDocumentReference: "SYN-AUTH-1", changeReason: "No evidence hash", idempotencyKey: `cfg-${randomUUID()}`,
            correlationId: randomUUID() })]), /evidence SHA-256/);
        const mapping = await harness.pool.query<{ version: number; kind: string; reference: string; referenced: boolean }>(`
          SELECT mapping.version, evidence.evidence_kind AS kind, mapping.evidence_document_reference AS reference,
                 EXISTS (SELECT 1 FROM abos.ledger_account_references ref WHERE ref.ledger_account_id = mapping.payable_ledger_account_id) AS referenced
            FROM abos.temporary_funding_account_mapping_versions mapping
            JOIN abos.evidence_references evidence ON evidence.id = mapping.evidence_reference_id
           WHERE mapping.id = $1`, [fixture.mappingVersionId]);
        assert.deepEqual(mapping.rows[0], { version: 1, kind: "TEMPORARY_FUNDING_ACCOUNT_MAPPING",
          reference: "SYN-AUTHORIZATION-001", referenced: true });
        const payload = { ledgerAccountId: fixture.payableLedgerId, evidenceDocumentReference: "SYN-AUTH-2",
          evidenceSha256: "a".repeat(64), changeReason: "Synthetic second version", idempotencyKey: `cfg-${randomUUID()}`,
          correlationId: randomUUID() };
        const first = await call<{ version: number; replayed: boolean }>(fixture.executor,
          "SELECT abos.configure_temporary_funding_mapping($1,$2,$3,$4::jsonb) AS value", [...args(fixture.sessions.configurer), JSON.stringify(payload)]);
        const replay = await call<{ version: number; replayed: boolean }>(fixture.executor,
          "SELECT abos.configure_temporary_funding_mapping($1,$2,$3,$4::jsonb) AS value",
          [...args(fixture.sessions.configurer), JSON.stringify({ ...payload, correlationId: randomUUID() })]);
        assert.deepEqual([first.version, first.replayed, replay.version, replay.replayed], [2, false, 2, true]);
        await assert.rejects(() => harness.pool.query(
          "UPDATE abos.temporary_funding_account_mapping_versions SET change_reason = 'tampered' WHERE id = $1", [fixture.mappingVersionId]));
        await assert.rejects(() => harness.pool.query(
          "DELETE FROM abos.temporary_funding_account_mapping_versions WHERE id = $1", [fixture.mappingVersionId]));
        assert.equal(await auditCount(harness, "TEMPORARY_FUNDING_MAPPING_CONFIGURED"), 2, "replay adds no audit fact");
      } finally { await fixture.close(); }
    });

    test("Mode A: Dr Expense / Cr provider payable; Safe unchanged; lineage complete", async () => {
      const fixture = await setupFixture(harness);
      try {
        const created = await record(fixture, fixture.sessions.creator, modeA(fixture, "250.00"));
        assert.deepEqual([created.status, created.journalId], ["PENDING_APPROVAL", null]);
        const posted = await decide(fixture, fixture.sessions.approver, created.id, created.version, "APPROVED");
        assert.deepEqual([posted.status, posted.lifecycleStatus, posted.outstandingAmount], ["POSTED", "POSTED", "250.00"]);
        assert.deepEqual(await journalLines(harness, posted.journalId!), [
          { line: 1, ledger: fixture.expenseLedgerId, party: fixture.payeePartyId, debit: "250.00", credit: "0", source: "TEMPORARY_FUNDING" },
          { line: 2, ledger: fixture.payableLedgerId, party: fixture.individualPartyId, debit: "0", credit: "250.00", source: "TEMPORARY_FUNDING" }
        ]);
        assert.deepEqual(await subledgers(harness, posted.journalId!), [{
          line: 2, type: "TEMPORARY_FUNDING_PAYABLE", party: fixture.individualPartyId, funding: created.id,
          settlement: null, treasury: null, amount: "250.00", currency: "USD"
        }]);
        assert.equal(await safeMovement(harness, fixture.safeId), "0", "the Safe never moves for a direct payment");
        const intent = await harness.pool.query<{ kind: string; source_type: string; policy: string; mapping: string; version: number; journals: string }>(`
          SELECT intent.intent_kind AS kind, intent.source_type, intent.finance_workflow_policy_version_id::text AS policy,
                 intent.temporary_funding_mapping_version_id::text AS mapping, intent.operational_version AS version,
                 (SELECT count(*)::text FROM abos.journals journal WHERE journal.posting_intent_id = intent.id) AS journals
            FROM abos.posting_intents intent WHERE intent.temporary_funding_id = $1`, [created.id]);
        assert.deepEqual(intent.rows, [{ kind: "TEMPORARY_FUNDING", source_type: "TEMPORARY_FUNDING",
          policy: fixture.policyId, mapping: fixture.mappingVersionId, version: 2, journals: "1" }]);
        const workspace = await workspaceOf(fixture, fixture.sessions.creator);
        assert.equal(workspace.payableTotal, "250.00");
        assert.equal(workspace.capability.state, "OPERATIONAL");
        assert.equal(workspace.capability.reversalAvailable, false);
        assert.equal(workspace.capability.safeNonNegativeGuardActive, false);
        assert.deepEqual(workspace.providers.map((p) => [p.name, p.outstandingAmount, p.status]), [["Synthetic Individual", "250.00", "OUTSTANDING"]]);
        assert.deepEqual(await auditActions(harness, created.id),
          ["TEMPORARY_FUNDING_RECORDED", "TEMPORARY_FUNDING_APPROVED", "TEMPORARY_FUNDING_POSTED"]);
        assert.equal(await scalar(harness, `SELECT count(*) FROM abos.outbox_events WHERE aggregate_id = '${created.id}'`), 3);
      } finally { await fixture.close(); }
    });

    test("Mode B: Dr Safe / Cr provider payable; the Safe increases by exactly the funding", async () => {
      const fixture = await setupFixture(harness);
      try {
        const posted = await postFunding(fixture, modeB(fixture, "400.00"));
        assert.deepEqual(await journalLines(harness, posted.journalId!), [
          { line: 1, ledger: fixture.world.cashLedgerAccountId, party: null, debit: "400.00", credit: "0", source: "TEMPORARY_FUNDING" },
          { line: 2, ledger: fixture.payableLedgerId, party: fixture.organizationPartyId, debit: "0", credit: "400.00", source: "TEMPORARY_FUNDING" }
        ]);
        assert.deepEqual(await subledgers(harness, posted.journalId!), [
          { line: 1, type: "OPERATIONAL_TREASURY", party: null, funding: null, settlement: null, treasury: fixture.safeId, amount: "400.00", currency: "USD" },
          { line: 2, type: "TEMPORARY_FUNDING_PAYABLE", party: fixture.organizationPartyId, funding: posted.id, settlement: null, treasury: null, amount: "400.00", currency: "USD" }
        ]);
        assert.equal(await safeMovement(harness, fixture.safeId), "400.00");
        await assert.rejects(() => record(fixture, fixture.sessions.creator, { ...modeB(fixture, "5.00"), treasuryAccountId: fixture.bankId }),
          /Treasury account on a CASH asset account is required/, "Mode B funds a Safe, cash box or petty cash only");
      } finally { await fixture.close(); }
    });

    test("settlement: partial, full, over-settlement, duplicates, exact payable, no expense repost", async () => {
      const fixture = await setupFixture(harness);
      try {
        const funding = await postFunding(fixture, modeA(fixture, "100.00"));
        const expenseLines = await scalar(harness, `SELECT count(*) FROM abos.journal_lines WHERE ledger_account_id = '${fixture.expenseLedgerId}'`);
        const payload = settlementBody(fixture, funding, "40.00");
        const first = await requestSettlement(fixture, payload);
        const replay = await call<{ settlement: Settlement; replayed: boolean }>(fixture.executor,
          "SELECT abos.request_temporary_funding_settlement($1,$2,$3,$4::jsonb) AS value",
          [...args(fixture.sessions.settler), JSON.stringify({ ...payload, correlationId: randomUUID() })]);
        assert.deepEqual([replay.replayed, replay.settlement.id], [true, first.settlement.id]);
        await assert.rejects(() => requestSettlement(fixture, { ...payload, amount: { amount: "41.00", currency: "USD" } }),
          /idempotency key was already used/);
        await assert.rejects(() => requestSettlement(fixture, settlementBody(fixture, funding, "60.01")),
          /exceeds the outstanding temporary funding payable of 60/);
        const afterFirst = await decideSettlement(fixture, fixture.sessions.settleApprover, first.settlement.id, 1, "APPROVED");
        assert.deepEqual([afterFirst.funding.lifecycleStatus, afterFirst.funding.outstandingAmount], ["PARTIALLY_SETTLED", "60.00"]);
        const journal = afterFirst.settlement.journalId!;
        assert.deepEqual(await journalLines(harness, journal), [
          { line: 1, ledger: fixture.payableLedgerId, party: fixture.individualPartyId, debit: "40.00", credit: "0", source: "TEMPORARY_FUNDING_SETTLEMENT" },
          { line: 2, ledger: fixture.world.cashLedgerAccountId, party: null, debit: "0", credit: "40.00", source: "TEMPORARY_FUNDING_SETTLEMENT" }
        ]);
        assert.deepEqual(await subledgers(harness, journal), [
          { line: 1, type: "TEMPORARY_FUNDING_PAYABLE", party: fixture.individualPartyId, funding: funding.id, settlement: first.settlement.id, treasury: null, amount: "-40.00", currency: "USD" },
          { line: 2, type: "OPERATIONAL_TREASURY", party: null, funding: null, settlement: null, treasury: fixture.safeId, amount: "-40.00", currency: "USD" }
        ]);
        assert.equal(await providerBalance(harness, fixture.individualPartyId), "60.00");
        const second = await requestSettlement(fixture, settlementBody(fixture, funding, "60.00"));
        const settled = await decideSettlement(fixture, fixture.sessions.settleApprover, second.settlement.id, 1, "APPROVED");
        assert.deepEqual([settled.funding.lifecycleStatus, settled.funding.outstandingAmount], ["SETTLED", "0.00"]);
        assert.equal(await providerBalance(harness, fixture.individualPartyId), "0.00");
        await assert.rejects(() => requestSettlement(fixture, settlementBody(fixture, funding, "0.01")), /payable of 0/);
        await assert.rejects(() => decideSettlement(fixture, fixture.sessions.settleApprover, second.settlement.id, 1, "APPROVED"),
          /changed; reload|not waiting for approval/);
        assert.equal(await scalar(harness, `SELECT count(*) FROM abos.posting_intents WHERE temporary_funding_settlement_id = '${second.settlement.id}'`), 1);
        assert.equal(await scalar(harness, `SELECT count(*) FROM abos.journal_lines WHERE ledger_account_id = '${fixture.expenseLedgerId}'`),
          expenseLines, "settlement never reposts the expense");
        assert.equal(await scalar(harness, `SELECT count(*) FROM abos.journal_lines line
          JOIN abos.ledger_accounts ledger ON ledger.id = line.ledger_account_id
          WHERE line.source_type = 'TEMPORARY_FUNDING_SETTLEMENT' AND ledger.account_type = 'EXPENSE'`), 0);
        assert.equal(await safeMovement(harness, fixture.safeId), "-100.00");
        const workspace = await workspaceOf(fixture, fixture.sessions.settler);
        assert.deepEqual(workspace.providers.map((p) => [p.fundedAmount, p.settledAmount, p.outstandingAmount, p.status]),
          [["100.00", "100.00", "0.00", "SETTLED"]]);
        assert.deepEqual(await auditActions(harness, first.settlement.id), [
          "TEMPORARY_FUNDING_SETTLEMENT_REQUESTED", "TEMPORARY_FUNDING_SETTLEMENT_APPROVED", "TEMPORARY_FUNDING_SETTLEMENT_POSTED"]);
      } finally { await fixture.close(); }
    });

    test("concurrency: one approval posts once; concurrent settlements cannot exceed the payable", async () => {
      const fixture = await setupFixture(harness);
      try {
        const created = await record(fixture, fixture.sessions.creator, modeA(fixture, "100.00"));
        const approvals = await Promise.allSettled([
          decide(fixture, fixture.sessions.approver, created.id, created.version, "APPROVED"),
          decide(fixture, fixture.sessions.secondApprover, created.id, created.version, "APPROVED")
        ]);
        assert.equal(approvals.filter((result) => result.status === "fulfilled").length, 1);
        assert.equal(await scalar(harness, `SELECT count(*) FROM abos.journals journal JOIN abos.posting_intents intent
          ON intent.id = journal.posting_intent_id WHERE intent.temporary_funding_id = '${created.id}'`), 1);
        const funding = await fundingRow(harness, created.id);
        const requests = await Promise.allSettled([
          requestSettlement(fixture, settlementBody(fixture, funding, "60.00")),
          requestSettlement(fixture, settlementBody(fixture, funding, "60.00"))
        ]);
        assert.equal(requests.filter((result) => result.status === "fulfilled").length, 1);
        assert.match(String((requests.find((result) => result.status === "rejected") as PromiseRejectedResult).reason), /exceeds the outstanding/);
        const pending = (requests.find((result) => result.status === "fulfilled") as PromiseFulfilledResult<{ settlement: Settlement }>).value;
        const decisions = await Promise.allSettled([
          decideSettlement(fixture, fixture.sessions.settleApprover, pending.settlement.id, 1, "APPROVED"),
          decideSettlement(fixture, fixture.sessions.settleApprover, pending.settlement.id, 1, "APPROVED")
        ]);
        assert.equal(decisions.filter((result) => result.status === "fulfilled").length, 1);
        assert.equal(await providerBalance(harness, fixture.individualPartyId), "40.00");
      } finally { await fixture.close(); }
    });

    test("security: segregation, provider independence, entity, forged actor, synthetic provenance, runtime boundary", async () => {
      const fixture = await setupFixture(harness);
      try {
        const created = await record(fixture, fixture.sessions.creator, modeA(fixture, "20.00"));
        await grant(harness, fixture.world, fixture.world.intentCreatorId, "finance.temporary-funding.approve");
        await assert.rejects(() => decide(fixture, fixture.sessions.creator, created.id, created.version, "APPROVED"),
          /recorder or the funding provider cannot decide/);
        await assert.rejects(() => decide(fixture, fixture.sessions.settler, created.id, created.version, "APPROVED"),
          /current authority is missing finance.temporary-funding.approve/);
        await assert.rejects(() => record(fixture, fixture.sessions.outsider, modeA(fixture, "5.00")),
          /current authority is missing finance.temporary-funding.record/);
        // The provider's own user can never approve the provider's funding or settlement.
        const officer = await record(fixture, fixture.sessions.creator, { ...modeA(fixture, "30.00"),
          providerKind: "EMPLOYEE", providerBusinessPartyId: fixture.employeePartyId });
        await assert.rejects(() => decide(fixture, fixture.sessions.approver, officer.id, officer.version, "APPROVED"),
          /recorder or the funding provider cannot decide/);
        const posted = await decide(fixture, fixture.sessions.secondApprover, officer.id, officer.version, "APPROVED");
        await grant(harness, fixture.world, fixture.world.approverId, "finance.temporary-funding.settle-approve");
        await grant(harness, fixture.world, fixture.world.cashierId, "finance.temporary-funding.settle-approve");
        const settlement = await requestSettlement(fixture, settlementBody(fixture, posted, "30.00"));
        await assert.rejects(() => decideSettlement(fixture, fixture.sessions.settler, settlement.settlement.id, 1, "APPROVED"),
          /settlement preparer or the funding provider cannot decide/);
        await assert.rejects(() => decideSettlement(fixture, fixture.sessions.approver, settlement.settlement.id, 1, "APPROVED"),
          /settlement preparer or the funding provider cannot decide/);
        // A stale source version is refused.
        await assert.rejects(() => requestSettlement(fixture, { ...settlementBody(fixture, posted, "1.00"), expectedFundingVersion: 1 }),
          /changed; reload/);
        // Wrong entity: another company sees and decides nothing.
        const other = await seedSyntheticWorld(harness.executor, { withoutSandboxAuthorization: true });
        await harness.executor.query(`INSERT INTO abos.sandbox_legal_entity_scopes (legal_entity_id, base_currency_code, authorized_by_user_account_id)
          VALUES ($1, 'USD', $2)`, [other.legalEntityId, fixture.world.bootstrapUserId]);
        for (const permission of ["finance.temporary-funding.read", "finance.temporary-funding.approve", "finance.temporary-funding.settle"]) {
          await grant(harness, other, other.approverId, permission);
        }
        const foreign = await sessionFor(harness, other, other.approverId);
        assert.equal((await workspaceOf(fixture, foreign)).fundings.length, 0);
        await assert.rejects(() => decide(fixture, foreign, created.id, created.version, "APPROVED"), /not available in this legal entity/);
        await assert.rejects(() => requestSettlement(fixture, settlementBody(fixture, posted, "1.00"), foreign), /not available in this legal entity/);
        // Forged actor: a tampered token digest or proof resolves to no session.
        const forged = { ...fixture.sessions.approver, tokenDigest: createHash("sha256").update(randomUUID()).digest("hex") };
        await assert.rejects(() => decide(fixture, forged, created.id, created.version, "APPROVED"), /sign in with an active account/);
        await assert.rejects(() => decide(fixture, { ...fixture.sessions.approver, proof: "x".repeat(40) }, created.id, created.version, "APPROVED"),
          /identity runtime proof is invalid/);
        // Synthetic developer provenance fails closed.
        const developer = await new SandboxAuthenticator(harness.executor, SYNTHETIC_AUTH_CONFIGURATION).issueSession({
          userAccountId: fixture.world.treasuryApproverId as UserAccountId, legalEntityId: fixture.world.legalEntityId as LegalEntityId });
        await assert.rejects(() => decide(fixture, sessionArgs(developer.token), created.id, created.version, "APPROVED"),
          /sign in with an active account/);
        // Runtime has no direct table access and cannot call internals or escalate.
        for (const table of [...FUNDING_TABLES, "posting_intents", "journals", "subledger_entries"]) {
          assert.equal((await harness.pool.query<{ ok: boolean }>(
            `SELECT has_table_privilege('abos_e1_runtime', 'abos.${table}', 'INSERT,UPDATE,DELETE') AS ok`)).rows[0]?.ok, false, table);
        }
        await assert.rejects(() => fixture.executor.query("SELECT * FROM abos.temporary_fundings"), /permission denied/);
        await assert.rejects(() => fixture.executor.query("SELECT abos.temporary_funding_post($1,$2)", [created.id, fixture.world.approverId]), /permission denied/);
        await assert.rejects(() => fixture.executor.query("SET ROLE abos_v1_operational_finance_owner"), /permission denied/);
        const definers = await harness.pool.query<{ name: string; owner: string; config: string[] }>(`
          SELECT proname AS name, pg_get_userbyid(proowner) AS owner, proconfig AS config FROM pg_proc
           WHERE pronamespace = 'abos'::regnamespace AND prosecdef AND proname ~ 'temporary_funding' ORDER BY proname`);
        assert.equal(definers.rows.length, 7);
        assert.ok(definers.rows.every((row) => row.owner === "abos_v1_operational_finance_owner"
          && row.config.includes("search_path=pg_catalog, pg_temp")), JSON.stringify(definers.rows));
        assert.equal(await scalar(harness, `SELECT count(*) FROM pg_proc WHERE pronamespace = 'abos'::regnamespace
          AND proname ~ 'temporary_funding' AND has_function_privilege('public', oid, 'EXECUTE')`), 0);
      } finally { await fixture.close(); }
    });

    test("accounting controls: base currency only, approval policy fails closed, immutable sources", async () => {
      const fixture = await setupFixture(harness);
      try {
        await assert.rejects(() => record(fixture, fixture.sessions.creator, { ...modeA(fixture, "5.00"), amount: { amount: "5.00", currency: "AFN" } }),
          /base-currency only/);
        await assert.rejects(() => record(fixture, fixture.sessions.creator, { ...modeA(fixture, "5.00"), providerKind: "EXTERNAL_OTHER",
          providerBusinessPartyId: fixture.shareholderPartyId }), /provider kind does not match/);
        await assert.rejects(() => record(fixture, fixture.sessions.creator, { ...modeA(fixture, "5.00"), providerKind: "SHAREHOLDER" }),
          /provider kind does not match/);
        const pending = await record(fixture, fixture.sessions.creator, modeA(fixture, "15.00"));
        await harness.executor.query(`INSERT INTO abos.finance_workflow_policy_versions (id, legal_entity_id, workflow_type, version,
            approval_required, configured_by_user_account_id, change_reason)
          VALUES (gen_random_uuid(), $1, 'TEMPORARY_FUNDING', 2, false, $2, 'Synthetic attempt to drop approval')`,
        [fixture.world.legalEntityId, fixture.world.bootstrapUserId]);
        await assert.rejects(() => record(fixture, fixture.sessions.creator, modeA(fixture, "5.00")), /approval-required/);
        await assert.rejects(() => decide(fixture, fixture.sessions.approver, pending.id, pending.version, "APPROVED"), /approval-required/);
        assert.equal((await workspaceOf(fixture, fixture.sessions.creator)).capability.state, "NOT_OPERATIONAL");
        await harness.executor.query(`INSERT INTO abos.finance_workflow_policy_versions (id, legal_entity_id, workflow_type, version,
            approval_required, configured_by_user_account_id, change_reason)
          VALUES (gen_random_uuid(), $1, 'TEMPORARY_FUNDING', 3, true, $2, 'Synthetic approval restored')`,
        [fixture.world.legalEntityId, fixture.world.bootstrapUserId]);
        const posted = await decide(fixture, fixture.sessions.approver, pending.id, pending.version, "APPROVED");
        // Source immutability holds even for a superuser, and the owner has no column privilege to try.
        await assert.rejects(() => harness.pool.query(`UPDATE abos.temporary_fundings SET original_amount = 1, base_amount = 1,
          version = version + 1, updated_at = clock_timestamp() WHERE id = $1`, [posted.id]), /accounting identity of a temporary funding cannot change/);
        for (const column of ["provider_business_party_id = provider_business_party_id", "business_date = business_date + 1",
          "mapping_version_id = mapping_version_id"]) {
          await assert.rejects(() => harness.pool.query(`UPDATE abos.temporary_fundings SET ${column}, version = version + 1,
            updated_at = clock_timestamp() WHERE id = $1`, [posted.id]), /cannot change|invalid temporary funding transition/);
        }
        await assert.rejects(() => harness.pool.query("DELETE FROM abos.temporary_fundings WHERE id = $1", [posted.id]), /permanent/);
        await roleRejects(harness, "abos_v1_operational_finance_owner",
          `UPDATE abos.temporary_fundings SET original_amount = 1 WHERE id = '${posted.id}'`, /permission denied/);
        await assert.rejects(() => harness.pool.query("UPDATE abos.journal_lines SET base_debit = 1 WHERE journal_id = $1", [posted.journalId]));
      } finally { await fixture.close(); }
    });

    test("reversal is fail-closed and the Safe non-negative guard stays dormant", async () => {
      const fixture = await setupFixture(harness);
      try {
        const funding = await postFunding(fixture, modeB(fixture, "10.00"));
        const evidence = await evidenceRow(harness, fixture.world, "REVERSAL_REASON");
        await assert.rejects(() => harness.pool.query(`INSERT INTO abos.journal_reversal_links
            (original_journal_id, reversal_journal_id, reason, approved_by_user_account_id, evidence_reference_id)
          VALUES ($1, $1, 'Synthetic reversal attempt', $2, $3)`, [funding.journalId, fixture.world.bootstrapUserId, evidence]),
        /temporary funding reversal is not active/);
        assert.equal((await workspaceOf(fixture, fixture.sessions.creator)).capability.reversalAvailable, false);
        // Dormant guard: a Safe-funded expense far beyond recorded Safe cash still posts exactly as before 0037.
        await grant(harness, fixture.world, fixture.world.intentCreatorId, "finance.expense.create");
        const created = await call<{ expense: { id: string; version: number } }>(fixture.executor,
          "SELECT abos.operational_expense_create($1,$2,$3,$4::jsonb) AS value",
          [...args(fixture.sessions.creator), JSON.stringify(expensePayload(fixture.safeId, fixture.categoryId, "900.00"))]);
        const posted = await call<{ expense: { status: string } }>(fixture.executor,
          "SELECT abos.operational_expense_approve($1,$2,$3,$4,$5,$6) AS value",
          [...args(fixture.sessions.approver), created.expense.id, created.expense.version, "Synthetic approval note"]);
        assert.equal(posted.expense.status, "POSTED");
        assert.equal(await safeMovement(harness, fixture.safeId), "-890.00");
      } finally { await fixture.close(); }
    });

    test("provider identity: never from the request, required, bound per funding, and enforced on approvals", async () => {
      const fixture = await setupFixture(harness);
      try {
        const { world, sessions } = fixture;
        // (1)(9) The request cannot supply or forge the provider's user identity or its profile version.
        await assert.rejects(() => record(fixture, sessions.creator, { ...modeA(fixture, "5.00"), providerUserAccountId: world.intentCreatorId }),
          /unsupported fields/);
        await assert.rejects(() => record(fixture, sessions.creator, { ...modeA(fixture, "5.00"),
          providerUserAccountId: world.treasuryApproverId }), /unsupported fields/);
        await assert.rejects(() => record(fixture, sessions.creator, { ...modeA(fixture, "5.00"),
          providerIdentityVersionId: randomUUID() }), /unsupported fields/);
        // (2) A provider without an identity profile cannot fund.
        const unconfigured = randomUUID();
        await harness.executor.query(`INSERT INTO abos.business_parties (id, legal_entity_id, display_name, external_reference, status)
          VALUES ($1,$2,'Synthetic Unconfigured Lender',$3,'ACTIVE')`, [unconfigured, world.legalEntityId, `SYN-${unconfigured.slice(0, 8)}`]);
        await assert.rejects(() => record(fixture, sessions.creator, { ...modeA(fixture, "5.00"), providerBusinessPartyId: unconfigured }),
          /provider identity is not configured/);
        // (3)(4)(5) The bound ABOS user (approver) is refused for funding and settlement; an independent approver succeeds.
        const funding = await record(fixture, sessions.creator, { ...modeA(fixture, "40.00"), providerKind: "EMPLOYEE",
          providerBusinessPartyId: fixture.employeePartyId });
        const bound = await harness.pool.query<{ user: string | null; version: number }>(`SELECT funding.provider_user_account_id AS user,
            identity.version FROM abos.temporary_fundings funding JOIN abos.temporary_funding_provider_identity_versions identity
            ON identity.id = funding.provider_identity_version_id WHERE funding.id = $1`, [funding.id]);
        assert.deepEqual(bound.rows[0], { user: world.approverId, version: 1 });
        // (6) A later identity change does not change this funding's bound identity.
        await configureIdentity(fixture.executor, sessions.identityAdmin, fixture.employeePartyId, 1, null);
        await assert.rejects(() => decide(fixture, sessions.approver, funding.id, funding.version, "APPROVED"),
          /recorder or the funding provider cannot decide/);
        const posted = await decide(fixture, sessions.secondApprover, funding.id, funding.version, "APPROVED");
        await grant(harness, world, world.approverId, "finance.temporary-funding.settle-approve");
        const settlement = await requestSettlement(fixture, settlementBody(fixture, posted, "10.00"));
        await assert.rejects(() => decideSettlement(fixture, sessions.approver, settlement.settlement.id, 1, "APPROVED"),
          /settlement preparer or the funding provider cannot decide/);
        const settled = await decideSettlement(fixture, sessions.settleApprover, settlement.settlement.id, 1, "APPROVED");
        assert.equal(settled.funding.lifecycleStatus, "PARTIALLY_SETTLED");
        // A funding recorded after the change binds the new profile (no ABOS user), so the approver is independent there.
        const later = await record(fixture, sessions.creator, { ...modeA(fixture, "7.00"), providerKind: "EMPLOYEE",
          providerBusinessPartyId: fixture.employeePartyId });
        assert.equal((await decide(fixture, sessions.approver, later.id, later.version, "APPROVED")).status, "POSTED");
        // Superuser cannot bind a stale profile version either.
        await assert.rejects(() => harness.pool.query(`INSERT INTO abos.temporary_fundings
            (id, legal_entity_id, funding_mode, provider_kind, provider_business_party_id, provider_identity_version_id,
             provider_user_account_id, operational_expense_category_id, reference, description, business_date, original_amount,
             original_currency_code, base_amount, base_currency_code, workflow_policy_version_id, mapping_version_id, correlation_id,
             idempotency_key, request_fingerprint, status, version, created_by_user_account_id)
          SELECT gen_random_uuid(), legal_entity_id, funding_mode, provider_kind, provider_business_party_id,
                 provider_identity_version_id, NULL, operational_expense_category_id, 'SYN-FORGED', 'Forged binding', business_date,
                 1, 'USD', 1, 'USD', workflow_policy_version_id, mapping_version_id, gen_random_uuid(), 'forged-binding-key',
                 repeat('d', 64), 'PENDING_APPROVAL', 1, created_by_user_account_id
            FROM abos.temporary_fundings WHERE id = $1`, [funding.id]), /current valid identity profile/);
        // Profiles are append-only.
        await assert.rejects(() => harness.pool.query(`UPDATE abos.temporary_funding_provider_identity_versions
          SET user_account_id = NULL, identity_mode = 'NO_ABOS_USER' WHERE business_party_id = $1`, [fixture.employeePartyId]));
      } finally { await fixture.close(); }
    });

    test("provider identity authority: Super Administrator only; wrong-entity, revoked and ambiguous users refused", async () => {
      const fixture = await setupFixture(harness);
      try {
        const { world, sessions } = fixture;
        const lender = randomUUID();
        await harness.executor.query(`INSERT INTO abos.business_parties (id, legal_entity_id, display_name, external_reference, status)
          VALUES ($1,$2,'Synthetic Lender',$3,'ACTIVE')`, [lender, world.legalEntityId, `SYN-${lender.slice(0, 8)}`]);
        // Not a Finance permission: a funding recorder or payable configurer cannot set identities.
        await assert.rejects(() => configureIdentity(fixture.executor, sessions.creator, lender, 0, null),
          /current authority is missing admin.users.manage/);
        await assert.rejects(() => configureIdentity(fixture.executor, sessions.configurer, lender, 0, null),
          /current authority is missing admin.users.manage/);
        await grant(harness, world, world.treasuryReconcilerId, "admin.users.manage");
        await assert.rejects(() => configureIdentity(fixture.executor, sessions.outsider, lender, 0, null),
          /current authority is missing admin.roles.manage/);
        // (7) A user from another legal entity (no grant here) is refused.
        const other = await seedSyntheticWorld(harness.executor, { withoutSandboxAuthorization: true });
        await grant(harness, other, other.approverId, "finance.temporary-funding.read");
        await assert.rejects(() => configureIdentity(fixture.executor, sessions.identityAdmin, lender, 0, other.approverId),
          /must be active with a current grant in this legal entity/);
        // (8) A user whose grants are revoked, or who is disabled, is refused; and a profile that becomes invalid fails closed.
        await harness.executor.query(`UPDATE abos.user_permission_grants SET revoked_at = clock_timestamp()
          WHERE user_account_id = $1 AND legal_entity_id = $2`, [world.reverserId, world.legalEntityId]);
        await assert.rejects(() => configureIdentity(fixture.executor, sessions.identityAdmin, lender, 0, world.reverserId),
          /must be active with a current grant in this legal entity/);
        const configured = await configureIdentity(fixture.executor, sessions.identityAdmin, lender, 0, world.cashierId);
        assert.equal(configured.version, 1);
        await assert.rejects(() => configureIdentity(fixture.executor, sessions.identityAdmin, lender, 0, null), /changed; reload/);
        // Ambiguity: the same user cannot be the current identity of two providers.
        await assert.rejects(() => configureIdentity(fixture.executor, sessions.identityAdmin, fixture.individualPartyId, 1, world.cashierId),
          /already the current identity of another provider/);
        await harness.executor.query("UPDATE abos.user_accounts SET status = 'DISABLED', disabled_at = clock_timestamp() WHERE id = $1",
          [world.cashierId]);
        await assert.rejects(() => record(fixture, sessions.creator, { ...modeA(fixture, "5.00"), providerBusinessPartyId: lender }),
          /no longer valid or is ambiguous/);
        assert.equal(await auditCount(harness, "TEMPORARY_FUNDING_PROVIDER_IDENTITY_CONFIGURED"), 5, "four fixture profiles and one here");
      } finally { await fixture.close(); }
    });

    test("provider classification is only what live roles prove", async () => {
      const fixture = await setupFixture(harness);
      try {
        const { world, sessions } = fixture;
        // (10) EMPLOYEE requires a current EMPLOYEE role on the business date.
        await assert.rejects(() => record(fixture, sessions.creator, { ...modeA(fixture, "5.00"), providerKind: "EMPLOYEE" }),
          /provider kind does not match/);
        const future = randomUUID();
        await harness.executor.query(`INSERT INTO abos.business_parties (id, legal_entity_id, display_name, external_reference, status)
          VALUES ($1,$2,'Synthetic Future Employee',$3,'ACTIVE')`, [future, world.legalEntityId, `SYN-${future.slice(0, 8)}`]);
        await harness.executor.query(`INSERT INTO abos.business_party_roles (business_party_id, role_code, effective_from)
          VALUES ($1,'EMPLOYEE','2026-12-01')`, [future]);
        await configureIdentity(fixture.executor, sessions.identityAdmin, future, 0, null);
        await assert.rejects(() => record(fixture, sessions.creator, { ...modeA(fixture, "5.00"), providerKind: "EMPLOYEE",
          providerBusinessPartyId: future }), /provider kind does not match/);
        const external = await record(fixture, sessions.creator, { ...modeA(fixture, "5.00"), providerKind: "EXTERNAL_OTHER",
          providerBusinessPartyId: future });
        assert.equal(external.status, "PENDING_APPROVAL");
        // (11) SHAREHOLDER requires a current SHAREHOLDER role; a shareholder is never recorded as anything else.
        await assert.rejects(() => record(fixture, sessions.creator, { ...modeA(fixture, "5.00"), providerKind: "SHAREHOLDER" }),
          /provider kind does not match/);
        await assert.rejects(() => record(fixture, sessions.creator, { ...modeA(fixture, "5.00"), providerKind: "EMPLOYEE",
          providerBusinessPartyId: fixture.shareholderPartyId }), /provider kind does not match/);
        // (12) No unverifiable person/organization classification is accepted or stored.
        for (const kind of ["INDIVIDUAL", "ORGANIZATION", "EMPLOYEE_OFFICER"]) {
          await assert.rejects(() => record(fixture, sessions.creator, { ...modeA(fixture, "5.00"), providerKind: kind }),
            /complete valid temporary funding request/, kind);
        }
        const kinds = await harness.pool.query<{ definition: string }>(`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
          WHERE conrelid = 'abos.temporary_fundings'::regclass AND pg_get_constraintdef(oid) LIKE '%provider_kind%'`);
        assert.match(kinds.rows[0]?.definition ?? "", /SHAREHOLDER.*EMPLOYEE.*EXTERNAL_OTHER/);
        assert.doesNotMatch(kinds.rows[0]?.definition ?? "", /INDIVIDUAL|ORGANIZATION/);
        const organization = await record(fixture, sessions.creator, modeB(fixture, "8.00"));
        assert.equal((await harness.pool.query<{ kind: string }>("SELECT provider_kind AS kind FROM abos.temporary_fundings WHERE id = $1",
          [organization.id])).rows[0]?.kind, "EXTERNAL_OTHER");
      } finally { await fixture.close(); }
    });

    test("coordination: no shareholder-capital contamination and forged typed sources are refused", async () => {
      const fixture = await setupFixture(harness);
      try {
        const funding = await postFunding(fixture, { ...modeB(fixture, "500.00"), providerKind: "SHAREHOLDER",
          providerBusinessPartyId: fixture.shareholderPartyId });
        assert.equal(await scalar(harness, `SELECT count(*) FROM abos.subledger_entries
          WHERE subledger_type IN ('SHAREHOLDER_CAPITAL', 'SHAREHOLDER_LOAN') OR shareholder_capital_receipt_id IS NOT NULL`), 0);
        assert.equal(await scalar(harness, `SELECT count(*) FROM abos.journal_lines line JOIN abos.ledger_accounts ledger
          ON ledger.id = line.ledger_account_id WHERE line.journal_id = '${funding.journalId}'
          AND (ledger.account_type = 'EQUITY' OR ledger.control_account_type IN ('SHAREHOLDER_CAPITAL', 'SHAREHOLDER_LOAN'))`), 0);
        assert.equal(await providerBalance(harness, fixture.shareholderPartyId), "500.00");
        assert.equal(await scalar(harness, `SELECT count(*) FROM abos.posting_intents
          WHERE source_type = 'SHAREHOLDER_CAPITAL_CONTRIBUTION_RECEIPT'`), 0);
        const client = await harness.pool.connect();
        try {
          await client.query("BEGIN");
          await client.query("SET LOCAL ROLE abos_v1_operational_finance_owner");
          await assert.rejects(() => client.query(`INSERT INTO abos.posting_intents
              (id, legal_entity_id, source_type, source_id, intent_kind, original_amount, original_currency_code, base_amount,
               base_currency_code, accounting_effective_date, correlation_id, idempotency_key, status, created_by_user_account_id,
               processing_model, finance_workflow_policy_version_id, temporary_funding_mapping_version_id, operational_version)
            SELECT gen_random_uuid(), legal_entity_id, 'TEMPORARY_FUNDING', id, 'TEMPORARY_FUNDING', 1, 'USD', 1, 'USD',
                   business_date, correlation_id, 'TFP:forged', 'APPROVED', created_by_user_account_id, 'OPERATIONAL_V1',
                   workflow_policy_version_id, mapping_version_id, 1
              FROM abos.temporary_fundings WHERE id = $1`, [funding.id]), /posting_intents_temporary_funding_source/);
          await client.query("ROLLBACK");
          await client.query("BEGIN");
          await client.query("SET LOCAL ROLE abos_v1_operational_finance_owner");
          await assert.rejects(() => client.query(`INSERT INTO abos.posting_intents
              (id, legal_entity_id, source_type, source_id, intent_kind, original_amount, original_currency_code, base_amount,
               base_currency_code, accounting_effective_date, correlation_id, idempotency_key, status, created_by_user_account_id,
               processing_model, temporary_funding_id, finance_workflow_policy_version_id, temporary_funding_mapping_version_id,
               operational_version)
            SELECT gen_random_uuid(), legal_entity_id, 'TEMPORARY_FUNDING', id, 'TEMPORARY_FUNDING', original_amount, 'USD',
                   base_amount, 'USD', business_date, correlation_id, 'TFP:duplicate', 'APPROVED', created_by_user_account_id,
                   'OPERATIONAL_V1', id, workflow_policy_version_id, mapping_version_id, 1
              FROM abos.temporary_fundings WHERE id = $1`, [funding.id]), /duplicate key value|posting_intents_legal_entity_id_source_type_source_id_key/);
        } finally { await client.query("ROLLBACK").catch(() => undefined); client.release(); }
      } finally { await fixture.close(); }
    });
  });
}

// ---------------------------------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------------------------------

async function setupFixture(harness: Harness): Promise<Fixture> {
  await resetSchema(harness.pool);
  const world = await seedSyntheticWorld(harness.executor);
  const lane = await configureExpenseLane(harness, world);
  const q = (sql: string, parameters: readonly unknown[] = []) => harness.executor.query(sql, parameters);
  const bankId = randomUUID(); const policyId = randomUUID();
  const bankLedgerId = await ledger(harness, world, `SYN-BNK-${bankId.slice(0, 6)}`, "ASSET", "CASH");
  await q(`INSERT INTO abos.operational_treasury_accounts (id, legal_entity_id, name_en, account_type, currency_code,
      ledger_account_id, status, version, created_by_user_account_id, last_changed_by_user_account_id)
    VALUES ($1,$2,'Synthetic Bank','BANK','USD',$3,'ACTIVE',1,$4,$4)`, [bankId, world.legalEntityId, bankLedgerId, world.bootstrapUserId]);
  const payableLedgerId = await ledger(harness, world, "SYN-2150", "LIABILITY", "TEMPORARY_FUNDING_PAYABLE");
  await q(`INSERT INTO abos.finance_workflow_policy_versions (id, legal_entity_id, workflow_type, version, approval_required,
      configured_by_user_account_id, change_reason)
    VALUES ($1,$2,'TEMPORARY_FUNDING',1,true,$3,'Synthetic test-only approval route.')`, [policyId, world.legalEntityId, world.bootstrapUserId]);
  const party = async (name: string, role: string | null): Promise<string> => {
    const id = randomUUID();
    await q(`INSERT INTO abos.business_parties (id, legal_entity_id, display_name, external_reference, status)
      VALUES ($1,$2,$3,$4,'ACTIVE')`, [id, world.legalEntityId, name, `SYN-${id.slice(0, 8)}`]);
    if (role !== null) {
      await q(`INSERT INTO abos.business_party_roles (business_party_id, role_code, effective_from) VALUES ($1,$2,'2026-01-01')`, [id, role]);
    }
    return id;
  };
  const shareholderPartyId = await party("Synthetic Funding Shareholder", "SHAREHOLDER");
  const employeePartyId = await party("Synthetic Officer", "EMPLOYEE");
  const individualPartyId = await party("Synthetic Individual", null);
  const organizationPartyId = await party("Synthetic Organization", null);
  const payeePartyId = await party("Synthetic Supplier", "SUPPLIER");
  for (const [userId, permission] of [
    [world.intentCreatorId, "finance.temporary-funding.record"], [world.intentCreatorId, "finance.temporary-funding.read"],
    [world.approverId, "finance.temporary-funding.approve"], [world.approverId, "finance.temporary-funding.read"],
    [world.treasuryApproverId, "finance.temporary-funding.approve"],
    [world.cashierId, "finance.temporary-funding.settle"], [world.cashierId, "finance.temporary-funding.read"],
    [world.counterId, "finance.temporary-funding.settle-approve"],
    [world.treasuryManagerId, "finance.temporary-funding.configure"],
    [world.countConfirmerId, "admin.users.manage"], [world.countConfirmerId, "admin.roles.manage"]
  ] as const) await grant(harness, world, userId, permission);
  await ensureLogin(harness);
  const connection = restricted();
  const sessions: Sessions = {
    creator: await sessionFor(harness, world, world.intentCreatorId),
    approver: await sessionFor(harness, world, world.approverId),
    secondApprover: await sessionFor(harness, world, world.treasuryApproverId),
    settler: await sessionFor(harness, world, world.cashierId),
    settleApprover: await sessionFor(harness, world, world.counterId),
    configurer: await sessionFor(harness, world, world.treasuryManagerId),
    outsider: await sessionFor(harness, world, world.treasuryReconcilerId),
    identityAdmin: await sessionFor(harness, world, world.countConfirmerId)
  };
  for (const [partyId, userId] of [[shareholderPartyId, null], [individualPartyId, null], [organizationPartyId, null],
    [employeePartyId, world.approverId]] as const) {
    await configureIdentity(connection.executor, sessions.identityAdmin, partyId, 0, userId);
  }
  const configured = await call<{ mappingVersionId: string; version: number }>(connection.executor,
    "SELECT abos.configure_temporary_funding_mapping($1,$2,$3,$4::jsonb) AS value",
    [...args(sessions.configurer), JSON.stringify({ ledgerAccountId: payableLedgerId,
      evidenceDocumentReference: "SYN-AUTHORIZATION-001", evidenceSha256: createHash("sha256").update("synthetic").digest("hex"),
      changeReason: "Synthetic payable mapping", idempotencyKey: `cfg-${randomUUID()}`, correlationId: randomUUID() })]);
  assert.equal(configured.version, 1);
  return { world, safeId: lane.safeId, bankId, categoryId: lane.categoryId, expenseLedgerId: lane.expenseLedgerId,
    payableLedgerId, mappingVersionId: configured.mappingVersionId, policyId, shareholderPartyId, employeePartyId,
    individualPartyId, organizationPartyId, payeePartyId, sessions, executor: connection.executor, close: connection.close };
}

/** Synthetic Operational V1 expense configuration (Safe, category, approval-required EXPENSE policy, grants). */
async function configureExpenseLane(harness: Harness, world: SyntheticWorld): Promise<{ safeId: string; categoryId: string; expenseLedgerId: string }> {
  const safeId = randomUUID(); const categoryId = randomUUID();
  const expenseLedgerId = await ledger(harness, world, `SYN-EXP-${safeId.slice(0, 6)}`, "EXPENSE", null);
  await harness.executor.query(`INSERT INTO abos.operational_treasury_accounts (id, legal_entity_id, name_en, name_fa, account_type,
      currency_code, ledger_account_id, status, version, created_by_user_account_id, last_changed_by_user_account_id)
    VALUES ($1,$2,'Synthetic Main Safe','صندوق اصلی آزمایشی','SAFE','USD',$3,'ACTIVE',1,$4,$4)`,
  [safeId, world.legalEntityId, world.cashLedgerAccountId, world.bootstrapUserId]);
  await harness.executor.query(`INSERT INTO abos.operational_expense_categories (id, legal_entity_id, category_code, name_en, name_fa,
      ledger_account_id, status, version, created_by_user_account_id, last_changed_by_user_account_id)
    VALUES ($1,$2,'SYN-OPS','Synthetic Operations','عملیات آزمایشی',$3,'ACTIVE',1,$4,$4)`,
  [categoryId, world.legalEntityId, expenseLedgerId, world.bootstrapUserId]);
  await harness.executor.query(`INSERT INTO abos.finance_workflow_policy_versions (id, legal_entity_id, workflow_type, version,
      approval_required, configured_by_user_account_id, change_reason)
    VALUES (gen_random_uuid(),$1,'EXPENSE',1,true,$2,'Synthetic test-only expense route.')`, [world.legalEntityId, world.bootstrapUserId]);
  for (const [userId, permission] of [[world.intentCreatorId, "finance.expense.create"], [world.intentCreatorId, "finance.expense.read"],
    [world.approverId, "finance.expense.approve"]] as const) await grant(harness, world, userId, permission);
  return { safeId, categoryId, expenseLedgerId };
}

async function ledger(harness: Harness, world: SyntheticWorld, code: string, type: string, control: string | null): Promise<string> {
  const id = randomUUID();
  await harness.executor.query(`INSERT INTO abos.ledger_accounts (id, legal_entity_id, account_code, account_name, account_type,
      control_account_type, posting_allowed, account_currency_code, status)
    VALUES ($1,$2,$3,$4,$5,$6,true,'USD','ACTIVE')`, [id, world.legalEntityId, code, `Synthetic ${code}`, type, control]);
  return id;
}

async function evidenceRow(harness: Harness, world: SyntheticWorld, kind: string): Promise<string> {
  const id = randomUUID();
  await harness.executor.query(`INSERT INTO abos.evidence_references (id, legal_entity_id, document_id, evidence_kind,
      evidence_version, sha256, completed_at) VALUES ($1,$2,gen_random_uuid(),$3,1,$4,clock_timestamp())`,
  [id, world.legalEntityId, kind, createHash("sha256").update(id).digest("hex")]);
  return id;
}

// ---------------------------------------------------------------------------------------------------
// Entry-point calls (restricted runtime only)
// ---------------------------------------------------------------------------------------------------

async function configureIdentity(executor: PostgresExecutor, session: SessionArgs, businessPartyId: string,
  expectedVersion: number, userAccountId: string | null): Promise<{ providerIdentityVersionId: string; version: number; replayed: boolean }> {
  return call(executor, "SELECT abos.configure_temporary_funding_provider_identity($1,$2,$3,$4::jsonb) AS value",
    [...args(session), JSON.stringify({ businessPartyId, expectedVersion, identityMode: userAccountId === null ? "NO_ABOS_USER" : "ABOS_USER",
      userAccountId, evidenceDocumentReference: "SYN-IDENTITY-DECLARATION", evidenceSha256: "c".repeat(64),
      changeReason: "Synthetic provider identity", idempotencyKey: `pid-${randomUUID()}`, correlationId: randomUUID() })]);
}

function modeA(fixture: Fixture, amount: string): Record<string, unknown> {
  return { fundingMode: "PROVIDER_PAID_EXPENSE_DIRECTLY", providerKind: "EXTERNAL_OTHER", providerBusinessPartyId: fixture.individualPartyId,
    expenseCategoryId: fixture.categoryId, payeeBusinessPartyId: fixture.payeePartyId, reference: `TF-${randomUUID().slice(0, 8)}`,
    description: "Provider paid a synthetic supplier directly", businessDate: DATE, amount: { amount, currency: "USD" },
    idempotencyKey: `tf-${randomUUID()}`, correlationId: randomUUID() };
}

function modeB(fixture: Fixture, amount: string): Record<string, unknown> {
  return { fundingMode: "PROVIDER_FUNDED_SAFE", providerKind: "EXTERNAL_OTHER", providerBusinessPartyId: fixture.organizationPartyId,
    treasuryAccountId: fixture.safeId, reference: `TF-${randomUUID().slice(0, 8)}`, description: "Provider placed synthetic cash in the Safe",
    businessDate: DATE, amount: { amount, currency: "USD" }, idempotencyKey: `tf-${randomUUID()}`, correlationId: randomUUID() };
}

function settlementBody(fixture: Fixture, funding: { id: string; version: number }, amount: string): Record<string, unknown> {
  return { temporaryFundingId: funding.id, expectedFundingVersion: funding.version, treasuryAccountId: fixture.safeId,
    amount: { amount, currency: "USD" }, businessDate: "2026-09-25", reference: `TFS-${randomUUID().slice(0, 8)}`,
    idempotencyKey: `tfs-${randomUUID()}`, correlationId: randomUUID() };
}

function expensePayload(safeId: string, categoryId: string, amount: string): Record<string, unknown> {
  return { treasuryAccountId: safeId, expenseCategoryId: categoryId, payeeBusinessPartyId: null, projectId: null, departmentId: null,
    costCenterId: null, reference: `EXP-${randomUUID().slice(0, 8)}`, description: "Synthetic ordinary Safe-funded expense", note: null,
    businessDate: DATE, originalAmount: amount, currencyCode: "USD", exchangeRateId: null, correlationId: randomUUID(),
    idempotencyKey: `expense-${randomUUID()}` };
}

async function configure(fixture: Fixture, ledgerAccountId: string): Promise<unknown> {
  return call(fixture.executor, "SELECT abos.configure_temporary_funding_mapping($1,$2,$3,$4::jsonb) AS value",
    [...args(fixture.sessions.configurer), JSON.stringify({ ledgerAccountId, evidenceDocumentReference: "SYN-AUTH",
      evidenceSha256: "b".repeat(64), changeReason: "Synthetic invalid account", idempotencyKey: `cfg-${randomUUID()}`, correlationId: randomUUID() })]);
}

async function record(fixture: Fixture, session: SessionArgs, payload: Record<string, unknown>): Promise<Funding> {
  return (await call<{ funding: Funding }>(fixture.executor, "SELECT abos.record_temporary_funding($1,$2,$3,$4::jsonb) AS value",
    [...args(session), JSON.stringify(payload)])).funding;
}

async function decide(fixture: Fixture, session: SessionArgs, id: string, version: number, decision: string): Promise<Funding> {
  return (await call<{ funding: Funding }>(fixture.executor, "SELECT abos.decide_temporary_funding($1,$2,$3,$4,$5::jsonb) AS value",
    [...args(session), id, JSON.stringify({ expectedVersion: version, decision, decisionReason: "Synthetic independent decision",
      idempotencyKey: `tfd-${randomUUID()}`, correlationId: randomUUID() })])).funding;
}

async function postFunding(fixture: Fixture, payload: Record<string, unknown>): Promise<Funding> {
  const created = await record(fixture, fixture.sessions.creator, payload);
  return decide(fixture, fixture.sessions.approver, created.id, created.version, "APPROVED");
}

async function requestSettlement(fixture: Fixture, payload: Record<string, unknown>, session?: SessionArgs):
Promise<{ settlement: Settlement; funding: Funding }> {
  return call(fixture.executor, "SELECT abos.request_temporary_funding_settlement($1,$2,$3,$4::jsonb) AS value",
    [...args(session ?? fixture.sessions.settler), JSON.stringify(payload)]);
}

async function decideSettlement(fixture: Fixture, session: SessionArgs, id: string, version: number, decision: string):
Promise<{ settlement: Settlement; funding: Funding }> {
  return call(fixture.executor, "SELECT abos.decide_temporary_funding_settlement($1,$2,$3,$4,$5::jsonb) AS value",
    [...args(session), id, JSON.stringify({ expectedVersion: version, decision, decisionReason: "Synthetic settlement decision",
      idempotencyKey: `tsd-${randomUUID()}`, correlationId: randomUUID() })]);
}

interface Workspace {
  readonly payableTotal: string;
  readonly capability: { state: string; reversalAvailable: boolean; safeNonNegativeGuardActive: boolean };
  readonly fundings: readonly Funding[];
  readonly providers: readonly { name: string; fundedAmount: string; settledAmount: string; outstandingAmount: string; status: string }[];
}

async function workspaceOf(fixture: Fixture, session: SessionArgs): Promise<Workspace> {
  return call(fixture.executor, "SELECT abos.temporary_funding_workspace($1,$2,$3) AS value", args(session));
}

// ---------------------------------------------------------------------------------------------------
// Ledger reads (superuser, test-only)
// ---------------------------------------------------------------------------------------------------

async function fundingRow(harness: Harness, id: string): Promise<{ id: string; version: number }> {
  const result = await harness.pool.query<{ id: string; version: number }>("SELECT id, version FROM abos.temporary_fundings WHERE id = $1", [id]);
  assert.ok(result.rows[0]); return result.rows[0];
}

async function journalLines(harness: Harness, journalId: string) {
  return (await harness.pool.query(`SELECT line_number AS line, ledger_account_id AS ledger, business_party_id AS party,
      base_debit::text AS debit, base_credit::text AS credit, source_type AS source
    FROM abos.journal_lines WHERE journal_id = $1 ORDER BY line_number`, [journalId])).rows;
}

async function subledgers(harness: Harness, journalId: string) {
  return (await harness.pool.query(`SELECT line.line_number AS line, entry.subledger_type AS type, entry.business_party_id AS party,
      entry.temporary_funding_id AS funding, entry.temporary_funding_settlement_id AS settlement,
      entry.operational_treasury_account_id AS treasury, entry.base_amount::text AS amount, entry.base_currency_code AS currency
    FROM abos.subledger_entries entry JOIN abos.journal_lines line ON line.id = entry.journal_line_id
   WHERE line.journal_id = $1 ORDER BY line.line_number, entry.subledger_type`, [journalId])).rows;
}

async function safeMovement(harness: Harness, treasuryId: string): Promise<string> {
  const result = await harness.pool.query<{ total: string }>(`SELECT COALESCE(sum(entry.original_amount), 0)::text AS total
    FROM abos.subledger_entries entry JOIN abos.journal_lines line ON line.id = entry.journal_line_id
    JOIN abos.journals journal ON journal.id = line.journal_id
   WHERE entry.operational_treasury_account_id = $1 AND journal.status = 'POSTED'`, [treasuryId]);
  return result.rows[0]!.total;
}

async function providerBalance(harness: Harness, partyId: string): Promise<string> {
  const result = await harness.pool.query<{ total: string }>(`SELECT COALESCE(sum(entry.base_amount), 0)::text AS total
    FROM abos.subledger_entries entry JOIN abos.journal_lines line ON line.id = entry.journal_line_id
    JOIN abos.journals journal ON journal.id = line.journal_id
   WHERE entry.subledger_type = 'TEMPORARY_FUNDING_PAYABLE' AND entry.business_party_id = $1 AND journal.status = 'POSTED'`, [partyId]);
  return result.rows[0]!.total;
}

async function auditActions(harness: Harness, entityId: string): Promise<string[]> {
  return (await harness.pool.query<{ action: string }>(
    "SELECT action FROM abos.audit_records WHERE entity_id = $1 ORDER BY occurred_at, action", [entityId])).rows.map((row) => row.action);
}

async function auditCount(harness: Harness, action: string): Promise<number> {
  return scalar(harness, `SELECT count(*) FROM abos.audit_records WHERE action = '${action}'`);
}

// ---------------------------------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------------------------------

async function call<T>(executor: PostgresExecutor, sql: string, parameters: readonly unknown[]): Promise<T> {
  const result = await executor.query<{ value: T }>(sql, parameters);
  assert.ok(result.rows[0]); return result.rows[0].value;
}

function args(session: SessionArgs): [string, string, string] {
  return [session.proof, session.runtimeDigest, session.tokenDigest];
}

async function grant(harness: Harness, world: SyntheticWorld, userId: string, permission: string): Promise<void> {
  await harness.executor.query(`INSERT INTO abos.user_permission_grants (user_account_id, legal_entity_id, permission_code, granted_by_user_account_id)
    VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [userId, world.legalEntityId, permission, world.bootstrapUserId]);
}

async function ensureLogin(harness: Harness): Promise<void> {
  await harness.executor.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${LOGIN.name}') THEN
    CREATE ROLE ${LOGIN.name} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION; END IF; END $$`);
  await harness.executor.query(`ALTER ROLE ${LOGIN.name} LOGIN PASSWORD '${LOGIN.password}'`);
  await harness.executor.query(`GRANT abos_e1_runtime TO ${LOGIN.name}`);
}

function restricted(): { executor: PostgresExecutor; close(): Promise<void> } {
  const url = new URL(databaseUrl() ?? ""); url.username = LOGIN.name; url.password = LOGIN.password;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 6 });
  return { executor: new PostgresExecutor(pool, { runtimeMarker: MARKER }), close: () => pool.end() };
}

async function sessionFor(harness: Harness, world: SyntheticWorld, userId: string): Promise<SessionArgs> {
  return sessionArgs((await issueOperationalSession(harness, userId, world.legalEntityId)).token);
}

function sessionArgs(token: string): SessionArgs {
  return { proof: identityDatabaseProof(SYNTHETIC_AUTH_CONFIGURATION.signingSecret),
    runtimeDigest: createHash("sha256").update(token).digest("hex"),
    tokenDigest: createHmac("sha256", SYNTHETIC_AUTH_CONFIGURATION.signingSecret).update(token).digest("hex") };
}

async function scalar(harness: Harness, sql: string): Promise<number> {
  const result = await harness.pool.query<{ count: string }>(sql);
  return Number(result.rows[0]?.count ?? "0");
}

async function roleRejects(harness: Harness, role: string, sql: string, message: RegExp): Promise<void> {
  const client = await harness.pool.connect();
  try { await client.query("BEGIN"); await client.query(`SET LOCAL ROLE ${role}`); await assert.rejects(() => client.query(sql), message); }
  finally { await client.query("ROLLBACK"); client.release(); }
}
