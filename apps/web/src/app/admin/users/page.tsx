import type { Metadata } from "next";

import { AdminUsersWorkspace } from "@/components/AdminUsersWorkspace";

export const metadata: Metadata = { title: "Users", description: "Employee accounts, roles and access history." };
export const dynamic = "force-dynamic";

export default function AdminUsersPage() {
  return <AdminUsersWorkspace />;
}
