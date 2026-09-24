import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before, describe } from "node:test";
import pg from "pg";
import type {
  CapitalAgreementId, CapitalInstallmentId, CashLocationCurrencyAccountId,
  CorrelationId, EvidenceReference, IdempotencyKey,
  LegalEntityId, PostingIntentId, UserAccountId
} from "@abos/contracts";
import { asDecimalString } from "@abos/contracts";
import type { SqlExecutor } from "@abos/database";
import {
  PostgresShareholderRepository, RestrictedCapitalPostingGateway
} from "@abos/persistence";
import { SandboxAuthenticator } from "@abos/sandbox-auth";
import { CapitalReceiptIntentService } from "@abos/shareholder";
import { databaseUrl, MISSING_DATABASE_MESSAGE, openHarness, resetSchema, type Harness } from "./harness.ts";
import {
  handOffSyntheticReceipt, recordCapitalPostingIntent, recordSyntheticTreasuryReceipt,
  seedSyntheticWorld, type SyntheticWorld
} from "./synthetic-world.ts";

const MARKER = "synthetic-e1-sandbox-marker";
const RUNTIME_LOGIN = "abos_e1_runtime_test_login";
const RUNTIME_PASSWORD = "synthetic-runtime-only-password-2026";
const authConfig = {
  runtimeMarker: MARKER,
  signingSecret: "synthetic-secure-posting-secret-at-least-32-chars",
  environment: "test" as const,
  maxSessionSeconds: 900
};

if (databaseUrl() === undefined) {
  test("E1 secure restricted-role posting", () => assert.fail(MISSING_DATABASE_MESSAGE));
} else {
  describe("E1 secure restricted-role posting", () => {
    let harness: Harness;
    before(async () => { harness = await openHarness(MARKER); });
    after(async () => { await harness.close(); });

    test("restricted runtime posts one authorized synthetic USD receipt without table writes", async () => {
      const prepared = await prepare(harness);
      const first = await asRestrictedLogin((database) =>
        new RestrictedCapitalPostingGateway(database).post({
          bearerToken: prepared.token,
          postingIntentId: prepared.postingIntentId as PostingIntentId,
          accountingPeriodId: prepared.world.accountingPeriodId as never
        })
      );
      const replay = await asRestrictedLogin((database) =>
        new RestrictedCapitalPostingGateway(database).post({
          bearerToken: prepared.token,
          postingIntentId: prepared.postingIntentId as PostingIntentId,
          accountingPeriodId: prepared.world.accountingPeriodId as never
        })
      );
      assert.equal(replay, first, "an authenticated replay returns the same journal");
      const state = await harness.executor.query<{
        status: string; source_status: string; journals: string; subledgers: string;
        audits: string; events: string;
      }>(
        `SELECT j.status, cri.status AS source_status,
          (SELECT count(*) FROM abos.journals)::text AS journals,
          (SELECT count(*) FROM abos.subledger_entries)::text AS subledgers,
          (SELECT count(*) FROM abos.audit_records WHERE entity_id = j.id)::text AS audits,
          (SELECT count(*) FROM abos.outbox_events WHERE aggregate_id = j.id)::text AS events
         FROM abos.journals j JOIN abos.capital_receipt_intents cri ON cri.journal_id = j.id
         WHERE j.id = $1`, [first]
      );
      assert.deepEqual(state.rows[0], {
        status: "POSTED", source_status: "POSTED", journals: "1",
        subledgers: "2", audits: "1", events: "1"
      });
      await assert.rejects(
        () => asRestrictedLogin((db) => db.query("UPDATE abos.journals SET status='DRAFT' WHERE id=$1", [first])),
        /permission denied/i
      );
    });

    test("revocation after approval fails closed without financial effects", async () => {
      const prepared = await prepare(harness);
      await harness.executor.query(
        `UPDATE abos.user_permission_grants SET revoked_at=clock_timestamp()
          WHERE user_account_id=$1 AND legal_entity_id=$2
            AND permission_code='finance.journal.post'`,
        [prepared.world.approverId, prepared.world.legalEntityId]
      );
      await assert.rejects(
        () => asRestrictedLogin((database) => new RestrictedCapitalPostingGateway(database).post({
          bearerToken: prepared.token,
          postingIntentId: prepared.postingIntentId as PostingIntentId,
          accountingPeriodId: prepared.world.accountingPeriodId as never
        })), /authority is missing/i
      );
      assert.equal(await journalCount(harness), 0);
    });

    test("forged identity token and missing independent approval are refused", async () => {
      const prepared = await prepare(harness);
      await assert.rejects(
        () => asRestrictedLogin((database) => new RestrictedCapitalPostingGateway(database).post({
          bearerToken: "x".repeat(43),
          postingIntentId: prepared.postingIntentId as PostingIntentId,
          accountingPeriodId: prepared.world.accountingPeriodId as never
        })), /session is invalid/i
      );
      const otherFinanceSession = await new SandboxAuthenticator(harness.executor, authConfig).issueSession({
        userAccountId: prepared.world.reverserId as UserAccountId,
        legalEntityId: prepared.world.legalEntityId as LegalEntityId
      });
      await assert.rejects(
        () => asRestrictedLogin((database) => new RestrictedCapitalPostingGateway(database).post({
          bearerToken: otherFinanceSession.token,
          postingIntentId: prepared.postingIntentId as PostingIntentId,
          accountingPeriodId: prepared.world.accountingPeriodId as never
        })), /authority is missing/i,
        "a valid token derives its own actor and cannot impersonate the Finance approver"
      );
      await harness.executor.query(
        "DELETE FROM abos.posting_approvals WHERE posting_intent_id=$1",
        [prepared.postingIntentId]
      );
      await assert.rejects(
        () => asRestrictedLogin((database) => new RestrictedCapitalPostingGateway(database).post({
          bearerToken: prepared.token,
          postingIntentId: prepared.postingIntentId as PostingIntentId,
          accountingPeriodId: prepared.world.accountingPeriodId as never
        })), /independent Finance approval/i
      );
      assert.equal(await journalCount(harness), 0);
    });

    test("restricted posting succeeds at every supported transaction isolation level", async () => {
      for (const isolation of ["READ COMMITTED", "REPEATABLE READ", "SERIALIZABLE"] as const) {
        const prepared = await prepare(harness);
        const journalId = await asRestrictedLogin((database) =>
          new RestrictedCapitalPostingGateway(database).post({
            bearerToken: prepared.token,
            postingIntentId: prepared.postingIntentId as PostingIntentId,
            accountingPeriodId: prepared.world.accountingPeriodId as never
          }), isolation
        );
        assert.ok(journalId, `${isolation} returned a journal`);
        assert.equal(await journalCount(harness), 1);
      }
    });
  });
}

async function prepare(harness: Harness): Promise<{
  world: SyntheticWorld; token: string; postingIntentId: string;
}> {
  await resetSchema(harness.pool);
  const world = await seedSyntheticWorld(harness.executor);
  const authenticator = new SandboxAuthenticator(harness.executor, authConfig);
  const session = await authenticator.issueSession({
    userAccountId: world.approverId as UserAccountId,
    legalEntityId: world.legalEntityId as LegalEntityId
  });
  const repository = new PostgresShareholderRepository(
    harness.executor, world.intentCreatorId as UserAccountId
  );
  const service = new CapitalReceiptIntentService(repository);
  const intent = await service.createCapitalReceiptIntent({
    legalEntityId: world.legalEntityId as LegalEntityId,
    shareholderPartyId: world.businessPartyId as never,
    agreementId: world.agreementId as CapitalAgreementId,
    installmentId: world.installmentId as CapitalInstallmentId,
    amount: { amount: asDecimalString(world.installmentAmount), currency: "USD" },
    expectedDestinationAccountId: world.cashAccountId as CashLocationCurrencyAccountId,
    businessEventAt: "2026-09-22T07:00:00.000Z",
    source: {
      legalEntityId: world.legalEntityId as LegalEntityId,
      idempotencyKey: `secure-${randomUUID()}` as IdempotencyKey,
      correlationId: randomUUID() as CorrelationId
    },
    evidence: [await evidence(harness, world.agreementDocumentEvidenceId)]
  });
  const treasury = await recordSyntheticTreasuryReceipt(harness.executor, world, {
    capitalReceiptIntentId: intent.id, amount: world.installmentAmount
  });
  await handOffSyntheticReceipt(harness.executor, world, treasury.cashReceiptId);
  const postingIntentId = await recordCapitalPostingIntent(harness.executor, world, {
    capitalReceiptIntentId: intent.id, cashReceiptId: treasury.cashReceiptId,
    amount: world.installmentAmount, idempotencyKey: `secure-post-${randomUUID()}`,
    correlationId: randomUUID()
  });
  await ensureRestrictedLogin(harness);
  return { world, token: session.token, postingIntentId };
}

async function evidence(harness: Harness, id: string): Promise<EvidenceReference> {
  const result = await harness.executor.query<{
    id: string; document_id: string; evidence_kind: EvidenceReference["kind"];
    evidence_version: number; sha256: string; completed_at: Date | string;
  }>(
    `SELECT id, document_id, evidence_kind, evidence_version, sha256, completed_at
       FROM abos.evidence_references WHERE id=$1`, [id]
  );
  const row = result.rows[0];
  assert.ok(row, `evidence ${id} must exist`);
  return { id: row.id as EvidenceReference["id"],
    documentId: row.document_id as EvidenceReference["documentId"], kind: row.evidence_kind,
    version: row.evidence_version, sha256: row.sha256,
    completedAt: new Date(row.completed_at).toISOString() };
}

async function journalCount(harness: Harness): Promise<number> {
  const result = await harness.executor.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM abos.journals"
  );
  return Number(result.rows[0]?.count ?? "0");
}

async function ensureRestrictedLogin(harness: Harness): Promise<void> {
  const exists = await harness.executor.query<{ exists: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=$1) AS exists", [RUNTIME_LOGIN]
  );
  if (exists.rows[0]?.exists === true) {
    await harness.executor.query(
      `ALTER ROLE abos_e1_runtime_test_login LOGIN INHERIT
       PASSWORD 'synthetic-runtime-only-password-2026'`
    );
  } else {
    await harness.executor.query(
      `CREATE ROLE abos_e1_runtime_test_login LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
       NOREPLICATION PASSWORD 'synthetic-runtime-only-password-2026'`
    );
  }
  await harness.executor.query("GRANT abos_e1_runtime TO abos_e1_runtime_test_login");
}

async function asRestrictedLogin<T>(
  operation: (db: SqlExecutor) => Promise<T>,
  isolation: "READ COMMITTED" | "REPEATABLE READ" | "SERIALIZABLE" = "READ COMMITTED"
): Promise<T> {
  const configured = databaseUrl();
  assert.ok(configured);
  const runtimeUrl = new URL(configured);
  runtimeUrl.username = RUNTIME_LOGIN;
  runtimeUrl.password = RUNTIME_PASSWORD;
  const pool = new pg.Pool({ connectionString: runtimeUrl.toString(), max: 1 });
  const client = await pool.connect();
  try {
    await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
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
