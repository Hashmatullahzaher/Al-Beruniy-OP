import { financialSummaryGet } from "@/server/reporting";

export const dynamic = "force-dynamic";
/** ?periodId= | ?fiscalYearId= | ?from=&to= | ?asOf=: the Treasury position, money in and out, and the result. Reads only. */
export const GET = financialSummaryGet;
