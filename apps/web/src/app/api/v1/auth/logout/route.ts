import { cookies } from "next/headers";

import { assertSameOrigin, json, SESSION_COOKIE } from "@/server/treasury";
import { clearSessionCookie, identityErrorResponse, identityRuntime } from "@/server/identity";

export const dynamic = "force-dynamic";

/** Revokes the server-side session and clears the cookie. */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const token = (await cookies()).get(SESSION_COOKIE)?.value;
    if (token !== undefined) await identityRuntime().service.logout(token);
    await clearSessionCookie();
    return json({ ok: true, data: { signedOut: true } });
  } catch (error) {
    await clearSessionCookie().catch(() => undefined);
    return identityErrorResponse(error);
  }
}
