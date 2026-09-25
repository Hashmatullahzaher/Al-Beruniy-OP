/**
 * WP-C preview fixture, run after `preview:seed` on the same DISPOSABLE database:
 *   node --experimental-strip-types packages/e1-integration/src/currency-preview-fixture.ts
 *
 * Adds synthetic data the currency demonstration needs: a third USD installment (the seed already
 * requested the first two), a synthetic AFN capital agreement with two installments, a synthetic
 * Saraf, and the AFN account of the synthetic safe activated through the real Treasury workflow.
 * Nothing here is company data; no exchange rate is recorded (a Finance user does that in the app).
 */
import pg from "pg";
import { PostgresExecutor } from "@abos/persistence";
import { readSandboxConfiguration } from "@abos/sandbox-auth";
import { activateAfnAccount, addAfnAgreement, addInstallmentTo, addSyntheticSaraf } from "./currency-fixtures.ts";
import type { SyntheticWorld } from "./synthetic-world.ts";

pg.types.setTypeParser(1700, (value: string) => value);

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
    const agreement = await one<{ id: string; shareholder_profile_id: string }>(
      "SELECT id, shareholder_profile_id FROM abos.capital_agreements WHERE legal_entity_id = $1 AND currency_code = 'USD' ORDER BY created_at LIMIT 1", [entity.id]);
    const afnAccount = await one<{ id: string }>(
      "SELECT id FROM abos.cash_location_currency_accounts WHERE legal_entity_id = $1 AND currency_code = 'AFN'", [entity.id]);
    const world = {
      legalEntityId: entity.id, authConfiguration: configuration, bootstrapUserId: await person("Sandbox Bootstrap"),
      counterId: await person("Synthetic Cash Counter"), treasuryApproverId: await person("Synthetic Treasury Approver"),
      treasuryReconcilerId: await person("Synthetic Treasury Reconciler"), afnCashAccountId: afnAccount.id,
      shareholderProfileId: agreement.shareholder_profile_id, agreementId: agreement.id
    } as unknown as SyntheticWorld;
    const next = await one<{ n: number }>("SELECT coalesce(max(sequence_number), 0) + 1 AS n FROM abos.capital_installments WHERE capital_agreement_id = $1", [agreement.id]);
    await addInstallmentTo(owner, world, agreement.id, next.n, "25000.00", "USD");
    await addAfnAgreement(owner, world, { committedAmount: "3565000", installments: ["1782500", "1782500"] });
    await addSyntheticSaraf(owner, world);
    await activateAfnAccount(owner, world);
    process.stdout.write("WP-C preview fixture added (synthetic): USD installment, AFN agreement, Saraf, active AFN safe account.\n");
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
