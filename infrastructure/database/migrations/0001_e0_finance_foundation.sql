CREATE SCHEMA IF NOT EXISTS abos;

CREATE TABLE IF NOT EXISTS abos.schema_migrations (
  migration_id text PRIMARY KEY,
  checksum_sha256 text NOT NULL CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE abos.currencies (
  code text PRIMARY KEY CHECK (code ~ '^[A-Z]{3}$'),
  name text NOT NULL CHECK (btrim(name) <> ''),
  enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE abos.companies (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE CHECK (btrim(code) <> ''),
  name text NOT NULL CHECK (btrim(name) <> ''),
  status text NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT', 'ACTIVE', 'SUSPENDED', 'ARCHIVED')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE abos.legal_entities (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES abos.companies(id),
  code text NOT NULL UNIQUE CHECK (btrim(code) <> ''),
  name text NOT NULL CHECK (btrim(name) <> ''),
  base_currency_code text REFERENCES abos.currencies(code),
  currency_policy_status text NOT NULL DEFAULT 'PENDING'
    CHECK (currency_policy_status IN ('PENDING', 'APPROVED', 'SUSPENDED')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, company_id),
  CHECK (currency_policy_status <> 'APPROVED' OR base_currency_code IS NOT NULL)
);

CREATE TABLE abos.projects (
  id uuid PRIMARY KEY,
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  code text NOT NULL CHECK (btrim(code) <> ''),
  name text NOT NULL CHECK (btrim(name) <> ''),
  active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (legal_entity_id, code),
  UNIQUE (id, legal_entity_id)
);

CREATE TABLE abos.departments (
  id uuid PRIMARY KEY,
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  code text NOT NULL CHECK (btrim(code) <> ''),
  name text NOT NULL CHECK (btrim(name) <> ''),
  active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (legal_entity_id, code),
  UNIQUE (id, legal_entity_id)
);

CREATE TABLE abos.cost_centers (
  id uuid PRIMARY KEY,
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  code text NOT NULL CHECK (btrim(code) <> ''),
  name text NOT NULL CHECK (btrim(name) <> ''),
  active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (legal_entity_id, code),
  UNIQUE (id, legal_entity_id)
);

-- Type A: authentication identity only.
CREATE TABLE abos.user_accounts (
  id uuid PRIMARY KEY,
  login_identifier text NOT NULL UNIQUE CHECK (btrim(login_identifier) <> ''),
  display_name text NOT NULL CHECK (btrim(display_name) <> ''),
  status text NOT NULL DEFAULT 'INVITED'
    CHECK (status IN ('INVITED', 'ACTIVE', 'DISABLED', 'REVOKED')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  disabled_at timestamptz
);

CREATE TABLE abos.evidence_references (
  id uuid PRIMARY KEY,
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  document_id uuid NOT NULL,
  evidence_kind text NOT NULL CHECK (evidence_kind IN
    ('CAPITAL_AGREEMENT', 'FORMAL_REGISTRATION', 'PHYSICAL_CASH_COUNT', 'CASH_RECEIPT',
     'OPENING_RECONCILIATION', 'FINANCE_APPROVAL', 'REVERSAL_REASON')),
  evidence_version integer NOT NULL CHECK (evidence_version > 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  completed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (legal_entity_id, document_id, evidence_version),
  UNIQUE (id, legal_entity_id)
);

-- Type B: counterparty. This is never a login or GL account.
CREATE TABLE abos.business_parties (
  id uuid PRIMARY KEY,
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  display_name text NOT NULL CHECK (btrim(display_name) <> ''),
  external_reference text,
  status text NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT', 'ACTIVE', 'SUSPENDED', 'ARCHIVED')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, legal_entity_id)
);
CREATE UNIQUE INDEX business_parties_external_ref_uq
  ON abos.business_parties(legal_entity_id, external_reference)
  WHERE external_reference IS NOT NULL;

CREATE TABLE abos.business_party_roles (
  business_party_id uuid NOT NULL REFERENCES abos.business_parties(id),
  role_code text NOT NULL
    CHECK (role_code IN ('SHAREHOLDER', 'SARAF', 'CUSTOMER', 'SUPPLIER', 'CONTRACTOR', 'EMPLOYEE')),
  effective_from date NOT NULL,
  effective_to date,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (business_party_id, role_code, effective_from),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE OR REPLACE FUNCTION abos.validate_shareholder_profile_role()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM abos.business_party_roles role
     WHERE role.business_party_id = NEW.business_party_id
       AND role.role_code = 'SHAREHOLDER'
       AND role.effective_from <= current_date
       AND (role.effective_to IS NULL OR role.effective_to >= current_date)
  ) THEN
    RAISE EXCEPTION 'shareholder profile requires a current SHAREHOLDER business-party role';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE abos.accounting_periods (
  id uuid PRIMARY KEY,
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  period_name text NOT NULL CHECK (btrim(period_name) <> ''),
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'OPEN', 'SOFT_CLOSED', 'CLOSED')),
  opened_by_user_account_id uuid REFERENCES abos.user_accounts(id),
  opened_at timestamptz,
  closed_by_user_account_id uuid REFERENCES abos.user_accounts(id),
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (legal_entity_id, period_name),
  UNIQUE (id, legal_entity_id),
  CHECK (ends_on >= starts_on),
  CHECK (status <> 'OPEN' OR (opened_by_user_account_id IS NOT NULL AND opened_at IS NOT NULL)),
  CHECK (status <> 'CLOSED' OR (closed_by_user_account_id IS NOT NULL AND closed_at IS NOT NULL))
);

-- Type C: Chart-of-Accounts member. Party and user IDs cannot be substituted here.
CREATE TABLE abos.ledger_accounts (
  id uuid PRIMARY KEY,
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  parent_ledger_account_id uuid,
  account_code text NOT NULL CHECK (btrim(account_code) <> ''),
  account_name text NOT NULL CHECK (btrim(account_name) <> ''),
  account_type text NOT NULL
    CHECK (account_type IN ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE')),
  control_account_type text
    CHECK (control_account_type IS NULL OR control_account_type IN
      ('CASH', 'SHAREHOLDER_CAPITAL', 'SHAREHOLDER_LOAN', 'AR', 'AP', 'OTHER')),
  posting_allowed boolean NOT NULL DEFAULT false,
  requires_project boolean NOT NULL DEFAULT false,
  requires_department boolean NOT NULL DEFAULT false,
  requires_cost_center boolean NOT NULL DEFAULT false,
  account_currency_code text REFERENCES abos.currencies(code),
  status text NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT', 'ACTIVE', 'INACTIVE')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (legal_entity_id, account_code),
  UNIQUE (id, legal_entity_id),
  UNIQUE (id, legal_entity_id, account_currency_code),
  FOREIGN KEY (parent_ledger_account_id, legal_entity_id)
    REFERENCES abos.ledger_accounts(id, legal_entity_id)
);

CREATE TABLE abos.shareholder_profiles (
  id uuid PRIMARY KEY,
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  business_party_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT', 'ACTIVE', 'SUSPENDED', 'ARCHIVED')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (business_party_id, legal_entity_id),
  UNIQUE (id, legal_entity_id),
  FOREIGN KEY (business_party_id, legal_entity_id)
    REFERENCES abos.business_parties(id, legal_entity_id)
);
CREATE TRIGGER shareholder_profiles_role_guard
BEFORE INSERT OR UPDATE ON abos.shareholder_profiles
FOR EACH ROW EXECUTE FUNCTION abos.validate_shareholder_profile_role();

CREATE TABLE abos.capital_agreements (
  id uuid PRIMARY KEY,
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  shareholder_profile_id uuid NOT NULL,
  agreement_reference text NOT NULL CHECK (btrim(agreement_reference) <> ''),
  agreement_kind text NOT NULL
    CHECK (agreement_kind IN ('CAPITAL_CONTRIBUTION', 'SHAREHOLDER_LOAN')),
  committed_amount numeric NOT NULL CHECK (committed_amount > 0),
  currency_code text NOT NULL REFERENCES abos.currencies(code),
  effective_on date NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT', 'PENDING_EVIDENCE', 'ELIGIBLE', 'SUSPENDED', 'CLOSED')),
  created_by_user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (legal_entity_id, agreement_reference),
  UNIQUE (id, legal_entity_id),
  UNIQUE (id, currency_code),
  FOREIGN KEY (shareholder_profile_id, legal_entity_id)
    REFERENCES abos.shareholder_profiles(id, legal_entity_id)
);

CREATE TABLE abos.registration_evidence (
  id uuid PRIMARY KEY,
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  capital_agreement_id uuid NOT NULL,
  evidence_reference_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'VERIFIED', 'REJECTED', 'SUPERSEDED')),
  verified_by_user_account_id uuid REFERENCES abos.user_accounts(id),
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (legal_entity_id, evidence_reference_id),
  FOREIGN KEY (capital_agreement_id, legal_entity_id)
    REFERENCES abos.capital_agreements(id, legal_entity_id),
  FOREIGN KEY (evidence_reference_id, legal_entity_id)
    REFERENCES abos.evidence_references(id, legal_entity_id),
  CHECK (status <> 'VERIFIED' OR
    (verified_by_user_account_id IS NOT NULL AND verified_at IS NOT NULL))
);

CREATE TABLE abos.capital_installments (
  id uuid PRIMARY KEY,
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  capital_agreement_id uuid NOT NULL,
  sequence_number integer NOT NULL CHECK (sequence_number > 0),
  expected_amount numeric NOT NULL CHECK (expected_amount > 0),
  currency_code text NOT NULL REFERENCES abos.currencies(code),
  due_on date,
  business_event_at timestamptz,
  status text NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT', 'PENDING_RECEIPT', 'RECEIVED_PENDING_APPROVAL', 'POSTED', 'REVERSED', 'CANCELLED')),
  created_by_user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (capital_agreement_id, sequence_number),
  UNIQUE (id, legal_entity_id),
  UNIQUE (id, currency_code),
  FOREIGN KEY (capital_agreement_id, legal_entity_id)
    REFERENCES abos.capital_agreements(id, legal_entity_id),
  FOREIGN KEY (capital_agreement_id, currency_code)
    REFERENCES abos.capital_agreements(id, currency_code)
);

CREATE TABLE abos.cash_locations (
  id uuid PRIMARY KEY,
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  location_name text NOT NULL CHECK (btrim(location_name) <> ''),
  responsible_cashier_user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  status text NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT', 'ACTIVE', 'INACTIVE')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (legal_entity_id, location_name),
  UNIQUE (id, legal_entity_id)
);

CREATE TABLE abos.cash_location_currency_accounts (
  id uuid PRIMARY KEY,
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  cash_location_id uuid NOT NULL,
  currency_code text NOT NULL REFERENCES abos.currencies(code),
  ledger_account_id uuid NOT NULL,
  activation_status text NOT NULL DEFAULT 'DRAFT'
    CHECK (activation_status IN ('DRAFT', 'RECONCILED', 'APPROVED', 'ACTIVE', 'BLOCKED')),
  reconciliation_evidence_reference_id uuid,
  activated_by_user_account_id uuid REFERENCES abos.user_accounts(id),
  activated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (cash_location_id, currency_code),
  UNIQUE (id, legal_entity_id),
  UNIQUE (id, currency_code),
  FOREIGN KEY (cash_location_id, legal_entity_id)
    REFERENCES abos.cash_locations(id, legal_entity_id),
  FOREIGN KEY (ledger_account_id, legal_entity_id, currency_code)
    REFERENCES abos.ledger_accounts(id, legal_entity_id, account_currency_code),
  FOREIGN KEY (reconciliation_evidence_reference_id, legal_entity_id)
    REFERENCES abos.evidence_references(id, legal_entity_id),
  CHECK (activation_status <> 'ACTIVE' OR
    (reconciliation_evidence_reference_id IS NOT NULL AND activated_by_user_account_id IS NOT NULL AND activated_at IS NOT NULL))
);

CREATE TABLE abos.physical_cash_counts (
  id uuid PRIMARY KEY,
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  cash_location_currency_account_id uuid NOT NULL,
  currency_code text NOT NULL REFERENCES abos.currencies(code),
  counted_amount numeric NOT NULL CHECK (counted_amount >= 0),
  counted_at timestamptz NOT NULL,
  counted_by_user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  evidence_reference_id uuid,
  status text NOT NULL DEFAULT 'RECORDED'
    CHECK (status IN ('RECORDED', 'CONFIRMED', 'DISCREPANCY', 'VOIDED')),
  confirmed_by_user_account_id uuid REFERENCES abos.user_accounts(id),
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, legal_entity_id),
  UNIQUE (id, cash_location_currency_account_id, currency_code),
  FOREIGN KEY (cash_location_currency_account_id, legal_entity_id)
    REFERENCES abos.cash_location_currency_accounts(id, legal_entity_id),
  FOREIGN KEY (cash_location_currency_account_id, currency_code)
    REFERENCES abos.cash_location_currency_accounts(id, currency_code),
  FOREIGN KEY (evidence_reference_id, legal_entity_id)
    REFERENCES abos.evidence_references(id, legal_entity_id),
  CHECK (confirmed_by_user_account_id IS NULL OR confirmed_by_user_account_id <> counted_by_user_account_id),
  CHECK (status <> 'CONFIRMED' OR (confirmed_by_user_account_id IS NOT NULL AND confirmed_at IS NOT NULL))
);

CREATE TABLE abos.cash_receipts (
  id uuid PRIMARY KEY,
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  capital_installment_id uuid,
  cash_location_currency_account_id uuid NOT NULL,
  physical_cash_count_id uuid,
  receipt_reference text NOT NULL CHECK (btrim(receipt_reference) <> ''),
  amount numeric NOT NULL CHECK (amount > 0),
  currency_code text NOT NULL REFERENCES abos.currencies(code),
  business_event_at timestamptz NOT NULL,
  received_by_user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  evidence_reference_id uuid,
  status text NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT', 'COUNTED', 'VERIFIED', 'VOIDED')),
  verified_by_user_account_id uuid REFERENCES abos.user_accounts(id),
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (legal_entity_id, receipt_reference),
  UNIQUE (id, legal_entity_id),
  FOREIGN KEY (capital_installment_id, legal_entity_id)
    REFERENCES abos.capital_installments(id, legal_entity_id),
  FOREIGN KEY (capital_installment_id, currency_code)
    REFERENCES abos.capital_installments(id, currency_code),
  FOREIGN KEY (cash_location_currency_account_id, legal_entity_id)
    REFERENCES abos.cash_location_currency_accounts(id, legal_entity_id),
  FOREIGN KEY (cash_location_currency_account_id, currency_code)
    REFERENCES abos.cash_location_currency_accounts(id, currency_code),
  FOREIGN KEY (physical_cash_count_id, legal_entity_id)
    REFERENCES abos.physical_cash_counts(id, legal_entity_id),
  FOREIGN KEY (physical_cash_count_id, cash_location_currency_account_id, currency_code)
    REFERENCES abos.physical_cash_counts(id, cash_location_currency_account_id, currency_code),
  FOREIGN KEY (evidence_reference_id, legal_entity_id)
    REFERENCES abos.evidence_references(id, legal_entity_id),
  CHECK (verified_by_user_account_id IS NULL OR verified_by_user_account_id <> received_by_user_account_id),
  CHECK (status <> 'VERIFIED' OR
    (physical_cash_count_id IS NOT NULL AND evidence_reference_id IS NOT NULL AND
     verified_by_user_account_id IS NOT NULL AND verified_at IS NOT NULL))
);

CREATE TABLE abos.posting_intents (
  id uuid PRIMARY KEY,
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  project_id uuid,
  department_id uuid,
  cost_center_id uuid,
  source_type text NOT NULL CHECK (btrim(source_type) <> ''),
  source_id uuid NOT NULL,
  treasury_cash_receipt_id uuid,
  intent_kind text NOT NULL
    CHECK (intent_kind IN ('SHAREHOLDER_CAPITAL_RECEIPT', 'SHAREHOLDER_LOAN_RECEIPT', 'REVERSAL')),
  original_amount numeric NOT NULL CHECK (original_amount > 0),
  original_currency_code text NOT NULL REFERENCES abos.currencies(code),
  base_amount numeric,
  base_currency_code text REFERENCES abos.currencies(code),
  conversion_snapshot_reference text,
  accounting_effective_date date NOT NULL,
  correlation_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (btrim(idempotency_key) <> ''),
  status text NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'POSTED', 'CANCELLED')),
  created_by_user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (legal_entity_id, idempotency_key),
  UNIQUE (legal_entity_id, source_type, source_id),
  CONSTRAINT posting_intents_one_intent_per_receipt
    UNIQUE (legal_entity_id, treasury_cash_receipt_id),
  UNIQUE (id, legal_entity_id),
  FOREIGN KEY (project_id, legal_entity_id) REFERENCES abos.projects(id, legal_entity_id),
  FOREIGN KEY (department_id, legal_entity_id) REFERENCES abos.departments(id, legal_entity_id),
  FOREIGN KEY (cost_center_id, legal_entity_id) REFERENCES abos.cost_centers(id, legal_entity_id),
  FOREIGN KEY (treasury_cash_receipt_id, legal_entity_id) REFERENCES abos.cash_receipts(id, legal_entity_id),
  CHECK ((base_amount IS NULL) = (base_currency_code IS NULL)),
  CHECK (base_amount IS NULL OR base_amount > 0),
  CHECK (conversion_snapshot_reference IS NULL),
  CHECK (base_currency_code IS NULL OR original_currency_code = base_currency_code)
);

CREATE TABLE abos.posting_approvals (
  id uuid PRIMARY KEY,
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  posting_intent_id uuid NOT NULL,
  decision text NOT NULL CHECK (decision IN ('APPROVED', 'REJECTED')),
  decision_reason text,
  approver_user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  evidence_reference_id uuid NOT NULL,
  approved_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (posting_intent_id, approver_user_account_id),
  FOREIGN KEY (posting_intent_id, legal_entity_id)
    REFERENCES abos.posting_intents(id, legal_entity_id),
  FOREIGN KEY (evidence_reference_id, legal_entity_id)
    REFERENCES abos.evidence_references(id, legal_entity_id)
);

CREATE TABLE abos.journals (
  id uuid PRIMARY KEY,
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  accounting_period_id uuid NOT NULL,
  posting_intent_id uuid NOT NULL,
  journal_reference text NOT NULL CHECK (btrim(journal_reference) <> ''),
  accounting_effective_date date NOT NULL,
  base_currency_code text NOT NULL REFERENCES abos.currencies(code),
  status text NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT', 'VALIDATED', 'POSTED')),
  created_by_user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  posted_by_user_account_id uuid REFERENCES abos.user_accounts(id),
  posted_at timestamptz,
  UNIQUE (legal_entity_id, journal_reference),
  UNIQUE (posting_intent_id),
  UNIQUE (id, legal_entity_id),
  FOREIGN KEY (accounting_period_id, legal_entity_id)
    REFERENCES abos.accounting_periods(id, legal_entity_id),
  FOREIGN KEY (posting_intent_id, legal_entity_id)
    REFERENCES abos.posting_intents(id, legal_entity_id),
  CHECK (status <> 'POSTED' OR
    (posted_by_user_account_id IS NOT NULL AND posted_at IS NOT NULL))
);

CREATE TABLE abos.journal_lines (
  id uuid PRIMARY KEY,
  journal_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  line_number integer NOT NULL CHECK (line_number > 0),
  ledger_account_id uuid NOT NULL,
  business_party_id uuid,
  project_id uuid,
  department_id uuid,
  cost_center_id uuid,
  original_amount numeric,
  original_currency_code text REFERENCES abos.currencies(code),
  base_debit numeric NOT NULL DEFAULT 0 CHECK (base_debit >= 0),
  base_credit numeric NOT NULL DEFAULT 0 CHECK (base_credit >= 0),
  base_currency_code text NOT NULL REFERENCES abos.currencies(code),
  conversion_snapshot_reference text,
  source_type text NOT NULL CHECK (btrim(source_type) <> ''),
  source_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (journal_id, line_number),
  UNIQUE (id, legal_entity_id),
  FOREIGN KEY (journal_id, legal_entity_id) REFERENCES abos.journals(id, legal_entity_id),
  FOREIGN KEY (ledger_account_id, legal_entity_id) REFERENCES abos.ledger_accounts(id, legal_entity_id),
  FOREIGN KEY (business_party_id, legal_entity_id) REFERENCES abos.business_parties(id, legal_entity_id),
  FOREIGN KEY (project_id, legal_entity_id) REFERENCES abos.projects(id, legal_entity_id),
  FOREIGN KEY (department_id, legal_entity_id) REFERENCES abos.departments(id, legal_entity_id),
  FOREIGN KEY (cost_center_id, legal_entity_id) REFERENCES abos.cost_centers(id, legal_entity_id),
  CHECK ((base_debit > 0 AND base_credit = 0) OR (base_credit > 0 AND base_debit = 0)),
  CHECK ((original_amount IS NULL) = (original_currency_code IS NULL)),
  CHECK (original_amount IS NULL OR original_amount > 0),
  CHECK (conversion_snapshot_reference IS NULL),
  CHECK (original_currency_code IS NULL OR original_currency_code = base_currency_code)
);

CREATE TABLE abos.journal_reversal_links (
  original_journal_id uuid PRIMARY KEY REFERENCES abos.journals(id),
  reversal_journal_id uuid NOT NULL UNIQUE REFERENCES abos.journals(id),
  reason text NOT NULL CHECK (btrim(reason) <> ''),
  approved_by_user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  evidence_reference_id uuid NOT NULL,
  linked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (evidence_reference_id) REFERENCES abos.evidence_references(id),
  CHECK (original_journal_id <> reversal_journal_id)
);

CREATE TABLE abos.subledger_entries (
  id uuid PRIMARY KEY,
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  journal_line_id uuid NOT NULL,
  subledger_type text NOT NULL
    CHECK (subledger_type IN ('SHAREHOLDER_CAPITAL', 'SHAREHOLDER_LOAN', 'CASH_LOCATION')),
  business_party_id uuid,
  cash_location_currency_account_id uuid,
  original_amount numeric NOT NULL CHECK (original_amount <> 0),
  original_currency_code text NOT NULL REFERENCES abos.currencies(code),
  base_amount numeric NOT NULL CHECK (base_amount <> 0),
  base_currency_code text NOT NULL REFERENCES abos.currencies(code),
  source_type text NOT NULL CHECK (btrim(source_type) <> ''),
  source_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (journal_line_id, subledger_type),
  FOREIGN KEY (journal_line_id, legal_entity_id) REFERENCES abos.journal_lines(id, legal_entity_id),
  FOREIGN KEY (business_party_id, legal_entity_id) REFERENCES abos.business_parties(id, legal_entity_id),
  FOREIGN KEY (cash_location_currency_account_id, legal_entity_id)
    REFERENCES abos.cash_location_currency_accounts(id, legal_entity_id),
  CHECK ((subledger_type IN ('SHAREHOLDER_CAPITAL', 'SHAREHOLDER_LOAN')) = (business_party_id IS NOT NULL)),
  CHECK ((subledger_type = 'CASH_LOCATION') = (cash_location_currency_account_id IS NOT NULL))
);

CREATE TABLE abos.idempotency_records (
  scope text NOT NULL CHECK (btrim(scope) <> ''),
  idempotency_key text NOT NULL CHECK (btrim(idempotency_key) <> ''),
  request_fingerprint text NOT NULL CHECK (btrim(request_fingerprint) <> ''),
  correlation_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('IN_PROGRESS', 'COMPLETED', 'FAILED')),
  resource_type text,
  resource_id uuid,
  response_code integer,
  response_snapshot jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  PRIMARY KEY (scope, idempotency_key),
  CHECK ((status = 'COMPLETED') = (completed_at IS NOT NULL))
);

CREATE TABLE abos.audit_records (
  id uuid PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_user_account_id uuid REFERENCES abos.user_accounts(id),
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  correlation_id uuid NOT NULL,
  action text NOT NULL CHECK (btrim(action) <> ''),
  entity_type text NOT NULL CHECK (btrim(entity_type) <> ''),
  entity_id uuid,
  before_state jsonb,
  after_state jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE abos.outbox_events (
  id uuid PRIMARY KEY,
  aggregate_type text NOT NULL CHECK (btrim(aggregate_type) <> ''),
  aggregate_id uuid NOT NULL,
  event_type text NOT NULL CHECK (btrim(event_type) <> ''),
  event_version integer NOT NULL CHECK (event_version > 0),
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  actor_user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  correlation_id uuid NOT NULL,
  payload jsonb NOT NULL,
  security_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  published_at timestamptz,
  publish_attempts integer NOT NULL DEFAULT 0 CHECK (publish_attempts >= 0),
  last_error text
);

CREATE INDEX capital_installments_agreement_idx ON abos.capital_installments(capital_agreement_id);
CREATE INDEX cash_receipts_account_idx ON abos.cash_receipts(cash_location_currency_account_id, business_event_at);
CREATE INDEX posting_intents_status_idx ON abos.posting_intents(legal_entity_id, status, accounting_effective_date);
CREATE INDEX journals_period_status_idx ON abos.journals(accounting_period_id, status);
CREATE INDEX journal_lines_account_idx ON abos.journal_lines(ledger_account_id, journal_id);
CREATE INDEX subledger_party_idx ON abos.subledger_entries(business_party_id) WHERE business_party_id IS NOT NULL;
CREATE INDEX outbox_available_idx ON abos.outbox_events(available_at, recorded_at) WHERE published_at IS NULL;
CREATE INDEX audit_entity_idx ON abos.audit_records(entity_type, entity_id, occurred_at);

CREATE OR REPLACE FUNCTION abos.validate_cash_account_activation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  ledger_status text;
  ledger_control_type text;
  ledger_posting_allowed boolean;
  location_status text;
  activation_evidence_kind text;
BEGIN
  IF NEW.activation_status = 'ACTIVE' THEN
    SELECT status, control_account_type, posting_allowed
      INTO ledger_status, ledger_control_type, ledger_posting_allowed
      FROM abos.ledger_accounts
     WHERE id = NEW.ledger_account_id
       AND legal_entity_id = NEW.legal_entity_id
       AND account_currency_code = NEW.currency_code;

    SELECT status INTO location_status
      FROM abos.cash_locations
     WHERE id = NEW.cash_location_id
       AND legal_entity_id = NEW.legal_entity_id;
    SELECT evidence_kind INTO activation_evidence_kind
      FROM abos.evidence_references
     WHERE id = NEW.reconciliation_evidence_reference_id
       AND legal_entity_id = NEW.legal_entity_id;

    IF ledger_status IS DISTINCT FROM 'ACTIVE'
       OR ledger_control_type IS DISTINCT FROM 'CASH'
       OR ledger_posting_allowed IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'active cash currency account requires an active posting CASH ledger account in the same currency';
    END IF;
    IF location_status IS DISTINCT FROM 'ACTIVE' THEN
      RAISE EXCEPTION 'active cash currency account requires an active cash location';
    END IF;
    IF activation_evidence_kind IS DISTINCT FROM 'OPENING_RECONCILIATION' THEN
      RAISE EXCEPTION 'active cash currency account requires structured opening-reconciliation evidence';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cash_account_activation_guard
BEFORE INSERT OR UPDATE ON abos.cash_location_currency_accounts
FOR EACH ROW EXECUTE FUNCTION abos.validate_cash_account_activation();
CREATE OR REPLACE FUNCTION abos.prevent_audit_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit records are append-only';
END;
$$;
CREATE TRIGGER audit_records_no_update_or_delete
BEFORE UPDATE OR DELETE ON abos.audit_records
FOR EACH ROW EXECUTE FUNCTION abos.prevent_audit_mutation();
CREATE TRIGGER evidence_references_no_update_or_delete
BEFORE UPDATE OR DELETE ON abos.evidence_references
FOR EACH ROW EXECUTE FUNCTION abos.prevent_audit_mutation();

CREATE OR REPLACE FUNCTION abos.enforce_posting_approval_sod()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  creator_id uuid;
  cashier_id uuid;
  counter_id uuid;
  approval_evidence_kind text;
BEGIN
  SELECT pi.created_by_user_account_id, cr.received_by_user_account_id,
         pc.counted_by_user_account_id
    INTO creator_id, cashier_id, counter_id
    FROM abos.posting_intents pi
    LEFT JOIN abos.cash_receipts cr
      ON cr.id = pi.treasury_cash_receipt_id
     AND cr.legal_entity_id = pi.legal_entity_id
    LEFT JOIN abos.physical_cash_counts pc
      ON pc.id = cr.physical_cash_count_id
     AND pc.legal_entity_id = cr.legal_entity_id
   WHERE pi.id = NEW.posting_intent_id
     AND pi.legal_entity_id = NEW.legal_entity_id;
  IF creator_id IS NULL THEN
    RAISE EXCEPTION 'posting intent not found in approval legal entity';
  END IF;
  IF creator_id = NEW.approver_user_account_id
     OR cashier_id = NEW.approver_user_account_id
     OR counter_id = NEW.approver_user_account_id THEN
    RAISE EXCEPTION 'posting intent creator, cashier or cash counter cannot approve the same intent';
  END IF;
  SELECT evidence_kind INTO approval_evidence_kind
    FROM abos.evidence_references
   WHERE id = NEW.evidence_reference_id
     AND legal_entity_id = NEW.legal_entity_id;
  IF approval_evidence_kind IS DISTINCT FROM 'FINANCE_APPROVAL' THEN
    RAISE EXCEPTION 'posting approval requires structured FINANCE_APPROVAL evidence';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER posting_approvals_sod
BEFORE INSERT OR UPDATE ON abos.posting_approvals
FOR EACH ROW EXECUTE FUNCTION abos.enforce_posting_approval_sod();

CREATE OR REPLACE FUNCTION abos.validate_treasury_evidence_kind()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected_kind text; actual_kind text;
BEGIN
  expected_kind := CASE TG_TABLE_NAME
    WHEN 'physical_cash_counts' THEN 'PHYSICAL_CASH_COUNT'
    WHEN 'cash_receipts' THEN 'CASH_RECEIPT'
  END;
  IF NEW.evidence_reference_id IS NOT NULL THEN
    SELECT evidence_kind INTO actual_kind FROM abos.evidence_references
     WHERE id = NEW.evidence_reference_id AND legal_entity_id = NEW.legal_entity_id;
    IF actual_kind IS DISTINCT FROM expected_kind THEN
      RAISE EXCEPTION 'Treasury record requires structured % evidence', expected_kind;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER physical_cash_counts_evidence_guard
BEFORE INSERT OR UPDATE ON abos.physical_cash_counts
FOR EACH ROW EXECUTE FUNCTION abos.validate_treasury_evidence_kind();
CREATE TRIGGER cash_receipts_evidence_guard
BEFORE INSERT OR UPDATE ON abos.cash_receipts
FOR EACH ROW EXECUTE FUNCTION abos.validate_treasury_evidence_kind();
CREATE OR REPLACE FUNCTION abos.validate_registration_evidence_kind()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actual_kind text;
BEGIN
  SELECT evidence_kind INTO actual_kind FROM abos.evidence_references
   WHERE id = NEW.evidence_reference_id AND legal_entity_id = NEW.legal_entity_id;
  IF actual_kind IS DISTINCT FROM 'FORMAL_REGISTRATION' THEN
    RAISE EXCEPTION 'capital registration requires structured FORMAL_REGISTRATION evidence';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER registration_evidence_kind_guard
BEFORE INSERT OR UPDATE ON abos.registration_evidence
FOR EACH ROW EXECUTE FUNCTION abos.validate_registration_evidence_kind();

CREATE OR REPLACE FUNCTION abos.guard_posted_financial_provenance()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE is_posted boolean;
BEGIN
  IF TG_TABLE_NAME = 'posting_intents' THEN
    SELECT EXISTS (SELECT 1 FROM abos.journals j
                    WHERE j.posting_intent_id = OLD.id AND j.status = 'POSTED') INTO is_posted;
  ELSIF TG_TABLE_NAME = 'posting_approvals' THEN
    SELECT EXISTS (SELECT 1 FROM abos.journals j
                    WHERE j.posting_intent_id = OLD.posting_intent_id AND j.status = 'POSTED') INTO is_posted;
  ELSIF TG_TABLE_NAME = 'cash_receipts' THEN
    SELECT EXISTS (
      SELECT 1 FROM abos.posting_intents pi
      JOIN abos.journals j ON j.posting_intent_id = pi.id
      WHERE pi.treasury_cash_receipt_id = OLD.id AND j.status = 'POSTED'
    ) INTO is_posted;
  ELSIF TG_TABLE_NAME = 'physical_cash_counts' THEN
    SELECT EXISTS (
      SELECT 1 FROM abos.cash_receipts cr
      JOIN abos.posting_intents pi ON pi.treasury_cash_receipt_id = cr.id
      JOIN abos.journals j ON j.posting_intent_id = pi.id
      WHERE cr.physical_cash_count_id = OLD.id AND j.status = 'POSTED'
    ) INTO is_posted;
  ELSIF TG_TABLE_NAME = 'cash_location_currency_accounts' THEN
    SELECT EXISTS (
      SELECT 1 FROM abos.cash_receipts cr
      JOIN abos.posting_intents pi ON pi.treasury_cash_receipt_id = cr.id
      JOIN abos.journals j ON j.posting_intent_id = pi.id
      WHERE cr.cash_location_currency_account_id = OLD.id AND j.status = 'POSTED'
    ) INTO is_posted;
  ELSIF TG_TABLE_NAME = 'cash_locations' THEN
    SELECT EXISTS (
      SELECT 1 FROM abos.cash_location_currency_accounts ca
      JOIN abos.cash_receipts cr ON cr.cash_location_currency_account_id = ca.id
      JOIN abos.posting_intents pi ON pi.treasury_cash_receipt_id = cr.id
      JOIN abos.journals j ON j.posting_intent_id = pi.id
      WHERE ca.cash_location_id = OLD.id AND j.status = 'POSTED'
    ) INTO is_posted;
  ELSIF TG_TABLE_NAME = 'capital_installments' THEN
    SELECT EXISTS (
      SELECT 1 FROM abos.cash_receipts cr
      JOIN abos.posting_intents pi ON pi.treasury_cash_receipt_id = cr.id
      JOIN abos.journals j ON j.posting_intent_id = pi.id
      WHERE cr.capital_installment_id = OLD.id AND j.status = 'POSTED'
    ) INTO is_posted;
  ELSIF TG_TABLE_NAME = 'capital_agreements' THEN
    SELECT EXISTS (
      SELECT 1 FROM abos.capital_installments ci
      JOIN abos.cash_receipts cr ON cr.capital_installment_id = ci.id
      JOIN abos.posting_intents pi ON pi.treasury_cash_receipt_id = cr.id
      JOIN abos.journals j ON j.posting_intent_id = pi.id
      WHERE ci.capital_agreement_id = OLD.id AND j.status = 'POSTED'
    ) INTO is_posted;
  ELSIF TG_TABLE_NAME = 'shareholder_profiles' THEN
    SELECT EXISTS (
      SELECT 1 FROM abos.capital_agreements ca
      JOIN abos.capital_installments ci ON ci.capital_agreement_id = ca.id
      JOIN abos.cash_receipts cr ON cr.capital_installment_id = ci.id
      JOIN abos.posting_intents pi ON pi.treasury_cash_receipt_id = cr.id
      JOIN abos.journals j ON j.posting_intent_id = pi.id
      WHERE ca.shareholder_profile_id = OLD.id AND j.status = 'POSTED'
    ) INTO is_posted;
  ELSIF TG_TABLE_NAME = 'business_parties' THEN
    SELECT EXISTS (
      SELECT 1 FROM abos.shareholder_profiles sp
      JOIN abos.capital_agreements ca ON ca.shareholder_profile_id = sp.id
      JOIN abos.capital_installments ci ON ci.capital_agreement_id = ca.id
      JOIN abos.cash_receipts cr ON cr.capital_installment_id = ci.id
      JOIN abos.posting_intents pi ON pi.treasury_cash_receipt_id = cr.id
      JOIN abos.journals j ON j.posting_intent_id = pi.id
      WHERE sp.business_party_id = OLD.id AND j.status = 'POSTED'
    ) INTO is_posted;
  ELSIF TG_TABLE_NAME = 'business_party_roles' THEN
    SELECT EXISTS (
      SELECT 1 FROM abos.shareholder_profiles sp
      JOIN abos.capital_agreements ca ON ca.shareholder_profile_id = sp.id
      JOIN abos.capital_installments ci ON ci.capital_agreement_id = ca.id
      JOIN abos.cash_receipts cr ON cr.capital_installment_id = ci.id
      JOIN abos.posting_intents pi ON pi.treasury_cash_receipt_id = cr.id
      JOIN abos.journals j ON j.posting_intent_id = pi.id
      WHERE sp.business_party_id = OLD.business_party_id AND j.status = 'POSTED'
    ) INTO is_posted;
  ELSIF TG_TABLE_NAME = 'registration_evidence' THEN
    SELECT EXISTS (
      SELECT 1 FROM abos.capital_installments ci
      JOIN abos.cash_receipts cr ON cr.capital_installment_id = ci.id
      JOIN abos.posting_intents pi ON pi.treasury_cash_receipt_id = cr.id
      JOIN abos.journals j ON j.posting_intent_id = pi.id
      WHERE ci.capital_agreement_id = OLD.capital_agreement_id AND j.status = 'POSTED'
    ) INTO is_posted;
  ELSIF TG_TABLE_NAME = 'ledger_accounts' THEN
    SELECT EXISTS (
      SELECT 1 FROM abos.journal_lines jl
      JOIN abos.journals j ON j.id = jl.journal_id
      WHERE jl.ledger_account_id = OLD.id AND j.status = 'POSTED'
    ) INTO is_posted;
  ELSE
    RAISE EXCEPTION 'unsupported provenance guard table: %', TG_TABLE_NAME;
  END IF;
  IF is_posted THEN
    RAISE EXCEPTION 'posted financial provenance is immutable';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
CREATE TRIGGER posting_intents_posted_provenance_guard
BEFORE UPDATE OR DELETE ON abos.posting_intents
FOR EACH ROW EXECUTE FUNCTION abos.guard_posted_financial_provenance();
CREATE TRIGGER posting_approvals_posted_provenance_guard
BEFORE UPDATE OR DELETE ON abos.posting_approvals
FOR EACH ROW EXECUTE FUNCTION abos.guard_posted_financial_provenance();
CREATE TRIGGER cash_receipts_posted_provenance_guard
BEFORE UPDATE OR DELETE ON abos.cash_receipts
FOR EACH ROW EXECUTE FUNCTION abos.guard_posted_financial_provenance();
CREATE TRIGGER physical_cash_counts_posted_provenance_guard
BEFORE UPDATE OR DELETE ON abos.physical_cash_counts
FOR EACH ROW EXECUTE FUNCTION abos.guard_posted_financial_provenance();
CREATE TRIGGER cash_accounts_posted_provenance_guard
BEFORE UPDATE OR DELETE ON abos.cash_location_currency_accounts
FOR EACH ROW EXECUTE FUNCTION abos.guard_posted_financial_provenance();
CREATE TRIGGER cash_locations_posted_provenance_guard
BEFORE UPDATE OR DELETE ON abos.cash_locations
FOR EACH ROW EXECUTE FUNCTION abos.guard_posted_financial_provenance();
CREATE TRIGGER capital_installments_posted_provenance_guard
BEFORE UPDATE OR DELETE ON abos.capital_installments
FOR EACH ROW EXECUTE FUNCTION abos.guard_posted_financial_provenance();
CREATE TRIGGER capital_agreements_posted_provenance_guard
BEFORE UPDATE OR DELETE ON abos.capital_agreements
FOR EACH ROW EXECUTE FUNCTION abos.guard_posted_financial_provenance();
CREATE TRIGGER shareholder_profiles_posted_provenance_guard
BEFORE UPDATE OR DELETE ON abos.shareholder_profiles
FOR EACH ROW EXECUTE FUNCTION abos.guard_posted_financial_provenance();
CREATE TRIGGER business_parties_posted_provenance_guard
BEFORE UPDATE OR DELETE ON abos.business_parties
FOR EACH ROW EXECUTE FUNCTION abos.guard_posted_financial_provenance();
CREATE TRIGGER business_party_roles_posted_provenance_guard
BEFORE UPDATE OR DELETE ON abos.business_party_roles
FOR EACH ROW EXECUTE FUNCTION abos.guard_posted_financial_provenance();
CREATE TRIGGER registration_evidence_posted_provenance_guard
BEFORE UPDATE OR DELETE ON abos.registration_evidence
FOR EACH ROW EXECUTE FUNCTION abos.guard_posted_financial_provenance();
CREATE TRIGGER ledger_accounts_posted_provenance_guard
BEFORE UPDATE OR DELETE ON abos.ledger_accounts
FOR EACH ROW EXECUTE FUNCTION abos.guard_posted_financial_provenance();

CREATE OR REPLACE FUNCTION abos.guard_journal_line_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE journal_status text;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT status INTO journal_status FROM abos.journals WHERE id = OLD.journal_id FOR SHARE;
    IF journal_status = 'POSTED' THEN
      RAISE EXCEPTION 'lines of a posted journal are immutable';
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT status INTO journal_status FROM abos.journals WHERE id = NEW.journal_id FOR SHARE;
    IF journal_status = 'POSTED' THEN
      RAISE EXCEPTION 'lines cannot be inserted into or moved to a posted journal';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
CREATE TRIGGER journal_lines_guard
BEFORE INSERT OR UPDATE OR DELETE ON abos.journal_lines
FOR EACH ROW EXECUTE FUNCTION abos.guard_journal_line_mutation();

CREATE OR REPLACE FUNCTION abos.validate_journal_posting()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  period_status text;
  period_start date;
  period_end date;
  entity_policy_status text;
  entity_base_currency text;
  intent_status text;
  intent_kind text;
  intent_source_id uuid;
  intent_creator_id uuid;
  intent_base_amount numeric;
  intent_base_currency text;
  treasury_receipt_status text;
  treasury_account_status text;
  treasury_location_status text;
  treasury_account_id uuid;
  treasury_ledger_account_id uuid;
  treasury_amount numeric;
  treasury_currency text;
  shareholder_party_id uuid;
  agreement_kind text;
  shareholder_role_active boolean;
  treasury_cashier_id uuid;
  treasury_counter_id uuid;
  debit_total numeric;
  credit_total numeric;
  line_count bigint;
  approved_count bigint;
BEGIN
  IF TG_OP = 'INSERT' AND NEW.status = 'POSTED' THEN
    RAISE EXCEPTION 'journals must be assembled as draft and posted by controlled status transition';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status = 'POSTED' THEN
      RAISE EXCEPTION 'posted journal is immutable';
    END IF;
  END IF;

  IF NEW.status = 'POSTED' THEN
    PERFORM 1 FROM abos.posting_intents
     WHERE id = NEW.posting_intent_id AND legal_entity_id = NEW.legal_entity_id
     FOR SHARE;
    PERFORM 1 FROM abos.posting_approvals
     WHERE posting_intent_id = NEW.posting_intent_id AND legal_entity_id = NEW.legal_entity_id
     FOR SHARE;
    PERFORM 1 FROM abos.cash_receipts cr
      JOIN abos.posting_intents pi ON pi.treasury_cash_receipt_id = cr.id
     WHERE pi.id = NEW.posting_intent_id AND pi.legal_entity_id = NEW.legal_entity_id
     FOR SHARE OF cr;
    PERFORM 1 FROM abos.physical_cash_counts pc
      JOIN abos.cash_receipts cr ON cr.physical_cash_count_id = pc.id
      JOIN abos.posting_intents pi ON pi.treasury_cash_receipt_id = cr.id
     WHERE pi.id = NEW.posting_intent_id AND pi.legal_entity_id = NEW.legal_entity_id
     FOR SHARE OF pc;
    PERFORM 1 FROM abos.cash_location_currency_accounts ca
      JOIN abos.cash_receipts cr ON cr.cash_location_currency_account_id = ca.id
      JOIN abos.posting_intents pi ON pi.treasury_cash_receipt_id = cr.id
     WHERE pi.id = NEW.posting_intent_id AND pi.legal_entity_id = NEW.legal_entity_id
     FOR SHARE OF ca;
    PERFORM 1 FROM abos.cash_locations cl
      JOIN abos.cash_location_currency_accounts ca ON ca.cash_location_id = cl.id
      JOIN abos.cash_receipts cr ON cr.cash_location_currency_account_id = ca.id
      JOIN abos.posting_intents pi ON pi.treasury_cash_receipt_id = cr.id
     WHERE pi.id = NEW.posting_intent_id AND pi.legal_entity_id = NEW.legal_entity_id
     FOR SHARE OF cl;
    PERFORM 1 FROM abos.capital_installments ci
      JOIN abos.cash_receipts cr ON cr.capital_installment_id = ci.id
      JOIN abos.posting_intents pi ON pi.treasury_cash_receipt_id = cr.id
     WHERE pi.id = NEW.posting_intent_id AND pi.legal_entity_id = NEW.legal_entity_id
     FOR SHARE OF ci;
    PERFORM 1 FROM abos.capital_agreements ca
      JOIN abos.capital_installments ci ON ci.capital_agreement_id = ca.id
      JOIN abos.cash_receipts cr ON cr.capital_installment_id = ci.id
      JOIN abos.posting_intents pi ON pi.treasury_cash_receipt_id = cr.id
     WHERE pi.id = NEW.posting_intent_id AND pi.legal_entity_id = NEW.legal_entity_id
     FOR SHARE OF ca;
    PERFORM 1 FROM abos.registration_evidence re
      JOIN abos.capital_installments ci ON ci.capital_agreement_id = re.capital_agreement_id
      JOIN abos.cash_receipts cr ON cr.capital_installment_id = ci.id
      JOIN abos.posting_intents pi ON pi.treasury_cash_receipt_id = cr.id
     WHERE pi.id = NEW.posting_intent_id AND pi.legal_entity_id = NEW.legal_entity_id
     FOR SHARE OF re;
    PERFORM 1 FROM abos.shareholder_profiles sp
      JOIN abos.capital_agreements ca ON ca.shareholder_profile_id = sp.id
      JOIN abos.capital_installments ci ON ci.capital_agreement_id = ca.id
      JOIN abos.cash_receipts cr ON cr.capital_installment_id = ci.id
      JOIN abos.posting_intents pi ON pi.treasury_cash_receipt_id = cr.id
     WHERE pi.id = NEW.posting_intent_id AND pi.legal_entity_id = NEW.legal_entity_id
     FOR SHARE OF sp;
    PERFORM 1 FROM abos.business_parties bp
      JOIN abos.shareholder_profiles sp ON sp.business_party_id = bp.id
      JOIN abos.capital_agreements ca ON ca.shareholder_profile_id = sp.id
      JOIN abos.capital_installments ci ON ci.capital_agreement_id = ca.id
      JOIN abos.cash_receipts cr ON cr.capital_installment_id = ci.id
      JOIN abos.posting_intents pi ON pi.treasury_cash_receipt_id = cr.id
     WHERE pi.id = NEW.posting_intent_id AND pi.legal_entity_id = NEW.legal_entity_id
     FOR SHARE OF bp;
    PERFORM 1 FROM abos.business_party_roles role
      JOIN abos.shareholder_profiles sp ON sp.business_party_id = role.business_party_id
      JOIN abos.capital_agreements ca ON ca.shareholder_profile_id = sp.id
      JOIN abos.capital_installments ci ON ci.capital_agreement_id = ca.id
      JOIN abos.cash_receipts cr ON cr.capital_installment_id = ci.id
      JOIN abos.posting_intents pi ON pi.treasury_cash_receipt_id = cr.id
     WHERE pi.id = NEW.posting_intent_id AND pi.legal_entity_id = NEW.legal_entity_id
     FOR SHARE OF role;
    PERFORM 1 FROM abos.journal_lines WHERE journal_id = NEW.id FOR UPDATE;
    PERFORM 1 FROM abos.subledger_entries se
      JOIN abos.journal_lines jl ON jl.id = se.journal_line_id
     WHERE jl.journal_id = NEW.id FOR UPDATE OF se;
    PERFORM 1 FROM abos.ledger_accounts la
      JOIN abos.journal_lines jl ON jl.ledger_account_id = la.id
     WHERE jl.journal_id = NEW.id FOR SHARE OF la;
    SELECT status, starts_on, ends_on
      INTO period_status, period_start, period_end
      FROM abos.accounting_periods
     WHERE id = NEW.accounting_period_id
       AND legal_entity_id = NEW.legal_entity_id;

    IF period_status IS DISTINCT FROM 'OPEN' THEN
      RAISE EXCEPTION 'journal posting requires an open accounting period';
    END IF;
    IF NEW.accounting_effective_date < period_start
       OR NEW.accounting_effective_date > period_end THEN
      RAISE EXCEPTION 'journal effective date is outside its accounting period';
    END IF;

    SELECT currency_policy_status, base_currency_code
      INTO entity_policy_status, entity_base_currency
      FROM abos.legal_entities
     WHERE id = NEW.legal_entity_id;

    IF entity_policy_status IS DISTINCT FROM 'APPROVED'
       OR entity_base_currency IS NULL
       OR entity_base_currency <> NEW.base_currency_code THEN
      RAISE EXCEPTION 'journal posting requires the approved legal-entity base currency';
    END IF;

    SELECT pi.status, pi.intent_kind, pi.source_id, pi.created_by_user_account_id,
           pi.base_amount, pi.base_currency_code
      INTO intent_status, intent_kind, intent_source_id, intent_creator_id, intent_base_amount, intent_base_currency
      FROM abos.posting_intents pi
     WHERE pi.id = NEW.posting_intent_id
       AND pi.legal_entity_id = NEW.legal_entity_id;

    IF intent_status IS DISTINCT FROM 'APPROVED'
       OR intent_base_amount IS NULL
       OR intent_base_currency IS DISTINCT FROM NEW.base_currency_code THEN
      RAISE EXCEPTION 'journal posting requires an approved valued posting intent';
    END IF;

    IF intent_kind IN ('SHAREHOLDER_CAPITAL_RECEIPT', 'SHAREHOLDER_LOAN_RECEIPT') THEN
      SELECT cr.status, ca.activation_status, cl.status, cr.cash_location_currency_account_id, ca.ledger_account_id,
             cr.amount, cr.currency_code, sp.business_party_id, cag.agreement_kind,
             EXISTS (SELECT 1 FROM abos.business_party_roles role
                      WHERE role.business_party_id = sp.business_party_id
                        AND role.role_code = 'SHAREHOLDER'
                        AND role.effective_from <= NEW.accounting_effective_date
                        AND (role.effective_to IS NULL OR role.effective_to >= NEW.accounting_effective_date)),
             cr.received_by_user_account_id, pc.counted_by_user_account_id
        INTO treasury_receipt_status, treasury_account_status, treasury_location_status, treasury_account_id,
             treasury_ledger_account_id, treasury_amount, treasury_currency, shareholder_party_id, agreement_kind,
             shareholder_role_active, treasury_cashier_id, treasury_counter_id
        FROM abos.posting_intents pi
        JOIN abos.cash_receipts cr
          ON cr.id = pi.treasury_cash_receipt_id
         AND cr.legal_entity_id = pi.legal_entity_id
        JOIN abos.cash_location_currency_accounts ca
          ON ca.id = cr.cash_location_currency_account_id
         AND ca.legal_entity_id = cr.legal_entity_id
        JOIN abos.cash_locations cl
          ON cl.id = ca.cash_location_id
         AND cl.legal_entity_id = ca.legal_entity_id
        LEFT JOIN abos.capital_installments ci
          ON ci.id = cr.capital_installment_id
         AND ci.legal_entity_id = cr.legal_entity_id
        LEFT JOIN abos.physical_cash_counts pc
          ON pc.id = cr.physical_cash_count_id
         AND pc.legal_entity_id = cr.legal_entity_id
        LEFT JOIN abos.capital_agreements cag
          ON cag.id = ci.capital_agreement_id
         AND cag.legal_entity_id = ci.legal_entity_id
        LEFT JOIN abos.shareholder_profiles sp
          ON sp.id = cag.shareholder_profile_id
         AND sp.legal_entity_id = cag.legal_entity_id
       WHERE pi.id = NEW.posting_intent_id
         AND pi.legal_entity_id = NEW.legal_entity_id;

      IF treasury_receipt_status IS DISTINCT FROM 'VERIFIED'
         OR treasury_account_status IS DISTINCT FROM 'ACTIVE'
         OR treasury_location_status IS DISTINCT FROM 'ACTIVE' THEN
        RAISE EXCEPTION 'capital or loan posting requires a verified receipt into an active cash currency account';
      END IF;
      IF agreement_kind IS NULL
         OR (agreement_kind = 'CAPITAL_CONTRIBUTION' AND intent_kind <> 'SHAREHOLDER_CAPITAL_RECEIPT')
         OR (agreement_kind = 'SHAREHOLDER_LOAN' AND intent_kind <> 'SHAREHOLDER_LOAN_RECEIPT') THEN
        RAISE EXCEPTION 'posting intent kind must match the capital agreement classification';
      END IF;
      IF shareholder_role_active IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'capital or loan posting requires an effective SHAREHOLDER business-party role';
      END IF;
      IF treasury_amount IS DISTINCT FROM intent_base_amount
         OR treasury_currency IS DISTINCT FROM NEW.base_currency_code THEN
        RAISE EXCEPTION 'verified Treasury receipt amount/currency must match the same-currency E0 posting intent';
      END IF;
      IF intent_kind = 'SHAREHOLDER_CAPITAL_RECEIPT' AND NOT EXISTS (
        SELECT 1 FROM abos.posting_intents pi
        JOIN abos.cash_receipts cr ON cr.id = pi.treasury_cash_receipt_id
        JOIN abos.capital_installments ci ON ci.id = cr.capital_installment_id
        JOIN abos.registration_evidence re ON re.capital_agreement_id = ci.capital_agreement_id
        JOIN abos.evidence_references er ON er.id = re.evidence_reference_id
        WHERE pi.id = NEW.posting_intent_id
          AND re.status = 'VERIFIED'
          AND er.evidence_kind = 'FORMAL_REGISTRATION'
      ) THEN
        RAISE EXCEPTION 'capital posting requires verified structured formal-registration evidence';
      END IF;
    END IF;

    IF NEW.posted_by_user_account_id IS NULL OR NEW.posted_at IS NULL THEN
      RAISE EXCEPTION 'posted journal requires posting actor and timestamp';
    END IF;
    IF NEW.posted_by_user_account_id = intent_creator_id
       OR NEW.posted_by_user_account_id = treasury_cashier_id
       OR NEW.posted_by_user_account_id = treasury_counter_id THEN
      RAISE EXCEPTION 'posting actor must remain separate from intent creator, cashier and cash counter';
    END IF;

    SELECT count(*), coalesce(sum(base_debit), 0), coalesce(sum(base_credit), 0)
      INTO line_count, debit_total, credit_total
      FROM abos.journal_lines
     WHERE journal_id = NEW.id;

    IF line_count < 2 OR debit_total <> credit_total OR debit_total <> intent_base_amount THEN
      RAISE EXCEPTION 'posted journal requires at least two lines balanced to the posting-intent base amount';
    END IF;

    IF EXISTS (
      SELECT 1
        FROM abos.journal_lines
       WHERE journal_id = NEW.id
         AND (legal_entity_id <> NEW.legal_entity_id
              OR base_currency_code <> NEW.base_currency_code)
    ) THEN
      RAISE EXCEPTION 'journal line entity and base currency must match the journal';
    END IF;

    IF EXISTS (
      SELECT 1
        FROM abos.journal_lines jl
        JOIN abos.ledger_accounts la ON la.id = jl.ledger_account_id
       WHERE jl.journal_id = NEW.id
         AND (la.status <> 'ACTIVE'
              OR NOT la.posting_allowed
              OR (la.requires_project AND jl.project_id IS NULL)
              OR (la.requires_department AND jl.department_id IS NULL)
              OR (la.requires_cost_center AND jl.cost_center_id IS NULL))
    ) THEN
      RAISE EXCEPTION 'journal lines violate ledger account activation or dimension requirements';
    END IF;

    IF intent_kind <> 'REVERSAL' AND (
      NOT EXISTS (
        SELECT 1 FROM abos.journal_lines jl
        JOIN abos.ledger_accounts la ON la.id = jl.ledger_account_id
        WHERE jl.journal_id = NEW.id
          AND jl.ledger_account_id = treasury_ledger_account_id
          AND la.control_account_type = 'CASH'
          AND jl.base_debit = intent_base_amount
          AND jl.base_credit = 0
      )
      OR NOT EXISTS (
        SELECT 1 FROM abos.journal_lines jl
        JOIN abos.ledger_accounts la ON la.id = jl.ledger_account_id
        WHERE jl.journal_id = NEW.id
          AND jl.business_party_id = shareholder_party_id
          AND la.control_account_type = CASE intent_kind
            WHEN 'SHAREHOLDER_CAPITAL_RECEIPT' THEN 'SHAREHOLDER_CAPITAL'
            WHEN 'SHAREHOLDER_LOAN_RECEIPT' THEN 'SHAREHOLDER_LOAN'
          END
          AND jl.base_debit = 0
          AND jl.base_credit = intent_base_amount
      )
    ) THEN
      RAISE EXCEPTION 'receipt journal requires the mapped safe CASH debit and matching shareholder control credit';
    END IF;

    IF EXISTS (
      SELECT 1
        FROM abos.journal_lines jl
        JOIN abos.ledger_accounts la ON la.id = jl.ledger_account_id
       WHERE jl.journal_id = NEW.id
         AND la.control_account_type IN ('CASH', 'SHAREHOLDER_CAPITAL', 'SHAREHOLDER_LOAN')
          AND NOT EXISTS (
            SELECT 1 FROM abos.subledger_entries se
             WHERE se.journal_line_id = jl.id
               AND se.legal_entity_id = jl.legal_entity_id
               AND se.subledger_type = CASE la.control_account_type
                 WHEN 'CASH' THEN 'CASH_LOCATION'
                 WHEN 'SHAREHOLDER_CAPITAL' THEN 'SHAREHOLDER_CAPITAL'
                 WHEN 'SHAREHOLDER_LOAN' THEN 'SHAREHOLDER_LOAN'
               END
               AND (
                 (intent_kind = 'REVERSAL' AND EXISTS (
                   SELECT 1
                     FROM abos.journals original_journal
                     JOIN abos.journal_lines original_line
                       ON original_line.journal_id = original_journal.id
                      AND original_line.line_number = jl.line_number
                     JOIN abos.subledger_entries original_entry
                       ON original_entry.journal_line_id = original_line.id
                      AND original_entry.subledger_type = se.subledger_type
                    WHERE original_journal.id = intent_source_id
                      AND original_journal.status = 'POSTED'
                      AND original_journal.legal_entity_id = NEW.legal_entity_id
                      AND original_journal.base_currency_code = NEW.base_currency_code
                      AND original_line.ledger_account_id = jl.ledger_account_id
                      AND original_entry.business_party_id IS NOT DISTINCT FROM se.business_party_id
                      AND original_entry.cash_location_currency_account_id IS NOT DISTINCT FROM se.cash_location_currency_account_id
                      AND se.original_amount = -original_entry.original_amount
                      AND se.original_currency_code = original_entry.original_currency_code
                      AND se.base_amount = -original_entry.base_amount
                      AND se.base_currency_code = original_entry.base_currency_code
                 ))
                 OR
                 (intent_kind <> 'REVERSAL'
                  AND (la.control_account_type <> 'CASH'
                       OR (se.cash_location_currency_account_id = treasury_account_id
                           AND jl.ledger_account_id = treasury_ledger_account_id))
                  AND (la.control_account_type = 'CASH'
                       OR se.business_party_id = shareholder_party_id)
                  AND se.original_currency_code = jl.original_currency_code
                  AND abs(se.original_amount) = jl.original_amount
                  AND se.base_currency_code = jl.base_currency_code
                  AND se.base_amount = CASE
                    WHEN jl.base_debit > 0 THEN jl.base_debit
                    ELSE -jl.base_credit
                  END
                  AND se.source_type = jl.source_type
                  AND se.source_id = jl.source_id)
               )
          )
    ) THEN
      RAISE EXCEPTION 'controlled cash/shareholder lines require matching subledger entries';
    END IF;

    SELECT count(*) INTO approved_count
      FROM abos.posting_approvals
     WHERE posting_intent_id = NEW.posting_intent_id
       AND legal_entity_id = NEW.legal_entity_id
       AND decision = 'APPROVED'
       AND approver_user_account_id = NEW.posted_by_user_account_id;

    IF approved_count = 0 THEN
      RAISE EXCEPTION 'posting actor must be the independent approver of the posting intent';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER journals_posting_guard
BEFORE INSERT OR UPDATE ON abos.journals
FOR EACH ROW EXECUTE FUNCTION abos.validate_journal_posting();

CREATE OR REPLACE FUNCTION abos.guard_subledger_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  journal_status text;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT j.status INTO journal_status
      FROM abos.journal_lines jl
      JOIN abos.journals j ON j.id = jl.journal_id
     WHERE jl.id = OLD.journal_line_id
     FOR SHARE OF j;
    IF journal_status = 'POSTED' THEN
      RAISE EXCEPTION 'subledger entries of a posted journal are immutable';
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT j.status INTO journal_status
      FROM abos.journal_lines jl
      JOIN abos.journals j ON j.id = jl.journal_id
     WHERE jl.id = NEW.journal_line_id
     FOR SHARE OF j;
    IF journal_status = 'POSTED' THEN
      RAISE EXCEPTION 'subledger entries cannot be inserted into or moved to a posted journal';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
CREATE TRIGGER subledger_entries_guard
BEFORE INSERT OR UPDATE OR DELETE ON abos.subledger_entries
FOR EACH ROW EXECUTE FUNCTION abos.guard_subledger_mutation();

CREATE OR REPLACE FUNCTION abos.validate_journal_reversal_link()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  original_status text;
  reversal_status text;
  original_entity uuid;
  reversal_entity uuid;
  original_currency text;
  reversal_currency text;
  reversal_kind text;
  reversal_source_id uuid;
  reversal_evidence_kind text;
  reversal_evidence_entity uuid;
  line_mismatch boolean;
  subledger_mismatch boolean;
  original_subledger_count bigint;
  reversal_subledger_count bigint;
BEGIN
  SELECT j.status, j.legal_entity_id, j.base_currency_code
    INTO original_status, original_entity, original_currency
    FROM abos.journals j WHERE j.id = NEW.original_journal_id;
  SELECT j.status, j.legal_entity_id, j.base_currency_code, pi.intent_kind, pi.source_id
    INTO reversal_status, reversal_entity, reversal_currency, reversal_kind, reversal_source_id
    FROM abos.journals j
    JOIN abos.posting_intents pi ON pi.id = j.posting_intent_id
   WHERE j.id = NEW.reversal_journal_id;

  IF original_status IS DISTINCT FROM 'POSTED'
     OR reversal_status IS DISTINCT FROM 'POSTED'
     OR original_entity IS DISTINCT FROM reversal_entity
     OR original_currency IS DISTINCT FROM reversal_currency
     OR reversal_kind IS DISTINCT FROM 'REVERSAL'
     OR reversal_source_id IS DISTINCT FROM NEW.original_journal_id THEN
    RAISE EXCEPTION 'reversal link requires two posted journals in the same entity/base currency and a REVERSAL intent';
  END IF;
  SELECT evidence_kind, legal_entity_id
    INTO reversal_evidence_kind, reversal_evidence_entity
    FROM abos.evidence_references WHERE id = NEW.evidence_reference_id;
  IF reversal_evidence_kind IS DISTINCT FROM 'REVERSAL_REASON'
     OR reversal_evidence_entity IS DISTINCT FROM original_entity THEN
    RAISE EXCEPTION 'reversal link requires REVERSAL_REASON evidence in the journal legal entity';
  END IF;

  WITH original_lines AS (
    SELECT * FROM abos.journal_lines WHERE journal_id = NEW.original_journal_id
  ), reversal_lines AS (
    SELECT * FROM abos.journal_lines WHERE journal_id = NEW.reversal_journal_id
  )
  SELECT EXISTS (
    SELECT 1
      FROM original_lines ol
      FULL OUTER JOIN reversal_lines rl USING (line_number)
     WHERE ol.id IS NULL OR rl.id IS NULL
        OR ol.ledger_account_id IS DISTINCT FROM rl.ledger_account_id
        OR ol.business_party_id IS DISTINCT FROM rl.business_party_id
        OR ol.project_id IS DISTINCT FROM rl.project_id
        OR ol.department_id IS DISTINCT FROM rl.department_id
        OR ol.cost_center_id IS DISTINCT FROM rl.cost_center_id
        OR ol.original_amount IS DISTINCT FROM rl.original_amount
        OR ol.original_currency_code IS DISTINCT FROM rl.original_currency_code
        OR ol.base_debit IS DISTINCT FROM rl.base_credit
        OR ol.base_credit IS DISTINCT FROM rl.base_debit
        OR ol.base_currency_code IS DISTINCT FROM rl.base_currency_code
  ) INTO line_mismatch;
  IF line_mismatch THEN
    RAISE EXCEPTION 'reversal journal must exactly invert every original journal line';
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM abos.journal_lines original_line
      JOIN abos.journal_lines reversal_line
        ON reversal_line.journal_id = NEW.reversal_journal_id
       AND reversal_line.line_number = original_line.line_number
      JOIN abos.subledger_entries original_entry
        ON original_entry.journal_line_id = original_line.id
      LEFT JOIN abos.subledger_entries reversal_entry
        ON reversal_entry.journal_line_id = reversal_line.id
       AND reversal_entry.subledger_type = original_entry.subledger_type
     WHERE original_line.journal_id = NEW.original_journal_id
       AND (reversal_entry.id IS NULL
         OR reversal_entry.business_party_id IS DISTINCT FROM original_entry.business_party_id
         OR reversal_entry.cash_location_currency_account_id IS DISTINCT FROM original_entry.cash_location_currency_account_id
         OR reversal_entry.original_amount IS DISTINCT FROM -original_entry.original_amount
         OR reversal_entry.original_currency_code IS DISTINCT FROM original_entry.original_currency_code
         OR reversal_entry.base_amount IS DISTINCT FROM -original_entry.base_amount
         OR reversal_entry.base_currency_code IS DISTINCT FROM original_entry.base_currency_code)
  ) INTO subledger_mismatch;
  SELECT count(*) INTO original_subledger_count
    FROM abos.subledger_entries se
    JOIN abos.journal_lines jl ON jl.id = se.journal_line_id
   WHERE jl.journal_id = NEW.original_journal_id;
  SELECT count(*) INTO reversal_subledger_count
    FROM abos.subledger_entries se
    JOIN abos.journal_lines jl ON jl.id = se.journal_line_id
   WHERE jl.journal_id = NEW.reversal_journal_id;
  IF subledger_mismatch OR original_subledger_count <> reversal_subledger_count THEN
    RAISE EXCEPTION 'reversal journal must exactly invert every original subledger entry';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER journal_reversal_links_guard
BEFORE INSERT ON abos.journal_reversal_links
FOR EACH ROW EXECUTE FUNCTION abos.validate_journal_reversal_link();
CREATE OR REPLACE FUNCTION abos.prevent_reversal_link_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'journal reversal links are immutable';
END;
$$;
CREATE TRIGGER journal_reversal_links_no_update_or_delete
BEFORE UPDATE OR DELETE ON abos.journal_reversal_links
FOR EACH ROW EXECUTE FUNCTION abos.prevent_reversal_link_mutation();
CREATE OR REPLACE FUNCTION abos.require_posted_reversal_link()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE intent_kind text;
BEGIN
  SELECT pi.intent_kind INTO intent_kind
    FROM abos.posting_intents pi WHERE pi.id = NEW.posting_intent_id;
  IF intent_kind = 'REVERSAL' AND NOT EXISTS (
    SELECT 1 FROM abos.journal_reversal_links link
     WHERE link.reversal_journal_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'posted reversal journal requires an immutable reversal link in the same transaction';
  END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER posted_reversal_requires_link
AFTER INSERT OR UPDATE ON abos.journals
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (NEW.status = 'POSTED')
EXECUTE FUNCTION abos.require_posted_reversal_link();
CREATE OR REPLACE FUNCTION abos.prevent_posted_journal_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'POSTED' THEN
    RAISE EXCEPTION 'posted journal cannot be deleted';
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER journals_delete_guard
BEFORE DELETE ON abos.journals
FOR EACH ROW EXECUTE FUNCTION abos.prevent_posted_journal_delete();
