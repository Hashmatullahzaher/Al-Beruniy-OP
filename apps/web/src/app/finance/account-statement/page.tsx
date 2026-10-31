import type { Metadata } from "next";
import { Suspense } from "react";

import { AccountStatementWorkspace } from "@/components/AccountStatementWorkspace";

export const metadata: Metadata = {
  title: "Account statement",
  description: "One account's posted movements with a running balance, from opening to closing."
};
export const dynamic = "force-dynamic";

export default function AccountStatementPage() {
  return <Suspense fallback={null}><AccountStatementWorkspace /></Suspense>;
}
