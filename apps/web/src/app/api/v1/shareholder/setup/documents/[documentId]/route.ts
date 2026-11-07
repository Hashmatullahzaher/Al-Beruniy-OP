import { downloadAgreementDocument } from "@/server/agreement-documents";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Retired by migration 0067: it served stored agreement files without a malware scan. An agreement file opens from the Document Vault. */
export async function GET(): Promise<Response> {
  return downloadAgreementDocument();
}
