-- Slice 4: basic money movements - receive cash, transfer, pay against a payable. Additive for data: no
-- existing row changes and nothing is seeded into a company.
--
-- One business event = one posting source. Three PLANNED registry sources become ACTIVE, each with its
-- own immutable source table, intent column, small validator (reached by the kernel's static dispatch)
-- and one SECURITY DEFINER writer posting through the posting kernel:
--   CASH_RECEIPT       Dr receiving Safe/Saraf   Cr income (REVENUE)          approval setting OTHER_INCOME
--   TREASURY_TRANSFER  Dr destination            Cr source                    approval setting TREASURY_TRANSFER
--   PAYMENT            Dr payable (LIABILITY)    Cr paying Safe/Saraf         SALARY_PAYMENT or SUPPLIER_PAYMENT
-- Simple Mode: a movement posts on Save when its approval setting is saved with approval OFF; when the
-- setting requires approval the writer refuses (no approval flow exists for these yet), so no setting is
-- bypassed. Base (accounting) currency only in this slice. Paying for an expense uses the expense lane
-- (0048), not PAYMENT.

-- ---------------------------------------------------------------------------------------------
-- 1. Source tables (immutable).
-- ---------------------------------------------------------------------------------------------

CREATE TABLE abos.treasury_cash_receipts (
  id uuid PRIMARY KEY,
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  operational_treasury_account_id uuid NOT NULL,
  currency_code text NOT NULL REFERENCES abos.currencies(code),
  amount numeric NOT NULL CHECK (amount > 0),
  business_date date NOT NULL,
  payer_business_party_id uuid,
  payer_name text CHECK (payer_name IS NULL OR length(btrim(payer_name)) BETWEEN 1 AND 200),
  revenue_ledger_account_id uuid NOT NULL,
  reference text CHECK (reference IS NULL OR length(btrim(reference)) BETWEEN 1 AND 120),
  note text CHECK (note IS NULL OR length(btrim(note)) BETWEEN 1 AND 1000),
  transaction_reference text NOT NULL UNIQUE,
  workflow_policy_version_id uuid NOT NULL REFERENCES abos.finance_workflow_policy_versions(id),
  journal_id uuid NOT NULL UNIQUE,
  created_by_user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  correlation_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  UNIQUE (id, legal_entity_id),
  CHECK (payer_business_party_id IS NOT NULL OR payer_name IS NOT NULL),
  FOREIGN KEY (operational_treasury_account_id, legal_entity_id, currency_code)
    REFERENCES abos.operational_treasury_accounts(id, legal_entity_id, currency_code),
  FOREIGN KEY (revenue_ledger_account_id, legal_entity_id) REFERENCES abos.ledger_accounts(id, legal_entity_id),
  FOREIGN KEY (payer_business_party_id, legal_entity_id) REFERENCES abos.business_parties(id, legal_entity_id)
);

CREATE TABLE abos.treasury_transfers (
  id uuid PRIMARY KEY,
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  source_treasury_account_id uuid NOT NULL,
  destination_treasury_account_id uuid NOT NULL,
  currency_code text NOT NULL REFERENCES abos.currencies(code),
  amount numeric NOT NULL CHECK (amount > 0),
  business_date date NOT NULL,
  reference text CHECK (reference IS NULL OR length(btrim(reference)) BETWEEN 1 AND 120),
  note text CHECK (note IS NULL OR length(btrim(note)) BETWEEN 1 AND 1000),
  transaction_reference text NOT NULL UNIQUE,
  workflow_policy_version_id uuid NOT NULL REFERENCES abos.finance_workflow_policy_versions(id),
  journal_id uuid NOT NULL UNIQUE,
  created_by_user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  correlation_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  UNIQUE (id, legal_entity_id),
  CHECK (source_treasury_account_id <> destination_treasury_account_id),
  FOREIGN KEY (source_treasury_account_id, legal_entity_id, currency_code)
    REFERENCES abos.operational_treasury_accounts(id, legal_entity_id, currency_code),
  FOREIGN KEY (destination_treasury_account_id, legal_entity_id, currency_code)
    REFERENCES abos.operational_treasury_accounts(id, legal_entity_id, currency_code)
);

CREATE TABLE abos.treasury_payments (
  id uuid PRIMARY KEY,
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  operational_treasury_account_id uuid NOT NULL,
  payment_kind text NOT NULL CHECK (payment_kind IN ('SUPPLIER', 'CONTRACTOR', 'SALARY', 'OTHER')),
  payee_business_party_id uuid,
  payee_name text CHECK (payee_name IS NULL OR length(btrim(payee_name)) BETWEEN 1 AND 200),
  payable_ledger_account_id uuid NOT NULL,
  currency_code text NOT NULL REFERENCES abos.currencies(code),
  amount numeric NOT NULL CHECK (amount > 0),
  business_date date NOT NULL,
  reference text CHECK (reference IS NULL OR length(btrim(reference)) BETWEEN 1 AND 120),
  note text CHECK (note IS NULL OR length(btrim(note)) BETWEEN 1 AND 1000),
  transaction_reference text NOT NULL UNIQUE,
  workflow_policy_version_id uuid NOT NULL REFERENCES abos.finance_workflow_policy_versions(id),
  journal_id uuid NOT NULL UNIQUE,
  created_by_user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  correlation_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  UNIQUE (id, legal_entity_id),
  CHECK (payee_business_party_id IS NOT NULL OR payee_name IS NOT NULL),
  FOREIGN KEY (operational_treasury_account_id, legal_entity_id, currency_code)
    REFERENCES abos.operational_treasury_accounts(id, legal_entity_id, currency_code),
  FOREIGN KEY (payable_ledger_account_id, legal_entity_id) REFERENCES abos.ledger_accounts(id, legal_entity_id),
  FOREIGN KEY (payee_business_party_id, legal_entity_id) REFERENCES abos.business_parties(id, legal_entity_id)
);

CREATE TRIGGER treasury_cash_receipts_no_update_or_delete BEFORE UPDATE OR DELETE ON abos.treasury_cash_receipts
FOR EACH ROW EXECUTE FUNCTION abos.prevent_audit_mutation();
CREATE TRIGGER treasury_transfers_no_update_or_delete BEFORE UPDATE OR DELETE ON abos.treasury_transfers
FOR EACH ROW EXECUTE FUNCTION abos.prevent_audit_mutation();
CREATE TRIGGER treasury_payments_no_update_or_delete BEFORE UPDATE OR DELETE ON abos.treasury_payments
FOR EACH ROW EXECUTE FUNCTION abos.prevent_audit_mutation();

COMMENT ON TABLE abos.treasury_cash_receipts IS 'Money received into a Safe or Saraf as other income (CASH_RECEIPT). Immutable; corrected by reversal.';
COMMENT ON TABLE abos.treasury_transfers IS 'Money moved between two Treasury accounts of the same currency (TREASURY_TRANSFER). Immutable; corrected by reversal.';
COMMENT ON TABLE abos.treasury_payments IS 'Money paid out of a Safe or Saraf against a payable (PAYMENT). Immutable; corrected by reversal.';

-- ---------------------------------------------------------------------------------------------
-- 2. Intent links and registry.
-- ---------------------------------------------------------------------------------------------

ALTER TABLE abos.posting_intents ADD COLUMN treasury_receipt_id uuid, ADD COLUMN treasury_transfer_id uuid,
  ADD COLUMN treasury_payment_id uuid;
ALTER TABLE abos.posting_intents
  ADD CONSTRAINT posting_intents_treasury_receipt_fkey FOREIGN KEY (treasury_receipt_id, legal_entity_id)
    REFERENCES abos.treasury_cash_receipts(id, legal_entity_id),
  ADD CONSTRAINT posting_intents_treasury_transfer_fkey FOREIGN KEY (treasury_transfer_id, legal_entity_id)
    REFERENCES abos.treasury_transfers(id, legal_entity_id),
  ADD CONSTRAINT posting_intents_treasury_payment_fkey FOREIGN KEY (treasury_payment_id, legal_entity_id)
    REFERENCES abos.treasury_payments(id, legal_entity_id);
ALTER TABLE abos.posting_intents DROP CONSTRAINT posting_intents_intent_kind_check;
ALTER TABLE abos.posting_intents ADD CONSTRAINT posting_intents_intent_kind_check CHECK (intent_kind = ANY (ARRAY[
  'SHAREHOLDER_CAPITAL_RECEIPT', 'SHAREHOLDER_LOAN_RECEIPT', 'REVERSAL', 'EXPENSE', 'TEMPORARY_FUNDING',
  'TEMPORARY_FUNDING_SETTLEMENT', 'DIRECT_SHAREHOLDER_CAPITAL', 'OPENING_BALANCE',
  'CASH_RECEIPT', 'TREASURY_TRANSFER', 'PAYMENT']));
ALTER TABLE abos.posting_intents ADD CONSTRAINT posting_intents_money_movement_shape CHECK (
  (intent_kind = 'CASH_RECEIPT') = (treasury_receipt_id IS NOT NULL)
  AND (intent_kind = 'TREASURY_TRANSFER') = (treasury_transfer_id IS NOT NULL)
  AND (intent_kind = 'PAYMENT') = (treasury_payment_id IS NOT NULL)
  AND (treasury_receipt_id IS NULL OR (source_type = 'CASH_RECEIPT' AND source_id = treasury_receipt_id AND processing_model = 'OPERATIONAL_V1'))
  AND (treasury_transfer_id IS NULL OR (source_type = 'TREASURY_TRANSFER' AND source_id = treasury_transfer_id AND processing_model = 'OPERATIONAL_V1'))
  AND (treasury_payment_id IS NULL OR (source_type = 'PAYMENT' AND source_id = treasury_payment_id AND processing_model = 'OPERATIONAL_V1')));

ALTER TABLE abos.posting_sources DISABLE TRIGGER posting_sources_no_update_or_delete;
UPDATE abos.posting_sources SET intent_kind = 'CASH_RECEIPT', workflow_type = 'OTHER_INCOME', status = 'ACTIVE', line_count = 2,
  debit_rules = '[{"accountType":"ASSET","control":"CASH"},{"accountType":"ASSET","control":"SARAF"}]',
  credit_rules = '[{"accountType":"REVENUE","control":null}]',
  subledger_rules = '[{"type":"OPERATIONAL_TREASURY","side":"DEBIT","required":true}]',
  reversible = true, validator = 'validate_cash_receipt_journal',
  description = 'Money received into a Safe or Saraf as other income: Dr the Treasury account, Cr an income account (0047).'
WHERE source_type = 'CASH_RECEIPT' AND status = 'PLANNED';
UPDATE abos.posting_sources SET intent_kind = 'TREASURY_TRANSFER', workflow_type = 'TREASURY_TRANSFER', status = 'ACTIVE', line_count = 2,
  debit_rules = '[{"accountType":"ASSET","control":"CASH"},{"accountType":"ASSET","control":"SARAF"}]',
  credit_rules = '[{"accountType":"ASSET","control":"CASH"},{"accountType":"ASSET","control":"SARAF"}]',
  subledger_rules = '[{"type":"OPERATIONAL_TREASURY","side":"DEBIT","required":true},{"type":"OPERATIONAL_TREASURY","side":"CREDIT","required":true}]',
  reversible = true, validator = 'validate_treasury_transfer_journal',
  description = 'Money moved between Safes and Saraf accounts of one currency: Dr destination, Cr source (0047).'
WHERE source_type = 'TREASURY_TRANSFER' AND status = 'PLANNED';
UPDATE abos.posting_sources SET intent_kind = 'PAYMENT', workflow_type = 'SUPPLIER_PAYMENT', status = 'ACTIVE', line_count = 2,
  debit_rules = '[{"accountType":"LIABILITY","control":"AP"},{"accountType":"LIABILITY","control":null}]',
  credit_rules = '[{"accountType":"ASSET","control":"CASH"},{"accountType":"ASSET","control":"SARAF"}]',
  subledger_rules = '[{"type":"OPERATIONAL_TREASURY","side":"CREDIT","required":true}]',
  reversible = true, validator = 'validate_payment_journal',
  description = 'Money paid out of a Safe or Saraf against a payable (salary under SALARY_PAYMENT, others under SUPPLIER_PAYMENT) (0047).'
WHERE source_type = 'PAYMENT' AND status = 'PLANNED';
ALTER TABLE abos.posting_sources ENABLE TRIGGER posting_sources_no_update_or_delete;
DO $registry$ BEGIN
  IF (SELECT count(*) FROM abos.posting_sources WHERE source_type IN ('CASH_RECEIPT', 'TREASURY_TRANSFER', 'PAYMENT') AND status = 'ACTIVE') <> 3 THEN
    RAISE EXCEPTION '0047 could not activate the three money-movement sources';
  END IF;
END $registry$;

INSERT INTO abos.permission_catalogue
  (permission_code, catalogue_version, category, availability, independence_enforced, administrative, sort_order)
VALUES
  ('treasury.receipt.record', 12, 'TREASURY', 'ACTIVE', false, false, 415),
  ('treasury.transfer.record', 12, 'TREASURY', 'ACTIVE', false, false, 416),
  ('treasury.payment.record', 12, 'TREASURY', 'ACTIVE', false, false, 417);

-- ---------------------------------------------------------------------------------------------
-- 3. Shared helpers (internal; caller's rights; only the operational Finance owner may call them).
-- ---------------------------------------------------------------------------------------------

CREATE FUNCTION abos.money_movement_policy(p_entity uuid, p_workflow_type text)
RETURNS uuid LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $policy$
DECLARE v_policy abos.finance_workflow_policy_versions%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('abos-finance-workflow-policy:' || p_entity::text || ':' || p_workflow_type, 0));
  SELECT * INTO v_policy FROM abos.finance_workflow_policy_versions
   WHERE legal_entity_id = p_entity AND workflow_type = p_workflow_type ORDER BY version DESC LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the % approval setting has not been saved yet', p_workflow_type USING ERRCODE = 'check_violation';
  END IF;
  IF v_policy.approval_required THEN
    RAISE EXCEPTION 'the % setting requires approval, which is not available for this movement yet', p_workflow_type
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN v_policy.id;
END
$policy$;

CREATE FUNCTION abos.money_treasury_account(p_entity uuid, p_account uuid, p_currency text)
RETURNS abos.operational_treasury_accounts LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $account$
DECLARE v_account abos.operational_treasury_accounts%ROWTYPE;
BEGIN
  -- Locks the row: a status change (close, deactivate) and other movements of this account serialize.
  SELECT * INTO v_account FROM abos.operational_treasury_accounts WHERE id = p_account AND legal_entity_id = p_entity FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the Safe or Saraf account was not found in this legal entity' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_account.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'the Safe or Saraf account % is not active', v_account.name_en USING ERRCODE = 'check_violation';
  END IF;
  IF v_account.currency_code IS DISTINCT FROM p_currency THEN
    RAISE EXCEPTION 'the Safe or Saraf account % holds %, not %', v_account.name_en, v_account.currency_code, p_currency
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN v_account;
END
$account$;

-- Parses the common request fields; returns {amount, date, key, correlation} or raises.
CREATE FUNCTION abos.money_request(p_payload jsonb, p_allowed text[])
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $request$
DECLARE v_unknown text; v_day date; v_correlation uuid; v_key text;
BEGIN
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'movement details must be an object' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT string_agg(k, ', ') INTO v_unknown FROM jsonb_object_keys(p_payload) k WHERE NOT k = ANY (p_allowed);
  IF v_unknown IS NOT NULL THEN
    RAISE EXCEPTION 'unknown movement fields: %', v_unknown USING ERRCODE = 'invalid_parameter_value';
  END IF;
  BEGIN
    v_day := NULLIF(p_payload->>'businessDate', '')::date;
    v_correlation := NULLIF(p_payload->>'correlationId', '')::uuid;
  EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow OR invalid_datetime_format THEN
    RAISE EXCEPTION 'a valid date and request identity are required' USING ERRCODE = 'invalid_parameter_value';
  END;
  v_key := NULLIF(btrim(p_payload->>'idempotencyKey'), '');
  IF v_day IS NULL OR v_correlation IS NULL OR v_key IS NULL OR length(v_key) NOT BETWEEN 8 AND 200
     OR length(p_payload->>'reference') > 120 OR length(p_payload->>'note') > 1000 THEN
    RAISE EXCEPTION 'a valid date and request identity are required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_day > abos.business_today() THEN
    RAISE EXCEPTION 'a movement cannot be dated after today' USING ERRCODE = 'check_violation';
  END IF;
  RETURN jsonb_build_object('amount', abos.temporary_funding_amount(p_payload->>'amount')::text, 'date', v_day,
    'key', v_key, 'correlation', v_correlation);
END
$request$;

CREATE FUNCTION abos.money_uuid(p_payload jsonb, p_field text)
RETURNS uuid LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $uuid$
BEGIN
  RETURN NULLIF(p_payload->>p_field, '')::uuid;
EXCEPTION WHEN invalid_text_representation THEN
  RAISE EXCEPTION 'choose a valid %', p_field USING ERRCODE = 'invalid_parameter_value';
END
$uuid$;

CREATE FUNCTION abos.money_base_currency(p_entity uuid, p_currency text)
RETURNS text LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $base$
DECLARE v_base text;
BEGIN
  SELECT base_currency_code INTO v_base FROM abos.legal_entities WHERE id = p_entity AND currency_policy_status = 'APPROVED';
  IF v_base IS NULL OR p_currency IS DISTINCT FROM v_base THEN
    RAISE EXCEPTION 'this movement is available in the approved accounting currency only' USING ERRCODE = 'check_violation';
  END IF;
  RETURN v_base;
END
$base$;

CREATE FUNCTION abos.money_party(p_entity uuid, p_party uuid, p_name text)
RETURNS void LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $party$
BEGIN
  IF p_party IS NULL AND p_name IS NULL THEN
    RAISE EXCEPTION 'name who the money came from or went to' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_party IS NOT NULL AND NOT EXISTS (SELECT 1 FROM abos.business_parties WHERE id = p_party AND legal_entity_id = p_entity AND status = 'ACTIVE') THEN
    RAISE EXCEPTION 'the chosen person or organization is not active in this legal entity' USING ERRCODE = 'check_violation';
  END IF;
  IF p_name IS NOT NULL AND length(p_name) > 200 THEN
    RAISE EXCEPTION 'the name must be at most 200 characters' USING ERRCODE = 'invalid_parameter_value';
  END IF;
END
$party$;

CREATE FUNCTION abos.money_audit(p_actor uuid, p_entity uuid, p_correlation uuid, p_action text, p_entity_type text, p_id uuid, p_after jsonb)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $audit$
BEGIN
  INSERT INTO abos.audit_records (id, actor_user_account_id, legal_entity_id, correlation_id, action, entity_type, entity_id, after_state, metadata)
  VALUES (gen_random_uuid(), p_actor, p_entity, p_correlation, p_action, p_entity_type, p_id, p_after,
    jsonb_build_object('source', 'v1-money-movements'));
  INSERT INTO abos.outbox_events (id, aggregate_type, aggregate_id, event_type, event_version, legal_entity_id, actor_user_account_id,
    correlation_id, payload, occurred_at)
  VALUES (gen_random_uuid(), p_entity_type, p_id, 'finance.' || lower(replace(p_action, '_', '-')), 1, p_entity, p_actor,
    p_correlation, p_after, clock_timestamp());
END
$audit$;

-- ---------------------------------------------------------------------------------------------
-- 4. Validators (static dispatch arms of the kernel). Each re-checks that its Treasury accounts are
--    still ACTIVE when the journal posts, like every other source validator.
-- ---------------------------------------------------------------------------------------------

CREATE FUNCTION abos.validate_cash_receipt_journal(p_journal abos.journals, p_intent abos.posting_intents)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $validate$
DECLARE r abos.treasury_cash_receipts%ROWTYPE; v_account abos.operational_treasury_accounts%ROWTYPE;
BEGIN
  SELECT * INTO r FROM abos.treasury_cash_receipts WHERE id = p_intent.source_id AND legal_entity_id = p_journal.legal_entity_id;
  IF NOT FOUND OR r.journal_id <> p_journal.id OR p_intent.intent_kind <> 'CASH_RECEIPT' OR p_intent.treasury_receipt_id IS DISTINCT FROM r.id
     OR p_intent.original_amount <> r.amount OR p_intent.base_amount <> r.amount OR p_intent.original_currency_code <> r.currency_code
     OR r.business_date <> p_journal.accounting_effective_date OR p_journal.journal_reference <> r.transaction_reference
     OR p_journal.posted_by_user_account_id IS DISTINCT FROM r.created_by_user_account_id
     OR p_intent.created_by_user_account_id <> r.created_by_user_account_id
     OR p_intent.finance_workflow_policy_version_id IS DISTINCT FROM r.workflow_policy_version_id
     OR NOT EXISTS (SELECT 1 FROM abos.finance_workflow_policy_versions v WHERE v.id = r.workflow_policy_version_id
          AND v.legal_entity_id = r.legal_entity_id AND v.workflow_type = 'OTHER_INCOME' AND NOT v.approval_required) THEN
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
$validate$;

CREATE FUNCTION abos.validate_treasury_transfer_journal(p_journal abos.journals, p_intent abos.posting_intents)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $validate$
DECLARE t abos.treasury_transfers%ROWTYPE; v_source abos.operational_treasury_accounts%ROWTYPE; v_destination abos.operational_treasury_accounts%ROWTYPE;
BEGIN
  SELECT * INTO t FROM abos.treasury_transfers WHERE id = p_intent.source_id AND legal_entity_id = p_journal.legal_entity_id;
  IF NOT FOUND OR t.journal_id <> p_journal.id OR p_intent.intent_kind <> 'TREASURY_TRANSFER' OR p_intent.treasury_transfer_id IS DISTINCT FROM t.id
     OR p_intent.original_amount <> t.amount OR p_intent.base_amount <> t.amount OR p_intent.original_currency_code <> t.currency_code
     OR t.business_date <> p_journal.accounting_effective_date OR p_journal.journal_reference <> t.transaction_reference
     OR p_journal.posted_by_user_account_id IS DISTINCT FROM t.created_by_user_account_id
     OR p_intent.created_by_user_account_id <> t.created_by_user_account_id
     OR p_intent.finance_workflow_policy_version_id IS DISTINCT FROM t.workflow_policy_version_id
     OR NOT EXISTS (SELECT 1 FROM abos.finance_workflow_policy_versions v WHERE v.id = t.workflow_policy_version_id
          AND v.legal_entity_id = t.legal_entity_id AND v.workflow_type = 'TREASURY_TRANSFER' AND NOT v.approval_required) THEN
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
$validate$;

CREATE FUNCTION abos.validate_payment_journal(p_journal abos.journals, p_intent abos.posting_intents)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $validate$
DECLARE p abos.treasury_payments%ROWTYPE; v_account abos.operational_treasury_accounts%ROWTYPE;
BEGIN
  SELECT * INTO p FROM abos.treasury_payments WHERE id = p_intent.source_id AND legal_entity_id = p_journal.legal_entity_id;
  IF NOT FOUND OR p.journal_id <> p_journal.id OR p_intent.intent_kind <> 'PAYMENT' OR p_intent.treasury_payment_id IS DISTINCT FROM p.id
     OR p_intent.original_amount <> p.amount OR p_intent.base_amount <> p.amount OR p_intent.original_currency_code <> p.currency_code
     OR p.business_date <> p_journal.accounting_effective_date OR p_journal.journal_reference <> p.transaction_reference
     OR p_journal.posted_by_user_account_id IS DISTINCT FROM p.created_by_user_account_id
     OR p_intent.created_by_user_account_id <> p.created_by_user_account_id
     OR p_intent.finance_workflow_policy_version_id IS DISTINCT FROM p.workflow_policy_version_id
     OR NOT EXISTS (SELECT 1 FROM abos.finance_workflow_policy_versions v WHERE v.id = p.workflow_policy_version_id
          AND v.legal_entity_id = p.legal_entity_id AND NOT v.approval_required
          AND v.workflow_type = CASE p.payment_kind WHEN 'SALARY' THEN 'SALARY_PAYMENT' ELSE 'SUPPLIER_PAYMENT' END) THEN
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
$validate$;

-- ---------------------------------------------------------------------------------------------
-- 5. Writers (one save each).
-- ---------------------------------------------------------------------------------------------

CREATE FUNCTION abos.treasury_receipt_record(p_proof text, p_runtime text, p_token text, p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $record$
DECLARE c jsonb; actor uuid; entity uuid; req jsonb; amount numeric; day date; key text; correlation uuid; currency text; base text;
  v_account abos.operational_treasury_accounts%ROWTYPE; revenue uuid; party uuid; payer text; policy uuid; period uuid;
  scope text; fingerprint text; replay jsonb; ref text; result jsonb;
  receipt uuid := gen_random_uuid(); journal uuid := gen_random_uuid(); intent uuid := gen_random_uuid();
BEGIN
  c := abos.treasury_safe_actor(p_proof, p_runtime, p_token, 'treasury.receipt.record');
  actor := (c->>'userAccountId')::uuid; entity := (c->>'legalEntityId')::uuid;
  req := abos.money_request(p_payload, ARRAY['treasuryAccountId', 'amount', 'currencyCode', 'businessDate', 'payerBusinessPartyId',
    'payerName', 'revenueLedgerAccountId', 'reference', 'note', 'idempotencyKey', 'correlationId']);
  amount := (req->>'amount')::numeric; day := (req->>'date')::date; key := req->>'key'; correlation := (req->>'correlation')::uuid;
  currency := p_payload->>'currencyCode'; party := abos.money_uuid(p_payload, 'payerBusinessPartyId');
  payer := NULLIF(btrim(p_payload->>'payerName'), ''); revenue := abos.money_uuid(p_payload, 'revenueLedgerAccountId');
  IF abos.money_uuid(p_payload, 'treasuryAccountId') IS NULL OR revenue IS NULL THEN
    RAISE EXCEPTION 'choose the Safe and the income account' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM abos.money_party(entity, party, payer);
  scope := 'treasury:receipt:' || entity::text || ':' || actor::text;
  fingerprint := encode(sha256(convert_to((p_payload - 'correlationId')::text || actor::text, 'UTF8')), 'hex');
  replay := abos.temporary_funding_idempotency_begin(scope, key, fingerprint, correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  base := abos.money_base_currency(entity, currency);
  v_account := abos.money_treasury_account(entity, abos.money_uuid(p_payload, 'treasuryAccountId'), currency);
  IF NOT EXISTS (SELECT 1 FROM abos.ledger_accounts WHERE id = revenue AND legal_entity_id = entity AND status = 'ACTIVE' AND posting_allowed
       AND account_type = 'REVENUE' AND control_account_type IS NULL AND account_currency_code IS NOT DISTINCT FROM base
       AND NOT requires_project AND NOT requires_department AND NOT requires_cost_center) THEN
    RAISE EXCEPTION 'choose an active income account in the accounting currency' USING ERRCODE = 'check_violation';
  END IF;
  policy := abos.money_movement_policy(entity, 'OTHER_INCOME');
  period := abos.open_period_for_business_date(entity, actor, day);
  ref := 'RC-' || to_char(day, 'YYYYMMDD') || '-' || upper(replace(receipt::text, '-', ''));
  INSERT INTO abos.treasury_cash_receipts (id, legal_entity_id, operational_treasury_account_id, currency_code, amount, business_date,
    payer_business_party_id, payer_name, revenue_ledger_account_id, reference, note, transaction_reference, workflow_policy_version_id,
    journal_id, created_by_user_account_id, correlation_id, idempotency_key)
  VALUES (receipt, entity, v_account.id, currency, amount, day, party, payer, revenue, NULLIF(btrim(p_payload->>'reference'), ''),
    NULLIF(btrim(p_payload->>'note'), ''), ref, policy, journal, actor, correlation, key);
  PERFORM abos.posting_kernel_draft(
    p_intent_id => intent, p_journal_id => journal, p_legal_entity_id => entity, p_source_type => 'CASH_RECEIPT', p_source_id => receipt,
    p_original_amount => amount, p_original_currency_code => currency, p_base_amount => amount, p_base_currency_code => base,
    p_accounting_effective_date => day, p_accounting_period_id => period, p_journal_reference => ref, p_correlation_id => correlation,
    p_idempotency_key => 'RC:' || receipt::text, p_initial_status => 'VALIDATED', p_created_by_user_account_id => actor,
    p_lines => ARRAY[
      ROW(1, 'DEBIT', v_account.ledger_account_id, NULL, NULL, NULL, NULL, 'OPERATIONAL_TREASURY', 1, v_account.id, NULL)::abos.posting_kernel_line,
      ROW(2, 'CREDIT', revenue, party, NULL, NULL, NULL, NULL, NULL, NULL, NULL)::abos.posting_kernel_line],
    p_finance_workflow_policy_version_id => policy);
  PERFORM abos.posting_kernel_commit(intent, journal, actor);
  result := jsonb_build_object('movementId', receipt, 'journalId', journal, 'reference', ref, 'status', 'POSTED', 'replayed', false);
  PERFORM abos.money_audit(actor, entity, correlation, 'TREASURY_CASH_RECEIPT_POSTED', 'TREASURY_CASH_RECEIPT', receipt,
    result || jsonb_build_object('treasuryAccountId', v_account.id, 'amount', amount::text, 'currency', currency, 'businessDate', day,
      'revenueAccountId', revenue, 'payerBusinessPartyId', party, 'payerName', payer));
  PERFORM abos.temporary_funding_idempotency_complete(scope, key, 'TREASURY_CASH_RECEIPT', receipt, result);
  RETURN result;
END
$record$;

CREATE FUNCTION abos.treasury_transfer_record(p_proof text, p_runtime text, p_token text, p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $record$
DECLARE c jsonb; actor uuid; entity uuid; req jsonb; amount numeric; day date; key text; correlation uuid; currency text; base text;
  v_source abos.operational_treasury_accounts%ROWTYPE; v_destination abos.operational_treasury_accounts%ROWTYPE; source_id uuid; destination_id uuid;
  policy uuid; period uuid; scope text; fingerprint text; replay jsonb; ref text; result jsonb;
  transfer uuid := gen_random_uuid(); journal uuid := gen_random_uuid(); intent uuid := gen_random_uuid();
BEGIN
  c := abos.treasury_safe_actor(p_proof, p_runtime, p_token, 'treasury.transfer.record');
  actor := (c->>'userAccountId')::uuid; entity := (c->>'legalEntityId')::uuid;
  req := abos.money_request(p_payload, ARRAY['sourceTreasuryAccountId', 'destinationTreasuryAccountId', 'amount', 'currencyCode',
    'businessDate', 'reference', 'note', 'idempotencyKey', 'correlationId']);
  amount := (req->>'amount')::numeric; day := (req->>'date')::date; key := req->>'key'; correlation := (req->>'correlation')::uuid;
  currency := p_payload->>'currencyCode';
  source_id := abos.money_uuid(p_payload, 'sourceTreasuryAccountId'); destination_id := abos.money_uuid(p_payload, 'destinationTreasuryAccountId');
  IF source_id IS NULL OR destination_id IS NULL THEN
    RAISE EXCEPTION 'choose where the money comes from and where it goes' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF source_id = destination_id THEN
    RAISE EXCEPTION 'a transfer needs two different accounts' USING ERRCODE = 'check_violation';
  END IF;
  scope := 'treasury:transfer:' || entity::text || ':' || actor::text;
  fingerprint := encode(sha256(convert_to((p_payload - 'correlationId')::text || actor::text, 'UTF8')), 'hex');
  replay := abos.temporary_funding_idempotency_begin(scope, key, fingerprint, correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  base := abos.money_base_currency(entity, currency);
  -- Both rows are locked in a stable order, so two opposite transfers cannot deadlock.
  IF source_id < destination_id THEN
    v_source := abos.money_treasury_account(entity, source_id, currency);
    v_destination := abos.money_treasury_account(entity, destination_id, currency);
  ELSE
    v_destination := abos.money_treasury_account(entity, destination_id, currency);
    v_source := abos.money_treasury_account(entity, source_id, currency);
  END IF;
  policy := abos.money_movement_policy(entity, 'TREASURY_TRANSFER');
  period := abos.open_period_for_business_date(entity, actor, day);
  ref := 'TR-' || to_char(day, 'YYYYMMDD') || '-' || upper(replace(transfer::text, '-', ''));
  INSERT INTO abos.treasury_transfers (id, legal_entity_id, source_treasury_account_id, destination_treasury_account_id, currency_code,
    amount, business_date, reference, note, transaction_reference, workflow_policy_version_id, journal_id, created_by_user_account_id,
    correlation_id, idempotency_key)
  VALUES (transfer, entity, v_source.id, v_destination.id, currency, amount, day, NULLIF(btrim(p_payload->>'reference'), ''),
    NULLIF(btrim(p_payload->>'note'), ''), ref, policy, journal, actor, correlation, key);
  PERFORM abos.posting_kernel_draft(
    p_intent_id => intent, p_journal_id => journal, p_legal_entity_id => entity, p_source_type => 'TREASURY_TRANSFER', p_source_id => transfer,
    p_original_amount => amount, p_original_currency_code => currency, p_base_amount => amount, p_base_currency_code => base,
    p_accounting_effective_date => day, p_accounting_period_id => period, p_journal_reference => ref, p_correlation_id => correlation,
    p_idempotency_key => 'TR:' || transfer::text, p_initial_status => 'VALIDATED', p_created_by_user_account_id => actor,
    p_lines => ARRAY[
      ROW(1, 'DEBIT', v_destination.ledger_account_id, NULL, NULL, NULL, NULL, 'OPERATIONAL_TREASURY', 1, v_destination.id, NULL)::abos.posting_kernel_line,
      ROW(2, 'CREDIT', v_source.ledger_account_id, NULL, NULL, NULL, NULL, 'OPERATIONAL_TREASURY', -1, v_source.id, NULL)::abos.posting_kernel_line],
    p_finance_workflow_policy_version_id => policy);
  PERFORM abos.posting_kernel_commit(intent, journal, actor);
  result := jsonb_build_object('movementId', transfer, 'journalId', journal, 'reference', ref, 'status', 'POSTED', 'replayed', false);
  PERFORM abos.money_audit(actor, entity, correlation, 'TREASURY_TRANSFER_POSTED', 'TREASURY_TRANSFER', transfer,
    result || jsonb_build_object('sourceTreasuryAccountId', v_source.id, 'destinationTreasuryAccountId', v_destination.id,
      'amount', amount::text, 'currency', currency, 'businessDate', day));
  PERFORM abos.temporary_funding_idempotency_complete(scope, key, 'TREASURY_TRANSFER', transfer, result);
  RETURN result;
END
$record$;

CREATE FUNCTION abos.treasury_payment_record(p_proof text, p_runtime text, p_token text, p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $record$
DECLARE c jsonb; actor uuid; entity uuid; req jsonb; amount numeric; day date; key text; correlation uuid; currency text; base text;
  v_account abos.operational_treasury_accounts%ROWTYPE; payable uuid; party uuid; payee text; kind text; policy uuid; period uuid;
  scope text; fingerprint text; replay jsonb; ref text; result jsonb;
  payment uuid := gen_random_uuid(); journal uuid := gen_random_uuid(); intent uuid := gen_random_uuid();
BEGIN
  c := abos.treasury_safe_actor(p_proof, p_runtime, p_token, 'treasury.payment.record');
  actor := (c->>'userAccountId')::uuid; entity := (c->>'legalEntityId')::uuid;
  req := abos.money_request(p_payload, ARRAY['treasuryAccountId', 'paymentKind', 'payeeBusinessPartyId', 'payeeName', 'payableLedgerAccountId',
    'amount', 'currencyCode', 'businessDate', 'reference', 'note', 'idempotencyKey', 'correlationId']);
  amount := (req->>'amount')::numeric; day := (req->>'date')::date; key := req->>'key'; correlation := (req->>'correlation')::uuid;
  currency := p_payload->>'currencyCode'; kind := p_payload->>'paymentKind';
  party := abos.money_uuid(p_payload, 'payeeBusinessPartyId'); payee := NULLIF(btrim(p_payload->>'payeeName'), '');
  payable := abos.money_uuid(p_payload, 'payableLedgerAccountId');
  IF kind IS NULL OR kind NOT IN ('SUPPLIER', 'CONTRACTOR', 'SALARY', 'OTHER') THEN
    RAISE EXCEPTION 'choose what kind of payment this is' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF abos.money_uuid(p_payload, 'treasuryAccountId') IS NULL OR payable IS NULL THEN
    RAISE EXCEPTION 'choose the Safe and the payable account' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM abos.money_party(entity, party, payee);
  scope := 'treasury:payment:' || entity::text || ':' || actor::text;
  fingerprint := encode(sha256(convert_to((p_payload - 'correlationId')::text || actor::text, 'UTF8')), 'hex');
  replay := abos.temporary_funding_idempotency_begin(scope, key, fingerprint, correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  base := abos.money_base_currency(entity, currency);
  v_account := abos.money_treasury_account(entity, abos.money_uuid(p_payload, 'treasuryAccountId'), currency);
  -- Temporary-funding, shareholder-loan and Saraf liabilities have their own lanes and are refused here.
  IF NOT EXISTS (SELECT 1 FROM abos.ledger_accounts WHERE id = payable AND legal_entity_id = entity AND status = 'ACTIVE' AND posting_allowed
       AND account_type = 'LIABILITY' AND (control_account_type IS NULL OR control_account_type = 'AP')
       AND account_currency_code IS NOT DISTINCT FROM base
       AND NOT requires_project AND NOT requires_department AND NOT requires_cost_center) THEN
    RAISE EXCEPTION 'choose an active payable account in the accounting currency' USING ERRCODE = 'check_violation';
  END IF;
  -- Accounts payable is kept per supplier, so a free-text name is enough only on a payable without the AP control.
  IF party IS NULL AND EXISTS (SELECT 1 FROM abos.ledger_accounts WHERE id = payable AND control_account_type = 'AP') THEN
    RAISE EXCEPTION 'a payment against accounts payable needs the person or organization it was owed to' USING ERRCODE = 'check_violation';
  END IF;
  policy := abos.money_movement_policy(entity, CASE kind WHEN 'SALARY' THEN 'SALARY_PAYMENT' ELSE 'SUPPLIER_PAYMENT' END);
  period := abos.open_period_for_business_date(entity, actor, day);
  ref := 'PY-' || to_char(day, 'YYYYMMDD') || '-' || upper(replace(payment::text, '-', ''));
  INSERT INTO abos.treasury_payments (id, legal_entity_id, operational_treasury_account_id, payment_kind, payee_business_party_id, payee_name,
    payable_ledger_account_id, currency_code, amount, business_date, reference, note, transaction_reference, workflow_policy_version_id,
    journal_id, created_by_user_account_id, correlation_id, idempotency_key)
  VALUES (payment, entity, v_account.id, kind, party, payee, payable, currency, amount, day, NULLIF(btrim(p_payload->>'reference'), ''),
    NULLIF(btrim(p_payload->>'note'), ''), ref, policy, journal, actor, correlation, key);
  PERFORM abos.posting_kernel_draft(
    p_intent_id => intent, p_journal_id => journal, p_legal_entity_id => entity, p_source_type => 'PAYMENT', p_source_id => payment,
    p_original_amount => amount, p_original_currency_code => currency, p_base_amount => amount, p_base_currency_code => base,
    p_accounting_effective_date => day, p_accounting_period_id => period, p_journal_reference => ref, p_correlation_id => correlation,
    p_idempotency_key => 'PY:' || payment::text, p_initial_status => 'VALIDATED', p_created_by_user_account_id => actor,
    p_lines => ARRAY[
      ROW(1, 'DEBIT', payable, party, NULL, NULL, NULL, NULL, NULL, NULL, NULL)::abos.posting_kernel_line,
      ROW(2, 'CREDIT', v_account.ledger_account_id, NULL, NULL, NULL, NULL, 'OPERATIONAL_TREASURY', -1, v_account.id, NULL)::abos.posting_kernel_line],
    p_finance_workflow_policy_version_id => policy);
  PERFORM abos.posting_kernel_commit(intent, journal, actor);
  result := jsonb_build_object('movementId', payment, 'journalId', journal, 'reference', ref, 'status', 'POSTED', 'replayed', false);
  PERFORM abos.money_audit(actor, entity, correlation, 'TREASURY_PAYMENT_POSTED', 'TREASURY_PAYMENT', payment,
    result || jsonb_build_object('treasuryAccountId', v_account.id, 'paymentKind', kind, 'amount', amount::text, 'currency', currency,
      'businessDate', day, 'payableAccountId', payable, 'payeeBusinessPartyId', party, 'payeeName', payee));
  PERFORM abos.temporary_funding_idempotency_complete(scope, key, 'TREASURY_PAYMENT', payment, result);
  RETURN result;
END
$record$;

-- What the three forms need: accounts, people, and whether each movement can be saved now.
CREATE FUNCTION abos.treasury_money_options(p_proof text, p_runtime text, p_token text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $options$
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
    'settings', (SELECT jsonb_object_agg(t.workflow_type, CASE WHEN v.id IS NULL THEN 'NOT_SAVED' WHEN v.approval_required THEN 'APPROVAL_REQUIRED' ELSE 'READY' END)
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
$options$;

-- ---------------------------------------------------------------------------------------------
-- 6. Restated: kernel intent columns and static dispatch arms for the three sources.
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION abos.posting_kernel_draft(p_intent_id uuid, p_journal_id uuid, p_legal_entity_id uuid, p_source_type text, p_source_id uuid, p_original_amount numeric, p_original_currency_code text, p_base_amount numeric, p_base_currency_code text, p_accounting_effective_date date, p_accounting_period_id uuid, p_journal_reference text, p_correlation_id uuid, p_idempotency_key text, p_initial_status text, p_created_by_user_account_id uuid, p_lines abos.posting_kernel_line[], p_project_id uuid DEFAULT NULL::uuid, p_department_id uuid DEFAULT NULL::uuid, p_cost_center_id uuid DEFAULT NULL::uuid, p_conversion_snapshot_reference text DEFAULT NULL::text, p_finance_workflow_policy_version_id uuid DEFAULT NULL::uuid, p_operational_version integer DEFAULT NULL::integer)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  v_source abos.posting_sources%ROWTYPE;
  v_line abos.posting_kernel_line;
  v_line_ids uuid[] := ARRAY[]::uuid[];
  v_index integer := 0;
BEGIN
  IF current_user <> 'abos_v1_operational_finance_owner' THEN
    RAISE EXCEPTION 'the posting kernel is internal' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO v_source FROM abos.posting_sources WHERE source_type = p_source_type;
  IF NOT FOUND OR v_source.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'posting source % is not active', p_source_type USING ERRCODE = 'check_violation';
  END IF;
  IF p_initial_status IS NULL OR p_initial_status NOT IN ('VALIDATED', 'APPROVED')
     OR p_original_amount IS NULL OR p_original_amount <= 0
     OR p_base_amount IS NULL OR p_base_amount <= 0
     OR p_lines IS NULL OR pg_catalog.cardinality(p_lines) <> v_source.line_count THEN
    RAISE EXCEPTION 'a posting needs positive amounts, a pre-posting status and exactly % lines', v_source.line_count
      USING ERRCODE = 'check_violation';
  END IF;
  FOREACH v_line IN ARRAY p_lines LOOP
    v_index := v_index + 1;
    IF v_line.line_number IS DISTINCT FROM v_index
       OR COALESCE(v_line.side NOT IN ('DEBIT', 'CREDIT'), true)
       OR v_line.ledger_account_id IS NULL
       OR (v_line.subledger_type IS NULL) <> (v_line.subledger_sign IS NULL)
       OR COALESCE(v_line.subledger_sign NOT IN (1, -1), false) THEN
      RAISE EXCEPTION 'posting line % is malformed', v_index USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;

  INSERT INTO abos.posting_intents
    (id, legal_entity_id, project_id, department_id, cost_center_id,
     source_type, source_id, intent_kind, original_amount, original_currency_code,
     base_amount, base_currency_code, conversion_snapshot_reference,
     accounting_effective_date, correlation_id, idempotency_key, status,
     created_by_user_account_id, processing_model,
     operational_expense_id, direct_capital_receipt_id, treasury_opening_balance_id,
     treasury_receipt_id, treasury_transfer_id, treasury_payment_id,
     finance_workflow_policy_version_id, operational_version)
  VALUES
    (p_intent_id, p_legal_entity_id, p_project_id, p_department_id, p_cost_center_id,
     p_source_type, p_source_id, v_source.intent_kind, p_original_amount, p_original_currency_code,
     p_base_amount, p_base_currency_code, p_conversion_snapshot_reference,
     p_accounting_effective_date, p_correlation_id, p_idempotency_key, p_initial_status,
     p_created_by_user_account_id, 'OPERATIONAL_V1',
     CASE p_source_type WHEN 'OPERATIONAL_EXPENSE' THEN p_source_id END,
     CASE p_source_type WHEN 'DIRECT_SHAREHOLDER_CAPITAL' THEN p_source_id END,
     CASE p_source_type WHEN 'OPENING_BALANCE' THEN p_source_id END,
     CASE p_source_type WHEN 'CASH_RECEIPT' THEN p_source_id END,
     CASE p_source_type WHEN 'TREASURY_TRANSFER' THEN p_source_id END,
     CASE p_source_type WHEN 'PAYMENT' THEN p_source_id END,
     p_finance_workflow_policy_version_id, p_operational_version);
  INSERT INTO abos.journals
    (id, legal_entity_id, accounting_period_id, posting_intent_id, journal_reference,
     accounting_effective_date, base_currency_code, status,
     created_by_user_account_id, processing_model)
  VALUES
    (p_journal_id, p_legal_entity_id, p_accounting_period_id, p_intent_id, p_journal_reference,
     p_accounting_effective_date, p_base_currency_code, 'DRAFT',
     p_created_by_user_account_id, 'OPERATIONAL_V1');

  FOREACH v_line IN ARRAY p_lines LOOP
    v_line_ids := v_line_ids || pg_catalog.gen_random_uuid();
    INSERT INTO abos.journal_lines
      (id, journal_id, legal_entity_id, line_number, ledger_account_id,
       business_party_id, project_id, department_id, cost_center_id,
       original_amount, original_currency_code, base_debit, base_credit,
       base_currency_code, conversion_snapshot_reference, source_type, source_id,
       processing_model)
    VALUES
      (v_line_ids[v_line.line_number], p_journal_id, p_legal_entity_id, v_line.line_number,
       v_line.ledger_account_id, v_line.business_party_id, v_line.project_id,
       v_line.department_id, v_line.cost_center_id, p_original_amount, p_original_currency_code,
       CASE v_line.side WHEN 'DEBIT' THEN p_base_amount ELSE 0 END,
       CASE v_line.side WHEN 'CREDIT' THEN p_base_amount ELSE 0 END,
       p_base_currency_code, p_conversion_snapshot_reference, p_source_type, p_source_id,
       'OPERATIONAL_V1');
  END LOOP;
  FOREACH v_line IN ARRAY p_lines LOOP
    CONTINUE WHEN v_line.subledger_type IS NULL;
    INSERT INTO abos.subledger_entries
      (id, legal_entity_id, journal_line_id, subledger_type, operational_treasury_account_id,
       business_party_id, original_amount, original_currency_code, base_amount, base_currency_code,
       source_type, source_id, processing_model, direct_capital_receipt_id)
    VALUES
      (pg_catalog.gen_random_uuid(), p_legal_entity_id, v_line_ids[v_line.line_number],
       v_line.subledger_type, v_line.operational_treasury_account_id,
       v_line.subledger_business_party_id,
       CASE v_line.subledger_sign WHEN -1 THEN -p_original_amount ELSE p_original_amount END,
       p_original_currency_code,
       CASE v_line.subledger_sign WHEN -1 THEN -p_base_amount ELSE p_base_amount END,
       p_base_currency_code, p_source_type, p_source_id, 'OPERATIONAL_V1',
       CASE p_source_type WHEN 'DIRECT_SHAREHOLDER_CAPITAL' THEN p_source_id END);
  END LOOP;
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
  RETURN NEW;
END
$function$;

-- ---------------------------------------------------------------------------------------------
-- 7. Privileges. Column-level writes only; helpers run with the caller's rights and only the
--    operational Finance owner may call them; the four entry points are SECURITY DEFINER functions of
--    that owner, callable only by the Finance runtime, and check the signed-in person's authority.
-- ---------------------------------------------------------------------------------------------

REVOKE ALL ON TABLE abos.treasury_cash_receipts, abos.treasury_transfers, abos.treasury_payments FROM PUBLIC;
GRANT SELECT ON abos.treasury_cash_receipts, abos.treasury_transfers, abos.treasury_payments TO abos_v1_operational_finance_owner;
GRANT INSERT (id, legal_entity_id, operational_treasury_account_id, currency_code, amount, business_date, payer_business_party_id,
  payer_name, revenue_ledger_account_id, reference, note, transaction_reference, workflow_policy_version_id, journal_id,
  created_by_user_account_id, correlation_id, idempotency_key)
  ON abos.treasury_cash_receipts TO abos_v1_operational_finance_owner;
GRANT INSERT (id, legal_entity_id, source_treasury_account_id, destination_treasury_account_id, currency_code, amount, business_date,
  reference, note, transaction_reference, workflow_policy_version_id, journal_id, created_by_user_account_id, correlation_id,
  idempotency_key)
  ON abos.treasury_transfers TO abos_v1_operational_finance_owner;
GRANT INSERT (id, legal_entity_id, operational_treasury_account_id, payment_kind, payee_business_party_id, payee_name,
  payable_ledger_account_id, currency_code, amount, business_date, reference, note, transaction_reference, workflow_policy_version_id,
  journal_id, created_by_user_account_id, correlation_id, idempotency_key)
  ON abos.treasury_payments TO abos_v1_operational_finance_owner;
GRANT SELECT (treasury_receipt_id, treasury_transfer_id, treasury_payment_id),
      INSERT (treasury_receipt_id, treasury_transfer_id, treasury_payment_id)
  ON abos.posting_intents TO abos_v1_operational_finance_owner;

REVOKE ALL ON FUNCTION
  abos.money_movement_policy(uuid, text), abos.money_treasury_account(uuid, uuid, text), abos.money_request(jsonb, text[]),
  abos.money_uuid(jsonb, text), abos.money_base_currency(uuid, text), abos.money_party(uuid, uuid, text),
  abos.money_audit(uuid, uuid, uuid, text, text, uuid, jsonb),
  abos.validate_cash_receipt_journal(abos.journals, abos.posting_intents),
  abos.validate_treasury_transfer_journal(abos.journals, abos.posting_intents),
  abos.validate_payment_journal(abos.journals, abos.posting_intents),
  abos.treasury_receipt_record(text, text, text, jsonb), abos.treasury_transfer_record(text, text, text, jsonb),
  abos.treasury_payment_record(text, text, text, jsonb), abos.treasury_money_options(text, text, text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  abos.money_movement_policy(uuid, text), abos.money_treasury_account(uuid, uuid, text), abos.money_request(jsonb, text[]),
  abos.money_uuid(jsonb, text), abos.money_base_currency(uuid, text), abos.money_party(uuid, uuid, text),
  abos.money_audit(uuid, uuid, uuid, text, text, uuid, jsonb),
  abos.validate_cash_receipt_journal(abos.journals, abos.posting_intents),
  abos.validate_treasury_transfer_journal(abos.journals, abos.posting_intents),
  abos.validate_payment_journal(abos.journals, abos.posting_intents)
  TO abos_v1_operational_finance_owner;
ALTER FUNCTION abos.treasury_receipt_record(text, text, text, jsonb) OWNER TO abos_v1_operational_finance_owner;
ALTER FUNCTION abos.treasury_transfer_record(text, text, text, jsonb) OWNER TO abos_v1_operational_finance_owner;
ALTER FUNCTION abos.treasury_payment_record(text, text, text, jsonb) OWNER TO abos_v1_operational_finance_owner;
ALTER FUNCTION abos.treasury_money_options(text, text, text) OWNER TO abos_v1_operational_finance_owner;
REVOKE ALL ON FUNCTION
  abos.treasury_receipt_record(text, text, text, jsonb), abos.treasury_transfer_record(text, text, text, jsonb),
  abos.treasury_payment_record(text, text, text, jsonb), abos.treasury_money_options(text, text, text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  abos.treasury_receipt_record(text, text, text, jsonb), abos.treasury_transfer_record(text, text, text, jsonb),
  abos.treasury_payment_record(text, text, text, jsonb), abos.treasury_money_options(text, text, text)
  TO abos_e1_runtime;
