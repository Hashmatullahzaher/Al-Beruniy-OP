import { incomeStatementGet } from "@/server/reporting";

export const dynamic = "force-dynamic";
/** A period: income less expenses by account, and the year to date. Reads only. */
export const GET = incomeStatementGet;
