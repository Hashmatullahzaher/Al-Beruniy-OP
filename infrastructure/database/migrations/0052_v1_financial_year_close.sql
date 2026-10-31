-- 0052: Financial Year Close replaces the monthly close / reopen of 0050 (owner correction of 2026-10-31).
--
-- Al-Beruniy closes a financial year, never a month. Months stay internal: date grouping, reporting, the fiscal
-- calendar and the posting kernel's period reference. Nothing here deletes a row or changes an applied migration.
--
-- 1. Retired from the product (functions kept for history, no longer callable by the runtime): close month, close-month
--    preview, reopen month, reopen request, reopen decision, the months workspace, and the manual "open period" (0027).
--    Permission finance.period.reopen is retired (permission_retirements, 0041 mechanism); the PERIOD_REOPEN approval
--    setting is withdrawn from the approval settings and is never available.
-- 2. The close is stored on the financial year itself: fiscal_years.closed_at / closed_by_user_account_id /
--    close_correlation_id. The year stays append-only except for that one transition (open -> closed); it is never
--    reopened and never deleted. Closing changes no month row and no journal.
-- 3. Posting refusal derives from the year: journals_financial_year_guard refuses any journal (inserted, or moved to a
--    new status or date) whose effective date falls in a closed financial year of its company. It locks that year row
--    FOR SHARE, so it serialises with a concurrent close (which UPDATEs the row): under READ COMMITTED it waits and then
--    sees the close; under REPEATABLE READ / SERIALIZABLE the concurrent update is a serialization failure.
-- 4. Months open themselves in every lane (as the Treasury lanes already did, 0040). The expense lane (record and post)
--    and temporary funding no longer require a month someone opened by hand. A date in a closed financial year is
--    refused before any month is touched.
-- 5. Reversals keep their 0050 rule, read at year level: the original date while the original's financial year is not
--    closed, otherwise the business day (whose year must be open). The reversal workspace reports a closed year.
-- Reopening a closed financial year is not offered. No journal is created and no existing row is changed.

-- ---------------------------------------------------------------------------------------------
-- 1. Retire the monthly operations.
-- ---------------------------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION
  abos.finance_period_close(text, text, text, jsonb), abos.finance_period_close_preview(text, text, text, uuid),
  abos.finance_period_reopen(text, text, text, jsonb), abos.finance_period_reopen_request(text, text, text, jsonb),
  abos.finance_period_reopen_decide(text, text, text, jsonb), abos.finance_periods_workspace(text, text, text),
  abos.finance_open_accounting_period(text, text, text, uuid, integer, text)
  FROM abos_e1_runtime;

INSERT INTO abos.permission_retirements (permission_code, retired_in_migration, reason)
VALUES ('finance.period.reopen', '0052_v1_financial_year_close',
  'Monthly reopen (0050) was a misread requirement: Al-Beruniy closes a financial year, never a month (owner correction of 2026-10-31).');

CREATE OR REPLACE FUNCTION abos.finance_workflow_approval_available(p_workflow_type text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  -- 0052: PERIOD_REOPEN is withdrawn with the monthly reopen; it is never available.
  SELECT p_workflow_type IN ('CHART_OF_ACCOUNTS', 'SHAREHOLDER_CAPITAL_RECEIPT', 'EXPENSE', 'TEMPORARY_FUNDING', 'JOURNAL_REVERSAL')
$function$;

-- ---------------------------------------------------------------------------------------------
-- 2. Year-close state on the financial year.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE abos.fiscal_years
  ADD COLUMN closed_at timestamptz,
  ADD COLUMN closed_by_user_account_id uuid REFERENCES abos.user_accounts(id),
  ADD COLUMN close_correlation_id uuid,
  ADD CONSTRAINT fiscal_years_close_complete CHECK (
    (closed_at IS NULL AND closed_by_user_account_id IS NULL AND close_correlation_id IS NULL)
    OR (closed_at IS NOT NULL AND closed_by_user_account_id IS NOT NULL AND close_correlation_id IS NOT NULL));

-- A financial year is append-only except for its one close; a closed year never changes again.
CREATE FUNCTION abos.guard_fiscal_year_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $guard$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'financial years are append-only; a financial year is never deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.closed_at IS NOT NULL THEN
    RAISE EXCEPTION 'financial years are append-only; a closed financial year is never changed or reopened' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.closed_at IS NULL
     OR (to_jsonb(NEW) - ARRAY['closed_at', 'closed_by_user_account_id', 'close_correlation_id'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['closed_at', 'closed_by_user_account_id', 'close_correlation_id']) THEN
    RAISE EXCEPTION 'financial years are append-only; only closing a financial year may change it' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$guard$;
DROP TRIGGER fiscal_years_no_update_or_delete ON abos.fiscal_years;
CREATE TRIGGER fiscal_years_append_only_except_close
BEFORE UPDATE OR DELETE ON abos.fiscal_years
FOR EACH ROW EXECUTE FUNCTION abos.guard_fiscal_year_mutation();

-- Whether the company's financial year covering a date is closed (no covering year: not closed).
CREATE FUNCTION abos.financial_year_closed_on(p_entity uuid, p_date date)
RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $closed$
  SELECT EXISTS (SELECT 1 FROM abos.fiscal_years y
                  WHERE y.legal_entity_id = p_entity AND p_date BETWEEN y.starts_on AND y.ends_on AND y.closed_at IS NOT NULL)
$closed$;

-- The posting guard: nothing is posted into a closed financial year, whichever lane or month it comes through.
CREATE FUNCTION abos.journal_financial_year_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $guard$
DECLARE y record;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status
     AND NEW.accounting_effective_date IS NOT DISTINCT FROM OLD.accounting_effective_date
     AND NEW.legal_entity_id IS NOT DISTINCT FROM OLD.legal_entity_id THEN
    RETURN NEW;
  END IF;
  -- FOR SHARE waits for a concurrent close of the year and then reads its committed state.
  FOR y IN SELECT closed_at FROM abos.fiscal_years
            WHERE legal_entity_id = NEW.legal_entity_id AND NEW.accounting_effective_date BETWEEN starts_on AND ends_on
            FOR SHARE LOOP
    IF y.closed_at IS NOT NULL THEN
      RAISE EXCEPTION 'the financial year covering % is closed; nothing can be posted into it', NEW.accounting_effective_date
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER journals_financial_year_guard
BEFORE INSERT OR UPDATE ON abos.journals
FOR EACH ROW EXECUTE FUNCTION abos.journal_financial_year_guard();

-- ---------------------------------------------------------------------------------------------
-- 3. Months open themselves; a closed financial year refuses first.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION abos.open_period_for_business_date(p_entity uuid, p_actor uuid, p_date date)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE period abos.accounting_periods%ROWTYPE; before_state jsonb;
BEGIN
 -- 0052: the financial year decides; a closed year refuses whatever state its month row is in.
 IF abos.financial_year_closed_on(p_entity, p_date) THEN
  RAISE EXCEPTION 'the financial year covering % is closed; nothing can be posted into it',p_date USING ERRCODE='check_violation';
 END IF;
 SELECT * INTO period FROM abos.accounting_periods
  WHERE legal_entity_id=p_entity AND p_date BETWEEN starts_on AND ends_on
  ORDER BY starts_on DESC LIMIT 1;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'no accounting period covers %; generate the financial year first',p_date USING ERRCODE='check_violation';
 END IF;
 IF period.status='OPEN' THEN RETURN period.id; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('abos-periods:'||p_entity::text,0));
 SELECT * INTO period FROM abos.accounting_periods WHERE id=period.id AND legal_entity_id=p_entity;
 IF period.status='OPEN' THEN RETURN period.id; END IF;
 IF period.status<>'PENDING' OR period.fiscal_year_id IS NULL THEN
  -- Only a month closed by the retired 0050 monthly close (none in production) or one outside the calendar.
  RAISE EXCEPTION 'the accounting period covering % is %; it cannot be reopened automatically',p_date,period.status
   USING ERRCODE='check_violation';
 END IF;
 before_state:=to_jsonb(period);
 UPDATE abos.accounting_periods SET status='OPEN',opened_by_user_account_id=p_actor,
  opened_at=clock_timestamp(),operational_version=operational_version+1
 WHERE id=period.id AND legal_entity_id=p_entity AND status='PENDING';
 INSERT INTO abos.audit_records(id,actor_user_account_id,legal_entity_id,correlation_id,action,
  entity_type,entity_id,before_state,after_state,metadata)
 VALUES(gen_random_uuid(),p_actor,p_entity,gen_random_uuid(),'ACCOUNTING_PERIOD_OPENED','ACCOUNTING_PERIOD',
  period.id,before_state,(SELECT to_jsonb(p) FROM abos.accounting_periods p WHERE p.id=period.id),
  jsonb_build_object('source','v1-auto-open','reason','opened automatically to record a dated transaction'));
 RETURN period.id;
END $function$;

-- Temporary funding opens the month like every other lane (it may run without a resolved actor; the month's opener is
-- then recorded as unknown, and the posting itself keeps its actor).
CREATE OR REPLACE FUNCTION abos.temporary_funding_open_period(p_entity uuid, p_date date)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  RETURN abos.open_period_for_business_date(p_entity, NULLIF(current_setting('abos.actor_user_account_id', true), '')::uuid, p_date);
END
$function$;


-- Restated: the expense lane opens the month covering its date (record and post), like every other lane.

CREATE OR REPLACE FUNCTION abos.operational_expense_create(p_identity_proof text, p_runtime_token_sha256 text, p_token_sha256 text, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  v_actor_context jsonb;
  v_actor_id uuid;
  v_entity_id uuid;
  v_treasury_id uuid;
  v_category_id uuid;
  v_payee_id uuid;
  v_project_id uuid;
  v_department_id uuid;
  v_cost_center_id uuid;
  v_exchange_rate_id uuid;
  v_correlation_id uuid;
  v_business_date date;
  v_amount_text text;
  v_original_amount numeric;
  v_currency text;
  v_base_currency text;
  v_base_amount numeric;
  v_reference text;
  v_description text;
  v_note text;
  v_request_key text;
  v_payment_kind text;
  v_fingerprint text;
  v_scope text;
  v_idempotency abos.idempotency_records%ROWTYPE;
  v_policy abos.finance_workflow_policy_versions%ROWTYPE;
  v_kind_policy abos.finance_workflow_policy_versions%ROWTYPE;
  v_approval boolean;
  v_expense_id uuid := pg_catalog.gen_random_uuid();
  v_snapshot_id uuid;
  v_snapshot abos.exchange_rate_snapshots%ROWTYPE;
  v_conversion abos.fx_conversions%ROWTYPE;
  v_route text;
  v_response jsonb;
  v_unknown text;
BEGIN
  -- Identity, legal entity and permission come only from server proof plus the live session.
  v_actor_context := abos.operational_finance_actor(
    p_identity_proof, p_runtime_token_sha256, p_token_sha256, 'finance.expense.create');
  v_actor_id := (v_actor_context ->> 'userAccountId')::uuid;
  v_entity_id := (v_actor_context ->> 'legalEntityId')::uuid;

  IF p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'expense details must be an object'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT pg_catalog.string_agg(payload_key, ', ') INTO v_unknown
    FROM pg_catalog.jsonb_object_keys(p_payload) payload_key
   WHERE payload_key NOT IN (
     'treasuryAccountId', 'expenseCategoryId', 'payeeBusinessPartyId',
     'projectId', 'departmentId', 'costCenterId', 'reference', 'description', 'note',
     'businessDate', 'originalAmount', 'currencyCode', 'exchangeRateId',
     'correlationId', 'idempotencyKey', 'paymentKind');
  IF v_unknown IS NOT NULL THEN
    RAISE EXCEPTION 'unknown expense fields: %', v_unknown
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Money crosses the boundary as a canonical decimal string (the contracts' pattern). A plain
  -- ::numeric cast would also accept NaN, Infinity and exponents.
  v_amount_text := p_payload ->> 'originalAmount';
  IF v_amount_text IS NULL OR pg_catalog.length(v_amount_text) > 256
     OR v_amount_text !~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$' THEN
    RAISE EXCEPTION 'the expense amount must be a plain positive decimal'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_original_amount := v_amount_text::numeric;
  v_treasury_id := NULLIF(p_payload ->> 'treasuryAccountId', '')::uuid;
  v_category_id := NULLIF(p_payload ->> 'expenseCategoryId', '')::uuid;
  v_payee_id := NULLIF(p_payload ->> 'payeeBusinessPartyId', '')::uuid;
  v_project_id := NULLIF(p_payload ->> 'projectId', '')::uuid;
  v_department_id := NULLIF(p_payload ->> 'departmentId', '')::uuid;
  v_cost_center_id := NULLIF(p_payload ->> 'costCenterId', '')::uuid;
  v_exchange_rate_id := NULLIF(p_payload ->> 'exchangeRateId', '')::uuid;
  v_correlation_id := NULLIF(p_payload ->> 'correlationId', '')::uuid;
  v_business_date := NULLIF(p_payload ->> 'businessDate', '')::date;
  v_currency := pg_catalog.upper(NULLIF(pg_catalog.btrim(p_payload ->> 'currencyCode'), ''));
  v_reference := NULLIF(pg_catalog.btrim(p_payload ->> 'reference'), '');
  v_description := NULLIF(pg_catalog.btrim(p_payload ->> 'description'), '');
  v_note := NULLIF(pg_catalog.btrim(p_payload ->> 'note'), '');
  v_request_key := NULLIF(pg_catalog.btrim(p_payload ->> 'idempotencyKey'), '');
  -- 0048: an expense recorded as a payment names its kind, which chooses the governing approval setting.
  v_payment_kind := NULLIF(pg_catalog.btrim(p_payload ->> 'paymentKind'), '');
  IF v_payment_kind IS NOT NULL AND v_payment_kind NOT IN ('SUPPLIER', 'CONTRACTOR', 'SALARY', 'OTHER') THEN
    RAISE EXCEPTION 'complete valid expense details are required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_treasury_id IS NULL OR v_category_id IS NULL OR v_correlation_id IS NULL
     OR v_business_date IS NULL OR v_original_amount <= 0
     OR v_currency IS NULL OR v_reference IS NULL OR v_description IS NULL
     OR v_request_key IS NULL OR pg_catalog.length(v_request_key) NOT BETWEEN 8 AND 200
     OR pg_catalog.length(v_reference) > 120
     OR pg_catalog.length(v_description) NOT BETWEEN 3 AND 500
     OR (v_note IS NOT NULL AND pg_catalog.length(v_note) > 1000) THEN
    RAISE EXCEPTION 'complete valid expense details are required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Idempotency first (after identity), so an identical retry returns the recorded result even if
  -- configuration changed meanwhile. The creator is part of the fingerprint: another user reusing
  -- the key is a conflict, never someone else's result.
  v_fingerprint := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    pg_catalog.jsonb_build_object(
      'actorId', v_actor_id,
      'treasuryAccountId', v_treasury_id, 'expenseCategoryId', v_category_id,
      'payeeBusinessPartyId', v_payee_id, 'projectId', v_project_id,
      'departmentId', v_department_id, 'costCenterId', v_cost_center_id,
      'reference', v_reference, 'description', v_description, 'note', v_note,
      'businessDate', v_business_date, 'originalAmount', v_original_amount::text,
      'currencyCode', v_currency, 'exchangeRateId', v_exchange_rate_id,
      'correlationId', v_correlation_id)
      -- 0048: present only with a kind, so requests without one keep their exact fingerprint.
      || CASE WHEN v_payment_kind IS NULL THEN '{}'::jsonb ELSE pg_catalog.jsonb_build_object('paymentKind', v_payment_kind) END
      ::text, 'UTF8')), 'hex');
  v_scope := v_entity_id::text || ':OPERATIONAL_EXPENSE_CREATE';
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_scope || ':' || v_request_key, 0));
  SELECT * INTO v_idempotency FROM abos.idempotency_records record
   WHERE record.scope = v_scope AND record.idempotency_key = v_request_key;
  IF FOUND THEN
    IF v_idempotency.request_fingerprint <> v_fingerprint THEN
      RAISE EXCEPTION 'idempotency key was already used for different expense details'
        USING ERRCODE = 'unique_violation';
    END IF;
    IF v_idempotency.status = 'COMPLETED' THEN
      RETURN v_idempotency.response_snapshot || pg_catalog.jsonb_build_object('replayed', true);
    END IF;
    RAISE EXCEPTION 'expense request with this idempotency key is still in progress'
      USING ERRCODE = 'serialization_failure';
  END IF;

  SELECT entity.base_currency_code INTO v_base_currency FROM abos.legal_entities entity
   WHERE entity.id = v_entity_id AND entity.currency_policy_status = 'APPROVED';
  IF v_base_currency IS NULL THEN
    RAISE EXCEPTION 'the legal entity has no approved base currency'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_currency = v_base_currency AND v_exchange_rate_id IS NOT NULL THEN
    RAISE EXCEPTION 'base-currency expense must not select an exchange rate'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM abos.operational_treasury_accounts account
     WHERE account.id = v_treasury_id AND account.legal_entity_id = v_entity_id
       AND account.status = 'ACTIVE' AND account.currency_code = v_currency
  ) OR NOT EXISTS (
    SELECT 1 FROM abos.operational_expense_categories category
     WHERE category.id = v_category_id AND category.legal_entity_id = v_entity_id
       AND category.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'active same-entity Treasury account and expense category are required'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_payee_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM abos.business_parties party
     WHERE party.id = v_payee_id AND party.legal_entity_id = v_entity_id AND party.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'payee is not an active business party in this legal entity'
      USING ERRCODE = 'check_violation';
  END IF;
  IF (v_project_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM abos.user_scope_grants grant_row
       WHERE grant_row.user_account_id = v_actor_id AND grant_row.legal_entity_id = v_entity_id
         AND grant_row.scope_kind = 'PROJECT' AND grant_row.scope_id = v_project_id
         AND grant_row.revoked_at IS NULL))
     OR (v_department_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM abos.user_scope_grants grant_row
       WHERE grant_row.user_account_id = v_actor_id AND grant_row.legal_entity_id = v_entity_id
         AND grant_row.scope_kind = 'DEPARTMENT' AND grant_row.scope_id = v_department_id
         AND grant_row.revoked_at IS NULL))
     OR (v_cost_center_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM abos.user_scope_grants grant_row
       WHERE grant_row.user_account_id = v_actor_id AND grant_row.legal_entity_id = v_entity_id
         AND grant_row.scope_kind = 'COST_CENTER' AND grant_row.scope_id = v_cost_center_id
         AND grant_row.revoked_at IS NULL)) THEN
    RAISE EXCEPTION 'expense dimensions are outside the actor''s live scope'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- 0052: the month covering the date opens itself; a closed financial year refuses.
  PERFORM abos.open_period_for_business_date(v_entity_id, v_actor_id, v_business_date);
  -- The route is fixed now: the deciding policy version at creation is stored with the expense and
  -- a later policy change never re-routes it. 0049: an expense needs approval when its EXPENSE setting
  -- or its payment kind's setting is ON, so a kind can never bypass the expense approval; a missing
  -- setting is the Simple Mode default (OFF) and is stored as a NULL reference.
  SELECT * INTO v_policy FROM abos.finance_workflow_policy_versions policy
   WHERE policy.legal_entity_id = v_entity_id AND policy.workflow_type = 'EXPENSE'
   ORDER BY policy.version DESC LIMIT 1;
  SELECT * INTO v_kind_policy FROM abos.finance_workflow_policy_versions policy
   WHERE policy.legal_entity_id = v_entity_id AND policy.workflow_type = abos.expense_workflow_type(v_payment_kind)
   ORDER BY policy.version DESC LIMIT 1;
  IF v_kind_policy.approval_required OR v_policy.id IS NULL THEN
    IF v_kind_policy.approval_required OR NOT COALESCE(v_policy.approval_required, false) THEN
      v_policy := v_kind_policy;
    END IF;
  END IF;
  v_approval := COALESCE(v_policy.approval_required, false);

  INSERT INTO abos.idempotency_records
    (scope, idempotency_key, request_fingerprint, correlation_id, status)
  VALUES (v_scope, v_request_key, v_fingerprint, v_correlation_id, 'IN_PROGRESS');

  INSERT INTO abos.operational_expenses
    (id, legal_entity_id, operational_treasury_account_id,
     operational_expense_category_id, payee_business_party_id, project_id,
     department_id, cost_center_id, reference, description, note, business_date,
     original_amount, original_currency_code, base_amount, base_currency_code,
     workflow_policy_version_id, approval_required, correlation_id, idempotency_key,
     request_fingerprint, status, version, created_by_user_account_id, payment_kind)
  VALUES
    (v_expense_id, v_entity_id, v_treasury_id, v_category_id, v_payee_id, v_project_id,
     v_department_id, v_cost_center_id, v_reference, v_description, v_note,
     v_business_date, v_original_amount, v_currency,
     CASE WHEN v_currency = v_base_currency THEN v_original_amount ELSE NULL END,
     v_base_currency, v_policy.id, v_approval, v_correlation_id,
     v_request_key, v_fingerprint, 'DRAFT', 1, v_actor_id, v_payment_kind);

  IF v_currency = v_base_currency THEN
    v_base_amount := v_original_amount;
  ELSE
    -- 0051: that business date's current rate (the user's choice when several exist), converted under the FX policy.
    v_conversion := abos.fx_convert(v_entity_id, 'OPERATIONAL_EXPENSE', v_expense_id, v_currency, v_business_date,
      v_exchange_rate_id, v_actor_id, v_original_amount);
    v_snapshot_id := v_conversion.exchange_rate_snapshot_id;
    v_base_amount := v_conversion.base_amount;
  END IF;
  v_route := CASE WHEN v_approval THEN 'PENDING_APPROVAL' ELSE 'VALIDATED' END;
  UPDATE abos.operational_expenses
     SET base_amount = v_base_amount, exchange_rate_snapshot_id = v_snapshot_id,
         status = v_route, version = 2, updated_at = pg_catalog.clock_timestamp()
   WHERE id = v_expense_id;
  -- Approval OFF: post in this same transaction; no approval row is written.
  IF NOT v_approval THEN
    PERFORM abos.operational_expense_post(v_expense_id, v_actor_id);
  END IF;
  v_response := pg_catalog.jsonb_build_object(
    'expense', abos.operational_expense_json(v_expense_id), 'replayed', false);
  UPDATE abos.idempotency_records
     SET status = 'COMPLETED', resource_type = 'OPERATIONAL_EXPENSE',
         resource_id = v_expense_id, response_code = 200, response_snapshot = v_response,
         completed_at = pg_catalog.clock_timestamp()
   WHERE scope = v_scope AND idempotency_key = v_request_key;
  INSERT INTO abos.audit_records
    (id, actor_user_account_id, legal_entity_id, correlation_id, action,
     entity_type, entity_id, after_state, metadata)
  VALUES
    (pg_catalog.gen_random_uuid(), v_actor_id, v_entity_id, v_correlation_id,
     'OPERATIONAL_EXPENSE_CREATED', 'OPERATIONAL_EXPENSE', v_expense_id,
     abos.operational_expense_json(v_expense_id),
     pg_catalog.jsonb_build_object(
       'source', 'v1-operational-expense',
       'approvalRequired', v_approval,
       'policyVersionId', v_policy.id));
  RETURN v_response;
END
$function$;

CREATE OR REPLACE FUNCTION abos.operational_expense_post(p_expense_id uuid, p_actor_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  expense abos.operational_expenses%ROWTYPE;
  treasury abos.operational_treasury_accounts%ROWTYPE;
  category abos.operational_expense_categories%ROWTYPE;
  period_id uuid;
  v_intent_id uuid := pg_catalog.gen_random_uuid();
  v_journal_id uuid := pg_catalog.gen_random_uuid();
  snapshot_reference text;
  initial_intent_status text;
BEGIN
  IF current_user <> 'abos_v1_operational_finance_owner' THEN
    RAISE EXCEPTION 'operational posting helper is internal'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO expense FROM abos.operational_expenses
   WHERE id = p_expense_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'operational expense not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF expense.status = 'POSTED' THEN RETURN expense.journal_id; END IF;
  IF expense.status NOT IN ('VALIDATED', 'PENDING_APPROVAL') THEN
    RAISE EXCEPTION 'expense is not ready to post' USING ERRCODE = 'check_violation';
  END IF;
  IF expense.approval_required THEN
    IF expense.status <> 'PENDING_APPROVAL' OR NOT EXISTS (
      SELECT 1 FROM abos.operational_expense_approvals approval
       WHERE approval.operational_expense_id = expense.id
         AND approval.legal_entity_id = expense.legal_entity_id
         AND approval.approver_user_account_id = p_actor_id
         AND approval.decision = 'APPROVED') THEN
      RAISE EXCEPTION 'approval-required expense has no approval from the posting actor'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    initial_intent_status := 'APPROVED';
  ELSE
    IF expense.status <> 'VALIDATED' OR expense.created_by_user_account_id <> p_actor_id
       OR EXISTS (SELECT 1 FROM abos.operational_expense_approvals approval
                   WHERE approval.operational_expense_id = expense.id) THEN
      RAISE EXCEPTION 'direct-posting expense route is inconsistent'
        USING ERRCODE = 'check_violation';
    END IF;
    initial_intent_status := 'VALIDATED';
  END IF;
  SELECT * INTO treasury FROM abos.operational_treasury_accounts
   WHERE id = expense.operational_treasury_account_id
     AND legal_entity_id = expense.legal_entity_id AND status = 'ACTIVE';
  SELECT * INTO category FROM abos.operational_expense_categories
   WHERE id = expense.operational_expense_category_id
     AND legal_entity_id = expense.legal_entity_id AND status = 'ACTIVE';
  IF treasury.id IS NULL OR category.id IS NULL THEN
    RAISE EXCEPTION 'expense Treasury account and category must remain active'
      USING ERRCODE = 'check_violation';
  END IF;
  -- 0052: the month covering the date opens itself; a closed financial year refuses.
  period_id := abos.open_period_for_business_date(expense.legal_entity_id, p_actor_id, expense.business_date);
  snapshot_reference := expense.exchange_rate_snapshot_id::text;

  PERFORM abos.posting_kernel_draft(
    p_intent_id => v_intent_id, p_journal_id => v_journal_id,
    p_legal_entity_id => expense.legal_entity_id,
    p_source_type => 'OPERATIONAL_EXPENSE', p_source_id => expense.id,
    p_original_amount => expense.original_amount,
    p_original_currency_code => expense.original_currency_code,
    p_base_amount => expense.base_amount, p_base_currency_code => expense.base_currency_code,
    p_accounting_effective_date => expense.business_date, p_accounting_period_id => period_id,
    p_journal_reference => 'OPX-' || v_journal_id::text,
    p_correlation_id => expense.correlation_id,
    p_idempotency_key => 'OPX:' || expense.idempotency_key,
    p_initial_status => initial_intent_status,
    p_created_by_user_account_id => expense.created_by_user_account_id,
    p_lines => ARRAY[
      ROW(1, 'DEBIT', category.ledger_account_id, expense.payee_business_party_id,
          expense.project_id, expense.department_id, expense.cost_center_id,
          NULL, NULL, NULL, NULL)::abos.posting_kernel_line,
      ROW(2, 'CREDIT', treasury.ledger_account_id, NULL,
          expense.project_id, expense.department_id, expense.cost_center_id,
          'OPERATIONAL_TREASURY', -1, expense.operational_treasury_account_id, NULL)::abos.posting_kernel_line],
    p_project_id => expense.project_id, p_department_id => expense.department_id,
    p_cost_center_id => expense.cost_center_id,
    p_conversion_snapshot_reference => snapshot_reference);
  UPDATE abos.operational_expenses
     SET status = 'POSTED', journal_id = v_journal_id, version = version + 1,
         updated_at = pg_catalog.clock_timestamp()
   WHERE id = expense.id;
  PERFORM abos.posting_kernel_commit(v_intent_id, v_journal_id, p_actor_id);
  INSERT INTO abos.audit_records
    (id, actor_user_account_id, legal_entity_id, correlation_id, action,
     entity_type, entity_id, after_state, metadata)
  VALUES
    (pg_catalog.gen_random_uuid(), p_actor_id, expense.legal_entity_id,
     expense.correlation_id, 'OPERATIONAL_EXPENSE_POSTED', 'OPERATIONAL_EXPENSE',
     expense.id, pg_catalog.jsonb_build_object(
       'expenseId', expense.id, 'journalId', v_journal_id,
       'approvalRequired', expense.approval_required,
       'originalAmount', expense.original_amount::text,
       'originalCurrency', expense.original_currency_code,
       'baseAmount', expense.base_amount::text,
       'baseCurrency', expense.base_currency_code),
     pg_catalog.jsonb_build_object('source', 'v1-operational-expense'));
  INSERT INTO abos.outbox_events
    (id, aggregate_type, aggregate_id, event_type, event_version,
     legal_entity_id, actor_user_account_id, correlation_id, payload, occurred_at)
  VALUES
    (pg_catalog.gen_random_uuid(), 'OPERATIONAL_EXPENSE', expense.id,
     'finance.operational-expense.posted', 1, expense.legal_entity_id, p_actor_id,
     expense.correlation_id,
     pg_catalog.jsonb_build_object('expenseId', expense.id, 'journalId', v_journal_id),
     pg_catalog.clock_timestamp());
  RETURN v_journal_id;
END
$function$;

CREATE OR REPLACE FUNCTION abos.operational_expense_entry_options(p_identity_proof text, p_runtime_token_sha256 text, p_token_sha256 text, p_business_date date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  v_actor_context jsonb;
  v_actor_id uuid;
  v_entity_id uuid;
  v_base_currency text;
  v_policy abos.finance_workflow_policy_versions%ROWTYPE;
  v_period record;
BEGIN
  v_actor_context := abos.operational_finance_actor(
    p_identity_proof, p_runtime_token_sha256, p_token_sha256, 'finance.expense.create');
  v_actor_id := (v_actor_context ->> 'userAccountId')::uuid;
  v_entity_id := (v_actor_context ->> 'legalEntityId')::uuid;
  IF p_business_date IS NULL THEN
    RAISE EXCEPTION 'a business date is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT entity.base_currency_code INTO v_base_currency FROM abos.legal_entities entity
   WHERE entity.id = v_entity_id AND entity.currency_policy_status = 'APPROVED';
  SELECT * INTO v_policy FROM abos.finance_workflow_policy_versions policy
   WHERE policy.legal_entity_id = v_entity_id AND policy.workflow_type = 'EXPENSE'
   ORDER BY policy.version DESC LIMIT 1;
  SELECT period.id, period.period_name, period.period_name_fa INTO v_period
    FROM abos.accounting_periods period
   WHERE period.legal_entity_id = v_entity_id AND period.status IN ('OPEN', 'PENDING')
     AND p_business_date BETWEEN period.starts_on AND period.ends_on
     AND NOT abos.financial_year_closed_on(v_entity_id, p_business_date);

  RETURN pg_catalog.jsonb_build_object(
    'businessDate', p_business_date,
    'baseCurrency', v_base_currency,
    'policyConfigured', v_policy.id IS NOT NULL,
    'approvalRequired', COALESCE(v_policy.approval_required, false),
    'openPeriod', CASE WHEN v_period.id IS NULL THEN NULL ELSE pg_catalog.jsonb_build_object(
      'nameEn', v_period.period_name, 'nameFa', v_period.period_name_fa) END,
    'treasuryAccounts', COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', account.id, 'nameEn', account.name_en, 'nameFa', account.name_fa,
        'currencyCode', account.currency_code, 'accountType', account.account_type,
        'requiresProject', ledger.requires_project, 'requiresDepartment', ledger.requires_department,
        'requiresCostCenter', ledger.requires_cost_center)
        ORDER BY account.name_en, account.id)
      FROM abos.operational_treasury_accounts account
      JOIN abos.ledger_accounts ledger
        ON ledger.id = account.ledger_account_id AND ledger.legal_entity_id = account.legal_entity_id
      WHERE account.legal_entity_id = v_entity_id AND account.status = 'ACTIVE'), '[]'::jsonb),
    'expenseCategories', COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', category.id, 'code', category.category_code,
        'nameEn', category.name_en, 'nameFa', category.name_fa,
        'requiresProject', ledger.requires_project, 'requiresDepartment', ledger.requires_department,
        'requiresCostCenter', ledger.requires_cost_center)
        ORDER BY category.category_code, category.id)
      FROM abos.operational_expense_categories category
      JOIN abos.ledger_accounts ledger
        ON ledger.id = category.ledger_account_id AND ledger.legal_entity_id = category.legal_entity_id
      WHERE category.legal_entity_id = v_entity_id AND category.status = 'ACTIVE'), '[]'::jsonb),
    -- Offered payees are parties with a current supplier, contractor or employee role; the
    -- shareholder register is not exposed on an expense form.
    'payees', COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', party.id, 'name', party.display_name) ORDER BY party.display_name, party.id)
      FROM abos.business_parties party
      WHERE party.legal_entity_id = v_entity_id AND party.status = 'ACTIVE'
        AND EXISTS (SELECT 1 FROM abos.business_party_roles role
                     WHERE role.business_party_id = party.id
                       AND role.role_code IN ('SUPPLIER', 'CONTRACTOR', 'EMPLOYEE')
                       AND role.effective_from <= p_business_date
                       AND (role.effective_to IS NULL OR role.effective_to >= p_business_date))), '[]'::jsonb),
    'projects', COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', dimension.id, 'code', dimension.code, 'name', dimension.name) ORDER BY dimension.code)
      FROM abos.projects dimension
      JOIN abos.user_scope_grants grant_row
        ON grant_row.scope_id = dimension.id AND grant_row.scope_kind = 'PROJECT'
       AND grant_row.user_account_id = v_actor_id AND grant_row.legal_entity_id = v_entity_id
       AND grant_row.revoked_at IS NULL
      WHERE dimension.legal_entity_id = v_entity_id AND dimension.active), '[]'::jsonb),
    'departments', COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', dimension.id, 'code', dimension.code, 'name', dimension.name) ORDER BY dimension.code)
      FROM abos.departments dimension
      JOIN abos.user_scope_grants grant_row
        ON grant_row.scope_id = dimension.id AND grant_row.scope_kind = 'DEPARTMENT'
       AND grant_row.user_account_id = v_actor_id AND grant_row.legal_entity_id = v_entity_id
       AND grant_row.revoked_at IS NULL
      WHERE dimension.legal_entity_id = v_entity_id AND dimension.active), '[]'::jsonb),
    'costCenters', COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', dimension.id, 'code', dimension.code, 'name', dimension.name) ORDER BY dimension.code)
      FROM abos.cost_centers dimension
      JOIN abos.user_scope_grants grant_row
        ON grant_row.scope_id = dimension.id AND grant_row.scope_kind = 'COST_CENTER'
       AND grant_row.user_account_id = v_actor_id AND grant_row.legal_entity_id = v_entity_id
       AND grant_row.revoked_at IS NULL
      WHERE dimension.legal_entity_id = v_entity_id AND dimension.active), '[]'::jsonb),
    -- Only that date's current (not superseded) rates between the base currency and another
    -- currency. Values are exact text, as entered.
    'exchangeRates', COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', rate.id, 'rateSource', rate.rate_source, 'sarafName', saraf.display_name,
        'unitCurrency', rate.unit_currency_code, 'quoteCurrency', rate.quote_currency_code,
        'rate', rate.rate_value::text) ORDER BY rate.rate_source, saraf.display_name NULLS FIRST, rate.id)
      FROM abos.exchange_rates rate
      LEFT JOIN abos.business_parties saraf ON saraf.id = rate.saraf_business_party_id
      WHERE rate.legal_entity_id = v_entity_id AND rate.rate_date = p_business_date
        AND v_base_currency IN (rate.unit_currency_code, rate.quote_currency_code)
        AND NOT EXISTS (SELECT 1 FROM abos.exchange_rates correction
                         WHERE correction.supersedes_exchange_rate_id = rate.id)), '[]'::jsonb));
END
$function$;

CREATE OR REPLACE FUNCTION abos.finance_workflow_policy_workspace(p_identity_proof text, p_runtime_token_sha256 text, p_token_sha256 text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
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
               'approvalAvailable', abos.finance_workflow_approval_available(workflow.workflow_type),
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
   WHERE workflow.active AND workflow.workflow_type <> 'PERIOD_REOPEN';
  RETURN result;
END
$function$;


-- Restated: reversals read the financial year (0050 rule at year level); the workspace reports a closed year.

CREATE OR REPLACE FUNCTION abos.reversal_post(p_entity uuid, p_actor uuid, p_approver uuid, p_journal uuid, p_reason text, p_request uuid, p_correlation uuid, p_mode text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE o abos.journals%ROWTYPE; oi abos.posting_intents%ROWTYPE; src abos.posting_sources%ROWTYPE; blocker text;
  period_status text; day date; period uuid; l record; result jsonb; ref text; self boolean;
  lines abos.posting_kernel_line[] := ARRAY[]::abos.posting_kernel_line[];
  reversal uuid := gen_random_uuid(); intent uuid := gen_random_uuid(); evidence uuid := gen_random_uuid();
BEGIN
  -- One reversal at a time per journal: a concurrent second attempt waits here and then finds the link.
  SELECT * INTO o FROM abos.journals WHERE id = p_journal AND legal_entity_id = p_entity FOR UPDATE;
  IF NOT FOUND OR NOT abos.reversal_journal_in_scope(p_journal, p_entity, p_actor) THEN
    RAISE EXCEPTION 'journal not found' USING ERRCODE = 'no_data_found';
  END IF;
  blocker := abos.reversal_journal_blocker(p_journal, p_entity);
  IF blocker = 'NOT_POSTED' THEN RAISE EXCEPTION 'only a posted journal can be reversed' USING ERRCODE = 'check_violation';
  ELSIF blocker = 'IS_REVERSAL' THEN RAISE EXCEPTION 'this journal is itself a reversal; reversing a reversal is not available' USING ERRCODE = 'check_violation';
  ELSIF blocker = 'ALREADY_REVERSED' THEN RAISE EXCEPTION 'this journal has already been reversed' USING ERRCODE = 'check_violation';
  ELSIF blocker IN ('OPEN_REQUEST', 'APPROVED_REQUEST') AND p_request IS NULL THEN
    RAISE EXCEPTION 'this journal has a reversal request; decide that request instead' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO oi FROM abos.posting_intents WHERE id = o.posting_intent_id;
  SELECT * INTO src FROM abos.posting_sources WHERE source_type = oi.source_type;
  IF o.processing_model <> 'OPERATIONAL_V1' OR src.status IS DISTINCT FROM 'ACTIVE' OR NOT src.reversible THEN
    RAISE EXCEPTION 'this kind of transaction cannot be reversed yet' USING ERRCODE = 'check_violation';
  END IF;
  -- Simple Mode (DIRECT): the reverser may correct their own transaction; it is flagged as a self-correction.
  -- Approved requests keep independence from whoever prepared, approved or posted the original.
  self := p_actor = ANY (abos.reversal_journal_participants(p_journal));
  IF p_mode <> 'DIRECT' AND (self OR p_approver = ANY (abos.reversal_journal_participants(p_journal))) THEN
    RAISE EXCEPTION 'whoever prepared, approved or posted a journal cannot reverse it' USING ERRCODE = 'insufficient_privilege';
  END IF;
  self := self AND p_mode = 'DIRECT';
  SELECT status INTO period_status FROM abos.accounting_periods WHERE id = o.accounting_period_id FOR SHARE;
  -- 0052: the original date is kept while the original's financial year is not closed.
  IF period_status = 'OPEN' AND NOT abos.financial_year_closed_on(p_entity, o.accounting_effective_date) THEN
    day := o.accounting_effective_date; period := o.accounting_period_id;
  ELSE
    -- The original's financial year is closed: the reversal posts on the business day, in an open year only.
    day := abos.business_today(); period := abos.open_period_for_business_date(p_entity, p_actor, day);
  END IF;
  FOR l IN SELECT line.line_number, line.base_debit, line.ledger_account_id, line.business_party_id, line.project_id,
                  line.department_id, line.cost_center_id, entry.subledger_type, entry.original_amount AS movement,
                  entry.operational_treasury_account_id, entry.business_party_id AS movement_party
             FROM abos.journal_lines line LEFT JOIN abos.subledger_entries entry ON entry.journal_line_id = line.id
            WHERE line.journal_id = p_journal ORDER BY line.line_number LOOP
    lines := lines || ROW(l.line_number, CASE WHEN l.base_debit > 0 THEN 'CREDIT' ELSE 'DEBIT' END, l.ledger_account_id,
      l.business_party_id, l.project_id, l.department_id, l.cost_center_id, l.subledger_type,
      CASE WHEN l.subledger_type IS NULL THEN NULL WHEN l.movement > 0 THEN -1 ELSE 1 END,
      l.operational_treasury_account_id, l.movement_party)::abos.posting_kernel_line;
  END LOOP;
  ref := 'RV-' || to_char(day, 'YYYYMMDD') || '-' || upper(replace(reversal::text, '-', ''));
  PERFORM abos.posting_kernel_draft(
    p_intent_id => intent, p_journal_id => reversal, p_legal_entity_id => p_entity, p_source_type => 'REVERSAL', p_source_id => p_journal,
    p_original_amount => oi.original_amount, p_original_currency_code => oi.original_currency_code,
    p_base_amount => oi.base_amount, p_base_currency_code => oi.base_currency_code,
    p_accounting_effective_date => day, p_accounting_period_id => period, p_journal_reference => ref, p_correlation_id => p_correlation,
    p_idempotency_key => 'RV:' || p_journal::text, p_initial_status => 'VALIDATED', p_created_by_user_account_id => p_actor,
    p_lines => lines, p_project_id => oi.project_id, p_department_id => oi.department_id, p_cost_center_id => oi.cost_center_id,
    p_conversion_snapshot_reference => oi.conversion_snapshot_reference);
  PERFORM abos.posting_kernel_commit(intent, reversal, p_actor);
  -- The written reason is the evidence (owner decision #4).
  INSERT INTO abos.evidence_references (id, legal_entity_id, document_id, evidence_kind, evidence_version, sha256, completed_at)
  VALUES (evidence, p_entity, COALESCE(p_request, reversal), 'REVERSAL_REASON', 1,
          encode(sha256(convert_to(p_reason, 'UTF8')), 'hex'), clock_timestamp());
  INSERT INTO abos.journal_reversal_links (original_journal_id, reversal_journal_id, reason, approved_by_user_account_id, evidence_reference_id,
    reversal_mode, self_reversal)
  VALUES (p_journal, reversal, p_reason, p_approver, evidence, CASE WHEN p_mode = 'DIRECT' THEN 'DIRECT' ELSE 'APPROVED_REQUEST' END, self);
  result := jsonb_build_object('originalJournalId', p_journal, 'originalReference', o.journal_reference, 'reversalJournalId', reversal,
    'reference', ref, 'effectiveDate', day, 'postedInOriginalPeriod', period = o.accounting_period_id, 'selfReversal', self,
    'status', 'POSTED', 'replayed', false);
  PERFORM abos.money_audit(p_actor, p_entity, p_correlation, 'JOURNAL_REVERSAL_POSTED', 'JOURNAL', reversal,
    result || jsonb_build_object('mode', p_mode, 'requestId', p_request, 'approvedBy', p_approver, 'reason', p_reason));
  RETURN result;
END
$function$;

CREATE OR REPLACE FUNCTION abos.validate_reversal_journal(p_journal abos.journals, p_intent abos.posting_intents)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE o abos.journals%ROWTYPE; oi abos.posting_intents%ROWTYPE; src abos.posting_sources%ROWTYPE; o_period abos.accounting_periods%ROWTYPE;
BEGIN
  SELECT * INTO o FROM abos.journals WHERE id = p_intent.source_id AND legal_entity_id = p_journal.legal_entity_id;
  IF NOT FOUND OR o.id = p_journal.id OR o.status <> 'POSTED' OR o.processing_model <> 'OPERATIONAL_V1'
     OR o.base_currency_code <> p_journal.base_currency_code THEN
    RAISE EXCEPTION 'a reversal must reverse a posted operational journal of the same company and currency' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO oi FROM abos.posting_intents WHERE id = o.posting_intent_id;
  SELECT * INTO src FROM abos.posting_sources WHERE source_type = oi.source_type;
  IF NOT FOUND OR src.status <> 'ACTIVE' OR NOT src.reversible OR oi.intent_kind = 'REVERSAL' THEN
    RAISE EXCEPTION 'this kind of journal cannot be reversed' USING ERRCODE = 'check_violation';
  END IF;
  IF p_intent.intent_kind <> 'REVERSAL' OR p_intent.source_type <> 'REVERSAL'
     OR p_intent.original_amount <> oi.original_amount OR p_intent.base_amount <> oi.base_amount
     OR p_intent.original_currency_code IS DISTINCT FROM oi.original_currency_code
     OR p_intent.conversion_snapshot_reference IS DISTINCT FROM oi.conversion_snapshot_reference THEN
    RAISE EXCEPTION 'a reversal must carry exactly the original amounts and currencies' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO o_period FROM abos.accounting_periods WHERE id = o.accounting_period_id;
  IF NOT ((p_journal.accounting_period_id = o.accounting_period_id AND p_journal.accounting_effective_date = o.accounting_effective_date)
       OR ((o_period.status <> 'OPEN' OR abos.financial_year_closed_on(o.legal_entity_id, o.accounting_effective_date))
           AND p_journal.accounting_effective_date > o_period.ends_on)) THEN
    -- 0052: the original date while the original's financial year is not closed, otherwise a later date.
    RAISE EXCEPTION 'a reversal posts on the original date while that financial year is open, otherwise on a later date'
      USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT count(*) FROM abos.journal_lines WHERE journal_id = o.id) <> (SELECT count(*) FROM abos.journal_lines WHERE journal_id = p_journal.id)
     OR EXISTS (SELECT l.line_number, l.ledger_account_id, l.business_party_id, l.project_id, l.department_id, l.cost_center_id,
                       l.original_amount, l.original_currency_code, l.base_debit, l.base_credit
                  FROM abos.journal_lines l WHERE l.journal_id = o.id
                EXCEPT
                SELECT r.line_number, r.ledger_account_id, r.business_party_id, r.project_id, r.department_id, r.cost_center_id,
                       r.original_amount, r.original_currency_code, r.base_credit, r.base_debit
                  FROM abos.journal_lines r WHERE r.journal_id = p_journal.id) THEN
    RAISE EXCEPTION 'a reversal must invert every original line exactly' USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT count(*) FROM abos.subledger_entries e JOIN abos.journal_lines l ON l.id = e.journal_line_id WHERE l.journal_id = o.id)
       <> (SELECT count(*) FROM abos.subledger_entries e JOIN abos.journal_lines l ON l.id = e.journal_line_id WHERE l.journal_id = p_journal.id)
     OR EXISTS (SELECT l.line_number, e.subledger_type, e.operational_treasury_account_id, e.business_party_id,
                       -e.original_amount, -e.base_amount, e.original_currency_code
                  FROM abos.subledger_entries e JOIN abos.journal_lines l ON l.id = e.journal_line_id WHERE l.journal_id = o.id
                EXCEPT
                SELECT l.line_number, e.subledger_type, e.operational_treasury_account_id, e.business_party_id,
                       e.original_amount, e.base_amount, e.original_currency_code
                  FROM abos.subledger_entries e JOIN abos.journal_lines l ON l.id = e.journal_line_id WHERE l.journal_id = p_journal.id) THEN
    RAISE EXCEPTION 'a reversal must invert every original subledger movement exactly' USING ERRCODE = 'check_violation';
  END IF;
END
$function$;

CREATE OR REPLACE FUNCTION abos.finance_journal_reversal_workspace(p_proof text, p_runtime text, p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE c jsonb; actor uuid; entity uuid; perms jsonb; approval boolean;
BEGIN
  c := abos.operational_finance_actor(p_proof, p_runtime, p_token, NULL);
  actor := (c->>'userAccountId')::uuid; entity := (c->>'legalEntityId')::uuid; perms := COALESCE(c->'permissions', '[]'::jsonb);
  IF NOT (perms ?| ARRAY['finance.reversal.direct', 'finance.reversal.request', 'finance.reversal.approve']) THEN
    RAISE EXCEPTION 'current authority is missing finance.reversal.direct, finance.reversal.request or finance.reversal.approve'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  approval := abos.workflow_setting_requires_approval(entity, 'JOURNAL_REVERSAL');
  RETURN jsonb_build_object(
    'today', abos.business_today(), 'approvalRequired', approval,
    'canReverseDirectly', perms ? 'finance.reversal.direct' AND NOT approval,
    'canRequest', perms ? 'finance.reversal.request', 'canApprove', perms ? 'finance.reversal.approve',
    'journals', COALESCE((SELECT jsonb_agg(row ORDER BY posted_at DESC) FROM (
      SELECT j.posted_at, jsonb_build_object('id', j.id, 'reference', j.journal_reference, 'date', j.accounting_effective_date,
        'sourceType', i.source_type, 'amount', i.original_amount::text, 'currency', i.original_currency_code,
        'postedBy', (SELECT display_name FROM abos.user_accounts WHERE id = j.posted_by_user_account_id),
        'periodStatus', CASE WHEN abos.financial_year_closed_on(entity, j.accounting_effective_date) THEN 'CLOSED' ELSE p.status END,
        'blocker', abos.reversal_journal_blocker(j.id, entity),
        'viewerIsParticipant', actor = ANY (abos.reversal_journal_participants(j.id)),
        'lines', (SELECT jsonb_agg(jsonb_build_object('lineNumber', l.line_number, 'accountCode', a.account_code, 'accountName', a.account_name,
            'debit', l.base_debit::text, 'credit', l.base_credit::text) ORDER BY l.line_number)
          FROM abos.journal_lines l JOIN abos.ledger_accounts a ON a.id = l.ledger_account_id WHERE l.journal_id = j.id),
        'reversal', (SELECT jsonb_build_object('journalId', rj.id, 'reference', rj.journal_reference, 'date', rj.accounting_effective_date,
            'reason', link.reason, 'selfReversal', link.self_reversal, 'mode', link.reversal_mode)
            FROM abos.journal_reversal_links link JOIN abos.journals rj ON rj.id = link.reversal_journal_id
          WHERE link.original_journal_id = j.id)) AS row
        FROM abos.journals j JOIN abos.posting_intents i ON i.id = j.posting_intent_id
        JOIN abos.posting_sources s ON s.source_type = i.source_type AND s.status = 'ACTIVE' AND s.reversible
        JOIN abos.accounting_periods p ON p.id = j.accounting_period_id
       WHERE j.legal_entity_id = entity AND j.status = 'POSTED' AND j.processing_model = 'OPERATIONAL_V1'
         AND abos.reversal_journal_in_scope(j.id, entity, actor)
       ORDER BY j.posted_at DESC LIMIT 100) x), '[]'::jsonb),
    'requests', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', r.id, 'journalId', r.journal_id, 'journalReference', j.journal_reference,
        'status', r.status, 'reason', r.reason, 'version', r.version,
        'requestedBy', (SELECT display_name FROM abos.user_accounts WHERE id = r.requested_by_user_account_id), 'requestedAt', r.requested_at,
        'decidedBy', (SELECT display_name FROM abos.user_accounts WHERE id = r.decided_by_user_account_id), 'decidedAt', r.decided_at,
        'decisionNote', r.decision_note, 'viewerIsRequester', r.requested_by_user_account_id = actor,
        'viewerIsParticipant', actor = ANY (abos.reversal_journal_participants(r.journal_id)),
        'reversalJournalId', (SELECT reversal_journal_id FROM abos.journal_reversal_links WHERE original_journal_id = r.journal_id))
        ORDER BY r.requested_at DESC)
      FROM abos.journal_reversal_requests r JOIN abos.journals j ON j.id = r.journal_id
     WHERE r.legal_entity_id = entity AND abos.reversal_journal_in_scope(r.journal_id, entity, actor)), '[]'::jsonb));
END
$function$;


-- ---------------------------------------------------------------------------------------------
-- 3. Financial year close.
-- ---------------------------------------------------------------------------------------------
-- What closing a financial year means: its posted journals and totals, items that would no longer be able to post,
-- and warnings. The only refusal is an integrity problem: a journal of the year that is not posted.
CREATE FUNCTION abos.financial_year_view(p_entity uuid, p_year uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $view$
  SELECT jsonb_build_object(
    'id', y.id, 'label', y.label_en, 'labelFa', y.label_fa, 'calendarKind', y.calendar_kind, 'startsOn', y.starts_on, 'endsOn', y.ends_on,
    'status', CASE WHEN y.closed_at IS NULL THEN 'ACTIVE' ELSE 'CLOSED' END,
    'closedAt', y.closed_at,
    'closedBy', (SELECT u.display_name FROM abos.user_accounts u WHERE u.id = y.closed_by_user_account_id),
    'postedJournals', (SELECT count(*) FROM abos.journals j WHERE j.legal_entity_id = p_entity AND j.status = 'POSTED'
                        AND j.accounting_effective_date BETWEEN y.starts_on AND y.ends_on),
    'months', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', p.id, 'name', p.period_name, 'nameFa', p.period_name_fa,
        'startsOn', p.starts_on, 'endsOn', p.ends_on) ORDER BY p.starts_on)
      FROM abos.accounting_periods p WHERE p.fiscal_year_id = y.id), '[]'::jsonb))
    FROM abos.fiscal_years y WHERE y.id = p_year AND y.legal_entity_id = p_entity
$view$;

CREATE FUNCTION abos.financial_year_close_preview_json(p_entity uuid, p_year uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $preview$
DECLARE y record; summary jsonb; unposted bigint; pending jsonb; warnings text[] := ARRAY[]::text[];
BEGIN
  SELECT id, starts_on, ends_on INTO y FROM abos.fiscal_years WHERE id = p_year AND legal_entity_id = p_entity;
  IF NOT FOUND THEN RAISE EXCEPTION 'the financial year was not found in this legal entity' USING ERRCODE = 'no_data_found'; END IF;
  SELECT jsonb_build_object('postedJournals', count(DISTINCT j.id), 'debits', COALESCE(sum(l.base_debit), 0)::text,
      'credits', COALESCE(sum(l.base_credit), 0)::text)
    INTO summary FROM abos.journals j JOIN abos.journal_lines l ON l.journal_id = j.id
   WHERE j.legal_entity_id = p_entity AND j.status = 'POSTED' AND j.accounting_effective_date BETWEEN y.starts_on AND y.ends_on;
  SELECT count(*) INTO unposted FROM abos.journals j WHERE j.legal_entity_id = p_entity AND j.status <> 'POSTED'
     AND j.accounting_effective_date BETWEEN y.starts_on AND y.ends_on;
  pending := jsonb_build_object(
    'expensesAwaitingApproval', (SELECT count(*) FROM abos.operational_expenses e WHERE e.legal_entity_id = p_entity AND e.status = 'PENDING_APPROVAL'
       AND e.business_date BETWEEN y.starts_on AND y.ends_on),
    'reversalRequests', (SELECT count(*) FROM abos.journal_reversal_requests r JOIN abos.journals j ON j.id = r.journal_id
       WHERE r.legal_entity_id = p_entity AND r.status IN ('REQUESTED', 'APPROVED') AND j.accounting_effective_date BETWEEN y.starts_on AND y.ends_on
         AND NOT EXISTS (SELECT 1 FROM abos.journal_reversal_links link WHERE link.original_journal_id = r.journal_id)),
    'temporaryFundingDecisions', (SELECT count(*) FROM abos.temporary_fundings f WHERE f.legal_entity_id = p_entity
       AND f.status = 'PENDING_APPROVAL' AND f.business_date BETWEEN y.starts_on AND y.ends_on)
       + (SELECT count(*) FROM abos.temporary_funding_settlements s WHERE s.legal_entity_id = p_entity
       AND s.status = 'PENDING_APPROVAL' AND s.business_date BETWEEN y.starts_on AND y.ends_on));
  IF y.ends_on >= abos.business_today() THEN warnings := warnings || 'YEAR_NOT_ENDED'; END IF;
  IF EXISTS (SELECT 1 FROM abos.fiscal_years e WHERE e.legal_entity_id = p_entity AND e.ends_on < y.starts_on AND e.closed_at IS NULL) THEN
    warnings := warnings || 'EARLIER_YEAR_ACTIVE';
  END IF;
  RETURN jsonb_build_object('year', abos.financial_year_view(p_entity, p_year), 'summary', summary, 'unpostedJournals', unposted,
    'pending', pending, 'warnings', to_jsonb(warnings));
END
$preview$;

CREATE FUNCTION abos.finance_financial_years_workspace(p_proof text, p_runtime text, p_token text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $workspace$
DECLARE c jsonb; entity uuid; perms jsonb;
BEGIN
  c := abos.operational_finance_actor(p_proof, p_runtime, p_token, NULL);
  entity := (c->>'legalEntityId')::uuid; perms := COALESCE(c->'permissions', '[]'::jsonb);
  IF NOT (perms ?| ARRAY['finance.period.manage', 'finance.report.operational.read']) THEN
    RAISE EXCEPTION 'current authority is missing finance.period.manage' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN jsonb_build_object('today', abos.business_today(), 'canClose', perms ? 'finance.period.manage',
    'years', COALESCE((SELECT jsonb_agg(abos.financial_year_view(entity, y.id) ORDER BY y.starts_on DESC)
      FROM abos.fiscal_years y WHERE y.legal_entity_id = entity), '[]'::jsonb));
END
$workspace$;

CREATE FUNCTION abos.finance_financial_year_close_preview(p_proof text, p_runtime text, p_token text, p_year uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $preview$
DECLARE c jsonb;
BEGIN
  c := abos.operational_finance_actor(p_proof, p_runtime, p_token, 'finance.period.manage');
  RETURN abos.financial_year_close_preview_json((c->>'legalEntityId')::uuid, p_year);
END
$preview$;

-- Closes the financial year: one update of the year row, no month row and no journal changes. From then on the posting
-- guard refuses every journal dated in the year. Idempotent: closing a closed year is a replay.
CREATE FUNCTION abos.finance_financial_year_close(p_proof text, p_runtime text, p_token text, p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $close$
DECLARE c jsonb; actor uuid; entity uuid; year_id uuid; correlation uuid; y record; preview jsonb;
BEGIN
  c := abos.operational_finance_actor(p_proof, p_runtime, p_token, 'finance.period.manage');
  actor := (c->>'userAccountId')::uuid; entity := (c->>'legalEntityId')::uuid;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_payload) k
       WHERE k NOT IN ('fiscalYearId', 'correlationId')) THEN
    RAISE EXCEPTION 'unknown financial year fields' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  BEGIN
    year_id := NULLIF(p_payload->>'fiscalYearId', '')::uuid;
    correlation := COALESCE(NULLIF(p_payload->>'correlationId', '')::uuid, gen_random_uuid());
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'choose a valid financial year' USING ERRCODE = 'invalid_parameter_value';
  END;
  -- The year row is locked first: postings into the year wait on it (the posting guard locks it FOR SHARE), so the
  -- integrity check and the close see a stable year.
  SELECT id, label_en, starts_on, ends_on, closed_at INTO y FROM abos.fiscal_years
   WHERE id = year_id AND legal_entity_id = entity FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'the financial year was not found in this legal entity' USING ERRCODE = 'no_data_found'; END IF;
  IF y.closed_at IS NOT NULL THEN
    RETURN jsonb_build_object('fiscalYearId', y.id, 'status', 'CLOSED', 'replayed', true, 'year', abos.financial_year_view(entity, y.id));
  END IF;
  preview := abos.financial_year_close_preview_json(entity, y.id);
  IF (preview->>'unpostedJournals')::bigint > 0 THEN
    RAISE EXCEPTION 'the financial year has a journal that is not posted; it cannot be closed' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE abos.fiscal_years SET closed_at = clock_timestamp(), closed_by_user_account_id = actor, close_correlation_id = correlation
   WHERE id = y.id AND legal_entity_id = entity AND closed_at IS NULL;
  PERFORM abos.money_audit(actor, entity, correlation, 'FINANCIAL_YEAR_CLOSED', 'FISCAL_YEAR', y.id,
    jsonb_build_object('label', y.label_en, 'startsOn', y.starts_on, 'endsOn', y.ends_on,
      'summary', preview->'summary', 'pending', preview->'pending', 'warnings', preview->'warnings'));
  RETURN jsonb_build_object('fiscalYearId', y.id, 'status', 'CLOSED', 'replayed', false, 'year', abos.financial_year_view(entity, y.id));
END
$close$;

-- ---------------------------------------------------------------------------------------------
-- 4. Privileges.
-- ---------------------------------------------------------------------------------------------
GRANT SELECT (id, legal_entity_id, calendar_kind, label_en, label_fa, starts_on, ends_on, closed_at, closed_by_user_account_id, close_correlation_id)
  ON abos.fiscal_years TO abos_v1_operational_finance_owner;
GRANT UPDATE (closed_at, closed_by_user_account_id, close_correlation_id) ON abos.fiscal_years TO abos_v1_operational_finance_owner;
GRANT SELECT (fiscal_year_id) ON abos.accounting_periods TO abos_v1_operational_finance_owner;
-- The calendar's own owner keeps reading the year it generates; closing stays with the operational Finance owner.
GRANT SELECT (closed_at, closed_by_user_account_id, close_correlation_id) ON abos.fiscal_years TO abos_e1_finance_owner;
REVOKE ALL ON FUNCTION abos.financial_year_closed_on(uuid, date), abos.guard_fiscal_year_mutation(), abos.journal_financial_year_guard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION abos.financial_year_closed_on(uuid, date) TO abos_v1_operational_finance_owner;
ALTER FUNCTION abos.journal_financial_year_guard() OWNER TO abos_v1_operational_finance_owner;
REVOKE ALL ON FUNCTION abos.financial_year_view(uuid, uuid), abos.financial_year_close_preview_json(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION abos.financial_year_view(uuid, uuid), abos.financial_year_close_preview_json(uuid, uuid) TO abos_v1_operational_finance_owner;
ALTER FUNCTION abos.finance_financial_years_workspace(text, text, text) OWNER TO abos_v1_operational_finance_owner;
ALTER FUNCTION abos.finance_financial_year_close_preview(text, text, text, uuid) OWNER TO abos_v1_operational_finance_owner;
ALTER FUNCTION abos.finance_financial_year_close(text, text, text, jsonb) OWNER TO abos_v1_operational_finance_owner;
REVOKE ALL ON FUNCTION abos.finance_financial_years_workspace(text, text, text), abos.finance_financial_year_close_preview(text, text, text, uuid),
  abos.finance_financial_year_close(text, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION abos.finance_financial_years_workspace(text, text, text), abos.finance_financial_year_close_preview(text, text, text, uuid),
  abos.finance_financial_year_close(text, text, text, jsonb) TO abos_e1_runtime;
