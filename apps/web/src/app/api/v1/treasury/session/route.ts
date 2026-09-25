import { cookies } from "next/headers";

import { developerTokenSignInEnabled } from "@/server/identity";
import { assertSameOrigin, currentTreasury, errorResponse, json, readJson, SESSION_COOKIE, stringField, treasuryRuntime } from "@/server/treasury";

export const dynamic = "force-dynamic";

/** Who is signed in, rebuilt from persisted grants. */
export async function GET() {
  try {
    const request = await currentTreasury();
    return json({
      ok: true,
      data: {
        userAccountId: request.actor.userAccountId,
        displayName: request.displayName,
        treasuryPermissions: request.actor.treasuryPermissions,
        sessionExpiresAt: request.context.expiresAt ?? ""
      }
    });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * Developer-only: exchanges a pre-issued sandbox session token for an httpOnly cookie. Employees
 * sign in with a username and password at /login instead. This path answers 404 unless
 * ABOS_ALLOW_DEV_TOKEN_SIGNIN=1 outside production, so it is never offered in a preview.
 */
export async function POST(request: Request) {
  if (!developerTokenSignInEnabled()) {
    return json({ ok: false, error: { code: "NOT_FOUND", message: "Developer token sign-in is disabled. Sign in with your username and password." } }, 404);
  }
  try {
    assertSameOrigin(request);
    const token = stringField(await readJson(request), "token").trim();
    const context = await treasuryRuntime().gateway.context(token);
    const expiresAt = new Date(context.expiresAt);
    (await cookies()).set(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "strict",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      expires: expiresAt
    });
    return json({ ok: true, data: { userAccountId: context.userAccountId } });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Signs out of this browser and revokes the server-side session. */
export async function DELETE(request: Request) {
  try {
    assertSameOrigin(request);
    const store = await cookies();
    const token = store.get(SESSION_COOKIE)?.value;
    if (token !== undefined) {
      try {
        await treasuryRuntime().gateway.revokeOwnSession(token);
      } catch {
        // An expired or already revoked session still gets its cookie cleared.
      }
    }
    store.delete(SESSION_COOKIE);
    return json({ ok: true, data: { signedOut: true } });
  } catch (error) {
    return errorResponse(error);
  }
}
