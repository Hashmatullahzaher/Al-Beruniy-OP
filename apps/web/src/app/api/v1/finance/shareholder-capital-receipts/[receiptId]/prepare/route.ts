import { shareholderCapitalPostingPrepareSchema } from "@abos/contracts";
import { assertMutation, readBody } from "@/server/identity";
import { prepareCapitalPosting, shareholderFinanceErrorResponse, shareholderFinanceUnavailableResponse } from "@/server/shareholder-finance-bridge";

export const dynamic = "force-dynamic";

/** Reserved Finance preparation boundary. Configuration remains database-authoritative. */
export async function POST(request: Request, { params }: { params: Promise<{ receiptId: string }> }) {
  try {
    const unavailable = await shareholderFinanceUnavailableResponse(request);
    if (unavailable) return unavailable;
    assertMutation(request);
    const parsed = shareholderCapitalPostingPrepareSchema.parse(await readBody(request));
    return Response.json({ ok: true, data: await prepareCapitalPosting(request, (await params).receiptId, parsed) });
  } catch (error) { return shareholderFinanceErrorResponse(error); }
}
