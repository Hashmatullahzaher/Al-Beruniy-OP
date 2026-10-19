/**
 * Bootstrap only the restricted database LOGIN roles required by the authenticated 0038 browser
 * test. Business fixtures remain owned by preview-seed and capital-activation-preview.
 *
 * This command is intentionally destructive only inside the exactly named disposable browser DB.
 */
import pg from "pg";
import { resetSchema, withClusterLock } from "../src/harness.ts";

const databaseUrl = process.env.ABOS_DATABASE_URL;
if (!databaseUrl?.trim()) throw new Error("ABOS_DATABASE_URL is required");
const databaseName = new URL(databaseUrl).pathname.slice(1);
const databaseAddress = new URL(databaseUrl);
if (databaseName !== "abos_capital_browser_preview_0038" || databaseAddress.hostname !== "127.0.0.1" || databaseAddress.port !== "55442") {
  throw new Error("Refusing to bootstrap outside the dedicated disposable browser database at 127.0.0.1:55442");
}

const logins = [
  {
    name: "abos_v1_identity_runtime_test_login",
    password: "synthetic-identity-runtime-only-2026",
    role: "abos_v1_identity_runtime"
  },
  {
    name: "abos_e1_finance_runtime_test_login",
    password: "synthetic-finance-runtime-only-2026",
    role: "abos_e1_runtime"
  },
  {
    name: "abos_e1_treasury_runtime_test_login",
    password: "synthetic-treasury-runtime-only-2026",
    role: "abos_e1_treasury_runtime"
  }
] as const;

const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
try {
  await resetSchema(pool);
  await withClusterLock(pool, async () => {
    for (const login of logins) {
      await pool.query(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${login.name}') THEN
          CREATE ROLE ${login.name} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
        END IF;
      END $$`);
      await pool.query(`ALTER ROLE ${login.name} LOGIN INHERIT PASSWORD '${login.password}'`);
      await pool.query(`GRANT ${login.role} TO ${login.name}`);
    }
  });
  process.stdout.write("Disposable capital browser database and restricted logins are ready.\n");
} finally {
  await pool.end();
}
