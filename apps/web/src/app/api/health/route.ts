import { releaseMetadata } from "@/lib/release";

export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({
    status: "ok",
    service: "web",
    // "production" for `next build` + `next start`, "development" for `next dev`. Stage 0 and review screens exist only in development.
    build: process.env.NODE_ENV === "production" ? "production" : "development",
    release: releaseMetadata
  });
}
