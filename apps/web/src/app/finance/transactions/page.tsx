import type { Metadata } from "next";

import { TransactionRegisterWorkspace } from "@/components/TransactionRegisterWorkspace";

export const metadata: Metadata = { title: "Daily transactions", description: "Expenses recorded in a date range." };
export const dynamic = "force-dynamic";

export default function Page() {
  return <TransactionRegisterWorkspace />;
}
