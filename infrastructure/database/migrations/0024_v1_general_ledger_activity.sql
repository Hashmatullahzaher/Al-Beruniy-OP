-- V1 backlog #19 (part): per-account posted activity for a date range and keyset paging of posted
-- General Ledger lines. Both are read-only operational previews over POSTED journals.
--
-- Policy boundary: there are no opening balances yet (#18) and no period can be opened or closed in
-- the application. Nothing here is a balance, a trial balance or a financial statement: the summary
-- is only the posted debit/credit activity inside the requested range. Currencies are never
-- combined and nothing is converted.
--
-- 0020 (abos.finance_general_ledger) is unchanged. The visibility rules below are the same
-- predicates, moved into one internal helper that both new entry points use.

-- -----------------------------------------------------------------------------------------------
-- Internal helper: the posted lines a given actor may see in a given legal entity.
--
-- Legal-entity isolation plus the conjunctive, live project / department / cost-center scope filter,
-- identical to 0020. SECURITY INVOKER and not executable by PUBLIC or any runtime: it runs only
-- inside the Finance-owned entry points below, which derive the actor and legal entity from the
-- bearer token before calling it. A runtime that reached it directly would still hold no table
-- privilege.
-- -----------------------------------------------------------------------------------------------
CREATE FUNCTION abos.finance_gl_visible_lines(
  p_legal_entity_id uuid,
  p_actor_id uuid,
  p_from date,
  p_to date,
  p_account_id uuid
) RETURNS TABLE (
  journal_id uuid,
  journal_reference text,
  line_number integer,
  account_id uuid,
  account_code text,
  account_name text,
  source_type text,
  source_id uuid,
  accounting_period_id uuid,
  accounting_effective_date date,
  posted_at timestamptz,
  original_currency_code text,
  original_amount numeric,
  base_currency_code text,
  base_debit numeric,
  base_credit numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $visible$
  SELECT journal.id, journal.journal_reference, line.line_number, account.id,
         account.account_code, account.account_name, line.source_type, line.source_id,
         journal.accounting_period_id, journal.accounting_effective_date, journal.posted_at,
         line.original_currency_code, line.original_amount, line.base_currency_code,
         line.base_debit, line.base_credit
    FROM abos.journal_lines line
    JOIN abos.journals journal
      ON journal.id = line.journal_id AND journal.legal_entity_id = line.legal_entity_id
    JOIN abos.ledger_accounts account
      ON account.id = line.ledger_account_id AND account.legal_entity_id = line.legal_entity_id
   WHERE p_legal_entity_id IS NOT NULL AND p_actor_id IS NOT NULL
     AND journal.legal_entity_id = p_legal_entity_id AND line.legal_entity_id = p_legal_entity_id
     AND journal.status = 'POSTED'
     AND journal.accounting_effective_date BETWEEN p_from AND p_to
     AND (p_account_id IS NULL OR line.ledger_account_id = p_account_id)
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
$visible$;

ALTER FUNCTION abos.finance_gl_visible_lines(uuid, uuid, date, date, uuid)
  OWNER TO abos_e1_finance_owner;
REVOKE ALL ON FUNCTION abos.finance_gl_visible_lines(uuid, uuid, date, date, uuid) FROM PUBLIC;

-- -----------------------------------------------------------------------------------------------
-- Per-account posted activity in [from, to]: one row per ledger account and base currency, with
-- debit total, credit total, net (debit - credit) and line count as exact decimal text. Where lines
-- carry an original amount, those are grouped by original currency inside the row. Never a balance.
-- -----------------------------------------------------------------------------------------------
CREATE FUNCTION abos.finance_general_ledger_activity(
  p_bearer_token text,
  p_from date,
  p_to date,
  p_account_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $activity$
DECLARE
  entity_id uuid;
  actor_id uuid;
  result jsonb;
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

  -- One statement, so the per-account rows and the per-currency totals share one snapshot.
  WITH visible AS MATERIALIZED (
    SELECT * FROM abos.finance_gl_visible_lines(entity_id, actor_id, p_from, p_to, p_account_id)
  ), original AS (
    SELECT visible.account_id, visible.base_currency_code, visible.original_currency_code,
           pg_catalog.sum(CASE WHEN visible.base_debit > 0 THEN visible.original_amount ELSE 0 END) AS debit_total,
           pg_catalog.sum(CASE WHEN visible.base_credit > 0 THEN visible.original_amount ELSE 0 END) AS credit_total,
           pg_catalog.count(*) AS line_count
      FROM visible
     WHERE visible.original_currency_code IS NOT NULL
     GROUP BY visible.account_id, visible.base_currency_code, visible.original_currency_code
  ), per_account AS (
    SELECT visible.account_id, visible.account_code, visible.account_name, visible.base_currency_code,
           pg_catalog.sum(visible.base_debit) AS debit_total,
           pg_catalog.sum(visible.base_credit) AS credit_total,
           pg_catalog.count(*) AS line_count
      FROM visible
     GROUP BY visible.account_id, visible.account_code, visible.account_name, visible.base_currency_code
  ), per_currency AS (
    SELECT visible.base_currency_code,
           pg_catalog.sum(visible.base_debit) AS debit_total,
           pg_catalog.sum(visible.base_credit) AS credit_total,
           pg_catalog.count(*) AS line_count,
           pg_catalog.count(DISTINCT visible.account_id) AS account_count
      FROM visible
     GROUP BY visible.base_currency_code
  )
  SELECT pg_catalog.jsonb_build_object(
           'accounts', coalesce((
             SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                      'accountId', per_account.account_id,
                      'accountCode', per_account.account_code,
                      'accountName', per_account.account_name,
                      'baseCurrency', per_account.base_currency_code,
                      'debitTotal', per_account.debit_total::text,
                      'creditTotal', per_account.credit_total::text,
                      'net', (per_account.debit_total - per_account.credit_total)::text,
                      'lineCount', per_account.line_count::text,
                      'originalCurrencies', coalesce((
                        SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                                 'currency', original.original_currency_code,
                                 'debitTotal', original.debit_total::text,
                                 'creditTotal', original.credit_total::text,
                                 'net', (original.debit_total - original.credit_total)::text,
                                 'lineCount', original.line_count::text)
                               ORDER BY original.original_currency_code)
                          FROM original
                         WHERE original.account_id = per_account.account_id
                           AND original.base_currency_code = per_account.base_currency_code), '[]'::jsonb))
                    ORDER BY per_account.account_code, per_account.base_currency_code, per_account.account_id)
               FROM per_account), '[]'::jsonb),
           'currencyTotals', coalesce((
             SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                      'baseCurrency', per_currency.base_currency_code,
                      'debitTotal', per_currency.debit_total::text,
                      'creditTotal', per_currency.credit_total::text,
                      'net', (per_currency.debit_total - per_currency.credit_total)::text,
                      'lineCount', per_currency.line_count::text,
                      'accountCount', per_currency.account_count::text)
                    ORDER BY per_currency.base_currency_code)
               FROM per_currency), '[]'::jsonb))
    INTO result;

  RETURN pg_catalog.jsonb_build_object(
    'syntheticOnly', true, 'legalEntityId', entity_id,
    'from', p_from, 'to', p_to, 'accountId', p_account_id,
    'basis', 'POSTED_ACTIVITY_IN_RANGE',
    'isBalance', false, 'openingBalancesIncluded', false,
    'accounts', result -> 'accounts', 'currencyTotals', result -> 'currencyTotals');
END
$activity$;

ALTER FUNCTION abos.finance_general_ledger_activity(text, date, date, uuid)
  OWNER TO abos_e1_finance_owner;
REVOKE ALL ON FUNCTION abos.finance_general_ledger_activity(text, date, date, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION abos.finance_general_ledger_activity(text, date, date, uuid)
  TO abos_e1_runtime;

-- -----------------------------------------------------------------------------------------------
-- Keyset paging of posted lines in exactly the 0020 order:
--   accounting_effective_date DESC, posted_at DESC, journal id DESC, line number ASC.
--
-- The cursor is an opaque, URL-safe encoding of the last returned row's sort key. It is only a
-- position: every page is re-filtered by the same entity and scope predicates, so a tampered or
-- foreign cursor can at most move the start position within the caller's own visible lines. A
-- cursor that does not decode to a well-formed sort key is refused (22023). The first page (no
-- cursor) also returns the per-currency totals of the whole filtered range, like 0020.
-- -----------------------------------------------------------------------------------------------
CREATE FUNCTION abos.finance_general_ledger_page(
  p_bearer_token text,
  p_from date,
  p_to date,
  p_account_id uuid DEFAULT NULL,
  p_cursor text DEFAULT NULL,
  p_page_size integer DEFAULT 100
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $page$
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
                      'baseCredit', numbered.base_credit::text)
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
    'syntheticOnly', true, 'legalEntityId', entity_id,
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
$page$;

ALTER FUNCTION abos.finance_general_ledger_page(text, date, date, uuid, text, integer)
  OWNER TO abos_e1_finance_owner;
REVOKE ALL ON FUNCTION abos.finance_general_ledger_page(text, date, date, uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION abos.finance_general_ledger_page(text, date, date, uuid, text, integer)
  TO abos_e1_runtime;
