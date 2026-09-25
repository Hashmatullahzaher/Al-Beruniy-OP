-- Least-privilege ownership for the restricted Treasury and Finance boundaries (V1 release blocker).
--
-- Before this migration every SECURITY DEFINER function from 0007-0009 was owned by the migration
-- identity, a superuser with BYPASSRLS and CREATEROLE. A logic flaw in any of them therefore ran
-- with unlimited database authority, including the ability to disable the immutability triggers.
--
-- After it:
--  * Treasury functions are owned by abos_e1_treasury_owner and Finance functions by
--    abos_e1_finance_owner. Both are NOLOGIN, NOSUPERUSER, NOBYPASSRLS, NOCREATEROLE, NOCREATEDB,
--    NOREPLICATION and NOINHERIT. Neither owns any table, so neither can ALTER, DROP or disable
--    triggers on one; the append-only, posting and segregation-of-duties triggers bind them too.
--  * Each owner receives exactly the table privileges its functions (and the triggers those
--    functions fire) need. There is no DELETE, TRUNCATE, REFERENCES or TRIGGER privilege.
--    Treasury has no write access to any ledger table; Finance has no write access to custody tables.
--  * Every definer function runs with search_path = pg_catalog, pg_temp, so a temporary object
--    can never shadow a catalog or schema object.
--  * Internal helper functions are no longer executable by PUBLIC.
--  * Runtime roles still hold EXECUTE on the public entry points only, and no table privilege.

DO $roles$
DECLARE
  owner_name text;
BEGIN
  FOREACH owner_name IN ARRAY ARRAY['abos_e1_treasury_owner', 'abos_e1_finance_owner'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = owner_name) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT', owner_name);
    ELSE
      EXECUTE format('ALTER ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT', owner_name);
    END IF;
  END LOOP;
END
$roles$;

GRANT USAGE ON SCHEMA abos TO abos_e1_treasury_owner, abos_e1_finance_owner;

-- ---------------------------------------------------------------------------
-- Shared read access: session, grant and sandbox-gate checks.
-- ---------------------------------------------------------------------------
GRANT SELECT ON
  abos.sandbox_authorizations, abos.sandbox_legal_entity_scopes, abos.sandbox_sessions,
  abos.user_accounts, abos.user_permission_grants, abos.user_scope_grants
TO abos_e1_treasury_owner, abos_e1_finance_owner;

-- ---------------------------------------------------------------------------
-- Treasury owner: custody records. No ledger writes.
-- ---------------------------------------------------------------------------
GRANT SELECT ON
  abos.business_parties, abos.capital_agreements, abos.capital_installments, abos.capital_receipt_intents,
  abos.capital_agreement_funding_policies, abos.capital_agreement_commitment_usage,
  abos.cash_account_openings, abos.cash_location_cashier_assignments, abos.cash_location_currency_accounts,
  abos.cash_locations, abos.cash_receipts, abos.evidence_references, abos.ledger_accounts,
  abos.physical_cash_counts, abos.posting_approvals, abos.posting_intents, abos.journals,
  abos.treasury_events, abos.treasury_evidence_bindings, abos.treasury_finance_handoffs,
  abos.accounting_periods, abos.legal_entities, abos.currencies
TO abos_e1_treasury_owner;
GRANT INSERT, UPDATE ON
  abos.cash_account_openings, abos.cash_location_cashier_assignments, abos.cash_location_currency_accounts,
  abos.cash_locations, abos.cash_receipts, abos.physical_cash_counts
TO abos_e1_treasury_owner;
GRANT INSERT ON abos.treasury_finance_handoffs, abos.treasury_events TO abos_e1_treasury_owner;
GRANT UPDATE ON abos.capital_receipt_intents TO abos_e1_treasury_owner;
GRANT INSERT ON abos.capital_receipt_intent_history TO abos_e1_treasury_owner;
GRANT UPDATE (revoked_at) ON abos.sandbox_sessions TO abos_e1_treasury_owner;

-- ---------------------------------------------------------------------------
-- Finance owner: posting intents, approvals, journals. No custody writes.
-- ---------------------------------------------------------------------------
GRANT SELECT ON
  abos.accounting_periods, abos.business_parties, abos.capital_agreements, abos.capital_installments,
  abos.capital_receipt_intents, abos.capital_agreement_funding_policies, abos.capital_agreement_commitment_usage,
  abos.cash_location_currency_accounts, abos.cash_locations, abos.cash_receipts,
  abos.evidence_references, abos.finance_approval_evidence_bindings, abos.journal_lines, abos.journals,
  abos.journal_reversal_links, abos.ledger_accounts, abos.physical_cash_counts, abos.posting_approvals,
  abos.posting_intents, abos.registration_evidence, abos.subledger_entries, abos.treasury_finance_handoffs,
  abos.legal_entities, abos.currencies, abos.idempotency_records
TO abos_e1_finance_owner;
GRANT INSERT, UPDATE ON abos.posting_intents, abos.journals, abos.journal_lines TO abos_e1_finance_owner;
GRANT INSERT ON
  abos.posting_approvals, abos.subledger_entries, abos.idempotency_records, abos.audit_records, abos.outbox_events
TO abos_e1_finance_owner;
GRANT UPDATE ON abos.capital_receipt_intents TO abos_e1_finance_owner;
GRANT INSERT ON abos.capital_receipt_intent_history TO abos_e1_finance_owner;

-- ---------------------------------------------------------------------------
-- Lock-only tables. The functions take row locks (SELECT ... FOR SHARE / FOR UPDATE) on rows they
-- must not change, and PostgreSQL requires UPDATE privilege for that. The privilege is granted, and
-- abos.forbid_owner_update refuses every actual UPDATE by an owner role on these tables, with one
-- exceptions: the Treasury owner may revoke a session (revoked_at from NULL to a time, nothing else)
-- and maintains cash receipts, cash accounts, safes and physical counts, which are lock-only for Finance.
-- ---------------------------------------------------------------------------
GRANT UPDATE ON
  abos.sandbox_sessions, abos.user_accounts, abos.sandbox_authorizations, abos.sandbox_legal_entity_scopes,
  abos.user_permission_grants
TO abos_e1_treasury_owner, abos_e1_finance_owner;
GRANT UPDATE ON
  abos.user_scope_grants, abos.posting_approvals, abos.evidence_references, abos.cash_receipts,
  abos.accounting_periods, abos.cash_location_currency_accounts, abos.treasury_finance_handoffs,
  abos.capital_agreements, abos.physical_cash_counts, abos.cash_locations,
  -- locked by the posting provenance guard (0001) while a journal is posted
  abos.registration_evidence, abos.shareholder_profiles, abos.business_parties, abos.business_party_roles,
  abos.subledger_entries, abos.ledger_accounts
TO abos_e1_finance_owner;
GRANT SELECT ON abos.shareholder_profiles, abos.business_party_roles TO abos_e1_finance_owner;
GRANT UPDATE ON abos.capital_agreements, abos.capital_installments, abos.capital_agreement_commitment_usage
TO abos_e1_treasury_owner, abos_e1_finance_owner;

CREATE OR REPLACE FUNCTION abos.forbid_owner_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user NOT IN ('abos_e1_treasury_owner', 'abos_e1_finance_owner') THEN
    RETURN NEW;
  END IF;
  IF current_user = 'abos_e1_treasury_owner' AND TG_TABLE_NAME = 'sandbox_sessions' THEN
    -- Row fields are compared as JSON so PL/pgSQL never resolves a column this table lacks.
    IF to_jsonb(OLD) ->> 'revoked_at' IS NULL AND to_jsonb(NEW) ->> 'revoked_at' IS NOT NULL
       AND (to_jsonb(NEW) - 'revoked_at') = (to_jsonb(OLD) - 'revoked_at') THEN
      RETURN NEW;
    END IF;
  END IF;
  -- Custody rows the Treasury owner genuinely maintains; for Finance they are lock-only.
  IF current_user = 'abos_e1_treasury_owner' AND TG_TABLE_NAME IN ('cash_receipts', 'cash_location_currency_accounts', 'physical_cash_counts', 'cash_locations') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% may lock but not change %', current_user, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

DO $lock_only$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'sandbox_sessions', 'user_accounts', 'sandbox_authorizations', 'sandbox_legal_entity_scopes',
    'user_permission_grants', 'user_scope_grants', 'posting_approvals', 'evidence_references',
    'cash_receipts', 'accounting_periods', 'cash_location_currency_accounts', 'treasury_finance_handoffs',
    'capital_agreements', 'physical_cash_counts', 'cash_locations', 'capital_installments',
    'capital_agreement_commitment_usage', 'registration_evidence', 'shareholder_profiles', 'business_parties',
    'business_party_roles', 'subledger_entries', 'ledger_accounts'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON abos.%I FOR EACH ROW EXECUTE FUNCTION abos.forbid_owner_update()',
      table_name || '_owner_lock_only', table_name);
  END LOOP;
END
$lock_only$;

-- ---------------------------------------------------------------------------
-- Ownership and search path of every definer function.
-- ---------------------------------------------------------------------------
DO $owners$
DECLARE
  fn record;
  target_owner text;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure AS signature, p.proname
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'abos' AND p.prosecdef
  LOOP
    target_owner := CASE
      WHEN fn.proname LIKE 'treasury\_%' THEN 'abos_e1_treasury_owner'
      WHEN fn.proname LIKE 'finance\_%' OR fn.proname IN ('post_synthetic_capital_receipt', 'require_posted_reversal_link')
        THEN 'abos_e1_finance_owner'
    END;
    IF target_owner IS NULL THEN
      RAISE EXCEPTION 'SECURITY DEFINER function % has no assigned least-privilege owner', fn.signature;
    END IF;
    EXECUTE format('ALTER FUNCTION %s OWNER TO %I', fn.signature, target_owner);
    EXECUTE format('ALTER FUNCTION %s SET search_path = pg_catalog, pg_temp', fn.signature);
  END LOOP;
END
$owners$;

-- ---------------------------------------------------------------------------
-- Internal helpers: not callable by PUBLIC. The owners (whose functions fire triggers that call
-- them) and the identity runtime (whose writes fire the super-administrator guard) keep access.
-- ---------------------------------------------------------------------------
DO $helpers$
DECLARE
  fn record;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure AS signature
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'abos' AND NOT p.prosecdef
       AND p.prorettype <> 'pg_catalog.trigger'::pg_catalog.regtype
       AND p.proname IN ('assert_sandbox_mutation_authorized', 'check_super_admin_remains', 'is_assigned_cashier',
                         'require_treasury_permission', 'treasury_actor', 'user_holds_permission')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn.signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO abos_e1_treasury_owner, abos_e1_finance_owner, abos_v1_identity_runtime', fn.signature);
  END LOOP;
END
$helpers$;
