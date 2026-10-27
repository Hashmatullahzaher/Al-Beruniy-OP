-- Slice 3, part 1: one subledger sign convention and one balance read model. Additive for data.
--
-- Convention: every subledger entry's signed amount has the sign of its journal line - debit is
-- positive, credit is negative - for original and base amounts. For Treasury: a positive movement
-- increases the Safe, a negative one decreases it. Every Treasury movement and every shareholder
-- capital movement already follows it; the temporary-funding payable did not (credit was positive).
--
-- This migration
-- 1. refuses to run if any existing subledger row breaks the convention or any temporary-funding
--    payable row exists (posted rows are immutable and cannot be re-signed; production has none);
-- 2. makes the posting kernel enforce the convention for every ACTIVE source;
-- 3. restates the two temporary-funding writers and their validators so the payable is recorded
--    debit +, credit - (only the sign of that one movement changes);
-- 4. adds the internal balance read model - Treasury balances, Treasury movements, ledger account
--    balances and shareholder capital - executable only by the operational Finance owner;
-- 5. restates the daily report's Safe positions and the temporary-funding workspace to read it
--    (the payable owed stays a positive figure: it is read as -sum).

DO $precheck$
DECLARE v_payable bigint; v_unsigned bigint;
BEGIN
  SELECT count(*) INTO v_payable FROM abos.subledger_entries WHERE subledger_type = 'TEMPORARY_FUNDING_PAYABLE';
  IF v_payable > 0 THEN
    RAISE EXCEPTION '0045 cannot re-sign % posted temporary-funding payable movement(s); posted rows are immutable', v_payable
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*) INTO v_unsigned
    FROM abos.subledger_entries entry
    JOIN abos.journal_lines line ON line.id = entry.journal_line_id
   WHERE sign(entry.base_amount) <> CASE WHEN line.base_debit > 0 THEN 1 ELSE -1 END
      OR (entry.original_amount IS NOT NULL
          AND sign(entry.original_amount) <> CASE WHEN line.base_debit > 0 THEN 1 ELSE -1 END);
  IF v_unsigned > 0 THEN
    RAISE EXCEPTION '0045 found % subledger movement(s) that do not follow debit = positive, credit = negative', v_unsigned
      USING ERRCODE = 'check_violation';
  END IF;
END
$precheck$;

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
    ELSE
      RAISE EXCEPTION 'operational posting source % has no validator', v_source.source_type
        USING ERRCODE = 'check_violation';
  END CASE;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION abos.temporary_funding_post(p_funding_id uuid, p_actor_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  funding abos.temporary_fundings%ROWTYPE;
  v_payable uuid; v_debit_ledger uuid; v_debit_party uuid; v_period uuid;
  v_intent uuid := gen_random_uuid(); v_journal uuid := gen_random_uuid();
  v_debit_line uuid := gen_random_uuid(); v_credit_line uuid := gen_random_uuid();
BEGIN
  IF current_user <> 'abos_v1_operational_finance_owner' THEN
    RAISE EXCEPTION 'temporary funding posting helper is internal' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO funding FROM abos.temporary_fundings WHERE id = p_funding_id FOR UPDATE;
  IF funding.status <> 'PENDING_APPROVAL' OR NOT EXISTS (
    SELECT 1 FROM abos.temporary_funding_decisions decision
     WHERE decision.temporary_funding_id = funding.id AND decision.legal_entity_id = funding.legal_entity_id
       AND decision.decision = 'APPROVED' AND decision.decided_by_user_account_id = p_actor_id) THEN
    RAISE EXCEPTION 'temporary funding has no approval from the posting actor' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT payable_ledger_account_id INTO v_payable FROM abos.temporary_funding_account_mapping_versions
   WHERE id = funding.mapping_version_id AND legal_entity_id = funding.legal_entity_id;
  IF funding.funding_mode = 'PROVIDER_PAID_EXPENSE_DIRECTLY' THEN
    SELECT category.ledger_account_id INTO v_debit_ledger FROM abos.operational_expense_categories category
     WHERE category.id = funding.operational_expense_category_id
       AND category.legal_entity_id = funding.legal_entity_id AND category.status = 'ACTIVE';
    v_debit_party := funding.payee_business_party_id;
    IF v_debit_ledger IS NULL THEN
      RAISE EXCEPTION 'the funding expense category must remain active' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    v_debit_ledger := abos.temporary_funding_treasury_ledger(
      funding.legal_entity_id, funding.operational_treasury_account_id, funding.base_currency_code, true);
    v_debit_party := NULL;
  END IF;
  v_period := abos.temporary_funding_open_period(funding.legal_entity_id, funding.business_date);

  INSERT INTO abos.posting_intents
    (id, legal_entity_id, project_id, department_id, cost_center_id, source_type, source_id, intent_kind,
     original_amount, original_currency_code, base_amount, base_currency_code, accounting_effective_date,
     correlation_id, idempotency_key, status, created_by_user_account_id, processing_model,
     temporary_funding_id, finance_workflow_policy_version_id, temporary_funding_mapping_version_id,
     operational_version)
  VALUES
    (v_intent, funding.legal_entity_id, funding.project_id, funding.department_id, funding.cost_center_id,
     'TEMPORARY_FUNDING', funding.id, 'TEMPORARY_FUNDING', funding.original_amount,
     funding.original_currency_code, funding.base_amount, funding.base_currency_code, funding.business_date,
     funding.correlation_id, 'TFP:' || funding.id::text, 'APPROVED', funding.created_by_user_account_id,
     'OPERATIONAL_V1', funding.id, funding.workflow_policy_version_id, funding.mapping_version_id, 1);
  INSERT INTO abos.journals
    (id, legal_entity_id, accounting_period_id, posting_intent_id, journal_reference, accounting_effective_date,
     base_currency_code, status, created_by_user_account_id, processing_model)
  VALUES
    (v_journal, funding.legal_entity_id, v_period, v_intent, 'TFP-' || replace(funding.id::text, '-', ''),
     funding.business_date, funding.base_currency_code, 'DRAFT', funding.created_by_user_account_id,
     'OPERATIONAL_V1');
  INSERT INTO abos.journal_lines
    (id, journal_id, legal_entity_id, line_number, ledger_account_id, business_party_id, project_id,
     department_id, cost_center_id, original_amount, original_currency_code, base_debit, base_credit,
     base_currency_code, conversion_snapshot_reference, source_type, source_id, processing_model)
  VALUES
    (v_debit_line, v_journal, funding.legal_entity_id, 1, v_debit_ledger, v_debit_party,
     funding.project_id, funding.department_id, funding.cost_center_id, funding.original_amount,
     funding.original_currency_code, funding.base_amount, 0, funding.base_currency_code, NULL,
     'TEMPORARY_FUNDING', funding.id, 'OPERATIONAL_V1'),
    (v_credit_line, v_journal, funding.legal_entity_id, 2, v_payable, funding.provider_business_party_id,
     NULL, NULL, NULL, funding.original_amount, funding.original_currency_code, 0, funding.base_amount,
     funding.base_currency_code, NULL, 'TEMPORARY_FUNDING', funding.id, 'OPERATIONAL_V1');
  INSERT INTO abos.subledger_entries
    (id, legal_entity_id, journal_line_id, subledger_type, business_party_id, temporary_funding_id,
     original_amount, original_currency_code, base_amount, base_currency_code, source_type, source_id,
     processing_model)
  VALUES
    (gen_random_uuid(), funding.legal_entity_id, v_credit_line, 'TEMPORARY_FUNDING_PAYABLE',
     funding.provider_business_party_id, funding.id, -funding.original_amount, funding.original_currency_code,
     -funding.base_amount, funding.base_currency_code, 'TEMPORARY_FUNDING', funding.id, 'OPERATIONAL_V1');
  IF funding.funding_mode = 'PROVIDER_FUNDED_SAFE' THEN
    INSERT INTO abos.subledger_entries
      (id, legal_entity_id, journal_line_id, subledger_type, operational_treasury_account_id,
       original_amount, original_currency_code, base_amount, base_currency_code, source_type, source_id,
       processing_model)
    VALUES
      (gen_random_uuid(), funding.legal_entity_id, v_debit_line, 'OPERATIONAL_TREASURY',
       funding.operational_treasury_account_id, funding.original_amount, funding.original_currency_code,
       funding.base_amount, funding.base_currency_code, 'TEMPORARY_FUNDING', funding.id, 'OPERATIONAL_V1');
  END IF;
  UPDATE abos.temporary_fundings
     SET status = 'POSTED', journal_id = v_journal, version = version + 1, updated_at = clock_timestamp()
   WHERE id = funding.id;
  UPDATE abos.posting_intents SET status = 'POSTED', operational_version = operational_version + 1
   WHERE id = v_intent;
  UPDATE abos.journals SET status = 'POSTED', posted_by_user_account_id = p_actor_id, posted_at = clock_timestamp()
   WHERE id = v_journal;
  PERFORM abos.temporary_funding_audit(p_actor_id, funding.legal_entity_id, funding.correlation_id,
    'TEMPORARY_FUNDING_POSTED', 'TEMPORARY_FUNDING', funding.id,
    jsonb_build_object('temporaryFundingId', funding.id, 'postingIntentId', v_intent, 'journalId', v_journal,
      'fundingMode', funding.funding_mode, 'providerBusinessPartyId', funding.provider_business_party_id,
      'amount', funding.original_amount::text, 'currency', funding.original_currency_code,
      'mappingVersionId', funding.mapping_version_id, 'workflowPolicyVersionId', funding.workflow_policy_version_id));
  RETURN v_journal;
END
$function$;

CREATE OR REPLACE FUNCTION abos.temporary_funding_settlement_post(p_settlement_id uuid, p_actor_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  settlement abos.temporary_funding_settlements%ROWTYPE;
  funding abos.temporary_fundings%ROWTYPE;
  v_payable uuid; v_treasury_ledger uuid; v_settled numeric; v_period uuid;
  v_intent uuid := gen_random_uuid(); v_journal uuid := gen_random_uuid();
  v_debit_line uuid := gen_random_uuid(); v_credit_line uuid := gen_random_uuid();
BEGIN
  IF current_user <> 'abos_v1_operational_finance_owner' THEN
    RAISE EXCEPTION 'temporary funding posting helper is internal' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Lock order everywhere: funding, then settlement.
  SELECT funding_row.* INTO funding FROM abos.temporary_fundings funding_row
   WHERE funding_row.id = (SELECT temporary_funding_id FROM abos.temporary_funding_settlements WHERE id = p_settlement_id)
   FOR UPDATE;
  SELECT * INTO settlement FROM abos.temporary_funding_settlements WHERE id = p_settlement_id FOR UPDATE;
  IF settlement.status <> 'PENDING_APPROVAL' OR funding.status <> 'POSTED' OR NOT EXISTS (
    SELECT 1 FROM abos.temporary_funding_settlement_decisions decision
     WHERE decision.settlement_id = settlement.id AND decision.legal_entity_id = settlement.legal_entity_id
       AND decision.decision = 'APPROVED' AND decision.decided_by_user_account_id = p_actor_id) THEN
    RAISE EXCEPTION 'settlement has no approval from the posting actor' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT COALESCE(sum(base_amount), 0) INTO v_settled FROM abos.temporary_funding_settlements
   WHERE temporary_funding_id = funding.id AND legal_entity_id = funding.legal_entity_id AND status = 'POSTED';
  IF v_settled + settlement.base_amount > funding.base_amount THEN
    RAISE EXCEPTION 'settlement would exceed the outstanding temporary funding payable'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT payable_ledger_account_id INTO v_payable FROM abos.temporary_funding_account_mapping_versions
   WHERE id = funding.mapping_version_id AND legal_entity_id = funding.legal_entity_id;
  v_treasury_ledger := abos.temporary_funding_treasury_ledger(
    settlement.legal_entity_id, settlement.operational_treasury_account_id, settlement.base_currency_code, false);
  v_period := abos.temporary_funding_open_period(settlement.legal_entity_id, settlement.business_date);

  INSERT INTO abos.posting_intents
    (id, legal_entity_id, source_type, source_id, intent_kind, original_amount, original_currency_code,
     base_amount, base_currency_code, accounting_effective_date, correlation_id, idempotency_key, status,
     created_by_user_account_id, processing_model, temporary_funding_id, temporary_funding_settlement_id,
     finance_workflow_policy_version_id, temporary_funding_mapping_version_id, operational_version)
  VALUES
    (v_intent, settlement.legal_entity_id, 'TEMPORARY_FUNDING_SETTLEMENT', settlement.id,
     'TEMPORARY_FUNDING_SETTLEMENT', settlement.original_amount, settlement.original_currency_code,
     settlement.base_amount, settlement.base_currency_code, settlement.business_date, settlement.correlation_id,
     'TFS:' || settlement.id::text, 'APPROVED', settlement.created_by_user_account_id, 'OPERATIONAL_V1',
     funding.id, settlement.id, settlement.workflow_policy_version_id, funding.mapping_version_id, 1);
  INSERT INTO abos.journals
    (id, legal_entity_id, accounting_period_id, posting_intent_id, journal_reference, accounting_effective_date,
     base_currency_code, status, created_by_user_account_id, processing_model)
  VALUES
    (v_journal, settlement.legal_entity_id, v_period, v_intent, 'TFS-' || replace(settlement.id::text, '-', ''),
     settlement.business_date, settlement.base_currency_code, 'DRAFT', settlement.created_by_user_account_id,
     'OPERATIONAL_V1');
  INSERT INTO abos.journal_lines
    (id, journal_id, legal_entity_id, line_number, ledger_account_id, business_party_id, project_id,
     department_id, cost_center_id, original_amount, original_currency_code, base_debit, base_credit,
     base_currency_code, conversion_snapshot_reference, source_type, source_id, processing_model)
  VALUES
    (v_debit_line, v_journal, settlement.legal_entity_id, 1, v_payable, funding.provider_business_party_id,
     NULL, NULL, NULL, settlement.original_amount, settlement.original_currency_code, settlement.base_amount, 0,
     settlement.base_currency_code, NULL, 'TEMPORARY_FUNDING_SETTLEMENT', settlement.id, 'OPERATIONAL_V1'),
    (v_credit_line, v_journal, settlement.legal_entity_id, 2, v_treasury_ledger, NULL, NULL, NULL, NULL,
     settlement.original_amount, settlement.original_currency_code, 0, settlement.base_amount,
     settlement.base_currency_code, NULL, 'TEMPORARY_FUNDING_SETTLEMENT', settlement.id, 'OPERATIONAL_V1');
  INSERT INTO abos.subledger_entries
    (id, legal_entity_id, journal_line_id, subledger_type, business_party_id, temporary_funding_id,
     temporary_funding_settlement_id, original_amount, original_currency_code, base_amount, base_currency_code,
     source_type, source_id, processing_model)
  VALUES
    (gen_random_uuid(), settlement.legal_entity_id, v_debit_line, 'TEMPORARY_FUNDING_PAYABLE',
     funding.provider_business_party_id, funding.id, settlement.id, settlement.original_amount,
     settlement.original_currency_code, settlement.base_amount, settlement.base_currency_code,
     'TEMPORARY_FUNDING_SETTLEMENT', settlement.id, 'OPERATIONAL_V1');
  INSERT INTO abos.subledger_entries
    (id, legal_entity_id, journal_line_id, subledger_type, operational_treasury_account_id,
     original_amount, original_currency_code, base_amount, base_currency_code, source_type, source_id,
     processing_model)
  VALUES
    (gen_random_uuid(), settlement.legal_entity_id, v_credit_line, 'OPERATIONAL_TREASURY',
     settlement.operational_treasury_account_id, -settlement.original_amount, settlement.original_currency_code,
     -settlement.base_amount, settlement.base_currency_code, 'TEMPORARY_FUNDING_SETTLEMENT', settlement.id,
     'OPERATIONAL_V1');
  UPDATE abos.temporary_funding_settlements
     SET status = 'POSTED', journal_id = v_journal, version = version + 1, updated_at = clock_timestamp()
   WHERE id = settlement.id;
  UPDATE abos.posting_intents SET status = 'POSTED', operational_version = operational_version + 1
   WHERE id = v_intent;
  UPDATE abos.journals SET status = 'POSTED', posted_by_user_account_id = p_actor_id, posted_at = clock_timestamp()
   WHERE id = v_journal;
  PERFORM abos.temporary_funding_audit(p_actor_id, settlement.legal_entity_id, settlement.correlation_id,
    'TEMPORARY_FUNDING_SETTLEMENT_POSTED', 'TEMPORARY_FUNDING_SETTLEMENT', settlement.id,
    jsonb_build_object('settlementId', settlement.id, 'temporaryFundingId', funding.id,
      'postingIntentId', v_intent, 'journalId', v_journal, 'amount', settlement.original_amount::text,
      'currency', settlement.original_currency_code,
      'outstandingAfter', (funding.base_amount - v_settled - settlement.base_amount)::text));
  RETURN v_journal;
END
$function$;

CREATE OR REPLACE FUNCTION abos.validate_temporary_funding_journal(p_journal abos.journals, p_intent abos.posting_intents)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  v_funding abos.temporary_fundings%ROWTYPE;
  v_mapping record; v_policy record;
  v_debit_ledger uuid; v_debit_party uuid; v_amount numeric; v_subledger_count bigint;
BEGIN
  IF p_intent.intent_kind <> 'TEMPORARY_FUNDING' OR p_intent.original_currency_code <> p_intent.base_currency_code
     OR p_intent.original_amount <> p_intent.base_amount THEN
    RAISE EXCEPTION 'temporary funding posting requires its posted base-currency intent'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT policy.id, policy.approval_required INTO v_policy FROM abos.finance_workflow_policy_versions policy
   WHERE policy.id = p_intent.finance_workflow_policy_version_id AND policy.legal_entity_id = p_journal.legal_entity_id
     AND policy.workflow_type = 'TEMPORARY_FUNDING';
  SELECT mapping.id, mapping.payable_ledger_account_id, ledger.status, ledger.posting_allowed,
         ledger.account_type, ledger.control_account_type
    INTO v_mapping
    FROM abos.temporary_funding_account_mapping_versions mapping
    JOIN abos.ledger_accounts ledger
      ON ledger.id = mapping.payable_ledger_account_id AND ledger.legal_entity_id = mapping.legal_entity_id
   WHERE mapping.id = p_intent.temporary_funding_mapping_version_id AND mapping.legal_entity_id = p_journal.legal_entity_id;
  IF v_policy.id IS NULL OR v_policy.approval_required IS NOT TRUE
     OR v_mapping.id IS NULL OR v_mapping.status <> 'ACTIVE' OR NOT v_mapping.posting_allowed
     OR v_mapping.account_type <> 'LIABILITY' OR v_mapping.control_account_type <> 'TEMPORARY_FUNDING_PAYABLE' THEN
    RAISE EXCEPTION 'temporary funding posting requires its approval-required policy and controlled payable mapping'
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM abos.journal_lines line
              WHERE line.journal_id = p_journal.id AND line.original_amount <> p_intent.original_amount) THEN
    RAISE EXCEPTION 'temporary funding journal line violates source, currency, account or dimension rules'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_funding FROM abos.temporary_fundings
   WHERE id = p_intent.temporary_funding_id AND legal_entity_id = p_journal.legal_entity_id;
  IF NOT FOUND OR v_funding.status <> 'POSTED' OR v_funding.journal_id IS DISTINCT FROM p_journal.id
     OR v_funding.base_amount <> p_intent.base_amount OR v_funding.business_date <> p_journal.accounting_effective_date
     OR v_funding.workflow_policy_version_id <> v_policy.id OR v_funding.mapping_version_id <> v_mapping.id THEN
    RAISE EXCEPTION 'temporary funding, intent and journal do not agree' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM abos.temporary_funding_decisions decision
                  WHERE decision.temporary_funding_id = v_funding.id AND decision.decision = 'APPROVED'
                    AND decision.decided_by_user_account_id = p_journal.posted_by_user_account_id)
     OR p_journal.posted_by_user_account_id = v_funding.created_by_user_account_id
     OR p_journal.posted_by_user_account_id IS NOT DISTINCT FROM v_funding.provider_user_account_id THEN
    RAISE EXCEPTION 'temporary funding must be posted by its independent approver'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  v_amount := v_funding.base_amount;
  IF v_funding.funding_mode = 'PROVIDER_PAID_EXPENSE_DIRECTLY' THEN
    SELECT category.ledger_account_id INTO v_debit_ledger FROM abos.operational_expense_categories category
      JOIN abos.ledger_accounts ledger ON ledger.id = category.ledger_account_id
       AND ledger.legal_entity_id = category.legal_entity_id AND ledger.account_type = 'EXPENSE'
     WHERE category.id = v_funding.operational_expense_category_id
       AND category.legal_entity_id = p_journal.legal_entity_id AND category.status = 'ACTIVE';
    v_debit_party := v_funding.payee_business_party_id;
  ELSE
    SELECT account.ledger_account_id INTO v_debit_ledger FROM abos.operational_treasury_accounts account
      JOIN abos.ledger_accounts ledger ON ledger.id = account.ledger_account_id
       AND ledger.legal_entity_id = account.legal_entity_id
     WHERE account.id = v_funding.operational_treasury_account_id AND account.legal_entity_id = p_journal.legal_entity_id
       AND account.status = 'ACTIVE' AND account.currency_code = p_journal.base_currency_code
       AND account.account_type IN ('SAFE', 'CASH_BOX', 'PETTY_CASH')
       AND ledger.account_type = 'ASSET' AND ledger.control_account_type = 'CASH'
       AND NOT ledger.requires_project AND NOT ledger.requires_department AND NOT ledger.requires_cost_center;
    v_debit_party := NULL;
  END IF;
  IF v_debit_ledger IS NULL OR NOT EXISTS (
       SELECT 1 FROM abos.journal_lines line WHERE line.journal_id = p_journal.id AND line.line_number = 1
          AND line.ledger_account_id = v_debit_ledger AND line.base_debit = v_amount AND line.base_credit = 0
          AND line.business_party_id IS NOT DISTINCT FROM v_debit_party
          AND line.project_id IS NOT DISTINCT FROM v_funding.project_id
          AND line.department_id IS NOT DISTINCT FROM v_funding.department_id
          AND line.cost_center_id IS NOT DISTINCT FROM v_funding.cost_center_id)
     OR NOT EXISTS (
       SELECT 1 FROM abos.journal_lines line WHERE line.journal_id = p_journal.id AND line.line_number = 2
          AND line.ledger_account_id = v_mapping.payable_ledger_account_id
          AND line.base_debit = 0 AND line.base_credit = v_amount
          AND line.business_party_id = v_funding.provider_business_party_id
          AND line.project_id IS NULL AND line.department_id IS NULL AND line.cost_center_id IS NULL) THEN
    RAISE EXCEPTION 'temporary funding journal must debit its expense or Safe and credit the provider payable'
      USING ERRCODE = 'check_violation';
  END IF;
  -- The provider payable on line 2 always; a Safe inflow on line 1 only when the provider funded the Safe.
  SELECT count(*) INTO v_subledger_count FROM abos.subledger_entries entry
    JOIN abos.journal_lines line ON line.id = entry.journal_line_id WHERE line.journal_id = p_journal.id;
  IF v_subledger_count <> (CASE WHEN v_funding.funding_mode = 'PROVIDER_FUNDED_SAFE' THEN 2 ELSE 1 END)
     OR EXISTS (
       SELECT 1 FROM abos.subledger_entries entry JOIN abos.journal_lines line ON line.id = entry.journal_line_id
        WHERE line.journal_id = p_journal.id AND NOT (
          (line.line_number = 2 AND entry.subledger_type = 'TEMPORARY_FUNDING_PAYABLE'
           AND entry.business_party_id = v_funding.provider_business_party_id
           AND entry.temporary_funding_id = v_funding.id AND entry.temporary_funding_settlement_id IS NULL
           AND entry.original_amount = -v_amount AND entry.base_amount = -v_amount)
          OR
          (v_funding.funding_mode = 'PROVIDER_FUNDED_SAFE' AND line.line_number = 1
           AND entry.subledger_type = 'OPERATIONAL_TREASURY'
           AND entry.operational_treasury_account_id = v_funding.operational_treasury_account_id
           AND entry.business_party_id IS NULL AND entry.temporary_funding_id IS NULL
           AND entry.original_amount = v_amount AND entry.base_amount = v_amount))) THEN
    RAISE EXCEPTION 'temporary funding journal requires exactly its provider payable and Safe movements'
      USING ERRCODE = 'check_violation';
  END IF;
END
$function$;

CREATE OR REPLACE FUNCTION abos.validate_temporary_funding_settlement_journal(p_journal abos.journals, p_intent abos.posting_intents)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  v_funding abos.temporary_fundings%ROWTYPE;
  v_settlement abos.temporary_funding_settlements%ROWTYPE;
  v_mapping record; v_policy record; v_treasury record; v_settled numeric; v_subledger_count bigint;
BEGIN
  IF p_intent.intent_kind <> 'TEMPORARY_FUNDING_SETTLEMENT' OR p_intent.original_currency_code <> p_intent.base_currency_code
     OR p_intent.original_amount <> p_intent.base_amount THEN
    RAISE EXCEPTION 'temporary funding posting requires its posted base-currency intent'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT policy.id, policy.approval_required INTO v_policy FROM abos.finance_workflow_policy_versions policy
   WHERE policy.id = p_intent.finance_workflow_policy_version_id AND policy.legal_entity_id = p_journal.legal_entity_id
     AND policy.workflow_type = 'TEMPORARY_FUNDING';
  SELECT mapping.id, mapping.payable_ledger_account_id, ledger.status, ledger.posting_allowed,
         ledger.account_type, ledger.control_account_type
    INTO v_mapping
    FROM abos.temporary_funding_account_mapping_versions mapping
    JOIN abos.ledger_accounts ledger
      ON ledger.id = mapping.payable_ledger_account_id AND ledger.legal_entity_id = mapping.legal_entity_id
   WHERE mapping.id = p_intent.temporary_funding_mapping_version_id AND mapping.legal_entity_id = p_journal.legal_entity_id;
  IF v_policy.id IS NULL OR v_policy.approval_required IS NOT TRUE
     OR v_mapping.id IS NULL OR v_mapping.status <> 'ACTIVE' OR NOT v_mapping.posting_allowed
     OR v_mapping.account_type <> 'LIABILITY' OR v_mapping.control_account_type <> 'TEMPORARY_FUNDING_PAYABLE' THEN
    RAISE EXCEPTION 'temporary funding posting requires its approval-required policy and controlled payable mapping'
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM abos.journal_lines line
              WHERE line.journal_id = p_journal.id AND line.original_amount <> p_intent.original_amount) THEN
    RAISE EXCEPTION 'temporary funding journal line violates source, currency, account or dimension rules'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_settlement FROM abos.temporary_funding_settlements
   WHERE id = p_intent.temporary_funding_settlement_id AND legal_entity_id = p_journal.legal_entity_id;
  SELECT * INTO v_funding FROM abos.temporary_fundings
   WHERE id = v_settlement.temporary_funding_id AND legal_entity_id = p_journal.legal_entity_id;
  IF v_settlement.id IS NULL OR v_funding.id IS NULL OR v_funding.id <> p_intent.temporary_funding_id
     OR v_settlement.status <> 'POSTED' OR v_settlement.journal_id IS DISTINCT FROM p_journal.id
     OR v_funding.status <> 'POSTED'
     OR v_settlement.base_amount <> p_intent.base_amount OR v_settlement.business_date <> p_journal.accounting_effective_date
     OR v_settlement.workflow_policy_version_id <> v_policy.id OR v_funding.mapping_version_id <> v_mapping.id THEN
    RAISE EXCEPTION 'settlement, funding, intent and journal do not agree' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM abos.temporary_funding_settlement_decisions decision
                  WHERE decision.settlement_id = v_settlement.id AND decision.decision = 'APPROVED'
                    AND decision.decided_by_user_account_id = p_journal.posted_by_user_account_id)
     OR p_journal.posted_by_user_account_id = v_settlement.created_by_user_account_id
     OR p_journal.posted_by_user_account_id IS NOT DISTINCT FROM v_funding.provider_user_account_id THEN
    RAISE EXCEPTION 'a settlement must be posted by its independent approver' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT COALESCE(sum(other.base_amount), 0) INTO v_settled FROM abos.temporary_funding_settlements other
   WHERE other.temporary_funding_id = v_funding.id AND other.legal_entity_id = p_journal.legal_entity_id
     AND other.status = 'POSTED';
  IF v_settled > v_funding.base_amount THEN
    RAISE EXCEPTION 'settlements cannot exceed the funded amount' USING ERRCODE = 'check_violation';
  END IF;
  SELECT account.id, account.ledger_account_id INTO v_treasury FROM abos.operational_treasury_accounts account
    JOIN abos.ledger_accounts ledger ON ledger.id = account.ledger_account_id AND ledger.legal_entity_id = account.legal_entity_id
   WHERE account.id = v_settlement.operational_treasury_account_id AND account.legal_entity_id = p_journal.legal_entity_id
     AND account.status = 'ACTIVE' AND account.currency_code = p_journal.base_currency_code
     AND ledger.account_type = 'ASSET' AND ledger.control_account_type = 'CASH'
     AND NOT ledger.requires_project AND NOT ledger.requires_department AND NOT ledger.requires_cost_center;
  IF v_treasury.id IS NULL OR NOT EXISTS (
       SELECT 1 FROM abos.journal_lines line WHERE line.journal_id = p_journal.id AND line.line_number = 1
          AND line.ledger_account_id = v_mapping.payable_ledger_account_id
          AND line.base_debit = v_settlement.base_amount AND line.base_credit = 0
          AND line.business_party_id = v_funding.provider_business_party_id
          AND line.project_id IS NULL AND line.department_id IS NULL AND line.cost_center_id IS NULL)
     OR NOT EXISTS (
       SELECT 1 FROM abos.journal_lines line WHERE line.journal_id = p_journal.id AND line.line_number = 2
          AND line.ledger_account_id = v_treasury.ledger_account_id AND line.base_debit = 0
          AND line.base_credit = v_settlement.base_amount AND line.business_party_id IS NULL
          AND line.project_id IS NULL AND line.department_id IS NULL AND line.cost_center_id IS NULL) THEN
    RAISE EXCEPTION 'a settlement must debit the provider payable and credit its Treasury source'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*) INTO v_subledger_count FROM abos.subledger_entries entry
    JOIN abos.journal_lines line ON line.id = entry.journal_line_id WHERE line.journal_id = p_journal.id;
  IF v_subledger_count <> 2 OR EXISTS (
       SELECT 1 FROM abos.subledger_entries entry JOIN abos.journal_lines line ON line.id = entry.journal_line_id
        WHERE line.journal_id = p_journal.id AND NOT (
          (line.line_number = 1 AND entry.subledger_type = 'TEMPORARY_FUNDING_PAYABLE'
           AND entry.business_party_id = v_funding.provider_business_party_id
           AND entry.temporary_funding_id = v_funding.id AND entry.temporary_funding_settlement_id = v_settlement.id
           AND entry.original_amount = v_settlement.original_amount AND entry.base_amount = v_settlement.base_amount)
          OR
          (line.line_number = 2 AND entry.subledger_type = 'OPERATIONAL_TREASURY'
           AND entry.operational_treasury_account_id = v_settlement.operational_treasury_account_id
           AND entry.business_party_id IS NULL AND entry.temporary_funding_id IS NULL
           AND entry.original_amount = -v_settlement.original_amount AND entry.base_amount = -v_settlement.base_amount)))
     OR (SELECT count(DISTINCT line.line_number) FROM abos.subledger_entries entry
           JOIN abos.journal_lines line ON line.id = entry.journal_line_id WHERE line.journal_id = p_journal.id) <> 2 THEN
    RAISE EXCEPTION 'a settlement journal requires exactly its payable decrease and Treasury outflow'
      USING ERRCODE = 'check_violation';
  END IF;
END
$function$;

-- ---------------------------------------------------------------------------------------------
-- The balance read model. Internal: run with the caller's rights, executable only by the operational
-- Finance owner, whose definer functions apply permission checks first. The arithmetic takes every
-- posted movement; no permission, scope or source filter ever reduces a balance.
-- ---------------------------------------------------------------------------------------------

CREATE FUNCTION abos.treasury_account_balances(p_entity uuid, p_as_of date, p_account uuid)
RETURNS TABLE (operational_treasury_account_id uuid, currency_code text, opening_balance numeric,
               inflows numeric, outflows numeric, book_balance numeric, movement_count bigint,
               last_movement_date date)
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $balances$
  SELECT account.id, account.currency_code,
         COALESCE(sum(movement.amount) FILTER (WHERE movement.source_type = 'OPENING_BALANCE'), 0),
         COALESCE(sum(movement.amount) FILTER (WHERE movement.source_type <> 'OPENING_BALANCE' AND movement.amount > 0), 0),
         COALESCE(-sum(movement.amount) FILTER (WHERE movement.source_type <> 'OPENING_BALANCE' AND movement.amount < 0), 0),
         COALESCE(sum(movement.amount), 0),
         count(movement.amount),
         max(movement.effective_date)
    FROM abos.operational_treasury_accounts account
    LEFT JOIN LATERAL (
      SELECT entry.original_amount AS amount, entry.source_type, journal.accounting_effective_date AS effective_date
        FROM abos.subledger_entries entry
        JOIN abos.journal_lines line ON line.id = entry.journal_line_id
        JOIN abos.journals journal ON journal.id = line.journal_id AND journal.status = 'POSTED'
       WHERE entry.subledger_type = 'OPERATIONAL_TREASURY'
         AND entry.operational_treasury_account_id = account.id
         AND entry.legal_entity_id = account.legal_entity_id
         AND (p_as_of IS NULL OR journal.accounting_effective_date <= p_as_of)) movement ON true
   WHERE account.legal_entity_id = p_entity AND (p_account IS NULL OR account.id = p_account)
   GROUP BY account.id, account.currency_code
$balances$;

CREATE FUNCTION abos.treasury_account_movements(p_entity uuid, p_account uuid, p_from date, p_to date, p_actor uuid)
RETURNS TABLE (journal_id uuid, effective_date date, amount numeric, source_type text,
               journal_reference text, restricted boolean, posted_at timestamptz)
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $movements$
  -- A movement whose line carries a project, department or cost centre outside the reader's scope keeps
  -- its date, direction and amount but hides its reference: confidentiality hides details, never money.
  SELECT journal.id, journal.accounting_effective_date, entry.original_amount, entry.source_type,
         CASE WHEN visible.ok THEN journal.journal_reference END, NOT visible.ok, journal.posted_at
    FROM abos.subledger_entries entry
    JOIN abos.journal_lines line ON line.id = entry.journal_line_id
    JOIN abos.journals journal ON journal.id = line.journal_id AND journal.status = 'POSTED'
    CROSS JOIN LATERAL (SELECT
      (line.project_id IS NULL OR EXISTS (SELECT 1 FROM abos.user_scope_grants g
         WHERE g.user_account_id = p_actor AND g.legal_entity_id = p_entity
           AND g.scope_kind = 'PROJECT' AND g.scope_id = line.project_id AND g.revoked_at IS NULL))
      AND (line.department_id IS NULL OR EXISTS (SELECT 1 FROM abos.user_scope_grants g
         WHERE g.user_account_id = p_actor AND g.legal_entity_id = p_entity
           AND g.scope_kind = 'DEPARTMENT' AND g.scope_id = line.department_id AND g.revoked_at IS NULL))
      AND (line.cost_center_id IS NULL OR EXISTS (SELECT 1 FROM abos.user_scope_grants g
         WHERE g.user_account_id = p_actor AND g.legal_entity_id = p_entity
           AND g.scope_kind = 'COST_CENTER' AND g.scope_id = line.cost_center_id AND g.revoked_at IS NULL)) AS ok) visible
   WHERE entry.subledger_type = 'OPERATIONAL_TREASURY' AND entry.legal_entity_id = p_entity
     AND entry.operational_treasury_account_id = p_account
     AND (p_from IS NULL OR journal.accounting_effective_date >= p_from)
     AND (p_to IS NULL OR journal.accounting_effective_date <= p_to)
   ORDER BY journal.accounting_effective_date DESC, journal.posted_at DESC, journal.id
$movements$;

CREATE FUNCTION abos.ledger_account_balances(p_entity uuid, p_from date, p_to date)
RETURNS TABLE (ledger_account_id uuid, debit_total numeric, credit_total numeric, net_balance numeric)
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $ledger$
  SELECT line.ledger_account_id, sum(line.base_debit), sum(line.base_credit), sum(line.base_debit) - sum(line.base_credit)
    FROM abos.journal_lines line
    JOIN abos.journals journal ON journal.id = line.journal_id AND journal.status = 'POSTED'
   WHERE line.legal_entity_id = p_entity
     AND (p_from IS NULL OR journal.accounting_effective_date >= p_from)
     AND (p_to IS NULL OR journal.accounting_effective_date <= p_to)
   GROUP BY line.ledger_account_id
$ledger$;

CREATE FUNCTION abos.shareholder_capital_balances(p_entity uuid)
RETURNS TABLE (business_party_id uuid, currency_code text, capital_posted numeric)
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $capital$
  -- Shareholder capital is a credit, recorded negative by the convention; the posted capital is -sum.
  SELECT entry.business_party_id, entry.original_currency_code, -sum(entry.original_amount)
    FROM abos.subledger_entries entry
    JOIN abos.journal_lines line ON line.id = entry.journal_line_id
    JOIN abos.journals journal ON journal.id = line.journal_id AND journal.status = 'POSTED'
   WHERE entry.subledger_type = 'SHAREHOLDER_CAPITAL' AND entry.legal_entity_id = p_entity
   GROUP BY entry.business_party_id, entry.original_currency_code
$capital$;


CREATE OR REPLACE FUNCTION abos.temporary_funding_workspace(p_identity_proof text, p_runtime_token_sha256 text, p_token_sha256 text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE v_context jsonb; v_entity uuid; v_permissions jsonb; v_base text; v_policy record; v_mapping record;
  v_super boolean;
BEGIN
  v_context := abos.temporary_funding_actor(p_identity_proof, p_runtime_token_sha256, p_token_sha256,
    ARRAY['finance.temporary-funding.read', 'finance.temporary-funding.record',
          'finance.temporary-funding.approve', 'finance.temporary-funding.settle',
          'finance.temporary-funding.settle-approve', 'finance.temporary-funding.configure',
          'admin.users.manage']);
  v_entity := (v_context ->> 'legalEntityId')::uuid;
  v_permissions := COALESCE(v_context -> 'permissions', '[]'::jsonb);
  v_super := v_permissions ? 'admin.users.manage' AND v_permissions ? 'admin.roles.manage';
  IF NOT v_super AND NOT v_permissions ?| ARRAY['finance.temporary-funding.read', 'finance.temporary-funding.record',
       'finance.temporary-funding.approve', 'finance.temporary-funding.settle',
       'finance.temporary-funding.settle-approve', 'finance.temporary-funding.configure'] THEN
    RAISE EXCEPTION 'current authority is missing finance.temporary-funding.read' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT base_currency_code INTO v_base FROM abos.legal_entities
   WHERE id = v_entity AND currency_policy_status = 'APPROVED';
  SELECT id, version, approval_required INTO v_policy FROM abos.finance_workflow_policy_versions
   WHERE legal_entity_id = v_entity AND workflow_type = 'TEMPORARY_FUNDING' ORDER BY version DESC LIMIT 1;
  SELECT mapping.id, mapping.version, mapping.configured_at, mapping.evidence_document_reference,
         ledger.id AS ledger_id, ledger.account_code, ledger.account_name,
         (ledger.status = 'ACTIVE' AND ledger.posting_allowed AND ledger.account_type = 'LIABILITY'
          AND ledger.control_account_type = 'TEMPORARY_FUNDING_PAYABLE'
          AND ledger.account_currency_code IS NOT DISTINCT FROM v_base) AS valid
    INTO v_mapping
    FROM abos.temporary_funding_account_mapping_versions mapping
    JOIN abos.ledger_accounts ledger ON ledger.id = mapping.payable_ledger_account_id
     AND ledger.legal_entity_id = mapping.legal_entity_id
   WHERE mapping.legal_entity_id = v_entity ORDER BY mapping.version DESC LIMIT 1;
  RETURN jsonb_build_object(
    'legalEntityId', v_entity,
    'baseCurrency', v_base,
    'actorUserAccountId', v_context ->> 'userAccountId',
    'permissions', jsonb_build_object(
      'canRead', v_permissions ? 'finance.temporary-funding.read',
      'canRecord', v_permissions ? 'finance.temporary-funding.record',
      'canApprove', v_permissions ? 'finance.temporary-funding.approve',
      'canSettle', v_permissions ? 'finance.temporary-funding.settle',
      'canApproveSettlement', v_permissions ? 'finance.temporary-funding.settle-approve',
      'canConfigure', v_permissions ? 'finance.temporary-funding.configure',
      'canConfigureProviderIdentity', v_super),
    'capability', jsonb_build_object(
      'state', CASE WHEN v_base IS NOT NULL AND v_policy.approval_required IS TRUE AND v_mapping.valid IS TRUE
                    THEN 'OPERATIONAL' ELSE 'NOT_OPERATIONAL' END,
      'reason', CASE WHEN v_base IS NULL THEN 'BASE_CURRENCY_NOT_APPROVED'
                     WHEN v_policy.id IS NULL THEN 'POLICY_NOT_CONFIGURED'
                     WHEN v_policy.approval_required IS NOT TRUE THEN 'APPROVAL_MUST_BE_REQUIRED'
                     WHEN v_mapping.id IS NULL THEN 'PAYABLE_MAPPING_NOT_CONFIGURED'
                     WHEN v_mapping.valid IS NOT TRUE THEN 'PAYABLE_MAPPING_INVALID'
                     ELSE NULL END,
      'reversalAvailable', false,
      'safeNonNegativeGuardActive', false,
      'requiredSessionProvenance', 'PASSWORD_OPERATIONAL'),
    'configuration', jsonb_build_object(
      'mapping', CASE WHEN v_mapping.id IS NULL THEN NULL ELSE jsonb_build_object(
        'id', v_mapping.id, 'version', v_mapping.version, 'configuredAt', v_mapping.configured_at,
        'evidenceDocumentReference', v_mapping.evidence_document_reference, 'valid', v_mapping.valid,
        'payableLedgerAccount', jsonb_build_object('id', v_mapping.ledger_id, 'code', v_mapping.account_code,
          'name', v_mapping.account_name)) END,
      'policy', CASE WHEN v_policy.id IS NULL THEN NULL ELSE jsonb_build_object(
        'id', v_policy.id, 'version', v_policy.version, 'approvalRequired', v_policy.approval_required) END),
    -- Provider subledger: the authoritative outstanding amount is the posted payable subledger.
    'providers', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'businessPartyId', provider.id, 'name', provider.display_name,
        'providerKinds', totals.kinds, 'fundedAmount', totals.funded::text,
        'settledAmount', totals.settled::text, 'outstandingAmount', COALESCE(ledger.balance, 0)::text,
        'status', CASE WHEN COALESCE(ledger.balance, 0) = 0 THEN 'SETTLED'
                       WHEN totals.settled = 0 THEN 'OUTSTANDING' ELSE 'PARTIALLY_SETTLED' END)
        ORDER BY provider.display_name, provider.id)
      FROM (SELECT funding.provider_business_party_id AS party_id,
                   jsonb_agg(DISTINCT funding.provider_kind) AS kinds,
                   sum(funding.base_amount) AS funded,
                   COALESCE((SELECT sum(settlement.base_amount) FROM abos.temporary_funding_settlements settlement
                              JOIN abos.temporary_fundings parent ON parent.id = settlement.temporary_funding_id
                             WHERE parent.provider_business_party_id = funding.provider_business_party_id
                               AND parent.legal_entity_id = v_entity AND settlement.legal_entity_id = v_entity
                               AND settlement.status = 'POSTED'), 0) AS settled
              FROM abos.temporary_fundings funding
             WHERE funding.legal_entity_id = v_entity AND funding.status = 'POSTED'
             GROUP BY funding.provider_business_party_id) totals
      JOIN abos.business_parties provider ON provider.id = totals.party_id AND provider.legal_entity_id = v_entity
      LEFT JOIN LATERAL (
        SELECT -sum(entry.base_amount) AS balance
          FROM abos.subledger_entries entry
          JOIN abos.journal_lines line ON line.id = entry.journal_line_id
          JOIN abos.journals journal ON journal.id = line.journal_id
         WHERE entry.legal_entity_id = v_entity AND entry.subledger_type = 'TEMPORARY_FUNDING_PAYABLE'
           AND entry.business_party_id = provider.id AND journal.status = 'POSTED') ledger ON true), '[]'::jsonb),
    'payableTotal', (SELECT COALESCE(-sum(entry.base_amount), 0)::text
        FROM abos.subledger_entries entry
        JOIN abos.journal_lines line ON line.id = entry.journal_line_id
        JOIN abos.journals journal ON journal.id = line.journal_id
       WHERE entry.legal_entity_id = v_entity AND entry.subledger_type = 'TEMPORARY_FUNDING_PAYABLE'
         AND journal.status = 'POSTED'),
    -- Physical Safe movements are shown apart from the payable and are not a balance.
    'safePositions', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'treasuryAccountId', account.id, 'nameEn', account.name_en, 'nameFa', account.name_fa,
        'accountType', account.account_type, 'currencyCode', account.currency_code,
        'postedMovementTotal', (SELECT balance.book_balance FROM abos.treasury_account_balances(v_entity, NULL, account.id) balance)::text,
        'temporaryFundingInflow', COALESCE(movements.funding_in, 0)::text,
        'temporaryFundingSettlementOutflow', COALESCE(movements.settlement_out, 0)::text)
        ORDER BY account.name_en, account.id)
      FROM abos.operational_treasury_accounts account
      LEFT JOIN LATERAL (
        SELECT sum(entry.original_amount) FILTER (WHERE entry.source_type = 'TEMPORARY_FUNDING') AS funding_in,
               -sum(entry.original_amount) FILTER (WHERE entry.source_type = 'TEMPORARY_FUNDING_SETTLEMENT') AS settlement_out
          FROM abos.subledger_entries entry
          JOIN abos.journal_lines line ON line.id = entry.journal_line_id
          JOIN abos.journals journal ON journal.id = line.journal_id
         WHERE entry.legal_entity_id = v_entity AND entry.subledger_type = 'OPERATIONAL_TREASURY'
           AND entry.operational_treasury_account_id = account.id AND journal.status = 'POSTED') movements ON true
      WHERE account.legal_entity_id = v_entity AND account.status = 'ACTIVE'), '[]'::jsonb),
    'fundings', COALESCE((SELECT jsonb_agg(abos.temporary_funding_json(funding.id)
        ORDER BY funding.business_date DESC, funding.created_at DESC)
      FROM (SELECT id, business_date, created_at FROM abos.temporary_fundings
             WHERE legal_entity_id = v_entity ORDER BY business_date DESC, created_at DESC LIMIT 500) funding),
      '[]'::jsonb),
    'options', jsonb_build_object(
      'safeAccounts', COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'id', account.id, 'nameEn', account.name_en, 'nameFa', account.name_fa,
          'currencyCode', account.currency_code, 'accountType', account.account_type)
          ORDER BY account.name_en, account.id)
        FROM abos.operational_treasury_accounts account
        JOIN abos.ledger_accounts ledger ON ledger.id = account.ledger_account_id AND ledger.legal_entity_id = account.legal_entity_id
        WHERE account.legal_entity_id = v_entity AND account.status = 'ACTIVE' AND account.currency_code = v_base
          AND account.account_type IN ('SAFE', 'CASH_BOX', 'PETTY_CASH')
          AND ledger.status = 'ACTIVE' AND ledger.posting_allowed AND ledger.account_type = 'ASSET'
          AND ledger.control_account_type = 'CASH'), '[]'::jsonb),
      'settlementSources', COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'id', account.id, 'nameEn', account.name_en, 'nameFa', account.name_fa,
          'currencyCode', account.currency_code, 'accountType', account.account_type)
          ORDER BY account.name_en, account.id)
        FROM abos.operational_treasury_accounts account
        JOIN abos.ledger_accounts ledger ON ledger.id = account.ledger_account_id AND ledger.legal_entity_id = account.legal_entity_id
        WHERE account.legal_entity_id = v_entity AND account.status = 'ACTIVE' AND account.currency_code = v_base
          AND ledger.status = 'ACTIVE' AND ledger.posting_allowed AND ledger.account_type = 'ASSET'
          AND ledger.control_account_type = 'CASH'), '[]'::jsonb),
      'expenseCategories', COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'id', category.id, 'code', category.category_code, 'nameEn', category.name_en, 'nameFa', category.name_fa)
          ORDER BY category.category_code, category.id)
        FROM abos.operational_expense_categories category
        WHERE category.legal_entity_id = v_entity AND category.status = 'ACTIVE'), '[]'::jsonb),
      'parties', COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'id', party.id, 'name', party.display_name,
          'providerKind', abos.temporary_funding_provider_kind(party.id, current_date),
          'identity', CASE WHEN identity.id IS NULL THEN NULL ELSE jsonb_build_object(
            'versionId', identity.id, 'version', identity.version, 'mode', identity.identity_mode,
            'userAccountId', identity.user_account_id, 'userName', identity_user.display_name,
            'configuredAt', identity.configured_at) END)
          ORDER BY party.display_name, party.id)
        FROM abos.business_parties party
        LEFT JOIN LATERAL (
          SELECT * FROM abos.temporary_funding_provider_identity_versions version_row
           WHERE version_row.legal_entity_id = v_entity AND version_row.business_party_id = party.id
           ORDER BY version_row.version DESC LIMIT 1) identity ON true
        LEFT JOIN abos.user_accounts identity_user ON identity_user.id = identity.user_account_id
        WHERE party.legal_entity_id = v_entity AND party.status = 'ACTIVE'), '[]'::jsonb),
      'users', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', account.id, 'name', account.display_name)
          ORDER BY account.display_name, account.id)
        FROM abos.user_accounts account
        WHERE v_super AND account.status = 'ACTIVE' AND EXISTS (
          SELECT 1 FROM abos.user_permission_grants grant_row
           WHERE grant_row.user_account_id = account.id AND grant_row.legal_entity_id = v_entity
             AND grant_row.revoked_at IS NULL)), '[]'::jsonb),
      'payableLedgerAccounts', COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'id', ledger.id, 'code', ledger.account_code, 'name', ledger.account_name)
          ORDER BY ledger.account_code, ledger.id)
        FROM abos.ledger_accounts ledger
        WHERE ledger.legal_entity_id = v_entity AND ledger.account_type = 'LIABILITY'
          AND ledger.control_account_type = 'TEMPORARY_FUNDING_PAYABLE'
          AND ledger.status = 'ACTIVE' AND ledger.posting_allowed
          AND ledger.account_currency_code IS NOT DISTINCT FROM v_base
          AND NOT ledger.requires_project AND NOT ledger.requires_department
          AND NOT ledger.requires_cost_center), '[]'::jsonb)));
END
$function$;

CREATE OR REPLACE FUNCTION abos.operational_finance_daily_report(p_identity_proof text, p_runtime_token_sha256 text, p_token_sha256 text, p_report_date date)
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
BEGIN
  v_actor_context := abos.operational_finance_actor(
    p_identity_proof, p_runtime_token_sha256, p_token_sha256, 'finance.expense.read');
  v_actor_id := (v_actor_context ->> 'userAccountId')::uuid;
  v_entity_id := (v_actor_context ->> 'legalEntityId')::uuid;
  IF p_report_date IS NULL THEN
    RAISE EXCEPTION 'a report date is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT entity.base_currency_code INTO v_base_currency FROM abos.legal_entities entity
   WHERE entity.id = v_entity_id;

  RETURN pg_catalog.jsonb_build_object(
    'reportDate', p_report_date,
    'baseCurrency', v_base_currency,
    -- Posted expenses of the date, per category and currency; currencies are never combined.
    'expensesByCategory', COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'categoryId', grouped.category_id, 'code', grouped.category_code,
        'nameEn', grouped.name_en, 'nameFa', grouped.name_fa,
        'currency', grouped.currency, 'count', grouped.expense_count,
        'amount', grouped.amount::text, 'baseAmount', grouped.base_amount::text)
        ORDER BY grouped.category_code, grouped.currency)
      FROM (SELECT category.id AS category_id, category.category_code, category.name_en, category.name_fa,
                   expense.original_currency_code AS currency, count(*) AS expense_count,
                   sum(expense.original_amount) AS amount, sum(expense.base_amount) AS base_amount
              FROM abos.operational_expenses expense
              JOIN abos.operational_expense_categories category
                ON category.id = expense.operational_expense_category_id
             WHERE expense.legal_entity_id = v_entity_id AND expense.status = 'POSTED'
               AND expense.business_date = p_report_date
               AND abos.operational_expense_actor_in_scope(expense.id, v_entity_id, v_actor_id)
             GROUP BY category.id, category.category_code, category.name_en, category.name_fa,
                      expense.original_currency_code) grouped), '[]'::jsonb),
    'totalsByCurrency', COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'currency', totals.currency, 'count', totals.expense_count, 'amount', totals.amount::text)
        ORDER BY totals.currency)
      FROM (SELECT expense.original_currency_code AS currency, count(*) AS expense_count,
                   sum(expense.original_amount) AS amount
              FROM abos.operational_expenses expense
             WHERE expense.legal_entity_id = v_entity_id AND expense.status = 'POSTED'
               AND expense.business_date = p_report_date
               AND abos.operational_expense_actor_in_scope(expense.id, v_entity_id, v_actor_id)
             GROUP BY expense.original_currency_code) totals), '[]'::jsonb),
    'baseTotal', (SELECT pg_catalog.jsonb_build_object('currency', v_base_currency,
        'amount', COALESCE(sum(expense.base_amount), 0)::text)
      FROM abos.operational_expenses expense
      WHERE expense.legal_entity_id = v_entity_id AND expense.status = 'POSTED'
        AND expense.business_date = p_report_date
        AND abos.operational_expense_actor_in_scope(expense.id, v_entity_id, v_actor_id)),
    'pendingApproval', (SELECT pg_catalog.jsonb_build_object('count', count(*))
      FROM abos.operational_expenses expense
      WHERE expense.legal_entity_id = v_entity_id AND expense.status = 'PENDING_APPROVAL'
        AND expense.business_date = p_report_date
        AND abos.operational_expense_actor_in_scope(expense.id, v_entity_id, v_actor_id)),
    -- 0045: Safe positions come from the one balance read model. A balance is the sum of EVERY
    -- posted movement of the account, whatever recorded it; the reader's project, department and
    -- cost-centre scope hides movement details elsewhere, never money from a balance.
    'treasuryMovements', COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'treasuryAccountId', account.id, 'nameEn', account.name_en, 'nameFa', account.name_fa,
        'currency', account.currency_code, 'status', account.status,
        'before', prior.book_balance::text, 'day', (current_day.book_balance - prior.book_balance)::text,
        'after', current_day.book_balance::text)
        ORDER BY account.name_en, account.id)
      FROM abos.operational_treasury_accounts account
      JOIN abos.treasury_account_balances(v_entity_id, p_report_date - 1, NULL) prior
        ON prior.operational_treasury_account_id = account.id
      JOIN abos.treasury_account_balances(v_entity_id, p_report_date, NULL) current_day
        ON current_day.operational_treasury_account_id = account.id
      WHERE account.legal_entity_id = v_entity_id), '[]'::jsonb));
END
$function$;


REVOKE ALL ON FUNCTION
  abos.treasury_account_balances(uuid, date, uuid),
  abos.treasury_account_movements(uuid, uuid, date, date, uuid),
  abos.ledger_account_balances(uuid, date, date),
  abos.shareholder_capital_balances(uuid)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  abos.treasury_account_balances(uuid, date, uuid),
  abos.treasury_account_movements(uuid, uuid, date, date, uuid),
  abos.ledger_account_balances(uuid, date, date),
  abos.shareholder_capital_balances(uuid)
  TO abos_v1_operational_finance_owner;
