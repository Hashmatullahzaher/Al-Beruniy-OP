import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before, describe } from "node:test";
import pg from "pg";
import type {
  CapitalAgreementId, CapitalInstallmentId, CashLocationCurrencyAccountId, CorrelationId, EvidenceReference,
  IdempotencyKey, LegalEntityId, UserAccountId
} from "@abos/contracts";
import { asDecimalString } from "@abos/contracts";
import type { SqlExecutor } from "@abos/database";
import { bootstrapSuperAdmin, IdentityError, IdentityService, type IdentityErrorCode } from "@abos/identity";
import { PostgresExecutor, PostgresShareholderRepository, RestrictedTreasuryGateway } from "@abos/persistence";
import { SandboxAuthenticator } from "@abos/sandbox-auth";
import { CapitalReceiptIntentService } from "@abos/shareholder";
import { databaseUrl, MISSING_DATABASE_MESSAGE, openHarness, resetSchema, type Harness } from "./harness.ts";
import {
  bindSyntheticFinanceApprovalEvidence, bindSyntheticTreasuryEvidence, seedSyntheticWorld,
  SYNTHETIC_AUTH_CONFIGURATION, type SyntheticWorld
} from "./synthetic-world.ts";

/**
 * V1 identity and access administration against real PostgreSQL.
 *
 * The identity service runs only through a restricted login that inherits abos_v1_identity_runtime.
 * Every Treasury and Finance step runs through the existing restricted Treasury and Finance logins,
 * with session tokens obtained from the real password sign-in. Nothing here is mocked.
 */

const MARKER = SYNTHETIC_AUTH_CONFIGURATION.runtimeMarker;
const LOGINS = {
  identity: { name: "abos_v1_identity_runtime_test_login", password: "synthetic-identity-runtime-only-2026", role: "abos_v1_identity_runtime" },
  treasury: { name: "abos_e1_treasury_runtime_test_login", password: "synthetic-treasury-runtime-only-2026", role: "abos_e1_treasury_runtime" },
  finance: { name: "abos_e1_finance_runtime_test_login", password: "synthetic-finance-runtime-only-2026", role: "abos_e1_runtime" }
} as const;
const ATTEMPT_SECRET = "synthetic-login-attempt-key-secret-for-tests-only";
const CLIENT = "203.0.113.10";

interface Setup {
  readonly world: SyntheticWorld;
  readonly identity: IdentityService;
  readonly adminToken: string;
  readonly adminId: string;
  readonly superAdminRoleId: string;
  close(): Promise<void>;
}

if (databaseUrl() === undefined) {
  test("V1 identity administration", () => assert.fail(MISSING_DATABASE_MESSAGE));
} else {
  describe("V1 identity administration (restricted identity login)", () => {
    let harness: Harness;
    before(async () => { harness = await openHarness(MARKER); });
    after(async () => { await harness.close(); });

    test("bootstrap creates one Super Administrator who must change the temporary password first", async () => {
      const setup = await prepare(harness, { changeAdminPassword: false });
      try {
        const bootstrap = await harness.executor.query<{ login_identifier: string }>(
          "SELECT login_identifier FROM abos.user_accounts WHERE id = $1", [setup.adminId]);
        const login = bootstrap.rows[0]?.login_identifier ?? "";
        await rejectsIdentity("PASSWORD_CHANGE_REQUIRED", () => setup.identity.login({ loginIdentifier: login, password: adminPassword, clientAddress: CLIENT }));
        const changed = await setup.identity.changePassword({ loginIdentifier: login, currentPassword: adminPassword, newPassword: "Owner chosen passphrase 91", clientAddress: CLIENT });
        assert.deepEqual([...changed.user.permissions].sort(), ["admin.roles.manage", "admin.users.manage"]);
        // A second bootstrap is refused: it cannot be used to add an administrator behind the first one's back.
        await rejectsIdentity("DUPLICATE", () => bootstrapSuperAdmin(harness.executor, {
          legalEntityId: setup.world.legalEntityId, systemUserAccountId: setup.world.bootstrapUserId,
          loginIdentifier: "second.admin", displayName: "Second Synthetic Admin"
        }));
        const stored = await harness.executor.query<{ password_hash: string }>(
          "SELECT password_hash FROM abos.user_credentials WHERE user_account_id = $1", [setup.adminId]);
        assert.match(stored.rows[0]?.password_hash ?? "", /^scrypt\$/);
        assert.equal(stored.rows[0]?.password_hash.includes("Owner chosen passphrase 91"), false);
      } finally { await setup.close(); }
    });

    test("a Super Administrator creates a role and an employee; the employee signs in and holds exactly that role's permissions", async () => {
      const setup = await prepare(harness);
      try {
        const role = await setup.identity.createRole(setup.adminToken, {
          name: "Cash Receipt Officer", description: "Records and counts cash received into the safe.",
          permissions: ["treasury.read", "treasury.cash-receipt.record", "treasury.cash-count.record"]
        });
        const created = await setup.identity.createUser(setup.adminToken, {
          loginIdentifier: "Receipt.Officer", displayName: "Synthetic Receipt Officer", jobTitle: "Cashier",
          contactEmail: "receipt.officer@synthetic.invalid", status: "ACTIVE", roleIds: [role.id]
        });
        assert.equal(created.user.loginIdentifier, "receipt.officer");
        assert.equal(created.user.mustChangePassword, true);
        assert.deepEqual(created.user.permissions, ["treasury.cash-count.record", "treasury.cash-receipt.record", "treasury.read"]);

        const token = await signInAs(setup.identity, "receipt.officer", created.temporaryPassword);
        const context = await restricted("treasury", (db) => new RestrictedTreasuryGateway(db).context(token));
        assert.equal(context.userAccountId, created.user.id);
        assert.deepEqual([...context.treasuryPermissions].sort(), ["treasury.cash-count.record", "treasury.cash-receipt.record", "treasury.read"]);

        const trail = await setup.identity.auditTrail(setup.adminToken);
        const actions = trail.map((entry) => `${entry.action}:${entry.actor}`);
        assert.ok(actions.includes("ROLE_CREATED:Synthetic Super Admin"));
        assert.ok(actions.includes("USER_CREATED:Synthetic Super Admin"));
        assert.ok(actions.includes("ROLE_ASSIGNED:Synthetic Super Admin"));
        assert.ok(trail.some((entry) => entry.action === "PASSWORD_CHANGED" && entry.actor === "Synthetic Receipt Officer"));
        const serialized = JSON.stringify(trail);
        assert.equal(serialized.includes(created.temporaryPassword), false);
      } finally { await setup.close(); }
    });

    test("ordinary employees cannot create users, edit roles or read the administration data", async () => {
      const setup = await prepare(harness);
      try {
        const { token } = await employee(setup, "plain.cashier", ["treasury.read", "treasury.cash-receipt.record"]);
        await rejectsIdentity("PERMISSION_DENIED", () => setup.identity.createUser(token, {
          loginIdentifier: "sneaky.user", displayName: "Sneaky User", status: "ACTIVE", roleIds: []
        }));
        await rejectsIdentity("PERMISSION_DENIED", () => setup.identity.createRole(token, { name: "Everything", description: "", permissions: ["finance.journal.post"] }));
        await rejectsIdentity("PERMISSION_DENIED", () => setup.identity.listUsers(token));
        await rejectsIdentity("PERMISSION_DENIED", () => setup.identity.listRoles(token));
        await rejectsIdentity("PERMISSION_DENIED", () => setup.identity.auditTrail(token));
        await rejectsIdentity("AUTHENTICATION_REQUIRED", () => setup.identity.listUsers("not-a-real-session-token-at-all-000000"));
      } finally { await setup.close(); }
    });

    test("nobody can raise their own access, and only a Super Administrator can hand out administration", async () => {
      const setup = await prepare(harness);
      try {
        // The administrator cannot change their own roles or status.
        const finance = await setup.identity.createRole(setup.adminToken, { name: "Finance Approver", description: "", permissions: ["finance.report.operational.read", "finance.posting-intent.approve"] });
        await rejectsIdentity("SELF_CHANGE_FORBIDDEN", () => setup.identity.setRoles(setup.adminToken, setup.adminId, [setup.superAdminRoleId, finance.id]));
        await rejectsIdentity("SELF_CHANGE_FORBIDDEN", () => setup.identity.setStatus(setup.adminToken, setup.adminId, "DISABLED"));
        // ...nor widen a role they hold.
        const superRole = (await setup.identity.listRoles(setup.adminToken)).find((role) => role.id === setup.superAdminRoleId);
        assert.ok(superRole?.youHoldThis);
        await rejectsIdentity("SELF_CHANGE_FORBIDDEN", () => setup.identity.updateRole(setup.adminToken, setup.superAdminRoleId, {
          name: superRole.name, description: superRole.description, status: "ACTIVE", expectedVersion: superRole.version,
          permissions: [...superRole.permissions, "finance.journal.post"]
        }));

        // A user administrator without role administration cannot hand out administration access.
        const userAdminRole = await setup.identity.createRole(setup.adminToken, { name: "User Administrator", description: "", permissions: ["admin.users.manage"] });
        const userAdmin = await employeeWithRole(setup, "user.admin", userAdminRole.id);
        const target = await employee(setup, "target.person", ["treasury.read"]);
        await rejectsIdentity("SUPER_ADMIN_REQUIRED", () => setup.identity.setRoles(userAdmin.token, target.id, [setup.superAdminRoleId]));
        await rejectsIdentity("SUPER_ADMIN_REQUIRED", () => setup.identity.setRoles(userAdmin.token, setup.adminId, []));
        // ...and cannot create roles at all.
        await rejectsIdentity("PERMISSION_DENIED", () => setup.identity.createRole(userAdmin.token, { name: "Mine", description: "", permissions: ["treasury.read"] }));

        // The database itself refuses a self-assignment and a self-grant, even for its own runtime role.
        await assert.rejects(() => restricted("identity", (db) => db.query(
          `INSERT INTO abos.user_role_assignments (id, user_account_id, role_id, legal_entity_id, assigned_by_user_account_id)
           VALUES ($1, $2, $3, $4, $2)`, [randomUUID(), userAdmin.id, finance.id, setup.world.legalEntityId])), /check constraint/i);
        await assert.rejects(() => restricted("identity", (db) => db.query(
          `INSERT INTO abos.user_permission_grants (user_account_id, legal_entity_id, permission_code, granted_by_user_account_id)
           VALUES ($1, $2, 'finance.journal.post', $1)`, [userAdmin.id, setup.world.legalEntityId])), /check constraint/i);
        // Unavailable permissions cannot be put into a role, by the service or directly.
        await rejectsIdentity("VALIDATION_FAILED", () => setup.identity.createRole(setup.adminToken, { name: "Reverser", description: "", permissions: ["finance.journal.reverse"] }));
        await assert.rejects(() => restricted("identity", (db) => db.query(
          "INSERT INTO abos.access_role_permissions (role_id, permission_code, added_by_user_account_id) VALUES ($1, 'finance.journal.reverse', $2)",
          [finance.id, setup.adminId])), /not available/i);
        await assert.rejects(() => restricted("identity", (db) => db.query(
          "INSERT INTO abos.access_role_permissions (role_id, permission_code, added_by_user_account_id) VALUES ($1, 'finance.everything', $2)",
          [finance.id, setup.adminId])), /foreign key|not available/i);
      } finally { await setup.close(); }
    });

    test("the last usable Super Administrator cannot be removed, even directly in the database", async () => {
      const setup = await prepare(harness);
      try {
        await assert.rejects(() => restricted("identity", (db) => db.query(
          "UPDATE abos.user_accounts SET status = 'DISABLED' WHERE id = $1", [setup.adminId])), /last active super administrator/i);
        await assert.rejects(() => restricted("identity", (db) => db.query(
          `UPDATE abos.user_permission_grants SET revoked_at = clock_timestamp()
            WHERE user_account_id = $1 AND permission_code = 'admin.users.manage'`, [setup.adminId])), /last active super administrator/i);
        // With a second Super Administrator, one of them may suspend the other.
        const second = await employeeWithRole(setup, "second.super", setup.superAdminRoleId);
        const suspended = await setup.identity.setStatus(second.token, setup.adminId, "DISABLED");
        assert.equal(suspended.status, "DISABLED");
        await assert.rejects(() => restricted("identity", (db) => db.query(
          "UPDATE abos.user_accounts SET status = 'DISABLED' WHERE id = $1", [second.id])), /last active super administrator/i);
      } finally { await setup.close(); }
    });

    test("suspension and role removal end access immediately, in the identity service and in the Treasury database functions", async () => {
      const setup = await prepare(harness);
      try {
        const person = await employee(setup, "soon.suspended", ["treasury.read", "treasury.cash-receipt.record"]);
        assert.ok((await restricted("treasury", (db) => new RestrictedTreasuryGateway(db).context(person.token))).treasuryPermissions.includes("treasury.read"));
        const detail = await setup.identity.setStatus(setup.adminToken, person.id, "DISABLED");
        assert.equal(detail.activeSessions, 0);
        await assert.rejects(() => restricted("treasury", (db) => new RestrictedTreasuryGateway(db).context(person.token)), /invalid|expired|revoked/i);
        await rejectsIdentity("AUTHENTICATION_REQUIRED", () => setup.identity.currentUser(person.token));
        await rejectsIdentity("ACCOUNT_INACTIVE", () => setup.identity.login({ loginIdentifier: "soon.suspended", password: person.password, clientAddress: CLIENT }));

        await setup.identity.setStatus(setup.adminToken, person.id, "ACTIVE");
        const token = await signInAs(setup.identity, "soon.suspended", person.password);
        await setup.identity.setRoles(setup.adminToken, person.id, []);
        await assert.rejects(() => restricted("treasury", (db) => new RestrictedTreasuryGateway(db).context(token)), /invalid|expired|revoked/i);
        await rejectsIdentity("NO_ACCESS_ASSIGNED", () => setup.identity.login({ loginIdentifier: "soon.suspended", password: person.password, clientAddress: CLIENT }));
        const grants = await harness.executor.query<{ permission_code: string }>(
          "SELECT permission_code FROM abos.user_permission_grants WHERE user_account_id = $1 AND revoked_at IS NULL", [person.id]);
        assert.equal(grants.rows.length, 0);
      } finally { await setup.close(); }
    });

    test("changing a role changes every holder's access and ends their sessions; deactivating it removes access", async () => {
      const setup = await prepare(harness);
      try {
        const role = await setup.identity.createRole(setup.adminToken, { name: "Treasury Reader", description: "", permissions: ["treasury.read"] });
        const person = await employeeWithRole(setup, "role.holder", role.id);
        const updated = await setup.identity.updateRole(setup.adminToken, role.id, {
          name: "Treasury Reader", description: "Reads and records", status: "ACTIVE", expectedVersion: role.version,
          permissions: ["treasury.read", "treasury.cash-receipt.record"]
        });
        assert.equal(updated.version, role.version + 1);
        await assert.rejects(() => restricted("treasury", (db) => new RestrictedTreasuryGateway(db).context(person.token)), /invalid|expired|revoked/i);
        await rejectsIdentity("STALE_VERSION", () => setup.identity.updateRole(setup.adminToken, role.id, {
          name: "Treasury Reader", description: "", status: "ACTIVE", expectedVersion: role.version, permissions: ["treasury.read"]
        }));
        const again = await signInAs(setup.identity, "role.holder", person.password);
        assert.deepEqual([...(await setup.identity.currentUser(again)).permissions].sort(), ["treasury.cash-receipt.record", "treasury.read"]);
        await setup.identity.updateRole(setup.adminToken, role.id, {
          name: "Treasury Reader", description: "", status: "INACTIVE", expectedVersion: updated.version, permissions: updated.permissions
        });
        await rejectsIdentity("NO_ACCESS_ASSIGNED", () => setup.identity.login({ loginIdentifier: "role.holder", password: person.password, clientAddress: CLIENT }));
      } finally { await setup.close(); }
    });

    test("duplicate usernames are refused regardless of letter case", async () => {
      const setup = await prepare(harness);
      try {
        await employee(setup, "unique.name", ["treasury.read"]);
        await rejectsIdentity("DUPLICATE", () => setup.identity.createUser(setup.adminToken, {
          loginIdentifier: "Unique.Name", displayName: "Someone Else", status: "ACTIVE", roleIds: []
        }));
        await rejectsIdentity("DUPLICATE", () => setup.identity.createRole(setup.adminToken, { name: "super administrator", description: "", permissions: [] }));
      } finally { await setup.close(); }
    });

    test("an administrator cannot see or change people and roles of another legal entity", async () => {
      const setup = await prepare(harness);
      try {
        const other = await otherEntity(harness, setup.world);
        await rejectsIdentity("NOT_FOUND", () => setup.identity.userDetail(setup.adminToken, other.userId));
        await rejectsIdentity("NOT_FOUND", () => setup.identity.setStatus(setup.adminToken, other.userId, "DISABLED"));
        const mine = await employee(setup, "local.person", ["treasury.read"]);
        await rejectsIdentity("NOT_FOUND", () => setup.identity.setRoles(setup.adminToken, mine.id, [other.roleId]));
        assert.equal((await setup.identity.listUsers(setup.adminToken)).some((user) => user.id === other.userId), false);
        assert.equal((await setup.identity.listRoles(setup.adminToken)).some((role) => role.id === other.roleId), false);
      } finally { await setup.close(); }
    });

    test("repeated wrong passwords lock the account, and a locked account answers exactly like an unknown one", async () => {
      const setup = await prepare(harness);
      try {
        const person = await employee(setup, "locked.person", ["treasury.read"]);
        for (let attempt = 0; attempt < 5; attempt += 1) {
          await rejectsIdentity("INVALID_CREDENTIALS", () => setup.identity.login({ loginIdentifier: "locked.person", password: "wrong password here", clientAddress: "198.51.100.7" }));
        }
        // Locked: even the right password gets the same answer as a wrong one or an unknown username.
        await rejectsIdentity("INVALID_CREDENTIALS", () => setup.identity.login({ loginIdentifier: "locked.person", password: person.password, clientAddress: "198.51.100.7" }));
        await rejectsIdentity("INVALID_CREDENTIALS", () => setup.identity.login({ loginIdentifier: "nobody.here", password: "whatever password", clientAddress: "198.51.100.8" }));
        const attempts = await harness.executor.query<{ login_key: string }>("SELECT login_key FROM abos.login_attempts");
        assert.ok(attempts.rows.every((row) => !row.login_key.includes("locked")));
      } finally { await setup.close(); }
    });

    test("independent review findings stay closed (sessions, audit scope, takeover, cross-entity, grant integrity, expiry)", async () => {
      const setup = await prepare(harness);
      try {
        const approver = await employee(setup, "fin.approver", ["finance.report.operational.read", "finance.posting-intent.approve"]);
        // C-01: the identity runtime cannot mint a session without a recorded successful sign-in,
        // and no new session may start in the future or last longer than an hour.
        // Someone who has an account and access but has not signed in.
        const quietRole = await setup.identity.createRole(setup.adminToken, { name: "Quiet Approver", description: "", permissions: ["finance.report.operational.read", "finance.posting-intent.approve"] });
        const quiet = await setup.identity.createUser(setup.adminToken, { loginIdentifier: "quiet.approver", displayName: "Quiet Approver", status: "ACTIVE", roleIds: [quietRole.id] });
        const mint = (issuedAt: string, expiresAt: string) => restricted("identity", (db) => db.query(
          `INSERT INTO abos.sandbox_sessions (id, user_account_id, token_sha256, runtime_token_sha256, legal_entity_id, issued_at, expires_at)
           VALUES ($1, $2, $3, $3, $4, ${issuedAt}, ${expiresAt})`,
          [randomUUID(), quiet.user.id, "a".repeat(64), setup.world.legalEntityId]));
        await assert.rejects(() => mint("'2030-01-01T00:00:00Z'", "'2030-01-01T00:59:00Z'"), /start now and last at most 60 minutes/);
        await harness.executor.query(
          "INSERT INTO abos.login_attempts (id, login_key, client_key, user_account_id, succeeded, attempted_at) VALUES ($1, $2, $2, $3, true, clock_timestamp() - interval '5 minutes')",
          [randomUUID(), "b".repeat(64), quiet.user.id]);
        await assert.rejects(() => mint("clock_timestamp()", "clock_timestamp() + interval '30 minutes'"), /after a recorded successful sign-in/);

        // C-04: the identity runtime can neither forge Treasury/Finance audit nor read it.
        await assert.rejects(() => restricted("identity", (db) => db.query(
          `INSERT INTO abos.audit_records (id, legal_entity_id, correlation_id, action, entity_type) VALUES ($1, $2, $1, 'JOURNAL_POSTED', 'JOURNAL')`,
          [randomUUID(), setup.world.legalEntityId])), /only record access-administration events/);
        await assert.rejects(() => restricted("identity", (db) => db.query("SELECT count(*) FROM abos.audit_records")), /permission denied/);
        await assert.rejects(() => restricted("identity", (db) => db.query("SELECT count(*) FROM abos.posting_intents")), /permission denied/);

        // C-02 interim: a user administrator cannot reset an approver's password or hand out approval access.
        const userAdminRole = await setup.identity.createRole(setup.adminToken, { name: "People Administrator", description: "", permissions: ["admin.users.manage"] });
        const userAdmin = await employeeWithRole(setup, "people.admin", userAdminRole.id);
        await rejectsIdentity("SUPER_ADMIN_REQUIRED", () => setup.identity.resetPassword(userAdmin.token, approver.id));
        await rejectsIdentity("SUPER_ADMIN_REQUIRED", () => setup.identity.revokeSessions(userAdmin.token, approver.id));
        await rejectsIdentity("SUPER_ADMIN_REQUIRED", () => setup.identity.updateProfile(userAdmin.token, setup.adminId, { displayName: "Renamed Admin" }));
        const approverRole = (await setup.identity.listRoles(setup.adminToken)).find((role) => role.permissions.includes("finance.posting-intent.approve"));
        assert.ok(approverRole);
        await rejectsIdentity("SUPER_ADMIN_REQUIRED", () => setup.identity.createUser(userAdmin.token, {
          loginIdentifier: "puppet.approver", displayName: "Puppet Approver", status: "ACTIVE", roleIds: [approverRole.id] }));
        // ...but can still run ordinary accounts.
        const reader = await setup.identity.createRole(setup.adminToken, { name: "Reader", description: "", permissions: ["treasury.read"] });
        const ordinary = await setup.identity.createUser(userAdmin.token, { loginIdentifier: "ordinary.reader", displayName: "Ordinary Reader", status: "ACTIVE", roleIds: [reader.id] });
        assert.equal(ordinary.user.permissions.join(","), "treasury.read");

        // C-08: in the database, administration access can only be granted by a current super administrator.
        await assert.rejects(() => restricted("identity", (db) => db.query(
          `INSERT INTO abos.user_permission_grants (user_account_id, legal_entity_id, permission_code, granted_by_user_account_id)
           VALUES ($1, $2, 'admin.roles.manage', $3)`, [ordinary.user.id, setup.world.legalEntityId, userAdmin.id])), /only a super administrator/);

        // C-03: an account that also has access in another legal entity cannot be managed from this one.
        const other = await otherEntity(harness, setup.world);
        await harness.executor.query(
          `INSERT INTO abos.user_permission_grants (user_account_id, legal_entity_id, permission_code, granted_by_user_account_id)
           VALUES ($1, $2, 'treasury.read', $3)`, [ordinary.user.id, other.entityId, setup.world.bootstrapUserId]);
        await rejectsIdentity("NOT_FOUND", () => setup.identity.resetPassword(setup.adminToken, ordinary.user.id));
        await rejectsIdentity("NOT_FOUND", () => setup.identity.setStatus(setup.adminToken, ordinary.user.id, "DISABLED"));

        // Temporary passwords expire after 72 hours.
        const late = await setup.identity.createUser(setup.adminToken, { loginIdentifier: "late.starter", displayName: "Late Starter", status: "ACTIVE", roleIds: [reader.id] });
        await harness.executor.query("UPDATE abos.user_credentials SET password_set_at = clock_timestamp() - interval '73 hours' WHERE user_account_id = $1", [late.user.id]);
        await rejectsIdentity("TEMPORARY_PASSWORD_EXPIRED", () => setup.identity.login({ loginIdentifier: "late.starter", password: late.temporaryPassword, clientAddress: CLIENT }));
      } finally { await setup.close(); }
    });

    test("an employee holding Cashier and Finance Approver roles still cannot approve cash they recorded", async () => {
      const setup = await prepare(harness);
      try {
        const both = await employee(setup, "dual.role", ["treasury.read", "treasury.cash-receipt.record", "treasury.cash-count.record",
          "finance.report.operational.read", "finance.posting-intent.approve"]);
        const verifier = await employee(setup, "independent.verifier", ["treasury.read", "treasury.cash-receipt.verify", "treasury.handoff.create"]);
        const preparer = await employee(setup, "finance.preparer", ["finance.report.operational.read", "finance.posting-intent.create"]);
        // A Treasury manager - also created through administration - assigns the cashier to the safe.
        const manager = await employee(setup, "treasury.manager", ["treasury.read", "treasury.cash-location.manage"]);
        await restricted("treasury", (db) => new RestrictedTreasuryGateway(db).command(
          { bearerToken: manager.token, legalEntityId: setup.world.legalEntityId as LegalEntityId },
          "ASSIGN_CASHIER", { id: randomUUID(), cashLocationId: setup.world.cashLocationId, userAccountId: both.id }));
        const flow = await capitalIntent(harness, setup.world);
        const handoffId = await receiptThroughHandoff(setup.world, flow, both.token, verifier.token);

        // A cashier-only token cannot reach Finance functions at all.
        const cashierOnly = await employee(setup, "cashier.only", ["treasury.read", "treasury.cash-receipt.record"]);
        await assert.rejects(() => restricted("finance", (db) => db.query("SELECT abos.finance_handoff_workspace($1)", [cashierOnly.token])), /authority is missing|insufficient/i);
        await assert.rejects(() => restricted("finance", (db) => db.query("SELECT abos.finance_prepare_capital_posting($1,$2,$3,$4)",
          [cashierOnly.token, handoffId, setup.world.accountingPeriodId, `idem-${randomUUID()}`])), /authority is missing|insufficient/i);

        const key = `idem-${randomUUID()}`;
        const prepare1 = await restricted("finance", (db) => db.query<{ id: string }>("SELECT abos.finance_prepare_capital_posting($1,$2,$3,$4) AS id",
          [preparer.token, handoffId, setup.world.accountingPeriodId, key]));
        const prepare2 = await restricted("finance", (db) => db.query<{ id: string }>("SELECT abos.finance_prepare_capital_posting($1,$2,$3,$4) AS id",
          [preparer.token, handoffId, setup.world.accountingPeriodId, key]));
        assert.equal(prepare2.rows[0]?.id, prepare1.rows[0]?.id, "a repeated request with the same idempotency key returns the same posting intent");

        // The cashier who recorded and counted the cash holds the approve permission, and is still refused.
        await assert.rejects(() => restricted("finance", (db) => db.query("SELECT abos.finance_approve_capital_posting($1,$2)", [both.token, prepare1.rows[0]?.id])),
          /independent of intent preparation and Treasury custody/i);
        // The identity runtime cannot touch Treasury, Finance or ledger tables.
        await assert.rejects(() => restricted("identity", (db) => db.query("UPDATE abos.journals SET status = status")), /permission denied/i);
        await assert.rejects(() => restricted("identity", (db) => db.query("SELECT * FROM abos.cash_receipts")), /permission denied/i);
        await assert.rejects(() => restricted("identity", (db) => db.query("UPDATE abos.audit_records SET action = 'X'")), /permission denied|append-only/i);
      } finally { await setup.close(); }
    });
  });
}

// -----------------------------------------------------------------------------------------------

let adminPassword = "";

async function prepare(harness: Harness, options: { readonly changeAdminPassword?: boolean } = {}): Promise<Setup> {
  await resetSchema(harness.pool);
  const world = await seedSyntheticWorld(harness.executor);
  for (const login of Object.values(LOGINS)) await ensureLogin(harness, login);
  const bootstrap = await bootstrapSuperAdmin(harness.executor, {
    legalEntityId: world.legalEntityId, systemUserAccountId: world.bootstrapUserId,
    loginIdentifier: "super.admin", displayName: "Synthetic Super Admin"
  });
  adminPassword = bootstrap.temporaryPassword;
  const pool = new pg.Pool({ connectionString: loginUrl("identity"), max: 4 });
  const executor = new PostgresExecutor(pool, { runtimeMarker: MARKER });
  const identity = new IdentityService(executor, new SandboxAuthenticator(executor, SYNTHETIC_AUTH_CONFIGURATION), { attemptKeySecret: ATTEMPT_SECRET });
  let adminToken = "";
  if (options.changeAdminPassword !== false) {
    adminToken = (await identity.changePassword({ loginIdentifier: "super.admin", currentPassword: bootstrap.temporaryPassword, newPassword: "Synthetic admin passphrase 1", clientAddress: CLIENT })).token;
  }
  return { world, identity, adminToken, adminId: bootstrap.userAccountId, superAdminRoleId: bootstrap.roleId, close: () => pool.end() };
}

async function employee(setup: Setup, login: string, permissions: readonly string[]): Promise<{ id: string; token: string; password: string }> {
  const role = await setup.identity.createRole(setup.adminToken, { name: `Role for ${login}`, description: "", permissions });
  return employeeWithRole(setup, login, role.id);
}

async function employeeWithRole(setup: Setup, login: string, roleId: string): Promise<{ id: string; token: string; password: string }> {
  const created = await setup.identity.createUser(setup.adminToken, { loginIdentifier: login, displayName: `Synthetic ${login}`, status: "ACTIVE", roleIds: [roleId] });
  const password = `Chosen passphrase for ${login.split(".").reverse().join(" ")} 42`;
  const result = await setup.identity.changePassword({ loginIdentifier: login, currentPassword: created.temporaryPassword, newPassword: password, clientAddress: CLIENT });
  return { id: created.user.id, token: result.token, password };
}

async function signInAs(identity: IdentityService, login: string, password: string): Promise<string> {
  try {
    return (await identity.login({ loginIdentifier: login, password, clientAddress: CLIENT })).token;
  } catch (error) {
    if (error instanceof IdentityError && error.code === "PASSWORD_CHANGE_REQUIRED") {
      return (await identity.changePassword({ loginIdentifier: login, currentPassword: password, newPassword: `Fresh passphrase ${randomUUID().slice(0, 8)}`, clientAddress: CLIENT })).token;
    }
    throw error;
  }
}

async function rejectsIdentity(code: IdentityErrorCode, run: () => Promise<unknown>): Promise<void> {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof IdentityError, `expected IdentityError ${code}, got ${String(error)}`);
    assert.equal(error.code, code, error.message);
    return true;
  });
}

function loginUrl(kind: keyof typeof LOGINS): string {
  const url = new URL(databaseUrl() ?? "");
  url.username = LOGINS[kind].name; url.password = LOGINS[kind].password;
  return url.toString();
}

async function ensureLogin(harness: Harness, login: (typeof LOGINS)[keyof typeof LOGINS]): Promise<void> {
  const exists = await harness.executor.query<{ exists: boolean }>("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists", [login.name]);
  const verb = exists.rows[0]?.exists === true ? "ALTER" : "CREATE";
  const extra = verb === "CREATE" ? " NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION" : "";
  await harness.executor.query(`${verb} ROLE ${login.name} LOGIN INHERIT${extra} PASSWORD '${login.password}'`);
  await harness.executor.query(`GRANT ${login.role} TO ${login.name}`);
}

async function restricted<T>(kind: keyof typeof LOGINS, operation: (db: SqlExecutor) => Promise<T>): Promise<T> {
  const pool = new pg.Pool({ connectionString: loginUrl(kind), max: 1 });
  try {
    return await operation(new PostgresExecutor(pool, { runtimeMarker: MARKER }));
  } finally {
    await pool.end();
  }
}

async function otherEntity(harness: Harness, world: SyntheticWorld): Promise<{ userId: string; roleId: string; entityId: string }> {
  const companyId = randomUUID(); const entityId = randomUUID(); const userId = randomUUID(); const roleId = randomUUID();
  await harness.executor.query("INSERT INTO abos.companies (id, code, name, status) VALUES ($1, $2, 'Other Synthetic Holding', 'ACTIVE')", [companyId, `OSH-${companyId.slice(0, 8)}`]);
  await harness.executor.query("INSERT INTO abos.legal_entities (id, company_id, code, name) VALUES ($1, $2, $3, 'Other Synthetic Entity')", [entityId, companyId, `OSE-${entityId.slice(0, 8)}`]);
  await harness.executor.query(
    "INSERT INTO abos.user_accounts (id, login_identifier, display_name, status, primary_legal_entity_id) VALUES ($1, $2, 'Other Entity Person', 'ACTIVE', $3)",
    [userId, `other.${userId.slice(0, 8)}`, entityId]);
  await harness.executor.query(
    "INSERT INTO abos.access_roles (id, legal_entity_id, role_name, created_by_user_account_id) VALUES ($1, $2, 'Other Entity Role', $3)",
    [roleId, entityId, world.bootstrapUserId]);
  return { userId, roleId, entityId };
}

interface Flow { readonly intentId: string; readonly countEvidenceId: string; readonly receiptEvidenceId: string }

async function capitalIntent(harness: Harness, world: SyntheticWorld): Promise<Flow> {
  const service = new CapitalReceiptIntentService(new PostgresShareholderRepository(harness.executor, world.intentCreatorId as UserAccountId));
  const row = (await harness.executor.query<{ id: string; document_id: string; evidence_kind: EvidenceReference["kind"]; evidence_version: number; sha256: string; completed_at: Date | string }>(
    "SELECT id, document_id, evidence_kind, evidence_version, sha256, completed_at FROM abos.evidence_references WHERE id = $1",
    [world.agreementDocumentEvidenceId])).rows[0];
  assert.ok(row);
  const intent = await service.createCapitalReceiptIntent({
    legalEntityId: world.legalEntityId as LegalEntityId,
    shareholderPartyId: world.businessPartyId as never,
    agreementId: world.agreementId as CapitalAgreementId,
    installmentId: world.installmentId as CapitalInstallmentId,
    amount: { amount: asDecimalString(world.installmentAmount), currency: "USD" },
    expectedDestinationAccountId: world.cashAccountId as CashLocationCurrencyAccountId,
    businessEventAt: "2026-09-22T07:00:00.000Z",
    source: { legalEntityId: world.legalEntityId as LegalEntityId, idempotencyKey: `identity-${randomUUID()}` as IdempotencyKey, correlationId: randomUUID() as CorrelationId },
    evidence: [{ id: row.id as never, documentId: row.document_id as never, kind: row.evidence_kind, version: row.evidence_version, sha256: row.sha256,
      completedAt: new Date(row.completed_at).toISOString() }]
  });
  const bound = await bindSyntheticTreasuryEvidence(harness.executor, world, intent.id);
  await bindSyntheticFinanceApprovalEvidence(harness.executor, world, intent.id);
  return { intentId: intent.id, ...bound };
}

async function receiptThroughHandoff(world: SyntheticWorld, flow: Flow, cashierToken: string, verifierToken: string): Promise<string> {
  const cashier = { bearerToken: cashierToken, legalEntityId: world.legalEntityId as LegalEntityId };
  const verifier = { bearerToken: verifierToken, legalEntityId: world.legalEntityId as LegalEntityId };
  const receiptId = randomUUID(); const handoffId = randomUUID();
  await restricted("treasury", (db) => new RestrictedTreasuryGateway(db).command(cashier, "RECORD_RECEIPT", {
    id: receiptId, capitalReceiptIntentId: flow.intentId, receiptReference: `ID-${receiptId.slice(0, 8)}`, businessEventAt: "2026-09-22T07:10:00.000Z" }));
  await restricted("treasury", (db) => new RestrictedTreasuryGateway(db).command(cashier, "COUNT_RECEIPT", {
    id: receiptId, countId: randomUUID(), countedAmount: world.installmentAmount,
    countEvidenceReferenceId: flow.countEvidenceId, receiptEvidenceReferenceId: flow.receiptEvidenceId }));
  await restricted("treasury", (db) => new RestrictedTreasuryGateway(db).command(cashier, "SUBMIT_RECEIPT", { id: receiptId }));
  await restricted("treasury", (db) => new RestrictedTreasuryGateway(db).command(verifier, "VERIFY_RECEIPT", { id: receiptId }));
  await restricted("treasury", (db) => new RestrictedTreasuryGateway(db).command(verifier, "HANDOFF_RECEIPT", { id: receiptId, handoffId, correlationId: randomUUID() }));
  return handoffId;
}
