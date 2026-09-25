import { identityErrorResponse, identityRuntime, sessionToken } from "@/server/identity";
import { json } from "@/server/treasury";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return json({ ok: true, data: await identityRuntime().service.auditTrail(await sessionToken(), 200) });
  } catch (error) {
    return identityErrorResponse(error);
  }
}
