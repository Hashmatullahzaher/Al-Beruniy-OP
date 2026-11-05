-- 0061: one loan lane. See docs/03-architecture/V1_LOAN_UNIFICATION_AUDIT_AND_DECISION.md.
--
-- Money that is lent to the company is received and repaid through two new posting sources, LOAN_RECEIPT and LOAN_REPAYMENT, on the
-- existing posting kernel, reversal mechanism, FX snapshots and Safe guard. Outstanding amounts are derived from posted journals; no
-- balance is stored.
--
-- Temporary funding stays for compatibility: no row or function is removed, and its sources are marked compatibility_only.
--
-- No journal is created and no posted row is changed.

-- ---------------------------------------------------------------------------------------------
-- 1. Vocabulary.
-- ---------------------------------------------------------------------------------------------
INSERT INTO abos.permission_catalogue
  (permission_code, catalogue_version, category, availability, independence_enforced, administrative, sort_order)
VALUES
  ('finance.loan.read',    15, 'FINANCE', 'ACTIVE', false, false, 660),
  ('finance.loan.record',  15, 'FINANCE', 'ACTIVE', false, false, 661),
  ('finance.loan.repay',   15, 'FINANCE', 'ACTIVE', false, false, 662),
  ('finance.loan.approve', 15, 'FINANCE', 'ACTIVE', true,  false, 663);

ALTER TABLE abos.finance_workflow_types DROP CONSTRAINT finance_workflow_types_workflow_type_check;
ALTER TABLE abos.finance_workflow_types ADD CONSTRAINT finance_workflow_types_workflow_type_check CHECK (workflow_type IN
  ('SHAREHOLDER_CAPITAL_RECEIPT', 'CUSTOMER_RECEIPT', 'OTHER_INCOME', 'EXPENSE', 'SUPPLIER_PAYMENT', 'SALARY_PAYMENT', 'TREASURY_TRANSFER',
   'TEMPORARY_FUNDING', 'CHART_OF_ACCOUNTS', 'PERIOD_REOPEN', 'JOURNAL_REVERSAL', 'LOAN'));
INSERT INTO abos.finance_workflow_types (workflow_type, label_en, label_fa, sort_order) VALUES ('LOAN', 'Loan received or repaid', 'دریافت یا بازپرداخت قرض', 120);

ALTER TABLE abos.ledger_accounts DROP CONSTRAINT ledger_accounts_control_account_type_check;
ALTER TABLE abos.ledger_accounts ADD CONSTRAINT ledger_accounts_control_account_type_check CHECK (control_account_type IS NULL OR control_account_type IN
  ('CASH', 'SHAREHOLDER_CAPITAL', 'SHAREHOLDER_LOAN', 'AR', 'AP', 'SARAF', 'OTHER', 'TEMPORARY_FUNDING_PAYABLE', 'SHAREHOLDER_CONTRIBUTED_ASSETS',
   'OPENING_BALANCE_EQUITY', 'FX_DIFFERENCE', 'LOAN_PAYABLE'));

ALTER TABLE abos.business_party_roles DROP CONSTRAINT business_party_roles_role_code_check;
ALTER TABLE abos.business_party_roles ADD CONSTRAINT business_party_roles_role_code_check CHECK (role_code IN
  ('SHAREHOLDER', 'SARAF', 'CUSTOMER', 'SUPPLIER', 'CONTRACTOR', 'EMPLOYEE', 'LENDER'));

ALTER TABLE abos.subledger_entries DROP CONSTRAINT subledger_entries_subledger_type_check;
ALTER TABLE abos.subledger_entries ADD CONSTRAINT subledger_entries_subledger_type_check CHECK (subledger_type IN
  ('SHAREHOLDER_CAPITAL', 'SHAREHOLDER_LOAN', 'CASH_LOCATION', 'OPERATIONAL_TREASURY', 'TEMPORARY_FUNDING_PAYABLE', 'LOAN_PAYABLE'));
ALTER TABLE abos.subledger_entries DROP CONSTRAINT subledger_entries_check;
ALTER TABLE abos.subledger_entries ADD CONSTRAINT subledger_entries_check CHECK
  ((subledger_type IN ('SHAREHOLDER_CAPITAL', 'SHAREHOLDER_LOAN', 'TEMPORARY_FUNDING_PAYABLE', 'LOAN_PAYABLE')) = (business_party_id IS NOT NULL));

ALTER TABLE abos.fx_conversions DROP CONSTRAINT fx_conversions_source_type_check;
ALTER TABLE abos.fx_conversions ADD CONSTRAINT fx_conversions_source_type_check CHECK (source_type IN
  ('CASH_RECEIPT', 'PAYMENT', 'TREASURY_TRANSFER', 'OPENING_BALANCE', 'OPERATIONAL_EXPENSE', 'LOAN_RECEIPT', 'LOAN_REPAYMENT'));
ALTER TABLE abos.exchange_rate_snapshots DROP CONSTRAINT exchange_rate_snapshots_source_type_check;
ALTER TABLE abos.exchange_rate_snapshots ADD CONSTRAINT exchange_rate_snapshots_source_type_check CHECK (source_type IN
  ('CAPITAL_RECEIPT_INTENT', 'OPERATIONAL_EXPENSE', 'CASH_RECEIPT', 'PAYMENT', 'TREASURY_TRANSFER', 'OPENING_BALANCE', 'LOAN_RECEIPT', 'LOAN_REPAYMENT'));

-- ---------------------------------------------------------------------------------------------
-- 2. The loan records. What was lent and repaid, never a balance.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE abos.loans (
  id uuid PRIMARY KEY,
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  lender_business_party_id uuid NOT NULL,
  lender_type text NOT NULL CHECK (lender_type IN ('SHAREHOLDER', 'INDIVIDUAL', 'SUPPLIER', 'COMPANY', 'OTHER')),
  shareholder_profile_id uuid,
  liability_ledger_account_id uuid NOT NULL,
  operational_treasury_account_id uuid NOT NULL,
  original_amount numeric NOT NULL CHECK (original_amount > 0 AND original_amount < 'Infinity'::numeric),
  original_currency_code text NOT NULL REFERENCES abos.currencies(code),
  base_amount numeric NOT NULL CHECK (base_amount > 0 AND base_amount < 'Infinity'::numeric),
  base_currency_code text NOT NULL REFERENCES abos.currencies(code),
  fx_conversion_id uuid REFERENCES abos.fx_conversions(id),
  business_date date NOT NULL,
  reference text CHECK (reference IS NULL OR length(btrim(reference)) BETWEEN 1 AND 120),
  note text CHECK (note IS NULL OR length(btrim(note)) BETWEEN 1 AND 1000),
  transaction_reference text NOT NULL,
  status text NOT NULL CHECK (status IN ('PENDING_APPROVAL', 'REJECTED', 'POSTED')),
  decision_reason text CHECK (decision_reason IS NULL OR length(btrim(decision_reason)) BETWEEN 3 AND 500),
  decided_by_user_account_id uuid REFERENCES abos.user_accounts(id),
  decided_at timestamptz,
  workflow_policy_version_id uuid,
  journal_id uuid,
  created_by_user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  correlation_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 8 AND 200),
  UNIQUE (id, legal_entity_id),
  UNIQUE (legal_entity_id, transaction_reference),
  UNIQUE (legal_entity_id, idempotency_key),
  UNIQUE (journal_id),
  FOREIGN KEY (lender_business_party_id, legal_entity_id) REFERENCES abos.business_parties(id, legal_entity_id),
  FOREIGN KEY (shareholder_profile_id, legal_entity_id) REFERENCES abos.shareholder_profiles(id, legal_entity_id),
  FOREIGN KEY (liability_ledger_account_id, legal_entity_id) REFERENCES abos.ledger_accounts(id, legal_entity_id),
  FOREIGN KEY (operational_treasury_account_id, legal_entity_id, original_currency_code)
    REFERENCES abos.operational_treasury_accounts(id, legal_entity_id, currency_code),
  FOREIGN KEY (workflow_policy_version_id, legal_entity_id) REFERENCES abos.finance_workflow_policy_versions(id, legal_entity_id),
  FOREIGN KEY (journal_id, legal_entity_id) REFERENCES abos.journals(id, legal_entity_id),
  CHECK ((lender_type = 'SHAREHOLDER') = (shareholder_profile_id IS NOT NULL)),
  CHECK ((status = 'POSTED') = (journal_id IS NOT NULL)),
  CHECK ((status = 'REJECTED') = (decision_reason IS NOT NULL)),
  CHECK ((decided_at IS NULL) = (decided_by_user_account_id IS NULL)),
  CHECK ((original_currency_code = base_currency_code AND original_amount = base_amount AND fx_conversion_id IS NULL)
      OR (original_currency_code <> base_currency_code AND fx_conversion_id IS NOT NULL))
);
CREATE INDEX loans_entity_date_idx ON abos.loans (legal_entity_id, business_date, id);
CREATE INDEX loans_lender_idx ON abos.loans (legal_entity_id, lender_business_party_id);

CREATE TABLE abos.loan_repayments (
  id uuid PRIMARY KEY,
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  loan_id uuid NOT NULL,
  operational_treasury_account_id uuid NOT NULL,
  original_amount numeric NOT NULL CHECK (original_amount > 0 AND original_amount < 'Infinity'::numeric),
  original_currency_code text NOT NULL REFERENCES abos.currencies(code),
  base_amount numeric NOT NULL CHECK (base_amount > 0 AND base_amount < 'Infinity'::numeric),
  base_currency_code text NOT NULL REFERENCES abos.currencies(code),
  fx_conversion_id uuid REFERENCES abos.fx_conversions(id),
  business_date date NOT NULL,
  reference text CHECK (reference IS NULL OR length(btrim(reference)) BETWEEN 1 AND 120),
  note text CHECK (note IS NULL OR length(btrim(note)) BETWEEN 1 AND 1000),
  transaction_reference text NOT NULL,
  status text NOT NULL CHECK (status IN ('PENDING_APPROVAL', 'REJECTED', 'POSTED')),
  decision_reason text CHECK (decision_reason IS NULL OR length(btrim(decision_reason)) BETWEEN 3 AND 500),
  decided_by_user_account_id uuid REFERENCES abos.user_accounts(id),
  decided_at timestamptz,
  workflow_policy_version_id uuid,
  journal_id uuid,
  created_by_user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  correlation_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 8 AND 200),
  UNIQUE (id, legal_entity_id),
  UNIQUE (legal_entity_id, transaction_reference),
  UNIQUE (legal_entity_id, idempotency_key),
  UNIQUE (journal_id),
  FOREIGN KEY (loan_id, legal_entity_id) REFERENCES abos.loans(id, legal_entity_id),
  FOREIGN KEY (operational_treasury_account_id, legal_entity_id, original_currency_code)
    REFERENCES abos.operational_treasury_accounts(id, legal_entity_id, currency_code),
  FOREIGN KEY (workflow_policy_version_id, legal_entity_id) REFERENCES abos.finance_workflow_policy_versions(id, legal_entity_id),
  FOREIGN KEY (journal_id, legal_entity_id) REFERENCES abos.journals(id, legal_entity_id),
  CHECK ((status = 'POSTED') = (journal_id IS NOT NULL)),
  CHECK ((status = 'REJECTED') = (decision_reason IS NOT NULL)),
  CHECK ((decided_at IS NULL) = (decided_by_user_account_id IS NULL)),
  CHECK ((original_currency_code = base_currency_code AND original_amount = base_amount AND fx_conversion_id IS NULL)
      OR (original_currency_code <> base_currency_code AND fx_conversion_id IS NOT NULL))
);
CREATE INDEX loan_repayments_loan_idx ON abos.loan_repayments (loan_id, business_date, id);

-- A record is written once. The only change allowed is the single decision on a pending record.
CREATE FUNCTION abos.guard_loan_record()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $guard$
DECLARE frozen text[] := ARRAY['status', 'decision_reason', 'decided_by_user_account_id', 'decided_at', 'journal_id'];
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'a loan record is never deleted' USING ERRCODE = 'check_violation'; END IF;
  IF OLD.status <> 'PENDING_APPROVAL' OR NEW.status = 'PENDING_APPROVAL' OR (to_jsonb(NEW) - frozen) <> (to_jsonb(OLD) - frozen) THEN
    RAISE EXCEPTION 'a loan record changes only once, from pending to its decision' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER loans_guard BEFORE UPDATE OR DELETE ON abos.loans FOR EACH ROW EXECUTE FUNCTION abos.guard_loan_record();
CREATE TRIGGER loan_repayments_guard BEFORE UPDATE OR DELETE ON abos.loan_repayments FOR EACH ROW EXECUTE FUNCTION abos.guard_loan_record();

ALTER TABLE abos.posting_intents ADD COLUMN loan_id uuid, ADD COLUMN loan_repayment_id uuid;
ALTER TABLE abos.posting_intents ADD CONSTRAINT posting_intents_loan_fk FOREIGN KEY (loan_id, legal_entity_id) REFERENCES abos.loans(id, legal_entity_id);
ALTER TABLE abos.posting_intents ADD CONSTRAINT posting_intents_loan_repayment_fk FOREIGN KEY (loan_repayment_id, legal_entity_id) REFERENCES abos.loan_repayments(id, legal_entity_id);
ALTER TABLE abos.posting_intents DROP CONSTRAINT posting_intents_intent_kind_check;
ALTER TABLE abos.posting_intents ADD CONSTRAINT posting_intents_intent_kind_check CHECK (intent_kind IN
  ('SHAREHOLDER_CAPITAL_RECEIPT', 'SHAREHOLDER_LOAN_RECEIPT', 'REVERSAL', 'EXPENSE', 'TEMPORARY_FUNDING', 'TEMPORARY_FUNDING_SETTLEMENT',
   'DIRECT_SHAREHOLDER_CAPITAL', 'OPENING_BALANCE', 'CASH_RECEIPT', 'TREASURY_TRANSFER', 'PAYMENT', 'LOAN_RECEIPT', 'LOAN_REPAYMENT'));
ALTER TABLE abos.posting_intents ADD CONSTRAINT posting_intents_loan_shape CHECK (
  ((intent_kind = 'LOAN_RECEIPT') = (loan_id IS NOT NULL)) AND ((intent_kind = 'LOAN_REPAYMENT') = (loan_repayment_id IS NOT NULL))
  AND (loan_id IS NULL OR (source_type = 'LOAN_RECEIPT' AND source_id = loan_id AND processing_model = 'OPERATIONAL_V1'))
  AND (loan_repayment_id IS NULL OR (source_type = 'LOAN_REPAYMENT' AND source_id = loan_repayment_id AND processing_model = 'OPERATIONAL_V1')));
CREATE UNIQUE INDEX posting_intents_one_per_loan ON abos.posting_intents (loan_id) WHERE loan_id IS NOT NULL;
CREATE UNIQUE INDEX posting_intents_one_per_loan_repayment ON abos.posting_intents (loan_repayment_id) WHERE loan_repayment_id IS NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- 3. The source registry.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE abos.posting_sources ADD COLUMN compatibility_only boolean NOT NULL DEFAULT false;
INSERT INTO abos.posting_sources
  (source_type, source_kind, intent_kind, workflow_type, status, line_count, debit_rules, credit_rules, subledger_rules, reversible, validator, description)
VALUES
  ('LOAN_RECEIPT', 'LOAN_RECEIPT', 'LOAN_RECEIPT', 'LOAN', 'ACTIVE', 2,
   '[{"control": "CASH", "accountType": "ASSET"}, {"control": "SARAF", "accountType": "ASSET"}]',
   '[{"control": "SHAREHOLDER_LOAN", "accountType": "LIABILITY"}, {"control": "LOAN_PAYABLE", "accountType": "LIABILITY"}]',
   '[{"side": "DEBIT", "type": "OPERATIONAL_TREASURY", "required": true}, {"side": "CREDIT", "type": "LOAN_PAYABLE", "required": true}]',
   true, 'validate_loan_receipt_journal', 'Money lent to the company, received into a Safe or Saraf account.'),
  ('LOAN_REPAYMENT', 'LOAN_REPAYMENT', 'LOAN_REPAYMENT', 'LOAN', 'ACTIVE', 2,
   '[{"control": "SHAREHOLDER_LOAN", "accountType": "LIABILITY"}, {"control": "LOAN_PAYABLE", "accountType": "LIABILITY"}]',
   '[{"control": "CASH", "accountType": "ASSET"}, {"control": "SARAF", "accountType": "ASSET"}]',
   '[{"side": "DEBIT", "type": "LOAN_PAYABLE", "required": true}, {"side": "CREDIT", "type": "OPERATIONAL_TREASURY", "required": true}]',
   true, 'validate_loan_repayment_journal', 'Principal repaid to a lender from a Safe or Saraf account.');
ALTER TABLE abos.posting_sources DISABLE TRIGGER posting_sources_no_update_or_delete;
UPDATE abos.posting_sources SET compatibility_only = true WHERE source_type IN ('TEMPORARY_FUNDING', 'TEMPORARY_FUNDING_SETTLEMENT');
UPDATE abos.posting_sources SET subledger_rules = subledger_rules
    || '[{"side": "DEBIT", "type": "LOAN_PAYABLE", "required": false}, {"side": "CREDIT", "type": "LOAN_PAYABLE", "required": false}]'::jsonb
 WHERE source_type = 'REVERSAL';
ALTER TABLE abos.posting_sources ENABLE TRIGGER posting_sources_no_update_or_delete;

-- ---------------------------------------------------------------------------------------------
-- 4. Positions, derived from posted journals only.
-- ---------------------------------------------------------------------------------------------
-- Every posted journal that belongs to a loan: its receipt, its repayments, and any reversal of either.
CREATE FUNCTION abos.loan_journals(p_loan uuid)
RETURNS TABLE(journal_id uuid, kind text, original_journal_id uuid)
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $journals$
  WITH own AS (
    SELECT l.journal_id, 'RECEIPT'::text AS kind FROM abos.loans l WHERE l.id = p_loan AND l.status = 'POSTED'
    UNION ALL
    SELECT r.journal_id, 'REPAYMENT' FROM abos.loan_repayments r WHERE r.loan_id = p_loan AND r.status = 'POSTED')
  SELECT o.journal_id, o.kind, NULL::uuid FROM own o
  UNION ALL
  SELECT link.reversal_journal_id, o.kind || '_REVERSAL', o.journal_id
    FROM own o JOIN abos.journal_reversal_links link ON link.original_journal_id = o.journal_id
$journals$;

-- What is owed on one loan at a date, in its own currency and at accounting value. Credit-positive: an open loan is positive.
CREATE FUNCTION abos.loan_position(p_loan uuid, p_to date DEFAULT NULL)
RETURNS TABLE(outstanding numeric, base_outstanding numeric)
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $position$
  SELECT COALESCE(-sum(entry.original_amount), 0), COALESCE(-sum(entry.base_amount), 0)
    FROM abos.loan_journals(p_loan) j
    JOIN abos.journals journal ON journal.id = j.journal_id AND journal.status = 'POSTED'
    JOIN abos.journal_lines line ON line.journal_id = journal.id
    JOIN abos.subledger_entries entry ON entry.journal_line_id = line.id AND entry.subledger_type = 'LOAN_PAYABLE'
   WHERE p_to IS NULL OR journal.accounting_effective_date <= p_to
$position$;

-- ---------------------------------------------------------------------------------------------
-- 5. Journal validators, one per source, in the kernel's dispatch.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION abos.validate_loan_receipt_journal(p_journal abos.journals, p_intent abos.posting_intents)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $validate$
DECLARE l abos.loans%ROWTYPE; v_account abos.operational_treasury_accounts%ROWTYPE;
BEGIN
  SELECT * INTO l FROM abos.loans WHERE id = p_intent.source_id AND legal_entity_id = p_journal.legal_entity_id;
  IF NOT FOUND OR l.status <> 'POSTED' OR l.journal_id <> p_journal.id OR p_intent.intent_kind <> 'LOAN_RECEIPT' OR p_intent.loan_id IS DISTINCT FROM l.id
     OR NOT abos.fx_source_matches(l.legal_entity_id, 'LOAN_RECEIPT', l.id, l.original_currency_code, l.original_amount, l.base_amount, l.fx_conversion_id, p_intent)
     OR l.business_date <> p_journal.accounting_effective_date OR p_journal.journal_reference <> l.transaction_reference
     OR p_intent.created_by_user_account_id <> l.created_by_user_account_id
     OR p_intent.finance_workflow_policy_version_id IS DISTINCT FROM l.workflow_policy_version_id
     OR NOT (CASE WHEN l.decided_by_user_account_id IS NULL
          THEN p_journal.posted_by_user_account_id = l.created_by_user_account_id
           AND abos.workflow_policy_allows_direct(l.legal_entity_id, ARRAY['LOAN'], l.workflow_policy_version_id)
          ELSE p_journal.posted_by_user_account_id = l.decided_by_user_account_id
           AND l.decided_by_user_account_id <> l.created_by_user_account_id END) THEN
    RAISE EXCEPTION 'loan journal does not match its record, amount, date, reference, policy or approval' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_account FROM abos.operational_treasury_accounts WHERE id = l.operational_treasury_account_id
     AND legal_entity_id = l.legal_entity_id AND status = 'ACTIVE';
  IF NOT FOUND OR v_account.currency_code <> l.original_currency_code THEN
    RAISE EXCEPTION 'a loan is received only into an active Safe or Saraf account in its currency' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM abos.journal_lines x WHERE x.journal_id = p_journal.id AND x.line_number = 1
       AND x.ledger_account_id = v_account.ledger_account_id AND x.base_debit = l.base_amount AND x.business_party_id IS NULL)
     OR NOT EXISTS (SELECT 1 FROM abos.journal_lines x WHERE x.journal_id = p_journal.id AND x.line_number = 2
       AND x.ledger_account_id = l.liability_ledger_account_id AND x.base_credit = l.base_amount AND x.business_party_id = l.lender_business_party_id) THEN
    RAISE EXCEPTION 'a loan must debit its Treasury account and credit its liability for its lender' USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT count(*) FROM abos.subledger_entries e JOIN abos.journal_lines x ON x.id = e.journal_line_id WHERE x.journal_id = p_journal.id) <> 2
     OR NOT EXISTS (SELECT 1 FROM abos.subledger_entries e JOIN abos.journal_lines x ON x.id = e.journal_line_id
       WHERE x.journal_id = p_journal.id AND x.line_number = 1 AND e.subledger_type = 'OPERATIONAL_TREASURY'
         AND e.operational_treasury_account_id = v_account.id AND e.base_amount = l.base_amount AND e.original_amount = l.original_amount)
     OR NOT EXISTS (SELECT 1 FROM abos.subledger_entries e JOIN abos.journal_lines x ON x.id = e.journal_line_id
       WHERE x.journal_id = p_journal.id AND x.line_number = 2 AND e.subledger_type = 'LOAN_PAYABLE'
         AND e.business_party_id = l.lender_business_party_id AND e.base_amount = -l.base_amount AND e.original_amount = -l.original_amount) THEN
    RAISE EXCEPTION 'a loan must move its Treasury account and its lender''s position by its exact amounts' USING ERRCODE = 'check_violation';
  END IF;
END
$validate$;

CREATE FUNCTION abos.validate_loan_repayment_journal(p_journal abos.journals, p_intent abos.posting_intents)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $validate$
DECLARE r abos.loan_repayments%ROWTYPE; l abos.loans%ROWTYPE; v_account abos.operational_treasury_accounts%ROWTYPE;
BEGIN
  SELECT * INTO r FROM abos.loan_repayments WHERE id = p_intent.source_id AND legal_entity_id = p_journal.legal_entity_id;
  IF NOT FOUND OR r.status <> 'POSTED' OR r.journal_id <> p_journal.id OR p_intent.intent_kind <> 'LOAN_REPAYMENT' OR p_intent.loan_repayment_id IS DISTINCT FROM r.id
     OR NOT abos.fx_source_matches(r.legal_entity_id, 'LOAN_REPAYMENT', r.id, r.original_currency_code, r.original_amount, r.base_amount, r.fx_conversion_id, p_intent)
     OR r.business_date <> p_journal.accounting_effective_date OR p_journal.journal_reference <> r.transaction_reference
     OR p_intent.created_by_user_account_id <> r.created_by_user_account_id
     OR p_intent.finance_workflow_policy_version_id IS DISTINCT FROM r.workflow_policy_version_id
     OR NOT (CASE WHEN r.decided_by_user_account_id IS NULL
          THEN p_journal.posted_by_user_account_id = r.created_by_user_account_id
           AND abos.workflow_policy_allows_direct(r.legal_entity_id, ARRAY['LOAN'], r.workflow_policy_version_id)
          ELSE p_journal.posted_by_user_account_id = r.decided_by_user_account_id
           AND r.decided_by_user_account_id <> r.created_by_user_account_id END) THEN
    RAISE EXCEPTION 'repayment journal does not match its record, amount, date, reference, policy or approval' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO l FROM abos.loans WHERE id = r.loan_id AND legal_entity_id = r.legal_entity_id AND status = 'POSTED';
  IF NOT FOUND OR l.original_currency_code <> r.original_currency_code THEN
    RAISE EXCEPTION 'a repayment belongs to a posted loan in its currency' USING ERRCODE = 'check_violation';
  END IF;
  -- This journal is not posted yet, so the position is still the amount owed before it.
  IF (SELECT outstanding FROM abos.loan_position(l.id)) < r.original_amount THEN
    RAISE EXCEPTION 'a repayment cannot exceed what is outstanding on the loan' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_account FROM abos.operational_treasury_accounts WHERE id = r.operational_treasury_account_id
     AND legal_entity_id = r.legal_entity_id AND status = 'ACTIVE';
  IF NOT FOUND OR v_account.currency_code <> r.original_currency_code THEN
    RAISE EXCEPTION 'a loan is repaid only from an active Safe or Saraf account in its currency' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM abos.journal_lines x WHERE x.journal_id = p_journal.id AND x.line_number = 1
       AND x.ledger_account_id = l.liability_ledger_account_id AND x.base_debit = r.base_amount AND x.business_party_id = l.lender_business_party_id)
     OR NOT EXISTS (SELECT 1 FROM abos.journal_lines x WHERE x.journal_id = p_journal.id AND x.line_number = 2
       AND x.ledger_account_id = v_account.ledger_account_id AND x.base_credit = r.base_amount AND x.business_party_id IS NULL) THEN
    RAISE EXCEPTION 'a repayment must debit its loan liability for its lender and credit its Treasury account' USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT count(*) FROM abos.subledger_entries e JOIN abos.journal_lines x ON x.id = e.journal_line_id WHERE x.journal_id = p_journal.id) <> 2
     OR NOT EXISTS (SELECT 1 FROM abos.subledger_entries e JOIN abos.journal_lines x ON x.id = e.journal_line_id
       WHERE x.journal_id = p_journal.id AND x.line_number = 1 AND e.subledger_type = 'LOAN_PAYABLE'
         AND e.business_party_id = l.lender_business_party_id AND e.base_amount = r.base_amount AND e.original_amount = r.original_amount)
     OR NOT EXISTS (SELECT 1 FROM abos.subledger_entries e JOIN abos.journal_lines x ON x.id = e.journal_line_id
       WHERE x.journal_id = p_journal.id AND x.line_number = 2 AND e.subledger_type = 'OPERATIONAL_TREASURY'
         AND e.operational_treasury_account_id = v_account.id AND e.base_amount = -r.base_amount AND e.original_amount = -r.original_amount) THEN
    RAISE EXCEPTION 'a repayment must move its lender''s position and its Treasury account by its exact amounts' USING ERRCODE = 'check_violation';
  END IF;
END
$validate$;

-- The one rule a loan adds to the standard reversal. The lock serializes a reversal with any repayment of the same loan.
CREATE FUNCTION abos.guard_loan_reversal_link()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $guard$
DECLARE v_kind text; v_loan uuid;
BEGIN
  SELECT intent.source_type,
         CASE intent.source_type WHEN 'LOAN_RECEIPT' THEN intent.loan_id WHEN 'LOAN_REPAYMENT' THEN (SELECT r.loan_id FROM abos.loan_repayments r WHERE r.id = intent.loan_repayment_id) END
    INTO v_kind, v_loan
    FROM abos.journals journal JOIN abos.posting_intents intent ON intent.id = journal.posting_intent_id
   WHERE journal.id = NEW.original_journal_id;
  IF v_loan IS NULL THEN RETURN NEW; END IF;
  PERFORM 1 FROM abos.loans WHERE id = v_loan FOR UPDATE;
  IF v_kind = 'LOAN_RECEIPT' AND EXISTS (
       SELECT 1 FROM abos.loan_repayments r WHERE r.loan_id = v_loan AND r.status = 'POSTED'
          AND NOT EXISTS (SELECT 1 FROM abos.journal_reversal_links link WHERE link.original_journal_id = r.journal_id)) THEN
    RAISE EXCEPTION 'this loan has repayments; reverse them before reversing the loan' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER ab_journal_reversal_links_loan_lineage BEFORE INSERT ON abos.journal_reversal_links
  FOR EACH ROW EXECUTE FUNCTION abos.guard_loan_reversal_link();

-- ---------------------------------------------------------------------------------------------
-- 6. The lanes.
-- ---------------------------------------------------------------------------------------------
-- The company setting for loans. No saved setting means OFF, as for other money movements.
CREATE FUNCTION abos.loan_policy(p_entity uuid)
RETURNS TABLE(policy_id uuid, approval_required boolean)
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $policy$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('abos-finance-workflow-policy:' || p_entity::text || ':LOAN', 0));
  RETURN QUERY SELECT v.id, v.approval_required FROM abos.finance_workflow_policy_versions v
    WHERE v.legal_entity_id = p_entity AND v.workflow_type = 'LOAN' ORDER BY v.version DESC LIMIT 1;
  IF NOT FOUND THEN RETURN QUERY SELECT NULL::uuid, false; END IF;
END
$policy$;

-- The liability a lender's money is owed on: shareholder loans and other loans stay on their own control.
CREATE FUNCTION abos.loan_liability_account(p_entity uuid, p_lender_type text, p_chosen uuid, p_base text)
RETURNS uuid LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $account$
DECLARE v_control text := CASE WHEN p_lender_type = 'SHAREHOLDER' THEN 'SHAREHOLDER_LOAN' ELSE 'LOAN_PAYABLE' END; v_found uuid[];
BEGIN
  SELECT array_agg(a.id) INTO v_found FROM abos.ledger_accounts a
   WHERE a.legal_entity_id = p_entity AND a.status = 'ACTIVE' AND a.posting_allowed AND a.account_type = 'LIABILITY' AND a.control_account_type = v_control
     AND (a.account_currency_code IS NULL OR a.account_currency_code = p_base)
     AND NOT a.requires_project AND NOT a.requires_department AND NOT a.requires_cost_center
     AND (p_chosen IS NULL OR a.id = p_chosen);
  IF v_found IS NULL THEN
    RAISE EXCEPTION 'LOAN_ACCOUNT_REQUIRED: create an active % liability account in the Chart of Accounts first', v_control USING ERRCODE = 'check_violation';
  END IF;
  IF cardinality(v_found) > 1 THEN
    RAISE EXCEPTION 'LOAN_ACCOUNT_CHOICE: choose which liability account this loan is owed on' USING ERRCODE = 'check_violation';
  END IF;
  RETURN v_found[1];
END
$account$;

CREATE FUNCTION abos.loan_post(p_loan uuid, p_actor uuid, p_decided boolean)
RETURNS uuid LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $post$
DECLARE l abos.loans%ROWTYPE; v_account abos.operational_treasury_accounts%ROWTYPE; v_period uuid; v_snapshot text;
  v_journal uuid := gen_random_uuid(); v_intent uuid := gen_random_uuid();
BEGIN
  IF current_user <> 'abos_v1_operational_finance_owner' THEN
    RAISE EXCEPTION 'loan posting is internal' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO l FROM abos.loans WHERE id = p_loan FOR UPDATE;
  v_account := abos.money_treasury_account(l.legal_entity_id, l.operational_treasury_account_id, l.original_currency_code);
  v_period := abos.open_period_for_business_date(l.legal_entity_id, p_actor, l.business_date);
  SELECT exchange_rate_snapshot_id::text INTO v_snapshot FROM abos.fx_conversions WHERE id = l.fx_conversion_id;
  PERFORM abos.posting_kernel_draft(
    p_intent_id => v_intent, p_journal_id => v_journal, p_legal_entity_id => l.legal_entity_id, p_source_type => 'LOAN_RECEIPT', p_source_id => l.id,
    p_original_amount => l.original_amount, p_original_currency_code => l.original_currency_code, p_base_amount => l.base_amount, p_base_currency_code => l.base_currency_code,
    p_accounting_effective_date => l.business_date, p_accounting_period_id => v_period, p_journal_reference => l.transaction_reference, p_correlation_id => l.correlation_id,
    p_idempotency_key => 'LN:' || l.id::text, p_initial_status => CASE WHEN p_decided THEN 'APPROVED' ELSE 'VALIDATED' END, p_created_by_user_account_id => l.created_by_user_account_id,
    p_lines => ARRAY[
      ROW(1, 'DEBIT', v_account.ledger_account_id, NULL, NULL, NULL, NULL, 'OPERATIONAL_TREASURY', 1, v_account.id, NULL)::abos.posting_kernel_line,
      ROW(2, 'CREDIT', l.liability_ledger_account_id, l.lender_business_party_id, NULL, NULL, NULL, 'LOAN_PAYABLE', -1, NULL, l.lender_business_party_id)::abos.posting_kernel_line],
    p_conversion_snapshot_reference => v_snapshot, p_finance_workflow_policy_version_id => l.workflow_policy_version_id);
  -- The decision and the posting are one change: the validator proves the approver is the one who posted.
  UPDATE abos.loans SET status = 'POSTED', journal_id = v_journal, decided_by_user_account_id = CASE WHEN p_decided THEN p_actor END,
         decided_at = CASE WHEN p_decided THEN clock_timestamp() END WHERE id = l.id;
  PERFORM abos.posting_kernel_commit(v_intent, v_journal, p_actor);
  RETURN v_journal;
END
$post$;

CREATE FUNCTION abos.loan_repayment_post(p_repayment uuid, p_actor uuid, p_decided boolean)
RETURNS uuid LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $post$
DECLARE r abos.loan_repayments%ROWTYPE; l abos.loans%ROWTYPE; v_account abos.operational_treasury_accounts%ROWTYPE; v_period uuid; v_snapshot text;
  v_journal uuid := gen_random_uuid(); v_intent uuid := gen_random_uuid();
BEGIN
  IF current_user <> 'abos_v1_operational_finance_owner' THEN
    RAISE EXCEPTION 'loan posting is internal' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO r FROM abos.loan_repayments WHERE id = p_repayment;
  -- The loan row is the lock: two repayments, or a repayment and a reversal, of one loan run one at a time.
  SELECT * INTO l FROM abos.loans WHERE id = r.loan_id FOR UPDATE;
  SELECT * INTO r FROM abos.loan_repayments WHERE id = p_repayment FOR UPDATE;
  IF (SELECT outstanding FROM abos.loan_position(l.id)) < r.original_amount THEN
    RAISE EXCEPTION 'REPAYMENT_EXCEEDS_OUTSTANDING: a repayment cannot exceed what is outstanding on the loan' USING ERRCODE = 'check_violation';
  END IF;
  v_account := abos.money_treasury_account(r.legal_entity_id, r.operational_treasury_account_id, r.original_currency_code);
  v_period := abos.open_period_for_business_date(r.legal_entity_id, p_actor, r.business_date);
  SELECT exchange_rate_snapshot_id::text INTO v_snapshot FROM abos.fx_conversions WHERE id = r.fx_conversion_id;
  PERFORM abos.posting_kernel_draft(
    p_intent_id => v_intent, p_journal_id => v_journal, p_legal_entity_id => r.legal_entity_id, p_source_type => 'LOAN_REPAYMENT', p_source_id => r.id,
    p_original_amount => r.original_amount, p_original_currency_code => r.original_currency_code, p_base_amount => r.base_amount, p_base_currency_code => r.base_currency_code,
    p_accounting_effective_date => r.business_date, p_accounting_period_id => v_period, p_journal_reference => r.transaction_reference, p_correlation_id => r.correlation_id,
    p_idempotency_key => 'LR:' || r.id::text, p_initial_status => CASE WHEN p_decided THEN 'APPROVED' ELSE 'VALIDATED' END, p_created_by_user_account_id => r.created_by_user_account_id,
    p_lines => ARRAY[
      ROW(1, 'DEBIT', l.liability_ledger_account_id, l.lender_business_party_id, NULL, NULL, NULL, 'LOAN_PAYABLE', 1, NULL, l.lender_business_party_id)::abos.posting_kernel_line,
      ROW(2, 'CREDIT', v_account.ledger_account_id, NULL, NULL, NULL, NULL, 'OPERATIONAL_TREASURY', -1, v_account.id, NULL)::abos.posting_kernel_line],
    p_conversion_snapshot_reference => v_snapshot, p_finance_workflow_policy_version_id => r.workflow_policy_version_id);
  UPDATE abos.loan_repayments SET status = 'POSTED', journal_id = v_journal, decided_by_user_account_id = CASE WHEN p_decided THEN p_actor END,
         decided_at = CASE WHEN p_decided THEN clock_timestamp() END WHERE id = r.id;
  PERFORM abos.posting_kernel_commit(v_intent, v_journal, p_actor);
  RETURN v_journal;
END
$post$;

CREATE FUNCTION abos.finance_loan_record(p_proof text, p_runtime text, p_token text, p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $record$
DECLARE c jsonb; actor uuid; entity uuid; req jsonb; amount numeric; day date; key text; correlation uuid; currency text; base text; v_account abos.operational_treasury_accounts%ROWTYPE;
  lender_type text; party uuid; profile uuid; v_name text; liability uuid; policy uuid; approval boolean; scope text; fingerprint text; replay jsonb; ref text; result jsonb;
  v_base_amount numeric; v_conversion abos.fx_conversions%ROWTYPE; loan uuid := gen_random_uuid(); journal uuid;
BEGIN
  c := abos.treasury_safe_actor(p_proof, p_runtime, p_token, 'finance.loan.record');
  actor := (c->>'userAccountId')::uuid; entity := (c->>'legalEntityId')::uuid;
  req := abos.money_request(p_payload, ARRAY['lenderType', 'lenderBusinessPartyId', 'lenderName', 'shareholderProfileId', 'liabilityLedgerAccountId', 'treasuryAccountId',
    'amount', 'currencyCode', 'businessDate', 'reference', 'note', 'exchangeRateId', 'idempotencyKey', 'correlationId']);
  amount := (req->>'amount')::numeric; day := (req->>'date')::date; key := req->>'key'; correlation := (req->>'correlation')::uuid;
  currency := p_payload->>'currencyCode'; lender_type := p_payload->>'lenderType';
  party := abos.money_uuid(p_payload, 'lenderBusinessPartyId'); profile := abos.money_uuid(p_payload, 'shareholderProfileId');
  v_name := NULLIF(btrim(p_payload->>'lenderName'), '');
  IF lender_type IS NULL OR lender_type NOT IN ('SHAREHOLDER', 'INDIVIDUAL', 'SUPPLIER', 'COMPANY', 'OTHER') THEN
    RAISE EXCEPTION 'choose who lent the money' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF abos.money_uuid(p_payload, 'treasuryAccountId') IS NULL THEN
    RAISE EXCEPTION 'choose the Safe the money went into' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF (lender_type = 'SHAREHOLDER') <> (profile IS NOT NULL) OR (lender_type = 'SHAREHOLDER' AND (party IS NOT NULL OR v_name IS NOT NULL))
     OR (lender_type <> 'SHAREHOLDER' AND (party IS NULL) = (v_name IS NULL)) OR length(v_name) > 160 THEN
    RAISE EXCEPTION 'name the lender once: a shareholder, a person or organization already known, or a new name' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  scope := 'loan:record:' || entity::text || ':' || actor::text;
  fingerprint := encode(sha256(convert_to((p_payload - 'correlationId')::text || actor::text, 'UTF8')), 'hex');
  replay := abos.temporary_funding_idempotency_begin(scope, key, fingerprint, correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  base := abos.money_currency_base(entity, currency);
  v_account := abos.money_treasury_account(entity, abos.money_uuid(p_payload, 'treasuryAccountId'), currency);
  IF lender_type = 'SHAREHOLDER' THEN
    SELECT business_party_id INTO party FROM abos.shareholder_profiles WHERE id = profile AND legal_entity_id = entity AND status = 'ACTIVE';
    IF party IS NULL THEN RAISE EXCEPTION 'shareholder not found in this legal entity' USING ERRCODE = 'no_data_found'; END IF;
  ELSIF party IS NOT NULL THEN
    PERFORM abos.money_party(entity, party, NULL);
  ELSE
    party := gen_random_uuid();
    INSERT INTO abos.business_parties (id, legal_entity_id, display_name, status) VALUES (party, entity, v_name, 'ACTIVE');
    INSERT INTO abos.business_party_roles (business_party_id, role_code, effective_from) VALUES (party, 'LENDER', day);
  END IF;
  liability := abos.loan_liability_account(entity, lender_type, abos.money_uuid(p_payload, 'liabilityLedgerAccountId'), base);
  SELECT policy_id, approval_required INTO policy, approval FROM abos.loan_policy(entity);
  IF currency = base THEN
    v_base_amount := amount;
  ELSE
    v_conversion := abos.fx_convert(entity, 'LOAN_RECEIPT', loan, currency, day, abos.money_uuid(p_payload, 'exchangeRateId'), actor, amount);
    v_base_amount := v_conversion.base_amount;
  END IF;
  ref := 'LN-' || to_char(day, 'YYYYMMDD') || '-' || upper(replace(loan::text, '-', ''));
  INSERT INTO abos.loans (id, legal_entity_id, lender_business_party_id, lender_type, shareholder_profile_id, liability_ledger_account_id, operational_treasury_account_id,
    original_amount, original_currency_code, base_amount, base_currency_code, fx_conversion_id, business_date, reference, note, transaction_reference, status,
    workflow_policy_version_id, created_by_user_account_id, correlation_id, idempotency_key)
  VALUES (loan, entity, party, lender_type, profile, liability, v_account.id, amount, currency, v_base_amount, base, v_conversion.id, day,
    NULLIF(btrim(p_payload->>'reference'), ''), NULLIF(btrim(p_payload->>'note'), ''), ref, 'PENDING_APPROVAL', policy, actor, correlation, key);
  IF NOT approval THEN journal := abos.loan_post(loan, actor, false); END IF;
  result := jsonb_build_object('loanId', loan, 'journalId', journal, 'reference', ref, 'lenderBusinessPartyId', party, 'currencyCode', currency, 'amount', amount::text,
    'baseAmount', v_base_amount::text, 'status', CASE WHEN approval THEN 'PENDING_APPROVAL' ELSE 'POSTED' END, 'replayed', false);
  PERFORM abos.money_audit(actor, entity, correlation, 'LOAN_RECORDED', 'LOAN', loan, result || jsonb_build_object('lenderType', lender_type, 'treasuryAccountId', v_account.id,
    'liabilityAccountId', liability, 'businessDate', day));
  PERFORM abos.temporary_funding_idempotency_complete(scope, key, 'LOAN', loan, result);
  RETURN result;
END
$record$;

CREATE FUNCTION abos.finance_loan_repay(p_proof text, p_runtime text, p_token text, p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $repay$
DECLARE c jsonb; actor uuid; entity uuid; req jsonb; amount numeric; day date; key text; correlation uuid; l abos.loans%ROWTYPE; v_account abos.operational_treasury_accounts%ROWTYPE;
  policy uuid; approval boolean; scope text; fingerprint text; replay jsonb; ref text; result jsonb; v_base_amount numeric; v_conversion abos.fx_conversions%ROWTYPE; v_owed numeric; v_pending numeric;
  repayment uuid := gen_random_uuid(); journal uuid;
BEGIN
  c := abos.treasury_safe_actor(p_proof, p_runtime, p_token, 'finance.loan.repay');
  actor := (c->>'userAccountId')::uuid; entity := (c->>'legalEntityId')::uuid;
  req := abos.money_request(p_payload, ARRAY['loanId', 'treasuryAccountId', 'amount', 'businessDate', 'reference', 'note', 'exchangeRateId', 'idempotencyKey', 'correlationId']);
  amount := (req->>'amount')::numeric; day := (req->>'date')::date; key := req->>'key'; correlation := (req->>'correlation')::uuid;
  IF abos.money_uuid(p_payload, 'loanId') IS NULL OR abos.money_uuid(p_payload, 'treasuryAccountId') IS NULL THEN
    RAISE EXCEPTION 'choose the loan and the Safe it is repaid from' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  scope := 'loan:repay:' || entity::text || ':' || actor::text;
  fingerprint := encode(sha256(convert_to((p_payload - 'correlationId')::text || actor::text, 'UTF8')), 'hex');
  replay := abos.temporary_funding_idempotency_begin(scope, key, fingerprint, correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  -- The loan row is the lock: repayments and reversals of one loan run one at a time.
  SELECT * INTO l FROM abos.loans WHERE id = abos.money_uuid(p_payload, 'loanId') AND legal_entity_id = entity FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'loan not found in this legal entity' USING ERRCODE = 'no_data_found'; END IF;
  IF l.status <> 'POSTED' THEN RAISE EXCEPTION 'only a posted loan can be repaid' USING ERRCODE = 'check_violation'; END IF;
  IF day < l.business_date THEN RAISE EXCEPTION 'a repayment cannot be dated before its loan' USING ERRCODE = 'check_violation'; END IF;
  SELECT outstanding INTO v_owed FROM abos.loan_position(l.id);
  SELECT COALESCE(sum(r.original_amount), 0) INTO v_pending FROM abos.loan_repayments r WHERE r.loan_id = l.id AND r.status = 'PENDING_APPROVAL';
  IF amount > v_owed - v_pending THEN
    RAISE EXCEPTION 'REPAYMENT_EXCEEDS_OUTSTANDING: a repayment cannot exceed what is outstanding on the loan' USING ERRCODE = 'check_violation';
  END IF;
  v_account := abos.money_treasury_account(entity, abos.money_uuid(p_payload, 'treasuryAccountId'), l.original_currency_code);
  SELECT policy_id, approval_required INTO policy, approval FROM abos.loan_policy(entity);
  IF l.original_currency_code = l.base_currency_code THEN
    v_base_amount := amount;
  ELSE
    v_conversion := abos.fx_convert(entity, 'LOAN_REPAYMENT', repayment, l.original_currency_code, day, abos.money_uuid(p_payload, 'exchangeRateId'), actor, amount);
    v_base_amount := v_conversion.base_amount;
  END IF;
  ref := 'LR-' || to_char(day, 'YYYYMMDD') || '-' || upper(replace(repayment::text, '-', ''));
  INSERT INTO abos.loan_repayments (id, legal_entity_id, loan_id, operational_treasury_account_id, original_amount, original_currency_code, base_amount, base_currency_code,
    fx_conversion_id, business_date, reference, note, transaction_reference, status, workflow_policy_version_id, created_by_user_account_id, correlation_id, idempotency_key)
  VALUES (repayment, entity, l.id, v_account.id, amount, l.original_currency_code, v_base_amount, l.base_currency_code, v_conversion.id, day,
    NULLIF(btrim(p_payload->>'reference'), ''), NULLIF(btrim(p_payload->>'note'), ''), ref, 'PENDING_APPROVAL', policy, actor, correlation, key);
  IF NOT approval THEN journal := abos.loan_repayment_post(repayment, actor, false); END IF;
  result := jsonb_build_object('repaymentId', repayment, 'loanId', l.id, 'journalId', journal, 'reference', ref, 'currencyCode', l.original_currency_code, 'amount', amount::text,
    'baseAmount', v_base_amount::text, 'status', CASE WHEN approval THEN 'PENDING_APPROVAL' ELSE 'POSTED' END, 'replayed', false);
  PERFORM abos.money_audit(actor, entity, correlation, 'LOAN_REPAYMENT_RECORDED', 'LOAN_REPAYMENT', repayment, result || jsonb_build_object('treasuryAccountId', v_account.id, 'businessDate', day));
  PERFORM abos.temporary_funding_idempotency_complete(scope, key, 'LOAN_REPAYMENT', repayment, result);
  RETURN result;
END
$repay$;

-- A second person decides a pending loan or repayment. The maker can never approve their own record.
CREATE FUNCTION abos.finance_loan_decide(p_proof text, p_runtime text, p_token text, p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $decide$
DECLARE c jsonb; actor uuid; entity uuid; kind text; record_id uuid; decision text; reason text; key text; correlation uuid; scope text; fingerprint text; replay jsonb; result jsonb;
  maker uuid; state text; journal uuid; loan_row uuid;
BEGIN
  c := abos.treasury_safe_actor(p_proof, p_runtime, p_token, 'finance.loan.approve');
  actor := (c->>'userAccountId')::uuid; entity := (c->>'legalEntityId')::uuid;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_payload) k WHERE k NOT IN ('kind', 'id', 'decision', 'reason', 'idempotencyKey', 'correlationId')) THEN
    RAISE EXCEPTION 'unknown decision fields' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  kind := p_payload->>'kind'; decision := p_payload->>'decision'; reason := NULLIF(btrim(p_payload->>'reason'), ''); record_id := abos.money_uuid(p_payload, 'id');
  key := NULLIF(btrim(p_payload->>'idempotencyKey'), ''); correlation := abos.money_uuid(p_payload, 'correlationId');
  IF kind IS NULL OR kind NOT IN ('LOAN', 'REPAYMENT') OR decision IS NULL OR decision NOT IN ('APPROVED', 'REJECTED') OR record_id IS NULL OR correlation IS NULL
     OR key IS NULL OR length(key) NOT BETWEEN 8 AND 200 OR (decision = 'REJECTED' AND (reason IS NULL OR length(reason) NOT BETWEEN 3 AND 500)) THEN
    RAISE EXCEPTION 'a decision needs its record, an outcome and, to reject, a reason' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  scope := 'loan:decide:' || entity::text || ':' || actor::text;
  fingerprint := encode(sha256(convert_to((p_payload - 'correlationId')::text || actor::text, 'UTF8')), 'hex');
  replay := abos.temporary_funding_idempotency_begin(scope, key, fingerprint, correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  IF kind = 'LOAN' THEN
    SELECT created_by_user_account_id, status, id INTO maker, state, loan_row FROM abos.loans WHERE id = record_id AND legal_entity_id = entity FOR UPDATE;
  ELSE
    SELECT loan_id INTO loan_row FROM abos.loan_repayments WHERE id = record_id AND legal_entity_id = entity;
    PERFORM 1 FROM abos.loans WHERE id = loan_row FOR UPDATE;
    SELECT created_by_user_account_id, status INTO maker, state FROM abos.loan_repayments WHERE id = record_id AND legal_entity_id = entity FOR UPDATE;
  END IF;
  IF state IS NULL THEN RAISE EXCEPTION 'record not found in this legal entity' USING ERRCODE = 'no_data_found'; END IF;
  IF state <> 'PENDING_APPROVAL' THEN RAISE EXCEPTION 'this record has already been decided' USING ERRCODE = 'check_violation'; END IF;
  IF maker = actor THEN RAISE EXCEPTION 'whoever recorded it cannot decide it' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF decision = 'REJECTED' THEN
    IF kind = 'LOAN' THEN
      UPDATE abos.loans SET status = 'REJECTED', decision_reason = reason, decided_by_user_account_id = actor, decided_at = clock_timestamp() WHERE id = record_id;
    ELSE
      UPDATE abos.loan_repayments SET status = 'REJECTED', decision_reason = reason, decided_by_user_account_id = actor, decided_at = clock_timestamp() WHERE id = record_id;
    END IF;
  ELSE
    IF kind = 'LOAN' THEN journal := abos.loan_post(record_id, actor, true); ELSE journal := abos.loan_repayment_post(record_id, actor, true); END IF;
  END IF;
  result := jsonb_build_object('id', record_id, 'kind', kind, 'status', CASE WHEN decision = 'APPROVED' THEN 'POSTED' ELSE 'REJECTED' END, 'journalId', journal, 'replayed', false);
  PERFORM abos.money_audit(actor, entity, correlation, 'LOAN_DECIDED', CASE kind WHEN 'LOAN' THEN 'LOAN' ELSE 'LOAN_REPAYMENT' END, record_id, result || jsonb_build_object('decision', decision, 'reason', reason));
  PERFORM abos.temporary_funding_idempotency_complete(scope, key, CASE kind WHEN 'LOAN' THEN 'LOAN' ELSE 'LOAN_REPAYMENT' END, record_id, result);
  RETURN result;
END
$decide$;

-- ---------------------------------------------------------------------------------------------
-- 7. What the kernel and the Chart of Accounts must now know. Each is the applied definition with only the loan lines added.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION abos.coa_validate(p_code text, p_name text, p_name_fa text, p_description text, p_type text, p_control text, p_currency text, p_posting boolean, p_status text)
 RETURNS void
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  IF p_code IS NULL OR p_code !~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,31}$' THEN
    RAISE EXCEPTION 'the account code must be 1-32 letters, digits or . _ / - and start with a letter or digit'
      USING ERRCODE = 'check_violation';
  END IF;
  IF p_name IS NULL OR length(p_name) NOT BETWEEN 2 AND 120 THEN
    RAISE EXCEPTION 'the account name must be 2-120 characters' USING ERRCODE = 'check_violation';
  END IF;
  IF p_name_fa IS NOT NULL AND length(p_name_fa) > 120 THEN
    RAISE EXCEPTION 'the Dari account name must be at most 120 characters' USING ERRCODE = 'check_violation';
  END IF;
  IF p_description IS NOT NULL AND length(p_description) > 500 THEN
    RAISE EXCEPTION 'the description must be at most 500 characters' USING ERRCODE = 'check_violation';
  END IF;
  IF p_type IS NULL OR p_type NOT IN ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE') THEN
    RAISE EXCEPTION 'the account type must be ASSET, LIABILITY, EQUITY, REVENUE or EXPENSE' USING ERRCODE = 'check_violation';
  END IF;
  IF p_control IS NOT NULL AND p_control NOT IN ('CASH', 'SARAF', 'SHAREHOLDER_CAPITAL', 'SHAREHOLDER_LOAN', 'AR', 'AP', 'OTHER',
                                                 'TEMPORARY_FUNDING_PAYABLE', 'SHAREHOLDER_CONTRIBUTED_ASSETS', 'OPENING_BALANCE_EQUITY',
                                                 'FX_DIFFERENCE', 'LOAN_PAYABLE') THEN
    RAISE EXCEPTION 'unknown control account type %', p_control USING ERRCODE = 'check_violation';
  END IF;
  -- A control account must carry the account type its balance has by definition.
  IF (p_control IN ('CASH', 'AR', 'SHAREHOLDER_CONTRIBUTED_ASSETS') AND p_type <> 'ASSET')
     OR (p_control IN ('AP', 'SHAREHOLDER_LOAN', 'TEMPORARY_FUNDING_PAYABLE', 'LOAN_PAYABLE') AND p_type <> 'LIABILITY')
     OR (p_control IN ('SHAREHOLDER_CAPITAL', 'OPENING_BALANCE_EQUITY') AND p_type <> 'EQUITY')
     OR (p_control = 'SARAF' AND p_type NOT IN ('ASSET', 'LIABILITY'))
     OR (p_control = 'FX_DIFFERENCE' AND p_type NOT IN ('REVENUE', 'EXPENSE')) THEN
    RAISE EXCEPTION 'a % control account cannot have account type %', p_control, p_type USING ERRCODE = 'check_violation';
  END IF;
  IF p_posting IS NULL THEN
    RAISE EXCEPTION 'say whether the account accepts postings' USING ERRCODE = 'check_violation';
  END IF;
  -- Currencies are never combined: an account that takes postings, or a control account, has one.
  IF p_currency IS NULL AND (p_posting OR p_control IS NOT NULL) THEN
    RAISE EXCEPTION 'an account that accepts postings, or a control account, needs a currency' USING ERRCODE = 'check_violation';
  END IF;
  IF p_currency IS NOT NULL AND p_status = 'ACTIVE'
     AND NOT EXISTS (SELECT 1 FROM abos.currencies c WHERE c.code = p_currency AND c.enabled) THEN
    RAISE EXCEPTION 'currency % is not enabled', p_currency USING ERRCODE = 'check_violation';
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION abos.finance_workflow_approval_available(p_workflow_type text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  -- 0052: PERIOD_REOPEN is withdrawn with the monthly reopen; it is never available.
  SELECT p_workflow_type IN ('CHART_OF_ACCOUNTS', 'SHAREHOLDER_CAPITAL_RECEIPT', 'EXPENSE', 'TEMPORARY_FUNDING', 'JOURNAL_REVERSAL', 'LOAN')
$function$;

CREATE OR REPLACE FUNCTION abos.posting_kernel_draft(p_intent_id uuid, p_journal_id uuid, p_legal_entity_id uuid, p_source_type text, p_source_id uuid, p_original_amount numeric, p_original_currency_code text, p_base_amount numeric, p_base_currency_code text, p_accounting_effective_date date, p_accounting_period_id uuid, p_journal_reference text, p_correlation_id uuid, p_idempotency_key text, p_initial_status text, p_created_by_user_account_id uuid, p_lines abos.posting_kernel_line[], p_project_id uuid DEFAULT NULL::uuid, p_department_id uuid DEFAULT NULL::uuid, p_cost_center_id uuid DEFAULT NULL::uuid, p_conversion_snapshot_reference text DEFAULT NULL::text, p_finance_workflow_policy_version_id uuid DEFAULT NULL::uuid, p_operational_version integer DEFAULT NULL::integer)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  v_source abos.posting_sources%ROWTYPE;
  v_line abos.posting_kernel_line;
  v_line_ids uuid[] := ARRAY[]::uuid[];
  v_index integer := 0;
BEGIN
  IF current_user <> 'abos_v1_operational_finance_owner' THEN
    RAISE EXCEPTION 'the posting kernel is internal' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO v_source FROM abos.posting_sources WHERE source_type = p_source_type;
  IF NOT FOUND OR v_source.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'posting source % is not active', p_source_type USING ERRCODE = 'check_violation';
  END IF;
  IF p_initial_status IS NULL OR p_initial_status NOT IN ('VALIDATED', 'APPROVED')
     OR p_original_amount IS NULL OR p_original_amount <= 0
     OR p_base_amount IS NULL OR p_base_amount <= 0
     OR p_lines IS NULL OR pg_catalog.cardinality(p_lines) <> v_source.line_count THEN
    RAISE EXCEPTION 'a posting needs positive amounts, a pre-posting status and exactly % lines', v_source.line_count
      USING ERRCODE = 'check_violation';
  END IF;
  FOREACH v_line IN ARRAY p_lines LOOP
    v_index := v_index + 1;
    IF v_line.line_number IS DISTINCT FROM v_index
       OR COALESCE(v_line.side NOT IN ('DEBIT', 'CREDIT'), true)
       OR v_line.ledger_account_id IS NULL
       OR (v_line.subledger_type IS NULL) <> (v_line.subledger_sign IS NULL)
       OR COALESCE(v_line.subledger_sign NOT IN (1, -1), false) THEN
      RAISE EXCEPTION 'posting line % is malformed', v_index USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;

  INSERT INTO abos.posting_intents
    (id, legal_entity_id, project_id, department_id, cost_center_id,
     source_type, source_id, intent_kind, original_amount, original_currency_code,
     base_amount, base_currency_code, conversion_snapshot_reference,
     accounting_effective_date, correlation_id, idempotency_key, status,
     created_by_user_account_id, processing_model,
     operational_expense_id, direct_capital_receipt_id, treasury_opening_balance_id,
     treasury_receipt_id, treasury_transfer_id, treasury_payment_id, loan_id, loan_repayment_id,
     finance_workflow_policy_version_id, operational_version)
  VALUES
    (p_intent_id, p_legal_entity_id, p_project_id, p_department_id, p_cost_center_id,
     p_source_type, p_source_id, v_source.intent_kind, p_original_amount, p_original_currency_code,
     p_base_amount, p_base_currency_code, p_conversion_snapshot_reference,
     p_accounting_effective_date, p_correlation_id, p_idempotency_key, p_initial_status,
     p_created_by_user_account_id, 'OPERATIONAL_V1',
     CASE p_source_type WHEN 'OPERATIONAL_EXPENSE' THEN p_source_id END,
     CASE p_source_type WHEN 'DIRECT_SHAREHOLDER_CAPITAL' THEN p_source_id END,
     CASE p_source_type WHEN 'OPENING_BALANCE' THEN p_source_id END,
     CASE p_source_type WHEN 'CASH_RECEIPT' THEN p_source_id END,
     CASE p_source_type WHEN 'TREASURY_TRANSFER' THEN p_source_id END,
     CASE p_source_type WHEN 'PAYMENT' THEN p_source_id END,
     CASE p_source_type WHEN 'LOAN_RECEIPT' THEN p_source_id END,
     CASE p_source_type WHEN 'LOAN_REPAYMENT' THEN p_source_id END,
     p_finance_workflow_policy_version_id, p_operational_version);
  INSERT INTO abos.journals
    (id, legal_entity_id, accounting_period_id, posting_intent_id, journal_reference,
     accounting_effective_date, base_currency_code, status,
     created_by_user_account_id, processing_model)
  VALUES
    (p_journal_id, p_legal_entity_id, p_accounting_period_id, p_intent_id, p_journal_reference,
     p_accounting_effective_date, p_base_currency_code, 'DRAFT',
     p_created_by_user_account_id, 'OPERATIONAL_V1');

  FOREACH v_line IN ARRAY p_lines LOOP
    v_line_ids := v_line_ids || pg_catalog.gen_random_uuid();
    INSERT INTO abos.journal_lines
      (id, journal_id, legal_entity_id, line_number, ledger_account_id,
       business_party_id, project_id, department_id, cost_center_id,
       original_amount, original_currency_code, base_debit, base_credit,
       base_currency_code, conversion_snapshot_reference, source_type, source_id,
       processing_model)
    VALUES
      (v_line_ids[v_line.line_number], p_journal_id, p_legal_entity_id, v_line.line_number,
       v_line.ledger_account_id, v_line.business_party_id, v_line.project_id,
       v_line.department_id, v_line.cost_center_id, p_original_amount, p_original_currency_code,
       CASE v_line.side WHEN 'DEBIT' THEN p_base_amount ELSE 0 END,
       CASE v_line.side WHEN 'CREDIT' THEN p_base_amount ELSE 0 END,
       p_base_currency_code, p_conversion_snapshot_reference, p_source_type, p_source_id,
       'OPERATIONAL_V1');
  END LOOP;
  FOREACH v_line IN ARRAY p_lines LOOP
    CONTINUE WHEN v_line.subledger_type IS NULL;
    INSERT INTO abos.subledger_entries
      (id, legal_entity_id, journal_line_id, subledger_type, operational_treasury_account_id,
       business_party_id, original_amount, original_currency_code, base_amount, base_currency_code,
       source_type, source_id, processing_model, direct_capital_receipt_id)
    VALUES
      (pg_catalog.gen_random_uuid(), p_legal_entity_id, v_line_ids[v_line.line_number],
       v_line.subledger_type, v_line.operational_treasury_account_id,
       v_line.subledger_business_party_id,
       CASE v_line.subledger_sign WHEN -1 THEN -p_original_amount ELSE p_original_amount END,
       p_original_currency_code,
       CASE v_line.subledger_sign WHEN -1 THEN -p_base_amount ELSE p_base_amount END,
       p_base_currency_code, p_source_type, p_source_id, 'OPERATIONAL_V1',
       CASE p_source_type WHEN 'DIRECT_SHAREHOLDER_CAPITAL' THEN p_source_id END);
  END LOOP;
END
$function$;

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
    WHEN 'LOAN_RECEIPT' THEN PERFORM abos.validate_loan_receipt_journal(NEW, v_intent);
    WHEN 'LOAN_REPAYMENT' THEN PERFORM abos.validate_loan_repayment_journal(NEW, v_intent);
    ELSE
      RAISE EXCEPTION 'operational posting source % has no validator', v_source.source_type
        USING ERRCODE = 'check_violation';
  END CASE;
  -- 0049: a Safe, cash box or petty-cash account never goes below zero, whichever lane posts.
  PERFORM abos.treasury_require_funds(NEW);
  RETURN NEW;
END
$function$;

-- ---------------------------------------------------------------------------------------------
-- 8. Privileges. Runtime roles get no table access. They reach loans only through the entry points.
-- ---------------------------------------------------------------------------------------------
REVOKE ALL ON TABLE abos.loans, abos.loan_repayments FROM PUBLIC;
GRANT SELECT ON abos.loans, abos.loan_repayments TO abos_v1_operational_finance_owner;
GRANT INSERT (id, legal_entity_id, lender_business_party_id, lender_type, shareholder_profile_id, liability_ledger_account_id, operational_treasury_account_id,
    original_amount, original_currency_code, base_amount, base_currency_code, fx_conversion_id, business_date, reference, note, transaction_reference, status,
    workflow_policy_version_id, created_by_user_account_id, correlation_id, idempotency_key),
  UPDATE (status, decision_reason, decided_by_user_account_id, decided_at, journal_id) ON abos.loans TO abos_v1_operational_finance_owner;
GRANT INSERT (id, legal_entity_id, loan_id, operational_treasury_account_id, original_amount, original_currency_code, base_amount, base_currency_code, fx_conversion_id,
    business_date, reference, note, transaction_reference, status, workflow_policy_version_id, created_by_user_account_id, correlation_id, idempotency_key),
  UPDATE (status, decision_reason, decided_by_user_account_id, decided_at, journal_id) ON abos.loan_repayments TO abos_v1_operational_finance_owner;
GRANT SELECT (loan_id, loan_repayment_id), INSERT (loan_id, loan_repayment_id) ON abos.posting_intents TO abos_v1_operational_finance_owner;
GRANT SELECT (compatibility_only) ON abos.posting_sources TO abos_v1_operational_finance_owner;
GRANT INSERT (id, legal_entity_id, display_name, status) ON abos.business_parties TO abos_v1_operational_finance_owner;
GRANT SELECT, INSERT (business_party_id, role_code, effective_from) ON abos.business_party_roles TO abos_v1_operational_finance_owner;

REVOKE ALL ON FUNCTION abos.guard_loan_record(), abos.guard_loan_reversal_link(), abos.loan_journals(uuid), abos.loan_position(uuid, date),
  abos.validate_loan_receipt_journal(abos.journals, abos.posting_intents), abos.validate_loan_repayment_journal(abos.journals, abos.posting_intents),
  abos.loan_policy(uuid), abos.loan_liability_account(uuid, text, uuid, text), abos.loan_post(uuid, uuid, boolean), abos.loan_repayment_post(uuid, uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION abos.guard_loan_record(), abos.guard_loan_reversal_link(), abos.loan_journals(uuid), abos.loan_position(uuid, date),
  abos.validate_loan_receipt_journal(abos.journals, abos.posting_intents), abos.validate_loan_repayment_journal(abos.journals, abos.posting_intents),
  abos.loan_policy(uuid), abos.loan_liability_account(uuid, text, uuid, text), abos.loan_post(uuid, uuid, boolean), abos.loan_repayment_post(uuid, uuid, boolean)
  TO abos_v1_operational_finance_owner;

ALTER FUNCTION abos.finance_loan_record(text, text, text, jsonb) OWNER TO abos_v1_operational_finance_owner;
ALTER FUNCTION abos.finance_loan_repay(text, text, text, jsonb) OWNER TO abos_v1_operational_finance_owner;
ALTER FUNCTION abos.finance_loan_decide(text, text, text, jsonb) OWNER TO abos_v1_operational_finance_owner;
REVOKE ALL ON FUNCTION abos.finance_loan_record(text, text, text, jsonb), abos.finance_loan_repay(text, text, text, jsonb), abos.finance_loan_decide(text, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION abos.finance_loan_record(text, text, text, jsonb), abos.finance_loan_repay(text, text, text, jsonb), abos.finance_loan_decide(text, text, text, jsonb) TO abos_e1_runtime;
