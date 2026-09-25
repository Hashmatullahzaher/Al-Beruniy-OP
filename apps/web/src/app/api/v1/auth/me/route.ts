import { identityErrorResponse, identityRuntime, sessionToken } from "@/server/identity";
import { json } from "@/server/treasury";

export const dynamic = "force-dynamic";

/** The signed-in person and their current permissions, rebuilt from the database. */
export async function GET() {
  try {
    return json({ ok: true, data: await identityRuntime().service.currentUser(await sessionToken()) });
  } catch (error) {
    return identityErrorResponse(error);
  }
}
