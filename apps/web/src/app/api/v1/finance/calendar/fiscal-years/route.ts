import { calendarErrorResponse, generateFiscalYear } from "@/server/finance-calendar";
import { assertMutation, readBody } from "@/server/identity";
import { json } from "@/server/treasury";

export const dynamic = "force-dynamic";

/** Generates twelve PENDING periods for one fiscal year; repeating the request returns the same year. */
export async function POST(request: Request) {
  try {
    assertMutation(request);
    const body = await readBody(request);
    const fiscalYear = typeof body.fiscalYear === "number" && Number.isInteger(body.fiscalYear) ? body.fiscalYear : -1;
    return json({ ok: true, data: { id: await generateFiscalYear(fiscalYear) } }, 201);
  } catch (error) {
    return calendarErrorResponse(error);
  }
}
