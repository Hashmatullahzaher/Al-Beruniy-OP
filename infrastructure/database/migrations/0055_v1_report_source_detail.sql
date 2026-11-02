-- 0055: source detail in the Account statement, journal detail and General Ledger (follow-up to 0053).
--   * An expense's source names its receipt reference and expense type, e.g. "EXP-001 — Office supplies", for a reader who
--     holds finance.expense.read; without it the label stays "Expense". The journal reference is unchanged.
--   * The "Capital received" link opens that shareholder's record (/shareholders?shareholder=<profile>) for a reader who may
--     read shareholders; without it there is no link, as before.
--   * finance_journal_sources gives the General Ledger page the same source object per journal, with the same reader,
--     permission and masking as the journal detail, so a restricted journal stays restricted.
-- report_journal_source is restated and one read-only function is added; no table, row or journal is touched.
CREATE OR REPLACE FUNCTION abos.report_journal_source(p_entity uuid, p_journal uuid, p_permissions jsonb, p_visible boolean)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $source$
DECLARE intent abos.posting_intents%ROWTYPE; label jsonb; route text; party text; readable boolean; detail jsonb;
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
    -- 0055: the capital link opens that shareholder's record.
    IF intent.source_type = 'DIRECT_SHAREHOLDER_CAPITAL' THEN
      route := COALESCE((SELECT '/shareholders?shareholder=' || r.shareholder_profile_id FROM abos.direct_capital_receipts r
        WHERE r.id = intent.source_id AND r.legal_entity_id = p_entity), route);
    END IF;
  END IF;
  -- 0055: an expense names its receipt reference and expense type ("EXP-001 — Office supplies") to a reader who may read
  -- expenses; everyone else keeps the generic label.
  IF intent.source_type = 'OPERATIONAL_EXPENSE' AND p_permissions ? 'finance.expense.read' THEN
    SELECT jsonb_build_object('en', e.reference || ' — ' || c.name_en, 'fa', e.reference || ' — ' || COALESCE(NULLIF(c.name_fa, ''), c.name_en))
      INTO detail FROM abos.operational_expenses e JOIN abos.operational_expense_categories c ON c.id = e.operational_expense_category_id
     WHERE e.id = intent.source_id AND e.legal_entity_id = p_entity;
  END IF;
  RETURN jsonb_build_object('type', intent.source_type, 'id', CASE WHEN readable THEN intent.source_id END, 'label', label,
    'route', CASE WHEN readable THEN route END, 'counterparty', party, 'detailRestricted', NOT readable, 'detail', detail);
END
$source$;

-- The business source of up to 100 journals at once, for the General Ledger page (its 0024 function is owned by the E1
-- Finance owner, which neither reads the source modules nor needs to). Same reader, permission and masking as
-- finance_journal_detail: a journal with any line outside the reader's scope gets the generic restricted source.
CREATE FUNCTION abos.finance_journal_sources(p_proof text, p_runtime text, p_token text, p_journal_ids uuid[])
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $sources$
DECLARE c jsonb; entity uuid; actor uuid; perms jsonb;
BEGIN
  c := abos.operational_finance_actor(p_proof, p_runtime, p_token, 'finance.report.operational.read');
  entity := (c->>'legalEntityId')::uuid; actor := (c->>'userAccountId')::uuid; perms := COALESCE(c->'permissions', '[]'::jsonb);
  IF p_journal_ids IS NULL OR cardinality(p_journal_ids) > 100 THEN
    RAISE EXCEPTION 'between 0 and 100 journals may be requested at once' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN COALESCE((SELECT jsonb_object_agg(j.id, abos.report_journal_source(entity, j.id, perms,
      (SELECT bool_and(abos.report_line_visible(entity, actor, line.project_id, line.department_id, line.cost_center_id))
         FROM abos.journal_lines line WHERE line.journal_id = j.id)))
    FROM abos.journals j WHERE j.id = ANY(p_journal_ids) AND j.legal_entity_id = entity AND j.status = 'POSTED'), '{}'::jsonb);
END
$sources$;

ALTER FUNCTION abos.finance_journal_sources(text, text, text, uuid[]) OWNER TO abos_v1_operational_finance_owner;
REVOKE ALL ON FUNCTION abos.finance_journal_sources(text, text, text, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION abos.finance_journal_sources(text, text, text, uuid[]) TO abos_e1_runtime;
