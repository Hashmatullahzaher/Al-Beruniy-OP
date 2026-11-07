-- Malware scanning for the Document Vault. Owner decision 2026-11-07: a new document is not usable until it passes a scan, and a failed or
-- unavailable scan must never mark it clean. Deployed together with 0065. Design: docs/03-architecture/V1_DOCUMENT_VAULT_AUDIT_AND_DECISION.md.
--
-- A document with no verdict is PENDING, so the safe state is the default and nothing has to be set for it to apply.
-- A verdict is final: CLEAN and INFECTED are written once. UNAVAILABLE records an attempt and decides nothing.
-- This migration creates no permission, grants none, and writes no row.

-- 1. Scan results, append-only like the documents themselves.
CREATE TABLE abos.document_scan_results (
  id uuid PRIMARY KEY,
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  document_id uuid NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('CLEAN', 'INFECTED', 'UNAVAILABLE')),
  engine text NOT NULL CHECK (length(btrim(engine)) BETWEEN 1 AND 60),
  detail text CHECK (detail IS NULL OR length(detail) <= 200),
  scanned_by_user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  scanned_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (document_id, legal_entity_id) REFERENCES abos.documents(id, legal_entity_id)
);
CREATE INDEX document_scan_results_document_idx ON abos.document_scan_results (document_id);
-- At most one verdict per document, whatever else happens. Status therefore never depends on the order of rows or on a clock.
CREATE UNIQUE INDEX document_scan_results_one_verdict ON abos.document_scan_results (document_id) WHERE outcome <> 'UNAVAILABLE';

CREATE TRIGGER document_scan_results_no_update_or_delete BEFORE UPDATE OR DELETE ON abos.document_scan_results
  FOR EACH ROW EXECUTE FUNCTION abos.prevent_audit_mutation();

REVOKE ALL ON TABLE abos.document_scan_results FROM PUBLIC;
GRANT SELECT ON abos.document_scan_results TO abos_v1_operational_finance_owner;
GRANT INSERT (id, legal_entity_id, document_id, outcome, engine, detail, scanned_by_user_account_id)
  ON abos.document_scan_results TO abos_v1_operational_finance_owner;

-- 2. The one reading of a document's state.
CREATE FUNCTION abos.document_scan_status(p_document uuid)
RETURNS text LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $status$
  SELECT COALESCE((SELECT r.outcome FROM abos.document_scan_results r WHERE r.document_id = p_document AND r.outcome <> 'UNAVAILABLE'), 'PENDING');
$status$;

-- 3. What the server needs to scan one document. Only someone who may attach to the record can ask for a scan.
CREATE FUNCTION abos.document_scan_target(p_proof text, p_runtime text, p_token text, p_link_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $target$
DECLARE c jsonb; entity uuid; actor uuid; l abos.document_links%ROWTYPE; d abos.documents%ROWTYPE;
BEGIN
  c := abos.treasury_safe_actor(p_proof, p_runtime, p_token, NULL);
  entity := (c->>'legalEntityId')::uuid; actor := (c->>'userAccountId')::uuid;
  SELECT * INTO l FROM abos.document_links WHERE id = p_link_id AND legal_entity_id = entity;
  IF NOT FOUND OR NOT abos.document_subject_allowed(entity, actor, COALESCE(c->'permissions', '[]'::jsonb), l.subject_type, l.subject_id, true) THEN
    RAISE EXCEPTION 'document not found' USING ERRCODE = 'no_data_found';
  END IF;
  SELECT * INTO d FROM abos.documents WHERE id = l.document_id AND legal_entity_id = entity;
  RETURN jsonb_build_object('id', l.id, 'storageId', d.storage_id, 'byteSize', d.byte_size, 'sha256', d.sha256, 'scanStatus', abos.document_scan_status(d.id));
END
$target$;

-- 4. Records what the scanner said. The server calls this; no request from a browser carries an outcome. A document already decided stays decided.
CREATE FUNCTION abos.document_scan_record(p_proof text, p_runtime text, p_token text, p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $record$
DECLARE c jsonb; entity uuid; actor uuid; l abos.document_links%ROWTYPE; v_link uuid; v_outcome text; v_engine text; v_detail text; correlation uuid; v_id uuid := gen_random_uuid(); written int;
BEGIN
  c := abos.treasury_safe_actor(p_proof, p_runtime, p_token, NULL);
  entity := (c->>'legalEntityId')::uuid; actor := (c->>'userAccountId')::uuid;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_payload) k WHERE k NOT IN ('linkId', 'outcome', 'engine', 'detail', 'correlationId')) THEN
    RAISE EXCEPTION 'unknown document fields' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_link := NULLIF(p_payload->>'linkId', '')::uuid;
  SELECT * INTO l FROM abos.document_links WHERE id = v_link AND legal_entity_id = entity;
  IF NOT FOUND OR NOT abos.document_subject_allowed(entity, actor, COALESCE(c->'permissions', '[]'::jsonb), l.subject_type, l.subject_id, true) THEN
    RAISE EXCEPTION 'document not found' USING ERRCODE = 'no_data_found';
  END IF;
  v_outcome := p_payload->>'outcome'; v_engine := NULLIF(btrim(p_payload->>'engine'), ''); v_detail := NULLIF(btrim(p_payload->>'detail'), '');
  correlation := COALESCE(NULLIF(p_payload->>'correlationId', '')::uuid, gen_random_uuid());
  IF v_outcome IS NULL OR v_outcome NOT IN ('CLEAN', 'INFECTED', 'UNAVAILABLE') OR v_engine IS NULL OR length(v_engine) > 60 OR length(v_detail) > 200 THEN
    RAISE EXCEPTION 'valid scan details are required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- Two scans of one document can finish together. The index decides, and the loser records nothing.
  IF v_outcome = 'UNAVAILABLE' THEN
    IF abos.document_scan_status(l.document_id) <> 'PENDING' THEN
      RETURN jsonb_build_object('id', l.id, 'scanStatus', abos.document_scan_status(l.document_id));
    END IF;
    INSERT INTO abos.document_scan_results (id, legal_entity_id, document_id, outcome, engine, detail, scanned_by_user_account_id)
    VALUES (v_id, entity, l.document_id, v_outcome, v_engine, v_detail, actor);
    written := 1;
  ELSE
    INSERT INTO abos.document_scan_results (id, legal_entity_id, document_id, outcome, engine, detail, scanned_by_user_account_id)
    VALUES (v_id, entity, l.document_id, v_outcome, v_engine, v_detail, actor)
    ON CONFLICT (document_id) WHERE outcome <> 'UNAVAILABLE' DO NOTHING;
    GET DIAGNOSTICS written = ROW_COUNT;
  END IF;
  IF written = 1 THEN
    PERFORM abos.money_audit(actor, entity, correlation, 'DOCUMENT_SCANNED', 'DOCUMENT', l.id, jsonb_build_object('documentId', l.document_id, 'outcome', v_outcome, 'engine', v_engine, 'detail', v_detail));
  END IF;
  RETURN jsonb_build_object('id', l.id, 'scanStatus', abos.document_scan_status(l.document_id));
END
$record$;

-- 5. The list now says where each document stands.
CREATE OR REPLACE FUNCTION abos.document_list(p_proof text, p_runtime text, p_token text, p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $list$
DECLARE c jsonb; entity uuid; actor uuid; perms jsonb; v_type text; v_id uuid; can_read boolean; can_attach boolean;
BEGIN
  c := abos.treasury_safe_actor(p_proof, p_runtime, p_token, NULL);
  entity := (c->>'legalEntityId')::uuid; actor := (c->>'userAccountId')::uuid; perms := COALESCE(c->'permissions', '[]'::jsonb);
  v_type := p_payload->>'subjectType'; v_id := abos.document_request_subject(entity, p_payload);
  can_read := v_id IS NOT NULL AND abos.document_subject_allowed(entity, actor, perms, v_type, v_id, false);
  can_attach := v_id IS NOT NULL AND abos.document_subject_allowed(entity, actor, perms, v_type, v_id, true);
  IF NOT can_read AND NOT can_attach THEN
    RAISE EXCEPTION 'document subject not found' USING ERRCODE = 'no_data_found';
  END IF;
  RETURN jsonb_build_object('canRead', can_read, 'canAttach', can_attach, 'documents', CASE WHEN can_read THEN COALESCE((
    SELECT jsonb_agg(jsonb_build_object('id', l.id, 'title', l.title, 'documentDate', l.document_date, 'fileName', d.original_file_name, 'mediaType', d.media_type,
      'byteSize', d.byte_size, 'attachedAt', l.linked_at, 'scanStatus', abos.document_scan_status(d.id)) ORDER BY l.linked_at, l.id)
    FROM abos.document_links l JOIN abos.documents d ON d.id = l.document_id AND d.legal_entity_id = l.legal_entity_id
    WHERE l.legal_entity_id = entity AND l.subject_type = v_type AND l.subject_id = v_id), '[]'::jsonb) ELSE '[]'::jsonb END);
END
$list$;

-- 6. Only a document that passed can be opened. The check comes after authorization, so a stranger still learns nothing, not even that a scan is pending.
CREATE OR REPLACE FUNCTION abos.document_open(p_proof text, p_runtime text, p_token text, p_link_id uuid, p_correlation_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $open$
DECLARE c jsonb; entity uuid; actor uuid; l abos.document_links%ROWTYPE; d abos.documents%ROWTYPE;
BEGIN
  c := abos.treasury_safe_actor(p_proof, p_runtime, p_token, NULL);
  entity := (c->>'legalEntityId')::uuid; actor := (c->>'userAccountId')::uuid;
  SELECT * INTO l FROM abos.document_links WHERE id = p_link_id AND legal_entity_id = entity;
  IF NOT FOUND OR NOT abos.document_subject_allowed(entity, actor, COALESCE(c->'permissions', '[]'::jsonb), l.subject_type, l.subject_id, false) THEN
    RAISE EXCEPTION 'document not found' USING ERRCODE = 'no_data_found';
  END IF;
  SELECT * INTO d FROM abos.documents WHERE id = l.document_id AND legal_entity_id = entity;
  IF abos.document_scan_status(d.id) <> 'CLEAN' THEN
    RAISE EXCEPTION 'document is not cleared for opening' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  PERFORM abos.money_audit(actor, entity, COALESCE(p_correlation_id, gen_random_uuid()), 'DOCUMENT_OPENED', 'DOCUMENT', l.id, jsonb_build_object('documentId', d.id,
    'subjectType', l.subject_type, 'subjectId', l.subject_id, 'mediaType', d.media_type, 'byteSize', d.byte_size, 'sha256', d.sha256));
  RETURN jsonb_build_object('id', l.id, 'storageId', d.storage_id, 'fileName', d.original_file_name, 'mediaType', d.media_type, 'byteSize', d.byte_size, 'sha256', d.sha256);
END
$open$;

-- 7. Everything the vault should hold, for read-only reconciliation by an operator. The runtime cannot call it.
CREATE FUNCTION abos.document_vault_manifest()
RETURNS TABLE (storage_id uuid, byte_size bigint, sha256 text, source text, scan_status text) LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $manifest$
  SELECT f.storage_id, f.byte_size, f.sha256, 'AGREEMENT'::text, NULL::text FROM abos.capital_agreement_document_files f
  UNION ALL
  SELECT d.storage_id, d.byte_size, d.sha256, 'DOCUMENT'::text, abos.document_scan_status(d.id) FROM abos.documents d
  ORDER BY 1;
$manifest$;

-- 8. Privileges. The two new entry points are the runtime's only way in.
REVOKE ALL ON FUNCTION abos.document_scan_status(uuid), abos.document_vault_manifest() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION abos.document_scan_status(uuid) TO abos_v1_operational_finance_owner;
ALTER FUNCTION abos.document_scan_target(text, text, text, uuid) OWNER TO abos_v1_operational_finance_owner;
ALTER FUNCTION abos.document_scan_record(text, text, text, jsonb) OWNER TO abos_v1_operational_finance_owner;
REVOKE ALL ON FUNCTION abos.document_scan_target(text, text, text, uuid), abos.document_scan_record(text, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION abos.document_scan_target(text, text, text, uuid), abos.document_scan_record(text, text, text, jsonb) TO abos_e1_runtime;
