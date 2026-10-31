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
  const known =
    /no accounting period covers/i.test(message)
      ? ["PERIOD_MISSING", "No month in your financial year covers this date. Generate the financial year first."]
    : /financial year covering .* is closed|cannot be reopened automatically/i.test(message)
      ? ["PERIOD_CLOSED", "The financial year of this date is closed. Choose a date in an active financial year."]
    : /contributed assets" account/i.test(message)
      ? ["ASSET_ACCOUNT_REQUIRED", "Create one active \"shareholder contributed assets\" account in the Chart of Accounts before recording an asset."]
    : /expense account/i.test(message)
      ? ["EXPENSE_ACCOUNT_REQUIRED", "Choose an active expense account in the accounting currency."]
    : /name the saraf/i.test(message)
      ? ["SARAF_REQUIRED", "Name the saraf the hawala came through."]
    : /describe the asset, or the bill/i.test(message)
      ? ["DESCRIPTION_REQUIRED", "Describe the asset, or the bill that was paid."]
    : /choose the Safe|does not move a Safe/i.test(message)
      ? ["DESTINATION_MISMATCH", "Cash and hawala need the Safe they went into; an asset or a paid bill does not."]
    : /currency|CASH asset/i.test(message)
      ? ["CURRENCY_MISMATCH", "Choose an active Safe in the approved accounting currency."]
    : /capital approval setting|capital equity account/i.test(message)
      ? ["CONFIGURATION_REQUIRED", "Finance configuration must be completed before recording capital."] : null;
  if (known) return json({ ok: false, error: { code: known[0], message: known[1] } }, 422);
  return shareholderSetupErrorResponse(error);
}
