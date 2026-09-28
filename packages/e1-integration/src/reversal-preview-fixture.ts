/**
 * WP #17 preview fixture, run after `preview:seed` on the same DISPOSABLE database:
 *   node --experimental-strip-types packages/e1-integration/src/reversal-preview-fixture.ts
 *
 * Posts ONE synthetic USD capital journal through the real Treasury workflow and the restricted
 * posting function, so the reversal screens have a posted journal to work with. The journal is
 * prepared and posted by two extra synthetic people ("Synthetic Earlier Preparer" and "Synthetic
 * Earlier Poster") who have no sign-in, so the demo's Finance people took no part in it and the
 * conservative participant rule does not stop them from requesting or deciding its reversal.
 * Nothing here is company data. It prints the journal reference as JOURNAL_REFERENCE=<reference>.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import type {
  CapitalAgreementId, CapitalInstallmentId, CashLocationCurrencyAccountId, CorrelationId, IdempotencyKey, LegalEntityId,
  PostingIntentId, UserAccountId
} from "@abos/contracts";
import { asDecimalString } from "@abos/contracts";
import { PostgresExecutor, PostgresShareholderRepository, RestrictedCapitalPostingGateway } from "@abos/persistence";
import { readSandboxConfiguration, SandboxAuthenticator } from "@abos/sandbox-auth";
import { CapitalReceiptIntentService } from "@abos/shareholder";
import {
  addInstallment, handOffSyntheticReceipt, recordCapitalPostingIntent, recordSyntheticTreasuryReceipt, type SyntheticWorld
} from "./synthetic-world.ts";

pg.types.setTypeParser(1700, (value: string) => value);

const AMOUNT = "25000.00";

async function main(): Promise<void> {
  const url = process.env.ABOS_DATABASE_URL;
  if (!url?.trim()) throw new Error("ABOS_DATABASE_URL is not set");
  const databaseName = new URL(url).pathname.slice(1);
  if (!/dev|sandbox|preview/i.test(databaseName)) throw new Error(`Refusing to change "${databaseName}": its name must contain dev, sandbox or preview`);
  const configuration = readSandboxConfiguration(process.env);
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  const owner = new PostgresExecutor(pool, { runtimeMarker: configuration.runtimeMarker });
  try {
    const one = async <T extends object>(sql: string, parameters: readonly unknown[] = []): Promise<T> => {
      const row = (await owner.query<T>(sql, parameters)).rows[0];
      if (row === undefined) throw new Error(`preview data missing: ${sql}`);
      return row;
    };
    const entity = await one<{ id: string }>("SELECT legal_entity_id AS id FROM abos.sandbox_legal_entity_scopes LIMIT 1");
    const person = async (name: string) => (await one<{ id: string }>("SELECT id FROM abos.user_accounts WHERE display_name = $1", [name])).id;
    const evidence = async (kind: string) => (await one<{ id: string }>(
      "SELECT id FROM abos.evidence_references WHERE legal_entity_id = $1 AND evidence_kind = $2 ORDER BY created_at, id LIMIT 1", [entity.id, kind])).id;
    const agreement = await one<{ id: string; business_party_id: string }>(
      `SELECT a.id, p.business_party_id FROM abos.capital_agreements a JOIN abos.shareholder_profiles p ON p.id = a.shareholder_profile_id
        WHERE a.legal_entity_id = $1 AND a.currency_code = 'USD' ORDER BY a.created_at LIMIT 1`, [entity.id]);
    const safeAccount = await one<{ id: string }>(
      "SELECT id FROM abos.cash_location_currency_accounts WHERE legal_entity_id = $1 AND currency_code = 'USD' AND activation_status = 'ACTIVE'", [entity.id]);
    const period = await one<{ id: string }>(
      "SELECT id FROM abos.accounting_periods WHERE legal_entity_id = $1 AND status = 'OPEN' AND DATE '2026-09-22' BETWEEN starts_on AND ends_on", [entity.id]);
    const bootstrap = await person("Sandbox Bootstrap");

    // Two synthetic people who prepare and post the journal. They have no sign-in.
    const earlier: string[] = [];
    for (const name of ["Synthetic Earlier Preparer", "Synthetic Earlier Poster"]) {
      const id = randomUUID();
      await owner.query("INSERT INTO abos.user_accounts (id, login_identifier, display_name, status) VALUES ($1, $2, $3, 'ACTIVE')",
        [id, `${name.toLowerCase().replace(/\s+/g, ".")}.${id.slice(0, 8)}@synthetic.invalid`, name]);
      earlier.push(id);
    }
    const [preparerId = "", posterId = ""] = earlier;
    for (const permission of ["finance.posting-intent.approve", "finance.journal.post"]) {
      await owner.query(`INSERT INTO abos.user_permission_grants (user_account_id, legal_entity_id, permission_code, granted_by_user_account_id)
                         VALUES ($1, $2, $3, $4)`, [posterId, entity.id, permission, bootstrap]);
    }

    const world = {
      legalEntityId: entity.id, authConfiguration: configuration, bootstrapUserId: bootstrap, agreementId: agreement.id,
      cashierId: await person("Synthetic Cashier"), countConfirmerId: await person("Synthetic Count Confirmer"),
      countEvidenceId: await evidence("PHYSICAL_CASH_COUNT"), receiptEvidenceId: await evidence("CASH_RECEIPT"),
      approvalEvidenceId: await evidence("FINANCE_APPROVAL"), accountingEffectiveDate: "2026-09-22",
      intentCreatorId: preparerId, approverId: posterId
    } as unknown as SyntheticWorld;

    const next = await one<{ n: number }>("SELECT coalesce(max(sequence_number), 0) + 1 AS n FROM abos.capital_installments WHERE capital_agreement_id = $1", [agreement.id]);
    const installmentId = await addInstallment(owner, world, { sequenceNumber: next.n, expectedAmount: AMOUNT });
    const agreementEvidence = await one<{ id: string; document_id: string; evidence_kind: "CAPITAL_AGREEMENT"; evidence_version: number; sha256: string; completed_at: Date }>(
      `SELECT id, document_id, evidence_kind, evidence_version, sha256, completed_at FROM abos.evidence_references
        WHERE legal_entity_id = $1 AND evidence_kind = 'CAPITAL_AGREEMENT' ORDER BY created_at, id LIMIT 1`, [entity.id]);
    const intent = await new CapitalReceiptIntentService(new PostgresShareholderRepository(owner, await person("Synthetic Intent Creator") as UserAccountId))
      .createCapitalReceiptIntent({
        legalEntityId: entity.id as LegalEntityId, shareholderPartyId: agreement.business_party_id as never,
        agreementId: agreement.id as CapitalAgreementId, installmentId: installmentId as CapitalInstallmentId,
        amount: { amount: asDecimalString(AMOUNT), currency: "USD" },
        expectedDestinationAccountId: safeAccount.id as CashLocationCurrencyAccountId,
        businessEventAt: "2026-09-22T07:00:00.000Z",
        source: { legalEntityId: entity.id as LegalEntityId, idempotencyKey: `reversal-preview-${randomUUID()}` as IdempotencyKey, correlationId: randomUUID() as CorrelationId },
        evidence: [{ id: agreementEvidence.id as never, documentId: agreementEvidence.document_id as never, kind: agreementEvidence.evidence_kind,
          version: agreementEvidence.evidence_version, sha256: agreementEvidence.sha256, completedAt: agreementEvidence.completed_at.toISOString() }]
      });
    const receipt = await recordSyntheticTreasuryReceipt(owner, world, { capitalReceiptIntentId: intent.id, amount: AMOUNT });
    await handOffSyntheticReceipt(owner, world, receipt.cashReceiptId);
    const postingIntentId = await recordCapitalPostingIntent(owner, world, {
      capitalReceiptIntentId: intent.id, cashReceiptId: receipt.cashReceiptId, amount: AMOUNT,
      idempotencyKey: `reversal-preview-post-${randomUUID()}`, correlationId: randomUUID()
    });
    const token = (await new SandboxAuthenticator(owner, configuration).issueSession({ userAccountId: posterId as UserAccountId, legalEntityId: entity.id as LegalEntityId })).token;
    const journalId = await new RestrictedCapitalPostingGateway(owner).post({
      bearerToken: token, postingIntentId: postingIntentId as PostingIntentId, accountingPeriodId: period.id as never
    });
    const journal = await one<{ journal_reference: string }>("SELECT journal_reference FROM abos.journals WHERE id = $1", [journalId]);
    process.stdout.write(`WP #17 preview fixture added (synthetic): one posted USD capital journal by synthetic people without sign-in.\nJOURNAL_REFERENCE=${journal.journal_reference}\n`);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
