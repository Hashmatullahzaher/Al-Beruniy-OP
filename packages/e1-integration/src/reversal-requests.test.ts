import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before, describe } from "node:test";
import pg from "pg";
import type {
  CapitalAgreementId, CapitalInstallmentId, CashLocationCurrencyAccountId, CorrelationId, EvidenceReference,
  IdempotencyKey, LegalEntityId, PostingIntentId, UserAccountId
} from "@abos/contracts";
import { asDecimalString } from "@abos/contracts";
import type { SqlExecutor } from "@abos/database";
import { PostgresExecutor, PostgresShareholderRepository, RestrictedCapitalPostingGateway } from "@abos/persistence";
import { SandboxAuthenticator } from "@abos/sandbox-auth";
import { CapitalReceiptIntentService } from "@abos/shareholder";
import { databaseUrl, MISSING_DATABASE_MESSAGE, openHarness, resetSchema, type Harness } from "./harness.ts";
import {
  addInstallment, handOffSyntheticReceipt, recordCapitalPostingIntent, recordSyntheticTreasuryReceipt, seedSyntheticWorld,
  SYNTHETIC_AUTH_CONFIGURATION, type SyntheticWorld
} from "./synthetic-world.ts";

/**
 * Migration 0023: controlled reversal requests (backlog #17), through the restricted Finance login.
 *
 * A Finance user requests, the Finance Manager approves; nobody decides their own request, and
 * (conservatively, until the Finance Manager decides) nobody who prepared, approved or posted the
 * journal requests or decides its reversal. Posting the reversal is deliberately not implemented:
 * an approval creates no journal, line, link or posting intent. Every person and amount is synthetic.
 */

const MARKER = SYNTHETIC_AUTH_CONFIGURATION.runtimeMarker;
const LOGINS = {
  finance: { name: "abos_e1_finance_runtime_test_login", password: "synthetic-finance-runtime-only-2026", role: "abos_e1_runtime" },
  treasury: { name: "abos_e1_treasury_runtime_test_login", password: "synthetic-treasury-runtime-only-2026", role: "abos_e1_treasury_runtime" },
  identity: { name: "abos_v1_identity_runtime_test_login", password: "synthetic-identity-runtime-only-2026", role: "abos_v1_identity_runtime" }
} as const;

interface JournalLine { lineNumber: number; accountCode: string; baseCurrency: string; baseDebit: string; baseCredit: string; originalAmount: string | null }
interface Journal {
  id: string; reference: string; status: string; postedBy: string; intentKind: string; viewerIsParticipant: boolean;
  lines: JournalLine[]; totals: { currency: string; debits: string; credits: string }[];
}
interface Request {
  id: string; status: string; reason: string; version: number; requestedBy: string; decidedBy: string | null; decisionNote: string | null;
  viewerIsRequester: boolean; viewerIsDecider: boolean; posting: { status: string; reversalJournalId: string | null }; journal: Journal;
}
interface View {
  syntheticOnly: boolean; canRequest: boolean; canApprove: boolean; legalEntity: { id: string };
  posting: { available: boolean; status: string; pendingDecisions: string[] };
  requests: Request[]; eligibleJournals: Journal[]; eligibleHasMore: boolean;
}
interface People { requester: string; manager: string; secondManager: string; reader: string }
interface Tokens { requester: string; manager: string; secondManager: string; reader: string; outsider: string; preparer: string; poster: string }

if (databaseUrl() === undefined) {
  test("V1 reversal requests", () => assert.fail(MISSING_DATABASE_MESSAGE));
} else {
  describe("V1 reversal requests (migration 0023)", () => {
    let harness: Harness;
    let financePool: pg.Pool;
    let db: SqlExecutor;
    before(async () => {
      harness = await openHarness(MARKER);
      for (const login of Object.values(LOGINS)) await ensureLogin(harness, login);
      financePool = new pg.Pool({ connectionString: loginUrl("finance"), max: 4 });
      db = new PostgresExecutor(financePool, { runtimeMarker: MARKER });
    });
    after(async () => { await financePool.end(); await harness.close(); });

    test("the catalogue adds request and approve (version 4) and leaves finance.journal.reverse unavailable", async () => {
      await prepare(harness, 0);
      const rows = await harness.executor.query<{ permission_code: string; catalogue_version: number; category: string; availability: string; independence_enforced: boolean; administrative: boolean; sort_order: number }>(
        `SELECT permission_code, catalogue_version, category, availability, independence_enforced, administrative, sort_order
           FROM abos.permission_catalogue WHERE permission_code IN ('finance.reversal.request', 'finance.reversal.approve', 'finance.journal.reverse')
          ORDER BY sort_order`);
      assert.deepEqual(rows.rows, [
        { permission_code: "finance.journal.reverse", catalogue_version: 1, category: "FINANCE", availability: "UNAVAILABLE_IN_PREVIEW", independence_enforced: true, administrative: false, sort_order: 160 },
        { permission_code: "finance.reversal.request", catalogue_version: 4, category: "FINANCE", availability: "ACTIVE", independence_enforced: true, administrative: false, sort_order: 270 },
        { permission_code: "finance.reversal.approve", catalogue_version: 4, category: "FINANCE", availability: "ACTIVE", independence_enforced: true, administrative: false, sort_order: 271 }
      ]);
      await refused(harness.executor.query("SELECT abos.finance_runtime_authorize($1, 'finance.journal.reverse')", ["t".repeat(43)]), "42501", /unsupported Finance permission/);
    });

    test("a Finance user requests, the Finance Manager approves, and nothing is posted", async () => {
      const { world, people, tokens, journals } = await prepare(harness, 1);
      const journalId = journals[0] ?? "";

      const requesterView = await view(db, tokens.requester);
      assert.equal(requesterView.syntheticOnly, true);
      assert.equal(requesterView.canRequest, true);
      assert.equal(requesterView.canApprove, false);
      assert.deepEqual(requesterView.posting, { available: false, status: "AWAITING_POSTING_POLICY",
        pendingDecisions: ["REVERSAL_DATE_AND_PERIOD", "REVERSAL_EVIDENCE", "SOURCE_RECORD_EFFECTS"] });
      const eligible = requesterView.eligibleJournals.find((journal) => journal.id === journalId);
      assert.ok(eligible, "the posted journal can be requested");
      assert.equal(eligible.viewerIsParticipant, false);
      assert.equal(eligible.postedBy, "Synthetic Finance Approver");
      assert.equal(eligible.intentKind, "SHAREHOLDER_CAPITAL_RECEIPT");
      // Exact decimal text, currencies kept apart.
      assert.deepEqual(eligible.lines.map((line) => [line.lineNumber, line.baseCurrency, line.baseDebit, line.baseCredit]),
        [[1, "USD", world.installmentAmount, "0"], [2, "USD", "0", world.installmentAmount]]);
      assert.deepEqual(eligible.totals, [{ currency: "USD", debits: world.installmentAmount, credits: world.installmentAmount }]);

      const before = await postingFootprint(harness, world);

      await refused(create(db, tokens.requester, journalId, "too short"), "23514", /reason of 10 to 1000/);
      await refused(create(db, tokens.requester, journalId, "x".repeat(1001)), "23514", /reason of 10 to 1000/);
      await refused(create(db, tokens.requester, randomUUID(), "Synthetic: journal that does not exist"), "P0002", /journal not found/);
      const reason = "Synthetic: posted to the wrong capital installment";
      const first = await create(db, tokens.requester, journalId, `  ${reason}  `);
      assert.equal(first.created, true);
      assert.equal(first.request.status, "REQUESTED");
      assert.equal(first.request.reason, reason, "the reason is stored trimmed");
      assert.equal(first.request.version, 1);
      assert.equal(first.request.requestedBy, "Synthetic Reversal Requester");
      assert.equal(first.request.viewerIsRequester, true);
      assert.equal(first.request.posting.status, "NOT_APPLICABLE");
      // A replay returns the same request; a different request for the same journal is refused.
      const replay = await create(db, tokens.requester, journalId, reason);
      assert.equal(replay.created, false);
      assert.equal(replay.request.id, first.request.id);
      await refused(create(db, tokens.requester, journalId, "Synthetic: a second, different reason"), "23505", /already has an open reversal request/);
      assert.ok(!(await view(db, tokens.requester)).eligibleJournals.some((journal) => journal.id === journalId), "an open request removes the journal from the list");

      // The requester, even holding the approve permission, cannot decide their own request.
      await grant(harness, world, people.requester, ["finance.reversal.approve"]);
      await refused(decide(db, tokens.requester, first.request.id, 1, "APPROVED", null), "ABR01", /requested a reversal cannot decide it/);
      await refused(decide(db, tokens.manager, first.request.id, 1, "MAYBE", null), "23514", /APPROVED or REJECTED/);
      await refused(decide(db, tokens.manager, first.request.id, 7, "APPROVED", null), "40001", /changed by someone else/);

      const managerView = await view(db, tokens.manager);
      assert.equal(managerView.canApprove, true);
      assert.equal(managerView.canRequest, false);
      assert.deepEqual(managerView.eligibleJournals, [], "only requesters are offered journals");
      assert.equal(managerView.requests[0]?.id, first.request.id);

      const approved = await decide(db, tokens.manager, first.request.id, 1, "APPROVED", "Synthetic: checked against the installment");
      assert.equal(approved.changed, true);
      assert.equal(approved.request.status, "APPROVED");
      assert.equal(approved.request.version, 2);
      assert.equal(approved.request.decidedBy, "Synthetic Finance Manager");
      assert.equal(approved.request.viewerIsDecider, true);
      assert.deepEqual(approved.request.posting, { status: "AWAITING_POSTING_POLICY", reversalJournalId: null });
      // A replay of the same decision changes nothing; any other decision is refused.
      const again = await decide(db, tokens.manager, first.request.id, 1, "APPROVED", null);
      assert.equal(again.changed, false);
      assert.equal(again.request.version, 2);
      await refused(decide(db, tokens.manager, first.request.id, 2, "REJECTED", "Synthetic change of mind"), "ABR02", /already approved/);
      await refused(decide(db, tokens.secondManager, first.request.id, 2, "APPROVED", null), "ABR02", /already approved/);
      await refused(withdraw(db, tokens.requester, first.request.id, 2, null), "ABR02", /already approved/);
      await refused(create(db, tokens.requester, journalId, "Synthetic: ask again after approval"), "23505", /already approved and awaits the posting policy/);

      // Fail-closed posting: no journal, line, link, intent, approval, subledger entry, outbox event
      // or idempotency record was created, and no source record changed.
      assert.deepEqual(await postingFootprint(harness, world), before);
      const journal = await harness.executor.query<{ status: string }>("SELECT status FROM abos.journals WHERE id = $1", [journalId]);
      assert.equal(journal.rows[0]?.status, "POSTED");

      const audit = await harness.executor.query<{ action: string; actor: string; metadata: { postingPerformed: boolean; journalId: string } }>(
        `SELECT action, actor_user_account_id AS actor, metadata FROM abos.audit_records
          WHERE entity_type = 'JOURNAL_REVERSAL_REQUEST' AND entity_id = $1 ORDER BY occurred_at`, [first.request.id]);
      assert.deepEqual(audit.rows.map((row) => [row.action, row.actor]),
        [["JOURNAL_REVERSAL_REQUESTED", people.requester], ["JOURNAL_REVERSAL_APPROVED", people.manager]]);
      assert.ok(audit.rows.every((row) => row.metadata.postingPerformed === false && row.metadata.journalId === journalId));

      // The decision is final, whoever writes: the migration identity cannot rewrite, delete or truncate it.
      await refused(harness.executor.query("UPDATE abos.journal_reversal_requests SET status = 'REJECTED', decision_note = 'x', version = version + 1 WHERE id = $1",
        [first.request.id]), "ABR02", /already approved/);
      await refused(harness.executor.query("UPDATE abos.journal_reversal_requests SET reason = 'Synthetic rewritten reason' WHERE id = $1",
        [first.request.id]), "ABR02", /cannot change/);
      await refused(harness.executor.query("DELETE FROM abos.journal_reversal_requests"), "P0001", /permanent records/);
      await refused(harness.executor.query("TRUNCATE abos.journal_reversal_requests"), "P0001", /permanent records/);
    });

    test("rejection needs a reason, the requester may withdraw, and a closed request may be followed by a new one", async () => {
      const { world, tokens, journals } = await prepare(harness, 1);
      const journalId = journals[0] ?? "";
      const first = await create(db, tokens.requester, journalId, "Synthetic: duplicate receipt suspected");
      await refused(decide(db, tokens.manager, first.request.id, 1, "REJECTED", "  "), "23514", /say why/);
      const rejected = await decide(db, tokens.manager, first.request.id, 1, "REJECTED", "Synthetic: the receipt is not a duplicate");
      assert.equal(rejected.request.status, "REJECTED");
      assert.equal(rejected.request.decisionNote, "Synthetic: the receipt is not a duplicate");
      await refused(withdraw(db, tokens.requester, first.request.id, 2, null), "ABR02", /already rejected/);

      // After a rejection the journal can be requested again.
      const second = await create(db, tokens.requester, journalId, "Synthetic: new evidence of a duplicate");
      assert.equal(second.created, true);
      assert.notEqual(second.request.id, first.request.id);
      // Only the requester withdraws, with the current version.
      await grant(harness, world, (await personId(harness, "Synthetic Finance Manager")), ["finance.reversal.request"]);
      await refused(withdraw(db, tokens.manager, second.request.id, 1, null), "ABR01", /only the person who requested/);
      await refused(withdraw(db, tokens.requester, second.request.id, 3, null), "40001", /changed by someone else/);
      const withdrawn = await withdraw(db, tokens.requester, second.request.id, 1, "Synthetic: raised in error");
      assert.equal(withdrawn.changed, true);
      assert.equal(withdrawn.request.status, "WITHDRAWN");
      assert.equal(withdrawn.request.decidedBy, "Synthetic Reversal Requester");
      assert.equal((await withdraw(db, tokens.requester, second.request.id, 1, null)).changed, false, "a replayed withdrawal changes nothing");
      await refused(decide(db, tokens.manager, second.request.id, 2, "APPROVED", null), "ABR02", /already withdrawn/);

      const all = (await view(db, tokens.reader)).requests;
      assert.deepEqual(all.map((request) => request.status), ["WITHDRAWN", "REJECTED"]);
      const audit = await harness.executor.query<{ action: string }>(
        "SELECT action FROM abos.audit_records WHERE entity_type = 'JOURNAL_REVERSAL_REQUEST' ORDER BY occurred_at");
      assert.deepEqual(audit.rows.map((row) => row.action),
        ["JOURNAL_REVERSAL_REQUESTED", "JOURNAL_REVERSAL_REJECTED", "JOURNAL_REVERSAL_REQUESTED", "JOURNAL_REVERSAL_WITHDRAWN"]);
    });

    test("segregation of duties: nobody decides their own request, and journal participants neither request nor decide", async () => {
      const { world, people, tokens, journals } = await prepare(harness, 1);
      const journalId = journals[0] ?? "";
      // The journal's preparer and its approver/poster hold both new permissions and are still refused.
      for (const participant of [world.intentCreatorId, world.approverId]) {
        await grant(harness, world, participant, ["finance.reversal.request", "finance.reversal.approve"]);
      }
      const posterView = await view(db, tokens.poster);
      assert.equal(posterView.eligibleJournals.find((journal) => journal.id === journalId)?.viewerIsParticipant, true);
      await refused(create(db, tokens.preparer, journalId, "Synthetic: my own journal is wrong"), "ABR01", /cannot request its reversal/);
      await refused(create(db, tokens.poster, journalId, "Synthetic: my own journal is wrong"), "ABR01", /cannot request its reversal/);

      const request = await create(db, tokens.requester, journalId, "Synthetic: independent request");
      await refused(decide(db, tokens.poster, request.request.id, 1, "APPROVED", null), "ABR01", /cannot decide its reversal/);
      await refused(decide(db, tokens.preparer, request.request.id, 1, "APPROVED", null), "ABR01", /cannot decide its reversal/);

      // The database enforces the same rules whoever writes, not only the entry points.
      await refused(harness.executor.query(
        `UPDATE abos.journal_reversal_requests SET status = 'APPROVED', decided_by_user_account_id = requested_by_user_account_id,
            decided_at = clock_timestamp(), version = version + 1 WHERE id = $1`, [request.request.id]), "ABR01", /cannot decide it/);
      await refused(harness.executor.query(
        `UPDATE abos.journal_reversal_requests SET status = 'APPROVED', decided_by_user_account_id = $2,
            decided_at = clock_timestamp(), version = version + 1 WHERE id = $1`, [request.request.id, world.approverId]), "ABR01", /cannot decide its reversal/);
      await refused(harness.executor.query(
        `UPDATE abos.journal_reversal_requests SET status = 'WITHDRAWN', decided_by_user_account_id = $2,
            decided_at = clock_timestamp(), version = version + 1 WHERE id = $1`, [request.request.id, people.manager]), "ABR01", /only the person who requested/);
      await refused(harness.executor.query(
        `UPDATE abos.journal_reversal_requests SET status = 'APPROVED', decided_by_user_account_id = $2,
            decided_at = clock_timestamp() WHERE id = $1`, [request.request.id, people.manager]), "40001", /changed by someone else/);
      await refused(harness.executor.query(
        `INSERT INTO abos.journal_reversal_requests (id, legal_entity_id, journal_id, reason, status, requested_by_user_account_id)
         VALUES (gen_random_uuid(), $1, $2, 'Synthetic direct insert', 'REQUESTED', $3)`, [world.legalEntityId, journalId, world.intentCreatorId]),
        "ABR01", /cannot request its reversal/);
      await refused(harness.executor.query(
        `INSERT INTO abos.journal_reversal_requests (id, legal_entity_id, journal_id, reason, status, requested_by_user_account_id, decided_by_user_account_id, decided_at, version)
         VALUES (gen_random_uuid(), $1, $2, 'Synthetic direct approval', 'APPROVED', $3, $4, clock_timestamp(), 2)`,
        [world.legalEntityId, journalId, people.requester, people.manager]), "23514", /starts as REQUESTED/);

      // An independent manager decides.
      const approved = await decide(db, tokens.manager, request.request.id, 1, "APPROVED", null);
      assert.equal(approved.request.status, "APPROVED");
    });

    test("company isolation, forged tokens, missing permissions and runtimes that are not Finance", async () => {
      const { world, tokens, journals } = await prepare(harness, 1);
      const journalId = journals[0] ?? "";
      const mine = await create(db, tokens.requester, journalId, "Synthetic: request inside company one");

      // A second synthetic company, with its own requester and manager.
      const other = await seedSyntheticWorld(harness.executor, { withoutSandboxAuthorization: true });
      await harness.executor.query(
        "INSERT INTO abos.sandbox_legal_entity_scopes (legal_entity_id, base_currency_code, authorized_by_user_account_id) VALUES ($1, 'USD', $2)",
        [other.legalEntityId, world.bootstrapUserId]);
      const otherPerson = await addPerson(harness, "Synthetic Other Company Manager");
      await grant(harness, other, otherPerson, ["finance.reversal.request", "finance.reversal.approve"]);
      const otherToken = await session(harness, other, otherPerson);
      const otherView = await view(db, otherToken);
      assert.equal(otherView.legalEntity.id, other.legalEntityId);
      assert.deepEqual(otherView.requests, [], "another company's requests are invisible");
      assert.deepEqual(otherView.eligibleJournals, [], "another company's journals are invisible");
      await refused(create(db, otherToken, journalId, "Synthetic: cross-company attempt"), "P0002", /journal not found/);
      await refused(decide(db, otherToken, mine.request.id, 1, "APPROVED", null), "P0002", /not found/);
      await refused(withdraw(db, otherToken, mine.request.id, 1, null), "P0002", /not found/);
      await refused(harness.executor.query(
        `INSERT INTO abos.journal_reversal_requests (id, legal_entity_id, journal_id, reason, status, requested_by_user_account_id)
         VALUES (gen_random_uuid(), $1, $2, 'Synthetic cross-company insert', 'REQUESTED', $3)`, [other.legalEntityId, journalId, otherPerson]),
        "P0002", /journal not found/);

      // Forged, short and missing tokens; people without the permission.
      for (const token of ["z".repeat(43), "short", null]) {
        await refused(view(db, token as string), "42501", /session is invalid|bearer credential/);
        await refused(create(db, token as string, journalId, "Synthetic: forged token"), "42501", /session is invalid|bearer credential/);
        await refused(decide(db, token as string, mine.request.id, 1, "APPROVED", null), "42501", /session is invalid|bearer credential/);
      }
      await refused(view(db, tokens.outsider), "42501", /authority is missing/);
      await refused(create(db, tokens.outsider, journalId, "Synthetic: no permission"), "42501", /authority is missing/);
      const readerView = await view(db, tokens.reader);
      assert.equal(readerView.canRequest, false);
      assert.equal(readerView.canApprove, false);
      assert.equal(readerView.requests.length, 1, "a Finance reader sees requests");
      assert.deepEqual(readerView.eligibleJournals, []);
      await refused(create(db, tokens.reader, journalId, "Synthetic: reader cannot request"), "42501", /authority is missing/);
      await refused(decide(db, tokens.reader, mine.request.id, 1, "APPROVED", null), "42501", /authority is missing/);
      await refused(decide(db, tokens.requester, mine.request.id, 1, "APPROVED", null), "42501", /authority is missing/);
      await refused(withdraw(db, tokens.manager, mine.request.id, 1, null), "42501", /authority is missing/);

      // Treasury and identity runtimes cannot execute any reversal entry point.
      for (const kind of ["treasury", "identity"] as const) {
        for (const call of [
          "SELECT abos.finance_reversal_requests_view($1)",
          "SELECT abos.finance_reversal_request_create($1, gen_random_uuid(), 'Synthetic runtime attempt')",
          "SELECT abos.finance_reversal_request_decide($1, gen_random_uuid(), 1, 'APPROVED', NULL)",
          "SELECT abos.finance_reversal_request_withdraw($1, gen_random_uuid(), 1, NULL)"
        ]) {
          await refused(restricted(kind, (runtime) => runtime.query(call, [tokens.manager])), "42501", /permission denied for function/);
        }
        await refused(restricted(kind, (runtime) => runtime.query("SELECT * FROM abos.journal_reversal_requests")), "42501", /permission denied for table/);
      }

      // The Finance runtime reaches nothing but its entry points.
      for (const sql of [
        "SELECT * FROM abos.journal_reversal_requests",
        "INSERT INTO abos.journal_reversal_requests (id) VALUES (gen_random_uuid())",
        "UPDATE abos.journal_reversal_requests SET status = 'APPROVED'",
        "DELETE FROM abos.journal_reversal_requests",
        "INSERT INTO abos.journal_reversal_links (original_journal_id) VALUES (gen_random_uuid())"
      ]) await refused(db.query(sql), "42501", /permission denied for table/);
      for (const sql of [
        "SELECT abos.reversal_journal_participants(gen_random_uuid())",
        "SELECT abos.reversal_journal_in_scope(gen_random_uuid(), gen_random_uuid(), gen_random_uuid())",
        "SELECT abos.reversal_journal_blocker(gen_random_uuid(), gen_random_uuid())",
        "SELECT abos.reversal_journal_json(gen_random_uuid(), NULL)",
        "SELECT abos.reversal_request_json(gen_random_uuid(), NULL)"
      ]) await refused(db.query(sql), "42501", /permission denied for function/);

      // The Finance owner changes requests only through the guarded columns, cannot delete them and
      // cannot create a reversal link; the Treasury owner cannot even read them.
      await asOwner(harness, "abos_e1_finance_owner", async (client) => {
        await refused(client.query("UPDATE abos.journal_reversal_requests SET reason = 'Synthetic rewrite' WHERE id = $1", [mine.request.id]), "42501", /permission denied/);
      });
      await asOwner(harness, "abos_e1_finance_owner", async (client) => {
        await refused(client.query("DELETE FROM abos.journal_reversal_requests"), "42501", /permission denied/);
      });
      await asOwner(harness, "abos_e1_finance_owner", async (client) => {
        await refused(client.query(`INSERT INTO abos.journal_reversal_links (original_journal_id, reversal_journal_id, reason, approved_by_user_account_id, evidence_reference_id)
          VALUES ($1, $1, 'x', $2, $3)`, [journalId, world.approverId, world.reversalEvidenceId]), "42501", /permission denied/);
      });
      await asOwner(harness, "abos_e1_finance_owner", async (client) => {
        await refused(client.query(`UPDATE abos.journal_reversal_requests SET status = 'APPROVED', decided_by_user_account_id = requested_by_user_account_id,
          decided_at = clock_timestamp(), version = version + 1 WHERE id = $1`, [mine.request.id]), "ABR01", /cannot decide it/);
      });
      await asOwner(harness, "abos_e1_treasury_owner", async (client) => {
        await refused(client.query("SELECT * FROM abos.journal_reversal_requests"), "42501", /permission denied/);
      });
      const unchanged = (await view(db, tokens.reader)).requests[0];
      assert.equal(unchanged?.status, "REQUESTED");
      assert.equal(unchanged?.reason, "Synthetic: request inside company one");
    });

    test("project, department and cost-center scope applies to the list, requests and decisions", async () => {
      const { world, people, tokens, journals } = await prepare(harness, 2);
      const [plain = "", scoped = ""] = journals;
      const request = await create(db, tokens.requester, scoped, "Synthetic: scoped journal to reverse");
      const dimensions = await dimensionJournal(harness, world, scoped);

      // Without every scope the journal, its request and every action on it are "not found".
      const requesterView = await view(db, tokens.requester);
      assert.deepEqual(requesterView.requests, []);
      assert.deepEqual(requesterView.eligibleJournals.map((journal) => journal.id), [plain]);
      await refused(withdraw(db, tokens.requester, request.request.id, 1, null), "P0002", /not found/);
      await refused(decide(db, tokens.manager, request.request.id, 1, "APPROVED", null), "P0002", /not found/);
      assert.deepEqual((await view(db, tokens.manager)).requests, []);

      // All three live scopes reveal it; revoking one hides it again at once.
      for (const [kind, scopeId] of dimensions) await scope(harness, world, people.manager, kind, scopeId);
      assert.equal((await view(db, tokens.manager)).requests[0]?.id, request.request.id);
      await harness.executor.query(
        "UPDATE abos.user_scope_grants SET revoked_at = clock_timestamp() WHERE user_account_id = $1 AND scope_kind = 'COST_CENTER'", [people.manager]);
      assert.deepEqual((await view(db, tokens.manager)).requests, []);
      await refused(decide(db, tokens.manager, request.request.id, 1, "APPROVED", null), "P0002", /not found/);
      await harness.executor.query(
        "UPDATE abos.user_scope_grants SET revoked_at = NULL WHERE user_account_id = $1 AND scope_kind = 'COST_CENTER'", [people.manager]);
      const approved = await decide(db, tokens.manager, request.request.id, 1, "APPROVED", null);
      assert.equal(approved.request.status, "APPROVED");

      // A requester without scope cannot open a request on a dimensioned journal either.
      await dimensionJournal(harness, world, plain);
      await refused(create(db, tokens.requester, plain, "Synthetic: outside my scope"), "P0002", /journal not found/);
      assert.deepEqual((await view(db, tokens.requester)).eligibleJournals, []);
    });

    test("concurrency: a double decision and a double request each settle to exactly one outcome", async () => {
      const { tokens, journals } = await prepare(harness, 2);
      const [first = "", second = ""] = journals;

      // Two managers approve at the same moment: one wins, the other is told it is already approved.
      const request = await create(db, tokens.requester, first, "Synthetic: concurrent decision test");
      const race = await raceTwo(financePool,
        "SELECT abos.finance_reversal_request_decide($1, $2, 1, 'APPROVED', NULL) AS value", [tokens.manager, request.request.id],
        "SELECT abos.finance_reversal_request_decide($1, $2, 1, 'REJECTED', 'Synthetic late rejection') AS value", [tokens.secondManager, request.request.id]);
      assert.equal((race.first as { changed: boolean }).changed, true);
      assert.equal((race.second as { code?: string }).code, "ABR02");
      assert.match(String(race.second), /already approved/);
      // The same manager double-submitting gets the same result, not an error.
      const replay = await decide(db, tokens.manager, request.request.id, 1, "APPROVED", null);
      assert.equal(replay.changed, false);
      const decisions = await harness.executor.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM abos.audit_records WHERE entity_id = $1 AND action LIKE 'JOURNAL_REVERSAL_%'", [request.request.id]);
      assert.equal(decisions.rows[0]?.count, "2", "one request and one decision were recorded");

      // Two people request the same journal at the same moment: one request exists afterwards.
      const both = await raceTwo(financePool,
        "SELECT abos.finance_reversal_request_create($1, $2, 'Synthetic: first concurrent request') AS value", [tokens.requester, second],
        "SELECT abos.finance_reversal_request_create($1, $2, 'Synthetic: second concurrent request') AS value", [tokens.secondManager, second]);
      assert.equal((both.first as { created: boolean }).created, true);
      assert.equal((both.second as { code?: string }).code, "23505");
      const open = await harness.executor.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM abos.journal_reversal_requests WHERE journal_id = $1", [second]);
      assert.equal(open.rows[0]?.count, "1");
    });
  });
}

// -----------------------------------------------------------------------------------------------

async function prepare(harness: Harness, journalCount: number): Promise<{ world: SyntheticWorld; people: People; tokens: Tokens; journals: string[] }> {
  await resetSchema(harness.pool);
  await harness.executor.query(`GRANT abos_e1_runtime TO ${LOGINS.finance.name}`);
  await harness.executor.query(`GRANT abos_e1_treasury_runtime TO ${LOGINS.treasury.name}`);
  await harness.executor.query(`GRANT abos_v1_identity_runtime TO ${LOGINS.identity.name}`);
  const world = await seedSyntheticWorld(harness.executor);
  const journals: string[] = [];
  for (let index = 0; index < journalCount; index += 1) journals.push(await postJournal(harness, world, index));

  // People who took no part in any journal. The journal's preparer (intent creator) and its
  // approver/poster are the seeded Finance people.
  const people: People = {
    requester: await addPerson(harness, "Synthetic Reversal Requester"),
    manager: await addPerson(harness, "Synthetic Finance Manager"),
    secondManager: await addPerson(harness, "Synthetic Second Finance Manager"),
    reader: await addPerson(harness, "Synthetic Finance Reader")
  };
  await grant(harness, world, people.requester, ["finance.reversal.request", "finance.report.operational.read"]);
  await grant(harness, world, people.manager, ["finance.reversal.approve", "finance.report.operational.read"]);
  await grant(harness, world, people.secondManager, ["finance.reversal.approve", "finance.reversal.request"]);
  await grant(harness, world, people.reader, ["finance.report.operational.read"]);
  return {
    world, people, journals,
    tokens: {
      requester: await session(harness, world, people.requester), manager: await session(harness, world, people.manager),
      secondManager: await session(harness, world, people.secondManager), reader: await session(harness, world, people.reader),
      outsider: await session(harness, world, world.cashierId), preparer: await session(harness, world, world.intentCreatorId),
      poster: await session(harness, world, world.approverId)
    }
  };
}

/** One synthetic capital receipt, through Treasury, handed to Finance, approved and posted. */
async function postJournal(harness: Harness, world: SyntheticWorld, index: number): Promise<string> {
  const installmentId = index === 0 ? world.installmentId : await addInstallment(harness.executor, world, { sequenceNumber: index + 1, expectedAmount: world.installmentAmount });
  const service = new CapitalReceiptIntentService(new PostgresShareholderRepository(harness.executor, world.intentCreatorId as UserAccountId));
  const row = (await harness.executor.query<{ id: string; document_id: string; evidence_kind: EvidenceReference["kind"]; evidence_version: number; sha256: string; completed_at: Date | string }>(
    "SELECT id, document_id, evidence_kind, evidence_version, sha256, completed_at FROM abos.evidence_references WHERE id = $1",
    [world.agreementDocumentEvidenceId])).rows[0];
  assert.ok(row);
  const intent = await service.createCapitalReceiptIntent({
    legalEntityId: world.legalEntityId as LegalEntityId, shareholderPartyId: world.businessPartyId as never,
    agreementId: world.agreementId as CapitalAgreementId, installmentId: installmentId as CapitalInstallmentId,
    amount: { amount: asDecimalString(world.installmentAmount), currency: "USD" },
    expectedDestinationAccountId: world.cashAccountId as CashLocationCurrencyAccountId,
    businessEventAt: "2026-09-22T07:00:00.000Z",
    source: { legalEntityId: world.legalEntityId as LegalEntityId, idempotencyKey: `reversal-${randomUUID()}` as IdempotencyKey, correlationId: randomUUID() as CorrelationId },
    evidence: [{ id: row.id as never, documentId: row.document_id as never, kind: row.evidence_kind, version: row.evidence_version, sha256: row.sha256, completedAt: new Date(row.completed_at).toISOString() }]
  });
  const receipt = await recordSyntheticTreasuryReceipt(harness.executor, world, { capitalReceiptIntentId: intent.id, amount: world.installmentAmount });
  await handOffSyntheticReceipt(harness.executor, world, receipt.cashReceiptId);
  const postingIntentId = await recordCapitalPostingIntent(harness.executor, world, {
    capitalReceiptIntentId: intent.id, cashReceiptId: receipt.cashReceiptId, amount: world.installmentAmount,
    idempotencyKey: `reversal-post-${randomUUID()}`, correlationId: randomUUID()
  });
  return new RestrictedCapitalPostingGateway(harness.executor).post({
    bearerToken: await session(harness, world, world.approverId), postingIntentId: postingIntentId as PostingIntentId,
    accountingPeriodId: world.accountingPeriodId as never
  });
}

async function addPerson(harness: Harness, name: string): Promise<string> {
  const id = randomUUID();
  await harness.executor.query(
    "INSERT INTO abos.user_accounts (id, login_identifier, display_name, status) VALUES ($1, $2, $3, 'ACTIVE')",
    [id, `${name.toLowerCase().replace(/\s+/g, ".")}.${id.slice(0, 8)}@synthetic.invalid`, name]);
  return id;
}

async function personId(harness: Harness, name: string): Promise<string> {
  const row = (await harness.executor.query<{ id: string }>("SELECT id FROM abos.user_accounts WHERE display_name = $1", [name])).rows[0];
  assert.ok(row, name);
  return row.id;
}

async function grant(harness: Harness, world: SyntheticWorld, userId: string, permissions: readonly string[]): Promise<void> {
  for (const permission of permissions) {
    await harness.executor.query(
      `INSERT INTO abos.user_permission_grants (user_account_id, legal_entity_id, permission_code, granted_by_user_account_id)
       VALUES ($1, $2, $3, $4)`, [userId, world.legalEntityId, permission, world.bootstrapUserId]);
  }
}

async function scope(harness: Harness, world: SyntheticWorld, userId: string, kind: string, scopeId: string): Promise<void> {
  await harness.executor.query(
    `INSERT INTO abos.user_scope_grants (user_account_id, legal_entity_id, scope_kind, scope_id, granted_by_user_account_id)
     VALUES ($1, $2, $3, $4, $5)`, [userId, world.legalEntityId, kind, scopeId, world.bootstrapUserId]);
}

/**
 * Gives every line of a posted journal a project, department and cost center. Test-only: the
 * privileged fixture update bypasses the posted-line immutability trigger solely to exercise scope,
 * exactly as the General Ledger scope test does.
 */
async function dimensionJournal(harness: Harness, world: SyntheticWorld, journalId: string): Promise<(readonly [string, string])[]> {
  const suffix = randomUUID().slice(0, 6);
  const ids = { PROJECT: randomUUID(), DEPARTMENT: randomUUID(), COST_CENTER: randomUUID() };
  await harness.executor.query("INSERT INTO abos.projects (id, legal_entity_id, code, name, active) VALUES ($1, $2, $3, 'Synthetic Project', true)",
    [ids.PROJECT, world.legalEntityId, `SYN-P-${suffix}`]);
  await harness.executor.query("INSERT INTO abos.departments (id, legal_entity_id, code, name, active) VALUES ($1, $2, $3, 'Synthetic Department', true)",
    [ids.DEPARTMENT, world.legalEntityId, `SYN-D-${suffix}`]);
  await harness.executor.query("INSERT INTO abos.cost_centers (id, legal_entity_id, code, name, active) VALUES ($1, $2, $3, 'Synthetic Cost Center', true)",
    [ids.COST_CENTER, world.legalEntityId, `SYN-C-${suffix}`]);
  await harness.executor.transaction(async (tx) => {
    await tx.query("SET LOCAL session_replication_role = replica");
    await tx.query("UPDATE abos.journal_lines SET project_id = $2, department_id = $3, cost_center_id = $4 WHERE journal_id = $1",
      [journalId, ids.PROJECT, ids.DEPARTMENT, ids.COST_CENTER]);
  });
  return Object.entries(ids).map(([kind, id]) => [kind, id] as const);
}

/**
 * Everything a reversal posting would touch. It must be byte-for-byte the same before and after
 * the whole request/approval workflow.
 */
async function postingFootprint(harness: Harness, world: SyntheticWorld): Promise<unknown> {
  const result = await harness.executor.query<{ footprint: unknown }>(
    `SELECT jsonb_build_object(
       'journals', (SELECT jsonb_agg(to_jsonb(j) ORDER BY j.id) FROM abos.journals j),
       'journalLines', (SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id) FROM abos.journal_lines l),
       'reversalLinks', (SELECT count(*) FROM abos.journal_reversal_links),
       'postingIntents', (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM abos.posting_intents p),
       'postingApprovals', (SELECT count(*) FROM abos.posting_approvals),
       'subledgerEntries', (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM abos.subledger_entries s),
       'outboxEvents', (SELECT count(*) FROM abos.outbox_events),
       'idempotencyRecords', (SELECT count(*) FROM abos.idempotency_records),
       'capitalReceiptIntents', (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM abos.capital_receipt_intents c),
       'installments', (SELECT jsonb_agg(to_jsonb(i) ORDER BY i.id) FROM abos.capital_installments i),
       'commitmentUsage', (SELECT jsonb_agg(to_jsonb(u)) FROM abos.capital_agreement_commitment_usage u),
       'cashReceipts', (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM abos.cash_receipts r),
       'cashAccounts', (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM abos.cash_location_currency_accounts a WHERE a.legal_entity_id = $1)
     ) AS footprint`, [world.legalEntityId]);
  return result.rows[0]?.footprint;
}

async function session(harness: Harness, world: SyntheticWorld, userId: string): Promise<string> {
  const auth = new SandboxAuthenticator(harness.executor, SYNTHETIC_AUTH_CONFIGURATION);
  return (await auth.issueSession({ userAccountId: userId as UserAccountId, legalEntityId: world.legalEntityId as LegalEntityId })).token;
}

/** The promise is refused with the given SQLSTATE (when not empty) and a message matching the pattern. */
async function refused(promise: Promise<unknown>, sqlState: string, message: RegExp): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    const code = (error as { code?: string }).code;
    assert.match(String(error), message);
    if (sqlState !== "") assert.equal(code, sqlState, String(error));
    return true;
  });
}

async function one<T>(db: SqlExecutor, sql: string, parameters: readonly unknown[]): Promise<T> {
  const result = await db.query<{ value: T }>(sql, parameters);
  const value = result.rows[0]?.value;
  assert.ok(value !== undefined);
  return value;
}

function view(db: SqlExecutor, token: string): Promise<View> {
  return one(db, "SELECT abos.finance_reversal_requests_view($1) AS value", [token]);
}

function create(db: SqlExecutor, token: string, journalId: string, reason: string): Promise<{ request: Request; created: boolean }> {
  return one(db, "SELECT abos.finance_reversal_request_create($1, $2, $3) AS value", [token, journalId, reason]);
}

function decide(db: SqlExecutor, token: string, requestId: string, version: number, decision: string, note: string | null): Promise<{ request: Request; changed: boolean }> {
  return one(db, "SELECT abos.finance_reversal_request_decide($1, $2, $3, $4, $5) AS value", [token, requestId, version, decision, note]);
}

function withdraw(db: SqlExecutor, token: string, requestId: string, version: number, note: string | null): Promise<{ request: Request; changed: boolean }> {
  return one(db, "SELECT abos.finance_reversal_request_withdraw($1, $2, $3, $4) AS value", [token, requestId, version, note]);
}

/**
 * Runs two calls on separate connections so that the second starts while the first still holds its
 * locks, then commits the first. Returns the first call's value and the second call's value or error.
 */
async function raceTwo(pool: pg.Pool, firstSql: string, firstParameters: readonly unknown[], secondSql: string, secondParameters: readonly unknown[]):
Promise<{ first: unknown; second: unknown }> {
  const a = await pool.connect();
  const b = await pool.connect();
  try {
    await a.query("BEGIN");
    await a.query("SELECT set_config('abos.runtime_marker', $1, true)", [MARKER]);
    const first = (await a.query<{ value: unknown }>(firstSql, [...firstParameters])).rows[0]?.value;
    await b.query("BEGIN");
    await b.query("SELECT set_config('abos.runtime_marker', $1, true)", [MARKER]);
    const pending = b.query<{ value: unknown }>(secondSql, [...secondParameters]).then((result) => result.rows[0]?.value, (error: unknown) => error);
    // Give the second call time to reach the lock the first one holds.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const blocked = await a.query<{ waiting: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()) AS waiting");
    assert.equal(blocked.rows[0]?.waiting, true, "the second call waits for the first");
    await a.query("COMMIT");
    const second = await pending;
    await b.query(second instanceof Error ? "ROLLBACK" : "COMMIT");
    return { first, second };
  } finally {
    a.release();
    b.release();
  }
}

function loginUrl(kind: keyof typeof LOGINS): string {
  const url = new URL(databaseUrl() ?? "");
  url.username = LOGINS[kind].name; url.password = LOGINS[kind].password;
  return url.toString();
}

async function ensureLogin(harness: Harness, login: (typeof LOGINS)[keyof typeof LOGINS]): Promise<void> {
  const exists = await harness.executor.query<{ exists: boolean }>("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists", [login.name]);
  const verb = exists.rows[0]?.exists === true ? "ALTER" : "CREATE";
  const extra = verb === "CREATE" ? " NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION" : "";
  await harness.executor.query(`${verb} ROLE ${login.name} LOGIN INHERIT${extra} PASSWORD '${login.password}'`);
}

async function restricted<T>(kind: keyof typeof LOGINS, operation: (runtime: SqlExecutor) => Promise<T>): Promise<T> {
  const pool = new pg.Pool({ connectionString: loginUrl(kind), max: 1 });
  try {
    return await operation(new PostgresExecutor(pool, { runtimeMarker: MARKER }));
  } finally {
    await pool.end();
  }
}

/** Runs as an owner role inside a transaction that is always rolled back. */
async function asOwner(harness: Harness, role: string, work: (client: pg.PoolClient) => Promise<void>): Promise<void> {
  const client = await harness.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL ROLE ${role}`);
    await client.query("SELECT set_config('abos.runtime_marker', $1, true)", [MARKER]);
    await work(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}
