-- V1 Phase 1, work package B: safes and Saraf accounts (backlog #11) and whole-safe cash counts (#16).
--
-- Owner decisions (docs/00-governance/DECISIONS.md, 2026-09-25):
--   * V1 money locations are cash safes and Saraf accounts only. No banks.
--   * Safes and Saraf accounts are accounts created the same way as other accounts: they link to an
--     account the user picks from the Chart of Accounts. Treasury never creates a ledger account.
--   * Cash count supports both modes: money received only (done in 0006), or the whole safe (here).
--
-- What this migration adds:
--   1. A database guard so a safe currency account can only be opened against an ACTIVE, posting
--      CASH ledger account (the composite foreign key from 0001 already forces the same currency).
--   2. abos.saraf_accounts: a Saraf (a business party with a current SARAF role) linked to one
--      ACTIVE SARAF control ledger account in one currency (USD or AFN), with status and audit.
--      Account setup only: no Saraf transactions, transfers, balances or postings exist.
--   3. abos.cash_safe_counts: a whole-safe count of one safe currency account at a point in time,
--      recorded by one person and confirmed by another. It stores, as a snapshot taken by the
--      database when the count is recorded, the custody total Treasury can derive for that account
--      (approved opening count + receipts VERIFIED at or before the count) and the difference.
--      It posts nothing and resolves nothing: no tolerance or discrepancy policy is invented here.
--   4. Two Treasury SECURITY DEFINER entry points (query and command), owned by
--      abos_e1_treasury_owner, executable only by abos_e1_treasury_runtime, authorizing through
--      abos.treasury_runtime_authorize. The runtime still has no table privilege.
--   5. The catalogue permission treasury.saraf-account.manage (catalogue version 3).
--
-- Safe creation, account opening, opening count/confirmation, reconciliation, approval, activation,
-- blocking and cashier assignment stay on the existing 0008 treasury_secure_command operations and
-- their 0006 segregation-of-duties triggers; nothing here re-creates those functions.

-- ---------------------------------------------------------------------------
-- 1. Permission.
-- ---------------------------------------------------------------------------
-- independence_enforced: whoever creates a Saraf account cannot activate it (enforced below).
INSERT INTO abos.permission_catalogue
  (permission_code, catalogue_version, category, availability, independence_enforced, administrative, sort_order)
VALUES ('treasury.saraf-account.manage', 3, 'TREASURY', 'ACTIVE', true, false, 220);

-- ---------------------------------------------------------------------------
-- 2. Audit vocabulary: the append-only Treasury history also records the new aggregates.
-- ---------------------------------------------------------------------------
ALTER TABLE abos.treasury_events DROP CONSTRAINT treasury_events_aggregate_type_check;
ALTER TABLE abos.treasury_events ADD CONSTRAINT treasury_events_aggregate_type_check
  CHECK (aggregate_type IN (
    'CASH_LOCATION', 'CASH_ACCOUNT', 'CASHIER_ASSIGNMENT', 'CASH_ACCOUNT_OPENING',
    'PHYSICAL_CASH_COUNT', 'CASH_RECEIPT', 'FINANCE_HANDOFF', 'SARAF_ACCOUNT', 'SAFE_COUNT'));

-- ---------------------------------------------------------------------------
-- 3. A safe currency account links only to an ACTIVE, posting CASH ledger account.
-- ---------------------------------------------------------------------------
-- 0001 checked the control type only when an account became ACTIVE, so a DRAFT safe account could
-- name any same-currency ledger account. From now on the link itself is checked when it is made.
CREATE FUNCTION abos.require_cash_ledger_for_safe_account()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $cash_ledger$
DECLARE ledger record;
BEGIN
  SELECT la.control_account_type, la.status, la.posting_allowed, la.account_currency_code
    INTO ledger
    FROM abos.ledger_accounts la
   WHERE la.id = NEW.ledger_account_id AND la.legal_entity_id = NEW.legal_entity_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the chosen ledger account does not exist in this legal entity';
  END IF;
  IF ledger.account_currency_code IS DISTINCT FROM NEW.currency_code THEN
    RAISE EXCEPTION 'a % safe account cannot link a % ledger account', NEW.currency_code,
      coalesce(ledger.account_currency_code, 'currency-less');
  END IF;
  IF ledger.control_account_type IS DISTINCT FROM 'CASH' OR ledger.status <> 'ACTIVE'
     OR NOT ledger.posting_allowed THEN
    RAISE EXCEPTION 'a safe account must link an ACTIVE posting CASH ledger account';
  END IF;
  RETURN NEW;
END
$cash_ledger$;
CREATE TRIGGER cash_location_currency_accounts_cash_ledger_guard
BEFORE INSERT ON abos.cash_location_currency_accounts
FOR EACH ROW EXECUTE FUNCTION abos.require_cash_ledger_for_safe_account();

-- ---------------------------------------------------------------------------
-- 4. Saraf accounts.
-- ---------------------------------------------------------------------------
CREATE TABLE abos.saraf_accounts (
  id uuid PRIMARY KEY,
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  business_party_id uuid NOT NULL,
  currency_code text NOT NULL REFERENCES abos.currencies(code) CHECK (currency_code IN ('USD', 'AFN')),
  ledger_account_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'ACTIVE', 'INACTIVE')),
  created_by_user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  activated_by_user_account_id uuid REFERENCES abos.user_accounts(id),
  activated_at timestamptz,
  status_changed_by_user_account_id uuid REFERENCES abos.user_accounts(id),
  status_changed_at timestamptz,
  UNIQUE (id, legal_entity_id),
  FOREIGN KEY (business_party_id, legal_entity_id) REFERENCES abos.business_parties(id, legal_entity_id),
  -- Same legal entity and the SAME currency as the ledger account, by construction.
  FOREIGN KEY (ledger_account_id, legal_entity_id, currency_code)
    REFERENCES abos.ledger_accounts(id, legal_entity_id, account_currency_code),
  -- Whoever created the account never activates it.
  CHECK (activated_by_user_account_id IS NULL OR activated_by_user_account_id <> created_by_user_account_id),
  CHECK ((activated_by_user_account_id IS NULL) = (activated_at IS NULL)),
  CHECK ((status_changed_by_user_account_id IS NULL) = (status_changed_at IS NULL)),
  CHECK (status = 'DRAFT' OR status_changed_by_user_account_id IS NOT NULL)
);
-- One live account per Saraf and currency. A deactivated account does not block a new one.
CREATE UNIQUE INDEX saraf_accounts_one_live_per_party_currency
  ON abos.saraf_accounts(legal_entity_id, business_party_id, currency_code)
  WHERE status <> 'INACTIVE';

CREATE FUNCTION abos.guard_saraf_account()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $saraf_guard$
DECLARE
  actor uuid;
  ledger record;
  party_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Saraf accounts are deactivated, never deleted';
  END IF;
  actor := abos.treasury_actor();
  PERFORM abos.require_treasury_permission(actor, NEW.legal_entity_id,
    'treasury.saraf-account.manage', 'Managing a Saraf account');

  IF TG_OP = 'UPDATE' THEN
    IF OLD.id <> NEW.id OR OLD.legal_entity_id <> NEW.legal_entity_id
       OR OLD.business_party_id <> NEW.business_party_id OR OLD.currency_code <> NEW.currency_code
       OR OLD.ledger_account_id <> NEW.ledger_account_id
       OR OLD.created_by_user_account_id <> NEW.created_by_user_account_id
       OR OLD.created_at <> NEW.created_at THEN
      RAISE EXCEPTION 'a Saraf account cannot change its Saraf, currency, ledger account or creator';
    END IF;
    IF OLD.status = NEW.status THEN
      RAISE EXCEPTION 'the Saraf account is already %', OLD.status;
    END IF;
    IF NEW.status_changed_by_user_account_id IS DISTINCT FROM actor THEN
      RAISE EXCEPTION 'a Saraf account status change must be recorded by the acting user';
    END IF;
    IF NEW.status = 'ACTIVE' THEN
      IF actor = NEW.created_by_user_account_id THEN
        RAISE EXCEPTION 'the person who created a Saraf account cannot activate it';
      END IF;
      IF NEW.activated_by_user_account_id IS DISTINCT FROM actor THEN
        RAISE EXCEPTION 'a Saraf account must be activated by the acting user';
      END IF;
    ELSIF NEW.status = 'INACTIVE' THEN
      IF NEW.activated_by_user_account_id IS DISTINCT FROM OLD.activated_by_user_account_id
         OR NEW.activated_at IS DISTINCT FROM OLD.activated_at THEN
        RAISE EXCEPTION 'deactivating a Saraf account keeps its activation record';
      END IF;
    ELSE
      RAISE EXCEPTION 'Saraf account transition % -> % is not permitted', OLD.status, NEW.status;
    END IF;
  ELSE
    IF NEW.status <> 'DRAFT' OR NEW.activated_by_user_account_id IS NOT NULL
       OR NEW.status_changed_by_user_account_id IS NOT NULL THEN
      RAISE EXCEPTION 'a Saraf account is created as DRAFT and activated by another person';
    END IF;
    IF NEW.created_by_user_account_id <> actor THEN
      RAISE EXCEPTION 'a Saraf account must be created by the acting user';
    END IF;
  END IF;

  -- Creating or (re)activating: the Saraf and the ledger account must qualify right now.
  IF TG_OP = 'INSERT' OR NEW.status = 'ACTIVE' THEN
    SELECT party.status INTO party_status FROM abos.business_parties party
     WHERE party.id = NEW.business_party_id AND party.legal_entity_id = NEW.legal_entity_id;
    IF party_status IS DISTINCT FROM 'ACTIVE' THEN
      RAISE EXCEPTION 'the Saraf must be an ACTIVE business party of this legal entity';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM abos.business_party_roles role
       WHERE role.business_party_id = NEW.business_party_id AND role.role_code = 'SARAF'
         AND role.effective_from <= current_date
         AND (role.effective_to IS NULL OR role.effective_to >= current_date)) THEN
      RAISE EXCEPTION 'the business party does not hold a current SARAF role';
    END IF;
    SELECT la.control_account_type, la.status, la.posting_allowed INTO ledger
      FROM abos.ledger_accounts la
     WHERE la.id = NEW.ledger_account_id AND la.legal_entity_id = NEW.legal_entity_id
       AND la.account_currency_code = NEW.currency_code;
    IF NOT FOUND OR ledger.control_account_type IS DISTINCT FROM 'SARAF' THEN
      RAISE EXCEPTION 'a Saraf account must link a SARAF control ledger account in the same currency';
    END IF;
    IF ledger.status <> 'ACTIVE' OR NOT ledger.posting_allowed THEN
      RAISE EXCEPTION 'the SARAF ledger account must be ACTIVE and allow posting';
    END IF;
  END IF;
  RETURN NEW;
END
$saraf_guard$;
CREATE TRIGGER saraf_accounts_guard
BEFORE INSERT OR UPDATE OR DELETE ON abos.saraf_accounts
FOR EACH ROW EXECUTE FUNCTION abos.guard_saraf_account();
CREATE TRIGGER saraf_accounts_sandbox_guard
BEFORE INSERT OR UPDATE ON abos.saraf_accounts
FOR EACH ROW EXECUTE FUNCTION abos.guard_sandbox_finance_mutation();
CREATE TRIGGER saraf_accounts_audit AFTER INSERT OR UPDATE ON abos.saraf_accounts
FOR EACH ROW EXECUTE FUNCTION abos.record_treasury_event('SARAF_ACCOUNT', 'status');

-- ---------------------------------------------------------------------------
-- 5. Whole-safe counts.
-- ---------------------------------------------------------------------------
CREATE TABLE abos.cash_safe_counts (
  id uuid PRIMARY KEY,
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  cash_location_currency_account_id uuid NOT NULL,
  currency_code text NOT NULL REFERENCES abos.currencies(code),
  counted_amount numeric NOT NULL CHECK (counted_amount >= 0),
  counted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  counted_by_user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  -- One count sheet evidences one count.
  evidence_reference_id uuid NOT NULL UNIQUE,
  note text CHECK (note IS NULL OR (btrim(note) <> '' AND length(note) <= 500)),
  -- Snapshot, computed by the database when the count is recorded (see the guard below).
  opening_amount numeric NOT NULL CHECK (opening_amount >= 0),
  verified_receipts_amount numeric NOT NULL CHECK (verified_receipts_amount >= 0),
  verified_receipt_count integer NOT NULL CHECK (verified_receipt_count >= 0),
  unverified_receipt_count integer NOT NULL CHECK (unverified_receipt_count >= 0),
  custody_total numeric GENERATED ALWAYS AS (opening_amount + verified_receipts_amount) STORED,
  difference numeric GENERATED ALWAYS AS (counted_amount - (opening_amount + verified_receipts_amount)) STORED,
  status text NOT NULL DEFAULT 'RECORDED' CHECK (status IN ('RECORDED', 'CONFIRMED')),
  confirmed_by_user_account_id uuid REFERENCES abos.user_accounts(id),
  confirmed_at timestamptz,
  UNIQUE (id, legal_entity_id),
  FOREIGN KEY (cash_location_currency_account_id, legal_entity_id)
    REFERENCES abos.cash_location_currency_accounts(id, legal_entity_id),
  FOREIGN KEY (cash_location_currency_account_id, currency_code)
    REFERENCES abos.cash_location_currency_accounts(id, currency_code),
  FOREIGN KEY (evidence_reference_id, legal_entity_id)
    REFERENCES abos.evidence_references(id, legal_entity_id),
  -- Whoever counted never confirms.
  CHECK (confirmed_by_user_account_id IS NULL OR confirmed_by_user_account_id <> counted_by_user_account_id),
  CHECK ((status = 'CONFIRMED') = (confirmed_by_user_account_id IS NOT NULL AND confirmed_at IS NOT NULL))
);
CREATE INDEX cash_safe_counts_account_idx ON abos.cash_safe_counts(cash_location_currency_account_id, counted_at);

CREATE FUNCTION abos.guard_cash_safe_count()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $safe_count_guard$
DECLARE
  actor uuid;
  opening record;
  evidence_kind text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'whole-safe counts are permanent records';
  END IF;
  actor := abos.treasury_actor();

  IF TG_OP = 'INSERT' THEN
    PERFORM abos.require_treasury_permission(actor, NEW.legal_entity_id,
      'treasury.cash-count.record', 'Recording a whole-safe count');
    IF NEW.status <> 'RECORDED' OR NEW.confirmed_by_user_account_id IS NOT NULL OR NEW.confirmed_at IS NOT NULL THEN
      RAISE EXCEPTION 'a whole-safe count is recorded first and confirmed by another person';
    END IF;
    IF NEW.counted_by_user_account_id <> actor THEN
      RAISE EXCEPTION 'a whole-safe count must be recorded by the person who counted';
    END IF;
    SELECT er.evidence_kind INTO evidence_kind FROM abos.evidence_references er
     WHERE er.id = NEW.evidence_reference_id AND er.legal_entity_id = NEW.legal_entity_id;
    IF evidence_kind IS DISTINCT FROM 'PHYSICAL_CASH_COUNT' THEN
      RAISE EXCEPTION 'a whole-safe count requires PHYSICAL_CASH_COUNT evidence';
    END IF;
    IF EXISTS (SELECT 1 FROM abos.treasury_evidence_bindings b WHERE b.evidence_reference_id = NEW.evidence_reference_id)
       OR EXISTS (SELECT 1 FROM abos.physical_cash_counts c WHERE c.evidence_reference_id = NEW.evidence_reference_id)
       OR EXISTS (SELECT 1 FROM abos.cash_safe_counts s WHERE s.evidence_reference_id = NEW.evidence_reference_id) THEN
      RAISE EXCEPTION 'this count evidence already belongs to another count or receipt';
    END IF;

    -- The custody total Treasury can derive: the approved opening count plus every receipt of this
    -- account VERIFIED at or before this count. Computed here, never supplied by the caller.
    SELECT o.opening_counted_amount INTO opening
      FROM abos.cash_account_openings o
     WHERE o.cash_location_currency_account_id = NEW.cash_location_currency_account_id
       AND o.legal_entity_id = NEW.legal_entity_id AND o.currency_code = NEW.currency_code
       AND o.status = 'APPROVED';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'a whole-safe count needs an account whose opening position is approved';
    END IF;
    NEW.counted_at := clock_timestamp();
    NEW.opening_amount := opening.opening_counted_amount;
    SELECT coalesce(sum(r.amount), 0), count(*)::integer
      INTO NEW.verified_receipts_amount, NEW.verified_receipt_count
      FROM abos.cash_receipts r
     WHERE r.cash_location_currency_account_id = NEW.cash_location_currency_account_id
       AND r.legal_entity_id = NEW.legal_entity_id AND r.currency_code = NEW.currency_code
       AND r.status = 'VERIFIED' AND r.verified_at <= NEW.counted_at;
    -- Informational only: cash recorded as received but not yet verified is not in the total.
    SELECT count(*)::integer INTO NEW.unverified_receipt_count
      FROM abos.cash_receipts r
     WHERE r.cash_location_currency_account_id = NEW.cash_location_currency_account_id
       AND r.legal_entity_id = NEW.legal_entity_id
       AND r.status IN ('DRAFT', 'COUNTED');
    RETURN NEW;
  END IF;

  IF OLD.status = 'CONFIRMED' THEN
    RAISE EXCEPTION 'a confirmed whole-safe count is final';
  END IF;
  -- Generated columns are not yet computed in a BEFORE trigger; they follow from compared inputs.
  IF (pg_catalog.to_jsonb(NEW) - ARRAY['status', 'confirmed_by_user_account_id', 'confirmed_at', 'custody_total', 'difference'])
     <> (pg_catalog.to_jsonb(OLD) - ARRAY['status', 'confirmed_by_user_account_id', 'confirmed_at', 'custody_total', 'difference']) THEN
    RAISE EXCEPTION 'a recorded whole-safe count cannot be rewritten';
  END IF;
  IF NEW.status <> 'CONFIRMED' THEN
    RAISE EXCEPTION 'whole-safe count transition % -> % is not permitted', OLD.status, NEW.status;
  END IF;
  IF NEW.confirmed_by_user_account_id IS DISTINCT FROM actor THEN
    RAISE EXCEPTION 'a whole-safe count must be confirmed by the acting user';
  END IF;
  IF actor = OLD.counted_by_user_account_id THEN
    RAISE EXCEPTION 'the person who counted the safe cannot confirm the count';
  END IF;
  PERFORM abos.require_treasury_permission(actor, NEW.legal_entity_id,
    'treasury.cash-account.approve', 'Confirming a whole-safe count');
  RETURN NEW;
END
$safe_count_guard$;
CREATE TRIGGER cash_safe_counts_guard
BEFORE INSERT OR UPDATE OR DELETE ON abos.cash_safe_counts
FOR EACH ROW EXECUTE FUNCTION abos.guard_cash_safe_count();
CREATE TRIGGER cash_safe_counts_sandbox_guard
BEFORE INSERT OR UPDATE ON abos.cash_safe_counts
FOR EACH ROW EXECUTE FUNCTION abos.guard_sandbox_finance_mutation();
CREATE TRIGGER cash_safe_counts_audit AFTER INSERT OR UPDATE ON abos.cash_safe_counts
FOR EACH ROW EXECUTE FUNCTION abos.record_treasury_event('SAFE_COUNT', 'status');

-- The evidence of a whole-safe count cannot later be reused by a receipt or opening count either.
CREATE FUNCTION abos.refuse_evidence_used_by_safe_count()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $evidence_reuse$
BEGIN
  IF NEW.evidence_reference_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM abos.cash_safe_counts s WHERE s.evidence_reference_id = NEW.evidence_reference_id) THEN
    RAISE EXCEPTION 'this count evidence already belongs to a whole-safe count';
  END IF;
  RETURN NEW;
END
$evidence_reuse$;
CREATE TRIGGER physical_cash_counts_safe_count_evidence_guard
BEFORE INSERT ON abos.physical_cash_counts
FOR EACH ROW EXECUTE FUNCTION abos.refuse_evidence_used_by_safe_count();

-- ---------------------------------------------------------------------------
-- 6. Treasury owner privileges for the new tables (column-level; nothing destructive).
-- ---------------------------------------------------------------------------
GRANT SELECT ON abos.saraf_accounts, abos.cash_safe_counts, abos.business_party_roles TO abos_e1_treasury_owner;
GRANT INSERT (id, legal_entity_id, business_party_id, currency_code, ledger_account_id, status,
              created_by_user_account_id)
  ON abos.saraf_accounts TO abos_e1_treasury_owner;
GRANT UPDATE (status, activated_by_user_account_id, activated_at, status_changed_by_user_account_id, status_changed_at)
  ON abos.saraf_accounts TO abos_e1_treasury_owner;
GRANT INSERT (id, legal_entity_id, cash_location_currency_account_id, currency_code, counted_amount,
              counted_by_user_account_id, evidence_reference_id, note, opening_amount,
              verified_receipts_amount, verified_receipt_count, unverified_receipt_count, status)
  ON abos.cash_safe_counts TO abos_e1_treasury_owner;
GRANT UPDATE (status, confirmed_by_user_account_id, confirmed_at)
  ON abos.cash_safe_counts TO abos_e1_treasury_owner;

-- ---------------------------------------------------------------------------
-- 7. Restricted entry points.
-- ---------------------------------------------------------------------------
CREATE FUNCTION abos.treasury_safes_saraf_query(
  p_bearer_token text,
  p_legal_entity_id uuid,
  p_query text,
  p_object_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $safes_query$
DECLARE result jsonb;
BEGIN
  PERFORM abos.treasury_runtime_authorize(p_bearer_token, p_legal_entity_id, 'treasury.read');
  CASE p_query
    -- Ledger accounts a safe account may link: ACTIVE posting CASH accounts, per currency.
    WHEN 'CASH_LEDGER_CHOICES' THEN
      SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x) ORDER BY x.account_code), '[]'::jsonb)
        INTO result FROM (
          SELECT la.id, la.account_code, la.account_name, la.account_currency_code
            FROM abos.ledger_accounts la
           WHERE la.legal_entity_id = p_legal_entity_id AND la.control_account_type = 'CASH'
             AND la.status = 'ACTIVE' AND la.posting_allowed AND la.account_currency_code IN ('USD', 'AFN')
             AND (p_object_id IS NULL OR la.id = p_object_id)) x;
    -- Ledger accounts a Saraf account may link: ACTIVE posting SARAF control accounts.
    WHEN 'SARAF_LEDGER_CHOICES' THEN
      SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x) ORDER BY x.account_code), '[]'::jsonb)
        INTO result FROM (
          SELECT la.id, la.account_code, la.account_name, la.account_currency_code
            FROM abos.ledger_accounts la
           WHERE la.legal_entity_id = p_legal_entity_id AND la.control_account_type = 'SARAF'
             AND la.status = 'ACTIVE' AND la.posting_allowed AND la.account_currency_code IN ('USD', 'AFN')
             AND (p_object_id IS NULL OR la.id = p_object_id)) x;
    -- Business parties that currently hold the SARAF role.
    WHEN 'SARAF_PARTIES' THEN
      SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x) ORDER BY x.display_name), '[]'::jsonb)
        INTO result FROM (
          SELECT party.id, party.display_name, party.external_reference
            FROM abos.business_parties party
           WHERE party.legal_entity_id = p_legal_entity_id AND party.status = 'ACTIVE'
             AND EXISTS (SELECT 1 FROM abos.business_party_roles role
                          WHERE role.business_party_id = party.id AND role.role_code = 'SARAF'
                            AND role.effective_from <= current_date
                            AND (role.effective_to IS NULL OR role.effective_to >= current_date))
             AND (p_object_id IS NULL OR party.id = p_object_id)) x;
    WHEN 'SARAF_ACCOUNTS' THEN
      SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x) ORDER BY x.party_name, x.currency_code), '[]'::jsonb)
        INTO result FROM (
          SELECT account.id, account.legal_entity_id, account.business_party_id, party.display_name AS party_name,
                 account.currency_code, account.ledger_account_id, ledger.account_code, ledger.account_name,
                 account.status, account.created_by_user_account_id, creator.display_name AS created_by_name,
                 account.created_at, account.activated_by_user_account_id, activator.display_name AS activated_by_name,
                 account.activated_at, account.status_changed_by_user_account_id, account.status_changed_at
            FROM abos.saraf_accounts account
            JOIN abos.business_parties party ON party.id = account.business_party_id
             AND party.legal_entity_id = account.legal_entity_id
            JOIN abos.ledger_accounts ledger ON ledger.id = account.ledger_account_id
             AND ledger.legal_entity_id = account.legal_entity_id
            JOIN abos.user_accounts creator ON creator.id = account.created_by_user_account_id
            LEFT JOIN abos.user_accounts activator ON activator.id = account.activated_by_user_account_id
           WHERE account.legal_entity_id = p_legal_entity_id
             AND (p_object_id IS NULL OR account.id = p_object_id)) x;
    WHEN 'SAFE_COUNTS' THEN
      SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x) ORDER BY x.counted_at DESC, x.id), '[]'::jsonb)
        INTO result FROM (
          SELECT sc.id, sc.legal_entity_id, sc.cash_location_currency_account_id, account.cash_location_id,
                 sc.currency_code, sc.counted_amount::text AS counted_amount, sc.counted_at,
                 sc.counted_by_user_account_id, counter.display_name AS counted_by_name,
                 sc.evidence_reference_id, sc.note, sc.opening_amount::text AS opening_amount,
                 sc.verified_receipts_amount::text AS verified_receipts_amount, sc.verified_receipt_count,
                 sc.unverified_receipt_count, sc.custody_total::text AS custody_total,
                 sc.difference::text AS difference, sc.status, sc.confirmed_by_user_account_id,
                 confirmer.display_name AS confirmed_by_name, sc.confirmed_at
            FROM abos.cash_safe_counts sc
            JOIN abos.cash_location_currency_accounts account ON account.id = sc.cash_location_currency_account_id
             AND account.legal_entity_id = sc.legal_entity_id
            JOIN abos.user_accounts counter ON counter.id = sc.counted_by_user_account_id
            LEFT JOIN abos.user_accounts confirmer ON confirmer.id = sc.confirmed_by_user_account_id
           WHERE sc.legal_entity_id = p_legal_entity_id
             AND (p_object_id IS NULL OR sc.id = p_object_id OR sc.cash_location_currency_account_id = p_object_id)) x;
    -- Count and reconciliation evidence provisioned for safes (never evidence bound to a shareholder
    -- receipt), with whether it has already been used. Evidence is provisioned by a trusted
    -- ingestion path; Treasury can only choose it.
    WHEN 'COUNT_EVIDENCE' THEN
      SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x) ORDER BY x.evidence_kind, x.created_at), '[]'::jsonb)
        INTO result FROM (
          SELECT evidence.id, evidence.evidence_kind, evidence.document_id, evidence.evidence_version,
                 evidence.sha256, evidence.created_at,
                 (EXISTS (SELECT 1 FROM abos.physical_cash_counts c WHERE c.evidence_reference_id = evidence.id)
                  OR EXISTS (SELECT 1 FROM abos.cash_safe_counts s WHERE s.evidence_reference_id = evidence.id)
                  OR EXISTS (SELECT 1 FROM abos.cash_account_openings o
                              WHERE o.reconciliation_evidence_reference_id = evidence.id)) AS used
            FROM abos.evidence_references evidence
           WHERE evidence.legal_entity_id = p_legal_entity_id
             AND evidence.evidence_kind IN ('PHYSICAL_CASH_COUNT', 'OPENING_RECONCILIATION')
             AND NOT EXISTS (SELECT 1 FROM abos.treasury_evidence_bindings b
                              WHERE b.evidence_reference_id = evidence.id)
             AND (p_object_id IS NULL OR evidence.id = p_object_id)) x;
    ELSE
      RAISE EXCEPTION 'unsupported Treasury safes query';
  END CASE;
  RETURN result;
END
$safes_query$;

CREATE FUNCTION abos.treasury_safes_saraf_command(
  p_bearer_token text,
  p_legal_entity_id uuid,
  p_operation text,
  p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $safes_command$
DECLARE
  actor uuid;
  required_permission text;
  object_id uuid;
  account_row record;
BEGIN
  required_permission := CASE p_operation
    WHEN 'CREATE_SARAF_ACCOUNT' THEN 'treasury.saraf-account.manage'
    WHEN 'ACTIVATE_SARAF_ACCOUNT' THEN 'treasury.saraf-account.manage'
    WHEN 'DEACTIVATE_SARAF_ACCOUNT' THEN 'treasury.saraf-account.manage'
    WHEN 'RECORD_SAFE_COUNT' THEN 'treasury.cash-count.record'
    WHEN 'CONFIRM_SAFE_COUNT' THEN 'treasury.cash-account.approve'
    ELSE NULL END;
  IF required_permission IS NULL THEN
    RAISE EXCEPTION 'unsupported Treasury safes operation';
  END IF;
  actor := abos.treasury_runtime_authorize(p_bearer_token, p_legal_entity_id, required_permission);
  object_id := nullif(p_payload ->> 'id', '')::uuid;
  IF object_id IS NULL THEN
    RAISE EXCEPTION 'an identifier is required';
  END IF;

  CASE p_operation
    WHEN 'CREATE_SARAF_ACCOUNT' THEN
      INSERT INTO abos.saraf_accounts
        (id, legal_entity_id, business_party_id, currency_code, ledger_account_id, status, created_by_user_account_id)
      VALUES (object_id, p_legal_entity_id, (p_payload ->> 'businessPartyId')::uuid, p_payload ->> 'currency',
              (p_payload ->> 'ledgerAccountId')::uuid, 'DRAFT', actor);
    WHEN 'ACTIVATE_SARAF_ACCOUNT' THEN
      UPDATE abos.saraf_accounts
         SET status = 'ACTIVE', activated_by_user_account_id = actor, activated_at = pg_catalog.clock_timestamp(),
             status_changed_by_user_account_id = actor, status_changed_at = pg_catalog.clock_timestamp()
       WHERE legal_entity_id = p_legal_entity_id AND id = object_id AND status IN ('DRAFT', 'INACTIVE');
      IF NOT FOUND THEN RAISE EXCEPTION 'draft or inactive Saraf account not found'; END IF;
    WHEN 'DEACTIVATE_SARAF_ACCOUNT' THEN
      UPDATE abos.saraf_accounts
         SET status = 'INACTIVE', status_changed_by_user_account_id = actor,
             status_changed_at = pg_catalog.clock_timestamp()
       WHERE legal_entity_id = p_legal_entity_id AND id = object_id AND status IN ('DRAFT', 'ACTIVE');
      IF NOT FOUND THEN RAISE EXCEPTION 'draft or active Saraf account not found'; END IF;
    WHEN 'RECORD_SAFE_COUNT' THEN
      SELECT account.id, account.currency_code INTO account_row
        FROM abos.cash_location_currency_accounts account
       WHERE account.legal_entity_id = p_legal_entity_id
         AND account.id = (p_payload ->> 'cashAccountId')::uuid;
      IF NOT FOUND THEN RAISE EXCEPTION 'cash account not found'; END IF;
      IF (p_payload ->> 'currency') IS DISTINCT FROM account_row.currency_code THEN
        RAISE EXCEPTION 'the count currency must be the account currency %', account_row.currency_code;
      END IF;
      -- The snapshot columns are placeholders; the guard trigger computes them.
      INSERT INTO abos.cash_safe_counts
        (id, legal_entity_id, cash_location_currency_account_id, currency_code, counted_amount,
         counted_by_user_account_id, evidence_reference_id, note, opening_amount,
         verified_receipts_amount, verified_receipt_count, unverified_receipt_count, status)
      VALUES (object_id, p_legal_entity_id, account_row.id, account_row.currency_code,
              (p_payload ->> 'countedAmount')::numeric, actor, (p_payload ->> 'evidenceReferenceId')::uuid,
              nullif(pg_catalog.btrim(coalesce(p_payload ->> 'note', '')), ''), 0, 0, 0, 0, 'RECORDED');
    WHEN 'CONFIRM_SAFE_COUNT' THEN
      UPDATE abos.cash_safe_counts
         SET status = 'CONFIRMED', confirmed_by_user_account_id = actor,
             confirmed_at = pg_catalog.clock_timestamp()
       WHERE legal_entity_id = p_legal_entity_id AND id = object_id AND status = 'RECORDED';
      IF NOT FOUND THEN RAISE EXCEPTION 'recorded whole-safe count not found'; END IF;
  END CASE;
  RETURN pg_catalog.jsonb_build_object('id', object_id, 'operation', p_operation);
END
$safes_command$;

ALTER FUNCTION abos.treasury_safes_saraf_query(text, uuid, text, uuid) OWNER TO abos_e1_treasury_owner;
ALTER FUNCTION abos.treasury_safes_saraf_command(text, uuid, text, jsonb) OWNER TO abos_e1_treasury_owner;
REVOKE ALL ON FUNCTION abos.treasury_safes_saraf_query(text, uuid, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION abos.treasury_safes_saraf_command(text, uuid, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION abos.treasury_safes_saraf_query(text, uuid, text, uuid) TO abos_e1_treasury_runtime;
GRANT EXECUTE ON FUNCTION abos.treasury_safes_saraf_command(text, uuid, text, jsonb) TO abos_e1_treasury_runtime;

-- Trigger functions are not entry points: nobody calls them directly.
REVOKE ALL ON FUNCTION abos.require_cash_ledger_for_safe_account() FROM PUBLIC;
REVOKE ALL ON FUNCTION abos.guard_saraf_account() FROM PUBLIC;
REVOKE ALL ON FUNCTION abos.guard_cash_safe_count() FROM PUBLIC;
REVOKE ALL ON FUNCTION abos.refuse_evidence_used_by_safe_count() FROM PUBLIC;

-- The runtime roles still hold no table privilege (defensive; nothing above grants one).
REVOKE ALL ON abos.saraf_accounts, abos.cash_safe_counts FROM abos_e1_treasury_runtime, abos_e1_runtime;
