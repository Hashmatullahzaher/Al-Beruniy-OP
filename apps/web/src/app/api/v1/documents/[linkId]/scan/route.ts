import { documentScanPost } from "@/server/documents";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Scans a locked document again. It carries no outcome: the answer comes from the scanner. */
export async function POST(request: Request, { params }: { params: Promise<{ linkId: string }> }): Promise<Response> {
  const { linkId } = await params;
  return documentScanPost(request, linkId);
}
