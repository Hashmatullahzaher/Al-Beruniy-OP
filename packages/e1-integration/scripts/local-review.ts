/**
 * Local V1 review environment.
 *
 * This is deliberately separate from preview:seed/dev-sandbox. It never seeds demo business data.
 * The operator supplies the real initial company/entity/admin values; everything else is entered
 * through the V1 application.
 *
 * Commands:
 *   setup   start local PostgreSQL, apply migrations, create restricted DB logins and bootstrap
 *           the owner-supplied company shell + first Super Administrator.
 *   reset   drop only the designated local-review abos schema and reapply migrations, leaving it
 *           empty. Requires --confirm RESET-LOCAL-V1.
 *   status  report migration/data counts and refuse to call synthetic/demo rows "ready".
 */
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import pg from "pg";
import { applyMigrations } from "@abos/database";
import { bootstrapSuperAdmin } from "@abos/identity";
import { PostgresExecutor } from "@abos/persistence";
import { identityDatabaseProofDigest } from "@abos/sandbox-auth";
import { loadMigrations } from "../src/harness.ts";

pg.types.setTypeParser(1700, (value: string) => value);

const ROOT = resolve(import.meta.dirname, "../../..");
const SECRETS_FILE = resolve(ROOT, ".env.local-review.local");
const WEB_ENV_FILE = resolve(ROOT, "apps/web/.env.local");
const COMPOSE_FILE = resolve(ROOT, "infrastructure/local-review/docker-compose.yml");
const DATABASE_NAME = "abos_v1_local_review";
const OPERATOR = "abos_local_operator";
const TREASURY_LOGIN = "abos_v1_local_treasury";
const FINANCE_LOGIN = "abos_v1_local_finance";
const IDENTITY_LOGIN = "abos_v1_local_identity";
const HOST = "127.0.0.1";
const PORT = 55432;

interface Secrets {
  readonly ABOS_LOCAL_POSTGRES_PASSWORD: string;
  readonly ABOS_LOCAL_TREASURY_PASSWORD: string;
  readonly ABOS_LOCAL_FINANCE_PASSWORD: string;
  readonly ABOS_LOCAL_IDENTITY_PASSWORD: string;
  readonly ABOS_SANDBOX_RUNTIME_MARKER: string;
  readonly ABOS_SANDBOX_SIGNING_SECRET: string;
}

interface BootstrapInput {
  readonly companyCode: string;
  readonly companyName: string;
  readonly entityCode: string;
  readonly entityName: string;
  readonly adminLogin: string;
  readonly adminName: string;
}

function randomSecret(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function run(command: string, args: readonly string[], quiet = false): void {
  const result = spawnSync(command, [...args], {
    cwd: ROOT,
    stdio: quiet ? "pipe" : "inherit",
    encoding: "utf8",
    shell: false
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = quiet ? String(result.stderr || result.stdout || "").trim() : "";
    throw new Error(`${command} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
}

function composeArgs(...args: string[]): string[] {
  return ["compose", "--env-file", SECRETS_FILE, "-f", COMPOSE_FILE, ...args];
}

async function loadOrCreateSecrets(): Promise<Secrets> {
  try {
    const text = await readFile(SECRETS_FILE, "utf8");
    return parseSecrets(text);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const secrets: Secrets = {
    ABOS_LOCAL_POSTGRES_PASSWORD: randomSecret(),
    ABOS_LOCAL_TREASURY_PASSWORD: randomSecret(),
    ABOS_LOCAL_FINANCE_PASSWORD: randomSecret(),
    ABOS_LOCAL_IDENTITY_PASSWORD: randomSecret(),
    ABOS_SANDBOX_RUNTIME_MARKER: `local-review-${randomBytes(18).toString("hex")}`,
    ABOS_SANDBOX_SIGNING_SECRET: randomSecret(48)
  };
  const body = [
    "# Generated locally by pnpm v1:local:setup. Never commit or share this file.",
    ...Object.entries(secrets).map(([key, value]) => `${key}=${value}`),
    ""
  ].join("\n");
  await writeFile(SECRETS_FILE, body, { encoding: "utf8", mode: 0o600 });
  await chmod(SECRETS_FILE, 0o600).catch(() => undefined);
  return secrets;
}

function parseSecrets(text: string): Secrets {
  const values = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const at = line.indexOf("=");
    if (at > 0) values.set(line.slice(0, at), line.slice(at + 1));
  }
  const required = (name: keyof Secrets): string => {
    const value = values.get(name);
    if (!value) throw new Error(`${SECRETS_FILE} is missing ${name}`);
    return value;
  };
  return {
    ABOS_LOCAL_POSTGRES_PASSWORD: required("ABOS_LOCAL_POSTGRES_PASSWORD"),
    ABOS_LOCAL_TREASURY_PASSWORD: required("ABOS_LOCAL_TREASURY_PASSWORD"),
    ABOS_LOCAL_FINANCE_PASSWORD: required("ABOS_LOCAL_FINANCE_PASSWORD"),
    ABOS_LOCAL_IDENTITY_PASSWORD: required("ABOS_LOCAL_IDENTITY_PASSWORD"),
    ABOS_SANDBOX_RUNTIME_MARKER: required("ABOS_SANDBOX_RUNTIME_MARKER"),
    ABOS_SANDBOX_SIGNING_SECRET: required("ABOS_SANDBOX_SIGNING_SECRET")
  };
}

function connectionUrl(user: string, password: string): string {
  const url = new URL(`postgresql://${HOST}:${PORT}/${DATABASE_NAME}`);
  url.username = user;
  url.password = password;
  return url.toString();
}

async function waitForPostgres(secrets: Secrets): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      run("docker", composeArgs("exec", "-T", "postgres", "pg_isready", "-U", OPERATOR, "-d", DATABASE_NAME), true);

      const client = new pg.Client({
        connectionString: connectionUrl(OPERATOR, secrets.ABOS_LOCAL_POSTGRES_PASSWORD),
        connectionTimeoutMillis: 1000
      });
      try {
        await client.connect();
        await client.query("SELECT 1");
        return;
      } finally {
        await client.end().catch(() => undefined);
      }
    } catch {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000));
    }
  }
  throw new Error(
    "Local PostgreSQL container became healthy but 127.0.0.1:55432 did not accept host connections within 60 seconds"
  );
}

async function applyCatalog(pool: pg.Pool, marker: string): Promise<void> {
  const executor = new PostgresExecutor(pool, { runtimeMarker: marker });
  await applyMigrations(executor, await loadMigrations());
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function ensureRuntimeLogins(owner: PostgresExecutor, secrets: Secrets): Promise<void> {
  const roles = [
    [TREASURY_LOGIN, secrets.ABOS_LOCAL_TREASURY_PASSWORD, "abos_e1_treasury_runtime"],
    [FINANCE_LOGIN, secrets.ABOS_LOCAL_FINANCE_PASSWORD, "abos_e1_runtime"],
    [IDENTITY_LOGIN, secrets.ABOS_LOCAL_IDENTITY_PASSWORD, "abos_v1_identity_runtime"]
  ] as const;
  for (const [login, password, membership] of roles) {
    await owner.query(`DO $role$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = ${sqlLiteral(login)}) THEN
        CREATE ROLE ${login} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
      END IF;
    END $role$`);
    await owner.query(`ALTER ROLE ${login} PASSWORD ${sqlLiteral(password)}`);
    await owner.query(`GRANT ${membership} TO ${login}`);
  }
}

async function promptBootstrap(): Promise<BootstrapInput> {
  const rl = createInterface({ input, output });
  try {
    const ask = async (label: string): Promise<string> => {
      const value = (await rl.question(label)).trim();
      if (value.length < 2) throw new Error(`${label.trim()} must contain at least 2 characters`);
      return value;
    };
    return {
      companyCode: await ask("Company code: "),
      companyName: await ask("Company name: "),
      entityCode: await ask("Legal entity code: "),
      entityName: await ask("Legal entity name: "),
      adminLogin: (await ask("First Super Administrator username: ")).toLowerCase(),
      adminName: await ask("First Super Administrator display name: ")
    };
  } finally {
    rl.close();
  }
}

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

async function bootstrapInput(): Promise<BootstrapInput> {
  const names = ["company-code", "company-name", "entity-code", "entity-name", "admin-login", "admin-name"] as const;
  const found = Object.fromEntries(names.map((name) => [name, readArg(name)]));
  const hasAny = Object.values(found).some(Boolean);
  if (!hasAny) return promptBootstrap();
  for (const name of names) {
    if (!found[name]?.trim()) throw new Error(`When using arguments, --${name}=... is required`);
  }
  return {
    companyCode: found["company-code"]!.trim(),
    companyName: found["company-name"]!.trim(),
    entityCode: found["entity-code"]!.trim(),
    entityName: found["entity-name"]!.trim(),
    adminLogin: found["admin-login"]!.trim().toLowerCase(),
    adminName: found["admin-name"]!.trim()
  };
}

async function writeWebEnvironment(secrets: Secrets): Promise<void> {
  const body = [
    "# Generated for ABOS V1 localhost review. Do not commit this file.",
    "NEXT_PUBLIC_APP_NAME=AL-BERUNIY Operating System",
    "NEXT_PUBLIC_APP_ENV=local-review",
    `ABOS_TREASURY_DATABASE_URL=${connectionUrl(TREASURY_LOGIN, secrets.ABOS_LOCAL_TREASURY_PASSWORD)}`,
    `ABOS_FINANCE_DATABASE_URL=${connectionUrl(FINANCE_LOGIN, secrets.ABOS_LOCAL_FINANCE_PASSWORD)}`,
    `ABOS_IDENTITY_DATABASE_URL=${connectionUrl(IDENTITY_LOGIN, secrets.ABOS_LOCAL_IDENTITY_PASSWORD)}`,
    "ABOS_ENVIRONMENT=development",
    `ABOS_SANDBOX_RUNTIME_MARKER=${secrets.ABOS_SANDBOX_RUNTIME_MARKER}`,
    `ABOS_SANDBOX_SIGNING_SECRET=${secrets.ABOS_SANDBOX_SIGNING_SECRET}`,
    "ABOS_SANDBOX_MAX_SESSION_SECONDS=3600",
    ""
  ].join("\n");
  await writeFile(WEB_ENV_FILE, body, { encoding: "utf8", mode: 0o600 });
  await chmod(WEB_ENV_FILE, 0o600).catch(() => undefined);
}

async function setup(): Promise<void> {
  if (Number(process.versions.node.split(".")[0]) !== 24) {
    throw new Error(`ABOS V1 requires Node.js 24; current version is ${process.versions.node}`);
  }
  run("docker", ["version"], true);
  const secrets = await loadOrCreateSecrets();
  run("docker", composeArgs("up", "-d", "postgres"));
  await waitForPostgres(secrets);

  const pool = new pg.Pool({
    connectionString: connectionUrl(OPERATOR, secrets.ABOS_LOCAL_POSTGRES_PASSWORD),
    max: 4
  });
  const owner = new PostgresExecutor(pool, { runtimeMarker: secrets.ABOS_SANDBOX_RUNTIME_MARKER });
  try {
    await applyCatalog(pool, secrets.ABOS_SANDBOX_RUNTIME_MARKER);
    await ensureRuntimeLogins(owner, secrets);

    const existing = await owner.query<{ readonly companies: string }>(
      "SELECT count(*)::text AS companies FROM abos.companies"
    );
    if (existing.rows[0]?.companies !== "0") {
      await writeWebEnvironment(secrets);
      process.stdout.write("Local V1 is already initialized. No company or user data was changed.\n");
      process.stdout.write("Run: pnpm v1:local:status\nThen: pnpm v1:local:start\n");
      return;
    }

    const values = await bootstrapInput();
    const companyId = randomUUID();
    const legalEntityId = randomUUID();
    const systemUserAccountId = randomUUID();

    await owner.transaction(async (tx) => {
      await tx.query(
        "INSERT INTO abos.currencies (code, name, enabled) VALUES ('USD','US Dollar',true),('AFN','Afghan Afghani',true) ON CONFLICT (code) DO UPDATE SET enabled=true"
      );
      await tx.query(
        "INSERT INTO abos.companies (id, code, name, status) VALUES ($1,$2,$3,'ACTIVE')",
        [companyId, values.companyCode, values.companyName]
      );
      await tx.query(
        "INSERT INTO abos.legal_entities (id, company_id, code, name, base_currency_code, currency_policy_status) VALUES ($1,$2,$3,$4,'USD','APPROVED')",
        [legalEntityId, companyId, values.entityCode, values.entityName]
      );
      await tx.query(
        "INSERT INTO abos.user_accounts (id, login_identifier, display_name, status, primary_legal_entity_id, updated_at) VALUES ($1,$2,$3,'ACTIVE',$4,clock_timestamp())",
        [systemUserAccountId, `system.local-bootstrap.${systemUserAccountId.slice(0, 8)}`, "Local V1 Bootstrap", legalEntityId]
      );
      await tx.query(
        `INSERT INTO abos.identity_runtime_configuration (singleton, signing_secret_sha256)
         VALUES (true,$1)
         ON CONFLICT (singleton) DO UPDATE
           SET signing_secret_sha256=EXCLUDED.signing_secret_sha256, configured_at=clock_timestamp()`,
        [identityDatabaseProofDigest(secrets.ABOS_SANDBOX_SIGNING_SECRET)]
      );
      await tx.query(
        `INSERT INTO abos.sandbox_authorizations
           (singleton, environment, configuration_state, policy_version_id, real_posting_enabled,
            runtime_marker, authorized_by_user_account_id, authorized_at, expires_at)
         VALUES (true,'development','SYNTHETIC_TEST_ONLY','local-v1-review',false,$1,$2,
                 clock_timestamp(),clock_timestamp()+interval '90 days')`,
        [secrets.ABOS_SANDBOX_RUNTIME_MARKER, systemUserAccountId]
      );
      await tx.query(
        "INSERT INTO abos.sandbox_legal_entity_scopes (legal_entity_id, base_currency_code, authorized_by_user_account_id) VALUES ($1,'USD',$2)",
        [legalEntityId, systemUserAccountId]
      );
    });

    const bootstrap = await bootstrapSuperAdmin(owner, {
      legalEntityId,
      systemUserAccountId,
      loginIdentifier: values.adminLogin,
      displayName: values.adminName
    });
    await writeWebEnvironment(secrets);

    process.stdout.write("\nABOS V1 localhost review is initialized with your supplied company shell.\n");
    process.stdout.write("No demo users, demo accounts, demo rates, balances or transactions were seeded.\n\n");
    process.stdout.write(`Super Administrator username: ${values.adminLogin}\n`);
    process.stdout.write(`Temporary password (shown once): ${bootstrap.temporaryPassword}\n`);
    process.stdout.write("The first sign-in requires a password change.\n\n");
    process.stdout.write("Start the app with: pnpm v1:local:start\n");
    process.stdout.write("Then open: http://127.0.0.1:3200/login\n");
  } finally {
    await pool.end();
  }
}

async function reset(): Promise<void> {
  if (readArg("confirm") !== "RESET-LOCAL-V1") {
    throw new Error("Reset is destructive. Re-run with --confirm=RESET-LOCAL-V1");
  }
  const secrets = await loadOrCreateSecrets();
  run("docker", composeArgs("up", "-d", "postgres"));
  await waitForPostgres(secrets);
  const pool = new pg.Pool({
    connectionString: connectionUrl(OPERATOR, secrets.ABOS_LOCAL_POSTGRES_PASSWORD),
    max: 4
  });
  try {
    await pool.query("DROP SCHEMA IF EXISTS abos CASCADE");
    await applyCatalog(pool, secrets.ABOS_SANDBOX_RUNTIME_MARKER);
    process.stdout.write("Local V1 schema was reset and migrations were reapplied. The business database is empty.\n");
    process.stdout.write("Run pnpm v1:local:setup to enter the company shell and first administrator.\n");
  } finally {
    await pool.end();
  }
}

async function status(): Promise<void> {
  const secrets = await loadOrCreateSecrets();
  run("docker", composeArgs("up", "-d", "postgres"));
  await waitForPostgres(secrets);
  const pool = new pg.Pool({
    connectionString: connectionUrl(OPERATOR, secrets.ABOS_LOCAL_POSTGRES_PASSWORD),
    max: 2
  });
  try {
    const result = await pool.query<{
      migrations: string; companies: string; entities: string; users: string; suspicious: string;
    }>(`SELECT
      (SELECT count(*)::text FROM abos.schema_migrations) AS migrations,
      (SELECT count(*)::text FROM abos.companies) AS companies,
      (SELECT count(*)::text FROM abos.legal_entities) AS entities,
      (SELECT count(*)::text FROM abos.user_accounts) AS users,
      (SELECT count(*)::text FROM abos.user_accounts
        WHERE lower(display_name) LIKE '%synthetic%' OR lower(login_identifier) LIKE '%demo.%'
           OR lower(login_identifier) LIKE '%@synthetic.invalid') AS suspicious`);
    const row = result.rows[0];
    process.stdout.write(JSON.stringify(row, null, 2) + "\n");
    if (row && row.suspicious !== "0") {
      throw new Error("Synthetic/demo user rows were found in the local-review database");
    }
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "setup") return setup();
  if (command === "reset") return reset();
  if (command === "status") return status();
  throw new Error("Usage: local-review.ts setup|status|reset [--confirm=RESET-LOCAL-V1]");
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
