import { shareholderCapitalPostingPostSchema } from "@abos/contracts";
import { assertMutation, readBody } from "@/server/identity";
import { postCapitalReceipt, shareholderFinanceErrorResponse, shareholderFinanceUnavailableResponse } from "@/server/shareholder-finance-bridge";

export const dynamic = "force-dynamic";

/** Reserved explicit posting boundary. It cannot post until the coordinated schema is installed. */
export async function POST(request: Request, { params }: { params: Promise<{ postingIntentId: string }> }) {
  try {
    const unavailable = await shareholderFinanceUnavailableResponse(request);
    if (unavailable) return unavailable;
    assertMutation(request);
    const parsed = shareholderCapitalPostingPostSchema.parse(await readBody(request));
    return Response.json({ ok: true, data: await postCapitalReceipt(request, (await params).postingIntentId, parsed) });
  } catch (error) { return shareholderFinanceErrorResponse(error); }
}
