-- E1 synthetic USD capital receipt: bind the Treasury evidence to its source and
-- advance the shareholder projection in the same transaction as the GL posting.

CREATE OR REPLACE FUNCTION abos.complete_posted_capital_source()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  posting abos.posting_intents%ROWTYPE;
  source_record abos.capital_receipt_intents%ROWTYPE;
  receipt abos.cash_receipts%ROWTYPE;
  installment_agreement_id uuid;
  agreement_party_id uuid;
BEGIN
  SELECT * INTO posting FROM abos.posting_intents WHERE id = NEW.posting_intent_id;
  IF posting.intent_kind <> 'SHAREHOLDER_CAPITAL_RECEIPT' THEN
    RETURN NEW;
  END IF;

  SELECT * INTO source_record
    FROM abos.capital_receipt_intents
   WHERE id = posting.capital_receipt_intent_id
     AND legal_entity_id = NEW.legal_entity_id
   FOR UPDATE;
  SELECT * INTO receipt
    FROM abos.cash_receipts
   WHERE id = posting.treasury_cash_receipt_id
     AND legal_entity_id = NEW.legal_entity_id
   FOR SHARE;
  SELECT ci.capital_agreement_id, sp.business_party_id
    INTO installment_agreement_id, agreement_party_id
    FROM abos.capital_installments ci
    JOIN abos.capital_agreements ca
      ON ca.id = ci.capital_agreement_id AND ca.legal_entity_id = ci.legal_entity_id
    JOIN abos.shareholder_profiles sp
      ON sp.id = ca.shareholder_profile_id AND sp.legal_entity_id = ca.legal_entity_id
   WHERE ci.id = source_record.capital_installment_id
     AND ci.legal_entity_id = NEW.legal_entity_id;

  IF source_record.id IS NULL OR receipt.id IS NULL
     OR source_record.status <> 'TREASURY_VERIFIED'
     OR receipt.status <> 'VERIFIED'
     OR posting.source_id <> source_record.id
     OR source_record.treasury_cash_receipt_id <> receipt.id
     OR receipt.capital_installment_id IS DISTINCT FROM source_record.capital_installment_id
     OR installment_agreement_id IS DISTINCT FROM source_record.capital_agreement_id
     OR agreement_party_id IS DISTINCT FROM source_record.shareholder_business_party_id
     OR receipt.cash_location_currency_account_id <> source_record.destination_cash_account_id
     OR receipt.amount <> source_record.amount
     OR receipt.currency_code <> source_record.currency_code THEN
    RAISE EXCEPTION 'posted capital journal source, shareholder, installment and Treasury receipt must agree';
  END IF;

  UPDATE abos.capital_receipt_intents
     SET status = 'POSTED', contribution_state = 'POSTED', journal_id = NEW.id,
         version = version + 1, updated_at = clock_timestamp()
   WHERE id = source_record.id AND status = 'TREASURY_VERIFIED'
   RETURNING * INTO source_record;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'capital source state changed before journal posting completed';
  END IF;

  INSERT INTO abos.capital_receipt_intent_history
    (id, capital_receipt_intent_id, legal_entity_id, version, status,
     contribution_state, classification, amount, currency_code,
     treasury_cash_receipt_id, journal_id)
  VALUES
    (gen_random_uuid(), source_record.id, source_record.legal_entity_id,
     source_record.version, 'POSTED', 'POSTED', source_record.classification,
     source_record.amount, source_record.currency_code,
     receipt.id, NEW.id);
  RETURN NEW;
END;
$$;

CREATE TRIGGER journals_complete_capital_source
AFTER UPDATE OF status ON abos.journals
FOR EACH ROW WHEN (NEW.status = 'POSTED' AND OLD.status <> 'POSTED')
EXECUTE FUNCTION abos.complete_posted_capital_source();
