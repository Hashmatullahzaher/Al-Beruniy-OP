import { moneyGet, moneyPost } from "@/server/treasury-money";

export const dynamic = "force-dynamic";
/** What the receive, transfer and pay forms need for the signed-in company. */
export const GET = moneyGet;
/** { action: "receive-cash" | "transfer" | "pay-payable", ...fields }. Repeating the same request key replays. */
export const POST = moneyPost;
