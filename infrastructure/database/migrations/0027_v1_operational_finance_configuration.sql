-- V1 Operational Finance configuration foundation.
--
-- This migration does not post a journal or create business data. It creates a separate,
-- least-privilege owner for reviewed operational entry points, company-scoped Treasury-account
-- and expense-category configuration, and the one approved accounting-period transition:
-- PENDING -> OPEN. Existing E1 synthetic functions, owners, grants and guards are unchanged.

INSERT INTO abos.permission_catalogue
  (permission_code, catalogue_version, category, availability,
   independence_enforced, administrative, sort_order)
VALUES
  ('treasury.operational-account.manage', 6, 'TREASURY', 'ACTIVE', false, false, 410),
  ('finance.expense-category.manage',      6, 'FINANCE',  'ACTIVE', false, false, 420),
  ('finance.expense.create',              6, 'FINANCE',  'ACTIVE', false, false, 430),
  ('finance.expense.read',                6, 'FINANCE',  'ACTIVE', false, false, 440),
  ('finance.expense.approve',             6, 'FINANCE',  'ACTIVE', true,  false, 450),
  ('finance.period.manage',               6, 'FINANCE',  'ACTIVE', false, false, 460);

CREATE TABLE abos.operational_treasury_accounts (
  id uuid PRIMARY KEY,
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  name_en text NOT NULL CHECK (length(btrim(name_en)) BETWEEN 2 AND 120),
  name_fa text CHECK (name_fa IS NULL OR length(btrim(name_fa)) BETWEEN 1 AND 120),
  account_type text NOT NULL
    CHECK (account_type IN ('SAFE', 'CASH_BOX', 'PETTY_CASH', 'BANK', 'SARAF', 'OTHER')),
  currency_code text NOT NULL REFERENCES abos.currencies(code),
  ledger_account_id uuid NOT NULL,
  saraf_business_party_id uuid,
  external_reference text CHECK (
    external_reference IS NULL OR length(btrim(external_reference)) BETWEEN 1 AND 120),
  status text NOT NULL CHECK (status IN ('ACTIVE', 'INACTIVE')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by_user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_changed_by_user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  last_changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, legal_entity_id),
  UNIQUE (ledger_account_id),
  FOREIGN KEY (ledger_account_id, legal_entity_id, currency_code)
    REFERENCES abos.ledger_accounts(id, legal_entity_id, account_currency_code),
  FOREIGN KEY (saraf_business_party_id, legal_entity_id)
    REFERENCES abos.business_parties(id, legal_entity_id),
  CHECK ((account_type = 'SARAF') = (saraf_business_party_id IS NOT NULL))
);

CREATE UNIQUE INDEX operational_treasury_accounts_external_reference_uq
  ON abos.operational_treasury_accounts (legal_entity_id, lower(btrim(external_reference)))
  WHERE external_reference IS NOT NULL;
CREATE INDEX operational_treasury_accounts_entity_status_idx
  ON abos.operational_treasury_accounts (legal_entity_id, status, account_type);

CREATE TABLE abos.operational_expense_categories (
  id uuid PRIMARY KEY,
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  category_code text NOT NULL
    CHECK (category_code ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,31}$'),
  name_en text NOT NULL CHECK (length(btrim(name_en)) BETWEEN 2 AND 120),
  name_fa text CHECK (name_fa IS NULL OR length(btrim(name_fa)) BETWEEN 1 AND 120),
  ledger_account_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('ACTIVE', 'INACTIVE')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by_user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_changed_by_user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  last_changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, legal_entity_id),
  UNIQUE (legal_entity_id, category_code),
  FOREIGN KEY (ledger_account_id, legal_entity_id)
    REFERENCES abos.ledger_accounts(id, legal_entity_id)
);

CREATE UNIQUE INDEX operational_expense_categories_code_normalized_uq
  ON abos.operational_expense_categories (legal_entity_id, lower(btrim(category_code)));
CREATE INDEX operational_expense_categories_entity_status_idx
  ON abos.operational_expense_categories (legal_entity_id, status);

-- Existing periods start at version 1. Calendar generation keeps working through the default.
ALTER TABLE abos.accounting_periods
  ADD COLUMN operational_version integer NOT NULL DEFAULT 1 CHECK (operational_version > 0);

-- A mapped account is in use. Registering it with the existing append-only reference registry
-- freezes the ledger attributes on which operational posting will later depend.
CREATE TRIGGER operational_treasury_accounts_ledger_reference
AFTER INSERT ON abos.operational_treasury_accounts
FOR EACH ROW EXECUTE FUNCTION abos.ledger_account_mark_referenced('ledger_account_id');
CREATE TRIGGER operational_expense_categories_ledger_reference
AFTER INSERT ON abos.operational_expense_categories
FOR EACH ROW EXECUTE FUNCTION abos.ledger_account_mark_referenced('ledger_account_id');

CREATE FUNCTION abos.guard_operational_treasury_account()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $guard$
DECLARE
  ledger record;
  party_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'operational Treasury accounts are deactivated, never deleted'
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.id, NEW.legal_entity_id, NEW.account_type, NEW.currency_code,
        NEW.ledger_account_id, NEW.saraf_business_party_id,
        NEW.created_by_user_account_id, NEW.created_at)
       IS DISTINCT FROM
       (OLD.id, OLD.legal_entity_id, OLD.account_type, OLD.currency_code,
        OLD.ledger_account_id, OLD.saraf_business_party_id,
        OLD.created_by_user_account_id, OLD.created_at) THEN
      RAISE EXCEPTION 'a Treasury account cannot change its type, currency, ledger mapping, Saraf or creator'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.version <> OLD.version + 1 THEN
      RAISE EXCEPTION 'a Treasury account change must advance exactly one version'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.last_changed_by_user_account_id IS NOT DISTINCT FROM OLD.last_changed_by_user_account_id
       AND NEW.last_changed_at IS NOT DISTINCT FROM OLD.last_changed_at THEN
      RAISE EXCEPTION 'a Treasury account change must record its actor and time'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  SELECT account_type, control_account_type, status, posting_allowed, account_currency_code
    INTO ledger
    FROM abos.ledger_accounts
   WHERE id = NEW.ledger_account_id AND legal_entity_id = NEW.legal_entity_id;
  IF NOT FOUND OR ledger.account_currency_code IS DISTINCT FROM NEW.currency_code THEN
    RAISE EXCEPTION 'the Treasury ledger account must belong to this legal entity and use the same currency'
      USING ERRCODE = 'check_violation';
  END IF;
  IF (TG_OP = 'INSERT' OR NEW.status = 'ACTIVE')
     AND (ledger.status <> 'ACTIVE' OR NOT ledger.posting_allowed) THEN
    RAISE EXCEPTION 'the Treasury ledger account must be ACTIVE and allow posting'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.account_type = 'SARAF' THEN
    IF ledger.control_account_type IS DISTINCT FROM 'SARAF'
       OR ledger.account_type <> 'ASSET' THEN
      RAISE EXCEPTION 'a Saraf Treasury account requires a posting SARAF control account'
        USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'INSERT' OR NEW.status = 'ACTIVE' THEN
      SELECT status INTO party_status
        FROM abos.business_parties
       WHERE id = NEW.saraf_business_party_id AND legal_entity_id = NEW.legal_entity_id;
      IF party_status IS DISTINCT FROM 'ACTIVE' OR NOT EXISTS (
        SELECT 1 FROM abos.business_party_roles role
         WHERE role.business_party_id = NEW.saraf_business_party_id
           AND role.role_code = 'SARAF'
           AND role.effective_from <= CURRENT_DATE
           AND (role.effective_to IS NULL OR role.effective_to >= CURRENT_DATE)
      ) THEN
        RAISE EXCEPTION 'a Saraf Treasury account requires an ACTIVE party with a current SARAF role'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  ELSIF ledger.account_type <> 'ASSET'
        OR ledger.control_account_type IS DISTINCT FROM 'CASH' THEN
    RAISE EXCEPTION 'a cash or bank Treasury account requires an ACTIVE posting CASH asset account'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$guard$;

CREATE TRIGGER operational_treasury_accounts_guard
BEFORE INSERT OR UPDATE OR DELETE ON abos.operational_treasury_accounts
FOR EACH ROW EXECUTE FUNCTION abos.guard_operational_treasury_account();

CREATE FUNCTION abos.guard_operational_expense_category()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $guard$
DECLARE ledger record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'operational expense categories are deactivated, never deleted'
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.id, NEW.legal_entity_id, NEW.category_code, NEW.ledger_account_id,
        NEW.created_by_user_account_id, NEW.created_at)
       IS DISTINCT FROM
       (OLD.id, OLD.legal_entity_id, OLD.category_code, OLD.ledger_account_id,
        OLD.created_by_user_account_id, OLD.created_at) THEN
      RAISE EXCEPTION 'an expense category cannot change its code, ledger mapping or creator'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.version <> OLD.version + 1 THEN
      RAISE EXCEPTION 'an expense-category change must advance exactly one version'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.last_changed_by_user_account_id IS NOT DISTINCT FROM OLD.last_changed_by_user_account_id
       AND NEW.last_changed_at IS NOT DISTINCT FROM OLD.last_changed_at THEN
      RAISE EXCEPTION 'an expense-category change must record its actor and time'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  SELECT account_type, status, posting_allowed
    INTO ledger
    FROM abos.ledger_accounts
   WHERE id = NEW.ledger_account_id AND legal_entity_id = NEW.legal_entity_id;
  IF NOT FOUND OR ledger.account_type <> 'EXPENSE'
     OR ledger.status <> 'ACTIVE' OR NOT ledger.posting_allowed THEN
    RAISE EXCEPTION 'an expense category requires an ACTIVE posting EXPENSE account in this legal entity'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$guard$;

CREATE TRIGGER operational_expense_categories_guard
BEFORE INSERT OR UPDATE OR DELETE ON abos.operational_expense_categories
FOR EACH ROW EXECUTE FUNCTION abos.guard_operational_expense_category();

DO $roles$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'abos_v1_operational_finance_owner'
  ) THEN
    CREATE ROLE abos_v1_operational_finance_owner
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
  ELSE
    ALTER ROLE abos_v1_operational_finance_owner
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
  END IF;
END
$roles$;

-- An existing role with this name is treated as contaminated until its inherited and direct
-- privileges are removed. The role must never own schema objects: ownership would bypass grants.
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA abos FROM abos_v1_operational_finance_owner;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA abos FROM abos_v1_operational_finance_owner;
REVOKE ALL PRIVILEGES ON SCHEMA abos FROM abos_v1_operational_finance_owner;

REVOKE abos_v1_operational_finance_owner FROM abos_v1_identity_runtime;
REVOKE abos_v1_operational_finance_owner FROM abos_e1_runtime;
REVOKE abos_v1_operational_finance_owner FROM abos_e1_treasury_runtime;

DO $membership$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_auth_members membership
      JOIN pg_catalog.pg_roles granted_role ON granted_role.oid = membership.roleid
      JOIN pg_catalog.pg_roles member_role ON member_role.oid = membership.member
     WHERE granted_role.rolname = 'abos_v1_operational_finance_owner'
        OR member_role.rolname = 'abos_v1_operational_finance_owner'
  ) THEN
    RAISE EXCEPTION 'abos_v1_operational_finance_owner must not have role memberships'
      USING ERRCODE = 'invalid_authorization_specification';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class object
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = object.relnamespace
      JOIN pg_catalog.pg_roles owner ON owner.oid = object.relowner
     WHERE namespace.nspname = 'abos'
       AND owner.rolname = 'abos_v1_operational_finance_owner'
  ) OR EXISTS (
    SELECT 1
      FROM pg_catalog.pg_namespace namespace
      JOIN pg_catalog.pg_roles owner ON owner.oid = namespace.nspowner
     WHERE namespace.nspname = 'abos'
       AND owner.rolname = 'abos_v1_operational_finance_owner'
  ) THEN
    RAISE EXCEPTION 'abos_v1_operational_finance_owner must not own database objects'
      USING ERRCODE = 'invalid_authorization_specification';
  END IF;
END
$membership$;

GRANT USAGE ON SCHEMA abos TO abos_v1_operational_finance_owner;

GRANT SELECT ON abos.operational_treasury_accounts, abos.operational_expense_categories
  TO abos_v1_operational_finance_owner;
GRANT INSERT (id, legal_entity_id, name_en, name_fa, account_type, currency_code,
  ledger_account_id, saraf_business_party_id, external_reference, status, version,
  created_by_user_account_id, last_changed_by_user_account_id)
  ON abos.operational_treasury_accounts TO abos_v1_operational_finance_owner;
GRANT UPDATE (name_en, name_fa, external_reference, status, version,
  last_changed_by_user_account_id, last_changed_at)
  ON abos.operational_treasury_accounts TO abos_v1_operational_finance_owner;
GRANT INSERT (id, legal_entity_id, category_code, name_en, name_fa, ledger_account_id,
  status, version, created_by_user_account_id, last_changed_by_user_account_id)
  ON abos.operational_expense_categories TO abos_v1_operational_finance_owner;
GRANT UPDATE (name_en, name_fa, status, version, last_changed_by_user_account_id, last_changed_at)
  ON abos.operational_expense_categories TO abos_v1_operational_finance_owner;

GRANT SELECT (id, name, base_currency_code) ON abos.legal_entities
  TO abos_v1_operational_finance_owner;
GRANT SELECT (id, legal_entity_id, account_code, account_name, account_type,
  control_account_type, posting_allowed, account_currency_code, status)
  ON abos.ledger_accounts TO abos_v1_operational_finance_owner;
GRANT SELECT (id, legal_entity_id, display_name, status) ON abos.business_parties
  TO abos_v1_operational_finance_owner;
GRANT SELECT (business_party_id, role_code, effective_from, effective_to)
  ON abos.business_party_roles TO abos_v1_operational_finance_owner;
GRANT SELECT (id, display_name) ON abos.user_accounts TO abos_v1_operational_finance_owner;
GRANT SELECT (id, legal_entity_id, period_name, starts_on, ends_on, status,
  opened_by_user_account_id, opened_at, fiscal_year_id, period_sequence,
  period_name_fa, closed_by_user_account_id, closed_at, created_at, operational_version)
  ON abos.accounting_periods TO abos_v1_operational_finance_owner;
GRANT UPDATE (status, opened_by_user_account_id, opened_at, operational_version)
  ON abos.accounting_periods TO abos_v1_operational_finance_owner;
GRANT SELECT ON abos.ledger_account_references TO abos_v1_operational_finance_owner;
GRANT INSERT (ledger_account_id, legal_entity_id, source_table)
  ON abos.ledger_account_references TO abos_v1_operational_finance_owner;
GRANT INSERT (id, actor_user_account_id, legal_entity_id, correlation_id, action,
  entity_type, entity_id, before_state, after_state, metadata)
  ON abos.audit_records TO abos_v1_operational_finance_owner;
GRANT EXECUTE ON FUNCTION abos.identity_actor_context(text, text, text)
  TO abos_v1_operational_finance_owner;
GRANT EXECUTE ON FUNCTION abos.ledger_account_mark_referenced()
  TO abos_v1_operational_finance_owner;

CREATE FUNCTION abos.operational_finance_actor(
  p_identity_proof text,
  p_runtime_token_sha256 text,
  p_token_sha256 text,
  p_required_permission text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $actor$
DECLARE actor_context jsonb;
BEGIN
  IF p_required_permission IS NOT NULL AND p_required_permission NOT IN (
    'treasury.operational-account.manage', 'finance.expense-category.manage',
    'finance.expense.create', 'finance.expense.read', 'finance.expense.approve',
    'finance.period.manage'
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

CREATE FUNCTION abos.operational_finance_configuration_workspace(
  p_identity_proof text,
  p_runtime_token_sha256 text,
  p_token_sha256 text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $workspace$
DECLARE
  actor_context jsonb;
  permissions jsonb;
  entity_id uuid;
BEGIN
  actor_context := abos.operational_finance_actor(
    p_identity_proof, p_runtime_token_sha256, p_token_sha256, NULL);
  permissions := COALESCE(actor_context -> 'permissions', '[]'::jsonb);
  IF NOT (permissions ? 'treasury.operational-account.manage'
       OR permissions ? 'finance.expense-category.manage'
       OR permissions ? 'finance.period.manage') THEN
    RAISE EXCEPTION 'current authority has no operational Finance configuration permission'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  entity_id := (actor_context ->> 'legalEntityId')::uuid;

  RETURN pg_catalog.jsonb_build_object(
    'legalEntity', (SELECT pg_catalog.jsonb_build_object(
      'id', entity.id, 'name', entity.name, 'baseCurrency', entity.base_currency_code)
      FROM abos.legal_entities entity WHERE entity.id = entity_id),
    'permissions', pg_catalog.jsonb_build_object(
      'canManageTreasuryAccounts', permissions ? 'treasury.operational-account.manage',
      'canManageExpenseCategories', permissions ? 'finance.expense-category.manage',
      'canManagePeriods', permissions ? 'finance.period.manage'),
    'treasuryAccounts', COALESCE((SELECT pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'id', account.id, 'nameEn', account.name_en, 'nameFa', account.name_fa,
        'accountType', account.account_type, 'currencyCode', account.currency_code,
        'ledgerAccountId', account.ledger_account_id, 'ledgerAccountCode', ledger.account_code,
        'ledgerAccountName', ledger.account_name,
        'sarafBusinessPartyId', account.saraf_business_party_id,
        'sarafName', saraf.display_name, 'externalReference', account.external_reference,
        'status', account.status, 'version', account.version,
        'createdAt', account.created_at, 'createdBy', creator.display_name,
        'updatedAt', account.last_changed_at, 'updatedBy', changer.display_name)
      ORDER BY account.name_en, account.id)
      FROM abos.operational_treasury_accounts account
      JOIN abos.ledger_accounts ledger ON ledger.id = account.ledger_account_id
      JOIN abos.user_accounts creator ON creator.id = account.created_by_user_account_id
      JOIN abos.user_accounts changer ON changer.id = account.last_changed_by_user_account_id
      LEFT JOIN abos.business_parties saraf ON saraf.id = account.saraf_business_party_id
      WHERE account.legal_entity_id = entity_id), '[]'::jsonb),
    'expenseCategories', COALESCE((SELECT pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'id', category.id, 'categoryCode', category.category_code,
        'nameEn', category.name_en, 'nameFa', category.name_fa,
        'ledgerAccountId', category.ledger_account_id,
        'ledgerAccountCode', ledger.account_code, 'ledgerAccountName', ledger.account_name,
        'status', category.status, 'version', category.version,
        'createdAt', category.created_at, 'createdBy', creator.display_name,
        'updatedAt', category.last_changed_at, 'updatedBy', changer.display_name)
      ORDER BY category.category_code, category.id)
      FROM abos.operational_expense_categories category
      JOIN abos.ledger_accounts ledger ON ledger.id = category.ledger_account_id
      JOIN abos.user_accounts creator ON creator.id = category.created_by_user_account_id
      JOIN abos.user_accounts changer ON changer.id = category.last_changed_by_user_account_id
      WHERE category.legal_entity_id = entity_id), '[]'::jsonb),
    'periods', COALESCE((SELECT pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'id', period.id, 'nameEn', period.period_name, 'nameFa', period.period_name_fa,
        'startsOn', period.starts_on, 'endsOn', period.ends_on,
        'status', period.status, 'version', period.operational_version,
        'openedAt', period.opened_at, 'openedBy', opener.display_name)
      ORDER BY period.starts_on, period.id)
      FROM abos.accounting_periods period
      LEFT JOIN abos.user_accounts opener ON opener.id = period.opened_by_user_account_id
      WHERE period.legal_entity_id = entity_id), '[]'::jsonb),
    'options', pg_catalog.jsonb_build_object(
      'treasuryLedgerAccounts', COALESCE((SELECT pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id', ledger.id, 'code', ledger.account_code, 'name', ledger.account_name,
          'currencyCode', ledger.account_currency_code, 'controlType', ledger.control_account_type)
        ORDER BY ledger.account_code, ledger.id)
        FROM abos.ledger_accounts ledger
        WHERE ledger.legal_entity_id = entity_id AND ledger.status = 'ACTIVE'
          AND ledger.account_type = 'ASSET'
          AND ledger.posting_allowed AND ledger.control_account_type IN ('CASH', 'SARAF')),
        '[]'::jsonb),
      'expenseLedgerAccounts', COALESCE((SELECT pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id', ledger.id, 'code', ledger.account_code, 'name', ledger.account_name,
          'currencyCode', ledger.account_currency_code)
        ORDER BY ledger.account_code, ledger.id)
        FROM abos.ledger_accounts ledger
        WHERE ledger.legal_entity_id = entity_id AND ledger.status = 'ACTIVE'
          AND ledger.posting_allowed AND ledger.account_type = 'EXPENSE'), '[]'::jsonb),
      'sarafs', COALESCE((SELECT pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object('id', party.id, 'name', party.display_name)
        ORDER BY party.display_name, party.id)
        FROM abos.business_parties party
        WHERE party.legal_entity_id = entity_id AND party.status = 'ACTIVE'
          AND EXISTS (SELECT 1 FROM abos.business_party_roles role
            WHERE role.business_party_id = party.id AND role.role_code = 'SARAF'
              AND role.effective_from <= CURRENT_DATE
              AND (role.effective_to IS NULL OR role.effective_to >= CURRENT_DATE))),
        '[]'::jsonb)));
END
$workspace$;

CREATE FUNCTION abos.operational_treasury_account_upsert(
  p_identity_proof text,
  p_runtime_token_sha256 text,
  p_token_sha256 text,
  p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $upsert$
DECLARE
  actor_context jsonb;
  actor_id uuid;
  entity_id uuid;
  account_id uuid;
  expected_version integer;
  current_account abos.operational_treasury_accounts%ROWTYPE;
  unknown text;
BEGIN
  actor_context := abos.operational_finance_actor(
    p_identity_proof, p_runtime_token_sha256, p_token_sha256,
    'treasury.operational-account.manage');
  actor_id := (actor_context ->> 'userAccountId')::uuid;
  entity_id := (actor_context ->> 'legalEntityId')::uuid;
  IF p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'Treasury account details must be an object'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT pg_catalog.string_agg(key, ', ') INTO unknown
    FROM pg_catalog.jsonb_object_keys(p_payload) key
   WHERE key NOT IN ('id', 'nameEn', 'nameFa', 'accountType', 'currencyCode',
     'ledgerAccountId', 'sarafBusinessPartyId', 'externalReference', 'status', 'expectedVersion');
  IF unknown IS NOT NULL THEN
    RAISE EXCEPTION 'unknown Treasury account fields: %', unknown
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  expected_version := COALESCE((p_payload ->> 'expectedVersion')::integer, -1);
  IF expected_version < 0 THEN
    RAISE EXCEPTION 'a non-negative expectedVersion is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  account_id := COALESCE(NULLIF(p_payload ->> 'id', '')::uuid, pg_catalog.gen_random_uuid());
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('abos-operational-treasury:' || entity_id::text || ':' || account_id::text, 0));
  SELECT * INTO current_account
    FROM abos.operational_treasury_accounts
   WHERE id = account_id AND legal_entity_id = entity_id
   FOR UPDATE;
  IF COALESCE(current_account.version, 0) <> expected_version THEN
    RAISE EXCEPTION 'the Treasury account changed; reload and try again'
      USING ERRCODE = 'serialization_failure';
  END IF;
  IF NOT FOUND THEN
    IF p_payload ? 'id' THEN
      RAISE EXCEPTION 'the Treasury account does not exist in this legal entity'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    INSERT INTO abos.operational_treasury_accounts
      (id, legal_entity_id, name_en, name_fa, account_type, currency_code,
       ledger_account_id, saraf_business_party_id, external_reference, status, version,
       created_by_user_account_id, last_changed_by_user_account_id)
    VALUES
      (account_id, entity_id, pg_catalog.btrim(p_payload ->> 'nameEn'),
       NULLIF(pg_catalog.btrim(p_payload ->> 'nameFa'), ''), p_payload ->> 'accountType',
       p_payload ->> 'currencyCode', (p_payload ->> 'ledgerAccountId')::uuid,
       NULLIF(p_payload ->> 'sarafBusinessPartyId', '')::uuid,
       NULLIF(pg_catalog.btrim(p_payload ->> 'externalReference'), ''),
       COALESCE(p_payload ->> 'status', 'ACTIVE'), 1, actor_id, actor_id);
  ELSE
    IF p_payload ->> 'accountType' IS DISTINCT FROM current_account.account_type
       OR p_payload ->> 'currencyCode' IS DISTINCT FROM current_account.currency_code
       OR NULLIF(p_payload ->> 'ledgerAccountId', '')::uuid
            IS DISTINCT FROM current_account.ledger_account_id
       OR NULLIF(p_payload ->> 'sarafBusinessPartyId', '')::uuid
            IS DISTINCT FROM current_account.saraf_business_party_id THEN
      RAISE EXCEPTION 'a Treasury account cannot change its type, currency, ledger mapping or Saraf'
        USING ERRCODE = 'check_violation';
    END IF;
    UPDATE abos.operational_treasury_accounts
       SET name_en = pg_catalog.btrim(p_payload ->> 'nameEn'),
           name_fa = NULLIF(pg_catalog.btrim(p_payload ->> 'nameFa'), ''),
           external_reference = NULLIF(pg_catalog.btrim(p_payload ->> 'externalReference'), ''),
           status = p_payload ->> 'status', version = version + 1,
           last_changed_by_user_account_id = actor_id,
           last_changed_at = pg_catalog.clock_timestamp()
     WHERE id = account_id AND legal_entity_id = entity_id;
  END IF;
  INSERT INTO abos.audit_records
    (id, actor_user_account_id, legal_entity_id, correlation_id, action,
     entity_type, entity_id, before_state, after_state, metadata)
  VALUES
    (pg_catalog.gen_random_uuid(), actor_id, entity_id, pg_catalog.gen_random_uuid(),
     CASE WHEN current_account.id IS NULL THEN 'OPERATIONAL_TREASURY_ACCOUNT_CREATED'
          ELSE 'OPERATIONAL_TREASURY_ACCOUNT_UPDATED' END,
     'OPERATIONAL_TREASURY_ACCOUNT', account_id,
     CASE WHEN current_account.id IS NULL THEN NULL ELSE pg_catalog.to_jsonb(current_account) END,
     (SELECT pg_catalog.to_jsonb(account) FROM abos.operational_treasury_accounts account
       WHERE account.id = account_id),
     pg_catalog.jsonb_build_object('source', 'v1-operational-finance-configuration'));
  RETURN abos.operational_finance_configuration_workspace(
    p_identity_proof, p_runtime_token_sha256, p_token_sha256);
END
$upsert$;

CREATE FUNCTION abos.operational_expense_category_upsert(
  p_identity_proof text,
  p_runtime_token_sha256 text,
  p_token_sha256 text,
  p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $upsert$
DECLARE
  actor_context jsonb;
  actor_id uuid;
  entity_id uuid;
  category_id uuid;
  expected_version integer;
  current_category abos.operational_expense_categories%ROWTYPE;
  unknown text;
BEGIN
  actor_context := abos.operational_finance_actor(
    p_identity_proof, p_runtime_token_sha256, p_token_sha256,
    'finance.expense-category.manage');
  actor_id := (actor_context ->> 'userAccountId')::uuid;
  entity_id := (actor_context ->> 'legalEntityId')::uuid;
  IF p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'expense-category details must be an object'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT pg_catalog.string_agg(key, ', ') INTO unknown
    FROM pg_catalog.jsonb_object_keys(p_payload) key
   WHERE key NOT IN ('id', 'categoryCode', 'nameEn', 'nameFa', 'ledgerAccountId',
     'status', 'expectedVersion');
  IF unknown IS NOT NULL THEN
    RAISE EXCEPTION 'unknown expense-category fields: %', unknown
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  expected_version := COALESCE((p_payload ->> 'expectedVersion')::integer, -1);
  IF expected_version < 0 THEN
    RAISE EXCEPTION 'a non-negative expectedVersion is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  category_id := COALESCE(NULLIF(p_payload ->> 'id', '')::uuid, pg_catalog.gen_random_uuid());
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('abos-operational-category:' || entity_id::text || ':' || category_id::text, 0));
  SELECT * INTO current_category
    FROM abos.operational_expense_categories
   WHERE id = category_id AND legal_entity_id = entity_id
   FOR UPDATE;
  IF COALESCE(current_category.version, 0) <> expected_version THEN
    RAISE EXCEPTION 'the expense category changed; reload and try again'
      USING ERRCODE = 'serialization_failure';
  END IF;
  IF NOT FOUND THEN
    IF p_payload ? 'id' THEN
      RAISE EXCEPTION 'the expense category does not exist in this legal entity'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    INSERT INTO abos.operational_expense_categories
      (id, legal_entity_id, category_code, name_en, name_fa, ledger_account_id,
       status, version, created_by_user_account_id, last_changed_by_user_account_id)
    VALUES
      (category_id, entity_id, pg_catalog.btrim(p_payload ->> 'categoryCode'),
       pg_catalog.btrim(p_payload ->> 'nameEn'),
       NULLIF(pg_catalog.btrim(p_payload ->> 'nameFa'), ''),
       (p_payload ->> 'ledgerAccountId')::uuid,
       COALESCE(p_payload ->> 'status', 'ACTIVE'), 1, actor_id, actor_id);
  ELSE
    IF p_payload ->> 'categoryCode' IS DISTINCT FROM current_category.category_code
       OR NULLIF(p_payload ->> 'ledgerAccountId', '')::uuid
            IS DISTINCT FROM current_category.ledger_account_id THEN
      RAISE EXCEPTION 'an expense category cannot change its code or ledger mapping'
        USING ERRCODE = 'check_violation';
    END IF;
    UPDATE abos.operational_expense_categories
       SET name_en = pg_catalog.btrim(p_payload ->> 'nameEn'),
           name_fa = NULLIF(pg_catalog.btrim(p_payload ->> 'nameFa'), ''),
           status = p_payload ->> 'status', version = version + 1,
           last_changed_by_user_account_id = actor_id,
           last_changed_at = pg_catalog.clock_timestamp()
     WHERE id = category_id AND legal_entity_id = entity_id;
  END IF;
  INSERT INTO abos.audit_records
    (id, actor_user_account_id, legal_entity_id, correlation_id, action,
     entity_type, entity_id, before_state, after_state, metadata)
  VALUES
    (pg_catalog.gen_random_uuid(), actor_id, entity_id, pg_catalog.gen_random_uuid(),
     CASE WHEN current_category.id IS NULL THEN 'OPERATIONAL_EXPENSE_CATEGORY_CREATED'
          ELSE 'OPERATIONAL_EXPENSE_CATEGORY_UPDATED' END,
     'OPERATIONAL_EXPENSE_CATEGORY', category_id,
     CASE WHEN current_category.id IS NULL THEN NULL ELSE pg_catalog.to_jsonb(current_category) END,
     (SELECT pg_catalog.to_jsonb(category) FROM abos.operational_expense_categories category
       WHERE category.id = category_id),
     pg_catalog.jsonb_build_object('source', 'v1-operational-finance-configuration'));
  RETURN abos.operational_finance_configuration_workspace(
    p_identity_proof, p_runtime_token_sha256, p_token_sha256);
END
$upsert$;

CREATE FUNCTION abos.finance_open_accounting_period(
  p_identity_proof text,
  p_runtime_token_sha256 text,
  p_token_sha256 text,
  p_period_id uuid,
  p_expected_version integer,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $open$
DECLARE
  actor_context jsonb;
  actor_id uuid;
  entity_id uuid;
  period_row abos.accounting_periods%ROWTYPE;
  reason text := pg_catalog.btrim(p_reason);
BEGIN
  actor_context := abos.operational_finance_actor(
    p_identity_proof, p_runtime_token_sha256, p_token_sha256,
    'finance.period.manage');
  actor_id := (actor_context ->> 'userAccountId')::uuid;
  entity_id := (actor_context ->> 'legalEntityId')::uuid;
  IF p_period_id IS NULL OR p_expected_version IS NULL OR p_expected_version < 1
     OR reason IS NULL OR pg_catalog.length(reason) NOT BETWEEN 5 AND 500 THEN
    RAISE EXCEPTION 'period, current version and a 5-500 character reason are required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO period_row
    FROM abos.accounting_periods
   WHERE id = p_period_id AND legal_entity_id = entity_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the accounting period does not exist in this legal entity'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF period_row.operational_version <> p_expected_version THEN
    RAISE EXCEPTION 'the accounting period changed; reload and try again'
      USING ERRCODE = 'serialization_failure';
  END IF;
  IF period_row.status <> 'PENDING' THEN
    RAISE EXCEPTION 'only a PENDING accounting period can be opened'
      USING ERRCODE = 'check_violation';
  END IF;
  UPDATE abos.accounting_periods
     SET status = 'OPEN', opened_by_user_account_id = actor_id,
         opened_at = pg_catalog.clock_timestamp(),
         operational_version = operational_version + 1
   WHERE id = p_period_id AND legal_entity_id = entity_id;
  INSERT INTO abos.audit_records
    (id, actor_user_account_id, legal_entity_id, correlation_id, action,
     entity_type, entity_id, before_state, after_state, metadata)
  VALUES
    (pg_catalog.gen_random_uuid(), actor_id, entity_id, pg_catalog.gen_random_uuid(),
     'ACCOUNTING_PERIOD_OPENED', 'ACCOUNTING_PERIOD', p_period_id,
     pg_catalog.to_jsonb(period_row),
     (SELECT pg_catalog.to_jsonb(period) FROM abos.accounting_periods period
       WHERE period.id = p_period_id),
     pg_catalog.jsonb_build_object(
       'source', 'v1-operational-finance-configuration', 'reason', reason));
  RETURN abos.operational_finance_configuration_workspace(
    p_identity_proof, p_runtime_token_sha256, p_token_sha256);
END
$open$;

ALTER FUNCTION abos.operational_finance_actor(text, text, text, text)
  OWNER TO abos_v1_operational_finance_owner;
ALTER FUNCTION abos.operational_finance_configuration_workspace(text, text, text)
  OWNER TO abos_v1_operational_finance_owner;
ALTER FUNCTION abos.operational_treasury_account_upsert(text, text, text, jsonb)
  OWNER TO abos_v1_operational_finance_owner;
ALTER FUNCTION abos.operational_expense_category_upsert(text, text, text, jsonb)
  OWNER TO abos_v1_operational_finance_owner;
ALTER FUNCTION abos.finance_open_accounting_period(text, text, text, uuid, integer, text)
  OWNER TO abos_v1_operational_finance_owner;

REVOKE ALL ON FUNCTION abos.operational_finance_actor(text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION abos.operational_finance_configuration_workspace(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION abos.operational_treasury_account_upsert(text, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION abos.operational_expense_category_upsert(text, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION abos.finance_open_accounting_period(text, text, text, uuid, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION abos.guard_operational_treasury_account() FROM PUBLIC;
REVOKE ALL ON FUNCTION abos.guard_operational_expense_category() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION abos.operational_finance_configuration_workspace(text, text, text),
  abos.operational_treasury_account_upsert(text, text, text, jsonb),
  abos.operational_expense_category_upsert(text, text, text, jsonb),
  abos.finance_open_accounting_period(text, text, text, uuid, integer, text)
  TO abos_e1_runtime;

REVOKE ALL ON abos.operational_treasury_accounts, abos.operational_expense_categories
  FROM PUBLIC, abos_v1_identity_runtime, abos_e1_runtime, abos_e1_treasury_runtime;
