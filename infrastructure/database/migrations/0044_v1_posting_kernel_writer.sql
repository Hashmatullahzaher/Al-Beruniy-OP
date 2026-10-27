-- Slice 2, part 2: the posting kernel writer. Additive for data.
--
-- Before: each operational writer inserted its own posting intent, draft journal, journal lines and
-- subledger entries, then marked the intent and the journal posted - the same canonical sequence
-- re-written per source with source-specific columns.
-- After: abos.posting_kernel_draft writes that sequence once from a typed description, and
-- abos.posting_kernel_commit posts it. The source keeps everything that is the source's own: its
-- request validation, idempotency, period rule, row locks, its own row, references, audit and
-- outbox. The kernel trigger (0043) validates the result exactly as before.
--
-- Repointed: the expense writer (operational_expense_post, 0028) and the direct capital writer
-- (direct_shareholder_receive, 0040), restated verbatim except for their posting block. Temporary
-- funding keeps its writers; the 0036 bridge and E1 are untouched. Each source's period rule is
-- unchanged: an expense needs an OPEN month, direct capital opens a PENDING month for its date.
--
-- No row of any existing table changes. The equivalence test runs the same scenarios against a
-- 0043 database (old writers) and a 0044 database (kernel writers) and requires identical rows.

-- ---------------------------------------------------------------------------------------------
-- 1. One journal line, as a source describes it. Amounts are not part of a line: every line of an
--    operational journal carries the intent's full amount on its side (0043 enforces it).
-- ---------------------------------------------------------------------------------------------

CREATE TYPE abos.posting_kernel_line AS (
  line_number integer,
  side text,
  ledger_account_id uuid,
  business_party_id uuid,
  project_id uuid,
  department_id uuid,
  cost_center_id uuid,
  subledger_type text,
  subledger_sign integer,
  operational_treasury_account_id uuid,
  subledger_business_party_id uuid
);

-- ---------------------------------------------------------------------------------------------
-- 2. Draft: intent, draft journal, lines, then subledger entries in line order.
-- ---------------------------------------------------------------------------------------------

CREATE FUNCTION abos.posting_kernel_draft(
  p_intent_id uuid,
  p_journal_id uuid,
  p_legal_entity_id uuid,
  p_source_type text,
  p_source_id uuid,
  p_original_amount numeric,
  p_original_currency_code text,
  p_base_amount numeric,
  p_base_currency_code text,
  p_accounting_effective_date date,
  p_accounting_period_id uuid,
  p_journal_reference text,
  p_correlation_id uuid,
  p_idempotency_key text,
  p_initial_status text,
  p_created_by_user_account_id uuid,
  p_lines abos.posting_kernel_line[],
  p_project_id uuid DEFAULT NULL,
  p_department_id uuid DEFAULT NULL,
  p_cost_center_id uuid DEFAULT NULL,
  p_conversion_snapshot_reference text DEFAULT NULL,
  p_finance_workflow_policy_version_id uuid DEFAULT NULL,
  p_operational_version integer DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $draft$
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
     operational_expense_id, direct_capital_receipt_id,
     finance_workflow_policy_version_id, operational_version)
  VALUES
    (p_intent_id, p_legal_entity_id, p_project_id, p_department_id, p_cost_center_id,
     p_source_type, p_source_id, v_source.intent_kind, p_original_amount, p_original_currency_code,
     p_base_amount, p_base_currency_code, p_conversion_snapshot_reference,
     p_accounting_effective_date, p_correlation_id, p_idempotency_key, p_initial_status,
     p_created_by_user_account_id, 'OPERATIONAL_V1',
     CASE p_source_type WHEN 'OPERATIONAL_EXPENSE' THEN p_source_id END,
     CASE p_source_type WHEN 'DIRECT_SHAREHOLDER_CAPITAL' THEN p_source_id END,
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
$draft$;

-- ---------------------------------------------------------------------------------------------
-- 3. Commit: post the intent (a versioned intent advances one version) and then the journal; the
--    kernel trigger validates the whole posting at that moment.
-- ---------------------------------------------------------------------------------------------

CREATE FUNCTION abos.posting_kernel_commit(p_intent_id uuid, p_journal_id uuid, p_actor_id uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $commit$
DECLARE
  v_version integer;
BEGIN
  IF current_user <> 'abos_v1_operational_finance_owner' THEN
    RAISE EXCEPTION 'the posting kernel is internal' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT intent.operational_version INTO v_version
    FROM abos.posting_intents intent
   WHERE intent.id = p_intent_id AND intent.processing_model = 'OPERATIONAL_V1'
     AND intent.status IN ('VALIDATED', 'APPROVED')
     AND EXISTS (SELECT 1 FROM abos.journals journal
                  WHERE journal.id = p_journal_id AND journal.posting_intent_id = intent.id
                    AND journal.status = 'DRAFT');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the posting kernel posts only its own draft' USING ERRCODE = 'check_violation';
  END IF;
  IF v_version IS NULL THEN
    UPDATE abos.posting_intents SET status = 'POSTED' WHERE id = p_intent_id;
  ELSE
    UPDATE abos.posting_intents SET status = 'POSTED', operational_version = v_version + 1
     WHERE id = p_intent_id;
  END IF;
  UPDATE abos.journals
     SET status = 'POSTED', posted_by_user_account_id = p_actor_id,
         posted_at = pg_catalog.clock_timestamp()
   WHERE id = p_journal_id;
END
$commit$;

-- ---------------------------------------------------------------------------------------------
-- 4. Writers, restated verbatim except for their posting block.
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION abos.operational_expense_post(p_expense_id uuid, p_actor_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $post$
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
  SELECT period.id INTO period_id FROM abos.accounting_periods period
   WHERE period.legal_entity_id = expense.legal_entity_id AND period.status = 'OPEN'
     AND expense.business_date BETWEEN period.starts_on AND period.ends_on;
  IF period_id IS NULL THEN
    RAISE EXCEPTION 'no open accounting period covers the expense date'
      USING ERRCODE = 'check_violation';
  END IF;
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
$post$;

CREATE OR REPLACE FUNCTION abos.direct_shareholder_receive(p_proof text,p_runtime text,p_token text,p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE c jsonb; actor uuid; entity uuid; profile uuid; destination uuid; equity uuid; currency text;
 amount numeric; day date; period uuid; policy uuid; debit_account uuid; base text; method text;
 provider text; item text; cash_bearing boolean;
 key text; correlation uuid; scope text; replay jsonb; fingerprint text; receipt uuid:=gen_random_uuid();
 journal uuid:=gen_random_uuid(); intent uuid:=gen_random_uuid();
 source abos.shareholder_contributions%ROWTYPE; allocated numeric; remaining numeric; piece numeric; party uuid; result jsonb; ref text;
 locked_sources uuid[]:=ARRAY[]::uuid[];
BEGIN
 c:=abos.direct_capital_actor(p_proof,p_runtime,p_token,true);
 actor:=(c->>'userAccountId')::uuid; entity:=(c->>'legalEntityId')::uuid;
 IF p_payload IS NULL OR jsonb_typeof(p_payload)<>'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_payload) k
  WHERE k NOT IN('shareholderProfileId','fundingMethod','amount','currencyCode','receiptDate','destinationAccountId',
   'providerName','itemDescription','expenseLedgerAccountId','paymentReference','note','idempotencyKey','correlationId')) THEN
  RAISE EXCEPTION 'unknown capital receipt fields' USING ERRCODE='invalid_parameter_value'; END IF;
 profile:=(p_payload->>'shareholderProfileId')::uuid; destination:=NULLIF(p_payload->>'destinationAccountId','')::uuid;
 currency:=p_payload->>'currencyCode'; day:=(p_payload->>'receiptDate')::date;
 amount:=abos.temporary_funding_amount(p_payload->>'amount');
 method:=COALESCE(NULLIF(btrim(p_payload->>'fundingMethod'),''),'CASH');
 provider:=NULLIF(btrim(p_payload->>'providerName'),''); item:=NULLIF(btrim(p_payload->>'itemDescription'),'');
 key:=NULLIF(btrim(p_payload->>'idempotencyKey'),''); correlation:=(p_payload->>'correlationId')::uuid;
 IF method NOT IN('CASH','HAWALA','ASSET','BILL_PAYMENT') THEN
  RAISE EXCEPTION 'unknown funding method %',method USING ERRCODE='invalid_parameter_value'; END IF;
 cash_bearing:=method IN('CASH','HAWALA');
 IF profile IS NULL OR day IS NULL OR day>abos.business_today()
  OR length(p_payload->>'paymentReference')>120 OR length(p_payload->>'note')>1000 THEN
  RAISE EXCEPTION 'a valid shareholder, date and reference are required' USING ERRCODE='invalid_parameter_value'; END IF;
 -- Each method requires exactly its own fields, so one cannot be smuggled through another.
 IF cash_bearing AND destination IS NULL THEN
  RAISE EXCEPTION 'choose the Safe the money went into' USING ERRCODE='invalid_parameter_value'; END IF;
 IF NOT cash_bearing AND destination IS NOT NULL THEN
  RAISE EXCEPTION 'this contribution does not move a Safe' USING ERRCODE='invalid_parameter_value'; END IF;
 IF (method='HAWALA')<>(provider IS NOT NULL) THEN
  RAISE EXCEPTION 'name the saraf for a hawala contribution, and only for one' USING ERRCODE='invalid_parameter_value'; END IF;
 IF (method IN('ASSET','BILL_PAYMENT'))<>(item IS NOT NULL) THEN
  RAISE EXCEPTION 'describe the asset, or the bill that was paid' USING ERRCODE='invalid_parameter_value'; END IF;
 IF (method='BILL_PAYMENT')<>(NULLIF(p_payload->>'expenseLedgerAccountId','') IS NOT NULL) THEN
  RAISE EXCEPTION 'choose the expense account the payment covers, and only for a paid bill' USING ERRCODE='invalid_parameter_value'; END IF;
 -- Authorization precedes durable replay; changed/expired permissions cannot replay sensitive results.
 scope:='direct-capital:receive:'||entity::text||':'||actor::text;
 fingerprint:=encode(sha256(convert_to((p_payload-'correlationId')::text||actor::text,'UTF8')),'hex');
 replay:=abos.temporary_funding_idempotency_begin(scope,key,fingerprint,correlation);
 IF replay IS NOT NULL THEN RETURN replay; END IF;
 SELECT business_party_id INTO party FROM abos.shareholder_profiles
 WHERE id=profile AND legal_entity_id=entity AND status='ACTIVE';
 IF party IS NULL OR NOT EXISTS(SELECT 1 FROM abos.business_parties WHERE id=party AND legal_entity_id=entity AND status='ACTIVE') THEN
  RAISE EXCEPTION 'shareholder not found in this legal entity' USING ERRCODE='no_data_found'; END IF;
 SELECT base_currency_code INTO base FROM abos.legal_entities WHERE id=entity AND currency_policy_status='APPROVED';
 IF base IS NULL OR currency IS DISTINCT FROM base OR NOT EXISTS(SELECT 1 FROM abos.currencies WHERE code=currency AND enabled) THEN
  RAISE EXCEPTION 'capital receipt currency must match the approved accounting currency' USING ERRCODE='check_violation'; END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('abos-finance-workflow-policy:'||entity::text||':SHAREHOLDER_CAPITAL_RECEIPT',0));
 SELECT id INTO policy FROM abos.finance_workflow_policy_versions
 WHERE legal_entity_id=entity AND workflow_type='SHAREHOLDER_CAPITAL_RECEIPT' ORDER BY version DESC LIMIT 1;
 IF policy IS NULL OR (SELECT approval_required FROM abos.finance_workflow_policy_versions WHERE id=policy) THEN
  RAISE EXCEPTION 'a direct capital receipt requires the company approval setting OFF' USING ERRCODE='check_violation'; END IF;
 IF cash_bearing THEN
  debit_account:=abos.temporary_funding_treasury_ledger(entity,destination,currency,true);
  IF EXISTS(SELECT 1 FROM abos.ledger_accounts WHERE id=debit_account
   AND account_currency_code IS NOT NULL AND account_currency_code<>currency) THEN
   RAISE EXCEPTION 'Safe ledger currency does not match receipt currency' USING ERRCODE='check_violation'; END IF;
 ELSIF method='ASSET' THEN debit_account:=abos.direct_capital_asset_account(entity,currency);
 ELSE debit_account:=abos.direct_capital_expense_account(entity,currency,(p_payload->>'expenseLedgerAccountId')::uuid);
 END IF;
 equity:=abos.direct_capital_equity(entity,currency);
 IF debit_account=equity THEN
  RAISE EXCEPTION 'a contribution cannot debit and credit the same account' USING ERRCODE='check_violation'; END IF;
 period:=abos.open_period_for_business_date(entity,actor,day);
 -- Exactly the same row locks as the legacy receipt command. Lock all eligible declarations in
 -- stable UUID order before allocating, so two direct saves and direct/legacy races serialize.
 FOR source IN SELECT * FROM abos.shareholder_contributions WHERE shareholder_profile_id=profile
  AND legal_entity_id=entity AND contribution_type='CASH' AND record_status='DECLARED'
  AND currency_code=currency ORDER BY id LOOP
  PERFORM abos.shareholder_contribution_finance_lock(entity,source.id,source.version);
  locked_sources:=array_append(locked_sources,source.id);
 END LOOP;
 remaining:=amount; ref:='CAP-'||to_char(day,'YYYYMMDD')||'-'||upper(replace(receipt::text,'-',''));
 INSERT INTO abos.direct_capital_receipts(id,legal_entity_id,shareholder_profile_id,funding_method,
  operational_treasury_account_id,debit_ledger_account_id,paid_in_capital_ledger_account_id,provider_name,
  item_description,original_amount,original_currency_code,receipt_date,payment_reference,note,
  transaction_reference,workflow_policy_version_id,journal_id,created_by_user_account_id,correlation_id,idempotency_key)
 VALUES(receipt,entity,profile,method,destination,debit_account,equity,provider,item,amount,currency,day,
  NULLIF(btrim(p_payload->>'paymentReference'),''),NULLIF(btrim(p_payload->>'note'),''),ref,policy,journal,actor,correlation,key);
 FOR source IN SELECT * FROM abos.shareholder_contributions WHERE shareholder_profile_id=profile
  AND legal_entity_id=entity AND contribution_type='CASH' AND record_status='DECLARED'
  AND currency_code=currency AND business_date<=day AND id=ANY(locked_sources) ORDER BY business_date,id LOOP
  SELECT COALESCE((SELECT sum(original_amount) FROM abos.shareholder_capital_receipts
   WHERE legal_entity_id=entity AND contribution_id=source.id AND record_state='RECORDED'),0)
   +COALESCE((SELECT sum(a.amount) FROM abos.direct_capital_receipt_allocations a
    WHERE a.legal_entity_id=entity AND a.contribution_id=source.id),0) INTO allocated;
  piece:=least(remaining,greatest(source.amount-allocated,0));
  IF piece>0 THEN INSERT INTO abos.direct_capital_receipt_allocations(receipt_id,legal_entity_id,contribution_id,amount)
   VALUES(receipt,entity,source.id,piece); remaining:=remaining-piece; END IF;
  EXIT WHEN remaining=0;
 END LOOP;
 -- An agreed total is optional. Whatever an existing declaration covers is consumed exactly as the
 -- legacy lane consumes it; anything beyond it is ordinary unallocated capital, not a refusal.
 IF remaining<0 THEN RAISE EXCEPTION 'capital allocation arithmetic failed' USING ERRCODE='check_violation'; END IF;
 -- 0044: the posting kernel writes the intent, the draft journal, its lines and subledgers, and posts
 -- them. The shareholder subledger always moves; the Treasury subledger moves only when a Safe does.
 PERFORM abos.posting_kernel_draft(
  p_intent_id=>intent,p_journal_id=>journal,p_legal_entity_id=>entity,
  p_source_type=>'DIRECT_SHAREHOLDER_CAPITAL',p_source_id=>receipt,
  p_original_amount=>amount,p_original_currency_code=>currency,p_base_amount=>amount,p_base_currency_code=>currency,
  p_accounting_effective_date=>day,p_accounting_period_id=>period,p_journal_reference=>ref,
  p_correlation_id=>correlation,p_idempotency_key=>'DC:'||receipt::text,p_initial_status=>'VALIDATED',
  p_created_by_user_account_id=>actor,
  p_lines=>ARRAY[
   ROW(1,'DEBIT',debit_account,NULL,NULL,NULL,NULL,
    CASE WHEN cash_bearing THEN 'OPERATIONAL_TREASURY' END,CASE WHEN cash_bearing THEN 1 END,
    CASE WHEN cash_bearing THEN destination END,NULL)::abos.posting_kernel_line,
   ROW(2,'CREDIT',equity,party,NULL,NULL,NULL,'SHAREHOLDER_CAPITAL',-1,NULL,party)::abos.posting_kernel_line],
  p_finance_workflow_policy_version_id=>policy,p_operational_version=>1);
 PERFORM abos.posting_kernel_commit(intent,journal,actor);
 result:=jsonb_build_object('receiptId',receipt,'journalId',journal,'reference',ref,'status','POSTED','replayed',false);
 PERFORM abos.temporary_funding_audit(actor,entity,correlation,'SHAREHOLDER_CAPITAL_RECEIVED','DIRECT_CAPITAL_RECEIPT',receipt,
  result||jsonb_build_object('shareholderProfileId',profile,'fundingMethod',method,'amount',amount::text,'currency',currency,
    'treasuryAccountId',destination,'debitAccountId',debit_account,'equityAccountId',equity,
    'providerName',provider,'itemDescription',item,'allocatedToDeclarations',(amount-remaining)::text,'approvalOccurred',false));
 PERFORM abos.temporary_funding_idempotency_complete(scope,key,'DIRECT_CAPITAL_RECEIPT',receipt,result);
 RETURN result;
END $$;

-- ---------------------------------------------------------------------------------------------
-- 5. Privileges. CREATE OR REPLACE keeps both writers' owners, security and grants. The kernel runs
--    with its caller's rights; only the operational Finance owner may call it or name its type.
-- ---------------------------------------------------------------------------------------------

REVOKE ALL ON TYPE abos.posting_kernel_line FROM PUBLIC;
GRANT USAGE ON TYPE abos.posting_kernel_line TO abos_v1_operational_finance_owner;
REVOKE ALL ON FUNCTION
  abos.posting_kernel_draft(uuid, uuid, uuid, text, uuid, numeric, text, numeric, text, date, uuid,
    text, uuid, text, text, uuid, abos.posting_kernel_line[], uuid, uuid, uuid, text, uuid, integer),
  abos.posting_kernel_commit(uuid, uuid, uuid)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  abos.posting_kernel_draft(uuid, uuid, uuid, text, uuid, numeric, text, numeric, text, date, uuid,
    text, uuid, text, text, uuid, abos.posting_kernel_line[], uuid, uuid, uuid, text, uuid, integer),
  abos.posting_kernel_commit(uuid, uuid, uuid)
  TO abos_v1_operational_finance_owner;
