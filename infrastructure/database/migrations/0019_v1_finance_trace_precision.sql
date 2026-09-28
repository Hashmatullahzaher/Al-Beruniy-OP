-- V1 Finance handoff trace: preserve exact decimal text and resolve recorded actors.
-- The function keeps its existing OID, owner, EXECUTE ACL and session authorization.
CREATE OR REPLACE FUNCTION abos.finance_handoff_trace(
  p_bearer_token text,
  p_handoff_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $trace$
DECLARE
  entity_id uuid;
  result jsonb;
BEGIN
  PERFORM abos.finance_runtime_authorize(p_bearer_token, 'finance.report.operational.read');
  entity_id := pg_catalog.current_setting('abos.finance_legal_entity_id')::uuid;

  SELECT pg_catalog.jsonb_build_object(
      'handoff', pg_catalog.to_jsonb(h) || pg_catalog.jsonb_build_object(
        'handed_off_by_display_name', handoff_actor.display_name),
      'source', pg_catalog.jsonb_set(pg_catalog.to_jsonb(source_row), '{amount}',
        pg_catalog.to_jsonb(source_row.amount::text)),
      'shareholder', pg_catalog.jsonb_build_object(
        'businessPartyId', party.id, 'displayName', party.display_name),
      'agreement', pg_catalog.jsonb_build_object(
        'id', agreement.id, 'reference', agreement.agreement_reference,
        'kind', agreement.agreement_kind, 'status', agreement.status),
      'installment', pg_catalog.jsonb_build_object(
        'id', installment.id, 'sequenceNumber', installment.sequence_number,
        'expectedAmount', installment.expected_amount::text,
        'currency', installment.currency_code, 'dueOn', installment.due_on),
      'receipt', pg_catalog.jsonb_set(pg_catalog.to_jsonb(receipt), '{amount}',
        pg_catalog.to_jsonb(receipt.amount::text)) || pg_catalog.jsonb_build_object(
        'verifier_display_name', verifier.display_name),
      'safe', pg_catalog.jsonb_build_object(
        'locationId', location.id, 'name', location.location_name,
        'accountId', account.id, 'currency', account.currency_code,
        'activationStatus', account.activation_status),
      'physicalCount', pg_catalog.jsonb_set(pg_catalog.to_jsonb(count_row), '{counted_amount}',
        pg_catalog.to_jsonb(count_row.counted_amount::text)) || pg_catalog.jsonb_build_object(
        'counted_by_display_name', counter.display_name,
        'confirmed_by_display_name', confirmer.display_name),
      'evidence', pg_catalog.jsonb_build_object(
        'agreement', agreement_evidence.evidence_reference_id,
        'count', count_row.evidence_reference_id,
        'receipt', receipt.evidence_reference_id,
        'approval', approval.evidence_reference_id),
      'postingIntent', CASE WHEN posting.id IS NULL THEN NULL ELSE
        pg_catalog.jsonb_set(
          pg_catalog.jsonb_set(pg_catalog.to_jsonb(posting), '{original_amount}',
            pg_catalog.to_jsonb(posting.original_amount::text)), '{base_amount}',
          coalesce(pg_catalog.to_jsonb(posting.base_amount::text), 'null'::jsonb)) || pg_catalog.jsonb_build_object(
          'created_by_display_name', preparer.display_name) END,
      'approval', CASE WHEN approval.id IS NULL THEN NULL ELSE
        pg_catalog.to_jsonb(approval) || pg_catalog.jsonb_build_object(
          'approver_display_name', approver.display_name) END,
      'journal', pg_catalog.to_jsonb(journal),
      'reconciliation', pg_catalog.jsonb_build_object(
        'debits', coalesce(totals.debits, 0)::text,
        'credits', coalesce(totals.credits, 0)::text,
        'balanced', coalesce(totals.debits, 0) = coalesce(totals.credits, 0),
        'subledgerEntries', coalesce(totals.subledgers, 0))
    )
    INTO result
    FROM abos.treasury_finance_handoffs h
    JOIN abos.capital_receipt_intents source_row
      ON source_row.id = h.capital_receipt_intent_id AND source_row.legal_entity_id = h.legal_entity_id
    JOIN abos.business_parties party
      ON party.id = source_row.shareholder_business_party_id AND party.legal_entity_id = h.legal_entity_id
    JOIN abos.capital_agreements agreement
      ON agreement.id = source_row.capital_agreement_id AND agreement.legal_entity_id = h.legal_entity_id
    JOIN abos.capital_installments installment
      ON installment.id = source_row.capital_installment_id AND installment.legal_entity_id = h.legal_entity_id
    JOIN abos.cash_receipts receipt
      ON receipt.id = h.cash_receipt_id AND receipt.legal_entity_id = h.legal_entity_id
    JOIN abos.cash_location_currency_accounts account
      ON account.id = receipt.cash_location_currency_account_id AND account.legal_entity_id = h.legal_entity_id
    JOIN abos.cash_locations location
      ON location.id = account.cash_location_id AND location.legal_entity_id = h.legal_entity_id
    JOIN abos.physical_cash_counts count_row
      ON count_row.id = receipt.physical_cash_count_id AND count_row.legal_entity_id = h.legal_entity_id
    LEFT JOIN abos.registration_evidence agreement_evidence
      ON agreement_evidence.capital_agreement_id = agreement.id
     AND agreement_evidence.legal_entity_id = h.legal_entity_id
     AND agreement_evidence.status = 'VERIFIED'
    LEFT JOIN abos.posting_intents posting
      ON posting.capital_receipt_intent_id = source_row.id AND posting.legal_entity_id = h.legal_entity_id
    LEFT JOIN abos.posting_approvals approval
      ON approval.posting_intent_id = posting.id AND approval.legal_entity_id = h.legal_entity_id
    LEFT JOIN abos.journals journal
      ON journal.posting_intent_id = posting.id AND journal.legal_entity_id = h.legal_entity_id
    LEFT JOIN abos.user_accounts handoff_actor ON handoff_actor.id = h.handed_off_by_user_account_id
    LEFT JOIN abos.user_accounts verifier ON verifier.id = receipt.verified_by_user_account_id
    LEFT JOIN abos.user_accounts counter ON counter.id = count_row.counted_by_user_account_id
    LEFT JOIN abos.user_accounts confirmer ON confirmer.id = count_row.confirmed_by_user_account_id
    LEFT JOIN abos.user_accounts preparer ON preparer.id = posting.created_by_user_account_id
    LEFT JOIN abos.user_accounts approver ON approver.id = approval.approver_user_account_id
    LEFT JOIN LATERAL (
      SELECT pg_catalog.sum(lines.base_debit) AS debits,
             pg_catalog.sum(lines.base_credit) AS credits,
             (SELECT pg_catalog.count(*) FROM abos.subledger_entries subledger
               WHERE subledger.legal_entity_id = h.legal_entity_id
                 AND subledger.journal_line_id IN (
                   SELECT line_id.id FROM abos.journal_lines line_id
                    WHERE line_id.journal_id = journal.id
                      AND line_id.legal_entity_id = h.legal_entity_id)) AS subledgers
        FROM abos.journal_lines lines
       WHERE lines.journal_id = journal.id AND lines.legal_entity_id = h.legal_entity_id
    ) totals ON true
   WHERE h.id = p_handoff_id AND h.legal_entity_id = entity_id;

  IF result IS NULL THEN
    RAISE EXCEPTION 'Finance handoff is not available in the current legal entity'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN result;
END
$trace$;

-- The preexisting Finance owner and role grants survive CREATE OR REPLACE.
ALTER FUNCTION abos.finance_handoff_trace(text, uuid) OWNER TO abos_e1_finance_owner;
REVOKE ALL ON FUNCTION abos.finance_handoff_trace(text, uuid) FROM PUBLIC;
