# V1 annual simulation 2026

**What it is:** one synthetic company taken from an empty installation through a financial year, entered through the product's own screens on a disposable database, and then checked against an accounting oracle written by hand before any report was read. It is a permanent test: `apps/web/tests/v1-annual-simulation.spec.ts`.

**What it is for:** unit and integration tests prove functions. This proves that a company can actually run on the product: start from zero, enter a year of ordinary business, and get final statements that agree with each other and with independent arithmetic.

**First full pass:** 2026-11-18, on a production build (`next build`, `next start`) against a disposable PostgreSQL database. Nine tests, all passed.

## How to run it

```bash
ABOS_V1_PREVIEW_E2E=1 pnpm exec playwright test v1-annual-simulation --workers=1
```

It needs the disposable preview database and its environment, the same as the other database-backed browser tests. It resets that database and refuses any database whose name does not mark it as disposable. The documents test also needs the real malware scanner (`ABOS_MALWARE_SCANNER=windows-defender`) and skips itself without it. Set `ABOS_SIM_RECORD_DIR` to keep a JSON record of what each report returned.

Rules it follows:

- Every business event goes through a screen an operator uses. SQL only reads.
- The oracle is written in the test file as constants. None of it is taken from the application.
- One exception to "no SQL setup": a second legal entity (three rows), because a single-company installation has no screen that creates one. It goes through `setupOnly`, which exists for exactly that.

## The scenario

All amounts are USD, the accounting currency, except the November AFN loan.

| Date | Event | Amount | Screen used |
| --- | --- | --- | --- |
| 2 Jan | Shareholder A puts in capital | 100,000.00 | Getting started, first money |
| 5 Jan | Shareholder B puts in capital | 50,000.00 | Shareholders, Add shareholder |
| 1 Feb | Office and setup expense | 12,000.00 | Record expense |
| 10 Mar | Sale of unit A-101 | 80,000.00 | Safes, Receive cash |
| 5 Apr | Shareholder A lends the company money | 20,000.00 | Add money, Shareholder loan |
| 1 May | Salaries | 18,000.00 | Record expense |
| 15 Jun | Transfer, Main Safe to Reserve Safe | 40,000.00 | Safes, Transfer |
| 1 Jul | Expense entered by mistake | 3,000.00 | Record expense |
| 1 Jul | Its reversal | 3,000.00 | Journal reversals |
| 20 Aug | Vendor and operating costs | 25,000.00 | Safes, Pay |
| 15 Sep | Sale of unit B-204 | 120,000.00 | Safes, Receive cash |
| 1 Oct | Part of the shareholder loan repaid | 5,000.00 | Loans, Repay |
| 20 Oct | Utilities (account code `0012`) | 10,000.00 | Record expense |
| 3 Nov | AFN loan into an empty AFN Safe, at 70 | 700,000 AFN | Add money, Other loan |
| 10 Nov | Repay half, the day's rate now 65 | 350,000 AFN | Loans, Repay |
| 17 Nov | Repay the rest, the day's rate now 80 | 350,000 AFN | Loans, Repay |

Two things the product decides differently from the scenario as first written, both by design:

- **The reversal is dated 1 July, not 2 July.** A reversal takes the original's date while that month is open (migration 0050). The operator does not choose its date.
- **No December entry.** Forms refuse a date after today, and the simulation ran in November.

## The oracle and the result

Worked out by hand from the table above. The mistaken expense and its reversal net to nothing. The AFN loan was received and repaid from the same Safe, so it leaves nothing.

| Figure | Expected | The system |
| --- | --- | --- |
| Revenue | 200,000.00 | 200,000.00 |
| Operating expenses | 65,000.00 | 65,000.00 |
| Net profit | 135,000.00 | 135,000.00 |
| Total assets | 300,000.00 | 300,000.00 |
| Total liabilities | 15,000.00 | 15,000.00 |
| Total equity (capital 150,000 + the year's result 135,000) | 285,000.00 | 285,000.00 |
| Balance sheet difference | 0.00 | 0.00 |
| Trial balance, ending debits | 365,000.00 | 365,000.00 |
| Trial balance, ending credits | 365,000.00 | 365,000.00 |
| Main Safe / Reserve Safe | 260,000.00 / 40,000.00 | 260,000.00 / 40,000.00 |
| Shareholder loan still owed | 15,000.00 | 15,000.00 |
| AFN Safe, AFN loan: native and accounting value | 0 and 0.00 | 0 and 0.00 |
| Realized FX from the AFN loan | none | none |

The year's result is derived for the balance sheet. No closing journal exists, as V1 intends.

### What was reconciled

- **The ledger, read independently.** All 32 posted lines, by date, account, debit and credit, equal the 32 lines the oracle lists. Each side totals 506,000.00.
- **Trial balance.** Every account's ending side and amount; no account missing or unexplained.
- **Income statement, balance sheet, financial summary.** Each equals the oracle, and the summary agrees with the Treasury and the ledger.
- **Account statements,** for all eleven accounts with activity: opening plus every movement gives the closing, and the closing is the trial balance's figure.
- **Safe statements.** The transfer appears on both Safes as a transfer, never as company money in or out. Each Safe agrees with the ledger.
- **Shareholder statement.** Shareholder A's capital (100,000) and loan (15,000) are separate figures and are never added. Shareholder B has capital only.
- **Loan register and statements.** Principal, repayment and amount owed for both loans.
- **General Ledger,** as the screen pages it: the same 32 lines the database holds.
- **The reversal.** The original stays posted; the reversal copies its amounts the other way; both are linked with the reason.

## A separate FX test

Kept apart from the year's figures, on its own AFN Safe, after the year-end reconciliation. Two loans arrive at different rates, so the Safe's carrying value is a mix. Each expected result was worked out by hand before posting.

| Step | By hand | The system |
| --- | --- | --- |
| 3 Nov, 140,000 AFN at 70 (2,000.00), then 10 Nov, 65,000 AFN at 65 (1,000.00) | Safe carries 3,000.00 for 205,000 AFN; the loans total 3,000.00 | 3,000.00 and 3,000.00 |
| Repay 70,000 AFN of the first loan | Safe gives up 1,024.39, the loan drops 1,000.00: loss 24.39 | loss 24.39 |
| Repay all 65,000 AFN of the second loan | Safe gives up 951.22, the loan drops 1,000.00: gain 48.78 | gain 48.78 |
| Repay the last 70,000 AFN of the first loan | Safe gives up its last 1,024.39, the loan drops 1,000.00: loss 24.39 | loss 24.39 |
| At the end | Safe 0 AFN and 0.00; both loans 0; gains 48.78 = losses 48.78 | the same |

Everything borrowed was repaid in the same currency, so the gains and losses had to cancel, and they do, to the cent. Net profit, assets, liabilities and equity are unchanged by this test.

## Exports, confidentiality and documents

- **Exports.** For the Trial balance (also with zero-balance accounts, and in Dari), three account statements, both USD Safes and the General Ledger, the downloaded file equals the screen's own response passed through the formatter, byte for byte. Decoded, the rows are the screen's rows in the screen's order. The account code `0012` is still `0012`. An account named `=1+1 formula check` is written as text. A liability's negative closing is a bare number. Dari text survives. Eleven files produced exactly eleven audit events, each holding metadata only. A refused export produced no file and no event.
- **Print.** Trial balance, income statement and balance sheet print in Dari, right to left, with the company, report, period and "Confidential / محرمانه", without the navigation and without horizontal overflow.
- **A report-only reader** gets the same figures as the Finance Manager and none of the private detail (people, lenders, references, descriptions, the reversal reason, links to source records), in twelve raw responses and in two exported files.
- **The person responsible for one Safe,** assigned on the Safes screen, sees and exports exactly that Safe. Another Safe of the same company and an id that names nothing get the same answer, byte for byte. Broader exports are refused.
- **A second company's** account, Safe and ids are refused exactly as unknown ids are, on seven routes, and appear in none of this company's reports.
- **Documents** were attached through the screens to a shareholder, a loan, an expense, a receipt and the company. Each was scanned clean by the real scanner, posted nothing, and is served only to people who may read its record; everyone else gets the answer an unknown address gets. The vault's integrity check found nothing.

## What the simulation found

Defects fixed before release:

| Found | Fix |
| --- | --- |
| Switching language on the Trial balance silently reloaded it with default filters, while the form still showed the earlier choices. | The report no longer reloads on a language switch. |
| After a loan was saved, Add money showed only "Loan recorded." A second loan of the same kind needed leaving the page. | "Record another loan", and choosing a source always opens a fresh form with its own request. |

Recorded, not changed for V1 (see `docs/00-governance/OPEN_ITEMS.md`):

- V1 has no property or unit sales workflow. A sale is a cash receipt against a revenue account, with the unit only in the free-text reference.
- An expense paid from a Safe can name only a party already on file; a new vendor's name goes into the description.
- Journal references shown to operators are long machine ids.
- The System Administrator sees Company details read-only, with nothing saying which permission edits them.
- A reversal's date cannot be chosen.
