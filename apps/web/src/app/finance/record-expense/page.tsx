import type { Metadata } from "next";

import { RecordExpenseWorkspace } from "@/components/RecordExpenseWorkspace";

export const metadata: Metadata = { title: "Record expense", description: "Record money paid out from a Treasury account." };
export const dynamic = "force-dynamic";

export default function Page() {
  return <RecordExpenseWorkspace />;
}
