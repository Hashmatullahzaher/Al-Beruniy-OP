/** The Document Vault (migration 0065). A document is reached through the record it is attached to, never by a storage name or path. */

export const DOCUMENT_SUBJECT_TYPES = ["COMPANY", "SHAREHOLDER", "LOAN", "EXPENSE", "RECEIPT", "PAYMENT"] as const;
export type DocumentSubjectType = (typeof DOCUMENT_SUBJECT_TYPES)[number];

export interface DocumentSubject {
  readonly subjectType: DocumentSubjectType;
  /** Null only for a company document: a person's company comes from their session. */
  readonly subjectId: string | null;
}

export interface AttachedDocument {
  readonly id: string;
  readonly title: string;
  readonly documentDate: string | null;
  readonly fileName: string;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly attachedAt: string;
}

export interface DocumentListView {
  readonly canRead: boolean;
  readonly canAttach: boolean;
  readonly documents: readonly AttachedDocument[];
}

export interface DocumentAttachInput extends DocumentSubject {
  readonly storageId: string;
  readonly originalFileName: string;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly title: string;
  readonly documentDate: string | null;
  readonly idempotencyKey: string;
  readonly correlationId: string;
}

/** What the server learns when it attaches or opens a document. The storage ID stays on the server. */
export interface StoredDocumentRecord extends AttachedDocument {
  readonly storageId: string;
  readonly replayed: boolean;
}

export interface OpenedDocumentRecord {
  readonly id: string;
  readonly storageId: string;
  readonly fileName: string;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly sha256: string;
}
