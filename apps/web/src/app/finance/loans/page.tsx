import type { Metadata } from "next";
import { Suspense } from "react";

import { LoansWorkspace } from "@/components/LoansWorkspace";

export const metadata: Metadata = { title: "Loans", description: "Money lent to the company, what has been repaid and what is still owed." };
export const dynamic = "force-dynamic";

export default function Page() {
  return <Suspense><LoansWorkspace /></Suspense>;
}
