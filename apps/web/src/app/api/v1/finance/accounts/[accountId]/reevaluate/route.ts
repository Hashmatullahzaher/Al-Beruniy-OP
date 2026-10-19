import { accountNotFound, chartErrorResponse, isAccountId, reevaluateAccount } from "@/server/chart-of-accounts";
import { assertMutation, readBody, text } from "@/server/identity";
import { json } from "@/server/treasury";

export const dynamic = "force-dynamic";

/** Revalidate an awaiting-review account under the current OFF policy; never invent an approval. */
export async function POST(request: Request, { params }: { params: Promise<{ accountId: string }> }) {
  try {
    assertMutation(request);
    const { accountId } = await params;
    if (!isAccountId(accountId)) return accountNotFound();
    const body = await readBody(request);
    const expectedVersion = typeof body.expectedVersion === "number" && Number.isInteger(body.expectedVersion) ? body.expectedVersion : -1;
    return json({ ok: true, data: await reevaluateAccount(accountId, {
      expectedVersion,
      reason: text(body, "reason"),
      idempotencyKey: text(body, "idempotencyKey"),
      correlationId: text(body, "correlationId")
    }) });
  } catch (error) {
    return chartErrorResponse(error);
  }
}
