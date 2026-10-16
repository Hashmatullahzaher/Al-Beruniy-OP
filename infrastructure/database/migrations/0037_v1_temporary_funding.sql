-- V1 Temporary Funding: first production slice, base currency only.
--
-- When a person or organization temporarily funds the business, the company records an explicit
-- per-provider liability (control type TEMPORARY_FUNDING_PAYABLE). Physical Safe cash is never used
-- to represent a shortage.
--   PROVIDER_PAID_EXPENSE_DIRECTLY: Dr Expense / Cr Temporary Funding Payable (provider). No Safe effect.
--   PROVIDER_FUNDED_SAFE:          Dr Safe    / Cr Temporary Funding Payable (provider). Safe +amount.
--   Settlement:                    Dr Temporary Funding Payable (provider) / Cr approved Treasury source.
-- Every funding and settlement is independently approved and posted by its approver in the same
-- transaction. Reversal, foreign currency and the Safe non-negative guard are NOT active in this slice.
-- Extends the 0036 model-aware Operational V1 dispatch; reuses posting_intents
-- .finance_workflow_policy_version_id and .operational_version. No business row is seeded or
-- backfilled and no existing ledger account is reclassified.

INSERT INTO abos.permission_catalogue
  (permission_code, catalogue_version, category, availability,
   independence_enforced, administrative, sort_order)
VALUES
  ('finance.temporary-funding.read',           10, 'FINANCE', 'ACTIVE', false, false, 600),
  ('finance.temporary-funding.record',         10, 'FINANCE', 'ACTIVE', false, false, 610),
  ('finance.temporary-funding.approve',        10, 'FINANCE', 'ACTIVE', true,  false, 620),
  ('finance.temporary-funding.settle',         10, 'FINANCE', 'ACTIVE', false, false, 630),
  ('finance.temporary-funding.settle-approve', 10, 'FINANCE', 'ACTIVE', true,  false, 640),
  ('finance.temporary-funding.configure',      10, 'FINANCE', 'ACTIVE', false, false, 650);

-- Exact evidence taxonomy (0036 list plus the funding payable mapping evidence).
ALTER TABLE abos.evidence_references
  DROP CONSTRAINT evidence_references_evidence_kind_check;
ALTER TABLE abos.evidence_references
  ADD CONSTRAINT evidence_references_evidence_kind_check CHECK (evidence_kind IN
    ('CAPITAL_AGREEMENT', 'FORMAL_REGISTRATION', 'PHYSICAL_CASH_COUNT', 'CASH_RECEIPT',
     'OPENING_RECONCILIATION', 'FINANCE_APPROVAL', 'REVERSAL_REASON',
     'BANK_CONFIRMATION', 'SARAF_CONFIRMATION', 'CONTROLLED_EVIDENCE',
     'CAPITAL_ACCOUNT_MAPPING', 'TEMPORARY_FUNDING_ACCOUNT_MAPPING'));

-- Dedicated control type. Existing accounts are not converted, classified or backfilled.
ALTER TABLE abos.ledger_accounts DROP CONSTRAINT ledger_accounts_control_account_type_check;
ALTER TABLE abos.ledger_accounts ADD CONSTRAINT ledger_accounts_control_account_type_check
  CHECK (control_account_type IS NULL OR control_account_type IN
    ('CASH', 'SHAREHOLDER_CAPITAL', 'SHAREHOLDER_LOAN', 'AR', 'AP', 'SARAF', 'OTHER',
     'TEMPORARY_FUNDING_PAYABLE'));

-- Chart of Accounts rules (0014) gain the new control type; a funding payable is always a LIABILITY.
CREATE OR REPLACE FUNCTION abos.coa_validate(
  p_code text, p_name text, p_name_fa text, p_description text, p_type text, p_control text,
  p_currency text, p_posting boolean, p_status text
) RETURNS void
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
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
                                                 'TEMPORARY_FUNDING_PAYABLE') THEN
    RAISE EXCEPTION 'unknown control account type %', p_control USING ERRCODE = 'check_violation';
  END IF;
  -- A control account must carry the account type its balance has by definition.
  IF (p_control IN ('CASH', 'AR') AND p_type <> 'ASSET')
     OR (p_control IN ('AP', 'SHAREHOLDER_LOAN', 'TEMPORARY_FUNDING_PAYABLE') AND p_type <> 'LIABILITY')
     OR (p_control = 'SHAREHOLDER_CAPITAL' AND p_type <> 'EQUITY')
     OR (p_control = 'SARAF' AND p_type NOT IN ('ASSET', 'LIABILITY')) THEN
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
$$;

ALTER TABLE abos.finance_workflow_types
  DROP CONSTRAINT finance_workflow_types_workflow_type_check,
  ADD CONSTRAINT finance_workflow_types_workflow_type_check CHECK (workflow_type IN (
    'SHAREHOLDER_CAPITAL_RECEIPT', 'CUSTOMER_RECEIPT', 'OTHER_INCOME', 'EXPENSE',
    'SUPPLIER_PAYMENT', 'SALARY_PAYMENT', 'TREASURY_TRANSFER', 'TEMPORARY_FUNDING'));
INSERT INTO abos.finance_workflow_types (workflow_type, label_en, label_fa, sort_order)
VALUES ('TEMPORARY_FUNDING', 'Temporary funding', 'تمویل موقت', 80);

-- ---------------------------------------------------------------------------------------------------
-- Domain-specific, evidence-backed, append-only payable mapping.
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE abos.temporary_funding_account_mapping_versions (
  id uuid PRIMARY KEY,
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  version integer NOT NULL CHECK (version > 0),
  payable_ledger_account_id uuid NOT NULL,
  evidence_reference_id uuid NOT NULL,
  evidence_document_reference text NOT NULL
    CHECK (length(btrim(evidence_document_reference)) BETWEEN 1 AND 200),
  change_reason text NOT NULL CHECK (length(btrim(change_reason)) BETWEEN 3 AND 500),
  configured_by_user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  configured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  correlation_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 8 AND 200),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  UNIQUE (id, legal_entity_id),
  UNIQUE (legal_entity_id, version),
  UNIQUE (legal_entity_id, idempotency_key),
  UNIQUE (evidence_reference_id),
  FOREIGN KEY (payable_ledger_account_id, legal_entity_id)
    REFERENCES abos.ledger_accounts(id, legal_entity_id),
  FOREIGN KEY (evidence_reference_id, legal_entity_id)
    REFERENCES abos.evidence_references(id, legal_entity_id)
);

CREATE FUNCTION abos.guard_temporary_funding_mapping_version()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $guard$
DECLARE v_ledger record; v_base text; v_latest integer; v_kind text;
BEGIN
  SELECT COALESCE(max(version), 0) INTO v_latest
    FROM abos.temporary_funding_account_mapping_versions WHERE legal_entity_id = NEW.legal_entity_id;
  IF NEW.version <> v_latest + 1 THEN
    RAISE EXCEPTION 'a temporary funding mapping version must follow the latest version'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT base_currency_code INTO v_base FROM abos.legal_entities
   WHERE id = NEW.legal_entity_id AND currency_policy_status = 'APPROVED';
  SELECT account_type, control_account_type, status, posting_allowed, account_currency_code,
         requires_project, requires_department, requires_cost_center
    INTO v_ledger FROM abos.ledger_accounts
   WHERE id = NEW.payable_ledger_account_id AND legal_entity_id = NEW.legal_entity_id;
  IF NOT FOUND OR v_base IS NULL
     OR v_ledger.account_type IS DISTINCT FROM 'LIABILITY'
     OR v_ledger.control_account_type IS DISTINCT FROM 'TEMPORARY_FUNDING_PAYABLE'
     OR v_ledger.status <> 'ACTIVE' OR NOT v_ledger.posting_allowed
     OR v_ledger.account_currency_code IS DISTINCT FROM v_base
     OR v_ledger.requires_project OR v_ledger.requires_department OR v_ledger.requires_cost_center THEN
    RAISE EXCEPTION 'temporary funding payable mapping requires an active posting TEMPORARY_FUNDING_PAYABLE liability account in the base currency without dimensions'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT evidence_kind INTO v_kind FROM abos.evidence_references
   WHERE id = NEW.evidence_reference_id AND legal_entity_id = NEW.legal_entity_id;
  IF v_kind IS DISTINCT FROM 'TEMPORARY_FUNDING_ACCOUNT_MAPPING' THEN
    RAISE EXCEPTION 'temporary funding payable mapping requires TEMPORARY_FUNDING_ACCOUNT_MAPPING evidence'
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.configured_at := clock_timestamp();
  RETURN NEW;
END
$guard$;
CREATE TRIGGER temporary_funding_mapping_version_guard
BEFORE INSERT ON abos.temporary_funding_account_mapping_versions
FOR EACH ROW EXECUTE FUNCTION abos.guard_temporary_funding_mapping_version();
CREATE TRIGGER temporary_funding_mapping_no_update_or_delete
BEFORE UPDATE OR DELETE ON abos.temporary_funding_account_mapping_versions
FOR EACH ROW EXECUTE FUNCTION abos.prevent_audit_mutation();
CREATE TRIGGER temporary_funding_mapping_ledger_reference
AFTER INSERT ON abos.temporary_funding_account_mapping_versions
FOR EACH ROW EXECUTE FUNCTION abos.ledger_account_mark_referenced('payable_ledger_account_id');

-- ---------------------------------------------------------------------------------------------------
-- Typed sources: fundings, their decisions, settlements and their decisions.
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE abos.temporary_fundings (
  id uuid PRIMARY KEY,
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  funding_mode text NOT NULL
    CHECK (funding_mode IN ('PROVIDER_PAID_EXPENSE_DIRECTLY', 'PROVIDER_FUNDED_SAFE')),
  provider_kind text NOT NULL
    CHECK (provider_kind IN ('SHAREHOLDER', 'EMPLOYEE_OFFICER', 'INDIVIDUAL', 'ORGANIZATION')),
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
  status text NOT NULL CHECK (status IN ('PENDING_APPROVAL', 'REJECTED', 'POSTED')),
  status_reason text CHECK (status_reason IS NULL OR length(btrim(status_reason)) BETWEEN 3 AND 500),
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
  FOREIGN KEY (operational_treasury_account_id, legal_entity_id, original_currency_code)
    REFERENCES abos.operational_treasury_accounts(id, legal_entity_id, currency_code),
  FOREIGN KEY (project_id, legal_entity_id) REFERENCES abos.projects(id, legal_entity_id),
  FOREIGN KEY (department_id, legal_entity_id) REFERENCES abos.departments(id, legal_entity_id),
  FOREIGN KEY (cost_center_id, legal_entity_id) REFERENCES abos.cost_centers(id, legal_entity_id),
  FOREIGN KEY (workflow_policy_version_id, legal_entity_id)
    REFERENCES abos.finance_workflow_policy_versions(id, legal_entity_id),
  FOREIGN KEY (mapping_version_id, legal_entity_id)
    REFERENCES abos.temporary_funding_account_mapping_versions(id, legal_entity_id),
  FOREIGN KEY (journal_id, legal_entity_id) REFERENCES abos.journals(id, legal_entity_id),
  -- Base currency only: no snapshot, conversion or FX gain/loss exists in this slice.
  CHECK (original_currency_code = base_currency_code AND original_amount = base_amount),
  CHECK ((funding_mode = 'PROVIDER_PAID_EXPENSE_DIRECTLY') = (operational_expense_category_id IS NOT NULL)),
  CHECK ((funding_mode = 'PROVIDER_FUNDED_SAFE') = (operational_treasury_account_id IS NOT NULL)),
  CHECK (funding_mode = 'PROVIDER_PAID_EXPENSE_DIRECTLY'
         OR (payee_business_party_id IS NULL AND project_id IS NULL
             AND department_id IS NULL AND cost_center_id IS NULL)),
  CHECK ((status = 'POSTED') = (journal_id IS NOT NULL)),
  CHECK ((status = 'REJECTED') = (status_reason IS NOT NULL))
);
CREATE INDEX temporary_fundings_entity_date_idx
  ON abos.temporary_fundings (legal_entity_id, business_date DESC, created_at DESC);
CREATE INDEX temporary_fundings_provider_idx
  ON abos.temporary_fundings (legal_entity_id, provider_business_party_id, status);

-- The accounting identity is frozen from the first insert; only the reviewed transitions may follow.
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
  IF OLD.status <> 'PENDING_APPROVAL' OR NEW.status NOT IN ('REJECTED', 'POSTED')
     OR NEW.version <> OLD.version + 1 OR NEW.updated_at <= OLD.updated_at THEN
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
  decision_reason text NOT NULL CHECK (length(btrim(decision_reason)) BETWEEN 3 AND 500),
  decided_by_user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  decided_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  correlation_id uuid NOT NULL,
  UNIQUE (temporary_funding_id),
  UNIQUE (id, legal_entity_id),
  FOREIGN KEY (temporary_funding_id, legal_entity_id) REFERENCES abos.temporary_fundings(id, legal_entity_id)
);

-- Maker-checker with persisted identities: never the recorder, never the provider's own user.
CREATE FUNCTION abos.guard_temporary_funding_decision()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $guard$
DECLARE v_source record;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'temporary funding decisions are immutable' USING ERRCODE = 'check_violation';
  END IF;
  SELECT status, created_by_user_account_id, provider_user_account_id INTO v_source
    FROM abos.temporary_fundings WHERE id = NEW.temporary_funding_id AND legal_entity_id = NEW.legal_entity_id;
  IF NOT FOUND OR v_source.status <> 'PENDING_APPROVAL' THEN
    RAISE EXCEPTION 'only a pending temporary funding can be decided' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.decided_by_user_account_id = v_source.created_by_user_account_id
     OR NEW.decided_by_user_account_id IS NOT DISTINCT FROM v_source.provider_user_account_id THEN
    RAISE EXCEPTION 'the recorder or the funding provider cannot decide the same temporary funding'
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
  funding_version integer NOT NULL CHECK (funding_version > 0),
  workflow_policy_version_id uuid NOT NULL,
  correlation_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 8 AND 200),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('PENDING_APPROVAL', 'REJECTED', 'POSTED')),
  status_reason text CHECK (status_reason IS NULL OR length(btrim(status_reason)) BETWEEN 3 AND 500),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  journal_id uuid,
  created_by_user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, legal_entity_id),
  UNIQUE (legal_entity_id, idempotency_key),
  FOREIGN KEY (temporary_funding_id, legal_entity_id) REFERENCES abos.temporary_fundings(id, legal_entity_id),
  FOREIGN KEY (operational_treasury_account_id, legal_entity_id, original_currency_code)
    REFERENCES abos.operational_treasury_accounts(id, legal_entity_id, currency_code),
  FOREIGN KEY (workflow_policy_version_id, legal_entity_id)
    REFERENCES abos.finance_workflow_policy_versions(id, legal_entity_id),
  FOREIGN KEY (journal_id, legal_entity_id) REFERENCES abos.journals(id, legal_entity_id),
  CHECK (original_currency_code = base_currency_code AND original_amount = base_amount),
  CHECK ((status = 'POSTED') = (journal_id IS NOT NULL)),
  CHECK ((status = 'REJECTED') = (status_reason IS NOT NULL))
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
  IF (NEW.id, NEW.legal_entity_id, NEW.temporary_funding_id, NEW.operational_treasury_account_id,
      NEW.reference, NEW.note, NEW.business_date, NEW.original_amount, NEW.original_currency_code,
      NEW.base_amount, NEW.base_currency_code, NEW.funding_version, NEW.workflow_policy_version_id,
      NEW.correlation_id, NEW.idempotency_key, NEW.request_fingerprint, NEW.created_by_user_account_id,
      NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.legal_entity_id, OLD.temporary_funding_id, OLD.operational_treasury_account_id,
      OLD.reference, OLD.note, OLD.business_date, OLD.original_amount, OLD.original_currency_code,
      OLD.base_amount, OLD.base_currency_code, OLD.funding_version, OLD.workflow_policy_version_id,
      OLD.correlation_id, OLD.idempotency_key, OLD.request_fingerprint, OLD.created_by_user_account_id,
      OLD.created_at) THEN
    RAISE EXCEPTION 'the accounting identity of a settlement cannot change' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'PENDING_APPROVAL' OR NEW.status NOT IN ('REJECTED', 'POSTED')
     OR NEW.version <> OLD.version + 1 OR NEW.updated_at <= OLD.updated_at THEN
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
  decision_reason text NOT NULL CHECK (length(btrim(decision_reason)) BETWEEN 3 AND 500),
  decided_by_user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  decided_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  correlation_id uuid NOT NULL,
  UNIQUE (settlement_id),
  UNIQUE (id, legal_entity_id),
  FOREIGN KEY (settlement_id, legal_entity_id)
    REFERENCES abos.temporary_funding_settlements(id, legal_entity_id)
);

CREATE FUNCTION abos.guard_temporary_funding_settlement_decision()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $guard$
DECLARE v_source record;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'settlement decisions are immutable' USING ERRCODE = 'check_violation';
  END IF;
  SELECT settlement.status, settlement.created_by_user_account_id, funding.provider_user_account_id
    INTO v_source
    FROM abos.temporary_funding_settlements settlement
    JOIN abos.temporary_fundings funding
      ON funding.id = settlement.temporary_funding_id AND funding.legal_entity_id = settlement.legal_entity_id
   WHERE settlement.id = NEW.settlement_id AND settlement.legal_entity_id = NEW.legal_entity_id;
  IF NOT FOUND OR v_source.status <> 'PENDING_APPROVAL' THEN
    RAISE EXCEPTION 'only a pending settlement can be decided' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.decided_by_user_account_id = v_source.created_by_user_account_id
     OR NEW.decided_by_user_account_id IS NOT DISTINCT FROM v_source.provider_user_account_id THEN
    RAISE EXCEPTION 'the settlement preparer or the funding provider cannot decide the same settlement'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.decided_at := clock_timestamp();
  RETURN NEW;
END
$guard$;
CREATE TRIGGER temporary_funding_settlement_decisions_guard
BEFORE INSERT OR UPDATE OR DELETE ON abos.temporary_funding_settlement_decisions
FOR EACH ROW EXECUTE FUNCTION abos.guard_temporary_funding_settlement_decision();

-- ---------------------------------------------------------------------------------------------------
-- Narrow typed extensions of shared financial tables (0036 model-aware sources are preserved).
-- ---------------------------------------------------------------------------------------------------
ALTER TABLE abos.posting_intents
  ADD COLUMN temporary_funding_id uuid,
  ADD COLUMN temporary_funding_settlement_id uuid,
  ADD COLUMN temporary_funding_mapping_version_id uuid,
  ADD CONSTRAINT posting_intents_temporary_funding_fk
    FOREIGN KEY (temporary_funding_id, legal_entity_id) REFERENCES abos.temporary_fundings(id, legal_entity_id),
  ADD CONSTRAINT posting_intents_temporary_funding_settlement_fk
    FOREIGN KEY (temporary_funding_settlement_id, legal_entity_id)
    REFERENCES abos.temporary_funding_settlements(id, legal_entity_id),
  ADD CONSTRAINT posting_intents_temporary_funding_mapping_fk
    FOREIGN KEY (temporary_funding_mapping_version_id, legal_entity_id)
    REFERENCES abos.temporary_funding_account_mapping_versions(id, legal_entity_id),
  DROP CONSTRAINT posting_intents_intent_kind_check,
  ADD CONSTRAINT posting_intents_intent_kind_check CHECK (intent_kind IN (
    'SHAREHOLDER_CAPITAL_RECEIPT', 'SHAREHOLDER_LOAN_RECEIPT', 'REVERSAL', 'EXPENSE',
    'TEMPORARY_FUNDING', 'TEMPORARY_FUNDING_SETTLEMENT')),
  -- Two disjoint Operational V1 temporary funding shapes; every other intent carries no funding lineage.
  ADD CONSTRAINT posting_intents_temporary_funding_source CHECK (
    (processing_model = 'OPERATIONAL_V1' AND intent_kind = 'TEMPORARY_FUNDING'
       AND source_type = 'TEMPORARY_FUNDING' AND temporary_funding_id IS NOT NULL
       AND source_id = temporary_funding_id AND temporary_funding_settlement_id IS NULL
       AND finance_workflow_policy_version_id IS NOT NULL
       AND temporary_funding_mapping_version_id IS NOT NULL AND operational_version IS NOT NULL
       AND operational_expense_id IS NULL AND treasury_cash_receipt_id IS NULL
       AND capital_receipt_intent_id IS NULL AND shareholder_capital_receipt_id IS NULL
       AND shareholder_capital_account_mapping_version_id IS NULL
       AND conversion_snapshot_reference IS NULL)
    OR
    (processing_model = 'OPERATIONAL_V1' AND intent_kind = 'TEMPORARY_FUNDING_SETTLEMENT'
       AND source_type = 'TEMPORARY_FUNDING_SETTLEMENT' AND temporary_funding_settlement_id IS NOT NULL
       AND source_id = temporary_funding_settlement_id AND temporary_funding_id IS NOT NULL
       AND finance_workflow_policy_version_id IS NOT NULL
       AND temporary_funding_mapping_version_id IS NOT NULL AND operational_version IS NOT NULL
       AND operational_expense_id IS NULL AND treasury_cash_receipt_id IS NULL
       AND capital_receipt_intent_id IS NULL AND shareholder_capital_receipt_id IS NULL
       AND shareholder_capital_account_mapping_version_id IS NULL
       AND conversion_snapshot_reference IS NULL)
    OR
    (intent_kind NOT IN ('TEMPORARY_FUNDING', 'TEMPORARY_FUNDING_SETTLEMENT')
       AND source_type NOT IN ('TEMPORARY_FUNDING', 'TEMPORARY_FUNDING_SETTLEMENT')
       AND temporary_funding_id IS NULL AND temporary_funding_settlement_id IS NULL
       AND temporary_funding_mapping_version_id IS NULL));
CREATE UNIQUE INDEX posting_intents_one_per_temporary_funding
  ON abos.posting_intents (legal_entity_id, temporary_funding_id)
  WHERE intent_kind = 'TEMPORARY_FUNDING';
CREATE UNIQUE INDEX posting_intents_one_per_temporary_funding_settlement
  ON abos.posting_intents (legal_entity_id, temporary_funding_settlement_id)
  WHERE temporary_funding_settlement_id IS NOT NULL;

-- Provider-specific payable subledger with exact funding and settlement lineage.
ALTER TABLE abos.subledger_entries
  ADD COLUMN temporary_funding_id uuid,
  ADD COLUMN temporary_funding_settlement_id uuid,
  ADD CONSTRAINT subledger_entries_temporary_funding_fk
    FOREIGN KEY (temporary_funding_id, legal_entity_id) REFERENCES abos.temporary_fundings(id, legal_entity_id),
  ADD CONSTRAINT subledger_entries_temporary_funding_settlement_fk
    FOREIGN KEY (temporary_funding_settlement_id, legal_entity_id)
    REFERENCES abos.temporary_funding_settlements(id, legal_entity_id),
  DROP CONSTRAINT subledger_entries_subledger_type_check,
  ADD CONSTRAINT subledger_entries_subledger_type_check CHECK (subledger_type IN (
    'SHAREHOLDER_CAPITAL', 'SHAREHOLDER_LOAN', 'CASH_LOCATION', 'OPERATIONAL_TREASURY',
    'TEMPORARY_FUNDING_PAYABLE')),
  DROP CONSTRAINT subledger_entries_check,
  ADD CONSTRAINT subledger_entries_check CHECK (
    (subledger_type IN ('SHAREHOLDER_CAPITAL', 'SHAREHOLDER_LOAN', 'TEMPORARY_FUNDING_PAYABLE'))
      = (business_party_id IS NOT NULL)),
  ADD CONSTRAINT subledger_entries_temporary_funding_check CHECK (
    ((subledger_type = 'TEMPORARY_FUNDING_PAYABLE') = (temporary_funding_id IS NOT NULL))
    AND (temporary_funding_settlement_id IS NULL OR subledger_type = 'TEMPORARY_FUNDING_PAYABLE')
    AND (subledger_type <> 'TEMPORARY_FUNDING_PAYABLE'
         OR (processing_model = 'OPERATIONAL_V1' AND shareholder_capital_receipt_id IS NULL
             AND operational_treasury_account_id IS NULL)));
CREATE INDEX subledger_entries_temporary_funding_idx
  ON abos.subledger_entries (legal_entity_id, business_party_id, temporary_funding_id)
  WHERE subledger_type = 'TEMPORARY_FUNDING_PAYABLE';

-- Funding reversal is not active in this slice: no reversal link may target a funding or settlement journal.
CREATE FUNCTION abos.refuse_temporary_funding_reversal_link()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM abos.journals journal
               JOIN abos.posting_intents intent ON intent.id = journal.posting_intent_id
              WHERE journal.id IN (NEW.original_journal_id, NEW.reversal_journal_id)
                AND intent.source_type IN ('TEMPORARY_FUNDING', 'TEMPORARY_FUNDING_SETTLEMENT')) THEN
    RAISE EXCEPTION 'temporary funding reversal is not active' USING ERRCODE = 'feature_not_supported';
  END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER aa_journal_reversal_links_temporary_funding_inactive
BEFORE INSERT ON abos.journal_reversal_links
FOR EACH ROW EXECUTE FUNCTION abos.refuse_temporary_funding_reversal_link();

-- ---------------------------------------------------------------------------------------------------
-- Posted-journal contract for temporary funding (own trigger, like the 0036 capital validator).
-- ---------------------------------------------------------------------------------------------------
CREATE FUNCTION abos.validate_temporary_funding_journal_posting()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $validate$
DECLARE
  v_intent abos.posting_intents%ROWTYPE;
  v_funding abos.temporary_fundings%ROWTYPE;
  v_settlement abos.temporary_funding_settlements%ROWTYPE;
  v_mapping record; v_policy record; v_treasury record; v_period record;
  v_base text; v_debit_ledger uuid; v_debit_party uuid; v_amount numeric; v_settled numeric;
  v_line_count bigint; v_debit numeric; v_credit numeric; v_subledger_count bigint;
BEGIN
  IF NEW.status <> 'POSTED' THEN RETURN NEW; END IF;
  SELECT * INTO v_intent FROM abos.posting_intents
   WHERE id = NEW.posting_intent_id AND legal_entity_id = NEW.legal_entity_id;
  IF NOT FOUND OR v_intent.processing_model <> 'OPERATIONAL_V1'
     OR v_intent.source_type NOT IN ('TEMPORARY_FUNDING', 'TEMPORARY_FUNDING_SETTLEMENT') THEN
    RETURN NEW;
  END IF;
  IF v_intent.status <> 'POSTED' OR v_intent.base_currency_code IS DISTINCT FROM NEW.base_currency_code
     OR v_intent.accounting_effective_date <> NEW.accounting_effective_date
     OR v_intent.original_currency_code <> v_intent.base_currency_code
     OR v_intent.original_amount <> v_intent.base_amount THEN
    RAISE EXCEPTION 'temporary funding posting requires its posted base-currency intent'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT status, starts_on, ends_on INTO v_period FROM abos.accounting_periods
   WHERE id = NEW.accounting_period_id AND legal_entity_id = NEW.legal_entity_id;
  SELECT base_currency_code INTO v_base FROM abos.legal_entities
   WHERE id = NEW.legal_entity_id AND currency_policy_status = 'APPROVED';
  IF v_period.status IS DISTINCT FROM 'OPEN'
     OR NEW.accounting_effective_date NOT BETWEEN v_period.starts_on AND v_period.ends_on
     OR v_base IS NULL OR v_base <> NEW.base_currency_code THEN
    RAISE EXCEPTION 'temporary funding posting requires an open period and the approved base currency'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT policy.id, policy.approval_required INTO v_policy FROM abos.finance_workflow_policy_versions policy
   WHERE policy.id = v_intent.finance_workflow_policy_version_id AND policy.legal_entity_id = NEW.legal_entity_id
     AND policy.workflow_type = 'TEMPORARY_FUNDING';
  SELECT mapping.id, mapping.payable_ledger_account_id, ledger.status, ledger.posting_allowed,
         ledger.account_type, ledger.control_account_type
    INTO v_mapping
    FROM abos.temporary_funding_account_mapping_versions mapping
    JOIN abos.ledger_accounts ledger
      ON ledger.id = mapping.payable_ledger_account_id AND ledger.legal_entity_id = mapping.legal_entity_id
   WHERE mapping.id = v_intent.temporary_funding_mapping_version_id AND mapping.legal_entity_id = NEW.legal_entity_id;
  IF v_policy.id IS NULL OR v_policy.approval_required IS NOT TRUE
     OR v_mapping.id IS NULL OR v_mapping.status <> 'ACTIVE' OR NOT v_mapping.posting_allowed
     OR v_mapping.account_type <> 'LIABILITY' OR v_mapping.control_account_type <> 'TEMPORARY_FUNDING_PAYABLE' THEN
    RAISE EXCEPTION 'temporary funding posting requires its approval-required policy and controlled payable mapping'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*), COALESCE(sum(base_debit), 0), COALESCE(sum(base_credit), 0)
    INTO v_line_count, v_debit, v_credit FROM abos.journal_lines WHERE journal_id = NEW.id;
  IF v_line_count <> 2 OR v_debit <> v_credit OR v_debit <> v_intent.base_amount THEN
    RAISE EXCEPTION 'a temporary funding journal has exactly two lines balanced to its amount'
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM abos.journal_lines line
      JOIN abos.ledger_accounts ledger ON ledger.id = line.ledger_account_id AND ledger.legal_entity_id = line.legal_entity_id
     WHERE line.journal_id = NEW.id AND (
       line.processing_model <> 'OPERATIONAL_V1' OR line.legal_entity_id <> NEW.legal_entity_id
       OR line.base_currency_code <> NEW.base_currency_code
       OR line.original_amount <> v_intent.original_amount
       OR line.original_currency_code <> v_intent.original_currency_code
       OR line.conversion_snapshot_reference IS NOT NULL
       OR line.source_type <> v_intent.source_type OR line.source_id <> v_intent.source_id
       OR ledger.status <> 'ACTIVE' OR NOT ledger.posting_allowed
       OR (ledger.requires_project AND line.project_id IS NULL)
       OR (ledger.requires_department AND line.department_id IS NULL)
       OR (ledger.requires_cost_center AND line.cost_center_id IS NULL))) THEN
    RAISE EXCEPTION 'temporary funding journal line violates source, currency, account or dimension rules'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_intent.intent_kind = 'TEMPORARY_FUNDING' THEN
    SELECT * INTO v_funding FROM abos.temporary_fundings
     WHERE id = v_intent.temporary_funding_id AND legal_entity_id = NEW.legal_entity_id;
    IF NOT FOUND OR v_funding.status <> 'POSTED' OR v_funding.journal_id IS DISTINCT FROM NEW.id
       OR v_funding.base_amount <> v_intent.base_amount OR v_funding.business_date <> NEW.accounting_effective_date
       OR v_funding.workflow_policy_version_id <> v_policy.id OR v_funding.mapping_version_id <> v_mapping.id THEN
      RAISE EXCEPTION 'temporary funding, intent and journal do not agree' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM abos.temporary_funding_decisions decision
                    WHERE decision.temporary_funding_id = v_funding.id AND decision.decision = 'APPROVED'
                      AND decision.decided_by_user_account_id = NEW.posted_by_user_account_id)
       OR NEW.posted_by_user_account_id = v_funding.created_by_user_account_id
       OR NEW.posted_by_user_account_id IS NOT DISTINCT FROM v_funding.provider_user_account_id THEN
      RAISE EXCEPTION 'temporary funding must be posted by its independent approver'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    v_amount := v_funding.base_amount;
    IF v_funding.funding_mode = 'PROVIDER_PAID_EXPENSE_DIRECTLY' THEN
      SELECT category.ledger_account_id INTO v_debit_ledger FROM abos.operational_expense_categories category
        JOIN abos.ledger_accounts ledger ON ledger.id = category.ledger_account_id
         AND ledger.legal_entity_id = category.legal_entity_id AND ledger.account_type = 'EXPENSE'
       WHERE category.id = v_funding.operational_expense_category_id
         AND category.legal_entity_id = NEW.legal_entity_id AND category.status = 'ACTIVE';
      v_debit_party := v_funding.payee_business_party_id;
    ELSE
      SELECT account.ledger_account_id INTO v_debit_ledger FROM abos.operational_treasury_accounts account
        JOIN abos.ledger_accounts ledger ON ledger.id = account.ledger_account_id
         AND ledger.legal_entity_id = account.legal_entity_id
       WHERE account.id = v_funding.operational_treasury_account_id AND account.legal_entity_id = NEW.legal_entity_id
         AND account.status = 'ACTIVE' AND account.currency_code = v_base
         AND account.account_type IN ('SAFE', 'CASH_BOX', 'PETTY_CASH')
         AND ledger.account_type = 'ASSET' AND ledger.control_account_type = 'CASH'
         AND NOT ledger.requires_project AND NOT ledger.requires_department AND NOT ledger.requires_cost_center;
      v_debit_party := NULL;
    END IF;
    IF v_debit_ledger IS NULL OR NOT EXISTS (
         SELECT 1 FROM abos.journal_lines line WHERE line.journal_id = NEW.id AND line.line_number = 1
            AND line.ledger_account_id = v_debit_ledger AND line.base_debit = v_amount AND line.base_credit = 0
            AND line.business_party_id IS NOT DISTINCT FROM v_debit_party
            AND line.project_id IS NOT DISTINCT FROM v_funding.project_id
            AND line.department_id IS NOT DISTINCT FROM v_funding.department_id
            AND line.cost_center_id IS NOT DISTINCT FROM v_funding.cost_center_id)
       OR NOT EXISTS (
         SELECT 1 FROM abos.journal_lines line WHERE line.journal_id = NEW.id AND line.line_number = 2
            AND line.ledger_account_id = v_mapping.payable_ledger_account_id
            AND line.base_debit = 0 AND line.base_credit = v_amount
            AND line.business_party_id = v_funding.provider_business_party_id
            AND line.project_id IS NULL AND line.department_id IS NULL AND line.cost_center_id IS NULL) THEN
      RAISE EXCEPTION 'temporary funding journal must debit its expense or Safe and credit the provider payable'
        USING ERRCODE = 'check_violation';
    END IF;
    -- The provider payable on line 2 always; a Safe inflow on line 1 only when the provider funded the Safe.
    SELECT count(*) INTO v_subledger_count FROM abos.subledger_entries entry
      JOIN abos.journal_lines line ON line.id = entry.journal_line_id WHERE line.journal_id = NEW.id;
    IF v_subledger_count <> (CASE WHEN v_funding.funding_mode = 'PROVIDER_FUNDED_SAFE' THEN 2 ELSE 1 END)
       OR EXISTS (
         SELECT 1 FROM abos.subledger_entries entry JOIN abos.journal_lines line ON line.id = entry.journal_line_id
          WHERE line.journal_id = NEW.id AND NOT (
            (line.line_number = 2 AND entry.subledger_type = 'TEMPORARY_FUNDING_PAYABLE'
             AND entry.processing_model = 'OPERATIONAL_V1'
             AND entry.business_party_id = v_funding.provider_business_party_id
             AND entry.temporary_funding_id = v_funding.id AND entry.temporary_funding_settlement_id IS NULL
             AND entry.original_amount = v_amount AND entry.base_amount = v_amount
             AND entry.original_currency_code = v_base AND entry.base_currency_code = v_base
             AND entry.source_type = 'TEMPORARY_FUNDING' AND entry.source_id = v_funding.id)
            OR
            (v_funding.funding_mode = 'PROVIDER_FUNDED_SAFE' AND line.line_number = 1
             AND entry.subledger_type = 'OPERATIONAL_TREASURY' AND entry.processing_model = 'OPERATIONAL_V1'
             AND entry.operational_treasury_account_id = v_funding.operational_treasury_account_id
             AND entry.business_party_id IS NULL AND entry.temporary_funding_id IS NULL
             AND entry.original_amount = v_amount AND entry.base_amount = v_amount
             AND entry.original_currency_code = v_base AND entry.base_currency_code = v_base
             AND entry.source_type = 'TEMPORARY_FUNDING' AND entry.source_id = v_funding.id)))
       OR NOT EXISTS (
         SELECT 1 FROM abos.subledger_entries entry JOIN abos.journal_lines line ON line.id = entry.journal_line_id
          WHERE line.journal_id = NEW.id AND entry.subledger_type = 'TEMPORARY_FUNDING_PAYABLE') THEN
      RAISE EXCEPTION 'temporary funding journal requires exactly its provider payable and Safe movements'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- TEMPORARY_FUNDING_SETTLEMENT
  SELECT * INTO v_settlement FROM abos.temporary_funding_settlements
   WHERE id = v_intent.temporary_funding_settlement_id AND legal_entity_id = NEW.legal_entity_id;
  SELECT * INTO v_funding FROM abos.temporary_fundings
   WHERE id = v_settlement.temporary_funding_id AND legal_entity_id = NEW.legal_entity_id;
  IF v_settlement.id IS NULL OR v_funding.id IS NULL OR v_funding.id <> v_intent.temporary_funding_id
     OR v_settlement.status <> 'POSTED' OR v_settlement.journal_id IS DISTINCT FROM NEW.id
     OR v_funding.status <> 'POSTED'
     OR v_settlement.base_amount <> v_intent.base_amount OR v_settlement.business_date <> NEW.accounting_effective_date
     OR v_settlement.workflow_policy_version_id <> v_policy.id OR v_funding.mapping_version_id <> v_mapping.id THEN
    RAISE EXCEPTION 'settlement, funding, intent and journal do not agree' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM abos.temporary_funding_settlement_decisions decision
                  WHERE decision.settlement_id = v_settlement.id AND decision.decision = 'APPROVED'
                    AND decision.decided_by_user_account_id = NEW.posted_by_user_account_id)
     OR NEW.posted_by_user_account_id = v_settlement.created_by_user_account_id
     OR NEW.posted_by_user_account_id IS NOT DISTINCT FROM v_funding.provider_user_account_id THEN
    RAISE EXCEPTION 'a settlement must be posted by its independent approver' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT COALESCE(sum(other.base_amount), 0) INTO v_settled FROM abos.temporary_funding_settlements other
   WHERE other.temporary_funding_id = v_funding.id AND other.legal_entity_id = NEW.legal_entity_id
     AND other.status = 'POSTED';
  IF v_settled > v_funding.base_amount THEN
    RAISE EXCEPTION 'settlements cannot exceed the funded amount' USING ERRCODE = 'check_violation';
  END IF;
  SELECT account.id, account.ledger_account_id INTO v_treasury FROM abos.operational_treasury_accounts account
    JOIN abos.ledger_accounts ledger ON ledger.id = account.ledger_account_id AND ledger.legal_entity_id = account.legal_entity_id
   WHERE account.id = v_settlement.operational_treasury_account_id AND account.legal_entity_id = NEW.legal_entity_id
     AND account.status = 'ACTIVE' AND account.currency_code = v_base
     AND ledger.account_type = 'ASSET' AND ledger.control_account_type = 'CASH'
     AND NOT ledger.requires_project AND NOT ledger.requires_department AND NOT ledger.requires_cost_center;
  IF v_treasury.id IS NULL OR NOT EXISTS (
       SELECT 1 FROM abos.journal_lines line WHERE line.journal_id = NEW.id AND line.line_number = 1
          AND line.ledger_account_id = v_mapping.payable_ledger_account_id
          AND line.base_debit = v_settlement.base_amount AND line.base_credit = 0
          AND line.business_party_id = v_funding.provider_business_party_id
          AND line.project_id IS NULL AND line.department_id IS NULL AND line.cost_center_id IS NULL)
     OR NOT EXISTS (
       SELECT 1 FROM abos.journal_lines line WHERE line.journal_id = NEW.id AND line.line_number = 2
          AND line.ledger_account_id = v_treasury.ledger_account_id AND line.base_debit = 0
          AND line.base_credit = v_settlement.base_amount AND line.business_party_id IS NULL
          AND line.project_id IS NULL AND line.department_id IS NULL AND line.cost_center_id IS NULL) THEN
    RAISE EXCEPTION 'a settlement must debit the provider payable and credit its Treasury source'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*) INTO v_subledger_count FROM abos.subledger_entries entry
    JOIN abos.journal_lines line ON line.id = entry.journal_line_id WHERE line.journal_id = NEW.id;
  IF v_subledger_count <> 2 OR EXISTS (
       SELECT 1 FROM abos.subledger_entries entry JOIN abos.journal_lines line ON line.id = entry.journal_line_id
        WHERE line.journal_id = NEW.id AND NOT (
          (line.line_number = 1 AND entry.subledger_type = 'TEMPORARY_FUNDING_PAYABLE'
           AND entry.processing_model = 'OPERATIONAL_V1'
           AND entry.business_party_id = v_funding.provider_business_party_id
           AND entry.temporary_funding_id = v_funding.id AND entry.temporary_funding_settlement_id = v_settlement.id
           AND entry.original_amount = -v_settlement.original_amount AND entry.base_amount = -v_settlement.base_amount
           AND entry.original_currency_code = v_base AND entry.base_currency_code = v_base
           AND entry.source_type = 'TEMPORARY_FUNDING_SETTLEMENT' AND entry.source_id = v_settlement.id)
          OR
          (line.line_number = 2 AND entry.subledger_type = 'OPERATIONAL_TREASURY'
           AND entry.processing_model = 'OPERATIONAL_V1'
           AND entry.operational_treasury_account_id = v_settlement.operational_treasury_account_id
           AND entry.business_party_id IS NULL AND entry.temporary_funding_id IS NULL
           AND entry.original_amount = -v_settlement.original_amount AND entry.base_amount = -v_settlement.base_amount
           AND entry.original_currency_code = v_base AND entry.base_currency_code = v_base
           AND entry.source_type = 'TEMPORARY_FUNDING_SETTLEMENT' AND entry.source_id = v_settlement.id)))
     OR (SELECT count(DISTINCT line.line_number) FROM abos.subledger_entries entry
           JOIN abos.journal_lines line ON line.id = entry.journal_line_id WHERE line.journal_id = NEW.id) <> 2 THEN
    RAISE EXCEPTION 'a settlement journal requires exactly its payable decrease and Treasury outflow'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$validate$;
CREATE TRIGGER journals_operational_temporary_funding_posting_guard
BEFORE INSERT OR UPDATE ON abos.journals
FOR EACH ROW WHEN (NEW.processing_model = 'OPERATIONAL_V1')
EXECUTE FUNCTION abos.validate_temporary_funding_journal_posting();

-- 0036 Operational V1 dispatch, preserved verbatim, gains the temporary funding source arm.
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

  SELECT * INTO intent_row FROM abos.posting_intents
   WHERE id = NEW.posting_intent_id AND legal_entity_id = NEW.legal_entity_id;
  IF FOUND AND intent_row.processing_model = 'OPERATIONAL_V1'
     AND intent_row.source_type = 'SHAREHOLDER_CAPITAL_CONTRIBUTION_RECEIPT' THEN
    RETURN NEW;
  END IF;
  -- 0037: typed temporary funding journals are validated by validate_temporary_funding_journal_posting().
  IF FOUND AND intent_row.processing_model = 'OPERATIONAL_V1'
     AND intent_row.source_type IN ('TEMPORARY_FUNDING', 'TEMPORARY_FUNDING_SETTLEMENT') THEN
    RETURN NEW;
  END IF;
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
-- The closed operational permission dispatcher (0036) gains only the six reviewed funding operations.
-- ---------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION abos.operational_finance_actor(
  p_identity_proof text,
  p_runtime_token_sha256 text,
  p_token_sha256 text,
  p_required_permission text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $actor$
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
    'finance.temporary-funding.settle-approve', 'finance.temporary-funding.configure'
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
$actor$;

-- ---------------------------------------------------------------------------------------------------
-- Internal helpers (invoker rights; executable only by the Operational Finance owner).
-- ---------------------------------------------------------------------------------------------------
-- Actor, legal entity and permissions come only from the database-verified password session.
CREATE FUNCTION abos.temporary_funding_actor(
  p_identity_proof text, p_runtime_token_sha256 text, p_token_sha256 text, p_any_of text[]
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $actor$
DECLARE v_context jsonb;
BEGIN
  v_context := abos.operational_finance_actor(p_identity_proof, p_runtime_token_sha256, p_token_sha256, NULL);
  IF v_context ->> 'sessionProvenance' IS DISTINCT FROM 'PASSWORD_OPERATIONAL' THEN
    RAISE EXCEPTION 'temporary funding requires an operational password session'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT COALESCE(v_context -> 'permissions', '[]'::jsonb) ?| p_any_of THEN
    RAISE EXCEPTION 'current authority is missing %', array_to_string(p_any_of, ' or ')
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN v_context;
END
$actor$;

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

-- Same key + same canonical payload replays; same key + different payload is refused.
CREATE FUNCTION abos.temporary_funding_idempotency_begin(
  p_scope text, p_key text, p_fingerprint text, p_correlation_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $idem$
DECLARE v_row abos.idempotency_records%ROWTYPE;
BEGIN
  IF p_key IS NULL OR length(btrim(p_key)) NOT BETWEEN 8 AND 200 OR p_correlation_id IS NULL THEN
    RAISE EXCEPTION 'an idempotency key and correlation are required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  INSERT INTO abos.idempotency_records (scope, idempotency_key, request_fingerprint, correlation_id, status)
  VALUES (p_scope, p_key, p_fingerprint, p_correlation_id, 'IN_PROGRESS')
  ON CONFLICT (scope, idempotency_key) DO NOTHING;
  SELECT * INTO v_row FROM abos.idempotency_records
   WHERE scope = p_scope AND idempotency_key = p_key FOR UPDATE;
  IF v_row.request_fingerprint IS DISTINCT FROM p_fingerprint THEN
    RAISE EXCEPTION 'idempotency key was already used with different temporary funding details'
      USING ERRCODE = 'unique_violation';
  END IF;
  IF v_row.status = 'COMPLETED' THEN
    RETURN v_row.response_snapshot || jsonb_build_object('replayed', true);
  END IF;
  RETURN NULL;
END
$idem$;

CREATE FUNCTION abos.temporary_funding_idempotency_complete(
  p_scope text, p_key text, p_resource_type text, p_resource_id uuid, p_snapshot jsonb
) RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $idem$
BEGIN
  UPDATE abos.idempotency_records
     SET status = 'COMPLETED', resource_type = p_resource_type, resource_id = p_resource_id,
         response_code = 200, response_snapshot = p_snapshot, completed_at = clock_timestamp()
   WHERE scope = p_scope AND idempotency_key = p_key AND status = 'IN_PROGRESS';
  IF NOT FOUND THEN RAISE EXCEPTION 'temporary funding idempotency record is not in progress'; END IF;
END
$idem$;

CREATE FUNCTION abos.temporary_funding_fingerprint(p_payload jsonb, p_target text, p_actor uuid)
RETURNS text LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $fingerprint$
  SELECT encode(sha256(convert_to((p_payload - 'correlationId')::text || ':' || COALESCE(p_target, '')
    || ':' || p_actor::text, 'UTF8')), 'hex')
$fingerprint$;

-- One reviewed audit fact and one outbox fact per meaningful action (never on idempotent replay).
CREATE FUNCTION abos.temporary_funding_audit(
  p_actor uuid, p_entity uuid, p_correlation uuid, p_action text, p_entity_type text, p_entity_id uuid,
  p_after jsonb
) RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $audit$
BEGIN
  INSERT INTO abos.audit_records
    (id, actor_user_account_id, legal_entity_id, correlation_id, action, entity_type, entity_id,
     after_state, metadata)
  VALUES (gen_random_uuid(), p_actor, p_entity, p_correlation, p_action, p_entity_type, p_entity_id,
          p_after, jsonb_build_object('source', 'v1-temporary-funding'));
  INSERT INTO abos.outbox_events
    (id, aggregate_type, aggregate_id, event_type, event_version, legal_entity_id, actor_user_account_id,
     correlation_id, payload, occurred_at)
  VALUES (gen_random_uuid(), p_entity_type, p_entity_id, 'finance.' || lower(replace(p_action, '_', '-')), 1,
          p_entity, p_actor, p_correlation, p_after, clock_timestamp());
END
$audit$;

-- Current approval-required policy; a policy that says approval is not required fails closed.
CREATE FUNCTION abos.temporary_funding_current_policy(p_entity uuid)
RETURNS uuid
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, pg_temp
AS $policy$
DECLARE v_policy record;
BEGIN
  SELECT id, approval_required INTO v_policy FROM abos.finance_workflow_policy_versions
   WHERE legal_entity_id = p_entity AND workflow_type = 'TEMPORARY_FUNDING'
   ORDER BY version DESC LIMIT 1;
  IF v_policy.id IS NULL OR v_policy.approval_required IS NOT TRUE THEN
    RAISE EXCEPTION 'temporary funding approval policy is not configured as approval-required'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN v_policy.id;
END
$policy$;

-- Current mapping whose payable account is still a valid controlled liability.
CREATE FUNCTION abos.temporary_funding_current_mapping(p_entity uuid)
RETURNS uuid
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, pg_temp
AS $mapping$
DECLARE v_mapping record; v_base text;
BEGIN
  SELECT base_currency_code INTO v_base FROM abos.legal_entities
   WHERE id = p_entity AND currency_policy_status = 'APPROVED';
  SELECT mapping.id, ledger.status, ledger.posting_allowed, ledger.account_type, ledger.control_account_type,
         ledger.account_currency_code, ledger.requires_project, ledger.requires_department, ledger.requires_cost_center
    INTO v_mapping
    FROM abos.temporary_funding_account_mapping_versions mapping
    JOIN abos.ledger_accounts ledger
      ON ledger.id = mapping.payable_ledger_account_id AND ledger.legal_entity_id = mapping.legal_entity_id
   WHERE mapping.legal_entity_id = p_entity ORDER BY mapping.version DESC LIMIT 1;
  IF v_mapping.id IS NULL OR v_mapping.status <> 'ACTIVE' OR NOT v_mapping.posting_allowed
     OR v_mapping.account_type <> 'LIABILITY' OR v_mapping.control_account_type <> 'TEMPORARY_FUNDING_PAYABLE'
     OR v_mapping.account_currency_code IS DISTINCT FROM v_base
     OR v_mapping.requires_project OR v_mapping.requires_department OR v_mapping.requires_cost_center THEN
    RAISE EXCEPTION 'temporary funding payable mapping is missing or no longer valid'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN v_mapping.id;
END
$mapping$;

CREATE FUNCTION abos.temporary_funding_open_period(p_entity uuid, p_date date)
RETURNS uuid
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, pg_temp
AS $period$
DECLARE v_period uuid;
BEGIN
  SELECT id INTO v_period FROM abos.accounting_periods
   WHERE legal_entity_id = p_entity AND status = 'OPEN' AND p_date BETWEEN starts_on AND ends_on
   ORDER BY starts_on DESC LIMIT 1;
  IF v_period IS NULL THEN
    RAISE EXCEPTION 'no open accounting period covers %', p_date USING ERRCODE = 'check_violation';
  END IF;
  RETURN v_period;
END
$period$;

-- An active, base-currency operational Treasury account on an active CASH asset without dimensions.
CREATE FUNCTION abos.temporary_funding_treasury_ledger(
  p_entity uuid, p_account uuid, p_currency text, p_safe_only boolean
) RETURNS uuid
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, pg_temp
AS $treasury$
DECLARE v_ledger uuid;
BEGIN
  SELECT account.ledger_account_id INTO v_ledger
    FROM abos.operational_treasury_accounts account
    JOIN abos.ledger_accounts ledger
      ON ledger.id = account.ledger_account_id AND ledger.legal_entity_id = account.legal_entity_id
   WHERE account.id = p_account AND account.legal_entity_id = p_entity AND account.status = 'ACTIVE'
     AND account.currency_code = p_currency
     AND (NOT p_safe_only OR account.account_type IN ('SAFE', 'CASH_BOX', 'PETTY_CASH'))
     AND ledger.status = 'ACTIVE' AND ledger.posting_allowed
     AND ledger.account_type = 'ASSET' AND ledger.control_account_type = 'CASH'
     AND NOT ledger.requires_project AND NOT ledger.requires_department AND NOT ledger.requires_cost_center;
  IF v_ledger IS NULL THEN
    RAISE EXCEPTION 'an active base-currency Treasury account on a CASH asset account is required'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN v_ledger;
END
$treasury$;

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
    'decision', (SELECT jsonb_build_object('decision', decision.decision, 'reason', decision.decision_reason,
                   'decidedBy', decider.display_name, 'decidedAt', decision.decided_at)
                   FROM abos.temporary_funding_settlement_decisions decision
                   JOIN abos.user_accounts decider ON decider.id = decision.decided_by_user_account_id
                  WHERE decision.settlement_id = settlement.id))
  FROM abos.temporary_funding_settlements settlement
  JOIN abos.operational_treasury_accounts treasury ON treasury.id = settlement.operational_treasury_account_id
  JOIN abos.user_accounts creator ON creator.id = settlement.created_by_user_account_id
  WHERE settlement.id = p_settlement_id
$json$;

-- Settlement progress is derived from posted settlements, never stored.
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
    'journalId', funding.journal_id, 'mappingVersionId', funding.mapping_version_id,
    'workflowPolicyVersionId', funding.workflow_policy_version_id,
    'createdBy', creator.display_name, 'createdByUserAccountId', funding.created_by_user_account_id,
    'createdAt', funding.created_at, 'updatedAt', funding.updated_at,
    'decision', (SELECT jsonb_build_object('decision', decision.decision, 'reason', decision.decision_reason,
                   'decidedBy', decider.display_name, 'decidedAt', decision.decided_at)
                   FROM abos.temporary_funding_decisions decision
                   JOIN abos.user_accounts decider ON decider.id = decision.decided_by_user_account_id
                  WHERE decision.temporary_funding_id = funding.id),
    'settlements', COALESCE((SELECT jsonb_agg(abos.temporary_funding_settlement_json(settlement.id)
                   ORDER BY settlement.business_date, settlement.created_at)
                   FROM abos.temporary_funding_settlements settlement
                  WHERE settlement.temporary_funding_id = funding.id
                    AND settlement.legal_entity_id = funding.legal_entity_id), '[]'::jsonb))
  FROM abos.temporary_fundings funding
  JOIN abos.business_parties provider
    ON provider.id = funding.provider_business_party_id AND provider.legal_entity_id = funding.legal_entity_id
  JOIN abos.user_accounts creator ON creator.id = funding.created_by_user_account_id
  LEFT JOIN abos.operational_expense_categories category ON category.id = funding.operational_expense_category_id
  LEFT JOIN abos.business_parties payee ON payee.id = funding.payee_business_party_id
  LEFT JOIN abos.operational_treasury_accounts treasury ON treasury.id = funding.operational_treasury_account_id
  CROSS JOIN LATERAL (
    SELECT COALESCE(sum(settlement.base_amount) FILTER (WHERE settlement.status = 'POSTED'), 0) AS settled,
           COALESCE(sum(settlement.base_amount) FILTER (WHERE settlement.status = 'PENDING_APPROVAL'), 0) AS pending
      FROM abos.temporary_funding_settlements settlement
     WHERE settlement.temporary_funding_id = funding.id AND settlement.legal_entity_id = funding.legal_entity_id) totals
  WHERE funding.id = p_funding_id
$json$;

-- Funding journal, built only after its independent approval, in the approver's transaction.
CREATE FUNCTION abos.temporary_funding_post(p_funding_id uuid, p_actor_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $post$
DECLARE
  funding abos.temporary_fundings%ROWTYPE;
  v_payable uuid; v_debit_ledger uuid; v_debit_party uuid; v_period uuid;
  v_intent uuid := gen_random_uuid(); v_journal uuid := gen_random_uuid();
  v_debit_line uuid := gen_random_uuid(); v_credit_line uuid := gen_random_uuid();
BEGIN
  IF current_user <> 'abos_v1_operational_finance_owner' THEN
    RAISE EXCEPTION 'temporary funding posting helper is internal' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO funding FROM abos.temporary_fundings WHERE id = p_funding_id FOR UPDATE;
  IF funding.status <> 'PENDING_APPROVAL' OR NOT EXISTS (
    SELECT 1 FROM abos.temporary_funding_decisions decision
     WHERE decision.temporary_funding_id = funding.id AND decision.legal_entity_id = funding.legal_entity_id
       AND decision.decision = 'APPROVED' AND decision.decided_by_user_account_id = p_actor_id) THEN
    RAISE EXCEPTION 'temporary funding has no approval from the posting actor' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT payable_ledger_account_id INTO v_payable FROM abos.temporary_funding_account_mapping_versions
   WHERE id = funding.mapping_version_id AND legal_entity_id = funding.legal_entity_id;
  IF funding.funding_mode = 'PROVIDER_PAID_EXPENSE_DIRECTLY' THEN
    SELECT category.ledger_account_id INTO v_debit_ledger FROM abos.operational_expense_categories category
     WHERE category.id = funding.operational_expense_category_id
       AND category.legal_entity_id = funding.legal_entity_id AND category.status = 'ACTIVE';
    v_debit_party := funding.payee_business_party_id;
    IF v_debit_ledger IS NULL THEN
      RAISE EXCEPTION 'the funding expense category must remain active' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    v_debit_ledger := abos.temporary_funding_treasury_ledger(
      funding.legal_entity_id, funding.operational_treasury_account_id, funding.base_currency_code, true);
    v_debit_party := NULL;
  END IF;
  v_period := abos.temporary_funding_open_period(funding.legal_entity_id, funding.business_date);

  INSERT INTO abos.posting_intents
    (id, legal_entity_id, project_id, department_id, cost_center_id, source_type, source_id, intent_kind,
     original_amount, original_currency_code, base_amount, base_currency_code, accounting_effective_date,
     correlation_id, idempotency_key, status, created_by_user_account_id, processing_model,
     temporary_funding_id, finance_workflow_policy_version_id, temporary_funding_mapping_version_id,
     operational_version)
  VALUES
    (v_intent, funding.legal_entity_id, funding.project_id, funding.department_id, funding.cost_center_id,
     'TEMPORARY_FUNDING', funding.id, 'TEMPORARY_FUNDING', funding.original_amount,
     funding.original_currency_code, funding.base_amount, funding.base_currency_code, funding.business_date,
     funding.correlation_id, 'TFP:' || funding.id::text, 'APPROVED', funding.created_by_user_account_id,
     'OPERATIONAL_V1', funding.id, funding.workflow_policy_version_id, funding.mapping_version_id, 1);
  INSERT INTO abos.journals
    (id, legal_entity_id, accounting_period_id, posting_intent_id, journal_reference, accounting_effective_date,
     base_currency_code, status, created_by_user_account_id, processing_model)
  VALUES
    (v_journal, funding.legal_entity_id, v_period, v_intent, 'TFP-' || replace(funding.id::text, '-', ''),
     funding.business_date, funding.base_currency_code, 'DRAFT', funding.created_by_user_account_id,
     'OPERATIONAL_V1');
  INSERT INTO abos.journal_lines
    (id, journal_id, legal_entity_id, line_number, ledger_account_id, business_party_id, project_id,
     department_id, cost_center_id, original_amount, original_currency_code, base_debit, base_credit,
     base_currency_code, conversion_snapshot_reference, source_type, source_id, processing_model)
  VALUES
    (v_debit_line, v_journal, funding.legal_entity_id, 1, v_debit_ledger, v_debit_party,
     funding.project_id, funding.department_id, funding.cost_center_id, funding.original_amount,
     funding.original_currency_code, funding.base_amount, 0, funding.base_currency_code, NULL,
     'TEMPORARY_FUNDING', funding.id, 'OPERATIONAL_V1'),
    (v_credit_line, v_journal, funding.legal_entity_id, 2, v_payable, funding.provider_business_party_id,
     NULL, NULL, NULL, funding.original_amount, funding.original_currency_code, 0, funding.base_amount,
     funding.base_currency_code, NULL, 'TEMPORARY_FUNDING', funding.id, 'OPERATIONAL_V1');
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
     SET status = 'POSTED', journal_id = v_journal, version = version + 1, updated_at = clock_timestamp()
   WHERE id = funding.id;
  UPDATE abos.posting_intents SET status = 'POSTED', operational_version = operational_version + 1
   WHERE id = v_intent;
  UPDATE abos.journals SET status = 'POSTED', posted_by_user_account_id = p_actor_id, posted_at = clock_timestamp()
   WHERE id = v_journal;
  PERFORM abos.temporary_funding_audit(p_actor_id, funding.legal_entity_id, funding.correlation_id,
    'TEMPORARY_FUNDING_POSTED', 'TEMPORARY_FUNDING', funding.id,
    jsonb_build_object('temporaryFundingId', funding.id, 'postingIntentId', v_intent, 'journalId', v_journal,
      'fundingMode', funding.funding_mode, 'providerBusinessPartyId', funding.provider_business_party_id,
      'amount', funding.original_amount::text, 'currency', funding.original_currency_code,
      'mappingVersionId', funding.mapping_version_id, 'workflowPolicyVersionId', funding.workflow_policy_version_id));
  RETURN v_journal;
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
  v_payable uuid; v_treasury_ledger uuid; v_settled numeric; v_period uuid;
  v_intent uuid := gen_random_uuid(); v_journal uuid := gen_random_uuid();
  v_debit_line uuid := gen_random_uuid(); v_credit_line uuid := gen_random_uuid();
BEGIN
  IF current_user <> 'abos_v1_operational_finance_owner' THEN
    RAISE EXCEPTION 'temporary funding posting helper is internal' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Lock order everywhere: funding, then settlement.
  SELECT funding_row.* INTO funding FROM abos.temporary_fundings funding_row
   WHERE funding_row.id = (SELECT temporary_funding_id FROM abos.temporary_funding_settlements WHERE id = p_settlement_id)
   FOR UPDATE;
  SELECT * INTO settlement FROM abos.temporary_funding_settlements WHERE id = p_settlement_id FOR UPDATE;
  IF settlement.status <> 'PENDING_APPROVAL' OR funding.status <> 'POSTED' OR NOT EXISTS (
    SELECT 1 FROM abos.temporary_funding_settlement_decisions decision
     WHERE decision.settlement_id = settlement.id AND decision.legal_entity_id = settlement.legal_entity_id
       AND decision.decision = 'APPROVED' AND decision.decided_by_user_account_id = p_actor_id) THEN
    RAISE EXCEPTION 'settlement has no approval from the posting actor' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT COALESCE(sum(base_amount), 0) INTO v_settled FROM abos.temporary_funding_settlements
   WHERE temporary_funding_id = funding.id AND legal_entity_id = funding.legal_entity_id AND status = 'POSTED';
  IF v_settled + settlement.base_amount > funding.base_amount THEN
    RAISE EXCEPTION 'settlement would exceed the outstanding temporary funding payable'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT payable_ledger_account_id INTO v_payable FROM abos.temporary_funding_account_mapping_versions
   WHERE id = funding.mapping_version_id AND legal_entity_id = funding.legal_entity_id;
  v_treasury_ledger := abos.temporary_funding_treasury_ledger(
    settlement.legal_entity_id, settlement.operational_treasury_account_id, settlement.base_currency_code, false);
  v_period := abos.temporary_funding_open_period(settlement.legal_entity_id, settlement.business_date);

  INSERT INTO abos.posting_intents
    (id, legal_entity_id, source_type, source_id, intent_kind, original_amount, original_currency_code,
     base_amount, base_currency_code, accounting_effective_date, correlation_id, idempotency_key, status,
     created_by_user_account_id, processing_model, temporary_funding_id, temporary_funding_settlement_id,
     finance_workflow_policy_version_id, temporary_funding_mapping_version_id, operational_version)
  VALUES
    (v_intent, settlement.legal_entity_id, 'TEMPORARY_FUNDING_SETTLEMENT', settlement.id,
     'TEMPORARY_FUNDING_SETTLEMENT', settlement.original_amount, settlement.original_currency_code,
     settlement.base_amount, settlement.base_currency_code, settlement.business_date, settlement.correlation_id,
     'TFS:' || settlement.id::text, 'APPROVED', settlement.created_by_user_account_id, 'OPERATIONAL_V1',
     funding.id, settlement.id, settlement.workflow_policy_version_id, funding.mapping_version_id, 1);
  INSERT INTO abos.journals
    (id, legal_entity_id, accounting_period_id, posting_intent_id, journal_reference, accounting_effective_date,
     base_currency_code, status, created_by_user_account_id, processing_model)
  VALUES
    (v_journal, settlement.legal_entity_id, v_period, v_intent, 'TFS-' || replace(settlement.id::text, '-', ''),
     settlement.business_date, settlement.base_currency_code, 'DRAFT', settlement.created_by_user_account_id,
     'OPERATIONAL_V1');
  INSERT INTO abos.journal_lines
    (id, journal_id, legal_entity_id, line_number, ledger_account_id, business_party_id, project_id,
     department_id, cost_center_id, original_amount, original_currency_code, base_debit, base_credit,
     base_currency_code, conversion_snapshot_reference, source_type, source_id, processing_model)
  VALUES
    (v_debit_line, v_journal, settlement.legal_entity_id, 1, v_payable, funding.provider_business_party_id,
     NULL, NULL, NULL, settlement.original_amount, settlement.original_currency_code, settlement.base_amount, 0,
     settlement.base_currency_code, NULL, 'TEMPORARY_FUNDING_SETTLEMENT', settlement.id, 'OPERATIONAL_V1'),
    (v_credit_line, v_journal, settlement.legal_entity_id, 2, v_treasury_ledger, NULL, NULL, NULL, NULL,
     settlement.original_amount, settlement.original_currency_code, 0, settlement.base_amount,
     settlement.base_currency_code, NULL, 'TEMPORARY_FUNDING_SETTLEMENT', settlement.id, 'OPERATIONAL_V1');
  INSERT INTO abos.subledger_entries
    (id, legal_entity_id, journal_line_id, subledger_type, business_party_id, temporary_funding_id,
     temporary_funding_settlement_id, original_amount, original_currency_code, base_amount, base_currency_code,
     source_type, source_id, processing_model)
  VALUES
    (gen_random_uuid(), settlement.legal_entity_id, v_debit_line, 'TEMPORARY_FUNDING_PAYABLE',
     funding.provider_business_party_id, funding.id, settlement.id, -settlement.original_amount,
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
     SET status = 'POSTED', journal_id = v_journal, version = version + 1, updated_at = clock_timestamp()
   WHERE id = settlement.id;
  UPDATE abos.posting_intents SET status = 'POSTED', operational_version = operational_version + 1
   WHERE id = v_intent;
  UPDATE abos.journals SET status = 'POSTED', posted_by_user_account_id = p_actor_id, posted_at = clock_timestamp()
   WHERE id = v_journal;
  PERFORM abos.temporary_funding_audit(p_actor_id, settlement.legal_entity_id, settlement.correlation_id,
    'TEMPORARY_FUNDING_SETTLEMENT_POSTED', 'TEMPORARY_FUNDING_SETTLEMENT', settlement.id,
    jsonb_build_object('settlementId', settlement.id, 'temporaryFundingId', funding.id,
      'postingIntentId', v_intent, 'journalId', v_journal, 'amount', settlement.original_amount::text,
      'currency', settlement.original_currency_code,
      'outstandingAfter', (funding.base_amount - v_settled - settlement.base_amount)::text));
  RETURN v_journal;
END
$post$;

-- ---------------------------------------------------------------------------------------------------
-- Restricted public entry points (SECURITY DEFINER, owner abos_v1_operational_finance_owner).
-- ---------------------------------------------------------------------------------------------------
CREATE FUNCTION abos.temporary_funding_workspace(
  p_identity_proof text, p_runtime_token_sha256 text, p_token_sha256 text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $workspace$
DECLARE v_context jsonb; v_entity uuid; v_permissions jsonb; v_base text; v_policy record; v_mapping record;
BEGIN
  v_context := abos.temporary_funding_actor(p_identity_proof, p_runtime_token_sha256, p_token_sha256,
    ARRAY['finance.temporary-funding.read', 'finance.temporary-funding.record',
          'finance.temporary-funding.approve', 'finance.temporary-funding.settle',
          'finance.temporary-funding.settle-approve', 'finance.temporary-funding.configure']);
  v_entity := (v_context ->> 'legalEntityId')::uuid;
  v_permissions := COALESCE(v_context -> 'permissions', '[]'::jsonb);
  SELECT base_currency_code INTO v_base FROM abos.legal_entities
   WHERE id = v_entity AND currency_policy_status = 'APPROVED';
  SELECT id, version, approval_required INTO v_policy FROM abos.finance_workflow_policy_versions
   WHERE legal_entity_id = v_entity AND workflow_type = 'TEMPORARY_FUNDING' ORDER BY version DESC LIMIT 1;
  SELECT mapping.id, mapping.version, mapping.configured_at, mapping.evidence_document_reference,
         ledger.id AS ledger_id, ledger.account_code, ledger.account_name,
         (ledger.status = 'ACTIVE' AND ledger.posting_allowed AND ledger.account_type = 'LIABILITY'
          AND ledger.control_account_type = 'TEMPORARY_FUNDING_PAYABLE'
          AND ledger.account_currency_code IS NOT DISTINCT FROM v_base) AS valid
    INTO v_mapping
    FROM abos.temporary_funding_account_mapping_versions mapping
    JOIN abos.ledger_accounts ledger ON ledger.id = mapping.payable_ledger_account_id
     AND ledger.legal_entity_id = mapping.legal_entity_id
   WHERE mapping.legal_entity_id = v_entity ORDER BY mapping.version DESC LIMIT 1;
  RETURN jsonb_build_object(
    'legalEntityId', v_entity,
    'baseCurrency', v_base,
    'actorUserAccountId', v_context ->> 'userAccountId',
    'permissions', jsonb_build_object(
      'canRead', v_permissions ? 'finance.temporary-funding.read',
      'canRecord', v_permissions ? 'finance.temporary-funding.record',
      'canApprove', v_permissions ? 'finance.temporary-funding.approve',
      'canSettle', v_permissions ? 'finance.temporary-funding.settle',
      'canApproveSettlement', v_permissions ? 'finance.temporary-funding.settle-approve',
      'canConfigure', v_permissions ? 'finance.temporary-funding.configure'),
    'capability', jsonb_build_object(
      'state', CASE WHEN v_base IS NOT NULL AND v_policy.approval_required IS TRUE AND v_mapping.valid IS TRUE
                    THEN 'OPERATIONAL' ELSE 'NOT_OPERATIONAL' END,
      'reason', CASE WHEN v_base IS NULL THEN 'BASE_CURRENCY_NOT_APPROVED'
                     WHEN v_policy.id IS NULL THEN 'POLICY_NOT_CONFIGURED'
                     WHEN v_policy.approval_required IS NOT TRUE THEN 'APPROVAL_MUST_BE_REQUIRED'
                     WHEN v_mapping.id IS NULL THEN 'PAYABLE_MAPPING_NOT_CONFIGURED'
                     WHEN v_mapping.valid IS NOT TRUE THEN 'PAYABLE_MAPPING_INVALID'
                     ELSE NULL END,
      'reversalAvailable', false,
      'safeNonNegativeGuardActive', false,
      'requiredSessionProvenance', 'PASSWORD_OPERATIONAL'),
    'configuration', jsonb_build_object(
      'mapping', CASE WHEN v_mapping.id IS NULL THEN NULL ELSE jsonb_build_object(
        'id', v_mapping.id, 'version', v_mapping.version, 'configuredAt', v_mapping.configured_at,
        'evidenceDocumentReference', v_mapping.evidence_document_reference, 'valid', v_mapping.valid,
        'payableLedgerAccount', jsonb_build_object('id', v_mapping.ledger_id, 'code', v_mapping.account_code,
          'name', v_mapping.account_name)) END,
      'policy', CASE WHEN v_policy.id IS NULL THEN NULL ELSE jsonb_build_object(
        'id', v_policy.id, 'version', v_policy.version, 'approvalRequired', v_policy.approval_required) END),
    -- Provider subledger: the authoritative outstanding amount is the posted payable subledger.
    'providers', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'businessPartyId', provider.id, 'name', provider.display_name,
        'providerKinds', totals.kinds, 'fundedAmount', totals.funded::text,
        'settledAmount', totals.settled::text, 'outstandingAmount', COALESCE(ledger.balance, 0)::text,
        'status', CASE WHEN COALESCE(ledger.balance, 0) = 0 THEN 'SETTLED'
                       WHEN totals.settled = 0 THEN 'OUTSTANDING' ELSE 'PARTIALLY_SETTLED' END)
        ORDER BY provider.display_name, provider.id)
      FROM (SELECT funding.provider_business_party_id AS party_id,
                   jsonb_agg(DISTINCT funding.provider_kind) AS kinds,
                   sum(funding.base_amount) AS funded,
                   COALESCE((SELECT sum(settlement.base_amount) FROM abos.temporary_funding_settlements settlement
                              JOIN abos.temporary_fundings parent ON parent.id = settlement.temporary_funding_id
                             WHERE parent.provider_business_party_id = funding.provider_business_party_id
                               AND parent.legal_entity_id = v_entity AND settlement.legal_entity_id = v_entity
                               AND settlement.status = 'POSTED'), 0) AS settled
              FROM abos.temporary_fundings funding
             WHERE funding.legal_entity_id = v_entity AND funding.status = 'POSTED'
             GROUP BY funding.provider_business_party_id) totals
      JOIN abos.business_parties provider ON provider.id = totals.party_id AND provider.legal_entity_id = v_entity
      LEFT JOIN LATERAL (
        SELECT sum(entry.base_amount) AS balance
          FROM abos.subledger_entries entry
          JOIN abos.journal_lines line ON line.id = entry.journal_line_id
          JOIN abos.journals journal ON journal.id = line.journal_id
         WHERE entry.legal_entity_id = v_entity AND entry.subledger_type = 'TEMPORARY_FUNDING_PAYABLE'
           AND entry.business_party_id = provider.id AND journal.status = 'POSTED') ledger ON true), '[]'::jsonb),
    'payableTotal', (SELECT COALESCE(sum(entry.base_amount), 0)::text
        FROM abos.subledger_entries entry
        JOIN abos.journal_lines line ON line.id = entry.journal_line_id
        JOIN abos.journals journal ON journal.id = line.journal_id
       WHERE entry.legal_entity_id = v_entity AND entry.subledger_type = 'TEMPORARY_FUNDING_PAYABLE'
         AND journal.status = 'POSTED'),
    -- Physical Safe movements are shown apart from the payable and are not a balance.
    'safePositions', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'treasuryAccountId', account.id, 'nameEn', account.name_en, 'nameFa', account.name_fa,
        'accountType', account.account_type, 'currencyCode', account.currency_code,
        'postedMovementTotal', COALESCE(movements.total, 0)::text,
        'temporaryFundingInflow', COALESCE(movements.funding_in, 0)::text,
        'temporaryFundingSettlementOutflow', COALESCE(movements.settlement_out, 0)::text)
        ORDER BY account.name_en, account.id)
      FROM abos.operational_treasury_accounts account
      LEFT JOIN LATERAL (
        SELECT sum(entry.original_amount) AS total,
               sum(entry.original_amount) FILTER (WHERE entry.source_type = 'TEMPORARY_FUNDING') AS funding_in,
               -sum(entry.original_amount) FILTER (WHERE entry.source_type = 'TEMPORARY_FUNDING_SETTLEMENT') AS settlement_out
          FROM abos.subledger_entries entry
          JOIN abos.journal_lines line ON line.id = entry.journal_line_id
          JOIN abos.journals journal ON journal.id = line.journal_id
         WHERE entry.legal_entity_id = v_entity AND entry.subledger_type = 'OPERATIONAL_TREASURY'
           AND entry.operational_treasury_account_id = account.id AND journal.status = 'POSTED') movements ON true
      WHERE account.legal_entity_id = v_entity AND account.status = 'ACTIVE'), '[]'::jsonb),
    'fundings', COALESCE((SELECT jsonb_agg(abos.temporary_funding_json(funding.id)
        ORDER BY funding.business_date DESC, funding.created_at DESC)
      FROM (SELECT id, business_date, created_at FROM abos.temporary_fundings
             WHERE legal_entity_id = v_entity ORDER BY business_date DESC, created_at DESC LIMIT 500) funding),
      '[]'::jsonb),
    'options', jsonb_build_object(
      'safeAccounts', COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'id', account.id, 'nameEn', account.name_en, 'nameFa', account.name_fa,
          'currencyCode', account.currency_code, 'accountType', account.account_type)
          ORDER BY account.name_en, account.id)
        FROM abos.operational_treasury_accounts account
        JOIN abos.ledger_accounts ledger ON ledger.id = account.ledger_account_id AND ledger.legal_entity_id = account.legal_entity_id
        WHERE account.legal_entity_id = v_entity AND account.status = 'ACTIVE' AND account.currency_code = v_base
          AND account.account_type IN ('SAFE', 'CASH_BOX', 'PETTY_CASH')
          AND ledger.status = 'ACTIVE' AND ledger.posting_allowed AND ledger.account_type = 'ASSET'
          AND ledger.control_account_type = 'CASH'), '[]'::jsonb),
      'settlementSources', COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'id', account.id, 'nameEn', account.name_en, 'nameFa', account.name_fa,
          'currencyCode', account.currency_code, 'accountType', account.account_type)
          ORDER BY account.name_en, account.id)
        FROM abos.operational_treasury_accounts account
        JOIN abos.ledger_accounts ledger ON ledger.id = account.ledger_account_id AND ledger.legal_entity_id = account.legal_entity_id
        WHERE account.legal_entity_id = v_entity AND account.status = 'ACTIVE' AND account.currency_code = v_base
          AND ledger.status = 'ACTIVE' AND ledger.posting_allowed AND ledger.account_type = 'ASSET'
          AND ledger.control_account_type = 'CASH'), '[]'::jsonb),
      'expenseCategories', COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'id', category.id, 'code', category.category_code, 'nameEn', category.name_en, 'nameFa', category.name_fa)
          ORDER BY category.category_code, category.id)
        FROM abos.operational_expense_categories category
        WHERE category.legal_entity_id = v_entity AND category.status = 'ACTIVE'), '[]'::jsonb),
      'parties', COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'id', party.id, 'name', party.display_name,
          'shareholder', EXISTS (SELECT 1 FROM abos.business_party_roles role
                                  WHERE role.business_party_id = party.id AND role.role_code = 'SHAREHOLDER'
                                    AND role.effective_from <= current_date
                                    AND (role.effective_to IS NULL OR role.effective_to >= current_date)))
          ORDER BY party.display_name, party.id)
        FROM abos.business_parties party
        WHERE party.legal_entity_id = v_entity AND party.status = 'ACTIVE'), '[]'::jsonb),
      'users', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', account.id, 'name', account.display_name)
          ORDER BY account.display_name, account.id)
        FROM abos.user_accounts account
        WHERE account.status = 'ACTIVE' AND EXISTS (
          SELECT 1 FROM abos.user_permission_grants grant_row
           WHERE grant_row.user_account_id = account.id AND grant_row.legal_entity_id = v_entity
             AND grant_row.revoked_at IS NULL)), '[]'::jsonb),
      'payableLedgerAccounts', COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'id', ledger.id, 'code', ledger.account_code, 'name', ledger.account_name)
          ORDER BY ledger.account_code, ledger.id)
        FROM abos.ledger_accounts ledger
        WHERE ledger.legal_entity_id = v_entity AND ledger.account_type = 'LIABILITY'
          AND ledger.control_account_type = 'TEMPORARY_FUNDING_PAYABLE'
          AND ledger.status = 'ACTIVE' AND ledger.posting_allowed
          AND ledger.account_currency_code IS NOT DISTINCT FROM v_base
          AND NOT ledger.requires_project AND NOT ledger.requires_department
          AND NOT ledger.requires_cost_center), '[]'::jsonb)));
END
$workspace$;

-- Evidence-backed payable mapping: the evidence fact and the mapping version are recorded together.
CREATE FUNCTION abos.configure_temporary_funding_mapping(
  p_identity_proof text, p_runtime_token_sha256 text, p_token_sha256 text, p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $configure$
DECLARE
  v_context jsonb; v_actor uuid; v_entity uuid; v_ledger uuid; v_reference text; v_sha text;
  v_reason text; v_key text; v_correlation uuid; v_scope text; v_replay jsonb; v_fingerprint text;
  v_version integer; v_mapping uuid := gen_random_uuid(); v_evidence uuid := gen_random_uuid(); v_result jsonb;
BEGIN
  v_context := abos.temporary_funding_actor(p_identity_proof, p_runtime_token_sha256, p_token_sha256,
    ARRAY['finance.temporary-funding.configure']);
  v_actor := (v_context ->> 'userAccountId')::uuid;
  v_entity := (v_context ->> 'legalEntityId')::uuid;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' OR EXISTS (
    SELECT 1 FROM jsonb_object_keys(p_payload) key
     WHERE key NOT IN ('ledgerAccountId', 'evidenceDocumentReference', 'evidenceSha256', 'changeReason',
                       'idempotencyKey', 'correlationId')) THEN
    RAISE EXCEPTION 'payable mapping request contains unsupported fields' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  BEGIN
    v_ledger := (p_payload ->> 'ledgerAccountId')::uuid;
    v_correlation := (p_payload ->> 'correlationId')::uuid;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'a complete payable mapping request is required' USING ERRCODE = 'invalid_parameter_value';
  END;
  v_reference := NULLIF(btrim(p_payload ->> 'evidenceDocumentReference'), '');
  v_sha := lower(btrim(p_payload ->> 'evidenceSha256'));
  v_reason := NULLIF(btrim(p_payload ->> 'changeReason'), '');
  v_key := btrim(p_payload ->> 'idempotencyKey');
  IF v_ledger IS NULL OR v_reference IS NULL OR length(v_reference) > 200 OR v_sha IS NULL
     OR v_sha !~ '^[0-9a-f]{64}$' OR v_reason IS NULL OR length(v_reason) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'payable account, evidence reference, evidence SHA-256 and a change reason are required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_fingerprint := abos.temporary_funding_fingerprint(p_payload, NULL, v_actor);
  v_scope := 'temporary-funding:configure:' || v_entity::text || ':' || v_actor::text;
  v_replay := abos.temporary_funding_idempotency_begin(v_scope, v_key, v_fingerprint, v_correlation);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('temporary-funding-mapping:' || v_entity::text, 0));
  SELECT COALESCE(max(version), 0) + 1 INTO v_version
    FROM abos.temporary_funding_account_mapping_versions WHERE legal_entity_id = v_entity;
  INSERT INTO abos.evidence_references
    (id, legal_entity_id, document_id, evidence_kind, evidence_version, sha256, completed_at)
  VALUES (v_evidence, v_entity, v_mapping, 'TEMPORARY_FUNDING_ACCOUNT_MAPPING', 1, v_sha, clock_timestamp());
  INSERT INTO abos.temporary_funding_account_mapping_versions
    (id, legal_entity_id, version, payable_ledger_account_id, evidence_reference_id, evidence_document_reference,
     change_reason, configured_by_user_account_id, correlation_id, idempotency_key, request_fingerprint)
  VALUES (v_mapping, v_entity, v_version, v_ledger, v_evidence, v_reference, v_reason, v_actor, v_correlation,
          v_key, v_fingerprint);
  v_result := jsonb_build_object('mappingVersionId', v_mapping, 'version', v_version, 'ledgerAccountId', v_ledger,
    'evidenceReferenceId', v_evidence, 'replayed', false);
  PERFORM abos.temporary_funding_audit(v_actor, v_entity, v_correlation, 'TEMPORARY_FUNDING_MAPPING_CONFIGURED',
    'TEMPORARY_FUNDING_MAPPING', v_mapping, v_result || jsonb_build_object('changeReason', v_reason,
      'evidenceDocumentReference', v_reference));
  PERFORM abos.temporary_funding_idempotency_complete(v_scope, v_key, 'TEMPORARY_FUNDING_MAPPING', v_mapping, v_result);
  RETURN v_result;
END
$configure$;

CREATE FUNCTION abos.record_temporary_funding(
  p_identity_proof text, p_runtime_token_sha256 text, p_token_sha256 text, p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $record$
DECLARE
  v_context jsonb; v_actor uuid; v_entity uuid; v_mode text; v_kind text; v_provider uuid; v_provider_user uuid;
  v_category uuid; v_payee uuid; v_project uuid; v_department uuid; v_cost_center uuid; v_treasury uuid;
  v_reference text; v_description text; v_note text; v_date date; v_amount numeric; v_currency text;
  v_base text; v_key text; v_correlation uuid; v_fingerprint text; v_scope text; v_replay jsonb;
  v_policy uuid; v_mapping uuid; v_shareholder boolean; v_ledger record;
  v_id uuid := gen_random_uuid(); v_result jsonb;
BEGIN
  v_context := abos.temporary_funding_actor(p_identity_proof, p_runtime_token_sha256, p_token_sha256,
    ARRAY['finance.temporary-funding.record']);
  v_actor := (v_context ->> 'userAccountId')::uuid;
  v_entity := (v_context ->> 'legalEntityId')::uuid;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' OR EXISTS (
    SELECT 1 FROM jsonb_object_keys(p_payload) key
     WHERE key NOT IN ('fundingMode', 'providerKind', 'providerBusinessPartyId', 'providerUserAccountId',
       'expenseCategoryId', 'payeeBusinessPartyId', 'projectId', 'departmentId', 'costCenterId',
       'treasuryAccountId', 'reference', 'description', 'note', 'businessDate', 'amount',
       'idempotencyKey', 'correlationId')) THEN
    RAISE EXCEPTION 'temporary funding request contains unsupported fields' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  BEGIN
    v_provider := (p_payload ->> 'providerBusinessPartyId')::uuid;
    v_provider_user := NULLIF(p_payload ->> 'providerUserAccountId', '')::uuid;
    v_category := NULLIF(p_payload ->> 'expenseCategoryId', '')::uuid;
    v_payee := NULLIF(p_payload ->> 'payeeBusinessPartyId', '')::uuid;
    v_project := NULLIF(p_payload ->> 'projectId', '')::uuid;
    v_department := NULLIF(p_payload ->> 'departmentId', '')::uuid;
    v_cost_center := NULLIF(p_payload ->> 'costCenterId', '')::uuid;
    v_treasury := NULLIF(p_payload ->> 'treasuryAccountId', '')::uuid;
    v_date := (p_payload ->> 'businessDate')::date;
    v_correlation := (p_payload ->> 'correlationId')::uuid;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'a complete valid temporary funding request is required' USING ERRCODE = 'invalid_parameter_value';
  END;
  v_mode := p_payload ->> 'fundingMode';
  v_kind := p_payload ->> 'providerKind';
  v_amount := abos.temporary_funding_amount(p_payload #>> '{amount,amount}');
  v_currency := upper(btrim(p_payload #>> '{amount,currency}'));
  v_reference := NULLIF(btrim(p_payload ->> 'reference'), '');
  v_description := NULLIF(btrim(p_payload ->> 'description'), '');
  v_note := NULLIF(btrim(p_payload ->> 'note'), '');
  v_key := btrim(p_payload ->> 'idempotencyKey');
  IF v_mode IS NULL OR v_mode NOT IN ('PROVIDER_PAID_EXPENSE_DIRECTLY', 'PROVIDER_FUNDED_SAFE')
     OR v_kind IS NULL OR v_kind NOT IN ('SHAREHOLDER', 'EMPLOYEE_OFFICER', 'INDIVIDUAL', 'ORGANIZATION')
     OR v_provider IS NULL OR v_date IS NULL OR v_currency IS NULL
     OR v_reference IS NULL OR length(v_reference) > 120
     OR v_description IS NULL OR length(v_description) NOT BETWEEN 3 AND 500
     OR (v_note IS NOT NULL AND length(v_note) > 1000)
     OR (v_mode = 'PROVIDER_PAID_EXPENSE_DIRECTLY' AND (v_category IS NULL OR v_treasury IS NOT NULL))
     OR (v_mode = 'PROVIDER_FUNDED_SAFE' AND (v_treasury IS NULL OR v_category IS NOT NULL OR v_payee IS NOT NULL
         OR v_project IS NOT NULL OR v_department IS NOT NULL OR v_cost_center IS NOT NULL)) THEN
    RAISE EXCEPTION 'a complete valid temporary funding request is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_fingerprint := abos.temporary_funding_fingerprint(p_payload, NULL, v_actor);
  v_scope := 'temporary-funding:record:' || v_entity::text || ':' || v_actor::text;
  v_replay := abos.temporary_funding_idempotency_begin(v_scope, v_key, v_fingerprint, v_correlation);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;

  SELECT base_currency_code INTO v_base FROM abos.legal_entities
   WHERE id = v_entity AND currency_policy_status = 'APPROVED';
  IF v_base IS NULL OR v_currency IS DISTINCT FROM v_base THEN
    RAISE EXCEPTION 'temporary funding is base-currency only; foreign currency is not available'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM abos.business_parties party WHERE party.id = v_provider
                    AND party.legal_entity_id = v_entity AND party.status = 'ACTIVE') THEN
    RAISE EXCEPTION 'the funding provider is not an active business party in this legal entity'
      USING ERRCODE = 'check_violation';
  END IF;
  -- A shareholder's funding is always visible as a shareholder's; it is still a payable, never capital.
  v_shareholder := EXISTS (SELECT 1 FROM abos.business_party_roles role
                            WHERE role.business_party_id = v_provider AND role.role_code = 'SHAREHOLDER'
                              AND role.effective_from <= v_date
                              AND (role.effective_to IS NULL OR role.effective_to >= v_date));
  IF (v_kind = 'SHAREHOLDER') <> v_shareholder THEN
    RAISE EXCEPTION 'the provider kind does not match the provider''s shareholder role on the funding date'
      USING ERRCODE = 'check_violation';
  END IF;
  -- No persisted business-party/user link exists yet: the provider's own ABOS user, when there is one,
  -- is recorded with the funding and is then excluded from every approval of it.
  IF v_provider_user IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM abos.user_accounts account
      JOIN abos.user_permission_grants grant_row ON grant_row.user_account_id = account.id
     WHERE account.id = v_provider_user AND account.status = 'ACTIVE'
       AND grant_row.legal_entity_id = v_entity AND grant_row.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'the provider''s user account is not active in this legal entity' USING ERRCODE = 'check_violation';
  END IF;
  IF v_mode = 'PROVIDER_PAID_EXPENSE_DIRECTLY' THEN
    SELECT ledger.requires_project, ledger.requires_department, ledger.requires_cost_center INTO v_ledger
      FROM abos.operational_expense_categories category
      JOIN abos.ledger_accounts ledger ON ledger.id = category.ledger_account_id
       AND ledger.legal_entity_id = category.legal_entity_id
     WHERE category.id = v_category AND category.legal_entity_id = v_entity AND category.status = 'ACTIVE'
       AND ledger.account_type = 'EXPENSE' AND ledger.status = 'ACTIVE' AND ledger.posting_allowed;
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
  ELSE
    PERFORM abos.temporary_funding_treasury_ledger(v_entity, v_treasury, v_base, true);
  END IF;
  PERFORM abos.temporary_funding_open_period(v_entity, v_date);
  v_policy := abos.temporary_funding_current_policy(v_entity);
  v_mapping := abos.temporary_funding_current_mapping(v_entity);

  INSERT INTO abos.temporary_fundings
    (id, legal_entity_id, funding_mode, provider_kind, provider_business_party_id, provider_user_account_id,
     operational_expense_category_id, payee_business_party_id, project_id, department_id, cost_center_id,
     operational_treasury_account_id, reference, description, note, business_date, original_amount,
     original_currency_code, base_amount, base_currency_code, workflow_policy_version_id, mapping_version_id,
     correlation_id, idempotency_key, request_fingerprint, status, version, created_by_user_account_id)
  VALUES
    (v_id, v_entity, v_mode, v_kind, v_provider, v_provider_user, v_category, v_payee, v_project, v_department,
     v_cost_center, v_treasury, v_reference, v_description, v_note, v_date, v_amount, v_currency, v_amount, v_base,
     v_policy, v_mapping, v_correlation, v_key, v_fingerprint, 'PENDING_APPROVAL', 1, v_actor);
  v_result := jsonb_build_object('funding', abos.temporary_funding_json(v_id), 'replayed', false);
  PERFORM abos.temporary_funding_audit(v_actor, v_entity, v_correlation, 'TEMPORARY_FUNDING_RECORDED',
    'TEMPORARY_FUNDING', v_id, v_result -> 'funding');
  PERFORM abos.temporary_funding_idempotency_complete(v_scope, v_key, 'TEMPORARY_FUNDING', v_id, v_result);
  RETURN v_result;
END
$record$;

CREATE FUNCTION abos.decide_temporary_funding(
  p_identity_proof text, p_runtime_token_sha256 text, p_token_sha256 text, p_funding_id uuid, p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $decide$
DECLARE
  v_context jsonb; v_actor uuid; v_entity uuid; v_expected integer; v_decision text; v_reason text;
  v_key text; v_correlation uuid; v_fingerprint text; v_scope text; v_replay jsonb; v_result jsonb;
  funding abos.temporary_fundings%ROWTYPE;
BEGIN
  v_context := abos.temporary_funding_actor(p_identity_proof, p_runtime_token_sha256, p_token_sha256,
    ARRAY['finance.temporary-funding.approve']);
  v_actor := (v_context ->> 'userAccountId')::uuid;
  v_entity := (v_context ->> 'legalEntityId')::uuid;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' OR EXISTS (
    SELECT 1 FROM jsonb_object_keys(p_payload) key
     WHERE key NOT IN ('expectedVersion', 'decision', 'decisionReason', 'idempotencyKey', 'correlationId')) THEN
    RAISE EXCEPTION 'temporary funding decision contains unsupported fields' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  BEGIN
    v_expected := (p_payload ->> 'expectedVersion')::integer;
    v_correlation := (p_payload ->> 'correlationId')::uuid;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'a complete temporary funding decision is required' USING ERRCODE = 'invalid_parameter_value';
  END;
  v_decision := p_payload ->> 'decision';
  v_reason := NULLIF(btrim(p_payload ->> 'decisionReason'), '');
  v_key := btrim(p_payload ->> 'idempotencyKey');
  IF p_funding_id IS NULL OR v_expected IS NULL OR v_decision IS NULL OR v_decision NOT IN ('APPROVED', 'REJECTED')
     OR v_reason IS NULL OR length(v_reason) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'a terminal decision, current version and a 3-500 character reason are required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('temporary-funding:' || p_funding_id::text, 0));
  SELECT * INTO funding FROM abos.temporary_fundings
   WHERE id = p_funding_id AND legal_entity_id = v_entity FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'temporary funding is not available in this legal entity' USING ERRCODE = 'no_data_found';
  END IF;
  v_fingerprint := abos.temporary_funding_fingerprint(p_payload, p_funding_id::text, v_actor);
  v_scope := 'temporary-funding:decide:' || v_entity::text || ':' || v_actor::text;
  v_replay := abos.temporary_funding_idempotency_begin(v_scope, v_key, v_fingerprint, v_correlation);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  IF funding.version <> v_expected THEN
    RAISE EXCEPTION 'temporary funding changed; reload and try again' USING ERRCODE = 'serialization_failure';
  END IF;
  IF funding.status <> 'PENDING_APPROVAL' THEN
    RAISE EXCEPTION 'temporary funding is not waiting for approval' USING ERRCODE = 'check_violation';
  END IF;
  IF funding.created_by_user_account_id = v_actor OR funding.provider_user_account_id IS NOT DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'the recorder or the funding provider cannot decide the same temporary funding'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_decision = 'APPROVED' THEN
    -- The bound policy snapshot and the current policy must both still require approval.
    IF NOT EXISTS (SELECT 1 FROM abos.finance_workflow_policy_versions policy
                    WHERE policy.id = funding.workflow_policy_version_id AND policy.legal_entity_id = v_entity
                      AND policy.workflow_type = 'TEMPORARY_FUNDING' AND policy.approval_required) THEN
      RAISE EXCEPTION 'temporary funding approval policy is not configured as approval-required'
        USING ERRCODE = 'check_violation';
    END IF;
    PERFORM abos.temporary_funding_current_policy(v_entity);
  END IF;
  INSERT INTO abos.temporary_funding_decisions
    (id, legal_entity_id, temporary_funding_id, decision, decision_reason, decided_by_user_account_id, correlation_id)
  VALUES (gen_random_uuid(), v_entity, funding.id, v_decision, v_reason, v_actor, v_correlation);
  PERFORM abos.temporary_funding_audit(v_actor, v_entity, v_correlation, 'TEMPORARY_FUNDING_' || v_decision,
    'TEMPORARY_FUNDING', funding.id, jsonb_build_object('temporaryFundingId', funding.id, 'decision', v_decision,
      'reason', v_reason));
  IF v_decision = 'APPROVED' THEN
    PERFORM abos.temporary_funding_post(funding.id, v_actor);
  ELSE
    UPDATE abos.temporary_fundings
       SET status = 'REJECTED', status_reason = v_reason, version = version + 1, updated_at = clock_timestamp()
     WHERE id = funding.id;
  END IF;
  v_result := jsonb_build_object('funding', abos.temporary_funding_json(funding.id), 'replayed', false);
  PERFORM abos.temporary_funding_idempotency_complete(v_scope, v_key, 'TEMPORARY_FUNDING_DECISION', funding.id, v_result);
  RETURN v_result;
END
$decide$;

CREATE FUNCTION abos.request_temporary_funding_settlement(
  p_identity_proof text, p_runtime_token_sha256 text, p_token_sha256 text, p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $request$
DECLARE
  v_context jsonb; v_actor uuid; v_entity uuid; v_funding_id uuid; v_expected integer; v_treasury uuid;
  v_reference text; v_note text; v_date date; v_amount numeric; v_currency text; v_key text; v_correlation uuid;
  v_fingerprint text; v_scope text; v_replay jsonb; v_reserved numeric; v_policy uuid;
  funding abos.temporary_fundings%ROWTYPE; v_id uuid := gen_random_uuid(); v_result jsonb;
BEGIN
  v_context := abos.temporary_funding_actor(p_identity_proof, p_runtime_token_sha256, p_token_sha256,
    ARRAY['finance.temporary-funding.settle']);
  v_actor := (v_context ->> 'userAccountId')::uuid;
  v_entity := (v_context ->> 'legalEntityId')::uuid;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' OR EXISTS (
    SELECT 1 FROM jsonb_object_keys(p_payload) key
     WHERE key NOT IN ('temporaryFundingId', 'expectedFundingVersion', 'treasuryAccountId', 'amount',
       'businessDate', 'reference', 'note', 'idempotencyKey', 'correlationId')) THEN
    RAISE EXCEPTION 'settlement request contains unsupported fields' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  BEGIN
    v_funding_id := (p_payload ->> 'temporaryFundingId')::uuid;
    v_expected := (p_payload ->> 'expectedFundingVersion')::integer;
    v_treasury := (p_payload ->> 'treasuryAccountId')::uuid;
    v_date := (p_payload ->> 'businessDate')::date;
    v_correlation := (p_payload ->> 'correlationId')::uuid;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'a complete valid settlement request is required' USING ERRCODE = 'invalid_parameter_value';
  END;
  v_amount := abos.temporary_funding_amount(p_payload #>> '{amount,amount}');
  v_currency := upper(btrim(p_payload #>> '{amount,currency}'));
  v_reference := NULLIF(btrim(p_payload ->> 'reference'), '');
  v_note := NULLIF(btrim(p_payload ->> 'note'), '');
  v_key := btrim(p_payload ->> 'idempotencyKey');
  IF v_funding_id IS NULL OR v_expected IS NULL OR v_treasury IS NULL OR v_date IS NULL OR v_currency IS NULL
     OR v_reference IS NULL OR length(v_reference) > 120 OR (v_note IS NOT NULL AND length(v_note) > 1000) THEN
    RAISE EXCEPTION 'a complete valid settlement request is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('temporary-funding:' || v_funding_id::text, 0));
  SELECT * INTO funding FROM abos.temporary_fundings
   WHERE id = v_funding_id AND legal_entity_id = v_entity FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'temporary funding is not available in this legal entity' USING ERRCODE = 'no_data_found';
  END IF;
  v_fingerprint := abos.temporary_funding_fingerprint(p_payload, NULL, v_actor);
  v_scope := 'temporary-funding:settle:' || v_entity::text || ':' || v_actor::text;
  v_replay := abos.temporary_funding_idempotency_begin(v_scope, v_key, v_fingerprint, v_correlation);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  IF funding.version <> v_expected THEN
    RAISE EXCEPTION 'temporary funding changed; reload and try again' USING ERRCODE = 'serialization_failure';
  END IF;
  IF funding.status <> 'POSTED' THEN
    RAISE EXCEPTION 'only a posted temporary funding can be settled' USING ERRCODE = 'check_violation';
  END IF;
  IF v_currency <> funding.base_currency_code THEN
    RAISE EXCEPTION 'temporary funding is base-currency only; foreign currency is not available'
      USING ERRCODE = 'check_violation';
  END IF;
  -- Reservation under the funding lock: pending plus posted settlements never exceed the payable.
  SELECT COALESCE(sum(base_amount), 0) INTO v_reserved FROM abos.temporary_funding_settlements
   WHERE temporary_funding_id = funding.id AND legal_entity_id = v_entity
     AND status IN ('PENDING_APPROVAL', 'POSTED');
  IF v_reserved + v_amount > funding.base_amount THEN
    RAISE EXCEPTION 'settlement exceeds the outstanding temporary funding payable of %',
      (funding.base_amount - v_reserved)::text USING ERRCODE = 'check_violation';
  END IF;
  IF v_date < funding.business_date THEN
    RAISE EXCEPTION 'a settlement cannot be dated before its funding' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM abos.temporary_funding_treasury_ledger(v_entity, v_treasury, funding.base_currency_code, false);
  PERFORM abos.temporary_funding_open_period(v_entity, v_date);
  v_policy := abos.temporary_funding_current_policy(v_entity);
  INSERT INTO abos.temporary_funding_settlements
    (id, legal_entity_id, temporary_funding_id, operational_treasury_account_id, reference, note, business_date,
     original_amount, original_currency_code, base_amount, base_currency_code, funding_version,
     workflow_policy_version_id, correlation_id, idempotency_key, request_fingerprint, status, version,
     created_by_user_account_id)
  VALUES
    (v_id, v_entity, funding.id, v_treasury, v_reference, v_note, v_date, v_amount, funding.base_currency_code,
     v_amount, funding.base_currency_code, funding.version, v_policy, v_correlation, v_key, v_fingerprint,
     'PENDING_APPROVAL', 1, v_actor);
  v_result := jsonb_build_object('settlement', abos.temporary_funding_settlement_json(v_id),
    'funding', abos.temporary_funding_json(funding.id), 'replayed', false);
  PERFORM abos.temporary_funding_audit(v_actor, v_entity, v_correlation, 'TEMPORARY_FUNDING_SETTLEMENT_REQUESTED',
    'TEMPORARY_FUNDING_SETTLEMENT', v_id, v_result -> 'settlement');
  PERFORM abos.temporary_funding_idempotency_complete(v_scope, v_key, 'TEMPORARY_FUNDING_SETTLEMENT', v_id, v_result);
  RETURN v_result;
END
$request$;

CREATE FUNCTION abos.decide_temporary_funding_settlement(
  p_identity_proof text, p_runtime_token_sha256 text, p_token_sha256 text, p_settlement_id uuid, p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $decide$
DECLARE
  v_context jsonb; v_actor uuid; v_entity uuid; v_expected integer; v_decision text; v_reason text;
  v_key text; v_correlation uuid; v_fingerprint text; v_scope text; v_replay jsonb; v_result jsonb;
  v_funding_id uuid; settlement abos.temporary_funding_settlements%ROWTYPE; funding abos.temporary_fundings%ROWTYPE;
BEGIN
  v_context := abos.temporary_funding_actor(p_identity_proof, p_runtime_token_sha256, p_token_sha256,
    ARRAY['finance.temporary-funding.settle-approve']);
  v_actor := (v_context ->> 'userAccountId')::uuid;
  v_entity := (v_context ->> 'legalEntityId')::uuid;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' OR EXISTS (
    SELECT 1 FROM jsonb_object_keys(p_payload) key
     WHERE key NOT IN ('expectedVersion', 'decision', 'decisionReason', 'idempotencyKey', 'correlationId')) THEN
    RAISE EXCEPTION 'settlement decision contains unsupported fields' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  BEGIN
    v_expected := (p_payload ->> 'expectedVersion')::integer;
    v_correlation := (p_payload ->> 'correlationId')::uuid;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'a complete settlement decision is required' USING ERRCODE = 'invalid_parameter_value';
  END;
  v_decision := p_payload ->> 'decision';
  v_reason := NULLIF(btrim(p_payload ->> 'decisionReason'), '');
  v_key := btrim(p_payload ->> 'idempotencyKey');
  IF p_settlement_id IS NULL OR v_expected IS NULL OR v_decision IS NULL OR v_decision NOT IN ('APPROVED', 'REJECTED')
     OR v_reason IS NULL OR length(v_reason) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'a terminal decision, current version and a 3-500 character reason are required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT temporary_funding_id INTO v_funding_id FROM abos.temporary_funding_settlements
   WHERE id = p_settlement_id AND legal_entity_id = v_entity;
  IF v_funding_id IS NULL THEN
    RAISE EXCEPTION 'settlement is not available in this legal entity' USING ERRCODE = 'no_data_found';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('temporary-funding:' || v_funding_id::text, 0));
  SELECT * INTO funding FROM abos.temporary_fundings WHERE id = v_funding_id AND legal_entity_id = v_entity FOR UPDATE;
  SELECT * INTO settlement FROM abos.temporary_funding_settlements
   WHERE id = p_settlement_id AND legal_entity_id = v_entity FOR UPDATE;
  v_fingerprint := abos.temporary_funding_fingerprint(p_payload, p_settlement_id::text, v_actor);
  v_scope := 'temporary-funding:settle-decide:' || v_entity::text || ':' || v_actor::text;
  v_replay := abos.temporary_funding_idempotency_begin(v_scope, v_key, v_fingerprint, v_correlation);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  IF settlement.version <> v_expected THEN
    RAISE EXCEPTION 'settlement changed; reload and try again' USING ERRCODE = 'serialization_failure';
  END IF;
  IF settlement.status <> 'PENDING_APPROVAL' THEN
    RAISE EXCEPTION 'settlement is not waiting for approval' USING ERRCODE = 'check_violation';
  END IF;
  IF settlement.created_by_user_account_id = v_actor OR funding.provider_user_account_id IS NOT DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'the settlement preparer or the funding provider cannot decide the same settlement'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_decision = 'APPROVED' THEN
    IF NOT EXISTS (SELECT 1 FROM abos.finance_workflow_policy_versions policy
                    WHERE policy.id = settlement.workflow_policy_version_id AND policy.legal_entity_id = v_entity
                      AND policy.workflow_type = 'TEMPORARY_FUNDING' AND policy.approval_required) THEN
      RAISE EXCEPTION 'temporary funding approval policy is not configured as approval-required'
        USING ERRCODE = 'check_violation';
    END IF;
    PERFORM abos.temporary_funding_current_policy(v_entity);
  END IF;
  INSERT INTO abos.temporary_funding_settlement_decisions
    (id, legal_entity_id, settlement_id, decision, decision_reason, decided_by_user_account_id, correlation_id)
  VALUES (gen_random_uuid(), v_entity, settlement.id, v_decision, v_reason, v_actor, v_correlation);
  PERFORM abos.temporary_funding_audit(v_actor, v_entity, v_correlation,
    'TEMPORARY_FUNDING_SETTLEMENT_' || v_decision, 'TEMPORARY_FUNDING_SETTLEMENT', settlement.id,
    jsonb_build_object('settlementId', settlement.id, 'temporaryFundingId', funding.id, 'decision', v_decision,
      'reason', v_reason));
  IF v_decision = 'APPROVED' THEN
    PERFORM abos.temporary_funding_settlement_post(settlement.id, v_actor);
  ELSE
    UPDATE abos.temporary_funding_settlements
       SET status = 'REJECTED', status_reason = v_reason, version = version + 1, updated_at = clock_timestamp()
     WHERE id = settlement.id;
  END IF;
  v_result := jsonb_build_object('settlement', abos.temporary_funding_settlement_json(settlement.id),
    'funding', abos.temporary_funding_json(funding.id), 'replayed', false);
  PERFORM abos.temporary_funding_idempotency_complete(v_scope, v_key, 'TEMPORARY_FUNDING_SETTLEMENT_DECISION',
    settlement.id, v_result);
  RETURN v_result;
END
$decide$;

-- ---------------------------------------------------------------------------------------------------
-- Least-privilege owner and runtime boundary.
-- ---------------------------------------------------------------------------------------------------
GRANT SELECT ON abos.temporary_fundings, abos.temporary_funding_decisions, abos.temporary_funding_settlements,
  abos.temporary_funding_settlement_decisions, abos.temporary_funding_account_mapping_versions,
  abos.journal_reversal_links
TO abos_v1_operational_finance_owner;
GRANT SELECT (status) ON abos.user_accounts TO abos_v1_operational_finance_owner;
GRANT SELECT (user_account_id, legal_entity_id, revoked_at)
  ON abos.user_permission_grants TO abos_v1_operational_finance_owner;
GRANT INSERT (id, legal_entity_id, document_id, evidence_kind, evidence_version, sha256, completed_at)
  ON abos.evidence_references TO abos_v1_operational_finance_owner;
GRANT INSERT (id, legal_entity_id, version, payable_ledger_account_id, evidence_reference_id,
  evidence_document_reference, change_reason, configured_by_user_account_id, correlation_id, idempotency_key,
  request_fingerprint)
  ON abos.temporary_funding_account_mapping_versions TO abos_v1_operational_finance_owner;
GRANT INSERT (id, legal_entity_id, funding_mode, provider_kind, provider_business_party_id,
  provider_user_account_id, operational_expense_category_id, payee_business_party_id, project_id, department_id,
  cost_center_id, operational_treasury_account_id, reference, description, note, business_date, original_amount,
  original_currency_code, base_amount, base_currency_code, workflow_policy_version_id, mapping_version_id,
  correlation_id, idempotency_key, request_fingerprint, status, version, created_by_user_account_id)
  ON abos.temporary_fundings TO abos_v1_operational_finance_owner;
GRANT UPDATE (status, status_reason, version, journal_id, updated_at)
  ON abos.temporary_fundings TO abos_v1_operational_finance_owner;
GRANT INSERT (id, legal_entity_id, temporary_funding_id, decision, decision_reason, decided_by_user_account_id,
  correlation_id)
  ON abos.temporary_funding_decisions TO abos_v1_operational_finance_owner;
GRANT INSERT (id, legal_entity_id, temporary_funding_id, operational_treasury_account_id, reference, note,
  business_date, original_amount, original_currency_code, base_amount, base_currency_code, funding_version,
  workflow_policy_version_id, correlation_id, idempotency_key, request_fingerprint, status, version,
  created_by_user_account_id)
  ON abos.temporary_funding_settlements TO abos_v1_operational_finance_owner;
GRANT UPDATE (status, status_reason, version, journal_id, updated_at)
  ON abos.temporary_funding_settlements TO abos_v1_operational_finance_owner;
GRANT INSERT (id, legal_entity_id, settlement_id, decision, decision_reason, decided_by_user_account_id,
  correlation_id)
  ON abos.temporary_funding_settlement_decisions TO abos_v1_operational_finance_owner;
GRANT INSERT (temporary_funding_id, temporary_funding_settlement_id, temporary_funding_mapping_version_id)
  ON abos.posting_intents TO abos_v1_operational_finance_owner;
GRANT INSERT (temporary_funding_id, temporary_funding_settlement_id)
  ON abos.subledger_entries TO abos_v1_operational_finance_owner;

REVOKE ALL ON FUNCTION
  abos.guard_temporary_funding_mapping_version(), abos.guard_temporary_funding(),
  abos.guard_temporary_funding_decision(), abos.guard_temporary_funding_settlement(),
  abos.guard_temporary_funding_settlement_decision(), abos.refuse_temporary_funding_reversal_link(),
  abos.validate_temporary_funding_journal_posting(),
  abos.temporary_funding_actor(text, text, text, text[]), abos.temporary_funding_amount(text),
  abos.temporary_funding_idempotency_begin(text, text, text, uuid),
  abos.temporary_funding_idempotency_complete(text, text, text, uuid, jsonb),
  abos.temporary_funding_fingerprint(jsonb, text, uuid),
  abos.temporary_funding_audit(uuid, uuid, uuid, text, text, uuid, jsonb),
  abos.temporary_funding_current_policy(uuid), abos.temporary_funding_current_mapping(uuid),
  abos.temporary_funding_open_period(uuid, date), abos.temporary_funding_treasury_ledger(uuid, uuid, text, boolean),
  abos.temporary_funding_settlement_json(uuid), abos.temporary_funding_json(uuid),
  abos.temporary_funding_post(uuid, uuid), abos.temporary_funding_settlement_post(uuid, uuid),
  abos.temporary_funding_workspace(text, text, text),
  abos.configure_temporary_funding_mapping(text, text, text, jsonb),
  abos.record_temporary_funding(text, text, text, jsonb),
  abos.decide_temporary_funding(text, text, text, uuid, jsonb),
  abos.request_temporary_funding_settlement(text, text, text, jsonb),
  abos.decide_temporary_funding_settlement(text, text, text, uuid, jsonb)
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
  abos.temporary_funding_actor(text, text, text, text[]), abos.temporary_funding_amount(text),
  abos.temporary_funding_idempotency_begin(text, text, text, uuid),
  abos.temporary_funding_idempotency_complete(text, text, text, uuid, jsonb),
  abos.temporary_funding_fingerprint(jsonb, text, uuid),
  abos.temporary_funding_audit(uuid, uuid, uuid, text, text, uuid, jsonb),
  abos.temporary_funding_current_policy(uuid), abos.temporary_funding_current_mapping(uuid),
  abos.temporary_funding_open_period(uuid, date), abos.temporary_funding_treasury_ledger(uuid, uuid, text, boolean),
  abos.temporary_funding_settlement_json(uuid), abos.temporary_funding_json(uuid),
  abos.temporary_funding_post(uuid, uuid), abos.temporary_funding_settlement_post(uuid, uuid)
TO abos_v1_operational_finance_owner;

ALTER FUNCTION abos.temporary_funding_workspace(text, text, text) OWNER TO abos_v1_operational_finance_owner;
ALTER FUNCTION abos.configure_temporary_funding_mapping(text, text, text, jsonb)
  OWNER TO abos_v1_operational_finance_owner;
ALTER FUNCTION abos.record_temporary_funding(text, text, text, jsonb) OWNER TO abos_v1_operational_finance_owner;
ALTER FUNCTION abos.decide_temporary_funding(text, text, text, uuid, jsonb)
  OWNER TO abos_v1_operational_finance_owner;
ALTER FUNCTION abos.request_temporary_funding_settlement(text, text, text, jsonb)
  OWNER TO abos_v1_operational_finance_owner;
ALTER FUNCTION abos.decide_temporary_funding_settlement(text, text, text, uuid, jsonb)
  OWNER TO abos_v1_operational_finance_owner;

GRANT EXECUTE ON FUNCTION
  abos.temporary_funding_workspace(text, text, text),
  abos.configure_temporary_funding_mapping(text, text, text, jsonb),
  abos.record_temporary_funding(text, text, text, jsonb),
  abos.decide_temporary_funding(text, text, text, uuid, jsonb),
  abos.request_temporary_funding_settlement(text, text, text, jsonb),
  abos.decide_temporary_funding_settlement(text, text, text, uuid, jsonb)
TO abos_e1_runtime;

REVOKE ALL ON abos.temporary_fundings, abos.temporary_funding_decisions, abos.temporary_funding_settlements,
  abos.temporary_funding_settlement_decisions, abos.temporary_funding_account_mapping_versions
FROM PUBLIC, abos_v1_identity_runtime, abos_e1_runtime, abos_e1_treasury_runtime;
