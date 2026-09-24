import type { Metadata } from "next";
import { FinanceHandoffWorkspace } from "@/components/FinanceHandoffWorkspace";

export const metadata: Metadata = { title: "Finance handoffs", description: "Synthetic E1 Treasury-to-Finance workflow" };
export default function FinanceHandoffsPage() { return <FinanceHandoffWorkspace />; }
