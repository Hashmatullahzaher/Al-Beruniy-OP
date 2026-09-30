import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import type { SqlExecutor } from "@abos/database";
import { bootstrapSuperAdmin, hashPassword, IdentityError, IdentityService } from "@abos/identity";
import { PostgresExecutor } from "@abos/persistence";
import { identityDatabaseProof, SandboxAuthenticator } from "@abos/sandbox-auth";
import { databaseUrl, MISSING_DATABASE_MESSAGE, openHarness, resetSchema } from "./harness.ts";
import { seedSyntheticWorld, SYNTHETIC_AUTH_CONFIGURATION } from "./synthetic-world.ts";

const LOGIN_NAME = "abos_v1_identity_runtime_test_login";
const LOGIN_PASSWORD = "synthetic-identity-runtime-only-2026";
const ATTEMPT_SECRET = "synthetic-login-attempt-key-secret-for-tests-only";
const CLIENT = "203.0.113.19";

if (databaseUrl() === undefined) {
  test("V1 session rotation", () => assert.fail(MISSING_DATABASE_MESSAGE));
} else {
  test("a restricted identity login rotates a live session once and rejects replay and stale credentials", async () => {
    const harness = await openHarness(SYNTHETIC_AUTH_CONFIGURATION.runtimeMarker);
    let pool: pg.Pool | undefined;
    try {
      await resetSchema(harness.pool);
      const world = await seedSyntheticWorld(harness.executor);
      await ensureRestrictedIdentityLogin(harness.executor);
      const admin = await bootstrapSuperAdmin(harness.executor, {
        legalEntityId: world.legalEntityId, systemUserAccountId: world.bootstrapUserId,
        loginIdentifier: "rotation.admin", displayName: "Synthetic Rotation Admin"
      });
      const url = new URL(databaseUrl()!);
      url.username = LOGIN_NAME;
      url.password = LOGIN_PASSWORD;
      pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
      const db = new PostgresExecutor(pool, { runtimeMarker: SYNTHETIC_AUTH_CONFIGURATION.runtimeMarker });
      const identity = new IdentityService(db, new SandboxAuthenticator(db, SYNTHETIC_AUTH_CONFIGURATION), {
        attemptKeySecret: ATTEMPT_SECRET
      });
      // Password sign-in/change/refresh is operational; developer-issued synthetic sessions are not.
      const developerAuthenticator = new SandboxAuthenticator(harness.executor, SYNTHETIC_AUTH_CONFIGURATION);
      const disposableDeveloperHash = await hashPassword("Disposable developer refresh password 47");
      await harness.executor.query(
        `INSERT INTO abos.user_credentials
           (user_account_id,password_hash,must_change_password,password_set_at,password_set_by_user_account_id)
         VALUES ($1,$2,false,clock_timestamp(),$1)`,
        [world.intentCreatorId, disposableDeveloperHash]
      );
      const persona = await developerAuthenticator.issueSession({
        userAccountId: world.intentCreatorId as never, legalEntityId: world.legalEntityId as never
      });
      const personaRefreshed = await developerAuthenticator.rotateSession(harness.executor, persona.token);
      assert.equal(personaRefreshed.sessionProvenance, "SYNTHETIC_DEVELOPER");
      const developerProvenance = await harness.executor.query<{ provenance: string }>(
        "SELECT session_provenance AS provenance FROM abos.sandbox_sessions WHERE id=$1",
        [personaRefreshed.sessionId]
      );
      assert.equal(developerProvenance.rows[0]?.provenance, "SYNTHETIC_DEVELOPER");
      await harness.executor.query("DELETE FROM abos.sandbox_authorizations");
      await assert.rejects(() => new SandboxAuthenticator(db, SYNTHETIC_AUTH_CONFIGURATION).issueSession({
        userAccountId: admin.userAccountId as never, legalEntityId: world.legalEntityId as never
      }), /no sandbox authorization/i);
      const personaOperational = await new SandboxAuthenticator(db, SYNTHETIC_AUTH_CONFIGURATION).issuePasswordSession({
        userAccountId: world.intentCreatorId as never,
        legalEntityId: world.legalEntityId as never,
        expectedPasswordHash: disposableDeveloperHash
      });
      const initial = await identity.changePassword({
        loginIdentifier: "rotation.admin", currentPassword: admin.temporaryPassword,
        newPassword: "Synthetic rotation passphrase 47", clientAddress: CLIENT
      });
      const login = await identity.login({
        loginIdentifier: "rotation.admin", password: "Synthetic rotation passphrase 47", clientAddress: CLIENT
      });
      assert.equal(login.user.userAccountId, admin.userAccountId);
      assert.equal(await sessionProvenance(harness.executor, login.token), "PASSWORD_OPERATIONAL");
      await identity.logout(login.token);
      await assert.rejects(() => new SandboxAuthenticator(db, SYNTHETIC_AUTH_CONFIGURATION).issuePasswordSession({
        userAccountId: admin.userAccountId as never, legalEntityId: world.legalEntityId as never,
        expectedPasswordHash: "changed-or-forged-password-hash"
      }), /password session authority is no longer current|Credentials changed/i);
      const renewed = await identity.refreshSession(initial.token, CLIENT);
      assert.notEqual(renewed.token, initial.token);
      assert.equal(renewed.user.userAccountId, admin.userAccountId);
      assert.equal(await sessionProvenance(harness.executor, renewed.token), "PASSWORD_OPERATIONAL");
      await assertIdentityDenied(() => identity.currentUser(initial.token));
      await assertIdentityDenied(() => identity.refreshSession(initial.token, CLIENT));

      const concurrent = await Promise.allSettled([
        identity.refreshSession(renewed.token, CLIENT), identity.refreshSession(renewed.token, CLIENT)
      ]);
      assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(concurrent.filter((result) => result.status === "rejected").length, 1);
      const surviving = concurrent.find((result) => result.status === "fulfilled");
      assert.ok(surviving && surviving.status === "fulfilled");
      await assertIdentityDenied(() => identity.currentUser(renewed.token));
      assert.equal((await identity.currentUser(surviving.value.token)).userAccountId, admin.userAccountId);
      const sessions = await harness.executor.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM abos.sandbox_sessions
          WHERE user_account_id = $1 AND revoked_at IS NULL AND expires_at > clock_timestamp()`,
        [admin.userAccountId]
      );
      assert.equal(sessions.rows[0]?.count, "1");

      await harness.executor.query(
        `UPDATE abos.user_permission_grants SET revoked_at=clock_timestamp()
          WHERE user_account_id=$1 AND legal_entity_id=$2 AND revoked_at IS NULL`,
        [world.intentCreatorId, world.legalEntityId]
      );
      await assertIdentityDenied(() => identity.currentUser(personaOperational.token));
      await assertIdentityDenied(() => identity.refreshSession(personaOperational.token, CLIENT));

      await identity.logout(surviving.value.token);
      await assertIdentityDenied(() => identity.refreshSession(surviving.value.token, CLIENT));

      // Even a persona that now has a current password cannot use or refresh its already-issued
      // synthetic session as an operational session; provenance, not credential existence, wins.
      const credentials = await harness.executor.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM abos.user_credentials WHERE user_account_id = $1",
        [world.intentCreatorId]
      );
      assert.equal(credentials.rows[0]?.count, "1");
      await assertIdentityDenied(() => identity.currentUser(personaRefreshed.token));
      await assertIdentityDenied(() => identity.refreshSession(personaRefreshed.token, CLIENT));
    } finally {
      await pool?.end();
      await harness.close();
    }
  });

  test("restricted identity credentials cannot mutate security state or assume owner roles", async (t) => {
    const harness = await openHarness(SYNTHETIC_AUTH_CONFIGURATION.runtimeMarker);
    let pool: pg.Pool | undefined;
    try {
      await resetSchema(harness.pool);
      const world = await seedSyntheticWorld(harness.executor);
      await ensureRestrictedIdentityLogin(harness.executor);
      const admin = await bootstrapSuperAdmin(harness.executor, {
        legalEntityId: world.legalEntityId, systemUserAccountId: world.bootstrapUserId,
        loginIdentifier: "attack.probe.admin", displayName: "Synthetic Attack Probe Admin"
      });
      pool = new pg.Pool({ connectionString: restrictedUrl(), max: 1 });
      const db = new PostgresExecutor(pool, { runtimeMarker: SYNTHETIC_AUTH_CONFIGURATION.runtimeMarker });
      const attackerChosenHash = await hashPassword("Synthetic attacker chosen password 88");
      await t.test("cannot directly replace a privileged password hash", async () => {
        await assert.rejects(
          () => db.query("UPDATE abos.user_credentials SET password_hash = $2, must_change_password = false WHERE user_account_id = $1",
            [admin.userAccountId, attackerChosenHash]),
          /permission denied/i,
          "A stolen identity runtime credential must not replace another user's password hash"
        );
      });
      await t.test("cannot mint a privileged session without knowing the password", async () => {
        const token = `synthetic-forged-token-${randomUUID()}`;
        const digest = (value: string) => createHash("sha256").update(value).digest("hex");
        await assert.rejects(
          () => db.query(
            "INSERT INTO abos.login_attempts (id, login_key, client_key, user_account_id, succeeded) VALUES ($1, $2, $3, $4, true)",
            [randomUUID(), digest("attack-login"), digest("attack-client"), admin.userAccountId]
          ), /permission denied/i
        );
        await assert.rejects(
          () => db.query(
            `INSERT INTO abos.sandbox_sessions
               (id, user_account_id, token_sha256, runtime_token_sha256, legal_entity_id, issued_at, expires_at)
             VALUES ($1, $2, $3, $4, $5, clock_timestamp(), clock_timestamp() + interval '15 minutes')`,
            [randomUUID(), admin.userAccountId, digest("fake-peppered-digest"), digest(token), world.legalEntityId]
          ), /permission denied/i
        );
        const identity = new IdentityService(db, new SandboxAuthenticator(db, SYNTHETIC_AUTH_CONFIGURATION), {
          attemptKeySecret: ATTEMPT_SECRET
        });
        await assertIdentityDenied(() => identity.currentUser(token));
      });
      await t.test("cannot directly assign roles, permissions or assume the identity owner", async () => {
        await assert.rejects(
          () => db.query(
            `INSERT INTO abos.user_permission_grants
               (user_account_id, legal_entity_id, permission_code, granted_by_user_account_id)
             VALUES ($1, $2, 'finance.journal.post', $3)`,
            [admin.userAccountId, world.legalEntityId, world.bootstrapUserId]
          ), /permission denied/i
        );
        await assert.rejects(() => db.query("SET ROLE abos_v1_identity_owner"), /permission denied/i);
      });
      await t.test("cannot use any privileged identity entry point without the server proof", async () => {
        for (const [sql, parameters] of [
          ["SELECT abos.identity_issue_session_context($1,$2,$3,$4)",
            ["wrong-secret-that-is-still-long-enough-000", admin.userAccountId, world.legalEntityId, null]],
          ["SELECT abos.identity_actor_context($1,$2,$3)",
            ["wrong-secret-that-is-still-long-enough-000", "a".repeat(64), "b".repeat(64)]],
          ["SELECT abos.identity_runtime_lock($1,'USER_ACCOUNT',$2::jsonb)",
            ["wrong-secret-that-is-still-long-enough-000", JSON.stringify({ userAccountId: admin.userAccountId, legalEntityId: world.legalEntityId })]],
          ["SELECT abos.identity_runtime_command($1,'REVOKE_USER_SESSIONS',$2::jsonb)",
            ["wrong-secret-that-is-still-long-enough-000", JSON.stringify({ userAccountId: admin.userAccountId })]]
        ] as const) {
          await assert.rejects(
            () => db.query(sql, parameters),
            (error: unknown) => (error as { code?: string }).code === "42501" && /proof is invalid/i.test(String(error))
          );
        }
      });
      await t.test("the raw signing secret is not a database proof; only its domain-separated derivative is", async () => {
        const payload = JSON.stringify({ userAccountId: admin.userAccountId });
        await assert.rejects(
          () => db.query("SELECT abos.identity_runtime_command($1,'REVOKE_USER_SESSIONS',$2::jsonb)",
            [SYNTHETIC_AUTH_CONFIGURATION.signingSecret, payload]),
          (error: unknown) => (error as { code?: string }).code === "42501" && /proof is invalid/i.test(String(error))
        );
        const accepted = await db.query<{ readonly value: { readonly affected: number } }>(
          "SELECT abos.identity_runtime_command($1,'REVOKE_USER_SESSIONS',$2::jsonb) AS value",
          [identityDatabaseProof(SYNTHETIC_AUTH_CONFIGURATION.signingSecret), payload]
        );
        assert.equal(typeof accepted.rows[0]?.value.affected, "number");
        const stored = await harness.executor.query<{ readonly digest: string }>(
          "SELECT signing_secret_sha256 AS digest FROM abos.identity_runtime_configuration");
        assert.notEqual(stored.rows[0]?.digest,
          createHash("sha256").update(SYNTHETIC_AUTH_CONFIGURATION.signingSecret, "utf8").digest("hex"));
      });
      await t.test("owner and function privileges are narrow", async () => {
        const checks = await harness.executor.query<{
          owner_bypass: boolean; runtime_writes: boolean; public_execute: boolean;
          runtime_execute: boolean; runtime_is_owner_member: boolean;
        }>(`SELECT
          (SELECT rolbypassrls FROM pg_roles WHERE rolname='abos_v1_identity_owner') AS owner_bypass,
          has_table_privilege('abos_v1_identity_runtime','abos.user_credentials','INSERT,UPDATE,DELETE')
            OR has_table_privilege('abos_v1_identity_runtime','abos.login_attempts','INSERT,UPDATE,DELETE')
            OR has_table_privilege('abos_v1_identity_runtime','abos.sandbox_sessions','INSERT,UPDATE,DELETE')
            OR has_table_privilege('abos_v1_identity_runtime','abos.user_role_assignments','INSERT,UPDATE,DELETE') AS runtime_writes,
          has_function_privilege('public','abos.identity_runtime_command(text,text,jsonb)','EXECUTE') AS public_execute,
          has_function_privilege('abos_v1_identity_runtime','abos.identity_runtime_command(text,text,jsonb)','EXECUTE') AS runtime_execute,
          pg_has_role('abos_v1_identity_runtime','abos_v1_identity_owner','MEMBER') AS runtime_is_owner_member`);
        assert.deepEqual(checks.rows[0], {
          owner_bypass: false, runtime_writes: false, public_execute: false,
          runtime_execute: true, runtime_is_owner_member: false
        });
      });
    } finally {
      await pool?.end();
      await harness.close();
    }
  });
}

async function sessionProvenance(database: SqlExecutor, token: string): Promise<string | undefined> {
  const result = await database.query<{ provenance: string }>(
    `SELECT session_provenance AS provenance FROM abos.sandbox_sessions
      WHERE runtime_token_sha256=encode(sha256(convert_to($1,'UTF8')),'hex')`,
    [token]
  );
  return result.rows[0]?.provenance;
}

async function ensureRestrictedIdentityLogin(db: SqlExecutor): Promise<void> {
  const role = await db.query<{ exists: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists", [LOGIN_NAME]
  );
  const verb = role.rows[0]?.exists ? "ALTER" : "CREATE";
  await db.query(
    `${verb} ROLE ${LOGIN_NAME} LOGIN INHERIT${verb === "CREATE" ? " NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION" : ""} PASSWORD '${LOGIN_PASSWORD}'`
  );
  await db.query(`GRANT abos_v1_identity_runtime TO ${LOGIN_NAME}`);
}

function restrictedUrl(): string {
  const url = new URL(databaseUrl()!);
  url.username = LOGIN_NAME;
  url.password = LOGIN_PASSWORD;
  return url.toString();
}

async function assertIdentityDenied(run: () => Promise<unknown>): Promise<void> {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof IdentityError);
    assert.equal(error.code, "AUTHENTICATION_REQUIRED");
    return true;
  });
}
