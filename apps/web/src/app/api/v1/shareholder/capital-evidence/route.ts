import { shareholderCapitalEvidenceRegisterSchema } from "@abos/contracts";

import { assertMutation, readBody } from "@/server/identity";
import {
  registerCapitalEvidence,
  shareholderFinanceErrorResponse,
  shareholderFinanceSchemaUnavailableResponse,
  shareholderFinanceUnavailableResponse
} from "@/server/shareholder-finance-bridge";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    assertMutation(request);
    const input = shareholderCapitalEvidenceRegisterSchema.parse(await readBody(request));
    const unavailable = input.evidenceKind === "CAPITAL_ACCOUNT_MAPPING"
      ? await shareholderFinanceSchemaUnavailableResponse(request)
      : await shareholderFinanceUnavailableResponse(request);
    if (unavailable) return unavailable;
    return Response.json({ ok: true, data: await registerCapitalEvidence(request, input) });
  } catch (error) {
    return shareholderFinanceErrorResponse(error);
  }
}
