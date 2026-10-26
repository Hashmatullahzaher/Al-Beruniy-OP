import { readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";

const fixtureFile = process.env.ABOS_DIRECT_CAPITAL_BROWSER_FILE;
test.skip(!fixtureFile, "Requires the dedicated disposable 0040 operational-password preview; never preserved company data.");

test("one person adds a shareholder with 20,000 in one save, adds 10,000 more and sees the actual GL", async ({ page }) => {
  if (!fixtureFile) throw new Error("Dedicated preview fixture is required");
  const fixture = JSON.parse(readFileSync(fixtureFile, "utf8")) as { database: string; url: string; username: string; password: string; safeId: string };
  expect(fixture.database).toBe("abos_direct_capital_browser_0040");
  expect(fixture.url).toBe("http://127.0.0.1:3191");
  await page.goto("/login?next=%2Fshareholders");
  await page.getByLabel("Username", { exact: true }).fill(fixture.username);
  await page.getByLabel("Password", { exact: true }).fill(fixture.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("button", { name: "Add shareholder", exact: true })).toBeVisible();
  // One save records the shareholder and the first 20,000 together.
  await page.getByRole("button", { name: "Add shareholder", exact: true }).click();
  const create = page.getByRole("form", { name: "Add shareholder", exact: true });
  await create.getByLabel("Name", { exact: true }).fill("Demo Shareholder");
  await create.getByLabel("Amount", { exact: true }).fill("20000");
  await create.getByRole("combobox", { name: "Currency", exact: true }).selectOption("USD");
  await create.getByRole("combobox", { name: "Which Safe did it go into?", exact: true }).selectOption(fixture.safeId);
  await create.getByLabel("Agreed total (optional)", { exact: true }).fill("100000");
  const created = page.waitForResponse(r => r.url().endsWith("/api/v1/shareholder/capital") && r.request().method() === "POST");
  await create.getByRole("button", { name: "Save", exact: true }).click();
  expect((await created).status()).toBe(201);
  const holder = page.getByRole("article", { name: "Demo Shareholder", exact: true });
  await expect(holder).toBeVisible();
  await expect(holder).toContainText("No document attached");
  await holder.getByRole("button", { name: "Add money", exact: true }).click();
  const form = page.getByRole("form", { name: /^Add money/ });
  await form.getByLabel("Amount", { exact: true }).fill("10000");
  await form.getByRole("combobox", { name: "Which Safe did it go into?", exact: true }).selectOption(fixture.safeId);
  const response = page.waitForResponse(r => r.url().endsWith("/api/v1/shareholder/capital") && r.request().method() === "POST");
  await form.getByRole("button", { name: "Save", exact: true }).click();
  expect((await response).status()).toBe(201);
  await expect(form).toHaveCount(0);
  const capital = holder.getByRole("region", { name: "USD capital", exact: true });
  await expect(capital).toContainText("USD 100,000");
  await expect(capital).toContainText("USD 30,000");
  await expect(capital).toContainText("USD 70,000");
  await expect(page.getByRole("region", { name: "Safe balances", exact: true })).toContainText("USD 30,000");
  await expect(holder.getByRole("row")).toHaveCount(3);
  const references = await holder.locator("tbody tr").allTextContents();
  expect(references.every(value => value.includes("CAP-"))).toBe(true);
  await expect(page.getByRole("main")).not.toContainText(/Capital Request|Capital Agreement|Posting Intent|Handoff|Eligibility|Installment|Ownership|Synthetic Authorization/);
  await page.screenshot({ path: "test-results/direct-capital-operational/shareholder-posted.png", fullPage: true });
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kabul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const ledger = await page.request.get(`/api/v1/finance/general-ledger?from=${today}&to=${today}`);
  expect(ledger.status()).toBe(200);
  const gl = await ledger.json() as { data: { lines: { sourceType: string; baseDebit: string; baseCredit: string }[] } };
  expect(gl.data.lines.filter(line => line.sourceType === "DIRECT_SHAREHOLDER_CAPITAL")).toHaveLength(4);
  // The complete financial flow above succeeds with no agreement/document. Attachment is an
  // independent optional action and must leave those exact posted lines unchanged.
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
  for (const version of [1, 2]) {
    const uploaded = page.waitForResponse(r => r.url().endsWith("/api/v1/shareholder/capital/documents") && r.request().method() === "POST");
    await holder.getByLabel(version === 1 ? "Upload agreement" : "Upload another version", { exact: true })
      .setInputFiles({ name: `agreement-v${version}.png`, mimeType: "image/png", buffer: png });
    const response = await uploaded;
    expect(response.status()).toBe(201);
    const record = await response.json() as { data: { sha256: string; byteSize: number } };
    expect(record.data.sha256).toBe(createHash("sha256").update(png).digest("hex"));
    expect(Number(record.data.byteSize)).toBe(png.byteLength);
    await expect(holder.getByRole("link", { name: "Download document", exact: true })).toHaveCount(version);
  }
  const downloadUrl = await holder.getByRole("link", { name: "Download document", exact: true }).first().getAttribute("href");
  expect(downloadUrl).toBeTruthy();
  const downloaded = await page.request.get(downloadUrl!);
  expect(downloaded.status()).toBe(200);
  expect(await downloaded.body()).toEqual(png);
  const anonymous = await page.context().browser()!.newContext();
  try {
    const denied = await anonymous.request.get(`${fixture.url}${downloadUrl}`);
    expect(denied.status()).toBe(401);
  } finally { await anonymous.close(); }
  const workspace = await (await page.request.get("/api/v1/shareholder/capital")).json() as { data: { shareholders: { id: string; name: string }[] } };
  const shareholder = workspace.data.shareholders.find(row => row.name === "Demo Shareholder");
  expect(shareholder).toBeTruthy();
  const invalid = await page.request.post("/api/v1/shareholder/capital/documents", {
    headers: { Origin: fixture.url }, multipart: { shareholderProfileId: shareholder!.id,
      documentReference: "invalid.pdf", documentDate: today, idempotencyKey: randomUUID(),
      file: { name: "invalid.pdf", mimeType: "application/pdf", buffer: Buffer.from("not a PDF") } }
  });
  expect(invalid.status()).toBe(422);
  const afterAttachment = await (await page.request.get(`/api/v1/finance/general-ledger?from=${today}&to=${today}`)).json();
  expect(afterAttachment.data.lines).toEqual(gl.data.lines);
  await page.getByRole("main").getByRole("link", { name: "General Ledger", exact: true }).click();
  await expect(page.getByRole("heading", { name: "General Ledger activity", exact: true })).toBeVisible();
  await expect(page.getByRole("main")).toContainText("CAP-");
  await page.screenshot({ path: "test-results/direct-capital-operational/general-ledger.png", fullPage: true });
});

test("real-password workspace remains responsive and keyboard accessible in Dari on tablet", async ({ page }) => {
  if (!fixtureFile) throw new Error("Dedicated preview fixture is required");
  const fixture = JSON.parse(readFileSync(fixtureFile, "utf8")) as { database: string; url: string; username: string; password: string };
  expect(fixture.database).toBe("abos_direct_capital_browser_0040");
  expect(fixture.url).toBe("http://127.0.0.1:3191");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/login?next=%2Fshareholders");
  await page.getByLabel("Username", { exact: true }).fill(fixture.username);
  await page.getByLabel("Password", { exact: true }).fill(fixture.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("button", { name: "Add shareholder", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("button", { name: /Demo Shareholder/ }).click();
  await expect(page.getByRole("article", { name: "Demo Shareholder", exact: true })).toContainText("USD 70,000");
  await expect(page.getByRole("article", { name: "Demo Shareholder", exact: true })).toContainText("Capital put in");
  await page.screenshot({ path: "test-results/direct-capital-operational/desktop-shareholder.png", fullPage: true });
  await page.setViewportSize({ width: 820, height: 1180 });
  await page.getByRole("button", { name: "Switch to Dari", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await page.getByRole("button", { name: "افزودن سهامدار", exact: true }).focus();
  await page.keyboard.press("Enter");
  const form = page.getByRole("form", { name: "افزودن سهامدار", exact: true });
  await expect(form.getByLabel("نام", { exact: true })).toBeFocused();
  await expect(form.getByLabel("سند توافق (اختیاری)")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/direct-capital-operational/tablet-dari.png", fullPage: true });
});
