import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before, describe } from "node:test";
import { databaseUrl, MISSING_DATABASE_MESSAGE, openHarness, resetSchema, type Harness } from "./harness.ts";
import { createRequest, ensureFinanceLogin, grant, isoToday, MARKER, runtime, sessionFor, shareholderWorkspace } from "./currency-fixtures.ts";
import { seedSyntheticWorld } from "./synthetic-world.ts";

/**
 * V1 #14 remains policy-gated. A loan agreement exists in the common model, but the restricted
 * capital workflow must never silently relabel its principal as paid-in capital. These executable
 * checks hold that boundary until a separately reviewed loan source and posting path exists.
 */
if (databaseUrl() === undefined) {
  test("V1 shareholder loan boundary", () => assert.fail(MISSING_DATABASE_MESSAGE));
} else {
  describe("V1 shareholder capital versus loan classification", () => {
    let harness: Harness;
    before(async () => {
      harness = await openHarness(MARKER);
      await ensureFinanceLogin(harness);
    });
    after(async () => { await harness.close(); });

    test("a chosen loan agreement cannot enter the capital request or posting pipeline", async () => {
      await resetSchema(harness.pool);
      await harness.executor.query("GRANT abos_e1_runtime TO abos_e1_finance_runtime_test_login");
      const world = await seedSyntheticWorld(harness.executor);
      await grant(harness.executor, world, world.intentCreatorId, ["shareholder.capital-request.create"]);
      const token = await sessionFor(harness.executor, world.intentCreatorId, world.legalEntityId);
      const agreementId = randomUUID();
      const installmentId = randomUUID();
      await harness.executor.query(
        `INSERT INTO abos.capital_agreements
           (id, legal_entity_id, shareholder_profile_id, agreement_reference, agreement_kind,
            committed_amount, currency_code, effective_on, status, partial_installments_allowed,
            created_by_user_account_id)
         VALUES ($1, $2, $3, $4, 'SHAREHOLDER_LOAN', 50000, 'USD', current_date,
                 'ELIGIBLE', true, $5)`,
        [agreementId, world.legalEntityId, world.shareholderProfileId,
          `SYN-LOAN-${agreementId.slice(0, 8)}`, world.bootstrapUserId]
      );
      await harness.executor.query(
        `INSERT INTO abos.capital_installments
           (id, legal_entity_id, capital_agreement_id, sequence_number, expected_amount,
            currency_code, status, created_by_user_account_id)
         VALUES ($1, $2, $3, 1, 50000, 'USD', 'PENDING_RECEIPT', $4)`,
        [installmentId, world.legalEntityId, agreementId, world.bootstrapUserId]
      );

      const view = await runtime((db) => shareholderWorkspace<{
        agreements: { id: string; kind: string; installments: { id: string; blockers: string[] }[] }[];
      }>(db, token));
      const loan = view.agreements.find((item) => item.id === agreementId);
      assert.equal(loan?.kind, "SHAREHOLDER_LOAN");
      assert.ok(loan?.installments.find((item) => item.id === installmentId)?.blockers.includes("LOAN_AGREEMENT"));

      await assert.rejects(
        () => runtime((db) => createRequest(db, token, {
          installmentId, destination: world.cashAccountId, amount: "50000", businessDate: isoToday()
        })),
        /loan agreement cannot fund a capital contribution/i
      );

      // Even a privileged caller cannot smuggle the loan classification through the old source
      // table: its database guards require a capital agreement and reject loan principal.
      await assert.rejects(
        () => harness.executor.query(
          `INSERT INTO abos.capital_receipt_intents
             (id, legal_entity_id, shareholder_business_party_id, capital_agreement_id,
              capital_installment_id, amount, currency_code, destination_cash_account_id,
              evidence_reference_id, correlation_id, idempotency_key, request_fingerprint,
              business_event_at, status, classification, contribution_state, version,
              created_by_user_account_id)
           VALUES ($1, $2, $3, $4, $5, 50000, 'USD', $6, $7, $8, $9, $10,
                   clock_timestamp(), 'ELIGIBLE', 'SHAREHOLDER_LOAN_PRINCIPAL', 'PENDING', 1, $11)`,
          [randomUUID(), world.legalEntityId, world.businessPartyId, agreementId, installmentId,
            world.cashAccountId, world.agreementDocumentEvidenceId, randomUUID(),
            `synthetic-loan-${randomUUID()}`, "a".repeat(64), world.intentCreatorId]
        ),
        /loan|classification|capital contribution/i
      );

      const effects = await harness.executor.query<{
        sources: string; receipts: string; posting_intents: string; journals: string;
      }>(
        `SELECT (SELECT count(*) FROM abos.capital_receipt_intents)::text AS sources,
                (SELECT count(*) FROM abos.cash_receipts)::text AS receipts,
                (SELECT count(*) FROM abos.posting_intents)::text AS posting_intents,
                (SELECT count(*) FROM abos.journals)::text AS journals`
      );
      assert.deepEqual(effects.rows[0], {
        sources: "0", receipts: "0", posting_intents: "0", journals: "0"
      });
    });
  });
}
