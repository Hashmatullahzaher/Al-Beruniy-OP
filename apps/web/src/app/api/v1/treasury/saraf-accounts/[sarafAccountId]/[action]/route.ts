import { assertMutation } from "@/server/identity";
import { errorResponse, json } from "@/server/treasury";
import { currentSafes } from "@/server/treasury-safes";

export const dynamic = "force-dynamic";

type Context = { readonly params: Promise<{ readonly sarafAccountId: string; readonly action: string }> };

/** Activate (by someone other than the creator) or deactivate a Saraf account. */
export async function POST(request: Request, { params }: Context) {
  try {
    assertMutation(request);
    const { sarafAccountId, action } = await params;
    const { safes, actor } = await currentSafes();
    if (action === "activate") await safes.activateSarafAccount(actor, sarafAccountId);
    else if (action === "deactivate") await safes.deactivateSarafAccount(actor, sarafAccountId);
    else return json({ ok: false, error: { code: "NOT_FOUND", message: `Unknown Saraf account action ${action}` } }, 404);
    return json({ ok: true, data: { sarafAccountId } });
  } catch (error) {
    return errorResponse(error);
  }
}
