import type { Metadata } from "next";

import { ShareholderSetupWorkspace } from "@/components/ShareholderSetupWorkspace";

export const metadata: Metadata = { title: "Shareholders", description: "Shareholders, capital agreements, installments and capital requests." };
export const dynamic = "force-dynamic";

export default function ShareholdersPage() {
  return <ShareholderSetupWorkspace />;
}
