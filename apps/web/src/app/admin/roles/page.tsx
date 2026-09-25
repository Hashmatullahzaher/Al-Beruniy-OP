import type { Metadata } from "next";

import { AdminRolesWorkspace } from "@/components/AdminRolesWorkspace";

export const metadata: Metadata = { title: "Roles & permissions", description: "Custom roles built from the controlled permission catalogue." };
export const dynamic = "force-dynamic";

export default function AdminRolesPage() {
  return <AdminRolesWorkspace />;
}
