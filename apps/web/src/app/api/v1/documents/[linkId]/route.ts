import { documentGet } from "@/server/documents";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request, { params }: { params: Promise<{ linkId: string }> }): Promise<Response> {
  const { linkId } = await params;
  return documentGet(request, linkId);
}
