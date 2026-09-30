import type { Metadata } from "next";

import { GeneralLedgerWorkspace } from "@/components/GeneralLedgerWorkspace";

export const metadata: Metadata = {
  title: "Posted General Ledger activity",
  description: "Read-only posted journal activity with source trace and dual-calendar dates."
};
export const dynamic = "force-dynamic";

export default function GeneralLedgerPage() {
  return <GeneralLedgerWorkspace />;
}
