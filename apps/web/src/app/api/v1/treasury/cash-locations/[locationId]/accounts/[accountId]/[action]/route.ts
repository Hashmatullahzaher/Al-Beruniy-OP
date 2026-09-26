import type { PhysicalCashCountId } from "@abos/contracts";
import { TreasuryDomainError } from "@abos/treasury";

import { assertMutation } from "@/server/identity";
import { errorResponse, json, readJson, stringField } from "@/server/treasury";
import { asAccountId, currentSafes } from "@/server/treasury-safes";

export const dynamic = "force-dynamic";

type Context = { readonly params: Promise<{ readonly locationId: string; readonly accountId: string; readonly action: string }> };

/**
 * The opening lifecycle of one currency account inside a safe, on the existing Treasury service and
 * 0008 commands: count -> independent confirmation -> reconciliation -> independent approval ->
 * activation, and blocking. The 0006 triggers enforce the same segregation of duties again.
 */
export async function POST(request: Request, { params }: Context) {
  try {
    assertMutation(request);
    const { locationId, accountId, action } = await params;
    const body = await readJson(request);
    const { service, safes, actor, reader } = await currentSafes();
    const id = asAccountId(accountId);
    const account = await reader.findAccount(actor.legalEntityId, id);
    if (account === undefined || account.cashLocationId !== locationId) {
      throw new TreasuryDomainError("NOT_FOUND", "This account does not belong to this safe.");
    }
    switch (action) {
      case "opening-count": {
        const evidenceReferenceId = stringField(body, "evidenceReferenceId");
        await safes.assertUnusedEvidence(actor, evidenceReferenceId, "PHYSICAL_CASH_COUNT");
        const countId = await service.recordOpeningCount(actor, { cashAccountId: id, countedAmount: stringField(body, "countedAmount").trim(), evidenceReferenceId });
        return json({ ok: true, data: { physicalCashCountId: countId } }, 201);
      }
      case "confirm-opening-count":
        await service.confirmOpeningCount(actor, stringField(body, "physicalCashCountId") as PhysicalCashCountId);
        break;
      case "reconcile": {
        const evidenceReferenceId = stringField(body, "reconciliationEvidenceReferenceId");
        await safes.assertUnusedEvidence(actor, evidenceReferenceId, "OPENING_RECONCILIATION");
        await service.reconcileOpening(actor, {
          cashAccountId: id, physicalCashCountId: stringField(body, "physicalCashCountId") as PhysicalCashCountId,
          reconciliationEvidenceReferenceId: evidenceReferenceId
        });
        break;
      }
      case "approve":
        await service.approveOpening(actor, id);
        break;
      case "activate":
        await service.activateAccount(actor, id);
        break;
      case "block":
        await safes.blockAccount(actor, id);
        break;
      default:
        return json({ ok: false, error: { code: "NOT_FOUND", message: `Unknown account action ${action}` } }, 404);
    }
    return json({ ok: true, data: { cashAccountId: accountId } });
  } catch (error) {
    return errorResponse(error);
  }
}
