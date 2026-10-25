import { directShareholderCommandSchema } from "@abos/contracts";
import { financeHandoffRuntime } from "@/server/finance-handoff";
import { restrictedFinanceAuthenticator } from "@/server/operational-finance";
import { assertMutation, readBody, sessionToken } from "@/server/identity";
import { shareholderSetupErrorResponse } from "@/server/shareholder-setup";

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-ABOS-Data": "operational" } });
}

export async function directCapitalGet(): Promise<Response> {
  try {
    const data = await restrictedFinanceAuthenticator().directCapitalWorkspace(financeHandoffRuntime().executor, await sessionToken());
    return json({ ok: true, data });
  } catch (error) { return directCapitalErrorResponse(error); }
}

export async function directCapitalPost(request: Request): Promise<Response> {
  try {
    assertMutation(request);
    const token = await sessionToken();
    const command = directShareholderCommandSchema.safeParse(await readBody(request));
    if (!command.success) return json({ ok: false, error: { code: "VALIDATION_FAILED", message: "Check the name, amount, currency, date and optional details." } }, 422);
    const executor = financeHandoffRuntime().executor;
    const authenticator = restrictedFinanceAuthenticator();
    // Read authority is checked before the mutation too; an otherwise permitted API writer must
    // not commit a financial event and then fail only because it cannot read its result workspace.
    await authenticator.directCapitalWorkspace(executor, token);
    const result = await authenticator.directCapitalCommand(executor, token, command.data);
    const workspace = await authenticator.directCapitalWorkspace(executor, token);
    return json({ ok: true, data: { ...result, workspace } }, result.replayed ? 200 : 201);
  } catch (error) { return directCapitalErrorResponse(error); }
}

function directCapitalErrorResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : "";
  const known = /exceeds available outstanding capital/i.test(message) ? ["OVER_RECEIPT", "The receipt exceeds outstanding capital."]
    : /no open accounting period/i.test(message) ? ["PERIOD_NOT_OPEN", "No open accounting period covers this date."]
    : /currency|CASH asset/i.test(message) ? ["CURRENCY_MISMATCH", "Choose an active Safe in the approved accounting currency."]
    : /capital approval setting|capital equity account/i.test(message) ? ["CONFIGURATION_REQUIRED", "Finance configuration must be completed before receiving capital."] : null;
  if (known) return json({ ok: false, error: { code: known[0], message: known[1] } }, 422);
  return shareholderSetupErrorResponse(error);
}
