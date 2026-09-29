import { operationalPeriodOpenSchema } from "@abos/contracts";
import { IdentityError } from "@abos/identity";

import { assertMutation, readBody } from "@/server/identity";
import { openOperationalFinancePeriod, operationalFinanceErrorResponse } from "@/server/operational-finance";
import { json } from "@/server/treasury";

export const dynamic = "force-dynamic";

/** Open one pending period. Closing and reopening remain intentionally unavailable. */
export async function POST(
  request: Request,
  { params }: { readonly params: Promise<{ readonly periodId: string }> }
) {
  try {
    assertMutation(request);
    const body = await readBody(request);
    const { periodId } = await params;
    const parsed = operationalPeriodOpenSchema.safeParse({
      periodId,
      expectedVersion: body.expectedVersion,
      reason: body.reason
    });
    if (!parsed.success) {
      throw new IdentityError("VALIDATION_FAILED", "Choose a pending period and enter a reason.", {
        fields: parsed.error.issues.map(issue => issue.path.join("."))
      });
    }
    return json({ ok: true, data: await openOperationalFinancePeriod(parsed.data) });
  } catch (error) {
    return operationalFinanceErrorResponse(error);
  }
}
