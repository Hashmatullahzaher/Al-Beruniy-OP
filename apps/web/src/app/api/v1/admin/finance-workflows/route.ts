import {
  assertMutation,
  identityErrorResponse,
  identityRuntime,
  readBody,
  sessionToken
} from "@/server/identity";
import { json } from "@/server/treasury";

export const dynamic = "force-dynamic";

/** Read the current legal entity's append-only workflow policy history. */
export async function GET() {
  try {
    return json({
      ok: true,
      data: await identityRuntime().service.financeWorkflowPolicies(await sessionToken())
    });
  } catch (error) {
    return identityErrorResponse(error);
  }
}

/** Append a policy version. The database derives actor/entity and enforces admin authority. */
export async function PUT(request: Request) {
  try {
    assertMutation(request);
    const body = await readBody(request);
    const data = await identityRuntime().service.setFinanceWorkflowPolicy(await sessionToken(), {
      workflowType: typeof body.workflowType === "string" ? body.workflowType : "",
      approvalRequired: body.approvalRequired,
      expectedVersion: body.expectedVersion,
      changeReason: body.changeReason
    });
    return json({ ok: true, data });
  } catch (error) {
    return identityErrorResponse(error);
  }
}
