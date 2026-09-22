-- Run after applying 0001_e0_finance_foundation.sql.
-- This is read-only catalog verification and exits with an exception on drift.

DO $verify$
DECLARE
  expected_table text;
  expected_tables text[] := ARRAY[
    'user_accounts', 'business_parties', 'ledger_accounts', 'companies', 'legal_entities',
    'evidence_references',
    'currencies', 'projects', 'departments', 'cost_centers',
    'shareholder_profiles', 'capital_agreements', 'registration_evidence',
    'capital_installments', 'cash_locations',
    'cash_location_currency_accounts', 'physical_cash_counts', 'cash_receipts',
    'accounting_periods', 'posting_intents', 'posting_approvals', 'journals',
    'journal_lines', 'journal_reversal_links', 'subledger_entries',
    'idempotency_records', 'audit_records', 'outbox_events'
  ];
  missing_tables text[];
  numeric_with_declared_scale text[];
  business_row_count bigint;
BEGIN
  SELECT array_agg(name ORDER BY name)
    INTO missing_tables
    FROM unnest(expected_tables) AS name
   WHERE to_regclass(format('abos.%I', name)) IS NULL;

  IF missing_tables IS NOT NULL THEN
    RAISE EXCEPTION 'missing E0 tables: %', missing_tables;
  END IF;

  IF to_regclass('abos.bank_accounts') IS NOT NULL
     OR to_regclass('abos.banks') IS NOT NULL THEN
    RAISE EXCEPTION 'bank tables are outside the authorized E0 slice';
  END IF;

  IF 'abos.user_accounts'::regclass = 'abos.business_parties'::regclass
     OR 'abos.user_accounts'::regclass = 'abos.ledger_accounts'::regclass
     OR 'abos.business_parties'::regclass = 'abos.ledger_accounts'::regclass THEN
    RAISE EXCEPTION 'Type A, Type B and Type C records must be distinct relations';
  END IF;

  SELECT array_agg(format('%I.%I', table_name, column_name) ORDER BY table_name, column_name)
    INTO numeric_with_declared_scale
    FROM information_schema.columns
   WHERE table_schema = 'abos'
     AND data_type = 'numeric'
     AND numeric_precision IS NOT NULL;

  IF numeric_with_declared_scale IS NOT NULL THEN
    RAISE EXCEPTION 'E0 NUMERIC columns must not invent precision/scale: %',
      numeric_with_declared_scale;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'abos.audit_records'::regclass
       AND tgname = 'audit_records_no_update_or_delete' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'append-only audit trigger is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'abos.journals'::regclass
       AND tgname = 'posted_reversal_requires_link' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'deferred posted-reversal link trigger is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'abos.posting_approvals'::regclass
       AND tgname = 'posting_approvals_sod' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'posting approval SoD trigger is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'abos.journals'::regclass
       AND tgname = 'journals_posting_guard' AND NOT tgisinternal
       AND (tgtype & 4) = 4 AND (tgtype & 16) = 16
  ) THEN
    RAISE EXCEPTION 'journal posting invariant trigger is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'abos.cash_location_currency_accounts'::regclass
       AND tgname = 'cash_account_activation_guard' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'cash location-currency activation trigger is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'abos.journal_lines'::regclass
       AND tgname = 'journal_lines_guard' AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'abos.subledger_entries'::regclass
       AND tgname = 'subledger_entries_guard' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'posted journal detail immutability triggers are missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'abos.journal_reversal_links'::regclass
       AND tgname = 'journal_reversal_links_no_update_or_delete'
       AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'journal reversal-link immutability trigger is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'abos.journal_reversal_links'::regclass
       AND tgname = 'journal_reversal_links_guard' AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'abos.journals'::regclass
       AND tgname = 'journals_delete_guard' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'journal reversal/delete guards are missing';
  END IF;

  FOREACH expected_table IN ARRAY expected_tables LOOP
    EXECUTE format('SELECT count(*) FROM abos.%I', expected_table)
      INTO business_row_count;
    IF business_row_count <> 0 THEN
      RAISE EXCEPTION 'migration must not seed business data: abos.% has % rows',
        expected_table, business_row_count;
    END IF;
  END LOOP;
END;
$verify$;

SELECT
  'E0 schema verification passed' AS result,
  current_database() AS database_name,
  clock_timestamp() AS verified_at;
