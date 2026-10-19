-- Capital activation only. No business configuration, grants to people, or financial backfill.
-- Existing 0001-0037 definitions remain immutable; only typed Capital entry points are replaced.
-- A document fingerprint establishes byte integrity, never legal verification or physical custody.

DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='abos_v1_capital_evidence_owner') THEN
    CREATE ROLE abos_v1_capital_evidence_owner NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB
      NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='abos_v1_capital_evidence_owner'
    AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles r
      ON r.oid=m.roleid OR r.oid=m.member WHERE r.rolname='abos_v1_capital_evidence_owner') THEN
    RAISE EXCEPTION 'capital evidence owner must be a restricted role without memberships';
  END IF;
END
$role$;
GRANT USAGE ON SCHEMA abos TO abos_v1_capital_evidence_owner;

CREATE TABLE abos.shareholder_capital_evidence_registrations (
  evidence_reference_id uuid PRIMARY KEY,
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  evidence_kind text NOT NULL CHECK (evidence_kind IN ('CAPITAL_ACCOUNT_MAPPING','CASH_RECEIPT',
    'PHYSICAL_CASH_COUNT','BANK_CONFIRMATION','SARAF_CONFIRMATION','CONTROLLED_EVIDENCE','FINANCE_APPROVAL')),
  contribution_id uuid,
  receipt_id uuid,
  posting_intent_id uuid,
  document_reference text NOT NULL CHECK (length(btrim(document_reference)) BETWEEN 3 AND 200),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  registered_by_user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  registered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  correlation_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 8 AND 200),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  UNIQUE (evidence_reference_id,legal_entity_id),
  UNIQUE (legal_entity_id,registered_by_user_account_id,idempotency_key),
  FOREIGN KEY (evidence_reference_id,legal_entity_id) REFERENCES abos.evidence_references(id,legal_entity_id),
  FOREIGN KEY (contribution_id,legal_entity_id) REFERENCES abos.shareholder_contributions(id,legal_entity_id),
  FOREIGN KEY (receipt_id,legal_entity_id) REFERENCES abos.shareholder_capital_receipts(id,legal_entity_id),
  FOREIGN KEY (posting_intent_id,legal_entity_id) REFERENCES abos.posting_intents(id,legal_entity_id),
  CHECK ((evidence_kind='CAPITAL_ACCOUNT_MAPPING' AND contribution_id IS NULL AND receipt_id IS NULL AND posting_intent_id IS NULL)
    OR (evidence_kind='CASH_RECEIPT' AND contribution_id IS NOT NULL AND receipt_id IS NULL AND posting_intent_id IS NULL)
    OR (evidence_kind IN ('PHYSICAL_CASH_COUNT','BANK_CONFIRMATION','SARAF_CONFIRMATION','CONTROLLED_EVIDENCE')
      AND contribution_id IS NULL AND receipt_id IS NOT NULL AND posting_intent_id IS NULL)
    OR (evidence_kind='FINANCE_APPROVAL' AND contribution_id IS NULL AND receipt_id IS NULL AND posting_intent_id IS NOT NULL))
);
CREATE INDEX shareholder_capital_evidence_subject_idx ON abos.shareholder_capital_evidence_registrations
  (legal_entity_id,evidence_kind,contribution_id,receipt_id,posting_intent_id);
CREATE TRIGGER shareholder_capital_evidence_immutable BEFORE UPDATE OR DELETE
  ON abos.shareholder_capital_evidence_registrations FOR EACH ROW EXECUTE FUNCTION abos.prevent_audit_mutation();

-- A registration is a single source-specific fact. One reference cannot justify two bindings.
CREATE UNIQUE INDEX shareholder_capital_mapping_evidence_once
  ON abos.shareholder_capital_account_mapping_versions(legal_entity_id,evidence_reference_id);
CREATE UNIQUE INDEX shareholder_capital_receipt_evidence_once
  ON abos.shareholder_capital_receipts(legal_entity_id,evidence_reference_id) WHERE evidence_reference_id IS NOT NULL;
CREATE UNIQUE INDEX shareholder_capital_custody_evidence_once
  ON abos.shareholder_capital_receipt_custody_verifications(legal_entity_id,evidence_reference_id);
CREATE UNIQUE INDEX shareholder_capital_approval_evidence_once
  ON abos.posting_approvals(legal_entity_id,evidence_reference_id) WHERE shareholder_capital_receipt_id IS NOT NULL;

CREATE FUNCTION abos.register_shareholder_capital_evidence(
  p_identity_proof text,p_runtime_token_sha256 text,p_token_sha256 text,p_payload jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp
AS $register$
DECLARE
  v_context jsonb; v_actor uuid; v_entity uuid; v_kind text; v_permission text; v_subject uuid;
  v_reference text; v_hash text; v_key text; v_correlation uuid; v_fingerprint text; v_scope text;
  v_evidence uuid; v_document uuid; v_idem jsonb; v_result jsonb; v_now timestamptz;
BEGIN
  IF p_payload IS NULL OR jsonb_typeof(p_payload)<>'object' OR EXISTS (
    SELECT 1 FROM jsonb_object_keys(p_payload) key WHERE key NOT IN
      ('evidenceKind','subjectId','documentReference','sha256','idempotencyKey','correlationId')) THEN
    RAISE EXCEPTION 'capital evidence request contains unsupported fields' USING ERRCODE='invalid_parameter_value';
  END IF;
  v_kind:=p_payload->>'evidenceKind';
  v_permission:=CASE
    WHEN v_kind='CAPITAL_ACCOUNT_MAPPING' THEN 'finance.capital-receipt.configure'
    WHEN v_kind='CASH_RECEIPT' THEN 'shareholder.capital-receipt.record'
    WHEN v_kind IN ('PHYSICAL_CASH_COUNT','BANK_CONFIRMATION','SARAF_CONFIRMATION','CONTROLLED_EVIDENCE')
      THEN 'treasury.capital-receipt.verify'
    WHEN v_kind='FINANCE_APPROVAL' THEN 'finance.capital-receipt.approve' END;
  IF v_permission IS NULL THEN RAISE EXCEPTION 'unsupported capital evidence kind' USING ERRCODE='invalid_parameter_value'; END IF;
  IF (v_kind IN ('CAPITAL_ACCOUNT_MAPPING','FINANCE_APPROVAL')
      AND NOT pg_has_role(session_user,'abos_e1_runtime','USAGE'))
    OR (v_kind NOT IN ('CAPITAL_ACCOUNT_MAPPING','FINANCE_APPROVAL')
      AND NOT pg_has_role(session_user,'abos_e1_treasury_runtime','USAGE')) THEN
    RAISE EXCEPTION 'capital evidence is unavailable through this runtime credential' USING ERRCODE='insufficient_privilege';
  END IF;
  v_context:=abos.identity_actor_context(p_identity_proof,p_runtime_token_sha256,p_token_sha256);
  IF v_context IS NULL OR COALESCE((v_context->>'live')::boolean,false) IS NOT TRUE
    OR v_context->>'status' IS DISTINCT FROM 'ACTIVE'
    OR v_context->>'sessionProvenance' IS DISTINCT FROM 'PASSWORD_OPERATIONAL'
    OR COALESCE((v_context->>'mustChangePassword')::boolean,false)
    OR NOT COALESCE(v_context->'permissions','[]'::jsonb) ? v_permission THEN
    RAISE EXCEPTION 'capital evidence requires a current authorized password session' USING ERRCODE='insufficient_privilege';
  END IF;
  v_actor:=(v_context->>'userAccountId')::uuid; v_entity:=(v_context->>'legalEntityId')::uuid;
  BEGIN
    v_subject:=NULLIF(p_payload->>'subjectId','')::uuid;
    v_reference:=btrim(p_payload->>'documentReference'); v_hash:=lower(p_payload->>'sha256');
    v_key:=btrim(p_payload->>'idempotencyKey'); v_correlation:=(p_payload->>'correlationId')::uuid;
  EXCEPTION WHEN others THEN RAISE EXCEPTION 'invalid capital evidence metadata' USING ERRCODE='invalid_parameter_value'; END;
  IF v_reference IS NULL OR length(v_reference) NOT BETWEEN 3 AND 200 OR v_reference ~ '[[:cntrl:]]'
    OR v_hash IS NULL OR v_hash !~ '^[0-9a-f]{64}$' OR v_key IS NULL
    OR length(v_key) NOT BETWEEN 8 AND 200 OR v_correlation IS NULL THEN
    RAISE EXCEPTION 'document reference, SHA-256 and command identifiers are required' USING ERRCODE='invalid_parameter_value';
  END IF;
  IF (v_kind='CAPITAL_ACCOUNT_MAPPING' AND v_subject IS NOT NULL)
    OR (v_kind<>'CAPITAL_ACCOUNT_MAPPING' AND v_subject IS NULL) THEN
    RAISE EXCEPTION 'capital evidence requires its exact subject' USING ERRCODE='invalid_parameter_value';
  END IF;
  IF v_kind='CASH_RECEIPT' AND NOT EXISTS (SELECT 1 FROM abos.shareholder_contributions
    WHERE id=v_subject AND legal_entity_id=v_entity AND contribution_type='CASH' AND record_status='DECLARED') THEN
    RAISE EXCEPTION 'cash contribution is unavailable in this legal entity' USING ERRCODE='insufficient_privilege';
  ELSIF v_kind IN ('PHYSICAL_CASH_COUNT','BANK_CONFIRMATION','SARAF_CONFIRMATION','CONTROLLED_EVIDENCE')
    AND NOT EXISTS (SELECT 1 FROM abos.shareholder_capital_receipts
      WHERE id=v_subject AND legal_entity_id=v_entity AND recorded_by_user_account_id<>v_actor) THEN
    RAISE EXCEPTION 'independent custody subject is unavailable in this legal entity' USING ERRCODE='insufficient_privilege';
  ELSIF v_kind='FINANCE_APPROVAL' AND NOT EXISTS (
    SELECT 1 FROM abos.posting_intents i JOIN abos.shareholder_capital_receipts r
      ON r.id=i.shareholder_capital_receipt_id AND r.legal_entity_id=i.legal_entity_id
    JOIN abos.shareholder_capital_receipt_custody_verifications c
      ON c.shareholder_capital_receipt_id=r.id AND c.legal_entity_id=r.legal_entity_id
    WHERE i.id=v_subject AND i.legal_entity_id=v_entity AND i.processing_model='OPERATIONAL_V1'
      AND i.source_type='SHAREHOLDER_CAPITAL_CONTRIBUTION_RECEIPT'
      AND v_actor NOT IN (i.created_by_user_account_id,r.recorded_by_user_account_id,c.verified_by_user_account_id)) THEN
    RAISE EXCEPTION 'independent capital approval subject is unavailable in this legal entity' USING ERRCODE='insufficient_privilege';
  END IF;
  v_fingerprint:=encode(sha256(convert_to((p_payload-'correlationId')::text||':'||v_actor::text,'UTF8')),'hex');
  v_scope:='capital-evidence:register:'||v_entity::text||':'||v_actor::text;
  v_idem:=abos.shareholder_capital_idempotency_begin(v_scope,v_key,v_fingerprint,v_correlation);
  IF (v_idem->>'replayed')::boolean THEN RETURN (v_idem->'snapshot')||jsonb_build_object('replayed',true); END IF;
  v_evidence:=gen_random_uuid(); v_document:=gen_random_uuid(); v_now:=clock_timestamp();
  INSERT INTO abos.evidence_references(id,legal_entity_id,document_id,evidence_kind,evidence_version,sha256,completed_at)
    VALUES(v_evidence,v_entity,v_document,v_kind,1,v_hash,v_now);
  INSERT INTO abos.shareholder_capital_evidence_registrations
    (evidence_reference_id,legal_entity_id,evidence_kind,contribution_id,receipt_id,posting_intent_id,
     document_reference,sha256,registered_by_user_account_id,registered_at,correlation_id,idempotency_key,request_fingerprint)
  VALUES(v_evidence,v_entity,v_kind,CASE WHEN v_kind='CASH_RECEIPT' THEN v_subject END,
    CASE WHEN v_kind IN ('PHYSICAL_CASH_COUNT','BANK_CONFIRMATION','SARAF_CONFIRMATION','CONTROLLED_EVIDENCE') THEN v_subject END,
    CASE WHEN v_kind='FINANCE_APPROVAL' THEN v_subject END,v_reference,v_hash,v_actor,v_now,v_correlation,v_key,v_fingerprint);
  v_result:=jsonb_build_object('evidenceReferenceId',v_evidence,'evidenceKind',v_kind,
    'documentReference',v_reference,'sha256',v_hash,'replayed',false);
  PERFORM abos.shareholder_capital_audit(v_actor,v_entity,v_correlation,
    'SHAREHOLDER_CAPITAL_EVIDENCE_REGISTERED','SHAREHOLDER_CAPITAL_EVIDENCE',v_evidence,v_result);
  PERFORM abos.shareholder_capital_idempotency_complete(v_scope,v_key,'SHAREHOLDER_CAPITAL_EVIDENCE',v_evidence,v_result);
  RETURN v_result;
END
$register$;

-- Binding is defended by triggers as well as the restricted application entry points.
CREATE FUNCTION abos.guard_shareholder_capital_evidence_binding()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp
AS $binding$
DECLARE v_kind text; v_actor uuid; v_subject uuid; v_evidence uuid;
BEGIN
  IF TG_TABLE_NAME='shareholder_capital_account_mapping_versions' THEN
    v_kind:='CAPITAL_ACCOUNT_MAPPING'; v_actor:=NEW.configured_by_user_account_id; v_subject:=NULL;
  ELSIF TG_TABLE_NAME='shareholder_capital_receipts' THEN
    IF NEW.receipt_date < (SELECT business_date FROM abos.shareholder_contributions
      WHERE id=NEW.contribution_id AND legal_entity_id=NEW.legal_entity_id) THEN
      RAISE EXCEPTION 'actual receipt date cannot precede declaration' USING ERRCODE='check_violation';
    END IF;
    IF NEW.evidence_reference_id IS NULL THEN RETURN NEW; END IF;
    v_kind:='CASH_RECEIPT'; v_actor:=NEW.recorded_by_user_account_id; v_subject:=NEW.contribution_id;
  ELSIF TG_TABLE_NAME='shareholder_capital_receipt_custody_verifications' THEN
    v_kind:=NEW.verification_kind; v_actor:=NEW.verified_by_user_account_id; v_subject:=NEW.shareholder_capital_receipt_id;
  ELSIF TG_TABLE_NAME='posting_approvals' THEN
    IF NEW.shareholder_capital_receipt_id IS NULL THEN RETURN NEW; END IF;
    v_kind:='FINANCE_APPROVAL'; v_actor:=NEW.approver_user_account_id; v_subject:=NEW.posting_intent_id;
  ELSE RAISE EXCEPTION 'unsupported capital evidence binding table'; END IF;
  v_evidence:=NEW.evidence_reference_id;
  IF NOT EXISTS (SELECT 1 FROM abos.shareholder_capital_evidence_registrations e
    WHERE e.evidence_reference_id=v_evidence AND e.legal_entity_id=NEW.legal_entity_id
      AND e.evidence_kind=v_kind AND e.registered_by_user_account_id=v_actor
      AND COALESCE(e.contribution_id,e.receipt_id,e.posting_intent_id) IS NOT DISTINCT FROM v_subject) THEN
    RAISE EXCEPTION 'capital evidence must be registered by this operator for this exact purpose and subject'
      USING ERRCODE='insufficient_privilege';
  END IF;
  RETURN NEW;
END
$binding$;
CREATE TRIGGER capital_mapping_registered_evidence BEFORE INSERT ON abos.shareholder_capital_account_mapping_versions
  FOR EACH ROW EXECUTE FUNCTION abos.guard_shareholder_capital_evidence_binding();
CREATE TRIGGER capital_receipt_registered_evidence BEFORE INSERT ON abos.shareholder_capital_receipts
  FOR EACH ROW EXECUTE FUNCTION abos.guard_shareholder_capital_evidence_binding();
CREATE TRIGGER capital_custody_registered_evidence BEFORE INSERT ON abos.shareholder_capital_receipt_custody_verifications
  FOR EACH ROW EXECUTE FUNCTION abos.guard_shareholder_capital_evidence_binding();
CREATE TRIGGER capital_approval_registered_evidence BEFORE INSERT ON abos.posting_approvals
  FOR EACH ROW EXECUTE FUNCTION abos.guard_shareholder_capital_evidence_binding();

ALTER FUNCTION abos.register_shareholder_capital_evidence(text,text,text,jsonb) OWNER TO abos_v1_capital_evidence_owner;
ALTER FUNCTION abos.guard_shareholder_capital_evidence_binding() OWNER TO abos_v1_capital_evidence_owner;
GRANT SELECT,INSERT ON abos.shareholder_capital_evidence_registrations TO abos_v1_capital_evidence_owner;
GRANT INSERT(id,legal_entity_id,document_id,evidence_kind,evidence_version,sha256,completed_at)
  ON abos.evidence_references TO abos_v1_capital_evidence_owner;
GRANT SELECT(id,legal_entity_id,contribution_type,record_status,business_date)
  ON abos.shareholder_contributions TO abos_v1_capital_evidence_owner;
GRANT SELECT(id,legal_entity_id,recorded_by_user_account_id)
  ON abos.shareholder_capital_receipts TO abos_v1_capital_evidence_owner;
GRANT SELECT(shareholder_capital_receipt_id,legal_entity_id,verified_by_user_account_id)
  ON abos.shareholder_capital_receipt_custody_verifications TO abos_v1_capital_evidence_owner;
GRANT SELECT(id,legal_entity_id,shareholder_capital_receipt_id,processing_model,source_type,created_by_user_account_id)
  ON abos.posting_intents TO abos_v1_capital_evidence_owner;
GRANT EXECUTE ON FUNCTION abos.identity_actor_context(text,text,text),
  abos.shareholder_capital_idempotency_begin(text,text,text,uuid),
  abos.shareholder_capital_idempotency_complete(text,text,text,uuid,jsonb),
  abos.shareholder_capital_audit(uuid,uuid,uuid,text,text,uuid,jsonb)
  TO abos_v1_capital_evidence_owner;
REVOKE ALL ON abos.shareholder_capital_evidence_registrations FROM PUBLIC,
  abos_e1_runtime,abos_e1_treasury_runtime,abos_v1_identity_runtime;
REVOKE ALL ON FUNCTION abos.register_shareholder_capital_evidence(text,text,text,jsonb),
  abos.guard_shareholder_capital_evidence_binding() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION abos.register_shareholder_capital_evidence(text,text,text,jsonb)
  TO abos_e1_runtime,abos_e1_treasury_runtime;


-- Truthful receipt dates; all source, version, amount, currency and idempotency checks retained.
CREATE OR REPLACE FUNCTION abos.record_shareholder_capital_receipt(
  p_identity_proof text, p_runtime_token_sha256 text, p_token_sha256 text, p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $record$
DECLARE
  v_context jsonb; v_actor uuid; v_entity uuid; v_contribution_id uuid; v_destination_id uuid;
  v_expected integer; v_amount numeric; v_currency text; v_date date; v_reference text;
  v_evidence uuid; v_key text; v_correlation uuid; v_fingerprint text; v_source_fingerprint text;
  v_scope text; v_idem jsonb; v_receipt_id uuid; v_allocated numeric;
  v_source abos.shareholder_contributions%ROWTYPE;
  v_treasury abos.operational_treasury_accounts%ROWTYPE;
  v_entity_base text; v_policy text; v_evidence_kind text; v_result jsonb;
BEGIN
  v_context := abos.shareholder_capital_actor(p_identity_proof, p_runtime_token_sha256,
    p_token_sha256, 'shareholder.capital-receipt.record');
  v_actor := (v_context ->> 'userAccountId')::uuid;
  v_entity := (v_context ->> 'legalEntityId')::uuid;
  IF EXISTS (SELECT 1 FROM pg_catalog.jsonb_object_keys(p_payload) key
              WHERE key NOT IN ('contributionId','expectedContributionVersion','amount','receiptDate',
                'treasuryDestinationId','paymentReference','evidenceReferenceId','idempotencyKey','correlationId')) THEN
    RAISE EXCEPTION 'capital receipt request contains unsupported fields' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  BEGIN
    v_contribution_id := (p_payload ->> 'contributionId')::uuid;
    v_destination_id := (p_payload ->> 'treasuryDestinationId')::uuid;
    v_expected := (p_payload ->> 'expectedContributionVersion')::integer;
    v_date := (p_payload ->> 'receiptDate')::date;
    v_evidence := NULLIF(p_payload ->> 'evidenceReferenceId','')::uuid;
    v_key := btrim(p_payload ->> 'idempotencyKey');
    v_correlation := (p_payload ->> 'correlationId')::uuid;
    v_amount := (p_payload #>> '{amount,amount}')::numeric;
    v_currency := upper(p_payload #>> '{amount,currency}');
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'a complete valid capital receipt request is required'
      USING ERRCODE = 'invalid_parameter_value';
  END;
  IF (p_payload #>> '{amount,amount}') !~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$'
     OR v_amount <= 0 OR v_amount >= 'Infinity'::numeric
     OR length(v_key) NOT BETWEEN 8 AND 200 THEN
    RAISE EXCEPTION 'a positive plain-decimal amount and idempotency key are required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_reference := NULLIF(btrim(p_payload ->> 'paymentReference'), '');
  v_source := abos.shareholder_contribution_finance_lock(v_entity, v_contribution_id, v_expected);
  SELECT base_currency_code, currency_policy_status INTO v_entity_base, v_policy
    FROM abos.legal_entities WHERE id = v_entity;
  SELECT * INTO v_treasury FROM abos.operational_treasury_accounts
   WHERE id = v_destination_id AND legal_entity_id = v_entity;
  IF v_policy <> 'APPROVED' OR v_entity_base IS NULL
     OR v_source.currency_code IS DISTINCT FROM v_currency
     OR v_currency IS DISTINCT FROM v_entity_base
     OR v_treasury.id IS NULL OR v_treasury.status <> 'ACTIVE'
     OR v_treasury.currency_code IS DISTINCT FROM v_currency THEN
    RAISE EXCEPTION 'capital receipt requires approved base currency and an active same-currency Treasury destination'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_date IS NULL OR v_date < v_source.business_date THEN
    RAISE EXCEPTION 'actual capital receipt date cannot precede the declaration date'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_evidence IS NOT NULL THEN
    SELECT evidence_kind INTO v_evidence_kind FROM abos.evidence_references
     WHERE id = v_evidence AND legal_entity_id = v_entity;
    IF v_evidence_kind IS DISTINCT FROM 'CASH_RECEIPT' THEN
      RAISE EXCEPTION 'optional receipt evidence must be structured CASH_RECEIPT evidence'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  v_fingerprint := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    (p_payload - 'correlationId')::text || ':' || v_actor::text, 'UTF8')), 'hex');
  v_source_fingerprint := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    pg_catalog.concat_ws(':',v_source.id::text,v_source.version::text,
      v_source.shareholder_profile_id::text,v_source.contribution_type,v_source.business_date::text,
      v_source.amount::text,v_source.currency_code), 'UTF8')), 'hex');
  v_scope := 'shareholder-capital:record:' || v_entity::text || ':' || v_actor::text;
  v_idem := abos.shareholder_capital_idempotency_begin(v_scope,v_key,v_fingerprint,v_correlation);
  IF (v_idem ->> 'replayed')::boolean THEN
    RETURN v_idem -> 'snapshot';
  END IF;
  SELECT COALESCE(sum(original_amount),0) INTO v_allocated
    FROM abos.shareholder_capital_receipts
   WHERE legal_entity_id = v_entity AND contribution_id = v_source.id AND record_state = 'RECORDED';
  IF v_allocated + v_amount > v_source.amount THEN
    RAISE EXCEPTION 'recorded receipts would exceed the declared contribution amount'
      USING ERRCODE = 'check_violation';
  END IF;
  v_receipt_id := pg_catalog.gen_random_uuid();
  INSERT INTO abos.shareholder_capital_receipts
    (id,legal_entity_id,contribution_id,operational_treasury_account_id,original_amount,
     original_currency_code,receipt_date,payment_reference,evidence_reference_id,
     contribution_version,source_fingerprint,record_state,version,correlation_id,
     idempotency_key,request_fingerprint,recorded_by_user_account_id)
  VALUES (v_receipt_id,v_entity,v_source.id,v_treasury.id,v_amount,v_currency,v_date,
          v_reference,v_evidence,v_source.version,v_source_fingerprint,'RECORDED',1,
          v_correlation,v_key,v_fingerprint,v_actor);
  v_result := pg_catalog.jsonb_build_object(
    'receipt',abos.shareholder_capital_receipt_json(v_receipt_id),'replayed',false);
  PERFORM abos.shareholder_capital_audit(v_actor,v_entity,v_correlation,
    'SHAREHOLDER_CAPITAL_RECEIPT_RECORDED','SHAREHOLDER_CAPITAL_RECEIPT',v_receipt_id,v_result);
  PERFORM abos.shareholder_capital_idempotency_complete(v_scope,v_key,
    'SHAREHOLDER_CAPITAL_RECEIPT',v_receipt_id,v_result);
  RETURN v_result;
END
$record$;

CREATE OR REPLACE FUNCTION abos.configure_shareholder_capital_mapping(
  p_identity_proof text,p_runtime_token_sha256 text,p_token_sha256 text,p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $configure$
DECLARE
  v_context jsonb; v_actor uuid; v_entity uuid; v_ledger uuid; v_evidence uuid;
  v_reason text; v_key text; v_correlation uuid; v_fingerprint text; v_scope text; v_idem jsonb;
  v_version integer; v_mapping uuid; v_ledger_row record;
  v_kind text; v_result jsonb;
BEGIN
  v_context := abos.operational_finance_actor(p_identity_proof,p_runtime_token_sha256,
    p_token_sha256,'finance.capital-receipt.configure');
  v_actor := (v_context ->> 'userAccountId')::uuid; v_entity := (v_context ->> 'legalEntityId')::uuid;
  IF EXISTS (SELECT 1 FROM pg_catalog.jsonb_object_keys(p_payload) key
              WHERE key NOT IN ('ledgerAccountId','evidenceReferenceId','changeReason','idempotencyKey','correlationId')) THEN
    RAISE EXCEPTION 'capital mapping request contains unsupported fields' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  BEGIN
    v_ledger := (p_payload ->> 'ledgerAccountId')::uuid;
    v_evidence := (p_payload ->> 'evidenceReferenceId')::uuid;
    v_reason := btrim(p_payload ->> 'changeReason'); v_key := btrim(p_payload ->> 'idempotencyKey');
    v_correlation := (p_payload ->> 'correlationId')::uuid;
  EXCEPTION WHEN others THEN RAISE EXCEPTION 'a complete capital mapping request is required'
    USING ERRCODE = 'invalid_parameter_value'; END;
  SELECT id,status,posting_allowed,account_type,control_account_type,
         requires_project,requires_department,requires_cost_center,account_currency_code
    INTO v_ledger_row FROM abos.ledger_accounts
   WHERE id = v_ledger AND legal_entity_id = v_entity;
  IF NOT FOUND OR v_ledger_row.status <> 'ACTIVE' OR NOT v_ledger_row.posting_allowed
     OR v_ledger_row.account_type <> 'EQUITY'
     OR v_ledger_row.control_account_type <> 'SHAREHOLDER_CAPITAL'
     OR v_ledger_row.account_currency_code IS DISTINCT FROM (SELECT base_currency_code FROM abos.legal_entities WHERE id=v_entity)
     OR v_ledger_row.requires_project OR v_ledger_row.requires_department
     OR v_ledger_row.requires_cost_center THEN
    RAISE EXCEPTION 'capital mapping requires an active posting SHAREHOLDER_CAPITAL equity account without dimensions'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT evidence_kind INTO v_kind FROM abos.evidence_references
   WHERE id = v_evidence AND legal_entity_id = v_entity;
  IF v_kind IS DISTINCT FROM 'CAPITAL_ACCOUNT_MAPPING' THEN
    RAISE EXCEPTION 'capital mapping requires structured CAPITAL_ACCOUNT_MAPPING evidence'
      USING ERRCODE = 'check_violation';
  END IF;
  IF length(v_reason) NOT BETWEEN 3 AND 500 OR length(v_key) NOT BETWEEN 8 AND 200 THEN
    RAISE EXCEPTION 'a mapping reason and idempotency key are required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_fingerprint := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    (p_payload-'correlationId')::text||':'||v_actor::text, 'UTF8')),'hex');
  v_scope := 'shareholder-capital:configure:'||v_entity::text||':'||v_actor::text;
  v_idem := abos.shareholder_capital_idempotency_begin(v_scope,v_key,v_fingerprint,v_correlation);
  IF (v_idem ->> 'replayed')::boolean THEN RETURN v_idem -> 'snapshot'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('capital-mapping:'||v_entity::text,0));
  SELECT COALESCE(max(version),0)+1 INTO v_version
    FROM abos.shareholder_capital_account_mapping_versions WHERE legal_entity_id=v_entity;
  v_mapping := pg_catalog.gen_random_uuid();
  INSERT INTO abos.shareholder_capital_account_mapping_versions
    (id,legal_entity_id,version,paid_in_capital_ledger_account_id,evidence_reference_id,
     change_reason,configured_by_user_account_id,correlation_id,idempotency_key,request_fingerprint)
  VALUES (v_mapping,v_entity,v_version,v_ledger,v_evidence,v_reason,v_actor,v_correlation,v_key,v_fingerprint);
  v_result := pg_catalog.jsonb_build_object('mappingVersionId',v_mapping,'version',v_version,
    'ledgerAccountId',v_ledger,'replayed',false);
  PERFORM abos.shareholder_capital_audit(v_actor,v_entity,v_correlation,
    'SHAREHOLDER_CAPITAL_MAPPING_CONFIGURED','SHAREHOLDER_CAPITAL_MAPPING',v_mapping,v_result);
  PERFORM abos.shareholder_capital_idempotency_complete(v_scope,v_key,'SHAREHOLDER_CAPITAL_MAPPING',v_mapping,v_result);
  RETURN v_result;
END
$configure$;

-- Read-only operator trace, using persisted source/policy/mapping/actor identities.
CREATE OR REPLACE FUNCTION abos.shareholder_capital_receipt_json(p_receipt_id uuid)
RETURNS jsonb LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $json$
  SELECT pg_catalog.jsonb_build_object(
    'receiptId', receipt.id, 'contributionId', receipt.contribution_id,
    'amount', pg_catalog.jsonb_build_object(
      'amount', receipt.original_amount::text, 'currency', receipt.original_currency_code),
    'receiptDate', receipt.receipt_date, 'treasuryDestinationId', receipt.operational_treasury_account_id,
    'treasuryDestinationName', treasury.name_en,
    'custodyState', COALESCE(custody.decision, 'PENDING_VERIFICATION'),
    'approvalState', CASE
      WHEN approval.decision IS NULL THEN 'PENDING' ELSE approval.decision END,
    'postingState', CASE WHEN journal.id IS NULL THEN 'NOT_POSTED' ELSE 'POSTED' END,
    'postingIntentId', intent.id, 'receiptVersion', receipt.version,
    'postingIntentVersion', intent.operational_version, 'journalId', journal.id,
    'paymentReference',receipt.payment_reference,'evidenceReferenceId',receipt.evidence_reference_id,
    'recorderName',(SELECT display_name FROM abos.user_accounts WHERE id=receipt.recorded_by_user_account_id),
    'recordedAt',receipt.recorded_at,'recorderUserAccountId',receipt.recorded_by_user_account_id,
    'verifierName',(SELECT display_name FROM abos.user_accounts WHERE id=custody.verified_by_user_account_id),
    'verifiedAt',custody.verified_at,'custodyReason',custody.decision_reason,'verificationKind',custody.verification_kind,
    'custodyEvidenceReferenceId',custody.evidence_reference_id,
    'preparerName',(SELECT display_name FROM abos.user_accounts WHERE id=intent.created_by_user_account_id),
    'preparedAt',intent.created_at,'accountingEffectiveDate',intent.accounting_effective_date,
    'approverName',(SELECT display_name FROM abos.user_accounts WHERE id=approval.approver_user_account_id),
    'approvedAt',approval.approved_at,'approvalReason',approval.decision_reason,
    'approverUserAccountId',approval.approver_user_account_id,
    'receiptEvidence',(SELECT jsonb_build_object('reference',document_reference,'sha256',sha256,'kind',evidence_kind)
      FROM abos.shareholder_capital_evidence_registrations WHERE evidence_reference_id=receipt.evidence_reference_id AND legal_entity_id=receipt.legal_entity_id),
    'custodyEvidence',(SELECT jsonb_build_object('reference',document_reference,'sha256',sha256,'kind',evidence_kind)
      FROM abos.shareholder_capital_evidence_registrations WHERE evidence_reference_id=custody.evidence_reference_id AND legal_entity_id=receipt.legal_entity_id),
    'approvalEvidence',(SELECT jsonb_build_object('reference',document_reference,'sha256',sha256,'kind',evidence_kind)
      FROM abos.shareholder_capital_evidence_registrations WHERE evidence_reference_id=approval.evidence_reference_id AND legal_entity_id=receipt.legal_entity_id),
    'approvalEvidenceReferenceId',approval.evidence_reference_id,
    'policyVersion',(SELECT version FROM abos.finance_workflow_policy_versions WHERE id=intent.finance_workflow_policy_version_id),
    'mappingVersion',(SELECT version FROM abos.shareholder_capital_account_mapping_versions WHERE id=intent.shareholder_capital_account_mapping_version_id),
    'mappingVersionId',intent.shareholder_capital_account_mapping_version_id,
    'debitAccount',(SELECT jsonb_build_object('id',id,'code',account_code,'name',account_name)
      FROM abos.ledger_accounts WHERE id=treasury.ledger_account_id AND legal_entity_id=receipt.legal_entity_id),
    'creditAccount',(SELECT jsonb_build_object('id',ledger.id,'code',ledger.account_code,'name',ledger.account_name)
      FROM abos.shareholder_capital_account_mapping_versions mapping JOIN abos.ledger_accounts ledger
        ON ledger.id=mapping.paid_in_capital_ledger_account_id AND ledger.legal_entity_id=mapping.legal_entity_id
      WHERE mapping.id=intent.shareholder_capital_account_mapping_version_id AND mapping.legal_entity_id=receipt.legal_entity_id))
  FROM abos.shareholder_capital_receipts receipt
  JOIN abos.operational_treasury_accounts treasury
    ON treasury.id = receipt.operational_treasury_account_id
   AND treasury.legal_entity_id = receipt.legal_entity_id
  LEFT JOIN abos.shareholder_capital_receipt_custody_verifications custody
    ON custody.shareholder_capital_receipt_id = receipt.id
   AND custody.legal_entity_id = receipt.legal_entity_id
  LEFT JOIN abos.posting_intents intent
    ON intent.shareholder_capital_receipt_id = receipt.id
   AND intent.legal_entity_id = receipt.legal_entity_id
  LEFT JOIN abos.posting_approvals approval
    ON approval.shareholder_capital_receipt_id = receipt.id
   AND approval.legal_entity_id = receipt.legal_entity_id
  LEFT JOIN abos.journals journal ON journal.posting_intent_id = intent.id
  WHERE receipt.id = p_receipt_id
$json$;

-- Capital readers need no shareholder master-data mutation authority.
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
    'today', current_date,
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

-- Capital readers need no shareholder master-data mutation authority.
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
    'today', current_date,
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

CREATE FUNCTION abos.shareholder_capital_configuration(p_identity_proof text,p_runtime_token_sha256 text,p_token_sha256 text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp
AS $config$
DECLARE v_context jsonb; v_entity uuid;
BEGIN
  v_context:=abos.operational_finance_actor(p_identity_proof,p_runtime_token_sha256,p_token_sha256,'finance.capital-receipt.configure');
  v_entity:=(v_context->>'legalEntityId')::uuid;
  RETURN jsonb_build_object('accounts',COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'id',l.id,'code',l.account_code,'name',l.account_name,'currency',l.account_currency_code) ORDER BY l.account_code)
    FROM abos.ledger_accounts l JOIN abos.legal_entities e ON e.id=l.legal_entity_id
    WHERE l.legal_entity_id=v_entity AND l.account_type='EQUITY' AND l.control_account_type='SHAREHOLDER_CAPITAL'
      AND l.status='ACTIVE' AND l.posting_allowed AND l.account_currency_code=e.base_currency_code
      AND NOT l.requires_project AND NOT l.requires_department AND NOT l.requires_cost_center),'[]'::jsonb),
    'mapping',(SELECT jsonb_build_object('mappingVersionId',id,'version',version,'ledgerAccountId',paid_in_capital_ledger_account_id)
      FROM abos.shareholder_capital_account_mapping_versions WHERE legal_entity_id=v_entity ORDER BY version DESC LIMIT 1));
END
$config$;
ALTER FUNCTION abos.shareholder_capital_configuration(text,text,text) OWNER TO abos_v1_operational_finance_owner;
REVOKE ALL ON FUNCTION abos.shareholder_capital_configuration(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION abos.shareholder_capital_configuration(text,text,text) TO abos_e1_runtime;
-- Trace-only column reads. No write privilege on financial records is added to an existing owner.
GRANT SELECT(id,display_name) ON abos.user_accounts TO abos_v1_shareholder_capital_owner;
GRANT SELECT(id,legal_entity_id,account_code,account_name) ON abos.ledger_accounts TO abos_v1_shareholder_capital_owner;
GRANT SELECT(id,version) ON abos.finance_workflow_policy_versions TO abos_v1_shareholder_capital_owner;
GRANT SELECT(evidence_reference_id,legal_entity_id,document_reference,sha256,evidence_kind)
  ON abos.shareholder_capital_evidence_registrations
  TO abos_v1_shareholder_capital_owner,abos_v1_operational_finance_owner;
