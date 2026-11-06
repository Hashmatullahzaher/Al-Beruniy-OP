# V1 first-loan readiness

What a company must do before its first loan, proved by `apps/web/tests/v1-first-loan-readiness.spec.ts` on a production build. The test starts where an upgraded company starts and sets nothing up by SQL.

## Required before the first loan

| Item | Who | Where | When it is needed |
|---|---|---|---|
| The loan permissions | An administrator | Roles & permissions | Before anyone can record, repay or read a loan |
| Shareholder Loan Payable | Whoever manages the Chart of Accounts | Add money links to a filled-in form | Before a shareholder loan |
| Other Loan Payable | The same | The same | Before a loan from anyone else |
| Realized FX Gain | The same | The same, or the refusal's own link | Only when foreign currency settles for more than it carried |
| Realized FX Loss | The same | The same | Only when foreign currency settles for less than it carried |

No migration grants a permission or creates an account. The upgrade proof shows no row changes in `role_permissions` or `ledger_accounts`.

A new company that uses the Finance Manager template holds the loan permissions from that template. An upgraded company's roles do not, because their permissions were saved before loans existed.

## What the test proves

- Without the permissions, the Loans menu is gone, the loan choices are disabled, and Add money names each permission and says to ask an administrator.
- All four accounts are named with why each is needed, in English and in Dari, right to left.
- With the permissions but no account, the form is not offered. It points to the Chart of Accounts.
- Each link opens the existing account form filled in, so the person adds only a code.
- A USD loan records and repays with no FX account.
- An AFN repayment with no difference needs no FX account, at the loan's own rate and at a changed rate from the same AFN.
- A repayment with a real difference refuses until its account exists, and leaves no repayment and no journal.
- After the Loss account is created, the same repayment posts with the difference as its own line. The Gain account is never demanded.
