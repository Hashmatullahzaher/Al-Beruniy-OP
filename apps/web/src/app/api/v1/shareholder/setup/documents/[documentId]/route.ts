import { downloadAgreementDocument } from "@/server/agreement-documents";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request, { params }: { params: Promise<{ documentId: string }> }): Promise<Response> {
  const { documentId } = await params;
  const disposition = new URL(request.url).searchParams.get("download") === "1" ? "attachment" : "inline";
  return downloadAgreementDocument(documentId, disposition);
}
