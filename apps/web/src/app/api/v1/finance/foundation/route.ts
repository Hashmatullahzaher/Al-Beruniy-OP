import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(
    {
      stage: "E0_FOUNDATION",
      contractVersion: "0.1.0-e0",
      transactionCurrencies: ["USD", "AFN"],
      firstSlice: "USD_SHAREHOLDER_CAPITAL_TO_PHYSICAL_SAFE",
      postingAvailable: false,
      productionPostingAuthorized: false,
      blockers: [
        "IDENTITY_AND_SOD_FOUNDATION",
        "CLIENT_FINANCE_POLICY_APPROVAL",
        "APPROVED_CHART_OF_ACCOUNTS",
        "APPROVED_ACCOUNTING_PERIOD",
        "RECONCILED_SAFE_OPENING_POSITION"
      ]
    },
    {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
        "X-ABOS-Operational-Status": "foundation-only"
      }
    }
  );
}
