import { createHash } from "node:crypto";

import type { SqlExecutor } from "./executor.ts";

export interface MigrationDefinition {
  readonly id: string;
  readonly checksumSha256: string;
  readonly relativePath: string;
}

export interface LoadedMigration extends MigrationDefinition {
  readonly sql: string;
}

export const migrationCatalog = [
  {
    id: "0001_e0_finance_foundation",
    checksumSha256: "babff85293e0addc526c6b1c39dd3fdbb9da0bd6c8038443069584dc42f7f6ef",
    relativePath:
      "infrastructure/database/migrations/0001_e0_finance_foundation.sql",
  },
  {
    id: "0002_e1_sandbox_integration",
    checksumSha256: "a559c14d139570273693edf282304a3932ed94f1ba9fe963683bf7e548637204",
    relativePath:
      "infrastructure/database/migrations/0002_e1_sandbox_integration.sql",
  },
  {
    id: "0003_e1_commitment_concurrency",
    checksumSha256: "d976a9c2930915086f84b5e2e30aaa2cce57ab3de4d3412bf4a8eed33cc5c7b2",
    relativePath: "infrastructure/database/migrations/0003_e1_commitment_concurrency.sql",
  },
  {
    id: "0004_e1_runtime_role",
    checksumSha256: "5ef214d258a1bab6cad51f2100fdfd3e3f628efe972ad21fdade8541b5ea1ffd",
    relativePath: "infrastructure/database/migrations/0004_e1_runtime_role.sql",
  },
  {
    id: "0005_e1_capital_provenance",
    checksumSha256: "6801fdec89a895d3ae5f0cbbb49f62a6f4184d6a652ea55e108388fc0f3c6236",
    relativePath: "infrastructure/database/migrations/0005_e1_capital_provenance.sql",
  },
  {
    id: "0006_e1_treasury",
    checksumSha256: "1342a73cc424b7e8ac9212235127a7575dde71bb4f43945b198c035d70fbf23a",
    relativePath: "infrastructure/database/migrations/0006_e1_treasury.sql",
  },
] as const satisfies readonly MigrationDefinition[];

const migrationTableSql = `
  CREATE SCHEMA IF NOT EXISTS abos;
  CREATE TABLE IF NOT EXISTS abos.schema_migrations (
    migration_id text PRIMARY KEY,
    checksum_sha256 text NOT NULL
      CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
    applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
  )
`;

interface AppliedMigrationRow {
  readonly migration_id: string;
  readonly checksum_sha256: string;
}

export async function applyMigrations(
  database: SqlExecutor,
  migrations: readonly LoadedMigration[],
): Promise<readonly string[]> {
  assertMigrationSet(migrations);
  await database.query(migrationTableSql);

  return database.transaction(async (transaction) => {
    await transaction.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('abos-schema-migrations', 0))",
    );
    const applied = await transaction.query<AppliedMigrationRow>(
      "SELECT migration_id, checksum_sha256 FROM abos.schema_migrations",
    );
    const appliedById = new Map(
      applied.rows.map((row) => [row.migration_id, row.checksum_sha256]),
    );
    const appliedNow: string[] = [];

    for (const migration of migrations) {
      const recordedChecksum = appliedById.get(migration.id);
      if (recordedChecksum !== undefined) {
        if (recordedChecksum !== migration.checksumSha256) {
          throw new Error(
            `Migration checksum mismatch for ${migration.id}: database=${recordedChecksum}, code=${migration.checksumSha256}`,
          );
        }
        continue;
      }

      await transaction.query(migration.sql);
      await transaction.query(
        `INSERT INTO abos.schema_migrations
          (migration_id, checksum_sha256)
         VALUES ($1, $2)`,
        [migration.id, migration.checksumSha256],
      );
      appliedNow.push(migration.id);
    }

    return appliedNow;
  });
}

export function calculateMigrationChecksum(sql: string): string {
  const canonicalSql = sql.replace(/\r\n?/g, "\n");
  return createHash("sha256").update(canonicalSql, "utf8").digest("hex");
}

export function assertMigrationSet(
  loaded: readonly LoadedMigration[],
): void {
  const catalogById = new Map<string, MigrationDefinition>(
    migrationCatalog.map((item) => [item.id, item]),
  );
  if (loaded.length !== migrationCatalog.length) {
    throw new Error("Loaded migration count does not match the catalog");
  }

  for (const migration of loaded) {
    const expected = catalogById.get(migration.id);
    if (expected === undefined) {
      throw new Error(`Unknown migration: ${migration.id}`);
    }
    if (migration.relativePath !== expected.relativePath) {
      throw new Error(`Unexpected migration path for ${migration.id}`);
    }
    if (migration.checksumSha256 !== expected.checksumSha256) {
      throw new Error(`Unexpected migration checksum for ${migration.id}`);
    }
    if (calculateMigrationChecksum(migration.sql) !== expected.checksumSha256) {
      throw new Error(`Migration content checksum mismatch for ${migration.id}`);
    }
  }
}
