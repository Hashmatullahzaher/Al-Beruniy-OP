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

test("migration runner applies an unseen checked migration in one transaction", async () => {
  const migration = await loadMigration();
  const executor = new RecordingExecutor([]);
  const applied = await applyMigrations(executor, [migration]);
  assert.deepEqual(applied, [migration.id]);
  assert.equal(executor.transactionCount, 1);
  assert.equal(executor.queries.some((query) => query.includes("pg_advisory_xact_lock")), true);
  assert.equal(executor.queries.some((query) => query.includes(migration.sql)), true);
  assert.equal(executor.queries.some((query) => query.includes("INSERT INTO abos.schema_migrations")), true);
});

test("migration runner is idempotent when the recorded checksum matches", async () => {
  const migration = await loadMigration();
  const executor = new RecordingExecutor([
    { migration_id: migration.id, checksum_sha256: migration.checksumSha256 }
  ]);
  const applied = await applyMigrations(executor, [migration]);
  assert.deepEqual(applied, []);
  assert.equal(executor.transactionCount, 1);
});

test("migration drift fails before applying SQL", async () => {
  const migration = await loadMigration();
  const drifted: LoadedMigration = { ...migration, sql: `${migration.sql}\n-- drift` };
  assert.throws(() => assertMigrationSet([drifted]), /content checksum mismatch/);
});

async function loadMigration(): Promise<LoadedMigration> {
  const definition = migrationCatalog[0];
  const sql = await readFile(resolve(import.meta.dirname, "../../../", definition.relativePath), "utf8");
  return { ...definition, sql };
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
