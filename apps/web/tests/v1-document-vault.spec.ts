import { createHash } from "node:crypto";

import { PrivateDocumentStorage, reconcileDocumentVault, type VaultIntegrityProblem, type VaultObject } from "@abos/persistence";
import { expect, test, type Page } from "@playwright/test";

import { employeeHolding, expectBusinessCounts, readOnly, seedFirstRun, signIn, signOut } from "./support/first-run";

/**
 * The Document Vault through the real UI, identity, database and private storage. Raw responses are inspected, not only the screen.
 * SQL only reads and verifies. It resets only an explicitly disposable preview database and must run serially:
 *
 *   ABOS_V1_PREVIEW_E2E=1 pnpm exec playwright test v1-document-vault --workers=1
 */
test.use({ viewport: { width: 1440, height: 900 } });

const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n", "utf8");
const FAKE_PDF = Buffer.from("<html><script>alert('not a document')</script></html>", "utf8");

type Raw = { status: number; text: string; headers: Record<string, string>; hash: string };

/** A request from the signed-in page, as the app makes it, so the Secure session cookie goes with it. */
async function raw(page: Page, url: string): Promise<Raw> {
  const seen = await page.evaluate(async (path) => {
    const response = await fetch(path);
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { status: response.status, bytes: Array.from(bytes), headers: Object.fromEntries(response.headers.entries()) };
  }, url);
  const bytes = Buffer.from(seen.bytes);
  return { status: seen.status, text: bytes.toString("utf8"), headers: seen.headers, hash: createHash("sha256").update(bytes).digest("hex") };
}

/** A POST from the signed-in page. It sends nothing but the address. */
async function post(page: Page, url: string): Promise<{ status: number; text: string }> {
  return page.evaluate(async (path) => {
    const response = await fetch(path, { method: "POST" });
    return { status: response.status, text: await response.text() };
  }, url);
}

const SCANNER = process.env.ABOS_MALWARE_SCANNER === "windows-defender";
/** The downgrade-only test wrapper (0067): the real scanner still runs first, and marked file names are answered more strictly. */
const DOWNGRADES = process.env.ABOS_MALWARE_SCANNER_TEST_DOWNGRADES === "1";
const ENGINE = DOWNGRADES ? "windows-defender+test-downgrades" : "windows-defender";

test.describe("V1 Document Vault", () => {
  test.skip(process.env.ABOS_V1_PREVIEW_E2E !== "1", "Set ABOS_V1_PREVIEW_E2E=1 with an isolated preview database to run this.");

  test("a company document is stored privately, served safely, audited, and reaches nobody else", async ({ page: admin, browser }) => {
    test.skip(!SCANNER, "Needs the real scanner: set ABOS_MALWARE_SCANNER=windows-defender.");
    test.setTimeout(180_000);
    const accounts = seedFirstRun();
    await signIn(admin, "super.admin", accounts["super.admin"]);
    const page = await employeeHolding(admin, browser, "company.records", ["Manage company details"]);
    await page.goto("/admin/company");
    const panel = page.getByRole("region", { name: "Documents" });
    await expect(panel).toContainText("No documents attached.");
    const form = panel.getByRole("form", { name: "Attach a document" });

    // The bytes decide, not the name: a web page called a PDF is refused, and nothing is recorded.
    await form.getByLabel("Title").fill("Not really a PDF");
    await form.getByLabel(/^PDF or image file/).setInputFiles({ name: "fake.pdf", mimeType: "application/pdf", buffer: FAKE_PDF });
    await form.getByRole("button", { name: "Attach document" }).click();
    await expect(form.getByRole("alert")).toContainText("Only genuine PDF, JPEG and PNG files are accepted.");
    expect(await readOnly("SELECT id FROM abos.documents")).toEqual([]);

    await form.getByLabel("Title").fill("Certificate of registration");
    await form.getByLabel(/^PDF or image file/).setInputFiles({ name: "../../certificate.pdf", mimeType: "application/pdf", buffer: PDF });
    await form.getByRole("button", { name: "Attach document" }).click();
    await expect(form.getByRole("status")).toContainText("Document attached.");
    await expect(panel.getByRole("listitem").filter({ hasText: "Certificate of registration" })).toContainText("certificate.pdf");

    // What the browser receives names no storage object, and the stored name is only a leaf.
    const listed = await raw(page, "/api/v1/documents?subjectType=COMPANY");
    const stored = await readOnly<{ storage: string; name: string; hash: string }>("SELECT storage_id::text AS storage, original_file_name AS name, sha256 AS hash FROM abos.documents");
    expect(stored).toHaveLength(1);
    expect(stored[0]!.name).toBe("certificate.pdf");
    expect(listed.text).not.toContain(stored[0]!.storage);
    expect(listed.text).not.toContain("storageId");
    const linkId = (JSON.parse(listed.text) as { data: { documents: { id: string }[] } }).data.documents[0]!.id;

    // Served through the app only: the same bytes, never cached, never sniffed, and never framed or embedded.
    const inline = await raw(page, `/api/v1/documents/${linkId}`);
    expect(inline.status).toBe(200);
    expect(inline.hash).toBe(stored[0]!.hash);
    expect(inline.headers["content-type"]).toBe("application/pdf");
    expect(inline.headers["cache-control"]).toContain("no-store");
    expect(inline.headers["x-content-type-options"]).toBe("nosniff");
    expect(inline.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(inline.headers["content-security-policy"]).toContain("object-src 'none'");
    expect(inline.headers["x-frame-options"]).toBe("DENY");
    expect(inline.headers["content-disposition"]).toContain("inline");
    expect((await raw(page, `/api/v1/documents/${linkId}?download=1`)).headers["content-disposition"]).toContain("attachment");
    const audit = await readOnly<{ action: string; n: number }>("SELECT action, count(*)::int AS n FROM abos.audit_records WHERE entity_type = 'DOCUMENT' GROUP BY action");
    expect([...audit].sort((a, b) => a.action.localeCompare(b.action))).toEqual([{ action: "DOCUMENT_ATTACHED", n: 1 }, { action: "DOCUMENT_OPENED", n: 2 },
      { action: "DOCUMENT_SCAN_STARTED", n: 1 }, { action: "DOCUMENT_SCANNED", n: 1 }].sort((a, b) => a.action.localeCompare(b.action)));
    // The real scanner passed this file, and the verdict is on record.
    expect(await readOnly("SELECT outcome, engine, detail FROM abos.document_scan_results")).toEqual([{ outcome: "CLEAN", engine: ENGINE, detail: null }]);

    // Another person who knows the address gets the answer an unknown address gets. Without a session, nothing either.
    await signOut(admin);
    await signIn(admin, "demo.finance.manager", accounts["demo.finance.manager"]);
    const refused = await raw(admin, `/api/v1/documents/${linkId}`);
    const unknown = await raw(admin, "/api/v1/documents/00000000-0000-4000-8000-000000000001");
    expect(refused.status).toBe(404);
    expect(refused.text).toBe(unknown.text);
    expect((await raw(admin, "/api/v1/documents?subjectType=COMPANY")).status).toBe(404);
    expect((await raw(admin, `/api/v1/documents/${linkId}?download=1`)).text).toBe(unknown.text);
    // Nor can they start a scan, and the answer again says nothing about whether the document exists.
    const scanRefused = await post(admin, `/api/v1/documents/${linkId}/scan`);
    const scanUnknown = await post(admin, "/api/v1/documents/00000000-0000-4000-8000-000000000001/scan");
    expect(scanRefused.status).toBe(404);
    expect(scanRefused.text).toBe(scanUnknown.text);
    await signOut(admin);
    expect((await raw(admin, `/api/v1/documents/${linkId}`)).status).toBe(401);
    expect((await raw(admin, `/api/v1/documents/${linkId}?download=1`)).status).toBe(401);
    expect((await post(admin, `/api/v1/documents/${linkId}/scan`)).status).toBe(401);

    // No file reached a public path, and attaching touched no accounting.
    expect((await raw(admin, `/objects/${stored[0]!.storage.slice(0, 2)}/${stored[0]!.storage}.bin`)).text).not.toContain("%PDF-");
    await expectBusinessCounts({ journals: 0 });
  });

  test("with no scanner a file stays locked: it is kept, cannot be opened, and nothing marks it clean", async ({ page: admin, browser }) => {
    test.skip(SCANNER, "Run against a server with no ABOS_MALWARE_SCANNER setting.");
    test.setTimeout(180_000);
    const accounts = seedFirstRun();
    await signIn(admin, "super.admin", accounts["super.admin"]);
    const page = await employeeHolding(admin, browser, "company.locked", ["Manage company details"]);
    await page.goto("/admin/company");
    const panel = page.getByRole("region", { name: "Documents" });
    const form = panel.getByRole("form", { name: "Attach a document" });
    await form.getByLabel("Title").fill("Awaiting a scanner");
    await form.getByLabel(/^PDF or image file/).setInputFiles({ name: "held.pdf", mimeType: "application/pdf", buffer: PDF });
    await form.getByRole("button", { name: "Attach document" }).click();
    // 0067: the attempt failed, so the file is shown as SCAN_FAILED. It is still only locked: nothing about it is decided.
    await expect(form.getByRole("status")).toContainText("its security check could not finish. It stays locked until a check passes.");
    const row = panel.getByRole("listitem").filter({ hasText: "Awaiting a scanner" });
    await expect(row).toContainText("Security check could not finish. It stays locked");
    await expect(row.getByRole("link")).toHaveCount(0);

    // The raw routes refuse too, and return no bytes. Trying again changes nothing.
    const listed = await raw(page, "/api/v1/documents?subjectType=COMPANY");
    const linkId = (JSON.parse(listed.text) as { data: { documents: { id: string }[] } }).data.documents[0]!.id;
    for (const url of [`/api/v1/documents/${linkId}`, `/api/v1/documents/${linkId}?download=1`]) {
      const refused = await raw(page, url);
      expect(refused.status).toBe(409);
      expect(refused.text).not.toContain("%PDF-");
      expect(refused.headers["content-disposition"]).toBeUndefined();
    }
    await row.getByRole("button", { name: "Check again" }).click();
    await expect(row).toContainText("Security check could not finish. It stays locked");
    expect(await readOnly("SELECT DISTINCT outcome, engine FROM abos.document_scan_results")).toEqual([{ outcome: "UNAVAILABLE", engine: DOWNGRADES ? "not-configured+test-downgrades" : "not-configured" }]);
    expect(await readOnly("SELECT id FROM abos.audit_records WHERE action = 'DOCUMENT_OPENED'")).toEqual([]);

    // Someone without access still gets the plain not-found answer, so a locked document is not disclosed.
    await signOut(admin);
    await signIn(admin, "demo.finance.manager", accounts["demo.finance.manager"]);
    expect((await raw(admin, `/api/v1/documents/${linkId}`)).status).toBe(404);
    await expectBusinessCounts({ journals: 0 });
  });

  test("the whole lifecycle: locked, failed, cleared, blocked and kept, opened only when clean and only by the right people", async ({ page: admin, browser }) => {
    test.skip(!SCANNER || !DOWNGRADES, "Needs the real scanner with the downgrade-only test wrapper: ABOS_MALWARE_SCANNER=windows-defender and ABOS_MALWARE_SCANNER_TEST_DOWNGRADES=1.");
    test.setTimeout(240_000);
    const accounts = seedFirstRun();
    await signIn(admin, "super.admin", accounts["super.admin"]);
    const page = await employeeHolding(admin, browser, "company.lifecycle", ["Manage company details"]);
    await page.goto("/admin/company");
    const panel = page.getByRole("region", { name: "Documents" });
    const form = panel.getByRole("form", { name: "Attach a document" });
    const attach = async (title: string, name: string) => {
      await form.getByLabel("Title").fill(title);
      await form.getByLabel(/^PDF or image file/).setInputFiles({ name, mimeType: "application/pdf", buffer: Buffer.concat([PDF, Buffer.from(`% ${title}\n%%EOF\n`)]) });
      await form.getByRole("button", { name: "Attach document" }).click();
    };
    const linkOf = async (title: string) => {
      const listed = JSON.parse((await raw(page, "/api/v1/documents?subjectType=COMPANY")).text) as { data: { documents: { id: string; title: string; scanStatus: string }[] } };
      const found = listed.data.documents.find((d) => d.title === title);
      expect(found, title).toBeTruthy();
      return found!;
    };
    const refusedBytes = async (id: string) => {
      for (const url of [`/api/v1/documents/${id}`, `/api/v1/documents/${id}?download=1`]) {
        const refused = await raw(page, url);
        expect(refused.status, url).toBe(409);
        expect(refused.text).not.toContain("%PDF-");
      }
    };

    // 1. A scan that fails leaves the file locked as SCAN_FAILED; checking again lets the real scanner clear it, and only then does it open.
    await attach("Board resolution", "resolution test-scan-fails-once.pdf");
    await expect(form.getByRole("status")).toContainText("its security check could not finish");
    const resolution = panel.getByRole("listitem").filter({ hasText: "Board resolution" });
    await expect(resolution).toContainText("Security check could not finish. It stays locked");
    await expect(resolution.getByRole("link")).toHaveCount(0);
    const failedOnce = await linkOf("Board resolution");
    expect(failedOnce.scanStatus).toBe("SCAN_FAILED");
    await refusedBytes(failedOnce.id);
    await resolution.getByRole("button", { name: "Check again" }).click();
    await expect(resolution.getByRole("link", { name: "View" })).toHaveAttribute("href", `/api/v1/documents/${failedOnce.id}`);
    const opened = await raw(page, `/api/v1/documents/${failedOnce.id}`);
    expect(opened.status).toBe(200);
    expect(opened.text).toContain("Board resolution");

    // 2. A threat blocks the file for good. It is kept, it never opens, and there is nothing to retry.
    await attach("Suspicious scan", "suspicious test-infected.pdf");
    await expect(form.getByRole("alert")).toContainText("This file failed its security check. It is kept, and it cannot be opened.");
    const blocked = panel.getByRole("listitem").filter({ hasText: "Suspicious scan" });
    await expect(blocked).toContainText("Blocked: failed its security check and cannot be opened");
    await expect(blocked.getByRole("button")).toHaveCount(0);
    const infected = await linkOf("Suspicious scan");
    expect(infected.scanStatus).toBe("INFECTED");
    await refusedBytes(infected.id);
    expect((await post(page, `/api/v1/documents/${infected.id}/scan`)).text).toContain("INFECTED");

    // 3. A file whose scans keep failing stays locked, however often anyone checks again.
    await attach("Unreadable scan", "unreadable test-scan-fails.pdf");
    const failing = panel.getByRole("listitem").filter({ hasText: "Unreadable scan" });
    for (let attempt = 0; attempt < 2; attempt++) {
      await failing.getByRole("button", { name: "Check again" }).click();
      await expect(failing).toContainText("Security check could not finish. It stays locked");
    }
    const failed = await linkOf("Unreadable scan");
    expect(failed.scanStatus).toBe("SCAN_FAILED");
    await refusedBytes(failed.id);

    // 4. A correction is a new document beside the old one: both stay, and both open.
    await attach("Board resolution (signed)", "resolution-signed.pdf");
    await expect(form.getByRole("status")).toHaveText("Document attached.");
    const corrected = await linkOf("Board resolution (signed)");
    expect(corrected.scanStatus).toBe("CLEAN");
    expect((await raw(page, `/api/v1/documents/${failedOnce.id}`)).status).toBe(200);

    // 5. The verdicts came from the server's scanner: every row names it, and a blocked or failed file never became clean.
    const verdicts = await readOnly<{ title: string; outcome: string; engine: string }>(
      `SELECT l.title, r.outcome, r.engine FROM abos.document_scan_results r JOIN abos.document_links l ON l.document_id = r.document_id ORDER BY r.scanned_at`);
    expect(verdicts.every((v) => v.engine === ENGINE)).toBe(true);
    expect(verdicts.filter((v) => v.title === "Suspicious scan").map((v) => v.outcome)).toEqual(["INFECTED"]);
    expect(verdicts.filter((v) => v.title === "Unreadable scan").map((v) => v.outcome)).toEqual(["UNAVAILABLE", "UNAVAILABLE", "UNAVAILABLE"]);
    expect(verdicts.filter((v) => v.title === "Board resolution").map((v) => v.outcome)).toEqual(["UNAVAILABLE", "CLEAN"]);

    // 6. Someone in the same company without the permission, or knowing only a storage name, learns nothing.
    const storage = await readOnly<{ storage: string }>("SELECT storage_id::text AS storage FROM abos.documents ORDER BY uploaded_at LIMIT 1");
    await signOut(admin);
    await signIn(admin, "demo.finance.manager", accounts["demo.finance.manager"]);
    const unknown = await raw(admin, "/api/v1/documents/00000000-0000-4000-8000-000000000001");
    for (const id of [failedOnce.id, infected.id, failed.id, corrected.id, storage[0]!.storage]) {
      const refused = await raw(admin, `/api/v1/documents/${id}`);
      expect([refused.status, refused.text]).toEqual([404, unknown.text]);
    }

    // 7. Reconciliation: every record has its file, unchanged, and the database finds nothing wrong. Files left by earlier disposable runs in
    // this shared preview folder have no record here, so they are not counted against this run.
    const objects = (await readOnly<{ storage_id: string; byte_size: string; sha256: string; source: VaultObject["source"]; scan_status: string | null }>(
      "SELECT storage_id::text, byte_size::text, sha256, source, scan_status FROM abos.document_vault_manifest()"))
      .map((row) => ({ storageId: row.storage_id, byteSize: Number(row.byte_size), sha256: row.sha256, source: row.source, scanStatus: row.scan_status }));
    const integrity = await readOnly<VaultIntegrityProblem & Record<string, unknown>>("SELECT problem, reference::text, detail FROM abos.document_vault_integrity()");
    const report = await reconcileDocumentVault(new PrivateDocumentStorage(process.env.ABOS_DOCUMENT_STORAGE_ROOT), objects, integrity);
    expect([report.missing, report.corrupted, report.trustedMissing, report.trustedChanged, report.unexpectedScanState, report.integrity]).toEqual([[], [], [], [], [], []]);
    expect(report.byScan).toEqual({ CLEAN: 2, INFECTED: 1, SCAN_FAILED: 1 });
    await expectBusinessCounts({ journals: 0 });
  });
});
