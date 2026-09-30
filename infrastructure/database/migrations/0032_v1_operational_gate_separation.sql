-- V1 Operational Gate Separation. No business data, posting authority or expense-lane changes.
-- Safe configuration/read permissions are a closed allowlist; all other permissions retain E1.
-- Reviewed bearer resolver belongs to the existing identity owner, never a Finance owner.
--
-- Session provenance is database-controlled. Existing sessions cannot be classified safely, so the
-- upgrade marks them synthetic and revokes them. A fresh password login is required after 0032.
ALTER TABLE abos.sandbox_sessions
  ADD COLUMN session_provenance text NOT NULL DEFAULT 'SYNTHETIC_DEVELOPER'
  CHECK (session_provenance IN ('PASSWORD_OPERATIONAL', 'SYNTHETIC_DEVELOPER'));

UPDATE abos.sandbox_sessions
   SET revoked_at = COALESCE(revoked_at, pg_catalog.clock_timestamp());

CREATE FUNCTION abos.prevent_session_provenance_change()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $guard$
BEGIN
  IF NEW.session_provenance IS DISTINCT FROM OLD.session_provenance THEN
    RAISE EXCEPTION 'session provenance is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER sandbox_sessions_provenance_immutable
BEFORE UPDATE OF session_provenance ON abos.sandbox_sessions
FOR EACH ROW EXECUTE FUNCTION abos.prevent_session_provenance_change();

CREATE FUNCTION abos.operational_bearer_context(p_bearer_token text, p_permission text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $context$
DECLARE v_session record; v_permissions jsonb; v_must_change boolean;
BEGIN
  IF p_bearer_token IS NULL OR pg_catalog.length(p_bearer_token) < 32 THEN
    RAISE EXCEPTION 'valid bearer credential required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT s.id, s.user_account_id, s.legal_entity_id, s.expires_at, s.revoked_at,
         s.session_provenance,
         u.status, u.display_name INTO v_session
    FROM abos.sandbox_sessions s JOIN abos.user_accounts u ON u.id = s.user_account_id
   WHERE s.runtime_token_sha256 = pg_catalog.encode(
     pg_catalog.sha256(pg_catalog.convert_to(p_bearer_token, 'UTF8')), 'hex')
   FOR SHARE OF s, u;
  IF NOT FOUND OR v_session.revoked_at IS NOT NULL
     OR v_session.expires_at <= pg_catalog.clock_timestamp() OR v_session.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'session is invalid, expired or revoked' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_session.session_provenance <> 'PASSWORD_OPERATIONAL' THEN
    RAISE EXCEPTION 'an operational password session is required'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT c.must_change_password INTO v_must_change FROM abos.user_credentials c
   WHERE c.user_account_id = v_session.user_account_id FOR SHARE;
  IF COALESCE(v_must_change, false) THEN
    RAISE EXCEPTION 'change the temporary password to continue' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM 1 FROM abos.user_permission_grants g
   WHERE g.user_account_id = v_session.user_account_id AND g.legal_entity_id = v_session.legal_entity_id
     AND g.revoked_at IS NULL FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'session legal-entity grant is no longer active'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT COALESCE(pg_catalog.jsonb_agg(g.permission_code ORDER BY g.permission_code), '[]'::jsonb)
    INTO v_permissions FROM abos.user_permission_grants g
   WHERE g.user_account_id = v_session.user_account_id AND g.legal_entity_id = v_session.legal_entity_id
     AND g.revoked_at IS NULL;
  IF p_permission IS NOT NULL AND NOT v_permissions ? p_permission THEN
    RAISE EXCEPTION 'current authority is missing %', p_permission USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN pg_catalog.jsonb_build_object('sessionId', v_session.id,
    'userAccountId', v_session.user_account_id, 'legalEntityId', v_session.legal_entity_id,
    'expiresAt', v_session.expires_at, 'displayName', v_session.display_name,
    'sessionProvenance', v_session.session_provenance, 'permissions', v_permissions);
END
$context$;
ALTER FUNCTION abos.operational_bearer_context(text, text) OWNER TO abos_v1_identity_owner;
REVOKE ALL ON FUNCTION abos.operational_bearer_context(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION abos.operational_bearer_context(text, text)
  TO abos_e1_finance_owner, abos_e1_treasury_owner;

CREATE OR REPLACE FUNCTION abos.finance_runtime_authorize(p_bearer_token text, p_permission text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $authorize_finance$
DECLARE
  session_row record;
  gate_row record;
  operational_context jsonb;
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

  -- Closed allowlist: adding a catalogue permission never opens a new operational lane.
  IF p_permission IN ('finance.calendar.manage', 'finance.ledger-account.manage', 'finance.ledger-account.review', 'finance.exchange-rate.record', 'finance.report.operational.read') THEN
    operational_context := abos.operational_bearer_context(p_bearer_token, p_permission);
    PERFORM pg_catalog.set_config('abos.actor_user_account_id', operational_context ->> 'userAccountId', true);
    PERFORM pg_catalog.set_config('abos.finance_legal_entity_id', operational_context ->> 'legalEntityId', true);
    PERFORM pg_catalog.set_config('abos.runtime_marker', '', true);
    RETURN (operational_context ->> 'userAccountId')::uuid;
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

CREATE OR REPLACE FUNCTION abos.treasury_runtime_authorize(p_bearer_token text, p_legal_entity_id uuid, p_permission text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $authorize_treasury$
DECLARE
  session_row record;
  gate_row record;
  operational_context jsonb;
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

  -- Closed allowlist: adding a catalogue permission never opens a new operational lane.
  IF p_permission IN ('treasury.cash-location.manage', 'treasury.saraf-account.manage') THEN
    operational_context := abos.operational_bearer_context(p_bearer_token, p_permission);
    IF (operational_context ->> 'legalEntityId')::uuid IS DISTINCT FROM p_legal_entity_id THEN
      RAISE EXCEPTION 'session is out of scope' USING ERRCODE = 'insufficient_privilege';
    END IF;
    PERFORM pg_catalog.set_config('abos.actor_user_account_id', operational_context ->> 'userAccountId', true);
    PERFORM pg_catalog.set_config('abos.operational_treasury_configuration', 'V1_REVIEWED', true);
    PERFORM pg_catalog.set_config('abos.runtime_marker', '', true);
    RETURN (operational_context ->> 'userAccountId')::uuid;
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

CREATE OR REPLACE FUNCTION abos.finance_synthetic_read_authorize(p_bearer_token text, p_permission text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY INVOKER
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

CREATE OR REPLACE FUNCTION abos.treasury_synthetic_authorize(p_bearer_token text, p_legal_entity_id uuid, p_permission text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY INVOKER
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

ALTER FUNCTION abos.finance_synthetic_read_authorize(text, text) OWNER TO abos_e1_finance_owner;
ALTER FUNCTION abos.treasury_synthetic_authorize(text, uuid, text) OWNER TO abos_e1_treasury_owner;
REVOKE ALL ON FUNCTION abos.finance_synthetic_read_authorize(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION abos.treasury_synthetic_authorize(text, uuid, text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION abos.treasury_secure_context(p_bearer_token text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $context$
DECLARE v_context jsonb; v_permissions jsonb;
BEGIN
  BEGIN
    v_context := abos.operational_bearer_context(p_bearer_token, NULL);
  EXCEPTION
    WHEN insufficient_privilege THEN
      -- A developer-token session may still load the legacy E1 Treasury shell while the
      -- synthetic gate is active. Every operational query/command performs its own password
      -- provenance check, so this fallback cannot confer an operational capability.
      RETURN abos.treasury_synthetic_signin_context(p_bearer_token);
  END;
  SELECT COALESCE(pg_catalog.jsonb_agg(p.value ORDER BY p.value), '[]'::jsonb) INTO v_permissions
    FROM pg_catalog.jsonb_array_elements_text(v_context -> 'permissions') p(value)
   WHERE p.value LIKE 'treasury.%';
  RETURN (v_context - 'permissions') || pg_catalog.jsonb_build_object(
    'treasuryPermissions', v_permissions,
    'syntheticAuthorized', EXISTS (SELECT 1 FROM abos.sandbox_authorizations a
      WHERE a.singleton AND a.environment IN ('development', 'test')
        AND a.configuration_state = 'SYNTHETIC_TEST_ONLY' AND NOT a.real_posting_enabled
        AND a.expires_at > pg_catalog.clock_timestamp()
        AND EXISTS (SELECT 1 FROM abos.sandbox_legal_entity_scopes s
          WHERE s.legal_entity_id = (v_context ->> 'legalEntityId')::uuid)));
END
$context$;

CREATE OR REPLACE FUNCTION abos.finance_handoff_workspace(
  p_bearer_token text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $workspace$
DECLARE
  actor uuid;
  entity_id uuid;
  permissions jsonb;
  handoffs jsonb;
  periods jsonb;
BEGIN
  actor := abos.finance_synthetic_read_authorize(p_bearer_token, 'finance.report.operational.read');
  entity_id := pg_catalog.current_setting('abos.finance_legal_entity_id')::uuid;

  SELECT coalesce(pg_catalog.jsonb_agg(g.permission_code ORDER BY g.permission_code), '[]'::jsonb)
    INTO permissions
    FROM abos.user_permission_grants g
   WHERE g.user_account_id = actor AND g.legal_entity_id = entity_id
     AND g.permission_code LIKE 'finance.%' AND g.revoked_at IS NULL;

  SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(row_data)
           ORDER BY row_data.handed_off_at DESC), '[]'::jsonb)
    INTO handoffs
    FROM (
      SELECT h.id, h.status, h.handed_off_at, h.cash_receipt_id,
             h.capital_receipt_intent_id, source_row.amount::text AS amount,
             source_row.currency_code, source_row.status AS source_status,
             agreement.agreement_reference, installment.sequence_number,
             receipt.receipt_reference, receipt.verified_by_user_account_id,
             location.location_name, account.id AS cash_account_id,
             account.activation_status AS cash_account_status,
             posting.id AS posting_intent_id, posting.status AS posting_status,
             journal.id AS journal_id, journal.status AS journal_status
        FROM abos.treasury_finance_handoffs h
        JOIN abos.capital_receipt_intents source_row
          ON source_row.id = h.capital_receipt_intent_id
         AND source_row.legal_entity_id = h.legal_entity_id
        JOIN abos.capital_agreements agreement
          ON agreement.id = source_row.capital_agreement_id
         AND agreement.legal_entity_id = h.legal_entity_id
        JOIN abos.capital_installments installment
          ON installment.id = source_row.capital_installment_id
         AND installment.legal_entity_id = h.legal_entity_id
        JOIN abos.cash_receipts receipt
          ON receipt.id = h.cash_receipt_id AND receipt.legal_entity_id = h.legal_entity_id
        JOIN abos.cash_location_currency_accounts account
          ON account.id = receipt.cash_location_currency_account_id
         AND account.legal_entity_id = h.legal_entity_id
        JOIN abos.cash_locations location
          ON location.id = account.cash_location_id AND location.legal_entity_id = h.legal_entity_id
        LEFT JOIN abos.posting_intents posting
          ON posting.capital_receipt_intent_id = h.capital_receipt_intent_id
         AND posting.legal_entity_id = h.legal_entity_id
        LEFT JOIN abos.journals journal
          ON journal.posting_intent_id = posting.id AND journal.legal_entity_id = h.legal_entity_id
       WHERE h.legal_entity_id = entity_id
    ) row_data;

  SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(row_data)
           ORDER BY row_data.starts_on), '[]'::jsonb)
    INTO periods
    FROM (
      SELECT id, period_name, starts_on, ends_on
        FROM abos.accounting_periods
       WHERE legal_entity_id = entity_id AND status = 'OPEN'
    ) row_data;

  RETURN pg_catalog.jsonb_build_object(
    'actor', pg_catalog.jsonb_build_object(
      'userAccountId', actor, 'legalEntityId', entity_id, 'permissions', permissions),
    'handoffs', handoffs,
    'openPeriods', periods,
    'syntheticOnly', true
  );
END
$workspace$;

CREATE OR REPLACE FUNCTION abos.finance_handoff_trace(
  p_bearer_token text,
  p_handoff_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $trace$
DECLARE
  entity_id uuid;
  result jsonb;
BEGIN
  PERFORM abos.finance_synthetic_read_authorize(p_bearer_token, 'finance.report.operational.read');
  entity_id := pg_catalog.current_setting('abos.finance_legal_entity_id')::uuid;

  SELECT pg_catalog.jsonb_build_object(
      'handoff', pg_catalog.to_jsonb(h) || pg_catalog.jsonb_build_object(
        'handed_off_by_display_name', handoff_actor.display_name),
      'source', pg_catalog.jsonb_set(pg_catalog.to_jsonb(source_row), '{amount}',
        pg_catalog.to_jsonb(source_row.amount::text)),
      'shareholder', pg_catalog.jsonb_build_object(
        'businessPartyId', party.id, 'displayName', party.display_name),
      'agreement', pg_catalog.jsonb_build_object(
        'id', agreement.id, 'reference', agreement.agreement_reference,
        'kind', agreement.agreement_kind, 'status', agreement.status),
      'installment', pg_catalog.jsonb_build_object(
        'id', installment.id, 'sequenceNumber', installment.sequence_number,
        'expectedAmount', installment.expected_amount::text,
        'currency', installment.currency_code, 'dueOn', installment.due_on),
      'receipt', pg_catalog.jsonb_set(pg_catalog.to_jsonb(receipt), '{amount}',
        pg_catalog.to_jsonb(receipt.amount::text)) || pg_catalog.jsonb_build_object(
        'verifier_display_name', verifier.display_name),
      'safe', pg_catalog.jsonb_build_object(
        'locationId', location.id, 'name', location.location_name,
        'accountId', account.id, 'currency', account.currency_code,
        'activationStatus', account.activation_status),
      'physicalCount', pg_catalog.jsonb_set(pg_catalog.to_jsonb(count_row), '{counted_amount}',
        pg_catalog.to_jsonb(count_row.counted_amount::text)) || pg_catalog.jsonb_build_object(
        'counted_by_display_name', counter.display_name,
        'confirmed_by_display_name', confirmer.display_name),
      'evidence', pg_catalog.jsonb_build_object(
        'agreement', agreement_evidence.evidence_reference_id,
        'count', count_row.evidence_reference_id,
        'receipt', receipt.evidence_reference_id,
        'approval', approval.evidence_reference_id),
      'postingIntent', CASE WHEN posting.id IS NULL THEN NULL ELSE
        pg_catalog.jsonb_set(
          pg_catalog.jsonb_set(pg_catalog.to_jsonb(posting), '{original_amount}',
            pg_catalog.to_jsonb(posting.original_amount::text)), '{base_amount}',
          coalesce(pg_catalog.to_jsonb(posting.base_amount::text), 'null'::jsonb)) || pg_catalog.jsonb_build_object(
          'created_by_display_name', preparer.display_name) END,
      'approval', CASE WHEN approval.id IS NULL THEN NULL ELSE
        pg_catalog.to_jsonb(approval) || pg_catalog.jsonb_build_object(
          'approver_display_name', approver.display_name) END,
      'journal', pg_catalog.to_jsonb(journal),
      'reconciliation', pg_catalog.jsonb_build_object(
        'debits', coalesce(totals.debits, 0)::text,
        'credits', coalesce(totals.credits, 0)::text,
        'balanced', coalesce(totals.debits, 0) = coalesce(totals.credits, 0),
        'subledgerEntries', coalesce(totals.subledgers, 0))
    )
    INTO result
    FROM abos.treasury_finance_handoffs h
    JOIN abos.capital_receipt_intents source_row
      ON source_row.id = h.capital_receipt_intent_id AND source_row.legal_entity_id = h.legal_entity_id
    JOIN abos.business_parties party
      ON party.id = source_row.shareholder_business_party_id AND party.legal_entity_id = h.legal_entity_id
    JOIN abos.capital_agreements agreement
      ON agreement.id = source_row.capital_agreement_id AND agreement.legal_entity_id = h.legal_entity_id
    JOIN abos.capital_installments installment
      ON installment.id = source_row.capital_installment_id AND installment.legal_entity_id = h.legal_entity_id
    JOIN abos.cash_receipts receipt
      ON receipt.id = h.cash_receipt_id AND receipt.legal_entity_id = h.legal_entity_id
    JOIN abos.cash_location_currency_accounts account
      ON account.id = receipt.cash_location_currency_account_id AND account.legal_entity_id = h.legal_entity_id
    JOIN abos.cash_locations location
      ON location.id = account.cash_location_id AND location.legal_entity_id = h.legal_entity_id
    JOIN abos.physical_cash_counts count_row
      ON count_row.id = receipt.physical_cash_count_id AND count_row.legal_entity_id = h.legal_entity_id
    LEFT JOIN abos.registration_evidence agreement_evidence
      ON agreement_evidence.capital_agreement_id = agreement.id
     AND agreement_evidence.legal_entity_id = h.legal_entity_id
     AND agreement_evidence.status = 'VERIFIED'
    LEFT JOIN abos.posting_intents posting
      ON posting.capital_receipt_intent_id = source_row.id AND posting.legal_entity_id = h.legal_entity_id
    LEFT JOIN abos.posting_approvals approval
      ON approval.posting_intent_id = posting.id AND approval.legal_entity_id = h.legal_entity_id
    LEFT JOIN abos.journals journal
      ON journal.posting_intent_id = posting.id AND journal.legal_entity_id = h.legal_entity_id
    LEFT JOIN abos.user_accounts handoff_actor ON handoff_actor.id = h.handed_off_by_user_account_id
    LEFT JOIN abos.user_accounts verifier ON verifier.id = receipt.verified_by_user_account_id
    LEFT JOIN abos.user_accounts counter ON counter.id = count_row.counted_by_user_account_id
    LEFT JOIN abos.user_accounts confirmer ON confirmer.id = count_row.confirmed_by_user_account_id
    LEFT JOIN abos.user_accounts preparer ON preparer.id = posting.created_by_user_account_id
    LEFT JOIN abos.user_accounts approver ON approver.id = approval.approver_user_account_id
    LEFT JOIN LATERAL (
      SELECT pg_catalog.sum(lines.base_debit) AS debits,
             pg_catalog.sum(lines.base_credit) AS credits,
             (SELECT pg_catalog.count(*) FROM abos.subledger_entries subledger
               WHERE subledger.legal_entity_id = h.legal_entity_id
                 AND subledger.journal_line_id IN (
                   SELECT line_id.id FROM abos.journal_lines line_id
                    WHERE line_id.journal_id = journal.id
                      AND line_id.legal_entity_id = h.legal_entity_id)) AS subledgers
        FROM abos.journal_lines lines
       WHERE lines.journal_id = journal.id AND lines.legal_entity_id = h.legal_entity_id
    ) totals ON true
   WHERE h.id = p_handoff_id AND h.legal_entity_id = entity_id;

  IF result IS NULL THEN
    RAISE EXCEPTION 'Finance handoff is not available in the current legal entity'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN result;
END
$trace$;

CREATE OR REPLACE FUNCTION abos.treasury_secure_command(
  p_bearer_token text,
  p_legal_entity_id uuid,
  p_operation text,
  p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $command$
DECLARE
  actor uuid;
  required_permission text;
  source_row record;
  receipt_row record;
  count_row record;
  existing_handoff record;
  object_id uuid;
  count_id uuid;
BEGIN
  required_permission := CASE p_operation
    WHEN 'CREATE_LOCATION' THEN 'treasury.cash-location.manage'
    WHEN 'SET_LOCATION_STATUS' THEN 'treasury.cash-location.manage'
    WHEN 'OPEN_ACCOUNT' THEN 'treasury.cash-location.manage'
    WHEN 'ASSIGN_CASHIER' THEN 'treasury.cash-location.manage'
    WHEN 'REVOKE_CASHIER' THEN 'treasury.cash-location.manage'
    WHEN 'RECORD_COUNT' THEN 'treasury.cash-count.record'
    WHEN 'CONFIRM_OPENING_COUNT' THEN 'treasury.cash-account.approve'
    WHEN 'RECONCILE_OPENING' THEN 'treasury.cash-account.reconcile'
    WHEN 'APPROVE_OPENING' THEN 'treasury.cash-account.approve'
    WHEN 'ACTIVATE_ACCOUNT' THEN 'treasury.cash-account.approve'
    WHEN 'BLOCK_ACCOUNT' THEN 'treasury.cash-account.approve'
    WHEN 'RECORD_RECEIPT' THEN 'treasury.cash-receipt.record'
    WHEN 'COUNT_RECEIPT' THEN 'treasury.cash-count.record'
    WHEN 'SUBMIT_RECEIPT' THEN 'treasury.cash-receipt.record'
    WHEN 'VERIFY_RECEIPT' THEN 'treasury.cash-receipt.verify'
    WHEN 'VOID_RECEIPT' THEN 'treasury.read'
    WHEN 'HANDOFF_RECEIPT' THEN 'treasury.handoff.create'
    ELSE NULL END;
  IF required_permission IS NULL THEN
    RAISE EXCEPTION 'unsupported Treasury operation';
  END IF;
  IF p_operation IN (
    'CREATE_LOCATION', 'SET_LOCATION_STATUS', 'OPEN_ACCOUNT', 'ASSIGN_CASHIER',
    'REVOKE_CASHIER'
  ) THEN
    actor := abos.treasury_runtime_authorize(p_bearer_token, p_legal_entity_id, required_permission);
  ELSE
    -- VOID_RECEIPT uses treasury.read but changes a synthetic receipt. Gate by operation as well.
    actor := abos.treasury_synthetic_authorize(p_bearer_token, p_legal_entity_id, required_permission);
  END IF;

  object_id := nullif(p_payload ->> 'id', '')::uuid;
  CASE p_operation
    WHEN 'CREATE_LOCATION' THEN
      INSERT INTO abos.cash_locations
        (id, legal_entity_id, location_name, responsible_cashier_user_account_id, status, location_kind)
      VALUES (object_id, p_legal_entity_id, p_payload ->> 'name',
              (p_payload ->> 'responsibleCashierUserAccountId')::uuid, 'DRAFT', 'OFFICE_SAFE');
    WHEN 'SET_LOCATION_STATUS' THEN
      UPDATE abos.cash_locations SET status = p_payload ->> 'status'
       WHERE legal_entity_id = p_legal_entity_id AND id = object_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'cash location not found'; END IF;
    WHEN 'OPEN_ACCOUNT' THEN
      INSERT INTO abos.cash_location_currency_accounts
        (id, legal_entity_id, cash_location_id, currency_code, ledger_account_id, activation_status)
      VALUES (object_id, p_legal_entity_id, (p_payload ->> 'cashLocationId')::uuid,
              p_payload ->> 'currency', (p_payload ->> 'ledgerAccountId')::uuid, 'DRAFT');
    WHEN 'ASSIGN_CASHIER' THEN
      INSERT INTO abos.cash_location_cashier_assignments
        (id, legal_entity_id, cash_location_id, user_account_id, assigned_by_user_account_id)
      VALUES (object_id, p_legal_entity_id, (p_payload ->> 'cashLocationId')::uuid,
              (p_payload ->> 'userAccountId')::uuid, actor);
    WHEN 'REVOKE_CASHIER' THEN
      UPDATE abos.cash_location_cashier_assignments
         SET revoked_at = pg_catalog.clock_timestamp(), revoked_by_user_account_id = actor
       WHERE legal_entity_id = p_legal_entity_id AND id = object_id AND revoked_at IS NULL;
      IF NOT FOUND THEN RAISE EXCEPTION 'active cashier assignment not found'; END IF;
    WHEN 'RECORD_COUNT' THEN
      INSERT INTO abos.physical_cash_counts
        (id, legal_entity_id, cash_location_currency_account_id, currency_code, counted_amount,
         counted_at, counted_by_user_account_id, evidence_reference_id, status, count_purpose)
      VALUES (object_id, p_legal_entity_id, (p_payload ->> 'cashAccountId')::uuid,
              p_payload ->> 'currency', (p_payload ->> 'countedAmount')::numeric,
              pg_catalog.clock_timestamp(), actor, (p_payload ->> 'evidenceReferenceId')::uuid,
              'RECORDED', p_payload ->> 'purpose');
    WHEN 'CONFIRM_OPENING_COUNT' THEN
      UPDATE abos.physical_cash_counts SET status = 'CONFIRMED',
             confirmed_by_user_account_id = actor, confirmed_at = pg_catalog.clock_timestamp()
       WHERE legal_entity_id = p_legal_entity_id AND id = object_id
         AND status = 'RECORDED' AND count_purpose = 'OPENING';
      IF NOT FOUND THEN RAISE EXCEPTION 'recorded opening count not found'; END IF;
    WHEN 'RECONCILE_OPENING' THEN
      INSERT INTO abos.cash_account_openings
        (cash_location_currency_account_id, legal_entity_id, currency_code, opening_counted_amount,
         physical_cash_count_id, reconciliation_evidence_reference_id, reconciled_by_user_account_id)
      VALUES (object_id, p_legal_entity_id, p_payload ->> 'currency',
              (p_payload ->> 'openingCountedAmount')::numeric,
              (p_payload ->> 'physicalCashCountId')::uuid,
              (p_payload ->> 'reconciliationEvidenceReferenceId')::uuid, actor);
      UPDATE abos.cash_location_currency_accounts SET activation_status = 'RECONCILED'
       WHERE legal_entity_id = p_legal_entity_id AND id = object_id AND activation_status = 'DRAFT';
      IF NOT FOUND THEN RAISE EXCEPTION 'draft cash account not found'; END IF;
    WHEN 'APPROVE_OPENING' THEN
      UPDATE abos.cash_account_openings SET status = 'APPROVED',
             approved_by_user_account_id = actor, approved_at = pg_catalog.clock_timestamp()
       WHERE legal_entity_id = p_legal_entity_id AND cash_location_currency_account_id = object_id
         AND status = 'RECONCILED';
      IF NOT FOUND THEN RAISE EXCEPTION 'reconciled opening not found'; END IF;
      UPDATE abos.cash_location_currency_accounts SET activation_status = 'APPROVED'
       WHERE legal_entity_id = p_legal_entity_id AND id = object_id AND activation_status = 'RECONCILED';
      IF NOT FOUND THEN RAISE EXCEPTION 'reconciled account not found'; END IF;
    WHEN 'ACTIVATE_ACCOUNT' THEN
      UPDATE abos.cash_location_currency_accounts SET activation_status = 'ACTIVE',
             activated_by_user_account_id = actor, activated_at = pg_catalog.clock_timestamp(),
             reconciliation_evidence_reference_id = (p_payload ->> 'evidenceReferenceId')::uuid
       WHERE legal_entity_id = p_legal_entity_id AND id = object_id AND activation_status = 'APPROVED';
      IF NOT FOUND THEN RAISE EXCEPTION 'approved cash account not found'; END IF;
    WHEN 'BLOCK_ACCOUNT' THEN
      UPDATE abos.cash_location_currency_accounts SET activation_status = 'BLOCKED'
       WHERE legal_entity_id = p_legal_entity_id AND id = object_id
         AND activation_status IN ('ACTIVE', 'APPROVED', 'RECONCILED');
      IF NOT FOUND THEN RAISE EXCEPTION 'blockable cash account not found'; END IF;
    WHEN 'RECORD_RECEIPT' THEN
      SELECT * INTO source_row FROM abos.capital_receipt_intents
       WHERE legal_entity_id = p_legal_entity_id
         AND id = (p_payload ->> 'capitalReceiptIntentId')::uuid FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'capital receipt source not found'; END IF;
      INSERT INTO abos.cash_receipts
        (id, legal_entity_id, capital_installment_id, capital_receipt_intent_id,
         cash_location_currency_account_id, receipt_reference, amount, currency_code,
         business_event_at, received_by_user_account_id, status)
      VALUES (object_id, p_legal_entity_id, source_row.capital_installment_id, source_row.id,
              source_row.destination_cash_account_id, p_payload ->> 'receiptReference',
              source_row.amount, source_row.currency_code,
              (p_payload ->> 'businessEventAt')::timestamptz, actor, 'DRAFT');
    WHEN 'COUNT_RECEIPT' THEN
      SELECT * INTO receipt_row FROM abos.cash_receipts
       WHERE legal_entity_id = p_legal_entity_id AND id = object_id FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'cash receipt not found'; END IF;
      count_id := (p_payload ->> 'countId')::uuid;
      INSERT INTO abos.physical_cash_counts
        (id, legal_entity_id, cash_location_currency_account_id, currency_code, counted_amount,
         counted_at, counted_by_user_account_id, evidence_reference_id, status, count_purpose)
      VALUES (count_id, p_legal_entity_id, receipt_row.cash_location_currency_account_id,
              receipt_row.currency_code, (p_payload ->> 'countedAmount')::numeric,
              pg_catalog.clock_timestamp(), actor,
              (p_payload ->> 'countEvidenceReferenceId')::uuid, 'RECORDED', 'RECEIPT');
      UPDATE abos.cash_receipts SET status = 'COUNTED', physical_cash_count_id = count_id,
             evidence_reference_id = (p_payload ->> 'receiptEvidenceReferenceId')::uuid
       WHERE legal_entity_id = p_legal_entity_id AND id = object_id AND status = 'DRAFT';
      IF NOT FOUND THEN RAISE EXCEPTION 'draft receipt not found'; END IF;
    WHEN 'SUBMIT_RECEIPT' THEN
      UPDATE abos.cash_receipts SET submitted_for_verification_at = pg_catalog.clock_timestamp()
       WHERE legal_entity_id = p_legal_entity_id AND id = object_id AND status = 'COUNTED'
         AND received_by_user_account_id = actor
         AND submitted_for_verification_at IS NULL;
      IF NOT FOUND THEN RAISE EXCEPTION 'counted receipt awaiting submission not found'; END IF;
    WHEN 'VERIFY_RECEIPT' THEN
      SELECT * INTO receipt_row FROM abos.cash_receipts
       WHERE legal_entity_id = p_legal_entity_id AND id = object_id FOR UPDATE;
      IF NOT FOUND OR receipt_row.physical_cash_count_id IS NULL THEN
        RAISE EXCEPTION 'counted receipt not found';
      END IF;
      UPDATE abos.physical_cash_counts SET status = 'CONFIRMED',
             confirmed_by_user_account_id = actor, confirmed_at = pg_catalog.clock_timestamp()
       WHERE legal_entity_id = p_legal_entity_id AND id = receipt_row.physical_cash_count_id
         AND status = 'RECORDED';
      IF NOT FOUND THEN RAISE EXCEPTION 'recorded receipt count not found'; END IF;
      UPDATE abos.cash_receipts SET status = 'VERIFIED', verified_by_user_account_id = actor,
             verified_at = pg_catalog.clock_timestamp()
       WHERE legal_entity_id = p_legal_entity_id AND id = object_id AND status = 'COUNTED';
      IF NOT FOUND THEN RAISE EXCEPTION 'counted receipt not found'; END IF;
    WHEN 'VOID_RECEIPT' THEN
      SELECT * INTO receipt_row FROM abos.cash_receipts
       WHERE legal_entity_id = p_legal_entity_id AND id = object_id FOR UPDATE;
      IF NOT FOUND OR receipt_row.status NOT IN ('DRAFT', 'COUNTED') THEN
        RAISE EXCEPTION 'voidable receipt not found';
      END IF;
      IF length(btrim(coalesce(p_payload ->> 'reason', ''))) < 5 THEN
        RAISE EXCEPTION 'void reason must contain at least five characters';
      END IF;
      IF receipt_row.received_by_user_account_id = actor THEN
        PERFORM abos.treasury_runtime_authorize(
          p_bearer_token, p_legal_entity_id, 'treasury.cash-receipt.record');
      ELSE
        PERFORM abos.treasury_runtime_authorize(
          p_bearer_token, p_legal_entity_id, 'treasury.cash-receipt.verify');
      END IF;
      UPDATE abos.cash_receipts SET status = 'VOIDED', voided_by_user_account_id = actor,
             voided_at = pg_catalog.clock_timestamp(), void_reason = p_payload ->> 'reason'
       WHERE legal_entity_id = p_legal_entity_id AND id = object_id AND status IN ('DRAFT', 'COUNTED');
      IF NOT FOUND THEN RAISE EXCEPTION 'voidable receipt not found'; END IF;
    WHEN 'HANDOFF_RECEIPT' THEN
      SELECT * INTO receipt_row FROM abos.cash_receipts
       WHERE legal_entity_id = p_legal_entity_id AND id = object_id FOR UPDATE;
      IF NOT FOUND OR receipt_row.status <> 'VERIFIED' THEN RAISE EXCEPTION 'verified receipt not found'; END IF;
      SELECT * INTO existing_handoff FROM abos.treasury_finance_handoffs
       WHERE cash_receipt_id = object_id;
      IF FOUND THEN
        IF existing_handoff.capital_receipt_intent_id <> receipt_row.capital_receipt_intent_id THEN
          RAISE EXCEPTION 'receipt has a conflicting Finance handoff';
        END IF;
        RETURN pg_catalog.jsonb_build_object('id', existing_handoff.id, 'replayed', true);
      END IF;
      UPDATE abos.capital_receipt_intents
         SET status = 'TREASURY_VERIFIED', contribution_state = 'VERIFIED',
             treasury_cash_receipt_id = receipt_row.id, version = version + 1,
             updated_at = pg_catalog.clock_timestamp()
       WHERE legal_entity_id = p_legal_entity_id AND id = receipt_row.capital_receipt_intent_id
         AND status = 'ELIGIBLE';
      IF NOT FOUND THEN RAISE EXCEPTION 'eligible capital receipt intent not found'; END IF;
      INSERT INTO abos.treasury_finance_handoffs
        (id, legal_entity_id, cash_receipt_id, capital_receipt_intent_id,
         handed_off_by_user_account_id, correlation_id)
      VALUES ((p_payload ->> 'handoffId')::uuid, p_legal_entity_id, receipt_row.id,
              receipt_row.capital_receipt_intent_id, actor, (p_payload ->> 'correlationId')::uuid);
      RETURN pg_catalog.jsonb_build_object('id', p_payload ->> 'handoffId', 'replayed', false);
  END CASE;
  RETURN pg_catalog.jsonb_build_object('id', object_id, 'operation', p_operation);
END
$command$;

-- Replace the four configuration-table sandbox triggers with a dual guard. The operational branch
-- is deliberately narrower than the table: it permits configuration only. All custody-affecting
-- transitions fall through to the unchanged synthetic sandbox assertion.
CREATE FUNCTION abos.guard_operational_treasury_configuration()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $guard$
DECLARE
  operational boolean := current_user = 'abos_e1_treasury_owner'
    AND pg_catalog.current_setting('abos.operational_treasury_configuration', true) = 'V1_REVIEWED';
  entity_id uuid;
BEGIN
  IF operational THEN
    CASE TG_TABLE_NAME
      WHEN 'cash_locations' THEN
        IF TG_OP = 'INSERT' AND NEW.status = 'DRAFT' THEN
          RETURN NEW;
        END IF;
        IF TG_OP = 'UPDATE'
           AND NEW.id = OLD.id
           AND NEW.legal_entity_id = OLD.legal_entity_id
           AND NEW.location_kind = OLD.location_kind
           AND NEW.created_at = OLD.created_at
           AND NOT EXISTS (
             SELECT 1 FROM abos.cash_location_currency_accounts account
              WHERE account.cash_location_id = OLD.id
                AND account.legal_entity_id = OLD.legal_entity_id
                AND account.activation_status <> 'DRAFT'
           ) THEN
          RETURN NEW;
        END IF;
        RAISE EXCEPTION 'operational cash-location configuration cannot change a location with custody state'
          USING ERRCODE = 'insufficient_privilege';

      WHEN 'cash_location_cashier_assignments' THEN
        IF TG_OP = 'INSERT' AND NEW.revoked_at IS NULL AND NEW.revoked_by_user_account_id IS NULL THEN
          RETURN NEW;
        END IF;
        IF TG_OP = 'UPDATE'
           AND OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
           AND NEW.id = OLD.id AND NEW.legal_entity_id = OLD.legal_entity_id
           AND NEW.cash_location_id = OLD.cash_location_id
           AND NEW.user_account_id = OLD.user_account_id
           AND NEW.assigned_by_user_account_id = OLD.assigned_by_user_account_id
           AND NEW.assigned_at = OLD.assigned_at THEN
          RETURN NEW;
        END IF;
        RAISE EXCEPTION 'operational cashier configuration permits only assignment or revocation'
          USING ERRCODE = 'insufficient_privilege';

      WHEN 'cash_location_currency_accounts' THEN
        IF TG_OP = 'INSERT'
           AND NEW.activation_status = 'DRAFT'
           AND NEW.reconciliation_evidence_reference_id IS NULL
           AND NEW.activated_by_user_account_id IS NULL
           AND NEW.activated_at IS NULL THEN
          RETURN NEW;
        END IF;
        RAISE EXCEPTION 'operational currency-account configuration permits only a new DRAFT account'
          USING ERRCODE = 'insufficient_privilege';

      WHEN 'saraf_accounts' THEN
        -- Saraf account lifecycle is configuration, not cash custody. The existing Saraf trigger
        -- still enforces independent activation, party/role status and ledger/currency mapping.
        IF TG_OP IN ('INSERT', 'UPDATE') THEN
          RETURN NEW;
        END IF;
        RAISE EXCEPTION 'operational Saraf configuration does not permit deletion'
          USING ERRCODE = 'insufficient_privilege';

      ELSE
        RAISE EXCEPTION 'unsupported operational Treasury configuration table'
          USING ERRCODE = 'insufficient_privilege';
    END CASE;
  END IF;

  entity_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.legal_entity_id ELSE NEW.legal_entity_id END;
  PERFORM abos.assert_sandbox_mutation_authorized(entity_id);
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$guard$;
ALTER FUNCTION abos.guard_operational_treasury_configuration() OWNER TO abos_e1_treasury_owner;
REVOKE ALL ON FUNCTION abos.guard_operational_treasury_configuration() FROM PUBLIC;

DROP TRIGGER cash_locations_sandbox_guard ON abos.cash_locations;
CREATE TRIGGER cash_locations_sandbox_guard
BEFORE INSERT OR UPDATE ON abos.cash_locations
FOR EACH ROW EXECUTE FUNCTION abos.guard_operational_treasury_configuration();
DROP TRIGGER cash_location_cashier_assignments_sandbox_guard ON abos.cash_location_cashier_assignments;
CREATE TRIGGER cash_location_cashier_assignments_sandbox_guard
BEFORE INSERT OR UPDATE ON abos.cash_location_cashier_assignments
FOR EACH ROW EXECUTE FUNCTION abos.guard_operational_treasury_configuration();
DROP TRIGGER cash_location_currency_accounts_sandbox_guard ON abos.cash_location_currency_accounts;
CREATE TRIGGER cash_location_currency_accounts_sandbox_guard
BEFORE INSERT OR UPDATE ON abos.cash_location_currency_accounts
FOR EACH ROW EXECUTE FUNCTION abos.guard_operational_treasury_configuration();
DROP TRIGGER saraf_accounts_sandbox_guard ON abos.saraf_accounts;
CREATE TRIGGER saraf_accounts_sandbox_guard
BEFORE INSERT OR UPDATE ON abos.saraf_accounts
FOR EACH ROW EXECUTE FUNCTION abos.guard_operational_treasury_configuration();

-- GL reads include both processing models already; their contract must no longer claim synthetic-only.
CREATE OR REPLACE FUNCTION abos.finance_general_ledger(
  p_bearer_token text,
  p_from date,
  p_to date,
  p_account_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $ledger$
DECLARE
  entity_id uuid;
  actor_id uuid;
  lines jsonb;
  totals jsonb;
BEGIN
  actor_id := abos.finance_runtime_authorize(p_bearer_token, 'finance.report.operational.read');
  entity_id := pg_catalog.current_setting('abos.finance_legal_entity_id')::uuid;
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN
    RAISE EXCEPTION 'valid inclusive date range required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_account_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM abos.ledger_accounts account
     WHERE account.id = p_account_id AND account.legal_entity_id = entity_id
  ) THEN
    RAISE EXCEPTION 'ledger account is outside the current legal entity'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(item)
           ORDER BY item."accountingEffectiveDate" DESC, item."postedAt" DESC,
                    item."journalId" DESC, item."lineNumber"), '[]'::jsonb)
    INTO lines
    FROM (
      SELECT journal.id AS "journalId", journal.journal_reference AS "journalReference",
             line.line_number AS "lineNumber", account.id AS "accountId",
             account.account_code AS "accountCode", account.account_name AS "accountName",
             line.source_type AS "sourceType", line.source_id AS "sourceId",
             journal.accounting_period_id AS "accountingPeriodId",
             journal.accounting_effective_date AS "accountingEffectiveDate",
             journal.posted_at AS "postedAt",
             line.original_currency_code AS "originalCurrency",
             line.original_amount::text AS "originalAmount",
             line.base_currency_code AS "baseCurrency",
             line.base_debit::text AS "baseDebit",
             line.base_credit::text AS "baseCredit"
        FROM abos.journal_lines line
        JOIN abos.journals journal
          ON journal.id = line.journal_id AND journal.legal_entity_id = line.legal_entity_id
        JOIN abos.ledger_accounts account
          ON account.id = line.ledger_account_id AND account.legal_entity_id = line.legal_entity_id
       WHERE journal.legal_entity_id = entity_id AND line.legal_entity_id = entity_id
         AND journal.status = 'POSTED'
         AND journal.accounting_effective_date BETWEEN p_from AND p_to
         AND (p_account_id IS NULL OR line.ledger_account_id = p_account_id)
         AND (line.project_id IS NULL OR EXISTS (
           SELECT 1 FROM abos.user_scope_grants scope
            WHERE scope.user_account_id = actor_id AND scope.legal_entity_id = entity_id
              AND scope.scope_kind = 'PROJECT' AND scope.scope_id = line.project_id
              AND scope.revoked_at IS NULL))
         AND (line.department_id IS NULL OR EXISTS (
           SELECT 1 FROM abos.user_scope_grants scope
            WHERE scope.user_account_id = actor_id AND scope.legal_entity_id = entity_id
              AND scope.scope_kind = 'DEPARTMENT' AND scope.scope_id = line.department_id
              AND scope.revoked_at IS NULL))
         AND (line.cost_center_id IS NULL OR EXISTS (
           SELECT 1 FROM abos.user_scope_grants scope
            WHERE scope.user_account_id = actor_id AND scope.legal_entity_id = entity_id
              AND scope.scope_kind = 'COST_CENTER' AND scope.scope_id = line.cost_center_id
              AND scope.revoked_at IS NULL))
       ORDER BY journal.accounting_effective_date DESC, journal.posted_at DESC,
                journal.id DESC, line.line_number
       LIMIT 100
    ) item;

  SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(item)
           ORDER BY item.currency), '[]'::jsonb)
    INTO totals
    FROM (
      SELECT line.base_currency_code AS currency,
             pg_catalog.sum(line.base_debit)::text AS debits,
             pg_catalog.sum(line.base_credit)::text AS credits,
             pg_catalog.count(*)::text AS "lineCount"
        FROM abos.journal_lines line
        JOIN abos.journals journal
          ON journal.id = line.journal_id AND journal.legal_entity_id = line.legal_entity_id
       WHERE journal.legal_entity_id = entity_id AND line.legal_entity_id = entity_id
         AND journal.status = 'POSTED'
         AND journal.accounting_effective_date BETWEEN p_from AND p_to
         AND (p_account_id IS NULL OR line.ledger_account_id = p_account_id)
         AND (line.project_id IS NULL OR EXISTS (
           SELECT 1 FROM abos.user_scope_grants scope
            WHERE scope.user_account_id = actor_id AND scope.legal_entity_id = entity_id
              AND scope.scope_kind = 'PROJECT' AND scope.scope_id = line.project_id
              AND scope.revoked_at IS NULL))
         AND (line.department_id IS NULL OR EXISTS (
           SELECT 1 FROM abos.user_scope_grants scope
            WHERE scope.user_account_id = actor_id AND scope.legal_entity_id = entity_id
              AND scope.scope_kind = 'DEPARTMENT' AND scope.scope_id = line.department_id
              AND scope.revoked_at IS NULL))
         AND (line.cost_center_id IS NULL OR EXISTS (
           SELECT 1 FROM abos.user_scope_grants scope
            WHERE scope.user_account_id = actor_id AND scope.legal_entity_id = entity_id
              AND scope.scope_kind = 'COST_CENTER' AND scope.scope_id = line.cost_center_id
              AND scope.revoked_at IS NULL))
       GROUP BY line.base_currency_code
    ) item;

  RETURN pg_catalog.jsonb_build_object(
    'syntheticOnly', false, 'legalEntityId', entity_id,
    'from', p_from, 'to', p_to, 'accountId', p_account_id,
    'lines', lines, 'totals', totals, 'pageLimit', 100,
    'returnedLineCount', pg_catalog.jsonb_array_length(lines),
    'hasMore', (SELECT coalesce(pg_catalog.sum((entry ->> 'lineCount')::bigint), 0)
                 FROM pg_catalog.jsonb_array_elements(totals) entry)
               > pg_catalog.jsonb_array_length(lines));
END
$ledger$;

CREATE OR REPLACE FUNCTION abos.finance_general_ledger_activity(
  p_bearer_token text,
  p_from date,
  p_to date,
  p_account_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $activity$
DECLARE
  entity_id uuid;
  actor_id uuid;
  result jsonb;
BEGIN
  actor_id := abos.finance_runtime_authorize(p_bearer_token, 'finance.report.operational.read');
  entity_id := pg_catalog.current_setting('abos.finance_legal_entity_id')::uuid;
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN
    RAISE EXCEPTION 'valid inclusive date range required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_account_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM abos.ledger_accounts account
     WHERE account.id = p_account_id AND account.legal_entity_id = entity_id
  ) THEN
    RAISE EXCEPTION 'ledger account is outside the current legal entity'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- One statement, so the per-account rows and the per-currency totals share one snapshot.
  WITH visible AS MATERIALIZED (
    SELECT * FROM abos.finance_gl_visible_lines(entity_id, actor_id, p_from, p_to, p_account_id)
  ), original AS (
    SELECT visible.account_id, visible.base_currency_code, visible.original_currency_code,
           pg_catalog.sum(CASE WHEN visible.base_debit > 0 THEN visible.original_amount ELSE 0 END) AS debit_total,
           pg_catalog.sum(CASE WHEN visible.base_credit > 0 THEN visible.original_amount ELSE 0 END) AS credit_total,
           pg_catalog.count(*) AS line_count
      FROM visible
     WHERE visible.original_currency_code IS NOT NULL
     GROUP BY visible.account_id, visible.base_currency_code, visible.original_currency_code
  ), per_account AS (
    SELECT visible.account_id, visible.account_code, visible.account_name, visible.base_currency_code,
           pg_catalog.sum(visible.base_debit) AS debit_total,
           pg_catalog.sum(visible.base_credit) AS credit_total,
           pg_catalog.count(*) AS line_count
      FROM visible
     GROUP BY visible.account_id, visible.account_code, visible.account_name, visible.base_currency_code
  ), per_currency AS (
    SELECT visible.base_currency_code,
           pg_catalog.sum(visible.base_debit) AS debit_total,
           pg_catalog.sum(visible.base_credit) AS credit_total,
           pg_catalog.count(*) AS line_count,
           pg_catalog.count(DISTINCT visible.account_id) AS account_count
      FROM visible
     GROUP BY visible.base_currency_code
  )
  SELECT pg_catalog.jsonb_build_object(
           'accounts', coalesce((
             SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                      'accountId', per_account.account_id,
                      'accountCode', per_account.account_code,
                      'accountName', per_account.account_name,
                      'baseCurrency', per_account.base_currency_code,
                      'debitTotal', per_account.debit_total::text,
                      'creditTotal', per_account.credit_total::text,
                      'net', (per_account.debit_total - per_account.credit_total)::text,
                      'lineCount', per_account.line_count::text,
                      'originalCurrencies', coalesce((
                        SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                                 'currency', original.original_currency_code,
                                 'debitTotal', original.debit_total::text,
                                 'creditTotal', original.credit_total::text,
                                 'net', (original.debit_total - original.credit_total)::text,
                                 'lineCount', original.line_count::text)
                               ORDER BY original.original_currency_code)
                          FROM original
                         WHERE original.account_id = per_account.account_id
                           AND original.base_currency_code = per_account.base_currency_code), '[]'::jsonb))
                    ORDER BY per_account.account_code, per_account.base_currency_code, per_account.account_id)
               FROM per_account), '[]'::jsonb),
           'currencyTotals', coalesce((
             SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                      'baseCurrency', per_currency.base_currency_code,
                      'debitTotal', per_currency.debit_total::text,
                      'creditTotal', per_currency.credit_total::text,
                      'net', (per_currency.debit_total - per_currency.credit_total)::text,
                      'lineCount', per_currency.line_count::text,
                      'accountCount', per_currency.account_count::text)
                    ORDER BY per_currency.base_currency_code)
               FROM per_currency), '[]'::jsonb))
    INTO result;

  RETURN pg_catalog.jsonb_build_object(
    'syntheticOnly', false, 'legalEntityId', entity_id,
    'from', p_from, 'to', p_to, 'accountId', p_account_id,
    'basis', 'POSTED_ACTIVITY_IN_RANGE',
    'isBalance', false, 'openingBalancesIncluded', false,
    'accounts', result -> 'accounts', 'currencyTotals', result -> 'currencyTotals');
END
$activity$;

CREATE OR REPLACE FUNCTION abos.finance_general_ledger_page(
  p_bearer_token text,
  p_from date,
  p_to date,
  p_account_id uuid DEFAULT NULL,
  p_cursor text DEFAULT NULL,
  p_page_size integer DEFAULT 100
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $page$
DECLARE
  entity_id uuid;
  actor_id uuid;
  cursor_key jsonb;
  after_date date;
  after_posted timestamptz;
  after_journal uuid;
  after_line integer;
  page_size integer := coalesce(p_page_size, 100);
  result jsonb;
  last_line jsonb;
  more boolean;
BEGIN
  actor_id := abos.finance_runtime_authorize(p_bearer_token, 'finance.report.operational.read');
  entity_id := pg_catalog.current_setting('abos.finance_legal_entity_id')::uuid;
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN
    RAISE EXCEPTION 'valid inclusive date range required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF page_size < 1 OR page_size > 100 THEN
    RAISE EXCEPTION 'page size must be between 1 and 100' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_account_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM abos.ledger_accounts account
     WHERE account.id = p_account_id AND account.legal_entity_id = entity_id
  ) THEN
    RAISE EXCEPTION 'ledger account is outside the current legal entity'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_cursor IS NOT NULL THEN
    BEGIN
      IF pg_catalog.length(p_cursor) > 400 OR p_cursor !~ '^[A-Za-z0-9_-]+$' THEN
        RAISE EXCEPTION 'malformed';
      END IF;
      cursor_key := pg_catalog.convert_from(pg_catalog.decode(
        pg_catalog.rpad(pg_catalog.translate(p_cursor, '-_', '+/'),
                        ((pg_catalog.length(p_cursor) + 3) / 4) * 4, '='), 'base64'), 'UTF8')::jsonb;
      IF pg_catalog.jsonb_typeof(cursor_key) <> 'object' OR (cursor_key ->> 'v') IS DISTINCT FROM '1'
         OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(cursor_key)) <> 5 THEN
        RAISE EXCEPTION 'malformed';
      END IF;
      after_date := (cursor_key ->> 'd')::date;
      after_posted := (cursor_key ->> 'p')::timestamptz;
      after_journal := (cursor_key ->> 'j')::uuid;
      after_line := (cursor_key ->> 'l')::integer;
      IF after_date IS NULL OR after_posted IS NULL OR after_journal IS NULL OR after_line IS NULL
         OR after_line < 1 THEN
        RAISE EXCEPTION 'malformed';
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'General Ledger cursor is invalid' USING ERRCODE = 'invalid_parameter_value';
    END;
  END IF;

  -- One statement, so the page, the look-ahead row and the first-page totals share one snapshot.
  WITH visible AS MATERIALIZED (
    SELECT * FROM abos.finance_gl_visible_lines(entity_id, actor_id, p_from, p_to, p_account_id)
  ), after_position AS (
    SELECT visible.*
      FROM visible
     WHERE p_cursor IS NULL
        OR (visible.accounting_effective_date, visible.posted_at, visible.journal_id)
             < (after_date, after_posted, after_journal)
        OR ((visible.accounting_effective_date, visible.posted_at, visible.journal_id)
             = (after_date, after_posted, after_journal)
            AND visible.line_number > after_line)
     ORDER BY visible.accounting_effective_date DESC, visible.posted_at DESC,
              visible.journal_id DESC, visible.line_number
     LIMIT page_size + 1
  ), numbered AS (
    SELECT after_position.*,
           pg_catalog.row_number() OVER (
             ORDER BY after_position.accounting_effective_date DESC, after_position.posted_at DESC,
                      after_position.journal_id DESC, after_position.line_number) AS ordinal
      FROM after_position
  )
  SELECT pg_catalog.jsonb_build_object(
           'lines', coalesce((
             SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                      'journalId', numbered.journal_id,
                      'journalReference', numbered.journal_reference,
                      'lineNumber', numbered.line_number,
                      'accountId', numbered.account_id,
                      'accountCode', numbered.account_code,
                      'accountName', numbered.account_name,
                      'sourceType', numbered.source_type,
                      'sourceId', numbered.source_id,
                      'accountingPeriodId', numbered.accounting_period_id,
                      'accountingEffectiveDate', numbered.accounting_effective_date,
                      'postedAt', numbered.posted_at,
                      'originalCurrency', numbered.original_currency_code,
                      'originalAmount', numbered.original_amount::text,
                      'baseCurrency', numbered.base_currency_code,
                      'baseDebit', numbered.base_debit::text,
                      'baseCredit', numbered.base_credit::text)
                    ORDER BY numbered.ordinal)
               FROM numbered WHERE numbered.ordinal <= page_size), '[]'::jsonb),
           'more', EXISTS (SELECT 1 FROM numbered WHERE numbered.ordinal > page_size),
           'totals', CASE WHEN p_cursor IS NULL THEN coalesce((
             SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                      'currency', totals.base_currency_code, 'debits', totals.debits,
                      'credits', totals.credits, 'lineCount', totals.line_count)
                    ORDER BY totals.base_currency_code)
               FROM (SELECT visible.base_currency_code,
                            pg_catalog.sum(visible.base_debit)::text AS debits,
                            pg_catalog.sum(visible.base_credit)::text AS credits,
                            pg_catalog.count(*)::text AS line_count
                       FROM visible GROUP BY visible.base_currency_code) totals), '[]'::jsonb)
             END)
    INTO result;

  more := (result ->> 'more')::boolean;
  last_line := result -> 'lines' -> -1;

  RETURN pg_catalog.jsonb_build_object(
    'syntheticOnly', false, 'legalEntityId', entity_id,
    'from', p_from, 'to', p_to, 'accountId', p_account_id,
    'order', 'accountingEffectiveDate DESC, postedAt DESC, journalId DESC, lineNumber ASC',
    'pageLimit', page_size,
    'lines', result -> 'lines',
    'returnedLineCount', pg_catalog.jsonb_array_length(result -> 'lines'),
    'hasMore', more,
    'nextCursor', CASE WHEN more AND last_line IS NOT NULL THEN
      pg_catalog.rtrim(pg_catalog.translate(pg_catalog.encode(pg_catalog.convert_to(
        pg_catalog.jsonb_build_object(
          'v', 1,
          'd', last_line -> 'accountingEffectiveDate',
          'p', last_line -> 'postedAt',
          'j', last_line -> 'journalId',
          'l', last_line -> 'lineNumber')::text, 'UTF8'), 'base64'), E'+/\n', '-_'), '=')
      END,
    'totals', result -> 'totals');
END
$page$;

-- Password session issuance is atomic and separate from the legacy synthetic ISSUE_SESSION command.
-- The runtime supplies digests and the credential hash already verified by the password service;
-- the owner function rechecks every value while holding the account/credential/grant rows.
CREATE FUNCTION abos.identity_issue_password_session(p_signing_secret text, p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $issue$
DECLARE
  account_row record;
  issued_at timestamptz;
  expires_at timestamptz;
BEGIN
  IF p_signing_secret IS NULL OR pg_catalog.length(p_signing_secret) < 32 OR NOT EXISTS (
    SELECT 1 FROM abos.identity_runtime_configuration configuration
     WHERE configuration.singleton AND configuration.signing_secret_sha256 = pg_catalog.encode(
       pg_catalog.sha256(pg_catalog.convert_to(p_signing_secret, 'UTF8')), 'hex')
  ) THEN
    RAISE EXCEPTION 'identity runtime proof is invalid or not configured'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload) <> 'object'
     OR p_payload - ARRAY['id','userAccountId','legalEntityId','expectedPasswordHash',
                           'tokenSha256','runtimeTokenSha256','issuedAt','expiresAt']::text[] <> '{}'::jsonb THEN
    RAISE EXCEPTION 'password session payload is invalid' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF COALESCE(p_payload->>'tokenSha256','') !~ '^[0-9a-f]{64}$'
     OR COALESCE(p_payload->>'runtimeTokenSha256','') !~ '^[0-9a-f]{64}$'
     OR COALESCE(p_payload->>'expectedPasswordHash','') = '' THEN
    RAISE EXCEPTION 'password session proof is invalid' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  issued_at := (p_payload->>'issuedAt')::timestamptz;
  expires_at := (p_payload->>'expiresAt')::timestamptz;
  IF issued_at > pg_catalog.clock_timestamp() + interval '1 minute'
     OR expires_at <= issued_at OR expires_at > issued_at + interval '24 hours' THEN
    RAISE EXCEPTION 'password session lifetime is invalid' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT account.id, account.status, credential.password_hash, credential.must_change_password
    INTO account_row
    FROM abos.user_accounts account
    JOIN abos.user_credentials credential ON credential.user_account_id = account.id
   WHERE account.id = (p_payload->>'userAccountId')::uuid
   FOR SHARE OF account, credential;
  IF NOT FOUND OR account_row.status <> 'ACTIVE' OR account_row.must_change_password
     OR account_row.password_hash <> p_payload->>'expectedPasswordHash'
     OR NOT EXISTS (
       SELECT 1 FROM abos.user_permission_grants grant_row
        WHERE grant_row.user_account_id = account_row.id
          AND grant_row.legal_entity_id = (p_payload->>'legalEntityId')::uuid
          AND grant_row.revoked_at IS NULL
        FOR SHARE
     ) THEN
    RAISE EXCEPTION 'password session authority is no longer current'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO abos.sandbox_sessions
    (id, user_account_id, token_sha256, runtime_token_sha256, legal_entity_id,
     issued_at, expires_at, session_provenance)
  VALUES ((p_payload->>'id')::uuid, account_row.id, p_payload->>'tokenSha256',
          p_payload->>'runtimeTokenSha256', (p_payload->>'legalEntityId')::uuid,
          issued_at, expires_at, 'PASSWORD_OPERATIONAL');
  RETURN pg_catalog.jsonb_build_object(
    'affected', 1, 'userAccountId', account_row.id,
    'legalEntityId', (p_payload->>'legalEntityId')::uuid,
    'sessionProvenance', 'PASSWORD_OPERATIONAL');
END
$issue$;
ALTER FUNCTION abos.identity_issue_password_session(text, jsonb) OWNER TO abos_v1_identity_owner;
REVOKE ALL ON FUNCTION abos.identity_issue_password_session(text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION abos.identity_issue_password_session(text, jsonb) TO abos_v1_identity_runtime;

-- Operational identity resolution accepts only a live password-authenticated session. Synthetic
-- developer sessions continue to use the E1 authorizers and can never be upgraded by this function.
CREATE OR REPLACE FUNCTION abos.identity_actor_context(
  p_signing_secret text, p_runtime_token_sha256 text, p_token_sha256 text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $context$
DECLARE session_row record; permissions text[];
BEGIN
  IF p_signing_secret IS NULL OR pg_catalog.length(p_signing_secret) < 32 OR NOT EXISTS (
    SELECT 1 FROM abos.identity_runtime_configuration configuration
     WHERE configuration.singleton AND configuration.signing_secret_sha256 = pg_catalog.encode(
       pg_catalog.sha256(pg_catalog.convert_to(p_signing_secret, 'UTF8')), 'hex')
  ) THEN
    RAISE EXCEPTION 'identity runtime proof is invalid or not configured'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT session.id, session.user_account_id, session.legal_entity_id,
         session.revoked_at IS NULL AND session.expires_at > pg_catalog.clock_timestamp() AS live,
         session.session_provenance, account.status, account.login_identifier,
         credential.must_change_password
    INTO session_row
    FROM abos.sandbox_sessions session
    JOIN abos.user_accounts account ON account.id = session.user_account_id
    JOIN abos.user_credentials credential ON credential.user_account_id = account.id
   WHERE session.runtime_token_sha256 = p_runtime_token_sha256
     AND session.token_sha256 = p_token_sha256
     AND session.session_provenance = 'PASSWORD_OPERATIONAL'
   FOR SHARE OF session, account, credential;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM 1 FROM abos.user_permission_grants grant_row
   WHERE grant_row.user_account_id = session_row.user_account_id
     AND grant_row.legal_entity_id = session_row.legal_entity_id
     AND grant_row.revoked_at IS NULL FOR SHARE;
  IF NOT FOUND THEN RETURN NULL; END IF;
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
    'sessionProvenance', session_row.session_provenance,
    'permissions', pg_catalog.to_jsonb(permissions));
END
$context$;
ALTER FUNCTION abos.identity_actor_context(text, text, text) OWNER TO abos_v1_identity_owner;
REVOKE ALL ON FUNCTION abos.identity_actor_context(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION abos.identity_actor_context(text, text, text) TO abos_v1_identity_runtime;

-- Password-backed refresh: identical atomic credential/session/grant checks to 0021,
-- without the synthetic authorization. The legacy ROTATE_SESSION command is untouched.
CREATE FUNCTION abos.identity_rotate_password_session(p_signing_secret text, p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $rotate$
DECLARE affected integer := 0; session_row record;
BEGIN
  IF p_signing_secret IS NULL OR pg_catalog.length(p_signing_secret) < 32 OR NOT EXISTS (
    SELECT 1 FROM abos.identity_runtime_configuration configuration
     WHERE configuration.singleton AND configuration.signing_secret_sha256 = pg_catalog.encode(
       pg_catalog.sha256(pg_catalog.convert_to(p_signing_secret, 'UTF8')), 'hex')
  ) THEN
    RAISE EXCEPTION 'identity runtime proof is invalid or not configured' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'identity command payload must be an object' USING ERRCODE = 'invalid_parameter_value';
  END IF;

      SELECT session.id, session.user_account_id, session.legal_entity_id
        INTO session_row
        FROM abos.sandbox_sessions session
        JOIN abos.user_accounts account ON account.id = session.user_account_id
        JOIN abos.user_credentials credential ON credential.user_account_id = account.id
       WHERE session.runtime_token_sha256 = p_payload->>'oldRuntimeTokenSha256'
         AND session.token_sha256 = p_payload->>'oldTokenSha256'
         AND session.session_provenance = 'PASSWORD_OPERATIONAL'
         AND session.revoked_at IS NULL AND session.expires_at > pg_catalog.clock_timestamp()
         AND account.status = 'ACTIVE' AND NOT credential.must_change_password
         AND EXISTS (SELECT 1 FROM abos.user_permission_grants grant_row
                      WHERE grant_row.user_account_id = session.user_account_id
                        AND grant_row.legal_entity_id = session.legal_entity_id
                        AND grant_row.revoked_at IS NULL)
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
         legal_entity_id, issued_at, expires_at, session_provenance)
      VALUES ((p_payload->>'id')::uuid, session_row.user_account_id,
              p_payload->>'tokenSha256', p_payload->>'runtimeTokenSha256',
              session_row.legal_entity_id, (p_payload->>'issuedAt')::timestamptz,
              (p_payload->>'expiresAt')::timestamptz, 'PASSWORD_OPERATIONAL');
      UPDATE abos.sandbox_sessions SET revoked_at = pg_catalog.clock_timestamp()
       WHERE id = session_row.id AND revoked_at IS NULL;
      GET DIAGNOSTICS affected = ROW_COUNT;
      IF affected <> 1 THEN
        RAISE EXCEPTION 'session was already rotated' USING ERRCODE = 'serialization_failure';
      END IF;
      RETURN pg_catalog.jsonb_build_object(
        'affected', affected, 'userAccountId', session_row.user_account_id,
        'legalEntityId', session_row.legal_entity_id,
        'sessionProvenance', 'PASSWORD_OPERATIONAL');


END
$rotate$;
ALTER FUNCTION abos.identity_rotate_password_session(text, jsonb) OWNER TO abos_v1_identity_owner;
REVOKE ALL ON FUNCTION abos.identity_rotate_password_session(text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION abos.identity_rotate_password_session(text, jsonb) TO abos_v1_identity_runtime;

-- Developer-token exchange retains the original sandbox-only context.
CREATE OR REPLACE FUNCTION abos.treasury_synthetic_signin_context(p_bearer_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $context$
DECLARE session_row record; permissions jsonb;
BEGIN
  IF p_bearer_token IS NULL OR pg_catalog.length(p_bearer_token) < 32 THEN
    RAISE EXCEPTION 'valid sandbox bearer credential required' USING ERRCODE='insufficient_privilege';
  END IF;
  SELECT session.id, session.user_account_id, session.legal_entity_id, session.expires_at,
         session.revoked_at, session.session_provenance,
         account.display_name, account.status AS user_status
    INTO session_row
    FROM abos.sandbox_sessions session
    JOIN abos.user_accounts account ON account.id=session.user_account_id
   WHERE session.runtime_token_sha256=
     pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_bearer_token,'UTF8')),'hex')
   FOR SHARE OF session, account;
  IF NOT FOUND OR session_row.revoked_at IS NOT NULL
     OR session_row.expires_at <= pg_catalog.clock_timestamp()
     OR session_row.user_status <> 'ACTIVE'
     OR session_row.session_provenance <> 'SYNTHETIC_DEVELOPER'
     OR NOT EXISTS (SELECT 1 FROM abos.sandbox_authorizations gate
       WHERE gate.singleton AND gate.environment IN ('development','test')
         AND gate.configuration_state='SYNTHETIC_TEST_ONLY' AND NOT gate.real_posting_enabled
         AND gate.expires_at > pg_catalog.clock_timestamp() FOR SHARE)
     OR NOT EXISTS (SELECT 1 FROM abos.sandbox_legal_entity_scopes scope
       WHERE scope.legal_entity_id=session_row.legal_entity_id FOR SHARE) THEN
    RAISE EXCEPTION 'sandbox session is invalid, expired, revoked or out of scope'
      USING ERRCODE='insufficient_privilege';
  END IF;
  SELECT coalesce(pg_catalog.jsonb_agg(grant_row.permission_code
           ORDER BY grant_row.permission_code),'[]'::jsonb)
    INTO permissions FROM abos.user_permission_grants grant_row
   WHERE grant_row.user_account_id=session_row.user_account_id
     AND grant_row.legal_entity_id=session_row.legal_entity_id
     AND grant_row.permission_code LIKE 'treasury.%' AND grant_row.revoked_at IS NULL;
  RETURN pg_catalog.jsonb_build_object(
    'sessionId',session_row.id,'userAccountId',session_row.user_account_id,
    'legalEntityId',session_row.legal_entity_id,'displayName',session_row.display_name,
    'expiresAt',session_row.expires_at,'sessionProvenance',session_row.session_provenance,
    'treasuryPermissions',permissions,'syntheticAuthorized',true);
END
$context$;
ALTER FUNCTION abos.treasury_synthetic_signin_context(text) OWNER TO abos_e1_treasury_owner;
REVOKE ALL ON FUNCTION abos.treasury_synthetic_signin_context(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION abos.treasury_synthetic_signin_context(text) TO abos_e1_treasury_runtime;

CREATE OR REPLACE FUNCTION abos.treasury_secure_query(
  p_bearer_token text,
  p_legal_entity_id uuid,
  p_query text,
  p_object_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $query$
DECLARE result jsonb;
BEGIN
  IF p_query IN ('LOCATIONS', 'ACCOUNTS', 'ASSIGNMENTS', 'CASH_LEDGER', 'USERS') THEN
    BEGIN
      PERFORM abos.treasury_runtime_authorize(
        p_bearer_token, p_legal_entity_id, 'treasury.cash-location.manage'
      );
    EXCEPTION
      WHEN insufficient_privilege THEN
        -- Legacy custody workflows may read the same configuration while the synthetic gate is
        -- active. This fallback cannot work in a real operational entity without that gate.
        PERFORM abos.treasury_synthetic_authorize(
          p_bearer_token, p_legal_entity_id, 'treasury.read'
        );
    END;
  ELSE
    PERFORM abos.treasury_synthetic_authorize(p_bearer_token, p_legal_entity_id, 'treasury.read');
  END IF;
  CASE p_query
    WHEN 'LOCATIONS' THEN
      SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x) ORDER BY x.location_name), '[]'::jsonb)
        INTO result FROM (
          SELECT id, legal_entity_id, location_name, location_kind, status, responsible_cashier_user_account_id
            FROM abos.cash_locations WHERE legal_entity_id = p_legal_entity_id
              AND (p_object_id IS NULL OR id = p_object_id)) x;
    WHEN 'ACCOUNTS' THEN
      SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x) ORDER BY x.currency_code), '[]'::jsonb)
        INTO result FROM (
          SELECT id, legal_entity_id, cash_location_id, currency_code, ledger_account_id, activation_status,
                 reconciliation_evidence_reference_id, activated_by_user_account_id, activated_at
            FROM abos.cash_location_currency_accounts WHERE legal_entity_id = p_legal_entity_id
              AND (p_object_id IS NULL OR id = p_object_id OR cash_location_id = p_object_id)) x;
    WHEN 'ASSIGNMENTS' THEN
      SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x) ORDER BY x.assigned_at), '[]'::jsonb)
        INTO result FROM (
          SELECT id, legal_entity_id, cash_location_id, user_account_id,
                 assigned_by_user_account_id, assigned_at, revoked_at
            FROM abos.cash_location_cashier_assignments WHERE legal_entity_id = p_legal_entity_id
              AND (p_object_id IS NULL OR cash_location_id = p_object_id OR id = p_object_id)) x;
    WHEN 'OPENINGS' THEN
      SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x)), '[]'::jsonb)
        INTO result FROM (
          SELECT cash_location_currency_account_id, legal_entity_id, currency_code,
                 opening_counted_amount::text AS opening_counted_amount, physical_cash_count_id,
                 reconciliation_evidence_reference_id, reconciled_by_user_account_id,
                 approved_by_user_account_id, status
            FROM abos.cash_account_openings WHERE legal_entity_id = p_legal_entity_id
              AND (p_object_id IS NULL OR cash_location_currency_account_id = p_object_id)) x;
    WHEN 'COUNTS' THEN
      SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x) ORDER BY x.counted_at), '[]'::jsonb)
        INTO result FROM (
          SELECT id, legal_entity_id, cash_location_currency_account_id, currency_code,
                 counted_amount::text AS counted_amount, counted_at, counted_by_user_account_id,
                 evidence_reference_id, count_purpose, status,
                 confirmed_by_user_account_id, confirmed_at
            FROM abos.physical_cash_counts WHERE legal_entity_id = p_legal_entity_id
              AND (p_object_id IS NULL OR id = p_object_id)) x;
    WHEN 'SOURCES' THEN
      SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x) ORDER BY x.created_at DESC), '[]'::jsonb)
        INTO result FROM (
          SELECT source_row.id, source_row.legal_entity_id,
                 source_row.shareholder_business_party_id, party.display_name,
                 source_row.capital_agreement_id, agreement.agreement_reference,
                 source_row.capital_installment_id, installment.sequence_number,
                 source_row.amount::text AS amount, source_row.currency_code,
                 source_row.destination_cash_account_id, source_row.status,
                 source_row.treasury_cash_receipt_id, source_row.journal_id,
                 source_row.business_event_at, source_row.evidence_reference_id, source_row.created_at
            FROM abos.capital_receipt_intents source_row
            JOIN abos.business_parties party ON party.id=source_row.shareholder_business_party_id
              AND party.legal_entity_id=source_row.legal_entity_id
            JOIN abos.capital_agreements agreement ON agreement.id=source_row.capital_agreement_id
              AND agreement.legal_entity_id=source_row.legal_entity_id
            JOIN abos.capital_installments installment ON installment.id=source_row.capital_installment_id
              AND installment.legal_entity_id=source_row.legal_entity_id
           WHERE source_row.legal_entity_id = p_legal_entity_id
             AND (p_object_id IS NULL OR source_row.id = p_object_id)) x;
    WHEN 'RECEIPTS' THEN
      SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x) ORDER BY x.created_at DESC), '[]'::jsonb)
        INTO result FROM (
          SELECT receipt.id, receipt.legal_entity_id, receipt.capital_receipt_intent_id,
                 receipt.capital_installment_id, receipt.cash_location_currency_account_id,
                 account.cash_location_id, receipt.receipt_reference, receipt.amount::text AS amount,
                 receipt.currency_code, receipt.business_event_at, receipt.received_by_user_account_id,
                 receipt.physical_cash_count_id, receipt.evidence_reference_id,
                 receipt.submitted_for_verification_at, receipt.verified_by_user_account_id,
                 receipt.verified_at, receipt.void_reason, receipt.status, receipt.created_at
            FROM abos.cash_receipts receipt
            JOIN abos.cash_location_currency_accounts account
              ON account.id=receipt.cash_location_currency_account_id
             AND account.legal_entity_id=receipt.legal_entity_id
           WHERE receipt.legal_entity_id = p_legal_entity_id
             AND receipt.capital_receipt_intent_id IS NOT NULL
             AND (p_object_id IS NULL OR receipt.id = p_object_id)) x;
    WHEN 'HANDOFFS' THEN
      SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x) ORDER BY x.handed_off_at DESC), '[]'::jsonb)
        INTO result FROM (
          SELECT id, legal_entity_id, cash_receipt_id, capital_receipt_intent_id, handed_off_by_user_account_id,
                 handed_off_at, correlation_id, status
            FROM abos.treasury_finance_handoffs WHERE legal_entity_id = p_legal_entity_id
              AND (p_object_id IS NULL OR cash_receipt_id = p_object_id OR id = p_object_id)) x;
    WHEN 'CASH_LEDGER' THEN
      SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x)), '[]'::jsonb)
        INTO result FROM (
          SELECT id, account_currency_code FROM abos.ledger_accounts
           WHERE legal_entity_id=p_legal_entity_id AND control_account_type='CASH'
             AND status='ACTIVE' AND posting_allowed
             AND (p_object_id IS NULL OR id=p_object_id)) x;
    WHEN 'EVENTS' THEN
      SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x) ORDER BY x.occurred_at, x.id), '[]'::jsonb)
        INTO result FROM (
          SELECT event.id, event.aggregate_type, event.aggregate_id, event.operation,
                 event.from_status, event.to_status, event.actor_user_account_id,
                 actor.display_name, event.occurred_at
            FROM abos.treasury_events event
            JOIN abos.user_accounts actor ON actor.id=event.actor_user_account_id
           WHERE event.legal_entity_id=p_legal_entity_id) x;
    WHEN 'EVIDENCE' THEN
      SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x) ORDER BY x.evidence_kind, x.created_at), '[]'::jsonb)
        INTO result FROM (
          SELECT evidence.id, evidence.evidence_kind, evidence.document_id,
                 evidence.sha256, evidence.created_at, binding.capital_receipt_intent_id
            FROM abos.evidence_references evidence
            JOIN abos.treasury_evidence_bindings binding
              ON binding.evidence_reference_id=evidence.id
             AND binding.legal_entity_id=evidence.legal_entity_id
           WHERE evidence.legal_entity_id=p_legal_entity_id
             AND evidence.evidence_kind IN ('CASH_RECEIPT','PHYSICAL_CASH_COUNT')
             AND (p_object_id IS NULL OR evidence.id=p_object_id)) x;
    WHEN 'USERS' THEN
      SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x) ORDER BY x.display_name), '[]'::jsonb)
        INTO result FROM (
          SELECT DISTINCT account.id, account.display_name
            FROM abos.user_accounts account
            JOIN abos.user_permission_grants grant_row ON grant_row.user_account_id=account.id
           WHERE grant_row.legal_entity_id=p_legal_entity_id) x;
    WHEN 'FINANCE_PROGRESS' THEN
      SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x)), '[]'::jsonb)
        INTO result FROM (
          SELECT posting.status AS posting_intent_status,
                 coalesce(approval.decision, 'NONE') AS decision,
                 approval.approver_user_account_id AS decided_by_user_account_id,
                 approval.approved_at AS decided_at
            FROM abos.cash_receipts receipt
            LEFT JOIN abos.posting_intents posting
              ON posting.capital_receipt_intent_id=receipt.capital_receipt_intent_id
             AND posting.legal_entity_id=receipt.legal_entity_id
            LEFT JOIN abos.posting_approvals approval
              ON approval.posting_intent_id=posting.id AND approval.legal_entity_id=posting.legal_entity_id
           WHERE receipt.legal_entity_id=p_legal_entity_id AND receipt.id=p_object_id) x;
    ELSE
      RAISE EXCEPTION 'unsupported Treasury query';
  END CASE;
  RETURN result;
END
$query$;

-- The original safes/Saraf read function used treasury.read for every result. Split it by data
-- sensitivity: Saraf configuration and its choices require the explicit Saraf-management grant;
-- physical safe counts and evidence remain on the synthetic custody gate.
CREATE OR REPLACE FUNCTION abos.treasury_safes_saraf_query(
  p_bearer_token text,
  p_legal_entity_id uuid,
  p_query text,
  p_object_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $safes_query$
DECLARE result jsonb;
BEGIN
  IF p_query IN ('SARAF_LEDGER_CHOICES', 'SARAF_PARTIES', 'SARAF_ACCOUNTS') THEN
    BEGIN
      PERFORM abos.treasury_runtime_authorize(
        p_bearer_token, p_legal_entity_id, 'treasury.saraf-account.manage'
      );
    EXCEPTION
      WHEN insufficient_privilege THEN
        PERFORM abos.treasury_synthetic_authorize(
          p_bearer_token, p_legal_entity_id, 'treasury.read'
        );
    END;
  ELSIF p_query = 'CASH_LEDGER_CHOICES' THEN
    BEGIN
      PERFORM abos.treasury_runtime_authorize(
        p_bearer_token, p_legal_entity_id, 'treasury.cash-location.manage'
      );
    EXCEPTION
      WHEN insufficient_privilege THEN
        PERFORM abos.treasury_synthetic_authorize(
          p_bearer_token, p_legal_entity_id, 'treasury.read'
        );
    END;
  ELSE
    PERFORM abos.treasury_synthetic_authorize(
      p_bearer_token, p_legal_entity_id, 'treasury.read'
    );
  END IF;
  CASE p_query
    WHEN 'CASH_LEDGER_CHOICES' THEN
      SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x) ORDER BY x.account_code), '[]'::jsonb)
        INTO result FROM (
          SELECT la.id, la.account_code, la.account_name, la.account_currency_code
            FROM abos.ledger_accounts la
           WHERE la.legal_entity_id = p_legal_entity_id AND la.control_account_type = 'CASH'
             AND la.status = 'ACTIVE' AND la.posting_allowed AND la.account_currency_code IN ('USD', 'AFN')
             AND (p_object_id IS NULL OR la.id = p_object_id)) x;
    WHEN 'SARAF_LEDGER_CHOICES' THEN
      SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x) ORDER BY x.account_code), '[]'::jsonb)
        INTO result FROM (
          SELECT la.id, la.account_code, la.account_name, la.account_currency_code
            FROM abos.ledger_accounts la
           WHERE la.legal_entity_id = p_legal_entity_id AND la.control_account_type = 'SARAF'
             AND la.status = 'ACTIVE' AND la.posting_allowed AND la.account_currency_code IN ('USD', 'AFN')
             AND (p_object_id IS NULL OR la.id = p_object_id)) x;
    WHEN 'SARAF_PARTIES' THEN
      SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x) ORDER BY x.display_name), '[]'::jsonb)
        INTO result FROM (
          SELECT party.id, party.display_name, party.external_reference
            FROM abos.business_parties party
           WHERE party.legal_entity_id = p_legal_entity_id AND party.status = 'ACTIVE'
             AND EXISTS (SELECT 1 FROM abos.business_party_roles role
                          WHERE role.business_party_id = party.id AND role.role_code = 'SARAF'
                            AND role.effective_from <= current_date
                            AND (role.effective_to IS NULL OR role.effective_to >= current_date))
             AND (p_object_id IS NULL OR party.id = p_object_id)) x;
    WHEN 'SARAF_ACCOUNTS' THEN
      SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x) ORDER BY x.party_name, x.currency_code), '[]'::jsonb)
        INTO result FROM (
          SELECT account.id, account.legal_entity_id, account.business_party_id, party.display_name AS party_name,
                 account.currency_code, account.ledger_account_id, ledger.account_code, ledger.account_name,
                 account.status, account.created_by_user_account_id, creator.display_name AS created_by_name,
                 account.created_at, account.activated_by_user_account_id, activator.display_name AS activated_by_name,
                 account.activated_at, account.status_changed_by_user_account_id, account.status_changed_at
            FROM abos.saraf_accounts account
            JOIN abos.business_parties party ON party.id = account.business_party_id
             AND party.legal_entity_id = account.legal_entity_id
            JOIN abos.ledger_accounts ledger ON ledger.id = account.ledger_account_id
             AND ledger.legal_entity_id = account.legal_entity_id
            JOIN abos.user_accounts creator ON creator.id = account.created_by_user_account_id
            LEFT JOIN abos.user_accounts activator ON activator.id = account.activated_by_user_account_id
           WHERE account.legal_entity_id = p_legal_entity_id
             AND (p_object_id IS NULL OR account.id = p_object_id)) x;
    WHEN 'SAFE_COUNTS' THEN
      SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x) ORDER BY x.counted_at DESC, x.id), '[]'::jsonb)
        INTO result FROM (
          SELECT sc.id, sc.legal_entity_id, sc.cash_location_currency_account_id, account.cash_location_id,
                 sc.currency_code, sc.counted_amount::text AS counted_amount, sc.counted_at,
                 sc.counted_by_user_account_id, counter.display_name AS counted_by_name,
                 sc.evidence_reference_id, sc.note, sc.opening_amount::text AS opening_amount,
                 sc.verified_receipts_amount::text AS verified_receipts_amount, sc.verified_receipt_count,
                 sc.unverified_receipt_count, sc.custody_total::text AS custody_total,
                 sc.difference::text AS difference, sc.status, sc.confirmed_by_user_account_id,
                 confirmer.display_name AS confirmed_by_name, sc.confirmed_at
            FROM abos.cash_safe_counts sc
            JOIN abos.cash_location_currency_accounts account ON account.id = sc.cash_location_currency_account_id
             AND account.legal_entity_id = sc.legal_entity_id
            JOIN abos.user_accounts counter ON counter.id = sc.counted_by_user_account_id
            LEFT JOIN abos.user_accounts confirmer ON confirmer.id = sc.confirmed_by_user_account_id
           WHERE sc.legal_entity_id = p_legal_entity_id
             AND (p_object_id IS NULL OR sc.id = p_object_id OR sc.cash_location_currency_account_id = p_object_id)) x;
    WHEN 'COUNT_EVIDENCE' THEN
      SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x) ORDER BY x.evidence_kind, x.created_at), '[]'::jsonb)
        INTO result FROM (
          SELECT evidence.id, evidence.evidence_kind, evidence.document_id, evidence.evidence_version,
                 evidence.sha256, evidence.created_at,
                 (EXISTS (SELECT 1 FROM abos.physical_cash_counts c WHERE c.evidence_reference_id = evidence.id)
                  OR EXISTS (SELECT 1 FROM abos.cash_safe_counts s WHERE s.evidence_reference_id = evidence.id)
                  OR EXISTS (SELECT 1 FROM abos.cash_account_openings o
                              WHERE o.reconciliation_evidence_reference_id = evidence.id)) AS used
            FROM abos.evidence_references evidence
           WHERE evidence.legal_entity_id = p_legal_entity_id
             AND evidence.evidence_kind IN ('PHYSICAL_CASH_COUNT', 'OPENING_RECONCILIATION')
             AND NOT EXISTS (SELECT 1 FROM abos.treasury_evidence_bindings b
                              WHERE b.evidence_reference_id = evidence.id)
             AND (p_object_id IS NULL OR evidence.id = p_object_id)) x;
    ELSE
      RAISE EXCEPTION 'unsupported Treasury safes query';
  END CASE;
  RETURN result;
END
$safes_query$;
