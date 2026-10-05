import { shareholderContributionsWorkspace, shareholderSetupErrorResponse } from "@/server/shareholder-setup";
import { json } from "@/server/treasury";

export const dynamic = "force-dynamic";

/**
 * Shareholders with their contribution declarations (0035) and any legacy cash capital agreements.
 * Read only. Contribution changes go through POST /api/v1/shareholder/setup.
 */
export async function GET() {
  try {
    return json({ ok: true, data: await shareholderContributionsWorkspace() });
  } catch (error) {
    return shareholderSetupErrorResponse(error);
  }
}
