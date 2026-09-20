import { releaseMetadata } from "@/lib/release";

export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({
    status: "ready",
    service: "web",
    checks: {
      applicationShell: "ready",
      operationalDependencies: "not-configured-stage-0"
    },
    release: releaseMetadata
  });
}
