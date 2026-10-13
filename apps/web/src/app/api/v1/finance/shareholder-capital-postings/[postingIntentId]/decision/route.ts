import { shareholderFinanceCapabilityResponse } from "@/server/shareholder-finance-bridge";

export const dynamic = "force-dynamic";

/** Reserved independent Finance approval boundary. */
export async function POST(request: Request) {
  return shareholderFinanceCapabilityResponse(request);
}
