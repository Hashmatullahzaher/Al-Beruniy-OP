-- 0053: Slice 7 part 1 — shared reporting primitives, the trial balance, the account statement and the journal detail;
-- the General Ledger masks restricted lines instead of excluding them.
--
-- Governing principle (owner instruction of 2026-10-31): every report derives from posted journals and their lines.
-- Source confidentiality may hide detail (reference, source, counterparty); it never changes an account's balance.
--
-- 1. Primitives (caller's rights; executable only by the operational Finance owner):
--    report_line_visible (the one scope test), report_account_balances (opening / period debit and credit per account,
--    no actor), report_native_balances (the same per original currency), report_range (period, date range or as-of)
--    and report_journal_source (a journal's business source, its detail gated by the source module's permission).
-- 2. Entry points (runtime-executable SECURITY DEFINER, finance.report.operational.read): finance_trial_balance,
--    finance_account_statement, finance_journal_detail.
-- 3. The General Ledger (0024) keeps every posted line in its totals and pages; a line outside the reader's project,
--    department or cost-centre scope keeps its date, account and amounts but hides its reference and source.
-- Read functions only: no table, no row, no backfill, no journal.

-- ---------------------------------------------------------------------------------------------
-- 1. Primitives.
-- ---------------------------------------------------------------------------------------------
-- A line is visible in detail when each of its dimensions is within the reader's live scope (0024 semantics).
CREATE FUNCTION abos.report_line_visible(p_entity uuid, p_actor uuid, p_project uuid, p_department uuid, p_cost_center uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $visible$
  SELECT (p_project IS NULL OR EXISTS (SELECT 1 FROM abos.user_scope_grants g WHERE g.user_account_id = p_actor AND g.legal_entity_id = p_entity
            AND g.scope_kind = 'PROJECT' AND g.scope_id = p_project AND g.revoked_at IS NULL))
     AND (p_department IS NULL OR EXISTS (SELECT 1 FROM abos.user_scope_grants g WHERE g.user_account_id = p_actor AND g.legal_entity_id = p_entity
            AND g.scope_kind = 'DEPARTMENT' AND g.scope_id = p_department AND g.revoked_at IS NULL))
     AND (p_cost_center IS NULL OR EXISTS (SELECT 1 FROM abos.user_scope_grants g WHERE g.user_account_id = p_actor AND g.legal_entity_id = p_entity
            AND g.scope_kind = 'COST_CENTER' AND g.scope_id = p_cost_center AND g.revoked_at IS NULL))
$visible$;

-- Per ledger account, from POSTED journals only, in the accounting currency: gross debit and credit before p_from
-- (the opening) and from p_from to p_to (the period). No reader, no scope, no source filter: this is the arithmetic.
CREATE FUNCTION abos.report_account_balances(p_entity uuid, p_from date, p_to date)
RETURNS TABLE(ledger_account_id uuid, opening_debit numeric, opening_credit numeric, period_debit numeric, period_credit numeric)
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $balances$
  SELECT line.ledger_account_id,
         COALESCE(sum(line.base_debit) FILTER (WHERE journal.accounting_effective_date < p_from), 0),
         COALESCE(sum(line.base_credit) FILTER (WHERE journal.accounting_effective_date < p_from), 0),
         COALESCE(sum(line.base_debit) FILTER (WHERE journal.accounting_effective_date >= p_from), 0),
         COALESCE(sum(line.base_credit) FILTER (WHERE journal.accounting_effective_date >= p_from), 0)
    FROM abos.journal_lines line
    JOIN abos.journals journal ON journal.id = line.journal_id AND journal.legal_entity_id = line.legal_entity_id
   WHERE line.legal_entity_id = p_entity AND journal.status = 'POSTED' AND journal.accounting_effective_date <= p_to
   GROUP BY line.ledger_account_id
$balances$;

-- The same lines per original currency other than the accounting currency (information only, never in base totals):
-- a debit line counts its native amount positive, a credit line negative.
CREATE FUNCTION abos.report_native_balances(p_entity uuid, p_from date, p_to date)
RETURNS TABLE(ledger_account_id uuid, currency_code text, opening_net numeric, period_debit numeric, period_credit numeric)
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $native$
  SELECT line.ledger_account_id, line.original_currency_code,
         COALESCE(sum(CASE WHEN line.base_debit > 0 THEN line.original_amount ELSE -line.original_amount END)
           FILTER (WHERE journal.accounting_effective_date < p_from), 0),
         COALESCE(sum(line.original_amount) FILTER (WHERE journal.accounting_effective_date >= p_from AND line.base_debit > 0), 0),
         COALESCE(sum(line.original_amount) FILTER (WHERE journal.accounting_effective_date >= p_from AND line.base_credit > 0), 0)
    FROM abos.journal_lines line
    JOIN abos.journals journal ON journal.id = line.journal_id AND journal.legal_entity_id = line.legal_entity_id
   WHERE line.legal_entity_id = p_entity AND journal.status = 'POSTED' AND journal.accounting_effective_date <= p_to
     AND line.original_currency_code IS NOT NULL AND line.original_currency_code <> line.base_currency_code
   GROUP BY line.ledger_account_id, line.original_currency_code
$native$;

-- The report range: exactly one of {periodId}, {from, to} or {asOf}. As-of reports the year to date: from the start of
-- the financial year containing the date (or of its calendar year when no financial year covers it). Period status is
-- returned for display, never used in arithmetic.
CREATE FUNCTION abos.report_range(p_entity uuid, p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $range$
DECLARE v_from date; v_to date; v_mode text; v_modes integer; v_period jsonb; v_year jsonb;
BEGIN
  v_modes := (CASE WHEN NULLIF(p_payload->>'periodId', '') IS NOT NULL THEN 1 ELSE 0 END)
           + (CASE WHEN NULLIF(p_payload->>'from', '') IS NOT NULL OR NULLIF(p_payload->>'to', '') IS NOT NULL THEN 1 ELSE 0 END)
           + (CASE WHEN NULLIF(p_payload->>'asOf', '') IS NOT NULL THEN 1 ELSE 0 END);
  IF v_modes <> 1 THEN
    RAISE EXCEPTION 'choose one: a period, a date range or an as-of date' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  BEGIN
    IF NULLIF(p_payload->>'periodId', '') IS NOT NULL THEN
      v_mode := 'PERIOD';
      SELECT jsonb_build_object('id', id, 'name', period_name, 'nameFa', period_name_fa), starts_on, ends_on
        INTO v_period, v_from, v_to FROM abos.accounting_periods WHERE id = (p_payload->>'periodId')::uuid AND legal_entity_id = p_entity;
      IF v_period IS NULL THEN RAISE EXCEPTION 'the accounting period was not found in this legal entity' USING ERRCODE = 'no_data_found'; END IF;
    ELSIF NULLIF(p_payload->>'asOf', '') IS NOT NULL THEN
      v_mode := 'AS_OF';
      v_to := (p_payload->>'asOf')::date;
      SELECT starts_on INTO v_from FROM abos.fiscal_years WHERE legal_entity_id = p_entity AND v_to BETWEEN starts_on AND ends_on;
      v_from := COALESCE(v_from, date_trunc('year', v_to)::date);
    ELSE
      v_mode := 'RANGE';
      v_from := (p_payload->>'from')::date; v_to := (p_payload->>'to')::date;
    END IF;
  EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow OR invalid_datetime_format THEN
    RAISE EXCEPTION 'choose a valid period or valid dates' USING ERRCODE = 'invalid_parameter_value';
  END;
  IF v_from IS NULL OR v_to IS NULL OR v_from > v_to THEN
    RAISE EXCEPTION 'choose a valid period or valid dates' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- The financial year decides whether figures can still change (0052); months carry no close state for reporting.
  SELECT jsonb_build_object('id', id, 'calendarKind', calendar_kind, 'label', label_en, 'labelFa', label_fa, 'startsOn', starts_on, 'endsOn', ends_on,
      'closed', closed_at IS NOT NULL)
    INTO v_year FROM abos.fiscal_years WHERE legal_entity_id = p_entity AND v_to BETWEEN starts_on AND ends_on;
  RETURN jsonb_build_object('mode', v_mode, 'from', v_from, 'to', v_to, 'period', v_period, 'fiscalYear', v_year,
    'periods', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', p.id, 'name', p.period_name, 'nameFa', p.period_name_fa,
        'startsOn', p.starts_on, 'endsOn', p.ends_on) ORDER BY p.starts_on)
      FROM abos.accounting_periods p WHERE p.legal_entity_id = p_entity AND p.starts_on <= v_to AND p.ends_on >= v_from), '[]'::jsonb));
END
$range$;

-- A journal's business source: its type and id, a business label, the screen that shows it, and its counterparty when
-- the reader may read that source module. Without that permission the label stays generic; amounts are never hidden.
CREATE FUNCTION abos.report_journal_source(p_entity uuid, p_journal uuid, p_permissions jsonb, p_visible boolean)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $source$
DECLARE intent abos.posting_intents%ROWTYPE; label jsonb; route text; party text; readable boolean;
BEGIN
  SELECT i.* INTO intent FROM abos.journals j JOIN abos.posting_intents i ON i.id = j.posting_intent_id
   WHERE j.id = p_journal AND j.legal_entity_id = p_entity;
  IF NOT FOUND THEN RETURN NULL; END IF;
  label := CASE intent.source_type
    WHEN 'CASH_RECEIPT' THEN jsonb_build_object('en', 'Money received', 'fa', 'پول دریافت‌شده')
    WHEN 'PAYMENT' THEN jsonb_build_object('en', 'Payment', 'fa', 'پرداخت')
    WHEN 'TREASURY_TRANSFER' THEN jsonb_build_object('en', 'Transfer between accounts', 'fa', 'انتقال میان حساب‌ها')
    WHEN 'OPENING_BALANCE' THEN jsonb_build_object('en', 'Opening balance', 'fa', 'موجودی افتتاحیه')
    WHEN 'OPERATIONAL_EXPENSE' THEN jsonb_build_object('en', 'Expense', 'fa', 'مصرف')
    WHEN 'DIRECT_SHAREHOLDER_CAPITAL' THEN jsonb_build_object('en', 'Capital received', 'fa', 'سرمایه دریافت‌شده')
    WHEN 'TEMPORARY_FUNDING' THEN jsonb_build_object('en', 'Funding received', 'fa', 'تمویل دریافت‌شده')
    WHEN 'TEMPORARY_FUNDING_SETTLEMENT' THEN jsonb_build_object('en', 'Funding repaid', 'fa', 'بازپرداخت تمویل')
    WHEN 'REVERSAL' THEN jsonb_build_object('en', 'Reversal', 'fa', 'برگشت')
    ELSE jsonb_build_object('en', 'Other posting', 'fa', 'ثبت دیگر') END;
  route := CASE intent.source_type
    WHEN 'CASH_RECEIPT' THEN '/finance/safes' WHEN 'PAYMENT' THEN '/finance/safes' WHEN 'TREASURY_TRANSFER' THEN '/finance/safes'
    WHEN 'OPENING_BALANCE' THEN '/finance/safes' WHEN 'OPERATIONAL_EXPENSE' THEN '/finance/transactions'
    WHEN 'DIRECT_SHAREHOLDER_CAPITAL' THEN '/shareholders' WHEN 'TEMPORARY_FUNDING' THEN '/finance/temporary-funding'
    WHEN 'TEMPORARY_FUNDING_SETTLEMENT' THEN '/finance/temporary-funding' WHEN 'REVERSAL' THEN '/finance/reversals' END;
  IF NOT p_visible THEN
    RETURN jsonb_build_object('type', 'RESTRICTED', 'label', jsonb_build_object('en', 'Restricted movement', 'fa', 'حرکت محدود'),
      'id', NULL, 'route', NULL, 'counterparty', NULL);
  END IF;
  readable := CASE
    WHEN intent.source_type = 'DIRECT_SHAREHOLDER_CAPITAL' THEN p_permissions ?| ARRAY['shareholder.read', 'shareholder.capital-receipt.read']
    WHEN intent.source_type IN ('TEMPORARY_FUNDING', 'TEMPORARY_FUNDING_SETTLEMENT') THEN p_permissions ? 'finance.temporary-funding.read'
    ELSE true END;
  IF readable THEN
    party := CASE intent.source_type
      WHEN 'CASH_RECEIPT' THEN (SELECT COALESCE((SELECT display_name FROM abos.business_parties WHERE id = r.payer_business_party_id), r.payer_name)
        FROM abos.treasury_cash_receipts r WHERE r.id = intent.source_id)
      WHEN 'PAYMENT' THEN (SELECT COALESCE((SELECT display_name FROM abos.business_parties WHERE id = p.payee_business_party_id), p.payee_name)
        FROM abos.treasury_payments p WHERE p.id = intent.source_id)
      WHEN 'OPERATIONAL_EXPENSE' THEN (SELECT b.display_name FROM abos.operational_expenses e JOIN abos.business_parties b ON b.id = e.payee_business_party_id
        WHERE e.id = intent.source_id)
      WHEN 'DIRECT_SHAREHOLDER_CAPITAL' THEN (SELECT b.display_name FROM abos.subledger_entries s JOIN abos.business_parties b ON b.id = s.business_party_id
        WHERE s.direct_capital_receipt_id = intent.source_id AND s.subledger_type = 'SHAREHOLDER_CAPITAL' LIMIT 1)
      WHEN 'TEMPORARY_FUNDING' THEN (SELECT b.display_name FROM abos.subledger_entries s JOIN abos.business_parties b ON b.id = s.business_party_id
        WHERE s.source_id = intent.source_id AND s.subledger_type = 'TEMPORARY_FUNDING_PAYABLE' LIMIT 1)
      WHEN 'TEMPORARY_FUNDING_SETTLEMENT' THEN (SELECT b.display_name FROM abos.subledger_entries s JOIN abos.business_parties b ON b.id = s.business_party_id
        WHERE s.source_id = intent.source_id AND s.subledger_type = 'TEMPORARY_FUNDING_PAYABLE' LIMIT 1)
      END;
  END IF;
  RETURN jsonb_build_object('type', intent.source_type, 'id', CASE WHEN readable THEN intent.source_id END, 'label', label,
    'route', CASE WHEN readable THEN route END, 'counterparty', party, 'detailRestricted', NOT readable);
END
$source$;


-- ---------------------------------------------------------------------------------------------
-- 2. Entry points.
-- ---------------------------------------------------------------------------------------------
-- Trial balance: per account the opening, period and ending positions on their natural side (a positive net is a
-- debit, a negative net a credit), gross period debits and credits, the native detail of foreign-currency lines, and the
-- proof that every total balances.
CREATE FUNCTION abos.finance_trial_balance(p_proof text, p_runtime text, p_token text, p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $tb$
DECLARE c jsonb; entity uuid; range jsonb; v_from date; v_to date; base text; include_zero boolean; rows jsonb; totals jsonb; unbalanced bigint;
BEGIN
  c := abos.operational_finance_actor(p_proof, p_runtime, p_token, 'finance.report.operational.read');
  entity := (c->>'legalEntityId')::uuid;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_payload) k
       WHERE k NOT IN ('periodId', 'from', 'to', 'asOf', 'includeZero')) THEN
    RAISE EXCEPTION 'unknown report fields' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  range := abos.report_range(entity, p_payload);
  v_from := (range->>'from')::date; v_to := (range->>'to')::date;
  include_zero := COALESCE((p_payload->>'includeZero')::boolean, false);
  SELECT base_currency_code INTO base FROM abos.legal_entities WHERE id = entity;
  WITH native AS MATERIALIZED (
    SELECT * FROM abos.report_native_balances(entity, v_from, v_to)
  ), balance AS (
    SELECT account.id, account.account_code, account.account_name, account.account_type, account.control_account_type,
           account.account_currency_code, account.status, account.parent_ledger_account_id,
           COALESCE(b.opening_debit, 0) - COALESCE(b.opening_credit, 0) AS opening_net,
           COALESCE(b.period_debit, 0) AS period_debit, COALESCE(b.period_credit, 0) AS period_credit
      FROM abos.ledger_accounts account
      LEFT JOIN abos.report_account_balances(entity, v_from, v_to) b ON b.ledger_account_id = account.id
     WHERE account.legal_entity_id = entity
  ), shown AS (
    SELECT balance.*, opening_net + period_debit - period_credit AS ending_net FROM balance
     WHERE include_zero OR opening_net <> 0 OR period_debit <> 0 OR period_credit <> 0
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'accountId', s.id, 'accountCode', s.account_code, 'accountName', s.account_name, 'accountType', s.account_type,
      'controlType', s.control_account_type, 'accountCurrency', s.account_currency_code, 'status', s.status, 'parentId', s.parent_ledger_account_id,
      'openingDebit', greatest(s.opening_net, 0)::text, 'openingCredit', greatest(-s.opening_net, 0)::text,
      'periodDebit', s.period_debit::text, 'periodCredit', s.period_credit::text,
      'endingDebit', greatest(s.ending_net, 0)::text, 'endingCredit', greatest(-s.ending_net, 0)::text,
      'native', COALESCE((SELECT jsonb_agg(jsonb_build_object('currency', n.currency_code, 'openingNet', n.opening_net::text,
          'periodDebit', n.period_debit::text, 'periodCredit', n.period_credit::text,
          'endingNet', (n.opening_net + n.period_debit - n.period_credit)::text) ORDER BY n.currency_code)
        FROM native n WHERE n.ledger_account_id = s.id), '[]'::jsonb))
      ORDER BY s.account_code, s.id), '[]'::jsonb),
    jsonb_build_object(
      'openingDebit', COALESCE(sum(greatest(s.opening_net, 0)), 0)::text, 'openingCredit', COALESCE(sum(greatest(-s.opening_net, 0)), 0)::text,
      'periodDebit', COALESCE(sum(s.period_debit), 0)::text, 'periodCredit', COALESCE(sum(s.period_credit), 0)::text,
      'endingDebit', COALESCE(sum(greatest(s.ending_net, 0)), 0)::text, 'endingCredit', COALESCE(sum(greatest(-s.ending_net, 0)), 0)::text)
    INTO rows, totals
    FROM shown s;
  -- Integrity: every posted journal of the company balances (the kernel guarantees it; the report proves it).
  SELECT count(*) INTO unbalanced FROM (SELECT journal.id FROM abos.journals journal JOIN abos.journal_lines line ON line.journal_id = journal.id
     WHERE journal.legal_entity_id = entity AND journal.status = 'POSTED' AND journal.accounting_effective_date <= v_to
     GROUP BY journal.id HAVING sum(line.base_debit) <> sum(line.base_credit)) x;
  RETURN jsonb_build_object('legalEntityId', entity, 'baseCurrency', base, 'range', range, 'includeZero', include_zero,
    'accounts', rows, 'totals', totals,
    'balanced', (totals->>'openingDebit')::numeric = (totals->>'openingCredit')::numeric
      AND (totals->>'periodDebit')::numeric = (totals->>'periodCredit')::numeric
      AND (totals->>'endingDebit')::numeric = (totals->>'endingCredit')::numeric AND unbalanced = 0,
    'unbalancedJournals', unbalanced);
END
$tb$;

-- One account's statement: the opening (all posted activity before the start), every posted line in the range in
-- order with its running balance, and the closing. A line outside the reader's scope keeps its date and amounts; its
-- reference, source and counterparty are hidden.
CREATE FUNCTION abos.finance_account_statement(p_proof text, p_runtime text, p_token text, p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $statement$
DECLARE c jsonb; entity uuid; actor uuid; perms jsonb; range jsonb; v_from date; v_to date; account record;
  account_id uuid; opening numeric; line_count bigint; lines jsonb;
BEGIN
  c := abos.operational_finance_actor(p_proof, p_runtime, p_token, 'finance.report.operational.read');
  entity := (c->>'legalEntityId')::uuid; actor := (c->>'userAccountId')::uuid; perms := COALESCE(c->'permissions', '[]'::jsonb);
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_payload) k
       WHERE k NOT IN ('accountId', 'periodId', 'from', 'to', 'asOf')) THEN
    RAISE EXCEPTION 'unknown report fields' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  BEGIN
    account_id := NULLIF(p_payload->>'accountId', '')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'choose a valid account' USING ERRCODE = 'invalid_parameter_value';
  END;
  SELECT id, account_code, account_name, account_type, control_account_type, account_currency_code, status INTO account
    FROM abos.ledger_accounts WHERE id = account_id AND legal_entity_id = entity;
  IF NOT FOUND THEN RAISE EXCEPTION 'the ledger account was not found in this legal entity' USING ERRCODE = 'no_data_found'; END IF;
  range := abos.report_range(entity, p_payload - 'accountId');
  v_from := (range->>'from')::date; v_to := (range->>'to')::date;
  -- The opening of this one account: all its posted lines before the start (journal_lines_account_idx).
  SELECT COALESCE(sum(line.base_debit) - sum(line.base_credit), 0) INTO opening
    FROM abos.journal_lines line JOIN abos.journals journal ON journal.id = line.journal_id AND journal.legal_entity_id = line.legal_entity_id
   WHERE line.ledger_account_id = account.id AND line.legal_entity_id = entity AND journal.status = 'POSTED'
     AND journal.accounting_effective_date < v_from;
  SELECT count(*) INTO line_count FROM abos.journal_lines line JOIN abos.journals journal ON journal.id = line.journal_id
   WHERE line.legal_entity_id = entity AND line.ledger_account_id = account.id AND journal.status = 'POSTED'
     AND journal.accounting_effective_date BETWEEN v_from AND v_to;
  IF line_count > 5000 THEN
    RAISE EXCEPTION 'this statement has % lines; choose a shorter period', line_count USING ERRCODE = 'program_limit_exceeded';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'journalId', x.journal_id, 'lineNumber', x.line_number, 'date', x.effective_date, 'postedAt', x.posted_at,
      'debit', x.base_debit::text, 'credit', x.base_credit::text, 'balance', (opening + x.running)::text,
      'originalAmount', x.original_amount::text, 'originalCurrency', x.original_currency_code,
      'rate', CASE WHEN x.visible THEN (SELECT jsonb_build_object('rate', s.rate_value::text, 'unitCurrency', s.unit_currency_code,
          'quoteCurrency', s.quote_currency_code, 'rateDate', s.rate_date, 'source', s.rate_source)
        FROM abos.exchange_rate_snapshots s WHERE s.id::text = x.conversion_snapshot_reference AND s.legal_entity_id = entity) END,
      'restricted', NOT x.visible,
      'journalReference', CASE WHEN x.visible THEN x.journal_reference END,
      'source', abos.report_journal_source(entity, x.journal_id, perms, x.visible),
      'reversedBy', CASE WHEN x.visible THEN (SELECT jsonb_build_object('journalId', l.reversal_journal_id, 'reference', r.journal_reference,
          'date', r.accounting_effective_date) FROM abos.journal_reversal_links l JOIN abos.journals r ON r.id = l.reversal_journal_id
        WHERE l.original_journal_id = x.journal_id) END,
      'reverses', CASE WHEN x.visible THEN (SELECT jsonb_build_object('journalId', l.original_journal_id, 'reference', o.journal_reference,
          'date', o.accounting_effective_date) FROM abos.journal_reversal_links l JOIN abos.journals o ON o.id = l.original_journal_id
        WHERE l.reversal_journal_id = x.journal_id) END)
      ORDER BY x.effective_date, x.posted_at, x.journal_id, x.line_number), '[]'::jsonb)
    INTO lines
    FROM (SELECT journal.id AS journal_id, line.line_number, journal.accounting_effective_date AS effective_date, journal.posted_at,
                 journal.journal_reference, line.base_debit, line.base_credit, line.original_amount, line.original_currency_code,
                 line.conversion_snapshot_reference,
                 abos.report_line_visible(entity, actor, line.project_id, line.department_id, line.cost_center_id) AS visible,
                 sum(line.base_debit - line.base_credit) OVER (ORDER BY journal.accounting_effective_date, journal.posted_at, journal.id, line.line_number
                   ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running
            FROM abos.journal_lines line JOIN abos.journals journal ON journal.id = line.journal_id AND journal.legal_entity_id = line.legal_entity_id
           WHERE line.legal_entity_id = entity AND line.ledger_account_id = account.id AND journal.status = 'POSTED'
             AND journal.accounting_effective_date BETWEEN v_from AND v_to) x;
  RETURN jsonb_build_object('legalEntityId', entity, 'range', range,
    'account', jsonb_build_object('id', account.id, 'code', account.account_code, 'name', account.account_name, 'type', account.account_type,
      'controlType', account.control_account_type, 'currency', account.account_currency_code, 'status', account.status),
    'opening', jsonb_build_object('debit', greatest(opening, 0)::text, 'credit', greatest(-opening, 0)::text, 'net', opening::text),
    'lines', lines,
    'periodDebit', COALESCE((SELECT sum((l->>'debit')::numeric) FROM jsonb_array_elements(lines) l), 0)::text,
    'periodCredit', COALESCE((SELECT sum((l->>'credit')::numeric) FROM jsonb_array_elements(lines) l), 0)::text,
    'closing', (SELECT jsonb_build_object('debit', greatest(n, 0)::text, 'credit', greatest(-n, 0)::text, 'net', n::text)
      FROM (SELECT opening + COALESCE(sum((l->>'debit')::numeric - (l->>'credit')::numeric), 0) AS n FROM jsonb_array_elements(lines) l) t));
END
$statement$;

-- One journal: its header, lines (with native amounts and the frozen rate), business source and reversal links. Lines
-- outside the reader's scope keep account and amounts and hide their dimensions; the source is hidden if any line is.
CREATE FUNCTION abos.finance_journal_detail(p_proof text, p_runtime text, p_token text, p_journal_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $detail$
DECLARE c jsonb; entity uuid; actor uuid; perms jsonb; journal abos.journals%ROWTYPE; visible boolean; intent abos.posting_intents%ROWTYPE;
BEGIN
  c := abos.operational_finance_actor(p_proof, p_runtime, p_token, 'finance.report.operational.read');
  entity := (c->>'legalEntityId')::uuid; actor := (c->>'userAccountId')::uuid; perms := COALESCE(c->'permissions', '[]'::jsonb);
  SELECT * INTO journal FROM abos.journals WHERE id = p_journal_id AND legal_entity_id = entity AND status = 'POSTED';
  IF NOT FOUND THEN RAISE EXCEPTION 'the journal was not found in this legal entity' USING ERRCODE = 'no_data_found'; END IF;
  SELECT bool_and(abos.report_line_visible(entity, actor, line.project_id, line.department_id, line.cost_center_id)) INTO visible
    FROM abos.journal_lines line WHERE line.journal_id = journal.id;
  SELECT * INTO intent FROM abos.posting_intents WHERE id = journal.posting_intent_id;
  RETURN jsonb_build_object(
    'journalId', journal.id, 'reference', CASE WHEN visible THEN journal.journal_reference END, 'restricted', NOT visible,
    'date', journal.accounting_effective_date, 'postedAt', journal.posted_at, 'baseCurrency', journal.base_currency_code,
    'postedBy', CASE WHEN visible THEN (SELECT display_name FROM abos.user_accounts WHERE id = journal.posted_by_user_account_id) END,
    'period', (SELECT jsonb_build_object('id', p.id, 'name', p.period_name, 'nameFa', p.period_name_fa)
      FROM abos.accounting_periods p WHERE p.id = journal.accounting_period_id),
    'source', abos.report_journal_source(entity, journal.id, perms, visible),
    'lines', COALESCE((SELECT jsonb_agg(jsonb_build_object('lineNumber', line.line_number, 'accountId', a.id, 'accountCode', a.account_code,
        'accountName', a.account_name, 'accountType', a.account_type, 'debit', line.base_debit::text, 'credit', line.base_credit::text,
        'originalAmount', line.original_amount::text, 'originalCurrency', line.original_currency_code) ORDER BY line.line_number)
      FROM abos.journal_lines line JOIN abos.ledger_accounts a ON a.id = line.ledger_account_id WHERE line.journal_id = journal.id), '[]'::jsonb),
    'fx', CASE WHEN visible AND intent.conversion_snapshot_reference IS NOT NULL THEN (SELECT jsonb_build_object(
        'rate', s.rate_value::text, 'unitCurrency', s.unit_currency_code, 'quoteCurrency', s.quote_currency_code, 'rateDate', s.rate_date,
        'source', s.rate_source, 'roundingMode', f.rounding_mode, 'baseScale', f.base_scale, 'exactBaseAmount', f.exact_base_amount::text,
        'roundingDifference', f.rounding_difference::text, 'policyVersionId', f.fx_policy_version_id)
      FROM abos.exchange_rate_snapshots s LEFT JOIN abos.fx_conversions f ON f.exchange_rate_snapshot_id = s.id
      WHERE s.id::text = intent.conversion_snapshot_reference AND s.legal_entity_id = entity) END,
    'reversedBy', (SELECT jsonb_build_object('journalId', l.reversal_journal_id, 'reference', CASE WHEN visible THEN r.journal_reference END,
        'date', r.accounting_effective_date, 'reason', CASE WHEN visible THEN l.reason END)
      FROM abos.journal_reversal_links l JOIN abos.journals r ON r.id = l.reversal_journal_id WHERE l.original_journal_id = journal.id),
    'reverses', (SELECT jsonb_build_object('journalId', l.original_journal_id, 'reference', CASE WHEN visible THEN o.journal_reference END,
        'date', o.accounting_effective_date, 'reason', CASE WHEN visible THEN l.reason END)
      FROM abos.journal_reversal_links l JOIN abos.journals o ON o.id = l.original_journal_id WHERE l.reversal_journal_id = journal.id));
END
$detail$;


-- ---------------------------------------------------------------------------------------------
-- 3. The General Ledger keeps every posted line (0024 restated). Visibility masks detail, never money: a line outside
--    the reader's scope keeps its date, account and amounts; its reference becomes NULL and its source RESTRICTED.
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION abos.finance_gl_visible_lines(p_legal_entity_id uuid, p_actor_id uuid, p_from date, p_to date, p_account_id uuid)
 RETURNS TABLE(journal_id uuid, journal_reference text, line_number integer, account_id uuid, account_code text, account_name text, source_type text, source_id uuid, accounting_period_id uuid, accounting_effective_date date, posted_at timestamp with time zone, original_currency_code text, original_amount numeric, base_currency_code text, base_debit numeric, base_credit numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT journal.id, CASE WHEN detail.ok THEN journal.journal_reference END, line.line_number, account.id,
         account.account_code, account.account_name,
         CASE WHEN detail.ok THEN line.source_type ELSE 'RESTRICTED' END, CASE WHEN detail.ok THEN line.source_id END,
         journal.accounting_period_id, journal.accounting_effective_date, journal.posted_at,
         line.original_currency_code, line.original_amount, line.base_currency_code,
         line.base_debit, line.base_credit
    FROM abos.journal_lines line
    JOIN abos.journals journal
      ON journal.id = line.journal_id AND journal.legal_entity_id = line.legal_entity_id
    JOIN abos.ledger_accounts account
      ON account.id = line.ledger_account_id AND account.legal_entity_id = line.legal_entity_id
    CROSS JOIN LATERAL (SELECT true
       AND (line.project_id IS NULL OR EXISTS (
       SELECT 1 FROM abos.user_scope_grants scope
        WHERE scope.user_account_id = p_actor_id AND scope.legal_entity_id = p_legal_entity_id
          AND scope.scope_kind = 'PROJECT' AND scope.scope_id = line.project_id
          AND scope.revoked_at IS NULL))
     AND (line.department_id IS NULL OR EXISTS (
       SELECT 1 FROM abos.user_scope_grants scope
        WHERE scope.user_account_id = p_actor_id AND scope.legal_entity_id = p_legal_entity_id
          AND scope.scope_kind = 'DEPARTMENT' AND scope.scope_id = line.department_id
          AND scope.revoked_at IS NULL))
     AND (line.cost_center_id IS NULL OR EXISTS (
       SELECT 1 FROM abos.user_scope_grants scope
        WHERE scope.user_account_id = p_actor_id AND scope.legal_entity_id = p_legal_entity_id
          AND scope.scope_kind = 'COST_CENTER' AND scope.scope_id = line.cost_center_id
          AND scope.revoked_at IS NULL))
    AS ok) detail
   WHERE p_legal_entity_id IS NOT NULL AND p_actor_id IS NOT NULL
     AND journal.legal_entity_id = p_legal_entity_id AND line.legal_entity_id = p_legal_entity_id
     AND journal.status = 'POSTED'
     AND journal.accounting_effective_date BETWEEN p_from AND p_to
     AND (p_account_id IS NULL OR line.ledger_account_id = p_account_id)
$function$;

CREATE OR REPLACE FUNCTION abos.finance_general_ledger_page(p_bearer_token text, p_from date, p_to date, p_account_id uuid DEFAULT NULL::uuid, p_cursor text DEFAULT NULL::text, p_page_size integer DEFAULT 100)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  entity_id uuid;
  actor_id uuid;
  cursor_key jsonb;
  after_date date;
  after_posted timestamptz;
  after_journal uuid;
  after_line integer;
  page_size integer := coalesce(p_page_size, 100);
  result jsonb;
  last_line jsonb;
  more boolean;
BEGIN
  actor_id := abos.finance_runtime_authorize(p_bearer_token, 'finance.report.operational.read');
  entity_id := pg_catalog.current_setting('abos.finance_legal_entity_id')::uuid;
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN
    RAISE EXCEPTION 'valid inclusive date range required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF page_size < 1 OR page_size > 100 THEN
    RAISE EXCEPTION 'page size must be between 1 and 100' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_account_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM abos.ledger_accounts account
     WHERE account.id = p_account_id AND account.legal_entity_id = entity_id
  ) THEN
    RAISE EXCEPTION 'ledger account is outside the current legal entity'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_cursor IS NOT NULL THEN
    BEGIN
      IF pg_catalog.length(p_cursor) > 400 OR p_cursor !~ '^[A-Za-z0-9_-]+$' THEN
        RAISE EXCEPTION 'malformed';
      END IF;
      cursor_key := pg_catalog.convert_from(pg_catalog.decode(
        pg_catalog.rpad(pg_catalog.translate(p_cursor, '-_', '+/'),
                        ((pg_catalog.length(p_cursor) + 3) / 4) * 4, '='), 'base64'), 'UTF8')::jsonb;
      IF pg_catalog.jsonb_typeof(cursor_key) <> 'object' OR (cursor_key ->> 'v') IS DISTINCT FROM '1'
         OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(cursor_key)) <> 5 THEN
        RAISE EXCEPTION 'malformed';
      END IF;
      after_date := (cursor_key ->> 'd')::date;
      after_posted := (cursor_key ->> 'p')::timestamptz;
      after_journal := (cursor_key ->> 'j')::uuid;
      after_line := (cursor_key ->> 'l')::integer;
      IF after_date IS NULL OR after_posted IS NULL OR after_journal IS NULL OR after_line IS NULL
         OR after_line < 1 THEN
        RAISE EXCEPTION 'malformed';
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'General Ledger cursor is invalid' USING ERRCODE = 'invalid_parameter_value';
    END;
  END IF;

  -- One statement, so the page, the look-ahead row and the first-page totals share one snapshot.
  WITH visible AS MATERIALIZED (
    SELECT * FROM abos.finance_gl_visible_lines(entity_id, actor_id, p_from, p_to, p_account_id)
  ), after_position AS (
    SELECT visible.*
      FROM visible
     WHERE p_cursor IS NULL
        OR (visible.accounting_effective_date, visible.posted_at, visible.journal_id)
             < (after_date, after_posted, after_journal)
        OR ((visible.accounting_effective_date, visible.posted_at, visible.journal_id)
             = (after_date, after_posted, after_journal)
            AND visible.line_number > after_line)
     ORDER BY visible.accounting_effective_date DESC, visible.posted_at DESC,
              visible.journal_id DESC, visible.line_number
     LIMIT page_size + 1
  ), numbered AS (
    SELECT after_position.*,
           pg_catalog.row_number() OVER (
             ORDER BY after_position.accounting_effective_date DESC, after_position.posted_at DESC,
                      after_position.journal_id DESC, after_position.line_number) AS ordinal
      FROM after_position
  )
  SELECT pg_catalog.jsonb_build_object(
           'lines', coalesce((
             SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                      'journalId', numbered.journal_id,
                      'journalReference', numbered.journal_reference,
                      'lineNumber', numbered.line_number,
                      'accountId', numbered.account_id,
                      'accountCode', numbered.account_code,
                      'accountName', numbered.account_name,
                      'sourceType', numbered.source_type,
                      'sourceId', numbered.source_id,
                      'accountingPeriodId', numbered.accounting_period_id,
                      'accountingEffectiveDate', numbered.accounting_effective_date,
                      'postedAt', numbered.posted_at,
                      'originalCurrency', numbered.original_currency_code,
                      'originalAmount', numbered.original_amount::text,
                      'baseCurrency', numbered.base_currency_code,
                      'baseDebit', numbered.base_debit::text,
                      'baseCredit', numbered.base_credit::text,
                      'restricted', numbered.source_type = 'RESTRICTED')
                    ORDER BY numbered.ordinal)
               FROM numbered WHERE numbered.ordinal <= page_size), '[]'::jsonb),
           'more', EXISTS (SELECT 1 FROM numbered WHERE numbered.ordinal > page_size),
           'totals', CASE WHEN p_cursor IS NULL THEN coalesce((
             SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                      'currency', totals.base_currency_code, 'debits', totals.debits,
                      'credits', totals.credits, 'lineCount', totals.line_count)
                    ORDER BY totals.base_currency_code)
               FROM (SELECT visible.base_currency_code,
                            pg_catalog.sum(visible.base_debit)::text AS debits,
                            pg_catalog.sum(visible.base_credit)::text AS credits,
                            pg_catalog.count(*)::text AS line_count
                       FROM visible GROUP BY visible.base_currency_code) totals), '[]'::jsonb)
             END)
    INTO result;

  more := (result ->> 'more')::boolean;
  last_line := result -> 'lines' -> -1;

  RETURN pg_catalog.jsonb_build_object(
    'syntheticOnly', false, 'legalEntityId', entity_id,
    'from', p_from, 'to', p_to, 'accountId', p_account_id,
    'order', 'accountingEffectiveDate DESC, postedAt DESC, journalId DESC, lineNumber ASC',
    'pageLimit', page_size,
    'lines', result -> 'lines',
    'returnedLineCount', pg_catalog.jsonb_array_length(result -> 'lines'),
    'hasMore', more,
    'nextCursor', CASE WHEN more AND last_line IS NOT NULL THEN
      pg_catalog.rtrim(pg_catalog.translate(pg_catalog.encode(pg_catalog.convert_to(
        pg_catalog.jsonb_build_object(
          'v', 1,
          'd', last_line -> 'accountingEffectiveDate',
          'p', last_line -> 'postedAt',
          'j', last_line -> 'journalId',
          'l', last_line -> 'lineNumber')::text, 'UTF8'), 'base64'), E'+/\n', '-_'), '=')
      END,
    'totals', result -> 'totals');
END
$function$;

-- The older unpaged General Ledger (0020/0032) reads the same masked lines, so no ledger read anywhere drops money.
CREATE OR REPLACE FUNCTION abos.finance_general_ledger(p_bearer_token text, p_from date, p_to date, p_account_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  entity_id uuid;
  actor_id uuid;
  lines jsonb;
  totals jsonb;
BEGIN
  actor_id := abos.finance_runtime_authorize(p_bearer_token, 'finance.report.operational.read');
  entity_id := pg_catalog.current_setting('abos.finance_legal_entity_id')::uuid;
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN
    RAISE EXCEPTION 'valid inclusive date range required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_account_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM abos.ledger_accounts account
     WHERE account.id = p_account_id AND account.legal_entity_id = entity_id
  ) THEN
    RAISE EXCEPTION 'ledger account is outside the current legal entity'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(item)
           ORDER BY item."accountingEffectiveDate" DESC, item."postedAt" DESC,
                    item."journalId" DESC, item."lineNumber"), '[]'::jsonb)
    INTO lines
    FROM (
      SELECT visible.journal_id AS "journalId", visible.journal_reference AS "journalReference",
             visible.line_number AS "lineNumber", visible.account_id AS "accountId",
             visible.account_code AS "accountCode", visible.account_name AS "accountName",
             visible.source_type AS "sourceType", visible.source_id AS "sourceId",
             visible.accounting_period_id AS "accountingPeriodId",
             visible.accounting_effective_date AS "accountingEffectiveDate",
             visible.posted_at AS "postedAt",
             visible.original_currency_code AS "originalCurrency",
             visible.original_amount::text AS "originalAmount",
             visible.base_currency_code AS "baseCurrency",
             visible.base_debit::text AS "baseDebit",
             visible.base_credit::text AS "baseCredit",
             visible.source_type = 'RESTRICTED' AS "restricted"
        FROM abos.finance_gl_visible_lines(entity_id, actor_id, p_from, p_to, p_account_id) visible
       ORDER BY visible.accounting_effective_date DESC, visible.posted_at DESC,
                visible.journal_id DESC, visible.line_number
       LIMIT 100
    ) item;

  SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(item)
           ORDER BY item.currency), '[]'::jsonb)
    INTO totals
    FROM (
      SELECT visible.base_currency_code AS currency,
             pg_catalog.sum(visible.base_debit)::text AS debits,
             pg_catalog.sum(visible.base_credit)::text AS credits,
             pg_catalog.count(*)::text AS "lineCount"
        FROM abos.finance_gl_visible_lines(entity_id, actor_id, p_from, p_to, p_account_id) visible
       GROUP BY visible.base_currency_code
    ) item;

  RETURN pg_catalog.jsonb_build_object(
    'syntheticOnly', false, 'legalEntityId', entity_id,
    'from', p_from, 'to', p_to, 'accountId', p_account_id,
    'lines', lines, 'totals', totals, 'pageLimit', 100,
    'returnedLineCount', pg_catalog.jsonb_array_length(lines),
    'hasMore', (SELECT coalesce(pg_catalog.sum((entry ->> 'lineCount')::bigint), 0)
                 FROM pg_catalog.jsonb_array_elements(totals) entry)
               > pg_catalog.jsonb_array_length(lines));
END
$function$;


-- ---------------------------------------------------------------------------------------------
-- 4. Reporting authority on the operational actor, and privileges.
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION abos.operational_finance_actor(p_identity_proof text, p_runtime_token_sha256 text, p_token_sha256 text, p_required_permission text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE actor_context jsonb;
BEGIN
  IF p_required_permission IS NOT NULL AND p_required_permission NOT IN (
    'treasury.operational-account.manage', 'finance.expense-category.manage',
    'finance.expense.create', 'finance.expense.read', 'finance.expense.approve',
    'finance.period.manage', 'shareholder.capital-receipt.read',
    'shareholder.capital-receipt.record', 'treasury.capital-receipt.verify',
    'finance.capital-receipt.configure', 'finance.capital-receipt.prepare',
    'finance.capital-receipt.approve', 'finance.capital-receipt.post',
    'finance.temporary-funding.read', 'finance.temporary-funding.record',
    'finance.temporary-funding.approve', 'finance.temporary-funding.settle',
    'finance.temporary-funding.settle-approve', 'finance.temporary-funding.configure',
    'finance.period.reopen', 'finance.reversal.direct', 'finance.reversal.request', 'finance.reversal.approve',
    'finance.fx-policy.manage', 'finance.report.operational.read'
  ) THEN
    RAISE EXCEPTION 'unsupported operational Finance permission'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
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
$function$;

-- The reports read the account hierarchy and the financial year (column-level, read-only).
GRANT SELECT (parent_ledger_account_id) ON abos.ledger_accounts TO abos_v1_operational_finance_owner;
GRANT SELECT (id, legal_entity_id, calendar_kind, label_en, label_fa, starts_on, ends_on) ON abos.fiscal_years TO abos_v1_operational_finance_owner;

REVOKE ALL ON FUNCTION
  abos.report_line_visible(uuid, uuid, uuid, uuid, uuid), abos.report_account_balances(uuid, date, date),
  abos.report_native_balances(uuid, date, date), abos.report_range(uuid, jsonb), abos.report_journal_source(uuid, uuid, jsonb, boolean)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  abos.report_line_visible(uuid, uuid, uuid, uuid, uuid), abos.report_account_balances(uuid, date, date),
  abos.report_native_balances(uuid, date, date), abos.report_range(uuid, jsonb), abos.report_journal_source(uuid, uuid, jsonb, boolean)
  TO abos_v1_operational_finance_owner;

ALTER FUNCTION abos.finance_trial_balance(text, text, text, jsonb) OWNER TO abos_v1_operational_finance_owner;
ALTER FUNCTION abos.finance_account_statement(text, text, text, jsonb) OWNER TO abos_v1_operational_finance_owner;
ALTER FUNCTION abos.finance_journal_detail(text, text, text, uuid) OWNER TO abos_v1_operational_finance_owner;
REVOKE ALL ON FUNCTION abos.finance_trial_balance(text, text, text, jsonb), abos.finance_account_statement(text, text, text, jsonb),
  abos.finance_journal_detail(text, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION abos.finance_trial_balance(text, text, text, jsonb), abos.finance_account_statement(text, text, text, jsonb),
  abos.finance_journal_detail(text, text, text, uuid) TO abos_e1_runtime;
