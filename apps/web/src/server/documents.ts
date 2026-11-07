import { createHash, randomUUID } from "node:crypto";

import { DOCUMENT_SUBJECT_TYPES, type DocumentSubject, type DocumentSubjectType } from "@abos/contracts";
import { AGREEMENT_DOCUMENT_MAX_BYTES, PrivateDocumentStorageError } from "@abos/persistence";

import { boundedMultipartForm, cleanupCandidate, documentError, MULTIPART_OVERHEAD_BYTES, privateDocumentResponse, privateStorage } from "@/server/agreement-documents";
import { financeHandoffRuntime } from "@/server/finance-handoff";
import { sessionToken } from "@/server/identity";
import { operationalFinanceErrorResponse, restrictedFinanceAuthenticator } from "@/server/operational-finance";
import { assertSameOrigin, json } from "@/server/treasury";

/**
 * The Document Vault (migration 0065) through the restricted runtime only. PostgreSQL decides who may read or attach, on every request, from
 * the record a document belongs to. The storage ID is used here and is never sent to the browser.
 */

const NOT_FOUND = "That document is not available.";

function subject(type: string | null, id: string | null): DocumentSubject | null {
  if (!DOCUMENT_SUBJECT_TYPES.includes(type as DocumentSubjectType)) return null;
  const subjectType = type as DocumentSubjectType;
  if (subjectType === "COMPANY") return { subjectType, subjectId: null };
  return id ? { subjectType, subjectId: id } : null;
}

/** A record the person cannot see and one that does not exist get the same answer. */
function documentFailure(error: unknown): Response {
  if (error instanceof PrivateDocumentStorageError) {
    const status = error.code === "TOO_LARGE" ? 413 : error.code === "NOT_FOUND" ? 404 : error.code === "NOT_CONFIGURED" ? 503 : 422;
    const message = error.code === "TOO_LARGE" ? "Files cannot exceed 10 MB." : error.code === "INVALID_FILE" ? "Only genuine PDF, JPEG and PNG files are accepted."
      : error.code === "NOT_FOUND" ? NOT_FOUND : "Documents are not available right now.";
    return documentError(error.code, message, status);
  }
  const sqlState = error !== null && typeof error === "object" && "code" in error ? String((error as { readonly code: unknown }).code) : "";
  const text = error instanceof Error ? error.message : "";
  if (sqlState === "P0002" || /document (subject )?not found/i.test(text)) return documentError("NOT_FOUND", NOT_FOUND, 404);
  if (/future/i.test(text)) return documentError("VALIDATION_FAILED", "The document date cannot be in the future.", 422);
  if (sqlState === "22023" || sqlState === "22P02" || sqlState === "22007" || sqlState === "22008") return documentError("VALIDATION_FAILED", "Some details are not valid.", 422);
  return operationalFinanceErrorResponse(error);
}

export async function documentsGet(request: Request): Promise<Response> {
  try {
    const search = new URL(request.url).searchParams;
    const requested = subject(search.get("subjectType"), search.get("subjectId"));
    if (requested === null) return documentError("VALIDATION_FAILED", "Choose what the documents belong to.", 422);
    const data = await restrictedFinanceAuthenticator().documentList(financeHandoffRuntime().executor, await sessionToken(), requested);
    return json({ ok: true, data });
  } catch (error) {
    return documentFailure(error);
  }
}

export async function documentsPost(request: Request): Promise<Response> {
  let candidate: string | null = null;
  try {
    assertSameOrigin(request);
    const type = request.headers.get("content-type")?.toLowerCase() ?? "";
    if (!type.startsWith("multipart/form-data;")) return documentError("INVALID_FILE", "Use a multipart file upload.", 415);
    const length = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(length) && length > AGREEMENT_DOCUMENT_MAX_BYTES + MULTIPART_OVERHEAD_BYTES) return documentError("TOO_LARGE", "Files cannot exceed 10 MB.", 413);
    // Authenticate before accepting the body. The bounded reader also enforces the limit for requests with no Content-Length.
    const token = await sessionToken();
    const form = await boundedMultipartForm(request, AGREEMENT_DOCUMENT_MAX_BYTES + MULTIPART_OVERHEAD_BYTES);
    const value = (name: string) => { const entry = form.get(name); return typeof entry === "string" ? entry.trim() : ""; };
    const file = form.get("file");
    const target = subject(value("subjectType"), value("subjectId") || null);
    const title = value("title");
    const idempotencyKey = value("idempotencyKey");
    if (!(file instanceof File) || target === null || !title || !idempotencyKey) return documentError("VALIDATION_FAILED", "Choose a file and give it a title.", 422);
    if (file.size > AGREEMENT_DOCUMENT_MAX_BYTES) return documentError("TOO_LARGE", "Files cannot exceed 10 MB.", 413);
    const finance = financeHandoffRuntime();
    const authenticator = restrictedFinanceAuthenticator();
    const bytes = new Uint8Array(await file.arrayBuffer());
    privateStorage().validate(file.name, bytes);
    await authenticator.documentPrepare(finance.executor, token, target);
    candidate = randomUUID();
    const stored = await privateStorage().write(candidate, file.name, bytes);
    const record = await authenticator.documentAttach(finance.executor, token, {
      ...target, storageId: stored.storageId, originalFileName: stored.originalFileName, mediaType: stored.mediaType, byteSize: stored.byteSize, sha256: stored.sha256,
      title, documentDate: value("documentDate") || null, idempotencyKey, correlationId: randomUUID()
    });
    // A replay keeps the object the first request stored, so this one has no reason to stay.
    if (record.storageId !== candidate) await cleanupCandidate(candidate);
    candidate = null;
    return json({ ok: true, data: { ...record, storageId: undefined } }, record.replayed ? 200 : 201);
  } catch (error) {
    if (candidate !== null) await cleanupCandidate(candidate);
    return documentFailure(error);
  }
}

export async function documentGet(request: Request, linkId: string): Promise<Response> {
  try {
    const disposition = new URL(request.url).searchParams.get("download") === "1" ? "attachment" : "inline";
    const record = await restrictedFinanceAuthenticator().documentOpen(financeHandoffRuntime().executor, await sessionToken(), linkId, randomUUID());
    const bytes = await privateStorage().read(record.storageId);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (bytes.byteLength !== Number(record.byteSize) || digest !== record.sha256) {
      return documentError("DOCUMENT_INTEGRITY_FAILURE", "The stored document failed its integrity check.", 503);
    }
    return privateDocumentResponse(bytes, record.mediaType, record.fileName, disposition);
  } catch (error) {
    return documentFailure(error);
  }
}
