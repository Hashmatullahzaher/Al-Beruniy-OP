-- Owner-authorized single-action capital receipts. Additive, zero business-data backfill.
-- Declarations stay non-financial. This disjoint lane never fabricates custody, approval,
-- agreement, evidence or legacy mapping records. Existing E1/0036-0039 commands remain protected.

ALTER TABLE abos.shareholder_profiles
 ADD COLUMN ownership_percentage numeric CHECK(ownership_percentage BETWEEN 0 AND 100),
 ADD COLUMN capital_note text CHECK(length(capital_note)<=1000);

CREATE TABLE abos.direct_capital_receipts (
 id uuid PRIMARY KEY,
 legal_entity_id uuid NOT NULL REFERENCES abos.legal_entities(id),
 shareholder_profile_id uuid NOT NULL,
 operational_treasury_account_id uuid NOT NULL,
 paid_in_capital_ledger_account_id uuid NOT NULL,
 original_amount numeric NOT NULL CHECK(original_amount>0 AND original_amount<'Infinity'::numeric),
 original_currency_code text NOT NULL REFERENCES abos.currencies(code),
 receipt_date date NOT NULL,
 payment_reference text CHECK(length(payment_reference)<=120),
 note text CHECK(length(note)<=1000),
 transaction_reference text NOT NULL,
 workflow_policy_version_id uuid NOT NULL,
 journal_id uuid NOT NULL,
 created_by_user_account_id uuid NOT NULL REFERENCES abos.user_accounts(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 correlation_id uuid NOT NULL,
 idempotency_key text NOT NULL CHECK(length(btrim(idempotency_key)) BETWEEN 8 AND 200),
 UNIQUE(id,legal_entity_id),
 UNIQUE(legal_entity_id,idempotency_key),
 UNIQUE(legal_entity_id,transaction_reference),
 UNIQUE(journal_id,legal_entity_id),
 FOREIGN KEY(shareholder_profile_id,legal_entity_id) REFERENCES abos.shareholder_profiles(id,legal_entity_id),
 FOREIGN KEY(operational_treasury_account_id,legal_entity_id,original_currency_code)
   REFERENCES abos.operational_treasury_accounts(id,legal_entity_id,currency_code),
 FOREIGN KEY(paid_in_capital_ledger_account_id,legal_entity_id) REFERENCES abos.ledger_accounts(id,legal_entity_id),
 FOREIGN KEY(workflow_policy_version_id,legal_entity_id) REFERENCES abos.finance_workflow_policy_versions(id,legal_entity_id),
 FOREIGN KEY(journal_id,legal_entity_id) REFERENCES abos.journals(id,legal_entity_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX direct_capital_receipts_shareholder_idx ON abos.direct_capital_receipts(legal_entity_id,shareholder_profile_id,receipt_date);
CREATE TABLE abos.direct_capital_receipt_allocations (
 receipt_id uuid NOT NULL,
 legal_entity_id uuid NOT NULL,
 contribution_id uuid NOT NULL,
 amount numeric NOT NULL CHECK(amount>0 AND amount<'Infinity'::numeric),
 PRIMARY KEY(receipt_id,contribution_id),
 FOREIGN KEY(receipt_id,legal_entity_id) REFERENCES abos.direct_capital_receipts(id,legal_entity_id),
 FOREIGN KEY(contribution_id,legal_entity_id) REFERENCES abos.shareholder_contributions(id,legal_entity_id)
);
CREATE INDEX direct_capital_allocations_contribution_idx ON abos.direct_capital_receipt_allocations(legal_entity_id,contribution_id);
CREATE TRIGGER direct_capital_receipts_immutable BEFORE UPDATE OR DELETE ON abos.direct_capital_receipts
 FOR EACH ROW EXECUTE FUNCTION abos.prevent_audit_mutation();
CREATE TRIGGER direct_capital_allocations_immutable BEFORE UPDATE OR DELETE ON abos.direct_capital_receipt_allocations
 FOR EACH ROW EXECUTE FUNCTION abos.prevent_audit_mutation();

ALTER TABLE abos.posting_intents ADD COLUMN direct_capital_receipt_id uuid,
 ADD CONSTRAINT posting_intents_direct_capital_fk FOREIGN KEY(direct_capital_receipt_id,legal_entity_id)
  REFERENCES abos.direct_capital_receipts(id,legal_entity_id),
 DROP CONSTRAINT posting_intents_intent_kind_check,
 ADD CONSTRAINT posting_intents_intent_kind_check CHECK(intent_kind IN(
  'SHAREHOLDER_CAPITAL_RECEIPT','SHAREHOLDER_LOAN_RECEIPT','REVERSAL','EXPENSE',
  'TEMPORARY_FUNDING','TEMPORARY_FUNDING_SETTLEMENT','DIRECT_SHAREHOLDER_CAPITAL')),
 ADD CONSTRAINT posting_intents_direct_capital_shape CHECK(
  (intent_kind='DIRECT_SHAREHOLDER_CAPITAL' AND source_type='DIRECT_SHAREHOLDER_CAPITAL'
   AND processing_model='OPERATIONAL_V1' AND direct_capital_receipt_id IS NOT NULL
   AND source_id=direct_capital_receipt_id AND finance_workflow_policy_version_id IS NOT NULL
   AND operational_version IS NOT NULL AND capital_receipt_intent_id IS NULL
   AND shareholder_capital_receipt_id IS NULL AND shareholder_capital_account_mapping_version_id IS NULL
   AND operational_expense_id IS NULL AND treasury_cash_receipt_id IS NULL
   AND temporary_funding_id IS NULL AND temporary_funding_settlement_id IS NULL
   AND temporary_funding_mapping_version_id IS NULL AND conversion_snapshot_reference IS NULL
   AND project_id IS NULL AND department_id IS NULL AND cost_center_id IS NULL
   AND original_currency_code=base_currency_code AND original_amount=base_amount)
  OR(intent_kind<>'DIRECT_SHAREHOLDER_CAPITAL' AND source_type<>'DIRECT_SHAREHOLDER_CAPITAL'
   AND direct_capital_receipt_id IS NULL));
CREATE UNIQUE INDEX posting_intents_direct_capital_once ON abos.posting_intents(legal_entity_id,direct_capital_receipt_id)
 WHERE direct_capital_receipt_id IS NOT NULL;
ALTER TABLE abos.subledger_entries ADD COLUMN direct_capital_receipt_id uuid,
 ADD CONSTRAINT subledger_direct_capital_fk FOREIGN KEY(direct_capital_receipt_id,legal_entity_id)
  REFERENCES abos.direct_capital_receipts(id,legal_entity_id),
 ADD CONSTRAINT subledger_direct_capital_shape CHECK(
  (source_type='DIRECT_SHAREHOLDER_CAPITAL' AND direct_capital_receipt_id IS NOT NULL
   AND source_id=direct_capital_receipt_id AND processing_model='OPERATIONAL_V1'
   AND subledger_type IN('OPERATIONAL_TREASURY','SHAREHOLDER_CAPITAL')
   AND shareholder_capital_receipt_id IS NULL
   AND temporary_funding_id IS NULL AND temporary_funding_settlement_id IS NULL)
  OR(source_type<>'DIRECT_SHAREHOLDER_CAPITAL' AND direct_capital_receipt_id IS NULL));

REVOKE ALL ON abos.direct_capital_receipts,abos.direct_capital_receipt_allocations FROM PUBLIC;
GRANT SELECT ON abos.direct_capital_receipts,abos.direct_capital_receipt_allocations TO abos_v1_operational_finance_owner;
GRANT INSERT(id,legal_entity_id,shareholder_profile_id,operational_treasury_account_id,paid_in_capital_ledger_account_id,
 original_amount,original_currency_code,receipt_date,payment_reference,note,transaction_reference,
 workflow_policy_version_id,journal_id,created_by_user_account_id,correlation_id,idempotency_key)
 ON abos.direct_capital_receipts TO abos_v1_operational_finance_owner;
GRANT INSERT(receipt_id,legal_entity_id,contribution_id,amount) ON abos.direct_capital_receipt_allocations
 TO abos_v1_operational_finance_owner;
GRANT SELECT(shareholder_profile_id,legal_entity_id) ON abos.direct_capital_receipts
 TO abos_v1_shareholder_setup_owner;
GRANT SELECT(legal_entity_id,contribution_id,amount) ON abos.direct_capital_receipt_allocations
 TO abos_v1_shareholder_capital_owner;
GRANT SELECT(ownership_percentage,capital_note) ON abos.shareholder_profiles TO abos_v1_operational_finance_owner;
GRANT SELECT(ownership_percentage,capital_note),UPDATE(ownership_percentage,capital_note)
 ON abos.shareholder_profiles TO abos_v1_shareholder_setup_owner;
GRANT INSERT(direct_capital_receipt_id) ON abos.posting_intents,abos.subledger_entries TO abos_v1_operational_finance_owner;
GRANT EXECUTE ON FUNCTION abos.shareholder_contribution_finance_lock(uuid,uuid,integer) TO abos_v1_operational_finance_owner;

CREATE FUNCTION abos.direct_capital_actor(p_proof text,p_runtime text,p_token text,p_write boolean)
RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE c jsonb; permissions jsonb;
BEGIN
 c:=abos.operational_finance_actor(p_proof,p_runtime,p_token,NULL);
 permissions:=COALESCE(c->'permissions','[]'::jsonb);
 IF c->>'sessionProvenance' IS DISTINCT FROM 'PASSWORD_OPERATIONAL' THEN
  RAISE EXCEPTION 'an operational password session is required' USING ERRCODE='insufficient_privilege';
 END IF;
 IF p_write AND NOT(permissions ?& ARRAY['shareholder.capital-receipt.record','finance.capital-receipt.prepare','finance.capital-receipt.post'])
  OR NOT p_write AND NOT(permissions ?| ARRAY['shareholder.setup.manage','shareholder.capital-receipt.read']) THEN
  RAISE EXCEPTION 'current capital authority is missing' USING ERRCODE='insufficient_privilege';
 END IF;
 RETURN c;
END $$;

-- Resolve an existing typed account, never invent a ledger code or create a fictitious mapping.
CREATE FUNCTION abos.direct_capital_equity(p_entity uuid,p_currency text) RETURNS uuid
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE ids uuid[];
BEGIN
 SELECT array_agg(a.id ORDER BY a.id) INTO ids FROM abos.ledger_accounts a
 LEFT JOIN abos.ledger_account_governance g ON g.ledger_account_id=a.id AND g.legal_entity_id=a.legal_entity_id
 WHERE a.legal_entity_id=p_entity AND a.status='ACTIVE' AND a.posting_allowed
  AND a.account_type='EQUITY' AND a.control_account_type='SHAREHOLDER_CAPITAL'
  AND (a.account_currency_code IS NULL OR a.account_currency_code=p_currency)
  AND NOT a.requires_project AND NOT a.requires_department AND NOT a.requires_cost_center
  AND(g.ledger_account_id IS NULL OR g.review_state IN('REVIEWED','NOT_REQUIRED'));
 IF cardinality(ids) IS DISTINCT FROM 1 THEN
  RAISE EXCEPTION 'choose one active shareholder capital equity account in Finance setup' USING ERRCODE='check_violation';
 END IF;
 RETURN ids[1];
END $$;

CREATE FUNCTION abos.direct_shareholder_create(p_proof text,p_runtime text,p_token text,p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE c jsonb; actor uuid; entity uuid; scope text; key text; correlation uuid; replay jsonb;
 profile jsonb; contribution jsonb; result jsonb; percent numeric; business_date date;
BEGIN
 c:=abos.shareholder_setup_actor(p_proof,p_runtime,p_token,ARRAY['shareholder.setup.manage']);
 IF c->>'sessionProvenance' IS DISTINCT FROM 'PASSWORD_OPERATIONAL' THEN
  RAISE EXCEPTION 'an operational password session is required' USING ERRCODE='insufficient_privilege'; END IF;
 actor:=(c->>'userAccountId')::uuid; entity:=(c->>'legalEntityId')::uuid;
 IF p_payload IS NULL OR jsonb_typeof(p_payload)<>'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_payload) k
  WHERE k NOT IN('displayName','totalCapital','currencyCode','ownershipPercent','externalReference','note','businessDate','idempotencyKey','correlationId')) THEN
  RAISE EXCEPTION 'unknown shareholder fields' USING ERRCODE='invalid_parameter_value'; END IF;
 key:=p_payload->>'idempotencyKey'; correlation:=(p_payload->>'correlationId')::uuid;
 business_date:=(p_payload->>'businessDate')::date;
 percent:=NULLIF(p_payload->>'ownershipPercent','')::numeric;
 IF percent IS NOT NULL AND (percent<0 OR percent>100 OR percent='NaN'::numeric) OR length(p_payload->>'note')>1000 THEN
  RAISE EXCEPTION 'invalid ownership percentage or note' USING ERRCODE='invalid_parameter_value'; END IF;
 scope:=entity::text||':DIRECT_SHAREHOLDER_CREATE';
 replay:=abos.shareholder_setup_idempotency_begin(scope,key,
  encode(sha256(convert_to((p_payload-'correlationId')::text||actor::text,'UTF8')),'hex'),correlation);
 IF replay IS NOT NULL THEN RETURN replay; END IF;
 profile:=abos.shareholder_setup_create_shareholder(p_proof,p_runtime,p_token,jsonb_build_object(
  'displayName',p_payload->>'displayName','externalReference',p_payload->>'externalReference',
  'shareholderSince',business_date,'idempotencyKey','DSP:'||key,'correlationId',correlation));
 contribution:=abos.shareholder_contribution_create(p_proof,p_runtime,p_token,jsonb_build_object(
  'shareholderProfileId',profile->>'shareholderProfileId','contributionType','CASH',
  'businessDate',business_date,'amount',p_payload->>'totalCapital','currencyCode',p_payload->>'currencyCode',
  'description',p_payload->>'note','reference',p_payload->>'externalReference','declare',true,
  'idempotencyKey','DSC:'||key,'correlationId',correlation));
 UPDATE abos.shareholder_profiles SET ownership_percentage=percent,capital_note=NULLIF(btrim(p_payload->>'note'),'')
 WHERE id=(profile->>'shareholderProfileId')::uuid AND legal_entity_id=entity;
 result:=profile||jsonb_build_object('contributionId',contribution->>'contributionId');
 PERFORM abos.shareholder_setup_idempotency_complete(scope,key,'SHAREHOLDER_PROFILE',(profile->>'shareholderProfileId')::uuid,result);
 RETURN result;
END $$;
ALTER FUNCTION abos.direct_shareholder_create(text,text,text,jsonb) OWNER TO abos_v1_shareholder_setup_owner;

CREATE FUNCTION abos.direct_shareholder_receive(p_proof text,p_runtime text,p_token text,p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE c jsonb; actor uuid; entity uuid; profile uuid; destination uuid; equity uuid; currency text;
 amount numeric; day date; period uuid; policy uuid; treasury_ledger uuid; base text;
 key text; correlation uuid; scope text; replay jsonb; fingerprint text; receipt uuid:=gen_random_uuid();
 journal uuid:=gen_random_uuid(); intent uuid:=gen_random_uuid(); debit_line uuid:=gen_random_uuid(); credit_line uuid:=gen_random_uuid();
 source abos.shareholder_contributions%ROWTYPE; allocated numeric; remaining numeric; piece numeric; party uuid; result jsonb; ref text;
 locked_sources uuid[]:=ARRAY[]::uuid[];
BEGIN
 c:=abos.direct_capital_actor(p_proof,p_runtime,p_token,true);
 actor:=(c->>'userAccountId')::uuid; entity:=(c->>'legalEntityId')::uuid;
 IF p_payload IS NULL OR jsonb_typeof(p_payload)<>'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_payload) k
  WHERE k NOT IN('shareholderProfileId','amount','currencyCode','receiptDate','destinationAccountId','paymentReference','note','idempotencyKey','correlationId')) THEN
  RAISE EXCEPTION 'unknown capital receipt fields' USING ERRCODE='invalid_parameter_value'; END IF;
 profile:=(p_payload->>'shareholderProfileId')::uuid; destination:=(p_payload->>'destinationAccountId')::uuid;
 currency:=p_payload->>'currencyCode'; day:=(p_payload->>'receiptDate')::date;
 amount:=abos.temporary_funding_amount(p_payload->>'amount');
 key:=NULLIF(btrim(p_payload->>'idempotencyKey'),''); correlation:=(p_payload->>'correlationId')::uuid;
 IF profile IS NULL OR destination IS NULL OR day IS NULL OR day>current_date
  OR length(p_payload->>'paymentReference')>120 OR length(p_payload->>'note')>1000 THEN
  RAISE EXCEPTION 'a valid shareholder, date, Safe and reference are required' USING ERRCODE='invalid_parameter_value'; END IF;
 -- Authorization precedes durable replay; changed/expired permissions cannot replay sensitive results.
 scope:='direct-capital:receive:'||entity::text||':'||actor::text;
 fingerprint:=encode(sha256(convert_to((p_payload-'correlationId')::text||actor::text,'UTF8')),'hex');
 replay:=abos.temporary_funding_idempotency_begin(scope,key,fingerprint,correlation);
 IF replay IS NOT NULL THEN RETURN replay; END IF;
 SELECT business_party_id INTO party FROM abos.shareholder_profiles
 WHERE id=profile AND legal_entity_id=entity AND status='ACTIVE';
 IF party IS NULL OR NOT EXISTS(SELECT 1 FROM abos.business_parties WHERE id=party AND legal_entity_id=entity AND status='ACTIVE') THEN
  RAISE EXCEPTION 'shareholder not found in this legal entity' USING ERRCODE='no_data_found'; END IF;
 SELECT base_currency_code INTO base FROM abos.legal_entities WHERE id=entity AND currency_policy_status='APPROVED';
 IF base IS NULL OR currency IS DISTINCT FROM base OR NOT EXISTS(SELECT 1 FROM abos.currencies WHERE code=currency AND enabled) THEN
  RAISE EXCEPTION 'capital receipt currency must match the approved accounting currency' USING ERRCODE='check_violation'; END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('abos-finance-workflow-policy:'||entity::text||':SHAREHOLDER_CAPITAL_RECEIPT',0));
 SELECT id INTO policy FROM abos.finance_workflow_policy_versions
 WHERE legal_entity_id=entity AND workflow_type='SHAREHOLDER_CAPITAL_RECEIPT' ORDER BY version DESC LIMIT 1;
 IF policy IS NULL OR (SELECT approval_required FROM abos.finance_workflow_policy_versions WHERE id=policy) THEN
  RAISE EXCEPTION 'a direct capital receipt requires the company approval setting OFF' USING ERRCODE='check_violation'; END IF;
 treasury_ledger:=abos.temporary_funding_treasury_ledger(entity,destination,currency,true);
 IF EXISTS(SELECT 1 FROM abos.ledger_accounts WHERE id=treasury_ledger
  AND account_currency_code IS NOT NULL AND account_currency_code<>currency) THEN
  RAISE EXCEPTION 'Safe ledger currency does not match receipt currency' USING ERRCODE='check_violation'; END IF;
 equity:=abos.direct_capital_equity(entity,currency);
 period:=abos.temporary_funding_open_period(entity,day);
 -- Exactly the same row locks as the legacy receipt command. Lock all eligible declarations in
 -- stable UUID order before allocating, so two direct saves and direct/legacy races serialize.
 FOR source IN SELECT * FROM abos.shareholder_contributions WHERE shareholder_profile_id=profile
  AND legal_entity_id=entity AND contribution_type='CASH' AND record_status='DECLARED'
  AND currency_code=currency ORDER BY id LOOP
  PERFORM abos.shareholder_contribution_finance_lock(entity,source.id,source.version);
  locked_sources:=array_append(locked_sources,source.id);
 END LOOP;
 remaining:=amount; ref:='CAP-'||to_char(day,'YYYYMMDD')||'-'||upper(replace(receipt::text,'-',''));
 INSERT INTO abos.direct_capital_receipts(id,legal_entity_id,shareholder_profile_id,operational_treasury_account_id,
  paid_in_capital_ledger_account_id,original_amount,original_currency_code,receipt_date,payment_reference,note,
  transaction_reference,workflow_policy_version_id,journal_id,created_by_user_account_id,correlation_id,idempotency_key)
 VALUES(receipt,entity,profile,destination,equity,amount,currency,day,NULLIF(btrim(p_payload->>'paymentReference'),''),
  NULLIF(btrim(p_payload->>'note'),''),ref,policy,journal,actor,correlation,key);
 FOR source IN SELECT * FROM abos.shareholder_contributions WHERE shareholder_profile_id=profile
  AND legal_entity_id=entity AND contribution_type='CASH' AND record_status='DECLARED'
  AND currency_code=currency AND business_date<=day AND id=ANY(locked_sources) ORDER BY business_date,id LOOP
  SELECT COALESCE((SELECT sum(original_amount) FROM abos.shareholder_capital_receipts
   WHERE legal_entity_id=entity AND contribution_id=source.id AND record_state='RECORDED'),0)
   +COALESCE((SELECT sum(a.amount) FROM abos.direct_capital_receipt_allocations a
    WHERE a.legal_entity_id=entity AND a.contribution_id=source.id),0) INTO allocated;
  piece:=least(remaining,greatest(source.amount-allocated,0));
  IF piece>0 THEN INSERT INTO abos.direct_capital_receipt_allocations(receipt_id,legal_entity_id,contribution_id,amount)
   VALUES(receipt,entity,source.id,piece); remaining:=remaining-piece; END IF;
  EXIT WHEN remaining=0;
 END LOOP;
 IF remaining<>0 THEN RAISE EXCEPTION 'receipt exceeds available outstanding capital for this date and currency'
  USING ERRCODE='check_violation'; END IF;
 INSERT INTO abos.posting_intents(id,legal_entity_id,source_type,source_id,intent_kind,original_amount,original_currency_code,
  base_amount,base_currency_code,accounting_effective_date,correlation_id,idempotency_key,status,created_by_user_account_id,
  processing_model,direct_capital_receipt_id,finance_workflow_policy_version_id,operational_version)
 VALUES(intent,entity,'DIRECT_SHAREHOLDER_CAPITAL',receipt,'DIRECT_SHAREHOLDER_CAPITAL',amount,currency,amount,currency,
  day,correlation,'DC:'||receipt::text,'VALIDATED',actor,'OPERATIONAL_V1',receipt,policy,1);
 INSERT INTO abos.journals(id,legal_entity_id,accounting_period_id,posting_intent_id,journal_reference,accounting_effective_date,
  base_currency_code,status,created_by_user_account_id,processing_model)
 VALUES(journal,entity,period,intent,ref,day,currency,'DRAFT',actor,'OPERATIONAL_V1');
 INSERT INTO abos.journal_lines(id,journal_id,legal_entity_id,line_number,ledger_account_id,business_party_id,
  original_amount,original_currency_code,base_debit,base_credit,base_currency_code,source_type,source_id,processing_model)
 VALUES(debit_line,journal,entity,1,treasury_ledger,NULL,amount,currency,amount,0,currency,'DIRECT_SHAREHOLDER_CAPITAL',receipt,'OPERATIONAL_V1'),
  (credit_line,journal,entity,2,equity,party,amount,currency,0,amount,currency,'DIRECT_SHAREHOLDER_CAPITAL',receipt,'OPERATIONAL_V1');
 INSERT INTO abos.subledger_entries(id,legal_entity_id,journal_line_id,subledger_type,operational_treasury_account_id,
  business_party_id,original_amount,original_currency_code,base_amount,base_currency_code,source_type,source_id,
  processing_model,direct_capital_receipt_id)
 VALUES(gen_random_uuid(),entity,debit_line,'OPERATIONAL_TREASURY',destination,NULL,amount,currency,amount,currency,
   'DIRECT_SHAREHOLDER_CAPITAL',receipt,'OPERATIONAL_V1',receipt),
  (gen_random_uuid(),entity,credit_line,'SHAREHOLDER_CAPITAL',NULL,party,-amount,currency,-amount,currency,
   'DIRECT_SHAREHOLDER_CAPITAL',receipt,'OPERATIONAL_V1',receipt);
 UPDATE abos.posting_intents SET status='POSTED',operational_version=2 WHERE id=intent;
 UPDATE abos.journals SET status='POSTED',posted_by_user_account_id=actor,posted_at=clock_timestamp() WHERE id=journal;
 result:=jsonb_build_object('receiptId',receipt,'journalId',journal,'reference',ref,'status','POSTED','replayed',false);
 PERFORM abos.temporary_funding_audit(actor,entity,correlation,'SHAREHOLDER_CAPITAL_RECEIVED','DIRECT_CAPITAL_RECEIPT',receipt,
  result||jsonb_build_object('shareholderProfileId',profile,'amount',amount::text,'currency',currency,
    'treasuryAccountId',destination,'equityAccountId',equity,'approvalOccurred',false));
 PERFORM abos.temporary_funding_idempotency_complete(scope,key,'DIRECT_CAPITAL_RECEIPT',receipt,result);
 RETURN result;
END $$;
ALTER FUNCTION abos.direct_shareholder_receive(text,text,text,jsonb) OWNER TO abos_v1_operational_finance_owner;

CREATE FUNCTION abos.validate_direct_capital_journal_posting() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE i abos.posting_intents%ROWTYPE; r abos.direct_capital_receipts%ROWTYPE;
 a abos.operational_treasury_accounts%ROWTYPE; party uuid; line_count bigint; debit numeric; credit numeric;
BEGIN
 IF NEW.status<>'POSTED' OR NEW.processing_model IS DISTINCT FROM 'OPERATIONAL_V1' THEN RETURN NEW; END IF;
 SELECT * INTO i FROM abos.posting_intents WHERE id=NEW.posting_intent_id AND legal_entity_id=NEW.legal_entity_id;
 IF i.source_type IS DISTINCT FROM 'DIRECT_SHAREHOLDER_CAPITAL' THEN RETURN NEW; END IF;
 SELECT * INTO r FROM abos.direct_capital_receipts WHERE id=i.direct_capital_receipt_id AND legal_entity_id=NEW.legal_entity_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'direct capital source missing' USING ERRCODE='check_violation'; END IF;
 SELECT * INTO a FROM abos.operational_treasury_accounts WHERE id=r.operational_treasury_account_id AND legal_entity_id=r.legal_entity_id;
 SELECT business_party_id INTO party FROM abos.shareholder_profiles WHERE id=r.shareholder_profile_id AND legal_entity_id=r.legal_entity_id AND status='ACTIVE';
 SELECT count(*),COALESCE(sum(base_debit),0),COALESCE(sum(base_credit),0) INTO line_count,debit,credit FROM abos.journal_lines WHERE journal_id=NEW.id;
 IF current_user<>'abos_v1_operational_finance_owner' OR i.processing_model<>'OPERATIONAL_V1'
  OR NEW.processing_model<>'OPERATIONAL_V1' OR i.status<>'POSTED' OR i.operational_version<>2
  OR i.intent_kind<>'DIRECT_SHAREHOLDER_CAPITAL' OR i.source_id IS DISTINCT FROM r.id
  OR r.journal_id IS DISTINCT FROM NEW.id OR NEW.journal_reference IS DISTINCT FROM r.transaction_reference
  OR i.created_by_user_account_id IS DISTINCT FROM r.created_by_user_account_id
  OR NEW.created_by_user_account_id IS DISTINCT FROM r.created_by_user_account_id
  OR NEW.posted_by_user_account_id IS DISTINCT FROM r.created_by_user_account_id OR NEW.posted_at IS NULL
  OR i.original_amount IS DISTINCT FROM r.original_amount OR i.base_amount IS DISTINCT FROM r.original_amount
  OR i.original_currency_code IS DISTINCT FROM r.original_currency_code OR i.base_currency_code IS DISTINCT FROM r.original_currency_code
  OR NEW.base_currency_code IS DISTINCT FROM r.original_currency_code
  OR NEW.accounting_effective_date IS DISTINCT FROM r.receipt_date OR i.accounting_effective_date IS DISTINCT FROM r.receipt_date
  OR i.finance_workflow_policy_version_id IS DISTINCT FROM r.workflow_policy_version_id
  OR a.id IS NULL OR party IS NULL OR line_count<>2 OR debit<>credit OR debit<>r.original_amount
  OR EXISTS(SELECT 1 FROM abos.posting_approvals WHERE posting_intent_id=i.id)
  OR NOT EXISTS(SELECT 1 FROM abos.finance_workflow_policy_versions WHERE id=r.workflow_policy_version_id
   AND legal_entity_id=r.legal_entity_id AND workflow_type='SHAREHOLDER_CAPITAL_RECEIPT' AND NOT approval_required)
  OR NOT EXISTS(SELECT 1 FROM abos.accounting_periods WHERE id=NEW.accounting_period_id AND legal_entity_id=NEW.legal_entity_id
   AND status='OPEN' AND r.receipt_date BETWEEN starts_on AND ends_on)
  OR NOT EXISTS(SELECT 1 FROM abos.legal_entities WHERE id=NEW.legal_entity_id AND currency_policy_status='APPROVED' AND base_currency_code=r.original_currency_code)
  OR abos.temporary_funding_treasury_ledger(r.legal_entity_id,a.id,r.original_currency_code,true) IS DISTINCT FROM a.ledger_account_id
  OR EXISTS(SELECT 1 FROM abos.ledger_accounts WHERE id=a.ledger_account_id
    AND account_currency_code IS NOT NULL AND account_currency_code<>r.original_currency_code)
  OR NOT EXISTS(SELECT 1 FROM abos.ledger_accounts e WHERE e.id=r.paid_in_capital_ledger_account_id AND e.legal_entity_id=r.legal_entity_id
   AND e.status='ACTIVE' AND e.posting_allowed AND e.account_type='EQUITY' AND e.control_account_type='SHAREHOLDER_CAPITAL'
   AND(e.account_currency_code IS NULL OR e.account_currency_code=r.original_currency_code)
   AND NOT e.requires_project AND NOT e.requires_department AND NOT e.requires_cost_center) THEN
  RAISE EXCEPTION 'direct capital journal does not match its source, policy, account, poster or period' USING ERRCODE='check_violation';
 END IF;
 IF EXISTS(SELECT 1 FROM abos.journal_lines l WHERE l.journal_id=NEW.id AND (
  l.legal_entity_id IS DISTINCT FROM r.legal_entity_id OR l.source_type IS DISTINCT FROM 'DIRECT_SHAREHOLDER_CAPITAL'
  OR l.source_id IS DISTINCT FROM r.id OR l.processing_model<>'OPERATIONAL_V1'
  OR l.project_id IS NOT NULL OR l.department_id IS NOT NULL OR l.cost_center_id IS NOT NULL
  OR l.original_amount IS DISTINCT FROM r.original_amount OR l.original_currency_code IS DISTINCT FROM r.original_currency_code
  OR l.base_currency_code IS DISTINCT FROM r.original_currency_code OR l.conversion_snapshot_reference IS NOT NULL
  OR NOT((l.line_number=1 AND l.ledger_account_id=a.ledger_account_id AND l.business_party_id IS NULL
   AND l.base_debit=r.original_amount AND l.base_credit=0)
   OR(l.line_number=2 AND l.ledger_account_id=r.paid_in_capital_ledger_account_id AND l.business_party_id IS NOT DISTINCT FROM party
   AND l.base_debit=0 AND l.base_credit=r.original_amount)))) THEN
  RAISE EXCEPTION 'direct capital requires exact Safe debit and shareholder equity credit' USING ERRCODE='check_violation'; END IF;
 IF (SELECT count(*) FROM abos.subledger_entries s JOIN abos.journal_lines l ON l.id=s.journal_line_id WHERE l.journal_id=NEW.id)<>2
  OR EXISTS(SELECT 1 FROM abos.subledger_entries s JOIN abos.journal_lines l ON l.id=s.journal_line_id WHERE l.journal_id=NEW.id AND(
   s.legal_entity_id IS DISTINCT FROM r.legal_entity_id OR s.direct_capital_receipt_id IS DISTINCT FROM r.id
   OR s.source_type IS DISTINCT FROM 'DIRECT_SHAREHOLDER_CAPITAL' OR s.source_id IS DISTINCT FROM r.id
   OR s.processing_model<>'OPERATIONAL_V1'
   OR s.original_amount IS DISTINCT FROM CASE WHEN l.line_number=1 THEN r.original_amount ELSE -r.original_amount END
   OR s.base_amount IS DISTINCT FROM CASE WHEN l.line_number=1 THEN r.original_amount ELSE -r.original_amount END
   OR s.original_currency_code IS DISTINCT FROM r.original_currency_code
   OR s.base_currency_code IS DISTINCT FROM r.original_currency_code
   OR NOT((l.line_number=1 AND s.subledger_type='OPERATIONAL_TREASURY' AND s.operational_treasury_account_id=a.id AND s.business_party_id IS NULL)
    OR(l.line_number=2 AND s.subledger_type='SHAREHOLDER_CAPITAL' AND s.business_party_id=party AND s.operational_treasury_account_id IS NULL)))) THEN
  RAISE EXCEPTION 'direct capital requires exact Safe and shareholder subledgers' USING ERRCODE='check_violation'; END IF;
 IF (SELECT COALESCE(sum(amount),0) FROM abos.direct_capital_receipt_allocations WHERE receipt_id=r.id)<>r.original_amount
  OR EXISTS(SELECT 1 FROM abos.direct_capital_receipt_allocations x JOIN abos.shareholder_contributions c ON c.id=x.contribution_id
   WHERE x.receipt_id=r.id AND(c.legal_entity_id IS DISTINCT FROM r.legal_entity_id OR c.shareholder_profile_id IS DISTINCT FROM r.shareholder_profile_id
    OR c.contribution_type<>'CASH' OR c.record_status<>'DECLARED' OR c.currency_code<>r.original_currency_code OR c.business_date>r.receipt_date
    OR c.amount<COALESCE((SELECT sum(amount) FROM abos.direct_capital_receipt_allocations z WHERE z.contribution_id=c.id),0)
      +COALESCE((SELECT sum(original_amount) FROM abos.shareholder_capital_receipts z WHERE z.contribution_id=c.id AND record_state='RECORDED'),0))) THEN
  RAISE EXCEPTION 'direct capital allocations exceed or mismatch declared capital' USING ERRCODE='check_violation'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER direct_capital_journal_validation BEFORE INSERT OR UPDATE ON abos.journals
 FOR EACH ROW EXECUTE FUNCTION abos.validate_direct_capital_journal_posting();

CREATE FUNCTION abos.guard_direct_capital_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE r abos.direct_capital_receipts%ROWTYPE;
BEGIN
 SELECT * INTO r FROM abos.direct_capital_receipts WHERE id=COALESCE(to_jsonb(NEW)->>'receipt_id',to_jsonb(NEW)->>'id')::uuid;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM abos.journals j JOIN abos.posting_intents i ON i.id=j.posting_intent_id
  WHERE j.id=r.journal_id AND j.legal_entity_id=r.legal_entity_id AND j.status='POSTED' AND i.status='POSTED'
   AND i.direct_capital_receipt_id=r.id AND i.source_type='DIRECT_SHAREHOLDER_CAPITAL')
  OR(SELECT COALESCE(sum(amount),0) FROM abos.direct_capital_receipt_allocations WHERE receipt_id=r.id)<>r.original_amount THEN
  RAISE EXCEPTION 'capital receipt must commit with its complete posted journal and allocations' USING ERRCODE='check_violation'; END IF;
 RETURN NULL;
END $$;
ALTER FUNCTION abos.guard_direct_capital_complete() OWNER TO abos_v1_operational_finance_owner;
CREATE CONSTRAINT TRIGGER direct_capital_complete AFTER INSERT ON abos.direct_capital_receipts
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION abos.guard_direct_capital_complete();
CREATE CONSTRAINT TRIGGER direct_capital_allocation_complete AFTER INSERT ON abos.direct_capital_receipt_allocations
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION abos.guard_direct_capital_complete();

CREATE FUNCTION abos.refuse_direct_capital_reversal() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM abos.journals j JOIN abos.posting_intents i ON i.id=j.posting_intent_id
  WHERE j.id=NEW.original_journal_id AND i.source_type='DIRECT_SHAREHOLDER_CAPITAL') THEN
  RAISE EXCEPTION 'direct capital reversals are not active' USING ERRCODE='insufficient_privilege'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER direct_capital_reversal_disabled BEFORE INSERT OR UPDATE ON abos.journal_reversal_links
 FOR EACH ROW EXECUTE FUNCTION abos.refuse_direct_capital_reversal();

-- A private attachment reuses the reviewed document vault. Its optional DRAFT holder is created
-- only when a user chooses a file; never a capital/registration/receipt prerequisite.
ALTER TABLE abos.shareholder_profiles ADD COLUMN capital_document_agreement_id uuid,
 ADD CONSTRAINT shareholder_document_holder_fk FOREIGN KEY(capital_document_agreement_id,legal_entity_id)
  REFERENCES abos.capital_agreements(id,legal_entity_id);
GRANT SELECT(capital_document_agreement_id),UPDATE(capital_document_agreement_id)
 ON abos.shareholder_profiles TO abos_v1_shareholder_setup_owner;

CREATE FUNCTION abos.direct_shareholder_document_holder(p_proof text,p_runtime text,p_token text,p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE c jsonb; entity uuid; profile uuid; holder uuid; currency text; total numeric; result jsonb;
BEGIN
 c:=abos.shareholder_setup_actor(p_proof,p_runtime,p_token,ARRAY['shareholder.setup.manage']);
 IF c->>'sessionProvenance' IS DISTINCT FROM 'PASSWORD_OPERATIONAL' THEN
  RAISE EXCEPTION 'an operational password session is required' USING ERRCODE='insufficient_privilege'; END IF;
 entity:=(c->>'legalEntityId')::uuid; profile:=(p_payload->>'shareholderProfileId')::uuid;
 PERFORM pg_advisory_xact_lock(hashtextextended('direct-capital-document:'||entity::text||':'||profile::text,0));
 SELECT capital_document_agreement_id INTO holder FROM abos.shareholder_profiles
 WHERE id=profile AND legal_entity_id=entity AND status='ACTIVE';
 IF NOT FOUND THEN RAISE EXCEPTION 'shareholder not found in this legal entity' USING ERRCODE='no_data_found'; END IF;
 IF holder IS NOT NULL THEN RETURN jsonb_build_object('capitalAgreementId',holder); END IF;
 SELECT currency_code,sum(amount) INTO currency,total FROM abos.shareholder_contributions
 WHERE shareholder_profile_id=profile AND legal_entity_id=entity AND contribution_type='CASH' AND record_status='DECLARED'
 GROUP BY currency_code ORDER BY currency_code LIMIT 1;
 IF total IS NULL THEN RAISE EXCEPTION 'save the shareholder capital before attaching a document' USING ERRCODE='check_violation'; END IF;
 result:=abos.shareholder_setup_create_agreement(p_proof,p_runtime,p_token,jsonb_build_object(
  'shareholderProfileId',profile,'agreementReference','ATTACHMENT-'||profile::text,
  'committedAmount',total::text,'currencyCode',currency,'effectiveOn',current_date,'partialInstallmentsAllowed',true,
  'idempotencyKey','DOC-HOLDER-'||profile::text,'correlationId',gen_random_uuid()));
 holder:=(result->>'capitalAgreementId')::uuid;
 UPDATE abos.shareholder_profiles SET capital_document_agreement_id=holder WHERE id=profile AND legal_entity_id=entity;
 RETURN jsonb_build_object('capitalAgreementId',holder);
END $$;
ALTER FUNCTION abos.direct_shareholder_document_holder(text,text,text,jsonb) OWNER TO abos_v1_shareholder_setup_owner;

GRANT SELECT(id,legal_entity_id,shareholder_profile_id) ON abos.capital_agreements TO abos_v1_operational_finance_owner;
GRANT SELECT(agreement_evidence_id,capital_agreement_id,legal_entity_id,original_file_name)
 ON abos.capital_agreement_document_files TO abos_v1_operational_finance_owner;
GRANT SELECT(id,legal_entity_id,version) ON abos.capital_agreement_evidence TO abos_v1_operational_finance_owner;

CREATE FUNCTION abos.direct_shareholder_capital_workspace(p_proof text,p_runtime text,p_token text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE c jsonb; entity uuid; permissions jsonb; base text; company_name text; reason text; equity uuid;
BEGIN
 c:=abos.direct_capital_actor(p_proof,p_runtime,p_token,false);
 entity:=(c->>'legalEntityId')::uuid; permissions:=COALESCE(c->'permissions','[]'::jsonb);
 SELECT base_currency_code,name INTO base,company_name FROM abos.legal_entities WHERE id=entity;
 BEGIN equity:=abos.direct_capital_equity(entity,base); EXCEPTION WHEN check_violation THEN reason:='Choose an active shareholder capital equity account in Finance setup.'; END;
 IF NOT EXISTS(SELECT 1 FROM abos.finance_workflow_policy_versions p WHERE p.legal_entity_id=entity
  AND p.workflow_type='SHAREHOLDER_CAPITAL_RECEIPT' AND NOT p.approval_required
  AND p.version=(SELECT max(version) FROM abos.finance_workflow_policy_versions WHERE legal_entity_id=entity AND workflow_type=p.workflow_type)) THEN
  reason:='The company capital approval setting does not permit direct receipts.'; END IF;
 RETURN jsonb_build_object('legalEntity',jsonb_build_object('id',entity,'name',company_name,'baseCurrency',base),
 'permissions',jsonb_build_object('canManage',permissions ? 'shareholder.setup.manage',
  'canReceive',permissions ?& ARRAY['shareholder.capital-receipt.record','finance.capital-receipt.prepare','finance.capital-receipt.post']),
 'receiveAvailable',reason IS NULL,'unavailableReason',reason,
 'currencies',COALESCE((SELECT jsonb_agg(jsonb_build_object('code',code,'label',name) ORDER BY code) FROM abos.currencies WHERE enabled),'[]'::jsonb),
 'destinations',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',a.id,'name',a.name_en,'currency',a.currency_code,
  'balance',CASE WHEN permissions ? 'finance.report.operational.read' THEN COALESCE((SELECT sum(s.original_amount) FROM abos.subledger_entries s JOIN abos.journal_lines l ON l.id=s.journal_line_id
   JOIN abos.journals j ON j.id=l.journal_id AND j.legal_entity_id=l.legal_entity_id AND j.status='POSTED'
   WHERE s.legal_entity_id=entity AND s.operational_treasury_account_id=a.id AND s.subledger_type='OPERATIONAL_TREASURY'
    AND s.processing_model='OPERATIONAL_V1'
    AND(l.project_id IS NULL OR EXISTS(SELECT 1 FROM abos.user_scope_grants g WHERE g.user_account_id=(c->>'userAccountId')::uuid AND g.legal_entity_id=entity AND g.scope_kind='PROJECT' AND g.scope_id=l.project_id AND g.revoked_at IS NULL))
    AND(l.department_id IS NULL OR EXISTS(SELECT 1 FROM abos.user_scope_grants g WHERE g.user_account_id=(c->>'userAccountId')::uuid AND g.legal_entity_id=entity AND g.scope_kind='DEPARTMENT' AND g.scope_id=l.department_id AND g.revoked_at IS NULL))
    AND(l.cost_center_id IS NULL OR EXISTS(SELECT 1 FROM abos.user_scope_grants g WHERE g.user_account_id=(c->>'userAccountId')::uuid AND g.legal_entity_id=entity AND g.scope_kind='COST_CENTER' AND g.scope_id=l.cost_center_id AND g.revoked_at IS NULL))),0)::text ELSE NULL END) ORDER BY a.name_en)
  FROM abos.operational_treasury_accounts a JOIN abos.ledger_accounts l ON l.id=a.ledger_account_id AND l.legal_entity_id=entity
  WHERE a.legal_entity_id=entity AND a.status='ACTIVE' AND a.currency_code=base AND a.account_type IN('SAFE','CASH_BOX','PETTY_CASH')
   AND l.status='ACTIVE' AND l.posting_allowed AND l.account_type='ASSET' AND l.control_account_type='CASH'
   AND(l.account_currency_code IS NULL OR l.account_currency_code=a.currency_code)
   AND NOT l.requires_project AND NOT l.requires_department AND NOT l.requires_cost_center),'[]'::jsonb),
 'shareholders',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',p.id,'name',b.display_name,'reference',b.external_reference,
  'note',p.capital_note,'ownershipPercent',p.ownership_percentage::text,'active',p.status='ACTIVE' AND b.status='ACTIVE',
  'capitals',COALESCE((SELECT jsonb_agg(jsonb_build_object('currency',v.currency,'total',v.total::text,
    'received',v.received::text,'outstanding',(v.total-v.received)::text,'available',(v.total-v.reserved)::text) ORDER BY v.currency)
   FROM(SELECT d.currency_code AS currency,sum(d.amount) AS total,
    sum(COALESCE((SELECT sum(x.amount) FROM abos.direct_capital_receipt_allocations x WHERE x.contribution_id=d.id AND x.legal_entity_id=entity),0)
     +COALESCE((SELECT sum(r.original_amount) FROM abos.shareholder_capital_receipts r JOIN abos.posting_intents i ON i.shareholder_capital_receipt_id=r.id
       AND i.legal_entity_id=entity AND i.status='POSTED' JOIN abos.journals j ON j.posting_intent_id=i.id AND j.status='POSTED'
       WHERE r.contribution_id=d.id AND r.legal_entity_id=entity),0)) AS received,
    sum(COALESCE((SELECT sum(x.amount) FROM abos.direct_capital_receipt_allocations x WHERE x.contribution_id=d.id AND x.legal_entity_id=entity),0)
     +COALESCE((SELECT sum(r.original_amount) FROM abos.shareholder_capital_receipts r WHERE r.contribution_id=d.id
        AND r.legal_entity_id=entity AND r.record_state='RECORDED'),0)) AS reserved
    FROM abos.shareholder_contributions d WHERE d.shareholder_profile_id=p.id AND d.legal_entity_id=entity
     AND d.contribution_type='CASH' AND d.record_status='DECLARED' GROUP BY d.currency_code)v),'[]'::jsonb),
  'transactions',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',r.id,'date',r.receipt_date,'amount',r.original_amount::text,
   'currency',r.original_currency_code,'destination',a.name_en,'reference',r.transaction_reference,'status','POSTED',
   'journalId',r.journal_id,'note',r.note,'paymentReference',r.payment_reference) ORDER BY r.receipt_date DESC,r.created_at DESC)
   FROM abos.direct_capital_receipts r JOIN abos.operational_treasury_accounts a ON a.id=r.operational_treasury_account_id AND a.legal_entity_id=entity
   WHERE r.shareholder_profile_id=p.id AND r.legal_entity_id=entity),'[]'::jsonb),
  'documents',CASE WHEN permissions ?| ARRAY['shareholder.setup.manage','shareholder.read'] THEN
   COALESCE((SELECT jsonb_agg(jsonb_build_object('id',f.agreement_evidence_id,'fileName',f.original_file_name,'version',e.version) ORDER BY e.version DESC)
    FROM abos.capital_agreement_document_files f JOIN abos.capital_agreement_evidence e ON e.id=f.agreement_evidence_id AND e.legal_entity_id=entity
    JOIN abos.capital_agreements a ON a.id=f.capital_agreement_id AND a.legal_entity_id=entity
    WHERE a.shareholder_profile_id=p.id AND f.legal_entity_id=entity),'[]'::jsonb) ELSE '[]'::jsonb END)
  ORDER BY b.display_name,p.id) FROM abos.shareholder_profiles p JOIN abos.business_parties b ON b.id=p.business_party_id AND b.legal_entity_id=entity
  WHERE p.legal_entity_id=entity),'[]'::jsonb));
END $$;
ALTER FUNCTION abos.direct_shareholder_capital_workspace(text,text,text) OWNER TO abos_v1_operational_finance_owner;

REVOKE ALL ON FUNCTION abos.direct_capital_actor(text,text,text,boolean),abos.direct_capital_equity(uuid,text),
 abos.direct_shareholder_create(text,text,text,jsonb),abos.direct_shareholder_receive(text,text,text,jsonb),
 abos.direct_shareholder_capital_workspace(text,text,text),abos.direct_shareholder_document_holder(text,text,text,jsonb),
 abos.validate_direct_capital_journal_posting(),abos.guard_direct_capital_complete(),abos.refuse_direct_capital_reversal()
 FROM PUBLIC;
GRANT EXECUTE ON FUNCTION abos.direct_capital_actor(text,text,text,boolean),abos.direct_capital_equity(uuid,text)
 TO abos_v1_operational_finance_owner;
GRANT EXECUTE ON FUNCTION abos.direct_shareholder_create(text,text,text,jsonb),abos.direct_shareholder_receive(text,text,text,jsonb),
 abos.direct_shareholder_capital_workspace(text,text,text),abos.direct_shareholder_document_holder(text,text,text,jsonb) TO abos_e1_runtime;


-- 0040 narrow replacements: preserve all historical paths and widen only typed capital reads/bindings.

CREATE OR REPLACE FUNCTION abos.validate_operational_journal_posting()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $validate$
DECLARE
  intent_row abos.posting_intents%ROWTYPE;
  expense_row abos.operational_expenses%ROWTYPE;
  treasury_row abos.operational_treasury_accounts%ROWTYPE;
  category_row abos.operational_expense_categories%ROWTYPE;
  policy_row abos.finance_workflow_policy_versions%ROWTYPE;
  period_row record;
  entity_base text;
  snapshot_row abos.exchange_rate_snapshots%ROWTYPE;
  line_count bigint;
  debit_total numeric;
  credit_total numeric;
  approval_count bigint;
  treasury_subledger_count bigint;
BEGIN
  IF TG_OP = 'INSERT' AND NEW.status = 'POSTED' THEN
    RAISE EXCEPTION 'operational journals must be assembled as draft before posting'
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'POSTED' THEN
    RAISE EXCEPTION 'a posted operational journal is immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status <> 'POSTED' THEN RETURN NEW; END IF;

  SELECT * INTO intent_row FROM abos.posting_intents
   WHERE id = NEW.posting_intent_id AND legal_entity_id = NEW.legal_entity_id;
  IF FOUND AND intent_row.processing_model = 'OPERATIONAL_V1'
     AND intent_row.source_type = 'SHAREHOLDER_CAPITAL_CONTRIBUTION_RECEIPT' THEN
    RETURN NEW;
  END IF;
  -- 0037: typed temporary funding journals are validated by validate_temporary_funding_journal_posting().
  IF FOUND AND intent_row.processing_model = 'OPERATIONAL_V1'
     AND intent_row.source_type IN ('TEMPORARY_FUNDING', 'TEMPORARY_FUNDING_SETTLEMENT') THEN
    RETURN NEW;
  END IF;
  IF FOUND AND intent_row.processing_model = 'OPERATIONAL_V1'
     AND intent_row.source_type = 'DIRECT_SHAREHOLDER_CAPITAL' THEN RETURN NEW; END IF;
  IF NOT FOUND OR intent_row.processing_model <> 'OPERATIONAL_V1'
     OR intent_row.intent_kind <> 'EXPENSE' OR intent_row.status <> 'POSTED'
     OR intent_row.base_amount IS NULL
     OR intent_row.base_currency_code IS DISTINCT FROM NEW.base_currency_code THEN
    RAISE EXCEPTION 'operational posting requires a posted valued EXPENSE intent'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO expense_row FROM abos.operational_expenses
   WHERE id = intent_row.operational_expense_id AND legal_entity_id = NEW.legal_entity_id;
  IF NOT FOUND OR expense_row.id IS DISTINCT FROM intent_row.source_id
     OR expense_row.status <> 'POSTED' OR expense_row.journal_id IS DISTINCT FROM NEW.id
     OR expense_row.original_amount IS DISTINCT FROM intent_row.original_amount
     OR expense_row.original_currency_code IS DISTINCT FROM intent_row.original_currency_code
     OR expense_row.base_amount IS DISTINCT FROM intent_row.base_amount
     OR expense_row.base_currency_code IS DISTINCT FROM intent_row.base_currency_code
     OR expense_row.business_date IS DISTINCT FROM NEW.accounting_effective_date THEN
    RAISE EXCEPTION 'operational expense, intent and journal do not agree'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO policy_row FROM abos.finance_workflow_policy_versions
   WHERE id = expense_row.workflow_policy_version_id
     AND legal_entity_id = NEW.legal_entity_id AND workflow_type = 'EXPENSE';
  IF NOT FOUND OR policy_row.approval_required IS DISTINCT FROM expense_row.approval_required THEN
    RAISE EXCEPTION 'operational expense approval route does not match its immutable policy snapshot'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*) INTO approval_count FROM abos.operational_expense_approvals approval
   WHERE approval.operational_expense_id = expense_row.id
     AND approval.legal_entity_id = NEW.legal_entity_id
     AND approval.decision = 'APPROVED'
     AND approval.approver_user_account_id = NEW.posted_by_user_account_id;
  IF expense_row.approval_required THEN
    IF approval_count <> 1
       OR NEW.posted_by_user_account_id = expense_row.created_by_user_account_id THEN
      RAISE EXCEPTION 'approval-required expense must be posted by its independent approver'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF approval_count <> 0
        OR NEW.posted_by_user_account_id IS DISTINCT FROM expense_row.created_by_user_account_id THEN
    RAISE EXCEPTION 'direct-posting expense must have no approval and be posted by its creator'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT status, starts_on, ends_on INTO period_row FROM abos.accounting_periods
   WHERE id = NEW.accounting_period_id AND legal_entity_id = NEW.legal_entity_id;
  IF NOT FOUND OR period_row.status <> 'OPEN'
     OR NEW.accounting_effective_date NOT BETWEEN period_row.starts_on AND period_row.ends_on THEN
    RAISE EXCEPTION 'operational posting requires an open accounting period covering its date'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT base_currency_code INTO entity_base FROM abos.legal_entities
   WHERE id = NEW.legal_entity_id AND currency_policy_status = 'APPROVED';
  IF entity_base IS NULL OR entity_base IS DISTINCT FROM NEW.base_currency_code THEN
    RAISE EXCEPTION 'operational posting requires the approved legal-entity base currency'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO treasury_row FROM abos.operational_treasury_accounts
   WHERE id = expense_row.operational_treasury_account_id
     AND legal_entity_id = NEW.legal_entity_id AND status = 'ACTIVE';
  SELECT * INTO category_row FROM abos.operational_expense_categories
   WHERE id = expense_row.operational_expense_category_id
     AND legal_entity_id = NEW.legal_entity_id AND status = 'ACTIVE';
  IF treasury_row.id IS NULL OR category_row.id IS NULL
     OR treasury_row.currency_code <> expense_row.original_currency_code THEN
    RAISE EXCEPTION 'expense requires active same-entity Treasury and category mappings'
      USING ERRCODE = 'check_violation';
  END IF;

  IF expense_row.original_currency_code = expense_row.base_currency_code THEN
    IF expense_row.exchange_rate_snapshot_id IS NOT NULL
       OR expense_row.base_amount <> expense_row.original_amount THEN
      RAISE EXCEPTION 'base-currency expense must retain the same amount without an FX snapshot'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    SELECT * INTO snapshot_row FROM abos.exchange_rate_snapshots
     WHERE id = expense_row.exchange_rate_snapshot_id
       AND legal_entity_id = NEW.legal_entity_id
       AND source_type = 'OPERATIONAL_EXPENSE' AND source_id = expense_row.id;
    IF NOT FOUND OR snapshot_row.transaction_currency_code <> expense_row.original_currency_code
       OR snapshot_row.base_currency_code <> expense_row.base_currency_code
       OR snapshot_row.rate_date <> expense_row.business_date
       OR intent_row.conversion_snapshot_reference IS DISTINCT FROM snapshot_row.id::text THEN
      RAISE EXCEPTION 'foreign-currency expense requires its exact immutable rate snapshot'
        USING ERRCODE = 'check_violation';
    END IF;
    IF snapshot_row.unit_currency_code = expense_row.original_currency_code
       AND snapshot_row.quote_currency_code = expense_row.base_currency_code THEN
      IF expense_row.base_amount <> expense_row.original_amount * snapshot_row.rate_value THEN
        RAISE EXCEPTION 'expense base amount does not exactly follow its direct rate'
          USING ERRCODE = 'check_violation';
      END IF;
    ELSIF snapshot_row.quote_currency_code = expense_row.original_currency_code
       AND snapshot_row.unit_currency_code = expense_row.base_currency_code THEN
      IF expense_row.base_amount * snapshot_row.rate_value <> expense_row.original_amount THEN
        RAISE EXCEPTION 'inverse rate requires an exact result; rounding policy is not approved'
          USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      RAISE EXCEPTION 'snapshot currency direction does not match the expense'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  SELECT count(*), coalesce(sum(base_debit), 0), coalesce(sum(base_credit), 0)
    INTO line_count, debit_total, credit_total FROM abos.journal_lines
   WHERE journal_id = NEW.id;
  IF line_count <> 2 OR debit_total <> credit_total
     OR debit_total <> expense_row.base_amount THEN
    RAISE EXCEPTION 'expense journal must contain exactly two lines balanced to its base amount'
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM abos.journal_lines line
    JOIN abos.ledger_accounts ledger ON ledger.id = line.ledger_account_id
     AND ledger.legal_entity_id = line.legal_entity_id
    WHERE line.journal_id = NEW.id AND (
      line.processing_model <> 'OPERATIONAL_V1'
      OR line.legal_entity_id <> NEW.legal_entity_id
      OR line.base_currency_code <> NEW.base_currency_code
      OR line.original_amount <> expense_row.original_amount
      OR line.original_currency_code <> expense_row.original_currency_code
      OR line.conversion_snapshot_reference IS DISTINCT FROM intent_row.conversion_snapshot_reference
      OR ledger.status <> 'ACTIVE' OR NOT ledger.posting_allowed
      OR (ledger.requires_project AND line.project_id IS NULL)
      OR (ledger.requires_department AND line.department_id IS NULL)
      OR (ledger.requires_cost_center AND line.cost_center_id IS NULL)
    )) THEN
    RAISE EXCEPTION 'operational journal line violates entity, currency, account or dimension rules'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM abos.journal_lines line WHERE line.journal_id = NEW.id
      AND line.line_number = 1 AND line.ledger_account_id = category_row.ledger_account_id
      AND line.base_debit = expense_row.base_amount AND line.base_credit = 0
      AND line.project_id IS NOT DISTINCT FROM expense_row.project_id
      AND line.department_id IS NOT DISTINCT FROM expense_row.department_id
      AND line.cost_center_id IS NOT DISTINCT FROM expense_row.cost_center_id
      AND line.business_party_id IS NOT DISTINCT FROM expense_row.payee_business_party_id
  ) OR NOT EXISTS (
    SELECT 1 FROM abos.journal_lines line WHERE line.journal_id = NEW.id
      AND line.line_number = 2 AND line.ledger_account_id = treasury_row.ledger_account_id
      AND line.base_debit = 0 AND line.base_credit = expense_row.base_amount
      AND line.project_id IS NOT DISTINCT FROM expense_row.project_id
      AND line.department_id IS NOT DISTINCT FROM expense_row.department_id
      AND line.cost_center_id IS NOT DISTINCT FROM expense_row.cost_center_id
      AND line.business_party_id IS NULL
  ) THEN
    RAISE EXCEPTION 'expense journal must debit its category and credit its Treasury mapping'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*) INTO treasury_subledger_count
    FROM abos.subledger_entries entry
    JOIN abos.journal_lines line ON line.id = entry.journal_line_id
   WHERE line.journal_id = NEW.id
     AND entry.processing_model = 'OPERATIONAL_V1'
     AND entry.subledger_type = 'OPERATIONAL_TREASURY'
     AND entry.operational_treasury_account_id = treasury_row.id
     AND entry.original_amount = -expense_row.original_amount
     AND entry.original_currency_code = expense_row.original_currency_code
     AND entry.base_amount = -expense_row.base_amount
     AND entry.base_currency_code = expense_row.base_currency_code
     AND entry.source_type = 'OPERATIONAL_EXPENSE' AND entry.source_id = expense_row.id;
  IF treasury_subledger_count <> 1 OR EXISTS (
    SELECT 1 FROM abos.subledger_entries entry
    JOIN abos.journal_lines line ON line.id = entry.journal_line_id
    WHERE line.journal_id = NEW.id AND (
      entry.processing_model <> 'OPERATIONAL_V1'
      OR entry.subledger_type <> 'OPERATIONAL_TREASURY'
      OR line.line_number <> 2)
  ) THEN
    RAISE EXCEPTION 'expense journal requires exactly one matching Treasury subledger movement'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$validate$;

CREATE OR REPLACE FUNCTION abos.record_shareholder_capital_receipt(
  p_identity_proof text, p_runtime_token_sha256 text, p_token_sha256 text, p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $record$
DECLARE
  v_context jsonb; v_actor uuid; v_entity uuid; v_contribution_id uuid; v_destination_id uuid;
  v_expected integer; v_amount numeric; v_currency text; v_date date; v_reference text;
  v_evidence uuid; v_key text; v_correlation uuid; v_fingerprint text; v_source_fingerprint text;
  v_scope text; v_idem jsonb; v_receipt_id uuid; v_allocated numeric;
  v_source abos.shareholder_contributions%ROWTYPE;
  v_treasury abos.operational_treasury_accounts%ROWTYPE;
  v_entity_base text; v_policy text; v_evidence_kind text; v_result jsonb;
BEGIN
  v_context := abos.shareholder_capital_actor(p_identity_proof, p_runtime_token_sha256,
    p_token_sha256, 'shareholder.capital-receipt.record');
  v_actor := (v_context ->> 'userAccountId')::uuid;
  v_entity := (v_context ->> 'legalEntityId')::uuid;
  IF EXISTS (SELECT 1 FROM pg_catalog.jsonb_object_keys(p_payload) key
              WHERE key NOT IN ('contributionId','expectedContributionVersion','amount','receiptDate',
                'treasuryDestinationId','paymentReference','evidenceReferenceId','idempotencyKey','correlationId')) THEN
    RAISE EXCEPTION 'capital receipt request contains unsupported fields' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  BEGIN
    v_contribution_id := (p_payload ->> 'contributionId')::uuid;
    v_destination_id := (p_payload ->> 'treasuryDestinationId')::uuid;
    v_expected := (p_payload ->> 'expectedContributionVersion')::integer;
    v_date := (p_payload ->> 'receiptDate')::date;
    v_evidence := NULLIF(p_payload ->> 'evidenceReferenceId','')::uuid;
    v_key := btrim(p_payload ->> 'idempotencyKey');
    v_correlation := (p_payload ->> 'correlationId')::uuid;
    v_amount := (p_payload #>> '{amount,amount}')::numeric;
    v_currency := upper(p_payload #>> '{amount,currency}');
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'a complete valid capital receipt request is required'
      USING ERRCODE = 'invalid_parameter_value';
  END;
  IF (p_payload #>> '{amount,amount}') !~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$'
     OR v_amount <= 0 OR v_amount >= 'Infinity'::numeric
     OR length(v_key) NOT BETWEEN 8 AND 200 THEN
    RAISE EXCEPTION 'a positive plain-decimal amount and idempotency key are required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_reference := NULLIF(btrim(p_payload ->> 'paymentReference'), '');
  v_source := abos.shareholder_contribution_finance_lock(v_entity, v_contribution_id, v_expected);
  SELECT base_currency_code, currency_policy_status INTO v_entity_base, v_policy
    FROM abos.legal_entities WHERE id = v_entity;
  SELECT * INTO v_treasury FROM abos.operational_treasury_accounts
   WHERE id = v_destination_id AND legal_entity_id = v_entity;
  IF v_policy <> 'APPROVED' OR v_entity_base IS NULL
     OR v_source.currency_code IS DISTINCT FROM v_currency
     OR v_currency IS DISTINCT FROM v_entity_base
     OR v_treasury.id IS NULL OR v_treasury.status <> 'ACTIVE'
     OR v_treasury.currency_code IS DISTINCT FROM v_currency THEN
    RAISE EXCEPTION 'capital receipt requires approved base currency and an active same-currency Treasury destination'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_date IS NULL OR v_date < v_source.business_date THEN
    RAISE EXCEPTION 'actual capital receipt date cannot precede the declaration date'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_evidence IS NOT NULL THEN
    SELECT evidence_kind INTO v_evidence_kind FROM abos.evidence_references
     WHERE id = v_evidence AND legal_entity_id = v_entity;
    IF v_evidence_kind IS DISTINCT FROM 'CASH_RECEIPT' THEN
      RAISE EXCEPTION 'optional receipt evidence must be structured CASH_RECEIPT evidence'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  v_fingerprint := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    (p_payload - 'correlationId')::text || ':' || v_actor::text, 'UTF8')), 'hex');
  v_source_fingerprint := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    pg_catalog.concat_ws(':',v_source.id::text,v_source.version::text,
      v_source.shareholder_profile_id::text,v_source.contribution_type,v_source.business_date::text,
      v_source.amount::text,v_source.currency_code), 'UTF8')), 'hex');
  v_scope := 'shareholder-capital:record:' || v_entity::text || ':' || v_actor::text;
  v_idem := abos.shareholder_capital_idempotency_begin(v_scope,v_key,v_fingerprint,v_correlation);
  IF (v_idem ->> 'replayed')::boolean THEN
    RETURN v_idem -> 'snapshot';
  END IF;
  SELECT COALESCE(sum(original_amount),0) INTO v_allocated
    FROM abos.shareholder_capital_receipts
   WHERE legal_entity_id = v_entity AND contribution_id = v_source.id AND record_state = 'RECORDED';
  v_allocated := v_allocated + COALESCE((SELECT sum(amount) FROM abos.direct_capital_receipt_allocations
    WHERE legal_entity_id=v_entity AND contribution_id=v_source.id),0);
  IF v_allocated + v_amount > v_source.amount THEN
    RAISE EXCEPTION 'recorded receipts would exceed the declared contribution amount'
      USING ERRCODE = 'check_violation';
  END IF;
  v_receipt_id := pg_catalog.gen_random_uuid();
  INSERT INTO abos.shareholder_capital_receipts
    (id,legal_entity_id,contribution_id,operational_treasury_account_id,original_amount,
     original_currency_code,receipt_date,payment_reference,evidence_reference_id,
     contribution_version,source_fingerprint,record_state,version,correlation_id,
     idempotency_key,request_fingerprint,recorded_by_user_account_id)
  VALUES (v_receipt_id,v_entity,v_source.id,v_treasury.id,v_amount,v_currency,v_date,
          v_reference,v_evidence,v_source.version,v_source_fingerprint,'RECORDED',1,
          v_correlation,v_key,v_fingerprint,v_actor);
  v_result := pg_catalog.jsonb_build_object(
    'receipt',abos.shareholder_capital_receipt_json(v_receipt_id),'replayed',false);
  PERFORM abos.shareholder_capital_audit(v_actor,v_entity,v_correlation,
    'SHAREHOLDER_CAPITAL_RECEIPT_RECORDED','SHAREHOLDER_CAPITAL_RECEIPT',v_receipt_id,v_result);
  PERFORM abos.shareholder_capital_idempotency_complete(v_scope,v_key,
    'SHAREHOLDER_CAPITAL_RECEIPT',v_receipt_id,v_result);
  RETURN v_result;
END
$record$;

CREATE OR REPLACE FUNCTION abos.shareholder_setup_has_posted_capital(p_profile_id uuid, p_entity_id uuid)
RETURNS boolean LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $posted$
  SELECT EXISTS (
    SELECT 1 FROM abos.capital_agreements agreement
     WHERE agreement.shareholder_profile_id = p_profile_id AND agreement.legal_entity_id = p_entity_id
       AND (abos.shareholder_setup_received(agreement.id, p_entity_id) > 0
            OR EXISTS (
              SELECT 1 FROM abos.capital_installments installment
                JOIN abos.cash_receipts receipt ON receipt.capital_installment_id = installment.id
                JOIN abos.posting_intents intent ON intent.treasury_cash_receipt_id = receipt.id
                JOIN abos.journals journal ON journal.posting_intent_id = intent.id AND journal.status = 'POSTED'
               WHERE installment.capital_agreement_id = agreement.id)))
  OR EXISTS(SELECT 1 FROM abos.direct_capital_receipts WHERE shareholder_profile_id=p_profile_id AND legal_entity_id=p_entity_id)
$posted$;

CREATE OR REPLACE FUNCTION abos.operational_finance_daily_report(
  p_identity_proof text,
  p_runtime_token_sha256 text,
  p_token_sha256 text,
  p_report_date date
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $report$
DECLARE
  v_actor_context jsonb;
  v_actor_id uuid;
  v_entity_id uuid;
  v_base_currency text;
BEGIN
  v_actor_context := abos.operational_finance_actor(
    p_identity_proof, p_runtime_token_sha256, p_token_sha256, 'finance.expense.read');
  v_actor_id := (v_actor_context ->> 'userAccountId')::uuid;
  v_entity_id := (v_actor_context ->> 'legalEntityId')::uuid;
  IF p_report_date IS NULL THEN
    RAISE EXCEPTION 'a report date is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT entity.base_currency_code INTO v_base_currency FROM abos.legal_entities entity
   WHERE entity.id = v_entity_id;

  RETURN pg_catalog.jsonb_build_object(
    'reportDate', p_report_date,
    'baseCurrency', v_base_currency,
    -- Posted expenses of the date, per category and currency; currencies are never combined.
    'expensesByCategory', COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'categoryId', grouped.category_id, 'code', grouped.category_code,
        'nameEn', grouped.name_en, 'nameFa', grouped.name_fa,
        'currency', grouped.currency, 'count', grouped.expense_count,
        'amount', grouped.amount::text, 'baseAmount', grouped.base_amount::text)
        ORDER BY grouped.category_code, grouped.currency)
      FROM (SELECT category.id AS category_id, category.category_code, category.name_en, category.name_fa,
                   expense.original_currency_code AS currency, count(*) AS expense_count,
                   sum(expense.original_amount) AS amount, sum(expense.base_amount) AS base_amount
              FROM abos.operational_expenses expense
              JOIN abos.operational_expense_categories category
                ON category.id = expense.operational_expense_category_id
             WHERE expense.legal_entity_id = v_entity_id AND expense.status = 'POSTED'
               AND expense.business_date = p_report_date
               AND abos.operational_expense_actor_in_scope(expense.id, v_entity_id, v_actor_id)
             GROUP BY category.id, category.category_code, category.name_en, category.name_fa,
                      expense.original_currency_code) grouped), '[]'::jsonb),
    'totalsByCurrency', COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'currency', totals.currency, 'count', totals.expense_count, 'amount', totals.amount::text)
        ORDER BY totals.currency)
      FROM (SELECT expense.original_currency_code AS currency, count(*) AS expense_count,
                   sum(expense.original_amount) AS amount
              FROM abos.operational_expenses expense
             WHERE expense.legal_entity_id = v_entity_id AND expense.status = 'POSTED'
               AND expense.business_date = p_report_date
               AND abos.operational_expense_actor_in_scope(expense.id, v_entity_id, v_actor_id)
             GROUP BY expense.original_currency_code) totals), '[]'::jsonb),
    'baseTotal', (SELECT pg_catalog.jsonb_build_object('currency', v_base_currency,
        'amount', COALESCE(sum(expense.base_amount), 0)::text)
      FROM abos.operational_expenses expense
      WHERE expense.legal_entity_id = v_entity_id AND expense.status = 'POSTED'
        AND expense.business_date = p_report_date
        AND abos.operational_expense_actor_in_scope(expense.id, v_entity_id, v_actor_id)),
    'pendingApproval', (SELECT pg_catalog.jsonb_build_object('count', count(*))
      FROM abos.operational_expenses expense
      WHERE expense.legal_entity_id = v_entity_id AND expense.status = 'PENDING_APPROVAL'
        AND expense.business_date = p_report_date
        AND abos.operational_expense_actor_in_scope(expense.id, v_entity_id, v_actor_id)),
    -- Operational Treasury movements from posted subledger entries only, in each account's own
    -- currency; "before" is every movement dated earlier, "day" is the report date.
    'treasuryMovements', COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'treasuryAccountId', account.id, 'nameEn', account.name_en, 'nameFa', account.name_fa,
        'currency', account.currency_code, 'status', account.status,
        'before', movements.before_amount::text, 'day', movements.day_amount::text,
        'after', (movements.before_amount + movements.day_amount)::text)
        ORDER BY account.name_en, account.id)
      FROM abos.operational_treasury_accounts account
      CROSS JOIN LATERAL (
        SELECT COALESCE(sum(entry.original_amount) FILTER (WHERE journal.accounting_effective_date < p_report_date), 0) AS before_amount,
               COALESCE(sum(entry.original_amount) FILTER (WHERE journal.accounting_effective_date = p_report_date), 0) AS day_amount
          FROM abos.subledger_entries entry
          JOIN abos.journal_lines line ON line.id = entry.journal_line_id
          JOIN abos.journals journal ON journal.id = line.journal_id AND journal.status = 'POSTED'
          LEFT JOIN abos.operational_expenses expense
            ON expense.id = entry.source_id AND expense.legal_entity_id = entry.legal_entity_id
         WHERE entry.operational_treasury_account_id = account.id
           AND entry.legal_entity_id = v_entity_id
           AND entry.processing_model = 'OPERATIONAL_V1'

           AND journal.accounting_effective_date <= p_report_date
           AND ((entry.source_type='OPERATIONAL_EXPENSE'
                 AND abos.operational_expense_actor_in_scope(expense.id,v_entity_id,v_actor_id))
                OR (entry.source_type='DIRECT_SHAREHOLDER_CAPITAL'
                    AND (v_actor_context->'permissions') ?| ARRAY['shareholder.capital-receipt.read','shareholder.setup.manage']))) movements
      WHERE account.legal_entity_id = v_entity_id), '[]'::jsonb));
END
$report$;
CREATE OR REPLACE FUNCTION abos.guard_bound_shareholder_contribution()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF (TG_OP='DELETE' OR NEW IS DISTINCT FROM OLD) AND (
  EXISTS(SELECT 1 FROM abos.shareholder_capital_receipts WHERE legal_entity_id=OLD.legal_entity_id AND contribution_id=OLD.id)
  OR EXISTS(SELECT 1 FROM abos.direct_capital_receipt_allocations WHERE legal_entity_id=OLD.legal_entity_id AND contribution_id=OLD.id)) THEN
  RAISE EXCEPTION 'a contribution with a financial receipt binding is immutable' USING ERRCODE='check_violation';
 END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
GRANT SELECT(ledger_account_id,legal_entity_id,review_state) ON abos.ledger_account_governance TO abos_v1_operational_finance_owner;
GRANT SELECT(code,name,enabled) ON abos.currencies TO abos_v1_operational_finance_owner;
