import type { Metadata } from "next";

import { FinanceWorkflowPolicyWorkspace } from "@/components/FinanceWorkflowPolicyWorkspace";

export const metadata: Metadata = {
  title: "Finance workflow policy",
  description: "Company approval requirements for operational finance workflows."
};
export const dynamic = "force-dynamic";

export default function FinanceWorkflowPolicyPage() {
  return <FinanceWorkflowPolicyWorkspace />;
}
