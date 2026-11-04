import type { Metadata } from "next";
import { Suspense } from "react";

import { BalanceSheetWorkspace } from "@/components/FinancialStatementsWorkspace";

export const metadata: Metadata = { title: "Balance sheet", description: "Assets, liabilities and equity at a date." };
export const dynamic = "force-dynamic";

export default function Page() {
  return <Suspense fallback={null}><BalanceSheetWorkspace /></Suspense>;
}
