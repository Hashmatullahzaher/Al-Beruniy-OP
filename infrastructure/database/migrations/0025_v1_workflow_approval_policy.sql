-- V1 operational finance: legal-entity workflow approval policy.
--
-- This is configuration, not a financial posting path. It deliberately does not alter the E1
-- synthetic-only gate or any existing Treasury/Finance posting function. The policy is append-only,
-- resolved from the caller's live database session, and administered independently from Finance.

INSERT INTO abos.permission_catalogue
  (permission_code, catalogue_version, category, availability,
   independence_enforced, administrative, sort_order)
VALUES
  ('admin.finance-workflow.manage', 5, 'ADMINISTRATION', 'ACTIVE', false, true, 400);

CREATE TABLE abos.finance_workflow_types (
  workflow_type text PRIMARY KEY
    CHECK (workflow_type IN (
      'SHAREHOLDER_CAPITAL_RECEIPT', 'CUSTOMER_RECEIPT', 'OTHER_INCOME', 'EXPENSE',
      'SUPPLIER_PAYMENT', 'SALARY_PAYMENT', 'TREASURY_TRANSFER')),
  label_en text NOT NULL CHECK (btrim(label_en) <> ''),
  label_fa text NOT NULL CHECK (btrim(label_fa) <> ''),
  sort_order integer NOT NULL UNIQUE CHECK (sort_order > 0),
  active boolean NOT NULL DEFAULT true
);

INSERT INTO abos.finance_workflow_types
  (workflow_type, label_en, label_fa, sort_order)
VALUES
  ('SHAREHOLDER_CAPITAL_RECEIPT', 'Shareholder capital receipt', 'دریافت سرمایه سهامدار', 10),
  ('CUSTOMER_RECEIPT',            'Customer receipt',           'دریافت مشتری',          20),
  ('OTHER_INCOME',                'Other income',               'سایر عواید',            30),
  ('EXPENSE',                     'Expense',                    'مصرف',                  40),
  ('SUPPLIER_PAYMENT',            'Supplier payment',           'پرداخت تأمین‌کننده',     50),
  ('SALARY_PAYMENT',              'Salary or wage payment',     'پرداخت معاش یا مزد',     60),
  ('TREASURY_TRANSFER',           'Treasury transfer',          'انتقال خزانه',           70);

CREATE TRIGGER finance_workflow_types_no_update_or_delete
BEFORE UPDATE OR DELETE ON abos.finance_workflow_types
FOR EACH ROW EXECUTE FUNCTION abos.prevent_audit_mutation();

CREATE TABLE abos.finance_workflow_policy_versions (
  id uuid PRIMARY KEY,
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  workflow_type text NOT NULL REFERENCES abos.finance_workflow_types(workflow_type),
  version integer NOT NULL CHECK (version > 0),
  approval_required boolean NOT NULL,
  configured_by_user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  configured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  change_reason text NOT NULL CHECK (length(btrim(change_reason)) BETWEEN 5 AND 500),
  UNIQUE (legal_entity_id, workflow_type, version),
  UNIQUE (id, legal_entity_id)
);

CREATE INDEX finance_workflow_policy_current_idx
  ON abos.finance_workflow_policy_versions
  (legal_entity_id, workflow_type, version DESC);

CREATE TRIGGER finance_workflow_policy_versions_no_update_or_delete
BEFORE UPDATE OR DELETE ON abos.finance_workflow_policy_versions
FOR EACH ROW EXECUTE FUNCTION abos.prevent_audit_mutation();

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'abos_v1_workflow_policy_owner') THEN
    CREATE ROLE abos_v1_workflow_policy_owner
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
  ELSE
    ALTER ROLE abos_v1_workflow_policy_owner
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
  END IF;
END
$roles$;

REVOKE abos_v1_workflow_policy_owner FROM abos_v1_identity_runtime;
GRANT USAGE ON SCHEMA abos TO abos_v1_workflow_policy_owner;
GRANT SELECT ON abos.finance_workflow_types, abos.finance_workflow_policy_versions,
  abos.user_accounts TO abos_v1_workflow_policy_owner;
GRANT INSERT (id, legal_entity_id, workflow_type, version, approval_required,
  configured_by_user_account_id, change_reason)
  ON abos.finance_workflow_policy_versions TO abos_v1_workflow_policy_owner;
GRANT INSERT (id, actor_user_account_id, legal_entity_id, correlation_id, action,
  entity_type, entity_id, before_state, after_state, metadata)
  ON abos.audit_records TO abos_v1_workflow_policy_owner;
GRANT EXECUTE ON FUNCTION abos.identity_actor_context(text, text, text)
  TO abos_v1_workflow_policy_owner;

CREATE FUNCTION abos.finance_workflow_policy_actor(
  p_identity_proof text,
  p_runtime_token_sha256 text,
  p_token_sha256 text,
  p_required_permission text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $actor$
DECLARE
  actor_context jsonb;
BEGIN
  actor_context := abos.identity_actor_context(
    p_identity_proof, p_runtime_token_sha256, p_token_sha256);
  IF actor_context IS NULL
     OR COALESCE((actor_context ->> 'live')::boolean, false) IS NOT TRUE
     OR actor_context ->> 'status' IS DISTINCT FROM 'ACTIVE'
     OR COALESCE((actor_context ->> 'mustChangePassword')::boolean, false) IS TRUE THEN
    RAISE EXCEPTION 'sign in with an active account to continue'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_required_permission IS NOT NULL
     AND NOT COALESCE(actor_context -> 'permissions', '[]'::jsonb) ? p_required_permission THEN
    RAISE EXCEPTION 'current authority is missing %', p_required_permission
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN actor_context;
END
$actor$;

CREATE FUNCTION abos.finance_workflow_policy_workspace(
  p_identity_proof text,
  p_runtime_token_sha256 text,
  p_token_sha256 text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $workspace$
DECLARE
  actor_context jsonb;
  entity_id uuid;
  result jsonb;
BEGIN
  actor_context := abos.finance_workflow_policy_actor(
    p_identity_proof, p_runtime_token_sha256, p_token_sha256, NULL);
  entity_id := (actor_context ->> 'legalEntityId')::uuid;

  SELECT pg_catalog.jsonb_build_object(
           'legalEntityId', entity_id,
           'canManage', COALESCE(actor_context -> 'permissions', '[]'::jsonb)
             ? 'admin.finance-workflow.manage',
           'policies', COALESCE(pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'workflowType', workflow.workflow_type,
               'labelEn', workflow.label_en,
               'labelFa', workflow.label_fa,
               'configured', current_policy.id IS NOT NULL,
               'policyVersionId', current_policy.id,
               'version', COALESCE(current_policy.version, 0),
               'approvalRequired', current_policy.approval_required,
               'changeReason', current_policy.change_reason,
               'configuredAt', current_policy.configured_at,
               'configuredBy', configured_by.display_name,
               'history', COALESCE(history.items, '[]'::jsonb))
             ORDER BY workflow.sort_order), '[]'::jsonb))
    INTO result
    FROM abos.finance_workflow_types workflow
    LEFT JOIN LATERAL (
      SELECT policy.*
        FROM abos.finance_workflow_policy_versions policy
       WHERE policy.legal_entity_id = entity_id
         AND policy.workflow_type = workflow.workflow_type
       ORDER BY policy.version DESC
       LIMIT 1
    ) current_policy ON true
    LEFT JOIN abos.user_accounts configured_by
      ON configured_by.id = current_policy.configured_by_user_account_id
    LEFT JOIN LATERAL (
      SELECT pg_catalog.jsonb_agg(
               pg_catalog.jsonb_build_object(
                 'policyVersionId', item.id,
                 'version', item.version,
                 'approvalRequired', item.approval_required,
                 'changeReason', item.change_reason,
                 'configuredAt', item.configured_at,
                 'configuredBy', history_actor.display_name)
               ORDER BY item.version DESC) AS items
        FROM abos.finance_workflow_policy_versions item
        JOIN abos.user_accounts history_actor
          ON history_actor.id = item.configured_by_user_account_id
       WHERE item.legal_entity_id = entity_id
         AND item.workflow_type = workflow.workflow_type
    ) history ON true
   WHERE workflow.active;
  RETURN result;
END
$workspace$;

CREATE FUNCTION abos.finance_workflow_policy_set(
  p_identity_proof text,
  p_runtime_token_sha256 text,
  p_token_sha256 text,
  p_workflow_type text,
  p_approval_required boolean,
  p_expected_version integer,
  p_change_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $set_policy$
DECLARE
  actor_context jsonb;
  actor_id uuid;
  entity_id uuid;
  current_policy record;
  next_policy_id uuid := pg_catalog.gen_random_uuid();
  reason text := pg_catalog.btrim(p_change_reason);
BEGIN
  actor_context := abos.finance_workflow_policy_actor(
    p_identity_proof, p_runtime_token_sha256, p_token_sha256,
    'admin.finance-workflow.manage');
  actor_id := (actor_context ->> 'userAccountId')::uuid;
  entity_id := (actor_context ->> 'legalEntityId')::uuid;

  IF p_approval_required IS NULL OR p_expected_version IS NULL OR p_expected_version < 0
     OR reason IS NULL OR pg_catalog.length(reason) < 5 OR pg_catalog.length(reason) > 500 THEN
    RAISE EXCEPTION 'approval flag, current version and a 5-500 character reason are required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM abos.finance_workflow_types workflow
     WHERE workflow.workflow_type = p_workflow_type AND workflow.active
  ) THEN
    RAISE EXCEPTION 'unknown finance workflow type'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'abos-finance-workflow-policy:' || entity_id::text || ':' || p_workflow_type, 0));
  SELECT policy.id, policy.version, policy.approval_required, policy.change_reason
    INTO current_policy
    FROM abos.finance_workflow_policy_versions policy
   WHERE policy.legal_entity_id = entity_id
     AND policy.workflow_type = p_workflow_type
   ORDER BY policy.version DESC
   LIMIT 1;
  IF COALESCE(current_policy.version, 0) <> p_expected_version THEN
    RAISE EXCEPTION 'finance workflow policy changed; reload and try again'
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO abos.finance_workflow_policy_versions
    (id, legal_entity_id, workflow_type, version, approval_required,
     configured_by_user_account_id, change_reason)
  VALUES
    (next_policy_id, entity_id, p_workflow_type, p_expected_version + 1,
     p_approval_required, actor_id, reason);

  INSERT INTO abos.audit_records
    (id, actor_user_account_id, legal_entity_id, correlation_id, action,
     entity_type, entity_id, before_state, after_state, metadata)
  VALUES
    (pg_catalog.gen_random_uuid(), actor_id, entity_id, pg_catalog.gen_random_uuid(),
     'FINANCE_WORKFLOW_POLICY_CHANGED', 'FINANCE_WORKFLOW_POLICY', next_policy_id,
     CASE WHEN current_policy.id IS NULL THEN NULL ELSE pg_catalog.jsonb_build_object(
       'policyVersionId', current_policy.id,
       'version', current_policy.version,
       'approvalRequired', current_policy.approval_required,
       'changeReason', current_policy.change_reason) END,
     pg_catalog.jsonb_build_object(
       'policyVersionId', next_policy_id,
       'workflowType', p_workflow_type,
       'version', p_expected_version + 1,
       'approvalRequired', p_approval_required,
       'changeReason', reason),
     pg_catalog.jsonb_build_object('source', 'v1-workflow-policy'));

  RETURN abos.finance_workflow_policy_workspace(
    p_identity_proof, p_runtime_token_sha256, p_token_sha256);
END
$set_policy$;

ALTER FUNCTION abos.finance_workflow_policy_actor(text, text, text, text)
  OWNER TO abos_v1_workflow_policy_owner;
ALTER FUNCTION abos.finance_workflow_policy_workspace(text, text, text)
  OWNER TO abos_v1_workflow_policy_owner;
ALTER FUNCTION abos.finance_workflow_policy_set(text, text, text, text, boolean, integer, text)
  OWNER TO abos_v1_workflow_policy_owner;

REVOKE ALL ON FUNCTION abos.finance_workflow_policy_actor(text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION abos.finance_workflow_policy_workspace(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION abos.finance_workflow_policy_set(text, text, text, text, boolean, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION abos.finance_workflow_policy_workspace(text, text, text),
  abos.finance_workflow_policy_set(text, text, text, text, boolean, integer, text)
  TO abos_v1_identity_runtime;

REVOKE ALL ON abos.finance_workflow_types, abos.finance_workflow_policy_versions
  FROM PUBLIC, abos_v1_identity_runtime, abos_e1_runtime, abos_e1_treasury_runtime;
