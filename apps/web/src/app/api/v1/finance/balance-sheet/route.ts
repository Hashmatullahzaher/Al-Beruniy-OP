import { balanceSheetGet } from "@/server/reporting";

export const dynamic = "force-dynamic";
/** ?asOf= | ?fiscalYearId= | ?periodId=: assets, liabilities and equity at that date, with its proof. Reads only. */
export const GET = balanceSheetGet;
