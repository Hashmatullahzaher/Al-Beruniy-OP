import type { Metadata } from "next";
import { Suspense } from "react";

import { FinancialSummaryWorkspace } from "@/components/FinancialSummaryWorkspace";

export const metadata: Metadata = {
  title: "Financial summary",
  description: "Where the company's money came from and went, and the result of the period."
};
export const dynamic = "force-dynamic";

export default function FinancialSummaryPage() {
  return <Suspense fallback={null}><FinancialSummaryWorkspace /></Suspense>;
}
