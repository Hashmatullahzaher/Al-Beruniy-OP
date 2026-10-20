-- Owner-approved administrative approval switches. Capability/schema only: no company policy,
-- account release, receipt, financial posting, person grant or operational configuration backfill.
-- Existing 0001-0038 files and all historical policy/review decisions remain immutable.

ALTER TABLE abos.finance_workflow_types DROP CONSTRAINT finance_workflow_types_workflow_type_check;
ALTER TABLE abos.finance_workflow_types ADD CONSTRAINT finance_workflow_types_workflow_type_check
  CHECK (workflow_type IN ('SHAREHOLDER_CAPITAL_RECEIPT','CUSTOMER_RECEIPT','OTHER_INCOME','EXPENSE',
    'SUPPLIER_PAYMENT','SALARY_PAYMENT','TREASURY_TRANSFER','TEMPORARY_FUNDING','CHART_OF_ACCOUNTS'));
INSERT INTO abos.finance_workflow_types(workflow_type,label_en,label_fa,sort_order)
VALUES ('CHART_OF_ACCOUNTS','Chart of Accounts','فهرست حساب‌ها',5);

-- A function owner is never a runtime group. Fail closed on accidental inherited authority.
DO $owner_membership$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r
    ON r.oid=m.roleid OR r.oid=m.member WHERE r.rolname='abos_v1_workflow_policy_owner') THEN
    RAISE EXCEPTION 'workflow policy owner must have no inherited or granted memberships';
  END IF;
END
$owner_membership$;

-- The command receipt is distinct from the immutable policy version. Actor/entity are derived;
-- the exact response is retained so retries do not append another version or audit event.
CREATE TABLE abos.finance_workflow_policy_commands (
  policy_version_id uuid PRIMARY KEY,
  legal_entity_id uuid NOT NULL,
  actor_user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  idempotency_key text NOT NULL CHECK(length(btrim(idempotency_key)) BETWEEN 8 AND 200),
  request_fingerprint text NOT NULL CHECK(request_fingerprint ~ '^[0-9a-f]{64}$'),
  correlation_id uuid NOT NULL,
  response_snapshot jsonb NOT NULL CHECK(jsonb_typeof(response_snapshot)='object'),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(legal_entity_id,actor_user_account_id,idempotency_key),
  FOREIGN KEY(policy_version_id,legal_entity_id) REFERENCES abos.finance_workflow_policy_versions(id,legal_entity_id)
);
CREATE TRIGGER finance_workflow_policy_commands_immutable BEFORE UPDATE OR DELETE
  ON abos.finance_workflow_policy_commands FOR EACH ROW EXECUTE FUNCTION abos.prevent_audit_mutation();
REVOKE ALL ON abos.finance_workflow_policy_commands FROM PUBLIC,abos_e1_runtime,abos_e1_treasury_runtime,abos_v1_identity_runtime;
GRANT SELECT ON abos.finance_workflow_policy_commands TO abos_v1_workflow_policy_owner;
GRANT INSERT(policy_version_id,legal_entity_id,actor_user_account_id,idempotency_key,
  request_fingerprint,correlation_id,response_snapshot)
  ON abos.finance_workflow_policy_commands TO abos_v1_workflow_policy_owner;

CREATE FUNCTION abos.finance_workflow_policy_set_command(
  p_identity_proof text,p_runtime_token_sha256 text,p_token_sha256 text,p_payload jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp
AS $command$
DECLARE
  v_context jsonb; v_actor uuid; v_entity uuid; v_type text; v_required boolean;
  v_expected integer; v_reason text; v_key text; v_correlation uuid; v_fingerprint text;
  v_current abos.finance_workflow_policy_versions%ROWTYPE;
  v_replay abos.finance_workflow_policy_commands%ROWTYPE;
  v_id uuid:=gen_random_uuid(); v_result jsonb;
BEGIN
  v_context:=abos.finance_workflow_policy_actor(p_identity_proof,p_runtime_token_sha256,p_token_sha256,
    'admin.finance-workflow.manage');
  IF v_context->>'sessionProvenance' IS DISTINCT FROM 'PASSWORD_OPERATIONAL' THEN
    RAISE EXCEPTION 'a real operational password session is required' USING ERRCODE='insufficient_privilege';
  END IF;
  v_actor:=(v_context->>'userAccountId')::uuid; v_entity:=(v_context->>'legalEntityId')::uuid;
  IF COALESCE(v_context->>'loginIdentifier','') LIKE 'system.local-bootstrap.%' THEN
    RAISE EXCEPTION 'internal bootstrap actors cannot administer workflow approval policies' USING ERRCODE='insufficient_privilege';
  END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload)<>'object'
     OR p_payload-ARRAY['workflowType','approvalRequired','expectedVersion','changeReason','idempotencyKey','correlationId']::text[]<>'{}'::jsonb
     OR jsonb_typeof(p_payload->'approvalRequired') IS DISTINCT FROM 'boolean' THEN
    RAISE EXCEPTION 'invalid policy command fields' USING ERRCODE='invalid_parameter_value';
  END IF;
  v_type:=p_payload->>'workflowType'; v_required:=(p_payload->>'approvalRequired')::boolean;
  v_expected:=(p_payload->>'expectedVersion')::integer; v_reason:=btrim(p_payload->>'changeReason');
  v_key:=btrim(p_payload->>'idempotencyKey'); v_correlation:=(p_payload->>'correlationId')::uuid;
  IF v_expected IS NULL OR v_expected<0 OR v_reason IS NULL OR length(v_reason) NOT BETWEEN 5 AND 500
     OR v_key IS NULL OR length(v_key) NOT BETWEEN 8 AND 200 OR v_correlation IS NULL THEN
    RAISE EXCEPTION 'current version, reason, idempotency key and correlation UUID are required' USING ERRCODE='invalid_parameter_value';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM abos.finance_workflow_types WHERE workflow_type=v_type AND active) THEN
    RAISE EXCEPTION 'unsupported workflow' USING ERRCODE='invalid_parameter_value';
  END IF;
  v_fingerprint:=encode(sha256(convert_to((p_payload-ARRAY['correlationId','idempotencyKey']::text[])::text||':'||v_actor::text||':'||v_entity::text,'UTF8')),'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended('abos-policy-command:'||v_entity::text||':'||v_actor::text||':'||v_key,0));
  SELECT * INTO v_replay FROM abos.finance_workflow_policy_commands
   WHERE legal_entity_id=v_entity AND actor_user_account_id=v_actor AND idempotency_key=v_key;
  IF FOUND THEN
    IF v_replay.request_fingerprint<>v_fingerprint THEN
      RAISE EXCEPTION 'idempotency key conflicts with an earlier policy command' USING ERRCODE='invalid_parameter_value';
    END IF;
    RETURN v_replay.response_snapshot||jsonb_build_object('replayed',true);
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('abos-finance-workflow-policy:'||v_entity::text||':'||v_type,0));
  SELECT * INTO v_current FROM abos.finance_workflow_policy_versions
   WHERE legal_entity_id=v_entity AND workflow_type=v_type ORDER BY version DESC LIMIT 1;
  IF COALESCE(v_current.version,0)<>v_expected THEN
    RAISE EXCEPTION 'workflow policy changed; reload and try again' USING ERRCODE='check_violation';
  END IF;
  INSERT INTO abos.finance_workflow_policy_versions(id,legal_entity_id,workflow_type,version,approval_required,
    configured_by_user_account_id,change_reason)
  VALUES(v_id,v_entity,v_type,v_expected+1,v_required,v_actor,v_reason);
  INSERT INTO abos.audit_records(id,actor_user_account_id,legal_entity_id,correlation_id,action,
    entity_type,entity_id,before_state,after_state,metadata)
  VALUES(gen_random_uuid(),v_actor,v_entity,v_correlation,'FINANCE_WORKFLOW_POLICY_CHANGED','FINANCE_WORKFLOW_POLICY',v_id,
    CASE WHEN v_current.id IS NOT NULL THEN to_jsonb(v_current) END,
    jsonb_build_object('policyVersionId',v_id,'workflowType',v_type,'version',v_expected+1,'approvalRequired',v_required,'changeReason',v_reason),
    jsonb_build_object('source','v1-admin-approval-controls','idempotencyKey',v_key));
  v_result:=abos.finance_workflow_policy_workspace(p_identity_proof,p_runtime_token_sha256,p_token_sha256)||jsonb_build_object('replayed',false);
  INSERT INTO abos.finance_workflow_policy_commands(policy_version_id,legal_entity_id,actor_user_account_id,
    idempotency_key,request_fingerprint,correlation_id,response_snapshot)
  VALUES(v_id,v_entity,v_actor,v_key,v_fingerprint,v_correlation,v_result);
  RETURN v_result;
END
$command$;
ALTER FUNCTION abos.finance_workflow_policy_set_command(text,text,text,jsonb) OWNER TO abos_v1_workflow_policy_owner;
REVOKE ALL ON FUNCTION abos.finance_workflow_policy_set_command(text,text,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION abos.finance_workflow_policy_set_command(text,text,text,jsonb) TO abos_v1_identity_runtime;

-- No unkeyed administration bypass remains. Historical policies are neither mutated nor deleted.
CREATE OR REPLACE FUNCTION abos.finance_workflow_policy_set(
  p_identity_proof text,p_runtime_token_sha256 text,p_token_sha256 text,p_workflow_type text,
  p_approval_required boolean,p_expected_version integer,p_change_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp
AS $obsolete$
BEGIN
  RAISE EXCEPTION 'use the idempotent workflow policy command' USING ERRCODE='feature_not_supported';
END
$obsolete$;
REVOKE ALL ON FUNCTION abos.finance_workflow_policy_set(text,text,text,text,boolean,integer,text)
  FROM PUBLIC,abos_v1_identity_runtime;

-- Snapshot approval requirements at each new/changed account definition. Existing accounts keep
-- their original review requirement until a separately authorized explicit policy release.
ALTER TABLE abos.ledger_account_governance
  DROP CONSTRAINT ledger_account_governance_review_state_check,
  ADD CONSTRAINT ledger_account_governance_review_state_check
    CHECK(review_state IN ('PENDING_REVIEW','REVIEWED','FLAGGED','NOT_REQUIRED')),
  ADD COLUMN finance_workflow_policy_version_id uuid,
  ADD COLUMN approval_required boolean NOT NULL DEFAULT true,
  ADD COLUMN policy_released_by_user_account_id uuid REFERENCES abos.user_accounts(id),
  ADD COLUMN policy_released_at timestamptz,
  ADD COLUMN policy_release_reason text CHECK(policy_release_reason IS NULL OR length(btrim(policy_release_reason)) BETWEEN 5 AND 500),
  ADD CONSTRAINT ledger_account_governance_policy_fk FOREIGN KEY(finance_workflow_policy_version_id,legal_entity_id)
    REFERENCES abos.finance_workflow_policy_versions(id,legal_entity_id),
  ADD CONSTRAINT ledger_account_governance_no_review_policy CHECK(review_state<>'NOT_REQUIRED'
    OR (approval_required=false AND finance_workflow_policy_version_id IS NOT NULL)),
  ADD CONSTRAINT ledger_account_governance_release_shape CHECK(
    (policy_released_by_user_account_id IS NULL AND policy_released_at IS NULL AND policy_release_reason IS NULL)
    OR (policy_released_by_user_account_id IS NOT NULL AND policy_released_at IS NOT NULL AND policy_release_reason IS NOT NULL));
GRANT SELECT(id,legal_entity_id,workflow_type,version,approval_required)
  ON abos.finance_workflow_policy_versions TO abos_e1_finance_owner;

CREATE FUNCTION abos.coa_current_approval_policy(p_entity uuid)
RETURNS TABLE(policy_version_id uuid,version integer,approval_required boolean,configured boolean)
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $policy$
  SELECT p.id,COALESCE(p.version,0),COALESCE(p.approval_required,true),p.id IS NOT NULL
  FROM (SELECT 1) anchor LEFT JOIN LATERAL (
    SELECT id,version,approval_required FROM abos.finance_workflow_policy_versions
    WHERE legal_entity_id=p_entity AND workflow_type='CHART_OF_ACCOUNTS' ORDER BY version DESC LIMIT 1
  ) p ON true
$policy$;
ALTER FUNCTION abos.coa_current_approval_policy(uuid) OWNER TO abos_e1_finance_owner;
REVOKE ALL ON FUNCTION abos.coa_current_approval_policy(uuid) FROM PUBLIC;

CREATE TABLE abos.ledger_account_policy_releases (
  id uuid PRIMARY KEY,
  legal_entity_id uuid NOT NULL,
  ledger_account_id uuid NOT NULL,
  account_version integer NOT NULL CHECK(account_version>0),
  policy_version_id uuid NOT NULL,
  actor_user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  released_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 5 AND 500),
  correlation_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK(length(btrim(idempotency_key)) BETWEEN 8 AND 200),
  request_fingerprint text NOT NULL CHECK(request_fingerprint ~ '^[0-9a-f]{64}$'),
  response_snapshot jsonb NOT NULL CHECK(jsonb_typeof(response_snapshot)='object'),
  UNIQUE(legal_entity_id,actor_user_account_id,idempotency_key),
  UNIQUE(ledger_account_id,account_version),
  FOREIGN KEY(ledger_account_id,legal_entity_id) REFERENCES abos.ledger_accounts(id,legal_entity_id),
  FOREIGN KEY(policy_version_id,legal_entity_id) REFERENCES abos.finance_workflow_policy_versions(id,legal_entity_id)
);
CREATE TRIGGER ledger_account_policy_releases_immutable BEFORE UPDATE OR DELETE
  ON abos.ledger_account_policy_releases FOR EACH ROW EXECUTE FUNCTION abos.prevent_audit_mutation();
REVOKE ALL ON abos.ledger_account_policy_releases FROM PUBLIC,abos_e1_runtime,abos_e1_treasury_runtime,abos_v1_identity_runtime;
GRANT SELECT ON abos.ledger_account_policy_releases TO abos_e1_finance_owner;
GRANT INSERT(id,legal_entity_id,ledger_account_id,account_version,policy_version_id,actor_user_account_id,
  reason,correlation_id,idempotency_key,request_fingerprint,response_snapshot)
  ON abos.ledger_account_policy_releases TO abos_e1_finance_owner;
GRANT UPDATE(finance_workflow_policy_version_id,approval_required,policy_released_by_user_account_id,
  policy_released_at,policy_release_reason) ON abos.ledger_account_governance TO abos_e1_finance_owner;

CREATE FUNCTION abos.finance_account_policy_reevaluate(p_bearer_token text,p_account_id uuid,p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp
AS $release$
DECLARE
  v_actor uuid; v_entity uuid; v_expected integer; v_reason text; v_key text; v_correlation uuid;
  v_hash text; v_account abos.ledger_accounts%ROWTYPE; v_gov abos.ledger_account_governance%ROWTYPE;
  v_policy record; v_replay abos.ledger_account_policy_releases%ROWTYPE;
  v_before jsonb; v_result jsonb; v_id uuid:=gen_random_uuid();
BEGIN
  v_actor:=abos.finance_runtime_authorize(p_bearer_token,'finance.ledger-account.manage');
  v_entity:=current_setting('abos.finance_legal_entity_id')::uuid;
  IF p_payload IS NULL OR jsonb_typeof(p_payload)<>'object'
    OR p_payload-ARRAY['expectedVersion','reason','idempotencyKey','correlationId']::text[]<>'{}'::jsonb THEN
    RAISE EXCEPTION 'valid account policy release fields are required' USING ERRCODE='invalid_parameter_value';
  END IF;
  v_expected:=(p_payload->>'expectedVersion')::integer; v_reason:=btrim(p_payload->>'reason');
  v_key:=btrim(p_payload->>'idempotencyKey');v_correlation:=(p_payload->>'correlationId')::uuid;
  IF v_expected IS NULL OR v_expected<1 OR v_reason IS NULL OR length(v_reason) NOT BETWEEN 5 AND 500
    OR v_key IS NULL OR length(v_key) NOT BETWEEN 8 AND 200 OR v_correlation IS NULL THEN
    RAISE EXCEPTION 'current account version, reason and command identifiers are required' USING ERRCODE='invalid_parameter_value';
  END IF;
  v_hash:=encode(sha256(convert_to((p_payload-ARRAY['correlationId','idempotencyKey']::text[])::text||':'||p_account_id::text||':'||v_actor::text,'UTF8')),'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended('abos-coa-release:'||v_entity::text||':'||v_actor::text||':'||v_key,0));
  SELECT * INTO v_replay FROM abos.ledger_account_policy_releases
    WHERE legal_entity_id=v_entity AND actor_user_account_id=v_actor AND idempotency_key=v_key;
  IF FOUND THEN
    IF v_replay.request_fingerprint<>v_hash THEN RAISE EXCEPTION 'idempotency key conflicts with an earlier release' USING ERRCODE='invalid_parameter_value'; END IF;
    RETURN v_replay.response_snapshot||jsonb_build_object('replayed',true);
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('abos-coa:'||v_entity::text,0));
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('abos-finance-workflow-policy:'||v_entity::text||':CHART_OF_ACCOUNTS',0));
  SELECT * INTO v_account FROM abos.ledger_accounts WHERE id=p_account_id AND legal_entity_id=v_entity FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ledger account not found' USING ERRCODE='no_data_found'; END IF;
  SELECT * INTO v_gov FROM abos.ledger_account_governance WHERE ledger_account_id=p_account_id AND legal_entity_id=v_entity FOR UPDATE;
  IF NOT FOUND OR v_gov.version<>v_expected THEN RAISE EXCEPTION 'account changed; reload and try again' USING ERRCODE='serialization_failure'; END IF;
  SELECT * INTO v_policy FROM abos.coa_current_approval_policy(v_entity);
  IF NOT v_policy.configured OR v_policy.approval_required IS DISTINCT FROM false OR v_gov.review_state<>'PENDING_REVIEW' THEN
    RAISE EXCEPTION 'only an awaiting-review account can be released under an explicit current OFF policy' USING ERRCODE='check_violation';
  END IF;
  IF v_account.status<>'ACTIVE' THEN RAISE EXCEPTION 'inactive accounts cannot be released as usable' USING ERRCODE='check_violation'; END IF;
  PERFORM abos.coa_validate(v_account.account_code,v_account.account_name,v_gov.account_name_fa,v_gov.description,
    v_account.account_type,v_account.control_account_type,v_account.account_currency_code,v_account.posting_allowed,v_account.status);
  PERFORM abos.coa_assert_single_capital(v_entity,p_account_id,v_account.control_account_type,
    v_account.account_currency_code,v_account.posting_allowed,v_account.status);
  v_before:=abos.coa_account_json(p_account_id,NULL);
  UPDATE abos.ledger_account_governance SET review_state='NOT_REQUIRED',approval_required=false,
    finance_workflow_policy_version_id=v_policy.policy_version_id,version=version+1,
    policy_released_by_user_account_id=v_actor,policy_released_at=clock_timestamp(),policy_release_reason=v_reason
    WHERE ledger_account_id=p_account_id AND legal_entity_id=v_entity;
  v_result:=jsonb_build_object('account',abos.coa_account_json(p_account_id,v_actor),'warnings','[]'::jsonb,'replayed',false);
  INSERT INTO abos.ledger_account_policy_releases(id,legal_entity_id,ledger_account_id,account_version,policy_version_id,
    actor_user_account_id,reason,correlation_id,idempotency_key,request_fingerprint,response_snapshot)
  VALUES(v_id,v_entity,p_account_id,v_expected+1,v_policy.policy_version_id,v_actor,v_reason,v_correlation,v_key,v_hash,v_result);
  INSERT INTO abos.audit_records(id,actor_user_account_id,legal_entity_id,correlation_id,action,entity_type,entity_id,
    before_state,after_state,metadata)
  VALUES(gen_random_uuid(),v_actor,v_entity,v_correlation,'LEDGER_ACCOUNT_RELEASED_UNDER_POLICY','LEDGER_ACCOUNT',p_account_id,
    v_before,v_result->'account',jsonb_build_object('source','v1-admin-approval-controls','policyVersionId',v_policy.policy_version_id,
      'approvalOccurred',false,'reason',v_reason,'idempotencyKey',v_key));
  RETURN v_result;
END
$release$;
ALTER FUNCTION abos.finance_account_policy_reevaluate(text,uuid,jsonb) OWNER TO abos_e1_finance_owner;
REVOKE ALL ON FUNCTION abos.finance_account_policy_reevaluate(text,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION abos.finance_account_policy_reevaluate(text,uuid,jsonb) TO abos_e1_runtime;

-- Policy-aware replacements follow. All unrelated legacy/Expense/Temporary Funding dispatchers
-- stay unchanged. Capital binds the current immutable policy at PREPARE, not at posting time.
-- BEGIN POLICY REPLACEMENTS

CREATE OR REPLACE FUNCTION abos.coa_account_json(p_account_id uuid, p_viewer uuid)
RETURNS jsonb
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT jsonb_build_object(
    'id', la.id, 'code', la.account_code, 'name', la.account_name, 'nameFa', g.account_name_fa, 'description', g.description,
    'type', la.account_type, 'controlType', la.control_account_type, 'currency', la.account_currency_code,
    'parentId', la.parent_ledger_account_id, 'postingAllowed', la.posting_allowed,
    'requiresProject', la.requires_project, 'requiresDepartment', la.requires_department, 'requiresCostCenter', la.requires_cost_center,
    'status', la.status, 'createdAt', la.created_at,
    'origin', coalesce(g.origin, 'PRE_EXISTING'), 'version', coalesce(g.version, 0),
    'reviewState', g.review_state, 'reviewReason', g.review_reason,
    'approvalPolicyVersion', (SELECT p.version FROM abos.finance_workflow_policy_versions p WHERE p.id=g.finance_workflow_policy_version_id),
    'approvalRequired', COALESCE(g.approval_required,true),
    'policyReleasedBy', (SELECT u.display_name FROM abos.user_accounts u WHERE u.id=g.policy_released_by_user_account_id),
    'policyReleasedAt', g.policy_released_at, 'policyReleaseReason', g.policy_release_reason,
    'createdBy', (SELECT u.display_name FROM abos.user_accounts u WHERE u.id = g.created_by_user_account_id),
    'lastChangedBy', (SELECT u.display_name FROM abos.user_accounts u WHERE u.id = g.last_changed_by_user_account_id),
    'lastChangedAt', g.last_changed_at,
    'lastReviewedBy', (SELECT u.display_name FROM abos.user_accounts u WHERE u.id = g.last_reviewed_by_user_account_id),
    'lastReviewedAt', g.last_reviewed_at, 'lastReviewNote', g.last_review_note,
    'duplicateWarnings', coalesce(g.duplicate_warnings, '[]'::jsonb),
    'viewerIsParticipant', p_viewer IS NOT NULL AND (p_viewer = g.created_by_user_account_id OR p_viewer = g.last_changed_by_user_account_id),
    'usage', abos.ledger_account_usage(la.id),
    'reviews', coalesce((SELECT jsonb_agg(jsonb_build_object('decision', d.decision, 'note', d.note, 'version', d.account_version,
                                  'reviewer', (SELECT u.display_name FROM abos.user_accounts u WHERE u.id = d.reviewer_user_account_id),
                                  'decidedAt', d.decided_at) ORDER BY d.decided_at DESC)
                           FROM abos.ledger_account_review_decisions d WHERE d.ledger_account_id = la.id), '[]'::jsonb))
    FROM abos.ledger_accounts la
    LEFT JOIN abos.ledger_account_governance g ON g.ledger_account_id = la.id
   WHERE la.id = p_account_id
$$;

CREATE OR REPLACE FUNCTION abos.finance_ledger_accounts_view(p_bearer_token text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $view$
DECLARE
  actor uuid;
  entity uuid;
  can_manage boolean := false;
  can_review boolean := false;
  can_read boolean := false;
BEGIN
  BEGIN
    actor := abos.finance_runtime_authorize(p_bearer_token, 'finance.ledger-account.manage');
    can_manage := true;
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    actor := abos.finance_runtime_authorize(p_bearer_token, 'finance.ledger-account.review');
    can_review := true;
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    actor := abos.finance_runtime_authorize(p_bearer_token, 'finance.report.operational.read');
    can_read := true;
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  IF NOT (can_manage OR can_review OR can_read) THEN
    -- Re-raise the real refusal: an ended session, or the missing permission.
    actor := abos.finance_runtime_authorize(p_bearer_token, 'finance.ledger-account.manage');
  END IF;
  entity := current_setting('abos.finance_legal_entity_id')::uuid;
  RETURN jsonb_build_object(
    'canManage', can_manage, 'canReview', can_review,
    'approvalPolicy', (SELECT jsonb_build_object('version',p.version,'approvalRequired',p.approval_required,'configured',p.configured)
      FROM abos.coa_current_approval_policy(entity) p),
    'actor', (SELECT jsonb_build_object('displayName', u.display_name) FROM abos.user_accounts u WHERE u.id = actor),
    'legalEntity', (SELECT jsonb_build_object('id', e.id, 'name', e.name, 'baseCurrency', e.base_currency_code)
                      FROM abos.legal_entities e WHERE e.id = entity),
    'currencies', coalesce((SELECT jsonb_agg(jsonb_build_object('code', c.code, 'name', c.name) ORDER BY c.code)
                              FROM abos.currencies c WHERE c.enabled), '[]'::jsonb),
    'accounts', coalesce((SELECT jsonb_agg(abos.coa_account_json(la.id, actor) ORDER BY lower(la.account_code))
                            FROM abos.ledger_accounts la WHERE la.legal_entity_id = entity), '[]'::jsonb),
    'reviewQueue', (SELECT count(*) FROM abos.ledger_account_governance g
                     WHERE g.legal_entity_id = entity AND g.review_state IN ('PENDING_REVIEW', 'FLAGGED')));
END;
$view$;

CREATE OR REPLACE FUNCTION abos.finance_ledger_account_create(p_bearer_token text, p_account jsonb, p_confirm_duplicates boolean)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $create$
DECLARE
  actor uuid;
  entity uuid;
  new_id uuid := gen_random_uuid();
  v_code text; v_name text; v_name_fa text; v_description text; v_type text; v_control text; v_currency text;
  v_parent uuid; v_posting boolean;
  warnings jsonb;
  created jsonb;
  v_policy record;
BEGIN
  actor := abos.finance_runtime_authorize(p_bearer_token, 'finance.ledger-account.manage');
  entity := current_setting('abos.finance_legal_entity_id')::uuid;
  PERFORM abos.coa_assert_keys(p_account);
  v_code := abos.coa_text(p_account, 'code');
  v_name := abos.coa_text(p_account, 'name');
  v_name_fa := abos.coa_text(p_account, 'nameFa');
  v_description := abos.coa_text(p_account, 'description');
  v_type := abos.coa_text(p_account, 'type');
  v_control := abos.coa_text(p_account, 'controlType');
  v_currency := abos.coa_text(p_account, 'currency');
  BEGIN
    v_parent := abos.coa_text(p_account, 'parentId')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'the parent account does not exist in this company' USING ERRCODE = 'foreign_key_violation';
  END;
  v_posting := abos.coa_bool(p_account, 'postingAllowed');
  PERFORM abos.coa_validate(v_code, v_name, v_name_fa, v_description, v_type, v_control, v_currency, v_posting, 'ACTIVE');

  -- One writer per company at a time, so the duplicate check and the insert see the same accounts.
  PERFORM pg_advisory_xact_lock(hashtextextended('abos-coa:' || entity::text, 0));
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('abos-finance-workflow-policy:'||entity::text||':CHART_OF_ACCOUNTS',0));
  SELECT * INTO v_policy FROM abos.coa_current_approval_policy(entity);
  IF EXISTS (SELECT 1 FROM abos.ledger_accounts la WHERE la.legal_entity_id = entity AND lower(btrim(la.account_code)) = lower(v_code)) THEN
    RAISE EXCEPTION 'account code % already exists in this company', v_code USING ERRCODE = 'unique_violation';
  END IF;
  PERFORM abos.coa_assert_single_capital(entity, NULL, v_control, v_currency, v_posting, 'ACTIVE');
  warnings := abos.coa_duplicate_warnings(entity, NULL, v_code, v_name, v_name_fa, v_type, v_currency, v_control);
  IF jsonb_path_exists(warnings, '$[*] ? (@.severity == "LIKELY")') AND NOT coalesce(p_confirm_duplicates, false) THEN
    RAISE EXCEPTION 'likely duplicate accounts exist; review the warnings and confirm to create the account anyway'
      USING ERRCODE = 'ABC01', DETAIL = warnings::text;
  END IF;

  PERFORM pg_catalog.set_config('abos.coa_command', 'on', true);
  INSERT INTO abos.ledger_accounts
    (id, legal_entity_id, parent_ledger_account_id, account_code, account_name, account_type, control_account_type,
     posting_allowed, requires_project, requires_department, requires_cost_center, account_currency_code, status)
  VALUES (new_id, entity, v_parent, v_code, v_name, v_type, v_control, v_posting,
          coalesce(abos.coa_bool(p_account, 'requiresProject'), false),
          coalesce(abos.coa_bool(p_account, 'requiresDepartment'), false),
          coalesce(abos.coa_bool(p_account, 'requiresCostCenter'), false),
          v_currency, 'ACTIVE');
  INSERT INTO abos.ledger_account_governance
    (ledger_account_id, legal_entity_id, account_name_fa, description, origin, created_by_user_account_id, created_at,
     last_changed_by_user_account_id, last_changed_at, version, review_state, review_reason, duplicate_warnings, finance_workflow_policy_version_id, approval_required)
  VALUES (new_id, entity, v_name_fa, v_description, 'APP', actor, clock_timestamp(), actor, clock_timestamp(), 1,
          CASE WHEN v_policy.approval_required THEN 'PENDING_REVIEW' ELSE 'NOT_REQUIRED' END, 'CREATED', warnings, v_policy.policy_version_id, v_policy.approval_required);
  PERFORM pg_catalog.set_config('abos.coa_command', '', true);

  created := abos.coa_account_json(new_id, NULL);
  INSERT INTO abos.audit_records (id, actor_user_account_id, legal_entity_id, correlation_id, action, entity_type, entity_id, after_state, metadata)
  VALUES (gen_random_uuid(), actor, entity, gen_random_uuid(), 'LEDGER_ACCOUNT_CREATED', 'LEDGER_ACCOUNT', new_id, created - 'usage' - 'reviews',
          jsonb_build_object('source', 'finance_ledger_account_create', 'duplicateWarnings', warnings,
                             'confirmedDuplicates', coalesce(p_confirm_duplicates, false)));
  RETURN jsonb_build_object('account', abos.coa_account_json(new_id, actor), 'warnings', warnings);
END;
$create$;

CREATE OR REPLACE FUNCTION abos.finance_ledger_account_update(
  p_bearer_token text, p_account_id uuid, p_expected_version integer, p_changes jsonb, p_confirm_duplicates boolean
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $update$
DECLARE
  actor uuid;
  entity uuid;
  account_row abos.ledger_accounts%ROWTYPE;
  governance_row abos.ledger_account_governance%ROWTYPE;
  has_governance boolean;
  before_state jsonb;
  usage jsonb;
  warnings jsonb := '[]'::jsonb;
  ledger_changed boolean;
  identity_changed boolean;
  v_policy record;
  v_code text; v_name text; v_name_fa text; v_description text; v_type text; v_control text; v_currency text;
  v_parent uuid; v_posting boolean; v_project boolean; v_department boolean; v_cost_center boolean;
BEGIN
  actor := abos.finance_runtime_authorize(p_bearer_token, 'finance.ledger-account.manage');
  entity := current_setting('abos.finance_legal_entity_id')::uuid;
  PERFORM abos.coa_assert_keys(p_changes);
  IF p_expected_version IS NULL THEN
    RAISE EXCEPTION 'the expected account version is required' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('abos-coa:' || entity::text, 0));
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('abos-finance-workflow-policy:'||entity::text||':CHART_OF_ACCOUNTS',0));
  SELECT * INTO v_policy FROM abos.coa_current_approval_policy(entity);
  SELECT * INTO account_row FROM abos.ledger_accounts WHERE id = p_account_id AND legal_entity_id = entity FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ledger account not found' USING ERRCODE = 'no_data_found';
  END IF;
  SELECT * INTO governance_row FROM abos.ledger_account_governance WHERE ledger_account_id = p_account_id FOR UPDATE;
  has_governance := FOUND;
  IF coalesce(governance_row.version, 0) <> p_expected_version THEN
    RAISE EXCEPTION 'the account was changed by someone else' USING ERRCODE = 'serialization_failure';
  END IF;
  before_state := abos.coa_account_json(p_account_id, NULL) - 'usage' - 'reviews';

  v_code := CASE WHEN p_changes ? 'code' THEN abos.coa_text(p_changes, 'code') ELSE account_row.account_code END;
  v_name := CASE WHEN p_changes ? 'name' THEN abos.coa_text(p_changes, 'name') ELSE account_row.account_name END;
  v_name_fa := CASE WHEN p_changes ? 'nameFa' THEN abos.coa_text(p_changes, 'nameFa') ELSE governance_row.account_name_fa END;
  v_description := CASE WHEN p_changes ? 'description' THEN abos.coa_text(p_changes, 'description') ELSE governance_row.description END;
  v_type := CASE WHEN p_changes ? 'type' THEN abos.coa_text(p_changes, 'type') ELSE account_row.account_type END;
  v_control := CASE WHEN p_changes ? 'controlType' THEN abos.coa_text(p_changes, 'controlType') ELSE account_row.control_account_type END;
  v_currency := CASE WHEN p_changes ? 'currency' THEN abos.coa_text(p_changes, 'currency') ELSE account_row.account_currency_code END;
  BEGIN
    v_parent := CASE WHEN p_changes ? 'parentId' THEN abos.coa_text(p_changes, 'parentId')::uuid ELSE account_row.parent_ledger_account_id END;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'the parent account does not exist in this company' USING ERRCODE = 'foreign_key_violation';
  END;
  v_posting := CASE WHEN p_changes ? 'postingAllowed' THEN abos.coa_bool(p_changes, 'postingAllowed') ELSE account_row.posting_allowed END;
  v_project := coalesce(CASE WHEN p_changes ? 'requiresProject' THEN abos.coa_bool(p_changes, 'requiresProject') END, account_row.requires_project);
  v_department := coalesce(CASE WHEN p_changes ? 'requiresDepartment' THEN abos.coa_bool(p_changes, 'requiresDepartment') END, account_row.requires_department);
  v_cost_center := coalesce(CASE WHEN p_changes ? 'requiresCostCenter' THEN abos.coa_bool(p_changes, 'requiresCostCenter') END, account_row.requires_cost_center);

  ledger_changed := (v_code, v_name, v_type, v_control, v_currency, v_parent, v_posting, v_project, v_department, v_cost_center)
    IS DISTINCT FROM (account_row.account_code, account_row.account_name, account_row.account_type, account_row.control_account_type,
                      account_row.account_currency_code, account_row.parent_ledger_account_id, account_row.posting_allowed,
                      account_row.requires_project, account_row.requires_department, account_row.requires_cost_center);
  IF NOT ledger_changed AND (v_name_fa, v_description) IS NOT DISTINCT FROM (governance_row.account_name_fa, governance_row.description) THEN
    RETURN jsonb_build_object('account', abos.coa_account_json(p_account_id, actor), 'warnings', '[]'::jsonb, 'changed', false);
  END IF;

  PERFORM abos.coa_validate(v_code, v_name, v_name_fa, v_description, v_type, v_control, v_currency, v_posting, account_row.status);
  usage := abos.ledger_account_usage(p_account_id);
  IF ledger_changed AND (usage ->> 'postedJournalLines')::integer > 0 THEN
    RAISE EXCEPTION 'account % has posted activity; only its Dari name and description can change', account_row.account_code
      USING ERRCODE = 'ABC02';
  END IF;
  IF (usage ->> 'inUse')::boolean AND (
       (v_code, v_type, v_currency, v_control, v_project, v_department, v_cost_center) IS DISTINCT FROM
       (account_row.account_code, account_row.account_type, account_row.account_currency_code, account_row.control_account_type,
        account_row.requires_project, account_row.requires_department, account_row.requires_cost_center)
       OR (account_row.posting_allowed AND NOT v_posting)) THEN
    RAISE EXCEPTION 'account % is in use, so its code, type, currency, control type, posting and dimension settings cannot change', account_row.account_code
      USING ERRCODE = 'ABC02';
  END IF;
  IF lower(v_code) <> lower(account_row.account_code) AND EXISTS (
       SELECT 1 FROM abos.ledger_accounts la WHERE la.legal_entity_id = entity AND la.id <> p_account_id
          AND lower(btrim(la.account_code)) = lower(v_code)) THEN
    RAISE EXCEPTION 'account code % already exists in this company', v_code USING ERRCODE = 'unique_violation';
  END IF;
  PERFORM abos.coa_assert_single_capital(entity, p_account_id, v_control, v_currency, v_posting, account_row.status);

  identity_changed := (v_code, v_name, v_name_fa, v_type, v_currency, v_control) IS DISTINCT FROM
    (account_row.account_code, account_row.account_name, governance_row.account_name_fa, account_row.account_type,
     account_row.account_currency_code, account_row.control_account_type);
  IF identity_changed THEN
    warnings := abos.coa_duplicate_warnings(entity, p_account_id, v_code, v_name, v_name_fa, v_type, v_currency, v_control);
    IF jsonb_path_exists(warnings, '$[*] ? (@.severity == "LIKELY")') AND NOT coalesce(p_confirm_duplicates, false) THEN
      RAISE EXCEPTION 'likely duplicate accounts exist; review the warnings and confirm to save the change anyway'
        USING ERRCODE = 'ABC01', DETAIL = warnings::text;
    END IF;
  END IF;

  PERFORM pg_catalog.set_config('abos.coa_command', 'on', true);
  IF ledger_changed THEN
    UPDATE abos.ledger_accounts
       SET account_code = v_code, account_name = v_name, account_type = v_type, control_account_type = v_control,
           account_currency_code = v_currency, parent_ledger_account_id = v_parent, posting_allowed = v_posting,
           requires_project = v_project, requires_department = v_department, requires_cost_center = v_cost_center
     WHERE id = p_account_id;
  END IF;
  IF has_governance THEN
    UPDATE abos.ledger_account_governance
       SET account_name_fa = v_name_fa, description = v_description,
           last_changed_by_user_account_id = actor, last_changed_at = clock_timestamp(), version = version + 1,
           review_reason = CASE WHEN review_state = 'PENDING_REVIEW' THEN review_reason ELSE 'CHANGED' END,
           review_state = CASE WHEN v_policy.approval_required THEN 'PENDING_REVIEW' ELSE 'NOT_REQUIRED' END,
           finance_workflow_policy_version_id=v_policy.policy_version_id, approval_required=v_policy.approval_required,
           policy_released_by_user_account_id=NULL, policy_released_at=NULL, policy_release_reason=NULL,
           duplicate_warnings = CASE WHEN identity_changed THEN warnings ELSE duplicate_warnings END
     WHERE ledger_account_id = p_account_id;
  ELSE
    -- An account created outside the app (for example the synthetic seed) enters the review list
    -- the first time it is changed in the app.
    INSERT INTO abos.ledger_account_governance
      (ledger_account_id, legal_entity_id, account_name_fa, description, origin, created_by_user_account_id, created_at,
       last_changed_by_user_account_id, last_changed_at, version, review_state, review_reason, duplicate_warnings, finance_workflow_policy_version_id, approval_required)
    VALUES (p_account_id, entity, v_name_fa, v_description, 'PRE_EXISTING', NULL, account_row.created_at, actor, clock_timestamp(), 1,
            CASE WHEN v_policy.approval_required THEN 'PENDING_REVIEW' ELSE 'NOT_REQUIRED' END, 'CHANGED', warnings, v_policy.policy_version_id, v_policy.approval_required);
  END IF;
  PERFORM pg_catalog.set_config('abos.coa_command', '', true);

  INSERT INTO abos.audit_records (id, actor_user_account_id, legal_entity_id, correlation_id, action, entity_type, entity_id, before_state, after_state, metadata)
  VALUES (gen_random_uuid(), actor, entity, gen_random_uuid(), 'LEDGER_ACCOUNT_UPDATED', 'LEDGER_ACCOUNT', p_account_id, before_state,
          abos.coa_account_json(p_account_id, NULL) - 'usage' - 'reviews',
          jsonb_build_object('source', 'finance_ledger_account_update', 'duplicateWarnings', warnings,
                             'confirmedDuplicates', coalesce(p_confirm_duplicates, false)));
  RETURN jsonb_build_object('account', abos.coa_account_json(p_account_id, actor), 'warnings', warnings, 'changed', true);
END;
$update$;

CREATE OR REPLACE FUNCTION abos.guard_ledger_account_review()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  governance_row record;
BEGIN
  SELECT created_by_user_account_id, last_changed_by_user_account_id, version, review_state, approval_required
    INTO governance_row
    FROM abos.ledger_account_governance
   WHERE ledger_account_id = NEW.ledger_account_id AND legal_entity_id = NEW.legal_entity_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'only accounts created or changed in the app are reviewed' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT governance_row.approval_required OR governance_row.review_state NOT IN ('PENDING_REVIEW','FLAGGED') THEN
    RAISE EXCEPTION 'this account does not await an approval decision' USING ERRCODE='check_violation';
  END IF;
  IF NEW.reviewer_user_account_id = governance_row.created_by_user_account_id
     OR NEW.reviewer_user_account_id = governance_row.last_changed_by_user_account_id THEN
    RAISE EXCEPTION 'the reviewer of an account cannot be the person who created or last changed it'
      USING ERRCODE = 'ABC03';
  END IF;
  IF NEW.account_version <> governance_row.version THEN
    RAISE EXCEPTION 'the account was changed by someone else' USING ERRCODE = 'serialization_failure';
  END IF;
  RETURN NEW;
END;
$$;

-- Additive 0039 Capital replacements. No generic0037 dispatch replacement.

CREATE OR REPLACE FUNCTION abos.shareholder_capital_capability(
  p_identity_proof text,p_runtime_token_sha256 text,p_token_sha256 text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $capability$
DECLARE
  v_context jsonb; v_entity uuid; v_permissions jsonb; v_policy record; v_mapping uuid;
  v_treasury_destinations jsonb;
BEGIN
  v_context:=abos.operational_finance_actor(p_identity_proof,p_runtime_token_sha256,p_token_sha256,NULL);
  v_entity:=(v_context->>'legalEntityId')::uuid;
  v_permissions:=COALESCE(v_context->'permissions','[]'::jsonb);
  IF NOT (v_permissions ? 'shareholder.capital-receipt.read'
       OR v_permissions ? 'shareholder.capital-receipt.record'
       OR v_permissions ? 'treasury.capital-receipt.verify'
       OR v_permissions ? 'finance.capital-receipt.configure'
       OR v_permissions ? 'finance.capital-receipt.prepare'
       OR v_permissions ? 'finance.capital-receipt.approve'
       OR v_permissions ? 'finance.capital-receipt.post') THEN
    RAISE EXCEPTION 'current authority has no shareholder capital bridge permission'
      USING ERRCODE='insufficient_privilege';
  END IF;
  SELECT id,approval_required,version INTO v_policy FROM abos.finance_workflow_policy_versions
   WHERE legal_entity_id=v_entity AND workflow_type='SHAREHOLDER_CAPITAL_RECEIPT'
   ORDER BY version DESC LIMIT 1;
  SELECT mapping.id INTO v_mapping
    FROM abos.shareholder_capital_account_mapping_versions mapping
    JOIN abos.ledger_accounts ledger
      ON ledger.id=mapping.paid_in_capital_ledger_account_id
     AND ledger.legal_entity_id=mapping.legal_entity_id
   WHERE mapping.legal_entity_id=v_entity
     AND ledger.status='ACTIVE' AND ledger.posting_allowed
     AND ledger.account_type='EQUITY' AND ledger.control_account_type='SHAREHOLDER_CAPITAL'
     AND NOT ledger.requires_project AND NOT ledger.requires_department
     AND NOT ledger.requires_cost_center
   ORDER BY mapping.version DESC LIMIT 1;
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'id',account.id,'name',account.name_en,'currency',account.currency_code)
           ORDER BY account.name_en), '[]'::jsonb)
    INTO v_treasury_destinations
    FROM abos.operational_treasury_accounts account
    JOIN abos.ledger_accounts ledger
      ON ledger.id=account.ledger_account_id AND ledger.legal_entity_id=account.legal_entity_id
    JOIN abos.legal_entities entity ON entity.id=account.legal_entity_id
   WHERE account.legal_entity_id=v_entity AND account.status='ACTIVE'
     AND entity.currency_policy_status='APPROVED'
     AND account.currency_code=entity.base_currency_code
     AND ledger.status='ACTIVE' AND ledger.posting_allowed
     AND ledger.account_type='ASSET' AND ledger.control_account_type='CASH'
     AND NOT ledger.requires_project AND NOT ledger.requires_department
     AND NOT ledger.requires_cost_center;
  RETURN pg_catalog.jsonb_build_object(
    'state',CASE WHEN v_policy.id IS NOT NULL AND v_mapping IS NOT NULL
                       AND pg_catalog.jsonb_array_length(v_treasury_destinations)>0
                 THEN 'OPERATIONAL' ELSE 'NOT_OPERATIONAL' END,
    'schemaInstalled',true,
    'mutationAvailable',v_policy.id IS NOT NULL AND v_mapping IS NOT NULL
                        AND pg_catalog.jsonb_array_length(v_treasury_destinations)>0,
    'reviewModeAvailable',false,
    'requiredSessionProvenance','PASSWORD_OPERATIONAL',
    'reason',CASE WHEN v_policy.id IS NULL THEN 'Capital receipt approval policy is not configured.'
                  WHEN v_mapping IS NULL THEN 'Paid-in-capital account mapping is not configured.'
                  WHEN pg_catalog.jsonb_array_length(v_treasury_destinations)=0
                    THEN 'No active base-currency Treasury destination is configured.'
                  ELSE 'The Shareholders to Finance bridge is operational.' END,
    'permissions',v_permissions,
    'policyVersion',v_policy.version,
    'approvalRequired',v_policy.approval_required,
    'mappingVersionId',v_mapping,
    'treasuryDestinations',v_treasury_destinations);
END
$capability$;

CREATE OR REPLACE FUNCTION abos.prepare_shareholder_capital_posting(
  p_identity_proof text,p_runtime_token_sha256 text,p_token_sha256 text,
  p_receipt_id uuid,p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $prepare$
DECLARE
  v_context jsonb; v_actor uuid; v_entity uuid; v_receipt abos.shareholder_capital_receipts%ROWTYPE;
  v_source abos.shareholder_contributions%ROWTYPE; v_custody record; v_treasury record;
  v_expected integer; v_effective date; v_key text; v_correlation uuid;
  v_fingerprint text; v_scope text; v_idem jsonb; v_policy record; v_mapping record;
  v_period uuid; v_intent uuid; v_result jsonb; v_existing record;
BEGIN
  v_context := abos.operational_finance_actor(p_identity_proof,p_runtime_token_sha256,
    p_token_sha256,'finance.capital-receipt.prepare');
  v_actor := (v_context ->> 'userAccountId')::uuid; v_entity := (v_context ->> 'legalEntityId')::uuid;
  IF EXISTS (SELECT 1 FROM pg_catalog.jsonb_object_keys(p_payload) key
              WHERE key NOT IN ('expectedReceiptVersion','accountingEffectiveDate','idempotencyKey','correlationId')) THEN
    RAISE EXCEPTION 'capital preparation request contains unsupported fields' USING ERRCODE='invalid_parameter_value';
  END IF;
  BEGIN
    v_expected := (p_payload ->> 'expectedReceiptVersion')::integer;
    v_effective := (p_payload ->> 'accountingEffectiveDate')::date;
    v_key := btrim(p_payload ->> 'idempotencyKey'); v_correlation := (p_payload ->> 'correlationId')::uuid;
  EXCEPTION WHEN others THEN RAISE EXCEPTION 'a complete capital preparation request is required'
    USING ERRCODE='invalid_parameter_value'; END;
  SELECT * INTO v_receipt FROM abos.shareholder_capital_receipts
   WHERE id=p_receipt_id AND legal_entity_id=v_entity;
  IF NOT FOUND THEN RAISE EXCEPTION 'capital receipt is not available in this legal entity'
    USING ERRCODE='no_data_found'; END IF;
  IF v_receipt.version<>v_expected THEN RAISE EXCEPTION 'capital receipt changed; reload and try again'
    USING ERRCODE='serialization_failure'; END IF;
  IF v_effective IS DISTINCT FROM v_receipt.receipt_date THEN
    RAISE EXCEPTION 'first-slice capital accounting date must equal the receipt date'
      USING ERRCODE='check_violation';
  END IF;
  SELECT * INTO v_source FROM abos.shareholder_contributions
   WHERE id=v_receipt.contribution_id AND legal_entity_id=v_entity;
  SELECT decision,verified_by_user_account_id INTO v_custody
    FROM abos.shareholder_capital_receipt_custody_verifications
   WHERE shareholder_capital_receipt_id=v_receipt.id AND legal_entity_id=v_entity;
  IF v_source.contribution_type<>'CASH' OR v_source.record_status<>'DECLARED'
     OR v_source.version<>v_receipt.contribution_version OR v_custody.decision IS DISTINCT FROM 'VERIFIED' THEN
    RAISE EXCEPTION 'capital receipt requires its unchanged declared CASH source and verified custody'
      USING ERRCODE='check_violation';
  END IF;
  SELECT account.id,account.currency_code,account.status,ledger.status AS ledger_status,
         ledger.posting_allowed,ledger.account_type,ledger.control_account_type,
         ledger.requires_project,ledger.requires_department,ledger.requires_cost_center
    INTO v_treasury
    FROM abos.operational_treasury_accounts account
    JOIN abos.ledger_accounts ledger ON ledger.id=account.ledger_account_id
     AND ledger.legal_entity_id=account.legal_entity_id
   WHERE account.id=v_receipt.operational_treasury_account_id AND account.legal_entity_id=v_entity;
  IF v_treasury.status<>'ACTIVE' OR v_treasury.ledger_status<>'ACTIVE' OR NOT v_treasury.posting_allowed
     OR v_treasury.account_type<>'ASSET' OR v_treasury.control_account_type<>'CASH'
     OR v_treasury.requires_project OR v_treasury.requires_department OR v_treasury.requires_cost_center
     OR v_treasury.currency_code<>v_receipt.original_currency_code THEN
    RAISE EXCEPTION 'capital receipt Treasury mapping is not active, postable and dimension-free'
      USING ERRCODE='check_violation';
  END IF;
  SELECT * INTO v_policy FROM abos.finance_workflow_policy_versions
   WHERE legal_entity_id=v_entity AND workflow_type='SHAREHOLDER_CAPITAL_RECEIPT'
   ORDER BY version DESC LIMIT 1;
  IF v_policy.id IS NULL THEN
    RAISE EXCEPTION 'capital receipt approval policy is not configured'
      USING ERRCODE='check_violation';
  END IF;
  SELECT mapping.id,mapping.version,ledger.id AS ledger_id,ledger.status,ledger.posting_allowed,
         ledger.account_type,ledger.control_account_type,ledger.requires_project,
         ledger.requires_department,ledger.requires_cost_center
    INTO v_mapping
    FROM abos.shareholder_capital_account_mapping_versions mapping
    JOIN abos.ledger_accounts ledger ON ledger.id=mapping.paid_in_capital_ledger_account_id
     AND ledger.legal_entity_id=mapping.legal_entity_id
   WHERE mapping.legal_entity_id=v_entity ORDER BY mapping.version DESC LIMIT 1;
  IF v_mapping.id IS NULL OR v_mapping.status<>'ACTIVE' OR NOT v_mapping.posting_allowed
     OR v_mapping.account_type<>'EQUITY' OR v_mapping.control_account_type<>'SHAREHOLDER_CAPITAL'
     OR v_mapping.requires_project OR v_mapping.requires_department OR v_mapping.requires_cost_center THEN
    RAISE EXCEPTION 'paid-in-capital mapping is missing or no longer valid'
      USING ERRCODE='check_violation';
  END IF;
  SELECT id INTO v_period FROM abos.accounting_periods
   WHERE legal_entity_id=v_entity AND status='OPEN'
     AND v_effective BETWEEN starts_on AND ends_on ORDER BY starts_on DESC LIMIT 1;
  IF v_period IS NULL THEN RAISE EXCEPTION 'no open accounting period covers the capital receipt date'
    USING ERRCODE='check_violation'; END IF;
  v_fingerprint:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    (p_payload-'correlationId')::text||':'||p_receipt_id::text||':'||v_actor::text, 'UTF8')),'hex');
  v_scope:='shareholder-capital:prepare:'||v_entity::text||':'||v_actor::text;
  v_idem:=abos.shareholder_capital_idempotency_begin(v_scope,v_key,v_fingerprint,v_correlation);
  IF (v_idem->>'replayed')::boolean THEN RETURN v_idem->'snapshot'; END IF;
  SELECT id,status,operational_version,created_by_user_account_id INTO v_existing
    FROM abos.posting_intents WHERE legal_entity_id=v_entity AND shareholder_capital_receipt_id=v_receipt.id;
  IF FOUND THEN
    RAISE EXCEPTION 'this capital receipt already has a posting intent'
      USING ERRCODE='unique_violation';
  END IF;
  v_intent:=pg_catalog.gen_random_uuid();
  INSERT INTO abos.posting_intents
    (id,legal_entity_id,source_type,source_id,intent_kind,original_amount,
     original_currency_code,base_amount,base_currency_code,accounting_effective_date,
     correlation_id,idempotency_key,status,created_by_user_account_id,processing_model,
     shareholder_capital_receipt_id,finance_workflow_policy_version_id,
     shareholder_capital_account_mapping_version_id,operational_version)
  VALUES (v_intent,v_entity,'SHAREHOLDER_CAPITAL_CONTRIBUTION_RECEIPT',v_receipt.id,
    'SHAREHOLDER_CAPITAL_RECEIPT',v_receipt.original_amount,v_receipt.original_currency_code,
    v_receipt.original_amount,v_receipt.original_currency_code,v_effective,v_correlation,v_key,
    CASE WHEN v_policy.approval_required THEN 'PENDING_APPROVAL' ELSE 'VALIDATED' END,v_actor,'OPERATIONAL_V1',v_receipt.id,v_policy.id,v_mapping.id,1);
  v_result:=pg_catalog.jsonb_build_object('receiptId',v_receipt.id,'postingIntentId',v_intent,
    'status',CASE WHEN v_policy.approval_required THEN 'PENDING_APPROVAL' ELSE 'VALIDATED' END,
    'approvalRequired',v_policy.approval_required,'policyVersion',v_policy.version,'version',1,'journalId',NULL,'replayed',false);
  PERFORM abos.shareholder_capital_audit(v_actor,v_entity,v_correlation,
    'SHAREHOLDER_CAPITAL_POSTING_PREPARED','POSTING_INTENT',v_intent,v_result);
  PERFORM abos.shareholder_capital_idempotency_complete(v_scope,v_key,'POSTING_INTENT',v_intent,v_result);
  RETURN v_result;
END
$prepare$;

CREATE OR REPLACE FUNCTION abos.decide_shareholder_capital_posting(
  p_identity_proof text,p_runtime_token_sha256 text,p_token_sha256 text,
  p_posting_intent_id uuid,p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $decide$
DECLARE
  v_context jsonb; v_actor uuid; v_entity uuid; v_intent abos.posting_intents%ROWTYPE;
  v_expected integer; v_decision text; v_evidence uuid; v_reason text; v_key text; v_correlation uuid;
  v_fingerprint text; v_scope text; v_idem jsonb; v_approval uuid; v_result jsonb;
BEGIN
  v_context:=abos.operational_finance_actor(p_identity_proof,p_runtime_token_sha256,
    p_token_sha256,'finance.capital-receipt.approve');
  v_actor:=(v_context->>'userAccountId')::uuid; v_entity:=(v_context->>'legalEntityId')::uuid;
  IF EXISTS (SELECT 1 FROM pg_catalog.jsonb_object_keys(p_payload) key
              WHERE key NOT IN ('expectedIntentVersion','decision','evidenceReferenceId','decisionReason','idempotencyKey','correlationId')) THEN
    RAISE EXCEPTION 'capital approval request contains unsupported fields' USING ERRCODE='invalid_parameter_value';
  END IF;
  BEGIN
    v_expected:=(p_payload->>'expectedIntentVersion')::integer; v_decision:=p_payload->>'decision';
    v_evidence:=(p_payload->>'evidenceReferenceId')::uuid; v_reason:=btrim(p_payload->>'decisionReason');
    v_key:=btrim(p_payload->>'idempotencyKey'); v_correlation:=(p_payload->>'correlationId')::uuid;
  EXCEPTION WHEN others THEN RAISE EXCEPTION 'a complete capital approval decision is required'
    USING ERRCODE='invalid_parameter_value'; END;
  SELECT * INTO v_intent FROM abos.posting_intents
   WHERE id=p_posting_intent_id AND legal_entity_id=v_entity FOR UPDATE;
  IF NOT FOUND OR v_intent.processing_model<>'OPERATIONAL_V1'
     OR v_intent.source_type<>'SHAREHOLDER_CAPITAL_CONTRIBUTION_RECEIPT' THEN
    RAISE EXCEPTION 'capital posting intent is not available in this legal entity'
      USING ERRCODE='no_data_found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM abos.finance_workflow_policy_versions p
    WHERE p.id=v_intent.finance_workflow_policy_version_id AND p.legal_entity_id=v_entity
      AND p.workflow_type='SHAREHOLDER_CAPITAL_RECEIPT' AND p.approval_required) THEN
    RAISE EXCEPTION 'this capital posting has no separate approval requirement' USING ERRCODE='check_violation';
  END IF;
  v_fingerprint:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    (p_payload-'correlationId')::text||':'||p_posting_intent_id::text||':'||v_actor::text, 'UTF8')),'hex');
  v_scope:='shareholder-capital:decide:'||v_entity::text||':'||v_actor::text;
  v_idem:=abos.shareholder_capital_idempotency_begin(v_scope,v_key,v_fingerprint,v_correlation);
  IF (v_idem->>'replayed')::boolean THEN RETURN v_idem->'snapshot'; END IF;
  IF v_intent.operational_version<>v_expected THEN RAISE EXCEPTION 'capital posting changed; reload and try again'
    USING ERRCODE='serialization_failure'; END IF;
  IF v_intent.status<>'PENDING_APPROVAL' THEN RAISE EXCEPTION 'capital posting is not waiting for approval'
    USING ERRCODE='check_violation'; END IF;
  IF v_decision NOT IN ('APPROVED','REJECTED') OR length(v_reason) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'a terminal decision and reason are required' USING ERRCODE='invalid_parameter_value';
  END IF;
  v_approval:=pg_catalog.gen_random_uuid();
  INSERT INTO abos.posting_approvals
    (id,legal_entity_id,posting_intent_id,decision,decision_reason,
     approver_user_account_id,evidence_reference_id,approved_at,shareholder_capital_receipt_id)
  VALUES (v_approval,v_entity,v_intent.id,v_decision,v_reason,v_actor,v_evidence,
          pg_catalog.clock_timestamp(),v_intent.shareholder_capital_receipt_id);
  UPDATE abos.posting_intents SET status=v_decision,operational_version=operational_version+1
   WHERE id=v_intent.id;
  v_result:=pg_catalog.jsonb_build_object('receiptId',v_intent.shareholder_capital_receipt_id,
    'postingIntentId',v_intent.id,'status',v_decision,'version',v_expected+1,
    'journalId',NULL,'replayed',false);
  PERFORM abos.shareholder_capital_audit(v_actor,v_entity,v_correlation,
    CASE v_decision WHEN 'APPROVED' THEN 'SHAREHOLDER_CAPITAL_POSTING_APPROVED'
      ELSE 'SHAREHOLDER_CAPITAL_POSTING_REJECTED' END,'POSTING_INTENT',v_intent.id,v_result);
  PERFORM abos.shareholder_capital_idempotency_complete(v_scope,v_key,'POSTING_APPROVAL',v_approval,v_result);
  RETURN v_result;
END
$decide$;

CREATE OR REPLACE FUNCTION abos.post_shareholder_capital_receipt(
  p_identity_proof text,p_runtime_token_sha256 text,p_token_sha256 text,
  p_posting_intent_id uuid,p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $post$
DECLARE
  v_context jsonb; v_actor uuid; v_entity uuid; v_intent abos.posting_intents%ROWTYPE;
  v_receipt abos.shareholder_capital_receipts%ROWTYPE; v_source abos.shareholder_contributions%ROWTYPE;
  v_custody record; v_approval record; v_policy record; v_mapping record; v_treasury record;
  v_party uuid; v_period uuid; v_expected integer; v_key text; v_correlation uuid;
  v_fingerprint text; v_scope text; v_idem jsonb; v_journal uuid; v_debit uuid; v_credit uuid;
  v_result jsonb; v_entity_base text; v_currency_policy text;
BEGIN
  v_context:=abos.operational_finance_actor(p_identity_proof,p_runtime_token_sha256,
    p_token_sha256,'finance.capital-receipt.post');
  v_actor:=(v_context->>'userAccountId')::uuid; v_entity:=(v_context->>'legalEntityId')::uuid;
  IF EXISTS (SELECT 1 FROM pg_catalog.jsonb_object_keys(p_payload) key
              WHERE key NOT IN ('expectedIntentVersion','idempotencyKey','correlationId')) THEN
    RAISE EXCEPTION 'capital posting request contains unsupported fields' USING ERRCODE='invalid_parameter_value';
  END IF;
  BEGIN
    v_expected:=(p_payload->>'expectedIntentVersion')::integer;
    v_key:=btrim(p_payload->>'idempotencyKey'); v_correlation:=(p_payload->>'correlationId')::uuid;
  EXCEPTION WHEN others THEN RAISE EXCEPTION 'a complete capital posting request is required'
    USING ERRCODE='invalid_parameter_value'; END;
  SELECT * INTO v_intent FROM abos.posting_intents
   WHERE id=p_posting_intent_id AND legal_entity_id=v_entity FOR UPDATE;
  IF NOT FOUND OR v_intent.processing_model<>'OPERATIONAL_V1'
     OR v_intent.source_type<>'SHAREHOLDER_CAPITAL_CONTRIBUTION_RECEIPT'
     OR v_intent.intent_kind<>'SHAREHOLDER_CAPITAL_RECEIPT' THEN
    RAISE EXCEPTION 'capital posting intent is not available in this legal entity'
      USING ERRCODE='no_data_found';
  END IF;
  SELECT * INTO v_receipt FROM abos.shareholder_capital_receipts
   WHERE id=v_intent.shareholder_capital_receipt_id AND legal_entity_id=v_entity;
  SELECT * INTO v_source FROM abos.shareholder_contributions
   WHERE id=v_receipt.contribution_id AND legal_entity_id=v_entity;
  SELECT decision,verified_amount,verified_currency_code,operational_treasury_account_id,
         verified_by_user_account_id INTO v_custody
    FROM abos.shareholder_capital_receipt_custody_verifications
   WHERE shareholder_capital_receipt_id=v_receipt.id AND legal_entity_id=v_entity;
  SELECT decision,approver_user_account_id,evidence_reference_id INTO v_approval
    FROM abos.posting_approvals
   WHERE posting_intent_id=v_intent.id AND legal_entity_id=v_entity
     AND shareholder_capital_receipt_id=v_receipt.id;
  SELECT * INTO v_policy FROM abos.finance_workflow_policy_versions
   WHERE id=v_intent.finance_workflow_policy_version_id AND legal_entity_id=v_entity
     AND workflow_type='SHAREHOLDER_CAPITAL_RECEIPT';
  IF v_policy.id IS NULL THEN
    RAISE EXCEPTION 'bound capital approval policy is unavailable' USING ERRCODE='check_violation';
  END IF;
  IF v_policy.approval_required THEN
    IF v_approval.decision IS DISTINCT FROM 'APPROVED'
       OR v_approval.approver_user_account_id IS DISTINCT FROM v_actor
       OR v_actor IN (v_intent.created_by_user_account_id,v_receipt.recorded_by_user_account_id,v_custody.verified_by_user_account_id) THEN
      RAISE EXCEPTION 'capital approval requires its independent original approver as poster' USING ERRCODE='insufficient_privilege';
    END IF;
  ELSE
    PERFORM abos.operational_finance_actor(p_identity_proof,p_runtime_token_sha256,p_token_sha256,'finance.capital-receipt.prepare');
    IF v_actor IS DISTINCT FROM v_intent.created_by_user_account_id
       OR EXISTS (SELECT 1 FROM abos.posting_approvals WHERE posting_intent_id=v_intent.id AND legal_entity_id=v_entity) THEN
      RAISE EXCEPTION 'capital without approval requires its preparer as poster and no approval decisions' USING ERRCODE='insufficient_privilege';
    END IF;
  END IF;
  v_fingerprint:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    (p_payload-'correlationId')::text||':'||p_posting_intent_id::text||':'||v_actor::text, 'UTF8')),'hex');
  v_scope:='shareholder-capital:post:'||v_entity::text||':'||v_actor::text;
  v_idem:=abos.shareholder_capital_idempotency_begin(v_scope,v_key,v_fingerprint,v_correlation);
  IF (v_idem->>'replayed')::boolean THEN RETURN v_idem->'snapshot'; END IF;

  IF v_intent.operational_version<>v_expected THEN RAISE EXCEPTION 'capital posting changed; reload and try again'
    USING ERRCODE='serialization_failure'; END IF;
  IF (v_policy.approval_required AND (v_intent.status<>'APPROVED' OR v_intent.operational_version<>2))
     OR (NOT v_policy.approval_required AND (v_intent.status<>'VALIDATED' OR v_intent.operational_version<>1)) THEN
    RAISE EXCEPTION 'capital posting is not ready under its bound approval policy' USING ERRCODE='check_violation';
  END IF;
  SELECT mapping.id,mapping.paid_in_capital_ledger_account_id,mapping.version,
         ledger.status,ledger.posting_allowed,ledger.account_type,ledger.control_account_type,
         ledger.requires_project,ledger.requires_department,ledger.requires_cost_center
    INTO v_mapping
    FROM abos.shareholder_capital_account_mapping_versions mapping
    JOIN abos.ledger_accounts ledger ON ledger.id=mapping.paid_in_capital_ledger_account_id
     AND ledger.legal_entity_id=mapping.legal_entity_id
   WHERE mapping.id=v_intent.shareholder_capital_account_mapping_version_id
     AND mapping.legal_entity_id=v_entity;
  SELECT account.id,account.ledger_account_id,account.currency_code,account.status,
         ledger.status AS ledger_status,ledger.posting_allowed,ledger.account_type,
         ledger.control_account_type,ledger.requires_project,ledger.requires_department,
         ledger.requires_cost_center
    INTO v_treasury
    FROM abos.operational_treasury_accounts account
    JOIN abos.ledger_accounts ledger ON ledger.id=account.ledger_account_id
     AND ledger.legal_entity_id=account.legal_entity_id
   WHERE account.id=v_receipt.operational_treasury_account_id AND account.legal_entity_id=v_entity;
  SELECT profile.business_party_id INTO v_party
    FROM abos.shareholder_profiles profile
   WHERE profile.id=v_source.shareholder_profile_id AND profile.legal_entity_id=v_entity;
  SELECT base_currency_code,currency_policy_status INTO v_entity_base,v_currency_policy
    FROM abos.legal_entities WHERE id=v_entity;
  SELECT id INTO v_period FROM abos.accounting_periods
   WHERE legal_entity_id=v_entity AND status='OPEN'
     AND v_receipt.receipt_date BETWEEN starts_on AND ends_on ORDER BY starts_on DESC LIMIT 1;
  IF v_source.id IS NULL OR v_source.contribution_type<>'CASH' OR v_source.record_status<>'DECLARED'
     OR v_source.version<>v_receipt.contribution_version
     OR v_source.amount<v_receipt.original_amount OR v_source.currency_code<>v_receipt.original_currency_code
     OR v_custody.decision IS DISTINCT FROM 'VERIFIED'
     OR v_custody.verified_amount IS DISTINCT FROM v_receipt.original_amount
     OR v_custody.verified_currency_code IS DISTINCT FROM v_receipt.original_currency_code
     OR v_custody.operational_treasury_account_id IS DISTINCT FROM v_receipt.operational_treasury_account_id
     OR v_mapping.id IS NULL OR v_mapping.status<>'ACTIVE' OR NOT v_mapping.posting_allowed
     OR v_mapping.account_type<>'EQUITY' OR v_mapping.control_account_type<>'SHAREHOLDER_CAPITAL'
     OR v_mapping.requires_project OR v_mapping.requires_department OR v_mapping.requires_cost_center
     OR v_treasury.id IS NULL OR v_treasury.status<>'ACTIVE' OR v_treasury.ledger_status<>'ACTIVE'
     OR NOT v_treasury.posting_allowed OR v_treasury.account_type<>'ASSET'
     OR v_treasury.control_account_type<>'CASH' OR v_treasury.requires_project
     OR v_treasury.requires_department OR v_treasury.requires_cost_center
     OR v_treasury.currency_code<>v_receipt.original_currency_code
     OR v_entity_base<>v_receipt.original_currency_code OR v_currency_policy<>'APPROVED'
     OR v_period IS NULL OR v_party IS NULL THEN
    RAISE EXCEPTION 'capital posting facts, approval, mapping, Treasury, period or currency are no longer valid'
      USING ERRCODE='check_violation';
  END IF;
  IF v_intent.original_amount<>v_receipt.original_amount
     OR v_intent.original_currency_code<>v_receipt.original_currency_code
     OR v_intent.base_amount<>v_receipt.original_amount
     OR v_intent.base_currency_code<>v_receipt.original_currency_code
     OR v_intent.accounting_effective_date<>v_receipt.receipt_date THEN
    RAISE EXCEPTION 'capital intent no longer matches its exact receipt' USING ERRCODE='check_violation';
  END IF;
  v_journal:=pg_catalog.gen_random_uuid(); v_debit:=pg_catalog.gen_random_uuid(); v_credit:=pg_catalog.gen_random_uuid();
  INSERT INTO abos.journals
    (id,legal_entity_id,accounting_period_id,posting_intent_id,journal_reference,
     accounting_effective_date,base_currency_code,status,created_by_user_account_id,processing_model)
  VALUES (v_journal,v_entity,v_period,v_intent.id,'CAP-'||replace(v_receipt.id::text,'-',''),
    v_receipt.receipt_date,v_entity_base,'DRAFT',v_actor,'OPERATIONAL_V1');
  INSERT INTO abos.journal_lines
    (id,journal_id,legal_entity_id,line_number,ledger_account_id,business_party_id,
     original_amount,original_currency_code,base_debit,base_credit,base_currency_code,
     conversion_snapshot_reference,source_type,source_id,processing_model)
  VALUES
    (v_debit,v_journal,v_entity,1,v_treasury.ledger_account_id,NULL,
     v_receipt.original_amount,v_receipt.original_currency_code,v_receipt.original_amount,0,
     v_entity_base,NULL,'SHAREHOLDER_CAPITAL_CONTRIBUTION_RECEIPT',v_receipt.id,'OPERATIONAL_V1'),
    (v_credit,v_journal,v_entity,2,v_mapping.paid_in_capital_ledger_account_id,v_party,
     v_receipt.original_amount,v_receipt.original_currency_code,0,v_receipt.original_amount,
     v_entity_base,NULL,'SHAREHOLDER_CAPITAL_CONTRIBUTION_RECEIPT',v_receipt.id,'OPERATIONAL_V1');
  INSERT INTO abos.subledger_entries
    (id,legal_entity_id,journal_line_id,subledger_type,business_party_id,
     operational_treasury_account_id,original_amount,original_currency_code,
     base_amount,base_currency_code,source_type,source_id,processing_model,
     shareholder_capital_receipt_id)
  VALUES
    (pg_catalog.gen_random_uuid(),v_entity,v_debit,'OPERATIONAL_TREASURY',NULL,
     v_receipt.operational_treasury_account_id,v_receipt.original_amount,
     v_receipt.original_currency_code,v_receipt.original_amount,v_entity_base,
     'SHAREHOLDER_CAPITAL_CONTRIBUTION_RECEIPT',v_receipt.id,'OPERATIONAL_V1',v_receipt.id),
    (pg_catalog.gen_random_uuid(),v_entity,v_credit,'SHAREHOLDER_CAPITAL',v_party,NULL,
     -v_receipt.original_amount,v_receipt.original_currency_code,-v_receipt.original_amount,
     v_entity_base,'SHAREHOLDER_CAPITAL_CONTRIBUTION_RECEIPT',v_receipt.id,'OPERATIONAL_V1',v_receipt.id);
  UPDATE abos.posting_intents SET status='POSTED',operational_version=operational_version+1
   WHERE id=v_intent.id;
  UPDATE abos.journals SET status='POSTED',posted_by_user_account_id=v_actor,
    posted_at=pg_catalog.clock_timestamp() WHERE id=v_journal;
  v_result:=pg_catalog.jsonb_build_object('receiptId',v_receipt.id,'postingIntentId',v_intent.id,
    'status','POSTED','version',v_expected+1,'journalId',v_journal,'replayed',false);
  PERFORM abos.shareholder_capital_audit(v_actor,v_entity,v_correlation,
    'SHAREHOLDER_CAPITAL_RECEIPT_POSTED','POSTING_INTENT',v_intent.id,v_result);
  PERFORM abos.shareholder_capital_idempotency_complete(v_scope,v_key,'JOURNAL',v_journal,v_result);
  RETURN v_result;
END
$post$;

CREATE OR REPLACE FUNCTION abos.validate_operational_capital_journal_posting()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $validate$
DECLARE
  v_intent abos.posting_intents%ROWTYPE; v_receipt abos.shareholder_capital_receipts%ROWTYPE;
  v_mapping abos.shareholder_capital_account_mapping_versions%ROWTYPE;
  v_treasury abos.operational_treasury_accounts%ROWTYPE; v_party uuid;
  v_policy abos.finance_workflow_policy_versions%ROWTYPE; v_custody record; v_approval_count bigint;
  v_line_count bigint; v_debit numeric; v_credit numeric; v_subledger_count bigint;
BEGIN
  IF NEW.status<>'POSTED' THEN RETURN NEW; END IF;
  SELECT * INTO v_intent FROM abos.posting_intents
   WHERE id=NEW.posting_intent_id AND legal_entity_id=NEW.legal_entity_id;
  IF v_intent.processing_model<>'OPERATIONAL_V1'
     OR v_intent.source_type<>'SHAREHOLDER_CAPITAL_CONTRIBUTION_RECEIPT' THEN RETURN NEW; END IF;
  SELECT * INTO v_receipt FROM abos.shareholder_capital_receipts
   WHERE id=v_intent.shareholder_capital_receipt_id AND legal_entity_id=NEW.legal_entity_id;
  SELECT * INTO v_mapping FROM abos.shareholder_capital_account_mapping_versions
   WHERE id=v_intent.shareholder_capital_account_mapping_version_id AND legal_entity_id=NEW.legal_entity_id;
  SELECT * INTO v_treasury FROM abos.operational_treasury_accounts
   WHERE id=v_receipt.operational_treasury_account_id AND legal_entity_id=NEW.legal_entity_id;
  SELECT profile.business_party_id INTO v_party
    FROM abos.shareholder_contributions contribution
    JOIN abos.shareholder_profiles profile ON profile.id=contribution.shareholder_profile_id
     AND profile.legal_entity_id=contribution.legal_entity_id
   WHERE contribution.id=v_receipt.contribution_id AND contribution.legal_entity_id=NEW.legal_entity_id;
  SELECT count(*),COALESCE(sum(base_debit),0),COALESCE(sum(base_credit),0)
    INTO v_line_count,v_debit,v_credit FROM abos.journal_lines WHERE journal_id=NEW.id;
  SELECT * INTO v_policy FROM abos.finance_workflow_policy_versions
    WHERE id=v_intent.finance_workflow_policy_version_id AND legal_entity_id=NEW.legal_entity_id
      AND workflow_type='SHAREHOLDER_CAPITAL_RECEIPT';
  SELECT verified_by_user_account_id INTO v_custody FROM abos.shareholder_capital_receipt_custody_verifications
    WHERE shareholder_capital_receipt_id=v_receipt.id AND legal_entity_id=NEW.legal_entity_id;
  SELECT count(*) INTO v_approval_count FROM abos.posting_approvals
    WHERE posting_intent_id=v_intent.id AND legal_entity_id=NEW.legal_entity_id;
  IF v_policy.id IS NULL OR NEW.posted_by_user_account_id IS NULL
     OR (v_policy.approval_required AND
       (v_intent.operational_version<>3 OR v_approval_count<>1
        OR NOT EXISTS (SELECT 1 FROM abos.posting_approvals a WHERE a.posting_intent_id=v_intent.id
          AND a.legal_entity_id=NEW.legal_entity_id AND a.shareholder_capital_receipt_id=v_receipt.id
          AND a.decision='APPROVED' AND a.approver_user_account_id=NEW.posted_by_user_account_id)
        OR NEW.posted_by_user_account_id IN (v_intent.created_by_user_account_id,v_receipt.recorded_by_user_account_id,v_custody.verified_by_user_account_id)))
     OR (NOT v_policy.approval_required AND
       (v_intent.operational_version<>2 OR v_approval_count<>0
        OR NEW.posted_by_user_account_id IS DISTINCT FROM v_intent.created_by_user_account_id)) THEN
    RAISE EXCEPTION 'capital journal must match its bound approval policy and exact poster' USING ERRCODE='check_violation';
  END IF;
  IF v_intent.status<>'POSTED'
     OR v_line_count<>2 OR v_debit<>v_credit OR v_debit<>v_receipt.original_amount
     OR NEW.accounting_effective_date<>v_receipt.receipt_date
     OR NEW.base_currency_code<>v_receipt.original_currency_code THEN
    RAISE EXCEPTION 'capital journal must be a posted exact two-line receipt journal'
      USING ERRCODE='check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM abos.journal_lines line WHERE line.journal_id=NEW.id
      AND line.line_number=1 AND line.ledger_account_id=v_treasury.ledger_account_id
      AND line.base_debit=v_receipt.original_amount AND line.base_credit=0
      AND line.business_party_id IS NULL AND line.source_type='SHAREHOLDER_CAPITAL_CONTRIBUTION_RECEIPT'
      AND line.source_id=v_receipt.id AND line.processing_model='OPERATIONAL_V1')
     OR NOT EXISTS (SELECT 1 FROM abos.journal_lines line WHERE line.journal_id=NEW.id
      AND line.line_number=2 AND line.ledger_account_id=v_mapping.paid_in_capital_ledger_account_id
      AND line.base_debit=0 AND line.base_credit=v_receipt.original_amount
      AND line.business_party_id=v_party AND line.source_type='SHAREHOLDER_CAPITAL_CONTRIBUTION_RECEIPT'
      AND line.source_id=v_receipt.id AND line.processing_model='OPERATIONAL_V1') THEN
    RAISE EXCEPTION 'capital journal must debit Treasury and credit mapped shareholder capital'
      USING ERRCODE='check_violation';
  END IF;
  SELECT count(*) INTO v_subledger_count FROM abos.subledger_entries entry
   JOIN abos.journal_lines line ON line.id=entry.journal_line_id
   WHERE line.journal_id=NEW.id AND entry.shareholder_capital_receipt_id=v_receipt.id
     AND entry.processing_model='OPERATIONAL_V1';
  IF v_subledger_count<>2 OR EXISTS (
    SELECT 1 FROM abos.subledger_entries entry
    JOIN abos.journal_lines line ON line.id=entry.journal_line_id
    WHERE line.journal_id=NEW.id AND NOT (
      (line.line_number=1 AND entry.subledger_type='OPERATIONAL_TREASURY'
       AND entry.operational_treasury_account_id=v_treasury.id AND entry.business_party_id IS NULL
       AND entry.original_amount=v_receipt.original_amount AND entry.base_amount=v_receipt.original_amount)
      OR
      (line.line_number=2 AND entry.subledger_type='SHAREHOLDER_CAPITAL'
       AND entry.operational_treasury_account_id IS NULL AND entry.business_party_id=v_party
       AND entry.original_amount=-v_receipt.original_amount AND entry.base_amount=-v_receipt.original_amount)
    )) THEN
    RAISE EXCEPTION 'capital journal requires exactly two typed receipt subledger effects'
      USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END
$validate$;

CREATE OR REPLACE FUNCTION abos.guard_posting_approval_processing_model()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $guard$
DECLARE v_model text; v_receipt uuid; v_policy_id uuid;
BEGIN
  SELECT processing_model, shareholder_capital_receipt_id, finance_workflow_policy_version_id
    INTO v_model, v_receipt, v_policy_id
    FROM abos.posting_intents
   WHERE id = NEW.posting_intent_id AND legal_entity_id = NEW.legal_entity_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'posting intent not found in approval legal entity'; END IF;
  IF v_model = 'LEGACY_E1' THEN
    PERFORM abos.assert_sandbox_mutation_authorized(NEW.legal_entity_id);
  ELSIF v_model = 'OPERATIONAL_V1' THEN
    IF current_user <> 'abos_v1_operational_finance_owner'
       OR v_receipt IS NULL
       OR NEW.shareholder_capital_receipt_id IS DISTINCT FROM v_receipt
       OR NOT EXISTS (SELECT 1 FROM abos.finance_workflow_policy_versions p
         WHERE p.id=v_policy_id AND p.legal_entity_id=NEW.legal_entity_id
           AND p.workflow_type='SHAREHOLDER_CAPITAL_RECEIPT' AND p.approval_required) THEN
      RAISE EXCEPTION 'operational capital approval is restricted to its typed Finance entry point'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSE
    RAISE EXCEPTION 'unsupported posting approval processing model';
  END IF;
  RETURN NEW;
END
$guard$;

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
    'approvalRequired',(SELECT approval_required FROM abos.finance_workflow_policy_versions
      WHERE id=intent.finance_workflow_policy_version_id AND legal_entity_id=receipt.legal_entity_id),
    'approvalState', CASE
      WHEN EXISTS (SELECT 1 FROM abos.finance_workflow_policy_versions WHERE id=intent.finance_workflow_policy_version_id
        AND legal_entity_id=receipt.legal_entity_id AND NOT approval_required) THEN 'NOT_REQUIRED'
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
    'preparerUserAccountId',intent.created_by_user_account_id,
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

CREATE OR REPLACE FUNCTION abos.register_shareholder_capital_evidence(
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
  IF v_kind='FINANCE_APPROVAL' AND NOT EXISTS (
    SELECT 1 FROM abos.posting_intents i JOIN abos.finance_workflow_policy_versions p
      ON p.id=i.finance_workflow_policy_version_id AND p.legal_entity_id=i.legal_entity_id
    WHERE i.id=v_subject AND i.legal_entity_id=v_entity AND i.status='PENDING_APPROVAL'
      AND p.workflow_type='SHAREHOLDER_CAPITAL_RECEIPT' AND p.approval_required) THEN
    RAISE EXCEPTION 'capital approval evidence requires a pending approval-required intent' USING ERRCODE='check_violation';
  END IF;
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

-- Existing owners/execution ACLs are retained by CREATE OR REPLACE. New reads are column-limited.
GRANT SELECT(finance_workflow_policy_version_id,status) ON abos.posting_intents TO abos_v1_capital_evidence_owner;
GRANT SELECT(id,legal_entity_id,workflow_type,approval_required) ON abos.finance_workflow_policy_versions TO abos_v1_capital_evidence_owner;
GRANT SELECT(approval_required,legal_entity_id) ON abos.finance_workflow_policy_versions TO abos_v1_shareholder_capital_owner;
