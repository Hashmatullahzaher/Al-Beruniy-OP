-- Slice 1 D3: retire the E1 synthetic lane from the product. Additive; zero business-data change.
--
-- What changes
--   1. The runtime groups (abos_e1_runtime, abos_e1_treasury_runtime, abos_v1_identity_runtime) lose
--      EXECUTE on the fourteen reviewed E1 entry points below. The functions, their owners and their
--      bodies are NOT changed, and no table is dropped: every historical row stays readable through
--      the owners' own code and every posted record stays immutable.
--   2. A new NOLOGIN, NOINHERIT holder role, abos_e1_frozen_lane, is the only grantee of EXECUTE on
--      those entry points. Nothing is a member of it here. Disposable test databases grant it to their
--      own throwaway logins, so the frozen functions keep database-level regression coverage
--      (immutability, segregation of duties, privilege) even though they left the product.
--   3. Twelve permission codes that exist only for the retired lane are recorded in
--      abos.permission_retirements (append-only). The catalogue rows themselves are not touched:
--      they stay ACTIVE so the frozen functions' own authorizers (0013/0016/0032) keep working for the
--      frozen lane, and so every existing user_permission_grants row is preserved exactly as it is,
--      including through later role re-synchronisation. A retired code can no longer be added to a
--      role (trigger below); the application hides retired codes and reports them as RETIRED.
--   4. abos.frozen_lanes lists the frozen entry points with their live EXECUTE state, so the
--      inventory test and future readers have one place to look.
--
-- What does not change: sandbox_sessions keeps serving password sessions. The developer-token
-- fallback inside treasury_secure_context is unreachable from any runtime once EXECUTE is gone, and
-- the synthetic gate (sandbox_authorizations) is absent on company data anyway.

-- ---------------------------------------------------------------------------
-- 1. Holder role for the frozen lane.
-- ---------------------------------------------------------------------------

DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'abos_e1_frozen_lane') THEN
    CREATE ROLE abos_e1_frozen_lane NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
  ELSE
    ALTER ROLE abos_e1_frozen_lane NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
  END IF;
END
$role$;

COMMENT ON ROLE abos_e1_frozen_lane IS
  'Holds EXECUTE on the frozen E1 entry points (abos.frozen_lanes). Never granted to any production login; disposable test harnesses grant it to their own throwaway logins.';

GRANT USAGE ON SCHEMA abos TO abos_e1_frozen_lane;

-- ---------------------------------------------------------------------------
-- 2. Runtime EXECUTE leaves the fourteen reviewed E1 entry points; the frozen lane receives it.
--    Signatures are spelled out so a later overload can never be caught by accident.
-- ---------------------------------------------------------------------------

-- Treasury synthetic lane (0008, 0015, 0032).
REVOKE EXECUTE ON FUNCTION abos.treasury_secure_context(text)
  FROM abos_e1_runtime, abos_e1_treasury_runtime, abos_v1_identity_runtime;
REVOKE EXECUTE ON FUNCTION abos.treasury_secure_query(text, uuid, text, uuid)
  FROM abos_e1_runtime, abos_e1_treasury_runtime, abos_v1_identity_runtime;
REVOKE EXECUTE ON FUNCTION abos.treasury_secure_command(text, uuid, text, jsonb)
  FROM abos_e1_runtime, abos_e1_treasury_runtime, abos_v1_identity_runtime;
REVOKE EXECUTE ON FUNCTION abos.treasury_synthetic_signin_context(text)
  FROM abos_e1_runtime, abos_e1_treasury_runtime, abos_v1_identity_runtime;
REVOKE EXECUTE ON FUNCTION abos.treasury_revoke_own_session(text)
  FROM abos_e1_runtime, abos_e1_treasury_runtime, abos_v1_identity_runtime;
REVOKE EXECUTE ON FUNCTION abos.treasury_safes_saraf_query(text, uuid, text, uuid)
  FROM abos_e1_runtime, abos_e1_treasury_runtime, abos_v1_identity_runtime;
REVOKE EXECUTE ON FUNCTION abos.treasury_safes_saraf_command(text, uuid, text, jsonb)
  FROM abos_e1_runtime, abos_e1_treasury_runtime, abos_v1_identity_runtime;
-- Finance handoff / synthetic posting lane (0007, 0009, 0032).
REVOKE EXECUTE ON FUNCTION abos.finance_handoff_workspace(text)
  FROM abos_e1_runtime, abos_e1_treasury_runtime, abos_v1_identity_runtime;
REVOKE EXECUTE ON FUNCTION abos.finance_handoff_trace(text, uuid)
  FROM abos_e1_runtime, abos_e1_treasury_runtime, abos_v1_identity_runtime;
REVOKE EXECUTE ON FUNCTION abos.finance_prepare_capital_posting(text, uuid, uuid, text)
  FROM abos_e1_runtime, abos_e1_treasury_runtime, abos_v1_identity_runtime;
REVOKE EXECUTE ON FUNCTION abos.finance_approve_capital_posting(text, uuid)
  FROM abos_e1_runtime, abos_e1_treasury_runtime, abos_v1_identity_runtime;
REVOKE EXECUTE ON FUNCTION abos.post_synthetic_capital_receipt(text, uuid, uuid)
  FROM abos_e1_runtime, abos_e1_treasury_runtime, abos_v1_identity_runtime;
-- Shareholder capital-request lane (0016, 0031, 0033).
REVOKE EXECUTE ON FUNCTION abos.shareholder_capital_workspace(text)
  FROM abos_e1_runtime, abos_e1_treasury_runtime, abos_v1_identity_runtime;
REVOKE EXECUTE ON FUNCTION abos.shareholder_create_capital_request(text, uuid, uuid, text, date, uuid, text)
  FROM abos_e1_runtime, abos_e1_treasury_runtime, abos_v1_identity_runtime;

GRANT EXECUTE ON FUNCTION
  abos.treasury_secure_context(text),
  abos.treasury_secure_query(text, uuid, text, uuid),
  abos.treasury_secure_command(text, uuid, text, jsonb),
  abos.treasury_synthetic_signin_context(text),
  abos.treasury_revoke_own_session(text),
  abos.treasury_safes_saraf_query(text, uuid, text, uuid),
  abos.treasury_safes_saraf_command(text, uuid, text, jsonb),
  abos.finance_handoff_workspace(text),
  abos.finance_handoff_trace(text, uuid),
  abos.finance_prepare_capital_posting(text, uuid, uuid, text),
  abos.finance_approve_capital_posting(text, uuid),
  abos.post_synthetic_capital_receipt(text, uuid, uuid),
  abos.shareholder_capital_workspace(text),
  abos.shareholder_create_capital_request(text, uuid, uuid, text, date, uuid, text)
  TO abos_e1_frozen_lane;

-- ---------------------------------------------------------------------------
-- 3. Permission retirements: append-only, lock-only, catalogue rows untouched.
-- ---------------------------------------------------------------------------

CREATE TABLE abos.permission_retirements (
  permission_code text PRIMARY KEY REFERENCES abos.permission_catalogue(permission_code),
  retired_in_migration text NOT NULL CHECK (retired_in_migration ~ '^[0-9]{4}_[a-z0-9_]+$'),
  retired_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 10 AND 500)
);

COMMENT ON TABLE abos.permission_retirements IS
  'Permission codes that belong only to a retired lane. The catalogue row stays; the code is hidden from the product, cannot be added to a role, and existing grants are left exactly as they are.';

-- The register is changed only by a new migration.
CREATE TRIGGER permission_retirements_no_update_or_delete
BEFORE UPDATE OR DELETE ON abos.permission_retirements
FOR EACH ROW EXECUTE FUNCTION abos.prevent_audit_mutation();

INSERT INTO abos.permission_retirements (permission_code, retired_in_migration, reason) VALUES
  ('treasury.read',                      '0041_v1_retire_synthetic_lane', 'E1 Treasury screen (safes, cash receipts, counts); the operational Safe model is operational_treasury_accounts (0027).'),
  ('treasury.cash-receipt.record',       '0041_v1_retire_synthetic_lane', 'E1 synthetic cash-receipt custody pipeline; replaced by direct shareholder capital (0040) and the 0036 bridge.'),
  ('treasury.cash-count.record',         '0041_v1_retire_synthetic_lane', 'E1 synthetic cash-receipt custody pipeline; replaced by direct shareholder capital (0040) and the 0036 bridge.'),
  ('treasury.cash-receipt.verify',       '0041_v1_retire_synthetic_lane', 'E1 synthetic cash-receipt custody pipeline; replaced by direct shareholder capital (0040) and the 0036 bridge.'),
  ('treasury.handoff.create',            '0041_v1_retire_synthetic_lane', 'E1 Treasury-to-Finance handoff; no operational lane hands cash to Finance for posting.'),
  ('treasury.cash-account.reconcile',    '0041_v1_retire_synthetic_lane', 'E1 synthetic cash-account opening and whole-safe counts; the operational Safe model is operational_treasury_accounts (0027).'),
  ('treasury.cash-account.approve',      '0041_v1_retire_synthetic_lane', 'E1 synthetic cash-account opening and whole-safe counts; the operational Safe model is operational_treasury_accounts (0027).'),
  ('shareholder.capital-request.create', '0041_v1_retire_synthetic_lane', 'E1 capital request from an agreement installment; capital is received in one save (0040) and agreements are informational.'),
  ('shareholder.capital-intent.create',  '0041_v1_retire_synthetic_lane', 'E1 capital receipt intent; never available in the preview and superseded by direct shareholder capital (0040).'),
  ('finance.posting-intent.create',      '0041_v1_retire_synthetic_lane', 'E1 Finance inbox prepare/approve/post pipeline; operational lanes post on save or through the 0036 bridge.'),
  ('finance.posting-intent.approve',     '0041_v1_retire_synthetic_lane', 'E1 Finance inbox prepare/approve/post pipeline; operational lanes post on save or through the 0036 bridge.'),
  ('finance.journal.post',               '0041_v1_retire_synthetic_lane', 'E1 Finance inbox prepare/approve/post pipeline; operational lanes post on save or through the 0036 bridge.');

-- Read by the identity runtime (catalogue view, role validation) and by the identity owner, whose own
-- command (identity_runtime_command) inserts role permissions and so fires the guard below. No other
-- runtime needs the register; the Finance and Treasury runtimes keep no access to it.
GRANT SELECT ON abos.permission_retirements TO abos_v1_identity_owner, abos_v1_identity_runtime;

-- A retired permission can no longer be put into a role, whoever writes the row. Rows that already
-- exist are left alone: nothing is removed from any role, and no grant changes.
CREATE OR REPLACE FUNCTION abos.guard_retired_role_permission()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM abos.permission_retirements r WHERE r.permission_code = NEW.permission_code) THEN
    RAISE EXCEPTION 'permission % is retired and cannot be added to a role', NEW.permission_code
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION abos.guard_retired_role_permission() FROM PUBLIC;

CREATE TRIGGER access_role_permissions_refuse_retired
BEFORE INSERT ON abos.access_role_permissions
FOR EACH ROW EXECUTE FUNCTION abos.guard_retired_role_permission();

-- ---------------------------------------------------------------------------
-- 4. Inventory of the frozen lane, with the live EXECUTE state of every grantee that matters.
-- ---------------------------------------------------------------------------

CREATE VIEW abos.frozen_lanes AS
SELECT lane.lane,
       lane.entry_point,
       lane.frozen_in_migration,
       pg_catalog.to_regprocedure(lane.entry_point) IS NOT NULL AS function_exists,
       CASE WHEN pg_catalog.to_regprocedure(lane.entry_point) IS NULL THEN NULL
            ELSE pg_catalog.has_function_privilege('abos_e1_runtime', pg_catalog.to_regprocedure(lane.entry_point)::oid, 'EXECUTE') END
         AS finance_runtime_can_execute,
       CASE WHEN pg_catalog.to_regprocedure(lane.entry_point) IS NULL THEN NULL
            ELSE pg_catalog.has_function_privilege('abos_e1_treasury_runtime', pg_catalog.to_regprocedure(lane.entry_point)::oid, 'EXECUTE') END
         AS treasury_runtime_can_execute,
       CASE WHEN pg_catalog.to_regprocedure(lane.entry_point) IS NULL THEN NULL
            ELSE pg_catalog.has_function_privilege('abos_v1_identity_runtime', pg_catalog.to_regprocedure(lane.entry_point)::oid, 'EXECUTE') END
         AS identity_runtime_can_execute,
       CASE WHEN pg_catalog.to_regprocedure(lane.entry_point) IS NULL THEN NULL
            ELSE pg_catalog.has_function_privilege('abos_e1_frozen_lane', pg_catalog.to_regprocedure(lane.entry_point)::oid, 'EXECUTE') END
         AS frozen_lane_can_execute
  FROM (VALUES
    ('TREASURY_SYNTHETIC',  'abos.treasury_secure_context(text)',                                          '0041_v1_retire_synthetic_lane'),
    ('TREASURY_SYNTHETIC',  'abos.treasury_secure_query(text,uuid,text,uuid)',                             '0041_v1_retire_synthetic_lane'),
    ('TREASURY_SYNTHETIC',  'abos.treasury_secure_command(text,uuid,text,jsonb)',                          '0041_v1_retire_synthetic_lane'),
    ('TREASURY_SYNTHETIC',  'abos.treasury_synthetic_signin_context(text)',                                '0041_v1_retire_synthetic_lane'),
    ('TREASURY_SYNTHETIC',  'abos.treasury_revoke_own_session(text)',                                      '0041_v1_retire_synthetic_lane'),
    ('TREASURY_SYNTHETIC',  'abos.treasury_safes_saraf_query(text,uuid,text,uuid)',                        '0041_v1_retire_synthetic_lane'),
    ('TREASURY_SYNTHETIC',  'abos.treasury_safes_saraf_command(text,uuid,text,jsonb)',                     '0041_v1_retire_synthetic_lane'),
    ('FINANCE_HANDOFF',     'abos.finance_handoff_workspace(text)',                                        '0041_v1_retire_synthetic_lane'),
    ('FINANCE_HANDOFF',     'abos.finance_handoff_trace(text,uuid)',                                       '0041_v1_retire_synthetic_lane'),
    ('FINANCE_HANDOFF',     'abos.finance_prepare_capital_posting(text,uuid,uuid,text)',                   '0041_v1_retire_synthetic_lane'),
    ('FINANCE_HANDOFF',     'abos.finance_approve_capital_posting(text,uuid)',                             '0041_v1_retire_synthetic_lane'),
    ('FINANCE_HANDOFF',     'abos.post_synthetic_capital_receipt(text,uuid,uuid)',                         '0041_v1_retire_synthetic_lane'),
    ('SHAREHOLDER_REQUEST', 'abos.shareholder_capital_workspace(text)',                                    '0041_v1_retire_synthetic_lane'),
    ('SHAREHOLDER_REQUEST', 'abos.shareholder_create_capital_request(text,uuid,uuid,text,date,uuid,text)', '0041_v1_retire_synthetic_lane')
  ) AS lane(lane, entry_point, frozen_in_migration);

COMMENT ON VIEW abos.frozen_lanes IS
  'The E1 entry points frozen by 0041: they exist, keep their owners and bodies, and are executable only by abos_e1_frozen_lane. Any runtime column reading true is a regression.';

GRANT SELECT ON abos.frozen_lanes
  TO abos_v1_identity_runtime, abos_e1_runtime, abos_e1_treasury_runtime, abos_e1_frozen_lane;
