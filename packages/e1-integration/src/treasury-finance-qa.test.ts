import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before, describe } from "node:test";
import pg from "pg";
import type {
  CapitalAgreementId,
  CapitalInstallmentId,
  CapitalReceiptIntentId,
  CashLocationCurrencyAccountId,
  CashReceiptId,
  CorrelationId,
  EvidenceReference,
  IdempotencyKey,
  LegalEntityId,
  PostingIntentId,
  UserAccountId
} from "@abos/contracts";
import { asDecimalString } from "@abos/contracts";
import type { SqlExecutor } from "@abos/database";
import {
  PostgresShareholderRepository,
  PostgresTreasuryRepository,
  RestrictedCapitalPostingGateway
} from "@abos/persistence";
import { SandboxAuthenticator } from "@abos/sandbox-auth";
import { CapitalReceiptIntentService } from "@abos/shareholder";
import { receiptStage, TreasuryDomainError } from "@abos/treasury";
import { databaseUrl, MISSING_DATABASE_MESSAGE, openHarness, resetSchema, type Harness } from "./harness.ts";
import {
  bindExistingSyntheticTreasuryEvidence,
  recordCapitalPostingIntent,
  seedSyntheticWorld,
  SYNTHETIC_AUTH_CONFIGURATION,
  treasuryAs,
  type SyntheticWorld
} from "./synthetic-world.ts";

/**
 * Independent Treasury -> Finance integration QA (Claude).
 *
 * Real Shareholder and Treasury services write the source and custody rows; Finance posts only
 * through Codex's restricted runtime login and `abos.post_synthetic_capital_receipt`, never through
 * an owner connection. Everything is synthetic.
 *
 * The independent review's R-1, R-2 and R-3 regression cases remain executable here after the
 * controlled Treasury and Finance migrations close them.
 */

const MARKER = SYNTHETIC_AUTH_CONFIGURATION.runtimeMarker;
const RUNTIME_LOGIN = "abos_e1_runtime_test_login";
const RUNTIME_PASSWORD = "synthetic-runtime-only-password-2026";

if (databaseUrl() === undefined) {
  test("E1 Treasury -> Finance integration QA", () => assert.fail(MISSING_DATABASE_MESSAGE));
} else {
  describe("E1 Treasury -> Finance integration QA (restricted posting)", () => {
    let harness: Harness;
    before(async () => { harness = await openHarness(MARKER); });
    after(async () => { await harness.close(); });

    test("an eligible USD installment passes real Treasury and restricted Finance posting, preserving every identifier", async () => {
      const { world, intentId, receiptId, countId } = await verifiedAndHandedOff(harness);
      const postingIntentId = await recordCapitalPostingIntent(harness.executor, world, {
        capitalReceiptIntentId: intentId, cashReceiptId: receiptId, amount: world.installmentAmount,
        idempotencyKey: `qa-${randomUUID()}`, correlationId: randomUUID()
      });
      const financeToken = await sessionFor(harness, world, world.approverId);

      // Before posting, Treasury shows the receipt as handed off - not approved, not posted.
      assert.equal(await stageOf(harness, world, receiptId), "HANDED_TO_FINANCE");

      const journalId = await asRestricted((db) => new RestrictedCapitalPostingGateway(db).post({
        bearerToken: financeToken, postingIntentId: postingIntentId as PostingIntentId,
        accountingPeriodId: world.accountingPeriodId as never
      }));

      // Treasury now derives POSTED_BY_FINANCE from the persisted source, not from any claim.
      assert.equal(await stageOf(harness, world, receiptId), "POSTED_BY_FINANCE");

      const row = await harness.executor.query<Record<string, string>>(
        `SELECT j.status AS journal_status, cri.status AS source_status,
                cri.shareholder_business_party_id AS party, cri.capital_agreement_id AS agreement,
                cri.capital_installment_id AS installment, cri.treasury_cash_receipt_id AS receipt,
                cr.physical_cash_count_id AS count, cr.cash_location_currency_account_id AS destination,
                cr.amount::text AS receipt_amount, cr.currency_code AS currency,
                cr.received_by_user_account_id AS cashier, cr.verified_by_user_account_id AS verifier,
                h.handed_off_by_user_account_id AS handed_off_by,
                (SELECT sum(base_debit)::text FROM abos.journal_lines WHERE journal_id = j.id) AS debit,
                (SELECT sum(base_credit)::text FROM abos.journal_lines WHERE journal_id = j.id) AS credit,
                (SELECT jl.business_party_id::text FROM abos.journal_lines jl
                  WHERE jl.journal_id = j.id AND jl.base_credit > 0) AS credited_party,
                (SELECT se.cash_location_currency_account_id::text FROM abos.subledger_entries se
                   JOIN abos.journal_lines jl ON jl.id = se.journal_line_id
                  WHERE jl.journal_id = j.id AND se.subledger_type = 'CASH_LOCATION') AS cash_subledger
           FROM abos.journals j
           JOIN abos.capital_receipt_intents cri ON cri.journal_id = j.id
           JOIN abos.cash_receipts cr ON cr.id = cri.treasury_cash_receipt_id
           JOIN abos.treasury_finance_handoffs h ON h.cash_receipt_id = cr.id
          WHERE j.id = $1`, [journalId]);
      const posted = row.rows[0];
      assert.ok(posted, "the posted journal joins back to its source, receipt and handoff");
      assert.deepEqual(
        { ...posted, debit: norm(posted.debit ?? ""), credit: norm(posted.credit ?? ""), receipt_amount: norm(posted.receipt_amount ?? "") },
        {
          journal_status: "POSTED", source_status: "POSTED",
          party: world.businessPartyId, agreement: world.agreementId, installment: world.installmentId,
          receipt: receiptId, count: countId, destination: world.cashAccountId,
          receipt_amount: norm(world.installmentAmount), currency: "USD",
          cashier: world.cashierId, verifier: world.countConfirmerId, handed_off_by: world.countConfirmerId,
          debit: norm(world.installmentAmount), credit: norm(world.installmentAmount),
          credited_party: world.businessPartyId, cash_subledger: world.cashAccountId
        });

      // Reconciliation: shareholder source = Treasury receipt = ledger cash debit = capital credit.
      assert.equal(norm(posted.debit ?? ""), norm(posted.receipt_amount ?? ""));
      assert.equal(norm(posted.credit ?? ""), norm(posted.receipt_amount ?? ""));

      // Duplicate posting request: idempotent, one journal.
      const replay = await asRestricted((db) => new RestrictedCapitalPostingGateway(db).post({
        bearerToken: financeToken, postingIntentId: postingIntentId as PostingIntentId,
        accountingPeriodId: world.accountingPeriodId as never
      }));
      assert.equal(replay, journalId);
      assert.equal(await count(harness, "SELECT count(*) FROM abos.journals"), 1);

      // Posted Treasury records are now immutable, including a void attempt.
      const cashier = await treasuryAs(harness.executor, world, world.cashierId);
      await rejectsTreasury("POSTED_RECORD_IMMUTABLE", () => cashier.service.voidReceipt(cashier.actor, receiptId, "attempt after posting"));
    });

    test("duplicate receipt and duplicate handoff requests are refused", async () => {
      const { world, intentId, receiptId } = await verifiedAndHandedOff(harness);
      const cashier = await treasuryAs(harness.executor, world, world.cashierId);
      const verifier = await treasuryAs(harness.executor, world, world.countConfirmerId);
      await assert.rejects(() => cashier.service.recordReceipt(cashier.actor, {
        capitalReceiptIntentId: intentId, receiptReference: "RCPT-DUP", businessEventAt: "2026-09-22T07:10:00.000Z"
      }), (error: unknown) => error instanceof TreasuryDomainError);
      await rejectsTreasury("IDEMPOTENCY_CONFLICT", () => verifier.service.handOffToFinance(verifier.actor, { receiptId }));
      assert.equal(await count(harness, "SELECT count(*) FROM abos.treasury_finance_handoffs"), 1);
    });

    test("an unverified receipt cannot reach restricted posting by any route", async () => {
      await resetSchema(harness.pool);
      const world = await seedSyntheticWorld(harness.executor);
      const intentId = await createIntent(harness, world, world.installmentId);
      const cashier = await treasuryAs(harness.executor, world, world.cashierId);
      const receiptId = await cashier.service.recordReceipt(cashier.actor, {
        capitalReceiptIntentId: intentId, receiptReference: "RCPT-UNV", businessEventAt: "2026-09-22T07:10:00.000Z"
      });
      await cashier.service.countReceipt(cashier.actor, {
        receiptId, countedAmount: world.installmentAmount,
        countEvidenceReferenceId: world.countEvidenceId, receiptEvidenceReferenceId: world.receiptEvidenceId
      });
      await cashier.service.submitForVerification(cashier.actor, receiptId);

      await assert.rejects(() => recordCapitalPostingIntent(harness.executor, world, {
        capitalReceiptIntentId: intentId, cashReceiptId: receiptId, amount: world.installmentAmount,
        idempotencyKey: `qa-${randomUUID()}`, correlationId: randomUUID()
      }), /requires a Treasury handoff|cannot be approved for posting|disagree on the Treasury receipt/);

      await ensureRestrictedLogin(harness);
      const financeToken = await sessionFor(harness, world, world.approverId);
      await assert.rejects(() => asRestricted((db) => new RestrictedCapitalPostingGateway(db).post({
        bearerToken: financeToken, postingIntentId: randomUUID() as PostingIntentId,
        accountingPeriodId: world.accountingPeriodId as never
      })), /not an approved same-currency synthetic USD capital receipt/);
      assert.equal(await count(harness, "SELECT count(*) FROM abos.journals"), 0);
    });

    test("Treasury cannot write the General Ledger: no table write, and a Treasury session cannot post", async () => {
      const { world, intentId, receiptId } = await verifiedAndHandedOff(harness);
      const postingIntentId = await recordCapitalPostingIntent(harness.executor, world, {
        capitalReceiptIntentId: intentId, cashReceiptId: receiptId, amount: world.installmentAmount,
        idempotencyKey: `qa-${randomUUID()}`, correlationId: randomUUID()
      });
      for (const sql of [
        "INSERT INTO abos.journals (id) VALUES (gen_random_uuid())",
        "INSERT INTO abos.journal_lines (id) VALUES (gen_random_uuid())",
        "INSERT INTO abos.subledger_entries (id) VALUES (gen_random_uuid())",
        "UPDATE abos.cash_receipts SET status = 'VERIFIED'",
        "INSERT INTO abos.treasury_finance_handoffs (id) VALUES (gen_random_uuid())"
      ]) {
        await assert.rejects(() => asRestricted((db) => db.query(sql)), /permission denied/i, sql);
      }
      // Every Treasury persona's own session is refused by the posting function.
      for (const person of [world.cashierId, world.countConfirmerId, world.treasuryManagerId, world.treasuryApproverId]) {
        const token = await sessionFor(harness, world, person);
        await assert.rejects(() => asRestricted((db) => new RestrictedCapitalPostingGateway(db).post({
          bearerToken: token, postingIntentId: postingIntentId as PostingIntentId,
          accountingPeriodId: world.accountingPeriodId as never
        })), /current Finance posting authority is missing/);
      }
      assert.equal(await count(harness, "SELECT count(*) FROM abos.journals"), 0);
    });

    test("cross-legal-entity access is refused in Treasury, in SQL and in restricted posting", async () => {
      const { world, receiptId, intentId } = await verifiedAndHandedOff(harness);
      const other = await secondLegalEntity(harness, world);

      // A Treasury verifier of entity B cannot see or act on entity A's receipt.
      const outsider = await treasuryAsIn(harness, world, other.verifierId, other.legalEntityId);
      await rejectsTreasury("NOT_FOUND", () => outsider.service.trace(outsider.actor, receiptId));
      await assert.rejects(() => outsider.service.voidReceipt(outsider.actor, receiptId, "cross-entity attempt"),
        (error: unknown) => error instanceof TreasuryDomainError && error.code === "NOT_FOUND");
      // Nor by SQL naming themselves as actor: their grant is in the wrong legal entity.
      await assert.rejects(() => asActorSql(harness, other.verifierId, (client) => client.query(
        `INSERT INTO abos.treasury_finance_handoffs
           (id, legal_entity_id, cash_receipt_id, capital_receipt_intent_id, handed_off_by_user_account_id, correlation_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [randomUUID(), world.legalEntityId, receiptId, intentId, other.verifierId, randomUUID()])),
        /requires treasury\.handoff\.create in legal entity|duplicate key/);

      // A Finance poster of entity B cannot post entity A's approved intent.
      const postingIntentId = await recordCapitalPostingIntent(harness.executor, world, {
        capitalReceiptIntentId: intentId, cashReceiptId: receiptId, amount: world.installmentAmount,
        idempotencyKey: `qa-${randomUUID()}`, correlationId: randomUUID()
      });
      const foreignFinance = await sessionIn(harness, world, other.financeId, other.legalEntityId);
      await assert.rejects(() => asRestricted((db) => new RestrictedCapitalPostingGateway(db).post({
        bearerToken: foreignFinance, postingIntentId: postingIntentId as PostingIntentId,
        accountingPeriodId: world.accountingPeriodId as never
      })), /not an approved same-currency synthetic USD capital receipt/);

      // Evidence belonging to entity B cannot evidence entity A's count.
      const intent2 = await createIntent(harness, world, await extraInstallment(harness, world));
      const cashier = await treasuryAs(harness.executor, world, world.cashierId);
      const receipt2 = await cashier.service.recordReceipt(cashier.actor, {
        capitalReceiptIntentId: intent2, receiptReference: "RCPT-X-EV", businessEventAt: "2026-09-22T07:10:00.000Z"
      });
      await assert.rejects(() => cashier.service.countReceipt(cashier.actor, {
        receiptId: receipt2, countedAmount: world.installmentAmount,
        countEvidenceReferenceId: other.countEvidenceId, receiptEvidenceReferenceId: world.receiptEvidenceId
      }), /foreign key|PHYSICAL_CASH_COUNT evidence/);
      assert.equal(await count(harness, "SELECT count(*) FROM abos.journals"), 0);
    });

    test("revoking a grant mid-workflow stops the next Treasury step immediately", async () => {
      await resetSchema(harness.pool);
      const world = await seedSyntheticWorld(harness.executor);
      const intentId = await createIntent(harness, world, world.installmentId);
      const cashier = await treasuryAs(harness.executor, world, world.cashierId);
      const verifier = await treasuryAs(harness.executor, world, world.countConfirmerId);
      const receiptId = await cashier.service.recordReceipt(cashier.actor, {
        capitalReceiptIntentId: intentId, receiptReference: "RCPT-REV", businessEventAt: "2026-09-22T07:10:00.000Z"
      });
      await cashier.service.countReceipt(cashier.actor, {
        receiptId, countedAmount: world.installmentAmount,
        countEvidenceReferenceId: world.countEvidenceId, receiptEvidenceReferenceId: world.receiptEvidenceId
      });

      // The cashier's receipt permission is revoked after counting; the still-open session holds
      // a stale in-memory permission list, and must not be able to use it.
      await revokeGrant(harness, world, world.cashierId, "treasury.cash-receipt.record");
      await assert.rejects(() => cashier.service.submitForVerification(cashier.actor, receiptId),
        /missing treasury\.cash-receipt\.record/);

      // The verifier's grant is revoked; verification is refused though the session is live.
      await restoreGrant(harness, world, world.cashierId, "treasury.cash-receipt.record");
      await cashier.service.submitForVerification(cashier.actor, receiptId);
      await revokeGrant(harness, world, world.countConfirmerId, "treasury.cash-receipt.verify");
      await assert.rejects(() => verifier.service.verifyReceipt(verifier.actor, receiptId),
        /missing treasury\.cash-receipt\.verify/);
      assert.equal(await stageOf(harness, world, receiptId), "PENDING_VERIFICATION");
    });

    test("the runtime role cannot use Treasury helper functions as an authority oracle", async () => {
      const { world } = await verifiedAndHandedOff(harness);
      // The helpers run with the caller's rights, so without table privileges they fail rather
      // than answer "does this user hold that grant?".
      for (const sql of [
        "SELECT abos.user_holds_permission($1::uuid, $2::uuid, 'treasury.cash-receipt.verify')",
        "SELECT abos.is_assigned_cashier($1::uuid, $2::uuid)"
      ]) {
        await assert.rejects(() => asRestricted((db) => db.query(sql, [world.cashierId, world.legalEntityId])),
          /permission denied/i, sql);
      }
      await assert.rejects(() => asRestricted((db) => db.query(
        "SELECT set_config('abos.actor_user_account_id', $1, true), abos.treasury_actor()", [world.countConfirmerId])),
        /permission denied/i, "claiming an actor id gains nothing without table privileges");
    });

    test("R-3: after an upgrade from 0001-0005+0007, the runtime role must still read no Treasury table", async () => {
      // Replays the real upgrade order on a scratch schema-less database: a database migrated at
      // Codex's d7b8360 has 0007 but not 0006, and the runner then applies 0006 last.
      const url = databaseUrl();
      assert.ok(url);
      const admin = new pg.Client({ connectionString: url });
      await admin.connect();
      const scratch = `abos_upgrade_${randomUUID().slice(0, 8)}`;
      try {
        await admin.query(`CREATE DATABASE ${scratch}`);
        const target = new URL(url);
        target.pathname = `/${scratch}`;
        const client = new pg.Client({ connectionString: target.toString() });
        await client.connect();
        try {
          const { readFile } = await import("node:fs/promises");
          const { resolve } = await import("node:path");
          const root = resolve(import.meta.dirname, "../../..");
          for (const id of ["0001_e0_finance_foundation", "0002_e1_sandbox_integration", "0003_e1_commitment_concurrency",
            "0004_e1_runtime_role", "0005_e1_capital_provenance", "0007_e1_secure_posting_boundary",
            "0006_e1_treasury", "0008_e1_secure_treasury_boundary"]) {
            await client.query("BEGIN");
            await client.query(await readFile(resolve(root, `infrastructure/database/migrations/${id}.sql`), "utf8"));
            await client.query("COMMIT");
          }
          const readable = await client.query<{ readonly relname: string }>(
            `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'abos' AND c.relkind = 'r'
                AND has_table_privilege('abos_e1_runtime', c.oid, 'SELECT') ORDER BY 1`);
          assert.deepEqual(readable.rows.map((row) => row.relname), [], "runtime must have no table privileges");
        } finally {
          await client.end();
        }
      } finally {
        await admin.query(`DROP DATABASE IF EXISTS ${scratch}`);
        await admin.end();
      }
    });

    test("R-1: the Treasury verifier of a receipt cannot approve the Finance posting", async () => {
      const { world, intentId, receiptId } = await verifiedAndHandedOff(harness);
      // The same person who confirmed the physical count and verified the receipt is also given
      // Finance authority, then approves and posts it.
      for (const permission of ["finance.posting-intent.approve", "finance.journal.post"]) {
        await harness.executor.query(
          `INSERT INTO abos.user_permission_grants (user_account_id, legal_entity_id, permission_code, granted_by_user_account_id)
           VALUES ($1, $2, $3, $4)`, [world.countConfirmerId, world.legalEntityId, permission, world.bootstrapUserId]);
      }
      await assert.rejects(
        () => postingIntentApprovedBy(
          harness, world, intentId, receiptId, world.countConfirmerId
        ),
        /independent of intent preparation and Treasury custody/,
        "custody verification and Finance approval must be separate people"
      );
    });

    test("R-2: one bound receipt evidence reference cannot evidence another intent", async () => {
      await resetSchema(harness.pool);
      const world = await seedSyntheticWorld(harness.executor);
      const cashier = await treasuryAs(harness.executor, world, world.cashierId);
      const first = await createIntent(harness, world, world.installmentId);
      const second = await createIntent(harness, world, await extraInstallment(harness, world));
      for (const [index, intentId] of [first, second].entries()) {
        const receiptId = await cashier.service.recordReceipt(cashier.actor, {
          capitalReceiptIntentId: intentId, receiptReference: `RCPT-EV-${index}`, businessEventAt: "2026-09-22T07:10:00.000Z"
        });
        const attempt = cashier.service.countReceipt(cashier.actor, {
          receiptId, countedAmount: world.installmentAmount,
          countEvidenceReferenceId: world.countEvidenceId, receiptEvidenceReferenceId: world.receiptEvidenceId
        });
        if (index === 0) await attempt;
        else await assert.rejects(() => attempt, /evidence/, "the same CASH_RECEIPT evidence reused");
      }
    });
  });
}

// ---------------------------------------------------------------------------------------- helpers

/** Seeds, then runs the real workflow up to and including the Treasury -> Finance handoff. */
async function verifiedAndHandedOff(harness: Harness): Promise<{
  world: SyntheticWorld; intentId: CapitalReceiptIntentId; receiptId: CashReceiptId; countId: string;
}> {
  await resetSchema(harness.pool);
  const world = await seedSyntheticWorld(harness.executor);
  await ensureRestrictedLogin(harness);
  const intentId = await createIntent(harness, world, world.installmentId);
  const cashier = await treasuryAs(harness.executor, world, world.cashierId);
  const verifier = await treasuryAs(harness.executor, world, world.countConfirmerId);
  const receiptId = await cashier.service.recordReceipt(cashier.actor, {
    capitalReceiptIntentId: intentId, receiptReference: `RCPT-QA-${randomUUID().slice(0, 6)}`,
    businessEventAt: "2026-09-22T07:10:00.000Z"
  });
  const countId = await cashier.service.countReceipt(cashier.actor, {
    receiptId, countedAmount: world.installmentAmount,
    countEvidenceReferenceId: world.countEvidenceId, receiptEvidenceReferenceId: world.receiptEvidenceId
  });
  await cashier.service.submitForVerification(cashier.actor, receiptId);
  await rejectsTreasury("SEGREGATION_OF_DUTIES_VIOLATION", async () => {
    // Self-verification refused even when the cashier is (wrongly) given verify authority.
    await harness.executor.query(
      `INSERT INTO abos.user_permission_grants (user_account_id, legal_entity_id, permission_code, granted_by_user_account_id)
       VALUES ($1, $2, 'treasury.cash-receipt.verify', $3) ON CONFLICT DO NOTHING`,
      [world.cashierId, world.legalEntityId, world.bootstrapUserId]);
    const elevated = await treasuryAs(harness.executor, world, world.cashierId);
    await elevated.service.verifyReceipt(elevated.actor, receiptId);
  });
  await verifier.service.verifyReceipt(verifier.actor, receiptId);
  await verifier.service.handOffToFinance(verifier.actor, { receiptId });
  return { world, intentId, receiptId, countId };
}

async function createIntent(harness: Harness, world: SyntheticWorld, installmentId: string): Promise<CapitalReceiptIntentId> {
  const service = new CapitalReceiptIntentService(
    new PostgresShareholderRepository(harness.executor, world.intentCreatorId as UserAccountId));
  const intent = await service.createCapitalReceiptIntent({
    legalEntityId: world.legalEntityId as LegalEntityId,
    shareholderPartyId: world.businessPartyId as never,
    agreementId: world.agreementId as CapitalAgreementId,
    installmentId: installmentId as CapitalInstallmentId,
    amount: { amount: asDecimalString(world.installmentAmount), currency: "USD" },
    expectedDestinationAccountId: world.cashAccountId as CashLocationCurrencyAccountId,
    businessEventAt: "2026-09-22T07:00:00.000Z",
    source: {
      legalEntityId: world.legalEntityId as LegalEntityId,
      idempotencyKey: `qa-${randomUUID()}` as IdempotencyKey,
      correlationId: randomUUID() as CorrelationId
    },
    evidence: [await evidence(harness, world.agreementDocumentEvidenceId)]
  });
  await bindExistingSyntheticTreasuryEvidence(harness.executor, world, intent.id);
  return intent.id;
}

async function extraInstallment(harness: Harness, world: SyntheticWorld): Promise<string> {
  const id = randomUUID();
  const next = await harness.executor.query<{ readonly n: number }>(
    "SELECT coalesce(max(sequence_number), 0) + 1 AS n FROM abos.capital_installments WHERE capital_agreement_id = $1",
    [world.agreementId]);
  await harness.executor.query(
    `INSERT INTO abos.capital_installments
       (id, legal_entity_id, capital_agreement_id, sequence_number, expected_amount, currency_code, status, created_by_user_account_id)
     VALUES ($1, $2, $3, $4, $5::numeric, 'USD', 'PENDING_RECEIPT', $6)`,
    [id, world.legalEntityId, world.agreementId, next.rows[0]?.n ?? 2, world.installmentAmount, world.bootstrapUserId]);
  return id;
}

/** A Finance-approved posting intent whose approval is by `approverId` (for the R-1 finding). */
async function postingIntentApprovedBy(
  harness: Harness, world: SyntheticWorld, intentId: string, receiptId: string, approverId: string
): Promise<string> {
  const id = randomUUID();
  await harness.executor.query(
    `INSERT INTO abos.posting_intents
       (id, legal_entity_id, source_type, source_id, treasury_cash_receipt_id, intent_kind,
        original_amount, original_currency_code, base_amount, base_currency_code,
        accounting_effective_date, correlation_id, idempotency_key, status,
        created_by_user_account_id, capital_receipt_intent_id)
     VALUES ($1, $2, 'SHAREHOLDER_CAPITAL_INSTALLMENT', $3, $4, 'SHAREHOLDER_CAPITAL_RECEIPT',
             $5::numeric, 'USD', $5::numeric, 'USD', $6, $7, $8, 'APPROVED', $9, $3)`,
    [id, world.legalEntityId, intentId, receiptId, world.installmentAmount, world.accountingEffectiveDate,
     randomUUID(), `qa-${randomUUID()}`, world.intentCreatorId]);
  await harness.executor.query(
    `INSERT INTO abos.posting_approvals
       (id, legal_entity_id, posting_intent_id, decision, approver_user_account_id, evidence_reference_id, approved_at)
     VALUES ($1, $2, $3, 'APPROVED', $4, $5, clock_timestamp())`,
    [randomUUID(), world.legalEntityId, id, approverId, world.approvalEvidenceId]);
  return id;
}

/** A second synthetic legal entity inside the sandbox, with its own verifier, Finance user and evidence. */
async function secondLegalEntity(harness: Harness, world: SyntheticWorld): Promise<{
  legalEntityId: string; verifierId: string; financeId: string; countEvidenceId: string;
}> {
  const legalEntityId = randomUUID();
  const verifierId = randomUUID();
  const financeId = randomUUID();
  const countEvidenceId = randomUUID();
  await harness.executor.query(
    `INSERT INTO abos.legal_entities (id, company_id, code, name, base_currency_code, currency_policy_status)
     VALUES ($1, $2, $3, 'Synthetic Second Entity', 'USD', 'APPROVED')`,
    [legalEntityId, world.companyId, `SLE2-${legalEntityId.slice(0, 8)}`]);
  await harness.executor.query(
    `INSERT INTO abos.sandbox_legal_entity_scopes (legal_entity_id, base_currency_code, authorized_by_user_account_id)
     VALUES ($1, 'USD', $2)`, [legalEntityId, world.bootstrapUserId]);
  for (const [id, name] of [[verifierId, "Synthetic Entity-B Verifier"], [financeId, "Synthetic Entity-B Finance"]] as const) {
    await harness.executor.query(
      `INSERT INTO abos.user_accounts (id, login_identifier, display_name, status) VALUES ($1, $2, $3, 'ACTIVE')`,
      [id, `${id}@synthetic.invalid`, name]);
  }
  const grants: readonly (readonly [string, string])[] = [
    [verifierId, "treasury.read"], [verifierId, "treasury.cash-receipt.verify"], [verifierId, "treasury.handoff.create"],
    [financeId, "finance.posting-intent.approve"], [financeId, "finance.journal.post"]
  ];
  for (const [user, permission] of grants) {
    await harness.executor.query(
      `INSERT INTO abos.user_permission_grants (user_account_id, legal_entity_id, permission_code, granted_by_user_account_id)
       VALUES ($1, $2, $3, $4)`, [user, legalEntityId, permission, world.bootstrapUserId]);
  }
  await harness.executor.query(
    `INSERT INTO abos.evidence_references (id, legal_entity_id, document_id, evidence_kind, evidence_version, sha256, completed_at)
     VALUES ($1, $2, $3, 'PHYSICAL_CASH_COUNT', 1, $4, clock_timestamp())`,
    [countEvidenceId, legalEntityId, randomUUID(), "e".repeat(64)]);
  return { legalEntityId, verifierId, financeId, countEvidenceId };
}

async function treasuryAsIn(harness: Harness, world: SyntheticWorld, userId: string, legalEntityId: string) {
  return treasuryAs(harness.executor, { ...world, legalEntityId }, userId);
}

async function sessionFor(harness: Harness, world: SyntheticWorld, userId: string): Promise<string> {
  return sessionIn(harness, world, userId, world.legalEntityId);
}

async function sessionIn(harness: Harness, world: SyntheticWorld, userId: string, legalEntityId: string): Promise<string> {
  const authenticator = new SandboxAuthenticator(harness.executor, world.authConfiguration);
  const session = await authenticator.issueSession({
    userAccountId: userId as UserAccountId, legalEntityId: legalEntityId as LegalEntityId
  });
  return session.token;
}

async function revokeGrant(harness: Harness, world: SyntheticWorld, userId: string, permission: string): Promise<void> {
  await harness.executor.query(
    `UPDATE abos.user_permission_grants SET revoked_at = clock_timestamp()
      WHERE user_account_id = $1 AND legal_entity_id = $2 AND permission_code = $3`,
    [userId, world.legalEntityId, permission]);
}

async function restoreGrant(harness: Harness, world: SyntheticWorld, userId: string, permission: string): Promise<void> {
  await harness.executor.query(
    `UPDATE abos.user_permission_grants SET revoked_at = NULL
      WHERE user_account_id = $1 AND legal_entity_id = $2 AND permission_code = $3`,
    [userId, world.legalEntityId, permission]);
}

async function stageOf(harness: Harness, world: SyntheticWorld, receiptId: CashReceiptId): Promise<string> {
  const repository = new PostgresTreasuryRepository(harness.executor);
  const entity = world.legalEntityId as LegalEntityId;
  const trace = await repository.trace(entity, receiptId);
  assert.ok(trace);
  return receiptStage(trace.receipt, trace.handoff, trace.postedJournalId);
}

async function count(harness: Harness, sql: string): Promise<number> {
  const result = await harness.executor.query<{ readonly count: string }>(sql);
  return Number(result.rows[0]?.count ?? "0");
}

async function evidence(harness: Harness, id: string): Promise<EvidenceReference> {
  const result = await harness.executor.query<{
    id: string; document_id: string; evidence_kind: EvidenceReference["kind"];
    evidence_version: number; sha256: string; completed_at: Date | string;
  }>("SELECT id, document_id, evidence_kind, evidence_version, sha256, completed_at FROM abos.evidence_references WHERE id = $1", [id]);
  const row = result.rows[0];
  assert.ok(row);
  return {
    id: row.id as EvidenceReference["id"], documentId: row.document_id as EvidenceReference["documentId"],
    kind: row.evidence_kind, version: row.evidence_version, sha256: row.sha256,
    completedAt: new Date(row.completed_at).toISOString()
  };
}

async function asActorSql<T>(harness: Harness, userId: string, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await harness.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('abos.runtime_marker', $1, true)", [MARKER]);
    await client.query("SELECT set_config('abos.actor_user_account_id', $1, true)", [userId]);
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** Codex's restricted runtime login: member of abos_e1_runtime only. */
async function ensureRestrictedLogin(harness: Harness): Promise<void> {
  const exists = await harness.executor.query<{ readonly exists: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists", [RUNTIME_LOGIN]);
  if (exists.rows[0]?.exists !== true) {
    await harness.executor.query(
      `CREATE ROLE ${RUNTIME_LOGIN} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${RUNTIME_PASSWORD}'`);
  }
  await harness.executor.query(`GRANT abos_e1_runtime TO ${RUNTIME_LOGIN}`);
}

async function asRestricted<T>(operation: (db: SqlExecutor) => Promise<T>): Promise<T> {
  const configured = databaseUrl();
  assert.ok(configured);
  const url = new URL(configured);
  url.username = RUNTIME_LOGIN;
  url.password = RUNTIME_PASSWORD;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 1 });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const db: SqlExecutor = {
      query: async (sql, parameters = []) => {
        const result = await client.query(sql, [...parameters]);
        return { rows: result.rows, rowCount: result.rowCount ?? 0 };
      },
      transaction: async (callback) => callback(db)
    };
    const value = await operation(db);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

async function rejectsTreasury(code: TreasuryDomainError["code"], run: () => Promise<unknown>): Promise<void> {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof TreasuryDomainError, `expected TreasuryDomainError ${code}, got ${String(error)}`);
    assert.equal(error.code, code, error.message);
    return true;
  });
}

function norm(amount: string): string {
  return amount.includes(".") ? amount.replace(/0+$/, "").replace(/\.$/, "") : amount;
}
