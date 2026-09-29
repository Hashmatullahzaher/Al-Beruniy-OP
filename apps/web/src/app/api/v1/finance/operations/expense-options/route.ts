import { operationalFinanceDateQuerySchema } from "@abos/contracts";
import { IdentityError } from "@abos/identity";

import {
  operationalExpenseEntryOptions,
  operationalExpenseErrorResponse
} from "@/server/operational-finance";
import { json } from "@/server/treasury";

export const dynamic = "force-dynamic";

/** Options for recording an expense on one business date, in the actor's live scope. */
export async function GET(request: Request) {
  try {
    const parsed = operationalFinanceDateQuerySchema.safeParse(
      Object.fromEntries(new URL(request.url).searchParams.entries())
    );
    if (!parsed.success) {
      throw new IdentityError("VALIDATION_FAILED", "Choose a valid expense date.", { fields: ["date"] });
    }
    return json({ ok: true, data: await operationalExpenseEntryOptions(parsed.data.date) });
  } catch (error) {
    return operationalExpenseErrorResponse(error);
  }
}
