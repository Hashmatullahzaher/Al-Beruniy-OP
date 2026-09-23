import type { QueryResult, SqlExecutor } from "@abos/database";
import type { Pool, PoolClient } from "pg";
import {
  DEFAULT_RETRY_POLICY,
  withRetry,
  type RetryObserver,
  type RetryPolicy
} from "./retry.ts";

export type IsolationLevel = "READ COMMITTED" | "REPEATABLE READ" | "SERIALIZABLE";

export interface PostgresExecutorOptions {
  /**
   * Presented to every transaction before any other statement.
   *
   * Migration 0002 makes each finance mutation trigger read
   * `current_setting('abos.runtime_marker', true)`, so a transaction that does not set it cannot
   * write finance data. It is deliberately required here rather than optional: an executor with no
   * marker is an executor that cannot post, and that should be a configuration error, not a
   * surprise at the first INSERT.
   */
  readonly runtimeMarker: string;
  readonly isolation?: IsolationLevel;
  readonly retry?: RetryPolicy;
  readonly observeRetry?: RetryObserver;
}

/**
 * `SqlExecutor` over a `pg` pool.
 *
 * Transactions are the unit of retry: `transaction()` runs the whole callback again from a fresh
 * connection when PostgreSQL reports a serialization failure or a deadlock, and never when it
 * reports anything else.
 */
export class PostgresExecutor implements SqlExecutor {
  private readonly pool: Pool;
  private readonly options: Required<Omit<PostgresExecutorOptions, "observeRetry">> & {
    readonly observeRetry: RetryObserver;
  };

  constructor(pool: Pool, options: PostgresExecutorOptions) {
    if (typeof options.runtimeMarker !== "string" || options.runtimeMarker.trim().length === 0) {
      throw new Error(
        "PostgresExecutor requires the sandbox runtime marker; without it no finance mutation can succeed"
      );
    }
    this.pool = pool;
    this.options = {
      runtimeMarker: options.runtimeMarker,
      isolation: options.isolation ?? "READ COMMITTED",
      retry: options.retry ?? DEFAULT_RETRY_POLICY,
      observeRetry: options.observeRetry ?? (() => {})
    };
  }

  async query<Row extends object = Record<string, unknown>>(
    sql: string,
    parameters: readonly unknown[] = []
  ): Promise<QueryResult<Row>> {
    const client = await this.pool.connect();
    try {
      // A single statement is its own transaction, so the marker is set for the same statement.
      await client.query("SELECT set_config('abos.runtime_marker', $1, false)", [
        this.options.runtimeMarker
      ]);
      const result = await client.query(sql, [...parameters]);
      return { rows: result.rows as readonly Row[], rowCount: result.rowCount ?? 0 };
    } finally {
      // Reset, so the next borrower of this pooled connection does not inherit the marker.
      try {
        await client.query("SELECT set_config('abos.runtime_marker', '', false)");
      } finally {
        client.release();
      }
    }
  }

  async transaction<Result>(
    operation: (transaction: SqlExecutor) => Promise<Result>
  ): Promise<Result> {
    return withRetry(
      "postgres.transaction",
      () => this.runOnce(operation),
      this.options.retry,
      this.options.observeRetry
    );
  }

  private async runOnce<Result>(
    operation: (transaction: SqlExecutor) => Promise<Result>
  ): Promise<Result> {
    const client = await this.pool.connect();
    try {
      await client.query(`BEGIN ISOLATION LEVEL ${this.options.isolation}`);
      // SET LOCAL: scoped to this transaction, so it cannot leak through the pool.
      await client.query("SELECT set_config('abos.runtime_marker', $1, true)", [
        this.options.runtimeMarker
      ]);
      const result = await operation(new ClientExecutor(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // A rollback failure means the connection is already unusable; the original error is the
        // one worth reporting, so it is deliberately not replaced here.
      }
      throw error;
    } finally {
      client.release();
    }
  }
}

/** A transaction-scoped executor. Nested `transaction()` reuses the same client, as callers expect. */
class ClientExecutor implements SqlExecutor {
  private readonly client: PoolClient;

  constructor(client: PoolClient) {
    this.client = client;
  }

  async query<Row extends object = Record<string, unknown>>(
    sql: string,
    parameters: readonly unknown[] = []
  ): Promise<QueryResult<Row>> {
    const result = await this.client.query(sql, [...parameters]);
    return { rows: result.rows as readonly Row[], rowCount: result.rowCount ?? 0 };
  }

  async transaction<Result>(
    operation: (transaction: SqlExecutor) => Promise<Result>
  ): Promise<Result> {
    return operation(this);
  }
}
