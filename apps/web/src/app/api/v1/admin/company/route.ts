import { assertMutation, identityErrorResponse, identityRuntime, optionalText, readBody, sessionToken } from "@/server/identity";
import { json } from "@/server/treasury";

export const dynamic = "force-dynamic";

/** Company details for any signed-in employee; changes need admin.company.manage. */
export async function GET() {
  try {
    return json({ ok: true, data: await identityRuntime().service.companyProfile(await sessionToken()) });
  } catch (error) {
    return identityErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    assertMutation(request);
    const body = await readBody(request);
    const data = await identityRuntime().service.updateCompanyProfile(await sessionToken(), {
      legalName: optionalText(body, "legalName"), registrationNumber: optionalText(body, "registrationNumber"),
      goLiveDate: optionalText(body, "goLiveDate"),
      expectedVersion: typeof body.expectedVersion === "number" ? body.expectedVersion : -1
    });
    return json({ ok: true, data });
  } catch (error) {
    return identityErrorResponse(error);
  }
}
