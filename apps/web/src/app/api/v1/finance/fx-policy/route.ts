import { fxPolicyGet, fxPolicyPost } from "@/server/fx-policy";

export const dynamic = "force-dynamic";
/** The FX policy in force per currency, its history and the FX difference account. */
export const GET = fxPolicyGet;
/** Saves a new FX policy version; returns the refreshed workspace. */
export const POST = fxPolicyPost;
