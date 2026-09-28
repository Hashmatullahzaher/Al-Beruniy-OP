-- V1 controlled reversal requests (backlog #17).
--
-- Owner decision 2026-09-25: "A Finance user requests a reversal and the Finance Manager approves
-- it. Posted history stays immutable." Nobody approves their own transaction.
--
-- What this migration does:
--  * A Finance user with finance.reversal.request asks for a posted journal to be reversed, with a
--    written reason. A Finance Manager with finance.reversal.approve approves or rejects it; the
--    requester may withdraw it while it is still waiting. Every step is versioned and audited.
--  * APPROVED is terminal. Posting the reversal journal is deliberately NOT implemented: which date
--    and accounting period it uses, what evidence it needs beyond the written reason, and what
--    happens to the source records of a capital journal (capital receipt, installment, commitment,
--    safe custody) are undecided Finance Manager policy. Nothing here creates a journal, a journal
--    line, a posting intent or a journal_reversal_links row, and no Finance function may insert a
--    reversal link at all (the Finance owner has no INSERT on that table).
--  * Segregation of duties is enforced by a trigger on the request table, whoever writes to it:
--      - the decider is never the requester (and the CHECK constraints say so too);
--      - CONSERVATIVE DEFAULT pending the Finance Manager's decision: whoever prepared the posting
--        intent, approved it, created or posted the journal may neither request nor decide its
--        reversal. Relaxing this is a one-function change (abos.reversal_journal_participants).
--  * At most one open (REQUESTED or APPROVED) request per journal, by a partial unique index.
--    A journal that is already reversed, or is itself a reversal journal, cannot be requested.
--  * Actor and legal entity come only from the session token. Project, department and cost-center
--    scope is applied exactly as in abos.finance_general_ledger (0020): a person may request, decide,
--    withdraw or see a reversal only when every line of the journal is within their live scopes.
--  * finance.journal.reverse stays UNAVAILABLE_IN_PREVIEW and untouched.
--  * Every entry point is a restricted Finance function owned by abos_e1_finance_owner (0011).

INSERT INTO abos.permission_catalogue
  (permission_code, catalogue_version, category, availability, independence_enforced, administrative, sort_order)
VALUES
  -- Independence: a participant in the journal cannot request its reversal (conservative default).
  ('finance.reversal.request', 4, 'FINANCE', 'ACTIVE', true, false, 270),
  -- Independence: never the requester, never a participant in the journal.
  ('finance.reversal.approve', 4, 'FINANCE', 'ACTIVE', true, false, 271);

-- ---------------------------------------------------------------------------
-- The request. What was asked, by whom and when never changes; the decision is recorded once.
-- ---------------------------------------------------------------------------
CREATE TABLE abos.journal_reversal_requests (
  id uuid PRIMARY KEY,
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  journal_id uuid NOT NULL,
  reason text NOT NULL CHECK (length(reason) BETWEEN 10 AND 1000 AND btrim(reason) = reason),
  status text NOT NULL CHECK (status IN ('REQUESTED', 'APPROVED', 'REJECTED', 'WITHDRAWN')),
  requested_by_user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  decided_by_user_account_id uuid REFERENCES abos.user_accounts(id),
  decided_at timestamptz,
  decision_note text CHECK (decision_note IS NULL OR (length(decision_note) BETWEEN 1 AND 1000 AND btrim(decision_note) = decision_note)),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (id, legal_entity_id),
  FOREIGN KEY (journal_id, legal_entity_id) REFERENCES abos.journals(id, legal_entity_id),
  CHECK ((status = 'REQUESTED') = (decided_by_user_account_id IS NULL)),
  CHECK ((decided_by_user_account_id IS NULL) = (decided_at IS NULL)),
  CHECK (status <> 'REQUESTED' OR decision_note IS NULL),
  CHECK (status <> 'WITHDRAWN' OR decided_by_user_account_id = requested_by_user_account_id),
  CHECK (status NOT IN ('APPROVED', 'REJECTED') OR decided_by_user_account_id <> requested_by_user_account_id),
  CHECK (status <> 'REJECTED' OR decision_note IS NOT NULL)
);
-- One open request per journal. An approved request stays open until a posting policy exists.
CREATE UNIQUE INDEX journal_reversal_requests_one_open
  ON abos.journal_reversal_requests (journal_id) WHERE status IN ('REQUESTED', 'APPROVED');
CREATE INDEX journal_reversal_requests_entity_idx
  ON abos.journal_reversal_requests (legal_entity_id, requested_at DESC);

-- ---------------------------------------------------------------------------
-- Internal helpers (the Finance owner only).
-- ---------------------------------------------------------------------------

-- Everyone who took part in a journal: the posting intent's preparer, every recorded approver of
-- that intent, the journal's creator and its poster. Used for the CONSERVATIVE default that none of
-- them may request or decide the journal's reversal until the Finance Manager decides otherwise.
CREATE FUNCTION abos.reversal_journal_participants(p_journal_id uuid)
RETURNS uuid[]
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT coalesce(array_agg(DISTINCT people.person) FILTER (WHERE people.person IS NOT NULL), '{}'::uuid[])
    FROM (
      SELECT j.created_by_user_account_id AS person FROM abos.journals j WHERE j.id = p_journal_id
      UNION ALL
      SELECT j.posted_by_user_account_id FROM abos.journals j WHERE j.id = p_journal_id
      UNION ALL
      SELECT pi.created_by_user_account_id
        FROM abos.journals j JOIN abos.posting_intents pi ON pi.id = j.posting_intent_id
       WHERE j.id = p_journal_id
      UNION ALL
      SELECT pa.approver_user_account_id
        FROM abos.journals j JOIN abos.posting_approvals pa ON pa.posting_intent_id = j.posting_intent_id
       WHERE j.id = p_journal_id
    ) people
$$;

-- True when every line of the journal is within the actor's live project, department and
-- cost-center scopes (the conjunctive rule of abos.finance_general_ledger, 0020).
CREATE FUNCTION abos.reversal_journal_in_scope(p_journal_id uuid, p_entity uuid, p_actor uuid)
RETURNS boolean
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM abos.journal_lines line
     WHERE line.journal_id = p_journal_id
       AND (line.legal_entity_id <> p_entity
         OR (line.project_id IS NOT NULL AND NOT EXISTS (
               SELECT 1 FROM abos.user_scope_grants scope
                WHERE scope.user_account_id = p_actor AND scope.legal_entity_id = p_entity
                  AND scope.scope_kind = 'PROJECT' AND scope.scope_id = line.project_id
                  AND scope.revoked_at IS NULL))
         OR (line.department_id IS NOT NULL AND NOT EXISTS (
               SELECT 1 FROM abos.user_scope_grants scope
                WHERE scope.user_account_id = p_actor AND scope.legal_entity_id = p_entity
                  AND scope.scope_kind = 'DEPARTMENT' AND scope.scope_id = line.department_id
                  AND scope.revoked_at IS NULL))
         OR (line.cost_center_id IS NOT NULL AND NOT EXISTS (
               SELECT 1 FROM abos.user_scope_grants scope
                WHERE scope.user_account_id = p_actor AND scope.legal_entity_id = p_entity
                  AND scope.scope_kind = 'COST_CENTER' AND scope.scope_id = line.cost_center_id
                  AND scope.revoked_at IS NULL)))
  )
$$;

-- Why a journal cannot receive a new reversal request, or NULL when it can.
CREATE FUNCTION abos.reversal_journal_blocker(p_journal_id uuid, p_entity uuid)
RETURNS text
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE
    WHEN j.id IS NULL THEN 'NOT_FOUND'
    WHEN j.status <> 'POSTED' THEN 'NOT_POSTED'
    WHEN pi.intent_kind = 'REVERSAL'
      OR EXISTS (SELECT 1 FROM abos.journal_reversal_links l WHERE l.reversal_journal_id = j.id) THEN 'IS_REVERSAL'
    WHEN EXISTS (SELECT 1 FROM abos.journal_reversal_links l WHERE l.original_journal_id = j.id) THEN 'ALREADY_REVERSED'
    WHEN EXISTS (SELECT 1 FROM abos.journal_reversal_requests r
                  WHERE r.journal_id = j.id AND r.status = 'APPROVED') THEN 'APPROVED_REQUEST'
    WHEN EXISTS (SELECT 1 FROM abos.journal_reversal_requests r
                  WHERE r.journal_id = j.id AND r.status = 'REQUESTED') THEN 'OPEN_REQUEST'
  END
    FROM (SELECT p_journal_id AS id) wanted
    LEFT JOIN abos.journals j ON j.id = wanted.id AND j.legal_entity_id = p_entity
    LEFT JOIN abos.posting_intents pi ON pi.id = j.posting_intent_id
$$;

-- A posted journal as the reversal screens show it. Amounts are exact decimal text; currencies are
-- never combined. The only actor named is the poster recorded on the journal.
CREATE FUNCTION abos.reversal_journal_json(p_journal_id uuid, p_viewer uuid)
RETURNS jsonb
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT jsonb_build_object(
    'id', j.id, 'reference', j.journal_reference, 'status', j.status,
    'accountingEffectiveDate', j.accounting_effective_date, 'accountingPeriodId', j.accounting_period_id,
    'postedAt', j.posted_at, 'baseCurrency', j.base_currency_code,
    'intentKind', pi.intent_kind, 'sourceType', pi.source_type,
    'postedBy', (SELECT u.display_name FROM abos.user_accounts u WHERE u.id = j.posted_by_user_account_id),
    'viewerIsParticipant', p_viewer IS NOT NULL AND p_viewer = ANY (abos.reversal_journal_participants(j.id)),
    'lines', coalesce((SELECT jsonb_agg(jsonb_build_object(
                 'lineNumber', line.line_number, 'accountCode', account.account_code, 'accountName', account.account_name,
                 'baseCurrency', line.base_currency_code, 'baseDebit', line.base_debit::text, 'baseCredit', line.base_credit::text,
                 'originalCurrency', line.original_currency_code, 'originalAmount', line.original_amount::text)
                 ORDER BY line.line_number)
               FROM abos.journal_lines line
               JOIN abos.ledger_accounts account ON account.id = line.ledger_account_id AND account.legal_entity_id = line.legal_entity_id
              WHERE line.journal_id = j.id), '[]'::jsonb),
    'totals', coalesce((SELECT jsonb_agg(jsonb_build_object('currency', t.currency, 'debits', t.debits, 'credits', t.credits) ORDER BY t.currency)
               FROM (SELECT line.base_currency_code AS currency, sum(line.base_debit)::text AS debits, sum(line.base_credit)::text AS credits
                       FROM abos.journal_lines line WHERE line.journal_id = j.id GROUP BY line.base_currency_code) t), '[]'::jsonb))
    FROM abos.journals j
    JOIN abos.posting_intents pi ON pi.id = j.posting_intent_id
   WHERE j.id = p_journal_id
$$;

-- A request as the reversal screens show it. Names are only those of actors recorded on the row.
CREATE FUNCTION abos.reversal_request_json(p_request_id uuid, p_viewer uuid)
RETURNS jsonb
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT jsonb_build_object(
    'id', r.id, 'status', r.status, 'reason', r.reason, 'version', r.version,
    'requestedBy', (SELECT u.display_name FROM abos.user_accounts u WHERE u.id = r.requested_by_user_account_id),
    'requestedAt', r.requested_at,
    'decidedBy', (SELECT u.display_name FROM abos.user_accounts u WHERE u.id = r.decided_by_user_account_id),
    'decidedAt', r.decided_at, 'decisionNote', r.decision_note,
    'viewerIsRequester', p_viewer IS NOT NULL AND p_viewer = r.requested_by_user_account_id,
    'viewerIsDecider', p_viewer IS NOT NULL AND p_viewer = r.decided_by_user_account_id,
    -- Posting the reversal is not implemented: an approved reversal waits for the Finance
    -- Manager's posting policy. No reversal journal exists for any request.
    'posting', jsonb_build_object(
      'status', CASE WHEN r.status = 'APPROVED' THEN 'AWAITING_POSTING_POLICY' ELSE 'NOT_APPLICABLE' END,
      'reversalJournalId', NULL),
    'journal', abos.reversal_journal_json(r.journal_id, p_viewer))
    FROM abos.journal_reversal_requests r
   WHERE r.id = p_request_id
$$;

-- ---------------------------------------------------------------------------
-- Guard on every write, whoever the writer is (entry point, owner or migration identity).
-- ---------------------------------------------------------------------------
CREATE FUNCTION abos.guard_journal_reversal_request()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  blocker text;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'reversal requests are permanent records and cannot be deleted';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'REQUESTED' OR NEW.version <> 1 OR NEW.decided_by_user_account_id IS NOT NULL THEN
      RAISE EXCEPTION 'a reversal request starts as REQUESTED, version 1, undecided' USING ERRCODE = 'check_violation';
    END IF;
    blocker := abos.reversal_journal_blocker(NEW.journal_id, NEW.legal_entity_id);
    IF blocker = 'NOT_FOUND' THEN
      RAISE EXCEPTION 'journal not found' USING ERRCODE = 'no_data_found';
    ELSIF blocker = 'NOT_POSTED' THEN
      RAISE EXCEPTION 'only a posted journal can be reversed' USING ERRCODE = 'ABR02';
    ELSIF blocker = 'IS_REVERSAL' THEN
      RAISE EXCEPTION 'this journal is itself a reversal; reversing a reversal is not available' USING ERRCODE = 'ABR02';
    ELSIF blocker = 'ALREADY_REVERSED' THEN
      RAISE EXCEPTION 'this journal has already been reversed' USING ERRCODE = 'ABR02';
    END IF;
    -- APPROVED_REQUEST and OPEN_REQUEST are left to the partial unique index, which also holds
    -- under concurrency.
    IF NEW.requested_by_user_account_id = ANY (abos.reversal_journal_participants(NEW.journal_id)) THEN
      RAISE EXCEPTION 'whoever prepared, approved or posted a journal cannot request its reversal (conservative rule until the Finance Manager decides)'
        USING ERRCODE = 'ABR01';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE: exactly one decision, recorded once.
  IF (NEW.id, NEW.legal_entity_id, NEW.journal_id, NEW.reason, NEW.requested_by_user_account_id, NEW.requested_at)
     IS DISTINCT FROM (OLD.id, OLD.legal_entity_id, OLD.journal_id, OLD.reason, OLD.requested_by_user_account_id, OLD.requested_at) THEN
    RAISE EXCEPTION 'what was requested, by whom and when cannot change' USING ERRCODE = 'ABR02';
  END IF;
  IF OLD.status <> 'REQUESTED' THEN
    RAISE EXCEPTION 'this reversal request was already %', lower(OLD.status) USING ERRCODE = 'ABR02';
  END IF;
  IF NEW.status = 'REQUESTED' THEN
    RAISE EXCEPTION 'a reversal request changes only by a decision or a withdrawal' USING ERRCODE = 'ABR02';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'the reversal request was changed by someone else' USING ERRCODE = 'serialization_failure';
  END IF;
  IF NEW.status = 'WITHDRAWN' THEN
    IF NEW.decided_by_user_account_id IS DISTINCT FROM OLD.requested_by_user_account_id THEN
      RAISE EXCEPTION 'only the person who requested a reversal can withdraw it' USING ERRCODE = 'ABR01';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.decided_by_user_account_id = OLD.requested_by_user_account_id THEN
    RAISE EXCEPTION 'the person who requested a reversal cannot decide it' USING ERRCODE = 'ABR01';
  END IF;
  IF NEW.decided_by_user_account_id = ANY (abos.reversal_journal_participants(OLD.journal_id)) THEN
    RAISE EXCEPTION 'whoever prepared, approved or posted a journal cannot decide its reversal (conservative rule until the Finance Manager decides)'
      USING ERRCODE = 'ABR01';
  END IF;
  IF NEW.status = 'APPROVED'
     AND abos.reversal_journal_blocker(OLD.journal_id, OLD.legal_entity_id) IN ('ALREADY_REVERSED', 'IS_REVERSAL', 'NOT_POSTED', 'NOT_FOUND') THEN
    RAISE EXCEPTION 'this journal can no longer be reversed' USING ERRCODE = 'ABR02';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER journal_reversal_requests_guard
BEFORE INSERT OR UPDATE OR DELETE ON abos.journal_reversal_requests
FOR EACH ROW EXECUTE FUNCTION abos.guard_journal_reversal_request();
CREATE TRIGGER journal_reversal_requests_no_truncate
BEFORE TRUNCATE ON abos.journal_reversal_requests
FOR EACH STATEMENT EXECUTE FUNCTION abos.guard_journal_reversal_request();

-- ---------------------------------------------------------------------------
-- Restricted Finance entry points.
-- ---------------------------------------------------------------------------

-- Everything the reversal screen needs. Holders of request, approve or the operational Finance
-- read permission may view; each sees only journals whose lines are all within their live scopes.
CREATE FUNCTION abos.finance_reversal_requests_view(p_bearer_token text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $view$
DECLARE
  actor uuid;
  entity uuid;
  can_request boolean := false;
  can_approve boolean := false;
  can_read boolean := false;
  eligible jsonb := '[]'::jsonb;
  eligible_total bigint := 0;
BEGIN
  BEGIN
    actor := abos.finance_runtime_authorize(p_bearer_token, 'finance.reversal.request');
    can_request := true;
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    actor := abos.finance_runtime_authorize(p_bearer_token, 'finance.reversal.approve');
    can_approve := true;
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    actor := abos.finance_runtime_authorize(p_bearer_token, 'finance.report.operational.read');
    can_read := true;
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  IF NOT (can_request OR can_approve OR can_read) THEN
    -- Re-raise the real refusal: an ended session, or the missing permission.
    actor := abos.finance_runtime_authorize(p_bearer_token, 'finance.reversal.request');
  END IF;
  entity := pg_catalog.current_setting('abos.finance_legal_entity_id')::uuid;

  IF can_request THEN
    WITH candidates AS (
      SELECT j.id, j.posted_at
        FROM abos.journals j
       WHERE j.legal_entity_id = entity AND j.status = 'POSTED'
         AND abos.reversal_journal_blocker(j.id, entity) IS NULL
         AND abos.reversal_journal_in_scope(j.id, entity, actor)
    )
    SELECT (SELECT count(*) FROM candidates),
           coalesce((SELECT jsonb_agg(abos.reversal_journal_json(c.id, actor) ORDER BY c.posted_at DESC, c.id)
                       FROM (SELECT * FROM candidates ORDER BY posted_at DESC, id LIMIT 100) c), '[]'::jsonb)
      INTO eligible_total, eligible;
  END IF;

  RETURN jsonb_build_object(
    'syntheticOnly', true,
    'canRequest', can_request, 'canApprove', can_approve,
    'actor', (SELECT jsonb_build_object('displayName', u.display_name) FROM abos.user_accounts u WHERE u.id = actor),
    'legalEntity', (SELECT jsonb_build_object('id', e.id, 'name', e.name, 'baseCurrency', e.base_currency_code)
                      FROM abos.legal_entities e WHERE e.id = entity),
    -- Fail-closed: posting an approved reversal awaits the Finance Manager's policy.
    'posting', jsonb_build_object('available', false, 'status', 'AWAITING_POSTING_POLICY',
                 'pendingDecisions', jsonb_build_array('REVERSAL_DATE_AND_PERIOD', 'REVERSAL_EVIDENCE', 'SOURCE_RECORD_EFFECTS')),
    'conservativeRules', jsonb_build_array('JOURNAL_PARTICIPANTS_CANNOT_REQUEST', 'JOURNAL_PARTICIPANTS_CANNOT_DECIDE'),
    'requests', coalesce((SELECT jsonb_agg(abos.reversal_request_json(r.id, actor) ORDER BY r.requested_at DESC, r.id)
                            FROM abos.journal_reversal_requests r
                           WHERE r.legal_entity_id = entity
                             AND abos.reversal_journal_in_scope(r.journal_id, entity, actor)), '[]'::jsonb),
    'eligibleJournals', eligible,
    'eligibleLimit', 100,
    'eligibleHasMore', eligible_total > jsonb_array_length(eligible));
END;
$view$;

-- A Finance user asks for a posted journal to be reversed. A replay of the same request by the
-- same person returns the existing request instead of a second one.
CREATE FUNCTION abos.finance_reversal_request_create(p_bearer_token text, p_journal_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $create$
DECLARE
  actor uuid;
  entity uuid;
  new_id uuid := gen_random_uuid();
  v_reason text := btrim(p_reason);
  existing record;
  created jsonb;
BEGIN
  actor := abos.finance_runtime_authorize(p_bearer_token, 'finance.reversal.request');
  entity := pg_catalog.current_setting('abos.finance_legal_entity_id')::uuid;
  IF v_reason IS NULL OR length(v_reason) < 10 OR length(v_reason) > 1000 THEN
    RAISE EXCEPTION 'give a written reason of 10 to 1000 characters' USING ERRCODE = 'check_violation';
  END IF;
  -- The journal must be in this company and entirely within the person's scopes; otherwise it is
  -- reported as not found, so nothing about it is disclosed.
  PERFORM 1 FROM abos.journals j WHERE j.id = p_journal_id AND j.legal_entity_id = entity FOR SHARE;
  IF NOT FOUND OR NOT abos.reversal_journal_in_scope(p_journal_id, entity, actor) THEN
    RAISE EXCEPTION 'journal not found' USING ERRCODE = 'no_data_found';
  END IF;

  FOR attempt IN 1..2 LOOP
    SELECT r.id, r.status, r.reason, r.requested_by_user_account_id INTO existing
      FROM abos.journal_reversal_requests r
     WHERE r.journal_id = p_journal_id AND r.status IN ('REQUESTED', 'APPROVED');
    IF FOUND THEN
      IF existing.status = 'REQUESTED' AND existing.requested_by_user_account_id = actor AND existing.reason = v_reason THEN
        RETURN jsonb_build_object('request', abos.reversal_request_json(existing.id, actor), 'created', false);
      END IF;
      IF existing.status = 'APPROVED' THEN
        RAISE EXCEPTION 'a reversal of this journal is already approved and awaits the posting policy' USING ERRCODE = 'unique_violation';
      END IF;
      RAISE EXCEPTION 'this journal already has an open reversal request' USING ERRCODE = 'unique_violation';
    END IF;
    BEGIN
      INSERT INTO abos.journal_reversal_requests
        (id, legal_entity_id, journal_id, reason, status, requested_by_user_account_id, requested_at, version)
      VALUES (new_id, entity, p_journal_id, v_reason, 'REQUESTED', actor, clock_timestamp(), 1);
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      -- Someone opened a request at the same moment: look again (a same-person replay is returned).
      IF attempt = 2 THEN RAISE; END IF;
    END;
  END LOOP;

  created := abos.reversal_request_json(new_id, NULL);
  INSERT INTO abos.audit_records (id, actor_user_account_id, legal_entity_id, correlation_id, action, entity_type, entity_id, after_state, metadata)
  VALUES (gen_random_uuid(), actor, entity, gen_random_uuid(), 'JOURNAL_REVERSAL_REQUESTED', 'JOURNAL_REVERSAL_REQUEST', new_id,
          created - 'journal', jsonb_build_object('source', 'finance_reversal_request_create', 'journalId', p_journal_id,
                                                  'postingPerformed', false));
  RETURN jsonb_build_object('request', abos.reversal_request_json(new_id, actor), 'created', true);
END;
$create$;

-- The Finance Manager approves or rejects a waiting request. Approval records the decision only:
-- no journal is created. A replay of the same decision by the same person changes nothing.
CREATE FUNCTION abos.finance_reversal_request_decide(
  p_bearer_token text, p_request_id uuid, p_expected_version integer, p_decision text, p_note text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $decide$
DECLARE
  actor uuid;
  entity uuid;
  request_row abos.journal_reversal_requests%ROWTYPE;
  v_note text := nullif(btrim(p_note), '');
BEGIN
  actor := abos.finance_runtime_authorize(p_bearer_token, 'finance.reversal.approve');
  entity := pg_catalog.current_setting('abos.finance_legal_entity_id')::uuid;
  IF p_decision IS NULL OR p_decision NOT IN ('APPROVED', 'REJECTED') THEN
    RAISE EXCEPTION 'the decision must be APPROVED or REJECTED' USING ERRCODE = 'check_violation';
  END IF;
  IF p_decision = 'REJECTED' AND (v_note IS NULL OR length(v_note) < 3) THEN
    RAISE EXCEPTION 'say why the reversal is rejected' USING ERRCODE = 'check_violation';
  END IF;
  IF v_note IS NOT NULL AND length(v_note) > 1000 THEN
    RAISE EXCEPTION 'the note must be at most 1000 characters' USING ERRCODE = 'check_violation';
  END IF;
  IF p_expected_version IS NULL THEN
    RAISE EXCEPTION 'the expected request version is required' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO request_row FROM abos.journal_reversal_requests
   WHERE id = p_request_id AND legal_entity_id = entity FOR UPDATE;
  IF NOT FOUND OR NOT abos.reversal_journal_in_scope(request_row.journal_id, entity, actor) THEN
    RAISE EXCEPTION 'reversal request not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF request_row.status <> 'REQUESTED' THEN
    IF request_row.status = p_decision AND request_row.decided_by_user_account_id = actor THEN
      RETURN jsonb_build_object('request', abos.reversal_request_json(p_request_id, actor), 'changed', false);
    END IF;
    RAISE EXCEPTION 'this reversal request was already %', lower(request_row.status) USING ERRCODE = 'ABR02';
  END IF;
  IF request_row.version <> p_expected_version THEN
    RAISE EXCEPTION 'the reversal request was changed by someone else' USING ERRCODE = 'serialization_failure';
  END IF;
  IF actor = request_row.requested_by_user_account_id THEN
    RAISE EXCEPTION 'the person who requested a reversal cannot decide it' USING ERRCODE = 'ABR01';
  END IF;
  IF actor = ANY (abos.reversal_journal_participants(request_row.journal_id)) THEN
    RAISE EXCEPTION 'whoever prepared, approved or posted a journal cannot decide its reversal (conservative rule until the Finance Manager decides)'
      USING ERRCODE = 'ABR01';
  END IF;

  UPDATE abos.journal_reversal_requests
     SET status = p_decision, decided_by_user_account_id = actor, decided_at = clock_timestamp(),
         decision_note = v_note, version = version + 1
   WHERE id = p_request_id;

  INSERT INTO abos.audit_records (id, actor_user_account_id, legal_entity_id, correlation_id, action, entity_type, entity_id, before_state, after_state, metadata)
  VALUES (gen_random_uuid(), actor, entity, gen_random_uuid(),
          CASE WHEN p_decision = 'APPROVED' THEN 'JOURNAL_REVERSAL_APPROVED' ELSE 'JOURNAL_REVERSAL_REJECTED' END,
          'JOURNAL_REVERSAL_REQUEST', p_request_id,
          jsonb_build_object('status', request_row.status, 'version', request_row.version),
          jsonb_build_object('status', p_decision, 'version', request_row.version + 1, 'decisionNote', v_note),
          jsonb_build_object('source', 'finance_reversal_request_decide', 'journalId', request_row.journal_id,
                             'postingPerformed', false,
                             'postingStatus', CASE WHEN p_decision = 'APPROVED' THEN 'AWAITING_POSTING_POLICY' ELSE 'NOT_APPLICABLE' END));
  RETURN jsonb_build_object('request', abos.reversal_request_json(p_request_id, actor), 'changed', true);
END;
$decide$;

-- The requester withdraws a request that is still waiting for a decision.
CREATE FUNCTION abos.finance_reversal_request_withdraw(
  p_bearer_token text, p_request_id uuid, p_expected_version integer, p_note text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $withdraw$
DECLARE
  actor uuid;
  entity uuid;
  request_row abos.journal_reversal_requests%ROWTYPE;
  v_note text := nullif(btrim(p_note), '');
BEGIN
  actor := abos.finance_runtime_authorize(p_bearer_token, 'finance.reversal.request');
  entity := pg_catalog.current_setting('abos.finance_legal_entity_id')::uuid;
  IF v_note IS NOT NULL AND length(v_note) > 1000 THEN
    RAISE EXCEPTION 'the note must be at most 1000 characters' USING ERRCODE = 'check_violation';
  END IF;
  IF p_expected_version IS NULL THEN
    RAISE EXCEPTION 'the expected request version is required' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO request_row FROM abos.journal_reversal_requests
   WHERE id = p_request_id AND legal_entity_id = entity FOR UPDATE;
  IF NOT FOUND OR NOT abos.reversal_journal_in_scope(request_row.journal_id, entity, actor) THEN
    RAISE EXCEPTION 'reversal request not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF actor <> request_row.requested_by_user_account_id THEN
    RAISE EXCEPTION 'only the person who requested a reversal can withdraw it' USING ERRCODE = 'ABR01';
  END IF;
  IF request_row.status <> 'REQUESTED' THEN
    IF request_row.status = 'WITHDRAWN' THEN
      RETURN jsonb_build_object('request', abos.reversal_request_json(p_request_id, actor), 'changed', false);
    END IF;
    RAISE EXCEPTION 'this reversal request was already %', lower(request_row.status) USING ERRCODE = 'ABR02';
  END IF;
  IF request_row.version <> p_expected_version THEN
    RAISE EXCEPTION 'the reversal request was changed by someone else' USING ERRCODE = 'serialization_failure';
  END IF;

  UPDATE abos.journal_reversal_requests
     SET status = 'WITHDRAWN', decided_by_user_account_id = actor, decided_at = clock_timestamp(),
         decision_note = v_note, version = version + 1
   WHERE id = p_request_id;

  INSERT INTO abos.audit_records (id, actor_user_account_id, legal_entity_id, correlation_id, action, entity_type, entity_id, before_state, after_state, metadata)
  VALUES (gen_random_uuid(), actor, entity, gen_random_uuid(), 'JOURNAL_REVERSAL_WITHDRAWN', 'JOURNAL_REVERSAL_REQUEST', p_request_id,
          jsonb_build_object('status', request_row.status, 'version', request_row.version),
          jsonb_build_object('status', 'WITHDRAWN', 'version', request_row.version + 1, 'decisionNote', v_note),
          jsonb_build_object('source', 'finance_reversal_request_withdraw', 'journalId', request_row.journal_id, 'postingPerformed', false));
  RETURN jsonb_build_object('request', abos.reversal_request_json(p_request_id, actor), 'changed', true);
END;
$withdraw$;

-- ---------------------------------------------------------------------------
-- Ownership and access, following 0011. Runtime roles receive no table privilege at all; the
-- Finance owner receives SELECT and column-level INSERT/UPDATE on the request table only. It still
-- has no INSERT on journal_reversal_links, journals or journal_lines through this migration.
-- Journals are locked FOR SHARE with the column privileges the Finance owner already holds (0011).
-- ---------------------------------------------------------------------------
REVOKE ALL ON abos.journal_reversal_requests FROM PUBLIC;
GRANT SELECT ON abos.journal_reversal_requests TO abos_e1_finance_owner;
GRANT INSERT (id, legal_entity_id, journal_id, reason, status, requested_by_user_account_id, requested_at, version)
  ON abos.journal_reversal_requests TO abos_e1_finance_owner;
GRANT UPDATE (status, decided_by_user_account_id, decided_at, decision_note, version)
  ON abos.journal_reversal_requests TO abos_e1_finance_owner;

ALTER FUNCTION abos.finance_reversal_requests_view(text) OWNER TO abos_e1_finance_owner;
ALTER FUNCTION abos.finance_reversal_request_create(text, uuid, text) OWNER TO abos_e1_finance_owner;
ALTER FUNCTION abos.finance_reversal_request_decide(text, uuid, integer, text, text) OWNER TO abos_e1_finance_owner;
ALTER FUNCTION abos.finance_reversal_request_withdraw(text, uuid, integer, text) OWNER TO abos_e1_finance_owner;

REVOKE ALL ON FUNCTION abos.finance_reversal_requests_view(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION abos.finance_reversal_request_create(text, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION abos.finance_reversal_request_decide(text, uuid, integer, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION abos.finance_reversal_request_withdraw(text, uuid, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION abos.finance_reversal_requests_view(text) TO abos_e1_runtime;
GRANT EXECUTE ON FUNCTION abos.finance_reversal_request_create(text, uuid, text) TO abos_e1_runtime;
GRANT EXECUTE ON FUNCTION abos.finance_reversal_request_decide(text, uuid, integer, text, text) TO abos_e1_runtime;
GRANT EXECUTE ON FUNCTION abos.finance_reversal_request_withdraw(text, uuid, integer, text) TO abos_e1_runtime;

-- Internal helpers and the trigger function: the Finance owner only (its entry points, and the
-- trigger those fire, call them).
REVOKE ALL ON FUNCTION abos.reversal_journal_participants(uuid), abos.reversal_journal_in_scope(uuid, uuid, uuid),
  abos.reversal_journal_blocker(uuid, uuid), abos.reversal_journal_json(uuid, uuid), abos.reversal_request_json(uuid, uuid),
  abos.guard_journal_reversal_request() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION abos.reversal_journal_participants(uuid), abos.reversal_journal_in_scope(uuid, uuid, uuid),
  abos.reversal_journal_blocker(uuid, uuid), abos.reversal_journal_json(uuid, uuid), abos.reversal_request_json(uuid, uuid)
  TO abos_e1_finance_owner;
