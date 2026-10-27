-- Slice 3, part 2: one Safe model with real opening balances. Additive for data: no existing row
-- changes, nothing is seeded into a company, and no balance is stored anywhere.
--
-- 1. Chart of Accounts control OPENING_BALANCE_EQUITY (an EQUITY account). The opening-balance writer
--    resolves exactly one active account with it; none or several is a setup error.
-- 2. Treasury account lifecycle ACTIVE / INACTIVE / CLOSED; CLOSED only at a zero book balance, terminal.
-- 3. Source OPENING_BALANCE becomes ACTIVE in the posting registry, with its source table, validator,
--    kernel dispatch arm and writer. One opening balance per Safe, never edited; corrected by reversal.
-- 4. Optional responsible users per Safe (they may read that Safe); permissions treasury.safe.read and
--    treasury.opening-balance.record; the Safe workspace reads balances from the 0045 read model.
-- 5. A read-only view links legacy cash-location accounts to the canonical Treasury account that uses
--    the same ledger account. The legacy tables stay frozen and are used by no operational action.

-- ---------------------------------------------------------------------------------------------
-- 1. Control type.
-- ---------------------------------------------------------------------------------------------

ALTER TABLE abos.ledger_accounts DROP CONSTRAINT ledger_accounts_control_account_type_check;
ALTER TABLE abos.ledger_accounts ADD CONSTRAINT ledger_accounts_control_account_type_check CHECK (
  control_account_type IS NULL OR control_account_type = ANY (ARRAY['CASH', 'SHAREHOLDER_CAPITAL', 'SHAREHOLDER_LOAN',
    'AR', 'AP', 'SARAF', 'OTHER', 'TEMPORARY_FUNDING_PAYABLE', 'SHAREHOLDER_CONTRIBUTED_ASSETS', 'OPENING_BALANCE_EQUITY']));

-- ---------------------------------------------------------------------------------------------
-- 2. Lifecycle.
-- ---------------------------------------------------------------------------------------------

ALTER TABLE abos.operational_treasury_accounts DROP CONSTRAINT operational_treasury_accounts_status_check;
ALTER TABLE abos.operational_treasury_accounts ADD CONSTRAINT operational_treasury_accounts_status_check
  CHECK (status = ANY (ARRAY['ACTIVE', 'INACTIVE', 'CLOSED']));

-- ---------------------------------------------------------------------------------------------
-- 3. Opening balances.
-- ---------------------------------------------------------------------------------------------

CREATE TABLE abos.treasury_opening_balances (
  id uuid PRIMARY KEY,
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  operational_treasury_account_id uuid NOT NULL,
  currency_code text NOT NULL REFERENCES abos.currencies(code),
  amount numeric NOT NULL CHECK (amount > 0),
  as_of_date date NOT NULL,
  reference text CHECK (reference IS NULL OR length(btrim(reference)) BETWEEN 1 AND 120),
  note text CHECK (note IS NULL OR length(btrim(note)) BETWEEN 1 AND 1000),
  transaction_reference text NOT NULL UNIQUE,
  equity_ledger_account_id uuid NOT NULL,
  journal_id uuid NOT NULL UNIQUE,
  created_by_user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  correlation_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  UNIQUE (id, legal_entity_id),
  -- One canonical opening balance per Safe (a Safe has one currency).
  UNIQUE (operational_treasury_account_id),
  FOREIGN KEY (operational_treasury_account_id, legal_entity_id, currency_code)
    REFERENCES abos.operational_treasury_accounts(id, legal_entity_id, currency_code),
  FOREIGN KEY (equity_ledger_account_id, legal_entity_id) REFERENCES abos.ledger_accounts(id, legal_entity_id)
);
COMMENT ON TABLE abos.treasury_opening_balances IS
  'The opening balance of a Safe at the business start: one per Safe, posted through the posting kernel (Dr the Safe, Cr opening balance equity), never edited; corrected by reversal.';
CREATE TRIGGER treasury_opening_balances_no_update_or_delete
BEFORE UPDATE OR DELETE ON abos.treasury_opening_balances
FOR EACH ROW EXECUTE FUNCTION abos.prevent_audit_mutation();

ALTER TABLE abos.posting_intents ADD COLUMN treasury_opening_balance_id uuid;
ALTER TABLE abos.posting_intents ADD CONSTRAINT posting_intents_treasury_opening_balance_fkey
  FOREIGN KEY (treasury_opening_balance_id, legal_entity_id) REFERENCES abos.treasury_opening_balances(id, legal_entity_id);
ALTER TABLE abos.posting_intents DROP CONSTRAINT posting_intents_intent_kind_check;
ALTER TABLE abos.posting_intents ADD CONSTRAINT posting_intents_intent_kind_check CHECK (intent_kind = ANY (ARRAY[
  'SHAREHOLDER_CAPITAL_RECEIPT', 'SHAREHOLDER_LOAN_RECEIPT', 'REVERSAL', 'EXPENSE', 'TEMPORARY_FUNDING',
  'TEMPORARY_FUNDING_SETTLEMENT', 'DIRECT_SHAREHOLDER_CAPITAL', 'OPENING_BALANCE']));
ALTER TABLE abos.posting_intents ADD CONSTRAINT posting_intents_opening_balance_shape CHECK (
  (intent_kind = 'OPENING_BALANCE') = (treasury_opening_balance_id IS NOT NULL)
  AND (treasury_opening_balance_id IS NULL OR (source_type = 'OPENING_BALANCE' AND source_id = treasury_opening_balance_id
       AND processing_model = 'OPERATIONAL_V1')));

-- The registry is lock-only; a migration activates a PLANNED source.
ALTER TABLE abos.posting_sources DISABLE TRIGGER posting_sources_no_update_or_delete;
UPDATE abos.posting_sources SET
  intent_kind = 'OPENING_BALANCE', status = 'ACTIVE', line_count = 2,
  debit_rules = '[{"accountType":"ASSET","control":"CASH"},{"accountType":"ASSET","control":"SARAF"}]',
  credit_rules = '[{"accountType":"EQUITY","control":"OPENING_BALANCE_EQUITY"}]',
  subledger_rules = '[{"type":"OPERATIONAL_TREASURY","side":"DEBIT","required":true}]',
  reversible = true, validator = 'validate_opening_balance_journal',
  description = 'Opening balance of a Safe at the business start: Dr the Safe, Cr opening balance equity (0046).'
WHERE source_type = 'OPENING_BALANCE' AND status = 'PLANNED';
ALTER TABLE abos.posting_sources ENABLE TRIGGER posting_sources_no_update_or_delete;
DO $registry$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM abos.posting_sources WHERE source_type = 'OPENING_BALANCE' AND status = 'ACTIVE') THEN
    RAISE EXCEPTION '0046 could not activate the OPENING_BALANCE source';
  END IF;
END $registry$;

CREATE FUNCTION abos.opening_balance_equity_status(p_entity uuid, p_currency text)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $status$
  WITH candidates AS (
    SELECT id, account_code, account_name, account_type, posting_allowed, account_currency_code,
           requires_project, requires_department, requires_cost_center
      FROM abos.ledger_accounts
     WHERE legal_entity_id = p_entity AND control_account_type = 'OPENING_BALANCE_EQUITY' AND status = 'ACTIVE')
  SELECT CASE
    WHEN (SELECT count(*) FROM candidates) = 0 THEN jsonb_build_object('status', 'MISSING')
    WHEN (SELECT count(*) FROM candidates) > 1 THEN jsonb_build_object('status', 'AMBIGUOUS', 'count', (SELECT count(*) FROM candidates))
    ELSE (SELECT jsonb_build_object(
      'status', CASE WHEN account_type = 'EQUITY' AND posting_allowed AND account_currency_code IS NOT DISTINCT FROM p_currency
                      AND NOT requires_project AND NOT requires_department AND NOT requires_cost_center
                     THEN 'READY' ELSE 'INVALID' END,
      'account', jsonb_build_object('id', id, 'code', account_code, 'name', account_name, 'currency', account_currency_code))
      FROM candidates)
  END
$status$;

CREATE FUNCTION abos.opening_balance_equity_account(p_entity uuid, p_currency text)
RETURNS uuid LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $resolve$
DECLARE v jsonb;
BEGIN
  v := abos.opening_balance_equity_status(p_entity, p_currency);
  IF v->>'status' = 'MISSING' THEN
    RAISE EXCEPTION 'opening balance equity is not set up: create one active EQUITY account with control OPENING_BALANCE_EQUITY'
      USING ERRCODE = 'check_violation';
  ELSIF v->>'status' = 'AMBIGUOUS' THEN
    RAISE EXCEPTION 'opening balance equity is ambiguous: % active accounts carry control OPENING_BALANCE_EQUITY', v->>'count'
      USING ERRCODE = 'check_violation';
  ELSIF v->>'status' <> 'READY' THEN
    RAISE EXCEPTION 'the opening balance equity account must be an EQUITY account that accepts postings in % without dimensions', p_currency
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN (v->'account'->>'id')::uuid;
END
$resolve$;

CREATE FUNCTION abos.validate_opening_balance_journal(p_journal abos.journals, p_intent abos.posting_intents)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $validate$
DECLARE
  v_opening abos.treasury_opening_balances%ROWTYPE;
  v_account abos.operational_treasury_accounts%ROWTYPE;
BEGIN
  SELECT * INTO v_opening FROM abos.treasury_opening_balances
   WHERE id = p_intent.source_id AND legal_entity_id = p_journal.legal_entity_id;
  IF NOT FOUND OR v_opening.journal_id <> p_journal.id OR p_intent.intent_kind <> 'OPENING_BALANCE'
     OR p_intent.treasury_opening_balance_id IS DISTINCT FROM v_opening.id
     OR p_intent.original_amount <> v_opening.amount OR p_intent.base_amount <> v_opening.amount
     OR p_intent.original_currency_code <> v_opening.currency_code
     OR v_opening.as_of_date <> p_journal.accounting_effective_date
     OR p_journal.journal_reference <> v_opening.transaction_reference
     OR p_journal.posted_by_user_account_id IS DISTINCT FROM v_opening.created_by_user_account_id
     OR p_intent.created_by_user_account_id <> v_opening.created_by_user_account_id THEN
    RAISE EXCEPTION 'opening balance journal does not match its source, amount, date, reference or recorder'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_account FROM abos.operational_treasury_accounts
   WHERE id = v_opening.operational_treasury_account_id AND legal_entity_id = p_journal.legal_entity_id;
  IF NOT EXISTS (SELECT 1 FROM abos.journal_lines line WHERE line.journal_id = p_journal.id AND line.line_number = 1
       AND line.ledger_account_id = v_account.ledger_account_id AND line.base_debit = v_opening.amount
       AND line.business_party_id IS NULL AND line.project_id IS NULL AND line.department_id IS NULL AND line.cost_center_id IS NULL)
     OR NOT EXISTS (SELECT 1 FROM abos.journal_lines line WHERE line.journal_id = p_journal.id AND line.line_number = 2
       AND line.ledger_account_id = v_opening.equity_ledger_account_id AND line.base_credit = v_opening.amount
       AND line.business_party_id IS NULL AND line.project_id IS NULL AND line.department_id IS NULL AND line.cost_center_id IS NULL) THEN
    RAISE EXCEPTION 'an opening balance must debit its Safe and credit opening balance equity'
      USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT count(*) FROM abos.subledger_entries entry JOIN abos.journal_lines line ON line.id = entry.journal_line_id
       WHERE line.journal_id = p_journal.id) <> 1
     OR NOT EXISTS (SELECT 1 FROM abos.subledger_entries entry JOIN abos.journal_lines line ON line.id = entry.journal_line_id
       WHERE line.journal_id = p_journal.id AND line.line_number = 1 AND entry.subledger_type = 'OPERATIONAL_TREASURY'
         AND entry.operational_treasury_account_id = v_account.id AND entry.original_amount = v_opening.amount
         AND entry.base_amount = v_opening.amount AND entry.business_party_id IS NULL) THEN
    RAISE EXCEPTION 'an opening balance requires exactly its Safe movement'
      USING ERRCODE = 'check_violation';
  END IF;
END
$validate$;

-- ---------------------------------------------------------------------------------------------
-- 4. Responsible users.
-- ---------------------------------------------------------------------------------------------

CREATE TABLE abos.operational_treasury_account_responsibles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  operational_treasury_account_id uuid NOT NULL,
  user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  assigned_by_user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  assigned_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_by_user_account_id uuid REFERENCES abos.user_accounts(id),
  revoked_at timestamptz,
  CHECK ((revoked_at IS NULL) = (revoked_by_user_account_id IS NULL)),
  FOREIGN KEY (operational_treasury_account_id, legal_entity_id) REFERENCES abos.operational_treasury_accounts(id, legal_entity_id)
);
CREATE UNIQUE INDEX operational_treasury_account_responsibles_current
  ON abos.operational_treasury_account_responsibles (operational_treasury_account_id, user_account_id) WHERE revoked_at IS NULL;
COMMENT ON TABLE abos.operational_treasury_account_responsibles IS
  'Optional people responsible for a Safe. A responsible person may read that Safe and its balance; it never creates another Safe identity.';

-- ---------------------------------------------------------------------------------------------
-- 5. Legacy link (read-only) and permissions.
-- ---------------------------------------------------------------------------------------------

CREATE VIEW abos.treasury_account_legacy_links AS
  SELECT treasury.id AS operational_treasury_account_id, treasury.legal_entity_id,
         legacy.id AS cash_location_currency_account_id, location.id AS cash_location_id,
         location.location_name, legacy.currency_code, legacy.activation_status
    FROM abos.operational_treasury_accounts treasury
    JOIN abos.cash_location_currency_accounts legacy
      ON legacy.ledger_account_id = treasury.ledger_account_id AND legacy.legal_entity_id = treasury.legal_entity_id
    JOIN abos.cash_locations location ON location.id = legacy.cash_location_id AND location.legal_entity_id = legacy.legal_entity_id;
COMMENT ON VIEW abos.treasury_account_legacy_links IS
  'Which frozen legacy cash-location account shares its ledger account with a canonical Treasury account. Writes nothing, creates no balance.';

INSERT INTO abos.permission_catalogue
  (permission_code, catalogue_version, category, availability, independence_enforced, administrative, sort_order)
VALUES
  ('treasury.safe.read', 11, 'TREASURY', 'ACTIVE', false, false, 412),
  ('treasury.opening-balance.record', 11, 'TREASURY', 'ACTIVE', false, false, 414);

-- ---------------------------------------------------------------------------------------------
-- 6. Commands and the Safe workspace.
-- ---------------------------------------------------------------------------------------------

CREATE FUNCTION abos.treasury_safe_actor(p_proof text, p_runtime text, p_token text, p_permission text)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $actor$
DECLARE c jsonb;
BEGIN
  c := abos.operational_finance_actor(p_proof, p_runtime, p_token, NULL);
  IF c->>'sessionProvenance' IS DISTINCT FROM 'PASSWORD_OPERATIONAL' THEN
    RAISE EXCEPTION 'an operational password session is required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_permission IS NOT NULL AND NOT COALESCE(c->'permissions', '[]'::jsonb) ? p_permission THEN
    RAISE EXCEPTION 'current authority is missing %', p_permission USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN c;
END
$actor$;

CREATE FUNCTION abos.treasury_opening_balance_record(p_proof text, p_runtime text, p_token text, p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $record$
DECLARE
  c jsonb; actor uuid; entity uuid; v_account abos.operational_treasury_accounts%ROWTYPE; base text;
  amount numeric; day date; currency text; equity uuid; period uuid; account_id uuid;
  key text; correlation uuid; scope text; fingerprint text; replay jsonb; ref text; result jsonb;
  opening uuid := gen_random_uuid(); journal uuid := gen_random_uuid(); intent uuid := gen_random_uuid();
BEGIN
  c := abos.treasury_safe_actor(p_proof, p_runtime, p_token, 'treasury.opening-balance.record');
  actor := (c->>'userAccountId')::uuid; entity := (c->>'legalEntityId')::uuid;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_payload) k
      WHERE k NOT IN ('treasuryAccountId', 'amount', 'currencyCode', 'asOfDate', 'reference', 'note', 'idempotencyKey', 'correlationId')) THEN
    RAISE EXCEPTION 'unknown opening balance fields' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  amount := abos.temporary_funding_amount(p_payload->>'amount');
  key := NULLIF(btrim(p_payload->>'idempotencyKey'), '');
  BEGIN
    account_id := NULLIF(p_payload->>'treasuryAccountId', '')::uuid;
    day := NULLIF(p_payload->>'asOfDate', '')::date;
    correlation := NULLIF(p_payload->>'correlationId', '')::uuid;
  EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow OR invalid_datetime_format THEN
    RAISE EXCEPTION 'a Safe, an amount, an as-of date and a request key are required' USING ERRCODE = 'invalid_parameter_value';
  END;
  currency := p_payload->>'currencyCode';
  IF account_id IS NULL OR day IS NULL OR key IS NULL OR correlation IS NULL
     OR length(p_payload->>'reference') > 120 OR length(p_payload->>'note') > 1000 THEN
    RAISE EXCEPTION 'a Safe, an amount, an as-of date and a request key are required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF day > abos.business_today() THEN
    RAISE EXCEPTION 'an opening balance cannot be dated after today' USING ERRCODE = 'check_violation';
  END IF;
  -- Authorization precedes durable replay; an identical request returns the first result.
  scope := 'treasury:opening-balance:' || entity::text || ':' || actor::text;
  fingerprint := encode(sha256(convert_to((p_payload - 'correlationId')::text || actor::text, 'UTF8')), 'hex');
  replay := abos.temporary_funding_idempotency_begin(scope, key, fingerprint, correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  -- Concurrent attempts for one Safe serialize here; the second sees the first and is refused.
  PERFORM pg_advisory_xact_lock(hashtextextended('abos-treasury-opening:' || entity::text || ':' || account_id::text, 0));
  SELECT * INTO v_account FROM abos.operational_treasury_accounts WHERE id = account_id AND legal_entity_id = entity FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the Safe was not found in this legal entity' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_account.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'an opening balance needs an active Safe' USING ERRCODE = 'check_violation';
  END IF;
  IF currency IS DISTINCT FROM v_account.currency_code THEN
    RAISE EXCEPTION 'the opening balance must be in the Safe currency %', v_account.currency_code USING ERRCODE = 'check_violation';
  END IF;
  SELECT base_currency_code INTO base FROM abos.legal_entities WHERE id = entity AND currency_policy_status = 'APPROVED';
  IF base IS NULL OR v_account.currency_code IS DISTINCT FROM base THEN
    RAISE EXCEPTION 'an opening balance in a currency other than the approved accounting currency is not available yet'
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM abos.treasury_opening_balances WHERE operational_treasury_account_id = v_account.id) THEN
    RAISE EXCEPTION 'this Safe already has an opening balance; a posted opening balance is corrected by reversal'
      USING ERRCODE = 'check_violation';
  END IF;
  equity := abos.opening_balance_equity_account(entity, base);
  period := abos.open_period_for_business_date(entity, actor, day);
  ref := 'OB-' || to_char(day, 'YYYYMMDD') || '-' || upper(replace(opening::text, '-', ''));
  INSERT INTO abos.treasury_opening_balances (id, legal_entity_id, operational_treasury_account_id, currency_code, amount,
    as_of_date, reference, note, transaction_reference, equity_ledger_account_id, journal_id, created_by_user_account_id,
    correlation_id, idempotency_key)
  VALUES (opening, entity, v_account.id, currency, amount, day, NULLIF(btrim(p_payload->>'reference'), ''),
    NULLIF(btrim(p_payload->>'note'), ''), ref, equity, journal, actor, correlation, key);
  PERFORM abos.posting_kernel_draft(
    p_intent_id => intent, p_journal_id => journal, p_legal_entity_id => entity,
    p_source_type => 'OPENING_BALANCE', p_source_id => opening,
    p_original_amount => amount, p_original_currency_code => currency, p_base_amount => amount, p_base_currency_code => base,
    p_accounting_effective_date => day, p_accounting_period_id => period, p_journal_reference => ref,
    p_correlation_id => correlation, p_idempotency_key => 'OB:' || opening::text, p_initial_status => 'VALIDATED',
    p_created_by_user_account_id => actor,
    p_lines => ARRAY[
      ROW(1, 'DEBIT', v_account.ledger_account_id, NULL, NULL, NULL, NULL, 'OPERATIONAL_TREASURY', 1, v_account.id, NULL)::abos.posting_kernel_line,
      ROW(2, 'CREDIT', equity, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)::abos.posting_kernel_line]);
  PERFORM abos.posting_kernel_commit(intent, journal, actor);
  result := jsonb_build_object('openingBalanceId', opening, 'journalId', journal, 'reference', ref, 'status', 'POSTED', 'replayed', false);
  INSERT INTO abos.audit_records (id, actor_user_account_id, legal_entity_id, correlation_id, action, entity_type, entity_id, after_state, metadata)
  VALUES (gen_random_uuid(), actor, entity, correlation, 'TREASURY_OPENING_BALANCE_POSTED', 'TREASURY_OPENING_BALANCE', opening,
    result || jsonb_build_object('treasuryAccountId', v_account.id, 'amount', amount::text, 'currency', currency, 'asOfDate', day,
      'equityAccountId', equity), jsonb_build_object('source', 'v1-treasury-opening-balance'));
  INSERT INTO abos.outbox_events (id, aggregate_type, aggregate_id, event_type, event_version, legal_entity_id, actor_user_account_id,
    correlation_id, payload, occurred_at)
  VALUES (gen_random_uuid(), 'TREASURY_OPENING_BALANCE', opening, 'finance.treasury-opening-balance.posted', 1, entity, actor, correlation,
    jsonb_build_object('openingBalanceId', opening, 'journalId', journal, 'treasuryAccountId', v_account.id), clock_timestamp());
  PERFORM abos.temporary_funding_idempotency_complete(scope, key, 'TREASURY_OPENING_BALANCE', opening, result);
  RETURN result;
END
$record$;

CREATE FUNCTION abos.treasury_safes_workspace(p_proof text, p_runtime text, p_token text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $workspace$
DECLARE c jsonb; actor uuid; entity uuid; perms jsonb; read_all boolean; base text;
BEGIN
  c := abos.treasury_safe_actor(p_proof, p_runtime, p_token, NULL);
  actor := (c->>'userAccountId')::uuid; entity := (c->>'legalEntityId')::uuid;
  perms := COALESCE(c->'permissions', '[]'::jsonb);
  read_all := perms ? 'treasury.safe.read';
  IF NOT read_all AND NOT EXISTS (SELECT 1 FROM abos.operational_treasury_account_responsibles r
       WHERE r.legal_entity_id = entity AND r.user_account_id = actor AND r.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'current authority is missing treasury.safe.read' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT base_currency_code INTO base FROM abos.legal_entities WHERE id = entity;
  RETURN jsonb_build_object(
    'today', abos.business_today(),
    'baseCurrency', base,
    'canRecordOpeningBalance', perms ? 'treasury.opening-balance.record',
    'canManageSafes', perms ? 'treasury.operational-account.manage',
    'canOpenLedger', perms ? 'finance.report.operational.read',
    'openingEquity', abos.opening_balance_equity_status(entity, base),
    'safes', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', account.id, 'nameEn', account.name_en, 'nameFa', account.name_fa, 'accountType', account.account_type,
        'currencyCode', account.currency_code, 'status', account.status, 'version', account.version,
        'ledgerAccount', jsonb_build_object('id', ledger.id, 'code', ledger.account_code, 'name', ledger.account_name),
        'balance', jsonb_build_object('opening', balance.opening_balance::text, 'inflows', balance.inflows::text,
          'outflows', balance.outflows::text, 'book', balance.book_balance::text, 'movementCount', balance.movement_count,
          'lastMovementDate', balance.last_movement_date),
        'openingBalance', (SELECT jsonb_build_object('id', ob.id, 'amount', ob.amount::text, 'currencyCode', ob.currency_code,
            'asOfDate', ob.as_of_date, 'reference', ob.reference, 'note', ob.note, 'transactionReference', ob.transaction_reference,
            'journalId', ob.journal_id, 'recordedAt', ob.created_at)
          FROM abos.treasury_opening_balances ob WHERE ob.operational_treasury_account_id = account.id),
        'responsibles', COALESCE((SELECT jsonb_agg(jsonb_build_object('userAccountId', u.id, 'displayName', u.display_name)
            ORDER BY u.display_name, u.id)
          FROM abos.operational_treasury_account_responsibles r JOIN abos.user_accounts u ON u.id = r.user_account_id
          WHERE r.operational_treasury_account_id = account.id AND r.revoked_at IS NULL), '[]'::jsonb),
        'legacyLink', (SELECT jsonb_build_object('locationName', link.location_name, 'activationStatus', link.activation_status)
          FROM abos.treasury_account_legacy_links link WHERE link.operational_treasury_account_id = account.id LIMIT 1),
        'movements', COALESCE((SELECT jsonb_agg(jsonb_build_object('journalId', m.journal_id, 'date', m.effective_date,
            'direction', CASE WHEN m.amount > 0 THEN 'IN' ELSE 'OUT' END, 'amount', abs(m.amount)::text,
            'sourceType', m.source_type, 'reference', m.journal_reference, 'restricted', m.restricted)
            ORDER BY m.effective_date DESC, m.posted_at DESC, m.journal_id)
          FROM (SELECT * FROM abos.treasury_account_movements(entity, account.id, NULL, NULL, actor) LIMIT 25) m), '[]'::jsonb))
        ORDER BY CASE account.status WHEN 'ACTIVE' THEN 0 WHEN 'INACTIVE' THEN 1 ELSE 2 END, account.name_en, account.id)
      FROM abos.operational_treasury_accounts account
      JOIN abos.ledger_accounts ledger ON ledger.id = account.ledger_account_id AND ledger.legal_entity_id = account.legal_entity_id
      JOIN abos.treasury_account_balances(entity, NULL, NULL) balance ON balance.operational_treasury_account_id = account.id
     WHERE account.legal_entity_id = entity
       AND (read_all OR EXISTS (SELECT 1 FROM abos.operational_treasury_account_responsibles r
             WHERE r.operational_treasury_account_id = account.id AND r.user_account_id = actor AND r.revoked_at IS NULL))), '[]'::jsonb),
    'assignableUsers', CASE WHEN perms ? 'treasury.operational-account.manage' THEN COALESCE((SELECT jsonb_agg(
        jsonb_build_object('userAccountId', u.id, 'displayName', u.display_name) ORDER BY u.display_name, u.id)
      FROM abos.user_accounts u WHERE u.status = 'ACTIVE' AND EXISTS (SELECT 1 FROM abos.user_permission_grants g
        WHERE g.user_account_id = u.id AND g.legal_entity_id = entity AND g.revoked_at IS NULL)), '[]'::jsonb) ELSE '[]'::jsonb END);
END
$workspace$;

CREATE FUNCTION abos.treasury_safe_responsibles_set(p_proof text, p_runtime text, p_token text, p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $responsibles$
DECLARE c jsonb; actor uuid; entity uuid; account_id uuid; wanted uuid[];
BEGIN
  c := abos.treasury_safe_actor(p_proof, p_runtime, p_token, 'treasury.operational-account.manage');
  actor := (c->>'userAccountId')::uuid; entity := (c->>'legalEntityId')::uuid;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' OR jsonb_typeof(p_payload->'userAccountIds') IS DISTINCT FROM 'array'
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_payload) k WHERE k NOT IN ('treasuryAccountId', 'userAccountIds')) THEN
    RAISE EXCEPTION 'choose a Safe and its responsible people' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  BEGIN
    account_id := (p_payload->>'treasuryAccountId')::uuid;
    SELECT COALESCE(array_agg(DISTINCT value::uuid), ARRAY[]::uuid[]) INTO wanted FROM jsonb_array_elements_text(p_payload->'userAccountIds');
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'choose a Safe and its responsible people' USING ERRCODE = 'invalid_parameter_value';
  END;
  PERFORM pg_advisory_xact_lock(hashtextextended('abos-operational-treasury:' || entity::text || ':' || account_id::text, 0));
  IF NOT EXISTS (SELECT 1 FROM abos.operational_treasury_accounts WHERE id = account_id AND legal_entity_id = entity AND status <> 'CLOSED') THEN
    RAISE EXCEPTION 'the Safe was not found in this legal entity' USING ERRCODE = 'no_data_found';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(wanted) w WHERE NOT EXISTS (SELECT 1 FROM abos.user_accounts u WHERE u.id = w AND u.status = 'ACTIVE'
      AND EXISTS (SELECT 1 FROM abos.user_permission_grants g WHERE g.user_account_id = u.id AND g.legal_entity_id = entity AND g.revoked_at IS NULL))) THEN
    RAISE EXCEPTION 'a responsible person must be an active user of this company' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE abos.operational_treasury_account_responsibles SET revoked_at = clock_timestamp(), revoked_by_user_account_id = actor
   WHERE operational_treasury_account_id = account_id AND legal_entity_id = entity AND revoked_at IS NULL AND NOT user_account_id = ANY (wanted);
  INSERT INTO abos.operational_treasury_account_responsibles (legal_entity_id, operational_treasury_account_id, user_account_id, assigned_by_user_account_id)
  SELECT entity, account_id, w, actor FROM unnest(wanted) w
   WHERE NOT EXISTS (SELECT 1 FROM abos.operational_treasury_account_responsibles r
     WHERE r.operational_treasury_account_id = account_id AND r.user_account_id = w AND r.revoked_at IS NULL);
  INSERT INTO abos.audit_records (id, actor_user_account_id, legal_entity_id, correlation_id, action, entity_type, entity_id, after_state, metadata)
  VALUES (gen_random_uuid(), actor, entity, gen_random_uuid(), 'TREASURY_RESPONSIBLES_SET', 'OPERATIONAL_TREASURY_ACCOUNT', account_id,
    jsonb_build_object('userAccountIds', to_jsonb(wanted)), jsonb_build_object('source', 'v1-treasury-safes'));
  RETURN abos.treasury_safes_workspace(p_proof, p_runtime, p_token);
END
$responsibles$;

-- ---------------------------------------------------------------------------------------------
-- 7. Restated: kernel dispatch arm and intent column, Chart of Accounts control, lifecycle guard.
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION abos.posting_kernel_validate()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  v_intent abos.posting_intents%ROWTYPE;
  v_source abos.posting_sources%ROWTYPE;
  v_period record;
  v_base text;
  v_line_count bigint; v_debit numeric; v_credit numeric;
BEGIN
  -- Draft before post, and posted is immutable, for every operational journal (frozen lanes included).
  IF TG_OP = 'INSERT' AND NEW.status = 'POSTED' THEN
    RAISE EXCEPTION 'operational journals must be assembled as draft before posting'
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'POSTED' THEN
    RAISE EXCEPTION 'a posted operational journal is immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status <> 'POSTED' THEN RETURN NEW; END IF;

  SELECT * INTO v_intent FROM abos.posting_intents
   WHERE id = NEW.posting_intent_id AND legal_entity_id = NEW.legal_entity_id;
  IF NOT FOUND OR v_intent.processing_model <> 'OPERATIONAL_V1' THEN
    RAISE EXCEPTION 'operational posting requires its operational posting intent in the same legal entity'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_source FROM abos.posting_sources WHERE source_type = v_intent.source_type;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'operational posting source % is not registered', v_intent.source_type
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_source.status = 'FROZEN' THEN RETURN NEW; END IF;
  IF v_source.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'operational posting source % is not available yet', v_intent.source_type
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_intent.status <> 'POSTED' OR v_intent.base_amount IS NULL
     OR v_intent.base_currency_code IS DISTINCT FROM NEW.base_currency_code
     OR v_intent.accounting_effective_date IS DISTINCT FROM NEW.accounting_effective_date THEN
    RAISE EXCEPTION 'operational posting requires its posted intent with the journal''s currency and date'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT status, starts_on, ends_on INTO v_period FROM abos.accounting_periods
   WHERE id = NEW.accounting_period_id AND legal_entity_id = NEW.legal_entity_id;
  IF NOT FOUND OR v_period.status <> 'OPEN'
     OR NEW.accounting_effective_date NOT BETWEEN v_period.starts_on AND v_period.ends_on THEN
    RAISE EXCEPTION 'operational posting requires an open accounting period covering its date'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT base_currency_code INTO v_base FROM abos.legal_entities
   WHERE id = NEW.legal_entity_id AND currency_policy_status = 'APPROVED';
  IF v_base IS NULL OR v_base IS DISTINCT FROM NEW.base_currency_code THEN
    RAISE EXCEPTION 'operational posting requires the approved legal-entity base currency'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT count(*), coalesce(sum(base_debit), 0), coalesce(sum(base_credit), 0)
    INTO v_line_count, v_debit, v_credit FROM abos.journal_lines WHERE journal_id = NEW.id;
  IF v_line_count <> v_source.line_count OR v_debit <> v_credit OR v_debit <> v_intent.base_amount THEN
    RAISE EXCEPTION 'operational journal must contain exactly % lines balanced to its intent amount', v_source.line_count
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM abos.journal_lines line
    JOIN abos.ledger_accounts ledger ON ledger.id = line.ledger_account_id
     AND ledger.legal_entity_id = line.legal_entity_id
    WHERE line.journal_id = NEW.id AND (
      line.processing_model <> 'OPERATIONAL_V1'
      OR line.legal_entity_id <> NEW.legal_entity_id
      OR line.base_currency_code <> NEW.base_currency_code
      OR line.original_currency_code IS DISTINCT FROM v_intent.original_currency_code
      OR line.conversion_snapshot_reference IS DISTINCT FROM v_intent.conversion_snapshot_reference
      OR line.source_type <> v_intent.source_type OR line.source_id <> v_intent.source_id
      OR ledger.status <> 'ACTIVE' OR NOT ledger.posting_allowed
      OR (ledger.requires_project AND line.project_id IS NULL)
      OR (ledger.requires_department AND line.department_id IS NULL)
      OR (ledger.requires_cost_center AND line.cost_center_id IS NULL)
      OR NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(CASE WHEN line.base_debit > 0 THEN v_source.debit_rules ELSE v_source.credit_rules END) rule
         WHERE rule->>'accountType' = ledger.account_type
           AND (NOT rule ? 'control' OR ledger.control_account_type IS NOT DISTINCT FROM rule->>'control'))
    )) OR (SELECT count(*) FROM abos.journal_lines line
            JOIN abos.ledger_accounts ledger ON ledger.id = line.ledger_account_id AND ledger.legal_entity_id = line.legal_entity_id
           WHERE line.journal_id = NEW.id) <> v_line_count THEN
    RAISE EXCEPTION 'operational journal line violates entity, currency, account or dimension rules'
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM abos.subledger_entries entry
    JOIN abos.journal_lines line ON line.id = entry.journal_line_id
    WHERE line.journal_id = NEW.id AND (
      entry.processing_model <> 'OPERATIONAL_V1'
      OR entry.legal_entity_id <> NEW.legal_entity_id
      OR entry.source_type <> v_intent.source_type OR entry.source_id <> v_intent.source_id
      OR entry.original_currency_code IS DISTINCT FROM v_intent.original_currency_code
      OR entry.base_currency_code <> NEW.base_currency_code
      OR abs(entry.base_amount) <> greatest(line.base_debit, line.base_credit)
      OR abs(entry.original_amount) IS DISTINCT FROM line.original_amount
      -- 0045: one sign convention for every subledger - debit = positive, credit = negative.
      OR sign(entry.base_amount) <> CASE WHEN line.base_debit > 0 THEN 1 ELSE -1 END
      OR sign(entry.original_amount) <> CASE WHEN line.base_debit > 0 THEN 1 ELSE -1 END
      OR NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_source.subledger_rules) rule
         WHERE rule->>'type' = entry.subledger_type
           AND rule->>'side' = CASE WHEN line.base_debit > 0 THEN 'DEBIT' ELSE 'CREDIT' END)
    )) OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_source.subledger_rules) rule
     WHERE (rule->>'required')::boolean AND NOT EXISTS (
       SELECT 1 FROM abos.subledger_entries entry JOIN abos.journal_lines line ON line.id = entry.journal_line_id
        WHERE line.journal_id = NEW.id AND entry.subledger_type = rule->>'type'
          AND rule->>'side' = CASE WHEN line.base_debit > 0 THEN 'DEBIT' ELSE 'CREDIT' END)) THEN
    RAISE EXCEPTION 'operational subledger movement violates its source, currency, amount or registered shape'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Static dispatch: one small validator per source. An ACTIVE source without an arm fails closed.
  CASE v_source.source_type
    WHEN 'OPERATIONAL_EXPENSE' THEN PERFORM abos.validate_expense_journal(NEW, v_intent);
    WHEN 'DIRECT_SHAREHOLDER_CAPITAL' THEN PERFORM abos.validate_direct_shareholder_capital_journal(NEW, v_intent);
    WHEN 'TEMPORARY_FUNDING' THEN PERFORM abos.validate_temporary_funding_journal(NEW, v_intent);
    WHEN 'TEMPORARY_FUNDING_SETTLEMENT' THEN PERFORM abos.validate_temporary_funding_settlement_journal(NEW, v_intent);
    WHEN 'OPENING_BALANCE' THEN PERFORM abos.validate_opening_balance_journal(NEW, v_intent);
    ELSE
      RAISE EXCEPTION 'operational posting source % has no validator', v_source.source_type
        USING ERRCODE = 'check_violation';
  END CASE;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION abos.posting_kernel_draft(p_intent_id uuid, p_journal_id uuid, p_legal_entity_id uuid, p_source_type text, p_source_id uuid, p_original_amount numeric, p_original_currency_code text, p_base_amount numeric, p_base_currency_code text, p_accounting_effective_date date, p_accounting_period_id uuid, p_journal_reference text, p_correlation_id uuid, p_idempotency_key text, p_initial_status text, p_created_by_user_account_id uuid, p_lines abos.posting_kernel_line[], p_project_id uuid DEFAULT NULL::uuid, p_department_id uuid DEFAULT NULL::uuid, p_cost_center_id uuid DEFAULT NULL::uuid, p_conversion_snapshot_reference text DEFAULT NULL::text, p_finance_workflow_policy_version_id uuid DEFAULT NULL::uuid, p_operational_version integer DEFAULT NULL::integer)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  v_source abos.posting_sources%ROWTYPE;
  v_line abos.posting_kernel_line;
  v_line_ids uuid[] := ARRAY[]::uuid[];
  v_index integer := 0;
BEGIN
  IF current_user <> 'abos_v1_operational_finance_owner' THEN
    RAISE EXCEPTION 'the posting kernel is internal' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO v_source FROM abos.posting_sources WHERE source_type = p_source_type;
  IF NOT FOUND OR v_source.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'posting source % is not active', p_source_type USING ERRCODE = 'check_violation';
  END IF;
  IF p_initial_status IS NULL OR p_initial_status NOT IN ('VALIDATED', 'APPROVED')
     OR p_original_amount IS NULL OR p_original_amount <= 0
     OR p_base_amount IS NULL OR p_base_amount <= 0
     OR p_lines IS NULL OR pg_catalog.cardinality(p_lines) <> v_source.line_count THEN
    RAISE EXCEPTION 'a posting needs positive amounts, a pre-posting status and exactly % lines', v_source.line_count
      USING ERRCODE = 'check_violation';
  END IF;
  FOREACH v_line IN ARRAY p_lines LOOP
    v_index := v_index + 1;
    IF v_line.line_number IS DISTINCT FROM v_index
       OR COALESCE(v_line.side NOT IN ('DEBIT', 'CREDIT'), true)
       OR v_line.ledger_account_id IS NULL
       OR (v_line.subledger_type IS NULL) <> (v_line.subledger_sign IS NULL)
       OR COALESCE(v_line.subledger_sign NOT IN (1, -1), false) THEN
      RAISE EXCEPTION 'posting line % is malformed', v_index USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;

  INSERT INTO abos.posting_intents
    (id, legal_entity_id, project_id, department_id, cost_center_id,
     source_type, source_id, intent_kind, original_amount, original_currency_code,
     base_amount, base_currency_code, conversion_snapshot_reference,
     accounting_effective_date, correlation_id, idempotency_key, status,
     created_by_user_account_id, processing_model,
     operational_expense_id, direct_capital_receipt_id, treasury_opening_balance_id,
     finance_workflow_policy_version_id, operational_version)
  VALUES
    (p_intent_id, p_legal_entity_id, p_project_id, p_department_id, p_cost_center_id,
     p_source_type, p_source_id, v_source.intent_kind, p_original_amount, p_original_currency_code,
     p_base_amount, p_base_currency_code, p_conversion_snapshot_reference,
     p_accounting_effective_date, p_correlation_id, p_idempotency_key, p_initial_status,
     p_created_by_user_account_id, 'OPERATIONAL_V1',
     CASE p_source_type WHEN 'OPERATIONAL_EXPENSE' THEN p_source_id END,
     CASE p_source_type WHEN 'DIRECT_SHAREHOLDER_CAPITAL' THEN p_source_id END,
     CASE p_source_type WHEN 'OPENING_BALANCE' THEN p_source_id END,
     p_finance_workflow_policy_version_id, p_operational_version);
  INSERT INTO abos.journals
    (id, legal_entity_id, accounting_period_id, posting_intent_id, journal_reference,
     accounting_effective_date, base_currency_code, status,
     created_by_user_account_id, processing_model)
  VALUES
    (p_journal_id, p_legal_entity_id, p_accounting_period_id, p_intent_id, p_journal_reference,
     p_accounting_effective_date, p_base_currency_code, 'DRAFT',
     p_created_by_user_account_id, 'OPERATIONAL_V1');

  FOREACH v_line IN ARRAY p_lines LOOP
    v_line_ids := v_line_ids || pg_catalog.gen_random_uuid();
    INSERT INTO abos.journal_lines
      (id, journal_id, legal_entity_id, line_number, ledger_account_id,
       business_party_id, project_id, department_id, cost_center_id,
       original_amount, original_currency_code, base_debit, base_credit,
       base_currency_code, conversion_snapshot_reference, source_type, source_id,
       processing_model)
    VALUES
      (v_line_ids[v_line.line_number], p_journal_id, p_legal_entity_id, v_line.line_number,
       v_line.ledger_account_id, v_line.business_party_id, v_line.project_id,
       v_line.department_id, v_line.cost_center_id, p_original_amount, p_original_currency_code,
       CASE v_line.side WHEN 'DEBIT' THEN p_base_amount ELSE 0 END,
       CASE v_line.side WHEN 'CREDIT' THEN p_base_amount ELSE 0 END,
       p_base_currency_code, p_conversion_snapshot_reference, p_source_type, p_source_id,
       'OPERATIONAL_V1');
  END LOOP;
  FOREACH v_line IN ARRAY p_lines LOOP
    CONTINUE WHEN v_line.subledger_type IS NULL;
    INSERT INTO abos.subledger_entries
      (id, legal_entity_id, journal_line_id, subledger_type, operational_treasury_account_id,
       business_party_id, original_amount, original_currency_code, base_amount, base_currency_code,
       source_type, source_id, processing_model, direct_capital_receipt_id)
    VALUES
      (pg_catalog.gen_random_uuid(), p_legal_entity_id, v_line_ids[v_line.line_number],
       v_line.subledger_type, v_line.operational_treasury_account_id,
       v_line.subledger_business_party_id,
       CASE v_line.subledger_sign WHEN -1 THEN -p_original_amount ELSE p_original_amount END,
       p_original_currency_code,
       CASE v_line.subledger_sign WHEN -1 THEN -p_base_amount ELSE p_base_amount END,
       p_base_currency_code, p_source_type, p_source_id, 'OPERATIONAL_V1',
       CASE p_source_type WHEN 'DIRECT_SHAREHOLDER_CAPITAL' THEN p_source_id END);
  END LOOP;
END
$function$;

CREATE OR REPLACE FUNCTION abos.coa_validate(p_code text, p_name text, p_name_fa text, p_description text, p_type text, p_control text, p_currency text, p_posting boolean, p_status text)
 RETURNS void
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  IF p_code IS NULL OR p_code !~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,31}$' THEN
    RAISE EXCEPTION 'the account code must be 1-32 letters, digits or . _ / - and start with a letter or digit'
      USING ERRCODE = 'check_violation';
  END IF;
  IF p_name IS NULL OR length(p_name) NOT BETWEEN 2 AND 120 THEN
    RAISE EXCEPTION 'the account name must be 2-120 characters' USING ERRCODE = 'check_violation';
  END IF;
  IF p_name_fa IS NOT NULL AND length(p_name_fa) > 120 THEN
    RAISE EXCEPTION 'the Dari account name must be at most 120 characters' USING ERRCODE = 'check_violation';
  END IF;
  IF p_description IS NOT NULL AND length(p_description) > 500 THEN
    RAISE EXCEPTION 'the description must be at most 500 characters' USING ERRCODE = 'check_violation';
  END IF;
  IF p_type IS NULL OR p_type NOT IN ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE') THEN
    RAISE EXCEPTION 'the account type must be ASSET, LIABILITY, EQUITY, REVENUE or EXPENSE' USING ERRCODE = 'check_violation';
  END IF;
  IF p_control IS NOT NULL AND p_control NOT IN ('CASH', 'SARAF', 'SHAREHOLDER_CAPITAL', 'SHAREHOLDER_LOAN', 'AR', 'AP', 'OTHER',
                                                 'TEMPORARY_FUNDING_PAYABLE', 'SHAREHOLDER_CONTRIBUTED_ASSETS', 'OPENING_BALANCE_EQUITY') THEN
    RAISE EXCEPTION 'unknown control account type %', p_control USING ERRCODE = 'check_violation';
  END IF;
  -- A control account must carry the account type its balance has by definition.
  IF (p_control IN ('CASH', 'AR', 'SHAREHOLDER_CONTRIBUTED_ASSETS') AND p_type <> 'ASSET')
     OR (p_control IN ('AP', 'SHAREHOLDER_LOAN', 'TEMPORARY_FUNDING_PAYABLE') AND p_type <> 'LIABILITY')
     OR (p_control IN ('SHAREHOLDER_CAPITAL', 'OPENING_BALANCE_EQUITY') AND p_type <> 'EQUITY')
     OR (p_control = 'SARAF' AND p_type NOT IN ('ASSET', 'LIABILITY')) THEN
    RAISE EXCEPTION 'a % control account cannot have account type %', p_control, p_type USING ERRCODE = 'check_violation';
  END IF;
  IF p_posting IS NULL THEN
    RAISE EXCEPTION 'say whether the account accepts postings' USING ERRCODE = 'check_violation';
  END IF;
  -- Currencies are never combined: an account that takes postings, or a control account, has one.
  IF p_currency IS NULL AND (p_posting OR p_control IS NOT NULL) THEN
    RAISE EXCEPTION 'an account that accepts postings, or a control account, needs a currency' USING ERRCODE = 'check_violation';
  END IF;
  IF p_currency IS NOT NULL AND p_status = 'ACTIVE'
     AND NOT EXISTS (SELECT 1 FROM abos.currencies c WHERE c.code = p_currency AND c.enabled) THEN
    RAISE EXCEPTION 'currency % is not enabled', p_currency USING ERRCODE = 'check_violation';
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION abos.guard_operational_treasury_account()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
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
    -- 0046: CLOSED is terminal and reached only at a zero book balance.
    IF OLD.status = 'CLOSED' THEN
      RAISE EXCEPTION 'a closed Treasury account cannot change' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status = 'CLOSED' AND (SELECT balance.book_balance
         FROM abos.treasury_account_balances(NEW.legal_entity_id, NULL, NEW.id) balance) <> 0 THEN
      RAISE EXCEPTION 'a Treasury account can be closed only at a zero book balance' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.status = 'CLOSED' THEN
    RAISE EXCEPTION 'a Treasury account is created ACTIVE or INACTIVE' USING ERRCODE = 'check_violation';
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
$function$;

-- ---------------------------------------------------------------------------------------------
-- 8. Privileges. Internal helpers run with their caller's rights and only the operational Finance
--    owner may call them; the three entry points are SECURITY DEFINER functions of that owner,
--    callable only by the Finance runtime, and check the signed-in person's authority first.
-- ---------------------------------------------------------------------------------------------

REVOKE ALL ON TABLE abos.treasury_opening_balances, abos.operational_treasury_account_responsibles,
  abos.treasury_account_legacy_links FROM PUBLIC;
-- Column-level writes only, like every other table the operational Finance owner writes.
GRANT SELECT ON abos.treasury_opening_balances, abos.operational_treasury_account_responsibles TO abos_v1_operational_finance_owner;
GRANT INSERT (id, legal_entity_id, operational_treasury_account_id, currency_code, amount, as_of_date, reference, note,
  transaction_reference, equity_ledger_account_id, journal_id, created_by_user_account_id, correlation_id, idempotency_key)
  ON abos.treasury_opening_balances TO abos_v1_operational_finance_owner;
GRANT INSERT (legal_entity_id, operational_treasury_account_id, user_account_id, assigned_by_user_account_id)
  ON abos.operational_treasury_account_responsibles TO abos_v1_operational_finance_owner;
GRANT UPDATE (revoked_at, revoked_by_user_account_id) ON abos.operational_treasury_account_responsibles
  TO abos_v1_operational_finance_owner;
GRANT SELECT ON abos.treasury_account_legacy_links TO abos_v1_operational_finance_owner;
GRANT SELECT (treasury_opening_balance_id), INSERT (treasury_opening_balance_id) ON abos.posting_intents
  TO abos_v1_operational_finance_owner;

REVOKE ALL ON FUNCTION
  abos.treasury_safe_actor(text, text, text, text),
  abos.opening_balance_equity_status(uuid, text),
  abos.opening_balance_equity_account(uuid, text),
  abos.validate_opening_balance_journal(abos.journals, abos.posting_intents),
  abos.treasury_opening_balance_record(text, text, text, jsonb),
  abos.treasury_safes_workspace(text, text, text),
  abos.treasury_safe_responsibles_set(text, text, text, jsonb)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  abos.treasury_safe_actor(text, text, text, text),
  abos.opening_balance_equity_status(uuid, text),
  abos.opening_balance_equity_account(uuid, text),
  abos.validate_opening_balance_journal(abos.journals, abos.posting_intents)
  TO abos_v1_operational_finance_owner;
ALTER FUNCTION abos.treasury_opening_balance_record(text, text, text, jsonb) OWNER TO abos_v1_operational_finance_owner;
ALTER FUNCTION abos.treasury_safes_workspace(text, text, text) OWNER TO abos_v1_operational_finance_owner;
ALTER FUNCTION abos.treasury_safe_responsibles_set(text, text, text, jsonb) OWNER TO abos_v1_operational_finance_owner;
REVOKE ALL ON FUNCTION
  abos.treasury_opening_balance_record(text, text, text, jsonb),
  abos.treasury_safes_workspace(text, text, text),
  abos.treasury_safe_responsibles_set(text, text, text, jsonb)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  abos.treasury_opening_balance_record(text, text, text, jsonb),
  abos.treasury_safes_workspace(text, text, text),
  abos.treasury_safe_responsibles_set(text, text, text, jsonb)
  TO abos_e1_runtime;
