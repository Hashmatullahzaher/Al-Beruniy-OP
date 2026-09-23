-- E1 synthetic sandbox runtime privilege boundary.
--
-- Apply with a privileged migration identity. Provision a separate LOGIN role outside this
-- migration and grant it membership in abos_e1_runtime only after the approved write API exists.
-- This role is deliberately read-only today: the E1 Finance adapter still issues direct SQL, and
-- a role with direct journal DML could copy the visible, caller-settable runtime marker and bypass
-- application authorization. Granting those writes would create a false security boundary.
-- The role is NOLOGIN so a password cannot accidentally make it a standalone posting identity.

DO $e1_runtime_role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'abos_e1_runtime') THEN
    CREATE ROLE abos_e1_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
  ELSE
    ALTER ROLE abos_e1_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
  END IF;
END;
$e1_runtime_role$;

REVOKE ALL ON SCHEMA abos FROM abos_e1_runtime;
REVOKE ALL ON ALL TABLES IN SCHEMA abos FROM abos_e1_runtime;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA abos FROM abos_e1_runtime;
GRANT USAGE ON SCHEMA abos TO abos_e1_runtime;
GRANT SELECT ON ALL TABLES IN SCHEMA abos TO abos_e1_runtime;

COMMENT ON ROLE abos_e1_runtime IS
  'E1 synthetic sandbox read-only runtime role. Privileged migrations use another identity. Direct finance writes remain denied until a controlled write API exists.';
