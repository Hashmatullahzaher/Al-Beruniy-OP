import { financeToken, financeWorkspace } from "@/server/finance-handoff";
import { errorResponse, json } from "@/server/treasury";

export const dynamic = "force-dynamic";
export async function GET() {
  try { return json({ ok: true, data: await financeWorkspace(await financeToken()) }); }
  catch (error) { return errorResponse(error); }
}
