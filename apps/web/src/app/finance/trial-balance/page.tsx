import type { Metadata } from "next";

import { TrialBalanceWorkspace } from "@/components/TrialBalanceWorkspace";

export const metadata: Metadata = {
  title: "Trial balance",
  description: "Every account's opening, period and ending debit and credit from posted journals, with the balance proof."
};
export const dynamic = "force-dynamic";

export default function TrialBalancePage() {
  return <TrialBalanceWorkspace />;
}
