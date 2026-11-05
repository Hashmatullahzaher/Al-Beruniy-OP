import type { Metadata } from "next";

import { AddMoneyWorkspace } from "@/components/AddMoneyWorkspace";

export const metadata: Metadata = { title: "Add money", description: "Say where company money came from, and record it in the right place." };
export const dynamic = "force-dynamic";

export default function Page() {
  return <AddMoneyWorkspace />;
}
