import { assertMutation, readBody, text } from "@/server/identity";
import { isReversalId, requestReversal, reversalErrorResponse, reversalNotFound, reversalWorkspace } from "@/server/reversals";
import { json } from "@/server/treasury";

export const dynamic = "force-dynamic";

/** Reversal requests, and the posted journals the person may ask to reverse. */
export async function GET() {
  try {
    return json({ ok: true, data: await reversalWorkspace() });
  } catch (error) {
    return reversalErrorResponse(error);
  }
}

/** A Finance user asks for a posted journal to be reversed, with a written reason. */
export async function POST(request: Request) {
  try {
    assertMutation(request);
    const body = await readBody(request);
    const journalId = text(body, "journalId");
    if (!isReversalId(journalId)) return reversalNotFound();
    const result = await requestReversal(journalId, text(body, "reason"));
    return json({ ok: true, data: result }, result.created ? 201 : 200);
  } catch (error) {
    return reversalErrorResponse(error);
  }
}
