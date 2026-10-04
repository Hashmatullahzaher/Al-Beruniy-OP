import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  auditDocumentVault,
  createDocumentVaultBackup,
  PrivateDocumentStorage,
  PrivateDocumentStorageError,
  restoreDocumentVaultBackup
} from "./private-document-storage.ts";

const FIRST = "10000000-0000-4000-8000-000000000001";
const SECOND = "10000000-0000-4000-8000-000000000002";
const THIRD = "10000000-0000-4000-8000-000000000003";
const pdf = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n", "ascii");
const png = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0,0,0,0x49,0x48,0x44,0x52,0,0,0,1,0,0,0,1]);

test("private agreement storage validates signatures, computes hashes, and cannot traverse paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "abos-doc-vault-"));
  try {
    const storage = new PrivateDocumentStorage(root, 100);
    const stored = await storage.write(FIRST, "../signed-agreement.pdf", pdf);
    assert.equal(stored.originalFileName, "signed-agreement.pdf");
    assert.equal(stored.mediaType, "application/pdf");
    assert.match(stored.sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(await storage.read(FIRST), pdf);
    assert.equal(storage.validate("misleading.exe", pdf).originalFileName, "misleading.pdf");
    await assert.rejects(() => storage.write(FIRST, "replacement.png", png), /already exists/);
    assert.deepEqual(await storage.read(FIRST), pdf, "an immutable object cannot be replaced");
    await assert.rejects(() => storage.read("../../secrets"), (error: unknown) =>
      error instanceof PrivateDocumentStorageError && error.code === "INVALID_FILE");
    await assert.rejects(() => storage.write(SECOND, "fake.pdf", Buffer.from("not a pdf")), /genuine PDF/);
    await assert.rejects(() => new PrivateDocumentStorage(root, 5).write(SECOND, "large.pdf", pdf),
      (error: unknown) => error instanceof PrivateDocumentStorageError && error.code === "TOO_LARGE");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("document backup and restore require exact PostgreSQL metadata and preserve every version", async () => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "abos-doc-source-"));
  const backupRoot = path.join(await mkdtemp(path.join(os.tmpdir(), "abos-doc-backups-")), "checkpoint-1");
  const restoreRoot = await mkdtemp(path.join(os.tmpdir(), "abos-doc-restore-"));
  try {
    const source = new PrivateDocumentStorage(sourceRoot);
    const first = await source.write(FIRST, "agreement-v1.pdf", pdf);
    const second = await source.write(SECOND, "agreement-v2.png", png);
    const records = [first, second].map(({ storageId, byteSize, sha256 }) => ({ storageId, byteSize, sha256 }));
    await createDocumentVaultBackup(source, backupRoot, records);
    const restored = new PrivateDocumentStorage(restoreRoot);
    await restoreDocumentVaultBackup(backupRoot, restored, records);
    assert.deepEqual(await restored.read(FIRST), pdf);
    assert.deepEqual(await restored.read(SECOND), png);
    const manifest = JSON.parse(await readFile(path.join(backupRoot, "manifest.json"), "utf8")) as { records: unknown[] };
    assert.equal(manifest.records.length, 2);
    await restored.write(THIRD, "interrupted-before-finalize.pdf", pdf);
    assert.deepEqual(await auditDocumentVault(restored, records), {
      missing: [], corrupted: [], unexpected: [THIRD]
    }, "an interrupted pre-finalize object is reported for review and never silently deleted");
    await assert.rejects(async () => restoreDocumentVaultBackup(backupRoot, new PrivateDocumentStorage(
      await mkdtemp(path.join(os.tmpdir(), "abos-doc-bad-"))), records.slice(0, 1)), /does not match PostgreSQL metadata/);
  } finally {
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(path.dirname(backupRoot), { recursive: true, force: true });
    await rm(restoreRoot, { recursive: true, force: true });
  }
});
