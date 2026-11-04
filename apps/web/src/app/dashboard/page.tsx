import type { Metadata } from "next";

import { DashboardWorkspace } from "@/components/DashboardWorkspace";

export const metadata: Metadata = { title: "My dashboard", description: "Your work and access." };
export const dynamic = "force-dynamic";

export default function DashboardPage() {
  return <DashboardWorkspace />;
}
