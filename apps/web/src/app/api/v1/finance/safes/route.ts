import { safesGet, safesPost } from "@/server/treasury-safes";

export const dynamic = "force-dynamic";
/** Safes of the signed-in company with balances derived from posted movements. */
export const GET = safesGet;
/** { action: "record-opening-balance" | "set-responsibles", ...fields }. Repeating the same request key replays. */
export const POST = safesPost;
