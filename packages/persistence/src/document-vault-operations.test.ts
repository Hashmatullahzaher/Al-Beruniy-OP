import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { reconcileDocumentVault, type VaultObject } from "./document-vault-operations.ts";
import { PrivateDocumentStorage } from "./private-document-storage.ts";

const pdf = (text: string) => new TextEncoder().encode(`%PDF-1.4\n% ${text}\n%%EOF\n`);

async function vault() {
  const root = await mkdtemp(path.join(tmpdir(), "abos-vault-reconcile-"));
  const storage = new PrivateDocumentStorage(root);
  const put = async (scanStatus: string | null, source: VaultObject["source"] = "DOCUMENT"): Promise<VaultObject> => {
    const stored = await storage.write(randomUUID(), "synthetic.pdf", pdf(randomUUID()));
    return { storageId: stored.storageId, byteSize: stored.byteSize, sha256: stored.sha256, source, scanStatus };
  };
  return { root, storage, put };
}

test("a vault that matches its records is clean, and counts each source and state", async () => {
  const v = await vault();
  try {
    const objects = [await v.put("CLEAN"), await v.put("PENDING"), await v.put("SCAN_FAILED"), await v.put(null, "AGREEMENT"), await v.put("CLEAN", "IMPORTED_AGREEMENT")];
    const report = await reconcileDocumentVault(v.storage, objects, []);
    assert.equal(report.clean, true);
    assert.deepEqual(report.bySource, { AGREEMENT: 1, DOCUMENT: 3, IMPORTED_AGREEMENT: 1 });
    assert.deepEqual(report.byScan, { CLEAN: 2, PENDING: 1, SCAN_FAILED: 1, NOT_IN_VAULT: 1 });
    assert.equal(report.storedObjects, 5);
  } finally { await rm(v.root, { recursive: true, force: true }); }
});

test("a trusted document that disappears or changes is the finding that matters, and is never quietly accepted", async () => {
  const v = await vault();
  try {
    const gone = await v.put("CLEAN"); const changed = await v.put("CLEAN"); const pending = await v.put("PENDING");
    await rm(v.storage.scanPath(gone.storageId));
    await writeFile(v.storage.scanPath(changed.storageId), pdf("altered"));
    await rm(v.storage.scanPath(pending.storageId));
    const report = await reconcileDocumentVault(v.storage, [gone, changed, pending], []);
    assert.equal(report.clean, false);
    assert.deepEqual(report.trustedMissing, [gone.storageId]);
    assert.deepEqual(report.trustedChanged, [changed.storageId]);
    assert.deepEqual([...report.missing].sort(), [gone.storageId, pending.storageId].sort());
  } finally { await rm(v.root, { recursive: true, force: true }); }
});

test("a file with no record is caught", async () => {
  const v = await vault();
  try {
    const known = await v.put("CLEAN");
    const stray = await v.put("CLEAN");
    const report = await reconcileDocumentVault(v.storage, [known], []);
    assert.deepEqual([report.clean, report.unexpected], [false, [stray.storageId]]);
  } finally { await rm(v.root, { recursive: true, force: true }); }
});

test("a blocked file removed by antivirus is reported apart and does not hide a file that is truly missing", async () => {
  const v = await vault();
  try {
    const blocked = await v.put("INFECTED");
    await rm(v.storage.scanPath(blocked.storageId));
    const alone = await reconcileDocumentVault(v.storage, [blocked], []);
    assert.deepEqual([alone.clean, alone.removedAfterBlock, alone.missing], [true, [blocked.storageId], []]);
    const lost = await v.put("SCAN_FAILED");
    await rm(v.storage.scanPath(lost.storageId));
    const both = await reconcileDocumentVault(v.storage, [blocked, lost], []);
    assert.deepEqual([both.clean, both.removedAfterBlock, both.missing], [false, [blocked.storageId], [lost.storageId]]);
  } finally { await rm(v.root, { recursive: true, force: true }); }
});

test("an impossible scan state, a duplicated storage identity or a database finding makes it not clean", async () => {
  const v = await vault();
  try {
    const a = await v.put("CLEAN");
    for (const [label, objects] of [
      ["vault document with no state", [{ ...a, scanStatus: null }]],
      ["unknown state", [{ ...a, scanStatus: "APPROVED" }]],
      ["agreement file with a state", [{ ...a, source: "AGREEMENT" as const, scanStatus: "CLEAN" }]],
      ["imported file that is not clean", [{ ...a, source: "IMPORTED_AGREEMENT" as const, scanStatus: "PENDING" }]],
      ["one object listed twice", [a, a]]
    ] as const) assert.equal((await reconcileDocumentVault(v.storage, objects, [])).clean, false, label);
    const report = await reconcileDocumentVault(v.storage, [a], [{ problem: "LINK_SUBJECT_MISSING", reference: randomUUID(), detail: "LOAN" }]);
    assert.deepEqual([report.clean, report.integrity.length], [false, 1]);
  } finally { await rm(v.root, { recursive: true, force: true }); }
});
