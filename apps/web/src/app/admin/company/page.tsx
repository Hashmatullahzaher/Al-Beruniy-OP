import type { Metadata } from "next";

import { CompanyWorkspace } from "@/components/CompanyWorkspace";

export const metadata: Metadata = { title: "Company", description: "Company configuration: legal details, currencies and financial year." };
export const dynamic = "force-dynamic";

export default function CompanyPage() {
  return <CompanyWorkspace />;
}
