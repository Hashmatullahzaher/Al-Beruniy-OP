import { trialBalanceGet } from "@/server/reporting";

export const dynamic = "force-dynamic";
/** ?periodId= | ?from=&to= | ?asOf= [&includeZero=true]: the trial balance from posted journals. Reads only. */
export const GET = trialBalanceGet;
