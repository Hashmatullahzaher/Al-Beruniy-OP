import { json } from "@/server/treasury";

export const dynamic = "force-dynamic";

/** Which sign-in methods this server offers: the password sign-in only. The developer-token form left with 0041. */
export async function GET() {
  return json({ ok: true, data: { password: true, developerTokens: false } });
}
