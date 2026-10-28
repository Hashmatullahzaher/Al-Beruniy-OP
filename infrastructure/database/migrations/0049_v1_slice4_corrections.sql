-- 0049: Slice 4 corrections before production (owner decisions of 2026-10-28).
--
-- 1. Sufficient funds. A Safe, cash box or petty-cash account can never go below zero; a Saraf account
--    may (a negative net position is an amount owed to the Saraf). The check runs inside PostgreSQL when
--    any operational journal posts (expense, payment, transfer, temporary-funding repayment, ...), under a
--    row lock on the Treasury account, from posted movements only. There is no stored balance.
-- 2. Simple Mode default. A workflow without a saved approval setting records in one save (approval OFF).
--    The policy reference on the record is NULL in that case. An explicit setting is never weakened.
--    An expense needs approval when either its EXPENSE setting or its payment kind's setting is ON.
-- 3. Approval ON cannot be saved for a workflow whose lane has no approval path yet (other income,
--    transfers, supplier and salary payments, customer receipts); it is shown as unavailable until
--    Advanced Controls exist. Turning a setting OFF is always possible. Shareholder capital keeps its
--    0039 behaviour: ON routes it to the Capital Requests approval lane.
--
-- No row is written or changed by this migration, no journal is created and no balance is stored.

-- ---------------------------------------------------------------------------------------------
-- 1. A missing setting is recorded as a NULL policy reference (Simple Mode default, approval OFF).
-- ---------------------------------------------------------------------------------------------
ALTER TABLE abos.treasury_cash_receipts ALTER COLUMN workflow_policy_version_id DROP NOT NULL;
ALTER TABLE abos.treasury_transfers ALTER COLUMN workflow_policy_version_id DROP NOT NULL;
ALTER TABLE abos.treasury_payments ALTER COLUMN workflow_policy_version_id DROP NOT NULL;
ALTER TABLE abos.operational_expenses ALTER COLUMN workflow_policy_version_id DROP NOT NULL;

-- True when a record that carries p_version may post without approval: the referenced setting is the
-- company's OFF setting for that workflow, or there is no reference and no setting requires approval.
CREATE FUNCTION abos.workflow_policy_allows_direct(p_entity uuid, p_workflow_types text[], p_version uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $direct$
  SELECT CASE WHEN p_version IS NULL THEN NOT EXISTS (
      SELECT 1 FROM unnest(p_workflow_types) t(workflow_type)
       CROSS JOIN LATERAL (SELECT v.approval_required FROM abos.finance_workflow_policy_versions v
         WHERE v.legal_entity_id = p_entity AND v.workflow_type = t.workflow_type ORDER BY v.version DESC LIMIT 1) latest
       WHERE latest.approval_required)
    ELSE EXISTS (SELECT 1 FROM abos.finance_workflow_policy_versions v WHERE v.id = p_version AND v.legal_entity_id = p_entity
      AND v.workflow_type = ANY (p_workflow_types) AND NOT v.approval_required) END
$direct$;

-- Workflows whose lane has an approval (pending and confirm) path today. ON is refused for the others.
CREATE FUNCTION abos.finance_workflow_approval_available(p_workflow_type text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $available$
  SELECT p_workflow_type IN ('CHART_OF_ACCOUNTS', 'SHAREHOLDER_CAPITAL_RECEIPT', 'EXPENSE', 'TEMPORARY_FUNDING')
$available$;

-- ---------------------------------------------------------------------------------------------
-- 2. Sufficient funds for cash-like Treasury accounts, checked when a journal posts.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION abos.treasury_require_funds(p_journal abos.journals)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $funds$
DECLARE v_out record; v_account abos.operational_treasury_accounts%ROWTYPE; v_low numeric;
BEGIN
  FOR v_out IN
    SELECT entry.operational_treasury_account_id AS id
      FROM abos.subledger_entries entry JOIN abos.journal_lines line ON line.id = entry.journal_line_id
     WHERE line.journal_id = p_journal.id AND entry.subledger_type = 'OPERATIONAL_TREASURY'
     GROUP BY entry.operational_treasury_account_id HAVING sum(entry.original_amount) < 0
     ORDER BY entry.operational_treasury_account_id
  LOOP
    SELECT * INTO v_account FROM abos.operational_treasury_accounts
     WHERE id = v_out.id AND legal_entity_id = p_journal.legal_entity_id;
    CONTINUE WHEN NOT FOUND OR v_account.account_type NOT IN ('SAFE', 'CASH_BOX', 'PETTY_CASH');
    -- One posting at a time takes money out of an account: a concurrent spender waits here, and its next
    -- statement sees the first one's committed movement. NO KEY UPDATE leaves the key-share locks that
    -- source rows hold on the account untouched, so recording stays concurrent; only spending queues.
    PERFORM 1 FROM abos.operational_treasury_accounts WHERE id = v_account.id FOR NO KEY UPDATE;
    -- The lowest balance from this movement's date onward, counting posted movements exactly as the
    -- Treasury read model does (0045) plus this journal: a backdated spend cannot overdraw either.
    SELECT min(running) INTO v_low FROM (
      SELECT movement.effective_date, sum(sum(movement.amount)) OVER (ORDER BY movement.effective_date) AS running
        FROM (SELECT entry.original_amount AS amount, journal.accounting_effective_date AS effective_date
                FROM abos.subledger_entries entry
                JOIN abos.journal_lines line ON line.id = entry.journal_line_id
                JOIN abos.journals journal ON journal.id = line.journal_id
               WHERE entry.subledger_type = 'OPERATIONAL_TREASURY' AND entry.operational_treasury_account_id = v_account.id
                 AND entry.legal_entity_id = v_account.legal_entity_id
                 AND (journal.status = 'POSTED' OR journal.id = p_journal.id)) movement
       GROUP BY movement.effective_date) balance
     WHERE balance.effective_date >= p_journal.accounting_effective_date;
    IF v_low < 0 THEN
      RAISE EXCEPTION 'not enough money in % for this movement: its balance would fall below zero', v_account.name_en
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
END
$funds$;


-- ---------------------------------------------------------------------------------------------
-- 3. Restated functions (0047/0048 definitions with the 0049 changes above).
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION abos.money_movement_policy(p_entity uuid, p_workflow_type text)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE v_policy abos.finance_workflow_policy_versions%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('abos-finance-workflow-policy:' || p_entity::text || ':' || p_workflow_type, 0));
  SELECT * INTO v_policy FROM abos.finance_workflow_policy_versions
   WHERE legal_entity_id = p_entity AND workflow_type = p_workflow_type ORDER BY version DESC LIMIT 1;
  -- 0049 Simple Mode: no saved setting means approval OFF, recorded as a NULL policy reference.
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF v_policy.approval_required THEN
    RAISE EXCEPTION 'the % setting requires approval, which is not available for this movement yet', p_workflow_type
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN v_policy.id;
END
$function$;

CREATE OR REPLACE FUNCTION abos.validate_cash_receipt_journal(p_journal abos.journals, p_intent abos.posting_intents)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE r abos.treasury_cash_receipts%ROWTYPE; v_account abos.operational_treasury_accounts%ROWTYPE;
BEGIN
  SELECT * INTO r FROM abos.treasury_cash_receipts WHERE id = p_intent.source_id AND legal_entity_id = p_journal.legal_entity_id;
  IF NOT FOUND OR r.journal_id <> p_journal.id OR p_intent.intent_kind <> 'CASH_RECEIPT' OR p_intent.treasury_receipt_id IS DISTINCT FROM r.id
     OR p_intent.original_amount <> r.amount OR p_intent.base_amount <> r.amount OR p_intent.original_currency_code <> r.currency_code
     OR r.business_date <> p_journal.accounting_effective_date OR p_journal.journal_reference <> r.transaction_reference
     OR p_journal.posted_by_user_account_id IS DISTINCT FROM r.created_by_user_account_id
     OR p_intent.created_by_user_account_id <> r.created_by_user_account_id
     OR p_intent.finance_workflow_policy_version_id IS DISTINCT FROM r.workflow_policy_version_id
     OR NOT abos.workflow_policy_allows_direct(r.legal_entity_id, ARRAY['OTHER_INCOME'], r.workflow_policy_version_id) THEN
    RAISE EXCEPTION 'cash receipt journal does not match its source, amount, date, reference, policy or recorder' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_account FROM abos.operational_treasury_accounts WHERE id = r.operational_treasury_account_id
     AND legal_entity_id = r.legal_entity_id AND status = 'ACTIVE';
  IF NOT FOUND THEN RAISE EXCEPTION 'a cash receipt posts only to an active Safe or Saraf account' USING ERRCODE = 'check_violation'; END IF;
  IF NOT EXISTS (SELECT 1 FROM abos.journal_lines l WHERE l.journal_id = p_journal.id AND l.line_number = 1
       AND l.ledger_account_id = v_account.ledger_account_id AND l.base_debit = r.amount AND l.business_party_id IS NULL
       AND l.project_id IS NULL AND l.department_id IS NULL AND l.cost_center_id IS NULL)
     OR NOT EXISTS (SELECT 1 FROM abos.journal_lines l WHERE l.journal_id = p_journal.id AND l.line_number = 2
       AND l.ledger_account_id = r.revenue_ledger_account_id AND l.base_credit = r.amount
       AND l.business_party_id IS NOT DISTINCT FROM r.payer_business_party_id
       AND l.project_id IS NULL AND l.department_id IS NULL AND l.cost_center_id IS NULL) THEN
    RAISE EXCEPTION 'a cash receipt must debit its Treasury account and credit its income account' USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT count(*) FROM abos.subledger_entries e JOIN abos.journal_lines l ON l.id = e.journal_line_id WHERE l.journal_id = p_journal.id) <> 1
     OR NOT EXISTS (SELECT 1 FROM abos.subledger_entries e JOIN abos.journal_lines l ON l.id = e.journal_line_id
       WHERE l.journal_id = p_journal.id AND l.line_number = 1 AND e.subledger_type = 'OPERATIONAL_TREASURY'
         AND e.operational_treasury_account_id = v_account.id AND e.base_amount = r.amount AND e.original_amount = r.amount) THEN
    RAISE EXCEPTION 'a cash receipt requires exactly its Treasury inflow' USING ERRCODE = 'check_violation';
  END IF;
END
$function$;

CREATE OR REPLACE FUNCTION abos.validate_treasury_transfer_journal(p_journal abos.journals, p_intent abos.posting_intents)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE t abos.treasury_transfers%ROWTYPE; v_source abos.operational_treasury_accounts%ROWTYPE; v_destination abos.operational_treasury_accounts%ROWTYPE;
BEGIN
  SELECT * INTO t FROM abos.treasury_transfers WHERE id = p_intent.source_id AND legal_entity_id = p_journal.legal_entity_id;
  IF NOT FOUND OR t.journal_id <> p_journal.id OR p_intent.intent_kind <> 'TREASURY_TRANSFER' OR p_intent.treasury_transfer_id IS DISTINCT FROM t.id
     OR p_intent.original_amount <> t.amount OR p_intent.base_amount <> t.amount OR p_intent.original_currency_code <> t.currency_code
     OR t.business_date <> p_journal.accounting_effective_date OR p_journal.journal_reference <> t.transaction_reference
     OR p_journal.posted_by_user_account_id IS DISTINCT FROM t.created_by_user_account_id
     OR p_intent.created_by_user_account_id <> t.created_by_user_account_id
     OR p_intent.finance_workflow_policy_version_id IS DISTINCT FROM t.workflow_policy_version_id
     OR NOT abos.workflow_policy_allows_direct(t.legal_entity_id, ARRAY['TREASURY_TRANSFER'], t.workflow_policy_version_id) THEN
    RAISE EXCEPTION 'transfer journal does not match its source, amount, date, reference, policy or recorder' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_source FROM abos.operational_treasury_accounts WHERE id = t.source_treasury_account_id AND legal_entity_id = t.legal_entity_id AND status = 'ACTIVE';
  SELECT * INTO v_destination FROM abos.operational_treasury_accounts WHERE id = t.destination_treasury_account_id AND legal_entity_id = t.legal_entity_id AND status = 'ACTIVE';
  IF v_source.id IS NULL OR v_destination.id IS NULL THEN
    RAISE EXCEPTION 'a transfer posts only between active Safe or Saraf accounts' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM abos.journal_lines l WHERE l.journal_id = p_journal.id AND l.line_number = 1
       AND l.ledger_account_id = v_destination.ledger_account_id AND l.base_debit = t.amount AND l.business_party_id IS NULL
       AND l.project_id IS NULL AND l.department_id IS NULL AND l.cost_center_id IS NULL)
     OR NOT EXISTS (SELECT 1 FROM abos.journal_lines l WHERE l.journal_id = p_journal.id AND l.line_number = 2
       AND l.ledger_account_id = v_source.ledger_account_id AND l.base_credit = t.amount AND l.business_party_id IS NULL
       AND l.project_id IS NULL AND l.department_id IS NULL AND l.cost_center_id IS NULL) THEN
    RAISE EXCEPTION 'a transfer must debit its destination and credit its source' USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT count(*) FROM abos.subledger_entries e JOIN abos.journal_lines l ON l.id = e.journal_line_id WHERE l.journal_id = p_journal.id) <> 2
     OR NOT EXISTS (SELECT 1 FROM abos.subledger_entries e JOIN abos.journal_lines l ON l.id = e.journal_line_id
       WHERE l.journal_id = p_journal.id AND l.line_number = 1 AND e.subledger_type = 'OPERATIONAL_TREASURY'
         AND e.operational_treasury_account_id = v_destination.id AND e.base_amount = t.amount AND e.original_amount = t.amount)
     OR NOT EXISTS (SELECT 1 FROM abos.subledger_entries e JOIN abos.journal_lines l ON l.id = e.journal_line_id
       WHERE l.journal_id = p_journal.id AND l.line_number = 2 AND e.subledger_type = 'OPERATIONAL_TREASURY'
         AND e.operational_treasury_account_id = v_source.id AND e.base_amount = -t.amount AND e.original_amount = -t.amount) THEN
    RAISE EXCEPTION 'a transfer requires exactly its destination inflow and source outflow' USING ERRCODE = 'check_violation';
  END IF;
END
$function$;

CREATE OR REPLACE FUNCTION abos.validate_payment_journal(p_journal abos.journals, p_intent abos.posting_intents)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE p abos.treasury_payments%ROWTYPE; v_account abos.operational_treasury_accounts%ROWTYPE;
BEGIN
  SELECT * INTO p FROM abos.treasury_payments WHERE id = p_intent.source_id AND legal_entity_id = p_journal.legal_entity_id;
  IF NOT FOUND OR p.journal_id <> p_journal.id OR p_intent.intent_kind <> 'PAYMENT' OR p_intent.treasury_payment_id IS DISTINCT FROM p.id
     OR p_intent.original_amount <> p.amount OR p_intent.base_amount <> p.amount OR p_intent.original_currency_code <> p.currency_code
     OR p.business_date <> p_journal.accounting_effective_date OR p_journal.journal_reference <> p.transaction_reference
     OR p_journal.posted_by_user_account_id IS DISTINCT FROM p.created_by_user_account_id
     OR p_intent.created_by_user_account_id <> p.created_by_user_account_id
     OR p_intent.finance_workflow_policy_version_id IS DISTINCT FROM p.workflow_policy_version_id
     OR NOT abos.workflow_policy_allows_direct(p.legal_entity_id,
          ARRAY[CASE p.payment_kind WHEN 'SALARY' THEN 'SALARY_PAYMENT' ELSE 'SUPPLIER_PAYMENT' END], p.workflow_policy_version_id) THEN
    RAISE EXCEPTION 'payment journal does not match its source, amount, date, reference, policy or recorder' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_account FROM abos.operational_treasury_accounts WHERE id = p.operational_treasury_account_id
     AND legal_entity_id = p.legal_entity_id AND status = 'ACTIVE';
  IF NOT FOUND THEN RAISE EXCEPTION 'a payment posts only from an active Safe or Saraf account' USING ERRCODE = 'check_violation'; END IF;
  IF p.payee_business_party_id IS NULL AND EXISTS (SELECT 1 FROM abos.ledger_accounts a WHERE a.id = p.payable_ledger_account_id
       AND a.control_account_type = 'AP') THEN
    RAISE EXCEPTION 'a payment against accounts payable needs the person or organization it was owed to' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM abos.journal_lines l WHERE l.journal_id = p_journal.id AND l.line_number = 1
       AND l.ledger_account_id = p.payable_ledger_account_id AND l.base_debit = p.amount
       AND l.business_party_id IS NOT DISTINCT FROM p.payee_business_party_id
       AND l.project_id IS NULL AND l.department_id IS NULL AND l.cost_center_id IS NULL)
     OR NOT EXISTS (SELECT 1 FROM abos.journal_lines l WHERE l.journal_id = p_journal.id AND l.line_number = 2
       AND l.ledger_account_id = v_account.ledger_account_id AND l.base_credit = p.amount AND l.business_party_id IS NULL
       AND l.project_id IS NULL AND l.department_id IS NULL AND l.cost_center_id IS NULL) THEN
    RAISE EXCEPTION 'a payment must debit its payable and credit its Treasury account' USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT count(*) FROM abos.subledger_entries e JOIN abos.journal_lines l ON l.id = e.journal_line_id WHERE l.journal_id = p_journal.id) <> 1
     OR NOT EXISTS (SELECT 1 FROM abos.subledger_entries e JOIN abos.journal_lines l ON l.id = e.journal_line_id
       WHERE l.journal_id = p_journal.id AND l.line_number = 2 AND e.subledger_type = 'OPERATIONAL_TREASURY'
         AND e.operational_treasury_account_id = v_account.id AND e.base_amount = -p.amount AND e.original_amount = -p.amount) THEN
    RAISE EXCEPTION 'a payment requires exactly its Treasury outflow' USING ERRCODE = 'check_violation';
  END IF;
END
$function$;

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

  -- 0049: the route came from the EXPENSE setting or the payment kind's setting; no reference is the
  -- Simple Mode default, valid only for a direct posting while no relevant setting requires approval.
  IF expense_row.workflow_policy_version_id IS NULL THEN
    IF expense_row.approval_required OR NOT abos.workflow_policy_allows_direct(p_journal.legal_entity_id,
         ARRAY['EXPENSE', abos.expense_workflow_type(expense_row.payment_kind)], NULL) THEN
      RAISE EXCEPTION 'operational expense approval route does not match its immutable policy snapshot'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    SELECT * INTO policy_row FROM abos.finance_workflow_policy_versions
     WHERE id = expense_row.workflow_policy_version_id AND legal_entity_id = p_journal.legal_entity_id
       AND workflow_type IN ('EXPENSE', abos.expense_workflow_type(expense_row.payment_kind));
    IF NOT FOUND OR policy_row.approval_required IS DISTINCT FROM expense_row.approval_required THEN
      RAISE EXCEPTION 'operational expense approval route does not match its immutable policy snapshot'
        USING ERRCODE = 'check_violation';
    END IF;
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
   WHERE period.legal_entity_id = v_entity_id AND period.status = 'OPEN'
     AND p_business_date BETWEEN period.starts_on AND period.ends_on;

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

CREATE OR REPLACE FUNCTION abos.treasury_money_options(p_proof text, p_runtime text, p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE c jsonb; actor uuid; entity uuid; perms jsonb; base text;
BEGIN
  c := abos.treasury_safe_actor(p_proof, p_runtime, p_token, NULL);
  actor := (c->>'userAccountId')::uuid; entity := (c->>'legalEntityId')::uuid;
  perms := COALESCE(c->'permissions', '[]'::jsonb);
  IF NOT (perms ?| ARRAY['treasury.receipt.record', 'treasury.transfer.record', 'treasury.payment.record']) THEN
    RAISE EXCEPTION 'current authority is missing treasury.receipt.record, treasury.transfer.record or treasury.payment.record'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT base_currency_code INTO base FROM abos.legal_entities WHERE id = entity AND currency_policy_status = 'APPROVED';
  RETURN jsonb_build_object(
    'baseCurrency', base, 'today', abos.business_today(),
    'canReceive', perms ? 'treasury.receipt.record', 'canTransfer', perms ? 'treasury.transfer.record', 'canPay', perms ? 'treasury.payment.record',
    'canRecordExpense', perms ? 'finance.expense.create',
    'settings', (SELECT jsonb_object_agg(t.workflow_type, CASE WHEN v.approval_required THEN 'APPROVAL_REQUIRED' ELSE 'READY' END)
      FROM unnest(ARRAY['OTHER_INCOME', 'TREASURY_TRANSFER', 'SUPPLIER_PAYMENT', 'SALARY_PAYMENT']) t(workflow_type)
      LEFT JOIN LATERAL (SELECT id, approval_required FROM abos.finance_workflow_policy_versions p WHERE p.legal_entity_id = entity
        AND p.workflow_type = t.workflow_type ORDER BY version DESC LIMIT 1) v ON true),
    'treasuryAccounts', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', a.id, 'nameEn', a.name_en, 'nameFa', a.name_fa,
        'accountType', a.account_type, 'currencyCode', a.currency_code) ORDER BY a.name_en, a.id)
      FROM abos.operational_treasury_accounts a WHERE a.legal_entity_id = entity AND a.status = 'ACTIVE'), '[]'::jsonb),
    'incomeAccounts', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', l.id, 'code', l.account_code, 'name', l.account_name) ORDER BY l.account_code)
      FROM abos.ledger_accounts l WHERE l.legal_entity_id = entity AND l.status = 'ACTIVE' AND l.posting_allowed AND l.account_type = 'REVENUE'
        AND l.control_account_type IS NULL AND l.account_currency_code IS NOT DISTINCT FROM base
        AND NOT l.requires_project AND NOT l.requires_department AND NOT l.requires_cost_center), '[]'::jsonb),
    'payableAccounts', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', l.id, 'code', l.account_code, 'name', l.account_name,
        'requiresParty', l.control_account_type IS NOT DISTINCT FROM 'AP') ORDER BY l.account_code)
      FROM abos.ledger_accounts l WHERE l.legal_entity_id = entity AND l.status = 'ACTIVE' AND l.posting_allowed AND l.account_type = 'LIABILITY'
        AND (l.control_account_type IS NULL OR l.control_account_type = 'AP') AND l.account_currency_code IS NOT DISTINCT FROM base
        AND NOT l.requires_project AND NOT l.requires_department AND NOT l.requires_cost_center), '[]'::jsonb),
    'parties', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', b.id, 'name', b.display_name) ORDER BY b.display_name, b.id)
      FROM abos.business_parties b WHERE b.legal_entity_id = entity AND b.status = 'ACTIVE'), '[]'::jsonb));
END
$function$;

CREATE OR REPLACE FUNCTION abos.posting_kernel_validate()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  v_intent abos.posting_intents%ROWTYPE;
  v_source abos.posting_sources%ROWTYPE;
  v_period record;
  v_base text;
  v_line_count bigint; v_debit numeric; v_credit numeric;
BEGIN
  -- Draft before post, and posted is immutable, for every operational journal (frozen lanes included).
  IF TG_OP = 'INSERT' AND NEW.status = 'POSTED' THEN
    RAISE EXCEPTION 'operational journals must be assembled as draft before posting'
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'POSTED' THEN
    RAISE EXCEPTION 'a posted operational journal is immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status <> 'POSTED' THEN RETURN NEW; END IF;

  SELECT * INTO v_intent FROM abos.posting_intents
   WHERE id = NEW.posting_intent_id AND legal_entity_id = NEW.legal_entity_id;
  IF NOT FOUND OR v_intent.processing_model <> 'OPERATIONAL_V1' THEN
    RAISE EXCEPTION 'operational posting requires its operational posting intent in the same legal entity'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_source FROM abos.posting_sources WHERE source_type = v_intent.source_type;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'operational posting source % is not registered', v_intent.source_type
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_source.status = 'FROZEN' THEN RETURN NEW; END IF;
  IF v_source.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'operational posting source % is not available yet', v_intent.source_type
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_intent.status <> 'POSTED' OR v_intent.base_amount IS NULL
     OR v_intent.base_currency_code IS DISTINCT FROM NEW.base_currency_code
     OR v_intent.accounting_effective_date IS DISTINCT FROM NEW.accounting_effective_date THEN
    RAISE EXCEPTION 'operational posting requires its posted intent with the journal''s currency and date'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT status, starts_on, ends_on INTO v_period FROM abos.accounting_periods
   WHERE id = NEW.accounting_period_id AND legal_entity_id = NEW.legal_entity_id;
  IF NOT FOUND OR v_period.status <> 'OPEN'
     OR NEW.accounting_effective_date NOT BETWEEN v_period.starts_on AND v_period.ends_on THEN
    RAISE EXCEPTION 'operational posting requires an open accounting period covering its date'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT base_currency_code INTO v_base FROM abos.legal_entities
   WHERE id = NEW.legal_entity_id AND currency_policy_status = 'APPROVED';
  IF v_base IS NULL OR v_base IS DISTINCT FROM NEW.base_currency_code THEN
    RAISE EXCEPTION 'operational posting requires the approved legal-entity base currency'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT count(*), coalesce(sum(base_debit), 0), coalesce(sum(base_credit), 0)
    INTO v_line_count, v_debit, v_credit FROM abos.journal_lines WHERE journal_id = NEW.id;
  IF v_line_count <> v_source.line_count OR v_debit <> v_credit OR v_debit <> v_intent.base_amount THEN
    RAISE EXCEPTION 'operational journal must contain exactly % lines balanced to its intent amount', v_source.line_count
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM abos.journal_lines line
    JOIN abos.ledger_accounts ledger ON ledger.id = line.ledger_account_id
     AND ledger.legal_entity_id = line.legal_entity_id
    WHERE line.journal_id = NEW.id AND (
      line.processing_model <> 'OPERATIONAL_V1'
      OR line.legal_entity_id <> NEW.legal_entity_id
      OR line.base_currency_code <> NEW.base_currency_code
      OR line.original_currency_code IS DISTINCT FROM v_intent.original_currency_code
      OR line.conversion_snapshot_reference IS DISTINCT FROM v_intent.conversion_snapshot_reference
      OR line.source_type <> v_intent.source_type OR line.source_id <> v_intent.source_id
      OR ledger.status <> 'ACTIVE' OR NOT ledger.posting_allowed
      OR (ledger.requires_project AND line.project_id IS NULL)
      OR (ledger.requires_department AND line.department_id IS NULL)
      OR (ledger.requires_cost_center AND line.cost_center_id IS NULL)
      OR NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(CASE WHEN line.base_debit > 0 THEN v_source.debit_rules ELSE v_source.credit_rules END) rule
         WHERE rule->>'accountType' = ledger.account_type
           AND (NOT rule ? 'control' OR ledger.control_account_type IS NOT DISTINCT FROM rule->>'control'))
    )) OR (SELECT count(*) FROM abos.journal_lines line
            JOIN abos.ledger_accounts ledger ON ledger.id = line.ledger_account_id AND ledger.legal_entity_id = line.legal_entity_id
           WHERE line.journal_id = NEW.id) <> v_line_count THEN
    RAISE EXCEPTION 'operational journal line violates entity, currency, account or dimension rules'
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM abos.subledger_entries entry
    JOIN abos.journal_lines line ON line.id = entry.journal_line_id
    WHERE line.journal_id = NEW.id AND (
      entry.processing_model <> 'OPERATIONAL_V1'
      OR entry.legal_entity_id <> NEW.legal_entity_id
      OR entry.source_type <> v_intent.source_type OR entry.source_id <> v_intent.source_id
      OR entry.original_currency_code IS DISTINCT FROM v_intent.original_currency_code
      OR entry.base_currency_code <> NEW.base_currency_code
      OR abs(entry.base_amount) <> greatest(line.base_debit, line.base_credit)
      OR abs(entry.original_amount) IS DISTINCT FROM line.original_amount
      -- 0045: one sign convention for every subledger - debit = positive, credit = negative.
      OR sign(entry.base_amount) <> CASE WHEN line.base_debit > 0 THEN 1 ELSE -1 END
      OR sign(entry.original_amount) <> CASE WHEN line.base_debit > 0 THEN 1 ELSE -1 END
      OR NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_source.subledger_rules) rule
         WHERE rule->>'type' = entry.subledger_type
           AND rule->>'side' = CASE WHEN line.base_debit > 0 THEN 'DEBIT' ELSE 'CREDIT' END)
    )) OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_source.subledger_rules) rule
     WHERE (rule->>'required')::boolean AND NOT EXISTS (
       SELECT 1 FROM abos.subledger_entries entry JOIN abos.journal_lines line ON line.id = entry.journal_line_id
        WHERE line.journal_id = NEW.id AND entry.subledger_type = rule->>'type'
          AND rule->>'side' = CASE WHEN line.base_debit > 0 THEN 'DEBIT' ELSE 'CREDIT' END)) THEN
    RAISE EXCEPTION 'operational subledger movement violates its source, currency, amount or registered shape'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Static dispatch: one small validator per source. An ACTIVE source without an arm fails closed.
  CASE v_source.source_type
    WHEN 'OPERATIONAL_EXPENSE' THEN PERFORM abos.validate_expense_journal(NEW, v_intent);
    WHEN 'DIRECT_SHAREHOLDER_CAPITAL' THEN PERFORM abos.validate_direct_shareholder_capital_journal(NEW, v_intent);
    WHEN 'TEMPORARY_FUNDING' THEN PERFORM abos.validate_temporary_funding_journal(NEW, v_intent);
    WHEN 'TEMPORARY_FUNDING_SETTLEMENT' THEN PERFORM abos.validate_temporary_funding_settlement_journal(NEW, v_intent);
    WHEN 'OPENING_BALANCE' THEN PERFORM abos.validate_opening_balance_journal(NEW, v_intent);
    WHEN 'CASH_RECEIPT' THEN PERFORM abos.validate_cash_receipt_journal(NEW, v_intent);
    WHEN 'TREASURY_TRANSFER' THEN PERFORM abos.validate_treasury_transfer_journal(NEW, v_intent);
    WHEN 'PAYMENT' THEN PERFORM abos.validate_payment_journal(NEW, v_intent);
    ELSE
      RAISE EXCEPTION 'operational posting source % has no validator', v_source.source_type
        USING ERRCODE = 'check_violation';
  END CASE;
  -- 0049: a Safe, cash box or petty-cash account never goes below zero, whichever lane posts.
  PERFORM abos.treasury_require_funds(NEW);
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION abos.finance_workflow_policy_set_command(p_identity_proof text, p_runtime_token_sha256 text, p_token_sha256 text, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
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
  -- 0049: ON is refused where the lane has no approval path yet, so no switch can make a workflow unusable.
  IF v_required AND NOT abos.finance_workflow_approval_available(v_type) THEN
    RAISE EXCEPTION 'approval is not available for % yet; it records in one save until Advanced Controls exist', v_type
      USING ERRCODE='check_violation';
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
   WHERE workflow.active;
  RETURN result;
END
$function$;

-- ---------------------------------------------------------------------------------------------
-- Privileges: the new helpers run with the caller's rights; only the owners that call them may.
-- ---------------------------------------------------------------------------------------------
REVOKE ALL ON FUNCTION abos.workflow_policy_allows_direct(uuid, text[], uuid), abos.finance_workflow_approval_available(text),
  abos.treasury_require_funds(abos.journals) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION abos.workflow_policy_allows_direct(uuid, text[], uuid), abos.treasury_require_funds(abos.journals)
  TO abos_v1_operational_finance_owner;
GRANT EXECUTE ON FUNCTION abos.finance_workflow_approval_available(text) TO abos_v1_workflow_policy_owner;
