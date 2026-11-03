-- 0056: an expense, temporary funding or settlement transition is never refused because two clock readings are equal.
--
-- Root cause. guard_operational_expense (0028, restated in 0048) and the temporary-funding and settlement guards (0037)
-- required NEW.updated_at > OLD.updated_at on every transition. Every writer stamps updated_at with clock_timestamp(),
-- the wall clock at microsecond resolution, which is neither strictly increasing nor monotonic. Recording an expense with
-- approval OFF writes the same row three times in one transaction (INSERT as DRAFT, UPDATE to VALIDATED, UPDATE to
-- POSTED), so two equal readings - or a wall-clock step backwards - refused a valid expense with "an expense transition
-- must advance its version and update time" and rolled the whole recording back.
--
-- The protection the timestamp appeared to add is already given by explicit invariants that do not depend on the clock:
-- the version must advance by exactly one, the status may move only along the allowed transitions, a posted record is
-- immutable, the accounting identity cannot change, and writers lock the row before changing it. Those checks stay
-- exactly as they were. updated_at becomes audit metadata only: the guard keeps it from moving backwards
-- (GREATEST(new, old)) and never refuses a transition because of it.
--
-- Only these three trigger functions change (same owners, privileges and triggers); no table, row, journal or balance is touched.
CREATE OR REPLACE FUNCTION abos.guard_operational_expense()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'operational expenses are permanent records' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' OR NEW.version <> 1 OR NEW.journal_id IS NOT NULL THEN
      RAISE EXCEPTION 'an operational expense starts as DRAFT version 1 without a journal'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'POSTED' THEN
    RAISE EXCEPTION 'a posted operational expense is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.id, NEW.legal_entity_id, NEW.operational_treasury_account_id,
      NEW.operational_expense_category_id, NEW.payee_business_party_id,
      NEW.project_id, NEW.department_id, NEW.cost_center_id, NEW.reference,
      NEW.description, NEW.note, NEW.business_date, NEW.original_amount,
      NEW.original_currency_code, NEW.base_currency_code, NEW.workflow_policy_version_id,
      NEW.approval_required, NEW.correlation_id, NEW.idempotency_key,
      NEW.request_fingerprint, NEW.created_by_user_account_id, NEW.created_at, NEW.payment_kind)
     IS DISTINCT FROM
     (OLD.id, OLD.legal_entity_id, OLD.operational_treasury_account_id,
      OLD.operational_expense_category_id, OLD.payee_business_party_id,
      OLD.project_id, OLD.department_id, OLD.cost_center_id, OLD.reference,
      OLD.description, OLD.note, OLD.business_date, OLD.original_amount,
      OLD.original_currency_code, OLD.base_currency_code, OLD.workflow_policy_version_id,
      OLD.approval_required, OLD.correlation_id, OLD.idempotency_key,
      OLD.request_fingerprint, OLD.created_by_user_account_id, OLD.created_at, OLD.payment_kind) THEN
    RAISE EXCEPTION 'the accounting identity of an operational expense cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.exchange_rate_snapshot_id IS NOT NULL
     AND NEW.exchange_rate_snapshot_id IS DISTINCT FROM OLD.exchange_rate_snapshot_id THEN
    RAISE EXCEPTION 'the expense exchange-rate snapshot is immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.base_amount IS NOT NULL AND NEW.base_amount IS DISTINCT FROM OLD.base_amount THEN
    RAISE EXCEPTION 'the expense base amount is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'an expense transition must advance its version by exactly one'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT ((OLD.status = 'DRAFT' AND NEW.status IN ('PENDING_APPROVAL', 'VALIDATED'))
       OR (OLD.status IN ('PENDING_APPROVAL', 'VALIDATED') AND NEW.status = 'POSTED')) THEN
    RAISE EXCEPTION 'invalid operational expense transition % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  -- 0056: updated_at is audit metadata, not a transition rule. It never moves backwards and never refuses a transition.
  NEW.updated_at := GREATEST(NEW.updated_at, OLD.updated_at);
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION abos.guard_temporary_funding()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $guard$
DECLARE v_identity abos.temporary_funding_provider_identity_versions%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'temporary funding records are permanent' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'PENDING_APPROVAL' OR NEW.version <> 1 OR NEW.journal_id IS NOT NULL THEN
      RAISE EXCEPTION 'temporary funding starts as PENDING_APPROVAL version 1 without a journal'
        USING ERRCODE = 'check_violation';
    END IF;
    -- The bound identity must be the provider's current valid profile and exactly its user.
    SELECT * INTO v_identity FROM abos.temporary_funding_provider_identity_versions
     WHERE id = NEW.provider_identity_version_id AND legal_entity_id = NEW.legal_entity_id;
    IF NOT FOUND OR v_identity.business_party_id <> NEW.provider_business_party_id
       OR v_identity.user_account_id IS DISTINCT FROM NEW.provider_user_account_id
       OR v_identity.version <> (SELECT max(other.version) FROM abos.temporary_funding_provider_identity_versions other
                                  WHERE other.legal_entity_id = NEW.legal_entity_id
                                    AND other.business_party_id = NEW.provider_business_party_id)
       OR (v_identity.identity_mode = 'ABOS_USER' AND (
             NOT abos.temporary_funding_provider_user_valid(NEW.legal_entity_id, NEW.provider_user_account_id)
             OR abos.temporary_funding_provider_user_ambiguous(NEW.legal_entity_id, NEW.provider_business_party_id,
                                                               NEW.provider_user_account_id))) THEN
      RAISE EXCEPTION 'temporary funding must bind the provider''s current valid identity profile'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.provider_kind IS DISTINCT FROM abos.temporary_funding_provider_kind(NEW.provider_business_party_id, NEW.business_date) THEN
      RAISE EXCEPTION 'the provider kind does not match the provider''s roles on the funding date'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.legal_entity_id, NEW.funding_mode, NEW.provider_kind, NEW.provider_business_party_id,
      NEW.provider_identity_version_id, NEW.provider_user_account_id, NEW.operational_expense_category_id, NEW.payee_business_party_id,
      NEW.project_id, NEW.department_id, NEW.cost_center_id, NEW.operational_treasury_account_id,
      NEW.reference, NEW.description, NEW.note, NEW.business_date, NEW.original_amount,
      NEW.original_currency_code, NEW.base_amount, NEW.base_currency_code, NEW.workflow_policy_version_id,
      NEW.mapping_version_id, NEW.correlation_id, NEW.idempotency_key, NEW.request_fingerprint,
      NEW.created_by_user_account_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.legal_entity_id, OLD.funding_mode, OLD.provider_kind, OLD.provider_business_party_id,
      OLD.provider_identity_version_id, OLD.provider_user_account_id, OLD.operational_expense_category_id, OLD.payee_business_party_id,
      OLD.project_id, OLD.department_id, OLD.cost_center_id, OLD.operational_treasury_account_id,
      OLD.reference, OLD.description, OLD.note, OLD.business_date, OLD.original_amount,
      OLD.original_currency_code, OLD.base_amount, OLD.base_currency_code, OLD.workflow_policy_version_id,
      OLD.mapping_version_id, OLD.correlation_id, OLD.idempotency_key, OLD.request_fingerprint,
      OLD.created_by_user_account_id, OLD.created_at) THEN
    RAISE EXCEPTION 'the accounting identity of a temporary funding cannot change' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'PENDING_APPROVAL' OR NEW.status NOT IN ('REJECTED', 'POSTED')
     OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'invalid temporary funding transition % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  -- 0056: updated_at is audit metadata, not a transition rule. It never moves backwards and never refuses a transition.
  NEW.updated_at := GREATEST(NEW.updated_at, OLD.updated_at);
  RETURN NEW;
END
$guard$;

CREATE OR REPLACE FUNCTION abos.guard_temporary_funding_settlement()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $guard$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'temporary funding settlements are permanent' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'PENDING_APPROVAL' OR NEW.version <> 1 OR NEW.journal_id IS NOT NULL THEN
      RAISE EXCEPTION 'a settlement starts as PENDING_APPROVAL version 1 without a journal'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.legal_entity_id, NEW.temporary_funding_id, NEW.operational_treasury_account_id,
      NEW.reference, NEW.note, NEW.business_date, NEW.original_amount, NEW.original_currency_code,
      NEW.base_amount, NEW.base_currency_code, NEW.funding_version, NEW.workflow_policy_version_id,
      NEW.correlation_id, NEW.idempotency_key, NEW.request_fingerprint, NEW.created_by_user_account_id,
      NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.legal_entity_id, OLD.temporary_funding_id, OLD.operational_treasury_account_id,
      OLD.reference, OLD.note, OLD.business_date, OLD.original_amount, OLD.original_currency_code,
      OLD.base_amount, OLD.base_currency_code, OLD.funding_version, OLD.workflow_policy_version_id,
      OLD.correlation_id, OLD.idempotency_key, OLD.request_fingerprint, OLD.created_by_user_account_id,
      OLD.created_at) THEN
    RAISE EXCEPTION 'the accounting identity of a settlement cannot change' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'PENDING_APPROVAL' OR NEW.status NOT IN ('REJECTED', 'POSTED')
     OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'invalid settlement transition % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  -- 0056: updated_at is audit metadata, not a transition rule. It never moves backwards and never refuses a transition.
  NEW.updated_at := GREATEST(NEW.updated_at, OLD.updated_at);
  RETURN NEW;
END
$guard$;
