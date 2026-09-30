import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test, type Page } from "@playwright/test";
import pg from "pg";

/**
 * WP-B in a real browser: a Treasury manager creates a safe and opens its USD and AFN accounts
 * against Chart of Accounts CASH accounts; the opening is counted, independently confirmed,
 * reconciled, approved and activated by different people; a Saraf account is created and activated
 * by someone else; the whole safe is counted and independently confirmed, with the difference shown.
 * Real sign-in, real API, restricted Treasury login, PostgreSQL. Nothing is mocked.
 *
 * It reseeds the disposable dev database named in apps/web/.env.local, so it is gated:
 *   ABOS_E2E_PORT=3192 ABOS_V1_PREVIEW_E2E=1 pnpm exec playwright test v1-safes-saraf --workers=1
 */
const SHOTS = resolve(__dirname, "../test-results/v1-safes-saraf");
const SAFE = "Synthetic Branch Safe (demo)";

test.use({ viewport: { width: 1440, height: 900 } });

test.describe("WP-B safes, Saraf accounts and whole-safe counts", () => {
  test.skip(process.env.ABOS_V1_PREVIEW_E2E !== "1", "Set ABOS_V1_PREVIEW_E2E=1 to reseed the dev database and run the WP-B journey.");

  test("safe set-up, Saraf account and whole-safe count, each with independent people", async ({ page }) => {
    test.setTimeout(420_000);
    mkdirSync(SHOTS, { recursive: true });
    const environment = previewEnvironment();
    assertDisposablePreviewDatabase(environment);
    const accounts = seedPreview(environment);
    await provisionOperatorData(environment);

    // The Super Administrator extends two standard roles (an administration step, not a Treasury one).
    await signIn(page, "super.admin", accounts["super.admin"]);
    const roleChanges = await page.evaluate(async () => {
      const list = await (await fetch("/api/v1/admin/roles")).json() as { data: { id: string; name: string; description: string; version: number; permissions: string[] }[] };
      const extra: Record<string, string[]> = {
        "Treasury Manager": ["treasury.cash-account.reconcile", "treasury.saraf-account.manage"],
        "Treasury Verifier": ["treasury.cash-account.approve", "treasury.saraf-account.manage"]
      };
      const statuses: number[] = [];
      for (const role of list.data.filter((item) => extra[item.name] !== undefined)) {
        const response = await fetch(`/api/v1/admin/roles/${role.id}`, {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: role.name, description: role.description, status: "ACTIVE", expectedVersion: role.version,
            permissions: [...role.permissions, ...(extra[role.name] ?? [])] })
        });
        statuses.push(response.status);
      }
      return statuses;
    });
    expect(roleChanges).toEqual([200, 200]);
    await signOut(page);

    // 1. The Treasury manager creates the safe, activates it and opens both currency accounts.
    await signIn(page, "demo.treasury.manager", accounts["demo.treasury.manager"]);
    await openSafes(page);
    const create = page.getByRole("form", { name: "New safe" });
    await create.getByLabel("Safe name").fill(SAFE);
    await create.getByLabel("Responsible cashier").selectOption({ label: "Synthetic Cashier" });
    await create.getByRole("button", { name: "Create safe" }).click();
    await expect(page.locator(".treasury-message.success")).toContainText("Safe created");
    const safe = page.locator(".treasury-safe", { hasText: SAFE });
    await safe.getByRole("button", { name: "Activate safe" }).click();
    await expect(safe.locator("header .treasury-chip")).toHaveText("Active");
    const open = safe.getByRole("form", { name: "Open a currency account" });
    await open.getByLabel("Currency").selectOption("USD");
    await open.getByLabel("Cash account in the Chart of Accounts").selectOption({ label: "1010-USD · Synthetic Office Cash - USD" });
    await open.getByRole("button", { name: "Open account" }).click();
    await expect(safe.locator(".treasury-account", { hasText: "USD" })).toContainText("Draft · not reconciled");
    // An AFN account can never link a USD ledger account, whatever the interface allows.
    const mismatch = await page.evaluate(async () => {
      const view = await (await fetch("/api/v1/treasury/cash-locations")).json() as { data: { locations: { id: string; name: string }[]; cashLedgers: { id: string; currency: string }[] } };
      const target = view.data.locations.find((item) => item.name.startsWith("Synthetic Branch Safe"));
      const usdLedger = view.data.cashLedgers.find((item) => item.currency === "USD");
      const response = await fetch(`/api/v1/treasury/cash-locations/${target?.id ?? ""}/open-account`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ currency: "AFN", ledgerAccountId: usdLedger?.id })
      });
      return { status: response.status, body: await response.json() as { ok: boolean; error?: { code: string } } };
    });
    expect(mismatch.body.ok).toBe(false);
    expect(mismatch.body.error?.code).toBe("CURRENCY_MISMATCH");
    await open.getByLabel("Currency").selectOption("AFN");
    await open.getByLabel("Cash account in the Chart of Accounts").selectOption({ label: "1011-AFN · Synthetic Office Cash - AFN" });
    await open.getByRole("button", { name: "Open account" }).click();
    await expect(safe.locator(".treasury-account", { hasText: "AFN" })).toContainText("Draft · not reconciled");
    await shot(page, "01-safe-created", ".treasury-safes");

    // 2. The manager creates a Saraf account; activating it themselves is not offered and is refused.
    await page.locator(".wpb-switch button", { hasText: "Saraf accounts" }).click();
    const saraf = page.getByRole("form", { name: "New Saraf account" });
    await saraf.getByRole("combobox", { name: "Saraf", exact: true }).selectOption({ label: "Synthetic Saraf House (demo)" });
    await saraf.getByLabel("Currency").selectOption("USD");
    await saraf.getByLabel("Saraf control account in the Chart of Accounts").selectOption({ label: "2300-USD · Synthetic Saraf control USD (demo)" });
    await saraf.getByRole("button", { name: "Create Saraf account" }).click();
    const sarafCard = page.locator(".saraf-account", { hasText: "Synthetic Saraf House (demo)" });
    await expect(sarafCard).toContainText("Draft · awaiting activation");
    await expect(sarafCard.getByRole("button", { name: "Activate Saraf account" })).toHaveCount(0);
    await expect(sarafCard).toContainText("another person must activate it");
    const selfActivate = await page.evaluate(async () => {
      const list = await (await fetch("/api/v1/treasury/saraf-accounts")).json() as { data: { sarafAccounts: { id: string }[] } };
      const response = await fetch(`/api/v1/treasury/saraf-accounts/${list.data.sarafAccounts[0]?.id ?? ""}/activate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      return response.status;
    });
    expect(selfActivate).toBe(403);
    await shot(page, "02-saraf-draft", ".wpb-saraf");
    await signOut(page);

    // 3. The cashier counts the opening cash of the new USD account.
    await signIn(page, "demo.cashier", accounts["demo.cashier"]);
    await openSafes(page);
    const cashierUsd = page.locator(".treasury-safe", { hasText: SAFE }).locator(".treasury-account", { hasText: "USD" });
    await cashierUsd.getByLabel(/Opening count amount/).fill("500.00");
    await cashierUsd.getByLabel("Count sheet").selectOption({ index: 1 });
    await cashierUsd.getByRole("button", { name: "Record opening count" }).click();
    await expect(cashierUsd).toContainText("Counted USD 500.00 · Synthetic Cashier");
    await expect(cashierUsd).toContainText("You counted this cash, so someone else must confirm the count.");
    await expect(cashierUsd.getByRole("button", { name: "Confirm opening count" })).toHaveCount(0);
    await signOut(page);

    // 4. The verifier confirms the count; 5. the manager reconciles; 6. the verifier approves and activates.
    await signIn(page, "demo.verifier", accounts["demo.verifier"]);
    await openSafes(page);
    const verifierUsd = page.locator(".treasury-safe", { hasText: SAFE }).locator(".treasury-account", { hasText: "USD" });
    await verifierUsd.getByRole("button", { name: "Confirm opening count" }).click();
    await expect(verifierUsd).toContainText("confirmed by Synthetic Count Confirmer");
    await signOut(page);

    await signIn(page, "demo.treasury.manager", accounts["demo.treasury.manager"]);
    await openSafes(page);
    const managerUsd = page.locator(".treasury-safe", { hasText: SAFE }).locator(".treasury-account", { hasText: "USD" });
    await managerUsd.getByLabel("Reconciliation evidence").selectOption({ index: 1 });
    await managerUsd.getByRole("button", { name: "Reconcile opening" }).click();
    await expect(managerUsd).toContainText("Reconciled · awaiting approval");
    await expect(managerUsd.getByRole("button", { name: "Approve opening" })).toHaveCount(0);
    await signOut(page);

    await signIn(page, "demo.verifier", accounts["demo.verifier"]);
    await openSafes(page);
    const approverUsd = page.locator(".treasury-safe", { hasText: SAFE }).locator(".treasury-account", { hasText: "USD" });
    await approverUsd.getByRole("button", { name: "Approve opening" }).click();
    await expect(approverUsd).toContainText("Approved · not active");
    await approverUsd.getByRole("button", { name: "Activate account" }).click();
    await expect(approverUsd.locator(".treasury-chip")).toHaveText("Active");
    await expect(approverUsd).toContainText("Activated by");
    await expect(approverUsd).toContainText("Synthetic Count Confirmer");
    await shot(page, "03-account-active", ".treasury-safes");
    // The Saraf account is activated by someone other than its creator.
    await page.locator(".wpb-switch button", { hasText: "Saraf accounts" }).click();
    await page.locator(".saraf-account", { hasText: "Synthetic Saraf House (demo)" }).getByRole("button", { name: "Activate Saraf account" }).click();
    await expect(page.locator(".saraf-account", { hasText: "Synthetic Saraf House (demo)" })).toContainText("Synthetic Count Confirmer");
    await expect(page.locator(".saraf-account .treasury-chip").first()).toHaveText("Active");
    await shot(page, "04-saraf-active", ".wpb-saraf");
    await signOut(page);

    // 7. The cashier counts the whole safe (short by 20.00) and cannot confirm their own count.
    await signIn(page, "demo.cashier", accounts["demo.cashier"]);
    await openSafes(page);
    await page.locator(".wpb-switch button", { hasText: "Cash counts" }).click();
    await expect(page.getByRole("radio", { name: /Whole safe/ })).toBeChecked();
    const whole = page.getByRole("form", { name: "Whole-safe count" });
    await whole.getByLabel("Safe account").selectOption({ label: `${SAFE} · USD` });
    await whole.getByLabel("Whole-safe counted amount").fill("480.00");
    await whole.getByLabel("Count sheet").selectOption({ index: 1 });
    await whole.getByLabel("Note (optional)").fill("Synthetic end-of-day count");
    await whole.getByRole("button", { name: "Record whole-safe count" }).click();
    const count = page.locator(".safe-count", { hasText: SAFE });
    await expect(count).toContainText("Awaiting independent confirmation");
    await expect(count).toContainText("USD 500.00");
    await expect(count).toContainText("USD −20.00");
    await expect(count.getByRole("button", { name: "Confirm whole-safe count" })).toHaveCount(0);
    const selfConfirm = await page.evaluate(async () => {
      const list = await (await fetch("/api/v1/treasury/safe-counts")).json() as { data: { safeCounts: { id: string }[] } };
      const response = await fetch(`/api/v1/treasury/safe-counts/${list.data.safeCounts[0]?.id ?? ""}/confirm`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      return response.status;
    });
    expect(selfConfirm).toBe(403);
    // Money-received mode stays available and points to the receipt workflow.
    await page.getByRole("radio", { name: /Money received only/ }).check();
    await expect(page.getByRole("button", { name: "Go to receipts" })).toBeVisible();
    await signOut(page);

    // 8. The verifier confirms it; the difference is recorded, not resolved.
    await signIn(page, "demo.verifier", accounts["demo.verifier"]);
    await openSafes(page);
    await page.locator(".wpb-switch button", { hasText: "Cash counts" }).click();
    await page.locator(".safe-count", { hasText: SAFE }).getByRole("button", { name: "Confirm whole-safe count" }).click();
    await expect(page.locator(".safe-count", { hasText: SAFE })).toContainText("Confirmed");
    await expect(page.locator(".safe-count", { hasText: SAFE })).toContainText("Synthetic Count Confirmer");
    await shot(page, "05-whole-safe-count-confirmed", ".wpb-counts");

    // Dari, right to left, desktop and phone width.
    await page.getByRole("button", { name: "Switch to Dari" }).click();
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.locator(".safe-count", { hasText: SAFE })).toContainText("تفاوت");
    await shot(page, "06-counts-dari-rtl", ".wpb-counts");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator(".wpb-switch button").first().click();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await shot(page, "07-safes-dari-phone", ".treasury-safes");
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("button", { name: "Switch to English" }).click();

    // 0032 operational configuration remains usable after the synthetic gate is removed. The
    // same password-backed manager can see safe/Saraf configuration, while custody counts and
    // their evidence are not queried or exposed.
    await signOut(page);
    await removeSandboxAuthorization(environment);
    await signIn(page, "demo.treasury.manager", accounts["demo.treasury.manager"]);
    await openSafes(page);
    await expect(page.locator(".treasury-safe", { hasText: SAFE })).toBeVisible();
    await page.locator(".wpb-switch button", { hasText: "Saraf accounts" }).click();
    await expect(page.locator(".saraf-account", { hasText: "Synthetic Saraf House (demo)" })).toBeVisible();
    await page.locator(".wpb-switch button", { hasText: "Cash counts" }).click();
    await expect(page.locator(".safe-count")).toHaveCount(0);
  });
});

async function openSafes(page: Page): Promise<void> {
  await page.goto("/finance/treasury");
  await page.getByRole("tab", { name: /Safes & accounts/ }).click();
  await expect(page.locator(".wpb-switch")).toBeVisible();
}

async function shot(page: Page, name: string, focus?: string): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  if (focus) {
    const target = page.locator(focus).first();
    if (await target.count() > 0) await target.evaluate((element) => { element.scrollIntoView({ block: "start" }); window.scrollBy(0, -96); });
  }
  await page.screenshot({ path: resolve(SHOTS, `${name}.png`) });
}

async function signIn(page: Page, username: string, password: string | undefined): Promise<void> {
  expect(password, `password for ${username}`).toBeTruthy();
  await page.goto("/login");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password ?? "");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

async function signOut(page: Page): Promise<void> {
  await page.locator(".account-control > button").click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);
}

function seedPreview(environment: Record<string, string | undefined>): Record<string, string> {
  const output = execFileSync("pnpm", ["--filter", "@abos/e1-integration", "preview:seed"], {
    cwd: resolve(__dirname, "../../.."), env: environment as NodeJS.ProcessEnv, encoding: "utf8", shell: process.platform === "win32"
  });
  const accounts: Record<string, string> = {};
  for (const line of output.split(/\r?\n/)) {
    const match = /\s((?:super\.admin|demo\.[a-z.]+))\s+([a-z]+-[a-z]+-[a-z]+-[0-9a-f]+)\s/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) accounts[match[1]] = match[2];
  }
  return accounts;
}

/**
 * Operator step, standing in for paths that are not Treasury's: evidence intake (count sheets and a
 * reconciliation record), a synthetic Saraf business party, and a synthetic SARAF control account
 * in the Chart of Accounts (Agent A's area). Treasury itself cannot create any of these.
 */
async function provisionOperatorData(environment: Record<string, string | undefined>): Promise<void> {
  const url = environment.ABOS_DATABASE_URL ?? "";
  if (!/dev|sandbox|preview/i.test(new URL(url).pathname)) throw new Error("Refusing to provision outside a disposable database");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const entity = (await client.query<{ legal_entity_id: string }>("SELECT legal_entity_id FROM abos.sandbox_legal_entity_scopes LIMIT 1")).rows[0]?.legal_entity_id;
    if (entity === undefined) throw new Error("No sandbox legal entity");
    for (const kind of ["PHYSICAL_CASH_COUNT", "PHYSICAL_CASH_COUNT", "OPENING_RECONCILIATION"]) {
      const id = randomUUID();
      await client.query(
        `INSERT INTO abos.evidence_references (id, legal_entity_id, document_id, evidence_kind, evidence_version, sha256, completed_at)
         VALUES ($1, $2, $3, $4, 1, $5, clock_timestamp())`,
        [id, entity, randomUUID(), kind, createHash("sha256").update(id).digest("hex")]);
    }
    const party = randomUUID();
    await client.query("INSERT INTO abos.business_parties (id, legal_entity_id, display_name, status) VALUES ($1, $2, 'Synthetic Saraf House (demo)', 'ACTIVE')", [party, entity]);
    await client.query("INSERT INTO abos.business_party_roles (business_party_id, role_code, effective_from) VALUES ($1, 'SARAF', current_date - 1)", [party]);
    await client.query(
      `INSERT INTO abos.ledger_accounts (id, legal_entity_id, account_code, account_name, account_type, control_account_type, posting_allowed, account_currency_code, status)
       VALUES ($1, $2, '2300-USD', 'Synthetic Saraf control USD (demo)', 'ASSET', 'SARAF', true, 'USD', 'ACTIVE')`, [randomUUID(), entity]);
  } finally {
    await client.end();
  }
}

async function removeSandboxAuthorization(environment: Record<string, string | undefined>): Promise<void> {
  const url = environment.ABOS_DATABASE_URL ?? "";
  if (!/dev|sandbox|preview/i.test(new URL(url).pathname)) throw new Error("Refusing to alter authorization outside a disposable database");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("DELETE FROM abos.sandbox_authorizations");
  } finally {
    await client.end();
  }
}

function previewEnvironment(): Record<string, string | undefined> {
  const fileEnvironment: Record<string, string> = {};
  for (const line of readFileSync(resolve(__dirname, "../.env.local"), "utf8").split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) fileEnvironment[match[1]] = match[2];
  }
  // Explicit command-line values win so a run can point every runtime at one isolated preview DB.
  return { ...fileEnvironment, ...process.env };
}

/** Refuses to seed unless the owner and every restricted login point at one disposable preview database. */
function assertDisposablePreviewDatabase(environment: Record<string, string | undefined>): void {
  const ownerUrl = environment.ABOS_DATABASE_URL;
  expect(ownerUrl, "ABOS_DATABASE_URL for an isolated preview database").toBeTruthy();
  expect(environment.ABOS_IDENTITY_DATABASE_URL, "ABOS_IDENTITY_DATABASE_URL for the same isolated preview database").toBeTruthy();
  const ownerDatabase = new URL(ownerUrl ?? "").pathname.slice(1);
  expect(ownerDatabase).toMatch(/dev|sandbox|preview/i);
  expect(ownerDatabase).not.toBe("abos_v1_local_review");
  for (const name of ["ABOS_IDENTITY_DATABASE_URL", "ABOS_FINANCE_DATABASE_URL", "ABOS_TREASURY_DATABASE_URL"]) {
    const url = environment[name];
    if (url !== undefined && url.trim() !== "") expect(new URL(url).pathname.slice(1), `${name} database`).toBe(ownerDatabase);
  }
}
