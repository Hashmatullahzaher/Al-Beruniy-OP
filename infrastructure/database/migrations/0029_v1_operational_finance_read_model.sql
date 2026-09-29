-- V1 Operational Finance: read model for the Record Expense form and the Daily Financial Report.
--
-- Read-only. Two restricted entry points, owned by abos_v1_operational_finance_owner and
-- executable only by the Finance runtime, derive actor, legal entity and permissions from the
-- server proof and the live session exactly as the 0028 entry points do. Nothing is written.
--
-- * operational_expense_entry_options: what the Record Expense form needs for one business date:
--   active Treasury accounts and expense categories (with the dimensions their ledger accounts
--   require), the actor's own live project / department / cost-center scopes, the date's current
--   exchange rates (never another day's), whether an open period covers the date, and whether an
--   expense approval policy is configured.
-- * operational_finance_daily_report: posted expenses of one date by category and per currency, and
--   operational Treasury movements before, on and up to that date. Figures come only from posted
--   Treasury subledger entries. As in the General Ledger (0020), a person sees only expenses whose
--   project, department and cost center are all inside their live scopes. No opening balances exist
--   yet, so Treasury figures are the movements recorded in this system, not bank or cash balances.

GRANT SELECT (id, legal_entity_id, code, name, active) ON abos.projects TO abos_v1_operational_finance_owner;
GRANT SELECT (id, legal_entity_id, code, name, active) ON abos.departments TO abos_v1_operational_finance_owner;
GRANT SELECT (id, legal_entity_id, code, name, active) ON abos.cost_centers TO abos_v1_operational_finance_owner;

CREATE FUNCTION abos.operational_expense_entry_options(
  p_identity_proof text,
  p_runtime_token_sha256 text,
  p_token_sha256 text,
  p_business_date date
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $options$
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
    'approvalRequired', v_policy.approval_required,
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
$options$;

CREATE FUNCTION abos.operational_finance_daily_report(
  p_identity_proof text,
  p_runtime_token_sha256 text,
  p_token_sha256 text,
  p_report_date date
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $report$
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
    -- Operational Treasury movements from posted subledger entries only, in each account's own
    -- currency; "before" is every movement dated earlier, "day" is the report date.
    'treasuryMovements', COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'treasuryAccountId', account.id, 'nameEn', account.name_en, 'nameFa', account.name_fa,
        'currency', account.currency_code, 'status', account.status,
        'before', movements.before_amount::text, 'day', movements.day_amount::text,
        'after', (movements.before_amount + movements.day_amount)::text)
        ORDER BY account.name_en, account.id)
      FROM abos.operational_treasury_accounts account
      CROSS JOIN LATERAL (
        SELECT COALESCE(sum(entry.original_amount) FILTER (WHERE journal.accounting_effective_date < p_report_date), 0) AS before_amount,
               COALESCE(sum(entry.original_amount) FILTER (WHERE journal.accounting_effective_date = p_report_date), 0) AS day_amount
          FROM abos.subledger_entries entry
          JOIN abos.journal_lines line ON line.id = entry.journal_line_id
          JOIN abos.journals journal ON journal.id = line.journal_id AND journal.status = 'POSTED'
          JOIN abos.operational_expenses expense
            ON expense.id = entry.source_id AND expense.legal_entity_id = entry.legal_entity_id
         WHERE entry.operational_treasury_account_id = account.id
           AND entry.legal_entity_id = v_entity_id
           AND entry.processing_model = 'OPERATIONAL_V1'
           AND entry.source_type = 'OPERATIONAL_EXPENSE'
           AND journal.accounting_effective_date <= p_report_date
           AND abos.operational_expense_actor_in_scope(expense.id, v_entity_id, v_actor_id)) movements
      WHERE account.legal_entity_id = v_entity_id), '[]'::jsonb));
END
$report$;

ALTER FUNCTION abos.operational_expense_entry_options(text, text, text, date)
  OWNER TO abos_v1_operational_finance_owner;
ALTER FUNCTION abos.operational_finance_daily_report(text, text, text, date)
  OWNER TO abos_v1_operational_finance_owner;
REVOKE ALL ON FUNCTION abos.operational_expense_entry_options(text, text, text, date),
  abos.operational_finance_daily_report(text, text, text, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION abos.operational_expense_entry_options(text, text, text, date),
  abos.operational_finance_daily_report(text, text, text, date) TO abos_e1_runtime;
