import { assertMutation, identityErrorResponse, identityRuntime, readBody, sessionToken, text } from "@/server/identity";
import { json } from "@/server/treasury";

export const dynamic = "force-dynamic";

type Context = { readonly params: Promise<{ readonly userId: string }> };

export async function POST(request: Request, { params }: Context) {
  try {
    assertMutation(request);
    const status = text(await readBody(request), "status");
    const data = await identityRuntime().service.setStatus(await sessionToken(), (await params).userId, status as "ACTIVE" | "DISABLED");
    return json({ ok: true, data });
  } catch (error) {
    return identityErrorResponse(error);
  }
}
