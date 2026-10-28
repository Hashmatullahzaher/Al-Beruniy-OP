import { periodsGet, periodsPost } from "@/server/periods-reversals";

export const dynamic = "force-dynamic";
/** Accounting months with their close / reopen state, pending reopen requests and history. */
export const GET = periodsGet;
/** { action: "close" | "reopen" | "request-reopen" | "decide-reopen", ... }; returns the refreshed workspace. */
export const POST = periodsPost;
