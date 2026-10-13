import { shareholderFinanceCapabilityResponse } from "@/server/shareholder-finance-bridge";

export const dynamic = "force-dynamic";

/** Reserved explicit posting boundary. It cannot post until the coordinated schema is installed. */
export async function POST(request: Request) {
  return shareholderFinanceCapabilityResponse(request);
}
