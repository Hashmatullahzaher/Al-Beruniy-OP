import { operationalTreasuryAccountUpsertSchema } from "@abos/contracts";
import { IdentityError } from "@abos/identity";

import { assertMutation, readBody } from "@/server/identity";
import { operationalFinanceErrorResponse, upsertOperationalTreasuryAccount } from "@/server/operational-finance";
import { json } from "@/server/treasury";

export const dynamic = "force-dynamic";

/** Create or update one immutable-mapped operational Treasury account. */
export async function PUT(request: Request) {
  try {
    assertMutation(request);
    const parsed = operationalTreasuryAccountUpsertSchema.safeParse(await readBody(request));
    if (!parsed.success) {
      throw new IdentityError("VALIDATION_FAILED", "Enter valid Treasury account configuration.", {
        fields: parsed.error.issues.map(issue => issue.path.join("."))
      });
    }
    return json({ ok: true, data: await upsertOperationalTreasuryAccount(parsed.data) });
  } catch (error) {
    return operationalFinanceErrorResponse(error);
  }
}
