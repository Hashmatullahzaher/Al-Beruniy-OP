import { opaqueUuidSchema, operationalExpenseApproveBodySchema } from "@abos/contracts";
import { IdentityError } from "@abos/identity";

import { assertMutation, readBody } from "@/server/identity";
import {
  approveOperationalExpense,
  operationalExpenseErrorResponse
} from "@/server/operational-finance";
import { json } from "@/server/treasury";

export const dynamic = "force-dynamic";

/** Independently approve and post an expense that the current actor did not create. */
export async function POST(
  request: Request,
  { params }: { readonly params: Promise<{ readonly expenseId: string }> }
) {
  try {
    assertMutation(request);
    const { expenseId } = await params;
    const parsedId = opaqueUuidSchema.safeParse(expenseId);
    const parsedBody = operationalExpenseApproveBodySchema.safeParse(await readBody(request));
    if (!parsedId.success || !parsedBody.success) {
      throw new IdentityError("VALIDATION_FAILED", "Choose a current pending expense and enter an approval note.", {
        fields: [
          ...(parsedId.success ? [] : ["expenseId"]),
          ...(parsedBody.success ? [] : parsedBody.error.issues.map((issue) => issue.path.join(".")))
        ]
      });
    }
    return json({
      ok: true,
      data: await approveOperationalExpense(parsedId.data, parsedBody.data)
    });
  } catch (error) {
    return operationalExpenseErrorResponse(error);
  }
}
