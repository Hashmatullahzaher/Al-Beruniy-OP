import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test, { after, before, describe } from "node:test";
import pg from "pg";

import { PostgresExecutor } from "@abos/persistence";
import { identityDatabaseProof } from "@abos/sandbox-auth";

import {
  databaseUrl,
  MISSING_DATABASE_MESSAGE,
  openHarness,
  resetSchema,
  withClusterLock,
  type Harness
} from "./harness.ts";
import { issueOperationalSession } from "./operational-session.ts";
import { seedSyntheticWorld, SYNTHETIC_AUTH_CONFIGURATION, type SyntheticWorld } from "./synthetic-world.ts";

/**
 * P2 Temporary Funding: isolated PostgreSQL proof for the UNNUMBERED schema proposal
 * infrastructure/database/proposals/p2_temporary_funding.sql, applied after migrations 0001-0035.
 * Disposable databases only. Nothing here is a migration and nothing here registers one.
 */

const MARKER = SYNTHETIC_AUTH_CONFIGURATION.runtimeMarker;
const LOGIN = {
  name: "abos_p2_temporary_funding_test_login",
  password: "synthetic-temporary-funding-runtime-only-2026"
};
const PROPOSAL = new URL("../../../infrastructure/database/proposals/p2_temporary_funding.sql", import.meta.url);
const DATE = "2026-09-22";

interface SessionArgs {
  readonly proof: string;
  readonly runtimeDigest: string;
  readonly tokenDigest: string;
}

interface Funding {
  readonly id: string;
  readonly status: string;
  readonly lifecycleStatus: string;
  readonly version: number;
  readonly journalId: string | null;
  readonly amount: string;
  readonly settledAmount: string;
  readonly outstandingAmount: string;
  readonly pendingSettlementAmount: string;
  readonly settlements: readonly { id: string; status: string; version: number; amount: string }[];
  readonly reversal: null | { id: string; status: string; version: number; reversalJournalId: string | null };
}

interface Sessions {
  readonly creator: SessionArgs;
  readonly approver: SessionArgs;
  readonly secondApprover: SessionArgs;
  readonly settler: SessionArgs;
  readonly settleApprover: SessionArgs;
  readonly reverser: SessionArgs;
  readonly reverseApprover: SessionArgs;
  readonly configurer: SessionArgs;
  readonly outsider: SessionArgs;
}

interface Fixture {
  readonly world: SyntheticWorld;
  readonly safeId: string;
  readonly bankId: string;
  readonly categoryId: string;
  readonly expenseLedgerId: string;
  readonly payableLedgerId: string;
  readonly shareholderPartyId: string;
  readonly employeePartyId: string;
  readonly personPartyId: string;
  readonly organizationPartyId: string;
  readonly payeePartyId: string;
  readonly sessions: Sessions;
  readonly executor: PostgresExecutor;
  close(): Promise<void>;
}

if (databaseUrl() === undefined) {
  test("P2 temporary funding proposal", () => assert.fail(MISSING_DATABASE_MESSAGE));
} else {
  describe("P2 temporary funding (isolated schema proposal)", () => {
    let harness: Harness;

    before(async () => { harness = await openHarness(MARKER); });
    after(async () => { await harness.close(); });

    test("the proposal applies after 0035; catalogue, workflow type and policy guard are in place", async () => {
      const fixture = await setupFixture(harness);
      try {
        const codes = await harness.executor.query<{ permission_code: string; independence_enforced: boolean }>(
          `SELECT permission_code, independence_enforced FROM abos.permission_catalogue
            WHERE permission_code LIKE 'finance.temporary-funding.%' ORDER BY sort_order`);
        assert.deepEqual(codes.rows.map((row) => [row.permission_code, row.independence_enforced]), [
          ["finance.temporary-funding.read", false], ["finance.temporary-funding.create", false],
          ["finance.temporary-funding.approve", true], ["finance.temporary-funding.settle", false],
          ["finance.temporary-funding.settle-approve", true], ["finance.temporary-funding.reverse", true],
          ["finance.temporary-funding.configure", false]
        ]);
        const type = await harness.executor.query<{ label_en: string; label_fa: string }>(
          "SELECT label_en, label_fa FROM abos.finance_workflow_types WHERE workflow_type = 'TEMPORARY_FUNDING'");
        assert.deepEqual(type.rows[0], { label_en: "Temporary funding", label_fa: "تمویل موقت" });
        await assert.rejects(() => harness.executor.query(
          `INSERT INTO abos.finance_workflow_policy_versions
             (id, legal_entity_id, workflow_type, version, approval_required, configured_by_user_account_id, change_reason)
           VALUES ($1,$2,'TEMPORARY_FUNDING',2,false,$3,'Attempt direct posting route')`,
          [randomUUID(), fixture.world.legalEntityId, fixture.world.bootstrapUserId]),
        /temporary funding always requires approval/);
        // No reserved Shareholder-Finance name was taken.
        const reserved = await harness.executor.query<{ name: string }>(
          `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'abos'
              AND table_name IN ('shareholder_capital_receipts', 'shareholder_capital_receipt_custody_verifications',
                                 'shareholder_capital_account_mapping_versions')
           UNION ALL
           SELECT column_name FROM information_schema.columns WHERE table_schema = 'abos'
              AND column_name = 'shareholder_capital_receipt_id'`);
        assert.equal(reserved.rowCount, 0);
      } finally {
        await fixture.close();
      }
    });

    test("ordinary expenses still post unchanged while no opening cash control exists (stage 1)", async () => {
      const fixture = await setupFixture(harness);
      try {
        const created = await call<{ expense: { id: string; version: number } }>(fixture.executor,
          "SELECT abos.operational_expense_create($1,$2,$3,$4::jsonb) AS value",
          [...args(fixture.sessions.creator), JSON.stringify(expensePayload(fixture, "900.00"))]);
        const approved = await call<{ expense: { status: string; journalId: string } }>(fixture.executor,
          "SELECT abos.operational_expense_approve($1,$2,$3,$4,$5,$6) AS value",
          [...args(fixture.sessions.approver), created.expense.id, created.expense.version, "Synthetic approval note"]);
        assert.equal(approved.expense.status, "POSTED");
        assert.equal(await safeMovement(harness, fixture.safeId), "-900.00",
          "no approved opening exists, so stage 1 imposes no non-negative rule");
      } finally {
        await fixture.close();
      }
    });

    test("Mode A: provider pays an expense directly; Safe is unchanged and the provider payable rises", async () => {
      const fixture = await setupFixture(harness);
      try {
        const created = await createFunding(fixture, fixture.sessions.creator, modeA(fixture, "250.00"));
        assert.equal(created.status, "PENDING_APPROVAL");
        assert.equal(created.journalId, null);
        const posted = await decide(fixture, fixture.sessions.approver, created.id, created.version, "APPROVED");
        assert.equal(posted.status, "POSTED");
        assert.equal(posted.lifecycleStatus, "POSTED");
        assert.equal(posted.outstandingAmount, "250.00");
        const lines = await journalLines(harness, posted.journalId!);
        assert.deepEqual(lines, [
          { line: 1, ledger: fixture.expenseLedgerId, party: fixture.payeePartyId, debit: "250.00", credit: "0" },
          { line: 2, ledger: fixture.payableLedgerId, party: fixture.personPartyId, debit: "0", credit: "250.00" }
        ]);
        const entries = await subledgers(harness, posted.journalId!);
        assert.deepEqual(entries, [{
          line: 2, type: "TEMPORARY_FUNDING_PAYABLE", party: fixture.personPartyId, funding: created.id,
          treasury: null, amount: "250.00"
        }]);
        assert.equal(await safeMovement(harness, fixture.safeId), "0", "direct payment never touches the Safe");
        const workspace = await workspaceOf(fixture, fixture.sessions.creator);
        assert.equal(workspace.payableTotal, "250.00");
        assert.deepEqual(workspace.providers.map((provider) => [provider.name, provider.outstandingAmount, provider.status]),
          [["Synthetic Other Person", "250.00", "OUTSTANDING"]]);
        assert.ok(workspace.safePositions.every((position) => position.postedMovementTotal === "0"));
        const audit = await auditActions(harness, created.id);
        assert.deepEqual(audit, ["TEMPORARY_FUNDING_SUBMITTED", "TEMPORARY_FUNDING_POSTED", "TEMPORARY_FUNDING_APPROVED"]);
        assert.equal(await scalar(harness,
          `SELECT count(*) FROM abos.outbox_events WHERE event_type = 'finance.temporary-funding.posted'
             AND aggregate_id = '${created.id}'`), 1);
      } finally {
        await fixture.close();
      }
    });

    test("Mode B: provider funds the Safe; only this mode increases physical Safe cash", async () => {
      const fixture = await setupFixture(harness);
      try {
        const created = await createFunding(fixture, fixture.sessions.creator, modeB(fixture, "400.00"));
        const posted = await decide(fixture, fixture.sessions.approver, created.id, created.version, "APPROVED");
        const lines = await journalLines(harness, posted.journalId!);
        assert.deepEqual(lines, [
          { line: 1, ledger: fixture.world.cashLedgerAccountId, party: null, debit: "400.00", credit: "0" },
          { line: 2, ledger: fixture.payableLedgerId, party: fixture.organizationPartyId, debit: "0", credit: "400.00" }
        ]);
        const entries = await subledgers(harness, posted.journalId!);
        assert.deepEqual(entries, [
          { line: 1, type: "OPERATIONAL_TREASURY", party: null, funding: null, treasury: fixture.safeId, amount: "400.00" },
          { line: 2, type: "TEMPORARY_FUNDING_PAYABLE", party: fixture.organizationPartyId, funding: created.id,
            treasury: null, amount: "400.00" }
        ]);
        assert.equal(await safeMovement(harness, fixture.safeId), "400.00");
        const workspace = await workspaceOf(fixture, fixture.sessions.creator);
        const safe = workspace.safePositions.find((position) => position.treasuryAccountId === fixture.safeId);
        assert.equal(safe?.temporaryFundingInflow, "400.00");
        assert.equal(safe?.cashControl, null);
        assert.equal(safe?.nonNegativeEnforced, false);
      } finally {
        await fixture.close();
      }
    });

    test("partial then full settlement; over-settlement rejected; the expense is never reposted", async () => {
      const fixture = await setupFixture(harness);
      try {
        const funding = await postFunding(fixture, modeA(fixture, "100.00"));
        const expenseLinesBefore = await ledgerLineCount(harness, fixture.expenseLedgerId);
        const first = await createSettlement(fixture, funding.id, "40.00");
        assert.equal(first.funding.pendingSettlementAmount, "40.00");
        await assert.rejects(() => createSettlement(fixture, funding.id, "60.01"),
          /settlement exceeds the outstanding amount of 60/);
        const afterFirst = await decideSettlement(fixture, fixture.sessions.settleApprover,
          first.settlement.id, first.settlement.version, "APPROVED");
        assert.equal(afterFirst.lifecycleStatus, "PARTIALLY_SETTLED");
        assert.equal(afterFirst.outstandingAmount, "60.00");
        assert.equal(await providerBalance(harness, fixture.personPartyId), "60.00");

        const settlementJournal = (await harness.executor.query<{ journal_id: string }>(
          "SELECT journal_id FROM abos.temporary_funding_settlements WHERE id = $1", [first.settlement.id])).rows[0]!.journal_id;
        assert.deepEqual(await journalLines(harness, settlementJournal), [
          { line: 1, ledger: fixture.payableLedgerId, party: fixture.personPartyId, debit: "40.00", credit: "0" },
          { line: 2, ledger: fixture.world.cashLedgerAccountId, party: null, debit: "0", credit: "40.00" }
        ]);
        assert.deepEqual(await subledgers(harness, settlementJournal), [
          { line: 1, type: "TEMPORARY_FUNDING_PAYABLE", party: fixture.personPartyId, funding: funding.id,
            treasury: null, amount: "-40.00" },
          { line: 2, type: "OPERATIONAL_TREASURY", party: null, funding: null, treasury: fixture.safeId, amount: "-40.00" }
        ]);

        const second = await createSettlement(fixture, funding.id, "60.00");
        const settled = await decideSettlement(fixture, fixture.sessions.settleApprover,
          second.settlement.id, second.settlement.version, "APPROVED");
        assert.equal(settled.lifecycleStatus, "SETTLED");
        assert.equal(settled.outstandingAmount, "0.00");
        assert.equal(await providerBalance(harness, fixture.personPartyId), "0.00");
        await assert.rejects(() => createSettlement(fixture, funding.id, "0.01"), /exceeds the outstanding amount of 0/);
        assert.equal(await ledgerLineCount(harness, fixture.expenseLedgerId), expenseLinesBefore,
          "settlement never reposts the expense");
        assert.equal(await safeMovement(harness, fixture.safeId), "-100.00");
        const workspace = await workspaceOf(fixture, fixture.sessions.settler);
        assert.deepEqual(workspace.providers.map((provider) => [provider.fundedAmount, provider.settledAmount,
          provider.outstandingAmount, provider.status]), [["100.00", "100.00", "0.00", "SETTLED"]]);
      } finally {
        await fixture.close();
      }
    });

    test("idempotent retries replay; duplicate posts are impossible; conflicting key reuse is refused", async () => {
      const fixture = await setupFixture(harness);
      try {
        const payload = modeA(fixture, "75.00");
        const first = await callFundingCreate(fixture, fixture.sessions.creator, payload);
        const replay = await callFundingCreate(fixture, fixture.sessions.creator, payload);
        assert.equal(replay.replayed, true);
        assert.equal(replay.funding.id, first.funding.id);
        await assert.rejects(() => callFundingCreate(fixture, fixture.sessions.creator, { ...payload, originalAmount: "76.00" }),
          /idempotency key was already used for different details/);
        const posted = await decide(fixture, fixture.sessions.approver, first.funding.id, first.funding.version, "APPROVED");
        const again = await call<{ replayed: boolean; funding: Funding }>(fixture.executor,
          "SELECT abos.temporary_funding_decide($1,$2,$3,$4,$5,$6,$7) AS value",
          [...args(fixture.sessions.approver), first.funding.id, first.funding.version, "APPROVED", "Synthetic approval note"]);
        assert.equal(again.replayed, true);
        assert.equal(again.funding.journalId, posted.journalId);
        await assert.rejects(() => decide(fixture, fixture.sessions.secondApprover, first.funding.id, posted.version, "APPROVED"),
          /not waiting for approval/);
        assert.equal(await scalar(harness,
          `SELECT count(*) FROM abos.posting_intents WHERE temporary_funding_id = '${first.funding.id}'`), 1);
        // Even the owner role cannot create a second intent for the same funding.
        await roleStatementRejected(harness, "abos_v1_operational_finance_owner",
          `INSERT INTO abos.posting_intents
             (id, legal_entity_id, source_type, source_id, intent_kind, original_amount, original_currency_code,
              base_amount, base_currency_code, accounting_effective_date, correlation_id, idempotency_key, status,
              created_by_user_account_id, processing_model, temporary_funding_id, finance_workflow_policy_version_id,
              temporary_funding_mapping_version_id)
           SELECT gen_random_uuid(), legal_entity_id, 'TEMPORARY_FUNDING', id, 'TEMPORARY_FUNDING', original_amount,
                  original_currency_code, base_amount, base_currency_code, business_date, correlation_id,
                  'TFP:dup-' || id, 'APPROVED', created_by_user_account_id, 'OPERATIONAL_V1', id,
                  workflow_policy_version_id, mapping_version_id
             FROM abos.temporary_fundings WHERE id = '${first.funding.id}'`,
          /duplicate key value/);
        const settlementPayload = settlementBody(first.funding.id, fixture.safeId, "10.00");
        const s1 = await call<{ replayed: boolean; settlement: { id: string } }>(fixture.executor,
          "SELECT abos.temporary_funding_settlement_create($1,$2,$3,$4::jsonb) AS value",
          [...args(fixture.sessions.settler), JSON.stringify(settlementPayload)]);
        const s2 = await call<{ replayed: boolean; settlement: { id: string } }>(fixture.executor,
          "SELECT abos.temporary_funding_settlement_create($1,$2,$3,$4::jsonb) AS value",
          [...args(fixture.sessions.settler), JSON.stringify(settlementPayload)]);
        assert.equal(s2.replayed, true);
        assert.equal(s2.settlement.id, s1.settlement.id);
        assert.equal(await scalar(harness, "SELECT count(*) FROM abos.temporary_funding_settlements"), 1);
      } finally {
        await fixture.close();
      }
    });

    test("concurrent approvals post once and concurrent settlements cannot over-settle", async () => {
      const fixture = await setupFixture(harness);
      try {
        const created = await createFunding(fixture, fixture.sessions.creator, modeA(fixture, "100.00"));
        const results = await Promise.allSettled([
          decide(fixture, fixture.sessions.approver, created.id, created.version, "APPROVED"),
          decide(fixture, fixture.sessions.secondApprover, created.id, created.version, "APPROVED")
        ]);
        assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
        assert.equal(await scalar(harness,
          `SELECT count(*) FROM abos.journals journal JOIN abos.posting_intents intent ON intent.id = journal.posting_intent_id
            WHERE intent.temporary_funding_id = '${created.id}'`), 1);
        const settlements = await Promise.allSettled([
          createSettlement(fixture, created.id, "60.00"),
          createSettlement(fixture, created.id, "60.00")
        ]);
        assert.equal(settlements.filter((result) => result.status === "fulfilled").length, 1);
        const rejected = settlements.find((result) => result.status === "rejected") as PromiseRejectedResult;
        assert.match(String(rejected.reason), /exceeds the outstanding amount/);
      } finally {
        await fixture.close();
      }
    });

    test("reversal mirrors the funding exactly, links it, and needs independent people", async () => {
      const fixture = await setupFixture(harness);
      try {
        const funding = await postFunding(fixture, modeB(fixture, "300.00"));
        const settled = await postFunding(fixture, modeA(fixture, "50.00"));
        const settlement = await createSettlement(fixture, settled.id, "10.00");
        await assert.rejects(() => requestReversal(fixture, fixture.sessions.reverser, settled.id),
          /pending or posted settlements cannot be reversed/);
        await decideSettlement(fixture, fixture.sessions.settleApprover, settlement.settlement.id,
          settlement.settlement.version, "REJECTED");

        const requested = await requestReversal(fixture, fixture.sessions.reverser, funding.id);
        const reversal = requested.funding.reversal!;
        assert.equal(reversal.status, "REQUESTED");
        await assert.rejects(() => decideReversal(fixture, fixture.sessions.reverser, reversal.id, reversal.version, "APPROVED"),
          /independent of the request/);
        await grant(harness, fixture.world, fixture.world.approverId, "finance.temporary-funding.reverse");
        await assert.rejects(() => decideReversal(fixture, fixture.sessions.approver, reversal.id, reversal.version, "APPROVED"),
          /independent of the request, the funding and its posting/);
        const reversed = await decideReversal(fixture, fixture.sessions.reverseApprover, reversal.id, reversal.version, "APPROVED");
        assert.equal(reversed.status, "REVERSED");
        assert.equal(reversed.lifecycleStatus, "REVERSED");
        const reversalJournal = reversed.reversal!.reversalJournalId!;
        assert.deepEqual(await journalLines(harness, reversalJournal), [
          { line: 1, ledger: fixture.world.cashLedgerAccountId, party: null, debit: "0", credit: "300.00" },
          { line: 2, ledger: fixture.payableLedgerId, party: fixture.organizationPartyId, debit: "300.00", credit: "0" }
        ]);
        assert.deepEqual(await subledgers(harness, reversalJournal), [
          { line: 1, type: "OPERATIONAL_TREASURY", party: null, funding: null, treasury: fixture.safeId, amount: "-300.00" },
          { line: 2, type: "TEMPORARY_FUNDING_PAYABLE", party: fixture.organizationPartyId, funding: funding.id,
            treasury: null, amount: "-300.00" }
        ]);
        const link = await harness.executor.query<{ original_journal_id: string; kind: string }>(
          `SELECT link.original_journal_id, evidence.evidence_kind AS kind FROM abos.journal_reversal_links link
             JOIN abos.evidence_references evidence ON evidence.id = link.evidence_reference_id
            WHERE link.reversal_journal_id = $1`, [reversalJournal]);
        assert.deepEqual(link.rows[0], { original_journal_id: funding.journalId, kind: "REVERSAL_REASON" });
        assert.equal(await providerBalance(harness, fixture.organizationPartyId), "0.00");
        assert.equal(await safeMovement(harness, fixture.safeId), "0.00");
        await assert.rejects(() => requestReversal(fixture, fixture.sessions.reverser, funding.id),
          /only a posted temporary funding can be reversed/);
        await assert.rejects(() => createSettlement(fixture, funding.id, "1.00"), /posted, unreversed/);
      } finally {
        await fixture.close();
      }
    });

    test("authorization: maker-checker, provider independence, missing authority and runtime boundary", async () => {
      const fixture = await setupFixture(harness);
      try {
        const created = await createFunding(fixture, fixture.sessions.creator, modeA(fixture, "20.00"));
        await grant(harness, fixture.world, fixture.world.intentCreatorId, "finance.temporary-funding.approve");
        await assert.rejects(() => decide(fixture, fixture.sessions.creator, created.id, created.version, "APPROVED"),
          /creator or the funding provider cannot decide/);
        await assert.rejects(() => decide(fixture, fixture.sessions.settler, created.id, created.version, "APPROVED"),
          /current authority is missing finance.temporary-funding.approve/);
        await assert.rejects(() => createFunding(fixture, fixture.sessions.outsider, modeA(fixture, "5.00")),
          /current authority is missing finance.temporary-funding.create/);
        await assert.rejects(() => workspaceOf(fixture, fixture.sessions.outsider), /current authority is missing/);

        const officer = await createFunding(fixture, fixture.sessions.creator, {
          ...modeA(fixture, "30.00"), providerKind: "EMPLOYEE_OFFICER",
          providerBusinessPartyId: fixture.employeePartyId, providerUserAccountId: fixture.world.approverId
        });
        await assert.rejects(() => decide(fixture, fixture.sessions.approver, officer.id, officer.version, "APPROVED"),
          /creator or the funding provider cannot decide/);
        const posted = await decide(fixture, fixture.sessions.secondApprover, officer.id, officer.version, "APPROVED");
        await grant(harness, fixture.world, fixture.world.cashierId, "finance.temporary-funding.settle-approve");
        const settlement = await createSettlement(fixture, posted.id, "30.00");
        await assert.rejects(() => decideSettlement(fixture, fixture.sessions.settler, settlement.settlement.id,
          settlement.settlement.version, "APPROVED"), /settlement creator or the funding provider/);
        await grant(harness, fixture.world, fixture.world.approverId, "finance.temporary-funding.settle-approve");
        await assert.rejects(() => decideSettlement(fixture, fixture.sessions.approver, settlement.settlement.id,
          settlement.settlement.version, "APPROVED"), /settlement creator or the funding provider/);

        for (const table of ["temporary_fundings", "temporary_funding_settlements", "temporary_funding_reversals",
          "operational_treasury_cash_controls"] as const) {
          await assert.rejects(() => fixture.executor.query(`SELECT * FROM abos.${table}`), /permission denied/, table);
        }
        await assert.rejects(() => fixture.executor.query("SELECT abos.temporary_funding_post($1,$2)",
          [created.id, fixture.world.approverId]), /permission denied/);
        await assert.rejects(() => fixture.executor.query(
          "SELECT abos.operational_treasury_cash_guard($1,$2,1,$3::date)",
          [fixture.world.legalEntityId, fixture.safeId, DATE]), /permission denied/);
        // The owner has no column privilege to rewrite an amount; even a superuser meets the guard.
        await roleStatementRejected(harness, "abos_v1_operational_finance_owner",
          `UPDATE abos.temporary_fundings SET original_amount = 1, base_amount = 1 WHERE id = '${posted.id}'`,
          /permission denied/);
        await assert.rejects(() => harness.executor.query(
          `UPDATE abos.temporary_fundings SET original_amount = 1, base_amount = 1, version = version + 1,
                  updated_at = clock_timestamp() WHERE id = $1`, [posted.id]),
        /accounting identity of a temporary funding cannot change/);
        await assert.rejects(() => harness.executor.query(
          "DELETE FROM abos.temporary_fundings WHERE id = $1", [posted.id]), /temporary funding records are permanent/);
        await assert.rejects(() => harness.executor.query(
          "DELETE FROM abos.subledger_entries WHERE temporary_funding_id = $1", [posted.id]), /posted|immutable/i);
      } finally {
        await fixture.close();
      }
    });

    test("cancel and reject are final and leave no financial rows", async () => {
      const fixture = await setupFixture(harness);
      try {
        const cancelled = await createFunding(fixture, fixture.sessions.creator, modeA(fixture, "11.00"));
        const after = await call<{ funding: Funding }>(fixture.executor,
          "SELECT abos.temporary_funding_cancel($1,$2,$3,$4,$5,$6) AS value",
          [...args(fixture.sessions.creator), cancelled.id, cancelled.version, "Entered by mistake"]);
        assert.equal(after.funding.status, "CANCELLED");
        await assert.rejects(() => decide(fixture, fixture.sessions.approver, cancelled.id, after.funding.version, "APPROVED"),
          /not waiting for approval/);
        const rejected = await createFunding(fixture, fixture.sessions.creator, modeB(fixture, "12.00"));
        const decided = await decide(fixture, fixture.sessions.approver, rejected.id, rejected.version, "REJECTED");
        assert.equal(decided.status, "REJECTED");
        assert.equal(await scalar(harness,
          "SELECT count(*) FROM abos.posting_intents WHERE processing_model = 'OPERATIONAL_V1'"), 0);
        assert.equal(await safeMovement(harness, fixture.safeId), "0");
      } finally {
        await fixture.close();
      }
    });

    test("cross-company isolation: another company sees and decides nothing", async () => {
      const fixture = await setupFixture(harness);
      try {
        const funding = await postFunding(fixture, modeA(fixture, "33.00"));
        const other = await seedSyntheticWorld(harness.executor, { withoutSandboxAuthorization: true });
        await harness.executor.query(
          `INSERT INTO abos.sandbox_legal_entity_scopes (legal_entity_id, base_currency_code, authorized_by_user_account_id)
           VALUES ($1, 'USD', $2)`, [other.legalEntityId, fixture.world.bootstrapUserId]);
        for (const permission of ["finance.temporary-funding.read", "finance.temporary-funding.settle",
          "finance.temporary-funding.reverse", "finance.temporary-funding.approve"]) {
          await grant(harness, other, other.approverId, permission);
        }
        const outsider = sessionArgs((await issueOperationalSession(harness, other.approverId, other.legalEntityId)).token);
        const workspace = await workspaceOf(fixture, outsider);
        assert.equal(workspace.fundings.length, 0);
        assert.equal(workspace.providers.length, 0);
        assert.equal(workspace.payableTotal, "0");
        await assert.rejects(() => decide(fixture, outsider, funding.id, funding.version, "APPROVED"),
          /not available in this legal entity/);
        await assert.rejects(() => call(fixture.executor,
          "SELECT abos.temporary_funding_settlement_create($1,$2,$3,$4::jsonb) AS value",
          [...args(outsider), JSON.stringify(settlementBody(funding.id, fixture.safeId, "1.00"))]),
        /not available in this legal entity/);
        await assert.rejects(() => requestReversal(fixture, outsider, funding.id), /not available in this legal entity/);
      } finally {
        await fixture.close();
      }
    });

    test("no shareholder-capital contamination; provider kinds follow live party roles", async () => {
      const fixture = await setupFixture(harness);
      try {
        const funding = await postFunding(fixture, {
          ...modeB(fixture, "500.00"), providerKind: "SHAREHOLDER", providerBusinessPartyId: fixture.shareholderPartyId
        });
        assert.equal(await scalar(harness,
          `SELECT count(*) FROM abos.subledger_entries
            WHERE subledger_type IN ('SHAREHOLDER_CAPITAL', 'SHAREHOLDER_LOAN')`), 0);
        assert.equal(await scalar(harness,
          `SELECT count(*) FROM abos.journal_lines line JOIN abos.ledger_accounts ledger ON ledger.id = line.ledger_account_id
            WHERE line.journal_id = '${funding.journalId}'
              AND (ledger.account_type = 'EQUITY' OR ledger.control_account_type IN ('SHAREHOLDER_CAPITAL', 'SHAREHOLDER_LOAN'))`), 0);
        assert.equal(await providerBalance(harness, fixture.shareholderPartyId), "500.00");
        await assert.rejects(() => createFunding(fixture, fixture.sessions.creator, {
          ...modeA(fixture, "5.00"), providerKind: "OTHER_PERSON", providerBusinessPartyId: fixture.shareholderPartyId
        }), /provider kind does not match/);
        await assert.rejects(() => createFunding(fixture, fixture.sessions.creator, {
          ...modeA(fixture, "5.00"), providerKind: "SHAREHOLDER", providerBusinessPartyId: fixture.personPartyId
        }), /provider kind does not match/);
        await assert.rejects(() => createFunding(fixture, fixture.sessions.creator, {
          ...modeA(fixture, "5.00"), currencyCode: "AFN"
        }), /base-currency only/);
        // The payable mapping refuses an account reserved for shareholder capital.
        await assert.rejects(() => call(fixture.executor,
          "SELECT abos.temporary_funding_configure($1,$2,$3,$4,$5,$6) AS value",
          [...args(fixture.sessions.configurer), fixture.world.capitalLedgerAccountId, 1, "Try the capital account"]),
        /must be an ACTIVE posting LIABILITY account/);
      } finally {
        await fixture.close();
      }
    });

    test("stage 2 Safe guard: with an approved opening, outflows fail before posting when cash is short", async () => {
      const fixture = await setupFixture(harness);
      try {
        await approveOpening(harness, fixture, "100.00", "2026-09-01");
        const short = await call<{ expense: { id: string; version: number } }>(fixture.executor,
          "SELECT abos.operational_expense_create($1,$2,$3,$4::jsonb) AS value",
          [...args(fixture.sessions.creator), JSON.stringify(expensePayload(fixture, "150.00"))]);
        await assert.rejects(() => call(fixture.executor,
          "SELECT abos.operational_expense_approve($1,$2,$3,$4,$5,$6) AS value",
          [...args(fixture.sessions.approver), short.expense.id, short.expense.version, "Synthetic approval note"]),
        /insufficient recorded cash in this Treasury account: available 100.00, required 150.00/);
        assert.equal(await scalar(harness,
          `SELECT count(*) FROM abos.operational_expenses WHERE id = '${short.expense.id}' AND status = 'PENDING_APPROVAL'
              AND journal_id IS NULL`), 1, "the refused expense stays unposted");

        // The shortfall is funded explicitly instead of letting the Safe go negative.
        await postFunding(fixture, modeA(fixture, "150.00"));
        const workspace = await workspaceOf(fixture, fixture.sessions.creator);
        assert.equal(workspace.safePositions.find((position) => position.treasuryAccountId === fixture.safeId)
          ?.cashControl?.recordedCash, "100.00", "direct-pay funding never changes recorded Safe cash");
        const settlementFunding = await postFunding(fixture, modeB(fixture, "60.00"));
        const fits = await call<{ expense: { id: string; version: number } }>(fixture.executor,
          "SELECT abos.operational_expense_create($1,$2,$3,$4::jsonb) AS value",
          [...args(fixture.sessions.creator), JSON.stringify(expensePayload(fixture, "150.00"))]);
        const approved = await call<{ expense: { status: string } }>(fixture.executor,
          "SELECT abos.operational_expense_approve($1,$2,$3,$4,$5,$6) AS value",
          [...args(fixture.sessions.approver), fits.expense.id, fits.expense.version, "Synthetic approval note"]);
        assert.equal(approved.expense.status, "POSTED");
        const pending = await createSettlement(fixture, settlementFunding.id, "60.00");
        await assert.rejects(() => decideSettlement(fixture, fixture.sessions.settleApprover,
          pending.settlement.id, pending.settlement.version, "APPROVED"), /insufficient recorded cash/);
        assert.equal(await scalar(harness,
          `SELECT count(*) FROM abos.temporary_funding_settlements WHERE id = '${pending.settlement.id}'
              AND status = 'PENDING_APPROVAL'`), 1);
        assert.equal(await recordedCash(harness, fixture), "10.00");
      } finally {
        await fixture.close();
      }
    });

    test("journal validator dispatch rejects a forged funding journal even inside the owner boundary", async () => {
      const fixture = await setupFixture(harness);
      try {
        const funding = await postFunding(fixture, modeA(fixture, "40.00"));
        const client = await harness.pool.connect();
        try {
          await client.query("BEGIN");
          await client.query("SET LOCAL ROLE abos_v1_operational_finance_owner");
          const intent = randomUUID();
          const journal = randomUUID();
          await client.query(
            `INSERT INTO abos.posting_intents
               (id, legal_entity_id, source_type, source_id, intent_kind, original_amount, original_currency_code,
                base_amount, base_currency_code, accounting_effective_date, correlation_id, idempotency_key, status,
                created_by_user_account_id, processing_model, temporary_funding_settlement_id,
                finance_workflow_policy_version_id, temporary_funding_mapping_version_id)
             SELECT $1, legal_entity_id, 'TEMPORARY_FUNDING_SETTLEMENT', $2, 'TEMPORARY_FUNDING_SETTLEMENT', 40, 'USD',
                    40, 'USD', business_date, correlation_id, 'TFS:forged', 'POSTED', created_by_user_account_id,
                    'OPERATIONAL_V1', NULL, workflow_policy_version_id, mapping_version_id
               FROM abos.temporary_fundings WHERE id = $3`,
            [intent, randomUUID(), funding.id]).then(
            () => assert.fail("a settlement intent without its typed source must be refused"),
            (error: Error) => assert.match(error.message, /posting_intents_temporary_funding_settlement_source/));
          await client.query("ROLLBACK");
          await client.query("BEGIN");
          await client.query("SET LOCAL ROLE abos_v1_operational_finance_owner");
          // A journal posted against the funding intent a second time is refused by the unique journal-per-intent.
          await assert.rejects(() => client.query(
            `INSERT INTO abos.journals (id, legal_entity_id, accounting_period_id, posting_intent_id, journal_reference,
               accounting_effective_date, base_currency_code, status, created_by_user_account_id, processing_model)
             SELECT $1, journal.legal_entity_id, journal.accounting_period_id, journal.posting_intent_id, 'TFP-forged',
                    journal.accounting_effective_date, 'USD', 'DRAFT', journal.created_by_user_account_id, 'OPERATIONAL_V1'
               FROM abos.journals journal WHERE journal.id = $2`, [journal, funding.journalId]),
          /duplicate key value/);
        } finally {
          await client.query("ROLLBACK").catch(() => undefined);
          client.release();
        }
      } finally {
        await fixture.close();
      }
    });
  });
}

// ---------------------------------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------------------------------

async function applyProposal(harness: Harness): Promise<void> {
  const sql = await readFile(PROPOSAL, "utf8");
  await withClusterLock(harness.pool, async () => {
    const client = await harness.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });
}

async function setupFixture(harness: Harness): Promise<Fixture> {
  await resetSchema(harness.pool);
  await applyProposal(harness);
  const world = await seedSyntheticWorld(harness.executor);
  const q = (sql: string, parameters: readonly unknown[] = []) => harness.executor.query(sql, parameters);
  const expenseLedgerId = randomUUID();
  const payableLedgerId = randomUUID();
  const safeId = randomUUID();
  const bankId = randomUUID();
  const categoryId = randomUUID();
  await q(`INSERT INTO abos.ledger_accounts (id, legal_entity_id, account_code, account_name, account_type,
             posting_allowed, account_currency_code, status)
           VALUES ($1,$2,$3,'Synthetic Operational Expense','EXPENSE',true,'USD','ACTIVE'),
                  ($4,$2,$5,'Synthetic Temporary Funding Payable','LIABILITY',true,'USD','ACTIVE')`,
  [expenseLedgerId, world.legalEntityId, `SYN-EXP-${expenseLedgerId.slice(0, 8)}`, payableLedgerId,
    `SYN-TFP-${payableLedgerId.slice(0, 8)}`]);
  await q(`INSERT INTO abos.operational_treasury_accounts (id, legal_entity_id, name_en, name_fa, account_type,
             currency_code, ledger_account_id, status, version, created_by_user_account_id, last_changed_by_user_account_id)
           VALUES ($1,$2,'Synthetic Main Safe','صندوق اصلی آزمایشی','SAFE','USD',$3,'ACTIVE',1,$4,$4)`,
  [safeId, world.legalEntityId, world.cashLedgerAccountId, world.bootstrapUserId]);
  const bankLedgerId = randomUUID();
  await q(`INSERT INTO abos.ledger_accounts (id, legal_entity_id, account_code, account_name, account_type,
             control_account_type, posting_allowed, account_currency_code, status)
           VALUES ($1,$2,$3,'Synthetic Bank','ASSET','CASH',true,'USD','ACTIVE')`,
  [bankLedgerId, world.legalEntityId, `SYN-BNK-${bankLedgerId.slice(0, 8)}`]);
  await q(`INSERT INTO abos.operational_treasury_accounts (id, legal_entity_id, name_en, account_type, currency_code,
             ledger_account_id, status, version, created_by_user_account_id, last_changed_by_user_account_id)
           VALUES ($1,$2,'Synthetic Bank','BANK','USD',$3,'ACTIVE',1,$4,$4)`,
  [bankId, world.legalEntityId, bankLedgerId, world.bootstrapUserId]);
  await q(`INSERT INTO abos.operational_expense_categories (id, legal_entity_id, category_code, name_en, name_fa,
             ledger_account_id, status, version, created_by_user_account_id, last_changed_by_user_account_id)
           VALUES ($1,$2,'SYN-OPS','Synthetic Operations','عملیات آزمایشی',$3,'ACTIVE',1,$4,$4)`,
  [categoryId, world.legalEntityId, expenseLedgerId, world.bootstrapUserId]);
  for (const type of ["EXPENSE", "TEMPORARY_FUNDING"]) {
    await q(`INSERT INTO abos.finance_workflow_policy_versions (id, legal_entity_id, workflow_type, version,
               approval_required, configured_by_user_account_id, change_reason)
             VALUES ($1,$2,$3,1,true,$4,'Synthetic test-only approval route.')`,
    [randomUUID(), world.legalEntityId, type, world.bootstrapUserId]);
  }
  const party = async (name: string, role: string | null): Promise<string> => {
    const id = randomUUID();
    await q(`INSERT INTO abos.business_parties (id, legal_entity_id, display_name, external_reference, status)
             VALUES ($1,$2,$3,$4,'ACTIVE')`, [id, world.legalEntityId, name, `SYN-${id.slice(0, 8)}`]);
    if (role !== null) {
      await q(`INSERT INTO abos.business_party_roles (business_party_id, role_code, effective_from)
               VALUES ($1,$2,'2026-01-01')`, [id, role]);
    }
    return id;
  };
  const shareholderPartyId = await party("Synthetic Funding Shareholder", "SHAREHOLDER");
  const employeePartyId = await party("Synthetic Officer", "EMPLOYEE");
  const personPartyId = await party("Synthetic Other Person", null);
  const organizationPartyId = await party("Synthetic Organization", null);
  const payeePartyId = await party("Synthetic Supplier", "SUPPLIER");

  const grants: readonly (readonly [string, string])[] = [
    [world.intentCreatorId, "finance.temporary-funding.create"],
    [world.intentCreatorId, "finance.temporary-funding.read"],
    [world.intentCreatorId, "finance.expense.create"],
    [world.intentCreatorId, "finance.expense.read"],
    [world.approverId, "finance.temporary-funding.approve"],
    [world.approverId, "finance.expense.approve"],
    [world.treasuryApproverId, "finance.temporary-funding.approve"],
    [world.cashierId, "finance.temporary-funding.settle"],
    [world.counterId, "finance.temporary-funding.settle-approve"],
    [world.reverserId, "finance.temporary-funding.reverse"],
    [world.countConfirmerId, "finance.temporary-funding.reverse"],
    [world.treasuryManagerId, "finance.temporary-funding.configure"]
  ];
  for (const [userId, permission] of grants) await grant(harness, world, userId, permission);

  await ensureLogin(harness);
  const connection = await restrictedFinance();
  const session = async (userId: string) =>
    sessionArgs((await issueOperationalSession(harness, userId, world.legalEntityId)).token);
  const sessions: Sessions = {
    creator: await session(world.intentCreatorId),
    approver: await session(world.approverId),
    secondApprover: await session(world.treasuryApproverId),
    settler: await session(world.cashierId),
    settleApprover: await session(world.counterId),
    reverser: await session(world.reverserId),
    reverseApprover: await session(world.countConfirmerId),
    configurer: await session(world.treasuryManagerId),
    outsider: await session(world.treasuryReconcilerId)
  };
  const configured = await call<{ version: number; replayed: boolean }>(connection.executor,
    "SELECT abos.temporary_funding_configure($1,$2,$3,$4,$5,$6) AS value",
    [...args(sessions.configurer), payableLedgerId, 0, "Synthetic payable mapping"]);
  assert.deepEqual(configured, { ...configured, version: 1, replayed: false });
  return {
    world, safeId, bankId, categoryId, expenseLedgerId, payableLedgerId, shareholderPartyId, employeePartyId,
    personPartyId, organizationPartyId, payeePartyId, sessions, executor: connection.executor, close: connection.close
  };
}

async function approveOpening(harness: Harness, fixture: Fixture, amount: string, asOf: string): Promise<void> {
  const evidenceId = randomUUID();
  await harness.executor.query(
    `INSERT INTO abos.evidence_references (id, legal_entity_id, document_id, evidence_kind, evidence_version, sha256, completed_at)
     VALUES ($1,$2,$3,'OPENING_RECONCILIATION',1,$4,clock_timestamp())`,
    [evidenceId, fixture.world.legalEntityId, randomUUID(), createHash("sha256").update(evidenceId).digest("hex")]);
  await harness.executor.query(
    `INSERT INTO abos.operational_treasury_cash_controls (id, legal_entity_id, operational_treasury_account_id,
       opening_amount, opening_as_of, evidence_reference_id, recorded_by_user_account_id, approved_by_user_account_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [randomUUID(), fixture.world.legalEntityId, fixture.safeId, amount, asOf, evidenceId,
      fixture.world.treasuryManagerId, fixture.world.treasuryApproverId]);
}

// ---------------------------------------------------------------------------------------------------
// Entry-point calls
// ---------------------------------------------------------------------------------------------------

function modeA(fixture: Fixture, amount: string): Record<string, unknown> {
  return {
    fundingMode: "PROVIDER_PAID_EXPENSE", providerKind: "OTHER_PERSON",
    providerBusinessPartyId: fixture.personPartyId, expenseCategoryId: fixture.categoryId,
    payeeBusinessPartyId: fixture.payeePartyId, reference: `TF-${randomUUID().slice(0, 8)}`,
    description: "Provider paid a synthetic supplier directly", businessDate: DATE, originalAmount: amount,
    currencyCode: "USD", correlationId: randomUUID(), idempotencyKey: `tf-${randomUUID()}`
  };
}

function modeB(fixture: Fixture, amount: string): Record<string, unknown> {
  return {
    fundingMode: "PROVIDER_FUNDED_SAFE", providerKind: "ORGANIZATION",
    providerBusinessPartyId: fixture.organizationPartyId, treasuryAccountId: fixture.safeId,
    reference: `TF-${randomUUID().slice(0, 8)}`, description: "Provider placed synthetic cash in the Safe",
    businessDate: DATE, originalAmount: amount, currencyCode: "USD", correlationId: randomUUID(),
    idempotencyKey: `tf-${randomUUID()}`
  };
}

function settlementBody(fundingId: string, treasuryId: string, amount: string): Record<string, unknown> {
  return {
    temporaryFundingId: fundingId, treasuryAccountId: treasuryId, reference: `TFS-${randomUUID().slice(0, 8)}`,
    businessDate: "2026-09-25", originalAmount: amount, correlationId: randomUUID(),
    idempotencyKey: `tfs-${randomUUID()}`
  };
}

function expensePayload(fixture: Fixture, amount: string): Record<string, unknown> {
  return {
    treasuryAccountId: fixture.safeId, expenseCategoryId: fixture.categoryId, reference: `EXP-${randomUUID().slice(0, 8)}`,
    description: "Synthetic ordinary Safe-funded expense", businessDate: DATE, originalAmount: amount,
    currencyCode: "USD", correlationId: randomUUID(), idempotencyKey: `expense-${randomUUID()}`
  };
}

async function callFundingCreate(fixture: Fixture, session: SessionArgs, payload: Record<string, unknown>):
Promise<{ funding: Funding; replayed: boolean }> {
  return call(fixture.executor, "SELECT abos.temporary_funding_create($1,$2,$3,$4::jsonb) AS value",
    [...args(session), JSON.stringify(payload)]);
}

async function createFunding(fixture: Fixture, session: SessionArgs, payload: Record<string, unknown>): Promise<Funding> {
  return (await callFundingCreate(fixture, session, payload)).funding;
}

async function decide(fixture: Fixture, session: SessionArgs, id: string, version: number, decision: string): Promise<Funding> {
  return (await call<{ funding: Funding }>(fixture.executor,
    "SELECT abos.temporary_funding_decide($1,$2,$3,$4,$5,$6,$7) AS value",
    [...args(session), id, version, decision, "Synthetic approval note"])).funding;
}

async function postFunding(fixture: Fixture, payload: Record<string, unknown>): Promise<Funding> {
  const created = await createFunding(fixture, fixture.sessions.creator, payload);
  return decide(fixture, fixture.sessions.approver, created.id, created.version, "APPROVED");
}

async function createSettlement(fixture: Fixture, fundingId: string, amount: string):
Promise<{ settlement: { id: string; version: number }; funding: Funding }> {
  return call(fixture.executor, "SELECT abos.temporary_funding_settlement_create($1,$2,$3,$4::jsonb) AS value",
    [...args(fixture.sessions.settler), JSON.stringify(settlementBody(fundingId, fixture.safeId, amount))]);
}

async function decideSettlement(fixture: Fixture, session: SessionArgs, id: string, version: number, decision: string):
Promise<Funding> {
  return (await call<{ funding: Funding }>(fixture.executor,
    "SELECT abos.temporary_funding_settlement_decide($1,$2,$3,$4,$5,$6,$7) AS value",
    [...args(session), id, version, decision, "Synthetic settlement decision"])).funding;
}

async function requestReversal(fixture: Fixture, session: SessionArgs, fundingId: string): Promise<{ funding: Funding }> {
  return call(fixture.executor, "SELECT abos.temporary_funding_reversal_request($1,$2,$3,$4::jsonb) AS value",
    [...args(session), JSON.stringify({
      temporaryFundingId: fundingId, reversalDate: "2026-09-26", reason: "Recorded against the wrong provider",
      correlationId: randomUUID(), idempotencyKey: `tfr-${randomUUID()}`
    })]);
}

async function decideReversal(fixture: Fixture, session: SessionArgs, id: string, version: number, decision: string):
Promise<Funding> {
  return (await call<{ funding: Funding }>(fixture.executor,
    "SELECT abos.temporary_funding_reversal_decide($1,$2,$3,$4,$5,$6,$7) AS value",
    [...args(session), id, version, decision, "Synthetic reversal decision"])).funding;
}

interface Workspace {
  readonly payableTotal: string;
  readonly fundings: readonly Funding[];
  readonly providers: readonly { name: string; fundedAmount: string; settledAmount: string; outstandingAmount: string;
    status: string }[];
  readonly safePositions: readonly { treasuryAccountId: string; postedMovementTotal: string;
    temporaryFundingInflow: string; nonNegativeEnforced: boolean;
    cashControl: null | { recordedCash: string } }[];
}

async function workspaceOf(fixture: Fixture, session: SessionArgs): Promise<Workspace> {
  return call(fixture.executor, "SELECT abos.temporary_funding_workspace($1,$2,$3) AS value", args(session));
}

// ---------------------------------------------------------------------------------------------------
// Ledger reads (superuser, test-only)
// ---------------------------------------------------------------------------------------------------

async function journalLines(harness: Harness, journalId: string) {
  const result = await harness.executor.query<{ line: number; ledger: string; party: string | null; debit: string; credit: string }>(
    `SELECT line_number AS line, ledger_account_id AS ledger, business_party_id AS party,
            base_debit::text AS debit, base_credit::text AS credit
       FROM abos.journal_lines WHERE journal_id = $1 ORDER BY line_number`, [journalId]);
  return result.rows;
}

async function subledgers(harness: Harness, journalId: string) {
  const result = await harness.executor.query<{
    line: number; type: string; party: string | null; funding: string | null; treasury: string | null; amount: string;
  }>(
    `SELECT line.line_number AS line, entry.subledger_type AS type, entry.business_party_id AS party,
            entry.temporary_funding_id AS funding, entry.operational_treasury_account_id AS treasury,
            entry.base_amount::text AS amount
       FROM abos.subledger_entries entry JOIN abos.journal_lines line ON line.id = entry.journal_line_id
      WHERE line.journal_id = $1 ORDER BY line.line_number, entry.subledger_type`, [journalId]);
  return result.rows;
}

async function safeMovement(harness: Harness, treasuryId: string): Promise<string> {
  const result = await harness.executor.query<{ total: string }>(
    `SELECT COALESCE(sum(entry.original_amount), 0)::text AS total
       FROM abos.subledger_entries entry JOIN abos.journal_lines line ON line.id = entry.journal_line_id
       JOIN abos.journals journal ON journal.id = line.journal_id
      WHERE entry.operational_treasury_account_id = $1 AND journal.status = 'POSTED'`, [treasuryId]);
  return result.rows[0]!.total;
}

async function recordedCash(harness: Harness, fixture: Fixture): Promise<string> {
  const result = await harness.executor.query<{ cash: string }>(
    "SELECT abos.operational_treasury_recorded_cash($1,$2)::text AS cash", [fixture.world.legalEntityId, fixture.safeId]);
  return result.rows[0]!.cash;
}

async function providerBalance(harness: Harness, partyId: string): Promise<string> {
  const result = await harness.executor.query<{ total: string }>(
    `SELECT COALESCE(sum(entry.base_amount), 0)::text AS total
       FROM abos.subledger_entries entry JOIN abos.journal_lines line ON line.id = entry.journal_line_id
       JOIN abos.journals journal ON journal.id = line.journal_id
      WHERE entry.subledger_type = 'TEMPORARY_FUNDING_PAYABLE' AND entry.business_party_id = $1
        AND journal.status = 'POSTED'`, [partyId]);
  return result.rows[0]!.total;
}

async function ledgerLineCount(harness: Harness, ledgerId: string): Promise<number> {
  return scalar(harness, `SELECT count(*) FROM abos.journal_lines WHERE ledger_account_id = '${ledgerId}'`);
}

async function auditActions(harness: Harness, entityId: string): Promise<string[]> {
  const result = await harness.executor.query<{ action: string }>(
    "SELECT action FROM abos.audit_records WHERE entity_id = $1 ORDER BY occurred_at, action", [entityId]);
  return result.rows.map((row) => row.action);
}

// ---------------------------------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------------------------------

async function call<T>(executor: PostgresExecutor, sql: string, parameters: readonly unknown[]): Promise<T> {
  const result = await executor.query<{ value: T }>(sql, parameters);
  assert.ok(result.rows[0]);
  return result.rows[0].value;
}

function args(session: SessionArgs): [string, string, string] {
  return [session.proof, session.runtimeDigest, session.tokenDigest];
}

async function grant(harness: Harness, world: SyntheticWorld, userId: string, permission: string): Promise<void> {
  await harness.executor.query(
    `INSERT INTO abos.user_permission_grants (user_account_id, legal_entity_id, permission_code, granted_by_user_account_id)
     VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
    [userId, world.legalEntityId, permission, world.bootstrapUserId]);
}

async function ensureLogin(harness: Harness): Promise<void> {
  await harness.executor.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${LOGIN.name}') THEN
      CREATE ROLE ${LOGIN.name} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
    END IF; END $$`);
  await harness.executor.query(`ALTER ROLE ${LOGIN.name} LOGIN PASSWORD '${LOGIN.password}'`);
  await harness.executor.query(`GRANT abos_e1_runtime TO ${LOGIN.name}`);
}

async function restrictedFinance(): Promise<{ readonly executor: PostgresExecutor; close(): Promise<void> }> {
  const url = new URL(databaseUrl() ?? "");
  url.username = LOGIN.name;
  url.password = LOGIN.password;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 6 });
  return { executor: new PostgresExecutor(pool, { runtimeMarker: MARKER }), close: () => pool.end() };
}

function sessionArgs(token: string): SessionArgs {
  return {
    proof: identityDatabaseProof(SYNTHETIC_AUTH_CONFIGURATION.signingSecret),
    runtimeDigest: createHash("sha256").update(token).digest("hex"),
    tokenDigest: createHmac("sha256", SYNTHETIC_AUTH_CONFIGURATION.signingSecret).update(token).digest("hex")
  };
}

async function scalar(harness: Harness, sql: string): Promise<number> {
  const result = await harness.executor.query<{ count: string }>(sql);
  return Number(result.rows[0]?.count ?? "0");
}

async function roleStatementRejected(harness: Harness, role: string, sql: string, message: RegExp): Promise<void> {
  const client = await harness.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL ROLE ${role}`);
    await assert.rejects(() => client.query(sql), message);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}
