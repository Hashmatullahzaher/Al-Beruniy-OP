-- 0062: loans in the reports, and the loan read models.
--
-- Every existing report already derives from posted journals, so loan money reaches the Trial Balance, General Ledger and Income
-- Statement with no change. Those that name kinds of funding are taught the two loan sources here. Each restated function is its applied
-- definition with only the loan lines added.
--
-- Lender identity, references, notes and links need finance.loan.read. Amounts, dates and generic labels do not. A reversal follows the
-- source it reverses, through 0060.
--
-- No table, no row, no journal.

CREATE OR REPLACE FUNCTION abos.report_source_readable(p_source_type text, p_permissions jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $readable$
  SELECT CASE
    WHEN p_source_type = 'DIRECT_SHAREHOLDER_CAPITAL' THEN p_permissions ?| ARRAY['shareholder.read', 'shareholder.capital-receipt.read']
    WHEN p_source_type IN ('TEMPORARY_FUNDING', 'TEMPORARY_FUNDING_SETTLEMENT') THEN p_permissions ? 'finance.temporary-funding.read'
    WHEN p_source_type = 'OPERATIONAL_EXPENSE' THEN p_permissions ? 'finance.expense.read'
    WHEN p_source_type IN ('LOAN_RECEIPT', 'LOAN_REPAYMENT') THEN p_permissions ?| ARRAY['finance.loan.read', 'finance.temporary-funding.read']
    WHEN p_source_type IN ('CASH_RECEIPT', 'PAYMENT', 'TREASURY_TRANSFER', 'OPENING_BALANCE') THEN p_permissions ? 'treasury.safe.read'
    ELSE false END
$readable$;

CREATE OR REPLACE FUNCTION abos.report_journal_source(p_entity uuid, p_journal uuid, p_permissions jsonb, p_visible boolean)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $source$
DECLARE intent abos.posting_intents%ROWTYPE; label jsonb; route text; party text; readable boolean; detail jsonb; business_reference text; business_description text;
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
    WHEN 'LOAN_RECEIPT' THEN jsonb_build_object('en', 'Loan received', 'fa', 'قرض دریافت‌شده')
    WHEN 'LOAN_REPAYMENT' THEN jsonb_build_object('en', 'Loan repaid', 'fa', 'بازپرداخت قرض')
    WHEN 'REVERSAL' THEN jsonb_build_object('en', 'Reversal', 'fa', 'برگشت')
    ELSE jsonb_build_object('en', 'Other posting', 'fa', 'ثبت دیگر') END;
  route := CASE intent.source_type
    WHEN 'CASH_RECEIPT' THEN '/finance/safes' WHEN 'PAYMENT' THEN '/finance/safes' WHEN 'TREASURY_TRANSFER' THEN '/finance/safes'
    WHEN 'OPENING_BALANCE' THEN '/finance/safes' WHEN 'OPERATIONAL_EXPENSE' THEN '/finance/transactions'
    WHEN 'DIRECT_SHAREHOLDER_CAPITAL' THEN '/shareholders' WHEN 'TEMPORARY_FUNDING' THEN '/finance/temporary-funding'
    WHEN 'TEMPORARY_FUNDING_SETTLEMENT' THEN '/finance/temporary-funding' WHEN 'REVERSAL' THEN '/finance/reversals'
    WHEN 'LOAN_RECEIPT' THEN '/finance/loans' WHEN 'LOAN_REPAYMENT' THEN '/finance/loans' END;
  IF NOT p_visible THEN
    RETURN jsonb_build_object('type', 'RESTRICTED', 'label', jsonb_build_object('en', 'Restricted movement', 'fa', 'حرکت محدود'),
      'id', NULL, 'route', NULL, 'counterparty', NULL);
  END IF;
  readable := abos.report_source_readable(abos.report_effective_source_type(p_journal), p_permissions);
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
      WHEN 'LOAN_RECEIPT' THEN (SELECT b.display_name FROM abos.loans l JOIN abos.business_parties b ON b.id = l.lender_business_party_id WHERE l.id = intent.source_id)
      WHEN 'LOAN_REPAYMENT' THEN (SELECT b.display_name FROM abos.loan_repayments r JOIN abos.loans l ON l.id = r.loan_id JOIN abos.business_parties b ON b.id = l.lender_business_party_id WHERE r.id = intent.source_id)
      WHEN 'TEMPORARY_FUNDING' THEN (SELECT b.display_name FROM abos.subledger_entries s JOIN abos.business_parties b ON b.id = s.business_party_id
        WHERE s.source_id = intent.source_id AND s.subledger_type = 'TEMPORARY_FUNDING_PAYABLE' LIMIT 1)
      WHEN 'TEMPORARY_FUNDING_SETTLEMENT' THEN (SELECT b.display_name FROM abos.subledger_entries s JOIN abos.business_parties b ON b.id = s.business_party_id
        WHERE s.source_id = intent.source_id AND s.subledger_type = 'TEMPORARY_FUNDING_PAYABLE' LIMIT 1)
      END;
    -- What the people recording it wrote: the business reference and description, for a reader of that module only.
    CASE intent.source_type
      WHEN 'CASH_RECEIPT' THEN SELECT r.reference, r.note INTO business_reference, business_description FROM abos.treasury_cash_receipts r WHERE r.id = intent.source_id;
      WHEN 'PAYMENT' THEN SELECT p.reference, p.note INTO business_reference, business_description FROM abos.treasury_payments p WHERE p.id = intent.source_id;
      WHEN 'TREASURY_TRANSFER' THEN SELECT t.reference, t.note INTO business_reference, business_description FROM abos.treasury_transfers t WHERE t.id = intent.source_id;
      WHEN 'OPENING_BALANCE' THEN SELECT o.reference, o.note INTO business_reference, business_description FROM abos.treasury_opening_balances o WHERE o.id = intent.source_id;
      WHEN 'OPERATIONAL_EXPENSE' THEN SELECT e.reference, e.description INTO business_reference, business_description FROM abos.operational_expenses e WHERE e.id = intent.source_id;
      WHEN 'DIRECT_SHAREHOLDER_CAPITAL' THEN SELECT d.payment_reference, d.note INTO business_reference, business_description FROM abos.direct_capital_receipts d WHERE d.id = intent.source_id;
      WHEN 'LOAN_RECEIPT' THEN SELECT l.reference, l.note INTO business_reference, business_description FROM abos.loans l WHERE l.id = intent.source_id;
      WHEN 'LOAN_REPAYMENT' THEN SELECT r.reference, r.note INTO business_reference, business_description FROM abos.loan_repayments r WHERE r.id = intent.source_id;
      WHEN 'TEMPORARY_FUNDING' THEN SELECT f.reference, f.description INTO business_reference, business_description FROM abos.temporary_fundings f WHERE f.id = intent.source_id;
      WHEN 'TEMPORARY_FUNDING_SETTLEMENT' THEN SELECT s.reference, s.note INTO business_reference, business_description FROM abos.temporary_funding_settlements s WHERE s.id = intent.source_id;
      ELSE NULL;
    END CASE;
    -- 0055: the capital link opens that shareholder's record.
    IF intent.source_type = 'DIRECT_SHAREHOLDER_CAPITAL' THEN
      route := COALESCE((SELECT '/shareholders?shareholder=' || r.shareholder_profile_id FROM abos.direct_capital_receipts r
        WHERE r.id = intent.source_id AND r.legal_entity_id = p_entity), route);
    END IF;
    -- 0062: a loan link opens that loan.
    IF intent.source_type = 'LOAN_RECEIPT' THEN route := '/finance/loans?loanId=' || intent.source_id; END IF;
    IF intent.source_type = 'LOAN_REPAYMENT' THEN
      route := COALESCE((SELECT '/finance/loans?loanId=' || r.loan_id FROM abos.loan_repayments r WHERE r.id = intent.source_id), route);
    END IF;
    -- 0055: an expense names its receipt reference and expense type ("EXP-001 — Office supplies").
    IF intent.source_type = 'OPERATIONAL_EXPENSE' THEN
      SELECT jsonb_build_object('en', e.reference || ' — ' || c.name_en, 'fa', e.reference || ' — ' || COALESCE(NULLIF(c.name_fa, ''), c.name_en))
        INTO detail FROM abos.operational_expenses e JOIN abos.operational_expense_categories c ON c.id = e.operational_expense_category_id
       WHERE e.id = intent.source_id AND e.legal_entity_id = p_entity;
    END IF;
  END IF;
  RETURN jsonb_build_object('type', intent.source_type, 'id', CASE WHEN readable THEN intent.source_id END, 'label', label,
    'route', CASE WHEN readable THEN route END, 'counterparty', party, 'detailRestricted', NOT readable, 'detail', detail,
    'reference', business_reference, 'description', business_description);
END
$source$;

CREATE OR REPLACE FUNCTION abos.report_party_positions(p_entity uuid, p_from date, p_to date)
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
                 intent.source_type IN ('TEMPORARY_FUNDING_SETTLEMENT', 'LOAN_REPAYMENT') AS repayment
            FROM abos.subledger_entries entry
            JOIN abos.journal_lines line ON line.id = entry.journal_line_id
            JOIN abos.journals journal ON journal.id = line.journal_id AND journal.status = 'POSTED'
            JOIN abos.posting_intents intent ON intent.id = journal.posting_intent_id
           WHERE entry.subledger_type IN ('SHAREHOLDER_CAPITAL', 'SHAREHOLDER_LOAN', 'TEMPORARY_FUNDING_PAYABLE', 'LOAN_PAYABLE') AND entry.legal_entity_id = p_entity
             AND journal.accounting_effective_date <= p_to) m
   GROUP BY m.party, m.kind, m.currency
$positions$;

CREATE OR REPLACE FUNCTION abos.finance_management_summary(p_proof text, p_runtime text, p_token text, p_payload jsonb)
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

CREATE OR REPLACE FUNCTION abos.finance_shareholder_statement(p_proof text, p_runtime text, p_token text, p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $statement$
DECLARE c jsonb; entity uuid; actor uuid; perms jsonb; base text; can_capital boolean; can_loans boolean; can_report boolean; can_safes boolean;
  range jsonb; v_from date; v_to date; party_id uuid; positions jsonb; totals jsonb; people jsonb; capital jsonb; loans jsonb; movements jsonb; party record;
  profile_id uuid; capital_ledger numeric; loan_ledger numeric; capital_base numeric; loan_base numeric; line_count bigint; reconciliation jsonb;
BEGIN
  c := abos.treasury_safe_actor(p_proof, p_runtime, p_token, NULL);
  entity := (c->>'legalEntityId')::uuid; actor := (c->>'userAccountId')::uuid; perms := COALESCE(c->'permissions', '[]'::jsonb);
  can_capital := perms ?| ARRAY['shareholder.read', 'shareholder.capital-receipt.read'];
  can_loans := perms ?| ARRAY['finance.loan.read', 'finance.temporary-funding.read'];
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
         COALESCE(sum(b.opening_credit - b.opening_debit + b.period_credit - b.period_debit) FILTER (WHERE a.control_account_type IN ('TEMPORARY_FUNDING_PAYABLE', 'SHAREHOLDER_LOAN', 'LOAN_PAYABLE')), 0)
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
   WHERE entry.legal_entity_id = entity AND entry.business_party_id = party_id AND entry.subledger_type IN ('SHAREHOLDER_CAPITAL', 'SHAREHOLDER_LOAN', 'TEMPORARY_FUNDING_PAYABLE', 'LOAN_PAYABLE')
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
                              WHEN intent.source_type IN ('TEMPORARY_FUNDING_SETTLEMENT', 'LOAN_REPAYMENT') THEN 'LOAN_REPAID'
                              WHEN intent.source_type = 'REVERSAL' THEN 'LOAN_REVERSAL' ELSE 'LOAN_RECEIVED' END AS kind,
                         abos.report_line_visible(entity, actor, line.project_id, line.department_id, line.cost_center_id) AS visible
                    FROM abos.subledger_entries entry
                    JOIN abos.journal_lines line ON line.id = entry.journal_line_id
                    JOIN abos.journals journal ON journal.id = line.journal_id AND journal.status = 'POSTED'
                    JOIN abos.posting_intents intent ON intent.id = journal.posting_intent_id
                   WHERE entry.legal_entity_id = entity AND entry.business_party_id = party_id
                     AND entry.subledger_type IN ('SHAREHOLDER_CAPITAL', 'SHAREHOLDER_LOAN', 'TEMPORARY_FUNDING_PAYABLE', 'LOAN_PAYABLE')
                     AND journal.accounting_effective_date BETWEEN v_from AND v_to) y
           WHERE (y.section = 'CAPITAL' AND can_capital) OR (y.section = 'LOAN' AND can_loans)) x;

  RETURN jsonb_build_object('legalEntityId', entity, 'baseCurrency', base, 'range', range, 'canReadCapital', can_capital, 'canReadLoans', can_loans,
    'totals', totals, 'people', people, 'reconciliation', reconciliation,
    'statement', jsonb_build_object('party', jsonb_build_object('id', party.id, 'name', party.display_name, 'shareholderProfileId', CASE WHEN can_capital THEN profile_id END),
      'capital', capital, 'loans', loans, 'transactions', movements, 'canOpenLedger', can_report));
END
$statement$;

CREATE OR REPLACE FUNCTION abos.finance_balance_sheet(p_proof text, p_runtime text, p_token text, p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $sheet$
DECLARE c jsonb; entity uuid; base text; range jsonb; v_to date; year_start date; accounts jsonb; assets numeric; liabilities numeric; equity_accounts numeric;
  earlier_result numeric; current_result numeric; equity numeric; treasury_ledger numeric; treasury_base numeric; unbalanced bigint; reclassified numeric;
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
  -- Each account's natural-side balance at the date. Money stays in its class, even when a balance is negative, with one exception:
  -- a negative ASSET-type Saraf is presented as a liability. amount is what the statement shows; bookAmount is what the ledger holds.
  SELECT COALESCE(jsonb_agg(jsonb_build_object('accountId', x.ledger_account_id, 'code', x.account_code, 'name', x.account_name, 'class', x.account_type, 'control', x.control_account_type,
      'status', x.status, 'parent', CASE WHEN x.parent_id IS NOT NULL THEN jsonb_build_object('id', x.parent_id, 'code', x.parent_code, 'name', x.parent_name) END,
      'group', CASE
        WHEN x.account_type = 'ASSET' AND x.control_account_type = 'SARAF' AND x.closing_net < 0 THEN 'SARAF_PAYABLE'
        WHEN x.account_type = 'ASSET' AND x.control_account_type IN ('CASH', 'SARAF') THEN 'TREASURY'
        WHEN x.account_type = 'ASSET' THEN 'OTHER_ASSETS'
        WHEN x.account_type = 'LIABILITY' AND x.control_account_type IN ('TEMPORARY_FUNDING_PAYABLE', 'SHAREHOLDER_LOAN', 'LOAN_PAYABLE') THEN 'LOANS'
        WHEN x.account_type = 'LIABILITY' AND x.control_account_type = 'AP' THEN 'PAYABLES'
        WHEN x.account_type = 'LIABILITY' THEN 'OTHER_LIABILITIES'
        WHEN x.control_account_type = 'SHAREHOLDER_CAPITAL' THEN 'SHAREHOLDER_CAPITAL'
        WHEN x.control_account_type = 'OPENING_BALANCE_EQUITY' THEN 'OPENING_BALANCE_EQUITY'
        ELSE 'OTHER_EQUITY' END,
      'amount', (CASE WHEN x.account_type = 'ASSET' AND x.control_account_type = 'SARAF' AND x.closing_net < 0 THEN -x.closing_net WHEN x.account_type = 'ASSET' THEN x.closing_net ELSE -x.closing_net END)::text,
      'bookAmount', (CASE WHEN x.account_type = 'ASSET' THEN x.closing_net ELSE -x.closing_net END)::text,
      'reclassified', x.account_type = 'ASSET' AND x.control_account_type = 'SARAF' AND x.closing_net < 0)
      ORDER BY x.account_code, x.ledger_account_id), '[]'::jsonb)
    INTO accounts FROM abos.report_classified_accounts(entity, year_start, v_to) x
   WHERE x.account_type IN ('ASSET', 'LIABILITY', 'EQUITY') AND (x.closing_net <> 0 OR x.control_account_type = 'OPENING_BALANCE_EQUITY');
  SELECT COALESCE(sum(x.closing_net) FILTER (WHERE x.account_type = 'ASSET'), 0), COALESCE(-sum(x.closing_net) FILTER (WHERE x.account_type = 'LIABILITY'), 0),
         COALESCE(-sum(x.closing_net) FILTER (WHERE x.account_type = 'EQUITY'), 0), COALESCE(-sum(x.opening_net) FILTER (WHERE x.account_type IN ('REVENUE', 'EXPENSE')), 0),
         COALESCE(-sum(x.closing_net) FILTER (WHERE x.account_type = 'ASSET' AND x.control_account_type = 'SARAF' AND x.closing_net < 0), 0)
    INTO assets, liabilities, equity_accounts, earlier_result, reclassified FROM abos.report_classified_accounts(entity, year_start, v_to) x;
  -- Both sides rise by the same amount, so the reclassification cannot change the difference or equity.
  assets := assets + reclassified;
  liabilities := liabilities + reclassified;
  SELECT net_result INTO current_result FROM abos.report_income_result(entity, year_start, v_to);
  equity := equity_accounts + earlier_result + current_result;
  SELECT COALESCE(sum(abos.treasury_account_base_balance(entity, v_to, a.id)), 0) INTO treasury_base FROM abos.operational_treasury_accounts a WHERE a.legal_entity_id = entity;
  SELECT COALESCE(sum(x.closing_net), 0) INTO treasury_ledger FROM abos.report_classified_accounts(entity, year_start, v_to) x
   WHERE x.ledger_account_id IN (SELECT a.ledger_account_id FROM abos.operational_treasury_accounts a WHERE a.legal_entity_id = entity);
  SELECT count(*) INTO unbalanced FROM (SELECT line.journal_id FROM abos.journal_lines line JOIN abos.journals journal ON journal.id = line.journal_id AND journal.status = 'POSTED'
    WHERE line.legal_entity_id = entity AND journal.accounting_effective_date <= v_to GROUP BY line.journal_id HAVING sum(line.base_debit) <> sum(line.base_credit)) x;
  RETURN jsonb_build_object('legalEntityId', entity, 'baseCurrency', base, 'range', range, 'asOf', v_to, 'yearStart', year_start, 'accounts', accounts,
    'totalAssets', assets::text, 'totalLiabilities', liabilities::text, 'reclassifiedSaraf', reclassified::text, 'equityAccounts', equity_accounts::text,
    -- Derived for presentation: no retained earnings journal exists. Earlier years' result is everything before this financial year.
    'earlierYearsResult', earlier_result::text, 'currentYearResult', current_result::text, 'totalEquity', equity::text, 'totalLiabilitiesAndEquity', (liabilities + equity)::text,
    'validation', jsonb_build_object('difference', (assets - liabilities - equity)::text, 'balanced', assets = liabilities + equity AND unbalanced = 0, 'unbalancedJournals', unbalanced),
    'treasury', jsonb_build_object('treasuryBase', treasury_base::text, 'ledgerBase', treasury_ledger::text, 'matches', treasury_base = treasury_ledger));
END
$sheet$;

CREATE OR REPLACE FUNCTION abos.financial_year_close_preview_json(p_entity uuid, p_year uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE y record; summary jsonb; unposted bigint; pending jsonb; warnings text[] := ARRAY[]::text[];
BEGIN
  SELECT id, starts_on, ends_on INTO y FROM abos.fiscal_years WHERE id = p_year AND legal_entity_id = p_entity;
  IF NOT FOUND THEN RAISE EXCEPTION 'the financial year was not found in this legal entity' USING ERRCODE = 'no_data_found'; END IF;
  SELECT jsonb_build_object('postedJournals', count(DISTINCT j.id), 'debits', COALESCE(sum(l.base_debit), 0)::text,
      'credits', COALESCE(sum(l.base_credit), 0)::text)
    INTO summary FROM abos.journals j JOIN abos.journal_lines l ON l.journal_id = j.id
   WHERE j.legal_entity_id = p_entity AND j.status = 'POSTED' AND j.accounting_effective_date BETWEEN y.starts_on AND y.ends_on;
  SELECT count(*) INTO unposted FROM abos.journals j WHERE j.legal_entity_id = p_entity AND j.status <> 'POSTED'
     AND j.accounting_effective_date BETWEEN y.starts_on AND y.ends_on;
  pending := jsonb_build_object(
    'expensesAwaitingApproval', (SELECT count(*) FROM abos.operational_expenses e WHERE e.legal_entity_id = p_entity AND e.status = 'PENDING_APPROVAL'
       AND e.business_date BETWEEN y.starts_on AND y.ends_on),
    'reversalRequests', (SELECT count(*) FROM abos.journal_reversal_requests r JOIN abos.journals j ON j.id = r.journal_id
       WHERE r.legal_entity_id = p_entity AND r.status IN ('REQUESTED', 'APPROVED') AND j.accounting_effective_date BETWEEN y.starts_on AND y.ends_on
         AND NOT EXISTS (SELECT 1 FROM abos.journal_reversal_links link WHERE link.original_journal_id = r.journal_id)),
    'temporaryFundingDecisions', (SELECT count(*) FROM abos.temporary_fundings f WHERE f.legal_entity_id = p_entity
       AND f.status = 'PENDING_APPROVAL' AND f.business_date BETWEEN y.starts_on AND y.ends_on)
       + (SELECT count(*) FROM abos.temporary_funding_settlements s WHERE s.legal_entity_id = p_entity
       AND s.status = 'PENDING_APPROVAL' AND s.business_date BETWEEN y.starts_on AND y.ends_on)
       + (SELECT count(*) FROM abos.loans l WHERE l.legal_entity_id = p_entity AND l.status = 'PENDING_APPROVAL' AND l.business_date BETWEEN y.starts_on AND y.ends_on)
       + (SELECT count(*) FROM abos.loan_repayments r WHERE r.legal_entity_id = p_entity AND r.status = 'PENDING_APPROVAL' AND r.business_date BETWEEN y.starts_on AND y.ends_on));
  IF y.ends_on >= abos.business_today() THEN warnings := array_append(warnings, 'YEAR_NOT_ENDED'); END IF;
  IF EXISTS (SELECT 1 FROM abos.fiscal_years e WHERE e.legal_entity_id = p_entity AND e.ends_on < y.starts_on AND e.closed_at IS NULL) THEN
    warnings := array_append(warnings, 'EARLIER_YEAR_ACTIVE');
  END IF;
  RETURN jsonb_build_object('year', abos.financial_year_view(p_entity, p_year), 'summary', summary, 'unpostedJournals', unposted,
    'pending', pending, 'warnings', to_jsonb(warnings));
END
$function$;

-- ---------------------------------------------------------------------------------------------
-- The loan register and approval list.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION abos.finance_loan_workspace(p_proof text, p_runtime text, p_token text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $workspace$
DECLARE c jsonb; entity uuid; perms jsonb; base text; can_read boolean; can_record boolean; can_repay boolean; can_approve boolean; approval boolean;
BEGIN
  c := abos.treasury_safe_actor(p_proof, p_runtime, p_token, NULL);
  entity := (c->>'legalEntityId')::uuid; perms := COALESCE(c->'permissions', '[]'::jsonb);
  can_read := perms ? 'finance.loan.read'; can_record := perms ? 'finance.loan.record'; can_repay := perms ? 'finance.loan.repay'; can_approve := perms ? 'finance.loan.approve';
  IF NOT (can_read OR can_record OR can_repay OR can_approve) THEN
    RAISE EXCEPTION 'current authority is missing finance.loan.read' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT base_currency_code INTO base FROM abos.legal_entities WHERE id = entity;
  SELECT v.approval_required INTO approval FROM abos.finance_workflow_policy_versions v WHERE v.legal_entity_id = entity AND v.workflow_type = 'LOAN' ORDER BY v.version DESC LIMIT 1;
  RETURN jsonb_build_object('legalEntityId', entity, 'baseCurrency', base, 'today', abos.business_today(), 'approvalRequired', COALESCE(approval, false),
    'permissions', jsonb_build_object('canRead', can_read, 'canRecord', can_record, 'canRepay', can_repay, 'canApprove', can_approve),
    'loans', CASE WHEN can_read OR can_repay OR can_approve THEN COALESCE((SELECT jsonb_agg(x.row ORDER BY x.business_date DESC, x.id) FROM (
        SELECT l.business_date, l.id, jsonb_build_object('id', l.id, 'transactionReference', l.transaction_reference, 'reference', l.reference, 'note', l.note, 'status', l.status,
          'decisionReason', l.decision_reason, 'lenderType', l.lender_type, 'lender', jsonb_build_object('id', b.id, 'name', b.display_name), 'shareholderProfileId', l.shareholder_profile_id,
          'currency', l.original_currency_code, 'principal', l.original_amount::text, 'basePrincipal', l.base_amount::text, 'date', l.business_date,
          'outstanding', p.outstanding::text, 'baseOutstanding', p.base_outstanding::text,
          'repaid', COALESCE((SELECT sum(r.original_amount) FROM abos.loan_repayments r WHERE r.loan_id = l.id AND r.status = 'POSTED'
              AND NOT EXISTS (SELECT 1 FROM abos.journal_reversal_links link WHERE link.original_journal_id = r.journal_id)), 0)::text,
          'pendingRepayments', COALESCE((SELECT sum(r.original_amount) FROM abos.loan_repayments r WHERE r.loan_id = l.id AND r.status = 'PENDING_APPROVAL'), 0)::text,
          'reversed', EXISTS (SELECT 1 FROM abos.journal_reversal_links link WHERE link.original_journal_id = l.journal_id),
          'treasury', jsonb_build_object('id', t.id, 'nameEn', t.name_en, 'nameFa', t.name_fa),
          'liability', jsonb_build_object('id', a.id, 'code', a.account_code, 'name', a.account_name), 'journalId', l.journal_id,
          'createdBy', (SELECT u.display_name FROM abos.user_accounts u WHERE u.id = l.created_by_user_account_id)) AS row
          FROM abos.loans l
          JOIN abos.business_parties b ON b.id = l.lender_business_party_id
          JOIN abos.operational_treasury_accounts t ON t.id = l.operational_treasury_account_id
          JOIN abos.ledger_accounts a ON a.id = l.liability_ledger_account_id
          CROSS JOIN LATERAL abos.loan_position(l.id) p
         WHERE l.legal_entity_id = entity) x), '[]'::jsonb) END,
    'pendingRepayments', CASE WHEN can_read OR can_approve THEN COALESCE((SELECT jsonb_agg(jsonb_build_object('id', r.id, 'loanId', r.loan_id, 'transactionReference', r.transaction_reference,
        'reference', r.reference, 'lender', b.display_name, 'currency', r.original_currency_code, 'amount', r.original_amount::text, 'date', r.business_date,
        'treasury', jsonb_build_object('id', t.id, 'nameEn', t.name_en, 'nameFa', t.name_fa),
        'createdBy', (SELECT u.display_name FROM abos.user_accounts u WHERE u.id = r.created_by_user_account_id)) ORDER BY r.business_date, r.id)
      FROM abos.loan_repayments r JOIN abos.loans l ON l.id = r.loan_id JOIN abos.business_parties b ON b.id = l.lender_business_party_id
      JOIN abos.operational_treasury_accounts t ON t.id = r.operational_treasury_account_id
     WHERE r.legal_entity_id = entity AND r.status = 'PENDING_APPROVAL'), '[]'::jsonb) END,
    'options', CASE WHEN can_record OR can_repay THEN jsonb_build_object(
      'treasuryAccounts', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', t.id, 'nameEn', t.name_en, 'nameFa', t.name_fa, 'accountType', t.account_type, 'currencyCode', t.currency_code) ORDER BY t.name_en, t.id)
        FROM abos.operational_treasury_accounts t WHERE t.legal_entity_id = entity AND t.status = 'ACTIVE'), '[]'::jsonb),
      'liabilityAccounts', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', a.id, 'code', a.account_code, 'name', a.account_name, 'control', a.control_account_type) ORDER BY a.account_code, a.id)
        FROM abos.ledger_accounts a WHERE a.legal_entity_id = entity AND a.status = 'ACTIVE' AND a.posting_allowed AND a.account_type = 'LIABILITY'
          AND a.control_account_type IN ('SHAREHOLDER_LOAN', 'LOAN_PAYABLE') AND (a.account_currency_code IS NULL OR a.account_currency_code = base)
          AND NOT a.requires_project AND NOT a.requires_department AND NOT a.requires_cost_center), '[]'::jsonb),
      'shareholders', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', s.id, 'name', b.display_name) ORDER BY b.display_name, s.id)
        FROM abos.shareholder_profiles s JOIN abos.business_parties b ON b.id = s.business_party_id
       WHERE s.legal_entity_id = entity AND s.status = 'ACTIVE' AND b.status = 'ACTIVE'), '[]'::jsonb),
      'lenders', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', b.id, 'name', b.display_name) ORDER BY b.display_name, b.id)
        FROM abos.business_parties b WHERE b.legal_entity_id = entity AND b.status = 'ACTIVE' AND EXISTS (SELECT 1 FROM abos.business_party_roles r WHERE r.business_party_id = b.id
          AND r.role_code IN ('LENDER', 'SUPPLIER', 'CONTRACTOR', 'CUSTOMER'))), '[]'::jsonb)) END);
END
$workspace$;

-- ---------------------------------------------------------------------------------------------
-- One loan's statement: opening, each receipt, repayment and reversal, and closing, proved against its liability account.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION abos.finance_loan_statement(p_proof text, p_runtime text, p_token text, p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $statement$
DECLARE c jsonb; entity uuid; perms jsonb; l abos.loans%ROWTYPE; loan_id uuid; range jsonb; v_from date; v_to date; opening record; closing record; lines jsonb; ledger_base numeric; loans_base numeric;
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
      'amount', abs(x.amount)::text, 'baseAmount', abs(x.base)::text, 'effect', (-x.amount)::text, 'balance', (opening.outstanding - x.running)::text,
      'treasury', x.treasury, 'source', abos.report_journal_source(entity, x.journal_id, perms, true)) ORDER BY x.day, x.posted_at, x.journal_id), '[]'::jsonb)
    INTO lines
    FROM (SELECT y.*, sum(y.amount) OVER (ORDER BY y.day, y.posted_at, y.journal_id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running
            FROM (SELECT j.journal_id, j.kind, journal.accounting_effective_date AS day, journal.posted_at, entry.original_amount AS amount, entry.base_amount AS base,
                         (SELECT jsonb_build_object('id', t.id, 'nameEn', t.name_en, 'nameFa', t.name_fa) FROM abos.subledger_entries te JOIN abos.journal_lines tl ON tl.id = te.journal_line_id
                            JOIN abos.operational_treasury_accounts t ON t.id = te.operational_treasury_account_id
                           WHERE tl.journal_id = j.journal_id AND te.subledger_type = 'OPERATIONAL_TREASURY' LIMIT 1) AS treasury
                    FROM abos.loan_journals(l.id) j
                    JOIN abos.journals journal ON journal.id = j.journal_id AND journal.status = 'POSTED'
                    JOIN abos.journal_lines line ON line.journal_id = journal.id
                    JOIN abos.subledger_entries entry ON entry.journal_line_id = line.id AND entry.subledger_type = 'LOAN_PAYABLE'
                   WHERE journal.accounting_effective_date BETWEEN v_from AND v_to) y) x;
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
    'lines', lines,
    'reconciliation', jsonb_build_object('loansBase', loans_base::text, 'ledgerBase', ledger_base::text, 'matches', loans_base = ledger_base));
END
$statement$;

ALTER FUNCTION abos.finance_loan_workspace(text, text, text) OWNER TO abos_v1_operational_finance_owner;
ALTER FUNCTION abos.finance_loan_statement(text, text, text, jsonb) OWNER TO abos_v1_operational_finance_owner;
REVOKE ALL ON FUNCTION abos.finance_loan_workspace(text, text, text), abos.finance_loan_statement(text, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION abos.finance_loan_workspace(text, text, text), abos.finance_loan_statement(text, text, text, jsonb) TO abos_e1_runtime;
