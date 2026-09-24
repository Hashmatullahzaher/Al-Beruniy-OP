import { approvePosting, financeToken, postApproved, preparePosting } from "@/server/finance-handoff";
import { assertSameOrigin, errorResponse, json, readJson, stringField } from "@/server/treasury";

export const dynamic = "force-dynamic";
const ACTIONS = new Set(["prepare", "approve", "post"]);

export async function POST(request: Request, { params }: { params: Promise<{ handoffId: string; action: string }> }) {
  try {
    assertSameOrigin(request);
    const { handoffId, action } = await params;
    if (!ACTIONS.has(action)) return json({ ok: false, error: { code: "NOT_FOUND", message: "Unknown Finance action." } }, 404);
    const token = await financeToken();
    const body = await readJson(request);
    const accountingPeriodId = stringField(body, "accountingPeriodId");
    if (action === "prepare") {
      const postingIntentId = await preparePosting(token, handoffId, accountingPeriodId, stringField(body, "idempotencyKey"));
      return json({ ok: true, data: { postingIntentId } });
    }
    const postingIntentId = stringField(body, "postingIntentId");
    if (action === "approve") {
      const approvalId = await approvePosting(token, postingIntentId);
      return json({ ok: true, data: { approvalId } });
    }
    const journalId = await postApproved(token, postingIntentId, accountingPeriodId);
    return json({ ok: true, data: { journalId } });
  } catch (error) { return errorResponse(error); }
}
