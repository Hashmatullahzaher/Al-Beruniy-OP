-- 0054: correction to 0052 (deployed 2026-10-31). The financial-year close preview appended its warnings with
-- `text[] || 'literal'`, which PostgreSQL reads as an array literal ("malformed array literal"), so previewing a year
-- that has not ended, or one with an earlier active year, failed. The warnings are now appended with array_append.
-- Only this one function changes; no table, row, privilege or journal is touched.
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
       AND s.status = 'PENDING_APPROVAL' AND s.business_date BETWEEN y.starts_on AND y.ends_on));
  IF y.ends_on >= abos.business_today() THEN warnings := array_append(warnings, 'YEAR_NOT_ENDED'); END IF;
  IF EXISTS (SELECT 1 FROM abos.fiscal_years e WHERE e.legal_entity_id = p_entity AND e.ends_on < y.starts_on AND e.closed_at IS NULL) THEN
    warnings := array_append(warnings, 'EARLIER_YEAR_ACTIVE');
  END IF;
  RETURN jsonb_build_object('year', abos.financial_year_view(p_entity, p_year), 'summary', summary, 'unpostedJournals', unposted,
    'pending', pending, 'warnings', to_jsonb(warnings));
END
$function$;
