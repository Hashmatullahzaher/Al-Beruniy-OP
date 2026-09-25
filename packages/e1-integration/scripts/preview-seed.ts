/**
 * V1 client-preview seed.
 *
 * Drops and recreates the `abos` schema in a DISPOSABLE database (the name must contain "dev",
 * "sandbox" or "preview"), seeds the synthetic E1 world through the real services, then sets up the
 * preview's people through the real identity service and its restricted database login:
 *
 *   1. the operator bootstrap creates the first Super Administrator;
 *   2. that administrator signs in, creates the standard roles and gives them to the synthetic
 *      Treasury and Finance people;
 *   3. every person receives a freshly generated password, printed once to this console.
 *
 * Nothing here is company data. Passwords are random per run and are never written to disk.
 */
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import type {
  CapitalAgreementId, CapitalInstallmentId, CashLocationCurrencyAccountId, CorrelationId, IdempotencyKey, LegalEntityId, UserAccountId
} from "@abos/contracts";
import { asDecimalString } from "@abos/contracts";
import { bootstrapSuperAdmin, IdentityService } from "@abos/identity";
import { PostgresExecutor, PostgresShareholderRepository } from "@abos/persistence";
import { readSandboxConfiguration, SandboxAuthenticator } from "@abos/sandbox-auth";
import { CapitalReceiptIntentService } from "@abos/shareholder";
import { resetSchema } from "../src/harness.ts";
import { addInstallment, bindSyntheticFinanceApprovalEvidence, bindSyntheticTreasuryEvidence, seedSyntheticWorld } from "../src/synthetic-world.ts";

pg.types.setTypeParser(1700, (value: string) => value);

const ROLES = [
  { name: "Cashier", description: "Records cash received into an assigned safe, counts it and submits it for verification.",
    permissions: ["treasury.read", "treasury.cash-receipt.record", "treasury.cash-count.record"] },
  { name: "Treasury Verifier", description: "Independently verifies cash recorded by someone else and hands it to Finance.",
    permissions: ["treasury.read", "treasury.cash-receipt.verify", "treasury.handoff.create"] },
  { name: "Treasury Manager", description: "Manages safes and cash accounts and assigns cashiers to safes.",
    permissions: ["treasury.read", "treasury.cash-location.manage"] },
  { name: "Finance Preparer", description: "Prepares journals for verified cash handed over by Treasury.",
    permissions: ["finance.report.operational.read", "finance.posting-intent.create"] },
  { name: "Finance Approver", description: "Independently approves prepared journals and posts approved ones.",
    permissions: ["finance.report.operational.read", "finance.posting-intent.approve", "finance.journal.post"] }
] as const;

const PEOPLE = [
  { displayName: "Synthetic Cashier", login: "demo.cashier", jobTitle: "Cashier (synthetic)", role: "Cashier" },
  { displayName: "Synthetic Count Confirmer", login: "demo.verifier", jobTitle: "Treasury verifier (synthetic)", role: "Treasury Verifier" },
  { displayName: "Synthetic Treasury Manager", login: "demo.treasury.manager", jobTitle: "Treasury manager (synthetic)", role: "Treasury Manager" },
  { displayName: "Synthetic Intent Creator", login: "demo.finance.preparer", jobTitle: "Finance preparer (synthetic)", role: "Finance Preparer" },
  { displayName: "Synthetic Finance Approver", login: "demo.finance.approver", jobTitle: "Finance approver (synthetic)", role: "Finance Approver" }
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
    const world = await seedSyntheticWorld(owner, { authConfiguration: configuration });
    const secondInstallment = await addInstallment(owner, world, { sequenceNumber: 2, expectedAmount: "25000.00" });
    const shareholder = new CapitalReceiptIntentService(new PostgresShareholderRepository(owner, world.intentCreatorId as UserAccountId));
    const evidence = (await owner.query<{ id: string; document_id: string; evidence_kind: "CAPITAL_AGREEMENT"; sha256: string; completed_at: Date }>(
      "SELECT id, document_id, evidence_kind, sha256, completed_at FROM abos.evidence_references WHERE id = $1", [world.agreementDocumentEvidenceId])).rows[0];
    if (evidence === undefined) throw new Error("seeded agreement evidence is missing");
    for (const installmentId of [world.installmentId, secondInstallment]) {
      const intent = await shareholder.createCapitalReceiptIntent({
        legalEntityId: world.legalEntityId as LegalEntityId, shareholderPartyId: world.businessPartyId as never,
        agreementId: world.agreementId as CapitalAgreementId, installmentId: installmentId as CapitalInstallmentId,
        amount: { amount: asDecimalString("25000.00"), currency: "USD" },
        expectedDestinationAccountId: world.cashAccountId as CashLocationCurrencyAccountId,
        businessEventAt: new Date().toISOString(),
        source: { legalEntityId: world.legalEntityId as LegalEntityId, idempotencyKey: `preview-${randomUUID()}` as IdempotencyKey, correlationId: randomUUID() as CorrelationId },
        evidence: [{ id: evidence.id as never, documentId: evidence.document_id as never, kind: evidence.evidence_kind, version: 1, sha256: evidence.sha256, completedAt: evidence.completed_at.toISOString() }]
      });
      await bindSyntheticTreasuryEvidence(owner, world, intent.id);
      await bindSyntheticFinanceApprovalEvidence(owner, world, intent.id);
    }

    // Operator step: give the synthetic people readable usernames and a home legal entity.
    for (const person of PEOPLE) {
      await owner.query(
        "UPDATE abos.user_accounts SET login_identifier = $2, primary_legal_entity_id = $3 WHERE display_name = $1",
        [person.displayName, person.login, world.legalEntityId]);
    }

    // Operator bootstrap of the first Super Administrator.
    const bootstrap = await bootstrapSuperAdmin(owner, {
      legalEntityId: world.legalEntityId, systemUserAccountId: world.bootstrapUserId,
      loginIdentifier: "super.admin", displayName: "Synthetic Super Admin"
    });

    // Everything else goes through the real identity service and its restricted login.
    const identityExecutor = new PostgresExecutor(identityPool, { runtimeMarker: configuration.runtimeMarker });
    const identity = new IdentityService(identityExecutor, new SandboxAuthenticator(identityExecutor, configuration), {
      attemptKeySecret: randomBytes(32).toString("hex")
    });
    const client = "preview-seed";
    const adminPassword = passphrase();
    const admin = await identity.changePassword({ loginIdentifier: "super.admin", currentPassword: bootstrap.temporaryPassword, newPassword: adminPassword, clientAddress: client });
    const roleIds = new Map<string, string>();
    for (const role of ROLES) {
      const created = await identity.createRole(admin.token, { name: role.name, description: role.description, permissions: [...role.permissions] });
      roleIds.set(role.name, created.id);
    }
    const users = await identity.listUsers(admin.token);
    const printed: { name: string; login: string; password: string; role: string }[] = [
      { name: "Synthetic Super Admin", login: "super.admin", password: adminPassword, role: "Super Administrator" }
    ];
    for (const person of PEOPLE) {
      const user = users.find((item) => item.loginIdentifier === person.login);
      if (user === undefined) throw new Error(`${person.displayName} is missing`);
      await identity.updateProfile(admin.token, user.id, { displayName: person.displayName, jobTitle: person.jobTitle });
      await identity.setRoles(admin.token, user.id, [roleIds.get(person.role) ?? ""]);
      const reset = await identity.resetPassword(admin.token, user.id);
      const password = passphrase();
      await identity.changePassword({ loginIdentifier: person.login, currentPassword: reset.temporaryPassword, newPassword: password, clientAddress: client });
      printed.push({ name: person.displayName, login: person.login, password, role: person.role });
    }

    process.stdout.write("\nV1 client preview seeded (synthetic data only). Passwords are shown once and are not stored.\n\n");
    process.stdout.write(`${"Person".padEnd(30)}${"Username".padEnd(26)}${"Password".padEnd(34)}Role\n`);
    for (const row of printed) process.stdout.write(`${row.name.padEnd(30)}${row.login.padEnd(26)}${row.password.padEnd(34)}${row.role}\n`);
    process.stdout.write("\nThe demo's new employee is created live by the Super Admin in Admin → Users.\n");
  } finally {
    await identityPool.end();
    await ownerPool.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
