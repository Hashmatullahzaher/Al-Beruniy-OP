import { companyDashboardErrorResponse, companyDashboardSummary } from "@/server/company-dashboard";
import { json } from "@/server/treasury";

export const dynamic = "force-dynamic";

/** Aggregate company dashboard figures, only for people holding company.dashboard.read. */
export async function GET() {
  try {
    return json({ ok: true, data: await companyDashboardSummary() });
  } catch (error) {
    return companyDashboardErrorResponse(error);
  }
}
