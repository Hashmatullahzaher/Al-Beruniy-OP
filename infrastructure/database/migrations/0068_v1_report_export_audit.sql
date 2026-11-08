-- 0068: every report export is an audit event (owner decision, 2026-11-08).
--
-- The application exports a report only after the report function itself has answered for the same session, so the
-- export can never carry more than the screen. This function then records that the export happened. It accepts
-- metadata only, every field from a closed list and checked for shape: report kind, format, language, the resolved
-- date range, the account filter and the row count. It has no free-text field, so the audit row cannot hold report
-- contents, descriptions, balances or names. The company, the person and the session come from the session itself,
-- never from the request. The audit table stays append-only (abos.prevent_audit_mutation).

CREATE FUNCTION abos.finance_report_export_record(p_proof text, p_runtime text, p_token text, p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $export$
DECLARE
  c jsonb; entity uuid; actor uuid; kind text; v_format text; v_language text; v_mode text; v_from date; v_to date;
  v_period uuid; v_year uuid; v_account uuid; v_include_zero boolean; v_rows integer; audit_id uuid := gen_random_uuid();
BEGIN
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_payload) k
       WHERE k NOT IN ('kind', 'format', 'language', 'mode', 'from', 'to', 'periodId', 'fiscalYearId', 'accountId', 'includeZero', 'rowCount')) THEN
    RAISE EXCEPTION 'unknown export fields' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  kind := p_payload->>'kind';
  IF kind IS NULL OR kind NOT IN ('TRIAL_BALANCE', 'GENERAL_LEDGER', 'ACCOUNT_STATEMENT', 'SAFE_STATEMENT') THEN
    RAISE EXCEPTION 'unknown report kind' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- The same authority the report itself requires: a Safe statement is open to its readers, the others to Finance report readers.
  IF kind = 'SAFE_STATEMENT' THEN
    c := abos.treasury_safe_actor(p_proof, p_runtime, p_token, NULL);
    IF NOT COALESCE(c->'permissions', '[]'::jsonb) ?| ARRAY['treasury.safe.read', 'finance.report.operational.read'] THEN
      RAISE EXCEPTION 'current authority is missing treasury.safe.read' USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSE
    c := abos.operational_finance_actor(p_proof, p_runtime, p_token, 'finance.report.operational.read');
  END IF;
  entity := (c->>'legalEntityId')::uuid; actor := (c->>'userAccountId')::uuid;

  v_format := p_payload->>'format'; v_language := p_payload->>'language'; v_mode := p_payload->>'mode';
  IF v_format IS DISTINCT FROM 'CSV' OR v_language IS NULL OR v_language NOT IN ('en', 'fa')
     OR v_mode IS NULL OR v_mode NOT IN ('AS_OF', 'PERIOD', 'RANGE', 'YEAR')
     OR jsonb_typeof(p_payload->'rowCount') IS DISTINCT FROM 'number'
     OR (p_payload ? 'includeZero' AND jsonb_typeof(p_payload->'includeZero') <> 'boolean') THEN
    RAISE EXCEPTION 'valid export details are required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  BEGIN
    v_from := (p_payload->>'from')::date; v_to := (p_payload->>'to')::date;
    v_period := NULLIF(p_payload->>'periodId', '')::uuid; v_year := NULLIF(p_payload->>'fiscalYearId', '')::uuid;
    v_account := NULLIF(p_payload->>'accountId', '')::uuid;
    v_rows := (p_payload->>'rowCount')::integer;
  EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow OR invalid_datetime_format OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'valid export details are required' USING ERRCODE = 'invalid_parameter_value';
  END;
  v_include_zero := COALESCE((p_payload->>'includeZero')::boolean, false);
  IF v_from IS NULL OR v_to IS NULL OR v_from > v_to OR v_rows IS NULL OR v_rows < 0 OR v_rows > 5000
     OR (p_payload->>'rowCount') !~ '^[0-9]+$'
     OR (v_account IS NULL AND kind IN ('ACCOUNT_STATEMENT', 'SAFE_STATEMENT'))
     OR (v_account IS NOT NULL AND kind = 'TRIAL_BALANCE')
     OR (v_include_zero AND kind <> 'TRIAL_BALANCE') THEN
    RAISE EXCEPTION 'valid export details are required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- A filter can only name something of the session's own company.
  IF v_account IS NOT NULL AND (
       (kind IN ('ACCOUNT_STATEMENT', 'GENERAL_LEDGER') AND NOT EXISTS (SELECT 1 FROM abos.ledger_accounts a WHERE a.id = v_account AND a.legal_entity_id = entity))
    OR (kind = 'SAFE_STATEMENT' AND NOT EXISTS (SELECT 1 FROM abos.operational_treasury_accounts t WHERE t.id = v_account AND t.legal_entity_id = entity))) THEN
    RAISE EXCEPTION 'the account was not found in this legal entity' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF (v_period IS NOT NULL AND NOT EXISTS (SELECT 1 FROM abos.accounting_periods p WHERE p.id = v_period AND p.legal_entity_id = entity))
     OR (v_year IS NOT NULL AND NOT EXISTS (SELECT 1 FROM abos.fiscal_years y WHERE y.id = v_year AND y.legal_entity_id = entity)) THEN
    RAISE EXCEPTION 'the period was not found in this legal entity' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  INSERT INTO abos.audit_records (id, actor_user_account_id, legal_entity_id, correlation_id, action, entity_type, entity_id, after_state, metadata)
  VALUES (audit_id, actor, entity, gen_random_uuid(), 'FINANCE_REPORT_EXPORTED', 'FINANCE_REPORT', v_account,
    jsonb_strip_nulls(jsonb_build_object('kind', kind, 'format', v_format, 'language', v_language, 'mode', v_mode, 'from', v_from, 'to', v_to,
      'periodId', v_period, 'fiscalYearId', v_year, 'accountId', v_account, 'includeZero', CASE WHEN kind = 'TRIAL_BALANCE' THEN v_include_zero END,
      'rowCount', v_rows)),
    jsonb_build_object('source', 'v1-report-export', 'sessionId', c->>'id'));
  RETURN jsonb_build_object('auditId', audit_id);
END
$export$;

-- The operational Finance owner may already insert audit rows (0027) and read these tables (0027, 0046, 0050, 0053).
ALTER FUNCTION abos.finance_report_export_record(text, text, text, jsonb) OWNER TO abos_v1_operational_finance_owner;
REVOKE ALL ON FUNCTION abos.finance_report_export_record(text, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION abos.finance_report_export_record(text, text, text, jsonb) TO abos_e1_runtime;
