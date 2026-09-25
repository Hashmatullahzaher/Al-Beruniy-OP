import { assertMutation, identityErrorResponse, identityRuntime, optionalText, readBody, sessionToken, text } from "@/server/identity";
import { json } from "@/server/treasury";

export const dynamic = "force-dynamic";

type Context = { readonly params: Promise<{ readonly userId: string }> };

export async function GET(_request: Request, { params }: Context) {
  try {
    return json({ ok: true, data: await identityRuntime().service.userDetail(await sessionToken(), (await params).userId) });
  } catch (error) {
    return identityErrorResponse(error);
  }
}

export async function PATCH(request: Request, { params }: Context) {
  try {
    assertMutation(request);
    const body = await readBody(request);
    const data = await identityRuntime().service.updateProfile(await sessionToken(), (await params).userId, {
      displayName: text(body, "displayName"), jobTitle: optionalText(body, "jobTitle"),
      contactEmail: optionalText(body, "contactEmail"), contactPhone: optionalText(body, "contactPhone")
    });
    return json({ ok: true, data });
  } catch (error) {
    return identityErrorResponse(error);
  }
}
