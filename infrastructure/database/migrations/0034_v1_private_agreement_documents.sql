-- Private shareholder-agreement file metadata. File bytes live in the configured private vault,
-- never in PostgreSQL or a publicly served directory. Rows and versions are immutable.
ALTER TABLE abos.capital_agreement_evidence
  ADD CONSTRAINT capital_agreement_evidence_id_entity_unique UNIQUE (id, legal_entity_id);
CREATE TABLE abos.capital_agreement_document_files (
  agreement_evidence_id uuid PRIMARY KEY REFERENCES abos.capital_agreement_evidence(id),
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  capital_agreement_id uuid NOT NULL,
  storage_id uuid NOT NULL UNIQUE,
  original_file_name text NOT NULL CHECK (length(btrim(original_file_name)) BETWEEN 1 AND 200),
  media_type text NOT NULL CHECK (media_type IN ('application/pdf', 'image/jpeg', 'image/png')),
  byte_size bigint NOT NULL CHECK (byte_size BETWEEN 1 AND 10485760),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  uploaded_by_user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  uploaded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (agreement_evidence_id, legal_entity_id)
    REFERENCES abos.capital_agreement_evidence(id, legal_entity_id),
  FOREIGN KEY (capital_agreement_id, legal_entity_id)
    REFERENCES abos.capital_agreements(id, legal_entity_id)
);
REVOKE ALL ON abos.capital_agreement_document_files FROM PUBLIC;
CREATE TRIGGER capital_agreement_document_files_no_update_or_delete
BEFORE UPDATE OR DELETE ON abos.capital_agreement_document_files
FOR EACH ROW EXECUTE FUNCTION abos.prevent_audit_mutation();

GRANT SELECT (agreement_evidence_id,legal_entity_id,capital_agreement_id,storage_id,original_file_name,
  media_type,byte_size,sha256,uploaded_by_user_account_id,uploaded_at)
  ON abos.capital_agreement_document_files TO abos_v1_shareholder_setup_owner;
GRANT INSERT (agreement_evidence_id,legal_entity_id,capital_agreement_id,storage_id,original_file_name,
  media_type,byte_size,sha256,uploaded_by_user_account_id)
  ON abos.capital_agreement_document_files TO abos_v1_shareholder_setup_owner;
-- Metadata-only evidence is no longer an application entry point once private uploads exist.
REVOKE EXECUTE ON FUNCTION abos.shareholder_setup_record_agreement_evidence(text,text,text,jsonb) FROM abos_e1_runtime;

-- Authorize an upload before any bytes are accepted by the application server. The agreement is
-- resolved only inside the actor's live legal-entity scope.
CREATE FUNCTION abos.shareholder_agreement_document_prepare(
  p_identity_proof text, p_runtime_token_sha256 text, p_token_sha256 text, p_capital_agreement_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $prepare$
DECLARE
  v_context jsonb;
  v_entity uuid;
BEGIN
  v_context := abos.shareholder_setup_actor(p_identity_proof, p_runtime_token_sha256, p_token_sha256,
    ARRAY['shareholder.setup.manage']);
  v_entity := (v_context ->> 'legalEntityId')::uuid;
  IF NOT EXISTS (SELECT 1 FROM abos.capital_agreements agreement
                  WHERE agreement.id = p_capital_agreement_id AND agreement.legal_entity_id = v_entity) THEN
    RAISE EXCEPTION 'capital agreement not found in this legal entity' USING ERRCODE = 'no_data_found';
  END IF;
  RETURN jsonb_build_object('legalEntityId', v_entity, 'capitalAgreementId', p_capital_agreement_id);
END
$prepare$;

-- Atomically link an already-durably-written private object to a new immutable agreement version.
-- The application deletes the unlinked object if this transaction fails or replays an earlier row.
CREATE FUNCTION abos.shareholder_agreement_document_finalize(
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
  IF v_document_date > current_date THEN
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

CREATE FUNCTION abos.shareholder_agreement_document_read(
  p_identity_proof text, p_runtime_token_sha256 text, p_token_sha256 text, p_agreement_evidence_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $read$
DECLARE
  v_context jsonb;
  v_entity uuid;
  v_row record;
BEGIN
  v_context := abos.shareholder_setup_actor(p_identity_proof,p_runtime_token_sha256,p_token_sha256,
    ARRAY['shareholder.setup.manage','shareholder.read']);
  v_entity := (v_context ->> 'legalEntityId')::uuid;
  SELECT file.*, link.version INTO v_row
    FROM abos.capital_agreement_document_files file
    JOIN abos.capital_agreement_evidence link ON link.id = file.agreement_evidence_id
   WHERE file.agreement_evidence_id = p_agreement_evidence_id AND file.legal_entity_id = v_entity;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'agreement document not found in this legal entity' USING ERRCODE = 'no_data_found';
  END IF;
  RETURN jsonb_build_object(
    'agreementEvidenceId',v_row.agreement_evidence_id,'capitalAgreementId',v_row.capital_agreement_id,
    'legalEntityId',v_row.legal_entity_id,'storageId',v_row.storage_id,
    'originalFileName',v_row.original_file_name,'mediaType',v_row.media_type,
    'byteSize',v_row.byte_size,'sha256',v_row.sha256,'version',v_row.version,
    'uploadedAt',v_row.uploaded_at,'replayed',false);
END
$read$;

CREATE FUNCTION abos.shareholder_agreement_document_list(
  p_identity_proof text, p_runtime_token_sha256 text, p_token_sha256 text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $list$
DECLARE
  v_context jsonb;
  v_entity uuid;
BEGIN
  v_context := abos.shareholder_setup_actor(p_identity_proof,p_runtime_token_sha256,p_token_sha256,
    ARRAY['shareholder.setup.manage','shareholder.read']);
  v_entity := (v_context ->> 'legalEntityId')::uuid;
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object(
    'agreementEvidenceId',file.agreement_evidence_id,'capitalAgreementId',file.capital_agreement_id,
    'legalEntityId',file.legal_entity_id,'storageId',file.storage_id,
    'originalFileName',file.original_file_name,'mediaType',file.media_type,
    'byteSize',file.byte_size,'sha256',file.sha256,'version',link.version,
    'uploadedAt',file.uploaded_at,'replayed',false) ORDER BY link.version)
    FROM abos.capital_agreement_document_files file
    JOIN abos.capital_agreement_evidence link ON link.id = file.agreement_evidence_id
    WHERE file.legal_entity_id = v_entity),'[]'::jsonb);
END
$list$;

ALTER FUNCTION abos.shareholder_agreement_document_prepare(text,text,text,uuid) OWNER TO abos_v1_shareholder_setup_owner;
ALTER FUNCTION abos.shareholder_agreement_document_finalize(text,text,text,jsonb) OWNER TO abos_v1_shareholder_setup_owner;
ALTER FUNCTION abos.shareholder_agreement_document_read(text,text,text,uuid) OWNER TO abos_v1_shareholder_setup_owner;
ALTER FUNCTION abos.shareholder_agreement_document_list(text,text,text) OWNER TO abos_v1_shareholder_setup_owner;
REVOKE ALL ON FUNCTION
  abos.shareholder_agreement_document_prepare(text,text,text,uuid),
  abos.shareholder_agreement_document_finalize(text,text,text,jsonb),
  abos.shareholder_agreement_document_read(text,text,text,uuid),
  abos.shareholder_agreement_document_list(text,text,text)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  abos.shareholder_agreement_document_prepare(text,text,text,uuid),
  abos.shareholder_agreement_document_finalize(text,text,text,jsonb),
  abos.shareholder_agreement_document_read(text,text,text,uuid),
  abos.shareholder_agreement_document_list(text,text,text)
TO abos_e1_runtime;
