import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { CapitalBridgeReviewWorkspace } from "@/components/CapitalBridgeReviewWorkspace";
import { shareholderFinanceCapability } from "@/server/shareholder-finance-bridge";

import "./capital-bridge-review.css";

export const metadata: Metadata = {
  title: "Shareholder capital bridge · isolated review",
  description: "Memory-only workflow prototype. No operational receipts or accounting entries."
};

export const dynamic = "force-dynamic";

export default function Page() {
  if (!shareholderFinanceCapability().reviewModeAvailable) notFound();
  return <CapitalBridgeReviewWorkspace />;
}
