-- E1 synthetic sandbox: durable commitment serialization across PostgreSQL isolation levels.
--
-- Migration 0002 locks the agreement and then sums receipt intents. A row lock alone does not
-- change the agreement tuple: under REPEATABLE READ, a transaction that took its snapshot before
-- waiting for that lock can still sum the old intent set. This migration gives every agreement a
-- usage row that is actually updated on each consuming/releasing transition. PostgreSQL then
-- raises 40001 for a stale REPEATABLE READ / SERIALIZABLE writer; READ COMMITTED rechecks the
-- current usage after waiting for the row. All amounts remain exact PostgreSQL numeric values.

LOCK TABLE abos.capital_agreements, abos.capital_receipt_intents
  IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE abos.capital_agreement_commitment_usage (
  capital_agreement_id uuid PRIMARY KEY,
  legal_entity_id uuid NOT NULL,
  consumed_amount numeric NOT NULL DEFAULT 0 CHECK (consumed_amount >= 0),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  FOREIGN KEY (capital_agreement_id, legal_entity_id)
    REFERENCES abos.capital_agreements(id, legal_entity_id)
);

INSERT INTO abos.capital_agreement_commitment_usage
  (capital_agreement_id, legal_entity_id, consumed_amount)
SELECT ca.id, ca.legal_entity_id,
       coalesce(sum(cri.amount) FILTER (WHERE cri.status <> 'REJECTED'), 0)
  FROM abos.capital_agreements ca
  LEFT JOIN abos.capital_receipt_intents cri
    ON cri.capital_agreement_id = ca.id AND cri.legal_entity_id = ca.legal_entity_id
 GROUP BY ca.id, ca.legal_entity_id;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM abos.capital_agreement_commitment_usage usage
      JOIN abos.capital_agreements agreement
        ON agreement.id = usage.capital_agreement_id
     WHERE usage.consumed_amount > agreement.committed_amount
  ) THEN
    RAISE EXCEPTION 'existing capital receipt intents exceed an agreement commitment';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION abos.initialize_capital_commitment_usage()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO abos.capital_agreement_commitment_usage
    (capital_agreement_id, legal_entity_id, consumed_amount)
  VALUES (NEW.id, NEW.legal_entity_id, 0);
  RETURN NEW;
END;
$$;
CREATE TRIGGER capital_agreements_initialize_commitment_usage
AFTER INSERT ON abos.capital_agreements
FOR EACH ROW EXECUTE FUNCTION abos.initialize_capital_commitment_usage();

-- Lowering a commitment must not strand already consumed amounts above the new ceiling.
-- Lock order is agreement then usage, matching the receipt-intent trigger below.
CREATE OR REPLACE FUNCTION abos.guard_capital_commitment_reduction()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE used numeric;
BEGIN
  SELECT consumed_amount INTO used
    FROM abos.capital_agreement_commitment_usage
   WHERE capital_agreement_id = NEW.id AND legal_entity_id = NEW.legal_entity_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'capital agreement has no commitment usage row';
  END IF;
  IF used > NEW.committed_amount THEN
    RAISE EXCEPTION 'capital agreement commitment cannot be reduced below consumed amount'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER capital_agreements_commitment_reduction_guard
BEFORE UPDATE OF committed_amount ON abos.capital_agreements
FOR EACH ROW EXECUTE FUNCTION abos.guard_capital_commitment_reduction();

-- Keep the existing 0002 trigger and its validation contract; replace its implementation so
-- amount accounting changes a real tuple. The UPDATE's WHERE predicate is evaluated against the
-- newest committed usage in READ COMMITTED. In stricter isolation PostgreSQL aborts the stale
-- updater with 40001, which must be retried as a whole transaction by the caller.
CREATE OR REPLACE FUNCTION abos.enforce_capital_commitment_ceiling()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  agreement_row abos.capital_agreements%ROWTYPE;
  installment_expected numeric;
  funding_policy abos.capital_agreement_funding_policies%ROWTYPE;
  prior_consumption numeric := 0;
  next_consumption numeric := 0;
  consumption_delta numeric;
BEGIN
  SELECT * INTO agreement_row
    FROM abos.capital_agreements
   WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.capital_agreement_id ELSE NEW.capital_agreement_id END
     AND legal_entity_id = CASE WHEN TG_OP = 'DELETE' THEN OLD.legal_entity_id ELSE NEW.legal_entity_id END
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'capital receipt intent references an unknown capital agreement';
  END IF;

  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.status <> 'REJECTED' THEN
    prior_consumption := OLD.amount;
  END IF;

  IF TG_OP <> 'DELETE' THEN
    IF agreement_row.agreement_kind <> 'CAPITAL_CONTRIBUTION' THEN
      RAISE EXCEPTION 'a shareholder loan agreement cannot fund a capital contribution';
    END IF;
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
    IF NEW.status <> 'REJECTED' THEN
      next_consumption := NEW.amount;
    END IF;
  END IF;

  consumption_delta := next_consumption - prior_consumption;
  IF consumption_delta <> 0 THEN
    UPDATE abos.capital_agreement_commitment_usage usage
       SET consumed_amount = usage.consumed_amount + consumption_delta,
           revision = usage.revision + 1
     WHERE usage.capital_agreement_id = agreement_row.id
       AND usage.legal_entity_id = agreement_row.legal_entity_id
       AND usage.consumed_amount + consumption_delta BETWEEN 0 AND agreement_row.committed_amount;
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'capital contributions would exceed the committed amount or usage is missing: committed %, requested delta %',
        agreement_row.committed_amount, consumption_delta
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER capital_receipt_intents_commitment_delete_guard
BEFORE DELETE ON abos.capital_receipt_intents
FOR EACH ROW EXECUTE FUNCTION abos.enforce_capital_commitment_ceiling();
