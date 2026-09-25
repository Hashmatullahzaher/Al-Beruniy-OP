import { accountNotFound, chartErrorResponse, isAccountId, setAccountStatus } from "@/server/chart-of-accounts";
import { assertMutation, optionalText, readBody, text } from "@/server/identity";
import { json } from "@/server/treasury";

export const dynamic = "force-dynamic";

/** Deactivates (with a reason) or reactivates an account. */
export async function POST(request: Request, { params }: { params: Promise<{ accountId: string }> }) {
  try {
    assertMutation(request);
    const { accountId } = await params;
    if (!isAccountId(accountId)) return accountNotFound();
    const body = await readBody(request);
    const version = typeof body.expectedVersion === "number" && Number.isInteger(body.expectedVersion) ? body.expectedVersion : -1;
    return json({ ok: true, data: await setAccountStatus(accountId, version, text(body, "status"), optionalText(body, "reason")) });
  } catch (error) {
    return chartErrorResponse(error);
  }
}
