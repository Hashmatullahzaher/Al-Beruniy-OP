import { currencyErrorResponse } from "@/server/exchange-rates";
import { assertMutation, optionalText, readBody, text } from "@/server/identity";
import { createCapitalRequest, shareholderWorkspace } from "@/server/shareholder-requests";
import { json } from "@/server/treasury";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return json({ ok: true, data: await shareholderWorkspace() });
  } catch (error) {
    return currencyErrorResponse(error, "You do not have permission to view shareholder agreements.");
  }
}

/** Creates a capital request from an eligible installment. Repeating the same request key returns the first result. */
export async function POST(request: Request) {
  try {
    assertMutation(request);
    const body = await readBody(request);
    const created = await createCapitalRequest({
      installmentId: text(body, "installmentId"), destinationAccountId: text(body, "destinationAccountId"),
      amount: text(body, "amount"), businessDate: text(body, "businessDate"),
      exchangeRateId: optionalText(body, "exchangeRateId") || null, idempotencyKey: optionalText(body, "idempotencyKey")
    });
    return json({ ok: true, data: created }, created.replayed ? 200 : 201);
  } catch (error) {
    return currencyErrorResponse(error, "You do not have permission to create shareholder capital requests.");
  }
}
