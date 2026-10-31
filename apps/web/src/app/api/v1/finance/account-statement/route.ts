import { accountStatementGet } from "@/server/reporting";

export const dynamic = "force-dynamic";
/** ?accountId= with ?periodId= | ?from=&to= | ?asOf=: one account statement with a running balance. Reads only. */
export const GET = accountStatementGet;
