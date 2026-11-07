-- Agreements join the Document Vault. Owner decisions 2026-11-07: one canonical vault; a new agreement file goes through the same quarantine
-- and malware scan as every other document; the older agreement upload lane is retired; the existing agreement file is kept, never rewritten,
-- and enters the vault only through an explicit, guarded operator import. Design: docs/03-architecture/V1_DOCUMENT_VAULT_AGREEMENTS_0067.md.
--
-- Ships with 0065 and 0066, none of which is deployed. It creates no permission, grants none to a person, and writes no row.

-- 1. A capital agreement is a subject. Its documents follow the agreement's own permissions, as the older lane did.
ALTER TABLE abos.document_links DROP CONSTRAINT document_links_subject_type_check;
ALTER TABLE abos.document_links ADD CONSTRAINT document_links_subject_type_check
  CHECK (subject_type IN ('COMPANY', 'SHAREHOLDER', 'LOAN', 'EXPENSE', 'RECEIPT', 'PAYMENT', 'AGREEMENT'));

GRANT SELECT (agreement_reference) ON abos.capital_agreements TO abos_v1_operational_finance_owner;

CREATE OR REPLACE FUNCTION abos.document_subject_allowed(p_entity uuid, p_actor uuid, p_permissions jsonb, p_type text, p_id uuid, p_attach boolean)
RETURNS boolean LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $allowed$
BEGIN
  IF NOT (CASE p_type
    WHEN 'COMPANY' THEN p_permissions ? 'admin.company.manage'
    WHEN 'SHAREHOLDER' THEN CASE WHEN p_attach THEN p_permissions ? 'shareholder.setup.manage' ELSE p_permissions ?| ARRAY['shareholder.read', 'shareholder.setup.manage'] END
    WHEN 'AGREEMENT' THEN CASE WHEN p_attach THEN p_permissions ? 'shareholder.setup.manage' ELSE p_permissions ?| ARRAY['shareholder.read', 'shareholder.setup.manage'] END
    WHEN 'LOAN' THEN CASE WHEN p_attach THEN p_permissions ?| ARRAY['finance.loan.record', 'finance.loan.repay'] ELSE p_permissions ? 'finance.loan.read' END
    WHEN 'EXPENSE' THEN p_permissions ? CASE WHEN p_attach THEN 'finance.expense.create' ELSE 'finance.expense.read' END
    WHEN 'RECEIPT' THEN p_permissions ? CASE WHEN p_attach THEN 'treasury.receipt.record' ELSE 'treasury.safe.read' END
    WHEN 'PAYMENT' THEN p_permissions ? CASE WHEN p_attach THEN 'treasury.payment.record' ELSE 'treasury.safe.read' END
    ELSE false END) THEN
    RETURN false;
  END IF;
  RETURN CASE p_type
    WHEN 'COMPANY' THEN p_id = p_entity
    WHEN 'SHAREHOLDER' THEN EXISTS (SELECT 1 FROM abos.shareholder_profiles s WHERE s.id = p_id AND s.legal_entity_id = p_entity)
    WHEN 'AGREEMENT' THEN EXISTS (SELECT 1 FROM abos.capital_agreements a WHERE a.id = p_id AND a.legal_entity_id = p_entity)
    WHEN 'LOAN' THEN EXISTS (SELECT 1 FROM abos.loans l WHERE l.id = p_id AND l.legal_entity_id = p_entity)
    WHEN 'EXPENSE' THEN EXISTS (SELECT 1 FROM abos.operational_expenses e WHERE e.id = p_id AND e.legal_entity_id = p_entity)
      AND abos.operational_expense_actor_in_scope(p_id, p_entity, p_actor)
    WHEN 'RECEIPT' THEN EXISTS (SELECT 1 FROM abos.treasury_cash_receipts r WHERE r.id = p_id AND r.legal_entity_id = p_entity)
    WHEN 'PAYMENT' THEN EXISTS (SELECT 1 FROM abos.treasury_payments p WHERE p.id = p_id AND p.legal_entity_id = p_entity)
    ELSE false END;
END
$allowed$;

-- 2. An agreement document needs its date, because the agreement's evidence record requires one. Otherwise attaching is unchanged from 0065.
CREATE OR REPLACE FUNCTION abos.document_attach(p_proof text, p_runtime text, p_token text, p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $attach$
DECLARE c jsonb; entity uuid; actor uuid; v_type text; v_id uuid; storage uuid; file_name text; media text; size bigint; hash text; v_title text; day date;
  key text; correlation uuid; scope text; fingerprint text; replay jsonb; result jsonb; v_document uuid := gen_random_uuid(); v_link uuid := gen_random_uuid();
BEGIN
  c := abos.treasury_safe_actor(p_proof, p_runtime, p_token, NULL);
  entity := (c->>'legalEntityId')::uuid; actor := (c->>'userAccountId')::uuid;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_payload) k WHERE k NOT IN
      ('subjectType', 'subjectId', 'storageId', 'originalFileName', 'mediaType', 'byteSize', 'sha256', 'title', 'documentDate', 'idempotencyKey', 'correlationId')) THEN
    RAISE EXCEPTION 'unknown document fields' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_type := p_payload->>'subjectType'; v_id := abos.document_request_subject(entity, p_payload);
  IF v_id IS NULL OR NOT abos.document_subject_allowed(entity, actor, COALESCE(c->'permissions', '[]'::jsonb), v_type, v_id, true) THEN
    RAISE EXCEPTION 'document subject not found' USING ERRCODE = 'no_data_found';
  END IF;
  storage := NULLIF(p_payload->>'storageId', '')::uuid; file_name := NULLIF(btrim(p_payload->>'originalFileName'), ''); media := NULLIF(p_payload->>'mediaType', '');
  size := NULLIF(p_payload->>'byteSize', '')::bigint; hash := lower(NULLIF(btrim(p_payload->>'sha256'), '')); v_title := NULLIF(btrim(p_payload->>'title'), '');
  day := NULLIF(p_payload->>'documentDate', '')::date; key := NULLIF(btrim(p_payload->>'idempotencyKey'), ''); correlation := NULLIF(p_payload->>'correlationId', '')::uuid;
  IF storage IS NULL OR file_name IS NULL OR length(file_name) > 200 OR media IS NULL OR media NOT IN ('application/pdf', 'image/jpeg', 'image/png')
     OR size IS NULL OR size NOT BETWEEN 1 AND 10485760 OR hash IS NULL OR hash !~ '^[0-9a-f]{64}$' OR v_title IS NULL OR length(v_title) > 200 THEN
    RAISE EXCEPTION 'valid document details are required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_type = 'AGREEMENT' AND day IS NULL THEN
    RAISE EXCEPTION 'an agreement document needs its date' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF day > abos.business_today() THEN
    RAISE EXCEPTION 'the document date cannot be in the future' USING ERRCODE = 'check_violation';
  END IF;
  scope := 'document:attach:' || entity::text || ':' || actor::text;
  fingerprint := encode(sha256(convert_to(jsonb_build_object('type', v_type, 'id', v_id, 'name', file_name, 'media', media, 'size', size, 'hash', hash,
    'title', v_title, 'date', day, 'actor', actor)::text, 'UTF8')), 'hex');
  replay := abos.temporary_funding_idempotency_begin(scope, key, fingerprint, correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  INSERT INTO abos.documents (id, legal_entity_id, storage_id, original_file_name, media_type, byte_size, sha256, uploaded_by_user_account_id)
  VALUES (v_document, entity, storage, file_name, media, size, hash, actor);
  INSERT INTO abos.document_links (id, legal_entity_id, document_id, subject_type, subject_id, title, document_date, linked_by_user_account_id)
  VALUES (v_link, entity, v_document, v_type, v_id, v_title, day, actor);
  result := jsonb_build_object('id', v_link, 'title', v_title, 'documentDate', day, 'fileName', file_name, 'mediaType', media, 'byteSize', size,
    'attachedAt', clock_timestamp(), 'storageId', storage, 'replayed', false);
  PERFORM abos.money_audit(actor, entity, correlation, 'DOCUMENT_ATTACHED', 'DOCUMENT', v_link, jsonb_build_object('documentId', v_document, 'subjectType', v_type,
    'subjectId', v_id, 'mediaType', media, 'byteSize', size, 'sha256', hash));
  PERFORM abos.temporary_funding_idempotency_complete(scope, key, 'DOCUMENT', v_link, result);
  RETURN result;
END
$attach$;

-- 3. A failed scan is visible as SCAN_FAILED. It decides nothing: the document stays locked and can be scanned again. PENDING means no attempt
-- has finished yet. Only CLEAN opens, as in 0066.
CREATE OR REPLACE FUNCTION abos.document_scan_status(p_document uuid)
RETURNS text LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $status$
  SELECT COALESCE((SELECT r.outcome FROM abos.document_scan_results r WHERE r.document_id = p_document AND r.outcome <> 'UNAVAILABLE'),
    CASE WHEN EXISTS (SELECT 1 FROM abos.document_scan_results r WHERE r.document_id = p_document AND r.outcome = 'UNAVAILABLE') THEN 'SCAN_FAILED' ELSE 'PENDING' END);
$status$;

-- 4. A scan row names who caused it: a person, or the legacy import operation. Never both, never neither.
ALTER TABLE abos.document_scan_results ALTER COLUMN scanned_by_user_account_id DROP NOT NULL;
ALTER TABLE abos.document_scan_results ADD COLUMN scanned_by_operation text CHECK (scanned_by_operation IN ('LEGACY_IMPORT'));
ALTER TABLE abos.document_scan_results ADD CONSTRAINT document_scan_results_one_cause
  CHECK ((scanned_by_user_account_id IS NULL) <> (scanned_by_operation IS NULL));

-- 5. Starting a scan is audited. The server also learns the file's original name, which never selects what is scanned.
CREATE OR REPLACE FUNCTION abos.document_scan_target(p_proof text, p_runtime text, p_token text, p_link_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $target$
DECLARE c jsonb; entity uuid; actor uuid; l abos.document_links%ROWTYPE; d abos.documents%ROWTYPE; v_status text;
BEGIN
  c := abos.treasury_safe_actor(p_proof, p_runtime, p_token, NULL);
  entity := (c->>'legalEntityId')::uuid; actor := (c->>'userAccountId')::uuid;
  SELECT * INTO l FROM abos.document_links WHERE id = p_link_id AND legal_entity_id = entity;
  IF NOT FOUND OR NOT abos.document_subject_allowed(entity, actor, COALESCE(c->'permissions', '[]'::jsonb), l.subject_type, l.subject_id, true) THEN
    RAISE EXCEPTION 'document not found' USING ERRCODE = 'no_data_found';
  END IF;
  SELECT * INTO d FROM abos.documents WHERE id = l.document_id AND legal_entity_id = entity;
  v_status := abos.document_scan_status(d.id);
  IF v_status IN ('PENDING', 'SCAN_FAILED') THEN
    PERFORM abos.money_audit(actor, entity, gen_random_uuid(), 'DOCUMENT_SCAN_STARTED', 'DOCUMENT', l.id, jsonb_build_object('documentId', d.id, 'scanStatus', v_status));
  END IF;
  RETURN jsonb_build_object('id', l.id, 'storageId', d.storage_id, 'byteSize', d.byte_size, 'sha256', d.sha256, 'scanStatus', v_status, 'fileName', d.original_file_name);
END
$target$;

-- 6. A clean agreement document becomes the agreement's evidence, numbered as the older lane numbered it. Evidence appears only on CLEAN, so a
-- locked or blocked file never satisfies an agreement's document requirement. Internal: only the scan recorder calls it.
CREATE FUNCTION abos.document_agreement_evidence(p_entity uuid, p_agreement uuid, p_document uuid, p_sha256 text, p_reference text, p_date date, p_actor uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $evidence$
DECLARE v_version integer; v_evidence uuid := gen_random_uuid();
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('abos-agreement-evidence:' || p_agreement::text, 0));
  SELECT coalesce(max(e.version), 0) + 1 INTO v_version FROM abos.capital_agreement_evidence e WHERE e.capital_agreement_id = p_agreement;
  INSERT INTO abos.evidence_references (id, legal_entity_id, document_id, evidence_kind, evidence_version, sha256, completed_at)
  VALUES (v_evidence, p_entity, p_document, 'CAPITAL_AGREEMENT', 1, p_sha256, clock_timestamp());
  INSERT INTO abos.capital_agreement_evidence (id, legal_entity_id, capital_agreement_id, evidence_reference_id, version, document_reference, document_date,
    recorded_by_user_account_id)
  VALUES (gen_random_uuid(), p_entity, p_agreement, v_evidence, v_version, p_reference, p_date, p_actor);
  RETURN v_version;
END
$evidence$;

CREATE OR REPLACE FUNCTION abos.document_scan_record(p_proof text, p_runtime text, p_token text, p_payload jsonb)
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
  IF v_outcome = 'UNAVAILABLE' THEN
    IF abos.document_scan_status(l.document_id) NOT IN ('PENDING', 'SCAN_FAILED') THEN
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
    IF v_outcome = 'CLEAN' AND l.subject_type = 'AGREEMENT' THEN
      PERFORM abos.document_agreement_evidence(entity, l.subject_id, l.document_id, (SELECT d.sha256 FROM abos.documents d WHERE d.id = l.document_id AND d.legal_entity_id = entity),
        l.title, l.document_date, l.linked_by_user_account_id);
    END IF;
  END IF;
  RETURN jsonb_build_object('id', l.id, 'scanStatus', abos.document_scan_status(l.document_id));
END
$record$;

-- 7. A shareholder's documents include those attached to that shareholder's capital agreements, each marked with its agreement. Opening one is
-- still decided by the agreement's own rule.
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
      'byteSize', d.byte_size, 'attachedAt', l.linked_at, 'scanStatus', abos.document_scan_status(d.id), 'subjectType', l.subject_type,
      'agreementReference', a.agreement_reference) ORDER BY l.linked_at, l.id)
    FROM abos.document_links l JOIN abos.documents d ON d.id = l.document_id AND d.legal_entity_id = l.legal_entity_id
    LEFT JOIN abos.capital_agreements a ON l.subject_type = 'AGREEMENT' AND a.id = l.subject_id AND a.legal_entity_id = l.legal_entity_id
    WHERE l.legal_entity_id = entity AND ((l.subject_type = v_type AND l.subject_id = v_id)
      OR (v_type = 'SHAREHOLDER' AND l.subject_type = 'AGREEMENT' AND a.shareholder_profile_id = v_id
          AND abos.document_subject_allowed(entity, actor, perms, 'AGREEMENT', l.subject_id, false)))), '[]'::jsonb) ELSE '[]'::jsonb END);
END
$list$;

-- 8. The older agreement lane is retired for the application. Its rows stay as history and nothing is deleted; the runtime can no longer store a
-- new file there, create an attachment-only agreement, or serve an unscanned file from it. The metadata list stays readable.
REVOKE EXECUTE ON FUNCTION abos.shareholder_agreement_document_prepare(text, text, text, uuid), abos.shareholder_agreement_document_finalize(text, text, text, jsonb),
  abos.shareholder_agreement_document_read(text, text, text, uuid), abos.direct_shareholder_document_holder(text, text, text, jsonb) FROM abos_e1_runtime;

-- 9. Bringing an existing agreement file into the vault. Each attempt is recorded, append-only. A file is registered only on a CLEAN verdict for
-- bytes that match the record; anything else is recorded as BLOCKED and changes nothing else. The legacy row and the bytes are never touched.
CREATE TABLE abos.document_legacy_imports (
  id uuid PRIMARY KEY,
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  agreement_evidence_id uuid NOT NULL REFERENCES abos.capital_agreement_document_files(agreement_evidence_id),
  legacy_storage_id uuid NOT NULL,
  byte_size bigint NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  outcome text NOT NULL CHECK (outcome IN ('IMPORTED', 'BLOCKED')),
  scan_outcome text NOT NULL CHECK (scan_outcome IN ('CLEAN', 'INFECTED', 'UNAVAILABLE', 'FINGERPRINT_MISMATCH')),
  engine text NOT NULL CHECK (length(btrim(engine)) BETWEEN 1 AND 60),
  detail text CHECK (detail IS NULL OR length(detail) <= 200),
  document_id uuid,
  link_id uuid REFERENCES abos.document_links(id),
  performed_by text NOT NULL DEFAULT session_user,
  performed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((outcome = 'IMPORTED') = (document_id IS NOT NULL AND link_id IS NOT NULL)),
  CHECK (outcome <> 'IMPORTED' OR scan_outcome = 'CLEAN'),
  FOREIGN KEY (document_id, legal_entity_id) REFERENCES abos.documents(id, legal_entity_id)
);
CREATE UNIQUE INDEX document_legacy_imports_once ON abos.document_legacy_imports (agreement_evidence_id) WHERE outcome = 'IMPORTED';
CREATE TRIGGER document_legacy_imports_no_update_or_delete BEFORE UPDATE OR DELETE ON abos.document_legacy_imports
  FOR EACH ROW EXECUTE FUNCTION abos.prevent_audit_mutation();
REVOKE ALL ON TABLE abos.document_legacy_imports FROM PUBLIC;

-- Operator only. The verdict comes from the operator's server-side scan of the stored bytes; the runtime cannot call this.
CREATE FUNCTION abos.document_import_legacy_agreement(p_agreement_evidence_id uuid, p_observed_byte_size bigint, p_observed_sha256 text, p_outcome text,
  p_engine text, p_detail text)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $import$
DECLARE r record; prior abos.document_legacy_imports%ROWTYPE; v_scan text; v_document uuid := gen_random_uuid(); v_link uuid := gen_random_uuid();
  v_engine text := NULLIF(btrim(p_engine), ''); v_detail text := NULLIF(btrim(p_detail), '');
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('abos-legacy-agreement-import:' || p_agreement_evidence_id::text, 0));
  SELECT f.*, e.document_reference, e.document_date, e.recorded_by_user_account_id, e.recorded_at INTO r
    FROM abos.capital_agreement_document_files f
    JOIN abos.capital_agreement_evidence e ON e.id = f.agreement_evidence_id AND e.legal_entity_id = f.legal_entity_id
   WHERE f.agreement_evidence_id = p_agreement_evidence_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'legacy agreement document not found' USING ERRCODE = 'no_data_found';
  END IF;
  SELECT * INTO prior FROM abos.document_legacy_imports i WHERE i.agreement_evidence_id = p_agreement_evidence_id AND i.outcome = 'IMPORTED';
  IF FOUND THEN
    RETURN jsonb_build_object('status', 'ALREADY_IMPORTED', 'documentId', prior.document_id, 'linkId', prior.link_id);
  END IF;
  -- A threat found once is final, exactly as in the vault: a later clean answer does not let the file in.
  IF EXISTS (SELECT 1 FROM abos.document_legacy_imports i WHERE i.agreement_evidence_id = p_agreement_evidence_id AND i.scan_outcome = 'INFECTED') THEN
    RETURN jsonb_build_object('status', 'BLOCKED', 'scanOutcome', 'INFECTED');
  END IF;
  IF p_outcome IS NULL OR p_outcome NOT IN ('CLEAN', 'INFECTED', 'UNAVAILABLE') OR v_engine IS NULL OR length(v_engine) > 60 OR length(v_detail) > 200 THEN
    RAISE EXCEPTION 'valid scan details are required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_scan := CASE WHEN p_observed_byte_size IS DISTINCT FROM r.byte_size OR lower(p_observed_sha256) IS DISTINCT FROM r.sha256 THEN 'FINGERPRINT_MISMATCH' ELSE p_outcome END;
  IF v_scan <> 'CLEAN' THEN
    INSERT INTO abos.document_legacy_imports (id, legal_entity_id, agreement_evidence_id, legacy_storage_id, byte_size, sha256, outcome, scan_outcome, engine, detail)
    VALUES (gen_random_uuid(), r.legal_entity_id, r.agreement_evidence_id, r.storage_id, r.byte_size, r.sha256, 'BLOCKED', v_scan, v_engine, v_detail);
    INSERT INTO abos.audit_records (id, actor_user_account_id, legal_entity_id, correlation_id, action, entity_type, entity_id, after_state, metadata)
    VALUES (gen_random_uuid(), NULL, r.legal_entity_id, gen_random_uuid(), 'DOCUMENT_LEGACY_IMPORT_BLOCKED', 'CAPITAL_AGREEMENT', r.capital_agreement_id,
      jsonb_build_object('agreementEvidenceId', r.agreement_evidence_id, 'scanOutcome', v_scan, 'engine', v_engine, 'detail', v_detail),
      jsonb_build_object('source', 'v1-document-legacy-import', 'operator', session_user));
    RETURN jsonb_build_object('status', 'BLOCKED', 'scanOutcome', v_scan);
  END IF;
  -- The bytes keep their storage identity and their original uploader and time; the link carries the agreement's own reference and date.
  INSERT INTO abos.documents (id, legal_entity_id, storage_id, original_file_name, media_type, byte_size, sha256, uploaded_by_user_account_id, uploaded_at)
  VALUES (v_document, r.legal_entity_id, r.storage_id, r.original_file_name, r.media_type, r.byte_size, r.sha256, r.uploaded_by_user_account_id, r.uploaded_at);
  INSERT INTO abos.document_links (id, legal_entity_id, document_id, subject_type, subject_id, title, document_date, linked_by_user_account_id, linked_at)
  VALUES (v_link, r.legal_entity_id, v_document, 'AGREEMENT', r.capital_agreement_id, r.document_reference, r.document_date, r.recorded_by_user_account_id, r.recorded_at);
  INSERT INTO abos.document_scan_results (id, legal_entity_id, document_id, outcome, engine, detail, scanned_by_operation)
  VALUES (gen_random_uuid(), r.legal_entity_id, v_document, 'CLEAN', v_engine, v_detail, 'LEGACY_IMPORT');
  INSERT INTO abos.document_legacy_imports (id, legal_entity_id, agreement_evidence_id, legacy_storage_id, byte_size, sha256, outcome, scan_outcome, engine, detail,
    document_id, link_id)
  VALUES (gen_random_uuid(), r.legal_entity_id, r.agreement_evidence_id, r.storage_id, r.byte_size, r.sha256, 'IMPORTED', 'CLEAN', v_engine, v_detail, v_document, v_link);
  -- No person performs an import, so the audit names the operator and carries no actor.
  INSERT INTO abos.audit_records (id, actor_user_account_id, legal_entity_id, correlation_id, action, entity_type, entity_id, after_state, metadata)
  VALUES (gen_random_uuid(), NULL, r.legal_entity_id, gen_random_uuid(), 'DOCUMENT_LEGACY_IMPORTED', 'DOCUMENT', v_link,
    jsonb_build_object('documentId', v_document, 'agreementEvidenceId', r.agreement_evidence_id, 'capitalAgreementId', r.capital_agreement_id,
      'mediaType', r.media_type, 'byteSize', r.byte_size, 'sha256', r.sha256, 'engine', v_engine),
    jsonb_build_object('source', 'v1-document-legacy-import', 'operator', session_user));
  RETURN jsonb_build_object('status', 'IMPORTED', 'documentId', v_document, 'linkId', v_link);
END
$import$;

-- 10. Everything the vault should hold, one row per stored object. An imported agreement file is one object with two records.
CREATE OR REPLACE FUNCTION abos.document_vault_manifest()
RETURNS TABLE (storage_id uuid, byte_size bigint, sha256 text, source text, scan_status text) LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $manifest$
  SELECT COALESCE(d.storage_id, f.storage_id), COALESCE(d.byte_size, f.byte_size), COALESCE(d.sha256, f.sha256),
    CASE WHEN d.id IS NULL THEN 'AGREEMENT' WHEN f.storage_id IS NULL THEN 'DOCUMENT' ELSE 'IMPORTED_AGREEMENT' END,
    CASE WHEN d.id IS NULL THEN NULL ELSE abos.document_scan_status(d.id) END
  FROM abos.documents d FULL JOIN abos.capital_agreement_document_files f ON f.storage_id = d.storage_id
  ORDER BY 1;
$manifest$;

-- 11. What the database itself can say is wrong, for read-only reconciliation. One row per problem; no row means none was found.
CREATE FUNCTION abos.document_vault_integrity()
RETURNS TABLE (problem text, reference uuid, detail text) LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $integrity$
  SELECT 'DOCUMENT_WITHOUT_LINK', d.id, d.storage_id::text FROM abos.documents d
   WHERE NOT EXISTS (SELECT 1 FROM abos.document_links l WHERE l.document_id = d.id)
  UNION ALL
  SELECT 'LINK_ENTITY_MISMATCH', l.id, l.document_id::text FROM abos.document_links l
   WHERE NOT EXISTS (SELECT 1 FROM abos.documents d WHERE d.id = l.document_id AND d.legal_entity_id = l.legal_entity_id)
  UNION ALL
  SELECT 'LINK_SUBJECT_MISSING', l.id, l.subject_type FROM abos.document_links l
   WHERE NOT CASE l.subject_type
     WHEN 'COMPANY' THEN l.subject_id = l.legal_entity_id
     WHEN 'SHAREHOLDER' THEN EXISTS (SELECT 1 FROM abos.shareholder_profiles s WHERE s.id = l.subject_id AND s.legal_entity_id = l.legal_entity_id)
     WHEN 'AGREEMENT' THEN EXISTS (SELECT 1 FROM abos.capital_agreements a WHERE a.id = l.subject_id AND a.legal_entity_id = l.legal_entity_id)
     WHEN 'LOAN' THEN EXISTS (SELECT 1 FROM abos.loans x WHERE x.id = l.subject_id AND x.legal_entity_id = l.legal_entity_id)
     WHEN 'EXPENSE' THEN EXISTS (SELECT 1 FROM abos.operational_expenses x WHERE x.id = l.subject_id AND x.legal_entity_id = l.legal_entity_id)
     WHEN 'RECEIPT' THEN EXISTS (SELECT 1 FROM abos.treasury_cash_receipts x WHERE x.id = l.subject_id AND x.legal_entity_id = l.legal_entity_id)
     WHEN 'PAYMENT' THEN EXISTS (SELECT 1 FROM abos.treasury_payments x WHERE x.id = l.subject_id AND x.legal_entity_id = l.legal_entity_id)
     ELSE false END
  UNION ALL
  SELECT 'SCAN_ENTITY_MISMATCH', r.id, r.document_id::text FROM abos.document_scan_results r
   WHERE NOT EXISTS (SELECT 1 FROM abos.documents d WHERE d.id = r.document_id AND d.legal_entity_id = r.legal_entity_id)
  UNION ALL
  SELECT 'SCAN_ATTEMPT_AFTER_VERDICT', r.id, r.document_id::text FROM abos.document_scan_results r
   WHERE r.outcome = 'UNAVAILABLE' AND EXISTS (SELECT 1 FROM abos.document_scan_results v WHERE v.document_id = r.document_id AND v.outcome <> 'UNAVAILABLE'
     AND v.scanned_at < r.scanned_at)
  UNION ALL
  SELECT 'SHARED_STORAGE_WITHOUT_IMPORT', d.id, d.storage_id::text FROM abos.documents d
    JOIN abos.capital_agreement_document_files f ON f.storage_id = d.storage_id
   WHERE NOT EXISTS (SELECT 1 FROM abos.document_legacy_imports i WHERE i.outcome = 'IMPORTED' AND i.document_id = d.id AND i.agreement_evidence_id = f.agreement_evidence_id)
  UNION ALL
  SELECT 'IMPORT_PROVENANCE_BROKEN', i.id, i.agreement_evidence_id::text FROM abos.document_legacy_imports i
    JOIN abos.capital_agreement_document_files f ON f.agreement_evidence_id = i.agreement_evidence_id
    LEFT JOIN abos.documents d ON d.id = i.document_id
    LEFT JOIN abos.document_links l ON l.id = i.link_id
   WHERE i.outcome = 'IMPORTED' AND (d.id IS NULL OR l.id IS NULL OR d.storage_id <> f.storage_id OR d.sha256 <> f.sha256 OR d.byte_size <> f.byte_size
     OR i.sha256 <> f.sha256 OR l.document_id <> d.id OR l.subject_type <> 'AGREEMENT' OR l.subject_id <> f.capital_agreement_id
     OR abos.document_scan_status(d.id) <> 'CLEAN')
  UNION ALL
  SELECT 'CLEAN_AGREEMENT_WITHOUT_EVIDENCE', l.id, l.subject_id::text FROM abos.document_links l
   WHERE l.subject_type = 'AGREEMENT' AND abos.document_scan_status(l.document_id) = 'CLEAN'
     AND NOT EXISTS (SELECT 1 FROM abos.document_legacy_imports i WHERE i.outcome = 'IMPORTED' AND i.document_id = l.document_id)
     AND NOT EXISTS (SELECT 1 FROM abos.evidence_references er JOIN abos.capital_agreement_evidence e ON e.evidence_reference_id = er.id
                      WHERE er.document_id = l.document_id AND e.capital_agreement_id = l.subject_id)
  UNION ALL
  SELECT 'EVIDENCE_FOR_UNCLEARED_DOCUMENT', er.id, er.document_id::text FROM abos.evidence_references er
    JOIN abos.documents d ON d.id = er.document_id
   WHERE abos.document_scan_status(d.id) <> 'CLEAN'
  ORDER BY 1, 2;
$integrity$;

-- 12. Privileges. The evidence helper is reached only through the scan recorder. The import, the manifest and the integrity check belong to the
-- operator who owns the schema; neither the runtime nor PUBLIC can call them.
ALTER FUNCTION abos.document_agreement_evidence(uuid, uuid, uuid, text, text, date, uuid) OWNER TO abos_v1_shareholder_setup_owner;
REVOKE ALL ON FUNCTION abos.document_agreement_evidence(uuid, uuid, uuid, text, text, date, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION abos.document_agreement_evidence(uuid, uuid, uuid, text, text, date, uuid) TO abos_v1_operational_finance_owner;
REVOKE ALL ON FUNCTION abos.document_import_legacy_agreement(uuid, bigint, text, text, text, text), abos.document_vault_integrity() FROM PUBLIC;
