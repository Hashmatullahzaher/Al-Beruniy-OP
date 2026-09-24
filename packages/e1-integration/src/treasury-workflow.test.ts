import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before, describe } from "node:test";
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
  UserAccountId
} from "@abos/contracts";
import { asDecimalString } from "@abos/contracts";
import { PostgresShareholderRepository, PostgresTreasuryRepository } from "@abos/persistence";
import { SandboxAuthenticator } from "@abos/sandbox-auth";
import { CapitalReceiptIntentService } from "@abos/shareholder";
import { receiptStage, TreasuryDomainError, TreasuryService } from "@abos/treasury";
import pg from "pg";
import { databaseUrl, MISSING_DATABASE_MESSAGE, openHarness, resetSchema, type Harness } from "./harness.ts";
import {
  handOffSyntheticReceipt,
  recordCapitalPostingIntent,
  recordSyntheticTreasuryReceipt,
  seedSyntheticWorld,
  SYNTHETIC_AUTH_CONFIGURATION,
  treasuryAs,
  type SyntheticWorld
} from "./synthetic-world.ts";

/**
 * The real Treasury workflow on PostgreSQL.
 *
 * Every rejection below is proved at the service, and - where the rule matters for custody - again
 * as raw SQL with the service bypassed, because a control that only holds when the application is
 * correct is not a control. Everything is synthetic.
 */

const MARKER = SYNTHETIC_AUTH_CONFIGURATION.runtimeMarker;

if (databaseUrl() === undefined) {
  test("E1 Treasury workflow", () => {
    assert.fail(MISSING_DATABASE_MESSAGE);
  });
} else {
  describe("E1 Treasury workflow on PostgreSQL", () => {
    let harness: Harness;

    before(async () => {
      harness = await openHarness(MARKER);
    });

    after(async () => {
      await harness.close();
    });

    // ----------------------------------------------------------------- the happy path

    test("an eligible synthetic receipt passes through real Treasury and produces a valid Finance handoff", async () => {
      await resetSchema(harness.pool);
      const world = await seedSyntheticWorld(harness.executor);
      const intentId = await createIntent(harness, world, world.installmentId);

      const cashier = await treasuryAs(harness.executor, world, world.cashierId);
      const verifier = await treasuryAs(harness.executor, world, world.countConfirmerId);

      const receiptId = await cashier.service.recordReceipt(cashier.actor, {
        capitalReceiptIntentId: intentId,
        receiptReference: "RCPT-SYN-HAPPY",
        businessEventAt: "2026-09-22T07:10:00.000Z"
      });
      assert.equal(await stage(harness, world, receiptId), "DRAFT");

      await cashier.service.countReceipt(cashier.actor, {
        receiptId,
        countedAmount: world.installmentAmount,
        countEvidenceReferenceId: world.countEvidenceId,
        receiptEvidenceReferenceId: world.receiptEvidenceId
      });
      assert.equal(await stage(harness, world, receiptId), "COUNTED");

      await cashier.service.submitForVerification(cashier.actor, receiptId);
      assert.equal(await stage(harness, world, receiptId), "PENDING_VERIFICATION");

      await verifier.service.verifyReceipt(verifier.actor, receiptId);
      assert.equal(await stage(harness, world, receiptId), "VERIFIED");

      // Treasury has not written the ledger, and has not yet handed anything to Finance.
      assert.equal(await journalCount(harness), 0);

      await verifier.service.handOffToFinance(verifier.actor, { receiptId });
      assert.equal(await stage(harness, world, receiptId), "HANDED_TO_FINANCE");
      assert.equal(await journalCount(harness), 0, "a handoff is not a posting");

      // The handoff preserved every identifier of the source.
      const trace = await verifier.service.trace(verifier.actor, receiptId);
      assert.equal(trace.source.id, intentId);
      assert.equal(trace.source.status, "TREASURY_VERIFIED");
      assert.equal(trace.source.treasuryCashReceiptId, receiptId);
      assert.equal(trace.source.shareholderBusinessPartyId, world.businessPartyId);
      assert.equal(trace.source.capitalAgreementId, world.agreementId);
      assert.equal(trace.source.capitalInstallmentId, world.installmentId);
      assert.equal(trace.receipt.capitalInstallmentId, world.installmentId);
      assert.equal(trace.receipt.cashAccountId, world.cashAccountId);
      assert.equal(trace.receipt.amount.currency, "USD");
      assert.equal(normalise(trace.receipt.amount.amount), normalise(world.installmentAmount));
      assert.equal(trace.count?.status, "CONFIRMED");
      assert.equal(trace.count?.countedByUserAccountId, world.cashierId);
      assert.equal(trace.count?.confirmedByUserAccountId, world.countConfirmerId);
      assert.equal(trace.receipt.verifiedByUserAccountId, world.countConfirmerId);
      assert.equal(trace.handoff?.handedOffByUserAccountId, world.countConfirmerId);

      // Finance can now take it: a posting intent naming this handed-off receipt is accepted.
      const postingIntentId = await recordCapitalPostingIntent(harness.executor, world, {
        capitalReceiptIntentId: intentId,
        cashReceiptId: receiptId,
        amount: world.installmentAmount,
        idempotencyKey: `posting-${randomUUID()}`,
        correlationId: randomUUID()
      });
      assert.ok(postingIntentId);

      // Complete audit history: every transition, each attributed to the person who acted.
      const history = trace.events.map((event) => `${event.aggregateType}:${event.toStatus ?? event.operation}:${event.actorUserAccountId === world.cashierId ? "cashier" : "verifier"}`);
      assert.deepEqual(history, [
        "CASH_RECEIPT:DRAFT:cashier",
        "PHYSICAL_CASH_COUNT:RECORDED:cashier",
        "CASH_RECEIPT:COUNTED:cashier",
        "CASH_RECEIPT:COUNTED:cashier",
        "PHYSICAL_CASH_COUNT:CONFIRMED:verifier",
        "CASH_RECEIPT:VERIFIED:verifier",
        "FINANCE_HANDOFF:READY_FOR_FINANCE:verifier"
      ]);
      await assert.rejects(
        () => harness.executor.query("DELETE FROM abos.treasury_events"),
        /append-only/
      );
    });

    test("USD and AFN accounts of the same safe are independent", async () => {
      await resetSchema(harness.pool);
      const world = await seedSyntheticWorld(harness.executor);
      const manager = await treasuryAs(harness.executor, world, world.treasuryManagerId);
      const accounts = await new PostgresTreasuryRepository(harness.executor).listAccounts(
        world.legalEntityId as LegalEntityId, world.cashLocationId as never);
      const byCurrency = Object.fromEntries(accounts.map((account) => [account.currency, account.status]));
      assert.deepEqual(byCurrency, { USD: "ACTIVE", AFN: "DRAFT" });

      // Opening a second USD account in the same safe is refused.
      await rejectsTreasury("IDEMPOTENCY_CONFLICT", () =>
        manager.service.openCurrencyAccount(manager.actor, { cashLocationId: world.cashLocationId as never, currency: "USD" }));
    });

    // ----------------------------------------------------------------- rejections

    test("an unassigned or unpermitted user cannot receive cash into a safe", async () => {
      await resetSchema(harness.pool);
      const world = await seedSyntheticWorld(harness.executor);
      const intentId = await createIntent(harness, world, world.installmentId);

      // The verifier holds Treasury permissions but is not an assigned cashier and cannot record.
      const verifier = await treasuryAs(harness.executor, world, world.countConfirmerId);
      await rejectsTreasury("PERMISSION_DENIED", () => verifier.service.recordReceipt(verifier.actor, {
        capitalReceiptIntentId: intentId, receiptReference: "RCPT-X", businessEventAt: "2026-09-22T07:10:00.000Z"
      }));

      // The counter holds the count permission but not the receipt permission.
      const counter = await treasuryAs(harness.executor, world, world.counterId);
      await rejectsTreasury("PERMISSION_DENIED", () => counter.service.recordReceipt(counter.actor, {
        capitalReceiptIntentId: intentId, receiptReference: "RCPT-X", businessEventAt: "2026-09-22T07:10:00.000Z"
      }));

      // Bypassing the service does not help: the database refuses an unassigned cashier.
      await assert.rejects(
        () => asActor(harness, world.countConfirmerId, (client) => client.query(...receiptStatement(world, randomUUID(), intentId, world.countConfirmerId))),
        /requires treasury\.cash-receipt\.record|assigned to this cash location/
      );

      // Revoking the cashier's assignment removes the ability immediately.
      const manager = await treasuryAs(harness.executor, world, world.treasuryManagerId);
      const assignments = await new PostgresTreasuryRepository(harness.executor).listAssignments(
        world.legalEntityId as LegalEntityId, world.cashLocationId as never);
      const active = assignments.find((item) => item.userAccountId === world.cashierId && item.revokedAt === undefined);
      assert.ok(active);
      await manager.service.revokeCashier(manager.actor, active.id);
      const cashier = await treasuryAs(harness.executor, world, world.cashierId);
      await rejectsTreasury("PERMISSION_DENIED", () => cashier.service.recordReceipt(cashier.actor, {
        capitalReceiptIntentId: intentId, receiptReference: "RCPT-X", businessEventAt: "2026-09-22T07:10:00.000Z"
      }));
    });

    test("an inactive or blocked cash account cannot receive cash", async () => {
      await resetSchema(harness.pool);
      const world = await seedSyntheticWorld(harness.executor);
      const intentId = await createIntent(harness, world, world.installmentId);

      // Block the USD account through the real lifecycle.
      await asActor(harness, world.treasuryApproverId, (client) => client.query(
        "UPDATE abos.cash_location_currency_accounts SET activation_status = 'BLOCKED' WHERE id = $1", [world.cashAccountId]));

      const cashier = await treasuryAs(harness.executor, world, world.cashierId);
      await rejectsTreasury("CASH_ACCOUNT_INACTIVE", () => cashier.service.recordReceipt(cashier.actor, {
        capitalReceiptIntentId: intentId, receiptReference: "RCPT-X", businessEventAt: "2026-09-22T07:10:00.000Z"
      }));
      await assert.rejects(
        () => asActor(harness, world.cashierId, (client) => client.query(...receiptStatement(world, randomUUID(), intentId, world.cashierId))),
        /ACTIVE currency account of an ACTIVE safe/
      );

      // An account cannot skip its lifecycle: DRAFT straight to ACTIVE is refused.
      await assert.rejects(
        () => asActor(harness, world.treasuryApproverId, (client) => client.query(
          `UPDATE abos.cash_location_currency_accounts
              SET activation_status = 'ACTIVE', activated_by_user_account_id = $2, activated_at = clock_timestamp(),
                  reconciliation_evidence_reference_id = $3
            WHERE id = $1`, [world.afnCashAccountId, world.treasuryApproverId, world.openingEvidenceId])),
        /DRAFT -> ACTIVE is not permitted/
      );
    });

    test("missing count evidence is refused", async () => {
      await resetSchema(harness.pool);
      const world = await seedSyntheticWorld(harness.executor);
      const intentId = await createIntent(harness, world, world.installmentId);
      const cashier = await treasuryAs(harness.executor, world, world.cashierId);
      const receiptId = await cashier.service.recordReceipt(cashier.actor, {
        capitalReceiptIntentId: intentId, receiptReference: "RCPT-NO-EV", businessEventAt: "2026-09-22T07:10:00.000Z"
      });
      await rejectsTreasury("EVIDENCE_REQUIRED", () => cashier.service.countReceipt(cashier.actor, {
        receiptId, countedAmount: world.installmentAmount, countEvidenceReferenceId: " ", receiptEvidenceReferenceId: world.receiptEvidenceId
      }));

      // In SQL: a count with no evidence, and a count citing the wrong kind of evidence.
      await assert.rejects(
        () => asActor(harness, world.cashierId, (client) => client.query(
          `INSERT INTO abos.physical_cash_counts
             (id, legal_entity_id, cash_location_currency_account_id, currency_code, counted_amount,
              counted_at, counted_by_user_account_id, status, count_purpose)
           VALUES ($1, $2, $3, 'USD', 25000, clock_timestamp(), $4, 'RECORDED', 'RECEIPT')`,
          [randomUUID(), world.legalEntityId, world.cashAccountId, world.cashierId])),
        /requires count evidence/
      );
      await assert.rejects(
        () => asActor(harness, world.cashierId, (client) => client.query(
          `INSERT INTO abos.physical_cash_counts
             (id, legal_entity_id, cash_location_currency_account_id, currency_code, counted_amount,
              counted_at, counted_by_user_account_id, evidence_reference_id, status, count_purpose)
           VALUES ($1, $2, $3, 'USD', 25000, clock_timestamp(), $4, $5, 'RECORDED', 'RECEIPT')`,
          [randomUUID(), world.legalEntityId, world.cashAccountId, world.cashierId, world.approvalEvidenceId])),
        /requires (structured )?PHYSICAL_CASH_COUNT evidence/
      );
    });

    test("a duplicate receipt for the same source is refused, and a voided one releases it", async () => {
      await resetSchema(harness.pool);
      const world = await seedSyntheticWorld(harness.executor);
      const intentId = await createIntent(harness, world, world.installmentId);
      const cashier = await treasuryAs(harness.executor, world, world.cashierId);
      const first = await cashier.service.recordReceipt(cashier.actor, {
        capitalReceiptIntentId: intentId, receiptReference: "RCPT-DUP-1", businessEventAt: "2026-09-22T07:10:00.000Z"
      });
      await rejectsTreasury("IDEMPOTENCY_CONFLICT", () => cashier.service.recordReceipt(cashier.actor, {
        capitalReceiptIntentId: intentId, receiptReference: "RCPT-DUP-2", businessEventAt: "2026-09-22T07:10:00.000Z"
      }));
      await assert.rejects(
        () => asActor(harness, world.cashierId, (client) => client.query(...receiptStatement(world, randomUUID(), intentId, world.cashierId))),
        /cash_receipts_one_live_receipt_per_intent|duplicate key/
      );

      await cashier.service.voidReceipt(cashier.actor, first, "Counted into the wrong bag; recounting");
      const second = await cashier.service.recordReceipt(cashier.actor, {
        capitalReceiptIntentId: intentId, receiptReference: "RCPT-DUP-3", businessEventAt: "2026-09-22T07:10:00.000Z"
      });
      assert.ok(second);
    });

    test("the cashier and the counter cannot verify their own receipt", async () => {
      await resetSchema(harness.pool);
      const world = await seedSyntheticWorld(harness.executor);
      // Give the cashier the verify permission too, so the refusal is segregation, not permission.
      await harness.executor.query(
        `INSERT INTO abos.user_permission_grants (user_account_id, legal_entity_id, permission_code, granted_by_user_account_id)
         VALUES ($1, $2, 'treasury.cash-receipt.verify', $3)`, [world.cashierId, world.legalEntityId, world.bootstrapUserId]);
      const intentId = await createIntent(harness, world, world.installmentId);
      const cashier = await treasuryAs(harness.executor, world, world.cashierId);
      const receiptId = await cashier.service.recordReceipt(cashier.actor, {
        capitalReceiptIntentId: intentId, receiptReference: "RCPT-SELF", businessEventAt: "2026-09-22T07:10:00.000Z"
      });
      const countId = await cashier.service.countReceipt(cashier.actor, {
        receiptId, countedAmount: world.installmentAmount,
        countEvidenceReferenceId: world.countEvidenceId, receiptEvidenceReferenceId: world.receiptEvidenceId
      });
      await cashier.service.submitForVerification(cashier.actor, receiptId);

      await rejectsTreasury("SEGREGATION_OF_DUTIES_VIOLATION", () => cashier.service.verifyReceipt(cashier.actor, receiptId));

      // Bypassing the service: the counter cannot confirm their own count, and the receiver cannot
      // verify their own receipt.
      await assert.rejects(
        () => asActor(harness, world.cashierId, (client) => client.query(
          `UPDATE abos.physical_cash_counts SET status = 'CONFIRMED', confirmed_by_user_account_id = $2,
                  confirmed_at = clock_timestamp() WHERE id = $1`, [countId, world.cashierId])),
        /violates check constraint/
      );
      await assert.rejects(
        () => asActor(harness, world.cashierId, (client) => client.query(
          `UPDATE abos.cash_receipts SET status = 'VERIFIED', verified_by_user_account_id = $2,
                  verified_at = clock_timestamp() WHERE id = $1`, [receiptId, world.cashierId])),
        /independent of the cashier|violates check constraint|has not been confirmed/
      );
      assert.equal(await stage(harness, world, receiptId), "PENDING_VERIFICATION");
    });

    test("a receipt cannot be verified before it is submitted, nor for an amount above its count", async () => {
      await resetSchema(harness.pool);
      const world = await seedSyntheticWorld(harness.executor);
      const intentId = await createIntent(harness, world, world.installmentId);
      const cashier = await treasuryAs(harness.executor, world, world.cashierId);
      const verifier = await treasuryAs(harness.executor, world, world.countConfirmerId);
      const receiptId = await cashier.service.recordReceipt(cashier.actor, {
        capitalReceiptIntentId: intentId, receiptReference: "RCPT-EARLY", businessEventAt: "2026-09-22T07:10:00.000Z"
      });
      await rejectsTreasury("EVIDENCE_REQUIRED", () => cashier.service.countReceipt(cashier.actor, {
        receiptId, countedAmount: "24999.99",
        countEvidenceReferenceId: world.countEvidenceId, receiptEvidenceReferenceId: world.receiptEvidenceId
      }));
      await cashier.service.countReceipt(cashier.actor, {
        receiptId, countedAmount: world.installmentAmount,
        countEvidenceReferenceId: world.countEvidenceId, receiptEvidenceReferenceId: world.receiptEvidenceId
      });
      await rejectsTreasury("TREASURY_RECEIPT_NOT_VERIFIED", () => verifier.service.verifyReceipt(verifier.actor, receiptId));
    });

    test("the receipt must match the shareholder source: installment, agreement, amount and destination", async () => {
      await resetSchema(harness.pool);
      const world = await seedSyntheticWorld(harness.executor);
      const intentId = await createIntent(harness, world, world.installmentId);
      const otherInstallment = randomUUID();
      await harness.executor.query(
        `INSERT INTO abos.capital_installments
           (id, legal_entity_id, capital_agreement_id, sequence_number, expected_amount, currency_code,
            status, created_by_user_account_id)
         VALUES ($1, $2, $3, 2, $4::numeric, 'USD', 'PENDING_RECEIPT', $5)`,
        [otherInstallment, world.legalEntityId, world.agreementId, world.installmentAmount, world.bootstrapUserId]);

      const variants: readonly (readonly [string, (row: unknown[]) => unknown[]])[] = [
        ["another installment", (row) => { row[2] = otherInstallment; return row; }],
        ["a different amount", (row) => { row[6] = "24000.00"; return row; }],
        ["the AFN account of the same safe", (row) => { row[4] = world.afnCashAccountId; return row; }]
      ];
      for (const [label, mutate] of variants) {
        const [sql, parameters] = receiptStatement(world, randomUUID(), intentId, world.cashierId);
        await assert.rejects(
          () => asActor(harness, world.cashierId, (client) => client.query(sql, mutate([...parameters]))),
          /must preserve the source|violates foreign key|ACTIVE currency account/,
          label
        );
      }

      // A source that is not ELIGIBLE - here, rejected by the shareholder side - cannot be received.
      await harness.executor.query(
        `UPDATE abos.capital_receipt_intents SET status = 'REJECTED', contribution_state = 'REJECTED',
                version = version + 1 WHERE id = $1`, [intentId]);
      const cashier = await treasuryAs(harness.executor, world, world.cashierId);
      await rejectsTreasury("CAPITAL_AGREEMENT_REQUIRED", () => cashier.service.recordReceipt(cashier.actor, {
        capitalReceiptIntentId: intentId, receiptReference: "RCPT-REJ", businessEventAt: "2026-09-22T07:10:00.000Z"
      }));
      await assert.rejects(
        () => asActor(harness, world.cashierId, (client) => client.query(...receiptStatement(world, randomUUID(), intentId, world.cashierId))),
        /REJECTED and cannot take a Treasury receipt/
      );
    });

    test("an unverified receipt never reaches Finance", async () => {
      await resetSchema(harness.pool);
      const world = await seedSyntheticWorld(harness.executor);
      const intentId = await createIntent(harness, world, world.installmentId);
      const cashier = await treasuryAs(harness.executor, world, world.cashierId);
      const verifier = await treasuryAs(harness.executor, world, world.countConfirmerId);
      const receiptId = await cashier.service.recordReceipt(cashier.actor, {
        capitalReceiptIntentId: intentId, receiptReference: "RCPT-UNV", businessEventAt: "2026-09-22T07:10:00.000Z"
      });
      await cashier.service.countReceipt(cashier.actor, {
        receiptId, countedAmount: world.installmentAmount,
        countEvidenceReferenceId: world.countEvidenceId, receiptEvidenceReferenceId: world.receiptEvidenceId
      });

      await rejectsTreasury("TREASURY_RECEIPT_NOT_VERIFIED", () => verifier.service.handOffToFinance(verifier.actor, { receiptId }));

      // Bypassing Treasury: the handoff row, the shareholder transition and the Finance posting
      // intent are each refused against an unverified receipt.
      await assert.rejects(
        () => asActor(harness, world.countConfirmerId, (client) => client.query(
          `INSERT INTO abos.treasury_finance_handoffs
             (id, legal_entity_id, cash_receipt_id, capital_receipt_intent_id, handed_off_by_user_account_id, correlation_id)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [randomUUID(), world.legalEntityId, receiptId, intentId, world.countConfirmerId, randomUUID()])),
        /only a VERIFIED receipt can be handed to Finance/
      );
      await assert.rejects(
        () => harness.executor.query(
          `UPDATE abos.capital_receipt_intents SET status = 'TREASURY_VERIFIED', contribution_state = 'VERIFIED',
                  treasury_cash_receipt_id = $2, version = version + 1 WHERE id = $1`, [intentId, receiptId]),
        /can only reference its own VERIFIED Treasury receipt/
      );
      await assert.rejects(
        () => recordCapitalPostingIntent(harness.executor, world, {
          capitalReceiptIntentId: intentId, cashReceiptId: receiptId, amount: world.installmentAmount,
          idempotencyKey: `posting-${randomUUID()}`, correlationId: randomUUID()
        }),
        /requires a Treasury handoff|cannot be approved for posting|disagree on the Treasury receipt/
      );
      assert.equal(await journalCount(harness), 0);
    });

    test("a verified receipt that was not handed off cannot be posted", async () => {
      await resetSchema(harness.pool);
      const world = await seedSyntheticWorld(harness.executor);
      const intentId = await createIntent(harness, world, world.installmentId);
      const treasury = await recordSyntheticTreasuryReceipt(harness.executor, world, {
        capitalReceiptIntentId: intentId, amount: world.installmentAmount
      });
      await assert.rejects(
        () => recordCapitalPostingIntent(harness.executor, world, {
          capitalReceiptIntentId: intentId, cashReceiptId: treasury.cashReceiptId, amount: world.installmentAmount,
          idempotencyKey: `posting-${randomUUID()}`, correlationId: randomUUID()
        }),
        /requires a Treasury handoff|disagree on the Treasury receipt/
      );
      await handOffSyntheticReceipt(harness.executor, world, treasury.cashReceiptId);
      await assert.rejects(
        () => handOffSyntheticReceipt(harness.executor, world, treasury.cashReceiptId),
        (error: unknown) => error instanceof TreasuryDomainError && error.code === "IDEMPOTENCY_CONFLICT",
        "a receipt is handed off once"
      );
    });

    test("an unattributed Treasury write is refused, and a revoked session cannot act", async () => {
      await resetSchema(harness.pool);
      const world = await seedSyntheticWorld(harness.executor);
      const intentId = await createIntent(harness, world, world.installmentId);

      await assert.rejects(
        () => harness.executor.query(...receiptStatement(world, randomUUID(), intentId, world.cashierId)),
        /requires an identified acting user/
      );

      const authenticator = new SandboxAuthenticator(harness.executor, SYNTHETIC_AUTH_CONFIGURATION);
      const cashier = await treasuryAs(harness.executor, world, world.cashierId);
      await authenticator.revokeSession(cashier.actor.sessionId);
      await assert.rejects(
        () => cashier.service.recordReceipt(cashier.actor, {
          capitalReceiptIntentId: intentId, receiptReference: "RCPT-REVOKED", businessEventAt: "2026-09-22T07:10:00.000Z"
        }),
        /Sandbox session was revoked/
      );

      // A repository opened without a credential is read-only.
      const readOnly = new TreasuryService(new PostgresTreasuryRepository(harness.executor));
      await rejectsTreasury("AUTHENTICATION_REQUIRED", () => readOnly.recordReceipt(cashier.actor, {
        capitalReceiptIntentId: intentId, receiptReference: "RCPT-RO", businessEventAt: "2026-09-22T07:10:00.000Z"
      }));
    });

    test("opening reconciliation keeps counter, reconciler and approver apart", async () => {
      await resetSchema(harness.pool);
      const world = await seedSyntheticWorld(harness.executor);
      const counter = await treasuryAs(harness.executor, world, world.counterId);
      const reconciler = await treasuryAs(harness.executor, world, world.treasuryReconcilerId);
      const approver = await treasuryAs(harness.executor, world, world.treasuryApproverId);
      const account = world.afnCashAccountId as CashLocationCurrencyAccountId;

      // Nobody can reconcile an account that has not been counted and confirmed.
      await rejectsTreasury("OPENING_POSITION_NOT_APPROVED", () => reconciler.service.reconcileOpening(reconciler.actor, {
        cashAccountId: account, physicalCashCountId: randomUUID() as never, reconciliationEvidenceReferenceId: world.openingEvidenceId
      }));

      const countId = await counter.service.recordOpeningCount(counter.actor, {
        cashAccountId: account, countedAmount: "0.00", evidenceReferenceId: world.openingCountEvidenceId
      });
      // The counter cannot confirm their own count (and lacks the approval grant besides).
      await rejectsTreasury("PERMISSION_DENIED", () => counter.service.confirmOpeningCount(counter.actor, countId));
      await approver.service.confirmOpeningCount(approver.actor, countId);
      await reconciler.service.reconcileOpening(reconciler.actor, {
        cashAccountId: account, physicalCashCountId: countId, reconciliationEvidenceReferenceId: world.openingEvidenceId
      });

      // Activation before approval is refused.
      await rejectsTreasury("OPENING_POSITION_NOT_APPROVED", () => approver.service.activateAccount(approver.actor, account));
      await approver.service.approveOpening(approver.actor, account);
      await approver.service.activateAccount(approver.actor, account);

      const accounts = await new PostgresTreasuryRepository(harness.executor).listAccounts(world.legalEntityId as LegalEntityId);
      assert.equal(accounts.find((item) => item.id === account)?.status, "ACTIVE", "AFN activated on its own lifecycle");

      // In SQL: the reconciler cannot approve their own opening position.
      const secondSafeAccount = await openBareAccount(harness, world);
      const secondCount = await counter.service.recordOpeningCount(counter.actor, {
        cashAccountId: secondSafeAccount, countedAmount: "0.00", evidenceReferenceId: world.openingCountEvidenceId
      });
      await approver.service.confirmOpeningCount(approver.actor, secondCount);
      await reconciler.service.reconcileOpening(reconciler.actor, {
        cashAccountId: secondSafeAccount, physicalCashCountId: secondCount, reconciliationEvidenceReferenceId: world.openingEvidenceId
      });
      await harness.executor.query(
        `INSERT INTO abos.user_permission_grants (user_account_id, legal_entity_id, permission_code, granted_by_user_account_id)
         VALUES ($1, $2, 'treasury.cash-account.approve', $3)`,
        [world.treasuryReconcilerId, world.legalEntityId, world.bootstrapUserId]);
      await assert.rejects(
        () => asActor(harness, world.treasuryReconcilerId, (client) => client.query(
          `UPDATE abos.cash_account_openings SET status = 'APPROVED', approved_by_user_account_id = $2,
                  approved_at = clock_timestamp() WHERE cash_location_currency_account_id = $1`,
          [secondSafeAccount, world.treasuryReconcilerId])),
        /violates check constraint/
      );
    });
  });
}

// ---------------------------------------------------------------------------- helpers

async function createIntent(harness: Harness, world: SyntheticWorld, installmentId: string): Promise<CapitalReceiptIntentId> {
  const service = new CapitalReceiptIntentService(
    new PostgresShareholderRepository(harness.executor, world.intentCreatorId as UserAccountId));
  const evidence = await loadEvidence(harness, world.agreementDocumentEvidenceId);
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
      idempotencyKey: `capital-${randomUUID()}` as IdempotencyKey,
      correlationId: randomUUID() as CorrelationId
    },
    evidence: [evidence]
  });
  return intent.id;
}

/** A second safe with only a DRAFT USD account, opened through the service. */
async function openBareAccount(harness: Harness, world: SyntheticWorld): Promise<CashLocationCurrencyAccountId> {
  const manager = await treasuryAs(harness.executor, world, world.treasuryManagerId);
  const location = await manager.service.createOfficeSafe(manager.actor, {
    name: "Synthetic Branch Safe", responsibleCashierUserAccountId: world.cashierId as UserAccountId
  });
  return manager.service.openCurrencyAccount(manager.actor, { cashLocationId: location, currency: "USD" });
}

async function stage(harness: Harness, world: SyntheticWorld, receiptId: CashReceiptId): Promise<string> {
  const repository = new PostgresTreasuryRepository(harness.executor);
  const receipt = await repository.findReceipt(world.legalEntityId as LegalEntityId, receiptId);
  assert.ok(receipt);
  const handoff = await repository.findHandoff(world.legalEntityId as LegalEntityId, receiptId);
  return receiptStage(receipt, handoff, undefined);
}

async function journalCount(harness: Harness): Promise<number> {
  const result = await harness.executor.query<{ readonly count: string }>(
    "SELECT count(*)::text AS count FROM abos.journals");
  return Number(result.rows[0]?.count ?? "0");
}

async function asActor<Result>(harness: Harness, userAccountId: string, work: (client: pg.PoolClient) => Promise<Result>): Promise<Result> {
  const client = await harness.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('abos.runtime_marker', $1, true)", [MARKER]);
    await client.query("SELECT set_config('abos.actor_user_account_id', $1, true)", [userAccountId]);
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

function receiptStatement(world: SyntheticWorld, receiptId: string, intentId: string, receivedBy: string): [string, unknown[]] {
  return [
    `INSERT INTO abos.cash_receipts
       (id, legal_entity_id, capital_installment_id, capital_receipt_intent_id,
        cash_location_currency_account_id, receipt_reference, amount, currency_code,
        business_event_at, received_by_user_account_id, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7::numeric, 'USD', '2026-09-22T07:10:00Z', $8, 'DRAFT')`,
    [receiptId, world.legalEntityId, world.installmentId, intentId, world.cashAccountId,
     `RCPT-${receiptId.slice(0, 8)}`, world.installmentAmount, receivedBy]
  ];
}

async function loadEvidence(harness: Harness, id: string): Promise<EvidenceReference> {
  const result = await harness.executor.query<{
    readonly id: string; readonly document_id: string; readonly evidence_kind: EvidenceReference["kind"];
    readonly evidence_version: number; readonly sha256: string; readonly completed_at: Date | string;
  }>("SELECT id, document_id, evidence_kind, evidence_version, sha256, completed_at FROM abos.evidence_references WHERE id = $1", [id]);
  const row = result.rows[0];
  assert.ok(row);
  return {
    id: row.id as EvidenceReference["id"], documentId: row.document_id as EvidenceReference["documentId"],
    kind: row.evidence_kind, version: row.evidence_version, sha256: row.sha256,
    completedAt: row.completed_at instanceof Date ? row.completed_at.toISOString() : String(row.completed_at)
  };
}

async function rejectsTreasury(code: TreasuryDomainError["code"], run: () => Promise<unknown>): Promise<void> {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof TreasuryDomainError, `expected TreasuryDomainError ${code}, got ${String(error)}`);
    assert.equal(error.code, code, error.message);
    return true;
  });
}

function normalise(amount: string): string {
  return amount.includes(".") ? amount.replace(/0+$/, "").replace(/\.$/, "") : amount;
}
