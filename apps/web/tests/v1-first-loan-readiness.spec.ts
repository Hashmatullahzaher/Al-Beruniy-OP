import { expect, test, type Page } from "@playwright/test";

import { createAccount, expectBusinessCounts, policyCard, readOnly, seedFirstRun, signIn, signOut } from "./support/first-run";

/**
 * The first loan in a company that has never used one, through the real UI, identity and database boundaries.
 *
 * It starts where an upgraded company starts: no loan account, no realized FX account and no role holding a loan permission. Nothing is
 * set up by SQL. SQL only reads and verifies. It resets only an explicitly disposable preview database and must run serially:
 *
 *   ABOS_V1_PREVIEW_E2E=1 pnpm exec playwright test v1-first-loan-readiness --workers=1
 */
test.use({ viewport: { width: 1440, height: 900 } });

const LOAN_PERMISSIONS = ["View loans and lenders", "Record loans", "Repay loans", "Approve loans"] as const;
const kabulDay = (offset: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kabul" }).format(new Date(Date.now() + offset * 86_400_000));

test.describe("V1 first loan readiness", () => {
  test.skip(process.env.ABOS_V1_PREVIEW_E2E !== "1", "Set ABOS_V1_PREVIEW_E2E=1 with an isolated preview database to run this.");

  test("a company is told what the first loan needs, and FX accounts are demanded only by a real difference", async ({ page }) => {
    test.setTimeout(300_000);
    const accounts = seedFirstRun();
    await expectBusinessCounts({ ledger_accounts: 0, treasury_accounts: 0, journals: 0 });

    // The company itself: a year, the accounts money needs, two Safes and two rates. No loan account and no FX account.
    await signIn(page, "demo.finance.manager", accounts["demo.finance.manager"]);
    const nav = page.getByRole("navigation", { name: "Operations" });
    await nav.getByRole("link", { name: "Financial calendar" }).click();
    const settings = page.getByRole("form", { name: "Financial calendar settings" });
    await settings.locator("label", { hasText: "Gregorian" }).first().locator("input[type=radio]").check();
    await settings.getByRole("button", { name: "Save settings" }).click();
    await expect(page.locator(".treasury-message.success")).toContainText("settings saved");
    const generator = page.getByRole("form", { name: "Generate fiscal year" });
    await generator.getByLabel("Starting Gregorian year").fill(String(new Date().getFullYear()));
    await generator.getByRole("button", { name: "Generate fiscal year" }).click();
    await expect(page.locator(".calendar-year").locator("tbody tr")).toHaveCount(12);
    await nav.getByRole("link", { name: "Workflow approvals" }).click();
    const chartCard = policyCard(page, "Chart of Accounts");
    await chartCard.getByLabel("Reason for this change").fill("Single operator: no second reviewer");
    await chartCard.getByRole("radio", { name: /Approval OFF/ }).check();
    await chartCard.getByRole("button", { name: "Save new version" }).click();
    await expect(chartCard.locator(".treasury-chip")).toHaveText("Approval OFF");
    await nav.getByRole("link", { name: "Chart of Accounts" }).click();
    await createAccount(page, { code: "1100", name: "USD Cash", type: "ASSET", control: "CASH" });
    await createAccount(page, { code: "1120", name: "AFN Cash", type: "ASSET", control: "CASH", currency: "AFN" });
    await nav.getByRole("link", { name: "Finance setup" }).click();
    for (const [name, currency, account] of [["Main USD Safe", "USD", "1100 · USD Cash"], ["Main AFN Safe", "AFN", "1120 · AFN Cash"]] as const) {
      await page.getByRole("button", { name: "Add account" }).click();
      const treasury = page.getByRole("form", { name: "Treasury account" });
      await treasury.getByLabel("Name (English) *").fill(name);
      await treasury.getByLabel("Type *").selectOption({ label: "Safe" });
      await treasury.getByLabel("Currency *").selectOption(currency);
      await treasury.getByLabel("Chart of Accounts account *").selectOption({ label: account });
      await treasury.getByRole("button", { name: "Save" }).click();
      await expect(page.getByRole("status").filter({ hasText: "Treasury account saved" })).toBeVisible();
    }
    await nav.getByRole("link", { name: "Exchange rates" }).click();
    for (const [day, value] of [[kabulDay(-1), "70"], [kabulDay(0), "56"]] as const) {
      const rateForm = page.getByRole("form", { name: "Record exchange rate" });
      await rateForm.getByLabel("Rate date").fill(day);
      await rateForm.getByLabel(/^Rate \(/).fill(value);
      await rateForm.getByRole("button", { name: "Record rate" }).click();
      await expect(page.locator(".treasury-message.success")).toContainText("exactly as entered");
    }
    await signOut(page);

    // An upgrade grants nothing. The administrator takes the company to that state: no role holds a loan permission.
    await signIn(page, "super.admin", accounts["super.admin"]);
    await setLoanPermissions(page, false);
    await signOut(page);

    // Without the permissions the person is told so, in words, and the Loans menu is gone. The forms are not offered.
    await signIn(page, "demo.finance.manager", accounts["demo.finance.manager"]);
    await expect(nav.getByRole("link", { name: "Loans" })).toHaveCount(0);
    await nav.getByRole("link", { name: "Add money" }).click();
    const needs = page.getByRole("region", { name: "What loans still need" });
    await expect(needs).toContainText("You do not hold these permissions:");
    for (const label of ["View loans and lenders", "Record loans", "Repay loans"]) await expect(needs).toContainText(label);
    await expect(needs).toContainText("Ask an administrator.");
    for (const name of ["Shareholder Loan Payable", "Other Loan Payable", "Realized FX Gain", "Realized FX Loss"]) await expect(needs).toContainText(name);
    await expect(needs).toContainText("Needed only when foreign currency settles for more than the value it carried.");
    await expect(page.getByRole("region", { name: "Where is this money coming from?" }).getByRole("button", { name: /Other loan/ })).toBeDisabled();

    // The same guidance in Dari, right to left.
    await page.evaluate(() => localStorage.setItem("abos.locale", "fa"));
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    const needsFa = page.getByRole("region", { name: "آنچه قرض‌ها هنوز لازم دارند" });
    await expect(needsFa).toContainText("شما این صلاحیت‌ها را ندارید:");
    await expect(needsFa).toContainText("مفاد تحقق‌یافتهٔ تبادله اسعار");
    await page.evaluate(() => localStorage.setItem("abos.locale", "en"));
    await page.reload();
    await signOut(page);

    await signIn(page, "super.admin", accounts["super.admin"]);
    await setLoanPermissions(page, true);
    await signOut(page);

    // With the permissions, each missing account leads to the existing form, filled in. Only the account this loan needs is created.
    await signIn(page, "demo.finance.manager", accounts["demo.finance.manager"]);
    await nav.getByRole("link", { name: "Add money" }).click();
    await expect(needs).not.toContainText("You do not hold these permissions:");
    const choices = page.getByRole("region", { name: "Where is this money coming from?" });
    await choices.getByRole("button", { name: /Other loan/ }).click();
    await expect(page.getByRole("region", { name: "Loan details" })).toContainText("First create a loan liability account in the");
    await expect(page.getByRole("form", { name: "Record loan" })).toHaveCount(0);
    await needs.getByRole("listitem").filter({ hasText: "Other Loan Payable" }).getByRole("link", { name: "Create the account" }).click();
    await expect(page).toHaveURL(/\/finance\/accounts\?new=LOAN_PAYABLE/);
    await createFromLink(page, "2520", "Other Loan Payable", "LIABILITY", "LOAN_PAYABLE");

    // A USD loan needs no FX account, to record or to repay.
    await recordLoan(page, nav, { lender: "USD Lender Ltd", safe: "Main USD Safe · USD", amount: "1000", currency: "USD", date: kabulDay(0) });
    await repay(page, { safe: "Main USD Safe", amount: "400", currency: "USD" });
    await expect(repaid(page)).not.toContainText("Realized FX");
    await repay(page, { safe: "Main USD Safe", amount: "600", currency: "USD" });
    await expect(page.getByRole("region", { name: "Loans" }).getByRole("row", { name: /USD Lender Ltd/ })).toContainText("0 USD");

    // An AFN repayment with no difference needs none either: at the loan's own rate, and at a changed rate from the same AFN.
    await recordLoan(page, nav, { lender: "AFN Lender Ltd", safe: "Main AFN Safe · AFN", amount: "14000", currency: "AFN", date: kabulDay(-1) });
    await repay(page, { safe: "Main AFN Safe", amount: "3500", currency: "AFN", date: kabulDay(-1) });
    await expect(repaid(page)).not.toContainText("Realized FX");
    await repay(page, { safe: "Main AFN Safe", amount: "3500", currency: "AFN", date: kabulDay(0) });
    await expect(repaid(page)).not.toContainText("Realized FX");
    await expectFxAccounts(0);
    const before = await readOnly<{ journals: number; repayments: number }>("SELECT (SELECT count(*)::int FROM abos.journals) AS journals, (SELECT count(*)::int FROM abos.loan_repayments) AS repayments");

    // AFN at another value joins the Safe. A repayment now has a real difference, and refuses atomically until its account exists.
    await recordLoan(page, nav, { lender: "Second Lender Ltd", safe: "Main AFN Safe · AFN", amount: "5600", currency: "AFN", date: kabulDay(0) });
    await page.goto("/finance/loans");
    await page.getByRole("region", { name: "Loans" }).getByRole("row", { name: /AFN Lender Ltd/ }).getByRole("link").first().click();
    await page.getByRole("button", { name: "Repay" }).click();
    const repayForm = page.getByRole("form", { name: "Repay loan" });
    await repayForm.getByLabel("From which Safe?").selectOption({ label: "Main AFN Safe" });
    await repayForm.getByLabel("Amount (AFN)").fill("3500");
    await repayForm.getByRole("button", { name: "Record repayment" }).click();
    const refused = repayForm.getByRole("alert");
    await expect(refused).toContainText("This repayment realizes an FX loss. Create a Realized FX Loss account first. Nothing was recorded.");
    const after = await readOnly<{ journals: number; repayments: number }>("SELECT (SELECT count(*)::int FROM abos.journals) AS journals, (SELECT count(*)::int FROM abos.loan_repayments) AS repayments");
    expect(after[0], "only the second loan was added: the refused repayment left nothing").toEqual({ journals: before[0]!.journals + 1, repayments: before[0]!.repayments });
    await refused.getByRole("link", { name: "Create the account" }).click();
    await expect(page).toHaveURL(/\/finance\/accounts\?new=REALIZED_FX_LOSS/);
    await createFromLink(page, "5910", "Realized FX Loss", "EXPENSE", "REALIZED_FX_LOSS");
    await expectFxAccounts(1);

    // The same repayment now posts, and the difference is its own line. The Gain account was never needed.
    await page.goto("/finance/loans");
    await page.getByRole("region", { name: "Loans" }).getByRole("row", { name: /AFN Lender Ltd/ }).getByRole("link").first().click();
    await repay(page, { safe: "Main AFN Safe", amount: "3500", currency: "AFN" });
    await expect(repaid(page)).toContainText("Realized FX loss:");
    const lines = await readOnly<{ account: string }>("SELECT la.account_code AS account FROM abos.journal_lines jl JOIN abos.journals j ON j.id = jl.journal_id JOIN abos.ledger_accounts la ON la.id = jl.ledger_account_id WHERE jl.source_type = 'LOAN_REPAYMENT' ORDER BY j.created_at DESC, jl.line_number DESC LIMIT 1");
    expect(lines).toEqual([{ account: "5910" }]);
    const balance = await readOnly<{ debit: string; credit: string }>("SELECT sum(base_debit)::text AS debit, sum(base_credit)::text AS credit FROM abos.journal_lines");
    expect(balance[0]!.debit).toBe(balance[0]!.credit);
  });
});

/** The administrator adds or removes the four loan permissions on the one Finance role, in Roles & permissions. */
async function setLoanPermissions(page: Page, allowed: boolean): Promise<void> {
  await page.goto("/admin/roles");
  await page.getByRole("button", { name: /^Finance Manager/ }).click();
  const editor = page.getByRole("form", { name: "Role editor" });
  for (const label of LOAN_PERMISSIONS) await editor.locator(".permission-row", { hasText: label }).locator("input").setChecked(allowed);
  await editor.getByRole("button", { name: "Save role" }).click();
  await expect(page.locator(".treasury-message.success")).toBeVisible();
}

/** The form a readiness link opens is already filled in: the person adds only the code. */
async function createFromLink(page: Page, code: string, name: string, type: string, control: string): Promise<void> {
  const form = page.getByRole("form", { name: "Account form" });
  await expect(form.getByLabel("Account name")).toHaveValue(name);
  await expect(form.getByLabel("Account type")).toHaveValue(type);
  await expect(form.getByLabel("Control type")).toHaveValue(control);
  await form.getByLabel("Account code").fill(code);
  await form.getByRole("button", { name: "Create account" }).click();
  await expect(page.locator(".treasury-message.success")).toContainText("Account created under the current approval policy.");
}

async function recordLoan(page: Page, nav: ReturnType<Page["getByRole"]>, loan: { lender: string; safe: string; amount: string; currency: string; date: string }): Promise<void> {
  await nav.getByRole("link", { name: "Add money" }).click();
  await page.getByRole("region", { name: "Where is this money coming from?" }).getByRole("button", { name: /Other loan/ }).click();
  const form = page.getByRole("form", { name: "Record loan" });
  await form.getByLabel("Who lent the money?").selectOption({ label: "A company" });
  await form.getByRole("textbox", { name: "Name" }).fill(loan.lender);
  await form.getByLabel("Which Safe did it go into?").selectOption({ label: loan.safe });
  await form.getByLabel(`Amount (${loan.currency})`).fill(loan.amount);
  await form.getByLabel("Date").fill(loan.date);
  await form.getByRole("button", { name: "Record loan" }).click();
  await expect(page.getByText("Loan recorded.")).toBeVisible();
  await page.getByRole("link", { name: "View the loan" }).click();
}

async function repay(page: Page, repayment: { safe: string; amount: string; currency: string; date?: string }): Promise<void> {
  await page.getByRole("button", { name: "Repay" }).click();
  const form = page.getByRole("form", { name: "Repay loan" });
  await form.getByLabel("From which Safe?").selectOption({ label: repayment.safe });
  await form.getByLabel(`Amount (${repayment.currency})`).fill(repayment.amount);
  if (repayment.date !== undefined) await form.getByLabel("Date").fill(repayment.date);
  // The previous repayment's message is still on screen, so it proves nothing about this one. Wait for this request's own answer.
  const answered = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/v1/finance/loans");
  await form.getByRole("button", { name: "Record repayment" }).click();
  expect((await answered).status()).toBe(201);
  await expect(form).toHaveCount(0);
  await expect(repaid(page)).toBeVisible();
}

function repaid(page: Page) {
  return page.locator(".treasury-message.success").filter({ hasText: "Repayment recorded." });
}

async function expectFxAccounts(count: number): Promise<void> {
  const rows = await readOnly<{ n: number }>("SELECT count(*)::int AS n FROM abos.ledger_accounts WHERE control_account_type IN ('REALIZED_FX_GAIN', 'REALIZED_FX_LOSS')");
  expect(rows).toEqual([{ n: count }]);
}
