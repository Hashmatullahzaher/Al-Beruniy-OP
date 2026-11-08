import { expect, test, type Page } from "@playwright/test";

const safe = "9a000000-0000-4000-8000-000000000001";
const afnSafe = "9a000000-0000-4000-8000-000000000002";
const shareholderAccount = "9a000000-0000-4000-8000-000000000003";
const otherAccount = "9a000000-0000-4000-8000-000000000004";
const profile = "9a000000-0000-4000-8000-000000000005";
const party = "9a000000-0000-4000-8000-000000000006";
const loanId = "9a000000-0000-4000-8000-000000000007";
const journal = "9a000000-0000-4000-8000-000000000008";
const pendingId = "9a000000-0000-4000-8000-000000000009";

const auth = (permissions: readonly string[]) => ({ userAccountId: "u", displayName: "Synthetic Finance User", loginIdentifier: "finance", legalEntityId: "e", jobTitle: "Accountant",
  legalEntityName: "UI test company", permissions, sessionExpiresAt: "2099-01-01T00:00:00Z" });
const ALL = ["finance.loan.read", "finance.loan.record", "finance.loan.repay", "finance.loan.approve"];
const treasury = { id: safe, nameEn: "Main Safe", nameFa: null };
const loan = (extra: object = {}) => ({ id: loanId, transactionReference: "LN-20260910-ABC", reference: "BANK-1", note: null, status: "POSTED", decisionReason: null, lenderType: "COMPANY",
  lender: { id: party, name: "Outside Lender Ltd" }, shareholderProfileId: null, currency: "USD", principal: "30000", basePrincipal: "30000", date: "2026-09-10", outstanding: "25000", baseOutstanding: "25000",
  repaid: "5000", pendingRepayments: "0", reversed: false, treasury, liability: { id: otherAccount, code: "2520", name: "Loans payable" }, journalId: journal, createdBy: "Synthetic Finance User", ...extra });
const workspace = (extra: object = {}) => ({ legalEntityId: "e", baseCurrency: "USD", today: "2099-12-31", approvalRequired: false, permissions: { canRead: true, canRecord: true, canRepay: true, canApprove: true },
  loans: [loan()], pendingRepayments: [], options: { treasuryAccounts: [{ ...treasury, accountType: "SAFE", currencyCode: "USD" }, { id: afnSafe, nameEn: "AFN Safe", nameFa: null, accountType: "SAFE", currencyCode: "AFN" }],
    liabilityAccounts: [{ id: shareholderAccount, code: "2510", name: "Shareholder loans", control: "SHAREHOLDER_LOAN" }, { id: otherAccount, code: "2520", name: "Loans payable", control: "LOAN_PAYABLE" }],
    shareholders: [{ id: profile, name: "Ahmad Holder" }], lenders: [{ id: party, name: "Outside Lender Ltd" }] }, ...extra });
const statement = { legalEntityId: "e", range: { from: "2026-01-01", to: "2026-09-30" }, loan: loan(), opening: { native: "0", base: "0" }, closing: { native: "25000", base: "25000" },
  lines: [{ journalId: journal, date: "2026-09-10", kind: "RECEIPT", reference: "LN-20260910-ABC", amount: "30000", baseAmount: "30000", treasuryBaseAmount: "30000", realizedFx: "0", effect: "30000", balance: "30000", treasury },
    { journalId: "j2", date: "2026-09-12", kind: "REPAYMENT", reference: "LR-20260912-ABC", amount: "5000", baseAmount: "5000", treasuryBaseAmount: "5000", realizedFx: "0", effect: "-5000", balance: "25000", treasury }],
  realizedFx: "0", reconciliation: { loansBase: "25000", ledgerBase: "25000", matches: true } };

const readiness = (extra: object = {}) => ({ legalEntityId: "e", baseCurrency: "USD", approvalRequired: false, canManageAccounts: true, canManageRoles: false,
  permissions: { canRead: true, canRecord: true, canRepay: true, canApprove: true },
  accounts: [{ control: "SHAREHOLDER_LOAN", accountType: "LIABILITY", status: "READY" }, { control: "LOAN_PAYABLE", accountType: "LIABILITY", status: "READY" },
    { control: "REALIZED_FX_GAIN", accountType: "REVENUE", status: "READY" }, { control: "REALIZED_FX_LOSS", accountType: "EXPENSE", status: "READY" }], ...extra });

async function mock(page: Page, data: object = workspace(), permissions: readonly string[] = ALL, ready: object = readiness()) {
  const posted: Record<string, unknown>[] = [];
  await page.route("**/api/v1/auth/me", (route) => route.fulfill({ json: { ok: true, data: auth(permissions) } }));
  await page.route(/\/api\/v1\/finance\/loans\/readiness/, (route) => route.fulfill({ json: { ok: true, data: ready } }));
  await page.route(/\/api\/v1\/finance\/loans\/statement/, (route) => route.fulfill({ json: { ok: true, data: statement } }));
  await page.route(/\/api\/v1\/finance\/loans$/, async (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      posted.push(body);
      if (body.action === "repay" && Number(body.amount) > 25000) {
        await route.fulfill({ status: 422, json: { ok: false, error: { code: "REPAYMENT_EXCEEDS_OUTSTANDING", message: "This is more than is outstanding on the loan." } } });
        return;
      }
      await route.fulfill({ status: 201, json: { ok: true, data: { status: "POSTED", journalId: journal, loanId, replayed: false } } });
      return;
    }
    await route.fulfill({ json: { ok: true, data } });
  });
  return posted;
}

test("Add money asks where the money came from, and each answer goes to its own lane", async ({ page }) => {
  await mock(page);
  await page.goto("/finance/add-money");
  const question = page.getByRole("region", { name: "Where is this money coming from?" });
  await expect(question.getByRole("link", { name: /Shareholder capital/ })).toHaveAttribute("href", "/shareholders");
  await expect(question.getByRole("link", { name: /Opening balance/ })).toHaveAttribute("href", "/finance/safes");
  await expect(question.getByRole("button", { name: /Shareholder loan/ })).toBeVisible();
  await expect(question.getByRole("button", { name: /Other loan/ })).toBeVisible();
  await expect(page.getByRole("main")).not.toContainText("Temporary funding");
  await expect(page.getByRole("main")).not.toContainText(/journal|liability|debit|credit/i);
});

test("a shareholder loan goes to the loan lane with the shareholder, and never asks for a name", async ({ page }) => {
  const posted = await mock(page);
  await page.goto("/finance/add-money");
  await page.getByRole("button", { name: /Shareholder loan/ }).click();
  const form = page.getByRole("form", { name: "Record loan" });
  await form.getByLabel("Which shareholder?").selectOption({ label: "Ahmad Holder" });
  await expect(form.getByRole("textbox", { name: "Name" })).toHaveCount(0);
  await form.getByLabel("Which Safe did it go into?").selectOption({ label: "Main Safe · USD" });
  await form.getByLabel(/^Amount/).fill("20000");
  await form.getByRole("button", { name: "Record loan" }).click();
  await expect(page.getByRole("status")).toContainText("Loan recorded.");
  expect(posted[0]).toMatchObject({ action: "record", lenderType: "SHAREHOLDER", shareholderProfileId: profile, lenderName: null, liabilityLedgerAccountId: shareholderAccount, currencyCode: "USD", amount: "20000" });
  await expect(page.getByRole("link", { name: "View the loan" })).toHaveAttribute("href", `/finance/loans?loanId=${loanId}`);
});

test("another lender can be new or known, and an AFN Safe takes its currency from the Safe", async ({ page }) => {
  const posted = await mock(page);
  await page.goto("/finance/add-money");
  await page.getByRole("button", { name: /Other loan/ }).click();
  const form = page.getByRole("form", { name: "Record loan" });
  await form.getByLabel("Who lent the money?").selectOption({ label: "A company" });
  await form.getByRole("textbox", { name: "Name" }).fill("New Lender Ltd");
  await form.getByLabel("Which Safe did it go into?").selectOption({ label: "AFN Safe · AFN" });
  await expect(form.getByLabel("Amount (AFN)")).toBeVisible();
  await form.getByLabel("Amount (AFN)").fill("7000");
  await form.getByRole("button", { name: "Record loan" }).click();
  await expect(page.getByRole("status")).toContainText("Loan recorded.");
  expect(posted[0]).toMatchObject({ lenderType: "COMPANY", lenderName: "New Lender Ltd", lenderBusinessPartyId: null, shareholderProfileId: null, currencyCode: "AFN", liabilityLedgerAccountId: otherAccount });
});

test("without a loan account the form says what to do, and with approval ON it says so first", async ({ page }) => {
  await mock(page, workspace({ options: { ...workspace().options, liabilityAccounts: [] } }));
  await page.goto("/finance/add-money");
  await page.getByRole("button", { name: /Other loan/ }).click();
  await expect(page.getByRole("link", { name: "Chart of Accounts" }).last()).toHaveAttribute("href", "/finance/accounts?new=LOAN_PAYABLE");
  await expect(page.getByRole("form", { name: "Record loan" })).toHaveCount(0);
  await page.unrouteAll();
  await mock(page, workspace({ approvalRequired: true }));
  await page.reload();
  await page.getByRole("button", { name: /Other loan/ }).click();
  await expect(page.getByRole("note")).toContainText("Another person must approve this loan");
});

test("the loan register shows what was lent, repaid and owed, and its statement agrees with the ledger", async ({ page }) => {
  await mock(page);
  await page.goto(`/finance/loans?loanId=${loanId}`);
  const row = page.getByRole("region", { name: "Loans" }).getByRole("row", { name: /Outside Lender Ltd/ });
  await expect(row).toContainText("30,000");
  await expect(row).toContainText("5,000");
  await expect(row).toContainText("25,000");
  const report = page.getByRole("region", { name: "Loan statement" });
  await expect(report.getByRole("status")).toContainText("Agrees with the liability account.");
  await expect(report.getByRole("row", { name: /Repayment/ })).toContainText("25,000");
  await expect(report.getByRole("link", { name: "Loan received" })).toHaveAttribute("href", `/finance/general-ledger?journalId=${journal}`);
});

test("a repayment beyond what is owed is refused, in words", async ({ page }) => {
  const posted = await mock(page);
  await page.goto(`/finance/loans?loanId=${loanId}`);
  await page.getByRole("button", { name: "Repay" }).click();
  const form = page.getByRole("form", { name: "Repay loan" });
  await form.getByLabel("From which Safe?").selectOption({ label: "Main Safe" });
  await form.getByLabel("Amount (USD)").fill("30000");
  await form.getByRole("button", { name: "Record repayment" }).click();
  await expect(form.getByRole("alert")).toHaveText("This is more than is outstanding on the loan.");
  await form.getByLabel("Amount (USD)").fill("5000");
  await form.getByRole("button", { name: "Record repayment" }).click();
  await expect(page.getByText("Repayment recorded.")).toBeVisible();
  expect(posted.at(-1)).toMatchObject({ action: "repay", loanId, treasuryAccountId: safe, amount: "5000" });
  expect(posted[0]?.idempotencyKey, "a retry of one form is one request").toBe(posted[1]?.idempotencyKey);
});

test("a second person approves from the same page; a reversed loan and a fully repaid one offer no repayment", async ({ page }) => {
  const posted = await mock(page, workspace({ loans: [loan({ id: pendingId, status: "PENDING_APPROVAL", journalId: null, outstanding: "0" }), loan({ reversed: true, outstanding: "0" })] }));
  await page.goto(`/finance/loans?loanId=${loanId}`);
  const waiting = page.getByRole("region", { name: "Waiting for approval" });
  await waiting.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText("Approved and recorded.")).toBeVisible();
  expect(posted[0]).toMatchObject({ action: "decide", kind: "LOAN", id: pendingId, decision: "APPROVED" });
  await expect(page.getByRole("button", { name: "Repay" })).toHaveCount(0);
});

test("Dari, RTL and phone width", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem("abos.locale", "fa"));
  await mock(page);
  await page.goto("/finance/add-money");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("heading", { level: 1, name: "افزودن پول" })).toBeVisible();
  await expect(page.getByRole("button", { name: /قرض سهامدار/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  await page.goto("/finance/loans");
  await expect(page.getByRole("heading", { level: 1, name: "قرض‌ها" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
});

test("without loan permission the menu hides Loans and the page refuses", async ({ page }) => {
  await page.route("**/api/v1/auth/me", (route) => route.fulfill({ json: { ok: true, data: auth(["finance.report.operational.read"]) } }));
  await page.route(/\/api\/v1\/finance\/loans$/, (route) => route.fulfill({ status: 403, json: { ok: false, error: { code: "PERMISSION_DENIED", message: "No." } } }));
  await page.goto("/finance/loans");
  await expect(page.getByText("Loans need permission to read or record loans.")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Operations" }).getByRole("link", { name: "Loans" })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Operations" }).getByRole("link", { name: "Temporary funding" })).toHaveCount(0);
});

const missing = (...controls: readonly string[]) => readiness().accounts.map((account) => controls.includes(account.control) ? { ...account, status: "MISSING" } : account);

test("Add money says exactly which accounts are missing, and links each to a filled-in form", async ({ page }) => {
  await mock(page, workspace(), ALL, readiness({ accounts: missing("LOAN_PAYABLE", "REALIZED_FX_LOSS") }));
  await page.goto("/finance/add-money");
  const needs = page.getByRole("region", { name: "What loans still need" });
  await expect(needs).toContainText("Other Loan Payable");
  await expect(needs).toContainText("Realized FX Loss");
  await expect(needs).toContainText("only when foreign currency settles for less than the value it carried");
  await expect(needs).not.toContainText("Realized FX Gain");
  await expect(needs.getByRole("link", { name: "Create the account" }).first()).toHaveAttribute("href", "/finance/accounts?new=LOAN_PAYABLE");
  await expect(needs.getByRole("link", { name: "Create the account" }).last()).toHaveAttribute("href", "/finance/accounts?new=REALIZED_FX_LOSS");
});

test("nothing is said when everything is ready", async ({ page }) => {
  await mock(page);
  await page.goto("/finance/add-money");
  await expect(page.getByRole("button", { name: /Other loan/ })).toBeEnabled();
  await expect(page.getByRole("region", { name: "What loans still need" })).toHaveCount(0);
});

test("someone who cannot manage accounts is told whom to ask, in Dari too, and two active accounts are named as the problem", async ({ page }) => {
  await mock(page, workspace(), ALL, readiness({ canManageAccounts: false, accounts: readiness().accounts.map((a) => a.control === "REALIZED_FX_GAIN" ? { ...a, status: "AMBIGUOUS" } : a) }));
  await page.goto("/finance/add-money");
  const needs = page.getByRole("region", { name: "What loans still need" });
  await expect(needs).toContainText("Several active accounts have this role. Keep one.");
  await expect(needs).toContainText("Ask whoever manages the Chart of Accounts.");
  await expect(needs.getByRole("link")).toHaveCount(0);
  await page.getByRole("button", { name: "Switch to Dari" }).click();
  await expect(page.getByRole("region", { name: "آنچه قرض‌ها هنوز لازم دارند" })).toContainText("مفاد تحقق‌یافتهٔ تبادله اسعار");
});

test("an administrator sees which loan permissions reach nobody, by name, and where to give them", async ({ page }) => {
  const denied = { ok: false, error: { code: "PERMISSION_DENIED", message: "denied" } };
  await mock(page, workspace(), ["admin.roles.manage"], readiness({ canManageRoles: true, canManageAccounts: false, permissions: { canRead: false, canRecord: false, canRepay: false, canApprove: false } }));
  await page.route(/\/api\/v1\/finance\/loans$/, (route) => route.fulfill({ status: 403, json: denied }));
  await page.route("**/api/v1/admin/roles", (route) => route.fulfill({ json: { ok: true, data: [
    { id: "r1", status: "ACTIVE", permissions: ["finance.loan.read"], holders: [{ id: "u1", displayName: "Finance", status: "ACTIVE" }] },
    { id: "r2", status: "ACTIVE", permissions: ["finance.loan.record"], holders: [] },
    { id: "r3", status: "INACTIVE", permissions: ["finance.loan.repay"], holders: [{ id: "u1", displayName: "Finance", status: "ACTIVE" }] }] } }));
  await page.goto("/finance/add-money");
  const needs = page.getByRole("region", { name: "What loans still need" });
  await expect(needs).toContainText("Nobody holds these permissions:");
  await expect(needs).toContainText("Record loans, Repay loans, Approve loans.");
  await expect(needs).not.toContainText("View loans and lenders");
  await expect(needs.getByRole("link", { name: "Roles & permissions" })).toHaveAttribute("href", "/admin/roles");
});

test("a person who lacks a permission is told so, and approval is mentioned only when the company requires it", async ({ page }) => {
  const held = { canRead: true, canRecord: true, canRepay: false, canApprove: false };
  await mock(page, workspace(), ALL, readiness({ permissions: held }));
  await page.goto("/finance/add-money");
  const needs = page.getByRole("region", { name: "What loans still need" });
  await expect(needs).toContainText("You do not hold these permissions:");
  await expect(needs).toContainText("Repay loans.");
  await expect(needs).toContainText("Ask an administrator.");
  await page.unrouteAll();
  await mock(page, workspace(), ALL, readiness({ permissions: held, approvalRequired: true }));
  await page.reload();
  await expect(needs).toContainText("Repay loans, Approve loans.");
});

test("a repayment that needs a missing FX account is refused in words, with the way to fix it", async ({ page }) => {
  await mock(page);
  await page.route(/\/api\/v1\/finance\/loans$/, async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({ status: 422, json: { ok: false, error: { code: "REALIZED_FX_LOSS_ACCOUNT_REQUIRED", message: "x" } } });
      return;
    }
    await route.fallback();
  });
  await page.goto(`/finance/loans?loanId=${loanId}`);
  await page.getByRole("button", { name: "Repay" }).click();
  const form = page.getByRole("form", { name: "Repay loan" });
  await form.getByLabel("From which Safe?").selectOption({ label: "Main Safe" });
  await form.getByLabel("Amount (USD)").fill("100");
  await form.getByRole("button", { name: "Record repayment" }).click();
  await expect(form.getByRole("alert")).toContainText("This repayment realizes an FX loss. Create a Realized FX Loss account first. Nothing was recorded.");
  await expect(form.getByRole("link", { name: "Create the account" })).toHaveAttribute("href", "/finance/accounts?new=REALIZED_FX_LOSS");
});

test("a repayment that realizes a difference says so, and the statement shows it and no residual", async ({ page }) => {
  const afn = loan({ currency: "AFN", principal: "7000", basePrincipal: "100", outstanding: "0", baseOutstanding: "0" });
  await mock(page, workspace({ loans: [afn] }));
  await page.route(/\/api\/v1\/finance\/loans\/statement/, (route) => route.fulfill({ json: { ok: true, data: { ...statement, loan: afn, closing: { native: "0", base: "0" }, realizedFx: "-20",
    lines: [{ journalId: "j3", date: "2026-09-21", kind: "REPAYMENT", reference: "LR-1", amount: "7000", baseAmount: "100", treasuryBaseAmount: "120", realizedFx: "-20", effect: "-7000", balance: "0", treasury }] } } }));
  await page.goto(`/finance/loans?loanId=${loanId}`);
  const report = page.getByRole("region", { name: "Loan statement" });
  await expect(report.getByRole("columnheader", { name: "Realized FX" })).toBeVisible();
  await expect(report.getByRole("row", { name: /Repayment/ })).toContainText("−20 USD");
  await expect(report.getByRole("note")).toContainText("Accounting value still owed: 0 USD.");
  await expect(report.getByRole("note")).toContainText("Realized FX in this period: −20 USD.");
  await expect(report).not.toContainText("remains on the liability");
});

test("a statement with no difference has no FX column", async ({ page }) => {
  await mock(page);
  await page.goto(`/finance/loans?loanId=${loanId}`);
  const report = page.getByRole("region", { name: "Loan statement" });
  await expect(report.getByRole("status")).toBeVisible();
  await expect(report.getByRole("columnheader", { name: "Realized FX" })).toHaveCount(0);
});

test("a repayment message belongs to its loan: it follows the language, and opening another loan clears it", async ({ page }) => {
  const other = "9a000000-0000-4000-8000-000000000099";
  await mock(page, workspace({ loans: [loan(), loan({ id: other })] }));
  await page.goto(`/finance/loans?loanId=${loanId}`);
  await page.getByRole("button", { name: "Repay" }).click();
  const form = page.getByRole("form", { name: "Repay loan" });
  await form.getByLabel("From which Safe?").selectOption({ label: "Main Safe" });
  await form.getByLabel("Amount (USD)").fill("5000");
  await form.getByRole("button", { name: "Record repayment" }).click();
  const status = page.getByRole("main").getByRole("status").filter({ hasText: /Repayment recorded|بازپرداخت ثبت شد/ });
  await expect(status).toHaveText("Repayment recorded.");
  await page.getByRole("button", { name: "Switch to Dari" }).click();
  await expect(status).toHaveText("بازپرداخت ثبت شد.");
  await page.getByRole("button", { name: "Switch to English" }).click();
  await page.locator(`a[href="/finance/loans?loanId=${other}"]`).click();
  await expect(page).toHaveURL(new RegExp(`loanId=${other}`));
  await expect(page.getByText("Repayment recorded.")).toHaveCount(0);
});
