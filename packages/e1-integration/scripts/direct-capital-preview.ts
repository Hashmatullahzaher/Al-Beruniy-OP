/** Disposable operational-password demo only. Never reads the preserved runtime configuration. */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { hashPassword } from "@abos/identity";
import { grant } from "../src/currency-fixtures.ts";
import { openHarness, resetSchema } from "../src/harness.ts";
import { seedSyntheticWorld } from "../src/synthetic-world.ts";

const input = process.env.ABOS_DIRECT_DEMO_DATABASE_URL;
if (!input) throw new Error("ABOS_DIRECT_DEMO_DATABASE_URL is required");
const address = new URL(input);
const name = "abos_direct_capital_browser_0040";
if (address.hostname !== "127.0.0.1" || address.port !== "15440" || address.pathname !== `/${name}`) {
  throw new Error("Only the dedicated disposable 0040 browser database on localhost:15440 is allowed");
}
if (process.env.ABOS_RESET_DISPOSABLE_DEMO !== "1") throw new Error("Explicit ABOS_RESET_DISPOSABLE_DEMO=1 is required");
const administrative = new URL(address); administrative.pathname = "/postgres";
const cluster = new pg.Client({ connectionString: administrative.toString() });
await cluster.connect();
try {
  if (!(await cluster.query("SELECT 1 FROM pg_database WHERE datname=$1", [name])).rowCount) {
    await cluster.query(`CREATE DATABASE ${name}`);
  }
} finally { await cluster.end(); }

const configuration = { runtimeMarker: `direct-capital-demo-${randomUUID()}`, signingSecret: randomBytes(32).toString("hex"),
  environment: "development" as const, maxSessionSeconds: 3600 };
process.env.ABOS_TEST_DATABASE_URL = address.toString();
const h = await openHarness(configuration.runtimeMarker);
try {
  await resetSchema(h.pool);
  const world = await seedSyntheticWorld(h.executor, { authConfiguration: configuration });
  await h.pool.query("DELETE FROM abos.sandbox_legal_entity_scopes");
  await h.pool.query("DELETE FROM abos.sandbox_authorizations");
  await h.pool.query("UPDATE abos.legal_entities SET name='Al-Beruniy · isolated client demo' WHERE id=$1", [world.legalEntityId]);
  await h.pool.query("UPDATE abos.business_parties SET display_name='Example planning record' WHERE id=$1", [world.businessPartyId]);
  await h.pool.query("UPDATE abos.user_accounts SET display_name='Demo Finance Manager',login_identifier='demo.finance',job_title='Finance Manager' WHERE id=$1", [world.intentCreatorId]);
  const password = `Demo-${randomBytes(12).toString("hex")}`;
  await h.pool.query(`INSERT INTO abos.user_credentials(user_account_id,password_hash,must_change_password,password_set_at,password_set_by_user_account_id)
    VALUES($1,$2,false,clock_timestamp(),$3)`, [world.intentCreatorId, await hashPassword(password), world.bootstrapUserId]);
  await grant(h.executor, world, world.intentCreatorId, ["shareholder.setup.manage", "shareholder.capital-receipt.read",
    "shareholder.capital-receipt.record", "finance.capital-receipt.prepare", "finance.capital-receipt.post",
    "finance.report.operational.read", "finance.expense.read", "finance.expense.create", "company.dashboard.read"]);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kabul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const first = `${today.slice(0, 7)}-01`;
  await h.pool.query("UPDATE abos.accounting_periods SET starts_on=$1::date,ends_on=($1::date+interval '1 month'-interval '1 day')::date WHERE id=$2", [first, world.accountingPeriodId]);
  const safe = randomUUID();
  await h.pool.query(`INSERT INTO abos.operational_treasury_accounts(id,legal_entity_id,name_en,name_fa,account_type,currency_code,
    ledger_account_id,status,version,created_by_user_account_id,last_changed_by_user_account_id)
    VALUES($1,$2,'Demo USD Safe','صندوق نمایشی دالر','SAFE','USD',$3,'ACTIVE',1,$4,$4)`,
  [safe, world.legalEntityId, world.cashLedgerAccountId, world.bootstrapUserId]);
  await h.pool.query(`INSERT INTO abos.finance_workflow_policy_versions(id,legal_entity_id,workflow_type,version,approval_required,configured_by_user_account_id,change_reason)
    VALUES($1,$2,'SHAREHOLDER_CAPITAL_RECEIPT',1,false,$3,'Disposable client-demonstration fixture only')`,
  [randomUUID(), world.legalEntityId, world.bootstrapUserId]);
  await h.pool.query(`INSERT INTO abos.capital_agreement_document_policies(legal_entity_id,document_requirement,decision_reference)
    VALUES($1,'OPTIONAL','Disposable optional-document demonstration only')`, [world.legalEntityId]);
  const runtimeUrls: Record<string, string> = {};
  for (const [suffix, role] of [["identity", "abos_v1_identity_runtime"], ["finance", "abos_e1_runtime"], ["treasury", "abos_e1_treasury_runtime"]] as const) {
    const login = `abos_direct_preview_${suffix}`;
    const secret = randomBytes(24).toString("hex");
    if (!(await h.pool.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [login])).rowCount) {
      await h.pool.query(`CREATE ROLE ${login} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    }
    await h.pool.query(`ALTER ROLE ${login} PASSWORD '${secret}'`);
    await h.pool.query(`GRANT ${role} TO ${login}`);
    const url = new URL(address); url.username = login; url.password = secret;
    runtimeUrls[`ABOS_${suffix.toUpperCase()}_DATABASE_URL`] = url.toString();
  }
  const output = resolve(import.meta.dirname, "../../../test-results/direct-capital");
  mkdirSync(output, { recursive: true });
  const env = { ...runtimeUrls, ABOS_DATABASE_URL: "", ABOS_ENVIRONMENT: configuration.environment,
    ABOS_SANDBOX_RUNTIME_MARKER: configuration.runtimeMarker, ABOS_SANDBOX_SIGNING_SECRET: configuration.signingSecret,
    ABOS_SANDBOX_MAX_SESSION_SECONDS: "3600", ABOS_ALLOW_DEV_TOKEN_SIGNIN: "0", ABOS_SHAREHOLDER_FINANCE_REVIEW_MODE: "0",
    ABOS_DOCUMENT_STORAGE_ROOT: resolve(output, "private-documents") };
  writeFileSync(resolve(output, "browser-preview.json"), JSON.stringify({ database: name, url: "http://127.0.0.1:3191",
    username: "demo.finance", password, legalEntityId: world.legalEntityId, safeId: safe, env }, null, 2), { mode: 0o600 });
  writeFileSync(resolve(output, "demo-credentials.txt"), `ISOLATED DEMO ONLY — no preserved company records\nURL: http://127.0.0.1:3191/login\nUsername: demo.finance\nPassword: ${password}\n`, { mode: 0o600 });
  console.log("Dedicated disposable client demo prepared. Credentials/configuration are in ignored test-results/direct-capital; no live records were read or changed.");
} finally { await h.close(); }
