-- Slice 4: an expense paid from the Pay screen names its payment kind. Additive for data.
--
-- Paying for something that is an expense goes through the existing expense lane (categories, approval
-- route, FX snapshot, dimensions, payee), so expenses keep one model and one place in the reports. The
-- optional kind (SUPPLIER, CONTRACTOR, SALARY, OTHER) chooses the governing approval setting:
-- SALARY -> SALARY_PAYMENT, SUPPLIER and CONTRACTOR -> SUPPLIER_PAYMENT, OTHER or none -> EXPENSE, so a
-- salary cannot bypass a salary approval setting by being recorded as an ordinary expense. Requests
-- without a kind behave exactly as before, including their replay fingerprints. Existing rows keep a
-- NULL kind (EXPENSE), which is what governed them.

ALTER TABLE abos.operational_expenses ADD COLUMN payment_kind text
  CHECK (payment_kind IS NULL OR payment_kind IN ('SUPPLIER', 'CONTRACTOR', 'SALARY', 'OTHER'));

CREATE FUNCTION abos.expense_workflow_type(p_payment_kind text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $kind$
  SELECT CASE p_payment_kind WHEN 'SALARY' THEN 'SALARY_PAYMENT' WHEN 'SUPPLIER' THEN 'SUPPLIER_PAYMENT'
    WHEN 'CONTRACTOR' THEN 'SUPPLIER_PAYMENT' ELSE 'EXPENSE' END
$kind$;

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
  v_expense_id uuid := pg_catalog.gen_random_uuid();
  v_snapshot_id uuid;
  v_snapshot abos.exchange_rate_snapshots%ROWTYPE;
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
  IF NOT EXISTS (
    SELECT 1 FROM abos.accounting_periods period
     WHERE period.legal_entity_id = v_entity_id AND period.status = 'OPEN'
       AND v_business_date BETWEEN period.starts_on AND period.ends_on
  ) THEN
    RAISE EXCEPTION 'an open accounting period must cover the expense date'
      USING ERRCODE = 'check_violation';
  END IF;
  -- The route is fixed now: the latest policy version at creation is stored with the expense and
  -- a later policy change never re-routes it.
  SELECT * INTO v_policy FROM abos.finance_workflow_policy_versions policy
   WHERE policy.legal_entity_id = v_entity_id AND policy.workflow_type = abos.expense_workflow_type(v_payment_kind)
   ORDER BY policy.version DESC LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'expense approval policy is not configured for this legal entity'
      USING ERRCODE = 'check_violation';
  END IF;

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
     v_base_currency, v_policy.id, v_policy.approval_required, v_correlation_id,
     v_request_key, v_fingerprint, 'DRAFT', 1, v_actor_id, v_payment_kind);

  IF v_currency = v_base_currency THEN
    v_base_amount := v_original_amount;
  ELSE
    -- Only that business date's current rate (the user's choice when several exist); never another
    -- day's rate and never a fallback.
    v_snapshot_id := abos.capture_exchange_rate_snapshot(
      v_entity_id, 'OPERATIONAL_EXPENSE', v_expense_id, v_currency,
      v_business_date, v_exchange_rate_id, v_actor_id);
    SELECT * INTO v_snapshot FROM abos.exchange_rate_snapshots snapshot
     WHERE snapshot.id = v_snapshot_id;
    -- Exact-only conversion (design addendum): no rounding policy is approved, so a result that
    -- is not exact is refused. trim_scale removes only trailing zeros; the value is unchanged.
    IF v_snapshot.unit_currency_code = v_currency
       AND v_snapshot.quote_currency_code = v_base_currency THEN
      v_base_amount := pg_catalog.trim_scale(v_original_amount * v_snapshot.rate_value);
    ELSIF v_snapshot.quote_currency_code = v_currency
       AND v_snapshot.unit_currency_code = v_base_currency THEN
      v_base_amount := pg_catalog.trim_scale(v_original_amount / v_snapshot.rate_value);
      IF v_base_amount * v_snapshot.rate_value <> v_original_amount THEN
        RAISE EXCEPTION 'inverse rate result is not exact; rounding policy is not approved'
          USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      RAISE EXCEPTION 'selected exchange rate does not match the expense currencies'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  v_route := CASE WHEN v_policy.approval_required THEN 'PENDING_APPROVAL' ELSE 'VALIDATED' END;
  UPDATE abos.operational_expenses
     SET base_amount = v_base_amount, exchange_rate_snapshot_id = v_snapshot_id,
         status = v_route, version = 2, updated_at = pg_catalog.clock_timestamp()
   WHERE id = v_expense_id;
  -- Approval OFF: post in this same transaction; no approval row is written.
  IF NOT v_policy.approval_required THEN
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
       'approvalRequired', v_policy.approval_required,
       'policyVersionId', v_policy.id));
  RETURN v_response;
END
$function$;

CREATE OR REPLACE FUNCTION abos.guard_operational_expense()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'operational expenses are permanent records' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' OR NEW.version <> 1 OR NEW.journal_id IS NOT NULL THEN
      RAISE EXCEPTION 'an operational expense starts as DRAFT version 1 without a journal'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'POSTED' THEN
    RAISE EXCEPTION 'a posted operational expense is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.id, NEW.legal_entity_id, NEW.operational_treasury_account_id,
      NEW.operational_expense_category_id, NEW.payee_business_party_id,
      NEW.project_id, NEW.department_id, NEW.cost_center_id, NEW.reference,
      NEW.description, NEW.note, NEW.business_date, NEW.original_amount,
      NEW.original_currency_code, NEW.base_currency_code, NEW.workflow_policy_version_id,
      NEW.approval_required, NEW.correlation_id, NEW.idempotency_key,
      NEW.request_fingerprint, NEW.created_by_user_account_id, NEW.created_at, NEW.payment_kind)
     IS DISTINCT FROM
     (OLD.id, OLD.legal_entity_id, OLD.operational_treasury_account_id,
      OLD.operational_expense_category_id, OLD.payee_business_party_id,
      OLD.project_id, OLD.department_id, OLD.cost_center_id, OLD.reference,
      OLD.description, OLD.note, OLD.business_date, OLD.original_amount,
      OLD.original_currency_code, OLD.base_currency_code, OLD.workflow_policy_version_id,
      OLD.approval_required, OLD.correlation_id, OLD.idempotency_key,
      OLD.request_fingerprint, OLD.created_by_user_account_id, OLD.created_at, OLD.payment_kind) THEN
    RAISE EXCEPTION 'the accounting identity of an operational expense cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.exchange_rate_snapshot_id IS NOT NULL
     AND NEW.exchange_rate_snapshot_id IS DISTINCT FROM OLD.exchange_rate_snapshot_id THEN
    RAISE EXCEPTION 'the expense exchange-rate snapshot is immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.base_amount IS NOT NULL AND NEW.base_amount IS DISTINCT FROM OLD.base_amount THEN
    RAISE EXCEPTION 'the expense base amount is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.version <> OLD.version + 1 OR NEW.updated_at <= OLD.updated_at THEN
    RAISE EXCEPTION 'an expense transition must advance its version and update time'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT ((OLD.status = 'DRAFT' AND NEW.status IN ('PENDING_APPROVAL', 'VALIDATED'))
       OR (OLD.status IN ('PENDING_APPROVAL', 'VALIDATED') AND NEW.status = 'POSTED')) THEN
    RAISE EXCEPTION 'invalid operational expense transition % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION abos.validate_expense_journal(p_journal abos.journals, p_intent abos.posting_intents)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  expense_row abos.operational_expenses%ROWTYPE;
  treasury_row abos.operational_treasury_accounts%ROWTYPE;
  category_row abos.operational_expense_categories%ROWTYPE;
  policy_row abos.finance_workflow_policy_versions%ROWTYPE;
  snapshot_row abos.exchange_rate_snapshots%ROWTYPE;
  approval_count bigint;
  treasury_subledger_count bigint;
BEGIN
  IF p_intent.intent_kind <> 'EXPENSE' OR p_intent.base_amount IS NULL THEN
    RAISE EXCEPTION 'operational posting requires a posted valued EXPENSE intent'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO expense_row FROM abos.operational_expenses
   WHERE id = p_intent.operational_expense_id AND legal_entity_id = p_journal.legal_entity_id;
  IF NOT FOUND OR expense_row.id IS DISTINCT FROM p_intent.source_id
     OR expense_row.status <> 'POSTED' OR expense_row.journal_id IS DISTINCT FROM p_journal.id
     OR expense_row.original_amount IS DISTINCT FROM p_intent.original_amount
     OR expense_row.original_currency_code IS DISTINCT FROM p_intent.original_currency_code
     OR expense_row.base_amount IS DISTINCT FROM p_intent.base_amount
     OR expense_row.base_currency_code IS DISTINCT FROM p_intent.base_currency_code
     OR expense_row.business_date IS DISTINCT FROM p_journal.accounting_effective_date THEN
    RAISE EXCEPTION 'operational expense, intent and journal do not agree'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO policy_row FROM abos.finance_workflow_policy_versions
   WHERE id = expense_row.workflow_policy_version_id
     AND legal_entity_id = p_journal.legal_entity_id AND workflow_type = abos.expense_workflow_type(expense_row.payment_kind);
  IF NOT FOUND OR policy_row.approval_required IS DISTINCT FROM expense_row.approval_required THEN
    RAISE EXCEPTION 'operational expense approval route does not match its immutable policy snapshot'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*) INTO approval_count FROM abos.operational_expense_approvals approval
   WHERE approval.operational_expense_id = expense_row.id
     AND approval.legal_entity_id = p_journal.legal_entity_id
     AND approval.decision = 'APPROVED'
     AND approval.approver_user_account_id = p_journal.posted_by_user_account_id;
  IF expense_row.approval_required THEN
    IF approval_count <> 1
       OR p_journal.posted_by_user_account_id = expense_row.created_by_user_account_id THEN
      RAISE EXCEPTION 'approval-required expense must be posted by its independent approver'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF approval_count <> 0
        OR p_journal.posted_by_user_account_id IS DISTINCT FROM expense_row.created_by_user_account_id THEN
    RAISE EXCEPTION 'direct-posting expense must have no approval and be posted by its creator'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO treasury_row FROM abos.operational_treasury_accounts
   WHERE id = expense_row.operational_treasury_account_id
     AND legal_entity_id = p_journal.legal_entity_id AND status = 'ACTIVE';
  SELECT * INTO category_row FROM abos.operational_expense_categories
   WHERE id = expense_row.operational_expense_category_id
     AND legal_entity_id = p_journal.legal_entity_id AND status = 'ACTIVE';
  IF treasury_row.id IS NULL OR category_row.id IS NULL
     OR treasury_row.currency_code <> expense_row.original_currency_code THEN
    RAISE EXCEPTION 'expense requires active same-entity Treasury and category mappings'
      USING ERRCODE = 'check_violation';
  END IF;

  IF expense_row.original_currency_code = expense_row.base_currency_code THEN
    IF expense_row.exchange_rate_snapshot_id IS NOT NULL
       OR expense_row.base_amount <> expense_row.original_amount THEN
      RAISE EXCEPTION 'base-currency expense must retain the same amount without an FX snapshot'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    SELECT * INTO snapshot_row FROM abos.exchange_rate_snapshots
     WHERE id = expense_row.exchange_rate_snapshot_id
       AND legal_entity_id = p_journal.legal_entity_id
       AND source_type = 'OPERATIONAL_EXPENSE' AND source_id = expense_row.id;
    IF NOT FOUND OR snapshot_row.transaction_currency_code <> expense_row.original_currency_code
       OR snapshot_row.base_currency_code <> expense_row.base_currency_code
       OR snapshot_row.rate_date <> expense_row.business_date
       OR p_intent.conversion_snapshot_reference IS DISTINCT FROM snapshot_row.id::text THEN
      RAISE EXCEPTION 'foreign-currency expense requires its exact immutable rate snapshot'
        USING ERRCODE = 'check_violation';
    END IF;
    IF snapshot_row.unit_currency_code = expense_row.original_currency_code
       AND snapshot_row.quote_currency_code = expense_row.base_currency_code THEN
      IF expense_row.base_amount <> expense_row.original_amount * snapshot_row.rate_value THEN
        RAISE EXCEPTION 'expense base amount does not exactly follow its direct rate'
          USING ERRCODE = 'check_violation';
      END IF;
    ELSIF snapshot_row.quote_currency_code = expense_row.original_currency_code
       AND snapshot_row.unit_currency_code = expense_row.base_currency_code THEN
      IF expense_row.base_amount * snapshot_row.rate_value <> expense_row.original_amount THEN
        RAISE EXCEPTION 'inverse rate requires an exact result; rounding policy is not approved'
          USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      RAISE EXCEPTION 'snapshot currency direction does not match the expense'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM abos.journal_lines line
              WHERE line.journal_id = p_journal.id AND line.original_amount <> expense_row.original_amount) THEN
    RAISE EXCEPTION 'operational journal line violates entity, currency, account or dimension rules'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM abos.journal_lines line WHERE line.journal_id = p_journal.id
      AND line.line_number = 1 AND line.ledger_account_id = category_row.ledger_account_id
      AND line.base_debit = expense_row.base_amount AND line.base_credit = 0
      AND line.project_id IS NOT DISTINCT FROM expense_row.project_id
      AND line.department_id IS NOT DISTINCT FROM expense_row.department_id
      AND line.cost_center_id IS NOT DISTINCT FROM expense_row.cost_center_id
      AND line.business_party_id IS NOT DISTINCT FROM expense_row.payee_business_party_id
  ) OR NOT EXISTS (
    SELECT 1 FROM abos.journal_lines line WHERE line.journal_id = p_journal.id
      AND line.line_number = 2 AND line.ledger_account_id = treasury_row.ledger_account_id
      AND line.base_debit = 0 AND line.base_credit = expense_row.base_amount
      AND line.project_id IS NOT DISTINCT FROM expense_row.project_id
      AND line.department_id IS NOT DISTINCT FROM expense_row.department_id
      AND line.cost_center_id IS NOT DISTINCT FROM expense_row.cost_center_id
      AND line.business_party_id IS NULL
  ) THEN
    RAISE EXCEPTION 'expense journal must debit its category and credit its Treasury mapping'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*) INTO treasury_subledger_count
    FROM abos.subledger_entries entry
    JOIN abos.journal_lines line ON line.id = entry.journal_line_id
   WHERE line.journal_id = p_journal.id
     AND entry.subledger_type = 'OPERATIONAL_TREASURY'
     AND entry.operational_treasury_account_id = treasury_row.id
     AND entry.original_amount = -expense_row.original_amount
     AND entry.base_amount = -expense_row.base_amount;
  IF treasury_subledger_count <> 1 OR EXISTS (
    SELECT 1 FROM abos.subledger_entries entry
    JOIN abos.journal_lines line ON line.id = entry.journal_line_id
    WHERE line.journal_id = p_journal.id AND (entry.subledger_type <> 'OPERATIONAL_TREASURY' OR line.line_number <> 2)
  ) THEN
    RAISE EXCEPTION 'expense journal requires exactly one matching Treasury subledger movement'
      USING ERRCODE = 'check_violation';
  END IF;
END
$function$;

CREATE OR REPLACE FUNCTION abos.operational_expense_json(p_expense_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT pg_catalog.jsonb_build_object(
    'id', expense.id,
    'legalEntityId', expense.legal_entity_id,
    'treasuryAccountId', expense.operational_treasury_account_id,
    'treasuryAccountNameEn', treasury.name_en,
    'treasuryAccountNameFa', treasury.name_fa,
    'expenseCategoryId', expense.operational_expense_category_id,
    'expenseCategoryCode', category.category_code,
    'expenseCategoryNameEn', category.name_en,
    'expenseCategoryNameFa', category.name_fa,
    'payeeBusinessPartyId', expense.payee_business_party_id,
    'payeeName', payee.display_name,
    'projectId', expense.project_id,
    'departmentId', expense.department_id,
    'costCenterId', expense.cost_center_id,
    'reference', expense.reference,
    'description', expense.description,
    'note', expense.note,
    'businessDate', expense.business_date,
    'originalAmount', expense.original_amount::text,
    'originalCurrency', expense.original_currency_code,
    'baseAmount', expense.base_amount::text,
    'baseCurrency', expense.base_currency_code,
    'exchangeRateSnapshot', CASE WHEN snapshot.id IS NULL THEN NULL ELSE
      pg_catalog.jsonb_build_object(
        'id', snapshot.id, 'exchangeRateId', snapshot.exchange_rate_id,
        'rateDate', snapshot.rate_date, 'rateSource', snapshot.rate_source,
        'unitCurrency', snapshot.unit_currency_code,
        'quoteCurrency', snapshot.quote_currency_code,
        'rate', snapshot.rate_value::text) END,
    'workflowPolicyVersionId', expense.workflow_policy_version_id,
    'approvalRequired', expense.approval_required,
    'status', expense.status,
    'version', expense.version,
    'journalId', expense.journal_id,
    'createdBy', creator.display_name,
    'createdAt', expense.created_at,
    'updatedAt', expense.updated_at,
    'approval', CASE WHEN approval.id IS NULL THEN NULL ELSE
      pg_catalog.jsonb_build_object(
        'id', approval.id, 'decision', approval.decision,
        'note', approval.decision_note, 'approvedAt', approval.approved_at,
        'approvedBy', approver.display_name) END)
    || CASE WHEN expense.payment_kind IS NULL THEN '{}'::jsonb ELSE pg_catalog.jsonb_build_object('paymentKind', expense.payment_kind) END
  FROM abos.operational_expenses expense
  JOIN abos.operational_treasury_accounts treasury
    ON treasury.id = expense.operational_treasury_account_id
  JOIN abos.operational_expense_categories category
    ON category.id = expense.operational_expense_category_id
  JOIN abos.user_accounts creator ON creator.id = expense.created_by_user_account_id
  LEFT JOIN abos.business_parties payee ON payee.id = expense.payee_business_party_id
  LEFT JOIN abos.exchange_rate_snapshots snapshot ON snapshot.id = expense.exchange_rate_snapshot_id
  LEFT JOIN abos.operational_expense_approvals approval
    ON approval.operational_expense_id = expense.id
  LEFT JOIN abos.user_accounts approver ON approver.id = approval.approver_user_account_id
  WHERE expense.id = p_expense_id
$function$;

REVOKE ALL ON FUNCTION abos.expense_workflow_type(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION abos.expense_workflow_type(text) TO abos_v1_operational_finance_owner;
GRANT SELECT (payment_kind), INSERT (payment_kind) ON abos.operational_expenses TO abos_v1_operational_finance_owner;
