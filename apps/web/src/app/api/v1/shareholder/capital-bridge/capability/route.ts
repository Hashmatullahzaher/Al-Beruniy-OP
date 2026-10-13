import { shareholderFinanceCapability } from "@/server/shareholder-finance-bridge";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ ok: true, data: shareholderFinanceCapability() }, {
    headers: { "cache-control": "no-store" }
  });
}
