import { assertMutation, identityErrorResponse, identityRuntime, sessionToken } from "@/server/identity";
import { json } from "@/server/treasury";

export const dynamic = "force-dynamic";

type Context = { readonly params: Promise<{ readonly userId: string }> };

export async function DELETE(request: Request, { params }: Context) {
  try {
    assertMutation(request);
    return json({ ok: true, data: await identityRuntime().service.revokeSessions(await sessionToken(), (await params).userId) });
  } catch (error) {
    return identityErrorResponse(error);
  }
}
