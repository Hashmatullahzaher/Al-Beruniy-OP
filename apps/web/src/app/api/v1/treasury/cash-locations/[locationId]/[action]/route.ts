import { TreasuryDomainError } from "@abos/treasury";

import { assertMutation } from "@/server/identity";
import { errorResponse, json, readJson, stringField } from "@/server/treasury";
import { asCurrency, asLocationId, currentSafes } from "@/server/treasury-safes";

export const dynamic = "force-dynamic";

type Context = { readonly params: Promise<{ readonly locationId: string; readonly action: string }> };

/**
 * Safe actions: `activate` (the safe itself) and `open-account` (a USD or AFN account linked to a
 * CASH ledger account the user chose from the Chart of Accounts).
 */
export async function POST(request: Request, { params }: Context) {
  try {
    assertMutation(request);
    const { locationId, action } = await params;
    const body = await readJson(request);
    const context = await currentSafes();
    if (action === "activate") {
      await context.service.activateSafe(context.actor, asLocationId(locationId));
      return json({ ok: true, data: { cashLocationId: locationId } });
    }
    if (action === "open-account") {
      const currency = asCurrency(stringField(body, "currency"));
      if (currency === undefined) throw new TreasuryDomainError("CURRENCY_MISMATCH", "A safe account is USD or AFN.");
      const cashAccountId = await context.safes.openCurrencyAccount(context.actor, {
        cashLocationId: asLocationId(locationId), currency, ledgerAccountId: stringField(body, "ledgerAccountId")
      });
      return json({ ok: true, data: { cashAccountId } }, 201);
    }
    return json({ ok: false, error: { code: "NOT_FOUND", message: `Unknown safe action ${action}` } }, 404);
  } catch (error) {
    return errorResponse(error);
  }
}
