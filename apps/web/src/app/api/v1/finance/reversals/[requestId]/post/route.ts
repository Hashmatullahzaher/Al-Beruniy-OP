import { assertMutation } from "@/server/identity";
import { reversalErrorResponse } from "@/server/reversals";
import { json } from "@/server/treasury";

export const dynamic = "force-dynamic";

/**
 * Posting an approved reversal is deliberately unavailable (fail-closed). The Finance Manager has
 * not yet decided which date and accounting period a reversal journal uses, what evidence it needs
 * beyond the written reason, or what happens to the source records (capital receipt, installment,
 * commitment, safe custody) when a capital journal is reversed. Nothing is written.
 */
export async function POST(request: Request) {
  try {
    assertMutation(request);
    return json({ ok: false, error: {
      code: "POSTING_POLICY_PENDING",
      message: "The approved reversal awaits the Finance Manager's posting policy (reversal date and period, evidence, and effects on source records). No reversal journal is created."
    } }, 409);
  } catch (error) {
    return reversalErrorResponse(error);
  }
}
