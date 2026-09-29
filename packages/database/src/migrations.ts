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
  {
    id: "0007_e1_secure_posting_boundary",
    checksumSha256: "0acbd2aecb4e9eed22641f802d811f1b7bdbf1418111e9010ff722729b162b3d",
    relativePath: "infrastructure/database/migrations/0007_e1_secure_posting_boundary.sql",
  },
  {
    id: "0008_e1_secure_treasury_boundary",
    checksumSha256: "b5082ff45fe609448ae9564ed915f4115ed30dbee30dff84f21b6713a80463f1",
    relativePath: "infrastructure/database/migrations/0008_e1_secure_treasury_boundary.sql",
  },
  {
    id: "0009_e1_finance_handoff_workflow",
    checksumSha256: "424cdc47f2b494e642c2e413dfb1950286c01d110a2900abbdeb06e66909d87b",
    relativePath: "infrastructure/database/migrations/0009_e1_finance_handoff_workflow.sql",
  },
  {
    id: "0010_v1_identity_admin",
    checksumSha256: "d3e798a0b3799a68c15f5bdb47792fe4d9e440989170b540dff17edd5d44a619",
    relativePath: "infrastructure/database/migrations/0010_v1_identity_admin.sql",
  },
  {
    id: "0011_v1_definer_least_privilege",
    checksumSha256: "897125905855c7c6b868392f09f5a8b8926d89fa735603314b477cff12c7a1bc",
    relativePath: "infrastructure/database/migrations/0011_v1_definer_least_privilege.sql",
  },
  {
    id: "0012_v1_financial_calendar",
    checksumSha256: "3ae4c20a38111cc6fa3ebb5e7bab464b19fa1c15cef1c512bb7572251fbb8bac",
    relativePath: "infrastructure/database/migrations/0012_v1_financial_calendar.sql",
  },
  {
    id: "0013_v1_phase1_contracts",
    checksumSha256: "882c15d1640599f5c6195c606f8881623f4774cc9a4e7e7c8ef09a4afcf3ba45",
    relativePath: "infrastructure/database/migrations/0013_v1_phase1_contracts.sql",
  },
  {
    id: "0014_v1_chart_of_accounts",
    checksumSha256: "c26e44dc503941939f43b040116380698b2cca01c12ccd5694edc5e1f9da42b4",
    relativePath: "infrastructure/database/migrations/0014_v1_chart_of_accounts.sql",
  },
  // WP-B (V1 Phase 1): safes and Saraf accounts, whole-safe counts.
  {
    id: "0015_v1_safes_saraf",
    checksumSha256: "23c2ff04bfb71d65a0713833810a5c39181c2d948ac225dd86239d5dda9ce84b",
    relativePath: "infrastructure/database/migrations/0015_v1_safes_saraf.sql",
  },
  // WP-C (lead resolves merge order with 0014/0015).
  {
    id: "0016_v1_currency_rates",
    checksumSha256: "35a9f511935dd2e3452556e80e3eccd2a778286489f3e1533ce038867ec0f298",
    relativePath: "infrastructure/database/migrations/0016_v1_currency_rates.sql",
  },
  // Lead (#8): company profile.
  {
    id: "0017_v1_company_profile",
    checksumSha256: "68edc2a10ce160088c45c1ae4ca589cf0ebefac1157223947cdeb6dc276a7a30",
    relativePath: "infrastructure/database/migrations/0017_v1_company_profile.sql",
  },
  {
    id: "0019_v1_finance_trace_precision",
    checksumSha256: "2520527f85f09c3dffb18e6986af188776037dd641f86db1f40c19960d29078a",
    relativePath: "infrastructure/database/migrations/0019_v1_finance_trace_precision.sql",
  },
  {
    id: "0020_v1_general_ledger_read",
    checksumSha256: "99c773e2613aaccf7b1bfcaca2f9cda28dc63d7488b54bcd6ea5d6b04485fd07",
    relativePath: "infrastructure/database/migrations/0020_v1_general_ledger_read.sql",
  },
  {
    id: "0021_v1_identity_privilege_boundary",
    checksumSha256: "6c81a199c890e7086aa7328e5cb971b9a138a35145934c9dc6456916e96df4be",
    relativePath: "infrastructure/database/migrations/0021_v1_identity_privilege_boundary.sql",
  },
  // 0018 was never created and is permanently retired: a late 0018 would run in a different order
  // on existing and new databases. See docs/04-delivery/V1_PHASE2_TAKEOVER_REVIEW.md section 4.
  {
    id: "0022_v1_identity_actor_context_fix",
    checksumSha256: "e6fadd3bc0775beb8845534c9ae3dded946e39440aa0fe38ba195063231119c5",
    relativePath: "infrastructure/database/migrations/0022_v1_identity_actor_context_fix.sql",
  },
  // WP #17: controlled reversal requests (request -> Finance Manager decision; posting fail-closed).
  {
    id: "0023_v1_reversal_requests",
    checksumSha256: "b56e026ee8612c921cf2a4815a75bcdfda43a72932e824e4da363ad1bd570242",
    relativePath: "infrastructure/database/migrations/0023_v1_reversal_requests.sql",
  },
  // WP #19 (GL activity): per-account posted activity and keyset paging of GL lines.
  {
    id: "0024_v1_general_ledger_activity",
    checksumSha256: "c740480479adedffcf45a3ed0f0f9fccb67ba7bd8270634f557e9eb2f069c43c",
    relativePath: "infrastructure/database/migrations/0024_v1_general_ledger_activity.sql",
  },
  // Operational Finance foundation: append-only, per-entity approval policy configuration.
  {
    id: "0025_v1_workflow_approval_policy",
    checksumSha256: "1a11e91aaf06bb20c53b8fa2bd9c03d51ea22383f5abedf34cf4468f31486426",
    relativePath: "infrastructure/database/migrations/0025_v1_workflow_approval_policy.sql",
  },
  // Least privilege: the policy owner may read only account identifiers and display names.
  {
    id: "0026_v1_workflow_policy_owner_read_scope",
    checksumSha256: "f3a8080fdd92c163d667058016c0d705fdb35cb4496c254acd05e6ee999710f0",
    relativePath: "infrastructure/database/migrations/0026_v1_workflow_policy_owner_read_scope.sql",
  },
  // Operational Finance configuration only: accounts/categories and PENDING -> OPEN authority.
  {
    id: "0027_v1_operational_finance_configuration",
    checksumSha256: "2863faed4fecd5a3fc96a12294552b224a49dbc845317ac637e78e4ac19e6ff0",
    relativePath: "infrastructure/database/migrations/0027_v1_operational_finance_configuration.sql",
  },
  // Protected Operational V1 expense posting lane; legacy E1 remains synthetic-only.
  {
    id: "0028_v1_operational_expense_posting",
    checksumSha256: "676082f3365986cb4983a521067c44cc91e71eca0b90d20495bfef9ff855b90a",
    relativePath: "infrastructure/database/migrations/0028_v1_operational_expense_posting.sql",
  },
  // Read-only Operational Finance model: Record Expense options and the Daily Financial Report.
  {
    id: "0029_v1_operational_finance_read_model",
    checksumSha256: "f1d6f629e4f35572b2c191c64d295f5465537850cdba0d2f26cde97e67ef09e5",
    relativePath: "infrastructure/database/migrations/0029_v1_operational_finance_read_model.sql",
  },
  {
    id: "0030_v1_company_dashboard",
    checksumSha256: "19c3f68fc0f4322529b7033d91407bd0397bd90ecb0e944a16510b32a2353afb",
    relativePath: "infrastructure/database/migrations/0030_v1_company_dashboard.sql",
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
