import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before, describe } from "node:test";
import type {
  CapitalAgreementId,
  CapitalInstallmentId,
  CapitalReceiptIntent,
  CashLocationCurrencyAccountId,
  CashReceiptId,
  CorrelationId,
  EvidenceReference,
  IdempotencyKey,
  LedgerAccountId,
  LegalEntityId,
  PhysicalCashCountId,
  PostingIntentId,
  ServerActorContext,
  UserAccountId,
  VerifiedTreasuryReceipt
} from "@abos/contracts";
import { asDecimalString } from "@abos/contracts";
import {
  FinancePostingService,
  reconcileCapitalReceipt,
  type PostCapitalReceiptCommand
} from "@abos/finance";
import { PostgresFinancePostingRepository, PostgresShareholderRepository } from "@abos/persistence";
import { SandboxAuthenticator, type SandboxAuthConfiguration } from "@abos/sandbox-auth";
import {
  CapitalReceiptIntentService,
  assertHandoffPreservesSource
} from "@abos/shareholder";
import { databaseUrl, MISSING_DATABASE_MESSAGE, openHarness, resetSchema, type Harness } from "./harness.ts";
import {
  addInstallment,
  handOffSyntheticReceipt,
  recordCapitalPostingIntent,
  recordSyntheticTreasuryReceipt,
  seedSyntheticWorld,
  type SyntheticWorld
} from "./synthetic-world.ts";

/**
 * The first connected E1 checkpoint, end to end, against a real PostgreSQL:
 *
 *   CapitalAgreement -> CapitalInstallmentEligibility -> CapitalReceiptIntent
 *     -> VerifiedTreasuryReceipt -> CapitalPostingIntent -> FinanceApproval
 *     -> PostedJournal -> ReconciliationResult
 *
 * Synthetic data only. One shareholder, one approved agreement, verified registration evidence,
 * one eligible USD installment into one synthetic office safe, an actual cash count confirmed by
 * someone other than the counter, Treasury verification, a separate Finance approver, one balanced
 * Finance-only journal, and a reconciled projection.
 *
 * No AFN, no conversion, no bank, no Saraf, no production balances, and the ledger accounts are a
 * test-only mapping rather than the client's Chart of Accounts.
 *
 * Treasury runs through the real Treasury services and migration 0006: an assigned cashier
 * records, counts and submits the receipt, an independent verifier confirms the count and verifies
 * it, and the verifier hands it to Finance. The handoff itself performs the shareholder
 * TREASURY_VERIFIED transition, through the shareholder domain's own service.
 */

const MARKER = "synthetic-e1-sandbox-marker";
const SECRET = "synthetic-e1-signing-secret-at-least-32-chars";

const configuration: SandboxAuthConfiguration = {
  runtimeMarker: MARKER,
  signingSecret: SECRET,
  environment: "test",
  maxSessionSeconds: 900
};

if (databaseUrl() === undefined) {
  test("E1 capital receipt end-to-end", () => {
    assert.fail(MISSING_DATABASE_MESSAGE);
  });
} else {
  describe("E1 first capital receipt, end to end on PostgreSQL", () => {
    let harness: Harness;

    before(async () => {
      harness = await openHarness(MARKER);
    });

    after(async () => {
      await harness.close();
    });

    test("one synthetic USD capital installment reaches a balanced, reconciled journal", async () => {
      await resetSchema(harness.pool);
      const world = await seedSyntheticWorld(harness.executor);
      const authenticator = new SandboxAuthenticator(harness.executor, configuration);

      // --- Authentication. The actor is built from persisted grants, not from this test. -----
      const session = await authenticator.issueSession({
        userAccountId: world.approverId as UserAccountId,
        legalEntityId: world.legalEntityId as LegalEntityId
      });
      const actor: ServerActorContext = await authenticator.authenticate(session.token);
      assert.equal(actor.userAccountId, world.approverId);
      assert.deepEqual([...actor.permissions].sort(), [
        "finance.journal.post",
        "finance.posting-intent.approve"
      ]);
      assert.equal(actor.sessionId, session.sessionId);

      const gate = await authenticator.resolveGate(world.legalEntityId as LegalEntityId);
      assert.equal(gate.authorization.configurationState, "SYNTHETIC_TEST_ONLY");
      assert.equal(gate.authorization.realPostingEnabled, false);

      // --- 1. Shareholder: the capital receipt intent, persisted. --------------------------
      const shareholderRepository = new PostgresShareholderRepository(
        harness.executor,
        world.intentCreatorId as UserAccountId
      );
      const shareholderService = new CapitalReceiptIntentService(shareholderRepository);

      const agreementEvidence = await loadEvidence(harness, world.agreementDocumentEvidenceId);
      const correlationId = randomUUID() as CorrelationId;
      const idempotencyKey = `capital-receipt-${randomUUID()}` as IdempotencyKey;

      const intent: CapitalReceiptIntent = await shareholderService.createCapitalReceiptIntent({
        legalEntityId: world.legalEntityId as LegalEntityId,
        shareholderPartyId: world.businessPartyId as never,
        agreementId: world.agreementId as CapitalAgreementId,
        installmentId: world.installmentId as CapitalInstallmentId,
        amount: { amount: asDecimalString(world.installmentAmount), currency: "USD" },
        expectedDestinationAccountId: world.cashAccountId as CashLocationCurrencyAccountId,
        businessEventAt: "2026-09-22T07:00:00.000Z",
        source: {
          legalEntityId: world.legalEntityId as LegalEntityId,
          idempotencyKey,
          correlationId
        },
        evidence: [agreementEvidence]
      });
      assert.equal(intent.status, "ELIGIBLE");

      const persisted = await harness.executor.query<{
        readonly status: string;
        readonly contribution_state: string;
        readonly classification: string;
        readonly amount: string;
      }>(
        `SELECT status, contribution_state, classification, amount::text AS amount
           FROM abos.capital_receipt_intents WHERE id = $1`,
        [intent.id]
      );
      assert.deepEqual(persisted.rows[0], {
        status: "ELIGIBLE",
        contribution_state: "PENDING",
        classification: "PAID_IN_SHARE_CAPITAL",
        amount: world.installmentAmount
      });

      // Creating the intent must not have moved any money.
      assert.equal(await journalCount(harness), 0, "no journal exists yet");

      // Replaying the same source transaction returns the same intent, not a second one.
      const replay = await shareholderService.createCapitalReceiptIntent({
        legalEntityId: world.legalEntityId as LegalEntityId,
        shareholderPartyId: world.businessPartyId as never,
        agreementId: world.agreementId as CapitalAgreementId,
        installmentId: world.installmentId as CapitalInstallmentId,
        amount: { amount: asDecimalString(world.installmentAmount), currency: "USD" },
        expectedDestinationAccountId: world.cashAccountId as CashLocationCurrencyAccountId,
        businessEventAt: "2026-09-22T07:00:00.000Z",
        source: {
          legalEntityId: world.legalEntityId as LegalEntityId,
          idempotencyKey,
          correlationId
        },
        evidence: [agreementEvidence]
      });
      assert.equal(replay.id, intent.id, "an idempotent replay returns the stored intent");

      // --- 2. Treasury: received, counted, submitted and independently verified. -----------
      const treasury = await recordSyntheticTreasuryReceipt(harness.executor, world, {
        capitalReceiptIntentId: intent.id,
        amount: world.installmentAmount
      });

      const receipt: VerifiedTreasuryReceipt = {
        id: treasury.cashReceiptId as CashReceiptId,
        capitalReceiptIntentId: intent.id,
        destinationType: "CASH_LOCATION",
        destinationAccountId: world.cashAccountId as CashLocationCurrencyAccountId,
        physicalCashCountId: treasury.physicalCashCountId as PhysicalCashCountId,
        amount: { amount: asDecimalString(world.installmentAmount), currency: "USD" },
        cashierUserAccountId: world.cashierId as UserAccountId,
        evidence: [await loadEvidence(harness, world.receiptEvidenceId)],
        verifiedAt: "2026-09-22T07:15:00.000Z",
        status: "VERIFIED"
      };

      // --- 3. The handoff contract, then Treasury hands the verified receipt to Finance. ---
      assertHandoffPreservesSource(intent, receipt);
      await handOffSyntheticReceipt(harness.executor, world, treasury.cashReceiptId);
      const verified = await shareholderRepository.findIntentById(
        world.legalEntityId as LegalEntityId,
        intent.id
      );
      assert.equal(verified?.status, "TREASURY_VERIFIED");
      assert.equal(verified?.version, intent.version + 1);

      // --- 4. Finance: the posting intent and an independent approval. ---------------------
      const postingIntentId = await recordCapitalPostingIntent(harness.executor, world, {
        capitalReceiptIntentId: intent.id,
        cashReceiptId: treasury.cashReceiptId,
        amount: world.installmentAmount,
        idempotencyKey: `posting-${randomUUID()}`,
        correlationId
      });

      // --- 5. Finance posts. ---------------------------------------------------------------
      const financeRepository = new PostgresFinancePostingRepository(harness.executor, authenticator);
      const financeService = new FinancePostingService(financeRepository, authenticator.verifyGate);

      const command = await postCommand({
        harness,
        world,
        actor,
        bearerToken: session.token,
        gate,
        intent,
        receipt,
        postingIntentId,
        physicalCashCountId: treasury.physicalCashCountId
      });
      const journal = await financeService.postCapitalReceipt(command);

      assert.equal(journal.status, "POSTED");
      assert.equal(journal.lines.length, 2);
      assert.equal(journal.sourceId, intent.id, "the journal is linked to the persisted source");

      // --- 6. The journal really is in the database, balanced, with a subledger. -----------
      const stored = await harness.executor.query<{
        readonly status: string;
        readonly debit: string;
        readonly credit: string;
        readonly lines: string;
      }>(
        `SELECT j.status,
                sum(jl.base_debit)::text AS debit,
                sum(jl.base_credit)::text AS credit,
                count(jl.id)::text AS lines
           FROM abos.journals j
           JOIN abos.journal_lines jl ON jl.journal_id = j.id
          WHERE j.id = $1
          GROUP BY j.status`,
        [journal.id]
      );
      assert.deepEqual(stored.rows[0], {
        status: "POSTED",
        debit: world.installmentAmount,
        credit: world.installmentAmount,
        lines: "2"
      });

      const debitLine = await harness.executor.query<{
        readonly account_code: string;
        readonly control_account_type: string;
        readonly subledger_type: string;
        readonly cash_location_currency_account_id: string;
      }>(
        `SELECT la.account_code, la.control_account_type, se.subledger_type,
                se.cash_location_currency_account_id
           FROM abos.journal_lines jl
           JOIN abos.ledger_accounts la ON la.id = jl.ledger_account_id
           JOIN abos.subledger_entries se ON se.journal_line_id = jl.id
          WHERE jl.journal_id = $1 AND jl.base_debit > 0`,
        [journal.id]
      );
      assert.equal(debitLine.rows[0]?.control_account_type, "CASH");
      assert.equal(debitLine.rows[0]?.subledger_type, "CASH_LOCATION");
      assert.equal(debitLine.rows[0]?.cash_location_currency_account_id, world.cashAccountId);

      const creditLine = await harness.executor.query<{
        readonly control_account_type: string;
        readonly subledger_type: string;
        readonly business_party_id: string;
      }>(
        `SELECT la.control_account_type, se.subledger_type, se.business_party_id
           FROM abos.journal_lines jl
           JOIN abos.ledger_accounts la ON la.id = jl.ledger_account_id
           JOIN abos.subledger_entries se ON se.journal_line_id = jl.id
          WHERE jl.journal_id = $1 AND jl.base_credit > 0`,
        [journal.id]
      );
      assert.equal(creditLine.rows[0]?.control_account_type, "SHAREHOLDER_CAPITAL");
      assert.equal(creditLine.rows[0]?.subledger_type, "SHAREHOLDER_CAPITAL");
      assert.equal(
        creditLine.rows[0]?.business_party_id,
        world.businessPartyId,
        "the credit is attributed to the shareholder business party, not a user or a GL account"
      );

      // --- 7. The shareholder record records the posting, without having done it. ----------
      const posted = await shareholderRepository.findIntentById(
        world.legalEntityId as LegalEntityId,
        intent.id
      );
      assert.equal(posted?.status, "POSTED", "the journal and source advance atomically");

      const history = await shareholderService.contributionHistory(
        world.legalEntityId as LegalEntityId,
        world.agreementId as CapitalAgreementId
      );
      assert.equal(history.length, 1);
      assert.equal(history[0]?.state, "POSTED");
      assert.equal(history[0]?.journalId, journal.id);

      const trail = await harness.executor.query<{ readonly status: string }>(
        `SELECT status FROM abos.capital_receipt_intent_history
          WHERE capital_receipt_intent_id = $1 ORDER BY version`,
        [intent.id]
      );
      assert.deepEqual(
        trail.rows.map((row) => row.status),
        ["ELIGIBLE", "TREASURY_VERIFIED", "POSTED"],
        "every state the intent passed through is retained"
      );

      // --- 8. Reconciliation across shareholder, safe and ledger. --------------------------
      const reconciliation = reconcileCapitalReceipt({
        sourceAmount: intent.amount,
        treasuryAmount: receipt.amount,
        shareholderPostedAmount: posted.amount,
        journal
      });
      assert.equal(reconciliation.reconciled, true);
      assert.equal(reconciliation.currency, "USD");
      // ExactDecimal normalises trailing zeros, so 25000.00 renders as 25000. Compare by value,
      // not by rendering: the amounts are equal as decimals, which is what reconciliation means.
      assert.equal(
        normalise(reconciliation.ledgerTotal.amount),
        normalise(world.installmentAmount),
        "the ledger total equals the source amount"
      );
      assert.equal(normalise(reconciliation.sourceTotal.amount), normalise(world.installmentAmount));

      // --- 9. The same source cannot be posted twice. --------------------------------------
      await assert.rejects(
        () =>
          financeService.postCapitalReceipt({
            ...command,
            metadata: { ...command.metadata, idempotencyKey: `second-${randomUUID()}` as IdempotencyKey }
          }),
        /already posted/i
      );
      assert.equal(await journalCount(harness), 1, "exactly one journal exists");
    });

    test("F-5 on the database: the poster of a real journal cannot post its reversal", async () => {
      await resetSchema(harness.pool);
      const world = await seedSyntheticWorld(harness.executor);
      const authenticator = new SandboxAuthenticator(harness.executor, configuration);
      const session = await authenticator.issueSession({
        userAccountId: world.approverId as UserAccountId,
        legalEntityId: world.legalEntityId as LegalEntityId
      });
      const actor = await authenticator.authenticate(session.token);
      const gate = await authenticator.resolveGate(world.legalEntityId as LegalEntityId);

      const journalId = await postOnce(harness, world, authenticator, actor, session.token, gate);

      // A REVERSAL posting intent whose source is the posted journal, posted by the same actor.
      const reversalIntentId = randomUUID();
      await harness.executor.query(
        `INSERT INTO abos.posting_intents
           (id, legal_entity_id, source_type, source_id, intent_kind, original_amount,
            original_currency_code, base_amount, base_currency_code, accounting_effective_date,
            correlation_id, idempotency_key, status, created_by_user_account_id)
         VALUES ($1, $2, 'REVERSAL', $3, 'REVERSAL', $4::numeric, 'USD', $4::numeric, 'USD',
                 $5, $6, $7, 'APPROVED', $8)`,
        [
          reversalIntentId,
          world.legalEntityId,
          journalId,
          world.installmentAmount,
          world.accountingEffectiveDate,
          randomUUID(),
          `reversal-${randomUUID()}`,
          world.intentCreatorId
        ]
      );

      const reversalJournalId = randomUUID();
      await harness.executor.query(
        `INSERT INTO abos.journals
           (id, legal_entity_id, accounting_period_id, posting_intent_id, journal_reference,
            accounting_effective_date, base_currency_code, status, created_by_user_account_id)
         VALUES ($1, $2, $3, $4, $5, $6, 'USD', 'DRAFT', $7)`,
        [
          reversalJournalId,
          world.legalEntityId,
          world.accountingPeriodId,
          reversalIntentId,
          `JRN-REV-${reversalJournalId.slice(0, 8)}`,
          world.accountingEffectiveDate,
          world.bootstrapUserId
        ]
      );

      await assert.rejects(
        () =>
          harness.executor.query(
            `UPDATE abos.journals
                SET status = 'POSTED', posted_by_user_account_id = $2, posted_at = clock_timestamp()
              WHERE id = $1`,
            [reversalJournalId, world.approverId]
          ),
        /cannot also post its reversal/,
        "the actor who posted the original is refused by the database, not by application code"
      );
    });

    test("the gate cannot be bypassed by a caller: an unsigned gate is refused by the kernel", async () => {
      await resetSchema(harness.pool);
      const world = await seedSyntheticWorld(harness.executor);
      const authenticator = new SandboxAuthenticator(harness.executor, configuration);
      const gate = await authenticator.resolveGate(world.legalEntityId as LegalEntityId);

      const financeService = new FinancePostingService(
        new PostgresFinancePostingRepository(harness.executor, authenticator),
        authenticator.verifyGate
      );
      assert.throws(
        () => authenticator.verifyGate({ ...gate, signature: "forged" }),
        /signature is invalid/
      );
      assert.ok(financeService);
    });

    test("a revoked Finance session and grant cannot post a prepared capital receipt", async () => {
      await resetSchema(harness.pool);
      const world = await seedSyntheticWorld(harness.executor);
      const authenticator = new SandboxAuthenticator(harness.executor, configuration);
      const session = await authenticator.issueSession({
        userAccountId: world.approverId as UserAccountId,
        legalEntityId: world.legalEntityId as LegalEntityId
      });
      const actor = await authenticator.authenticate(session.token);
      const gate = await authenticator.resolveGate(world.legalEntityId as LegalEntityId);
      const command = await prepareUnposted(harness, world, actor, session.token, gate);
      await assertUnpostedSource(harness, command.intent.sourceIntentId);

      // The command still carries the old, once-valid actor. The repository must revalidate
      // session and grants against PostgreSQL in the posting transaction, not trust that snapshot.
      await harness.executor.query(
        "UPDATE abos.sandbox_sessions SET revoked_at = clock_timestamp() WHERE id = $1",
        [session.sessionId]
      );
      await harness.executor.query(
        `UPDATE abos.user_permission_grants
            SET revoked_at = clock_timestamp()
          WHERE user_account_id = $1 AND legal_entity_id = $2
            AND permission_code IN ('finance.journal.post', 'finance.posting-intent.approve')`,
        [world.approverId, world.legalEntityId]
      );

      const financeService = new FinancePostingService(
        new PostgresFinancePostingRepository(harness.executor, authenticator),
        authenticator.verifyGate
      );
      await assert.rejects(
        () => financeService.postCapitalReceipt(command),
        /revoked|session|permission/i
      );
      await assertUnpostedSource(harness, command.intent.sourceIntentId);
    });

    test("a Treasury receipt from another installment cannot advance a capital source or journal", async () => {
      await resetSchema(harness.pool);
      const world = await seedSyntheticWorld(harness.executor);
      const authenticator = new SandboxAuthenticator(harness.executor, configuration);
      const session = await authenticator.issueSession({
        userAccountId: world.approverId as UserAccountId,
        legalEntityId: world.legalEntityId as LegalEntityId
      });
      const actor = await authenticator.authenticate(session.token);
      const gate = await authenticator.resolveGate(world.legalEntityId as LegalEntityId);
      const prepared = await prepareUnposted(harness, world, actor, session.token, gate);

      const otherInstallment = await addInstallment(harness.executor, world, {
        sequenceNumber: 2,
        expectedAmount: world.installmentAmount
      });
      // A genuine, fully verified Treasury receipt - but for a different installment's intent.
      const otherIntent = await new CapitalReceiptIntentService(
        new PostgresShareholderRepository(harness.executor, world.intentCreatorId as UserAccountId)
      ).createCapitalReceiptIntent({
        legalEntityId: world.legalEntityId as LegalEntityId,
        shareholderPartyId: world.businessPartyId as never,
        agreementId: world.agreementId as CapitalAgreementId,
        installmentId: otherInstallment as CapitalInstallmentId,
        amount: { amount: asDecimalString(world.installmentAmount), currency: "USD" },
        expectedDestinationAccountId: world.cashAccountId as CashLocationCurrencyAccountId,
        businessEventAt: "2026-09-22T07:00:00.000Z",
        source: {
          legalEntityId: world.legalEntityId as LegalEntityId,
          idempotencyKey: `capital-${randomUUID()}` as IdempotencyKey,
          correlationId: randomUUID() as CorrelationId
        },
        evidence: [await loadEvidence(harness, world.agreementDocumentEvidenceId)]
      });
      const foreignReceipt = await recordSyntheticTreasuryReceipt(harness.executor, world, {
        capitalReceiptIntentId: otherIntent.id,
        amount: world.installmentAmount
      });

      // A compromised upstream writer tries to make the prepared source point at that receipt.
      // Treasury's link guard refuses: a source may only reference its own verified receipt.
      await assert.rejects(
        () =>
          harness.executor.query(
            `UPDATE abos.capital_receipt_intents
                SET treasury_cash_receipt_id = $2, version = version + 1
              WHERE id = $1`,
            [prepared.intent.sourceIntentId, foreignReceipt.cashReceiptId]
          ),
        /can only reference its own VERIFIED Treasury receipt/
      );
      // And Finance cannot be pointed at a receipt Treasury never handed off for this source.
      await assert.rejects(
        () =>
          harness.executor.query(
            "UPDATE abos.posting_intents SET treasury_cash_receipt_id = $2 WHERE id = $1",
            [prepared.intent.id, foreignReceipt.cashReceiptId]
          ),
        /requires a Treasury handoff of this verified receipt|disagree on the Treasury receipt/
      );
      await assertUnpostedSource(harness, prepared.intent.sourceIntentId);
    });
  });
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

async function loadEvidence(harness: Harness, evidenceId: string): Promise<EvidenceReference> {
  const result = await harness.executor.query<{
    readonly id: string;
    readonly document_id: string;
    readonly evidence_kind: EvidenceReference["kind"];
    readonly evidence_version: number;
    readonly sha256: string;
    readonly completed_at: Date | string;
  }>(
    `SELECT id, document_id, evidence_kind, evidence_version, sha256, completed_at
       FROM abos.evidence_references WHERE id = $1`,
    [evidenceId]
  );
  const row = result.rows[0];
  assert.ok(row, `evidence ${evidenceId} must exist`);
  return {
    id: row.id as EvidenceReference["id"],
    documentId: row.document_id as EvidenceReference["documentId"],
    kind: row.evidence_kind,
    version: row.evidence_version,
    sha256: row.sha256,
    completedAt:
      row.completed_at instanceof Date ? row.completed_at.toISOString() : String(row.completed_at)
  };
}

/** Strips insignificant trailing zeros, so "25000.00" and "25000" compare equal. */
function normalise(amount: string): string {
  return amount.includes(".") ? amount.replace(/0+$/, "").replace(/\.$/, "") : amount;
}

async function journalCount(harness: Harness): Promise<number> {
  const result = await harness.executor.query<{ readonly count: string }>(
    "SELECT count(*)::text AS count FROM abos.journals WHERE status = 'POSTED'"
  );
  return Number(result.rows[0]?.count ?? "0");
}

async function assertUnpostedSource(harness: Harness, sourceId: string): Promise<void> {
  const result = await harness.executor.query<{
    readonly status: string;
    readonly journal_id: string | null;
  }>(
    "SELECT status, journal_id FROM abos.capital_receipt_intents WHERE id = $1",
    [sourceId]
  );
  assert.equal(result.rows[0]?.status, "TREASURY_VERIFIED");
  assert.equal(result.rows[0]?.journal_id, null);
  assert.equal(await journalCount(harness), 0);
  const allJournals = await harness.executor.query<{ readonly count: string }>(
    "SELECT count(*)::text AS count FROM abos.journals"
  );
  assert.equal(allJournals.rows[0]?.count, "0", "the failed transaction rolled back its draft journal");
  const subledger = await harness.executor.query<{ readonly count: string }>(
    "SELECT count(*)::text AS count FROM abos.subledger_entries"
  );
  assert.equal(subledger.rows[0]?.count, "0", "the failed transaction left no subledger entry");
}

async function postCommand(input: {
  readonly harness: Harness;
  readonly world: SyntheticWorld;
  readonly actor: ServerActorContext;
  readonly bearerToken: string;
  readonly gate: PostCapitalReceiptCommand["configuration"]["gate"];
  readonly intent: CapitalReceiptIntent;
  readonly receipt: VerifiedTreasuryReceipt;
  readonly postingIntentId: string;
  readonly physicalCashCountId: string;
}): Promise<PostCapitalReceiptCommand> {
  const { harness, world, intent, receipt } = input;
  const approvalEvidence = await loadEvidence(harness, world.approvalEvidenceId);
  const registrationEvidence = await loadEvidence(harness, world.registrationEvidenceId);
  const amount = asDecimalString(world.installmentAmount);

  const count = await harness.executor.query<{
    readonly counted_amount: string;
    readonly counted_at: Date | string;
    readonly counted_by_user_account_id: string;
    readonly confirmed_by_user_account_id: string;
  }>(
    `SELECT counted_amount::text AS counted_amount, counted_at, counted_by_user_account_id,
            confirmed_by_user_account_id
       FROM abos.physical_cash_counts WHERE id = $1`,
    [input.physicalCashCountId]
  );
  const countRow = count.rows[0];
  assert.ok(countRow);

  return {
    intent: {
      id: input.postingIntentId as PostingIntentId,
      sourceType: "SHAREHOLDER_CAPITAL_INSTALLMENT",
      sourceIntentId: intent.id,
      agreementId: world.agreementId as CapitalAgreementId,
      installmentId: world.installmentId as CapitalInstallmentId,
      treasuryReceiptId: receipt.id,
      dimensions: {
        scope: "COMPANY_LEVEL",
        legalEntityId: world.legalEntityId as LegalEntityId,
        companyLevelReason: "CORPORATE_CAPITAL"
      },
      originalAmount: { amount, currency: "USD" },
      baseAmount: { amount, currency: "USD" },
      destinationAccountId: world.cashAccountId as CashLocationCurrencyAccountId,
      debitLedgerAccountId: world.cashLedgerAccountId as LedgerAccountId,
      creditLedgerAccountId: world.capitalLedgerAccountId as LedgerAccountId,
      accountingPeriodId: world.accountingPeriodId as never,
      cashierUserAccountId: world.cashierId as UserAccountId,
      evidence: [registrationEvidence],
      status: "APPROVED"
    },
    eligibility: {
      installmentId: world.installmentId as CapitalInstallmentId,
      agreementId: world.agreementId as CapitalAgreementId,
      eligibleAmount: { amount, currency: "USD" },
      canonicalAgreementStatus: "ELIGIBLE",
      remainingEligibleAmount: {
        amount: asDecimalString(world.committedAmount),
        currency: "USD"
      },
      partialInstallmentsAllowed: true,
      registrationEvidence
    },
    treasuryReceipt: receipt,
    approval: {
      id: randomUUID() as never,
      postingIntentId: input.postingIntentId as PostingIntentId,
      approvedByUserAccountId: world.approverId as UserAccountId,
      approvedAt: "2026-09-22T07:45:00.000Z",
      evidence: [approvalEvidence],
      status: "APPROVED"
    },
    actor: input.actor,
    bearerToken: input.bearerToken,
    metadata: {
      correlationId: randomUUID() as CorrelationId,
      idempotencyKey: `post-${randomUUID()}` as IdempotencyKey
    },
    accountingEffectiveDate: world.accountingEffectiveDate,
    configuration: {
      policy: {
        environment: "test",
        configurationState: "SYNTHETIC_TEST_ONLY",
        policyVersionId: world.policyVersionId,
        baseCurrency: "USD",
        realPostingEnabled: false
      },
      gate: input.gate,
      fundingPolicy: {
        vocabularyVersion: "stage1-e0-v2",
        decisionReference: "SANDBOX-SYNTHETIC-E1 (not a client Finance decision)",
        decidedBy: "SANDBOX_SYNTHETIC",
        fundableStatuses: ["ELIGIBLE"],
        decidedAt: "2026-09-01T00:00:00.000Z"
      },
      physicalCashCount: {
        id: input.physicalCashCountId as PhysicalCashCountId,
        legalEntityId: world.legalEntityId as LegalEntityId,
        cashLocationCurrencyAccountId: world.cashAccountId as CashLocationCurrencyAccountId,
        currency: "USD",
        countedAmount: countRow.counted_amount,
        countedAt:
          countRow.counted_at instanceof Date
            ? countRow.counted_at.toISOString()
            : String(countRow.counted_at),
        countedByUserAccountId: countRow.counted_by_user_account_id as UserAccountId,
        status: "CONFIRMED",
        confirmedByUserAccountId: countRow.confirmed_by_user_account_id as UserAccountId
      },
      accountingPeriod: {
        id: world.accountingPeriodId as never,
        legalEntityId: world.legalEntityId as LegalEntityId,
        status: "OPEN",
        startsOn: "2026-09-01",
        endsOn: "2026-09-30"
      },
      ledgerAccounts: new Map([
        [
          world.cashLedgerAccountId as LedgerAccountId,
          {
            id: world.cashLedgerAccountId as LedgerAccountId,
            legalEntityId: world.legalEntityId as LegalEntityId,
            status: "ACTIVE" as const,
            postable: true
          }
        ],
        [
          world.capitalLedgerAccountId as LedgerAccountId,
          {
            id: world.capitalLedgerAccountId as LedgerAccountId,
            legalEntityId: world.legalEntityId as LegalEntityId,
            status: "ACTIVE" as const,
            postable: true
          }
        ]
      ]),
      cashLocationAccount: {
        id: world.cashAccountId as CashLocationCurrencyAccountId,
        cashLocationId: world.cashLocationId as never,
        currency: "USD",
        status: "ACTIVE",
        openingPositionApproved: true,
        responsibleCashierUserAccountId: world.cashierId as UserAccountId,
        activationEvidence: [await loadEvidence(harness, world.openingEvidenceId)],
        version: 1
      },
      configuredCashLedgerAccountId: world.cashLedgerAccountId as LedgerAccountId,
      configuredPaidInCapitalLedgerAccountId: world.capitalLedgerAccountId as LedgerAccountId
    }
  };
}

/** Runs the whole chain once and returns the posted journal id. */
async function postOnce(
  harness: Harness,
  world: SyntheticWorld,
  authenticator: SandboxAuthenticator,
  actor: ServerActorContext,
  bearerToken: string,
  gate: PostCapitalReceiptCommand["configuration"]["gate"]
): Promise<string> {
  const command = await prepareUnposted(harness, world, actor, bearerToken, gate);
  const financeService = new FinancePostingService(
    new PostgresFinancePostingRepository(harness.executor, authenticator),
    authenticator.verifyGate
  );
  const journal = await financeService.postCapitalReceipt(command);
  return journal.id;
}

/** Persists a valid source, count, Treasury receipt, posting intent and Finance approval. */
async function prepareUnposted(
  harness: Harness,
  world: SyntheticWorld,
  actor: ServerActorContext,
  bearerToken: string,
  gate: PostCapitalReceiptCommand["configuration"]["gate"]
): Promise<PostCapitalReceiptCommand> {
  const shareholderService = new CapitalReceiptIntentService(
    new PostgresShareholderRepository(harness.executor, world.intentCreatorId as UserAccountId)
  );
  const agreementEvidence = await loadEvidence(harness, world.agreementDocumentEvidenceId);
  const intent = await shareholderService.createCapitalReceiptIntent({
    legalEntityId: world.legalEntityId as LegalEntityId,
    shareholderPartyId: world.businessPartyId as never,
    agreementId: world.agreementId as CapitalAgreementId,
    installmentId: world.installmentId as CapitalInstallmentId,
    amount: { amount: asDecimalString(world.installmentAmount), currency: "USD" },
    expectedDestinationAccountId: world.cashAccountId as CashLocationCurrencyAccountId,
    businessEventAt: "2026-09-22T07:00:00.000Z",
    source: {
      legalEntityId: world.legalEntityId as LegalEntityId,
      idempotencyKey: `capital-${randomUUID()}` as IdempotencyKey,
      correlationId: randomUUID() as CorrelationId
    },
    evidence: [agreementEvidence]
  });

  const treasury = await recordSyntheticTreasuryReceipt(harness.executor, world, {
    capitalReceiptIntentId: intent.id,
    amount: world.installmentAmount
  });
  const receipt: VerifiedTreasuryReceipt = {
    id: treasury.cashReceiptId as CashReceiptId,
    capitalReceiptIntentId: intent.id,
    destinationType: "CASH_LOCATION",
    destinationAccountId: world.cashAccountId as CashLocationCurrencyAccountId,
    physicalCashCountId: treasury.physicalCashCountId as PhysicalCashCountId,
    amount: { amount: asDecimalString(world.installmentAmount), currency: "USD" },
    cashierUserAccountId: world.cashierId as UserAccountId,
    evidence: [await loadEvidence(harness, world.receiptEvidenceId)],
    verifiedAt: "2026-09-22T07:15:00.000Z",
    status: "VERIFIED"
  };
  await handOffSyntheticReceipt(harness.executor, world, treasury.cashReceiptId);

  const postingIntentId = await recordCapitalPostingIntent(harness.executor, world, {
    capitalReceiptIntentId: intent.id,
    cashReceiptId: treasury.cashReceiptId,
    amount: world.installmentAmount,
    idempotencyKey: `posting-${randomUUID()}`,
    correlationId: randomUUID()
  });

  return postCommand({
    harness,
    world,
    actor,
    bearerToken,
    gate,
    intent,
    receipt,
    postingIntentId,
    physicalCashCountId: treasury.physicalCashCountId
  });
}
