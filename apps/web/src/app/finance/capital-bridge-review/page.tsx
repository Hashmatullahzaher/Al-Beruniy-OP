import type { Metadata } from "next";

import { CapitalBridgeReviewWorkspace } from "@/components/CapitalBridgeReviewWorkspace";

import "./capital-bridge-review.css";

export const metadata: Metadata = {
  title: "Shareholder capital bridge · isolated review",
  description: "Memory-only workflow prototype. No operational receipts or accounting entries."
};

export default function Page() {
  return <CapitalBridgeReviewWorkspace />;
}
