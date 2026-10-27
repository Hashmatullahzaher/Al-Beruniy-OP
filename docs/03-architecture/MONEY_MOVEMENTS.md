# Basic money movements: receive cash, transfer, pay (Slice 4)

Status: design for Slice 4, written from trunk `4ee3e24` (production runs 0046). Implemented in
migrations 0047 and 0048. Binding: one business event = one posting source; the posting kernel and
registry (0043/0044); the canonical Treasury model (`operational_treasury_accounts`, Safe and Saraf
alike); balances only from posted movements (0045); one-save screens; no new engine, Safe model or
stored balance.

## 1. Facts this design starts from

| Fact | Where |
|---|---|
| Registry rows CASH_RECEIPT, PAYMENT, TREASURY_TRANSFER exist as PLANNED | 0043 |
| Approval settings exist per workflow type: OTHER_INCOME, SUPPLIER_PAYMENT, SALARY_PAYMENT, TREASURY_TRANSFER, EXPENSE (and others); production has OTHER_INCOME, SUPPLIER_PAYMENT and TREASURY_TRANSFER saved with approval OFF | `finance_workflow_types`, production read-only |
| Lanes without an approval flow refuse when their setting requires approval (direct capital) | 0040 |
| The expense lane (categories, approval route, FX snapshot, dimensions, payee) is the only way expenses reach the daily report's expense figures | 0028/0029 |
| Treasury accounts of type SARAF use a SARAF control asset account; every other type a CASH control asset account | guard |
| Posting lines carry base amounts; a non-base currency needs an exchange-rate snapshot | 0028 |

## 2. Sources (migration 0047)

| Source | Dr | Cr | Treasury movements | Approval setting |
|---|---|---|---|---|
| CASH_RECEIPT (other income) | the receiving Safe/Saraf | an income (REVENUE) account | + on the debit | OTHER_INCOME |
| TREASURY_TRANSFER | the destination Safe/Saraf | the source Safe/Saraf | + on the debit, − on the credit | TREASURY_TRANSFER |
| PAYMENT (against a payable) | a payable (LIABILITY, control AP or none) | the paying Safe/Saraf | − on the credit | SALARY_PAYMENT for salary, otherwise SUPPLIER_PAYMENT |

Each source has its own immutable table (`treasury_cash_receipts`, `treasury_transfers`,
`treasury_payments`), its own intent column, a small validator reached by the kernel's static
dispatch, and one SECURITY DEFINER writer with its own permission
(`treasury.receipt.record`, `treasury.transfer.record`, `treasury.payment.record`).

Common rules for every writer: operational password session; idempotent replay by request key;
Treasury rows locked (both, in a stable order, for a transfer) so concurrent movements and a close
serialize; every Treasury account ACTIVE, in the company and in the movement's currency; for this
slice the approved accounting (base) currency only, like capital, temporary funding and opening
balances; date not after the Kabul business day; PENDING month inside the financial year opened on
the first valid posting, closed or uncovered months refused; the workflow setting must be saved with
approval OFF (Simple Mode: Save posts); audit and outbox.

- Receive cash: from a business party or a free-text name (one of them is required); the income
  account is an active posting REVENUE account without control or required dimensions. Shareholder
  money stays in the shareholder lane; customer receivables wait for Sales/AR.
- Transfer: source and destination differ; both in the transfer currency; Safe ↔ Safe, Safe ↔ Saraf,
  Saraf ↔ Saraf.
- Pay against a payable: kind SUPPLIER, CONTRACTOR, SALARY or OTHER (metadata, not separate engines);
  payee party or free-text name; the payable account is an active posting LIABILITY account with
  control AP or no control (temporary-funding, shareholder-loan and Saraf liabilities are refused:
  they have their own lanes).

Insufficient funds are not refused, exactly like expenses today; whether a physical Safe may go
negative is recorded as an owner-policy question.

## 3. Pay for an expense (migration 0048)

Paying for something that is an expense goes through the existing expense lane, so expenses keep one
model, one approval route and one place in the reports. The Pay screen sends the expense with a
`paymentKind`. The kind chooses the governing approval setting: SALARY → SALARY_PAYMENT, SUPPLIER and
CONTRACTOR → SUPPLIER_PAYMENT, OTHER or none → EXPENSE. That keeps every saved setting effective:
salary cannot bypass a salary approval by being recorded as an ordinary expense. Requests without a
kind behave exactly as before, including their replay fingerprints.

## 4. Screens

On the Safes page each active Safe/Saraf offers **Receive cash**, **Transfer** and **Pay**. Pay asks
what was paid for: an expense type (expense lane) or a payable account (PAYMENT source). Each form
saves once; the Safe's balance and movements update from posted movements.
