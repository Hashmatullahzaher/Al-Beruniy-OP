import type { CashLocationId, UserAccountId } from "@abos/contracts";
import { SandboxAuthError } from "@abos/sandbox-auth";

import { assertSameOrigin, currentTreasury, errorResponse, hasTreasuryPermission, json, readJson, stringField } from "@/server/treasury";

export const dynamic = "force-dynamic";

type Context = { readonly params: Promise<{ readonly locationId: string }> };

/** People who could be given custody of this safe. Only a Treasury manager may ask. */
export async function GET() {
  try {
    const treasury = await currentTreasury();
    if (!hasTreasuryPermission(treasury.actor, "treasury.cash-location.manage")) {
      throw new SandboxAuthError("PERMISSION_DENIED", "Managing safes requires the Treasury manager permission.");
    }
    const users = await treasury.reader.listUsers(treasury.actor.legalEntityId);
    return json({ ok: true, data: users
      .filter((row) => String(row.id) !== treasury.actor.userAccountId)
      .map((row) => ({ userAccountId: String(row.id), displayName: String(row.display_name) })) });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Assigns a cashier to the safe through the existing Treasury service and restricted database command. */
export async function POST(request: Request, { params }: Context) {
  try {
    assertSameOrigin(request);
    const body = await readJson(request);
    const treasury = await currentTreasury();
    const assignmentId = await treasury.service.assignCashier(treasury.actor, {
      cashLocationId: (await params).locationId as CashLocationId,
      userAccountId: stringField(body, "userAccountId") as UserAccountId
    });
    return json({ ok: true, data: { assignmentId } }, 201);
  } catch (error) {
    return errorResponse(error);
  }
}
