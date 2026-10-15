import { shareholderCapitalCustodyDecisionSchema } from "@abos/contracts";
import { assertMutation, readBody } from "@/server/identity";
import { shareholderFinanceErrorResponse, shareholderFinanceUnavailableResponse, verifyCapitalCustody } from "@/server/shareholder-finance-bridge";

export const dynamic = "force-dynamic";

/** Reserved Treasury custody boundary. Actor/entity are never accepted from the request body. */
export async function POST(request: Request, { params }: { params: Promise<{ receiptId: string }> }) {
  try {
    const unavailable = await shareholderFinanceUnavailableResponse(request);
    if (unavailable) return unavailable;
    assertMutation(request);
    const parsed = shareholderCapitalCustodyDecisionSchema.parse(await readBody(request));
    return Response.json({ ok: true, data: await verifyCapitalCustody(request, (await params).receiptId, parsed) });
  } catch (error) { return shareholderFinanceErrorResponse(error); }
}
