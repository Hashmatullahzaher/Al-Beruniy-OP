import type { Metadata } from "next";

import { ChartOfAccountsWorkspace } from "@/components/ChartOfAccountsWorkspace";

export const metadata: Metadata = { title: "Chart of Accounts", description: "The company's own accounts and the Finance Manager's review list." };
export const dynamic = "force-dynamic";

export default function ChartOfAccountsPage() {
  return <ChartOfAccountsWorkspace />;
}
