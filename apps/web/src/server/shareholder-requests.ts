import { randomUUID } from "node:crypto";

import { financeHandoffRuntime, financeToken } from "@/server/finance-handoff";

/**
 * Shareholder capital requests through the restricted runtime login only (migration 0016). The
 * database applies the shareholder rules, the funding decision, the commitment ceiling and, for AFN,
 * the rate snapshot. Amounts cross the API as decimal strings and are never summed across currencies.
 */

export type CapitalRequestBlocker =
  | "HAS_REQUEST" | "INSTALLMENT_CLOSED" | "LOAN_AGREEMENT" | "SHAREHOLDER_NOT_ACTIVE" | "AGREEMENT_NOT_FUNDABLE"
  | "REGISTRATION_NOT_VERIFIED" | "COMMITMENT_USED" | "NO_ACTIVE_ACCOUNT";

export interface RateSnapshotView {
  readonly id: string; readonly rateDate: string; readonly source: "MARKET" | "SARAF"; readonly sarafName: string | null;
  readonly unitCurrency: string; readonly quoteCurrency: string; readonly rate: string; readonly capturedAt: string;
}

export interface CapitalRequestView {
  readonly id: string; readonly status: string; readonly amount: string; readonly currency: string; readonly businessDate: string;
  readonly createdAt: string; readonly createdBy: string; readonly destination: string; readonly snapshot: RateSnapshotView | null;
}

export interface InstallmentView {
  readonly id: string; readonly sequence: number; readonly expectedAmount: string; readonly currency: string;
  readonly dueOn: string | null; readonly status: string; readonly request: CapitalRequestView | null;
  readonly blockers: readonly CapitalRequestBlocker[];
}

export interface AgreementView {
  readonly id: string; readonly reference: string; readonly shareholder: string; readonly shareholderStatus: string;
  readonly kind: string; readonly currency: string; readonly committedAmount: string; readonly consumedAmount: string;
  readonly remainingAmount: string; readonly status: string; readonly partialAllowed: boolean; readonly fundable: boolean;
  readonly registrationVerified: boolean; readonly installments: readonly InstallmentView[];
}

export interface ShareholderWorkspaceView {
  readonly canCreate: boolean;
  readonly today: string;
  readonly legalEntity: { readonly id: string; readonly name: string; readonly baseCurrency: string | null };
  readonly fundingPolicy: { readonly decisionReference: string; readonly decidedBy: string; readonly fundableStatuses: readonly string[] } | null;
  readonly agreements: readonly AgreementView[];
  readonly totalsByCurrency: readonly { readonly currency: string; readonly committed: string; readonly requested: string; readonly agreements: number }[];
  readonly destinationAccounts: readonly { readonly id: string; readonly safe: string; readonly currency: string; readonly status: string; readonly safeStatus: string; readonly usable: boolean }[];
  readonly currentRates: readonly { readonly id: string; readonly rateDate: string; readonly source: "MARKET" | "SARAF"; readonly sarafName: string | null; readonly unitCurrency: string; readonly quoteCurrency: string; readonly rate: string }[];
}

export async function shareholderWorkspace(): Promise<ShareholderWorkspaceView> {
  const token = await financeToken();
  const result = await financeHandoffRuntime().executor.query<{ value: ShareholderWorkspaceView }>(
    "SELECT abos.shareholder_capital_workspace($1) AS value", [token]);
  const value = result.rows[0]?.value;
  if (value === undefined) throw new Error("The shareholder function returned no result.");
  return value;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Malformed identifiers reach the database as NULL, so authorization is always checked first. */
const uuidOrNull = (value: string | null) => (value !== null && UUID.test(value) ? value : null);

export async function createCapitalRequest(input: {
  readonly installmentId: string; readonly destinationAccountId: string; readonly amount: string; readonly businessDate: string;
  readonly exchangeRateId: string | null; readonly idempotencyKey: string | null;
}): Promise<{ readonly id: string; readonly replayed: boolean; readonly snapshotId: string | null }> {
  const token = await financeToken();
  const result = await financeHandoffRuntime().executor.query<{ value: { id: string; replayed: boolean; snapshotId: string | null } }>(
    "SELECT abos.shareholder_create_capital_request($1, $2::uuid, $3::uuid, $4, $5::date, $6::uuid, $7) AS value",
    [token, uuidOrNull(input.installmentId), uuidOrNull(input.destinationAccountId), input.amount,
      DATE.test(input.businessDate) ? input.businessDate : null, uuidOrNull(input.exchangeRateId),
      input.idempotencyKey ?? randomUUID()]);
  const value = result.rows[0]?.value;
  if (value === undefined) throw new Error("The shareholder function returned no result.");
  return value;
}
