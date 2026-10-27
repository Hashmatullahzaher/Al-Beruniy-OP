-- Slice 2, part 1: the posting kernel and the source registry (validation). Additive for data; it
-- replaces three journal validators that each re-implemented the shared accounting invariants and
-- early-returned for one another's sources.
--
-- Before: every OPERATIONAL_V1 journal passed four BEFORE triggers on abos.journals
-- (expense, direct capital, temporary funding, and the 0036 bridge). Draft-before-post and
-- posted-immutability for every operational journal lived inside the expense validator.
-- After: one kernel trigger enforces those and the shared invariants once, reads the source's rules
-- from abos.posting_sources, and dispatches with a static CASE to one small validator per source.
-- The 0036 bridge keeps its own validator (registered FROZEN); E1 is untouched.
--
-- Writers are not changed here, so every posted row is produced exactly as before (part 2, 0044,
-- moves the writers onto the kernel with an equivalence proof). No row of any existing table changes.

-- ---------------------------------------------------------------------------------------------
-- 1. Registry.
-- ---------------------------------------------------------------------------------------------

CREATE TABLE abos.posting_sources (
  source_type text PRIMARY KEY CHECK (source_type ~ '^[A-Z][A-Z_]+[A-Z]$'),
  source_kind text NOT NULL UNIQUE CHECK (source_kind ~ '^[A-Z][A-Z_]+[A-Z]$'),
  intent_kind text,
  workflow_type text,
  status text NOT NULL CHECK (status IN ('ACTIVE', 'FROZEN', 'PLANNED')),
  line_count integer CHECK (line_count IS NULL OR line_count >= 2),
  debit_rules jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(debit_rules) = 'array'),
  credit_rules jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(credit_rules) = 'array'),
  subledger_rules jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(subledger_rules) = 'array'),
  reversible boolean NOT NULL,
  validator text CHECK (validator IS NULL OR validator ~ '^validate_[a-z_]+_journal$'),
  description text NOT NULL CHECK (length(btrim(description)) BETWEEN 10 AND 500),
  CHECK (status <> 'ACTIVE' OR (intent_kind IS NOT NULL AND line_count IS NOT NULL AND validator IS NOT NULL
         AND jsonb_array_length(debit_rules) > 0 AND jsonb_array_length(credit_rules) > 0))
);

COMMENT ON TABLE abos.posting_sources IS
  'Every operational posting source: its accounts per side, subledgers, line count, reversibility and validator. ACTIVE sources are validated by the kernel and dispatched to their validator; FROZEN sources keep their own lane; PLANNED sources are refused. Changed only by migrations.';

CREATE TRIGGER posting_sources_no_update_or_delete
BEFORE UPDATE OR DELETE ON abos.posting_sources
FOR EACH ROW EXECUTE FUNCTION abos.prevent_audit_mutation();

INSERT INTO abos.posting_sources
  (source_type, source_kind, intent_kind, workflow_type, status, line_count,
   debit_rules, credit_rules, subledger_rules, reversible, validator, description)
VALUES
  ('OPERATIONAL_EXPENSE', 'EXPENSE', 'EXPENSE', 'EXPENSE', 'ACTIVE', 2,
   '[{"accountType":"EXPENSE"}]',
   '[{"accountType":"ASSET","control":"CASH"},{"accountType":"ASSET","control":"SARAF"}]',
   '[{"type":"OPERATIONAL_TREASURY","side":"CREDIT","required":true}]',
   true, 'validate_expense_journal',
   'Money paid out of a Safe, bank or Saraf account for an expense category (0028).'),
  ('DIRECT_SHAREHOLDER_CAPITAL', 'DIRECT_SHAREHOLDER_CAPITAL', 'DIRECT_SHAREHOLDER_CAPITAL', 'SHAREHOLDER_CAPITAL_RECEIPT', 'ACTIVE', 2,
   '[{"accountType":"ASSET","control":"CASH"},{"accountType":"ASSET","control":"SHAREHOLDER_CONTRIBUTED_ASSETS"},{"accountType":"EXPENSE","control":null}]',
   '[{"accountType":"EQUITY","control":"SHAREHOLDER_CAPITAL"}]',
   '[{"type":"OPERATIONAL_TREASURY","side":"DEBIT","required":false},{"type":"SHAREHOLDER_CAPITAL","side":"CREDIT","required":true}]',
   false, 'validate_direct_shareholder_capital_journal',
   'Shareholder capital in one save: cash or hawala into a Safe, a contributed asset, or a bill paid directly (0040).'),
  ('TEMPORARY_FUNDING', 'TEMPORARY_FUNDING', 'TEMPORARY_FUNDING', 'TEMPORARY_FUNDING', 'ACTIVE', 2,
   '[{"accountType":"ASSET","control":"CASH"},{"accountType":"EXPENSE"}]',
   '[{"accountType":"LIABILITY","control":"TEMPORARY_FUNDING_PAYABLE"}]',
   '[{"type":"OPERATIONAL_TREASURY","side":"DEBIT","required":false},{"type":"TEMPORARY_FUNDING_PAYABLE","side":"CREDIT","required":true}]',
   false, 'validate_temporary_funding_journal',
   'Money a provider put into a Safe or paid directly as an expense, owed back to the provider (0037).'),
  ('TEMPORARY_FUNDING_SETTLEMENT', 'TEMPORARY_FUNDING_SETTLEMENT', 'TEMPORARY_FUNDING_SETTLEMENT', 'TEMPORARY_FUNDING', 'ACTIVE', 2,
   '[{"accountType":"LIABILITY","control":"TEMPORARY_FUNDING_PAYABLE"}]',
   '[{"accountType":"ASSET","control":"CASH"}]',
   '[{"type":"TEMPORARY_FUNDING_PAYABLE","side":"DEBIT","required":true},{"type":"OPERATIONAL_TREASURY","side":"CREDIT","required":true}]',
   false, 'validate_temporary_funding_settlement_journal',
   'Repayment of temporary funding from a Treasury account (0037).'),
  ('SHAREHOLDER_CAPITAL_CONTRIBUTION_RECEIPT', 'SHAREHOLDER_CAPITAL_BRIDGE', 'SHAREHOLDER_CAPITAL_RECEIPT', 'SHAREHOLDER_CAPITAL_RECEIPT', 'FROZEN', NULL,
   '[]', '[]', '[]', false, NULL,
   'The 0036 shareholder-capital bridge: validated by its own lane (validate_operational_capital_journal_posting); not repointed.'),
  ('CASH_RECEIPT', 'CASH_RECEIPT', NULL, NULL, 'PLANNED', NULL, '[]', '[]', '[]', true, NULL, 'Money received into a Safe or Saraf from a counterparty (Slice 4).'),
  ('PAYMENT', 'PAYMENT', NULL, NULL, 'PLANNED', NULL, '[]', '[]', '[]', true, NULL, 'Money paid out to a supplier, contractor, employee or other payee (Slice 4).'),
  ('TREASURY_TRANSFER', 'TREASURY_TRANSFER', NULL, NULL, 'PLANNED', NULL, '[]', '[]', '[]', true, NULL, 'Money moved between Safes and Saraf accounts (Slice 4).'),
  ('COUNT_DIFFERENCE', 'COUNT_DIFFERENCE', NULL, NULL, 'PLANNED', NULL, '[]', '[]', '[]', true, NULL, 'Difference found when a Safe is counted (Slice 3).'),
  ('OPENING_BALANCE', 'OPENING_BALANCE', NULL, NULL, 'PLANNED', NULL, '[]', '[]', '[]', true, NULL, 'Opening balance of a Safe or account at the business start (Slice 3).'),
  ('REVERSAL', 'REVERSAL', NULL, NULL, 'PLANNED', NULL, '[]', '[]', '[]', false, NULL, 'Exact inversion of a posted journal, linked to it (Slice 5).');

GRANT SELECT ON abos.posting_sources TO abos_v1_operational_finance_owner;

-- ---------------------------------------------------------------------------------------------
-- 2. Source validators: only the facts of their own source. Extracted from the 0028/0037/0040
--    validators; the shared invariants they repeated now live in the kernel below.
-- ---------------------------------------------------------------------------------------------

CREATE FUNCTION abos.validate_expense_journal(p_journal abos.journals, p_intent abos.posting_intents)
RETURNS void LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $validate$
DECLARE
  expense_row abos.operational_expenses%ROWTYPE;
  treasury_row abos.operational_treasury_accounts%ROWTYPE;
  category_row abos.operational_expense_categories%ROWTYPE;
  policy_row abos.finance_workflow_policy_versions%ROWTYPE;
  snapshot_row abos.exchange_rate_snapshots%ROWTYPE;
  approval_count bigint;
  treasury_subledger_count bigint;
BEGIN
  IF p_intent.intent_kind <> 'EXPENSE' OR p_intent.base_amount IS NULL THEN
    RAISE EXCEPTION 'operational posting requires a posted valued EXPENSE intent'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO expense_row FROM abos.operational_expenses
   WHERE id = p_intent.operational_expense_id AND legal_entity_id = p_journal.legal_entity_id;
  IF NOT FOUND OR expense_row.id IS DISTINCT FROM p_intent.source_id
     OR expense_row.status <> 'POSTED' OR expense_row.journal_id IS DISTINCT FROM p_journal.id
     OR expense_row.original_amount IS DISTINCT FROM p_intent.original_amount
     OR expense_row.original_currency_code IS DISTINCT FROM p_intent.original_currency_code
     OR expense_row.base_amount IS DISTINCT FROM p_intent.base_amount
     OR expense_row.base_currency_code IS DISTINCT FROM p_intent.base_currency_code
     OR expense_row.business_date IS DISTINCT FROM p_journal.accounting_effective_date THEN
    RAISE EXCEPTION 'operational expense, intent and journal do not agree'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO policy_row FROM abos.finance_workflow_policy_versions
   WHERE id = expense_row.workflow_policy_version_id
     AND legal_entity_id = p_journal.legal_entity_id AND workflow_type = 'EXPENSE';
  IF NOT FOUND OR policy_row.approval_required IS DISTINCT FROM expense_row.approval_required THEN
    RAISE EXCEPTION 'operational expense approval route does not match its immutable policy snapshot'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*) INTO approval_count FROM abos.operational_expense_approvals approval
   WHERE approval.operational_expense_id = expense_row.id
     AND approval.legal_entity_id = p_journal.legal_entity_id
     AND approval.decision = 'APPROVED'
     AND approval.approver_user_account_id = p_journal.posted_by_user_account_id;
  IF expense_row.approval_required THEN
    IF approval_count <> 1
       OR p_journal.posted_by_user_account_id = expense_row.created_by_user_account_id THEN
      RAISE EXCEPTION 'approval-required expense must be posted by its independent approver'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF approval_count <> 0
        OR p_journal.posted_by_user_account_id IS DISTINCT FROM expense_row.created_by_user_account_id THEN
    RAISE EXCEPTION 'direct-posting expense must have no approval and be posted by its creator'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO treasury_row FROM abos.operational_treasury_accounts
   WHERE id = expense_row.operational_treasury_account_id
     AND legal_entity_id = p_journal.legal_entity_id AND status = 'ACTIVE';
  SELECT * INTO category_row FROM abos.operational_expense_categories
   WHERE id = expense_row.operational_expense_category_id
     AND legal_entity_id = p_journal.legal_entity_id AND status = 'ACTIVE';
  IF treasury_row.id IS NULL OR category_row.id IS NULL
     OR treasury_row.currency_code <> expense_row.original_currency_code THEN
    RAISE EXCEPTION 'expense requires active same-entity Treasury and category mappings'
      USING ERRCODE = 'check_violation';
  END IF;

  IF expense_row.original_currency_code = expense_row.base_currency_code THEN
    IF expense_row.exchange_rate_snapshot_id IS NOT NULL
       OR expense_row.base_amount <> expense_row.original_amount THEN
      RAISE EXCEPTION 'base-currency expense must retain the same amount without an FX snapshot'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    SELECT * INTO snapshot_row FROM abos.exchange_rate_snapshots
     WHERE id = expense_row.exchange_rate_snapshot_id
       AND legal_entity_id = p_journal.legal_entity_id
       AND source_type = 'OPERATIONAL_EXPENSE' AND source_id = expense_row.id;
    IF NOT FOUND OR snapshot_row.transaction_currency_code <> expense_row.original_currency_code
       OR snapshot_row.base_currency_code <> expense_row.base_currency_code
       OR snapshot_row.rate_date <> expense_row.business_date
       OR p_intent.conversion_snapshot_reference IS DISTINCT FROM snapshot_row.id::text THEN
      RAISE EXCEPTION 'foreign-currency expense requires its exact immutable rate snapshot'
        USING ERRCODE = 'check_violation';
    END IF;
    IF snapshot_row.unit_currency_code = expense_row.original_currency_code
       AND snapshot_row.quote_currency_code = expense_row.base_currency_code THEN
      IF expense_row.base_amount <> expense_row.original_amount * snapshot_row.rate_value THEN
        RAISE EXCEPTION 'expense base amount does not exactly follow its direct rate'
          USING ERRCODE = 'check_violation';
      END IF;
    ELSIF snapshot_row.quote_currency_code = expense_row.original_currency_code
       AND snapshot_row.unit_currency_code = expense_row.base_currency_code THEN
      IF expense_row.base_amount * snapshot_row.rate_value <> expense_row.original_amount THEN
        RAISE EXCEPTION 'inverse rate requires an exact result; rounding policy is not approved'
          USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      RAISE EXCEPTION 'snapshot currency direction does not match the expense'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM abos.journal_lines line
              WHERE line.journal_id = p_journal.id AND line.original_amount <> expense_row.original_amount) THEN
    RAISE EXCEPTION 'operational journal line violates entity, currency, account or dimension rules'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM abos.journal_lines line WHERE line.journal_id = p_journal.id
      AND line.line_number = 1 AND line.ledger_account_id = category_row.ledger_account_id
      AND line.base_debit = expense_row.base_amount AND line.base_credit = 0
      AND line.project_id IS NOT DISTINCT FROM expense_row.project_id
      AND line.department_id IS NOT DISTINCT FROM expense_row.department_id
      AND line.cost_center_id IS NOT DISTINCT FROM expense_row.cost_center_id
      AND line.business_party_id IS NOT DISTINCT FROM expense_row.payee_business_party_id
  ) OR NOT EXISTS (
    SELECT 1 FROM abos.journal_lines line WHERE line.journal_id = p_journal.id
      AND line.line_number = 2 AND line.ledger_account_id = treasury_row.ledger_account_id
      AND line.base_debit = 0 AND line.base_credit = expense_row.base_amount
      AND line.project_id IS NOT DISTINCT FROM expense_row.project_id
      AND line.department_id IS NOT DISTINCT FROM expense_row.department_id
      AND line.cost_center_id IS NOT DISTINCT FROM expense_row.cost_center_id
      AND line.business_party_id IS NULL
  ) THEN
    RAISE EXCEPTION 'expense journal must debit its category and credit its Treasury mapping'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*) INTO treasury_subledger_count
    FROM abos.subledger_entries entry
    JOIN abos.journal_lines line ON line.id = entry.journal_line_id
   WHERE line.journal_id = p_journal.id
     AND entry.subledger_type = 'OPERATIONAL_TREASURY'
     AND entry.operational_treasury_account_id = treasury_row.id
     AND entry.original_amount = -expense_row.original_amount
     AND entry.base_amount = -expense_row.base_amount;
  IF treasury_subledger_count <> 1 OR EXISTS (
    SELECT 1 FROM abos.subledger_entries entry
    JOIN abos.journal_lines line ON line.id = entry.journal_line_id
    WHERE line.journal_id = p_journal.id AND (entry.subledger_type <> 'OPERATIONAL_TREASURY' OR line.line_number <> 2)
  ) THEN
    RAISE EXCEPTION 'expense journal requires exactly one matching Treasury subledger movement'
      USING ERRCODE = 'check_violation';
  END IF;
END
$validate$;

CREATE FUNCTION abos.validate_direct_shareholder_capital_journal(p_journal abos.journals, p_intent abos.posting_intents)
RETURNS void LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $validate$
DECLARE r abos.direct_capital_receipts%ROWTYPE; a abos.operational_treasury_accounts%ROWTYPE; party uuid;
 cash_bearing boolean; debit_account_valid boolean;
BEGIN
 SELECT * INTO r FROM abos.direct_capital_receipts WHERE id=p_intent.direct_capital_receipt_id AND legal_entity_id=p_journal.legal_entity_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'direct capital source missing' USING ERRCODE='check_violation'; END IF;
 cash_bearing:=r.funding_method IN('CASH','HAWALA');
 SELECT * INTO a FROM abos.operational_treasury_accounts WHERE id=r.operational_treasury_account_id AND legal_entity_id=r.legal_entity_id;
 -- The debit account must independently satisfy the rule of the method that chose it.
 debit_account_valid:=CASE
  WHEN cash_bearing THEN a.id IS NOT NULL AND r.debit_ledger_account_id=a.ledger_account_id
   AND abos.temporary_funding_treasury_ledger(r.legal_entity_id,a.id,r.original_currency_code,true)=a.ledger_account_id
   AND NOT EXISTS(SELECT 1 FROM abos.ledger_accounts WHERE id=a.ledger_account_id
    AND account_currency_code IS NOT NULL AND account_currency_code<>r.original_currency_code)
  WHEN r.funding_method='ASSET' THEN EXISTS(SELECT 1 FROM abos.ledger_accounts x
   WHERE x.id=r.debit_ledger_account_id AND x.legal_entity_id=r.legal_entity_id AND x.status='ACTIVE'
    AND x.posting_allowed AND x.account_type='ASSET' AND x.control_account_type='SHAREHOLDER_CONTRIBUTED_ASSETS'
    AND(x.account_currency_code IS NULL OR x.account_currency_code=r.original_currency_code)
    AND NOT x.requires_project AND NOT x.requires_department AND NOT x.requires_cost_center)
  ELSE EXISTS(SELECT 1 FROM abos.ledger_accounts x
   WHERE x.id=r.debit_ledger_account_id AND x.legal_entity_id=r.legal_entity_id AND x.status='ACTIVE'
    AND x.posting_allowed AND x.account_type='EXPENSE' AND x.control_account_type IS NULL
    AND(x.account_currency_code IS NULL OR x.account_currency_code=r.original_currency_code)
    AND NOT x.requires_project AND NOT x.requires_department AND NOT x.requires_cost_center) END;
 SELECT business_party_id INTO party FROM abos.shareholder_profiles WHERE id=r.shareholder_profile_id AND legal_entity_id=r.legal_entity_id AND status='ACTIVE';
 IF p_intent.operational_version<>2
  OR p_intent.intent_kind<>'DIRECT_SHAREHOLDER_CAPITAL' OR p_intent.source_id IS DISTINCT FROM r.id
  OR r.journal_id IS DISTINCT FROM p_journal.id OR p_journal.journal_reference IS DISTINCT FROM r.transaction_reference
  OR p_intent.created_by_user_account_id IS DISTINCT FROM r.created_by_user_account_id
  OR p_journal.created_by_user_account_id IS DISTINCT FROM r.created_by_user_account_id
  OR p_journal.posted_by_user_account_id IS DISTINCT FROM r.created_by_user_account_id OR p_journal.posted_at IS NULL
  OR p_intent.original_amount IS DISTINCT FROM r.original_amount OR p_intent.base_amount IS DISTINCT FROM r.original_amount
  OR p_intent.original_currency_code IS DISTINCT FROM r.original_currency_code OR p_intent.base_currency_code IS DISTINCT FROM r.original_currency_code
  OR p_journal.accounting_effective_date IS DISTINCT FROM r.receipt_date
  OR p_intent.finance_workflow_policy_version_id IS DISTINCT FROM r.workflow_policy_version_id
  OR NOT debit_account_valid OR (NOT cash_bearing AND r.operational_treasury_account_id IS NOT NULL)
  OR r.debit_ledger_account_id=r.paid_in_capital_ledger_account_id
  OR party IS NULL
  OR EXISTS(SELECT 1 FROM abos.posting_approvals WHERE posting_intent_id=p_intent.id)
  OR NOT EXISTS(SELECT 1 FROM abos.finance_workflow_policy_versions WHERE id=r.workflow_policy_version_id
   AND legal_entity_id=r.legal_entity_id AND workflow_type='SHAREHOLDER_CAPITAL_RECEIPT' AND NOT approval_required)
  OR NOT EXISTS(SELECT 1 FROM abos.ledger_accounts e WHERE e.id=r.paid_in_capital_ledger_account_id AND e.legal_entity_id=r.legal_entity_id
   AND e.status='ACTIVE' AND e.posting_allowed AND e.account_type='EQUITY' AND e.control_account_type='SHAREHOLDER_CAPITAL'
   AND(e.account_currency_code IS NULL OR e.account_currency_code=r.original_currency_code)
   AND NOT e.requires_project AND NOT e.requires_department AND NOT e.requires_cost_center) THEN
  RAISE EXCEPTION 'direct capital journal does not match its source, policy, account, poster or period' USING ERRCODE='check_violation';
 END IF;
 IF EXISTS(SELECT 1 FROM abos.journal_lines l WHERE l.journal_id=p_journal.id AND (
  l.project_id IS NOT NULL OR l.department_id IS NOT NULL OR l.cost_center_id IS NOT NULL
  OR l.original_amount IS DISTINCT FROM r.original_amount
  OR NOT((l.line_number=1 AND l.ledger_account_id=r.debit_ledger_account_id AND l.business_party_id IS NULL
   AND l.base_debit=r.original_amount AND l.base_credit=0)
   OR(l.line_number=2 AND l.ledger_account_id=r.paid_in_capital_ledger_account_id AND l.business_party_id IS NOT DISTINCT FROM party
   AND l.base_debit=0 AND l.base_credit=r.original_amount)))) THEN
  RAISE EXCEPTION 'direct capital requires its exact method debit and shareholder equity credit' USING ERRCODE='check_violation'; END IF;
 IF (SELECT count(*) FROM abos.subledger_entries s JOIN abos.journal_lines l ON l.id=s.journal_line_id WHERE l.journal_id=p_journal.id)
   <>(CASE WHEN cash_bearing THEN 2 ELSE 1 END)
  OR EXISTS(SELECT 1 FROM abos.subledger_entries s JOIN abos.journal_lines l ON l.id=s.journal_line_id WHERE l.journal_id=p_journal.id AND(
   s.direct_capital_receipt_id IS DISTINCT FROM r.id
   OR s.original_amount IS DISTINCT FROM CASE WHEN l.line_number=1 THEN r.original_amount ELSE -r.original_amount END
   OR s.base_amount IS DISTINCT FROM CASE WHEN l.line_number=1 THEN r.original_amount ELSE -r.original_amount END
   OR NOT((l.line_number=1 AND cash_bearing AND s.subledger_type='OPERATIONAL_TREASURY' AND s.operational_treasury_account_id=a.id AND s.business_party_id IS NULL)
    OR(l.line_number=2 AND s.subledger_type='SHAREHOLDER_CAPITAL' AND s.business_party_id=party AND s.operational_treasury_account_id IS NULL)))) THEN
  RAISE EXCEPTION 'direct capital requires its exact method and shareholder subledgers' USING ERRCODE='check_violation'; END IF;
 IF (SELECT COALESCE(sum(amount),0) FROM abos.direct_capital_receipt_allocations WHERE receipt_id=r.id)>r.original_amount
  OR EXISTS(SELECT 1 FROM abos.direct_capital_receipt_allocations x JOIN abos.shareholder_contributions c ON c.id=x.contribution_id
   WHERE x.receipt_id=r.id AND(c.legal_entity_id IS DISTINCT FROM r.legal_entity_id OR c.shareholder_profile_id IS DISTINCT FROM r.shareholder_profile_id
    OR c.contribution_type<>'CASH' OR c.record_status<>'DECLARED' OR c.currency_code<>r.original_currency_code OR c.business_date>r.receipt_date
    OR c.amount<COALESCE((SELECT sum(amount) FROM abos.direct_capital_receipt_allocations z WHERE z.contribution_id=c.id),0)
      +COALESCE((SELECT sum(original_amount) FROM abos.shareholder_capital_receipts z WHERE z.contribution_id=c.id AND record_state='RECORDED'),0))) THEN
  RAISE EXCEPTION 'direct capital allocations exceed or mismatch declared capital' USING ERRCODE='check_violation'; END IF;
END $validate$;

CREATE FUNCTION abos.validate_temporary_funding_journal(p_journal abos.journals, p_intent abos.posting_intents)
RETURNS void LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $validate$
DECLARE
  v_funding abos.temporary_fundings%ROWTYPE;
  v_mapping record; v_policy record;
  v_debit_ledger uuid; v_debit_party uuid; v_amount numeric; v_subledger_count bigint;
BEGIN
  IF p_intent.intent_kind <> 'TEMPORARY_FUNDING' OR p_intent.original_currency_code <> p_intent.base_currency_code
     OR p_intent.original_amount <> p_intent.base_amount THEN
    RAISE EXCEPTION 'temporary funding posting requires its posted base-currency intent'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT policy.id, policy.approval_required INTO v_policy FROM abos.finance_workflow_policy_versions policy
   WHERE policy.id = p_intent.finance_workflow_policy_version_id AND policy.legal_entity_id = p_journal.legal_entity_id
     AND policy.workflow_type = 'TEMPORARY_FUNDING';
  SELECT mapping.id, mapping.payable_ledger_account_id, ledger.status, ledger.posting_allowed,
         ledger.account_type, ledger.control_account_type
    INTO v_mapping
    FROM abos.temporary_funding_account_mapping_versions mapping
    JOIN abos.ledger_accounts ledger
      ON ledger.id = mapping.payable_ledger_account_id AND ledger.legal_entity_id = mapping.legal_entity_id
   WHERE mapping.id = p_intent.temporary_funding_mapping_version_id AND mapping.legal_entity_id = p_journal.legal_entity_id;
  IF v_policy.id IS NULL OR v_policy.approval_required IS NOT TRUE
     OR v_mapping.id IS NULL OR v_mapping.status <> 'ACTIVE' OR NOT v_mapping.posting_allowed
     OR v_mapping.account_type <> 'LIABILITY' OR v_mapping.control_account_type <> 'TEMPORARY_FUNDING_PAYABLE' THEN
    RAISE EXCEPTION 'temporary funding posting requires its approval-required policy and controlled payable mapping'
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM abos.journal_lines line
              WHERE line.journal_id = p_journal.id AND line.original_amount <> p_intent.original_amount) THEN
    RAISE EXCEPTION 'temporary funding journal line violates source, currency, account or dimension rules'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_funding FROM abos.temporary_fundings
   WHERE id = p_intent.temporary_funding_id AND legal_entity_id = p_journal.legal_entity_id;
  IF NOT FOUND OR v_funding.status <> 'POSTED' OR v_funding.journal_id IS DISTINCT FROM p_journal.id
     OR v_funding.base_amount <> p_intent.base_amount OR v_funding.business_date <> p_journal.accounting_effective_date
     OR v_funding.workflow_policy_version_id <> v_policy.id OR v_funding.mapping_version_id <> v_mapping.id THEN
    RAISE EXCEPTION 'temporary funding, intent and journal do not agree' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM abos.temporary_funding_decisions decision
                  WHERE decision.temporary_funding_id = v_funding.id AND decision.decision = 'APPROVED'
                    AND decision.decided_by_user_account_id = p_journal.posted_by_user_account_id)
     OR p_journal.posted_by_user_account_id = v_funding.created_by_user_account_id
     OR p_journal.posted_by_user_account_id IS NOT DISTINCT FROM v_funding.provider_user_account_id THEN
    RAISE EXCEPTION 'temporary funding must be posted by its independent approver'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  v_amount := v_funding.base_amount;
  IF v_funding.funding_mode = 'PROVIDER_PAID_EXPENSE_DIRECTLY' THEN
    SELECT category.ledger_account_id INTO v_debit_ledger FROM abos.operational_expense_categories category
      JOIN abos.ledger_accounts ledger ON ledger.id = category.ledger_account_id
       AND ledger.legal_entity_id = category.legal_entity_id AND ledger.account_type = 'EXPENSE'
     WHERE category.id = v_funding.operational_expense_category_id
       AND category.legal_entity_id = p_journal.legal_entity_id AND category.status = 'ACTIVE';
    v_debit_party := v_funding.payee_business_party_id;
  ELSE
    SELECT account.ledger_account_id INTO v_debit_ledger FROM abos.operational_treasury_accounts account
      JOIN abos.ledger_accounts ledger ON ledger.id = account.ledger_account_id
       AND ledger.legal_entity_id = account.legal_entity_id
     WHERE account.id = v_funding.operational_treasury_account_id AND account.legal_entity_id = p_journal.legal_entity_id
       AND account.status = 'ACTIVE' AND account.currency_code = p_journal.base_currency_code
       AND account.account_type IN ('SAFE', 'CASH_BOX', 'PETTY_CASH')
       AND ledger.account_type = 'ASSET' AND ledger.control_account_type = 'CASH'
       AND NOT ledger.requires_project AND NOT ledger.requires_department AND NOT ledger.requires_cost_center;
    v_debit_party := NULL;
  END IF;
  IF v_debit_ledger IS NULL OR NOT EXISTS (
       SELECT 1 FROM abos.journal_lines line WHERE line.journal_id = p_journal.id AND line.line_number = 1
          AND line.ledger_account_id = v_debit_ledger AND line.base_debit = v_amount AND line.base_credit = 0
          AND line.business_party_id IS NOT DISTINCT FROM v_debit_party
          AND line.project_id IS NOT DISTINCT FROM v_funding.project_id
          AND line.department_id IS NOT DISTINCT FROM v_funding.department_id
          AND line.cost_center_id IS NOT DISTINCT FROM v_funding.cost_center_id)
     OR NOT EXISTS (
       SELECT 1 FROM abos.journal_lines line WHERE line.journal_id = p_journal.id AND line.line_number = 2
          AND line.ledger_account_id = v_mapping.payable_ledger_account_id
          AND line.base_debit = 0 AND line.base_credit = v_amount
          AND line.business_party_id = v_funding.provider_business_party_id
          AND line.project_id IS NULL AND line.department_id IS NULL AND line.cost_center_id IS NULL) THEN
    RAISE EXCEPTION 'temporary funding journal must debit its expense or Safe and credit the provider payable'
      USING ERRCODE = 'check_violation';
  END IF;
  -- The provider payable on line 2 always; a Safe inflow on line 1 only when the provider funded the Safe.
  SELECT count(*) INTO v_subledger_count FROM abos.subledger_entries entry
    JOIN abos.journal_lines line ON line.id = entry.journal_line_id WHERE line.journal_id = p_journal.id;
  IF v_subledger_count <> (CASE WHEN v_funding.funding_mode = 'PROVIDER_FUNDED_SAFE' THEN 2 ELSE 1 END)
     OR EXISTS (
       SELECT 1 FROM abos.subledger_entries entry JOIN abos.journal_lines line ON line.id = entry.journal_line_id
        WHERE line.journal_id = p_journal.id AND NOT (
          (line.line_number = 2 AND entry.subledger_type = 'TEMPORARY_FUNDING_PAYABLE'
           AND entry.business_party_id = v_funding.provider_business_party_id
           AND entry.temporary_funding_id = v_funding.id AND entry.temporary_funding_settlement_id IS NULL
           AND entry.original_amount = v_amount AND entry.base_amount = v_amount)
          OR
          (v_funding.funding_mode = 'PROVIDER_FUNDED_SAFE' AND line.line_number = 1
           AND entry.subledger_type = 'OPERATIONAL_TREASURY'
           AND entry.operational_treasury_account_id = v_funding.operational_treasury_account_id
           AND entry.business_party_id IS NULL AND entry.temporary_funding_id IS NULL
           AND entry.original_amount = v_amount AND entry.base_amount = v_amount))) THEN
    RAISE EXCEPTION 'temporary funding journal requires exactly its provider payable and Safe movements'
      USING ERRCODE = 'check_violation';
  END IF;
END
$validate$;

CREATE FUNCTION abos.validate_temporary_funding_settlement_journal(p_journal abos.journals, p_intent abos.posting_intents)
RETURNS void LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $validate$
DECLARE
  v_funding abos.temporary_fundings%ROWTYPE;
  v_settlement abos.temporary_funding_settlements%ROWTYPE;
  v_mapping record; v_policy record; v_treasury record; v_settled numeric; v_subledger_count bigint;
BEGIN
  IF p_intent.intent_kind <> 'TEMPORARY_FUNDING_SETTLEMENT' OR p_intent.original_currency_code <> p_intent.base_currency_code
     OR p_intent.original_amount <> p_intent.base_amount THEN
    RAISE EXCEPTION 'temporary funding posting requires its posted base-currency intent'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT policy.id, policy.approval_required INTO v_policy FROM abos.finance_workflow_policy_versions policy
   WHERE policy.id = p_intent.finance_workflow_policy_version_id AND policy.legal_entity_id = p_journal.legal_entity_id
     AND policy.workflow_type = 'TEMPORARY_FUNDING';
  SELECT mapping.id, mapping.payable_ledger_account_id, ledger.status, ledger.posting_allowed,
         ledger.account_type, ledger.control_account_type
    INTO v_mapping
    FROM abos.temporary_funding_account_mapping_versions mapping
    JOIN abos.ledger_accounts ledger
      ON ledger.id = mapping.payable_ledger_account_id AND ledger.legal_entity_id = mapping.legal_entity_id
   WHERE mapping.id = p_intent.temporary_funding_mapping_version_id AND mapping.legal_entity_id = p_journal.legal_entity_id;
  IF v_policy.id IS NULL OR v_policy.approval_required IS NOT TRUE
     OR v_mapping.id IS NULL OR v_mapping.status <> 'ACTIVE' OR NOT v_mapping.posting_allowed
     OR v_mapping.account_type <> 'LIABILITY' OR v_mapping.control_account_type <> 'TEMPORARY_FUNDING_PAYABLE' THEN
    RAISE EXCEPTION 'temporary funding posting requires its approval-required policy and controlled payable mapping'
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM abos.journal_lines line
              WHERE line.journal_id = p_journal.id AND line.original_amount <> p_intent.original_amount) THEN
    RAISE EXCEPTION 'temporary funding journal line violates source, currency, account or dimension rules'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_settlement FROM abos.temporary_funding_settlements
   WHERE id = p_intent.temporary_funding_settlement_id AND legal_entity_id = p_journal.legal_entity_id;
  SELECT * INTO v_funding FROM abos.temporary_fundings
   WHERE id = v_settlement.temporary_funding_id AND legal_entity_id = p_journal.legal_entity_id;
  IF v_settlement.id IS NULL OR v_funding.id IS NULL OR v_funding.id <> p_intent.temporary_funding_id
     OR v_settlement.status <> 'POSTED' OR v_settlement.journal_id IS DISTINCT FROM p_journal.id
     OR v_funding.status <> 'POSTED'
     OR v_settlement.base_amount <> p_intent.base_amount OR v_settlement.business_date <> p_journal.accounting_effective_date
     OR v_settlement.workflow_policy_version_id <> v_policy.id OR v_funding.mapping_version_id <> v_mapping.id THEN
    RAISE EXCEPTION 'settlement, funding, intent and journal do not agree' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM abos.temporary_funding_settlement_decisions decision
                  WHERE decision.settlement_id = v_settlement.id AND decision.decision = 'APPROVED'
                    AND decision.decided_by_user_account_id = p_journal.posted_by_user_account_id)
     OR p_journal.posted_by_user_account_id = v_settlement.created_by_user_account_id
     OR p_journal.posted_by_user_account_id IS NOT DISTINCT FROM v_funding.provider_user_account_id THEN
    RAISE EXCEPTION 'a settlement must be posted by its independent approver' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT COALESCE(sum(other.base_amount), 0) INTO v_settled FROM abos.temporary_funding_settlements other
   WHERE other.temporary_funding_id = v_funding.id AND other.legal_entity_id = p_journal.legal_entity_id
     AND other.status = 'POSTED';
  IF v_settled > v_funding.base_amount THEN
    RAISE EXCEPTION 'settlements cannot exceed the funded amount' USING ERRCODE = 'check_violation';
  END IF;
  SELECT account.id, account.ledger_account_id INTO v_treasury FROM abos.operational_treasury_accounts account
    JOIN abos.ledger_accounts ledger ON ledger.id = account.ledger_account_id AND ledger.legal_entity_id = account.legal_entity_id
   WHERE account.id = v_settlement.operational_treasury_account_id AND account.legal_entity_id = p_journal.legal_entity_id
     AND account.status = 'ACTIVE' AND account.currency_code = p_journal.base_currency_code
     AND ledger.account_type = 'ASSET' AND ledger.control_account_type = 'CASH'
     AND NOT ledger.requires_project AND NOT ledger.requires_department AND NOT ledger.requires_cost_center;
  IF v_treasury.id IS NULL OR NOT EXISTS (
       SELECT 1 FROM abos.journal_lines line WHERE line.journal_id = p_journal.id AND line.line_number = 1
          AND line.ledger_account_id = v_mapping.payable_ledger_account_id
          AND line.base_debit = v_settlement.base_amount AND line.base_credit = 0
          AND line.business_party_id = v_funding.provider_business_party_id
          AND line.project_id IS NULL AND line.department_id IS NULL AND line.cost_center_id IS NULL)
     OR NOT EXISTS (
       SELECT 1 FROM abos.journal_lines line WHERE line.journal_id = p_journal.id AND line.line_number = 2
          AND line.ledger_account_id = v_treasury.ledger_account_id AND line.base_debit = 0
          AND line.base_credit = v_settlement.base_amount AND line.business_party_id IS NULL
          AND line.project_id IS NULL AND line.department_id IS NULL AND line.cost_center_id IS NULL) THEN
    RAISE EXCEPTION 'a settlement must debit the provider payable and credit its Treasury source'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*) INTO v_subledger_count FROM abos.subledger_entries entry
    JOIN abos.journal_lines line ON line.id = entry.journal_line_id WHERE line.journal_id = p_journal.id;
  IF v_subledger_count <> 2 OR EXISTS (
       SELECT 1 FROM abos.subledger_entries entry JOIN abos.journal_lines line ON line.id = entry.journal_line_id
        WHERE line.journal_id = p_journal.id AND NOT (
          (line.line_number = 1 AND entry.subledger_type = 'TEMPORARY_FUNDING_PAYABLE'
           AND entry.business_party_id = v_funding.provider_business_party_id
           AND entry.temporary_funding_id = v_funding.id AND entry.temporary_funding_settlement_id = v_settlement.id
           AND entry.original_amount = -v_settlement.original_amount AND entry.base_amount = -v_settlement.base_amount)
          OR
          (line.line_number = 2 AND entry.subledger_type = 'OPERATIONAL_TREASURY'
           AND entry.operational_treasury_account_id = v_settlement.operational_treasury_account_id
           AND entry.business_party_id IS NULL AND entry.temporary_funding_id IS NULL
           AND entry.original_amount = -v_settlement.original_amount AND entry.base_amount = -v_settlement.base_amount)))
     OR (SELECT count(DISTINCT line.line_number) FROM abos.subledger_entries entry
           JOIN abos.journal_lines line ON line.id = entry.journal_line_id WHERE line.journal_id = p_journal.id) <> 2 THEN
    RAISE EXCEPTION 'a settlement journal requires exactly its payable decrease and Treasury outflow'
      USING ERRCODE = 'check_violation';
  END IF;
END
$validate$;

-- ---------------------------------------------------------------------------------------------
-- 3. The kernel: shared invariants once, then static dispatch.
-- ---------------------------------------------------------------------------------------------

CREATE FUNCTION abos.posting_kernel_validate()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $kernel$
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
    ELSE
      RAISE EXCEPTION 'operational posting source % has no validator', v_source.source_type
        USING ERRCODE = 'check_violation';
  END CASE;
  RETURN NEW;
END
$kernel$;

REVOKE ALL ON FUNCTION
  abos.posting_kernel_validate(),
  abos.validate_expense_journal(abos.journals, abos.posting_intents),
  abos.validate_direct_shareholder_capital_journal(abos.journals, abos.posting_intents),
  abos.validate_temporary_funding_journal(abos.journals, abos.posting_intents),
  abos.validate_temporary_funding_settlement_journal(abos.journals, abos.posting_intents)
  FROM PUBLIC;
-- The kernel trigger runs as the role that posts: only the operational Finance owner may write
-- OPERATIONAL_V1 journals (guard_finance_processing_model), so only it calls the source validators.
GRANT EXECUTE ON FUNCTION
  abos.validate_expense_journal(abos.journals, abos.posting_intents),
  abos.validate_direct_shareholder_capital_journal(abos.journals, abos.posting_intents),
  abos.validate_temporary_funding_journal(abos.journals, abos.posting_intents),
  abos.validate_temporary_funding_settlement_journal(abos.journals, abos.posting_intents)
  TO abos_v1_operational_finance_owner;

-- ---------------------------------------------------------------------------------------------
-- 4. One kernel trigger replaces the three validators it supersedes; the bridge keeps its own.
-- ---------------------------------------------------------------------------------------------

DROP TRIGGER journals_operational_posting_guard ON abos.journals;
DROP TRIGGER direct_capital_journal_validation ON abos.journals;
DROP TRIGGER journals_operational_temporary_funding_posting_guard ON abos.journals;
DROP FUNCTION abos.validate_operational_journal_posting();
DROP FUNCTION abos.validate_direct_capital_journal_posting();
DROP FUNCTION abos.validate_temporary_funding_journal_posting();

CREATE TRIGGER journals_operational_kernel_guard
BEFORE INSERT OR UPDATE ON abos.journals
FOR EACH ROW WHEN (NEW.processing_model = 'OPERATIONAL_V1')
EXECUTE FUNCTION abos.posting_kernel_validate();
