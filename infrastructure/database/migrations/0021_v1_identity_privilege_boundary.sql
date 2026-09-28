-- V1 identity privilege boundary.
--
-- The application database credential may read the identity projection, but it may not directly
-- change passwords, login attempts, sessions, users, roles, grants or audit records. Mutations use
-- the finite command list below and require the server-held sandbox signing secret. The database
-- stores only its SHA-256 digest. Deployment/bootstrap code must provision that digest using an
-- owner connection before identity mutations are enabled.

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'abos_v1_identity_owner') THEN
    CREATE ROLE abos_v1_identity_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
      NOREPLICATION NOBYPASSRLS NOINHERIT;
  ELSE
    ALTER ROLE abos_v1_identity_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
      NOREPLICATION NOBYPASSRLS NOINHERIT;
  END IF;
END
$roles$;

REVOKE abos_v1_identity_owner FROM abos_v1_identity_runtime;

DO $owner_membership$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_auth_members membership
      JOIN pg_catalog.pg_roles granted_role ON granted_role.oid = membership.roleid
      JOIN pg_catalog.pg_roles member_role ON member_role.oid = membership.member
     WHERE granted_role.rolname = 'abos_v1_identity_owner'
        OR member_role.rolname = 'abos_v1_identity_owner'
  ) THEN
    RAISE EXCEPTION 'abos_v1_identity_owner has a membership; remove it before applying this migration';
  END IF;
END
$owner_membership$;

CREATE TABLE abos.identity_runtime_configuration (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  signing_secret_sha256 text NOT NULL CHECK (signing_secret_sha256 ~ '^[0-9a-f]{64}$'),
  configured_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON abos.identity_runtime_configuration FROM PUBLIC, abos_v1_identity_runtime;
GRANT SELECT ON abos.identity_runtime_configuration TO abos_v1_identity_owner;

GRANT USAGE ON SCHEMA abos TO abos_v1_identity_owner;
GRANT SELECT ON
  abos.identity_runtime_configuration, abos.user_accounts, abos.user_credentials,
  abos.login_attempts, abos.access_roles, abos.access_role_permissions,
  abos.user_role_assignments, abos.user_permission_grants, abos.sandbox_sessions,
  abos.permission_catalogue, abos.audit_records, abos.legal_entity_profiles,
  abos.sandbox_authorizations, abos.sandbox_legal_entity_scopes
TO abos_v1_identity_owner;
GRANT INSERT, UPDATE ON abos.user_accounts, abos.user_credentials, abos.access_roles,
  abos.user_role_assignments, abos.user_permission_grants, abos.sandbox_sessions,
  abos.legal_entity_profiles TO abos_v1_identity_owner;
GRANT INSERT ON abos.login_attempts, abos.audit_records TO abos_v1_identity_owner;
GRANT INSERT, DELETE ON abos.access_role_permissions TO abos_v1_identity_owner;
GRANT EXECUTE ON FUNCTION abos.role_derived_permissions(uuid, uuid),
  abos.check_super_admin_remains(uuid) TO abos_v1_identity_owner;

CREATE FUNCTION abos.identity_issue_session_context(
  p_signing_secret text, p_user_account_id uuid, p_legal_entity_id uuid,
  p_expected_password_hash text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $context$
DECLARE
  account_status text;
  grant_count integer;
  credential_current boolean := true;
BEGIN
  IF p_signing_secret IS NULL OR pg_catalog.length(p_signing_secret) < 32 OR NOT EXISTS (
    SELECT 1 FROM abos.identity_runtime_configuration configuration
     WHERE configuration.singleton
       AND configuration.signing_secret_sha256 = pg_catalog.encode(
         pg_catalog.sha256(pg_catalog.convert_to(p_signing_secret, 'UTF8')), 'hex')
  ) THEN
    RAISE EXCEPTION 'identity runtime proof is invalid or not configured'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT status INTO account_status FROM abos.user_accounts
   WHERE id = p_user_account_id FOR SHARE;
  IF p_expected_password_hash IS NOT NULL THEN
    SELECT credential.password_hash = p_expected_password_hash
           AND NOT credential.must_change_password
      INTO credential_current
      FROM abos.user_credentials credential
     WHERE credential.user_account_id = p_user_account_id
     FOR SHARE;
    credential_current := COALESCE(credential_current, false);
  END IF;
  PERFORM 1 FROM abos.user_permission_grants
   WHERE user_account_id = p_user_account_id AND legal_entity_id = p_legal_entity_id
     AND revoked_at IS NULL FOR SHARE;
  GET DIAGNOSTICS grant_count = ROW_COUNT;
  RETURN pg_catalog.jsonb_build_object(
    'status', account_status, 'grantCount', grant_count,
    'credentialCurrent', credential_current);
END
$context$;

CREATE FUNCTION abos.identity_actor_context(
  p_signing_secret text, p_runtime_token_sha256 text, p_token_sha256 text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $context$
DECLARE
  session_row record;
  permissions text[];
BEGIN
  IF p_signing_secret IS NULL OR pg_catalog.length(p_signing_secret) < 32 OR NOT EXISTS (
    SELECT 1 FROM abos.identity_runtime_configuration configuration
     WHERE configuration.singleton
       AND configuration.signing_secret_sha256 = pg_catalog.encode(
         pg_catalog.sha256(pg_catalog.convert_to(p_signing_secret, 'UTF8')), 'hex')
  ) THEN
    RAISE EXCEPTION 'identity runtime proof is invalid or not configured'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT session.id, session.user_account_id, session.legal_entity_id,
         session.revoked_at IS NULL AND session.expires_at > pg_catalog.clock_timestamp() AS live,
         account.status, account.login_identifier, credential.must_change_password
    INTO session_row
    FROM abos.sandbox_sessions session
    JOIN abos.user_accounts account ON account.id = session.user_account_id
    JOIN abos.user_credentials credential ON credential.user_account_id = account.id
   WHERE session.runtime_token_sha256 = p_runtime_token_sha256
     AND session.token_sha256 = p_token_sha256
   FOR SHARE OF session, account, credential;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM 1 FROM abos.user_permission_grants grant_row
   WHERE grant_row.user_account_id = session_row.user_account_id
     AND grant_row.legal_entity_id = session_row.legal_entity_id
     AND grant_row.revoked_at IS NULL FOR SHARE;
  SELECT COALESCE(pg_catalog.array_agg(grant_row.permission_code ORDER BY grant_row.permission_code), ARRAY[]::text[])
    INTO permissions FROM abos.user_permission_grants grant_row
   WHERE grant_row.user_account_id = session_row.user_account_id
     AND grant_row.legal_entity_id = session_row.legal_entity_id
     AND grant_row.revoked_at IS NULL;
  RETURN pg_catalog.jsonb_build_object(
    'id', session_row.id, 'userAccountId', session_row.user_account_id,
    'legalEntityId', session_row.legal_entity_id, 'live', session_row.live,
    'status', session_row.status, 'loginIdentifier', session_row.login_identifier,
    'mustChangePassword', session_row.must_change_password,
    'permissions', pg_catalog.to_jsonb(permissions));
END
$context$;

CREATE FUNCTION abos.identity_runtime_lock(
  p_signing_secret text,
  p_operation text,
  p_payload jsonb
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $lock$
DECLARE
  affected integer := 0;
BEGIN
  IF p_signing_secret IS NULL OR pg_catalog.length(p_signing_secret) < 32 OR NOT EXISTS (
    SELECT 1 FROM abos.identity_runtime_configuration configuration
     WHERE configuration.singleton
       AND configuration.signing_secret_sha256 = pg_catalog.encode(
         pg_catalog.sha256(pg_catalog.convert_to(p_signing_secret, 'UTF8')), 'hex')
  ) THEN
    RAISE EXCEPTION 'identity runtime proof is invalid or not configured'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'identity lock payload must be an object'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  CASE p_operation
    WHEN 'LEGAL_ENTITY_PROFILE' THEN
      PERFORM 1 FROM abos.legal_entity_profiles profile
       WHERE profile.legal_entity_id = (p_payload->>'legalEntityId')::uuid
       FOR UPDATE;

    WHEN 'USER_ACCOUNT' THEN
      PERFORM 1 FROM abos.user_accounts account
       WHERE account.id = (p_payload->>'userAccountId')::uuid
         AND account.primary_legal_entity_id = (p_payload->>'legalEntityId')::uuid
         AND NOT EXISTS (
           SELECT 1 FROM abos.user_permission_grants other_grant
            WHERE other_grant.user_account_id = account.id
              AND other_grant.legal_entity_id <> (p_payload->>'legalEntityId')::uuid
              AND other_grant.revoked_at IS NULL)
         AND NOT EXISTS (
           SELECT 1 FROM abos.user_role_assignments other_assignment
            WHERE other_assignment.user_account_id = account.id
              AND other_assignment.legal_entity_id <> (p_payload->>'legalEntityId')::uuid
              AND other_assignment.revoked_at IS NULL)
       FOR UPDATE OF account;

    WHEN 'USER_ASSIGNMENTS' THEN
      PERFORM 1 FROM abos.user_role_assignments assignment
       WHERE assignment.user_account_id = (p_payload->>'userAccountId')::uuid
         AND assignment.legal_entity_id = (p_payload->>'legalEntityId')::uuid
         AND assignment.revoked_at IS NULL
       FOR UPDATE;

    WHEN 'ACCESS_ROLE' THEN
      PERFORM 1 FROM abos.access_roles role_row
       WHERE role_row.id = (p_payload->>'roleId')::uuid
         AND role_row.legal_entity_id = (p_payload->>'legalEntityId')::uuid
       FOR UPDATE;

    WHEN 'ACCESS_ROLES' THEN
      PERFORM 1 FROM abos.access_roles role_row
       WHERE role_row.legal_entity_id = (p_payload->>'legalEntityId')::uuid
         AND role_row.id IN (
           SELECT value::uuid FROM pg_catalog.jsonb_array_elements_text(p_payload->'roleIds') value)
       FOR SHARE;

    ELSE
      RAISE EXCEPTION 'unsupported identity lock operation: %', p_operation
        USING ERRCODE = 'invalid_parameter_value';
  END CASE;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END
$lock$;

ALTER FUNCTION abos.identity_issue_session_context(text, uuid, uuid, text) OWNER TO abos_v1_identity_owner;
ALTER FUNCTION abos.identity_actor_context(text, text, text) OWNER TO abos_v1_identity_owner;
ALTER FUNCTION abos.identity_runtime_lock(text, text, jsonb) OWNER TO abos_v1_identity_owner;
REVOKE ALL ON FUNCTION abos.identity_issue_session_context(text, uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION abos.identity_actor_context(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION abos.identity_runtime_lock(text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION abos.identity_issue_session_context(text, uuid, uuid, text),
  abos.identity_actor_context(text, text, text),
  abos.identity_runtime_lock(text, text, jsonb) TO abos_v1_identity_runtime;

CREATE FUNCTION abos.identity_runtime_command(
  p_signing_secret text,
  p_operation text,
  p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $command$
DECLARE
  affected integer := 0;
  session_row record;
BEGIN
  IF p_signing_secret IS NULL OR pg_catalog.length(p_signing_secret) < 32 OR NOT EXISTS (
    SELECT 1 FROM abos.identity_runtime_configuration configuration
     WHERE configuration.singleton
       AND configuration.signing_secret_sha256 = pg_catalog.encode(
         pg_catalog.sha256(pg_catalog.convert_to(p_signing_secret, 'UTF8')), 'hex')
  ) THEN
    RAISE EXCEPTION 'identity runtime proof is invalid or not configured'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'identity command payload must be an object'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  CASE p_operation
    WHEN 'RECORD_ATTEMPT' THEN
      INSERT INTO abos.login_attempts (id, login_key, client_key, user_account_id, succeeded)
      VALUES ((p_payload->>'id')::uuid, p_payload->>'loginKey', p_payload->>'clientKey',
              (p_payload->>'userAccountId')::uuid, (p_payload->>'succeeded')::boolean);

    WHEN 'ISSUE_SESSION' THEN
      INSERT INTO abos.sandbox_sessions
        (id, user_account_id, token_sha256, runtime_token_sha256,
         legal_entity_id, issued_at, expires_at)
      VALUES ((p_payload->>'id')::uuid, (p_payload->>'userAccountId')::uuid,
              p_payload->>'tokenSha256', p_payload->>'runtimeTokenSha256',
              (p_payload->>'legalEntityId')::uuid, (p_payload->>'issuedAt')::timestamptz,
              (p_payload->>'expiresAt')::timestamptz);

    WHEN 'CHANGE_PASSWORD' THEN
      UPDATE abos.user_credentials
         SET password_hash = p_payload->>'newPasswordHash', must_change_password = false,
             password_set_at = pg_catalog.clock_timestamp(),
             password_set_by_user_account_id = (p_payload->>'userAccountId')::uuid
       WHERE user_account_id = (p_payload->>'userAccountId')::uuid
         AND password_hash = p_payload->>'expectedPasswordHash';
      GET DIAGNOSTICS affected = ROW_COUNT;

    WHEN 'ROTATE_SESSION' THEN
      SELECT session.id, session.user_account_id, session.legal_entity_id
        INTO session_row
        FROM abos.sandbox_sessions session
        JOIN abos.user_accounts account ON account.id = session.user_account_id
        JOIN abos.user_credentials credential ON credential.user_account_id = account.id
       WHERE session.runtime_token_sha256 = p_payload->>'oldRuntimeTokenSha256'
         AND session.token_sha256 = p_payload->>'oldTokenSha256'
         AND session.revoked_at IS NULL AND session.expires_at > pg_catalog.clock_timestamp()
         AND account.status = 'ACTIVE' AND NOT credential.must_change_password
         AND EXISTS (SELECT 1 FROM abos.user_permission_grants grant_row
                      WHERE grant_row.user_account_id = session.user_account_id
                        AND grant_row.legal_entity_id = session.legal_entity_id
                        AND grant_row.revoked_at IS NULL)
         AND EXISTS (SELECT 1 FROM abos.sandbox_authorizations authz
                      WHERE authz.singleton
                        AND authz.environment IN ('development', 'test')
                        AND authz.configuration_state = 'SYNTHETIC_TEST_ONLY'
                        AND NOT authz.real_posting_enabled
                        AND authz.expires_at > pg_catalog.clock_timestamp()
                        AND authz.runtime_marker = pg_catalog.current_setting('abos.runtime_marker', true))
         AND EXISTS (SELECT 1 FROM abos.sandbox_legal_entity_scopes scope
                      WHERE scope.legal_entity_id = session.legal_entity_id)
       FOR UPDATE OF session FOR SHARE OF account, credential;
      IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object('affected', 0);
      END IF;
      PERFORM 1 FROM abos.user_permission_grants grant_row
       WHERE grant_row.user_account_id = session_row.user_account_id
         AND grant_row.legal_entity_id = session_row.legal_entity_id
         AND grant_row.revoked_at IS NULL
       FOR SHARE;
      IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object('affected', 0);
      END IF;
      INSERT INTO abos.sandbox_sessions
        (id, user_account_id, token_sha256, runtime_token_sha256,
         legal_entity_id, issued_at, expires_at)
      VALUES ((p_payload->>'id')::uuid, session_row.user_account_id,
              p_payload->>'tokenSha256', p_payload->>'runtimeTokenSha256',
              session_row.legal_entity_id, (p_payload->>'issuedAt')::timestamptz,
              (p_payload->>'expiresAt')::timestamptz);
      UPDATE abos.sandbox_sessions SET revoked_at = pg_catalog.clock_timestamp()
       WHERE id = session_row.id AND revoked_at IS NULL;
      GET DIAGNOSTICS affected = ROW_COUNT;
      IF affected <> 1 THEN
        RAISE EXCEPTION 'session was already rotated' USING ERRCODE = 'serialization_failure';
      END IF;
      RETURN pg_catalog.jsonb_build_object(
        'affected', affected, 'userAccountId', session_row.user_account_id,
        'legalEntityId', session_row.legal_entity_id);

    WHEN 'UPSERT_CREDENTIAL' THEN
      INSERT INTO abos.user_credentials
        (user_account_id, password_hash, must_change_password, password_set_by_user_account_id)
      VALUES ((p_payload->>'userAccountId')::uuid, p_payload->>'passwordHash',
              (p_payload->>'mustChangePassword')::boolean,
              (p_payload->>'setByUserAccountId')::uuid)
      ON CONFLICT (user_account_id) DO UPDATE
         SET password_hash = EXCLUDED.password_hash,
             must_change_password = EXCLUDED.must_change_password,
             password_set_at = pg_catalog.clock_timestamp(),
             password_set_by_user_account_id = EXCLUDED.password_set_by_user_account_id;

    WHEN 'REVOKE_SESSION_TOKEN' THEN
      UPDATE abos.sandbox_sessions SET revoked_at = pg_catalog.clock_timestamp()
       WHERE runtime_token_sha256 = p_payload->>'runtimeTokenSha256' AND revoked_at IS NULL;
      GET DIAGNOSTICS affected = ROW_COUNT;

    WHEN 'REVOKE_SESSION_ID' THEN
      UPDATE abos.sandbox_sessions SET revoked_at = pg_catalog.clock_timestamp()
       WHERE id = (p_payload->>'sessionId')::uuid AND revoked_at IS NULL;
      GET DIAGNOSTICS affected = ROW_COUNT;

    WHEN 'REVOKE_USER_SESSIONS' THEN
      UPDATE abos.sandbox_sessions SET revoked_at = pg_catalog.clock_timestamp()
       WHERE user_account_id = (p_payload->>'userAccountId')::uuid
         AND revoked_at IS NULL AND expires_at > pg_catalog.clock_timestamp();
      GET DIAGNOSTICS affected = ROW_COUNT;

    WHEN 'CREATE_USER' THEN
      INSERT INTO abos.user_accounts
        (id, login_identifier, display_name, status, job_title, contact_email, contact_phone,
         primary_legal_entity_id, created_by_user_account_id, disabled_at, updated_at)
      VALUES ((p_payload->>'id')::uuid, p_payload->>'loginIdentifier', p_payload->>'displayName',
              p_payload->>'status', p_payload->>'jobTitle', p_payload->>'contactEmail',
              p_payload->>'contactPhone', (p_payload->>'legalEntityId')::uuid,
              (p_payload->>'createdByUserAccountId')::uuid,
              CASE WHEN p_payload->>'status' = 'DISABLED' THEN pg_catalog.clock_timestamp() END,
              pg_catalog.clock_timestamp());

    WHEN 'UPDATE_USER_PROFILE' THEN
      UPDATE abos.user_accounts
         SET display_name = p_payload->>'displayName', job_title = p_payload->>'jobTitle',
             contact_email = p_payload->>'contactEmail', contact_phone = p_payload->>'contactPhone',
             updated_at = pg_catalog.clock_timestamp()
       WHERE id = (p_payload->>'userAccountId')::uuid;
      GET DIAGNOSTICS affected = ROW_COUNT;

    WHEN 'SET_USER_STATUS' THEN
      UPDATE abos.user_accounts
         SET status = p_payload->>'status',
             disabled_at = CASE WHEN p_payload->>'status' = 'DISABLED'
                                THEN pg_catalog.clock_timestamp() END,
             updated_at = pg_catalog.clock_timestamp()
       WHERE id = (p_payload->>'userAccountId')::uuid;
      GET DIAGNOSTICS affected = ROW_COUNT;

    WHEN 'ASSIGN_ROLE' THEN
      INSERT INTO abos.user_role_assignments
        (id, user_account_id, role_id, legal_entity_id, assigned_by_user_account_id)
      VALUES ((p_payload->>'id')::uuid, (p_payload->>'userAccountId')::uuid,
              (p_payload->>'roleId')::uuid, (p_payload->>'legalEntityId')::uuid,
              (p_payload->>'assignedByUserAccountId')::uuid);

    WHEN 'REVOKE_ROLE' THEN
      UPDATE abos.user_role_assignments
         SET revoked_at = pg_catalog.clock_timestamp(),
             revoked_by_user_account_id = (p_payload->>'revokedByUserAccountId')::uuid
       WHERE id = (p_payload->>'assignmentId')::uuid AND revoked_at IS NULL;
      GET DIAGNOSTICS affected = ROW_COUNT;

    WHEN 'CREATE_ROLE' THEN
      INSERT INTO abos.access_roles
        (id, legal_entity_id, role_name, description, created_by_user_account_id)
      VALUES ((p_payload->>'id')::uuid, (p_payload->>'legalEntityId')::uuid,
              p_payload->>'name', p_payload->>'description',
              (p_payload->>'createdByUserAccountId')::uuid);

    WHEN 'UPDATE_ROLE' THEN
      UPDATE abos.access_roles
         SET role_name = p_payload->>'name', description = p_payload->>'description',
             status = p_payload->>'status', version = version + 1,
             updated_by_user_account_id = (p_payload->>'updatedByUserAccountId')::uuid,
             updated_at = pg_catalog.clock_timestamp()
       WHERE id = (p_payload->>'roleId')::uuid;
      GET DIAGNOSTICS affected = ROW_COUNT;

    WHEN 'ADD_ROLE_PERMISSION' THEN
      INSERT INTO abos.access_role_permissions (role_id, permission_code, added_by_user_account_id)
      VALUES ((p_payload->>'roleId')::uuid, p_payload->>'permissionCode',
              (p_payload->>'addedByUserAccountId')::uuid);

    WHEN 'REMOVE_ROLE_PERMISSION' THEN
      DELETE FROM abos.access_role_permissions
       WHERE role_id = (p_payload->>'roleId')::uuid
         AND permission_code = p_payload->>'permissionCode';
      GET DIAGNOSTICS affected = ROW_COUNT;

    WHEN 'SYNC_GRANTS' THEN
      UPDATE abos.user_permission_grants grant_row
         SET revoked_at = pg_catalog.clock_timestamp()
       WHERE grant_row.user_account_id = (p_payload->>'userAccountId')::uuid
         AND grant_row.legal_entity_id = (p_payload->>'legalEntityId')::uuid
         AND grant_row.revoked_at IS NULL
         AND grant_row.permission_code NOT IN (
           SELECT derived.permission_code FROM abos.role_derived_permissions(
             (p_payload->>'userAccountId')::uuid, (p_payload->>'legalEntityId')::uuid) derived);
      INSERT INTO abos.user_permission_grants
        (user_account_id, legal_entity_id, permission_code, granted_by_user_account_id)
      SELECT (p_payload->>'userAccountId')::uuid, (p_payload->>'legalEntityId')::uuid,
             derived.permission_code, (p_payload->>'actorUserAccountId')::uuid
        FROM abos.role_derived_permissions((p_payload->>'userAccountId')::uuid,
                                           (p_payload->>'legalEntityId')::uuid) derived
      ON CONFLICT (user_account_id, legal_entity_id, permission_code) DO UPDATE
         SET revoked_at = NULL, granted_by_user_account_id = EXCLUDED.granted_by_user_account_id,
             granted_at = pg_catalog.clock_timestamp()
       WHERE abos.user_permission_grants.revoked_at IS NOT NULL;

    WHEN 'WRITE_AUDIT' THEN
      IF p_payload->>'entityType' NOT IN ('USER_ACCOUNT', 'ACCESS_ROLE', 'COMPANY_PROFILE') THEN
        RAISE EXCEPTION 'unsupported identity audit entity type'
          USING ERRCODE = 'insufficient_privilege';
      END IF;
      INSERT INTO abos.audit_records
        (id, actor_user_account_id, legal_entity_id, correlation_id, action, entity_type,
         entity_id, before_state, after_state, metadata)
      VALUES ((p_payload->>'id')::uuid, (p_payload->>'actorUserAccountId')::uuid,
              (p_payload->>'legalEntityId')::uuid, (p_payload->>'correlationId')::uuid,
              p_payload->>'action', p_payload->>'entityType', (p_payload->>'entityId')::uuid,
              p_payload->'before', p_payload->'after', p_payload->'metadata');

    WHEN 'UPSERT_COMPANY_PROFILE' THEN
      INSERT INTO abos.legal_entity_profiles
        (legal_entity_id, legal_name, registration_number, go_live_date, updated_by_user_account_id)
      VALUES ((p_payload->>'legalEntityId')::uuid, p_payload->>'legalName',
              p_payload->>'registrationNumber', (p_payload->>'goLiveDate')::date,
              (p_payload->>'updatedByUserAccountId')::uuid)
      ON CONFLICT (legal_entity_id) DO UPDATE
         SET legal_name = EXCLUDED.legal_name, registration_number = EXCLUDED.registration_number,
             go_live_date = EXCLUDED.go_live_date, version = abos.legal_entity_profiles.version + 1,
             updated_by_user_account_id = EXCLUDED.updated_by_user_account_id,
             updated_at = pg_catalog.clock_timestamp();

    ELSE
      RAISE EXCEPTION 'unsupported identity runtime operation %', p_operation
        USING ERRCODE = 'insufficient_privilege';
  END CASE;

  RETURN pg_catalog.jsonb_build_object('affected', affected);
END
$command$;

ALTER FUNCTION abos.identity_runtime_command(text, text, jsonb) OWNER TO abos_v1_identity_owner;
REVOKE ALL ON FUNCTION abos.identity_runtime_command(text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION abos.identity_runtime_command(text, text, jsonb)
  TO abos_v1_identity_runtime;

REVOKE ALL ON FUNCTION abos.sync_role_grants(uuid, uuid, uuid) FROM abos_v1_identity_runtime;
REVOKE INSERT, UPDATE, DELETE ON
  abos.user_accounts, abos.user_credentials, abos.login_attempts, abos.access_roles,
  abos.access_role_permissions, abos.user_role_assignments, abos.user_permission_grants,
  abos.sandbox_sessions, abos.audit_records, abos.legal_entity_profiles
FROM abos_v1_identity_runtime;
