-- V1 Shareholders -> Finance bridge: production-safe, same/base-currency CASH receipts only.
--
-- A declaration remains non-financial. Receipt, custody verification, Finance preparation,
-- independent approval and explicit posting are separate durable facts. No business row is seeded
-- or backfilled by this migration. Legacy E1 remains synthetic-only.

INSERT INTO abos.permission_catalogue
  (permission_code, catalogue_version, category, availability,
   independence_enforced, administrative, sort_order)
VALUES
  ('shareholder.capital-receipt.read',      9, 'SHAREHOLDER', 'ACTIVE', false, false, 530),
  ('shareholder.capital-receipt.record',    9, 'TREASURY',    'ACTIVE', false, false, 540),
  ('treasury.capital-receipt.verify',       9, 'TREASURY',    'ACTIVE', true,  false, 550),
  ('finance.capital-receipt.configure',     9, 'FINANCE',     'ACTIVE', false, false, 560),
  ('finance.capital-receipt.prepare',       9, 'FINANCE',     'ACTIVE', false, false, 570),
  ('finance.capital-receipt.approve',       9, 'FINANCE',     'ACTIVE', true,  false, 580),
  ('finance.capital-receipt.post',          9, 'FINANCE',     'ACTIVE', true,  false, 590);

-- Exact evidence taxonomies. A hash or file alone never establishes legal validity or approval.
ALTER TABLE abos.evidence_references
  DROP CONSTRAINT evidence_references_evidence_kind_check;
ALTER TABLE abos.evidence_references
  ADD CONSTRAINT evidence_references_evidence_kind_check CHECK (evidence_kind IN
    ('CAPITAL_AGREEMENT', 'FORMAL_REGISTRATION', 'PHYSICAL_CASH_COUNT', 'CASH_RECEIPT',
     'OPENING_RECONCILIATION', 'FINANCE_APPROVAL', 'REVERSAL_REASON',
     'BANK_CONFIRMATION', 'SARAF_CONFIRMATION', 'CONTROLLED_EVIDENCE',
     'CAPITAL_ACCOUNT_MAPPING'));

ALTER TABLE abos.operational_treasury_accounts
  ADD CONSTRAINT operational_treasury_accounts_id_entity_currency_uq
  UNIQUE (id, legal_entity_id, currency_code);

CREATE TABLE abos.shareholder_capital_receipts (
  id uuid PRIMARY KEY,
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  contribution_id uuid NOT NULL,
  operational_treasury_account_id uuid NOT NULL,
  original_amount numeric NOT NULL
    CHECK (original_amount > 0 AND original_amount < 'Infinity'::numeric),
  original_currency_code text NOT NULL REFERENCES abos.currencies(code),
  receipt_date date NOT NULL,
  payment_reference text CHECK (
    payment_reference IS NULL OR length(btrim(payment_reference)) BETWEEN 1 AND 120),
  evidence_reference_id uuid,
  contribution_version integer NOT NULL CHECK (contribution_version > 0),
  source_fingerprint text NOT NULL CHECK (source_fingerprint ~ '^[0-9a-f]{64}$'),
  record_state text NOT NULL CHECK (record_state IN ('RECORDED', 'CANCELLED')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  correlation_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 8 AND 200),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  recorded_by_user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  cancelled_by_user_account_id uuid REFERENCES abos.user_accounts(id),
  cancelled_at timestamptz,
  cancellation_reason text CHECK (
    cancellation_reason IS NULL OR length(btrim(cancellation_reason)) BETWEEN 3 AND 500),
  UNIQUE (id, legal_entity_id),
  UNIQUE (legal_entity_id, idempotency_key),
  FOREIGN KEY (contribution_id, legal_entity_id)
    REFERENCES abos.shareholder_contributions(id, legal_entity_id),
  FOREIGN KEY (operational_treasury_account_id, legal_entity_id, original_currency_code)
    REFERENCES abos.operational_treasury_accounts(id, legal_entity_id, currency_code),
  FOREIGN KEY (evidence_reference_id, legal_entity_id)
    REFERENCES abos.evidence_references(id, legal_entity_id),
  CHECK (record_state = 'RECORDED' AND cancelled_by_user_account_id IS NULL
         AND cancelled_at IS NULL AND cancellation_reason IS NULL)
);
CREATE INDEX shareholder_capital_receipts_contribution_idx
  ON abos.shareholder_capital_receipts
    (legal_entity_id, contribution_id, receipt_date, recorded_at);

CREATE TABLE abos.shareholder_capital_receipt_custody_verifications (
  id uuid PRIMARY KEY,
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  shareholder_capital_receipt_id uuid NOT NULL,
  decision text NOT NULL CHECK (decision IN ('VERIFIED', 'REJECTED')),
  verification_kind text NOT NULL CHECK (verification_kind IN
    ('PHYSICAL_CASH_COUNT', 'BANK_CONFIRMATION', 'SARAF_CONFIRMATION', 'CONTROLLED_EVIDENCE')),
  verified_amount numeric NOT NULL
    CHECK (verified_amount > 0 AND verified_amount < 'Infinity'::numeric),
  verified_currency_code text NOT NULL REFERENCES abos.currencies(code),
  operational_treasury_account_id uuid NOT NULL,
  evidence_reference_id uuid NOT NULL,
  decision_reason text CHECK (
    decision_reason IS NULL OR length(btrim(decision_reason)) BETWEEN 3 AND 500),
  correlation_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 8 AND 200),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  verified_by_user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  verified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, legal_entity_id),
  UNIQUE (legal_entity_id, shareholder_capital_receipt_id),
  UNIQUE (legal_entity_id, idempotency_key),
  FOREIGN KEY (shareholder_capital_receipt_id, legal_entity_id)
    REFERENCES abos.shareholder_capital_receipts(id, legal_entity_id),
  FOREIGN KEY (operational_treasury_account_id, legal_entity_id, verified_currency_code)
    REFERENCES abos.operational_treasury_accounts(id, legal_entity_id, currency_code),
  FOREIGN KEY (evidence_reference_id, legal_entity_id)
    REFERENCES abos.evidence_references(id, legal_entity_id),
  CHECK ((decision = 'REJECTED') = (decision_reason IS NOT NULL))
);

CREATE TABLE abos.shareholder_capital_account_mapping_versions (
  id uuid PRIMARY KEY,
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  version integer NOT NULL CHECK (version > 0),
  paid_in_capital_ledger_account_id uuid NOT NULL,
  evidence_reference_id uuid NOT NULL,
  change_reason text NOT NULL CHECK (length(btrim(change_reason)) BETWEEN 3 AND 500),
  configured_by_user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  configured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  correlation_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 8 AND 200),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  UNIQUE (id, legal_entity_id),
  UNIQUE (legal_entity_id, version),
  UNIQUE (legal_entity_id, idempotency_key),
  FOREIGN KEY (paid_in_capital_ledger_account_id, legal_entity_id)
    REFERENCES abos.ledger_accounts(id, legal_entity_id),
  FOREIGN KEY (evidence_reference_id, legal_entity_id)
    REFERENCES abos.evidence_references(id, legal_entity_id)
);

ALTER TABLE abos.posting_intents
  ADD COLUMN shareholder_capital_receipt_id uuid,
  ADD COLUMN finance_workflow_policy_version_id uuid,
  ADD COLUMN shareholder_capital_account_mapping_version_id uuid,
  ADD COLUMN operational_version integer CHECK (operational_version > 0),
  ADD CONSTRAINT posting_intents_shareholder_capital_receipt_fk
    FOREIGN KEY (shareholder_capital_receipt_id, legal_entity_id)
    REFERENCES abos.shareholder_capital_receipts(id, legal_entity_id),
  ADD CONSTRAINT posting_intents_finance_workflow_policy_fk
    FOREIGN KEY (finance_workflow_policy_version_id, legal_entity_id)
    REFERENCES abos.finance_workflow_policy_versions(id, legal_entity_id),
  ADD CONSTRAINT posting_intents_shareholder_capital_mapping_fk
    FOREIGN KEY (shareholder_capital_account_mapping_version_id, legal_entity_id)
    REFERENCES abos.shareholder_capital_account_mapping_versions(id, legal_entity_id);
CREATE UNIQUE INDEX posting_intents_one_operational_capital_receipt
  ON abos.posting_intents (legal_entity_id, shareholder_capital_receipt_id)
  WHERE shareholder_capital_receipt_id IS NOT NULL;

ALTER TABLE abos.posting_approvals
  ADD COLUMN shareholder_capital_receipt_id uuid,
  ADD CONSTRAINT posting_approvals_shareholder_capital_receipt_fk
    FOREIGN KEY (shareholder_capital_receipt_id, legal_entity_id)
    REFERENCES abos.shareholder_capital_receipts(id, legal_entity_id);
CREATE UNIQUE INDEX posting_approvals_one_operational_capital_decision
  ON abos.posting_approvals (legal_entity_id, shareholder_capital_receipt_id)
  WHERE shareholder_capital_receipt_id IS NOT NULL;

ALTER TABLE abos.subledger_entries
  ADD COLUMN shareholder_capital_receipt_id uuid,
  ADD CONSTRAINT subledger_entries_shareholder_capital_receipt_fk
    FOREIGN KEY (shareholder_capital_receipt_id, legal_entity_id)
    REFERENCES abos.shareholder_capital_receipts(id, legal_entity_id);
CREATE INDEX subledger_entries_operational_capital_receipt_idx
  ON abos.subledger_entries
    (legal_entity_id, shareholder_capital_receipt_id, subledger_type)
  WHERE shareholder_capital_receipt_id IS NOT NULL;

-- Preserve the exact LEGACY_E1 source shape and add one disjoint Operational V1 capital shape.
ALTER TABLE abos.posting_intents
  DROP CONSTRAINT posting_intents_capital_source_required,
  DROP CONSTRAINT posting_intents_capital_source_matches_source_id;
ALTER TABLE abos.posting_intents
  ADD CONSTRAINT posting_intents_capital_source_required CHECK (
    (processing_model = 'LEGACY_E1' AND intent_kind = 'SHAREHOLDER_CAPITAL_RECEIPT'
       AND capital_receipt_intent_id IS NOT NULL
       AND shareholder_capital_receipt_id IS NULL)
    OR
    (processing_model = 'OPERATIONAL_V1' AND intent_kind = 'SHAREHOLDER_CAPITAL_RECEIPT'
       AND capital_receipt_intent_id IS NULL
       AND shareholder_capital_receipt_id IS NOT NULL
       AND source_type = 'SHAREHOLDER_CAPITAL_CONTRIBUTION_RECEIPT'
       AND source_id = shareholder_capital_receipt_id
       AND treasury_cash_receipt_id IS NULL
       AND operational_expense_id IS NULL
       AND finance_workflow_policy_version_id IS NOT NULL
       AND shareholder_capital_account_mapping_version_id IS NOT NULL
       AND operational_version IS NOT NULL)
    OR
    (intent_kind <> 'SHAREHOLDER_CAPITAL_RECEIPT'
       AND capital_receipt_intent_id IS NULL
       AND shareholder_capital_receipt_id IS NULL
       AND shareholder_capital_account_mapping_version_id IS NULL)
  ),
  ADD CONSTRAINT posting_intents_capital_source_matches_source_id CHECK (
    intent_kind <> 'SHAREHOLDER_CAPITAL_RECEIPT'
    OR (processing_model = 'LEGACY_E1'
        AND source_id = capital_receipt_intent_id)
    OR (processing_model = 'OPERATIONAL_V1'
        AND source_id = shareholder_capital_receipt_id)
  );

-- New facts and configuration versions are append-only.
CREATE TRIGGER shareholder_capital_receipts_no_update_or_delete
BEFORE UPDATE OR DELETE ON abos.shareholder_capital_receipts
FOR EACH ROW EXECUTE FUNCTION abos.prevent_audit_mutation();
CREATE TRIGGER shareholder_capital_custody_no_update_or_delete
BEFORE UPDATE OR DELETE ON abos.shareholder_capital_receipt_custody_verifications
FOR EACH ROW EXECUTE FUNCTION abos.prevent_audit_mutation();
CREATE TRIGGER shareholder_capital_mapping_no_update_or_delete
BEFORE UPDATE OR DELETE ON abos.shareholder_capital_account_mapping_versions
FOR EACH ROW EXECUTE FUNCTION abos.prevent_audit_mutation();
CREATE TRIGGER shareholder_capital_mapping_ledger_reference
AFTER INSERT ON abos.shareholder_capital_account_mapping_versions
FOR EACH ROW EXECUTE FUNCTION abos.ledger_account_mark_referenced('paid_in_capital_ledger_account_id');

CREATE FUNCTION abos.guard_bound_shareholder_contribution()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $guard$
BEGIN
  IF (TG_OP = 'DELETE' OR NEW IS DISTINCT FROM OLD) AND EXISTS (
    SELECT 1 FROM abos.shareholder_capital_receipts receipt
     WHERE receipt.legal_entity_id = OLD.legal_entity_id
       AND receipt.contribution_id = OLD.id
  ) THEN
    RAISE EXCEPTION 'a contribution with a financial receipt binding is immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$guard$;
CREATE TRIGGER aa_shareholder_contributions_finance_binding_guard
BEFORE UPDATE OR DELETE ON abos.shareholder_contributions
FOR EACH ROW EXECUTE FUNCTION abos.guard_bound_shareholder_contribution();

-- Legacy-only triggers must not consume the new typed operational capital source.
CREATE OR REPLACE FUNCTION abos.require_treasury_handoff_for_posting()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $guard$
BEGIN
  IF NEW.intent_kind <> 'SHAREHOLDER_CAPITAL_RECEIPT'
     OR NEW.processing_model <> 'LEGACY_E1' THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM abos.treasury_finance_handoffs h
                  WHERE h.cash_receipt_id = NEW.treasury_cash_receipt_id
                    AND h.capital_receipt_intent_id = NEW.capital_receipt_intent_id
                    AND h.legal_entity_id = NEW.legal_entity_id) THEN
    RAISE EXCEPTION 'a capital posting intent requires a Treasury handoff of this verified receipt';
  END IF;
  RETURN NEW;
END
$guard$;

-- Posting approvals dispatch by persisted processing model; runtime input cannot select the lane.
CREATE FUNCTION abos.guard_posting_approval_processing_model()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $guard$
DECLARE v_model text; v_receipt uuid;
BEGIN
  SELECT processing_model, shareholder_capital_receipt_id
    INTO v_model, v_receipt
    FROM abos.posting_intents
   WHERE id = NEW.posting_intent_id AND legal_entity_id = NEW.legal_entity_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'posting intent not found in approval legal entity'; END IF;
  IF v_model = 'LEGACY_E1' THEN
    PERFORM abos.assert_sandbox_mutation_authorized(NEW.legal_entity_id);
  ELSIF v_model = 'OPERATIONAL_V1' THEN
    IF current_user <> 'abos_v1_operational_finance_owner'
       OR v_receipt IS NULL
       OR NEW.shareholder_capital_receipt_id IS DISTINCT FROM v_receipt THEN
      RAISE EXCEPTION 'operational capital approval is restricted to its typed Finance entry point'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSE
    RAISE EXCEPTION 'unsupported posting approval processing model';
  END IF;
  RETURN NEW;
END
$guard$;
DROP TRIGGER posting_approvals_sandbox_guard ON abos.posting_approvals;
CREATE TRIGGER posting_approvals_sandbox_guard
BEFORE INSERT OR UPDATE ON abos.posting_approvals
FOR EACH ROW EXECUTE FUNCTION abos.guard_posting_approval_processing_model();

CREATE OR REPLACE FUNCTION abos.enforce_posting_approval_sod()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $sod$
DECLARE
  intent_row abos.posting_intents%ROWTYPE;
  creator_id uuid; cashier_id uuid; counter_id uuid; verifier_id uuid; handoff_actor_id uuid;
  recorder_id uuid; custody_verifier_id uuid; approval_evidence_kind text;
BEGIN
  SELECT * INTO intent_row FROM abos.posting_intents
   WHERE id = NEW.posting_intent_id AND legal_entity_id = NEW.legal_entity_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'posting intent not found in approval legal entity'; END IF;
  IF intent_row.processing_model = 'LEGACY_E1' THEN
    SELECT pi.created_by_user_account_id, cr.received_by_user_account_id,
           pc.counted_by_user_account_id, cr.verified_by_user_account_id,
           handoff.handed_off_by_user_account_id
      INTO creator_id, cashier_id, counter_id, verifier_id, handoff_actor_id
      FROM abos.posting_intents pi
      LEFT JOIN abos.cash_receipts cr ON cr.id = pi.treasury_cash_receipt_id
       AND cr.legal_entity_id = pi.legal_entity_id
      LEFT JOIN abos.physical_cash_counts pc ON pc.id = cr.physical_cash_count_id
       AND pc.legal_entity_id = cr.legal_entity_id
      LEFT JOIN abos.treasury_finance_handoffs handoff ON handoff.cash_receipt_id = cr.id
       AND handoff.legal_entity_id = cr.legal_entity_id
     WHERE pi.id = NEW.posting_intent_id AND pi.legal_entity_id = NEW.legal_entity_id;
    IF NEW.approver_user_account_id IN
       (creator_id, cashier_id, counter_id, verifier_id, handoff_actor_id) THEN
      RAISE EXCEPTION 'Finance approver must be independent of intent preparation and Treasury custody';
    END IF;
  ELSE
    SELECT receipt.recorded_by_user_account_id, custody.verified_by_user_account_id
      INTO recorder_id, custody_verifier_id
      FROM abos.shareholder_capital_receipts receipt
      JOIN abos.shareholder_capital_receipt_custody_verifications custody
        ON custody.shareholder_capital_receipt_id = receipt.id
       AND custody.legal_entity_id = receipt.legal_entity_id
     WHERE receipt.id = intent_row.shareholder_capital_receipt_id
       AND receipt.legal_entity_id = intent_row.legal_entity_id;
    IF NEW.shareholder_capital_receipt_id IS DISTINCT FROM intent_row.shareholder_capital_receipt_id
       OR NEW.approver_user_account_id IN
          (intent_row.created_by_user_account_id, recorder_id, custody_verifier_id) THEN
      RAISE EXCEPTION 'Finance approver must be independent of receipt recording, custody and preparation'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  SELECT evidence_kind INTO approval_evidence_kind FROM abos.evidence_references
   WHERE id = NEW.evidence_reference_id AND legal_entity_id = NEW.legal_entity_id;
  IF approval_evidence_kind IS DISTINCT FROM 'FINANCE_APPROVAL' THEN
    RAISE EXCEPTION 'posting approval requires structured FINANCE_APPROVAL evidence';
  END IF;
  RETURN NEW;
END
$sod$;

CREATE FUNCTION abos.guard_operational_capital_approval_immutability()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $guard$
BEGIN
  IF TG_OP <> 'INSERT' AND OLD.shareholder_capital_receipt_id IS NOT NULL THEN
    RAISE EXCEPTION 'operational capital approval decisions are immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$guard$;
CREATE TRIGGER posting_approvals_operational_capital_immutable
BEFORE UPDATE OR DELETE ON abos.posting_approvals
FOR EACH ROW EXECUTE FUNCTION abos.guard_operational_capital_approval_immutability();

-- Keep the old source-completion side effect in the synthetic legacy model only.
CREATE OR REPLACE FUNCTION abos.complete_posted_capital_source()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $complete$
DECLARE
  posting abos.posting_intents%ROWTYPE;
  source_record abos.capital_receipt_intents%ROWTYPE;
  receipt abos.cash_receipts%ROWTYPE;
  installment_agreement_id uuid;
  agreement_party_id uuid;
BEGIN
  SELECT * INTO posting FROM abos.posting_intents WHERE id = NEW.posting_intent_id;
  IF posting.intent_kind <> 'SHAREHOLDER_CAPITAL_RECEIPT'
     OR posting.processing_model <> 'LEGACY_E1' THEN
    RETURN NEW;
  END IF;
  SELECT * INTO source_record
    FROM abos.capital_receipt_intents
   WHERE id = posting.capital_receipt_intent_id
     AND legal_entity_id = NEW.legal_entity_id
   FOR UPDATE;
  SELECT * INTO receipt
    FROM abos.cash_receipts
   WHERE id = posting.treasury_cash_receipt_id
     AND legal_entity_id = NEW.legal_entity_id
   FOR SHARE;
  SELECT ci.capital_agreement_id, sp.business_party_id
    INTO installment_agreement_id, agreement_party_id
    FROM abos.capital_installments ci
    JOIN abos.capital_agreements ca
      ON ca.id = ci.capital_agreement_id AND ca.legal_entity_id = ci.legal_entity_id
    JOIN abos.shareholder_profiles sp
      ON sp.id = ca.shareholder_profile_id AND sp.legal_entity_id = ca.legal_entity_id
   WHERE ci.id = source_record.capital_installment_id
     AND ci.legal_entity_id = NEW.legal_entity_id;
  IF source_record.id IS NULL OR receipt.id IS NULL
     OR source_record.status <> 'TREASURY_VERIFIED'
     OR receipt.status <> 'VERIFIED'
     OR posting.source_id <> source_record.id
     OR source_record.treasury_cash_receipt_id <> receipt.id
     OR receipt.capital_installment_id IS DISTINCT FROM source_record.capital_installment_id
     OR installment_agreement_id IS DISTINCT FROM source_record.capital_agreement_id
     OR agreement_party_id IS DISTINCT FROM source_record.shareholder_business_party_id
     OR receipt.cash_location_currency_account_id <> source_record.destination_cash_account_id
     OR receipt.amount <> source_record.amount
     OR receipt.currency_code <> source_record.currency_code THEN
    RAISE EXCEPTION 'posted capital journal source, shareholder, installment and Treasury receipt must agree';
  END IF;
  UPDATE abos.capital_receipt_intents
     SET status = 'POSTED', contribution_state = 'POSTED', journal_id = NEW.id,
         version = version + 1, updated_at = pg_catalog.clock_timestamp()
   WHERE id = source_record.id AND status = 'TREASURY_VERIFIED'
   RETURNING * INTO source_record;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'capital source state changed before journal posting completed';
  END IF;
  INSERT INTO abos.capital_receipt_intent_history
    (id, capital_receipt_intent_id, legal_entity_id, version, status,
     contribution_state, classification, amount, currency_code,
     treasury_cash_receipt_id, journal_id)
  VALUES
    (pg_catalog.gen_random_uuid(), source_record.id, source_record.legal_entity_id,
     source_record.version, 'POSTED', 'POSTED', source_record.classification,
     source_record.amount, source_record.currency_code, receipt.id, NEW.id);
  RETURN NEW;
END
$complete$;

-- Hardened owner for receipt/custody facts only. It owns no table and has no GL DML.
DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles
                  WHERE rolname = 'abos_v1_shareholder_capital_owner') THEN
    CREATE ROLE abos_v1_shareholder_capital_owner
      NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END
$role$;
REVOKE ALL ON SCHEMA abos FROM abos_v1_shareholder_capital_owner;
GRANT USAGE ON SCHEMA abos TO abos_v1_shareholder_capital_owner;
REVOKE ALL ON ALL TABLES IN SCHEMA abos FROM abos_v1_shareholder_capital_owner;
REVOKE abos_v1_shareholder_capital_owner FROM abos_e1_runtime, abos_e1_treasury_runtime;

-- The closed operational permission dispatcher gains only the seven reviewed capital operations.
CREATE OR REPLACE FUNCTION abos.operational_finance_actor(
  p_identity_proof text,
  p_runtime_token_sha256 text,
  p_token_sha256 text,
  p_required_permission text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $actor$
DECLARE actor_context jsonb;
BEGIN
  IF p_required_permission IS NOT NULL AND p_required_permission NOT IN (
    'treasury.operational-account.manage', 'finance.expense-category.manage',
    'finance.expense.create', 'finance.expense.read', 'finance.expense.approve',
    'finance.period.manage', 'shareholder.capital-receipt.read',
    'shareholder.capital-receipt.record', 'treasury.capital-receipt.verify',
    'finance.capital-receipt.configure', 'finance.capital-receipt.prepare',
    'finance.capital-receipt.approve', 'finance.capital-receipt.post'
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
$actor$;

CREATE FUNCTION abos.shareholder_capital_actor(
  p_identity_proof text, p_runtime_token_sha256 text, p_token_sha256 text,
  p_required_permission text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $actor$
DECLARE v_context jsonb;
BEGIN
  IF p_required_permission NOT IN (
    'shareholder.capital-receipt.read', 'shareholder.capital-receipt.record',
    'treasury.capital-receipt.verify'
  ) THEN
    RAISE EXCEPTION 'unsupported shareholder capital permission'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  v_context := abos.identity_actor_context(
    p_identity_proof, p_runtime_token_sha256, p_token_sha256);
  IF v_context IS NULL
     OR COALESCE((v_context ->> 'live')::boolean, false) IS NOT TRUE
     OR v_context ->> 'status' IS DISTINCT FROM 'ACTIVE'
     OR COALESCE((v_context ->> 'mustChangePassword')::boolean, false) IS TRUE
     OR NOT COALESCE(v_context -> 'permissions', '[]'::jsonb) ? p_required_permission THEN
    RAISE EXCEPTION 'an active password session with % is required', p_required_permission
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN v_context;
END
$actor$;

CREATE FUNCTION abos.shareholder_contribution_finance_lock(
  p_legal_entity_id uuid, p_contribution_id uuid, p_expected_version integer
) RETURNS abos.shareholder_contributions
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $lock$
DECLARE v_row abos.shareholder_contributions%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM abos.shareholder_contributions
   WHERE id = p_contribution_id AND legal_entity_id = p_legal_entity_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'capital contribution is not available in this legal entity'
    USING ERRCODE = 'no_data_found'; END IF;
  IF v_row.version <> p_expected_version THEN
    RAISE EXCEPTION 'capital contribution changed; reload and try again'
      USING ERRCODE = 'serialization_failure';
  END IF;
  IF v_row.contribution_type <> 'CASH' OR v_row.record_status <> 'DECLARED'
     OR v_row.amount IS NULL OR v_row.currency_code IS NULL THEN
    RAISE EXCEPTION 'only a declared CASH contribution can receive funds'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN v_row;
END
$lock$;
ALTER FUNCTION abos.shareholder_contribution_finance_lock(uuid, uuid, integer)
  OWNER TO abos_v1_shareholder_setup_owner;

-- Durable idempotency. Authentication is performed before these helpers are called.
CREATE FUNCTION abos.shareholder_capital_idempotency_begin(
  p_scope text, p_key text, p_fingerprint text, p_correlation_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $idem$
DECLARE v_row abos.idempotency_records%ROWTYPE;
BEGIN
  INSERT INTO abos.idempotency_records
    (scope, idempotency_key, request_fingerprint, correlation_id, status)
  VALUES (p_scope, p_key, p_fingerprint, p_correlation_id, 'IN_PROGRESS')
  ON CONFLICT (scope, idempotency_key) DO NOTHING;
  SELECT * INTO v_row FROM abos.idempotency_records
   WHERE scope = p_scope AND idempotency_key = p_key FOR UPDATE;
  IF v_row.request_fingerprint IS DISTINCT FROM p_fingerprint THEN
    RAISE EXCEPTION 'idempotency key was already used with different capital receipt details'
      USING ERRCODE = 'unique_violation';
  END IF;
  IF v_row.status = 'COMPLETED' THEN
    RETURN pg_catalog.jsonb_build_object('replayed', true, 'snapshot', v_row.response_snapshot);
  END IF;
  RETURN pg_catalog.jsonb_build_object('replayed', false);
END
$idem$;

CREATE FUNCTION abos.shareholder_capital_idempotency_complete(
  p_scope text, p_key text, p_resource_type text, p_resource_id uuid, p_snapshot jsonb
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $idem$
BEGIN
  UPDATE abos.idempotency_records
     SET status = 'COMPLETED', resource_type = p_resource_type, resource_id = p_resource_id,
         response_code = 200, response_snapshot = p_snapshot,
         completed_at = pg_catalog.clock_timestamp()
   WHERE scope = p_scope AND idempotency_key = p_key AND status = 'IN_PROGRESS';
  IF NOT FOUND THEN RAISE EXCEPTION 'capital idempotency record is not in progress'; END IF;
END
$idem$;

CREATE FUNCTION abos.shareholder_capital_audit(
  p_actor uuid, p_entity uuid, p_correlation uuid, p_action text,
  p_entity_type text, p_entity_id uuid, p_after jsonb
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $audit$
BEGIN
  INSERT INTO abos.audit_records
    (id, actor_user_account_id, legal_entity_id, correlation_id, action,
     entity_type, entity_id, after_state, metadata)
  VALUES (pg_catalog.gen_random_uuid(), p_actor, p_entity, p_correlation, p_action,
          p_entity_type, p_entity_id, p_after,
          pg_catalog.jsonb_build_object('source', 'v1-shareholder-finance-bridge'));
  INSERT INTO abos.outbox_events
    (id, aggregate_type, aggregate_id, event_type, event_version,
     legal_entity_id, actor_user_account_id, correlation_id, payload, occurred_at)
  VALUES (pg_catalog.gen_random_uuid(), p_entity_type, p_entity_id, lower(p_action), 1,
          p_entity, p_actor, p_correlation, p_after, pg_catalog.clock_timestamp());
END
$audit$;

CREATE FUNCTION abos.shareholder_capital_receipt_json(p_receipt_id uuid)
RETURNS jsonb LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $json$
  SELECT pg_catalog.jsonb_build_object(
    'receiptId', receipt.id, 'contributionId', receipt.contribution_id,
    'amount', pg_catalog.jsonb_build_object(
      'amount', receipt.original_amount::text, 'currency', receipt.original_currency_code),
    'receiptDate', receipt.receipt_date, 'treasuryDestinationId', receipt.operational_treasury_account_id,
    'treasuryDestinationName', treasury.name_en,
    'custodyState', COALESCE(custody.decision, 'PENDING_VERIFICATION'),
    'approvalState', CASE
      WHEN approval.decision IS NULL THEN 'PENDING' ELSE approval.decision END,
    'postingState', CASE WHEN journal.id IS NULL THEN 'NOT_POSTED' ELSE 'POSTED' END,
    'postingIntentId', intent.id, 'receiptVersion', receipt.version,
    'postingIntentVersion', intent.operational_version, 'journalId', journal.id)
  FROM abos.shareholder_capital_receipts receipt
  JOIN abos.operational_treasury_accounts treasury
    ON treasury.id = receipt.operational_treasury_account_id
   AND treasury.legal_entity_id = receipt.legal_entity_id
  LEFT JOIN abos.shareholder_capital_receipt_custody_verifications custody
    ON custody.shareholder_capital_receipt_id = receipt.id
   AND custody.legal_entity_id = receipt.legal_entity_id
  LEFT JOIN abos.posting_intents intent
    ON intent.shareholder_capital_receipt_id = receipt.id
   AND intent.legal_entity_id = receipt.legal_entity_id
  LEFT JOIN abos.posting_approvals approval
    ON approval.shareholder_capital_receipt_id = receipt.id
   AND approval.legal_entity_id = receipt.legal_entity_id
  LEFT JOIN abos.journals journal ON journal.posting_intent_id = intent.id
  WHERE receipt.id = p_receipt_id
$json$;

CREATE FUNCTION abos.record_shareholder_capital_receipt(
  p_identity_proof text, p_runtime_token_sha256 text, p_token_sha256 text, p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $record$
DECLARE
  v_context jsonb; v_actor uuid; v_entity uuid; v_contribution_id uuid; v_destination_id uuid;
  v_expected integer; v_amount numeric; v_currency text; v_date date; v_reference text;
  v_evidence uuid; v_key text; v_correlation uuid; v_fingerprint text; v_source_fingerprint text;
  v_scope text; v_idem jsonb; v_receipt_id uuid; v_allocated numeric;
  v_source abos.shareholder_contributions%ROWTYPE;
  v_treasury abos.operational_treasury_accounts%ROWTYPE;
  v_entity_base text; v_policy text; v_evidence_kind text; v_result jsonb;
BEGIN
  v_context := abos.shareholder_capital_actor(p_identity_proof, p_runtime_token_sha256,
    p_token_sha256, 'shareholder.capital-receipt.record');
  v_actor := (v_context ->> 'userAccountId')::uuid;
  v_entity := (v_context ->> 'legalEntityId')::uuid;
  IF EXISTS (SELECT 1 FROM pg_catalog.jsonb_object_keys(p_payload) key
              WHERE key NOT IN ('contributionId','expectedContributionVersion','amount','receiptDate',
                'treasuryDestinationId','paymentReference','evidenceReferenceId','idempotencyKey','correlationId')) THEN
    RAISE EXCEPTION 'capital receipt request contains unsupported fields' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  BEGIN
    v_contribution_id := (p_payload ->> 'contributionId')::uuid;
    v_destination_id := (p_payload ->> 'treasuryDestinationId')::uuid;
    v_expected := (p_payload ->> 'expectedContributionVersion')::integer;
    v_date := (p_payload ->> 'receiptDate')::date;
    v_evidence := NULLIF(p_payload ->> 'evidenceReferenceId','')::uuid;
    v_key := btrim(p_payload ->> 'idempotencyKey');
    v_correlation := (p_payload ->> 'correlationId')::uuid;
    v_amount := (p_payload #>> '{amount,amount}')::numeric;
    v_currency := upper(p_payload #>> '{amount,currency}');
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'a complete valid capital receipt request is required'
      USING ERRCODE = 'invalid_parameter_value';
  END;
  IF (p_payload #>> '{amount,amount}') !~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$'
     OR v_amount <= 0 OR v_amount >= 'Infinity'::numeric
     OR length(v_key) NOT BETWEEN 8 AND 200 THEN
    RAISE EXCEPTION 'a positive plain-decimal amount and idempotency key are required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_reference := NULLIF(btrim(p_payload ->> 'paymentReference'), '');
  v_source := abos.shareholder_contribution_finance_lock(v_entity, v_contribution_id, v_expected);
  SELECT base_currency_code, currency_policy_status INTO v_entity_base, v_policy
    FROM abos.legal_entities WHERE id = v_entity;
  SELECT * INTO v_treasury FROM abos.operational_treasury_accounts
   WHERE id = v_destination_id AND legal_entity_id = v_entity;
  IF v_policy <> 'APPROVED' OR v_entity_base IS NULL
     OR v_source.currency_code IS DISTINCT FROM v_currency
     OR v_currency IS DISTINCT FROM v_entity_base
     OR v_treasury.id IS NULL OR v_treasury.status <> 'ACTIVE'
     OR v_treasury.currency_code IS DISTINCT FROM v_currency THEN
    RAISE EXCEPTION 'capital receipt requires approved base currency and an active same-currency Treasury destination'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_date IS DISTINCT FROM v_source.business_date THEN
    RAISE EXCEPTION 'first-slice capital receipt date must equal the declared contribution date'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_evidence IS NOT NULL THEN
    SELECT evidence_kind INTO v_evidence_kind FROM abos.evidence_references
     WHERE id = v_evidence AND legal_entity_id = v_entity;
    IF v_evidence_kind IS DISTINCT FROM 'CASH_RECEIPT' THEN
      RAISE EXCEPTION 'optional receipt evidence must be structured CASH_RECEIPT evidence'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  v_fingerprint := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    (p_payload - 'correlationId')::text || ':' || v_actor::text, 'UTF8')), 'hex');
  v_source_fingerprint := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    pg_catalog.concat_ws(':',v_source.id::text,v_source.version::text,
      v_source.shareholder_profile_id::text,v_source.contribution_type,v_source.business_date::text,
      v_source.amount::text,v_source.currency_code), 'UTF8')), 'hex');
  v_scope := 'shareholder-capital:record:' || v_entity::text || ':' || v_actor::text;
  v_idem := abos.shareholder_capital_idempotency_begin(v_scope,v_key,v_fingerprint,v_correlation);
  IF (v_idem ->> 'replayed')::boolean THEN
    RETURN v_idem -> 'snapshot';
  END IF;
  SELECT COALESCE(sum(original_amount),0) INTO v_allocated
    FROM abos.shareholder_capital_receipts
   WHERE legal_entity_id = v_entity AND contribution_id = v_source.id AND record_state = 'RECORDED';
  IF v_allocated + v_amount > v_source.amount THEN
    RAISE EXCEPTION 'recorded receipts would exceed the declared contribution amount'
      USING ERRCODE = 'check_violation';
  END IF;
  v_receipt_id := pg_catalog.gen_random_uuid();
  INSERT INTO abos.shareholder_capital_receipts
    (id,legal_entity_id,contribution_id,operational_treasury_account_id,original_amount,
     original_currency_code,receipt_date,payment_reference,evidence_reference_id,
     contribution_version,source_fingerprint,record_state,version,correlation_id,
     idempotency_key,request_fingerprint,recorded_by_user_account_id)
  VALUES (v_receipt_id,v_entity,v_source.id,v_treasury.id,v_amount,v_currency,v_date,
          v_reference,v_evidence,v_source.version,v_source_fingerprint,'RECORDED',1,
          v_correlation,v_key,v_fingerprint,v_actor);
  v_result := pg_catalog.jsonb_build_object(
    'receipt',abos.shareholder_capital_receipt_json(v_receipt_id),'replayed',false);
  PERFORM abos.shareholder_capital_audit(v_actor,v_entity,v_correlation,
    'SHAREHOLDER_CAPITAL_RECEIPT_RECORDED','SHAREHOLDER_CAPITAL_RECEIPT',v_receipt_id,v_result);
  PERFORM abos.shareholder_capital_idempotency_complete(v_scope,v_key,
    'SHAREHOLDER_CAPITAL_RECEIPT',v_receipt_id,v_result);
  RETURN v_result;
END
$record$;

CREATE FUNCTION abos.verify_shareholder_capital_receipt_custody(
  p_identity_proof text, p_runtime_token_sha256 text, p_token_sha256 text,
  p_receipt_id uuid, p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $verify$
DECLARE
  v_context jsonb; v_actor uuid; v_entity uuid; v_receipt abos.shareholder_capital_receipts%ROWTYPE;
  v_expected integer; v_decision text; v_kind text; v_evidence uuid; v_reason text;
  v_key text; v_correlation uuid; v_fingerprint text; v_scope text; v_idem jsonb;
  v_evidence_kind text; v_verification_id uuid; v_result jsonb;
BEGIN
  v_context := abos.shareholder_capital_actor(p_identity_proof,p_runtime_token_sha256,
    p_token_sha256,'treasury.capital-receipt.verify');
  v_actor := (v_context ->> 'userAccountId')::uuid;
  v_entity := (v_context ->> 'legalEntityId')::uuid;
  IF EXISTS (SELECT 1 FROM pg_catalog.jsonb_object_keys(p_payload) key
              WHERE key NOT IN ('expectedReceiptVersion','decision','verificationKind',
                'evidenceReferenceId','decisionReason','idempotencyKey','correlationId')) THEN
    RAISE EXCEPTION 'custody request contains unsupported fields' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  BEGIN
    v_expected := (p_payload ->> 'expectedReceiptVersion')::integer;
    v_decision := p_payload ->> 'decision'; v_kind := p_payload ->> 'verificationKind';
    v_evidence := (p_payload ->> 'evidenceReferenceId')::uuid;
    v_reason := NULLIF(btrim(p_payload ->> 'decisionReason'),'');
    v_key := btrim(p_payload ->> 'idempotencyKey');
    v_correlation := (p_payload ->> 'correlationId')::uuid;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'a complete custody decision is required' USING ERRCODE = 'invalid_parameter_value';
  END;
  SELECT * INTO v_receipt FROM abos.shareholder_capital_receipts
   WHERE id = p_receipt_id AND legal_entity_id = v_entity;
  IF NOT FOUND THEN RAISE EXCEPTION 'capital receipt is not available in this legal entity'
    USING ERRCODE = 'no_data_found'; END IF;
  IF v_receipt.version <> v_expected THEN RAISE EXCEPTION 'capital receipt changed; reload and try again'
    USING ERRCODE = 'serialization_failure'; END IF;
  IF v_receipt.recorded_by_user_account_id = v_actor THEN
    RAISE EXCEPTION 'receipt recorder cannot verify custody of the same receipt'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_decision NOT IN ('VERIFIED','REJECTED') OR v_kind NOT IN
    ('PHYSICAL_CASH_COUNT','BANK_CONFIRMATION','SARAF_CONFIRMATION','CONTROLLED_EVIDENCE')
     OR (v_decision = 'REJECTED') <> (v_reason IS NOT NULL) THEN
    RAISE EXCEPTION 'a valid terminal custody decision is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT evidence_kind INTO v_evidence_kind FROM abos.evidence_references
   WHERE id = v_evidence AND legal_entity_id = v_entity;
  IF v_evidence_kind IS DISTINCT FROM v_kind THEN
    RAISE EXCEPTION 'custody verification kind must match its structured evidence'
      USING ERRCODE = 'check_violation';
  END IF;
  v_fingerprint := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    (p_payload - 'correlationId')::text || ':' || p_receipt_id::text || ':' || v_actor::text, 'UTF8')),'hex');
  v_scope := 'shareholder-capital:verify:'||v_entity::text||':'||v_actor::text;
  v_idem := abos.shareholder_capital_idempotency_begin(v_scope,v_key,v_fingerprint,v_correlation);
  IF (v_idem ->> 'replayed')::boolean THEN RETURN v_idem -> 'snapshot'; END IF;
  v_verification_id := pg_catalog.gen_random_uuid();
  INSERT INTO abos.shareholder_capital_receipt_custody_verifications
    (id,legal_entity_id,shareholder_capital_receipt_id,decision,verification_kind,
     verified_amount,verified_currency_code,operational_treasury_account_id,
     evidence_reference_id,decision_reason,correlation_id,idempotency_key,
     request_fingerprint,verified_by_user_account_id)
  VALUES (v_verification_id,v_entity,v_receipt.id,v_decision,v_kind,v_receipt.original_amount,
    v_receipt.original_currency_code,v_receipt.operational_treasury_account_id,v_evidence,
    v_reason,v_correlation,v_key,v_fingerprint,v_actor);
  v_result := pg_catalog.jsonb_build_object(
    'receipt',abos.shareholder_capital_receipt_json(v_receipt.id),'replayed',false);
  PERFORM abos.shareholder_capital_audit(v_actor,v_entity,v_correlation,
    CASE v_decision WHEN 'VERIFIED' THEN 'SHAREHOLDER_CAPITAL_CUSTODY_VERIFIED'
      ELSE 'SHAREHOLDER_CAPITAL_CUSTODY_REJECTED' END,
    'SHAREHOLDER_CAPITAL_RECEIPT',v_receipt.id,v_result);
  PERFORM abos.shareholder_capital_idempotency_complete(v_scope,v_key,
    'SHAREHOLDER_CAPITAL_CUSTODY_VERIFICATION',v_verification_id,v_result);
  RETURN v_result;
END
$verify$;

CREATE FUNCTION abos.configure_shareholder_capital_mapping(
  p_identity_proof text,p_runtime_token_sha256 text,p_token_sha256 text,p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $configure$
DECLARE
  v_context jsonb; v_actor uuid; v_entity uuid; v_ledger uuid; v_evidence uuid;
  v_reason text; v_key text; v_correlation uuid; v_fingerprint text; v_scope text; v_idem jsonb;
  v_version integer; v_mapping uuid; v_ledger_row record;
  v_kind text; v_result jsonb;
BEGIN
  v_context := abos.operational_finance_actor(p_identity_proof,p_runtime_token_sha256,
    p_token_sha256,'finance.capital-receipt.configure');
  v_actor := (v_context ->> 'userAccountId')::uuid; v_entity := (v_context ->> 'legalEntityId')::uuid;
  IF EXISTS (SELECT 1 FROM pg_catalog.jsonb_object_keys(p_payload) key
              WHERE key NOT IN ('ledgerAccountId','evidenceReferenceId','changeReason','idempotencyKey','correlationId')) THEN
    RAISE EXCEPTION 'capital mapping request contains unsupported fields' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  BEGIN
    v_ledger := (p_payload ->> 'ledgerAccountId')::uuid;
    v_evidence := (p_payload ->> 'evidenceReferenceId')::uuid;
    v_reason := btrim(p_payload ->> 'changeReason'); v_key := btrim(p_payload ->> 'idempotencyKey');
    v_correlation := (p_payload ->> 'correlationId')::uuid;
  EXCEPTION WHEN others THEN RAISE EXCEPTION 'a complete capital mapping request is required'
    USING ERRCODE = 'invalid_parameter_value'; END;
  SELECT id,status,posting_allowed,account_type,control_account_type,
         requires_project,requires_department,requires_cost_center
    INTO v_ledger_row FROM abos.ledger_accounts
   WHERE id = v_ledger AND legal_entity_id = v_entity;
  IF NOT FOUND OR v_ledger_row.status <> 'ACTIVE' OR NOT v_ledger_row.posting_allowed
     OR v_ledger_row.account_type <> 'EQUITY'
     OR v_ledger_row.control_account_type <> 'SHAREHOLDER_CAPITAL'
     OR v_ledger_row.requires_project OR v_ledger_row.requires_department
     OR v_ledger_row.requires_cost_center THEN
    RAISE EXCEPTION 'capital mapping requires an active posting SHAREHOLDER_CAPITAL equity account without dimensions'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT evidence_kind INTO v_kind FROM abos.evidence_references
   WHERE id = v_evidence AND legal_entity_id = v_entity;
  IF v_kind IS DISTINCT FROM 'CAPITAL_ACCOUNT_MAPPING' THEN
    RAISE EXCEPTION 'capital mapping requires structured CAPITAL_ACCOUNT_MAPPING evidence'
      USING ERRCODE = 'check_violation';
  END IF;
  IF length(v_reason) NOT BETWEEN 3 AND 500 OR length(v_key) NOT BETWEEN 8 AND 200 THEN
    RAISE EXCEPTION 'a mapping reason and idempotency key are required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_fingerprint := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    (p_payload-'correlationId')::text||':'||v_actor::text, 'UTF8')),'hex');
  v_scope := 'shareholder-capital:configure:'||v_entity::text||':'||v_actor::text;
  v_idem := abos.shareholder_capital_idempotency_begin(v_scope,v_key,v_fingerprint,v_correlation);
  IF (v_idem ->> 'replayed')::boolean THEN RETURN v_idem -> 'snapshot'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('capital-mapping:'||v_entity::text,0));
  SELECT COALESCE(max(version),0)+1 INTO v_version
    FROM abos.shareholder_capital_account_mapping_versions WHERE legal_entity_id=v_entity;
  v_mapping := pg_catalog.gen_random_uuid();
  INSERT INTO abos.shareholder_capital_account_mapping_versions
    (id,legal_entity_id,version,paid_in_capital_ledger_account_id,evidence_reference_id,
     change_reason,configured_by_user_account_id,correlation_id,idempotency_key,request_fingerprint)
  VALUES (v_mapping,v_entity,v_version,v_ledger,v_evidence,v_reason,v_actor,v_correlation,v_key,v_fingerprint);
  v_result := pg_catalog.jsonb_build_object('mappingVersionId',v_mapping,'version',v_version,
    'ledgerAccountId',v_ledger,'replayed',false);
  PERFORM abos.shareholder_capital_audit(v_actor,v_entity,v_correlation,
    'SHAREHOLDER_CAPITAL_MAPPING_CONFIGURED','SHAREHOLDER_CAPITAL_MAPPING',v_mapping,v_result);
  PERFORM abos.shareholder_capital_idempotency_complete(v_scope,v_key,'SHAREHOLDER_CAPITAL_MAPPING',v_mapping,v_result);
  RETURN v_result;
END
$configure$;

CREATE FUNCTION abos.prepare_shareholder_capital_posting(
  p_identity_proof text,p_runtime_token_sha256 text,p_token_sha256 text,
  p_receipt_id uuid,p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $prepare$
DECLARE
  v_context jsonb; v_actor uuid; v_entity uuid; v_receipt abos.shareholder_capital_receipts%ROWTYPE;
  v_source abos.shareholder_contributions%ROWTYPE; v_custody record; v_treasury record;
  v_expected integer; v_effective date; v_key text; v_correlation uuid;
  v_fingerprint text; v_scope text; v_idem jsonb; v_policy record; v_mapping record;
  v_period uuid; v_intent uuid; v_result jsonb; v_existing record;
BEGIN
  v_context := abos.operational_finance_actor(p_identity_proof,p_runtime_token_sha256,
    p_token_sha256,'finance.capital-receipt.prepare');
  v_actor := (v_context ->> 'userAccountId')::uuid; v_entity := (v_context ->> 'legalEntityId')::uuid;
  IF EXISTS (SELECT 1 FROM pg_catalog.jsonb_object_keys(p_payload) key
              WHERE key NOT IN ('expectedReceiptVersion','accountingEffectiveDate','idempotencyKey','correlationId')) THEN
    RAISE EXCEPTION 'capital preparation request contains unsupported fields' USING ERRCODE='invalid_parameter_value';
  END IF;
  BEGIN
    v_expected := (p_payload ->> 'expectedReceiptVersion')::integer;
    v_effective := (p_payload ->> 'accountingEffectiveDate')::date;
    v_key := btrim(p_payload ->> 'idempotencyKey'); v_correlation := (p_payload ->> 'correlationId')::uuid;
  EXCEPTION WHEN others THEN RAISE EXCEPTION 'a complete capital preparation request is required'
    USING ERRCODE='invalid_parameter_value'; END;
  SELECT * INTO v_receipt FROM abos.shareholder_capital_receipts
   WHERE id=p_receipt_id AND legal_entity_id=v_entity;
  IF NOT FOUND THEN RAISE EXCEPTION 'capital receipt is not available in this legal entity'
    USING ERRCODE='no_data_found'; END IF;
  IF v_receipt.version<>v_expected THEN RAISE EXCEPTION 'capital receipt changed; reload and try again'
    USING ERRCODE='serialization_failure'; END IF;
  IF v_effective IS DISTINCT FROM v_receipt.receipt_date THEN
    RAISE EXCEPTION 'first-slice capital accounting date must equal the receipt date'
      USING ERRCODE='check_violation';
  END IF;
  SELECT * INTO v_source FROM abos.shareholder_contributions
   WHERE id=v_receipt.contribution_id AND legal_entity_id=v_entity;
  SELECT decision,verified_by_user_account_id INTO v_custody
    FROM abos.shareholder_capital_receipt_custody_verifications
   WHERE shareholder_capital_receipt_id=v_receipt.id AND legal_entity_id=v_entity;
  IF v_source.contribution_type<>'CASH' OR v_source.record_status<>'DECLARED'
     OR v_source.version<>v_receipt.contribution_version OR v_custody.decision IS DISTINCT FROM 'VERIFIED' THEN
    RAISE EXCEPTION 'capital receipt requires its unchanged declared CASH source and verified custody'
      USING ERRCODE='check_violation';
  END IF;
  SELECT account.id,account.currency_code,account.status,ledger.status AS ledger_status,
         ledger.posting_allowed,ledger.account_type,ledger.control_account_type,
         ledger.requires_project,ledger.requires_department,ledger.requires_cost_center
    INTO v_treasury
    FROM abos.operational_treasury_accounts account
    JOIN abos.ledger_accounts ledger ON ledger.id=account.ledger_account_id
     AND ledger.legal_entity_id=account.legal_entity_id
   WHERE account.id=v_receipt.operational_treasury_account_id AND account.legal_entity_id=v_entity;
  IF v_treasury.status<>'ACTIVE' OR v_treasury.ledger_status<>'ACTIVE' OR NOT v_treasury.posting_allowed
     OR v_treasury.account_type<>'ASSET' OR v_treasury.control_account_type<>'CASH'
     OR v_treasury.requires_project OR v_treasury.requires_department OR v_treasury.requires_cost_center
     OR v_treasury.currency_code<>v_receipt.original_currency_code THEN
    RAISE EXCEPTION 'capital receipt Treasury mapping is not active, postable and dimension-free'
      USING ERRCODE='check_violation';
  END IF;
  SELECT * INTO v_policy FROM abos.finance_workflow_policy_versions
   WHERE legal_entity_id=v_entity AND workflow_type='SHAREHOLDER_CAPITAL_RECEIPT'
   ORDER BY version DESC LIMIT 1;
  IF v_policy.id IS NULL OR v_policy.approval_required IS NOT TRUE THEN
    RAISE EXCEPTION 'capital receipt approval policy is not configured as approval-required'
      USING ERRCODE='check_violation';
  END IF;
  SELECT mapping.id,mapping.version,ledger.id AS ledger_id,ledger.status,ledger.posting_allowed,
         ledger.account_type,ledger.control_account_type,ledger.requires_project,
         ledger.requires_department,ledger.requires_cost_center
    INTO v_mapping
    FROM abos.shareholder_capital_account_mapping_versions mapping
    JOIN abos.ledger_accounts ledger ON ledger.id=mapping.paid_in_capital_ledger_account_id
     AND ledger.legal_entity_id=mapping.legal_entity_id
   WHERE mapping.legal_entity_id=v_entity ORDER BY mapping.version DESC LIMIT 1;
  IF v_mapping.id IS NULL OR v_mapping.status<>'ACTIVE' OR NOT v_mapping.posting_allowed
     OR v_mapping.account_type<>'EQUITY' OR v_mapping.control_account_type<>'SHAREHOLDER_CAPITAL'
     OR v_mapping.requires_project OR v_mapping.requires_department OR v_mapping.requires_cost_center THEN
    RAISE EXCEPTION 'paid-in-capital mapping is missing or no longer valid'
      USING ERRCODE='check_violation';
  END IF;
  SELECT id INTO v_period FROM abos.accounting_periods
   WHERE legal_entity_id=v_entity AND status='OPEN'
     AND v_effective BETWEEN starts_on AND ends_on ORDER BY starts_on DESC LIMIT 1;
  IF v_period IS NULL THEN RAISE EXCEPTION 'no open accounting period covers the capital receipt date'
    USING ERRCODE='check_violation'; END IF;
  v_fingerprint:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    (p_payload-'correlationId')::text||':'||p_receipt_id::text||':'||v_actor::text, 'UTF8')),'hex');
  v_scope:='shareholder-capital:prepare:'||v_entity::text||':'||v_actor::text;
  v_idem:=abos.shareholder_capital_idempotency_begin(v_scope,v_key,v_fingerprint,v_correlation);
  IF (v_idem->>'replayed')::boolean THEN RETURN v_idem->'snapshot'; END IF;
  SELECT id,status,operational_version,created_by_user_account_id INTO v_existing
    FROM abos.posting_intents WHERE legal_entity_id=v_entity AND shareholder_capital_receipt_id=v_receipt.id;
  IF FOUND THEN
    RAISE EXCEPTION 'this capital receipt already has a posting intent'
      USING ERRCODE='unique_violation';
  END IF;
  v_intent:=pg_catalog.gen_random_uuid();
  INSERT INTO abos.posting_intents
    (id,legal_entity_id,source_type,source_id,intent_kind,original_amount,
     original_currency_code,base_amount,base_currency_code,accounting_effective_date,
     correlation_id,idempotency_key,status,created_by_user_account_id,processing_model,
     shareholder_capital_receipt_id,finance_workflow_policy_version_id,
     shareholder_capital_account_mapping_version_id,operational_version)
  VALUES (v_intent,v_entity,'SHAREHOLDER_CAPITAL_CONTRIBUTION_RECEIPT',v_receipt.id,
    'SHAREHOLDER_CAPITAL_RECEIPT',v_receipt.original_amount,v_receipt.original_currency_code,
    v_receipt.original_amount,v_receipt.original_currency_code,v_effective,v_correlation,v_key,
    'PENDING_APPROVAL',v_actor,'OPERATIONAL_V1',v_receipt.id,v_policy.id,v_mapping.id,1);
  v_result:=pg_catalog.jsonb_build_object('receiptId',v_receipt.id,'postingIntentId',v_intent,
    'status','PENDING_APPROVAL','version',1,'journalId',NULL,'replayed',false);
  PERFORM abos.shareholder_capital_audit(v_actor,v_entity,v_correlation,
    'SHAREHOLDER_CAPITAL_POSTING_PREPARED','POSTING_INTENT',v_intent,v_result);
  PERFORM abos.shareholder_capital_idempotency_complete(v_scope,v_key,'POSTING_INTENT',v_intent,v_result);
  RETURN v_result;
END
$prepare$;

CREATE FUNCTION abos.decide_shareholder_capital_posting(
  p_identity_proof text,p_runtime_token_sha256 text,p_token_sha256 text,
  p_posting_intent_id uuid,p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $decide$
DECLARE
  v_context jsonb; v_actor uuid; v_entity uuid; v_intent abos.posting_intents%ROWTYPE;
  v_expected integer; v_decision text; v_evidence uuid; v_reason text; v_key text; v_correlation uuid;
  v_fingerprint text; v_scope text; v_idem jsonb; v_approval uuid; v_result jsonb;
BEGIN
  v_context:=abos.operational_finance_actor(p_identity_proof,p_runtime_token_sha256,
    p_token_sha256,'finance.capital-receipt.approve');
  v_actor:=(v_context->>'userAccountId')::uuid; v_entity:=(v_context->>'legalEntityId')::uuid;
  IF EXISTS (SELECT 1 FROM pg_catalog.jsonb_object_keys(p_payload) key
              WHERE key NOT IN ('expectedIntentVersion','decision','evidenceReferenceId','decisionReason','idempotencyKey','correlationId')) THEN
    RAISE EXCEPTION 'capital approval request contains unsupported fields' USING ERRCODE='invalid_parameter_value';
  END IF;
  BEGIN
    v_expected:=(p_payload->>'expectedIntentVersion')::integer; v_decision:=p_payload->>'decision';
    v_evidence:=(p_payload->>'evidenceReferenceId')::uuid; v_reason:=btrim(p_payload->>'decisionReason');
    v_key:=btrim(p_payload->>'idempotencyKey'); v_correlation:=(p_payload->>'correlationId')::uuid;
  EXCEPTION WHEN others THEN RAISE EXCEPTION 'a complete capital approval decision is required'
    USING ERRCODE='invalid_parameter_value'; END;
  SELECT * INTO v_intent FROM abos.posting_intents
   WHERE id=p_posting_intent_id AND legal_entity_id=v_entity FOR UPDATE;
  IF NOT FOUND OR v_intent.processing_model<>'OPERATIONAL_V1'
     OR v_intent.source_type<>'SHAREHOLDER_CAPITAL_CONTRIBUTION_RECEIPT' THEN
    RAISE EXCEPTION 'capital posting intent is not available in this legal entity'
      USING ERRCODE='no_data_found';
  END IF;
  v_fingerprint:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    (p_payload-'correlationId')::text||':'||p_posting_intent_id::text||':'||v_actor::text, 'UTF8')),'hex');
  v_scope:='shareholder-capital:decide:'||v_entity::text||':'||v_actor::text;
  v_idem:=abos.shareholder_capital_idempotency_begin(v_scope,v_key,v_fingerprint,v_correlation);
  IF (v_idem->>'replayed')::boolean THEN RETURN v_idem->'snapshot'; END IF;
  IF v_intent.operational_version<>v_expected THEN RAISE EXCEPTION 'capital posting changed; reload and try again'
    USING ERRCODE='serialization_failure'; END IF;
  IF v_intent.status<>'PENDING_APPROVAL' THEN RAISE EXCEPTION 'capital posting is not waiting for approval'
    USING ERRCODE='check_violation'; END IF;
  IF v_decision NOT IN ('APPROVED','REJECTED') OR length(v_reason) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'a terminal decision and reason are required' USING ERRCODE='invalid_parameter_value';
  END IF;
  v_approval:=pg_catalog.gen_random_uuid();
  INSERT INTO abos.posting_approvals
    (id,legal_entity_id,posting_intent_id,decision,decision_reason,
     approver_user_account_id,evidence_reference_id,approved_at,shareholder_capital_receipt_id)
  VALUES (v_approval,v_entity,v_intent.id,v_decision,v_reason,v_actor,v_evidence,
          pg_catalog.clock_timestamp(),v_intent.shareholder_capital_receipt_id);
  UPDATE abos.posting_intents SET status=v_decision,operational_version=operational_version+1
   WHERE id=v_intent.id;
  v_result:=pg_catalog.jsonb_build_object('receiptId',v_intent.shareholder_capital_receipt_id,
    'postingIntentId',v_intent.id,'status',v_decision,'version',v_expected+1,
    'journalId',NULL,'replayed',false);
  PERFORM abos.shareholder_capital_audit(v_actor,v_entity,v_correlation,
    CASE v_decision WHEN 'APPROVED' THEN 'SHAREHOLDER_CAPITAL_POSTING_APPROVED'
      ELSE 'SHAREHOLDER_CAPITAL_POSTING_REJECTED' END,'POSTING_INTENT',v_intent.id,v_result);
  PERFORM abos.shareholder_capital_idempotency_complete(v_scope,v_key,'POSTING_APPROVAL',v_approval,v_result);
  RETURN v_result;
END
$decide$;

CREATE FUNCTION abos.post_shareholder_capital_receipt(
  p_identity_proof text,p_runtime_token_sha256 text,p_token_sha256 text,
  p_posting_intent_id uuid,p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $post$
DECLARE
  v_context jsonb; v_actor uuid; v_entity uuid; v_intent abos.posting_intents%ROWTYPE;
  v_receipt abos.shareholder_capital_receipts%ROWTYPE; v_source abos.shareholder_contributions%ROWTYPE;
  v_custody record; v_approval record; v_policy record; v_mapping record; v_treasury record;
  v_party uuid; v_period uuid; v_expected integer; v_key text; v_correlation uuid;
  v_fingerprint text; v_scope text; v_idem jsonb; v_journal uuid; v_debit uuid; v_credit uuid;
  v_result jsonb; v_entity_base text; v_currency_policy text;
BEGIN
  v_context:=abos.operational_finance_actor(p_identity_proof,p_runtime_token_sha256,
    p_token_sha256,'finance.capital-receipt.post');
  v_actor:=(v_context->>'userAccountId')::uuid; v_entity:=(v_context->>'legalEntityId')::uuid;
  IF EXISTS (SELECT 1 FROM pg_catalog.jsonb_object_keys(p_payload) key
              WHERE key NOT IN ('expectedIntentVersion','idempotencyKey','correlationId')) THEN
    RAISE EXCEPTION 'capital posting request contains unsupported fields' USING ERRCODE='invalid_parameter_value';
  END IF;
  BEGIN
    v_expected:=(p_payload->>'expectedIntentVersion')::integer;
    v_key:=btrim(p_payload->>'idempotencyKey'); v_correlation:=(p_payload->>'correlationId')::uuid;
  EXCEPTION WHEN others THEN RAISE EXCEPTION 'a complete capital posting request is required'
    USING ERRCODE='invalid_parameter_value'; END;
  v_fingerprint:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    (p_payload-'correlationId')::text||':'||p_posting_intent_id::text||':'||v_actor::text, 'UTF8')),'hex');
  v_scope:='shareholder-capital:post:'||v_entity::text||':'||v_actor::text;
  v_idem:=abos.shareholder_capital_idempotency_begin(v_scope,v_key,v_fingerprint,v_correlation);
  IF (v_idem->>'replayed')::boolean THEN RETURN v_idem->'snapshot'; END IF;

  SELECT * INTO v_intent FROM abos.posting_intents
   WHERE id=p_posting_intent_id AND legal_entity_id=v_entity FOR UPDATE;
  IF NOT FOUND OR v_intent.processing_model<>'OPERATIONAL_V1'
     OR v_intent.source_type<>'SHAREHOLDER_CAPITAL_CONTRIBUTION_RECEIPT'
     OR v_intent.intent_kind<>'SHAREHOLDER_CAPITAL_RECEIPT' THEN
    RAISE EXCEPTION 'capital posting intent is not available in this legal entity'
      USING ERRCODE='no_data_found';
  END IF;
  IF v_intent.operational_version<>v_expected THEN RAISE EXCEPTION 'capital posting changed; reload and try again'
    USING ERRCODE='serialization_failure'; END IF;
  IF v_intent.status<>'APPROVED' THEN RAISE EXCEPTION 'only an approved capital posting can be posted'
    USING ERRCODE='check_violation'; END IF;
  SELECT * INTO v_receipt FROM abos.shareholder_capital_receipts
   WHERE id=v_intent.shareholder_capital_receipt_id AND legal_entity_id=v_entity;
  SELECT * INTO v_source FROM abos.shareholder_contributions
   WHERE id=v_receipt.contribution_id AND legal_entity_id=v_entity;
  SELECT decision,verified_amount,verified_currency_code,operational_treasury_account_id,
         verified_by_user_account_id INTO v_custody
    FROM abos.shareholder_capital_receipt_custody_verifications
   WHERE shareholder_capital_receipt_id=v_receipt.id AND legal_entity_id=v_entity;
  SELECT decision,approver_user_account_id,evidence_reference_id INTO v_approval
    FROM abos.posting_approvals
   WHERE posting_intent_id=v_intent.id AND legal_entity_id=v_entity
     AND shareholder_capital_receipt_id=v_receipt.id;
  SELECT * INTO v_policy FROM abos.finance_workflow_policy_versions
   WHERE id=v_intent.finance_workflow_policy_version_id AND legal_entity_id=v_entity
     AND workflow_type='SHAREHOLDER_CAPITAL_RECEIPT';
  SELECT mapping.id,mapping.paid_in_capital_ledger_account_id,mapping.version,
         ledger.status,ledger.posting_allowed,ledger.account_type,ledger.control_account_type,
         ledger.requires_project,ledger.requires_department,ledger.requires_cost_center
    INTO v_mapping
    FROM abos.shareholder_capital_account_mapping_versions mapping
    JOIN abos.ledger_accounts ledger ON ledger.id=mapping.paid_in_capital_ledger_account_id
     AND ledger.legal_entity_id=mapping.legal_entity_id
   WHERE mapping.id=v_intent.shareholder_capital_account_mapping_version_id
     AND mapping.legal_entity_id=v_entity;
  SELECT account.id,account.ledger_account_id,account.currency_code,account.status,
         ledger.status AS ledger_status,ledger.posting_allowed,ledger.account_type,
         ledger.control_account_type,ledger.requires_project,ledger.requires_department,
         ledger.requires_cost_center
    INTO v_treasury
    FROM abos.operational_treasury_accounts account
    JOIN abos.ledger_accounts ledger ON ledger.id=account.ledger_account_id
     AND ledger.legal_entity_id=account.legal_entity_id
   WHERE account.id=v_receipt.operational_treasury_account_id AND account.legal_entity_id=v_entity;
  SELECT profile.business_party_id INTO v_party
    FROM abos.shareholder_profiles profile
   WHERE profile.id=v_source.shareholder_profile_id AND profile.legal_entity_id=v_entity;
  SELECT base_currency_code,currency_policy_status INTO v_entity_base,v_currency_policy
    FROM abos.legal_entities WHERE id=v_entity;
  SELECT id INTO v_period FROM abos.accounting_periods
   WHERE legal_entity_id=v_entity AND status='OPEN'
     AND v_receipt.receipt_date BETWEEN starts_on AND ends_on ORDER BY starts_on DESC LIMIT 1;
  IF v_source.id IS NULL OR v_source.contribution_type<>'CASH' OR v_source.record_status<>'DECLARED'
     OR v_source.version<>v_receipt.contribution_version
     OR v_source.amount<v_receipt.original_amount OR v_source.currency_code<>v_receipt.original_currency_code
     OR v_custody.decision IS DISTINCT FROM 'VERIFIED'
     OR v_custody.verified_amount IS DISTINCT FROM v_receipt.original_amount
     OR v_custody.verified_currency_code IS DISTINCT FROM v_receipt.original_currency_code
     OR v_custody.operational_treasury_account_id IS DISTINCT FROM v_receipt.operational_treasury_account_id
     OR v_approval.decision IS DISTINCT FROM 'APPROVED'
     OR v_approval.approver_user_account_id IS DISTINCT FROM v_actor
     OR v_policy.approval_required IS NOT TRUE
     OR v_mapping.id IS NULL OR v_mapping.status<>'ACTIVE' OR NOT v_mapping.posting_allowed
     OR v_mapping.account_type<>'EQUITY' OR v_mapping.control_account_type<>'SHAREHOLDER_CAPITAL'
     OR v_mapping.requires_project OR v_mapping.requires_department OR v_mapping.requires_cost_center
     OR v_treasury.id IS NULL OR v_treasury.status<>'ACTIVE' OR v_treasury.ledger_status<>'ACTIVE'
     OR NOT v_treasury.posting_allowed OR v_treasury.account_type<>'ASSET'
     OR v_treasury.control_account_type<>'CASH' OR v_treasury.requires_project
     OR v_treasury.requires_department OR v_treasury.requires_cost_center
     OR v_treasury.currency_code<>v_receipt.original_currency_code
     OR v_entity_base<>v_receipt.original_currency_code OR v_currency_policy<>'APPROVED'
     OR v_period IS NULL OR v_party IS NULL THEN
    RAISE EXCEPTION 'capital posting facts, approval, mapping, Treasury, period or currency are no longer valid'
      USING ERRCODE='check_violation';
  END IF;
  IF v_intent.original_amount<>v_receipt.original_amount
     OR v_intent.original_currency_code<>v_receipt.original_currency_code
     OR v_intent.base_amount<>v_receipt.original_amount
     OR v_intent.base_currency_code<>v_receipt.original_currency_code
     OR v_intent.accounting_effective_date<>v_receipt.receipt_date THEN
    RAISE EXCEPTION 'capital intent no longer matches its exact receipt' USING ERRCODE='check_violation';
  END IF;
  v_journal:=pg_catalog.gen_random_uuid(); v_debit:=pg_catalog.gen_random_uuid(); v_credit:=pg_catalog.gen_random_uuid();
  INSERT INTO abos.journals
    (id,legal_entity_id,accounting_period_id,posting_intent_id,journal_reference,
     accounting_effective_date,base_currency_code,status,created_by_user_account_id,processing_model)
  VALUES (v_journal,v_entity,v_period,v_intent.id,'CAP-'||replace(v_receipt.id::text,'-',''),
    v_receipt.receipt_date,v_entity_base,'DRAFT',v_actor,'OPERATIONAL_V1');
  INSERT INTO abos.journal_lines
    (id,journal_id,legal_entity_id,line_number,ledger_account_id,business_party_id,
     original_amount,original_currency_code,base_debit,base_credit,base_currency_code,
     conversion_snapshot_reference,source_type,source_id,processing_model)
  VALUES
    (v_debit,v_journal,v_entity,1,v_treasury.ledger_account_id,NULL,
     v_receipt.original_amount,v_receipt.original_currency_code,v_receipt.original_amount,0,
     v_entity_base,NULL,'SHAREHOLDER_CAPITAL_CONTRIBUTION_RECEIPT',v_receipt.id,'OPERATIONAL_V1'),
    (v_credit,v_journal,v_entity,2,v_mapping.paid_in_capital_ledger_account_id,v_party,
     v_receipt.original_amount,v_receipt.original_currency_code,0,v_receipt.original_amount,
     v_entity_base,NULL,'SHAREHOLDER_CAPITAL_CONTRIBUTION_RECEIPT',v_receipt.id,'OPERATIONAL_V1');
  INSERT INTO abos.subledger_entries
    (id,legal_entity_id,journal_line_id,subledger_type,business_party_id,
     operational_treasury_account_id,original_amount,original_currency_code,
     base_amount,base_currency_code,source_type,source_id,processing_model,
     shareholder_capital_receipt_id)
  VALUES
    (pg_catalog.gen_random_uuid(),v_entity,v_debit,'OPERATIONAL_TREASURY',NULL,
     v_receipt.operational_treasury_account_id,v_receipt.original_amount,
     v_receipt.original_currency_code,v_receipt.original_amount,v_entity_base,
     'SHAREHOLDER_CAPITAL_CONTRIBUTION_RECEIPT',v_receipt.id,'OPERATIONAL_V1',v_receipt.id),
    (pg_catalog.gen_random_uuid(),v_entity,v_credit,'SHAREHOLDER_CAPITAL',v_party,NULL,
     -v_receipt.original_amount,v_receipt.original_currency_code,-v_receipt.original_amount,
     v_entity_base,'SHAREHOLDER_CAPITAL_CONTRIBUTION_RECEIPT',v_receipt.id,'OPERATIONAL_V1',v_receipt.id);
  UPDATE abos.posting_intents SET status='POSTED',operational_version=operational_version+1
   WHERE id=v_intent.id;
  UPDATE abos.journals SET status='POSTED',posted_by_user_account_id=v_actor,
    posted_at=pg_catalog.clock_timestamp() WHERE id=v_journal;
  v_result:=pg_catalog.jsonb_build_object('receiptId',v_receipt.id,'postingIntentId',v_intent.id,
    'status','POSTED','version',v_expected+1,'journalId',v_journal,'replayed',false);
  PERFORM abos.shareholder_capital_audit(v_actor,v_entity,v_correlation,
    'SHAREHOLDER_CAPITAL_RECEIPT_POSTED','POSTING_INTENT',v_intent.id,v_result);
  PERFORM abos.shareholder_capital_idempotency_complete(v_scope,v_key,'JOURNAL',v_journal,v_result);
  RETURN v_result;
END
$post$;

CREATE FUNCTION abos.validate_operational_capital_journal_posting()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $validate$
DECLARE
  v_intent abos.posting_intents%ROWTYPE; v_receipt abos.shareholder_capital_receipts%ROWTYPE;
  v_mapping abos.shareholder_capital_account_mapping_versions%ROWTYPE;
  v_treasury abos.operational_treasury_accounts%ROWTYPE; v_party uuid;
  v_line_count bigint; v_debit numeric; v_credit numeric; v_subledger_count bigint;
BEGIN
  IF NEW.status<>'POSTED' THEN RETURN NEW; END IF;
  SELECT * INTO v_intent FROM abos.posting_intents
   WHERE id=NEW.posting_intent_id AND legal_entity_id=NEW.legal_entity_id;
  IF v_intent.processing_model<>'OPERATIONAL_V1'
     OR v_intent.source_type<>'SHAREHOLDER_CAPITAL_CONTRIBUTION_RECEIPT' THEN RETURN NEW; END IF;
  SELECT * INTO v_receipt FROM abos.shareholder_capital_receipts
   WHERE id=v_intent.shareholder_capital_receipt_id AND legal_entity_id=NEW.legal_entity_id;
  SELECT * INTO v_mapping FROM abos.shareholder_capital_account_mapping_versions
   WHERE id=v_intent.shareholder_capital_account_mapping_version_id AND legal_entity_id=NEW.legal_entity_id;
  SELECT * INTO v_treasury FROM abos.operational_treasury_accounts
   WHERE id=v_receipt.operational_treasury_account_id AND legal_entity_id=NEW.legal_entity_id;
  SELECT profile.business_party_id INTO v_party
    FROM abos.shareholder_contributions contribution
    JOIN abos.shareholder_profiles profile ON profile.id=contribution.shareholder_profile_id
     AND profile.legal_entity_id=contribution.legal_entity_id
   WHERE contribution.id=v_receipt.contribution_id AND contribution.legal_entity_id=NEW.legal_entity_id;
  SELECT count(*),COALESCE(sum(base_debit),0),COALESCE(sum(base_credit),0)
    INTO v_line_count,v_debit,v_credit FROM abos.journal_lines WHERE journal_id=NEW.id;
  IF v_intent.status<>'POSTED' OR v_intent.operational_version<3
     OR v_line_count<>2 OR v_debit<>v_credit OR v_debit<>v_receipt.original_amount
     OR NEW.accounting_effective_date<>v_receipt.receipt_date
     OR NEW.base_currency_code<>v_receipt.original_currency_code THEN
    RAISE EXCEPTION 'capital journal must be a posted exact two-line receipt journal'
      USING ERRCODE='check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM abos.journal_lines line WHERE line.journal_id=NEW.id
      AND line.line_number=1 AND line.ledger_account_id=v_treasury.ledger_account_id
      AND line.base_debit=v_receipt.original_amount AND line.base_credit=0
      AND line.business_party_id IS NULL AND line.source_type='SHAREHOLDER_CAPITAL_CONTRIBUTION_RECEIPT'
      AND line.source_id=v_receipt.id AND line.processing_model='OPERATIONAL_V1')
     OR NOT EXISTS (SELECT 1 FROM abos.journal_lines line WHERE line.journal_id=NEW.id
      AND line.line_number=2 AND line.ledger_account_id=v_mapping.paid_in_capital_ledger_account_id
      AND line.base_debit=0 AND line.base_credit=v_receipt.original_amount
      AND line.business_party_id=v_party AND line.source_type='SHAREHOLDER_CAPITAL_CONTRIBUTION_RECEIPT'
      AND line.source_id=v_receipt.id AND line.processing_model='OPERATIONAL_V1') THEN
    RAISE EXCEPTION 'capital journal must debit Treasury and credit mapped shareholder capital'
      USING ERRCODE='check_violation';
  END IF;
  SELECT count(*) INTO v_subledger_count FROM abos.subledger_entries entry
   JOIN abos.journal_lines line ON line.id=entry.journal_line_id
   WHERE line.journal_id=NEW.id AND entry.shareholder_capital_receipt_id=v_receipt.id
     AND entry.processing_model='OPERATIONAL_V1';
  IF v_subledger_count<>2 OR EXISTS (
    SELECT 1 FROM abos.subledger_entries entry
    JOIN abos.journal_lines line ON line.id=entry.journal_line_id
    WHERE line.journal_id=NEW.id AND NOT (
      (line.line_number=1 AND entry.subledger_type='OPERATIONAL_TREASURY'
       AND entry.operational_treasury_account_id=v_treasury.id AND entry.business_party_id IS NULL
       AND entry.original_amount=v_receipt.original_amount AND entry.base_amount=v_receipt.original_amount)
      OR
      (line.line_number=2 AND entry.subledger_type='SHAREHOLDER_CAPITAL'
       AND entry.operational_treasury_account_id IS NULL AND entry.business_party_id=v_party
       AND entry.original_amount=-v_receipt.original_amount AND entry.base_amount=-v_receipt.original_amount)
    )) THEN
    RAISE EXCEPTION 'capital journal requires exactly two typed receipt subledger effects'
      USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END
$validate$;
CREATE TRIGGER journals_operational_capital_posting_guard
BEFORE INSERT OR UPDATE ON abos.journals
FOR EACH ROW WHEN (NEW.processing_model='OPERATIONAL_V1')
EXECUTE FUNCTION abos.validate_operational_capital_journal_posting();

CREATE FUNCTION abos.shareholder_capital_capability(
  p_identity_proof text,p_runtime_token_sha256 text,p_token_sha256 text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $capability$
DECLARE
  v_context jsonb; v_entity uuid; v_permissions jsonb; v_policy record; v_mapping uuid;
  v_treasury_destinations jsonb;
BEGIN
  v_context:=abos.operational_finance_actor(p_identity_proof,p_runtime_token_sha256,p_token_sha256,NULL);
  v_entity:=(v_context->>'legalEntityId')::uuid;
  v_permissions:=COALESCE(v_context->'permissions','[]'::jsonb);
  IF NOT (v_permissions ? 'shareholder.capital-receipt.read'
       OR v_permissions ? 'shareholder.capital-receipt.record'
       OR v_permissions ? 'treasury.capital-receipt.verify'
       OR v_permissions ? 'finance.capital-receipt.configure'
       OR v_permissions ? 'finance.capital-receipt.prepare'
       OR v_permissions ? 'finance.capital-receipt.approve'
       OR v_permissions ? 'finance.capital-receipt.post') THEN
    RAISE EXCEPTION 'current authority has no shareholder capital bridge permission'
      USING ERRCODE='insufficient_privilege';
  END IF;
  SELECT id,approval_required,version INTO v_policy FROM abos.finance_workflow_policy_versions
   WHERE legal_entity_id=v_entity AND workflow_type='SHAREHOLDER_CAPITAL_RECEIPT'
   ORDER BY version DESC LIMIT 1;
  SELECT mapping.id INTO v_mapping
    FROM abos.shareholder_capital_account_mapping_versions mapping
    JOIN abos.ledger_accounts ledger
      ON ledger.id=mapping.paid_in_capital_ledger_account_id
     AND ledger.legal_entity_id=mapping.legal_entity_id
   WHERE mapping.legal_entity_id=v_entity
     AND ledger.status='ACTIVE' AND ledger.posting_allowed
     AND ledger.account_type='EQUITY' AND ledger.control_account_type='SHAREHOLDER_CAPITAL'
     AND NOT ledger.requires_project AND NOT ledger.requires_department
     AND NOT ledger.requires_cost_center
   ORDER BY mapping.version DESC LIMIT 1;
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'id',account.id,'name',account.name_en,'currency',account.currency_code)
           ORDER BY account.name_en), '[]'::jsonb)
    INTO v_treasury_destinations
    FROM abos.operational_treasury_accounts account
    JOIN abos.ledger_accounts ledger
      ON ledger.id=account.ledger_account_id AND ledger.legal_entity_id=account.legal_entity_id
    JOIN abos.legal_entities entity ON entity.id=account.legal_entity_id
   WHERE account.legal_entity_id=v_entity AND account.status='ACTIVE'
     AND entity.currency_policy_status='APPROVED'
     AND account.currency_code=entity.base_currency_code
     AND ledger.status='ACTIVE' AND ledger.posting_allowed
     AND ledger.account_type='ASSET' AND ledger.control_account_type='CASH'
     AND NOT ledger.requires_project AND NOT ledger.requires_department
     AND NOT ledger.requires_cost_center;
  RETURN pg_catalog.jsonb_build_object(
    'state',CASE WHEN v_policy.approval_required IS TRUE AND v_mapping IS NOT NULL
                       AND pg_catalog.jsonb_array_length(v_treasury_destinations)>0
                 THEN 'OPERATIONAL' ELSE 'NOT_OPERATIONAL' END,
    'schemaInstalled',true,
    'mutationAvailable',v_policy.approval_required IS TRUE AND v_mapping IS NOT NULL
                        AND pg_catalog.jsonb_array_length(v_treasury_destinations)>0,
    'reviewModeAvailable',false,
    'requiredSessionProvenance','PASSWORD_OPERATIONAL',
    'reason',CASE WHEN v_policy.id IS NULL THEN 'Capital receipt approval policy is not configured.'
                  WHEN v_policy.approval_required IS NOT TRUE THEN 'Capital receipt approval must be required.'
                  WHEN v_mapping IS NULL THEN 'Paid-in-capital account mapping is not configured.'
                  WHEN pg_catalog.jsonb_array_length(v_treasury_destinations)=0
                    THEN 'No active base-currency Treasury destination is configured.'
                  ELSE 'The Shareholders to Finance bridge is operational.' END,
    'permissions',v_permissions,
    'policyVersion',v_policy.version,
    'mappingVersionId',v_mapping,
    'treasuryDestinations',v_treasury_destinations);
END
$capability$;

CREATE FUNCTION abos.shareholder_capital_trace(
  p_identity_proof text,p_runtime_token_sha256 text,p_token_sha256 text,p_contribution_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $trace$
DECLARE v_context jsonb; v_entity uuid; v_source record; v_capability jsonb;
BEGIN
  v_context:=abos.operational_finance_actor(p_identity_proof,p_runtime_token_sha256,
    p_token_sha256,'shareholder.capital-receipt.read');
  v_entity:=(v_context->>'legalEntityId')::uuid;
  SELECT contribution.*,profile.business_party_id,party.display_name INTO v_source
    FROM abos.shareholder_contributions contribution
    JOIN abos.shareholder_profiles profile ON profile.id=contribution.shareholder_profile_id
     AND profile.legal_entity_id=contribution.legal_entity_id
    JOIN abos.business_parties party ON party.id=profile.business_party_id
     AND party.legal_entity_id=profile.legal_entity_id
   WHERE contribution.id=p_contribution_id AND contribution.legal_entity_id=v_entity;
  IF NOT FOUND THEN RAISE EXCEPTION 'capital contribution is not available in this legal entity'
    USING ERRCODE='no_data_found'; END IF;
  v_capability:=abos.shareholder_capital_capability(p_identity_proof,p_runtime_token_sha256,p_token_sha256);
  RETURN pg_catalog.jsonb_build_object(
    'capability',v_capability,
    'contribution',pg_catalog.jsonb_build_object(
      'contributionId',v_source.id,'shareholderProfileId',v_source.shareholder_profile_id,
      'shareholderBusinessPartyId',v_source.business_party_id,
      'shareholderDisplayName',v_source.display_name,'declarationDate',v_source.business_date,
      'declaredAmount',pg_catalog.jsonb_build_object('amount',v_source.amount::text,'currency',v_source.currency_code),
      'receivedAmount',pg_catalog.jsonb_build_object('amount',COALESCE((SELECT sum(r.original_amount)
        FROM abos.shareholder_capital_receipts r WHERE r.contribution_id=v_source.id
          AND r.legal_entity_id=v_entity AND r.record_state='RECORDED'),0)::text,'currency',v_source.currency_code),
      'custodyVerifiedAmount',pg_catalog.jsonb_build_object('amount',COALESCE((SELECT sum(r.original_amount)
        FROM abos.shareholder_capital_receipts r JOIN abos.shareholder_capital_receipt_custody_verifications c
          ON c.shareholder_capital_receipt_id=r.id AND c.legal_entity_id=r.legal_entity_id
        WHERE r.contribution_id=v_source.id AND r.legal_entity_id=v_entity AND c.decision='VERIFIED'),0)::text,'currency',v_source.currency_code),
      'approvedAmount',pg_catalog.jsonb_build_object('amount',COALESCE((SELECT sum(r.original_amount)
        FROM abos.shareholder_capital_receipts r JOIN abos.posting_approvals a
          ON a.shareholder_capital_receipt_id=r.id AND a.legal_entity_id=r.legal_entity_id
        WHERE r.contribution_id=v_source.id AND r.legal_entity_id=v_entity AND a.decision='APPROVED'),0)::text,'currency',v_source.currency_code),
      'postedAmount',pg_catalog.jsonb_build_object('amount',COALESCE((SELECT sum(r.original_amount)
        FROM abos.shareholder_capital_receipts r JOIN abos.posting_intents i
          ON i.shareholder_capital_receipt_id=r.id AND i.legal_entity_id=r.legal_entity_id
        WHERE r.contribution_id=v_source.id AND r.legal_entity_id=v_entity AND i.status='POSTED'),0)::text,'currency',v_source.currency_code),
      'outstandingAmount',pg_catalog.jsonb_build_object('amount',(v_source.amount-COALESCE((SELECT sum(r.original_amount)
        FROM abos.shareholder_capital_receipts r WHERE r.contribution_id=v_source.id
          AND r.legal_entity_id=v_entity AND r.record_state='RECORDED'),0))::text,'currency',v_source.currency_code),
      'status',CASE WHEN EXISTS (SELECT 1 FROM abos.posting_intents i JOIN abos.shareholder_capital_receipts r
                    ON r.id=i.shareholder_capital_receipt_id WHERE r.contribution_id=v_source.id AND i.status='POSTED') THEN 'POSTED'
                    WHEN EXISTS (SELECT 1 FROM abos.posting_approvals a JOIN abos.shareholder_capital_receipts r
                    ON r.id=a.shareholder_capital_receipt_id WHERE r.contribution_id=v_source.id AND a.decision='APPROVED') THEN 'APPROVED'
                    WHEN EXISTS (SELECT 1 FROM abos.shareholder_capital_receipt_custody_verifications c JOIN abos.shareholder_capital_receipts r
                    ON r.id=c.shareholder_capital_receipt_id WHERE r.contribution_id=v_source.id AND c.decision='VERIFIED') THEN 'VERIFIED'
                    WHEN EXISTS (SELECT 1 FROM abos.shareholder_capital_receipts r WHERE r.contribution_id=v_source.id) THEN 'RECEIVED'
                    ELSE 'DECLARED' END,
      'receipts',COALESCE((SELECT pg_catalog.jsonb_agg(abos.shareholder_capital_receipt_json(r.id) ORDER BY r.recorded_at)
        FROM abos.shareholder_capital_receipts r WHERE r.contribution_id=v_source.id AND r.legal_entity_id=v_entity),'[]'::jsonb)),
    'legacyAgreements','[]'::jsonb);
END
$trace$;

-- Exact least-privilege table access. Runtime roles retain zero direct protected-table DML.
GRANT SELECT ON abos.shareholder_capital_receipts TO abos_v1_shareholder_capital_owner;
GRANT INSERT (id,legal_entity_id,contribution_id,operational_treasury_account_id,original_amount,
  original_currency_code,receipt_date,payment_reference,evidence_reference_id,contribution_version,
  source_fingerprint,record_state,version,correlation_id,idempotency_key,request_fingerprint,
  recorded_by_user_account_id)
  ON abos.shareholder_capital_receipts TO abos_v1_shareholder_capital_owner;
GRANT SELECT, INSERT ON abos.shareholder_capital_receipt_custody_verifications
  TO abos_v1_shareholder_capital_owner;
GRANT SELECT ON abos.operational_treasury_accounts,abos.legal_entities,abos.evidence_references,
  abos.posting_intents,abos.posting_approvals,abos.journals,abos.shareholder_capital_account_mapping_versions,
  abos.idempotency_records TO abos_v1_shareholder_capital_owner;
GRANT INSERT (scope,idempotency_key,request_fingerprint,correlation_id,status)
  ON abos.idempotency_records TO abos_v1_shareholder_capital_owner;
GRANT UPDATE (status,resource_type,resource_id,response_code,response_snapshot,completed_at)
  ON abos.idempotency_records TO abos_v1_shareholder_capital_owner;
GRANT INSERT (id,actor_user_account_id,legal_entity_id,correlation_id,action,entity_type,
  entity_id,before_state,after_state,metadata) ON abos.audit_records TO abos_v1_shareholder_capital_owner;
GRANT INSERT (id,aggregate_type,aggregate_id,event_type,event_version,legal_entity_id,
  actor_user_account_id,correlation_id,payload,occurred_at) ON abos.outbox_events TO abos_v1_shareholder_capital_owner;
GRANT EXECUTE ON FUNCTION abos.identity_actor_context(text,text,text),
  abos.shareholder_contribution_finance_lock(uuid,uuid,integer)
  TO abos_v1_shareholder_capital_owner;

GRANT SELECT ON abos.shareholder_capital_receipts,
  abos.shareholder_capital_receipt_custody_verifications,
  abos.shareholder_capital_account_mapping_versions,
  abos.posting_approvals TO abos_v1_operational_finance_owner;
GRANT SELECT ON abos.shareholder_contributions,abos.shareholder_profiles,
  abos.business_parties,abos.evidence_references TO abos_v1_operational_finance_owner;
GRANT SELECT (requires_project,requires_department,requires_cost_center)
  ON abos.ledger_accounts TO abos_v1_operational_finance_owner;
GRANT SELECT (currency_policy_status)
  ON abos.legal_entities TO abos_v1_operational_finance_owner;
GRANT INSERT (id,legal_entity_id,version,paid_in_capital_ledger_account_id,evidence_reference_id,
  change_reason,configured_by_user_account_id,correlation_id,idempotency_key,request_fingerprint)
  ON abos.shareholder_capital_account_mapping_versions TO abos_v1_operational_finance_owner;
GRANT INSERT (id,legal_entity_id,project_id,department_id,cost_center_id,source_type,source_id,
  intent_kind,original_amount,original_currency_code,base_amount,base_currency_code,
  conversion_snapshot_reference,accounting_effective_date,correlation_id,idempotency_key,status,
  created_by_user_account_id,processing_model,operational_expense_id,shareholder_capital_receipt_id,
  finance_workflow_policy_version_id,shareholder_capital_account_mapping_version_id,operational_version)
  ON abos.posting_intents TO abos_v1_operational_finance_owner;
GRANT UPDATE (status,operational_version) ON abos.posting_intents TO abos_v1_operational_finance_owner;
GRANT INSERT (id,legal_entity_id,posting_intent_id,decision,decision_reason,
  approver_user_account_id,evidence_reference_id,approved_at,shareholder_capital_receipt_id)
  ON abos.posting_approvals TO abos_v1_operational_finance_owner;
GRANT INSERT (id,legal_entity_id,journal_line_id,subledger_type,business_party_id,
  operational_treasury_account_id,original_amount,original_currency_code,base_amount,
  base_currency_code,source_type,source_id,processing_model,shareholder_capital_receipt_id)
  ON abos.subledger_entries TO abos_v1_operational_finance_owner;

ALTER FUNCTION abos.shareholder_capital_actor(text,text,text,text) OWNER TO abos_v1_shareholder_capital_owner;
ALTER FUNCTION abos.guard_bound_shareholder_contribution() OWNER TO abos_v1_shareholder_capital_owner;
ALTER FUNCTION abos.shareholder_capital_idempotency_begin(text,text,text,uuid) OWNER TO abos_v1_shareholder_capital_owner;
ALTER FUNCTION abos.shareholder_capital_idempotency_complete(text,text,text,uuid,jsonb) OWNER TO abos_v1_shareholder_capital_owner;
ALTER FUNCTION abos.shareholder_capital_audit(uuid,uuid,uuid,text,text,uuid,jsonb) OWNER TO abos_v1_shareholder_capital_owner;
ALTER FUNCTION abos.shareholder_capital_receipt_json(uuid) OWNER TO abos_v1_shareholder_capital_owner;
ALTER FUNCTION abos.record_shareholder_capital_receipt(text,text,text,jsonb) OWNER TO abos_v1_shareholder_capital_owner;
ALTER FUNCTION abos.verify_shareholder_capital_receipt_custody(text,text,text,uuid,jsonb) OWNER TO abos_v1_shareholder_capital_owner;
ALTER FUNCTION abos.configure_shareholder_capital_mapping(text,text,text,jsonb) OWNER TO abos_v1_operational_finance_owner;
ALTER FUNCTION abos.prepare_shareholder_capital_posting(text,text,text,uuid,jsonb) OWNER TO abos_v1_operational_finance_owner;
ALTER FUNCTION abos.decide_shareholder_capital_posting(text,text,text,uuid,jsonb) OWNER TO abos_v1_operational_finance_owner;
ALTER FUNCTION abos.post_shareholder_capital_receipt(text,text,text,uuid,jsonb) OWNER TO abos_v1_operational_finance_owner;
ALTER FUNCTION abos.shareholder_capital_capability(text,text,text) OWNER TO abos_v1_operational_finance_owner;
ALTER FUNCTION abos.shareholder_capital_trace(text,text,text,uuid) OWNER TO abos_v1_operational_finance_owner;

GRANT EXECUTE ON FUNCTION abos.shareholder_capital_idempotency_begin(text,text,text,uuid),
  abos.shareholder_capital_idempotency_complete(text,text,text,uuid,jsonb),
  abos.shareholder_capital_audit(uuid,uuid,uuid,text,text,uuid,jsonb),
  abos.shareholder_capital_receipt_json(uuid)
TO abos_v1_operational_finance_owner;

REVOKE ALL ON FUNCTION abos.shareholder_capital_actor(text,text,text,text),
  abos.shareholder_contribution_finance_lock(uuid,uuid,integer),
  abos.shareholder_capital_idempotency_begin(text,text,text,uuid),
  abos.shareholder_capital_idempotency_complete(text,text,text,uuid,jsonb),
  abos.shareholder_capital_audit(uuid,uuid,uuid,text,text,uuid,jsonb),
  abos.shareholder_capital_receipt_json(uuid),
  abos.record_shareholder_capital_receipt(text,text,text,jsonb),
  abos.verify_shareholder_capital_receipt_custody(text,text,text,uuid,jsonb),
  abos.configure_shareholder_capital_mapping(text,text,text,jsonb),
  abos.prepare_shareholder_capital_posting(text,text,text,uuid,jsonb),
  abos.decide_shareholder_capital_posting(text,text,text,uuid,jsonb),
  abos.post_shareholder_capital_receipt(text,text,text,uuid,jsonb),
  abos.shareholder_capital_capability(text,text,text),
  abos.shareholder_capital_trace(text,text,text,uuid),
  abos.validate_operational_capital_journal_posting(),
  abos.guard_bound_shareholder_contribution(),
  abos.guard_posting_approval_processing_model(),
  abos.guard_operational_capital_approval_immutability()
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
  abos.record_shareholder_capital_receipt(text,text,text,jsonb),
  abos.verify_shareholder_capital_receipt_custody(text,text,text,uuid,jsonb)
TO abos_e1_treasury_runtime;
GRANT EXECUTE ON FUNCTION
  abos.configure_shareholder_capital_mapping(text,text,text,jsonb),
  abos.prepare_shareholder_capital_posting(text,text,text,uuid,jsonb),
  abos.decide_shareholder_capital_posting(text,text,text,uuid,jsonb),
  abos.post_shareholder_capital_receipt(text,text,text,uuid,jsonb),
  abos.shareholder_capital_capability(text,text,text),
  abos.shareholder_capital_trace(text,text,text,uuid)
TO abos_e1_runtime;
GRANT EXECUTE ON FUNCTION
  abos.shareholder_capital_capability(text,text,text),
  abos.shareholder_capital_trace(text,text,text,uuid)
TO abos_e1_treasury_runtime;

REVOKE ALL ON abos.shareholder_capital_receipts,
  abos.shareholder_capital_receipt_custody_verifications,
  abos.shareholder_capital_account_mapping_versions
FROM PUBLIC,abos_v1_identity_runtime,abos_e1_runtime,abos_e1_treasury_runtime;







-- Preserve the complete Operational Expense validator and dispatch typed capital to its validator.
CREATE OR REPLACE FUNCTION abos.validate_operational_journal_posting()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $validate$
DECLARE
  intent_row abos.posting_intents%ROWTYPE;
  expense_row abos.operational_expenses%ROWTYPE;
  treasury_row abos.operational_treasury_accounts%ROWTYPE;
  category_row abos.operational_expense_categories%ROWTYPE;
  policy_row abos.finance_workflow_policy_versions%ROWTYPE;
  period_row record;
  entity_base text;
  snapshot_row abos.exchange_rate_snapshots%ROWTYPE;
  line_count bigint;
  debit_total numeric;
  credit_total numeric;
  approval_count bigint;
  treasury_subledger_count bigint;
BEGIN
  IF TG_OP = 'INSERT' AND NEW.status = 'POSTED' THEN
    RAISE EXCEPTION 'operational journals must be assembled as draft before posting'
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'POSTED' THEN
    RAISE EXCEPTION 'a posted operational journal is immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status <> 'POSTED' THEN RETURN NEW; END IF;

  SELECT * INTO intent_row FROM abos.posting_intents
   WHERE id = NEW.posting_intent_id AND legal_entity_id = NEW.legal_entity_id;
  IF FOUND AND intent_row.processing_model = 'OPERATIONAL_V1'
     AND intent_row.source_type = 'SHAREHOLDER_CAPITAL_CONTRIBUTION_RECEIPT' THEN
    RETURN NEW;
  END IF;
  IF NOT FOUND OR intent_row.processing_model <> 'OPERATIONAL_V1'
     OR intent_row.intent_kind <> 'EXPENSE' OR intent_row.status <> 'POSTED'
     OR intent_row.base_amount IS NULL
     OR intent_row.base_currency_code IS DISTINCT FROM NEW.base_currency_code THEN
    RAISE EXCEPTION 'operational posting requires a posted valued EXPENSE intent'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO expense_row FROM abos.operational_expenses
   WHERE id = intent_row.operational_expense_id AND legal_entity_id = NEW.legal_entity_id;
  IF NOT FOUND OR expense_row.id IS DISTINCT FROM intent_row.source_id
     OR expense_row.status <> 'POSTED' OR expense_row.journal_id IS DISTINCT FROM NEW.id
     OR expense_row.original_amount IS DISTINCT FROM intent_row.original_amount
     OR expense_row.original_currency_code IS DISTINCT FROM intent_row.original_currency_code
     OR expense_row.base_amount IS DISTINCT FROM intent_row.base_amount
     OR expense_row.base_currency_code IS DISTINCT FROM intent_row.base_currency_code
     OR expense_row.business_date IS DISTINCT FROM NEW.accounting_effective_date THEN
    RAISE EXCEPTION 'operational expense, intent and journal do not agree'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO policy_row FROM abos.finance_workflow_policy_versions
   WHERE id = expense_row.workflow_policy_version_id
     AND legal_entity_id = NEW.legal_entity_id AND workflow_type = 'EXPENSE';
  IF NOT FOUND OR policy_row.approval_required IS DISTINCT FROM expense_row.approval_required THEN
    RAISE EXCEPTION 'operational expense approval route does not match its immutable policy snapshot'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*) INTO approval_count FROM abos.operational_expense_approvals approval
   WHERE approval.operational_expense_id = expense_row.id
     AND approval.legal_entity_id = NEW.legal_entity_id
     AND approval.decision = 'APPROVED'
     AND approval.approver_user_account_id = NEW.posted_by_user_account_id;
  IF expense_row.approval_required THEN
    IF approval_count <> 1
       OR NEW.posted_by_user_account_id = expense_row.created_by_user_account_id THEN
      RAISE EXCEPTION 'approval-required expense must be posted by its independent approver'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF approval_count <> 0
        OR NEW.posted_by_user_account_id IS DISTINCT FROM expense_row.created_by_user_account_id THEN
    RAISE EXCEPTION 'direct-posting expense must have no approval and be posted by its creator'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT status, starts_on, ends_on INTO period_row FROM abos.accounting_periods
   WHERE id = NEW.accounting_period_id AND legal_entity_id = NEW.legal_entity_id;
  IF NOT FOUND OR period_row.status <> 'OPEN'
     OR NEW.accounting_effective_date NOT BETWEEN period_row.starts_on AND period_row.ends_on THEN
    RAISE EXCEPTION 'operational posting requires an open accounting period covering its date'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT base_currency_code INTO entity_base FROM abos.legal_entities
   WHERE id = NEW.legal_entity_id AND currency_policy_status = 'APPROVED';
  IF entity_base IS NULL OR entity_base IS DISTINCT FROM NEW.base_currency_code THEN
    RAISE EXCEPTION 'operational posting requires the approved legal-entity base currency'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO treasury_row FROM abos.operational_treasury_accounts
   WHERE id = expense_row.operational_treasury_account_id
     AND legal_entity_id = NEW.legal_entity_id AND status = 'ACTIVE';
  SELECT * INTO category_row FROM abos.operational_expense_categories
   WHERE id = expense_row.operational_expense_category_id
     AND legal_entity_id = NEW.legal_entity_id AND status = 'ACTIVE';
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
       AND legal_entity_id = NEW.legal_entity_id
       AND source_type = 'OPERATIONAL_EXPENSE' AND source_id = expense_row.id;
    IF NOT FOUND OR snapshot_row.transaction_currency_code <> expense_row.original_currency_code
       OR snapshot_row.base_currency_code <> expense_row.base_currency_code
       OR snapshot_row.rate_date <> expense_row.business_date
       OR intent_row.conversion_snapshot_reference IS DISTINCT FROM snapshot_row.id::text THEN
      RAISE EXCEPTION 'foreign-currency expense requires its exact immutable rate snapshot'
        USING ERRCODE = 'check_violation';
    END IF;
    IF snapshot_row.unit_currency_code = expense_row.original_currency_code
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

  SELECT count(*), coalesce(sum(base_debit), 0), coalesce(sum(base_credit), 0)
    INTO line_count, debit_total, credit_total FROM abos.journal_lines
   WHERE journal_id = NEW.id;
  IF line_count <> 2 OR debit_total <> credit_total
     OR debit_total <> expense_row.base_amount THEN
    RAISE EXCEPTION 'expense journal must contain exactly two lines balanced to its base amount'
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
      OR line.original_amount <> expense_row.original_amount
      OR line.original_currency_code <> expense_row.original_currency_code
      OR line.conversion_snapshot_reference IS DISTINCT FROM intent_row.conversion_snapshot_reference
      OR ledger.status <> 'ACTIVE' OR NOT ledger.posting_allowed
      OR (ledger.requires_project AND line.project_id IS NULL)
      OR (ledger.requires_department AND line.department_id IS NULL)
      OR (ledger.requires_cost_center AND line.cost_center_id IS NULL)
    )) THEN
    RAISE EXCEPTION 'operational journal line violates entity, currency, account or dimension rules'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM abos.journal_lines line WHERE line.journal_id = NEW.id
      AND line.line_number = 1 AND line.ledger_account_id = category_row.ledger_account_id
      AND line.base_debit = expense_row.base_amount AND line.base_credit = 0
      AND line.project_id IS NOT DISTINCT FROM expense_row.project_id
      AND line.department_id IS NOT DISTINCT FROM expense_row.department_id
      AND line.cost_center_id IS NOT DISTINCT FROM expense_row.cost_center_id
      AND line.business_party_id IS NOT DISTINCT FROM expense_row.payee_business_party_id
  ) OR NOT EXISTS (
    SELECT 1 FROM abos.journal_lines line WHERE line.journal_id = NEW.id
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
   WHERE line.journal_id = NEW.id
     AND entry.processing_model = 'OPERATIONAL_V1'
     AND entry.subledger_type = 'OPERATIONAL_TREASURY'
     AND entry.operational_treasury_account_id = treasury_row.id
     AND entry.original_amount = -expense_row.original_amount
     AND entry.original_currency_code = expense_row.original_currency_code
     AND entry.base_amount = -expense_row.base_amount
     AND entry.base_currency_code = expense_row.base_currency_code
     AND entry.source_type = 'OPERATIONAL_EXPENSE' AND entry.source_id = expense_row.id;
  IF treasury_subledger_count <> 1 OR EXISTS (
    SELECT 1 FROM abos.subledger_entries entry
    JOIN abos.journal_lines line ON line.id = entry.journal_line_id
    WHERE line.journal_id = NEW.id AND (
      entry.processing_model <> 'OPERATIONAL_V1'
      OR entry.subledger_type <> 'OPERATIONAL_TREASURY'
      OR line.line_number <> 2)
  ) THEN
    RAISE EXCEPTION 'expense journal requires exactly one matching Treasury subledger movement'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$validate$;
