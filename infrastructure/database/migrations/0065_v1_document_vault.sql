-- Generalized Document Vault. One stored file, attached to any number of business records. The design and the audit behind it are in
-- docs/03-architecture/V1_DOCUMENT_VAULT_AUDIT_AND_DECISION.md.
--
-- A document has no permission of its own: access comes from the record it is attached to, checked in the database on every request.
-- Nothing is replaced or deleted. File bytes stay in the private vault, and only their metadata is here.
-- This migration creates no permission, grants none, and writes no row.

-- 1. The two tables. Both are append-only.
CREATE TABLE abos.documents (
  id uuid PRIMARY KEY,
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  storage_id uuid NOT NULL UNIQUE,
  original_file_name text NOT NULL CHECK (length(btrim(original_file_name)) BETWEEN 1 AND 200),
  media_type text NOT NULL CHECK (media_type IN ('application/pdf', 'image/jpeg', 'image/png')),
  byte_size bigint NOT NULL CHECK (byte_size BETWEEN 1 AND 10485760),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  uploaded_by_user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  uploaded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, legal_entity_id)
);

CREATE TABLE abos.document_links (
  id uuid PRIMARY KEY,
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  document_id uuid NOT NULL,
  subject_type text NOT NULL CHECK (subject_type IN ('COMPANY', 'SHAREHOLDER', 'LOAN', 'EXPENSE', 'RECEIPT', 'PAYMENT')),
  subject_id uuid NOT NULL,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  document_date date,
  linked_by_user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  linked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (document_id, legal_entity_id) REFERENCES abos.documents(id, legal_entity_id)
);
CREATE INDEX document_links_subject_idx ON abos.document_links (legal_entity_id, subject_type, subject_id, linked_at, id);
CREATE INDEX document_links_document_idx ON abos.document_links (document_id);

CREATE TRIGGER documents_no_update_or_delete BEFORE UPDATE OR DELETE ON abos.documents
  FOR EACH ROW EXECUTE FUNCTION abos.prevent_audit_mutation();
CREATE TRIGGER document_links_no_update_or_delete BEFORE UPDATE OR DELETE ON abos.document_links
  FOR EACH ROW EXECUTE FUNCTION abos.prevent_audit_mutation();

REVOKE ALL ON TABLE abos.documents, abos.document_links FROM PUBLIC;
GRANT SELECT ON abos.documents, abos.document_links TO abos_v1_operational_finance_owner;
GRANT INSERT (id, legal_entity_id, storage_id, original_file_name, media_type, byte_size, sha256, uploaded_by_user_account_id)
  ON abos.documents TO abos_v1_operational_finance_owner;
GRANT INSERT (id, legal_entity_id, document_id, subject_type, subject_id, title, document_date, linked_by_user_account_id)
  ON abos.document_links TO abos_v1_operational_finance_owner;

-- 2. The one rule: may this person read, or attach to, this record? A record outside the person's company, or an expense outside their
-- scope, is the same answer as one that does not exist. Report permissions appear nowhere here: seeing a total opens no document.
CREATE FUNCTION abos.document_subject_allowed(p_entity uuid, p_actor uuid, p_permissions jsonb, p_type text, p_id uuid, p_attach boolean)
RETURNS boolean LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $allowed$
BEGIN
  IF NOT (CASE p_type
    WHEN 'COMPANY' THEN p_permissions ? 'admin.company.manage'
    WHEN 'SHAREHOLDER' THEN CASE WHEN p_attach THEN p_permissions ? 'shareholder.setup.manage' ELSE p_permissions ?| ARRAY['shareholder.read', 'shareholder.setup.manage'] END
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
    WHEN 'LOAN' THEN EXISTS (SELECT 1 FROM abos.loans l WHERE l.id = p_id AND l.legal_entity_id = p_entity)
    WHEN 'EXPENSE' THEN EXISTS (SELECT 1 FROM abos.operational_expenses e WHERE e.id = p_id AND e.legal_entity_id = p_entity)
      AND abos.operational_expense_actor_in_scope(p_id, p_entity, p_actor)
    WHEN 'RECEIPT' THEN EXISTS (SELECT 1 FROM abos.treasury_cash_receipts r WHERE r.id = p_id AND r.legal_entity_id = p_entity)
    WHEN 'PAYMENT' THEN EXISTS (SELECT 1 FROM abos.treasury_payments p WHERE p.id = p_id AND p.legal_entity_id = p_entity)
    ELSE false END;
END
$allowed$;

-- The request names a type and a record. A company document names no record, because a person's company comes from their session.
CREATE FUNCTION abos.document_request_subject(p_entity uuid, p_payload jsonb)
RETURNS uuid LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $subject$
BEGIN
  IF p_payload->>'subjectType' = 'COMPANY' THEN RETURN p_entity; END IF;
  RETURN NULLIF(p_payload->>'subjectId', '')::uuid;
EXCEPTION WHEN invalid_text_representation THEN
  RAISE EXCEPTION 'document subject not found' USING ERRCODE = 'no_data_found';
END
$subject$;

-- 3. Before any bytes are stored.
CREATE FUNCTION abos.document_prepare(p_proof text, p_runtime text, p_token text, p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $prepare$
DECLARE c jsonb; entity uuid; actor uuid; v_type text; v_id uuid;
BEGIN
  c := abos.treasury_safe_actor(p_proof, p_runtime, p_token, NULL);
  entity := (c->>'legalEntityId')::uuid; actor := (c->>'userAccountId')::uuid;
  v_type := p_payload->>'subjectType'; v_id := abos.document_request_subject(entity, p_payload);
  IF v_id IS NULL OR NOT abos.document_subject_allowed(entity, actor, COALESCE(c->'permissions', '[]'::jsonb), v_type, v_id, true) THEN
    RAISE EXCEPTION 'document subject not found' USING ERRCODE = 'no_data_found';
  END IF;
  RETURN jsonb_build_object('subjectType', v_type, 'subjectId', v_id);
END
$prepare$;

-- 4. Links an already durably written object to a record, atomically. The application removes the object if this fails, or replays an earlier one.
CREATE FUNCTION abos.document_attach(p_proof text, p_runtime text, p_token text, p_payload jsonb)
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
  IF day > abos.business_today() THEN
    RAISE EXCEPTION 'the document date cannot be in the future' USING ERRCODE = 'check_violation';
  END IF;
  scope := 'document:attach:' || entity::text || ':' || actor::text;
  -- The storage ID is left out: a retry stores a fresh candidate, and it is the same request.
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

-- 5. What is attached to one record. No storage ID leaves here. A person who may attach but not read sees only that they may attach.
CREATE FUNCTION abos.document_list(p_proof text, p_runtime text, p_token text, p_payload jsonb)
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
      'byteSize', d.byte_size, 'attachedAt', l.linked_at) ORDER BY l.linked_at, l.id)
    FROM abos.document_links l JOIN abos.documents d ON d.id = l.document_id AND d.legal_entity_id = l.legal_entity_id
    WHERE l.legal_entity_id = entity AND l.subject_type = v_type AND l.subject_id = v_id), '[]'::jsonb) ELSE '[]'::jsonb END);
END
$list$;

-- 6. Opening a document, through the link that attaches it. Each opening is audited. Not knowing the record and not being allowed to read it give the same answer.
CREATE FUNCTION abos.document_open(p_proof text, p_runtime text, p_token text, p_link_id uuid, p_correlation_id uuid)
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
  PERFORM abos.money_audit(actor, entity, COALESCE(p_correlation_id, gen_random_uuid()), 'DOCUMENT_OPENED', 'DOCUMENT', l.id, jsonb_build_object('documentId', d.id,
    'subjectType', l.subject_type, 'subjectId', l.subject_id, 'mediaType', d.media_type, 'byteSize', d.byte_size, 'sha256', d.sha256));
  RETURN jsonb_build_object('id', l.id, 'storageId', d.storage_id, 'fileName', d.original_file_name, 'mediaType', d.media_type, 'byteSize', d.byte_size, 'sha256', d.sha256);
END
$open$;

-- 7. Privileges. The helpers are internal. The four entry points are the runtime's only way in.
REVOKE ALL ON FUNCTION abos.document_subject_allowed(uuid, uuid, jsonb, text, uuid, boolean), abos.document_request_subject(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION abos.document_subject_allowed(uuid, uuid, jsonb, text, uuid, boolean), abos.document_request_subject(uuid, jsonb) TO abos_v1_operational_finance_owner;
ALTER FUNCTION abos.document_prepare(text, text, text, jsonb) OWNER TO abos_v1_operational_finance_owner;
ALTER FUNCTION abos.document_attach(text, text, text, jsonb) OWNER TO abos_v1_operational_finance_owner;
ALTER FUNCTION abos.document_list(text, text, text, jsonb) OWNER TO abos_v1_operational_finance_owner;
ALTER FUNCTION abos.document_open(text, text, text, uuid, uuid) OWNER TO abos_v1_operational_finance_owner;
REVOKE ALL ON FUNCTION abos.document_prepare(text, text, text, jsonb), abos.document_attach(text, text, text, jsonb), abos.document_list(text, text, text, jsonb),
  abos.document_open(text, text, text, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION abos.document_prepare(text, text, text, jsonb), abos.document_attach(text, text, text, jsonb), abos.document_list(text, text, text, jsonb),
  abos.document_open(text, text, text, uuid, uuid) TO abos_e1_runtime;
