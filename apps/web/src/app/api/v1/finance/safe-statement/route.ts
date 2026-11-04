import { safeStatementGet } from "@/server/reporting";

export const dynamic = "force-dynamic";
/** No query: the accounts this reader may open. ?accountId= with ?periodId= | ?from=&to= | ?asOf=: one statement. Reads only. */
export const GET = safeStatementGet;
