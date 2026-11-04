import type { Metadata } from "next";
import { Suspense } from "react";

import { SafeStatementWorkspace } from "@/components/SafeStatementWorkspace";

export const metadata: Metadata = {
  title: "Safe / Saraf statement",
  description: "One Safe or Saraf's posted movements in its own currency, with a running balance."
};
export const dynamic = "force-dynamic";

export default function SafeStatementPage() {
  return <Suspense fallback={null}><SafeStatementWorkspace /></Suspense>;
}
