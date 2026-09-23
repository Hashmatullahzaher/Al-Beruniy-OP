-- Restricted E1 synthetic-capital posting boundary.
-- The runtime role receives EXECUTE on one function and no direct table privileges.

ALTER TABLE abos.sandbox_sessions
  ADD COLUMN runtime_token_sha256 text
  CHECK (runtime_token_sha256 IS NULL OR runtime_token_sha256 ~ '^[0-9a-f]{64}$');
CREATE UNIQUE INDEX sandbox_sessions_runtime_token_sha256_idx
  ON abos.sandbox_sessions(runtime_token_sha256)
  WHERE runtime_token_sha256 IS NOT NULL;

CREATE OR REPLACE FUNCTION abos.post_synthetic_capital_receipt(
  p_bearer_token text,
  p_posting_intent_id uuid,
  p_accounting_period_id uuid
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $secure_post$
DECLARE
  session_row record;
  gate_row record;
  intent_row record;
  source_row record;
  receipt_row record;
  approval_row record;
  cash_ledger_id uuid;
  capital_ledger_id uuid;
  cash_count bigint;
  capital_count bigint;
  existing_journal_id uuid;
  journal_id uuid := gen_random_uuid();
  debit_line_id uuid := gen_random_uuid();
  credit_line_id uuid := gen_random_uuid();
BEGIN
  IF p_bearer_token IS NULL OR length(p_bearer_token) < 32 THEN
    RAISE EXCEPTION 'valid sandbox bearer credential required'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT s.id, s.user_account_id, s.legal_entity_id, s.expires_at, s.revoked_at,
         u.status AS user_status
    INTO session_row
    FROM abos.sandbox_sessions s
    JOIN abos.user_accounts u ON u.id = s.user_account_id
   WHERE s.runtime_token_sha256 =
         encode(pg_catalog.sha256(convert_to(p_bearer_token, 'UTF8')), 'hex')
   FOR SHARE OF s, u;
  IF NOT FOUND OR session_row.revoked_at IS NOT NULL
     OR session_row.expires_at <= clock_timestamp()
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
     OR gate_row.real_posting_enabled OR gate_row.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'synthetic sandbox authorization is not active'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT pi.*, cri.request_fingerprint
    INTO intent_row
    FROM abos.posting_intents pi
    JOIN abos.capital_receipt_intents cri
      ON cri.id = pi.capital_receipt_intent_id
     AND cri.legal_entity_id = pi.legal_entity_id
   WHERE pi.id = p_posting_intent_id
   FOR UPDATE OF pi;
  IF NOT FOUND OR intent_row.legal_entity_id <> session_row.legal_entity_id
     OR intent_row.intent_kind <> 'SHAREHOLDER_CAPITAL_RECEIPT'
     OR intent_row.status <> 'APPROVED'
     OR intent_row.original_currency_code <> 'USD'
     OR intent_row.base_currency_code <> 'USD'
     OR intent_row.original_amount <> intent_row.base_amount THEN
    RAISE EXCEPTION 'posting intent is not an approved same-currency synthetic USD capital receipt';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM abos.sandbox_legal_entity_scopes
     WHERE legal_entity_id = intent_row.legal_entity_id
       AND base_currency_code = intent_row.base_currency_code
     FOR SHARE
  ) THEN
    RAISE EXCEPTION 'legal entity is outside the synthetic sandbox scope'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM abos.user_permission_grants
     WHERE user_account_id = session_row.user_account_id
       AND legal_entity_id = intent_row.legal_entity_id
       AND permission_code = 'finance.journal.post' AND revoked_at IS NULL
     FOR SHARE
  ) OR NOT EXISTS (
    SELECT 1 FROM abos.user_permission_grants
     WHERE user_account_id = session_row.user_account_id
       AND legal_entity_id = intent_row.legal_entity_id
       AND permission_code = 'finance.posting-intent.approve' AND revoked_at IS NULL
     FOR SHARE
  ) THEN
    RAISE EXCEPTION 'current Finance posting authority is missing'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (intent_row.project_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM abos.user_scope_grants WHERE user_account_id = session_row.user_account_id
          AND legal_entity_id = intent_row.legal_entity_id AND scope_kind = 'PROJECT'
          AND scope_id = intent_row.project_id AND revoked_at IS NULL FOR SHARE))
     OR (intent_row.department_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM abos.user_scope_grants WHERE user_account_id = session_row.user_account_id
          AND legal_entity_id = intent_row.legal_entity_id AND scope_kind = 'DEPARTMENT'
          AND scope_id = intent_row.department_id AND revoked_at IS NULL FOR SHARE))
     OR (intent_row.cost_center_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM abos.user_scope_grants WHERE user_account_id = session_row.user_account_id
          AND legal_entity_id = intent_row.legal_entity_id AND scope_kind = 'COST_CENTER'
          AND scope_id = intent_row.cost_center_id AND revoked_at IS NULL FOR SHARE)) THEN
    RAISE EXCEPTION 'current Finance dimension authority is missing'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT * INTO approval_row
    FROM abos.posting_approvals
   WHERE posting_intent_id = intent_row.id
     AND legal_entity_id = intent_row.legal_entity_id
     AND decision = 'APPROVED'
     AND approver_user_account_id = session_row.user_account_id
   FOR SHARE;
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM abos.evidence_references er
     WHERE er.id = approval_row.evidence_reference_id
       AND er.legal_entity_id = intent_row.legal_entity_id
       AND er.evidence_kind = 'FINANCE_APPROVAL'
       AND er.completed_at IS NOT NULL
     FOR SHARE
  ) THEN
    RAISE EXCEPTION 'current actor has no completed independent Finance approval';
  END IF;

  SELECT j.id INTO existing_journal_id FROM abos.journals j
   WHERE j.posting_intent_id = intent_row.id AND j.status = 'POSTED';
  IF FOUND THEN RETURN existing_journal_id; END IF;

  SELECT * INTO source_row FROM abos.capital_receipt_intents
   WHERE id = intent_row.capital_receipt_intent_id
     AND legal_entity_id = intent_row.legal_entity_id FOR UPDATE;
  SELECT * INTO receipt_row FROM abos.cash_receipts
   WHERE id = intent_row.treasury_cash_receipt_id
     AND legal_entity_id = intent_row.legal_entity_id FOR SHARE;
  IF source_row.status <> 'TREASURY_VERIFIED' OR receipt_row.status <> 'VERIFIED'
     OR source_row.treasury_cash_receipt_id <> receipt_row.id
     OR receipt_row.capital_installment_id <> source_row.capital_installment_id
     OR receipt_row.cash_location_currency_account_id <> source_row.destination_cash_account_id
     OR receipt_row.amount <> source_row.amount OR receipt_row.currency_code <> source_row.currency_code
     OR source_row.amount <> intent_row.base_amount OR source_row.currency_code <> intent_row.base_currency_code THEN
    RAISE EXCEPTION 'persisted capital source and verified Treasury receipt do not match';
  END IF;
  IF session_row.user_account_id IN (
    intent_row.created_by_user_account_id,
    receipt_row.received_by_user_account_id,
    (SELECT counted_by_user_account_id FROM abos.physical_cash_counts
      WHERE id = receipt_row.physical_cash_count_id)
  ) THEN
    RAISE EXCEPTION 'posting actor violates segregation of duties';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM abos.accounting_periods ap
     WHERE ap.id = p_accounting_period_id AND ap.legal_entity_id = intent_row.legal_entity_id
       AND ap.status = 'OPEN'
       AND intent_row.accounting_effective_date BETWEEN ap.starts_on AND ap.ends_on
     FOR SHARE
  ) THEN
    RAISE EXCEPTION 'open accounting period does not cover the posting date';
  END IF;

  SELECT ca.ledger_account_id INTO cash_ledger_id
    FROM abos.cash_location_currency_accounts ca
   WHERE ca.id = receipt_row.cash_location_currency_account_id
     AND ca.legal_entity_id = intent_row.legal_entity_id
     AND ca.activation_status = 'ACTIVE'
   FOR SHARE;
  SELECT count(*) INTO capital_count
    FROM abos.ledger_accounts
   WHERE legal_entity_id = intent_row.legal_entity_id
     AND control_account_type = 'SHAREHOLDER_CAPITAL'
     AND posting_allowed AND status = 'ACTIVE'
     AND account_currency_code = intent_row.base_currency_code;
  SELECT id INTO capital_ledger_id FROM abos.ledger_accounts
   WHERE legal_entity_id = intent_row.legal_entity_id
     AND control_account_type = 'SHAREHOLDER_CAPITAL'
     AND posting_allowed AND status = 'ACTIVE'
     AND account_currency_code = intent_row.base_currency_code
   ORDER BY id LIMIT 1;
  SELECT count(*) INTO cash_count FROM abos.ledger_accounts
   WHERE id = cash_ledger_id AND legal_entity_id = intent_row.legal_entity_id
     AND control_account_type = 'CASH' AND posting_allowed AND status = 'ACTIVE';
  IF cash_count <> 1 OR capital_count <> 1 THEN
    RAISE EXCEPTION 'synthetic ledger mapping must resolve exactly one cash and capital account';
  END IF;

  PERFORM set_config('abos.runtime_marker', gate_row.runtime_marker, true);
  INSERT INTO abos.journals
    (id, legal_entity_id, accounting_period_id, posting_intent_id, journal_reference,
     accounting_effective_date, base_currency_code, status, created_by_user_account_id)
  VALUES
    (journal_id, intent_row.legal_entity_id, p_accounting_period_id, intent_row.id,
     'JRN-' || journal_id::text, intent_row.accounting_effective_date,
     intent_row.base_currency_code, 'DRAFT', session_row.user_account_id);
  INSERT INTO abos.journal_lines
    (id, journal_id, legal_entity_id, line_number, ledger_account_id, project_id, department_id,
     cost_center_id, original_amount, original_currency_code, base_debit, base_credit,
     base_currency_code, source_type, source_id)
  VALUES
    (debit_line_id, journal_id, intent_row.legal_entity_id, 1, cash_ledger_id,
     intent_row.project_id, intent_row.department_id, intent_row.cost_center_id,
     intent_row.original_amount, intent_row.original_currency_code, intent_row.base_amount, 0,
     intent_row.base_currency_code, intent_row.source_type, intent_row.source_id),
    (credit_line_id, journal_id, intent_row.legal_entity_id, 2, capital_ledger_id,
     intent_row.project_id, intent_row.department_id, intent_row.cost_center_id,
     intent_row.original_amount, intent_row.original_currency_code, 0, intent_row.base_amount,
     intent_row.base_currency_code, intent_row.source_type, intent_row.source_id);
  UPDATE abos.journal_lines SET business_party_id = source_row.shareholder_business_party_id
   WHERE id = credit_line_id;
  INSERT INTO abos.subledger_entries
    (id, legal_entity_id, journal_line_id, subledger_type, cash_location_currency_account_id,
     original_amount, original_currency_code, base_amount, base_currency_code, source_type, source_id)
  VALUES
    (gen_random_uuid(), intent_row.legal_entity_id, debit_line_id, 'CASH_LOCATION',
     receipt_row.cash_location_currency_account_id, intent_row.original_amount,
     intent_row.original_currency_code, intent_row.base_amount, intent_row.base_currency_code,
     intent_row.source_type, intent_row.source_id);
  INSERT INTO abos.subledger_entries
    (id, legal_entity_id, journal_line_id, subledger_type, business_party_id,
     original_amount, original_currency_code, base_amount, base_currency_code, source_type, source_id)
  VALUES
    (gen_random_uuid(), intent_row.legal_entity_id, credit_line_id, 'SHAREHOLDER_CAPITAL',
     source_row.shareholder_business_party_id, -intent_row.original_amount,
     intent_row.original_currency_code, -intent_row.base_amount, intent_row.base_currency_code,
     intent_row.source_type, intent_row.source_id);
  UPDATE abos.journals SET status = 'POSTED',
    posted_by_user_account_id = session_row.user_account_id, posted_at = clock_timestamp()
   WHERE id = journal_id;

  INSERT INTO abos.idempotency_records
    (scope, idempotency_key, request_fingerprint, correlation_id, status, resource_type,
     resource_id, response_code, completed_at)
  VALUES
    (intent_row.legal_entity_id::text || ':POST_CAPITAL_RECEIPT', intent_row.idempotency_key,
     intent_row.request_fingerprint, intent_row.correlation_id, 'COMPLETED', 'JOURNAL',
     journal_id, 200, clock_timestamp());
  INSERT INTO abos.audit_records
    (id, actor_user_account_id, legal_entity_id, correlation_id, action, entity_type,
     entity_id, after_state)
  VALUES
    (gen_random_uuid(), session_row.user_account_id, intent_row.legal_entity_id,
     intent_row.correlation_id, 'FINANCE_JOURNAL_POSTED', 'JOURNAL', journal_id,
     jsonb_build_object('journalId', journal_id, 'postingIntentId', intent_row.id,
                        'syntheticOnly', true, 'path', 'restricted-security-definer'));
  INSERT INTO abos.outbox_events
    (id, aggregate_type, aggregate_id, event_type, event_version, legal_entity_id,
     actor_user_account_id, correlation_id, payload, occurred_at)
  VALUES
    (gen_random_uuid(), 'JOURNAL', journal_id, 'finance.journal.posted', 1,
     intent_row.legal_entity_id, session_row.user_account_id, intent_row.correlation_id,
     jsonb_build_object('journalId', journal_id, 'sourceId', intent_row.source_id),
     clock_timestamp());
  RETURN journal_id;
END;
$secure_post$;

REVOKE ALL ON FUNCTION abos.post_synthetic_capital_receipt(text, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA abos FROM abos_e1_runtime;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA abos FROM abos_e1_runtime;
GRANT USAGE ON SCHEMA abos TO abos_e1_runtime;
GRANT EXECUTE ON FUNCTION abos.post_synthetic_capital_receipt(text, uuid, uuid) TO abos_e1_runtime;

COMMENT ON FUNCTION abos.post_synthetic_capital_receipt(text, uuid, uuid) IS
  'Synthetic E1 only. Authenticates opaque session token and posts one approved USD capital receipt atomically.';

-- This existing deferred trigger runs at COMMIT, after the SECURITY DEFINER call has returned.
-- Give only its fixed, schema-qualified integrity query owner rights; runtime receives no EXECUTE.
ALTER FUNCTION abos.require_posted_reversal_link() SECURITY DEFINER;
ALTER FUNCTION abos.require_posted_reversal_link() SET search_path = pg_catalog;
REVOKE ALL ON FUNCTION abos.require_posted_reversal_link() FROM PUBLIC;
