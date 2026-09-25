import { assertMutation, identityErrorResponse, identityRuntime, optionalText, readBody, sessionToken, stringList, text } from "@/server/identity";
import { json } from "@/server/treasury";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return json({ ok: true, data: await identityRuntime().service.listUsers(await sessionToken()) });
  } catch (error) {
    return identityErrorResponse(error);
  }
}

/** Creates an employee account. The temporary password is returned once, for the administrator to hand over. */
export async function POST(request: Request) {
  try {
    assertMutation(request);
    const body = await readBody(request);
    const status = text(body, "status") === "DISABLED" ? "DISABLED" : text(body, "status") === "ACTIVE" ? "ACTIVE" : "";
    const result = await identityRuntime().service.createUser(await sessionToken(), {
      loginIdentifier: text(body, "loginIdentifier"), displayName: text(body, "displayName"),
      jobTitle: optionalText(body, "jobTitle"), contactEmail: optionalText(body, "contactEmail"), contactPhone: optionalText(body, "contactPhone"),
      status: status as "ACTIVE" | "DISABLED", roleIds: stringList(body, "roleIds")
    });
    return json({ ok: true, data: result }, 201);
  } catch (error) {
    return identityErrorResponse(error);
  }
}
