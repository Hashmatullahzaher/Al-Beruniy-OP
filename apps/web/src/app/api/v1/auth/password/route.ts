import { assertMutation, clientAddress, identityErrorResponse, identityRuntime, readBody, setSessionCookie, text } from "@/server/identity";
import { json } from "@/server/treasury";

export const dynamic = "force-dynamic";

/** Changes a password after proving the current one; ends every other session and signs in. */
export async function POST(request: Request) {
  try {
    assertMutation(request);
    const body = await readBody(request);
    const result = await identityRuntime().service.changePassword({
      loginIdentifier: text(body, "loginIdentifier"), currentPassword: text(body, "currentPassword"),
      newPassword: text(body, "newPassword"), clientAddress: clientAddress(request)
    });
    await setSessionCookie(result);
    return json({ ok: true, data: { user: result.user } });
  } catch (error) {
    return identityErrorResponse(error);
  }
}
