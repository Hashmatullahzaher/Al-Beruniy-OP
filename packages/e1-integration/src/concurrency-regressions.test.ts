import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before, describe } from "node:test";
import type { PoolClient } from "pg";
import { PostgresExecutor, type RetryAttempt } from "@abos/persistence";
import { databaseUrl, MISSING_DATABASE_MESSAGE, openHarness, resetSchema, type Harness } from "./harness.ts";
import { addInstallment, seedSyntheticWorld, type SyntheticWorld } from "./synthetic-world.ts";

const MARKER = "synthetic-e1-sandbox-marker";
type Isolation = "READ COMMITTED" | "REPEATABLE READ" | "SERIALIZABLE";

if (databaseUrl() === undefined) {
  test("E1 commitment concurrency needs PostgreSQL", () => {
    assert.fail(MISSING_DATABASE_MESSAGE);
  });
} else {
  describe("E1 commitment concurrency regression", () => {
    let harness: Harness;

    before(async () => {
      harness = await openHarness(MARKER);
    });

    after(async () => {
      await harness.close();
    });

    for (const isolation of ["READ COMMITTED", "REPEATABLE READ", "SERIALIZABLE"] as const) {
      test(`${isolation}: two 25,000 USD installments cannot consume a 30,000 USD commitment`, async () => {
        await resetSchema(harness.pool);
        const world = await seedSyntheticWorld(harness.executor, {
          committedAmount: "30000.00",
          installmentAmount: "25000.00"
        });
        const secondInstallment = await addInstallment(harness.executor, world, {
          sequenceNumber: 2,
          expectedAmount: "25000.00"
        });

        // Both transactions explicitly take a snapshot before either writes. This reproduces the
        // stale-SUM hole in 0002 under REPEATABLE READ rather than testing sequential inserts.
        const first = await beginAtSnapshot(harness, world, isolation);
        const second = await beginAtSnapshot(harness, world, isolation);
        const outcomes = await Promise.allSettled([
          commitIntent(first, world, world.installmentId, "25000.00"),
          commitIntent(second, world, secondInstallment, "25000.00")
        ]);

        const successes = outcomes.filter((outcome) => outcome.status === "fulfilled");
        const failures = outcomes.filter((outcome) => outcome.status === "rejected") as PromiseRejectedResult[];
        assert.equal(successes.length, 1, JSON.stringify(outcomes));
        assert.equal(failures.length, 1, JSON.stringify(outcomes));
        const code = sqlState(failures[0]?.reason);
        if (isolation === "READ COMMITTED") {
          assert.equal(code, "23514", "the current usage fails the ceiling check");
        } else {
          assert.equal(code, "40001", "the stale writer must retry its complete transaction");
        }
        await assertUsage(harness, world, "25000");
      });
    }

    test("different installments can consume the same commitment when their total fits", async () => {
      await resetSchema(harness.pool);
      const world = await seedSyntheticWorld(harness.executor, {
        committedAmount: "50000.00",
        installmentAmount: "25000.00"
      });
      const secondInstallment = await addInstallment(harness.executor, world, {
        sequenceNumber: 2,
        expectedAmount: "25000.00"
      });
      const first = await beginAtSnapshot(harness, world, "READ COMMITTED");
      const second = await beginAtSnapshot(harness, world, "READ COMMITTED");
      const outcomes = await Promise.allSettled([
        commitIntent(first, world, world.installmentId, "25000.00"),
        commitIntent(second, world, secondInstallment, "25000.00")
      ]);
      assert.equal(outcomes.every((outcome) => outcome.status === "fulfilled"), true, JSON.stringify(outcomes));
      await assertUsage(harness, world, "50000");
    });

    test("a real 40001 retries the whole transaction without duplicate source rows", async () => {
      await resetSchema(harness.pool);
      const world = await seedSyntheticWorld(harness.executor, {
        committedAmount: "50000.00",
        installmentAmount: "25000.00"
      });
      const secondInstallment = await addInstallment(harness.executor, world, {
        sequenceNumber: 2,
        expectedAmount: "25000.00"
      });
      const observed: RetryAttempt[] = [];
      const executor = new PostgresExecutor(harness.pool, {
        runtimeMarker: world.runtimeMarker,
        isolation: "SERIALIZABLE",
        retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 10 },
        observeRetry: (attempt) => observed.push(attempt)
      });
      let firstAttemptCount = 0;
      let releaseFirstAttempts: () => void = () => {};
      const bothSnapshotsReady = new Promise<void>((resolve) => { releaseFirstAttempts = resolve; });
      const run = (installmentId: string) => {
        const intentId = randomUUID();
        return executor.transaction(async (transaction) => {
          await transaction.query(
            "SELECT consumed_amount FROM abos.capital_agreement_commitment_usage WHERE capital_agreement_id = $1",
            [world.agreementId]
          );
          firstAttemptCount += 1;
          if (firstAttemptCount <= 2) {
            if (firstAttemptCount === 2) releaseFirstAttempts();
            await bothSnapshotsReady;
          }
          await transaction.query(intentSql, intentParams(world, installmentId, "25000.00", intentId));
          return intentId;
        });
      };
      const [first, second] = await Promise.all([
        run(world.installmentId),
        run(secondInstallment)
      ]);
      assert.notEqual(first, second);
      assert.equal(observed.length, 1, "one stale serializable writer needed one complete retry");
      assert.equal(observed[0]?.sqlState, "40001");
      await assertUsage(harness, world, "50000");
      const sourceCount = await harness.pool.query<{ readonly count: string }>(
        "SELECT count(*)::text AS count FROM abos.capital_receipt_intents WHERE capital_agreement_id = $1",
        [world.agreementId]
      );
      assert.equal(sourceCount.rows[0]?.count, "2", "retry did not duplicate its source intent");
      const journalCount = await harness.pool.query<{ readonly count: string }>(
        "SELECT count(*)::text AS count FROM abos.journals"
      );
      assert.equal(journalCount.rows[0]?.count, "0", "source creation does not post a journal");
    });

    test("duplicate source installment is refused and does not reserve more commitment", async () => {
      await resetSchema(harness.pool);
      const world = await seedSyntheticWorld(harness.executor, {
        committedAmount: "50000.00",
        installmentAmount: "25000.00"
      });
      await insertIntent(harness, world, world.installmentId, "25000.00");
      await assert.rejects(
        () => insertIntent(harness, world, world.installmentId, "25000.00"),
        (error) => sqlState(error) === "23505"
      );
      await assertUsage(harness, world, "25000");
      const journals = await harness.pool.query<{ readonly count: string }>(
        "SELECT count(*)::text AS count FROM abos.journals"
      );
      assert.equal(journals.rows[0]?.count, "0", "a failed source write cannot create a journal");
    });

    test("rejection releases usage and a later installment can consume it", async () => {
      await resetSchema(harness.pool);
      const world = await seedSyntheticWorld(harness.executor, {
        committedAmount: "30000.00",
        installmentAmount: "25000.00"
      });
      const firstIntent = await insertIntent(harness, world, world.installmentId, "25000.00");
      await harness.executor.query(
        `UPDATE abos.capital_receipt_intents
            SET status = 'REJECTED', contribution_state = 'REJECTED', version = version + 1
          WHERE id = $1`,
        [firstIntent]
      );
      await assertUsage(harness, world, "0");
      const secondInstallment = await addInstallment(harness.executor, world, {
        sequenceNumber: 2,
        expectedAmount: "25000.00"
      });
      await insertIntent(harness, world, secondInstallment, "25000.00");
      await assertUsage(harness, world, "25000");
    });

    test("the agreement commitment cannot be reduced beneath reserved usage", async () => {
      await resetSchema(harness.pool);
      const world = await seedSyntheticWorld(harness.executor);
      await insertIntent(harness, world, world.installmentId, "25000.00");
      await assert.rejects(
        () => harness.executor.query(
          "UPDATE abos.capital_agreements SET committed_amount = 20000 WHERE id = $1",
          [world.agreementId]
        ),
        (error) => sqlState(error) === "23514"
      );
      await assertUsage(harness, world, "25000");
    });
  });
}

async function beginAtSnapshot(harness: Harness, world: SyntheticWorld, isolation: Isolation): Promise<PoolClient> {
  const client = await harness.pool.connect();
  try {
    await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
    await client.query("SELECT set_config('abos.runtime_marker', $1, true)", [world.runtimeMarker]);
    await client.query(
      "SELECT consumed_amount FROM abos.capital_agreement_commitment_usage WHERE capital_agreement_id = $1",
      [world.agreementId]
    );
    return client;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
    throw error;
  }
}

async function commitIntent(
  client: PoolClient,
  world: SyntheticWorld,
  installmentId: string,
  amount: string
): Promise<string> {
  const intentId = randomUUID();
  try {
    await client.query(intentSql, intentParams(world, installmentId, amount, intentId));
    await client.query("COMMIT");
    return intentId;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function insertIntent(
  harness: Harness,
  world: SyntheticWorld,
  installmentId: string,
  amount: string
): Promise<string> {
  const intentId = randomUUID();
  await harness.executor.query(intentSql, intentParams(world, installmentId, amount, intentId));
  return intentId;
}

const intentSql = `INSERT INTO abos.capital_receipt_intents
  (id, legal_entity_id, shareholder_business_party_id, capital_agreement_id,
   capital_installment_id, amount, currency_code, destination_cash_account_id,
   evidence_reference_id, correlation_id, idempotency_key, request_fingerprint,
   business_event_at, status, classification, contribution_state, version,
   created_by_user_account_id)
 VALUES ($1,$2,$3,$4,$5,$6::numeric,'USD',$7,$8,$9,$10,$11,
         '2026-09-22T07:00:00Z','ELIGIBLE','PAID_IN_SHARE_CAPITAL','PENDING',1,$12)`;

function intentParams(world: SyntheticWorld, installmentId: string, amount: string, intentId: string): unknown[] {
  return [
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
  ];
}

async function assertUsage(harness: Harness, world: SyntheticWorld, expected: string): Promise<void> {
  const result = await harness.pool.query<{
    readonly usage_matches: boolean;
    readonly intents_match: boolean;
    readonly within_ceiling: boolean;
  }>(
    `SELECT usage.consumed_amount = $2::numeric AS usage_matches,
            (SELECT coalesce(sum(amount), 0)
               FROM abos.capital_receipt_intents
              WHERE capital_agreement_id = $1 AND status <> 'REJECTED') = $2::numeric AS intents_match,
            usage.consumed_amount <= agreement.committed_amount AS within_ceiling
       FROM abos.capital_agreement_commitment_usage usage
       JOIN abos.capital_agreements agreement ON agreement.id = usage.capital_agreement_id
      WHERE usage.capital_agreement_id = $1`,
    [world.agreementId, expected]
  );
  assert.equal(result.rows[0]?.usage_matches, true);
  assert.equal(result.rows[0]?.intents_match, true);
  assert.equal(result.rows[0]?.within_ceiling, true);
}

function sqlState(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code: unknown }).code)
    : undefined;
}
