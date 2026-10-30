-- 0051: Slice 6 — FX policy and AFN operational posting, through the one posting kernel and the one Treasury model.
--
-- 1. Permission finance.fx-policy.manage (catalogue v14) and the Chart of Accounts control FX_DIFFERENCE (an income or
--    expense account in the accounting currency). No account is ever created by the system.
-- 2. FX policy per legal entity and currency (append-only versions): the scale of the converted accounting amount, the
--    rounding mode (HALF_UP, the default; or EXACT_ONLY) and the FX difference account, effective from a business date.
--    With no saved version the default applies: HALF_UP to 2 decimal places, and the one active FX_DIFFERENCE account.
--    A foreign-currency posting is refused with a setup error while the FX difference account is missing or ambiguous.
-- 3. One conversion for every lane: abos.fx_convert takes the day's immutable rate snapshot (0016), applies the policy
--    in exact decimal arithmetic (no floating point) and records an immutable abos.fx_conversions row: the native amount
--    and currency, the exact accounting amount, the rounded accounting amount, the rounding residual, the policy
--    version and the FX difference account.
-- 4. Receipts, payments, same-currency transfers, opening balances and expenses post in a non-base currency (AFN): the
--    lines and Treasury movements keep the native amount and currency, the accounting amount and the snapshot
--    reference. A transfer between accounts of different currencies stays refused (a currency exchange is a later slice).
-- 5. Each journal uses one snapshot for all its lines, so every journal balances in the accounting currency and no
--    posting in this slice produces an FX difference; the account is resolved and recorded on every conversion so the
--    exchange and revaluation lanes post into the configured account.
-- No existing row is changed and no journal is created by this migration.

-- ---------------------------------------------------------------------------------------------
-- 1. Permission and control type.
-- ---------------------------------------------------------------------------------------------
INSERT INTO abos.permission_catalogue
  (permission_code, catalogue_version, category, availability, independence_enforced, administrative, sort_order)
SELECT 'finance.fx-policy.manage', 14, 'FINANCE', 'ACTIVE', false, false, (SELECT max(sort_order) FROM abos.permission_catalogue) + 1;

ALTER TABLE abos.ledger_accounts DROP CONSTRAINT ledger_accounts_control_account_type_check;
ALTER TABLE abos.ledger_accounts ADD CONSTRAINT ledger_accounts_control_account_type_check CHECK (
  control_account_type IS NULL OR control_account_type = ANY (ARRAY['CASH', 'SHAREHOLDER_CAPITAL', 'SHAREHOLDER_LOAN',
    'AR', 'AP', 'SARAF', 'OTHER', 'TEMPORARY_FUNDING_PAYABLE', 'SHAREHOLDER_CONTRIBUTED_ASSETS', 'OPENING_BALANCE_EQUITY',
    'FX_DIFFERENCE']));

-- ---------------------------------------------------------------------------------------------
-- 2. FX policy versions (append-only) and immutable conversions.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE abos.fx_policy_versions (
  id uuid PRIMARY KEY,
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  currency_code text NOT NULL REFERENCES abos.currencies(code),
  version integer NOT NULL CHECK (version >= 1),
  effective_from date NOT NULL,
  base_scale integer NOT NULL CHECK (base_scale BETWEEN 0 AND 6),
  rounding_mode text NOT NULL CHECK (rounding_mode IN ('HALF_UP', 'EXACT_ONLY')),
  fx_difference_ledger_account_id uuid NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 5 AND 500),
  created_by_user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  correlation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (legal_entity_id, currency_code, version),
  UNIQUE (id, legal_entity_id),
  FOREIGN KEY (fx_difference_ledger_account_id, legal_entity_id) REFERENCES abos.ledger_accounts(id, legal_entity_id)
);

CREATE TABLE abos.fx_conversions (
  id uuid PRIMARY KEY,
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  source_type text NOT NULL CHECK (source_type IN ('CASH_RECEIPT', 'PAYMENT', 'TREASURY_TRANSFER', 'OPENING_BALANCE', 'OPERATIONAL_EXPENSE')),
  source_id uuid NOT NULL,
  exchange_rate_snapshot_id uuid NOT NULL UNIQUE REFERENCES abos.exchange_rate_snapshots(id),
  fx_policy_version_id uuid,
  rounding_mode text NOT NULL CHECK (rounding_mode IN ('HALF_UP', 'EXACT_ONLY')),
  base_scale integer NOT NULL CHECK (base_scale BETWEEN 0 AND 6),
  fx_difference_ledger_account_id uuid NOT NULL,
  original_amount numeric NOT NULL CHECK (original_amount > 0),
  original_currency_code text NOT NULL REFERENCES abos.currencies(code),
  base_currency_code text NOT NULL REFERENCES abos.currencies(code),
  -- The unrounded accounting amount: exact for a direct rate; 20 decimal places for an inverse rate.
  exact_base_amount numeric NOT NULL,
  base_amount numeric NOT NULL CHECK (base_amount > 0),
  rounding_difference numeric NOT NULL,
  created_by_user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (source_type, source_id),
  FOREIGN KEY (fx_policy_version_id, legal_entity_id) REFERENCES abos.fx_policy_versions(id, legal_entity_id),
  FOREIGN KEY (fx_difference_ledger_account_id, legal_entity_id) REFERENCES abos.ledger_accounts(id, legal_entity_id),
  CHECK (original_currency_code <> base_currency_code),
  CHECK (rounding_difference = base_amount - exact_base_amount)
);
CREATE INDEX fx_conversions_entity_source_idx ON abos.fx_conversions (legal_entity_id, source_type);

CREATE FUNCTION abos.fx_append_only() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable; record a new version instead', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END
$$;
CREATE TRIGGER fx_policy_versions_no_update_or_delete BEFORE UPDATE OR DELETE ON abos.fx_policy_versions
  FOR EACH ROW EXECUTE FUNCTION abos.fx_append_only();
CREATE TRIGGER fx_conversions_no_update_or_delete BEFORE UPDATE OR DELETE ON abos.fx_conversions
  FOR EACH ROW EXECUTE FUNCTION abos.fx_append_only();
CREATE TRIGGER fx_policy_versions_no_truncate BEFORE TRUNCATE ON abos.fx_policy_versions
  FOR EACH STATEMENT EXECUTE FUNCTION abos.fx_append_only();
CREATE TRIGGER fx_conversions_no_truncate BEFORE TRUNCATE ON abos.fx_conversions
  FOR EACH STATEMENT EXECUTE FUNCTION abos.fx_append_only();

-- Snapshots may now belong to the Treasury lanes too.
ALTER TABLE abos.exchange_rate_snapshots
  DROP CONSTRAINT exchange_rate_snapshots_source_type_check,
  ADD CONSTRAINT exchange_rate_snapshots_source_type_check
    CHECK (source_type IN ('CAPITAL_RECEIPT_INTENT', 'OPERATIONAL_EXPENSE', 'CASH_RECEIPT', 'PAYMENT', 'TREASURY_TRANSFER', 'OPENING_BALANCE'));

-- The accounting amount and the conversion of each Treasury movement (NULL on rows recorded before 0051, which are
-- all in the accounting currency and keep amount = accounting amount).
ALTER TABLE abos.treasury_cash_receipts ADD COLUMN base_amount numeric CHECK (base_amount > 0),
  ADD COLUMN fx_conversion_id uuid UNIQUE REFERENCES abos.fx_conversions(id);
ALTER TABLE abos.treasury_payments ADD COLUMN base_amount numeric CHECK (base_amount > 0),
  ADD COLUMN fx_conversion_id uuid UNIQUE REFERENCES abos.fx_conversions(id);
ALTER TABLE abos.treasury_transfers ADD COLUMN base_amount numeric CHECK (base_amount > 0),
  ADD COLUMN fx_conversion_id uuid UNIQUE REFERENCES abos.fx_conversions(id);
ALTER TABLE abos.treasury_opening_balances ADD COLUMN base_amount numeric CHECK (base_amount > 0),
  ADD COLUMN fx_conversion_id uuid UNIQUE REFERENCES abos.fx_conversions(id);

-- ---------------------------------------------------------------------------------------------
-- 3. Policy resolution and conversion (internal helpers, caller's rights).
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION abos.fx_difference_status(p_entity uuid, p_base text)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $status$
  WITH candidate AS (
    SELECT id, account_code, account_name, account_type, posting_allowed, account_currency_code,
           requires_project, requires_department, requires_cost_center
      FROM abos.ledger_accounts
     WHERE legal_entity_id = p_entity AND control_account_type = 'FX_DIFFERENCE' AND status = 'ACTIVE')
  SELECT CASE (SELECT count(*) FROM candidate)
    WHEN 0 THEN jsonb_build_object('status', 'MISSING', 'count', 0)
    WHEN 1 THEN (SELECT jsonb_build_object(
      'status', CASE WHEN account_type IN ('REVENUE', 'EXPENSE') AND posting_allowed AND account_currency_code IS NOT DISTINCT FROM p_base
                      AND NOT requires_project AND NOT requires_department AND NOT requires_cost_center THEN 'READY' ELSE 'INVALID' END,
      'count', 1,
      'account', jsonb_build_object('id', id, 'code', account_code, 'name', account_name, 'currency', account_currency_code))
      FROM candidate)
    ELSE jsonb_build_object('status', 'AMBIGUOUS', 'count', (SELECT count(*) FROM candidate))
  END
$status$;

-- An account a policy may name: an active FX_DIFFERENCE income or expense account in the accounting currency.
CREATE FUNCTION abos.fx_difference_account_ready(p_entity uuid, p_account uuid, p_base text)
RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $ready$
  SELECT EXISTS (SELECT 1 FROM abos.ledger_accounts WHERE id = p_account AND legal_entity_id = p_entity
    AND control_account_type = 'FX_DIFFERENCE' AND status = 'ACTIVE' AND posting_allowed AND account_type IN ('REVENUE', 'EXPENSE')
    AND account_currency_code IS NOT DISTINCT FROM p_base AND NOT requires_project AND NOT requires_department AND NOT requires_cost_center)
$ready$;

-- The policy in force for a currency on a business day: the highest saved version effective on or before that day, or
-- the default (HALF_UP to 2 decimal places, the one active FX_DIFFERENCE account). Raises the setup error otherwise.
CREATE FUNCTION abos.fx_policy_resolve(p_entity uuid, p_currency text, p_day date)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $resolve$
DECLARE base text; v abos.fx_policy_versions%ROWTYPE; st jsonb;
BEGIN
  SELECT base_currency_code INTO base FROM abos.legal_entities WHERE id = p_entity AND currency_policy_status = 'APPROVED';
  IF base IS NULL THEN
    RAISE EXCEPTION 'the company has no approved accounting currency' USING ERRCODE = 'check_violation';
  END IF;
  IF p_currency IS NULL OR p_currency = base THEN
    RAISE EXCEPTION 'an FX policy applies to a currency other than the accounting currency' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v FROM abos.fx_policy_versions
   WHERE legal_entity_id = p_entity AND currency_code = p_currency AND effective_from <= p_day
   ORDER BY version DESC LIMIT 1;
  IF FOUND THEN
    IF NOT abos.fx_difference_account_ready(p_entity, v.fx_difference_ledger_account_id, base) THEN
      RAISE EXCEPTION 'FX setup: the FX difference account named by the % policy is no longer an active FX difference account in %; save a new % policy',
        p_currency, base, p_currency USING ERRCODE = 'check_violation';
    END IF;
    RETURN jsonb_build_object('versionId', v.id, 'version', v.version, 'effectiveFrom', v.effective_from, 'roundingMode', v.rounding_mode,
      'baseScale', v.base_scale, 'fxDifferenceAccountId', v.fx_difference_ledger_account_id, 'isDefault', false);
  END IF;
  st := abos.fx_difference_status(p_entity, base);
  IF st->>'status' = 'MISSING' THEN
    RAISE EXCEPTION 'FX setup: no FX difference account. Create one active income or expense account in % with control FX_DIFFERENCE before posting in %',
      base, p_currency USING ERRCODE = 'check_violation';
  ELSIF st->>'status' = 'AMBIGUOUS' THEN
    RAISE EXCEPTION 'FX setup: % active accounts carry control FX_DIFFERENCE; save an FX policy for % that names one',
      st->>'count', p_currency USING ERRCODE = 'check_violation';
  ELSIF st->>'status' <> 'READY' THEN
    RAISE EXCEPTION 'FX setup: the FX difference account must be an income or expense account in % that accepts postings without dimensions',
      base USING ERRCODE = 'check_violation';
  END IF;
  RETURN jsonb_build_object('versionId', NULL, 'version', 0, 'effectiveFrom', NULL, 'roundingMode', 'HALF_UP', 'baseScale', 2,
    'fxDifferenceAccountId', st->'account'->>'id', 'isDefault', true);
END
$resolve$;

-- Exact decimal conversion of a positive native amount with a rate snapshot and a policy. HALF_UP rounds a half away
-- from zero; for an inverse rate it is computed by integer division, never from a truncated quotient.
CREATE FUNCTION abos.fx_amount(p_amount numeric, p_currency text, p_base text, p_unit text, p_quote text, p_rate numeric,
  p_scale integer, p_mode text)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $amount$
DECLARE exact numeric; result numeric; factor numeric := 10::numeric ^ p_scale;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 OR p_rate IS NULL OR p_rate <= 0 THEN
    RAISE EXCEPTION 'a conversion needs a positive amount and rate' USING ERRCODE = 'check_violation';
  END IF;
  IF p_unit = p_currency AND p_quote = p_base THEN
    exact := p_amount * p_rate;
    result := round(exact, p_scale);
    IF p_mode = 'EXACT_ONLY' AND result <> exact THEN
      RAISE EXCEPTION 'the % amount is not exact to % decimal places at this rate, and the % FX policy is exact-only',
        p_base, p_scale, p_currency USING ERRCODE = 'check_violation';
    END IF;
  ELSIF p_quote = p_currency AND p_unit = p_base THEN
    result := round(div(2 * p_amount * factor + p_rate, 2 * p_rate) / factor, p_scale);
    exact := round(p_amount / p_rate, 20);
    IF p_mode = 'EXACT_ONLY' AND result * p_rate <> p_amount THEN
      RAISE EXCEPTION 'the % amount is not exact to % decimal places at this rate, and the % FX policy is exact-only',
        p_base, p_scale, p_currency USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    RAISE EXCEPTION 'the exchange rate does not convert % to %', p_currency, p_base USING ERRCODE = 'check_violation';
  END IF;
  IF result <= 0 THEN
    RAISE EXCEPTION 'the amount is too small to convert: it rounds to zero %', p_base USING ERRCODE = 'check_violation';
  END IF;
  RETURN jsonb_build_object('exact', exact::text, 'base', result::text, 'difference', (result - exact)::text);
END
$amount$;

-- Captures the day's rate snapshot for the source and records the conversion. The setup check runs first, so a missing
-- FX difference account refuses before anything is written.
CREATE FUNCTION abos.fx_convert(p_entity uuid, p_source_type text, p_source_id uuid, p_currency text, p_day date,
  p_exchange_rate_id uuid, p_actor uuid, p_amount numeric)
RETURNS abos.fx_conversions LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $convert$
DECLARE base text; policy jsonb; snapshot_id uuid; snapshot abos.exchange_rate_snapshots%ROWTYPE; amounts jsonb;
  conversion abos.fx_conversions%ROWTYPE;
BEGIN
  SELECT base_currency_code INTO base FROM abos.legal_entities WHERE id = p_entity AND currency_policy_status = 'APPROVED';
  policy := abos.fx_policy_resolve(p_entity, p_currency, p_day);
  snapshot_id := abos.capture_exchange_rate_snapshot(p_entity, p_source_type, p_source_id, p_currency, p_day, p_exchange_rate_id, p_actor);
  SELECT * INTO snapshot FROM abos.exchange_rate_snapshots WHERE id = snapshot_id;
  amounts := abos.fx_amount(p_amount, p_currency, base, snapshot.unit_currency_code, snapshot.quote_currency_code, snapshot.rate_value,
    (policy->>'baseScale')::integer, policy->>'roundingMode');
  INSERT INTO abos.fx_conversions (id, legal_entity_id, source_type, source_id, exchange_rate_snapshot_id, fx_policy_version_id,
    rounding_mode, base_scale, fx_difference_ledger_account_id, original_amount, original_currency_code, base_currency_code,
    exact_base_amount, base_amount, rounding_difference, created_by_user_account_id)
  VALUES (gen_random_uuid(), p_entity, p_source_type, p_source_id, snapshot.id, (policy->>'versionId')::uuid,
    policy->>'roundingMode', (policy->>'baseScale')::integer, (policy->>'fxDifferenceAccountId')::uuid, p_amount, p_currency, base,
    (amounts->>'exact')::numeric, (amounts->>'base')::numeric, (amounts->>'difference')::numeric, p_actor)
  RETURNING * INTO conversion;
  RETURN conversion;
END
$convert$;

-- The accounting currency of a movement, which may now be in any enabled currency (the kernel and the validators
-- carry the native amount, the accounting amount and the snapshot).
CREATE FUNCTION abos.money_currency_base(p_entity uuid, p_currency text)
RETURNS text LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $base$
DECLARE v_base text;
BEGIN
  SELECT base_currency_code INTO v_base FROM abos.legal_entities WHERE id = p_entity AND currency_policy_status = 'APPROVED';
  IF v_base IS NULL THEN
    RAISE EXCEPTION 'the company has no approved accounting currency' USING ERRCODE = 'check_violation';
  END IF;
  IF p_currency IS NULL OR NOT EXISTS (SELECT 1 FROM abos.currencies WHERE code = p_currency AND enabled) THEN
    RAISE EXCEPTION 'choose an enabled currency' USING ERRCODE = 'check_violation';
  END IF;
  RETURN v_base;
END
$base$;

-- A validator's check that a source's accounting amount and conversion agree with its intent: the same amount without
-- a snapshot in the accounting currency, otherwise its own immutable conversion and snapshot.
CREATE FUNCTION abos.fx_source_matches(p_entity uuid, p_source_type text, p_source_id uuid, p_currency text, p_amount numeric,
  p_base_amount numeric, p_conversion uuid, p_intent abos.posting_intents)
RETURNS boolean LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $matches$
DECLARE base text; c abos.fx_conversions%ROWTYPE; s abos.exchange_rate_snapshots%ROWTYPE;
BEGIN
  SELECT base_currency_code INTO base FROM abos.legal_entities WHERE id = p_entity;
  IF p_base_amount IS NULL OR p_intent.base_amount IS DISTINCT FROM p_base_amount OR p_intent.base_currency_code IS DISTINCT FROM base
     OR p_intent.original_amount IS DISTINCT FROM p_amount OR p_intent.original_currency_code IS DISTINCT FROM p_currency THEN
    RETURN false;
  END IF;
  IF p_currency = base THEN
    RETURN p_conversion IS NULL AND p_base_amount = p_amount AND p_intent.conversion_snapshot_reference IS NULL;
  END IF;
  SELECT * INTO c FROM abos.fx_conversions WHERE id = p_conversion AND legal_entity_id = p_entity;
  IF NOT FOUND OR c.source_type <> p_source_type OR c.source_id <> p_source_id OR c.original_amount <> p_amount
     OR c.original_currency_code <> p_currency OR c.base_currency_code <> base OR c.base_amount <> p_base_amount
     OR p_intent.conversion_snapshot_reference IS DISTINCT FROM c.exchange_rate_snapshot_id::text THEN
    RETURN false;
  END IF;
  SELECT * INTO s FROM abos.exchange_rate_snapshots WHERE id = c.exchange_rate_snapshot_id AND legal_entity_id = p_entity;
  RETURN FOUND AND s.source_type = p_source_type AND s.source_id = p_source_id AND s.transaction_currency_code = p_currency
     AND s.base_currency_code = base AND s.rate_date = p_intent.accounting_effective_date;
END
$matches$;


-- ---------------------------------------------------------------------------------------------
-- 4. Restated: the Chart of Accounts rule for the new control, and the actor allowlist.
-- ---------------------------------------------------------------------------------------------

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
                                                 'TEMPORARY_FUNDING_PAYABLE', 'SHAREHOLDER_CONTRIBUTED_ASSETS', 'OPENING_BALANCE_EQUITY',
                                                 'FX_DIFFERENCE') THEN
    RAISE EXCEPTION 'unknown control account type %', p_control USING ERRCODE = 'check_violation';
  END IF;
  -- A control account must carry the account type its balance has by definition.
  IF (p_control IN ('CASH', 'AR', 'SHAREHOLDER_CONTRIBUTED_ASSETS') AND p_type <> 'ASSET')
     OR (p_control IN ('AP', 'SHAREHOLDER_LOAN', 'TEMPORARY_FUNDING_PAYABLE') AND p_type <> 'LIABILITY')
     OR (p_control IN ('SHAREHOLDER_CAPITAL', 'OPENING_BALANCE_EQUITY') AND p_type <> 'EQUITY')
     OR (p_control = 'SARAF' AND p_type NOT IN ('ASSET', 'LIABILITY'))
     OR (p_control = 'FX_DIFFERENCE' AND p_type NOT IN ('REVENUE', 'EXPENSE')) THEN
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

CREATE OR REPLACE FUNCTION abos.operational_finance_actor(p_identity_proof text, p_runtime_token_sha256 text, p_token_sha256 text, p_required_permission text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE actor_context jsonb;
BEGIN
  IF p_required_permission IS NOT NULL AND p_required_permission NOT IN (
    'treasury.operational-account.manage', 'finance.expense-category.manage',
    'finance.expense.create', 'finance.expense.read', 'finance.expense.approve',
    'finance.period.manage', 'shareholder.capital-receipt.read',
    'shareholder.capital-receipt.record', 'treasury.capital-receipt.verify',
    'finance.capital-receipt.configure', 'finance.capital-receipt.prepare',
    'finance.capital-receipt.approve', 'finance.capital-receipt.post',
    'finance.temporary-funding.read', 'finance.temporary-funding.record',
    'finance.temporary-funding.approve', 'finance.temporary-funding.settle',
    'finance.temporary-funding.settle-approve', 'finance.temporary-funding.configure',
    'finance.period.reopen', 'finance.reversal.direct', 'finance.reversal.request', 'finance.reversal.approve',
    'finance.fx-policy.manage'
  ) THEN
    RAISE EXCEPTION 'unsupported operational Finance permission'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  actor_context := abos.identity_actor_context(
    p_identity_proof, p_runtime_token_sha256, p_token_sha256);
  IF actor_context IS NULL
     OR COALESCE((actor_context ->> 'live')::boolean, false) IS NOT TRUE
     OR actor_context ->> 'status' IS DISTINCT FROM 'ACTIVE'
     OR COALESCE((actor_context ->> 'mustChangePassword')::boolean, false) IS TRUE THEN
    RAISE EXCEPTION 'sign in with an active account to continue'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_required_permission IS NOT NULL
     AND NOT COALESCE(actor_context -> 'permissions', '[]'::jsonb) ? p_required_permission THEN
    RAISE EXCEPTION 'current authority is missing %', p_required_permission
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN actor_context;
END
$function$;


-- ---------------------------------------------------------------------------------------------
-- 5. Restated money writers: any enabled currency; a non-base movement converts through fx_convert and posts its
--    native amount, its accounting amount and its snapshot reference through the kernel.
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION abos.treasury_receipt_record(p_proof text, p_runtime text, p_token text, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE c jsonb; actor uuid; entity uuid; req jsonb; amount numeric; day date; key text; correlation uuid; currency text; base text;
  v_account abos.operational_treasury_accounts%ROWTYPE; revenue uuid; party uuid; payer text; policy uuid; period uuid;
  scope text; fingerprint text; replay jsonb; ref text; result jsonb; v_base_amount numeric; v_conversion abos.fx_conversions%ROWTYPE;
  receipt uuid := gen_random_uuid(); journal uuid := gen_random_uuid(); intent uuid := gen_random_uuid();
BEGIN
  c := abos.treasury_safe_actor(p_proof, p_runtime, p_token, 'treasury.receipt.record');
  actor := (c->>'userAccountId')::uuid; entity := (c->>'legalEntityId')::uuid;
  req := abos.money_request(p_payload, ARRAY['treasuryAccountId', 'amount', 'currencyCode', 'businessDate', 'payerBusinessPartyId',
    'payerName', 'revenueLedgerAccountId', 'reference', 'note', 'idempotencyKey', 'correlationId', 'exchangeRateId']);
  amount := (req->>'amount')::numeric; day := (req->>'date')::date; key := req->>'key'; correlation := (req->>'correlation')::uuid;
  currency := p_payload->>'currencyCode'; party := abos.money_uuid(p_payload, 'payerBusinessPartyId');
  payer := NULLIF(btrim(p_payload->>'payerName'), ''); revenue := abos.money_uuid(p_payload, 'revenueLedgerAccountId');
  IF abos.money_uuid(p_payload, 'treasuryAccountId') IS NULL OR revenue IS NULL THEN
    RAISE EXCEPTION 'choose the Safe and the income account' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM abos.money_party(entity, party, payer);
  scope := 'treasury:receipt:' || entity::text || ':' || actor::text;
  fingerprint := encode(sha256(convert_to((p_payload - 'correlationId')::text || actor::text, 'UTF8')), 'hex');
  replay := abos.temporary_funding_idempotency_begin(scope, key, fingerprint, correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  base := abos.money_currency_base(entity, currency);
  v_account := abos.money_treasury_account(entity, abos.money_uuid(p_payload, 'treasuryAccountId'), currency);
  IF NOT EXISTS (SELECT 1 FROM abos.ledger_accounts WHERE id = revenue AND legal_entity_id = entity AND status = 'ACTIVE' AND posting_allowed
       AND account_type = 'REVENUE' AND control_account_type IS NULL AND account_currency_code IS NOT DISTINCT FROM base
       AND NOT requires_project AND NOT requires_department AND NOT requires_cost_center) THEN
    RAISE EXCEPTION 'choose an active income account in the accounting currency' USING ERRCODE = 'check_violation';
  END IF;
  policy := abos.money_movement_policy(entity, 'OTHER_INCOME');
  period := abos.open_period_for_business_date(entity, actor, day);
  IF currency = base THEN
    v_base_amount := amount;
  ELSE
    v_conversion := abos.fx_convert(entity, 'CASH_RECEIPT', receipt, currency, day, abos.money_uuid(p_payload, 'exchangeRateId'), actor, amount);
    v_base_amount := v_conversion.base_amount;
  END IF;
  ref := 'RC-' || to_char(day, 'YYYYMMDD') || '-' || upper(replace(receipt::text, '-', ''));
  INSERT INTO abos.treasury_cash_receipts (id, legal_entity_id, operational_treasury_account_id, currency_code, amount, business_date,
    payer_business_party_id, payer_name, revenue_ledger_account_id, reference, note, transaction_reference, workflow_policy_version_id,
    journal_id, created_by_user_account_id, correlation_id, idempotency_key, base_amount, fx_conversion_id)
  VALUES (receipt, entity, v_account.id, currency, amount, day, party, payer, revenue, NULLIF(btrim(p_payload->>'reference'), ''),
    NULLIF(btrim(p_payload->>'note'), ''), ref, policy, journal, actor, correlation, key, v_base_amount, v_conversion.id);
  PERFORM abos.posting_kernel_draft(
    p_intent_id => intent, p_journal_id => journal, p_legal_entity_id => entity, p_source_type => 'CASH_RECEIPT', p_source_id => receipt,
    p_original_amount => amount, p_original_currency_code => currency, p_base_amount => v_base_amount, p_base_currency_code => base,
    p_accounting_effective_date => day, p_accounting_period_id => period, p_journal_reference => ref, p_correlation_id => correlation,
    p_idempotency_key => 'RC:' || receipt::text, p_initial_status => 'VALIDATED', p_created_by_user_account_id => actor,
    p_lines => ARRAY[
      ROW(1, 'DEBIT', v_account.ledger_account_id, NULL, NULL, NULL, NULL, 'OPERATIONAL_TREASURY', 1, v_account.id, NULL)::abos.posting_kernel_line,
      ROW(2, 'CREDIT', revenue, party, NULL, NULL, NULL, NULL, NULL, NULL, NULL)::abos.posting_kernel_line],
    p_conversion_snapshot_reference => v_conversion.exchange_rate_snapshot_id::text, p_finance_workflow_policy_version_id => policy);
  PERFORM abos.posting_kernel_commit(intent, journal, actor);
  result := jsonb_build_object('movementId', receipt, 'journalId', journal, 'reference', ref, 'currencyCode', currency, 'amount', amount::text,
    'baseAmount', v_base_amount::text, 'fxConversionId', v_conversion.id, 'status', 'POSTED', 'replayed', false);
  PERFORM abos.money_audit(actor, entity, correlation, 'TREASURY_CASH_RECEIPT_POSTED', 'TREASURY_CASH_RECEIPT', receipt,
    result || jsonb_build_object('treasuryAccountId', v_account.id, 'amount', amount::text, 'currency', currency, 'businessDate', day,
      'revenueAccountId', revenue, 'payerBusinessPartyId', party, 'payerName', payer));
  PERFORM abos.temporary_funding_idempotency_complete(scope, key, 'TREASURY_CASH_RECEIPT', receipt, result);
  RETURN result;
END
$function$;

CREATE OR REPLACE FUNCTION abos.treasury_payment_record(p_proof text, p_runtime text, p_token text, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE c jsonb; actor uuid; entity uuid; req jsonb; amount numeric; day date; key text; correlation uuid; currency text; base text;
  v_account abos.operational_treasury_accounts%ROWTYPE; payable uuid; party uuid; payee text; kind text; policy uuid; period uuid;
  scope text; fingerprint text; replay jsonb; ref text; result jsonb; v_base_amount numeric; v_conversion abos.fx_conversions%ROWTYPE;
  payment uuid := gen_random_uuid(); journal uuid := gen_random_uuid(); intent uuid := gen_random_uuid();
BEGIN
  c := abos.treasury_safe_actor(p_proof, p_runtime, p_token, 'treasury.payment.record');
  actor := (c->>'userAccountId')::uuid; entity := (c->>'legalEntityId')::uuid;
  req := abos.money_request(p_payload, ARRAY['treasuryAccountId', 'paymentKind', 'payeeBusinessPartyId', 'payeeName', 'payableLedgerAccountId',
    'amount', 'currencyCode', 'businessDate', 'reference', 'note', 'idempotencyKey', 'correlationId', 'exchangeRateId']);
  amount := (req->>'amount')::numeric; day := (req->>'date')::date; key := req->>'key'; correlation := (req->>'correlation')::uuid;
  currency := p_payload->>'currencyCode'; kind := p_payload->>'paymentKind';
  party := abos.money_uuid(p_payload, 'payeeBusinessPartyId'); payee := NULLIF(btrim(p_payload->>'payeeName'), '');
  payable := abos.money_uuid(p_payload, 'payableLedgerAccountId');
  IF kind IS NULL OR kind NOT IN ('SUPPLIER', 'CONTRACTOR', 'SALARY', 'OTHER') THEN
    RAISE EXCEPTION 'choose what kind of payment this is' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF abos.money_uuid(p_payload, 'treasuryAccountId') IS NULL OR payable IS NULL THEN
    RAISE EXCEPTION 'choose the Safe and the payable account' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM abos.money_party(entity, party, payee);
  scope := 'treasury:payment:' || entity::text || ':' || actor::text;
  fingerprint := encode(sha256(convert_to((p_payload - 'correlationId')::text || actor::text, 'UTF8')), 'hex');
  replay := abos.temporary_funding_idempotency_begin(scope, key, fingerprint, correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  base := abos.money_currency_base(entity, currency);
  v_account := abos.money_treasury_account(entity, abos.money_uuid(p_payload, 'treasuryAccountId'), currency);
  -- Temporary-funding, shareholder-loan and Saraf liabilities have their own lanes and are refused here.
  IF NOT EXISTS (SELECT 1 FROM abos.ledger_accounts WHERE id = payable AND legal_entity_id = entity AND status = 'ACTIVE' AND posting_allowed
       AND account_type = 'LIABILITY' AND (control_account_type IS NULL OR control_account_type = 'AP')
       AND account_currency_code IS NOT DISTINCT FROM base
       AND NOT requires_project AND NOT requires_department AND NOT requires_cost_center) THEN
    RAISE EXCEPTION 'choose an active payable account in the accounting currency' USING ERRCODE = 'check_violation';
  END IF;
  -- Accounts payable is kept per supplier, so a free-text name is enough only on a payable without the AP control.
  IF party IS NULL AND EXISTS (SELECT 1 FROM abos.ledger_accounts WHERE id = payable AND control_account_type = 'AP') THEN
    RAISE EXCEPTION 'a payment against accounts payable needs the person or organization it was owed to' USING ERRCODE = 'check_violation';
  END IF;
  policy := abos.money_movement_policy(entity, CASE kind WHEN 'SALARY' THEN 'SALARY_PAYMENT' ELSE 'SUPPLIER_PAYMENT' END);
  period := abos.open_period_for_business_date(entity, actor, day);
  IF currency = base THEN
    v_base_amount := amount;
  ELSE
    v_conversion := abos.fx_convert(entity, 'PAYMENT', payment, currency, day, abos.money_uuid(p_payload, 'exchangeRateId'), actor, amount);
    v_base_amount := v_conversion.base_amount;
  END IF;
  ref := 'PY-' || to_char(day, 'YYYYMMDD') || '-' || upper(replace(payment::text, '-', ''));
  INSERT INTO abos.treasury_payments (id, legal_entity_id, operational_treasury_account_id, payment_kind, payee_business_party_id, payee_name,
    payable_ledger_account_id, currency_code, amount, business_date, reference, note, transaction_reference, workflow_policy_version_id,
    journal_id, created_by_user_account_id, correlation_id, idempotency_key, base_amount, fx_conversion_id)
  VALUES (payment, entity, v_account.id, kind, party, payee, payable, currency, amount, day, NULLIF(btrim(p_payload->>'reference'), ''),
    NULLIF(btrim(p_payload->>'note'), ''), ref, policy, journal, actor, correlation, key, v_base_amount, v_conversion.id);
  PERFORM abos.posting_kernel_draft(
    p_intent_id => intent, p_journal_id => journal, p_legal_entity_id => entity, p_source_type => 'PAYMENT', p_source_id => payment,
    p_original_amount => amount, p_original_currency_code => currency, p_base_amount => v_base_amount, p_base_currency_code => base,
    p_accounting_effective_date => day, p_accounting_period_id => period, p_journal_reference => ref, p_correlation_id => correlation,
    p_idempotency_key => 'PY:' || payment::text, p_initial_status => 'VALIDATED', p_created_by_user_account_id => actor,
    p_lines => ARRAY[
      ROW(1, 'DEBIT', payable, party, NULL, NULL, NULL, NULL, NULL, NULL, NULL)::abos.posting_kernel_line,
      ROW(2, 'CREDIT', v_account.ledger_account_id, NULL, NULL, NULL, NULL, 'OPERATIONAL_TREASURY', -1, v_account.id, NULL)::abos.posting_kernel_line],
    p_conversion_snapshot_reference => v_conversion.exchange_rate_snapshot_id::text, p_finance_workflow_policy_version_id => policy);
  PERFORM abos.posting_kernel_commit(intent, journal, actor);
  result := jsonb_build_object('movementId', payment, 'journalId', journal, 'reference', ref, 'currencyCode', currency, 'amount', amount::text,
    'baseAmount', v_base_amount::text, 'fxConversionId', v_conversion.id, 'status', 'POSTED', 'replayed', false);
  PERFORM abos.money_audit(actor, entity, correlation, 'TREASURY_PAYMENT_POSTED', 'TREASURY_PAYMENT', payment,
    result || jsonb_build_object('treasuryAccountId', v_account.id, 'paymentKind', kind, 'amount', amount::text, 'currency', currency,
      'businessDate', day, 'payableAccountId', payable, 'payeeBusinessPartyId', party, 'payeeName', payee));
  PERFORM abos.temporary_funding_idempotency_complete(scope, key, 'TREASURY_PAYMENT', payment, result);
  RETURN result;
END
$function$;

CREATE OR REPLACE FUNCTION abos.treasury_transfer_record(p_proof text, p_runtime text, p_token text, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE c jsonb; actor uuid; entity uuid; req jsonb; amount numeric; day date; key text; correlation uuid; currency text; base text;
  v_source abos.operational_treasury_accounts%ROWTYPE; v_destination abos.operational_treasury_accounts%ROWTYPE; source_id uuid; destination_id uuid;
  policy uuid; period uuid; scope text; fingerprint text; replay jsonb; ref text; result jsonb; v_base_amount numeric; v_conversion abos.fx_conversions%ROWTYPE;
  transfer uuid := gen_random_uuid(); journal uuid := gen_random_uuid(); intent uuid := gen_random_uuid();
BEGIN
  c := abos.treasury_safe_actor(p_proof, p_runtime, p_token, 'treasury.transfer.record');
  actor := (c->>'userAccountId')::uuid; entity := (c->>'legalEntityId')::uuid;
  req := abos.money_request(p_payload, ARRAY['sourceTreasuryAccountId', 'destinationTreasuryAccountId', 'amount', 'currencyCode',
    'businessDate', 'reference', 'note', 'idempotencyKey', 'correlationId', 'exchangeRateId']);
  amount := (req->>'amount')::numeric; day := (req->>'date')::date; key := req->>'key'; correlation := (req->>'correlation')::uuid;
  currency := p_payload->>'currencyCode';
  source_id := abos.money_uuid(p_payload, 'sourceTreasuryAccountId'); destination_id := abos.money_uuid(p_payload, 'destinationTreasuryAccountId');
  IF source_id IS NULL OR destination_id IS NULL THEN
    RAISE EXCEPTION 'choose where the money comes from and where it goes' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF source_id = destination_id THEN
    RAISE EXCEPTION 'a transfer needs two different accounts' USING ERRCODE = 'check_violation';
  END IF;
  scope := 'treasury:transfer:' || entity::text || ':' || actor::text;
  fingerprint := encode(sha256(convert_to((p_payload - 'correlationId')::text || actor::text, 'UTF8')), 'hex');
  replay := abos.temporary_funding_idempotency_begin(scope, key, fingerprint, correlation);
  IF replay IS NOT NULL THEN RETURN replay; END IF;
  base := abos.money_currency_base(entity, currency);
  -- Both rows are locked in a stable order, so two opposite transfers cannot deadlock.
  IF source_id < destination_id THEN
    v_source := abos.money_treasury_account(entity, source_id, currency);
    v_destination := abos.money_treasury_account(entity, destination_id, currency);
  ELSE
    v_destination := abos.money_treasury_account(entity, destination_id, currency);
    v_source := abos.money_treasury_account(entity, source_id, currency);
  END IF;
  policy := abos.money_movement_policy(entity, 'TREASURY_TRANSFER');
  period := abos.open_period_for_business_date(entity, actor, day);
  IF currency = base THEN
    v_base_amount := amount;
  ELSE
    v_conversion := abos.fx_convert(entity, 'TREASURY_TRANSFER', transfer, currency, day, abos.money_uuid(p_payload, 'exchangeRateId'), actor, amount);
    v_base_amount := v_conversion.base_amount;
  END IF;
  ref := 'TR-' || to_char(day, 'YYYYMMDD') || '-' || upper(replace(transfer::text, '-', ''));
  INSERT INTO abos.treasury_transfers (id, legal_entity_id, source_treasury_account_id, destination_treasury_account_id, currency_code,
    amount, business_date, reference, note, transaction_reference, workflow_policy_version_id, journal_id, created_by_user_account_id,
    correlation_id, idempotency_key, base_amount, fx_conversion_id)
  VALUES (transfer, entity, v_source.id, v_destination.id, currency, amount, day, NULLIF(btrim(p_payload->>'reference'), ''),
    NULLIF(btrim(p_payload->>'note'), ''), ref, policy, journal, actor, correlation, key, v_base_amount, v_conversion.id);
  PERFORM abos.posting_kernel_draft(
    p_intent_id => intent, p_journal_id => journal, p_legal_entity_id => entity, p_source_type => 'TREASURY_TRANSFER', p_source_id => transfer,
    p_original_amount => amount, p_original_currency_code => currency, p_base_amount => v_base_amount, p_base_currency_code => base,
    p_accounting_effective_date => day, p_accounting_period_id => period, p_journal_reference => ref, p_correlation_id => correlation,
    p_idempotency_key => 'TR:' || transfer::text, p_initial_status => 'VALIDATED', p_created_by_user_account_id => actor,
    p_lines => ARRAY[
      ROW(1, 'DEBIT', v_destination.ledger_account_id, NULL, NULL, NULL, NULL, 'OPERATIONAL_TREASURY', 1, v_destination.id, NULL)::abos.posting_kernel_line,
      ROW(2, 'CREDIT', v_source.ledger_account_id, NULL, NULL, NULL, NULL, 'OPERATIONAL_TREASURY', -1, v_source.id, NULL)::abos.posting_kernel_line],
    p_conversion_snapshot_reference => v_conversion.exchange_rate_snapshot_id::text, p_finance_workflow_policy_version_id => policy);
  PERFORM abos.posting_kernel_commit(intent, journal, actor);
  result := jsonb_build_object('movementId', transfer, 'journalId', journal, 'reference', ref, 'currencyCode', currency, 'amount', amount::text,
    'baseAmount', v_base_amount::text, 'fxConversionId', v_conversion.id, 'status', 'POSTED', 'replayed', false);
  PERFORM abos.money_audit(actor, entity, correlation, 'TREASURY_TRANSFER_POSTED', 'TREASURY_TRANSFER', transfer,
    result || jsonb_build_object('sourceTreasuryAccountId', v_source.id, 'destinationTreasuryAccountId', v_destination.id,
      'amount', amount::text, 'currency', currency, 'businessDate', day));
  PERFORM abos.temporary_funding_idempotency_complete(scope, key, 'TREASURY_TRANSFER', transfer, result);
  RETURN result;
END
$function$;

CREATE OR REPLACE FUNCTION abos.treasury_opening_balance_record(p_proof text, p_runtime text, p_token text, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  c jsonb; actor uuid; entity uuid; v_account abos.operational_treasury_accounts%ROWTYPE; base text;
  amount numeric; day date; currency text; equity uuid; period uuid; account_id uuid;
  key text; correlation uuid; scope text; fingerprint text; replay jsonb; ref text; result jsonb;
  v_base_amount numeric; v_conversion abos.fx_conversions%ROWTYPE;
  opening uuid := gen_random_uuid(); journal uuid := gen_random_uuid(); intent uuid := gen_random_uuid();
BEGIN
  c := abos.treasury_safe_actor(p_proof, p_runtime, p_token, 'treasury.opening-balance.record');
  actor := (c->>'userAccountId')::uuid; entity := (c->>'legalEntityId')::uuid;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_payload) k
      WHERE k NOT IN ('treasuryAccountId', 'amount', 'currencyCode', 'asOfDate', 'reference', 'note', 'idempotencyKey', 'correlationId',
        'exchangeRateId')) THEN
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
  -- 0051: an opening balance may be in the Safe's own currency; a non-base one converts at the as-of day's rate.
  base := abos.money_currency_base(entity, currency);
  -- 0050: only an opening balance that has not been reversed blocks a new one (checked under the Safe lock).
  IF EXISTS (SELECT 1 FROM abos.treasury_opening_balances ob WHERE ob.operational_treasury_account_id = v_account.id
       AND NOT EXISTS (SELECT 1 FROM abos.journal_reversal_links link WHERE link.original_journal_id = ob.journal_id)) THEN
    RAISE EXCEPTION 'this Safe already has an opening balance; a posted opening balance is corrected by reversal'
      USING ERRCODE = 'check_violation';
  END IF;
  equity := abos.opening_balance_equity_account(entity, base);
  period := abos.open_period_for_business_date(entity, actor, day);
  IF currency = base THEN
    v_base_amount := amount;
  ELSE
    v_conversion := abos.fx_convert(entity, 'OPENING_BALANCE', opening, currency, day, abos.money_uuid(p_payload, 'exchangeRateId'), actor, amount);
    v_base_amount := v_conversion.base_amount;
  END IF;
  ref := 'OB-' || to_char(day, 'YYYYMMDD') || '-' || upper(replace(opening::text, '-', ''));
  INSERT INTO abos.treasury_opening_balances (id, legal_entity_id, operational_treasury_account_id, currency_code, amount,
    as_of_date, reference, note, transaction_reference, equity_ledger_account_id, journal_id, created_by_user_account_id,
    correlation_id, idempotency_key, base_amount, fx_conversion_id)
  VALUES (opening, entity, v_account.id, currency, amount, day, NULLIF(btrim(p_payload->>'reference'), ''),
    NULLIF(btrim(p_payload->>'note'), ''), ref, equity, journal, actor, correlation, key, v_base_amount, v_conversion.id);
  PERFORM abos.posting_kernel_draft(
    p_intent_id => intent, p_journal_id => journal, p_legal_entity_id => entity,
    p_source_type => 'OPENING_BALANCE', p_source_id => opening,
    p_original_amount => amount, p_original_currency_code => currency, p_base_amount => v_base_amount, p_base_currency_code => base,
    p_accounting_effective_date => day, p_accounting_period_id => period, p_journal_reference => ref,
    p_correlation_id => correlation, p_idempotency_key => 'OB:' || opening::text, p_initial_status => 'VALIDATED',
    p_created_by_user_account_id => actor,
    p_lines => ARRAY[
      ROW(1, 'DEBIT', v_account.ledger_account_id, NULL, NULL, NULL, NULL, 'OPERATIONAL_TREASURY', 1, v_account.id, NULL)::abos.posting_kernel_line,
      ROW(2, 'CREDIT', equity, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)::abos.posting_kernel_line],
    p_conversion_snapshot_reference => v_conversion.exchange_rate_snapshot_id::text);
  PERFORM abos.posting_kernel_commit(intent, journal, actor);
  result := jsonb_build_object('openingBalanceId', opening, 'journalId', journal, 'reference', ref, 'currencyCode', currency,
    'amount', amount::text, 'baseAmount', v_base_amount::text, 'fxConversionId', v_conversion.id, 'status', 'POSTED', 'replayed', false);
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
$function$;


-- ---------------------------------------------------------------------------------------------
-- 6. Restated validators: the accounting amount and conversion come from the source row (fx_source_matches); lines
--    carry the accounting amount, Treasury movements the native amount and the accounting amount.
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION abos.validate_cash_receipt_journal(p_journal abos.journals, p_intent abos.posting_intents)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE r abos.treasury_cash_receipts%ROWTYPE; v_account abos.operational_treasury_accounts%ROWTYPE;
BEGIN
  SELECT * INTO r FROM abos.treasury_cash_receipts WHERE id = p_intent.source_id AND legal_entity_id = p_journal.legal_entity_id;
  IF NOT FOUND OR r.journal_id <> p_journal.id OR p_intent.intent_kind <> 'CASH_RECEIPT' OR p_intent.treasury_receipt_id IS DISTINCT FROM r.id
     OR NOT abos.fx_source_matches(r.legal_entity_id, 'CASH_RECEIPT', r.id, r.currency_code, r.amount, r.base_amount, r.fx_conversion_id, p_intent)
     OR r.business_date <> p_journal.accounting_effective_date OR p_journal.journal_reference <> r.transaction_reference
     OR p_journal.posted_by_user_account_id IS DISTINCT FROM r.created_by_user_account_id
     OR p_intent.created_by_user_account_id <> r.created_by_user_account_id
     OR p_intent.finance_workflow_policy_version_id IS DISTINCT FROM r.workflow_policy_version_id
     OR NOT abos.workflow_policy_allows_direct(r.legal_entity_id, ARRAY['OTHER_INCOME'], r.workflow_policy_version_id) THEN
    RAISE EXCEPTION 'cash receipt journal does not match its source, amount, date, reference, policy or recorder' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_account FROM abos.operational_treasury_accounts WHERE id = r.operational_treasury_account_id
     AND legal_entity_id = r.legal_entity_id AND status = 'ACTIVE';
  IF NOT FOUND OR v_account.currency_code <> r.currency_code THEN
    RAISE EXCEPTION 'a cash receipt posts only to an active Safe or Saraf account in its currency' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM abos.journal_lines l WHERE l.journal_id = p_journal.id AND l.line_number = 1
       AND l.ledger_account_id = v_account.ledger_account_id AND l.base_debit = r.base_amount AND l.business_party_id IS NULL
       AND l.project_id IS NULL AND l.department_id IS NULL AND l.cost_center_id IS NULL)
     OR NOT EXISTS (SELECT 1 FROM abos.journal_lines l WHERE l.journal_id = p_journal.id AND l.line_number = 2
       AND l.ledger_account_id = r.revenue_ledger_account_id AND l.base_credit = r.base_amount
       AND l.business_party_id IS NOT DISTINCT FROM r.payer_business_party_id
       AND l.project_id IS NULL AND l.department_id IS NULL AND l.cost_center_id IS NULL) THEN
    RAISE EXCEPTION 'a cash receipt must debit its Treasury account and credit its income account' USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT count(*) FROM abos.subledger_entries e JOIN abos.journal_lines l ON l.id = e.journal_line_id WHERE l.journal_id = p_journal.id) <> 1
     OR NOT EXISTS (SELECT 1 FROM abos.subledger_entries e JOIN abos.journal_lines l ON l.id = e.journal_line_id
       WHERE l.journal_id = p_journal.id AND l.line_number = 1 AND e.subledger_type = 'OPERATIONAL_TREASURY'
         AND e.operational_treasury_account_id = v_account.id AND e.base_amount = r.base_amount AND e.original_amount = r.amount) THEN
    RAISE EXCEPTION 'a cash receipt requires exactly its Treasury inflow' USING ERRCODE = 'check_violation';
  END IF;
END
$function$;

CREATE OR REPLACE FUNCTION abos.validate_payment_journal(p_journal abos.journals, p_intent abos.posting_intents)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE p abos.treasury_payments%ROWTYPE; v_account abos.operational_treasury_accounts%ROWTYPE;
BEGIN
  SELECT * INTO p FROM abos.treasury_payments WHERE id = p_intent.source_id AND legal_entity_id = p_journal.legal_entity_id;
  IF NOT FOUND OR p.journal_id <> p_journal.id OR p_intent.intent_kind <> 'PAYMENT' OR p_intent.treasury_payment_id IS DISTINCT FROM p.id
     OR NOT abos.fx_source_matches(p.legal_entity_id, 'PAYMENT', p.id, p.currency_code, p.amount, p.base_amount, p.fx_conversion_id, p_intent)
     OR p.business_date <> p_journal.accounting_effective_date OR p_journal.journal_reference <> p.transaction_reference
     OR p_journal.posted_by_user_account_id IS DISTINCT FROM p.created_by_user_account_id
     OR p_intent.created_by_user_account_id <> p.created_by_user_account_id
     OR p_intent.finance_workflow_policy_version_id IS DISTINCT FROM p.workflow_policy_version_id
     OR NOT abos.workflow_policy_allows_direct(p.legal_entity_id,
          ARRAY[CASE p.payment_kind WHEN 'SALARY' THEN 'SALARY_PAYMENT' ELSE 'SUPPLIER_PAYMENT' END], p.workflow_policy_version_id) THEN
    RAISE EXCEPTION 'payment journal does not match its source, amount, date, reference, policy or recorder' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_account FROM abos.operational_treasury_accounts WHERE id = p.operational_treasury_account_id
     AND legal_entity_id = p.legal_entity_id AND status = 'ACTIVE';
  IF NOT FOUND OR v_account.currency_code <> p.currency_code THEN
    RAISE EXCEPTION 'a payment posts only from an active Safe or Saraf account in its currency' USING ERRCODE = 'check_violation';
  END IF;
  IF p.payee_business_party_id IS NULL AND EXISTS (SELECT 1 FROM abos.ledger_accounts a WHERE a.id = p.payable_ledger_account_id
       AND a.control_account_type = 'AP') THEN
    RAISE EXCEPTION 'a payment against accounts payable needs the person or organization it was owed to' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM abos.journal_lines l WHERE l.journal_id = p_journal.id AND l.line_number = 1
       AND l.ledger_account_id = p.payable_ledger_account_id AND l.base_debit = p.base_amount
       AND l.business_party_id IS NOT DISTINCT FROM p.payee_business_party_id
       AND l.project_id IS NULL AND l.department_id IS NULL AND l.cost_center_id IS NULL)
     OR NOT EXISTS (SELECT 1 FROM abos.journal_lines l WHERE l.journal_id = p_journal.id AND l.line_number = 2
       AND l.ledger_account_id = v_account.ledger_account_id AND l.base_credit = p.base_amount AND l.business_party_id IS NULL
       AND l.project_id IS NULL AND l.department_id IS NULL AND l.cost_center_id IS NULL) THEN
    RAISE EXCEPTION 'a payment must debit its payable and credit its Treasury account' USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT count(*) FROM abos.subledger_entries e JOIN abos.journal_lines l ON l.id = e.journal_line_id WHERE l.journal_id = p_journal.id) <> 1
     OR NOT EXISTS (SELECT 1 FROM abos.subledger_entries e JOIN abos.journal_lines l ON l.id = e.journal_line_id
       WHERE l.journal_id = p_journal.id AND l.line_number = 2 AND e.subledger_type = 'OPERATIONAL_TREASURY'
         AND e.operational_treasury_account_id = v_account.id AND e.base_amount = -p.base_amount AND e.original_amount = -p.amount) THEN
    RAISE EXCEPTION 'a payment requires exactly its Treasury outflow' USING ERRCODE = 'check_violation';
  END IF;
END
$function$;

CREATE OR REPLACE FUNCTION abos.validate_treasury_transfer_journal(p_journal abos.journals, p_intent abos.posting_intents)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE t abos.treasury_transfers%ROWTYPE; v_source abos.operational_treasury_accounts%ROWTYPE; v_destination abos.operational_treasury_accounts%ROWTYPE;
BEGIN
  SELECT * INTO t FROM abos.treasury_transfers WHERE id = p_intent.source_id AND legal_entity_id = p_journal.legal_entity_id;
  IF NOT FOUND OR t.journal_id <> p_journal.id OR p_intent.intent_kind <> 'TREASURY_TRANSFER' OR p_intent.treasury_transfer_id IS DISTINCT FROM t.id
     OR NOT abos.fx_source_matches(t.legal_entity_id, 'TREASURY_TRANSFER', t.id, t.currency_code, t.amount, t.base_amount, t.fx_conversion_id, p_intent)
     OR t.business_date <> p_journal.accounting_effective_date OR p_journal.journal_reference <> t.transaction_reference
     OR p_journal.posted_by_user_account_id IS DISTINCT FROM t.created_by_user_account_id
     OR p_intent.created_by_user_account_id <> t.created_by_user_account_id
     OR p_intent.finance_workflow_policy_version_id IS DISTINCT FROM t.workflow_policy_version_id
     OR NOT abos.workflow_policy_allows_direct(t.legal_entity_id, ARRAY['TREASURY_TRANSFER'], t.workflow_policy_version_id) THEN
    RAISE EXCEPTION 'transfer journal does not match its source, amount, date, reference, policy or recorder' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_source FROM abos.operational_treasury_accounts WHERE id = t.source_treasury_account_id AND legal_entity_id = t.legal_entity_id AND status = 'ACTIVE';
  SELECT * INTO v_destination FROM abos.operational_treasury_accounts WHERE id = t.destination_treasury_account_id AND legal_entity_id = t.legal_entity_id AND status = 'ACTIVE';
  IF v_source.id IS NULL OR v_destination.id IS NULL OR v_source.currency_code <> t.currency_code OR v_destination.currency_code <> t.currency_code THEN
    RAISE EXCEPTION 'a transfer posts only between active Safe or Saraf accounts' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM abos.journal_lines l WHERE l.journal_id = p_journal.id AND l.line_number = 1
       AND l.ledger_account_id = v_destination.ledger_account_id AND l.base_debit = t.base_amount AND l.business_party_id IS NULL
       AND l.project_id IS NULL AND l.department_id IS NULL AND l.cost_center_id IS NULL)
     OR NOT EXISTS (SELECT 1 FROM abos.journal_lines l WHERE l.journal_id = p_journal.id AND l.line_number = 2
       AND l.ledger_account_id = v_source.ledger_account_id AND l.base_credit = t.base_amount AND l.business_party_id IS NULL
       AND l.project_id IS NULL AND l.department_id IS NULL AND l.cost_center_id IS NULL) THEN
    RAISE EXCEPTION 'a transfer must debit its destination and credit its source' USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT count(*) FROM abos.subledger_entries e JOIN abos.journal_lines l ON l.id = e.journal_line_id WHERE l.journal_id = p_journal.id) <> 2
     OR NOT EXISTS (SELECT 1 FROM abos.subledger_entries e JOIN abos.journal_lines l ON l.id = e.journal_line_id
       WHERE l.journal_id = p_journal.id AND l.line_number = 1 AND e.subledger_type = 'OPERATIONAL_TREASURY'
         AND e.operational_treasury_account_id = v_destination.id AND e.base_amount = t.base_amount AND e.original_amount = t.amount)
     OR NOT EXISTS (SELECT 1 FROM abos.subledger_entries e JOIN abos.journal_lines l ON l.id = e.journal_line_id
       WHERE l.journal_id = p_journal.id AND l.line_number = 2 AND e.subledger_type = 'OPERATIONAL_TREASURY'
         AND e.operational_treasury_account_id = v_source.id AND e.base_amount = -t.base_amount AND e.original_amount = -t.amount) THEN
    RAISE EXCEPTION 'a transfer requires exactly its destination inflow and source outflow' USING ERRCODE = 'check_violation';
  END IF;
END
$function$;

CREATE OR REPLACE FUNCTION abos.validate_opening_balance_journal(p_journal abos.journals, p_intent abos.posting_intents)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  v_opening abos.treasury_opening_balances%ROWTYPE;
  v_account abos.operational_treasury_accounts%ROWTYPE;
BEGIN
  SELECT * INTO v_opening FROM abos.treasury_opening_balances
   WHERE id = p_intent.source_id AND legal_entity_id = p_journal.legal_entity_id;
  IF NOT FOUND OR v_opening.journal_id <> p_journal.id OR p_intent.intent_kind <> 'OPENING_BALANCE'
     OR p_intent.treasury_opening_balance_id IS DISTINCT FROM v_opening.id
     OR NOT abos.fx_source_matches(v_opening.legal_entity_id, 'OPENING_BALANCE', v_opening.id, v_opening.currency_code, v_opening.amount,
          v_opening.base_amount, v_opening.fx_conversion_id, p_intent)
     OR v_opening.as_of_date <> p_journal.accounting_effective_date
     OR p_journal.journal_reference <> v_opening.transaction_reference
     OR p_journal.posted_by_user_account_id IS DISTINCT FROM v_opening.created_by_user_account_id
     OR p_intent.created_by_user_account_id <> v_opening.created_by_user_account_id THEN
    RAISE EXCEPTION 'opening balance journal does not match its source, amount, date, reference or recorder'
      USING ERRCODE = 'check_violation';
  END IF;
  -- Like every other source validator, the Safe must still be ACTIVE when the journal posts.
  SELECT * INTO v_account FROM abos.operational_treasury_accounts
   WHERE id = v_opening.operational_treasury_account_id AND legal_entity_id = p_journal.legal_entity_id AND status = 'ACTIVE'
     AND currency_code = v_opening.currency_code;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'an opening balance posts only to an active Safe' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM abos.journal_lines line WHERE line.journal_id = p_journal.id AND line.line_number = 1
       AND line.ledger_account_id = v_account.ledger_account_id AND line.base_debit = v_opening.base_amount
       AND line.business_party_id IS NULL AND line.project_id IS NULL AND line.department_id IS NULL AND line.cost_center_id IS NULL)
     OR NOT EXISTS (SELECT 1 FROM abos.journal_lines line WHERE line.journal_id = p_journal.id AND line.line_number = 2
       AND line.ledger_account_id = v_opening.equity_ledger_account_id AND line.base_credit = v_opening.base_amount
       AND line.business_party_id IS NULL AND line.project_id IS NULL AND line.department_id IS NULL AND line.cost_center_id IS NULL) THEN
    RAISE EXCEPTION 'an opening balance must debit its Safe and credit opening balance equity'
      USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT count(*) FROM abos.subledger_entries entry JOIN abos.journal_lines line ON line.id = entry.journal_line_id
       WHERE line.journal_id = p_journal.id) <> 1
     OR NOT EXISTS (SELECT 1 FROM abos.subledger_entries entry JOIN abos.journal_lines line ON line.id = entry.journal_line_id
       WHERE line.journal_id = p_journal.id AND line.line_number = 1 AND entry.subledger_type = 'OPERATIONAL_TREASURY'
         AND entry.operational_treasury_account_id = v_account.id AND entry.original_amount = v_opening.amount
         AND entry.base_amount = v_opening.base_amount AND entry.business_party_id IS NULL) THEN
    RAISE EXCEPTION 'an opening balance requires exactly its Safe movement'
      USING ERRCODE = 'check_violation';
  END IF;
END
$function$;


-- ---------------------------------------------------------------------------------------------
-- 7. Restated expense lane: the FX policy replaces the exact-only rule. A foreign-currency expense recorded before
--    0051 (no conversion row) is still validated by the exact rule it was created under.
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION abos.operational_expense_create(p_identity_proof text, p_runtime_token_sha256 text, p_token_sha256 text, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  v_actor_context jsonb;
  v_actor_id uuid;
  v_entity_id uuid;
  v_treasury_id uuid;
  v_category_id uuid;
  v_payee_id uuid;
  v_project_id uuid;
  v_department_id uuid;
  v_cost_center_id uuid;
  v_exchange_rate_id uuid;
  v_correlation_id uuid;
  v_business_date date;
  v_amount_text text;
  v_original_amount numeric;
  v_currency text;
  v_base_currency text;
  v_base_amount numeric;
  v_reference text;
  v_description text;
  v_note text;
  v_request_key text;
  v_payment_kind text;
  v_fingerprint text;
  v_scope text;
  v_idempotency abos.idempotency_records%ROWTYPE;
  v_policy abos.finance_workflow_policy_versions%ROWTYPE;
  v_kind_policy abos.finance_workflow_policy_versions%ROWTYPE;
  v_approval boolean;
  v_expense_id uuid := pg_catalog.gen_random_uuid();
  v_snapshot_id uuid;
  v_snapshot abos.exchange_rate_snapshots%ROWTYPE;
  v_conversion abos.fx_conversions%ROWTYPE;
  v_route text;
  v_response jsonb;
  v_unknown text;
BEGIN
  -- Identity, legal entity and permission come only from server proof plus the live session.
  v_actor_context := abos.operational_finance_actor(
    p_identity_proof, p_runtime_token_sha256, p_token_sha256, 'finance.expense.create');
  v_actor_id := (v_actor_context ->> 'userAccountId')::uuid;
  v_entity_id := (v_actor_context ->> 'legalEntityId')::uuid;

  IF p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'expense details must be an object'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT pg_catalog.string_agg(payload_key, ', ') INTO v_unknown
    FROM pg_catalog.jsonb_object_keys(p_payload) payload_key
   WHERE payload_key NOT IN (
     'treasuryAccountId', 'expenseCategoryId', 'payeeBusinessPartyId',
     'projectId', 'departmentId', 'costCenterId', 'reference', 'description', 'note',
     'businessDate', 'originalAmount', 'currencyCode', 'exchangeRateId',
     'correlationId', 'idempotencyKey', 'paymentKind');
  IF v_unknown IS NOT NULL THEN
    RAISE EXCEPTION 'unknown expense fields: %', v_unknown
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Money crosses the boundary as a canonical decimal string (the contracts' pattern). A plain
  -- ::numeric cast would also accept NaN, Infinity and exponents.
  v_amount_text := p_payload ->> 'originalAmount';
  IF v_amount_text IS NULL OR pg_catalog.length(v_amount_text) > 256
     OR v_amount_text !~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$' THEN
    RAISE EXCEPTION 'the expense amount must be a plain positive decimal'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_original_amount := v_amount_text::numeric;
  v_treasury_id := NULLIF(p_payload ->> 'treasuryAccountId', '')::uuid;
  v_category_id := NULLIF(p_payload ->> 'expenseCategoryId', '')::uuid;
  v_payee_id := NULLIF(p_payload ->> 'payeeBusinessPartyId', '')::uuid;
  v_project_id := NULLIF(p_payload ->> 'projectId', '')::uuid;
  v_department_id := NULLIF(p_payload ->> 'departmentId', '')::uuid;
  v_cost_center_id := NULLIF(p_payload ->> 'costCenterId', '')::uuid;
  v_exchange_rate_id := NULLIF(p_payload ->> 'exchangeRateId', '')::uuid;
  v_correlation_id := NULLIF(p_payload ->> 'correlationId', '')::uuid;
  v_business_date := NULLIF(p_payload ->> 'businessDate', '')::date;
  v_currency := pg_catalog.upper(NULLIF(pg_catalog.btrim(p_payload ->> 'currencyCode'), ''));
  v_reference := NULLIF(pg_catalog.btrim(p_payload ->> 'reference'), '');
  v_description := NULLIF(pg_catalog.btrim(p_payload ->> 'description'), '');
  v_note := NULLIF(pg_catalog.btrim(p_payload ->> 'note'), '');
  v_request_key := NULLIF(pg_catalog.btrim(p_payload ->> 'idempotencyKey'), '');
  -- 0048: an expense recorded as a payment names its kind, which chooses the governing approval setting.
  v_payment_kind := NULLIF(pg_catalog.btrim(p_payload ->> 'paymentKind'), '');
  IF v_payment_kind IS NOT NULL AND v_payment_kind NOT IN ('SUPPLIER', 'CONTRACTOR', 'SALARY', 'OTHER') THEN
    RAISE EXCEPTION 'complete valid expense details are required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_treasury_id IS NULL OR v_category_id IS NULL OR v_correlation_id IS NULL
     OR v_business_date IS NULL OR v_original_amount <= 0
     OR v_currency IS NULL OR v_reference IS NULL OR v_description IS NULL
     OR v_request_key IS NULL OR pg_catalog.length(v_request_key) NOT BETWEEN 8 AND 200
     OR pg_catalog.length(v_reference) > 120
     OR pg_catalog.length(v_description) NOT BETWEEN 3 AND 500
     OR (v_note IS NOT NULL AND pg_catalog.length(v_note) > 1000) THEN
    RAISE EXCEPTION 'complete valid expense details are required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Idempotency first (after identity), so an identical retry returns the recorded result even if
  -- configuration changed meanwhile. The creator is part of the fingerprint: another user reusing
  -- the key is a conflict, never someone else's result.
  v_fingerprint := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    pg_catalog.jsonb_build_object(
      'actorId', v_actor_id,
      'treasuryAccountId', v_treasury_id, 'expenseCategoryId', v_category_id,
      'payeeBusinessPartyId', v_payee_id, 'projectId', v_project_id,
      'departmentId', v_department_id, 'costCenterId', v_cost_center_id,
      'reference', v_reference, 'description', v_description, 'note', v_note,
      'businessDate', v_business_date, 'originalAmount', v_original_amount::text,
      'currencyCode', v_currency, 'exchangeRateId', v_exchange_rate_id,
      'correlationId', v_correlation_id)
      -- 0048: present only with a kind, so requests without one keep their exact fingerprint.
      || CASE WHEN v_payment_kind IS NULL THEN '{}'::jsonb ELSE pg_catalog.jsonb_build_object('paymentKind', v_payment_kind) END
      ::text, 'UTF8')), 'hex');
  v_scope := v_entity_id::text || ':OPERATIONAL_EXPENSE_CREATE';
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_scope || ':' || v_request_key, 0));
  SELECT * INTO v_idempotency FROM abos.idempotency_records record
   WHERE record.scope = v_scope AND record.idempotency_key = v_request_key;
  IF FOUND THEN
    IF v_idempotency.request_fingerprint <> v_fingerprint THEN
      RAISE EXCEPTION 'idempotency key was already used for different expense details'
        USING ERRCODE = 'unique_violation';
    END IF;
    IF v_idempotency.status = 'COMPLETED' THEN
      RETURN v_idempotency.response_snapshot || pg_catalog.jsonb_build_object('replayed', true);
    END IF;
    RAISE EXCEPTION 'expense request with this idempotency key is still in progress'
      USING ERRCODE = 'serialization_failure';
  END IF;

  SELECT entity.base_currency_code INTO v_base_currency FROM abos.legal_entities entity
   WHERE entity.id = v_entity_id AND entity.currency_policy_status = 'APPROVED';
  IF v_base_currency IS NULL THEN
    RAISE EXCEPTION 'the legal entity has no approved base currency'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_currency = v_base_currency AND v_exchange_rate_id IS NOT NULL THEN
    RAISE EXCEPTION 'base-currency expense must not select an exchange rate'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM abos.operational_treasury_accounts account
     WHERE account.id = v_treasury_id AND account.legal_entity_id = v_entity_id
       AND account.status = 'ACTIVE' AND account.currency_code = v_currency
  ) OR NOT EXISTS (
    SELECT 1 FROM abos.operational_expense_categories category
     WHERE category.id = v_category_id AND category.legal_entity_id = v_entity_id
       AND category.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'active same-entity Treasury account and expense category are required'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_payee_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM abos.business_parties party
     WHERE party.id = v_payee_id AND party.legal_entity_id = v_entity_id AND party.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'payee is not an active business party in this legal entity'
      USING ERRCODE = 'check_violation';
  END IF;
  IF (v_project_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM abos.user_scope_grants grant_row
       WHERE grant_row.user_account_id = v_actor_id AND grant_row.legal_entity_id = v_entity_id
         AND grant_row.scope_kind = 'PROJECT' AND grant_row.scope_id = v_project_id
         AND grant_row.revoked_at IS NULL))
     OR (v_department_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM abos.user_scope_grants grant_row
       WHERE grant_row.user_account_id = v_actor_id AND grant_row.legal_entity_id = v_entity_id
         AND grant_row.scope_kind = 'DEPARTMENT' AND grant_row.scope_id = v_department_id
         AND grant_row.revoked_at IS NULL))
     OR (v_cost_center_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM abos.user_scope_grants grant_row
       WHERE grant_row.user_account_id = v_actor_id AND grant_row.legal_entity_id = v_entity_id
         AND grant_row.scope_kind = 'COST_CENTER' AND grant_row.scope_id = v_cost_center_id
         AND grant_row.revoked_at IS NULL)) THEN
    RAISE EXCEPTION 'expense dimensions are outside the actor''s live scope'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM abos.accounting_periods period
     WHERE period.legal_entity_id = v_entity_id AND period.status = 'OPEN'
       AND v_business_date BETWEEN period.starts_on AND period.ends_on
  ) THEN
    RAISE EXCEPTION 'an open accounting period must cover the expense date'
      USING ERRCODE = 'check_violation';
  END IF;
  -- The route is fixed now: the deciding policy version at creation is stored with the expense and
  -- a later policy change never re-routes it. 0049: an expense needs approval when its EXPENSE setting
  -- or its payment kind's setting is ON, so a kind can never bypass the expense approval; a missing
  -- setting is the Simple Mode default (OFF) and is stored as a NULL reference.
  SELECT * INTO v_policy FROM abos.finance_workflow_policy_versions policy
   WHERE policy.legal_entity_id = v_entity_id AND policy.workflow_type = 'EXPENSE'
   ORDER BY policy.version DESC LIMIT 1;
  SELECT * INTO v_kind_policy FROM abos.finance_workflow_policy_versions policy
   WHERE policy.legal_entity_id = v_entity_id AND policy.workflow_type = abos.expense_workflow_type(v_payment_kind)
   ORDER BY policy.version DESC LIMIT 1;
  IF v_kind_policy.approval_required OR v_policy.id IS NULL THEN
    IF v_kind_policy.approval_required OR NOT COALESCE(v_policy.approval_required, false) THEN
      v_policy := v_kind_policy;
    END IF;
  END IF;
  v_approval := COALESCE(v_policy.approval_required, false);

  INSERT INTO abos.idempotency_records
    (scope, idempotency_key, request_fingerprint, correlation_id, status)
  VALUES (v_scope, v_request_key, v_fingerprint, v_correlation_id, 'IN_PROGRESS');

  INSERT INTO abos.operational_expenses
    (id, legal_entity_id, operational_treasury_account_id,
     operational_expense_category_id, payee_business_party_id, project_id,
     department_id, cost_center_id, reference, description, note, business_date,
     original_amount, original_currency_code, base_amount, base_currency_code,
     workflow_policy_version_id, approval_required, correlation_id, idempotency_key,
     request_fingerprint, status, version, created_by_user_account_id, payment_kind)
  VALUES
    (v_expense_id, v_entity_id, v_treasury_id, v_category_id, v_payee_id, v_project_id,
     v_department_id, v_cost_center_id, v_reference, v_description, v_note,
     v_business_date, v_original_amount, v_currency,
     CASE WHEN v_currency = v_base_currency THEN v_original_amount ELSE NULL END,
     v_base_currency, v_policy.id, v_approval, v_correlation_id,
     v_request_key, v_fingerprint, 'DRAFT', 1, v_actor_id, v_payment_kind);

  IF v_currency = v_base_currency THEN
    v_base_amount := v_original_amount;
  ELSE
    -- 0051: that business date's current rate (the user's choice when several exist), converted under the FX policy.
    v_conversion := abos.fx_convert(v_entity_id, 'OPERATIONAL_EXPENSE', v_expense_id, v_currency, v_business_date,
      v_exchange_rate_id, v_actor_id, v_original_amount);
    v_snapshot_id := v_conversion.exchange_rate_snapshot_id;
    v_base_amount := v_conversion.base_amount;
  END IF;
  v_route := CASE WHEN v_approval THEN 'PENDING_APPROVAL' ELSE 'VALIDATED' END;
  UPDATE abos.operational_expenses
     SET base_amount = v_base_amount, exchange_rate_snapshot_id = v_snapshot_id,
         status = v_route, version = 2, updated_at = pg_catalog.clock_timestamp()
   WHERE id = v_expense_id;
  -- Approval OFF: post in this same transaction; no approval row is written.
  IF NOT v_approval THEN
    PERFORM abos.operational_expense_post(v_expense_id, v_actor_id);
  END IF;
  v_response := pg_catalog.jsonb_build_object(
    'expense', abos.operational_expense_json(v_expense_id), 'replayed', false);
  UPDATE abos.idempotency_records
     SET status = 'COMPLETED', resource_type = 'OPERATIONAL_EXPENSE',
         resource_id = v_expense_id, response_code = 200, response_snapshot = v_response,
         completed_at = pg_catalog.clock_timestamp()
   WHERE scope = v_scope AND idempotency_key = v_request_key;
  INSERT INTO abos.audit_records
    (id, actor_user_account_id, legal_entity_id, correlation_id, action,
     entity_type, entity_id, after_state, metadata)
  VALUES
    (pg_catalog.gen_random_uuid(), v_actor_id, v_entity_id, v_correlation_id,
     'OPERATIONAL_EXPENSE_CREATED', 'OPERATIONAL_EXPENSE', v_expense_id,
     abos.operational_expense_json(v_expense_id),
     pg_catalog.jsonb_build_object(
       'source', 'v1-operational-expense',
       'approvalRequired', v_approval,
       'policyVersionId', v_policy.id));
  RETURN v_response;
END
$function$;

CREATE OR REPLACE FUNCTION abos.validate_expense_journal(p_journal abos.journals, p_intent abos.posting_intents)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  expense_row abos.operational_expenses%ROWTYPE;
  treasury_row abos.operational_treasury_accounts%ROWTYPE;
  category_row abos.operational_expense_categories%ROWTYPE;
  policy_row abos.finance_workflow_policy_versions%ROWTYPE;
  snapshot_row abos.exchange_rate_snapshots%ROWTYPE;
  approval_count bigint;
  treasury_subledger_count bigint;
BEGIN
  IF p_intent.intent_kind <> 'EXPENSE' OR p_intent.base_amount IS NULL THEN
    RAISE EXCEPTION 'operational posting requires a posted valued EXPENSE intent'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO expense_row FROM abos.operational_expenses
   WHERE id = p_intent.operational_expense_id AND legal_entity_id = p_journal.legal_entity_id;
  IF NOT FOUND OR expense_row.id IS DISTINCT FROM p_intent.source_id
     OR expense_row.status <> 'POSTED' OR expense_row.journal_id IS DISTINCT FROM p_journal.id
     OR expense_row.original_amount IS DISTINCT FROM p_intent.original_amount
     OR expense_row.original_currency_code IS DISTINCT FROM p_intent.original_currency_code
     OR expense_row.base_amount IS DISTINCT FROM p_intent.base_amount
     OR expense_row.base_currency_code IS DISTINCT FROM p_intent.base_currency_code
     OR expense_row.business_date IS DISTINCT FROM p_journal.accounting_effective_date THEN
    RAISE EXCEPTION 'operational expense, intent and journal do not agree'
      USING ERRCODE = 'check_violation';
  END IF;

  -- 0049: the route came from the EXPENSE setting or the payment kind's setting; no reference is the
  -- Simple Mode default, valid only for a direct posting while no relevant setting requires approval.
  IF expense_row.workflow_policy_version_id IS NULL THEN
    IF expense_row.approval_required OR NOT abos.workflow_policy_allows_direct(p_journal.legal_entity_id,
         ARRAY['EXPENSE', abos.expense_workflow_type(expense_row.payment_kind)], NULL) THEN
      RAISE EXCEPTION 'operational expense approval route does not match its immutable policy snapshot'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    SELECT * INTO policy_row FROM abos.finance_workflow_policy_versions
     WHERE id = expense_row.workflow_policy_version_id AND legal_entity_id = p_journal.legal_entity_id
       AND workflow_type IN ('EXPENSE', abos.expense_workflow_type(expense_row.payment_kind));
    IF NOT FOUND OR policy_row.approval_required IS DISTINCT FROM expense_row.approval_required THEN
      RAISE EXCEPTION 'operational expense approval route does not match its immutable policy snapshot'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  SELECT count(*) INTO approval_count FROM abos.operational_expense_approvals approval
   WHERE approval.operational_expense_id = expense_row.id
     AND approval.legal_entity_id = p_journal.legal_entity_id
     AND approval.decision = 'APPROVED'
     AND approval.approver_user_account_id = p_journal.posted_by_user_account_id;
  IF expense_row.approval_required THEN
    IF approval_count <> 1
       OR p_journal.posted_by_user_account_id = expense_row.created_by_user_account_id THEN
      RAISE EXCEPTION 'approval-required expense must be posted by its independent approver'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF approval_count <> 0
        OR p_journal.posted_by_user_account_id IS DISTINCT FROM expense_row.created_by_user_account_id THEN
    RAISE EXCEPTION 'direct-posting expense must have no approval and be posted by its creator'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO treasury_row FROM abos.operational_treasury_accounts
   WHERE id = expense_row.operational_treasury_account_id
     AND legal_entity_id = p_journal.legal_entity_id AND status = 'ACTIVE';
  SELECT * INTO category_row FROM abos.operational_expense_categories
   WHERE id = expense_row.operational_expense_category_id
     AND legal_entity_id = p_journal.legal_entity_id AND status = 'ACTIVE';
  IF treasury_row.id IS NULL OR category_row.id IS NULL
     OR treasury_row.currency_code <> expense_row.original_currency_code THEN
    RAISE EXCEPTION 'expense requires active same-entity Treasury and category mappings'
      USING ERRCODE = 'check_violation';
  END IF;

  IF expense_row.original_currency_code = expense_row.base_currency_code THEN
    IF expense_row.exchange_rate_snapshot_id IS NOT NULL
       OR expense_row.base_amount <> expense_row.original_amount THEN
      RAISE EXCEPTION 'base-currency expense must retain the same amount without an FX snapshot'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    SELECT * INTO snapshot_row FROM abos.exchange_rate_snapshots
     WHERE id = expense_row.exchange_rate_snapshot_id
       AND legal_entity_id = p_journal.legal_entity_id
       AND source_type = 'OPERATIONAL_EXPENSE' AND source_id = expense_row.id;
    IF NOT FOUND OR snapshot_row.transaction_currency_code <> expense_row.original_currency_code
       OR snapshot_row.base_currency_code <> expense_row.base_currency_code
       OR snapshot_row.rate_date <> expense_row.business_date
       OR p_intent.conversion_snapshot_reference IS DISTINCT FROM snapshot_row.id::text THEN
      RAISE EXCEPTION 'foreign-currency expense requires its exact immutable rate snapshot'
        USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM abos.fx_conversions conversion WHERE conversion.source_type = 'OPERATIONAL_EXPENSE'
         AND conversion.source_id = expense_row.id) THEN
      IF NOT EXISTS (SELECT 1 FROM abos.fx_conversions conversion WHERE conversion.source_type = 'OPERATIONAL_EXPENSE'
           AND conversion.source_id = expense_row.id AND conversion.legal_entity_id = p_journal.legal_entity_id
           AND conversion.exchange_rate_snapshot_id = snapshot_row.id AND conversion.original_amount = expense_row.original_amount
           AND conversion.original_currency_code = expense_row.original_currency_code
           AND conversion.base_currency_code = expense_row.base_currency_code AND conversion.base_amount = expense_row.base_amount) THEN
        RAISE EXCEPTION 'foreign-currency expense requires its immutable FX conversion'
          USING ERRCODE = 'check_violation';
      END IF;
    ELSIF snapshot_row.unit_currency_code = expense_row.original_currency_code
       AND snapshot_row.quote_currency_code = expense_row.base_currency_code THEN
      IF expense_row.base_amount <> expense_row.original_amount * snapshot_row.rate_value THEN
        RAISE EXCEPTION 'expense base amount does not exactly follow its direct rate'
          USING ERRCODE = 'check_violation';
      END IF;
    ELSIF snapshot_row.quote_currency_code = expense_row.original_currency_code
       AND snapshot_row.unit_currency_code = expense_row.base_currency_code THEN
      IF expense_row.base_amount * snapshot_row.rate_value <> expense_row.original_amount THEN
        RAISE EXCEPTION 'inverse rate requires an exact result; rounding policy is not approved'
          USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      RAISE EXCEPTION 'snapshot currency direction does not match the expense'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM abos.journal_lines line
              WHERE line.journal_id = p_journal.id AND line.original_amount <> expense_row.original_amount) THEN
    RAISE EXCEPTION 'operational journal line violates entity, currency, account or dimension rules'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM abos.journal_lines line WHERE line.journal_id = p_journal.id
      AND line.line_number = 1 AND line.ledger_account_id = category_row.ledger_account_id
      AND line.base_debit = expense_row.base_amount AND line.base_credit = 0
      AND line.project_id IS NOT DISTINCT FROM expense_row.project_id
      AND line.department_id IS NOT DISTINCT FROM expense_row.department_id
      AND line.cost_center_id IS NOT DISTINCT FROM expense_row.cost_center_id
      AND line.business_party_id IS NOT DISTINCT FROM expense_row.payee_business_party_id
  ) OR NOT EXISTS (
    SELECT 1 FROM abos.journal_lines line WHERE line.journal_id = p_journal.id
      AND line.line_number = 2 AND line.ledger_account_id = treasury_row.ledger_account_id
      AND line.base_debit = 0 AND line.base_credit = expense_row.base_amount
      AND line.project_id IS NOT DISTINCT FROM expense_row.project_id
      AND line.department_id IS NOT DISTINCT FROM expense_row.department_id
      AND line.cost_center_id IS NOT DISTINCT FROM expense_row.cost_center_id
      AND line.business_party_id IS NULL
  ) THEN
    RAISE EXCEPTION 'expense journal must debit its category and credit its Treasury mapping'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*) INTO treasury_subledger_count
    FROM abos.subledger_entries entry
    JOIN abos.journal_lines line ON line.id = entry.journal_line_id
   WHERE line.journal_id = p_journal.id
     AND entry.subledger_type = 'OPERATIONAL_TREASURY'
     AND entry.operational_treasury_account_id = treasury_row.id
     AND entry.original_amount = -expense_row.original_amount
     AND entry.base_amount = -expense_row.base_amount;
  IF treasury_subledger_count <> 1 OR EXISTS (
    SELECT 1 FROM abos.subledger_entries entry
    JOIN abos.journal_lines line ON line.id = entry.journal_line_id
    WHERE line.journal_id = p_journal.id AND (entry.subledger_type <> 'OPERATIONAL_TREASURY' OR line.line_number <> 2)
  ) THEN
    RAISE EXCEPTION 'expense journal requires exactly one matching Treasury subledger movement'
      USING ERRCODE = 'check_violation';
  END IF;
END
$function$;


-- ---------------------------------------------------------------------------------------------
-- 8. Restated reads: the Safe card carries its accounting-currency book (the sum of the accounting amounts of its
--    posted movements); money options carry each foreign currency's FX setup.
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION abos.treasury_safes_workspace(p_proof text, p_runtime text, p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
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
          'baseBook', (SELECT COALESCE(sum(entry.base_amount), 0)::text FROM abos.subledger_entries entry
             JOIN abos.journal_lines line ON line.id = entry.journal_line_id
             JOIN abos.journals journal ON journal.id = line.journal_id AND journal.status = 'POSTED'
            WHERE entry.subledger_type = 'OPERATIONAL_TREASURY' AND entry.operational_treasury_account_id = account.id
              AND entry.legal_entity_id = account.legal_entity_id),
          'lastMovementDate', balance.last_movement_date),
        'openingBalance', (SELECT jsonb_build_object('id', ob.id, 'amount', ob.amount::text, 'currencyCode', ob.currency_code,
            'asOfDate', ob.as_of_date, 'reference', ob.reference, 'note', ob.note, 'transactionReference', ob.transaction_reference,
            'journalId', ob.journal_id, 'recordedAt', ob.created_at)
          || COALESCE((SELECT jsonb_build_object('reversal', jsonb_build_object('journalId', link.reversal_journal_id,
               'reference', reversal.journal_reference, 'date', reversal.accounting_effective_date, 'reason', link.reason))
             FROM abos.journal_reversal_links link JOIN abos.journals reversal ON reversal.id = link.reversal_journal_id
            WHERE link.original_journal_id = ob.journal_id), '{}'::jsonb)
          FROM abos.treasury_opening_balances ob WHERE ob.operational_treasury_account_id = account.id
         ORDER BY ob.created_at DESC LIMIT 1),
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
$function$;

CREATE OR REPLACE FUNCTION abos.treasury_money_options(p_proof text, p_runtime text, p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE c jsonb; actor uuid; entity uuid; perms jsonb; base text;
BEGIN
  c := abos.treasury_safe_actor(p_proof, p_runtime, p_token, NULL);
  actor := (c->>'userAccountId')::uuid; entity := (c->>'legalEntityId')::uuid;
  perms := COALESCE(c->'permissions', '[]'::jsonb);
  IF NOT (perms ?| ARRAY['treasury.receipt.record', 'treasury.transfer.record', 'treasury.payment.record']) THEN
    RAISE EXCEPTION 'current authority is missing treasury.receipt.record, treasury.transfer.record or treasury.payment.record'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT base_currency_code INTO base FROM abos.legal_entities WHERE id = entity AND currency_policy_status = 'APPROVED';
  RETURN jsonb_build_object(
    'baseCurrency', base, 'today', abos.business_today(),
    'canReceive', perms ? 'treasury.receipt.record', 'canTransfer', perms ? 'treasury.transfer.record', 'canPay', perms ? 'treasury.payment.record',
    'canRecordExpense', perms ? 'finance.expense.create',
    'settings', (SELECT jsonb_object_agg(t.workflow_type, CASE WHEN v.approval_required THEN 'APPROVAL_REQUIRED' ELSE 'READY' END)
      FROM unnest(ARRAY['OTHER_INCOME', 'TREASURY_TRANSFER', 'SUPPLIER_PAYMENT', 'SALARY_PAYMENT']) t(workflow_type)
      LEFT JOIN LATERAL (SELECT id, approval_required FROM abos.finance_workflow_policy_versions p WHERE p.legal_entity_id = entity
        AND p.workflow_type = t.workflow_type ORDER BY version DESC LIMIT 1) v ON true),
    'treasuryAccounts', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', a.id, 'nameEn', a.name_en, 'nameFa', a.name_fa,
        'accountType', a.account_type, 'currencyCode', a.currency_code) ORDER BY a.name_en, a.id)
      FROM abos.operational_treasury_accounts a WHERE a.legal_entity_id = entity AND a.status = 'ACTIVE'), '[]'::jsonb),
    'incomeAccounts', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', l.id, 'code', l.account_code, 'name', l.account_name) ORDER BY l.account_code)
      FROM abos.ledger_accounts l WHERE l.legal_entity_id = entity AND l.status = 'ACTIVE' AND l.posting_allowed AND l.account_type = 'REVENUE'
        AND l.control_account_type IS NULL AND l.account_currency_code IS NOT DISTINCT FROM base
        AND NOT l.requires_project AND NOT l.requires_department AND NOT l.requires_cost_center), '[]'::jsonb),
    'payableAccounts', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', l.id, 'code', l.account_code, 'name', l.account_name,
        'requiresParty', l.control_account_type IS NOT DISTINCT FROM 'AP') ORDER BY l.account_code)
      FROM abos.ledger_accounts l WHERE l.legal_entity_id = entity AND l.status = 'ACTIVE' AND l.posting_allowed AND l.account_type = 'LIABILITY'
        AND (l.control_account_type IS NULL OR l.control_account_type = 'AP') AND l.account_currency_code IS NOT DISTINCT FROM base
        AND NOT l.requires_project AND NOT l.requires_department AND NOT l.requires_cost_center), '[]'::jsonb),
    'fx', COALESCE((SELECT jsonb_agg(abos.fx_setup_view(entity, x.currency_code, abos.business_today()) ORDER BY x.currency_code)
      FROM (SELECT DISTINCT a.currency_code FROM abos.operational_treasury_accounts a
             WHERE a.legal_entity_id = entity AND a.status = 'ACTIVE' AND a.currency_code IS DISTINCT FROM base) x), '[]'::jsonb),
    'parties', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', b.id, 'name', b.display_name) ORDER BY b.display_name, b.id)
      FROM abos.business_parties b WHERE b.legal_entity_id = entity AND b.status = 'ACTIVE'), '[]'::jsonb));
END
$function$;


-- ---------------------------------------------------------------------------------------------
-- 9. FX setup view, FX policy screen and the conversion preview.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION abos.fx_setup_view(p_entity uuid, p_currency text, p_day date)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $setup$
DECLARE p jsonb;
BEGIN
  p := abos.fx_policy_resolve(p_entity, p_currency, p_day);
  RETURN jsonb_build_object('currencyCode', p_currency, 'status', 'READY', 'policy', p,
    'fxDifferenceAccount', (SELECT jsonb_build_object('id', id, 'code', account_code, 'name', account_name)
      FROM abos.ledger_accounts WHERE id = (p->>'fxDifferenceAccountId')::uuid AND legal_entity_id = p_entity));
EXCEPTION WHEN check_violation THEN
  RETURN jsonb_build_object('currencyCode', p_currency, 'status', 'SETUP_REQUIRED', 'message', SQLERRM);
END
$setup$;

CREATE FUNCTION abos.finance_fx_policy_workspace(p_proof text, p_runtime text, p_token text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $workspace$
DECLARE c jsonb; entity uuid; perms jsonb; base text; today date := abos.business_today();
BEGIN
  c := abos.operational_finance_actor(p_proof, p_runtime, p_token, NULL);
  entity := (c->>'legalEntityId')::uuid; perms := COALESCE(c->'permissions', '[]'::jsonb);
  IF NOT (perms ?| ARRAY['finance.fx-policy.manage', 'finance.exchange-rate.record']) THEN
    RAISE EXCEPTION 'current authority is missing finance.fx-policy.manage or finance.exchange-rate.record' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT base_currency_code INTO base FROM abos.legal_entities WHERE id = entity AND currency_policy_status = 'APPROVED';
  RETURN jsonb_build_object('today', today, 'baseCurrency', base, 'canManage', perms ? 'finance.fx-policy.manage',
    'defaultPolicy', jsonb_build_object('roundingMode', 'HALF_UP', 'baseScale', 2),
    'fxDifference', abos.fx_difference_status(entity, base),
    'fxDifferenceAccounts', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', l.id, 'code', l.account_code, 'name', l.account_name,
        'accountType', l.account_type, 'currency', l.account_currency_code, 'ready', abos.fx_difference_account_ready(entity, l.id, base))
        ORDER BY l.account_code)
      FROM abos.ledger_accounts l WHERE l.legal_entity_id = entity AND l.control_account_type = 'FX_DIFFERENCE' AND l.status = 'ACTIVE'), '[]'::jsonb),
    'currencies', COALESCE((SELECT jsonb_agg(jsonb_build_object('currencyCode', cur.code, 'name', cur.name,
        'current', abos.fx_setup_view(entity, cur.code, today),
        'versions', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', v.id, 'version', v.version, 'effectiveFrom', v.effective_from,
            'roundingMode', v.rounding_mode, 'baseScale', v.base_scale, 'reason', v.reason, 'createdAt', v.created_at,
            'createdBy', (SELECT display_name FROM abos.user_accounts WHERE id = v.created_by_user_account_id),
            'fxDifferenceAccount', (SELECT jsonb_build_object('id', l.id, 'code', l.account_code, 'name', l.account_name)
              FROM abos.ledger_accounts l WHERE l.id = v.fx_difference_ledger_account_id)) ORDER BY v.version DESC)
          FROM abos.fx_policy_versions v WHERE v.legal_entity_id = entity AND v.currency_code = cur.code), '[]'::jsonb))
        ORDER BY cur.code)
      FROM abos.currencies cur WHERE cur.enabled AND cur.code IS DISTINCT FROM base), '[]'::jsonb));
END
$workspace$;

CREATE FUNCTION abos.finance_fx_policy_set(p_proof text, p_runtime text, p_token text, p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $set$
DECLARE c jsonb; actor uuid; entity uuid; base text; currency text; effective date; scale integer; mode text; account uuid;
  reason text; expected integer; correlation uuid; current_version integer; v abos.fx_policy_versions%ROWTYPE; unknown text;
BEGIN
  c := abos.operational_finance_actor(p_proof, p_runtime, p_token, 'finance.fx-policy.manage');
  actor := (c->>'userAccountId')::uuid; entity := (c->>'legalEntityId')::uuid;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'FX policy details must be an object' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT string_agg(k, ', ') INTO unknown FROM jsonb_object_keys(p_payload) k WHERE k NOT IN ('currencyCode', 'effectiveFrom', 'baseScale',
    'roundingMode', 'fxDifferenceLedgerAccountId', 'reason', 'expectedVersion', 'correlationId');
  IF unknown IS NOT NULL THEN
    RAISE EXCEPTION 'unknown FX policy fields: %', unknown USING ERRCODE = 'invalid_parameter_value';
  END IF;
  BEGIN
    effective := NULLIF(p_payload->>'effectiveFrom', '')::date;
    scale := (p_payload->>'baseScale')::integer;
    expected := (p_payload->>'expectedVersion')::integer;
    correlation := NULLIF(p_payload->>'correlationId', '')::uuid;
    account := NULLIF(p_payload->>'fxDifferenceLedgerAccountId', '')::uuid;
  EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow OR invalid_datetime_format OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'choose a valid effective date, scale, FX difference account and version' USING ERRCODE = 'invalid_parameter_value';
  END;
  currency := p_payload->>'currencyCode'; mode := p_payload->>'roundingMode'; reason := NULLIF(btrim(p_payload->>'reason'), '');
  IF effective IS NULL OR scale IS NULL OR expected IS NULL OR correlation IS NULL OR account IS NULL THEN
    RAISE EXCEPTION 'choose a valid effective date, scale, FX difference account and version' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF scale NOT BETWEEN 0 AND 6 THEN
    RAISE EXCEPTION 'the scale must be 0 to 6 decimal places' USING ERRCODE = 'check_violation';
  END IF;
  IF mode IS NULL OR mode NOT IN ('HALF_UP', 'EXACT_ONLY') THEN
    RAISE EXCEPTION 'choose the rounding mode: HALF_UP or EXACT_ONLY' USING ERRCODE = 'check_violation';
  END IF;
  IF reason IS NULL OR length(reason) NOT BETWEEN 5 AND 500 THEN
    RAISE EXCEPTION 'write the reason for this FX policy (5 to 500 characters)' USING ERRCODE = 'check_violation';
  END IF;
  SELECT base_currency_code INTO base FROM abos.legal_entities WHERE id = entity AND currency_policy_status = 'APPROVED';
  IF base IS NULL OR currency IS NULL OR currency = base OR NOT EXISTS (SELECT 1 FROM abos.currencies WHERE code = currency AND enabled) THEN
    RAISE EXCEPTION 'an FX policy is saved for an enabled currency other than the accounting currency' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT abos.fx_difference_account_ready(entity, account, base) THEN
    RAISE EXCEPTION 'choose an active income or expense account in % with control FX_DIFFERENCE that accepts postings without dimensions', base
      USING ERRCODE = 'check_violation';
  END IF;
  -- One saved version at a time per currency; a stale screen is refused.
  PERFORM pg_advisory_xact_lock(hashtextextended('abos-fx-policy:' || entity::text || ':' || currency, 0));
  SELECT COALESCE(max(version), 0) INTO current_version FROM abos.fx_policy_versions WHERE legal_entity_id = entity AND currency_code = currency;
  IF expected <> current_version THEN
    RAISE EXCEPTION 'the FX policy changed by someone else; reload and try again' USING ERRCODE = 'serialization_failure';
  END IF;
  INSERT INTO abos.fx_policy_versions (id, legal_entity_id, currency_code, version, effective_from, base_scale, rounding_mode,
    fx_difference_ledger_account_id, reason, created_by_user_account_id, correlation_id)
  VALUES (gen_random_uuid(), entity, currency, current_version + 1, effective, scale, mode, account, reason, actor, correlation)
  RETURNING * INTO v;
  PERFORM abos.money_audit(actor, entity, correlation, 'FX_POLICY_SAVED', 'FX_POLICY', v.id,
    jsonb_build_object('currencyCode', currency, 'version', v.version, 'effectiveFrom', effective, 'baseScale', scale, 'roundingMode', mode,
      'fxDifferenceAccountId', account, 'reason', reason));
  RETURN jsonb_build_object('versionId', v.id, 'currencyCode', currency, 'version', v.version, 'effectiveFrom', effective,
    'baseScale', scale, 'roundingMode', mode, 'status', 'SAVED');
END
$set$;

-- What a recorder sees before saving a foreign-currency movement: the day's current rates for the pair, the FX setup in
-- force and, for an amount, the accounting amount it would post. Nothing is written.
CREATE FUNCTION abos.treasury_fx_preview(p_proof text, p_runtime text, p_token text, p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $preview$
DECLARE c jsonb; entity uuid; perms jsonb; base text; currency text; day date; amount numeric; rate uuid; setup jsonb; rates jsonb;
  chosen abos.exchange_rates%ROWTYPE; preview jsonb; n integer;
BEGIN
  c := abos.treasury_safe_actor(p_proof, p_runtime, p_token, NULL);
  entity := (c->>'legalEntityId')::uuid; perms := COALESCE(c->'permissions', '[]'::jsonb);
  IF NOT (perms ?| ARRAY['treasury.receipt.record', 'treasury.transfer.record', 'treasury.payment.record', 'treasury.opening-balance.record',
       'finance.expense.create']) THEN
    RAISE EXCEPTION 'current authority is missing a money recording permission' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object'
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_payload) k WHERE k NOT IN ('currencyCode', 'businessDate', 'amount', 'exchangeRateId')) THEN
    RAISE EXCEPTION 'unknown preview fields' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  BEGIN
    day := NULLIF(p_payload->>'businessDate', '')::date;
    rate := NULLIF(p_payload->>'exchangeRateId', '')::uuid;
  EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow OR invalid_datetime_format THEN
    RAISE EXCEPTION 'choose a valid date and rate' USING ERRCODE = 'invalid_parameter_value';
  END;
  currency := p_payload->>'currencyCode';
  base := abos.money_currency_base(entity, currency);
  IF day IS NULL THEN RAISE EXCEPTION 'choose a valid date and rate' USING ERRCODE = 'invalid_parameter_value'; END IF;
  IF currency = base THEN
    RETURN jsonb_build_object('currencyCode', currency, 'baseCurrency', base, 'businessDate', day, 'setup', NULL, 'rates', '[]'::jsonb, 'preview', NULL);
  END IF;
  setup := abos.fx_setup_view(entity, currency, day);
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', r.id, 'source', r.rate_source,
      'sarafName', (SELECT display_name FROM abos.business_parties WHERE id = r.saraf_business_party_id),
      'unitCurrency', r.unit_currency_code, 'quoteCurrency', r.quote_currency_code, 'rate', r.rate_value::text) ORDER BY r.rate_source, r.id), '[]'::jsonb),
    count(*)
    INTO rates, n
    FROM abos.exchange_rates r
   WHERE r.legal_entity_id = entity AND r.rate_date = day
     AND least(r.unit_currency_code, r.quote_currency_code) = least(base, currency)
     AND greatest(r.unit_currency_code, r.quote_currency_code) = greatest(base, currency)
     AND NOT EXISTS (SELECT 1 FROM abos.exchange_rates s WHERE s.supersedes_exchange_rate_id = r.id);
  IF NULLIF(p_payload->>'amount', '') IS NOT NULL AND setup->>'status' = 'READY' THEN
    BEGIN
      amount := abos.temporary_funding_amount(p_payload->>'amount');
      SELECT * INTO chosen FROM abos.exchange_rates r WHERE r.legal_entity_id = entity AND r.rate_date = day
        AND (rate IS NULL OR r.id = rate)
        AND least(r.unit_currency_code, r.quote_currency_code) = least(base, currency)
        AND greatest(r.unit_currency_code, r.quote_currency_code) = greatest(base, currency)
        AND NOT EXISTS (SELECT 1 FROM abos.exchange_rates s WHERE s.supersedes_exchange_rate_id = r.id)
        AND (rate IS NOT NULL OR n = 1);
      IF FOUND THEN
        preview := abos.fx_amount(amount, currency, base, chosen.unit_currency_code, chosen.quote_currency_code, chosen.rate_value,
          (setup->'policy'->>'baseScale')::integer, setup->'policy'->>'roundingMode') || jsonb_build_object('exchangeRateId', chosen.id);
      END IF;
    EXCEPTION WHEN check_violation OR invalid_parameter_value THEN
      preview := jsonb_build_object('error', SQLERRM);
    END;
  END IF;
  RETURN jsonb_build_object('currencyCode', currency, 'baseCurrency', base, 'businessDate', day, 'setup', setup, 'rates', rates,
    'preview', preview);
END
$preview$;

-- ---------------------------------------------------------------------------------------------
-- 10. Privileges. Column-level writes only; helpers run with the caller's rights and only the operational Finance
--     owner may call them; the three new entry points are its SECURITY DEFINER functions, callable only by the runtime.
-- ---------------------------------------------------------------------------------------------
REVOKE ALL ON TABLE abos.fx_policy_versions, abos.fx_conversions FROM PUBLIC;
GRANT SELECT ON abos.fx_policy_versions, abos.fx_conversions TO abos_v1_operational_finance_owner;
GRANT INSERT (id, legal_entity_id, currency_code, version, effective_from, base_scale, rounding_mode, fx_difference_ledger_account_id,
  reason, created_by_user_account_id, correlation_id) ON abos.fx_policy_versions TO abos_v1_operational_finance_owner;
GRANT INSERT (id, legal_entity_id, source_type, source_id, exchange_rate_snapshot_id, fx_policy_version_id, rounding_mode, base_scale,
  fx_difference_ledger_account_id, original_amount, original_currency_code, base_currency_code, exact_base_amount, base_amount,
  rounding_difference, created_by_user_account_id) ON abos.fx_conversions TO abos_v1_operational_finance_owner;
GRANT SELECT (base_amount, fx_conversion_id), INSERT (base_amount, fx_conversion_id)
  ON abos.treasury_cash_receipts, abos.treasury_payments, abos.treasury_transfers, abos.treasury_opening_balances
  TO abos_v1_operational_finance_owner;

REVOKE ALL ON FUNCTION
  abos.fx_difference_status(uuid, text), abos.fx_difference_account_ready(uuid, uuid, text), abos.fx_policy_resolve(uuid, text, date),
  abos.fx_amount(numeric, text, text, text, text, numeric, integer, text),
  abos.fx_convert(uuid, text, uuid, text, date, uuid, uuid, numeric), abos.money_currency_base(uuid, text),
  abos.fx_source_matches(uuid, text, uuid, text, numeric, numeric, uuid, abos.posting_intents), abos.fx_setup_view(uuid, text, date),
  abos.fx_append_only()
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  abos.fx_difference_status(uuid, text), abos.fx_difference_account_ready(uuid, uuid, text), abos.fx_policy_resolve(uuid, text, date),
  abos.fx_amount(numeric, text, text, text, text, numeric, integer, text),
  abos.fx_convert(uuid, text, uuid, text, date, uuid, uuid, numeric), abos.money_currency_base(uuid, text),
  abos.fx_source_matches(uuid, text, uuid, text, numeric, numeric, uuid, abos.posting_intents), abos.fx_setup_view(uuid, text, date)
  TO abos_v1_operational_finance_owner;

ALTER FUNCTION abos.finance_fx_policy_workspace(text, text, text) OWNER TO abos_v1_operational_finance_owner;
ALTER FUNCTION abos.finance_fx_policy_set(text, text, text, jsonb) OWNER TO abos_v1_operational_finance_owner;
ALTER FUNCTION abos.treasury_fx_preview(text, text, text, jsonb) OWNER TO abos_v1_operational_finance_owner;
REVOKE ALL ON FUNCTION abos.finance_fx_policy_workspace(text, text, text), abos.finance_fx_policy_set(text, text, text, jsonb),
  abos.treasury_fx_preview(text, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION abos.finance_fx_policy_workspace(text, text, text), abos.finance_fx_policy_set(text, text, text, jsonb),
  abos.treasury_fx_preview(text, text, text, jsonb) TO abos_e1_runtime;
