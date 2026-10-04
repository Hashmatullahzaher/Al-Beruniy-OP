import { createHash } from "node:crypto";
import { link, open, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const AGREEMENT_DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;
export type AgreementDocumentMediaType = "application/pdf" | "image/jpeg" | "image/png";

export interface StoredDocumentDescriptor {
  readonly storageId: string;
  readonly originalFileName: string;
  readonly mediaType: AgreementDocumentMediaType;
  readonly byteSize: number;
  readonly sha256: string;
}

export interface DocumentBackupRecord {
  readonly storageId: string;
  readonly byteSize: number;
  readonly sha256: string;
}

export interface DocumentVaultAudit {
  readonly missing: readonly string[];
  readonly corrupted: readonly string[];
  /** Unreferenced objects are inaccessible through the app and require explicit operator review. */
  readonly unexpected: readonly string[];
}

const STORAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class PrivateDocumentStorageError extends Error {
  readonly code: "NOT_CONFIGURED" | "INVALID_FILE" | "TOO_LARGE" | "NOT_FOUND" | "BACKUP_MISMATCH";
  constructor(code: "NOT_CONFIGURED" | "INVALID_FILE" | "TOO_LARGE" | "NOT_FOUND" | "BACKUP_MISMATCH", message: string) {
    super(message);
    this.name = "PrivateDocumentStorageError";
    this.code = code;
  }
}

export class PrivateDocumentStorage {
  readonly root: string;
  readonly maximumBytes: number;

  constructor(root: string | undefined, maximumBytes = AGREEMENT_DOCUMENT_MAX_BYTES) {
    if (!root?.trim()) throw new PrivateDocumentStorageError("NOT_CONFIGURED", "ABOS_DOCUMENT_STORAGE_ROOT is not configured.");
    if (!path.isAbsolute(root)) throw new PrivateDocumentStorageError("NOT_CONFIGURED", "The private document root must be an absolute path.");
    this.root = path.resolve(root);
    this.maximumBytes = maximumBytes;
    const segments = this.root.toLowerCase().split(path.sep);
    if (segments.includes("public") || segments.includes(".next")) {
      throw new PrivateDocumentStorageError("NOT_CONFIGURED", "The private document root cannot be inside the public directory.");
    }
  }

  validate(originalName: string, bytes: Uint8Array): Omit<StoredDocumentDescriptor, "storageId"> {
    if (bytes.byteLength < 1) throw new PrivateDocumentStorageError("INVALID_FILE", "The selected file is empty.");
    if (bytes.byteLength > this.maximumBytes) {
      throw new PrivateDocumentStorageError("TOO_LARGE", `Agreement files cannot exceed ${this.maximumBytes} bytes.`);
    }
    const mediaType = detectMediaType(bytes);
    if (mediaType === null) {
      throw new PrivateDocumentStorageError("INVALID_FILE", "Only genuine PDF, JPEG, and PNG files are accepted.");
    }
    const fileName = safeFileName(originalName, mediaType);
    return {
      originalFileName: fileName,
      mediaType,
      byteSize: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex")
    };
  }

  async write(storageId: string, originalName: string, bytes: Uint8Array): Promise<StoredDocumentDescriptor> {
    assertStorageId(storageId);
    const descriptor = this.validate(originalName, bytes);
    const target = this.objectPath(storageId);
    const staging = path.join(this.root, "staging", `${storageId}.part`);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await mkdir(path.dirname(staging), { recursive: true, mode: 0o700 });
    const handle = await open(staging, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(staging, { force: true }).catch(() => undefined);
      throw error;
    }
    await handle.close();
    try {
      // Creating a hard link is atomic and refuses an existing target. Unlike rename(), it can
      // never silently replace an immutable document version during upload or restore.
      await link(staging, target);
      await rm(staging);
    } catch (error) {
      await rm(staging, { force: true }).catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new PrivateDocumentStorageError("INVALID_FILE", "That immutable storage identifier already exists.");
      }
      throw error;
    }
    return { storageId, ...descriptor };
  }

  async read(storageId: string): Promise<Uint8Array> {
    assertStorageId(storageId);
    try {
      return await readFile(this.objectPath(storageId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new PrivateDocumentStorageError("NOT_FOUND", "The private document file is unavailable.");
      }
      throw error;
    }
  }

  /** Only for compensating a failed database finalize; linked versions are never deleted. */
  async removeUnlinked(storageId: string): Promise<void> {
    assertStorageId(storageId);
    await rm(this.objectPath(storageId), { force: true });
  }

  async listStorageIds(): Promise<readonly string[]> {
    const objectRoot = path.resolve(this.root, "objects");
    let prefixes;
    try {
      prefixes = await readdir(objectRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const ids: string[] = [];
    for (const prefix of prefixes) {
      if (!prefix.isDirectory()) continue;
      for (const entry of await readdir(path.join(objectRoot, prefix.name), { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".bin")) continue;
        const id = entry.name.slice(0, -4);
        if (STORAGE_ID.test(id) && id.slice(0, 2).toLowerCase() === prefix.name.toLowerCase()) ids.push(id);
      }
    }
    return ids.sort();
  }

  private objectPath(storageId: string): string {
    const target = path.resolve(this.root, "objects", storageId.slice(0, 2), `${storageId}.bin`);
    const objectRoot = path.resolve(this.root, "objects");
    if (!target.startsWith(`${objectRoot}${path.sep}`)) throw new PrivateDocumentStorageError("INVALID_FILE", "Invalid storage identifier.");
    return target;
  }
}

export async function createDocumentVaultBackup(
  storage: PrivateDocumentStorage,
  destination: string,
  records: readonly DocumentBackupRecord[]
): Promise<void> {
  const root = path.resolve(destination);
  await mkdir(root, { recursive: false, mode: 0o700 });
  await mkdir(path.join(root, "objects"), { mode: 0o700 });
  const manifest: DocumentBackupRecord[] = [];
  for (const record of [...records].sort((a, b) => a.storageId.localeCompare(b.storageId))) {
    const bytes = await storage.read(record.storageId);
    verifyRecord(record, bytes);
    const target = path.join(root, "objects", `${record.storageId}.bin`);
    await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
    manifest.push(record);
  }
  await writeFile(path.join(root, "manifest.json"), `${JSON.stringify({ version: 1, records: manifest }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

export async function restoreDocumentVaultBackup(
  backupRoot: string,
  destination: PrivateDocumentStorage,
  expectedRecords: readonly DocumentBackupRecord[]
): Promise<void> {
  const parsed: unknown = JSON.parse(await readFile(path.resolve(backupRoot, "manifest.json"), "utf8"));
  if (!isManifest(parsed)) throw new PrivateDocumentStorageError("BACKUP_MISMATCH", "The document backup manifest is invalid.");
  const expected = [...expectedRecords].sort((a, b) => a.storageId.localeCompare(b.storageId));
  const actual = [...parsed.records].sort((a, b) => a.storageId.localeCompare(b.storageId));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new PrivateDocumentStorageError("BACKUP_MISMATCH", "The document manifest does not match PostgreSQL metadata.");
  }
  for (const record of actual) {
    const bytes = await readFile(path.resolve(backupRoot, "objects", `${record.storageId}.bin`));
    verifyRecord(record, bytes);
    await destination.write(record.storageId, fileNameForMedia(record.storageId, detectMediaType(bytes)), bytes);
  }
}

/**
 * Read-only reconciliation for crash recovery. It never deletes a finalized or unreferenced file:
 * an operator must investigate `unexpected` objects before deciding whether they are abandoned
 * pre-finalize uploads. The expected records must come from the matching PostgreSQL snapshot.
 */
export async function auditDocumentVault(
  storage: PrivateDocumentStorage,
  expectedRecords: readonly DocumentBackupRecord[]
): Promise<DocumentVaultAudit> {
  const expected = new Map(expectedRecords.map(record => [record.storageId, record]));
  const missing: string[] = [];
  const corrupted: string[] = [];
  for (const record of expected.values()) {
    try {
      verifyRecord(record, await storage.read(record.storageId));
    } catch (error) {
      if (error instanceof PrivateDocumentStorageError && error.code === "NOT_FOUND") missing.push(record.storageId);
      else corrupted.push(record.storageId);
    }
  }
  const unexpected = (await storage.listStorageIds()).filter(storageId => !expected.has(storageId));
  return { missing: missing.sort(), corrupted: corrupted.sort(), unexpected };
}

function detectMediaType(bytes: Uint8Array): AgreementDocumentMediaType | null {
  if (bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))
      && Buffer.from(bytes.subarray(12, 16)).toString("ascii") === "IHDR") return "image/png";
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9) return "image/jpeg";
  if (bytes.length >= 10 && Buffer.from(bytes.subarray(0, 5)).toString("ascii") === "%PDF-"
      && Buffer.from(bytes.subarray(Math.max(0, bytes.length - 1024))).includes(Buffer.from("%%EOF"))) return "application/pdf";
  return null;
}

function safeFileName(input: string, mediaType: AgreementDocumentMediaType): string {
  const leaf = input.replace(/\\/g, "/").split("/").at(-1)?.replace(/[\u0000-\u001f\u007f]/g, "").trim() ?? "";
  const sanitized = leaf.replace(/[<>:"|?*]/g, "_").slice(0, 200);
  if (!sanitized || sanitized === "." || sanitized === "..") return fileNameForMedia("agreement", mediaType);
  const extension = mediaType === "application/pdf" ? ".pdf" : mediaType === "image/png" ? ".png" : ".jpg";
  const base = path.basename(sanitized, path.extname(sanitized)).trim().slice(0, 200 - extension.length) || "agreement";
  return `${base}${extension}`;
}

function fileNameForMedia(base: string, mediaType: AgreementDocumentMediaType | null): string {
  return `${base}.${mediaType === "application/pdf" ? "pdf" : mediaType === "image/png" ? "png" : "jpg"}`;
}

function assertStorageId(storageId: string): void {
  if (!STORAGE_ID.test(storageId)) throw new PrivateDocumentStorageError("INVALID_FILE", "Invalid storage identifier.");
}

function verifyRecord(record: DocumentBackupRecord, bytes: Uint8Array): void {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (bytes.byteLength !== record.byteSize || sha256 !== record.sha256) {
    throw new PrivateDocumentStorageError("BACKUP_MISMATCH", `Document ${record.storageId} does not match PostgreSQL metadata.`);
  }
}

function isManifest(value: unknown): value is { readonly version: 1; readonly records: DocumentBackupRecord[] } {
  if (value === null || typeof value !== "object" || (value as { version?: unknown }).version !== 1) return false;
  const records = (value as { records?: unknown }).records;
  return Array.isArray(records) && records.every((record) => record !== null && typeof record === "object"
    && typeof (record as DocumentBackupRecord).storageId === "string" && STORAGE_ID.test((record as DocumentBackupRecord).storageId)
    && Number.isSafeInteger((record as DocumentBackupRecord).byteSize) && (record as DocumentBackupRecord).byteSize > 0
    && typeof (record as DocumentBackupRecord).sha256 === "string"
    && /^[0-9a-f]{64}$/.test((record as DocumentBackupRecord).sha256));
}
