-- 0063: realized FX on loan settlement. See docs/03-architecture/V1_LOAN_REALIZED_FX.md.
--
-- A repayment now removes the loan's carrying value, not the day's value of the cash paid. The difference between the two is a realized
-- FX gain or loss, posted in the same journal. A loan whose native principal reaches zero therefore has no base value left either.
--
-- Three things make that possible, and each stays general:
--   1. The posting kernel accepts an amount per line. A source that passes none keeps one amount on every line, exactly as before.
--   2. The registry lets a source allow one more line. LOAN_REPAYMENT has 2 or 3, and so does REVERSAL, which must mirror it.
--   3. reversal_post copies each original line's amount, so a three-line journal reverses exactly, without recalculating anything.
--
-- No account is created and no permission is granted. A repayment that would realize a difference is refused until its account exists.
-- No journal is created and no posted row is changed.

-- ---------------------------------------------------------------------------------------------
-- 1. Two explicit Chart of Accounts roles. FX_DIFFERENCE is one account of either type, so it cannot hold both a gain and a loss.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE abos.ledger_accounts DROP CONSTRAINT ledger_accounts_control_account_type_check;
ALTER TABLE abos.ledger_accounts ADD CONSTRAINT ledger_accounts_control_account_type_check CHECK (control_account_type IS NULL OR control_account_type IN
  ('CASH', 'SHAREHOLDER_CAPITAL', 'SHAREHOLDER_LOAN', 'AR', 'AP', 'SARAF', 'OTHER', 'TEMPORARY_FUNDING_PAYABLE', 'SHAREHOLDER_CONTRIBUTED_ASSETS',
   'OPENING_BALANCE_EQUITY', 'FX_DIFFERENCE', 'LOAN_PAYABLE', 'REALIZED_FX_GAIN', 'REALIZED_FX_LOSS'));

CREATE OR REPLACE FUNCTION abos.coa_validate(p_code text, p_name text, p_name_fa text, p_description text, p_type text, p_control text, p_currency text, p_posting boolean, p_status text)
 RETURNS void
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  IF p_code IS NULL OR p_code !~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,31}$' THEN
    RAISE EXCEPTION 'the account code must be 1-32 letters, digits or . _ / - and start with a letter or digit'
      USING ERRCODE = 'check_violation';
  END IF;
  IF p_name IS NULL OR length(p_name) NOT BETWEEN 2 AND 120 THEN
    RAISE EXCEPTION 'the account name must be 2-120 characters' USING ERRCODE = 'check_violation';
  END IF;
  IF p_name_fa IS NOT NULL AND length(p_name_fa) > 120 THEN
    RAISE EXCEPTION 'the Dari account name must be at most 120 characters' USING ERRCODE = 'check_violation';
  END IF;
  IF p_description IS NOT NULL AND length(p_description) > 500 THEN
    RAISE EXCEPTION 'the description must be at most 500 characters' USING ERRCODE = 'check_violation';
  END IF;
  IF p_type IS NULL OR p_type NOT IN ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE') THEN
    RAISE EXCEPTION 'the account type must be ASSET, LIABILITY, EQUITY, REVENUE or EXPENSE' USING ERRCODE = 'check_violation';
  END IF;
  IF p_control IS NOT NULL AND p_control NOT IN ('CASH', 'SARAF', 'SHAREHOLDER_CAPITAL', 'SHAREHOLDER_LOAN', 'AR', 'AP', 'OTHER',
                                                 'TEMPORARY_FUNDING_PAYABLE', 'SHAREHOLDER_CONTRIBUTED_ASSETS', 'OPENING_BALANCE_EQUITY',
                                                 'FX_DIFFERENCE', 'LOAN_PAYABLE', 'REALIZED_FX_GAIN', 'REALIZED_FX_LOSS') THEN
    RAISE EXCEPTION 'unknown control account type %', p_control USING ERRCODE = 'check_violation';
  END IF;
  -- A control account must carry the account type its balance has by definition.
  IF (p_control IN ('CASH', 'AR', 'SHAREHOLDER_CONTRIBUTED_ASSETS') AND p_type <> 'ASSET')
     OR (p_control IN ('AP', 'SHAREHOLDER_LOAN', 'TEMPORARY_FUNDING_PAYABLE', 'LOAN_PAYABLE') AND p_type <> 'LIABILITY')
     OR (p_control IN ('SHAREHOLDER_CAPITAL', 'OPENING_BALANCE_EQUITY') AND p_type <> 'EQUITY')
     OR (p_control = 'SARAF' AND p_type NOT IN ('ASSET', 'LIABILITY'))
     OR (p_control = 'FX_DIFFERENCE' AND p_type NOT IN ('REVENUE', 'EXPENSE'))
     OR (p_control = 'REALIZED_FX_GAIN' AND p_type <> 'REVENUE')
     OR (p_control = 'REALIZED_FX_LOSS' AND p_type <> 'EXPENSE') THEN
    RAISE EXCEPTION 'a % control account cannot have account type %', p_control, p_type USING ERRCODE = 'check_violation';
  END IF;
  IF p_posting IS NULL THEN
    RAISE EXCEPTION 'say whether the account accepts postings' USING ERRCODE = 'check_violation';
  END IF;
  -- Currencies are never combined: an account that takes postings, or a control account, has one.
  IF p_currency IS NULL AND (p_posting OR p_control IS NOT NULL) THEN
    RAISE EXCEPTION 'an account that accepts postings, or a control account, needs a currency' USING ERRCODE = 'check_violation';
  END IF;
  IF p_currency IS NOT NULL AND p_status = 'ACTIVE'
     AND NOT EXISTS (SELECT 1 FROM abos.currencies c WHERE c.code = p_currency AND c.enabled) THEN
    RAISE EXCEPTION 'currency % is not enabled', p_currency USING ERRCODE = 'check_violation';
  END IF;
END;
$function$;

-- ---------------------------------------------------------------------------------------------
-- 2. The registry. A source may allow one more line; a repayment has its FX line only when a difference exists.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE abos.posting_sources ADD COLUMN line_count_max integer;
ALTER TABLE abos.posting_sources ADD CONSTRAINT posting_sources_line_count_max_check CHECK (line_count_max IS NULL OR line_count_max > line_count);
ALTER TABLE abos.posting_sources DISABLE TRIGGER posting_sources_no_update_or_delete;
UPDATE abos.posting_sources SET line_count_max = 3,
    debit_rules = debit_rules || '[{"control": "REALIZED_FX_LOSS", "accountType": "EXPENSE"}]'::jsonb,
    credit_rules = credit_rules || '[{"control": "REALIZED_FX_GAIN", "accountType": "REVENUE"}]'::jsonb
 WHERE source_type = 'LOAN_REPAYMENT';
UPDATE abos.posting_sources SET line_count_max = 3 WHERE source_type = 'REVERSAL';
ALTER TABLE abos.posting_sources ENABLE TRIGGER posting_sources_no_update_or_delete;

-- ---------------------------------------------------------------------------------------------
-- 3. The kernel. Each is the applied definition with only these lines changed.
-- ---------------------------------------------------------------------------------------------
DROP FUNCTION abos.posting_kernel_draft(uuid, uuid, uuid, text, uuid, numeric, text, numeric, text, date, uuid,
  text, uuid, text, text, uuid, abos.posting_kernel_line[], uuid, uuid, uuid, text, uuid, integer);
CREATE FUNCTION abos.posting_kernel_draft(p_intent_id uuid, p_journal_id uuid, p_legal_entity_id uuid, p_source_type text, p_source_id uuid, p_original_amount numeric, p_original_currency_code text, p_base_amount numeric, p_base_currency_code text, p_accounting_effective_date date, p_accounting_period_id uuid, p_journal_reference text, p_correlation_id uuid, p_idempotency_key text, p_initial_status text, p_created_by_user_account_id uuid, p_lines abos.posting_kernel_line[], p_project_id uuid DEFAULT NULL::uuid, p_department_id uuid DEFAULT NULL::uuid, p_cost_center_id uuid DEFAULT NULL::uuid, p_conversion_snapshot_reference text DEFAULT NULL::text, p_finance_workflow_policy_version_id uuid DEFAULT NULL::uuid, p_operational_version integer DEFAULT NULL::integer, p_line_base_amounts numeric[] DEFAULT NULL::numeric[])
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  v_source abos.posting_sources%ROWTYPE;
  v_line abos.posting_kernel_line;
  v_line_ids uuid[] := ARRAY[]::uuid[];
  v_index integer := 0;
  v_amounts numeric[];
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
     OR p_lines IS NULL OR pg_catalog.cardinality(p_lines) NOT BETWEEN v_source.line_count AND COALESCE(v_source.line_count_max, v_source.line_count) THEN
    RAISE EXCEPTION 'a posting needs positive amounts, a pre-posting status and exactly % lines', v_source.line_count
      USING ERRCODE = 'check_violation';
  END IF;
  -- 0063: one amount on every line, unless the source passes each line's own.
  v_amounts := COALESCE(p_line_base_amounts, pg_catalog.array_fill(p_base_amount, ARRAY[pg_catalog.cardinality(p_lines)]));
  IF pg_catalog.cardinality(v_amounts) <> pg_catalog.cardinality(p_lines) OR EXISTS (SELECT 1 FROM pg_catalog.unnest(v_amounts) a WHERE a IS NULL OR a <= 0) THEN
    RAISE EXCEPTION 'every posting line needs a positive amount' USING ERRCODE = 'check_violation';
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
     treasury_receipt_id, treasury_transfer_id, treasury_payment_id, loan_id, loan_repayment_id,
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
     CASE p_source_type WHEN 'LOAN_RECEIPT' THEN p_source_id END,
     CASE p_source_type WHEN 'LOAN_REPAYMENT' THEN p_source_id END,
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
       CASE v_line.side WHEN 'DEBIT' THEN v_amounts[v_line.line_number] ELSE 0 END,
       CASE v_line.side WHEN 'CREDIT' THEN v_amounts[v_line.line_number] ELSE 0 END,
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
       CASE v_line.subledger_sign WHEN -1 THEN -v_amounts[v_line.line_number] ELSE v_amounts[v_line.line_number] END,
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
  IF v_line_count NOT BETWEEN v_source.line_count AND COALESCE(v_source.line_count_max, v_source.line_count) OR v_debit <> v_credit OR v_debit <> v_intent.base_amount THEN
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
    WHEN 'REVERSAL' THEN PERFORM abos.validate_reversal_journal(NEW, v_intent);
    WHEN 'LOAN_RECEIPT' THEN PERFORM abos.validate_loan_receipt_journal(NEW, v_intent);
    WHEN 'LOAN_REPAYMENT' THEN PERFORM abos.validate_loan_repayment_journal(NEW, v_intent);
    ELSE
      RAISE EXCEPTION 'operational posting source % has no validator', v_source.source_type
        USING ERRCODE = 'check_violation';
  END CASE;
  -- 0049: a Safe, cash box or petty-cash account never goes below zero, whichever lane posts.
  PERFORM abos.treasury_require_funds(NEW);
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION abos.reversal_post(p_entity uuid, p_actor uuid, p_approver uuid, p_journal uuid, p_reason text, p_request uuid, p_correlation uuid, p_mode text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE o abos.journals%ROWTYPE; oi abos.posting_intents%ROWTYPE; src abos.posting_sources%ROWTYPE; blocker text;
  period_status text; day date; period uuid; l record; result jsonb; ref text; self boolean;
  lines abos.posting_kernel_line[] := ARRAY[]::abos.posting_kernel_line[]; amounts numeric[] := ARRAY[]::numeric[];
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
  FOR l IN SELECT line.line_number, line.base_debit, line.base_credit, line.ledger_account_id, line.business_party_id, line.project_id,
                  line.department_id, line.cost_center_id, entry.subledger_type, entry.original_amount AS movement,
                  entry.operational_treasury_account_id, entry.business_party_id AS movement_party
             FROM abos.journal_lines line LEFT JOIN abos.subledger_entries entry ON entry.journal_line_id = line.id
            WHERE line.journal_id = p_journal ORDER BY line.line_number LOOP
    lines := lines || ROW(l.line_number, CASE WHEN l.base_debit > 0 THEN 'CREDIT' ELSE 'DEBIT' END, l.ledger_account_id,
      l.business_party_id, l.project_id, l.department_id, l.cost_center_id, l.subledger_type,
      CASE WHEN l.subledger_type IS NULL THEN NULL WHEN l.movement > 0 THEN -1 ELSE 1 END,
      l.operational_treasury_account_id, l.movement_party)::abos.posting_kernel_line;
    -- 0063: each line keeps its own posted amount. Nothing is recalculated.
    amounts := amounts || (l.base_debit + l.base_credit);
  END LOOP;
  ref := 'RV-' || to_char(day, 'YYYYMMDD') || '-' || upper(replace(reversal::text, '-', ''));
  PERFORM abos.posting_kernel_draft(
    p_intent_id => intent, p_journal_id => reversal, p_legal_entity_id => p_entity, p_source_type => 'REVERSAL', p_source_id => p_journal,
    p_original_amount => oi.original_amount, p_original_currency_code => oi.original_currency_code,
    p_base_amount => oi.base_amount, p_base_currency_code => oi.base_currency_code,
    p_accounting_effective_date => day, p_accounting_period_id => period, p_journal_reference => ref, p_correlation_id => p_correlation,
    p_idempotency_key => 'RV:' || p_journal::text, p_initial_status => 'VALIDATED', p_created_by_user_account_id => p_actor,
    p_lines => lines, p_project_id => oi.project_id, p_department_id => oi.department_id, p_cost_center_id => oi.cost_center_id,
    p_conversion_snapshot_reference => oi.conversion_snapshot_reference, p_line_base_amounts => amounts);
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

-- ---------------------------------------------------------------------------------------------
-- 4. The settlement mathematics. Carrying value is derived from posted journals through loan_position; nothing is stored.
-- ---------------------------------------------------------------------------------------------
-- The carrying value a repayment of p_amount removes, when p_outstanding is owed at p_carrying.
--   The whole remaining principal: exactly p_carrying, so nothing can be left behind.
--   A part: p_carrying * p_amount / p_outstanding, rounded half up at p_scale in exact decimal arithmetic. It is kept between one smallest
--   unit and p_carrying less one smallest unit, so a part never removes nothing and never removes everything.
CREATE FUNCTION abos.loan_carrying_share(p_carrying numeric, p_outstanding numeric, p_amount numeric, p_scale integer)
RETURNS numeric LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $share$
DECLARE factor numeric := 10::numeric ^ p_scale; unit numeric := round(1 / factor, p_scale); share numeric;
BEGIN
  IF p_carrying IS NULL OR p_carrying <= 0 OR p_outstanding IS NULL OR p_outstanding <= 0 OR p_amount IS NULL OR p_amount <= 0 OR p_amount > p_outstanding THEN
    RAISE EXCEPTION 'a repayment needs an open loan and an amount within what is outstanding' USING ERRCODE = 'check_violation';
  END IF;
  IF p_amount = p_outstanding THEN RETURN p_carrying; END IF;
  share := round(div(2 * p_carrying * p_amount * factor + p_outstanding, 2 * p_outstanding) / factor, p_scale);
  share := LEAST(GREATEST(share, unit), p_carrying - unit);
  IF share < unit THEN
    RAISE EXCEPTION 'LOAN_REPAY_IN_FULL: so little carrying value remains that this loan can only be repaid in full' USING ERRCODE = 'check_violation';
  END IF;
  RETURN share;
END
$share$;

-- What a repayment would settle now: the carrying value removed, and the cash value less that carrying value. Positive is a loss.
-- The caller holds the loan row's lock, so the position cannot move underneath it.
CREATE FUNCTION abos.loan_repayment_settlement(p_loan abos.loans, p_amount numeric, p_cash numeric, p_conversion uuid)
RETURNS TABLE(carrying numeric, difference numeric)
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $settlement$
DECLARE owed record; scale integer;
BEGIN
  IF p_loan.original_currency_code = p_loan.base_currency_code THEN
    carrying := p_amount;
  ELSE
    SELECT base_scale INTO scale FROM abos.fx_conversions WHERE id = p_conversion AND legal_entity_id = p_loan.legal_entity_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'a foreign-currency repayment needs its frozen conversion' USING ERRCODE = 'check_violation'; END IF;
    SELECT * INTO owed FROM abos.loan_position(p_loan.id);
    carrying := abos.loan_carrying_share(owed.base_outstanding, owed.outstanding, p_amount, scale);
  END IF;
  difference := p_cash - carrying;
  RETURN NEXT;
END
$settlement$;

-- The state of one realized FX role: exactly one usable account is READY.
CREATE FUNCTION abos.loan_fx_account_status(p_entity uuid, p_control text, p_base text)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $status$
  WITH candidate AS (
    SELECT id, account_code, account_name, account_type, posting_allowed, account_currency_code, requires_project, requires_department, requires_cost_center
      FROM abos.ledger_accounts WHERE legal_entity_id = p_entity AND control_account_type = p_control AND status = 'ACTIVE')
  SELECT CASE (SELECT count(*) FROM candidate)
    WHEN 0 THEN jsonb_build_object('status', 'MISSING', 'count', 0)
    WHEN 1 THEN (SELECT jsonb_build_object(
      'status', CASE WHEN account_type = CASE p_control WHEN 'REALIZED_FX_GAIN' THEN 'REVENUE' ELSE 'EXPENSE' END AND posting_allowed
                      AND account_currency_code IS NOT DISTINCT FROM p_base AND NOT requires_project AND NOT requires_department AND NOT requires_cost_center THEN 'READY' ELSE 'INVALID' END,
      'count', 1, 'id', id, 'code', account_code, 'name', account_name) FROM candidate)
    ELSE jsonb_build_object('status', 'AMBIGUOUS', 'count', (SELECT count(*) FROM candidate))
  END
$status$;

-- The account a difference posts to, or a refusal before anything is written. Only a real difference ever asks for it.
CREATE FUNCTION abos.loan_fx_account(p_entity uuid, p_difference numeric, p_base text)
RETURNS uuid LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $account$
DECLARE v_control text := CASE WHEN p_difference < 0 THEN 'REALIZED_FX_GAIN' ELSE 'REALIZED_FX_LOSS' END; v_state jsonb;
BEGIN
  v_state := abos.loan_fx_account_status(p_entity, v_control, p_base);
  IF v_state->>'status' = 'MISSING' THEN
    RAISE EXCEPTION '%_ACCOUNT_REQUIRED: create one active % account in the Chart of Accounts first', v_control, v_control USING ERRCODE = 'check_violation';
  ELSIF v_state->>'status' <> 'READY' THEN
    RAISE EXCEPTION 'REALIZED_FX_ACCOUNT_INVALID: keep exactly one active % account, in %, that accepts postings without dimensions', v_control, p_base USING ERRCODE = 'check_violation';
  END IF;
  RETURN (v_state->>'id')::uuid;
END
$account$;

-- ---------------------------------------------------------------------------------------------
-- 5. The repayment lane.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION abos.validate_loan_repayment_journal(p_journal abos.journals, p_intent abos.posting_intents)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $validate$
DECLARE r abos.loan_repayments%ROWTYPE; l abos.loans%ROWTYPE; v_account abos.operational_treasury_accounts%ROWTYPE; v_cash_intent abos.posting_intents%ROWTYPE;
  v_carrying numeric; v_difference numeric; v_fx uuid;
BEGIN
  SELECT * INTO r FROM abos.loan_repayments WHERE id = p_intent.source_id AND legal_entity_id = p_journal.legal_entity_id;
  -- The intent carries the journal's total, which is the larger of the cash and the carrying value. The conversion proves the cash.
  v_cash_intent := p_intent; v_cash_intent.base_amount := r.base_amount;
  IF NOT FOUND OR r.status <> 'POSTED' OR r.journal_id <> p_journal.id OR p_intent.intent_kind <> 'LOAN_REPAYMENT' OR p_intent.loan_repayment_id IS DISTINCT FROM r.id
     OR NOT abos.fx_source_matches(r.legal_entity_id, 'LOAN_REPAYMENT', r.id, r.original_currency_code, r.original_amount, r.base_amount, r.fx_conversion_id, v_cash_intent)
     OR r.business_date <> p_journal.accounting_effective_date OR p_journal.journal_reference <> r.transaction_reference
     OR p_intent.created_by_user_account_id <> r.created_by_user_account_id
     OR p_intent.finance_workflow_policy_version_id IS DISTINCT FROM r.workflow_policy_version_id
     OR NOT (CASE WHEN r.decided_by_user_account_id IS NULL
          THEN p_journal.posted_by_user_account_id = r.created_by_user_account_id
           AND abos.workflow_policy_allows_direct(r.legal_entity_id, ARRAY['LOAN'], r.workflow_policy_version_id)
          ELSE p_journal.posted_by_user_account_id = r.decided_by_user_account_id
           AND r.decided_by_user_account_id <> r.created_by_user_account_id END) THEN
    RAISE EXCEPTION 'repayment journal does not match its record, amount, date, reference, policy or approval' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO l FROM abos.loans WHERE id = r.loan_id AND legal_entity_id = r.legal_entity_id AND status = 'POSTED';
  IF NOT FOUND OR l.original_currency_code <> r.original_currency_code THEN
    RAISE EXCEPTION 'a repayment belongs to a posted loan in its currency' USING ERRCODE = 'check_violation';
  END IF;
  -- This journal is not posted yet, so the position is still the amount owed before it.
  IF (SELECT outstanding FROM abos.loan_position(l.id)) < r.original_amount THEN
    RAISE EXCEPTION 'a repayment cannot exceed what is outstanding on the loan' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_account FROM abos.operational_treasury_accounts WHERE id = r.operational_treasury_account_id
     AND legal_entity_id = r.legal_entity_id AND status = 'ACTIVE';
  IF NOT FOUND OR v_account.currency_code <> r.original_currency_code THEN
    RAISE EXCEPTION 'a loan is repaid only from an active Safe or Saraf account in its currency' USING ERRCODE = 'check_violation';
  END IF;
  -- The settlement is worked out again here, from the journals, and the posted lines must equal it exactly.
  SELECT carrying, difference INTO v_carrying, v_difference FROM abos.loan_repayment_settlement(l, r.original_amount, r.base_amount, r.fx_conversion_id);
  IF p_intent.base_amount <> GREATEST(r.base_amount, v_carrying)
     OR (SELECT count(*) FROM abos.journal_lines x WHERE x.journal_id = p_journal.id) <> (CASE WHEN v_difference = 0 THEN 2 ELSE 3 END) THEN
    RAISE EXCEPTION 'a repayment has one line for each of its liability, its Treasury account and any realized difference' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM abos.journal_lines x WHERE x.journal_id = p_journal.id AND x.line_number = 1
       AND x.ledger_account_id = l.liability_ledger_account_id AND x.base_debit = v_carrying AND x.business_party_id = l.lender_business_party_id)
     OR NOT EXISTS (SELECT 1 FROM abos.journal_lines x WHERE x.journal_id = p_journal.id AND x.line_number = 2
       AND x.ledger_account_id = v_account.ledger_account_id AND x.base_credit = r.base_amount AND x.business_party_id IS NULL) THEN
    RAISE EXCEPTION 'a repayment must debit its loan liability by the carrying value removed and credit its Treasury account by the cash paid' USING ERRCODE = 'check_violation';
  END IF;
  IF v_difference <> 0 THEN
    v_fx := abos.loan_fx_account(r.legal_entity_id, v_difference, r.base_currency_code);
    IF NOT EXISTS (SELECT 1 FROM abos.journal_lines x WHERE x.journal_id = p_journal.id AND x.line_number = 3 AND x.ledger_account_id = v_fx AND x.business_party_id IS NULL
         AND x.base_debit = GREATEST(v_difference, 0) AND x.base_credit = GREATEST(-v_difference, 0)) THEN
      RAISE EXCEPTION 'a realized difference must post to its gain or loss account by its exact amount' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF (SELECT count(*) FROM abos.subledger_entries e JOIN abos.journal_lines x ON x.id = e.journal_line_id WHERE x.journal_id = p_journal.id) <> 2
     OR NOT EXISTS (SELECT 1 FROM abos.subledger_entries e JOIN abos.journal_lines x ON x.id = e.journal_line_id
       WHERE x.journal_id = p_journal.id AND x.line_number = 1 AND e.subledger_type = 'LOAN_PAYABLE'
         AND e.business_party_id = l.lender_business_party_id AND e.base_amount = v_carrying AND e.original_amount = r.original_amount)
     OR NOT EXISTS (SELECT 1 FROM abos.subledger_entries e JOIN abos.journal_lines x ON x.id = e.journal_line_id
       WHERE x.journal_id = p_journal.id AND x.line_number = 2 AND e.subledger_type = 'OPERATIONAL_TREASURY'
         AND e.operational_treasury_account_id = v_account.id AND e.base_amount = -r.base_amount AND e.original_amount = -r.original_amount) THEN
    RAISE EXCEPTION 'a repayment must move its lender''s position and its Treasury account by its exact amounts' USING ERRCODE = 'check_violation';
  END IF;
END
$validate$;

CREATE OR REPLACE FUNCTION abos.loan_repayment_post(p_repayment uuid, p_actor uuid, p_decided boolean)
RETURNS uuid LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $post$
DECLARE r abos.loan_repayments%ROWTYPE; l abos.loans%ROWTYPE; v_account abos.operational_treasury_accounts%ROWTYPE; v_period uuid; v_snapshot text;
  v_journal uuid := gen_random_uuid(); v_intent uuid := gen_random_uuid(); v_carrying numeric; v_difference numeric; v_lines abos.posting_kernel_line[];
BEGIN
  IF current_user <> 'abos_v1_operational_finance_owner' THEN
    RAISE EXCEPTION 'loan posting is internal' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO r FROM abos.loan_repayments WHERE id = p_repayment;
  -- The loan row is the lock: two repayments, or a repayment and a reversal, of one loan run one at a time.
  SELECT * INTO l FROM abos.loans WHERE id = r.loan_id FOR UPDATE;
  SELECT * INTO r FROM abos.loan_repayments WHERE id = p_repayment FOR UPDATE;
  IF (SELECT outstanding FROM abos.loan_position(l.id)) < r.original_amount THEN
    RAISE EXCEPTION 'REPAYMENT_EXCEEDS_OUTSTANDING: a repayment cannot exceed what is outstanding on the loan' USING ERRCODE = 'check_violation';
  END IF;
  v_account := abos.money_treasury_account(r.legal_entity_id, r.operational_treasury_account_id, r.original_currency_code);
  v_period := abos.open_period_for_business_date(r.legal_entity_id, p_actor, r.business_date);
  SELECT exchange_rate_snapshot_id::text INTO v_snapshot FROM abos.fx_conversions WHERE id = r.fx_conversion_id;
  -- 0063: worked out here, under the lock and at posting, so a decision made later still settles what is owed at that moment.
  SELECT carrying, difference INTO v_carrying, v_difference FROM abos.loan_repayment_settlement(l, r.original_amount, r.base_amount, r.fx_conversion_id);
  v_lines := ARRAY[
    ROW(1, 'DEBIT', l.liability_ledger_account_id, l.lender_business_party_id, NULL, NULL, NULL, 'LOAN_PAYABLE', 1, NULL, l.lender_business_party_id)::abos.posting_kernel_line,
    ROW(2, 'CREDIT', v_account.ledger_account_id, NULL, NULL, NULL, NULL, 'OPERATIONAL_TREASURY', -1, v_account.id, NULL)::abos.posting_kernel_line];
  IF v_difference <> 0 THEN
    v_lines := v_lines || ROW(3, CASE WHEN v_difference > 0 THEN 'DEBIT' ELSE 'CREDIT' END, abos.loan_fx_account(r.legal_entity_id, v_difference, r.base_currency_code),
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)::abos.posting_kernel_line;
  END IF;
  PERFORM abos.posting_kernel_draft(
    p_intent_id => v_intent, p_journal_id => v_journal, p_legal_entity_id => r.legal_entity_id, p_source_type => 'LOAN_REPAYMENT', p_source_id => r.id,
    p_original_amount => r.original_amount, p_original_currency_code => r.original_currency_code, p_base_amount => GREATEST(r.base_amount, v_carrying), p_base_currency_code => r.base_currency_code,
    p_accounting_effective_date => r.business_date, p_accounting_period_id => v_period, p_journal_reference => r.transaction_reference, p_correlation_id => r.correlation_id,
    p_idempotency_key => 'LR:' || r.id::text, p_initial_status => CASE WHEN p_decided THEN 'APPROVED' ELSE 'VALIDATED' END, p_created_by_user_account_id => r.created_by_user_account_id,
    p_lines => v_lines, p_conversion_snapshot_reference => v_snapshot, p_finance_workflow_policy_version_id => r.workflow_policy_version_id,
    p_line_base_amounts => CASE WHEN v_difference <> 0 THEN ARRAY[v_carrying, r.base_amount, abs(v_difference)] END);
  UPDATE abos.loan_repayments SET status = 'POSTED', journal_id = v_journal, decided_by_user_account_id = CASE WHEN p_decided THEN p_actor END,
         decided_at = CASE WHEN p_decided THEN clock_timestamp() END WHERE id = r.id;
  PERFORM abos.posting_kernel_commit(v_intent, v_journal, p_actor);
  RETURN v_journal;
END
$post$;

CREATE OR REPLACE FUNCTION abos.finance_loan_repay(p_proof text, p_runtime text, p_token text, p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $repay$
DECLARE c jsonb; actor uuid; entity uuid; req jsonb; amount numeric; day date; key text; correlation uuid; l abos.loans%ROWTYPE; v_account abos.operational_treasury_accounts%ROWTYPE;
  policy uuid; approval boolean; scope text; fingerprint text; replay jsonb; ref text; result jsonb; v_base_amount numeric; v_conversion abos.fx_conversions%ROWTYPE; v_owed numeric; v_pending numeric;
  repayment uuid := gen_random_uuid(); journal uuid; v_carrying numeric; v_difference numeric;
BEGIN
  c := abos.treasury_safe_actor(p_proof, p_runtime, p_token, 'finance.loan.repay');
  actor := (c->>'userAccountId')::uuid; entity := (c->>'legalEntityId')::uuid;
  req := abos.money_request(p_payload, ARRAY['loanId', 'treasuryAccountId', 'amount', 'businessDate', 'reference', 'note', 'exchangeRateId', 'idempotencyKey', 'correlationId']);
  amount := (req->>'amount')::numeric; day := (req->>'date')::date; key := req->>'key'; correlation := (req->>'correlation')::uuid;
  IF abos.money_uuid(p_payload, 'loanId') IS NULL OR abos.money_uuid(p_payload, 'treasuryAccountId') IS NULL THEN
    RAISE EXCEPTION 'choose the loan and the Safe it is repaid from' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  scope := 'loan:repay:' || entity::text || ':' || actor::text;
  fingerprint := encode(sha256(convert_to((p_payload - 'correlationId')::text || actor::text, 'UTF8')), 'hex');
  replay := abos.temporary_funding_idempotency_begin(scope, key, fingerprint, correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  -- The loan row is the lock: repayments and reversals of one loan run one at a time.
  SELECT * INTO l FROM abos.loans WHERE id = abos.money_uuid(p_payload, 'loanId') AND legal_entity_id = entity FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'loan not found in this legal entity' USING ERRCODE = 'no_data_found'; END IF;
  IF l.status <> 'POSTED' THEN RAISE EXCEPTION 'only a posted loan can be repaid' USING ERRCODE = 'check_violation'; END IF;
  IF day < l.business_date THEN RAISE EXCEPTION 'a repayment cannot be dated before its loan' USING ERRCODE = 'check_violation'; END IF;
  SELECT outstanding INTO v_owed FROM abos.loan_position(l.id);
  SELECT COALESCE(sum(r.original_amount), 0) INTO v_pending FROM abos.loan_repayments r WHERE r.loan_id = l.id AND r.status = 'PENDING_APPROVAL';
  IF amount > v_owed - v_pending THEN
    RAISE EXCEPTION 'REPAYMENT_EXCEEDS_OUTSTANDING: a repayment cannot exceed what is outstanding on the loan' USING ERRCODE = 'check_violation';
  END IF;
  v_account := abos.money_treasury_account(entity, abos.money_uuid(p_payload, 'treasuryAccountId'), l.original_currency_code);
  SELECT policy_id, approval_required INTO policy, approval FROM abos.loan_policy(entity);
  IF l.original_currency_code = l.base_currency_code THEN
    v_base_amount := amount;
  ELSE
    v_conversion := abos.fx_convert(entity, 'LOAN_REPAYMENT', repayment, l.original_currency_code, day, abos.money_uuid(p_payload, 'exchangeRateId'), actor, amount);
    v_base_amount := v_conversion.base_amount;
  END IF;
  -- 0063: a repayment that would realize a difference is refused here if its account is missing, before anything waits for approval.
  SELECT carrying, difference INTO v_carrying, v_difference FROM abos.loan_repayment_settlement(l, amount, v_base_amount, v_conversion.id);
  IF v_difference <> 0 THEN PERFORM abos.loan_fx_account(entity, v_difference, l.base_currency_code); END IF;
  ref := 'LR-' || to_char(day, 'YYYYMMDD') || '-' || upper(replace(repayment::text, '-', ''));
  INSERT INTO abos.loan_repayments (id, legal_entity_id, loan_id, operational_treasury_account_id, original_amount, original_currency_code, base_amount, base_currency_code,
    fx_conversion_id, business_date, reference, note, transaction_reference, status, workflow_policy_version_id, created_by_user_account_id, correlation_id, idempotency_key)
  VALUES (repayment, entity, l.id, v_account.id, amount, l.original_currency_code, v_base_amount, l.base_currency_code, v_conversion.id, day,
    NULLIF(btrim(p_payload->>'reference'), ''), NULLIF(btrim(p_payload->>'note'), ''), ref, 'PENDING_APPROVAL', policy, actor, correlation, key);
  IF NOT approval THEN journal := abos.loan_repayment_post(repayment, actor, false); END IF;
  result := jsonb_build_object('repaymentId', repayment, 'loanId', l.id, 'journalId', journal, 'reference', ref, 'currencyCode', l.original_currency_code, 'amount', amount::text,
    'baseAmount', v_base_amount::text, 'status', CASE WHEN approval THEN 'PENDING_APPROVAL' ELSE 'POSTED' END, 'replayed', false);
  -- Known only once posted: a pending repayment settles what is owed when it is approved. Positive is a gain.
  IF NOT approval THEN result := result || jsonb_build_object('carryingAmount', v_carrying::text, 'realizedFx', (-v_difference)::text); END IF;
  PERFORM abos.money_audit(actor, entity, correlation, 'LOAN_REPAYMENT_RECORDED', 'LOAN_REPAYMENT', repayment, result || jsonb_build_object('treasuryAccountId', v_account.id, 'businessDate', day));
  PERFORM abos.temporary_funding_idempotency_complete(scope, key, 'LOAN_REPAYMENT', repayment, result);
  RETURN result;
END
$repay$;

-- ---------------------------------------------------------------------------------------------
-- 6. What the reports and the setup screens read.
-- ---------------------------------------------------------------------------------------------
-- A journal's realized difference: positive is a gain. A reversal comes out as the opposite on its own, from its own lines.
CREATE FUNCTION abos.loan_journal_realized_fx(p_journal uuid)
RETURNS numeric LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $realized$
  SELECT COALESCE(sum(line.base_credit - line.base_debit), 0) FROM abos.journal_lines line JOIN abos.ledger_accounts account ON account.id = line.ledger_account_id
   WHERE line.journal_id = p_journal AND account.control_account_type IN ('REALIZED_FX_GAIN', 'REALIZED_FX_LOSS')
$realized$;

CREATE OR REPLACE FUNCTION abos.finance_loan_statement(p_proof text, p_runtime text, p_token text, p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $statement$
DECLARE c jsonb; entity uuid; perms jsonb; l abos.loans%ROWTYPE; loan_id uuid; range jsonb; v_from date; v_to date; opening record; closing record; lines jsonb; ledger_base numeric; loans_base numeric; realized numeric;
BEGIN
  c := abos.treasury_safe_actor(p_proof, p_runtime, p_token, 'finance.loan.read');
  entity := (c->>'legalEntityId')::uuid; perms := COALESCE(c->'permissions', '[]'::jsonb);
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_payload) k WHERE k NOT IN ('loanId', 'periodId', 'from', 'to', 'asOf', 'fiscalYearId')) THEN
    RAISE EXCEPTION 'unknown report fields' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  loan_id := abos.money_uuid(p_payload, 'loanId');
  SELECT * INTO l FROM abos.loans WHERE id = loan_id AND legal_entity_id = entity;
  IF NOT FOUND THEN RAISE EXCEPTION 'loan not found in this legal entity' USING ERRCODE = 'no_data_found'; END IF;
  range := abos.report_range(entity, p_payload - 'loanId');
  v_from := (range->>'from')::date; v_to := (range->>'to')::date;
  SELECT * INTO opening FROM abos.loan_position(l.id, v_from - 1);
  SELECT * INTO closing FROM abos.loan_position(l.id, v_to);
  SELECT COALESCE(jsonb_agg(jsonb_build_object('journalId', x.journal_id, 'date', x.day, 'kind', x.kind, 'reference', abos.report_journal_reference(x.journal_id, perms),
      'amount', abs(x.amount)::text, 'baseAmount', abs(x.base)::text, 'treasuryBaseAmount', x.cash::text, 'realizedFx', x.fx::text, 'effect', (-x.amount)::text, 'balance', (opening.outstanding - x.running)::text,
      'treasury', x.treasury, 'source', abos.report_journal_source(entity, x.journal_id, perms, true)) ORDER BY x.day, x.posted_at, x.journal_id), '[]'::jsonb)
    INTO lines
    FROM (SELECT y.*, sum(y.amount) OVER (ORDER BY y.day, y.posted_at, y.journal_id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running
            FROM (SELECT j.journal_id, j.kind, journal.accounting_effective_date AS day, journal.posted_at, entry.original_amount AS amount, entry.base_amount AS base,
                         (SELECT jsonb_build_object('id', t.id, 'nameEn', t.name_en, 'nameFa', t.name_fa) FROM abos.subledger_entries te JOIN abos.journal_lines tl ON tl.id = te.journal_line_id
                            JOIN abos.operational_treasury_accounts t ON t.id = te.operational_treasury_account_id
                           WHERE tl.journal_id = j.journal_id AND te.subledger_type = 'OPERATIONAL_TREASURY' LIMIT 1) AS treasury,
                         (SELECT abs(te.base_amount) FROM abos.subledger_entries te JOIN abos.journal_lines tl ON tl.id = te.journal_line_id
                           WHERE tl.journal_id = j.journal_id AND te.subledger_type = 'OPERATIONAL_TREASURY' LIMIT 1) AS cash,
                         abos.loan_journal_realized_fx(j.journal_id) AS fx
                    FROM abos.loan_journals(l.id) j
                    JOIN abos.journals journal ON journal.id = j.journal_id AND journal.status = 'POSTED'
                    JOIN abos.journal_lines line ON line.journal_id = journal.id
                    JOIN abos.subledger_entries entry ON entry.journal_line_id = line.id AND entry.subledger_type = 'LOAN_PAYABLE'
                   WHERE journal.accounting_effective_date BETWEEN v_from AND v_to) y) x;
  SELECT COALESCE(sum(abos.loan_journal_realized_fx(j.journal_id)), 0) INTO realized FROM abos.loan_journals(l.id) j
    JOIN abos.journals journal ON journal.id = j.journal_id AND journal.status = 'POSTED' WHERE journal.accounting_effective_date BETWEEN v_from AND v_to;
  -- Everything owed on this liability account, loan by loan, against the account itself.
  SELECT COALESCE(sum(b.opening_credit - b.opening_debit + b.period_credit - b.period_debit), 0) INTO ledger_base
    FROM abos.report_account_balances(entity, v_from, v_to) b WHERE b.ledger_account_id = l.liability_ledger_account_id;
  SELECT COALESCE(sum(p.base_outstanding), 0) INTO loans_base FROM abos.loans o CROSS JOIN LATERAL abos.loan_position(o.id, v_to) p
   WHERE o.legal_entity_id = entity AND o.liability_ledger_account_id = l.liability_ledger_account_id AND o.status = 'POSTED';
  RETURN jsonb_build_object('legalEntityId', entity, 'range', range, 'loan', jsonb_build_object('id', l.id, 'transactionReference', l.transaction_reference, 'reference', l.reference, 'note', l.note,
      'status', l.status, 'lenderType', l.lender_type, 'lender', (SELECT jsonb_build_object('id', b.id, 'name', b.display_name) FROM abos.business_parties b WHERE b.id = l.lender_business_party_id),
      'currency', l.original_currency_code, 'principal', l.original_amount::text, 'basePrincipal', l.base_amount::text, 'date', l.business_date,
      'liability', (SELECT jsonb_build_object('id', a.id, 'code', a.account_code, 'name', a.account_name) FROM abos.ledger_accounts a WHERE a.id = l.liability_ledger_account_id), 'journalId', l.journal_id),
    'opening', jsonb_build_object('native', opening.outstanding::text, 'base', opening.base_outstanding::text),
    'closing', jsonb_build_object('native', closing.outstanding::text, 'base', closing.base_outstanding::text),
    'lines', lines, 'realizedFx', realized::text,
    'reconciliation', jsonb_build_object('loansBase', loans_base::text, 'ledgerBase', ledger_base::text, 'matches', loans_base = ledger_base));
END
$statement$;

-- What the loan screens still need. It names account roles and the reader's own permissions, and nothing about any lender or loan.
CREATE FUNCTION abos.finance_loan_readiness(p_proof text, p_runtime text, p_token text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $readiness$
DECLARE c jsonb; entity uuid; perms jsonb; base text;
BEGIN
  c := abos.treasury_safe_actor(p_proof, p_runtime, p_token, NULL);
  entity := (c->>'legalEntityId')::uuid; perms := COALESCE(c->'permissions', '[]'::jsonb);
  IF NOT perms ?| ARRAY['finance.loan.read', 'finance.loan.record', 'finance.loan.repay', 'finance.loan.approve', 'finance.ledger-account.manage', 'admin.roles.manage',
       'shareholder.capital-receipt.record', 'treasury.opening-balance.record'] THEN
    RAISE EXCEPTION 'current authority is missing finance.loan.read' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT base_currency_code INTO base FROM abos.legal_entities WHERE id = entity;
  RETURN jsonb_build_object('legalEntityId', entity, 'baseCurrency', base,
    'approvalRequired', COALESCE((SELECT v.approval_required FROM abos.finance_workflow_policy_versions v WHERE v.legal_entity_id = entity AND v.workflow_type = 'LOAN' ORDER BY v.version DESC LIMIT 1), false),
    'accounts', (SELECT jsonb_agg(jsonb_build_object('control', a.control, 'accountType', a.kind, 'status', a.status) ORDER BY a.position) FROM (
      SELECT 1 AS position, 'SHAREHOLDER_LOAN' AS control, 'LIABILITY' AS kind, abos.loan_liability_status(entity, 'SHAREHOLDER_LOAN', base) AS status
      UNION ALL SELECT 2, 'LOAN_PAYABLE', 'LIABILITY', abos.loan_liability_status(entity, 'LOAN_PAYABLE', base)
      UNION ALL SELECT 3, 'REALIZED_FX_GAIN', 'REVENUE', abos.loan_fx_account_status(entity, 'REALIZED_FX_GAIN', base)->>'status'
      UNION ALL SELECT 4, 'REALIZED_FX_LOSS', 'EXPENSE', abos.loan_fx_account_status(entity, 'REALIZED_FX_LOSS', base)->>'status') a),
    'permissions', jsonb_build_object('canRead', perms ? 'finance.loan.read', 'canRecord', perms ? 'finance.loan.record', 'canRepay', perms ? 'finance.loan.repay', 'canApprove', perms ? 'finance.loan.approve'),
    'canManageAccounts', perms ? 'finance.ledger-account.manage', 'canManageRoles', perms ? 'admin.roles.manage');
END
$readiness$;

-- A liability role is READY with one usable account or several: a loan chooses among several when it is recorded.
CREATE FUNCTION abos.loan_liability_status(p_entity uuid, p_control text, p_base text)
RETURNS text LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $liability$
  SELECT CASE WHEN EXISTS (SELECT 1 FROM abos.ledger_accounts a WHERE a.legal_entity_id = p_entity AND a.status = 'ACTIVE' AND a.posting_allowed AND a.account_type = 'LIABILITY'
      AND a.control_account_type = p_control AND (a.account_currency_code IS NULL OR a.account_currency_code = p_base)
      AND NOT a.requires_project AND NOT a.requires_department AND NOT a.requires_cost_center) THEN 'READY' ELSE 'MISSING' END
$liability$;

-- ---------------------------------------------------------------------------------------------
-- 7. Privileges. The kernel keeps the grants it had; the new helpers are internal; the runtime reaches one new entry point.
-- ---------------------------------------------------------------------------------------------
REVOKE ALL ON FUNCTION abos.posting_kernel_draft(uuid, uuid, uuid, text, uuid, numeric, text, numeric, text, date, uuid,
  text, uuid, text, text, uuid, abos.posting_kernel_line[], uuid, uuid, uuid, text, uuid, integer, numeric[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION abos.posting_kernel_draft(uuid, uuid, uuid, text, uuid, numeric, text, numeric, text, date, uuid,
  text, uuid, text, text, uuid, abos.posting_kernel_line[], uuid, uuid, uuid, text, uuid, integer, numeric[]) TO abos_v1_operational_finance_owner;

REVOKE ALL ON FUNCTION abos.loan_carrying_share(numeric, numeric, numeric, integer), abos.loan_repayment_settlement(abos.loans, numeric, numeric, uuid),
  abos.loan_fx_account_status(uuid, text, text), abos.loan_fx_account(uuid, numeric, text), abos.loan_journal_realized_fx(uuid), abos.loan_liability_status(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION abos.loan_carrying_share(numeric, numeric, numeric, integer), abos.loan_repayment_settlement(abos.loans, numeric, numeric, uuid),
  abos.loan_fx_account_status(uuid, text, text), abos.loan_fx_account(uuid, numeric, text), abos.loan_journal_realized_fx(uuid), abos.loan_liability_status(uuid, text, text)
  TO abos_v1_operational_finance_owner;

ALTER FUNCTION abos.finance_loan_readiness(text, text, text) OWNER TO abos_v1_operational_finance_owner;
REVOKE ALL ON FUNCTION abos.finance_loan_readiness(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION abos.finance_loan_readiness(text, text, text) TO abos_e1_runtime;
