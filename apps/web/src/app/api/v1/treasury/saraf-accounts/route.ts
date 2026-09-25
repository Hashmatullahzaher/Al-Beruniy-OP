import { TreasuryDomainError } from "@abos/treasury";

import { assertMutation } from "@/server/identity";
import { errorResponse, json, readJson, stringField } from "@/server/treasury";
import { asCurrency, buildSafesView, currentSafes } from "@/server/treasury-safes";

export const dynamic = "force-dynamic";

/** Saraf accounts (set-up only: no transactions, transfers or balances exist in V1). */
export async function GET() {
  try {
    const view = await buildSafesView(await currentSafes());
    return json({ ok: true, data: { sarafAccounts: view.sarafAccounts, sarafParties: view.sarafParties, sarafLedgers: view.sarafLedgers } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    assertMutation(request);
    const body = await readJson(request);
    const currency = asCurrency(stringField(body, "currency"));
    if (currency === undefined) throw new TreasuryDomainError("CURRENCY_MISMATCH", "A Saraf account is USD or AFN.");
    const { safes, actor } = await currentSafes();
    const sarafAccountId = await safes.createSarafAccount(actor, {
      businessPartyId: stringField(body, "businessPartyId"), currency, ledgerAccountId: stringField(body, "ledgerAccountId")
    });
    return json({ ok: true, data: { sarafAccountId } }, 201);
  } catch (error) {
    return errorResponse(error);
  }
}
