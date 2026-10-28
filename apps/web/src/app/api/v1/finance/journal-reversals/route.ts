import { reversalsGet, reversalsPost } from "@/server/periods-reversals";

export const dynamic = "force-dynamic";
/** Reversible journals, reversal requests and posted reversals. */
export const GET = reversalsGet;
/** { action: "reverse" | "request" | "decide" | "post-approved" | "withdraw", ... }; returns the refreshed workspace. */
export const POST = reversalsPost;
