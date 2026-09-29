import type { Metadata } from "next";

import { FinanceSetupWorkspace } from "@/components/FinanceSetupWorkspace";

export const metadata: Metadata = { title: "Finance setup", description: "Treasury accounts, expense types and accounting periods." };
export const dynamic = "force-dynamic";

export default function Page() {
  return <FinanceSetupWorkspace />;
}
