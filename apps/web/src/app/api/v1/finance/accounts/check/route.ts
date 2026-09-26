import { accountInput, chartErrorResponse, checkAccount } from "@/server/chart-of-accounts";
import { assertMutation, optionalText, readBody } from "@/server/identity";
import { json } from "@/server/treasury";

export const dynamic = "force-dynamic";

/** Live duplicate check while a person types. Changes nothing. */
export async function POST(request: Request) {
  try {
    assertMutation(request);
    const body = await readBody(request);
    return json({ ok: true, data: await checkAccount(accountInput(body.account), optionalText(body, "accountId")) });
  } catch (error) {
    return chartErrorResponse(error);
  }
}
