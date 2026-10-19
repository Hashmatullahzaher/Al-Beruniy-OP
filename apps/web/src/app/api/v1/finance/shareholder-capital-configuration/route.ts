import {
  capitalConfiguration,
  shareholderFinanceErrorResponse,
  shareholderFinanceSchemaUnavailableResponse
} from "@/server/shareholder-finance-bridge";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const unavailable = await shareholderFinanceSchemaUnavailableResponse(request);
    if (unavailable) return unavailable;
    return Response.json({ ok: true, data: await capitalConfiguration() }, {
      headers: { "cache-control": "no-store" }
    });
  } catch (error) {
    return shareholderFinanceErrorResponse(error);
  }
}
