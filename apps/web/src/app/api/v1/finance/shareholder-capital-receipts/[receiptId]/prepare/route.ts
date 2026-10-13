import { shareholderFinanceCapabilityResponse } from "@/server/shareholder-finance-bridge";

export const dynamic = "force-dynamic";

/** Reserved Finance preparation boundary. Configuration remains database-authoritative. */
export async function POST(request: Request) {
  return shareholderFinanceCapabilityResponse(request);
}
