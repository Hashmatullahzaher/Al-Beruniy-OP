import { loansGet, loansPost } from "@/server/loans";

export const dynamic = "force-dynamic";
/** The loan register, approvals and entry options of the signed-in company. */
export const GET = loansGet;
/** { action: "record" | "repay" | "decide", ... }. Repeating the same request key returns the first result. */
export const POST = loansPost;
