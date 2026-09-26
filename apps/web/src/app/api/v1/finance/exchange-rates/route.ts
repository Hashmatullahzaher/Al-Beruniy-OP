import { currencyErrorResponse, exchangeRatesView, recordExchangeRate } from "@/server/exchange-rates";
import { assertMutation, optionalText, readBody, text } from "@/server/identity";
import { json } from "@/server/treasury";

export const dynamic = "force-dynamic";

const DENIED = "You do not have permission to record exchange rates.";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    return json({ ok: true, data: await exchangeRatesView(url.searchParams.get("from"), url.searchParams.get("to")) });
  } catch (error) {
    return currencyErrorResponse(error, "You do not have permission to view exchange rates.");
  }
}

/** Records the day's rate exactly as entered; the rate travels as a decimal string. */
export async function POST(request: Request) {
  try {
    assertMutation(request);
    const body = await readBody(request);
    const id = await recordExchangeRate({
      rateDate: text(body, "rateDate"), source: text(body, "source"), sarafPartyId: optionalText(body, "sarafPartyId") || null,
      unitCurrency: text(body, "unitCurrency"), quoteCurrency: text(body, "quoteCurrency"), rate: text(body, "rate"),
      note: optionalText(body, "note")
    });
    return json({ ok: true, data: { id } }, 201);
  } catch (error) {
    return currencyErrorResponse(error, DENIED);
  }
}
