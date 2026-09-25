import { assertMutation } from "@/server/identity";
import { errorResponse, json } from "@/server/treasury";
import { currentSafes } from "@/server/treasury-safes";

export const dynamic = "force-dynamic";

type Context = { readonly params: Promise<{ readonly countId: string }> };

/** Independent confirmation of a whole-safe count; the counter is refused here and in the database. */
export async function POST(request: Request, { params }: Context) {
  try {
    assertMutation(request);
    const { countId } = await params;
    const { safes, actor } = await currentSafes();
    await safes.confirmSafeCount(actor, countId);
    return json({ ok: true, data: { safeCountId: countId } });
  } catch (error) {
    return errorResponse(error);
  }
}
