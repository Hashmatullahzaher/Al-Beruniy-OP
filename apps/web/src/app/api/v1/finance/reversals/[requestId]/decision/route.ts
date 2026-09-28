import { assertMutation, optionalText, readBody, text } from "@/server/identity";
import { decideReversal, expectedVersion, isReversalId, reversalErrorResponse, reversalNotFound } from "@/server/reversals";
import { json } from "@/server/treasury";

export const dynamic = "force-dynamic";

/**
 * The Finance Manager approves or rejects (with a note) a waiting reversal request. Approval
 * records the decision only; posting the reversal awaits the Finance Manager's posting policy.
 */
export async function POST(request: Request, { params }: { params: Promise<{ requestId: string }> }) {
  try {
    assertMutation(request);
    const { requestId } = await params;
    if (!isReversalId(requestId)) return reversalNotFound();
    const body = await readBody(request);
    return json({ ok: true, data: await decideReversal(requestId, expectedVersion(body.expectedVersion), text(body, "decision"), optionalText(body, "note")) });
  } catch (error) {
    return reversalErrorResponse(error);
  }
}
