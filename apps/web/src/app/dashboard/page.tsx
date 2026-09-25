import type { Metadata } from "next";

import { DashboardWorkspace } from "@/components/DashboardWorkspace";

export const metadata: Metadata = { title: "My dashboard", description: "Your work and access in the V1 client preview." };
export const dynamic = "force-dynamic";

export default function DashboardPage() {
  return <DashboardWorkspace />;
}
