-- P2 TEMPORARY FUNDING: SCHEMA PROPOSAL (NOT A MIGRATION; NO NUMBER ASSIGNED).
--
-- Status: isolated design + implementation for coordination with the Shareholders -> Finance bridge
-- (codex/v1-shareholder-finance-bridge @ 1758f03, V1_SHAREHOLDER_FINANCE_MIGRATION_READINESS_MANIFEST.md).
-- This file is applied ONLY by the isolated test suite after migrations 0001-0035 in a disposable
-- database. It is not registered in packages/database/src/migrations.ts and must not be applied to any
-- preserved or production database. A migration number is assigned only after schema coordination.
--
-- Business rule: a cash shortage is never represented by letting physical Safe cash go negative. When a
-- person or organization temporarily funds the business, the funding is an explicit liability:
-- TEMPORARY_FUNDING_PAYABLE, per provider.
--   Mode PROVIDER_PAID_EXPENSE: Dr Expense / Cr Temporary Funding Payable (provider). Safe unchanged.
--   Mode PROVIDER_FUNDED_SAFE : Dr Safe    / Cr Temporary Funding Payable (provider). Safe increases.
--   Settlement               : Dr Temporary Funding Payable (provider) / Cr Safe or Bank.
--   Reversal (unsettled only): exact mirror journal linked through journal_reversal_links.
--
-- Coordination decisions (see docs/04-delivery/P2_TEMPORARY_FUNDING_SCHEMA_PROPOSAL.md):
--   * reuses the shared generic column posting_intents.finance_workflow_policy_version_id (same name and
--     semantics as the Shareholder-Finance manifest; whichever migration lands first creates it with
--     ADD COLUMN IF NOT EXISTS and an entity-qualified FK);
--   * typed source FKs (temporary_funding_id, temporary_funding_settlement_id,
--     temporary_funding_reversal_id) extend the model-aware source checks without touching the legacy
--     capital or Operational V1 expense branches;
--   * the Operational V1 journal validator becomes a dispatcher: TEMPORARY_FUNDING* journals go to the
--     funding validator, everything else runs the unchanged 0028 expense body;
--   * no generic receipt/custody table and no reuse of any reserved shareholder-capital name;
--   * funding-specific immutable mapping versions (payable ledger), not the capital mapping.
--
-- Staged Safe guard: operational_treasury_cash_controls holds an approved opening position per Treasury
-- account. Where a control exists, every outflow (ordinary expense and funding settlement) must leave
-- recorded cash >= 0 or fail before posting. Where none exists (all accounts today), behaviour is
-- unchanged: no opening balance has been formally approved, so no non-negative rule is imposed yet.

-- ---------------------------------------------------------------------------------------------------
-- 1. Permissions and workflow type
-- ---------------------------------------------------------------------------------------------------
-- Catalogue version: next free number at apply time (the coordinator assigns the final value).
INSERT INTO abos.permission_catalogue
  (permission_code, catalogue_version, category, availability, independence_enforced, administrative, sort_order)
SELECT item.code, (SELECT max(catalogue_version) + 1 FROM abos.permission_catalogue), 'FINANCE', 'ACTIVE',
       item.independent, false, item.sort_order
  FROM (VALUES
    ('finance.temporary-funding.read',           false, 530),
    ('finance.temporary-funding.create',         false, 540),
    ('finance.temporary-funding.approve',        true,  550),
    ('finance.temporary-funding.settle',         false, 560),
    ('finance.temporary-funding.settle-approve', true,  570),
    ('finance.temporary-funding.reverse',        true,  580),
    ('finance.temporary-funding.configure',      false, 590)
  ) AS item(code, independent, sort_order);

ALTER TABLE abos.finance_workflow_types
  DROP CONSTRAINT finance_workflow_types_workflow_type_check,
  ADD CONSTRAINT finance_workflow_types_workflow_type_check CHECK (workflow_type IN (
    'SHAREHOLDER_CAPITAL_RECEIPT', 'CUSTOMER_RECEIPT', 'OTHER_INCOME', 'EXPENSE',
    'SUPPLIER_PAYMENT', 'SALARY_PAYMENT', 'TREASURY_TRANSFER', 'TEMPORARY_FUNDING'));
INSERT INTO abos.finance_workflow_types (workflow_type, label_en, label_fa, sort_order)
VALUES ('TEMPORARY_FUNDING', 'Temporary funding', 'تمویل موقت', 80);

-- ---------------------------------------------------------------------------------------------------
-- 2. Funding-specific immutable payable mapping (append-only versions)
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE abos.temporary_funding_account_mapping_versions (
  id uuid PRIMARY KEY,
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  version integer NOT NULL CHECK (version > 0),
  payable_ledger_account_id uuid NOT NULL,
  configured_by_user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  configured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  change_reason text NOT NULL CHECK (length(btrim(change_reason)) BETWEEN 5 AND 500),
  UNIQUE (id, legal_entity_id),
  UNIQUE (legal_entity_id, version),
  FOREIGN KEY (payable_ledger_account_id, legal_entity_id)
    REFERENCES abos.ledger_accounts(id, legal_entity_id)
);
CREATE INDEX temporary_funding_mapping_current_idx
  ON abos.temporary_funding_account_mapping_versions (legal_entity_id, version DESC);

CREATE FUNCTION abos.guard_temporary_funding_mapping()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $guard$
DECLARE ledger record; entity_base text; latest integer;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'temporary funding mapping versions are immutable' USING ERRCODE = 'check_violation';
  END IF;
  SELECT COALESCE(max(version), 0) INTO latest FROM abos.temporary_funding_account_mapping_versions
   WHERE legal_entity_id = NEW.legal_entity_id;
  IF NEW.version <> latest + 1 THEN
    RAISE EXCEPTION 'a mapping version must follow the latest version' USING ERRCODE = 'check_violation';
  END IF;
  SELECT base_currency_code INTO entity_base FROM abos.legal_entities
   WHERE id = NEW.legal_entity_id AND currency_policy_status = 'APPROVED';
  SELECT account_type, control_account_type, status, posting_allowed, account_currency_code,
         requires_project, requires_department, requires_cost_center
    INTO ledger FROM abos.ledger_accounts
   WHERE id = NEW.payable_ledger_account_id AND legal_entity_id = NEW.legal_entity_id;
  IF NOT FOUND OR entity_base IS NULL
     OR ledger.account_type <> 'LIABILITY' OR ledger.status <> 'ACTIVE' OR NOT ledger.posting_allowed
     OR (ledger.control_account_type IS NOT NULL AND ledger.control_account_type <> 'OTHER')
     OR (ledger.account_currency_code IS NOT NULL AND ledger.account_currency_code <> entity_base)
     OR ledger.requires_project OR ledger.requires_department OR ledger.requires_cost_center THEN
    RAISE EXCEPTION 'the temporary funding payable must be an ACTIVE posting LIABILITY account in the base currency, without a reserved control type or required dimensions'
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.configured_at := clock_timestamp();
  RETURN NEW;
END
$guard$;
CREATE TRIGGER temporary_funding_mapping_guard
BEFORE INSERT OR UPDATE OR DELETE ON abos.temporary_funding_account_mapping_versions
FOR EACH ROW EXECUTE FUNCTION abos.guard_temporary_funding_mapping();
CREATE TRIGGER temporary_funding_mapping_ledger_reference
AFTER INSERT ON abos.temporary_funding_account_mapping_versions
FOR EACH ROW EXECUTE FUNCTION abos.ledger_account_mark_referenced('payable_ledger_account_id');

-- ---------------------------------------------------------------------------------------------------
-- 3. Staged Safe guard: approved opening positions (inert until a row exists)
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE abos.operational_treasury_cash_controls (
  id uuid PRIMARY KEY,
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  operational_treasury_account_id uuid NOT NULL,
  opening_amount numeric NOT NULL CHECK (opening_amount >= 0 AND opening_amount < 'Infinity'::numeric),
  opening_as_of date NOT NULL,
  evidence_reference_id uuid NOT NULL,
  recorded_by_user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  approved_by_user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  approved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (operational_treasury_account_id),
  UNIQUE (id, legal_entity_id),
  FOREIGN KEY (operational_treasury_account_id, legal_entity_id)
    REFERENCES abos.operational_treasury_accounts(id, legal_entity_id),
  FOREIGN KEY (evidence_reference_id, legal_entity_id)
    REFERENCES abos.evidence_references(id, legal_entity_id),
  CHECK (recorded_by_user_account_id <> approved_by_user_account_id)
);
CREATE TRIGGER operational_treasury_cash_controls_no_update_or_delete
BEFORE UPDATE OR DELETE ON abos.operational_treasury_cash_controls
FOR EACH ROW EXECUTE FUNCTION abos.prevent_audit_mutation();

-- Recorded cash of one operational Treasury account = approved opening + every POSTED Operational V1
-- Treasury movement dated after the opening. NULL when the account has no approved opening control.
CREATE FUNCTION abos.operational_treasury_recorded_cash(p_entity uuid, p_account uuid)
RETURNS numeric
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $cash$
  SELECT control.opening_amount + COALESCE((
    SELECT sum(entry.original_amount)
      FROM abos.subledger_entries entry
      JOIN abos.journal_lines line ON line.id = entry.journal_line_id
      JOIN abos.journals journal ON journal.id = line.journal_id
     WHERE entry.legal_entity_id = p_entity
       AND entry.subledger_type = 'OPERATIONAL_TREASURY'
       AND entry.operational_treasury_account_id = p_account
       AND journal.status = 'POSTED'
       AND journal.accounting_effective_date > control.opening_as_of), 0)
    FROM abos.operational_treasury_cash_controls control
   WHERE control.legal_entity_id = p_entity AND control.operational_treasury_account_id = p_account
$cash$;

-- Serializes every outflow from one account and refuses one that would make recorded cash negative.
-- Without an approved opening control the account is not yet enforced (stage 1) and nothing changes.
CREATE FUNCTION abos.operational_treasury_cash_guard(
  p_entity uuid, p_account uuid, p_outflow numeric, p_business_date date
) RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $guard$
DECLARE control abos.operational_treasury_cash_controls%ROWTYPE; available numeric;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('abos-operational-treasury-cash:' || p_account::text, 0));
  SELECT * INTO control FROM abos.operational_treasury_cash_controls
   WHERE legal_entity_id = p_entity AND operational_treasury_account_id = p_account;
  IF NOT FOUND THEN RETURN; END IF;
  IF p_business_date <= control.opening_as_of THEN
    RAISE EXCEPTION 'a Treasury movement cannot be dated on or before the approved opening date'
      USING ERRCODE = 'check_violation';
  END IF;
  available := abos.operational_treasury_recorded_cash(p_entity, p_account);
  IF available - p_outflow < 0 THEN
    RAISE EXCEPTION 'insufficient recorded cash in this Treasury account: available %, required %',
      available::text, p_outflow::text USING ERRCODE = 'check_violation';
  END IF;
END
$guard$;

-- ---------------------------------------------------------------------------------------------------
-- 4. Temporary funding source, decisions, settlements and reversals
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE abos.temporary_fundings (
  id uuid PRIMARY KEY,
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  funding_mode text NOT NULL CHECK (funding_mode IN ('PROVIDER_PAID_EXPENSE', 'PROVIDER_FUNDED_SAFE')),
  provider_kind text NOT NULL
    CHECK (provider_kind IN ('SHAREHOLDER', 'EMPLOYEE_OFFICER', 'OTHER_PERSON', 'ORGANIZATION')),
  provider_business_party_id uuid NOT NULL,
  provider_user_account_id uuid REFERENCES abos.user_accounts(id),
  operational_expense_category_id uuid,
  payee_business_party_id uuid,
  project_id uuid,
  department_id uuid,
  cost_center_id uuid,
  operational_treasury_account_id uuid,
  reference text NOT NULL CHECK (length(btrim(reference)) BETWEEN 1 AND 120),
  description text NOT NULL CHECK (length(btrim(description)) BETWEEN 3 AND 500),
  note text CHECK (note IS NULL OR length(btrim(note)) BETWEEN 1 AND 1000),
  business_date date NOT NULL,
  original_amount numeric NOT NULL CHECK (original_amount > 0 AND original_amount < 'Infinity'::numeric),
  original_currency_code text NOT NULL REFERENCES abos.currencies(code),
  base_amount numeric NOT NULL CHECK (base_amount > 0 AND base_amount < 'Infinity'::numeric),
  base_currency_code text NOT NULL REFERENCES abos.currencies(code),
  workflow_policy_version_id uuid NOT NULL,
  mapping_version_id uuid NOT NULL,
  correlation_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 8 AND 200),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('PENDING_APPROVAL', 'REJECTED', 'CANCELLED', 'POSTED', 'REVERSED')),
  status_reason text CHECK (status_reason IS NULL OR length(btrim(status_reason)) BETWEEN 5 AND 500),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  journal_id uuid,
  created_by_user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, legal_entity_id),
  UNIQUE (legal_entity_id, idempotency_key),
  FOREIGN KEY (provider_business_party_id, legal_entity_id) REFERENCES abos.business_parties(id, legal_entity_id),
  FOREIGN KEY (payee_business_party_id, legal_entity_id) REFERENCES abos.business_parties(id, legal_entity_id),
  FOREIGN KEY (operational_expense_category_id, legal_entity_id)
    REFERENCES abos.operational_expense_categories(id, legal_entity_id),
  FOREIGN KEY (operational_treasury_account_id, legal_entity_id)
    REFERENCES abos.operational_treasury_accounts(id, legal_entity_id),
  FOREIGN KEY (project_id, legal_entity_id) REFERENCES abos.projects(id, legal_entity_id),
  FOREIGN KEY (department_id, legal_entity_id) REFERENCES abos.departments(id, legal_entity_id),
  FOREIGN KEY (cost_center_id, legal_entity_id) REFERENCES abos.cost_centers(id, legal_entity_id),
  FOREIGN KEY (workflow_policy_version_id, legal_entity_id)
    REFERENCES abos.finance_workflow_policy_versions(id, legal_entity_id),
  FOREIGN KEY (mapping_version_id, legal_entity_id)
    REFERENCES abos.temporary_funding_account_mapping_versions(id, legal_entity_id),
  FOREIGN KEY (journal_id, legal_entity_id) REFERENCES abos.journals(id, legal_entity_id),
  -- First activation is same-currency only: no FX snapshot, no revaluation policy exists yet.
  CHECK (original_currency_code = base_currency_code AND original_amount = base_amount),
  CHECK ((funding_mode = 'PROVIDER_PAID_EXPENSE') = (operational_expense_category_id IS NOT NULL)),
  CHECK ((funding_mode = 'PROVIDER_FUNDED_SAFE') = (operational_treasury_account_id IS NOT NULL)),
  CHECK (funding_mode = 'PROVIDER_PAID_EXPENSE'
         OR (payee_business_party_id IS NULL AND project_id IS NULL
             AND department_id IS NULL AND cost_center_id IS NULL)),
  CHECK (provider_user_account_id IS NULL OR provider_kind = 'EMPLOYEE_OFFICER'),
  CHECK ((status IN ('POSTED', 'REVERSED')) = (journal_id IS NOT NULL)),
  CHECK ((status IN ('REJECTED', 'CANCELLED')) = (status_reason IS NOT NULL))
);
CREATE INDEX temporary_fundings_entity_date_idx
  ON abos.temporary_fundings (legal_entity_id, business_date DESC, created_at DESC);
CREATE INDEX temporary_fundings_provider_idx
  ON abos.temporary_fundings (legal_entity_id, provider_business_party_id, status);
CREATE INDEX temporary_fundings_pending_idx
  ON abos.temporary_fundings (legal_entity_id, status) WHERE status = 'PENDING_APPROVAL';

CREATE FUNCTION abos.guard_temporary_funding()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $guard$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'temporary funding records are permanent' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'PENDING_APPROVAL' OR NEW.version <> 1 OR NEW.journal_id IS NOT NULL THEN
      RAISE EXCEPTION 'temporary funding starts as PENDING_APPROVAL version 1 without a journal'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status IN ('REJECTED', 'CANCELLED', 'REVERSED') THEN
    RAISE EXCEPTION 'a % temporary funding is final', lower(OLD.status) USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.id, NEW.legal_entity_id, NEW.funding_mode, NEW.provider_kind, NEW.provider_business_party_id,
      NEW.provider_user_account_id, NEW.operational_expense_category_id, NEW.payee_business_party_id,
      NEW.project_id, NEW.department_id, NEW.cost_center_id, NEW.operational_treasury_account_id,
      NEW.reference, NEW.description, NEW.note, NEW.business_date, NEW.original_amount,
      NEW.original_currency_code, NEW.base_amount, NEW.base_currency_code, NEW.workflow_policy_version_id,
      NEW.mapping_version_id, NEW.correlation_id, NEW.idempotency_key, NEW.request_fingerprint,
      NEW.created_by_user_account_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.legal_entity_id, OLD.funding_mode, OLD.provider_kind, OLD.provider_business_party_id,
      OLD.provider_user_account_id, OLD.operational_expense_category_id, OLD.payee_business_party_id,
      OLD.project_id, OLD.department_id, OLD.cost_center_id, OLD.operational_treasury_account_id,
      OLD.reference, OLD.description, OLD.note, OLD.business_date, OLD.original_amount,
      OLD.original_currency_code, OLD.base_amount, OLD.base_currency_code, OLD.workflow_policy_version_id,
      OLD.mapping_version_id, OLD.correlation_id, OLD.idempotency_key, OLD.request_fingerprint,
      OLD.created_by_user_account_id, OLD.created_at) THEN
    RAISE EXCEPTION 'the accounting identity of a temporary funding cannot change' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.journal_id IS NOT NULL AND NEW.journal_id IS DISTINCT FROM OLD.journal_id THEN
    RAISE EXCEPTION 'the temporary funding journal is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.version <> OLD.version + 1 OR NEW.updated_at <= OLD.updated_at THEN
    RAISE EXCEPTION 'a funding transition must advance its version and update time' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT ((OLD.status = 'PENDING_APPROVAL' AND NEW.status IN ('REJECTED', 'CANCELLED', 'POSTED'))
       OR (OLD.status = 'POSTED' AND NEW.status = 'REVERSED')) THEN
    RAISE EXCEPTION 'invalid temporary funding transition % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER temporary_fundings_guard
BEFORE INSERT OR UPDATE OR DELETE ON abos.temporary_fundings
FOR EACH ROW EXECUTE FUNCTION abos.guard_temporary_funding();

CREATE TABLE abos.temporary_funding_decisions (
  id uuid PRIMARY KEY,
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  temporary_funding_id uuid NOT NULL,
  decision text NOT NULL CHECK (decision IN ('APPROVED', 'REJECTED')),
  decision_note text NOT NULL CHECK (length(btrim(decision_note)) BETWEEN 5 AND 500),
  decided_by_user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  decided_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (temporary_funding_id),
  UNIQUE (id, legal_entity_id),
  FOREIGN KEY (temporary_funding_id, legal_entity_id) REFERENCES abos.temporary_fundings(id, legal_entity_id)
);

CREATE FUNCTION abos.guard_temporary_funding_decision()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $guard$
DECLARE source_row record;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'temporary funding decisions are immutable' USING ERRCODE = 'check_violation';
  END IF;
  SELECT status, created_by_user_account_id, provider_user_account_id INTO source_row
    FROM abos.temporary_fundings WHERE id = NEW.temporary_funding_id AND legal_entity_id = NEW.legal_entity_id;
  IF NOT FOUND OR source_row.status <> 'PENDING_APPROVAL' THEN
    RAISE EXCEPTION 'only a pending temporary funding can be decided' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.decided_by_user_account_id = source_row.created_by_user_account_id
     OR NEW.decided_by_user_account_id IS NOT DISTINCT FROM source_row.provider_user_account_id THEN
    RAISE EXCEPTION 'the creator or the funding provider cannot decide the same temporary funding'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.decided_at := clock_timestamp();
  RETURN NEW;
END
$guard$;
CREATE TRIGGER temporary_funding_decisions_guard
BEFORE INSERT OR UPDATE OR DELETE ON abos.temporary_funding_decisions
FOR EACH ROW EXECUTE FUNCTION abos.guard_temporary_funding_decision();

CREATE TABLE abos.temporary_funding_settlements (
  id uuid PRIMARY KEY,
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  temporary_funding_id uuid NOT NULL,
  operational_treasury_account_id uuid NOT NULL,
  reference text NOT NULL CHECK (length(btrim(reference)) BETWEEN 1 AND 120),
  note text CHECK (note IS NULL OR length(btrim(note)) BETWEEN 1 AND 1000),
  business_date date NOT NULL,
  original_amount numeric NOT NULL CHECK (original_amount > 0 AND original_amount < 'Infinity'::numeric),
  original_currency_code text NOT NULL REFERENCES abos.currencies(code),
  base_amount numeric NOT NULL CHECK (base_amount > 0 AND base_amount < 'Infinity'::numeric),
  base_currency_code text NOT NULL REFERENCES abos.currencies(code),
  workflow_policy_version_id uuid NOT NULL,
  correlation_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 8 AND 200),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('PENDING_APPROVAL', 'REJECTED', 'CANCELLED', 'POSTED')),
  status_reason text CHECK (status_reason IS NULL OR length(btrim(status_reason)) BETWEEN 5 AND 500),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  journal_id uuid,
  created_by_user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, legal_entity_id),
  UNIQUE (legal_entity_id, idempotency_key),
  FOREIGN KEY (temporary_funding_id, legal_entity_id) REFERENCES abos.temporary_fundings(id, legal_entity_id),
  FOREIGN KEY (operational_treasury_account_id, legal_entity_id)
    REFERENCES abos.operational_treasury_accounts(id, legal_entity_id),
  FOREIGN KEY (workflow_policy_version_id, legal_entity_id)
    REFERENCES abos.finance_workflow_policy_versions(id, legal_entity_id),
  FOREIGN KEY (journal_id, legal_entity_id) REFERENCES abos.journals(id, legal_entity_id),
  CHECK (original_currency_code = base_currency_code AND original_amount = base_amount),
  CHECK ((status = 'POSTED') = (journal_id IS NOT NULL)),
  CHECK ((status IN ('REJECTED', 'CANCELLED')) = (status_reason IS NOT NULL))
);
CREATE INDEX temporary_funding_settlements_funding_idx
  ON abos.temporary_funding_settlements (legal_entity_id, temporary_funding_id, status);

CREATE FUNCTION abos.guard_temporary_funding_settlement()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $guard$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'temporary funding settlements are permanent' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'PENDING_APPROVAL' OR NEW.version <> 1 OR NEW.journal_id IS NOT NULL THEN
      RAISE EXCEPTION 'a settlement starts as PENDING_APPROVAL version 1 without a journal'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'PENDING_APPROVAL' THEN
    RAISE EXCEPTION 'a % settlement is final', lower(OLD.status) USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.id, NEW.legal_entity_id, NEW.temporary_funding_id, NEW.operational_treasury_account_id,
      NEW.reference, NEW.note, NEW.business_date, NEW.original_amount, NEW.original_currency_code,
      NEW.base_amount, NEW.base_currency_code, NEW.workflow_policy_version_id, NEW.correlation_id,
      NEW.idempotency_key, NEW.request_fingerprint, NEW.created_by_user_account_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.legal_entity_id, OLD.temporary_funding_id, OLD.operational_treasury_account_id,
      OLD.reference, OLD.note, OLD.business_date, OLD.original_amount, OLD.original_currency_code,
      OLD.base_amount, OLD.base_currency_code, OLD.workflow_policy_version_id, OLD.correlation_id,
      OLD.idempotency_key, OLD.request_fingerprint, OLD.created_by_user_account_id, OLD.created_at) THEN
    RAISE EXCEPTION 'the accounting identity of a settlement cannot change' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.version <> OLD.version + 1 OR NEW.updated_at <= OLD.updated_at
     OR NEW.status NOT IN ('REJECTED', 'CANCELLED', 'POSTED') THEN
    RAISE EXCEPTION 'invalid settlement transition % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER temporary_funding_settlements_guard
BEFORE INSERT OR UPDATE OR DELETE ON abos.temporary_funding_settlements
FOR EACH ROW EXECUTE FUNCTION abos.guard_temporary_funding_settlement();

CREATE TABLE abos.temporary_funding_settlement_decisions (
  id uuid PRIMARY KEY,
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  settlement_id uuid NOT NULL,
  decision text NOT NULL CHECK (decision IN ('APPROVED', 'REJECTED')),
  decision_note text NOT NULL CHECK (length(btrim(decision_note)) BETWEEN 5 AND 500),
  decided_by_user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  decided_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (settlement_id),
  UNIQUE (id, legal_entity_id),
  FOREIGN KEY (settlement_id, legal_entity_id)
    REFERENCES abos.temporary_funding_settlements(id, legal_entity_id)
);

CREATE FUNCTION abos.guard_temporary_funding_settlement_decision()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $guard$
DECLARE source_row record;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'settlement decisions are immutable' USING ERRCODE = 'check_violation';
  END IF;
  SELECT settlement.status, settlement.created_by_user_account_id, funding.provider_user_account_id
    INTO source_row
    FROM abos.temporary_funding_settlements settlement
    JOIN abos.temporary_fundings funding ON funding.id = settlement.temporary_funding_id
   WHERE settlement.id = NEW.settlement_id AND settlement.legal_entity_id = NEW.legal_entity_id;
  IF NOT FOUND OR source_row.status <> 'PENDING_APPROVAL' THEN
    RAISE EXCEPTION 'only a pending settlement can be decided' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.decided_by_user_account_id = source_row.created_by_user_account_id
     OR NEW.decided_by_user_account_id IS NOT DISTINCT FROM source_row.provider_user_account_id THEN
    RAISE EXCEPTION 'the settlement creator or the funding provider cannot decide the same settlement'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.decided_at := clock_timestamp();
  RETURN NEW;
END
$guard$;
CREATE TRIGGER temporary_funding_settlement_decisions_guard
BEFORE INSERT OR UPDATE OR DELETE ON abos.temporary_funding_settlement_decisions
FOR EACH ROW EXECUTE FUNCTION abos.guard_temporary_funding_settlement_decision();

CREATE TABLE abos.temporary_funding_reversals (
  id uuid PRIMARY KEY,
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  temporary_funding_id uuid NOT NULL,
  original_journal_id uuid NOT NULL,
  reversal_date date NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 5 AND 1000),
  correlation_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 8 AND 200),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('REQUESTED', 'REJECTED', 'POSTED')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  requested_by_user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  decided_by_user_account_id uuid REFERENCES abos.user_accounts(id),
  decided_at timestamptz,
  decision_note text CHECK (decision_note IS NULL OR length(btrim(decision_note)) BETWEEN 5 AND 500),
  reversal_journal_id uuid,
  evidence_reference_id uuid,
  UNIQUE (id, legal_entity_id),
  UNIQUE (legal_entity_id, idempotency_key),
  FOREIGN KEY (temporary_funding_id, legal_entity_id) REFERENCES abos.temporary_fundings(id, legal_entity_id),
  FOREIGN KEY (original_journal_id, legal_entity_id) REFERENCES abos.journals(id, legal_entity_id),
  FOREIGN KEY (reversal_journal_id, legal_entity_id) REFERENCES abos.journals(id, legal_entity_id),
  FOREIGN KEY (evidence_reference_id, legal_entity_id) REFERENCES abos.evidence_references(id, legal_entity_id),
  CHECK ((status = 'REQUESTED') = (decided_by_user_account_id IS NULL)),
  CHECK ((decided_by_user_account_id IS NULL) = (decided_at IS NULL)),
  CHECK ((decided_by_user_account_id IS NULL) = (decision_note IS NULL)),
  CHECK ((status = 'POSTED') = (reversal_journal_id IS NOT NULL)),
  CHECK ((status = 'POSTED') = (evidence_reference_id IS NOT NULL)),
  CHECK (decided_by_user_account_id IS NULL OR decided_by_user_account_id <> requested_by_user_account_id)
);
CREATE UNIQUE INDEX temporary_funding_reversals_one_open_uq
  ON abos.temporary_funding_reversals (temporary_funding_id) WHERE status IN ('REQUESTED', 'POSTED');

CREATE FUNCTION abos.guard_temporary_funding_reversal()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $guard$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'temporary funding reversals are permanent' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'REQUESTED' OR NEW.version <> 1 THEN
      RAISE EXCEPTION 'a reversal starts as REQUESTED version 1' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'REQUESTED' THEN
    RAISE EXCEPTION 'a % reversal is final', lower(OLD.status) USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.id, NEW.legal_entity_id, NEW.temporary_funding_id, NEW.original_journal_id, NEW.reversal_date,
      NEW.reason, NEW.correlation_id, NEW.idempotency_key, NEW.request_fingerprint,
      NEW.requested_by_user_account_id, NEW.requested_at)
     IS DISTINCT FROM
     (OLD.id, OLD.legal_entity_id, OLD.temporary_funding_id, OLD.original_journal_id, OLD.reversal_date,
      OLD.reason, OLD.correlation_id, OLD.idempotency_key, OLD.request_fingerprint,
      OLD.requested_by_user_account_id, OLD.requested_at)
     OR NEW.version <> OLD.version + 1 OR NEW.status NOT IN ('REJECTED', 'POSTED') THEN
    RAISE EXCEPTION 'invalid temporary funding reversal transition' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER temporary_funding_reversals_guard
BEFORE INSERT OR UPDATE OR DELETE ON abos.temporary_funding_reversals
FOR EACH ROW EXECUTE FUNCTION abos.guard_temporary_funding_reversal();

-- ---------------------------------------------------------------------------------------------------
-- 5. Narrow typed extensions of the shared financial tables
-- ---------------------------------------------------------------------------------------------------
-- Shared coordination column (Shareholder-Finance manifest section 5): the exact approval-policy
-- version an intent was routed under. Same name and semantics in both lanes; created once.
ALTER TABLE abos.posting_intents
  ADD COLUMN IF NOT EXISTS finance_workflow_policy_version_id uuid;
DO $fk$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                  WHERE conname = 'posting_intents_finance_workflow_policy_version_fk') THEN
    ALTER TABLE abos.posting_intents
      ADD CONSTRAINT posting_intents_finance_workflow_policy_version_fk
      FOREIGN KEY (finance_workflow_policy_version_id, legal_entity_id)
      REFERENCES abos.finance_workflow_policy_versions(id, legal_entity_id);
  END IF;
END
$fk$;

ALTER TABLE abos.posting_intents
  ADD COLUMN temporary_funding_id uuid,
  ADD COLUMN temporary_funding_settlement_id uuid,
  ADD COLUMN temporary_funding_reversal_id uuid,
  ADD COLUMN temporary_funding_mapping_version_id uuid,
  ADD CONSTRAINT posting_intents_temporary_funding_fk
    FOREIGN KEY (temporary_funding_id, legal_entity_id) REFERENCES abos.temporary_fundings(id, legal_entity_id),
  ADD CONSTRAINT posting_intents_temporary_funding_settlement_fk
    FOREIGN KEY (temporary_funding_settlement_id, legal_entity_id)
    REFERENCES abos.temporary_funding_settlements(id, legal_entity_id),
  ADD CONSTRAINT posting_intents_temporary_funding_reversal_fk
    FOREIGN KEY (temporary_funding_reversal_id, legal_entity_id)
    REFERENCES abos.temporary_funding_reversals(id, legal_entity_id),
  ADD CONSTRAINT posting_intents_temporary_funding_mapping_fk
    FOREIGN KEY (temporary_funding_mapping_version_id, legal_entity_id)
    REFERENCES abos.temporary_funding_account_mapping_versions(id, legal_entity_id),
  DROP CONSTRAINT posting_intents_intent_kind_check,
  ADD CONSTRAINT posting_intents_intent_kind_check CHECK (intent_kind IN (
    'SHAREHOLDER_CAPITAL_RECEIPT', 'SHAREHOLDER_LOAN_RECEIPT', 'REVERSAL', 'EXPENSE',
    'TEMPORARY_FUNDING', 'TEMPORARY_FUNDING_SETTLEMENT')),
  -- Typed, model-aware source branches. Legacy capital and Operational V1 expense checks are untouched.
  ADD CONSTRAINT posting_intents_temporary_funding_source CHECK (
    ((processing_model = 'OPERATIONAL_V1' AND intent_kind = 'TEMPORARY_FUNDING') = (temporary_funding_id IS NOT NULL))
    AND (temporary_funding_id IS NULL OR (temporary_funding_id = source_id
         AND source_type = 'TEMPORARY_FUNDING'
         AND finance_workflow_policy_version_id IS NOT NULL
         AND temporary_funding_mapping_version_id IS NOT NULL))),
  ADD CONSTRAINT posting_intents_temporary_funding_settlement_source CHECK (
    ((processing_model = 'OPERATIONAL_V1' AND intent_kind = 'TEMPORARY_FUNDING_SETTLEMENT')
       = (temporary_funding_settlement_id IS NOT NULL))
    AND (temporary_funding_settlement_id IS NULL OR (temporary_funding_settlement_id = source_id
         AND source_type = 'TEMPORARY_FUNDING_SETTLEMENT'
         AND finance_workflow_policy_version_id IS NOT NULL
         AND temporary_funding_mapping_version_id IS NOT NULL))),
  ADD CONSTRAINT posting_intents_temporary_funding_reversal_source CHECK (
    temporary_funding_reversal_id IS NULL
    OR (processing_model = 'OPERATIONAL_V1' AND intent_kind = 'REVERSAL'
        AND source_type = 'TEMPORARY_FUNDING_REVERSAL'));
CREATE UNIQUE INDEX posting_intents_one_per_temporary_funding_uq
  ON abos.posting_intents (legal_entity_id, temporary_funding_id) WHERE temporary_funding_id IS NOT NULL;
CREATE UNIQUE INDEX posting_intents_one_per_temporary_funding_settlement_uq
  ON abos.posting_intents (legal_entity_id, temporary_funding_settlement_id)
  WHERE temporary_funding_settlement_id IS NOT NULL;
CREATE UNIQUE INDEX posting_intents_one_per_temporary_funding_reversal_uq
  ON abos.posting_intents (legal_entity_id, temporary_funding_reversal_id)
  WHERE temporary_funding_reversal_id IS NOT NULL;

-- Provider subledger: a party-bearing liability subledger with exact funding lineage.
ALTER TABLE abos.subledger_entries
  ADD COLUMN temporary_funding_id uuid,
  ADD CONSTRAINT subledger_entries_temporary_funding_fk
    FOREIGN KEY (temporary_funding_id, legal_entity_id) REFERENCES abos.temporary_fundings(id, legal_entity_id),
  DROP CONSTRAINT subledger_entries_subledger_type_check,
  ADD CONSTRAINT subledger_entries_subledger_type_check CHECK (subledger_type IN (
    'SHAREHOLDER_CAPITAL', 'SHAREHOLDER_LOAN', 'CASH_LOCATION', 'OPERATIONAL_TREASURY',
    'TEMPORARY_FUNDING_PAYABLE')),
  DROP CONSTRAINT subledger_entries_check,
  ADD CONSTRAINT subledger_entries_check CHECK (
    (subledger_type IN ('SHAREHOLDER_CAPITAL', 'SHAREHOLDER_LOAN', 'TEMPORARY_FUNDING_PAYABLE'))
      = (business_party_id IS NOT NULL)),
  ADD CONSTRAINT subledger_entries_temporary_funding_check CHECK (
    (subledger_type = 'TEMPORARY_FUNDING_PAYABLE') = (temporary_funding_id IS NOT NULL));
CREATE INDEX subledger_entries_temporary_funding_idx
  ON abos.subledger_entries (legal_entity_id, business_party_id, temporary_funding_id)
  WHERE subledger_type = 'TEMPORARY_FUNDING_PAYABLE';

-- Reversals must keep the funding lineage of every payable subledger entry (like 0028 Treasury identity).
CREATE FUNCTION abos.validate_temporary_funding_reversal_link()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $validate$
BEGIN
  IF EXISTS (
    SELECT 1 FROM abos.journal_lines original_line
      JOIN abos.journal_lines reversal_line
        ON reversal_line.journal_id = NEW.reversal_journal_id AND reversal_line.line_number = original_line.line_number
      JOIN abos.subledger_entries original_entry ON original_entry.journal_line_id = original_line.id
      JOIN abos.subledger_entries reversal_entry
        ON reversal_entry.journal_line_id = reversal_line.id AND reversal_entry.subledger_type = original_entry.subledger_type
     WHERE original_line.journal_id = NEW.original_journal_id
       AND original_entry.temporary_funding_id IS DISTINCT FROM reversal_entry.temporary_funding_id
  ) THEN
    RAISE EXCEPTION 'reversal journal must preserve the temporary funding lineage' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$validate$;
CREATE TRIGGER journal_reversal_links_temporary_funding_guard
BEFORE INSERT ON abos.journal_reversal_links
FOR EACH ROW EXECUTE FUNCTION abos.validate_temporary_funding_reversal_link();

-- ---------------------------------------------------------------------------------------------------
-- 6. Funding journal validator and Operational V1 validator dispatch
-- ---------------------------------------------------------------------------------------------------
CREATE FUNCTION abos.validate_temporary_funding_journal(
  p_journal_id uuid, p_entity uuid, p_poster uuid, p_period uuid, p_date date, p_base text
) RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $validate$
DECLARE
  intent_row abos.posting_intents%ROWTYPE;
  funding abos.temporary_fundings%ROWTYPE;
  settlement abos.temporary_funding_settlements%ROWTYPE;
  reversal abos.temporary_funding_reversals%ROWTYPE;
  mapping abos.temporary_funding_account_mapping_versions%ROWTYPE;
  policy abos.finance_workflow_policy_versions%ROWTYPE;
  period_row record;
  entity_base text;
  debit_ledger uuid; credit_ledger uuid; debit_party uuid; credit_party uuid;
  treasury_ledger uuid; category_ledger uuid;
  amount numeric;
  line_count bigint; debit_total numeric; credit_total numeric;
  settled numeric;
BEGIN
  SELECT intent.* INTO intent_row FROM abos.posting_intents intent
    JOIN abos.journals journal ON journal.posting_intent_id = intent.id
   WHERE journal.id = p_journal_id AND intent.legal_entity_id = p_entity;
  IF NOT FOUND OR intent_row.processing_model <> 'OPERATIONAL_V1' OR intent_row.status <> 'POSTED'
     OR intent_row.base_currency_code IS DISTINCT FROM p_base OR intent_row.accounting_effective_date <> p_date THEN
    RAISE EXCEPTION 'temporary funding posting requires its posted Operational V1 intent' USING ERRCODE = 'check_violation';
  END IF;
  SELECT status, starts_on, ends_on INTO period_row FROM abos.accounting_periods
   WHERE id = p_period AND legal_entity_id = p_entity;
  IF NOT FOUND OR period_row.status <> 'OPEN' OR p_date NOT BETWEEN period_row.starts_on AND period_row.ends_on THEN
    RAISE EXCEPTION 'temporary funding posting requires an open accounting period covering its date'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT base_currency_code INTO entity_base FROM abos.legal_entities
   WHERE id = p_entity AND currency_policy_status = 'APPROVED';
  IF entity_base IS NULL OR entity_base <> p_base THEN
    RAISE EXCEPTION 'temporary funding posting requires the approved base currency' USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*), COALESCE(sum(base_debit), 0), COALESCE(sum(base_credit), 0)
    INTO line_count, debit_total, credit_total FROM abos.journal_lines WHERE journal_id = p_journal_id;
  IF line_count <> 2 OR debit_total <> credit_total OR debit_total <> intent_row.base_amount THEN
    RAISE EXCEPTION 'a temporary funding journal has exactly two lines balanced to its amount'
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM abos.journal_lines line
      JOIN abos.ledger_accounts ledger ON ledger.id = line.ledger_account_id AND ledger.legal_entity_id = line.legal_entity_id
     WHERE line.journal_id = p_journal_id AND (
       line.processing_model <> 'OPERATIONAL_V1' OR line.base_currency_code <> p_base
       OR line.original_amount <> intent_row.original_amount
       OR line.original_currency_code <> intent_row.original_currency_code
       OR line.conversion_snapshot_reference IS NOT NULL
       OR ledger.status <> 'ACTIVE' OR NOT ledger.posting_allowed
       OR (ledger.requires_project AND line.project_id IS NULL)
       OR (ledger.requires_department AND line.department_id IS NULL)
       OR (ledger.requires_cost_center AND line.cost_center_id IS NULL))) THEN
    RAISE EXCEPTION 'temporary funding journal line violates currency, account or dimension rules'
      USING ERRCODE = 'check_violation';
  END IF;

  IF intent_row.intent_kind = 'REVERSAL' THEN
    -- The exact mirror of every line and subledger entry is proven by journal_reversal_links guards in
    -- the same transaction (posted_reversal_requires_link is deferred to commit).
    SELECT * INTO reversal FROM abos.temporary_funding_reversals
     WHERE id = intent_row.temporary_funding_reversal_id AND legal_entity_id = p_entity;
    IF NOT FOUND OR reversal.status <> 'POSTED' OR reversal.reversal_journal_id <> p_journal_id
       OR reversal.decided_by_user_account_id <> p_poster
       OR intent_row.source_id <> reversal.original_journal_id OR reversal.reversal_date <> p_date THEN
      RAISE EXCEPTION 'temporary funding reversal journal does not match its decided reversal'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN;
  END IF;

  SELECT * INTO policy FROM abos.finance_workflow_policy_versions
   WHERE id = intent_row.finance_workflow_policy_version_id AND legal_entity_id = p_entity
     AND workflow_type = 'TEMPORARY_FUNDING';
  SELECT * INTO mapping FROM abos.temporary_funding_account_mapping_versions
   WHERE id = intent_row.temporary_funding_mapping_version_id AND legal_entity_id = p_entity;
  IF policy.id IS NULL OR NOT policy.approval_required OR mapping.id IS NULL THEN
    RAISE EXCEPTION 'temporary funding posting requires its approval-required policy and payable mapping'
      USING ERRCODE = 'check_violation';
  END IF;

  IF intent_row.intent_kind = 'TEMPORARY_FUNDING' THEN
    SELECT * INTO funding FROM abos.temporary_fundings WHERE id = intent_row.temporary_funding_id AND legal_entity_id = p_entity;
    IF NOT FOUND OR funding.status <> 'POSTED' OR funding.journal_id <> p_journal_id
       OR funding.base_amount <> intent_row.base_amount OR funding.business_date <> p_date
       OR funding.workflow_policy_version_id <> policy.id OR funding.mapping_version_id <> mapping.id THEN
      RAISE EXCEPTION 'temporary funding, intent and journal do not agree' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM abos.temporary_funding_decisions decision
                    WHERE decision.temporary_funding_id = funding.id AND decision.decision = 'APPROVED'
                      AND decision.decided_by_user_account_id = p_poster)
       OR p_poster = funding.created_by_user_account_id
       OR p_poster IS NOT DISTINCT FROM funding.provider_user_account_id THEN
      RAISE EXCEPTION 'temporary funding must be posted by its independent approver' USING ERRCODE = 'insufficient_privilege';
    END IF;
    amount := funding.base_amount;
    credit_ledger := mapping.payable_ledger_account_id; credit_party := funding.provider_business_party_id;
    IF funding.funding_mode = 'PROVIDER_PAID_EXPENSE' THEN
      SELECT ledger_account_id INTO category_ledger FROM abos.operational_expense_categories
       WHERE id = funding.operational_expense_category_id AND legal_entity_id = p_entity AND status = 'ACTIVE';
      debit_ledger := category_ledger; debit_party := funding.payee_business_party_id;
    ELSE
      SELECT ledger_account_id INTO treasury_ledger FROM abos.operational_treasury_accounts
       WHERE id = funding.operational_treasury_account_id AND legal_entity_id = p_entity AND status = 'ACTIVE'
         AND currency_code = funding.original_currency_code
         AND account_type IN ('SAFE', 'CASH_BOX', 'PETTY_CASH');
      debit_ledger := treasury_ledger; debit_party := NULL;
    END IF;
    IF debit_ledger IS NULL OR NOT EXISTS (
         SELECT 1 FROM abos.journal_lines line WHERE line.journal_id = p_journal_id AND line.line_number = 1
            AND line.ledger_account_id = debit_ledger AND line.base_debit = amount AND line.base_credit = 0
            AND line.business_party_id IS NOT DISTINCT FROM debit_party
            AND line.project_id IS NOT DISTINCT FROM funding.project_id
            AND line.department_id IS NOT DISTINCT FROM funding.department_id
            AND line.cost_center_id IS NOT DISTINCT FROM funding.cost_center_id
            AND line.source_type = 'TEMPORARY_FUNDING' AND line.source_id = funding.id)
       OR NOT EXISTS (
         SELECT 1 FROM abos.journal_lines line WHERE line.journal_id = p_journal_id AND line.line_number = 2
            AND line.ledger_account_id = credit_ledger AND line.base_debit = 0 AND line.base_credit = amount
            AND line.business_party_id = credit_party
            AND line.project_id IS NULL AND line.department_id IS NULL AND line.cost_center_id IS NULL
            AND line.source_type = 'TEMPORARY_FUNDING' AND line.source_id = funding.id) THEN
      RAISE EXCEPTION 'temporary funding journal must debit its expense or Safe and credit the provider payable'
        USING ERRCODE = 'check_violation';
    END IF;
    -- Subledgers: the provider payable (+) on line 2 always; a Treasury inflow (+) on line 1 only for the
    -- Safe mode. Direct-pay never touches physical Safe cash.
    IF (SELECT count(*) FROM abos.subledger_entries entry JOIN abos.journal_lines line ON line.id = entry.journal_line_id
         WHERE line.journal_id = p_journal_id) <> (CASE WHEN funding.funding_mode = 'PROVIDER_FUNDED_SAFE' THEN 2 ELSE 1 END)
       OR NOT EXISTS (
         SELECT 1 FROM abos.subledger_entries entry JOIN abos.journal_lines line ON line.id = entry.journal_line_id
          WHERE line.journal_id = p_journal_id AND line.line_number = 2
            AND entry.subledger_type = 'TEMPORARY_FUNDING_PAYABLE' AND entry.processing_model = 'OPERATIONAL_V1'
            AND entry.business_party_id = funding.provider_business_party_id AND entry.temporary_funding_id = funding.id
            AND entry.original_amount = funding.original_amount AND entry.base_amount = funding.base_amount
            AND entry.original_currency_code = funding.original_currency_code
            AND entry.source_type = 'TEMPORARY_FUNDING' AND entry.source_id = funding.id)
       OR (funding.funding_mode = 'PROVIDER_FUNDED_SAFE' AND NOT EXISTS (
         SELECT 1 FROM abos.subledger_entries entry JOIN abos.journal_lines line ON line.id = entry.journal_line_id
          WHERE line.journal_id = p_journal_id AND line.line_number = 1
            AND entry.subledger_type = 'OPERATIONAL_TREASURY' AND entry.processing_model = 'OPERATIONAL_V1'
            AND entry.operational_treasury_account_id = funding.operational_treasury_account_id
            AND entry.original_amount = funding.original_amount AND entry.base_amount = funding.base_amount
            AND entry.source_type = 'TEMPORARY_FUNDING' AND entry.source_id = funding.id)) THEN
      RAISE EXCEPTION 'temporary funding journal requires exactly its provider payable and Safe movements'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN;
  END IF;

  -- TEMPORARY_FUNDING_SETTLEMENT
  SELECT * INTO settlement FROM abos.temporary_funding_settlements
   WHERE id = intent_row.temporary_funding_settlement_id AND legal_entity_id = p_entity;
  SELECT * INTO funding FROM abos.temporary_fundings
   WHERE id = settlement.temporary_funding_id AND legal_entity_id = p_entity;
  IF settlement.id IS NULL OR funding.id IS NULL OR settlement.status <> 'POSTED'
     OR settlement.journal_id <> p_journal_id OR funding.status <> 'POSTED'
     OR settlement.base_amount <> intent_row.base_amount OR settlement.business_date <> p_date
     OR settlement.workflow_policy_version_id <> policy.id OR funding.mapping_version_id <> mapping.id THEN
    RAISE EXCEPTION 'settlement, funding, intent and journal do not agree' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM abos.temporary_funding_settlement_decisions decision
                  WHERE decision.settlement_id = settlement.id AND decision.decision = 'APPROVED'
                    AND decision.decided_by_user_account_id = p_poster)
     OR p_poster = settlement.created_by_user_account_id
     OR p_poster IS NOT DISTINCT FROM funding.provider_user_account_id THEN
    RAISE EXCEPTION 'a settlement must be posted by its independent approver' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT COALESCE(sum(other.base_amount), 0) INTO settled FROM abos.temporary_funding_settlements other
   WHERE other.temporary_funding_id = funding.id AND other.status = 'POSTED';
  IF settled > funding.base_amount THEN
    RAISE EXCEPTION 'settlements cannot exceed the funded amount' USING ERRCODE = 'check_violation';
  END IF;
  SELECT ledger_account_id INTO treasury_ledger FROM abos.operational_treasury_accounts
   WHERE id = settlement.operational_treasury_account_id AND legal_entity_id = p_entity AND status = 'ACTIVE'
     AND currency_code = settlement.original_currency_code;
  IF treasury_ledger IS NULL OR NOT EXISTS (
       SELECT 1 FROM abos.journal_lines line WHERE line.journal_id = p_journal_id AND line.line_number = 1
          AND line.ledger_account_id = mapping.payable_ledger_account_id
          AND line.base_debit = settlement.base_amount AND line.base_credit = 0
          AND line.business_party_id = funding.provider_business_party_id
          AND line.source_type = 'TEMPORARY_FUNDING_SETTLEMENT' AND line.source_id = settlement.id)
     OR NOT EXISTS (
       SELECT 1 FROM abos.journal_lines line WHERE line.journal_id = p_journal_id AND line.line_number = 2
          AND line.ledger_account_id = treasury_ledger AND line.base_debit = 0
          AND line.base_credit = settlement.base_amount AND line.business_party_id IS NULL
          AND line.source_type = 'TEMPORARY_FUNDING_SETTLEMENT' AND line.source_id = settlement.id) THEN
    RAISE EXCEPTION 'a settlement must debit the provider payable and credit its cash source'
      USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT count(*) FROM abos.subledger_entries entry JOIN abos.journal_lines line ON line.id = entry.journal_line_id
       WHERE line.journal_id = p_journal_id) <> 2
     OR NOT EXISTS (
       SELECT 1 FROM abos.subledger_entries entry JOIN abos.journal_lines line ON line.id = entry.journal_line_id
        WHERE line.journal_id = p_journal_id AND line.line_number = 1
          AND entry.subledger_type = 'TEMPORARY_FUNDING_PAYABLE'
          AND entry.business_party_id = funding.provider_business_party_id AND entry.temporary_funding_id = funding.id
          AND entry.original_amount = -settlement.original_amount AND entry.base_amount = -settlement.base_amount
          AND entry.source_type = 'TEMPORARY_FUNDING_SETTLEMENT' AND entry.source_id = settlement.id)
     OR NOT EXISTS (
       SELECT 1 FROM abos.subledger_entries entry JOIN abos.journal_lines line ON line.id = entry.journal_line_id
        WHERE line.journal_id = p_journal_id AND line.line_number = 2
          AND entry.subledger_type = 'OPERATIONAL_TREASURY'
          AND entry.operational_treasury_account_id = settlement.operational_treasury_account_id
          AND entry.original_amount = -settlement.original_amount AND entry.base_amount = -settlement.base_amount
          AND entry.source_type = 'TEMPORARY_FUNDING_SETTLEMENT' AND entry.source_id = settlement.id) THEN
    RAISE EXCEPTION 'a settlement journal requires exactly its payable decrease and cash outflow'
      USING ERRCODE = 'check_violation';
  END IF;
END
$validate$;

CREATE OR REPLACE FUNCTION abos.validate_operational_journal_posting()
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
  -- P2 dispatch: Temporary Funding journals (funding, settlement and their reversals) have their own
  -- typed validator. Every other OPERATIONAL_V1 journal continues through the unchanged 0028 body.
  SELECT * INTO intent_row FROM abos.posting_intents
   WHERE id = NEW.posting_intent_id AND legal_entity_id = NEW.legal_entity_id;
  IF FOUND AND (intent_row.intent_kind IN ('TEMPORARY_FUNDING', 'TEMPORARY_FUNDING_SETTLEMENT')
                OR intent_row.temporary_funding_reversal_id IS NOT NULL) THEN
    PERFORM abos.validate_temporary_funding_journal(NEW.id, NEW.legal_entity_id,
      NEW.posted_by_user_account_id, NEW.accounting_period_id, NEW.accounting_effective_date,
      NEW.base_currency_code);
    RETURN NEW;
  END IF;

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

-- ---------------------------------------------------------------------------------------------------
-- 7. Ordinary expenses keep their 0028 behaviour; the staged cash guard is added before posting.
--    With no approved cash control on the account the guard returns immediately (no change today).
-- ---------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION abos.operational_expense_post(p_expense_id uuid, p_actor_id uuid)
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
  -- P2 staged Safe guard: inert unless this Treasury account has an approved opening cash control.
  PERFORM abos.operational_treasury_cash_guard(
    expense.legal_entity_id, treasury.id, expense.original_amount, expense.business_date);
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

-- Temporary funding policy is never direct-posting: every funding event requires approval.
CREATE FUNCTION abos.guard_temporary_funding_policy()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $guard$
BEGIN
  IF NOT NEW.approval_required THEN
    RAISE EXCEPTION 'temporary funding always requires approval' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER finance_workflow_policy_temporary_funding_guard
BEFORE INSERT ON abos.finance_workflow_policy_versions
FOR EACH ROW WHEN (NEW.workflow_type = 'TEMPORARY_FUNDING')
EXECUTE FUNCTION abos.guard_temporary_funding_policy();

-- ---------------------------------------------------------------------------------------------------
-- 8. Internal helpers (executable by the Operational Finance owner only)
-- ---------------------------------------------------------------------------------------------------
CREATE FUNCTION abos.temporary_funding_actor(
  p_identity_proof text, p_runtime_token_sha256 text, p_token_sha256 text, p_any_of text[]
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $actor$
DECLARE v_context jsonb;
BEGIN
  v_context := abos.identity_actor_context(p_identity_proof, p_runtime_token_sha256, p_token_sha256);
  IF v_context IS NULL
     OR COALESCE((v_context ->> 'live')::boolean, false) IS NOT TRUE
     OR v_context ->> 'status' IS DISTINCT FROM 'ACTIVE'
     OR COALESCE((v_context ->> 'mustChangePassword')::boolean, false) IS TRUE THEN
    RAISE EXCEPTION 'sign in with an active account to continue' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT COALESCE(v_context -> 'permissions', '[]'::jsonb) ?| p_any_of THEN
    RAISE EXCEPTION 'current authority is missing %', array_to_string(p_any_of, ' or ')
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN v_context;
END
$actor$;

-- A plain positive decimal string (the contracts' pattern); never NaN, Infinity or exponents.
CREATE FUNCTION abos.temporary_funding_amount(p_text text)
RETURNS numeric LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $amount$
BEGIN
  IF p_text IS NULL OR length(p_text) > 40 OR p_text !~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$' OR p_text !~ '[1-9]' THEN
    RAISE EXCEPTION 'amounts must be plain positive decimals' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN p_text::numeric;
END
$amount$;

-- Returns the recorded response for an identical replay, NULL for a new request; refuses conflicts.
CREATE FUNCTION abos.temporary_funding_idempotency_begin(
  p_scope text, p_key text, p_fingerprint text, p_correlation_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $begin$
DECLARE v_record abos.idempotency_records%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_scope || ':' || p_key, 0));
  SELECT * INTO v_record FROM abos.idempotency_records WHERE scope = p_scope AND idempotency_key = p_key;
  IF FOUND THEN
    IF v_record.request_fingerprint <> p_fingerprint THEN
      RAISE EXCEPTION 'idempotency key was already used for different details' USING ERRCODE = 'unique_violation';
    END IF;
    IF v_record.status = 'COMPLETED' THEN
      RETURN v_record.response_snapshot || jsonb_build_object('replayed', true);
    END IF;
    RAISE EXCEPTION 'request with this idempotency key is still in progress' USING ERRCODE = 'serialization_failure';
  END IF;
  INSERT INTO abos.idempotency_records (scope, idempotency_key, request_fingerprint, correlation_id, status)
  VALUES (p_scope, p_key, p_fingerprint, p_correlation_id, 'IN_PROGRESS');
  RETURN NULL;
END
$begin$;

CREATE FUNCTION abos.temporary_funding_idempotency_complete(
  p_scope text, p_key text, p_resource_type text, p_resource_id uuid, p_response jsonb
) RETURNS void
LANGUAGE sql
SET search_path = pg_catalog, pg_temp
AS $complete$
  UPDATE abos.idempotency_records
     SET status = 'COMPLETED', resource_type = p_resource_type, resource_id = p_resource_id,
         response_code = 200, response_snapshot = p_response, completed_at = clock_timestamp()
   WHERE scope = p_scope AND idempotency_key = p_key;
$complete$;

CREATE FUNCTION abos.temporary_funding_audit(
  p_actor uuid, p_entity uuid, p_correlation uuid, p_action text, p_entity_type text, p_entity_id uuid,
  p_after jsonb
) RETURNS void
LANGUAGE sql
SET search_path = pg_catalog, pg_temp
AS $audit$
  INSERT INTO abos.audit_records
    (id, actor_user_account_id, legal_entity_id, correlation_id, action, entity_type, entity_id,
     after_state, metadata)
  VALUES (gen_random_uuid(), p_actor, p_entity, p_correlation, p_action, p_entity_type, p_entity_id,
          p_after, jsonb_build_object('source', 'v1-temporary-funding'));
$audit$;

-- The latest TEMPORARY_FUNDING policy version; it is always approval-required (guarded above).
CREATE FUNCTION abos.temporary_funding_policy_id(p_entity uuid)
RETURNS uuid
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, pg_temp
AS $policy$
DECLARE v_policy abos.finance_workflow_policy_versions%ROWTYPE;
BEGIN
  SELECT * INTO v_policy FROM abos.finance_workflow_policy_versions
   WHERE legal_entity_id = p_entity AND workflow_type = 'TEMPORARY_FUNDING'
   ORDER BY version DESC LIMIT 1;
  IF NOT FOUND OR NOT v_policy.approval_required THEN
    RAISE EXCEPTION 'the temporary funding approval policy is not configured for this legal entity'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN v_policy.id;
END
$policy$;

CREATE FUNCTION abos.temporary_funding_period_open(p_entity uuid, p_date date)
RETURNS uuid
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, pg_temp
AS $period$
DECLARE v_period uuid;
BEGIN
  SELECT period.id INTO v_period FROM abos.accounting_periods period
   WHERE period.legal_entity_id = p_entity AND period.status = 'OPEN'
     AND p_date BETWEEN period.starts_on AND period.ends_on;
  IF v_period IS NULL THEN
    RAISE EXCEPTION 'no open accounting period covers %', p_date USING ERRCODE = 'check_violation';
  END IF;
  RETURN v_period;
END
$period$;

CREATE FUNCTION abos.temporary_funding_settlement_json(p_settlement_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $json$
  SELECT jsonb_build_object(
    'id', settlement.id, 'temporaryFundingId', settlement.temporary_funding_id,
    'treasuryAccount', jsonb_build_object('id', treasury.id, 'nameEn', treasury.name_en,
      'nameFa', treasury.name_fa, 'accountType', treasury.account_type),
    'reference', settlement.reference, 'note', settlement.note, 'businessDate', settlement.business_date,
    'amount', settlement.original_amount::text, 'currencyCode', settlement.original_currency_code,
    'status', settlement.status, 'statusReason', settlement.status_reason, 'version', settlement.version,
    'journalId', settlement.journal_id, 'createdBy', creator.display_name,
    'createdByUserAccountId', settlement.created_by_user_account_id, 'createdAt', settlement.created_at,
    'decision', (SELECT jsonb_build_object('decision', decision.decision, 'note', decision.decision_note,
                   'decidedBy', decider.display_name, 'decidedAt', decision.decided_at)
                   FROM abos.temporary_funding_settlement_decisions decision
                   JOIN abos.user_accounts decider ON decider.id = decision.decided_by_user_account_id
                  WHERE decision.settlement_id = settlement.id))
  FROM abos.temporary_funding_settlements settlement
  JOIN abos.operational_treasury_accounts treasury ON treasury.id = settlement.operational_treasury_account_id
  JOIN abos.user_accounts creator ON creator.id = settlement.created_by_user_account_id
  WHERE settlement.id = p_settlement_id
$json$;

-- Lifecycle presented to people: PENDING_APPROVAL (submitted), REJECTED, CANCELLED, POSTED (approved and
-- posted atomically), PARTIALLY_SETTLED, SETTLED, REVERSED. Settlement progress is derived, never stored.
CREATE FUNCTION abos.temporary_funding_json(p_funding_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $json$
  SELECT jsonb_build_object(
    'id', funding.id, 'fundingMode', funding.funding_mode, 'providerKind', funding.provider_kind,
    'provider', jsonb_build_object('id', provider.id, 'name', provider.display_name),
    'providerUserAccountId', funding.provider_user_account_id,
    'expenseCategory', CASE WHEN category.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', category.id, 'code', category.category_code, 'nameEn', category.name_en, 'nameFa', category.name_fa) END,
    'payee', CASE WHEN payee.id IS NULL THEN NULL ELSE jsonb_build_object('id', payee.id, 'name', payee.display_name) END,
    'treasuryAccount', CASE WHEN treasury.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', treasury.id, 'nameEn', treasury.name_en, 'nameFa', treasury.name_fa, 'accountType', treasury.account_type) END,
    'projectId', funding.project_id, 'departmentId', funding.department_id, 'costCenterId', funding.cost_center_id,
    'reference', funding.reference, 'description', funding.description, 'note', funding.note,
    'businessDate', funding.business_date,
    'amount', funding.original_amount::text, 'currencyCode', funding.original_currency_code,
    'status', funding.status, 'statusReason', funding.status_reason, 'version', funding.version,
    'lifecycleStatus', CASE
      WHEN funding.status <> 'POSTED' THEN funding.status
      WHEN totals.settled = 0 THEN 'POSTED'
      WHEN totals.settled < funding.base_amount THEN 'PARTIALLY_SETTLED'
      ELSE 'SETTLED' END,
    'settledAmount', totals.settled::text,
    'pendingSettlementAmount', totals.pending::text,
    'outstandingAmount', CASE WHEN funding.status = 'POSTED'
      THEN (funding.base_amount - totals.settled)::text ELSE '0' END,
    'journalId', funding.journal_id, 'createdBy', creator.display_name,
    'createdByUserAccountId', funding.created_by_user_account_id,
    'createdAt', funding.created_at, 'updatedAt', funding.updated_at,
    'decision', (SELECT jsonb_build_object('decision', decision.decision, 'note', decision.decision_note,
                   'decidedBy', decider.display_name, 'decidedAt', decision.decided_at)
                   FROM abos.temporary_funding_decisions decision
                   JOIN abos.user_accounts decider ON decider.id = decision.decided_by_user_account_id
                  WHERE decision.temporary_funding_id = funding.id),
    'settlements', COALESCE((SELECT jsonb_agg(abos.temporary_funding_settlement_json(settlement.id)
                   ORDER BY settlement.business_date, settlement.created_at)
                   FROM abos.temporary_funding_settlements settlement
                  WHERE settlement.temporary_funding_id = funding.id), '[]'::jsonb),
    'reversal', (SELECT jsonb_build_object('id', reversal.id, 'status', reversal.status,
                   'version', reversal.version, 'reversalDate', reversal.reversal_date, 'reason', reversal.reason,
                   'requestedBy', requester.display_name,
                   'requestedByUserAccountId', reversal.requested_by_user_account_id,
                   'requestedAt', reversal.requested_at, 'decidedBy', decider.display_name,
                   'decidedAt', reversal.decided_at, 'decisionNote', reversal.decision_note,
                   'reversalJournalId', reversal.reversal_journal_id)
                   FROM abos.temporary_funding_reversals reversal
                   JOIN abos.user_accounts requester ON requester.id = reversal.requested_by_user_account_id
                   LEFT JOIN abos.user_accounts decider ON decider.id = reversal.decided_by_user_account_id
                  WHERE reversal.temporary_funding_id = funding.id
                  ORDER BY reversal.requested_at DESC LIMIT 1))
  FROM abos.temporary_fundings funding
  JOIN abos.business_parties provider ON provider.id = funding.provider_business_party_id
  JOIN abos.user_accounts creator ON creator.id = funding.created_by_user_account_id
  LEFT JOIN abos.operational_expense_categories category ON category.id = funding.operational_expense_category_id
  LEFT JOIN abos.business_parties payee ON payee.id = funding.payee_business_party_id
  LEFT JOIN abos.operational_treasury_accounts treasury ON treasury.id = funding.operational_treasury_account_id
  CROSS JOIN LATERAL (
    SELECT COALESCE(sum(settlement.base_amount) FILTER (WHERE settlement.status = 'POSTED'), 0) AS settled,
           COALESCE(sum(settlement.base_amount) FILTER (WHERE settlement.status = 'PENDING_APPROVAL'), 0) AS pending
      FROM abos.temporary_funding_settlements settlement
     WHERE settlement.temporary_funding_id = funding.id) totals
  WHERE funding.id = p_funding_id
$json$;

-- ---------------------------------------------------------------------------------------------------
-- 9. Internal posting helpers (one transaction each; the approver posts)
-- ---------------------------------------------------------------------------------------------------
CREATE FUNCTION abos.temporary_funding_post(p_funding_id uuid, p_actor_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $post$
DECLARE
  funding abos.temporary_fundings%ROWTYPE;
  mapping abos.temporary_funding_account_mapping_versions%ROWTYPE;
  v_debit_ledger uuid;
  v_debit_party uuid;
  v_period uuid;
  v_intent_id uuid := gen_random_uuid();
  v_journal_id uuid := gen_random_uuid();
  v_debit_line uuid := gen_random_uuid();
  v_credit_line uuid := gen_random_uuid();
BEGIN
  IF current_user <> 'abos_v1_operational_finance_owner' THEN
    RAISE EXCEPTION 'temporary funding posting helper is internal' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO funding FROM abos.temporary_fundings WHERE id = p_funding_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'temporary funding not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF funding.status = 'POSTED' THEN RETURN funding.journal_id; END IF;
  IF funding.status <> 'PENDING_APPROVAL' OR NOT EXISTS (
    SELECT 1 FROM abos.temporary_funding_decisions decision
     WHERE decision.temporary_funding_id = funding.id AND decision.decision = 'APPROVED'
       AND decision.decided_by_user_account_id = p_actor_id) THEN
    RAISE EXCEPTION 'temporary funding has no approval from the posting actor' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO mapping FROM abos.temporary_funding_account_mapping_versions
   WHERE id = funding.mapping_version_id AND legal_entity_id = funding.legal_entity_id;
  IF funding.funding_mode = 'PROVIDER_PAID_EXPENSE' THEN
    SELECT category.ledger_account_id INTO v_debit_ledger FROM abos.operational_expense_categories category
     WHERE category.id = funding.operational_expense_category_id
       AND category.legal_entity_id = funding.legal_entity_id AND category.status = 'ACTIVE';
    v_debit_party := funding.payee_business_party_id;
  ELSE
    SELECT treasury.ledger_account_id INTO v_debit_ledger FROM abos.operational_treasury_accounts treasury
     WHERE treasury.id = funding.operational_treasury_account_id
       AND treasury.legal_entity_id = funding.legal_entity_id AND treasury.status = 'ACTIVE'
       AND treasury.currency_code = funding.original_currency_code
       AND treasury.account_type IN ('SAFE', 'CASH_BOX', 'PETTY_CASH');
    v_debit_party := NULL;
    -- An inflow takes the same per-account lock and opening-date rule as every outflow.
    PERFORM abos.operational_treasury_cash_guard(
      funding.legal_entity_id, funding.operational_treasury_account_id, 0, funding.business_date);
  END IF;
  IF v_debit_ledger IS NULL OR mapping.id IS NULL THEN
    RAISE EXCEPTION 'the funding expense category or Safe and the payable mapping must remain active'
      USING ERRCODE = 'check_violation';
  END IF;
  v_period := abos.temporary_funding_period_open(funding.legal_entity_id, funding.business_date);

  INSERT INTO abos.posting_intents
    (id, legal_entity_id, project_id, department_id, cost_center_id, source_type, source_id, intent_kind,
     original_amount, original_currency_code, base_amount, base_currency_code, conversion_snapshot_reference,
     accounting_effective_date, correlation_id, idempotency_key, status, created_by_user_account_id,
     processing_model, temporary_funding_id, finance_workflow_policy_version_id,
     temporary_funding_mapping_version_id)
  VALUES
    (v_intent_id, funding.legal_entity_id, funding.project_id, funding.department_id, funding.cost_center_id,
     'TEMPORARY_FUNDING', funding.id, 'TEMPORARY_FUNDING', funding.original_amount,
     funding.original_currency_code, funding.base_amount, funding.base_currency_code, NULL,
     funding.business_date, funding.correlation_id, 'TFP:' || funding.idempotency_key, 'APPROVED',
     funding.created_by_user_account_id, 'OPERATIONAL_V1', funding.id, funding.workflow_policy_version_id,
     funding.mapping_version_id);
  INSERT INTO abos.journals
    (id, legal_entity_id, accounting_period_id, posting_intent_id, journal_reference, accounting_effective_date,
     base_currency_code, status, created_by_user_account_id, processing_model)
  VALUES
    (v_journal_id, funding.legal_entity_id, v_period, v_intent_id, 'TFP-' || v_journal_id::text,
     funding.business_date, funding.base_currency_code, 'DRAFT', funding.created_by_user_account_id,
     'OPERATIONAL_V1');
  INSERT INTO abos.journal_lines
    (id, journal_id, legal_entity_id, line_number, ledger_account_id, business_party_id, project_id,
     department_id, cost_center_id, original_amount, original_currency_code, base_debit, base_credit,
     base_currency_code, conversion_snapshot_reference, source_type, source_id, processing_model)
  VALUES
    (v_debit_line, v_journal_id, funding.legal_entity_id, 1, v_debit_ledger, v_debit_party,
     funding.project_id, funding.department_id, funding.cost_center_id, funding.original_amount,
     funding.original_currency_code, funding.base_amount, 0, funding.base_currency_code, NULL,
     'TEMPORARY_FUNDING', funding.id, 'OPERATIONAL_V1'),
    (v_credit_line, v_journal_id, funding.legal_entity_id, 2, mapping.payable_ledger_account_id,
     funding.provider_business_party_id, NULL, NULL, NULL, funding.original_amount,
     funding.original_currency_code, 0, funding.base_amount, funding.base_currency_code, NULL,
     'TEMPORARY_FUNDING', funding.id, 'OPERATIONAL_V1');
  INSERT INTO abos.subledger_entries
    (id, legal_entity_id, journal_line_id, subledger_type, business_party_id, temporary_funding_id,
     original_amount, original_currency_code, base_amount, base_currency_code, source_type, source_id,
     processing_model)
  VALUES
    (gen_random_uuid(), funding.legal_entity_id, v_credit_line, 'TEMPORARY_FUNDING_PAYABLE',
     funding.provider_business_party_id, funding.id, funding.original_amount, funding.original_currency_code,
     funding.base_amount, funding.base_currency_code, 'TEMPORARY_FUNDING', funding.id, 'OPERATIONAL_V1');
  IF funding.funding_mode = 'PROVIDER_FUNDED_SAFE' THEN
    INSERT INTO abos.subledger_entries
      (id, legal_entity_id, journal_line_id, subledger_type, operational_treasury_account_id,
       original_amount, original_currency_code, base_amount, base_currency_code, source_type, source_id,
       processing_model)
    VALUES
      (gen_random_uuid(), funding.legal_entity_id, v_debit_line, 'OPERATIONAL_TREASURY',
       funding.operational_treasury_account_id, funding.original_amount, funding.original_currency_code,
       funding.base_amount, funding.base_currency_code, 'TEMPORARY_FUNDING', funding.id, 'OPERATIONAL_V1');
  END IF;
  UPDATE abos.temporary_fundings
     SET status = 'POSTED', journal_id = v_journal_id, version = version + 1, updated_at = clock_timestamp()
   WHERE id = funding.id;
  UPDATE abos.posting_intents SET status = 'POSTED' WHERE id = v_intent_id;
  UPDATE abos.journals
     SET status = 'POSTED', posted_by_user_account_id = p_actor_id, posted_at = clock_timestamp()
   WHERE id = v_journal_id;
  PERFORM abos.temporary_funding_audit(p_actor_id, funding.legal_entity_id, funding.correlation_id,
    'TEMPORARY_FUNDING_POSTED', 'TEMPORARY_FUNDING', funding.id,
    jsonb_build_object('temporaryFundingId', funding.id, 'journalId', v_journal_id,
      'fundingMode', funding.funding_mode, 'providerBusinessPartyId', funding.provider_business_party_id,
      'amount', funding.original_amount::text, 'currency', funding.original_currency_code));
  INSERT INTO abos.outbox_events
    (id, aggregate_type, aggregate_id, event_type, event_version, legal_entity_id, actor_user_account_id,
     correlation_id, payload, occurred_at)
  VALUES
    (gen_random_uuid(), 'TEMPORARY_FUNDING', funding.id, 'finance.temporary-funding.posted', 1,
     funding.legal_entity_id, p_actor_id, funding.correlation_id,
     jsonb_build_object('temporaryFundingId', funding.id, 'journalId', v_journal_id), clock_timestamp());
  RETURN v_journal_id;
END
$post$;

CREATE FUNCTION abos.temporary_funding_settlement_post(p_settlement_id uuid, p_actor_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $post$
DECLARE
  settlement abos.temporary_funding_settlements%ROWTYPE;
  funding abos.temporary_fundings%ROWTYPE;
  mapping abos.temporary_funding_account_mapping_versions%ROWTYPE;
  v_treasury_ledger uuid;
  v_settled numeric;
  v_period uuid;
  v_intent_id uuid := gen_random_uuid();
  v_journal_id uuid := gen_random_uuid();
  v_debit_line uuid := gen_random_uuid();
  v_credit_line uuid := gen_random_uuid();
BEGIN
  IF current_user <> 'abos_v1_operational_finance_owner' THEN
    RAISE EXCEPTION 'temporary funding posting helper is internal' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Lock order everywhere: funding, then settlement.
  SELECT funding_row.* INTO funding FROM abos.temporary_fundings funding_row
   WHERE funding_row.id = (SELECT temporary_funding_id FROM abos.temporary_funding_settlements WHERE id = p_settlement_id)
   FOR UPDATE;
  SELECT * INTO settlement FROM abos.temporary_funding_settlements WHERE id = p_settlement_id FOR UPDATE;
  IF settlement.id IS NULL OR funding.id IS NULL THEN
    RAISE EXCEPTION 'settlement not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF settlement.status = 'POSTED' THEN RETURN settlement.journal_id; END IF;
  IF settlement.status <> 'PENDING_APPROVAL' OR NOT EXISTS (
    SELECT 1 FROM abos.temporary_funding_settlement_decisions decision
     WHERE decision.settlement_id = settlement.id AND decision.decision = 'APPROVED'
       AND decision.decided_by_user_account_id = p_actor_id) THEN
    RAISE EXCEPTION 'settlement has no approval from the posting actor' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF funding.status <> 'POSTED' THEN
    RAISE EXCEPTION 'only a posted, unreversed temporary funding can be settled' USING ERRCODE = 'check_violation';
  END IF;
  SELECT COALESCE(sum(base_amount), 0) INTO v_settled FROM abos.temporary_funding_settlements
   WHERE temporary_funding_id = funding.id AND status = 'POSTED';
  IF v_settled + settlement.base_amount > funding.base_amount THEN
    RAISE EXCEPTION 'settlement would exceed the outstanding temporary funding' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO mapping FROM abos.temporary_funding_account_mapping_versions
   WHERE id = funding.mapping_version_id AND legal_entity_id = funding.legal_entity_id;
  SELECT treasury.ledger_account_id INTO v_treasury_ledger FROM abos.operational_treasury_accounts treasury
   WHERE treasury.id = settlement.operational_treasury_account_id
     AND treasury.legal_entity_id = settlement.legal_entity_id AND treasury.status = 'ACTIVE'
     AND treasury.currency_code = settlement.original_currency_code;
  IF v_treasury_ledger IS NULL OR mapping.id IS NULL THEN
    RAISE EXCEPTION 'the settlement cash source must remain active' USING ERRCODE = 'check_violation';
  END IF;
  v_period := abos.temporary_funding_period_open(settlement.legal_entity_id, settlement.business_date);
  -- Staged Safe guard: an enforced account cannot pay out more recorded cash than it holds.
  PERFORM abos.operational_treasury_cash_guard(settlement.legal_entity_id,
    settlement.operational_treasury_account_id, settlement.original_amount, settlement.business_date);

  INSERT INTO abos.posting_intents
    (id, legal_entity_id, source_type, source_id, intent_kind, original_amount, original_currency_code,
     base_amount, base_currency_code, conversion_snapshot_reference, accounting_effective_date, correlation_id,
     idempotency_key, status, created_by_user_account_id, processing_model, temporary_funding_settlement_id,
     finance_workflow_policy_version_id, temporary_funding_mapping_version_id)
  VALUES
    (v_intent_id, settlement.legal_entity_id, 'TEMPORARY_FUNDING_SETTLEMENT', settlement.id,
     'TEMPORARY_FUNDING_SETTLEMENT', settlement.original_amount, settlement.original_currency_code,
     settlement.base_amount, settlement.base_currency_code, NULL, settlement.business_date,
     settlement.correlation_id, 'TFS:' || settlement.idempotency_key, 'APPROVED',
     settlement.created_by_user_account_id, 'OPERATIONAL_V1', settlement.id,
     settlement.workflow_policy_version_id, funding.mapping_version_id);
  INSERT INTO abos.journals
    (id, legal_entity_id, accounting_period_id, posting_intent_id, journal_reference, accounting_effective_date,
     base_currency_code, status, created_by_user_account_id, processing_model)
  VALUES
    (v_journal_id, settlement.legal_entity_id, v_period, v_intent_id, 'TFS-' || v_journal_id::text,
     settlement.business_date, settlement.base_currency_code, 'DRAFT', settlement.created_by_user_account_id,
     'OPERATIONAL_V1');
  INSERT INTO abos.journal_lines
    (id, journal_id, legal_entity_id, line_number, ledger_account_id, business_party_id, project_id,
     department_id, cost_center_id, original_amount, original_currency_code, base_debit, base_credit,
     base_currency_code, conversion_snapshot_reference, source_type, source_id, processing_model)
  VALUES
    (v_debit_line, v_journal_id, settlement.legal_entity_id, 1, mapping.payable_ledger_account_id,
     funding.provider_business_party_id, NULL, NULL, NULL, settlement.original_amount,
     settlement.original_currency_code, settlement.base_amount, 0, settlement.base_currency_code, NULL,
     'TEMPORARY_FUNDING_SETTLEMENT', settlement.id, 'OPERATIONAL_V1'),
    (v_credit_line, v_journal_id, settlement.legal_entity_id, 2, v_treasury_ledger, NULL, NULL, NULL, NULL,
     settlement.original_amount, settlement.original_currency_code, 0, settlement.base_amount,
     settlement.base_currency_code, NULL, 'TEMPORARY_FUNDING_SETTLEMENT', settlement.id, 'OPERATIONAL_V1');
  INSERT INTO abos.subledger_entries
    (id, legal_entity_id, journal_line_id, subledger_type, business_party_id, temporary_funding_id,
     original_amount, original_currency_code, base_amount, base_currency_code, source_type, source_id,
     processing_model)
  VALUES
    (gen_random_uuid(), settlement.legal_entity_id, v_debit_line, 'TEMPORARY_FUNDING_PAYABLE',
     funding.provider_business_party_id, funding.id, -settlement.original_amount,
     settlement.original_currency_code, -settlement.base_amount, settlement.base_currency_code,
     'TEMPORARY_FUNDING_SETTLEMENT', settlement.id, 'OPERATIONAL_V1');
  INSERT INTO abos.subledger_entries
    (id, legal_entity_id, journal_line_id, subledger_type, operational_treasury_account_id,
     original_amount, original_currency_code, base_amount, base_currency_code, source_type, source_id,
     processing_model)
  VALUES
    (gen_random_uuid(), settlement.legal_entity_id, v_credit_line, 'OPERATIONAL_TREASURY',
     settlement.operational_treasury_account_id, -settlement.original_amount, settlement.original_currency_code,
     -settlement.base_amount, settlement.base_currency_code, 'TEMPORARY_FUNDING_SETTLEMENT', settlement.id,
     'OPERATIONAL_V1');
  UPDATE abos.temporary_funding_settlements
     SET status = 'POSTED', journal_id = v_journal_id, version = version + 1, updated_at = clock_timestamp()
   WHERE id = settlement.id;
  UPDATE abos.posting_intents SET status = 'POSTED' WHERE id = v_intent_id;
  UPDATE abos.journals
     SET status = 'POSTED', posted_by_user_account_id = p_actor_id, posted_at = clock_timestamp()
   WHERE id = v_journal_id;
  PERFORM abos.temporary_funding_audit(p_actor_id, settlement.legal_entity_id, settlement.correlation_id,
    'TEMPORARY_FUNDING_SETTLEMENT_POSTED', 'TEMPORARY_FUNDING_SETTLEMENT', settlement.id,
    jsonb_build_object('settlementId', settlement.id, 'temporaryFundingId', funding.id,
      'journalId', v_journal_id, 'amount', settlement.original_amount::text,
      'currency', settlement.original_currency_code,
      'outstandingAfter', (funding.base_amount - v_settled - settlement.base_amount)::text));
  INSERT INTO abos.outbox_events
    (id, aggregate_type, aggregate_id, event_type, event_version, legal_entity_id, actor_user_account_id,
     correlation_id, payload, occurred_at)
  VALUES
    (gen_random_uuid(), 'TEMPORARY_FUNDING', funding.id, 'finance.temporary-funding.settled', 1,
     settlement.legal_entity_id, p_actor_id, settlement.correlation_id,
     jsonb_build_object('temporaryFundingId', funding.id, 'settlementId', settlement.id,
       'journalId', v_journal_id), clock_timestamp());
  RETURN v_journal_id;
END
$post$;

-- Exact mirror of an unsettled funding journal; decided and posted by an independent reverser.
CREATE FUNCTION abos.temporary_funding_reversal_post(p_reversal_id uuid, p_actor_id uuid, p_note text)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $post$
DECLARE
  reversal abos.temporary_funding_reversals%ROWTYPE;
  funding abos.temporary_fundings%ROWTYPE;
  original abos.journals%ROWTYPE;
  v_period uuid;
  v_evidence_id uuid := gen_random_uuid();
  v_intent_id uuid := gen_random_uuid();
  v_journal_id uuid := gen_random_uuid();
BEGIN
  IF current_user <> 'abos_v1_operational_finance_owner' THEN
    RAISE EXCEPTION 'temporary funding posting helper is internal' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT funding_row.* INTO funding FROM abos.temporary_fundings funding_row
   WHERE funding_row.id = (SELECT temporary_funding_id FROM abos.temporary_funding_reversals WHERE id = p_reversal_id)
   FOR UPDATE;
  SELECT * INTO reversal FROM abos.temporary_funding_reversals WHERE id = p_reversal_id FOR UPDATE;
  IF reversal.id IS NULL OR funding.id IS NULL THEN
    RAISE EXCEPTION 'reversal not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF reversal.status = 'POSTED' THEN RETURN reversal.reversal_journal_id; END IF;
  IF reversal.status <> 'REQUESTED' OR funding.status <> 'POSTED'
     OR funding.journal_id IS DISTINCT FROM reversal.original_journal_id THEN
    RAISE EXCEPTION 'reversal is not ready to post' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM abos.temporary_funding_settlements settlement
              WHERE settlement.temporary_funding_id = funding.id
                AND settlement.status IN ('PENDING_APPROVAL', 'POSTED')) THEN
    RAISE EXCEPTION 'a temporary funding with pending or posted settlements cannot be reversed'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO original FROM abos.journals WHERE id = reversal.original_journal_id;
  IF p_actor_id = original.posted_by_user_account_id OR p_actor_id = reversal.requested_by_user_account_id
     OR p_actor_id = funding.created_by_user_account_id
     OR p_actor_id IS NOT DISTINCT FROM funding.provider_user_account_id THEN
    RAISE EXCEPTION 'the reversal must be decided by someone independent of the request, the funding and its posting'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  v_period := abos.temporary_funding_period_open(funding.legal_entity_id, reversal.reversal_date);
  IF funding.funding_mode = 'PROVIDER_FUNDED_SAFE' THEN
    -- Reversing a Safe inflow takes the cash back out of the Safe.
    PERFORM abos.operational_treasury_cash_guard(funding.legal_entity_id,
      funding.operational_treasury_account_id, funding.original_amount, reversal.reversal_date);
  END IF;

  INSERT INTO abos.evidence_references
    (id, legal_entity_id, document_id, evidence_kind, evidence_version, sha256, completed_at)
  VALUES
    (v_evidence_id, funding.legal_entity_id, reversal.id, 'REVERSAL_REASON', 1,
     encode(sha256(convert_to(reversal.reason, 'UTF8')), 'hex'), clock_timestamp());
  INSERT INTO abos.posting_intents
    (id, legal_entity_id, project_id, department_id, cost_center_id, source_type, source_id, intent_kind,
     original_amount, original_currency_code, base_amount, base_currency_code, conversion_snapshot_reference,
     accounting_effective_date, correlation_id, idempotency_key, status, created_by_user_account_id,
     processing_model, temporary_funding_reversal_id, temporary_funding_mapping_version_id)
  VALUES
    (v_intent_id, funding.legal_entity_id, funding.project_id, funding.department_id, funding.cost_center_id,
     'TEMPORARY_FUNDING_REVERSAL', reversal.original_journal_id, 'REVERSAL', funding.original_amount,
     funding.original_currency_code, funding.base_amount, funding.base_currency_code, NULL,
     reversal.reversal_date, reversal.correlation_id, 'TFR:' || reversal.idempotency_key, 'APPROVED',
     reversal.requested_by_user_account_id, 'OPERATIONAL_V1', reversal.id, funding.mapping_version_id);
  INSERT INTO abos.journals
    (id, legal_entity_id, accounting_period_id, posting_intent_id, journal_reference, accounting_effective_date,
     base_currency_code, status, created_by_user_account_id, processing_model)
  VALUES
    (v_journal_id, funding.legal_entity_id, v_period, v_intent_id, 'TFR-' || v_journal_id::text,
     reversal.reversal_date, funding.base_currency_code, 'DRAFT', reversal.requested_by_user_account_id,
     'OPERATIONAL_V1');
  INSERT INTO abos.journal_lines
    (id, journal_id, legal_entity_id, line_number, ledger_account_id, business_party_id, project_id,
     department_id, cost_center_id, original_amount, original_currency_code, base_debit, base_credit,
     base_currency_code, conversion_snapshot_reference, source_type, source_id, processing_model)
  SELECT gen_random_uuid(), v_journal_id, line.legal_entity_id, line.line_number, line.ledger_account_id,
         line.business_party_id, line.project_id, line.department_id, line.cost_center_id, line.original_amount,
         line.original_currency_code, line.base_credit, line.base_debit, line.base_currency_code, NULL,
         'TEMPORARY_FUNDING_REVERSAL', reversal.id, 'OPERATIONAL_V1'
    FROM abos.journal_lines line WHERE line.journal_id = reversal.original_journal_id;
  INSERT INTO abos.subledger_entries
    (id, legal_entity_id, journal_line_id, subledger_type, business_party_id, temporary_funding_id,
     operational_treasury_account_id, original_amount, original_currency_code, base_amount, base_currency_code,
     source_type, source_id, processing_model)
  SELECT gen_random_uuid(), entry.legal_entity_id, mirror.id, entry.subledger_type, entry.business_party_id,
         entry.temporary_funding_id, entry.operational_treasury_account_id, -entry.original_amount,
         entry.original_currency_code, -entry.base_amount, entry.base_currency_code,
         'TEMPORARY_FUNDING_REVERSAL', reversal.id, 'OPERATIONAL_V1'
    FROM abos.subledger_entries entry
    JOIN abos.journal_lines line ON line.id = entry.journal_line_id
    JOIN abos.journal_lines mirror ON mirror.journal_id = v_journal_id AND mirror.line_number = line.line_number
   WHERE line.journal_id = reversal.original_journal_id;
  UPDATE abos.temporary_funding_reversals
     SET status = 'POSTED', version = version + 1, decided_by_user_account_id = p_actor_id,
         decided_at = clock_timestamp(), decision_note = p_note, reversal_journal_id = v_journal_id,
         evidence_reference_id = v_evidence_id
   WHERE id = reversal.id;
  UPDATE abos.temporary_fundings
     SET status = 'REVERSED', version = version + 1, updated_at = clock_timestamp()
   WHERE id = funding.id;
  UPDATE abos.posting_intents SET status = 'POSTED' WHERE id = v_intent_id;
  UPDATE abos.journals
     SET status = 'POSTED', posted_by_user_account_id = p_actor_id, posted_at = clock_timestamp()
   WHERE id = v_journal_id;
  INSERT INTO abos.journal_reversal_links
    (original_journal_id, reversal_journal_id, reason, approved_by_user_account_id, evidence_reference_id)
  VALUES (reversal.original_journal_id, v_journal_id, reversal.reason, p_actor_id, v_evidence_id);
  PERFORM abos.temporary_funding_audit(p_actor_id, funding.legal_entity_id, reversal.correlation_id,
    'TEMPORARY_FUNDING_REVERSAL_POSTED', 'TEMPORARY_FUNDING', funding.id,
    jsonb_build_object('temporaryFundingId', funding.id, 'reversalId', reversal.id,
      'originalJournalId', reversal.original_journal_id, 'reversalJournalId', v_journal_id,
      'evidenceReferenceId', v_evidence_id));
  INSERT INTO abos.outbox_events
    (id, aggregate_type, aggregate_id, event_type, event_version, legal_entity_id, actor_user_account_id,
     correlation_id, payload, occurred_at)
  VALUES
    (gen_random_uuid(), 'TEMPORARY_FUNDING', funding.id, 'finance.temporary-funding.reversed', 1,
     funding.legal_entity_id, p_actor_id, reversal.correlation_id,
     jsonb_build_object('temporaryFundingId', funding.id, 'reversalJournalId', v_journal_id), clock_timestamp());
  RETURN v_journal_id;
END
$post$;

-- ---------------------------------------------------------------------------------------------------
-- 10. Restricted public entry points (owned by abos_v1_operational_finance_owner; runtime EXECUTE only)
-- ---------------------------------------------------------------------------------------------------
CREATE FUNCTION abos.temporary_funding_workspace(
  p_identity_proof text, p_runtime_token_sha256 text, p_token_sha256 text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $workspace$
DECLARE
  v_context jsonb;
  v_entity uuid;
  v_permissions jsonb;
  v_base text;
BEGIN
  v_context := abos.temporary_funding_actor(p_identity_proof, p_runtime_token_sha256, p_token_sha256,
    ARRAY['finance.temporary-funding.read', 'finance.temporary-funding.create',
          'finance.temporary-funding.approve', 'finance.temporary-funding.settle',
          'finance.temporary-funding.settle-approve', 'finance.temporary-funding.reverse',
          'finance.temporary-funding.configure']);
  v_entity := (v_context ->> 'legalEntityId')::uuid;
  v_permissions := COALESCE(v_context -> 'permissions', '[]'::jsonb);
  SELECT base_currency_code INTO v_base FROM abos.legal_entities
   WHERE id = v_entity AND currency_policy_status = 'APPROVED';
  RETURN jsonb_build_object(
    'legalEntityId', v_entity,
    'baseCurrency', v_base,
    'actorUserAccountId', v_context ->> 'userAccountId',
    'permissions', jsonb_build_object(
      'canRead', v_permissions ? 'finance.temporary-funding.read',
      'canCreate', v_permissions ? 'finance.temporary-funding.create',
      'canApprove', v_permissions ? 'finance.temporary-funding.approve',
      'canSettle', v_permissions ? 'finance.temporary-funding.settle',
      'canApproveSettlement', v_permissions ? 'finance.temporary-funding.settle-approve',
      'canReverse', v_permissions ? 'finance.temporary-funding.reverse',
      'canConfigure', v_permissions ? 'finance.temporary-funding.configure'),
    'configuration', jsonb_build_object(
      'mapping', (SELECT jsonb_build_object('id', mapping.id, 'version', mapping.version,
                    'payableLedgerAccount', jsonb_build_object('id', ledger.id, 'code', ledger.account_code,
                      'name', ledger.account_name), 'configuredAt', mapping.configured_at)
                    FROM abos.temporary_funding_account_mapping_versions mapping
                    JOIN abos.ledger_accounts ledger ON ledger.id = mapping.payable_ledger_account_id
                   WHERE mapping.legal_entity_id = v_entity ORDER BY mapping.version DESC LIMIT 1),
      'policy', (SELECT jsonb_build_object('id', policy.id, 'version', policy.version,
                    'approvalRequired', policy.approval_required)
                    FROM abos.finance_workflow_policy_versions policy
                   WHERE policy.legal_entity_id = v_entity AND policy.workflow_type = 'TEMPORARY_FUNDING'
                   ORDER BY policy.version DESC LIMIT 1)),
    -- Provider subledger: the authoritative outstanding balance is the posted payable subledger.
    'providers', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'businessPartyId', provider.id, 'name', provider.display_name,
        'providerKinds', provider_totals.kinds,
        'fundedAmount', provider_totals.funded::text,
        'settledAmount', provider_totals.settled::text,
        'reversedAmount', provider_totals.reversed::text,
        'outstandingAmount', COALESCE(ledger_totals.balance, 0)::text,
        'openFundings', provider_totals.open_count,
        'status', CASE WHEN COALESCE(ledger_totals.balance, 0) = 0 THEN 'SETTLED'
                       WHEN provider_totals.settled = 0 THEN 'OUTSTANDING'
                       ELSE 'PARTIALLY_SETTLED' END)
        ORDER BY provider.display_name, provider.id)
      FROM (
        SELECT funding.provider_business_party_id AS party_id,
               jsonb_agg(DISTINCT funding.provider_kind) AS kinds,
               COALESCE(sum(funding.base_amount) FILTER (WHERE funding.status IN ('POSTED', 'REVERSED')), 0) AS funded,
               COALESCE(sum(funding.base_amount) FILTER (WHERE funding.status = 'REVERSED'), 0) AS reversed,
               COALESCE((SELECT sum(settlement.base_amount) FROM abos.temporary_funding_settlements settlement
                          JOIN abos.temporary_fundings parent ON parent.id = settlement.temporary_funding_id
                         WHERE parent.provider_business_party_id = funding.provider_business_party_id
                           AND parent.legal_entity_id = v_entity AND settlement.status = 'POSTED'), 0) AS settled,
               count(*) FILTER (WHERE funding.status = 'POSTED') AS open_count
          FROM abos.temporary_fundings funding
         WHERE funding.legal_entity_id = v_entity AND funding.status IN ('POSTED', 'REVERSED')
         GROUP BY funding.provider_business_party_id) provider_totals
      JOIN abos.business_parties provider ON provider.id = provider_totals.party_id
      LEFT JOIN LATERAL (
        SELECT sum(entry.base_amount) AS balance
          FROM abos.subledger_entries entry
          JOIN abos.journal_lines line ON line.id = entry.journal_line_id
          JOIN abos.journals journal ON journal.id = line.journal_id
         WHERE entry.legal_entity_id = v_entity AND entry.subledger_type = 'TEMPORARY_FUNDING_PAYABLE'
           AND entry.business_party_id = provider.id AND journal.status = 'POSTED') ledger_totals ON true),
      '[]'::jsonb),
    'payableTotal', (SELECT COALESCE(sum(entry.base_amount), 0)::text
        FROM abos.subledger_entries entry
        JOIN abos.journal_lines line ON line.id = entry.journal_line_id
        JOIN abos.journals journal ON journal.id = line.journal_id
       WHERE entry.legal_entity_id = v_entity AND entry.subledger_type = 'TEMPORARY_FUNDING_PAYABLE'
         AND journal.status = 'POSTED'),
    -- Physical Safe positions are shown separately and never include the payable.
    'safePositions', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'treasuryAccountId', account.id, 'nameEn', account.name_en, 'nameFa', account.name_fa,
        'accountType', account.account_type, 'currencyCode', account.currency_code,
        'postedMovementTotal', COALESCE(movements.total, 0)::text,
        'temporaryFundingInflow', COALESCE(movements.funding_in, 0)::text,
        'temporaryFundingSettlementOutflow', COALESCE(movements.settlement_out, 0)::text,
        'cashControl', CASE WHEN control.id IS NULL THEN NULL ELSE jsonb_build_object(
          'openingAmount', control.opening_amount::text, 'openingAsOf', control.opening_as_of,
          'recordedCash', abos.operational_treasury_recorded_cash(v_entity, account.id)::text) END,
        'nonNegativeEnforced', control.id IS NOT NULL)
        ORDER BY account.name_en, account.id)
      FROM abos.operational_treasury_accounts account
      LEFT JOIN abos.operational_treasury_cash_controls control
        ON control.operational_treasury_account_id = account.id
      LEFT JOIN LATERAL (
        SELECT sum(entry.original_amount) AS total,
               sum(entry.original_amount) FILTER (WHERE entry.source_type IN ('TEMPORARY_FUNDING', 'TEMPORARY_FUNDING_REVERSAL')) AS funding_in,
               -sum(entry.original_amount) FILTER (WHERE entry.source_type = 'TEMPORARY_FUNDING_SETTLEMENT') AS settlement_out
          FROM abos.subledger_entries entry
          JOIN abos.journal_lines line ON line.id = entry.journal_line_id
          JOIN abos.journals journal ON journal.id = line.journal_id
         WHERE entry.subledger_type = 'OPERATIONAL_TREASURY' AND entry.operational_treasury_account_id = account.id
           AND journal.status = 'POSTED') movements ON true
      WHERE account.legal_entity_id = v_entity AND account.status = 'ACTIVE'), '[]'::jsonb),
    'fundings', COALESCE((SELECT jsonb_agg(abos.temporary_funding_json(funding.id)
        ORDER BY funding.business_date DESC, funding.created_at DESC)
      FROM (SELECT id, business_date, created_at FROM abos.temporary_fundings
             WHERE legal_entity_id = v_entity ORDER BY business_date DESC, created_at DESC LIMIT 500) funding),
      '[]'::jsonb),
    'options', jsonb_build_object(
      'treasuryAccounts', COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'id', account.id, 'nameEn', account.name_en, 'nameFa', account.name_fa,
          'currencyCode', account.currency_code, 'accountType', account.account_type)
          ORDER BY account.name_en, account.id)
        FROM abos.operational_treasury_accounts account
        WHERE account.legal_entity_id = v_entity AND account.status = 'ACTIVE'
          AND account.currency_code = v_base), '[]'::jsonb),
      'expenseCategories', COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'id', category.id, 'code', category.category_code, 'nameEn', category.name_en, 'nameFa', category.name_fa)
          ORDER BY category.category_code, category.id)
        FROM abos.operational_expense_categories category
        WHERE category.legal_entity_id = v_entity AND category.status = 'ACTIVE'), '[]'::jsonb),
      'parties', COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'id', party.id, 'name', party.display_name,
          'roles', COALESCE((SELECT jsonb_agg(DISTINCT role.role_code) FROM abos.business_party_roles role
                              WHERE role.business_party_id = party.id AND role.effective_from <= current_date
                                AND (role.effective_to IS NULL OR role.effective_to >= current_date)), '[]'::jsonb))
          ORDER BY party.display_name, party.id)
        FROM abos.business_parties party
        WHERE party.legal_entity_id = v_entity AND party.status = 'ACTIVE'), '[]'::jsonb),
      'payableLedgerAccounts', COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'id', ledger.id, 'code', ledger.account_code, 'name', ledger.account_name)
          ORDER BY ledger.account_code, ledger.id)
        FROM abos.ledger_accounts ledger
        WHERE ledger.legal_entity_id = v_entity AND ledger.account_type = 'LIABILITY'
          AND ledger.status = 'ACTIVE' AND ledger.posting_allowed
          AND (ledger.control_account_type IS NULL OR ledger.control_account_type = 'OTHER')
          AND (ledger.account_currency_code IS NULL OR ledger.account_currency_code = v_base)
          AND NOT ledger.requires_project AND NOT ledger.requires_department
          AND NOT ledger.requires_cost_center), '[]'::jsonb)));
END
$workspace$;

CREATE FUNCTION abos.temporary_funding_configure(
  p_identity_proof text, p_runtime_token_sha256 text, p_token_sha256 text,
  p_payable_ledger_account_id uuid, p_expected_version integer, p_change_reason text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $configure$
DECLARE
  v_context jsonb;
  v_actor uuid;
  v_entity uuid;
  v_latest abos.temporary_funding_account_mapping_versions%ROWTYPE;
  v_id uuid := gen_random_uuid();
  v_reason text := NULLIF(btrim(p_change_reason), '');
BEGIN
  v_context := abos.temporary_funding_actor(p_identity_proof, p_runtime_token_sha256, p_token_sha256,
    ARRAY['finance.temporary-funding.configure']);
  v_actor := (v_context ->> 'userAccountId')::uuid;
  v_entity := (v_context ->> 'legalEntityId')::uuid;
  IF p_payable_ledger_account_id IS NULL OR p_expected_version IS NULL OR p_expected_version < 0
     OR v_reason IS NULL OR length(v_reason) NOT BETWEEN 5 AND 500 THEN
    RAISE EXCEPTION 'payable account, current mapping version and a 5-500 character reason are required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('abos-temporary-funding-mapping:' || v_entity::text, 0));
  SELECT * INTO v_latest FROM abos.temporary_funding_account_mapping_versions
   WHERE legal_entity_id = v_entity ORDER BY version DESC LIMIT 1;
  IF v_latest.id IS NOT NULL AND v_latest.version = p_expected_version
     AND v_latest.payable_ledger_account_id = p_payable_ledger_account_id THEN
    RETURN jsonb_build_object('mappingId', v_latest.id, 'version', v_latest.version, 'replayed', true);
  END IF;
  IF COALESCE(v_latest.version, 0) <> p_expected_version THEN
    RAISE EXCEPTION 'the payable mapping changed; reload and try again' USING ERRCODE = 'serialization_failure';
  END IF;
  INSERT INTO abos.temporary_funding_account_mapping_versions
    (id, legal_entity_id, version, payable_ledger_account_id, configured_by_user_account_id, change_reason)
  VALUES (v_id, v_entity, p_expected_version + 1, p_payable_ledger_account_id, v_actor, v_reason);
  PERFORM abos.temporary_funding_audit(v_actor, v_entity, gen_random_uuid(),
    'TEMPORARY_FUNDING_MAPPING_CONFIGURED', 'TEMPORARY_FUNDING_MAPPING', v_id,
    jsonb_build_object('version', p_expected_version + 1, 'payableLedgerAccountId', p_payable_ledger_account_id,
      'reason', v_reason));
  RETURN jsonb_build_object('mappingId', v_id, 'version', p_expected_version + 1, 'replayed', false);
END
$configure$;

CREATE FUNCTION abos.temporary_funding_create(
  p_identity_proof text, p_runtime_token_sha256 text, p_token_sha256 text, p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $create$
DECLARE
  v_context jsonb;
  v_actor uuid;
  v_entity uuid;
  v_unknown text;
  v_mode text;
  v_kind text;
  v_provider uuid;
  v_provider_user uuid;
  v_category uuid;
  v_payee uuid;
  v_project uuid;
  v_department uuid;
  v_cost_center uuid;
  v_treasury uuid;
  v_reference text;
  v_description text;
  v_note text;
  v_date date;
  v_amount numeric;
  v_currency text;
  v_base text;
  v_correlation uuid;
  v_key text;
  v_fingerprint text;
  v_scope text;
  v_replay jsonb;
  v_policy uuid;
  v_mapping uuid;
  v_is_shareholder boolean;
  v_is_employee boolean;
  v_ledger record;
  v_id uuid := gen_random_uuid();
  v_response jsonb;
BEGIN
  v_context := abos.temporary_funding_actor(p_identity_proof, p_runtime_token_sha256, p_token_sha256,
    ARRAY['finance.temporary-funding.create']);
  v_actor := (v_context ->> 'userAccountId')::uuid;
  v_entity := (v_context ->> 'legalEntityId')::uuid;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'temporary funding details must be an object' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT string_agg(payload_key, ', ') INTO v_unknown FROM jsonb_object_keys(p_payload) payload_key
   WHERE payload_key NOT IN ('fundingMode', 'providerKind', 'providerBusinessPartyId', 'providerUserAccountId',
     'expenseCategoryId', 'payeeBusinessPartyId', 'projectId', 'departmentId', 'costCenterId',
     'treasuryAccountId', 'reference', 'description', 'note', 'businessDate', 'originalAmount',
     'currencyCode', 'correlationId', 'idempotencyKey');
  IF v_unknown IS NOT NULL THEN
    RAISE EXCEPTION 'unknown temporary funding fields: %', v_unknown USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_mode := p_payload ->> 'fundingMode';
  v_kind := p_payload ->> 'providerKind';
  v_amount := abos.temporary_funding_amount(p_payload ->> 'originalAmount');
  v_provider := NULLIF(p_payload ->> 'providerBusinessPartyId', '')::uuid;
  v_provider_user := NULLIF(p_payload ->> 'providerUserAccountId', '')::uuid;
  v_category := NULLIF(p_payload ->> 'expenseCategoryId', '')::uuid;
  v_payee := NULLIF(p_payload ->> 'payeeBusinessPartyId', '')::uuid;
  v_project := NULLIF(p_payload ->> 'projectId', '')::uuid;
  v_department := NULLIF(p_payload ->> 'departmentId', '')::uuid;
  v_cost_center := NULLIF(p_payload ->> 'costCenterId', '')::uuid;
  v_treasury := NULLIF(p_payload ->> 'treasuryAccountId', '')::uuid;
  v_reference := NULLIF(btrim(p_payload ->> 'reference'), '');
  v_description := NULLIF(btrim(p_payload ->> 'description'), '');
  v_note := NULLIF(btrim(p_payload ->> 'note'), '');
  v_date := NULLIF(p_payload ->> 'businessDate', '')::date;
  v_currency := upper(NULLIF(btrim(p_payload ->> 'currencyCode'), ''));
  v_correlation := NULLIF(p_payload ->> 'correlationId', '')::uuid;
  v_key := NULLIF(btrim(p_payload ->> 'idempotencyKey'), '');
  IF v_mode IS NULL OR v_mode NOT IN ('PROVIDER_PAID_EXPENSE', 'PROVIDER_FUNDED_SAFE')
     OR v_kind IS NULL OR v_kind NOT IN ('SHAREHOLDER', 'EMPLOYEE_OFFICER', 'OTHER_PERSON', 'ORGANIZATION')
     OR v_provider IS NULL OR v_date IS NULL OR v_currency IS NULL OR v_correlation IS NULL
     OR v_reference IS NULL OR length(v_reference) > 120
     OR v_description IS NULL OR length(v_description) NOT BETWEEN 3 AND 500
     OR (v_note IS NOT NULL AND length(v_note) > 1000)
     OR v_key IS NULL OR length(v_key) NOT BETWEEN 8 AND 200
     OR (v_mode = 'PROVIDER_PAID_EXPENSE' AND (v_category IS NULL OR v_treasury IS NOT NULL))
     OR (v_mode = 'PROVIDER_FUNDED_SAFE' AND (v_treasury IS NULL OR v_category IS NOT NULL OR v_payee IS NOT NULL
         OR v_project IS NOT NULL OR v_department IS NOT NULL OR v_cost_center IS NOT NULL))
     OR (v_provider_user IS NOT NULL AND v_kind <> 'EMPLOYEE_OFFICER') THEN
    RAISE EXCEPTION 'complete valid temporary funding details are required' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_fingerprint := encode(sha256(convert_to(jsonb_build_object(
    'actorId', v_actor, 'fundingMode', v_mode, 'providerKind', v_kind, 'providerBusinessPartyId', v_provider,
    'providerUserAccountId', v_provider_user, 'expenseCategoryId', v_category, 'payeeBusinessPartyId', v_payee,
    'projectId', v_project, 'departmentId', v_department, 'costCenterId', v_cost_center,
    'treasuryAccountId', v_treasury, 'reference', v_reference, 'description', v_description, 'note', v_note,
    'businessDate', v_date, 'originalAmount', v_amount::text, 'currencyCode', v_currency,
    'correlationId', v_correlation)::text, 'UTF8')), 'hex');
  v_scope := v_entity::text || ':TEMPORARY_FUNDING_CREATE';
  v_replay := abos.temporary_funding_idempotency_begin(v_scope, v_key, v_fingerprint, v_correlation);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;

  SELECT base_currency_code INTO v_base FROM abos.legal_entities
   WHERE id = v_entity AND currency_policy_status = 'APPROVED';
  IF v_base IS NULL THEN
    RAISE EXCEPTION 'the legal entity has no approved base currency' USING ERRCODE = 'check_violation';
  END IF;
  IF v_currency <> v_base THEN
    RAISE EXCEPTION 'temporary funding is base-currency only until a foreign-currency policy is approved'
      USING ERRCODE = 'check_violation';
  END IF;
  -- Provider classification follows the party's live roles so a shareholder's temporary funding is
  -- always visible as such, while still never touching shareholder capital or loan subledgers.
  IF NOT EXISTS (SELECT 1 FROM abos.business_parties party WHERE party.id = v_provider
                    AND party.legal_entity_id = v_entity AND party.status = 'ACTIVE') THEN
    RAISE EXCEPTION 'the funding provider is not an active business party in this legal entity'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT bool_or(role.role_code = 'SHAREHOLDER'), bool_or(role.role_code = 'EMPLOYEE')
    INTO v_is_shareholder, v_is_employee
    FROM abos.business_party_roles role
   WHERE role.business_party_id = v_provider AND role.effective_from <= v_date
     AND (role.effective_to IS NULL OR role.effective_to >= v_date);
  v_is_shareholder := COALESCE(v_is_shareholder, false);
  v_is_employee := COALESCE(v_is_employee, false);
  IF (v_kind = 'SHAREHOLDER' AND NOT v_is_shareholder)
     OR (v_kind = 'EMPLOYEE_OFFICER' AND NOT v_is_employee)
     OR (v_kind IN ('OTHER_PERSON', 'ORGANIZATION') AND (v_is_shareholder OR v_is_employee)) THEN
    RAISE EXCEPTION 'the provider kind does not match the provider''s roles on the funding date'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_mode = 'PROVIDER_PAID_EXPENSE' THEN
    SELECT ledger.requires_project, ledger.requires_department, ledger.requires_cost_center INTO v_ledger
      FROM abos.operational_expense_categories category
      JOIN abos.ledger_accounts ledger ON ledger.id = category.ledger_account_id
     WHERE category.id = v_category AND category.legal_entity_id = v_entity AND category.status = 'ACTIVE';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'an active same-entity expense category is required' USING ERRCODE = 'check_violation';
    END IF;
    IF (v_ledger.requires_project AND v_project IS NULL) OR (v_ledger.requires_department AND v_department IS NULL)
       OR (v_ledger.requires_cost_center AND v_cost_center IS NULL) THEN
      RAISE EXCEPTION 'the expense category requires a project, department or cost center'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF v_payee IS NOT NULL AND NOT EXISTS (SELECT 1 FROM abos.business_parties party WHERE party.id = v_payee
                                              AND party.legal_entity_id = v_entity AND party.status = 'ACTIVE') THEN
      RAISE EXCEPTION 'payee is not an active business party in this legal entity' USING ERRCODE = 'check_violation';
    END IF;
    IF (v_project IS NOT NULL AND NOT EXISTS (SELECT 1 FROM abos.user_scope_grants grant_row
          WHERE grant_row.user_account_id = v_actor AND grant_row.legal_entity_id = v_entity
            AND grant_row.scope_kind = 'PROJECT' AND grant_row.scope_id = v_project AND grant_row.revoked_at IS NULL))
       OR (v_department IS NOT NULL AND NOT EXISTS (SELECT 1 FROM abos.user_scope_grants grant_row
          WHERE grant_row.user_account_id = v_actor AND grant_row.legal_entity_id = v_entity
            AND grant_row.scope_kind = 'DEPARTMENT' AND grant_row.scope_id = v_department AND grant_row.revoked_at IS NULL))
       OR (v_cost_center IS NOT NULL AND NOT EXISTS (SELECT 1 FROM abos.user_scope_grants grant_row
          WHERE grant_row.user_account_id = v_actor AND grant_row.legal_entity_id = v_entity
            AND grant_row.scope_kind = 'COST_CENTER' AND grant_row.scope_id = v_cost_center AND grant_row.revoked_at IS NULL)) THEN
      RAISE EXCEPTION 'funding dimensions are outside the actor''s live scope' USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF NOT EXISTS (SELECT 1 FROM abos.operational_treasury_accounts account
                     WHERE account.id = v_treasury AND account.legal_entity_id = v_entity
                       AND account.status = 'ACTIVE' AND account.currency_code = v_currency
                       AND account.account_type IN ('SAFE', 'CASH_BOX', 'PETTY_CASH')) THEN
    RAISE EXCEPTION 'an active same-currency Safe, cash box or petty cash account is required'
      USING ERRCODE = 'check_violation';
  END IF;
  PERFORM abos.temporary_funding_period_open(v_entity, v_date);
  v_policy := abos.temporary_funding_policy_id(v_entity);
  SELECT id INTO v_mapping FROM abos.temporary_funding_account_mapping_versions
   WHERE legal_entity_id = v_entity ORDER BY version DESC LIMIT 1;
  IF v_mapping IS NULL THEN
    RAISE EXCEPTION 'the temporary funding payable account is not configured' USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO abos.temporary_fundings
    (id, legal_entity_id, funding_mode, provider_kind, provider_business_party_id, provider_user_account_id,
     operational_expense_category_id, payee_business_party_id, project_id, department_id, cost_center_id,
     operational_treasury_account_id, reference, description, note, business_date, original_amount,
     original_currency_code, base_amount, base_currency_code, workflow_policy_version_id, mapping_version_id,
     correlation_id, idempotency_key, request_fingerprint, status, version, created_by_user_account_id)
  VALUES
    (v_id, v_entity, v_mode, v_kind, v_provider, v_provider_user, v_category, v_payee, v_project, v_department,
     v_cost_center, v_treasury, v_reference, v_description, v_note, v_date, v_amount, v_currency, v_amount,
     v_base, v_policy, v_mapping, v_correlation, v_key, v_fingerprint, 'PENDING_APPROVAL', 1, v_actor);
  v_response := jsonb_build_object('funding', abos.temporary_funding_json(v_id), 'replayed', false);
  PERFORM abos.temporary_funding_idempotency_complete(v_scope, v_key, 'TEMPORARY_FUNDING', v_id, v_response);
  PERFORM abos.temporary_funding_audit(v_actor, v_entity, v_correlation, 'TEMPORARY_FUNDING_SUBMITTED',
    'TEMPORARY_FUNDING', v_id, abos.temporary_funding_json(v_id));
  RETURN v_response;
END
$create$;

CREATE FUNCTION abos.temporary_funding_decide(
  p_identity_proof text, p_runtime_token_sha256 text, p_token_sha256 text,
  p_funding_id uuid, p_expected_version integer, p_decision text, p_note text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $decide$
DECLARE
  v_context jsonb;
  v_actor uuid;
  v_entity uuid;
  v_note text := NULLIF(btrim(p_note), '');
  funding abos.temporary_fundings%ROWTYPE;
BEGIN
  v_context := abos.temporary_funding_actor(p_identity_proof, p_runtime_token_sha256, p_token_sha256,
    ARRAY['finance.temporary-funding.approve']);
  v_actor := (v_context ->> 'userAccountId')::uuid;
  v_entity := (v_context ->> 'legalEntityId')::uuid;
  IF p_funding_id IS NULL OR p_expected_version IS NULL OR p_expected_version < 1
     OR p_decision IS NULL OR p_decision NOT IN ('APPROVED', 'REJECTED')
     OR v_note IS NULL OR length(v_note) NOT BETWEEN 5 AND 500 THEN
    RAISE EXCEPTION 'funding, current version, a decision and a 5-500 character note are required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('abos-temporary-funding:' || p_funding_id::text, 0));
  SELECT * INTO funding FROM abos.temporary_fundings
   WHERE id = p_funding_id AND legal_entity_id = v_entity FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'temporary funding is not available in this legal entity' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF EXISTS (SELECT 1 FROM abos.temporary_funding_decisions decision
              WHERE decision.temporary_funding_id = funding.id AND decision.decided_by_user_account_id = v_actor
                AND decision.decision = p_decision) THEN
    RETURN jsonb_build_object('funding', abos.temporary_funding_json(funding.id), 'replayed', true);
  END IF;
  IF funding.version <> p_expected_version THEN
    RAISE EXCEPTION 'temporary funding changed; reload and try again' USING ERRCODE = 'serialization_failure';
  END IF;
  IF funding.status <> 'PENDING_APPROVAL' THEN
    RAISE EXCEPTION 'temporary funding is not waiting for approval' USING ERRCODE = 'check_violation';
  END IF;
  IF funding.created_by_user_account_id = v_actor OR funding.provider_user_account_id IS NOT DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'the creator or the funding provider cannot decide the same temporary funding'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO abos.temporary_funding_decisions
    (id, legal_entity_id, temporary_funding_id, decision, decision_note, decided_by_user_account_id)
  VALUES (gen_random_uuid(), v_entity, funding.id, p_decision, v_note, v_actor);
  IF p_decision = 'APPROVED' THEN
    PERFORM abos.temporary_funding_post(funding.id, v_actor);
  ELSE
    UPDATE abos.temporary_fundings
       SET status = 'REJECTED', status_reason = v_note, version = version + 1, updated_at = clock_timestamp()
     WHERE id = funding.id;
  END IF;
  PERFORM abos.temporary_funding_audit(v_actor, v_entity, funding.correlation_id,
    'TEMPORARY_FUNDING_' || p_decision, 'TEMPORARY_FUNDING', funding.id, abos.temporary_funding_json(funding.id));
  RETURN jsonb_build_object('funding', abos.temporary_funding_json(funding.id), 'replayed', false);
END
$decide$;

CREATE FUNCTION abos.temporary_funding_cancel(
  p_identity_proof text, p_runtime_token_sha256 text, p_token_sha256 text,
  p_funding_id uuid, p_expected_version integer, p_reason text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $cancel$
DECLARE
  v_context jsonb;
  v_actor uuid;
  v_entity uuid;
  v_reason text := NULLIF(btrim(p_reason), '');
  funding abos.temporary_fundings%ROWTYPE;
BEGIN
  v_context := abos.temporary_funding_actor(p_identity_proof, p_runtime_token_sha256, p_token_sha256,
    ARRAY['finance.temporary-funding.create']);
  v_actor := (v_context ->> 'userAccountId')::uuid;
  v_entity := (v_context ->> 'legalEntityId')::uuid;
  IF p_funding_id IS NULL OR p_expected_version IS NULL OR v_reason IS NULL
     OR length(v_reason) NOT BETWEEN 5 AND 500 THEN
    RAISE EXCEPTION 'funding, current version and a 5-500 character reason are required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('abos-temporary-funding:' || p_funding_id::text, 0));
  SELECT * INTO funding FROM abos.temporary_fundings
   WHERE id = p_funding_id AND legal_entity_id = v_entity FOR UPDATE;
  IF NOT FOUND OR funding.created_by_user_account_id <> v_actor THEN
    RAISE EXCEPTION 'only the creator can cancel a pending temporary funding' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF funding.status = 'CANCELLED' THEN
    RETURN jsonb_build_object('funding', abos.temporary_funding_json(funding.id), 'replayed', true);
  END IF;
  IF funding.version <> p_expected_version THEN
    RAISE EXCEPTION 'temporary funding changed; reload and try again' USING ERRCODE = 'serialization_failure';
  END IF;
  IF funding.status <> 'PENDING_APPROVAL' THEN
    RAISE EXCEPTION 'only a pending temporary funding can be cancelled' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE abos.temporary_fundings
     SET status = 'CANCELLED', status_reason = v_reason, version = version + 1, updated_at = clock_timestamp()
   WHERE id = funding.id;
  PERFORM abos.temporary_funding_audit(v_actor, v_entity, funding.correlation_id, 'TEMPORARY_FUNDING_CANCELLED',
    'TEMPORARY_FUNDING', funding.id, abos.temporary_funding_json(funding.id));
  RETURN jsonb_build_object('funding', abos.temporary_funding_json(funding.id), 'replayed', false);
END
$cancel$;

CREATE FUNCTION abos.temporary_funding_settlement_create(
  p_identity_proof text, p_runtime_token_sha256 text, p_token_sha256 text, p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $create$
DECLARE
  v_context jsonb;
  v_actor uuid;
  v_entity uuid;
  v_unknown text;
  v_funding_id uuid;
  v_treasury uuid;
  v_reference text;
  v_note text;
  v_date date;
  v_amount numeric;
  v_correlation uuid;
  v_key text;
  v_fingerprint text;
  v_scope text;
  v_replay jsonb;
  v_policy uuid;
  v_reserved numeric;
  funding abos.temporary_fundings%ROWTYPE;
  v_id uuid := gen_random_uuid();
  v_response jsonb;
BEGIN
  v_context := abos.temporary_funding_actor(p_identity_proof, p_runtime_token_sha256, p_token_sha256,
    ARRAY['finance.temporary-funding.settle']);
  v_actor := (v_context ->> 'userAccountId')::uuid;
  v_entity := (v_context ->> 'legalEntityId')::uuid;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'settlement details must be an object' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT string_agg(payload_key, ', ') INTO v_unknown FROM jsonb_object_keys(p_payload) payload_key
   WHERE payload_key NOT IN ('temporaryFundingId', 'treasuryAccountId', 'reference', 'note', 'businessDate',
     'originalAmount', 'correlationId', 'idempotencyKey');
  IF v_unknown IS NOT NULL THEN
    RAISE EXCEPTION 'unknown settlement fields: %', v_unknown USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_amount := abos.temporary_funding_amount(p_payload ->> 'originalAmount');
  v_funding_id := NULLIF(p_payload ->> 'temporaryFundingId', '')::uuid;
  v_treasury := NULLIF(p_payload ->> 'treasuryAccountId', '')::uuid;
  v_reference := NULLIF(btrim(p_payload ->> 'reference'), '');
  v_note := NULLIF(btrim(p_payload ->> 'note'), '');
  v_date := NULLIF(p_payload ->> 'businessDate', '')::date;
  v_correlation := NULLIF(p_payload ->> 'correlationId', '')::uuid;
  v_key := NULLIF(btrim(p_payload ->> 'idempotencyKey'), '');
  IF v_funding_id IS NULL OR v_treasury IS NULL OR v_date IS NULL OR v_correlation IS NULL
     OR v_reference IS NULL OR length(v_reference) > 120 OR (v_note IS NOT NULL AND length(v_note) > 1000)
     OR v_key IS NULL OR length(v_key) NOT BETWEEN 8 AND 200 THEN
    RAISE EXCEPTION 'complete valid settlement details are required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_fingerprint := encode(sha256(convert_to(jsonb_build_object(
    'actorId', v_actor, 'temporaryFundingId', v_funding_id, 'treasuryAccountId', v_treasury,
    'reference', v_reference, 'note', v_note, 'businessDate', v_date, 'originalAmount', v_amount::text,
    'correlationId', v_correlation)::text, 'UTF8')), 'hex');
  v_scope := v_entity::text || ':TEMPORARY_FUNDING_SETTLEMENT_CREATE';
  v_replay := abos.temporary_funding_idempotency_begin(v_scope, v_key, v_fingerprint, v_correlation);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('abos-temporary-funding:' || v_funding_id::text, 0));
  SELECT * INTO funding FROM abos.temporary_fundings
   WHERE id = v_funding_id AND legal_entity_id = v_entity FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'temporary funding is not available in this legal entity' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF funding.status <> 'POSTED' THEN
    RAISE EXCEPTION 'only a posted, unreversed temporary funding can be settled' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM abos.temporary_funding_reversals reversal
              WHERE reversal.temporary_funding_id = funding.id AND reversal.status = 'REQUESTED') THEN
    RAISE EXCEPTION 'a reversal is waiting for a decision on this funding' USING ERRCODE = 'check_violation';
  END IF;
  -- Reservation rule (under the funding row lock): pending plus posted settlements never exceed funding.
  SELECT COALESCE(sum(base_amount), 0) INTO v_reserved FROM abos.temporary_funding_settlements
   WHERE temporary_funding_id = funding.id AND status IN ('PENDING_APPROVAL', 'POSTED');
  IF v_reserved + v_amount > funding.base_amount THEN
    RAISE EXCEPTION 'settlement exceeds the outstanding amount of %', (funding.base_amount - v_reserved)::text
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_date < funding.business_date THEN
    RAISE EXCEPTION 'a settlement cannot be dated before its funding' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM abos.operational_treasury_accounts account
                  WHERE account.id = v_treasury AND account.legal_entity_id = v_entity
                    AND account.status = 'ACTIVE' AND account.currency_code = funding.original_currency_code) THEN
    RAISE EXCEPTION 'an active same-currency Safe or bank account is required' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM abos.temporary_funding_period_open(v_entity, v_date);
  v_policy := abos.temporary_funding_policy_id(v_entity);
  INSERT INTO abos.temporary_funding_settlements
    (id, legal_entity_id, temporary_funding_id, operational_treasury_account_id, reference, note, business_date,
     original_amount, original_currency_code, base_amount, base_currency_code, workflow_policy_version_id,
     correlation_id, idempotency_key, request_fingerprint, status, version, created_by_user_account_id)
  VALUES
    (v_id, v_entity, funding.id, v_treasury, v_reference, v_note, v_date, v_amount, funding.original_currency_code,
     v_amount, funding.base_currency_code, v_policy, v_correlation, v_key, v_fingerprint, 'PENDING_APPROVAL', 1,
     v_actor);
  v_response := jsonb_build_object('settlement', abos.temporary_funding_settlement_json(v_id),
    'funding', abos.temporary_funding_json(funding.id), 'replayed', false);
  PERFORM abos.temporary_funding_idempotency_complete(v_scope, v_key, 'TEMPORARY_FUNDING_SETTLEMENT', v_id, v_response);
  PERFORM abos.temporary_funding_audit(v_actor, v_entity, v_correlation, 'TEMPORARY_FUNDING_SETTLEMENT_SUBMITTED',
    'TEMPORARY_FUNDING_SETTLEMENT', v_id, abos.temporary_funding_settlement_json(v_id));
  RETURN v_response;
END
$create$;

CREATE FUNCTION abos.temporary_funding_settlement_decide(
  p_identity_proof text, p_runtime_token_sha256 text, p_token_sha256 text,
  p_settlement_id uuid, p_expected_version integer, p_decision text, p_note text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $decide$
DECLARE
  v_context jsonb;
  v_actor uuid;
  v_entity uuid;
  v_note text := NULLIF(btrim(p_note), '');
  v_funding_id uuid;
  settlement abos.temporary_funding_settlements%ROWTYPE;
  funding abos.temporary_fundings%ROWTYPE;
BEGIN
  v_context := abos.temporary_funding_actor(p_identity_proof, p_runtime_token_sha256, p_token_sha256,
    ARRAY['finance.temporary-funding.settle-approve']);
  v_actor := (v_context ->> 'userAccountId')::uuid;
  v_entity := (v_context ->> 'legalEntityId')::uuid;
  IF p_settlement_id IS NULL OR p_expected_version IS NULL OR p_expected_version < 1
     OR p_decision IS NULL OR p_decision NOT IN ('APPROVED', 'REJECTED')
     OR v_note IS NULL OR length(v_note) NOT BETWEEN 5 AND 500 THEN
    RAISE EXCEPTION 'settlement, current version, a decision and a 5-500 character note are required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT temporary_funding_id INTO v_funding_id FROM abos.temporary_funding_settlements
   WHERE id = p_settlement_id AND legal_entity_id = v_entity;
  IF v_funding_id IS NULL THEN
    RAISE EXCEPTION 'settlement is not available in this legal entity' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('abos-temporary-funding:' || v_funding_id::text, 0));
  SELECT * INTO funding FROM abos.temporary_fundings WHERE id = v_funding_id FOR UPDATE;
  SELECT * INTO settlement FROM abos.temporary_funding_settlements WHERE id = p_settlement_id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM abos.temporary_funding_settlement_decisions decision
              WHERE decision.settlement_id = settlement.id AND decision.decided_by_user_account_id = v_actor
                AND decision.decision = p_decision) THEN
    RETURN jsonb_build_object('settlement', abos.temporary_funding_settlement_json(settlement.id),
      'funding', abos.temporary_funding_json(funding.id), 'replayed', true);
  END IF;
  IF settlement.version <> p_expected_version THEN
    RAISE EXCEPTION 'settlement changed; reload and try again' USING ERRCODE = 'serialization_failure';
  END IF;
  IF settlement.status <> 'PENDING_APPROVAL' THEN
    RAISE EXCEPTION 'settlement is not waiting for approval' USING ERRCODE = 'check_violation';
  END IF;
  IF settlement.created_by_user_account_id = v_actor OR funding.provider_user_account_id IS NOT DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'the settlement creator or the funding provider cannot decide the same settlement'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO abos.temporary_funding_settlement_decisions
    (id, legal_entity_id, settlement_id, decision, decision_note, decided_by_user_account_id)
  VALUES (gen_random_uuid(), v_entity, settlement.id, p_decision, v_note, v_actor);
  IF p_decision = 'APPROVED' THEN
    PERFORM abos.temporary_funding_settlement_post(settlement.id, v_actor);
  ELSE
    UPDATE abos.temporary_funding_settlements
       SET status = 'REJECTED', status_reason = v_note, version = version + 1, updated_at = clock_timestamp()
     WHERE id = settlement.id;
  END IF;
  PERFORM abos.temporary_funding_audit(v_actor, v_entity, settlement.correlation_id,
    'TEMPORARY_FUNDING_SETTLEMENT_' || p_decision, 'TEMPORARY_FUNDING_SETTLEMENT', settlement.id,
    abos.temporary_funding_settlement_json(settlement.id));
  RETURN jsonb_build_object('settlement', abos.temporary_funding_settlement_json(settlement.id),
    'funding', abos.temporary_funding_json(funding.id), 'replayed', false);
END
$decide$;

CREATE FUNCTION abos.temporary_funding_settlement_cancel(
  p_identity_proof text, p_runtime_token_sha256 text, p_token_sha256 text,
  p_settlement_id uuid, p_expected_version integer, p_reason text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $cancel$
DECLARE
  v_context jsonb;
  v_actor uuid;
  v_entity uuid;
  v_reason text := NULLIF(btrim(p_reason), '');
  v_funding_id uuid;
  settlement abos.temporary_funding_settlements%ROWTYPE;
BEGIN
  v_context := abos.temporary_funding_actor(p_identity_proof, p_runtime_token_sha256, p_token_sha256,
    ARRAY['finance.temporary-funding.settle']);
  v_actor := (v_context ->> 'userAccountId')::uuid;
  v_entity := (v_context ->> 'legalEntityId')::uuid;
  IF p_settlement_id IS NULL OR p_expected_version IS NULL OR v_reason IS NULL
     OR length(v_reason) NOT BETWEEN 5 AND 500 THEN
    RAISE EXCEPTION 'settlement, current version and a 5-500 character reason are required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT temporary_funding_id INTO v_funding_id FROM abos.temporary_funding_settlements
   WHERE id = p_settlement_id AND legal_entity_id = v_entity;
  IF v_funding_id IS NULL THEN
    RAISE EXCEPTION 'settlement is not available in this legal entity' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('abos-temporary-funding:' || v_funding_id::text, 0));
  PERFORM 1 FROM abos.temporary_fundings WHERE id = v_funding_id FOR UPDATE;
  SELECT * INTO settlement FROM abos.temporary_funding_settlements WHERE id = p_settlement_id FOR UPDATE;
  IF settlement.created_by_user_account_id <> v_actor THEN
    RAISE EXCEPTION 'only the creator can cancel a pending settlement' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF settlement.status = 'CANCELLED' THEN
    RETURN jsonb_build_object('settlement', abos.temporary_funding_settlement_json(settlement.id), 'replayed', true);
  END IF;
  IF settlement.version <> p_expected_version THEN
    RAISE EXCEPTION 'settlement changed; reload and try again' USING ERRCODE = 'serialization_failure';
  END IF;
  IF settlement.status <> 'PENDING_APPROVAL' THEN
    RAISE EXCEPTION 'only a pending settlement can be cancelled' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE abos.temporary_funding_settlements
     SET status = 'CANCELLED', status_reason = v_reason, version = version + 1, updated_at = clock_timestamp()
   WHERE id = settlement.id;
  PERFORM abos.temporary_funding_audit(v_actor, v_entity, settlement.correlation_id,
    'TEMPORARY_FUNDING_SETTLEMENT_CANCELLED', 'TEMPORARY_FUNDING_SETTLEMENT', settlement.id,
    abos.temporary_funding_settlement_json(settlement.id));
  RETURN jsonb_build_object('settlement', abos.temporary_funding_settlement_json(settlement.id), 'replayed', false);
END
$cancel$;

CREATE FUNCTION abos.temporary_funding_reversal_request(
  p_identity_proof text, p_runtime_token_sha256 text, p_token_sha256 text, p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $request$
DECLARE
  v_context jsonb;
  v_actor uuid;
  v_entity uuid;
  v_unknown text;
  v_funding_id uuid;
  v_date date;
  v_reason text;
  v_correlation uuid;
  v_key text;
  v_fingerprint text;
  v_scope text;
  v_replay jsonb;
  funding abos.temporary_fundings%ROWTYPE;
  v_id uuid := gen_random_uuid();
  v_response jsonb;
BEGIN
  v_context := abos.temporary_funding_actor(p_identity_proof, p_runtime_token_sha256, p_token_sha256,
    ARRAY['finance.temporary-funding.reverse']);
  v_actor := (v_context ->> 'userAccountId')::uuid;
  v_entity := (v_context ->> 'legalEntityId')::uuid;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'reversal details must be an object' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT string_agg(payload_key, ', ') INTO v_unknown FROM jsonb_object_keys(p_payload) payload_key
   WHERE payload_key NOT IN ('temporaryFundingId', 'reversalDate', 'reason', 'correlationId', 'idempotencyKey');
  IF v_unknown IS NOT NULL THEN
    RAISE EXCEPTION 'unknown reversal fields: %', v_unknown USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_funding_id := NULLIF(p_payload ->> 'temporaryFundingId', '')::uuid;
  v_date := NULLIF(p_payload ->> 'reversalDate', '')::date;
  v_reason := NULLIF(btrim(p_payload ->> 'reason'), '');
  v_correlation := NULLIF(p_payload ->> 'correlationId', '')::uuid;
  v_key := NULLIF(btrim(p_payload ->> 'idempotencyKey'), '');
  IF v_funding_id IS NULL OR v_date IS NULL OR v_correlation IS NULL OR v_reason IS NULL
     OR length(v_reason) NOT BETWEEN 5 AND 1000 OR v_key IS NULL OR length(v_key) NOT BETWEEN 8 AND 200 THEN
    RAISE EXCEPTION 'complete valid reversal details are required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_fingerprint := encode(sha256(convert_to(jsonb_build_object(
    'actorId', v_actor, 'temporaryFundingId', v_funding_id, 'reversalDate', v_date, 'reason', v_reason,
    'correlationId', v_correlation)::text, 'UTF8')), 'hex');
  v_scope := v_entity::text || ':TEMPORARY_FUNDING_REVERSAL_REQUEST';
  v_replay := abos.temporary_funding_idempotency_begin(v_scope, v_key, v_fingerprint, v_correlation);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('abos-temporary-funding:' || v_funding_id::text, 0));
  SELECT * INTO funding FROM abos.temporary_fundings
   WHERE id = v_funding_id AND legal_entity_id = v_entity FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'temporary funding is not available in this legal entity' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF funding.status <> 'POSTED' THEN
    RAISE EXCEPTION 'only a posted temporary funding can be reversed' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM abos.temporary_funding_settlements settlement
              WHERE settlement.temporary_funding_id = funding.id
                AND settlement.status IN ('PENDING_APPROVAL', 'POSTED')) THEN
    RAISE EXCEPTION 'a temporary funding with pending or posted settlements cannot be reversed'
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM abos.temporary_funding_reversals reversal
              WHERE reversal.temporary_funding_id = funding.id AND reversal.status = 'REQUESTED') THEN
    RAISE EXCEPTION 'a reversal is already waiting for a decision' USING ERRCODE = 'check_violation';
  END IF;
  IF v_date < funding.business_date THEN
    RAISE EXCEPTION 'a reversal cannot be dated before its funding' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM abos.temporary_funding_period_open(v_entity, v_date);
  INSERT INTO abos.temporary_funding_reversals
    (id, legal_entity_id, temporary_funding_id, original_journal_id, reversal_date, reason, correlation_id,
     idempotency_key, request_fingerprint, status, version, requested_by_user_account_id)
  VALUES
    (v_id, v_entity, funding.id, funding.journal_id, v_date, v_reason, v_correlation, v_key, v_fingerprint,
     'REQUESTED', 1, v_actor);
  v_response := jsonb_build_object('funding', abos.temporary_funding_json(funding.id), 'reversalId', v_id,
    'replayed', false);
  PERFORM abos.temporary_funding_idempotency_complete(v_scope, v_key, 'TEMPORARY_FUNDING_REVERSAL', v_id, v_response);
  PERFORM abos.temporary_funding_audit(v_actor, v_entity, v_correlation, 'TEMPORARY_FUNDING_REVERSAL_REQUESTED',
    'TEMPORARY_FUNDING', funding.id, jsonb_build_object('reversalId', v_id, 'reversalDate', v_date,
      'reason', v_reason));
  RETURN v_response;
END
$request$;

CREATE FUNCTION abos.temporary_funding_reversal_decide(
  p_identity_proof text, p_runtime_token_sha256 text, p_token_sha256 text,
  p_reversal_id uuid, p_expected_version integer, p_decision text, p_note text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $decide$
DECLARE
  v_context jsonb;
  v_actor uuid;
  v_entity uuid;
  v_note text := NULLIF(btrim(p_note), '');
  v_funding_id uuid;
  reversal abos.temporary_funding_reversals%ROWTYPE;
  funding abos.temporary_fundings%ROWTYPE;
BEGIN
  v_context := abos.temporary_funding_actor(p_identity_proof, p_runtime_token_sha256, p_token_sha256,
    ARRAY['finance.temporary-funding.reverse']);
  v_actor := (v_context ->> 'userAccountId')::uuid;
  v_entity := (v_context ->> 'legalEntityId')::uuid;
  IF p_reversal_id IS NULL OR p_expected_version IS NULL OR p_expected_version < 1
     OR p_decision IS NULL OR p_decision NOT IN ('APPROVED', 'REJECTED')
     OR v_note IS NULL OR length(v_note) NOT BETWEEN 5 AND 500 THEN
    RAISE EXCEPTION 'reversal, current version, a decision and a 5-500 character note are required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT temporary_funding_id INTO v_funding_id FROM abos.temporary_funding_reversals
   WHERE id = p_reversal_id AND legal_entity_id = v_entity;
  IF v_funding_id IS NULL THEN
    RAISE EXCEPTION 'reversal is not available in this legal entity' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('abos-temporary-funding:' || v_funding_id::text, 0));
  SELECT * INTO funding FROM abos.temporary_fundings WHERE id = v_funding_id FOR UPDATE;
  SELECT * INTO reversal FROM abos.temporary_funding_reversals WHERE id = p_reversal_id FOR UPDATE;
  IF reversal.decided_by_user_account_id = v_actor
     AND reversal.status = (CASE p_decision WHEN 'APPROVED' THEN 'POSTED' ELSE 'REJECTED' END) THEN
    RETURN jsonb_build_object('funding', abos.temporary_funding_json(funding.id), 'replayed', true);
  END IF;
  IF reversal.version <> p_expected_version THEN
    RAISE EXCEPTION 'reversal changed; reload and try again' USING ERRCODE = 'serialization_failure';
  END IF;
  IF reversal.status <> 'REQUESTED' THEN
    RAISE EXCEPTION 'reversal is not waiting for a decision' USING ERRCODE = 'check_violation';
  END IF;
  IF v_actor = reversal.requested_by_user_account_id OR v_actor = funding.created_by_user_account_id
     OR v_actor IS NOT DISTINCT FROM funding.provider_user_account_id
     OR EXISTS (SELECT 1 FROM abos.journals journal WHERE journal.id = funding.journal_id
                   AND journal.posted_by_user_account_id = v_actor) THEN
    RAISE EXCEPTION 'the reversal must be decided by someone independent of the request, the funding and its posting'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_decision = 'APPROVED' THEN
    PERFORM abos.temporary_funding_reversal_post(reversal.id, v_actor, v_note);
  ELSE
    UPDATE abos.temporary_funding_reversals
       SET status = 'REJECTED', version = version + 1, decided_by_user_account_id = v_actor,
           decided_at = clock_timestamp(), decision_note = v_note
     WHERE id = reversal.id;
    PERFORM abos.temporary_funding_audit(v_actor, v_entity, reversal.correlation_id,
      'TEMPORARY_FUNDING_REVERSAL_REJECTED', 'TEMPORARY_FUNDING', funding.id,
      jsonb_build_object('reversalId', reversal.id, 'note', v_note));
  END IF;
  RETURN jsonb_build_object('funding', abos.temporary_funding_json(funding.id), 'replayed', false);
END
$decide$;

-- ---------------------------------------------------------------------------------------------------
-- 11. Least-privilege owner and runtime boundary
-- ---------------------------------------------------------------------------------------------------
GRANT SELECT ON abos.temporary_fundings, abos.temporary_funding_decisions, abos.temporary_funding_settlements,
  abos.temporary_funding_settlement_decisions, abos.temporary_funding_reversals,
  abos.temporary_funding_account_mapping_versions, abos.operational_treasury_cash_controls,
  abos.journal_reversal_links
TO abos_v1_operational_finance_owner;
GRANT SELECT (id, legal_entity_id, evidence_kind) ON abos.evidence_references TO abos_v1_operational_finance_owner;
GRANT SELECT (id, legal_entity_id, account_code, account_name, account_type, control_account_type,
  posting_allowed, requires_project, requires_department, requires_cost_center, account_currency_code, status)
  ON abos.ledger_accounts TO abos_v1_operational_finance_owner;
GRANT INSERT (id, legal_entity_id, funding_mode, provider_kind, provider_business_party_id,
  provider_user_account_id, operational_expense_category_id, payee_business_party_id, project_id, department_id,
  cost_center_id, operational_treasury_account_id, reference, description, note, business_date, original_amount,
  original_currency_code, base_amount, base_currency_code, workflow_policy_version_id, mapping_version_id,
  correlation_id, idempotency_key, request_fingerprint, status, version, created_by_user_account_id)
  ON abos.temporary_fundings TO abos_v1_operational_finance_owner;
GRANT UPDATE (status, status_reason, version, journal_id, updated_at)
  ON abos.temporary_fundings TO abos_v1_operational_finance_owner;
GRANT INSERT (id, legal_entity_id, temporary_funding_id, decision, decision_note, decided_by_user_account_id)
  ON abos.temporary_funding_decisions TO abos_v1_operational_finance_owner;
GRANT INSERT (id, legal_entity_id, temporary_funding_id, operational_treasury_account_id, reference, note,
  business_date, original_amount, original_currency_code, base_amount, base_currency_code,
  workflow_policy_version_id, correlation_id, idempotency_key, request_fingerprint, status, version,
  created_by_user_account_id)
  ON abos.temporary_funding_settlements TO abos_v1_operational_finance_owner;
GRANT UPDATE (status, status_reason, version, journal_id, updated_at)
  ON abos.temporary_funding_settlements TO abos_v1_operational_finance_owner;
GRANT INSERT (id, legal_entity_id, settlement_id, decision, decision_note, decided_by_user_account_id)
  ON abos.temporary_funding_settlement_decisions TO abos_v1_operational_finance_owner;
GRANT INSERT (id, legal_entity_id, temporary_funding_id, original_journal_id, reversal_date, reason,
  correlation_id, idempotency_key, request_fingerprint, status, version, requested_by_user_account_id)
  ON abos.temporary_funding_reversals TO abos_v1_operational_finance_owner;
GRANT UPDATE (status, version, decided_by_user_account_id, decided_at, decision_note, reversal_journal_id,
  evidence_reference_id)
  ON abos.temporary_funding_reversals TO abos_v1_operational_finance_owner;
GRANT INSERT (id, legal_entity_id, version, payable_ledger_account_id, configured_by_user_account_id, change_reason)
  ON abos.temporary_funding_account_mapping_versions TO abos_v1_operational_finance_owner;
GRANT INSERT (temporary_funding_id, temporary_funding_settlement_id, temporary_funding_reversal_id,
  temporary_funding_mapping_version_id, finance_workflow_policy_version_id)
  ON abos.posting_intents TO abos_v1_operational_finance_owner;
GRANT INSERT (business_party_id, temporary_funding_id) ON abos.subledger_entries TO abos_v1_operational_finance_owner;
GRANT INSERT (id, legal_entity_id, document_id, evidence_kind, evidence_version, sha256, completed_at)
  ON abos.evidence_references TO abos_v1_operational_finance_owner;
GRANT INSERT (original_journal_id, reversal_journal_id, reason, approved_by_user_account_id, evidence_reference_id)
  ON abos.journal_reversal_links TO abos_v1_operational_finance_owner;

REVOKE ALL ON FUNCTION
  abos.guard_temporary_funding_mapping(), abos.guard_temporary_funding(), abos.guard_temporary_funding_decision(),
  abos.guard_temporary_funding_settlement(), abos.guard_temporary_funding_settlement_decision(),
  abos.guard_temporary_funding_reversal(), abos.guard_temporary_funding_policy(),
  abos.validate_temporary_funding_reversal_link(),
  abos.validate_temporary_funding_journal(uuid, uuid, uuid, uuid, date, text),
  abos.operational_treasury_recorded_cash(uuid, uuid),
  abos.operational_treasury_cash_guard(uuid, uuid, numeric, date),
  abos.temporary_funding_actor(text, text, text, text[]), abos.temporary_funding_amount(text),
  abos.temporary_funding_idempotency_begin(text, text, text, uuid),
  abos.temporary_funding_idempotency_complete(text, text, text, uuid, jsonb),
  abos.temporary_funding_audit(uuid, uuid, uuid, text, text, uuid, jsonb),
  abos.temporary_funding_policy_id(uuid), abos.temporary_funding_period_open(uuid, date),
  abos.temporary_funding_settlement_json(uuid), abos.temporary_funding_json(uuid),
  abos.temporary_funding_post(uuid, uuid), abos.temporary_funding_settlement_post(uuid, uuid),
  abos.temporary_funding_reversal_post(uuid, uuid, text),
  abos.temporary_funding_workspace(text, text, text),
  abos.temporary_funding_configure(text, text, text, uuid, integer, text),
  abos.temporary_funding_create(text, text, text, jsonb),
  abos.temporary_funding_decide(text, text, text, uuid, integer, text, text),
  abos.temporary_funding_cancel(text, text, text, uuid, integer, text),
  abos.temporary_funding_settlement_create(text, text, text, jsonb),
  abos.temporary_funding_settlement_decide(text, text, text, uuid, integer, text, text),
  abos.temporary_funding_settlement_cancel(text, text, text, uuid, integer, text),
  abos.temporary_funding_reversal_request(text, text, text, jsonb),
  abos.temporary_funding_reversal_decide(text, text, text, uuid, integer, text, text)
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
  abos.validate_temporary_funding_journal(uuid, uuid, uuid, uuid, date, text),
  abos.operational_treasury_recorded_cash(uuid, uuid),
  abos.operational_treasury_cash_guard(uuid, uuid, numeric, date),
  abos.temporary_funding_actor(text, text, text, text[]), abos.temporary_funding_amount(text),
  abos.temporary_funding_idempotency_begin(text, text, text, uuid),
  abos.temporary_funding_idempotency_complete(text, text, text, uuid, jsonb),
  abos.temporary_funding_audit(uuid, uuid, uuid, text, text, uuid, jsonb),
  abos.temporary_funding_policy_id(uuid), abos.temporary_funding_period_open(uuid, date),
  abos.temporary_funding_settlement_json(uuid), abos.temporary_funding_json(uuid),
  abos.temporary_funding_post(uuid, uuid), abos.temporary_funding_settlement_post(uuid, uuid),
  abos.temporary_funding_reversal_post(uuid, uuid, text)
TO abos_v1_operational_finance_owner;

ALTER FUNCTION abos.temporary_funding_workspace(text, text, text) OWNER TO abos_v1_operational_finance_owner;
ALTER FUNCTION abos.temporary_funding_configure(text, text, text, uuid, integer, text)
  OWNER TO abos_v1_operational_finance_owner;
ALTER FUNCTION abos.temporary_funding_create(text, text, text, jsonb) OWNER TO abos_v1_operational_finance_owner;
ALTER FUNCTION abos.temporary_funding_decide(text, text, text, uuid, integer, text, text)
  OWNER TO abos_v1_operational_finance_owner;
ALTER FUNCTION abos.temporary_funding_cancel(text, text, text, uuid, integer, text)
  OWNER TO abos_v1_operational_finance_owner;
ALTER FUNCTION abos.temporary_funding_settlement_create(text, text, text, jsonb)
  OWNER TO abos_v1_operational_finance_owner;
ALTER FUNCTION abos.temporary_funding_settlement_decide(text, text, text, uuid, integer, text, text)
  OWNER TO abos_v1_operational_finance_owner;
ALTER FUNCTION abos.temporary_funding_settlement_cancel(text, text, text, uuid, integer, text)
  OWNER TO abos_v1_operational_finance_owner;
ALTER FUNCTION abos.temporary_funding_reversal_request(text, text, text, jsonb)
  OWNER TO abos_v1_operational_finance_owner;
ALTER FUNCTION abos.temporary_funding_reversal_decide(text, text, text, uuid, integer, text, text)
  OWNER TO abos_v1_operational_finance_owner;

GRANT EXECUTE ON FUNCTION
  abos.temporary_funding_workspace(text, text, text),
  abos.temporary_funding_configure(text, text, text, uuid, integer, text),
  abos.temporary_funding_create(text, text, text, jsonb),
  abos.temporary_funding_decide(text, text, text, uuid, integer, text, text),
  abos.temporary_funding_cancel(text, text, text, uuid, integer, text),
  abos.temporary_funding_settlement_create(text, text, text, jsonb),
  abos.temporary_funding_settlement_decide(text, text, text, uuid, integer, text, text),
  abos.temporary_funding_settlement_cancel(text, text, text, uuid, integer, text),
  abos.temporary_funding_reversal_request(text, text, text, jsonb),
  abos.temporary_funding_reversal_decide(text, text, text, uuid, integer, text, text)
TO abos_e1_runtime;

REVOKE ALL ON abos.temporary_fundings, abos.temporary_funding_decisions, abos.temporary_funding_settlements,
  abos.temporary_funding_settlement_decisions, abos.temporary_funding_reversals,
  abos.temporary_funding_account_mapping_versions, abos.operational_treasury_cash_controls
  FROM PUBLIC, abos_v1_identity_runtime, abos_e1_runtime, abos_e1_treasury_runtime;
