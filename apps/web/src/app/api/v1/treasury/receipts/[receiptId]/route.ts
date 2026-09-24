import { currentTreasury, errorResponse, json } from "@/server/treasury";
import { buildTrace } from "@/server/treasury-view";

export const dynamic = "force-dynamic";

/** The full trace from receipt back to the shareholder installment, with audit history. */
export async function GET(_request: Request, { params }: { params: Promise<{ receiptId: string }> }) {
  try {
    const { receiptId } = await params;
    return json({ ok: true, data: await buildTrace(await currentTreasury(), receiptId) });
  } catch (error) {
    return errorResponse(error);
  }
}
