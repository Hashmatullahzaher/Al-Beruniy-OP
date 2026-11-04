-- 0059: Slice 7 part 4. The Income Statement and the Balance Sheet.
--
-- Both are built from posted journal lines through the same primitives as the Trial Balance. The account's class decides where a
-- figure goes; no module, account number or name takes part. See docs/03-architecture/V1_CHART_OF_ACCOUNTS_CLASSIFICATION_AUDIT.md.
--
-- No table, no row and no journal. In particular no closing or retained earnings entry is posted: the accumulated result is derived
-- for presentation, split into earlier years and the current year.
--
-- These statements carry account-level arithmetic only, never a source, so they need only the report permission.

-- Every account with its class and parent, and its position: opening before p_from, movement to p_to, debit-positive.
CREATE FUNCTION abos.report_classified_accounts(p_entity uuid, p_from date, p_to date)
RETURNS TABLE(ledger_account_id uuid, account_code text, account_name text, account_type text, control_account_type text, status text,
  parent_id uuid, parent_code text, parent_name text, opening_net numeric, period_debit numeric, period_credit numeric, closing_net numeric)
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $classified$
  SELECT a.id, a.account_code, a.account_name, a.account_type, a.control_account_type, a.status, p.id, p.account_code, p.account_name,
         b.opening_debit - b.opening_credit, b.period_debit, b.period_credit, b.opening_debit - b.opening_credit + b.period_debit - b.period_credit
    FROM abos.report_account_balances(p_entity, p_from, p_to) b
    JOIN abos.ledger_accounts a ON a.id = b.ledger_account_id AND a.legal_entity_id = p_entity
    LEFT JOIN abos.ledger_accounts p ON p.id = a.parent_ledger_account_id AND p.legal_entity_id = p_entity
$classified$;

-- The first day of the financial year holding a date, or of its calendar year when no financial year covers it.
CREATE FUNCTION abos.report_year_start(p_entity uuid, p_date date)
RETURNS date LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $year$
  SELECT COALESCE((SELECT y.starts_on FROM abos.fiscal_years y WHERE y.legal_entity_id = p_entity AND p_date BETWEEN y.starts_on AND y.ends_on), date_trunc('year', p_date)::date)
$year$;

CREATE FUNCTION abos.finance_income_statement(p_proof text, p_runtime text, p_token text, p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $income$
DECLARE c jsonb; entity uuid; base text; range jsonb; v_from date; v_to date; result record; to_date_result record; year_start date; rows jsonb;
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
  year_start := abos.report_year_start(entity, v_to);
  SELECT COALESCE(jsonb_agg(jsonb_build_object('accountId', x.ledger_account_id, 'code', x.account_code, 'name', x.account_name, 'class', x.account_type, 'status', x.status,
      'parent', CASE WHEN x.parent_id IS NOT NULL THEN jsonb_build_object('id', x.parent_id, 'code', x.parent_code, 'name', x.parent_name) END,
      'amount', (CASE x.account_type WHEN 'REVENUE' THEN x.period_credit - x.period_debit ELSE x.period_debit - x.period_credit END)::text)
      ORDER BY x.account_code, x.ledger_account_id), '[]'::jsonb)
    INTO rows FROM abos.report_classified_accounts(entity, v_from, v_to) x
   WHERE x.account_type IN ('REVENUE', 'EXPENSE') AND (x.period_debit <> 0 OR x.period_credit <> 0);
  SELECT * INTO result FROM abos.report_income_result(entity, v_from, v_to);
  SELECT * INTO to_date_result FROM abos.report_income_result(entity, year_start, v_to);
  RETURN jsonb_build_object('legalEntityId', entity, 'baseCurrency', base, 'range', range,
    'income', (SELECT COALESCE(jsonb_agg(r), '[]'::jsonb) FROM jsonb_array_elements(rows) r WHERE r->>'class' = 'REVENUE'),
    'expenses', (SELECT COALESCE(jsonb_agg(r), '[]'::jsonb) FROM jsonb_array_elements(rows) r WHERE r->>'class' = 'EXPENSE'),
    'totalIncome', result.income::text, 'totalExpenses', result.expense::text, 'netResult', result.net_result::text,
    'yearToDate', jsonb_build_object('from', year_start, 'to', v_to, 'income', to_date_result.income::text, 'expenses', to_date_result.expense::text, 'netResult', to_date_result.net_result::text));
END
$income$;

CREATE FUNCTION abos.finance_balance_sheet(p_proof text, p_runtime text, p_token text, p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $sheet$
DECLARE c jsonb; entity uuid; base text; range jsonb; v_to date; year_start date; accounts jsonb; assets numeric; liabilities numeric; equity_accounts numeric;
  earlier_result numeric; current_result numeric; equity numeric; treasury_ledger numeric; treasury_base numeric; unbalanced bigint;
BEGIN
  c := abos.operational_finance_actor(p_proof, p_runtime, p_token, 'finance.report.operational.read');
  entity := (c->>'legalEntityId')::uuid;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_payload) k
       WHERE k NOT IN ('periodId', 'asOf', 'fiscalYearId')) THEN
    RAISE EXCEPTION 'unknown report fields' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT base_currency_code INTO base FROM abos.legal_entities WHERE id = entity;
  range := abos.report_range(entity, p_payload);
  v_to := (range->>'to')::date;
  year_start := abos.report_year_start(entity, v_to);
  -- Each account's natural-side balance at the date. Money stays in its class, even when a balance is negative.
  SELECT COALESCE(jsonb_agg(jsonb_build_object('accountId', x.ledger_account_id, 'code', x.account_code, 'name', x.account_name, 'class', x.account_type, 'control', x.control_account_type,
      'status', x.status, 'parent', CASE WHEN x.parent_id IS NOT NULL THEN jsonb_build_object('id', x.parent_id, 'code', x.parent_code, 'name', x.parent_name) END,
      'group', CASE
        WHEN x.account_type = 'ASSET' AND x.control_account_type IN ('CASH', 'SARAF') THEN 'TREASURY'
        WHEN x.account_type = 'ASSET' THEN 'OTHER_ASSETS'
        WHEN x.account_type = 'LIABILITY' AND x.control_account_type IN ('TEMPORARY_FUNDING_PAYABLE', 'SHAREHOLDER_LOAN') THEN 'LOANS'
        WHEN x.account_type = 'LIABILITY' AND x.control_account_type = 'AP' THEN 'PAYABLES'
        WHEN x.account_type = 'LIABILITY' THEN 'OTHER_LIABILITIES'
        WHEN x.control_account_type = 'SHAREHOLDER_CAPITAL' THEN 'SHAREHOLDER_CAPITAL'
        WHEN x.control_account_type = 'OPENING_BALANCE_EQUITY' THEN 'OPENING_BALANCE_EQUITY'
        ELSE 'OTHER_EQUITY' END,
      'amount', (CASE WHEN x.account_type = 'ASSET' THEN x.closing_net ELSE -x.closing_net END)::text)
      ORDER BY x.account_code, x.ledger_account_id), '[]'::jsonb)
    INTO accounts FROM abos.report_classified_accounts(entity, year_start, v_to) x
   WHERE x.account_type IN ('ASSET', 'LIABILITY', 'EQUITY') AND (x.closing_net <> 0 OR x.control_account_type = 'OPENING_BALANCE_EQUITY');
  SELECT COALESCE(sum(x.closing_net) FILTER (WHERE x.account_type = 'ASSET'), 0), COALESCE(-sum(x.closing_net) FILTER (WHERE x.account_type = 'LIABILITY'), 0),
         COALESCE(-sum(x.closing_net) FILTER (WHERE x.account_type = 'EQUITY'), 0), COALESCE(-sum(x.opening_net) FILTER (WHERE x.account_type IN ('REVENUE', 'EXPENSE')), 0)
    INTO assets, liabilities, equity_accounts, earlier_result FROM abos.report_classified_accounts(entity, year_start, v_to) x;
  SELECT net_result INTO current_result FROM abos.report_income_result(entity, year_start, v_to);
  equity := equity_accounts + earlier_result + current_result;
  SELECT COALESCE(sum(abos.treasury_account_base_balance(entity, v_to, a.id)), 0) INTO treasury_base FROM abos.operational_treasury_accounts a WHERE a.legal_entity_id = entity;
  SELECT COALESCE(sum(x.closing_net), 0) INTO treasury_ledger FROM abos.report_classified_accounts(entity, year_start, v_to) x
   WHERE x.ledger_account_id IN (SELECT a.ledger_account_id FROM abos.operational_treasury_accounts a WHERE a.legal_entity_id = entity);
  SELECT count(*) INTO unbalanced FROM (SELECT line.journal_id FROM abos.journal_lines line JOIN abos.journals journal ON journal.id = line.journal_id AND journal.status = 'POSTED'
    WHERE line.legal_entity_id = entity AND journal.accounting_effective_date <= v_to GROUP BY line.journal_id HAVING sum(line.base_debit) <> sum(line.base_credit)) x;
  RETURN jsonb_build_object('legalEntityId', entity, 'baseCurrency', base, 'range', range, 'asOf', v_to, 'yearStart', year_start, 'accounts', accounts,
    'totalAssets', assets::text, 'totalLiabilities', liabilities::text, 'equityAccounts', equity_accounts::text,
    -- Derived for presentation: no retained earnings journal exists. Earlier years' result is everything before this financial year.
    'earlierYearsResult', earlier_result::text, 'currentYearResult', current_result::text, 'totalEquity', equity::text, 'totalLiabilitiesAndEquity', (liabilities + equity)::text,
    'validation', jsonb_build_object('difference', (assets - liabilities - equity)::text, 'balanced', assets = liabilities + equity AND unbalanced = 0, 'unbalancedJournals', unbalanced),
    'treasury', jsonb_build_object('treasuryBase', treasury_base::text, 'ledgerBase', treasury_ledger::text, 'matches', treasury_base = treasury_ledger));
END
$sheet$;

REVOKE ALL ON FUNCTION abos.report_classified_accounts(uuid, date, date), abos.report_year_start(uuid, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION abos.report_classified_accounts(uuid, date, date), abos.report_year_start(uuid, date) TO abos_v1_operational_finance_owner;

ALTER FUNCTION abos.finance_income_statement(text, text, text, jsonb) OWNER TO abos_v1_operational_finance_owner;
ALTER FUNCTION abos.finance_balance_sheet(text, text, text, jsonb) OWNER TO abos_v1_operational_finance_owner;
REVOKE ALL ON FUNCTION abos.finance_income_statement(text, text, text, jsonb), abos.finance_balance_sheet(text, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION abos.finance_income_statement(text, text, text, jsonb), abos.finance_balance_sheet(text, text, text, jsonb) TO abos_e1_runtime;
