-- Restricted E1 Treasury boundary. The application role can execute only these
-- authenticated entry points and has no direct access to Treasury or session tables.

ALTER TABLE abos.user_permission_grants
  DROP CONSTRAINT user_permission_grants_permission_code_check;
ALTER TABLE abos.user_permission_grants
  ADD CONSTRAINT user_permission_grants_permission_code_check CHECK (permission_code IN (
    'finance.posting-intent.create',
    'finance.posting-intent.approve',
    'finance.journal.post',
    'finance.journal.reverse',
    'finance.report.operational.read',
    'shareholder.capital-intent.create',
    'treasury.read',
    'treasury.cash-location.manage',
    'treasury.cash-account.reconcile',
    'treasury.cash-account.approve',
    'treasury.cash-receipt.record',
    'treasury.cash-count.record',
    'treasury.cash-receipt.verify',
    'treasury.handoff.create'));

-- Evidence must be provisioned by a trusted ingestion path before Treasury can use it.
-- The restricted runtime cannot insert, update or delete these bindings.
CREATE TABLE abos.treasury_evidence_bindings (
  evidence_reference_id uuid PRIMARY KEY,
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  capital_receipt_intent_id uuid NOT NULL,
  evidence_role text NOT NULL CHECK (evidence_role IN ('PHYSICAL_CASH_COUNT', 'CASH_RECEIPT')),
  bound_by_user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  bound_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (evidence_reference_id, legal_entity_id)
    REFERENCES abos.evidence_references(id, legal_entity_id),
  FOREIGN KEY (capital_receipt_intent_id, legal_entity_id)
    REFERENCES abos.capital_receipt_intents(id, legal_entity_id)
);

CREATE OR REPLACE FUNCTION abos.prevent_treasury_evidence_binding_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $binding_final$
BEGIN
  RAISE EXCEPTION 'Treasury evidence bindings are append-only';
END
$binding_final$;
CREATE TRIGGER treasury_evidence_bindings_no_update_or_delete
BEFORE UPDATE OR DELETE ON abos.treasury_evidence_bindings
FOR EACH ROW EXECUTE FUNCTION abos.prevent_treasury_evidence_binding_mutation();

CREATE OR REPLACE FUNCTION abos.require_bound_treasury_receipt_evidence()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $binding_guard$
DECLARE count_evidence_id uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status = 'DRAFT' AND NEW.status = 'COUNTED' THEN
    SELECT evidence_reference_id INTO count_evidence_id
      FROM abos.physical_cash_counts
     WHERE id = NEW.physical_cash_count_id
       AND legal_entity_id = NEW.legal_entity_id;
    IF count_evidence_id IS NULL
       OR NOT EXISTS (
         SELECT 1 FROM abos.treasury_evidence_bindings b
          WHERE b.evidence_reference_id = count_evidence_id
            AND b.legal_entity_id = NEW.legal_entity_id
            AND b.capital_receipt_intent_id = NEW.capital_receipt_intent_id
            AND b.evidence_role = 'PHYSICAL_CASH_COUNT')
       OR NOT EXISTS (
         SELECT 1 FROM abos.treasury_evidence_bindings b
          WHERE b.evidence_reference_id = NEW.evidence_reference_id
            AND b.legal_entity_id = NEW.legal_entity_id
            AND b.capital_receipt_intent_id = NEW.capital_receipt_intent_id
            AND b.evidence_role = 'CASH_RECEIPT') THEN
      RAISE EXCEPTION 'Treasury receipt and count evidence must be prebound to this capital receipt intent';
    END IF;
  END IF;
  RETURN NEW;
END
$binding_guard$;
CREATE TRIGGER cash_receipts_evidence_binding_guard
BEFORE UPDATE ON abos.cash_receipts
FOR EACH ROW EXECUTE FUNCTION abos.require_bound_treasury_receipt_evidence();
REVOKE ALL ON FUNCTION abos.prevent_treasury_evidence_binding_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION abos.require_bound_treasury_receipt_evidence() FROM PUBLIC;

DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'abos_e1_treasury_runtime') THEN
    CREATE ROLE abos_e1_treasury_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
  ELSE
    ALTER ROLE abos_e1_treasury_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
  END IF;
END
$role$;

CREATE OR REPLACE FUNCTION abos.treasury_runtime_authorize(
  p_bearer_token text,
  p_legal_entity_id uuid,
  p_permission text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $authorize$
DECLARE
  session_row record;
  gate_row record;
BEGIN
  IF p_bearer_token IS NULL OR length(p_bearer_token) < 32 THEN
    RAISE EXCEPTION 'valid sandbox bearer credential required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_permission NOT IN (
    'treasury.read', 'treasury.cash-location.manage', 'treasury.cash-account.reconcile',
    'treasury.cash-account.approve', 'treasury.cash-receipt.record',
    'treasury.cash-count.record', 'treasury.cash-receipt.verify', 'treasury.handoff.create') THEN
    RAISE EXCEPTION 'unsupported Treasury permission' USING ERRCODE = 'insufficient_privilege';
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
     OR session_row.user_status <> 'ACTIVE'
     OR session_row.legal_entity_id <> p_legal_entity_id THEN
    RAISE EXCEPTION 'sandbox session is invalid, expired, revoked or out of scope'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT environment, configuration_state, real_posting_enabled, runtime_marker, expires_at
    INTO gate_row FROM abos.sandbox_authorizations WHERE singleton FOR SHARE;
  IF NOT FOUND OR gate_row.environment NOT IN ('development', 'test')
     OR gate_row.configuration_state <> 'SYNTHETIC_TEST_ONLY'
     OR gate_row.real_posting_enabled OR gate_row.expires_at <= pg_catalog.clock_timestamp()
     OR NOT EXISTS (SELECT 1 FROM abos.sandbox_legal_entity_scopes s
                     WHERE s.legal_entity_id = p_legal_entity_id FOR SHARE) THEN
    RAISE EXCEPTION 'synthetic Treasury sandbox authorization is not active'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM abos.user_permission_grants g
     WHERE g.user_account_id = session_row.user_account_id
       AND g.legal_entity_id = p_legal_entity_id
       AND g.permission_code = p_permission AND g.revoked_at IS NULL
     FOR SHARE
  ) THEN
    RAISE EXCEPTION 'current Treasury authority is missing' USING ERRCODE = 'insufficient_privilege';
  END IF;

  PERFORM pg_catalog.set_config('abos.actor_user_account_id', session_row.user_account_id::text, true);
  PERFORM pg_catalog.set_config('abos.runtime_marker', gate_row.runtime_marker, true);
  RETURN session_row.user_account_id;
END
$authorize$;

REVOKE ALL ON FUNCTION abos.treasury_runtime_authorize(text, uuid, text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION abos.treasury_secure_context(p_bearer_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $context$
DECLARE session_row record; permissions jsonb;
BEGIN
  IF p_bearer_token IS NULL OR pg_catalog.length(p_bearer_token) < 32 THEN
    RAISE EXCEPTION 'valid sandbox bearer credential required' USING ERRCODE='insufficient_privilege';
  END IF;
  SELECT session.id, session.user_account_id, session.legal_entity_id, session.expires_at,
         session.revoked_at, account.display_name, account.status AS user_status
    INTO session_row
    FROM abos.sandbox_sessions session
    JOIN abos.user_accounts account ON account.id=session.user_account_id
   WHERE session.runtime_token_sha256=
     pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_bearer_token,'UTF8')),'hex')
   FOR SHARE OF session, account;
  IF NOT FOUND OR session_row.revoked_at IS NOT NULL
     OR session_row.expires_at <= pg_catalog.clock_timestamp()
     OR session_row.user_status <> 'ACTIVE'
     OR NOT EXISTS (SELECT 1 FROM abos.sandbox_authorizations gate
       WHERE gate.singleton AND gate.environment IN ('development','test')
         AND gate.configuration_state='SYNTHETIC_TEST_ONLY' AND NOT gate.real_posting_enabled
         AND gate.expires_at > pg_catalog.clock_timestamp() FOR SHARE)
     OR NOT EXISTS (SELECT 1 FROM abos.sandbox_legal_entity_scopes scope
       WHERE scope.legal_entity_id=session_row.legal_entity_id FOR SHARE) THEN
    RAISE EXCEPTION 'sandbox session is invalid, expired, revoked or out of scope'
      USING ERRCODE='insufficient_privilege';
  END IF;
  SELECT coalesce(pg_catalog.jsonb_agg(grant_row.permission_code
           ORDER BY grant_row.permission_code),'[]'::jsonb)
    INTO permissions FROM abos.user_permission_grants grant_row
   WHERE grant_row.user_account_id=session_row.user_account_id
     AND grant_row.legal_entity_id=session_row.legal_entity_id
     AND grant_row.permission_code LIKE 'treasury.%' AND grant_row.revoked_at IS NULL;
  RETURN pg_catalog.jsonb_build_object(
    'sessionId',session_row.id,'userAccountId',session_row.user_account_id,
    'legalEntityId',session_row.legal_entity_id,'displayName',session_row.display_name,
    'expiresAt',session_row.expires_at,'treasuryPermissions',permissions);
END
$context$;

CREATE OR REPLACE FUNCTION abos.treasury_revoke_own_session(p_bearer_token text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $revoke$
DECLARE changed_count bigint;
BEGIN
  IF p_bearer_token IS NULL OR pg_catalog.length(p_bearer_token) < 32 THEN RETURN false; END IF;
  UPDATE abos.sandbox_sessions SET revoked_at=pg_catalog.clock_timestamp()
   WHERE runtime_token_sha256=
     pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_bearer_token,'UTF8')),'hex')
     AND revoked_at IS NULL;
  GET DIAGNOSTICS changed_count = ROW_COUNT;
  RETURN changed_count > 0;
END
$revoke$;

REVOKE ALL ON FUNCTION abos.treasury_secure_context(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION abos.treasury_revoke_own_session(text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION abos.treasury_secure_query(
  p_bearer_token text,
  p_legal_entity_id uuid,
  p_query text,
  p_object_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $query$
DECLARE result jsonb;
BEGIN
  PERFORM abos.treasury_runtime_authorize(p_bearer_token, p_legal_entity_id, 'treasury.read');
  CASE p_query
    WHEN 'LOCATIONS' THEN
      SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x) ORDER BY x.location_name), '[]'::jsonb)
        INTO result FROM (
          SELECT id, legal_entity_id, location_name, location_kind, status, responsible_cashier_user_account_id
            FROM abos.cash_locations WHERE legal_entity_id = p_legal_entity_id
              AND (p_object_id IS NULL OR id = p_object_id)) x;
    WHEN 'ACCOUNTS' THEN
      SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x) ORDER BY x.currency_code), '[]'::jsonb)
        INTO result FROM (
          SELECT id, legal_entity_id, cash_location_id, currency_code, ledger_account_id, activation_status,
                 reconciliation_evidence_reference_id, activated_by_user_account_id, activated_at
            FROM abos.cash_location_currency_accounts WHERE legal_entity_id = p_legal_entity_id
              AND (p_object_id IS NULL OR id = p_object_id OR cash_location_id = p_object_id)) x;
    WHEN 'ASSIGNMENTS' THEN
      SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x) ORDER BY x.assigned_at), '[]'::jsonb)
        INTO result FROM (
          SELECT id, legal_entity_id, cash_location_id, user_account_id,
                 assigned_by_user_account_id, assigned_at, revoked_at
            FROM abos.cash_location_cashier_assignments WHERE legal_entity_id = p_legal_entity_id
              AND (p_object_id IS NULL OR cash_location_id = p_object_id OR id = p_object_id)) x;
    WHEN 'OPENINGS' THEN
      SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x)), '[]'::jsonb)
        INTO result FROM (
          SELECT cash_location_currency_account_id, legal_entity_id, currency_code,
                 opening_counted_amount::text AS opening_counted_amount, physical_cash_count_id,
                 reconciliation_evidence_reference_id, reconciled_by_user_account_id,
                 approved_by_user_account_id, status
            FROM abos.cash_account_openings WHERE legal_entity_id = p_legal_entity_id
              AND (p_object_id IS NULL OR cash_location_currency_account_id = p_object_id)) x;
    WHEN 'COUNTS' THEN
      SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x) ORDER BY x.counted_at), '[]'::jsonb)
        INTO result FROM (
          SELECT id, legal_entity_id, cash_location_currency_account_id, currency_code,
                 counted_amount::text AS counted_amount, counted_at, counted_by_user_account_id,
                 evidence_reference_id, count_purpose, status,
                 confirmed_by_user_account_id, confirmed_at
            FROM abos.physical_cash_counts WHERE legal_entity_id = p_legal_entity_id
              AND (p_object_id IS NULL OR id = p_object_id)) x;
    WHEN 'SOURCES' THEN
      SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x) ORDER BY x.created_at DESC), '[]'::jsonb)
        INTO result FROM (
          SELECT source_row.id, source_row.legal_entity_id,
                 source_row.shareholder_business_party_id, party.display_name,
                 source_row.capital_agreement_id, agreement.agreement_reference,
                 source_row.capital_installment_id, installment.sequence_number,
                 source_row.amount::text AS amount, source_row.currency_code,
                 source_row.destination_cash_account_id, source_row.status,
                 source_row.treasury_cash_receipt_id, source_row.journal_id,
                 source_row.business_event_at, source_row.evidence_reference_id, source_row.created_at
            FROM abos.capital_receipt_intents source_row
            JOIN abos.business_parties party ON party.id=source_row.shareholder_business_party_id
              AND party.legal_entity_id=source_row.legal_entity_id
            JOIN abos.capital_agreements agreement ON agreement.id=source_row.capital_agreement_id
              AND agreement.legal_entity_id=source_row.legal_entity_id
            JOIN abos.capital_installments installment ON installment.id=source_row.capital_installment_id
              AND installment.legal_entity_id=source_row.legal_entity_id
           WHERE source_row.legal_entity_id = p_legal_entity_id
             AND (p_object_id IS NULL OR source_row.id = p_object_id)) x;
    WHEN 'RECEIPTS' THEN
      SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x) ORDER BY x.created_at DESC), '[]'::jsonb)
        INTO result FROM (
          SELECT receipt.id, receipt.legal_entity_id, receipt.capital_receipt_intent_id,
                 receipt.capital_installment_id, receipt.cash_location_currency_account_id,
                 account.cash_location_id, receipt.receipt_reference, receipt.amount::text AS amount,
                 receipt.currency_code, receipt.business_event_at, receipt.received_by_user_account_id,
                 receipt.physical_cash_count_id, receipt.evidence_reference_id,
                 receipt.submitted_for_verification_at, receipt.verified_by_user_account_id,
                 receipt.verified_at, receipt.void_reason, receipt.status, receipt.created_at
            FROM abos.cash_receipts receipt
            JOIN abos.cash_location_currency_accounts account
              ON account.id=receipt.cash_location_currency_account_id
             AND account.legal_entity_id=receipt.legal_entity_id
           WHERE receipt.legal_entity_id = p_legal_entity_id
             AND receipt.capital_receipt_intent_id IS NOT NULL
             AND (p_object_id IS NULL OR receipt.id = p_object_id)) x;
    WHEN 'HANDOFFS' THEN
      SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x) ORDER BY x.handed_off_at DESC), '[]'::jsonb)
        INTO result FROM (
          SELECT id, legal_entity_id, cash_receipt_id, capital_receipt_intent_id, handed_off_by_user_account_id,
                 handed_off_at, correlation_id, status
            FROM abos.treasury_finance_handoffs WHERE legal_entity_id = p_legal_entity_id
              AND (p_object_id IS NULL OR cash_receipt_id = p_object_id OR id = p_object_id)) x;
    WHEN 'CASH_LEDGER' THEN
      SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x)), '[]'::jsonb)
        INTO result FROM (
          SELECT id, account_currency_code FROM abos.ledger_accounts
           WHERE legal_entity_id=p_legal_entity_id AND control_account_type='CASH'
             AND status='ACTIVE' AND posting_allowed
             AND (p_object_id IS NULL OR id=p_object_id)) x;
    WHEN 'EVENTS' THEN
      SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x) ORDER BY x.occurred_at, x.id), '[]'::jsonb)
        INTO result FROM (
          SELECT event.id, event.aggregate_type, event.aggregate_id, event.operation,
                 event.from_status, event.to_status, event.actor_user_account_id,
                 actor.display_name, event.occurred_at
            FROM abos.treasury_events event
            JOIN abos.user_accounts actor ON actor.id=event.actor_user_account_id
           WHERE event.legal_entity_id=p_legal_entity_id) x;
    WHEN 'EVIDENCE' THEN
      SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x) ORDER BY x.evidence_kind, x.created_at), '[]'::jsonb)
        INTO result FROM (
          SELECT evidence.id, evidence.evidence_kind, evidence.document_id,
                 evidence.sha256, evidence.created_at, binding.capital_receipt_intent_id
            FROM abos.evidence_references evidence
            JOIN abos.treasury_evidence_bindings binding
              ON binding.evidence_reference_id=evidence.id
             AND binding.legal_entity_id=evidence.legal_entity_id
           WHERE evidence.legal_entity_id=p_legal_entity_id
             AND evidence.evidence_kind IN ('CASH_RECEIPT','PHYSICAL_CASH_COUNT')
             AND (p_object_id IS NULL OR evidence.id=p_object_id)) x;
    WHEN 'USERS' THEN
      SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x) ORDER BY x.display_name), '[]'::jsonb)
        INTO result FROM (
          SELECT DISTINCT account.id, account.display_name
            FROM abos.user_accounts account
            JOIN abos.user_permission_grants grant_row ON grant_row.user_account_id=account.id
           WHERE grant_row.legal_entity_id=p_legal_entity_id) x;
    WHEN 'FINANCE_PROGRESS' THEN
      SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x)), '[]'::jsonb)
        INTO result FROM (
          SELECT posting.status AS posting_intent_status,
                 coalesce(approval.decision, 'NONE') AS decision,
                 approval.approver_user_account_id AS decided_by_user_account_id,
                 approval.approved_at AS decided_at
            FROM abos.cash_receipts receipt
            LEFT JOIN abos.posting_intents posting
              ON posting.capital_receipt_intent_id=receipt.capital_receipt_intent_id
             AND posting.legal_entity_id=receipt.legal_entity_id
            LEFT JOIN abos.posting_approvals approval
              ON approval.posting_intent_id=posting.id AND approval.legal_entity_id=posting.legal_entity_id
           WHERE receipt.legal_entity_id=p_legal_entity_id AND receipt.id=p_object_id) x;
    ELSE
      RAISE EXCEPTION 'unsupported Treasury query';
  END CASE;
  RETURN result;
END
$query$;

CREATE OR REPLACE FUNCTION abos.treasury_secure_command(
  p_bearer_token text,
  p_legal_entity_id uuid,
  p_operation text,
  p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $command$
DECLARE
  actor uuid;
  required_permission text;
  source_row record;
  receipt_row record;
  count_row record;
  existing_handoff record;
  object_id uuid;
  count_id uuid;
BEGIN
  required_permission := CASE p_operation
    WHEN 'CREATE_LOCATION' THEN 'treasury.cash-location.manage'
    WHEN 'SET_LOCATION_STATUS' THEN 'treasury.cash-location.manage'
    WHEN 'OPEN_ACCOUNT' THEN 'treasury.cash-location.manage'
    WHEN 'ASSIGN_CASHIER' THEN 'treasury.cash-location.manage'
    WHEN 'REVOKE_CASHIER' THEN 'treasury.cash-location.manage'
    WHEN 'RECORD_COUNT' THEN 'treasury.cash-count.record'
    WHEN 'CONFIRM_OPENING_COUNT' THEN 'treasury.cash-account.approve'
    WHEN 'RECONCILE_OPENING' THEN 'treasury.cash-account.reconcile'
    WHEN 'APPROVE_OPENING' THEN 'treasury.cash-account.approve'
    WHEN 'ACTIVATE_ACCOUNT' THEN 'treasury.cash-account.approve'
    WHEN 'BLOCK_ACCOUNT' THEN 'treasury.cash-account.approve'
    WHEN 'RECORD_RECEIPT' THEN 'treasury.cash-receipt.record'
    WHEN 'COUNT_RECEIPT' THEN 'treasury.cash-count.record'
    WHEN 'SUBMIT_RECEIPT' THEN 'treasury.cash-receipt.record'
    WHEN 'VERIFY_RECEIPT' THEN 'treasury.cash-receipt.verify'
    WHEN 'VOID_RECEIPT' THEN 'treasury.read'
    WHEN 'HANDOFF_RECEIPT' THEN 'treasury.handoff.create'
    ELSE NULL END;
  IF required_permission IS NULL THEN
    RAISE EXCEPTION 'unsupported Treasury operation';
  END IF;
  actor := abos.treasury_runtime_authorize(p_bearer_token, p_legal_entity_id, required_permission);

  object_id := nullif(p_payload ->> 'id', '')::uuid;
  CASE p_operation
    WHEN 'CREATE_LOCATION' THEN
      INSERT INTO abos.cash_locations
        (id, legal_entity_id, location_name, responsible_cashier_user_account_id, status, location_kind)
      VALUES (object_id, p_legal_entity_id, p_payload ->> 'name',
              (p_payload ->> 'responsibleCashierUserAccountId')::uuid, 'DRAFT', 'OFFICE_SAFE');
    WHEN 'SET_LOCATION_STATUS' THEN
      UPDATE abos.cash_locations SET status = p_payload ->> 'status'
       WHERE legal_entity_id = p_legal_entity_id AND id = object_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'cash location not found'; END IF;
    WHEN 'OPEN_ACCOUNT' THEN
      INSERT INTO abos.cash_location_currency_accounts
        (id, legal_entity_id, cash_location_id, currency_code, ledger_account_id, activation_status)
      VALUES (object_id, p_legal_entity_id, (p_payload ->> 'cashLocationId')::uuid,
              p_payload ->> 'currency', (p_payload ->> 'ledgerAccountId')::uuid, 'DRAFT');
    WHEN 'ASSIGN_CASHIER' THEN
      INSERT INTO abos.cash_location_cashier_assignments
        (id, legal_entity_id, cash_location_id, user_account_id, assigned_by_user_account_id)
      VALUES (object_id, p_legal_entity_id, (p_payload ->> 'cashLocationId')::uuid,
              (p_payload ->> 'userAccountId')::uuid, actor);
    WHEN 'REVOKE_CASHIER' THEN
      UPDATE abos.cash_location_cashier_assignments
         SET revoked_at = pg_catalog.clock_timestamp(), revoked_by_user_account_id = actor
       WHERE legal_entity_id = p_legal_entity_id AND id = object_id AND revoked_at IS NULL;
      IF NOT FOUND THEN RAISE EXCEPTION 'active cashier assignment not found'; END IF;
    WHEN 'RECORD_COUNT' THEN
      INSERT INTO abos.physical_cash_counts
        (id, legal_entity_id, cash_location_currency_account_id, currency_code, counted_amount,
         counted_at, counted_by_user_account_id, evidence_reference_id, status, count_purpose)
      VALUES (object_id, p_legal_entity_id, (p_payload ->> 'cashAccountId')::uuid,
              p_payload ->> 'currency', (p_payload ->> 'countedAmount')::numeric,
              pg_catalog.clock_timestamp(), actor, (p_payload ->> 'evidenceReferenceId')::uuid,
              'RECORDED', p_payload ->> 'purpose');
    WHEN 'CONFIRM_OPENING_COUNT' THEN
      UPDATE abos.physical_cash_counts SET status = 'CONFIRMED',
             confirmed_by_user_account_id = actor, confirmed_at = pg_catalog.clock_timestamp()
       WHERE legal_entity_id = p_legal_entity_id AND id = object_id
         AND status = 'RECORDED' AND count_purpose = 'OPENING';
      IF NOT FOUND THEN RAISE EXCEPTION 'recorded opening count not found'; END IF;
    WHEN 'RECONCILE_OPENING' THEN
      INSERT INTO abos.cash_account_openings
        (cash_location_currency_account_id, legal_entity_id, currency_code, opening_counted_amount,
         physical_cash_count_id, reconciliation_evidence_reference_id, reconciled_by_user_account_id)
      VALUES (object_id, p_legal_entity_id, p_payload ->> 'currency',
              (p_payload ->> 'openingCountedAmount')::numeric,
              (p_payload ->> 'physicalCashCountId')::uuid,
              (p_payload ->> 'reconciliationEvidenceReferenceId')::uuid, actor);
      UPDATE abos.cash_location_currency_accounts SET activation_status = 'RECONCILED'
       WHERE legal_entity_id = p_legal_entity_id AND id = object_id AND activation_status = 'DRAFT';
      IF NOT FOUND THEN RAISE EXCEPTION 'draft cash account not found'; END IF;
    WHEN 'APPROVE_OPENING' THEN
      UPDATE abos.cash_account_openings SET status = 'APPROVED',
             approved_by_user_account_id = actor, approved_at = pg_catalog.clock_timestamp()
       WHERE legal_entity_id = p_legal_entity_id AND cash_location_currency_account_id = object_id
         AND status = 'RECONCILED';
      IF NOT FOUND THEN RAISE EXCEPTION 'reconciled opening not found'; END IF;
      UPDATE abos.cash_location_currency_accounts SET activation_status = 'APPROVED'
       WHERE legal_entity_id = p_legal_entity_id AND id = object_id AND activation_status = 'RECONCILED';
      IF NOT FOUND THEN RAISE EXCEPTION 'reconciled account not found'; END IF;
    WHEN 'ACTIVATE_ACCOUNT' THEN
      UPDATE abos.cash_location_currency_accounts SET activation_status = 'ACTIVE',
             activated_by_user_account_id = actor, activated_at = pg_catalog.clock_timestamp(),
             reconciliation_evidence_reference_id = (p_payload ->> 'evidenceReferenceId')::uuid
       WHERE legal_entity_id = p_legal_entity_id AND id = object_id AND activation_status = 'APPROVED';
      IF NOT FOUND THEN RAISE EXCEPTION 'approved cash account not found'; END IF;
    WHEN 'BLOCK_ACCOUNT' THEN
      UPDATE abos.cash_location_currency_accounts SET activation_status = 'BLOCKED'
       WHERE legal_entity_id = p_legal_entity_id AND id = object_id
         AND activation_status IN ('ACTIVE', 'APPROVED', 'RECONCILED');
      IF NOT FOUND THEN RAISE EXCEPTION 'blockable cash account not found'; END IF;
    WHEN 'RECORD_RECEIPT' THEN
      SELECT * INTO source_row FROM abos.capital_receipt_intents
       WHERE legal_entity_id = p_legal_entity_id
         AND id = (p_payload ->> 'capitalReceiptIntentId')::uuid FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'capital receipt source not found'; END IF;
      INSERT INTO abos.cash_receipts
        (id, legal_entity_id, capital_installment_id, capital_receipt_intent_id,
         cash_location_currency_account_id, receipt_reference, amount, currency_code,
         business_event_at, received_by_user_account_id, status)
      VALUES (object_id, p_legal_entity_id, source_row.capital_installment_id, source_row.id,
              source_row.destination_cash_account_id, p_payload ->> 'receiptReference',
              source_row.amount, source_row.currency_code,
              (p_payload ->> 'businessEventAt')::timestamptz, actor, 'DRAFT');
    WHEN 'COUNT_RECEIPT' THEN
      SELECT * INTO receipt_row FROM abos.cash_receipts
       WHERE legal_entity_id = p_legal_entity_id AND id = object_id FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'cash receipt not found'; END IF;
      count_id := (p_payload ->> 'countId')::uuid;
      INSERT INTO abos.physical_cash_counts
        (id, legal_entity_id, cash_location_currency_account_id, currency_code, counted_amount,
         counted_at, counted_by_user_account_id, evidence_reference_id, status, count_purpose)
      VALUES (count_id, p_legal_entity_id, receipt_row.cash_location_currency_account_id,
              receipt_row.currency_code, (p_payload ->> 'countedAmount')::numeric,
              pg_catalog.clock_timestamp(), actor,
              (p_payload ->> 'countEvidenceReferenceId')::uuid, 'RECORDED', 'RECEIPT');
      UPDATE abos.cash_receipts SET status = 'COUNTED', physical_cash_count_id = count_id,
             evidence_reference_id = (p_payload ->> 'receiptEvidenceReferenceId')::uuid
       WHERE legal_entity_id = p_legal_entity_id AND id = object_id AND status = 'DRAFT';
      IF NOT FOUND THEN RAISE EXCEPTION 'draft receipt not found'; END IF;
    WHEN 'SUBMIT_RECEIPT' THEN
      UPDATE abos.cash_receipts SET submitted_for_verification_at = pg_catalog.clock_timestamp()
       WHERE legal_entity_id = p_legal_entity_id AND id = object_id AND status = 'COUNTED'
         AND received_by_user_account_id = actor
         AND submitted_for_verification_at IS NULL;
      IF NOT FOUND THEN RAISE EXCEPTION 'counted receipt awaiting submission not found'; END IF;
    WHEN 'VERIFY_RECEIPT' THEN
      SELECT * INTO receipt_row FROM abos.cash_receipts
       WHERE legal_entity_id = p_legal_entity_id AND id = object_id FOR UPDATE;
      IF NOT FOUND OR receipt_row.physical_cash_count_id IS NULL THEN
        RAISE EXCEPTION 'counted receipt not found';
      END IF;
      UPDATE abos.physical_cash_counts SET status = 'CONFIRMED',
             confirmed_by_user_account_id = actor, confirmed_at = pg_catalog.clock_timestamp()
       WHERE legal_entity_id = p_legal_entity_id AND id = receipt_row.physical_cash_count_id
         AND status = 'RECORDED';
      IF NOT FOUND THEN RAISE EXCEPTION 'recorded receipt count not found'; END IF;
      UPDATE abos.cash_receipts SET status = 'VERIFIED', verified_by_user_account_id = actor,
             verified_at = pg_catalog.clock_timestamp()
       WHERE legal_entity_id = p_legal_entity_id AND id = object_id AND status = 'COUNTED';
      IF NOT FOUND THEN RAISE EXCEPTION 'counted receipt not found'; END IF;
    WHEN 'VOID_RECEIPT' THEN
      SELECT * INTO receipt_row FROM abos.cash_receipts
       WHERE legal_entity_id = p_legal_entity_id AND id = object_id FOR UPDATE;
      IF NOT FOUND OR receipt_row.status NOT IN ('DRAFT', 'COUNTED') THEN
        RAISE EXCEPTION 'voidable receipt not found';
      END IF;
      IF length(btrim(coalesce(p_payload ->> 'reason', ''))) < 5 THEN
        RAISE EXCEPTION 'void reason must contain at least five characters';
      END IF;
      IF receipt_row.received_by_user_account_id = actor THEN
        PERFORM abos.treasury_runtime_authorize(
          p_bearer_token, p_legal_entity_id, 'treasury.cash-receipt.record');
      ELSE
        PERFORM abos.treasury_runtime_authorize(
          p_bearer_token, p_legal_entity_id, 'treasury.cash-receipt.verify');
      END IF;
      UPDATE abos.cash_receipts SET status = 'VOIDED', voided_by_user_account_id = actor,
             voided_at = pg_catalog.clock_timestamp(), void_reason = p_payload ->> 'reason'
       WHERE legal_entity_id = p_legal_entity_id AND id = object_id AND status IN ('DRAFT', 'COUNTED');
      IF NOT FOUND THEN RAISE EXCEPTION 'voidable receipt not found'; END IF;
    WHEN 'HANDOFF_RECEIPT' THEN
      SELECT * INTO receipt_row FROM abos.cash_receipts
       WHERE legal_entity_id = p_legal_entity_id AND id = object_id FOR UPDATE;
      IF NOT FOUND OR receipt_row.status <> 'VERIFIED' THEN RAISE EXCEPTION 'verified receipt not found'; END IF;
      SELECT * INTO existing_handoff FROM abos.treasury_finance_handoffs
       WHERE cash_receipt_id = object_id;
      IF FOUND THEN
        IF existing_handoff.capital_receipt_intent_id <> receipt_row.capital_receipt_intent_id THEN
          RAISE EXCEPTION 'receipt has a conflicting Finance handoff';
        END IF;
        RETURN pg_catalog.jsonb_build_object('id', existing_handoff.id, 'replayed', true);
      END IF;
      UPDATE abos.capital_receipt_intents
         SET status = 'TREASURY_VERIFIED', contribution_state = 'VERIFIED',
             treasury_cash_receipt_id = receipt_row.id, version = version + 1,
             updated_at = pg_catalog.clock_timestamp()
       WHERE legal_entity_id = p_legal_entity_id AND id = receipt_row.capital_receipt_intent_id
         AND status = 'ELIGIBLE';
      IF NOT FOUND THEN RAISE EXCEPTION 'eligible capital receipt intent not found'; END IF;
      INSERT INTO abos.treasury_finance_handoffs
        (id, legal_entity_id, cash_receipt_id, capital_receipt_intent_id,
         handed_off_by_user_account_id, correlation_id)
      VALUES ((p_payload ->> 'handoffId')::uuid, p_legal_entity_id, receipt_row.id,
              receipt_row.capital_receipt_intent_id, actor, (p_payload ->> 'correlationId')::uuid);
      RETURN pg_catalog.jsonb_build_object('id', p_payload ->> 'handoffId', 'replayed', false);
  END CASE;
  RETURN pg_catalog.jsonb_build_object('id', object_id, 'operation', p_operation);
END
$command$;

REVOKE ALL ON FUNCTION abos.treasury_secure_query(text, uuid, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION abos.treasury_secure_command(text, uuid, text, jsonb) FROM PUBLIC;

-- Repair Claude finding R-3 for databases where 0006 was applied after 0007.
REVOKE ALL ON ALL TABLES IN SCHEMA abos FROM abos_e1_runtime;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA abos FROM abos_e1_runtime;

REVOKE ALL ON SCHEMA abos FROM abos_e1_treasury_runtime;
REVOKE ALL ON ALL TABLES IN SCHEMA abos FROM abos_e1_treasury_runtime;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA abos FROM abos_e1_treasury_runtime;
GRANT USAGE ON SCHEMA abos TO abos_e1_treasury_runtime;
GRANT EXECUTE ON FUNCTION abos.treasury_secure_query(text, uuid, text, uuid)
  TO abos_e1_treasury_runtime;
GRANT EXECUTE ON FUNCTION abos.treasury_secure_command(text, uuid, text, jsonb)
  TO abos_e1_treasury_runtime;
GRANT EXECUTE ON FUNCTION abos.treasury_secure_context(text) TO abos_e1_treasury_runtime;
GRANT EXECUTE ON FUNCTION abos.treasury_revoke_own_session(text) TO abos_e1_treasury_runtime;

COMMENT ON ROLE abos_e1_treasury_runtime IS
  'Restricted E1 Treasury role: authenticated Treasury query/command functions only; no direct relation access.';
