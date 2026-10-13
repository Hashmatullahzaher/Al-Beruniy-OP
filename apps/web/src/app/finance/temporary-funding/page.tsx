import type { Metadata } from "next";

import { TemporaryFundingWorkspace } from "@/components/TemporaryFundingWorkspace";

export const metadata: Metadata = {
  title: "Temporary funding",
  description: "Money a person or organization put in for the company, owed back to them and kept apart from Safe cash."
};
export const dynamic = "force-dynamic";

export default function Page() {
  return <TemporaryFundingWorkspace />;
}
