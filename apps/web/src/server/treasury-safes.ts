import type { CashLocationCurrencyAccountId, CashLocationId, SupportedCurrency } from "@abos/contracts";
import { RestrictedTreasurySafesRepository } from "@abos/persistence";
import { holdsPermission, TreasurySafesService } from "@abos/treasury";
import { cookies } from "next/headers";

import { currentTreasury, SESSION_COOKIE, type TreasuryRequestContext } from "@/server/treasury";

/**
 * WP-B server layer: safes created and activated in the app, Saraf accounts and whole-safe counts.
 * Every write goes through the Treasury domain services and the restricted database entry points
 * (0008 for safes and their accounts, 0015 for Saraf accounts and whole-safe counts). The view is
 * read from persisted rows; it never computes a figure the database did not return.
 */

export interface SafesRequestContext extends TreasuryRequestContext {
  readonly safes: TreasurySafesService;
  readonly safesReader: RestrictedTreasurySafesRepository;
}

export async function currentSafes(): Promise<SafesRequestContext> {
  const treasury = await currentTreasury();
  const token = (await cookies()).get(SESSION_COOKIE)?.value ?? "";
  const safesReader = new RestrictedTreasurySafesRepository(treasury.runtime.gateway, { bearerToken: token, legalEntityId: treasury.actor.legalEntityId });
  return { ...treasury, safesReader, safes: new TreasurySafesService(safesReader, treasury.reader) };
}

export type Currency = SupportedCurrency;

export interface LedgerChoiceView {
  readonly id: string;
  readonly label: string;
  readonly currency: Currency;
}

export interface PersonView {
  readonly userAccountId: string;
  readonly displayName: string;
}

export interface SafeAccountView {
  readonly id: string;
  readonly currency: Currency;
  readonly status: "DRAFT" | "RECONCILED" | "APPROVED" | "ACTIVE" | "BLOCKED";
  readonly ledgerLabel: string;
  /** The latest opening count of a DRAFT account, if one was recorded. */
  readonly openingCount?: {
    readonly id: string;
    readonly amount: string;
    readonly status: string;
    readonly countedBy: string;
    readonly countedByUserAccountId: string;
    readonly confirmedBy?: string;
  };
  readonly opening?: {
    readonly status: "RECONCILED" | "APPROVED";
    readonly amount: string;
    readonly countedByUserAccountId: string;
    readonly reconciledBy: string;
    readonly reconciledByUserAccountId: string;
    readonly approvedBy?: string;
  };
  readonly activatedBy?: string;
}

export interface SafeView {
  readonly id: string;
  readonly name: string;
  readonly status: "DRAFT" | "ACTIVE" | "INACTIVE";
  readonly responsibleCashier: string;
  readonly cashiers: readonly PersonView[];
  readonly accounts: readonly SafeAccountView[];
}

export interface SarafAccountView {
  readonly id: string;
  readonly partyName: string;
  readonly currency: Currency;
  readonly ledgerLabel: string;
  readonly status: "DRAFT" | "ACTIVE" | "INACTIVE";
  readonly createdBy: string;
  readonly createdByUserAccountId: string;
  readonly createdAt: string;
  readonly activatedBy?: string;
  readonly activatedAt?: string;
}

export interface SafeCountView {
  readonly id: string;
  readonly accountId: string;
  readonly accountLabel: string;
  readonly currency: Currency;
  readonly countedAmount: string;
  readonly countedAt: string;
  readonly countedBy: string;
  readonly countedByUserAccountId: string;
  readonly note?: string;
  readonly openingAmount: string;
  readonly verifiedReceiptsAmount: string;
  readonly verifiedReceiptCount: number;
  readonly unverifiedReceiptCount: number;
  readonly custodyTotal: string;
  readonly difference: string;
  readonly status: "RECORDED" | "CONFIRMED";
  readonly confirmedBy?: string;
  readonly confirmedAt?: string;
  readonly evidenceLabel: string;
}

export interface EvidenceOptionView {
  readonly id: string;
  readonly label: string;
}

export interface SafesWorkspaceView {
  readonly me: string;
  readonly can: {
    readonly manageSafes: boolean;
    readonly count: boolean;
    readonly reconcile: boolean;
    readonly approve: boolean;
    readonly manageSaraf: boolean;
  };
  readonly locations: readonly SafeView[];
  readonly cashLedgers: readonly LedgerChoiceView[];
  readonly sarafLedgers: readonly LedgerChoiceView[];
  readonly sarafParties: readonly { readonly id: string; readonly label: string }[];
  readonly sarafAccounts: readonly SarafAccountView[];
  readonly safeCounts: readonly SafeCountView[];
  /** Unused evidence provisioned for safes, by kind. */
  readonly evidence: {
    readonly count: readonly EvidenceOptionView[];
    readonly reconciliation: readonly EvidenceOptionView[];
  };
  /** People a safe can be given to as responsible cashier (Treasury managers only). */
  readonly people: readonly PersonView[];
}

export async function buildSafesView(request: SafesRequestContext): Promise<SafesWorkspaceView> {
  const { reader, safesReader, actor } = request;
  const entity = actor.legalEntityId;
  const can = {
    manageSafes: holdsPermission(actor, "treasury.cash-location.manage"),
    count: holdsPermission(actor, "treasury.cash-count.record"),
    reconcile: holdsPermission(actor, "treasury.cash-account.reconcile"),
    approve: holdsPermission(actor, "treasury.cash-account.approve"),
    manageSaraf: holdsPermission(actor, "treasury.saraf-account.manage")
  };
  const empty: SafesWorkspaceView = {
    me: actor.userAccountId, can, locations: [], cashLedgers: [], sarafLedgers: [], sarafParties: [], sarafAccounts: [],
    safeCounts: [], evidence: { count: [], reconciliation: [] }, people: []
  };
  if (!holdsPermission(actor, "treasury.read")) return empty;

  const [locations, accounts, counts, cashLedgers, sarafLedgers, parties, sarafAccounts, safeCounts, evidence, users] = await Promise.all([
    reader.listLocations(entity), reader.listAccounts(entity), safesReader.listPhysicalCounts(entity),
    safesReader.listCashLedgerChoices(entity), safesReader.listSarafLedgerChoices(entity), safesReader.listSarafParties(entity),
    safesReader.listSarafAccounts(entity), safesReader.listSafeCounts(entity), safesReader.listCountEvidence(entity),
    reader.listUsers(entity)
  ]);
  const names = new Map(users.map((row) => [String(row.id), String(row.display_name)]));
  const name = (id: string | undefined) => (id === undefined ? undefined : names.get(id) ?? "Unknown user");
  const ledgerLabel = new Map([...cashLedgers, ...sarafLedgers].map((choice) => [choice.id, `${choice.accountCode} · ${choice.accountName}`]));
  const locationName = new Map(locations.map((location) => [location.id, location.name]));

  const locationViews: SafeView[] = [];
  for (const location of locations) {
    const assignments = (await reader.listAssignments(entity, location.id)).filter((item) => item.revokedAt === undefined);
    const accountViews: SafeAccountView[] = [];
    for (const account of accounts.filter((item) => item.cashLocationId === location.id)) {
      const opening = await reader.findOpening(entity, account.id);
      const openingCounts = counts.filter((count) => count.cashAccountId === account.id && count.purpose === "OPENING" && count.status !== "VOIDED")
        .sort((a, b) => b.countedAt.localeCompare(a.countedAt));
      const latest = openingCounts[0];
      const openingCount = opening === undefined ? latest : counts.find((count) => count.id === opening.physicalCashCountId);
      accountViews.push({
        id: account.id, currency: account.currency, status: account.status,
        ledgerLabel: ledgerLabel.get(account.ledgerAccountId) ?? `${account.ledgerAccountId.slice(0, 8)} · not an active CASH account`,
        ...(opening === undefined && latest !== undefined ? {
          openingCount: {
            id: latest.id, amount: latest.countedAmount, status: latest.status,
            countedBy: name(latest.countedByUserAccountId) ?? "", countedByUserAccountId: latest.countedByUserAccountId,
            ...(latest.confirmedByUserAccountId === undefined ? {} : { confirmedBy: name(latest.confirmedByUserAccountId) ?? "" })
          }
        } : {}),
        ...(opening === undefined ? {} : {
          opening: {
            status: opening.status, amount: opening.openingCountedAmount,
            countedByUserAccountId: openingCount?.countedByUserAccountId ?? "",
            reconciledBy: name(opening.reconciledByUserAccountId) ?? "", reconciledByUserAccountId: opening.reconciledByUserAccountId,
            ...(opening.approvedByUserAccountId === undefined ? {} : { approvedBy: name(opening.approvedByUserAccountId) ?? "" })
          }
        }),
        ...(account.activatedByUserAccountId === undefined ? {} : { activatedBy: name(account.activatedByUserAccountId) ?? "" })
      });
    }
    locationViews.push({
      id: location.id, name: location.name, status: location.status,
      responsibleCashier: name(location.responsibleCashierUserAccountId) ?? "",
      cashiers: assignments.map((item) => ({ userAccountId: item.userAccountId, displayName: name(item.userAccountId) ?? "" })),
      accounts: accountViews
    });
  }

  const accountLabel = new Map(accounts.map((account) => [account.id, `${locationName.get(account.cashLocationId) ?? "Unknown safe"} · ${account.currency}`]));
  const evidenceLabel = (id: string) => {
    const row = evidence.find((item) => item.id === id);
    return row === undefined ? "Evidence reference" : `document ${row.documentId.slice(0, 8)} · sha ${row.sha256.slice(0, 10)}`;
  };
  const option = (row: (typeof evidence)[number]): EvidenceOptionView => ({
    id: row.id, label: `${row.kind === "PHYSICAL_CASH_COUNT" ? "Count sheet" : "Reconciliation"} · doc ${row.documentId.slice(0, 8)} · sha ${row.sha256.slice(0, 10)}`
  });

  return {
    me: actor.userAccountId,
    can,
    locations: locationViews,
    cashLedgers: cashLedgers.map((choice) => ({ id: choice.id, label: `${choice.accountCode} · ${choice.accountName}`, currency: choice.currency })),
    sarafLedgers: sarafLedgers.map((choice) => ({ id: choice.id, label: `${choice.accountCode} · ${choice.accountName}`, currency: choice.currency })),
    sarafParties: parties.map((party) => ({ id: party.id, label: party.externalReference ? `${party.displayName} · ${party.externalReference}` : party.displayName })),
    sarafAccounts: sarafAccounts.map((account) => ({
      id: account.id, partyName: account.partyName, currency: account.currency,
      ledgerLabel: `${account.ledgerAccountCode} · ${account.ledgerAccountName}`, status: account.status,
      createdBy: account.createdByName, createdByUserAccountId: account.createdByUserAccountId, createdAt: account.createdAt,
      ...(account.activatedByName === undefined ? {} : { activatedBy: account.activatedByName }),
      ...(account.activatedAt === undefined ? {} : { activatedAt: account.activatedAt })
    })),
    safeCounts: safeCounts.map((count) => ({
      id: count.id, accountId: count.cashAccountId, accountLabel: accountLabel.get(count.cashAccountId) ?? "Unknown account",
      currency: count.currency, countedAmount: count.countedAmount, countedAt: count.countedAt, countedBy: count.countedByName,
      countedByUserAccountId: count.countedByUserAccountId, ...(count.note === undefined ? {} : { note: count.note }),
      openingAmount: count.openingAmount, verifiedReceiptsAmount: count.verifiedReceiptsAmount,
      verifiedReceiptCount: count.verifiedReceiptCount, unverifiedReceiptCount: count.unverifiedReceiptCount,
      custodyTotal: count.custodyTotal, difference: count.difference, status: count.status,
      ...(count.confirmedByName === undefined ? {} : { confirmedBy: count.confirmedByName }),
      ...(count.confirmedAt === undefined ? {} : { confirmedAt: count.confirmedAt }),
      evidenceLabel: evidenceLabel(count.evidenceReferenceId)
    })),
    evidence: {
      count: evidence.filter((row) => !row.used && row.kind === "PHYSICAL_CASH_COUNT").map(option),
      reconciliation: evidence.filter((row) => !row.used && row.kind === "OPENING_RECONCILIATION").map(option)
    },
    people: can.manageSafes
      ? users.filter((row) => String(row.id) !== actor.userAccountId).map((row) => ({ userAccountId: String(row.id), displayName: String(row.display_name) }))
      : []
  };
}

export function asLocationId(value: string): CashLocationId { return value as CashLocationId; }
export function asAccountId(value: string): CashLocationCurrencyAccountId { return value as CashLocationCurrencyAccountId; }
export function asCurrency(value: string): Currency | undefined { return value === "USD" || value === "AFN" ? value : undefined; }
