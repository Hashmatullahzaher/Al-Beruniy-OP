import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test, { after, before, describe } from "node:test";
import pg from "pg";
import type {
  CapitalAgreementId, CapitalInstallmentId, CashLocationCurrencyAccountId,
  CorrelationId, EvidenceReference, IdempotencyKey, LegalEntityId, PostingIntentId,
  UserAccountId
} from "@abos/contracts";
import { asDecimalString } from "@abos/contracts";
import type { SqlExecutor } from "@abos/database";
import {
  PostgresShareholderRepository, RestrictedCapitalPostingGateway, RestrictedTreasuryGateway
} from "@abos/persistence";
import { SandboxAuthenticator } from "@abos/sandbox-auth";
import { CapitalReceiptIntentService } from "@abos/shareholder";
import { databaseUrl, MISSING_DATABASE_MESSAGE, openHarness, resetSchema, type Harness } from "./harness.ts";
import {
  bindSyntheticFinanceApprovalEvidence, bindSyntheticTreasuryEvidence,
  seedSyntheticWorld, type SyntheticWorld
} from "./synthetic-world.ts";

const MARKER = "synthetic-e1-sandbox-marker";
const LOGIN = "abos_e1_treasury_runtime_test_login";
const PASSWORD = "synthetic-treasury-runtime-only-2026";
const FINANCE_LOGIN = "abos_e1_finance_runtime_test_login";
const FINANCE_PASSWORD = "synthetic-finance-runtime-only-2026";
const authConfig = {
  runtimeMarker: MARKER,
  signingSecret: "synthetic-secure-treasury-secret-at-least-32-chars",
  environment: "test" as const,
  maxSessionSeconds: 900
};

if (databaseUrl() === undefined) {
  test("E1 secure Treasury boundary", () => assert.fail(MISSING_DATABASE_MESSAGE));
} else {
  describe("E1 secure Treasury boundary", () => {
    let harness: Harness;
    before(async () => { harness = await openHarness(MARKER); });
    after(async () => { await harness.close(); });

    test("independent restricted login completes receipt, verification and Finance handoff", async () => {
      const prepared = await prepare(harness);
      const cashierAuthority = { bearerToken: prepared.cashierToken,
        legalEntityId: prepared.world.legalEntityId as LegalEntityId };
      const verifierAuthority = { bearerToken: prepared.verifierToken,
        legalEntityId: prepared.world.legalEntityId as LegalEntityId };
      const receiptId = randomUUID();
      const countId = randomUUID();
      const handoffId = randomUUID();

      const sessionContext = await restricted((db) =>
        new RestrictedTreasuryGateway(db).context(prepared.cashierToken));
      assert.equal(sessionContext.userAccountId, prepared.world.cashierId);
      assert.equal(sessionContext.legalEntityId, prepared.world.legalEntityId);
      assert.ok(sessionContext.treasuryPermissions.includes("treasury.cash-receipt.record"));

      await restricted((db) => new RestrictedTreasuryGateway(db).command(cashierAuthority,
        "RECORD_RECEIPT", { id: receiptId, capitalReceiptIntentId: prepared.intentId,
          receiptReference: `SEC-${randomUUID().slice(0, 8)}`,
          businessEventAt: "2026-09-22T07:10:00.000Z" }));
      await restricted((db) => new RestrictedTreasuryGateway(db).command(cashierAuthority,
        "COUNT_RECEIPT", { id: receiptId, countId,
          countedAmount: prepared.world.installmentAmount,
          countEvidenceReferenceId: prepared.countEvidenceId,
          receiptEvidenceReferenceId: prepared.receiptEvidenceId }));
      await restricted((db) => new RestrictedTreasuryGateway(db).command(cashierAuthority,
        "SUBMIT_RECEIPT", { id: receiptId }));
      await restricted((db) => new RestrictedTreasuryGateway(db).command(verifierAuthority,
        "VERIFY_RECEIPT", { id: receiptId }));
      const handoff = await restricted((db) => new RestrictedTreasuryGateway(db).command<{
        id: string; replayed: boolean;
      }>(verifierAuthority, "HANDOFF_RECEIPT", { id: receiptId, handoffId,
        correlationId: randomUUID() }));
      assert.deepEqual(handoff, { id: handoffId, replayed: false });

      const receipts = await restricted((db) => new RestrictedTreasuryGateway(db).query<readonly {
        id: string; status: string; verified_by_user_account_id: string;
      }[]>(verifierAuthority, "RECEIPTS", receiptId));
      assert.equal(receipts[0]?.status, "VERIFIED");
      assert.equal(receipts[0]?.verified_by_user_account_id, prepared.world.countConfirmerId);
      const state = await harness.executor.query<{ status: string; treasury_cash_receipt_id: string;
        events: string; journals: string }>(
        `SELECT status, treasury_cash_receipt_id,
          (SELECT count(*)::text FROM abos.treasury_events WHERE aggregate_id IN ($2, $3)) AS events,
          (SELECT count(*)::text FROM abos.journals) AS journals
         FROM abos.capital_receipt_intents WHERE id=$1`, [prepared.intentId, receiptId, countId]
      );
      assert.deepEqual(state.rows[0], {
        status: "TREASURY_VERIFIED", treasury_cash_receipt_id: receiptId,
        events: "6", journals: "0"
      });

      await bindSyntheticFinanceApprovalEvidence(
        harness.executor, prepared.world, prepared.intentId
      );
      const auth = new SandboxAuthenticator(harness.executor, authConfig);
      const preparerSession = await auth.issueSession({
        userAccountId: prepared.world.intentCreatorId as UserAccountId,
        legalEntityId: prepared.world.legalEntityId as LegalEntityId
      });
      const approverSession = await auth.issueSession({
        userAccountId: prepared.world.approverId as UserAccountId,
        legalEntityId: prepared.world.legalEntityId as LegalEntityId
      });
      await ensureFinanceLogin(harness);
      const postingIntentId = await financeRestricted(async (db) => {
        const result = await db.query<{ posting_intent_id: string }>(
          "SELECT abos.finance_prepare_capital_posting($1,$2,$3,$4) AS posting_intent_id",
          [preparerSession.token, handoffId, prepared.world.accountingPeriodId,
            `secure-finance-${randomUUID()}`]
        );
        return result.rows[0]?.posting_intent_id;
      });
      assert.ok(postingIntentId);
      const approvalId = await financeRestricted(async (db) => {
        const result = await db.query<{ approval_id: string }>(
          "SELECT abos.finance_approve_capital_posting($1,$2) AS approval_id",
          [approverSession.token, postingIntentId]
        );
        return result.rows[0]?.approval_id;
      });
      assert.ok(approvalId);
      assert.notEqual(approvalId, postingIntentId);
      const journalId = await financeRestricted((db) =>
        new RestrictedCapitalPostingGateway(db).post({
          bearerToken: approverSession.token,
          postingIntentId: postingIntentId as PostingIntentId,
          accountingPeriodId: prepared.world.accountingPeriodId as never
        })
      );
      const posted = await harness.executor.query<{ status: string; source_status: string;
        debit: string; credit: string }>(
        `SELECT j.status, source.status AS source_status,
          sum(lines.base_debit)::text AS debit, sum(lines.base_credit)::text AS credit
         FROM abos.journals j
         JOIN abos.journal_lines lines ON lines.journal_id=j.id
         JOIN abos.capital_receipt_intents source ON source.journal_id=j.id
         WHERE j.id=$1 GROUP BY j.status, source.status`, [journalId]
      );
      assert.deepEqual(posted.rows[0], {
        status: "POSTED", source_status: "POSTED",
        debit: prepared.world.installmentAmount, credit: prepared.world.installmentAmount
      });

      await assert.rejects(
        () => restricted((db) => db.query(
          "SELECT abos.finance_handoff_workspace($1)", [prepared.verifierToken])),
        /permission denied/i
      );
      await assert.rejects(
        () => financeRestricted((db) => db.query(
          "SELECT abos.treasury_secure_query($1,$2,'LOCATIONS',NULL)",
          [approverSession.token, prepared.world.legalEntityId])),
        /permission denied/i
      );

      await assert.rejects(
        () => restricted((db) => db.query("SELECT * FROM abos.sandbox_sessions")),
        /permission denied/i
      );
      await assert.rejects(
        () => restricted((db) => db.query("UPDATE abos.cash_receipts SET status='VOIDED' WHERE id=$1", [receiptId])),
        /permission denied/i
      );
      assert.equal(await restricted((db) =>
        new RestrictedTreasuryGateway(db).revokeOwnSession(prepared.cashierToken)), true);
      await assert.rejects(
        () => restricted((db) => new RestrictedTreasuryGateway(db).context(prepared.cashierToken)),
        /session is invalid/i
      );
    });

    test("revoked grant, forged token and self-grant fail closed", async () => {
      const prepared = await prepare(harness);
      const authority = { bearerToken: prepared.cashierToken,
        legalEntityId: prepared.world.legalEntityId as LegalEntityId };
      await harness.executor.query(
        `UPDATE abos.user_permission_grants SET revoked_at=clock_timestamp()
          WHERE user_account_id=$1 AND legal_entity_id=$2
            AND permission_code='treasury.cash-receipt.record'`,
        [prepared.world.cashierId, prepared.world.legalEntityId]
      );
      await assert.rejects(
        () => restricted((db) => new RestrictedTreasuryGateway(db).command(authority,
          "RECORD_RECEIPT", { id: randomUUID(), capitalReceiptIntentId: prepared.intentId,
            receiptReference: "DENIED", businessEventAt: "2026-09-22T07:10:00.000Z" })),
        /authority is missing/i
      );
      await assert.rejects(
        () => restricted((db) => new RestrictedTreasuryGateway(db).query({
          bearerToken: "x".repeat(43), legalEntityId: prepared.world.legalEntityId as LegalEntityId
        }, "LOCATIONS")), /session is invalid/i
      );
      await assert.rejects(
        () => restricted((db) => db.query(
          `INSERT INTO abos.user_permission_grants
           (user_account_id,legal_entity_id,permission_code,granted_by_user_account_id)
           VALUES ($1,$2,'treasury.cash-receipt.record',$1)`,
          [prepared.world.cashierId, prepared.world.legalEntityId])), /permission denied/i
      );
      await assert.rejects(
        () => restricted((db) => new RestrictedTreasuryGateway(db).query({
          bearerToken: prepared.verifierToken, legalEntityId: randomUUID() as LegalEntityId
        }, "RECEIPTS")), /out of scope/i
      );
      await assert.rejects(
        () => restricted((db) => db.query(
          "UPDATE abos.sandbox_authorizations SET expires_at=clock_timestamp()")),
        /permission denied/i
      );
      const privileges = await harness.executor.query<{
        runtime_tables: boolean; finance_exec: boolean; treasury_exec: boolean;
      }>(`SELECT
        has_table_privilege('abos_e1_treasury_runtime','abos.cash_receipts','SELECT,INSERT,UPDATE') AS runtime_tables,
        has_function_privilege('abos_e1_treasury_runtime','abos.post_synthetic_capital_receipt(text,uuid,uuid)','EXECUTE') AS finance_exec,
        has_function_privilege('abos_e1_runtime','abos.treasury_secure_command(text,uuid,text,jsonb)','EXECUTE') AS treasury_exec`);
      assert.deepEqual(privileges.rows[0], {
        runtime_tables: false, finance_exec: false, treasury_exec: false
      });
    });

    test("unbound evidence, count mismatch, self-verification and early handoff are refused", async () => {
      const prepared = await prepare(harness);
      const cashier = { bearerToken: prepared.cashierToken,
        legalEntityId: prepared.world.legalEntityId as LegalEntityId };
      const verifier = { bearerToken: prepared.verifierToken,
        legalEntityId: prepared.world.legalEntityId as LegalEntityId };
      const receiptId = randomUUID();
      const gateway = (db: SqlExecutor) => new RestrictedTreasuryGateway(db);
      await restricted((db) => gateway(db).command(cashier, "RECORD_RECEIPT", {
        id: receiptId, capitalReceiptIntentId: prepared.intentId, receiptReference: "SEC-NEGATIVE",
        businessEventAt: "2026-09-22T07:10:00.000Z"
      }));
      await assert.rejects(
        () => restricted((db) => gateway(db).command(verifier, "HANDOFF_RECEIPT", {
          id: receiptId, handoffId: randomUUID(), correlationId: randomUUID()
        })), /verified receipt not found/i
      );
      await assert.rejects(
        () => restricted((db) => gateway(db).command(cashier, "COUNT_RECEIPT", {
          id: receiptId, countId: randomUUID(), countedAmount: prepared.world.installmentAmount,
          countEvidenceReferenceId: prepared.world.countEvidenceId,
          receiptEvidenceReferenceId: prepared.world.receiptEvidenceId
        })), /prebound/i
      );
      const countId = randomUUID();
      await restricted((db) => gateway(db).command(cashier, "COUNT_RECEIPT", {
        id: receiptId, countId, countedAmount: "1.00",
        countEvidenceReferenceId: prepared.countEvidenceId,
        receiptEvidenceReferenceId: prepared.receiptEvidenceId
      }));
      await restricted((db) => gateway(db).command(cashier, "SUBMIT_RECEIPT", { id: receiptId }));
      await assert.rejects(
        () => restricted((db) => gateway(db).command(verifier, "VERIFY_RECEIPT", { id: receiptId })),
        /counted amount|receipt amount|must equal|below the received amount/i
      );
      const stored = await harness.executor.query<{ counted_amount: string }>(
        "SELECT counted_amount::text FROM abos.physical_cash_counts WHERE id=$1", [countId]);
      assert.equal(stored.rows[0]?.counted_amount, "1.00");
    });

    test("a cashier cannot self-verify even after receiving a verify grant", async () => {
      const prepared = await prepare(harness);
      const cashier = { bearerToken: prepared.cashierToken,
        legalEntityId: prepared.world.legalEntityId as LegalEntityId };
      const gateway = (db: SqlExecutor) => new RestrictedTreasuryGateway(db);
      const receiptId = randomUUID();
      await restricted((db) => gateway(db).command(cashier, "RECORD_RECEIPT", {
        id: receiptId, capitalReceiptIntentId: prepared.intentId, receiptReference: "SEC-SELF",
        businessEventAt: "2026-09-22T07:10:00.000Z"
      }));
      await restricted((db) => gateway(db).command(cashier, "COUNT_RECEIPT", {
        id: receiptId, countId: randomUUID(), countedAmount: prepared.world.installmentAmount,
        countEvidenceReferenceId: prepared.countEvidenceId,
        receiptEvidenceReferenceId: prepared.receiptEvidenceId
      }));
      await harness.executor.query(
        `INSERT INTO abos.user_permission_grants
          (user_account_id,legal_entity_id,permission_code,granted_by_user_account_id)
         VALUES ($1,$2,'treasury.cash-receipt.record',$3)`,
        [prepared.world.countConfirmerId, prepared.world.legalEntityId, prepared.world.bootstrapUserId]
      );
      await assert.rejects(
        () => restricted((db) => gateway(db).command({
          bearerToken: prepared.verifierToken,
          legalEntityId: prepared.world.legalEntityId as LegalEntityId
        }, "SUBMIT_RECEIPT", { id: receiptId })),
        /awaiting submission not found/i
      );
      await restricted((db) => gateway(db).command(cashier, "SUBMIT_RECEIPT", { id: receiptId }));
      await harness.executor.query(
        `INSERT INTO abos.user_permission_grants
          (user_account_id,legal_entity_id,permission_code,granted_by_user_account_id)
         VALUES ($1,$2,'treasury.cash-receipt.verify',$3)`,
        [prepared.world.cashierId, prepared.world.legalEntityId, prepared.world.bootstrapUserId]
      );
      await assert.rejects(
        () => restricted((db) => gateway(db).command(cashier, "VERIFY_RECEIPT", { id: receiptId })),
        /independent|cashier|counter|check constraint/i
      );
    });

    test("expired sessions and a disabled synthetic gate deny every Treasury query", async () => {
      let prepared = await prepare(harness);
      const expiredDigest = createHash("sha256").update(prepared.verifierToken).digest("hex");
      await harness.executor.query(
        `UPDATE abos.sandbox_sessions session_row
            SET issued_at=expired_window.issued_at,
                expires_at=expired_window.issued_at + interval '30 minutes'
           FROM (SELECT clock_timestamp()-interval '2 hours' AS issued_at) expired_window
          WHERE session_row.runtime_token_sha256=$1`, [expiredDigest]
      );
      await assert.rejects(
        () => restricted((db) => new RestrictedTreasuryGateway(db).query({
          bearerToken: prepared.verifierToken,
          legalEntityId: prepared.world.legalEntityId as LegalEntityId
        }, "RECEIPTS")), /expired|invalid/i
      );

      prepared = await prepare(harness);
      await harness.executor.query("DELETE FROM abos.sandbox_authorizations");
      await assert.rejects(
        () => restricted((db) => new RestrictedTreasuryGateway(db).query({
          bearerToken: prepared.verifierToken,
          legalEntityId: prepared.world.legalEntityId as LegalEntityId
        }, "RECEIPTS")), /authorization is not active/i
      );
    });
  });
}

async function prepare(harness: Harness): Promise<{
  world: SyntheticWorld; intentId: string; cashierToken: string; verifierToken: string;
  countEvidenceId: string; receiptEvidenceId: string;
}> {
  await resetSchema(harness.pool);
  const world = await seedSyntheticWorld(harness.executor);
  const service = new CapitalReceiptIntentService(new PostgresShareholderRepository(
    harness.executor, world.intentCreatorId as UserAccountId));
  const intent = await service.createCapitalReceiptIntent({
    legalEntityId: world.legalEntityId as LegalEntityId,
    shareholderPartyId: world.businessPartyId as never,
    agreementId: world.agreementId as CapitalAgreementId,
    installmentId: world.installmentId as CapitalInstallmentId,
    amount: { amount: asDecimalString(world.installmentAmount), currency: "USD" },
    expectedDestinationAccountId: world.cashAccountId as CashLocationCurrencyAccountId,
    businessEventAt: "2026-09-22T07:00:00.000Z",
    source: { legalEntityId: world.legalEntityId as LegalEntityId,
      idempotencyKey: `treasury-secure-${randomUUID()}` as IdempotencyKey,
      correlationId: randomUUID() as CorrelationId },
    evidence: [await evidence(harness, world.agreementDocumentEvidenceId)]
  });
  const auth = new SandboxAuthenticator(harness.executor, authConfig);
  const cashier = await auth.issueSession({ userAccountId: world.cashierId as UserAccountId,
    legalEntityId: world.legalEntityId as LegalEntityId });
  const verifier = await auth.issueSession({ userAccountId: world.countConfirmerId as UserAccountId,
    legalEntityId: world.legalEntityId as LegalEntityId });
  const bound = await bindSyntheticTreasuryEvidence(harness.executor, world, intent.id);
  await ensureLogin(harness);
  return { world, intentId: intent.id, cashierToken: cashier.token, verifierToken: verifier.token,
    ...bound };
}

async function evidence(harness: Harness, id: string): Promise<EvidenceReference> {
  const result = await harness.executor.query<{
    id: string; document_id: string; evidence_kind: EvidenceReference["kind"];
    evidence_version: number; sha256: string; completed_at: Date | string;
  }>(`SELECT id, document_id, evidence_kind, evidence_version, sha256, completed_at
        FROM abos.evidence_references WHERE id=$1`, [id]);
  const row = result.rows[0];
  assert.ok(row);
  return { id: row.id as EvidenceReference["id"], documentId: row.document_id as EvidenceReference["documentId"],
    kind: row.evidence_kind, version: row.evidence_version, sha256: row.sha256,
    completedAt: new Date(row.completed_at).toISOString() };
}

async function ensureLogin(harness: Harness): Promise<void> {
  const exists = await harness.executor.query<{ exists: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=$1) AS exists", [LOGIN]);
  if (exists.rows[0]?.exists === true) {
    await harness.executor.query(`ALTER ROLE abos_e1_treasury_runtime_test_login LOGIN INHERIT
      PASSWORD 'synthetic-treasury-runtime-only-2026'`);
  } else {
    await harness.executor.query(`CREATE ROLE abos_e1_treasury_runtime_test_login LOGIN INHERIT
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION
      PASSWORD 'synthetic-treasury-runtime-only-2026'`);
  }
  await harness.executor.query("GRANT abos_e1_treasury_runtime TO abos_e1_treasury_runtime_test_login");
}

async function ensureFinanceLogin(harness: Harness): Promise<void> {
  const exists = await harness.executor.query<{ exists: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=$1) AS exists", [FINANCE_LOGIN]);
  if (exists.rows[0]?.exists === true) {
    await harness.executor.query(`ALTER ROLE abos_e1_finance_runtime_test_login LOGIN INHERIT
      PASSWORD 'synthetic-finance-runtime-only-2026'`);
  } else {
    await harness.executor.query(`CREATE ROLE abos_e1_finance_runtime_test_login LOGIN INHERIT
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION
      PASSWORD 'synthetic-finance-runtime-only-2026'`);
  }
  await harness.executor.query("GRANT abos_e1_runtime TO abos_e1_finance_runtime_test_login");
}

async function restricted<T>(operation: (db: SqlExecutor) => Promise<T>): Promise<T> {
  const configured = databaseUrl(); assert.ok(configured);
  const url = new URL(configured); url.username = LOGIN; url.password = PASSWORD;
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
    client.release(); await pool.end();
  }
}

async function financeRestricted<T>(operation: (db: SqlExecutor) => Promise<T>): Promise<T> {
  const configured = databaseUrl(); assert.ok(configured);
  const url = new URL(configured); url.username = FINANCE_LOGIN; url.password = FINANCE_PASSWORD;
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
    client.release(); await pool.end();
  }
}
