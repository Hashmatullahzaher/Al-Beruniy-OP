-- Owner-approved optional capital-agreement documentation, scoped to one legal entity.
-- The absence of a policy row is fail-closed: agreement evidence stays required.
-- This migration changes neither agreement nor financial records and does not enable receipts.
CREATE TABLE abos.capital_agreement_document_policies (
  legal_entity_id uuid PRIMARY KEY REFERENCES abos.legal_entities(id),
  document_requirement text NOT NULL CHECK (document_requirement IN ('OPTIONAL', 'REQUIRED')),
  decision_reference text NOT NULL CHECK (length(btrim(decision_reference)) BETWEEN 1 AND 200),
  recorded_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
REVOKE ALL ON abos.capital_agreement_document_policies FROM PUBLIC;

-- Exact local legal-entity identity verified at the accepted 0032 checkpoint.
-- Other entities receive no implicit policy change. A mismatched identity refuses the migration.
DO $policy$
BEGIN
  IF EXISTS (SELECT 1 FROM abos.legal_entities
             WHERE id = '296fc3b7-7249-4297-8963-78cf670c8a93'::uuid
               AND name IS DISTINCT FROM 'Al-Beruniy') THEN
    RAISE EXCEPTION 'the approved optional-document entity identity does not match';
  END IF;
  INSERT INTO abos.capital_agreement_document_policies
    (legal_entity_id, document_requirement, decision_reference)
  SELECT id, 'OPTIONAL', 'OWNER_APPROVED_OPTIONAL_SHAREHOLDER_AGREEMENT_DOCUMENTS_2026-10-01'
    FROM abos.legal_entities
   WHERE id = '296fc3b7-7249-4297-8963-78cf670c8a93'::uuid
     AND name = 'Al-Beruniy';
END
$policy$;

-- Only the two existing least-privilege owners may read the policy. Runtime logins
-- receive no direct table access or new financial authority.
GRANT SELECT (legal_entity_id, document_requirement)
  ON abos.capital_agreement_document_policies TO abos_v1_shareholder_setup_owner, abos_e1_shareholder_owner;

-- Preserve the original owners and EXECUTE ACLs of the three reviewed entry points.
-- The only behavior changed below is the agreement-document condition.

CREATE OR REPLACE FUNCTION abos.shareholder_setup_workspace(
  p_identity_proof text, p_runtime_token_sha256 text, p_token_sha256 text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $workspace$
DECLARE
  v_context jsonb;
  v_entity uuid;
  v_permissions jsonb;
  v_funding boolean;
BEGIN
  v_context := abos.shareholder_setup_actor(p_identity_proof, p_runtime_token_sha256, p_token_sha256,
    ARRAY['shareholder.setup.manage', 'shareholder.read']);
  v_entity := (v_context ->> 'legalEntityId')::uuid;
  v_permissions := COALESCE(v_context -> 'permissions', '[]'::jsonb);
  v_funding := EXISTS (SELECT 1 FROM abos.capital_agreement_funding_policies p WHERE p.legal_entity_id = v_entity);
  RETURN jsonb_build_object(
    'legalEntity', (SELECT jsonb_build_object('id', entity.id, 'name', entity.name, 'baseCurrency', entity.base_currency_code)
                      FROM abos.legal_entities entity WHERE entity.id = v_entity),
    'permissions', jsonb_build_object(
      'canManage', v_permissions ? 'shareholder.setup.manage',
      'canCreateRequests', v_permissions ? 'shareholder.capital-request.create'),
    'today', current_date,
    -- The downstream path (Capital Request -> Treasury -> Finance -> GL) is not operational in V1.
    'receiptPathOperational', false,
    'agreementDocumentRequirement', COALESCE((SELECT policy.document_requirement
      FROM abos.capital_agreement_document_policies policy WHERE policy.legal_entity_id = v_entity), 'REQUIRED'),
    'currencies', COALESCE((SELECT jsonb_agg(currency.code ORDER BY currency.code)
                              FROM abos.currencies currency WHERE currency.enabled), '[]'::jsonb),
    'shareholders', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', profile.id, 'businessPartyId', party.id, 'name', party.display_name,
               'reference', party.external_reference, 'status', profile.status,
               'since', (SELECT min(role.effective_from) FROM abos.business_party_roles role
                          WHERE role.business_party_id = party.id AND role.role_code = 'SHAREHOLDER'),
               'createdAt', profile.created_at,
               'correctable', NOT abos.shareholder_setup_has_posted_capital(profile.id, v_entity),
               'agreementCount', (SELECT count(*) FROM abos.capital_agreements a
                                   WHERE a.shareholder_profile_id = profile.id AND a.legal_entity_id = v_entity))
             ORDER BY party.display_name, profile.id)
        FROM abos.shareholder_profiles profile
        JOIN abos.business_parties party ON party.id = profile.business_party_id AND party.legal_entity_id = profile.legal_entity_id
       WHERE profile.legal_entity_id = v_entity), '[]'::jsonb),
    'agreements', COALESCE((
      SELECT jsonb_agg(row_json ORDER BY row_json ->> 'shareholderName', row_json ->> 'reference')
        FROM (
          SELECT jsonb_build_object(
                   'id', agreement.id, 'shareholderProfileId', agreement.shareholder_profile_id,
                   'shareholderName', party.display_name, 'reference', agreement.agreement_reference,
                   'kind', agreement.agreement_kind, 'currency', agreement.currency_code,
                   'committed', agreement.committed_amount::text,
                   'planned', (SELECT coalesce(sum(i.expected_amount), 0) FROM abos.capital_installments i
                                WHERE i.capital_agreement_id = agreement.id AND i.status <> 'CANCELLED')::text,
                   'requested', (SELECT coalesce(sum(r.amount), 0) FROM abos.capital_receipt_intents r
                                  WHERE r.capital_agreement_id = agreement.id AND r.legal_entity_id = v_entity
                                    AND r.status IN ('DRAFT', 'ELIGIBLE', 'TREASURY_VERIFIED'))::text,
                   'received', received.amount::text,
                   'remaining', (agreement.committed_amount - received.amount)::text,
                   'effectiveOn', agreement.effective_on, 'status', agreement.status,
                   'partialAllowed', agreement.partial_installments_allowed,
                   'createdBy', creator.display_name, 'createdAt', agreement.created_at,
                   'editable', agreement.status = 'DRAFT',
                   'installments', COALESCE((
                     SELECT jsonb_agg(jsonb_build_object(
                              'id', i.id, 'sequence', i.sequence_number, 'amount', i.expected_amount::text,
                              'currency', i.currency_code, 'dueOn', i.due_on, 'status', i.status,
                              'editable', i.status = 'DRAFT' AND agreement.status = 'DRAFT')
                            ORDER BY i.sequence_number)
                       FROM abos.capital_installments i WHERE i.capital_agreement_id = agreement.id), '[]'::jsonb),
                   'documents', COALESCE((
                     SELECT jsonb_agg(jsonb_build_object(
                              'id', link.id, 'version', link.version, 'reference', link.document_reference,
                              'documentDate', link.document_date, 'sha256', er.sha256,
                              'recordedAt', link.recorded_at, 'recordedBy', recorder.display_name)
                            ORDER BY link.version)
                       FROM abos.capital_agreement_evidence link
                       JOIN abos.evidence_references er ON er.id = link.evidence_reference_id AND er.legal_entity_id = link.legal_entity_id
                       JOIN abos.user_accounts recorder ON recorder.id = link.recorded_by_user_account_id
                      WHERE link.capital_agreement_id = agreement.id), '[]'::jsonb),
                   'registration', CASE
                     WHEN EXISTS (SELECT 1 FROM abos.registration_evidence re
                                   WHERE re.capital_agreement_id = agreement.id AND re.legal_entity_id = v_entity
                                     AND re.status = 'VERIFIED') THEN 'VERIFIED'
                     WHEN EXISTS (SELECT 1 FROM abos.registration_evidence re
                                   WHERE re.capital_agreement_id = agreement.id AND re.legal_entity_id = v_entity
                                     AND re.status = 'PENDING') THEN 'PENDING'
                     ELSE 'NONE' END,
                   'requestBlockers', to_jsonb(array_remove(ARRAY[
                     CASE WHEN agreement.status = 'DRAFT' THEN 'AGREEMENT_DRAFT' END,
                     CASE WHEN COALESCE((SELECT policy.document_requirement FROM abos.capital_agreement_document_policies policy
                                          WHERE policy.legal_entity_id = v_entity), 'REQUIRED') = 'REQUIRED'
                           AND NOT EXISTS (SELECT 1 FROM abos.capital_agreement_evidence link
                                            WHERE link.capital_agreement_id = agreement.id) THEN 'AGREEMENT_EVIDENCE_MISSING' END,
                     CASE WHEN NOT EXISTS (SELECT 1 FROM abos.registration_evidence re
                                            WHERE re.capital_agreement_id = agreement.id AND re.legal_entity_id = v_entity
                                              AND re.status = 'VERIFIED') THEN 'REGISTRATION_NOT_VERIFIED' END,
                     CASE WHEN NOT v_funding THEN 'NO_FUNDING_DECISION' END,
                     'RECEIPT_PATH_NOT_OPERATIONAL'], NULL))) AS row_json
            FROM abos.capital_agreements agreement
            JOIN abos.shareholder_profiles profile
              ON profile.id = agreement.shareholder_profile_id AND profile.legal_entity_id = agreement.legal_entity_id
            JOIN abos.business_parties party ON party.id = profile.business_party_id AND party.legal_entity_id = profile.legal_entity_id
            JOIN abos.user_accounts creator ON creator.id = agreement.created_by_user_account_id
            CROSS JOIN LATERAL (SELECT abos.shareholder_setup_received(agreement.id, v_entity) AS amount) received
           WHERE agreement.legal_entity_id = v_entity) agreements), '[]'::jsonb),
    -- Per currency; currencies are never combined.
    'totalsByCurrency', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('currency', t.currency, 'committed', t.committed::text,
                                          'received', t.received::text, 'remaining', (t.committed - t.received)::text)
                       ORDER BY t.currency)
        FROM (SELECT agreement.currency_code AS currency, sum(agreement.committed_amount) AS committed,
                     sum(abos.shareholder_setup_received(agreement.id, v_entity)) AS received
                FROM abos.capital_agreements agreement
               WHERE agreement.legal_entity_id = v_entity GROUP BY agreement.currency_code) t), '[]'::jsonb));
END
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
  -- 0031: the CAPITAL_AGREEMENT document must be linked to THIS agreement; any agreement document
  -- elsewhere in the company no longer satisfies it.
  IF COALESCE((SELECT policy.document_requirement FROM abos.capital_agreement_document_policies policy
                WHERE policy.legal_entity_id = entity), 'REQUIRED') = 'REQUIRED'
     AND NOT EXISTS (SELECT 1 FROM abos.capital_agreement_evidence cae
                  JOIN abos.evidence_references er
                    ON er.id = cae.evidence_reference_id AND er.legal_entity_id = cae.legal_entity_id
                 WHERE cae.capital_agreement_id = agreement.id AND cae.legal_entity_id = entity
                   AND er.evidence_kind = 'CAPITAL_AGREEMENT') THEN
    RAISE EXCEPTION 'a controlled CAPITAL_AGREEMENT document linked to this agreement is required' USING ERRCODE = 'check_violation';
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
                            CASE WHEN COALESCE((SELECT policy.document_requirement FROM abos.capital_agreement_document_policies policy
                                              WHERE policy.legal_entity_id = entity), 'REQUIRED') = 'REQUIRED'
                                 AND NOT EXISTS (SELECT 1 FROM abos.capital_agreement_evidence cae
                                                   WHERE cae.capital_agreement_id = ca.id AND cae.legal_entity_id = entity)
                                 THEN 'AGREEMENT_EVIDENCE_MISSING' END,
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
