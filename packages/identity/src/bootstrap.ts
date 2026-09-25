import { randomUUID } from "node:crypto";

import type { SqlExecutor } from "@abos/database";

import { assertIdentity } from "./errors.ts";
import { ADMIN_ROLES, ADMIN_USERS, normalizeLogin } from "./identity-service.ts";
import { generateTemporaryPassword, hashPassword, passwordProblems } from "./password.ts";

export const SUPER_ADMIN_ROLE_NAME = "Super Administrator";

/**
 * Controlled first-administrator bootstrap.
 *
 * Run by an operator with the migration/owner credential, never from the web application. It
 * creates one Super Administrator in a legal entity that has none, with a random temporary password
 * that is returned once and must be changed at first sign-in. The grant is recorded as made by a
 * named system account that has no password and therefore can never sign in or approve anything.
 * It refuses to run when the legal entity already has an active Super Administrator, so it cannot
 * be used to add a second one behind the existing administrators' backs.
 */
export async function bootstrapSuperAdmin(owner: SqlExecutor, input: {
  readonly legalEntityId: string;
  readonly systemUserAccountId: string;
  readonly loginIdentifier: string;
  readonly displayName: string;
}): Promise<{ readonly userAccountId: string; readonly roleId: string; readonly temporaryPassword: string }> {
  const login = normalizeLogin(input.loginIdentifier);
  assertIdentity(/^[a-z0-9][a-z0-9._-]{2,63}$/.test(login), "VALIDATION_FAILED", "Invalid administrator username");
  assertIdentity(input.displayName.trim().length >= 2, "VALIDATION_FAILED", "Invalid administrator name");
  let temporaryPassword = generateTemporaryPassword(20);
  while (passwordProblems(temporaryPassword, login).length > 0) temporaryPassword = generateTemporaryPassword(20);
  const hash = await hashPassword(temporaryPassword);

  return owner.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('abos-super-admin-bootstrap', 0))");
    const existing = await tx.query(
      `SELECT 1
         FROM abos.user_permission_grants users_grant
         JOIN abos.user_permission_grants roles_grant
           ON roles_grant.user_account_id = users_grant.user_account_id
          AND roles_grant.legal_entity_id = users_grant.legal_entity_id
          AND roles_grant.permission_code = $3 AND roles_grant.revoked_at IS NULL
         JOIN abos.user_accounts account ON account.id = users_grant.user_account_id AND account.status = 'ACTIVE'
         JOIN abos.user_credentials credential ON credential.user_account_id = account.id
        WHERE users_grant.legal_entity_id = $1 AND users_grant.permission_code = $2 AND users_grant.revoked_at IS NULL`,
      [input.legalEntityId, ADMIN_USERS, ADMIN_ROLES]
    );
    assertIdentity(existing.rows.length === 0, "DUPLICATE", "This legal entity already has an active Super Administrator; use the application instead.");
    const system = await tx.query(
      `SELECT 1 FROM abos.user_accounts u
        WHERE u.id = $1 AND NOT EXISTS (SELECT 1 FROM abos.user_credentials c WHERE c.user_account_id = u.id)`,
      [input.systemUserAccountId]
    );
    assertIdentity(system.rows.length === 1, "VALIDATION_FAILED", "The bootstrap system account must exist and must not be able to sign in.");

    const existingRole = (await tx.query<{ readonly id: string; readonly status: string; readonly permissions: string[] }>(
      `SELECT r.id, r.status,
              coalesce((SELECT jsonb_agg(rp.permission_code ORDER BY rp.permission_code) FROM abos.access_role_permissions rp WHERE rp.role_id = r.id), '[]'::jsonb) AS permissions
         FROM abos.access_roles r WHERE r.legal_entity_id = $1 AND lower(r.role_name) = lower($2)`,
      [input.legalEntityId, SUPER_ADMIN_ROLE_NAME]
    )).rows[0];
    // A reused role must be exactly the Super Administrator role: active, with both administration permissions and nothing else.
    assertIdentity(existingRole === undefined || (existingRole.status === "ACTIVE" && existingRole.permissions.join(",") === [ADMIN_ROLES, ADMIN_USERS].sort().join(",")),
      "VALIDATION_FAILED", `A role named "${SUPER_ADMIN_ROLE_NAME}" exists but is not the standard active Super Administrator role.`);
    let role = existingRole?.id;
    if (role === undefined) {
      role = randomUUID();
      await tx.query(
        `INSERT INTO abos.access_roles (id, legal_entity_id, role_name, description, created_by_user_account_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [role, input.legalEntityId, SUPER_ADMIN_ROLE_NAME,
          "Creates employee accounts, custom roles and permissions. Cannot approve financial transactions unless also given those permissions.",
          input.systemUserAccountId]
      );
      for (const code of [ADMIN_USERS, ADMIN_ROLES]) {
        await tx.query(
          "INSERT INTO abos.access_role_permissions (role_id, permission_code, added_by_user_account_id) VALUES ($1, $2, $3)",
          [role, code, input.systemUserAccountId]
        );
      }
    }

    const userAccountId = randomUUID();
    await tx.query(
      `INSERT INTO abos.user_accounts
         (id, login_identifier, display_name, status, primary_legal_entity_id, created_by_user_account_id, updated_at)
       VALUES ($1, $2, $3, 'ACTIVE', $4, $5, clock_timestamp())`,
      [userAccountId, login, input.displayName.trim(), input.legalEntityId, input.systemUserAccountId]
    );
    await tx.query(
      `INSERT INTO abos.user_credentials (user_account_id, password_hash, must_change_password, password_set_by_user_account_id)
       VALUES ($1, $2, true, $3)`,
      [userAccountId, hash, input.systemUserAccountId]
    );
    await tx.query(
      `INSERT INTO abos.user_role_assignments (id, user_account_id, role_id, legal_entity_id, assigned_by_user_account_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), userAccountId, role, input.legalEntityId, input.systemUserAccountId]
    );
    await tx.query("SELECT abos.sync_role_grants($1, $2, $3)", [userAccountId, input.legalEntityId, input.systemUserAccountId]);
    await tx.query(
      `INSERT INTO abos.audit_records (id, actor_user_account_id, legal_entity_id, correlation_id, action, entity_type, entity_id, after_state, metadata)
       VALUES ($1, $2, $3, $4, 'SUPER_ADMIN_BOOTSTRAPPED', 'USER_ACCOUNT', $5, $6, $7)`,
      [randomUUID(), input.systemUserAccountId, input.legalEntityId, randomUUID(), userAccountId,
        JSON.stringify({ loginIdentifier: login, displayName: input.displayName.trim(), roleId: role, mustChangePassword: true }),
        JSON.stringify({ source: "operator-bootstrap" })]
    );
    return { userAccountId, roleId: role, temporaryPassword };
  });
}
