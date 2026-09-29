import type { Metadata } from "next";

import { DailyFinancialReportWorkspace } from "@/components/DailyFinancialReportWorkspace";

export const metadata: Metadata = { title: "Daily financial report", description: "What was paid out on one day." };
export const dynamic = "force-dynamic";

export default function Page() {
  return <DailyFinancialReportWorkspace />;
}
