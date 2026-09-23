import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { resolve } from "node:path";
import type { QueryResult, SqlExecutor } from "./executor.ts";
import {
  applyMigrations,
  assertMigrationSet,
  calculateMigrationChecksum,
  migrationCatalog,
  type LoadedMigration
} from "./migrations.ts";

test("catalog checksum matches canonical migration and no forbidden money/bank schema appears", async () => {
  const migration = await loadMigration();
  assert.equal(calculateMigrationChecksum(migration.sql), migration.checksumSha256);
  assert.doesNotMatch(migration.sql, /\bnumeric\s*\(/i);
  assert.doesNotMatch(migration.sql, /create\s+table\s+(?:if\s+not\s+exists\s+)?abos\.(?:banks?|bank_accounts?)\b/i);
  assert.match(migration.sql, /create\s+table\s+abos\.user_accounts/i);
  assert.match(migration.sql, /create\s+table\s+abos\.business_parties/i);
  assert.match(migration.sql, /create\s+table\s+abos\.ledger_accounts/i);
  assert.match(migration.sql, /create\s+table\s+abos\.companies/i);
  assert.match(migration.sql, /create\s+table\s+abos\.evidence_references/i);
  assert.match(migration.sql, /unique\s*\(legal_entity_id,\s*source_type,\s*source_id\)/i);
  assert.match(migration.sql, /check\s*\(conversion_snapshot_reference\s+is\s+null\)/i);
  assert.match(migration.sql, /posting_approvals[\s\S]*evidence_reference_id\s+uuid\s+not\s+null/i);
  assert.match(migration.sql, /outbox_events[\s\S]*actor_user_account_id\s+uuid\s+not\s+null/i);
});

test("migration text contains fail-closed posting, immutability, reversal, and subledger controls", async () => {
  const { sql } = await loadMigration();
  assert.match(sql, /journals must be assembled as draft and posted by controlled status transition/i);
  assert.match(sql, /create\s+trigger\s+journals_posting_guard\s+before\s+insert\s+or\s+update/i);
  assert.match(sql, /where\s+id\s*=\s*old\.journal_id[\s\S]*where\s+id\s*=\s*new\.journal_id/i);
  assert.match(sql, /where\s+jl\.id\s*=\s*old\.journal_line_id[\s\S]*where\s+jl\.id\s*=\s*new\.journal_line_id/i);
  assert.match(sql, /reversal journal must exactly invert every original journal line/i);
  assert.match(sql, /journal_reversal_links_no_update_or_delete/i);
  assert.match(sql, /posted_reversal_requires_link/i);
  assert.match(sql, /posted financial provenance is immutable/i);
  assert.match(sql, /mapped safe CASH debit and matching shareholder control credit/i);
  assert.match(sql, /posting_intents_one_intent_per_receipt/i);
  assert.match(sql, /SELECT pi\.status, pi\.intent_kind, pi\.source_id/i);
  assert.match(sql, /must remain separate from intent creator, cashier and cash counter/i);
  assert.match(sql, /verified structured formal-registration evidence/i);
  assert.match(sql, /registration_evidence_posted_provenance_guard/i);
  assert.match(sql, /cash_accounts_posted_provenance_guard/i);
  assert.match(sql, /cash_locations_posted_provenance_guard/i);
  assert.match(sql, /posting intent kind must match the capital agreement classification/i);
  assert.match(sql, /effective SHAREHOLDER business-party role/i);
  assert.match(sql, /for\s+share/i);
  assert.match(sql, /se\.cash_location_currency_account_id\s*=\s*treasury_account_id/i);
  assert.match(sql, /jl\.ledger_account_id\s*=\s*treasury_ledger_account_id/i);
  assert.match(sql, /se\.base_amount\s*=\s*case/i);
  assert.match(sql, /cashier or cash counter cannot approve the same intent/i);
});

test("migration runner applies unseen checked migrations in one transaction", async () => {
  const migrations = await loadAllMigrations();
  const executor = new RecordingExecutor([]);
  const applied = await applyMigrations(executor, migrations);
  assert.deepEqual(applied, migrations.map((migration) => migration.id));
  assert.equal(executor.transactionCount, 1);
  assert.equal(executor.queries.some((query) => query.includes("pg_advisory_xact_lock")), true);
  for (const migration of migrations) {
    assert.equal(executor.queries.some((query) => query.includes(migration.sql)), true);
  }
  assert.equal(executor.queries.some((query) => query.includes("INSERT INTO abos.schema_migrations")), true);
});

test("migration runner is idempotent when the recorded checksum matches", async () => {
  const migrations = await loadAllMigrations();
  const executor = new RecordingExecutor(
    migrations.map((migration) => ({
      migration_id: migration.id,
      checksum_sha256: migration.checksumSha256
    }))
  );
  const applied = await applyMigrations(executor, migrations);
  assert.deepEqual(applied, []);
  assert.equal(executor.transactionCount, 1);
});

test("migration drift fails before applying SQL", async () => {
  const migrations = await loadAllMigrations();
  const drifted = migrations.map((migration, index) =>
    index === 0 ? { ...migration, sql: `${migration.sql}\n-- drift` } : migration
  );
  assert.throws(() => assertMigrationSet(drifted), /content checksum mismatch/);
});

test("the E1 sandbox migration is additive and installs the fail-closed gate", async () => {
  const migrations = await loadAllMigrations();
  const e1 = migrations.find((migration) => migration.id === "0002_e1_sandbox_integration");
  assert.ok(e1, "0002 must be in the catalog");
  assert.equal(calculateMigrationChecksum(e1.sql), e1.checksumSha256);

  // 0001 is untouched: its recorded checksum still matches its file byte for byte.
  const e0 = migrations[0] as LoadedMigration;
  assert.equal(e0.id, "0001_e0_finance_foundation");
  assert.equal(calculateMigrationChecksum(e0.sql), e0.checksumSha256);

  // Additive only: nothing is dropped and no 0001 trigger function is rewritten.
  assert.doesNotMatch(e1.sql, /\bdrop\s+(table|trigger|function|column|constraint)\b/i);
  assert.doesNotMatch(e1.sql, /create\s+or\s+replace\s+function\s+abos\.validate_journal_posting/i);
  assert.doesNotMatch(e1.sql, /\bnumeric\s*\(/i);

  // F-3: the gate cannot be satisfied by a caller-supplied object.
  assert.match(e1.sql, /create\s+table\s+abos\.sandbox_authorizations/i);
  assert.match(
    e1.sql,
    /real_posting_enabled\s+boolean\s+not\s+null\s+default\s+false\s+check\s*\(real_posting_enabled\s*=\s*false\)/i
  );
  assert.match(e1.sql, /current_setting\('abos\.runtime_marker',\s*true\)/i);
  assert.match(e1.sql, /this database has none/i);

  // F-2: the persisted source record and a real foreign key from Finance.
  assert.match(e1.sql, /create\s+table\s+abos\.capital_receipt_intents/i);
  assert.match(e1.sql, /posting_intents_capital_source_fk/i);
  assert.match(e1.sql, /unique\s*\(legal_entity_id,\s*capital_installment_id\)/i);

  // F-1: fundability is a recorded decision, and a structurally unfundable status cannot be
  // named in one at all.
  assert.match(e1.sql, /create\s+table\s+abos\.capital_agreement_funding_policies/i);
  assert.match(e1.sql, /fundable_statuses\s*<@\s*array\['PENDING_EVIDENCE',\s*'ELIGIBLE'\]/i);
  assert.match(e1.sql, /nothing is fundable/i);

  // F-4, F-5, F-7.
  assert.match(e1.sql, /from\s+abos\.capital_agreements[\s\S]{0,200}for\s+update/i);
  assert.match(e1.sql, /would exceed the committed amount/i);
  assert.match(e1.sql, /cannot also post its reversal/i);
  assert.match(e1.sql, /has not been confirmed/i);
});

async function loadMigration(): Promise<LoadedMigration> {
  return (await loadAllMigrations())[0] as LoadedMigration;
}

async function loadAllMigrations(): Promise<readonly LoadedMigration[]> {
  return Promise.all(
    migrationCatalog.map(async (definition) => ({
      ...definition,
      sql: await readFile(resolve(import.meta.dirname, "../../../", definition.relativePath), "utf8")
    }))
  );
}

class RecordingExecutor implements SqlExecutor {
  readonly queries: string[] = [];
  transactionCount = 0;
  private readonly appliedRows: readonly Record<string, string>[];

  constructor(appliedRows: readonly Record<string, string>[]) {
    this.appliedRows = appliedRows;
  }

  async query<Row extends object = Record<string, unknown>>(sql: string): Promise<QueryResult<Row>> {
    this.queries.push(sql);
    if (sql.includes("SELECT migration_id")) {
      return { rows: this.appliedRows as readonly Row[], rowCount: this.appliedRows.length };
    }
    return { rows: [], rowCount: 0 };
  }

  async transaction<Result>(operation: (transaction: SqlExecutor) => Promise<Result>): Promise<Result> {
    this.transactionCount += 1;
    return operation(this);
  }
}
