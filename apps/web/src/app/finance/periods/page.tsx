import type { Metadata } from "next";

import { PeriodsWorkspace } from "@/components/PeriodsWorkspace";

export const metadata: Metadata = {
  title: "Financial periods",
  description: "Close an accounting month after reviewing it, and reopen it with a written reason."
};
export const dynamic = "force-dynamic";

export default function FinancialPeriodsPage() {
  return <PeriodsWorkspace />;
}
