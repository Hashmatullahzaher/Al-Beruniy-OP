import { uploadAgreementDocument } from "@/server/agreement-documents";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  return uploadAgreementDocument(request);
}
