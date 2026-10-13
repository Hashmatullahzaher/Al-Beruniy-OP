import { shareholderFinanceCapabilityResponse } from "@/server/shareholder-finance-bridge";

export const dynamic = "force-dynamic";

/** Reserved permission-scoped trace read. Declaration reads remain on the existing 0035 endpoint. */
export async function GET(request: Request) {
  return shareholderFinanceCapabilityResponse(request);
}
