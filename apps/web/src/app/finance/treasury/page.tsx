import type { Metadata } from "next";

import { TreasuryWorkspace } from "@/components/TreasuryWorkspace";

export const metadata: Metadata = {
  title: "Treasury",
  description: "E1 synthetic sandbox: office safes, independent USD and AFN accounts, cash receipts, counts, independent verification and handoff to Finance."
};

// Treasury state is per-request and per-person; nothing here is prerendered.
export const dynamic = "force-dynamic";

export default function TreasuryPage() {
  return <TreasuryWorkspace />;
}
