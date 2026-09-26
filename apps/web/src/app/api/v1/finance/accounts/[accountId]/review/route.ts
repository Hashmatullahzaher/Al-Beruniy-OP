import { accountNotFound, chartErrorResponse, isAccountId, reviewAccount } from "@/server/chart-of-accounts";
import { assertMutation, optionalText, readBody, text } from "@/server/identity";
import { json } from "@/server/treasury";

export const dynamic = "force-dynamic";

/** The Finance Manager's review decision: REVIEWED, or FLAGGED with a note. */
export async function POST(request: Request, { params }: { params: Promise<{ accountId: string }> }) {
  try {
    assertMutation(request);
    const { accountId } = await params;
    if (!isAccountId(accountId)) return accountNotFound();
    const body = await readBody(request);
    const version = typeof body.expectedVersion === "number" && Number.isInteger(body.expectedVersion) ? body.expectedVersion : -1;
    return json({ ok: true, data: await reviewAccount(accountId, version, text(body, "decision"), optionalText(body, "note")) });
  } catch (error) {
    return chartErrorResponse(error);
  }
}
