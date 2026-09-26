import { correctExchangeRate, currencyErrorResponse } from "@/server/exchange-rates";
import { assertMutation, readBody, text } from "@/server/identity";
import { json } from "@/server/treasury";

export const dynamic = "force-dynamic";

/** A correction is a new rate that supersedes the current one; the old row and its snapshots stay. */
export async function POST(request: Request, context: { params: Promise<{ rateId: string }> }) {
  try {
    assertMutation(request);
    const { rateId } = await context.params;
    const body = await readBody(request);
    const id = await correctExchangeRate(rateId, text(body, "rate"), text(body, "reason"));
    return json({ ok: true, data: { id } }, 201);
  } catch (error) {
    return currencyErrorResponse(error, "You do not have permission to correct exchange rates.");
  }
}
