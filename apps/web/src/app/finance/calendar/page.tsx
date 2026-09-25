import type { Metadata } from "next";

import { FinanceCalendarWorkspace } from "@/components/FinanceCalendarWorkspace";

export const metadata: Metadata = { title: "Financial calendar", description: "Company financial year and accounting periods." };
export const dynamic = "force-dynamic";

export default function FinanceCalendarPage() {
  return <FinanceCalendarWorkspace />;
}
