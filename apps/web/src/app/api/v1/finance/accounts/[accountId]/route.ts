import { accountInput, accountNotFound, chartErrorResponse, isAccountId, updateAccount } from "@/server/chart-of-accounts";
import { assertMutation, readBody } from "@/server/identity";
import { json } from "@/server/treasury";

export const dynamic = "force-dynamic";

/** Changes an account's definition; the change returns it to the review list. */
export async function PATCH(request: Request, { params }: { params: Promise<{ accountId: string }> }) {
  try {
    assertMutation(request);
    const { accountId } = await params;
    if (!isAccountId(accountId)) return accountNotFound();
    const body = await readBody(request);
    const version = typeof body.expectedVersion === "number" && Number.isInteger(body.expectedVersion) ? body.expectedVersion : -1;
    return json({ ok: true, data: await updateAccount(accountId, version, accountInput(body.changes), body.confirmDuplicates === true) });
  } catch (error) {
    return chartErrorResponse(error);
  }
}
