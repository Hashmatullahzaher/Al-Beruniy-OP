import { operationalFinanceConfiguration, operationalFinanceErrorResponse } from "@/server/operational-finance";
import { json } from "@/server/treasury";

export const dynamic = "force-dynamic";

/** Read the current legal entity's protected operational Finance configuration workspace. */
export async function GET() {
  try {
    return json({ ok: true, data: await operationalFinanceConfiguration() });
  } catch (error) {
    return operationalFinanceErrorResponse(error);
  }
}
