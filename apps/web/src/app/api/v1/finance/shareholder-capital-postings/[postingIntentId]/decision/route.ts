import { shareholderCapitalPostingDecisionSchema } from "@abos/contracts";
import { assertMutation, readBody } from "@/server/identity";
import { decideCapitalPosting, shareholderFinanceErrorResponse, shareholderFinanceUnavailableResponse } from "@/server/shareholder-finance-bridge";

export const dynamic = "force-dynamic";

/** Reserved independent Finance approval boundary. */
export async function POST(request: Request, { params }: { params: Promise<{ postingIntentId: string }> }) {
  try {
    const unavailable = await shareholderFinanceUnavailableResponse(request);
    if (unavailable) return unavailable;
    assertMutation(request);
    const parsed = shareholderCapitalPostingDecisionSchema.parse(await readBody(request));
    return Response.json({ ok: true, data: await decideCapitalPosting(request, (await params).postingIntentId, parsed) });
  } catch (error) { return shareholderFinanceErrorResponse(error); }
}
