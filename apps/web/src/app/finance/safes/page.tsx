import type { Metadata } from "next";

import { SafesWorkspace } from "@/components/SafesWorkspace";

export const metadata: Metadata = {
  title: "Safes",
  description: "Every Safe with its real book balance, opening balance and recent movements."
};
export const dynamic = "force-dynamic";

export default function Page() {
  return <SafesWorkspace />;
}
