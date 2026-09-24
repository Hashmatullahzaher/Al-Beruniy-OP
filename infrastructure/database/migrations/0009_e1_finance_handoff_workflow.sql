-- Restricted E1 Finance handoff workflow.
--
-- The application runtime may inspect a session-scoped Treasury handoff, prepare a posting intent,
-- approve it as an independent Finance user, and invoke migration 0007's posting function. It never
-- receives table privileges and never supplies an actor, amount, account, source, evidence, or
-- journal line.

-- Approval evidence is ingested and bound before Finance approval. The application runtime can
-- neither create nor reassign this binding.
CREATE TABLE abos.finance_approval_evidence_bindings (
  evidence_reference_id uuid PRIMARY KEY,
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  capital_receipt_intent_id uuid NOT NULL,
  bound_by_user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  bound_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (evidence_reference_id, legal_entity_id)
    REFERENCES abos.evidence_references(id, legal_entity_id),
  FOREIGN KEY (capital_receipt_intent_id, legal_entity_id)
    REFERENCES abos.capital_receipt_intents(id, legal_entity_id),
  UNIQUE (capital_receipt_intent_id, legal_entity_id)
);

CREATE TRIGGER finance_approval_evidence_bindings_no_update_or_delete
BEFORE UPDATE OR DELETE ON abos.finance_approval_evidence_bindings
FOR EACH ROW EXECUTE FUNCTION abos.prevent_treasury_evidence_binding_mutation();

CREATE OR REPLACE FUNCTION abos.finance_runtime_authorize(
  p_bearer_token text,
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
  IF p_bearer_token IS NULL OR pg_catalog.length(p_bearer_token) < 32 THEN
    RAISE EXCEPTION 'valid sandbox bearer credential required'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_permission NOT IN (
    'finance.posting-intent.create', 'finance.posting-intent.approve',
    'finance.journal.post', 'finance.report.operational.read') THEN
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

REVOKE ALL ON FUNCTION abos.finance_runtime_authorize(text, text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION abos.finance_handoff_workspace(
  p_bearer_token text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $workspace$
DECLARE
  actor uuid;
  entity_id uuid;
  permissions jsonb;
  handoffs jsonb;
  periods jsonb;
BEGIN
  actor := abos.finance_runtime_authorize(p_bearer_token, 'finance.report.operational.read');
  entity_id := pg_catalog.current_setting('abos.finance_legal_entity_id')::uuid;

  SELECT coalesce(pg_catalog.jsonb_agg(g.permission_code ORDER BY g.permission_code), '[]'::jsonb)
    INTO permissions
    FROM abos.user_permission_grants g
   WHERE g.user_account_id = actor AND g.legal_entity_id = entity_id
     AND g.permission_code LIKE 'finance.%' AND g.revoked_at IS NULL;

  SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(row_data)
           ORDER BY row_data.handed_off_at DESC), '[]'::jsonb)
    INTO handoffs
    FROM (
      SELECT h.id, h.status, h.handed_off_at, h.cash_receipt_id,
             h.capital_receipt_intent_id, source_row.amount::text AS amount,
             source_row.currency_code, source_row.status AS source_status,
             agreement.agreement_reference, installment.sequence_number,
             receipt.receipt_reference, receipt.verified_by_user_account_id,
             location.location_name, account.id AS cash_account_id,
             account.activation_status AS cash_account_status,
             posting.id AS posting_intent_id, posting.status AS posting_status,
             journal.id AS journal_id, journal.status AS journal_status
        FROM abos.treasury_finance_handoffs h
        JOIN abos.capital_receipt_intents source_row
          ON source_row.id = h.capital_receipt_intent_id
         AND source_row.legal_entity_id = h.legal_entity_id
        JOIN abos.capital_agreements agreement
          ON agreement.id = source_row.capital_agreement_id
         AND agreement.legal_entity_id = h.legal_entity_id
        JOIN abos.capital_installments installment
          ON installment.id = source_row.capital_installment_id
         AND installment.legal_entity_id = h.legal_entity_id
        JOIN abos.cash_receipts receipt
          ON receipt.id = h.cash_receipt_id AND receipt.legal_entity_id = h.legal_entity_id
        JOIN abos.cash_location_currency_accounts account
          ON account.id = receipt.cash_location_currency_account_id
         AND account.legal_entity_id = h.legal_entity_id
        JOIN abos.cash_locations location
          ON location.id = account.cash_location_id AND location.legal_entity_id = h.legal_entity_id
        LEFT JOIN abos.posting_intents posting
          ON posting.capital_receipt_intent_id = h.capital_receipt_intent_id
         AND posting.legal_entity_id = h.legal_entity_id
        LEFT JOIN abos.journals journal
          ON journal.posting_intent_id = posting.id AND journal.legal_entity_id = h.legal_entity_id
       WHERE h.legal_entity_id = entity_id
    ) row_data;

  SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(row_data)
           ORDER BY row_data.starts_on), '[]'::jsonb)
    INTO periods
    FROM (
      SELECT id, period_name, starts_on, ends_on
        FROM abos.accounting_periods
       WHERE legal_entity_id = entity_id AND status = 'OPEN'
    ) row_data;

  RETURN pg_catalog.jsonb_build_object(
    'actor', pg_catalog.jsonb_build_object(
      'userAccountId', actor, 'legalEntityId', entity_id, 'permissions', permissions),
    'handoffs', handoffs,
    'openPeriods', periods,
    'syntheticOnly', true
  );
END
$workspace$;

CREATE OR REPLACE FUNCTION abos.finance_handoff_trace(
  p_bearer_token text,
  p_handoff_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $trace$
DECLARE
  entity_id uuid;
  result jsonb;
BEGIN
  PERFORM abos.finance_runtime_authorize(p_bearer_token, 'finance.report.operational.read');
  entity_id := pg_catalog.current_setting('abos.finance_legal_entity_id')::uuid;

  SELECT pg_catalog.jsonb_build_object(
      'handoff', pg_catalog.to_jsonb(h),
      'source', pg_catalog.to_jsonb(source_row),
      'shareholder', pg_catalog.jsonb_build_object(
        'businessPartyId', party.id, 'displayName', party.display_name),
      'agreement', pg_catalog.jsonb_build_object(
        'id', agreement.id, 'reference', agreement.agreement_reference,
        'kind', agreement.agreement_kind, 'status', agreement.status),
      'installment', pg_catalog.jsonb_build_object(
        'id', installment.id, 'sequenceNumber', installment.sequence_number,
        'expectedAmount', installment.expected_amount::text,
        'currency', installment.currency_code, 'dueOn', installment.due_on),
      'receipt', pg_catalog.to_jsonb(receipt),
      'safe', pg_catalog.jsonb_build_object(
        'locationId', location.id, 'name', location.location_name,
        'accountId', account.id, 'currency', account.currency_code,
        'activationStatus', account.activation_status),
      'physicalCount', pg_catalog.to_jsonb(count_row),
      'evidence', pg_catalog.jsonb_build_object(
        'agreement', agreement_evidence.evidence_reference_id,
        'count', count_row.evidence_reference_id,
        'receipt', receipt.evidence_reference_id,
        'approval', approval.evidence_reference_id),
      'postingIntent', pg_catalog.to_jsonb(posting),
      'approval', pg_catalog.to_jsonb(approval),
      'journal', pg_catalog.to_jsonb(journal),
      'reconciliation', pg_catalog.jsonb_build_object(
        'debits', coalesce(totals.debits, 0)::text,
        'credits', coalesce(totals.credits, 0)::text,
        'balanced', coalesce(totals.debits, 0) = coalesce(totals.credits, 0),
        'subledgerEntries', coalesce(totals.subledgers, 0))
    )
    INTO result
    FROM abos.treasury_finance_handoffs h
    JOIN abos.capital_receipt_intents source_row
      ON source_row.id = h.capital_receipt_intent_id AND source_row.legal_entity_id = h.legal_entity_id
    JOIN abos.business_parties party
      ON party.id = source_row.shareholder_business_party_id AND party.legal_entity_id = h.legal_entity_id
    JOIN abos.capital_agreements agreement
      ON agreement.id = source_row.capital_agreement_id AND agreement.legal_entity_id = h.legal_entity_id
    JOIN abos.capital_installments installment
      ON installment.id = source_row.capital_installment_id AND installment.legal_entity_id = h.legal_entity_id
    JOIN abos.cash_receipts receipt
      ON receipt.id = h.cash_receipt_id AND receipt.legal_entity_id = h.legal_entity_id
    JOIN abos.cash_location_currency_accounts account
      ON account.id = receipt.cash_location_currency_account_id AND account.legal_entity_id = h.legal_entity_id
    JOIN abos.cash_locations location
      ON location.id = account.cash_location_id AND location.legal_entity_id = h.legal_entity_id
    JOIN abos.physical_cash_counts count_row
      ON count_row.id = receipt.physical_cash_count_id AND count_row.legal_entity_id = h.legal_entity_id
    LEFT JOIN abos.registration_evidence agreement_evidence
      ON agreement_evidence.capital_agreement_id = agreement.id
     AND agreement_evidence.legal_entity_id = h.legal_entity_id
     AND agreement_evidence.status = 'VERIFIED'
    LEFT JOIN abos.posting_intents posting
      ON posting.capital_receipt_intent_id = source_row.id AND posting.legal_entity_id = h.legal_entity_id
    LEFT JOIN abos.posting_approvals approval
      ON approval.posting_intent_id = posting.id AND approval.legal_entity_id = h.legal_entity_id
    LEFT JOIN abos.journals journal
      ON journal.posting_intent_id = posting.id AND journal.legal_entity_id = h.legal_entity_id
    LEFT JOIN LATERAL (
      SELECT pg_catalog.sum(lines.base_debit) AS debits,
             pg_catalog.sum(lines.base_credit) AS credits,
             (SELECT pg_catalog.count(*) FROM abos.subledger_entries subledger
               WHERE subledger.legal_entity_id = h.legal_entity_id
                 AND subledger.journal_line_id IN (
                   SELECT line_id.id FROM abos.journal_lines line_id
                    WHERE line_id.journal_id = journal.id
                      AND line_id.legal_entity_id = h.legal_entity_id)) AS subledgers
        FROM abos.journal_lines lines
       WHERE lines.journal_id = journal.id AND lines.legal_entity_id = h.legal_entity_id
    ) totals ON true
   WHERE h.id = p_handoff_id AND h.legal_entity_id = entity_id;

  IF result IS NULL THEN
    RAISE EXCEPTION 'Finance handoff is not available in the current legal entity'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN result;
END
$trace$;

CREATE OR REPLACE FUNCTION abos.finance_prepare_capital_posting(
  p_bearer_token text,
  p_handoff_id uuid,
  p_accounting_period_id uuid,
  p_idempotency_key text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $prepare$
DECLARE
  actor uuid;
  entity_id uuid;
  handoff_row record;
  source_row record;
  receipt_row record;
  existing_id uuid;
  new_id uuid := pg_catalog.gen_random_uuid();
BEGIN
  actor := abos.finance_runtime_authorize(p_bearer_token, 'finance.posting-intent.create');
  entity_id := pg_catalog.current_setting('abos.finance_legal_entity_id')::uuid;
  IF p_idempotency_key IS NULL OR pg_catalog.btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'Finance preparation requires an idempotency key';
  END IF;

  SELECT * INTO handoff_row FROM abos.treasury_finance_handoffs
   WHERE id = p_handoff_id AND legal_entity_id = entity_id FOR SHARE;
  IF NOT FOUND OR handoff_row.status <> 'READY_FOR_FINANCE' THEN
    RAISE EXCEPTION 'verified Treasury handoff is unavailable';
  END IF;
  SELECT * INTO source_row FROM abos.capital_receipt_intents
   WHERE id = handoff_row.capital_receipt_intent_id AND legal_entity_id = entity_id FOR UPDATE;
  SELECT * INTO receipt_row FROM abos.cash_receipts
   WHERE id = handoff_row.cash_receipt_id AND legal_entity_id = entity_id FOR SHARE;
  IF source_row.status <> 'TREASURY_VERIFIED' OR receipt_row.status <> 'VERIFIED'
     OR source_row.treasury_cash_receipt_id <> receipt_row.id
     OR source_row.capital_installment_id <> receipt_row.capital_installment_id
     OR source_row.destination_cash_account_id <> receipt_row.cash_location_currency_account_id
     OR source_row.amount <> receipt_row.amount OR source_row.currency_code <> receipt_row.currency_code
     OR source_row.currency_code <> 'USD' THEN
    RAISE EXCEPTION 'Treasury handoff and shareholder source do not agree';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM abos.accounting_periods period
     WHERE period.id = p_accounting_period_id AND period.legal_entity_id = entity_id
       AND period.status = 'OPEN'
       AND source_row.business_event_at::date BETWEEN period.starts_on AND period.ends_on
     FOR SHARE
  ) THEN
    RAISE EXCEPTION 'open accounting period does not cover the source date';
  END IF;

  SELECT id INTO existing_id FROM abos.posting_intents
   WHERE legal_entity_id = entity_id
     AND (treasury_cash_receipt_id = receipt_row.id
          OR (source_type = 'SHAREHOLDER_CAPITAL_INSTALLMENT' AND source_id = source_row.id))
   FOR UPDATE;
  IF FOUND THEN RETURN existing_id; END IF;

  INSERT INTO abos.posting_intents
    (id, legal_entity_id, project_id, department_id, cost_center_id,
     source_type, source_id, treasury_cash_receipt_id, intent_kind,
     original_amount, original_currency_code, base_amount, base_currency_code,
     accounting_effective_date, correlation_id, idempotency_key, status,
     created_by_user_account_id, capital_receipt_intent_id)
  VALUES
    (new_id, entity_id, NULL, NULL, NULL,
     'SHAREHOLDER_CAPITAL_INSTALLMENT', source_row.id, receipt_row.id,
     'SHAREHOLDER_CAPITAL_RECEIPT', source_row.amount, source_row.currency_code,
     source_row.amount, source_row.currency_code, source_row.business_event_at::date,
     handoff_row.correlation_id, p_idempotency_key, 'PENDING_APPROVAL', actor, source_row.id);
  RETURN new_id;
EXCEPTION WHEN unique_violation THEN
  SELECT id INTO existing_id FROM abos.posting_intents
   WHERE legal_entity_id = entity_id
     AND (treasury_cash_receipt_id = receipt_row.id
          OR (source_type = 'SHAREHOLDER_CAPITAL_INSTALLMENT' AND source_id = source_row.id));
  IF existing_id IS NULL THEN RAISE; END IF;
  RETURN existing_id;
END
$prepare$;

CREATE OR REPLACE FUNCTION abos.finance_approve_capital_posting(
  p_bearer_token text,
  p_posting_intent_id uuid
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $approve$
DECLARE
  actor uuid;
  entity_id uuid;
  intent_row record;
  evidence_id uuid;
  evidence_count bigint;
  existing_approver uuid;
  approval_id uuid;
BEGIN
  actor := abos.finance_runtime_authorize(p_bearer_token, 'finance.posting-intent.approve');
  entity_id := pg_catalog.current_setting('abos.finance_legal_entity_id')::uuid;
  SELECT * INTO intent_row FROM abos.posting_intents
   WHERE id = p_posting_intent_id AND legal_entity_id = entity_id FOR UPDATE;
  IF NOT FOUND OR intent_row.intent_kind <> 'SHAREHOLDER_CAPITAL_RECEIPT'
     OR intent_row.status NOT IN ('PENDING_APPROVAL', 'APPROVED') THEN
    RAISE EXCEPTION 'posting intent is unavailable for Finance approval';
  END IF;

  SELECT approval.id, approval.approver_user_account_id INTO approval_id, existing_approver
    FROM abos.posting_approvals approval
   WHERE approval.posting_intent_id = intent_row.id
     AND approval.legal_entity_id = entity_id AND approval.decision = 'APPROVED';
  IF FOUND THEN
    IF existing_approver <> actor THEN
      RAISE EXCEPTION 'posting intent already has an independent Finance decision';
    END IF;
    RETURN approval_id;
  END IF;

  SELECT (pg_catalog.array_agg(binding.evidence_reference_id
            ORDER BY binding.evidence_reference_id))[1], pg_catalog.count(*)
    INTO evidence_id, evidence_count
    FROM abos.finance_approval_evidence_bindings binding
    JOIN abos.evidence_references evidence
      ON evidence.id = binding.evidence_reference_id
     AND evidence.legal_entity_id = binding.legal_entity_id
   WHERE binding.legal_entity_id = entity_id
     AND binding.capital_receipt_intent_id = intent_row.capital_receipt_intent_id
     AND evidence.evidence_kind = 'FINANCE_APPROVAL'
     AND evidence.completed_at IS NOT NULL;
  IF evidence_count <> 1 THEN
    RAISE EXCEPTION 'posting source has no unique completed, prebound Finance approval evidence';
  END IF;

  approval_id := pg_catalog.gen_random_uuid();
  INSERT INTO abos.posting_approvals
    (id, legal_entity_id, posting_intent_id, decision, approver_user_account_id,
     evidence_reference_id, approved_at)
  VALUES
    (approval_id, entity_id, intent_row.id, 'APPROVED', actor,
     evidence_id, pg_catalog.clock_timestamp());
  UPDATE abos.posting_intents SET status = 'APPROVED'
   WHERE id = intent_row.id AND legal_entity_id = entity_id AND status = 'PENDING_APPROVAL';
  IF NOT FOUND THEN RAISE EXCEPTION 'posting intent state changed before approval completed'; END IF;
  RETURN approval_id;
END
$approve$;

-- Finance approval is independent of every person who handled the cash or released it to Finance.
CREATE OR REPLACE FUNCTION abos.enforce_posting_approval_sod()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $sod$
DECLARE
  creator_id uuid;
  cashier_id uuid;
  counter_id uuid;
  verifier_id uuid;
  handoff_actor_id uuid;
  approval_evidence_kind text;
BEGIN
  SELECT pi.created_by_user_account_id, cr.received_by_user_account_id,
         pc.counted_by_user_account_id, cr.verified_by_user_account_id,
         handoff.handed_off_by_user_account_id
    INTO creator_id, cashier_id, counter_id, verifier_id, handoff_actor_id
    FROM abos.posting_intents pi
    LEFT JOIN abos.cash_receipts cr
      ON cr.id = pi.treasury_cash_receipt_id AND cr.legal_entity_id = pi.legal_entity_id
    LEFT JOIN abos.physical_cash_counts pc
      ON pc.id = cr.physical_cash_count_id AND pc.legal_entity_id = cr.legal_entity_id
    LEFT JOIN abos.treasury_finance_handoffs handoff
      ON handoff.cash_receipt_id = cr.id AND handoff.legal_entity_id = cr.legal_entity_id
   WHERE pi.id = NEW.posting_intent_id AND pi.legal_entity_id = NEW.legal_entity_id;
  IF creator_id IS NULL THEN RAISE EXCEPTION 'posting intent not found in approval legal entity'; END IF;
  IF NEW.approver_user_account_id IN
     (creator_id, cashier_id, counter_id, verifier_id, handoff_actor_id) THEN
    RAISE EXCEPTION 'Finance approver must be independent of intent preparation and Treasury custody';
  END IF;
  SELECT evidence.evidence_kind INTO approval_evidence_kind
    FROM abos.evidence_references evidence
   WHERE evidence.id = NEW.evidence_reference_id
     AND evidence.legal_entity_id = NEW.legal_entity_id;
  IF approval_evidence_kind IS DISTINCT FROM 'FINANCE_APPROVAL' THEN
    RAISE EXCEPTION 'posting approval requires structured FINANCE_APPROVAL evidence';
  END IF;
  RETURN NEW;
END
$sod$;

REVOKE ALL ON FUNCTION abos.finance_handoff_workspace(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION abos.finance_handoff_trace(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION abos.finance_prepare_capital_posting(text, uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION abos.finance_approve_capital_posting(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION abos.finance_handoff_workspace(text) TO abos_e1_runtime;
GRANT EXECUTE ON FUNCTION abos.finance_handoff_trace(text, uuid) TO abos_e1_runtime;
GRANT EXECUTE ON FUNCTION abos.finance_prepare_capital_posting(text, uuid, uuid, text) TO abos_e1_runtime;
GRANT EXECUTE ON FUNCTION abos.finance_approve_capital_posting(text, uuid) TO abos_e1_runtime;

-- Reassert role separation after all E1 objects exist.
REVOKE ALL ON ALL TABLES IN SCHEMA abos FROM abos_e1_runtime;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA abos FROM abos_e1_runtime;
REVOKE ALL ON FUNCTION abos.treasury_secure_query(text, uuid, text, uuid) FROM abos_e1_runtime;
REVOKE ALL ON FUNCTION abos.treasury_secure_command(text, uuid, text, jsonb) FROM abos_e1_runtime;

COMMENT ON FUNCTION abos.finance_prepare_capital_posting(text, uuid, uuid, text) IS
  'Synthetic E1 only. Derives one Finance posting intent from a persisted Treasury handoff.';
COMMENT ON FUNCTION abos.finance_approve_capital_posting(text, uuid) IS
  'Synthetic E1 only. Records an independent evidence-backed Finance approval.';
