import { cookies } from "next/headers";
import pg from "pg";

import type { QueryResult, SqlExecutor } from "@abos/database";
import { SandboxAuthError } from "@abos/sandbox-auth";

import { SESSION_COOKIE, TreasuryUnavailableError } from "@/server/treasury";

/**
 * The restricted Finance database login for the web app, shared by every Finance server module.
 *
 * The E1 Finance inbox (handoff workspace, prepare, approve, post) left the product with migration
 * 0041; the module keeps its name until the deferred authenticator rename, and now only provides the
 * executor and the session token.
 */

pg.types.setTypeParser(1700, (value: string) => value);

class PoolExecutor implements SqlExecutor {
  constructor(private readonly pool: pg.Pool) {}

  async query<Row extends object = Record<string, unknown>>(sql: string, parameters: readonly unknown[] = []): Promise<QueryResult<Row>> {
    const result = await this.pool.query(sql, [...parameters]);
    return { rows: result.rows as Row[], rowCount: result.rowCount ?? 0 };
  }

  async transaction<Result>(operation: (transaction: SqlExecutor) => Promise<Result>): Promise<Result> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const executor: SqlExecutor = {
        query: async <Row extends object = Record<string, unknown>>(sql: string, parameters: readonly unknown[] = []) => {
          const result = await client.query(sql, [...parameters]);
          return { rows: result.rows as Row[], rowCount: result.rowCount ?? 0 };
        },
        transaction: async <Nested>(nested: (tx: SqlExecutor) => Promise<Nested>) => nested(executor)
      };
      const result = await operation(executor);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

interface FinanceRuntime { readonly executor: SqlExecutor }
const globalRuntime = globalThis as typeof globalThis & { __abosFinanceHandoffRuntime?: FinanceRuntime };

export function financeHandoffRuntime(): FinanceRuntime {
  if (globalRuntime.__abosFinanceHandoffRuntime) return globalRuntime.__abosFinanceHandoffRuntime;
  const url = process.env.ABOS_FINANCE_DATABASE_URL;
  if (!url?.trim()) throw new TreasuryUnavailableError("The Finance database login is not configured (ABOS_FINANCE_DATABASE_URL is unset).");
  const executor = new PoolExecutor(new pg.Pool({ connectionString: url, max: 4 }));
  return globalRuntime.__abosFinanceHandoffRuntime = { executor };
}

export async function financeToken(): Promise<string> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) throw new SandboxAuthError("AUTHENTICATION_REQUIRED", "Sign in to continue.");
  return token;
}
