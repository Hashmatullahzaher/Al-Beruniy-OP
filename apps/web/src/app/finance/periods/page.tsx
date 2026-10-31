import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/** The monthly close / reopen page is retired (0052); an old link lands on the financial year page. */
export default function FinancialPeriodsPage() {
  redirect("/finance/financial-year");
}
