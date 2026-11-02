/**
 * V1 first-run seed: a brand-new company with nothing set up.
 *
 * Drops and recreates the `abos` schema in a DISPOSABLE database (the name must contain "dev",
 * "sandbox" or "preview") and creates only what an installation has before anyone signs in:
 *
 *   1. the currencies, one company shell and the identity signing configuration;
 *   2. the operator bootstrap of the first Super Administrator;
 *   3. through the real identity service and its restricted login, a single-operator
 *      "Finance Manager" role and one Finance user holding it.
 *
 * No financial year, account, policy, Safe, shareholder or transaction exists afterwards: the
 * first-run browser test sets all of them up through the app. Passwords are random per run,
 * printed once to this console and never written to disk.
 */
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { bootstrapSuperAdmin, IdentityService } from "@abos/identity";
import { PostgresExecutor } from "@abos/persistence";
import { identityDatabaseProofDigest, readSandboxConfiguration, SandboxAuthenticator } from "@abos/sandbox-auth";
import { resetSchema } from "../src/harness.ts";

// What the single-operator Finance Manager of the 2026-11-02 clean first-run test was given in Roles & permissions.
const FINANCE_MANAGER_PERMISSIONS = [
  "admin.finance-workflow.manage", "company.dashboard.read",
  "finance.calendar.manage", "finance.period.manage", "finance.report.operational.read",
  "finance.ledger-account.manage", "finance.ledger-account.review",
  "finance.capital-receipt.prepare", "finance.capital-receipt.approve", "finance.capital-receipt.post", "finance.capital-receipt.configure",
  "finance.expense-category.manage", "finance.expense.create", "finance.expense.read", "finance.expense.approve",
  "finance.exchange-rate.record", "finance.fx-policy.manage",
  "finance.reversal.request", "finance.reversal.approve", "finance.reversal.direct",
  "finance.temporary-funding.read", "finance.temporary-funding.record", "finance.temporary-funding.approve",
  "finance.temporary-funding.configure", "finance.temporary-funding.settle", "finance.temporary-funding.settle-approve",
  "shareholder.read", "shareholder.setup.manage", "shareholder.capital-receipt.read", "shareholder.capital-receipt.record",
  "treasury.safe.read", "treasury.cash-location.manage", "treasury.operational-account.manage", "treasury.saraf-account.manage",
  "treasury.opening-balance.record", "treasury.receipt.record", "treasury.payment.record", "treasury.transfer.record",
  "treasury.capital-receipt.verify"
] as const;

function passphrase(): string {
  const words = ["cedar", "river", "lantern", "harbor", "saffron", "marble", "orchard", "falcon", "meadow", "copper", "willow", "summit"];
  const pick = () => words[randomBytes(1)[0]! % words.length];
  return `${pick()}-${pick()}-${pick()}-${randomBytes(3).toString("hex")}`;
}

async function main(): Promise<void> {
  const ownerUrl = process.env.ABOS_DATABASE_URL;
  const identityUrl = process.env.ABOS_IDENTITY_DATABASE_URL;
  if (!ownerUrl?.trim()) throw new Error("ABOS_DATABASE_URL is not set");
  if (!identityUrl?.trim()) throw new Error("ABOS_IDENTITY_DATABASE_URL is not set (the restricted identity login)");
  if (identityUrl === ownerUrl) throw new Error("ABOS_IDENTITY_DATABASE_URL must be the restricted identity login, not the administration credential");
  const databaseName = new URL(ownerUrl).pathname.slice(1);
  if (!/dev|sandbox|preview/i.test(databaseName)) throw new Error(`Refusing to reset "${databaseName}": its name must contain dev, sandbox or preview`);
  if (new URL(identityUrl).pathname.slice(1) !== databaseName) throw new Error("The identity login must point at the same disposable database");
  const configuration = readSandboxConfiguration(process.env);

  const ownerPool = new pg.Pool({ connectionString: ownerUrl, max: 4 });
  const identityPool = new pg.Pool({ connectionString: identityUrl, max: 4 });
  const owner = new PostgresExecutor(ownerPool, { runtimeMarker: configuration.runtimeMarker });
  try {
    await resetSchema(ownerPool);

    // Installation shell: what exists before the first sign-in.
    const companyId = randomUUID();
    const legalEntityId = randomUUID();
    const systemUserId = randomUUID();
    await owner.transaction(async (tx) => {
      await tx.query("INSERT INTO abos.currencies (code, name, enabled) VALUES ('USD','US Dollar',true),('AFN','Afghan Afghani',true) ON CONFLICT (code) DO NOTHING");
      await tx.query(
        `INSERT INTO abos.identity_runtime_configuration (singleton, signing_secret_sha256) VALUES (true, $1)
         ON CONFLICT (singleton) DO UPDATE SET signing_secret_sha256 = EXCLUDED.signing_secret_sha256, configured_at = clock_timestamp()`,
        [identityDatabaseProofDigest(configuration.signingSecret)]);
      await tx.query("INSERT INTO abos.companies (id, code, name, status) VALUES ($1, 'SFR', 'Synthetic First-Run Company', 'ACTIVE')", [companyId]);
      await tx.query(
        `INSERT INTO abos.legal_entities (id, company_id, code, name, base_currency_code, currency_policy_status)
         VALUES ($1, $2, 'SFR', 'Synthetic First-Run Company', 'USD', 'APPROVED')`, [legalEntityId, companyId]);
      await tx.query(
        `INSERT INTO abos.user_accounts (id, login_identifier, display_name, status, primary_legal_entity_id, updated_at)
         VALUES ($1, $2, 'Synthetic Installation Bootstrap', 'ACTIVE', $3, clock_timestamp())`,
        [systemUserId, `system.first-run-bootstrap.${systemUserId.slice(0, 8)}`, legalEntityId]);
    });

    // Operator bootstrap of the first Super Administrator.
    const bootstrap = await bootstrapSuperAdmin(owner, {
      legalEntityId, systemUserAccountId: systemUserId, loginIdentifier: "super.admin", displayName: "Synthetic Super Admin"
    });

    // The administrator creates the Finance role and the Finance user through the real identity service.
    const identityExecutor = new PostgresExecutor(identityPool, { runtimeMarker: configuration.runtimeMarker });
    const identity = new IdentityService(identityExecutor, new SandboxAuthenticator(identityExecutor, configuration), {
      attemptKeySecret: randomBytes(32).toString("hex")
    });
    const client = "first-run-seed";
    const adminPassword = passphrase();
    const admin = await identity.changePassword({ loginIdentifier: "super.admin", currentPassword: bootstrap.temporaryPassword, newPassword: adminPassword, clientAddress: client });
    const role = await identity.createRole(admin.token, {
      name: "Finance Manager",
      description: "Single-operator Finance: setup, money in and out, reports, reversals and year close (synthetic).",
      permissions: [...FINANCE_MANAGER_PERMISSIONS]
    });
    const created = await identity.createUser(admin.token, {
      loginIdentifier: "demo.finance.manager", displayName: "Synthetic Finance Manager", jobTitle: "Finance manager (synthetic)",
      status: "ACTIVE", roleIds: [role.id]
    });
    const financePassword = passphrase();
    await identity.changePassword({ loginIdentifier: "demo.finance.manager", currentPassword: created.temporaryPassword, newPassword: financePassword, clientAddress: client });

    process.stdout.write("\nV1 first-run company created (synthetic, nothing set up). Passwords are shown once and are not stored.\n\n");
    process.stdout.write(`${"Person".padEnd(30)}${"Username".padEnd(26)}${"Password".padEnd(34)}Role\n`);
    for (const row of [
      { name: "Synthetic Super Admin", login: "super.admin", password: adminPassword, role: "Super Administrator" },
      { name: "Synthetic Finance Manager", login: "demo.finance.manager", password: financePassword, role: "Finance Manager" }
    ]) process.stdout.write(`${row.name.padEnd(30)}${row.login.padEnd(26)}${row.password.padEnd(34)}${row.role}\n`);
  } finally {
    await identityPool.end();
    await ownerPool.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
