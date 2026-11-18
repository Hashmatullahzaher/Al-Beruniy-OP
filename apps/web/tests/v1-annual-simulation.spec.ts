import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";

import {
  accountStatementTable, generalLedgerTable, reportCsv, safeStatementTable, trialBalanceTable, type AccountStatementView, type BalanceSheetView, type ExportLedgerLine,
  type ExportLedgerTotal, type IncomeStatementView, type LoanStatementView, type LoanWorkspace, type ManagementSummaryView, type ShareholderStatementView,
  type TreasuryStatementView, type TrialBalanceView
} from "@abos/contracts";
import { expect, test, type Page } from "@playwright/test";

import { decodeReportCsv, spreadsheetHazards } from "./support/csv";
import { createAccount, employeeHolding, readOnly, seedFirstRun, setupOnly, signIn, signOut } from "./support/first-run";

/**
 * V1 ANNUAL SIMULATION 2026: one synthetic company from zero through a financial year, entered through the real screens on a disposable
 * database, then reconciled against an accounting oracle that is written here by hand, before any report is read.
 *
 * Nothing in the oracle comes from the application. Every business event goes through the product's own forms. SQL only reads, to verify.
 * It resets only an explicitly disposable preview database and must run serially, on a production build:
 *
 *   ABOS_V1_PREVIEW_E2E=1 pnpm exec playwright test v1-annual-simulation --workers=1
 *
 * The scenario (USD, the accounting currency):
 *   02 Jan  Shareholder A puts in capital 100,000          05 Jan  Shareholder B puts in capital 50,000
 *   01 Feb  office and setup expense 12,000                10 Mar  sale receipt 80,000 (unit A-101)
 *   05 Apr  Shareholder A lends 20,000 (a loan, not capital) 01 May  salaries 18,000
 *   15 Jun  transfer 40,000 Main Safe -> Reserve Safe       01 Jul  expense 3,000 entered by mistake, then reversed
 *   20 Aug  vendor expense 25,000                          15 Sep  sale receipt 120,000 (unit B-204)
 *   01 Oct  repay 5,000 of the shareholder loan            20 Oct  utilities 10,000
 *   Nov     an AFN loan of 700,000 received into an empty AFN Safe and repaid in two halves at different rates: nothing is left, nothing is realized
 */
// A missing control fails in seconds, not at the end of the whole test's budget. It shortens no wait that could succeed.
test.use({ viewport: { width: 1440, height: 900 }, actionTimeout: 30_000 });

const COMPANY = "V1 ANNUAL SIMULATION 2026";
const HOLDER_A = "Synthetic Shareholder A";
const HOLDER_B = "Synthetic Shareholder B";
const MAIN = "Main USD Safe";
const RESERVE = "Reserve USD Safe";
const AFN_SAFE = "AFN Safe";
const RESERVE_FA = "صندوق ذخیره";
const UTILITIES_FA = "برق و آب";
const FX_SAFE = "FX Test AFN Safe";
/** A harmless synthetic PDF: a real header and trailer, no content. */
const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n", "utf8");
const SCANNER = process.env.ABOS_MALWARE_SCANNER === "windows-defender";
/** The passphrase tests/support/first-run.ts gives every employee it creates on the disposable database. */
const PASSPHRASE = "Synthetic confidentiality check passphrase 2026";
/** What only the Finance Manager's permissions may show: people, lenders, references, descriptions and reasons. */
const PRIVATE_DETAIL = [HOLDER_A, HOLDER_B, "Synthetic Buyer", "Synthetic Vendor Ltd", "Synthetic AFN Lender Ltd", "SIM-LOAN-A", "SIM-AFN-LOAN", "SIM-EXP-0201",
  "Office setup and furniture", "Salaries for April", "Entered by mistake on 1 July", "SALE A-101"];

/** The oracle: what the ledger must hold at the end of October, worked out by hand from the scenario above. */
export const ORACLE = {
  revenue: "200000.00", expenses: "65000.00", netProfit: "135000.00", capital: "150000.00", loanOutstanding: "15000.00",
  assets: "300000.00", liabilities: "15000.00", equity: "285000.00", trialBalanceSide: "365000.00",
  mainSafe: "260000.00", reserveSafe: "40000.00",
  expenseByAccount: { office: "12000.00", salaries: "18000.00", vendor: "25000.00", utilities: "10000.00" }
} as const;

let accounts: Record<string, string> = {};
/** Every action a person takes in the simulation, per workflow, for the operator-experience record. */
const actions: Record<string, number> = {};
const act = (workflow: string, count = 1) => { actions[workflow] = (actions[workflow] ?? 0) + count; };

const nav = (page: Page) => page.getByRole("navigation", { name: "Operations" });
const open = async (page: Page, link: string) => { await nav(page).getByRole("link", { name: link, exact: true }).click(); };
const safeCard = (page: Page, safe: string) => page.locator(".safe-card").filter({ has: page.getByRole("heading", { name: safe, exact: true }) });
const money = (value: string) => new RegExp(`(^|\\D)${value.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}(\\.00)? USD`);

/** Kabul's calendar day: the reports' "as of today". */
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kabul" }).format(new Date());

/** What the simulation saw, written beside the run when ABOS_SIM_RECORD_DIR is set, so the figures in a release report are the recorded ones. */
const record: Record<string, unknown> = {};
function keep(name: string, value: unknown): void {
  record[name] = value;
  const directory = process.env.ABOS_SIM_RECORD_DIR;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  writeFileSync(`${directory}/annual-simulation-record.json`, JSON.stringify(record, null, 1));
}

/** A raw response, as this person's browser receives it. */
async function raw(page: Page, path: string): Promise<{ status: number; text: string }> {
  return page.evaluate(async (url) => { const response = await fetch(url, { cache: "no-store" }); return { status: response.status, text: await response.text() }; }, path);
}

async function data<T>(page: Page, path: string): Promise<T> {
  const answer = await raw(page, path);
  expect(answer.status, path).toBe(200);
  return (JSON.parse(answer.text) as { data: T }).data;
}

/** A decimal string without trailing zeros, so 15000 and 15000.00 compare equal. Text only: no number is ever built from an amount. */
function plain(value: string): string {
  const trimmed = value.includes(".") ? value.replace(/0+$/, "").replace(/\.$/, "") : value;
  return trimmed === "-0" || trimmed === "" ? "0" : trimmed;
}
const expectAmount = (actual: string | null | undefined, expected: string, what: string) => expect(plain(actual ?? "missing"), what).toBe(plain(expected));

/** Hundredths as an integer, for checking that an opening plus its movements gives the closing. Exact for two decimals. */
function cents(value: string): bigint {
  const negative = value.startsWith("-");
  const [whole = "0", fraction = ""] = (negative ? value.slice(1) : value).split(".");
  expect(fraction.length, `${value} has at most two decimals`).toBeLessThanOrEqual(2);
  const amount = BigInt(whole) * BigInt(100) + BigInt(`${fraction}00`.slice(0, 2));
  return negative ? -amount : amount;
}

/** Clicks an export button and reads the saved file, byte-order mark included. */
async function downloadCsv(target: Page, button = "CSV (Excel-compatible)"): Promise<{ name: string; text: string; bytes: Buffer }> {
  const download = target.waitForEvent("download");
  await target.getByRole("button", { name: button }).click();
  const file = await download;
  const bytes = await readFile(await file.path());
  return { name: file.suggestedFilename(), text: bytes.toString("utf8"), bytes };
}

/** The generation time written in a CSV's header block, so the rest of the file can be compared exactly. */
function generatedAt(csv: string): string {
  const match = /^"(?:Generated at|زمان تهیه)","([^"]+)"\r$/m.exec(csv);
  expect(match, "the file says when it was made").not.toBeNull();
  return match?.[1] ?? "";
}

/** What the screen itself received for a report, captured while the action that loads it runs. */
async function screenPayload<T>(target: Page, path: string, action: () => Promise<unknown>): Promise<T> {
  const response = target.waitForResponse((answer) => answer.url().includes(path) && answer.request().method() === "GET" && answer.ok());
  await action();
  return ((await (await response).json()) as { data: T }).data;
}

/** An export request as the browser makes it. */
async function exportGet(target: Page, query: string): Promise<{ status: number; text: string; disposition: string | null; cache: string | null }> {
  return target.evaluate(async (search) => {
    const response = await fetch(`/api/v1/finance/report-export?${search}`, { cache: "no-store" });
    return { status: response.status, text: await response.text(), disposition: response.headers.get("Content-Disposition"), cache: response.headers.get("Cache-Control") };
  }, query);
}

const exportAudits = () => readOnly<{ actor: string; after: Record<string, unknown>; metadata: Record<string, unknown> }>(
  "SELECT actor_user_account_id::text AS actor, after_state AS after, metadata FROM abos.audit_records WHERE action = 'FINANCE_REPORT_EXPORTED' ORDER BY occurred_at, id");

async function signInAs(page: Page, login: string): Promise<void> {
  await signIn(page, login, PASSPHRASE);
}

async function manager(page: Page): Promise<void> {
  await signIn(page, "demo.finance.manager", accounts["demo.finance.manager"]);
}

async function expectSafe(page: Page, safe: string, amount: string): Promise<void> {
  await open(page, "Safes");
  await expect(safeCard(page, safe).getByLabel("Book balance")).toContainText(money(amount));
}

/** Independent read of the ledger: net debit-positive balance per account code, straight from posted journal lines. */
async function ledgerBalances(): Promise<Record<string, string>> {
  const rows = await readOnly<{ code: string; net: string }>(
    `SELECT la.account_code AS code, to_char(sum(jl.base_debit - jl.base_credit), 'FM999999999990.00') AS net
       FROM abos.journal_lines jl JOIN abos.journals j ON j.id = jl.journal_id JOIN abos.ledger_accounts la ON la.id = jl.ledger_account_id
      WHERE j.status = 'POSTED' GROUP BY la.account_code ORDER BY la.account_code`);
  return Object.fromEntries(rows.map((row) => [row.code, row.net]));
}

async function journalCount(): Promise<number> {
  return Number((await readOnly<{ n: string }>("SELECT count(*)::text AS n FROM abos.journals WHERE status = 'POSTED'"))[0]?.n);
}

async function recordExpense(page: Page, values: { date: string; safe: string; type: string; amount: string; reference: string; purpose: string }): Promise<void> {
  await open(page, "Record expense");
  const form = page.getByRole("form", { name: "Record expense" });
  await form.getByLabel("Date *").fill(values.date);
  await form.getByLabel("Paid from *").selectOption({ label: `${values.safe} · USD` });
  await form.getByLabel("Expense type *").selectOption({ label: values.type });
  await form.getByLabel("Amount (USD) *").fill(values.amount);
  await form.getByLabel("Receipt or reference number *").fill(values.reference);
  await form.getByLabel("What was it for? *").fill(values.purpose);
  await form.getByRole("button", { name: "Record expense" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Expense recorded" })).toBeVisible();
  act("expense", 8);
}

async function receiveCash(page: Page, values: { date: string; safe: string; amount: string; payer: string; income: string; reference: string }): Promise<void> {
  await open(page, "Safes");
  await safeCard(page, values.safe).getByRole("button", { name: "Receive cash" }).click();
  const form = page.getByRole("form", { name: `Receive cash — ${values.safe}` });
  await form.getByLabel("Amount *").fill(values.amount);
  await form.getByLabel("Date *").fill(values.date);
  await form.getByLabel("Or a name").fill(values.payer);
  await form.getByLabel("Income account *").selectOption({ label: values.income });
  await form.getByLabel("Reference (optional)").fill(values.reference);
  await form.getByRole("button", { name: "Save" }).click();
  await expect(page.locator(".treasury-message.success")).toContainText("Money received and recorded.");
  act("receipt", 8);
}

test.describe.serial("V1 annual simulation 2026", () => {
  test.skip(process.env.ABOS_V1_PREVIEW_E2E !== "1", "Set ABOS_V1_PREVIEW_E2E=1 with an isolated preview database to run this.");

  test("the company is set up from zero: people, financial year, accounts, three Safes, expense types and the first capital", async ({ page, browser }) => {
    test.setTimeout(600_000);
    accounts = seedFirstRun();
    expect(await journalCount()).toBe(0);

    // The administrator creates the people. The administrator cannot edit company details or touch Finance: each needs its own permission.
    await signIn(page, "super.admin", accounts["super.admin"]);
    await open(page, "Company");
    await expect(page.getByRole("form", { name: "Edit company details" })).toHaveCount(0);
    const records = await employeeHolding(page, browser, "sim.company.records", ["Manage company details"]);
    await records.goto("/admin/company");
    const company = records.getByRole("form", { name: "Edit company details" });
    await company.getByLabel("Legal name").fill(COMPANY);
    await company.getByRole("button", { name: "Save" }).click();
    await expect(records.locator(".treasury-message.success")).toBeVisible();
    await expect(records.getByRole("main")).toContainText(COMPANY);
    await records.context().close();
    const reader = await employeeHolding(page, browser, "sim.report.reader", ["View Finance reports and journals"]);
    await reader.context().close();
    const keeper = await employeeHolding(page, browser, "sim.safe.keeper", ["Request journal reversals"]);
    await keeper.context().close();
    await signOut(page);

    // The Finance Manager: Getting started, Simple mode, the 2026 financial year, the starter accounts, the Main USD Safe and an expense type.
    await manager(page);
    await open(page, "Getting started");
    await page.getByRole("radio", { name: /Simple \/ Single Operator/ }).check();
    await page.getByRole("button", { name: "Use Simple / Single Operator" }).click();
    await expect(page.getByText("2 of 8 steps done")).toBeVisible();
    await expect(page.getByLabel("Year", { exact: true })).toHaveValue("2026");
    await page.getByRole("button", { name: "Create the financial year" }).click();
    await expect(page.getByText("3 of 8 steps done")).toBeVisible();
    await page.getByRole("button", { name: "Create the starter accounts" }).click();
    await expect(page.getByText("4 of 8 steps done")).toBeVisible();
    await expect(page.getByLabel("Name", { exact: true }).first()).toHaveValue(MAIN);
    await page.getByRole("button", { name: "Create the Safe" }).click();
    await expect(page.getByText("Safe created with a balance of zero.")).toBeVisible();
    await page.getByRole("button", { name: "Save the expense type" }).click();
    await expect(page.getByText("5 of 8 steps done")).toBeVisible();
    act("first setup", 7);

    // 2 January: Shareholder A's capital, back-dated to the day it was received, confirmed before anything is posted.
    await page.getByRole("button", { name: "Record shareholder capital" }).click();
    const capital = page.getByRole("form", { name: "Record shareholder capital" });
    await capital.getByLabel("Shareholder name").fill(HOLDER_A);
    await capital.getByLabel("Agreed capital (optional)").fill("100000");
    await capital.getByLabel("Amount received now (USD)").fill("100000");
    await capital.getByLabel("Date").fill("2026-01-02");
    await page.getByRole("button", { name: "Review" }).click();
    await expect(page.getByText(`Record 100,000 USD of shareholder capital from ${HOLDER_A} into ${MAIN}`)).toBeVisible();
    expect(await journalCount()).toBe(0);
    await page.getByRole("button", { name: "Confirm and record" }).click();
    await expect(page.getByText("Your first transaction is posted and balanced.")).toBeVisible();
    await expect(page.getByText("8 of 8 steps done")).toBeVisible();
    act("capital", 7);
    expect(await ledgerBalances()).toEqual({ "1100": "100000.00", "3100": "-100000.00" });

    // The rest of the Chart of Accounts this company needs. One code starts with zeros, to follow it into the exports.
    await open(page, "Chart of Accounts");
    for (const account of [
      { code: "1110", name: "Reserve Cash", type: "ASSET", control: "CASH" },
      { code: "1120", name: "AFN Cash", type: "ASSET", control: "CASH", currency: "AFN" },
      { code: "2510", name: "Shareholder Loans", type: "LIABILITY", control: "SHAREHOLDER_LOAN" },
      { code: "2520", name: "Loans Payable", type: "LIABILITY", control: "LOAN_PAYABLE" },
      { code: "4100", name: "Sales Revenue", type: "REVENUE" },
      { code: "4910", name: "Realized FX Gain", type: "REVENUE", control: "REALIZED_FX_GAIN" },
      { code: "5200", name: "Salaries", type: "EXPENSE" },
      { code: "5300", name: "Vendor and Operating Costs", type: "EXPENSE" },
      { code: "0012", name: "Utilities", type: "EXPENSE" },
      { code: "5910", name: "Realized FX Loss", type: "EXPENSE", control: "REALIZED_FX_LOSS" },
      // Never used: its name starts like a formula, to follow that into the Trial balance export.
      { code: "9990", name: "=1+1 formula check", type: "EXPENSE" }
    ]) { await createAccount(page, account); act("chart of accounts", 5); }

    // Two more Safes and three more expense types, in Finance setup.
    await open(page, "Finance setup");
    for (const [name, currency, ledger] of [[RESERVE, "USD", "1110 · Reserve Cash"], [AFN_SAFE, "AFN", "1120 · AFN Cash"]] as const) {
      await page.getByRole("button", { name: "Add account" }).click();
      const treasury = page.getByRole("form", { name: "Treasury account" });
      await treasury.getByLabel("Name (English) *").fill(name);
      if (name === RESERVE) await treasury.getByLabel("Name (Dari)").fill(RESERVE_FA);
      await treasury.getByLabel("Type *").selectOption({ label: "Safe" });
      await treasury.getByLabel("Currency *").selectOption(currency);
      await treasury.getByLabel("Chart of Accounts account *").selectOption({ label: ledger });
      await treasury.getByRole("button", { name: "Save" }).click();
      await expect(page.getByRole("status").filter({ hasText: "Treasury account saved" })).toBeVisible();
      act("safe creation", 6);
    }
    for (const [code, name, ledger] of [["SALARY", "Salaries", "5200 · Salaries"], ["VENDOR", "Vendors and operations", "5300 · Vendor and Operating Costs"],
      ["UTIL", "Utilities", "0012 · Utilities"]] as const) {
      await page.getByRole("button", { name: "Add expense type" }).click();
      const type = page.getByRole("form", { name: "Expense type" });
      await type.getByLabel("Code *").fill(code);
      await type.getByLabel("Name (English) *").fill(name);
      if (code === "UTIL") await type.getByLabel("Name (Dari)").fill(UTILITIES_FA);
      await type.getByLabel("Expense account in the Chart of Accounts *").selectOption({ label: ledger });
      await type.getByRole("button", { name: "Save" }).click();
      await expect(page.getByRole("status").filter({ hasText: "Expense type saved" })).toBeVisible();
    }
    await expectSafe(page, MAIN, "100000");
    await expectSafe(page, RESERVE, "0");
  });

  test("January to October: capital, expenses, sales receipts, a shareholder loan, a transfer, a reversal and a repayment", async ({ page }) => {
    test.setTimeout(600_000);
    await manager(page);

    // 5 January: Shareholder B is added and puts in 50,000.
    await open(page, "Shareholders");
    await page.getByRole("button", { name: "Add shareholder" }).click();
    const add = page.getByRole("form", { name: "Add shareholder" });
    await add.getByLabel("Name").fill(HOLDER_B);
    await add.getByLabel("What are they putting in?").selectOption({ label: "Cash into a Safe" });
    await add.getByLabel("Amount").fill("50000");
    await add.getByLabel("Date").fill("2026-01-05");
    await add.getByLabel("Which Safe did it go into?").selectOption({ label: `${MAIN} · USD` });
    await add.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("status").filter({ hasText: /Shareholder and capital saved · CAP-20260105-/ })).toBeVisible();
    act("shareholder and capital", 7);
    await expectSafe(page, MAIN, "150000");
    expect(await ledgerBalances()).toMatchObject({ "1100": "150000.00", "3100": "-150000.00" });

    // 1 February: office and setup expense.
    await recordExpense(page, { date: "2026-02-01", safe: MAIN, type: "Office supplies", amount: "12000", reference: "SIM-EXP-0201", purpose: "Office setup and furniture" });
    await expectSafe(page, MAIN, "138000");

    // 10 March: sale of unit A-101. V1 has no property-sales workflow, so the receipt goes through Receive cash against Sales Revenue.
    await receiveCash(page, { date: "2026-03-10", safe: MAIN, amount: "80000", payer: "Synthetic Buyer of Unit A-101", income: "4100 · Sales Revenue", reference: "SALE A-101" });
    await expectSafe(page, MAIN, "218000");

    // 5 April: Shareholder A lends 20,000. A liability: not capital, not income.
    await open(page, "Add money");
    await page.getByRole("region", { name: "Where is this money coming from?" }).getByRole("button", { name: /Shareholder loan/ }).click();
    const loan = page.getByRole("form", { name: "Record loan" });
    await loan.getByLabel("Which shareholder?").selectOption({ label: HOLDER_A });
    await loan.getByLabel("Which Safe did it go into?").selectOption({ label: `${MAIN} · USD` });
    await loan.getByLabel(/^Amount/).fill("20000");
    await loan.getByLabel("Date").fill("2026-04-05");
    await loan.getByLabel("Reference (optional)").fill("SIM-LOAN-A");
    await loan.getByRole("button", { name: "Record loan" }).click();
    await expect(page.getByText("Loan recorded.")).toBeVisible();
    act("loan", 8);
    await expectSafe(page, MAIN, "238000");

    // 1 May: salaries.
    await recordExpense(page, { date: "2026-05-01", safe: MAIN, type: "Salaries", amount: "18000", reference: "SIM-SAL-0501", purpose: "Salaries for April" });
    await expectSafe(page, MAIN, "220000");

    // 15 June: 40,000 moves to the Reserve Safe. The company's money does not change.
    await open(page, "Safes");
    await safeCard(page, MAIN).getByRole("button", { name: "Transfer" }).click();
    const transfer = page.getByRole("form", { name: `Transfer — ${MAIN}` });
    await transfer.getByLabel("To which account? *").selectOption({ label: `${RESERVE} · USD` });
    await transfer.getByLabel("Amount *").fill("40000");
    await transfer.getByLabel("Date *").fill("2026-06-15");
    await transfer.getByLabel("Reference (optional)").fill("-TRANSFER 0615");
    await transfer.getByRole("button", { name: "Save" }).click();
    await expect(page.locator(".treasury-message.success")).toContainText("Transfer recorded.");
    act("transfer", 7);
    await expect(safeCard(page, MAIN).getByLabel("Book balance")).toContainText(money("180000"));
    await expect(safeCard(page, RESERVE).getByLabel("Book balance")).toContainText(money("40000"));

    // 1 July: an expense entered by mistake, then reversed. Both stay in the books.
    await recordExpense(page, { date: "2026-07-01", safe: MAIN, type: "Office supplies", amount: "3000", reference: "SIM-MISTAKE-0701", purpose: "=1+1 entered by mistake" });
    await expectSafe(page, MAIN, "177000");
    const beforeReversal = await journalCount();
    await open(page, "Journal reversals");
    await page.locator("tr").filter({ hasText: "SIM-MISTAKE-0701" }).getByRole("button", { name: "Reverse" }).click();
    const reversal = page.locator(".reversal-form");
    await reversal.getByLabel("Reason *").fill("Entered by mistake on 1 July");
    await reversal.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Reversal posted.")).toBeVisible();
    act("reversal", 4);
    expect(await journalCount()).toBe(beforeReversal + 1);
    await expectSafe(page, MAIN, "180000");

    // 20 August: a vendor is paid, through Pay on the Safe.
    await safeCard(page, MAIN).getByRole("button", { name: "Pay" }).click();
    const pay = page.getByRole("form", { name: `Pay — ${MAIN}` });
    await pay.getByLabel("Kind of payment *").selectOption("SUPPLIER");
    await pay.getByLabel("An expense").check();
    await pay.getByLabel("Expense type *").selectOption({ label: "Vendors and operations" });
    // An expense payment names only a party already on file, so the vendor's name goes into the description.
    await pay.getByLabel("Description *").fill("@Synthetic Vendor Ltd: site services and materials");
    await pay.getByLabel("Amount *").fill("25000");
    await pay.getByLabel("Date *").fill("2026-08-20");
    await pay.getByLabel("Reference *").fill("SIM-VENDOR-0820");
    await pay.getByRole("button", { name: "Save" }).click();
    await expect(page.locator(".treasury-message.success")).toContainText("Payment recorded.");
    act("payment", 9);
    await expect(safeCard(page, MAIN).getByLabel("Book balance")).toContainText(money("155000"));

    // 15 September: sale of unit B-204.
    await receiveCash(page, { date: "2026-09-15", safe: MAIN, amount: "120000", payer: "Synthetic Buyer of Unit B-204", income: "4100 · Sales Revenue", reference: "+SALE B-204" });
    await expectSafe(page, MAIN, "275000");

    // 1 October: 5,000 of the shareholder loan is repaid.
    await open(page, "Loans");
    await page.getByRole("region", { name: "Loans" }).getByRole("link", { name: HOLDER_A }).click();
    await page.getByRole("button", { name: "Repay" }).click();
    const repay = page.getByRole("form", { name: "Repay loan" });
    await repay.getByLabel("From which Safe?").selectOption({ label: MAIN });
    await repay.getByLabel("Amount (USD)").fill("5000");
    await repay.getByLabel("Date").fill("2026-10-01");
    await repay.getByRole("button", { name: "Record repayment" }).click();
    await expect(page.getByText("Repayment recorded.")).toBeVisible();
    act("loan repayment", 6);
    await expectSafe(page, MAIN, "270000");

    // 20 October: utilities, charged to the account whose code starts with zeros.
    await recordExpense(page, { date: "2026-10-20", safe: MAIN, type: "Utilities", amount: "10000", reference: "SIM-UTIL-1020", purpose: "برق و آب (electricity and water)" });
    await expectSafe(page, MAIN, "260000");
    await expect(safeCard(page, RESERVE).getByLabel("Book balance")).toContainText(money("40000"));

    // The ledger, read independently, against the oracle. Debit-positive nets per account.
    expect(await ledgerBalances()).toEqual({
      "0012": "10000.00", "1100": "260000.00", "1110": "40000.00", "2510": "-15000.00", "3100": "-150000.00", "4100": "-200000.00",
      "5100": "12000.00", "5200": "18000.00", "5300": "25000.00"
    });
    keep("actionsPerWorkflow", actions);
    keep("ledgerEndOfOctober", await ledgerBalances());
  });

  test("November: an AFN loan into an empty AFN Safe is repaid in two halves at different rates and leaves nothing behind", async ({ page }) => {
    test.setTimeout(300_000);
    await manager(page);

    // Three days, three rates: 70, then 65, then 80 AFN to the dollar.
    await open(page, "Exchange rates");
    for (const [day, rate] of [["2026-11-03", "70"], ["2026-11-10", "65"], ["2026-11-17", "80"]] as const) {
      const rateForm = page.getByRole("form", { name: "Record exchange rate" });
      await rateForm.getByLabel("Rate date").fill(day);
      await rateForm.getByLabel(/^Rate \(/).fill(rate);
      await rateForm.getByRole("button", { name: "Record rate" }).click();
      await expect(page.getByRole("main")).toContainText(day);
    }
    act("exchange rates", 9);

    // 3 November: 700,000 AFN arrives at 70, so the loan and the Safe both carry 10,000.00 USD.
    await open(page, "Add money");
    await page.getByRole("region", { name: "Where is this money coming from?" }).getByRole("button", { name: /Other loan/ }).click();
    const loan = page.getByRole("form", { name: "Record loan" });
    await loan.getByLabel("Who lent the money?").selectOption({ label: "A company" });
    await loan.getByRole("textbox", { name: "Name" }).fill("Synthetic AFN Lender Ltd");
    await loan.getByLabel("Which Safe did it go into?").selectOption({ label: `${AFN_SAFE} · AFN` });
    await loan.getByLabel("Amount (AFN)").fill("700000");
    await loan.getByLabel("Date").fill("2026-11-03");
    await loan.getByLabel("Reference (optional)").fill("SIM-AFN-LOAN");
    await loan.getByRole("button", { name: "Record loan" }).click();
    await expect(page.getByText("Loan recorded.")).toBeVisible();
    expect(await ledgerBalances()).toMatchObject({ "1120": "10000.00", "2520": "-10000.00" });

    // 10 and 17 November: two repayments of 350,000 AFN from the same Safe. The day's rate has moved; it must realize nothing.
    await page.getByRole("link", { name: "View the loan" }).click();
    for (const [day, left] of [["2026-11-10", "350,000"], ["2026-11-17", "0"]] as const) {
      await page.getByRole("button", { name: "Repay" }).click();
      const repay = page.getByRole("form", { name: "Repay loan" });
      await repay.getByLabel("Amount (AFN)").fill("350000");
      await repay.getByLabel("Date").fill(day);
      await repay.getByRole("button", { name: "Record repayment" }).click();
      await expect(page.locator(".treasury-message.success").filter({ hasText: "Repayment recorded." })).not.toContainText("Realized FX");
      await expect(page.getByRole("region", { name: "Loans" }).getByRole("row", { name: /Synthetic AFN Lender Ltd/ })).toContainText(`${left} AFN`);
    }

    // Nothing is left anywhere: the loan, the Safe, their accounting values, and no FX account was ever touched.
    const balances = await ledgerBalances();
    expect(balances["1120"]).toBe("0.00");
    expect(balances["2520"]).toBe("0.00");
    expect(Object.keys(balances)).not.toContain("4910");
    expect(Object.keys(balances)).not.toContain("5910");
    const loans = await data<LoanWorkspace>(page, "/api/v1/finance/loans");
    const afnLoan = loans.loans?.find((item) => item.currency === "AFN");
    expect(afnLoan).toBeDefined();
    expectAmount(afnLoan?.outstanding, "0", "AFN still owed");
    expectAmount(afnLoan?.baseOutstanding, "0", "AFN loan carrying value");
    const afnStatement = await data<LoanStatementView>(page, `/api/v1/finance/loans/statement?loanId=${afnLoan?.id}&asOf=${today()}`);
    expectAmount(afnStatement.closing.native, "0", "AFN loan statement closing");
    expectAmount(afnStatement.closing.base, "0", "AFN loan statement carrying value");
    expect(afnStatement.lines.map((line) => [line.date, line.kind, plain(line.amount), plain(line.baseAmount)])).toEqual([
      ["2026-11-03", "RECEIPT", "700000", "10000"], ["2026-11-10", "REPAYMENT", "350000", "5000"], ["2026-11-17", "REPAYMENT", "350000", "5000"]]);
    const safes = await data<TreasuryStatementView>(page, "/api/v1/finance/safe-statement");
    const afnSafe = safes.accounts.find((account) => account.nameEn === AFN_SAFE);
    const afnSafeStatement = await data<TreasuryStatementView>(page, `/api/v1/finance/safe-statement?accountId=${afnSafe?.id}&asOf=${today()}`);
    expectAmount(afnSafeStatement.statement?.closing.native, "0", "AFN Safe balance");
    expectAmount(afnSafeStatement.statement?.closing.base, "0", "AFN Safe carrying value");
    expect(afnSafeStatement.statement?.carryingStatus).toBe("OK");
    expect(afnSafeStatement.statement?.reconciliation.matches).toBe(true);
    keep("afnLifecycle", { loan: afnLoan, loanStatement: afnStatement.lines, safeClosing: afnSafeStatement.statement?.closing, ledger: { "1120": balances["1120"], "2520": balances["2520"] } });
  });

  test("year end: every report agrees with the oracle and with each other", async ({ page }) => {
    test.setTimeout(300_000);
    await manager(page);
    const asOf = today();

    // The ledger first, read independently of every report: each posted line, by date.
    const posted = await readOnly<{ date: string; code: string; debit: string; credit: string }>(
      `SELECT to_char(j.accounting_effective_date, 'YYYY-MM-DD') AS date, la.account_code AS code, to_char(jl.base_debit, 'FM999999999990.00') AS debit,
              to_char(jl.base_credit, 'FM999999999990.00') AS credit
         FROM abos.journal_lines jl JOIN abos.journals j ON j.id = jl.journal_id JOIN abos.ledger_accounts la ON la.id = jl.ledger_account_id
        WHERE j.status = 'POSTED'`);
    const line = (date: string, code: string, debit: string, credit: string) => `${date} ${code} ${debit} ${credit}`;
    const EXPECTED_LINES = [
      line("2026-01-02", "1100", "100000.00", "0.00"), line("2026-01-02", "3100", "0.00", "100000.00"),
      line("2026-01-05", "1100", "50000.00", "0.00"), line("2026-01-05", "3100", "0.00", "50000.00"),
      line("2026-02-01", "5100", "12000.00", "0.00"), line("2026-02-01", "1100", "0.00", "12000.00"),
      line("2026-03-10", "1100", "80000.00", "0.00"), line("2026-03-10", "4100", "0.00", "80000.00"),
      line("2026-04-05", "1100", "20000.00", "0.00"), line("2026-04-05", "2510", "0.00", "20000.00"),
      line("2026-05-01", "5200", "18000.00", "0.00"), line("2026-05-01", "1100", "0.00", "18000.00"),
      line("2026-06-15", "1110", "40000.00", "0.00"), line("2026-06-15", "1100", "0.00", "40000.00"),
      line("2026-07-01", "5100", "3000.00", "0.00"), line("2026-07-01", "1100", "0.00", "3000.00"),
      // The reversal carries the original's date while its month is open (0050): the same amounts, the other way round.
      line("2026-07-01", "5100", "0.00", "3000.00"), line("2026-07-01", "1100", "3000.00", "0.00"),
      line("2026-08-20", "5300", "25000.00", "0.00"), line("2026-08-20", "1100", "0.00", "25000.00"),
      line("2026-09-15", "1100", "120000.00", "0.00"), line("2026-09-15", "4100", "0.00", "120000.00"),
      line("2026-10-01", "2510", "5000.00", "0.00"), line("2026-10-01", "1100", "0.00", "5000.00"),
      line("2026-10-20", "0012", "10000.00", "0.00"), line("2026-10-20", "1100", "0.00", "10000.00"),
      line("2026-11-03", "1120", "10000.00", "0.00"), line("2026-11-03", "2520", "0.00", "10000.00"),
      line("2026-11-10", "2520", "5000.00", "0.00"), line("2026-11-10", "1120", "0.00", "5000.00"),
      line("2026-11-17", "2520", "5000.00", "0.00"), line("2026-11-17", "1120", "0.00", "5000.00")
    ].sort();
    expect(posted.map((row) => line(row.date, row.code, row.debit, row.credit)).sort()).toEqual(EXPECTED_LINES);
    const reversal = await readOnly<{ originalStatus: string; reason: string; original: string; reversing: string }>(
      `SELECT o.status AS "originalStatus", l.reason, o.journal_reference AS original, r.journal_reference AS reversing
         FROM abos.journal_reversal_links l JOIN abos.journals o ON o.id = l.original_journal_id JOIN abos.journals r ON r.id = l.reversal_journal_id`);
    expect(reversal).toHaveLength(1);
    expect(reversal[0]).toMatchObject({ originalStatus: "POSTED", reason: "Entered by mistake on 1 July" });
    keep("reversal", reversal[0]);

    // Trial balance.
    const trial = await data<TrialBalanceView>(page, `/api/v1/finance/trial-balance?asOf=${asOf}`);
    expect(trial.balanced).toBe(true);
    expect(trial.unbalancedJournals).toBe(0);
    const ending = Object.fromEntries(trial.accounts.map((row) => [row.accountCode, `${plain(row.endingDebit)} Dr / ${plain(row.endingCredit)} Cr`]));
    expect(ending).toEqual({
      "0012": "10000 Dr / 0 Cr", "1100": "260000 Dr / 0 Cr", "1110": "40000 Dr / 0 Cr", "1120": "0 Dr / 0 Cr", "2510": "0 Dr / 15000 Cr", "2520": "0 Dr / 0 Cr",
      "3100": "0 Dr / 150000 Cr", "4100": "0 Dr / 200000 Cr", "5100": "12000 Dr / 0 Cr", "5200": "18000 Dr / 0 Cr", "5300": "25000 Dr / 0 Cr"
    });
    expectAmount(trial.totals.endingDebit, ORACLE.trialBalanceSide, "trial balance debit side");
    expectAmount(trial.totals.endingCredit, ORACLE.trialBalanceSide, "trial balance credit side");
    const accountId = (code: string) => trial.accounts.find((row) => row.accountCode === code)?.accountId ?? "";
    keep("trialBalance", { ending, totals: trial.totals, balanced: trial.balanced });

    // Income statement.
    const income = await data<IncomeStatementView>(page, `/api/v1/finance/income-statement?asOf=${asOf}`);
    expect(Object.fromEntries(income.income.map((row) => [row.code, plain(row.amount)]))).toEqual({ "4100": "200000" });
    expect(Object.fromEntries(income.expenses.map((row) => [row.code, plain(row.amount)]))).toEqual({ "0012": "10000", "5100": "12000", "5200": "18000", "5300": "25000" });
    expectAmount(income.totalIncome, ORACLE.revenue, "revenue");
    expectAmount(income.totalExpenses, ORACLE.expenses, "operating expenses");
    expectAmount(income.netResult, ORACLE.netProfit, "net profit");
    keep("incomeStatement", { income: income.income, expenses: income.expenses, totalIncome: income.totalIncome, totalExpenses: income.totalExpenses, netResult: income.netResult });

    // Balance sheet: the year's result is derived for presentation; no closing journal exists.
    const sheet = await data<BalanceSheetView>(page, `/api/v1/finance/balance-sheet?asOf=${asOf}`);
    expectAmount(sheet.totalAssets, ORACLE.assets, "total assets");
    expectAmount(sheet.totalLiabilities, ORACLE.liabilities, "total liabilities");
    expectAmount(sheet.equityAccounts, ORACLE.capital, "capital");
    expectAmount(sheet.currentYearResult, ORACLE.netProfit, "current-year result");
    expectAmount(sheet.totalEquity, ORACLE.equity, "total equity");
    expectAmount(sheet.totalLiabilitiesAndEquity, ORACLE.assets, "liabilities and equity");
    expectAmount(sheet.validation.difference, "0", "balance sheet difference");
    expect(sheet.validation.balanced).toBe(true);
    expect(sheet.treasury.matches).toBe(true);
    keep("balanceSheet", { totalAssets: sheet.totalAssets, totalLiabilities: sheet.totalLiabilities, equityAccounts: sheet.equityAccounts, currentYearResult: sheet.currentYearResult,
      totalEquity: sheet.totalEquity, validation: sheet.validation, treasury: sheet.treasury });

    // Financial summary: it must agree with the income statement, the Treasury and the ledger.
    const summary = await data<ManagementSummaryView>(page, `/api/v1/finance/financial-summary?asOf=${asOf}`);
    expectAmount(summary.profit.income, ORACLE.revenue, "summary income");
    expectAmount(summary.profit.expenses, ORACLE.expenses, "summary expenses");
    expectAmount(summary.profit.netResult, ORACLE.netProfit, "summary net result");
    expectAmount(summary.profit.realizedFxGain, "0", "no realized FX gain");
    expectAmount(summary.profit.realizedFxLoss, "0", "no realized FX loss");
    expect(summary.reconciliation.matches).toBe(true);
    expectAmount(summary.reconciliation.treasuryClosing, ORACLE.assets, "summary Treasury closing");
    expectAmount(summary.reconciliation.ledgerClosing, ORACLE.assets, "summary ledger closing");
    keep("financialSummary", { profit: summary.profit, base: summary.base, reconciliation: summary.reconciliation });

    // Shareholders: capital and loans are separate figures, for the company and for each person.
    const holders = await data<ShareholderStatementView>(page, `/api/v1/finance/shareholder-statement?asOf=${asOf}`);
    expect(holders.totals.capital?.map((row) => [row.currency, plain(row.effective)])).toEqual([["USD", "150000"]]);
    // Company loan totals are per currency: the AFN loan is fully repaid and shows as zero, never netted into USD.
    expect(holders.totals.loans?.map((row) => [row.currency, plain(row.outstanding)]).sort()).toEqual([["AFN", "0"], ["USD", "15000"]]);
    expect(holders.reconciliation.capital?.matches).toBe(true);
    expect(holders.reconciliation.loans?.matches).toBe(true);
    const party = (name: string) => holders.people.find((person) => person.name === name)?.partyId ?? "";
    const holderA = await data<ShareholderStatementView>(page, `/api/v1/finance/shareholder-statement?asOf=${asOf}&partyId=${party(HOLDER_A)}`);
    expect(holderA.statement?.capital?.map((row) => plain(row.effective))).toEqual(["100000"]);
    expect(holderA.statement?.loans?.map((row) => [plain(row.received), plain(row.repaid), plain(row.outstanding)])).toEqual([["20000", "5000", "15000"]]);
    expect(holderA.statement?.transactions.map((row) => [row.date, row.kind, row.section, plain(row.amount)])).toEqual([
      ["2026-01-02", "CAPITAL_RECEIVED", "CAPITAL", "100000"], ["2026-04-05", "LOAN_RECEIVED", "LOAN", "20000"], ["2026-10-01", "LOAN_REPAID", "LOAN", "5000"]]);
    const holderB = await data<ShareholderStatementView>(page, `/api/v1/finance/shareholder-statement?asOf=${asOf}&partyId=${party(HOLDER_B)}`);
    expect(holderB.statement?.capital?.map((row) => plain(row.effective))).toEqual(["50000"]);
    expect(holderB.statement?.loans ?? []).toEqual([]);
    keep("shareholders", { totals: holders.totals, a: { capital: holderA.statement?.capital, loans: holderA.statement?.loans }, b: { capital: holderB.statement?.capital, loans: holderB.statement?.loans } });

    // The loan register and the shareholder loan's statement.
    const loans = await data<LoanWorkspace>(page, "/api/v1/finance/loans");
    const usdLoan = loans.loans?.find((item) => item.currency === "USD");
    expectAmount(usdLoan?.principal, "20000", "shareholder loan principal");
    expectAmount(usdLoan?.repaid, "5000", "shareholder loan repaid");
    expectAmount(usdLoan?.outstanding, ORACLE.loanOutstanding, "shareholder loan still owed");
    const usdLoanStatement = await data<LoanStatementView>(page, `/api/v1/finance/loans/statement?loanId=${usdLoan?.id}&asOf=${asOf}`);
    expect(usdLoanStatement.lines.map((row) => [row.date, row.kind, plain(row.amount)])).toEqual([["2026-04-05", "RECEIPT", "20000"], ["2026-10-01", "REPAYMENT", "5000"]]);
    expectAmount(usdLoanStatement.closing.native, ORACLE.loanOutstanding, "loan statement closing");
    keep("loans", loans.loans?.map((item) => ({ lender: item.lender.name, currency: item.currency, principal: item.principal, repaid: item.repaid, outstanding: item.outstanding, baseOutstanding: item.baseOutstanding })));

    // Account statements: the opening plus every movement gives the closing, and the closing is the trial balance's figure.
    const closings: Record<string, string> = {};
    for (const [code, closing, lines] of [["1100", "260000", 13], ["1110", "40000", 1], ["1120", "0", 3], ["2510", "-15000", 2], ["2520", "0", 3], ["3100", "-150000", 2],
      ["4100", "-200000", 2], ["5100", "12000", 3], ["5200", "18000", 1], ["5300", "25000", 1], ["0012", "10000", 1]] as const) {
      const statement = await data<AccountStatementView>(page, `/api/v1/finance/account-statement?accountId=${accountId(code)}&asOf=${asOf}`);
      expect(statement.lines.length, `${code} lines`).toBe(lines);
      expectAmount(statement.opening.net, "0", `${code} opening`);
      expectAmount(statement.closing.net, closing, `${code} closing`);
      const movement = statement.lines.reduce((sum, row) => sum + cents(row.debit) - cents(row.credit), cents(statement.opening.net));
      expect(movement, `${code}: opening plus movements`).toBe(cents(statement.closing.net));
      expect(cents(statement.lines.at(-1)?.balance ?? "0"), `${code}: last running balance`).toBe(cents(statement.closing.net));
      closings[code] = statement.closing.net;
    }
    keep("accountStatementClosings", closings);

    // Safe statements: the transfer shows on both sides, as a transfer and never as company money in or out.
    const safes = await data<TreasuryStatementView>(page, "/api/v1/finance/safe-statement");
    const safeId = (name: string) => safes.accounts.find((account) => account.nameEn === name)?.id ?? "";
    const main = (await data<TreasuryStatementView>(page, `/api/v1/finance/safe-statement?accountId=${safeId(MAIN)}&asOf=${asOf}`)).statement;
    const reserve = (await data<TreasuryStatementView>(page, `/api/v1/finance/safe-statement?accountId=${safeId(RESERVE)}&asOf=${asOf}`)).statement;
    expectAmount(main?.closing.native, ORACLE.mainSafe, "Main Safe closing");
    expectAmount(reserve?.closing.native, ORACLE.reserveSafe, "Reserve Safe closing");
    expect(main?.reconciliation.matches).toBe(true);
    expect(reserve?.reconciliation.matches).toBe(true);
    expectAmount(main?.totals.transfersOut, "40000", "Main Safe transfers out");
    expectAmount(reserve?.totals.transfersIn, "40000", "Reserve Safe transfers in");
    expect(reserve?.lines.map((row) => [row.date, row.kind, plain(row.moneyIn)])).toEqual([["2026-06-15", "TRANSFER", "40000"]]);
    expect(main?.lines.length).toBe(13);
    keep("safes", { main: { closing: main?.closing, totals: main?.totals }, reserve: { closing: reserve?.closing, totals: reserve?.totals } });

    // General Ledger, as the screen pages it: the same lines the database holds.
    type Ledger = { lines: { accountingEffectiveDate: string; accountCode: string; baseDebit: string; baseCredit: string }[]; nextCursor: string | null;
      totals: { currency: string; debits: string; credits: string; lineCount: string }[] | null };
    const ledgerLines: string[] = [];
    let totals: Ledger["totals"] = null;
    for (let cursor: string | null = null, first = true; first || cursor !== null; first = false) {
      const ledgerPage: Ledger = await data<Ledger>(page, `/api/v1/finance/general-ledger?from=2026-01-01&to=${asOf}${cursor ? `&cursor=${cursor}` : ""}`);
      if (first) totals = ledgerPage.totals;
      ledgerLines.push(...ledgerPage.lines.map((row) => line(row.accountingEffectiveDate, row.accountCode, cents(row.baseDebit).toString(), cents(row.baseCredit).toString())));
      cursor = ledgerPage.nextCursor;
    }
    expect(ledgerLines.sort()).toEqual(posted.map((row) => line(row.date, row.code, cents(row.debit).toString(), cents(row.credit).toString())).sort());
    // The ledger's own totals: the sum of the 32 expected lines above (506,000.00 each side), added here from the oracle's lines, not from the report.
    const expectedSide = (column: 2 | 3) => EXPECTED_LINES.reduce((sum, item) => sum + cents(item.split(" ")[column] ?? "0"), BigInt(0));
    expect(expectedSide(2)).toBe(BigInt(50_600_000));
    expect(expectedSide(3)).toBe(BigInt(50_600_000));
    expect(totals?.map((row) => [row.currency, cents(row.debits), cents(row.credits), row.lineCount])).toEqual([["USD", expectedSide(2), expectedSide(3), String(EXPECTED_LINES.length)]]);
    keep("generalLedger", { lines: ledgerLines.length, totals });

    // The screens say the same, in words an operator reads.
    await open(page, "Balance sheet");
    const sheetRegion = page.getByRole("region", { name: "Balance sheet" });
    await expect(sheetRegion.getByRole("status")).toContainText("(balanced)");
    await expect(sheetRegion.getByRole("row", { name: /Total assets/ })).toContainText(money("300000"));
    await open(page, "Income statement");
    await expect(page.getByRole("region", { name: "Income statement" }).getByRole("row", { name: /Net profit/ })).toContainText(money("135000"));
    await open(page, "Trial balance");
    await expect(page.getByText("Balanced: total debits equal total credits (USD).")).toBeVisible();
    await expect(page.getByRole("region", { name: "Trial balance" }).getByRole("row", { name: /0012/ })).toContainText("10,000");
  });

  test("the year's reports export exactly what the screen shows, safely for a spreadsheet, in English and Dari, and print as Confidential", async ({ page }) => {
    test.setTimeout(300_000);
    await manager(page);
    const asOf = today();
    const company = (await data<{ legalEntityName: string }>(page, "/api/v1/auth/me")).legalEntityName;
    const auditsBefore = (await exportAudits()).length;
    const files: Record<string, string> = {};

    // Trial balance: the file is the screen's own payload through the formatter, byte for byte.
    const trial = await screenPayload<TrialBalanceView>(page, "/api/v1/finance/trial-balance?", () => open(page, "Trial balance"));
    await expect(page.getByText("Balanced: total debits equal total credits (USD).")).toBeVisible();
    const trialFile = await downloadCsv(page);
    expect(trialFile.text).toBe(reportCsv(trialBalanceTable(trial, "en"), "en", generatedAt(trialFile.text), company));
    expect(trialFile.name).toBe(`trial-balance_2026-01-01_${asOf}.csv`);
    expect([...trialFile.bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const trialDecoded = decodeReportCsv(trialFile.text);
    expect(trialDecoded.head[0]).toEqual(["Company", company]);
    expect(trialDecoded.head.at(-1)).toEqual(["Confidential / محرمانه"]);
    // Decoded, the rows are the payload's accounts in the payload's order, and the code that starts with zeros is still 0012.
    // (An account with activity in another currency has one more row under it for that currency, as on the screen.)
    expect(trialDecoded.rows.slice(0, -1).map((row) => row[0])).toEqual(trial.accounts.flatMap((row) => [row.accountCode, ...row.native.map(() => row.accountCode)]));
    expect(trialDecoded.rows.map((row) => row[0])).toContain("0012");
    expect(trialFile.text).toContain("\"=\"\"0012\"\"\",\"Utilities\"");
    const totalRow = trialDecoded.rows.at(-1) ?? [];
    expectAmount(totalRow[8], ORACLE.trialBalanceSide, "exported ending debit total");
    expectAmount(totalRow[9], ORACLE.trialBalanceSide, "exported ending credit total");
    expect(spreadsheetHazards(trialFile.text)).toEqual([]);
    files.trialBalance = trialFile.name;

    // With accounts that have no balance: the account whose name starts like a formula is in the file as text, at the start of its cell.
    await page.getByLabel("Include accounts with no balance").check();
    const withZero = await screenPayload<TrialBalanceView>(page, "/api/v1/finance/trial-balance?", () => page.getByRole("button", { name: "Show" }).click());
    await expect(page.getByRole("region", { name: "Trial balance" }).getByRole("row", { name: /9990/ })).toBeVisible();
    const zeroFile = await downloadCsv(page);
    expect(zeroFile.text).toBe(reportCsv(trialBalanceTable(withZero, "en"), "en", generatedAt(zeroFile.text), company));
    expect(decodeReportCsv(zeroFile.text).rows.find((row) => row[0] === "9990")?.[1]).toBe("'=1+1 formula check");
    expect(zeroFile.text).toContain("\"=\"\"9990\"\"\",\"'=1+1 formula check\"");
    expect(spreadsheetHazards(zeroFile.text)).toEqual([]);

    // Dari: the same payload and columns, Dari headings, still one byte-order mark. Printed, it is right to left and Confidential.
    await page.getByRole("button", { name: "Switch to Dari" }).click();
    const trialDari = await downloadCsv(page, "CSV (سازگار با Excel)");
    expect(trialDari.text).toBe(reportCsv(trialBalanceTable(withZero, "fa"), "fa", generatedAt(trialDari.text), company));
    expect(decodeReportCsv(trialDari.text).headings[0]).toBe("کد");
    for (const [path, title] of [["/finance/trial-balance", "بیلانس آزمایشی"], ["/finance/income-statement", "صورت عاید و مصرف"], ["/finance/balance-sheet", "بیلانس"]] as const) {
      await page.goto(path);
      await page.emulateMedia({ media: "print" });
      const printed = page.getByTestId("report-print-header");
      await expect(printed, path).toBeVisible();
      await expect(printed).toHaveAttribute("dir", "rtl");
      await expect(printed.getByRole("heading", { name: title })).toBeVisible();
      await expect(printed).toContainText("Confidential / محرمانه");
      await expect(printed).toContainText(company);
      await expect(page.locator(".print-confidential")).toBeVisible();
      await expect(page.locator(".sidebar")).toBeHidden();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `${path} printed width`).toBeLessThanOrEqual(1);
      await page.emulateMedia({ media: "screen" });
    }
    await page.getByRole("button", { name: "Switch to English" }).click();

    // Account statements: the Main Safe's ledger account, the liability with a negative balance, and the account whose code starts with zeros.
    const accountId = (code: string) => trial.accounts.find((row) => row.accountCode === code)?.accountId ?? "";
    for (const code of ["1100", "2510", "0012"]) {
      const view = await screenPayload<AccountStatementView>(page, "/api/v1/finance/account-statement?",
        () => page.goto(`/finance/account-statement?accountId=${accountId(code)}&asOf=${asOf}`));
      await expect(page.getByRole("region", { name: "Account statement" })).toBeVisible();
      const file = await downloadCsv(page);
      expect(file.text, code).toBe(reportCsv(accountStatementTable(view, "en"), "en", generatedAt(file.text), company));
      expect(file.name).toBe(`account-statement_2026-01-01_${asOf}.csv`);
      const decoded = decodeReportCsv(file.text);
      expect(decoded.rows.length, `${code}: opening, every line, closing, total`).toBe(view.lines.length + 3);
      expect(decoded.rows.slice(1, -2).map((row) => [row[0], row[4], row[5], row[6]]), `${code}: dates and amounts in order`)
        .toEqual(view.lines.map((row) => [row.date, row.debit, row.credit, row.balance]));
      expect(spreadsheetHazards(file.text), code).toEqual([]);
      if (code === "2510") {
        // A liability's closing is a negative number: written as a bare number, never as text.
        const closing = decoded.cells.find((row) => row[1]?.text === "Closing");
        expect(closing?.[6]).toEqual({ text: view.closing.net, quoted: false });
        expect(view.closing.net.startsWith("-")).toBe(true);
      }
      if (code === "0012") {
        // In Dari the same statement names the expense type in Dari, and the code is still text.
        const dari = await exportGet(page, `report=account-statement&format=csv&lang=fa&asOf=${asOf}&accountId=${accountId(code)}`);
        expect(dari.status).toBe(200);
        expect(dari.text).toContain(`SIM-UTIL-1020 — ${UTILITIES_FA}`);
        expect(decodeReportCsv(dari.text).head[2]).toEqual(["حساب", "0012 · Utilities"]);
        expect(spreadsheetHazards(dari.text)).toEqual([]);
      }
    }

    // The two USD Safes. The file names the Safe inside; its name never reaches the file name.
    const safes = await data<TreasuryStatementView>(page, "/api/v1/finance/safe-statement");
    const safeId = (name: string) => safes.accounts.find((account) => account.nameEn === name)?.id ?? "";
    for (const name of [MAIN, RESERVE]) {
      const view = await screenPayload<TreasuryStatementView>(page, "/api/v1/finance/safe-statement?accountId=",
        () => page.goto(`/finance/safe-statement?accountId=${safeId(name)}&asOf=${asOf}`));
      await expect(page.getByRole("region", { name: "Statement" }).getByRole("status")).toContainText("Agrees with the General Ledger.");
      const file = await downloadCsv(page);
      const table = safeStatementTable(view, "en");
      expect(table).not.toBeNull();
      if (table !== null) expect(file.text, name).toBe(reportCsv(table, "en", generatedAt(file.text), company));
      expect(file.name).toBe(`safe-statement_2026-01-01_${asOf}.csv`);
      const decoded = decodeReportCsv(file.text);
      expect(decoded.head[2]).toEqual(["Account", name]);
      expect(decoded.rows.length).toBe((view.statement?.lines.length ?? 0) + 2);
      expect(spreadsheetHazards(file.text), name).toEqual([]);
      if (name === MAIN) {
        // The formula-like text a person typed during the year is in this file intact. Each piece sits inside a longer text cell
        // ("Expense · reference · description"), so it can never start a formula; spreadsheetHazards above checked every cell.
        const cells = decoded.cells.flat().filter((cell) => cell.quoted).map((cell) => cell.text);
        for (const typed of ["=1+1 entered by mistake", "@Synthetic Vendor Ltd", "+SALE B-204", "-TRANSFER 0615"]) {
          expect(cells.some((cell) => cell.includes(typed) && !cell.startsWith(typed)), `${typed} is inside a text cell`).toBe(true);
        }
        // The Dari purpose a person typed for the utilities expense is in the file, intact.
        expect(file.text).toContain("برق و آب (electricity and water)");
      }
      files[name] = file.name;
    }
    // In Dari the Reserve Safe carries its Dari name inside the file.
    const reserveDari = await exportGet(page, `report=safe-statement&format=csv&lang=fa&accountId=${safeId(RESERVE)}&asOf=${asOf}`);
    expect(reserveDari.status).toBe(200);
    expect(decodeReportCsv(reserveDari.text).head[2]).toEqual(["حساب", RESERVE_FA]);
    expect(reserveDari.disposition).toBe(`attachment; filename="safe-statement_2026-01-01_${asOf}.csv"`);
    expect(reserveDari.cache).toBe("no-store");

    // The full-year General Ledger.
    type LedgerPage = { from: string; to: string; hasMore: boolean; lines: ExportLedgerLine[]; totals: ExportLedgerTotal[] | null };
    const ledger = await screenPayload<LedgerPage>(page, "/api/v1/finance/general-ledger?", () => open(page, "General Ledger"));
    expect(ledger.hasMore).toBe(false);
    const ledgerFile = await downloadCsv(page);
    expect(ledgerFile.text).toBe(reportCsv(generalLedgerTable(ledger, ledger.lines, ledger.totals ?? [], "en"), "en", generatedAt(ledgerFile.text), company));
    expect(decodeReportCsv(ledgerFile.text).rows.length).toBe(ledger.lines.length + (ledger.totals?.length ?? 0));
    expect(spreadsheetHazards(ledgerFile.text)).toEqual([]);
    files.generalLedger = ledgerFile.name;

    // Refusals carry no file and record nothing: an unknown account, a report that has no export, and a format that does not exist.
    const beforeRefusals = (await exportAudits()).length;
    const unknown = await exportGet(page, `report=account-statement&format=csv&lang=en&asOf=${asOf}&accountId=${randomUUID()}`);
    expect(unknown.status).toBe(404);
    expect(unknown.disposition).toBeNull();
    expect((await exportGet(page, `report=balance-sheet&format=csv&lang=en&asOf=${asOf}`)).status).toBe(422);
    expect((await exportGet(page, `report=trial-balance&format=xlsx&lang=en&asOf=${asOf}`)).status).toBe(422);
    expect((await exportAudits()).length).toBe(beforeRefusals);

    // The audit: exactly one event per file (eleven files), each holding metadata only.
    const recorded = (await exportAudits()).slice(auditsBefore);
    expect(recorded.map((row) => row.after.kind)).toEqual(["TRIAL_BALANCE", "TRIAL_BALANCE", "TRIAL_BALANCE", "ACCOUNT_STATEMENT", "ACCOUNT_STATEMENT", "ACCOUNT_STATEMENT",
      "ACCOUNT_STATEMENT", "SAFE_STATEMENT", "SAFE_STATEMENT", "SAFE_STATEMENT", "GENERAL_LEDGER"]);
    for (const row of recorded) {
      expect(Object.keys(row.after).every((key) => ["kind", "format", "language", "mode", "from", "to", "periodId", "fiscalYearId", "accountId", "includeZero", "rowCount"]
        .includes(key))).toBe(true);
      const text = JSON.stringify(row);
      for (const word of [...PRIVATE_DETAIL, MAIN, RESERVE, RESERVE_FA, "Utilities", "260000.00", "300000.00", "135000"]) expect(text, `audit must not hold ${word}`).not.toContain(word);
    }
    keep("exports", { files, auditEvents: recorded.map((row) => row.after) });
  });

  test("a report-only reader sees the same figures and none of the private detail, on screen, in raw responses and in exported files", async ({ page, browser }) => {
    test.setTimeout(300_000);
    await manager(page);
    const asOf = today();
    const full = {
      trial: await data<TrialBalanceView>(page, `/api/v1/finance/trial-balance?asOf=${asOf}`),
      income: await data<IncomeStatementView>(page, `/api/v1/finance/income-statement?asOf=${asOf}`),
      sheet: await data<BalanceSheetView>(page, `/api/v1/finance/balance-sheet?asOf=${asOf}`)
    };
    const cash = full.trial.accounts.find((row) => row.accountCode === "1100")?.accountId ?? "";
    const managerLedger = await raw(page, `/api/v1/finance/general-ledger?from=2026-01-01&to=${asOf}`);
    // The Finance Manager's own responses do carry the detail, so its absence below means it was withheld, not that it does not exist.
    expect(managerLedger.text).toContain(HOLDER_A);
    expect(managerLedger.text).toContain("SIM-EXP-0201");

    const reader = await (await browser.newContext()).newPage();
    await signInAs(reader, "sim.report.reader");
    // The same figures.
    const trial = await data<TrialBalanceView>(reader, `/api/v1/finance/trial-balance?asOf=${asOf}`);
    expect(trial.totals).toEqual(full.trial.totals);
    expect(trial.accounts.map((row) => [row.accountCode, row.endingDebit, row.endingCredit])).toEqual(full.trial.accounts.map((row) => [row.accountCode, row.endingDebit, row.endingCredit]));
    const income = await data<IncomeStatementView>(reader, `/api/v1/finance/income-statement?asOf=${asOf}`);
    expect([income.totalIncome, income.totalExpenses, income.netResult]).toEqual([full.income.totalIncome, full.income.totalExpenses, full.income.netResult]);
    const sheet = await data<BalanceSheetView>(reader, `/api/v1/finance/balance-sheet?asOf=${asOf}`);
    expect([sheet.totalAssets, sheet.totalLiabilities, sheet.totalEquity]).toEqual([full.sheet.totalAssets, full.sheet.totalLiabilities, full.sheet.totalEquity]);

    // None of the private detail, in any raw response this person can ask for. A refusal is fine; a leak is not.
    const seen: Record<string, number> = {};
    for (const path of [`/api/v1/finance/trial-balance?asOf=${asOf}`, `/api/v1/finance/income-statement?asOf=${asOf}`, `/api/v1/finance/balance-sheet?asOf=${asOf}`,
      `/api/v1/finance/general-ledger?from=2026-01-01&to=${asOf}`, `/api/v1/finance/account-statement?accountId=${cash}&asOf=${asOf}`,
      `/api/v1/finance/financial-summary?asOf=${asOf}`, `/api/v1/finance/shareholder-statement?asOf=${asOf}`, "/api/v1/finance/loans", "/api/v1/finance/safe-statement",
      "/api/v1/finance/journal-reversals", `/api/v1/finance/operations/expenses?from=2026-01-01&to=${asOf}`, "/api/v1/shareholders"]) {
      const answer = await raw(reader, path);
      seen[path.split("?")[0] ?? path] = answer.status;
      expect([200, 401, 403, 404], path).toContain(answer.status);
      for (const word of PRIVATE_DETAIL) expect(answer.text, `${path} must not carry ${word}`).not.toContain(word);
      expect(answer.text, `${path} must not link to a source record`).not.toMatch(/"route":"\/(shareholders|finance\/loans|finance\/transactions)/);
    }
    // The four reports this permission is for do answer.
    for (const path of ["/api/v1/finance/trial-balance", "/api/v1/finance/income-statement", "/api/v1/finance/balance-sheet", "/api/v1/finance/general-ledger",
      "/api/v1/finance/account-statement"]) expect(seen[path], path).toBe(200);

    // The reader's exports are the reader's masked screens: the General Ledger and the cash account's statement.
    const company = (await data<{ legalEntityName: string }>(reader, "/api/v1/auth/me")).legalEntityName;
    type LedgerPage = { from: string; to: string; hasMore: boolean; lines: ExportLedgerLine[]; totals: ExportLedgerTotal[] | null };
    const ledger = await screenPayload<LedgerPage>(reader, "/api/v1/finance/general-ledger?", () => reader.goto("/finance/general-ledger"));
    const ledgerFile = await downloadCsv(reader);
    expect(ledgerFile.text).toBe(reportCsv(generalLedgerTable(ledger, ledger.lines, ledger.totals ?? [], "en"), "en", generatedAt(ledgerFile.text), company));
    const statement = await screenPayload<AccountStatementView>(reader, "/api/v1/finance/account-statement?", () => reader.goto(`/finance/account-statement?accountId=${cash}&asOf=${asOf}`));
    const statementFile = await downloadCsv(reader);
    expect(statementFile.text).toBe(reportCsv(accountStatementTable(statement, "en"), "en", generatedAt(statementFile.text), company));
    for (const file of [ledgerFile, statementFile]) {
      for (const word of PRIVATE_DETAIL) expect(file.text, `the reader's ${file.name} must not carry ${word}`).not.toContain(word);
      expect(spreadsheetHazards(file.text)).toEqual([]);
    }
    // Every line and every amount is still there: only the detail is withheld.
    expect(statement.lines.map((row) => [row.date, row.debit, row.credit, row.balance])).toHaveLength(13);
    expectAmount(statement.closing.net, ORACLE.mainSafe, "the reader's cash closing");
    // The reader cannot export a Safe statement, and is told nothing about whether a Safe exists.
    const safes = await data<TreasuryStatementView>(page, "/api/v1/finance/safe-statement");
    const mainId = safes.accounts.find((account) => account.nameEn === MAIN)?.id ?? "";
    keep("reportOnlyReader", { statuses: seen, ledgerLines: ledger.lines.length, safeExport: (await exportGet(reader, `report=safe-statement&format=csv&lang=en&asOf=${asOf}&accountId=${mainId}`)).status });
    await reader.context().close();
  });

  test("the person responsible for one Safe sees and exports exactly that Safe; another company's records and unknown ids are refused alike", async ({ page, browser }) => {
    test.setTimeout(300_000);
    await manager(page);
    const asOf = today();
    const safes = await data<TreasuryStatementView>(page, "/api/v1/finance/safe-statement");
    const safeId = (name: string) => safes.accounts.find((account) => account.nameEn === name)?.id ?? "";
    const trial = await data<TrialBalanceView>(page, `/api/v1/finance/trial-balance?asOf=${asOf}`);
    const cash = trial.accounts.find((row) => row.accountCode === "1100")?.accountId ?? "";

    // The responsibility is given on the Safes screen, the way an operator gives it.
    await open(page, "Safes");
    const responsibles = safeCard(page, RESERVE).locator(".safe-responsibles");
    await responsibles.getByRole("button", { name: "Change" }).click();
    await responsibles.locator("label", { hasText: "Synthetic sim.safe.keeper" }).locator("input").check();
    await responsibles.getByRole("button", { name: "Save" }).click();
    await expect(page.locator(".treasury-message.success")).toContainText("Responsible people saved.");
    act("safe responsibility", 4);

    const keeper = await (await browser.newContext()).newPage();
    await signInAs(keeper, "sim.safe.keeper");
    await keeper.goto("/finance/safe-statement");
    await expect(keeper.getByLabel("Safe or Saraf").locator("option").filter({ hasText: RESERVE })).toHaveCount(1);
    await expect(keeper.getByLabel("Safe or Saraf").locator("option").filter({ hasText: MAIN })).toHaveCount(0);
    await expect(keeper.getByLabel("Safe or Saraf").locator("option").filter({ hasText: AFN_SAFE })).toHaveCount(0);
    const view = await screenPayload<TreasuryStatementView>(keeper, "/api/v1/finance/safe-statement?accountId=",
      () => keeper.getByLabel("Safe or Saraf").selectOption({ label: `${RESERVE} · USD` }));
    const company = (await data<{ legalEntityName: string }>(keeper, "/api/v1/auth/me")).legalEntityName;
    const file = await downloadCsv(keeper);
    const table = safeStatementTable(view, "en");
    expect(table).not.toBeNull();
    if (table !== null) expect(file.text).toBe(reportCsv(table, "en", generatedAt(file.text), company));
    const decoded = decodeReportCsv(file.text);
    expect(decoded.rows.length).toBe((view.statement?.lines.length ?? 0) + 2);
    expectAmount(view.statement?.closing.native, ORACLE.reserveSafe, "the keeper's Reserve Safe closing");
    expect(file.name).toBe(`safe-statement_2026-01-01_${asOf}.csv`);

    // Nothing broader. Another Safe of the same company and an id that names nothing get the same answer, byte for byte.
    const other = await exportGet(keeper, `report=safe-statement&format=csv&lang=en&asOf=${asOf}&accountId=${safeId(MAIN)}`);
    const nothing = await exportGet(keeper, `report=safe-statement&format=csv&lang=en&asOf=${asOf}&accountId=${randomUUID()}`);
    expect([403, 404]).toContain(other.status);
    expect(nothing.status).toBe(other.status);
    expect(nothing.text).toBe(other.text);
    expect(other.disposition).toBeNull();
    const otherScreen = await raw(keeper, `/api/v1/finance/safe-statement?accountId=${safeId(MAIN)}&asOf=${asOf}`);
    const nothingScreen = await raw(keeper, `/api/v1/finance/safe-statement?accountId=${randomUUID()}&asOf=${asOf}`);
    expect(nothingScreen.status).toBe(otherScreen.status);
    expect(nothingScreen.text).toBe(otherScreen.text);
    for (const query of [`report=trial-balance&format=csv&lang=en&asOf=${asOf}`, `report=general-ledger&format=csv&lang=en&from=2026-01-01&to=${asOf}`,
      `report=account-statement&format=csv&lang=en&asOf=${asOf}&accountId=${cash}`]) {
      const refused = await exportGet(keeper, query);
      expect([403, 404], query).toContain(refused.status);
      expect(refused.disposition, query).toBeNull();
    }
    const keeperAudit = (await exportAudits()).at(-1);
    expect(keeperAudit?.after).toMatchObject({ kind: "SAFE_STATEMENT", accountId: safeId(RESERVE), rowCount: view.statement?.lines.length });
    await keeper.context().close();

    // A second company. A single-company installation has no screen that creates one, so its three rows are test setup, not business data.
    const foreign = { entity: randomUUID(), ledger: randomUUID(), safe: randomUUID() };
    await setupOnly(`INSERT INTO abos.legal_entities (id, company_id, code, name, base_currency_code, currency_policy_status)
      SELECT $1, company_id, 'SIM-OTHER', 'Synthetic Other Company', 'USD', 'APPROVED' FROM abos.legal_entities LIMIT 1`, [foreign.entity]);
    await setupOnly(`INSERT INTO abos.ledger_accounts (id, legal_entity_id, account_code, account_name, account_type, control_account_type, posting_allowed, account_currency_code, status)
      VALUES ($1, $2, '1100', 'Synthetic Other Cash', 'ASSET', 'CASH', true, 'USD', 'ACTIVE')`, [foreign.ledger, foreign.entity]);
    await setupOnly(`INSERT INTO abos.operational_treasury_accounts (id, legal_entity_id, name_en, account_type, currency_code, ledger_account_id, status, version,
        created_by_user_account_id, last_changed_by_user_account_id)
      SELECT $1, $2, 'Synthetic Other Safe', 'SAFE', 'USD', $3, 'ACTIVE', 1, id, id FROM abos.user_accounts ORDER BY created_at LIMIT 1`, [foreign.safe, foreign.entity, foreign.ledger]);
    const pairs: [string, string, string][] = [
      ["account statement", `/api/v1/finance/account-statement?asOf=${asOf}&accountId=${foreign.ledger}`, `/api/v1/finance/account-statement?asOf=${asOf}&accountId=${randomUUID()}`],
      ["Safe statement", `/api/v1/finance/safe-statement?asOf=${asOf}&accountId=${foreign.safe}`, `/api/v1/finance/safe-statement?asOf=${asOf}&accountId=${randomUUID()}`],
      ["General Ledger", `/api/v1/finance/general-ledger?from=2026-01-01&to=${asOf}&accountId=${foreign.ledger}`, `/api/v1/finance/general-ledger?from=2026-01-01&to=${asOf}&accountId=${randomUUID()}`],
      ["account statement export", `/api/v1/finance/report-export?report=account-statement&format=csv&lang=en&asOf=${asOf}&accountId=${foreign.ledger}`,
        `/api/v1/finance/report-export?report=account-statement&format=csv&lang=en&asOf=${asOf}&accountId=${randomUUID()}`],
      ["Safe statement export", `/api/v1/finance/report-export?report=safe-statement&format=csv&lang=en&asOf=${asOf}&accountId=${foreign.safe}`,
        `/api/v1/finance/report-export?report=safe-statement&format=csv&lang=en&asOf=${asOf}&accountId=${randomUUID()}`],
      ["loan documents", `/api/v1/documents?subjectType=LOAN&subjectId=${foreign.safe}`, `/api/v1/documents?subjectType=LOAN&subjectId=${randomUUID()}`],
      ["loan statement", `/api/v1/finance/loans/statement?asOf=${asOf}&loanId=${foreign.safe}`, `/api/v1/finance/loans/statement?asOf=${asOf}&loanId=${randomUUID()}`]
    ];
    const isolation: Record<string, number> = {};
    for (const [what, theirs, unknownPath] of pairs) {
      const answer = await raw(page, theirs);
      const unknown = await raw(page, unknownPath);
      expect([403, 404, 422], `${what} of another company`).toContain(answer.status);
      expect(answer.status, `${what}: another company's id and an unknown id are refused alike`).toBe(unknown.status);
      expect(answer.text, what).toBe(unknown.text);
      expect(answer.text, what).not.toContain("Synthetic Other");
      isolation[what] = answer.status;
    }
    // And the other company's rows appear in none of this company's reports.
    for (const path of [`/api/v1/finance/trial-balance?asOf=${asOf}`, "/api/v1/finance/safe-statement", `/api/v1/finance/general-ledger?from=2026-01-01&to=${asOf}`]) {
      expect((await raw(page, path)).text, path).not.toContain("Synthetic Other");
    }
    keep("isolation", isolation);
  });

  test("documents attach to a shareholder, a loan, an expense, a receipt and the company; each is scanned, served only to those who may read its record, and touches no accounting", async ({ page, browser }) => {
    test.skip(!SCANNER, "Needs the real scanner: set ABOS_MALWARE_SCANNER=windows-defender.");
    test.setTimeout(420_000);
    await manager(page);
    const asOf = today();
    const journalsBefore = await journalCount();
    const attach = async (target: Page, title: string, date: string) => {
      const panel = target.getByRole("region", { name: "Documents" });
      const form = panel.getByRole("form", { name: "Attach a document" });
      await form.getByLabel("Title").fill(title);
      await form.getByLabel(/^Document date/).fill(date);
      await form.getByLabel(/^PDF or image file/).setInputFiles({ name: `${title}.pdf`, mimeType: "application/pdf", buffer: PDF });
      await form.getByRole("button", { name: "Attach document" }).click();
      await expect(form.getByRole("status")).toContainText("Document attached.");
      await expect(panel.getByRole("listitem").filter({ hasText: title })).toBeVisible();
      act("document", 4);
    };

    // The shareholder's own record.
    await open(page, "Shareholders");
    await page.getByRole("button", { name: new RegExp(HOLDER_A) }).click();
    await expect(page.getByRole("article", { name: HOLDER_A })).toBeVisible();
    await attach(page, "Synthetic identity paper", "2026-01-02");
    // The loan.
    await open(page, "Loans");
    await page.getByRole("region", { name: "Loans" }).getByRole("link", { name: HOLDER_A }).click();
    await attach(page, "Synthetic loan note", "2026-04-05");
    // The expense, from the daily register.
    await open(page, "Daily transactions");
    await page.getByRole("form", { name: "Date range" }).getByLabel("From").fill("2026-01-01");
    const expenseRow = page.locator(".register-table tbody tr").filter({ hasText: "SIM-EXP-0201" });
    await expenseRow.getByRole("button", { name: "Documents" }).click();
    await attach(page, "Synthetic supplier invoice", "2026-02-01");
    // The receipt, from its journal.
    const trial = await data<TrialBalanceView>(page, `/api/v1/finance/trial-balance?asOf=${asOf}`);
    const revenue = trial.accounts.find((row) => row.accountCode === "4100")?.accountId ?? "";
    await page.goto(`/finance/account-statement?accountId=${revenue}&asOf=${asOf}`);
    await page.getByRole("region", { name: "Account statement" }).locator("tbody tr").first().getByRole("link").first().click();
    await expect(page.getByRole("region", { name: "Journal", exact: true })).toBeVisible();
    await attach(page, "Synthetic sale receipt A-101", "2026-03-10");
    // The company, by the person who keeps its records.
    const records = await (await browser.newContext()).newPage();
    await signInAs(records, "sim.company.records");
    await records.goto("/admin/company");
    await attach(records, "Synthetic registration certificate", "2026-01-01");

    // Five documents, five subjects, every one scanned clean by the real scanner; attaching posted nothing.
    const stored = await readOnly<{ link: string; subject: string; title: string; storage: string; outcome: string | null }>(
      `SELECT l.id::text AS link, l.subject_type AS subject, l.title, d.storage_id::text AS storage,
              (SELECT r.outcome FROM abos.document_scan_results r WHERE r.document_id = d.id ORDER BY r.scanned_at DESC LIMIT 1) AS outcome
         FROM abos.document_links l JOIN abos.documents d ON d.id = l.document_id ORDER BY l.subject_type`);
    expect(stored.map((row) => [row.subject, row.outcome])).toEqual([["COMPANY", "CLEAN"], ["EXPENSE", "CLEAN"], ["LOAN", "CLEAN"], ["RECEIPT", "CLEAN"], ["SHAREHOLDER", "CLEAN"]]);
    expect(await journalCount()).toBe(journalsBefore);
    expect(await readOnly("SELECT * FROM abos.document_vault_integrity()")).toEqual([]);
    const attached = await readOnly<{ n: number }>("SELECT count(*)::int AS n FROM abos.audit_records WHERE action = 'DOCUMENT_ATTACHED'");
    expect(attached[0]?.n).toBe(5);

    // Opening: the person who may read the record gets the file; the list never names where it is stored.
    const link = (subject: string) => stored.find((row) => row.subject === subject);
    const loanFile = await raw(page, `/api/v1/documents/${link("LOAN")?.link}`);
    expect(loanFile.status).toBe(200);
    expect(loanFile.text.startsWith("%PDF-1.4")).toBe(true);
    const loans = await data<LoanWorkspace>(page, "/api/v1/finance/loans");
    const usdLoan = loans.loans?.find((item) => item.currency === "USD");
    const list = await raw(page, `/api/v1/documents?subjectType=LOAN&subjectId=${usdLoan?.id}`);
    expect(list.status).toBe(200);
    for (const row of stored) expect(list.text, "no storage object is named").not.toContain(row.storage);
    expect(list.text).not.toMatch(/storageId|[A-Za-z]:\\\\|private-documents|documents-preview/);
    // The Finance Manager does not manage company details, so the company's document is not theirs to open.
    const unknown = await raw(page, `/api/v1/documents/${randomUUID()}`);
    const companyFile = await raw(page, `/api/v1/documents/${link("COMPANY")?.link}`);
    expect(unknown.status).toBe(404);
    expect(companyFile.status).toBe(404);
    expect(companyFile.text).toBe(unknown.text);
    // The report-only reader and the Safe's keeper can open none of them: each is refused exactly as an address that names nothing.
    const access: Record<string, number[]> = {};
    for (const login of ["sim.report.reader", "sim.safe.keeper"]) {
      const person = await (await browser.newContext()).newPage();
      await signInAs(person, login);
      const nothing = await raw(person, `/api/v1/documents/${randomUUID()}`);
      access[login] = [];
      for (const row of stored) {
        const answer = await raw(person, `/api/v1/documents/${row.link}`);
        access[login]?.push(answer.status);
        expect(answer.status, `${login} and the ${row.subject} document`).toBe(404);
        expect(answer.text).toBe(nothing.text);
      }
      await person.context().close();
    }
    // The records keeper opens the company's document and none of Finance's.
    expect((await raw(records, `/api/v1/documents/${link("COMPANY")?.link}`)).status).toBe(200);
    expect((await raw(records, `/api/v1/documents/${link("LOAN")?.link}`)).status).toBe(404);
    await records.context().close();
    // Nothing can replace or remove an attached document: the runtime has no such route, and the tables refuse it.
    expect((await page.evaluate(async (url) => (await fetch(url, { method: "DELETE" })).status, `/api/v1/documents/${link("LOAN")?.link}`))).toBe(405);
    keep("documents", { attached: stored.map((row) => [row.subject, row.title, row.outcome]), refusedFor: access });
  });

  test("a separate FX test on its own AFN Safe: a mixed carrying basis realizes one gain and two losses, exactly as worked out by hand, and nets to nothing", async ({ page }) => {
    test.setTimeout(420_000);
    await manager(page);
    const asOf = today();

    // A second AFN Safe, so the year's own AFN Safe stays untouched. Rates on file: 3 Nov 70, 10 Nov 65, 17 Nov 80 AFN to the dollar.
    await open(page, "Chart of Accounts");
    await createAccount(page, { code: "1130", name: "FX Test AFN Cash", type: "ASSET", control: "CASH", currency: "AFN" });
    await open(page, "Finance setup");
    await page.getByRole("button", { name: "Add account" }).click();
    const treasury = page.getByRole("form", { name: "Treasury account" });
    await treasury.getByLabel("Name (English) *").fill(FX_SAFE);
    await treasury.getByLabel("Type *").selectOption({ label: "Safe" });
    await treasury.getByLabel("Currency *").selectOption("AFN");
    await treasury.getByLabel("Chart of Accounts account *").selectOption({ label: "1130 · FX Test AFN Cash" });
    await treasury.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Treasury account saved" })).toBeVisible();

    // Two loans into the same Safe at different rates. Worked out by hand, before anything is posted:
    //   3 Nov, 140,000 AFN at 70 = 2,000.00 USD.   Safe: 140,000 AFN carrying 2,000.00.
    //  10 Nov,  65,000 AFN at 65 = 1,000.00 USD.   Safe: 205,000 AFN carrying 3,000.00.
    await open(page, "Add money");
    await page.getByRole("region", { name: "Where is this money coming from?" }).getByRole("button", { name: /Other loan/ }).click();
    const lend = async (lender: string, amount: string, day: string) => {
      const form = page.getByRole("form", { name: "Record loan" });
      await form.getByLabel("Who lent the money?").selectOption({ label: "A company" });
      await form.getByRole("textbox", { name: "Name" }).fill(lender);
      await form.getByLabel("Which Safe did it go into?").selectOption({ label: `${FX_SAFE} · AFN` });
      await form.getByLabel("Amount (AFN)").fill(amount);
      await form.getByLabel("Date").fill(day);
      await form.getByRole("button", { name: "Record loan" }).click();
      await expect(page.getByText("Loan recorded.")).toBeVisible();
    };
    await lend("Synthetic FX Lender One", "140000", "2026-11-03");
    // The second loan is recorded from the same page, straight after the first.
    await page.getByRole("button", { name: "Record another loan" }).click();
    await lend("Synthetic FX Lender Two", "65000", "2026-11-10");
    expect(await ledgerBalances()).toMatchObject({ "1130": "3000.00", "2520": "-3000.00" });

    // Three repayments on 17 November, each expected result worked out by hand from the two carrying values:
    //  a) Lender One, 70,000 AFN. The Safe gives up 3,000.00 x 70,000 / 205,000 = 1,024.39. The loan drops by 2,000.00 x 70,000 / 140,000 = 1,000.00.
    //     More was given up than was owed: a loss of 24.39.           Safe: 135,000 AFN carrying 1,975.61.
    //  b) Lender Two, 65,000 AFN (all of it). The Safe gives up 1,975.61 x 65,000 / 135,000 = 951.22. The loan drops by 1,000.00.
    //     Less was given up than was owed: a gain of 48.78.            Safe: 70,000 AFN carrying 1,024.39.
    //  c) Lender One, the last 70,000 AFN. The Safe gives up all it carries, 1,024.39. The loan drops by its last 1,000.00: a loss of 24.39.
    //  Everything borrowed was repaid in the same currency, so the gains and losses must cancel: 48.78 - 24.39 - 24.39 = 0.00.
    const repay = async (lender: string, amount: string, result: RegExp) => {
      await open(page, "Loans");
      await page.getByRole("region", { name: "Loans" }).getByRole("link", { name: lender }).click();
      await page.getByRole("button", { name: "Repay" }).click();
      const form = page.getByRole("form", { name: "Repay loan" });
      await form.getByLabel("From which Safe?").selectOption({ label: FX_SAFE });
      await form.getByLabel("Amount (AFN)").fill(amount);
      await form.getByLabel("Date").fill("2026-11-17");
      await form.getByRole("button", { name: "Record repayment" }).click();
      await expect(page.locator(".treasury-message.success").filter({ hasText: "Repayment recorded." })).toContainText(result);
    };
    await repay("Synthetic FX Lender One", "70000", /Realized FX loss: 24\.39 USD\./);
    expect(await ledgerBalances()).toMatchObject({ "1130": "1975.61", "2520": "-2000.00", "5910": "24.39" });
    await repay("Synthetic FX Lender Two", "65000", /Realized FX gain: 48\.78 USD\./);
    expect(await ledgerBalances()).toMatchObject({ "1130": "1024.39", "2520": "-1000.00", "4910": "-48.78", "5910": "24.39" });
    await repay("Synthetic FX Lender One", "70000", /Realized FX loss: 24\.39 USD\./);

    // Nothing is left in the Safe or owed on either loan, in AFN or in accounting value, and the FX accounts cancel to the cent.
    const balances = await ledgerBalances();
    expect(balances).toMatchObject({ "1130": "0.00", "2520": "0.00", "4910": "-48.78", "5910": "48.78" });
    const loans = await data<LoanWorkspace>(page, "/api/v1/finance/loans");
    for (const lender of ["Synthetic FX Lender One", "Synthetic FX Lender Two"]) {
      const loan = loans.loans?.find((item) => item.lender.name === lender);
      expectAmount(loan?.outstanding, "0", `${lender} still owed`);
      expectAmount(loan?.baseOutstanding, "0", `${lender} carrying value`);
    }
    const safes = await data<TreasuryStatementView>(page, "/api/v1/finance/safe-statement");
    const fxSafe = (await data<TreasuryStatementView>(page, `/api/v1/finance/safe-statement?accountId=${safes.accounts.find((account) => account.nameEn === FX_SAFE)?.id}&asOf=${asOf}`)).statement;
    expectAmount(fxSafe?.closing.native, "0", "FX test Safe balance");
    expectAmount(fxSafe?.closing.base, "0", "FX test Safe carrying value");
    expect(fxSafe?.carryingStatus).toBe("OK");
    expect(fxSafe?.reconciliation.matches).toBe(true);

    // The statements show the FX on its own lines, and the year's result and position are exactly what they were.
    const income = await data<IncomeStatementView>(page, `/api/v1/finance/income-statement?asOf=${asOf}`);
    expectAmount(income.income.find((row) => row.code === "4910")?.amount, "48.78", "Realized FX Gain on the income statement");
    expectAmount(income.expenses.find((row) => row.code === "5910")?.amount, "48.78", "Realized FX Loss on the income statement");
    expectAmount(income.netResult, ORACLE.netProfit, "net profit after the FX test");
    const summary = await data<ManagementSummaryView>(page, `/api/v1/finance/financial-summary?asOf=${asOf}`);
    expectAmount(summary.profit.income, ORACLE.revenue, "summary income leaves realized FX out");
    expectAmount(summary.profit.expenses, ORACLE.expenses, "summary expenses leave realized FX out");
    expectAmount(summary.profit.realizedFxGain, "48.78", "summary realized FX gain");
    expectAmount(summary.profit.realizedFxLoss, "48.78", "summary realized FX loss");
    expectAmount(summary.profit.netResult, ORACLE.netProfit, "summary net result after the FX test");
    const sheet = await data<BalanceSheetView>(page, `/api/v1/finance/balance-sheet?asOf=${asOf}`);
    expectAmount(sheet.totalAssets, ORACLE.assets, "total assets after the FX test");
    expectAmount(sheet.totalLiabilities, ORACLE.liabilities, "total liabilities after the FX test");
    expectAmount(sheet.totalEquity, ORACLE.equity, "total equity after the FX test");
    expect(sheet.validation.balanced).toBe(true);
    const trial = await data<TrialBalanceView>(page, `/api/v1/finance/trial-balance?asOf=${asOf}`);
    expect(trial.balanced).toBe(true);
    keep("fxTest", { ledger: { "1130": balances["1130"], "2520": balances["2520"], "4910": balances["4910"], "5910": balances["5910"] },
      incomeStatementNet: income.netResult, summaryProfit: summary.profit, safeClosing: fxSafe?.closing });
    keep("actionsPerWorkflow", actions);
  });
});
