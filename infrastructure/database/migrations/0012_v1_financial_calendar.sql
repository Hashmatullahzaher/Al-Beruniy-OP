-- V1 company financial calendar (owner decision 2026-09-25): each legal entity chooses a Solar
-- Hijri year (from 1 Hamal), a Gregorian year (January-December) or a custom Gregorian year, and
-- reports can be shown in either calendar.
--
-- This migration adds the calendar settings, fiscal years and their twelve monthly periods, generated
-- as PENDING accounting periods. It does NOT open or close periods: who may do so is an open Finance
-- Manager policy item, and a PENDING period cannot receive a posting. Every entry point is a
-- restricted Finance function owned by abos_e1_finance_owner (0011's least-privilege model).

-- The Finance authorizer gains the calendar permission; everything else is unchanged.
CREATE OR REPLACE FUNCTION abos.finance_runtime_authorize(p_bearer_token text, p_permission text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $authorize$
DECLARE
  session_row record;
  gate_row record;
BEGIN
  IF p_bearer_token IS NULL OR pg_catalog.length(p_bearer_token) < 32 THEN
    RAISE EXCEPTION 'valid sandbox bearer credential required'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_permission NOT IN (
    'finance.posting-intent.create', 'finance.posting-intent.approve',
    'finance.journal.post', 'finance.report.operational.read', 'finance.calendar.manage') THEN
    RAISE EXCEPTION 'unsupported Finance permission'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT s.id, s.user_account_id, s.legal_entity_id, s.expires_at, s.revoked_at,
         u.status AS user_status
    INTO session_row
    FROM abos.sandbox_sessions s
    JOIN abos.user_accounts u ON u.id = s.user_account_id
   WHERE s.runtime_token_sha256 =
         pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_bearer_token, 'UTF8')), 'hex')
   FOR SHARE OF s, u;
  IF NOT FOUND OR session_row.revoked_at IS NOT NULL
     OR session_row.expires_at <= pg_catalog.clock_timestamp()
     OR session_row.user_status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'sandbox session is invalid, expired or revoked'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT environment, configuration_state, real_posting_enabled, runtime_marker, expires_at
    INTO gate_row
    FROM abos.sandbox_authorizations
   WHERE singleton
   FOR SHARE;
  IF NOT FOUND OR gate_row.environment NOT IN ('development', 'test')
     OR gate_row.configuration_state <> 'SYNTHETIC_TEST_ONLY'
     OR gate_row.real_posting_enabled OR gate_row.expires_at <= pg_catalog.clock_timestamp()
     OR NOT EXISTS (
       SELECT 1 FROM abos.sandbox_legal_entity_scopes scope
        WHERE scope.legal_entity_id = session_row.legal_entity_id
        FOR SHARE
     ) THEN
    RAISE EXCEPTION 'synthetic Finance sandbox authorization is not active'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM abos.user_permission_grants grant_row
     WHERE grant_row.user_account_id = session_row.user_account_id
       AND grant_row.legal_entity_id = session_row.legal_entity_id
       AND grant_row.permission_code = p_permission
       AND grant_row.revoked_at IS NULL
     FOR SHARE
  ) THEN
    RAISE EXCEPTION 'current Finance authority is missing %', p_permission
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  PERFORM pg_catalog.set_config('abos.actor_user_account_id', session_row.user_account_id::text, true);
  PERFORM pg_catalog.set_config('abos.finance_legal_entity_id', session_row.legal_entity_id::text, true);
  PERFORM pg_catalog.set_config('abos.runtime_marker', gate_row.runtime_marker, true);
  RETURN session_row.user_account_id;
END
$authorize$;

-- ---------------------------------------------------------------------------
-- Solar Hijri arithmetic (jalaali algorithm, Borkowski). The same algorithm and test vectors as
-- packages/calendar, so the database and the interface always agree on 1 Hamal.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION abos.solar_hijri_new_year(p_year integer)
RETURNS date
LANGUAGE plpgsql IMMUTABLE STRICT
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  breaks integer[] := ARRAY[-61, 9, 38, 199, 426, 686, 756, 818, 1111, 1181, 1210, 1635, 2060, 2097, 2192, 2262, 2324, 2394, 2456, 3178];
  gy integer := p_year + 621;
  leap_j integer := -14;
  jp integer := breaks[1];
  jm integer;
  jump integer := 0;
  n integer;
  leap_g integer;
  march integer;
  i integer;
BEGIN
  IF p_year < 1300 OR p_year > 1600 THEN
    RAISE EXCEPTION 'Solar Hijri year % is outside the supported range 1300-1600', p_year USING ERRCODE = 'data_exception';
  END IF;
  FOR i IN 2 .. array_length(breaks, 1) LOOP
    jm := breaks[i];
    jump := jm - jp;
    EXIT WHEN p_year < jm;
    leap_j := leap_j + (jump / 33) * 8 + ((jump % 33) / 4);
    jp := jm;
  END LOOP;
  n := p_year - jp;
  leap_j := leap_j + (n / 33) * 8 + (((n % 33) + 3) / 4);
  IF (jump % 33) = 4 AND jump - n = 4 THEN
    leap_j := leap_j + 1;
  END IF;
  leap_g := (gy / 4) - (((gy / 100) + 1) * 3) / 4 - 150;
  march := 20 + leap_j - leap_g;
  RETURN make_date(gy, 3, march);
END;
$$;

-- First Gregorian day of a Solar Hijri month: months 1-6 have 31 days, 7-11 have 30.
CREATE OR REPLACE FUNCTION abos.solar_hijri_to_gregorian(p_year integer, p_month integer, p_day integer)
RETURNS date
LANGUAGE plpgsql IMMUTABLE STRICT
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  start_day date := abos.solar_hijri_new_year(p_year);
  month_start integer;
  month_length integer;
BEGIN
  IF p_month < 1 OR p_month > 12 THEN
    RAISE EXCEPTION 'Solar Hijri month % is invalid', p_month USING ERRCODE = 'data_exception';
  END IF;
  month_start := CASE WHEN p_month <= 7 THEN (p_month - 1) * 31 ELSE 186 + (p_month - 7) * 30 END;
  month_length := CASE WHEN p_month <= 6 THEN 31 WHEN p_month <= 11 THEN 30
                       ELSE (abos.solar_hijri_new_year(p_year + 1) - start_day) - 336 END;
  IF p_day < 1 OR p_day > month_length THEN
    RAISE EXCEPTION 'Solar Hijri day %-%-% is invalid', p_year, p_month, p_day USING ERRCODE = 'data_exception';
  END IF;
  RETURN start_day + month_start + p_day - 1;
END;
$$;

CREATE OR REPLACE FUNCTION abos.dari_digits(p_text text)
RETURNS text
LANGUAGE sql IMMUTABLE STRICT
SET search_path = pg_catalog, pg_temp
AS $$ SELECT translate(p_text, '0123456789', '۰۱۲۳۴۵۶۷۸۹') $$;

-- ---------------------------------------------------------------------------
-- Calendar settings, fiscal years and their periods.
-- ---------------------------------------------------------------------------

INSERT INTO abos.permission_catalogue
  (permission_code, catalogue_version, category, availability, independence_enforced, administrative, sort_order)
VALUES ('finance.calendar.manage', 2, 'FINANCE', 'ACTIVE', false, false, 125);

CREATE TABLE abos.financial_calendar_settings (
  legal_entity_id uuid PRIMARY KEY REFERENCES abos.legal_entities(id),
  calendar_kind text NOT NULL CHECK (calendar_kind IN ('SOLAR_HIJRI', 'GREGORIAN', 'CUSTOM')),
  custom_start_month smallint CHECK (custom_start_month BETWEEN 1 AND 12),
  custom_start_day smallint CHECK (custom_start_day BETWEEN 1 AND 28),
  reporting_calendars text[] NOT NULL
    CHECK (cardinality(reporting_calendars) BETWEEN 1 AND 2
           AND reporting_calendars <@ ARRAY['SOLAR_HIJRI', 'GREGORIAN']::text[]),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by_user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((calendar_kind = 'CUSTOM') = (custom_start_month IS NOT NULL AND custom_start_day IS NOT NULL)),
  CHECK (calendar_kind = 'CUSTOM' OR (custom_start_month IS NULL AND custom_start_day IS NULL))
);

CREATE TABLE abos.fiscal_years (
  id uuid PRIMARY KEY,
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  calendar_kind text NOT NULL CHECK (calendar_kind IN ('SOLAR_HIJRI', 'GREGORIAN', 'CUSTOM')),
  fiscal_year integer NOT NULL,
  label_en text NOT NULL CHECK (btrim(label_en) <> ''),
  label_fa text NOT NULL CHECK (btrim(label_fa) <> ''),
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  generated_by_user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  generated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (legal_entity_id, calendar_kind, fiscal_year),
  CHECK (ends_on > starts_on)
);
CREATE TRIGGER fiscal_years_no_update_or_delete
BEFORE UPDATE OR DELETE ON abos.fiscal_years
FOR EACH ROW EXECUTE FUNCTION abos.prevent_audit_mutation();

ALTER TABLE abos.accounting_periods
  ADD COLUMN fiscal_year_id uuid REFERENCES abos.fiscal_years(id),
  ADD COLUMN period_sequence smallint CHECK (period_sequence BETWEEN 1 AND 12),
  ADD COLUMN period_name_fa text,
  ADD CONSTRAINT accounting_periods_fiscal_year_consistent
    CHECK ((fiscal_year_id IS NULL) = (period_sequence IS NULL) AND (fiscal_year_id IS NULL) = (period_name_fa IS NULL));
CREATE UNIQUE INDEX accounting_periods_fiscal_year_sequence ON abos.accounting_periods (fiscal_year_id, period_sequence)
  WHERE fiscal_year_id IS NOT NULL;

-- Two periods of one legal entity may never cover the same day, whoever inserts them.
CREATE OR REPLACE FUNCTION abos.guard_accounting_period_overlap()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('abos-periods:' || NEW.legal_entity_id::text, 0));
  IF EXISTS (SELECT 1 FROM abos.accounting_periods p
              WHERE p.legal_entity_id = NEW.legal_entity_id AND p.id <> NEW.id
                AND daterange(p.starts_on, p.ends_on, '[]') && daterange(NEW.starts_on, NEW.ends_on, '[]')) THEN
    RAISE EXCEPTION 'accounting period % overlaps an existing period of this legal entity', NEW.period_name
      USING ERRCODE = 'exclusion_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER accounting_periods_no_overlap
BEFORE INSERT ON abos.accounting_periods
FOR EACH ROW EXECUTE FUNCTION abos.guard_accounting_period_overlap();

-- ---------------------------------------------------------------------------
-- Restricted Finance entry points (owned by abos_e1_finance_owner, like every Finance definer).
-- Opening and closing periods is NOT provided: period authority is an open Finance Manager policy.
-- Generated periods are PENDING and cannot receive postings.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION abos.finance_calendar_view(p_bearer_token text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $view$
DECLARE
  actor uuid;
  entity uuid;
  can_manage boolean := true;
BEGIN
  BEGIN
    actor := abos.finance_runtime_authorize(p_bearer_token, 'finance.calendar.manage');
  EXCEPTION WHEN insufficient_privilege THEN
    actor := abos.finance_runtime_authorize(p_bearer_token, 'finance.report.operational.read');
    can_manage := false;
  END;
  entity := current_setting('abos.finance_legal_entity_id')::uuid;
  RETURN jsonb_build_object(
    'canManage', can_manage,
    'legalEntity', (SELECT jsonb_build_object('id', e.id, 'name', e.name, 'baseCurrency', e.base_currency_code)
                      FROM abos.legal_entities e WHERE e.id = entity),
    'settings', (SELECT jsonb_build_object('calendarKind', s.calendar_kind, 'customStartMonth', s.custom_start_month,
                        'customStartDay', s.custom_start_day, 'reportingCalendars', to_jsonb(s.reporting_calendars),
                        'version', s.version, 'updatedAt', s.updated_at,
                        'updatedBy', (SELECT u.display_name FROM abos.user_accounts u WHERE u.id = s.updated_by_user_account_id))
                   FROM abos.financial_calendar_settings s WHERE s.legal_entity_id = entity),
    'fiscalYears', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'id', fy.id, 'calendarKind', fy.calendar_kind, 'fiscalYear', fy.fiscal_year,
               'labelEn', fy.label_en, 'labelFa', fy.label_fa, 'startsOn', fy.starts_on, 'endsOn', fy.ends_on,
               'generatedAt', fy.generated_at,
               'periods', (SELECT jsonb_agg(jsonb_build_object('sequence', p.period_sequence, 'nameEn', p.period_name,
                                   'nameFa', p.period_name_fa, 'startsOn', p.starts_on, 'endsOn', p.ends_on, 'status', p.status)
                                   ORDER BY p.period_sequence)
                             FROM abos.accounting_periods p WHERE p.fiscal_year_id = fy.id))
             ORDER BY fy.starts_on)
        FROM abos.fiscal_years fy WHERE fy.legal_entity_id = entity), '[]'::jsonb),
    'otherPeriods', coalesce((
      SELECT jsonb_agg(jsonb_build_object('name', p.period_name, 'startsOn', p.starts_on, 'endsOn', p.ends_on, 'status', p.status)
                       ORDER BY p.starts_on)
        FROM abos.accounting_periods p WHERE p.legal_entity_id = entity AND p.fiscal_year_id IS NULL), '[]'::jsonb));
END;
$view$;

CREATE OR REPLACE FUNCTION abos.finance_calendar_configure(
  p_bearer_token text,
  p_calendar_kind text,
  p_custom_start_month integer,
  p_custom_start_day integer,
  p_reporting_calendars text[],
  p_expected_version integer
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $configure$
DECLARE
  actor uuid;
  entity uuid;
  current_row abos.financial_calendar_settings%ROWTYPE;
  structural_change boolean;
BEGIN
  actor := abos.finance_runtime_authorize(p_bearer_token, 'finance.calendar.manage');
  entity := current_setting('abos.finance_legal_entity_id')::uuid;
  IF p_calendar_kind NOT IN ('SOLAR_HIJRI', 'GREGORIAN', 'CUSTOM') THEN
    RAISE EXCEPTION 'unknown calendar kind' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO current_row FROM abos.financial_calendar_settings WHERE legal_entity_id = entity FOR UPDATE;
  IF FOUND THEN
    IF current_row.version <> p_expected_version THEN
      RAISE EXCEPTION 'the calendar settings were changed by someone else' USING ERRCODE = 'serialization_failure';
    END IF;
    structural_change := (current_row.calendar_kind, current_row.custom_start_month, current_row.custom_start_day)
      IS DISTINCT FROM (p_calendar_kind, p_custom_start_month::smallint, p_custom_start_day::smallint);
    -- The year structure is fixed once a fiscal year has been generated from it.
    IF structural_change AND EXISTS (SELECT 1 FROM abos.fiscal_years WHERE legal_entity_id = entity) THEN
      RAISE EXCEPTION 'the financial year structure cannot change after a fiscal year has been generated'
        USING ERRCODE = 'check_violation';
    END IF;
    UPDATE abos.financial_calendar_settings
       SET calendar_kind = p_calendar_kind,
           custom_start_month = CASE WHEN p_calendar_kind = 'CUSTOM' THEN p_custom_start_month END,
           custom_start_day = CASE WHEN p_calendar_kind = 'CUSTOM' THEN p_custom_start_day END,
           reporting_calendars = p_reporting_calendars, version = version + 1,
           updated_by_user_account_id = actor, updated_at = clock_timestamp()
     WHERE legal_entity_id = entity;
  ELSE
    IF p_expected_version <> 0 THEN
      RAISE EXCEPTION 'the calendar settings were changed by someone else' USING ERRCODE = 'serialization_failure';
    END IF;
    INSERT INTO abos.financial_calendar_settings
      (legal_entity_id, calendar_kind, custom_start_month, custom_start_day, reporting_calendars, updated_by_user_account_id)
    VALUES (entity, p_calendar_kind,
            CASE WHEN p_calendar_kind = 'CUSTOM' THEN p_custom_start_month END,
            CASE WHEN p_calendar_kind = 'CUSTOM' THEN p_custom_start_day END,
            p_reporting_calendars, actor);
  END IF;
  INSERT INTO abos.audit_records (id, actor_user_account_id, legal_entity_id, correlation_id, action, entity_type, entity_id, before_state, after_state, metadata)
  VALUES (gen_random_uuid(), actor, entity, gen_random_uuid(), 'FINANCIAL_CALENDAR_CONFIGURED', 'FINANCIAL_CALENDAR', entity,
          CASE WHEN current_row.legal_entity_id IS NULL THEN NULL ELSE to_jsonb(current_row) END,
          (SELECT to_jsonb(s) FROM abos.financial_calendar_settings s WHERE s.legal_entity_id = entity),
          jsonb_build_object('source', 'finance_calendar_configure'));
  RETURN (SELECT version FROM abos.financial_calendar_settings WHERE legal_entity_id = entity);
END;
$configure$;

CREATE OR REPLACE FUNCTION abos.finance_generate_fiscal_year(p_bearer_token text, p_fiscal_year integer)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $generate$
DECLARE
  actor uuid;
  entity uuid;
  settings abos.financial_calendar_settings%ROWTYPE;
  existing uuid;
  year_id uuid := gen_random_uuid();
  year_start date;
  year_end date;
  period_start date;
  period_end date;
  name_en text;
  name_fa text;
  label_en text;
  label_fa text;
  sh_months_en text[] := ARRAY['Hamal', 'Sawr', 'Jawza', 'Saratan', 'Asad', 'Sunbula', 'Mizan', 'Aqrab', 'Qaws', 'Jadi', 'Dalw', 'Hut'];
  sh_months_fa text[] := ARRAY['حمل', 'ثور', 'جوزا', 'سرطان', 'اسد', 'سنبله', 'میزان', 'عقرب', 'قوس', 'جدی', 'دلو', 'حوت'];
  g_months_en text[] := ARRAY['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  g_months_fa text[] := ARRAY['جنوری', 'فبروری', 'مارچ', 'اپریل', 'می', 'جون', 'جولای', 'اگست', 'سپتمبر', 'اکتوبر', 'نومبر', 'دسمبر'];
  n integer;
BEGIN
  actor := abos.finance_runtime_authorize(p_bearer_token, 'finance.calendar.manage');
  entity := current_setting('abos.finance_legal_entity_id')::uuid;
  SELECT * INTO settings FROM abos.financial_calendar_settings WHERE legal_entity_id = entity FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'choose the financial calendar before generating a fiscal year' USING ERRCODE = 'check_violation';
  END IF;
  SELECT id INTO existing FROM abos.fiscal_years
   WHERE legal_entity_id = entity AND calendar_kind = settings.calendar_kind AND fiscal_year = p_fiscal_year;
  IF FOUND THEN
    RETURN existing;
  END IF;

  IF settings.calendar_kind = 'SOLAR_HIJRI' THEN
    IF p_fiscal_year < 1300 OR p_fiscal_year > 1599 THEN
      RAISE EXCEPTION 'Solar Hijri fiscal year % is out of range', p_fiscal_year USING ERRCODE = 'check_violation';
    END IF;
    year_start := abos.solar_hijri_new_year(p_fiscal_year);
    year_end := abos.solar_hijri_new_year(p_fiscal_year + 1) - 1;
    label_en := 'FY ' || p_fiscal_year || ' SH';
    label_fa := 'سال مالی ' || abos.dari_digits(p_fiscal_year::text);
  ELSE
    IF p_fiscal_year < 1900 OR p_fiscal_year > 2200 THEN
      RAISE EXCEPTION 'fiscal year % is out of range', p_fiscal_year USING ERRCODE = 'check_violation';
    END IF;
    IF settings.calendar_kind = 'GREGORIAN' THEN
      year_start := make_date(p_fiscal_year, 1, 1);
    ELSE
      year_start := make_date(p_fiscal_year, settings.custom_start_month, settings.custom_start_day);
    END IF;
    year_end := (year_start + interval '1 year')::date - 1;
    label_en := CASE WHEN extract(year FROM year_end) = p_fiscal_year THEN 'FY ' || p_fiscal_year
                     ELSE 'FY ' || p_fiscal_year || '/' || right((p_fiscal_year + 1)::text, 2) END;
    label_fa := 'سال مالی ' || abos.dari_digits(CASE WHEN extract(year FROM year_end) = p_fiscal_year THEN p_fiscal_year::text
                     ELSE p_fiscal_year || '/' || right((p_fiscal_year + 1)::text, 2) END);
  END IF;

  INSERT INTO abos.fiscal_years (id, legal_entity_id, calendar_kind, fiscal_year, label_en, label_fa, starts_on, ends_on, generated_by_user_account_id)
  VALUES (year_id, entity, settings.calendar_kind, p_fiscal_year, label_en, label_fa, year_start, year_end, actor);

  FOR n IN 1 .. 12 LOOP
    IF settings.calendar_kind = 'SOLAR_HIJRI' THEN
      period_start := abos.solar_hijri_to_gregorian(p_fiscal_year, n, 1);
      period_end := CASE WHEN n = 12 THEN year_end ELSE abos.solar_hijri_to_gregorian(p_fiscal_year, n + 1, 1) - 1 END;
      name_en := sh_months_en[n] || ' ' || p_fiscal_year;
      name_fa := sh_months_fa[n] || ' ' || abos.dari_digits(p_fiscal_year::text);
    ELSE
      period_start := (year_start + make_interval(months => n - 1))::date;
      period_end := (year_start + make_interval(months => n))::date - 1;
      name_en := g_months_en[extract(month FROM period_start)::integer] || ' ' || extract(year FROM period_start);
      name_fa := g_months_fa[extract(month FROM period_start)::integer] || ' ' || abos.dari_digits(extract(year FROM period_start)::text);
      IF settings.calendar_kind = 'CUSTOM' AND settings.custom_start_day <> 1 THEN
        name_en := name_en || ' (from ' || extract(day FROM period_start) || ')';
        name_fa := name_fa || ' (از ' || abos.dari_digits(extract(day FROM period_start)::text) || ')';
      END IF;
    END IF;
    INSERT INTO abos.accounting_periods
      (id, legal_entity_id, period_name, starts_on, ends_on, status, fiscal_year_id, period_sequence, period_name_fa)
    VALUES (gen_random_uuid(), entity, name_en, period_start, period_end, 'PENDING', year_id, n, name_fa);
  END LOOP;

  IF (SELECT max(ends_on) FROM abos.accounting_periods WHERE fiscal_year_id = year_id) <> year_end
     OR (SELECT count(*) FROM abos.accounting_periods WHERE fiscal_year_id = year_id) <> 12 THEN
    RAISE EXCEPTION 'generated periods do not cover the fiscal year exactly' USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO abos.audit_records (id, actor_user_account_id, legal_entity_id, correlation_id, action, entity_type, entity_id, after_state, metadata)
  VALUES (gen_random_uuid(), actor, entity, gen_random_uuid(), 'FISCAL_YEAR_GENERATED', 'FISCAL_YEAR', year_id,
          jsonb_build_object('fiscalYear', p_fiscal_year, 'calendarKind', settings.calendar_kind, 'startsOn', year_start, 'endsOn', year_end, 'periods', 12, 'status', 'PENDING'),
          jsonb_build_object('source', 'finance_generate_fiscal_year'));
  RETURN year_id;
END;
$generate$;

-- ---------------------------------------------------------------------------
-- Ownership and access, following 0011.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT ON abos.financial_calendar_settings TO abos_e1_finance_owner;
GRANT UPDATE (calendar_kind, custom_start_month, custom_start_day, reporting_calendars, version,
  updated_by_user_account_id, updated_at) ON abos.financial_calendar_settings TO abos_e1_finance_owner;
GRANT SELECT, INSERT ON abos.fiscal_years TO abos_e1_finance_owner;
GRANT INSERT ON abos.accounting_periods TO abos_e1_finance_owner;
GRANT SELECT ON abos.permission_catalogue TO abos_e1_finance_owner;

ALTER FUNCTION abos.finance_calendar_view(text) OWNER TO abos_e1_finance_owner;
ALTER FUNCTION abos.finance_calendar_configure(text, text, integer, integer, text[], integer) OWNER TO abos_e1_finance_owner;
ALTER FUNCTION abos.finance_generate_fiscal_year(text, integer) OWNER TO abos_e1_finance_owner;

REVOKE ALL ON FUNCTION abos.finance_calendar_view(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION abos.finance_calendar_configure(text, text, integer, integer, text[], integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION abos.finance_generate_fiscal_year(text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION abos.finance_calendar_view(text) TO abos_e1_runtime;
GRANT EXECUTE ON FUNCTION abos.finance_calendar_configure(text, text, integer, integer, text[], integer) TO abos_e1_runtime;
GRANT EXECUTE ON FUNCTION abos.finance_generate_fiscal_year(text, integer) TO abos_e1_runtime;

-- Pure helpers stay callable only by the Finance owner (and the migration identity).
REVOKE ALL ON FUNCTION abos.solar_hijri_new_year(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION abos.solar_hijri_to_gregorian(integer, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION abos.dari_digits(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION abos.solar_hijri_new_year(integer), abos.solar_hijri_to_gregorian(integer, integer, integer),
  abos.dari_digits(text) TO abos_e1_finance_owner;
