import { assertMutation, identityErrorResponse, identityRuntime, readBody, sessionToken, stringList } from "@/server/identity";
import { json } from "@/server/treasury";

export const dynamic = "force-dynamic";

type Context = { readonly params: Promise<{ readonly userId: string }> };

export async function PUT(request: Request, { params }: Context) {
  try {
    assertMutation(request);
    const data = await identityRuntime().service.setRoles(await sessionToken(), (await params).userId, stringList(await readBody(request), "roleIds"));
    return json({ ok: true, data });
  } catch (error) {
    return identityErrorResponse(error);
  }
}
