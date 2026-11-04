import type { Metadata } from "next";
import { Suspense } from "react";

import { IncomeStatementWorkspace } from "@/components/FinancialStatementsWorkspace";

export const metadata: Metadata = { title: "Income statement", description: "Income less expenses, from the ledger." };
export const dynamic = "force-dynamic";

export default function Page() {
  return <Suspense fallback={null}><IncomeStatementWorkspace /></Suspense>;
}
