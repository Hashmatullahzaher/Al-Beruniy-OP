import { uploadAgreementDocument } from "@/server/agreement-documents";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Retired by migration 0067: a direct shareholder's agreement file is attached in the Document Vault. */
export async function POST(): Promise<Response> {
  return uploadAgreementDocument();
}
