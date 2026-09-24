import type { CapitalReceiptIntentId } from "@abos/contracts";

import { assertSameOrigin, currentTreasury, errorResponse, json, readJson, stringField } from "@/server/treasury";

export const dynamic = "force-dynamic";

/**
 * Step 3: an assigned cashier records that cash was physically received against an ELIGIBLE
 * shareholder intent. The amount, currency and safe come from the intent, not from this request.
 */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const body = await readJson(request);
    const treasury = await currentTreasury();
    const receiptId = await treasury.service.recordReceipt(treasury.actor, {
      capitalReceiptIntentId: stringField(body, "capitalReceiptIntentId") as CapitalReceiptIntentId,
      receiptReference: stringField(body, "receiptReference"),
      businessEventAt: stringField(body, "businessEventAt") || new Date().toISOString()
    });
    return json({ ok: true, data: { receiptId } }, 201);
  } catch (error) {
    return errorResponse(error);
  }
}
