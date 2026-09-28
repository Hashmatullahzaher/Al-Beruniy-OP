import type { Metadata } from "next";

import { ReversalRequestsWorkspace } from "@/components/ReversalRequestsWorkspace";

export const metadata: Metadata = {
  title: "Journal reversals",
  description: "Finance users request reversals of posted journals; the Finance Manager approves or rejects them."
};
export const dynamic = "force-dynamic";

export default function ReversalRequestsPage() {
  return <ReversalRequestsWorkspace />;
}
