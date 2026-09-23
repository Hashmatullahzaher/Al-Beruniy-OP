-- Stage 1 E1 sandbox integration.
--
-- Additive only. Migration 0001 is not edited and its checksum is unchanged; every guard below is a
-- new table, a new column, or a new trigger alongside the existing ones.
--
-- Resolves findings F-1 (canonical status vocabulary), F-2 (persistent capital receipt intent),
-- F-3 (technically enforced synthetic-only gate), F-4 (durable over-contribution prevention),
-- F-5 (reversal segregation of duties) and F-7 (physical cash count validation) of
-- docs/04-delivery/STAGE_01_E1_FINANCE_REVIEW_CLAUDE.md.
--
-- Nothing here enables real posting. The gate this migration installs makes posting impossible
-- unless a database explicitly and expirably declares itself a synthetic sandbox.

-- ---------------------------------------------------------------------------
-- F-3. Synthetic-only authorization, enforced by the database being written to.
-- ---------------------------------------------------------------------------

-- Exactly one row is representable: the primary key is a boolean constrained to true.
CREATE TABLE abos.sandbox_authorizations (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  environment text NOT NULL CHECK (environment IN ('development', 'test')),
  configuration_state text NOT NULL CHECK (configuration_state = 'SYNTHETIC_TEST_ONLY'),
  policy_version_id text NOT NULL CHECK (btrim(policy_version_id) <> ''),
  -- Not a default and not a toggle: a true value cannot be stored at all.
  real_posting_enabled boolean NOT NULL DEFAULT false CHECK (real_posting_enabled = false),
  -- The operator sets this when authorizing the sandbox and must present the same value on every
  -- session that mutates finance. There is no default, so an unconfigured session cannot post.
  runtime_marker text NOT NULL CHECK (length(btrim(runtime_marker)) >= 16),
  authorized_by_user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  authorized_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (expires_at > authorized_at)
);

CREATE TABLE abos.sandbox_legal_entity_scopes (
  legal_entity_id uuid PRIMARY KEY REFERENCES abos.legal_entities(id),
  base_currency_code text NOT NULL REFERENCES abos.currencies(code),
  authorized_by_user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  authorized_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Fails closed on every path: no authorization row, an expired one, a session that does not present
-- the runtime marker, or a legal entity outside the authorized scope.
CREATE OR REPLACE FUNCTION abos.assert_sandbox_mutation_authorized(target_legal_entity_id uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  authorization_row abos.sandbox_authorizations%ROWTYPE;
  session_marker text;
  scoped_currency text;
BEGIN
  SELECT * INTO authorization_row FROM abos.sandbox_authorizations WHERE singleton;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'E1 finance mutation requires an explicit sandbox authorization; this database has none'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF authorization_row.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'sandbox authorization expired at %', authorization_row.expires_at
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- current_setting(..., true) returns NULL when unset rather than raising, so an unconfigured
  -- session reaches the refusal below instead of succeeding.
  session_marker := current_setting('abos.runtime_marker', true);
  IF session_marker IS NULL OR session_marker <> authorization_row.runtime_marker THEN
    RAISE EXCEPTION 'session does not present the authorized sandbox runtime marker'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT base_currency_code INTO scoped_currency
    FROM abos.sandbox_legal_entity_scopes
   WHERE legal_entity_id = target_legal_entity_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'legal entity % is not inside the authorized E1 sandbox scope', target_legal_entity_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION abos.guard_sandbox_finance_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM abos.assert_sandbox_mutation_authorized(NEW.legal_entity_id);
  RETURN NEW;
END;
$$;

CREATE TRIGGER posting_intents_sandbox_guard
BEFORE INSERT OR UPDATE ON abos.posting_intents
FOR EACH ROW EXECUTE FUNCTION abos.guard_sandbox_finance_mutation();

CREATE TRIGGER posting_approvals_sandbox_guard
BEFORE INSERT OR UPDATE ON abos.posting_approvals
FOR EACH ROW EXECUTE FUNCTION abos.guard_sandbox_finance_mutation();

CREATE TRIGGER journals_sandbox_guard
BEFORE INSERT OR UPDATE ON abos.journals
FOR EACH ROW EXECUTE FUNCTION abos.guard_sandbox_finance_mutation();

CREATE TRIGGER journal_lines_sandbox_guard
BEFORE INSERT OR UPDATE ON abos.journal_lines
FOR EACH ROW EXECUTE FUNCTION abos.guard_sandbox_finance_mutation();

CREATE TRIGGER subledger_entries_sandbox_guard
BEFORE INSERT OR UPDATE ON abos.subledger_entries
FOR EACH ROW EXECUTE FUNCTION abos.guard_sandbox_finance_mutation();

CREATE TRIGGER cash_receipts_sandbox_guard
BEFORE INSERT OR UPDATE ON abos.cash_receipts
FOR EACH ROW EXECUTE FUNCTION abos.guard_sandbox_finance_mutation();

-- ---------------------------------------------------------------------------
-- Server-side authentication and authorization for the sandbox.
-- ---------------------------------------------------------------------------

CREATE TABLE abos.user_permission_grants (
  user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  permission_code text NOT NULL CHECK (permission_code IN (
    'finance.posting-intent.approve',
    'finance.journal.post',
    'finance.journal.reverse',
    'finance.report.operational.read',
    'treasury.cash-receipt.verify',
    'treasury.cash-count.record',
    'shareholder.capital-intent.create')),
  granted_by_user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  granted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  PRIMARY KEY (user_account_id, legal_entity_id, permission_code),
  -- No self-grant: a sandbox actor cannot widen its own authority.
  CHECK (granted_by_user_account_id <> user_account_id),
  CHECK (revoked_at IS NULL OR revoked_at >= granted_at)
);

CREATE TABLE abos.user_scope_grants (
  user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  scope_kind text NOT NULL CHECK (scope_kind IN ('PROJECT', 'DEPARTMENT', 'COST_CENTER')),
  scope_id uuid NOT NULL,
  granted_by_user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  granted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  PRIMARY KEY (user_account_id, legal_entity_id, scope_kind, scope_id),
  CHECK (granted_by_user_account_id <> user_account_id)
);

-- Short-lived sandbox credentials. Only a SHA-256 of the bearer token is stored; the token itself
-- exists solely in the issuing response.
CREATE TABLE abos.sandbox_sessions (
  id uuid PRIMARY KEY,
  user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  token_sha256 text NOT NULL UNIQUE CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (expires_at > issued_at),
  -- A sandbox credential cannot be long-lived.
  CHECK (expires_at <= issued_at + interval '60 minutes')
);
CREATE INDEX sandbox_sessions_user_idx ON abos.sandbox_sessions(user_account_id, expires_at);

-- ---------------------------------------------------------------------------
-- F-1. Canonical capital-agreement status vocabulary and the funding decision.
-- ---------------------------------------------------------------------------

-- The canonical vocabulary is the persisted one, already enforced by the CHECK on
-- abos.capital_agreements.status in migration 0001. What was missing is the separate, explicit
-- record of which canonical status the business has decided may fund an installment. Without a row
-- here nothing is fundable, so the mismatch can never be resolved by inference.
CREATE TABLE abos.capital_agreement_funding_policies (
  legal_entity_id uuid PRIMARY KEY REFERENCES abos.legal_entities(id),
  vocabulary_version text NOT NULL CHECK (vocabulary_version = 'stage1-e0-v2'),
  decision_reference text NOT NULL CHECK (btrim(decision_reference) <> ''),
  decided_by text NOT NULL
    CHECK (decided_by IN ('SANDBOX_SYNTHETIC', 'OWNER_PROVISIONAL', 'CLIENT_FINANCE')),
  -- DRAFT, SUSPENDED and CLOSED are structurally unfundable and cannot be named here at all.
  fundable_statuses text[] NOT NULL
    CHECK (cardinality(fundable_statuses) > 0
           AND fundable_statuses <@ ARRAY['PENDING_EVIDENCE', 'ELIGIBLE']::text[]),
  decided_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- A CLIENT_FINANCE decision is a real accounting approval and must not be recorded by a synthetic
-- sandbox. While the sandbox authorization is present, only synthetic or owner-provisional
-- decisions are storable.
CREATE OR REPLACE FUNCTION abos.guard_funding_policy_authority()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.decided_by = 'CLIENT_FINANCE'
     AND EXISTS (SELECT 1 FROM abos.sandbox_authorizations WHERE singleton) THEN
    RAISE EXCEPTION 'a synthetic sandbox cannot record a CLIENT_FINANCE funding decision';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER capital_agreement_funding_policies_authority_guard
BEFORE INSERT OR UPDATE ON abos.capital_agreement_funding_policies
FOR EACH ROW EXECUTE FUNCTION abos.guard_funding_policy_authority();

-- F-4 support: the agreement-level partial-installment term the kernel needed and never had.
-- Defaults to false, so an agreement is assumed NOT to permit partial payment until someone says so.
ALTER TABLE abos.capital_agreements
  ADD COLUMN partial_installments_allowed boolean NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- F-2. Persistent capital receipt intent, owned by the shareholder domain.
-- ---------------------------------------------------------------------------

CREATE TABLE abos.capital_receipt_intents (
  id uuid PRIMARY KEY,
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  shareholder_business_party_id uuid NOT NULL,
  capital_agreement_id uuid NOT NULL,
  capital_installment_id uuid NOT NULL,
  amount numeric NOT NULL CHECK (amount > 0),
  currency_code text NOT NULL REFERENCES abos.currencies(code),
  destination_cash_account_id uuid NOT NULL,
  evidence_reference_id uuid NOT NULL,
  correlation_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (btrim(idempotency_key) <> ''),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  business_event_at timestamptz NOT NULL,
  status text NOT NULL
    CHECK (status IN ('DRAFT', 'ELIGIBLE', 'REJECTED', 'TREASURY_VERIFIED', 'POSTED')),
  classification text NOT NULL CHECK (classification IN
    ('PAID_IN_SHARE_CAPITAL', 'UNDETERMINED_PENDING_POLICY', 'SHAREHOLDER_LOAN_PRINCIPAL')),
  contribution_state text NOT NULL
    CHECK (contribution_state IN ('PENDING', 'VERIFIED', 'APPROVED', 'POSTED', 'REJECTED')),
  treasury_cash_receipt_id uuid,
  journal_id uuid,
  version integer NOT NULL CHECK (version > 0),
  created_by_user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),

  -- Source uniqueness, the counterpart of the Finance kernel's own idempotency.
  UNIQUE (legal_entity_id, idempotency_key),
  -- One intent per installment. This is the constraint that makes double-funding an installment
  -- impossible rather than merely checked.
  UNIQUE (legal_entity_id, capital_installment_id),
  UNIQUE (id, legal_entity_id),
  UNIQUE (id, currency_code),

  FOREIGN KEY (capital_agreement_id, legal_entity_id)
    REFERENCES abos.capital_agreements(id, legal_entity_id),
  FOREIGN KEY (capital_agreement_id, currency_code)
    REFERENCES abos.capital_agreements(id, currency_code),
  FOREIGN KEY (capital_installment_id, legal_entity_id)
    REFERENCES abos.capital_installments(id, legal_entity_id),
  FOREIGN KEY (capital_installment_id, currency_code)
    REFERENCES abos.capital_installments(id, currency_code),
  FOREIGN KEY (shareholder_business_party_id, legal_entity_id)
    REFERENCES abos.business_parties(id, legal_entity_id),
  FOREIGN KEY (destination_cash_account_id, legal_entity_id)
    REFERENCES abos.cash_location_currency_accounts(id, legal_entity_id),
  FOREIGN KEY (destination_cash_account_id, currency_code)
    REFERENCES abos.cash_location_currency_accounts(id, currency_code),
  FOREIGN KEY (evidence_reference_id, legal_entity_id)
    REFERENCES abos.evidence_references(id, legal_entity_id),
  FOREIGN KEY (treasury_cash_receipt_id, legal_entity_id)
    REFERENCES abos.cash_receipts(id, legal_entity_id),
  FOREIGN KEY (journal_id, legal_entity_id)
    REFERENCES abos.journals(id, legal_entity_id),

  CHECK (status <> 'TREASURY_VERIFIED' OR treasury_cash_receipt_id IS NOT NULL),
  CHECK (status <> 'POSTED' OR (treasury_cash_receipt_id IS NOT NULL AND journal_id IS NOT NULL)),
  -- A shareholder loan principal can never be recorded as a capital contribution intent.
  CHECK (classification <> 'SHAREHOLDER_LOAN_PRINCIPAL')
);

CREATE INDEX capital_receipt_intents_agreement_idx
  ON abos.capital_receipt_intents(capital_agreement_id, status);

CREATE TRIGGER capital_receipt_intents_sandbox_guard
BEFORE INSERT OR UPDATE ON abos.capital_receipt_intents
FOR EACH ROW EXECUTE FUNCTION abos.guard_sandbox_finance_mutation();

-- Append-only lifecycle history: every state the intent passed through, never rewritten.
CREATE TABLE abos.capital_receipt_intent_history (
  id uuid PRIMARY KEY,
  capital_receipt_intent_id uuid NOT NULL REFERENCES abos.capital_receipt_intents(id),
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL
    CHECK (status IN ('DRAFT', 'ELIGIBLE', 'REJECTED', 'TREASURY_VERIFIED', 'POSTED')),
  contribution_state text NOT NULL
    CHECK (contribution_state IN ('PENDING', 'VERIFIED', 'APPROVED', 'POSTED', 'REJECTED')),
  classification text NOT NULL CHECK (classification IN
    ('PAID_IN_SHARE_CAPITAL', 'UNDETERMINED_PENDING_POLICY', 'SHAREHOLDER_LOAN_PRINCIPAL')),
  amount numeric NOT NULL CHECK (amount > 0),
  currency_code text NOT NULL REFERENCES abos.currencies(code),
  treasury_cash_receipt_id uuid,
  journal_id uuid,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (capital_receipt_intent_id, version)
);

CREATE OR REPLACE FUNCTION abos.prevent_intent_history_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'capital receipt intent history is append-only';
END;
$$;
CREATE TRIGGER capital_receipt_intent_history_no_update_or_delete
BEFORE UPDATE OR DELETE ON abos.capital_receipt_intent_history
FOR EACH ROW EXECUTE FUNCTION abos.prevent_intent_history_mutation();

-- Finance posting intents must reference a real persisted source record, not a bare uuid.
ALTER TABLE abos.posting_intents ADD COLUMN capital_receipt_intent_id uuid;
ALTER TABLE abos.posting_intents
  ADD CONSTRAINT posting_intents_capital_source_fk
  FOREIGN KEY (capital_receipt_intent_id, legal_entity_id)
  REFERENCES abos.capital_receipt_intents(id, legal_entity_id);
ALTER TABLE abos.posting_intents
  ADD CONSTRAINT posting_intents_capital_source_required
  CHECK ((intent_kind = 'SHAREHOLDER_CAPITAL_RECEIPT') = (capital_receipt_intent_id IS NOT NULL));
-- The generic source_id column stays, but for a capital receipt it is now pinned to the referenced
-- row, so source uniqueness is enforced over an identifier the database owns.
ALTER TABLE abos.posting_intents
  ADD CONSTRAINT posting_intents_capital_source_matches_source_id
  CHECK (capital_receipt_intent_id IS NULL OR capital_receipt_intent_id = source_id);

-- The posted intent must agree with its source on entity, installment, amount and currency, and the
-- source must have reached TREASURY_VERIFIED before Finance may value it.
CREATE OR REPLACE FUNCTION abos.validate_capital_source_intent()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_row abos.capital_receipt_intents%ROWTYPE;
BEGIN
  IF NEW.capital_receipt_intent_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO source_row
    FROM abos.capital_receipt_intents
   WHERE id = NEW.capital_receipt_intent_id
     AND legal_entity_id = NEW.legal_entity_id
     FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'posting intent references an unknown capital receipt intent';
  END IF;
  IF source_row.amount <> NEW.original_amount
     OR source_row.currency_code <> NEW.original_currency_code THEN
    RAISE EXCEPTION 'posting intent amount/currency differs from its persisted capital receipt intent';
  END IF;
  IF NEW.status IN ('APPROVED', 'POSTED')
     AND source_row.status NOT IN ('TREASURY_VERIFIED', 'POSTED') THEN
    RAISE EXCEPTION 'capital receipt intent % is % and cannot be approved for posting',
      source_row.id, source_row.status;
  END IF;
  IF NEW.treasury_cash_receipt_id IS NOT NULL
     AND source_row.treasury_cash_receipt_id IS DISTINCT FROM NEW.treasury_cash_receipt_id THEN
    RAISE EXCEPTION 'posting intent and capital receipt intent disagree on the Treasury receipt';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER posting_intents_capital_source_guard
BEFORE INSERT OR UPDATE ON abos.posting_intents
FOR EACH ROW EXECUTE FUNCTION abos.validate_capital_source_intent();

-- ---------------------------------------------------------------------------
-- F-4. Durable, concurrency-safe prevention of over-contribution.
-- ---------------------------------------------------------------------------

-- The agreement row is locked FOR UPDATE before the consumed total is read, so two concurrent
-- installments against the same agreement serialize on that row. Under READ COMMITTED the second
-- transaction re-reads after the lock is released and therefore sees the first one's committed
-- intent; under REPEATABLE READ or SERIALIZABLE it aborts with a serialization failure, which the
-- application retries. Neither path can overrun the commitment.
CREATE OR REPLACE FUNCTION abos.enforce_capital_commitment_ceiling()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  agreement_row abos.capital_agreements%ROWTYPE;
  installment_expected numeric;
  consumed numeric;
  funding_policy abos.capital_agreement_funding_policies%ROWTYPE;
BEGIN
  SELECT * INTO agreement_row
    FROM abos.capital_agreements
   WHERE id = NEW.capital_agreement_id
     AND legal_entity_id = NEW.legal_entity_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'capital receipt intent references an unknown capital agreement';
  END IF;

  IF agreement_row.agreement_kind <> 'CAPITAL_CONTRIBUTION' THEN
    RAISE EXCEPTION 'a shareholder loan agreement cannot fund a capital contribution';
  END IF;

  -- F-1: fundability is read from the recorded decision, never inferred from the status name.
  SELECT * INTO funding_policy
    FROM abos.capital_agreement_funding_policies
   WHERE legal_entity_id = NEW.legal_entity_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no capital-agreement funding policy is recorded for legal entity %; nothing is fundable',
      NEW.legal_entity_id;
  END IF;
  IF NOT (agreement_row.status = ANY (funding_policy.fundable_statuses)) THEN
    RAISE EXCEPTION 'capital agreement status % is not fundable under decision %',
      agreement_row.status, funding_policy.decision_reference;
  END IF;

  IF NEW.currency_code <> agreement_row.currency_code THEN
    RAISE EXCEPTION 'capital receipt currency differs from the agreement denomination currency';
  END IF;

  SELECT expected_amount INTO installment_expected
    FROM abos.capital_installments
   WHERE id = NEW.capital_installment_id
     AND capital_agreement_id = NEW.capital_agreement_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'installment does not belong to the referenced capital agreement';
  END IF;

  IF NEW.amount < installment_expected AND NOT agreement_row.partial_installments_allowed THEN
    RAISE EXCEPTION 'agreement % does not authorize a partial installment', agreement_row.id;
  END IF;
  IF NEW.amount > installment_expected THEN
    RAISE EXCEPTION 'capital receipt exceeds the expected installment amount';
  END IF;

  SELECT coalesce(sum(amount), 0) INTO consumed
    FROM abos.capital_receipt_intents
   WHERE capital_agreement_id = NEW.capital_agreement_id
     AND legal_entity_id = NEW.legal_entity_id
     AND id <> NEW.id
     -- A REJECTED intent releases its share of the commitment. Every other state consumes it.
     AND status IN ('DRAFT', 'ELIGIBLE', 'TREASURY_VERIFIED', 'POSTED');

  IF consumed + NEW.amount > agreement_row.committed_amount THEN
    RAISE EXCEPTION
      'capital contributions would exceed the committed amount: committed %, already consumed %, requested %',
      agreement_row.committed_amount, consumed, NEW.amount
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER capital_receipt_intents_commitment_guard
BEFORE INSERT OR UPDATE OF amount, status, capital_agreement_id, capital_installment_id, currency_code
ON abos.capital_receipt_intents
FOR EACH ROW EXECUTE FUNCTION abos.enforce_capital_commitment_ceiling();

-- An intent whose contribution has been posted is immutable.
CREATE OR REPLACE FUNCTION abos.guard_posted_capital_receipt_intent()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'POSTED' THEN
      RAISE EXCEPTION 'a posted capital receipt intent cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'POSTED' THEN
    RAISE EXCEPTION 'a posted capital receipt intent is immutable';
  END IF;
  IF OLD.amount <> NEW.amount
     OR OLD.currency_code <> NEW.currency_code
     OR OLD.capital_agreement_id <> NEW.capital_agreement_id
     OR OLD.capital_installment_id <> NEW.capital_installment_id
     OR OLD.shareholder_business_party_id <> NEW.shareholder_business_party_id
     OR OLD.destination_cash_account_id <> NEW.destination_cash_account_id
     OR OLD.idempotency_key <> NEW.idempotency_key
     OR OLD.request_fingerprint <> NEW.request_fingerprint THEN
    RAISE EXCEPTION 'the identity of a capital receipt intent cannot be rewritten';
  END IF;
  IF NEW.version <= OLD.version THEN
    RAISE EXCEPTION 'capital receipt intent version must advance on every transition';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER capital_receipt_intents_immutability_guard
BEFORE UPDATE OR DELETE ON abos.capital_receipt_intents
FOR EACH ROW EXECUTE FUNCTION abos.guard_posted_capital_receipt_intent();

-- ---------------------------------------------------------------------------
-- F-5. Reversal segregation of duties.
-- ---------------------------------------------------------------------------

-- Migration 0001 already keeps the posting actor separate from the intent creator, the cashier and
-- the counter, and requires the reversal to be an exact inverse. It does not stop the person who
-- posted a journal from also reversing it.
CREATE OR REPLACE FUNCTION abos.enforce_reversal_segregation_of_duties()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  original_poster uuid;
  reversal_poster uuid;
BEGIN
  SELECT posted_by_user_account_id INTO original_poster
    FROM abos.journals WHERE id = NEW.original_journal_id;
  SELECT posted_by_user_account_id INTO reversal_poster
    FROM abos.journals WHERE id = NEW.reversal_journal_id;

  IF original_poster IS NULL OR reversal_poster IS NULL THEN
    RAISE EXCEPTION 'a reversal link requires both journals to record their posting actor';
  END IF;
  IF original_poster = reversal_poster THEN
    RAISE EXCEPTION 'the actor who posted a journal cannot also post its reversal';
  END IF;
  IF NEW.approved_by_user_account_id = original_poster THEN
    RAISE EXCEPTION 'the actor who posted a journal cannot approve its reversal';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER journal_reversal_links_sod_guard
BEFORE INSERT ON abos.journal_reversal_links
FOR EACH ROW EXECUTE FUNCTION abos.enforce_reversal_segregation_of_duties();

-- ---------------------------------------------------------------------------
-- F-7. Physical cash count validation.
-- ---------------------------------------------------------------------------

-- Migration 0001 requires a verified receipt to carry a physical_cash_count_id and constrains it to
-- the same account and currency by composite foreign key. It does not require the count to have
-- been confirmed, nor to be consistent with the received amount or the moment of receipt.
--
-- Open question deliberately not decided here: whether counted_amount is a count of the cash
-- received or of the whole safe after receipt. The constraint below is the weaker of the two
-- readings (the safe must at least contain what was received) so that neither reading is foreclosed.
-- Recorded for the Finance Manager in the handoff.
CREATE OR REPLACE FUNCTION abos.validate_physical_cash_count_for_receipt()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE count_row abos.physical_cash_counts%ROWTYPE;
BEGIN
  IF NEW.status <> 'VERIFIED' THEN
    RETURN NEW;
  END IF;
  SELECT * INTO count_row
    FROM abos.physical_cash_counts
   WHERE id = NEW.physical_cash_count_id
     FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'verified cash receipt references an unknown physical cash count';
  END IF;
  IF count_row.legal_entity_id <> NEW.legal_entity_id THEN
    RAISE EXCEPTION 'physical cash count belongs to another legal entity';
  END IF;
  IF count_row.cash_location_currency_account_id <> NEW.cash_location_currency_account_id THEN
    RAISE EXCEPTION 'physical cash count belongs to another cash currency account';
  END IF;
  IF count_row.currency_code <> NEW.currency_code THEN
    RAISE EXCEPTION 'physical cash count currency differs from the receipt currency';
  END IF;
  IF count_row.status <> 'CONFIRMED' THEN
    RAISE EXCEPTION 'physical cash count % is % and has not been confirmed', count_row.id, count_row.status;
  END IF;
  IF count_row.counted_at < NEW.business_event_at THEN
    RAISE EXCEPTION 'physical cash count predates the receipt it is claimed to evidence';
  END IF;
  IF count_row.counted_amount < NEW.amount THEN
    RAISE EXCEPTION 'physical cash count % is below the received amount %',
      count_row.counted_amount, NEW.amount;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cash_receipts_physical_count_guard
BEFORE INSERT OR UPDATE ON abos.cash_receipts
FOR EACH ROW EXECUTE FUNCTION abos.validate_physical_cash_count_for_receipt();

-- ---------------------------------------------------------------------------
-- Posting-time restatement of the gate.
-- ---------------------------------------------------------------------------

-- The per-table guards above already refuse an unauthorized session. This one restates the same
-- refusal at the single most consequential moment, so that a future table whose guard is forgotten
-- still cannot result in a posted journal, and so that the funding decision is re-checked against
-- the agreement as it stands at posting time rather than as it stood when the intent was created.
CREATE OR REPLACE FUNCTION abos.validate_e1_sandbox_posting()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  intent_kind text;
  source_intent_id uuid;
  agreement_status text;
  funding_policy abos.capital_agreement_funding_policies%ROWTYPE;
BEGIN
  IF NEW.status <> 'POSTED' THEN
    RETURN NEW;
  END IF;
  PERFORM abos.assert_sandbox_mutation_authorized(NEW.legal_entity_id);

  SELECT pi.intent_kind, pi.capital_receipt_intent_id
    INTO intent_kind, source_intent_id
    FROM abos.posting_intents pi
   WHERE pi.id = NEW.posting_intent_id AND pi.legal_entity_id = NEW.legal_entity_id;

  IF intent_kind = 'SHAREHOLDER_CAPITAL_RECEIPT' THEN
    IF source_intent_id IS NULL THEN
      RAISE EXCEPTION 'a capital receipt journal requires a persisted capital receipt intent';
    END IF;
    SELECT ca.status INTO agreement_status
      FROM abos.capital_receipt_intents cri
      JOIN abos.capital_agreements ca
        ON ca.id = cri.capital_agreement_id AND ca.legal_entity_id = cri.legal_entity_id
     WHERE cri.id = source_intent_id AND cri.legal_entity_id = NEW.legal_entity_id
       FOR SHARE OF ca;
    SELECT * INTO funding_policy
      FROM abos.capital_agreement_funding_policies
     WHERE legal_entity_id = NEW.legal_entity_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'no capital-agreement funding policy is recorded; capital cannot be posted';
    END IF;
    IF agreement_status IS NULL OR NOT (agreement_status = ANY (funding_policy.fundable_statuses)) THEN
      RAISE EXCEPTION 'capital agreement status % is not fundable under decision % at posting time',
        agreement_status, funding_policy.decision_reference;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER journals_e1_sandbox_posting_guard
BEFORE INSERT OR UPDATE ON abos.journals
FOR EACH ROW EXECUTE FUNCTION abos.validate_e1_sandbox_posting();
