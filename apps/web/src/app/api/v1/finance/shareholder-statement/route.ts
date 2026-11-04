import { shareholderStatementGet } from "@/server/reporting";

export const dynamic = "force-dynamic";
/** A period, and optionally ?partyId=: company totals and the people this reader may see, or one person's equity and debt. Reads only. */
export const GET = shareholderStatementGet;
