import { financeToken, financeTrace } from "@/server/finance-handoff";
import { errorResponse, json } from "@/server/treasury";

export const dynamic = "force-dynamic";
export async function GET(_request: Request, { params }: { params: Promise<{ handoffId: string }> }) {
  try {
    const { handoffId } = await params;
    return json({ ok: true, data: await financeTrace(await financeToken(), handoffId) });
  } catch (error) { return errorResponse(error); }
}
