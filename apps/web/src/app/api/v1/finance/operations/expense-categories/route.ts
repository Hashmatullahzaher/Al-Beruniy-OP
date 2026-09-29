import { operationalExpenseCategoryUpsertSchema } from "@abos/contracts";
import { IdentityError } from "@abos/identity";

import { assertMutation, readBody } from "@/server/identity";
import { operationalFinanceErrorResponse, upsertOperationalExpenseCategory } from "@/server/operational-finance";
import { json } from "@/server/treasury";

export const dynamic = "force-dynamic";

/** Create or update one expense category while preserving its immutable ledger mapping. */
export async function PUT(request: Request) {
  try {
    assertMutation(request);
    const parsed = operationalExpenseCategoryUpsertSchema.safeParse(await readBody(request));
    if (!parsed.success) {
      throw new IdentityError("VALIDATION_FAILED", "Enter valid expense-category configuration.", {
        fields: parsed.error.issues.map(issue => issue.path.join("."))
      });
    }
    return json({ ok: true, data: await upsertOperationalExpenseCategory(parsed.data) });
  } catch (error) {
    return operationalFinanceErrorResponse(error);
  }
}
