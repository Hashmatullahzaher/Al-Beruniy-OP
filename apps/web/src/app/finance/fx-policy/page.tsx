import type { Metadata } from "next";

import { FxPolicyWorkspace } from "@/components/FxPolicyWorkspace";

export const metadata: Metadata = {
  title: "FX policy",
  description: "How money in another currency is recorded in the accounting currency: rounding, decimal places and the FX difference account."
};
export const dynamic = "force-dynamic";

export default function FxPolicyPage() {
  return <FxPolicyWorkspace />;
}
