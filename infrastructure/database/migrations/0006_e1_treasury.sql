-- Stage 1 E1 Treasury domain.
--
-- Builds on the Treasury tables migration 0001 already owns (cash_locations,
-- cash_location_currency_accounts, physical_cash_counts, cash_receipts). It does not add a second
-- cash model. What it adds is the control layer those tables were missing:
--
--   * authorized cashier assignment per physical cash location;
--   * an opening reconciliation that must be counted, reconciled and independently approved
--     before a currency account inside a safe can become ACTIVE;
--   * a receipt lifecycle - DRAFT, COUNTED, submitted, VERIFIED or VOIDED - with segregation of
--     duties enforced on the stored rows, not only in application code;
--   * binding every receipt to one eligible shareholder capital receipt intent, so the shareholder,
--     agreement, installment, currency, amount and destination are preserved end to end;
--   * an explicit, persistent handoff to Finance, without which no capital posting intent can exist;
--   * an append-only audit history of every Treasury mutation.
--
-- Treasury never writes the General Ledger. Nothing here inserts into journals, journal_lines or
-- subledger_entries, and nothing here creates a ledger account.
--
-- Caveat carried from migration 0004: the session settings this migration reads
-- (abos.runtime_marker, abos.actor_user_account_id) can be set by anyone holding a database
-- connection with write privileges. They bind audit rows to the acting user and let the database
-- check that user's grants; they are not a privilege boundary. Until the controlled write API that
-- 0004 describes exists, Treasury writes need an owner connection, exactly like Finance posting.

-- ---------------------------------------------------------------------------
-- Treasury permissions.
-- ---------------------------------------------------------------------------

ALTER TABLE abos.user_permission_grants
  DROP CONSTRAINT user_permission_grants_permission_code_check;
ALTER TABLE abos.user_permission_grants
  ADD CONSTRAINT user_permission_grants_permission_code_check CHECK (permission_code IN (
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

-- The acting user for a Treasury mutation. There is no default: an unattributed write is refused.
CREATE OR REPLACE FUNCTION abos.treasury_actor()
RETURNS uuid LANGUAGE plpgsql STABLE AS $$
DECLARE
  raw text := current_setting('abos.actor_user_account_id', true);
  actor uuid;
BEGIN
  IF raw IS NULL OR btrim(raw) = '' THEN
    RAISE EXCEPTION 'Treasury mutation requires an identified acting user'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  actor := raw::uuid;
  IF NOT EXISTS (SELECT 1 FROM abos.user_accounts WHERE id = actor AND status = 'ACTIVE') THEN
    RAISE EXCEPTION 'Treasury acting user % is not an active user account', actor
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN actor;
END;
$$;

CREATE OR REPLACE FUNCTION abos.user_holds_permission(
  target_user uuid, target_entity uuid, target_permission text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM abos.user_permission_grants g
      JOIN abos.user_accounts u ON u.id = g.user_account_id
     WHERE g.user_account_id = target_user
       AND g.legal_entity_id = target_entity
       AND g.permission_code = target_permission
       AND g.revoked_at IS NULL
       AND u.status = 'ACTIVE');
$$;

CREATE OR REPLACE FUNCTION abos.require_treasury_permission(
  target_user uuid, target_entity uuid, target_permission text, action text)
RETURNS void LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF NOT abos.user_holds_permission(target_user, target_entity, target_permission) THEN
    RAISE EXCEPTION '% requires % in legal entity %', action, target_permission, target_entity
      USING ERRCODE = 'insufficient_privilege';
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- Physical cash locations.
-- ---------------------------------------------------------------------------

ALTER TABLE abos.cash_locations
  ADD COLUMN location_kind text NOT NULL DEFAULT 'OFFICE_SAFE'
    CHECK (location_kind IN ('OFFICE_SAFE'));

CREATE OR REPLACE FUNCTION abos.guard_cash_location()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor uuid := abos.treasury_actor();
BEGIN
  PERFORM abos.require_treasury_permission(actor, NEW.legal_entity_id,
    'treasury.cash-location.manage', 'Managing a cash location');
  IF TG_OP = 'UPDATE' AND (OLD.legal_entity_id <> NEW.legal_entity_id
                           OR OLD.location_kind <> NEW.location_kind) THEN
    RAISE EXCEPTION 'the legal entity and kind of a cash location cannot change';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cash_locations_treasury_guard
BEFORE INSERT OR UPDATE ON abos.cash_locations
FOR EACH ROW EXECUTE FUNCTION abos.guard_cash_location();

CREATE TRIGGER cash_locations_sandbox_guard
BEFORE INSERT OR UPDATE ON abos.cash_locations
FOR EACH ROW EXECUTE FUNCTION abos.guard_sandbox_finance_mutation();

-- ---------------------------------------------------------------------------
-- Authorized cashier assignment.
-- ---------------------------------------------------------------------------

CREATE TABLE abos.cash_location_cashier_assignments (
  id uuid PRIMARY KEY,
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  cash_location_id uuid NOT NULL,
  user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  assigned_by_user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  assigned_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_by_user_account_id uuid REFERENCES abos.user_accounts(id),
  revoked_at timestamptz,
  FOREIGN KEY (cash_location_id, legal_entity_id)
    REFERENCES abos.cash_locations(id, legal_entity_id),
  -- Nobody assigns themselves custody of cash.
  CHECK (assigned_by_user_account_id <> user_account_id),
  CHECK ((revoked_at IS NULL) = (revoked_by_user_account_id IS NULL)),
  CHECK (revoked_at IS NULL OR revoked_at >= assigned_at)
);
CREATE UNIQUE INDEX cash_location_cashier_assignments_active_uq
  ON abos.cash_location_cashier_assignments(cash_location_id, user_account_id)
  WHERE revoked_at IS NULL;

CREATE OR REPLACE FUNCTION abos.guard_cashier_assignment()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor uuid := abos.treasury_actor();
BEGIN
  PERFORM abos.require_treasury_permission(actor, NEW.legal_entity_id,
    'treasury.cash-location.manage', 'Assigning a cashier');
  IF TG_OP = 'INSERT' THEN
    IF NEW.assigned_by_user_account_id <> actor THEN
      RAISE EXCEPTION 'a cashier assignment must be recorded by the acting user';
    END IF;
    IF NEW.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'a cashier assignment cannot be created already revoked';
    END IF;
    IF NOT abos.user_holds_permission(NEW.user_account_id, NEW.legal_entity_id,
                                      'treasury.cash-receipt.record') THEN
      RAISE EXCEPTION 'only a user holding treasury.cash-receipt.record can be assigned as cashier';
    END IF;
  ELSE
    IF OLD.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'a revoked cashier assignment is final';
    END IF;
    IF OLD.user_account_id <> NEW.user_account_id
       OR OLD.cash_location_id <> NEW.cash_location_id
       OR OLD.assigned_by_user_account_id <> NEW.assigned_by_user_account_id
       OR OLD.assigned_at <> NEW.assigned_at THEN
      RAISE EXCEPTION 'a cashier assignment can only be revoked, not rewritten';
    END IF;
    IF NEW.revoked_by_user_account_id IS DISTINCT FROM actor THEN
      RAISE EXCEPTION 'a cashier assignment must be revoked by the acting user';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cash_location_cashier_assignments_guard
BEFORE INSERT OR UPDATE ON abos.cash_location_cashier_assignments
FOR EACH ROW EXECUTE FUNCTION abos.guard_cashier_assignment();
CREATE TRIGGER cash_location_cashier_assignments_sandbox_guard
BEFORE INSERT OR UPDATE ON abos.cash_location_cashier_assignments
FOR EACH ROW EXECUTE FUNCTION abos.guard_sandbox_finance_mutation();

CREATE OR REPLACE FUNCTION abos.prevent_assignment_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'cashier assignments are revoked, never deleted';
END;
$$;
CREATE TRIGGER cash_location_cashier_assignments_no_delete
BEFORE DELETE ON abos.cash_location_cashier_assignments
FOR EACH ROW EXECUTE FUNCTION abos.prevent_assignment_delete();

CREATE OR REPLACE FUNCTION abos.is_assigned_cashier(target_user uuid, target_account uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1
      FROM abos.cash_location_currency_accounts account
      JOIN abos.cash_location_cashier_assignments assignment
        ON assignment.cash_location_id = account.cash_location_id
       AND assignment.legal_entity_id = account.legal_entity_id
     WHERE account.id = target_account
       AND assignment.user_account_id = target_user
       AND assignment.revoked_at IS NULL);
$$;

-- ---------------------------------------------------------------------------
-- Physical cash counts.
-- ---------------------------------------------------------------------------

ALTER TABLE abos.physical_cash_counts
  ADD COLUMN count_purpose text NOT NULL DEFAULT 'RECEIPT'
    CHECK (count_purpose IN ('OPENING', 'RECEIPT'));

-- A count is recorded by one person and confirmed by another. It cannot be inserted already
-- confirmed, and once confirmed or voided it is final.
CREATE OR REPLACE FUNCTION abos.guard_physical_cash_count()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor uuid := abos.treasury_actor();
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'RECORDED' OR NEW.confirmed_by_user_account_id IS NOT NULL
       OR NEW.confirmed_at IS NOT NULL THEN
      RAISE EXCEPTION 'a physical cash count must be recorded before it can be confirmed';
    END IF;
    IF NEW.counted_by_user_account_id <> actor THEN
      RAISE EXCEPTION 'a physical cash count must be recorded by the person who counted';
    END IF;
    IF NEW.evidence_reference_id IS NULL THEN
      RAISE EXCEPTION 'a physical cash count requires count evidence';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM abos.evidence_references
                    WHERE id = NEW.evidence_reference_id
                      AND legal_entity_id = NEW.legal_entity_id
                      AND evidence_kind = 'PHYSICAL_CASH_COUNT') THEN
      RAISE EXCEPTION 'a physical cash count requires PHYSICAL_CASH_COUNT evidence';
    END IF;
    PERFORM abos.require_treasury_permission(actor, NEW.legal_entity_id,
      'treasury.cash-count.record', 'Recording a physical cash count');
    IF NEW.count_purpose = 'RECEIPT'
       AND NOT abos.is_assigned_cashier(actor, NEW.cash_location_currency_account_id) THEN
      RAISE EXCEPTION 'a receipt count must be recorded by a cashier assigned to that cash location';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status IN ('CONFIRMED', 'VOIDED') THEN
    -- 0001's provenance guard separately protects a count behind a posted journal.
    RAISE EXCEPTION 'a % physical cash count is final', OLD.status;
  END IF;
  IF OLD.cash_location_currency_account_id <> NEW.cash_location_currency_account_id
     OR OLD.currency_code <> NEW.currency_code
     OR OLD.counted_amount <> NEW.counted_amount
     OR OLD.counted_at <> NEW.counted_at
     OR OLD.counted_by_user_account_id <> NEW.counted_by_user_account_id
     OR OLD.evidence_reference_id IS DISTINCT FROM NEW.evidence_reference_id
     OR OLD.count_purpose <> NEW.count_purpose THEN
    RAISE EXCEPTION 'a recorded physical cash count cannot be rewritten; void it and count again';
  END IF;
  IF NEW.status = 'CONFIRMED' THEN
    IF NEW.confirmed_by_user_account_id IS DISTINCT FROM actor THEN
      RAISE EXCEPTION 'a physical cash count must be confirmed by the acting user';
    END IF;
    PERFORM abos.require_treasury_permission(actor, NEW.legal_entity_id,
      CASE NEW.count_purpose WHEN 'OPENING' THEN 'treasury.cash-account.approve'
                             ELSE 'treasury.cash-receipt.verify' END,
      'Confirming a physical cash count');
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER physical_cash_counts_treasury_guard
BEFORE INSERT OR UPDATE ON abos.physical_cash_counts
FOR EACH ROW EXECUTE FUNCTION abos.guard_physical_cash_count();
CREATE TRIGGER physical_cash_counts_sandbox_guard
BEFORE INSERT OR UPDATE ON abos.physical_cash_counts
FOR EACH ROW EXECUTE FUNCTION abos.guard_sandbox_finance_mutation();

-- ---------------------------------------------------------------------------
-- Opening reconciliation and account activation.
-- ---------------------------------------------------------------------------

-- The opening position of a currency account inside a safe. It is a physical count, reconciled
-- by one person and approved by another. The amount is whatever was counted; this migration does
-- not supply one, and a synthetic sandbox counts a synthetic safe.
CREATE TABLE abos.cash_account_openings (
  cash_location_currency_account_id uuid PRIMARY KEY,
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  currency_code text NOT NULL REFERENCES abos.currencies(code),
  opening_counted_amount numeric NOT NULL CHECK (opening_counted_amount >= 0),
  physical_cash_count_id uuid NOT NULL UNIQUE,
  reconciliation_evidence_reference_id uuid NOT NULL,
  reconciled_by_user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  reconciled_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  approved_by_user_account_id uuid REFERENCES abos.user_accounts(id),
  approved_at timestamptz,
  status text NOT NULL DEFAULT 'RECONCILED' CHECK (status IN ('RECONCILED', 'APPROVED')),
  FOREIGN KEY (cash_location_currency_account_id, legal_entity_id)
    REFERENCES abos.cash_location_currency_accounts(id, legal_entity_id),
  FOREIGN KEY (cash_location_currency_account_id, currency_code)
    REFERENCES abos.cash_location_currency_accounts(id, currency_code),
  FOREIGN KEY (physical_cash_count_id, cash_location_currency_account_id, currency_code)
    REFERENCES abos.physical_cash_counts(id, cash_location_currency_account_id, currency_code),
  FOREIGN KEY (reconciliation_evidence_reference_id, legal_entity_id)
    REFERENCES abos.evidence_references(id, legal_entity_id),
  CHECK (approved_by_user_account_id IS NULL OR approved_by_user_account_id <> reconciled_by_user_account_id),
  CHECK ((status = 'APPROVED') = (approved_by_user_account_id IS NOT NULL AND approved_at IS NOT NULL))
);

CREATE OR REPLACE FUNCTION abos.guard_cash_account_opening()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  actor uuid := abos.treasury_actor();
  count_row abos.physical_cash_counts%ROWTYPE;
  evidence_kind text;
BEGIN
  SELECT * INTO count_row FROM abos.physical_cash_counts WHERE id = NEW.physical_cash_count_id;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'RECONCILED' THEN
      RAISE EXCEPTION 'an opening position is reconciled before it is approved';
    END IF;
    IF NEW.reconciled_by_user_account_id <> actor THEN
      RAISE EXCEPTION 'an opening reconciliation must be recorded by the acting user';
    END IF;
    PERFORM abos.require_treasury_permission(actor, NEW.legal_entity_id,
      'treasury.cash-account.reconcile', 'Reconciling an opening position');
    IF count_row.count_purpose <> 'OPENING' OR count_row.status <> 'CONFIRMED' THEN
      RAISE EXCEPTION 'an opening reconciliation needs a confirmed OPENING physical cash count';
    END IF;
    IF count_row.counted_amount <> NEW.opening_counted_amount THEN
      RAISE EXCEPTION 'the opening amount must equal the confirmed physical count';
    END IF;
    SELECT er.evidence_kind INTO evidence_kind FROM abos.evidence_references er
     WHERE er.id = NEW.reconciliation_evidence_reference_id;
    IF evidence_kind IS DISTINCT FROM 'OPENING_RECONCILIATION' THEN
      RAISE EXCEPTION 'an opening reconciliation needs OPENING_RECONCILIATION evidence';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'APPROVED' THEN
    RAISE EXCEPTION 'an approved opening position is final';
  END IF;
  IF OLD.opening_counted_amount <> NEW.opening_counted_amount
     OR OLD.physical_cash_count_id <> NEW.physical_cash_count_id
     OR OLD.reconciled_by_user_account_id <> NEW.reconciled_by_user_account_id
     OR OLD.reconciliation_evidence_reference_id <> NEW.reconciliation_evidence_reference_id THEN
    RAISE EXCEPTION 'a reconciled opening position cannot be rewritten';
  END IF;
  IF NEW.status = 'APPROVED' THEN
    IF NEW.approved_by_user_account_id IS DISTINCT FROM actor THEN
      RAISE EXCEPTION 'an opening position must be approved by the acting user';
    END IF;
    IF actor = count_row.counted_by_user_account_id THEN
      RAISE EXCEPTION 'the person who counted the opening cash cannot approve the opening position';
    END IF;
    PERFORM abos.require_treasury_permission(actor, NEW.legal_entity_id,
      'treasury.cash-account.approve', 'Approving an opening position');
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cash_account_openings_guard
BEFORE INSERT OR UPDATE ON abos.cash_account_openings
FOR EACH ROW EXECUTE FUNCTION abos.guard_cash_account_opening();
CREATE TRIGGER cash_account_openings_sandbox_guard
BEFORE INSERT OR UPDATE ON abos.cash_account_openings
FOR EACH ROW EXECUTE FUNCTION abos.guard_sandbox_finance_mutation();

-- Each currency inside a safe is its own account with its own lifecycle. USD being ACTIVE says
-- nothing about AFN. Activation walks DRAFT -> RECONCILED -> APPROVED -> ACTIVE, and every step
-- depends on the opening position having reached the matching state.
CREATE OR REPLACE FUNCTION abos.guard_cash_account_lifecycle()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  actor uuid := abos.treasury_actor();
  opening abos.cash_account_openings%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM abos.require_treasury_permission(actor, NEW.legal_entity_id,
      'treasury.cash-location.manage', 'Opening a cash currency account');
    IF NEW.activation_status <> 'DRAFT' THEN
      RAISE EXCEPTION 'a cash currency account starts as DRAFT and is activated by reconciliation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.cash_location_id <> NEW.cash_location_id
     OR OLD.currency_code <> NEW.currency_code
     OR OLD.ledger_account_id <> NEW.ledger_account_id
     OR OLD.legal_entity_id <> NEW.legal_entity_id THEN
    RAISE EXCEPTION 'a cash currency account cannot change its safe, currency or ledger mapping';
  END IF;
  IF OLD.activation_status = NEW.activation_status THEN
    RETURN NEW;
  END IF;

  SELECT * INTO opening FROM abos.cash_account_openings
   WHERE cash_location_currency_account_id = NEW.id;

  IF OLD.activation_status = 'DRAFT' AND NEW.activation_status = 'RECONCILED' THEN
    PERFORM abos.require_treasury_permission(actor, NEW.legal_entity_id,
      'treasury.cash-account.reconcile', 'Marking a cash account reconciled');
    IF opening.cash_location_currency_account_id IS NULL THEN
      RAISE EXCEPTION 'a cash account is RECONCILED only after its opening position is reconciled';
    END IF;
  ELSIF OLD.activation_status = 'RECONCILED' AND NEW.activation_status = 'APPROVED' THEN
    PERFORM abos.require_treasury_permission(actor, NEW.legal_entity_id,
      'treasury.cash-account.approve', 'Approving a cash account');
    IF opening.status IS DISTINCT FROM 'APPROVED' THEN
      RAISE EXCEPTION 'a cash account is APPROVED only after its opening position is approved';
    END IF;
  ELSIF OLD.activation_status = 'APPROVED' AND NEW.activation_status = 'ACTIVE' THEN
    PERFORM abos.require_treasury_permission(actor, NEW.legal_entity_id,
      'treasury.cash-account.approve', 'Activating a cash account');
    IF NEW.activated_by_user_account_id IS DISTINCT FROM actor THEN
      RAISE EXCEPTION 'a cash account must be activated by the acting user';
    END IF;
    IF actor = opening.reconciled_by_user_account_id THEN
      RAISE EXCEPTION 'the person who reconciled the opening position cannot activate the account';
    END IF;
    IF NEW.reconciliation_evidence_reference_id IS DISTINCT FROM opening.reconciliation_evidence_reference_id THEN
      RAISE EXCEPTION 'activation must cite the opening reconciliation evidence';
    END IF;
  ELSIF NEW.activation_status = 'BLOCKED' AND OLD.activation_status IN ('ACTIVE', 'APPROVED', 'RECONCILED') THEN
    PERFORM abos.require_treasury_permission(actor, NEW.legal_entity_id,
      'treasury.cash-account.approve', 'Blocking a cash account');
  ELSIF OLD.activation_status = 'BLOCKED' AND NEW.activation_status = 'ACTIVE' THEN
    PERFORM abos.require_treasury_permission(actor, NEW.legal_entity_id,
      'treasury.cash-account.approve', 'Reactivating a cash account');
    IF opening.status IS DISTINCT FROM 'APPROVED' THEN
      RAISE EXCEPTION 'a blocked account can be reactivated only with an approved opening position';
    END IF;
  ELSE
    RAISE EXCEPTION 'cash account transition % -> % is not permitted',
      OLD.activation_status, NEW.activation_status;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cash_location_currency_accounts_lifecycle_guard
BEFORE INSERT OR UPDATE ON abos.cash_location_currency_accounts
FOR EACH ROW EXECUTE FUNCTION abos.guard_cash_account_lifecycle();
CREATE TRIGGER cash_location_currency_accounts_sandbox_guard
BEFORE INSERT OR UPDATE ON abos.cash_location_currency_accounts
FOR EACH ROW EXECUTE FUNCTION abos.guard_sandbox_finance_mutation();

-- ---------------------------------------------------------------------------
-- Receipts: bound to a shareholder source, counted, independently verified.
-- ---------------------------------------------------------------------------

ALTER TABLE abos.cash_receipts
  ADD COLUMN capital_receipt_intent_id uuid,
  ADD COLUMN submitted_for_verification_at timestamptz,
  ADD COLUMN voided_by_user_account_id uuid REFERENCES abos.user_accounts(id),
  ADD COLUMN voided_at timestamptz,
  ADD COLUMN void_reason text;
ALTER TABLE abos.cash_receipts
  ADD CONSTRAINT cash_receipts_capital_source_fk
  FOREIGN KEY (capital_receipt_intent_id, legal_entity_id)
  REFERENCES abos.capital_receipt_intents(id, legal_entity_id);
-- NOT VALID: enforced for every new or changed row without asserting anything about rows a
-- previous sandbox may already hold.
ALTER TABLE abos.cash_receipts
  ADD CONSTRAINT cash_receipts_installment_has_source
  CHECK ((capital_installment_id IS NULL) = (capital_receipt_intent_id IS NULL)) NOT VALID;
ALTER TABLE abos.cash_receipts
  ADD CONSTRAINT cash_receipts_void_is_explained
  CHECK ((status = 'VOIDED') = (voided_by_user_account_id IS NOT NULL AND voided_at IS NOT NULL
                                AND void_reason IS NOT NULL AND btrim(void_reason) <> '')) NOT VALID;

-- One live receipt per capital receipt intent. A voided receipt releases the intent.
CREATE UNIQUE INDEX cash_receipts_one_live_receipt_per_intent
  ON abos.cash_receipts(capital_receipt_intent_id)
  WHERE capital_receipt_intent_id IS NOT NULL AND status <> 'VOIDED';
-- One count evidences one receipt.
CREATE UNIQUE INDEX cash_receipts_one_receipt_per_count
  ON abos.cash_receipts(physical_cash_count_id)
  WHERE physical_cash_count_id IS NOT NULL AND status <> 'VOIDED';

CREATE OR REPLACE FUNCTION abos.guard_treasury_receipt()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  actor uuid := abos.treasury_actor();
  source_row abos.capital_receipt_intents%ROWTYPE;
  account_status text;
  location_status text;
  count_row abos.physical_cash_counts%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' OR NEW.physical_cash_count_id IS NOT NULL
       OR NEW.verified_by_user_account_id IS NOT NULL OR NEW.verified_at IS NOT NULL
       OR NEW.submitted_for_verification_at IS NOT NULL THEN
      RAISE EXCEPTION 'a cash receipt is recorded as DRAFT; counting and verification come later';
    END IF;
    IF NEW.received_by_user_account_id <> actor THEN
      RAISE EXCEPTION 'a cash receipt must be recorded by the cashier who received the cash';
    END IF;
    IF NEW.capital_receipt_intent_id IS NULL THEN
      RAISE EXCEPTION 'every E1 cash receipt must answer an eligible shareholder capital receipt intent';
    END IF;
  ELSE
    IF OLD.status IN ('VERIFIED', 'VOIDED') THEN
      RAISE EXCEPTION 'a % cash receipt is final', OLD.status;
    END IF;
    IF OLD.legal_entity_id <> NEW.legal_entity_id
       OR OLD.capital_receipt_intent_id IS DISTINCT FROM NEW.capital_receipt_intent_id
       OR OLD.capital_installment_id IS DISTINCT FROM NEW.capital_installment_id
       OR OLD.cash_location_currency_account_id <> NEW.cash_location_currency_account_id
       OR OLD.amount <> NEW.amount
       OR OLD.currency_code <> NEW.currency_code
       OR OLD.received_by_user_account_id <> NEW.received_by_user_account_id
       OR OLD.receipt_reference <> NEW.receipt_reference
       OR OLD.business_event_at <> NEW.business_event_at THEN
      RAISE EXCEPTION 'the identity of a cash receipt cannot be rewritten';
    END IF;
  END IF;

  -- The source intent: same shareholder installment, destination, currency and amount.
  SELECT * INTO source_row FROM abos.capital_receipt_intents
   WHERE id = NEW.capital_receipt_intent_id AND legal_entity_id = NEW.legal_entity_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'cash receipt references an unknown capital receipt intent';
  END IF;
  IF source_row.capital_installment_id IS DISTINCT FROM NEW.capital_installment_id
     OR source_row.destination_cash_account_id <> NEW.cash_location_currency_account_id
     OR source_row.currency_code <> NEW.currency_code
     OR source_row.amount <> NEW.amount THEN
    RAISE EXCEPTION 'cash receipt must preserve the source installment, destination, currency and amount';
  END IF;
  IF NEW.status <> 'VOIDED' AND source_row.status <> 'ELIGIBLE' THEN
    RAISE EXCEPTION 'capital receipt intent % is % and cannot take a Treasury receipt',
      source_row.id, source_row.status;
  END IF;

  IF NEW.status <> 'VOIDED' THEN
    SELECT account.activation_status, location.status INTO account_status, location_status
      FROM abos.cash_location_currency_accounts account
      JOIN abos.cash_locations location
        ON location.id = account.cash_location_id AND location.legal_entity_id = account.legal_entity_id
     WHERE account.id = NEW.cash_location_currency_account_id
     FOR SHARE OF account;
    IF account_status IS DISTINCT FROM 'ACTIVE' OR location_status IS DISTINCT FROM 'ACTIVE' THEN
      RAISE EXCEPTION 'cash can only be received into an ACTIVE currency account of an ACTIVE safe';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    PERFORM abos.require_treasury_permission(actor, NEW.legal_entity_id,
      'treasury.cash-receipt.record', 'Recording a cash receipt');
    IF NOT abos.is_assigned_cashier(actor, NEW.cash_location_currency_account_id) THEN
      RAISE EXCEPTION 'only a cashier assigned to this cash location can record a receipt into it';
    END IF;
    RETURN NEW;
  END IF;

  -- Transitions.
  IF NEW.status = 'VOIDED' THEN
    IF NEW.voided_by_user_account_id IS DISTINCT FROM actor THEN
      RAISE EXCEPTION 'a cash receipt must be voided by the acting user';
    END IF;
    IF actor <> OLD.received_by_user_account_id
       AND NOT abos.user_holds_permission(actor, NEW.legal_entity_id, 'treasury.cash-receipt.verify') THEN
      RAISE EXCEPTION 'only the receiving cashier or a Treasury verifier can void a receipt';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'DRAFT' AND NEW.status = 'COUNTED' THEN
    IF NEW.physical_cash_count_id IS NULL OR NEW.evidence_reference_id IS NULL THEN
      RAISE EXCEPTION 'a counted receipt needs a physical cash count and receipt evidence';
    END IF;
    SELECT * INTO count_row FROM abos.physical_cash_counts WHERE id = NEW.physical_cash_count_id;
    IF count_row.count_purpose <> 'RECEIPT' OR count_row.status <> 'RECORDED' THEN
      RAISE EXCEPTION 'a receipt is counted with a freshly RECORDED receipt count';
    END IF;
    IF count_row.counted_by_user_account_id <> actor THEN
      RAISE EXCEPTION 'the count must be attached by the person who recorded it';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM abos.evidence_references
                    WHERE id = NEW.evidence_reference_id AND evidence_kind = 'CASH_RECEIPT'
                      AND legal_entity_id = NEW.legal_entity_id) THEN
      RAISE EXCEPTION 'a counted receipt needs CASH_RECEIPT evidence';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'COUNTED' AND NEW.status = 'COUNTED' THEN
    IF OLD.physical_cash_count_id IS DISTINCT FROM NEW.physical_cash_count_id
       OR OLD.evidence_reference_id IS DISTINCT FROM NEW.evidence_reference_id THEN
      RAISE EXCEPTION 'a counted receipt keeps its count and evidence; void it to recount';
    END IF;
    IF OLD.submitted_for_verification_at IS NOT NULL THEN
      RAISE EXCEPTION 'this receipt has already been submitted for verification';
    END IF;
    IF NEW.submitted_for_verification_at IS NULL THEN
      RETURN NEW;
    END IF;
    IF actor <> OLD.received_by_user_account_id THEN
      RAISE EXCEPTION 'the receiving cashier submits the receipt for verification';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'COUNTED' AND NEW.status = 'VERIFIED' THEN
    IF OLD.submitted_for_verification_at IS NULL THEN
      RAISE EXCEPTION 'a receipt must be submitted for verification before it can be verified';
    END IF;
    IF OLD.physical_cash_count_id IS DISTINCT FROM NEW.physical_cash_count_id
       OR OLD.evidence_reference_id IS DISTINCT FROM NEW.evidence_reference_id THEN
      RAISE EXCEPTION 'verification cannot swap the count or evidence';
    END IF;
    IF NEW.verified_by_user_account_id IS DISTINCT FROM actor THEN
      RAISE EXCEPTION 'a receipt must be verified by the acting user';
    END IF;
    PERFORM abos.require_treasury_permission(actor, NEW.legal_entity_id,
      'treasury.cash-receipt.verify', 'Verifying a cash receipt');
    SELECT * INTO count_row FROM abos.physical_cash_counts WHERE id = NEW.physical_cash_count_id;
    IF actor = count_row.counted_by_user_account_id OR actor = NEW.received_by_user_account_id THEN
      RAISE EXCEPTION 'the verifier must be independent of the cashier and the counter';
    END IF;
    IF count_row.confirmed_by_user_account_id IS DISTINCT FROM actor THEN
      RAISE EXCEPTION 'the verifier must personally confirm the physical cash count';
    END IF;
    -- The F-7 guard from 0002 then checks the confirmed count against the receipt.
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'cash receipt transition % -> % is not permitted', OLD.status, NEW.status;
END;
$$;
CREATE TRIGGER cash_receipts_treasury_guard
BEFORE INSERT OR UPDATE ON abos.cash_receipts
FOR EACH ROW EXECUTE FUNCTION abos.guard_treasury_receipt();

-- ---------------------------------------------------------------------------
-- Handoff to Finance.
-- ---------------------------------------------------------------------------

CREATE TABLE abos.treasury_finance_handoffs (
  id uuid PRIMARY KEY,
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  cash_receipt_id uuid NOT NULL UNIQUE,
  capital_receipt_intent_id uuid NOT NULL UNIQUE,
  handed_off_by_user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  handed_off_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  correlation_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'READY_FOR_FINANCE' CHECK (status = 'READY_FOR_FINANCE'),
  FOREIGN KEY (cash_receipt_id, legal_entity_id) REFERENCES abos.cash_receipts(id, legal_entity_id),
  FOREIGN KEY (capital_receipt_intent_id, legal_entity_id)
    REFERENCES abos.capital_receipt_intents(id, legal_entity_id)
);

CREATE OR REPLACE FUNCTION abos.guard_treasury_handoff()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  actor uuid := abos.treasury_actor();
  receipt abos.cash_receipts%ROWTYPE;
  source_row abos.capital_receipt_intents%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'a Treasury handoff to Finance is immutable';
  END IF;
  IF NEW.handed_off_by_user_account_id <> actor THEN
    RAISE EXCEPTION 'a handoff must be recorded by the acting user';
  END IF;
  PERFORM abos.require_treasury_permission(actor, NEW.legal_entity_id,
    'treasury.handoff.create', 'Handing a receipt to Finance');
  SELECT * INTO receipt FROM abos.cash_receipts WHERE id = NEW.cash_receipt_id FOR SHARE;
  SELECT * INTO source_row FROM abos.capital_receipt_intents
   WHERE id = NEW.capital_receipt_intent_id FOR SHARE;
  IF receipt.status IS DISTINCT FROM 'VERIFIED' THEN
    RAISE EXCEPTION 'only a VERIFIED receipt can be handed to Finance';
  END IF;
  IF receipt.capital_receipt_intent_id IS DISTINCT FROM NEW.capital_receipt_intent_id THEN
    RAISE EXCEPTION 'the handoff must name the receipt''s own capital receipt intent';
  END IF;
  IF source_row.status IS DISTINCT FROM 'TREASURY_VERIFIED'
     OR source_row.treasury_cash_receipt_id IS DISTINCT FROM receipt.id THEN
    RAISE EXCEPTION 'the shareholder intent must record this verified receipt before handoff';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER treasury_finance_handoffs_guard
BEFORE INSERT OR UPDATE OR DELETE ON abos.treasury_finance_handoffs
FOR EACH ROW EXECUTE FUNCTION abos.guard_treasury_handoff();
CREATE TRIGGER treasury_finance_handoffs_sandbox_guard
BEFORE INSERT ON abos.treasury_finance_handoffs
FOR EACH ROW EXECUTE FUNCTION abos.guard_sandbox_finance_mutation();

-- The shareholder source may claim TREASURY_VERIFIED (or later POSTED) only against a receipt
-- that really is VERIFIED and really answers this intent.
CREATE OR REPLACE FUNCTION abos.guard_intent_treasury_link()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE receipt abos.cash_receipts%ROWTYPE;
BEGIN
  IF NEW.status NOT IN ('TREASURY_VERIFIED', 'POSTED') THEN
    RETURN NEW;
  END IF;
  SELECT * INTO receipt FROM abos.cash_receipts WHERE id = NEW.treasury_cash_receipt_id FOR SHARE;
  IF receipt.id IS NULL OR receipt.status <> 'VERIFIED'
     OR receipt.capital_receipt_intent_id IS DISTINCT FROM NEW.id THEN
    RAISE EXCEPTION 'capital receipt intent % can only reference its own VERIFIED Treasury receipt', NEW.id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER capital_receipt_intents_treasury_link_guard
BEFORE INSERT OR UPDATE ON abos.capital_receipt_intents
FOR EACH ROW EXECUTE FUNCTION abos.guard_intent_treasury_link();

-- Finance consumes only what Treasury released. A capital posting intent must name a receipt that
-- has been handed off for exactly this source.
CREATE OR REPLACE FUNCTION abos.require_treasury_handoff_for_posting()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.intent_kind <> 'SHAREHOLDER_CAPITAL_RECEIPT' THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM abos.treasury_finance_handoffs h
                  WHERE h.cash_receipt_id = NEW.treasury_cash_receipt_id
                    AND h.capital_receipt_intent_id = NEW.capital_receipt_intent_id
                    AND h.legal_entity_id = NEW.legal_entity_id) THEN
    RAISE EXCEPTION 'a capital posting intent requires a Treasury handoff of this verified receipt';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER posting_intents_require_treasury_handoff
BEFORE INSERT OR UPDATE ON abos.posting_intents
FOR EACH ROW EXECUTE FUNCTION abos.require_treasury_handoff_for_posting();

-- ---------------------------------------------------------------------------
-- Append-only Treasury audit history.
-- ---------------------------------------------------------------------------

CREATE TABLE abos.treasury_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  aggregate_type text NOT NULL CHECK (aggregate_type IN (
    'CASH_LOCATION', 'CASH_ACCOUNT', 'CASHIER_ASSIGNMENT', 'CASH_ACCOUNT_OPENING',
    'PHYSICAL_CASH_COUNT', 'CASH_RECEIPT', 'FINANCE_HANDOFF')),
  aggregate_id uuid NOT NULL,
  operation text NOT NULL CHECK (operation IN ('INSERT', 'UPDATE')),
  from_status text,
  to_status text,
  actor_user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  row_after jsonb NOT NULL
);
CREATE INDEX treasury_events_aggregate_idx
  ON abos.treasury_events(aggregate_type, aggregate_id, occurred_at);

CREATE OR REPLACE FUNCTION abos.record_treasury_event()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  after_row jsonb := to_jsonb(NEW);
  before_row jsonb := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE NULL END;
  status_key text := nullif(TG_ARGV[1], '');
  aggregate_key text := coalesce(TG_ARGV[2], 'id');
BEGIN
  INSERT INTO abos.treasury_events
    (legal_entity_id, aggregate_type, aggregate_id, operation, from_status, to_status,
     actor_user_account_id, row_after)
  VALUES
    (NEW.legal_entity_id, TG_ARGV[0], (after_row ->> aggregate_key)::uuid, TG_OP,
     CASE WHEN status_key IS NULL OR before_row IS NULL THEN NULL ELSE before_row ->> status_key END,
     CASE WHEN status_key IS NULL THEN NULL ELSE after_row ->> status_key END,
     abos.treasury_actor(), after_row);
  RETURN NEW;
END;
$$;

CREATE TRIGGER cash_locations_audit AFTER INSERT OR UPDATE ON abos.cash_locations
FOR EACH ROW EXECUTE FUNCTION abos.record_treasury_event('CASH_LOCATION', 'status');
CREATE TRIGGER cash_accounts_audit AFTER INSERT OR UPDATE ON abos.cash_location_currency_accounts
FOR EACH ROW EXECUTE FUNCTION abos.record_treasury_event('CASH_ACCOUNT', 'activation_status');
CREATE TRIGGER cashier_assignments_audit AFTER INSERT OR UPDATE ON abos.cash_location_cashier_assignments
FOR EACH ROW EXECUTE FUNCTION abos.record_treasury_event('CASHIER_ASSIGNMENT', '');
CREATE TRIGGER cash_account_openings_audit AFTER INSERT OR UPDATE ON abos.cash_account_openings
FOR EACH ROW EXECUTE FUNCTION abos.record_treasury_event('CASH_ACCOUNT_OPENING', 'status', 'cash_location_currency_account_id');
CREATE TRIGGER physical_cash_counts_audit AFTER INSERT OR UPDATE ON abos.physical_cash_counts
FOR EACH ROW EXECUTE FUNCTION abos.record_treasury_event('PHYSICAL_CASH_COUNT', 'status');
CREATE TRIGGER cash_receipts_audit AFTER INSERT OR UPDATE ON abos.cash_receipts
FOR EACH ROW EXECUTE FUNCTION abos.record_treasury_event('CASH_RECEIPT', 'status');
CREATE TRIGGER treasury_finance_handoffs_audit AFTER INSERT ON abos.treasury_finance_handoffs
FOR EACH ROW EXECUTE FUNCTION abos.record_treasury_event('FINANCE_HANDOFF', 'status');

CREATE OR REPLACE FUNCTION abos.prevent_treasury_event_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Treasury audit history is append-only';
END;
$$;
CREATE TRIGGER treasury_events_no_update_or_delete
BEFORE UPDATE OR DELETE ON abos.treasury_events
FOR EACH ROW EXECUTE FUNCTION abos.prevent_treasury_event_mutation();

-- The read-only runtime role from 0004 can read the new tables too. It still cannot write them.
GRANT SELECT ON abos.cash_location_cashier_assignments, abos.cash_account_openings,
  abos.treasury_finance_handoffs, abos.treasury_events TO abos_e1_runtime;
