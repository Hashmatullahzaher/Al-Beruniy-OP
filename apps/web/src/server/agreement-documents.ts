import { PrivateDocumentStorage, PrivateDocumentStorageError } from "@abos/persistence";

import { json } from "@/server/treasury";

export const MULTIPART_OVERHEAD_BYTES = 1024 * 1024;
let configuredStorage: PrivateDocumentStorage | undefined;

export function privateStorage(): PrivateDocumentStorage {
  configuredStorage ??= new PrivateDocumentStorage(process.env.ABOS_DOCUMENT_STORAGE_ROOT);
  return configuredStorage;
}

/**
 * The older agreement upload lane, retired by migration 0067. A new agreement file is attached in the Document Vault, where it is locked until a
 * malware scan passes. The database also refuses this lane, so this answer is not the only thing standing in the way.
 */
export async function uploadAgreementDocument(): Promise<Response> {
  return documentError("AGREEMENT_UPLOAD_MOVED", "Agreement documents are now attached in the Document Vault.", 410);
}

export async function boundedMultipartForm(request: Request, maximumBytes: number): Promise<FormData> {
  if (request.body === null) return new FormData();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteSize = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteSize += value.byteLength;
      if (byteSize > maximumBytes) {
        await reader.cancel();
        throw new PrivateDocumentStorageError("TOO_LARGE", "Agreement files cannot exceed 10 MB.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), byteSize);
  return new Request(request.url, { method: "POST", headers: request.headers, body }).formData();
}

/**
 * Retired with the upload lane. This route served stored agreement files without a malware scan. An agreement file is opened through the
 * Document Vault once it has been brought in and passed its scan; until then it stays stored and untouched, and nothing serves it.
 */
export async function downloadAgreementDocument(): Promise<Response> {
  return documentError("AGREEMENT_DOCUMENT_MOVED", "This agreement document is opened from the Document Vault.", 410);
}

/** How every private file leaves the server: never cached and never sniffed. The site-wide headers in next.config.ts add the content policy, and they override any set here. */
export function privateDocumentResponse(bytes: Uint8Array, mediaType: string, fileName: string, disposition: "inline" | "attachment", fallbackName = "document"): Response {
  const encodedName = encodeURIComponent(fileName).replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return new Response(new Uint8Array(bytes).buffer, {
    status: 200,
    headers: {
      "Content-Type": mediaType,
      "Content-Length": String(bytes.byteLength),
      "Content-Disposition": `${disposition}; filename="${fallbackName}"; filename*=UTF-8''${encodedName}`,
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

export function documentError(code: string, message: string, status: number): Response {
  return json({ ok: false, error: { code, message } }, status);
}

export async function cleanupCandidate(storageId: string): Promise<void> {
  await configuredStorage?.removeUnlinked(storageId).catch(() => undefined);
}
