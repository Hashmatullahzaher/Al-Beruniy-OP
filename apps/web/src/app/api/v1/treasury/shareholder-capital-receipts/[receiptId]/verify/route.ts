import { shareholderFinanceCapabilityResponse } from "@/server/shareholder-finance-bridge";

export const dynamic = "force-dynamic";

/** Reserved Treasury custody boundary. Actor/entity are never accepted from the request body. */
export async function POST(request: Request) {
  return shareholderFinanceCapabilityResponse(request);
}
