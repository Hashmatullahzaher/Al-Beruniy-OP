-- V1 read-only posted General Ledger activity. This is an operational preview,
-- not an official financial statement or an opening-balance calculation.
CREATE FUNCTION abos.finance_general_ledger(
  p_bearer_token text,
  p_from date,
  p_to date,
  p_account_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $ledger$
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
      SELECT journal.id AS "journalId", journal.journal_reference AS "journalReference",
             line.line_number AS "lineNumber", account.id AS "accountId",
             account.account_code AS "accountCode", account.account_name AS "accountName",
             line.source_type AS "sourceType", line.source_id AS "sourceId",
             journal.accounting_period_id AS "accountingPeriodId",
             journal.accounting_effective_date AS "accountingEffectiveDate",
             journal.posted_at AS "postedAt",
             line.original_currency_code AS "originalCurrency",
             line.original_amount::text AS "originalAmount",
             line.base_currency_code AS "baseCurrency",
             line.base_debit::text AS "baseDebit",
             line.base_credit::text AS "baseCredit"
        FROM abos.journal_lines line
        JOIN abos.journals journal
          ON journal.id = line.journal_id AND journal.legal_entity_id = line.legal_entity_id
        JOIN abos.ledger_accounts account
          ON account.id = line.ledger_account_id AND account.legal_entity_id = line.legal_entity_id
       WHERE journal.legal_entity_id = entity_id AND line.legal_entity_id = entity_id
         AND journal.status = 'POSTED'
         AND journal.accounting_effective_date BETWEEN p_from AND p_to
         AND (p_account_id IS NULL OR line.ledger_account_id = p_account_id)
         AND (line.project_id IS NULL OR EXISTS (
           SELECT 1 FROM abos.user_scope_grants scope
            WHERE scope.user_account_id = actor_id AND scope.legal_entity_id = entity_id
              AND scope.scope_kind = 'PROJECT' AND scope.scope_id = line.project_id
              AND scope.revoked_at IS NULL))
         AND (line.department_id IS NULL OR EXISTS (
           SELECT 1 FROM abos.user_scope_grants scope
            WHERE scope.user_account_id = actor_id AND scope.legal_entity_id = entity_id
              AND scope.scope_kind = 'DEPARTMENT' AND scope.scope_id = line.department_id
              AND scope.revoked_at IS NULL))
         AND (line.cost_center_id IS NULL OR EXISTS (
           SELECT 1 FROM abos.user_scope_grants scope
            WHERE scope.user_account_id = actor_id AND scope.legal_entity_id = entity_id
              AND scope.scope_kind = 'COST_CENTER' AND scope.scope_id = line.cost_center_id
              AND scope.revoked_at IS NULL))
       ORDER BY journal.accounting_effective_date DESC, journal.posted_at DESC,
                journal.id DESC, line.line_number
       LIMIT 100
    ) item;

  SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(item)
           ORDER BY item.currency), '[]'::jsonb)
    INTO totals
    FROM (
      SELECT line.base_currency_code AS currency,
             pg_catalog.sum(line.base_debit)::text AS debits,
             pg_catalog.sum(line.base_credit)::text AS credits,
             pg_catalog.count(*)::text AS "lineCount"
        FROM abos.journal_lines line
        JOIN abos.journals journal
          ON journal.id = line.journal_id AND journal.legal_entity_id = line.legal_entity_id
       WHERE journal.legal_entity_id = entity_id AND line.legal_entity_id = entity_id
         AND journal.status = 'POSTED'
         AND journal.accounting_effective_date BETWEEN p_from AND p_to
         AND (p_account_id IS NULL OR line.ledger_account_id = p_account_id)
         AND (line.project_id IS NULL OR EXISTS (
           SELECT 1 FROM abos.user_scope_grants scope
            WHERE scope.user_account_id = actor_id AND scope.legal_entity_id = entity_id
              AND scope.scope_kind = 'PROJECT' AND scope.scope_id = line.project_id
              AND scope.revoked_at IS NULL))
         AND (line.department_id IS NULL OR EXISTS (
           SELECT 1 FROM abos.user_scope_grants scope
            WHERE scope.user_account_id = actor_id AND scope.legal_entity_id = entity_id
              AND scope.scope_kind = 'DEPARTMENT' AND scope.scope_id = line.department_id
              AND scope.revoked_at IS NULL))
         AND (line.cost_center_id IS NULL OR EXISTS (
           SELECT 1 FROM abos.user_scope_grants scope
            WHERE scope.user_account_id = actor_id AND scope.legal_entity_id = entity_id
              AND scope.scope_kind = 'COST_CENTER' AND scope.scope_id = line.cost_center_id
              AND scope.revoked_at IS NULL))
       GROUP BY line.base_currency_code
    ) item;

  RETURN pg_catalog.jsonb_build_object(
    'syntheticOnly', true, 'legalEntityId', entity_id,
    'from', p_from, 'to', p_to, 'accountId', p_account_id,
    'lines', lines, 'totals', totals, 'pageLimit', 100,
    'returnedLineCount', pg_catalog.jsonb_array_length(lines),
    'hasMore', (SELECT coalesce(pg_catalog.sum((entry ->> 'lineCount')::bigint), 0)
                 FROM pg_catalog.jsonb_array_elements(totals) entry)
               > pg_catalog.jsonb_array_length(lines));
END
$ledger$;

ALTER FUNCTION abos.finance_general_ledger(text, date, date, uuid)
  OWNER TO abos_e1_finance_owner;
REVOKE ALL ON FUNCTION abos.finance_general_ledger(text, date, date, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION abos.finance_general_ledger(text, date, date, uuid)
  TO abos_e1_runtime;
