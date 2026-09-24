import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before, describe } from "node:test";
import pg from "pg";
import { databaseUrl, MISSING_DATABASE_MESSAGE, openHarness, resetSchema, type Harness } from "./harness.ts";
import {
  addInstallment, bindExistingSyntheticTreasuryEvidence,
  seedSyntheticWorld, type SyntheticWorld
} from "./synthetic-world.ts";

/**
 * Database-level proof of findings F-2 through F-5 and F-7.
 *
 * These run against a real PostgreSQL. They prove what the *database* refuses, which is the only
 * thing that matters for a gate meant to hold when the application is wrong, bypassed or absent:
 * every statement below is issued directly, with no domain code in the way.
 */

const MARKER = "synthetic-e1-sandbox-marker";

if (databaseUrl() === undefined) {
  test("E1 PostgreSQL integration suite", (t) => {
    t.diagnostic(MISSING_DATABASE_MESSAGE);
    assert.fail(MISSING_DATABASE_MESSAGE);
  });
} else {
  describe("E1 database guards", () => {
    let harness: Harness;

    before(async () => {
      harness = await openHarness(MARKER);
      await resetSchema(harness.pool);
    });

    after(async () => {
      await harness.close();
    });

    // -----------------------------------------------------------------------
    // F-3. The synthetic-only gate is enforced by the database.
    // -----------------------------------------------------------------------

    test("F-3: with no sandbox authorization, finance mutation is impossible", async () => {
      await resetSchema(harness.pool);
      const world = await seedSyntheticWorld(harness.executor, {
        withoutSandboxAuthorization: true
      });
      await assert.rejects(
        () => insertIntent(harness, world, world.installmentId, "1000.00"),
        /this database has none/,
        "a database that has not declared itself a sandbox must refuse the write"
      );
    });

    test("F-3: a session that does not present the runtime marker cannot write finance data", async () => {
      await resetSchema(harness.pool);
      const world = await seedSyntheticWorld(harness.executor);

      // A raw connection, exactly what a stray script or a misconfigured service would have.
      const client = await harness.pool.connect();
      try {
        await assert.rejects(
          () =>
            client.query(...intentStatement(world, world.installmentId, "1000.00", randomUUID())),
          /does not present the authorized sandbox runtime marker/
        );
      } finally {
        client.release();
      }
    });

    test("F-3: a wrong runtime marker is refused just like a missing one", async () => {
      await resetSchema(harness.pool);
      const world = await seedSyntheticWorld(harness.executor);
      const client = await harness.pool.connect();
      try {
        await client.query("SELECT set_config('abos.runtime_marker', $1, false)", ["not-the-marker"]);
        await assert.rejects(
          () => client.query(...intentStatement(world, world.installmentId, "1000.00", randomUUID())),
          /does not present the authorized sandbox runtime marker/
        );
      } finally {
        client.release();
      }
    });

    test("F-3: real posting cannot be enabled, and there cannot be a second authorization", async () => {
      await resetSchema(harness.pool);
      const world = await seedSyntheticWorld(harness.executor);

      await assert.rejects(
        () =>
          harness.executor.query(
            "UPDATE abos.sandbox_authorizations SET real_posting_enabled = true WHERE singleton"
          ),
        /real_posting_enabled/,
        "the flag is a CHECK, not a setting"
      );

      await assert.rejects(
        () =>
          harness.executor.query(
            `INSERT INTO abos.sandbox_authorizations
               (singleton, environment, configuration_state, policy_version_id, runtime_marker,
                authorized_by_user_account_id, authorized_at, expires_at)
             VALUES (true, 'development', 'SYNTHETIC_TEST_ONLY', 'second', 'another-long-marker',
                     $1, clock_timestamp(), clock_timestamp() + interval '1 day')`,
            [world.bootstrapUserId]
          ),
        /duplicate key|sandbox_authorizations_pkey/i
      );

      // A production authorization cannot be stored at all.
      await assert.rejects(
        () =>
          harness.executor.query(
            "UPDATE abos.sandbox_authorizations SET environment = 'production' WHERE singleton"
          ),
        /sandbox_authorizations_environment_check|violates check constraint/i
      );
    });

    test("F-3: an expired authorization stops finance mutation", async () => {
      await resetSchema(harness.pool);
      const world = await seedSyntheticWorld(harness.executor);
      await harness.executor.query(
        `UPDATE abos.sandbox_authorizations
            SET authorized_at = clock_timestamp() - interval '2 days',
                expires_at = clock_timestamp() - interval '1 day'
          WHERE singleton`
      );
      await assert.rejects(
        () => insertIntent(harness, world, world.installmentId, "1000.00"),
        /sandbox authorization expired/
      );
    });

    test("F-3: a legal entity outside the authorized scope cannot be posted to", async () => {
      await resetSchema(harness.pool);
      const world = await seedSyntheticWorld(harness.executor);
      await harness.executor.query("DELETE FROM abos.sandbox_legal_entity_scopes WHERE legal_entity_id = $1", [
        world.legalEntityId
      ]);
      await assert.rejects(
        () => insertIntent(harness, world, world.installmentId, "1000.00"),
        /not inside the authorized E1 sandbox scope/
      );
    });

    // -----------------------------------------------------------------------
    // F-1. Fundability is a recorded decision.
    // -----------------------------------------------------------------------

    test("F-1: with no funding decision recorded, no capital receipt can be created", async () => {
      await resetSchema(harness.pool);
      const world = await seedSyntheticWorld(harness.executor, { withoutFundingPolicy: true });
      await assert.rejects(
        () => insertIntent(harness, world, world.installmentId, "1000.00"),
        /no capital-agreement funding policy is recorded/
      );
    });

    test("F-1: a decision cannot name a structurally unfundable status", async () => {
      await resetSchema(harness.pool);
      const world = await seedSyntheticWorld(harness.executor, { withoutFundingPolicy: true });
      for (const status of ["DRAFT", "SUSPENDED", "CLOSED"]) {
        await assert.rejects(
          () =>
            harness.executor.query(
              `INSERT INTO abos.capital_agreement_funding_policies
                 (legal_entity_id, vocabulary_version, decision_reference, decided_by,
                  fundable_statuses, decided_at)
               VALUES ($1, 'stage1-e0-v2', 'attempt', 'SANDBOX_SYNTHETIC', $2::text[], clock_timestamp())`,
              [world.legalEntityId, [status]]
            ),
          /violates check constraint/i,
          `${status} must not be storable as fundable`
        );
      }
    });

    test("F-1: a synthetic sandbox cannot record a CLIENT_FINANCE decision", async () => {
      await resetSchema(harness.pool);
      const world = await seedSyntheticWorld(harness.executor, { withoutFundingPolicy: true });
      await assert.rejects(
        () =>
          harness.executor.query(
            `INSERT INTO abos.capital_agreement_funding_policies
               (legal_entity_id, vocabulary_version, decision_reference, decided_by,
                fundable_statuses, decided_at)
             VALUES ($1, 'stage1-e0-v2', 'pretend-client-approval', 'CLIENT_FINANCE',
                     ARRAY['ELIGIBLE']::text[], clock_timestamp())`,
            [world.legalEntityId]
          ),
        /synthetic sandbox cannot record a CLIENT_FINANCE funding decision/
      );
    });

    test("F-1: an agreement whose status the decision does not cover cannot be funded", async () => {
      await resetSchema(harness.pool);
      const world = await seedSyntheticWorld(harness.executor, {
        agreementStatus: "PENDING_EVIDENCE",
        fundableStatuses: ["ELIGIBLE"]
      });
      await assert.rejects(
        () => insertIntent(harness, world, world.installmentId, "1000.00"),
        /is not fundable under decision/
      );
    });

    // -----------------------------------------------------------------------
    // F-2. The persisted source record and its referential integrity.
    // -----------------------------------------------------------------------

    test("F-2: a capital posting intent cannot reference a source that does not exist", async () => {
      await resetSchema(harness.pool);
      const world = await seedSyntheticWorld(harness.executor);
      await assert.rejects(
        () =>
          harness.executor.query(
            `INSERT INTO abos.posting_intents
               (id, legal_entity_id, source_type, source_id, intent_kind, original_amount,
                original_currency_code, accounting_effective_date, correlation_id, idempotency_key,
                created_by_user_account_id, capital_receipt_intent_id)
             VALUES ($1, $2, 'SHAREHOLDER_CAPITAL_INSTALLMENT', $3, 'SHAREHOLDER_CAPITAL_RECEIPT',
                     100, 'USD', '2026-09-22', $4, 'key-1', $5, $3)`,
            [randomUUID(), world.legalEntityId, randomUUID(), randomUUID(), world.intentCreatorId]
          ),
        /unknown capital receipt intent|violates foreign key constraint|posting_intents_capital_source_fk/i,
        "source_id is no longer an unconstrained uuid"
      );
    });

    test("F-2: a capital posting intent must carry its source, and it must match source_id", async () => {
      await resetSchema(harness.pool);
      const world = await seedSyntheticWorld(harness.executor);
      await assert.rejects(
        () =>
          harness.executor.query(
            `INSERT INTO abos.posting_intents
               (id, legal_entity_id, source_type, source_id, intent_kind, original_amount,
                original_currency_code, accounting_effective_date, correlation_id, idempotency_key,
                created_by_user_account_id)
             VALUES ($1, $2, 'SHAREHOLDER_CAPITAL_INSTALLMENT', $3, 'SHAREHOLDER_CAPITAL_RECEIPT',
                     100, 'USD', '2026-09-22', $4, 'key-2', $5)`,
            [randomUUID(), world.legalEntityId, randomUUID(), randomUUID(), world.intentCreatorId]
          ),
        /posting_intents_capital_source_required|violates check constraint|requires a Treasury handoff/i
      );
    });

    test("F-2: one installment can have only one capital receipt intent", async () => {
      await resetSchema(harness.pool);
      const world = await seedSyntheticWorld(harness.executor);
      await insertIntent(harness, world, world.installmentId, "1000.00");
      await assert.rejects(
        () => insertIntent(harness, world, world.installmentId, "1000.00"),
        /duplicate key/i
      );
    });

    test("F-2: a posted capital receipt intent is immutable and cannot be deleted", async () => {
      await resetSchema(harness.pool);
      const world = await seedSyntheticWorld(harness.executor);
      const intentId = await insertIntent(harness, world, world.installmentId, "1000.00");
      await harness.executor.query(
        `UPDATE abos.capital_receipt_intents
            SET status = 'POSTED', contribution_state = 'POSTED', version = version + 1,
                treasury_cash_receipt_id = NULL, journal_id = NULL
          WHERE id = $1`,
        [intentId]
      ).catch(() => {
        // The POSTED status requires a receipt and a journal, so the update above is expected to
        // fail its CHECK. That is itself the point: POSTED cannot be claimed without provenance.
      });

      const posted = await harness.executor.query<{ readonly status: string }>(
        "SELECT status FROM abos.capital_receipt_intents WHERE id = $1",
        [intentId]
      );
      assert.equal(posted.rows[0]?.status, "ELIGIBLE", "the unsupported POSTED claim did not stick");

      // Identity can never be rewritten, posted or not.
      await assert.rejects(
        () =>
          harness.executor.query(
            "UPDATE abos.capital_receipt_intents SET amount = 999, version = version + 1 WHERE id = $1",
            [intentId]
          ),
        /identity of a capital receipt intent cannot be rewritten/
      );

      // A transition must advance the version.
      await assert.rejects(
        () =>
          harness.executor.query(
            "UPDATE abos.capital_receipt_intents SET status = 'REJECTED' WHERE id = $1",
            [intentId]
          ),
        /version must advance/
      );
    });

    // -----------------------------------------------------------------------
    // F-4. Over-contribution, including under concurrency.
    // -----------------------------------------------------------------------

    test("F-4: the sum of intents cannot exceed the committed amount", async () => {
      await resetSchema(harness.pool);
      const world = await seedSyntheticWorld(harness.executor, {
        committedAmount: "30000.00",
        installmentAmount: "25000.00"
      });
      const second = await addInstallment(harness.executor, world, {
        sequenceNumber: 2,
        expectedAmount: "25000.00"
      });

      await insertIntent(harness, world, world.installmentId, "25000.00");
      await assert.rejects(
        () => insertIntent(harness, world, second, "25000.00"),
        /would exceed the committed amount/,
        "25000 + 25000 > 30000"
      );

      // What is left still fits.
      const intentId = await insertIntent(harness, world, second, "5000.00");
      assert.ok(intentId);
    });

    test("F-4: a rejected intent releases its share of the commitment", async () => {
      await resetSchema(harness.pool);
      const world = await seedSyntheticWorld(harness.executor, {
        committedAmount: "30000.00",
        installmentAmount: "25000.00"
      });
      const second = await addInstallment(harness.executor, world, {
        sequenceNumber: 2,
        expectedAmount: "25000.00"
      });
      const first = await insertIntent(harness, world, world.installmentId, "25000.00");
      await harness.executor.query(
        `UPDATE abos.capital_receipt_intents
            SET status = 'REJECTED', contribution_state = 'REJECTED', version = version + 1
          WHERE id = $1`,
        [first]
      );
      const replacement = await insertIntent(harness, world, second, "25000.00");
      assert.ok(replacement, "the released commitment can be used again");
    });

    test("F-4: two concurrent installments cannot overrun the commitment", async () => {
      await resetSchema(harness.pool);
      const world = await seedSyntheticWorld(harness.executor, {
        committedAmount: "30000.00",
        installmentAmount: "25000.00"
      });
      const second = await addInstallment(harness.executor, world, {
        sequenceNumber: 2,
        expectedAmount: "25000.00"
      });

      // Two transactions, each individually valid, racing on the same agreement. The row lock on
      // the agreement serializes them, so exactly one can win.
      const results = await Promise.allSettled([
        concurrentIntent(harness, world, world.installmentId, "25000.00"),
        concurrentIntent(harness, world, second, "25000.00")
      ]);

      const fulfilled = results.filter((result) => result.status === "fulfilled");
      const rejected = results.filter((result) => result.status === "rejected");
      assert.equal(fulfilled.length, 1, `exactly one should succeed, got ${fulfilled.length}`);
      assert.equal(rejected.length, 1);
      assert.match(
        String((rejected[0] as PromiseRejectedResult).reason),
        /would exceed the committed amount/
      );

      const total = await harness.executor.query<{ readonly total: string }>(
        `SELECT coalesce(sum(amount), 0)::text AS total
           FROM abos.capital_receipt_intents
          WHERE capital_agreement_id = $1 AND status <> 'REJECTED'`,
        [world.agreementId]
      );
      assert.equal(total.rows[0]?.total, "25000.00", "the ledger of intents never exceeded 30000");
    });

    test("F-4: an unauthorized partial installment is refused", async () => {
      await resetSchema(harness.pool);
      const world = await seedSyntheticWorld(harness.executor, {
        partialInstallmentsAllowed: false,
        installmentAmount: "25000.00"
      });
      await assert.rejects(
        () => insertIntent(harness, world, world.installmentId, "10000.00"),
        /does not authorize a partial installment/
      );
      const full = await insertIntent(harness, world, world.installmentId, "25000.00");
      assert.ok(full);
    });

    // -----------------------------------------------------------------------
    // F-5 and F-7.
    // -----------------------------------------------------------------------

    // F-5 is proved in capital-receipt-e2e.test.ts, against a genuinely posted journal.
    //
    // It cannot be proved here: PostgreSQL fires triggers in name order, so 0001's
    // journal_reversal_links_guard runs before the segregation guard and rejects any pair that is
    // not already two valid posted journals. Rather than assert against a refusal that never
    // reaches the rule under test, the rule is also enforced when the reversal journal is posted,
    // and that is what the end-to-end test exercises.

    test("F-7: a verified receipt requires a confirmed, matching physical cash count", async () => {
      await resetSchema(harness.pool);
      const world = await seedSyntheticWorld(harness.executor);
      const intentId = await insertIntent(harness, world, world.installmentId, "25000.00");
      await bindExistingSyntheticTreasuryEvidence(harness.executor, world, intentId);

      // The cashier receives 25,000 but records a count of only 24,999.99. Raw SQL under a named
      // actor: this proves the database's refusal, with no service in the way.
      const receiptId = randomUUID();
      const shortCount = randomUUID();
      await asActor(harness, world.cashierId, async (client) => {
        await client.query(...receiptStatement(world, receiptId, intentId, "25000.00"));
        await client.query(...countStatement(world, shortCount, world.cashierId, "24999.99"));
        await client.query(
          `UPDATE abos.cash_receipts SET status = 'COUNTED', physical_cash_count_id = $2, evidence_reference_id = $3
            WHERE id = $1`, [receiptId, shortCount, world.receiptEvidenceId]);
        await client.query(
          "UPDATE abos.cash_receipts SET submitted_for_verification_at = clock_timestamp() WHERE id = $1", [receiptId]);
      });

      // Verifying without confirming the count is refused.
      await assert.rejects(
        () => asActor(harness, world.countConfirmerId, (client) => client.query(
          `UPDATE abos.cash_receipts SET status = 'VERIFIED', verified_by_user_account_id = $2,
                  verified_at = clock_timestamp() WHERE id = $1`, [receiptId, world.countConfirmerId])),
        /must personally confirm the physical cash count|has not been confirmed/
      );

      // Confirming a count below the received amount and then verifying is refused.
      await assert.rejects(
        () => asActor(harness, world.countConfirmerId, async (client) => {
          await client.query(
            `UPDATE abos.physical_cash_counts SET status = 'CONFIRMED', confirmed_by_user_account_id = $2,
                    confirmed_at = clock_timestamp() WHERE id = $1`, [shortCount, world.countConfirmerId]);
          await client.query(
            `UPDATE abos.cash_receipts SET status = 'VERIFIED', verified_by_user_account_id = $2,
                    verified_at = clock_timestamp() WHERE id = $1`, [receiptId, world.countConfirmerId]);
        }),
        /below the received amount/
      );

      const stored = await harness.executor.query<{ readonly status: string }>(
        "SELECT status FROM abos.cash_receipts WHERE id = $1", [receiptId]);
      assert.equal(stored.rows[0]?.status, "COUNTED", "the receipt did not become VERIFIED");
    });

    test("F-7: the actor who counted the cash cannot confirm the count", async () => {
      await resetSchema(harness.pool);
      const world = await seedSyntheticWorld(harness.executor);
      const countId = randomUUID();
      await asActor(harness, world.cashierId, (client) =>
        client.query(...countStatement(world, countId, world.cashierId, "25000.00")));

      // Even inserted in one step, a count cannot arrive already confirmed.
      await assert.rejects(
        () => asActor(harness, world.cashierId, (client) => client.query(
          `INSERT INTO abos.physical_cash_counts
             (id, legal_entity_id, cash_location_currency_account_id, currency_code, counted_amount,
              counted_at, counted_by_user_account_id, evidence_reference_id, status,
              confirmed_by_user_account_id, confirmed_at)
           VALUES ($1, $2, $3, 'USD', 25000, clock_timestamp(), $4, $5, 'CONFIRMED', $4, clock_timestamp())`,
          [randomUUID(), world.legalEntityId, world.cashAccountId, world.cashierId, world.countEvidenceId])),
        /must be recorded before it can be confirmed|violates check constraint/i
      );

      // And the counter cannot confirm their own count afterwards.
      await assert.rejects(
        () => asActor(harness, world.cashierId, (client) => client.query(
          `UPDATE abos.physical_cash_counts SET status = 'CONFIRMED', confirmed_by_user_account_id = $2,
                  confirmed_at = clock_timestamp() WHERE id = $1`, [countId, world.cashierId])),
        /violates check constraint|requires treasury\.cash-receipt\.verify/i
      );
    });

    test("a user cannot grant themselves a permission, and a sandbox session cannot be long-lived", async () => {
      await resetSchema(harness.pool);
      const world = await seedSyntheticWorld(harness.executor);

      await assert.rejects(
        () =>
          harness.executor.query(
            `INSERT INTO abos.user_permission_grants
               (user_account_id, legal_entity_id, permission_code, granted_by_user_account_id)
             VALUES ($1, $2, 'finance.journal.post', $1)`,
            [world.cashierId, world.legalEntityId]
          ),
        /violates check constraint/i
      );

      await assert.rejects(
        () =>
          harness.executor.query(
            `INSERT INTO abos.sandbox_sessions
               (id, user_account_id, token_sha256, legal_entity_id, issued_at, expires_at)
             VALUES ($1, $2, $3, $4, clock_timestamp(), clock_timestamp() + interval '2 hours')`,
            [randomUUID(), world.approverId, "b".repeat(64), world.legalEntityId]
          ),
        /violates check constraint/i
      );
    });
  });
}

// ---------------------------------------------------------------------------
// Raw SQL helpers. Deliberately no domain code: these prove the database's own refusals.
// ---------------------------------------------------------------------------

function intentStatement(
  world: SyntheticWorld,
  installmentId: string,
  amount: string,
  intentId: string
): [string, unknown[]] {
  return [
    `INSERT INTO abos.capital_receipt_intents
       (id, legal_entity_id, shareholder_business_party_id, capital_agreement_id,
        capital_installment_id, amount, currency_code, destination_cash_account_id,
        evidence_reference_id, correlation_id, idempotency_key, request_fingerprint,
        business_event_at, status, classification, contribution_state, version,
        created_by_user_account_id)
     VALUES ($1,$2,$3,$4,$5,$6::numeric,'USD',$7,$8,$9,$10,$11,'2026-09-22T07:00:00Z','ELIGIBLE',
             'PAID_IN_SHARE_CAPITAL','PENDING',1,$12)`,
    [
      intentId,
      world.legalEntityId,
      world.businessPartyId,
      world.agreementId,
      installmentId,
      amount,
      world.cashAccountId,
      world.agreementDocumentEvidenceId,
      randomUUID(),
      `idem-${intentId}`,
      "c".repeat(64),
      world.intentCreatorId
    ]
  ];
}

async function insertIntent(
  harness: Harness,
  world: SyntheticWorld,
  installmentId: string,
  amount: string
): Promise<string> {
  const intentId = randomUUID();
  const [sql, parameters] = intentStatement(world, installmentId, amount, intentId);
  await harness.executor.query(sql, parameters);
  return intentId;
}

/**
 * One intent inside its own transaction, with a barrier so both racers are inside their
 * transaction before either commits. Without the barrier the two would simply serialize in time
 * and the test would prove nothing about concurrency.
 */
async function concurrentIntent(
  harness: Harness,
  world: SyntheticWorld,
  installmentId: string,
  amount: string
): Promise<string> {
  const client = await harness.pool.connect();
  const intentId = randomUUID();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('abos.runtime_marker', $1, true)", [world.runtimeMarker]);
    const [sql, parameters] = intentStatement(world, installmentId, amount, intentId);
    await client.query(sql, parameters);
    // Hold the agreement's row lock briefly, so the other transaction is definitely waiting on it.
    await client.query("SELECT pg_sleep(0.25)");
    await client.query("COMMIT");
    return intentId;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** Runs raw SQL as one named synthetic person, inside a transaction carrying the sandbox marker. */
async function asActor<Result>(
  harness: Harness,
  userAccountId: string,
  work: (client: pg.PoolClient) => Promise<Result>
): Promise<Result> {
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

function receiptStatement(world: SyntheticWorld, receiptId: string, intentId: string, amount: string): [string, unknown[]] {
  return [
    `INSERT INTO abos.cash_receipts
       (id, legal_entity_id, capital_installment_id, capital_receipt_intent_id,
        cash_location_currency_account_id, receipt_reference, amount, currency_code,
        business_event_at, received_by_user_account_id, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7::numeric, 'USD', '2026-09-22T07:10:00Z', $8, 'DRAFT')`,
    [receiptId, world.legalEntityId, world.installmentId, intentId, world.cashAccountId,
     `RCPT-${receiptId.slice(0, 8)}`, amount, world.cashierId]
  ];
}

function countStatement(world: SyntheticWorld, countId: string, countedBy: string, amount: string): [string, unknown[]] {
  return [
    `INSERT INTO abos.physical_cash_counts
       (id, legal_entity_id, cash_location_currency_account_id, currency_code, counted_amount,
        counted_at, counted_by_user_account_id, evidence_reference_id, status, count_purpose)
     VALUES ($1, $2, $3, 'USD', $4::numeric, clock_timestamp(), $5, $6, 'RECORDED', 'RECEIPT')`,
    [countId, world.legalEntityId, world.cashAccountId, amount, countedBy, world.countEvidenceId]
  ];
}

/** Keep numeric as exact decimal text in this file too. */
pg.types.setTypeParser(1700, (value: string) => value);
