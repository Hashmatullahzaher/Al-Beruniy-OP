/**
 * Local development sandbox for the Treasury interface.
 *
 *   seed      drops and recreates the `abos` schema in the DEV database, seeds the synthetic world
 *             through the real services, creates two ELIGIBLE shareholder capital receipt intents
 *             for Treasury to act on, and prints a session token per synthetic persona.
 *   sessions  issues fresh tokens for the same personas without touching any data.
 *
 * Everything is synthetic. The script refuses any database whose name does not contain "dev" or
 * "sandbox", and any ABOS_ENVIRONMENT other than development or test, because `seed` drops a schema.
 *
 * The web app never picks an identity for you. It accepts one of these tokens, and the server
 * rebuilds the actor from persisted grants on every request.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import type {
  CapitalAgreementId,
  CapitalInstallmentId,
  CashLocationCurrencyAccountId,
  CorrelationId,
  IdempotencyKey,
  LegalEntityId,
  UserAccountId
} from "@abos/contracts";
import { asDecimalString } from "@abos/contracts";
import { PostgresExecutor, PostgresShareholderRepository } from "@abos/persistence";
import { readSandboxConfiguration, SandboxAuthenticator } from "@abos/sandbox-auth";
import { CapitalReceiptIntentService } from "@abos/shareholder";
import { resetSchema } from "../src/harness.ts";
import {
  addInstallment,
  bindSyntheticFinanceApprovalEvidence,
  bindSyntheticTreasuryEvidence,
  seedSyntheticWorld
} from "../src/synthetic-world.ts";

pg.types.setTypeParser(1700, (value: string) => value);

const PERSONAS: readonly (readonly [string, string])[] = [
  ["Synthetic Cashier", "cashier - records, counts and submits receipts"],
  ["Synthetic Count Confirmer", "treasury verifier - confirms counts, verifies, hands to Finance"],
  ["Synthetic Treasury Manager", "manager - safes, accounts, cashier assignment"],
  ["Synthetic Cash Counter", "counter - opening counts"],
  ["Synthetic Treasury Reconciler", "reconciler - opening reconciliation"],
  ["Synthetic Treasury Approver", "approver - approves openings, activates accounts"],
  ["Synthetic Intent Creator", "Finance preparer - creates the posting intent"],
  ["Synthetic Finance Approver", "Finance approver - holds no Treasury permission (proves refusal)"]
];

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command !== "seed" && command !== "sessions") {
    throw new Error("Usage: dev-sandbox.ts seed|sessions");
  }
  const url = process.env.ABOS_DATABASE_URL;
  if (url === undefined || url.trim() === "") throw new Error("ABOS_DATABASE_URL is not set");
  const databaseName = new URL(url).pathname.slice(1);
  if (!/dev|sandbox/i.test(databaseName)) {
    throw new Error(`Refusing to use database "${databaseName}": its name must contain "dev" or "sandbox"`);
  }
  const configuration = readSandboxConfiguration(process.env);

  const pool = new pg.Pool({ connectionString: url, max: 4 });
  const executor = new PostgresExecutor(pool, { runtimeMarker: configuration.runtimeMarker });
  try {
    if (command === "seed") {
      await resetSchema(pool);
      const world = await seedSyntheticWorld(executor, { authConfiguration: configuration });
      const secondInstallment = await addInstallment(executor, world, { sequenceNumber: 2, expectedAmount: "25000.00" });
      const shareholder = new CapitalReceiptIntentService(
        new PostgresShareholderRepository(executor, world.intentCreatorId as UserAccountId));
      const evidence = await executor.query<{
        readonly id: string; readonly document_id: string; readonly evidence_kind: "CAPITAL_AGREEMENT";
        readonly sha256: string; readonly completed_at: Date;
      }>("SELECT id, document_id, evidence_kind, sha256, completed_at FROM abos.evidence_references WHERE id = $1",
        [world.agreementDocumentEvidenceId]);
      const row = evidence.rows[0];
      if (row === undefined) throw new Error("seeded agreement evidence is missing");
      for (const installmentId of [world.installmentId, secondInstallment]) {
        const intent = await shareholder.createCapitalReceiptIntent({
          legalEntityId: world.legalEntityId as LegalEntityId,
          shareholderPartyId: world.businessPartyId as never,
          agreementId: world.agreementId as CapitalAgreementId,
          installmentId: installmentId as CapitalInstallmentId,
          amount: { amount: asDecimalString("25000.00"), currency: "USD" },
          expectedDestinationAccountId: world.cashAccountId as CashLocationCurrencyAccountId,
          businessEventAt: new Date().toISOString(),
          source: {
            legalEntityId: world.legalEntityId as LegalEntityId,
            idempotencyKey: `dev-${randomUUID()}` as IdempotencyKey,
            correlationId: randomUUID() as CorrelationId
          },
          evidence: [{
            id: row.id as never, documentId: row.document_id as never, kind: row.evidence_kind,
            version: 1, sha256: row.sha256, completedAt: row.completed_at.toISOString()
          }]
        });
        await bindSyntheticTreasuryEvidence(executor, world, intent.id);
        await bindSyntheticFinanceApprovalEvidence(executor, world, intent.id);
      }
      process.stdout.write("Seeded a synthetic sandbox with two ELIGIBLE USD capital receipt intents.\n\n");
    }

    const entity = await executor.query<{ readonly legal_entity_id: LegalEntityId }>(
      "SELECT legal_entity_id FROM abos.sandbox_legal_entity_scopes");
    const legalEntityId = entity.rows[0]?.legal_entity_id;
    if (legalEntityId === undefined || entity.rows.length !== 1) {
      throw new Error("Expected exactly one sandbox legal entity; run `seed` first");
    }
    const authenticator = new SandboxAuthenticator(executor, configuration);
    process.stdout.write(`Session tokens (valid ${configuration.maxSessionSeconds}s). Paste one into /finance/treasury.\n\n`);
    for (const [displayName, role] of PERSONAS) {
      const user = await executor.query<{ readonly id: UserAccountId }>(
        "SELECT id FROM abos.user_accounts WHERE display_name = $1", [displayName]);
      const userId = user.rows[0]?.id;
      if (userId === undefined) continue;
      const session = await authenticator.issueSession({ userAccountId: userId, legalEntityId });
      process.stdout.write(`${displayName.padEnd(32)} ${role}\n  ${session.token}\n\n`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
