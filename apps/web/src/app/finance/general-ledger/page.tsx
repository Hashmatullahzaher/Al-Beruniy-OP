import type { Metadata } from "next";
import { Suspense } from "react";

import { GeneralLedgerWorkspace } from "@/components/GeneralLedgerWorkspace";

export const metadata: Metadata = {
  title: "Posted General Ledger activity",
  description: "Read-only posted journal activity with source trace and dual-calendar dates."
};
export const dynamic = "force-dynamic";

export default function GeneralLedgerPage() {
  return <Suspense fallback={null}><GeneralLedgerWorkspace /></Suspense>;
}
