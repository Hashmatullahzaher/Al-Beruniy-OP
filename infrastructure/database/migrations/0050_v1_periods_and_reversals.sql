-- 0050: Slice 5 - period close / reopen and reversal posting (docs/03-architecture/PERIODS_AND_REVERSALS.md).
--
-- * Close: finance.period.manage closes an OPEN month after a preview; only a journal that is not posted
--   refuses it. Reopen: finance.period.reopen with a mandatory reason; Simple Mode reopens directly,
--   Advanced Mode (PERIOD_REOPEN ON) needs a second person. Every step is an append-only event.
-- * REVERSAL becomes an ACTIVE posting source through the one kernel: an exact inverse of a posted
--   operational journal, linked immutably to it, on the original date while that month is open and
--   otherwise on the Kabul business day. Simple Mode: finance.reversal.direct reverses directly.
--   Advanced Mode (JOURNAL_REVERSAL ON): request -> independent approval -> the same writer posts.
-- * Direct shareholder capital becomes reversible; temporary funding stays non-reversible.
-- No journal, period state or business row is written by this migration.

-- ---------------------------------------------------------------------------------------------
-- 1. Permissions (catalogue v13) and the two new approval settings.
-- ---------------------------------------------------------------------------------------------
INSERT INTO abos.permission_catalogue
  (permission_code, catalogue_version, category, availability, independence_enforced, administrative, sort_order)
SELECT code, 13, 'FINANCE', 'ACTIVE', false, false, (SELECT max(sort_order) FROM abos.permission_catalogue) + n
  FROM (VALUES ('finance.period.reopen', 1), ('finance.reversal.direct', 2)) AS v(code, n);

ALTER TABLE abos.finance_workflow_types DROP CONSTRAINT finance_workflow_types_workflow_type_check;
ALTER TABLE abos.finance_workflow_types ADD CONSTRAINT finance_workflow_types_workflow_type_check CHECK (workflow_type IN (
  'SHAREHOLDER_CAPITAL_RECEIPT', 'CUSTOMER_RECEIPT', 'OTHER_INCOME', 'EXPENSE', 'SUPPLIER_PAYMENT', 'SALARY_PAYMENT',
  'TREASURY_TRANSFER', 'TEMPORARY_FUNDING', 'CHART_OF_ACCOUNTS', 'PERIOD_REOPEN', 'JOURNAL_REVERSAL'));
INSERT INTO abos.finance_workflow_types (workflow_type, label_en, label_fa, sort_order) VALUES
  ('PERIOD_REOPEN', 'Reopening a closed month', 'بازگشایی ماه بسته‌شده', 100),
  ('JOURNAL_REVERSAL', 'Journal reversal', 'برگشت ژورنال', 110);

-- Simple Mode: a missing setting is approval OFF; only an explicit ON requires approval.
CREATE FUNCTION abos.workflow_setting_requires_approval(p_entity uuid, p_workflow_type text)
RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $setting$
  SELECT COALESCE((SELECT v.approval_required FROM abos.finance_workflow_policy_versions v
    WHERE v.legal_entity_id = p_entity AND v.workflow_type = p_workflow_type ORDER BY v.version DESC LIMIT 1), false)
$setting$;

-- ---------------------------------------------------------------------------------------------
-- 2. Period history and second-person reopen requests.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE abos.accounting_period_reopen_requests (
  id uuid PRIMARY KEY,
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  accounting_period_id uuid NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 5 AND 500 AND btrim(reason) = reason),
  status text NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED', 'CONFIRMED', 'REJECTED', 'WITHDRAWN')),
  requested_by_user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  decided_by_user_account_id uuid REFERENCES abos.user_accounts(id),
  decided_at timestamptz,
  decision_note text CHECK (decision_note IS NULL OR (length(btrim(decision_note)) BETWEEN 3 AND 500 AND btrim(decision_note) = decision_note)),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (id, legal_entity_id),
  FOREIGN KEY (accounting_period_id, legal_entity_id) REFERENCES abos.accounting_periods(id, legal_entity_id),
  CHECK ((status = 'REQUESTED') = (decided_by_user_account_id IS NULL)),
  CHECK ((decided_by_user_account_id IS NULL) = (decided_at IS NULL)),
  CHECK (status <> 'WITHDRAWN' OR decided_by_user_account_id = requested_by_user_account_id),
  CHECK (status NOT IN ('CONFIRMED', 'REJECTED') OR decided_by_user_account_id <> requested_by_user_account_id),
  CHECK (status <> 'REJECTED' OR decision_note IS NOT NULL)
);
CREATE UNIQUE INDEX accounting_period_reopen_requests_one_open ON abos.accounting_period_reopen_requests (accounting_period_id)
  WHERE status = 'REQUESTED';

CREATE TABLE abos.accounting_period_events (
  id uuid PRIMARY KEY,
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  accounting_period_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('CLOSED', 'REOPENED', 'REOPEN_REQUESTED', 'REOPEN_REJECTED', 'REOPEN_WITHDRAWN')),
  from_status text NOT NULL,
  to_status text NOT NULL,
  reason text,
  reopen_request_id uuid,
  actor_user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  correlation_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (accounting_period_id, legal_entity_id) REFERENCES abos.accounting_periods(id, legal_entity_id),
  FOREIGN KEY (reopen_request_id, legal_entity_id) REFERENCES abos.accounting_period_reopen_requests(id, legal_entity_id),
  CHECK (action NOT IN ('REOPENED', 'REOPEN_REQUESTED', 'REOPEN_REJECTED') OR reason IS NOT NULL)
);
CREATE INDEX accounting_period_events_period_idx ON abos.accounting_period_events (accounting_period_id, occurred_at);
CREATE TRIGGER accounting_period_events_append_only BEFORE UPDATE OR DELETE ON abos.accounting_period_events
  FOR EACH ROW EXECUTE FUNCTION abos.prevent_audit_mutation();

-- ---------------------------------------------------------------------------------------------
-- 3. REVERSAL becomes an ACTIVE source; direct capital becomes reversible (temporary funding stays not).
-- ---------------------------------------------------------------------------------------------
ALTER TABLE abos.posting_sources DISABLE TRIGGER posting_sources_no_update_or_delete;
UPDATE abos.posting_sources SET intent_kind = 'REVERSAL', workflow_type = 'JOURNAL_REVERSAL', status = 'ACTIVE', line_count = 2,
  debit_rules = '[{"accountType":"ASSET"},{"accountType":"LIABILITY"},{"accountType":"EQUITY"},{"accountType":"REVENUE"},{"accountType":"EXPENSE"}]',
  credit_rules = '[{"accountType":"ASSET"},{"accountType":"LIABILITY"},{"accountType":"EQUITY"},{"accountType":"REVENUE"},{"accountType":"EXPENSE"}]',
  subledger_rules = '[{"type":"OPERATIONAL_TREASURY","side":"DEBIT","required":false},{"type":"OPERATIONAL_TREASURY","side":"CREDIT","required":false},
                      {"type":"SHAREHOLDER_CAPITAL","side":"DEBIT","required":false},{"type":"SHAREHOLDER_CAPITAL","side":"CREDIT","required":false}]',
  validator = 'validate_reversal_journal',
  description = 'Exact inversion of a posted operational journal, linked immutably to it (0050).'
 WHERE source_type = 'REVERSAL' AND status = 'PLANNED';
UPDATE abos.posting_sources SET reversible = true WHERE source_type = 'DIRECT_SHAREHOLDER_CAPITAL' AND NOT reversible;
ALTER TABLE abos.posting_sources ENABLE TRIGGER posting_sources_no_update_or_delete;
DO $check$ BEGIN
  IF (SELECT count(*) FROM abos.posting_sources WHERE (source_type = 'REVERSAL' AND status = 'ACTIVE')
        OR (source_type = 'DIRECT_SHAREHOLDER_CAPITAL' AND reversible)) <> 2 THEN
    RAISE EXCEPTION '0050 could not activate REVERSAL and make direct capital reversible';
  END IF;
END $check$;

-- 0040 refused every direct capital reversal while there was no reversal posting; the kernel validator
-- and the link guards now decide it.
DROP TRIGGER direct_capital_reversal_disabled ON abos.journal_reversal_links;

-- A posted opening balance is corrected by reversal and may then be recorded again: one opening balance
-- per Safe that has not been reversed (checked by the writer under the Safe lock).
ALTER TABLE abos.treasury_opening_balances DROP CONSTRAINT treasury_opening_balances_operational_treasury_account_id_key;
CREATE INDEX treasury_opening_balances_account_idx ON abos.treasury_opening_balances (operational_treasury_account_id);

-- Simple Mode self-correction (owner decision of 2026-10-29): the immutable link records how the reversal was
-- authorised and whether it corrects the reverser's own transaction.
ALTER TABLE abos.journal_reversal_links
  ADD COLUMN reversal_mode text NOT NULL DEFAULT 'APPROVED_REQUEST' CHECK (reversal_mode IN ('DIRECT', 'APPROVED_REQUEST')),
  ADD COLUMN self_reversal boolean NOT NULL DEFAULT false;
ALTER TABLE abos.journal_reversal_links
  ADD CONSTRAINT journal_reversal_links_self_only_direct CHECK (NOT self_reversal OR reversal_mode = 'DIRECT');

-- Segregation of duties, restated. A DIRECT reversal (Simple Mode, finance.reversal.direct) may correct the
-- reverser's own transaction, flagged truthfully; it is refused while reversals require approval. Every other
-- reversal keeps database-enforced independence from whoever prepared, approved or posted the original.
CREATE OR REPLACE FUNCTION abos.enforce_reversal_segregation_of_duties()
RETURNS trigger LANGUAGE plpgsql AS $sod$
DECLARE original_poster uuid; reversal_poster uuid; entity uuid; participants uuid[];
BEGIN
  SELECT posted_by_user_account_id, legal_entity_id INTO original_poster, entity FROM abos.journals WHERE id = NEW.original_journal_id;
  SELECT posted_by_user_account_id INTO reversal_poster FROM abos.journals WHERE id = NEW.reversal_journal_id;
  IF original_poster IS NULL OR reversal_poster IS NULL THEN
    RAISE EXCEPTION 'a reversal link requires both journals to record their posting actor';
  END IF;
  participants := abos.reversal_journal_participants(NEW.original_journal_id);
  IF NEW.reversal_mode = 'DIRECT' THEN
    IF abos.workflow_setting_requires_approval(entity, 'JOURNAL_REVERSAL') THEN
      RAISE EXCEPTION 'a direct reversal is not available while reversals require approval';
    END IF;
    IF reversal_poster <> NEW.approved_by_user_account_id THEN
      RAISE EXCEPTION 'a direct reversal is posted by the person who authorised it';
    END IF;
    IF NEW.self_reversal IS DISTINCT FROM (NEW.approved_by_user_account_id = ANY (participants)) THEN
      RAISE EXCEPTION 'a direct reversal must record truthfully whether it corrects the reverser''s own transaction';
    END IF;
    RETURN NEW;
  END IF;
  IF original_poster = reversal_poster THEN
    RAISE EXCEPTION 'the actor who posted a journal cannot also post its reversal';
  END IF;
  IF NEW.approved_by_user_account_id = original_poster THEN
    RAISE EXCEPTION 'the actor who posted a journal cannot approve its reversal';
  END IF;
  IF NEW.approved_by_user_account_id = ANY (participants) OR reversal_poster = ANY (participants) THEN
    RAISE EXCEPTION 'whoever prepared, approved or posted a journal cannot approve or post its reversal';
  END IF;
  RETURN NEW;
END
$sod$;

-- The Treasury balance read model (0045), restated: a reversal of an opening balance belongs to the opening
-- figure, so a fully reversed 2,500 opening balance shows an effective opening of 0 (owner decision of
-- 2026-10-29). The book balance is unchanged: it is still the sum of every posted movement.
CREATE OR REPLACE FUNCTION abos.treasury_account_balances(p_entity uuid, p_as_of date, p_account uuid)
RETURNS TABLE(operational_treasury_account_id uuid, currency_code text, opening_balance numeric, inflows numeric, outflows numeric,
  book_balance numeric, movement_count bigint, last_movement_date date)
LANGUAGE sql STABLE SET search_path TO 'pg_catalog', 'pg_temp' AS $balances$
  SELECT account.id, account.currency_code,
         COALESCE(sum(movement.amount) FILTER (WHERE movement.opening), 0),
         COALESCE(sum(movement.amount) FILTER (WHERE NOT movement.opening AND movement.amount > 0), 0),
         COALESCE(-sum(movement.amount) FILTER (WHERE NOT movement.opening AND movement.amount < 0), 0),
         COALESCE(sum(movement.amount), 0),
         count(movement.amount),
         max(movement.effective_date)
    FROM abos.operational_treasury_accounts account
    LEFT JOIN LATERAL (
      SELECT entry.original_amount AS amount, journal.accounting_effective_date AS effective_date,
             entry.source_type = 'OPENING_BALANCE' OR (entry.source_type = 'REVERSAL' AND EXISTS (
               SELECT 1 FROM abos.journals original JOIN abos.posting_intents intent ON intent.id = original.posting_intent_id
                WHERE original.id = entry.source_id AND intent.source_type = 'OPENING_BALANCE')) AS opening
        FROM abos.subledger_entries entry
        JOIN abos.journal_lines line ON line.id = entry.journal_line_id
        JOIN abos.journals journal ON journal.id = line.journal_id AND journal.status = 'POSTED'
       WHERE entry.subledger_type = 'OPERATIONAL_TREASURY'
         AND entry.operational_treasury_account_id = account.id
         AND entry.legal_entity_id = account.legal_entity_id
         AND (p_as_of IS NULL OR journal.accounting_effective_date <= p_as_of)) movement ON true
   WHERE account.legal_entity_id = p_entity AND (p_account IS NULL OR account.id = p_account)
   GROUP BY account.id, account.currency_code
$balances$;

-- ---------------------------------------------------------------------------------------------
-- 4. The reversal validator (static kernel dispatch) and the one internal reversal writer.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION abos.validate_reversal_journal(p_journal abos.journals, p_intent abos.posting_intents)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $validate$
DECLARE o abos.journals%ROWTYPE; oi abos.posting_intents%ROWTYPE; src abos.posting_sources%ROWTYPE; o_period abos.accounting_periods%ROWTYPE;
BEGIN
  SELECT * INTO o FROM abos.journals WHERE id = p_intent.source_id AND legal_entity_id = p_journal.legal_entity_id;
  IF NOT FOUND OR o.id = p_journal.id OR o.status <> 'POSTED' OR o.processing_model <> 'OPERATIONAL_V1'
     OR o.base_currency_code <> p_journal.base_currency_code THEN
    RAISE EXCEPTION 'a reversal must reverse a posted operational journal of the same company and currency' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO oi FROM abos.posting_intents WHERE id = o.posting_intent_id;
  SELECT * INTO src FROM abos.posting_sources WHERE source_type = oi.source_type;
  IF NOT FOUND OR src.status <> 'ACTIVE' OR NOT src.reversible OR oi.intent_kind = 'REVERSAL' THEN
    RAISE EXCEPTION 'this kind of journal cannot be reversed' USING ERRCODE = 'check_violation';
  END IF;
  IF p_intent.intent_kind <> 'REVERSAL' OR p_intent.source_type <> 'REVERSAL'
     OR p_intent.original_amount <> oi.original_amount OR p_intent.base_amount <> oi.base_amount
     OR p_intent.original_currency_code IS DISTINCT FROM oi.original_currency_code
     OR p_intent.conversion_snapshot_reference IS DISTINCT FROM oi.conversion_snapshot_reference THEN
    RAISE EXCEPTION 'a reversal must carry exactly the original amounts and currencies' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO o_period FROM abos.accounting_periods WHERE id = o.accounting_period_id;
  IF NOT ((p_journal.accounting_period_id = o.accounting_period_id AND p_journal.accounting_effective_date = o.accounting_effective_date)
       OR (o_period.status <> 'OPEN' AND p_journal.accounting_effective_date > o_period.ends_on)) THEN
    RAISE EXCEPTION 'a reversal posts on the original date while that month is open, otherwise in a later open month'
      USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT count(*) FROM abos.journal_lines WHERE journal_id = o.id) <> (SELECT count(*) FROM abos.journal_lines WHERE journal_id = p_journal.id)
     OR EXISTS (SELECT l.line_number, l.ledger_account_id, l.business_party_id, l.project_id, l.department_id, l.cost_center_id,
                       l.original_amount, l.original_currency_code, l.base_debit, l.base_credit
                  FROM abos.journal_lines l WHERE l.journal_id = o.id
                EXCEPT
                SELECT r.line_number, r.ledger_account_id, r.business_party_id, r.project_id, r.department_id, r.cost_center_id,
                       r.original_amount, r.original_currency_code, r.base_credit, r.base_debit
                  FROM abos.journal_lines r WHERE r.journal_id = p_journal.id) THEN
    RAISE EXCEPTION 'a reversal must invert every original line exactly' USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT count(*) FROM abos.subledger_entries e JOIN abos.journal_lines l ON l.id = e.journal_line_id WHERE l.journal_id = o.id)
       <> (SELECT count(*) FROM abos.subledger_entries e JOIN abos.journal_lines l ON l.id = e.journal_line_id WHERE l.journal_id = p_journal.id)
     OR EXISTS (SELECT l.line_number, e.subledger_type, e.operational_treasury_account_id, e.business_party_id,
                       -e.original_amount, -e.base_amount, e.original_currency_code
                  FROM abos.subledger_entries e JOIN abos.journal_lines l ON l.id = e.journal_line_id WHERE l.journal_id = o.id
                EXCEPT
                SELECT l.line_number, e.subledger_type, e.operational_treasury_account_id, e.business_party_id,
                       e.original_amount, e.base_amount, e.original_currency_code
                  FROM abos.subledger_entries e JOIN abos.journal_lines l ON l.id = e.journal_line_id WHERE l.journal_id = p_journal.id) THEN
    RAISE EXCEPTION 'a reversal must invert every original subledger movement exactly' USING ERRCODE = 'check_violation';
  END IF;
END
$validate$;

-- The one reversal writer. Runs inside the operational Finance owner's entry points only.
CREATE FUNCTION abos.reversal_post(p_entity uuid, p_actor uuid, p_approver uuid, p_journal uuid, p_reason text,
  p_request uuid, p_correlation uuid, p_mode text)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $post$
DECLARE o abos.journals%ROWTYPE; oi abos.posting_intents%ROWTYPE; src abos.posting_sources%ROWTYPE; blocker text;
  period_status text; day date; period uuid; l record; result jsonb; ref text; self boolean;
  lines abos.posting_kernel_line[] := ARRAY[]::abos.posting_kernel_line[];
  reversal uuid := gen_random_uuid(); intent uuid := gen_random_uuid(); evidence uuid := gen_random_uuid();
BEGIN
  -- One reversal at a time per journal: a concurrent second attempt waits here and then finds the link.
  SELECT * INTO o FROM abos.journals WHERE id = p_journal AND legal_entity_id = p_entity FOR UPDATE;
  IF NOT FOUND OR NOT abos.reversal_journal_in_scope(p_journal, p_entity, p_actor) THEN
    RAISE EXCEPTION 'journal not found' USING ERRCODE = 'no_data_found';
  END IF;
  blocker := abos.reversal_journal_blocker(p_journal, p_entity);
  IF blocker = 'NOT_POSTED' THEN RAISE EXCEPTION 'only a posted journal can be reversed' USING ERRCODE = 'check_violation';
  ELSIF blocker = 'IS_REVERSAL' THEN RAISE EXCEPTION 'this journal is itself a reversal; reversing a reversal is not available' USING ERRCODE = 'check_violation';
  ELSIF blocker = 'ALREADY_REVERSED' THEN RAISE EXCEPTION 'this journal has already been reversed' USING ERRCODE = 'check_violation';
  ELSIF blocker IN ('OPEN_REQUEST', 'APPROVED_REQUEST') AND p_request IS NULL THEN
    RAISE EXCEPTION 'this journal has a reversal request; decide that request instead' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO oi FROM abos.posting_intents WHERE id = o.posting_intent_id;
  SELECT * INTO src FROM abos.posting_sources WHERE source_type = oi.source_type;
  IF o.processing_model <> 'OPERATIONAL_V1' OR src.status IS DISTINCT FROM 'ACTIVE' OR NOT src.reversible THEN
    RAISE EXCEPTION 'this kind of transaction cannot be reversed yet' USING ERRCODE = 'check_violation';
  END IF;
  -- Simple Mode (DIRECT): the reverser may correct their own transaction; it is flagged as a self-correction.
  -- Approved requests keep independence from whoever prepared, approved or posted the original.
  self := p_actor = ANY (abos.reversal_journal_participants(p_journal));
  IF p_mode <> 'DIRECT' AND (self OR p_approver = ANY (abos.reversal_journal_participants(p_journal))) THEN
    RAISE EXCEPTION 'whoever prepared, approved or posted a journal cannot reverse it' USING ERRCODE = 'insufficient_privilege';
  END IF;
  self := self AND p_mode = 'DIRECT';
  SELECT status INTO period_status FROM abos.accounting_periods WHERE id = o.accounting_period_id FOR SHARE;
  IF period_status = 'OPEN' THEN
    day := o.accounting_effective_date; period := o.accounting_period_id;
  ELSE
    -- The original month is closed: the reversal goes to the current month, which is never reopened silently.
    day := abos.business_today(); period := abos.open_period_for_business_date(p_entity, p_actor, day);
  END IF;
  FOR l IN SELECT line.line_number, line.base_debit, line.ledger_account_id, line.business_party_id, line.project_id,
                  line.department_id, line.cost_center_id, entry.subledger_type, entry.original_amount AS movement,
                  entry.operational_treasury_account_id, entry.business_party_id AS movement_party
             FROM abos.journal_lines line LEFT JOIN abos.subledger_entries entry ON entry.journal_line_id = line.id
            WHERE line.journal_id = p_journal ORDER BY line.line_number LOOP
    lines := lines || ROW(l.line_number, CASE WHEN l.base_debit > 0 THEN 'CREDIT' ELSE 'DEBIT' END, l.ledger_account_id,
      l.business_party_id, l.project_id, l.department_id, l.cost_center_id, l.subledger_type,
      CASE WHEN l.subledger_type IS NULL THEN NULL WHEN l.movement > 0 THEN -1 ELSE 1 END,
      l.operational_treasury_account_id, l.movement_party)::abos.posting_kernel_line;
  END LOOP;
  ref := 'RV-' || to_char(day, 'YYYYMMDD') || '-' || upper(replace(reversal::text, '-', ''));
  PERFORM abos.posting_kernel_draft(
    p_intent_id => intent, p_journal_id => reversal, p_legal_entity_id => p_entity, p_source_type => 'REVERSAL', p_source_id => p_journal,
    p_original_amount => oi.original_amount, p_original_currency_code => oi.original_currency_code,
    p_base_amount => oi.base_amount, p_base_currency_code => oi.base_currency_code,
    p_accounting_effective_date => day, p_accounting_period_id => period, p_journal_reference => ref, p_correlation_id => p_correlation,
    p_idempotency_key => 'RV:' || p_journal::text, p_initial_status => 'VALIDATED', p_created_by_user_account_id => p_actor,
    p_lines => lines, p_project_id => oi.project_id, p_department_id => oi.department_id, p_cost_center_id => oi.cost_center_id,
    p_conversion_snapshot_reference => oi.conversion_snapshot_reference);
  PERFORM abos.posting_kernel_commit(intent, reversal, p_actor);
  -- The written reason is the evidence (owner decision #4).
  INSERT INTO abos.evidence_references (id, legal_entity_id, document_id, evidence_kind, evidence_version, sha256, completed_at)
  VALUES (evidence, p_entity, COALESCE(p_request, reversal), 'REVERSAL_REASON', 1,
          encode(sha256(convert_to(p_reason, 'UTF8')), 'hex'), clock_timestamp());
  INSERT INTO abos.journal_reversal_links (original_journal_id, reversal_journal_id, reason, approved_by_user_account_id, evidence_reference_id,
    reversal_mode, self_reversal)
  VALUES (p_journal, reversal, p_reason, p_approver, evidence, CASE WHEN p_mode = 'DIRECT' THEN 'DIRECT' ELSE 'APPROVED_REQUEST' END, self);
  result := jsonb_build_object('originalJournalId', p_journal, 'originalReference', o.journal_reference, 'reversalJournalId', reversal,
    'reference', ref, 'effectiveDate', day, 'postedInOriginalPeriod', period = o.accounting_period_id, 'selfReversal', self,
    'status', 'POSTED', 'replayed', false);
  PERFORM abos.money_audit(p_actor, p_entity, p_correlation, 'JOURNAL_REVERSAL_POSTED', 'JOURNAL', reversal,
    result || jsonb_build_object('mode', p_mode, 'requestId', p_request, 'approvedBy', p_approver, 'reason', p_reason));
  RETURN result;
END
$post$;

-- Expense effects of a day: posted expenses on their date, and each reversed expense negatively on the
-- reversal's date (a closed day is never rewritten).
CREATE FUNCTION abos.operational_expense_effects(p_entity uuid, p_date date)
RETURNS TABLE (id uuid, operational_expense_category_id uuid, original_currency_code text, original_amount numeric, base_amount numeric, n integer)
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $effects$
  SELECT e.id, e.operational_expense_category_id, e.original_currency_code, e.original_amount, e.base_amount, 1
    FROM abos.operational_expenses e
   WHERE e.legal_entity_id = p_entity AND e.status = 'POSTED' AND e.business_date = p_date
  UNION ALL
  SELECT e.id, e.operational_expense_category_id, e.original_currency_code, -e.original_amount, -e.base_amount, -1
    FROM abos.operational_expenses e
    JOIN abos.journal_reversal_links link ON link.original_journal_id = e.journal_id
    JOIN abos.journals reversal ON reversal.id = link.reversal_journal_id AND reversal.status = 'POSTED'
   WHERE e.legal_entity_id = p_entity AND e.status = 'POSTED' AND reversal.accounting_effective_date = p_date
$effects$;

-- ---------------------------------------------------------------------------------------------
-- 5. Reversal entry points (operational password session).
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION abos.reversal_reason(p_payload jsonb, p_field text)
RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $reason$
DECLARE v text := btrim(p_payload ->> p_field);
BEGIN
  IF v IS NULL OR length(v) NOT BETWEEN 10 AND 1000 THEN
    RAISE EXCEPTION 'write the reason for the reversal (10 to 1000 characters)' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN v;
END
$reason$;

CREATE FUNCTION abos.finance_journal_reversal_direct(p_proof text, p_runtime text, p_token text, p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $direct$
DECLARE c jsonb; actor uuid; entity uuid; journal uuid; reason text; key text; correlation uuid; scope text; replay jsonb; result jsonb;
BEGIN
  c := abos.operational_finance_actor(p_proof, p_runtime, p_token, 'finance.reversal.direct');
  actor := (c->>'userAccountId')::uuid; entity := (c->>'legalEntityId')::uuid;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' OR (p_payload - ARRAY['journalId','reason','idempotencyKey','correlationId']) <> '{}'::jsonb THEN
    RAISE EXCEPTION 'unknown reversal fields' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  BEGIN journal := (p_payload->>'journalId')::uuid; correlation := (p_payload->>'correlationId')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'choose a valid journal' USING ERRCODE = 'invalid_parameter_value'; END;
  key := btrim(p_payload->>'idempotencyKey');
  IF journal IS NULL OR correlation IS NULL OR key IS NULL OR length(key) NOT BETWEEN 8 AND 200 THEN
    RAISE EXCEPTION 'choose a valid journal and request identity' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  reason := abos.reversal_reason(p_payload, 'reason');
  IF abos.workflow_setting_requires_approval(entity, 'JOURNAL_REVERSAL') THEN
    RAISE EXCEPTION 'your company requires an approved request for reversals; send a reversal request' USING ERRCODE = 'check_violation';
  END IF;
  scope := 'finance:reversal:' || entity::text || ':' || actor::text;
  replay := abos.temporary_funding_idempotency_begin(scope, key,
    encode(sha256(convert_to((p_payload - 'correlationId')::text || actor::text, 'UTF8')), 'hex'), correlation);
  IF replay IS NOT NULL THEN RETURN replay || jsonb_build_object('replayed', true); END IF;
  result := abos.reversal_post(entity, actor, actor, journal, reason, NULL, correlation, 'DIRECT');
  PERFORM abos.temporary_funding_idempotency_complete(scope, key, 'JOURNAL_REVERSAL', (result->>'reversalJournalId')::uuid, result);
  RETURN result;
END
$direct$;

CREATE FUNCTION abos.finance_journal_reversal_request(p_proof text, p_runtime text, p_token text, p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $request$
DECLARE c jsonb; actor uuid; entity uuid; journal uuid; reason text; request uuid := gen_random_uuid();
BEGIN
  c := abos.operational_finance_actor(p_proof, p_runtime, p_token, 'finance.reversal.request');
  actor := (c->>'userAccountId')::uuid; entity := (c->>'legalEntityId')::uuid;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' OR (p_payload - ARRAY['journalId','reason']) <> '{}'::jsonb THEN
    RAISE EXCEPTION 'unknown reversal fields' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  BEGIN journal := (p_payload->>'journalId')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'choose a valid journal' USING ERRCODE = 'invalid_parameter_value'; END;
  reason := abos.reversal_reason(p_payload, 'reason');
  IF journal IS NULL OR NOT EXISTS (SELECT 1 FROM abos.journals WHERE id = journal AND legal_entity_id = entity)
     OR NOT abos.reversal_journal_in_scope(journal, entity, actor) THEN
    RAISE EXCEPTION 'journal not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM abos.journals j JOIN abos.posting_intents i ON i.id = j.posting_intent_id
       JOIN abos.posting_sources s ON s.source_type = i.source_type
      WHERE j.id = journal AND j.processing_model = 'OPERATIONAL_V1' AND s.status = 'ACTIVE' AND s.reversible) THEN
    RAISE EXCEPTION 'this kind of transaction cannot be reversed yet' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO abos.journal_reversal_requests (id, legal_entity_id, journal_id, reason, status, requested_by_user_account_id)
  VALUES (request, entity, journal, reason, 'REQUESTED', actor);
  PERFORM abos.money_audit(actor, entity, gen_random_uuid(), 'JOURNAL_REVERSAL_REQUESTED', 'JOURNAL_REVERSAL_REQUEST', request,
    jsonb_build_object('journalId', journal, 'reason', reason));
  RETURN jsonb_build_object('requestId', request, 'status', 'REQUESTED');
END
$request$;

CREATE FUNCTION abos.finance_journal_reversal_decide(p_proof text, p_runtime text, p_token text, p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $decide$
DECLARE c jsonb; actor uuid; entity uuid; r abos.journal_reversal_requests%ROWTYPE; request uuid; expected integer;
  decision text; note text; result jsonb;
BEGIN
  c := abos.operational_finance_actor(p_proof, p_runtime, p_token, 'finance.reversal.approve');
  actor := (c->>'userAccountId')::uuid; entity := (c->>'legalEntityId')::uuid;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' OR (p_payload - ARRAY['requestId','expectedVersion','decision','note']) <> '{}'::jsonb THEN
    RAISE EXCEPTION 'unknown reversal fields' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  BEGIN request := (p_payload->>'requestId')::uuid; expected := (p_payload->>'expectedVersion')::integer;
  EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'choose a valid request' USING ERRCODE = 'invalid_parameter_value'; END;
  decision := p_payload->>'decision'; note := NULLIF(btrim(p_payload->>'note'), '');
  IF decision IS NULL OR decision NOT IN ('APPROVED', 'REJECTED') THEN
    RAISE EXCEPTION 'the decision must be APPROVED or REJECTED' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF decision = 'REJECTED' AND (note IS NULL OR length(note) < 3) THEN
    RAISE EXCEPTION 'say why the reversal is rejected' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO r FROM abos.journal_reversal_requests WHERE id = request AND legal_entity_id = entity FOR UPDATE;
  IF NOT FOUND OR NOT abos.reversal_journal_in_scope(r.journal_id, entity, actor) THEN
    RAISE EXCEPTION 'reversal request not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF r.status <> 'REQUESTED' THEN
    IF r.status = decision AND r.decided_by_user_account_id = actor THEN
      RETURN jsonb_build_object('requestId', r.id, 'status', r.status, 'replayed', true,
        'reversalJournalId', (SELECT reversal_journal_id FROM abos.journal_reversal_links WHERE original_journal_id = r.journal_id));
    END IF;
    RAISE EXCEPTION 'this reversal request was already %', lower(r.status) USING ERRCODE = 'check_violation';
  END IF;
  IF expected IS DISTINCT FROM r.version THEN
    RAISE EXCEPTION 'the reversal request was changed by someone else' USING ERRCODE = 'serialization_failure';
  END IF;
  UPDATE abos.journal_reversal_requests SET status = decision, decided_by_user_account_id = actor, decided_at = clock_timestamp(),
    decision_note = note, version = version + 1 WHERE id = r.id;
  IF decision = 'APPROVED' THEN
    -- Independent approval posts in the same transaction through the same writer.
    result := abos.reversal_post(entity, actor, actor, r.journal_id, r.reason, r.id, gen_random_uuid(), 'APPROVED_REQUEST');
  ELSE
    PERFORM abos.money_audit(actor, entity, gen_random_uuid(), 'JOURNAL_REVERSAL_REJECTED', 'JOURNAL_REVERSAL_REQUEST', r.id,
      jsonb_build_object('journalId', r.journal_id, 'note', note));
    result := '{}'::jsonb;
  END IF;
  RETURN result || jsonb_build_object('requestId', r.id, 'status', decision, 'replayed', false);
END
$decide$;

CREATE FUNCTION abos.finance_journal_reversal_post_approved(p_proof text, p_runtime text, p_token text, p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $approved$
DECLARE c jsonb; actor uuid; entity uuid; r abos.journal_reversal_requests%ROWTYPE; request uuid; existing uuid;
BEGIN
  c := abos.operational_finance_actor(p_proof, p_runtime, p_token, 'finance.reversal.approve');
  actor := (c->>'userAccountId')::uuid; entity := (c->>'legalEntityId')::uuid;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' OR (p_payload - ARRAY['requestId']) <> '{}'::jsonb THEN
    RAISE EXCEPTION 'unknown reversal fields' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  BEGIN request := (p_payload->>'requestId')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'choose a valid request' USING ERRCODE = 'invalid_parameter_value'; END;
  SELECT * INTO r FROM abos.journal_reversal_requests WHERE id = request AND legal_entity_id = entity FOR UPDATE;
  IF NOT FOUND OR NOT abos.reversal_journal_in_scope(r.journal_id, entity, actor) THEN
    RAISE EXCEPTION 'reversal request not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF r.status <> 'APPROVED' THEN
    RAISE EXCEPTION 'only an approved reversal request can be posted' USING ERRCODE = 'check_violation';
  END IF;
  SELECT reversal_journal_id INTO existing FROM abos.journal_reversal_links WHERE original_journal_id = r.journal_id;
  IF existing IS NOT NULL THEN
    RETURN jsonb_build_object('requestId', r.id, 'reversalJournalId', existing, 'status', 'POSTED', 'replayed', true);
  END IF;
  IF actor = r.requested_by_user_account_id THEN
    RAISE EXCEPTION 'the person who requested a reversal cannot post it' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN abos.reversal_post(entity, actor, r.decided_by_user_account_id, r.journal_id, r.reason, r.id, gen_random_uuid(), 'APPROVED_REQUEST')
    || jsonb_build_object('requestId', r.id);
END
$approved$;

CREATE FUNCTION abos.finance_journal_reversal_withdraw(p_proof text, p_runtime text, p_token text, p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $withdraw$
DECLARE c jsonb; actor uuid; entity uuid; r abos.journal_reversal_requests%ROWTYPE; request uuid; expected integer;
BEGIN
  c := abos.operational_finance_actor(p_proof, p_runtime, p_token, 'finance.reversal.request');
  actor := (c->>'userAccountId')::uuid; entity := (c->>'legalEntityId')::uuid;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' OR (p_payload - ARRAY['requestId','expectedVersion']) <> '{}'::jsonb THEN
    RAISE EXCEPTION 'unknown reversal fields' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  BEGIN request := (p_payload->>'requestId')::uuid; expected := (p_payload->>'expectedVersion')::integer;
  EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'choose a valid request' USING ERRCODE = 'invalid_parameter_value'; END;
  SELECT * INTO r FROM abos.journal_reversal_requests WHERE id = request AND legal_entity_id = entity FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'reversal request not found' USING ERRCODE = 'no_data_found'; END IF;
  IF r.status = 'WITHDRAWN' AND r.decided_by_user_account_id = actor THEN
    RETURN jsonb_build_object('requestId', r.id, 'status', 'WITHDRAWN', 'replayed', true);
  END IF;
  IF expected IS DISTINCT FROM r.version THEN
    RAISE EXCEPTION 'the reversal request was changed by someone else' USING ERRCODE = 'serialization_failure';
  END IF;
  UPDATE abos.journal_reversal_requests SET status = 'WITHDRAWN', decided_by_user_account_id = actor, decided_at = clock_timestamp(),
    version = version + 1 WHERE id = r.id;
  PERFORM abos.money_audit(actor, entity, gen_random_uuid(), 'JOURNAL_REVERSAL_WITHDRAWN', 'JOURNAL_REVERSAL_REQUEST', r.id,
    jsonb_build_object('journalId', r.journal_id));
  RETURN jsonb_build_object('requestId', r.id, 'status', 'WITHDRAWN', 'replayed', false);
END
$withdraw$;

CREATE FUNCTION abos.finance_journal_reversal_workspace(p_proof text, p_runtime text, p_token text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $workspace$
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
      SELECT j.posted_at, jsonb_build_object('id', j.id, 'reference', j.journal_reference, 'date', j.accounting_effective_date,
        'sourceType', i.source_type, 'amount', i.original_amount::text, 'currency', i.original_currency_code,
        'postedBy', (SELECT display_name FROM abos.user_accounts WHERE id = j.posted_by_user_account_id),
        'periodStatus', p.status,
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
    'requests', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', r.id, 'journalId', r.journal_id, 'journalReference', j.journal_reference,
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
$workspace$;

-- ---------------------------------------------------------------------------------------------
-- 6. Period close / reopen entry points (operational password session).
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION abos.period_close_preview_json(p_entity uuid, p_period uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $preview$
  SELECT jsonb_build_object(
    'period', jsonb_build_object('id', p.id, 'name', p.period_name, 'nameFa', p.period_name_fa, 'startsOn', p.starts_on, 'endsOn', p.ends_on,
      'status', p.status, 'version', p.operational_version),
    'summary', (SELECT jsonb_build_object('postedJournals', count(DISTINCT j.id), 'debits', COALESCE(sum(l.base_debit), 0)::text,
        'credits', COALESCE(sum(l.base_credit), 0)::text)
      FROM abos.journals j LEFT JOIN abos.journal_lines l ON l.journal_id = j.id
     WHERE j.accounting_period_id = p.id AND j.status = 'POSTED'),
    'unpostedJournals', (SELECT count(*) FROM abos.journals j WHERE j.accounting_period_id = p.id AND j.status <> 'POSTED'),
    'pending', jsonb_build_object(
      'expensesAwaitingApproval', (SELECT count(*) FROM abos.operational_expenses e WHERE e.legal_entity_id = p_entity
        AND e.status = 'PENDING_APPROVAL' AND e.business_date BETWEEN p.starts_on AND p.ends_on),
      'reversalRequests', (SELECT count(*) FROM abos.journal_reversal_requests r JOIN abos.journals j ON j.id = r.journal_id
        WHERE r.legal_entity_id = p_entity AND r.status IN ('REQUESTED', 'APPROVED') AND j.accounting_period_id = p.id
          AND NOT EXISTS (SELECT 1 FROM abos.journal_reversal_links link WHERE link.original_journal_id = r.journal_id)),
      'temporaryFundingDecisions', (SELECT count(*) FROM abos.temporary_fundings f WHERE f.legal_entity_id = p_entity
        AND f.status = 'PENDING_APPROVAL' AND f.business_date BETWEEN p.starts_on AND p.ends_on)
        + (SELECT count(*) FROM abos.temporary_funding_settlements s WHERE s.legal_entity_id = p_entity
        AND s.status = 'PENDING_APPROVAL' AND s.business_date BETWEEN p.starts_on AND p.ends_on)),
    'warnings', to_jsonb(array_remove(ARRAY[
      CASE WHEN EXISTS (SELECT 1 FROM abos.accounting_periods e WHERE e.legal_entity_id = p_entity AND e.status = 'OPEN' AND e.ends_on < p.starts_on)
        THEN 'EARLIER_MONTH_OPEN' END,
      CASE WHEN abos.business_today() BETWEEN p.starts_on AND p.ends_on THEN 'CONTAINS_TODAY' END,
      CASE WHEN NOT EXISTS (SELECT 1 FROM abos.journals j WHERE j.accounting_period_id = p.id AND j.status = 'POSTED') THEN 'NO_POSTING' END
    ], NULL)))
  FROM abos.accounting_periods p WHERE p.id = p_period AND p.legal_entity_id = p_entity
$preview$;

CREATE FUNCTION abos.period_payload(p_payload jsonb, p_allowed text[])
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $payload$
BEGIN
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' OR (p_payload - p_allowed) <> '{}'::jsonb THEN
    RAISE EXCEPTION 'unknown period fields' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  BEGIN
    RETURN jsonb_build_object('id', (COALESCE(p_payload->>'periodId', p_payload->>'requestId'))::uuid,
      'version', (p_payload->>'expectedVersion')::integer);
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'choose a valid month' USING ERRCODE = 'invalid_parameter_value';
  END;
END
$payload$;

CREATE FUNCTION abos.period_event(p_entity uuid, p_period uuid, p_action text, p_from text, p_to text, p_reason text,
  p_request uuid, p_actor uuid, p_before jsonb)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $event$
DECLARE correlation uuid := gen_random_uuid();
BEGIN
  INSERT INTO abos.accounting_period_events (id, legal_entity_id, accounting_period_id, action, from_status, to_status, reason,
    reopen_request_id, actor_user_account_id, correlation_id)
  VALUES (gen_random_uuid(), p_entity, p_period, p_action, p_from, p_to, p_reason, p_request, p_actor, correlation);
  INSERT INTO abos.audit_records (id, actor_user_account_id, legal_entity_id, correlation_id, action, entity_type, entity_id,
    before_state, after_state, metadata)
  VALUES (gen_random_uuid(), p_actor, p_entity, correlation, 'ACCOUNTING_PERIOD_' || p_action, 'ACCOUNTING_PERIOD', p_period, p_before,
    (SELECT to_jsonb(x) FROM abos.accounting_periods x WHERE x.id = p_period),
    jsonb_build_object('source', 'v1-period-close-reopen', 'reason', p_reason, 'reopenRequestId', p_request));
END
$event$;

CREATE FUNCTION abos.finance_period_close_preview(p_proof text, p_runtime text, p_token text, p_period uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $closepreview$
DECLARE c jsonb; preview jsonb;
BEGIN
  c := abos.operational_finance_actor(p_proof, p_runtime, p_token, 'finance.period.manage');
  preview := abos.period_close_preview_json((c->>'legalEntityId')::uuid, p_period);
  IF preview IS NULL THEN RAISE EXCEPTION 'the accounting period does not exist in this legal entity' USING ERRCODE = 'no_data_found'; END IF;
  RETURN preview;
END
$closepreview$;

CREATE FUNCTION abos.finance_period_close(p_proof text, p_runtime text, p_token text, p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $close$
DECLARE c jsonb; actor uuid; entity uuid; req jsonb; p abos.accounting_periods%ROWTYPE;
BEGIN
  c := abos.operational_finance_actor(p_proof, p_runtime, p_token, 'finance.period.manage');
  actor := (c->>'userAccountId')::uuid; entity := (c->>'legalEntityId')::uuid;
  req := abos.period_payload(p_payload, ARRAY['periodId', 'expectedVersion']);
  SELECT * INTO p FROM abos.accounting_periods WHERE id = (req->>'id')::uuid AND legal_entity_id = entity FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'the accounting period does not exist in this legal entity' USING ERRCODE = 'no_data_found'; END IF;
  IF p.status = 'CLOSED' AND p.closed_by_user_account_id = actor THEN
    RETURN abos.period_close_preview_json(entity, p.id) || jsonb_build_object('replayed', true);
  END IF;
  IF (req->>'version')::integer IS DISTINCT FROM p.operational_version THEN
    RAISE EXCEPTION 'the accounting period changed; reload and try again' USING ERRCODE = 'serialization_failure';
  END IF;
  IF p.status NOT IN ('OPEN', 'SOFT_CLOSED') THEN
    RAISE EXCEPTION 'only an open month can be closed (this one is %)', p.status USING ERRCODE = 'check_violation';
  END IF;
  -- The one integrity refusal: every journal of the month must be posted (journals are never changed by closing).
  IF EXISTS (SELECT 1 FROM abos.journals WHERE accounting_period_id = p.id AND status <> 'POSTED') THEN
    RAISE EXCEPTION 'the month has a journal that is not posted; it cannot be closed' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE abos.accounting_periods SET status = 'CLOSED', closed_by_user_account_id = actor, closed_at = clock_timestamp(),
    operational_version = operational_version + 1 WHERE id = p.id;
  PERFORM abos.period_event(entity, p.id, 'CLOSED', p.status, 'CLOSED', NULL, NULL, actor, to_jsonb(p));
  RETURN abos.period_close_preview_json(entity, p.id) || jsonb_build_object('replayed', false);
END
$close$;

CREATE FUNCTION abos.period_reopen(p_entity uuid, p_actor uuid, p_period abos.accounting_periods, p_reason text, p_request uuid)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $reopen$
BEGIN
  UPDATE abos.accounting_periods SET status = 'OPEN', closed_by_user_account_id = NULL, closed_at = NULL,
    operational_version = operational_version + 1 WHERE id = p_period.id AND status = 'CLOSED';
  IF NOT FOUND THEN RAISE EXCEPTION 'only a closed month can be reopened' USING ERRCODE = 'check_violation'; END IF;
  PERFORM abos.period_event(p_entity, p_period.id, 'REOPENED', 'CLOSED', 'OPEN', p_reason, p_request, p_actor, to_jsonb(p_period));
END
$reopen$;

CREATE FUNCTION abos.period_reason(p_payload jsonb)
RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $preason$
DECLARE v text := btrim(p_payload->>'reason');
BEGIN
  IF v IS NULL OR length(v) NOT BETWEEN 5 AND 500 THEN
    RAISE EXCEPTION 'write the reason for reopening the month (5 to 500 characters)' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN v;
END
$preason$;

CREATE FUNCTION abos.finance_period_reopen(p_proof text, p_runtime text, p_token text, p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $reopendirect$
DECLARE c jsonb; actor uuid; entity uuid; req jsonb; p abos.accounting_periods%ROWTYPE; reason text;
BEGIN
  c := abos.operational_finance_actor(p_proof, p_runtime, p_token, 'finance.period.reopen');
  actor := (c->>'userAccountId')::uuid; entity := (c->>'legalEntityId')::uuid;
  req := abos.period_payload(p_payload, ARRAY['periodId', 'expectedVersion', 'reason']);
  reason := abos.period_reason(p_payload);
  SELECT * INTO p FROM abos.accounting_periods WHERE id = (req->>'id')::uuid AND legal_entity_id = entity FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'the accounting period does not exist in this legal entity' USING ERRCODE = 'no_data_found'; END IF;
  IF abos.workflow_setting_requires_approval(entity, 'PERIOD_REOPEN') THEN
    RAISE EXCEPTION 'your company requires a second person to reopen a month; send a reopen request' USING ERRCODE = 'check_violation';
  END IF;
  IF (req->>'version')::integer IS DISTINCT FROM p.operational_version THEN
    RAISE EXCEPTION 'the accounting period changed; reload and try again' USING ERRCODE = 'serialization_failure';
  END IF;
  PERFORM abos.period_reopen(entity, actor, p, reason, NULL);
  RETURN jsonb_build_object('periodId', p.id, 'status', 'OPEN');
END
$reopendirect$;

CREATE FUNCTION abos.finance_period_reopen_request(p_proof text, p_runtime text, p_token text, p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $reopenrequest$
DECLARE c jsonb; actor uuid; entity uuid; req jsonb; p abos.accounting_periods%ROWTYPE; reason text; request uuid := gen_random_uuid();
BEGIN
  c := abos.operational_finance_actor(p_proof, p_runtime, p_token, 'finance.period.reopen');
  actor := (c->>'userAccountId')::uuid; entity := (c->>'legalEntityId')::uuid;
  req := abos.period_payload(p_payload, ARRAY['periodId', 'expectedVersion', 'reason']);
  reason := abos.period_reason(p_payload);
  SELECT * INTO p FROM abos.accounting_periods WHERE id = (req->>'id')::uuid AND legal_entity_id = entity FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'the accounting period does not exist in this legal entity' USING ERRCODE = 'no_data_found'; END IF;
  IF (req->>'version')::integer IS DISTINCT FROM p.operational_version THEN
    RAISE EXCEPTION 'the accounting period changed; reload and try again' USING ERRCODE = 'serialization_failure';
  END IF;
  IF p.status <> 'CLOSED' THEN RAISE EXCEPTION 'only a closed month can be reopened' USING ERRCODE = 'check_violation'; END IF;
  INSERT INTO abos.accounting_period_reopen_requests (id, legal_entity_id, accounting_period_id, reason, requested_by_user_account_id)
  VALUES (request, entity, p.id, reason, actor);
  PERFORM abos.period_event(entity, p.id, 'REOPEN_REQUESTED', 'CLOSED', 'CLOSED', reason, request, actor, to_jsonb(p));
  RETURN jsonb_build_object('requestId', request, 'status', 'REQUESTED');
END
$reopenrequest$;

CREATE FUNCTION abos.finance_period_reopen_decide(p_proof text, p_runtime text, p_token text, p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $reopendecide$
DECLARE c jsonb; actor uuid; entity uuid; req jsonb; r abos.accounting_period_reopen_requests%ROWTYPE; p abos.accounting_periods%ROWTYPE;
  decision text := p_payload->>'decision'; note text := NULLIF(btrim(p_payload->>'note'), '');
BEGIN
  req := abos.period_payload(p_payload, ARRAY['requestId', 'expectedVersion', 'decision', 'note']);
  c := abos.operational_finance_actor(p_proof, p_runtime, p_token, 'finance.period.reopen');
  actor := (c->>'userAccountId')::uuid; entity := (c->>'legalEntityId')::uuid;
  IF decision IS NULL OR decision NOT IN ('CONFIRMED', 'REJECTED', 'WITHDRAWN') THEN
    RAISE EXCEPTION 'the decision must be CONFIRMED, REJECTED or WITHDRAWN' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO r FROM abos.accounting_period_reopen_requests WHERE id = (req->>'id')::uuid AND legal_entity_id = entity FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'reopen request not found' USING ERRCODE = 'no_data_found'; END IF;
  IF r.status <> 'REQUESTED' THEN
    IF r.status = decision AND r.decided_by_user_account_id = actor THEN
      RETURN jsonb_build_object('requestId', r.id, 'status', r.status, 'replayed', true);
    END IF;
    RAISE EXCEPTION 'this reopen request was already %', lower(r.status) USING ERRCODE = 'check_violation';
  END IF;
  IF (req->>'version')::integer IS DISTINCT FROM r.version THEN
    RAISE EXCEPTION 'the reopen request was changed by someone else' USING ERRCODE = 'serialization_failure';
  END IF;
  IF decision = 'WITHDRAWN' AND actor <> r.requested_by_user_account_id THEN
    RAISE EXCEPTION 'only the person who asked can withdraw the request' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF decision IN ('CONFIRMED', 'REJECTED') AND actor = r.requested_by_user_account_id THEN
    RAISE EXCEPTION 'a second person must confirm or reject the reopen request' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF decision = 'REJECTED' AND (note IS NULL OR length(note) < 3) THEN
    RAISE EXCEPTION 'say why the reopen request is rejected' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO p FROM abos.accounting_periods WHERE id = r.accounting_period_id AND legal_entity_id = entity FOR UPDATE;
  UPDATE abos.accounting_period_reopen_requests SET status = decision, decided_by_user_account_id = actor, decided_at = clock_timestamp(),
    decision_note = note, version = version + 1 WHERE id = r.id;
  IF decision = 'CONFIRMED' THEN
    PERFORM abos.period_reopen(entity, actor, p, r.reason, r.id);
  ELSE
    PERFORM abos.period_event(entity, p.id, CASE decision WHEN 'REJECTED' THEN 'REOPEN_REJECTED' ELSE 'REOPEN_WITHDRAWN' END,
      p.status, p.status, COALESCE(note, r.reason), r.id, actor, to_jsonb(p));
  END IF;
  RETURN jsonb_build_object('requestId', r.id, 'status', decision, 'replayed', false);
END
$reopendecide$;

CREATE FUNCTION abos.finance_periods_workspace(p_proof text, p_runtime text, p_token text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $periods$
DECLARE c jsonb; actor uuid; entity uuid; perms jsonb; approval boolean;
BEGIN
  c := abos.operational_finance_actor(p_proof, p_runtime, p_token, NULL);
  actor := (c->>'userAccountId')::uuid; entity := (c->>'legalEntityId')::uuid; perms := COALESCE(c->'permissions', '[]'::jsonb);
  IF NOT (perms ?| ARRAY['finance.period.manage', 'finance.period.reopen']) THEN
    RAISE EXCEPTION 'current authority is missing finance.period.manage or finance.period.reopen' USING ERRCODE = 'insufficient_privilege';
  END IF;
  approval := abos.workflow_setting_requires_approval(entity, 'PERIOD_REOPEN');
  RETURN jsonb_build_object('today', abos.business_today(), 'reopenNeedsSecondPerson', approval,
    'canClose', perms ? 'finance.period.manage', 'canReopen', perms ? 'finance.period.reopen',
    'periods', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', p.id, 'name', p.period_name, 'nameFa', p.period_name_fa,
        'startsOn', p.starts_on, 'endsOn', p.ends_on, 'status', p.status, 'version', p.operational_version,
        'openedBy', (SELECT display_name FROM abos.user_accounts WHERE id = p.opened_by_user_account_id), 'openedAt', p.opened_at,
        'closedBy', (SELECT display_name FROM abos.user_accounts WHERE id = p.closed_by_user_account_id), 'closedAt', p.closed_at,
        'reopenCount', (SELECT count(*) FROM abos.accounting_period_events e WHERE e.accounting_period_id = p.id AND e.action = 'REOPENED'),
        'postedJournals', (SELECT count(*) FROM abos.journals j WHERE j.accounting_period_id = p.id AND j.status = 'POSTED'),
        'reopenRequest', (SELECT jsonb_build_object('id', r.id, 'reason', r.reason, 'version', r.version,
            'requestedBy', (SELECT display_name FROM abos.user_accounts WHERE id = r.requested_by_user_account_id),
            'requestedAt', r.requested_at, 'viewerIsRequester', r.requested_by_user_account_id = actor)
          FROM abos.accounting_period_reopen_requests r WHERE r.accounting_period_id = p.id AND r.status = 'REQUESTED'))
        ORDER BY p.starts_on)
      FROM abos.accounting_periods p WHERE p.legal_entity_id = entity), '[]'::jsonb),
    'history', COALESCE((SELECT jsonb_agg(jsonb_build_object('periodName', p.period_name, 'periodNameFa', p.period_name_fa,
        'action', e.action, 'fromStatus', e.from_status, 'toStatus', e.to_status, 'reason', e.reason,
        'actor', (SELECT display_name FROM abos.user_accounts WHERE id = e.actor_user_account_id), 'at', e.occurred_at)
        ORDER BY e.occurred_at DESC)
      FROM (SELECT * FROM abos.accounting_period_events WHERE legal_entity_id = entity ORDER BY occurred_at DESC LIMIT 50) e
      JOIN abos.accounting_periods p ON p.id = e.accounting_period_id), '[]'::jsonb));
END
$periods$;

-- ---------------------------------------------------------------------------------------------
-- 7. Restated: kernel dispatch, Finance actor allowlist, switch availability and the read models
--    that now account for reversals (0049 definitions with the 0050 changes).
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION abos.posting_kernel_validate()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  v_intent abos.posting_intents%ROWTYPE;
  v_source abos.posting_sources%ROWTYPE;
  v_period record;
  v_base text;
  v_line_count bigint; v_debit numeric; v_credit numeric;
BEGIN
  -- Draft before post, and posted is immutable, for every operational journal (frozen lanes included).
  IF TG_OP = 'INSERT' AND NEW.status = 'POSTED' THEN
    RAISE EXCEPTION 'operational journals must be assembled as draft before posting'
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'POSTED' THEN
    RAISE EXCEPTION 'a posted operational journal is immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status <> 'POSTED' THEN RETURN NEW; END IF;

  SELECT * INTO v_intent FROM abos.posting_intents
   WHERE id = NEW.posting_intent_id AND legal_entity_id = NEW.legal_entity_id;
  IF NOT FOUND OR v_intent.processing_model <> 'OPERATIONAL_V1' THEN
    RAISE EXCEPTION 'operational posting requires its operational posting intent in the same legal entity'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_source FROM abos.posting_sources WHERE source_type = v_intent.source_type;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'operational posting source % is not registered', v_intent.source_type
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_source.status = 'FROZEN' THEN RETURN NEW; END IF;
  IF v_source.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'operational posting source % is not available yet', v_intent.source_type
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_intent.status <> 'POSTED' OR v_intent.base_amount IS NULL
     OR v_intent.base_currency_code IS DISTINCT FROM NEW.base_currency_code
     OR v_intent.accounting_effective_date IS DISTINCT FROM NEW.accounting_effective_date THEN
    RAISE EXCEPTION 'operational posting requires its posted intent with the journal''s currency and date'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT status, starts_on, ends_on INTO v_period FROM abos.accounting_periods
   WHERE id = NEW.accounting_period_id AND legal_entity_id = NEW.legal_entity_id;
  IF NOT FOUND OR v_period.status <> 'OPEN'
     OR NEW.accounting_effective_date NOT BETWEEN v_period.starts_on AND v_period.ends_on THEN
    RAISE EXCEPTION 'operational posting requires an open accounting period covering its date'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT base_currency_code INTO v_base FROM abos.legal_entities
   WHERE id = NEW.legal_entity_id AND currency_policy_status = 'APPROVED';
  IF v_base IS NULL OR v_base IS DISTINCT FROM NEW.base_currency_code THEN
    RAISE EXCEPTION 'operational posting requires the approved legal-entity base currency'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT count(*), coalesce(sum(base_debit), 0), coalesce(sum(base_credit), 0)
    INTO v_line_count, v_debit, v_credit FROM abos.journal_lines WHERE journal_id = NEW.id;
  IF v_line_count <> v_source.line_count OR v_debit <> v_credit OR v_debit <> v_intent.base_amount THEN
    RAISE EXCEPTION 'operational journal must contain exactly % lines balanced to its intent amount', v_source.line_count
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM abos.journal_lines line
    JOIN abos.ledger_accounts ledger ON ledger.id = line.ledger_account_id
     AND ledger.legal_entity_id = line.legal_entity_id
    WHERE line.journal_id = NEW.id AND (
      line.processing_model <> 'OPERATIONAL_V1'
      OR line.legal_entity_id <> NEW.legal_entity_id
      OR line.base_currency_code <> NEW.base_currency_code
      OR line.original_currency_code IS DISTINCT FROM v_intent.original_currency_code
      OR line.conversion_snapshot_reference IS DISTINCT FROM v_intent.conversion_snapshot_reference
      OR line.source_type <> v_intent.source_type OR line.source_id <> v_intent.source_id
      OR ledger.status <> 'ACTIVE' OR NOT ledger.posting_allowed
      OR (ledger.requires_project AND line.project_id IS NULL)
      OR (ledger.requires_department AND line.department_id IS NULL)
      OR (ledger.requires_cost_center AND line.cost_center_id IS NULL)
      OR NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(CASE WHEN line.base_debit > 0 THEN v_source.debit_rules ELSE v_source.credit_rules END) rule
         WHERE rule->>'accountType' = ledger.account_type
           AND (NOT rule ? 'control' OR ledger.control_account_type IS NOT DISTINCT FROM rule->>'control'))
    )) OR (SELECT count(*) FROM abos.journal_lines line
            JOIN abos.ledger_accounts ledger ON ledger.id = line.ledger_account_id AND ledger.legal_entity_id = line.legal_entity_id
           WHERE line.journal_id = NEW.id) <> v_line_count THEN
    RAISE EXCEPTION 'operational journal line violates entity, currency, account or dimension rules'
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM abos.subledger_entries entry
    JOIN abos.journal_lines line ON line.id = entry.journal_line_id
    WHERE line.journal_id = NEW.id AND (
      entry.processing_model <> 'OPERATIONAL_V1'
      OR entry.legal_entity_id <> NEW.legal_entity_id
      OR entry.source_type <> v_intent.source_type OR entry.source_id <> v_intent.source_id
      OR entry.original_currency_code IS DISTINCT FROM v_intent.original_currency_code
      OR entry.base_currency_code <> NEW.base_currency_code
      OR abs(entry.base_amount) <> greatest(line.base_debit, line.base_credit)
      OR abs(entry.original_amount) IS DISTINCT FROM line.original_amount
      -- 0045: one sign convention for every subledger - debit = positive, credit = negative.
      OR sign(entry.base_amount) <> CASE WHEN line.base_debit > 0 THEN 1 ELSE -1 END
      OR sign(entry.original_amount) <> CASE WHEN line.base_debit > 0 THEN 1 ELSE -1 END
      OR NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_source.subledger_rules) rule
         WHERE rule->>'type' = entry.subledger_type
           AND rule->>'side' = CASE WHEN line.base_debit > 0 THEN 'DEBIT' ELSE 'CREDIT' END)
    )) OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_source.subledger_rules) rule
     WHERE (rule->>'required')::boolean AND NOT EXISTS (
       SELECT 1 FROM abos.subledger_entries entry JOIN abos.journal_lines line ON line.id = entry.journal_line_id
        WHERE line.journal_id = NEW.id AND entry.subledger_type = rule->>'type'
          AND rule->>'side' = CASE WHEN line.base_debit > 0 THEN 'DEBIT' ELSE 'CREDIT' END)) THEN
    RAISE EXCEPTION 'operational subledger movement violates its source, currency, amount or registered shape'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Static dispatch: one small validator per source. An ACTIVE source without an arm fails closed.
  CASE v_source.source_type
    WHEN 'OPERATIONAL_EXPENSE' THEN PERFORM abos.validate_expense_journal(NEW, v_intent);
    WHEN 'DIRECT_SHAREHOLDER_CAPITAL' THEN PERFORM abos.validate_direct_shareholder_capital_journal(NEW, v_intent);
    WHEN 'TEMPORARY_FUNDING' THEN PERFORM abos.validate_temporary_funding_journal(NEW, v_intent);
    WHEN 'TEMPORARY_FUNDING_SETTLEMENT' THEN PERFORM abos.validate_temporary_funding_settlement_journal(NEW, v_intent);
    WHEN 'OPENING_BALANCE' THEN PERFORM abos.validate_opening_balance_journal(NEW, v_intent);
    WHEN 'CASH_RECEIPT' THEN PERFORM abos.validate_cash_receipt_journal(NEW, v_intent);
    WHEN 'TREASURY_TRANSFER' THEN PERFORM abos.validate_treasury_transfer_journal(NEW, v_intent);
    WHEN 'PAYMENT' THEN PERFORM abos.validate_payment_journal(NEW, v_intent);
    WHEN 'REVERSAL' THEN PERFORM abos.validate_reversal_journal(NEW, v_intent);
    ELSE
      RAISE EXCEPTION 'operational posting source % has no validator', v_source.source_type
        USING ERRCODE = 'check_violation';
  END CASE;
  -- 0049: a Safe, cash box or petty-cash account never goes below zero, whichever lane posts.
  PERFORM abos.treasury_require_funds(NEW);
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION abos.operational_finance_actor(p_identity_proof text, p_runtime_token_sha256 text, p_token_sha256 text, p_required_permission text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE actor_context jsonb;
BEGIN
  IF p_required_permission IS NOT NULL AND p_required_permission NOT IN (
    'treasury.operational-account.manage', 'finance.expense-category.manage',
    'finance.expense.create', 'finance.expense.read', 'finance.expense.approve',
    'finance.period.manage', 'shareholder.capital-receipt.read',
    'shareholder.capital-receipt.record', 'treasury.capital-receipt.verify',
    'finance.capital-receipt.configure', 'finance.capital-receipt.prepare',
    'finance.capital-receipt.approve', 'finance.capital-receipt.post',
    'finance.temporary-funding.read', 'finance.temporary-funding.record',
    'finance.temporary-funding.approve', 'finance.temporary-funding.settle',
    'finance.temporary-funding.settle-approve', 'finance.temporary-funding.configure',
    'finance.period.reopen', 'finance.reversal.direct', 'finance.reversal.request', 'finance.reversal.approve'
  ) THEN
    RAISE EXCEPTION 'unsupported operational Finance permission'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  actor_context := abos.identity_actor_context(
    p_identity_proof, p_runtime_token_sha256, p_token_sha256);
  IF actor_context IS NULL
     OR COALESCE((actor_context ->> 'live')::boolean, false) IS NOT TRUE
     OR actor_context ->> 'status' IS DISTINCT FROM 'ACTIVE'
     OR COALESCE((actor_context ->> 'mustChangePassword')::boolean, false) IS TRUE THEN
    RAISE EXCEPTION 'sign in with an active account to continue'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_required_permission IS NOT NULL
     AND NOT COALESCE(actor_context -> 'permissions', '[]'::jsonb) ? p_required_permission THEN
    RAISE EXCEPTION 'current authority is missing %', p_required_permission
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN actor_context;
END
$function$;

CREATE OR REPLACE FUNCTION abos.finance_workflow_approval_available(p_workflow_type text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT p_workflow_type IN ('CHART_OF_ACCOUNTS', 'SHAREHOLDER_CAPITAL_RECEIPT', 'EXPENSE', 'TEMPORARY_FUNDING',
    'PERIOD_REOPEN', 'JOURNAL_REVERSAL')
$function$;

CREATE OR REPLACE FUNCTION abos.operational_finance_daily_report(p_identity_proof text, p_runtime_token_sha256 text, p_token_sha256 text, p_report_date date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
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
                   expense.original_currency_code AS currency, sum(expense.n) AS expense_count,
                   sum(expense.original_amount) AS amount, sum(expense.base_amount) AS base_amount
              FROM abos.operational_expense_effects(v_entity_id, p_report_date) expense
              JOIN abos.operational_expense_categories category
                ON category.id = expense.operational_expense_category_id
             WHERE true
               AND abos.operational_expense_actor_in_scope(expense.id, v_entity_id, v_actor_id)
             GROUP BY category.id, category.category_code, category.name_en, category.name_fa,
                      expense.original_currency_code) grouped), '[]'::jsonb),
    'totalsByCurrency', COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'currency', totals.currency, 'count', totals.expense_count, 'amount', totals.amount::text)
        ORDER BY totals.currency)
      FROM (SELECT expense.original_currency_code AS currency, sum(expense.n) AS expense_count,
                   sum(expense.original_amount) AS amount
              FROM abos.operational_expense_effects(v_entity_id, p_report_date) expense
             WHERE true
               AND abos.operational_expense_actor_in_scope(expense.id, v_entity_id, v_actor_id)
             GROUP BY expense.original_currency_code) totals), '[]'::jsonb),
    'baseTotal', (SELECT pg_catalog.jsonb_build_object('currency', v_base_currency,
        'amount', COALESCE(sum(expense.base_amount), 0)::text)
      FROM abos.operational_expense_effects(v_entity_id, p_report_date) expense
      WHERE true
        AND abos.operational_expense_actor_in_scope(expense.id, v_entity_id, v_actor_id)),
    'pendingApproval', (SELECT pg_catalog.jsonb_build_object('count', count(*))
      FROM abos.operational_expenses expense
      WHERE expense.legal_entity_id = v_entity_id AND expense.status = 'PENDING_APPROVAL'
        AND expense.business_date = p_report_date
        AND abos.operational_expense_actor_in_scope(expense.id, v_entity_id, v_actor_id)),
    -- 0045: Safe positions come from the one balance read model. A balance is the sum of EVERY
    -- posted movement of the account, whatever recorded it; the reader's project, department and
    -- cost-centre scope hides movement details elsewhere, never money from a balance.
    'treasuryMovements', COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'treasuryAccountId', account.id, 'nameEn', account.name_en, 'nameFa', account.name_fa,
        'currency', account.currency_code, 'status', account.status,
        'before', prior.book_balance::text, 'day', (current_day.book_balance - prior.book_balance)::text,
        'after', current_day.book_balance::text)
        ORDER BY account.name_en, account.id)
      FROM abos.operational_treasury_accounts account
      JOIN abos.treasury_account_balances(v_entity_id, p_report_date - 1, NULL) prior
        ON prior.operational_treasury_account_id = account.id
      JOIN abos.treasury_account_balances(v_entity_id, p_report_date, NULL) current_day
        ON current_day.operational_treasury_account_id = account.id
      WHERE account.legal_entity_id = v_entity_id), '[]'::jsonb));
END
$function$;

CREATE OR REPLACE FUNCTION abos.operational_expense_json(p_expense_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT pg_catalog.jsonb_build_object(
    'id', expense.id,
    'legalEntityId', expense.legal_entity_id,
    'treasuryAccountId', expense.operational_treasury_account_id,
    'treasuryAccountNameEn', treasury.name_en,
    'treasuryAccountNameFa', treasury.name_fa,
    'expenseCategoryId', expense.operational_expense_category_id,
    'expenseCategoryCode', category.category_code,
    'expenseCategoryNameEn', category.name_en,
    'expenseCategoryNameFa', category.name_fa,
    'payeeBusinessPartyId', expense.payee_business_party_id,
    'payeeName', payee.display_name,
    'projectId', expense.project_id,
    'departmentId', expense.department_id,
    'costCenterId', expense.cost_center_id,
    'reference', expense.reference,
    'description', expense.description,
    'note', expense.note,
    'businessDate', expense.business_date,
    'originalAmount', expense.original_amount::text,
    'originalCurrency', expense.original_currency_code,
    'baseAmount', expense.base_amount::text,
    'baseCurrency', expense.base_currency_code,
    'exchangeRateSnapshot', CASE WHEN snapshot.id IS NULL THEN NULL ELSE
      pg_catalog.jsonb_build_object(
        'id', snapshot.id, 'exchangeRateId', snapshot.exchange_rate_id,
        'rateDate', snapshot.rate_date, 'rateSource', snapshot.rate_source,
        'unitCurrency', snapshot.unit_currency_code,
        'quoteCurrency', snapshot.quote_currency_code,
        'rate', snapshot.rate_value::text) END,
    'workflowPolicyVersionId', expense.workflow_policy_version_id,
    'approvalRequired', expense.approval_required,
    'status', expense.status,
    'version', expense.version,
    'journalId', expense.journal_id,
    'createdBy', creator.display_name,
    'createdAt', expense.created_at,
    'updatedAt', expense.updated_at,
    'approval', CASE WHEN approval.id IS NULL THEN NULL ELSE
      pg_catalog.jsonb_build_object(
        'id', approval.id, 'decision', approval.decision,
        'note', approval.decision_note, 'approvedAt', approval.approved_at,
        'approvedBy', approver.display_name) END)
    || CASE WHEN expense.payment_kind IS NULL THEN '{}'::jsonb ELSE pg_catalog.jsonb_build_object('paymentKind', expense.payment_kind) END
    -- 0050: a reversed expense shows its reversal; an expense that was never reversed reads as before.
    || COALESCE((SELECT pg_catalog.jsonb_build_object('reversal', pg_catalog.jsonb_build_object('journalId', link.reversal_journal_id,
         'reference', reversal.journal_reference, 'date', reversal.accounting_effective_date, 'reason', link.reason))
       FROM abos.journal_reversal_links link JOIN abos.journals reversal ON reversal.id = link.reversal_journal_id
      WHERE link.original_journal_id = expense.journal_id), '{}'::jsonb)
  FROM abos.operational_expenses expense
  JOIN abos.operational_treasury_accounts treasury
    ON treasury.id = expense.operational_treasury_account_id
  JOIN abos.operational_expense_categories category
    ON category.id = expense.operational_expense_category_id
  JOIN abos.user_accounts creator ON creator.id = expense.created_by_user_account_id
  LEFT JOIN abos.business_parties payee ON payee.id = expense.payee_business_party_id
  LEFT JOIN abos.exchange_rate_snapshots snapshot ON snapshot.id = expense.exchange_rate_snapshot_id
  LEFT JOIN abos.operational_expense_approvals approval
    ON approval.operational_expense_id = expense.id
  LEFT JOIN abos.user_accounts approver ON approver.id = approval.approver_user_account_id
  WHERE expense.id = p_expense_id
$function$;

CREATE OR REPLACE FUNCTION abos.direct_shareholder_capital_workspace(p_proof text, p_runtime text, p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE c jsonb; entity uuid; permissions jsonb; base text; company_name text; reason text; equity uuid;
 asset_account uuid;
BEGIN
 c:=abos.direct_capital_actor(p_proof,p_runtime,p_token,false);
 entity:=(c->>'legalEntityId')::uuid; permissions:=COALESCE(c->'permissions','[]'::jsonb);
 SELECT base_currency_code,name INTO base,company_name FROM abos.legal_entities WHERE id=entity;
 BEGIN equity:=abos.direct_capital_equity(entity,base); EXCEPTION WHEN check_violation THEN reason:='Choose an active shareholder capital equity account in Finance setup.'; END;
 -- Asset contributions need their own account. Its absence disables only that one method.
 BEGIN asset_account:=abos.direct_capital_asset_account(entity,base); EXCEPTION WHEN check_violation THEN asset_account:=NULL; END;
 IF NOT EXISTS(SELECT 1 FROM abos.finance_workflow_policy_versions p WHERE p.legal_entity_id=entity
  AND p.workflow_type='SHAREHOLDER_CAPITAL_RECEIPT' AND NOT p.approval_required
  AND p.version=(SELECT max(version) FROM abos.finance_workflow_policy_versions WHERE legal_entity_id=entity AND workflow_type=p.workflow_type)) THEN
  reason:='The company capital approval setting does not permit direct receipts.'; END IF;
 RETURN jsonb_build_object('legalEntity',jsonb_build_object('id',entity,'name',company_name,'baseCurrency',base),
 'permissions',jsonb_build_object('canManage',permissions ? 'shareholder.setup.manage',
  'canReceive',permissions ?& ARRAY['shareholder.capital-receipt.record','finance.capital-receipt.prepare','finance.capital-receipt.post']),
 'receiveAvailable',reason IS NULL,'unavailableReason',reason,'assetAccountReady',asset_account IS NOT NULL,
 'expenseAccounts',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',x.id,'code',x.account_code,'name',x.account_name)
   ORDER BY x.account_code) FROM abos.ledger_accounts x
   LEFT JOIN abos.ledger_account_governance g ON g.ledger_account_id=x.id AND g.legal_entity_id=x.legal_entity_id
   WHERE x.legal_entity_id=entity AND x.status='ACTIVE' AND x.posting_allowed AND x.account_type='EXPENSE'
    AND x.control_account_type IS NULL AND(x.account_currency_code IS NULL OR x.account_currency_code=base)
    AND NOT x.requires_project AND NOT x.requires_department AND NOT x.requires_cost_center
    AND(g.ledger_account_id IS NULL OR g.review_state IN('REVIEWED','NOT_REQUIRED'))),'[]'::jsonb),
 'currencies',COALESCE((SELECT jsonb_agg(jsonb_build_object('code',code,'label',name) ORDER BY code) FROM abos.currencies WHERE enabled),'[]'::jsonb),
 'destinations',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',a.id,'name',a.name_en,'currency',a.currency_code,
  'balance',CASE WHEN permissions ? 'finance.report.operational.read' THEN COALESCE((SELECT sum(s.original_amount) FROM abos.subledger_entries s JOIN abos.journal_lines l ON l.id=s.journal_line_id
   JOIN abos.journals j ON j.id=l.journal_id AND j.legal_entity_id=l.legal_entity_id AND j.status='POSTED'
   WHERE s.legal_entity_id=entity AND s.operational_treasury_account_id=a.id AND s.subledger_type='OPERATIONAL_TREASURY'
    AND s.processing_model='OPERATIONAL_V1'
    AND(l.project_id IS NULL OR EXISTS(SELECT 1 FROM abos.user_scope_grants g WHERE g.user_account_id=(c->>'userAccountId')::uuid AND g.legal_entity_id=entity AND g.scope_kind='PROJECT' AND g.scope_id=l.project_id AND g.revoked_at IS NULL))
    AND(l.department_id IS NULL OR EXISTS(SELECT 1 FROM abos.user_scope_grants g WHERE g.user_account_id=(c->>'userAccountId')::uuid AND g.legal_entity_id=entity AND g.scope_kind='DEPARTMENT' AND g.scope_id=l.department_id AND g.revoked_at IS NULL))
    AND(l.cost_center_id IS NULL OR EXISTS(SELECT 1 FROM abos.user_scope_grants g WHERE g.user_account_id=(c->>'userAccountId')::uuid AND g.legal_entity_id=entity AND g.scope_kind='COST_CENTER' AND g.scope_id=l.cost_center_id AND g.revoked_at IS NULL))),0)::text ELSE NULL END) ORDER BY a.name_en)
  FROM abos.operational_treasury_accounts a JOIN abos.ledger_accounts l ON l.id=a.ledger_account_id AND l.legal_entity_id=entity
  WHERE a.legal_entity_id=entity AND a.status='ACTIVE' AND a.currency_code=base AND a.account_type IN('SAFE','CASH_BOX','PETTY_CASH')
   AND l.status='ACTIVE' AND l.posting_allowed AND l.account_type='ASSET' AND l.control_account_type='CASH'
   AND(l.account_currency_code IS NULL OR l.account_currency_code=a.currency_code)
   AND NOT l.requires_project AND NOT l.requires_department AND NOT l.requires_cost_center),'[]'::jsonb),
 'shareholders',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',p.id,'name',b.display_name,'reference',b.external_reference,
  'note',p.capital_note,'active',p.status='ACTIVE' AND b.status='ACTIVE',
  -- Capital is what the shareholder actually contributed. An agreed total is shown only where one
  -- exists; nothing is implied from its absence and no figure is invented.
  'capitals',COALESCE((SELECT jsonb_agg(jsonb_build_object('currency',v.currency,
    'contributed',v.contributed::text,'agreedTotal',v.agreed::text,
    'remaining',CASE WHEN v.agreed IS NOT NULL THEN (v.agreed-v.contributed)::text END) ORDER BY v.currency)
   FROM(SELECT u.currency,sum(u.contributed) AS contributed,
     CASE WHEN sum(u.agreed) IS NULL THEN NULL ELSE sum(u.agreed) END AS agreed
    FROM(
     SELECT r.original_currency_code AS currency,r.original_amount AS contributed,NULL::numeric AS agreed
      FROM abos.direct_capital_receipts r WHERE r.shareholder_profile_id=p.id AND r.legal_entity_id=entity
       AND NOT EXISTS (SELECT 1 FROM abos.journal_reversal_links link WHERE link.original_journal_id=r.journal_id)
     UNION ALL
     SELECT r.original_currency_code,r.original_amount,NULL::numeric
      FROM abos.shareholder_capital_receipts r
      JOIN abos.posting_intents i ON i.shareholder_capital_receipt_id=r.id AND i.legal_entity_id=entity AND i.status='POSTED'
      JOIN abos.journals j ON j.posting_intent_id=i.id AND j.status='POSTED'
      JOIN abos.shareholder_contributions d ON d.id=r.contribution_id AND d.legal_entity_id=entity
      WHERE d.shareholder_profile_id=p.id AND r.legal_entity_id=entity
     UNION ALL
     SELECT d.currency_code,0::numeric,d.amount FROM abos.shareholder_contributions d
      WHERE d.shareholder_profile_id=p.id AND d.legal_entity_id=entity
       AND d.contribution_type='CASH' AND d.record_status='DECLARED')u
    GROUP BY u.currency)v),'[]'::jsonb),
  'transactions',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',r.id,'date',r.receipt_date,'amount',r.original_amount::text,
   'currency',r.original_currency_code,'method',r.funding_method,'destination',a.name_en,
   'providerName',r.provider_name,'itemDescription',r.item_description,
   'debitAccount',(SELECT x.account_name FROM abos.ledger_accounts x WHERE x.id=r.debit_ledger_account_id AND x.legal_entity_id=entity),
   'reference',r.transaction_reference,
   'status',CASE WHEN EXISTS (SELECT 1 FROM abos.journal_reversal_links link WHERE link.original_journal_id=r.journal_id) THEN 'REVERSED' ELSE 'POSTED' END,
   'journalId',r.journal_id,'note',r.note,'paymentReference',r.payment_reference) ORDER BY r.receipt_date DESC,r.created_at DESC)
   FROM abos.direct_capital_receipts r
   LEFT JOIN abos.operational_treasury_accounts a ON a.id=r.operational_treasury_account_id AND a.legal_entity_id=entity
   WHERE r.shareholder_profile_id=p.id AND r.legal_entity_id=entity),'[]'::jsonb),
  'documents',CASE WHEN permissions ?| ARRAY['shareholder.setup.manage','shareholder.read'] THEN
   COALESCE((SELECT jsonb_agg(jsonb_build_object('id',f.agreement_evidence_id,'fileName',f.original_file_name,'version',e.version) ORDER BY e.version DESC)
    FROM abos.capital_agreement_document_files f JOIN abos.capital_agreement_evidence e ON e.id=f.agreement_evidence_id AND e.legal_entity_id=entity
    JOIN abos.capital_agreements a ON a.id=f.capital_agreement_id AND a.legal_entity_id=entity
    WHERE a.shareholder_profile_id=p.id AND f.legal_entity_id=entity),'[]'::jsonb) ELSE '[]'::jsonb END)
  ORDER BY b.display_name,p.id) FROM abos.shareholder_profiles p JOIN abos.business_parties b ON b.id=p.business_party_id AND b.legal_entity_id=entity
  WHERE p.legal_entity_id=entity),'[]'::jsonb));
END $function$;

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
            'sourceType', m.source_type, 'reference', m.journal_reference, 'restricted', m.restricted)
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

CREATE OR REPLACE FUNCTION abos.treasury_opening_balance_record(p_proof text, p_runtime text, p_token text, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  c jsonb; actor uuid; entity uuid; v_account abos.operational_treasury_accounts%ROWTYPE; base text;
  amount numeric; day date; currency text; equity uuid; period uuid; account_id uuid;
  key text; correlation uuid; scope text; fingerprint text; replay jsonb; ref text; result jsonb;
  opening uuid := gen_random_uuid(); journal uuid := gen_random_uuid(); intent uuid := gen_random_uuid();
BEGIN
  c := abos.treasury_safe_actor(p_proof, p_runtime, p_token, 'treasury.opening-balance.record');
  actor := (c->>'userAccountId')::uuid; entity := (c->>'legalEntityId')::uuid;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_payload) k
      WHERE k NOT IN ('treasuryAccountId', 'amount', 'currencyCode', 'asOfDate', 'reference', 'note', 'idempotencyKey', 'correlationId')) THEN
    RAISE EXCEPTION 'unknown opening balance fields' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  amount := abos.temporary_funding_amount(p_payload->>'amount');
  key := NULLIF(btrim(p_payload->>'idempotencyKey'), '');
  BEGIN
    account_id := NULLIF(p_payload->>'treasuryAccountId', '')::uuid;
    day := NULLIF(p_payload->>'asOfDate', '')::date;
    correlation := NULLIF(p_payload->>'correlationId', '')::uuid;
  EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow OR invalid_datetime_format THEN
    RAISE EXCEPTION 'a Safe, an amount, an as-of date and a request key are required' USING ERRCODE = 'invalid_parameter_value';
  END;
  currency := p_payload->>'currencyCode';
  IF account_id IS NULL OR day IS NULL OR key IS NULL OR correlation IS NULL
     OR length(p_payload->>'reference') > 120 OR length(p_payload->>'note') > 1000 THEN
    RAISE EXCEPTION 'a Safe, an amount, an as-of date and a request key are required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF day > abos.business_today() THEN
    RAISE EXCEPTION 'an opening balance cannot be dated after today' USING ERRCODE = 'check_violation';
  END IF;
  -- Authorization precedes durable replay; an identical request returns the first result.
  scope := 'treasury:opening-balance:' || entity::text || ':' || actor::text;
  fingerprint := encode(sha256(convert_to((p_payload - 'correlationId')::text || actor::text, 'UTF8')), 'hex');
  replay := abos.temporary_funding_idempotency_begin(scope, key, fingerprint, correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  -- Concurrent attempts for one Safe serialize here; the second sees the first and is refused.
  PERFORM pg_advisory_xact_lock(hashtextextended('abos-treasury-opening:' || entity::text || ':' || account_id::text, 0));
  SELECT * INTO v_account FROM abos.operational_treasury_accounts WHERE id = account_id AND legal_entity_id = entity FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the Safe was not found in this legal entity' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_account.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'an opening balance needs an active Safe' USING ERRCODE = 'check_violation';
  END IF;
  IF currency IS DISTINCT FROM v_account.currency_code THEN
    RAISE EXCEPTION 'the opening balance must be in the Safe currency %', v_account.currency_code USING ERRCODE = 'check_violation';
  END IF;
  SELECT base_currency_code INTO base FROM abos.legal_entities WHERE id = entity AND currency_policy_status = 'APPROVED';
  IF base IS NULL OR v_account.currency_code IS DISTINCT FROM base THEN
    RAISE EXCEPTION 'an opening balance in a currency other than the approved accounting currency is not available yet'
      USING ERRCODE = 'check_violation';
  END IF;
  -- 0050: only an opening balance that has not been reversed blocks a new one (checked under the Safe lock).
  IF EXISTS (SELECT 1 FROM abos.treasury_opening_balances ob WHERE ob.operational_treasury_account_id = v_account.id
       AND NOT EXISTS (SELECT 1 FROM abos.journal_reversal_links link WHERE link.original_journal_id = ob.journal_id)) THEN
    RAISE EXCEPTION 'this Safe already has an opening balance; a posted opening balance is corrected by reversal'
      USING ERRCODE = 'check_violation';
  END IF;
  equity := abos.opening_balance_equity_account(entity, base);
  period := abos.open_period_for_business_date(entity, actor, day);
  ref := 'OB-' || to_char(day, 'YYYYMMDD') || '-' || upper(replace(opening::text, '-', ''));
  INSERT INTO abos.treasury_opening_balances (id, legal_entity_id, operational_treasury_account_id, currency_code, amount,
    as_of_date, reference, note, transaction_reference, equity_ledger_account_id, journal_id, created_by_user_account_id,
    correlation_id, idempotency_key)
  VALUES (opening, entity, v_account.id, currency, amount, day, NULLIF(btrim(p_payload->>'reference'), ''),
    NULLIF(btrim(p_payload->>'note'), ''), ref, equity, journal, actor, correlation, key);
  PERFORM abos.posting_kernel_draft(
    p_intent_id => intent, p_journal_id => journal, p_legal_entity_id => entity,
    p_source_type => 'OPENING_BALANCE', p_source_id => opening,
    p_original_amount => amount, p_original_currency_code => currency, p_base_amount => amount, p_base_currency_code => base,
    p_accounting_effective_date => day, p_accounting_period_id => period, p_journal_reference => ref,
    p_correlation_id => correlation, p_idempotency_key => 'OB:' || opening::text, p_initial_status => 'VALIDATED',
    p_created_by_user_account_id => actor,
    p_lines => ARRAY[
      ROW(1, 'DEBIT', v_account.ledger_account_id, NULL, NULL, NULL, NULL, 'OPERATIONAL_TREASURY', 1, v_account.id, NULL)::abos.posting_kernel_line,
      ROW(2, 'CREDIT', equity, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)::abos.posting_kernel_line]);
  PERFORM abos.posting_kernel_commit(intent, journal, actor);
  result := jsonb_build_object('openingBalanceId', opening, 'journalId', journal, 'reference', ref, 'status', 'POSTED', 'replayed', false);
  INSERT INTO abos.audit_records (id, actor_user_account_id, legal_entity_id, correlation_id, action, entity_type, entity_id, after_state, metadata)
  VALUES (gen_random_uuid(), actor, entity, correlation, 'TREASURY_OPENING_BALANCE_POSTED', 'TREASURY_OPENING_BALANCE', opening,
    result || jsonb_build_object('treasuryAccountId', v_account.id, 'amount', amount::text, 'currency', currency, 'asOfDate', day,
      'equityAccountId', equity), jsonb_build_object('source', 'v1-treasury-opening-balance'));
  INSERT INTO abos.outbox_events (id, aggregate_type, aggregate_id, event_type, event_version, legal_entity_id, actor_user_account_id,
    correlation_id, payload, occurred_at)
  VALUES (gen_random_uuid(), 'TREASURY_OPENING_BALANCE', opening, 'finance.treasury-opening-balance.posted', 1, entity, actor, correlation,
    jsonb_build_object('openingBalanceId', opening, 'journalId', journal, 'treasuryAccountId', v_account.id), clock_timestamp());
  PERFORM abos.temporary_funding_idempotency_complete(scope, key, 'TREASURY_OPENING_BALANCE', opening, result);
  RETURN result;
END
$function$;

-- ---------------------------------------------------------------------------------------------
-- 8. Privileges. Column-level writes only; helpers run with the caller's rights and only the
--    operational Finance owner may call them; entry points are its SECURITY DEFINER functions,
--    callable only by the Finance runtime, and check the signed-in person's authority.
-- ---------------------------------------------------------------------------------------------
REVOKE ALL ON TABLE abos.accounting_period_events, abos.accounting_period_reopen_requests FROM PUBLIC;
GRANT SELECT ON abos.accounting_period_events, abos.accounting_period_reopen_requests TO abos_v1_operational_finance_owner;
GRANT INSERT (id, legal_entity_id, accounting_period_id, action, from_status, to_status, reason, reopen_request_id, actor_user_account_id,
  correlation_id) ON abos.accounting_period_events TO abos_v1_operational_finance_owner;
GRANT INSERT (id, legal_entity_id, accounting_period_id, reason, requested_by_user_account_id),
      UPDATE (status, decided_by_user_account_id, decided_at, decision_note, version)
  ON abos.accounting_period_reopen_requests TO abos_v1_operational_finance_owner;
GRANT UPDATE (closed_by_user_account_id, closed_at) ON abos.accounting_periods TO abos_v1_operational_finance_owner;
GRANT SELECT ON abos.journal_reversal_requests, abos.journal_reversal_links TO abos_v1_operational_finance_owner;
GRANT INSERT (id, legal_entity_id, journal_id, reason, status, requested_by_user_account_id),
      UPDATE (status, decided_by_user_account_id, decided_at, decision_note, version)
  ON abos.journal_reversal_requests TO abos_v1_operational_finance_owner;
GRANT INSERT (original_journal_id, reversal_journal_id, reason, approved_by_user_account_id, evidence_reference_id, reversal_mode, self_reversal)
  ON abos.journal_reversal_links TO abos_v1_operational_finance_owner;

REVOKE ALL ON FUNCTION
  abos.workflow_setting_requires_approval(uuid, text), abos.validate_reversal_journal(abos.journals, abos.posting_intents),
  abos.reversal_post(uuid, uuid, uuid, uuid, text, uuid, uuid, text), abos.operational_expense_effects(uuid, date),
  abos.reversal_reason(jsonb, text), abos.period_close_preview_json(uuid, uuid), abos.period_payload(jsonb, text[]),
  abos.period_event(uuid, uuid, text, text, text, text, uuid, uuid, jsonb), abos.period_reopen(uuid, uuid, abos.accounting_periods, text, uuid),
  abos.period_reason(jsonb)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  abos.workflow_setting_requires_approval(uuid, text), abos.validate_reversal_journal(abos.journals, abos.posting_intents),
  abos.reversal_post(uuid, uuid, uuid, uuid, text, uuid, uuid, text), abos.operational_expense_effects(uuid, date),
  abos.reversal_reason(jsonb, text), abos.period_close_preview_json(uuid, uuid), abos.period_payload(jsonb, text[]),
  abos.period_event(uuid, uuid, text, text, text, text, uuid, uuid, jsonb), abos.period_reopen(uuid, uuid, abos.accounting_periods, text, uuid),
  abos.period_reason(jsonb),
  abos.reversal_journal_blocker(uuid, uuid), abos.reversal_journal_in_scope(uuid, uuid, uuid), abos.reversal_journal_participants(uuid)
  TO abos_v1_operational_finance_owner;

ALTER FUNCTION abos.finance_journal_reversal_direct(text, text, text, jsonb) OWNER TO abos_v1_operational_finance_owner;
ALTER FUNCTION abos.finance_journal_reversal_request(text, text, text, jsonb) OWNER TO abos_v1_operational_finance_owner;
ALTER FUNCTION abos.finance_journal_reversal_decide(text, text, text, jsonb) OWNER TO abos_v1_operational_finance_owner;
ALTER FUNCTION abos.finance_journal_reversal_post_approved(text, text, text, jsonb) OWNER TO abos_v1_operational_finance_owner;
ALTER FUNCTION abos.finance_journal_reversal_withdraw(text, text, text, jsonb) OWNER TO abos_v1_operational_finance_owner;
ALTER FUNCTION abos.finance_journal_reversal_workspace(text, text, text) OWNER TO abos_v1_operational_finance_owner;
ALTER FUNCTION abos.finance_period_close_preview(text, text, text, uuid) OWNER TO abos_v1_operational_finance_owner;
ALTER FUNCTION abos.finance_period_close(text, text, text, jsonb) OWNER TO abos_v1_operational_finance_owner;
ALTER FUNCTION abos.finance_period_reopen(text, text, text, jsonb) OWNER TO abos_v1_operational_finance_owner;
ALTER FUNCTION abos.finance_period_reopen_request(text, text, text, jsonb) OWNER TO abos_v1_operational_finance_owner;
ALTER FUNCTION abos.finance_period_reopen_decide(text, text, text, jsonb) OWNER TO abos_v1_operational_finance_owner;
ALTER FUNCTION abos.finance_periods_workspace(text, text, text) OWNER TO abos_v1_operational_finance_owner;
REVOKE ALL ON FUNCTION
  abos.finance_journal_reversal_direct(text, text, text, jsonb), abos.finance_journal_reversal_request(text, text, text, jsonb),
  abos.finance_journal_reversal_decide(text, text, text, jsonb), abos.finance_journal_reversal_post_approved(text, text, text, jsonb),
  abos.finance_journal_reversal_withdraw(text, text, text, jsonb), abos.finance_journal_reversal_workspace(text, text, text),
  abos.finance_period_close_preview(text, text, text, uuid), abos.finance_period_close(text, text, text, jsonb),
  abos.finance_period_reopen(text, text, text, jsonb), abos.finance_period_reopen_request(text, text, text, jsonb),
  abos.finance_period_reopen_decide(text, text, text, jsonb), abos.finance_periods_workspace(text, text, text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  abos.finance_journal_reversal_direct(text, text, text, jsonb), abos.finance_journal_reversal_request(text, text, text, jsonb),
  abos.finance_journal_reversal_decide(text, text, text, jsonb), abos.finance_journal_reversal_post_approved(text, text, text, jsonb),
  abos.finance_journal_reversal_withdraw(text, text, text, jsonb), abos.finance_journal_reversal_workspace(text, text, text),
  abos.finance_period_close_preview(text, text, text, uuid), abos.finance_period_close(text, text, text, jsonb),
  abos.finance_period_reopen(text, text, text, jsonb), abos.finance_period_reopen_request(text, text, text, jsonb),
  abos.finance_period_reopen_decide(text, text, text, jsonb), abos.finance_periods_workspace(text, text, text)
  TO abos_e1_runtime;
