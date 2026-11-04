# Chart of Accounts classification audit

Status: completed before the Income Statement and Balance Sheet were built. Read from the schema at 0056.

## 1. What classification exists

| Fact | Where it is guaranteed |
|---|---|
| Every ledger account has a class | `ledger_accounts.account_type` is `NOT NULL` |
| The class is one of ASSET, LIABILITY, EQUITY, REVENUE, EXPENSE | A table `CHECK` constraint. REVENUE is the requested INCOME class under its existing name |
| A class cannot change once an account is used | `guard_ledger_account_change` refuses a change of type, code, currency or control type on an account in use |
| A class cannot change on an account with sub-accounts | The same guard |
| Every journal line has an account | `journal_lines.ledger_account_id`, a foreign key |
| Control type implies class | `coa_validate`, called by every Chart of Accounts command: CASH, AR and contributed assets are ASSET; AP, SHAREHOLDER_LOAN and TEMPORARY_FUNDING_PAYABLE are LIABILITY; SHAREHOLDER_CAPITAL and OPENING_BALANCE_EQUITY are EQUITY; FX_DIFFERENCE is REVENUE or EXPENSE; SARAF is ASSET or LIABILITY |
| Accounts can be grouped | `parent_ledger_account_id` gives a hierarchy |

No report needs account numbers, names or English words to classify anything.

## 2. What is missing

Nothing in the schema records current versus non-current, or operating versus other. These cannot be inferred, so V1 does not present them:

| Requested group | Available? |
|---|---|
| Assets, Liabilities, Equity, Income, Expense | Yes, from the class |
| Treasury / cash; shareholder and provider loans; supplier payables; shareholder capital; Opening Balance Equity | Yes, from the control type, which the schema ties to the class |
| Current and non-current assets or liabilities | No |
| Operating and other income or expense | No |

## 3. Can the Income Statement be correct?

Yes. Income is the REVENUE accounts and expenses are the EXPENSE accounts. Any posting to one of them appears automatically, whichever module posted it.

## 4. Can the Balance Sheet be correct?

Yes. Every line sits in exactly one class, and double entry makes Assets = Liabilities + Equity + the accumulated result. There is no closing journal, so the result is derived for display and nothing is posted.

## 5. Schema change

None. A classification migration would add nothing the required statements need, and the owner asked for no migration without a need. Migration 0059 therefore contains the statements themselves.

If statutory groupings are wanted, the smallest extension is one optional `statement_section` attribute on `ledger_accounts`. Arithmetic would not change. Accounts without a section would be listed under their class and flagged for setup, never guessed. See the owner decisions in `docs/04-delivery/V1_REPORTING_STATUS.md`.

## 6. A note on Saraf accounts

A Saraf account may be ASSET or LIABILITY. An ASSET Saraf with a negative balance is shown as a negative figure under Treasury, and the statement says so. It is not moved to liabilities, because that would be a presentation policy the schema does not define.
