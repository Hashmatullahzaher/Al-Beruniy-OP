import type { Metadata } from "next";

import { FinancialYearWorkspace } from "@/components/FinancialYearWorkspace";

export const metadata: Metadata = {
  title: "Financial year",
  description: "Financial years and their status; close a financial year at year end after reviewing it."
};
export const dynamic = "force-dynamic";

export default function FinancialYearPage() {
  return <FinancialYearWorkspace />;
}
