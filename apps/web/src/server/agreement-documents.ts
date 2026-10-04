import { createHash, randomUUID } from "node:crypto";

import type { AgreementDocumentFinalizeInput } from "@abos/contracts";
import {
  AGREEMENT_DOCUMENT_MAX_BYTES,
  PrivateDocumentStorage,
  PrivateDocumentStorageError
} from "@abos/persistence";

import { sessionToken } from "@/server/identity";
import { financeHandoffRuntime } from "@/server/finance-handoff";
import { restrictedFinanceAuthenticator } from "@/server/operational-finance";
import { assertSameOrigin, json } from "@/server/treasury";
import { shareholderSetupErrorResponse } from "@/server/shareholder-setup";

const MULTIPART_OVERHEAD_BYTES = 1024 * 1024;
let configuredStorage: PrivateDocumentStorage | undefined;

function storage(): PrivateDocumentStorage {
  configuredStorage ??= new PrivateDocumentStorage(process.env.ABOS_DOCUMENT_STORAGE_ROOT);
  return configuredStorage;
}

export async function uploadAgreementDocument(request: Request): Promise<Response> {
  let candidateStorageId: string | null = null;
  let candidateWritten = false;
  try {
    assertSameOrigin(request);
    const type = request.headers.get("content-type")?.toLowerCase() ?? "";
    if (!type.startsWith("multipart/form-data;")) return documentError("INVALID_FILE", "Use a multipart file upload.", 415);
    const length = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(length) && length > AGREEMENT_DOCUMENT_MAX_BYTES + MULTIPART_OVERHEAD_BYTES) {
      return documentError("FILE_TOO_LARGE", "Agreement files cannot exceed 10 MB.", 413);
    }
    // Authenticate before accepting the request body. The bounded reader below also enforces the
    // transport limit for chunked requests that legitimately have no Content-Length header.
    const token = await sessionToken();
    const form = await boundedMultipartForm(request, AGREEMENT_DOCUMENT_MAX_BYTES + MULTIPART_OVERHEAD_BYTES);
    const file = form.get("file");
    const capitalAgreementId = field(form, "capitalAgreementId");
    const documentReference = field(form, "documentReference");
    const documentDate = field(form, "documentDate");
    const idempotencyKey = field(form, "idempotencyKey");
    if (!(file instanceof File) || !capitalAgreementId || !documentReference || !documentDate || !idempotencyKey) {
      return documentError("VALIDATION_FAILED", "Choose a file and enter its agreement details.", 422);
    }
    if (file.size > AGREEMENT_DOCUMENT_MAX_BYTES) {
      return documentError("FILE_TOO_LARGE", "Agreement files cannot exceed 10 MB.", 413);
    }
    const finance = financeHandoffRuntime();
    const authenticator = restrictedFinanceAuthenticator();
    await authenticator.prepareAgreementDocument(finance.executor, token, capitalAgreementId);
    const bytes = new Uint8Array(await file.arrayBuffer());
    candidateStorageId = randomUUID();
    const stored = await storage().write(candidateStorageId, file.name, bytes);
    candidateWritten = true;
    const input: AgreementDocumentFinalizeInput = {
      capitalAgreementId,
      storageId: stored.storageId,
      originalFileName: stored.originalFileName,
      mediaType: stored.mediaType,
      byteSize: stored.byteSize,
      sha256: stored.sha256,
      documentReference,
      documentDate,
      idempotencyKey,
      correlationId: randomUUID()
    };
    try {
      const record = await authenticator.finalizeAgreementDocument(finance.executor, token, input);
      if (record.storageId !== candidateStorageId) {
        await storage().removeUnlinked(candidateStorageId);
        candidateWritten = false;
      }
      return json({ ok: true, data: record }, record.replayed ? 200 : 201);
    } catch (error) {
      if (candidateWritten) {
        await cleanupCandidate(candidateStorageId);
        candidateWritten = false;
      }
      throw error;
    }
  } catch (error) {
    if (candidateStorageId !== null && candidateWritten) await cleanupCandidate(candidateStorageId);
    if (error instanceof PrivateDocumentStorageError) {
      const status = error.code === "TOO_LARGE" ? 413 : error.code === "NOT_FOUND" ? 404 : error.code === "NOT_CONFIGURED" ? 503 : 422;
      return documentError(error.code, error.message, status);
    }
    return shareholderSetupErrorResponse(error);
  }
}

async function boundedMultipartForm(request: Request, maximumBytes: number): Promise<FormData> {
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

export async function downloadAgreementDocument(
  agreementEvidenceId: string,
  disposition: "inline" | "attachment"
): Promise<Response> {
  try {
    const finance = financeHandoffRuntime();
    const record = await restrictedFinanceAuthenticator().agreementDocument(
      finance.executor, await sessionToken(), agreementEvidenceId
    );
    const bytes = await storage().read(record.storageId);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (bytes.byteLength !== Number(record.byteSize) || digest !== record.sha256) {
      return documentError("DOCUMENT_INTEGRITY_FAILURE", "The stored document failed its integrity check.", 503);
    }
    const encodedName = encodeURIComponent(record.originalFileName).replace(/['()*]/g,
      character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
    return new Response(new Uint8Array(bytes).buffer, {
      status: 200,
      headers: {
        "Content-Type": record.mediaType,
        "Content-Length": String(bytes.byteLength),
        "Content-Disposition": `${disposition}; filename="agreement"; filename*=UTF-8''${encodedName}`,
        "Cache-Control": "private, no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox"
      }
    });
  } catch (error) {
    if (error instanceof PrivateDocumentStorageError) {
      return documentError(error.code, error.code === "NOT_FOUND" ? "The document file is unavailable." : error.message,
        error.code === "NOT_FOUND" ? 404 : 503);
    }
    return shareholderSetupErrorResponse(error);
  }
}

function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function documentError(code: string, message: string, status: number): Response {
  return json({ ok: false, error: { code, message } }, status);
}

async function cleanupCandidate(storageId: string): Promise<void> {
  await configuredStorage?.removeUnlinked(storageId).catch(() => undefined);
}
