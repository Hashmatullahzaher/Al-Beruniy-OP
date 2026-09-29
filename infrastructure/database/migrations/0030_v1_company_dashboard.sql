-- V1 company dashboard: an explicit permission and a real, aggregate-only read model.
--
-- The company-wide dashboard at "/" was open to anyone and showed hard-coded presentation figures.
-- From this migration it needs company.dashboard.read (category COMPANY), granted like any other
-- permission through Roles & Permissions. It is not granted to any existing role, including Super
-- Administrator; permissions stay explicit.
--
-- company_dashboard_summary returns only aggregate counts from sources that exist in V1. Today that
-- is the Projects register. Sales, inventory, receivables, construction, procurement, HR and
-- profit/loss have no V1 source yet, so the dashboard reports them as not connected instead of
-- showing any figure. The function reads no Finance, Treasury or identity records, so holding the
-- dashboard permission reveals nothing those modules protect.

ALTER TABLE abos.permission_catalogue
  DROP CONSTRAINT permission_catalogue_category_check,
  ADD CONSTRAINT permission_catalogue_category_check CHECK (category IN (
    'ADMINISTRATION', 'SHAREHOLDER', 'TREASURY', 'FINANCE', 'COMPANY'));

INSERT INTO abos.permission_catalogue
  (permission_code, catalogue_version, category, availability,
   independence_enforced, administrative, sort_order)
VALUES
  ('company.dashboard.read', 7, 'COMPANY', 'ACTIVE', false, false, 500);

-- ---------------------------------------------------------------------------
-- Least-privilege owner: reads project counts and the company name, nothing else.
-- ---------------------------------------------------------------------------
DO $role$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'abos_v1_company_dashboard_owner'
  ) THEN
    CREATE ROLE abos_v1_company_dashboard_owner
      NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
  ELSE
    ALTER ROLE abos_v1_company_dashboard_owner
      NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
  END IF;
END
$role$;

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA abos FROM abos_v1_company_dashboard_owner;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA abos FROM abos_v1_company_dashboard_owner;
REVOKE ALL PRIVILEGES ON SCHEMA abos FROM abos_v1_company_dashboard_owner;
REVOKE abos_v1_company_dashboard_owner FROM abos_v1_identity_runtime;
REVOKE abos_v1_company_dashboard_owner FROM abos_e1_runtime;
REVOKE abos_v1_company_dashboard_owner FROM abos_e1_treasury_runtime;

DO $guard$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members membership
      JOIN pg_catalog.pg_roles granted_role ON granted_role.oid = membership.roleid
      JOIN pg_catalog.pg_roles member_role ON member_role.oid = membership.member
     WHERE granted_role.rolname = 'abos_v1_company_dashboard_owner'
        OR member_role.rolname = 'abos_v1_company_dashboard_owner'
  ) THEN
    RAISE EXCEPTION 'abos_v1_company_dashboard_owner must not have role memberships';
  END IF;
END
$guard$;

GRANT USAGE ON SCHEMA abos TO abos_v1_company_dashboard_owner;
GRANT SELECT (id, legal_entity_id, active) ON abos.projects TO abos_v1_company_dashboard_owner;
GRANT SELECT (id, name) ON abos.legal_entities TO abos_v1_company_dashboard_owner;
GRANT EXECUTE ON FUNCTION abos.identity_actor_context(text, text, text)
  TO abos_v1_company_dashboard_owner;

CREATE FUNCTION abos.company_dashboard_summary(
  p_identity_proof text,
  p_runtime_token_sha256 text,
  p_token_sha256 text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $summary$
DECLARE
  v_actor_context jsonb;
  v_entity_id uuid;
BEGIN
  -- Identity, company and permission come only from the server proof and the live session.
  v_actor_context := abos.identity_actor_context(
    p_identity_proof, p_runtime_token_sha256, p_token_sha256);
  IF v_actor_context IS NULL
     OR COALESCE((v_actor_context ->> 'live')::boolean, false) IS NOT TRUE
     OR v_actor_context ->> 'status' IS DISTINCT FROM 'ACTIVE'
     OR COALESCE((v_actor_context ->> 'mustChangePassword')::boolean, false) IS TRUE THEN
    RAISE EXCEPTION 'sign in with an active account to continue'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT COALESCE(v_actor_context -> 'permissions', '[]'::jsonb) ? 'company.dashboard.read' THEN
    RAISE EXCEPTION 'current authority is missing company.dashboard.read'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  v_entity_id := (v_actor_context ->> 'legalEntityId')::uuid;

  RETURN pg_catalog.jsonb_build_object(
    'legalEntityName', (SELECT entity.name FROM abos.legal_entities entity WHERE entity.id = v_entity_id),
    'projects', (SELECT pg_catalog.jsonb_build_object(
        'active', count(*) FILTER (WHERE project.active),
        'total', count(*))
      FROM abos.projects project WHERE project.legal_entity_id = v_entity_id));
END
$summary$;

ALTER FUNCTION abos.company_dashboard_summary(text, text, text)
  OWNER TO abos_v1_company_dashboard_owner;
REVOKE ALL ON FUNCTION abos.company_dashboard_summary(text, text, text) FROM PUBLIC;
-- The web server calls it through the restricted Finance runtime login, which holds no table access.
GRANT EXECUTE ON FUNCTION abos.company_dashboard_summary(text, text, text) TO abos_e1_runtime;
