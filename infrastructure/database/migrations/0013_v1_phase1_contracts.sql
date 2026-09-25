-- V1 Phase 1 shared contracts (lead-owned), applied before the parallel work packages.
--
-- 1. The Treasury and Finance authorizers accept any ACTIVE permission of their category in the
--    controlled permission catalogue, instead of a hard-coded list. Each work package then adds its
--    permission as a catalogue row in its own migration, and no two packages re-create the same
--    privileged function. Behaviour for every existing permission is unchanged: each was already in
--    the catalogue as ACTIVE with the matching category, and finance.journal.reverse (UNAVAILABLE)
--    stays refused. Owners and ACLs are kept by CREATE OR REPLACE; the search path stays pinned.
-- 2. Ledger control-account type SARAF, used by Saraf accounts (work package #11).

CREATE OR REPLACE FUNCTION abos.treasury_runtime_authorize(p_bearer_token text, p_legal_entity_id uuid, p_permission text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $authorize_treasury$
DECLARE
  session_row record;
  gate_row record;
BEGIN
  IF p_bearer_token IS NULL OR length(p_bearer_token) < 32 THEN
    RAISE EXCEPTION 'valid sandbox bearer credential required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Any ACTIVE Treasury permission in the controlled catalogue (0010). Adding a Treasury
  -- permission is a catalogue row, not a change to this privileged function.
  IF NOT EXISTS (SELECT 1 FROM abos.permission_catalogue catalogue
                  WHERE catalogue.permission_code = p_permission
                    AND catalogue.category = 'TREASURY' AND catalogue.availability = 'ACTIVE') THEN
    RAISE EXCEPTION 'unsupported Treasury permission' USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT s.id, s.user_account_id, s.legal_entity_id, s.expires_at, s.revoked_at,
         u.status AS user_status
    INTO session_row
    FROM abos.sandbox_sessions s
    JOIN abos.user_accounts u ON u.id = s.user_account_id
   WHERE s.runtime_token_sha256 =
         pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_bearer_token, 'UTF8')), 'hex')
   FOR SHARE OF s, u;
  IF NOT FOUND OR session_row.revoked_at IS NOT NULL
     OR session_row.expires_at <= pg_catalog.clock_timestamp()
     OR session_row.user_status <> 'ACTIVE'
     OR session_row.legal_entity_id <> p_legal_entity_id THEN
    RAISE EXCEPTION 'sandbox session is invalid, expired, revoked or out of scope'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT environment, configuration_state, real_posting_enabled, runtime_marker, expires_at
    INTO gate_row FROM abos.sandbox_authorizations WHERE singleton FOR SHARE;
  IF NOT FOUND OR gate_row.environment NOT IN ('development', 'test')
     OR gate_row.configuration_state <> 'SYNTHETIC_TEST_ONLY'
     OR gate_row.real_posting_enabled OR gate_row.expires_at <= pg_catalog.clock_timestamp()
     OR NOT EXISTS (SELECT 1 FROM abos.sandbox_legal_entity_scopes s
                     WHERE s.legal_entity_id = p_legal_entity_id FOR SHARE) THEN
    RAISE EXCEPTION 'synthetic Treasury sandbox authorization is not active'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM abos.user_permission_grants g
     WHERE g.user_account_id = session_row.user_account_id
       AND g.legal_entity_id = p_legal_entity_id
       AND g.permission_code = p_permission AND g.revoked_at IS NULL
     FOR SHARE
  ) THEN
    RAISE EXCEPTION 'current Treasury authority is missing' USING ERRCODE = 'insufficient_privilege';
  END IF;

  PERFORM pg_catalog.set_config('abos.actor_user_account_id', session_row.user_account_id::text, true);
  PERFORM pg_catalog.set_config('abos.runtime_marker', gate_row.runtime_marker, true);
  RETURN session_row.user_account_id;
END
$authorize_treasury$;

CREATE OR REPLACE FUNCTION abos.finance_runtime_authorize(p_bearer_token text, p_permission text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $authorize_finance$
DECLARE
  session_row record;
  gate_row record;
BEGIN
  IF p_bearer_token IS NULL OR pg_catalog.length(p_bearer_token) < 32 THEN
    RAISE EXCEPTION 'valid sandbox bearer credential required'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Any ACTIVE Finance permission in the controlled catalogue (0010).
  IF NOT EXISTS (SELECT 1 FROM abos.permission_catalogue catalogue
                  WHERE catalogue.permission_code = p_permission
                    AND catalogue.category = 'FINANCE' AND catalogue.availability = 'ACTIVE') THEN
    RAISE EXCEPTION 'unsupported Finance permission'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT s.id, s.user_account_id, s.legal_entity_id, s.expires_at, s.revoked_at,
         u.status AS user_status
    INTO session_row
    FROM abos.sandbox_sessions s
    JOIN abos.user_accounts u ON u.id = s.user_account_id
   WHERE s.runtime_token_sha256 =
         pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_bearer_token, 'UTF8')), 'hex')
   FOR SHARE OF s, u;
  IF NOT FOUND OR session_row.revoked_at IS NOT NULL
     OR session_row.expires_at <= pg_catalog.clock_timestamp()
     OR session_row.user_status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'sandbox session is invalid, expired or revoked'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT environment, configuration_state, real_posting_enabled, runtime_marker, expires_at
    INTO gate_row
    FROM abos.sandbox_authorizations
   WHERE singleton
   FOR SHARE;
  IF NOT FOUND OR gate_row.environment NOT IN ('development', 'test')
     OR gate_row.configuration_state <> 'SYNTHETIC_TEST_ONLY'
     OR gate_row.real_posting_enabled OR gate_row.expires_at <= pg_catalog.clock_timestamp()
     OR NOT EXISTS (
       SELECT 1 FROM abos.sandbox_legal_entity_scopes scope
        WHERE scope.legal_entity_id = session_row.legal_entity_id
        FOR SHARE
     ) THEN
    RAISE EXCEPTION 'synthetic Finance sandbox authorization is not active'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM abos.user_permission_grants grant_row
     WHERE grant_row.user_account_id = session_row.user_account_id
       AND grant_row.legal_entity_id = session_row.legal_entity_id
       AND grant_row.permission_code = p_permission
       AND grant_row.revoked_at IS NULL
     FOR SHARE
  ) THEN
    RAISE EXCEPTION 'current Finance authority is missing %', p_permission
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  PERFORM pg_catalog.set_config('abos.actor_user_account_id', session_row.user_account_id::text, true);
  PERFORM pg_catalog.set_config('abos.finance_legal_entity_id', session_row.legal_entity_id::text, true);
  PERFORM pg_catalog.set_config('abos.runtime_marker', gate_row.runtime_marker, true);
  RETURN session_row.user_account_id;
END
$authorize_finance$;

-- The authorizers now read the catalogue.
GRANT SELECT ON abos.permission_catalogue TO abos_e1_treasury_owner, abos_e1_finance_owner;

ALTER TABLE abos.ledger_accounts DROP CONSTRAINT ledger_accounts_control_account_type_check;
ALTER TABLE abos.ledger_accounts ADD CONSTRAINT ledger_accounts_control_account_type_check
  CHECK (control_account_type IS NULL OR control_account_type IN
    ('CASH', 'SHAREHOLDER_CAPITAL', 'SHAREHOLDER_LOAN', 'AR', 'AP', 'SARAF', 'OTHER'));
