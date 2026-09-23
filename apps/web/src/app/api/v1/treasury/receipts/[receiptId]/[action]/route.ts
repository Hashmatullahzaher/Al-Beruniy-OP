import type { CashReceiptId } from "@abos/contracts";

import { assertSameOrigin, currentTreasury, errorResponse, json, readJson, stringField } from "@/server/treasury";

export const dynamic = "force-dynamic";

const ACTIONS = new Set(["count", "submit", "verify", "void", "handoff"]);

/**
 * Receipt transitions. Each one is authorized server-side against the acting user's persisted
 * grants, rechecked inside its transaction, and enforced again by the database. A refusal is
 * returned as a refusal; nothing reports success unless the transition committed.
 */
export async function POST(request: Request, { params }: { params: Promise<{ receiptId: string; action: string }> }) {
  try {
    assertSameOrigin(request);
    const { receiptId, action } = await params;
    if (!ACTIONS.has(action)) {
      return json({ ok: false, error: { code: "NOT_FOUND", message: `Unknown Treasury action ${action}` } }, 404);
    }
    const body = await readJson(request);
    const treasury = await currentTreasury();
    const id = receiptId as CashReceiptId;
    const { service, actor } = treasury;

    if (action === "count") {
      const countId = await service.countReceipt(actor, {
        receiptId: id,
        countedAmount: stringField(body, "countedAmount").trim(),
        countEvidenceReferenceId: stringField(body, "countEvidenceReferenceId"),
        receiptEvidenceReferenceId: stringField(body, "receiptEvidenceReferenceId")
      });
      return json({ ok: true, data: { receiptId, physicalCashCountId: countId } });
    }
    if (action === "submit") {
      await service.submitForVerification(actor, id);
    } else if (action === "verify") {
      await service.verifyReceipt(actor, id);
    } else if (action === "void") {
      await service.voidReceipt(actor, id, stringField(body, "reason"));
    } else {
      const handoffId = await service.handOffToFinance(actor, { receiptId: id });
      return json({ ok: true, data: { receiptId, handoffId } });
    }
    return json({ ok: true, data: { receiptId } });
  } catch (error) {
    return errorResponse(error);
  }
}
