import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { CompanyDashboardWorkspace } from "@/components/CompanyDashboardWorkspace";
import { companyDashboardAccess } from "@/server/company-dashboard";

export const metadata: Metadata = {
  title: "Company dashboard",
  description: "Company-wide summary figures from the modules connected in V1."
};
export const dynamic = "force-dynamic";

/**
 * The company-wide dashboard. Access is decided on the server before anything renders, so no
 * company figure reaches a browser that is not allowed to see it; the figures themselves come only
 * from the protected API, which PostgreSQL authorizes again.
 */
export default async function CompanyDashboardPage() {
  const access = await companyDashboardAccess();
  if (access === "sign-in") redirect("/login");
  if (access === "own-workspace") redirect("/dashboard");
  return <CompanyDashboardWorkspace />;
}
