import { currentTreasury, errorResponse, json } from "@/server/treasury";
import { buildOverview } from "@/server/treasury-view";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return json({ ok: true, data: await buildOverview(await currentTreasury()) });
  } catch (error) {
    return errorResponse(error);
  }
}
