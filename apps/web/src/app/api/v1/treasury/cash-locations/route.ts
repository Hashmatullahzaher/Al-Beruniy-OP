import type { UserAccountId } from "@abos/contracts";

import { assertMutation } from "@/server/identity";
import { errorResponse, json, readJson, stringField } from "@/server/treasury";
import { buildSafesView, currentSafes } from "@/server/treasury-safes";

export const dynamic = "force-dynamic";

/** The Safes & accounts workspace: safes, their accounts, Saraf accounts and whole-safe counts. */
export async function GET() {
  try {
    return json({ ok: true, data: await buildSafesView(await currentSafes()) });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Creates a safe (DRAFT) through the existing Treasury service and restricted CREATE_LOCATION command. */
export async function POST(request: Request) {
  try {
    assertMutation(request);
    const body = await readJson(request);
    const { service, actor } = await currentSafes();
    const cashLocationId = await service.createOfficeSafe(actor, {
      name: stringField(body, "name"),
      responsibleCashierUserAccountId: stringField(body, "responsibleCashierUserAccountId") as UserAccountId
    });
    return json({ ok: true, data: { cashLocationId } }, 201);
  } catch (error) {
    return errorResponse(error);
  }
}
