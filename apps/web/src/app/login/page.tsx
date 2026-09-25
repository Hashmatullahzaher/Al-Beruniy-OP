import type { Metadata } from "next";
import { Suspense } from "react";

import { LoginWorkspace } from "@/components/LoginWorkspace";

export const metadata: Metadata = { title: "Sign in", description: "Employee sign-in for the AL-BERUNIY Operating System preview." };
export const dynamic = "force-dynamic";

export default function LoginPage() {
  return <Suspense fallback={null}><LoginWorkspace /></Suspense>;
}
