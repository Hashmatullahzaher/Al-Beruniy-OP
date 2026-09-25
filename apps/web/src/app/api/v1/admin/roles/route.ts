import { assertMutation, identityErrorResponse, identityRuntime, readBody, sessionToken, stringList, text } from "@/server/identity";
import { json } from "@/server/treasury";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return json({ ok: true, data: await identityRuntime().service.listRoles(await sessionToken()) });
  } catch (error) {
    return identityErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    assertMutation(request);
    const body = await readBody(request);
    const data = await identityRuntime().service.createRole(await sessionToken(), {
      name: text(body, "name"), description: text(body, "description"), permissions: stringList(body, "permissions")
    });
    return json({ ok: true, data }, 201);
  } catch (error) {
    return identityErrorResponse(error);
  }
}
