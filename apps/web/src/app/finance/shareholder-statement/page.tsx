import type { Metadata } from "next";
import { Suspense } from "react";

import { ShareholderStatementWorkspace } from "@/components/ShareholderStatementWorkspace";

export const metadata: Metadata = {
  title: "Shareholder statement",
  description: "A shareholder's capital and, separately, what the company owes them as a loan."
};
export const dynamic = "force-dynamic";

export default function ShareholderStatementPage() {
  return <Suspense fallback={null}><ShareholderStatementWorkspace /></Suspense>;
}
