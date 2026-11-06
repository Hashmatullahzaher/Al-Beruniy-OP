-- 0064: foreign-currency Treasury carrying value. See docs/03-architecture/V1_FX_TREASURY_CARRYING_VALUE.md.
--
-- A foreign-currency Treasury account now carries weighted-average value. Nothing new is stored: native and base carrying are
-- both derived from the posted subledger, as they always were. What changes is the amount a movement posts to Treasury:
--
--   before: native x the day's rate, on every line
--   now:    what the account actually carries for that native, so native zero means carrying zero
--
-- The day's value stays where it already was, on the source row and its frozen conversion. The difference between the two is a
-- realized FX gain or loss, in the same journal, once. Base-currency movements take none of these paths and post as before.
--
-- 0063 stays as it is. This migration replaces its settlement, because a repayment now has two carrying values to reconcile.
-- No account is created, no permission is granted, no journal is created and no posted row is changed.

-- ---------------------------------------------------------------------------------------------
-- 1. The registry. Every lane that can carry foreign currency may need the one FX line.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE abos.posting_sources DISABLE TRIGGER posting_sources_no_update_or_delete;
UPDATE abos.posting_sources SET line_count_max = 3,
    debit_rules = debit_rules || '[{"control": "REALIZED_FX_LOSS", "accountType": "EXPENSE"}]'::jsonb,
    credit_rules = credit_rules || '[{"control": "REALIZED_FX_GAIN", "accountType": "REVENUE"}]'::jsonb
 WHERE source_type IN ('OPERATIONAL_EXPENSE', 'PAYMENT', 'CASH_RECEIPT', 'TREASURY_TRANSFER', 'LOAN_RECEIPT');
ALTER TABLE abos.posting_sources ENABLE TRIGGER posting_sources_no_update_or_delete;

-- ---------------------------------------------------------------------------------------------
-- 2. The canonical read and the one rule. Every lane calls these; none works carrying value out for itself.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION abos.treasury_carrying_position(p_account uuid, p_as_of date DEFAULT NULL)
RETURNS TABLE (native numeric, carrying numeric) LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $position$
  SELECT COALESCE(sum(entry.original_amount), 0), COALESCE(sum(entry.base_amount), 0)
    FROM abos.subledger_entries entry
    JOIN abos.journal_lines line ON line.id = entry.journal_line_id
    JOIN abos.journals journal ON journal.id = line.journal_id AND journal.status = 'POSTED'
   WHERE entry.subledger_type = 'OPERATIONAL_TREASURY' AND entry.operational_treasury_account_id = p_account
     AND (p_as_of IS NULL OR journal.accounting_effective_date <= p_as_of)
$position$;

-- The invariant, as a check: would adding this to the position leave native and value disagreeing, on its date or any later one? The sign
-- of the two must match, which covers native zero with a value left, a value of the wrong sign, and a balance with no value. A position
-- that already disagrees can only come from a history posted before 0064, and is not this movement's doing.
CREATE FUNCTION abos.treasury_position_stays_valid(p_account uuid, p_day date, p_native numeric, p_carrying numeric)
RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $valid$
  WITH days AS (
    SELECT journal.accounting_effective_date AS day, sum(entry.original_amount) AS native, sum(entry.base_amount) AS carrying
      FROM abos.subledger_entries entry
      JOIN abos.journal_lines line ON line.id = entry.journal_line_id
      JOIN abos.journals journal ON journal.id = line.journal_id AND journal.status = 'POSTED'
     WHERE entry.subledger_type = 'OPERATIONAL_TREASURY' AND entry.operational_treasury_account_id = p_account
     GROUP BY journal.accounting_effective_date
    UNION ALL SELECT p_day, 0, 0),
  running AS (SELECT d.day, sum(d.native) OVER w AS native, sum(d.carrying) OVER w AS carrying FROM days d WINDOW w AS (ORDER BY d.day))
  SELECT NOT EXISTS (SELECT 1 FROM running r WHERE r.day >= p_day AND sign(r.native) = sign(r.carrying)
                        AND sign(r.native + p_native) <> sign(r.carrying + p_carrying))
$valid$;

-- The carrying value one movement posts to Treasury, always positive. p_native is signed: positive in, negative out.
-- p_value is what the other side of the journal moves by. It is the amount added when this movement adds to the position.
CREATE FUNCTION abos.treasury_carrying_move(p_account abos.operational_treasury_accounts, p_base text, p_day date, p_native numeric, p_value numeric, p_scale integer)
RETURNS numeric LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $move$
DECLARE v_position record; v_scale integer; v_factor numeric; v_unit numeric; v_amount numeric; v_held numeric; v_value numeric; v_result numeric;
BEGIN
  IF p_account.currency_code = p_base THEN RETURN p_value; END IF;
  -- One movement at a time works out and posts against this position. A concurrent one waits here and then sees the first.
  PERFORM 1 FROM abos.operational_treasury_accounts WHERE id = p_account.id FOR NO KEY UPDATE;
  SELECT native, carrying INTO v_position FROM abos.treasury_carrying_position(p_account.id, p_day);
  v_amount := abs(p_native); v_held := abs(v_position.native); v_value := abs(v_position.carrying);
  v_scale := COALESCE(p_scale, (abos.fx_policy_resolve(p_account.legal_entity_id, p_account.currency_code, p_day)->>'baseScale')::integer);
  v_factor := 10::numeric ^ v_scale; v_unit := round(1 / v_factor, v_scale);
  IF v_position.native = 0 OR sign(v_position.native) = sign(p_native) THEN
    -- Nothing held, or more of the same: this adds to the position, at the value of this movement.
    v_result := p_value;
  ELSIF v_amount > v_held AND p_account.account_type IN ('SAFE', 'CASH_BOX', 'PETTY_CASH') THEN
    -- These never go below zero. The funds guard refuses this movement in its own words.
    RETURN p_value;
  ELSIF sign(v_position.carrying) <> sign(v_position.native) THEN
    -- Against the position, which has no value of the right sign to reduce. Only a history posted before 0064 can do this.
    RAISE EXCEPTION 'TREASURY_CARRYING_CORRECTION_REQUIRED: % holds % % at a value of %, which needs correcting before this movement', p_account.name_en, v_position.native, p_account.currency_code, v_position.carrying
      USING ERRCODE = 'check_violation';
  ELSIF v_amount = v_held THEN
    -- The last of it takes exactly what remains, so no rounding can be left behind.
    v_result := v_value;
  ELSIF v_amount > v_held THEN
    -- Through zero: all of the old position goes, and the rest opens a new one at this movement's value.
    v_result := v_value + GREATEST(round(div(2 * p_value * (v_amount - v_held) * v_factor + v_amount, 2 * v_amount) / v_factor, v_scale), v_unit);
  ELSE
    IF v_value < 2 * v_unit THEN
      RAISE EXCEPTION 'TREASURY_DISPOSE_IN_FULL: so little value remains in % that its balance can only be moved in full', p_account.name_en USING ERRCODE = 'check_violation';
    END IF;
    v_result := LEAST(GREATEST(round(div(2 * v_value * v_amount * v_factor + v_held, 2 * v_held) / v_factor, v_scale), v_unit), v_value - v_unit);
    -- One smallest unit apart is rounding, not a gain or a loss. It stays in the position, and the last movement clears it.
    IF abs(v_result - p_value) <= v_unit THEN v_result := LEAST(GREATEST(p_value, v_unit), v_value - v_unit); END IF;
  END IF;
  -- A movement dated behind others must not break the rule on a later day. Most never do; the few that would are refused here.
  IF NOT abos.treasury_position_stays_valid(p_account.id, p_day, p_native, sign(p_native) * v_result) THEN
    RAISE EXCEPTION 'TREASURY_FX_OUT_OF_ORDER: dated %, this would leave % with a value and no balance on a later day. Date it later, or reverse the later movement first', p_day, p_account.name_en
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN v_result;
END
$move$;

-- A journal's debit and credit sides differ only by realized FX. Lines 1 and 2 are the movement; line 3 is the difference, if there is one.
CREATE FUNCTION abos.realized_fx_append(p_lines abos.posting_kernel_line[], p_entity uuid, p_base text, p_debit numeric, p_credit numeric,
  p_project uuid DEFAULT NULL, p_department uuid DEFAULT NULL, p_cost_center uuid DEFAULT NULL)
RETURNS abos.posting_kernel_line[] LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $append$
BEGIN
  IF p_debit = p_credit THEN RETURN p_lines; END IF;
  RETURN p_lines || ROW(3, CASE WHEN p_credit > p_debit THEN 'DEBIT' ELSE 'CREDIT' END, abos.loan_fx_account(p_entity, p_credit - p_debit, p_base),
    NULL, p_project, p_department, p_cost_center, NULL, NULL, NULL, NULL)::abos.posting_kernel_line;
END
$append$;

CREATE FUNCTION abos.realized_fx_amounts(p_debit numeric, p_credit numeric)
RETURNS numeric[] LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $amounts$
  SELECT CASE WHEN p_debit = p_credit THEN ARRAY[p_debit, p_credit] ELSE ARRAY[p_debit, p_credit, abs(p_credit - p_debit)] END
$amounts$;

CREATE FUNCTION abos.realized_fx_matches(p_journal uuid, p_entity uuid, p_base text, p_debit numeric, p_credit numeric,
  p_project uuid DEFAULT NULL, p_department uuid DEFAULT NULL, p_cost_center uuid DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $matches$
DECLARE v_lines bigint;
BEGIN
  SELECT count(*) INTO v_lines FROM abos.journal_lines WHERE journal_id = p_journal;
  IF p_debit = p_credit THEN RETURN v_lines = 2; END IF;
  RETURN v_lines = 3 AND EXISTS (SELECT 1 FROM abos.journal_lines x WHERE x.journal_id = p_journal AND x.line_number = 3
    AND x.ledger_account_id = abos.loan_fx_account(p_entity, p_credit - p_debit, p_base) AND x.business_party_id IS NULL
    AND x.base_debit = GREATEST(p_credit - p_debit, 0) AND x.base_credit = GREATEST(p_debit - p_credit, 0)
    AND x.project_id IS NOT DISTINCT FROM p_project AND x.department_id IS NOT DISTINCT FROM p_department AND x.cost_center_id IS NOT DISTINCT FROM p_cost_center);
END
$matches$;

CREATE FUNCTION abos.fx_conversion_scale(p_conversion uuid)
RETURNS integer LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $scale$
  SELECT base_scale FROM abos.fx_conversions WHERE id = p_conversion
$scale$;

-- ---------------------------------------------------------------------------------------------
-- 3. Cash receipts. Into a position at or above zero this adds at the day's value, as before.
--    Into an amount owed in this currency it reduces that position, which can realize a difference.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION abos.treasury_receipt_record(p_proof text, p_runtime text, p_token text, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE c jsonb; actor uuid; entity uuid; req jsonb; amount numeric; day date; key text; correlation uuid; currency text; base text;
  v_account abos.operational_treasury_accounts%ROWTYPE; revenue uuid; party uuid; payer text; policy uuid; period uuid;
  scope text; fingerprint text; replay jsonb; ref text; result jsonb; v_base_amount numeric; v_conversion abos.fx_conversions%ROWTYPE;
  receipt uuid := gen_random_uuid(); journal uuid := gen_random_uuid(); intent uuid := gen_random_uuid(); v_carrying numeric;
BEGIN
  c := abos.treasury_safe_actor(p_proof, p_runtime, p_token, 'treasury.receipt.record');
  actor := (c->>'userAccountId')::uuid; entity := (c->>'legalEntityId')::uuid;
  req := abos.money_request(p_payload, ARRAY['treasuryAccountId', 'amount', 'currencyCode', 'businessDate', 'payerBusinessPartyId',
    'payerName', 'revenueLedgerAccountId', 'reference', 'note', 'idempotencyKey', 'correlationId', 'exchangeRateId']);
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
  base := abos.money_currency_base(entity, currency);
  v_account := abos.money_treasury_account(entity, abos.money_uuid(p_payload, 'treasuryAccountId'), currency);
  IF NOT EXISTS (SELECT 1 FROM abos.ledger_accounts WHERE id = revenue AND legal_entity_id = entity AND status = 'ACTIVE' AND posting_allowed
       AND account_type = 'REVENUE' AND control_account_type IS NULL AND account_currency_code IS NOT DISTINCT FROM base
       AND NOT requires_project AND NOT requires_department AND NOT requires_cost_center) THEN
    RAISE EXCEPTION 'choose an active income account in the accounting currency' USING ERRCODE = 'check_violation';
  END IF;
  policy := abos.money_movement_policy(entity, 'OTHER_INCOME');
  period := abos.open_period_for_business_date(entity, actor, day);
  IF currency = base THEN
    v_base_amount := amount;
  ELSE
    v_conversion := abos.fx_convert(entity, 'CASH_RECEIPT', receipt, currency, day, abos.money_uuid(p_payload, 'exchangeRateId'), actor, amount);
    v_base_amount := v_conversion.base_amount;
  END IF;
  v_carrying := abos.treasury_carrying_move(v_account, base, day, amount, v_base_amount, v_conversion.base_scale);
  ref := 'RC-' || to_char(day, 'YYYYMMDD') || '-' || upper(replace(receipt::text, '-', ''));
  INSERT INTO abos.treasury_cash_receipts (id, legal_entity_id, operational_treasury_account_id, currency_code, amount, business_date,
    payer_business_party_id, payer_name, revenue_ledger_account_id, reference, note, transaction_reference, workflow_policy_version_id,
    journal_id, created_by_user_account_id, correlation_id, idempotency_key, base_amount, fx_conversion_id)
  VALUES (receipt, entity, v_account.id, currency, amount, day, party, payer, revenue, NULLIF(btrim(p_payload->>'reference'), ''),
    NULLIF(btrim(p_payload->>'note'), ''), ref, policy, journal, actor, correlation, key, v_base_amount, v_conversion.id);
  PERFORM abos.posting_kernel_draft(
    p_intent_id => intent, p_journal_id => journal, p_legal_entity_id => entity, p_source_type => 'CASH_RECEIPT', p_source_id => receipt,
    p_original_amount => amount, p_original_currency_code => currency, p_base_amount => GREATEST(v_carrying, v_base_amount), p_base_currency_code => base,
    p_accounting_effective_date => day, p_accounting_period_id => period, p_journal_reference => ref, p_correlation_id => correlation,
    p_idempotency_key => 'RC:' || receipt::text, p_initial_status => 'VALIDATED', p_created_by_user_account_id => actor,
    p_lines => abos.realized_fx_append(ARRAY[
      ROW(1, 'DEBIT', v_account.ledger_account_id, NULL, NULL, NULL, NULL, 'OPERATIONAL_TREASURY', 1, v_account.id, NULL)::abos.posting_kernel_line,
      ROW(2, 'CREDIT', revenue, party, NULL, NULL, NULL, NULL, NULL, NULL, NULL)::abos.posting_kernel_line], entity, base, v_carrying, v_base_amount),
    p_conversion_snapshot_reference => v_conversion.exchange_rate_snapshot_id::text, p_finance_workflow_policy_version_id => policy,
    p_line_base_amounts => abos.realized_fx_amounts(v_carrying, v_base_amount));
  PERFORM abos.posting_kernel_commit(intent, journal, actor);
  result := jsonb_build_object('movementId', receipt, 'journalId', journal, 'reference', ref, 'currencyCode', currency, 'amount', amount::text,
    'baseAmount', v_base_amount::text, 'carryingAmount', v_carrying::text, 'realizedFx', (v_carrying - v_base_amount)::text, 'fxConversionId', v_conversion.id, 'status', 'POSTED', 'replayed', false);
  PERFORM abos.money_audit(actor, entity, correlation, 'TREASURY_CASH_RECEIPT_POSTED', 'TREASURY_CASH_RECEIPT', receipt,
    result || jsonb_build_object('treasuryAccountId', v_account.id, 'amount', amount::text, 'currency', currency, 'businessDate', day,
      'revenueAccountId', revenue, 'payerBusinessPartyId', party, 'payerName', payer));
  PERFORM abos.temporary_funding_idempotency_complete(scope, key, 'TREASURY_CASH_RECEIPT', receipt, result);
  RETURN result;
END
$function$;

CREATE OR REPLACE FUNCTION abos.validate_cash_receipt_journal(p_journal abos.journals, p_intent abos.posting_intents)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE r abos.treasury_cash_receipts%ROWTYPE; v_account abos.operational_treasury_accounts%ROWTYPE; v_value_intent abos.posting_intents%ROWTYPE; v_carrying numeric;
BEGIN
  SELECT * INTO r FROM abos.treasury_cash_receipts WHERE id = p_intent.source_id AND legal_entity_id = p_journal.legal_entity_id;
  -- The intent carries the journal's total. The conversion proves the day's value.
  v_value_intent := p_intent; v_value_intent.base_amount := r.base_amount;
  IF NOT FOUND OR r.journal_id <> p_journal.id OR p_intent.intent_kind <> 'CASH_RECEIPT' OR p_intent.treasury_receipt_id IS DISTINCT FROM r.id
     OR NOT abos.fx_source_matches(r.legal_entity_id, 'CASH_RECEIPT', r.id, r.currency_code, r.amount, r.base_amount, r.fx_conversion_id, v_value_intent)
     OR r.business_date <> p_journal.accounting_effective_date OR p_journal.journal_reference <> r.transaction_reference
     OR p_journal.posted_by_user_account_id IS DISTINCT FROM r.created_by_user_account_id
     OR p_intent.created_by_user_account_id <> r.created_by_user_account_id
     OR p_intent.finance_workflow_policy_version_id IS DISTINCT FROM r.workflow_policy_version_id
     OR NOT abos.workflow_policy_allows_direct(r.legal_entity_id, ARRAY['OTHER_INCOME'], r.workflow_policy_version_id) THEN
    RAISE EXCEPTION 'cash receipt journal does not match its source, amount, date, reference, policy or recorder' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_account FROM abos.operational_treasury_accounts WHERE id = r.operational_treasury_account_id
     AND legal_entity_id = r.legal_entity_id AND status = 'ACTIVE';
  IF NOT FOUND OR v_account.currency_code <> r.currency_code THEN
    RAISE EXCEPTION 'a cash receipt posts only to an active Safe or Saraf account in its currency' USING ERRCODE = 'check_violation';
  END IF;
  -- Worked out again from the journals: the posted lines must equal it exactly.
  v_carrying := abos.treasury_carrying_move(v_account, p_intent.base_currency_code, r.business_date, r.amount, r.base_amount, abos.fx_conversion_scale(r.fx_conversion_id));
  IF p_intent.base_amount <> GREATEST(v_carrying, r.base_amount)
     OR NOT abos.realized_fx_matches(p_journal.id, r.legal_entity_id, p_intent.base_currency_code, v_carrying, r.base_amount) THEN
    RAISE EXCEPTION 'a cash receipt has one line for its Treasury account, one for its income and one for any realized difference' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM abos.journal_lines l WHERE l.journal_id = p_journal.id AND l.line_number = 1
       AND l.ledger_account_id = v_account.ledger_account_id AND l.base_debit = v_carrying AND l.business_party_id IS NULL
       AND l.project_id IS NULL AND l.department_id IS NULL AND l.cost_center_id IS NULL)
     OR NOT EXISTS (SELECT 1 FROM abos.journal_lines l WHERE l.journal_id = p_journal.id AND l.line_number = 2
       AND l.ledger_account_id = r.revenue_ledger_account_id AND l.base_credit = r.base_amount
       AND l.business_party_id IS NOT DISTINCT FROM r.payer_business_party_id
       AND l.project_id IS NULL AND l.department_id IS NULL AND l.cost_center_id IS NULL) THEN
    RAISE EXCEPTION 'a cash receipt must debit its Treasury account and credit its income account' USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT count(*) FROM abos.subledger_entries e JOIN abos.journal_lines l ON l.id = e.journal_line_id WHERE l.journal_id = p_journal.id) <> 1
     OR NOT EXISTS (SELECT 1 FROM abos.subledger_entries e JOIN abos.journal_lines l ON l.id = e.journal_line_id
       WHERE l.journal_id = p_journal.id AND l.line_number = 1 AND e.subledger_type = 'OPERATIONAL_TREASURY'
         AND e.operational_treasury_account_id = v_account.id AND e.base_amount = v_carrying AND e.original_amount = r.amount) THEN
    RAISE EXCEPTION 'a cash receipt requires exactly its Treasury inflow' USING ERRCODE = 'check_violation';
  END IF;
END
$function$;

-- ---------------------------------------------------------------------------------------------
-- 4. An opening balance is the start of a position. It adds at its own value, and it cannot be slotted in behind an average,
--    or into an amount already owed: neither has a meaning for a balance that is simply stated.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION abos.treasury_opening_balance_record(p_proof text, p_runtime text, p_token text, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  c jsonb; actor uuid; entity uuid; v_account abos.operational_treasury_accounts%ROWTYPE; base text;
  amount numeric; day date; currency text; equity uuid; period uuid; account_id uuid;
  key text; correlation uuid; scope text; fingerprint text; replay jsonb; ref text; result jsonb;
  v_base_amount numeric; v_conversion abos.fx_conversions%ROWTYPE;
  opening uuid := gen_random_uuid(); journal uuid := gen_random_uuid(); intent uuid := gen_random_uuid();
BEGIN
  c := abos.treasury_safe_actor(p_proof, p_runtime, p_token, 'treasury.opening-balance.record');
  actor := (c->>'userAccountId')::uuid; entity := (c->>'legalEntityId')::uuid;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_payload) k
      WHERE k NOT IN ('treasuryAccountId', 'amount', 'currencyCode', 'asOfDate', 'reference', 'note', 'idempotencyKey', 'correlationId',
        'exchangeRateId')) THEN
    RAISE EXCEPTION 'unknown opening balance fields' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  amount := abos.temporary_funding_amount(p_payload->>'amount');
  key := NULLIF(btrim(p_payload->>'idempotencyKey'), '');
  BEGIN
    account_id := NULLIF(p_payload->>'treasuryAccountId', '')::uuid;
    day := NULLIF(p_payload->>'asOfDate', '')::date;
    correlation := NULLIF(p_payload->>'correlationId', '')::uuid;
  EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow OR invalid_datetime_format THEN
    RAISE EXCEPTION 'a Safe, an amount, an as-of date and a request key are required' USING ERRCODE = 'invalid_parameter_value';
  END;
  currency := p_payload->>'currencyCode';
  IF account_id IS NULL OR day IS NULL OR key IS NULL OR correlation IS NULL
     OR length(p_payload->>'reference') > 120 OR length(p_payload->>'note') > 1000 THEN
    RAISE EXCEPTION 'a Safe, an amount, an as-of date and a request key are required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF day > abos.business_today() THEN
    RAISE EXCEPTION 'an opening balance cannot be dated after today' USING ERRCODE = 'check_violation';
  END IF;
  -- Authorization precedes durable replay; an identical request returns the first result.
  scope := 'treasury:opening-balance:' || entity::text || ':' || actor::text;
  fingerprint := encode(sha256(convert_to((p_payload - 'correlationId')::text || actor::text, 'UTF8')), 'hex');
  replay := abos.temporary_funding_idempotency_begin(scope, key, fingerprint, correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  -- Concurrent attempts for one Safe serialize here; the second sees the first and is refused.
  PERFORM pg_advisory_xact_lock(hashtextextended('abos-treasury-opening:' || entity::text || ':' || account_id::text, 0));
  SELECT * INTO v_account FROM abos.operational_treasury_accounts WHERE id = account_id AND legal_entity_id = entity FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the Safe was not found in this legal entity' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_account.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'an opening balance needs an active Safe' USING ERRCODE = 'check_violation';
  END IF;
  IF currency IS DISTINCT FROM v_account.currency_code THEN
    RAISE EXCEPTION 'the opening balance must be in the Safe currency %', v_account.currency_code USING ERRCODE = 'check_violation';
  END IF;
  -- 0051: an opening balance may be in the Safe's own currency; a non-base one converts at the as-of day's rate.
  base := abos.money_currency_base(entity, currency);
  -- 0050: only an opening balance that has not been reversed blocks a new one (checked under the Safe lock).
  IF EXISTS (SELECT 1 FROM abos.treasury_opening_balances ob WHERE ob.operational_treasury_account_id = v_account.id
       AND NOT EXISTS (SELECT 1 FROM abos.journal_reversal_links link WHERE link.original_journal_id = ob.journal_id)) THEN
    RAISE EXCEPTION 'this Safe already has an opening balance; a posted opening balance is corrected by reversal'
      USING ERRCODE = 'check_violation';
  END IF;
  equity := abos.opening_balance_equity_account(entity, base);
  period := abos.open_period_for_business_date(entity, actor, day);
  IF currency = base THEN
    v_base_amount := amount;
  ELSE
    v_conversion := abos.fx_convert(entity, 'OPENING_BALANCE', opening, currency, day, abos.money_uuid(p_payload, 'exchangeRateId'), actor, amount);
    v_base_amount := v_conversion.base_amount;
  END IF;
  IF currency <> base AND abos.treasury_carrying_move(v_account, base, day, amount, v_base_amount, v_conversion.base_scale) <> v_base_amount THEN
    RAISE EXCEPTION 'TREASURY_FX_OPENING_ORDER: % already owes % at another value, so it cannot take an opening balance', v_account.name_en, currency USING ERRCODE = 'check_violation';
  END IF;
  ref := 'OB-' || to_char(day, 'YYYYMMDD') || '-' || upper(replace(opening::text, '-', ''));
  INSERT INTO abos.treasury_opening_balances (id, legal_entity_id, operational_treasury_account_id, currency_code, amount,
    as_of_date, reference, note, transaction_reference, equity_ledger_account_id, journal_id, created_by_user_account_id,
    correlation_id, idempotency_key, base_amount, fx_conversion_id)
  VALUES (opening, entity, v_account.id, currency, amount, day, NULLIF(btrim(p_payload->>'reference'), ''),
    NULLIF(btrim(p_payload->>'note'), ''), ref, equity, journal, actor, correlation, key, v_base_amount, v_conversion.id);
  PERFORM abos.posting_kernel_draft(
    p_intent_id => intent, p_journal_id => journal, p_legal_entity_id => entity,
    p_source_type => 'OPENING_BALANCE', p_source_id => opening,
    p_original_amount => amount, p_original_currency_code => currency, p_base_amount => v_base_amount, p_base_currency_code => base,
    p_accounting_effective_date => day, p_accounting_period_id => period, p_journal_reference => ref,
    p_correlation_id => correlation, p_idempotency_key => 'OB:' || opening::text, p_initial_status => 'VALIDATED',
    p_created_by_user_account_id => actor,
    p_lines => ARRAY[
      ROW(1, 'DEBIT', v_account.ledger_account_id, NULL, NULL, NULL, NULL, 'OPERATIONAL_TREASURY', 1, v_account.id, NULL)::abos.posting_kernel_line,
      ROW(2, 'CREDIT', equity, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)::abos.posting_kernel_line],
    p_conversion_snapshot_reference => v_conversion.exchange_rate_snapshot_id::text);
  PERFORM abos.posting_kernel_commit(intent, journal, actor);
  result := jsonb_build_object('openingBalanceId', opening, 'journalId', journal, 'reference', ref, 'currencyCode', currency,
    'amount', amount::text, 'baseAmount', v_base_amount::text, 'fxConversionId', v_conversion.id, 'status', 'POSTED', 'replayed', false);
  INSERT INTO abos.audit_records (id, actor_user_account_id, legal_entity_id, correlation_id, action, entity_type, entity_id, after_state, metadata)
  VALUES (gen_random_uuid(), actor, entity, correlation, 'TREASURY_OPENING_BALANCE_POSTED', 'TREASURY_OPENING_BALANCE', opening,
    result || jsonb_build_object('treasuryAccountId', v_account.id, 'amount', amount::text, 'currency', currency, 'asOfDate', day,
      'equityAccountId', equity), jsonb_build_object('source', 'v1-treasury-opening-balance'));
  INSERT INTO abos.outbox_events (id, aggregate_type, aggregate_id, event_type, event_version, legal_entity_id, actor_user_account_id,
    correlation_id, payload, occurred_at)
  VALUES (gen_random_uuid(), 'TREASURY_OPENING_BALANCE', opening, 'finance.treasury-opening-balance.posted', 1, entity, actor, correlation,
    jsonb_build_object('openingBalanceId', opening, 'journalId', journal, 'treasuryAccountId', v_account.id), clock_timestamp());
  PERFORM abos.temporary_funding_idempotency_complete(scope, key, 'TREASURY_OPENING_BALANCE', opening, result);
  RETURN result;
END
$function$;

-- ---------------------------------------------------------------------------------------------
-- 5. Expenses. The expense stays at its transaction-date value. Treasury gives up what it carries. The FX line keeps the expense's dimensions.
-- ---------------------------------------------------------------------------------------------
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
  v_carrying numeric;
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
  v_carrying := abos.treasury_carrying_move(treasury, expense.base_currency_code, expense.business_date, -expense.original_amount, expense.base_amount,
    (SELECT conversion.base_scale FROM abos.fx_conversions conversion WHERE conversion.source_type = 'OPERATIONAL_EXPENSE' AND conversion.source_id = expense.id));

  PERFORM abos.posting_kernel_draft(
    p_intent_id => v_intent_id, p_journal_id => v_journal_id,
    p_legal_entity_id => expense.legal_entity_id,
    p_source_type => 'OPERATIONAL_EXPENSE', p_source_id => expense.id,
    p_original_amount => expense.original_amount,
    p_original_currency_code => expense.original_currency_code,
    p_base_amount => GREATEST(expense.base_amount, v_carrying), p_base_currency_code => expense.base_currency_code,
    p_accounting_effective_date => expense.business_date, p_accounting_period_id => period_id,
    p_journal_reference => 'OPX-' || v_journal_id::text,
    p_correlation_id => expense.correlation_id,
    p_idempotency_key => 'OPX:' || expense.idempotency_key,
    p_initial_status => initial_intent_status,
    p_created_by_user_account_id => expense.created_by_user_account_id,
    p_lines => abos.realized_fx_append(ARRAY[
      ROW(1, 'DEBIT', category.ledger_account_id, expense.payee_business_party_id,
          expense.project_id, expense.department_id, expense.cost_center_id,
          NULL, NULL, NULL, NULL)::abos.posting_kernel_line,
      ROW(2, 'CREDIT', treasury.ledger_account_id, NULL,
          expense.project_id, expense.department_id, expense.cost_center_id,
          'OPERATIONAL_TREASURY', -1, expense.operational_treasury_account_id, NULL)::abos.posting_kernel_line],
      expense.legal_entity_id, expense.base_currency_code, expense.base_amount, v_carrying, expense.project_id, expense.department_id, expense.cost_center_id),
    p_project_id => expense.project_id, p_department_id => expense.department_id,
    p_cost_center_id => expense.cost_center_id,
    p_conversion_snapshot_reference => snapshot_reference,
    p_line_base_amounts => abos.realized_fx_amounts(expense.base_amount, v_carrying));
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
  v_carrying numeric;
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
    IF EXISTS (SELECT 1 FROM abos.fx_conversions conversion WHERE conversion.source_type = 'OPERATIONAL_EXPENSE'
         AND conversion.source_id = expense_row.id) THEN
      IF NOT EXISTS (SELECT 1 FROM abos.fx_conversions conversion WHERE conversion.source_type = 'OPERATIONAL_EXPENSE'
           AND conversion.source_id = expense_row.id AND conversion.legal_entity_id = p_journal.legal_entity_id
           AND conversion.exchange_rate_snapshot_id = snapshot_row.id AND conversion.original_amount = expense_row.original_amount
           AND conversion.original_currency_code = expense_row.original_currency_code
           AND conversion.base_currency_code = expense_row.base_currency_code AND conversion.base_amount = expense_row.base_amount) THEN
        RAISE EXCEPTION 'foreign-currency expense requires its immutable FX conversion'
          USING ERRCODE = 'check_violation';
      END IF;
    ELSIF snapshot_row.unit_currency_code = expense_row.original_currency_code
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

  -- Worked out again from the journals: the posted lines must equal it exactly.
  v_carrying := abos.treasury_carrying_move(treasury_row, expense_row.base_currency_code, expense_row.business_date, -expense_row.original_amount, expense_row.base_amount,
    (SELECT conversion.base_scale FROM abos.fx_conversions conversion WHERE conversion.source_type = 'OPERATIONAL_EXPENSE' AND conversion.source_id = expense_row.id));
  IF p_intent.base_amount <> GREATEST(expense_row.base_amount, v_carrying)
     OR NOT abos.realized_fx_matches(p_journal.id, expense_row.legal_entity_id, expense_row.base_currency_code, expense_row.base_amount, v_carrying,
          expense_row.project_id, expense_row.department_id, expense_row.cost_center_id) THEN
    RAISE EXCEPTION 'an expense has one line for its category, one for its Treasury account and one for any realized difference' USING ERRCODE = 'check_violation';
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
      AND line.base_debit = 0 AND line.base_credit = v_carrying
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
     AND entry.base_amount = -v_carrying;
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
    'treasuryCarryingAmount', (SELECT abs(entry.base_amount)::text FROM abos.subledger_entries entry JOIN abos.journal_lines line ON line.id = entry.journal_line_id
       WHERE line.journal_id = expense.journal_id AND entry.subledger_type = 'OPERATIONAL_TREASURY'),
    'realizedFx', CASE WHEN expense.journal_id IS NOT NULL THEN abos.loan_journal_realized_fx(expense.journal_id)::text END,
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
    -- 0050: a reversed expense shows its reversal; an expense that was never reversed reads as before.
    || COALESCE((SELECT pg_catalog.jsonb_build_object('reversal', pg_catalog.jsonb_build_object('journalId', link.reversal_journal_id,
         'reference', reversal.journal_reference, 'date', reversal.accounting_effective_date, 'reason', link.reason))
       FROM abos.journal_reversal_links link JOIN abos.journals reversal ON reversal.id = link.reversal_journal_id
      WHERE link.original_journal_id = expense.journal_id), '{}'::jsonb)
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

-- ---------------------------------------------------------------------------------------------
-- 6. Payments. The payable clears at the transaction-date value. Treasury gives up what it carries.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION abos.treasury_payment_record(p_proof text, p_runtime text, p_token text, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE c jsonb; actor uuid; entity uuid; req jsonb; amount numeric; day date; key text; correlation uuid; currency text; base text;
  v_account abos.operational_treasury_accounts%ROWTYPE; payable uuid; party uuid; payee text; kind text; policy uuid; period uuid;
  scope text; fingerprint text; replay jsonb; ref text; result jsonb; v_base_amount numeric; v_conversion abos.fx_conversions%ROWTYPE;
  payment uuid := gen_random_uuid(); journal uuid := gen_random_uuid(); intent uuid := gen_random_uuid(); v_carrying numeric;
BEGIN
  c := abos.treasury_safe_actor(p_proof, p_runtime, p_token, 'treasury.payment.record');
  actor := (c->>'userAccountId')::uuid; entity := (c->>'legalEntityId')::uuid;
  req := abos.money_request(p_payload, ARRAY['treasuryAccountId', 'paymentKind', 'payeeBusinessPartyId', 'payeeName', 'payableLedgerAccountId',
    'amount', 'currencyCode', 'businessDate', 'reference', 'note', 'idempotencyKey', 'correlationId', 'exchangeRateId']);
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
  base := abos.money_currency_base(entity, currency);
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
  IF currency = base THEN
    v_base_amount := amount;
  ELSE
    v_conversion := abos.fx_convert(entity, 'PAYMENT', payment, currency, day, abos.money_uuid(p_payload, 'exchangeRateId'), actor, amount);
    v_base_amount := v_conversion.base_amount;
  END IF;
  v_carrying := abos.treasury_carrying_move(v_account, base, day, -amount, v_base_amount, v_conversion.base_scale);
  ref := 'PY-' || to_char(day, 'YYYYMMDD') || '-' || upper(replace(payment::text, '-', ''));
  INSERT INTO abos.treasury_payments (id, legal_entity_id, operational_treasury_account_id, payment_kind, payee_business_party_id, payee_name,
    payable_ledger_account_id, currency_code, amount, business_date, reference, note, transaction_reference, workflow_policy_version_id,
    journal_id, created_by_user_account_id, correlation_id, idempotency_key, base_amount, fx_conversion_id)
  VALUES (payment, entity, v_account.id, kind, party, payee, payable, currency, amount, day, NULLIF(btrim(p_payload->>'reference'), ''),
    NULLIF(btrim(p_payload->>'note'), ''), ref, policy, journal, actor, correlation, key, v_base_amount, v_conversion.id);
  PERFORM abos.posting_kernel_draft(
    p_intent_id => intent, p_journal_id => journal, p_legal_entity_id => entity, p_source_type => 'PAYMENT', p_source_id => payment,
    p_original_amount => amount, p_original_currency_code => currency, p_base_amount => GREATEST(v_base_amount, v_carrying), p_base_currency_code => base,
    p_accounting_effective_date => day, p_accounting_period_id => period, p_journal_reference => ref, p_correlation_id => correlation,
    p_idempotency_key => 'PY:' || payment::text, p_initial_status => 'VALIDATED', p_created_by_user_account_id => actor,
    p_lines => abos.realized_fx_append(ARRAY[
      ROW(1, 'DEBIT', payable, party, NULL, NULL, NULL, NULL, NULL, NULL, NULL)::abos.posting_kernel_line,
      ROW(2, 'CREDIT', v_account.ledger_account_id, NULL, NULL, NULL, NULL, 'OPERATIONAL_TREASURY', -1, v_account.id, NULL)::abos.posting_kernel_line], entity, base, v_base_amount, v_carrying),
    p_conversion_snapshot_reference => v_conversion.exchange_rate_snapshot_id::text, p_finance_workflow_policy_version_id => policy,
    p_line_base_amounts => abos.realized_fx_amounts(v_base_amount, v_carrying));
  PERFORM abos.posting_kernel_commit(intent, journal, actor);
  result := jsonb_build_object('movementId', payment, 'journalId', journal, 'reference', ref, 'currencyCode', currency, 'amount', amount::text,
    'baseAmount', v_base_amount::text, 'carryingAmount', v_carrying::text, 'realizedFx', (v_base_amount - v_carrying)::text, 'fxConversionId', v_conversion.id, 'status', 'POSTED', 'replayed', false);
  PERFORM abos.money_audit(actor, entity, correlation, 'TREASURY_PAYMENT_POSTED', 'TREASURY_PAYMENT', payment,
    result || jsonb_build_object('treasuryAccountId', v_account.id, 'paymentKind', kind, 'amount', amount::text, 'currency', currency,
      'businessDate', day, 'payableAccountId', payable, 'payeeBusinessPartyId', party, 'payeeName', payee));
  PERFORM abos.temporary_funding_idempotency_complete(scope, key, 'TREASURY_PAYMENT', payment, result);
  RETURN result;
END
$function$;

CREATE OR REPLACE FUNCTION abos.validate_payment_journal(p_journal abos.journals, p_intent abos.posting_intents)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE p abos.treasury_payments%ROWTYPE; v_account abos.operational_treasury_accounts%ROWTYPE; v_value_intent abos.posting_intents%ROWTYPE; v_carrying numeric;
BEGIN
  SELECT * INTO p FROM abos.treasury_payments WHERE id = p_intent.source_id AND legal_entity_id = p_journal.legal_entity_id;
  -- The intent carries the journal's total. The conversion proves the day's value.
  v_value_intent := p_intent; v_value_intent.base_amount := p.base_amount;
  IF NOT FOUND OR p.journal_id <> p_journal.id OR p_intent.intent_kind <> 'PAYMENT' OR p_intent.treasury_payment_id IS DISTINCT FROM p.id
     OR NOT abos.fx_source_matches(p.legal_entity_id, 'PAYMENT', p.id, p.currency_code, p.amount, p.base_amount, p.fx_conversion_id, v_value_intent)
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
  IF NOT FOUND OR v_account.currency_code <> p.currency_code THEN
    RAISE EXCEPTION 'a payment posts only from an active Safe or Saraf account in its currency' USING ERRCODE = 'check_violation';
  END IF;
  IF p.payee_business_party_id IS NULL AND EXISTS (SELECT 1 FROM abos.ledger_accounts a WHERE a.id = p.payable_ledger_account_id
       AND a.control_account_type = 'AP') THEN
    RAISE EXCEPTION 'a payment against accounts payable needs the person or organization it was owed to' USING ERRCODE = 'check_violation';
  END IF;
  -- Worked out again from the journals: the posted lines must equal it exactly.
  v_carrying := abos.treasury_carrying_move(v_account, p_intent.base_currency_code, p.business_date, -p.amount, p.base_amount, abos.fx_conversion_scale(p.fx_conversion_id));
  IF p_intent.base_amount <> GREATEST(p.base_amount, v_carrying)
     OR NOT abos.realized_fx_matches(p_journal.id, p.legal_entity_id, p_intent.base_currency_code, p.base_amount, v_carrying) THEN
    RAISE EXCEPTION 'a payment has one line for its payable, one for its Treasury account and one for any realized difference' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM abos.journal_lines l WHERE l.journal_id = p_journal.id AND l.line_number = 1
       AND l.ledger_account_id = p.payable_ledger_account_id AND l.base_debit = p.base_amount
       AND l.business_party_id IS NOT DISTINCT FROM p.payee_business_party_id
       AND l.project_id IS NULL AND l.department_id IS NULL AND l.cost_center_id IS NULL)
     OR NOT EXISTS (SELECT 1 FROM abos.journal_lines l WHERE l.journal_id = p_journal.id AND l.line_number = 2
       AND l.ledger_account_id = v_account.ledger_account_id AND l.base_credit = v_carrying AND l.business_party_id IS NULL
       AND l.project_id IS NULL AND l.department_id IS NULL AND l.cost_center_id IS NULL) THEN
    RAISE EXCEPTION 'a payment must debit its payable and credit its Treasury account' USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT count(*) FROM abos.subledger_entries e JOIN abos.journal_lines l ON l.id = e.journal_line_id WHERE l.journal_id = p_journal.id) <> 1
     OR NOT EXISTS (SELECT 1 FROM abos.subledger_entries e JOIN abos.journal_lines l ON l.id = e.journal_line_id
       WHERE l.journal_id = p_journal.id AND l.line_number = 2 AND e.subledger_type = 'OPERATIONAL_TREASURY'
         AND e.operational_treasury_account_id = v_account.id AND e.base_amount = -v_carrying AND e.original_amount = -p.amount) THEN
    RAISE EXCEPTION 'a payment requires exactly its Treasury outflow' USING ERRCODE = 'check_violation';
  END IF;
END
$function$;

-- ---------------------------------------------------------------------------------------------
-- 7. Transfers. Carrying value moves with the money, so the day's rate plays no part and nothing is realized.
--    The one exception is a destination that owes this currency: the money settles that position, at its own carrying value.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION abos.treasury_transfer_record(p_proof text, p_runtime text, p_token text, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE c jsonb; actor uuid; entity uuid; req jsonb; amount numeric; day date; key text; correlation uuid; currency text; base text;
  v_source abos.operational_treasury_accounts%ROWTYPE; v_destination abos.operational_treasury_accounts%ROWTYPE; source_id uuid; destination_id uuid;
  policy uuid; period uuid; scope text; fingerprint text; replay jsonb; ref text; result jsonb; v_base_amount numeric; v_conversion abos.fx_conversions%ROWTYPE;
  transfer uuid := gen_random_uuid(); journal uuid := gen_random_uuid(); intent uuid := gen_random_uuid(); v_out numeric; v_in numeric;
BEGIN
  c := abos.treasury_safe_actor(p_proof, p_runtime, p_token, 'treasury.transfer.record');
  actor := (c->>'userAccountId')::uuid; entity := (c->>'legalEntityId')::uuid;
  req := abos.money_request(p_payload, ARRAY['sourceTreasuryAccountId', 'destinationTreasuryAccountId', 'amount', 'currencyCode',
    'businessDate', 'reference', 'note', 'idempotencyKey', 'correlationId', 'exchangeRateId']);
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
  base := abos.money_currency_base(entity, currency);
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
  IF currency = base THEN
    v_base_amount := amount;
  ELSE
    v_conversion := abos.fx_convert(entity, 'TREASURY_TRANSFER', transfer, currency, day, abos.money_uuid(p_payload, 'exchangeRateId'), actor, amount);
    v_base_amount := v_conversion.base_amount;
  END IF;
  v_out := abos.treasury_carrying_move(v_source, base, day, -amount, v_base_amount, v_conversion.base_scale);
  v_in := abos.treasury_carrying_move(v_destination, base, day, amount, v_out, v_conversion.base_scale);
  ref := 'TR-' || to_char(day, 'YYYYMMDD') || '-' || upper(replace(transfer::text, '-', ''));
  INSERT INTO abos.treasury_transfers (id, legal_entity_id, source_treasury_account_id, destination_treasury_account_id, currency_code,
    amount, business_date, reference, note, transaction_reference, workflow_policy_version_id, journal_id, created_by_user_account_id,
    correlation_id, idempotency_key, base_amount, fx_conversion_id)
  VALUES (transfer, entity, v_source.id, v_destination.id, currency, amount, day, NULLIF(btrim(p_payload->>'reference'), ''),
    NULLIF(btrim(p_payload->>'note'), ''), ref, policy, journal, actor, correlation, key, v_base_amount, v_conversion.id);
  PERFORM abos.posting_kernel_draft(
    p_intent_id => intent, p_journal_id => journal, p_legal_entity_id => entity, p_source_type => 'TREASURY_TRANSFER', p_source_id => transfer,
    p_original_amount => amount, p_original_currency_code => currency, p_base_amount => GREATEST(v_in, v_out), p_base_currency_code => base,
    p_accounting_effective_date => day, p_accounting_period_id => period, p_journal_reference => ref, p_correlation_id => correlation,
    p_idempotency_key => 'TR:' || transfer::text, p_initial_status => 'VALIDATED', p_created_by_user_account_id => actor,
    p_lines => abos.realized_fx_append(ARRAY[
      ROW(1, 'DEBIT', v_destination.ledger_account_id, NULL, NULL, NULL, NULL, 'OPERATIONAL_TREASURY', 1, v_destination.id, NULL)::abos.posting_kernel_line,
      ROW(2, 'CREDIT', v_source.ledger_account_id, NULL, NULL, NULL, NULL, 'OPERATIONAL_TREASURY', -1, v_source.id, NULL)::abos.posting_kernel_line], entity, base, v_in, v_out),
    p_conversion_snapshot_reference => v_conversion.exchange_rate_snapshot_id::text, p_finance_workflow_policy_version_id => policy,
    p_line_base_amounts => abos.realized_fx_amounts(v_in, v_out));
  PERFORM abos.posting_kernel_commit(intent, journal, actor);
  result := jsonb_build_object('movementId', transfer, 'journalId', journal, 'reference', ref, 'currencyCode', currency, 'amount', amount::text,
    'baseAmount', v_base_amount::text, 'carryingAmount', v_out::text, 'realizedFx', (v_in - v_out)::text, 'fxConversionId', v_conversion.id, 'status', 'POSTED', 'replayed', false);
  PERFORM abos.money_audit(actor, entity, correlation, 'TREASURY_TRANSFER_POSTED', 'TREASURY_TRANSFER', transfer,
    result || jsonb_build_object('sourceTreasuryAccountId', v_source.id, 'destinationTreasuryAccountId', v_destination.id,
      'amount', amount::text, 'currency', currency, 'businessDate', day));
  PERFORM abos.temporary_funding_idempotency_complete(scope, key, 'TREASURY_TRANSFER', transfer, result);
  RETURN result;
END
$function$;

CREATE OR REPLACE FUNCTION abos.validate_treasury_transfer_journal(p_journal abos.journals, p_intent abos.posting_intents)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE t abos.treasury_transfers%ROWTYPE; v_source abos.operational_treasury_accounts%ROWTYPE; v_destination abos.operational_treasury_accounts%ROWTYPE;
  v_value_intent abos.posting_intents%ROWTYPE; v_out numeric; v_in numeric; v_scale integer;
BEGIN
  SELECT * INTO t FROM abos.treasury_transfers WHERE id = p_intent.source_id AND legal_entity_id = p_journal.legal_entity_id;
  -- The intent carries the journal's total. The conversion proves the day's value.
  v_value_intent := p_intent; v_value_intent.base_amount := t.base_amount;
  IF NOT FOUND OR t.journal_id <> p_journal.id OR p_intent.intent_kind <> 'TREASURY_TRANSFER' OR p_intent.treasury_transfer_id IS DISTINCT FROM t.id
     OR NOT abos.fx_source_matches(t.legal_entity_id, 'TREASURY_TRANSFER', t.id, t.currency_code, t.amount, t.base_amount, t.fx_conversion_id, v_value_intent)
     OR t.business_date <> p_journal.accounting_effective_date OR p_journal.journal_reference <> t.transaction_reference
     OR p_journal.posted_by_user_account_id IS DISTINCT FROM t.created_by_user_account_id
     OR p_intent.created_by_user_account_id <> t.created_by_user_account_id
     OR p_intent.finance_workflow_policy_version_id IS DISTINCT FROM t.workflow_policy_version_id
     OR NOT abos.workflow_policy_allows_direct(t.legal_entity_id, ARRAY['TREASURY_TRANSFER'], t.workflow_policy_version_id) THEN
    RAISE EXCEPTION 'transfer journal does not match its source, amount, date, reference, policy or recorder' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_source FROM abos.operational_treasury_accounts WHERE id = t.source_treasury_account_id AND legal_entity_id = t.legal_entity_id AND status = 'ACTIVE';
  SELECT * INTO v_destination FROM abos.operational_treasury_accounts WHERE id = t.destination_treasury_account_id AND legal_entity_id = t.legal_entity_id AND status = 'ACTIVE';
  IF v_source.id IS NULL OR v_destination.id IS NULL OR v_source.currency_code <> t.currency_code OR v_destination.currency_code <> t.currency_code THEN
    RAISE EXCEPTION 'a transfer posts only between active Safe or Saraf accounts' USING ERRCODE = 'check_violation';
  END IF;
  -- Worked out again from the journals: the posted lines must equal it exactly.
  v_scale := abos.fx_conversion_scale(t.fx_conversion_id);
  v_out := abos.treasury_carrying_move(v_source, p_intent.base_currency_code, t.business_date, -t.amount, t.base_amount, v_scale);
  v_in := abos.treasury_carrying_move(v_destination, p_intent.base_currency_code, t.business_date, t.amount, v_out, v_scale);
  IF p_intent.base_amount <> GREATEST(v_in, v_out) OR NOT abos.realized_fx_matches(p_journal.id, t.legal_entity_id, p_intent.base_currency_code, v_in, v_out) THEN
    RAISE EXCEPTION 'a transfer has one line for each account and one for any realized difference' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM abos.journal_lines l WHERE l.journal_id = p_journal.id AND l.line_number = 1
       AND l.ledger_account_id = v_destination.ledger_account_id AND l.base_debit = v_in AND l.business_party_id IS NULL
       AND l.project_id IS NULL AND l.department_id IS NULL AND l.cost_center_id IS NULL)
     OR NOT EXISTS (SELECT 1 FROM abos.journal_lines l WHERE l.journal_id = p_journal.id AND l.line_number = 2
       AND l.ledger_account_id = v_source.ledger_account_id AND l.base_credit = v_out AND l.business_party_id IS NULL
       AND l.project_id IS NULL AND l.department_id IS NULL AND l.cost_center_id IS NULL) THEN
    RAISE EXCEPTION 'a transfer must debit its destination and credit its source' USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT count(*) FROM abos.subledger_entries e JOIN abos.journal_lines l ON l.id = e.journal_line_id WHERE l.journal_id = p_journal.id) <> 2
     OR NOT EXISTS (SELECT 1 FROM abos.subledger_entries e JOIN abos.journal_lines l ON l.id = e.journal_line_id
       WHERE l.journal_id = p_journal.id AND l.line_number = 1 AND e.subledger_type = 'OPERATIONAL_TREASURY'
         AND e.operational_treasury_account_id = v_destination.id AND e.base_amount = v_in AND e.original_amount = t.amount)
     OR NOT EXISTS (SELECT 1 FROM abos.subledger_entries e JOIN abos.journal_lines l ON l.id = e.journal_line_id
       WHERE l.journal_id = p_journal.id AND l.line_number = 2 AND e.subledger_type = 'OPERATIONAL_TREASURY'
         AND e.operational_treasury_account_id = v_source.id AND e.base_amount = -v_out AND e.original_amount = -t.amount) THEN
    RAISE EXCEPTION 'a transfer requires exactly its destination inflow and source outflow' USING ERRCODE = 'check_violation';
  END IF;
END
$function$;

-- ---------------------------------------------------------------------------------------------
-- 8. Loans. A receipt behaves like any inflow. A repayment now has two carrying values: the liability's and the Treasury's.
--    The difference between those two is the whole realized effect, so AFN borrowed and repaid from the same basis realizes nothing.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION abos.loan_post(p_loan uuid, p_actor uuid, p_decided boolean)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE l abos.loans%ROWTYPE; v_account abos.operational_treasury_accounts%ROWTYPE; v_period uuid; v_snapshot text; v_scale integer; v_carrying numeric;
  v_journal uuid := gen_random_uuid(); v_intent uuid := gen_random_uuid();
BEGIN
  IF current_user <> 'abos_v1_operational_finance_owner' THEN
    RAISE EXCEPTION 'loan posting is internal' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO l FROM abos.loans WHERE id = p_loan FOR UPDATE;
  v_account := abos.money_treasury_account(l.legal_entity_id, l.operational_treasury_account_id, l.original_currency_code);
  v_period := abos.open_period_for_business_date(l.legal_entity_id, p_actor, l.business_date);
  SELECT exchange_rate_snapshot_id::text, base_scale INTO v_snapshot, v_scale FROM abos.fx_conversions WHERE id = l.fx_conversion_id;
  v_carrying := abos.treasury_carrying_move(v_account, l.base_currency_code, l.business_date, l.original_amount, l.base_amount, v_scale);
  PERFORM abos.posting_kernel_draft(
    p_intent_id => v_intent, p_journal_id => v_journal, p_legal_entity_id => l.legal_entity_id, p_source_type => 'LOAN_RECEIPT', p_source_id => l.id,
    p_original_amount => l.original_amount, p_original_currency_code => l.original_currency_code, p_base_amount => GREATEST(v_carrying, l.base_amount), p_base_currency_code => l.base_currency_code,
    p_accounting_effective_date => l.business_date, p_accounting_period_id => v_period, p_journal_reference => l.transaction_reference, p_correlation_id => l.correlation_id,
    p_idempotency_key => 'LN:' || l.id::text, p_initial_status => CASE WHEN p_decided THEN 'APPROVED' ELSE 'VALIDATED' END, p_created_by_user_account_id => l.created_by_user_account_id,
    p_lines => abos.realized_fx_append(ARRAY[
      ROW(1, 'DEBIT', v_account.ledger_account_id, NULL, NULL, NULL, NULL, 'OPERATIONAL_TREASURY', 1, v_account.id, NULL)::abos.posting_kernel_line,
      ROW(2, 'CREDIT', l.liability_ledger_account_id, l.lender_business_party_id, NULL, NULL, NULL, 'LOAN_PAYABLE', -1, NULL, l.lender_business_party_id)::abos.posting_kernel_line],
      l.legal_entity_id, l.base_currency_code, v_carrying, l.base_amount),
    p_conversion_snapshot_reference => v_snapshot, p_finance_workflow_policy_version_id => l.workflow_policy_version_id,
    p_line_base_amounts => abos.realized_fx_amounts(v_carrying, l.base_amount));
  -- The decision and the posting are one change: the validator proves the approver is the one who posted.
  UPDATE abos.loans SET status = 'POSTED', journal_id = v_journal, decided_by_user_account_id = CASE WHEN p_decided THEN p_actor END,
         decided_at = CASE WHEN p_decided THEN clock_timestamp() END WHERE id = l.id;
  PERFORM abos.posting_kernel_commit(v_intent, v_journal, p_actor);
  RETURN v_journal;
END
$function$;

CREATE OR REPLACE FUNCTION abos.validate_loan_receipt_journal(p_journal abos.journals, p_intent abos.posting_intents)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE l abos.loans%ROWTYPE; v_account abos.operational_treasury_accounts%ROWTYPE; v_value_intent abos.posting_intents%ROWTYPE; v_carrying numeric;
BEGIN
  SELECT * INTO l FROM abos.loans WHERE id = p_intent.source_id AND legal_entity_id = p_journal.legal_entity_id;
  -- The intent carries the journal's total. The conversion proves the day's value.
  v_value_intent := p_intent; v_value_intent.base_amount := l.base_amount;
  IF NOT FOUND OR l.status <> 'POSTED' OR l.journal_id <> p_journal.id OR p_intent.intent_kind <> 'LOAN_RECEIPT' OR p_intent.loan_id IS DISTINCT FROM l.id
     OR NOT abos.fx_source_matches(l.legal_entity_id, 'LOAN_RECEIPT', l.id, l.original_currency_code, l.original_amount, l.base_amount, l.fx_conversion_id, v_value_intent)
     OR l.business_date <> p_journal.accounting_effective_date OR p_journal.journal_reference <> l.transaction_reference
     OR p_intent.created_by_user_account_id <> l.created_by_user_account_id
     OR p_intent.finance_workflow_policy_version_id IS DISTINCT FROM l.workflow_policy_version_id
     OR NOT (CASE WHEN l.decided_by_user_account_id IS NULL
          THEN p_journal.posted_by_user_account_id = l.created_by_user_account_id
           AND abos.workflow_policy_allows_direct(l.legal_entity_id, ARRAY['LOAN'], l.workflow_policy_version_id)
          ELSE p_journal.posted_by_user_account_id = l.decided_by_user_account_id
           AND l.decided_by_user_account_id <> l.created_by_user_account_id END) THEN
    RAISE EXCEPTION 'loan journal does not match its record, amount, date, reference, policy or approval' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_account FROM abos.operational_treasury_accounts WHERE id = l.operational_treasury_account_id
     AND legal_entity_id = l.legal_entity_id AND status = 'ACTIVE';
  IF NOT FOUND OR v_account.currency_code <> l.original_currency_code THEN
    RAISE EXCEPTION 'a loan is received only into an active Safe or Saraf account in its currency' USING ERRCODE = 'check_violation';
  END IF;
  -- Worked out again from the journals: the posted lines must equal it exactly.
  v_carrying := abos.treasury_carrying_move(v_account, l.base_currency_code, l.business_date, l.original_amount, l.base_amount, abos.fx_conversion_scale(l.fx_conversion_id));
  IF p_intent.base_amount <> GREATEST(v_carrying, l.base_amount)
     OR NOT abos.realized_fx_matches(p_journal.id, l.legal_entity_id, l.base_currency_code, v_carrying, l.base_amount) THEN
    RAISE EXCEPTION 'a loan has one line for its Treasury account, one for its liability and one for any realized difference' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM abos.journal_lines x WHERE x.journal_id = p_journal.id AND x.line_number = 1
       AND x.ledger_account_id = v_account.ledger_account_id AND x.base_debit = v_carrying AND x.business_party_id IS NULL)
     OR NOT EXISTS (SELECT 1 FROM abos.journal_lines x WHERE x.journal_id = p_journal.id AND x.line_number = 2
       AND x.ledger_account_id = l.liability_ledger_account_id AND x.base_credit = l.base_amount AND x.business_party_id = l.lender_business_party_id) THEN
    RAISE EXCEPTION 'a loan must debit its Treasury account and credit its liability for its lender' USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT count(*) FROM abos.subledger_entries e JOIN abos.journal_lines x ON x.id = e.journal_line_id WHERE x.journal_id = p_journal.id) <> 2
     OR NOT EXISTS (SELECT 1 FROM abos.subledger_entries e JOIN abos.journal_lines x ON x.id = e.journal_line_id
       WHERE x.journal_id = p_journal.id AND x.line_number = 1 AND e.subledger_type = 'OPERATIONAL_TREASURY'
         AND e.operational_treasury_account_id = v_account.id AND e.base_amount = v_carrying AND e.original_amount = l.original_amount)
     OR NOT EXISTS (SELECT 1 FROM abos.subledger_entries e JOIN abos.journal_lines x ON x.id = e.journal_line_id
       WHERE x.journal_id = p_journal.id AND x.line_number = 2 AND e.subledger_type = 'LOAN_PAYABLE'
         AND e.business_party_id = l.lender_business_party_id AND e.base_amount = -l.base_amount AND e.original_amount = -l.original_amount) THEN
    RAISE EXCEPTION 'a loan must move its Treasury account and its lender''s position by its exact amounts' USING ERRCODE = 'check_violation';
  END IF;
END
$function$;

DROP FUNCTION abos.loan_repayment_settlement(abos.loans, numeric, numeric, uuid);
-- carrying is what leaves the liability, treasury is what leaves the Safe, difference is the realized result: positive is a loss.
CREATE FUNCTION abos.loan_repayment_settlement(p_loan abos.loans, p_account abos.operational_treasury_accounts, p_day date, p_amount numeric, p_conversion uuid)
RETURNS TABLE (carrying numeric, treasury numeric, difference numeric) LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $settlement$
DECLARE owed record; v_scale integer;
BEGIN
  IF p_loan.original_currency_code = p_loan.base_currency_code THEN
    carrying := p_amount;
  ELSE
    v_scale := abos.fx_conversion_scale(p_conversion);
    IF v_scale IS NULL THEN RAISE EXCEPTION 'a foreign-currency repayment needs its frozen conversion' USING ERRCODE = 'check_violation'; END IF;
    SELECT * INTO owed FROM abos.loan_position(p_loan.id);
    carrying := abos.loan_carrying_share(owed.base_outstanding, owed.outstanding, p_amount, v_scale);
  END IF;
  treasury := abos.treasury_carrying_move(p_account, p_loan.base_currency_code, p_day, -p_amount, carrying, v_scale);
  difference := treasury - carrying;
  RETURN NEXT;
END
$settlement$;

CREATE OR REPLACE FUNCTION abos.loan_repayment_post(p_repayment uuid, p_actor uuid, p_decided boolean)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE r abos.loan_repayments%ROWTYPE; l abos.loans%ROWTYPE; v_account abos.operational_treasury_accounts%ROWTYPE; v_period uuid; v_snapshot text;
  v_journal uuid := gen_random_uuid(); v_intent uuid := gen_random_uuid(); v_carrying numeric; v_treasury numeric; v_difference numeric; v_lines abos.posting_kernel_line[];
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
  SELECT carrying, treasury, difference INTO v_carrying, v_treasury, v_difference FROM abos.loan_repayment_settlement(l, v_account, r.business_date, r.original_amount, r.fx_conversion_id);
  v_lines := ARRAY[
    ROW(1, 'DEBIT', l.liability_ledger_account_id, l.lender_business_party_id, NULL, NULL, NULL, 'LOAN_PAYABLE', 1, NULL, l.lender_business_party_id)::abos.posting_kernel_line,
    ROW(2, 'CREDIT', v_account.ledger_account_id, NULL, NULL, NULL, NULL, 'OPERATIONAL_TREASURY', -1, v_account.id, NULL)::abos.posting_kernel_line];
  IF v_difference <> 0 THEN
    v_lines := v_lines || ROW(3, CASE WHEN v_difference > 0 THEN 'DEBIT' ELSE 'CREDIT' END, abos.loan_fx_account(r.legal_entity_id, v_difference, r.base_currency_code),
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)::abos.posting_kernel_line;
  END IF;
  PERFORM abos.posting_kernel_draft(
    p_intent_id => v_intent, p_journal_id => v_journal, p_legal_entity_id => r.legal_entity_id, p_source_type => 'LOAN_REPAYMENT', p_source_id => r.id,
    p_original_amount => r.original_amount, p_original_currency_code => r.original_currency_code, p_base_amount => GREATEST(v_treasury, v_carrying), p_base_currency_code => r.base_currency_code,
    p_accounting_effective_date => r.business_date, p_accounting_period_id => v_period, p_journal_reference => r.transaction_reference, p_correlation_id => r.correlation_id,
    p_idempotency_key => 'LR:' || r.id::text, p_initial_status => CASE WHEN p_decided THEN 'APPROVED' ELSE 'VALIDATED' END, p_created_by_user_account_id => r.created_by_user_account_id,
    p_lines => v_lines, p_conversion_snapshot_reference => v_snapshot, p_finance_workflow_policy_version_id => r.workflow_policy_version_id,
    p_line_base_amounts => abos.realized_fx_amounts(v_carrying, v_treasury));
  UPDATE abos.loan_repayments SET status = 'POSTED', journal_id = v_journal, decided_by_user_account_id = CASE WHEN p_decided THEN p_actor END,
         decided_at = CASE WHEN p_decided THEN clock_timestamp() END WHERE id = r.id;
  PERFORM abos.posting_kernel_commit(v_intent, v_journal, p_actor);
  RETURN v_journal;
END
$function$;

CREATE OR REPLACE FUNCTION abos.validate_loan_repayment_journal(p_journal abos.journals, p_intent abos.posting_intents)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE r abos.loan_repayments%ROWTYPE; l abos.loans%ROWTYPE; v_account abos.operational_treasury_accounts%ROWTYPE; v_cash_intent abos.posting_intents%ROWTYPE;
  v_carrying numeric; v_treasury numeric; v_difference numeric; v_fx uuid;
BEGIN
  SELECT * INTO r FROM abos.loan_repayments WHERE id = p_intent.source_id AND legal_entity_id = p_journal.legal_entity_id;
  -- The intent carries the journal's total, which is the larger of the two carrying values. The conversion proves the day's value.
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
  SELECT carrying, treasury, difference INTO v_carrying, v_treasury, v_difference FROM abos.loan_repayment_settlement(l, v_account, r.business_date, r.original_amount, r.fx_conversion_id);
  IF p_intent.base_amount <> GREATEST(v_treasury, v_carrying)
     OR (SELECT count(*) FROM abos.journal_lines x WHERE x.journal_id = p_journal.id) <> (CASE WHEN v_difference = 0 THEN 2 ELSE 3 END) THEN
    RAISE EXCEPTION 'a repayment has one line for each of its liability, its Treasury account and any realized difference' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM abos.journal_lines x WHERE x.journal_id = p_journal.id AND x.line_number = 1
       AND x.ledger_account_id = l.liability_ledger_account_id AND x.base_debit = v_carrying AND x.business_party_id = l.lender_business_party_id)
     OR NOT EXISTS (SELECT 1 FROM abos.journal_lines x WHERE x.journal_id = p_journal.id AND x.line_number = 2
       AND x.ledger_account_id = v_account.ledger_account_id AND x.base_credit = v_treasury AND x.business_party_id IS NULL) THEN
    RAISE EXCEPTION 'a repayment must debit its loan liability and credit its Treasury account, each by the carrying value it gives up' USING ERRCODE = 'check_violation';
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
         AND e.operational_treasury_account_id = v_account.id AND e.base_amount = -v_treasury AND e.original_amount = -r.original_amount) THEN
    RAISE EXCEPTION 'a repayment must move its lender''s position and its Treasury account by its exact amounts' USING ERRCODE = 'check_violation';
  END IF;
END
$function$;

CREATE OR REPLACE FUNCTION abos.finance_loan_repay(p_proof text, p_runtime text, p_token text, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE c jsonb; actor uuid; entity uuid; req jsonb; amount numeric; day date; key text; correlation uuid; l abos.loans%ROWTYPE; v_account abos.operational_treasury_accounts%ROWTYPE;
  policy uuid; approval boolean; scope text; fingerprint text; replay jsonb; ref text; result jsonb; v_base_amount numeric; v_conversion abos.fx_conversions%ROWTYPE; v_owed numeric; v_pending numeric;
  repayment uuid := gen_random_uuid(); journal uuid; v_carrying numeric; v_treasury numeric; v_difference numeric;
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
  SELECT carrying, treasury, difference INTO v_carrying, v_treasury, v_difference FROM abos.loan_repayment_settlement(l, v_account, day, amount, v_conversion.id);
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
  IF NOT approval THEN result := result || jsonb_build_object('carryingAmount', v_carrying::text, 'treasuryCarryingAmount', v_treasury::text, 'realizedFx', (-v_difference)::text); END IF;
  PERFORM abos.money_audit(actor, entity, correlation, 'LOAN_REPAYMENT_RECORDED', 'LOAN_REPAYMENT', repayment, result || jsonb_build_object('treasuryAccountId', v_account.id, 'businessDate', day));
  PERFORM abos.temporary_funding_idempotency_complete(scope, key, 'LOAN_REPAYMENT', repayment, result);
  RETURN result;
END
$function$;

CREATE OR REPLACE FUNCTION abos.finance_loan_statement(p_proof text, p_runtime text, p_token text, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
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
      'amount', abs(x.amount)::text, 'baseAmount', abs(x.base)::text, 'treasuryBaseAmount', x.cash::text, 'transactionBaseAmount', x.day_value::text, 'realizedFx', x.fx::text, 'effect', (-x.amount)::text, 'balance', (opening.outstanding - x.running)::text,
      'treasury', x.treasury, 'source', abos.report_journal_source(entity, x.journal_id, perms, true)) ORDER BY x.day, x.posted_at, x.journal_id), '[]'::jsonb)
    INTO lines
    FROM (SELECT y.*, sum(y.amount) OVER (ORDER BY y.day, y.posted_at, y.journal_id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running
            FROM (SELECT j.journal_id, j.kind, journal.accounting_effective_date AS day, journal.posted_at, entry.original_amount AS amount, entry.base_amount AS base,
                         (SELECT jsonb_build_object('id', t.id, 'nameEn', t.name_en, 'nameFa', t.name_fa) FROM abos.subledger_entries te JOIN abos.journal_lines tl ON tl.id = te.journal_line_id
                            JOIN abos.operational_treasury_accounts t ON t.id = te.operational_treasury_account_id
                           WHERE tl.journal_id = j.journal_id AND te.subledger_type = 'OPERATIONAL_TREASURY' LIMIT 1) AS treasury,
                         (SELECT abs(te.base_amount) FROM abos.subledger_entries te JOIN abos.journal_lines tl ON tl.id = te.journal_line_id
                           WHERE tl.journal_id = j.journal_id AND te.subledger_type = 'OPERATIONAL_TREASURY' LIMIT 1) AS cash,
                         (SELECT r.base_amount FROM abos.loan_repayments r WHERE r.journal_id = j.journal_id) AS day_value,
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
$function$;

-- ---------------------------------------------------------------------------------------------
-- 9. Reversals stay the exact inverse of the posted lines, and read no rate. All the metadata they need is in those lines, so a reversal
--    proceeds, later movements or not. The one case refused is the one the invariant forbids: money already spent cannot be un-received,
--    because the exact inverse would leave a value with no balance behind it. Reversing the later movement first removes the problem.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION abos.treasury_reversal_safe(p_journal abos.journals, p_day date)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $safe$
  SELECT NOT EXISTS (SELECT 1 FROM abos.subledger_entries entry
      JOIN abos.journal_lines line ON line.id = entry.journal_line_id
      JOIN abos.operational_treasury_accounts account ON account.id = entry.operational_treasury_account_id
     WHERE line.journal_id = p_journal.id AND entry.subledger_type = 'OPERATIONAL_TREASURY' AND account.currency_code <> p_journal.base_currency_code
       AND NOT abos.treasury_position_stays_valid(account.id, p_day, -entry.original_amount, -entry.base_amount))
$safe$;

CREATE OR REPLACE FUNCTION abos.reversal_journal_blocker(p_journal_id uuid, p_entity uuid)
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT CASE
    WHEN j.id IS NULL THEN 'NOT_FOUND'
    WHEN j.status <> 'POSTED' THEN 'NOT_POSTED'
    WHEN pi.intent_kind = 'REVERSAL'
      OR EXISTS (SELECT 1 FROM abos.journal_reversal_links l WHERE l.reversal_journal_id = j.id) THEN 'IS_REVERSAL'
    WHEN EXISTS (SELECT 1 FROM abos.journal_reversal_links l WHERE l.original_journal_id = j.id) THEN 'ALREADY_REVERSED'
    WHEN EXISTS (SELECT 1 FROM abos.journal_reversal_requests r
                  WHERE r.journal_id = j.id AND r.status = 'APPROVED') THEN 'APPROVED_REQUEST'
    WHEN EXISTS (SELECT 1 FROM abos.journal_reversal_requests r
                  WHERE r.journal_id = j.id AND r.status = 'REQUESTED') THEN 'OPEN_REQUEST'
    WHEN NOT abos.treasury_reversal_safe(j, j.accounting_effective_date) THEN 'LATER_TREASURY_MOVEMENT'
  END
    FROM (SELECT p_journal_id AS id) wanted
    LEFT JOIN abos.journals j ON j.id = wanted.id AND j.legal_entity_id = p_entity
    LEFT JOIN abos.posting_intents pi ON pi.id = j.posting_intent_id
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
  -- 0064: the loan first, as every repayment takes it, and then the accounts in a stable order. Nothing can slip in behind this check.
  PERFORM 1 FROM abos.loans WHERE id = COALESCE(oi.loan_id, (SELECT r.loan_id FROM abos.loan_repayments r WHERE r.id = oi.loan_repayment_id)) FOR UPDATE;
  PERFORM 1 FROM abos.operational_treasury_accounts account
    WHERE account.currency_code <> o.base_currency_code AND account.id IN (SELECT entry.operational_treasury_account_id FROM abos.subledger_entries entry
      JOIN abos.journal_lines line ON line.id = entry.journal_line_id WHERE line.journal_id = p_journal AND entry.subledger_type = 'OPERATIONAL_TREASURY')
    ORDER BY account.id FOR NO KEY UPDATE;
  IF NOT abos.treasury_reversal_safe(o, day) THEN
    RAISE EXCEPTION 'TREASURY_LATER_MOVEMENT: a later movement used this money, so reversing it would leave a value with no balance; reverse that movement first' USING ERRCODE = 'check_violation';
  END IF;
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
-- 10. Reports. The Safe statement stays native first, and now shows carrying value and the day's value as the two things they are.
--     The Financial Summary reports realized FX on its own line, so it reads as neither income received nor an operating cost.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION abos.treasury_account_statement(p_proof text, p_runtime text, p_token text, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE c jsonb; entity uuid; actor uuid; perms jsonb; source_perms jsonb; read_all boolean; can_ledger boolean; base text; accounts jsonb;
  account_id uuid; account record; ledger record; range jsonb; v_from date; v_to date; opening numeric; base_opening numeric;
  closing numeric; base_closing numeric; ledger_balance numeric; line_count bigint; lines jsonb; totals jsonb;
BEGIN
  c := abos.treasury_safe_actor(p_proof, p_runtime, p_token, NULL);
  entity := (c->>'legalEntityId')::uuid; actor := (c->>'userAccountId')::uuid; perms := COALESCE(c->'permissions', '[]'::jsonb);
  read_all := perms ?| ARRAY['treasury.safe.read', 'finance.report.operational.read'];
  can_ledger := perms ? 'finance.report.operational.read';
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_payload) k
       WHERE k NOT IN ('accountId', 'periodId', 'from', 'to', 'asOf')) THEN
    RAISE EXCEPTION 'unknown report fields' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT base_currency_code INTO base FROM abos.legal_entities WHERE id = entity;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', a.id, 'nameEn', a.name_en, 'nameFa', a.name_fa, 'accountType', a.account_type,
      'currencyCode', a.currency_code, 'status', a.status)
      ORDER BY CASE a.status WHEN 'ACTIVE' THEN 0 WHEN 'INACTIVE' THEN 1 ELSE 2 END, a.name_en, a.id), '[]'::jsonb)
    INTO accounts FROM abos.operational_treasury_accounts a
   WHERE a.legal_entity_id = entity AND (read_all OR EXISTS (SELECT 1 FROM abos.operational_treasury_account_responsibles r
       WHERE r.operational_treasury_account_id = a.id AND r.user_account_id = actor AND r.revoked_at IS NULL));
  IF NOT read_all AND jsonb_array_length(accounts) = 0 THEN
    RAISE EXCEPTION 'current authority is missing treasury.safe.read' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NULLIF(p_payload->>'accountId', '') IS NULL THEN
    RETURN jsonb_build_object('legalEntityId', entity, 'baseCurrency', base, 'accounts', accounts, 'statement', NULL);
  END IF;
  BEGIN
    account_id := (p_payload->>'accountId')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'choose a valid account' USING ERRCODE = 'invalid_parameter_value';
  END;
  -- An account the reader may not open is reported exactly like one that does not exist.
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(accounts) a WHERE a->>'id' = account_id::text) THEN
    RAISE EXCEPTION 'the Treasury account was not found in this legal entity' USING ERRCODE = 'no_data_found';
  END IF;
  SELECT id, name_en, name_fa, account_type, currency_code, status, ledger_account_id INTO account
    FROM abos.operational_treasury_accounts WHERE id = account_id AND legal_entity_id = entity;
  SELECT id, account_code, account_name INTO ledger FROM abos.ledger_accounts WHERE id = account.ledger_account_id AND legal_entity_id = entity;
  -- A person responsible for this Safe reads its Treasury sources, as a Safe reader does.
  source_perms := CASE WHEN perms ? 'treasury.safe.read' OR can_ledger THEN perms ELSE perms || '["treasury.safe.read"]'::jsonb END;
  range := abos.report_range(entity, p_payload - 'accountId');
  v_from := (range->>'from')::date; v_to := (range->>'to')::date;
  -- The opening and closing are the one Treasury balance, not a new sum.
  SELECT book_balance INTO opening FROM abos.treasury_account_balances(entity, v_from - 1, account.id);
  SELECT book_balance INTO closing FROM abos.treasury_account_balances(entity, v_to, account.id);
  base_opening := abos.treasury_account_base_balance(entity, v_from - 1, account.id);
  base_closing := abos.treasury_account_base_balance(entity, v_to, account.id);
  SELECT count(*) INTO line_count FROM abos.subledger_entries entry
    JOIN abos.journal_lines line ON line.id = entry.journal_line_id
    JOIN abos.journals journal ON journal.id = line.journal_id AND journal.status = 'POSTED'
   WHERE entry.subledger_type = 'OPERATIONAL_TREASURY' AND entry.legal_entity_id = entity AND entry.operational_treasury_account_id = account.id
     AND journal.accounting_effective_date BETWEEN v_from AND v_to;
  IF line_count > 5000 THEN
    RAISE EXCEPTION 'this statement has % lines; choose a shorter period', line_count USING ERRCODE = 'program_limit_exceeded';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', x.entry_id, 'date', x.effective_date, 'postedAt', x.posted_at,
      'moneyIn', greatest(x.amount, 0)::text, 'moneyOut', greatest(-x.amount, 0)::text, 'balance', (opening + x.running)::text,
      'currency', x.currency, 'baseAmount', x.base_amount::text, 'runningBase', (base_opening + x.base_running)::text, 'restricted', NOT x.visible, 'kind', x.kind, 'isReversal', x.is_reversal,
      'fx', CASE WHEN x.visible AND x.currency <> base THEN (SELECT jsonb_build_object('rate', s.rate_value::text, 'unitCurrency', s.unit_currency_code,
          'quoteCurrency', s.quote_currency_code, 'rateDate', s.rate_date, 'source', s.rate_source, 'policyVersionId', conversion.fx_policy_version_id,
          'roundingMode', conversion.rounding_mode, 'baseScale', conversion.base_scale,
          'transactionBaseAmount', conversion.base_amount::text, 'exactBaseAmount', conversion.exact_base_amount::text, 'roundingDifference', conversion.rounding_difference::text)
        FROM abos.exchange_rate_snapshots s LEFT JOIN abos.fx_conversions conversion ON conversion.exchange_rate_snapshot_id = s.id
        WHERE s.id::text = x.conversion_snapshot_reference AND s.legal_entity_id = entity) END,
      'journalId', CASE WHEN x.visible AND can_ledger THEN x.journal_id END,
      'journalReference', CASE WHEN x.visible THEN abos.report_journal_reference(x.journal_id, source_perms) END,
      'source', abos.report_journal_source(entity, x.journal_id, source_perms, x.visible),
      'transferPeer', CASE WHEN x.visible AND read_all AND x.source_type = 'TREASURY_TRANSFER' AND abos.report_source_readable('TREASURY_TRANSFER', source_perms) THEN (
          SELECT jsonb_build_object('en', peer.name_en, 'fa', COALESCE(peer.name_fa, peer.name_en)) FROM abos.treasury_transfers transfer
            JOIN abos.operational_treasury_accounts peer ON peer.id = CASE WHEN transfer.source_treasury_account_id = account.id
              THEN transfer.destination_treasury_account_id ELSE transfer.source_treasury_account_id END
           WHERE transfer.journal_id = x.journal_id) END,
      'reversedBy', CASE WHEN x.visible THEN (SELECT jsonb_build_object('journalId', CASE WHEN can_ledger THEN l.reversal_journal_id END,
          'reference', abos.report_journal_reference(l.reversal_journal_id, source_perms), 'date', r.accounting_effective_date)
        FROM abos.journal_reversal_links l JOIN abos.journals r ON r.id = l.reversal_journal_id WHERE l.original_journal_id = x.journal_id) END,
      'reverses', CASE WHEN x.visible THEN (SELECT jsonb_build_object('journalId', CASE WHEN can_ledger THEN l.original_journal_id END,
          'reference', abos.report_journal_reference(l.original_journal_id, source_perms), 'date', o.accounting_effective_date)
        FROM abos.journal_reversal_links l JOIN abos.journals o ON o.id = l.original_journal_id WHERE l.reversal_journal_id = x.journal_id) END)
      ORDER BY x.effective_date, x.posted_at, x.journal_id, x.line_number), '[]'::jsonb),
    jsonb_build_object(
      'moneyIn', COALESCE(sum(greatest(x.amount, 0)), 0)::text, 'moneyOut', COALESCE(sum(greatest(-x.amount, 0)), 0)::text,
      'transfersIn', COALESCE(sum(greatest(x.amount, 0)) FILTER (WHERE x.kind = 'TRANSFER'), 0)::text,
      'transfersOut', COALESCE(sum(greatest(-x.amount, 0)) FILTER (WHERE x.kind = 'TRANSFER'), 0)::text,
      'reversalsIn', COALESCE(sum(greatest(x.amount, 0)) FILTER (WHERE x.is_reversal), 0)::text,
      'reversalsOut', COALESCE(sum(greatest(-x.amount, 0)) FILTER (WHERE x.is_reversal), 0)::text,
      'movementCount', count(*))
    INTO lines, totals
    FROM (SELECT entry.id AS entry_id, journal.id AS journal_id, line.line_number, journal.accounting_effective_date AS effective_date, journal.posted_at,
                 entry.original_amount AS amount, entry.original_currency_code AS currency, entry.base_amount, line.conversion_snapshot_reference,
                 intent.source_type, intent.source_type = 'REVERSAL' AS is_reversal,
                 CASE abos.report_effective_source_type(journal.id) WHEN 'TREASURY_TRANSFER' THEN 'TRANSFER' WHEN 'OPENING_BALANCE' THEN 'OPENING' ELSE 'EXTERNAL' END AS kind,
                 abos.report_line_visible(entity, actor, line.project_id, line.department_id, line.cost_center_id) AS visible,
                 sum(entry.original_amount) OVER (ORDER BY journal.accounting_effective_date, journal.posted_at, journal.id, line.line_number
                   ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running,
                 sum(entry.base_amount) OVER (ORDER BY journal.accounting_effective_date, journal.posted_at, journal.id, line.line_number
                   ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS base_running
            FROM abos.subledger_entries entry
            JOIN abos.journal_lines line ON line.id = entry.journal_line_id
            JOIN abos.journals journal ON journal.id = line.journal_id AND journal.status = 'POSTED'
            JOIN abos.posting_intents intent ON intent.id = journal.posting_intent_id
           WHERE entry.subledger_type = 'OPERATIONAL_TREASURY' AND entry.legal_entity_id = entity AND entry.operational_treasury_account_id = account.id
             AND journal.accounting_effective_date BETWEEN v_from AND v_to) x;
  SELECT COALESCE(sum(b.opening_debit - b.opening_credit + b.period_debit - b.period_credit), 0) INTO ledger_balance
    FROM abos.report_account_balances(entity, v_from, v_to) b WHERE b.ledger_account_id = account.ledger_account_id;
  RETURN jsonb_build_object('legalEntityId', entity, 'baseCurrency', base, 'accounts', accounts, 'statement', jsonb_build_object(
    'range', range, 'canOpenLedger', can_ledger,
    'account', jsonb_build_object('id', account.id, 'nameEn', account.name_en, 'nameFa', account.name_fa, 'accountType', account.account_type,
      'currencyCode', account.currency_code, 'status', account.status,
      'ledgerAccount', CASE WHEN can_ledger THEN jsonb_build_object('id', ledger.id, 'code', ledger.account_code, 'name', ledger.account_name) END),
    'opening', jsonb_build_object('native', opening::text, 'base', base_opening::text),
    'closing', jsonb_build_object('native', closing::text, 'base', base_closing::text),
    -- Only a history posted before 0064 can be anything but OK. It stays visible until someone corrects it.
    'carryingStatus', CASE WHEN account.currency_code = base OR sign(closing) = sign(base_closing) THEN 'OK' WHEN closing = 0 THEN 'ORPHAN' ELSE 'INVERTED' END,
    'totals', totals, 'lines', lines,
    'reconciliation', jsonb_build_object('treasuryBase', base_closing::text, 'ledgerBase', ledger_balance::text,
      'difference', (base_closing - ledger_balance)::text, 'matches', base_closing = ledger_balance)));
END
$function$;

CREATE OR REPLACE FUNCTION abos.finance_management_summary(p_proof text, p_runtime text, p_token text, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE c jsonb; entity uuid; base text; range jsonb; v_from date; v_to date; figures jsonb; accounts jsonb; result record;
  ledger_closing numeric; treasury_closing numeric; flows_closing numeric; fx_gain numeric; fx_loss numeric;
BEGIN
  c := abos.operational_finance_actor(p_proof, p_runtime, p_token, 'finance.report.operational.read');
  entity := (c->>'legalEntityId')::uuid;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_payload) k
       WHERE k NOT IN ('periodId', 'from', 'to', 'asOf', 'fiscalYearId')) THEN
    RAISE EXCEPTION 'unknown report fields' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT base_currency_code INTO base FROM abos.legal_entities WHERE id = entity;
  range := abos.report_range(entity, p_payload);
  v_from := (range->>'from')::date; v_to := (range->>'to')::date;
  -- Each Treasury account's position from the one Treasury balance.
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', a.id, 'nameEn', a.name_en, 'nameFa', a.name_fa, 'accountType', a.account_type, 'currency', a.currency_code,
      'status', a.status, 'opening', o.book_balance::text, 'closing', e.book_balance::text,
      'baseOpening', abos.treasury_account_base_balance(entity, v_from - 1, a.id)::text, 'baseClosing', abos.treasury_account_base_balance(entity, v_to, a.id)::text)
      ORDER BY a.name_en, a.id), '[]'::jsonb)
    INTO accounts FROM abos.operational_treasury_accounts a
    JOIN abos.treasury_account_balances(entity, v_from - 1, NULL) o ON o.operational_treasury_account_id = a.id
    JOIN abos.treasury_account_balances(entity, v_to, NULL) e ON e.operational_treasury_account_id = a.id
   WHERE a.legal_entity_id = entity;
  -- The same figures in each currency, and once in the accounting currency. A net is the original movements with their reversals.
  WITH flows AS (SELECT * FROM abos.report_treasury_flows(entity, v_from, v_to)),
  measured AS (
    SELECT f.currency_code AS scope, f.source_type, f.gross_in, f.gross_out, f.reversal_in, f.reversal_out, f.movement_count, f.reversal_count FROM flows f
    UNION ALL
    SELECT 'BASE', f.source_type, f.base_gross_in, f.base_gross_out, f.base_reversal_in, f.base_reversal_out, f.movement_count, f.reversal_count FROM flows f),
  positions AS (
    SELECT (a->>'currency') AS scope, sum((a->>'opening')::numeric) AS opening, sum((a->>'closing')::numeric) AS closing FROM jsonb_array_elements(accounts) a GROUP BY 1
    UNION ALL
    SELECT 'BASE', COALESCE(sum((a->>'baseOpening')::numeric), 0), COALESCE(sum((a->>'baseClosing')::numeric), 0) FROM jsonb_array_elements(accounts) a),
  nets AS (
    SELECT m.scope,
      COALESCE(sum(m.gross_in - m.gross_out + m.reversal_in - m.reversal_out) FILTER (WHERE m.source_type = 'DIRECT_SHAREHOLDER_CAPITAL'), 0) AS capital,
      COALESCE(sum(m.gross_in - m.gross_out + m.reversal_in - m.reversal_out) FILTER (WHERE m.source_type IN ('TEMPORARY_FUNDING', 'LOAN_RECEIPT')), 0) AS loans,
      COALESCE(sum(m.gross_in - m.gross_out + m.reversal_in - m.reversal_out) FILTER (WHERE m.source_type = 'CASH_RECEIPT'), 0) AS receipts,
      COALESCE(sum(m.gross_out - m.gross_in + m.reversal_out - m.reversal_in) FILTER (WHERE m.source_type = 'OPERATIONAL_EXPENSE'), 0) AS expenses,
      COALESCE(sum(m.gross_out - m.gross_in + m.reversal_out - m.reversal_in) FILTER (WHERE m.source_type = 'PAYMENT'), 0) AS payments,
      COALESCE(sum(m.gross_out - m.gross_in + m.reversal_out - m.reversal_in) FILTER (WHERE m.source_type IN ('TEMPORARY_FUNDING_SETTLEMENT', 'LOAN_REPAYMENT')), 0) AS repayments,
      COALESCE(sum(m.gross_in - m.gross_out + m.reversal_in - m.reversal_out) FILTER (WHERE m.source_type = 'OPENING_BALANCE'), 0) AS opening_balances,
      COALESCE(sum(m.gross_in - m.reversal_out) FILTER (WHERE m.source_type = 'TREASURY_TRANSFER'), 0) AS transfers_in,
      COALESCE(sum(m.gross_out - m.reversal_in) FILTER (WHERE m.source_type = 'TREASURY_TRANSFER'), 0) AS transfers_out,
      COALESCE(sum(m.gross_in - m.gross_out + m.reversal_in - m.reversal_out) FILTER (WHERE m.source_type NOT IN ('DIRECT_SHAREHOLDER_CAPITAL', 'TEMPORARY_FUNDING', 'LOAN_RECEIPT', 'LOAN_REPAYMENT', 'CASH_RECEIPT',
        'OPERATIONAL_EXPENSE', 'PAYMENT', 'TEMPORARY_FUNDING_SETTLEMENT', 'OPENING_BALANCE', 'TREASURY_TRANSFER')), 0) AS unclassified,
      COALESCE(sum(m.reversal_in), 0) AS reversals_in, COALESCE(sum(m.reversal_out), 0) AS reversals_out, COALESCE(sum(m.reversal_count), 0) AS reversal_count
      FROM measured m GROUP BY m.scope)
  SELECT COALESCE(jsonb_object_agg(p.scope, jsonb_build_object(
      'opening', p.opening::text, 'closing', p.closing::text,
      'capitalReceived', COALESCE(n.capital, 0)::text, 'loansReceived', COALESCE(n.loans, 0)::text, 'otherReceipts', COALESCE(n.receipts, 0)::text,
      'moneyReceived', (COALESCE(n.capital, 0) + COALESCE(n.loans, 0) + COALESCE(n.receipts, 0))::text,
      'expensesPaid', COALESCE(n.expenses, 0)::text, 'paymentsMade', COALESCE(n.payments, 0)::text, 'loanRepayments', COALESCE(n.repayments, 0)::text,
      'moneyPaid', (COALESCE(n.expenses, 0) + COALESCE(n.payments, 0) + COALESCE(n.repayments, 0))::text,
      'openingBalancesRecorded', COALESCE(n.opening_balances, 0)::text,
      'transfersIn', COALESCE(n.transfers_in, 0)::text, 'transfersOut', COALESCE(n.transfers_out, 0)::text,
      'unclassified', COALESCE(n.unclassified, 0)::text,
      'reversalsIn', COALESCE(n.reversals_in, 0)::text, 'reversalsOut', COALESCE(n.reversals_out, 0)::text, 'reversalCount', COALESCE(n.reversal_count, 0),
      'flowsClosing', (p.opening + COALESCE(n.capital, 0) + COALESCE(n.loans, 0) + COALESCE(n.receipts, 0) - COALESCE(n.expenses, 0) - COALESCE(n.payments, 0) - COALESCE(n.repayments, 0)
        + COALESCE(n.opening_balances, 0) + COALESCE(n.transfers_in, 0) - COALESCE(n.transfers_out, 0) + COALESCE(n.unclassified, 0))::text)), '{}'::jsonb)
    INTO figures FROM positions p LEFT JOIN nets n ON n.scope = p.scope;
  SELECT * INTO result FROM abos.report_income_result(entity, v_from, v_to);
  SELECT COALESCE(sum(b.period_credit - b.period_debit) FILTER (WHERE a.control_account_type = 'REALIZED_FX_GAIN'), 0),
         COALESCE(sum(b.period_debit - b.period_credit) FILTER (WHERE a.control_account_type = 'REALIZED_FX_LOSS'), 0)
    INTO fx_gain, fx_loss
    FROM abos.report_account_balances(entity, v_from, v_to) b JOIN abos.ledger_accounts a ON a.id = b.ledger_account_id;
  SELECT COALESCE(sum(b.opening_debit - b.opening_credit + b.period_debit - b.period_credit), 0) INTO ledger_closing
    FROM abos.report_account_balances(entity, v_from, v_to) b
   WHERE b.ledger_account_id IN (SELECT a.ledger_account_id FROM abos.operational_treasury_accounts a WHERE a.legal_entity_id = entity);
  treasury_closing := COALESCE((figures->'BASE'->>'closing')::numeric, 0);
  flows_closing := COALESCE((figures->'BASE'->>'flowsClosing')::numeric, 0);
  RETURN jsonb_build_object('legalEntityId', entity, 'baseCurrency', base, 'range', range, 'accounts', accounts,
    'base', figures->'BASE', 'currencies', (SELECT COALESCE(jsonb_object_agg(k, v), '{}'::jsonb) FROM jsonb_each(figures) e(k, v) WHERE k <> 'BASE'),
    'profit', jsonb_build_object('income', (result.income - fx_gain)::text, 'expenses', (result.expense - fx_loss)::text,
      'realizedFxGain', fx_gain::text, 'realizedFxLoss', fx_loss::text, 'netResult', result.net_result::text),
    'reconciliation', jsonb_build_object('treasuryClosing', treasury_closing::text, 'flowsClosing', flows_closing::text, 'ledgerClosing', ledger_closing::text,
      'matches', treasury_closing = flows_closing AND treasury_closing = ledger_closing));
END
$function$;

-- ---------------------------------------------------------------------------------------------
-- 11. Privileges. Every new function is internal, and the runtime reaches none of them directly.
-- ---------------------------------------------------------------------------------------------
REVOKE ALL ON FUNCTION abos.treasury_carrying_position(uuid, date), abos.treasury_position_stays_valid(uuid, date, numeric, numeric),
  abos.treasury_carrying_move(abos.operational_treasury_accounts, text, date, numeric, numeric, integer),
  abos.realized_fx_append(abos.posting_kernel_line[], uuid, text, numeric, numeric, uuid, uuid, uuid), abos.realized_fx_amounts(numeric, numeric),
  abos.realized_fx_matches(uuid, uuid, text, numeric, numeric, uuid, uuid, uuid), abos.fx_conversion_scale(uuid),
  abos.loan_repayment_settlement(abos.loans, abos.operational_treasury_accounts, date, numeric, uuid), abos.treasury_reversal_safe(abos.journals, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION abos.treasury_carrying_position(uuid, date), abos.treasury_position_stays_valid(uuid, date, numeric, numeric),
  abos.treasury_carrying_move(abos.operational_treasury_accounts, text, date, numeric, numeric, integer),
  abos.realized_fx_append(abos.posting_kernel_line[], uuid, text, numeric, numeric, uuid, uuid, uuid), abos.realized_fx_amounts(numeric, numeric),
  abos.realized_fx_matches(uuid, uuid, text, numeric, numeric, uuid, uuid, uuid), abos.fx_conversion_scale(uuid),
  abos.loan_repayment_settlement(abos.loans, abos.operational_treasury_accounts, date, numeric, uuid), abos.treasury_reversal_safe(abos.journals, date)
  TO abos_v1_operational_finance_owner;
-- reversal_journal_blocker also runs inside the reversal request screens, which belong to the older Finance owner. That role has no access
-- to the Treasury tables and gets none: this one yes-or-no answer is a definer of the operational owner, which it may execute and the runtime may not.
ALTER FUNCTION abos.treasury_reversal_safe(abos.journals, date) OWNER TO abos_v1_operational_finance_owner;
REVOKE ALL ON FUNCTION abos.treasury_reversal_safe(abos.journals, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION abos.treasury_reversal_safe(abos.journals, date) TO abos_v1_operational_finance_owner, abos_e1_finance_owner;
