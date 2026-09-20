import { releaseMetadata } from "@/lib/release";

export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({
    status: "ok",
    service: "web",
    release: releaseMetadata
  });
}
