-- V1 operational shareholder setup: shareholder master data and DRAFT capital agreements.
--
-- Permitted people (shareholder.setup.manage) create and correct shareholders, DRAFT capital
-- agreements, DRAFT installments and agreement-document references in the application, through
-- restricted entry points owned by a dedicated least-privilege owner. Nothing here receives money,
-- creates a Treasury, posting, journal or subledger row, or touches the synthetic E1 money path:
-- Capital Request -> Treasury -> Finance -> GL stays gated by assert_sandbox_mutation_authorized.
--
-- Also:
--  * a universal invariant: the non-cancelled installments of an agreement never plan more than
--    its committed capital (existing rows are checked first; the migration fails closed);
--  * one company-wide party reference namespace: business_parties.external_reference is unique per
--    legal entity, case-insensitively, after trimming; blank means no reference;
--  * the CAPITAL_AGREEMENT document is linked to the exact agreement it evidences
--    (capital_agreement_evidence); the application request path now requires that exact link.
-- No data is seeded.

-- ---------------------------------------------------------------------------
-- Preflight: refuse to install invariants that existing data already breaks.
-- ---------------------------------------------------------------------------
DO $preflight$
DECLARE
  over_planned integer;
  duplicate_references integer;
BEGIN
  SELECT count(*) INTO over_planned
    FROM abos.capital_agreements agreement
   WHERE (SELECT coalesce(sum(installment.expected_amount), 0)
            FROM abos.capital_installments installment
           WHERE installment.capital_agreement_id = agreement.id
             AND installment.status <> 'CANCELLED') > agreement.committed_amount;
  IF over_planned > 0 THEN
    RAISE EXCEPTION 'migration 0031 refused: % capital agreement(s) already plan installments above their committed capital', over_planned;
  END IF;
  SELECT count(*) INTO duplicate_references
    FROM (SELECT 1 FROM abos.business_parties party
           WHERE NULLIF(btrim(party.external_reference), '') IS NOT NULL
           GROUP BY party.legal_entity_id, lower(btrim(party.external_reference))
          HAVING count(*) > 1) duplicates;
  IF duplicate_references > 0 THEN
    RAISE EXCEPTION 'migration 0031 refused: % party reference(s) are used by more than one business party in a legal entity', duplicate_references;
  END IF;
END
$preflight$;

-- ---------------------------------------------------------------------------
-- Permission.
-- ---------------------------------------------------------------------------
INSERT INTO abos.permission_catalogue
  (permission_code, catalogue_version, category, availability,
   independence_enforced, administrative, sort_order)
VALUES
  ('shareholder.setup.manage', 8, 'SHAREHOLDER', 'ACTIVE', false, false, 520);

-- ---------------------------------------------------------------------------
-- One party reference namespace per legal entity (all business parties, every role).
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX business_parties_reference_normalized
  ON abos.business_parties (legal_entity_id, lower(btrim(external_reference)))
  WHERE NULLIF(btrim(external_reference), '') IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Agreement-specific CAPITAL_AGREEMENT document references (metadata and hash only).
-- ---------------------------------------------------------------------------
CREATE TABLE abos.capital_agreement_evidence (
  id uuid PRIMARY KEY,
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  capital_agreement_id uuid NOT NULL,
  evidence_reference_id uuid NOT NULL UNIQUE,
  version integer NOT NULL CHECK (version > 0),
  document_reference text NOT NULL CHECK (length(btrim(document_reference)) BETWEEN 1 AND 200),
  document_date date NOT NULL,
  recorded_by_user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (capital_agreement_id, version),
  FOREIGN KEY (capital_agreement_id, legal_entity_id)
    REFERENCES abos.capital_agreements(id, legal_entity_id),
  FOREIGN KEY (evidence_reference_id, legal_entity_id)
    REFERENCES abos.evidence_references(id, legal_entity_id)
);

CREATE FUNCTION abos.guard_capital_agreement_evidence()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM abos.evidence_references er
                  WHERE er.id = NEW.evidence_reference_id AND er.legal_entity_id = NEW.legal_entity_id
                    AND er.evidence_kind = 'CAPITAL_AGREEMENT') THEN
    RAISE EXCEPTION 'only a CAPITAL_AGREEMENT document of the same legal entity can evidence an agreement'
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.recorded_at := clock_timestamp();
  RETURN NEW;
END
$guard$;
CREATE TRIGGER capital_agreement_evidence_guard
BEFORE INSERT ON abos.capital_agreement_evidence
FOR EACH ROW EXECUTE FUNCTION abos.guard_capital_agreement_evidence();
CREATE TRIGGER capital_agreement_evidence_no_update_or_delete
BEFORE UPDATE OR DELETE ON abos.capital_agreement_evidence
FOR EACH ROW EXECUTE FUNCTION abos.prevent_audit_mutation();

-- ---------------------------------------------------------------------------
-- Universal invariant: planned (non-cancelled) installments <= committed capital.
-- Every write that can raise an agreement's plan (or lower its commitment) first updates the
-- agreement's plan-revision row. Under READ COMMITTED a concurrent writer waits for that row and then
-- re-reads the plan; under REPEATABLE READ or SERIALIZABLE a stale writer fails with 40001. So
-- concurrent inserts cannot jointly exceed the commitment at any isolation level.
-- ---------------------------------------------------------------------------
CREATE TABLE abos.capital_installment_plan_revisions (
  capital_agreement_id uuid PRIMARY KEY,
  legal_entity_id uuid NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  FOREIGN KEY (capital_agreement_id, legal_entity_id) REFERENCES abos.capital_agreements(id, legal_entity_id)
);

CREATE FUNCTION abos.guard_installment_commitment()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $guard$
DECLARE
  committed numeric;
  planned numeric;
BEGIN
  -- Changes that can only lower or keep the planned total need no check.
  IF TG_OP = 'UPDATE'
     AND NEW.capital_agreement_id = OLD.capital_agreement_id
     AND (NEW.status = 'CANCELLED'
          OR (OLD.status <> 'CANCELLED' AND NEW.expected_amount <= OLD.expected_amount)) THEN
    RETURN NEW;
  END IF;
  IF NEW.status = 'CANCELLED' THEN
    RETURN NEW;
  END IF;
  INSERT INTO abos.capital_installment_plan_revisions AS plan (capital_agreement_id, legal_entity_id)
  VALUES (NEW.capital_agreement_id, NEW.legal_entity_id)
  ON CONFLICT (capital_agreement_id) DO UPDATE SET revision = plan.revision + 1;
  SELECT agreement.committed_amount INTO committed FROM abos.capital_agreements agreement
   WHERE agreement.id = NEW.capital_agreement_id AND agreement.legal_entity_id = NEW.legal_entity_id;
  SELECT coalesce(sum(installment.expected_amount), 0) INTO planned
    FROM abos.capital_installments installment
   WHERE installment.capital_agreement_id = NEW.capital_agreement_id
     AND installment.status <> 'CANCELLED' AND installment.id <> NEW.id;
  IF planned + NEW.expected_amount > committed THEN
    RAISE EXCEPTION 'installments would plan % against a committed capital of %',
      planned + NEW.expected_amount, committed USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER capital_installments_commitment_invariant
BEFORE INSERT OR UPDATE OF expected_amount, status, capital_agreement_id ON abos.capital_installments
FOR EACH ROW EXECUTE FUNCTION abos.guard_installment_commitment();

CREATE FUNCTION abos.guard_agreement_planned_commitment()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $guard$
DECLARE planned numeric;
BEGIN
  IF NEW.committed_amount >= OLD.committed_amount THEN
    RETURN NEW;
  END IF;
  INSERT INTO abos.capital_installment_plan_revisions AS plan (capital_agreement_id, legal_entity_id)
  VALUES (NEW.id, NEW.legal_entity_id)
  ON CONFLICT (capital_agreement_id) DO UPDATE SET revision = plan.revision + 1;
  SELECT coalesce(sum(installment.expected_amount), 0) INTO planned
    FROM abos.capital_installments installment
   WHERE installment.capital_agreement_id = NEW.id AND installment.status <> 'CANCELLED';
  IF planned > NEW.committed_amount THEN
    RAISE EXCEPTION 'the committed capital cannot be reduced below the % already planned in installments', planned
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER capital_agreements_planned_commitment_guard
BEFORE UPDATE OF committed_amount ON abos.capital_agreements
FOR EACH ROW EXECUTE FUNCTION abos.guard_agreement_planned_commitment();

-- ---------------------------------------------------------------------------
-- Dedicated least-privilege owner.
-- ---------------------------------------------------------------------------
DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'abos_v1_shareholder_setup_owner') THEN
    CREATE ROLE abos_v1_shareholder_setup_owner
      NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
  ELSE
    ALTER ROLE abos_v1_shareholder_setup_owner
      NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
  END IF;
END
$role$;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA abos FROM abos_v1_shareholder_setup_owner;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA abos FROM abos_v1_shareholder_setup_owner;
REVOKE ALL PRIVILEGES ON SCHEMA abos FROM abos_v1_shareholder_setup_owner;
REVOKE abos_v1_shareholder_setup_owner FROM abos_v1_identity_runtime;
REVOKE abos_v1_shareholder_setup_owner FROM abos_e1_runtime;
REVOKE abos_v1_shareholder_setup_owner FROM abos_e1_treasury_runtime;
DO $guard$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members membership
      JOIN pg_catalog.pg_roles granted_role ON granted_role.oid = membership.roleid
      JOIN pg_catalog.pg_roles member_role ON member_role.oid = membership.member
     WHERE granted_role.rolname = 'abos_v1_shareholder_setup_owner'
        OR member_role.rolname = 'abos_v1_shareholder_setup_owner'
  ) THEN
    RAISE EXCEPTION 'abos_v1_shareholder_setup_owner must not have role memberships';
  END IF;
END
$guard$;

-- The usage row is locked (never changed) when a commitment changes; the lock needs a column grant.
CREATE FUNCTION abos.forbid_shareholder_setup_owner_update()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $guard$
BEGIN
  IF current_user = 'abos_v1_shareholder_setup_owner' THEN
    RAISE EXCEPTION '% may lock but not change %', current_user, TG_TABLE_NAME
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER capital_agreement_commitment_usage_setup_owner_lock_only
BEFORE UPDATE ON abos.capital_agreement_commitment_usage
FOR EACH ROW EXECUTE FUNCTION abos.forbid_shareholder_setup_owner_update();

GRANT USAGE ON SCHEMA abos TO abos_v1_shareholder_setup_owner;
GRANT EXECUTE ON FUNCTION abos.identity_actor_context(text, text, text) TO abos_v1_shareholder_setup_owner;
-- Reads: master data, the read model and the posted-provenance guard's join path.
GRANT SELECT (id, name, base_currency_code) ON abos.legal_entities TO abos_v1_shareholder_setup_owner;
GRANT SELECT (code, enabled) ON abos.currencies TO abos_v1_shareholder_setup_owner;
GRANT SELECT (id, display_name) ON abos.user_accounts TO abos_v1_shareholder_setup_owner;
GRANT SELECT (id, legal_entity_id, display_name, external_reference, status, created_at)
  ON abos.business_parties TO abos_v1_shareholder_setup_owner;
GRANT SELECT (business_party_id, role_code, effective_from, effective_to)
  ON abos.business_party_roles TO abos_v1_shareholder_setup_owner;
GRANT SELECT (id, legal_entity_id, business_party_id, status, created_at)
  ON abos.shareholder_profiles TO abos_v1_shareholder_setup_owner;
GRANT SELECT (id, legal_entity_id, shareholder_profile_id, agreement_reference, agreement_kind, committed_amount,
  currency_code, effective_on, status, partial_installments_allowed, created_by_user_account_id, created_at)
  ON abos.capital_agreements TO abos_v1_shareholder_setup_owner;
GRANT SELECT (id, legal_entity_id, capital_agreement_id, sequence_number, expected_amount, currency_code, due_on,
  status, created_by_user_account_id, created_at)
  ON abos.capital_installments TO abos_v1_shareholder_setup_owner;
GRANT SELECT (capital_agreement_id, legal_entity_id, consumed_amount)
  ON abos.capital_agreement_commitment_usage TO abos_v1_shareholder_setup_owner;
GRANT SELECT (id, legal_entity_id, document_id, evidence_kind, evidence_version, sha256, completed_at)
  ON abos.evidence_references TO abos_v1_shareholder_setup_owner;
GRANT SELECT ON abos.capital_agreement_evidence TO abos_v1_shareholder_setup_owner;
GRANT SELECT (capital_agreement_id, revision) ON abos.capital_installment_plan_revisions TO abos_v1_shareholder_setup_owner;
GRANT SELECT (capital_agreement_id, legal_entity_id, evidence_reference_id, status)
  ON abos.registration_evidence TO abos_v1_shareholder_setup_owner;
GRANT SELECT (legal_entity_id) ON abos.capital_agreement_funding_policies TO abos_v1_shareholder_setup_owner;
GRANT SELECT (id, legal_entity_id, capital_agreement_id, capital_installment_id, amount, currency_code, status)
  ON abos.capital_receipt_intents TO abos_v1_shareholder_setup_owner;
GRANT SELECT (id, capital_installment_id) ON abos.cash_receipts TO abos_v1_shareholder_setup_owner;
GRANT SELECT (id, legal_entity_id, treasury_cash_receipt_id, capital_receipt_intent_id, intent_kind, original_amount)
  ON abos.posting_intents TO abos_v1_shareholder_setup_owner;
GRANT SELECT (id, posting_intent_id, status) ON abos.journals TO abos_v1_shareholder_setup_owner;
GRANT SELECT (original_journal_id, reversal_journal_id) ON abos.journal_reversal_links TO abos_v1_shareholder_setup_owner;
GRANT SELECT (scope, idempotency_key, request_fingerprint, status, response_snapshot)
  ON abos.idempotency_records TO abos_v1_shareholder_setup_owner;
-- Writes: column-level inserts for the setup records, and only the columns the correction
-- commands change. No DELETE, TRUNCATE, TRIGGER or REFERENCES anywhere.
GRANT INSERT (id, legal_entity_id, display_name, external_reference, status)
  ON abos.business_parties TO abos_v1_shareholder_setup_owner;
GRANT UPDATE (display_name, external_reference) ON abos.business_parties TO abos_v1_shareholder_setup_owner;
GRANT INSERT (business_party_id, role_code, effective_from) ON abos.business_party_roles TO abos_v1_shareholder_setup_owner;
GRANT INSERT (id, legal_entity_id, business_party_id, status) ON abos.shareholder_profiles TO abos_v1_shareholder_setup_owner;
GRANT INSERT (id, legal_entity_id, shareholder_profile_id, agreement_reference, agreement_kind, committed_amount,
  currency_code, effective_on, status, partial_installments_allowed, created_by_user_account_id)
  ON abos.capital_agreements TO abos_v1_shareholder_setup_owner;
GRANT UPDATE (agreement_reference, committed_amount, currency_code, effective_on, partial_installments_allowed)
  ON abos.capital_agreements TO abos_v1_shareholder_setup_owner;
GRANT INSERT (id, legal_entity_id, capital_agreement_id, sequence_number, expected_amount, currency_code, due_on,
  status, created_by_user_account_id)
  ON abos.capital_installments TO abos_v1_shareholder_setup_owner;
GRANT UPDATE (expected_amount, due_on, status) ON abos.capital_installments TO abos_v1_shareholder_setup_owner;
GRANT INSERT (capital_agreement_id, legal_entity_id, consumed_amount)
  ON abos.capital_agreement_commitment_usage TO abos_v1_shareholder_setup_owner;
GRANT UPDATE (capital_agreement_id) ON abos.capital_agreement_commitment_usage TO abos_v1_shareholder_setup_owner;
GRANT INSERT (capital_agreement_id, legal_entity_id) ON abos.capital_installment_plan_revisions TO abos_v1_shareholder_setup_owner;
GRANT UPDATE (revision) ON abos.capital_installment_plan_revisions TO abos_v1_shareholder_setup_owner;
GRANT INSERT (id, legal_entity_id, document_id, evidence_kind, evidence_version, sha256, completed_at)
  ON abos.evidence_references TO abos_v1_shareholder_setup_owner;
GRANT INSERT (id, legal_entity_id, capital_agreement_id, evidence_reference_id, version, document_reference,
  document_date, recorded_by_user_account_id)
  ON abos.capital_agreement_evidence TO abos_v1_shareholder_setup_owner;
GRANT INSERT (scope, idempotency_key, request_fingerprint, correlation_id, status)
  ON abos.idempotency_records TO abos_v1_shareholder_setup_owner;
GRANT UPDATE (status, resource_type, resource_id, response_code, response_snapshot, completed_at)
  ON abos.idempotency_records TO abos_v1_shareholder_setup_owner;
GRANT INSERT (id, actor_user_account_id, legal_entity_id, correlation_id, action, entity_type, entity_id,
  before_state, after_state, metadata)
  ON abos.audit_records TO abos_v1_shareholder_setup_owner;

-- ---------------------------------------------------------------------------
-- Internal helpers (executable by the owner only).
-- ---------------------------------------------------------------------------
CREATE FUNCTION abos.shareholder_setup_actor(
  p_identity_proof text, p_runtime_token_sha256 text, p_token_sha256 text, p_any_of text[]
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $actor$
DECLARE v_context jsonb;
BEGIN
  v_context := abos.identity_actor_context(p_identity_proof, p_runtime_token_sha256, p_token_sha256);
  IF v_context IS NULL
     OR COALESCE((v_context ->> 'live')::boolean, false) IS NOT TRUE
     OR v_context ->> 'status' IS DISTINCT FROM 'ACTIVE'
     OR COALESCE((v_context ->> 'mustChangePassword')::boolean, false) IS TRUE THEN
    RAISE EXCEPTION 'sign in with an active account to continue' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT COALESCE(v_context -> 'permissions', '[]'::jsonb) ?| p_any_of THEN
    RAISE EXCEPTION 'current authority is missing %', array_to_string(p_any_of, ' or ')
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN v_context;
END
$actor$;

-- A plain positive decimal string (the contracts' pattern); never NaN, Infinity or exponents.
CREATE FUNCTION abos.shareholder_setup_amount(p_text text)
RETURNS numeric LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $amount$
BEGIN
  IF p_text IS NULL OR length(p_text) > 40 OR p_text !~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$' OR p_text !~ '[1-9]' THEN
    RAISE EXCEPTION 'amounts must be plain positive decimals' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN p_text::numeric;
END
$amount$;

-- Returns the recorded response for an identical replay, NULL for a new request; refuses conflicts.
CREATE FUNCTION abos.shareholder_setup_idempotency_begin(
  p_scope text, p_key text, p_fingerprint text, p_correlation_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $begin$
DECLARE
  v_fingerprint text;
  v_status text;
  v_response jsonb;
BEGIN
  IF p_key IS NULL OR length(p_key) NOT BETWEEN 8 AND 200 OR p_correlation_id IS NULL THEN
    RAISE EXCEPTION 'a request key (8-200 characters) and correlation id are required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_scope || ':' || p_key, 0));
  SELECT record.request_fingerprint, record.status, record.response_snapshot
    INTO v_fingerprint, v_status, v_response
    FROM abos.idempotency_records record
   WHERE record.scope = p_scope AND record.idempotency_key = p_key;
  IF FOUND THEN
    IF v_fingerprint <> p_fingerprint THEN
      RAISE EXCEPTION 'this request key was already used for different details' USING ERRCODE = 'unique_violation';
    END IF;
    IF v_status = 'COMPLETED' THEN
      RETURN v_response || pg_catalog.jsonb_build_object('replayed', true);
    END IF;
    RAISE EXCEPTION 'this request is still in progress' USING ERRCODE = 'serialization_failure';
  END IF;
  INSERT INTO abos.idempotency_records (scope, idempotency_key, request_fingerprint, correlation_id, status)
  VALUES (p_scope, p_key, p_fingerprint, p_correlation_id, 'IN_PROGRESS');
  RETURN NULL;
END
$begin$;

CREATE FUNCTION abos.shareholder_setup_idempotency_complete(
  p_scope text, p_key text, p_resource_type text, p_resource_id uuid, p_response jsonb
) RETURNS void
LANGUAGE sql
SET search_path = pg_catalog, pg_temp
AS $complete$
  UPDATE abos.idempotency_records
     SET status = 'COMPLETED', resource_type = p_resource_type, resource_id = p_resource_id,
         response_code = 200, response_snapshot = p_response, completed_at = pg_catalog.clock_timestamp()
   WHERE scope = p_scope AND idempotency_key = p_key
$complete$;

-- Genuinely POSTED, non-reversed capital for one agreement; each posting intent counted once.
CREATE FUNCTION abos.shareholder_setup_received(p_agreement_id uuid, p_entity_id uuid)
RETURNS numeric LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $received$
  SELECT coalesce(sum(intent.original_amount), 0)
    FROM abos.posting_intents intent
    JOIN abos.capital_receipt_intents request
      ON request.id = intent.capital_receipt_intent_id AND request.legal_entity_id = intent.legal_entity_id
   WHERE request.capital_agreement_id = p_agreement_id AND request.legal_entity_id = p_entity_id
     AND intent.intent_kind = 'SHAREHOLDER_CAPITAL_RECEIPT'
     AND EXISTS (
       SELECT 1 FROM abos.journals journal
        WHERE journal.posting_intent_id = intent.id AND journal.status = 'POSTED'
          AND NOT EXISTS (
            SELECT 1 FROM abos.journal_reversal_links link
              JOIN abos.journals reversal ON reversal.id = link.reversal_journal_id AND reversal.status = 'POSTED'
             WHERE link.original_journal_id = journal.id))
$received$;

-- Any posted capital activity for a shareholder (the corrections are refused from then on).
CREATE FUNCTION abos.shareholder_setup_has_posted_capital(p_profile_id uuid, p_entity_id uuid)
RETURNS boolean LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $posted$
  SELECT EXISTS (
    SELECT 1 FROM abos.capital_agreements agreement
     WHERE agreement.shareholder_profile_id = p_profile_id AND agreement.legal_entity_id = p_entity_id
       AND (abos.shareholder_setup_received(agreement.id, p_entity_id) > 0
            OR EXISTS (
              SELECT 1 FROM abos.capital_installments installment
                JOIN abos.cash_receipts receipt ON receipt.capital_installment_id = installment.id
                JOIN abos.posting_intents intent ON intent.treasury_cash_receipt_id = receipt.id
                JOIN abos.journals journal ON journal.posting_intent_id = intent.id AND journal.status = 'POSTED'
               WHERE installment.capital_agreement_id = agreement.id)))
$posted$;

CREATE FUNCTION abos.shareholder_setup_audit(
  p_actor uuid, p_entity uuid, p_correlation uuid, p_action text, p_entity_type text, p_entity_id uuid,
  p_before jsonb, p_after jsonb
) RETURNS void
LANGUAGE sql
SET search_path = pg_catalog, pg_temp
AS $audit$
  INSERT INTO abos.audit_records
    (id, actor_user_account_id, legal_entity_id, correlation_id, action, entity_type, entity_id,
     before_state, after_state, metadata)
  VALUES (pg_catalog.gen_random_uuid(), p_actor, p_entity, coalesce(p_correlation, pg_catalog.gen_random_uuid()),
          p_action, p_entity_type, p_entity_id, p_before, p_after,
          pg_catalog.jsonb_build_object('source', 'v1-shareholder-setup'))
$audit$;

-- ---------------------------------------------------------------------------
-- Restricted entry points.
-- ---------------------------------------------------------------------------
CREATE FUNCTION abos.shareholder_setup_create_shareholder(
  p_identity_proof text, p_runtime_token_sha256 text, p_token_sha256 text, p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $create_shareholder$
DECLARE
  v_context jsonb;
  v_actor uuid;
  v_entity uuid;
  v_name text;
  v_reference text;
  v_since date;
  v_key text;
  v_correlation uuid;
  v_scope text;
  v_replay jsonb;
  v_party uuid := pg_catalog.gen_random_uuid();
  v_profile uuid := pg_catalog.gen_random_uuid();
  v_response jsonb;
BEGIN
  v_context := abos.shareholder_setup_actor(p_identity_proof, p_runtime_token_sha256, p_token_sha256,
    ARRAY['shareholder.setup.manage']);
  v_actor := (v_context ->> 'userAccountId')::uuid;
  v_entity := (v_context ->> 'legalEntityId')::uuid;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' OR EXISTS (
       SELECT 1 FROM jsonb_object_keys(p_payload) k
        WHERE k NOT IN ('displayName', 'externalReference', 'shareholderSince', 'correlationId', 'idempotencyKey')) THEN
    RAISE EXCEPTION 'unknown or missing shareholder fields' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_name := NULLIF(btrim(p_payload ->> 'displayName'), '');
  v_reference := NULLIF(btrim(p_payload ->> 'externalReference'), '');
  v_since := NULLIF(p_payload ->> 'shareholderSince', '')::date;
  v_key := NULLIF(btrim(p_payload ->> 'idempotencyKey'), '');
  v_correlation := NULLIF(p_payload ->> 'correlationId', '')::uuid;
  IF v_name IS NULL OR length(v_name) NOT BETWEEN 2 AND 160
     OR (v_reference IS NOT NULL AND length(v_reference) > 60) OR v_since IS NULL THEN
    RAISE EXCEPTION 'a name (2-160 characters), a reference of at most 60 characters and a shareholder-since date are required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_since > current_date THEN
    RAISE EXCEPTION 'the shareholder-since date cannot be in the future' USING ERRCODE = 'check_violation';
  END IF;
  v_scope := v_entity::text || ':SHAREHOLDER_SETUP_CREATE_SHAREHOLDER';
  v_replay := abos.shareholder_setup_idempotency_begin(v_scope, v_key,
    encode(sha256(convert_to(jsonb_build_object('actor', v_actor, 'name', v_name, 'reference', v_reference,
      'since', v_since)::text, 'UTF8')), 'hex'), v_correlation);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  IF v_reference IS NOT NULL AND EXISTS (
    SELECT 1 FROM abos.business_parties party
     WHERE party.legal_entity_id = v_entity AND lower(btrim(party.external_reference)) = lower(v_reference)) THEN
    RAISE EXCEPTION 'reference % is already used by another business party', v_reference USING ERRCODE = 'unique_violation';
  END IF;

  INSERT INTO abos.business_parties (id, legal_entity_id, display_name, external_reference, status)
  VALUES (v_party, v_entity, v_name, v_reference, 'ACTIVE');
  INSERT INTO abos.business_party_roles (business_party_id, role_code, effective_from)
  VALUES (v_party, 'SHAREHOLDER', v_since);
  INSERT INTO abos.shareholder_profiles (id, legal_entity_id, business_party_id, status)
  VALUES (v_profile, v_entity, v_party, 'ACTIVE');
  v_response := jsonb_build_object('shareholderProfileId', v_profile, 'businessPartyId', v_party, 'replayed', false);
  PERFORM abos.shareholder_setup_audit(v_actor, v_entity, v_correlation, 'SHAREHOLDER_CREATED', 'SHAREHOLDER', v_profile,
    NULL, jsonb_build_object('name', v_name, 'reference', v_reference, 'since', v_since));
  PERFORM abos.shareholder_setup_idempotency_complete(v_scope, v_key, 'SHAREHOLDER_PROFILE', v_profile, v_response);
  RETURN v_response;
END
$create_shareholder$;

CREATE FUNCTION abos.shareholder_setup_correct_shareholder(
  p_identity_proof text, p_runtime_token_sha256 text, p_token_sha256 text, p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $correct_shareholder$
DECLARE
  v_context jsonb;
  v_actor uuid;
  v_entity uuid;
  v_profile uuid;
  v_name text;
  v_reference text;
  v_party uuid;
  v_before jsonb;
BEGIN
  v_context := abos.shareholder_setup_actor(p_identity_proof, p_runtime_token_sha256, p_token_sha256,
    ARRAY['shareholder.setup.manage']);
  v_actor := (v_context ->> 'userAccountId')::uuid;
  v_entity := (v_context ->> 'legalEntityId')::uuid;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' OR EXISTS (
       SELECT 1 FROM jsonb_object_keys(p_payload) k
        WHERE k NOT IN ('shareholderProfileId', 'displayName', 'externalReference')) THEN
    RAISE EXCEPTION 'unknown or missing shareholder fields' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_profile := NULLIF(p_payload ->> 'shareholderProfileId', '')::uuid;
  v_name := NULLIF(btrim(p_payload ->> 'displayName'), '');
  v_reference := NULLIF(btrim(p_payload ->> 'externalReference'), '');
  IF v_profile IS NULL OR v_name IS NULL OR length(v_name) NOT BETWEEN 2 AND 160
     OR (v_reference IS NOT NULL AND length(v_reference) > 60) THEN
    RAISE EXCEPTION 'a shareholder, a name (2-160 characters) and a reference of at most 60 characters are required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT profile.business_party_id INTO v_party FROM abos.shareholder_profiles profile
   WHERE profile.id = v_profile AND profile.legal_entity_id = v_entity;
  IF v_party IS NULL THEN
    RAISE EXCEPTION 'shareholder not found in this legal entity' USING ERRCODE = 'no_data_found';
  END IF;
  PERFORM 1 FROM abos.business_parties party WHERE party.id = v_party FOR UPDATE;
  IF abos.shareholder_setup_has_posted_capital(v_profile, v_entity) THEN
    RAISE EXCEPTION 'this shareholder already has posted capital; their details can no longer be corrected here'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_reference IS NOT NULL AND EXISTS (
    SELECT 1 FROM abos.business_parties party
     WHERE party.legal_entity_id = v_entity AND party.id <> v_party
       AND lower(btrim(party.external_reference)) = lower(v_reference)) THEN
    RAISE EXCEPTION 'reference % is already used by another business party', v_reference USING ERRCODE = 'unique_violation';
  END IF;
  SELECT jsonb_build_object('name', party.display_name, 'reference', party.external_reference) INTO v_before
    FROM abos.business_parties party WHERE party.id = v_party;
  UPDATE abos.business_parties SET display_name = v_name, external_reference = v_reference WHERE id = v_party;
  PERFORM abos.shareholder_setup_audit(v_actor, v_entity, NULL, 'SHAREHOLDER_CORRECTED', 'SHAREHOLDER', v_profile,
    v_before, jsonb_build_object('name', v_name, 'reference', v_reference));
  RETURN jsonb_build_object('shareholderProfileId', v_profile, 'changed', true);
END
$correct_shareholder$;

CREATE FUNCTION abos.shareholder_setup_create_agreement(
  p_identity_proof text, p_runtime_token_sha256 text, p_token_sha256 text, p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $create_agreement$
DECLARE
  v_context jsonb;
  v_actor uuid;
  v_entity uuid;
  v_profile uuid;
  v_reference text;
  v_amount numeric;
  v_currency text;
  v_effective date;
  v_partial boolean;
  v_key text;
  v_correlation uuid;
  v_scope text;
  v_replay jsonb;
  v_agreement uuid := pg_catalog.gen_random_uuid();
  v_response jsonb;
BEGIN
  v_context := abos.shareholder_setup_actor(p_identity_proof, p_runtime_token_sha256, p_token_sha256,
    ARRAY['shareholder.setup.manage']);
  v_actor := (v_context ->> 'userAccountId')::uuid;
  v_entity := (v_context ->> 'legalEntityId')::uuid;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' OR EXISTS (
       SELECT 1 FROM jsonb_object_keys(p_payload) k
        WHERE k NOT IN ('shareholderProfileId', 'agreementReference', 'committedAmount', 'currencyCode', 'effectiveOn',
                        'partialInstallmentsAllowed', 'correlationId', 'idempotencyKey')) THEN
    RAISE EXCEPTION 'unknown or missing agreement fields' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_profile := NULLIF(p_payload ->> 'shareholderProfileId', '')::uuid;
  v_reference := NULLIF(btrim(p_payload ->> 'agreementReference'), '');
  v_amount := abos.shareholder_setup_amount(p_payload ->> 'committedAmount');
  v_currency := upper(NULLIF(btrim(p_payload ->> 'currencyCode'), ''));
  v_effective := NULLIF(p_payload ->> 'effectiveOn', '')::date;
  v_partial := COALESCE((p_payload ->> 'partialInstallmentsAllowed')::boolean, false);
  v_key := NULLIF(btrim(p_payload ->> 'idempotencyKey'), '');
  v_correlation := NULLIF(p_payload ->> 'correlationId', '')::uuid;
  IF v_profile IS NULL OR v_reference IS NULL OR length(v_reference) > 60 OR v_currency IS NULL OR v_effective IS NULL THEN
    RAISE EXCEPTION 'a shareholder, an agreement reference (at most 60 characters), a currency and an effective date are required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_scope := v_entity::text || ':SHAREHOLDER_SETUP_CREATE_AGREEMENT';
  v_replay := abos.shareholder_setup_idempotency_begin(v_scope, v_key,
    encode(sha256(convert_to(jsonb_build_object('actor', v_actor, 'profile', v_profile, 'reference', v_reference,
      'amount', v_amount::text, 'currency', v_currency, 'effective', v_effective, 'partial', v_partial)::text, 'UTF8')), 'hex'), v_correlation);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  IF NOT EXISTS (SELECT 1 FROM abos.shareholder_profiles profile
                  WHERE profile.id = v_profile AND profile.legal_entity_id = v_entity AND profile.status = 'ACTIVE') THEN
    RAISE EXCEPTION 'the shareholder is not an active shareholder of this legal entity' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM abos.currencies currency WHERE currency.code = v_currency AND currency.enabled) THEN
    RAISE EXCEPTION 'currency % is not enabled', v_currency USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO abos.capital_agreements
    (id, legal_entity_id, shareholder_profile_id, agreement_reference, agreement_kind, committed_amount, currency_code,
     effective_on, status, partial_installments_allowed, created_by_user_account_id)
  VALUES (v_agreement, v_entity, v_profile, v_reference, 'CAPITAL_CONTRIBUTION', v_amount, v_currency,
          v_effective, 'DRAFT', v_partial, v_actor);
  v_response := jsonb_build_object('capitalAgreementId', v_agreement, 'replayed', false);
  PERFORM abos.shareholder_setup_audit(v_actor, v_entity, v_correlation, 'CAPITAL_AGREEMENT_DRAFTED', 'CAPITAL_AGREEMENT',
    v_agreement, NULL, jsonb_build_object('shareholderProfileId', v_profile, 'reference', v_reference,
      'committedAmount', v_amount::text, 'currency', v_currency, 'effectiveOn', v_effective, 'partialAllowed', v_partial));
  PERFORM abos.shareholder_setup_idempotency_complete(v_scope, v_key, 'CAPITAL_AGREEMENT', v_agreement, v_response);
  RETURN v_response;
END
$create_agreement$;

CREATE FUNCTION abos.shareholder_setup_update_agreement(
  p_identity_proof text, p_runtime_token_sha256 text, p_token_sha256 text, p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $update_agreement$
DECLARE
  v_context jsonb;
  v_actor uuid;
  v_entity uuid;
  v_agreement uuid;
  v_reference text;
  v_amount numeric;
  v_currency text;
  v_effective date;
  v_partial boolean;
  v_row record;
BEGIN
  v_context := abos.shareholder_setup_actor(p_identity_proof, p_runtime_token_sha256, p_token_sha256,
    ARRAY['shareholder.setup.manage']);
  v_actor := (v_context ->> 'userAccountId')::uuid;
  v_entity := (v_context ->> 'legalEntityId')::uuid;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' OR EXISTS (
       SELECT 1 FROM jsonb_object_keys(p_payload) k
        WHERE k NOT IN ('capitalAgreementId', 'agreementReference', 'committedAmount', 'currencyCode', 'effectiveOn',
                        'partialInstallmentsAllowed')) THEN
    RAISE EXCEPTION 'unknown or missing agreement fields' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_agreement := NULLIF(p_payload ->> 'capitalAgreementId', '')::uuid;
  v_reference := NULLIF(btrim(p_payload ->> 'agreementReference'), '');
  v_amount := abos.shareholder_setup_amount(p_payload ->> 'committedAmount');
  v_currency := upper(NULLIF(btrim(p_payload ->> 'currencyCode'), ''));
  v_effective := NULLIF(p_payload ->> 'effectiveOn', '')::date;
  v_partial := COALESCE((p_payload ->> 'partialInstallmentsAllowed')::boolean, false);
  IF v_agreement IS NULL OR v_reference IS NULL OR length(v_reference) > 60 OR v_currency IS NULL OR v_effective IS NULL THEN
    RAISE EXCEPTION 'an agreement, a reference (at most 60 characters), a currency and an effective date are required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT agreement.status, agreement.agreement_reference, agreement.committed_amount, agreement.currency_code,
         agreement.effective_on, agreement.partial_installments_allowed
    INTO v_row
    FROM abos.capital_agreements agreement
   WHERE agreement.id = v_agreement AND agreement.legal_entity_id = v_entity
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'capital agreement not found in this legal entity' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_row.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'only a DRAFT capital agreement can be edited here' USING ERRCODE = 'check_violation';
  END IF;
  IF v_currency <> v_row.currency_code THEN
    IF EXISTS (SELECT 1 FROM abos.capital_installments installment WHERE installment.capital_agreement_id = v_agreement) THEN
      RAISE EXCEPTION 'the currency cannot change once installments exist' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM abos.currencies currency WHERE currency.code = v_currency AND currency.enabled) THEN
      RAISE EXCEPTION 'currency % is not enabled', v_currency USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  UPDATE abos.capital_agreements
     SET agreement_reference = v_reference, committed_amount = v_amount, currency_code = v_currency,
         effective_on = v_effective, partial_installments_allowed = v_partial
   WHERE id = v_agreement;
  PERFORM abos.shareholder_setup_audit(v_actor, v_entity, NULL, 'CAPITAL_AGREEMENT_DRAFT_EDITED', 'CAPITAL_AGREEMENT',
    v_agreement,
    jsonb_build_object('reference', v_row.agreement_reference, 'committedAmount', v_row.committed_amount::text,
      'currency', v_row.currency_code, 'effectiveOn', v_row.effective_on, 'partialAllowed', v_row.partial_installments_allowed),
    jsonb_build_object('reference', v_reference, 'committedAmount', v_amount::text, 'currency', v_currency,
      'effectiveOn', v_effective, 'partialAllowed', v_partial));
  RETURN jsonb_build_object('capitalAgreementId', v_agreement, 'changed', true);
END
$update_agreement$;

CREATE FUNCTION abos.shareholder_setup_add_installment(
  p_identity_proof text, p_runtime_token_sha256 text, p_token_sha256 text, p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $add_installment$
DECLARE
  v_context jsonb;
  v_actor uuid;
  v_entity uuid;
  v_agreement uuid;
  v_sequence integer;
  v_amount numeric;
  v_due date;
  v_key text;
  v_correlation uuid;
  v_scope text;
  v_replay jsonb;
  v_currency text;
  v_status text;
  v_installment uuid := pg_catalog.gen_random_uuid();
  v_response jsonb;
BEGIN
  v_context := abos.shareholder_setup_actor(p_identity_proof, p_runtime_token_sha256, p_token_sha256,
    ARRAY['shareholder.setup.manage']);
  v_actor := (v_context ->> 'userAccountId')::uuid;
  v_entity := (v_context ->> 'legalEntityId')::uuid;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' OR EXISTS (
       SELECT 1 FROM jsonb_object_keys(p_payload) k
        WHERE k NOT IN ('capitalAgreementId', 'sequenceNumber', 'expectedAmount', 'dueOn', 'correlationId', 'idempotencyKey')) THEN
    RAISE EXCEPTION 'unknown or missing installment fields' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_agreement := NULLIF(p_payload ->> 'capitalAgreementId', '')::uuid;
  v_sequence := NULLIF(p_payload ->> 'sequenceNumber', '')::integer;
  v_amount := abos.shareholder_setup_amount(p_payload ->> 'expectedAmount');
  v_due := NULLIF(p_payload ->> 'dueOn', '')::date;
  v_key := NULLIF(btrim(p_payload ->> 'idempotencyKey'), '');
  v_correlation := NULLIF(p_payload ->> 'correlationId', '')::uuid;
  IF v_agreement IS NULL OR (v_sequence IS NOT NULL AND v_sequence < 1) THEN
    RAISE EXCEPTION 'an agreement and a positive sequence number are required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_scope := v_entity::text || ':SHAREHOLDER_SETUP_ADD_INSTALLMENT';
  v_replay := abos.shareholder_setup_idempotency_begin(v_scope, v_key,
    encode(sha256(convert_to(jsonb_build_object('actor', v_actor, 'agreement', v_agreement, 'sequence', v_sequence,
      'amount', v_amount::text, 'due', v_due)::text, 'UTF8')), 'hex'), v_correlation);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  SELECT agreement.currency_code, agreement.status INTO v_currency, v_status
    FROM abos.capital_agreements agreement
   WHERE agreement.id = v_agreement AND agreement.legal_entity_id = v_entity;
  IF v_currency IS NULL THEN
    RAISE EXCEPTION 'capital agreement not found in this legal entity' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'installments can be planned here only while the agreement is DRAFT' USING ERRCODE = 'check_violation';
  END IF;
  IF v_sequence IS NULL THEN
    SELECT coalesce(max(installment.sequence_number), 0) + 1 INTO v_sequence
      FROM abos.capital_installments installment WHERE installment.capital_agreement_id = v_agreement;
  END IF;
  -- The currency always comes from the agreement, never from the request.
  INSERT INTO abos.capital_installments
    (id, legal_entity_id, capital_agreement_id, sequence_number, expected_amount, currency_code, due_on, status,
     created_by_user_account_id)
  VALUES (v_installment, v_entity, v_agreement, v_sequence, v_amount, v_currency, v_due, 'DRAFT', v_actor);
  v_response := jsonb_build_object('capitalInstallmentId', v_installment, 'sequenceNumber', v_sequence, 'replayed', false);
  PERFORM abos.shareholder_setup_audit(v_actor, v_entity, v_correlation, 'CAPITAL_INSTALLMENT_PLANNED', 'CAPITAL_INSTALLMENT',
    v_installment, NULL, jsonb_build_object('capitalAgreementId', v_agreement, 'sequence', v_sequence,
      'expectedAmount', v_amount::text, 'currency', v_currency, 'dueOn', v_due));
  PERFORM abos.shareholder_setup_idempotency_complete(v_scope, v_key, 'CAPITAL_INSTALLMENT', v_installment, v_response);
  RETURN v_response;
END
$add_installment$;

CREATE FUNCTION abos.shareholder_setup_update_installment(
  p_identity_proof text, p_runtime_token_sha256 text, p_token_sha256 text, p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $update_installment$
DECLARE
  v_context jsonb;
  v_actor uuid;
  v_entity uuid;
  v_installment uuid;
  v_amount numeric;
  v_due date;
  v_row record;
BEGIN
  v_context := abos.shareholder_setup_actor(p_identity_proof, p_runtime_token_sha256, p_token_sha256,
    ARRAY['shareholder.setup.manage']);
  v_actor := (v_context ->> 'userAccountId')::uuid;
  v_entity := (v_context ->> 'legalEntityId')::uuid;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' OR EXISTS (
       SELECT 1 FROM jsonb_object_keys(p_payload) k WHERE k NOT IN ('capitalInstallmentId', 'expectedAmount', 'dueOn')) THEN
    RAISE EXCEPTION 'unknown or missing installment fields' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_installment := NULLIF(p_payload ->> 'capitalInstallmentId', '')::uuid;
  v_amount := abos.shareholder_setup_amount(p_payload ->> 'expectedAmount');
  v_due := NULLIF(p_payload ->> 'dueOn', '')::date;
  SELECT installment.status, installment.expected_amount, installment.due_on, agreement.status AS agreement_status
    INTO v_row
    FROM abos.capital_installments installment
    JOIN abos.capital_agreements agreement
      ON agreement.id = installment.capital_agreement_id AND agreement.legal_entity_id = installment.legal_entity_id
   WHERE installment.id = v_installment AND installment.legal_entity_id = v_entity
   FOR UPDATE OF installment;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'installment not found in this legal entity' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_row.status <> 'DRAFT' OR v_row.agreement_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'only a DRAFT installment of a DRAFT agreement can be edited here' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE abos.capital_installments SET expected_amount = v_amount, due_on = v_due WHERE id = v_installment;
  PERFORM abos.shareholder_setup_audit(v_actor, v_entity, NULL, 'CAPITAL_INSTALLMENT_DRAFT_EDITED', 'CAPITAL_INSTALLMENT',
    v_installment, jsonb_build_object('expectedAmount', v_row.expected_amount::text, 'dueOn', v_row.due_on),
    jsonb_build_object('expectedAmount', v_amount::text, 'dueOn', v_due));
  RETURN jsonb_build_object('capitalInstallmentId', v_installment, 'changed', true);
END
$update_installment$;

CREATE FUNCTION abos.shareholder_setup_cancel_installment(
  p_identity_proof text, p_runtime_token_sha256 text, p_token_sha256 text, p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $cancel_installment$
DECLARE
  v_context jsonb;
  v_actor uuid;
  v_entity uuid;
  v_installment uuid;
  v_reason text;
  v_row record;
BEGIN
  v_context := abos.shareholder_setup_actor(p_identity_proof, p_runtime_token_sha256, p_token_sha256,
    ARRAY['shareholder.setup.manage']);
  v_actor := (v_context ->> 'userAccountId')::uuid;
  v_entity := (v_context ->> 'legalEntityId')::uuid;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' OR EXISTS (
       SELECT 1 FROM jsonb_object_keys(p_payload) k WHERE k NOT IN ('capitalInstallmentId', 'reason')) THEN
    RAISE EXCEPTION 'unknown or missing installment fields' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_installment := NULLIF(p_payload ->> 'capitalInstallmentId', '')::uuid;
  v_reason := NULLIF(btrim(p_payload ->> 'reason'), '');
  IF v_installment IS NULL OR v_reason IS NULL OR length(v_reason) NOT BETWEEN 3 AND 300 THEN
    RAISE EXCEPTION 'an installment and a reason (3-300 characters) are required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT installment.status, agreement.status AS agreement_status INTO v_row
    FROM abos.capital_installments installment
    JOIN abos.capital_agreements agreement
      ON agreement.id = installment.capital_agreement_id AND agreement.legal_entity_id = installment.legal_entity_id
   WHERE installment.id = v_installment AND installment.legal_entity_id = v_entity
   FOR UPDATE OF installment;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'installment not found in this legal entity' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_row.status = 'CANCELLED' THEN
    RETURN jsonb_build_object('capitalInstallmentId', v_installment, 'changed', false);
  END IF;
  IF v_row.status <> 'DRAFT' OR v_row.agreement_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'only a DRAFT installment of a DRAFT agreement can be cancelled here' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE abos.capital_installments SET status = 'CANCELLED' WHERE id = v_installment;
  PERFORM abos.shareholder_setup_audit(v_actor, v_entity, NULL, 'CAPITAL_INSTALLMENT_CANCELLED', 'CAPITAL_INSTALLMENT',
    v_installment, jsonb_build_object('status', 'DRAFT'), jsonb_build_object('status', 'CANCELLED', 'reason', v_reason));
  RETURN jsonb_build_object('capitalInstallmentId', v_installment, 'changed', true);
END
$cancel_installment$;

CREATE FUNCTION abos.shareholder_setup_record_agreement_evidence(
  p_identity_proof text, p_runtime_token_sha256 text, p_token_sha256 text, p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $record_evidence$
DECLARE
  v_context jsonb;
  v_actor uuid;
  v_entity uuid;
  v_agreement uuid;
  v_document_reference text;
  v_document_date date;
  v_sha256 text;
  v_key text;
  v_correlation uuid;
  v_scope text;
  v_replay jsonb;
  v_status text;
  v_version integer;
  v_evidence uuid := pg_catalog.gen_random_uuid();
  v_link uuid := pg_catalog.gen_random_uuid();
  v_response jsonb;
BEGIN
  v_context := abos.shareholder_setup_actor(p_identity_proof, p_runtime_token_sha256, p_token_sha256,
    ARRAY['shareholder.setup.manage']);
  v_actor := (v_context ->> 'userAccountId')::uuid;
  v_entity := (v_context ->> 'legalEntityId')::uuid;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' OR EXISTS (
       SELECT 1 FROM jsonb_object_keys(p_payload) k
        WHERE k NOT IN ('capitalAgreementId', 'documentReference', 'documentDate', 'sha256', 'correlationId', 'idempotencyKey')) THEN
    RAISE EXCEPTION 'unknown or missing document fields' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_agreement := NULLIF(p_payload ->> 'capitalAgreementId', '')::uuid;
  v_document_reference := NULLIF(btrim(p_payload ->> 'documentReference'), '');
  v_document_date := NULLIF(p_payload ->> 'documentDate', '')::date;
  v_sha256 := lower(NULLIF(btrim(p_payload ->> 'sha256'), ''));
  v_key := NULLIF(btrim(p_payload ->> 'idempotencyKey'), '');
  v_correlation := NULLIF(p_payload ->> 'correlationId', '')::uuid;
  IF v_agreement IS NULL OR v_document_reference IS NULL OR length(v_document_reference) > 200
     OR v_document_date IS NULL OR v_sha256 IS NULL OR v_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'an agreement, a document reference, the document date and its SHA-256 are required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_document_date > current_date THEN
    RAISE EXCEPTION 'the document date cannot be in the future' USING ERRCODE = 'check_violation';
  END IF;
  v_scope := v_entity::text || ':SHAREHOLDER_SETUP_AGREEMENT_EVIDENCE';
  v_replay := abos.shareholder_setup_idempotency_begin(v_scope, v_key,
    encode(sha256(convert_to(jsonb_build_object('actor', v_actor, 'agreement', v_agreement,
      'reference', v_document_reference, 'date', v_document_date, 'sha256', v_sha256)::text, 'UTF8')), 'hex'), v_correlation);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  SELECT agreement.status INTO v_status FROM abos.capital_agreements agreement
   WHERE agreement.id = v_agreement AND agreement.legal_entity_id = v_entity;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'capital agreement not found in this legal entity' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_status NOT IN ('DRAFT', 'PENDING_EVIDENCE') THEN
    RAISE EXCEPTION 'agreement documents can be recorded here only before the agreement is eligible' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('abos-agreement-evidence:' || v_agreement::text, 0));
  SELECT coalesce(max(link.version), 0) + 1 INTO v_version
    FROM abos.capital_agreement_evidence link WHERE link.capital_agreement_id = v_agreement;
  INSERT INTO abos.evidence_references
    (id, legal_entity_id, document_id, evidence_kind, evidence_version, sha256, completed_at)
  VALUES (v_evidence, v_entity, pg_catalog.gen_random_uuid(), 'CAPITAL_AGREEMENT', 1, v_sha256, pg_catalog.clock_timestamp());
  INSERT INTO abos.capital_agreement_evidence
    (id, legal_entity_id, capital_agreement_id, evidence_reference_id, version, document_reference, document_date,
     recorded_by_user_account_id)
  VALUES (v_link, v_entity, v_agreement, v_evidence, v_version, v_document_reference, v_document_date, v_actor);
  v_response := jsonb_build_object('agreementEvidenceId', v_link, 'evidenceReferenceId', v_evidence,
    'version', v_version, 'replayed', false);
  PERFORM abos.shareholder_setup_audit(v_actor, v_entity, v_correlation, 'CAPITAL_AGREEMENT_DOCUMENT_RECORDED',
    'CAPITAL_AGREEMENT', v_agreement, NULL,
    jsonb_build_object('documentReference', v_document_reference, 'documentDate', v_document_date,
      'sha256', v_sha256, 'version', v_version));
  PERFORM abos.shareholder_setup_idempotency_complete(v_scope, v_key, 'CAPITAL_AGREEMENT_EVIDENCE', v_link, v_response);
  RETURN v_response;
END
$record_evidence$;

CREATE FUNCTION abos.shareholder_setup_workspace(
  p_identity_proof text, p_runtime_token_sha256 text, p_token_sha256 text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $workspace$
DECLARE
  v_context jsonb;
  v_entity uuid;
  v_permissions jsonb;
  v_funding boolean;
BEGIN
  v_context := abos.shareholder_setup_actor(p_identity_proof, p_runtime_token_sha256, p_token_sha256,
    ARRAY['shareholder.setup.manage', 'shareholder.read']);
  v_entity := (v_context ->> 'legalEntityId')::uuid;
  v_permissions := COALESCE(v_context -> 'permissions', '[]'::jsonb);
  v_funding := EXISTS (SELECT 1 FROM abos.capital_agreement_funding_policies p WHERE p.legal_entity_id = v_entity);
  RETURN jsonb_build_object(
    'legalEntity', (SELECT jsonb_build_object('id', entity.id, 'name', entity.name, 'baseCurrency', entity.base_currency_code)
                      FROM abos.legal_entities entity WHERE entity.id = v_entity),
    'permissions', jsonb_build_object(
      'canManage', v_permissions ? 'shareholder.setup.manage',
      'canCreateRequests', v_permissions ? 'shareholder.capital-request.create'),
    'today', current_date,
    -- The downstream path (Capital Request -> Treasury -> Finance -> GL) is not operational in V1.
    'receiptPathOperational', false,
    'currencies', COALESCE((SELECT jsonb_agg(currency.code ORDER BY currency.code)
                              FROM abos.currencies currency WHERE currency.enabled), '[]'::jsonb),
    'shareholders', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', profile.id, 'businessPartyId', party.id, 'name', party.display_name,
               'reference', party.external_reference, 'status', profile.status,
               'since', (SELECT min(role.effective_from) FROM abos.business_party_roles role
                          WHERE role.business_party_id = party.id AND role.role_code = 'SHAREHOLDER'),
               'createdAt', profile.created_at,
               'correctable', NOT abos.shareholder_setup_has_posted_capital(profile.id, v_entity),
               'agreementCount', (SELECT count(*) FROM abos.capital_agreements a
                                   WHERE a.shareholder_profile_id = profile.id AND a.legal_entity_id = v_entity))
             ORDER BY party.display_name, profile.id)
        FROM abos.shareholder_profiles profile
        JOIN abos.business_parties party ON party.id = profile.business_party_id AND party.legal_entity_id = profile.legal_entity_id
       WHERE profile.legal_entity_id = v_entity), '[]'::jsonb),
    'agreements', COALESCE((
      SELECT jsonb_agg(row_json ORDER BY row_json ->> 'shareholderName', row_json ->> 'reference')
        FROM (
          SELECT jsonb_build_object(
                   'id', agreement.id, 'shareholderProfileId', agreement.shareholder_profile_id,
                   'shareholderName', party.display_name, 'reference', agreement.agreement_reference,
                   'kind', agreement.agreement_kind, 'currency', agreement.currency_code,
                   'committed', agreement.committed_amount::text,
                   'planned', (SELECT coalesce(sum(i.expected_amount), 0) FROM abos.capital_installments i
                                WHERE i.capital_agreement_id = agreement.id AND i.status <> 'CANCELLED')::text,
                   'requested', (SELECT coalesce(sum(r.amount), 0) FROM abos.capital_receipt_intents r
                                  WHERE r.capital_agreement_id = agreement.id AND r.legal_entity_id = v_entity
                                    AND r.status IN ('DRAFT', 'ELIGIBLE', 'TREASURY_VERIFIED'))::text,
                   'received', received.amount::text,
                   'remaining', (agreement.committed_amount - received.amount)::text,
                   'effectiveOn', agreement.effective_on, 'status', agreement.status,
                   'partialAllowed', agreement.partial_installments_allowed,
                   'createdBy', creator.display_name, 'createdAt', agreement.created_at,
                   'editable', agreement.status = 'DRAFT',
                   'installments', COALESCE((
                     SELECT jsonb_agg(jsonb_build_object(
                              'id', i.id, 'sequence', i.sequence_number, 'amount', i.expected_amount::text,
                              'currency', i.currency_code, 'dueOn', i.due_on, 'status', i.status,
                              'editable', i.status = 'DRAFT' AND agreement.status = 'DRAFT')
                            ORDER BY i.sequence_number)
                       FROM abos.capital_installments i WHERE i.capital_agreement_id = agreement.id), '[]'::jsonb),
                   'documents', COALESCE((
                     SELECT jsonb_agg(jsonb_build_object(
                              'id', link.id, 'version', link.version, 'reference', link.document_reference,
                              'documentDate', link.document_date, 'sha256', er.sha256,
                              'recordedAt', link.recorded_at, 'recordedBy', recorder.display_name)
                            ORDER BY link.version)
                       FROM abos.capital_agreement_evidence link
                       JOIN abos.evidence_references er ON er.id = link.evidence_reference_id AND er.legal_entity_id = link.legal_entity_id
                       JOIN abos.user_accounts recorder ON recorder.id = link.recorded_by_user_account_id
                      WHERE link.capital_agreement_id = agreement.id), '[]'::jsonb),
                   'registration', CASE
                     WHEN EXISTS (SELECT 1 FROM abos.registration_evidence re
                                   WHERE re.capital_agreement_id = agreement.id AND re.legal_entity_id = v_entity
                                     AND re.status = 'VERIFIED') THEN 'VERIFIED'
                     WHEN EXISTS (SELECT 1 FROM abos.registration_evidence re
                                   WHERE re.capital_agreement_id = agreement.id AND re.legal_entity_id = v_entity
                                     AND re.status = 'PENDING') THEN 'PENDING'
                     ELSE 'NONE' END,
                   'requestBlockers', to_jsonb(array_remove(ARRAY[
                     CASE WHEN agreement.status = 'DRAFT' THEN 'AGREEMENT_DRAFT' END,
                     CASE WHEN NOT EXISTS (SELECT 1 FROM abos.capital_agreement_evidence link
                                            WHERE link.capital_agreement_id = agreement.id) THEN 'AGREEMENT_EVIDENCE_MISSING' END,
                     CASE WHEN NOT EXISTS (SELECT 1 FROM abos.registration_evidence re
                                            WHERE re.capital_agreement_id = agreement.id AND re.legal_entity_id = v_entity
                                              AND re.status = 'VERIFIED') THEN 'REGISTRATION_NOT_VERIFIED' END,
                     CASE WHEN NOT v_funding THEN 'NO_FUNDING_DECISION' END,
                     'RECEIPT_PATH_NOT_OPERATIONAL'], NULL))) AS row_json
            FROM abos.capital_agreements agreement
            JOIN abos.shareholder_profiles profile
              ON profile.id = agreement.shareholder_profile_id AND profile.legal_entity_id = agreement.legal_entity_id
            JOIN abos.business_parties party ON party.id = profile.business_party_id AND party.legal_entity_id = profile.legal_entity_id
            JOIN abos.user_accounts creator ON creator.id = agreement.created_by_user_account_id
            CROSS JOIN LATERAL (SELECT abos.shareholder_setup_received(agreement.id, v_entity) AS amount) received
           WHERE agreement.legal_entity_id = v_entity) agreements), '[]'::jsonb),
    -- Per currency; currencies are never combined.
    'totalsByCurrency', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('currency', t.currency, 'committed', t.committed::text,
                                          'received', t.received::text, 'remaining', (t.committed - t.received)::text)
                       ORDER BY t.currency)
        FROM (SELECT agreement.currency_code AS currency, sum(agreement.committed_amount) AS committed,
                     sum(abos.shareholder_setup_received(agreement.id, v_entity)) AS received
                FROM abos.capital_agreements agreement
               WHERE agreement.legal_entity_id = v_entity GROUP BY agreement.currency_code) t), '[]'::jsonb));
END
$workspace$;

-- ---------------------------------------------------------------------------
-- Ownership and execution.
-- ---------------------------------------------------------------------------
ALTER FUNCTION abos.shareholder_setup_create_shareholder(text, text, text, jsonb) OWNER TO abos_v1_shareholder_setup_owner;
ALTER FUNCTION abos.shareholder_setup_correct_shareholder(text, text, text, jsonb) OWNER TO abos_v1_shareholder_setup_owner;
ALTER FUNCTION abos.shareholder_setup_create_agreement(text, text, text, jsonb) OWNER TO abos_v1_shareholder_setup_owner;
ALTER FUNCTION abos.shareholder_setup_update_agreement(text, text, text, jsonb) OWNER TO abos_v1_shareholder_setup_owner;
ALTER FUNCTION abos.shareholder_setup_add_installment(text, text, text, jsonb) OWNER TO abos_v1_shareholder_setup_owner;
ALTER FUNCTION abos.shareholder_setup_update_installment(text, text, text, jsonb) OWNER TO abos_v1_shareholder_setup_owner;
ALTER FUNCTION abos.shareholder_setup_cancel_installment(text, text, text, jsonb) OWNER TO abos_v1_shareholder_setup_owner;
ALTER FUNCTION abos.shareholder_setup_record_agreement_evidence(text, text, text, jsonb) OWNER TO abos_v1_shareholder_setup_owner;
ALTER FUNCTION abos.shareholder_setup_workspace(text, text, text) OWNER TO abos_v1_shareholder_setup_owner;

REVOKE ALL ON FUNCTION
  abos.shareholder_setup_actor(text, text, text, text[]),
  abos.shareholder_setup_amount(text),
  abos.shareholder_setup_idempotency_begin(text, text, text, uuid),
  abos.shareholder_setup_idempotency_complete(text, text, text, uuid, jsonb),
  abos.shareholder_setup_received(uuid, uuid),
  abos.shareholder_setup_has_posted_capital(uuid, uuid),
  abos.shareholder_setup_audit(uuid, uuid, uuid, text, text, uuid, jsonb, jsonb),
  abos.shareholder_setup_create_shareholder(text, text, text, jsonb),
  abos.shareholder_setup_correct_shareholder(text, text, text, jsonb),
  abos.shareholder_setup_create_agreement(text, text, text, jsonb),
  abos.shareholder_setup_update_agreement(text, text, text, jsonb),
  abos.shareholder_setup_add_installment(text, text, text, jsonb),
  abos.shareholder_setup_update_installment(text, text, text, jsonb),
  abos.shareholder_setup_cancel_installment(text, text, text, jsonb),
  abos.shareholder_setup_record_agreement_evidence(text, text, text, jsonb),
  abos.shareholder_setup_workspace(text, text, text),
  abos.guard_capital_agreement_evidence(),
  abos.guard_installment_commitment(),
  abos.guard_agreement_planned_commitment(),
  abos.forbid_shareholder_setup_owner_update()
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  abos.shareholder_setup_actor(text, text, text, text[]),
  abos.shareholder_setup_amount(text),
  abos.shareholder_setup_idempotency_begin(text, text, text, uuid),
  abos.shareholder_setup_idempotency_complete(text, text, text, uuid, jsonb),
  abos.shareholder_setup_received(uuid, uuid),
  abos.shareholder_setup_has_posted_capital(uuid, uuid),
  abos.shareholder_setup_audit(uuid, uuid, uuid, text, text, uuid, jsonb, jsonb)
TO abos_v1_shareholder_setup_owner;
-- Runtime: EXECUTE on the reviewed entry points only, through the restricted Finance login.
GRANT EXECUTE ON FUNCTION
  abos.shareholder_setup_create_shareholder(text, text, text, jsonb),
  abos.shareholder_setup_correct_shareholder(text, text, text, jsonb),
  abos.shareholder_setup_create_agreement(text, text, text, jsonb),
  abos.shareholder_setup_update_agreement(text, text, text, jsonb),
  abos.shareholder_setup_add_installment(text, text, text, jsonb),
  abos.shareholder_setup_update_installment(text, text, text, jsonb),
  abos.shareholder_setup_cancel_installment(text, text, text, jsonb),
  abos.shareholder_setup_record_agreement_evidence(text, text, text, jsonb),
  abos.shareholder_setup_workspace(text, text, text)
TO abos_e1_runtime;

-- ---------------------------------------------------------------------------
-- E1 application request path: the agreement document must be linked to THIS agreement.
-- Both functions are copied from 0016 unchanged except for the marked evidence lines; they keep
-- their owner (abos_e1_shareholder_owner), grants and the synthetic gate.
-- ---------------------------------------------------------------------------
GRANT SELECT ON abos.capital_agreement_evidence TO abos_e1_shareholder_owner;

CREATE OR REPLACE FUNCTION abos.shareholder_create_capital_request(
  p_bearer_token text,
  p_installment_id uuid,
  p_destination_cash_account_id uuid,
  p_amount text,
  p_business_date date,
  p_exchange_rate_id uuid,
  p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $create_request$
DECLARE
  actor uuid;
  entity uuid;
  base text;
  installment abos.capital_installments%ROWTYPE;
  agreement abos.capital_agreements%ROWTYPE;
  profile abos.shareholder_profiles%ROWTYPE;
  registration_evidence_id uuid;
  destination record;
  amount numeric;
  consumed numeric;
  fingerprint text;
  existing record;
  intent_id uuid := gen_random_uuid();
  snapshot_id uuid;
BEGIN
  actor := abos.shareholder_runtime_authorize(p_bearer_token, 'shareholder.capital-request.create');
  entity := current_setting('abos.shareholder_legal_entity_id')::uuid;
  SELECT base_currency_code INTO base FROM abos.legal_entities WHERE id = entity;
  IF base IS NULL THEN
    RAISE EXCEPTION 'the legal entity has no base currency' USING ERRCODE = 'check_violation';
  END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' OR length(p_idempotency_key) > 200 THEN
    RAISE EXCEPTION 'a stable idempotency key is required for the request' USING ERRCODE = 'check_violation';
  END IF;
  IF p_amount IS NULL OR length(p_amount) > 40 OR p_amount !~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$' THEN
    RAISE EXCEPTION 'the amount must be a plain decimal number' USING ERRCODE = 'check_violation';
  END IF;
  amount := p_amount::numeric;
  IF amount <= 0 THEN
    RAISE EXCEPTION 'the amount must be greater than zero' USING ERRCODE = 'check_violation';
  END IF;
  IF p_business_date IS NULL THEN
    RAISE EXCEPTION 'the business date of the request is required' USING ERRCODE = 'check_violation';
  END IF;
  IF p_business_date > current_date + 1 THEN
    RAISE EXCEPTION 'a request cannot be dated in the future' USING ERRCODE = 'check_violation';
  END IF;

  -- Idempotency: the same key and the same request return the first result; a different request
  -- under the same key is refused. Serialized per key and per installment.
  fingerprint := encode(sha256(convert_to(jsonb_build_object(
    'installment', p_installment_id, 'destination', p_destination_cash_account_id, 'amount', trim_scale(amount)::text,
    'businessDate', p_business_date, 'exchangeRate', p_exchange_rate_id)::text, 'UTF8')), 'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended('abos-capital-request-key:' || entity::text || ':' || p_idempotency_key, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('abos-capital-request-installment:' || coalesce(p_installment_id::text, '-'), 0));
  SELECT cri.id, cri.request_fingerprint INTO existing
    FROM abos.capital_receipt_intents cri
   WHERE cri.legal_entity_id = entity AND cri.idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF existing.request_fingerprint <> fingerprint THEN
      RAISE EXCEPTION 'this request key was already used for a different request' USING ERRCODE = 'unique_violation';
    END IF;
    RETURN jsonb_build_object('id', existing.id, 'replayed', true,
      'snapshotId', (SELECT s.id FROM abos.exchange_rate_snapshots s
                      WHERE s.source_type = 'CAPITAL_RECEIPT_INTENT' AND s.source_id = existing.id));
  END IF;

  SELECT * INTO installment FROM abos.capital_installments WHERE id = p_installment_id AND legal_entity_id = entity;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the capital installment was not found' USING ERRCODE = 'check_violation';
  END IF;
  IF installment.status NOT IN ('DRAFT', 'PENDING_RECEIPT') THEN
    RAISE EXCEPTION 'installment % is % and cannot take a new capital request', installment.sequence_number, installment.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM abos.capital_receipt_intents WHERE legal_entity_id = entity AND capital_installment_id = installment.id) THEN
    RAISE EXCEPTION 'this installment already has a capital request' USING ERRCODE = 'unique_violation';
  END IF;
  SELECT * INTO agreement FROM abos.capital_agreements WHERE id = installment.capital_agreement_id AND legal_entity_id = entity;
  IF agreement.agreement_kind <> 'CAPITAL_CONTRIBUTION' THEN
    RAISE EXCEPTION 'a shareholder loan agreement cannot fund a capital contribution' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO profile FROM abos.shareholder_profiles WHERE id = agreement.shareholder_profile_id AND legal_entity_id = entity;
  IF profile.status IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'the shareholder profile is not active' USING ERRCODE = 'check_violation';
  END IF;
  -- F-1: fundability comes from the recorded decision, never from the status name.
  IF NOT EXISTS (SELECT 1 FROM abos.capital_agreement_funding_policies p
                  WHERE p.legal_entity_id = entity AND agreement.status = ANY (p.fundable_statuses)) THEN
    RAISE EXCEPTION 'capital agreement % is % and is not fundable under the recorded funding decision',
      agreement.agreement_reference, agreement.status USING ERRCODE = 'check_violation';
  END IF;
  SELECT re.evidence_reference_id INTO registration_evidence_id
    FROM abos.registration_evidence re
    JOIN abos.evidence_references er ON er.id = re.evidence_reference_id AND er.legal_entity_id = re.legal_entity_id
   WHERE re.capital_agreement_id = agreement.id AND re.legal_entity_id = entity
     AND re.status = 'VERIFIED' AND er.evidence_kind = 'FORMAL_REGISTRATION'
   ORDER BY re.verified_at DESC, re.created_at DESC
   LIMIT 1;
  IF registration_evidence_id IS NULL THEN
    RAISE EXCEPTION 'verified formal capital-registration evidence is required before a capital request'
      USING ERRCODE = 'check_violation';
  END IF;
  -- 0031: the CAPITAL_AGREEMENT document must be linked to THIS agreement; any agreement document
  -- elsewhere in the company no longer satisfies it.
  IF NOT EXISTS (SELECT 1 FROM abos.capital_agreement_evidence cae
                  JOIN abos.evidence_references er
                    ON er.id = cae.evidence_reference_id AND er.legal_entity_id = cae.legal_entity_id
                 WHERE cae.capital_agreement_id = agreement.id AND cae.legal_entity_id = entity
                   AND er.evidence_kind = 'CAPITAL_AGREEMENT') THEN
    RAISE EXCEPTION 'a controlled CAPITAL_AGREEMENT document linked to this agreement is required' USING ERRCODE = 'check_violation';
  END IF;
  IF installment.currency_code <> agreement.currency_code
     OR NOT EXISTS (SELECT 1 FROM abos.currencies c WHERE c.code = installment.currency_code AND c.enabled) THEN
    RAISE EXCEPTION 'the installment currency is not an enabled agreement currency' USING ERRCODE = 'check_violation';
  END IF;

  SELECT a.id, a.currency_code, a.activation_status, l.status AS location_status, l.location_name INTO destination
    FROM abos.cash_location_currency_accounts a
    JOIN abos.cash_locations l ON l.id = a.cash_location_id AND l.legal_entity_id = a.legal_entity_id
   WHERE a.id = p_destination_cash_account_id AND a.legal_entity_id = entity;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the receiving safe account was not found' USING ERRCODE = 'check_violation';
  END IF;
  IF destination.currency_code <> installment.currency_code THEN
    RAISE EXCEPTION 'a % installment is received into a % safe account; amounts are never converted',
      installment.currency_code, installment.currency_code USING ERRCODE = 'check_violation';
  END IF;
  IF destination.activation_status <> 'ACTIVE' OR destination.location_status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'Treasury has not activated the % account of %', destination.currency_code, destination.location_name
      USING ERRCODE = 'check_violation';
  END IF;

  IF amount > installment.expected_amount THEN
    RAISE EXCEPTION 'the amount exceeds the expected installment amount of % %', installment.expected_amount, installment.currency_code
      USING ERRCODE = 'check_violation';
  END IF;
  IF amount < installment.expected_amount AND NOT agreement.partial_installments_allowed THEN
    RAISE EXCEPTION 'this agreement does not allow a partial installment' USING ERRCODE = 'check_violation';
  END IF;
  SELECT consumed_amount INTO consumed FROM abos.capital_agreement_commitment_usage
   WHERE capital_agreement_id = agreement.id AND legal_entity_id = entity;
  IF coalesce(consumed, 0) + amount > agreement.committed_amount THEN
    RAISE EXCEPTION 'capital requests would exceed the committed amount: committed % %, already requested %, this request %',
      agreement.committed_amount, agreement.currency_code, coalesce(consumed, 0), amount USING ERRCODE = 'check_violation';
  END IF;
  IF installment.currency_code = base AND p_exchange_rate_id IS NOT NULL THEN
    RAISE EXCEPTION 'a % request takes no exchange rate', base USING ERRCODE = 'check_violation';
  END IF;

  -- The existing triggers enforce the ceiling (row-locked usage), the funding decision and the
  -- sandbox gate again on this insert; one intent per installment is a unique constraint.
  INSERT INTO abos.capital_receipt_intents
    (id, legal_entity_id, shareholder_business_party_id, capital_agreement_id, capital_installment_id,
     amount, currency_code, destination_cash_account_id, evidence_reference_id, correlation_id,
     idempotency_key, request_fingerprint, business_event_at, status, classification,
     contribution_state, version, created_by_user_account_id)
  VALUES
    (intent_id, entity, profile.business_party_id, agreement.id, installment.id,
     amount, installment.currency_code, destination.id, registration_evidence_id, gen_random_uuid(),
     p_idempotency_key, fingerprint, p_business_date::timestamp AT TIME ZONE 'UTC', 'ELIGIBLE', 'PAID_IN_SHARE_CAPITAL',
     'PENDING', 1, actor);
  INSERT INTO abos.capital_receipt_intent_history
    (id, capital_receipt_intent_id, legal_entity_id, version, status, contribution_state, classification, amount, currency_code)
  VALUES (gen_random_uuid(), intent_id, entity, 1, 'ELIGIBLE', 'PENDING', 'PAID_IN_SHARE_CAPITAL', amount, installment.currency_code);

  -- A non-base (AFN) request keeps an immutable snapshot of the rate for its business date; with no
  -- rate for that date the whole request is refused and nothing above is kept.
  IF installment.currency_code <> base THEN
    snapshot_id := abos.capture_exchange_rate_snapshot(entity, 'CAPITAL_RECEIPT_INTENT', intent_id,
      installment.currency_code, p_business_date, p_exchange_rate_id, actor);
  END IF;

  INSERT INTO abos.audit_records (id, actor_user_account_id, legal_entity_id, correlation_id, action, entity_type, entity_id, after_state, metadata)
  VALUES (gen_random_uuid(), actor, entity, gen_random_uuid(), 'SHAREHOLDER_CAPITAL_REQUEST_CREATED', 'CAPITAL_RECEIPT_INTENT', intent_id,
          jsonb_build_object('agreementId', agreement.id, 'installmentId', installment.id, 'amount', amount::text,
            'currency', installment.currency_code, 'destinationCashAccountId', destination.id, 'businessDate', p_business_date,
            'status', 'ELIGIBLE', 'exchangeRateSnapshot',
            (SELECT jsonb_build_object('id', s.id, 'exchangeRateId', s.exchange_rate_id, 'rateDate', s.rate_date,
                      'unitCurrency', s.unit_currency_code, 'quoteCurrency', s.quote_currency_code, 'rate', s.rate_value::text)
               FROM abos.exchange_rate_snapshots s WHERE s.id = snapshot_id)),
          jsonb_build_object('source', 'shareholder_create_capital_request'));
  RETURN jsonb_build_object('id', intent_id, 'replayed', false, 'snapshotId', snapshot_id);
END;
$create_request$;

CREATE OR REPLACE FUNCTION abos.shareholder_capital_workspace(p_bearer_token text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $workspace$
DECLARE
  actor uuid;
  entity uuid;
  can_create boolean := true;
  base text;
BEGIN
  BEGIN
    actor := abos.shareholder_runtime_authorize(p_bearer_token, 'shareholder.capital-request.create');
  EXCEPTION WHEN insufficient_privilege THEN
    actor := abos.shareholder_runtime_authorize(p_bearer_token, 'shareholder.read');
    can_create := false;
  END;
  entity := current_setting('abos.shareholder_legal_entity_id')::uuid;
  SELECT base_currency_code INTO base FROM abos.legal_entities WHERE id = entity;
  RETURN jsonb_build_object(
    'canCreate', can_create,
    'today', current_date,
    'legalEntity', (SELECT jsonb_build_object('id', e.id, 'name', e.name, 'baseCurrency', e.base_currency_code)
                      FROM abos.legal_entities e WHERE e.id = entity),
    'fundingPolicy', (SELECT jsonb_build_object('decisionReference', p.decision_reference, 'decidedBy', p.decided_by,
                              'fundableStatuses', to_jsonb(p.fundable_statuses))
                        FROM abos.capital_agreement_funding_policies p WHERE p.legal_entity_id = entity),
    'agreements', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'id', ca.id, 'reference', ca.agreement_reference, 'shareholder', bp.display_name,
               'shareholderStatus', sp.status, 'kind', ca.agreement_kind, 'currency', ca.currency_code,
               'committedAmount', ca.committed_amount::text, 'consumedAmount', coalesce(usage.consumed_amount, 0)::text,
               'remainingAmount', (ca.committed_amount - coalesce(usage.consumed_amount, 0))::text,
               'status', ca.status, 'partialAllowed', ca.partial_installments_allowed,
               'fundable', EXISTS (SELECT 1 FROM abos.capital_agreement_funding_policies p
                                    WHERE p.legal_entity_id = entity AND ca.status = ANY (p.fundable_statuses)),
               'registrationVerified', EXISTS (
                 SELECT 1 FROM abos.registration_evidence re
                   JOIN abos.evidence_references er ON er.id = re.evidence_reference_id AND er.legal_entity_id = re.legal_entity_id
                  WHERE re.capital_agreement_id = ca.id AND re.legal_entity_id = entity
                    AND re.status = 'VERIFIED' AND er.evidence_kind = 'FORMAL_REGISTRATION'),
               'installments', coalesce((
                 SELECT jsonb_agg(jsonb_build_object(
                          'id', ci.id, 'sequence', ci.sequence_number, 'expectedAmount', ci.expected_amount::text,
                          'currency', ci.currency_code, 'dueOn', ci.due_on, 'status', ci.status,
                          'request', (
                            SELECT jsonb_build_object(
                                     'id', cri.id, 'status', cri.status, 'amount', cri.amount::text, 'currency', cri.currency_code,
                                     'businessDate', (cri.business_event_at AT TIME ZONE 'UTC')::date,
                                     'createdAt', cri.created_at, 'createdBy', creator.display_name,
                                     'destination', loc.location_name || ' · ' || acct.currency_code,
                                     'snapshot', (SELECT jsonb_build_object(
                                                     'id', snap.id, 'rateDate', snap.rate_date, 'source', snap.rate_source,
                                                     'sarafName', saraf.display_name, 'unitCurrency', snap.unit_currency_code,
                                                     'quoteCurrency', snap.quote_currency_code, 'rate', snap.rate_value::text,
                                                     'capturedAt', snap.captured_at)
                                                    FROM abos.exchange_rate_snapshots snap
                                                    LEFT JOIN abos.business_parties saraf
                                                      ON saraf.id = snap.saraf_business_party_id AND saraf.legal_entity_id = snap.legal_entity_id
                                                   WHERE snap.source_type = 'CAPITAL_RECEIPT_INTENT' AND snap.source_id = cri.id))
                              FROM abos.capital_receipt_intents cri
                              JOIN abos.user_accounts creator ON creator.id = cri.created_by_user_account_id
                              JOIN abos.cash_location_currency_accounts acct
                                ON acct.id = cri.destination_cash_account_id AND acct.legal_entity_id = cri.legal_entity_id
                              JOIN abos.cash_locations loc ON loc.id = acct.cash_location_id AND loc.legal_entity_id = acct.legal_entity_id
                             WHERE cri.capital_installment_id = ci.id AND cri.legal_entity_id = entity),
                          'blockers', to_jsonb(array_remove(ARRAY[
                            CASE WHEN EXISTS (SELECT 1 FROM abos.capital_receipt_intents x
                                               WHERE x.capital_installment_id = ci.id AND x.legal_entity_id = entity) THEN 'HAS_REQUEST' END,
                            CASE WHEN ci.status NOT IN ('DRAFT', 'PENDING_RECEIPT') THEN 'INSTALLMENT_CLOSED' END,
                            CASE WHEN ca.agreement_kind <> 'CAPITAL_CONTRIBUTION' THEN 'LOAN_AGREEMENT' END,
                            CASE WHEN sp.status <> 'ACTIVE' THEN 'SHAREHOLDER_NOT_ACTIVE' END,
                            CASE WHEN NOT EXISTS (SELECT 1 FROM abos.capital_agreement_funding_policies p
                                                   WHERE p.legal_entity_id = entity AND ca.status = ANY (p.fundable_statuses))
                                 THEN 'AGREEMENT_NOT_FUNDABLE' END,
                            CASE WHEN NOT EXISTS (SELECT 1 FROM abos.capital_agreement_evidence cae
                                                   WHERE cae.capital_agreement_id = ca.id AND cae.legal_entity_id = entity)
                                 THEN 'AGREEMENT_EVIDENCE_MISSING' END,
                            CASE WHEN NOT EXISTS (
                                   SELECT 1 FROM abos.registration_evidence re
                                     JOIN abos.evidence_references er ON er.id = re.evidence_reference_id AND er.legal_entity_id = re.legal_entity_id
                                    WHERE re.capital_agreement_id = ca.id AND re.legal_entity_id = entity
                                      AND re.status = 'VERIFIED' AND er.evidence_kind = 'FORMAL_REGISTRATION')
                                 THEN 'REGISTRATION_NOT_VERIFIED' END,
                            CASE WHEN ca.committed_amount - coalesce(usage.consumed_amount, 0) <= 0 THEN 'COMMITMENT_USED' END,
                            CASE WHEN NOT EXISTS (
                                   SELECT 1 FROM abos.cash_location_currency_accounts a
                                     JOIN abos.cash_locations l ON l.id = a.cash_location_id AND l.legal_entity_id = a.legal_entity_id
                                    WHERE a.legal_entity_id = entity AND a.currency_code = ci.currency_code
                                      AND a.activation_status = 'ACTIVE' AND l.status = 'ACTIVE')
                                 THEN 'NO_ACTIVE_ACCOUNT' END], NULL)))
                        ORDER BY ci.sequence_number)
                   FROM abos.capital_installments ci
                  WHERE ci.capital_agreement_id = ca.id AND ci.legal_entity_id = entity), '[]'::jsonb))
             ORDER BY ca.currency_code, ca.agreement_reference)
        FROM abos.capital_agreements ca
        JOIN abos.shareholder_profiles sp ON sp.id = ca.shareholder_profile_id AND sp.legal_entity_id = ca.legal_entity_id
        JOIN abos.business_parties bp ON bp.id = sp.business_party_id AND bp.legal_entity_id = sp.legal_entity_id
        LEFT JOIN abos.capital_agreement_commitment_usage usage
          ON usage.capital_agreement_id = ca.id AND usage.legal_entity_id = ca.legal_entity_id
       WHERE ca.legal_entity_id = entity), '[]'::jsonb),
    -- Per currency, never summed across currencies and never converted.
    'totalsByCurrency', coalesce((
      SELECT jsonb_agg(jsonb_build_object('currency', t.currency_code, 'committed', t.committed::text,
                                          'requested', t.requested::text, 'agreements', t.agreements) ORDER BY t.currency_code)
        FROM (SELECT ca.currency_code, sum(ca.committed_amount) AS committed,
                     sum(coalesce(usage.consumed_amount, 0)) AS requested, count(*) AS agreements
                FROM abos.capital_agreements ca
                LEFT JOIN abos.capital_agreement_commitment_usage usage
                  ON usage.capital_agreement_id = ca.id AND usage.legal_entity_id = ca.legal_entity_id
               WHERE ca.legal_entity_id = entity AND ca.agreement_kind = 'CAPITAL_CONTRIBUTION'
               GROUP BY ca.currency_code) t), '[]'::jsonb),
    'destinationAccounts', coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', a.id, 'safe', l.location_name, 'currency', a.currency_code,
                                          'status', a.activation_status, 'safeStatus', l.status,
                                          'usable', a.activation_status = 'ACTIVE' AND l.status = 'ACTIVE')
                       ORDER BY l.location_name, a.currency_code)
        FROM abos.cash_location_currency_accounts a
        JOIN abos.cash_locations l ON l.id = a.cash_location_id AND l.legal_entity_id = a.legal_entity_id
       WHERE a.legal_entity_id = entity), '[]'::jsonb),
    -- Current (uncorrected) rates against the base currency, so a request can show which rate its
    -- business date would snapshot. Read-only here; recording rates is a Finance permission.
    'currentRates', coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', r.id, 'rateDate', r.rate_date, 'source', r.rate_source,
                                          'sarafName', saraf.display_name, 'unitCurrency', r.unit_currency_code,
                                          'quoteCurrency', r.quote_currency_code, 'rate', r.rate_value::text)
                       ORDER BY r.rate_date DESC, r.rate_source, saraf.display_name)
        FROM abos.exchange_rates r
        LEFT JOIN abos.business_parties saraf ON saraf.id = r.saraf_business_party_id AND saraf.legal_entity_id = r.legal_entity_id
       WHERE r.legal_entity_id = entity AND base IN (r.unit_currency_code, r.quote_currency_code)
         AND r.rate_date BETWEEN current_date - 60 AND current_date + 1
         AND NOT EXISTS (SELECT 1 FROM abos.exchange_rates c WHERE c.supersedes_exchange_rate_id = r.id)), '[]'::jsonb));
END;
$workspace$;
