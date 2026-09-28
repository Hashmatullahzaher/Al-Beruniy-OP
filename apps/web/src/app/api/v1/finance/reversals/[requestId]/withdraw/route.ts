import { assertMutation, optionalText, readBody } from "@/server/identity";
import { expectedVersion, isReversalId, reversalErrorResponse, reversalNotFound, withdrawReversal } from "@/server/reversals";
import { json } from "@/server/treasury";

export const dynamic = "force-dynamic";

/** The requester withdraws a reversal request that is still waiting for a decision. */
export async function POST(request: Request, { params }: { params: Promise<{ requestId: string }> }) {
  try {
    assertMutation(request);
    const { requestId } = await params;
    if (!isReversalId(requestId)) return reversalNotFound();
    const body = await readBody(request);
    return json({ ok: true, data: await withdrawReversal(requestId, expectedVersion(body.expectedVersion), optionalText(body, "note")) });
  } catch (error) {
    return reversalErrorResponse(error);
  }
}
