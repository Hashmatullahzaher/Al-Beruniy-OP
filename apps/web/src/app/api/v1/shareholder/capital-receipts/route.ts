import { shareholderFinanceCapabilityResponse } from "@/server/shareholder-finance-bridge";

export const dynamic = "force-dynamic";

/** Reserved production boundary. No memory/demo adapter is reachable from this route. */
export async function POST(request: Request) {
  return shareholderFinanceCapabilityResponse(request);
}
