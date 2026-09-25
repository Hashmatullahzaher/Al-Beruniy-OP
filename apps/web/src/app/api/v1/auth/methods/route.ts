import { developerTokenSignInEnabled } from "@/server/identity";
import { json } from "@/server/treasury";

export const dynamic = "force-dynamic";

/** Which sign-in methods this server offers. Developer tokens are never offered in production. */
export async function GET() {
  return json({ ok: true, data: { password: true, developerTokens: developerTokenSignInEnabled() } });
}
