import { accountInput, chartErrorResponse, chartOfAccountsView, createAccount } from "@/server/chart-of-accounts";
import { assertMutation, readBody } from "@/server/identity";
import { json } from "@/server/treasury";

export const dynamic = "force-dynamic";

/** The company's Chart of Accounts, with the review list, for anyone who may view it. */
export async function GET() {
  try {
    return json({ ok: true, data: await chartOfAccountsView() });
  } catch (error) {
    return chartErrorResponse(error);
  }
}

/** Creates an account that is usable at once and waits in the review list. */
export async function POST(request: Request) {
  try {
    assertMutation(request);
    const body = await readBody(request);
    return json({ ok: true, data: await createAccount(accountInput(body.account), body.confirmDuplicates === true) }, 201);
  } catch (error) {
    return chartErrorResponse(error);
  }
}
