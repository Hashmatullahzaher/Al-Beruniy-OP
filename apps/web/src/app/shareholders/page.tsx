import type { Metadata } from "next";

import { ShareholderRequestWorkspace } from "@/components/ShareholderRequestWorkspace";

export const metadata: Metadata = { title: "Shareholder capital", description: "Capital agreements, installments and capital requests." };
export const dynamic = "force-dynamic";

export default function ShareholdersPage() {
  return <ShareholderRequestWorkspace />;
}
