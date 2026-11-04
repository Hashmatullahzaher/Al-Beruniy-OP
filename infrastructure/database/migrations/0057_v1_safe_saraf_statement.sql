-- 0057: Slice 7 part 2. The Safe and Saraf statement, and one rule for what a reader may learn about a journal's source.
--
-- Reports still derive only from posted journals and their lines. This migration adds no table, no row and no journal, and one
-- measured index.
--
-- 1. Shared primitives:
--    report_source_readable    the one test of whether a reader may see the business record behind a journal. It fails closed:
--                              a source type it does not name is not readable.
--    report_journal_reference  a journal's reference for one reader. CAP-, RC-, PY-, TR-, OB- and TFS- references embed the
--                              source record's id, so a reader who may not see the source gets a neutral JRN- reference.
--    report_journal_source     restated: expense, receipt, payment, transfer and opening-balance sources now need their own
--                              module's permission, as capital and funding already did. It also carries the business
--                              reference and description, under the same test.
--    report_effective_source_type  what a journal really was: a reversal counts as the source it reverses, so summaries can
--                              keep transfers and their reversals out of company money in and money out.
--    treasury_account_base_balance  a Treasury account's accounting value, replacing the inline sum in the Safes workspace.
--    treasury_account_movements    restated over report_line_visible, retiring its inline copy of the scope test.
-- 2. treasury_account_statement: one Safe, cash box, petty cash or Saraf, native currency first. It takes its opening and
--    closing from treasury_account_balances, the one Treasury balance, and proves them against the ledger account.
-- 3. The Account Statement, journal detail, reversal list, General Ledger sources and Safes workspace use the masked reference.
--
-- Confidentiality hides detail, never money: a reader without the source permission still sees the correct amount and balance.

-- ---------------------------------------------------------------------------------------------
-- 1. Primitives.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION abos.report_source_readable(p_source_type text, p_permissions jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $readable$
  SELECT CASE
    WHEN p_source_type = 'DIRECT_SHAREHOLDER_CAPITAL' THEN p_permissions ?| ARRAY['shareholder.read', 'shareholder.capital-receipt.read']
    WHEN p_source_type IN ('TEMPORARY_FUNDING', 'TEMPORARY_FUNDING_SETTLEMENT') THEN p_permissions ? 'finance.temporary-funding.read'
    WHEN p_source_type = 'OPERATIONAL_EXPENSE' THEN p_permissions ? 'finance.expense.read'
    WHEN p_source_type IN ('CASH_RECEIPT', 'PAYMENT', 'TREASURY_TRANSFER', 'OPENING_BALANCE') THEN p_permissions ? 'treasury.safe.read'
    WHEN p_source_type = 'REVERSAL' THEN true
    ELSE false END
$readable$;

CREATE FUNCTION abos.report_journal_reference(p_journal uuid, p_permissions jsonb)
RETURNS text LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $reference$
  SELECT CASE WHEN abos.report_source_readable(intent.source_type, p_permissions) THEN journal.journal_reference
              ELSE 'JRN-' || upper(left(replace(journal.id::text, '-', ''), 12)) END
    FROM abos.journals journal JOIN abos.posting_intents intent ON intent.id = journal.posting_intent_id
   WHERE journal.id = p_journal
$reference$;

CREATE FUNCTION abos.report_effective_source_type(p_journal uuid)
RETURNS text LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $effective$
  SELECT CASE WHEN intent.source_type = 'REVERSAL' THEN (
      SELECT original_intent.source_type FROM abos.journal_reversal_links link
        JOIN abos.journals original ON original.id = link.original_journal_id
        JOIN abos.posting_intents original_intent ON original_intent.id = original.posting_intent_id
       WHERE link.reversal_journal_id = journal.id)
    ELSE intent.source_type END
    FROM abos.journals journal JOIN abos.posting_intents intent ON intent.id = journal.posting_intent_id
   WHERE journal.id = p_journal
$effective$;

CREATE FUNCTION abos.treasury_account_base_balance(p_entity uuid, p_as_of date, p_account uuid)
RETURNS numeric LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $base$
  SELECT COALESCE(sum(entry.base_amount), 0)
    FROM abos.subledger_entries entry
    JOIN abos.journal_lines line ON line.id = entry.journal_line_id
    JOIN abos.journals journal ON journal.id = line.journal_id AND journal.status = 'POSTED'
   WHERE entry.subledger_type = 'OPERATIONAL_TREASURY' AND entry.operational_treasury_account_id = p_account
     AND entry.legal_entity_id = p_entity AND (p_as_of IS NULL OR journal.accounting_effective_date <= p_as_of)
$base$;

CREATE OR REPLACE FUNCTION abos.treasury_account_movements(p_entity uuid, p_account uuid, p_from date, p_to date, p_actor uuid)
RETURNS TABLE(journal_id uuid, effective_date date, amount numeric, source_type text, journal_reference text, restricted boolean, posted_at timestamp with time zone)
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $movements$
  -- A movement outside the reader's scope keeps its date, direction and amount but hides its reference.
  SELECT journal.id, journal.accounting_effective_date, entry.original_amount, entry.source_type,
         CASE WHEN visible.ok THEN journal.journal_reference END, NOT visible.ok, journal.posted_at
    FROM abos.subledger_entries entry
    JOIN abos.journal_lines line ON line.id = entry.journal_line_id
    JOIN abos.journals journal ON journal.id = line.journal_id AND journal.status = 'POSTED'
    CROSS JOIN LATERAL (SELECT abos.report_line_visible(p_entity, p_actor, line.project_id, line.department_id, line.cost_center_id) AS ok) visible
   WHERE entry.subledger_type = 'OPERATIONAL_TREASURY' AND entry.legal_entity_id = p_entity
     AND entry.operational_treasury_account_id = p_account
     AND (p_from IS NULL OR journal.accounting_effective_date >= p_from)
     AND (p_to IS NULL OR journal.accounting_effective_date <= p_to)
   ORDER BY journal.accounting_effective_date DESC, journal.posted_at DESC, journal.id
$movements$;

-- A journal's business source for one reader. Without the source module's permission only the generic label remains: no id,
-- link, counterparty, reference or description. Outside the reader's scope the journal is RESTRICTED. Amounts are never hidden.
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
  readable := abos.report_source_readable(intent.source_type, p_permissions);
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

-- ---------------------------------------------------------------------------------------------
-- 2. The Safe and Saraf statement.
-- ---------------------------------------------------------------------------------------------
-- Without accountId it returns the accounts this reader may open. With it, the statement: the native opening, every posted
-- movement in order with its running native balance, the native closing, the accounting value as secondary information, and
-- the proof that the Treasury accounting value equals the ledger account.
CREATE FUNCTION abos.treasury_account_statement(p_proof text, p_runtime text, p_token text, p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $statement$
DECLARE c jsonb; entity uuid; actor uuid; perms jsonb; source_perms jsonb; read_all boolean; can_ledger boolean; base text; accounts jsonb;
  account_id uuid; account record; ledger record; range jsonb; v_from date; v_to date; opening numeric; base_opening numeric;
  closing numeric; base_closing numeric; ledger_balance numeric; line_count bigint; lines jsonb; totals jsonb;
BEGIN
  c := abos.treasury_safe_actor(p_proof, p_runtime, p_token, NULL);
  entity := (c->>'legalEntityId')::uuid; actor := (c->>'userAccountId')::uuid; perms := COALESCE(c->'permissions', '[]'::jsonb);
  read_all := perms ?| ARRAY['treasury.safe.read', 'finance.report.operational.read'];
  can_ledger := perms ? 'finance.report.operational.read';
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_payload) k
       WHERE k NOT IN ('accountId', 'periodId', 'from', 'to', 'asOf')) THEN
    RAISE EXCEPTION 'unknown report fields' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT base_currency_code INTO base FROM abos.legal_entities WHERE id = entity;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', a.id, 'nameEn', a.name_en, 'nameFa', a.name_fa, 'accountType', a.account_type,
      'currencyCode', a.currency_code, 'status', a.status)
      ORDER BY CASE a.status WHEN 'ACTIVE' THEN 0 WHEN 'INACTIVE' THEN 1 ELSE 2 END, a.name_en, a.id), '[]'::jsonb)
    INTO accounts FROM abos.operational_treasury_accounts a
   WHERE a.legal_entity_id = entity AND (read_all OR EXISTS (SELECT 1 FROM abos.operational_treasury_account_responsibles r
       WHERE r.operational_treasury_account_id = a.id AND r.user_account_id = actor AND r.revoked_at IS NULL));
  IF NOT read_all AND jsonb_array_length(accounts) = 0 THEN
    RAISE EXCEPTION 'current authority is missing treasury.safe.read' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NULLIF(p_payload->>'accountId', '') IS NULL THEN
    RETURN jsonb_build_object('legalEntityId', entity, 'baseCurrency', base, 'accounts', accounts, 'statement', NULL);
  END IF;
  BEGIN
    account_id := (p_payload->>'accountId')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'choose a valid account' USING ERRCODE = 'invalid_parameter_value';
  END;
  -- An account the reader may not open is reported exactly like one that does not exist.
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(accounts) a WHERE a->>'id' = account_id::text) THEN
    RAISE EXCEPTION 'the Treasury account was not found in this legal entity' USING ERRCODE = 'no_data_found';
  END IF;
  SELECT id, name_en, name_fa, account_type, currency_code, status, ledger_account_id INTO account
    FROM abos.operational_treasury_accounts WHERE id = account_id AND legal_entity_id = entity;
  SELECT id, account_code, account_name INTO ledger FROM abos.ledger_accounts WHERE id = account.ledger_account_id AND legal_entity_id = entity;
  -- A person responsible for this Safe reads its Treasury sources, as a Safe reader does.
  source_perms := CASE WHEN perms ? 'treasury.safe.read' OR can_ledger THEN perms ELSE perms || '["treasury.safe.read"]'::jsonb END;
  range := abos.report_range(entity, p_payload - 'accountId');
  v_from := (range->>'from')::date; v_to := (range->>'to')::date;
  -- The opening and closing are the one Treasury balance, not a new sum.
  SELECT book_balance INTO opening FROM abos.treasury_account_balances(entity, v_from - 1, account.id);
  SELECT book_balance INTO closing FROM abos.treasury_account_balances(entity, v_to, account.id);
  base_opening := abos.treasury_account_base_balance(entity, v_from - 1, account.id);
  base_closing := abos.treasury_account_base_balance(entity, v_to, account.id);
  SELECT count(*) INTO line_count FROM abos.subledger_entries entry
    JOIN abos.journal_lines line ON line.id = entry.journal_line_id
    JOIN abos.journals journal ON journal.id = line.journal_id AND journal.status = 'POSTED'
   WHERE entry.subledger_type = 'OPERATIONAL_TREASURY' AND entry.legal_entity_id = entity AND entry.operational_treasury_account_id = account.id
     AND journal.accounting_effective_date BETWEEN v_from AND v_to;
  IF line_count > 5000 THEN
    RAISE EXCEPTION 'this statement has % lines; choose a shorter period', line_count USING ERRCODE = 'program_limit_exceeded';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', x.entry_id, 'date', x.effective_date, 'postedAt', x.posted_at,
      'moneyIn', greatest(x.amount, 0)::text, 'moneyOut', greatest(-x.amount, 0)::text, 'balance', (opening + x.running)::text,
      'currency', x.currency, 'baseAmount', x.base_amount::text, 'restricted', NOT x.visible, 'kind', x.kind, 'isReversal', x.is_reversal,
      'fx', CASE WHEN x.visible AND x.currency <> base THEN (SELECT jsonb_build_object('rate', s.rate_value::text, 'unitCurrency', s.unit_currency_code,
          'quoteCurrency', s.quote_currency_code, 'rateDate', s.rate_date, 'source', s.rate_source, 'policyVersionId', conversion.fx_policy_version_id,
          'roundingMode', conversion.rounding_mode, 'baseScale', conversion.base_scale,
          'exactBaseAmount', conversion.exact_base_amount::text, 'roundingDifference', conversion.rounding_difference::text)
        FROM abos.exchange_rate_snapshots s LEFT JOIN abos.fx_conversions conversion ON conversion.exchange_rate_snapshot_id = s.id
        WHERE s.id::text = x.conversion_snapshot_reference AND s.legal_entity_id = entity) END,
      'journalId', CASE WHEN x.visible AND can_ledger THEN x.journal_id END,
      'journalReference', CASE WHEN x.visible THEN abos.report_journal_reference(x.journal_id, source_perms) END,
      'source', abos.report_journal_source(entity, x.journal_id, source_perms, x.visible),
      'transferPeer', CASE WHEN x.visible AND read_all AND x.source_type = 'TREASURY_TRANSFER' AND abos.report_source_readable('TREASURY_TRANSFER', source_perms) THEN (
          SELECT jsonb_build_object('en', peer.name_en, 'fa', COALESCE(peer.name_fa, peer.name_en)) FROM abos.treasury_transfers transfer
            JOIN abos.operational_treasury_accounts peer ON peer.id = CASE WHEN transfer.source_treasury_account_id = account.id
              THEN transfer.destination_treasury_account_id ELSE transfer.source_treasury_account_id END
           WHERE transfer.journal_id = x.journal_id) END,
      'reversedBy', CASE WHEN x.visible THEN (SELECT jsonb_build_object('journalId', CASE WHEN can_ledger THEN l.reversal_journal_id END,
          'reference', abos.report_journal_reference(l.reversal_journal_id, source_perms), 'date', r.accounting_effective_date)
        FROM abos.journal_reversal_links l JOIN abos.journals r ON r.id = l.reversal_journal_id WHERE l.original_journal_id = x.journal_id) END,
      'reverses', CASE WHEN x.visible THEN (SELECT jsonb_build_object('journalId', CASE WHEN can_ledger THEN l.original_journal_id END,
          'reference', abos.report_journal_reference(l.original_journal_id, source_perms), 'date', o.accounting_effective_date)
        FROM abos.journal_reversal_links l JOIN abos.journals o ON o.id = l.original_journal_id WHERE l.reversal_journal_id = x.journal_id) END)
      ORDER BY x.effective_date, x.posted_at, x.journal_id, x.line_number), '[]'::jsonb),
    jsonb_build_object(
      'moneyIn', COALESCE(sum(greatest(x.amount, 0)), 0)::text, 'moneyOut', COALESCE(sum(greatest(-x.amount, 0)), 0)::text,
      'transfersIn', COALESCE(sum(greatest(x.amount, 0)) FILTER (WHERE x.kind = 'TRANSFER'), 0)::text,
      'transfersOut', COALESCE(sum(greatest(-x.amount, 0)) FILTER (WHERE x.kind = 'TRANSFER'), 0)::text,
      'reversalsIn', COALESCE(sum(greatest(x.amount, 0)) FILTER (WHERE x.is_reversal), 0)::text,
      'reversalsOut', COALESCE(sum(greatest(-x.amount, 0)) FILTER (WHERE x.is_reversal), 0)::text,
      'movementCount', count(*))
    INTO lines, totals
    FROM (SELECT entry.id AS entry_id, journal.id AS journal_id, line.line_number, journal.accounting_effective_date AS effective_date, journal.posted_at,
                 entry.original_amount AS amount, entry.original_currency_code AS currency, entry.base_amount, line.conversion_snapshot_reference,
                 intent.source_type, intent.source_type = 'REVERSAL' AS is_reversal,
                 CASE abos.report_effective_source_type(journal.id) WHEN 'TREASURY_TRANSFER' THEN 'TRANSFER' WHEN 'OPENING_BALANCE' THEN 'OPENING' ELSE 'EXTERNAL' END AS kind,
                 abos.report_line_visible(entity, actor, line.project_id, line.department_id, line.cost_center_id) AS visible,
                 sum(entry.original_amount) OVER (ORDER BY journal.accounting_effective_date, journal.posted_at, journal.id, line.line_number
                   ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running
            FROM abos.subledger_entries entry
            JOIN abos.journal_lines line ON line.id = entry.journal_line_id
            JOIN abos.journals journal ON journal.id = line.journal_id AND journal.status = 'POSTED'
            JOIN abos.posting_intents intent ON intent.id = journal.posting_intent_id
           WHERE entry.subledger_type = 'OPERATIONAL_TREASURY' AND entry.legal_entity_id = entity AND entry.operational_treasury_account_id = account.id
             AND journal.accounting_effective_date BETWEEN v_from AND v_to) x;
  SELECT COALESCE(sum(b.opening_debit - b.opening_credit + b.period_debit - b.period_credit), 0) INTO ledger_balance
    FROM abos.report_account_balances(entity, v_from, v_to) b WHERE b.ledger_account_id = account.ledger_account_id;
  RETURN jsonb_build_object('legalEntityId', entity, 'baseCurrency', base, 'accounts', accounts, 'statement', jsonb_build_object(
    'range', range, 'canOpenLedger', can_ledger,
    'account', jsonb_build_object('id', account.id, 'nameEn', account.name_en, 'nameFa', account.name_fa, 'accountType', account.account_type,
      'currencyCode', account.currency_code, 'status', account.status,
      'ledgerAccount', CASE WHEN can_ledger THEN jsonb_build_object('id', ledger.id, 'code', ledger.account_code, 'name', ledger.account_name) END),
    'opening', jsonb_build_object('native', opening::text, 'base', base_opening::text),
    'closing', jsonb_build_object('native', closing::text, 'base', base_closing::text),
    'totals', totals, 'lines', lines,
    'reconciliation', jsonb_build_object('treasuryBase', base_closing::text, 'ledgerBase', ledger_balance::text,
      'difference', (base_closing - ledger_balance)::text, 'matches', base_closing = ledger_balance)));
END
$statement$;

-- The business source of up to 100 journals, for the General Ledger page. The page's own function runs as another owner and knows
-- no source permission, so this also gives the reference the reader may see: none at all for a journal outside their scope.
CREATE OR REPLACE FUNCTION abos.finance_journal_sources(p_proof text, p_runtime text, p_token text, p_journal_ids uuid[])
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $sources$
DECLARE c jsonb; entity uuid; actor uuid; perms jsonb;
BEGIN
  c := abos.operational_finance_actor(p_proof, p_runtime, p_token, 'finance.report.operational.read');
  entity := (c->>'legalEntityId')::uuid; actor := (c->>'userAccountId')::uuid; perms := COALESCE(c->'permissions', '[]'::jsonb);
  IF p_journal_ids IS NULL OR cardinality(p_journal_ids) > 100 THEN
    RAISE EXCEPTION 'between 0 and 100 journals may be requested at once' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN COALESCE((SELECT jsonb_object_agg(v.id, jsonb_build_object('journalReference', CASE WHEN v.visible THEN abos.report_journal_reference(v.id, perms) END)
        || abos.report_journal_source(entity, v.id, perms, v.visible))
    FROM (SELECT j.id,
                 -- Fail closed: a journal whose visibility cannot be established is treated as restricted.
                 COALESCE((SELECT bool_and(abos.report_line_visible(entity, actor, line.project_id, line.department_id, line.cost_center_id))
                    FROM abos.journal_lines line WHERE line.journal_id = j.id), false) AS visible
            FROM abos.journals j WHERE j.id = ANY(p_journal_ids) AND j.legal_entity_id = entity AND j.status = 'POSTED') v), '{}'::jsonb);
END
$sources$;

-- ---------------------------------------------------------------------------------------------
-- 3. The masked reference in the existing reports. Each differs from 0056 only in where the reference comes from.
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION abos.finance_account_statement(p_proof text, p_runtime text, p_token text, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE c jsonb; entity uuid; actor uuid; perms jsonb; range jsonb; v_from date; v_to date; account record;
  account_id uuid; opening numeric; line_count bigint; lines jsonb;
BEGIN
  c := abos.operational_finance_actor(p_proof, p_runtime, p_token, 'finance.report.operational.read');
  entity := (c->>'legalEntityId')::uuid; actor := (c->>'userAccountId')::uuid; perms := COALESCE(c->'permissions', '[]'::jsonb);
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_payload) k
       WHERE k NOT IN ('accountId', 'periodId', 'from', 'to', 'asOf')) THEN
    RAISE EXCEPTION 'unknown report fields' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  BEGIN
    account_id := NULLIF(p_payload->>'accountId', '')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'choose a valid account' USING ERRCODE = 'invalid_parameter_value';
  END;
  SELECT id, account_code, account_name, account_type, control_account_type, account_currency_code, status INTO account
    FROM abos.ledger_accounts WHERE id = account_id AND legal_entity_id = entity;
  IF NOT FOUND THEN RAISE EXCEPTION 'the ledger account was not found in this legal entity' USING ERRCODE = 'no_data_found'; END IF;
  range := abos.report_range(entity, p_payload - 'accountId');
  v_from := (range->>'from')::date; v_to := (range->>'to')::date;
  -- The opening of this one account: all its posted lines before the start (journal_lines_account_idx).
  SELECT COALESCE(sum(line.base_debit) - sum(line.base_credit), 0) INTO opening
    FROM abos.journal_lines line JOIN abos.journals journal ON journal.id = line.journal_id AND journal.legal_entity_id = line.legal_entity_id
   WHERE line.ledger_account_id = account.id AND line.legal_entity_id = entity AND journal.status = 'POSTED'
     AND journal.accounting_effective_date < v_from;
  SELECT count(*) INTO line_count FROM abos.journal_lines line JOIN abos.journals journal ON journal.id = line.journal_id
   WHERE line.legal_entity_id = entity AND line.ledger_account_id = account.id AND journal.status = 'POSTED'
     AND journal.accounting_effective_date BETWEEN v_from AND v_to;
  IF line_count > 5000 THEN
    RAISE EXCEPTION 'this statement has % lines; choose a shorter period', line_count USING ERRCODE = 'program_limit_exceeded';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'journalId', x.journal_id, 'lineNumber', x.line_number, 'date', x.effective_date, 'postedAt', x.posted_at,
      'debit', x.base_debit::text, 'credit', x.base_credit::text, 'balance', (opening + x.running)::text,
      'originalAmount', x.original_amount::text, 'originalCurrency', x.original_currency_code,
      'rate', CASE WHEN x.visible THEN (SELECT jsonb_build_object('rate', s.rate_value::text, 'unitCurrency', s.unit_currency_code,
          'quoteCurrency', s.quote_currency_code, 'rateDate', s.rate_date, 'source', s.rate_source)
        FROM abos.exchange_rate_snapshots s WHERE s.id::text = x.conversion_snapshot_reference AND s.legal_entity_id = entity) END,
      'restricted', NOT x.visible,
      'journalReference', CASE WHEN x.visible THEN abos.report_journal_reference(x.journal_id, perms) END,
      'source', abos.report_journal_source(entity, x.journal_id, perms, x.visible),
      'reversedBy', CASE WHEN x.visible THEN (SELECT jsonb_build_object('journalId', l.reversal_journal_id, 'reference', abos.report_journal_reference(r.id, perms),
          'date', r.accounting_effective_date) FROM abos.journal_reversal_links l JOIN abos.journals r ON r.id = l.reversal_journal_id
        WHERE l.original_journal_id = x.journal_id) END,
      'reverses', CASE WHEN x.visible THEN (SELECT jsonb_build_object('journalId', l.original_journal_id, 'reference', abos.report_journal_reference(o.id, perms),
          'date', o.accounting_effective_date) FROM abos.journal_reversal_links l JOIN abos.journals o ON o.id = l.original_journal_id
        WHERE l.reversal_journal_id = x.journal_id) END)
      ORDER BY x.effective_date, x.posted_at, x.journal_id, x.line_number), '[]'::jsonb)
    INTO lines
    FROM (SELECT journal.id AS journal_id, line.line_number, journal.accounting_effective_date AS effective_date, journal.posted_at,
                 journal.journal_reference, line.base_debit, line.base_credit, line.original_amount, line.original_currency_code,
                 line.conversion_snapshot_reference,
                 abos.report_line_visible(entity, actor, line.project_id, line.department_id, line.cost_center_id) AS visible,
                 sum(line.base_debit - line.base_credit) OVER (ORDER BY journal.accounting_effective_date, journal.posted_at, journal.id, line.line_number
                   ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running
            FROM abos.journal_lines line JOIN abos.journals journal ON journal.id = line.journal_id AND journal.legal_entity_id = line.legal_entity_id
           WHERE line.legal_entity_id = entity AND line.ledger_account_id = account.id AND journal.status = 'POSTED'
             AND journal.accounting_effective_date BETWEEN v_from AND v_to) x;
  RETURN jsonb_build_object('legalEntityId', entity, 'range', range,
    'account', jsonb_build_object('id', account.id, 'code', account.account_code, 'name', account.account_name, 'type', account.account_type,
      'controlType', account.control_account_type, 'currency', account.account_currency_code, 'status', account.status),
    'opening', jsonb_build_object('debit', greatest(opening, 0)::text, 'credit', greatest(-opening, 0)::text, 'net', opening::text),
    'lines', lines,
    'periodDebit', COALESCE((SELECT sum((l->>'debit')::numeric) FROM jsonb_array_elements(lines) l), 0)::text,
    'periodCredit', COALESCE((SELECT sum((l->>'credit')::numeric) FROM jsonb_array_elements(lines) l), 0)::text,
    'closing', (SELECT jsonb_build_object('debit', greatest(n, 0)::text, 'credit', greatest(-n, 0)::text, 'net', n::text)
      FROM (SELECT opening + COALESCE(sum((l->>'debit')::numeric - (l->>'credit')::numeric), 0) AS n FROM jsonb_array_elements(lines) l) t));
END
$function$;

CREATE OR REPLACE FUNCTION abos.finance_journal_detail(p_proof text, p_runtime text, p_token text, p_journal_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE c jsonb; entity uuid; actor uuid; perms jsonb; journal abos.journals%ROWTYPE; visible boolean; intent abos.posting_intents%ROWTYPE;
BEGIN
  c := abos.operational_finance_actor(p_proof, p_runtime, p_token, 'finance.report.operational.read');
  entity := (c->>'legalEntityId')::uuid; actor := (c->>'userAccountId')::uuid; perms := COALESCE(c->'permissions', '[]'::jsonb);
  SELECT * INTO journal FROM abos.journals WHERE id = p_journal_id AND legal_entity_id = entity AND status = 'POSTED';
  IF NOT FOUND THEN RAISE EXCEPTION 'the journal was not found in this legal entity' USING ERRCODE = 'no_data_found'; END IF;
  SELECT bool_and(abos.report_line_visible(entity, actor, line.project_id, line.department_id, line.cost_center_id)) INTO visible
    FROM abos.journal_lines line WHERE line.journal_id = journal.id;
  SELECT * INTO intent FROM abos.posting_intents WHERE id = journal.posting_intent_id;
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
        'date', r.accounting_effective_date, 'reason', CASE WHEN visible THEN l.reason END)
      FROM abos.journal_reversal_links l JOIN abos.journals r ON r.id = l.reversal_journal_id WHERE l.original_journal_id = journal.id),
    'reverses', (SELECT jsonb_build_object('journalId', l.original_journal_id, 'reference', CASE WHEN visible THEN abos.report_journal_reference(o.id, perms) END,
        'date', o.accounting_effective_date, 'reason', CASE WHEN visible THEN l.reason END)
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
        'reversal', (SELECT jsonb_build_object('journalId', rj.id, 'reference', rj.journal_reference, 'date', rj.accounting_effective_date,
            'reason', link.reason, 'selfReversal', link.self_reversal, 'mode', link.reversal_mode)
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

CREATE OR REPLACE FUNCTION abos.treasury_safes_workspace(p_proof text, p_runtime text, p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE c jsonb; actor uuid; entity uuid; perms jsonb; read_all boolean; base text;
BEGIN
  c := abos.treasury_safe_actor(p_proof, p_runtime, p_token, NULL);
  actor := (c->>'userAccountId')::uuid; entity := (c->>'legalEntityId')::uuid;
  perms := COALESCE(c->'permissions', '[]'::jsonb);
  read_all := perms ? 'treasury.safe.read';
  IF NOT read_all AND NOT EXISTS (SELECT 1 FROM abos.operational_treasury_account_responsibles r
       WHERE r.legal_entity_id = entity AND r.user_account_id = actor AND r.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'current authority is missing treasury.safe.read' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT base_currency_code INTO base FROM abos.legal_entities WHERE id = entity;
  RETURN jsonb_build_object(
    'today', abos.business_today(),
    'baseCurrency', base,
    'canRecordOpeningBalance', perms ? 'treasury.opening-balance.record',
    'canManageSafes', perms ? 'treasury.operational-account.manage',
    'canOpenLedger', perms ? 'finance.report.operational.read',
    'openingEquity', abos.opening_balance_equity_status(entity, base),
    'safes', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', account.id, 'nameEn', account.name_en, 'nameFa', account.name_fa, 'accountType', account.account_type,
        'currencyCode', account.currency_code, 'status', account.status, 'version', account.version,
        'ledgerAccount', jsonb_build_object('id', ledger.id, 'code', ledger.account_code, 'name', ledger.account_name),
        'balance', jsonb_build_object('opening', balance.opening_balance::text, 'inflows', balance.inflows::text,
          'outflows', balance.outflows::text, 'book', balance.book_balance::text, 'movementCount', balance.movement_count,
          'baseBook', abos.treasury_account_base_balance(entity, NULL, account.id)::text,
          'lastMovementDate', balance.last_movement_date),
        'openingBalance', (SELECT jsonb_build_object('id', ob.id, 'amount', ob.amount::text, 'currencyCode', ob.currency_code,
            'asOfDate', ob.as_of_date, 'reference', ob.reference, 'note', ob.note, 'transactionReference', ob.transaction_reference,
            'journalId', ob.journal_id, 'recordedAt', ob.created_at)
          || COALESCE((SELECT jsonb_build_object('reversal', jsonb_build_object('journalId', link.reversal_journal_id,
               'reference', reversal.journal_reference, 'date', reversal.accounting_effective_date, 'reason', link.reason))
             FROM abos.journal_reversal_links link JOIN abos.journals reversal ON reversal.id = link.reversal_journal_id
            WHERE link.original_journal_id = ob.journal_id), '{}'::jsonb)
          FROM abos.treasury_opening_balances ob WHERE ob.operational_treasury_account_id = account.id
         ORDER BY ob.created_at DESC LIMIT 1),
        'responsibles', COALESCE((SELECT jsonb_agg(jsonb_build_object('userAccountId', u.id, 'displayName', u.display_name)
            ORDER BY u.display_name, u.id)
          FROM abos.operational_treasury_account_responsibles r JOIN abos.user_accounts u ON u.id = r.user_account_id
          WHERE r.operational_treasury_account_id = account.id AND r.revoked_at IS NULL), '[]'::jsonb),
        'legacyLink', (SELECT jsonb_build_object('locationName', link.location_name, 'activationStatus', link.activation_status)
          FROM abos.treasury_account_legacy_links link WHERE link.operational_treasury_account_id = account.id LIMIT 1),
        'movements', COALESCE((SELECT jsonb_agg(jsonb_build_object('journalId', m.journal_id, 'date', m.effective_date,
            'direction', CASE WHEN m.amount > 0 THEN 'IN' ELSE 'OUT' END, 'amount', abs(m.amount)::text,
            'sourceType', m.source_type, 'reference', CASE WHEN NOT m.restricted THEN abos.report_journal_reference(m.journal_id, perms || '["treasury.safe.read"]'::jsonb) END, 'restricted', m.restricted)
            ORDER BY m.effective_date DESC, m.posted_at DESC, m.journal_id)
          FROM (SELECT * FROM abos.treasury_account_movements(entity, account.id, NULL, NULL, actor) LIMIT 25) m), '[]'::jsonb))
        ORDER BY CASE account.status WHEN 'ACTIVE' THEN 0 WHEN 'INACTIVE' THEN 1 ELSE 2 END, account.name_en, account.id)
      FROM abos.operational_treasury_accounts account
      JOIN abos.ledger_accounts ledger ON ledger.id = account.ledger_account_id AND ledger.legal_entity_id = account.legal_entity_id
      JOIN abos.treasury_account_balances(entity, NULL, NULL) balance ON balance.operational_treasury_account_id = account.id
     WHERE account.legal_entity_id = entity
       AND (read_all OR EXISTS (SELECT 1 FROM abos.operational_treasury_account_responsibles r
             WHERE r.operational_treasury_account_id = account.id AND r.user_account_id = actor AND r.revoked_at IS NULL))), '[]'::jsonb),
    'assignableUsers', CASE WHEN perms ? 'treasury.operational-account.manage' THEN COALESCE((SELECT jsonb_agg(
        jsonb_build_object('userAccountId', u.id, 'displayName', u.display_name) ORDER BY u.display_name, u.id)
      FROM abos.user_accounts u WHERE u.status = 'ACTIVE' AND EXISTS (SELECT 1 FROM abos.user_permission_grants g
        WHERE g.user_account_id = u.id AND g.legal_entity_id = entity AND g.revoked_at IS NULL)), '[]'::jsonb) ELSE '[]'::jsonb END);
END
$function$;

-- ---------------------------------------------------------------------------------------------
-- 4. One measured index. At 50,000 lines the Treasury balance fell from 100 ms to 21 ms; it runs for every Safe on the Safes page.
-- ---------------------------------------------------------------------------------------------
CREATE INDEX subledger_entries_operational_treasury_account_idx ON abos.subledger_entries (operational_treasury_account_id)
  WHERE subledger_type = 'OPERATIONAL_TREASURY';

-- ---------------------------------------------------------------------------------------------
-- 5. Ownership and grants: the primitives run only inside the owner's report functions.
-- ---------------------------------------------------------------------------------------------
REVOKE ALL ON FUNCTION abos.report_source_readable(text, jsonb), abos.report_journal_reference(uuid, jsonb),
  abos.report_effective_source_type(uuid), abos.treasury_account_base_balance(uuid, date, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION abos.report_source_readable(text, jsonb), abos.report_journal_reference(uuid, jsonb),
  abos.report_effective_source_type(uuid), abos.treasury_account_base_balance(uuid, date, uuid) TO abos_v1_operational_finance_owner;

ALTER FUNCTION abos.treasury_account_statement(text, text, text, jsonb) OWNER TO abos_v1_operational_finance_owner;
REVOKE ALL ON FUNCTION abos.treasury_account_statement(text, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION abos.treasury_account_statement(text, text, text, jsonb) TO abos_e1_runtime;
