import type { Metadata } from "next";

import { ExchangeRatesWorkspace } from "@/components/ExchangeRatesWorkspace";

export const metadata: Metadata = { title: "Exchange rates", description: "Daily USD–AFN market and Saraf rates." };
export const dynamic = "force-dynamic";

export default function ExchangeRatesPage() {
  return <ExchangeRatesWorkspace />;
}
