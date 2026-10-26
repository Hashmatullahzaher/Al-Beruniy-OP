import type { Metadata } from "next";

import { ShareholderSetupWorkspace } from "@/components/ShareholderSetupWorkspace";

export const metadata: Metadata = { title: "Shareholder records" };
export const dynamic = "force-dynamic";

// Preserved records remain available at an explicit route; they are not a step in receiving capital.
export default function PreservedShareholderRecordsPage() {
  return <ShareholderSetupWorkspace />;
}
