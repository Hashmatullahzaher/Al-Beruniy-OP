import { shareholderCapitalMappingConfigureSchema } from "@abos/contracts";

import { assertMutation, readBody } from "@/server/identity";
import { configureCapitalMapping, shareholderFinanceErrorResponse, shareholderFinanceUnavailableResponse } from "@/server/shareholder-finance-bridge";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const unavailable = await shareholderFinanceUnavailableResponse(request);
    if (unavailable) return unavailable;
    assertMutation(request);
    const parsed = shareholderCapitalMappingConfigureSchema.parse(await readBody(request));
    return Response.json({ ok: true, data: await configureCapitalMapping(request, parsed) });
  } catch (error) {
    return shareholderFinanceErrorResponse(error);
  }
}
