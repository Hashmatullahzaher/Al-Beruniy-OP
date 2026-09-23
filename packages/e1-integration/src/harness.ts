import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";
import { applyMigrations, migrationCatalog, type LoadedMigration } from "@abos/database";
import { PostgresExecutor } from "@abos/persistence";

/**
 * Real PostgreSQL for the E1 integration suite.
 *
 * There is no in-memory fallback and no skip-if-absent shortcut: if `ABOS_TEST_DATABASE_URL` is
 * unset the suite reports that it cannot run, rather than passing silently and looking like
 * persistence was proved when it was not.
 */
export const DATABASE_URL_VARIABLE = "ABOS_TEST_DATABASE_URL";

export function databaseUrl(): string | undefined {
  const value = process.env[DATABASE_URL_VARIABLE];
  return value === undefined || value.trim().length === 0 ? undefined : value;
}

export const MISSING_DATABASE_MESSAGE =
  `${DATABASE_URL_VARIABLE} is not set, so the E1 PostgreSQL integration suite cannot run. ` +
  "These tests prove persistence and concurrency; nothing else in the repository proves them, " +
  "so a skipped run means those properties are unproved, not satisfied. " +
  "Start a sandbox database and export the URL - see packages/e1-integration/README.md.";

/** `numeric` must never be parsed into a JavaScript number; keep it as exact decimal text. */
pg.types.setTypeParser(1700, (value: string) => value);

export interface Harness {
  readonly pool: pg.Pool;
  readonly executor: PostgresExecutor;
  close(): Promise<void>;
}

export async function openHarness(runtimeMarker: string): Promise<Harness> {
  const url = databaseUrl();
  if (url === undefined) throw new Error(MISSING_DATABASE_MESSAGE);

  const pool = new pg.Pool({ connectionString: url, max: 8 });
  const executor = new PostgresExecutor(pool, { runtimeMarker });
  return {
    pool,
    executor,
    close: async () => {
      await pool.end();
    }
  };
}

/**
 * Applies both migrations to a clean schema.
 *
 * The schema is dropped first, so every run starts from nothing and a test cannot pass because of
 * something an earlier run left behind.
 */
export async function resetSchema(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    // A session-level advisory lock, so two suites resetting the same database serialize instead
    // of racing each other's DROP and CREATE.
    await client.query("SELECT pg_advisory_lock(hashtextextended('abos-e1-reset', 0))");
    await client.query("DROP SCHEMA IF EXISTS abos CASCADE");
    await client.query("SELECT pg_advisory_unlock(hashtextextended('abos-e1-reset', 0))");
  } finally {
    client.release();
  }

  const migrations = await loadMigrations();
  const bootstrap = {
    query: async (sql: string, parameters: readonly unknown[] = []) => {
      const result = await pool.query(sql, [...parameters]);
      return { rows: result.rows, rowCount: result.rowCount ?? 0 };
    },
    transaction: async <Result>(
      operation: (transaction: {
        query: (sql: string, parameters?: readonly unknown[]) => Promise<unknown>;
      }) => Promise<Result>
    ): Promise<Result> => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await operation({
          query: async (sql: string, parameters: readonly unknown[] = []) => {
            const inner = await client.query(sql, [...parameters]);
            return { rows: inner.rows, rowCount: inner.rowCount ?? 0 };
          }
        });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
  };
  // The migration runner only needs query/transaction, which the shim above provides.
  await applyMigrations(bootstrap as never, migrations);
}

export async function loadMigrations(): Promise<readonly LoadedMigration[]> {
  const root = resolve(import.meta.dirname, "../../..");
  return Promise.all(
    migrationCatalog.map(async (definition) => ({
      ...definition,
      sql: await readFile(resolve(root, definition.relativePath), "utf8")
    }))
  );
}
