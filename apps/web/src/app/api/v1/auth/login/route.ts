import { clearSessionCookie, clientAddress, assertMutation, identityErrorResponse, identityRuntime, readBody, setSessionCookie, text } from "@/server/identity";
import { json } from "@/server/treasury";

export const dynamic = "force-dynamic";

/** Username and password sign-in. The session token goes only into the httpOnly cookie. */
export async function POST(request: Request) {
  try {
    assertMutation(request);
    const body = await readBody(request);
    const result = await identityRuntime().service.login({
      loginIdentifier: text(body, "loginIdentifier"), password: text(body, "password"), clientAddress: clientAddress(request)
    });
    await setSessionCookie(result);
    return json({ ok: true, data: { user: result.user } });
  } catch (error) {
    await clearSessionCookie().catch(() => undefined);
    return identityErrorResponse(error);
  }
}
