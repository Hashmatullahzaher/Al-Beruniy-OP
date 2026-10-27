-- Slice 1 follow-up (finding D3-F1): the shareholder setup lane judges "today" on the Kabul business
-- day, abos.business_today() (0040), instead of PostgreSQL's current_date, which follows the session
-- time zone (UTC on the production database). Between 00:00 and 04:30 Kabul time the two differ by a
-- day: a shareholder dated "today" was refused as "in the future" while the money arriving that day
-- was accepted by the direct capital lane.
--
-- Eight functions are restated from their latest definitions, verbatim except that current_date
-- becomes abos.business_today(). CREATE OR REPLACE keeps every owner, signature, security setting,
-- search_path and privilege. The frozen E1 functions that also read current_date are not touched.
-- One grant is added: the shareholder setup owner may read the business day (the restated definer
-- functions and the profile trigger run as that owner). Zero business-data change.

GRANT EXECUTE ON FUNCTION abos.business_today() TO abos_v1_shareholder_setup_owner;

-- shareholder_setup_create_shareholder (latest: 0031_v1_shareholder_setup.sql; 1 occurrence): refused a shareholder-since date after the UTC day; called by direct_shareholder_add (0040), so the owner's one-save flow was refused nightly.
CREATE OR REPLACE FUNCTION abos.shareholder_setup_create_shareholder(
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
  IF v_since > abos.business_today() THEN
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

-- shareholder_setup_record_agreement_evidence (latest: 0031_v1_shareholder_setup.sql; 1 occurrence): refused a document date after the UTC day (legacy evidence path; no runtime grant since 0034, restated for consistency).
CREATE OR REPLACE FUNCTION abos.shareholder_setup_record_agreement_evidence(
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
  IF v_document_date > abos.business_today() THEN
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

-- shareholder_agreement_document_finalize (latest: 0034_v1_private_agreement_documents.sql; 1 occurrence): refused an agreement document dated after the UTC day.
CREATE OR REPLACE FUNCTION abos.shareholder_agreement_document_finalize(
  p_identity_proof text, p_runtime_token_sha256 text, p_token_sha256 text, p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $finalize$
DECLARE
  v_context jsonb;
  v_actor uuid;
  v_entity uuid;
  v_agreement uuid;
  v_storage uuid;
  v_file_name text;
  v_media_type text;
  v_byte_size bigint;
  v_sha256 text;
  v_reference text;
  v_document_date date;
  v_key text;
  v_correlation uuid;
  v_scope text;
  v_fingerprint text;
  v_replay jsonb;
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
       SELECT 1 FROM jsonb_object_keys(p_payload) k WHERE k NOT IN
        ('capitalAgreementId','storageId','originalFileName','mediaType','byteSize','sha256',
         'documentReference','documentDate','idempotencyKey','correlationId')) THEN
    RAISE EXCEPTION 'unknown or missing agreement document fields' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_agreement := NULLIF(p_payload ->> 'capitalAgreementId', '')::uuid;
  v_storage := NULLIF(p_payload ->> 'storageId', '')::uuid;
  v_file_name := NULLIF(btrim(p_payload ->> 'originalFileName'), '');
  v_media_type := NULLIF(p_payload ->> 'mediaType', '');
  v_byte_size := NULLIF(p_payload ->> 'byteSize', '')::bigint;
  v_sha256 := lower(NULLIF(btrim(p_payload ->> 'sha256'), ''));
  v_reference := NULLIF(btrim(p_payload ->> 'documentReference'), '');
  v_document_date := NULLIF(p_payload ->> 'documentDate', '')::date;
  v_key := NULLIF(btrim(p_payload ->> 'idempotencyKey'), '');
  v_correlation := NULLIF(p_payload ->> 'correlationId', '')::uuid;
  IF v_agreement IS NULL OR v_storage IS NULL OR v_file_name IS NULL OR length(v_file_name) > 200
     OR v_media_type NOT IN ('application/pdf','image/jpeg','image/png')
     OR v_byte_size NOT BETWEEN 1 AND 10485760 OR v_sha256 !~ '^[0-9a-f]{64}$'
     OR v_reference IS NULL OR length(v_reference) > 200 OR v_document_date IS NULL
     OR v_key IS NULL OR length(v_key) > 200 OR v_correlation IS NULL THEN
    RAISE EXCEPTION 'valid agreement document metadata is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_document_date > abos.business_today() THEN
    RAISE EXCEPTION 'the document date cannot be in the future' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM abos.capital_agreements agreement
                  WHERE agreement.id = v_agreement AND agreement.legal_entity_id = v_entity) THEN
    RAISE EXCEPTION 'capital agreement not found in this legal entity' USING ERRCODE = 'no_data_found';
  END IF;
  v_scope := v_entity::text || ':SHAREHOLDER_AGREEMENT_FILE';
  v_fingerprint := encode(sha256(convert_to(jsonb_build_object(
    'actor',v_actor,'agreement',v_agreement,'fileName',v_file_name,'mediaType',v_media_type,
    'byteSize',v_byte_size,'sha256',v_sha256,'reference',v_reference,'date',v_document_date)::text,'UTF8')),'hex');
  v_replay := abos.shareholder_setup_idempotency_begin(v_scope, v_key, v_fingerprint, v_correlation);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('abos-agreement-evidence:' || v_agreement::text, 0));
  SELECT coalesce(max(link.version), 0) + 1 INTO v_version
    FROM abos.capital_agreement_evidence link WHERE link.capital_agreement_id = v_agreement;
  INSERT INTO abos.evidence_references
    (id, legal_entity_id, document_id, evidence_kind, evidence_version, sha256, completed_at)
  VALUES (v_evidence, v_entity, pg_catalog.gen_random_uuid(), 'CAPITAL_AGREEMENT', 1, v_sha256, clock_timestamp());
  INSERT INTO abos.capital_agreement_evidence
    (id, legal_entity_id, capital_agreement_id, evidence_reference_id, version, document_reference,
     document_date, recorded_by_user_account_id)
  VALUES (v_link, v_entity, v_agreement, v_evidence, v_version, v_reference, v_document_date, v_actor);
  INSERT INTO abos.capital_agreement_document_files
    (agreement_evidence_id, legal_entity_id, capital_agreement_id, storage_id, original_file_name,
     media_type, byte_size, sha256, uploaded_by_user_account_id)
  VALUES (v_link, v_entity, v_agreement, v_storage, v_file_name, v_media_type, v_byte_size, v_sha256, v_actor);
  v_response := jsonb_build_object(
    'agreementEvidenceId',v_link,'evidenceReferenceId',v_evidence,
    'capitalAgreementId',v_agreement,'legalEntityId',v_entity,
    'storageId',v_storage,'originalFileName',v_file_name,'mediaType',v_media_type,
    'byteSize',v_byte_size,'sha256',v_sha256,'version',v_version,
    'uploadedAt',clock_timestamp(),'replayed',false);
  PERFORM abos.shareholder_setup_audit(v_actor,v_entity,v_correlation,'CAPITAL_AGREEMENT_DOCUMENT_UPLOADED',
    'CAPITAL_AGREEMENT',v_agreement,NULL,jsonb_build_object(
      'agreementEvidenceId',v_link,'version',v_version,'mediaType',v_media_type,
      'byteSize',v_byte_size,'sha256',v_sha256));
  PERFORM abos.shareholder_setup_idempotency_complete(v_scope,v_key,'CAPITAL_AGREEMENT_EVIDENCE',v_link,v_response);
  RETURN v_response;
END
$finalize$;

-- shareholder_contribution_fields (latest: 0035_v1_shareholder_contributions.sql; 1 occurrence): bounded a contribution's date at the UTC day plus ten years.
CREATE OR REPLACE FUNCTION abos.shareholder_contribution_fields(p_type text, p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $fields$
DECLARE
  v_date date;
  v_description text := NULLIF(btrim(p_payload ->> 'description'), '');
  v_reference text := NULLIF(btrim(p_payload ->> 'reference'), '');
  v_currency text;
  v_category text;
  v_item text;
  v_quantity numeric;
  v_unit text;
  v_note text;
  v_estimate numeric;
  v_valuation_currency text;
  v_amount numeric;
BEGIN
  BEGIN
    v_date := NULLIF(p_payload ->> 'businessDate', '')::date;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'the contribution date is not a valid date' USING ERRCODE = 'invalid_parameter_value';
  END;
  IF v_date IS NULL OR v_date < DATE '1950-01-01' OR v_date > abos.business_today() + 3650 THEN
    RAISE EXCEPTION 'a contribution date is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF (v_description IS NOT NULL AND length(v_description) > 1000) OR (v_reference IS NOT NULL AND length(v_reference) > 100) THEN
    RAISE EXCEPTION 'the description (at most 1000 characters) or reference (at most 100 characters) is too long'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  CASE p_type
    WHEN 'CASH', 'CREDIT' THEN
      IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_payload) k
                  WHERE k IN ('assetCategory', 'itemName', 'quantity', 'unit', 'ownershipNote', 'estimatedValue', 'valuationCurrencyCode')
                    AND p_payload ->> k IS NOT NULL AND p_payload ->> k <> '') THEN
        RAISE EXCEPTION 'asset fields do not apply to a % contribution', lower(p_type) USING ERRCODE = 'invalid_parameter_value';
      END IF;
      v_amount := abos.shareholder_setup_amount(p_payload ->> 'amount');
      v_currency := upper(NULLIF(btrim(p_payload ->> 'currencyCode'), ''));
      IF v_currency IS NULL OR NOT EXISTS (SELECT 1 FROM abos.currencies c WHERE c.code = v_currency AND c.enabled) THEN
        RAISE EXCEPTION 'an enabled currency is required' USING ERRCODE = 'invalid_parameter_value';
      END IF;
      IF p_type = 'CREDIT' AND v_description IS NULL THEN
        RAISE EXCEPTION 'a credit contribution needs a description' USING ERRCODE = 'invalid_parameter_value';
      END IF;
      RETURN jsonb_build_object('businessDate', v_date, 'description', v_description, 'reference', v_reference,
        'amount', v_amount::text, 'currencyCode', v_currency);
    WHEN 'IN_KIND' THEN
      IF NULLIF(p_payload ->> 'amount', '') IS NOT NULL OR NULLIF(p_payload ->> 'currencyCode', '') IS NOT NULL THEN
        RAISE EXCEPTION 'an asset contribution has no cash amount; use the optional estimated value'
          USING ERRCODE = 'invalid_parameter_value';
      END IF;
      v_category := NULLIF(btrim(p_payload ->> 'assetCategory'), '');
      v_item := NULLIF(btrim(p_payload ->> 'itemName'), '');
      v_unit := NULLIF(btrim(p_payload ->> 'unit'), '');
      v_note := NULLIF(btrim(p_payload ->> 'ownershipNote'), '');
      v_valuation_currency := upper(NULLIF(btrim(p_payload ->> 'valuationCurrencyCode'), ''));
      IF v_category IS NULL OR v_category NOT IN ('LAND_PROPERTY', 'EQUIPMENT_MACHINERY', 'GOODS_MATERIALS', 'OTHER') THEN
        RAISE EXCEPTION 'choose an asset category' USING ERRCODE = 'invalid_parameter_value';
      END IF;
      IF v_item IS NULL OR length(v_item) > 200 OR (v_unit IS NOT NULL AND length(v_unit) > 40)
         OR (v_note IS NOT NULL AND length(v_note) > 1000) THEN
        RAISE EXCEPTION 'an item name (at most 200 characters) is required; unit and note must be short'
          USING ERRCODE = 'invalid_parameter_value';
      END IF;
      IF NULLIF(p_payload ->> 'quantity', '') IS NOT NULL THEN
        v_quantity := abos.shareholder_setup_amount(p_payload ->> 'quantity');
      ELSIF v_unit IS NOT NULL THEN
        RAISE EXCEPTION 'a unit needs a quantity' USING ERRCODE = 'invalid_parameter_value';
      END IF;
      IF NULLIF(p_payload ->> 'estimatedValue', '') IS NOT NULL THEN
        v_estimate := abos.shareholder_setup_amount(p_payload ->> 'estimatedValue');
        IF v_valuation_currency IS NULL OR NOT EXISTS (SELECT 1 FROM abos.currencies c WHERE c.code = v_valuation_currency AND c.enabled) THEN
          RAISE EXCEPTION 'an estimated value needs an enabled valuation currency' USING ERRCODE = 'invalid_parameter_value';
        END IF;
      ELSIF v_valuation_currency IS NOT NULL THEN
        RAISE EXCEPTION 'a valuation currency needs an estimated value' USING ERRCODE = 'invalid_parameter_value';
      END IF;
      RETURN jsonb_build_object('businessDate', v_date, 'description', v_description, 'reference', v_reference,
        'assetCategory', v_category, 'itemName', v_item, 'quantity', v_quantity::text, 'unit', v_unit,
        'ownershipNote', v_note, 'estimatedValue', v_estimate::text, 'valuationCurrencyCode', v_valuation_currency);
    ELSE
      RAISE EXCEPTION 'choose a contribution type: CASH, IN_KIND or CREDIT' USING ERRCODE = 'invalid_parameter_value';
  END CASE;
END
$fields$;

-- shareholder_setup_workspace (latest: 0038_v1_shareholder_capital_activation.sql; 1 occurrence): returned today as the UTC day, which the forms use as default and ceiling.
CREATE OR REPLACE FUNCTION abos.shareholder_setup_workspace(
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
    ARRAY['shareholder.setup.manage', 'shareholder.read', 'shareholder.capital-receipt.read']);
  v_entity := (v_context ->> 'legalEntityId')::uuid;
  v_permissions := COALESCE(v_context -> 'permissions', '[]'::jsonb);
  v_funding := EXISTS (SELECT 1 FROM abos.capital_agreement_funding_policies p WHERE p.legal_entity_id = v_entity);
  RETURN jsonb_build_object(
    'legalEntity', (SELECT jsonb_build_object('id', entity.id, 'name', entity.name, 'baseCurrency', entity.base_currency_code)
                      FROM abos.legal_entities entity WHERE entity.id = v_entity),
    'permissions', jsonb_build_object(
      'canManage', v_permissions ? 'shareholder.setup.manage',
      'canCreateRequests', v_permissions ? 'shareholder.capital-request.create',
      'canReadAgreementDocuments', v_permissions ?| ARRAY['shareholder.setup.manage','shareholder.read']),
    'today', abos.business_today(),
    -- The downstream path (Capital Request -> Treasury -> Finance -> GL) is not operational in V1.
    'receiptPathOperational', false,
    'agreementDocumentRequirement', COALESCE((SELECT policy.document_requirement
      FROM abos.capital_agreement_document_policies policy WHERE policy.legal_entity_id = v_entity), 'REQUIRED'),
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
                     CASE WHEN COALESCE((SELECT policy.document_requirement FROM abos.capital_agreement_document_policies policy
                                          WHERE policy.legal_entity_id = v_entity), 'REQUIRED') = 'REQUIRED'
                           AND NOT EXISTS (SELECT 1 FROM abos.capital_agreement_evidence link
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

-- shareholder_contributions_workspace (latest: 0038_v1_shareholder_capital_activation.sql; 1 occurrence): returned today as the UTC day, which the forms use as default and ceiling.
CREATE OR REPLACE FUNCTION abos.shareholder_contributions_workspace(
  p_identity_proof text, p_runtime_token_sha256 text, p_token_sha256 text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $workspace$
DECLARE
  v_context jsonb;
  v_entity uuid;
  v_permissions jsonb;
BEGIN
  v_context := abos.shareholder_setup_actor(p_identity_proof, p_runtime_token_sha256, p_token_sha256,
    ARRAY['shareholder.setup.manage', 'shareholder.read', 'shareholder.capital-receipt.read']);
  v_entity := (v_context ->> 'legalEntityId')::uuid;
  v_permissions := COALESCE(v_context -> 'permissions', '[]'::jsonb);
  RETURN jsonb_build_object(
    'legalEntity', (SELECT jsonb_build_object('id', entity.id, 'name', entity.name, 'baseCurrency', entity.base_currency_code)
                      FROM abos.legal_entities entity WHERE entity.id = v_entity),
    'permissions', jsonb_build_object('canManage', v_permissions ? 'shareholder.setup.manage'),
    'today', abos.business_today(),
    'currencies', COALESCE((SELECT jsonb_agg(c.code ORDER BY c.code) FROM abos.currencies c WHERE c.enabled), '[]'::jsonb),
    'shareholders', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', profile.id, 'businessPartyId', party.id, 'name', party.display_name,
               'reference', party.external_reference, 'status', profile.status,
               'since', (SELECT min(role.effective_from) FROM abos.business_party_roles role
                          WHERE role.business_party_id = party.id AND role.role_code = 'SHAREHOLDER'),
               'contributions', COALESCE((
                 SELECT jsonb_agg(jsonb_build_object(
                          'id', c.id, 'type', c.contribution_type, 'businessDate', c.business_date,
                          'description', c.description, 'reference', c.reference,
                          'recordStatus', c.record_status, 'receiptStatus', c.receipt_status,
                          'valuationStatus', c.valuation_status, 'amount', c.amount::text, 'currency', c.currency_code,
                          'assetCategory', c.asset_category, 'itemName', c.item_name, 'quantity', c.quantity::text,
                          'unit', c.unit, 'ownershipNote', c.ownership_note, 'estimatedValue', c.estimated_value::text,
                          'valuationCurrency', c.valuation_currency_code, 'creditClassification', c.credit_classification,
                          'version', c.version, 'createdAt', c.created_at, 'createdBy', creator.display_name,
                          'cancellationReason', c.cancellation_reason,
                          'editable', c.record_status IN ('DRAFT', 'DECLARED'))
                        ORDER BY (c.record_status = 'CANCELLED'), c.business_date, c.created_at)
                   FROM abos.shareholder_contributions c
                   JOIN abos.user_accounts creator ON creator.id = c.created_by_user_account_id
                  WHERE c.shareholder_profile_id = profile.id AND c.legal_entity_id = v_entity), '[]'::jsonb),
               -- Declared amounts per type and currency. Estimates are reported separately and never
               -- added to CASH or CREDIT; cancelled rows and legacy agreements are excluded.
               'declaredTotals', COALESCE((
                 SELECT jsonb_agg(jsonb_build_object('type', t.contribution_type, 'currency', t.currency_code,
                                                     'amount', t.total::text) ORDER BY t.contribution_type, t.currency_code)
                   FROM (SELECT c.contribution_type, c.currency_code, sum(c.amount) AS total
                           FROM abos.shareholder_contributions c
                          WHERE c.shareholder_profile_id = profile.id AND c.legal_entity_id = v_entity
                            AND c.contribution_type IN ('CASH', 'CREDIT') AND c.record_status <> 'CANCELLED'
                          GROUP BY c.contribution_type, c.currency_code) t), '[]'::jsonb),
               'estimatedAssetTotals', COALESCE((
                 SELECT jsonb_agg(jsonb_build_object('currency', t.valuation_currency_code, 'amount', t.total::text)
                                  ORDER BY t.valuation_currency_code)
                   FROM (SELECT c.valuation_currency_code, sum(c.estimated_value) AS total
                           FROM abos.shareholder_contributions c
                          WHERE c.shareholder_profile_id = profile.id AND c.legal_entity_id = v_entity
                            AND c.contribution_type = 'IN_KIND' AND c.estimated_value IS NOT NULL
                            AND c.record_status <> 'CANCELLED'
                          GROUP BY c.valuation_currency_code) t), '[]'::jsonb),
               'legacyCashAgreements', COALESCE((
                 SELECT jsonb_agg(jsonb_build_object(
                          'id', agreement.id, 'reference', agreement.agreement_reference, 'kind', agreement.agreement_kind,
                          'committed', agreement.committed_amount::text, 'currency', agreement.currency_code,
                          'status', agreement.status, 'effectiveOn', agreement.effective_on,
                          'installmentCount', (SELECT count(*) FROM abos.capital_installments i
                                                WHERE i.capital_agreement_id = agreement.id AND i.status <> 'CANCELLED'),
                          'planned', (SELECT coalesce(sum(i.expected_amount), 0) FROM abos.capital_installments i
                                       WHERE i.capital_agreement_id = agreement.id AND i.status <> 'CANCELLED')::text)
                        ORDER BY agreement.effective_on, agreement.agreement_reference)
                   FROM abos.capital_agreements agreement
                  WHERE agreement.shareholder_profile_id = profile.id AND agreement.legal_entity_id = v_entity), '[]'::jsonb))
             ORDER BY party.display_name, profile.id)
        FROM abos.shareholder_profiles profile
        JOIN abos.business_parties party ON party.id = profile.business_party_id AND party.legal_entity_id = profile.legal_entity_id
       WHERE profile.legal_entity_id = v_entity), '[]'::jsonb));
END
$workspace$;

-- direct_shareholder_document_holder (latest: 0040_v1_direct_shareholder_capital.sql; 1 occurrence): dated the attachment holder agreement on the UTC day.
CREATE OR REPLACE FUNCTION abos.direct_shareholder_document_holder(p_proof text,p_runtime text,p_token text,p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE c jsonb; entity uuid; profile uuid; holder uuid; currency text; total numeric; result jsonb;
BEGIN
 c:=abos.shareholder_setup_actor(p_proof,p_runtime,p_token,ARRAY['shareholder.setup.manage']);
 IF c->>'sessionProvenance' IS DISTINCT FROM 'PASSWORD_OPERATIONAL' THEN
  RAISE EXCEPTION 'an operational password session is required' USING ERRCODE='insufficient_privilege'; END IF;
 entity:=(c->>'legalEntityId')::uuid; profile:=(p_payload->>'shareholderProfileId')::uuid;
 PERFORM pg_advisory_xact_lock(hashtextextended('direct-capital-document:'||entity::text||':'||profile::text,0));
 SELECT capital_document_agreement_id INTO holder FROM abos.shareholder_profiles
 WHERE id=profile AND legal_entity_id=entity AND status='ACTIVE';
 IF NOT FOUND THEN RAISE EXCEPTION 'shareholder not found in this legal entity' USING ERRCODE='no_data_found'; END IF;
 IF holder IS NOT NULL THEN RETURN jsonb_build_object('capitalAgreementId',holder); END IF;
 -- An agreed total is optional, so the holder's committed amount falls back to what was actually
 -- contributed. The holder is a private attachment anchor only; it activates no agreement.
 SELECT currency_code,sum(amount) INTO currency,total FROM abos.shareholder_contributions
 WHERE shareholder_profile_id=profile AND legal_entity_id=entity AND contribution_type='CASH' AND record_status='DECLARED'
 GROUP BY currency_code ORDER BY currency_code LIMIT 1;
 IF total IS NULL THEN
  SELECT original_currency_code,sum(original_amount) INTO currency,total FROM abos.direct_capital_receipts
  WHERE shareholder_profile_id=profile AND legal_entity_id=entity
  GROUP BY original_currency_code ORDER BY original_currency_code LIMIT 1;
 END IF;
 IF total IS NULL THEN RAISE EXCEPTION 'record the shareholder capital before attaching a document' USING ERRCODE='check_violation'; END IF;
 result:=abos.shareholder_setup_create_agreement(p_proof,p_runtime,p_token,jsonb_build_object(
  'shareholderProfileId',profile,'agreementReference','ATTACHMENT-'||profile::text,
  'committedAmount',total::text,'currencyCode',currency,'effectiveOn',abos.business_today(),'partialInstallmentsAllowed',true,
  'idempotencyKey','DOC-HOLDER-'||profile::text,'correlationId',gen_random_uuid()));
 holder:=(result->>'capitalAgreementId')::uuid;
 UPDATE abos.shareholder_profiles SET capital_document_agreement_id=holder WHERE id=profile AND legal_entity_id=entity;
 RETURN jsonb_build_object('capitalAgreementId',holder);
END $$;

-- validate_shareholder_profile_role (latest: 0001_e0_finance_foundation.sql; 2 occurrences): (trigger shareholder_profiles_role_guard) required a SHAREHOLDER role effective on the UTC day, so a shareholder whose role starts on the Kabul day was refused between 00:00 and 04:30 Kabul time even after the creation check is fixed.
CREATE OR REPLACE FUNCTION abos.validate_shareholder_profile_role()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM abos.business_party_roles role
     WHERE role.business_party_id = NEW.business_party_id
       AND role.role_code = 'SHAREHOLDER'
       AND role.effective_from <= abos.business_today()
       AND (role.effective_to IS NULL OR role.effective_to >= abos.business_today())
  ) THEN
    RAISE EXCEPTION 'shareholder profile requires a current SHAREHOLDER business-party role';
  END IF;
  RETURN NEW;
END;
$$;
