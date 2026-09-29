import {
  operationalExpenseCreateSchema,
  operationalExpenseWorkspaceQuerySchema
} from "@abos/contracts";
import { IdentityError } from "@abos/identity";

import { assertMutation, readBody } from "@/server/identity";
import {
  createOperationalExpense,
  operationalExpenseWorkspace,
  operationalExpenseErrorResponse
} from "@/server/operational-finance";
import { json } from "@/server/treasury";

export const dynamic = "force-dynamic";

/** Read expenses visible in the current actor's live legal-entity and dimension scope. */
export async function GET(request: Request) {
  try {
    const search = new URL(request.url).searchParams;
    const parsed = operationalExpenseWorkspaceQuerySchema.safeParse(
      Object.fromEntries(search.entries())
    );
    if (!parsed.success) {
      throw new IdentityError("VALIDATION_FAILED", "Choose a valid expense date range of at most 366 days.", {
        fields: parsed.error.issues.map((issue) => issue.path.join("."))
      });
    }
    return json({ ok: true, data: await operationalExpenseWorkspace(parsed.data) });
  } catch (error) {
    return operationalExpenseErrorResponse(error);
  }
}

/** Create, value and either route or directly post one expense under the persisted policy. */
export async function POST(request: Request) {
  try {
    assertMutation(request);
    const parsed = operationalExpenseCreateSchema.safeParse(await readBody(request));
    if (!parsed.success) {
      throw new IdentityError("VALIDATION_FAILED", "Enter complete valid expense details.", {
        fields: parsed.error.issues.map((issue) => issue.path.join("."))
      });
    }
    return json({ ok: true, data: await createOperationalExpense(parsed.data) });
  } catch (error) {
    return operationalExpenseErrorResponse(error);
  }
}
