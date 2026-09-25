import { assertMutation, identityErrorResponse, identityRuntime, readBody, sessionToken } from "@/server/identity";
import { json } from "@/server/treasury";

export const dynamic = "force-dynamic";

type Context = { readonly params: Promise<{ readonly userId: string }> };

export async function POST(request: Request, { params }: Context) {
  try {
    assertMutation(request);
    await readBody(request);
    return json({ ok: true, data: await identityRuntime().service.resetPassword(await sessionToken(), (await params).userId) });
  } catch (error) {
    return identityErrorResponse(error);
  }
}
