import { assertMutation } from "@/server/identity";
import { errorResponse, json, readJson, stringField } from "@/server/treasury";
import { asAccountId, buildSafesView, currentSafes } from "@/server/treasury-safes";

export const dynamic = "force-dynamic";

/**
 * Whole-safe counts. The custody total and the difference are computed by the database when the
 * count is recorded; they are displayed, never acted on (the discrepancy policy is not decided).
 */
export async function GET() {
  try {
    const view = await buildSafesView(await currentSafes());
    return json({ ok: true, data: { safeCounts: view.safeCounts } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    assertMutation(request);
    const body = await readJson(request);
    const { safes, actor } = await currentSafes();
    const note = stringField(body, "note").trim();
    const safeCountId = await safes.recordSafeCount(actor, {
      cashAccountId: asAccountId(stringField(body, "cashAccountId")),
      countedAmount: stringField(body, "countedAmount").trim(),
      evidenceReferenceId: stringField(body, "evidenceReferenceId"),
      ...(note === "" ? {} : { note })
    });
    return json({ ok: true, data: { safeCountId } }, 201);
  } catch (error) {
    return errorResponse(error);
  }
}
