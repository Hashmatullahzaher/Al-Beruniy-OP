import { generalLedgerActivity, ledgerErrorResponse, ledgerValidationFailed, parseLedgerQuery } from "@/server/general-ledger";
import { json } from "@/server/treasury";

export const dynamic = "force-dynamic";

/** Posted activity per account and base currency in the range. Not a balance (no opening balances). */
export async function GET(request: Request) {
  const query = parseLedgerQuery(new URL(request.url).searchParams, false);
  if (query === null) return ledgerValidationFailed();
  try {
    return json({ ok: true, data: await generalLedgerActivity(query.from, query.to, query.accountId) });
  } catch (error) {
    return ledgerErrorResponse(error);
  }
}
