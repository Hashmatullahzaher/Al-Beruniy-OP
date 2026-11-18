import type { APIRequestContext } from "@playwright/test";

export const DEV_ONLY = "Development and review only: a production build answers Not Found here (owner decision, 2026-11-11). Runs on next dev.";
export const PRODUCTION_ONLY = "Production-build behaviour: on next dev the Stage 0 screens are still reachable for review.";

/** Whether the server under test is a production build (`next build` + `next start`). Stage 0 and review screens exist only on `next dev`. */
export async function productionBuild(request: APIRequestContext): Promise<boolean> {
  const body = await (await request.get("/api/health")).json() as { build?: string };
  return body.build === "production";
}
