import { assertMutation, identityErrorResponse, identityRuntime, readBody, sessionToken, stringList, text } from "@/server/identity";
import { json } from "@/server/treasury";

export const dynamic = "force-dynamic";

type Context = { readonly params: Promise<{ readonly roleId: string }> };

export async function PUT(request: Request, { params }: Context) {
  try {
    assertMutation(request);
    const body = await readBody(request);
    const version = body.expectedVersion;
    const data = await identityRuntime().service.updateRole(await sessionToken(), (await params).roleId, {
      name: text(body, "name"), description: text(body, "description"), permissions: stringList(body, "permissions"),
      status: text(body, "status") === "INACTIVE" ? "INACTIVE" : "ACTIVE",
      expectedVersion: typeof version === "number" ? version : -1
    });
    return json({ ok: true, data });
  } catch (error) {
    return identityErrorResponse(error);
  }
}
