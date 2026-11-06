import assert from "node:assert/strict";
import test from "node:test";

import { loanReadinessGaps, type LoanReadiness } from "./loans.ts";

const ready: LoanReadiness = {
  legalEntityId: "e", baseCurrency: "USD", approvalRequired: false, canManageAccounts: false, canManageRoles: false,
  permissions: { canRead: true, canRecord: true, canRepay: true, canApprove: false },
  accounts: [{ control: "SHAREHOLDER_LOAN", accountType: "LIABILITY", status: "READY" }, { control: "LOAN_PAYABLE", accountType: "LIABILITY", status: "READY" },
    { control: "REALIZED_FX_GAIN", accountType: "REVENUE", status: "READY" }, { control: "REALIZED_FX_LOSS", accountType: "EXPENSE", status: "READY" }]
};
const active = [{ status: "ACTIVE" }];

test("nothing is missing when every account is ready and the person holds what the company needs", () => {
  assert.deepEqual(loanReadinessGaps(ready), { accounts: [], permissions: [] });
});

test("every account that is not ready is named, whatever is wrong with it", () => {
  const accounts = ready.accounts.map((a, i) => ({ ...a, status: (["MISSING", "READY", "AMBIGUOUS", "INVALID"] as const)[i] ?? "READY" }));
  assert.deepEqual(loanReadinessGaps({ ...ready, accounts }).accounts.map((a) => a.control), ["SHAREHOLDER_LOAN", "REALIZED_FX_GAIN", "REALIZED_FX_LOSS"]);
});

test("approval is someone's gap only when the company requires it", () => {
  assert.deepEqual(loanReadinessGaps(ready).permissions, []);
  assert.deepEqual(loanReadinessGaps({ ...ready, approvalRequired: true }).permissions, ["finance.loan.approve"]);
});

test("with the roles in hand, a permission counts only if an active role gives it to an active person", () => {
  const roles = [{ status: "ACTIVE", permissions: ["finance.loan.read"], holders: active }, { status: "ACTIVE", permissions: ["finance.loan.record"], holders: [] },
    { status: "INACTIVE", permissions: ["finance.loan.repay"], holders: active }, { status: "ACTIVE", permissions: ["finance.loan.approve"], holders: [{ status: "SUSPENDED" }] }];
  assert.deepEqual(loanReadinessGaps(ready, roles).permissions, ["finance.loan.record", "finance.loan.repay", "finance.loan.approve"]);
});

test("an administrator's own lack of a permission is not the gap: reaching someone is", () => {
  const holder = { ...ready, permissions: { canRead: false, canRecord: false, canRepay: false, canApprove: false } };
  const roles = [{ status: "ACTIVE", permissions: ["finance.loan.read", "finance.loan.record", "finance.loan.repay", "finance.loan.approve"], holders: active }];
  assert.deepEqual(loanReadinessGaps(holder, roles).permissions, []);
});
