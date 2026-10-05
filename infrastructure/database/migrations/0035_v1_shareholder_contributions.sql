-- V1 shareholder contributions: DECLARATION ONLY.
--
-- A shareholder has zero, one or many contribution rows of type CASH, IN_KIND or CREDIT. "None yet"
-- is the absence of rows; no zero-value transaction is ever stored. Three independent status
-- dimensions replace a single linear workflow:
--   record_status    DRAFT / DECLARED / APPROVED / CANCELLED / POSTED
--   receipt_status   NOT_APPLICABLE / NOT_RECEIVED / PARTIALLY_RECEIVED / RECEIVED
--   valuation_status NOT_APPLICABLE / NOT_VALUED / VALUED / APPROVED
-- The later values exist for compatibility only. A lifecycle guard keeps every writer inside the
-- P1 states (DRAFT/DECLARED/CANCELLED, NOT_RECEIVED/NOT_APPLICABLE, NOT_VALUED/NOT_APPLICABLE)
-- until a separately approved phase replaces it.
--
-- Nothing here creates or changes a Treasury receipt, Safe, posting intent, journal, journal line,
-- subledger entry, receivable, payable, loan or equity record. An estimated asset value and a credit
-- classification are information only, and a CASH declaration is not cash received.
--
-- Existing capital agreements, installments and capital requests are not rewritten or copied; the
-- read model shows them separately as legacy cash capital agreements. No document is required, and
-- this migration has no dependency on the agreement-document migrations.

CREATE TABLE abos.shareholder_contributions (
  id uuid PRIMARY KEY,
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  shareholder_profile_id uuid NOT NULL,
  contribution_type text NOT NULL CHECK (contribution_type IN ('CASH', 'IN_KIND', 'CREDIT')),
  business_date date NOT NULL,
  description text CHECK (description IS NULL OR length(btrim(description)) BETWEEN 1 AND 1000),
  reference text CHECK (reference IS NULL OR length(btrim(reference)) BETWEEN 1 AND 100),
  record_status text NOT NULL
    CHECK (record_status IN ('DRAFT', 'DECLARED', 'APPROVED', 'CANCELLED', 'POSTED')),
  receipt_status text NOT NULL
    CHECK (receipt_status IN ('NOT_APPLICABLE', 'NOT_RECEIVED', 'PARTIALLY_RECEIVED', 'RECEIVED')),
  valuation_status text NOT NULL
    CHECK (valuation_status IN ('NOT_APPLICABLE', 'NOT_VALUED', 'VALUED', 'APPROVED')),
  -- CASH and CREDIT
  amount numeric CHECK (amount IS NULL OR amount > 0),
  currency_code text REFERENCES abos.currencies(code),
  -- IN_KIND
  asset_category text CHECK (asset_category IS NULL OR asset_category IN
    ('LAND_PROPERTY', 'EQUIPMENT_MACHINERY', 'GOODS_MATERIALS', 'OTHER')),
  item_name text CHECK (item_name IS NULL OR length(btrim(item_name)) BETWEEN 1 AND 200),
  quantity numeric CHECK (quantity IS NULL OR quantity > 0),
  unit text CHECK (unit IS NULL OR length(btrim(unit)) BETWEEN 1 AND 40),
  ownership_note text CHECK (ownership_note IS NULL OR length(btrim(ownership_note)) BETWEEN 1 AND 1000),
  estimated_value numeric CHECK (estimated_value IS NULL OR estimated_value > 0),
  valuation_currency_code text REFERENCES abos.currencies(code),
  -- CREDIT (information only; set by a later, Finance-authorized classification step)
  credit_classification text CHECK (credit_classification IS NULL OR credit_classification IN
    ('UNCLASSIFIED', 'CAPITAL_RECEIVABLE', 'SHAREHOLDER_LOAN', 'OFFSET')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by_user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by_user_account_id uuid REFERENCES abos.user_accounts(id),
  updated_at timestamptz,
  declared_by_user_account_id uuid REFERENCES abos.user_accounts(id),
  declared_at timestamptz,
  cancelled_by_user_account_id uuid REFERENCES abos.user_accounts(id),
  cancelled_at timestamptz,
  cancellation_reason text CHECK (cancellation_reason IS NULL OR length(btrim(cancellation_reason)) BETWEEN 3 AND 300),
  UNIQUE (id, legal_entity_id),
  FOREIGN KEY (shareholder_profile_id, legal_entity_id)
    REFERENCES abos.shareholder_profiles(id, legal_entity_id),
  -- One shape per type; fields of other types must stay empty.
  CONSTRAINT shareholder_contributions_cash_shape CHECK (contribution_type <> 'CASH' OR (
    amount IS NOT NULL AND currency_code IS NOT NULL
    AND asset_category IS NULL AND item_name IS NULL AND quantity IS NULL AND unit IS NULL
    AND ownership_note IS NULL AND estimated_value IS NULL AND valuation_currency_code IS NULL
    AND credit_classification IS NULL
    AND valuation_status = 'NOT_APPLICABLE' AND receipt_status <> 'NOT_APPLICABLE')),
  CONSTRAINT shareholder_contributions_in_kind_shape CHECK (contribution_type <> 'IN_KIND' OR (
    asset_category IS NOT NULL AND item_name IS NOT NULL
    AND amount IS NULL AND currency_code IS NULL AND credit_classification IS NULL
    AND (estimated_value IS NULL) = (valuation_currency_code IS NULL)
    AND (unit IS NULL OR quantity IS NOT NULL)
    AND valuation_status <> 'NOT_APPLICABLE' AND receipt_status <> 'NOT_APPLICABLE')),
  CONSTRAINT shareholder_contributions_credit_shape CHECK (contribution_type <> 'CREDIT' OR (
    amount IS NOT NULL AND currency_code IS NOT NULL AND credit_classification IS NOT NULL
    AND asset_category IS NULL AND item_name IS NULL AND quantity IS NULL AND unit IS NULL
    AND ownership_note IS NULL AND estimated_value IS NULL AND valuation_currency_code IS NULL
    AND valuation_status = 'NOT_APPLICABLE')),
  CONSTRAINT shareholder_contributions_cancelled_shape CHECK (
    (record_status = 'CANCELLED') = (cancelled_at IS NOT NULL)
    AND (record_status = 'CANCELLED') = (cancellation_reason IS NOT NULL)
    AND (cancelled_at IS NULL) = (cancelled_by_user_account_id IS NULL)),
  CONSTRAINT shareholder_contributions_declared_shape CHECK (
    (declared_at IS NULL) = (declared_by_user_account_id IS NULL)
    AND (record_status NOT IN ('DECLARED', 'APPROVED', 'POSTED') OR declared_at IS NOT NULL))
);

CREATE INDEX shareholder_contributions_by_shareholder
  ON abos.shareholder_contributions (legal_entity_id, shareholder_profile_id, created_at);

-- P1 lifecycle guard: applies to every writer, including the owner of the table.
CREATE FUNCTION abos.guard_shareholder_contribution_lifecycle()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $guard$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'shareholder contributions are never deleted; cancel them instead'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.record_status IN ('APPROVED', 'POSTED')
     OR NEW.receipt_status IN ('PARTIALLY_RECEIVED', 'RECEIVED')
     OR NEW.valuation_status IN ('VALUED', 'APPROVED') THEN
    RAISE EXCEPTION 'contribution approval, receipt, valuation and posting are not available in this phase'
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.record_status NOT IN ('DRAFT', 'DECLARED') OR NEW.version <> 1 THEN
      RAISE EXCEPTION 'a new contribution starts as DRAFT or DECLARED at version 1'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.contribution_type = 'CREDIT' AND NEW.credit_classification <> 'UNCLASSIFIED' THEN
      RAISE EXCEPTION 'a new credit contribution is UNCLASSIFIED; classification is a later Finance step'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  -- UPDATE
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.legal_entity_id IS DISTINCT FROM OLD.legal_entity_id
     OR NEW.shareholder_profile_id IS DISTINCT FROM OLD.shareholder_profile_id
     OR NEW.contribution_type IS DISTINCT FROM OLD.contribution_type
     OR NEW.created_by_user_account_id IS DISTINCT FROM OLD.created_by_user_account_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.credit_classification IS DISTINCT FROM OLD.credit_classification THEN
    RAISE EXCEPTION 'a contribution''s identity, shareholder, type, creator and classification cannot change here'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.record_status = 'CANCELLED' THEN
    RAISE EXCEPTION 'a cancelled contribution cannot change' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT ((OLD.record_status = 'DRAFT' AND NEW.record_status IN ('DRAFT', 'DECLARED', 'CANCELLED'))
       OR (OLD.record_status = 'DECLARED' AND NEW.record_status IN ('DECLARED', 'CANCELLED'))) THEN
    RAISE EXCEPTION 'contribution status cannot change from % to %', OLD.record_status, NEW.record_status
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'every contribution change increments its version' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$guard$;
CREATE TRIGGER shareholder_contributions_lifecycle_guard
BEFORE INSERT OR UPDATE OR DELETE ON abos.shareholder_contributions
FOR EACH ROW EXECUTE FUNCTION abos.guard_shareholder_contribution_lifecycle();
REVOKE ALL ON FUNCTION abos.guard_shareholder_contribution_lifecycle() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Least privilege: the existing shareholder setup owner (0031) gets column-level access only.
-- ---------------------------------------------------------------------------
GRANT SELECT (id, legal_entity_id, shareholder_profile_id, contribution_type, business_date, description,
  reference, record_status, receipt_status, valuation_status, amount, currency_code, asset_category, item_name,
  quantity, unit, ownership_note, estimated_value, valuation_currency_code, credit_classification, version,
  created_by_user_account_id, created_at, updated_by_user_account_id, updated_at, declared_by_user_account_id,
  declared_at, cancelled_by_user_account_id, cancelled_at, cancellation_reason)
  ON abos.shareholder_contributions TO abos_v1_shareholder_setup_owner;
GRANT INSERT (id, legal_entity_id, shareholder_profile_id, contribution_type, business_date, description,
  reference, record_status, receipt_status, valuation_status, amount, currency_code, asset_category, item_name,
  quantity, unit, ownership_note, estimated_value, valuation_currency_code, credit_classification,
  created_by_user_account_id, declared_by_user_account_id, declared_at)
  ON abos.shareholder_contributions TO abos_v1_shareholder_setup_owner;
GRANT UPDATE (business_date, description, reference, record_status, amount, currency_code, asset_category,
  item_name, quantity, unit, ownership_note, estimated_value, valuation_currency_code, version,
  updated_by_user_account_id, updated_at, declared_by_user_account_id, declared_at,
  cancelled_by_user_account_id, cancelled_at, cancellation_reason)
  ON abos.shareholder_contributions TO abos_v1_shareholder_setup_owner;

-- ---------------------------------------------------------------------------
-- Internal helper (owner only): validates and normalizes the fields of one contribution type.
-- ---------------------------------------------------------------------------
CREATE FUNCTION abos.shareholder_contribution_fields(p_type text, p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $fields$
DECLARE
  v_date date;
  v_description text := NULLIF(btrim(p_payload ->> 'description'), '');
  v_reference text := NULLIF(btrim(p_payload ->> 'reference'), '');
  v_currency text;
  v_category text;
  v_item text;
  v_quantity numeric;
  v_unit text;
  v_note text;
  v_estimate numeric;
  v_valuation_currency text;
  v_amount numeric;
BEGIN
  BEGIN
    v_date := NULLIF(p_payload ->> 'businessDate', '')::date;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'the contribution date is not a valid date' USING ERRCODE = 'invalid_parameter_value';
  END;
  IF v_date IS NULL OR v_date < DATE '1950-01-01' OR v_date > current_date + 3650 THEN
    RAISE EXCEPTION 'a contribution date is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF (v_description IS NOT NULL AND length(v_description) > 1000) OR (v_reference IS NOT NULL AND length(v_reference) > 100) THEN
    RAISE EXCEPTION 'the description (at most 1000 characters) or reference (at most 100 characters) is too long'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  CASE p_type
    WHEN 'CASH', 'CREDIT' THEN
      IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_payload) k
                  WHERE k IN ('assetCategory', 'itemName', 'quantity', 'unit', 'ownershipNote', 'estimatedValue', 'valuationCurrencyCode')
                    AND p_payload ->> k IS NOT NULL AND p_payload ->> k <> '') THEN
        RAISE EXCEPTION 'asset fields do not apply to a % contribution', lower(p_type) USING ERRCODE = 'invalid_parameter_value';
      END IF;
      v_amount := abos.shareholder_setup_amount(p_payload ->> 'amount');
      v_currency := upper(NULLIF(btrim(p_payload ->> 'currencyCode'), ''));
      IF v_currency IS NULL OR NOT EXISTS (SELECT 1 FROM abos.currencies c WHERE c.code = v_currency AND c.enabled) THEN
        RAISE EXCEPTION 'an enabled currency is required' USING ERRCODE = 'invalid_parameter_value';
      END IF;
      IF p_type = 'CREDIT' AND v_description IS NULL THEN
        RAISE EXCEPTION 'a credit contribution needs a description' USING ERRCODE = 'invalid_parameter_value';
      END IF;
      RETURN jsonb_build_object('businessDate', v_date, 'description', v_description, 'reference', v_reference,
        'amount', v_amount::text, 'currencyCode', v_currency);
    WHEN 'IN_KIND' THEN
      IF NULLIF(p_payload ->> 'amount', '') IS NOT NULL OR NULLIF(p_payload ->> 'currencyCode', '') IS NOT NULL THEN
        RAISE EXCEPTION 'an asset contribution has no cash amount; use the optional estimated value'
          USING ERRCODE = 'invalid_parameter_value';
      END IF;
      v_category := NULLIF(btrim(p_payload ->> 'assetCategory'), '');
      v_item := NULLIF(btrim(p_payload ->> 'itemName'), '');
      v_unit := NULLIF(btrim(p_payload ->> 'unit'), '');
      v_note := NULLIF(btrim(p_payload ->> 'ownershipNote'), '');
      v_valuation_currency := upper(NULLIF(btrim(p_payload ->> 'valuationCurrencyCode'), ''));
      IF v_category IS NULL OR v_category NOT IN ('LAND_PROPERTY', 'EQUIPMENT_MACHINERY', 'GOODS_MATERIALS', 'OTHER') THEN
        RAISE EXCEPTION 'choose an asset category' USING ERRCODE = 'invalid_parameter_value';
      END IF;
      IF v_item IS NULL OR length(v_item) > 200 OR (v_unit IS NOT NULL AND length(v_unit) > 40)
         OR (v_note IS NOT NULL AND length(v_note) > 1000) THEN
        RAISE EXCEPTION 'an item name (at most 200 characters) is required; unit and note must be short'
          USING ERRCODE = 'invalid_parameter_value';
      END IF;
      IF NULLIF(p_payload ->> 'quantity', '') IS NOT NULL THEN
        v_quantity := abos.shareholder_setup_amount(p_payload ->> 'quantity');
      ELSIF v_unit IS NOT NULL THEN
        RAISE EXCEPTION 'a unit needs a quantity' USING ERRCODE = 'invalid_parameter_value';
      END IF;
      IF NULLIF(p_payload ->> 'estimatedValue', '') IS NOT NULL THEN
        v_estimate := abos.shareholder_setup_amount(p_payload ->> 'estimatedValue');
        IF v_valuation_currency IS NULL OR NOT EXISTS (SELECT 1 FROM abos.currencies c WHERE c.code = v_valuation_currency AND c.enabled) THEN
          RAISE EXCEPTION 'an estimated value needs an enabled valuation currency' USING ERRCODE = 'invalid_parameter_value';
        END IF;
      ELSIF v_valuation_currency IS NOT NULL THEN
        RAISE EXCEPTION 'a valuation currency needs an estimated value' USING ERRCODE = 'invalid_parameter_value';
      END IF;
      RETURN jsonb_build_object('businessDate', v_date, 'description', v_description, 'reference', v_reference,
        'assetCategory', v_category, 'itemName', v_item, 'quantity', v_quantity::text, 'unit', v_unit,
        'ownershipNote', v_note, 'estimatedValue', v_estimate::text, 'valuationCurrencyCode', v_valuation_currency);
    ELSE
      RAISE EXCEPTION 'choose a contribution type: CASH, IN_KIND or CREDIT' USING ERRCODE = 'invalid_parameter_value';
  END CASE;
END
$fields$;

-- ---------------------------------------------------------------------------
-- Restricted entry points (actor and legal entity come only from the authenticated session).
-- ---------------------------------------------------------------------------
CREATE FUNCTION abos.shareholder_contribution_create(
  p_identity_proof text, p_runtime_token_sha256 text, p_token_sha256 text, p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $create$
DECLARE
  v_context jsonb;
  v_actor uuid;
  v_entity uuid;
  v_profile uuid;
  v_type text;
  v_declare boolean;
  v_fields jsonb;
  v_key text;
  v_correlation uuid;
  v_scope text;
  v_replay jsonb;
  v_id uuid := pg_catalog.gen_random_uuid();
  v_status text;
  v_response jsonb;
BEGIN
  v_context := abos.shareholder_setup_actor(p_identity_proof, p_runtime_token_sha256, p_token_sha256,
    ARRAY['shareholder.setup.manage']);
  v_actor := (v_context ->> 'userAccountId')::uuid;
  v_entity := (v_context ->> 'legalEntityId')::uuid;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' OR EXISTS (
       SELECT 1 FROM jsonb_object_keys(p_payload) k
        WHERE k NOT IN ('shareholderProfileId', 'contributionType', 'businessDate', 'description', 'reference',
                        'amount', 'currencyCode', 'assetCategory', 'itemName', 'quantity', 'unit', 'ownershipNote',
                        'estimatedValue', 'valuationCurrencyCode', 'declare', 'idempotencyKey', 'correlationId')) THEN
    RAISE EXCEPTION 'unknown or missing contribution fields' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  BEGIN
    v_profile := NULLIF(p_payload ->> 'shareholderProfileId', '')::uuid;
    v_correlation := NULLIF(p_payload ->> 'correlationId', '')::uuid;
    v_declare := COALESCE((p_payload ->> 'declare')::boolean, true);
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'unknown or missing contribution fields' USING ERRCODE = 'invalid_parameter_value';
  END;
  v_type := upper(NULLIF(btrim(p_payload ->> 'contributionType'), ''));
  v_key := NULLIF(btrim(p_payload ->> 'idempotencyKey'), '');
  IF v_profile IS NULL THEN
    RAISE EXCEPTION 'choose a shareholder' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_fields := abos.shareholder_contribution_fields(v_type, p_payload);
  v_scope := v_entity::text || ':SHAREHOLDER_CONTRIBUTION_CREATE';
  v_replay := abos.shareholder_setup_idempotency_begin(v_scope, v_key,
    encode(sha256(convert_to(jsonb_build_object('actor', v_actor, 'profile', v_profile, 'type', v_type,
      'declare', v_declare, 'fields', v_fields)::text, 'UTF8')), 'hex'), v_correlation);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;
  IF NOT EXISTS (SELECT 1 FROM abos.shareholder_profiles profile
                  WHERE profile.id = v_profile AND profile.legal_entity_id = v_entity AND profile.status = 'ACTIVE') THEN
    RAISE EXCEPTION 'the shareholder is not an active shareholder of this legal entity' USING ERRCODE = 'no_data_found';
  END IF;
  v_status := CASE WHEN v_declare THEN 'DECLARED' ELSE 'DRAFT' END;
  INSERT INTO abos.shareholder_contributions
    (id, legal_entity_id, shareholder_profile_id, contribution_type, business_date, description, reference,
     record_status, receipt_status, valuation_status, amount, currency_code, asset_category, item_name, quantity,
     unit, ownership_note, estimated_value, valuation_currency_code, credit_classification,
     created_by_user_account_id, declared_by_user_account_id, declared_at)
  VALUES
    (v_id, v_entity, v_profile, v_type, (v_fields ->> 'businessDate')::date, v_fields ->> 'description',
     v_fields ->> 'reference', v_status,
     CASE v_type WHEN 'CREDIT' THEN 'NOT_APPLICABLE' ELSE 'NOT_RECEIVED' END,
     CASE v_type WHEN 'IN_KIND' THEN 'NOT_VALUED' ELSE 'NOT_APPLICABLE' END,
     (v_fields ->> 'amount')::numeric, v_fields ->> 'currencyCode', v_fields ->> 'assetCategory',
     v_fields ->> 'itemName', (v_fields ->> 'quantity')::numeric, v_fields ->> 'unit', v_fields ->> 'ownershipNote',
     (v_fields ->> 'estimatedValue')::numeric, v_fields ->> 'valuationCurrencyCode',
     CASE v_type WHEN 'CREDIT' THEN 'UNCLASSIFIED' END,
     v_actor, CASE WHEN v_declare THEN v_actor END, CASE WHEN v_declare THEN pg_catalog.clock_timestamp() END);
  v_response := jsonb_build_object('contributionId', v_id, 'recordStatus', v_status, 'version', 1, 'replayed', false);
  PERFORM abos.shareholder_setup_audit(v_actor, v_entity, v_correlation, 'SHAREHOLDER_CONTRIBUTION_RECORDED',
    'SHAREHOLDER_CONTRIBUTION', v_id, NULL,
    v_fields || jsonb_build_object('shareholderProfileId', v_profile, 'contributionType', v_type, 'recordStatus', v_status));
  PERFORM abos.shareholder_setup_idempotency_complete(v_scope, v_key, 'SHAREHOLDER_CONTRIBUTION', v_id, v_response);
  RETURN v_response;
END
$create$;

-- Locks one contribution of the actor's legal entity and checks its expected version.
CREATE FUNCTION abos.shareholder_contribution_lock(p_entity uuid, p_payload jsonb)
RETURNS abos.shareholder_contributions
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $lock$
DECLARE
  v_id uuid;
  v_version integer;
  v_row abos.shareholder_contributions%ROWTYPE;
BEGIN
  BEGIN
    v_id := NULLIF(p_payload ->> 'contributionId', '')::uuid;
    v_version := NULLIF(p_payload ->> 'expectedVersion', '')::integer;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'a contribution and its expected version are required' USING ERRCODE = 'invalid_parameter_value';
  END;
  IF v_id IS NULL OR v_version IS NULL THEN
    RAISE EXCEPTION 'a contribution and its expected version are required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO v_row FROM abos.shareholder_contributions c
   WHERE c.id = v_id AND c.legal_entity_id = p_entity
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'contribution not found in this legal entity' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_row.version <> v_version THEN
    RAISE EXCEPTION 'this contribution changed; reload it and try again' USING ERRCODE = 'serialization_failure';
  END IF;
  RETURN v_row;
END
$lock$;

CREATE FUNCTION abos.shareholder_contribution_update(
  p_identity_proof text, p_runtime_token_sha256 text, p_token_sha256 text, p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $update$
DECLARE
  v_context jsonb;
  v_actor uuid;
  v_entity uuid;
  v_row abos.shareholder_contributions%ROWTYPE;
  v_fields jsonb;
BEGIN
  v_context := abos.shareholder_setup_actor(p_identity_proof, p_runtime_token_sha256, p_token_sha256,
    ARRAY['shareholder.setup.manage']);
  v_actor := (v_context ->> 'userAccountId')::uuid;
  v_entity := (v_context ->> 'legalEntityId')::uuid;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' OR EXISTS (
       SELECT 1 FROM jsonb_object_keys(p_payload) k
        WHERE k NOT IN ('contributionId', 'expectedVersion', 'businessDate', 'description', 'reference', 'amount',
                        'currencyCode', 'assetCategory', 'itemName', 'quantity', 'unit', 'ownershipNote',
                        'estimatedValue', 'valuationCurrencyCode')) THEN
    RAISE EXCEPTION 'unknown or missing contribution fields' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_row := abos.shareholder_contribution_lock(v_entity, p_payload);
  IF v_row.record_status NOT IN ('DRAFT', 'DECLARED') THEN
    RAISE EXCEPTION 'only a draft or declared contribution can be edited' USING ERRCODE = 'check_violation';
  END IF;
  v_fields := abos.shareholder_contribution_fields(v_row.contribution_type, p_payload);
  UPDATE abos.shareholder_contributions
     SET business_date = (v_fields ->> 'businessDate')::date, description = v_fields ->> 'description',
         reference = v_fields ->> 'reference', amount = (v_fields ->> 'amount')::numeric,
         currency_code = v_fields ->> 'currencyCode', asset_category = v_fields ->> 'assetCategory',
         item_name = v_fields ->> 'itemName', quantity = (v_fields ->> 'quantity')::numeric, unit = v_fields ->> 'unit',
         ownership_note = v_fields ->> 'ownershipNote', estimated_value = (v_fields ->> 'estimatedValue')::numeric,
         valuation_currency_code = v_fields ->> 'valuationCurrencyCode', version = v_row.version + 1,
         updated_by_user_account_id = v_actor, updated_at = pg_catalog.clock_timestamp()
   WHERE id = v_row.id;
  PERFORM abos.shareholder_setup_audit(v_actor, v_entity, NULL, 'SHAREHOLDER_CONTRIBUTION_EDITED',
    'SHAREHOLDER_CONTRIBUTION', v_row.id,
    jsonb_build_object('businessDate', v_row.business_date, 'description', v_row.description, 'reference', v_row.reference,
      'amount', v_row.amount::text, 'currencyCode', v_row.currency_code, 'assetCategory', v_row.asset_category,
      'itemName', v_row.item_name, 'quantity', v_row.quantity::text, 'unit', v_row.unit,
      'ownershipNote', v_row.ownership_note, 'estimatedValue', v_row.estimated_value::text,
      'valuationCurrencyCode', v_row.valuation_currency_code, 'version', v_row.version),
    v_fields || jsonb_build_object('version', v_row.version + 1));
  RETURN jsonb_build_object('contributionId', v_row.id, 'version', v_row.version + 1, 'changed', true);
END
$update$;

CREATE FUNCTION abos.shareholder_contribution_declare(
  p_identity_proof text, p_runtime_token_sha256 text, p_token_sha256 text, p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $declare$
DECLARE
  v_context jsonb;
  v_actor uuid;
  v_entity uuid;
  v_id uuid;
  v_current abos.shareholder_contributions%ROWTYPE;
  v_row abos.shareholder_contributions%ROWTYPE;
BEGIN
  v_context := abos.shareholder_setup_actor(p_identity_proof, p_runtime_token_sha256, p_token_sha256,
    ARRAY['shareholder.setup.manage']);
  v_actor := (v_context ->> 'userAccountId')::uuid;
  v_entity := (v_context ->> 'legalEntityId')::uuid;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' OR EXISTS (
       SELECT 1 FROM jsonb_object_keys(p_payload) k WHERE k NOT IN ('contributionId', 'expectedVersion')) THEN
    RAISE EXCEPTION 'unknown or missing contribution fields' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- An already declared contribution is a successful replay, whatever version the caller saw.
  BEGIN
    v_id := NULLIF(p_payload ->> 'contributionId', '')::uuid;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'a contribution and its expected version are required' USING ERRCODE = 'invalid_parameter_value';
  END;
  SELECT * INTO v_current FROM abos.shareholder_contributions c
   WHERE c.id = v_id AND c.legal_entity_id = v_entity FOR UPDATE;
  IF FOUND AND v_current.record_status = 'DECLARED' THEN
    RETURN jsonb_build_object('contributionId', v_current.id, 'version', v_current.version, 'changed', false);
  END IF;
  v_row := abos.shareholder_contribution_lock(v_entity, p_payload);
  IF v_row.record_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'only a draft contribution can be declared' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE abos.shareholder_contributions
     SET record_status = 'DECLARED', declared_by_user_account_id = v_actor,
         declared_at = pg_catalog.clock_timestamp(), version = v_row.version + 1,
         updated_by_user_account_id = v_actor, updated_at = pg_catalog.clock_timestamp()
   WHERE id = v_row.id;
  PERFORM abos.shareholder_setup_audit(v_actor, v_entity, NULL, 'SHAREHOLDER_CONTRIBUTION_DECLARED',
    'SHAREHOLDER_CONTRIBUTION', v_row.id, jsonb_build_object('recordStatus', 'DRAFT', 'version', v_row.version),
    jsonb_build_object('recordStatus', 'DECLARED', 'version', v_row.version + 1));
  RETURN jsonb_build_object('contributionId', v_row.id, 'version', v_row.version + 1, 'changed', true);
END
$declare$;

CREATE FUNCTION abos.shareholder_contribution_cancel(
  p_identity_proof text, p_runtime_token_sha256 text, p_token_sha256 text, p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $cancel$
DECLARE
  v_context jsonb;
  v_actor uuid;
  v_entity uuid;
  v_reason text;
  v_id uuid;
  v_current abos.shareholder_contributions%ROWTYPE;
  v_row abos.shareholder_contributions%ROWTYPE;
BEGIN
  v_context := abos.shareholder_setup_actor(p_identity_proof, p_runtime_token_sha256, p_token_sha256,
    ARRAY['shareholder.setup.manage']);
  v_actor := (v_context ->> 'userAccountId')::uuid;
  v_entity := (v_context ->> 'legalEntityId')::uuid;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' OR EXISTS (
       SELECT 1 FROM jsonb_object_keys(p_payload) k WHERE k NOT IN ('contributionId', 'expectedVersion', 'reason')) THEN
    RAISE EXCEPTION 'unknown or missing contribution fields' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_reason := NULLIF(btrim(p_payload ->> 'reason'), '');
  IF v_reason IS NULL OR length(v_reason) NOT BETWEEN 3 AND 300 THEN
    RAISE EXCEPTION 'a cancellation reason (3-300 characters) is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  BEGIN
    v_id := NULLIF(p_payload ->> 'contributionId', '')::uuid;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'a contribution and its expected version are required' USING ERRCODE = 'invalid_parameter_value';
  END;
  SELECT * INTO v_current FROM abos.shareholder_contributions c
   WHERE c.id = v_id AND c.legal_entity_id = v_entity FOR UPDATE;
  IF FOUND AND v_current.record_status = 'CANCELLED' THEN
    RETURN jsonb_build_object('contributionId', v_current.id, 'version', v_current.version, 'changed', false);
  END IF;
  v_row := abos.shareholder_contribution_lock(v_entity, p_payload);
  IF v_row.record_status NOT IN ('DRAFT', 'DECLARED') THEN
    RAISE EXCEPTION 'only a draft or declared contribution can be cancelled' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE abos.shareholder_contributions
     SET record_status = 'CANCELLED', cancelled_by_user_account_id = v_actor,
         cancelled_at = pg_catalog.clock_timestamp(), cancellation_reason = v_reason,
         version = v_row.version + 1, updated_by_user_account_id = v_actor, updated_at = pg_catalog.clock_timestamp()
   WHERE id = v_row.id;
  PERFORM abos.shareholder_setup_audit(v_actor, v_entity, NULL, 'SHAREHOLDER_CONTRIBUTION_CANCELLED',
    'SHAREHOLDER_CONTRIBUTION', v_row.id,
    jsonb_build_object('recordStatus', v_row.record_status, 'version', v_row.version),
    jsonb_build_object('recordStatus', 'CANCELLED', 'reason', v_reason, 'version', v_row.version + 1));
  RETURN jsonb_build_object('contributionId', v_row.id, 'version', v_row.version + 1, 'changed', true);
END
$cancel$;

-- Simple shareholder read model: contributions per shareholder, plus any legacy cash capital
-- agreements shown separately (never copied into contributions and never added to their totals).
CREATE FUNCTION abos.shareholder_contributions_workspace(
  p_identity_proof text, p_runtime_token_sha256 text, p_token_sha256 text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $workspace$
DECLARE
  v_context jsonb;
  v_entity uuid;
  v_permissions jsonb;
BEGIN
  v_context := abos.shareholder_setup_actor(p_identity_proof, p_runtime_token_sha256, p_token_sha256,
    ARRAY['shareholder.setup.manage', 'shareholder.read']);
  v_entity := (v_context ->> 'legalEntityId')::uuid;
  v_permissions := COALESCE(v_context -> 'permissions', '[]'::jsonb);
  RETURN jsonb_build_object(
    'legalEntity', (SELECT jsonb_build_object('id', entity.id, 'name', entity.name, 'baseCurrency', entity.base_currency_code)
                      FROM abos.legal_entities entity WHERE entity.id = v_entity),
    'permissions', jsonb_build_object('canManage', v_permissions ? 'shareholder.setup.manage'),
    'today', current_date,
    'currencies', COALESCE((SELECT jsonb_agg(c.code ORDER BY c.code) FROM abos.currencies c WHERE c.enabled), '[]'::jsonb),
    'shareholders', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', profile.id, 'businessPartyId', party.id, 'name', party.display_name,
               'reference', party.external_reference, 'status', profile.status,
               'since', (SELECT min(role.effective_from) FROM abos.business_party_roles role
                          WHERE role.business_party_id = party.id AND role.role_code = 'SHAREHOLDER'),
               'contributions', COALESCE((
                 SELECT jsonb_agg(jsonb_build_object(
                          'id', c.id, 'type', c.contribution_type, 'businessDate', c.business_date,
                          'description', c.description, 'reference', c.reference,
                          'recordStatus', c.record_status, 'receiptStatus', c.receipt_status,
                          'valuationStatus', c.valuation_status, 'amount', c.amount::text, 'currency', c.currency_code,
                          'assetCategory', c.asset_category, 'itemName', c.item_name, 'quantity', c.quantity::text,
                          'unit', c.unit, 'ownershipNote', c.ownership_note, 'estimatedValue', c.estimated_value::text,
                          'valuationCurrency', c.valuation_currency_code, 'creditClassification', c.credit_classification,
                          'version', c.version, 'createdAt', c.created_at, 'createdBy', creator.display_name,
                          'cancellationReason', c.cancellation_reason,
                          'editable', c.record_status IN ('DRAFT', 'DECLARED'))
                        ORDER BY (c.record_status = 'CANCELLED'), c.business_date, c.created_at)
                   FROM abos.shareholder_contributions c
                   JOIN abos.user_accounts creator ON creator.id = c.created_by_user_account_id
                  WHERE c.shareholder_profile_id = profile.id AND c.legal_entity_id = v_entity), '[]'::jsonb),
               -- Declared amounts per type and currency. Estimates are reported separately and never
               -- added to CASH or CREDIT; cancelled rows and legacy agreements are excluded.
               'declaredTotals', COALESCE((
                 SELECT jsonb_agg(jsonb_build_object('type', t.contribution_type, 'currency', t.currency_code,
                                                     'amount', t.total::text) ORDER BY t.contribution_type, t.currency_code)
                   FROM (SELECT c.contribution_type, c.currency_code, sum(c.amount) AS total
                           FROM abos.shareholder_contributions c
                          WHERE c.shareholder_profile_id = profile.id AND c.legal_entity_id = v_entity
                            AND c.contribution_type IN ('CASH', 'CREDIT') AND c.record_status <> 'CANCELLED'
                          GROUP BY c.contribution_type, c.currency_code) t), '[]'::jsonb),
               'estimatedAssetTotals', COALESCE((
                 SELECT jsonb_agg(jsonb_build_object('currency', t.valuation_currency_code, 'amount', t.total::text)
                                  ORDER BY t.valuation_currency_code)
                   FROM (SELECT c.valuation_currency_code, sum(c.estimated_value) AS total
                           FROM abos.shareholder_contributions c
                          WHERE c.shareholder_profile_id = profile.id AND c.legal_entity_id = v_entity
                            AND c.contribution_type = 'IN_KIND' AND c.estimated_value IS NOT NULL
                            AND c.record_status <> 'CANCELLED'
                          GROUP BY c.valuation_currency_code) t), '[]'::jsonb),
               'legacyCashAgreements', COALESCE((
                 SELECT jsonb_agg(jsonb_build_object(
                          'id', agreement.id, 'reference', agreement.agreement_reference, 'kind', agreement.agreement_kind,
                          'committed', agreement.committed_amount::text, 'currency', agreement.currency_code,
                          'status', agreement.status, 'effectiveOn', agreement.effective_on,
                          'installmentCount', (SELECT count(*) FROM abos.capital_installments i
                                                WHERE i.capital_agreement_id = agreement.id AND i.status <> 'CANCELLED'),
                          'planned', (SELECT coalesce(sum(i.expected_amount), 0) FROM abos.capital_installments i
                                       WHERE i.capital_agreement_id = agreement.id AND i.status <> 'CANCELLED')::text)
                        ORDER BY agreement.effective_on, agreement.agreement_reference)
                   FROM abos.capital_agreements agreement
                  WHERE agreement.shareholder_profile_id = profile.id AND agreement.legal_entity_id = v_entity), '[]'::jsonb))
             ORDER BY party.display_name, profile.id)
        FROM abos.shareholder_profiles profile
        JOIN abos.business_parties party ON party.id = profile.business_party_id AND party.legal_entity_id = profile.legal_entity_id
       WHERE profile.legal_entity_id = v_entity), '[]'::jsonb));
END
$workspace$;

-- ---------------------------------------------------------------------------
-- Ownership and execution.
-- ---------------------------------------------------------------------------
ALTER FUNCTION abos.shareholder_contribution_fields(text, jsonb) OWNER TO abos_v1_shareholder_setup_owner;
ALTER FUNCTION abos.shareholder_contribution_lock(uuid, jsonb) OWNER TO abos_v1_shareholder_setup_owner;
ALTER FUNCTION abos.shareholder_contribution_create(text, text, text, jsonb) OWNER TO abos_v1_shareholder_setup_owner;
ALTER FUNCTION abos.shareholder_contribution_update(text, text, text, jsonb) OWNER TO abos_v1_shareholder_setup_owner;
ALTER FUNCTION abos.shareholder_contribution_declare(text, text, text, jsonb) OWNER TO abos_v1_shareholder_setup_owner;
ALTER FUNCTION abos.shareholder_contribution_cancel(text, text, text, jsonb) OWNER TO abos_v1_shareholder_setup_owner;
ALTER FUNCTION abos.shareholder_contributions_workspace(text, text, text) OWNER TO abos_v1_shareholder_setup_owner;

REVOKE ALL ON FUNCTION
  abos.shareholder_contribution_fields(text, jsonb),
  abos.shareholder_contribution_lock(uuid, jsonb),
  abos.shareholder_contribution_create(text, text, text, jsonb),
  abos.shareholder_contribution_update(text, text, text, jsonb),
  abos.shareholder_contribution_declare(text, text, text, jsonb),
  abos.shareholder_contribution_cancel(text, text, text, jsonb),
  abos.shareholder_contributions_workspace(text, text, text)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  abos.shareholder_contribution_fields(text, jsonb),
  abos.shareholder_contribution_lock(uuid, jsonb)
TO abos_v1_shareholder_setup_owner;
-- Runtime: EXECUTE on the reviewed entry points only, through the restricted Finance login.
GRANT EXECUTE ON FUNCTION
  abos.shareholder_contribution_create(text, text, text, jsonb),
  abos.shareholder_contribution_update(text, text, text, jsonb),
  abos.shareholder_contribution_declare(text, text, text, jsonb),
  abos.shareholder_contribution_cancel(text, text, text, jsonb),
  abos.shareholder_contributions_workspace(text, text, text)
TO abos_e1_runtime;
