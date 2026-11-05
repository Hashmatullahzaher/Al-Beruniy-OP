-- 0060: a reversal is as confidential as the journal it reverses.
--
-- 0057 treated every reversal as readable. A report-only reader therefore received, for a reversal of a source they may not read, its
-- RV- reference, the reversed journal as the source id, a link to the reversals page, and on journal detail the free-text reason.
-- A reason is written about the business record and may name a person or a payment.
--
-- One rule now decides: a reversal counts as the source it reverses, through report_effective_source_type. A source type the rule does
-- not name stays unreadable, so REVERSAL is no longer a special case. Amounts, dates, accounts and the generic "Reversal" label do not
-- change, and neither does any balance.
--
-- No table, no row, no journal. Each function keeps its owner, grants and signature.

CREATE OR REPLACE FUNCTION abos.report_source_readable(p_source_type text, p_permissions jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $readable$
  SELECT CASE
    WHEN p_source_type = 'DIRECT_SHAREHOLDER_CAPITAL' THEN p_permissions ?| ARRAY['shareholder.read', 'shareholder.capital-receipt.read']
    WHEN p_source_type IN ('TEMPORARY_FUNDING', 'TEMPORARY_FUNDING_SETTLEMENT') THEN p_permissions ? 'finance.temporary-funding.read'
    WHEN p_source_type = 'OPERATIONAL_EXPENSE' THEN p_permissions ? 'finance.expense.read'
    WHEN p_source_type IN ('CASH_RECEIPT', 'PAYMENT', 'TREASURY_TRANSFER', 'OPENING_BALANCE') THEN p_permissions ? 'treasury.safe.read'
    ELSE false END
$readable$;

CREATE OR REPLACE FUNCTION abos.report_journal_reference(p_journal uuid, p_permissions jsonb)
RETURNS text LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $reference$
  SELECT CASE WHEN abos.report_source_readable(abos.report_effective_source_type(journal.id), p_permissions) THEN journal.journal_reference
              ELSE 'JRN-' || upper(left(replace(journal.id::text, '-', ''), 12)) END
    FROM abos.journals journal
   WHERE journal.id = p_journal
$reference$;

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
      WHEN 'TEMPORARY_FUNDING' THEN SELECT f.reference, f.description INTO business_reference, business_description FROM abos.temporary_fundings f WHERE f.id = intent.source_id;
      WHEN 'TEMPORARY_FUNDING_SETTLEMENT' THEN SELECT s.reference, s.note INTO business_reference, business_description FROM abos.temporary_funding_settlements s WHERE s.id = intent.source_id;
      ELSE NULL;
    END CASE;
    -- 0055: the capital link opens that shareholder's record.
    IF intent.source_type = 'DIRECT_SHAREHOLDER_CAPITAL' THEN
      route := COALESCE((SELECT '/shareholders?shareholder=' || r.shareholder_profile_id FROM abos.direct_capital_receipts r
        WHERE r.id = intent.source_id AND r.legal_entity_id = p_entity), route);
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

CREATE OR REPLACE FUNCTION abos.finance_journal_detail(p_proof text, p_runtime text, p_token text, p_journal_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE c jsonb; entity uuid; actor uuid; perms jsonb; journal abos.journals%ROWTYPE; visible boolean; intent abos.posting_intents%ROWTYPE; may_read_reason boolean;
BEGIN
  c := abos.operational_finance_actor(p_proof, p_runtime, p_token, 'finance.report.operational.read');
  entity := (c->>'legalEntityId')::uuid; actor := (c->>'userAccountId')::uuid; perms := COALESCE(c->'permissions', '[]'::jsonb);
  SELECT * INTO journal FROM abos.journals WHERE id = p_journal_id AND legal_entity_id = entity AND status = 'POSTED';
  IF NOT FOUND THEN RAISE EXCEPTION 'the journal was not found in this legal entity' USING ERRCODE = 'no_data_found'; END IF;
  SELECT bool_and(abos.report_line_visible(entity, actor, line.project_id, line.department_id, line.cost_center_id)) INTO visible
    FROM abos.journal_lines line WHERE line.journal_id = journal.id;
  SELECT * INTO intent FROM abos.posting_intents WHERE id = journal.posting_intent_id;
  -- The reason is free text about the business record, so it follows that record's permission.
  may_read_reason := visible AND abos.report_source_readable(abos.report_effective_source_type(journal.id), perms);
  RETURN jsonb_build_object(
    'journalId', journal.id, 'reference', CASE WHEN visible THEN abos.report_journal_reference(journal.id, perms) END, 'restricted', NOT visible,
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
    'reversedBy', (SELECT jsonb_build_object('journalId', l.reversal_journal_id, 'reference', CASE WHEN visible THEN abos.report_journal_reference(r.id, perms) END,
        'date', r.accounting_effective_date, 'reason', CASE WHEN may_read_reason THEN l.reason END)
      FROM abos.journal_reversal_links l JOIN abos.journals r ON r.id = l.reversal_journal_id WHERE l.original_journal_id = journal.id),
    'reverses', (SELECT jsonb_build_object('journalId', l.original_journal_id, 'reference', CASE WHEN visible THEN abos.report_journal_reference(o.id, perms) END,
        'date', o.accounting_effective_date, 'reason', CASE WHEN may_read_reason THEN l.reason END)
      FROM abos.journal_reversal_links l JOIN abos.journals o ON o.id = l.original_journal_id WHERE l.reversal_journal_id = journal.id));
END
$function$;

CREATE OR REPLACE FUNCTION abos.finance_journal_reversal_workspace(p_proof text, p_runtime text, p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE c jsonb; actor uuid; entity uuid; perms jsonb; approval boolean;
BEGIN
  c := abos.operational_finance_actor(p_proof, p_runtime, p_token, NULL);
  actor := (c->>'userAccountId')::uuid; entity := (c->>'legalEntityId')::uuid; perms := COALESCE(c->'permissions', '[]'::jsonb);
  IF NOT (perms ?| ARRAY['finance.reversal.direct', 'finance.reversal.request', 'finance.reversal.approve']) THEN
    RAISE EXCEPTION 'current authority is missing finance.reversal.direct, finance.reversal.request or finance.reversal.approve'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  approval := abos.workflow_setting_requires_approval(entity, 'JOURNAL_REVERSAL');
  RETURN jsonb_build_object(
    'today', abos.business_today(), 'approvalRequired', approval,
    'canReverseDirectly', perms ? 'finance.reversal.direct' AND NOT approval,
    'canRequest', perms ? 'finance.reversal.request', 'canApprove', perms ? 'finance.reversal.approve',
    'journals', COALESCE((SELECT jsonb_agg(row ORDER BY posted_at DESC) FROM (
      SELECT j.posted_at, jsonb_build_object('id', j.id, 'reference', abos.report_journal_reference(j.id, perms), 'date', j.accounting_effective_date,
        'sourceType', i.source_type, 'amount', i.original_amount::text, 'currency', i.original_currency_code,
        'postedBy', (SELECT display_name FROM abos.user_accounts WHERE id = j.posted_by_user_account_id),
        'periodStatus', CASE WHEN abos.financial_year_closed_on(entity, j.accounting_effective_date) THEN 'CLOSED' ELSE p.status END,
        'blocker', abos.reversal_journal_blocker(j.id, entity),
        'viewerIsParticipant', actor = ANY (abos.reversal_journal_participants(j.id)),
        'lines', (SELECT jsonb_agg(jsonb_build_object('lineNumber', l.line_number, 'accountCode', a.account_code, 'accountName', a.account_name,
            'debit', l.base_debit::text, 'credit', l.base_credit::text) ORDER BY l.line_number)
          FROM abos.journal_lines l JOIN abos.ledger_accounts a ON a.id = l.ledger_account_id WHERE l.journal_id = j.id),
        'reversal', (SELECT jsonb_build_object('journalId', rj.id, 'reference', abos.report_journal_reference(rj.id, perms), 'date', rj.accounting_effective_date,
            'reason', CASE WHEN abos.report_source_readable(i.source_type, perms) THEN link.reason END, 'selfReversal', link.self_reversal, 'mode', link.reversal_mode)
            FROM abos.journal_reversal_links link JOIN abos.journals rj ON rj.id = link.reversal_journal_id
          WHERE link.original_journal_id = j.id)) AS row
        FROM abos.journals j JOIN abos.posting_intents i ON i.id = j.posting_intent_id
        JOIN abos.posting_sources s ON s.source_type = i.source_type AND s.status = 'ACTIVE' AND s.reversible
        JOIN abos.accounting_periods p ON p.id = j.accounting_period_id
       WHERE j.legal_entity_id = entity AND j.status = 'POSTED' AND j.processing_model = 'OPERATIONAL_V1'
         AND abos.reversal_journal_in_scope(j.id, entity, actor)
       ORDER BY j.posted_at DESC LIMIT 100) x), '[]'::jsonb),
    'requests', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', r.id, 'journalId', r.journal_id, 'journalReference', abos.report_journal_reference(j.id, perms),
        'status', r.status, 'reason', r.reason, 'version', r.version,
        'requestedBy', (SELECT display_name FROM abos.user_accounts WHERE id = r.requested_by_user_account_id), 'requestedAt', r.requested_at,
        'decidedBy', (SELECT display_name FROM abos.user_accounts WHERE id = r.decided_by_user_account_id), 'decidedAt', r.decided_at,
        'decisionNote', r.decision_note, 'viewerIsRequester', r.requested_by_user_account_id = actor,
        'viewerIsParticipant', actor = ANY (abos.reversal_journal_participants(r.journal_id)),
        'reversalJournalId', (SELECT reversal_journal_id FROM abos.journal_reversal_links WHERE original_journal_id = r.journal_id))
        ORDER BY r.requested_at DESC)
      FROM abos.journal_reversal_requests r JOIN abos.journals j ON j.id = r.journal_id
     WHERE r.legal_entity_id = entity AND abos.reversal_journal_in_scope(r.journal_id, entity, actor)), '[]'::jsonb));
END
$function$;
