import { currencyErrorResponse } from "@/server/exchange-rates";
import { assertMutation, optionalText, readBody, text } from "@/server/identity";
import { createCapitalRequest, shareholderWorkspace } from "@/server/shareholder-requests";
import { json } from "@/server/treasury";

export const dynamic = "force-dynamic";

/**
 * Capital requests still run only behind the synthetic sandbox gate. On company data that gate is
 * deliberately closed, which is not a session problem: report it as "not operational" (403) instead
 * of "session ended" (401). Every other refusal keeps its existing mapping.
 */
function notOperational(error: unknown): Response | null {
  const code = error !== null && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
  const message = error instanceof Error ? error.message : "";
  if (code !== "42501" || !/synthetic Shareholder sandbox authorization is not active/.test(message)) return null;
  return json({ ok: false, error: { code: "NOT_OPERATIONAL", message: "Capital Requests is not operational yet." } }, 403);
}

export async function GET() {
  try {
    return json({ ok: true, data: await shareholderWorkspace() });
  } catch (error) {
    return notOperational(error) ?? currencyErrorResponse(error, "You do not have permission to view shareholder agreements.");
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
    return notOperational(error) ?? currencyErrorResponse(error, "You do not have permission to create shareholder capital requests.");
  }
}
