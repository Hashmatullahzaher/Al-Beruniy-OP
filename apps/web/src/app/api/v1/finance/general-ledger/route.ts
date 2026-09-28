import { generalLedgerView, ledgerErrorResponse, ledgerValidationFailed, parseLedgerQuery } from "@/server/general-ledger";
import { json } from "@/server/treasury";

export const dynamic = "force-dynamic";

/** Posted GL lines, one keyset page at a time: `cursor` is the previous page's `nextCursor`. */
export async function GET(request: Request) {
  const query = parseLedgerQuery(new URL(request.url).searchParams, true);
  if (query === null) return ledgerValidationFailed();
  try {
    return json({ ok: true, data: await generalLedgerView(query.from, query.to, query.accountId, query.cursor, query.pageSize) });
  } catch (error) {
    return ledgerErrorResponse(error);
  }
}
