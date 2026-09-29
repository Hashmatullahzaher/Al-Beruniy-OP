import { randomUUID } from "node:crypto";
import pg from "pg";
import type { CashLocationCurrencyAccountId, LegalEntityId, UserAccountId } from "@abos/contracts";
import type { SqlExecutor } from "@abos/database";
import { PostgresExecutor } from "@abos/persistence";
import { SandboxAuthenticator } from "@abos/sandbox-auth";
import { databaseUrl, type Harness } from "./harness.ts";
import { SYNTHETIC_AUTH_CONFIGURATION, treasuryAs, type SyntheticWorld } from "./synthetic-world.ts";

/**
 * Work package C test fixtures (migration 0016). Synthetic only: every name below is labelled
 * synthetic or demonstration, and no rate here is a real market or Saraf rate.
 */

export const MARKER = SYNTHETIC_AUTH_CONFIGURATION.runtimeMarker;
export const FINANCE_LOGIN = { name: "abos_e1_finance_runtime_test_login", password: "synthetic-finance-runtime-only-2026" } as const;

export async function ensureFinanceLogin(harness: Harness): Promise<void> {
  const exists = await harness.executor.query<{ exists: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists", [FINANCE_LOGIN.name]);
  const verb = exists.rows[0]?.exists === true ? "ALTER" : "CREATE";
  const extra = verb === "CREATE" ? " NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION" : "";
  await harness.executor.query(`${verb} ROLE ${FINANCE_LOGIN.name} LOGIN INHERIT${extra} PASSWORD '${FINANCE_LOGIN.password}'`);
}

/** Runs through the restricted runtime login (member of abos_e1_runtime only). */
export async function runtime<T>(operation: (db: SqlExecutor) => Promise<T>): Promise<T> {
  const url = new URL(databaseUrl() ?? "");
  url.username = FINANCE_LOGIN.name; url.password = FINANCE_LOGIN.password;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 1 });
  try {
    return await operation(new PostgresExecutor(pool, { runtimeMarker: MARKER }));
  } finally {
    await pool.end();
  }
}

/** Runs as a role (via the test superuser) inside a transaction that is always rolled back unless commit is set. */
export async function asRole<T>(role: string, work: (client: pg.PoolClient) => Promise<T>, commit = false): Promise<T> {
  const pool = new pg.Pool({ connectionString: databaseUrl(), max: 1 });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL ROLE ${role}`);
    await client.query("SELECT set_config('abos.runtime_marker', $1, true)", [MARKER]);
    try {
      const result = await work(client);
      await client.query(commit ? "COMMIT" : "ROLLBACK");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  } finally {
    client.release();
    await pool.end();
  }
}

export async function grant(database: SqlExecutor, world: SyntheticWorld, userId: string, permissions: readonly string[], legalEntityId = world.legalEntityId): Promise<void> {
  for (const permission of permissions) {
    await database.query(
      `INSERT INTO abos.user_permission_grants (user_account_id, legal_entity_id, permission_code, granted_by_user_account_id)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`, [userId, legalEntityId, permission, world.bootstrapUserId]);
  }
}

export async function sessionFor(database: SqlExecutor, userId: string, legalEntityId: string): Promise<string> {
  const auth = new SandboxAuthenticator(database, SYNTHETIC_AUTH_CONFIGURATION);
  return (await auth.issueSession({ userAccountId: userId as UserAccountId, legalEntityId: legalEntityId as LegalEntityId })).token;
}

/** A synthetic Saraf counterparty with a current SARAF role. */
export async function addSyntheticSaraf(database: SqlExecutor, world: SyntheticWorld, name = "Synthetic Saraf (demonstration)"): Promise<string> {
  const id = randomUUID();
  await database.query(
    `INSERT INTO abos.business_parties (id, legal_entity_id, display_name, external_reference, status)
     VALUES ($1, $2, $3, $4, 'ACTIVE')`, [id, world.legalEntityId, name, `SARAF-${id.slice(0, 8)}`]);
  await database.query(
    "INSERT INTO abos.business_party_roles (business_party_id, role_code, effective_from) VALUES ($1, 'SARAF', current_date - 30)", [id]);
  return id;
}

/** A second synthetic legal entity inside the sandbox scope, with one Finance user. */
export async function addSecondEntity(database: SqlExecutor, world: SyntheticWorld, permissions: readonly string[]): Promise<{ legalEntityId: string; userId: string; token: string }> {
  const companyId = randomUUID(); const legalEntityId = randomUUID(); const userId = randomUUID();
  await database.query("INSERT INTO abos.companies (id, code, name, status) VALUES ($1, $2, 'Synthetic Second Holding', 'ACTIVE')", [companyId, `SYN2-${companyId.slice(0, 8)}`]);
  await database.query(
    `INSERT INTO abos.legal_entities (id, company_id, code, name, base_currency_code, currency_policy_status)
     VALUES ($1, $2, $3, 'Synthetic Second Entity', 'USD', 'APPROVED')`, [legalEntityId, companyId, `SLE2-${legalEntityId.slice(0, 8)}`]);
  await database.query("INSERT INTO abos.sandbox_legal_entity_scopes (legal_entity_id, base_currency_code, authorized_by_user_account_id) VALUES ($1, 'USD', $2)", [legalEntityId, world.bootstrapUserId]);
  await database.query("INSERT INTO abos.user_accounts (id, login_identifier, display_name, status) VALUES ($1, $2, 'Synthetic Second-Entity User', 'ACTIVE')", [userId, `second.${userId.slice(0, 8)}@synthetic.invalid`]);
  await grant(database, world, userId, permissions, legalEntityId);
  return { legalEntityId, userId, token: await sessionFor(database, userId, legalEntityId) };
}

/**
 * Treasury activates the AFN account of the synthetic safe through the real Treasury workflow:
 * the counter counts it (empty synthetic safe), the approver confirms, the reconciler reconciles,
 * the approver approves and activates. Distinct people at every step, as the schema requires.
 */
export async function activateAfnAccount(database: SqlExecutor, world: SyntheticWorld): Promise<void> {
  const evidence = async (kind: string) => {
    const id = randomUUID();
    await database.query(
      `INSERT INTO abos.evidence_references (id, legal_entity_id, document_id, evidence_kind, evidence_version, sha256, completed_at)
       VALUES ($1, $2, gen_random_uuid(), $3, 1, $4, clock_timestamp())`, [id, world.legalEntityId, kind, id.replace(/-/g, "").padEnd(64, "0")]);
    return id;
  };
  const counter = await treasuryAs(database, world, world.counterId);
  const approver = await treasuryAs(database, world, world.treasuryApproverId);
  const reconciler = await treasuryAs(database, world, world.treasuryReconcilerId);
  const account = world.afnCashAccountId as CashLocationCurrencyAccountId;
  const count = await counter.service.recordOpeningCount(counter.actor, { cashAccountId: account, countedAmount: "0", evidenceReferenceId: await evidence("PHYSICAL_CASH_COUNT") });
  await approver.service.confirmOpeningCount(approver.actor, count);
  await reconciler.service.reconcileOpening(reconciler.actor, { cashAccountId: account, physicalCashCountId: count, reconciliationEvidenceReferenceId: await evidence("OPENING_RECONCILIATION") });
  await approver.service.approveOpening(approver.actor, account);
  await approver.service.activateAccount(approver.actor, account);
}

/** A synthetic AFN capital agreement of the world's shareholder, with verified registration and installments. */
export async function addAfnAgreement(database: SqlExecutor, world: SyntheticWorld, input: {
  readonly committedAmount: string; readonly installments: readonly string[]; readonly partialAllowed?: boolean;
}): Promise<{ agreementId: string; installmentIds: string[] }> {
  const agreementId = randomUUID();
  await database.query(
    `INSERT INTO abos.capital_agreements
       (id, legal_entity_id, shareholder_profile_id, agreement_reference, agreement_kind, committed_amount, currency_code,
        effective_on, status, partial_installments_allowed, created_by_user_account_id)
     VALUES ($1, $2, $3, $4, 'CAPITAL_CONTRIBUTION', $5::numeric, 'AFN', '2026-09-01', 'ELIGIBLE', $6, $7)`,
    [agreementId, world.legalEntityId, world.shareholderProfileId, `SYN-AFN-${agreementId.slice(0, 8)}`, input.committedAmount,
      input.partialAllowed ?? false, world.bootstrapUserId]);
  const registrationEvidenceId = randomUUID();
  await database.query(
    `INSERT INTO abos.evidence_references (id, legal_entity_id, document_id, evidence_kind, evidence_version, sha256, completed_at)
     VALUES ($1, $2, gen_random_uuid(), 'FORMAL_REGISTRATION', 1, $3, clock_timestamp())`,
    [registrationEvidenceId, world.legalEntityId, registrationEvidenceId.replace(/-/g, "").padEnd(64, "0")]);
  await database.query(
    `INSERT INTO abos.registration_evidence (id, legal_entity_id, capital_agreement_id, evidence_reference_id, status, verified_by_user_account_id, verified_at)
     VALUES (gen_random_uuid(), $1, $2, $3, 'VERIFIED', $4, clock_timestamp())`,
    [world.legalEntityId, agreementId, registrationEvidenceId, world.bootstrapUserId]);
  // Each agreement carries its own agreement document (0031); one document never evidences two agreements.
  const documentEvidenceId = randomUUID();
  await database.query(
    `INSERT INTO abos.evidence_references (id, legal_entity_id, document_id, evidence_kind, evidence_version, sha256, completed_at)
     VALUES ($1, $2, gen_random_uuid(), 'CAPITAL_AGREEMENT', 1, $3, clock_timestamp())`,
    [documentEvidenceId, world.legalEntityId, documentEvidenceId.replace(/-/g, "").padEnd(64, "0")]);
  await database.query(
    `INSERT INTO abos.capital_agreement_evidence
       (id, legal_entity_id, capital_agreement_id, evidence_reference_id, version, document_reference, document_date, recorded_by_user_account_id)
     VALUES (gen_random_uuid(), $1, $2, $3, 1, 'Synthetic AFN agreement', '2026-09-01', $4)`,
    [world.legalEntityId, agreementId, documentEvidenceId, world.bootstrapUserId]);
  const installmentIds: string[] = [];
  for (const [index, amount] of input.installments.entries()) {
    installmentIds.push(await addInstallmentTo(database, world, agreementId, index + 1, amount, "AFN"));
  }
  return { agreementId, installmentIds };
}

export async function addInstallmentTo(database: SqlExecutor, world: SyntheticWorld, agreementId: string, sequence: number, amount: string, currency: string): Promise<string> {
  const id = randomUUID();
  await database.query(
    `INSERT INTO abos.capital_installments
       (id, legal_entity_id, capital_agreement_id, sequence_number, expected_amount, currency_code, due_on, business_event_at, status, created_by_user_account_id)
     VALUES ($1, $2, $3, $4, $5::numeric, $6, '2026-09-22', '2026-09-22T07:00:00Z', 'PENDING_RECEIPT', $7)`,
    [id, world.legalEntityId, agreementId, sequence, amount, currency, world.bootstrapUserId]);
  return id;
}

// --- Restricted entry points, as the web server calls them. ---------------------------------------

export async function recordRate(db: SqlExecutor, token: string, input: {
  readonly date: string; readonly source?: string; readonly saraf?: string | null; readonly unit?: string; readonly quote?: string; readonly rate: string; readonly note?: string | null;
}): Promise<string> {
  const result = await db.query<{ id: string }>(
    "SELECT abos.finance_record_exchange_rate($1, $2::date, $3, $4::uuid, $5, $6, $7, $8) AS id",
    [token, input.date, input.source ?? "MARKET", input.saraf ?? null, input.unit ?? "USD", input.quote ?? "AFN", input.rate, input.note ?? null]);
  return result.rows[0]?.id ?? "";
}

export async function correctRate(db: SqlExecutor, token: string, rateId: string, rate: string, reason: string | null): Promise<string> {
  const result = await db.query<{ id: string }>("SELECT abos.finance_correct_exchange_rate($1, $2::uuid, $3, $4) AS id", [token, rateId, rate, reason]);
  return result.rows[0]?.id ?? "";
}

export interface RateRow { id: string; rateDate: string; source: string; sarafName: string | null; unitCurrency: string; quoteCurrency: string; rate: string; current: boolean; supersedesId: string | null; supersededById: string | null; correctionReason: string | null; enteredBy: string; snapshotCount: number }
export interface RatesView { canRecord: boolean; rates: RateRow[]; sarafParties: { id: string; name: string }[]; currencies: string[]; legalEntity: { baseCurrency: string } }

export async function ratesView(db: SqlExecutor, token: string, from: string | null = null, to: string | null = null): Promise<RatesView> {
  const result = await db.query<{ value: RatesView }>("SELECT abos.finance_exchange_rates_view($1, $2::date, $3::date) AS value", [token, from, to]);
  const value = result.rows[0]?.value;
  if (value === undefined) throw new Error("no view");
  return value;
}

export async function createRequest(db: SqlExecutor, token: string, input: {
  readonly installmentId: string; readonly destination: string; readonly amount: string; readonly businessDate: string;
  readonly exchangeRateId?: string | null; readonly key?: string;
}): Promise<{ id: string; replayed: boolean; snapshotId: string | null }> {
  const result = await db.query<{ value: { id: string; replayed: boolean; snapshotId: string | null } }>(
    "SELECT abos.shareholder_create_capital_request($1, $2::uuid, $3::uuid, $4, $5::date, $6::uuid, $7) AS value",
    [token, input.installmentId, input.destination, input.amount, input.businessDate, input.exchangeRateId ?? null, input.key ?? randomUUID()]);
  const value = result.rows[0]?.value;
  if (value === undefined) throw new Error("no result");
  return value;
}

export async function shareholderWorkspace<T = Record<string, unknown>>(db: SqlExecutor, token: string): Promise<T> {
  const result = await db.query<{ value: T }>("SELECT abos.shareholder_capital_workspace($1) AS value", [token]);
  const value = result.rows[0]?.value;
  if (value === undefined) throw new Error("no workspace");
  return value;
}

export function isoToday(): string {
  return new Date().toISOString().slice(0, 10);
}
