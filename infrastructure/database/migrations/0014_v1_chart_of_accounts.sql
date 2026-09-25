-- V1 user-managed Chart of Accounts (backlog #10, work package A).
--
-- Owner decision 2026-09-25: "No fixed chart of accounts is shipped. A permitted user adds accounts
-- instantly; the system warns on likely duplicates; the Finance Manager receives a review list of
-- newly created accounts. Safes and Saraf accounts are accounts created the same way."
--
-- What this migration does:
--  * abos.ledger_accounts stays THE account table. Nothing is renamed or dropped. Accounts created
--    in the app are ACTIVE at once (usable immediately, as decided) and enter the review list.
--    Whether an account accepts postings is the existing posting_allowed flag and nothing else.
--  * No account, class or numbering convention is created for any company. The five account types
--    are the structural classification; optional grouping is by parent accounts. The Finance
--    Manager has not approved classes or a numbering convention, so codes are free text.
--  * Likely duplicates are reported as warnings (same or similar name, look-alike code, same type
--    and currency). A LIKELY warning must be explicitly confirmed; an exactly equal code (ignoring
--    letter case and surrounding spaces) is refused.
--  * The Finance Manager review list: accounts created or changed in the app wait for review. The
--    reviewer can never be the person who created or last changed the account (enforced by a
--    trigger on the decisions table, not only by the entry point).
--  * Accounts in use (journal lines, safe currency accounts, references registered by later
--    packages such as Saraf accounts, or pending capital posting intents) keep their code, type,
--    currency, control type, dimension rules and posting flag, and cannot be deactivated while the
--    use is open. Accounts with posted activity stay fully immutable (the 0001 provenance guard).
--  * Every entry point is a restricted Finance function owned by abos_e1_finance_owner (0011).

INSERT INTO abos.permission_catalogue
  (permission_code, catalogue_version, category, availability, independence_enforced, administrative, sort_order)
VALUES
  ('finance.ledger-account.manage', 3, 'FINANCE', 'ACTIVE', false, false, 200),
  ('finance.ledger-account.review', 3, 'FINANCE', 'ACTIVE', true,  false, 210);

-- An account code may not repeat within a company, whatever its letter case or surrounding spaces.
CREATE UNIQUE INDEX ledger_accounts_code_normalized ON abos.ledger_accounts (legal_entity_id, lower(btrim(account_code)));
CREATE INDEX ledger_accounts_parent_idx ON abos.ledger_accounts (parent_ledger_account_id) WHERE parent_ledger_account_id IS NOT NULL;
CREATE INDEX cash_location_currency_accounts_ledger_idx ON abos.cash_location_currency_accounts (ledger_account_id);

-- ---------------------------------------------------------------------------
-- Governance around each account: who created or last changed it, its review state, and the
-- duplicate warnings the person confirmed. Accounts created outside the app (for example the
-- synthetic seed) have no row until someone changes them in the app.
-- ---------------------------------------------------------------------------
CREATE TABLE abos.ledger_account_governance (
  ledger_account_id uuid PRIMARY KEY,
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  account_name_fa text CHECK (account_name_fa IS NULL OR length(btrim(account_name_fa)) BETWEEN 1 AND 120),
  description text CHECK (description IS NULL OR length(description) BETWEEN 1 AND 500),
  origin text NOT NULL CHECK (origin IN ('APP', 'PRE_EXISTING')),
  created_by_user_account_id uuid REFERENCES abos.user_accounts(id),
  created_at timestamptz NOT NULL,
  last_changed_by_user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  last_changed_at timestamptz NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  review_state text NOT NULL CHECK (review_state IN ('PENDING_REVIEW', 'REVIEWED', 'FLAGGED')),
  review_reason text NOT NULL CHECK (review_reason IN ('CREATED', 'CHANGED')),
  duplicate_warnings jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(duplicate_warnings) = 'array'),
  last_reviewed_by_user_account_id uuid REFERENCES abos.user_accounts(id),
  last_reviewed_at timestamptz,
  last_review_note text,
  FOREIGN KEY (ledger_account_id, legal_entity_id) REFERENCES abos.ledger_accounts(id, legal_entity_id),
  CHECK ((origin = 'APP') = (created_by_user_account_id IS NOT NULL)),
  CHECK ((last_reviewed_by_user_account_id IS NULL) = (last_reviewed_at IS NULL))
);
CREATE INDEX ledger_account_governance_review_idx ON abos.ledger_account_governance (legal_entity_id, review_state);

-- Append-only history of review decisions.
CREATE TABLE abos.ledger_account_review_decisions (
  id uuid PRIMARY KEY,
  ledger_account_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  account_version integer NOT NULL CHECK (account_version > 0),
  decision text NOT NULL CHECK (decision IN ('REVIEWED', 'FLAGGED')),
  note text CHECK (note IS NULL OR length(btrim(note)) BETWEEN 1 AND 500),
  reviewer_user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
  decided_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (ledger_account_id, legal_entity_id) REFERENCES abos.ledger_accounts(id, legal_entity_id),
  CHECK (decision <> 'FLAGGED' OR note IS NOT NULL)
);
CREATE INDEX ledger_account_review_decisions_account_idx ON abos.ledger_account_review_decisions (ledger_account_id, decided_at);
CREATE TRIGGER ledger_account_review_decisions_no_update_or_delete
BEFORE UPDATE OR DELETE ON abos.ledger_account_review_decisions
FOR EACH ROW EXECUTE FUNCTION abos.prevent_audit_mutation();

-- Independence, whoever inserts the decision: never the creator or the last person to change it.
CREATE OR REPLACE FUNCTION abos.guard_ledger_account_review()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  governance_row record;
BEGIN
  SELECT created_by_user_account_id, last_changed_by_user_account_id, version, review_state
    INTO governance_row
    FROM abos.ledger_account_governance
   WHERE ledger_account_id = NEW.ledger_account_id AND legal_entity_id = NEW.legal_entity_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'only accounts created or changed in the app are reviewed' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.reviewer_user_account_id = governance_row.created_by_user_account_id
     OR NEW.reviewer_user_account_id = governance_row.last_changed_by_user_account_id THEN
    RAISE EXCEPTION 'the reviewer of an account cannot be the person who created or last changed it'
      USING ERRCODE = 'ABC03';
  END IF;
  IF NEW.account_version <> governance_row.version THEN
    RAISE EXCEPTION 'the account was changed by someone else' USING ERRCODE = 'serialization_failure';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ledger_account_review_decisions_independence
BEFORE INSERT ON abos.ledger_account_review_decisions
FOR EACH ROW EXECUTE FUNCTION abos.guard_ledger_account_review();

-- ---------------------------------------------------------------------------
-- References from tables added by later packages (Saraf accounts in 0015, and so on).
--
-- Contract for those packages: attach
--   CREATE TRIGGER <table>_ledger_account_reference AFTER INSERT OR UPDATE OF <column> ON abos.<table>
--   FOR EACH ROW EXECUTE FUNCTION abos.ledger_account_mark_referenced('<column>');
-- Once registered, a reference is permanent: the account's code, type, currency, control type,
-- posting flag and dimension rules are frozen and the account cannot be deactivated.
-- ---------------------------------------------------------------------------
CREATE TABLE abos.ledger_account_references (
  ledger_account_id uuid NOT NULL,
  legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
  source_table text NOT NULL CHECK (source_table ~ '^[a-z_][a-z0-9_]{0,62}$'),
  first_referenced_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (ledger_account_id, source_table),
  FOREIGN KEY (ledger_account_id, legal_entity_id) REFERENCES abos.ledger_accounts(id, legal_entity_id)
);
CREATE TRIGGER ledger_account_references_no_update_or_delete
BEFORE UPDATE OR DELETE ON abos.ledger_account_references
FOR EACH ROW EXECUTE FUNCTION abos.prevent_audit_mutation();

CREATE OR REPLACE FUNCTION abos.ledger_account_mark_referenced()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  account_id uuid;
BEGIN
  IF TG_NARGS <> 1 THEN
    RAISE EXCEPTION 'ledger_account_mark_referenced needs the referencing column name';
  END IF;
  -- Read as JSON, so the function never resolves a column the table lacks.
  account_id := (to_jsonb(NEW) ->> TG_ARGV[0])::uuid;
  IF account_id IS NOT NULL THEN
    INSERT INTO abos.ledger_account_references (ledger_account_id, legal_entity_id, source_table)
    SELECT la.id, la.legal_entity_id, TG_TABLE_NAME FROM abos.ledger_accounts la WHERE la.id = account_id
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- Pure helpers: name normalization, similarity, usage.
-- ---------------------------------------------------------------------------

-- Lower case, Arabic-script letter variants unified (ي/ی, ك/ک, ة/ۀ/ه, أ/إ/آ/ا), Eastern digits to
-- ASCII, zero-width non-joiner and tatweel removed, punctuation collapsed to single spaces.
CREATE OR REPLACE FUNCTION abos.coa_normalize_name(p_name text)
RETURNS text
LANGUAGE sql IMMUTABLE STRICT
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT btrim(regexp_replace(
    lower(translate(normalize(p_name, NFKC),
      'يكىۀةأإآ٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹' || chr(8204) || chr(1600),
      'یکیههااا01234567890123456789')),
    '[^0-9a-zà-ɏؠ-يٮ-ۓۺ-ۿ]+', ' ', 'g'))
$$;

-- Letters and digits only, upper case: "1-100" and "1100" look alike.
CREATE OR REPLACE FUNCTION abos.coa_normalize_code(p_code text)
RETURNS text
LANGUAGE sql IMMUTABLE STRICT
SET search_path = pg_catalog, pg_temp
AS $$ SELECT upper(regexp_replace(p_code, '[^0-9A-Za-z]', '', 'g')) $$;

-- Jaccard similarity of character bigrams (0..1), on already-normalized names.
CREATE OR REPLACE FUNCTION abos.coa_name_similarity(p_left text, p_right text)
RETURNS numeric
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  WITH l AS (SELECT DISTINCT substr(' ' || p_left || ' ', i, 2) AS g
               FROM generate_series(1, length(' ' || coalesce(p_left, '') || ' ') - 1) AS i
              WHERE coalesce(p_left, '') <> ''),
       r AS (SELECT DISTINCT substr(' ' || p_right || ' ', i, 2) AS g
               FROM generate_series(1, length(' ' || coalesce(p_right, '') || ' ') - 1) AS i
              WHERE coalesce(p_right, '') <> ''),
       u AS (SELECT g FROM l UNION SELECT g FROM r),
       x AS (SELECT g FROM l INTERSECT SELECT g FROM r)
  SELECT CASE WHEN (SELECT count(*) FROM u) = 0 THEN 0::numeric
              ELSE round((SELECT count(*) FROM x)::numeric / (SELECT count(*) FROM u), 3) END
$$;

-- What refers to an account. "inUse" freezes its identifying attributes.
CREATE OR REPLACE FUNCTION abos.ledger_account_usage(p_account_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT u || jsonb_build_object('inUse',
           (u ->> 'journalLines')::integer > 0 OR (u ->> 'safeAccounts')::integer > 0
           OR jsonb_array_length(u -> 'references') > 0 OR (u ->> 'pendingPostingIntents')::integer > 0)
    FROM (SELECT jsonb_build_object(
      'journalLines', (SELECT count(*) FROM abos.journal_lines jl WHERE jl.ledger_account_id = p_account_id),
      'postedJournalLines', (SELECT count(*) FROM abos.journal_lines jl JOIN abos.journals j ON j.id = jl.journal_id
                              WHERE jl.ledger_account_id = p_account_id AND j.status = 'POSTED'),
      'safeAccounts', (SELECT count(*) FROM abos.cash_location_currency_accounts ca WHERE ca.ledger_account_id = p_account_id),
      'openSafeAccounts', (SELECT count(*) FROM abos.cash_location_currency_accounts ca
                            WHERE ca.ledger_account_id = p_account_id AND ca.activation_status <> 'BLOCKED'),
      'references', coalesce((SELECT jsonb_agg(r.source_table ORDER BY r.source_table) FROM abos.ledger_account_references r
                               WHERE r.ledger_account_id = p_account_id), '[]'::jsonb),
      -- The synthetic posting engine resolves the company's single active capital account at posting
      -- time (0007), so open capital posting intents in its currency depend on it.
      'pendingPostingIntents', (SELECT count(*) FROM abos.ledger_accounts la
                                 JOIN abos.posting_intents pi ON pi.legal_entity_id = la.legal_entity_id
                                  AND pi.intent_kind = 'SHAREHOLDER_CAPITAL_RECEIPT'
                                  AND pi.status IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED')
                                  AND pi.original_currency_code = la.account_currency_code
                                WHERE la.id = p_account_id AND la.control_account_type = 'SHAREHOLDER_CAPITAL'
                                  AND la.status = 'ACTIVE' AND la.posting_allowed),
      'children', (SELECT count(*) FROM abos.ledger_accounts c WHERE c.parent_ledger_account_id = p_account_id),
      'activeChildren', (SELECT count(*) FROM abos.ledger_accounts c WHERE c.parent_ledger_account_id = p_account_id AND c.status = 'ACTIVE')
    ) AS u) usage_row
$$;

-- ---------------------------------------------------------------------------
-- Protection of accounts, for every writer (the Finance owner, the migration identity, anyone).
-- Replaces 0011's lock-only trigger on this table: the Treasury owner still may not change an
-- account, and the Finance owner may change one only inside a Chart of Accounts entry point
-- (column grants limit what it can change; other Finance functions still only lock accounts).
-- ---------------------------------------------------------------------------
DROP TRIGGER ledger_accounts_owner_lock_only ON abos.ledger_accounts;

CREATE OR REPLACE FUNCTION abos.guard_ledger_account_change()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  usage jsonb;
  parent_row record;
  cursor_id uuid;
  depth integer := 1;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF current_user = 'abos_e1_treasury_owner'
       OR (current_user = 'abos_e1_finance_owner' AND coalesce(current_setting('abos.coa_command', true), '') <> 'on') THEN
      RAISE EXCEPTION '% may lock but not change %', current_user, TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.legal_entity_id IS DISTINCT FROM OLD.legal_entity_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'the identity of a ledger account cannot change' USING ERRCODE = 'ABC02';
    END IF;
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    usage := abos.ledger_account_usage(OLD.id);
    IF (usage ->> 'inUse')::boolean AND (
         NEW.account_code IS DISTINCT FROM OLD.account_code OR NEW.account_type IS DISTINCT FROM OLD.account_type
         OR NEW.account_currency_code IS DISTINCT FROM OLD.account_currency_code
         OR NEW.control_account_type IS DISTINCT FROM OLD.control_account_type
         OR NEW.requires_project IS DISTINCT FROM OLD.requires_project
         OR NEW.requires_department IS DISTINCT FROM OLD.requires_department
         OR NEW.requires_cost_center IS DISTINCT FROM OLD.requires_cost_center
         OR (OLD.posting_allowed AND NOT NEW.posting_allowed)) THEN
      RAISE EXCEPTION 'account % is in use, so its code, type, currency, control type, posting and dimension settings cannot change', OLD.account_code
        USING ERRCODE = 'ABC02';
    END IF;
    IF NEW.status = 'INACTIVE' AND OLD.status <> 'INACTIVE' AND (
         (usage ->> 'openSafeAccounts')::integer > 0 OR jsonb_array_length(usage -> 'references') > 0
         OR (usage ->> 'journalLines')::integer > (usage ->> 'postedJournalLines')::integer
         OR (usage ->> 'pendingPostingIntents')::integer > 0 OR (usage ->> 'activeChildren')::integer > 0) THEN
      RAISE EXCEPTION 'account % is in use and cannot be deactivated', OLD.account_code USING ERRCODE = 'ABC02';
    END IF;
    IF (usage ->> 'children')::integer > 0 AND (NEW.account_type IS DISTINCT FROM OLD.account_type
         OR NEW.account_currency_code IS DISTINCT FROM OLD.account_currency_code) THEN
      RAISE EXCEPTION 'account % has sub-accounts, so its type and currency cannot change', OLD.account_code USING ERRCODE = 'ABC02';
    END IF;
  END IF;

  IF NEW.parent_ledger_account_id IS NOT NULL AND (TG_OP = 'INSERT'
       OR NEW.parent_ledger_account_id IS DISTINCT FROM OLD.parent_ledger_account_id
       OR NEW.account_type IS DISTINCT FROM OLD.account_type
       OR NEW.account_currency_code IS DISTINCT FROM OLD.account_currency_code
       OR NEW.status IS DISTINCT FROM OLD.status) THEN
    SELECT account_type, account_currency_code, status INTO parent_row
      FROM abos.ledger_accounts
     WHERE id = NEW.parent_ledger_account_id AND legal_entity_id = NEW.legal_entity_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'the parent account does not exist in this company' USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF parent_row.account_type <> NEW.account_type THEN
      RAISE EXCEPTION 'a sub-account must have the same account type as its parent (%)', parent_row.account_type USING ERRCODE = 'check_violation';
    END IF;
    IF parent_row.account_currency_code IS NOT NULL AND NEW.account_currency_code IS DISTINCT FROM parent_row.account_currency_code THEN
      RAISE EXCEPTION 'a sub-account must use its parent''s currency (%)', parent_row.account_currency_code USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status = 'ACTIVE' AND parent_row.status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'an active account needs an active parent' USING ERRCODE = 'check_violation';
    END IF;
    cursor_id := NEW.parent_ledger_account_id;
    WHILE cursor_id IS NOT NULL LOOP
      IF cursor_id = NEW.id THEN
        RAISE EXCEPTION 'an account cannot be placed under itself or one of its own sub-accounts' USING ERRCODE = 'check_violation';
      END IF;
      depth := depth + 1;
      IF depth > 8 THEN
        RAISE EXCEPTION 'account grouping is limited to eight levels' USING ERRCODE = 'check_violation';
      END IF;
      SELECT parent_ledger_account_id INTO cursor_id FROM abos.ledger_accounts WHERE id = cursor_id;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ledger_accounts_coa_guard
BEFORE INSERT OR UPDATE ON abos.ledger_accounts
FOR EACH ROW EXECUTE FUNCTION abos.guard_ledger_account_change();

-- ---------------------------------------------------------------------------
-- Internal helpers used by the entry points (not callable by any runtime).
-- ---------------------------------------------------------------------------

-- A JSON text field: NULL when absent or null; refused when present with another type.
CREATE OR REPLACE FUNCTION abos.coa_text(p_input jsonb, p_key text)
RETURNS text
LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_input IS NULL OR NOT p_input ? p_key OR jsonb_typeof(p_input -> p_key) = 'null' THEN
    RETURN NULL;
  END IF;
  IF jsonb_typeof(p_input -> p_key) <> 'string' THEN
    RAISE EXCEPTION '% must be text', p_key USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN nullif(btrim(p_input ->> p_key), '');
END;
$$;

CREATE OR REPLACE FUNCTION abos.coa_bool(p_input jsonb, p_key text)
RETURNS boolean
LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_input IS NULL OR NOT p_input ? p_key OR jsonb_typeof(p_input -> p_key) = 'null' THEN
    RETURN NULL;
  END IF;
  IF jsonb_typeof(p_input -> p_key) <> 'boolean' THEN
    RAISE EXCEPTION '% must be true or false', p_key USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN (p_input ->> p_key)::boolean;
END;
$$;

CREATE OR REPLACE FUNCTION abos.coa_assert_keys(p_input jsonb)
RETURNS void
LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  unknown text;
BEGIN
  IF p_input IS NULL OR jsonb_typeof(p_input) <> 'object' THEN
    RAISE EXCEPTION 'the account details must be an object' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT string_agg(k, ', ') INTO unknown FROM jsonb_object_keys(p_input) AS k
   WHERE k NOT IN ('code', 'name', 'nameFa', 'description', 'type', 'controlType', 'currency', 'parentId',
                   'postingAllowed', 'requiresProject', 'requiresDepartment', 'requiresCostCenter');
  IF unknown IS NOT NULL THEN
    RAISE EXCEPTION 'unknown account fields: %', unknown USING ERRCODE = 'invalid_parameter_value';
  END IF;
END;
$$;

-- Structural rules for an account definition. Codes are free text within a safe character set:
-- no numbering convention has been approved.
CREATE OR REPLACE FUNCTION abos.coa_validate(
  p_code text, p_name text, p_name_fa text, p_description text, p_type text, p_control text,
  p_currency text, p_posting boolean, p_status text
) RETURNS void
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_code IS NULL OR p_code !~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,31}$' THEN
    RAISE EXCEPTION 'the account code must be 1-32 letters, digits or . _ / - and start with a letter or digit'
      USING ERRCODE = 'check_violation';
  END IF;
  IF p_name IS NULL OR length(p_name) NOT BETWEEN 2 AND 120 THEN
    RAISE EXCEPTION 'the account name must be 2-120 characters' USING ERRCODE = 'check_violation';
  END IF;
  IF p_name_fa IS NOT NULL AND length(p_name_fa) > 120 THEN
    RAISE EXCEPTION 'the Dari account name must be at most 120 characters' USING ERRCODE = 'check_violation';
  END IF;
  IF p_description IS NOT NULL AND length(p_description) > 500 THEN
    RAISE EXCEPTION 'the description must be at most 500 characters' USING ERRCODE = 'check_violation';
  END IF;
  IF p_type IS NULL OR p_type NOT IN ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE') THEN
    RAISE EXCEPTION 'the account type must be ASSET, LIABILITY, EQUITY, REVENUE or EXPENSE' USING ERRCODE = 'check_violation';
  END IF;
  IF p_control IS NOT NULL AND p_control NOT IN ('CASH', 'SARAF', 'SHAREHOLDER_CAPITAL', 'SHAREHOLDER_LOAN', 'AR', 'AP', 'OTHER') THEN
    RAISE EXCEPTION 'unknown control account type %', p_control USING ERRCODE = 'check_violation';
  END IF;
  -- A control account must carry the account type its balance has by definition.
  IF (p_control IN ('CASH', 'AR') AND p_type <> 'ASSET')
     OR (p_control IN ('AP', 'SHAREHOLDER_LOAN') AND p_type <> 'LIABILITY')
     OR (p_control = 'SHAREHOLDER_CAPITAL' AND p_type <> 'EQUITY')
     OR (p_control = 'SARAF' AND p_type NOT IN ('ASSET', 'LIABILITY')) THEN
    RAISE EXCEPTION 'a % control account cannot have account type %', p_control, p_type USING ERRCODE = 'check_violation';
  END IF;
  IF p_posting IS NULL THEN
    RAISE EXCEPTION 'say whether the account accepts postings' USING ERRCODE = 'check_violation';
  END IF;
  -- Currencies are never combined: an account that takes postings, or a control account, has one.
  IF p_currency IS NULL AND (p_posting OR p_control IS NOT NULL) THEN
    RAISE EXCEPTION 'an account that accepts postings, or a control account, needs a currency' USING ERRCODE = 'check_violation';
  END IF;
  IF p_currency IS NOT NULL AND p_status = 'ACTIVE'
     AND NOT EXISTS (SELECT 1 FROM abos.currencies c WHERE c.code = p_currency AND c.enabled) THEN
    RAISE EXCEPTION 'currency % is not enabled', p_currency USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

-- The synthetic posting engine (0007) needs exactly one active posting capital account per
-- currency; a second one would stop capital posting, so it is refused with that reason.
CREATE OR REPLACE FUNCTION abos.coa_assert_single_capital(
  p_entity uuid, p_account_id uuid, p_control text, p_currency text, p_posting boolean, p_status text
) RETURNS void
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_control = 'SHAREHOLDER_CAPITAL' AND p_posting AND p_status = 'ACTIVE' AND EXISTS (
    SELECT 1 FROM abos.ledger_accounts la
     WHERE la.legal_entity_id = p_entity AND la.id IS DISTINCT FROM p_account_id
       AND la.control_account_type = 'SHAREHOLDER_CAPITAL' AND la.posting_allowed AND la.status = 'ACTIVE'
       AND la.account_currency_code = p_currency) THEN
    RAISE EXCEPTION 'an active shareholder capital account in % already exists; capital posting needs exactly one', p_currency
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

-- Likely-duplicate warnings for a proposed definition. Never blocks by itself.
CREATE OR REPLACE FUNCTION abos.coa_duplicate_warnings(
  p_entity uuid, p_exclude uuid, p_code text, p_name text, p_name_fa text, p_type text, p_currency text, p_control text
) RETURNS jsonb
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  WITH proposed AS (
    SELECT coalesce(abos.coa_normalize_name(p_name), '') AS n, coalesce(abos.coa_normalize_name(p_name_fa), '') AS nf,
           coalesce(abos.coa_normalize_code(p_code), '') AS c
  ), scored AS (
    SELECT la.id, la.account_code, la.account_name, g.account_name_fa, la.account_type, la.account_currency_code,
           la.control_account_type, la.status,
           abos.coa_normalize_name(la.account_name) AS n_old, coalesce(abos.coa_normalize_name(g.account_name_fa), '') AS nf_old,
           p.n, p.nf, p.c
      FROM abos.ledger_accounts la
      LEFT JOIN abos.ledger_account_governance g ON g.ledger_account_id = la.id
      CROSS JOIN proposed p
     WHERE la.legal_entity_id = p_entity AND la.id IS DISTINCT FROM p_exclude
  ), flagged AS (
    SELECT s.*,
           (s.n <> '' AND (s.n = s.n_old OR s.n = s.nf_old)) OR (s.nf <> '' AND (s.nf = s.nf_old OR s.nf = s.n_old)) AS same_name,
           greatest(abos.coa_name_similarity(s.n, s.n_old), abos.coa_name_similarity(s.nf, s.nf_old),
                    abos.coa_name_similarity(s.n, s.nf_old), abos.coa_name_similarity(s.nf, s.n_old)) AS similarity,
           s.c <> '' AND s.c = abos.coa_normalize_code(s.account_code)
             AND lower(btrim(s.account_code)) <> lower(coalesce(btrim(p_code), '')) AS similar_code,
           s.account_type = p_type AS same_type,
           s.account_currency_code IS NOT DISTINCT FROM p_currency AS same_currency,
           p_control IS NOT NULL AND s.control_account_type IS NOT DISTINCT FROM p_control AS same_control
      FROM scored s
  ), warnings AS (
    SELECT f.*, f.same_name OR f.similarity >= 0.6 AS name_match FROM flagged f
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'accountId', w.id, 'code', w.account_code, 'name', w.account_name, 'nameFa', w.account_name_fa,
           'type', w.account_type, 'currency', w.account_currency_code, 'controlType', w.control_account_type,
           'status', w.status, 'similarity', w.similarity,
           'reasons', to_jsonb(array_remove(ARRAY[
              CASE WHEN w.same_name THEN 'SAME_NAME' WHEN w.name_match THEN 'SIMILAR_NAME' END,
              CASE WHEN w.similar_code THEN 'SIMILAR_CODE' END,
              CASE WHEN w.same_type THEN 'SAME_TYPE' END,
              CASE WHEN w.same_currency THEN 'SAME_CURRENCY' END,
              CASE WHEN w.same_control THEN 'SAME_CONTROL_TYPE' END], NULL)),
           'severity', CASE WHEN w.similar_code OR (w.name_match AND w.same_type AND w.same_currency) THEN 'LIKELY' ELSE 'POSSIBLE' END)
           ORDER BY (w.similar_code OR (w.name_match AND w.same_type AND w.same_currency)) DESC, w.similarity DESC, w.account_code), '[]'::jsonb)
    FROM (SELECT * FROM warnings WHERE name_match OR similar_code
           ORDER BY (similar_code OR (name_match AND same_type AND same_currency)) DESC, similarity DESC, account_code LIMIT 10) w
$$;

-- One account as the interface sees it. p_viewer marks whether the viewer took part in it.
CREATE OR REPLACE FUNCTION abos.coa_account_json(p_account_id uuid, p_viewer uuid)
RETURNS jsonb
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT jsonb_build_object(
    'id', la.id, 'code', la.account_code, 'name', la.account_name, 'nameFa', g.account_name_fa, 'description', g.description,
    'type', la.account_type, 'controlType', la.control_account_type, 'currency', la.account_currency_code,
    'parentId', la.parent_ledger_account_id, 'postingAllowed', la.posting_allowed,
    'requiresProject', la.requires_project, 'requiresDepartment', la.requires_department, 'requiresCostCenter', la.requires_cost_center,
    'status', la.status, 'createdAt', la.created_at,
    'origin', coalesce(g.origin, 'PRE_EXISTING'), 'version', coalesce(g.version, 0),
    'reviewState', g.review_state, 'reviewReason', g.review_reason,
    'createdBy', (SELECT u.display_name FROM abos.user_accounts u WHERE u.id = g.created_by_user_account_id),
    'lastChangedBy', (SELECT u.display_name FROM abos.user_accounts u WHERE u.id = g.last_changed_by_user_account_id),
    'lastChangedAt', g.last_changed_at,
    'lastReviewedBy', (SELECT u.display_name FROM abos.user_accounts u WHERE u.id = g.last_reviewed_by_user_account_id),
    'lastReviewedAt', g.last_reviewed_at, 'lastReviewNote', g.last_review_note,
    'duplicateWarnings', coalesce(g.duplicate_warnings, '[]'::jsonb),
    'viewerIsParticipant', p_viewer IS NOT NULL AND (p_viewer = g.created_by_user_account_id OR p_viewer = g.last_changed_by_user_account_id),
    'usage', abos.ledger_account_usage(la.id),
    'reviews', coalesce((SELECT jsonb_agg(jsonb_build_object('decision', d.decision, 'note', d.note, 'version', d.account_version,
                                  'reviewer', (SELECT u.display_name FROM abos.user_accounts u WHERE u.id = d.reviewer_user_account_id),
                                  'decidedAt', d.decided_at) ORDER BY d.decided_at DESC)
                           FROM abos.ledger_account_review_decisions d WHERE d.ledger_account_id = la.id), '[]'::jsonb))
    FROM abos.ledger_accounts la
    LEFT JOIN abos.ledger_account_governance g ON g.ledger_account_id = la.id
   WHERE la.id = p_account_id
$$;

-- ---------------------------------------------------------------------------
-- Restricted Finance entry points.
-- ---------------------------------------------------------------------------

-- Everything a Chart of Accounts screen needs. Holders of manage, review or the operational
-- Finance read permission may view.
CREATE OR REPLACE FUNCTION abos.finance_ledger_accounts_view(p_bearer_token text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $view$
DECLARE
  actor uuid;
  entity uuid;
  can_manage boolean := false;
  can_review boolean := false;
  can_read boolean := false;
BEGIN
  BEGIN
    actor := abos.finance_runtime_authorize(p_bearer_token, 'finance.ledger-account.manage');
    can_manage := true;
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    actor := abos.finance_runtime_authorize(p_bearer_token, 'finance.ledger-account.review');
    can_review := true;
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    actor := abos.finance_runtime_authorize(p_bearer_token, 'finance.report.operational.read');
    can_read := true;
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  IF NOT (can_manage OR can_review OR can_read) THEN
    -- Re-raise the real refusal: an ended session, or the missing permission.
    actor := abos.finance_runtime_authorize(p_bearer_token, 'finance.ledger-account.manage');
  END IF;
  entity := current_setting('abos.finance_legal_entity_id')::uuid;
  RETURN jsonb_build_object(
    'canManage', can_manage, 'canReview', can_review,
    'actor', (SELECT jsonb_build_object('displayName', u.display_name) FROM abos.user_accounts u WHERE u.id = actor),
    'legalEntity', (SELECT jsonb_build_object('id', e.id, 'name', e.name, 'baseCurrency', e.base_currency_code)
                      FROM abos.legal_entities e WHERE e.id = entity),
    'currencies', coalesce((SELECT jsonb_agg(jsonb_build_object('code', c.code, 'name', c.name) ORDER BY c.code)
                              FROM abos.currencies c WHERE c.enabled), '[]'::jsonb),
    'accounts', coalesce((SELECT jsonb_agg(abos.coa_account_json(la.id, actor) ORDER BY lower(la.account_code))
                            FROM abos.ledger_accounts la WHERE la.legal_entity_id = entity), '[]'::jsonb),
    'reviewQueue', (SELECT count(*) FROM abos.ledger_account_governance g
                     WHERE g.legal_entity_id = entity AND g.review_state IN ('PENDING_REVIEW', 'FLAGGED')));
END;
$view$;

-- Live duplicate check while a person types. p_account_id is the account being edited, or NULL.
CREATE OR REPLACE FUNCTION abos.finance_ledger_account_check(p_bearer_token text, p_account jsonb, p_account_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $check$
DECLARE
  actor uuid;
  entity uuid;
  v_code text;
  conflict record;
BEGIN
  actor := abos.finance_runtime_authorize(p_bearer_token, 'finance.ledger-account.manage');
  entity := current_setting('abos.finance_legal_entity_id')::uuid;
  PERFORM abos.coa_assert_keys(p_account);
  v_code := abos.coa_text(p_account, 'code');
  SELECT la.id, la.account_code, la.account_name INTO conflict
    FROM abos.ledger_accounts la
   WHERE la.legal_entity_id = entity AND la.id IS DISTINCT FROM p_account_id
     AND v_code IS NOT NULL AND lower(la.account_code) = lower(v_code)
   LIMIT 1;
  RETURN jsonb_build_object(
    'codeTaken', CASE WHEN conflict.id IS NULL THEN NULL
                      ELSE jsonb_build_object('accountId', conflict.id, 'code', conflict.account_code, 'name', conflict.account_name) END,
    'warnings', abos.coa_duplicate_warnings(entity, p_account_id, v_code, abos.coa_text(p_account, 'name'),
                  abos.coa_text(p_account, 'nameFa'), abos.coa_text(p_account, 'type'), abos.coa_text(p_account, 'currency'),
                  abos.coa_text(p_account, 'controlType')));
END;
$check$;

-- Creates an account that is ACTIVE at once and waits in the Finance Manager's review list.
CREATE OR REPLACE FUNCTION abos.finance_ledger_account_create(p_bearer_token text, p_account jsonb, p_confirm_duplicates boolean)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $create$
DECLARE
  actor uuid;
  entity uuid;
  new_id uuid := gen_random_uuid();
  v_code text; v_name text; v_name_fa text; v_description text; v_type text; v_control text; v_currency text;
  v_parent uuid; v_posting boolean;
  warnings jsonb;
  created jsonb;
BEGIN
  actor := abos.finance_runtime_authorize(p_bearer_token, 'finance.ledger-account.manage');
  entity := current_setting('abos.finance_legal_entity_id')::uuid;
  PERFORM abos.coa_assert_keys(p_account);
  v_code := abos.coa_text(p_account, 'code');
  v_name := abos.coa_text(p_account, 'name');
  v_name_fa := abos.coa_text(p_account, 'nameFa');
  v_description := abos.coa_text(p_account, 'description');
  v_type := abos.coa_text(p_account, 'type');
  v_control := abos.coa_text(p_account, 'controlType');
  v_currency := abos.coa_text(p_account, 'currency');
  BEGIN
    v_parent := abos.coa_text(p_account, 'parentId')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'the parent account does not exist in this company' USING ERRCODE = 'foreign_key_violation';
  END;
  v_posting := abos.coa_bool(p_account, 'postingAllowed');
  PERFORM abos.coa_validate(v_code, v_name, v_name_fa, v_description, v_type, v_control, v_currency, v_posting, 'ACTIVE');

  -- One writer per company at a time, so the duplicate check and the insert see the same accounts.
  PERFORM pg_advisory_xact_lock(hashtextextended('abos-coa:' || entity::text, 0));
  IF EXISTS (SELECT 1 FROM abos.ledger_accounts la WHERE la.legal_entity_id = entity AND lower(btrim(la.account_code)) = lower(v_code)) THEN
    RAISE EXCEPTION 'account code % already exists in this company', v_code USING ERRCODE = 'unique_violation';
  END IF;
  PERFORM abos.coa_assert_single_capital(entity, NULL, v_control, v_currency, v_posting, 'ACTIVE');
  warnings := abos.coa_duplicate_warnings(entity, NULL, v_code, v_name, v_name_fa, v_type, v_currency, v_control);
  IF jsonb_path_exists(warnings, '$[*] ? (@.severity == "LIKELY")') AND NOT coalesce(p_confirm_duplicates, false) THEN
    RAISE EXCEPTION 'likely duplicate accounts exist; review the warnings and confirm to create the account anyway'
      USING ERRCODE = 'ABC01', DETAIL = warnings::text;
  END IF;

  PERFORM pg_catalog.set_config('abos.coa_command', 'on', true);
  INSERT INTO abos.ledger_accounts
    (id, legal_entity_id, parent_ledger_account_id, account_code, account_name, account_type, control_account_type,
     posting_allowed, requires_project, requires_department, requires_cost_center, account_currency_code, status)
  VALUES (new_id, entity, v_parent, v_code, v_name, v_type, v_control, v_posting,
          coalesce(abos.coa_bool(p_account, 'requiresProject'), false),
          coalesce(abos.coa_bool(p_account, 'requiresDepartment'), false),
          coalesce(abos.coa_bool(p_account, 'requiresCostCenter'), false),
          v_currency, 'ACTIVE');
  INSERT INTO abos.ledger_account_governance
    (ledger_account_id, legal_entity_id, account_name_fa, description, origin, created_by_user_account_id, created_at,
     last_changed_by_user_account_id, last_changed_at, version, review_state, review_reason, duplicate_warnings)
  VALUES (new_id, entity, v_name_fa, v_description, 'APP', actor, clock_timestamp(), actor, clock_timestamp(), 1,
          'PENDING_REVIEW', 'CREATED', warnings);
  PERFORM pg_catalog.set_config('abos.coa_command', '', true);

  created := abos.coa_account_json(new_id, NULL);
  INSERT INTO abos.audit_records (id, actor_user_account_id, legal_entity_id, correlation_id, action, entity_type, entity_id, after_state, metadata)
  VALUES (gen_random_uuid(), actor, entity, gen_random_uuid(), 'LEDGER_ACCOUNT_CREATED', 'LEDGER_ACCOUNT', new_id, created - 'usage' - 'reviews',
          jsonb_build_object('source', 'finance_ledger_account_create', 'duplicateWarnings', warnings,
                             'confirmedDuplicates', coalesce(p_confirm_duplicates, false)));
  RETURN jsonb_build_object('account', abos.coa_account_json(new_id, actor), 'warnings', warnings);
END;
$create$;

-- Changes the definition of an account. Every change returns it to the review list.
CREATE OR REPLACE FUNCTION abos.finance_ledger_account_update(
  p_bearer_token text, p_account_id uuid, p_expected_version integer, p_changes jsonb, p_confirm_duplicates boolean
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $update$
DECLARE
  actor uuid;
  entity uuid;
  account_row abos.ledger_accounts%ROWTYPE;
  governance_row abos.ledger_account_governance%ROWTYPE;
  has_governance boolean;
  before_state jsonb;
  usage jsonb;
  warnings jsonb := '[]'::jsonb;
  ledger_changed boolean;
  identity_changed boolean;
  v_code text; v_name text; v_name_fa text; v_description text; v_type text; v_control text; v_currency text;
  v_parent uuid; v_posting boolean; v_project boolean; v_department boolean; v_cost_center boolean;
BEGIN
  actor := abos.finance_runtime_authorize(p_bearer_token, 'finance.ledger-account.manage');
  entity := current_setting('abos.finance_legal_entity_id')::uuid;
  PERFORM abos.coa_assert_keys(p_changes);
  IF p_expected_version IS NULL THEN
    RAISE EXCEPTION 'the expected account version is required' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('abos-coa:' || entity::text, 0));
  SELECT * INTO account_row FROM abos.ledger_accounts WHERE id = p_account_id AND legal_entity_id = entity FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ledger account not found' USING ERRCODE = 'no_data_found';
  END IF;
  SELECT * INTO governance_row FROM abos.ledger_account_governance WHERE ledger_account_id = p_account_id FOR UPDATE;
  has_governance := FOUND;
  IF coalesce(governance_row.version, 0) <> p_expected_version THEN
    RAISE EXCEPTION 'the account was changed by someone else' USING ERRCODE = 'serialization_failure';
  END IF;
  before_state := abos.coa_account_json(p_account_id, NULL) - 'usage' - 'reviews';

  v_code := CASE WHEN p_changes ? 'code' THEN abos.coa_text(p_changes, 'code') ELSE account_row.account_code END;
  v_name := CASE WHEN p_changes ? 'name' THEN abos.coa_text(p_changes, 'name') ELSE account_row.account_name END;
  v_name_fa := CASE WHEN p_changes ? 'nameFa' THEN abos.coa_text(p_changes, 'nameFa') ELSE governance_row.account_name_fa END;
  v_description := CASE WHEN p_changes ? 'description' THEN abos.coa_text(p_changes, 'description') ELSE governance_row.description END;
  v_type := CASE WHEN p_changes ? 'type' THEN abos.coa_text(p_changes, 'type') ELSE account_row.account_type END;
  v_control := CASE WHEN p_changes ? 'controlType' THEN abos.coa_text(p_changes, 'controlType') ELSE account_row.control_account_type END;
  v_currency := CASE WHEN p_changes ? 'currency' THEN abos.coa_text(p_changes, 'currency') ELSE account_row.account_currency_code END;
  BEGIN
    v_parent := CASE WHEN p_changes ? 'parentId' THEN abos.coa_text(p_changes, 'parentId')::uuid ELSE account_row.parent_ledger_account_id END;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'the parent account does not exist in this company' USING ERRCODE = 'foreign_key_violation';
  END;
  v_posting := CASE WHEN p_changes ? 'postingAllowed' THEN abos.coa_bool(p_changes, 'postingAllowed') ELSE account_row.posting_allowed END;
  v_project := coalesce(CASE WHEN p_changes ? 'requiresProject' THEN abos.coa_bool(p_changes, 'requiresProject') END, account_row.requires_project);
  v_department := coalesce(CASE WHEN p_changes ? 'requiresDepartment' THEN abos.coa_bool(p_changes, 'requiresDepartment') END, account_row.requires_department);
  v_cost_center := coalesce(CASE WHEN p_changes ? 'requiresCostCenter' THEN abos.coa_bool(p_changes, 'requiresCostCenter') END, account_row.requires_cost_center);

  ledger_changed := (v_code, v_name, v_type, v_control, v_currency, v_parent, v_posting, v_project, v_department, v_cost_center)
    IS DISTINCT FROM (account_row.account_code, account_row.account_name, account_row.account_type, account_row.control_account_type,
                      account_row.account_currency_code, account_row.parent_ledger_account_id, account_row.posting_allowed,
                      account_row.requires_project, account_row.requires_department, account_row.requires_cost_center);
  IF NOT ledger_changed AND (v_name_fa, v_description) IS NOT DISTINCT FROM (governance_row.account_name_fa, governance_row.description) THEN
    RETURN jsonb_build_object('account', abos.coa_account_json(p_account_id, actor), 'warnings', '[]'::jsonb, 'changed', false);
  END IF;

  PERFORM abos.coa_validate(v_code, v_name, v_name_fa, v_description, v_type, v_control, v_currency, v_posting, account_row.status);
  usage := abos.ledger_account_usage(p_account_id);
  IF ledger_changed AND (usage ->> 'postedJournalLines')::integer > 0 THEN
    RAISE EXCEPTION 'account % has posted activity; only its Dari name and description can change', account_row.account_code
      USING ERRCODE = 'ABC02';
  END IF;
  IF (usage ->> 'inUse')::boolean AND (
       (v_code, v_type, v_currency, v_control, v_project, v_department, v_cost_center) IS DISTINCT FROM
       (account_row.account_code, account_row.account_type, account_row.account_currency_code, account_row.control_account_type,
        account_row.requires_project, account_row.requires_department, account_row.requires_cost_center)
       OR (account_row.posting_allowed AND NOT v_posting)) THEN
    RAISE EXCEPTION 'account % is in use, so its code, type, currency, control type, posting and dimension settings cannot change', account_row.account_code
      USING ERRCODE = 'ABC02';
  END IF;
  IF lower(v_code) <> lower(account_row.account_code) AND EXISTS (
       SELECT 1 FROM abos.ledger_accounts la WHERE la.legal_entity_id = entity AND la.id <> p_account_id
          AND lower(btrim(la.account_code)) = lower(v_code)) THEN
    RAISE EXCEPTION 'account code % already exists in this company', v_code USING ERRCODE = 'unique_violation';
  END IF;
  PERFORM abos.coa_assert_single_capital(entity, p_account_id, v_control, v_currency, v_posting, account_row.status);

  identity_changed := (v_code, v_name, v_name_fa, v_type, v_currency, v_control) IS DISTINCT FROM
    (account_row.account_code, account_row.account_name, governance_row.account_name_fa, account_row.account_type,
     account_row.account_currency_code, account_row.control_account_type);
  IF identity_changed THEN
    warnings := abos.coa_duplicate_warnings(entity, p_account_id, v_code, v_name, v_name_fa, v_type, v_currency, v_control);
    IF jsonb_path_exists(warnings, '$[*] ? (@.severity == "LIKELY")') AND NOT coalesce(p_confirm_duplicates, false) THEN
      RAISE EXCEPTION 'likely duplicate accounts exist; review the warnings and confirm to save the change anyway'
        USING ERRCODE = 'ABC01', DETAIL = warnings::text;
    END IF;
  END IF;

  PERFORM pg_catalog.set_config('abos.coa_command', 'on', true);
  IF ledger_changed THEN
    UPDATE abos.ledger_accounts
       SET account_code = v_code, account_name = v_name, account_type = v_type, control_account_type = v_control,
           account_currency_code = v_currency, parent_ledger_account_id = v_parent, posting_allowed = v_posting,
           requires_project = v_project, requires_department = v_department, requires_cost_center = v_cost_center
     WHERE id = p_account_id;
  END IF;
  IF has_governance THEN
    UPDATE abos.ledger_account_governance
       SET account_name_fa = v_name_fa, description = v_description,
           last_changed_by_user_account_id = actor, last_changed_at = clock_timestamp(), version = version + 1,
           review_reason = CASE WHEN review_state = 'PENDING_REVIEW' THEN review_reason ELSE 'CHANGED' END,
           review_state = 'PENDING_REVIEW',
           duplicate_warnings = CASE WHEN identity_changed THEN warnings ELSE duplicate_warnings END
     WHERE ledger_account_id = p_account_id;
  ELSE
    -- An account created outside the app (for example the synthetic seed) enters the review list
    -- the first time it is changed in the app.
    INSERT INTO abos.ledger_account_governance
      (ledger_account_id, legal_entity_id, account_name_fa, description, origin, created_by_user_account_id, created_at,
       last_changed_by_user_account_id, last_changed_at, version, review_state, review_reason, duplicate_warnings)
    VALUES (p_account_id, entity, v_name_fa, v_description, 'PRE_EXISTING', NULL, account_row.created_at, actor, clock_timestamp(), 1,
            'PENDING_REVIEW', 'CHANGED', warnings);
  END IF;
  PERFORM pg_catalog.set_config('abos.coa_command', '', true);

  INSERT INTO abos.audit_records (id, actor_user_account_id, legal_entity_id, correlation_id, action, entity_type, entity_id, before_state, after_state, metadata)
  VALUES (gen_random_uuid(), actor, entity, gen_random_uuid(), 'LEDGER_ACCOUNT_UPDATED', 'LEDGER_ACCOUNT', p_account_id, before_state,
          abos.coa_account_json(p_account_id, NULL) - 'usage' - 'reviews',
          jsonb_build_object('source', 'finance_ledger_account_update', 'duplicateWarnings', warnings,
                             'confirmedDuplicates', coalesce(p_confirm_duplicates, false)));
  RETURN jsonb_build_object('account', abos.coa_account_json(p_account_id, actor), 'warnings', warnings, 'changed', true);
END;
$update$;

-- Deactivates or reactivates an account. Deactivation needs a reason and is refused while the
-- account is in open use.
CREATE OR REPLACE FUNCTION abos.finance_ledger_account_set_status(
  p_bearer_token text, p_account_id uuid, p_expected_version integer, p_status text, p_reason text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $status$
DECLARE
  actor uuid;
  entity uuid;
  account_row abos.ledger_accounts%ROWTYPE;
  governance_row abos.ledger_account_governance%ROWTYPE;
  has_governance boolean;
  usage jsonb;
  before_state jsonb;
  v_reason text := nullif(btrim(p_reason), '');
BEGIN
  actor := abos.finance_runtime_authorize(p_bearer_token, 'finance.ledger-account.manage');
  entity := current_setting('abos.finance_legal_entity_id')::uuid;
  IF p_status IS NULL OR p_status NOT IN ('ACTIVE', 'INACTIVE') THEN
    RAISE EXCEPTION 'the status must be ACTIVE or INACTIVE' USING ERRCODE = 'check_violation';
  END IF;
  IF p_expected_version IS NULL THEN
    RAISE EXCEPTION 'the expected account version is required' USING ERRCODE = 'check_violation';
  END IF;
  IF v_reason IS NOT NULL AND length(v_reason) > 500 THEN
    RAISE EXCEPTION 'the reason must be at most 500 characters' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('abos-coa:' || entity::text, 0));
  SELECT * INTO account_row FROM abos.ledger_accounts WHERE id = p_account_id AND legal_entity_id = entity FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ledger account not found' USING ERRCODE = 'no_data_found';
  END IF;
  SELECT * INTO governance_row FROM abos.ledger_account_governance WHERE ledger_account_id = p_account_id FOR UPDATE;
  has_governance := FOUND;
  IF coalesce(governance_row.version, 0) <> p_expected_version THEN
    RAISE EXCEPTION 'the account was changed by someone else' USING ERRCODE = 'serialization_failure';
  END IF;
  IF account_row.status = p_status THEN
    RETURN jsonb_build_object('account', abos.coa_account_json(p_account_id, actor), 'changed', false);
  END IF;

  usage := abos.ledger_account_usage(p_account_id);
  IF (usage ->> 'postedJournalLines')::integer > 0 THEN
    RAISE EXCEPTION 'account % has posted activity; its status cannot change', account_row.account_code USING ERRCODE = 'ABC02';
  END IF;
  IF p_status = 'INACTIVE' THEN
    IF v_reason IS NULL OR length(v_reason) < 3 THEN
      RAISE EXCEPTION 'give a reason for deactivating the account' USING ERRCODE = 'check_violation';
    END IF;
    IF (usage ->> 'openSafeAccounts')::integer > 0 THEN
      RAISE EXCEPTION 'account % is used by a safe currency account; block that safe account first', account_row.account_code USING ERRCODE = 'ABC02';
    END IF;
    IF jsonb_array_length(usage -> 'references') > 0 THEN
      RAISE EXCEPTION 'account % is used by % and cannot be deactivated', account_row.account_code, usage -> 'references' USING ERRCODE = 'ABC02';
    END IF;
    IF (usage ->> 'journalLines')::integer > 0 OR (usage ->> 'pendingPostingIntents')::integer > 0 THEN
      RAISE EXCEPTION 'account % has journals or postings in progress and cannot be deactivated', account_row.account_code USING ERRCODE = 'ABC02';
    END IF;
    IF (usage ->> 'activeChildren')::integer > 0 THEN
      RAISE EXCEPTION 'account % has active sub-accounts; deactivate them first', account_row.account_code USING ERRCODE = 'ABC02';
    END IF;
  ELSE
    PERFORM abos.coa_validate(account_row.account_code, account_row.account_name, governance_row.account_name_fa, governance_row.description,
      account_row.account_type, account_row.control_account_type, account_row.account_currency_code, account_row.posting_allowed, 'ACTIVE');
    PERFORM abos.coa_assert_single_capital(entity, p_account_id, account_row.control_account_type, account_row.account_currency_code,
      account_row.posting_allowed, 'ACTIVE');
  END IF;

  before_state := abos.coa_account_json(p_account_id, NULL) - 'usage' - 'reviews';
  PERFORM pg_catalog.set_config('abos.coa_command', 'on', true);
  UPDATE abos.ledger_accounts SET status = p_status WHERE id = p_account_id;
  IF has_governance THEN
    UPDATE abos.ledger_account_governance SET version = version + 1 WHERE ledger_account_id = p_account_id;
  END IF;
  PERFORM pg_catalog.set_config('abos.coa_command', '', true);

  INSERT INTO abos.audit_records (id, actor_user_account_id, legal_entity_id, correlation_id, action, entity_type, entity_id, before_state, after_state, metadata)
  VALUES (gen_random_uuid(), actor, entity, gen_random_uuid(),
          CASE WHEN p_status = 'INACTIVE' THEN 'LEDGER_ACCOUNT_DEACTIVATED' ELSE 'LEDGER_ACCOUNT_REACTIVATED' END,
          'LEDGER_ACCOUNT', p_account_id, before_state, abos.coa_account_json(p_account_id, NULL) - 'usage' - 'reviews',
          jsonb_build_object('source', 'finance_ledger_account_set_status', 'reason', v_reason));
  RETURN jsonb_build_object('account', abos.coa_account_json(p_account_id, actor), 'changed', true);
END;
$status$;

-- The Finance Manager's decision on an account in the review list.
CREATE OR REPLACE FUNCTION abos.finance_ledger_account_review(
  p_bearer_token text, p_account_id uuid, p_expected_version integer, p_decision text, p_note text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $review$
DECLARE
  actor uuid;
  entity uuid;
  governance_row abos.ledger_account_governance%ROWTYPE;
  v_note text := nullif(btrim(p_note), '');
BEGIN
  actor := abos.finance_runtime_authorize(p_bearer_token, 'finance.ledger-account.review');
  entity := current_setting('abos.finance_legal_entity_id')::uuid;
  IF p_decision IS NULL OR p_decision NOT IN ('REVIEWED', 'FLAGGED') THEN
    RAISE EXCEPTION 'the decision must be REVIEWED or FLAGGED' USING ERRCODE = 'check_violation';
  END IF;
  IF p_decision = 'FLAGGED' AND (v_note IS NULL OR length(v_note) < 3) THEN
    RAISE EXCEPTION 'say what needs correcting when flagging an account' USING ERRCODE = 'check_violation';
  END IF;
  IF v_note IS NOT NULL AND length(v_note) > 500 THEN
    RAISE EXCEPTION 'the note must be at most 500 characters' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM abos.ledger_accounts WHERE id = p_account_id AND legal_entity_id = entity) THEN
    RAISE EXCEPTION 'ledger account not found' USING ERRCODE = 'no_data_found';
  END IF;
  SELECT * INTO governance_row FROM abos.ledger_account_governance
   WHERE ledger_account_id = p_account_id AND legal_entity_id = entity FOR UPDATE;
  IF NOT FOUND OR governance_row.review_state NOT IN ('PENDING_REVIEW', 'FLAGGED') THEN
    RAISE EXCEPTION 'this account is not waiting for review' USING ERRCODE = 'check_violation';
  END IF;
  IF p_expected_version IS DISTINCT FROM governance_row.version THEN
    RAISE EXCEPTION 'the account was changed by someone else' USING ERRCODE = 'serialization_failure';
  END IF;
  IF actor = governance_row.created_by_user_account_id OR actor = governance_row.last_changed_by_user_account_id THEN
    RAISE EXCEPTION 'the reviewer of an account cannot be the person who created or last changed it' USING ERRCODE = 'ABC03';
  END IF;

  INSERT INTO abos.ledger_account_review_decisions
    (id, ledger_account_id, legal_entity_id, account_version, decision, note, reviewer_user_account_id)
  VALUES (gen_random_uuid(), p_account_id, entity, governance_row.version, p_decision, v_note, actor);
  UPDATE abos.ledger_account_governance
     SET review_state = p_decision, last_reviewed_by_user_account_id = actor, last_reviewed_at = clock_timestamp(),
         last_review_note = v_note, version = version + 1
   WHERE ledger_account_id = p_account_id;

  INSERT INTO abos.audit_records (id, actor_user_account_id, legal_entity_id, correlation_id, action, entity_type, entity_id, before_state, after_state, metadata)
  VALUES (gen_random_uuid(), actor, entity, gen_random_uuid(),
          CASE WHEN p_decision = 'REVIEWED' THEN 'LEDGER_ACCOUNT_REVIEWED' ELSE 'LEDGER_ACCOUNT_FLAGGED' END,
          'LEDGER_ACCOUNT', p_account_id,
          jsonb_build_object('reviewState', governance_row.review_state, 'version', governance_row.version),
          jsonb_build_object('reviewState', p_decision, 'version', governance_row.version + 1),
          jsonb_build_object('source', 'finance_ledger_account_review', 'note', v_note));
  RETURN jsonb_build_object('account', abos.coa_account_json(p_account_id, actor));
END;
$review$;

-- ---------------------------------------------------------------------------
-- Ownership and access, following 0011.
-- ---------------------------------------------------------------------------
GRANT INSERT (id, legal_entity_id, parent_ledger_account_id, account_code, account_name, account_type, control_account_type,
  posting_allowed, requires_project, requires_department, requires_cost_center, account_currency_code, status)
  ON abos.ledger_accounts TO abos_e1_finance_owner;
GRANT UPDATE (parent_ledger_account_id, account_code, account_name, account_type, control_account_type, posting_allowed,
  requires_project, requires_department, requires_cost_center, account_currency_code, status)
  ON abos.ledger_accounts TO abos_e1_finance_owner;
GRANT SELECT, INSERT ON abos.ledger_account_governance TO abos_e1_finance_owner;
GRANT UPDATE (account_name_fa, description, last_changed_by_user_account_id, last_changed_at, version, review_state,
  review_reason, duplicate_warnings, last_reviewed_by_user_account_id, last_reviewed_at, last_review_note)
  ON abos.ledger_account_governance TO abos_e1_finance_owner;
GRANT SELECT, INSERT ON abos.ledger_account_review_decisions TO abos_e1_finance_owner;
-- Any package's owner may register a reference (it can only freeze an account, never free one).
GRANT SELECT, INSERT ON abos.ledger_account_references TO abos_e1_finance_owner, abos_e1_treasury_owner;

ALTER FUNCTION abos.finance_ledger_accounts_view(text) OWNER TO abos_e1_finance_owner;
ALTER FUNCTION abos.finance_ledger_account_check(text, jsonb, uuid) OWNER TO abos_e1_finance_owner;
ALTER FUNCTION abos.finance_ledger_account_create(text, jsonb, boolean) OWNER TO abos_e1_finance_owner;
ALTER FUNCTION abos.finance_ledger_account_update(text, uuid, integer, jsonb, boolean) OWNER TO abos_e1_finance_owner;
ALTER FUNCTION abos.finance_ledger_account_set_status(text, uuid, integer, text, text) OWNER TO abos_e1_finance_owner;
ALTER FUNCTION abos.finance_ledger_account_review(text, uuid, integer, text, text) OWNER TO abos_e1_finance_owner;

REVOKE ALL ON FUNCTION abos.finance_ledger_accounts_view(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION abos.finance_ledger_account_check(text, jsonb, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION abos.finance_ledger_account_create(text, jsonb, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION abos.finance_ledger_account_update(text, uuid, integer, jsonb, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION abos.finance_ledger_account_set_status(text, uuid, integer, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION abos.finance_ledger_account_review(text, uuid, integer, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION abos.finance_ledger_accounts_view(text) TO abos_e1_runtime;
GRANT EXECUTE ON FUNCTION abos.finance_ledger_account_check(text, jsonb, uuid) TO abos_e1_runtime;
GRANT EXECUTE ON FUNCTION abos.finance_ledger_account_create(text, jsonb, boolean) TO abos_e1_runtime;
GRANT EXECUTE ON FUNCTION abos.finance_ledger_account_update(text, uuid, integer, jsonb, boolean) TO abos_e1_runtime;
GRANT EXECUTE ON FUNCTION abos.finance_ledger_account_set_status(text, uuid, integer, text, text) TO abos_e1_runtime;
GRANT EXECUTE ON FUNCTION abos.finance_ledger_account_review(text, uuid, integer, text, text) TO abos_e1_runtime;

-- Internal helpers: the Finance owner only (its entry points and the triggers they fire call them).
REVOKE ALL ON FUNCTION abos.coa_normalize_name(text), abos.coa_normalize_code(text), abos.coa_name_similarity(text, text),
  abos.ledger_account_usage(uuid), abos.coa_text(jsonb, text), abos.coa_bool(jsonb, text), abos.coa_assert_keys(jsonb),
  abos.coa_validate(text, text, text, text, text, text, text, boolean, text),
  abos.coa_assert_single_capital(uuid, uuid, text, text, boolean, text),
  abos.coa_duplicate_warnings(uuid, uuid, text, text, text, text, text, text), abos.coa_account_json(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION abos.coa_normalize_name(text), abos.coa_normalize_code(text), abos.coa_name_similarity(text, text),
  abos.ledger_account_usage(uuid), abos.coa_text(jsonb, text), abos.coa_bool(jsonb, text), abos.coa_assert_keys(jsonb),
  abos.coa_validate(text, text, text, text, text, text, text, boolean, text),
  abos.coa_assert_single_capital(uuid, uuid, text, text, boolean, text),
  abos.coa_duplicate_warnings(uuid, uuid, text, text, text, text, text, text), abos.coa_account_json(uuid, uuid)
  TO abos_e1_finance_owner;
