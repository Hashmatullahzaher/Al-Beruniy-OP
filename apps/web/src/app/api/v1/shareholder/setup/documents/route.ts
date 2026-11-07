import { uploadAgreementDocument } from "@/server/agreement-documents";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Retired by migration 0067: an agreement file is attached in the Document Vault, where it is scanned before anyone can open it. */
export async function POST(): Promise<Response> {
  return uploadAgreementDocument();
}
