import { capitalTrace, shareholderFinanceErrorResponse, shareholderFinanceUnavailableResponse } from "@/server/shareholder-finance-bridge";

export const dynamic = "force-dynamic";

/** Reserved permission-scoped trace read. Declaration reads remain on the existing 0035 endpoint. */
export async function GET(request: Request, { params }: { params: Promise<{ contributionId: string }> }) {
  try {
    const unavailable = await shareholderFinanceUnavailableResponse(request);
    if (unavailable) return unavailable;
    return Response.json({ ok: true, data: await capitalTrace((await params).contributionId) });
  } catch (error) { return shareholderFinanceErrorResponse(error); }
}
