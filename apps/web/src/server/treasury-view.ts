import type { CashReceiptId } from "@abos/contracts";
import { receiptStage, type CapitalReceiptSource, type TreasuryReceipt } from "@abos/treasury";

import type {
  CashLocationView,
  EvidenceOption,
  ReceiptTraceView,
  ReceiptView,
  SourceView,
  TreasuryOverview
} from "@/lib/treasury-types";
import { displayNames, type TreasuryRequestContext } from "@/server/treasury";

/**
 * Builds the page's view model from persisted rows. It reads; it never writes and never derives a
 * figure the rows do not contain.
 */
export async function buildOverview(request: TreasuryRequestContext): Promise<TreasuryOverview> {
  const { reader, actor, runtime, context } = request;
  const entity = actor.legalEntityId;
  const canRead = actor.treasuryPermissions.includes("treasury.read");

  const locations = canRead ? await reader.listLocations(entity) : [];
  const accounts = canRead ? await reader.listAccounts(entity) : [];
  const sources = canRead ? await reader.listSources(entity) : [];
  const receipts = canRead ? await reader.listReceipts(entity) : [];

  const assignmentsByLocation = new Map<string, readonly { userAccountId: string }[]>();
  for (const location of locations) {
    assignmentsByLocation.set(location.id, (await reader.listAssignments(entity, location.id)).filter((item) => item.revokedAt === undefined));
  }
  const counts = new Map<string, { countedBy: string }>();
  for (const receipt of receipts) {
    if (receipt.physicalCashCountId !== undefined) {
      const count = await reader.findCount(entity, receipt.physicalCashCountId);
      if (count) counts.set(receipt.id, { countedBy: count.countedByUserAccountId });
    }
  }
  const openings = new Map<string, Awaited<ReturnType<typeof reader.findOpening>>>();
  for (const account of accounts) openings.set(account.id, await reader.findOpening(entity, account.id));

  const names = await displayNames(runtime, [
    ...receipts.flatMap((receipt) => [receipt.receivedByUserAccountId, receipt.verifiedByUserAccountId ?? ""]),
    ...[...counts.values()].map((count) => count.countedBy),
    ...[...assignmentsByLocation.values()].flatMap((items) => items.map((item) => item.userAccountId)),
    ...accounts.map((account) => account.activatedByUserAccountId ?? "")
  ]);
  const name = (id: string | undefined) => (id === undefined ? undefined : names.get(id) ?? "Unknown user");

  const locationName = new Map(locations.map((location) => [location.id, location.name]));
  const accountLabel = new Map(accounts.map((account) => [account.id, `${locationName.get(account.cashLocationId) ?? "Unknown safe"} · ${account.currency}`]));
  const sourcesById = new Map(sources.map((source) => [source.id, source]));

  const locationViews: CashLocationView[] = locations.map((location) => ({
    id: location.id,
    name: location.name,
    kind: location.kind,
    status: location.status,
    accounts: accounts.filter((account) => account.cashLocationId === location.id).map((account) => {
      const opening = openings.get(account.id);
      return {
        id: account.id,
        currency: account.currency,
        status: account.status,
        openingStatus: opening === undefined ? "NOT_RECONCILED" : opening.status,
        ...(opening === undefined ? {} : { openingCountedAmount: opening.openingCountedAmount }),
        ...(account.activatedByUserAccountId === undefined ? {} : { activatedBy: name(account.activatedByUserAccountId) ?? "" }),
        ...(account.activatedAt === undefined ? {} : { activatedAt: account.activatedAt })
      };
    }),
    cashiers: (assignmentsByLocation.get(location.id) ?? []).map((item) => ({ userAccountId: item.userAccountId, displayName: name(item.userAccountId) ?? "" }))
  }));

  const liveBySource = new Set(receipts.filter((receipt) => receipt.status !== "VOIDED").map((receipt) => receipt.capitalReceiptIntentId));
  const sourceViews: SourceView[] = sources.map((source) => sourceView(source, accountLabel, liveBySource.has(source.id)));

  const receiptViews: ReceiptView[] = [];
  for (const receipt of receipts) {
    const source = sourcesById.get(receipt.capitalReceiptIntentId);
    const handoff = await reader.findHandoff(entity, receipt.id as CashReceiptId);
    const posted = source?.status === "POSTED" ? source.journalId : undefined;
    const finance = handoff === undefined ? undefined : await reader.findFinanceProgress(entity, receipt.id as CashReceiptId);
    receiptViews.push(receiptView(receipt, source, receiptStage(receipt, handoff, posted, finance?.decision ?? "NONE"), accountLabel, name, counts.get(receipt.id)?.countedBy));
  }

  const evidence = await runtime.executor.query<{ readonly id: string; readonly evidence_kind: string; readonly document_id: string; readonly sha256: string }>(
    `SELECT id, evidence_kind, document_id, sha256 FROM abos.evidence_references
      WHERE legal_entity_id = $1 AND evidence_kind IN ('CASH_RECEIPT', 'PHYSICAL_CASH_COUNT')
      ORDER BY evidence_kind, created_at`, [entity]);
  const option = (row: { id: string; evidence_kind: string; document_id: string; sha256: string }): EvidenceOption => ({
    id: row.id, kind: row.evidence_kind,
    label: `${row.evidence_kind.replaceAll("_", " ").toLowerCase()} · doc ${row.document_id.slice(0, 8)} · sha ${row.sha256.slice(0, 10)}`
  });

  return {
    actor: {
      userAccountId: actor.userAccountId,
      displayName: request.displayName,
      treasuryPermissions: actor.treasuryPermissions,
      sessionExpiresAt: context.expiresAt ?? ""
    },
    locations: locationViews,
    sources: sourceViews,
    receipts: receiptViews,
    evidence: {
      cashReceipt: evidence.rows.filter((row) => row.evidence_kind === "CASH_RECEIPT").map(option),
      physicalCount: evidence.rows.filter((row) => row.evidence_kind === "PHYSICAL_CASH_COUNT").map(option)
    }
  };
}

export async function buildTrace(request: TreasuryRequestContext, receiptId: string): Promise<ReceiptTraceView> {
  const { service, actor, runtime, reader } = request;
  const trace = await service.trace(actor, receiptId as CashReceiptId);
  const accounts = await reader.listAccounts(actor.legalEntityId);
  const locations = await reader.listLocations(actor.legalEntityId);
  const locationName = new Map(locations.map((location) => [location.id, location.name]));
  const accountLabel = new Map(accounts.map((account) => [account.id, `${locationName.get(account.cashLocationId) ?? "Unknown safe"} · ${account.currency}`]));
  const names = await displayNames(runtime, [
    trace.receipt.receivedByUserAccountId, trace.receipt.verifiedByUserAccountId ?? "",
    trace.count?.countedByUserAccountId ?? "", trace.count?.confirmedByUserAccountId ?? "",
    trace.handoff?.handedOffByUserAccountId ?? ""
  ]);
  const name = (id: string | undefined) => (id === undefined ? undefined : names.get(id) ?? "Unknown user");
  const evidenceIds = [trace.receipt.evidenceReferenceId, trace.count?.evidenceReferenceId].filter((id): id is string => id !== undefined);
  const evidence = await runtime.executor.query<{ readonly id: string; readonly evidence_kind: string; readonly document_id: string; readonly sha256: string }>(
    "SELECT id, evidence_kind, document_id, sha256 FROM abos.evidence_references WHERE id = ANY($1::uuid[])", [evidenceIds]);
  const label = (id: string | undefined) => {
    const row = evidence.rows.find((item) => item.id === id);
    return row === undefined ? undefined : `${row.evidence_kind} · document ${row.document_id} · sha256 ${row.sha256}`;
  };
  const stage = receiptStage(trace.receipt, trace.handoff, trace.postedJournalId, trace.finance.decision);
  const financeNames = await displayNames(runtime, [trace.finance.decidedByUserAccountId ?? ""]);
  const receiptLabel = label(trace.receipt.evidenceReferenceId);

  return {
    receipt: receiptView(trace.receipt, trace.source, stage, accountLabel, name, trace.count?.countedByUserAccountId),
    source: {
      id: trace.source.id,
      status: trace.source.status,
      shareholder: trace.source.shareholderDisplayName,
      shareholderBusinessPartyId: trace.source.shareholderBusinessPartyId,
      agreementId: trace.source.capitalAgreementId,
      agreementReference: trace.source.agreementReference,
      installmentId: trace.source.capitalInstallmentId,
      installmentSequence: trace.source.installmentSequence,
      amount: trace.source.amount.amount,
      currency: trace.source.amount.currency
    },
    ...(trace.count === undefined ? {} : {
      count: {
        id: trace.count.id,
        countedAmount: trace.count.countedAmount,
        countedBy: name(trace.count.countedByUserAccountId) ?? "",
        countedAt: trace.count.countedAt,
        status: trace.count.status,
        ...(trace.count.confirmedByUserAccountId === undefined ? {} : { confirmedBy: name(trace.count.confirmedByUserAccountId) ?? "" }),
        ...(trace.count.confirmedAt === undefined ? {} : { confirmedAt: trace.count.confirmedAt }),
        evidenceLabel: label(trace.count.evidenceReferenceId) ?? "Evidence reference missing"
      }
    }),
    ...(receiptLabel === undefined ? {} : { receiptEvidenceLabel: receiptLabel }),
    ...(trace.handoff === undefined ? {} : {
      handoff: { id: trace.handoff.id, handedOffBy: name(trace.handoff.handedOffByUserAccountId) ?? "", handedOffAt: trace.handoff.handedOffAt }
    }),
    finance: {
      ...(trace.finance.postingIntentStatus === undefined ? {} : { postingIntentStatus: trace.finance.postingIntentStatus }),
      decision: trace.finance.decision,
      ...(trace.finance.decidedByUserAccountId === undefined ? {} : { decidedBy: financeNames.get(trace.finance.decidedByUserAccountId) ?? "Unknown user" }),
      ...(trace.finance.decidedAt === undefined ? {} : { decidedAt: trace.finance.decidedAt })
    },
    ...(trace.postedJournalId === undefined ? {} : { postedJournalId: trace.postedJournalId }),
    events: trace.events.map((event) => ({
      id: event.id,
      aggregate: event.aggregateType,
      operation: event.operation,
      ...(event.fromStatus === undefined ? {} : { fromStatus: event.fromStatus }),
      // A receipt that stays COUNTED but gains its submission timestamp was submitted for
      // verification; say so, rather than showing an unexplained COUNTED -> COUNTED.
      ...(event.toStatus === undefined ? {} : {
        toStatus: event.aggregateType === "CASH_RECEIPT" && event.fromStatus === "COUNTED" && event.toStatus === "COUNTED"
          ? "SUBMITTED FOR VERIFICATION" : event.toStatus
      }),
      actor: event.actorDisplayName,
      occurredAt: event.occurredAt
    }))
  };
}

function sourceView(source: CapitalReceiptSource, accountLabel: Map<string, string>, hasLiveReceipt: boolean): SourceView {
  return {
    id: source.id,
    shareholder: source.shareholderDisplayName,
    agreementReference: source.agreementReference,
    installmentSequence: source.installmentSequence,
    amount: source.amount.amount,
    currency: source.amount.currency,
    destinationAccountId: source.destinationCashAccountId,
    destinationLabel: accountLabel.get(source.destinationCashAccountId) ?? "Unknown account",
    status: source.status,
    hasLiveReceipt
  };
}

function receiptView(
  receipt: TreasuryReceipt,
  source: CapitalReceiptSource | undefined,
  stage: ReceiptView["stage"],
  accountLabel: Map<string, string>,
  name: (id: string | undefined) => string | undefined,
  countedBy: string | undefined
): ReceiptView {
  return {
    id: receipt.id,
    reference: receipt.receiptReference,
    sourceId: receipt.capitalReceiptIntentId,
    shareholder: source?.shareholderDisplayName ?? "Unknown shareholder",
    agreementReference: source?.agreementReference ?? "",
    installmentSequence: source?.installmentSequence ?? 0,
    amount: receipt.amount.amount,
    currency: receipt.amount.currency,
    destinationLabel: accountLabel.get(receipt.cashAccountId) ?? "Unknown account",
    stage,
    receivedBy: name(receipt.receivedByUserAccountId) ?? "",
    receivedByUserAccountId: receipt.receivedByUserAccountId,
    ...(countedBy === undefined ? {} : { countedBy: name(countedBy) ?? "", countedByUserAccountId: countedBy }),
    ...(receipt.verifiedByUserAccountId === undefined ? {} : { verifiedBy: name(receipt.verifiedByUserAccountId) ?? "" }),
    ...(receipt.voidReason === undefined ? {} : { voidReason: receipt.voidReason })
  };
}
