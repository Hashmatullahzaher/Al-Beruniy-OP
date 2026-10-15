import { shareholderFinanceCapability, shareholderFinanceCapabilityResponse } from "@/server/shareholder-finance-bridge";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    return Response.json({ ok: true, data: await shareholderFinanceCapability() }, {
      headers: { "cache-control": "no-store" }
    });
  } catch {
    return shareholderFinanceCapabilityResponse(request);
  }
}
