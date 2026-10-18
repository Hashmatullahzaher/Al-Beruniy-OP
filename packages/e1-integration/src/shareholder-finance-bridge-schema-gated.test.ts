import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import test, { after, before, describe } from "node:test";
import pg from "pg";

import type { SqlExecutor } from "@abos/database";
import { PostgresExecutor } from "@abos/persistence";
import { identityDatabaseProof } from "@abos/sandbox-auth";

import { grant } from "./currency-fixtures.ts";
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
import {
  seedSyntheticWorld,
  SYNTHETIC_AUTH_CONFIGURATION,
  type SyntheticWorld
} from "./synthetic-world.ts";

/** Real PostgreSQL acceptance for migration 0036. All records are disposable and synthetic. */
const MARKER = SYNTHETIC_AUTH_CONFIGURATION.runtimeMarker;
const FINANCE_LOGIN = { name: "abos_v1_capital_finance_test_login", password: "synthetic-capital-finance-runtime-only-2026" };
const TREASURY_LOGIN = { name: "abos_v1_capital_treasury_test_login", password: "synthetic-capital-treasury-runtime-only-2026" };

interface SessionArgs { readonly proof: string; readonly runtimeDigest: string; readonly tokenDigest: string }
interface BridgeFixture {
  world: SyntheticWorld; contributionId: string; treasuryId: string;
  expenseCategoryId: string;
  mappingEvidenceId: string; receiptEvidenceId: string; custodyEvidenceId: string; approvalEvidenceId: string;
  recorder: SessionArgs; verifier: SessionArgs; preparer: SessionArgs; approver: SessionArgs;
  finance: PostgresExecutor; treasury: PostgresExecutor;
}
interface WorkflowState {
  receiptId: string; intentId: string; journalId: string; recordKey: string; recordPayload: Record<string, unknown>;
}

if (databaseUrl() === undefined) {
  test("V1 Shareholders to Finance bridge", () => assert.fail(MISSING_DATABASE_MESSAGE));
} else {
  describe("V1 Shareholders to Finance bridge (migration 0036)", () => {
    let harness: Harness;
    let financeConnection: { executor: PostgresExecutor; close(): Promise<void> };
    let treasuryConnection: { executor: PostgresExecutor; close(): Promise<void> };
    let fixture: BridgeFixture;
    let workflow: WorkflowState | undefined;

    before(async () => {
      harness = await openHarness(MARKER);
      await ensureLogin(harness, FINANCE_LOGIN, "abos_e1_runtime");
      await ensureLogin(harness, TREASURY_LOGIN, "abos_e1_treasury_runtime");
      financeConnection = restricted(FINANCE_LOGIN);
      treasuryConnection = restricted(TREASURY_LOGIN);
    });
    after(async () => {
      await financeConnection?.close(); await treasuryConnection?.close(); await harness?.close();
    });

    test("upgrade from 0035 preserves business rows and creates zero receipt backfill", async () => {
      await withClusterLock(harness.pool, async () => {
        const client = await harness.pool.connect();
        try {
          await client.query("BEGIN");
          await client.query("DROP SCHEMA IF EXISTS abos CASCADE");
          const migrations = await loadMigrations();
          const index = migrations.findIndex((migration) => migration.id === "0036_v1_shareholder_finance_bridge");
          assert.ok(index > 0, "0036 follows its predecessors");
          const migration = migrations[index]; assert.ok(migration);
          for (const predecessor of migrations.slice(0, index)) await client.query(predecessor.sql);
          await client.query("SELECT set_config('abos.runtime_marker',$1,true)", [MARKER]);
          const tx: SqlExecutor = {
            query: async <Row extends object>(sql: string, parameters: readonly unknown[] = []) => {
              const result = await client.query(sql, [...parameters]);
              return { rows: result.rows as Row[], rowCount: result.rowCount ?? 0 };
            },
            transaction: async (work) => work(tx)
          };
          const world = await seedSyntheticWorld(tx);
          const preservedContributionId = randomUUID();
          await client.query(`INSERT INTO abos.shareholder_contributions
            (id,legal_entity_id,shareholder_profile_id,contribution_type,business_date,description,record_status,
             receipt_status,valuation_status,amount,currency_code,version,created_by_user_account_id,
             declared_by_user_account_id,declared_at)
            VALUES ($1,$2,$3,'CASH','2026-09-22','Synthetic pre-0036 declaration','DECLARED',
              'NOT_RECEIVED','NOT_APPLICABLE',123,'USD',1,$4,$4,clock_timestamp())`,
            [preservedContributionId, world.legalEntityId, world.shareholderProfileId, world.bootstrapUserId]);
          const beforeRow = await client.query<{ row: string }>(
            "SELECT to_jsonb(c)::text AS row FROM abos.shareholder_contributions c WHERE id=$1",
            [preservedContributionId]
          );
          const before = await client.query<{ tables: string; contribution_columns: string }>(`
            SELECT (SELECT count(*)::text FROM pg_catalog.pg_tables WHERE schemaname='abos') AS tables,
                   (SELECT count(*)::text FROM information_schema.columns
                     WHERE table_schema='abos' AND table_name='shareholder_contributions') AS contribution_columns`);
          await client.query(migration.sql);
          const after = await client.query<{ tables: string; contribution_columns: string; receipts: string; custody: string; mappings: string }>(`
            SELECT (SELECT count(*)::text FROM pg_catalog.pg_tables WHERE schemaname='abos') AS tables,
                   (SELECT count(*)::text FROM information_schema.columns
                     WHERE table_schema='abos' AND table_name='shareholder_contributions') AS contribution_columns,
                   (SELECT count(*)::text FROM abos.shareholder_capital_receipts) AS receipts,
                   (SELECT count(*)::text FROM abos.shareholder_capital_receipt_custody_verifications) AS custody,
                   (SELECT count(*)::text FROM abos.shareholder_capital_account_mapping_versions) AS mappings`);
          assert.equal(after.rows[0]?.contribution_columns, before.rows[0]?.contribution_columns);
          const afterRow = await client.query<{ row: string }>(
            "SELECT to_jsonb(c)::text AS row FROM abos.shareholder_contributions c WHERE id=$1",
            [preservedContributionId]
          );
          assert.deepEqual(afterRow.rows, beforeRow.rows, "0036 preserves the populated declaration exactly");
          assert.deepEqual({ receipts: after.rows[0]?.receipts, custody: after.rows[0]?.custody, mappings: after.rows[0]?.mappings },
            { receipts: "0", custody: "0", mappings: "0" });
          assert.equal(Number(after.rows[0]?.tables) - Number(before.rows[0]?.tables), 3);
        } finally { await client.query("ROLLBACK"); client.release(); }
      });
    });

    test("legacy E1 capital custody and posting remain unchanged", async () => {
      await resetSchema(harness.pool);
      const definitions = await harness.pool.query<{ name: string; definition: string }>(`
        SELECT proname AS name, pg_get_functiondef(oid) AS definition FROM pg_proc
         WHERE pronamespace='abos'::regnamespace
           AND proname IN ('complete_posted_capital_source','post_synthetic_capital_receipt') ORDER BY proname`);
      assert.deepEqual(definitions.rows.map((row) => row.name), ["complete_posted_capital_source", "post_synthetic_capital_receipt"]);
      assert.match(definitions.rows[0]?.definition ?? "", /LEGACY_E1/);
      assert.match(definitions.rows[1]?.definition ?? "", /sandbox/i);
    });

    test("Operational V1 expense posting remains unchanged", async () => {
      const validators = await harness.pool.query<{ operational: boolean; expense: boolean }>(`
        SELECT to_regprocedure('abos.validate_operational_journal_posting()') IS NOT NULL AS operational,
               to_regprocedure('abos.operational_expense_post(uuid,uuid)') IS NOT NULL AS expense`);
      assert.deepEqual(validators.rows[0], { operational: true, expense: true });
      const definition = await harness.pool.query<{ definition: string }>(
        "SELECT pg_get_functiondef('abos.validate_operational_journal_posting()'::regprocedure) AS definition");
      assert.match(definition.rows[0]?.definition ?? "", /OPERATIONAL_EXPENSE/);
      assert.match(definition.rows[0]?.definition ?? "", /SHAREHOLDER_CAPITAL_CONTRIBUTION_RECEIPT/);
    });

    test("same-currency shareholder receipt follows receipt to custody to approval to posting", async () => {
      fixture = await setupFixture(harness, financeConnection.executor, treasuryConnection.executor);
      const recordKey = `record-${randomUUID()}`;
      const recordPayload = {
        contributionId: fixture.contributionId, expectedContributionVersion: 1,
        amount: { amount: "25000", currency: "USD" }, receiptDate: "2026-09-22",
        treasuryDestinationId: fixture.treasuryId, paymentReference: "SYN-CAPITAL-RECEIPT",
        evidenceReferenceId: fixture.receiptEvidenceId, idempotencyKey: recordKey, correlationId: randomUUID()
      };
      const recorded = await callJson<{ receipt: { receiptId: string }; replayed: boolean }>(
        fixture.treasury, "record_shareholder_capital_receipt", fixture.recorder, [recordPayload]);
      const receiptId = recorded.receipt.receiptId; assert.equal(recorded.replayed, false);
      await callJson(fixture.treasury, "verify_shareholder_capital_receipt_custody", fixture.verifier, [receiptId, {
        expectedReceiptVersion: 1, decision: "VERIFIED", verificationKind: "PHYSICAL_CASH_COUNT",
        evidenceReferenceId: fixture.custodyEvidenceId, decisionReason: null,
        idempotencyKey: `verify-${randomUUID()}`, correlationId: randomUUID()
      }]);
      await callJson(fixture.finance, "configure_shareholder_capital_mapping", fixture.preparer, [{
        ledgerAccountId: fixture.world.capitalLedgerAccountId, evidenceReferenceId: fixture.mappingEvidenceId,
        changeReason: "Synthetic test mapping for paid-in capital",
        idempotencyKey: `mapping-${randomUUID()}`, correlationId: randomUUID()
      }]);
      const prepared = await callJson<{ postingIntentId: string; version: number }>(
        fixture.finance, "prepare_shareholder_capital_posting", fixture.preparer, [receiptId, {
          expectedReceiptVersion: 1, accountingEffectiveDate: "2026-09-22",
          idempotencyKey: `prepare-${randomUUID()}`, correlationId: randomUUID()
        }]);
      await callJson(fixture.finance, "decide_shareholder_capital_posting", fixture.approver, [prepared.postingIntentId, {
        expectedIntentVersion: 1, decision: "APPROVED", evidenceReferenceId: fixture.approvalEvidenceId,
        decisionReason: "Synthetic independent Finance approval",
        idempotencyKey: `approve-${randomUUID()}`, correlationId: randomUUID()
      }]);
      const posted = await callJson<{ journalId: string; status: string }>(
        fixture.finance, "post_shareholder_capital_receipt", fixture.approver, [prepared.postingIntentId, {
          expectedIntentVersion: 2, idempotencyKey: `post-${randomUUID()}`, correlationId: randomUUID()
        }]);
      assert.equal(posted.status, "POSTED");
      workflow = { receiptId, intentId: prepared.postingIntentId, journalId: posted.journalId, recordKey, recordPayload };
      const trace = await callJson<{ contribution: { status: string; postedAmount: { amount: string } } }>(
        fixture.finance, "shareholder_capital_trace", fixture.preparer, [fixture.contributionId], false);
      assert.equal(trace.contribution.status, "POSTED"); assert.equal(trace.contribution.postedAmount.amount, "25000");
    });

    test("one receipt produces one intent and one journal", async () => {
      const state = requiredWorkflow(workflow);
      const result = await harness.pool.query<{ receipts: string; intents: string; journals: string }>(`
        SELECT (SELECT count(*)::text FROM abos.shareholder_capital_receipts WHERE id=$1) AS receipts,
               (SELECT count(*)::text FROM abos.posting_intents WHERE shareholder_capital_receipt_id=$1) AS intents,
               (SELECT count(*)::text FROM abos.journals WHERE posting_intent_id=$2) AS journals`, [state.receiptId, state.intentId]);
      assert.deepEqual(result.rows[0], { receipts: "1", intents: "1", journals: "1" });
    });

    test("posted capital journal has exactly two balanced lines", async () => {
      const state = requiredWorkflow(workflow);
      const result = await harness.pool.query<{ lines: string; debit: string; credit: string; models: string }>(`
        SELECT count(*)::text AS lines, sum(base_debit)::text AS debit, sum(base_credit)::text AS credit,
               count(DISTINCT processing_model)::text AS models FROM abos.journal_lines WHERE journal_id=$1`, [state.journalId]);
      assert.deepEqual(result.rows[0], { lines: "2", debit: "25000", credit: "25000", models: "1" });
    });

    test("posted capital journal has exactly two matching subledger entries", async () => {
      const state = requiredWorkflow(workflow);
      const result = await harness.pool.query<{ count: string; types: string[]; total: string }>(`
        SELECT count(*)::text AS count, array_agg(subledger_type ORDER BY subledger_type) AS types,
               sum(original_amount)::text AS total FROM abos.subledger_entries WHERE shareholder_capital_receipt_id=$1`, [state.receiptId]);
      assert.deepEqual(result.rows[0], { count: "2", types: ["OPERATIONAL_TREASURY", "SHAREHOLDER_CAPITAL"], total: "0" });
    });

    test("posted capital funds the same Treasury source and a normal expense spends from it", async () => {
      const state = requiredWorkflow(workflow);
      const declarationBefore = await harness.pool.query<{
        contribution_type: string; record_status: string; receipt_status: string;
        amount: string; currency_code: string; description: string; version: number;
      }>(`SELECT contribution_type,record_status,receipt_status,amount::text,currency_code,description,version
             FROM abos.shareholder_contributions WHERE id=$1`, [fixture.contributionId]);
      assert.equal(declarationBefore.rows[0]?.record_status, "DECLARED");

      const funded = await harness.pool.query<{ amount: string }>(`
        SELECT sum(original_amount)::text AS amount FROM abos.subledger_entries
         WHERE operational_treasury_account_id=$1`, [fixture.treasuryId]);
      assert.equal(funded.rows[0]?.amount, "25000", "capital receipt increases the selected Safe");

      const expense = await callJson<{ expense: { id: string; journalId: string; status: string } }>(
        fixture.finance, "operational_expense_create", fixture.preparer, [{
          treasuryAccountId: fixture.treasuryId,
          expenseCategoryId: fixture.expenseCategoryId,
          payeeBusinessPartyId: null,
          projectId: null,
          departmentId: null,
          costCenterId: null,
          reference: `SYN-SPEND-CAPITAL-${randomUUID().slice(0, 8)}`,
          description: "Synthetic same-Safe expense after capital receipt",
          note: "Disposable PostgreSQL acceptance only",
          businessDate: "2026-09-22",
          originalAmount: "125.50",
          currencyCode: "USD",
          exchangeRateId: null,
          idempotencyKey: `spend-${randomUUID()}`,
          correlationId: randomUUID()
        }]);
      assert.equal(expense.expense.status, "POSTED");

      const treasury = await harness.pool.query<{ balance: string; entries: string }>(`
        SELECT sum(original_amount)::text AS balance,count(*)::text AS entries
          FROM abos.subledger_entries WHERE operational_treasury_account_id=$1`, [fixture.treasuryId]);
      assert.deepEqual(treasury.rows[0], { balance: "24874.50", entries: "2" });

      const expenseJournal = await harness.pool.query<{
        lines: string; debit: string; credit: string; capital_entries: string; treasury_entries: string;
      }>(`SELECT
          (SELECT count(*)::text FROM abos.journal_lines WHERE journal_id=$1) AS lines,
          (SELECT sum(base_debit)::text FROM abos.journal_lines WHERE journal_id=$1) AS debit,
          (SELECT sum(base_credit)::text FROM abos.journal_lines WHERE journal_id=$1) AS credit,
          (SELECT count(*)::text FROM abos.subledger_entries entry
             JOIN abos.journal_lines line ON line.id=entry.journal_line_id
            WHERE line.journal_id=$1 AND entry.subledger_type='SHAREHOLDER_CAPITAL') AS capital_entries,
          (SELECT count(*)::text FROM abos.subledger_entries entry
             JOIN abos.journal_lines line ON line.id=entry.journal_line_id
            WHERE line.journal_id=$1 AND entry.subledger_type='OPERATIONAL_TREASURY') AS treasury_entries`,
        [expense.expense.journalId]);
      assert.deepEqual(expenseJournal.rows[0], {
        lines: "2", debit: "125.50", credit: "125.50", capital_entries: "0", treasury_entries: "1"
      });

      const sharedLedger = await harness.pool.query<{ capital_cash: string; expense_cash: string }>(`
        SELECT
          (SELECT ledger_account_id::text FROM abos.journal_lines
            WHERE journal_id=$1 AND base_debit>0) AS capital_cash,
          (SELECT ledger_account_id::text FROM abos.journal_lines
            WHERE journal_id=$2 AND base_credit>0) AS expense_cash`, [state.journalId, expense.expense.journalId]);
      assert.equal(sharedLedger.rows[0]?.capital_cash, sharedLedger.rows[0]?.expense_cash,
        "capital debit and expense credit use the exact same Safe ledger");

      const declarationAfter = await harness.pool.query<{
        contribution_type: string; record_status: string; receipt_status: string;
        amount: string; currency_code: string; description: string; version: number;
      }>(`SELECT contribution_type,record_status,receipt_status,amount::text,currency_code,description,version
             FROM abos.shareholder_contributions WHERE id=$1`, [fixture.contributionId]);
      assert.deepEqual(declarationAfter.rows, declarationBefore.rows,
        "spending cash does not rewrite or contaminate the shareholder declaration");
      const trace = await callJson<{ contribution: { postedAmount: { amount: string } } }>(
        fixture.finance, "shareholder_capital_trace", fixture.preparer, [fixture.contributionId], false);
      assert.equal(trace.contribution.postedAmount.amount, "25000");
    });

    test("entity-qualified source destination evidence approval and journal links reject cross-entity data", async () => {
      const state = requiredWorkflow(workflow);
      const second = await seedSyntheticWorld(harness.executor, { withoutSandboxAuthorization: true });
      await grant(harness.executor, second, second.treasuryManagerId, ["shareholder.capital-receipt.read"]);
      const secondSession = await sessionFor(harness, second, second.treasuryManagerId);
      await assert.rejects(() => callJson(fixture.finance, "shareholder_capital_trace", secondSession, [fixture.contributionId], false),
        /not available in this legal entity/i);
      await assert.rejects(() => harness.pool.query(
        "UPDATE abos.posting_intents SET shareholder_capital_receipt_id=$1 WHERE id=$2", [randomUUID(), state.intentId]),
        /immutable|violates foreign key|restricted operational Finance boundary/i);
    });

    test("restricted Treasury and Finance runtimes have no direct protected-table mutation", async () => {
      const result = await harness.pool.query<{ role_name: string; table_name: string; may_mutate: boolean }>(`
        SELECT role_name, table_name,
               has_table_privilege(role_name, 'abos.' || table_name, 'INSERT,UPDATE,DELETE') AS may_mutate
          FROM unnest(ARRAY['abos_e1_runtime','abos_e1_treasury_runtime']) role_name
          CROSS JOIN unnest(ARRAY['shareholder_capital_receipts','shareholder_capital_receipt_custody_verifications',
            'shareholder_capital_account_mapping_versions','posting_intents','posting_approvals','journals','journal_lines','subledger_entries']) table_name`);
      assert.ok(result.rows.every((row) => row.may_mutate === false), JSON.stringify(result.rows));
      await assert.rejects(() => fixture.finance.query("INSERT INTO abos.journals (id) VALUES (gen_random_uuid())"), /permission denied/i);
      await assert.rejects(() => fixture.treasury.query("SET ROLE abos_v1_shareholder_capital_owner"), /permission denied/i);
    });

    test("same-key retries replay and conflicting keys or payloads cannot duplicate receipt or posting", async () => {
      const state = requiredWorkflow(workflow);
      const replay = await callJson<{ receipt: { receiptId: string } }>(fixture.treasury,
        "record_shareholder_capital_receipt", fixture.recorder, [{ ...state.recordPayload, correlationId: randomUUID() }]);
      assert.equal(replay.receipt.receiptId, state.receiptId);
      await assert.rejects(() => callJson(fixture.treasury, "record_shareholder_capital_receipt", fixture.recorder, [{
        ...state.recordPayload, amount: { amount: "1", currency: "USD" }, correlationId: randomUUID()
      }]), /idempotency key was already used/i);
      const count = await harness.pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM abos.shareholder_capital_receipts WHERE contribution_id=$1", [fixture.contributionId]);
      assert.equal(count.rows[0]?.count, "1");
    });

    test("stale versions over-receipts and concurrent posts fail closed", async () => {
      const state = requiredWorkflow(workflow);
      await assert.rejects(() => callJson(fixture.treasury, "record_shareholder_capital_receipt", fixture.recorder, [{
        ...state.recordPayload, expectedContributionVersion: 999,
        idempotencyKey: `stale-${randomUUID()}`, correlationId: randomUUID()
      }]), /changed; reload/i);
      await assert.rejects(() => callJson(fixture.treasury, "record_shareholder_capital_receipt", fixture.recorder, [{
        ...state.recordPayload, amount: { amount: "25000.01", currency: "USD" },
        idempotencyKey: `over-${randomUUID()}`, correlationId: randomUUID()
      }]), /exceed the declared contribution amount/i);
      const results = await Promise.allSettled([
        callJson(fixture.finance, "post_shareholder_capital_receipt", fixture.approver, [state.intentId, {
          expectedIntentVersion: 2, idempotencyKey: `again-a-${randomUUID()}`, correlationId: randomUUID()
        }]),
        callJson(fixture.finance, "post_shareholder_capital_receipt", fixture.approver, [state.intentId, {
          expectedIntentVersion: 2, idempotencyKey: `again-b-${randomUUID()}`, correlationId: randomUUID()
        }])
      ]);
      assert.equal(results.filter((result) => result.status === "rejected").length, 2);
      assert.ok(results.every((result) => result.status === "rejected" && /changed|approved capital posting/i.test(String(result.reason))));
      const journals = await harness.pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM abos.journals WHERE posting_intent_id=$1", [state.intentId]);
      assert.equal(journals.rows[0]?.count, "1");
    });

    test("cross-currency refunds reversals in-kind and credit posting remain unavailable", async () => {
      const sourceTypes = await harness.pool.query<{ source_type: string }>(`
        SELECT DISTINCT source_type FROM abos.posting_intents
         WHERE processing_model='OPERATIONAL_V1' AND intent_kind='SHAREHOLDER_CAPITAL_RECEIPT'`);
      assert.deepEqual(sourceTypes.rows, [{ source_type: "SHAREHOLDER_CAPITAL_CONTRIBUTION_RECEIPT" }]);
      await assert.rejects(() => callJson(fixture.treasury, "record_shareholder_capital_receipt", fixture.recorder, [{
        contributionId: fixture.contributionId, expectedContributionVersion: 1,
        amount: { amount: "1", currency: "AFN" }, receiptDate: "2026-09-22",
        treasuryDestinationId: fixture.treasuryId, paymentReference: "SYN-CROSS-CURRENCY",
        evidenceReferenceId: fixture.receiptEvidenceId, idempotencyKey: `fx-${randomUUID()}`, correlationId: randomUUID()
      }]), /same-currency Treasury destination/i);
      const entryPoints = await harness.pool.query<{ count: string }>(`
        SELECT count(*)::text AS count FROM pg_proc WHERE pronamespace='abos'::regnamespace
          AND proname ~ 'shareholder_capital_(refund|reversal|in_kind|credit)'`);
      assert.equal(entryPoints.rows[0]?.count, "0");
    });
  });
}

async function setupFixture(harness: Harness, finance: PostgresExecutor, treasury: PostgresExecutor): Promise<BridgeFixture> {
  const world = await seedSyntheticWorld(harness.executor);
  const contributionId = randomUUID(); const treasuryId = randomUUID(); const policyId = randomUUID();
  const expenseLedgerId = randomUUID(); const expenseCategoryId = randomUUID(); const expensePolicyId = randomUUID();
  const mappingEvidenceId = await evidence(harness.executor, world, "CAPITAL_ACCOUNT_MAPPING");
  const receiptEvidenceId = await evidence(harness.executor, world, "CASH_RECEIPT");
  const custodyEvidenceId = await evidence(harness.executor, world, "PHYSICAL_CASH_COUNT");
  const approvalEvidenceId = await evidence(harness.executor, world, "FINANCE_APPROVAL");
  await harness.executor.query(`INSERT INTO abos.shareholder_contributions
    (id,legal_entity_id,shareholder_profile_id,contribution_type,business_date,description,record_status,receipt_status,
     valuation_status,amount,currency_code,version,created_by_user_account_id,declared_by_user_account_id,declared_at)
    VALUES ($1,$2,$3,'CASH','2026-09-22','Synthetic declared cash contribution','DECLARED','NOT_RECEIVED',
      'NOT_APPLICABLE',25000,'USD',1,$4,$4,clock_timestamp())`,
    [contributionId, world.legalEntityId, world.shareholderProfileId, world.bootstrapUserId]);
  await harness.executor.query(`INSERT INTO abos.operational_treasury_accounts
    (id,legal_entity_id,name_en,account_type,currency_code,ledger_account_id,status,version,
     created_by_user_account_id,last_changed_by_user_account_id)
    VALUES ($1,$2,'Synthetic Capital Safe','SAFE','USD',$3,'ACTIVE',1,$4,$4)`,
    [treasuryId, world.legalEntityId, world.cashLedgerAccountId, world.bootstrapUserId]);
  await harness.executor.query(`INSERT INTO abos.finance_workflow_policy_versions
    (id,legal_entity_id,workflow_type,version,approval_required,configured_by_user_account_id,change_reason)
    VALUES ($1,$2,'SHAREHOLDER_CAPITAL_RECEIPT',1,true,$3,'Synthetic bridge requires independent approval')`,
    [policyId, world.legalEntityId, world.bootstrapUserId]);
  await harness.executor.query(`INSERT INTO abos.ledger_accounts
    (id,legal_entity_id,account_code,account_name,account_type,posting_allowed,account_currency_code,status)
    VALUES ($1,$2,$3,'Synthetic Capital-Funded Expense','EXPENSE',true,'USD','ACTIVE')`,
    [expenseLedgerId, world.legalEntityId, `SYN-CAP-EXP-${expenseLedgerId.slice(0, 8)}`]);
  await harness.executor.query(`INSERT INTO abos.operational_expense_categories
    (id,legal_entity_id,category_code,name_en,ledger_account_id,status,version,
     created_by_user_account_id,last_changed_by_user_account_id)
    VALUES ($1,$2,$3,'Synthetic capital-funded operations',$4,'ACTIVE',1,$5,$5)`,
    [expenseCategoryId, world.legalEntityId, `SYN-CAP-${expenseCategoryId.slice(0, 8)}`,
      expenseLedgerId, world.bootstrapUserId]);
  await harness.executor.query(`INSERT INTO abos.finance_workflow_policy_versions
    (id,legal_entity_id,workflow_type,version,approval_required,configured_by_user_account_id,change_reason)
    VALUES ($1,$2,'EXPENSE',1,false,$3,'Synthetic direct-post expense after capital funding')`,
    [expensePolicyId, world.legalEntityId, world.bootstrapUserId]);
  await grant(harness.executor, world, world.treasuryManagerId, ["shareholder.capital-receipt.record", "shareholder.capital-receipt.read"]);
  await grant(harness.executor, world, world.treasuryApproverId, ["treasury.capital-receipt.verify", "shareholder.capital-receipt.read"]);
  await grant(harness.executor, world, world.intentCreatorId,
    ["finance.capital-receipt.configure", "finance.capital-receipt.prepare", "shareholder.capital-receipt.read",
      "finance.expense.create", "finance.expense.read"]);
  await grant(harness.executor, world, world.approverId,
    ["finance.capital-receipt.approve", "finance.capital-receipt.post", "shareholder.capital-receipt.read"]);
  return { world, contributionId, treasuryId, expenseCategoryId,
    mappingEvidenceId, receiptEvidenceId, custodyEvidenceId, approvalEvidenceId,
    recorder: await sessionFor(harness, world, world.treasuryManagerId), verifier: await sessionFor(harness, world, world.treasuryApproverId),
    preparer: await sessionFor(harness, world, world.intentCreatorId), approver: await sessionFor(harness, world, world.approverId), finance, treasury };
}

async function evidence(database: SqlExecutor, world: SyntheticWorld, kind: string): Promise<string> {
  const id = randomUUID();
  await database.query(`INSERT INTO abos.evidence_references
    (id,legal_entity_id,document_id,evidence_kind,evidence_version,sha256,completed_at)
    VALUES ($1,$2,gen_random_uuid(),$3,1,$4,clock_timestamp())`,
    [id, world.legalEntityId, kind, createHash("sha256").update(id).digest("hex")]);
  return id;
}

async function ensureLogin(harness: Harness, login: { name: string; password: string }, runtimeRole: string): Promise<void> {
  await harness.executor.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${login.name}') THEN
    CREATE ROLE ${login.name} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION; END IF; END $$`);
  await harness.executor.query(`ALTER ROLE ${login.name} LOGIN PASSWORD '${login.password}'`);
  await harness.executor.query(`GRANT ${runtimeRole} TO ${login.name}`);
}

function restricted(login: { name: string; password: string }): { executor: PostgresExecutor; close(): Promise<void> } {
  const url = new URL(databaseUrl() ?? ""); url.username = login.name; url.password = login.password;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
  return { executor: new PostgresExecutor(pool, { runtimeMarker: MARKER }), close: () => pool.end() };
}

async function sessionFor(harness: Harness, world: SyntheticWorld, userId: string): Promise<SessionArgs> {
  const session = await issueOperationalSession(harness, userId, world.legalEntityId);
  return { proof: identityDatabaseProof(SYNTHETIC_AUTH_CONFIGURATION.signingSecret),
    runtimeDigest: createHash("sha256").update(session.token).digest("hex"),
    tokenDigest: createHmac("sha256", SYNTHETIC_AUTH_CONFIGURATION.signingSecret).update(session.token).digest("hex") };
}

async function callJson<T = Record<string, unknown>>(
  executor: PostgresExecutor, functionName: string, session: SessionArgs,
  args: readonly unknown[], finalArgumentIsJson = true
): Promise<T> {
  const parameters: unknown[] = [session.proof, session.runtimeDigest, session.tokenDigest];
  const placeholders = ["$1", "$2", "$3"];
  for (const [index, arg] of args.entries()) {
    const asJson = finalArgumentIsJson && index === args.length - 1 && typeof arg === "object";
    parameters.push(asJson ? JSON.stringify(arg) : arg);
    placeholders.push(`$${parameters.length}${asJson ? "::jsonb" : ""}`);
  }
  const result = await executor.query<{ value: T }>(`SELECT abos.${functionName}(${placeholders.join(",")}) AS value`, parameters);
  assert.ok(result.rows[0]); return result.rows[0].value;
}

function requiredWorkflow(value: WorkflowState | undefined): WorkflowState {
  assert.ok(value, "the happy-path workflow completed first"); return value;
}
