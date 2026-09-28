import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import pg from "pg";
import { bootstrapSuperAdmin, IdentityError, IdentityService, type IdentityErrorCode } from "@abos/identity";
import { PostgresExecutor } from "@abos/persistence";
import { SandboxAuthenticator } from "@abos/sandbox-auth";
import { databaseUrl, MISSING_DATABASE_MESSAGE, openHarness, resetSchema, type Harness } from "./harness.ts";
import { seedSyntheticWorld, SYNTHETIC_AUTH_CONFIGURATION } from "./synthetic-world.ts";

/** Migration 0017: company configuration (#8) through the restricted identity login. */

const MARKER = SYNTHETIC_AUTH_CONFIGURATION.runtimeMarker;
const LOGIN = { name: "abos_v1_identity_runtime_test_login", password: "synthetic-identity-runtime-only-2026" };
const CLIENT = "203.0.113.20";

if (databaseUrl() === undefined) {
  test("V1 company profile", () => assert.fail(MISSING_DATABASE_MESSAGE));
} else {
  describe("V1 company profile (migration 0017)", () => {
    let harness: Harness;
    before(async () => { harness = await openHarness(MARKER); });
    after(async () => { await harness.close(); });

    test("owner data stays pending until a Super Administrator enters it; employees can read it; changes are audited", async () => {
      await resetSchema(harness.pool);
      const world = await seedSyntheticWorld(harness.executor);
      await harness.executor.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${LOGIN.name}') THEN
        CREATE ROLE ${LOGIN.name} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION; END IF; END $$`);
      await harness.executor.query(`ALTER ROLE ${LOGIN.name} LOGIN PASSWORD '${LOGIN.password}'`);
      await harness.executor.query(`GRANT abos_v1_identity_runtime TO ${LOGIN.name}`);
      const bootstrap = await bootstrapSuperAdmin(harness.executor, {
        legalEntityId: world.legalEntityId, systemUserAccountId: world.bootstrapUserId, loginIdentifier: "super.admin", displayName: "Synthetic Super Admin"
      });
      const url = new URL(databaseUrl() ?? ""); url.username = LOGIN.name; url.password = LOGIN.password;
      const pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
      try {
        const executor = new PostgresExecutor(pool, { runtimeMarker: MARKER });
        const identity = new IdentityService(executor, new SandboxAuthenticator(executor, SYNTHETIC_AUTH_CONFIGURATION), { attemptKeySecret: "synthetic-login-attempt-key-secret-for-tests-only" });
        const admin = (await identity.changePassword({ loginIdentifier: "super.admin", currentPassword: bootstrap.temporaryPassword, newPassword: "Synthetic admin passphrase 7", clientAddress: CLIENT })).token;

        // Nothing is invented: the legal details are pending, the decided base currency and currencies are real rows.
        const initial = await identity.companyProfile(admin);
        assert.deepEqual([initial.profile.legalName, initial.profile.registrationNumber, initial.profile.goLiveDate], [null, null, null]);
        assert.equal(initial.legalEntity.baseCurrency, "USD");
        assert.deepEqual(initial.currencies.filter((currency) => currency.enabled).map((currency) => currency.code).sort(), ["AFN", "USD"]);
        assert.equal(initial.canManage, false, "even the Super Administrator needs the company permission explicitly");

        // Only a Super Administrator can hand out the company permission (administration access).
        const companyRole = await identity.createRole(admin, { name: "Company Editor", description: "", permissions: ["admin.company.manage"] });
        const readerRole = await identity.createRole(admin, { name: "Reader", description: "", permissions: ["treasury.read"] });
        const reader = await identity.createUser(admin, { loginIdentifier: "plain.reader", displayName: "Synthetic Reader", status: "ACTIVE", roleIds: [readerRole.id] });
        const readerToken = (await identity.changePassword({ loginIdentifier: "plain.reader", currentPassword: reader.temporaryPassword, newPassword: "Reader passphrase 2026 x", clientAddress: CLIENT })).token;
        assert.equal((await identity.companyProfile(readerToken)).profile.legalName, null, "any employee can read the company details");
        await rejects("PERMISSION_DENIED", () => identity.updateCompanyProfile(readerToken, { legalName: "Hijack", registrationNumber: null, goLiveDate: null, expectedVersion: 0 }));

        const editor = await identity.createUser(admin, { loginIdentifier: "company.editor", displayName: "Synthetic Company Editor", status: "ACTIVE", roleIds: [companyRole.id] });
        const editorToken = (await identity.changePassword({ loginIdentifier: "company.editor", currentPassword: editor.temporaryPassword, newPassword: "Editor passphrase 2026 y", clientAddress: CLIENT })).token;
        const saved = await identity.updateCompanyProfile(editorToken, { legalName: "Synthetic Company Ltd (demo)", registrationNumber: "DEMO-0001", goLiveDate: "2027-03-21", expectedVersion: 0 });
        assert.equal(saved.profile.legalName, "Synthetic Company Ltd (demo)");
        assert.equal(saved.profile.goLiveDate, "2027-03-21");
        assert.equal(saved.profile.version, 1);
        await rejects("STALE_VERSION", () => identity.updateCompanyProfile(editorToken, { legalName: "Late", registrationNumber: null, goLiveDate: null, expectedVersion: 0 }));
        await rejects("VALIDATION_FAILED", () => identity.updateCompanyProfile(editorToken, { legalName: "X", registrationNumber: null, goLiveDate: null, expectedVersion: 1 }));
        await rejects("VALIDATION_FAILED", () => identity.updateCompanyProfile(editorToken, { legalName: null, registrationNumber: null, goLiveDate: "25/09/2026", expectedVersion: 1 }));
        // Clearing a value returns it to pending.
        const cleared = await identity.updateCompanyProfile(editorToken, { legalName: null, registrationNumber: "DEMO-0001", goLiveDate: null, expectedVersion: 1 });
        assert.equal(cleared.profile.legalName, null);

        const trail = await identity.auditTrail(admin);
        const updates = trail.filter((entry) => entry.action === "COMPANY_PROFILE_UPDATED");
        assert.equal(updates.length, 2);
        assert.ok(updates.every((entry) => entry.actor === "Synthetic Company Editor"));

        // The identity runtime still cannot write other kinds of audit or touch Treasury/Finance tables.
        await assert.rejects(() => executor.query(
          "INSERT INTO abos.audit_records (id, legal_entity_id, correlation_id, action, entity_type) VALUES (gen_random_uuid(), $1, gen_random_uuid(), 'X', 'JOURNAL')",
          [world.legalEntityId]), /permission denied|only record access-administration events/);
        await assert.rejects(() => executor.query("UPDATE abos.legal_entities SET name = 'x'"), /permission denied/);
      } finally {
        await pool.end();
      }
    });
  });
}

async function rejects(code: IdentityErrorCode, run: () => Promise<unknown>): Promise<void> {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof IdentityError, String(error));
    assert.equal(error.code, code, error.message);
    return true;
  });
}
