/** The Document Vault (migration 0065). A document is reached through the record it is attached to, never by a storage name or path. */

/** AGREEMENT is a capital agreement (migration 0067). A direct shareholder has no agreement record, so their agreement file is a SHAREHOLDER document. */
export const DOCUMENT_SUBJECT_TYPES = ["COMPANY", "SHAREHOLDER", "LOAN", "EXPENSE", "RECEIPT", "PAYMENT", "AGREEMENT"] as const;
export type DocumentSubjectType = (typeof DOCUMENT_SUBJECT_TYPES)[number];

export interface DocumentSubject {
  readonly subjectType: DocumentSubjectType;
  /** Null only for a company document: a person's company comes from their session. */
  readonly subjectId: string | null;
}

/**
 * PENDING: no scan has finished. SCAN_FAILED: every attempt so far failed, and it can be scanned again. INFECTED is final. Only a CLEAN document
 * can be opened (migrations 0066 and 0067). Nothing a browser sends can set any of these.
 */
export const DOCUMENT_SCAN_STATUSES = ["PENDING", "SCAN_FAILED", "CLEAN", "INFECTED"] as const;
export type DocumentScanStatus = (typeof DOCUMENT_SCAN_STATUSES)[number];

export interface AttachedDocument {
  readonly id: string;
  readonly title: string;
  readonly documentDate: string | null;
  readonly fileName: string;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly attachedAt: string;
  readonly scanStatus: DocumentScanStatus;
  /** Where it is attached. A shareholder's list also shows the documents of that shareholder's capital agreements. */
  readonly subjectType?: DocumentSubjectType;
  readonly agreementReference?: string | null;
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
export interface StoredDocumentRecord extends Omit<AttachedDocument, "scanStatus" | "subjectType" | "agreementReference"> {
  readonly storageId: string;
  readonly replayed: boolean;
}

/** What the server needs to scan a stored object. It stays on the server. */
export interface DocumentScanTarget {
  readonly id: string;
  readonly storageId: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly scanStatus: DocumentScanStatus;
  /** The original name, for the scanner's description only. It never selects the file that is scanned. */
  readonly fileName?: string;
}

/** Written by the server from the scanner's verdict. No request from a browser carries this. */
export interface DocumentScanRecordInput {
  readonly linkId: string;
  readonly outcome: "CLEAN" | "INFECTED" | "UNAVAILABLE";
  readonly engine: string;
  readonly detail: string | null;
  readonly correlationId: string;
}

export interface DocumentScanResult {
  readonly id: string;
  readonly scanStatus: DocumentScanStatus;
}

export interface OpenedDocumentRecord {
  readonly id: string;
  readonly storageId: string;
  readonly fileName: string;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly sha256: string;
}
