\set ON_ERROR_STOP on
BEGIN;

INSERT INTO abos.currencies VALUES ('USD', 'US Dollar', true, clock_timestamp());
INSERT INTO abos.companies (id, code, name, status) VALUES
 ('10000000-0000-4000-8000-000000000001', 'SYN', 'Synthetic E0 Company', 'ACTIVE');
INSERT INTO abos.legal_entities
 (id, company_id, code, name, base_currency_code, currency_policy_status) VALUES
 ('10000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001',
  'SYN-LE', 'Synthetic E0 Entity', 'USD', 'APPROVED');
INSERT INTO abos.user_accounts (id, login_identifier, display_name, status) VALUES
 ('10000000-0000-4000-8000-000000000010', 'creator', 'Synthetic Creator', 'ACTIVE'),
 ('10000000-0000-4000-8000-000000000011', 'cashier', 'Synthetic Cashier', 'ACTIVE'),
 ('10000000-0000-4000-8000-000000000012', 'verifier', 'Synthetic Verifier', 'ACTIVE'),
 ('10000000-0000-4000-8000-000000000013', 'finance', 'Synthetic Finance', 'ACTIVE');
INSERT INTO abos.evidence_references
 (id, legal_entity_id, document_id, evidence_kind, evidence_version, sha256, completed_at) VALUES
 ('10000000-0000-4000-8000-000000000101', '10000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000201', 'OPENING_RECONCILIATION', 1, repeat('a',64), '2026-09-22T06:00:00Z'),
 ('10000000-0000-4000-8000-000000000102', '10000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000202', 'PHYSICAL_CASH_COUNT', 1, repeat('b',64), '2026-09-22T06:05:00Z'),
 ('10000000-0000-4000-8000-000000000103', '10000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000203', 'CASH_RECEIPT', 1, repeat('c',64), '2026-09-22T06:10:00Z'),
 ('10000000-0000-4000-8000-000000000104', '10000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000204', 'FINANCE_APPROVAL', 1, repeat('d',64), '2026-09-22T06:15:00Z'),
 ('10000000-0000-4000-8000-000000000105', '10000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000205', 'REVERSAL_REASON', 1, repeat('e',64), '2026-09-22T06:20:00Z'),
 ('10000000-0000-4000-8000-000000000106', '10000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000206', 'FORMAL_REGISTRATION', 1, repeat('f',64), '2026-09-22T06:22:00Z');

INSERT INTO abos.business_parties (id, legal_entity_id, display_name, status) VALUES
 ('10000000-0000-4000-8000-000000000020', '10000000-0000-4000-8000-000000000002', 'Synthetic Shareholder', 'ACTIVE');
INSERT INTO abos.business_party_roles (business_party_id, role_code, effective_from) VALUES
 ('10000000-0000-4000-8000-000000000020', 'SHAREHOLDER', '2026-01-01');
INSERT INTO abos.shareholder_profiles (id, legal_entity_id, business_party_id, status) VALUES
 ('10000000-0000-4000-8000-000000000021', '10000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000020', 'ACTIVE');
INSERT INTO abos.accounting_periods
 (id, legal_entity_id, period_name, starts_on, ends_on, status, opened_by_user_account_id, opened_at) VALUES
 ('10000000-0000-4000-8000-000000000030', '10000000-0000-4000-8000-000000000002', 'Synthetic Sep 2026',
  '2026-09-01', '2026-09-30', 'OPEN', '10000000-0000-4000-8000-000000000013', '2026-09-01T00:00:00Z');
INSERT INTO abos.ledger_accounts
 (id, legal_entity_id, account_code, account_name, account_type, control_account_type, posting_allowed, account_currency_code, status) VALUES
 ('10000000-0000-4000-8000-000000000040', '10000000-0000-4000-8000-000000000002', 'SYN-CASH', 'Synthetic Cash', 'ASSET', 'CASH', true, 'USD', 'ACTIVE'),
 ('10000000-0000-4000-8000-000000000041', '10000000-0000-4000-8000-000000000002', 'SYN-CAP', 'Synthetic Capital', 'EQUITY', 'SHAREHOLDER_CAPITAL', true, 'USD', 'ACTIVE');
INSERT INTO abos.capital_agreements
 (id, legal_entity_id, shareholder_profile_id, agreement_reference, agreement_kind, committed_amount, currency_code, effective_on, status, created_by_user_account_id) VALUES
 ('10000000-0000-4000-8000-000000000050', '10000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000021',
  'SYN-AGREE', 'CAPITAL_CONTRIBUTION', 100, 'USD', '2026-09-01', 'ELIGIBLE', '10000000-0000-4000-8000-000000000010');
INSERT INTO abos.capital_installments
 (id, legal_entity_id, capital_agreement_id, sequence_number, expected_amount, currency_code, status, created_by_user_account_id) VALUES
 ('10000000-0000-4000-8000-000000000051', '10000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000050',
  1, 100, 'USD', 'RECEIVED_PENDING_APPROVAL', '10000000-0000-4000-8000-000000000010');
INSERT INTO abos.registration_evidence
 (id, legal_entity_id, capital_agreement_id, evidence_reference_id, status, verified_by_user_account_id, verified_at) VALUES
 ('10000000-0000-4000-8000-000000000052', '10000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000050',
  '10000000-0000-4000-8000-000000000106', 'VERIFIED', '10000000-0000-4000-8000-000000000012', '2026-09-22T06:23:00Z');
INSERT INTO abos.cash_locations
 (id, legal_entity_id, location_name, responsible_cashier_user_account_id, status) VALUES
 ('10000000-0000-4000-8000-000000000060', '10000000-0000-4000-8000-000000000002', 'Synthetic Safe', '10000000-0000-4000-8000-000000000011', 'ACTIVE');
INSERT INTO abos.cash_location_currency_accounts
 (id, legal_entity_id, cash_location_id, currency_code, ledger_account_id, activation_status,
  reconciliation_evidence_reference_id, activated_by_user_account_id, activated_at) VALUES
 ('10000000-0000-4000-8000-000000000061', '10000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000060',
  'USD', '10000000-0000-4000-8000-000000000040', 'ACTIVE', '10000000-0000-4000-8000-000000000101',
  '10000000-0000-4000-8000-000000000013', '2026-09-22T06:25:00Z');
INSERT INTO abos.physical_cash_counts
 (id, legal_entity_id, cash_location_currency_account_id, currency_code, counted_amount, counted_at,
  counted_by_user_account_id, evidence_reference_id, status, confirmed_by_user_account_id, confirmed_at) VALUES
 ('10000000-0000-4000-8000-000000000062', '10000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000061',
  'USD', 100, '2026-09-22T06:30:00Z', '10000000-0000-4000-8000-000000000011', '10000000-0000-4000-8000-000000000102',
  'CONFIRMED', '10000000-0000-4000-8000-000000000012', '2026-09-22T06:35:00Z');
INSERT INTO abos.cash_receipts
 (id, legal_entity_id, capital_installment_id, cash_location_currency_account_id, physical_cash_count_id,
  receipt_reference, amount, currency_code, business_event_at, received_by_user_account_id,
  evidence_reference_id, status, verified_by_user_account_id, verified_at) VALUES
 ('10000000-0000-4000-8000-000000000063', '10000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000051',
  '10000000-0000-4000-8000-000000000061', '10000000-0000-4000-8000-000000000062', 'SYN-RECEIPT', 100, 'USD',
  '2026-09-22T06:40:00Z', '10000000-0000-4000-8000-000000000011', '10000000-0000-4000-8000-000000000103',
  'VERIFIED', '10000000-0000-4000-8000-000000000012', '2026-09-22T06:45:00Z');

INSERT INTO abos.posting_intents
 (id, legal_entity_id, source_type, source_id, treasury_cash_receipt_id, intent_kind, original_amount, original_currency_code,
  base_amount, base_currency_code, accounting_effective_date, correlation_id, idempotency_key, status, created_by_user_account_id) VALUES
 ('10000000-0000-4000-8000-000000000070', '10000000-0000-4000-8000-000000000002', 'CAPITAL_RECEIPT_INTENT',
  '10000000-0000-4000-8000-000000000071', '10000000-0000-4000-8000-000000000063', 'SHAREHOLDER_CAPITAL_RECEIPT',
  100, 'USD', 100, 'USD', '2026-09-22', '10000000-0000-4000-8000-000000000072', 'syn-post', 'APPROVED',
  '10000000-0000-4000-8000-000000000010');

DO $test$
BEGIN
  BEGIN
    INSERT INTO abos.posting_intents
      (id, legal_entity_id, source_type, source_id, treasury_cash_receipt_id, intent_kind, original_amount,
       original_currency_code, base_amount, base_currency_code, accounting_effective_date, correlation_id,
       idempotency_key, status, created_by_user_account_id) VALUES
      ('10000000-0000-4000-8000-000000000075', '10000000-0000-4000-8000-000000000002', 'CAPITAL_RECEIPT_INTENT',
       '10000000-0000-4000-8000-000000000076', '10000000-0000-4000-8000-000000000063', 'SHAREHOLDER_CAPITAL_RECEIPT',
       100, 'USD', 100, 'USD', '2026-09-22', '10000000-0000-4000-8000-000000000077', 'syn-post-duplicate',
       'APPROVED', '10000000-0000-4000-8000-000000000010');
    RAISE EXCEPTION 'duplicate receipt intent unexpectedly succeeded';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;
END;
$test$;

DO $test$
BEGIN
  BEGIN
    INSERT INTO abos.posting_approvals
      (id, legal_entity_id, posting_intent_id, decision, approver_user_account_id, evidence_reference_id, approved_at) VALUES
      ('10000000-0000-4000-8000-000000000074', '10000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000070',
       'APPROVED', '10000000-0000-4000-8000-000000000011', '10000000-0000-4000-8000-000000000104', '2026-09-22T06:50:00Z');
    RAISE EXCEPTION 'cashier self-approval unexpectedly succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'cashier self-approval unexpectedly succeeded' THEN RAISE; END IF;
    IF position('cashier or cash counter' IN SQLERRM) = 0 THEN RAISE; END IF;
  END;
END;
$test$;

INSERT INTO abos.posting_approvals
 (id, legal_entity_id, posting_intent_id, decision, approver_user_account_id, evidence_reference_id, approved_at) VALUES
 ('10000000-0000-4000-8000-000000000073', '10000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000070',
  'APPROVED', '10000000-0000-4000-8000-000000000013', '10000000-0000-4000-8000-000000000104', '2026-09-22T06:50:00Z');
INSERT INTO abos.journals
 (id, legal_entity_id, accounting_period_id, posting_intent_id, journal_reference, accounting_effective_date,
  base_currency_code, status, created_by_user_account_id) VALUES
 ('10000000-0000-4000-8000-000000000080', '10000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000030',
  '10000000-0000-4000-8000-000000000070', 'SYN-JOURNAL', '2026-09-22', 'USD', 'DRAFT', '10000000-0000-4000-8000-000000000010');
INSERT INTO abos.journal_lines
 (id, journal_id, legal_entity_id, line_number, ledger_account_id, business_party_id, original_amount, original_currency_code,
  base_debit, base_credit, base_currency_code, source_type, source_id) VALUES
 ('10000000-0000-4000-8000-000000000081', '10000000-0000-4000-8000-000000000080', '10000000-0000-4000-8000-000000000002',
  1, '10000000-0000-4000-8000-000000000040', NULL, 100, 'USD', 100, 0, 'USD', 'CAPITAL_RECEIPT_INTENT', '10000000-0000-4000-8000-000000000071'),
 ('10000000-0000-4000-8000-000000000082', '10000000-0000-4000-8000-000000000080', '10000000-0000-4000-8000-000000000002',
  2, '10000000-0000-4000-8000-000000000041', '10000000-0000-4000-8000-000000000020', 100, 'USD', 0, 100, 'USD',
  'CAPITAL_RECEIPT_INTENT', '10000000-0000-4000-8000-000000000071');
INSERT INTO abos.subledger_entries
 (id, legal_entity_id, journal_line_id, subledger_type, business_party_id, cash_location_currency_account_id,
  original_amount, original_currency_code, base_amount, base_currency_code, source_type, source_id) VALUES
 ('10000000-0000-4000-8000-000000000083', '10000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000081',
  'CASH_LOCATION', NULL, '10000000-0000-4000-8000-000000000061', 100, 'USD', 100, 'USD', 'CAPITAL_RECEIPT_INTENT', '10000000-0000-4000-8000-000000000071'),
 ('10000000-0000-4000-8000-000000000084', '10000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000082',
  'SHAREHOLDER_CAPITAL', '10000000-0000-4000-8000-000000000020', NULL, -100, 'USD', -100, 'USD',
  'CAPITAL_RECEIPT_INTENT', '10000000-0000-4000-8000-000000000071');

DO $test$
BEGIN
  BEGIN
    INSERT INTO abos.journals
      (id, legal_entity_id, accounting_period_id, posting_intent_id, journal_reference, accounting_effective_date,
       base_currency_code, status, created_by_user_account_id, posted_by_user_account_id, posted_at) VALUES
      ('10000000-0000-4000-8000-000000000090', '10000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000030',
       '10000000-0000-4000-8000-000000000070', 'SYN-DIRECT', '2026-09-22', 'USD', 'POSTED',
       '10000000-0000-4000-8000-000000000010', '10000000-0000-4000-8000-000000000013', '2026-09-22T07:00:00Z');
    RAISE EXCEPTION 'direct POSTED insert unexpectedly succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'direct POSTED insert unexpectedly succeeded' THEN RAISE; END IF;
    IF position('assembled as draft' IN SQLERRM) = 0 THEN RAISE; END IF;
  END;
END;
$test$;

DO $test$
BEGIN
  BEGIN
    UPDATE abos.cash_receipts SET received_by_user_account_id='10000000-0000-4000-8000-000000000013'
     WHERE id='10000000-0000-4000-8000-000000000063';
    UPDATE abos.journals SET status='POSTED', posted_by_user_account_id='10000000-0000-4000-8000-000000000013',
     posted_at='2026-09-22T06:55:00Z' WHERE id='10000000-0000-4000-8000-000000000080';
    RAISE EXCEPTION 'post-approval SoD mutation unexpectedly succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'post-approval SoD mutation unexpectedly succeeded' THEN RAISE; END IF;
    IF position('must remain separate' IN SQLERRM) = 0 THEN RAISE; END IF;
  END;
END;
$test$;

DO $test$
BEGIN
  BEGIN
    UPDATE abos.posting_intents SET intent_kind='SHAREHOLDER_LOAN_RECEIPT'
     WHERE id='10000000-0000-4000-8000-000000000070';
    UPDATE abos.journals SET status='POSTED', posted_by_user_account_id='10000000-0000-4000-8000-000000000013',
     posted_at='2026-09-22T06:56:00Z' WHERE id='10000000-0000-4000-8000-000000000080';
    RAISE EXCEPTION 'agreement classification mismatch unexpectedly posted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'agreement classification mismatch unexpectedly posted' THEN RAISE; END IF;
    IF position('agreement classification' IN SQLERRM) = 0 THEN RAISE; END IF;
  END;
  BEGIN
    UPDATE abos.cash_locations SET status='INACTIVE' WHERE id='10000000-0000-4000-8000-000000000060';
    UPDATE abos.journals SET status='POSTED', posted_by_user_account_id='10000000-0000-4000-8000-000000000013',
     posted_at='2026-09-22T06:57:00Z' WHERE id='10000000-0000-4000-8000-000000000080';
    RAISE EXCEPTION 'inactive parent safe unexpectedly posted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'inactive parent safe unexpectedly posted' THEN RAISE; END IF;
    IF position('active cash currency account' IN SQLERRM) = 0 THEN RAISE; END IF;
  END;
  BEGIN
    DELETE FROM abos.business_party_roles
     WHERE business_party_id='10000000-0000-4000-8000-000000000020' AND role_code='SHAREHOLDER';
    UPDATE abos.journals SET status='POSTED', posted_by_user_account_id='10000000-0000-4000-8000-000000000013',
     posted_at='2026-09-22T06:58:00Z' WHERE id='10000000-0000-4000-8000-000000000080';
    RAISE EXCEPTION 'missing shareholder role unexpectedly posted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'missing shareholder role unexpectedly posted' THEN RAISE; END IF;
    IF position('SHAREHOLDER business-party role' IN SQLERRM) = 0 THEN RAISE; END IF;
  END;
END;
$test$;

DO $test$
BEGIN
  BEGIN
    UPDATE abos.ledger_accounts
       SET control_account_type='SHAREHOLDER_LOAN'
     WHERE id='10000000-0000-4000-8000-000000000041';
    UPDATE abos.journals SET status='POSTED', posted_by_user_account_id='10000000-0000-4000-8000-000000000013',
     posted_at='2026-09-22T06:59:00Z' WHERE id='10000000-0000-4000-8000-000000000080';
    RAISE EXCEPTION 'wrong shareholder control account unexpectedly posted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'wrong shareholder control account unexpectedly posted' THEN RAISE; END IF;
    IF position('mapped safe CASH debit and matching shareholder control credit' IN SQLERRM) = 0 THEN RAISE; END IF;
  END;
END;
$test$;

UPDATE abos.journals SET status='POSTED', posted_by_user_account_id='10000000-0000-4000-8000-000000000013',
 posted_at='2026-09-22T07:00:00Z' WHERE id='10000000-0000-4000-8000-000000000080';

DO $test$
BEGIN
  BEGIN
    UPDATE abos.cash_receipts SET amount=99 WHERE id='10000000-0000-4000-8000-000000000063';
    RAISE EXCEPTION 'posted provenance mutation unexpectedly succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'posted provenance mutation unexpectedly succeeded' THEN RAISE; END IF;
    IF position('provenance is immutable' IN SQLERRM) = 0 THEN RAISE; END IF;
  END;
  BEGIN
    UPDATE abos.journal_lines SET base_debit=99 WHERE id='10000000-0000-4000-8000-000000000081';
    RAISE EXCEPTION 'posted line mutation unexpectedly succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'posted line mutation unexpectedly succeeded' THEN RAISE; END IF;
    IF position('posted journal are immutable' IN SQLERRM) = 0 THEN RAISE; END IF;
  END;
  BEGIN
    UPDATE abos.cash_location_currency_accounts SET cash_location_id='10000000-0000-4000-8000-000000000060'
     WHERE id='10000000-0000-4000-8000-000000000061';
    RAISE EXCEPTION 'posted safe mapping mutation unexpectedly succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'posted safe mapping mutation unexpectedly succeeded' THEN RAISE; END IF;
    IF position('provenance is immutable' IN SQLERRM) = 0 THEN RAISE; END IF;
  END;
END;
$test$;

INSERT INTO abos.posting_intents
 (id, legal_entity_id, source_type, source_id, intent_kind, original_amount, original_currency_code, base_amount,
  base_currency_code, accounting_effective_date, correlation_id, idempotency_key, status, created_by_user_account_id) VALUES
 ('10000000-0000-4000-8000-000000000091', '10000000-0000-4000-8000-000000000002', 'REVERSAL',
  '10000000-0000-4000-8000-000000000080', 'REVERSAL', 100, 'USD', 100, 'USD', '2026-09-22',
  '10000000-0000-4000-8000-000000000092', 'syn-reverse', 'APPROVED', '10000000-0000-4000-8000-000000000012');
INSERT INTO abos.posting_approvals
 (id, legal_entity_id, posting_intent_id, decision, approver_user_account_id, evidence_reference_id, approved_at) VALUES
 ('10000000-0000-4000-8000-000000000093', '10000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000091',
  'APPROVED', '10000000-0000-4000-8000-000000000013', '10000000-0000-4000-8000-000000000104', '2026-09-22T07:05:00Z');
INSERT INTO abos.journals
 (id, legal_entity_id, accounting_period_id, posting_intent_id, journal_reference, accounting_effective_date,
  base_currency_code, status, created_by_user_account_id) VALUES
 ('10000000-0000-4000-8000-000000000094', '10000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000030',
  '10000000-0000-4000-8000-000000000091', 'SYN-REVERSAL', '2026-09-22', 'USD', 'DRAFT', '10000000-0000-4000-8000-000000000012');
INSERT INTO abos.journal_lines
 (id, journal_id, legal_entity_id, line_number, ledger_account_id, business_party_id, original_amount, original_currency_code,
  base_debit, base_credit, base_currency_code, source_type, source_id) VALUES
 ('10000000-0000-4000-8000-000000000095', '10000000-0000-4000-8000-000000000094', '10000000-0000-4000-8000-000000000002',
  1, '10000000-0000-4000-8000-000000000040', NULL, 100, 'USD', 0, 100, 'USD', 'REVERSAL', '10000000-0000-4000-8000-000000000080'),
 ('10000000-0000-4000-8000-000000000096', '10000000-0000-4000-8000-000000000094', '10000000-0000-4000-8000-000000000002',
  2, '10000000-0000-4000-8000-000000000041', '10000000-0000-4000-8000-000000000020', 100, 'USD', 100, 0, 'USD',
  'REVERSAL', '10000000-0000-4000-8000-000000000080');
INSERT INTO abos.subledger_entries
 (id, legal_entity_id, journal_line_id, subledger_type, business_party_id, cash_location_currency_account_id,
  original_amount, original_currency_code, base_amount, base_currency_code, source_type, source_id) VALUES
 ('10000000-0000-4000-8000-000000000097', '10000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000095',
  'CASH_LOCATION', NULL, '10000000-0000-4000-8000-000000000061', -100, 'USD', -100, 'USD', 'REVERSAL', '10000000-0000-4000-8000-000000000080'),
 ('10000000-0000-4000-8000-000000000098', '10000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000096',
  'SHAREHOLDER_CAPITAL', '10000000-0000-4000-8000-000000000020', NULL, 100, 'USD', 100, 'USD',
  'REVERSAL', '10000000-0000-4000-8000-000000000080');
UPDATE abos.journals SET status='POSTED', posted_by_user_account_id='10000000-0000-4000-8000-000000000013',
 posted_at='2026-09-22T07:10:00Z' WHERE id='10000000-0000-4000-8000-000000000094';
INSERT INTO abos.journal_reversal_links
 (original_journal_id, reversal_journal_id, reason, approved_by_user_account_id, evidence_reference_id) VALUES
 ('10000000-0000-4000-8000-000000000080', '10000000-0000-4000-8000-000000000094', 'Synthetic reversal test',
  '10000000-0000-4000-8000-000000000013', '10000000-0000-4000-8000-000000000105');
SET CONSTRAINTS posted_reversal_requires_link IMMEDIATE;

SELECT 'E0 finance database invariant behavior passed' AS result;
ROLLBACK;
