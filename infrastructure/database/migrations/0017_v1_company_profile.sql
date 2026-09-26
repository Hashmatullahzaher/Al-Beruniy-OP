-- V1 company configuration (backlog #8), lead package.
--
-- Owner decisions: USD base currency, AFN fully supported, per-company settings. Still pending from
-- the owner and never invented here: legal name, registration number and go-live date. They are
-- stored only when a Super Administrator enters them; until then the application shows them as
-- "Pending". Base currency and enabled currencies are read from the existing records; the financial
-- calendar stays in 0012.
--
-- The profile is administration data, handled by the identity runtime (table grants, no SECURITY
-- DEFINER), like users and roles in 0010.

INSERT INTO abos.permission_catalogue
  (permission_code, catalogue_version, category, availability, independence_enforced, administrative, sort_order)
VALUES ('admin.company.manage', 3, 'ADMINISTRATION', 'ACTIVE', false, true, 260);

CREATE TABLE abos.legal_entity_profiles (
  legal_entity_id uuid PRIMARY KEY REFERENCES abos.legal_entities(id),
  legal_name text CHECK (legal_name IS NULL OR length(btrim(legal_name)) BETWEEN 2 AND 200),
  registration_number text CHECK (registration_number IS NULL OR length(btrim(registration_number)) BETWEEN 1 AND 100),
  go_live_date date,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by_user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Company-profile changes are access-administration audit, so the identity runtime may write and
-- read them (0010 confined it to user and role records).
CREATE OR REPLACE FUNCTION abos.guard_identity_audit_insert()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  is_identity_runtime boolean;
BEGIN
  SELECT NOT r.rolsuper AND pg_has_role(current_user, 'abos_v1_identity_runtime', 'MEMBER')
    INTO is_identity_runtime FROM pg_roles r WHERE r.rolname = current_user;
  IF coalesce(is_identity_runtime, false) AND NEW.entity_type NOT IN ('USER_ACCOUNT', 'ACCESS_ROLE', 'COMPANY_PROFILE') THEN
    RAISE EXCEPTION 'the identity service may only record access-administration events' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE VIEW abos.access_audit_records WITH (security_barrier) AS
  SELECT id, occurred_at, actor_user_account_id, legal_entity_id, action, entity_type, entity_id, before_state, after_state
    FROM abos.audit_records
   WHERE entity_type IN ('USER_ACCOUNT', 'ACCESS_ROLE', 'COMPANY_PROFILE');

GRANT SELECT, INSERT ON abos.legal_entity_profiles TO abos_v1_identity_runtime;
GRANT UPDATE (legal_name, registration_number, go_live_date, version, updated_by_user_account_id, updated_at)
  ON abos.legal_entity_profiles TO abos_v1_identity_runtime;
-- Read-only context for the company page.
GRANT SELECT ON abos.currencies, abos.financial_calendar_settings TO abos_v1_identity_runtime;
