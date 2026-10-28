import type { Metadata } from "next";

import { JournalReversalsWorkspace } from "@/components/JournalReversalsWorkspace";

export const metadata: Metadata = {
  title: "Journal reversals",
  description: "Correct a posted transaction with an exact, linked reversal: directly in Simple mode, or requested and approved by another person."
};
export const dynamic = "force-dynamic";

export default function ReversalRequestsPage() {
  return <JournalReversalsWorkspace />;
}
