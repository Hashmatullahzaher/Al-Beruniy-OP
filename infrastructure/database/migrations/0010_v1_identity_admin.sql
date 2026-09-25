-- V1 identity and access administration (client preview).
--
-- Employee accounts stay abos.user_accounts. Custom roles are sets of permissions from a controlled
-- catalogue; the effective permissions of a person are materialised into the existing
-- abos.user_permission_grants table, which the Treasury and Finance boundaries (0008, 0009) already
-- read. Nothing in those boundaries changes: a role can only ever produce grants those functions
-- already check, and every segregation-of-duties rule they enforce still applies per transaction.
--
-- No SECURITY DEFINER function is added. The identity runtime role receives explicit table
-- privileges on identity tables only, and none on Treasury, Finance or ledger tables.

-- ---------------------------------------------------------------------------
-- Controlled permission catalogue (version 1).
-- ---------------------------------------------------------------------------

CREATE TABLE abos.permission_catalogue (
  permission_code text PRIMARY KEY CHECK (permission_code ~ '^[a-z]+(\.[a-z-]+)+$'),
  catalogue_version integer NOT NULL CHECK (catalogue_version > 0),
  category text NOT NULL CHECK (category IN (
    'ADMINISTRATION', 'SHAREHOLDER', 'TREASURY', 'FINANCE')),
  availability text NOT NULL CHECK (availability IN ('ACTIVE', 'UNAVAILABLE_IN_PREVIEW')),
  -- The operation is subject to an independence rule enforced on each transaction.
  independence_enforced boolean NOT NULL,
  administrative boolean NOT NULL,
  sort_order integer NOT NULL UNIQUE
);

INSERT INTO abos.permission_catalogue
  (permission_code, catalogue_version, category, availability, independence_enforced, administrative, sort_order)
VALUES
  ('admin.users.manage',                1, 'ADMINISTRATION', 'ACTIVE',                 false, true,  10),
  ('admin.roles.manage',                1, 'ADMINISTRATION', 'ACTIVE',                 false, true,  20),
  ('shareholder.capital-intent.create', 1, 'SHAREHOLDER',    'UNAVAILABLE_IN_PREVIEW', false, false, 30),
  ('treasury.read',                     1, 'TREASURY',       'ACTIVE',                 false, false, 40),
  ('treasury.cash-location.manage',     1, 'TREASURY',       'ACTIVE',                 false, false, 50),
  ('treasury.cash-account.reconcile',   1, 'TREASURY',       'ACTIVE',                 true,  false, 60),
  ('treasury.cash-account.approve',     1, 'TREASURY',       'ACTIVE',                 true,  false, 70),
  ('treasury.cash-receipt.record',      1, 'TREASURY',       'ACTIVE',                 false, false, 80),
  ('treasury.cash-count.record',        1, 'TREASURY',       'ACTIVE',                 false, false, 90),
  ('treasury.cash-receipt.verify',      1, 'TREASURY',       'ACTIVE',                 true,  false, 100),
  ('treasury.handoff.create',           1, 'TREASURY',       'ACTIVE',                 false, false, 110),
  ('finance.report.operational.read',   1, 'FINANCE',        'ACTIVE',                 false, false, 120),
  ('finance.posting-intent.create',     1, 'FINANCE',        'ACTIVE',                 false, false, 130),
  ('finance.posting-intent.approve',    1, 'FINANCE',        'ACTIVE',                 true,  false, 140),
  ('finance.journal.post',              1, 'FINANCE',        'ACTIVE',                 true,  false, 150),
  ('finance.journal.reverse',           1, 'FINANCE',        'UNAVAILABLE_IN_PREVIEW', true,  false, 160);

-- The catalogue is changed only by a new migration.
CREATE TRIGGER permission_catalogue_no_update_or_delete
BEFORE UPDATE OR DELETE ON abos.permission_catalogue
FOR EACH ROW EXECUTE FUNCTION abos.prevent_audit_mutation();

-- Every stored grant must name a catalogued permission. This replaces the hard-coded list, which
-- 0008 last set and which the catalogue now contains in full.
ALTER TABLE abos.user_permission_grants
  DROP CONSTRAINT user_permission_grants_permission_code_check;
ALTER TABLE abos.user_permission_grants
  ADD CONSTRAINT user_permission_grants_permission_code_fkey
  FOREIGN KEY (permission_code) REFERENCES abos.permission_catalogue(permission_code);

-- ---------------------------------------------------------------------------
-- Employee profile attributes and credentials.
-- ---------------------------------------------------------------------------

ALTER TABLE abos.user_accounts
  ADD COLUMN contact_email text
    CHECK (contact_email IS NULL OR (length(contact_email) <= 200 AND contact_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  ADD COLUMN contact_phone text
    CHECK (contact_phone IS NULL OR contact_phone ~ '^\+?[0-9][0-9 ()-]{5,22}$'),
  ADD COLUMN job_title text CHECK (job_title IS NULL OR length(job_title) BETWEEN 1 AND 120),
  ADD COLUMN primary_legal_entity_id uuid REFERENCES abos.legal_entities(id),
  ADD COLUMN created_by_user_account_id uuid REFERENCES abos.user_accounts(id),
  ADD COLUMN updated_at timestamptz;

-- Login identifiers are unique regardless of letter case.
CREATE UNIQUE INDEX user_accounts_login_identifier_ci ON abos.user_accounts (lower(login_identifier));

-- Only a password hash is stored: scrypt with its parameters and salt encoded in the value.
CREATE TABLE abos.user_credentials (
  user_account_id uuid PRIMARY KEY REFERENCES abos.user_accounts(id),
  password_hash text NOT NULL CHECK (password_hash ~ '^scrypt\$[0-9]+\$[0-9]+\$[0-9]+\$[A-Za-z0-9_-]{22,}\$[A-Za-z0-9_-]{43,}$'),
  must_change_password boolean NOT NULL,
  password_set_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  password_set_by_user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until timestamptz
);

-- Sign-in attempts for throttling and review. Identifiers are stored only as keyed digests.
CREATE TABLE abos.login_attempts (
  id uuid PRIMARY KEY,
  login_key text NOT NULL CHECK (login_key ~ '^[0-9a-f]{64}$'),
  client_key text NOT NULL CHECK (client_key ~ '^[0-9a-f]{64}$'),
  user_account_id uuid REFERENCES abos.user_accounts(id),
  succeeded boolean NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX login_attempts_login_idx ON abos.login_attempts (login_key, attempted_at);
CREATE INDEX login_attempts_client_idx ON abos.login_attempts (client_key, attempted_at);
CREATE TRIGGER login_attempts_no_update_or_delete
BEFORE UPDATE OR DELETE ON abos.login_attempts
FOR EACH ROW EXECUTE FUNCTION abos.prevent_audit_mutation();

-- ---------------------------------------------------------------------------
-- Custom roles and assignments.
-- ---------------------------------------------------------------------------

CREATE TABLE abos.access_roles (
  id uuid PRIMARY KEY,
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  role_name text NOT NULL CHECK (btrim(role_name) <> '' AND length(role_name) <= 80),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 500),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_by_user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by_user_account_id uuid REFERENCES abos.user_accounts(id),
  updated_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE UNIQUE INDEX access_roles_name_ci ON abos.access_roles (legal_entity_id, lower(btrim(role_name)));

CREATE TABLE abos.access_role_permissions (
  role_id uuid NOT NULL REFERENCES abos.access_roles(id),
  permission_code text NOT NULL REFERENCES abos.permission_catalogue(permission_code),
  added_by_user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  added_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (role_id, permission_code)
);

CREATE OR REPLACE FUNCTION abos.guard_role_permission()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM abos.permission_catalogue c
                  WHERE c.permission_code = NEW.permission_code AND c.availability = 'ACTIVE') THEN
    RAISE EXCEPTION 'permission % is not available and cannot be added to a role', NEW.permission_code
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER access_role_permissions_available_only
BEFORE INSERT OR UPDATE ON abos.access_role_permissions
FOR EACH ROW EXECUTE FUNCTION abos.guard_role_permission();

CREATE TABLE abos.user_role_assignments (
  id uuid PRIMARY KEY,
  user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  role_id uuid NOT NULL REFERENCES abos.access_roles(id),
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  assigned_by_user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  assigned_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_by_user_account_id uuid REFERENCES abos.user_accounts(id),
  revoked_at timestamptz,
  -- Nobody assigns a role to themselves.
  CHECK (assigned_by_user_account_id <> user_account_id),
  CHECK ((revoked_at IS NULL) = (revoked_by_user_account_id IS NULL)),
  CHECK (revoked_at IS NULL OR revoked_at >= assigned_at)
);
CREATE UNIQUE INDEX user_role_assignments_active
  ON abos.user_role_assignments (user_account_id, role_id) WHERE revoked_at IS NULL;

CREATE OR REPLACE FUNCTION abos.guard_role_assignment()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM abos.access_roles r
                  WHERE r.id = NEW.role_id AND r.legal_entity_id = NEW.legal_entity_id) THEN
    RAISE EXCEPTION 'role belongs to a different legal entity' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.user_account_id, NEW.role_id, NEW.legal_entity_id,
      NEW.assigned_by_user_account_id, NEW.assigned_at)
      IS DISTINCT FROM (OLD.user_account_id, OLD.role_id, OLD.legal_entity_id,
      OLD.assigned_by_user_account_id, OLD.assigned_at) THEN
    RAISE EXCEPTION 'a role assignment can only be revoked, not rewritten' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'a revoked role assignment is final' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER user_role_assignments_guard
BEFORE INSERT OR UPDATE ON abos.user_role_assignments
FOR EACH ROW EXECUTE FUNCTION abos.guard_role_assignment();

-- ---------------------------------------------------------------------------
-- Effective permissions: materialise the roles of one person into user_permission_grants.
-- SECURITY INVOKER: it runs with the caller's own table privileges.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION abos.role_derived_permissions(
  p_user_account_id uuid,
  p_legal_entity_id uuid
) RETURNS TABLE (permission_code text)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT DISTINCT rp.permission_code
    FROM abos.user_role_assignments a
    JOIN abos.access_roles r ON r.id = a.role_id AND r.status = 'ACTIVE'
    JOIN abos.access_role_permissions rp ON rp.role_id = r.id
    JOIN abos.permission_catalogue c ON c.permission_code = rp.permission_code AND c.availability = 'ACTIVE'
   WHERE a.user_account_id = p_user_account_id
     AND a.legal_entity_id = p_legal_entity_id
     AND a.revoked_at IS NULL
$$;

CREATE OR REPLACE FUNCTION abos.sync_role_grants(
  p_user_account_id uuid,
  p_legal_entity_id uuid,
  p_actor_user_account_id uuid
) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  UPDATE abos.user_permission_grants g
     SET revoked_at = clock_timestamp()
   WHERE g.user_account_id = p_user_account_id
     AND g.legal_entity_id = p_legal_entity_id
     AND g.revoked_at IS NULL
     AND g.permission_code NOT IN (
       SELECT d.permission_code FROM abos.role_derived_permissions(p_user_account_id, p_legal_entity_id) d);

  -- A grant to oneself violates the existing no-self-grant CHECK and aborts the transaction.
  INSERT INTO abos.user_permission_grants
    (user_account_id, legal_entity_id, permission_code, granted_by_user_account_id)
  SELECT p_user_account_id, p_legal_entity_id, d.permission_code, p_actor_user_account_id
    FROM abos.role_derived_permissions(p_user_account_id, p_legal_entity_id) d
  ON CONFLICT (user_account_id, legal_entity_id, permission_code) DO UPDATE
     SET revoked_at = NULL,
         granted_by_user_account_id = EXCLUDED.granted_by_user_account_id,
         granted_at = clock_timestamp()
   WHERE abos.user_permission_grants.revoked_at IS NOT NULL;
END;
$$;

-- ---------------------------------------------------------------------------
-- The last usable super administrator of a legal entity cannot be removed.
-- A super administrator holds both administration permissions, is ACTIVE and can sign in.
-- Checked at commit, so a transaction may hand over administration before removing itself.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION abos.assert_super_admin_remains()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM (SELECT DISTINCT legal_entity_id FROM abos.user_permission_grants
             WHERE permission_code = 'admin.users.manage') entity
     WHERE NOT EXISTS (
       SELECT 1
         FROM abos.user_permission_grants users_grant
         JOIN abos.user_permission_grants roles_grant
           ON roles_grant.user_account_id = users_grant.user_account_id
          AND roles_grant.legal_entity_id = users_grant.legal_entity_id
          AND roles_grant.permission_code = 'admin.roles.manage'
          AND roles_grant.revoked_at IS NULL
         JOIN abos.user_accounts account ON account.id = users_grant.user_account_id AND account.status = 'ACTIVE'
         JOIN abos.user_credentials credential ON credential.user_account_id = account.id
        WHERE users_grant.legal_entity_id = entity.legal_entity_id
          AND users_grant.permission_code = 'admin.users.manage'
          AND users_grant.revoked_at IS NULL)
  ) THEN
    RAISE EXCEPTION 'the last active super administrator cannot be removed or suspended'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER super_admin_remains_after_grant_change
AFTER UPDATE OR DELETE ON abos.user_permission_grants
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION abos.assert_super_admin_remains();

CREATE CONSTRAINT TRIGGER super_admin_remains_after_account_change
AFTER UPDATE OF status ON abos.user_accounts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION abos.assert_super_admin_remains();

CREATE CONSTRAINT TRIGGER super_admin_remains_after_credential_change
AFTER DELETE ON abos.user_credentials
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION abos.assert_super_admin_remains();

-- ---------------------------------------------------------------------------
-- Identity runtime role: identity tables only. No Treasury, Finance or ledger access.
-- ---------------------------------------------------------------------------

DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'abos_v1_identity_runtime') THEN
    CREATE ROLE abos_v1_identity_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
  ELSE
    ALTER ROLE abos_v1_identity_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
  END IF;
END
$role$;

GRANT USAGE ON SCHEMA abos TO abos_v1_identity_runtime;
GRANT SELECT ON abos.permission_catalogue, abos.legal_entities, abos.companies,
  abos.sandbox_authorizations, abos.sandbox_legal_entity_scopes, abos.user_scope_grants
  TO abos_v1_identity_runtime;
GRANT SELECT, INSERT ON abos.user_accounts TO abos_v1_identity_runtime;
GRANT UPDATE (display_name, status, disabled_at, contact_email, contact_phone, job_title, updated_at)
  ON abos.user_accounts TO abos_v1_identity_runtime;
GRANT SELECT, INSERT, UPDATE ON abos.user_credentials TO abos_v1_identity_runtime;
GRANT SELECT, INSERT ON abos.login_attempts TO abos_v1_identity_runtime;
GRANT SELECT, INSERT ON abos.access_roles TO abos_v1_identity_runtime;
GRANT UPDATE (role_name, description, status, updated_by_user_account_id, updated_at, version)
  ON abos.access_roles TO abos_v1_identity_runtime;
GRANT SELECT, INSERT, DELETE ON abos.access_role_permissions TO abos_v1_identity_runtime;
GRANT SELECT, INSERT ON abos.user_role_assignments TO abos_v1_identity_runtime;
GRANT UPDATE (revoked_at, revoked_by_user_account_id) ON abos.user_role_assignments TO abos_v1_identity_runtime;
GRANT SELECT, INSERT ON abos.user_permission_grants TO abos_v1_identity_runtime;
GRANT UPDATE (revoked_at, granted_by_user_account_id, granted_at)
  ON abos.user_permission_grants TO abos_v1_identity_runtime;
GRANT SELECT, INSERT ON abos.sandbox_sessions TO abos_v1_identity_runtime;
GRANT UPDATE (revoked_at) ON abos.sandbox_sessions TO abos_v1_identity_runtime;
GRANT SELECT, INSERT ON abos.audit_records TO abos_v1_identity_runtime;

REVOKE ALL ON FUNCTION abos.role_derived_permissions(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION abos.role_derived_permissions(uuid, uuid) TO abos_v1_identity_runtime;
REVOKE ALL ON FUNCTION abos.sync_role_grants(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION abos.sync_role_grants(uuid, uuid, uuid) TO abos_v1_identity_runtime;
