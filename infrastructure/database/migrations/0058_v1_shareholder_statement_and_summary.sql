-- 0058: Slice 7 part 3. The Shareholder Statement and the Financial Summary.
--
-- Both read posted journals, their lines and subledgers only. This migration adds no table, no row and no journal.
--
-- 1. Shared primitives:
--    report_range                    restated: a whole financial year can be chosen.
--    report_income_result            income, expenses and net result from classified ledger accounts. The Financial Summary uses
--                                    it now; the Income Statement and Balance Sheet use the same one.
--    report_treasury_flows           every Treasury movement in a range by what it really is: a reversal counts as the source it
--                                    reverses, so transfers and their reversals stay internal.
--    report_party_positions          capital and loans per party, from the equity and payable subledgers.
-- 2. finance_management_summary: the Treasury position, money received and paid, transfers and reversals apart, and profit.
-- 3. finance_shareholder_statement: equity and debt, never one number. Agreement figures are information only.
--
-- Confidentiality hides detail, never money. A report reader gets company totals with no person named.

-- ---------------------------------------------------------------------------------------------
-- 1. Primitives.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION abos.report_range(p_entity uuid, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE v_from date; v_to date; v_mode text; v_modes integer; v_period jsonb; v_year jsonb;
BEGIN
  v_modes := (CASE WHEN NULLIF(p_payload->>'periodId', '') IS NOT NULL THEN 1 ELSE 0 END)
           + (CASE WHEN NULLIF(p_payload->>'from', '') IS NOT NULL OR NULLIF(p_payload->>'to', '') IS NOT NULL THEN 1 ELSE 0 END)
           + (CASE WHEN NULLIF(p_payload->>'asOf', '') IS NOT NULL THEN 1 ELSE 0 END)
           + (CASE WHEN NULLIF(p_payload->>'fiscalYearId', '') IS NOT NULL THEN 1 ELSE 0 END);
  IF v_modes <> 1 THEN
    RAISE EXCEPTION 'choose one: a period, a date range or an as-of date' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  BEGIN
    IF NULLIF(p_payload->>'periodId', '') IS NOT NULL THEN
      v_mode := 'PERIOD';
      SELECT jsonb_build_object('id', id, 'name', period_name, 'nameFa', period_name_fa), starts_on, ends_on
        INTO v_period, v_from, v_to FROM abos.accounting_periods WHERE id = (p_payload->>'periodId')::uuid AND legal_entity_id = p_entity;
      IF v_period IS NULL THEN RAISE EXCEPTION 'the accounting period was not found in this legal entity' USING ERRCODE = 'no_data_found'; END IF;
    ELSIF NULLIF(p_payload->>'fiscalYearId', '') IS NOT NULL THEN
      v_mode := 'YEAR';
      SELECT starts_on, ends_on INTO v_from, v_to FROM abos.fiscal_years WHERE id = (p_payload->>'fiscalYearId')::uuid AND legal_entity_id = p_entity;
      IF NOT FOUND THEN RAISE EXCEPTION 'the financial year was not found in this legal entity' USING ERRCODE = 'no_data_found'; END IF;
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
    'fiscalYears', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', y.id, 'label', y.label_en, 'labelFa', y.label_fa, 'startsOn', y.starts_on, 'endsOn', y.ends_on,
        'closed', y.closed_at IS NOT NULL) ORDER BY y.starts_on DESC) FROM abos.fiscal_years y WHERE y.legal_entity_id = p_entity), '[]'::jsonb),
    'periods', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', p.id, 'name', p.period_name, 'nameFa', p.period_name_fa,
        'startsOn', p.starts_on, 'endsOn', p.ends_on) ORDER BY p.starts_on)
      FROM abos.accounting_periods p WHERE p.legal_entity_id = p_entity AND p.starts_on <= v_to AND p.ends_on >= v_from), '[]'::jsonb));
END
$function$;

CREATE FUNCTION abos.report_income_result(p_entity uuid, p_from date, p_to date)
RETURNS TABLE(income numeric, expense numeric, net_result numeric)
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $result$
  -- The ledger account's class decides. Nothing here knows which module posted a line.
  SELECT COALESCE(sum(b.period_credit - b.period_debit) FILTER (WHERE account.account_type = 'REVENUE'), 0),
         COALESCE(sum(b.period_debit - b.period_credit) FILTER (WHERE account.account_type = 'EXPENSE'), 0),
         COALESCE(sum(b.period_credit - b.period_debit) FILTER (WHERE account.account_type IN ('REVENUE', 'EXPENSE')), 0)
    FROM abos.report_account_balances(p_entity, p_from, p_to) b
    JOIN abos.ledger_accounts account ON account.id = b.ledger_account_id AND account.legal_entity_id = p_entity
$result$;

-- One row per currency and effective source. "gross" is original movements; "reversal" is their reversals. A reversal never
-- counts as new money: it nets into the source it reverses and is also reported on its own.
CREATE FUNCTION abos.report_treasury_flows(p_entity uuid, p_from date, p_to date)
RETURNS TABLE(currency_code text, source_type text, gross_in numeric, gross_out numeric, reversal_in numeric, reversal_out numeric,
  base_gross_in numeric, base_gross_out numeric, base_reversal_in numeric, base_reversal_out numeric, movement_count bigint, reversal_count bigint)
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $flows$
  SELECT m.currency, m.effective,
         COALESCE(sum(greatest(m.amount, 0)) FILTER (WHERE NOT m.reversal), 0), COALESCE(sum(greatest(-m.amount, 0)) FILTER (WHERE NOT m.reversal), 0),
         COALESCE(sum(greatest(m.amount, 0)) FILTER (WHERE m.reversal), 0), COALESCE(sum(greatest(-m.amount, 0)) FILTER (WHERE m.reversal), 0),
         COALESCE(sum(greatest(m.base, 0)) FILTER (WHERE NOT m.reversal), 0), COALESCE(sum(greatest(-m.base, 0)) FILTER (WHERE NOT m.reversal), 0),
         COALESCE(sum(greatest(m.base, 0)) FILTER (WHERE m.reversal), 0), COALESCE(sum(greatest(-m.base, 0)) FILTER (WHERE m.reversal), 0),
         count(*) FILTER (WHERE NOT m.reversal), count(*) FILTER (WHERE m.reversal)
    FROM (SELECT entry.original_currency_code AS currency, entry.original_amount AS amount, entry.base_amount AS base,
                 intent.source_type = 'REVERSAL' AS reversal,
                 COALESCE(original_intent.source_type, intent.source_type) AS effective
            FROM abos.subledger_entries entry
            JOIN abos.journal_lines line ON line.id = entry.journal_line_id
            JOIN abos.journals journal ON journal.id = line.journal_id AND journal.status = 'POSTED'
            JOIN abos.posting_intents intent ON intent.id = journal.posting_intent_id
            LEFT JOIN abos.journal_reversal_links link ON link.reversal_journal_id = journal.id
            LEFT JOIN abos.journals original ON original.id = link.original_journal_id
            LEFT JOIN abos.posting_intents original_intent ON original_intent.id = original.posting_intent_id
           WHERE entry.subledger_type = 'OPERATIONAL_TREASURY' AND entry.legal_entity_id = p_entity
             AND journal.accounting_effective_date BETWEEN p_from AND p_to) m
   GROUP BY m.currency, m.effective
$flows$;

-- Per party and currency, from the subledgers: CAPITAL is equity, LOAN is a liability. Both are credits, recorded negative by the
-- 0045 convention, so a figure here is minus the sum. No agreement, declaration or installment takes part.
CREATE FUNCTION abos.report_party_positions(p_entity uuid, p_from date, p_to date)
RETURNS TABLE(business_party_id uuid, position_kind text, currency_code text, opening numeric, received numeric, reversed numeric, repaid numeric, closing numeric,
  base_opening numeric, base_received numeric, base_reversed numeric, base_repaid numeric, base_closing numeric, movement_count bigint)
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $positions$
  SELECT m.party, m.kind, m.currency,
         COALESCE(-sum(m.amount) FILTER (WHERE m.day < p_from), 0),
         COALESCE(-sum(m.amount) FILTER (WHERE m.day >= p_from AND NOT m.reversal AND NOT m.repayment), 0),
         COALESCE(sum(m.amount) FILTER (WHERE m.day >= p_from AND m.reversal), 0),
         COALESCE(sum(m.amount) FILTER (WHERE m.day >= p_from AND m.repayment AND NOT m.reversal), 0),
         -sum(m.amount),
         COALESCE(-sum(m.base) FILTER (WHERE m.day < p_from), 0),
         COALESCE(-sum(m.base) FILTER (WHERE m.day >= p_from AND NOT m.reversal AND NOT m.repayment), 0),
         COALESCE(sum(m.base) FILTER (WHERE m.day >= p_from AND m.reversal), 0),
         COALESCE(sum(m.base) FILTER (WHERE m.day >= p_from AND m.repayment AND NOT m.reversal), 0),
         -sum(m.base),
         count(*) FILTER (WHERE m.day >= p_from)
    FROM (SELECT entry.business_party_id AS party, entry.original_currency_code AS currency, entry.original_amount AS amount, entry.base_amount AS base,
                 CASE entry.subledger_type WHEN 'SHAREHOLDER_CAPITAL' THEN 'CAPITAL' ELSE 'LOAN' END AS kind,
                 journal.accounting_effective_date AS day, intent.source_type = 'REVERSAL' AS reversal,
                 intent.source_type = 'TEMPORARY_FUNDING_SETTLEMENT' AS repayment
            FROM abos.subledger_entries entry
            JOIN abos.journal_lines line ON line.id = entry.journal_line_id
            JOIN abos.journals journal ON journal.id = line.journal_id AND journal.status = 'POSTED'
            JOIN abos.posting_intents intent ON intent.id = journal.posting_intent_id
           WHERE entry.subledger_type IN ('SHAREHOLDER_CAPITAL', 'SHAREHOLDER_LOAN', 'TEMPORARY_FUNDING_PAYABLE') AND entry.legal_entity_id = p_entity
             AND journal.accounting_effective_date <= p_to) m
   GROUP BY m.party, m.kind, m.currency
$positions$;

-- ---------------------------------------------------------------------------------------------
-- 2. The Financial Summary.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION abos.finance_management_summary(p_proof text, p_runtime text, p_token text, p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $summary$
DECLARE c jsonb; entity uuid; base text; range jsonb; v_from date; v_to date; figures jsonb; accounts jsonb; result record;
  ledger_closing numeric; treasury_closing numeric; flows_closing numeric;
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
      COALESCE(sum(m.gross_in - m.gross_out + m.reversal_in - m.reversal_out) FILTER (WHERE m.source_type = 'TEMPORARY_FUNDING'), 0) AS loans,
      COALESCE(sum(m.gross_in - m.gross_out + m.reversal_in - m.reversal_out) FILTER (WHERE m.source_type = 'CASH_RECEIPT'), 0) AS receipts,
      COALESCE(sum(m.gross_out - m.gross_in + m.reversal_out - m.reversal_in) FILTER (WHERE m.source_type = 'OPERATIONAL_EXPENSE'), 0) AS expenses,
      COALESCE(sum(m.gross_out - m.gross_in + m.reversal_out - m.reversal_in) FILTER (WHERE m.source_type = 'PAYMENT'), 0) AS payments,
      COALESCE(sum(m.gross_out - m.gross_in + m.reversal_out - m.reversal_in) FILTER (WHERE m.source_type = 'TEMPORARY_FUNDING_SETTLEMENT'), 0) AS repayments,
      COALESCE(sum(m.gross_in - m.gross_out + m.reversal_in - m.reversal_out) FILTER (WHERE m.source_type = 'OPENING_BALANCE'), 0) AS opening_balances,
      COALESCE(sum(m.gross_in - m.reversal_out) FILTER (WHERE m.source_type = 'TREASURY_TRANSFER'), 0) AS transfers_in,
      COALESCE(sum(m.gross_out - m.reversal_in) FILTER (WHERE m.source_type = 'TREASURY_TRANSFER'), 0) AS transfers_out,
      COALESCE(sum(m.gross_in - m.gross_out + m.reversal_in - m.reversal_out) FILTER (WHERE m.source_type NOT IN ('DIRECT_SHAREHOLDER_CAPITAL', 'TEMPORARY_FUNDING', 'CASH_RECEIPT',
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
  SELECT COALESCE(sum(b.opening_debit - b.opening_credit + b.period_debit - b.period_credit), 0) INTO ledger_closing
    FROM abos.report_account_balances(entity, v_from, v_to) b
   WHERE b.ledger_account_id IN (SELECT a.ledger_account_id FROM abos.operational_treasury_accounts a WHERE a.legal_entity_id = entity);
  treasury_closing := COALESCE((figures->'BASE'->>'closing')::numeric, 0);
  flows_closing := COALESCE((figures->'BASE'->>'flowsClosing')::numeric, 0);
  RETURN jsonb_build_object('legalEntityId', entity, 'baseCurrency', base, 'range', range, 'accounts', accounts,
    'base', figures->'BASE', 'currencies', (SELECT COALESCE(jsonb_object_agg(k, v), '{}'::jsonb) FROM jsonb_each(figures) e(k, v) WHERE k <> 'BASE'),
    'profit', jsonb_build_object('income', result.income::text, 'expenses', result.expense::text, 'netResult', result.net_result::text),
    'reconciliation', jsonb_build_object('treasuryClosing', treasury_closing::text, 'flowsClosing', flows_closing::text, 'ledgerClosing', ledger_closing::text,
      'matches', treasury_closing = flows_closing AND treasury_closing = ledger_closing));
END
$summary$;

-- ---------------------------------------------------------------------------------------------
-- 3. The Shareholder Statement.
-- ---------------------------------------------------------------------------------------------
-- Without partyId: company totals, and the people this reader may see. With it: one person's equity and debt, kept apart, with
-- every transaction. Capital detail needs a shareholder permission; loan detail needs the funding read permission. A report
-- reader gets company totals only, with nobody named.
CREATE FUNCTION abos.finance_shareholder_statement(p_proof text, p_runtime text, p_token text, p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $statement$
DECLARE c jsonb; entity uuid; actor uuid; perms jsonb; base text; can_capital boolean; can_loans boolean; can_report boolean; can_safes boolean;
  range jsonb; v_from date; v_to date; party_id uuid; positions jsonb; totals jsonb; people jsonb; capital jsonb; loans jsonb; movements jsonb; party record;
  profile_id uuid; capital_ledger numeric; loan_ledger numeric; capital_base numeric; loan_base numeric; line_count bigint; reconciliation jsonb;
BEGIN
  c := abos.treasury_safe_actor(p_proof, p_runtime, p_token, NULL);
  entity := (c->>'legalEntityId')::uuid; actor := (c->>'userAccountId')::uuid; perms := COALESCE(c->'permissions', '[]'::jsonb);
  can_capital := perms ?| ARRAY['shareholder.read', 'shareholder.capital-receipt.read'];
  can_loans := perms ? 'finance.temporary-funding.read';
  can_report := perms ? 'finance.report.operational.read';
  can_safes := perms ?| ARRAY['treasury.safe.read', 'finance.report.operational.read'];
  IF NOT (can_capital OR can_loans OR can_report) THEN
    RAISE EXCEPTION 'current authority is missing shareholder.read' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_payload) k
       WHERE k NOT IN ('partyId', 'periodId', 'from', 'to', 'asOf', 'fiscalYearId')) THEN
    RAISE EXCEPTION 'unknown report fields' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  BEGIN
    party_id := NULLIF(p_payload->>'partyId', '')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'choose a valid shareholder' USING ERRCODE = 'invalid_parameter_value';
  END;
  SELECT base_currency_code INTO base FROM abos.legal_entities WHERE id = entity;
  range := abos.report_range(entity, p_payload - 'partyId');
  v_from := (range->>'from')::date; v_to := (range->>'to')::date;
  positions := COALESCE((SELECT jsonb_agg(to_jsonb(p)) FROM abos.report_party_positions(entity, v_from, v_to) p), '[]'::jsonb);

  -- Company totals: arithmetic with no person in it.
  totals := jsonb_build_object(
    'capital', CASE WHEN can_capital OR can_report THEN COALESCE((SELECT jsonb_agg(jsonb_build_object('currency', t.currency, 'opening', t.opening::text, 'received', t.received::text,
        'reversed', t.reversed::text, 'effective', t.closing::text, 'baseEffective', t.base_closing::text) ORDER BY t.currency)
      FROM (SELECT p->>'currency_code' AS currency, sum((p->>'opening')::numeric) AS opening, sum((p->>'received')::numeric) AS received, sum((p->>'reversed')::numeric) AS reversed,
                   sum((p->>'closing')::numeric) AS closing, sum((p->>'base_closing')::numeric) AS base_closing
              FROM jsonb_array_elements(positions) p WHERE p->>'position_kind' = 'CAPITAL' GROUP BY 1) t), '[]'::jsonb) END,
    'loans', CASE WHEN can_loans OR can_report THEN COALESCE((SELECT jsonb_agg(jsonb_build_object('currency', t.currency, 'opening', t.opening::text, 'received', t.received::text,
        'repaid', t.repaid::text, 'outstanding', t.closing::text, 'baseOutstanding', t.base_closing::text) ORDER BY t.currency)
      FROM (SELECT p->>'currency_code' AS currency, sum((p->>'opening')::numeric) AS opening, sum((p->>'received')::numeric) AS received, sum((p->>'repaid')::numeric) AS repaid,
                   sum((p->>'closing')::numeric) AS closing, sum((p->>'base_closing')::numeric) AS base_closing
              FROM jsonb_array_elements(positions) p WHERE p->>'position_kind' = 'LOAN' GROUP BY 1) t), '[]'::jsonb) END);

  -- Equity and debt each against their ledger accounts.
  capital_base := COALESCE((SELECT sum((p->>'base_closing')::numeric) FROM jsonb_array_elements(positions) p WHERE p->>'position_kind' = 'CAPITAL'), 0);
  loan_base := COALESCE((SELECT sum((p->>'base_closing')::numeric) FROM jsonb_array_elements(positions) p WHERE p->>'position_kind' = 'LOAN'), 0);
  SELECT COALESCE(sum(b.opening_credit - b.opening_debit + b.period_credit - b.period_debit) FILTER (WHERE a.control_account_type = 'SHAREHOLDER_CAPITAL'), 0),
         COALESCE(sum(b.opening_credit - b.opening_debit + b.period_credit - b.period_debit) FILTER (WHERE a.control_account_type IN ('TEMPORARY_FUNDING_PAYABLE', 'SHAREHOLDER_LOAN')), 0)
    INTO capital_ledger, loan_ledger
    FROM abos.report_account_balances(entity, v_from, v_to) b JOIN abos.ledger_accounts a ON a.id = b.ledger_account_id AND a.legal_entity_id = entity;
  reconciliation := jsonb_build_object(
    'capital', CASE WHEN can_capital OR can_report THEN jsonb_build_object('subledgerBase', capital_base::text, 'ledgerBase', capital_ledger::text, 'matches', capital_base = capital_ledger) END,
    'loans', CASE WHEN can_loans OR can_report THEN jsonb_build_object('subledgerBase', loan_base::text, 'ledgerBase', loan_ledger::text, 'matches', loan_base = loan_ledger) END);

  -- The people this reader may see: shareholders for a capital reader, those with a loan for a loan reader.
  people := COALESCE((SELECT jsonb_agg(jsonb_build_object('partyId', x.id, 'name', x.display_name, 'isShareholder', x.profile_id IS NOT NULL,
      'capital', CASE WHEN can_capital THEN COALESCE((SELECT jsonb_agg(jsonb_build_object('currency', p->>'currency_code', 'effective', p->>'closing', 'baseEffective', p->>'base_closing'))
          FROM jsonb_array_elements(positions) p WHERE p->>'position_kind' = 'CAPITAL' AND p->>'business_party_id' = x.id::text), '[]'::jsonb) END,
      'loans', CASE WHEN can_loans THEN COALESCE((SELECT jsonb_agg(jsonb_build_object('currency', p->>'currency_code', 'outstanding', p->>'closing', 'baseOutstanding', p->>'base_closing'))
          FROM jsonb_array_elements(positions) p WHERE p->>'position_kind' = 'LOAN' AND p->>'business_party_id' = x.id::text), '[]'::jsonb) END)
      ORDER BY x.display_name, x.id)
    FROM (SELECT b.id, b.display_name, (SELECT s.id FROM abos.shareholder_profiles s WHERE s.business_party_id = b.id AND s.legal_entity_id = entity LIMIT 1) AS profile_id
            FROM abos.business_parties b
           WHERE b.legal_entity_id = entity
             AND ((can_capital AND EXISTS (SELECT 1 FROM abos.shareholder_profiles s WHERE s.business_party_id = b.id AND s.legal_entity_id = entity))
               OR (can_loans AND EXISTS (SELECT 1 FROM jsonb_array_elements(positions) p WHERE p->>'position_kind' = 'LOAN' AND p->>'business_party_id' = b.id::text)))) x), '[]'::jsonb);

  IF party_id IS NULL THEN
    RETURN jsonb_build_object('legalEntityId', entity, 'baseCurrency', base, 'range', range, 'canReadCapital', can_capital, 'canReadLoans', can_loans,
      'totals', totals, 'people', people, 'reconciliation', reconciliation, 'statement', NULL);
  END IF;
  -- Someone this reader may not see is reported exactly like someone who does not exist.
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(people) p WHERE p->>'partyId' = party_id::text) THEN
    RAISE EXCEPTION 'the shareholder was not found in this legal entity' USING ERRCODE = 'no_data_found';
  END IF;
  SELECT id, display_name INTO party FROM abos.business_parties WHERE id = party_id AND legal_entity_id = entity;
  SELECT id INTO profile_id FROM abos.shareholder_profiles WHERE business_party_id = party_id AND legal_entity_id = entity LIMIT 1;

  -- Equity. The agreed figure is what was declared, shown as information only: it never decides a balance.
  capital := CASE WHEN can_capital THEN COALESCE((SELECT jsonb_agg(jsonb_build_object('currency', u.currency, 'agreed', u.agreed::text, 'opening', COALESCE(u.opening, 0)::text,
      'received', COALESCE(u.received, 0)::text, 'reversed', COALESCE(u.reversed, 0)::text, 'effective', COALESCE(u.closing, 0)::text, 'baseEffective', COALESCE(u.base_closing, 0)::text,
      'outstanding', CASE WHEN u.agreed IS NOT NULL THEN (u.agreed - COALESCE(u.closing, 0))::text END) ORDER BY u.currency)
    FROM (SELECT COALESCE(posted.currency, declared.currency) AS currency, declared.agreed, posted.opening, posted.received, posted.reversed, posted.closing, posted.base_closing
            FROM (SELECT p->>'currency_code' AS currency, (p->>'opening')::numeric AS opening, (p->>'received')::numeric AS received, (p->>'reversed')::numeric AS reversed,
                         (p->>'closing')::numeric AS closing, (p->>'base_closing')::numeric AS base_closing
                    FROM jsonb_array_elements(positions) p WHERE p->>'position_kind' = 'CAPITAL' AND p->>'business_party_id' = party_id::text) posted
            FULL JOIN (SELECT d.currency_code AS currency, sum(d.amount) AS agreed FROM abos.shareholder_contributions d
                        WHERE d.shareholder_profile_id = profile_id AND d.legal_entity_id = entity AND d.contribution_type = 'CASH' AND d.record_status = 'DECLARED'
                        GROUP BY d.currency_code) declared ON declared.currency = posted.currency) u), '[]'::jsonb) END;
  -- Debt.
  loans := CASE WHEN can_loans THEN COALESCE((SELECT jsonb_agg(jsonb_build_object('currency', p->>'currency_code', 'opening', p->>'opening', 'received', p->>'received', 'repaid', p->>'repaid',
      'outstanding', p->>'closing', 'baseOutstanding', p->>'base_closing') ORDER BY p->>'currency_code')
    FROM jsonb_array_elements(positions) p WHERE p->>'position_kind' = 'LOAN' AND p->>'business_party_id' = party_id::text), '[]'::jsonb) END;

  SELECT count(*) INTO line_count FROM abos.subledger_entries entry
    JOIN abos.journal_lines line ON line.id = entry.journal_line_id
    JOIN abos.journals journal ON journal.id = line.journal_id AND journal.status = 'POSTED'
   WHERE entry.legal_entity_id = entity AND entry.business_party_id = party_id AND entry.subledger_type IN ('SHAREHOLDER_CAPITAL', 'SHAREHOLDER_LOAN', 'TEMPORARY_FUNDING_PAYABLE')
     AND journal.accounting_effective_date BETWEEN v_from AND v_to;
  IF line_count > 5000 THEN
    RAISE EXCEPTION 'this statement has % lines; choose a shorter period', line_count USING ERRCODE = 'program_limit_exceeded';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', x.entry_id, 'date', x.effective_date, 'kind', x.kind, 'section', x.section, 'amount', abs(x.amount)::text, 'effect', (-x.amount)::text,
      'balance', (x.opening_balance - x.running)::text, 'currency', x.currency, 'baseAmount', abs(x.base_amount)::text, 'restricted', NOT x.visible,
      'source', abos.report_journal_source(entity, x.journal_id, perms, x.visible),
      'journalId', CASE WHEN x.visible AND can_report THEN x.journal_id END,
      'journalReference', CASE WHEN x.visible THEN abos.report_journal_reference(x.journal_id, perms) END,
      'safe', CASE WHEN x.visible AND can_safes THEN (SELECT jsonb_build_object('id', t.id, 'nameEn', t.name_en, 'nameFa', t.name_fa)
          FROM abos.subledger_entries te JOIN abos.journal_lines tl ON tl.id = te.journal_line_id
          JOIN abos.operational_treasury_accounts t ON t.id = te.operational_treasury_account_id
         WHERE tl.journal_id = x.journal_id AND te.subledger_type = 'OPERATIONAL_TREASURY' AND te.legal_entity_id = entity LIMIT 1) END,
      'reversedBy', CASE WHEN x.visible THEN (SELECT jsonb_build_object('journalId', CASE WHEN can_report THEN l.reversal_journal_id END,
          'reference', abos.report_journal_reference(l.reversal_journal_id, perms), 'date', r.accounting_effective_date)
        FROM abos.journal_reversal_links l JOIN abos.journals r ON r.id = l.reversal_journal_id WHERE l.original_journal_id = x.journal_id) END,
      'reverses', CASE WHEN x.visible THEN (SELECT jsonb_build_object('journalId', CASE WHEN can_report THEN l.original_journal_id END,
          'reference', abos.report_journal_reference(l.original_journal_id, perms), 'date', o.accounting_effective_date)
        FROM abos.journal_reversal_links l JOIN abos.journals o ON o.id = l.original_journal_id WHERE l.reversal_journal_id = x.journal_id) END)
      ORDER BY x.effective_date, x.posted_at, x.journal_id, x.line_number), '[]'::jsonb)
    INTO movements
    FROM (SELECT y.*, COALESCE((SELECT (p->>'opening')::numeric FROM jsonb_array_elements(positions) p
              WHERE p->>'business_party_id' = party_id::text AND p->>'position_kind' = y.section AND p->>'currency_code' = y.currency), 0) AS opening_balance,
                 sum(y.amount) OVER (PARTITION BY y.section, y.currency ORDER BY y.effective_date, y.posted_at, y.journal_id, y.line_number
                   ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running
            FROM (SELECT entry.id AS entry_id, journal.id AS journal_id, line.line_number, journal.accounting_effective_date AS effective_date, journal.posted_at,
                         entry.original_amount AS amount, entry.base_amount, entry.original_currency_code AS currency,
                         CASE entry.subledger_type WHEN 'SHAREHOLDER_CAPITAL' THEN 'CAPITAL' ELSE 'LOAN' END AS section,
                         CASE WHEN entry.subledger_type = 'SHAREHOLDER_CAPITAL' THEN CASE WHEN intent.source_type = 'REVERSAL' THEN 'CAPITAL_REVERSAL' ELSE 'CAPITAL_RECEIVED' END
                              WHEN intent.source_type = 'TEMPORARY_FUNDING_SETTLEMENT' THEN 'LOAN_REPAID'
                              WHEN intent.source_type = 'REVERSAL' THEN 'LOAN_REVERSAL' ELSE 'LOAN_RECEIVED' END AS kind,
                         abos.report_line_visible(entity, actor, line.project_id, line.department_id, line.cost_center_id) AS visible
                    FROM abos.subledger_entries entry
                    JOIN abos.journal_lines line ON line.id = entry.journal_line_id
                    JOIN abos.journals journal ON journal.id = line.journal_id AND journal.status = 'POSTED'
                    JOIN abos.posting_intents intent ON intent.id = journal.posting_intent_id
                   WHERE entry.legal_entity_id = entity AND entry.business_party_id = party_id
                     AND entry.subledger_type IN ('SHAREHOLDER_CAPITAL', 'SHAREHOLDER_LOAN', 'TEMPORARY_FUNDING_PAYABLE')
                     AND journal.accounting_effective_date BETWEEN v_from AND v_to) y
           WHERE (y.section = 'CAPITAL' AND can_capital) OR (y.section = 'LOAN' AND can_loans)) x;

  RETURN jsonb_build_object('legalEntityId', entity, 'baseCurrency', base, 'range', range, 'canReadCapital', can_capital, 'canReadLoans', can_loans,
    'totals', totals, 'people', people, 'reconciliation', reconciliation,
    'statement', jsonb_build_object('party', jsonb_build_object('id', party.id, 'name', party.display_name, 'shareholderProfileId', CASE WHEN can_capital THEN profile_id END),
      'capital', capital, 'loans', loans, 'transactions', movements, 'canOpenLedger', can_report));
END
$statement$;

-- ---------------------------------------------------------------------------------------------
-- 4. Ownership and grants: the primitives run only inside the owner's report functions.
-- ---------------------------------------------------------------------------------------------
REVOKE ALL ON FUNCTION abos.report_income_result(uuid, date, date), abos.report_treasury_flows(uuid, date, date), abos.report_party_positions(uuid, date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION abos.report_income_result(uuid, date, date), abos.report_treasury_flows(uuid, date, date), abos.report_party_positions(uuid, date, date)
  TO abos_v1_operational_finance_owner;

ALTER FUNCTION abos.finance_management_summary(text, text, text, jsonb) OWNER TO abos_v1_operational_finance_owner;
ALTER FUNCTION abos.finance_shareholder_statement(text, text, text, jsonb) OWNER TO abos_v1_operational_finance_owner;
REVOKE ALL ON FUNCTION abos.finance_management_summary(text, text, text, jsonb), abos.finance_shareholder_statement(text, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION abos.finance_management_summary(text, text, text, jsonb), abos.finance_shareholder_statement(text, text, text, jsonb) TO abos_e1_runtime;
