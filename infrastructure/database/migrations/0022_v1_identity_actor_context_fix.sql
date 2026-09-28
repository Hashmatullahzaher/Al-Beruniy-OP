-- V1 identity actor context: restore credential-less session resolution.
--
-- 0021 inner-joined abos.user_credentials, so a session held by an account without a password
-- (operator-seeded sandbox personas) stopped resolving, which the earlier service did not do.
-- Such an account has no password to change, so it is treated as not needing a change. Session
-- rotation (ROTATE_SESSION) still requires a credential row and is unchanged.
CREATE OR REPLACE FUNCTION abos.identity_actor_context(
  p_signing_secret text, p_runtime_token_sha256 text, p_token_sha256 text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $context$
DECLARE
  session_row record;
  must_change boolean;
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
         account.status, account.login_identifier
    INTO session_row
    FROM abos.sandbox_sessions session
    JOIN abos.user_accounts account ON account.id = session.user_account_id
   WHERE session.runtime_token_sha256 = p_runtime_token_sha256
     AND session.token_sha256 = p_token_sha256
   FOR SHARE OF session, account;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT credential.must_change_password INTO must_change
    FROM abos.user_credentials credential
   WHERE credential.user_account_id = session_row.user_account_id
   FOR SHARE;
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
    'mustChangePassword', COALESCE(must_change, false),
    'permissions', pg_catalog.to_jsonb(permissions));
END
$context$;

ALTER FUNCTION abos.identity_actor_context(text, text, text) OWNER TO abos_v1_identity_owner;
REVOKE ALL ON FUNCTION abos.identity_actor_context(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION abos.identity_actor_context(text, text, text) TO abos_v1_identity_runtime;
