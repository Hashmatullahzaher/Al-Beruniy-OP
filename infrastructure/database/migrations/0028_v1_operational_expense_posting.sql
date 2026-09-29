-- V1 Operational Finance: isolated expense posting lane.
--
-- LEGACY_E1 remains subject to every existing synthetic gate and posting validator. OPERATIONAL_V1
-- is writable only through the restricted operational Finance owner and the reviewed entry points
-- at the end of this migration. No business data is seeded.

-- ---------------------------------------------------------------------------
-- Persisted source, immutable policy route and independent approval.
-- ---------------------------------------------------------------------------

CREATE TABLE abos.operational_expenses (
  id uuid PRIMARY KEY,
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  operational_treasury_account_id uuid NOT NULL,
  operational_expense_category_id uuid NOT NULL,
  payee_business_party_id uuid,
  project_id uuid,
  department_id uuid,
  cost_center_id uuid,
  reference text NOT NULL CHECK (length(btrim(reference)) BETWEEN 1 AND 120),
  description text NOT NULL CHECK (length(btrim(description)) BETWEEN 3 AND 500),
  note text CHECK (note IS NULL OR length(btrim(note)) BETWEEN 1 AND 1000),
  business_date date NOT NULL,
  -- NaN sorts above every number in PostgreSQL, so '< Infinity' also excludes NaN.
  original_amount numeric NOT NULL CHECK (original_amount > 0 AND original_amount < 'Infinity'::numeric),
  original_currency_code text NOT NULL REFERENCES abos.currencies(code),
  base_amount numeric CHECK (base_amount IS NULL OR (base_amount > 0 AND base_amount < 'Infinity'::numeric)),
  base_currency_code text NOT NULL REFERENCES abos.currencies(code),
  exchange_rate_snapshot_id uuid,
  workflow_policy_version_id uuid NOT NULL,
  approval_required boolean NOT NULL,
  correlation_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 8 AND 200),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('DRAFT', 'PENDING_APPROVAL', 'VALIDATED', 'POSTED')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  journal_id uuid,
  created_by_user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, legal_entity_id),
  UNIQUE (legal_entity_id, idempotency_key),
  FOREIGN KEY (operational_treasury_account_id, legal_entity_id)
    REFERENCES abos.operational_treasury_accounts(id, legal_entity_id),
  FOREIGN KEY (operational_expense_category_id, legal_entity_id)
    REFERENCES abos.operational_expense_categories(id, legal_entity_id),
  FOREIGN KEY (payee_business_party_id, legal_entity_id)
    REFERENCES abos.business_parties(id, legal_entity_id),
  FOREIGN KEY (project_id, legal_entity_id) REFERENCES abos.projects(id, legal_entity_id),
  FOREIGN KEY (department_id, legal_entity_id) REFERENCES abos.departments(id, legal_entity_id),
  FOREIGN KEY (cost_center_id, legal_entity_id) REFERENCES abos.cost_centers(id, legal_entity_id),
  FOREIGN KEY (workflow_policy_version_id, legal_entity_id)
    REFERENCES abos.finance_workflow_policy_versions(id, legal_entity_id),
  CHECK (status = 'DRAFT' OR base_amount IS NOT NULL),
  CHECK ((status = 'POSTED') = (journal_id IS NOT NULL)),
  CHECK ((original_currency_code = base_currency_code AND exchange_rate_snapshot_id IS NULL)
      OR (original_currency_code <> base_currency_code
          AND (status = 'DRAFT' OR exchange_rate_snapshot_id IS NOT NULL)))
);
CREATE INDEX operational_expenses_entity_date_idx
  ON abos.operational_expenses (legal_entity_id, business_date DESC, created_at DESC);
CREATE INDEX operational_expenses_pending_idx
  ON abos.operational_expenses (legal_entity_id, status, business_date)
  WHERE status = 'PENDING_APPROVAL';

CREATE TABLE abos.operational_expense_approvals (
  id uuid PRIMARY KEY,
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  operational_expense_id uuid NOT NULL,
  decision text NOT NULL CHECK (decision = 'APPROVED'),
  decision_note text NOT NULL CHECK (length(btrim(decision_note)) BETWEEN 5 AND 500),
  approver_user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  approved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (operational_expense_id),
  UNIQUE (id, legal_entity_id),
  FOREIGN KEY (operational_expense_id, legal_entity_id)
    REFERENCES abos.operational_expenses(id, legal_entity_id)
);

CREATE FUNCTION abos.guard_operational_expense()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $guard$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'operational expenses are permanent records' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' OR NEW.version <> 1 OR NEW.journal_id IS NOT NULL THEN
      RAISE EXCEPTION 'an operational expense starts as DRAFT version 1 without a journal'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'POSTED' THEN
    RAISE EXCEPTION 'a posted operational expense is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.id, NEW.legal_entity_id, NEW.operational_treasury_account_id,
      NEW.operational_expense_category_id, NEW.payee_business_party_id,
      NEW.project_id, NEW.department_id, NEW.cost_center_id, NEW.reference,
      NEW.description, NEW.note, NEW.business_date, NEW.original_amount,
      NEW.original_currency_code, NEW.base_currency_code, NEW.workflow_policy_version_id,
      NEW.approval_required, NEW.correlation_id, NEW.idempotency_key,
      NEW.request_fingerprint, NEW.created_by_user_account_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.legal_entity_id, OLD.operational_treasury_account_id,
      OLD.operational_expense_category_id, OLD.payee_business_party_id,
      OLD.project_id, OLD.department_id, OLD.cost_center_id, OLD.reference,
      OLD.description, OLD.note, OLD.business_date, OLD.original_amount,
      OLD.original_currency_code, OLD.base_currency_code, OLD.workflow_policy_version_id,
      OLD.approval_required, OLD.correlation_id, OLD.idempotency_key,
      OLD.request_fingerprint, OLD.created_by_user_account_id, OLD.created_at) THEN
    RAISE EXCEPTION 'the accounting identity of an operational expense cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.exchange_rate_snapshot_id IS NOT NULL
     AND NEW.exchange_rate_snapshot_id IS DISTINCT FROM OLD.exchange_rate_snapshot_id THEN
    RAISE EXCEPTION 'the expense exchange-rate snapshot is immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.base_amount IS NOT NULL AND NEW.base_amount IS DISTINCT FROM OLD.base_amount THEN
    RAISE EXCEPTION 'the expense base amount is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.version <> OLD.version + 1 OR NEW.updated_at <= OLD.updated_at THEN
    RAISE EXCEPTION 'an expense transition must advance its version and update time'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT ((OLD.status = 'DRAFT' AND NEW.status IN ('PENDING_APPROVAL', 'VALIDATED'))
       OR (OLD.status IN ('PENDING_APPROVAL', 'VALIDATED') AND NEW.status = 'POSTED')) THEN
    RAISE EXCEPTION 'invalid operational expense transition % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER operational_expenses_guard
BEFORE INSERT OR UPDATE OR DELETE ON abos.operational_expenses
FOR EACH ROW EXECUTE FUNCTION abos.guard_operational_expense();

CREATE FUNCTION abos.guard_operational_expense_approval()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $guard$
DECLARE source_row record;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'operational expense approvals are immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT status, approval_required, created_by_user_account_id INTO source_row
    FROM abos.operational_expenses
   WHERE id = NEW.operational_expense_id AND legal_entity_id = NEW.legal_entity_id;
  IF NOT FOUND OR source_row.status <> 'PENDING_APPROVAL' OR NOT source_row.approval_required THEN
    RAISE EXCEPTION 'only a pending expense on an approval-required route can be approved'
      USING ERRCODE = 'check_violation';
  END IF;
  IF source_row.created_by_user_account_id = NEW.approver_user_account_id THEN
    RAISE EXCEPTION 'the expense creator cannot approve the same expense'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.approved_at := clock_timestamp();
  RETURN NEW;
END
$guard$;
CREATE TRIGGER operational_expense_approvals_guard
BEFORE INSERT OR UPDATE OR DELETE ON abos.operational_expense_approvals
FOR EACH ROW EXECUTE FUNCTION abos.guard_operational_expense_approval();

-- ---------------------------------------------------------------------------
-- Immutable LEGACY_E1 / OPERATIONAL_V1 discriminator and model-aware columns.
-- ---------------------------------------------------------------------------

ALTER TABLE abos.posting_intents
  ADD COLUMN processing_model text NOT NULL DEFAULT 'LEGACY_E1'
    CHECK (processing_model IN ('LEGACY_E1', 'OPERATIONAL_V1')),
  ADD COLUMN operational_expense_id uuid,
  ADD CONSTRAINT posting_intents_operational_expense_fk
    FOREIGN KEY (operational_expense_id, legal_entity_id)
    REFERENCES abos.operational_expenses(id, legal_entity_id),
  ADD CONSTRAINT posting_intents_operational_expense_source
    CHECK ((processing_model = 'OPERATIONAL_V1' AND intent_kind = 'EXPENSE')
             = (operational_expense_id IS NOT NULL)),
  DROP CONSTRAINT posting_intents_intent_kind_check,
  ADD CONSTRAINT posting_intents_intent_kind_check CHECK (intent_kind IN (
    'SHAREHOLDER_CAPITAL_RECEIPT', 'SHAREHOLDER_LOAN_RECEIPT', 'REVERSAL', 'EXPENSE')),
  DROP CONSTRAINT posting_intents_status_check,
  ADD CONSTRAINT posting_intents_status_check CHECK (status IN (
    'DRAFT', 'PENDING_APPROVAL', 'VALIDATED', 'APPROVED', 'REJECTED', 'POSTED', 'CANCELLED')),
  DROP CONSTRAINT posting_intents_check1,
  DROP CONSTRAINT posting_intents_conversion_snapshot_reference_check,
  ADD CONSTRAINT posting_intents_model_currency_check CHECK (
    (processing_model = 'LEGACY_E1'
      AND conversion_snapshot_reference IS NULL
      AND (base_currency_code IS NULL OR original_currency_code = base_currency_code))
    OR
    (processing_model = 'OPERATIONAL_V1' AND base_amount IS NOT NULL
      AND ((original_currency_code = base_currency_code AND conversion_snapshot_reference IS NULL)
        OR (original_currency_code <> base_currency_code
          AND conversion_snapshot_reference ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')))
  );

ALTER TABLE abos.journals
  ADD COLUMN processing_model text NOT NULL DEFAULT 'LEGACY_E1'
    CHECK (processing_model IN ('LEGACY_E1', 'OPERATIONAL_V1'));

ALTER TABLE abos.journal_lines
  ADD COLUMN processing_model text NOT NULL DEFAULT 'LEGACY_E1'
    CHECK (processing_model IN ('LEGACY_E1', 'OPERATIONAL_V1')),
  DROP CONSTRAINT journal_lines_check2,
  DROP CONSTRAINT journal_lines_conversion_snapshot_reference_check,
  ADD CONSTRAINT journal_lines_model_currency_check CHECK (
    (processing_model = 'LEGACY_E1'
      AND conversion_snapshot_reference IS NULL
      AND (original_currency_code IS NULL OR original_currency_code = base_currency_code))
    OR
    (processing_model = 'OPERATIONAL_V1' AND original_amount IS NOT NULL
      AND ((original_currency_code = base_currency_code AND conversion_snapshot_reference IS NULL)
        OR (original_currency_code <> base_currency_code
          AND conversion_snapshot_reference ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')))
  );

ALTER TABLE abos.subledger_entries
  ADD COLUMN processing_model text NOT NULL DEFAULT 'LEGACY_E1'
    CHECK (processing_model IN ('LEGACY_E1', 'OPERATIONAL_V1')),
  ADD COLUMN operational_treasury_account_id uuid,
  ADD CONSTRAINT subledger_entries_operational_treasury_fk
    FOREIGN KEY (operational_treasury_account_id, legal_entity_id)
    REFERENCES abos.operational_treasury_accounts(id, legal_entity_id),
  DROP CONSTRAINT subledger_entries_subledger_type_check,
  ADD CONSTRAINT subledger_entries_subledger_type_check CHECK (subledger_type IN (
    'SHAREHOLDER_CAPITAL', 'SHAREHOLDER_LOAN', 'CASH_LOCATION', 'OPERATIONAL_TREASURY')),
  ADD CONSTRAINT subledger_entries_operational_treasury_check CHECK (
    (subledger_type = 'OPERATIONAL_TREASURY') = (operational_treasury_account_id IS NOT NULL));

ALTER TABLE abos.operational_expenses
  ADD CONSTRAINT operational_expenses_journal_fk
    FOREIGN KEY (journal_id, legal_entity_id) REFERENCES abos.journals(id, legal_entity_id);

CREATE FUNCTION abos.guard_finance_processing_model()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $guard$
DECLARE parent_model text;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.processing_model IS DISTINCT FROM NEW.processing_model THEN
    RAISE EXCEPTION 'financial processing model is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.processing_model = 'OPERATIONAL_V1'
     AND current_user <> 'abos_v1_operational_finance_owner' THEN
    RAISE EXCEPTION 'OPERATIONAL_V1 records require the restricted operational Finance boundary'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_TABLE_NAME = 'journals' THEN
    SELECT processing_model INTO parent_model FROM abos.posting_intents
     WHERE id = NEW.posting_intent_id AND legal_entity_id = NEW.legal_entity_id;
  ELSIF TG_TABLE_NAME = 'journal_lines' THEN
    SELECT processing_model INTO parent_model FROM abos.journals
     WHERE id = NEW.journal_id AND legal_entity_id = NEW.legal_entity_id;
  ELSIF TG_TABLE_NAME = 'subledger_entries' THEN
    SELECT processing_model INTO parent_model FROM abos.journal_lines
     WHERE id = NEW.journal_line_id AND legal_entity_id = NEW.legal_entity_id;
  END IF;
  IF TG_TABLE_NAME <> 'posting_intents' AND parent_model IS DISTINCT FROM NEW.processing_model THEN
    RAISE EXCEPTION 'financial child processing model must match its parent'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER aa_posting_intents_processing_model_guard
BEFORE INSERT OR UPDATE ON abos.posting_intents
FOR EACH ROW EXECUTE FUNCTION abos.guard_finance_processing_model();
CREATE TRIGGER aa_journals_processing_model_guard
BEFORE INSERT OR UPDATE ON abos.journals
FOR EACH ROW EXECUTE FUNCTION abos.guard_finance_processing_model();
CREATE TRIGGER aa_journal_lines_processing_model_guard
BEFORE INSERT OR UPDATE ON abos.journal_lines
FOR EACH ROW EXECUTE FUNCTION abos.guard_finance_processing_model();
CREATE TRIGGER aa_subledger_entries_processing_model_guard
BEFORE INSERT OR UPDATE ON abos.subledger_entries
FOR EACH ROW EXECUTE FUNCTION abos.guard_finance_processing_model();

-- Route the unchanged legacy function bodies only to legacy records.
DROP TRIGGER posting_intents_sandbox_guard ON abos.posting_intents;
CREATE TRIGGER posting_intents_sandbox_guard BEFORE INSERT OR UPDATE ON abos.posting_intents
FOR EACH ROW WHEN (NEW.processing_model = 'LEGACY_E1')
EXECUTE FUNCTION abos.guard_sandbox_finance_mutation();
DROP TRIGGER journals_sandbox_guard ON abos.journals;
CREATE TRIGGER journals_sandbox_guard BEFORE INSERT OR UPDATE ON abos.journals
FOR EACH ROW WHEN (NEW.processing_model = 'LEGACY_E1')
EXECUTE FUNCTION abos.guard_sandbox_finance_mutation();
DROP TRIGGER journal_lines_sandbox_guard ON abos.journal_lines;
CREATE TRIGGER journal_lines_sandbox_guard BEFORE INSERT OR UPDATE ON abos.journal_lines
FOR EACH ROW WHEN (NEW.processing_model = 'LEGACY_E1')
EXECUTE FUNCTION abos.guard_sandbox_finance_mutation();
DROP TRIGGER subledger_entries_sandbox_guard ON abos.subledger_entries;
CREATE TRIGGER subledger_entries_sandbox_guard BEFORE INSERT OR UPDATE ON abos.subledger_entries
FOR EACH ROW WHEN (NEW.processing_model = 'LEGACY_E1')
EXECUTE FUNCTION abos.guard_sandbox_finance_mutation();
DROP TRIGGER journals_posting_guard ON abos.journals;
CREATE TRIGGER journals_posting_guard BEFORE INSERT OR UPDATE ON abos.journals
FOR EACH ROW WHEN (NEW.processing_model = 'LEGACY_E1')
EXECUTE FUNCTION abos.validate_journal_posting();
DROP TRIGGER journals_e1_sandbox_posting_guard ON abos.journals;
CREATE TRIGGER journals_e1_sandbox_posting_guard BEFORE INSERT OR UPDATE ON abos.journals
FOR EACH ROW WHEN (NEW.processing_model = 'LEGACY_E1')
EXECUTE FUNCTION abos.validate_e1_sandbox_posting();

ALTER TABLE abos.posting_intents
  ADD CONSTRAINT posting_intents_operational_source_matches_source_id
  CHECK (operational_expense_id IS NULL OR operational_expense_id = source_id);

-- ---------------------------------------------------------------------------
-- Immutable rate snapshots may now bind to an operational expense source.
-- ---------------------------------------------------------------------------

ALTER TABLE abos.exchange_rate_snapshots
  DROP CONSTRAINT exchange_rate_snapshots_source_type_check,
  ADD CONSTRAINT exchange_rate_snapshots_source_type_check
    CHECK (source_type IN ('CAPITAL_RECEIPT_INTENT', 'OPERATIONAL_EXPENSE'));

CREATE OR REPLACE FUNCTION abos.guard_exchange_rate_snapshot_insert()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $guard$
DECLARE
  rate abos.exchange_rates%ROWTYPE;
  entity_base text;
BEGIN
  NEW.captured_at := clock_timestamp();
  SELECT base_currency_code INTO entity_base FROM abos.legal_entities WHERE id = NEW.legal_entity_id;
  IF entity_base IS DISTINCT FROM NEW.base_currency_code THEN
    RAISE EXCEPTION 'a snapshot must name the legal entity''s base currency'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO rate FROM abos.exchange_rates
   WHERE id = NEW.exchange_rate_id AND legal_entity_id = NEW.legal_entity_id;
  IF NOT FOUND
     OR (rate.rate_date, rate.rate_source, rate.saraf_business_party_id,
         rate.unit_currency_code, rate.quote_currency_code, rate.entered_at)
        IS DISTINCT FROM (NEW.rate_date, NEW.rate_source, NEW.saraf_business_party_id,
         NEW.unit_currency_code, NEW.quote_currency_code, NEW.rate_entered_at)
     OR rate.rate_value::text <> NEW.rate_value::text THEN
    RAISE EXCEPTION 'a snapshot must copy its exchange rate exactly'
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM abos.exchange_rates correction
              WHERE correction.supersedes_exchange_rate_id = rate.id) THEN
    RAISE EXCEPTION 'a superseded exchange rate cannot be snapshotted'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.source_type = 'CAPITAL_RECEIPT_INTENT' AND NOT EXISTS (
    SELECT 1 FROM abos.capital_receipt_intents source
     WHERE source.id = NEW.source_id AND source.legal_entity_id = NEW.legal_entity_id
       AND source.currency_code = NEW.transaction_currency_code
  ) THEN
    RAISE EXCEPTION 'the snapshot source transaction does not exist in this currency'
      USING ERRCODE = 'check_violation';
  ELSIF NEW.source_type = 'OPERATIONAL_EXPENSE' AND NOT EXISTS (
    SELECT 1 FROM abos.operational_expenses source
     WHERE source.id = NEW.source_id AND source.legal_entity_id = NEW.legal_entity_id
       AND source.original_currency_code = NEW.transaction_currency_code
  ) THEN
    RAISE EXCEPTION 'the snapshot source expense does not exist in this currency'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$guard$;

ALTER TABLE abos.operational_expenses
  ADD CONSTRAINT operational_expenses_exchange_snapshot_fk
    FOREIGN KEY (exchange_rate_snapshot_id) REFERENCES abos.exchange_rate_snapshots(id);

-- ---------------------------------------------------------------------------
-- OPERATIONAL_V1 posting validator. Legacy validation remains unchanged above.
-- ---------------------------------------------------------------------------

CREATE FUNCTION abos.validate_operational_journal_posting()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $validate$
DECLARE
  intent_row abos.posting_intents%ROWTYPE;
  expense_row abos.operational_expenses%ROWTYPE;
  treasury_row abos.operational_treasury_accounts%ROWTYPE;
  category_row abos.operational_expense_categories%ROWTYPE;
  policy_row abos.finance_workflow_policy_versions%ROWTYPE;
  period_row record;
  entity_base text;
  snapshot_row abos.exchange_rate_snapshots%ROWTYPE;
  line_count bigint;
  debit_total numeric;
  credit_total numeric;
  approval_count bigint;
  treasury_subledger_count bigint;
BEGIN
  IF TG_OP = 'INSERT' AND NEW.status = 'POSTED' THEN
    RAISE EXCEPTION 'operational journals must be assembled as draft before posting'
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'POSTED' THEN
    RAISE EXCEPTION 'a posted operational journal is immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status <> 'POSTED' THEN RETURN NEW; END IF;

  SELECT * INTO intent_row FROM abos.posting_intents
   WHERE id = NEW.posting_intent_id AND legal_entity_id = NEW.legal_entity_id;
  IF NOT FOUND OR intent_row.processing_model <> 'OPERATIONAL_V1'
     OR intent_row.intent_kind <> 'EXPENSE' OR intent_row.status <> 'POSTED'
     OR intent_row.base_amount IS NULL
     OR intent_row.base_currency_code IS DISTINCT FROM NEW.base_currency_code THEN
    RAISE EXCEPTION 'operational posting requires a posted valued EXPENSE intent'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO expense_row FROM abos.operational_expenses
   WHERE id = intent_row.operational_expense_id AND legal_entity_id = NEW.legal_entity_id;
  IF NOT FOUND OR expense_row.id IS DISTINCT FROM intent_row.source_id
     OR expense_row.status <> 'POSTED' OR expense_row.journal_id IS DISTINCT FROM NEW.id
     OR expense_row.original_amount IS DISTINCT FROM intent_row.original_amount
     OR expense_row.original_currency_code IS DISTINCT FROM intent_row.original_currency_code
     OR expense_row.base_amount IS DISTINCT FROM intent_row.base_amount
     OR expense_row.base_currency_code IS DISTINCT FROM intent_row.base_currency_code
     OR expense_row.business_date IS DISTINCT FROM NEW.accounting_effective_date THEN
    RAISE EXCEPTION 'operational expense, intent and journal do not agree'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO policy_row FROM abos.finance_workflow_policy_versions
   WHERE id = expense_row.workflow_policy_version_id
     AND legal_entity_id = NEW.legal_entity_id AND workflow_type = 'EXPENSE';
  IF NOT FOUND OR policy_row.approval_required IS DISTINCT FROM expense_row.approval_required THEN
    RAISE EXCEPTION 'operational expense approval route does not match its immutable policy snapshot'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*) INTO approval_count FROM abos.operational_expense_approvals approval
   WHERE approval.operational_expense_id = expense_row.id
     AND approval.legal_entity_id = NEW.legal_entity_id
     AND approval.decision = 'APPROVED'
     AND approval.approver_user_account_id = NEW.posted_by_user_account_id;
  IF expense_row.approval_required THEN
    IF approval_count <> 1
       OR NEW.posted_by_user_account_id = expense_row.created_by_user_account_id THEN
      RAISE EXCEPTION 'approval-required expense must be posted by its independent approver'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF approval_count <> 0
        OR NEW.posted_by_user_account_id IS DISTINCT FROM expense_row.created_by_user_account_id THEN
    RAISE EXCEPTION 'direct-posting expense must have no approval and be posted by its creator'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT status, starts_on, ends_on INTO period_row FROM abos.accounting_periods
   WHERE id = NEW.accounting_period_id AND legal_entity_id = NEW.legal_entity_id;
  IF NOT FOUND OR period_row.status <> 'OPEN'
     OR NEW.accounting_effective_date NOT BETWEEN period_row.starts_on AND period_row.ends_on THEN
    RAISE EXCEPTION 'operational posting requires an open accounting period covering its date'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT base_currency_code INTO entity_base FROM abos.legal_entities
   WHERE id = NEW.legal_entity_id AND currency_policy_status = 'APPROVED';
  IF entity_base IS NULL OR entity_base IS DISTINCT FROM NEW.base_currency_code THEN
    RAISE EXCEPTION 'operational posting requires the approved legal-entity base currency'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO treasury_row FROM abos.operational_treasury_accounts
   WHERE id = expense_row.operational_treasury_account_id
     AND legal_entity_id = NEW.legal_entity_id AND status = 'ACTIVE';
  SELECT * INTO category_row FROM abos.operational_expense_categories
   WHERE id = expense_row.operational_expense_category_id
     AND legal_entity_id = NEW.legal_entity_id AND status = 'ACTIVE';
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
       AND legal_entity_id = NEW.legal_entity_id
       AND source_type = 'OPERATIONAL_EXPENSE' AND source_id = expense_row.id;
    IF NOT FOUND OR snapshot_row.transaction_currency_code <> expense_row.original_currency_code
       OR snapshot_row.base_currency_code <> expense_row.base_currency_code
       OR snapshot_row.rate_date <> expense_row.business_date
       OR intent_row.conversion_snapshot_reference IS DISTINCT FROM snapshot_row.id::text THEN
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

  SELECT count(*), coalesce(sum(base_debit), 0), coalesce(sum(base_credit), 0)
    INTO line_count, debit_total, credit_total FROM abos.journal_lines
   WHERE journal_id = NEW.id;
  IF line_count <> 2 OR debit_total <> credit_total
     OR debit_total <> expense_row.base_amount THEN
    RAISE EXCEPTION 'expense journal must contain exactly two lines balanced to its base amount'
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
      OR line.original_amount <> expense_row.original_amount
      OR line.original_currency_code <> expense_row.original_currency_code
      OR line.conversion_snapshot_reference IS DISTINCT FROM intent_row.conversion_snapshot_reference
      OR ledger.status <> 'ACTIVE' OR NOT ledger.posting_allowed
      OR (ledger.requires_project AND line.project_id IS NULL)
      OR (ledger.requires_department AND line.department_id IS NULL)
      OR (ledger.requires_cost_center AND line.cost_center_id IS NULL)
    )) THEN
    RAISE EXCEPTION 'operational journal line violates entity, currency, account or dimension rules'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM abos.journal_lines line WHERE line.journal_id = NEW.id
      AND line.line_number = 1 AND line.ledger_account_id = category_row.ledger_account_id
      AND line.base_debit = expense_row.base_amount AND line.base_credit = 0
      AND line.project_id IS NOT DISTINCT FROM expense_row.project_id
      AND line.department_id IS NOT DISTINCT FROM expense_row.department_id
      AND line.cost_center_id IS NOT DISTINCT FROM expense_row.cost_center_id
      AND line.business_party_id IS NOT DISTINCT FROM expense_row.payee_business_party_id
  ) OR NOT EXISTS (
    SELECT 1 FROM abos.journal_lines line WHERE line.journal_id = NEW.id
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
   WHERE line.journal_id = NEW.id
     AND entry.processing_model = 'OPERATIONAL_V1'
     AND entry.subledger_type = 'OPERATIONAL_TREASURY'
     AND entry.operational_treasury_account_id = treasury_row.id
     AND entry.original_amount = -expense_row.original_amount
     AND entry.original_currency_code = expense_row.original_currency_code
     AND entry.base_amount = -expense_row.base_amount
     AND entry.base_currency_code = expense_row.base_currency_code
     AND entry.source_type = 'OPERATIONAL_EXPENSE' AND entry.source_id = expense_row.id;
  IF treasury_subledger_count <> 1 OR EXISTS (
    SELECT 1 FROM abos.subledger_entries entry
    JOIN abos.journal_lines line ON line.id = entry.journal_line_id
    WHERE line.journal_id = NEW.id AND (
      entry.processing_model <> 'OPERATIONAL_V1'
      OR entry.subledger_type <> 'OPERATIONAL_TREASURY'
      OR line.line_number <> 2)
  ) THEN
    RAISE EXCEPTION 'expense journal requires exactly one matching Treasury subledger movement'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$validate$;
CREATE TRIGGER journals_operational_posting_guard
BEFORE INSERT OR UPDATE ON abos.journals
FOR EACH ROW WHEN (NEW.processing_model = 'OPERATIONAL_V1')
EXECUTE FUNCTION abos.validate_operational_journal_posting();

-- Existing reversal validation already checks exact lines, amounts and subledger cardinality. Add
-- the new Treasury-account identity without changing its legacy function body.
CREATE FUNCTION abos.validate_operational_treasury_reversal_link()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $validate$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM abos.journal_lines original_line
      JOIN abos.journal_lines reversal_line
        ON reversal_line.journal_id = NEW.reversal_journal_id
       AND reversal_line.line_number = original_line.line_number
      JOIN abos.subledger_entries original_entry
        ON original_entry.journal_line_id = original_line.id
      JOIN abos.subledger_entries reversal_entry
        ON reversal_entry.journal_line_id = reversal_line.id
       AND reversal_entry.subledger_type = original_entry.subledger_type
     WHERE original_line.journal_id = NEW.original_journal_id
       AND original_entry.operational_treasury_account_id
           IS DISTINCT FROM reversal_entry.operational_treasury_account_id
  ) THEN
    RAISE EXCEPTION 'reversal journal must preserve the operational Treasury account identity'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$validate$;
CREATE TRIGGER journal_reversal_links_operational_treasury_guard
BEFORE INSERT ON abos.journal_reversal_links
FOR EACH ROW EXECUTE FUNCTION abos.validate_operational_treasury_reversal_link();

-- ---------------------------------------------------------------------------
-- Internal operational helpers.
-- ---------------------------------------------------------------------------

CREATE FUNCTION abos.operational_expense_actor_in_scope(
  p_expense_id uuid, p_legal_entity_id uuid, p_actor_id uuid
) RETURNS boolean
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $scope$
  SELECT EXISTS (
    SELECT 1 FROM abos.operational_expenses expense
     WHERE expense.id = p_expense_id AND expense.legal_entity_id = p_legal_entity_id
       AND (expense.project_id IS NULL OR EXISTS (
         SELECT 1 FROM abos.user_scope_grants grant_row
          WHERE grant_row.user_account_id = p_actor_id
            AND grant_row.legal_entity_id = p_legal_entity_id
            AND grant_row.scope_kind = 'PROJECT' AND grant_row.scope_id = expense.project_id
            AND grant_row.revoked_at IS NULL))
       AND (expense.department_id IS NULL OR EXISTS (
         SELECT 1 FROM abos.user_scope_grants grant_row
          WHERE grant_row.user_account_id = p_actor_id
            AND grant_row.legal_entity_id = p_legal_entity_id
            AND grant_row.scope_kind = 'DEPARTMENT' AND grant_row.scope_id = expense.department_id
            AND grant_row.revoked_at IS NULL))
       AND (expense.cost_center_id IS NULL OR EXISTS (
         SELECT 1 FROM abos.user_scope_grants grant_row
          WHERE grant_row.user_account_id = p_actor_id
            AND grant_row.legal_entity_id = p_legal_entity_id
            AND grant_row.scope_kind = 'COST_CENTER' AND grant_row.scope_id = expense.cost_center_id
            AND grant_row.revoked_at IS NULL))
  )
$scope$;

CREATE FUNCTION abos.operational_expense_json(p_expense_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $json$
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
$json$;

CREATE FUNCTION abos.operational_expense_post(p_expense_id uuid, p_actor_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $post$
DECLARE
  expense abos.operational_expenses%ROWTYPE;
  treasury abos.operational_treasury_accounts%ROWTYPE;
  category abos.operational_expense_categories%ROWTYPE;
  period_id uuid;
  v_intent_id uuid := pg_catalog.gen_random_uuid();
  v_journal_id uuid := pg_catalog.gen_random_uuid();
  debit_line_id uuid := pg_catalog.gen_random_uuid();
  credit_line_id uuid := pg_catalog.gen_random_uuid();
  snapshot_reference text;
  initial_intent_status text;
BEGIN
  IF current_user <> 'abos_v1_operational_finance_owner' THEN
    RAISE EXCEPTION 'operational posting helper is internal'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO expense FROM abos.operational_expenses
   WHERE id = p_expense_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'operational expense not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF expense.status = 'POSTED' THEN RETURN expense.journal_id; END IF;
  IF expense.status NOT IN ('VALIDATED', 'PENDING_APPROVAL') THEN
    RAISE EXCEPTION 'expense is not ready to post' USING ERRCODE = 'check_violation';
  END IF;
  IF expense.approval_required THEN
    IF expense.status <> 'PENDING_APPROVAL' OR NOT EXISTS (
      SELECT 1 FROM abos.operational_expense_approvals approval
       WHERE approval.operational_expense_id = expense.id
         AND approval.legal_entity_id = expense.legal_entity_id
         AND approval.approver_user_account_id = p_actor_id
         AND approval.decision = 'APPROVED') THEN
      RAISE EXCEPTION 'approval-required expense has no approval from the posting actor'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    initial_intent_status := 'APPROVED';
  ELSE
    IF expense.status <> 'VALIDATED' OR expense.created_by_user_account_id <> p_actor_id
       OR EXISTS (SELECT 1 FROM abos.operational_expense_approvals approval
                   WHERE approval.operational_expense_id = expense.id) THEN
      RAISE EXCEPTION 'direct-posting expense route is inconsistent'
        USING ERRCODE = 'check_violation';
    END IF;
    initial_intent_status := 'VALIDATED';
  END IF;
  SELECT * INTO treasury FROM abos.operational_treasury_accounts
   WHERE id = expense.operational_treasury_account_id
     AND legal_entity_id = expense.legal_entity_id AND status = 'ACTIVE';
  SELECT * INTO category FROM abos.operational_expense_categories
   WHERE id = expense.operational_expense_category_id
     AND legal_entity_id = expense.legal_entity_id AND status = 'ACTIVE';
  IF treasury.id IS NULL OR category.id IS NULL THEN
    RAISE EXCEPTION 'expense Treasury account and category must remain active'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT period.id INTO period_id FROM abos.accounting_periods period
   WHERE period.legal_entity_id = expense.legal_entity_id AND period.status = 'OPEN'
     AND expense.business_date BETWEEN period.starts_on AND period.ends_on;
  IF period_id IS NULL THEN
    RAISE EXCEPTION 'no open accounting period covers the expense date'
      USING ERRCODE = 'check_violation';
  END IF;
  snapshot_reference := expense.exchange_rate_snapshot_id::text;

  INSERT INTO abos.posting_intents
    (id, legal_entity_id, project_id, department_id, cost_center_id,
     source_type, source_id, intent_kind, original_amount, original_currency_code,
     base_amount, base_currency_code, conversion_snapshot_reference,
     accounting_effective_date, correlation_id, idempotency_key, status,
     created_by_user_account_id, processing_model, operational_expense_id)
  VALUES
    (v_intent_id, expense.legal_entity_id, expense.project_id, expense.department_id,
     expense.cost_center_id, 'OPERATIONAL_EXPENSE', expense.id, 'EXPENSE',
     expense.original_amount, expense.original_currency_code, expense.base_amount,
     expense.base_currency_code, snapshot_reference, expense.business_date,
     expense.correlation_id, 'OPX:' || expense.idempotency_key, initial_intent_status,
     expense.created_by_user_account_id, 'OPERATIONAL_V1', expense.id);
  INSERT INTO abos.journals
    (id, legal_entity_id, accounting_period_id, posting_intent_id, journal_reference,
     accounting_effective_date, base_currency_code, status,
     created_by_user_account_id, processing_model)
  VALUES
    (v_journal_id, expense.legal_entity_id, period_id, v_intent_id,
     'OPX-' || v_journal_id::text, expense.business_date, expense.base_currency_code,
     'DRAFT', expense.created_by_user_account_id, 'OPERATIONAL_V1');
  INSERT INTO abos.journal_lines
    (id, journal_id, legal_entity_id, line_number, ledger_account_id,
     business_party_id, project_id, department_id, cost_center_id,
     original_amount, original_currency_code, base_debit, base_credit,
     base_currency_code, conversion_snapshot_reference, source_type, source_id,
     processing_model)
  VALUES
    (debit_line_id, v_journal_id, expense.legal_entity_id, 1, category.ledger_account_id,
     expense.payee_business_party_id, expense.project_id, expense.department_id,
     expense.cost_center_id, expense.original_amount, expense.original_currency_code,
     expense.base_amount, 0, expense.base_currency_code, snapshot_reference,
     'OPERATIONAL_EXPENSE', expense.id, 'OPERATIONAL_V1'),
    (credit_line_id, v_journal_id, expense.legal_entity_id, 2, treasury.ledger_account_id,
     NULL, expense.project_id, expense.department_id, expense.cost_center_id,
     expense.original_amount, expense.original_currency_code, 0, expense.base_amount,
     expense.base_currency_code, snapshot_reference,
     'OPERATIONAL_EXPENSE', expense.id, 'OPERATIONAL_V1');
  INSERT INTO abos.subledger_entries
    (id, legal_entity_id, journal_line_id, subledger_type,
     original_amount, original_currency_code, base_amount, base_currency_code,
     source_type, source_id, processing_model, operational_treasury_account_id)
  VALUES
    (pg_catalog.gen_random_uuid(), expense.legal_entity_id, credit_line_id,
     'OPERATIONAL_TREASURY', -expense.original_amount, expense.original_currency_code,
     -expense.base_amount, expense.base_currency_code, 'OPERATIONAL_EXPENSE', expense.id,
     'OPERATIONAL_V1', expense.operational_treasury_account_id);
  UPDATE abos.operational_expenses
     SET status = 'POSTED', journal_id = v_journal_id, version = version + 1,
         updated_at = pg_catalog.clock_timestamp()
   WHERE id = expense.id;
  UPDATE abos.posting_intents SET status = 'POSTED' WHERE id = v_intent_id;
  UPDATE abos.journals
     SET status = 'POSTED', posted_by_user_account_id = p_actor_id,
         posted_at = pg_catalog.clock_timestamp()
   WHERE id = v_journal_id;
  INSERT INTO abos.audit_records
    (id, actor_user_account_id, legal_entity_id, correlation_id, action,
     entity_type, entity_id, after_state, metadata)
  VALUES
    (pg_catalog.gen_random_uuid(), p_actor_id, expense.legal_entity_id,
     expense.correlation_id, 'OPERATIONAL_EXPENSE_POSTED', 'OPERATIONAL_EXPENSE',
     expense.id, pg_catalog.jsonb_build_object(
       'expenseId', expense.id, 'journalId', v_journal_id,
       'approvalRequired', expense.approval_required,
       'originalAmount', expense.original_amount::text,
       'originalCurrency', expense.original_currency_code,
       'baseAmount', expense.base_amount::text,
       'baseCurrency', expense.base_currency_code),
     pg_catalog.jsonb_build_object('source', 'v1-operational-expense'));
  INSERT INTO abos.outbox_events
    (id, aggregate_type, aggregate_id, event_type, event_version,
     legal_entity_id, actor_user_account_id, correlation_id, payload, occurred_at)
  VALUES
    (pg_catalog.gen_random_uuid(), 'OPERATIONAL_EXPENSE', expense.id,
     'finance.operational-expense.posted', 1, expense.legal_entity_id, p_actor_id,
     expense.correlation_id,
     pg_catalog.jsonb_build_object('expenseId', expense.id, 'journalId', v_journal_id),
     pg_catalog.clock_timestamp());
  RETURN v_journal_id;
END
$post$;

-- ---------------------------------------------------------------------------
-- Restricted public entry points.
-- ---------------------------------------------------------------------------

CREATE FUNCTION abos.operational_expense_workspace(
  p_identity_proof text,
  p_runtime_token_sha256 text,
  p_token_sha256 text,
  p_from date,
  p_to date
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $workspace$
DECLARE
  actor_context jsonb;
  actor_id uuid;
  entity_id uuid;
  permissions jsonb;
BEGIN
  actor_context := abos.operational_finance_actor(
    p_identity_proof, p_runtime_token_sha256, p_token_sha256, 'finance.expense.read');
  actor_id := (actor_context ->> 'userAccountId')::uuid;
  entity_id := (actor_context ->> 'legalEntityId')::uuid;
  permissions := COALESCE(actor_context -> 'permissions', '[]'::jsonb);
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 366 THEN
    RAISE EXCEPTION 'a valid expense date range of at most 366 days is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN pg_catalog.jsonb_build_object(
    'legalEntityId', entity_id,
    'from', p_from,
    'to', p_to,
    'permissions', pg_catalog.jsonb_build_object(
      'canCreate', permissions ? 'finance.expense.create',
      'canApprove', permissions ? 'finance.expense.approve'),
    'expenses', COALESCE((SELECT pg_catalog.jsonb_agg(
      abos.operational_expense_json(expense.id)
      ORDER BY expense.business_date DESC, expense.created_at DESC)
      FROM abos.operational_expenses expense
      WHERE expense.legal_entity_id = entity_id
        AND expense.business_date BETWEEN p_from AND p_to
        AND abos.operational_expense_actor_in_scope(expense.id, entity_id, actor_id)), '[]'::jsonb),
    'totalsByOriginalCurrency', COALESCE((SELECT pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'currency', totals.currency_code, 'amount', totals.amount::text)
      ORDER BY totals.currency_code)
      FROM (SELECT expense.original_currency_code AS currency_code,
                   sum(expense.original_amount) AS amount
              FROM abos.operational_expenses expense
             WHERE expense.legal_entity_id = entity_id
               AND expense.status = 'POSTED'
               AND expense.business_date BETWEEN p_from AND p_to
               AND abos.operational_expense_actor_in_scope(expense.id, entity_id, actor_id)
             GROUP BY expense.original_currency_code) totals), '[]'::jsonb),
    'baseTotal', (SELECT pg_catalog.jsonb_build_object(
      'currency', entity.base_currency_code,
      'amount', COALESCE(sum(expense.base_amount) FILTER (WHERE expense.status = 'POSTED'), 0)::text)
      FROM abos.legal_entities entity
      LEFT JOIN abos.operational_expenses expense
        ON expense.legal_entity_id = entity.id
       AND expense.business_date BETWEEN p_from AND p_to
       AND abos.operational_expense_actor_in_scope(expense.id, entity_id, actor_id)
      WHERE entity.id = entity_id GROUP BY entity.base_currency_code),
    'options', pg_catalog.jsonb_build_object(
      'treasuryAccounts', COALESCE((SELECT pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id', account.id, 'nameEn', account.name_en, 'nameFa', account.name_fa,
          'currencyCode', account.currency_code, 'accountType', account.account_type)
        ORDER BY account.name_en, account.id)
        FROM abos.operational_treasury_accounts account
        WHERE account.legal_entity_id = entity_id AND account.status = 'ACTIVE'), '[]'::jsonb),
      'expenseCategories', COALESCE((SELECT pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id', category.id, 'code', category.category_code,
          'nameEn', category.name_en, 'nameFa', category.name_fa)
        ORDER BY category.category_code, category.id)
        FROM abos.operational_expense_categories category
        WHERE category.legal_entity_id = entity_id AND category.status = 'ACTIVE'), '[]'::jsonb),
      'payees', COALESCE((SELECT pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object('id', party.id, 'name', party.display_name)
        ORDER BY party.display_name, party.id)
        FROM abos.business_parties party
        WHERE party.legal_entity_id = entity_id AND party.status = 'ACTIVE'), '[]'::jsonb)));
END
$workspace$;

CREATE FUNCTION abos.operational_expense_create(
  p_identity_proof text,
  p_runtime_token_sha256 text,
  p_token_sha256 text,
  p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $create$
DECLARE
  v_actor_context jsonb;
  v_actor_id uuid;
  v_entity_id uuid;
  v_treasury_id uuid;
  v_category_id uuid;
  v_payee_id uuid;
  v_project_id uuid;
  v_department_id uuid;
  v_cost_center_id uuid;
  v_exchange_rate_id uuid;
  v_correlation_id uuid;
  v_business_date date;
  v_amount_text text;
  v_original_amount numeric;
  v_currency text;
  v_base_currency text;
  v_base_amount numeric;
  v_reference text;
  v_description text;
  v_note text;
  v_request_key text;
  v_fingerprint text;
  v_scope text;
  v_idempotency abos.idempotency_records%ROWTYPE;
  v_policy abos.finance_workflow_policy_versions%ROWTYPE;
  v_expense_id uuid := pg_catalog.gen_random_uuid();
  v_snapshot_id uuid;
  v_snapshot abos.exchange_rate_snapshots%ROWTYPE;
  v_route text;
  v_response jsonb;
  v_unknown text;
BEGIN
  -- Identity, legal entity and permission come only from server proof plus the live session.
  v_actor_context := abos.operational_finance_actor(
    p_identity_proof, p_runtime_token_sha256, p_token_sha256, 'finance.expense.create');
  v_actor_id := (v_actor_context ->> 'userAccountId')::uuid;
  v_entity_id := (v_actor_context ->> 'legalEntityId')::uuid;

  IF p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'expense details must be an object'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT pg_catalog.string_agg(payload_key, ', ') INTO v_unknown
    FROM pg_catalog.jsonb_object_keys(p_payload) payload_key
   WHERE payload_key NOT IN (
     'treasuryAccountId', 'expenseCategoryId', 'payeeBusinessPartyId',
     'projectId', 'departmentId', 'costCenterId', 'reference', 'description', 'note',
     'businessDate', 'originalAmount', 'currencyCode', 'exchangeRateId',
     'correlationId', 'idempotencyKey');
  IF v_unknown IS NOT NULL THEN
    RAISE EXCEPTION 'unknown expense fields: %', v_unknown
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Money crosses the boundary as a canonical decimal string (the contracts' pattern). A plain
  -- ::numeric cast would also accept NaN, Infinity and exponents.
  v_amount_text := p_payload ->> 'originalAmount';
  IF v_amount_text IS NULL OR pg_catalog.length(v_amount_text) > 256
     OR v_amount_text !~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$' THEN
    RAISE EXCEPTION 'the expense amount must be a plain positive decimal'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_original_amount := v_amount_text::numeric;
  v_treasury_id := NULLIF(p_payload ->> 'treasuryAccountId', '')::uuid;
  v_category_id := NULLIF(p_payload ->> 'expenseCategoryId', '')::uuid;
  v_payee_id := NULLIF(p_payload ->> 'payeeBusinessPartyId', '')::uuid;
  v_project_id := NULLIF(p_payload ->> 'projectId', '')::uuid;
  v_department_id := NULLIF(p_payload ->> 'departmentId', '')::uuid;
  v_cost_center_id := NULLIF(p_payload ->> 'costCenterId', '')::uuid;
  v_exchange_rate_id := NULLIF(p_payload ->> 'exchangeRateId', '')::uuid;
  v_correlation_id := NULLIF(p_payload ->> 'correlationId', '')::uuid;
  v_business_date := NULLIF(p_payload ->> 'businessDate', '')::date;
  v_currency := pg_catalog.upper(NULLIF(pg_catalog.btrim(p_payload ->> 'currencyCode'), ''));
  v_reference := NULLIF(pg_catalog.btrim(p_payload ->> 'reference'), '');
  v_description := NULLIF(pg_catalog.btrim(p_payload ->> 'description'), '');
  v_note := NULLIF(pg_catalog.btrim(p_payload ->> 'note'), '');
  v_request_key := NULLIF(pg_catalog.btrim(p_payload ->> 'idempotencyKey'), '');
  IF v_treasury_id IS NULL OR v_category_id IS NULL OR v_correlation_id IS NULL
     OR v_business_date IS NULL OR v_original_amount <= 0
     OR v_currency IS NULL OR v_reference IS NULL OR v_description IS NULL
     OR v_request_key IS NULL OR pg_catalog.length(v_request_key) NOT BETWEEN 8 AND 200
     OR pg_catalog.length(v_reference) > 120
     OR pg_catalog.length(v_description) NOT BETWEEN 3 AND 500
     OR (v_note IS NOT NULL AND pg_catalog.length(v_note) > 1000) THEN
    RAISE EXCEPTION 'complete valid expense details are required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Idempotency first (after identity), so an identical retry returns the recorded result even if
  -- configuration changed meanwhile. The creator is part of the fingerprint: another user reusing
  -- the key is a conflict, never someone else's result.
  v_fingerprint := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    pg_catalog.jsonb_build_object(
      'actorId', v_actor_id,
      'treasuryAccountId', v_treasury_id, 'expenseCategoryId', v_category_id,
      'payeeBusinessPartyId', v_payee_id, 'projectId', v_project_id,
      'departmentId', v_department_id, 'costCenterId', v_cost_center_id,
      'reference', v_reference, 'description', v_description, 'note', v_note,
      'businessDate', v_business_date, 'originalAmount', v_original_amount::text,
      'currencyCode', v_currency, 'exchangeRateId', v_exchange_rate_id,
      'correlationId', v_correlation_id)::text, 'UTF8')), 'hex');
  v_scope := v_entity_id::text || ':OPERATIONAL_EXPENSE_CREATE';
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_scope || ':' || v_request_key, 0));
  SELECT * INTO v_idempotency FROM abos.idempotency_records record
   WHERE record.scope = v_scope AND record.idempotency_key = v_request_key;
  IF FOUND THEN
    IF v_idempotency.request_fingerprint <> v_fingerprint THEN
      RAISE EXCEPTION 'idempotency key was already used for different expense details'
        USING ERRCODE = 'unique_violation';
    END IF;
    IF v_idempotency.status = 'COMPLETED' THEN
      RETURN v_idempotency.response_snapshot || pg_catalog.jsonb_build_object('replayed', true);
    END IF;
    RAISE EXCEPTION 'expense request with this idempotency key is still in progress'
      USING ERRCODE = 'serialization_failure';
  END IF;

  SELECT entity.base_currency_code INTO v_base_currency FROM abos.legal_entities entity
   WHERE entity.id = v_entity_id AND entity.currency_policy_status = 'APPROVED';
  IF v_base_currency IS NULL THEN
    RAISE EXCEPTION 'the legal entity has no approved base currency'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_currency = v_base_currency AND v_exchange_rate_id IS NOT NULL THEN
    RAISE EXCEPTION 'base-currency expense must not select an exchange rate'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM abos.operational_treasury_accounts account
     WHERE account.id = v_treasury_id AND account.legal_entity_id = v_entity_id
       AND account.status = 'ACTIVE' AND account.currency_code = v_currency
  ) OR NOT EXISTS (
    SELECT 1 FROM abos.operational_expense_categories category
     WHERE category.id = v_category_id AND category.legal_entity_id = v_entity_id
       AND category.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'active same-entity Treasury account and expense category are required'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_payee_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM abos.business_parties party
     WHERE party.id = v_payee_id AND party.legal_entity_id = v_entity_id AND party.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'payee is not an active business party in this legal entity'
      USING ERRCODE = 'check_violation';
  END IF;
  IF (v_project_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM abos.user_scope_grants grant_row
       WHERE grant_row.user_account_id = v_actor_id AND grant_row.legal_entity_id = v_entity_id
         AND grant_row.scope_kind = 'PROJECT' AND grant_row.scope_id = v_project_id
         AND grant_row.revoked_at IS NULL))
     OR (v_department_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM abos.user_scope_grants grant_row
       WHERE grant_row.user_account_id = v_actor_id AND grant_row.legal_entity_id = v_entity_id
         AND grant_row.scope_kind = 'DEPARTMENT' AND grant_row.scope_id = v_department_id
         AND grant_row.revoked_at IS NULL))
     OR (v_cost_center_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM abos.user_scope_grants grant_row
       WHERE grant_row.user_account_id = v_actor_id AND grant_row.legal_entity_id = v_entity_id
         AND grant_row.scope_kind = 'COST_CENTER' AND grant_row.scope_id = v_cost_center_id
         AND grant_row.revoked_at IS NULL)) THEN
    RAISE EXCEPTION 'expense dimensions are outside the actor''s live scope'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM abos.accounting_periods period
     WHERE period.legal_entity_id = v_entity_id AND period.status = 'OPEN'
       AND v_business_date BETWEEN period.starts_on AND period.ends_on
  ) THEN
    RAISE EXCEPTION 'an open accounting period must cover the expense date'
      USING ERRCODE = 'check_violation';
  END IF;
  -- The route is fixed now: the latest policy version at creation is stored with the expense and
  -- a later policy change never re-routes it.
  SELECT * INTO v_policy FROM abos.finance_workflow_policy_versions policy
   WHERE policy.legal_entity_id = v_entity_id AND policy.workflow_type = 'EXPENSE'
   ORDER BY policy.version DESC LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'expense approval policy is not configured for this legal entity'
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO abos.idempotency_records
    (scope, idempotency_key, request_fingerprint, correlation_id, status)
  VALUES (v_scope, v_request_key, v_fingerprint, v_correlation_id, 'IN_PROGRESS');

  INSERT INTO abos.operational_expenses
    (id, legal_entity_id, operational_treasury_account_id,
     operational_expense_category_id, payee_business_party_id, project_id,
     department_id, cost_center_id, reference, description, note, business_date,
     original_amount, original_currency_code, base_amount, base_currency_code,
     workflow_policy_version_id, approval_required, correlation_id, idempotency_key,
     request_fingerprint, status, version, created_by_user_account_id)
  VALUES
    (v_expense_id, v_entity_id, v_treasury_id, v_category_id, v_payee_id, v_project_id,
     v_department_id, v_cost_center_id, v_reference, v_description, v_note,
     v_business_date, v_original_amount, v_currency,
     CASE WHEN v_currency = v_base_currency THEN v_original_amount ELSE NULL END,
     v_base_currency, v_policy.id, v_policy.approval_required, v_correlation_id,
     v_request_key, v_fingerprint, 'DRAFT', 1, v_actor_id);

  IF v_currency = v_base_currency THEN
    v_base_amount := v_original_amount;
  ELSE
    -- Only that business date's current rate (the user's choice when several exist); never another
    -- day's rate and never a fallback.
    v_snapshot_id := abos.capture_exchange_rate_snapshot(
      v_entity_id, 'OPERATIONAL_EXPENSE', v_expense_id, v_currency,
      v_business_date, v_exchange_rate_id, v_actor_id);
    SELECT * INTO v_snapshot FROM abos.exchange_rate_snapshots snapshot
     WHERE snapshot.id = v_snapshot_id;
    -- Exact-only conversion (design addendum): no rounding policy is approved, so a result that
    -- is not exact is refused. trim_scale removes only trailing zeros; the value is unchanged.
    IF v_snapshot.unit_currency_code = v_currency
       AND v_snapshot.quote_currency_code = v_base_currency THEN
      v_base_amount := pg_catalog.trim_scale(v_original_amount * v_snapshot.rate_value);
    ELSIF v_snapshot.quote_currency_code = v_currency
       AND v_snapshot.unit_currency_code = v_base_currency THEN
      v_base_amount := pg_catalog.trim_scale(v_original_amount / v_snapshot.rate_value);
      IF v_base_amount * v_snapshot.rate_value <> v_original_amount THEN
        RAISE EXCEPTION 'inverse rate result is not exact; rounding policy is not approved'
          USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      RAISE EXCEPTION 'selected exchange rate does not match the expense currencies'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  v_route := CASE WHEN v_policy.approval_required THEN 'PENDING_APPROVAL' ELSE 'VALIDATED' END;
  UPDATE abos.operational_expenses
     SET base_amount = v_base_amount, exchange_rate_snapshot_id = v_snapshot_id,
         status = v_route, version = 2, updated_at = pg_catalog.clock_timestamp()
   WHERE id = v_expense_id;
  -- Approval OFF: post in this same transaction; no approval row is written.
  IF NOT v_policy.approval_required THEN
    PERFORM abos.operational_expense_post(v_expense_id, v_actor_id);
  END IF;
  v_response := pg_catalog.jsonb_build_object(
    'expense', abos.operational_expense_json(v_expense_id), 'replayed', false);
  UPDATE abos.idempotency_records
     SET status = 'COMPLETED', resource_type = 'OPERATIONAL_EXPENSE',
         resource_id = v_expense_id, response_code = 200, response_snapshot = v_response,
         completed_at = pg_catalog.clock_timestamp()
   WHERE scope = v_scope AND idempotency_key = v_request_key;
  INSERT INTO abos.audit_records
    (id, actor_user_account_id, legal_entity_id, correlation_id, action,
     entity_type, entity_id, after_state, metadata)
  VALUES
    (pg_catalog.gen_random_uuid(), v_actor_id, v_entity_id, v_correlation_id,
     'OPERATIONAL_EXPENSE_CREATED', 'OPERATIONAL_EXPENSE', v_expense_id,
     abos.operational_expense_json(v_expense_id),
     pg_catalog.jsonb_build_object(
       'source', 'v1-operational-expense',
       'approvalRequired', v_policy.approval_required,
       'policyVersionId', v_policy.id));
  RETURN v_response;
END
$create$;

CREATE FUNCTION abos.operational_expense_approve(
  p_identity_proof text,
  p_runtime_token_sha256 text,
  p_token_sha256 text,
  p_expense_id uuid,
  p_expected_version integer,
  p_note text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $approve$
DECLARE
  actor_context jsonb;
  actor_id uuid;
  entity_id uuid;
  expense abos.operational_expenses%ROWTYPE;
  note_value text := NULLIF(pg_catalog.btrim(p_note), '');
BEGIN
  actor_context := abos.operational_finance_actor(
    p_identity_proof, p_runtime_token_sha256, p_token_sha256, 'finance.expense.approve');
  actor_id := (actor_context ->> 'userAccountId')::uuid;
  entity_id := (actor_context ->> 'legalEntityId')::uuid;
  IF p_expense_id IS NULL OR p_expected_version IS NULL OR p_expected_version < 1
     OR note_value IS NULL OR pg_catalog.length(note_value) NOT BETWEEN 5 AND 500 THEN
    RAISE EXCEPTION 'expense, current version and a 5-500 character approval note are required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('abos-operational-expense-approve:' || p_expense_id::text, 0));
  SELECT * INTO expense FROM abos.operational_expenses
   WHERE id = p_expense_id AND legal_entity_id = entity_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'expense is not available in this legal entity'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF expense.status = 'POSTED' AND EXISTS (
    SELECT 1 FROM abos.operational_expense_approvals approval
     WHERE approval.operational_expense_id = expense.id
       AND approval.approver_user_account_id = actor_id
  ) THEN
    RETURN pg_catalog.jsonb_build_object(
      'expense', abos.operational_expense_json(expense.id), 'replayed', true);
  END IF;
  IF expense.version <> p_expected_version THEN
    RAISE EXCEPTION 'expense changed; reload and try again'
      USING ERRCODE = 'serialization_failure';
  END IF;
  IF expense.status <> 'PENDING_APPROVAL' OR NOT expense.approval_required THEN
    RAISE EXCEPTION 'expense is not waiting for approval'
      USING ERRCODE = 'check_violation';
  END IF;
  IF expense.created_by_user_account_id = actor_id THEN
    RAISE EXCEPTION 'the expense creator cannot approve the same expense'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT abos.operational_expense_actor_in_scope(expense.id, entity_id, actor_id) THEN
    RAISE EXCEPTION 'expense is outside the approver''s live scope'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO abos.operational_expense_approvals
    (id, legal_entity_id, operational_expense_id, decision, decision_note,
     approver_user_account_id)
  VALUES
    (pg_catalog.gen_random_uuid(), entity_id, expense.id, 'APPROVED', note_value, actor_id);
  PERFORM abos.operational_expense_post(expense.id, actor_id);
  INSERT INTO abos.audit_records
    (id, actor_user_account_id, legal_entity_id, correlation_id, action,
     entity_type, entity_id, after_state, metadata)
  VALUES
    (pg_catalog.gen_random_uuid(), actor_id, entity_id, expense.correlation_id,
     'OPERATIONAL_EXPENSE_APPROVED', 'OPERATIONAL_EXPENSE', expense.id,
     abos.operational_expense_json(expense.id),
     pg_catalog.jsonb_build_object('source', 'v1-operational-expense'));
  RETURN pg_catalog.jsonb_build_object(
    'expense', abos.operational_expense_json(expense.id), 'replayed', false);
END
$approve$;

-- ---------------------------------------------------------------------------
-- Least-privilege owner and runtime boundary.
-- ---------------------------------------------------------------------------

GRANT SELECT ON
  abos.operational_expenses, abos.operational_expense_approvals,
  abos.finance_workflow_policy_versions, abos.posting_intents, abos.journals,
  abos.journal_lines, abos.subledger_entries, abos.exchange_rates,
  abos.exchange_rate_snapshots, abos.idempotency_records
TO abos_v1_operational_finance_owner;
GRANT SELECT (id, legal_entity_id, starts_on, ends_on, status)
  ON abos.accounting_periods TO abos_v1_operational_finance_owner;
GRANT SELECT (id, base_currency_code, currency_policy_status)
  ON abos.legal_entities TO abos_v1_operational_finance_owner;
GRANT SELECT (id, legal_entity_id, account_code, account_name, account_type,
  control_account_type, posting_allowed, requires_project, requires_department,
  requires_cost_center, account_currency_code, status)
  ON abos.ledger_accounts TO abos_v1_operational_finance_owner;
GRANT SELECT (user_account_id, legal_entity_id, scope_kind, scope_id, revoked_at)
  ON abos.user_scope_grants TO abos_v1_operational_finance_owner;

GRANT INSERT (id, legal_entity_id, operational_treasury_account_id,
  operational_expense_category_id, payee_business_party_id, project_id,
  department_id, cost_center_id, reference, description, note, business_date,
  original_amount, original_currency_code, base_amount, base_currency_code,
  exchange_rate_snapshot_id, workflow_policy_version_id, approval_required,
  correlation_id, idempotency_key, request_fingerprint, status, version,
  journal_id, created_by_user_account_id)
  ON abos.operational_expenses TO abos_v1_operational_finance_owner;
GRANT UPDATE (base_amount, exchange_rate_snapshot_id, status, version, journal_id, updated_at)
  ON abos.operational_expenses TO abos_v1_operational_finance_owner;
GRANT INSERT (id, legal_entity_id, operational_expense_id, decision,
  decision_note, approver_user_account_id)
  ON abos.operational_expense_approvals TO abos_v1_operational_finance_owner;
GRANT INSERT (id, legal_entity_id, project_id, department_id, cost_center_id,
  source_type, source_id, intent_kind, original_amount, original_currency_code,
  base_amount, base_currency_code, conversion_snapshot_reference,
  accounting_effective_date, correlation_id, idempotency_key, status,
  created_by_user_account_id, processing_model, operational_expense_id)
  ON abos.posting_intents TO abos_v1_operational_finance_owner;
GRANT UPDATE (status) ON abos.posting_intents TO abos_v1_operational_finance_owner;
GRANT INSERT (id, legal_entity_id, accounting_period_id, posting_intent_id,
  journal_reference, accounting_effective_date, base_currency_code, status,
  created_by_user_account_id, processing_model)
  ON abos.journals TO abos_v1_operational_finance_owner;
GRANT UPDATE (status, posted_by_user_account_id, posted_at)
  ON abos.journals TO abos_v1_operational_finance_owner;
GRANT INSERT (id, journal_id, legal_entity_id, line_number, ledger_account_id,
  business_party_id, project_id, department_id, cost_center_id, original_amount,
  original_currency_code, base_debit, base_credit, base_currency_code,
  conversion_snapshot_reference, source_type, source_id, processing_model)
  ON abos.journal_lines TO abos_v1_operational_finance_owner;
GRANT INSERT (id, legal_entity_id, journal_line_id, subledger_type,
  operational_treasury_account_id, original_amount, original_currency_code,
  base_amount, base_currency_code, source_type, source_id, processing_model)
  ON abos.subledger_entries TO abos_v1_operational_finance_owner;
GRANT INSERT (id, legal_entity_id, source_type, source_id,
  transaction_currency_code, base_currency_code, exchange_rate_id, rate_date,
  rate_source, saraf_business_party_id, unit_currency_code, quote_currency_code,
  rate_value, rate_entered_at, captured_by_user_account_id)
  ON abos.exchange_rate_snapshots TO abos_v1_operational_finance_owner;
GRANT INSERT (scope, idempotency_key, request_fingerprint, correlation_id, status)
  ON abos.idempotency_records TO abos_v1_operational_finance_owner;
GRANT UPDATE (status, resource_type, resource_id, response_code,
  response_snapshot, completed_at)
  ON abos.idempotency_records TO abos_v1_operational_finance_owner;
GRANT INSERT (id, aggregate_type, aggregate_id, event_type, event_version,
  legal_entity_id, actor_user_account_id, correlation_id, payload, occurred_at)
  ON abos.outbox_events TO abos_v1_operational_finance_owner;

GRANT EXECUTE ON FUNCTION abos.capture_exchange_rate_snapshot(uuid, text, uuid, text, date, uuid, uuid),
  abos.operational_expense_actor_in_scope(uuid, uuid, uuid),
  abos.operational_expense_json(uuid),
  abos.operational_expense_post(uuid, uuid)
TO abos_v1_operational_finance_owner;

ALTER FUNCTION abos.operational_expense_workspace(text, text, text, date, date)
  OWNER TO abos_v1_operational_finance_owner;
ALTER FUNCTION abos.operational_expense_create(text, text, text, jsonb)
  OWNER TO abos_v1_operational_finance_owner;
ALTER FUNCTION abos.operational_expense_approve(text, text, text, uuid, integer, text)
  OWNER TO abos_v1_operational_finance_owner;

REVOKE ALL ON FUNCTION abos.guard_operational_expense(),
  abos.guard_operational_expense_approval(), abos.guard_finance_processing_model(),
  abos.validate_operational_journal_posting(),
  abos.validate_operational_treasury_reversal_link(),
  abos.operational_expense_actor_in_scope(uuid, uuid, uuid),
  abos.operational_expense_json(uuid), abos.operational_expense_post(uuid, uuid),
  abos.operational_expense_workspace(text, text, text, date, date),
  abos.operational_expense_create(text, text, text, jsonb),
  abos.operational_expense_approve(text, text, text, uuid, integer, text)
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
  abos.operational_expense_workspace(text, text, text, date, date),
  abos.operational_expense_create(text, text, text, jsonb),
  abos.operational_expense_approve(text, text, text, uuid, integer, text)
TO abos_e1_runtime;

REVOKE ALL ON abos.operational_expenses, abos.operational_expense_approvals
  FROM PUBLIC, abos_v1_identity_runtime, abos_e1_runtime, abos_e1_treasury_runtime;
