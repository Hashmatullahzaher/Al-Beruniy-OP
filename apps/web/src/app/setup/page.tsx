import type { Metadata } from "next";

import { GettingStartedWorkspace } from "@/components/GettingStartedWorkspace";

export const metadata: Metadata = { title: "Getting started", description: "From first sign-in to the first posted transaction." };
export const dynamic = "force-dynamic";

export default function Page() {
  return <GettingStartedWorkspace />;
}
