-- V1 work package C: daily exchange rates with immutable per-transaction snapshots (#13), AFN on the
-- USD foundation (#12) and shareholder capital-request creation in the application (#15).
--
-- Owner decision 2026-09-25: "Base currency is USD; AFN is fully supported. The market/Saraf exchange
-- rate is entered daily by a permitted user, and every transaction keeps an immutable snapshot of the
-- rate it used."
--
-- What this migration decides, and what it deliberately does not:
--  * A rate is stored EXACTLY as entered (numeric, no typmod, no rounding), with both currency codes,
--    so the quote convention is explicit on every row: rate_value units of quote_currency_code per
--    ONE unit_currency_code (e.g. 71.254 AFN per 1 USD). It is never inverted or recomputed.
--  * Rates are append-only. A correction is a new row that supersedes exactly one current row, with a
--    reason; the superseded row stays. Snapshots taken before a correction keep the rate they used.
--  * Nothing is converted. There is no conversion arithmetic, no rounding rule, no precision policy,
--    no staleness window, no fallback rate, no gain/loss and no revaluation: all are open Finance
--    Manager decisions (OPEN_ITEMS.md, Multi-Currency). The posting engine (0007/0009) is unchanged
--    and still posts same-currency synthetic USD only; AFN is never posted to the USD ledger here.
--  * An AFN (non-base) shareholder capital request captures a snapshot of the current rate for its
--    business date. With no current rate for that date the request is REFUSED (fail closed): the
--    decision requires every transaction to keep the rate it used, and no fallback rate is invented.
--
-- Security model (0011): Finance entry points are owned by abos_e1_finance_owner. Shareholder entry
-- points are owned by a new least-privilege owner, abos_e1_shareholder_owner, because creating a
-- capital receipt intent writes shareholder source records and the commitment-usage row, which the
-- Finance owner may only lock (0011) and which Finance must not originate (Finance values; the
-- shareholder domain prepares sources). Runtime roles receive EXECUTE on entry points only.

-- ---------------------------------------------------------------------------
-- Least-privilege owner for the shareholder entry points.
-- ---------------------------------------------------------------------------
DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'abos_e1_shareholder_owner') THEN
    CREATE ROLE abos_e1_shareholder_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
  ELSE
    ALTER ROLE abos_e1_shareholder_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
  END IF;
  -- Roles are cluster-wide: a pre-existing membership would let a login SET ROLE to the owner.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m
               JOIN pg_catalog.pg_roles r ON r.oid = m.roleid
               JOIN pg_catalog.pg_roles x ON x.oid = m.member
              WHERE r.rolname = 'abos_e1_shareholder_owner' OR x.rolname = 'abos_e1_shareholder_owner') THEN
    RAISE EXCEPTION 'abos_e1_shareholder_owner has a membership; remove it before applying this migration';
  END IF;
END
$role$;

GRANT USAGE ON SCHEMA abos TO abos_e1_shareholder_owner;

-- ---------------------------------------------------------------------------
-- Permissions (catalogue version 3, work package C range 240-259).
-- ---------------------------------------------------------------------------
INSERT INTO abos.permission_catalogue
  (permission_code, catalogue_version, category, availability, independence_enforced, administrative, sort_order)
VALUES
  ('finance.exchange-rate.record',       3, 'FINANCE',     'ACTIVE', false, false, 240),
  ('shareholder.capital-request.create', 3, 'SHAREHOLDER', 'ACTIVE', false, false, 250),
  ('shareholder.read',                   3, 'SHAREHOLDER', 'ACTIVE', false, false, 251);

-- ---------------------------------------------------------------------------
-- Daily exchange rates: append-only, stored exactly as entered.
-- ---------------------------------------------------------------------------
CREATE TABLE abos.exchange_rates (
  id uuid PRIMARY KEY,
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  -- The business day the rate applies to, as entered. Time zone and cut-off are open decisions.
  rate_date date NOT NULL,
  rate_source text NOT NULL CHECK (rate_source IN ('MARKET', 'SARAF')),
  saraf_business_party_id uuid,
  -- rate_value units of quote_currency_code per ONE unit_currency_code.
  unit_currency_code text NOT NULL REFERENCES abos.currencies(code),
  quote_currency_code text NOT NULL REFERENCES abos.currencies(code),
  rate_value numeric NOT NULL CHECK (rate_value > 0),
  note text CHECK (note IS NULL OR (btrim(note) <> '' AND length(note) <= 500)),
  supersedes_exchange_rate_id uuid UNIQUE,
  correction_reason text CHECK (correction_reason IS NULL OR (btrim(correction_reason) <> '' AND length(correction_reason) <= 500)),
  entered_by_user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  entered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, legal_entity_id),
  FOREIGN KEY (saraf_business_party_id, legal_entity_id) REFERENCES abos.business_parties(id, legal_entity_id),
  FOREIGN KEY (supersedes_exchange_rate_id, legal_entity_id) REFERENCES abos.exchange_rates(id, legal_entity_id),
  CHECK (unit_currency_code <> quote_currency_code),
  CHECK (rate_source = 'SARAF' OR saraf_business_party_id IS NULL),
  CHECK ((supersedes_exchange_rate_id IS NULL) = (correction_reason IS NULL))
);

-- One original entry per day, source (market, or each Saraf) and currency pair in either direction.
-- Later changes are corrections, which chain one after another (supersedes_exchange_rate_id is unique),
-- so exactly one row of each chain is current: the one nobody supersedes.
CREATE UNIQUE INDEX exchange_rates_one_original_per_day
  ON abos.exchange_rates (legal_entity_id, rate_date, rate_source,
    coalesce(saraf_business_party_id, '00000000-0000-0000-0000-000000000000'::uuid),
    least(unit_currency_code, quote_currency_code), greatest(unit_currency_code, quote_currency_code))
  WHERE supersedes_exchange_rate_id IS NULL;
CREATE INDEX exchange_rates_entity_date_idx ON abos.exchange_rates (legal_entity_id, rate_date);

CREATE OR REPLACE FUNCTION abos.prevent_exchange_rate_mutation()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'exchange rates are append-only; record a correction instead'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER exchange_rates_no_update_or_delete
BEFORE UPDATE OR DELETE ON abos.exchange_rates
FOR EACH ROW EXECUTE FUNCTION abos.prevent_exchange_rate_mutation();

-- Whoever inserts: the time is the database's, a Saraf rate names a real Saraf, and a correction
-- keeps everything but the value of the row it supersedes.
CREATE OR REPLACE FUNCTION abos.guard_exchange_rate_insert()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  previous abos.exchange_rates%ROWTYPE;
BEGIN
  NEW.entered_at := clock_timestamp();
  IF NEW.saraf_business_party_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM abos.business_party_roles role
     WHERE role.business_party_id = NEW.saraf_business_party_id AND role.role_code = 'SARAF'
       AND role.effective_from <= NEW.rate_date
       AND (role.effective_to IS NULL OR role.effective_to >= NEW.rate_date)) THEN
    RAISE EXCEPTION 'the named Saraf does not hold a Saraf role on %', NEW.rate_date USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.supersedes_exchange_rate_id IS NOT NULL THEN
    SELECT * INTO previous FROM abos.exchange_rates
     WHERE id = NEW.supersedes_exchange_rate_id AND legal_entity_id = NEW.legal_entity_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'the corrected exchange rate does not exist in this legal entity' USING ERRCODE = 'check_violation';
    END IF;
    IF (previous.rate_date, previous.rate_source, previous.saraf_business_party_id, previous.unit_currency_code, previous.quote_currency_code)
       IS DISTINCT FROM (NEW.rate_date, NEW.rate_source, NEW.saraf_business_party_id, NEW.unit_currency_code, NEW.quote_currency_code) THEN
      RAISE EXCEPTION 'a correction changes only the rate value; date, source, Saraf and currencies stay the same'
        USING ERRCODE = 'check_violation';
    END IF;
    -- numeric equality ignores trailing zeros, so 71.2540 is not a correction of 71.254.
    IF previous.rate_value = NEW.rate_value THEN
      RAISE EXCEPTION 'the correction does not change the rate' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER exchange_rates_insert_guard
BEFORE INSERT ON abos.exchange_rates
FOR EACH ROW EXECUTE FUNCTION abos.guard_exchange_rate_insert();

-- ---------------------------------------------------------------------------
-- Immutable per-transaction rate snapshots.
-- ---------------------------------------------------------------------------
CREATE TABLE abos.exchange_rate_snapshots (
  id uuid PRIMARY KEY,
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  -- The transaction that used the rate. Only source types wired below are accepted.
  source_type text NOT NULL CHECK (source_type IN ('CAPITAL_RECEIPT_INTENT')),
  source_id uuid NOT NULL,
  transaction_currency_code text NOT NULL REFERENCES abos.currencies(code),
  base_currency_code text NOT NULL REFERENCES abos.currencies(code),
  -- The rate row it came from, and a copy of that row as it was.
  exchange_rate_id uuid NOT NULL,
  rate_date date NOT NULL,
  rate_source text NOT NULL CHECK (rate_source IN ('MARKET', 'SARAF')),
  saraf_business_party_id uuid,
  unit_currency_code text NOT NULL REFERENCES abos.currencies(code),
  quote_currency_code text NOT NULL REFERENCES abos.currencies(code),
  rate_value numeric NOT NULL CHECK (rate_value > 0),
  rate_entered_at timestamptz NOT NULL,
  captured_by_user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (source_type, source_id),
  FOREIGN KEY (exchange_rate_id, legal_entity_id) REFERENCES abos.exchange_rates(id, legal_entity_id),
  CHECK (transaction_currency_code <> base_currency_code),
  CHECK (ARRAY[unit_currency_code, quote_currency_code] @> ARRAY[transaction_currency_code, base_currency_code])
);
CREATE INDEX exchange_rate_snapshots_rate_idx ON abos.exchange_rate_snapshots (exchange_rate_id);

CREATE OR REPLACE FUNCTION abos.prevent_exchange_rate_snapshot_mutation()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'an exchange-rate snapshot is immutable' USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER exchange_rate_snapshots_no_update_or_delete
BEFORE UPDATE OR DELETE ON abos.exchange_rate_snapshots
FOR EACH ROW EXECUTE FUNCTION abos.prevent_exchange_rate_snapshot_mutation();

-- A snapshot is a faithful copy of the CURRENT rate row, taken for a real non-base transaction.
CREATE OR REPLACE FUNCTION abos.guard_exchange_rate_snapshot_insert()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  rate abos.exchange_rates%ROWTYPE;
  entity_base text;
BEGIN
  NEW.captured_at := clock_timestamp();
  SELECT base_currency_code INTO entity_base FROM abos.legal_entities WHERE id = NEW.legal_entity_id;
  IF entity_base IS DISTINCT FROM NEW.base_currency_code THEN
    RAISE EXCEPTION 'a snapshot must name the legal entity''s base currency' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO rate FROM abos.exchange_rates WHERE id = NEW.exchange_rate_id AND legal_entity_id = NEW.legal_entity_id;
  IF NOT FOUND
     OR (rate.rate_date, rate.rate_source, rate.saraf_business_party_id, rate.unit_currency_code,
         rate.quote_currency_code, rate.entered_at)
        IS DISTINCT FROM (NEW.rate_date, NEW.rate_source, NEW.saraf_business_party_id, NEW.unit_currency_code,
         NEW.quote_currency_code, NEW.rate_entered_at)
     -- Compared as text, so even the scale is copied exactly (71.2540 stays 71.2540).
     OR rate.rate_value::text <> NEW.rate_value::text THEN
    RAISE EXCEPTION 'a snapshot must copy its exchange rate exactly' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM abos.exchange_rates c WHERE c.supersedes_exchange_rate_id = rate.id) THEN
    RAISE EXCEPTION 'a superseded exchange rate cannot be snapshotted' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.source_type = 'CAPITAL_RECEIPT_INTENT' AND NOT EXISTS (
    SELECT 1 FROM abos.capital_receipt_intents i
     WHERE i.id = NEW.source_id AND i.legal_entity_id = NEW.legal_entity_id
       AND i.currency_code = NEW.transaction_currency_code) THEN
    RAISE EXCEPTION 'the snapshot source transaction does not exist in this currency' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER exchange_rate_snapshots_insert_guard
BEFORE INSERT ON abos.exchange_rate_snapshots
FOR EACH ROW EXECUTE FUNCTION abos.guard_exchange_rate_snapshot_insert();

-- ---------------------------------------------------------------------------
-- Snapshot capture: an internal helper, not a runtime entry point. It is called only from entry
-- points that create a non-base-currency transaction, runs with that entry point's owner's
-- privileges, and is executable only by the owners that wire it.
--
-- Which rate: the CURRENT (uncorrected) rate for the transaction's business date and the pair
-- {base, transaction currency}, in whichever direction it was entered, copied as entered.
--  * none for that date  -> refused (no_data_found). No other day's rate and no fallback is used.
--  * several (market and one or more Saraf) -> refused (too_many_rows) unless the caller names one;
--    which source a transaction type must use is an open Finance Manager decision.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION abos.capture_exchange_rate_snapshot(
  p_legal_entity_id uuid,
  p_source_type text,
  p_source_id uuid,
  p_transaction_currency text,
  p_rate_date date,
  p_exchange_rate_id uuid,
  p_actor uuid
) RETURNS uuid
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $capture$
DECLARE
  base text;
  chosen abos.exchange_rates%ROWTYPE;
  candidates integer;
  snapshot_id uuid := gen_random_uuid();
BEGIN
  SELECT base_currency_code INTO base FROM abos.legal_entities WHERE id = p_legal_entity_id;
  IF base IS NULL THEN
    RAISE EXCEPTION 'the legal entity has no base currency' USING ERRCODE = 'check_violation';
  END IF;
  IF p_transaction_currency IS NULL OR p_transaction_currency = base THEN
    RAISE EXCEPTION 'a base-currency transaction takes no exchange-rate snapshot' USING ERRCODE = 'check_violation';
  END IF;
  IF p_rate_date IS NULL THEN
    RAISE EXCEPTION 'the transaction''s business date is required to choose its exchange rate' USING ERRCODE = 'check_violation';
  END IF;

  SELECT count(*) INTO candidates
    FROM abos.exchange_rates r
   WHERE r.legal_entity_id = p_legal_entity_id AND r.rate_date = p_rate_date
     AND least(r.unit_currency_code, r.quote_currency_code) = least(base, p_transaction_currency)
     AND greatest(r.unit_currency_code, r.quote_currency_code) = greatest(base, p_transaction_currency)
     AND NOT EXISTS (SELECT 1 FROM abos.exchange_rates c WHERE c.supersedes_exchange_rate_id = r.id);

  IF p_exchange_rate_id IS NOT NULL THEN
    SELECT r.* INTO chosen
      FROM abos.exchange_rates r
     WHERE r.id = p_exchange_rate_id AND r.legal_entity_id = p_legal_entity_id AND r.rate_date = p_rate_date
       AND least(r.unit_currency_code, r.quote_currency_code) = least(base, p_transaction_currency)
       AND greatest(r.unit_currency_code, r.quote_currency_code) = greatest(base, p_transaction_currency)
       AND NOT EXISTS (SELECT 1 FROM abos.exchange_rates c WHERE c.supersedes_exchange_rate_id = r.id);
    IF NOT FOUND THEN
      RAISE EXCEPTION 'the chosen exchange rate is not a current %/% rate for %', base, p_transaction_currency, p_rate_date
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF candidates = 0 THEN
    RAISE EXCEPTION 'no %/% exchange rate is recorded for %; a permitted Finance user must record that day''s rate first (no other day''s rate is used)',
      base, p_transaction_currency, p_rate_date USING ERRCODE = 'no_data_found';
  ELSIF candidates > 1 THEN
    RAISE EXCEPTION '% current %/% rates are recorded for %; choose which rate this transaction uses',
      candidates, base, p_transaction_currency, p_rate_date USING ERRCODE = 'too_many_rows';
  ELSE
    SELECT r.* INTO chosen
      FROM abos.exchange_rates r
     WHERE r.legal_entity_id = p_legal_entity_id AND r.rate_date = p_rate_date
       AND least(r.unit_currency_code, r.quote_currency_code) = least(base, p_transaction_currency)
       AND greatest(r.unit_currency_code, r.quote_currency_code) = greatest(base, p_transaction_currency)
       AND NOT EXISTS (SELECT 1 FROM abos.exchange_rates c WHERE c.supersedes_exchange_rate_id = r.id);
  END IF;

  INSERT INTO abos.exchange_rate_snapshots
    (id, legal_entity_id, source_type, source_id, transaction_currency_code, base_currency_code,
     exchange_rate_id, rate_date, rate_source, saraf_business_party_id, unit_currency_code,
     quote_currency_code, rate_value, rate_entered_at, captured_by_user_account_id)
  VALUES
    (snapshot_id, p_legal_entity_id, p_source_type, p_source_id, p_transaction_currency, base,
     chosen.id, chosen.rate_date, chosen.rate_source, chosen.saraf_business_party_id, chosen.unit_currency_code,
     chosen.quote_currency_code, chosen.rate_value, chosen.entered_at, p_actor);
  RETURN snapshot_id;
END
$capture$;

-- ---------------------------------------------------------------------------
-- Shareholder authorizer: the exact pattern of abos.finance_runtime_authorize (0013), for ACTIVE
-- permissions of category SHAREHOLDER. The Treasury and Finance authorizers cover only their own
-- categories, so this is the first entry point that can check a SHAREHOLDER permission.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION abos.shareholder_runtime_authorize(p_bearer_token text, p_permission text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $authorize_shareholder$
DECLARE
  session_row record;
  gate_row record;
BEGIN
  IF p_bearer_token IS NULL OR pg_catalog.length(p_bearer_token) < 32 THEN
    RAISE EXCEPTION 'valid sandbox bearer credential required'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM abos.permission_catalogue catalogue
                  WHERE catalogue.permission_code = p_permission
                    AND catalogue.category = 'SHAREHOLDER' AND catalogue.availability = 'ACTIVE') THEN
    RAISE EXCEPTION 'unsupported Shareholder permission'
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
    RAISE EXCEPTION 'synthetic Shareholder sandbox authorization is not active'
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
    RAISE EXCEPTION 'current Shareholder authority is missing %', p_permission
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  PERFORM pg_catalog.set_config('abos.actor_user_account_id', session_row.user_account_id::text, true);
  PERFORM pg_catalog.set_config('abos.shareholder_legal_entity_id', session_row.legal_entity_id::text, true);
  PERFORM pg_catalog.set_config('abos.runtime_marker', gate_row.runtime_marker, true);
  RETURN session_row.user_account_id;
END
$authorize_shareholder$;

-- ---------------------------------------------------------------------------
-- Finance entry points: exchange rates.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION abos.finance_exchange_rates_view(p_bearer_token text, p_from date, p_to date)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $rates_view$
DECLARE
  actor uuid;
  entity uuid;
  can_record boolean := true;
  range_to date;
  range_from date;
BEGIN
  BEGIN
    actor := abos.finance_runtime_authorize(p_bearer_token, 'finance.exchange-rate.record');
  EXCEPTION WHEN insufficient_privilege THEN
    actor := abos.finance_runtime_authorize(p_bearer_token, 'finance.report.operational.read');
    can_record := false;
  END;
  entity := current_setting('abos.finance_legal_entity_id')::uuid;
  range_to := coalesce(p_to, current_date + 1);
  range_from := coalesce(p_from, range_to - 45);
  IF range_from > range_to OR range_to - range_from > 400 THEN
    RAISE EXCEPTION 'choose a date range of at most 400 days' USING ERRCODE = 'check_violation';
  END IF;
  RETURN jsonb_build_object(
    'canRecord', can_record,
    'today', current_date,
    'range', jsonb_build_object('from', range_from, 'to', range_to),
    'legalEntity', (SELECT jsonb_build_object('id', e.id, 'name', e.name, 'baseCurrency', e.base_currency_code)
                      FROM abos.legal_entities e WHERE e.id = entity),
    'currencies', coalesce((SELECT jsonb_agg(c.code ORDER BY c.code) FROM abos.currencies c WHERE c.enabled), '[]'::jsonb),
    'sarafParties', coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', bp.id, 'name', bp.display_name) ORDER BY bp.display_name)
        FROM abos.business_parties bp
       WHERE bp.legal_entity_id = entity
         AND EXISTS (SELECT 1 FROM abos.business_party_roles role
                      WHERE role.business_party_id = bp.id AND role.role_code = 'SARAF'
                        AND role.effective_from <= current_date
                        AND (role.effective_to IS NULL OR role.effective_to >= current_date))), '[]'::jsonb),
    'rates', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'id', r.id, 'rateDate', r.rate_date, 'source', r.rate_source,
               'sarafPartyId', r.saraf_business_party_id, 'sarafName', bp.display_name,
               'unitCurrency', r.unit_currency_code, 'quoteCurrency', r.quote_currency_code,
               -- As text: the value exactly as entered, never a JavaScript number.
               'rate', r.rate_value::text, 'note', r.note,
               'supersedesId', r.supersedes_exchange_rate_id, 'correctionReason', r.correction_reason,
               'supersededById', (SELECT c.id FROM abos.exchange_rates c WHERE c.supersedes_exchange_rate_id = r.id),
               'current', NOT EXISTS (SELECT 1 FROM abos.exchange_rates c WHERE c.supersedes_exchange_rate_id = r.id),
               'enteredBy', u.display_name, 'enteredAt', r.entered_at,
               'snapshotCount', (SELECT count(*) FROM abos.exchange_rate_snapshots s WHERE s.exchange_rate_id = r.id))
             ORDER BY r.rate_date DESC, r.entered_at DESC)
        FROM abos.exchange_rates r
        LEFT JOIN abos.business_parties bp ON bp.id = r.saraf_business_party_id AND bp.legal_entity_id = r.legal_entity_id
        LEFT JOIN abos.user_accounts u ON u.id = r.entered_by_user_account_id
       WHERE r.legal_entity_id = entity AND r.rate_date BETWEEN range_from AND range_to), '[]'::jsonb));
END;
$rates_view$;

CREATE OR REPLACE FUNCTION abos.finance_record_exchange_rate(
  p_bearer_token text,
  p_rate_date date,
  p_source text,
  p_saraf_business_party_id uuid,
  p_unit_currency text,
  p_quote_currency text,
  p_rate text,
  p_note text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $record_rate$
DECLARE
  actor uuid;
  entity uuid;
  base text;
  rate_id uuid := gen_random_uuid();
  value numeric;
  clean_note text := nullif(btrim(coalesce(p_note, '')), '');
BEGIN
  actor := abos.finance_runtime_authorize(p_bearer_token, 'finance.exchange-rate.record');
  entity := current_setting('abos.finance_legal_entity_id')::uuid;
  SELECT base_currency_code INTO base FROM abos.legal_entities WHERE id = entity;
  IF base IS NULL THEN
    RAISE EXCEPTION 'the legal entity has no base currency' USING ERRCODE = 'check_violation';
  END IF;
  IF p_rate_date IS NULL THEN
    RAISE EXCEPTION 'the rate date is required' USING ERRCODE = 'check_violation';
  END IF;
  -- A daily rate is entered for a day that has begun somewhere: one day of slack for the server's
  -- UTC clock. This is not a staleness rule; how old a rate may be is an open decision.
  IF p_rate_date > current_date + 1 THEN
    RAISE EXCEPTION 'a rate cannot be recorded for a future date' USING ERRCODE = 'check_violation';
  END IF;
  IF p_source IS NULL OR p_source NOT IN ('MARKET', 'SARAF') THEN
    RAISE EXCEPTION 'the rate source must be MARKET or SARAF' USING ERRCODE = 'check_violation';
  END IF;
  IF p_source = 'MARKET' AND p_saraf_business_party_id IS NOT NULL THEN
    RAISE EXCEPTION 'a market rate does not name a Saraf' USING ERRCODE = 'check_violation';
  END IF;
  IF p_saraf_business_party_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM abos.business_parties bp WHERE bp.id = p_saraf_business_party_id AND bp.legal_entity_id = entity) THEN
    RAISE EXCEPTION 'the Saraf was not found in this legal entity' USING ERRCODE = 'check_violation';
  END IF;
  IF p_unit_currency IS NULL OR p_quote_currency IS NULL OR p_unit_currency = p_quote_currency
     OR NOT EXISTS (SELECT 1 FROM abos.currencies c WHERE c.code = p_unit_currency AND c.enabled)
     OR NOT EXISTS (SELECT 1 FROM abos.currencies c WHERE c.code = p_quote_currency AND c.enabled) THEN
    RAISE EXCEPTION 'choose two different enabled currencies' USING ERRCODE = 'check_violation';
  END IF;
  IF base NOT IN (p_unit_currency, p_quote_currency) THEN
    RAISE EXCEPTION 'a rate is recorded against the base currency %', base USING ERRCODE = 'check_violation';
  END IF;
  -- Exactly as entered: a plain positive decimal. No rounding and no precision is imposed.
  IF p_rate IS NULL OR length(p_rate) > 40 OR p_rate !~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$' THEN
    RAISE EXCEPTION 'the rate must be a plain decimal number such as 71.254' USING ERRCODE = 'check_violation';
  END IF;
  value := p_rate::numeric;
  IF value <= 0 THEN
    RAISE EXCEPTION 'the rate must be greater than zero' USING ERRCODE = 'check_violation';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('abos-exchange-rate:' || entity::text || ':' || p_rate_date::text || ':' || p_source
    || ':' || coalesce(p_saraf_business_party_id::text, '-') || ':' || least(p_unit_currency, p_quote_currency)
    || greatest(p_unit_currency, p_quote_currency), 0));
  IF EXISTS (
    SELECT 1 FROM abos.exchange_rates r
     WHERE r.legal_entity_id = entity AND r.rate_date = p_rate_date AND r.rate_source = p_source
       AND r.saraf_business_party_id IS NOT DISTINCT FROM p_saraf_business_party_id
       AND least(r.unit_currency_code, r.quote_currency_code) = least(p_unit_currency, p_quote_currency)
       AND greatest(r.unit_currency_code, r.quote_currency_code) = greatest(p_unit_currency, p_quote_currency)) THEN
    RAISE EXCEPTION 'a rate is already recorded for this day, source and currencies; record a correction instead'
      USING ERRCODE = 'unique_violation';
  END IF;

  INSERT INTO abos.exchange_rates
    (id, legal_entity_id, rate_date, rate_source, saraf_business_party_id, unit_currency_code,
     quote_currency_code, rate_value, note, entered_by_user_account_id)
  VALUES (rate_id, entity, p_rate_date, p_source, p_saraf_business_party_id, p_unit_currency,
          p_quote_currency, value, clean_note, actor);

  INSERT INTO abos.audit_records (id, actor_user_account_id, legal_entity_id, correlation_id, action, entity_type, entity_id, after_state, metadata)
  VALUES (gen_random_uuid(), actor, entity, gen_random_uuid(), 'EXCHANGE_RATE_RECORDED', 'EXCHANGE_RATE', rate_id,
          jsonb_build_object('rateDate', p_rate_date, 'source', p_source, 'sarafBusinessPartyId', p_saraf_business_party_id,
            'unitCurrency', p_unit_currency, 'quoteCurrency', p_quote_currency, 'rate', value::text, 'note', clean_note),
          jsonb_build_object('source', 'finance_record_exchange_rate'));
  RETURN rate_id;
END;
$record_rate$;

-- A correction supersedes the current rate with a new value and a reason. Whether a correction needs
-- an independent approval is an open Finance Manager decision; until then the corrector must hold the
-- same permission, give a reason, and is recorded with the correction.
CREATE OR REPLACE FUNCTION abos.finance_correct_exchange_rate(
  p_bearer_token text,
  p_exchange_rate_id uuid,
  p_rate text,
  p_reason text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $correct_rate$
DECLARE
  actor uuid;
  entity uuid;
  previous abos.exchange_rates%ROWTYPE;
  rate_id uuid := gen_random_uuid();
  value numeric;
  clean_reason text := nullif(btrim(coalesce(p_reason, '')), '');
BEGIN
  actor := abos.finance_runtime_authorize(p_bearer_token, 'finance.exchange-rate.record');
  entity := current_setting('abos.finance_legal_entity_id')::uuid;
  SELECT * INTO previous FROM abos.exchange_rates WHERE id = p_exchange_rate_id AND legal_entity_id = entity;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the exchange rate was not found' USING ERRCODE = 'check_violation';
  END IF;
  IF clean_reason IS NULL OR length(clean_reason) > 500 THEN
    RAISE EXCEPTION 'a correction needs a reason (at most 500 characters)' USING ERRCODE = 'check_violation';
  END IF;
  IF p_rate IS NULL OR length(p_rate) > 40 OR p_rate !~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$' THEN
    RAISE EXCEPTION 'the rate must be a plain decimal number such as 71.254' USING ERRCODE = 'check_violation';
  END IF;
  value := p_rate::numeric;
  IF value <= 0 THEN
    RAISE EXCEPTION 'the rate must be greater than zero' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('abos-exchange-rate:' || entity::text || ':' || previous.rate_date::text || ':' || previous.rate_source
    || ':' || coalesce(previous.saraf_business_party_id::text, '-') || ':' || least(previous.unit_currency_code, previous.quote_currency_code)
    || greatest(previous.unit_currency_code, previous.quote_currency_code), 0));
  IF EXISTS (SELECT 1 FROM abos.exchange_rates c WHERE c.supersedes_exchange_rate_id = previous.id) THEN
    RAISE EXCEPTION 'this rate has already been corrected; correct the current rate instead' USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO abos.exchange_rates
    (id, legal_entity_id, rate_date, rate_source, saraf_business_party_id, unit_currency_code,
     quote_currency_code, rate_value, note, supersedes_exchange_rate_id, correction_reason, entered_by_user_account_id)
  VALUES (rate_id, entity, previous.rate_date, previous.rate_source, previous.saraf_business_party_id,
          previous.unit_currency_code, previous.quote_currency_code, value, previous.note, previous.id, clean_reason, actor);

  INSERT INTO abos.audit_records (id, actor_user_account_id, legal_entity_id, correlation_id, action, entity_type, entity_id, before_state, after_state, metadata)
  VALUES (gen_random_uuid(), actor, entity, gen_random_uuid(), 'EXCHANGE_RATE_CORRECTED', 'EXCHANGE_RATE', rate_id,
          jsonb_build_object('exchangeRateId', previous.id, 'rate', previous.rate_value::text, 'enteredBy', previous.entered_by_user_account_id),
          jsonb_build_object('exchangeRateId', rate_id, 'rate', value::text, 'reason', clean_reason,
            'snapshotsKeepPreviousRate', (SELECT count(*) FROM abos.exchange_rate_snapshots s WHERE s.exchange_rate_id = previous.id)),
          jsonb_build_object('source', 'finance_correct_exchange_rate'));
  RETURN rate_id;
END;
$correct_rate$;

-- ---------------------------------------------------------------------------
-- Shareholder entry points: capital requests (capital receipt intents) in the application.
-- The rules are those of CapitalReceiptIntentService (packages/shareholder) and the existing
-- triggers, which still run on every insert: the funding policy (F-1), the commitment ceiling and
-- partial-installment rule (F-4, 0003), one intent per installment, idempotency and the sandbox gate.
-- USD and AFN are both accepted; each request stays in its installment's own currency.
-- Classification stays as the domain service sets it: capital vs loan per transaction (#14) is Phase 2.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION abos.shareholder_capital_workspace(p_bearer_token text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $workspace$
DECLARE
  actor uuid;
  entity uuid;
  can_create boolean := true;
  base text;
BEGIN
  BEGIN
    actor := abos.shareholder_runtime_authorize(p_bearer_token, 'shareholder.capital-request.create');
  EXCEPTION WHEN insufficient_privilege THEN
    actor := abos.shareholder_runtime_authorize(p_bearer_token, 'shareholder.read');
    can_create := false;
  END;
  entity := current_setting('abos.shareholder_legal_entity_id')::uuid;
  SELECT base_currency_code INTO base FROM abos.legal_entities WHERE id = entity;
  RETURN jsonb_build_object(
    'canCreate', can_create,
    'today', current_date,
    'legalEntity', (SELECT jsonb_build_object('id', e.id, 'name', e.name, 'baseCurrency', e.base_currency_code)
                      FROM abos.legal_entities e WHERE e.id = entity),
    'fundingPolicy', (SELECT jsonb_build_object('decisionReference', p.decision_reference, 'decidedBy', p.decided_by,
                              'fundableStatuses', to_jsonb(p.fundable_statuses))
                        FROM abos.capital_agreement_funding_policies p WHERE p.legal_entity_id = entity),
    'agreements', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'id', ca.id, 'reference', ca.agreement_reference, 'shareholder', bp.display_name,
               'shareholderStatus', sp.status, 'kind', ca.agreement_kind, 'currency', ca.currency_code,
               'committedAmount', ca.committed_amount::text, 'consumedAmount', coalesce(usage.consumed_amount, 0)::text,
               'remainingAmount', (ca.committed_amount - coalesce(usage.consumed_amount, 0))::text,
               'status', ca.status, 'partialAllowed', ca.partial_installments_allowed,
               'fundable', EXISTS (SELECT 1 FROM abos.capital_agreement_funding_policies p
                                    WHERE p.legal_entity_id = entity AND ca.status = ANY (p.fundable_statuses)),
               'registrationVerified', EXISTS (
                 SELECT 1 FROM abos.registration_evidence re
                   JOIN abos.evidence_references er ON er.id = re.evidence_reference_id AND er.legal_entity_id = re.legal_entity_id
                  WHERE re.capital_agreement_id = ca.id AND re.legal_entity_id = entity
                    AND re.status = 'VERIFIED' AND er.evidence_kind = 'FORMAL_REGISTRATION'),
               'installments', coalesce((
                 SELECT jsonb_agg(jsonb_build_object(
                          'id', ci.id, 'sequence', ci.sequence_number, 'expectedAmount', ci.expected_amount::text,
                          'currency', ci.currency_code, 'dueOn', ci.due_on, 'status', ci.status,
                          'request', (
                            SELECT jsonb_build_object(
                                     'id', cri.id, 'status', cri.status, 'amount', cri.amount::text, 'currency', cri.currency_code,
                                     'businessDate', (cri.business_event_at AT TIME ZONE 'UTC')::date,
                                     'createdAt', cri.created_at, 'createdBy', creator.display_name,
                                     'destination', loc.location_name || ' · ' || acct.currency_code,
                                     'snapshot', (SELECT jsonb_build_object(
                                                     'id', snap.id, 'rateDate', snap.rate_date, 'source', snap.rate_source,
                                                     'sarafName', saraf.display_name, 'unitCurrency', snap.unit_currency_code,
                                                     'quoteCurrency', snap.quote_currency_code, 'rate', snap.rate_value::text,
                                                     'capturedAt', snap.captured_at)
                                                    FROM abos.exchange_rate_snapshots snap
                                                    LEFT JOIN abos.business_parties saraf
                                                      ON saraf.id = snap.saraf_business_party_id AND saraf.legal_entity_id = snap.legal_entity_id
                                                   WHERE snap.source_type = 'CAPITAL_RECEIPT_INTENT' AND snap.source_id = cri.id))
                              FROM abos.capital_receipt_intents cri
                              JOIN abos.user_accounts creator ON creator.id = cri.created_by_user_account_id
                              JOIN abos.cash_location_currency_accounts acct
                                ON acct.id = cri.destination_cash_account_id AND acct.legal_entity_id = cri.legal_entity_id
                              JOIN abos.cash_locations loc ON loc.id = acct.cash_location_id AND loc.legal_entity_id = acct.legal_entity_id
                             WHERE cri.capital_installment_id = ci.id AND cri.legal_entity_id = entity),
                          'blockers', to_jsonb(array_remove(ARRAY[
                            CASE WHEN EXISTS (SELECT 1 FROM abos.capital_receipt_intents x
                                               WHERE x.capital_installment_id = ci.id AND x.legal_entity_id = entity) THEN 'HAS_REQUEST' END,
                            CASE WHEN ci.status NOT IN ('DRAFT', 'PENDING_RECEIPT') THEN 'INSTALLMENT_CLOSED' END,
                            CASE WHEN ca.agreement_kind <> 'CAPITAL_CONTRIBUTION' THEN 'LOAN_AGREEMENT' END,
                            CASE WHEN sp.status <> 'ACTIVE' THEN 'SHAREHOLDER_NOT_ACTIVE' END,
                            CASE WHEN NOT EXISTS (SELECT 1 FROM abos.capital_agreement_funding_policies p
                                                   WHERE p.legal_entity_id = entity AND ca.status = ANY (p.fundable_statuses))
                                 THEN 'AGREEMENT_NOT_FUNDABLE' END,
                            CASE WHEN NOT EXISTS (
                                   SELECT 1 FROM abos.registration_evidence re
                                     JOIN abos.evidence_references er ON er.id = re.evidence_reference_id AND er.legal_entity_id = re.legal_entity_id
                                    WHERE re.capital_agreement_id = ca.id AND re.legal_entity_id = entity
                                      AND re.status = 'VERIFIED' AND er.evidence_kind = 'FORMAL_REGISTRATION')
                                 THEN 'REGISTRATION_NOT_VERIFIED' END,
                            CASE WHEN ca.committed_amount - coalesce(usage.consumed_amount, 0) <= 0 THEN 'COMMITMENT_USED' END,
                            CASE WHEN NOT EXISTS (
                                   SELECT 1 FROM abos.cash_location_currency_accounts a
                                     JOIN abos.cash_locations l ON l.id = a.cash_location_id AND l.legal_entity_id = a.legal_entity_id
                                    WHERE a.legal_entity_id = entity AND a.currency_code = ci.currency_code
                                      AND a.activation_status = 'ACTIVE' AND l.status = 'ACTIVE')
                                 THEN 'NO_ACTIVE_ACCOUNT' END], NULL)))
                        ORDER BY ci.sequence_number)
                   FROM abos.capital_installments ci
                  WHERE ci.capital_agreement_id = ca.id AND ci.legal_entity_id = entity), '[]'::jsonb))
             ORDER BY ca.currency_code, ca.agreement_reference)
        FROM abos.capital_agreements ca
        JOIN abos.shareholder_profiles sp ON sp.id = ca.shareholder_profile_id AND sp.legal_entity_id = ca.legal_entity_id
        JOIN abos.business_parties bp ON bp.id = sp.business_party_id AND bp.legal_entity_id = sp.legal_entity_id
        LEFT JOIN abos.capital_agreement_commitment_usage usage
          ON usage.capital_agreement_id = ca.id AND usage.legal_entity_id = ca.legal_entity_id
       WHERE ca.legal_entity_id = entity), '[]'::jsonb),
    -- Per currency, never summed across currencies and never converted.
    'totalsByCurrency', coalesce((
      SELECT jsonb_agg(jsonb_build_object('currency', t.currency_code, 'committed', t.committed::text,
                                          'requested', t.requested::text, 'agreements', t.agreements) ORDER BY t.currency_code)
        FROM (SELECT ca.currency_code, sum(ca.committed_amount) AS committed,
                     sum(coalesce(usage.consumed_amount, 0)) AS requested, count(*) AS agreements
                FROM abos.capital_agreements ca
                LEFT JOIN abos.capital_agreement_commitment_usage usage
                  ON usage.capital_agreement_id = ca.id AND usage.legal_entity_id = ca.legal_entity_id
               WHERE ca.legal_entity_id = entity AND ca.agreement_kind = 'CAPITAL_CONTRIBUTION'
               GROUP BY ca.currency_code) t), '[]'::jsonb),
    'destinationAccounts', coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', a.id, 'safe', l.location_name, 'currency', a.currency_code,
                                          'status', a.activation_status, 'safeStatus', l.status,
                                          'usable', a.activation_status = 'ACTIVE' AND l.status = 'ACTIVE')
                       ORDER BY l.location_name, a.currency_code)
        FROM abos.cash_location_currency_accounts a
        JOIN abos.cash_locations l ON l.id = a.cash_location_id AND l.legal_entity_id = a.legal_entity_id
       WHERE a.legal_entity_id = entity), '[]'::jsonb),
    -- Current (uncorrected) rates against the base currency, so a request can show which rate its
    -- business date would snapshot. Read-only here; recording rates is a Finance permission.
    'currentRates', coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', r.id, 'rateDate', r.rate_date, 'source', r.rate_source,
                                          'sarafName', saraf.display_name, 'unitCurrency', r.unit_currency_code,
                                          'quoteCurrency', r.quote_currency_code, 'rate', r.rate_value::text)
                       ORDER BY r.rate_date DESC, r.rate_source, saraf.display_name)
        FROM abos.exchange_rates r
        LEFT JOIN abos.business_parties saraf ON saraf.id = r.saraf_business_party_id AND saraf.legal_entity_id = r.legal_entity_id
       WHERE r.legal_entity_id = entity AND base IN (r.unit_currency_code, r.quote_currency_code)
         AND r.rate_date BETWEEN current_date - 60 AND current_date + 1
         AND NOT EXISTS (SELECT 1 FROM abos.exchange_rates c WHERE c.supersedes_exchange_rate_id = r.id)), '[]'::jsonb));
END;
$workspace$;

CREATE OR REPLACE FUNCTION abos.shareholder_create_capital_request(
  p_bearer_token text,
  p_installment_id uuid,
  p_destination_cash_account_id uuid,
  p_amount text,
  p_business_date date,
  p_exchange_rate_id uuid,
  p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $create_request$
DECLARE
  actor uuid;
  entity uuid;
  base text;
  installment abos.capital_installments%ROWTYPE;
  agreement abos.capital_agreements%ROWTYPE;
  profile abos.shareholder_profiles%ROWTYPE;
  registration_evidence_id uuid;
  destination record;
  amount numeric;
  consumed numeric;
  fingerprint text;
  existing record;
  intent_id uuid := gen_random_uuid();
  snapshot_id uuid;
BEGIN
  actor := abos.shareholder_runtime_authorize(p_bearer_token, 'shareholder.capital-request.create');
  entity := current_setting('abos.shareholder_legal_entity_id')::uuid;
  SELECT base_currency_code INTO base FROM abos.legal_entities WHERE id = entity;
  IF base IS NULL THEN
    RAISE EXCEPTION 'the legal entity has no base currency' USING ERRCODE = 'check_violation';
  END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' OR length(p_idempotency_key) > 200 THEN
    RAISE EXCEPTION 'a stable idempotency key is required for the request' USING ERRCODE = 'check_violation';
  END IF;
  IF p_amount IS NULL OR length(p_amount) > 40 OR p_amount !~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$' THEN
    RAISE EXCEPTION 'the amount must be a plain decimal number' USING ERRCODE = 'check_violation';
  END IF;
  amount := p_amount::numeric;
  IF amount <= 0 THEN
    RAISE EXCEPTION 'the amount must be greater than zero' USING ERRCODE = 'check_violation';
  END IF;
  IF p_business_date IS NULL THEN
    RAISE EXCEPTION 'the business date of the request is required' USING ERRCODE = 'check_violation';
  END IF;
  IF p_business_date > current_date + 1 THEN
    RAISE EXCEPTION 'a request cannot be dated in the future' USING ERRCODE = 'check_violation';
  END IF;

  -- Idempotency: the same key and the same request return the first result; a different request
  -- under the same key is refused. Serialized per key and per installment.
  fingerprint := encode(sha256(convert_to(jsonb_build_object(
    'installment', p_installment_id, 'destination', p_destination_cash_account_id, 'amount', trim_scale(amount)::text,
    'businessDate', p_business_date, 'exchangeRate', p_exchange_rate_id)::text, 'UTF8')), 'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended('abos-capital-request-key:' || entity::text || ':' || p_idempotency_key, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('abos-capital-request-installment:' || coalesce(p_installment_id::text, '-'), 0));
  SELECT cri.id, cri.request_fingerprint INTO existing
    FROM abos.capital_receipt_intents cri
   WHERE cri.legal_entity_id = entity AND cri.idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF existing.request_fingerprint <> fingerprint THEN
      RAISE EXCEPTION 'this request key was already used for a different request' USING ERRCODE = 'unique_violation';
    END IF;
    RETURN jsonb_build_object('id', existing.id, 'replayed', true,
      'snapshotId', (SELECT s.id FROM abos.exchange_rate_snapshots s
                      WHERE s.source_type = 'CAPITAL_RECEIPT_INTENT' AND s.source_id = existing.id));
  END IF;

  SELECT * INTO installment FROM abos.capital_installments WHERE id = p_installment_id AND legal_entity_id = entity;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the capital installment was not found' USING ERRCODE = 'check_violation';
  END IF;
  IF installment.status NOT IN ('DRAFT', 'PENDING_RECEIPT') THEN
    RAISE EXCEPTION 'installment % is % and cannot take a new capital request', installment.sequence_number, installment.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM abos.capital_receipt_intents WHERE legal_entity_id = entity AND capital_installment_id = installment.id) THEN
    RAISE EXCEPTION 'this installment already has a capital request' USING ERRCODE = 'unique_violation';
  END IF;
  SELECT * INTO agreement FROM abos.capital_agreements WHERE id = installment.capital_agreement_id AND legal_entity_id = entity;
  IF agreement.agreement_kind <> 'CAPITAL_CONTRIBUTION' THEN
    RAISE EXCEPTION 'a shareholder loan agreement cannot fund a capital contribution' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO profile FROM abos.shareholder_profiles WHERE id = agreement.shareholder_profile_id AND legal_entity_id = entity;
  IF profile.status IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'the shareholder profile is not active' USING ERRCODE = 'check_violation';
  END IF;
  -- F-1: fundability comes from the recorded decision, never from the status name.
  IF NOT EXISTS (SELECT 1 FROM abos.capital_agreement_funding_policies p
                  WHERE p.legal_entity_id = entity AND agreement.status = ANY (p.fundable_statuses)) THEN
    RAISE EXCEPTION 'capital agreement % is % and is not fundable under the recorded funding decision',
      agreement.agreement_reference, agreement.status USING ERRCODE = 'check_violation';
  END IF;
  SELECT re.evidence_reference_id INTO registration_evidence_id
    FROM abos.registration_evidence re
    JOIN abos.evidence_references er ON er.id = re.evidence_reference_id AND er.legal_entity_id = re.legal_entity_id
   WHERE re.capital_agreement_id = agreement.id AND re.legal_entity_id = entity
     AND re.status = 'VERIFIED' AND er.evidence_kind = 'FORMAL_REGISTRATION'
   ORDER BY re.verified_at DESC, re.created_at DESC
   LIMIT 1;
  IF registration_evidence_id IS NULL THEN
    RAISE EXCEPTION 'verified formal capital-registration evidence is required before a capital request'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM abos.evidence_references er
                  WHERE er.legal_entity_id = entity AND er.evidence_kind = 'CAPITAL_AGREEMENT') THEN
    RAISE EXCEPTION 'a controlled CAPITAL_AGREEMENT document is required' USING ERRCODE = 'check_violation';
  END IF;
  IF installment.currency_code <> agreement.currency_code
     OR NOT EXISTS (SELECT 1 FROM abos.currencies c WHERE c.code = installment.currency_code AND c.enabled) THEN
    RAISE EXCEPTION 'the installment currency is not an enabled agreement currency' USING ERRCODE = 'check_violation';
  END IF;

  SELECT a.id, a.currency_code, a.activation_status, l.status AS location_status, l.location_name INTO destination
    FROM abos.cash_location_currency_accounts a
    JOIN abos.cash_locations l ON l.id = a.cash_location_id AND l.legal_entity_id = a.legal_entity_id
   WHERE a.id = p_destination_cash_account_id AND a.legal_entity_id = entity;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the receiving safe account was not found' USING ERRCODE = 'check_violation';
  END IF;
  IF destination.currency_code <> installment.currency_code THEN
    RAISE EXCEPTION 'a % installment is received into a % safe account; amounts are never converted',
      installment.currency_code, installment.currency_code USING ERRCODE = 'check_violation';
  END IF;
  IF destination.activation_status <> 'ACTIVE' OR destination.location_status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'Treasury has not activated the % account of %', destination.currency_code, destination.location_name
      USING ERRCODE = 'check_violation';
  END IF;

  IF amount > installment.expected_amount THEN
    RAISE EXCEPTION 'the amount exceeds the expected installment amount of % %', installment.expected_amount, installment.currency_code
      USING ERRCODE = 'check_violation';
  END IF;
  IF amount < installment.expected_amount AND NOT agreement.partial_installments_allowed THEN
    RAISE EXCEPTION 'this agreement does not allow a partial installment' USING ERRCODE = 'check_violation';
  END IF;
  SELECT consumed_amount INTO consumed FROM abos.capital_agreement_commitment_usage
   WHERE capital_agreement_id = agreement.id AND legal_entity_id = entity;
  IF coalesce(consumed, 0) + amount > agreement.committed_amount THEN
    RAISE EXCEPTION 'capital requests would exceed the committed amount: committed % %, already requested %, this request %',
      agreement.committed_amount, agreement.currency_code, coalesce(consumed, 0), amount USING ERRCODE = 'check_violation';
  END IF;
  IF installment.currency_code = base AND p_exchange_rate_id IS NOT NULL THEN
    RAISE EXCEPTION 'a % request takes no exchange rate', base USING ERRCODE = 'check_violation';
  END IF;

  -- The existing triggers enforce the ceiling (row-locked usage), the funding decision and the
  -- sandbox gate again on this insert; one intent per installment is a unique constraint.
  INSERT INTO abos.capital_receipt_intents
    (id, legal_entity_id, shareholder_business_party_id, capital_agreement_id, capital_installment_id,
     amount, currency_code, destination_cash_account_id, evidence_reference_id, correlation_id,
     idempotency_key, request_fingerprint, business_event_at, status, classification,
     contribution_state, version, created_by_user_account_id)
  VALUES
    (intent_id, entity, profile.business_party_id, agreement.id, installment.id,
     amount, installment.currency_code, destination.id, registration_evidence_id, gen_random_uuid(),
     p_idempotency_key, fingerprint, p_business_date::timestamp AT TIME ZONE 'UTC', 'ELIGIBLE', 'PAID_IN_SHARE_CAPITAL',
     'PENDING', 1, actor);
  INSERT INTO abos.capital_receipt_intent_history
    (id, capital_receipt_intent_id, legal_entity_id, version, status, contribution_state, classification, amount, currency_code)
  VALUES (gen_random_uuid(), intent_id, entity, 1, 'ELIGIBLE', 'PENDING', 'PAID_IN_SHARE_CAPITAL', amount, installment.currency_code);

  -- A non-base (AFN) request keeps an immutable snapshot of the rate for its business date; with no
  -- rate for that date the whole request is refused and nothing above is kept.
  IF installment.currency_code <> base THEN
    snapshot_id := abos.capture_exchange_rate_snapshot(entity, 'CAPITAL_RECEIPT_INTENT', intent_id,
      installment.currency_code, p_business_date, p_exchange_rate_id, actor);
  END IF;

  INSERT INTO abos.audit_records (id, actor_user_account_id, legal_entity_id, correlation_id, action, entity_type, entity_id, after_state, metadata)
  VALUES (gen_random_uuid(), actor, entity, gen_random_uuid(), 'SHAREHOLDER_CAPITAL_REQUEST_CREATED', 'CAPITAL_RECEIPT_INTENT', intent_id,
          jsonb_build_object('agreementId', agreement.id, 'installmentId', installment.id, 'amount', amount::text,
            'currency', installment.currency_code, 'destinationCashAccountId', destination.id, 'businessDate', p_business_date,
            'status', 'ELIGIBLE', 'exchangeRateSnapshot',
            (SELECT jsonb_build_object('id', s.id, 'exchangeRateId', s.exchange_rate_id, 'rateDate', s.rate_date,
                      'unitCurrency', s.unit_currency_code, 'quoteCurrency', s.quote_currency_code, 'rate', s.rate_value::text)
               FROM abos.exchange_rate_snapshots s WHERE s.id = snapshot_id)),
          jsonb_build_object('source', 'shareholder_create_capital_request'));
  RETURN jsonb_build_object('id', intent_id, 'replayed', false, 'snapshotId', snapshot_id);
END;
$create_request$;

-- ---------------------------------------------------------------------------
-- Ownership and access, following 0011.
-- ---------------------------------------------------------------------------

-- Finance owner: exchange rates. Column-level INSERT; entered_at is always the database's.
GRANT SELECT ON abos.exchange_rates, abos.exchange_rate_snapshots TO abos_e1_finance_owner;
GRANT INSERT (id, legal_entity_id, rate_date, rate_source, saraf_business_party_id, unit_currency_code,
  quote_currency_code, rate_value, note, supersedes_exchange_rate_id, correction_reason, entered_by_user_account_id)
  ON abos.exchange_rates TO abos_e1_finance_owner;

-- Shareholder owner: reads what the capital-request rules read; writes only the intent, its history,
-- the commitment usage the ceiling trigger maintains, the rate snapshot and audit. No ledger, custody
-- or identity writes.
GRANT SELECT ON
  abos.sandbox_authorizations, abos.sandbox_legal_entity_scopes, abos.sandbox_sessions, abos.user_accounts,
  abos.user_permission_grants, abos.permission_catalogue, abos.legal_entities, abos.currencies,
  abos.business_parties, abos.business_party_roles, abos.shareholder_profiles, abos.capital_agreements,
  abos.capital_installments, abos.capital_agreement_funding_policies, abos.capital_agreement_commitment_usage,
  abos.capital_receipt_intents, abos.registration_evidence, abos.evidence_references,
  abos.cash_location_currency_accounts, abos.cash_locations, abos.exchange_rates, abos.exchange_rate_snapshots
TO abos_e1_shareholder_owner;
GRANT INSERT (id, legal_entity_id, shareholder_business_party_id, capital_agreement_id, capital_installment_id,
  amount, currency_code, destination_cash_account_id, evidence_reference_id, correlation_id, idempotency_key,
  request_fingerprint, business_event_at, status, classification, contribution_state, version, created_by_user_account_id)
  ON abos.capital_receipt_intents TO abos_e1_shareholder_owner;
GRANT INSERT (id, capital_receipt_intent_id, legal_entity_id, version, status, contribution_state, classification,
  amount, currency_code) ON abos.capital_receipt_intent_history TO abos_e1_shareholder_owner;
GRANT UPDATE (consumed_amount, revision) ON abos.capital_agreement_commitment_usage TO abos_e1_shareholder_owner;
GRANT INSERT (id, legal_entity_id, source_type, source_id, transaction_currency_code, base_currency_code, exchange_rate_id,
  rate_date, rate_source, saraf_business_party_id, unit_currency_code, quote_currency_code, rate_value, rate_entered_at,
  captured_by_user_account_id) ON abos.exchange_rate_snapshots TO abos_e1_shareholder_owner;
GRANT INSERT ON abos.audit_records TO abos_e1_shareholder_owner;

-- Lock-only tables for the shareholder owner (the authorizer's FOR SHARE, and the ceiling trigger's
-- lock on the agreement): the primary-key column only, plus a trigger that refuses any change.
CREATE OR REPLACE FUNCTION abos.forbid_shareholder_owner_update()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF current_user = 'abos_e1_shareholder_owner' THEN
    RAISE EXCEPTION '% may lock but not change %', current_user, TG_TABLE_NAME
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

DO $lock_only$
DECLARE
  table_name text;
  key_column text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['sandbox_sessions', 'user_accounts', 'sandbox_authorizations',
    'sandbox_legal_entity_scopes', 'user_permission_grants', 'capital_agreements'] LOOP
    SELECT a.attname INTO key_column
      FROM pg_catalog.pg_index i
      JOIN pg_catalog.pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
     WHERE i.indrelid = format('abos.%I', table_name)::regclass AND i.indisprimary;
    IF key_column IS NULL THEN
      RAISE EXCEPTION 'lock-only table % has no primary key', table_name;
    END IF;
    EXECUTE format('GRANT UPDATE (%I) ON abos.%I TO abos_e1_shareholder_owner', key_column, table_name);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON abos.%I FOR EACH ROW EXECUTE FUNCTION abos.forbid_shareholder_owner_update()',
      table_name || '_shareholder_owner_lock_only', table_name);
  END LOOP;
END
$lock_only$;

ALTER FUNCTION abos.finance_exchange_rates_view(text, date, date) OWNER TO abos_e1_finance_owner;
ALTER FUNCTION abos.finance_record_exchange_rate(text, date, text, uuid, text, text, text, text) OWNER TO abos_e1_finance_owner;
ALTER FUNCTION abos.finance_correct_exchange_rate(text, uuid, text, text) OWNER TO abos_e1_finance_owner;
ALTER FUNCTION abos.shareholder_runtime_authorize(text, text) OWNER TO abos_e1_shareholder_owner;
ALTER FUNCTION abos.shareholder_capital_workspace(text) OWNER TO abos_e1_shareholder_owner;
ALTER FUNCTION abos.shareholder_create_capital_request(text, uuid, uuid, text, date, uuid, text) OWNER TO abos_e1_shareholder_owner;

REVOKE ALL ON FUNCTION abos.finance_exchange_rates_view(text, date, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION abos.finance_record_exchange_rate(text, date, text, uuid, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION abos.finance_correct_exchange_rate(text, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION abos.shareholder_runtime_authorize(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION abos.shareholder_capital_workspace(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION abos.shareholder_create_capital_request(text, uuid, uuid, text, date, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION abos.finance_exchange_rates_view(text, date, date) TO abos_e1_runtime;
GRANT EXECUTE ON FUNCTION abos.finance_record_exchange_rate(text, date, text, uuid, text, text, text, text) TO abos_e1_runtime;
GRANT EXECUTE ON FUNCTION abos.finance_correct_exchange_rate(text, uuid, text, text) TO abos_e1_runtime;
GRANT EXECUTE ON FUNCTION abos.shareholder_capital_workspace(text) TO abos_e1_runtime;
GRANT EXECUTE ON FUNCTION abos.shareholder_create_capital_request(text, uuid, uuid, text, date, uuid, text) TO abos_e1_runtime;

-- Internal helpers: never callable by PUBLIC or a runtime.
REVOKE ALL ON FUNCTION abos.capture_exchange_rate_snapshot(uuid, text, uuid, text, date, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION abos.capture_exchange_rate_snapshot(uuid, text, uuid, text, date, uuid, uuid) TO abos_e1_shareholder_owner;
-- The capital-intent sandbox guard trigger calls this helper under the inserting owner.
GRANT EXECUTE ON FUNCTION abos.assert_sandbox_mutation_authorized(uuid) TO abos_e1_shareholder_owner;
REVOKE ALL ON FUNCTION abos.prevent_exchange_rate_mutation(), abos.guard_exchange_rate_insert(),
  abos.prevent_exchange_rate_snapshot_mutation(), abos.guard_exchange_rate_snapshot_insert(),
  abos.forbid_shareholder_owner_update() FROM PUBLIC;
