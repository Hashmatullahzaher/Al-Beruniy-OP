import type { Metadata } from "next";

import { DirectShareholderCapitalWorkspace } from "@/components/DirectShareholderCapitalWorkspace";

export const metadata: Metadata = { title: "Shareholders", description: "Shareholder capital, receipts and outstanding balances." };
export const dynamic = "force-dynamic";

export default function ShareholdersPage() {
  return <DirectShareholderCapitalWorkspace />;
}
