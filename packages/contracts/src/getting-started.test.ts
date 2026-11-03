import assert from "node:assert/strict";
import test from "node:test";

import {
  FINANCE_MANAGER_ROLE_TEMPLATE, GETTING_STARTED_FINANCE_PERMISSIONS, operatingModeInForce, operatingModePlan, requiredAccounts, suggestedFirstYear,
  type AccountReadinessInput
} from "./getting-started.ts";
import type { FinanceWorkflowPolicy, FinanceWorkflowType } from "./workflow-policy.ts";

const policy = (workflowType: FinanceWorkflowType, configured: boolean, approvalRequired: boolean | null, version = configured ? 1 : 0,
  approvalAvailable = true): FinanceWorkflowPolicy => ({ workflowType, labelEn: workflowType, labelFa: workflowType, approvalAvailable, configured,
  policyVersionId: configured ? `v-${workflowType}` : null, version, approvalRequired, changeReason: null, configuredAt: null, configuredBy: null, history: [] });
const fresh = () => [policy("CHART_OF_ACCOUNTS", false, null), policy("SHAREHOLDER_CAPITAL_RECEIPT", false, null), policy("EXPENSE", false, null),
  policy("JOURNAL_REVERSAL", false, null), policy("TEMPORARY_FUNDING", false, null), policy("TREASURY_TRANSFER", false, null, 0, false)];

test("Simple mode on a new company saves exactly the four settings OFF, each at its current version", () => {
  const plan = operatingModePlan("SIMPLE", fresh());
  assert.deepEqual(plan.saves.map((s) => [s.workflowType, s.approvalRequired, s.expectedVersion]), [
    ["CHART_OF_ACCOUNTS", false, 0], ["SHAREHOLDER_CAPITAL_RECEIPT", false, 0], ["EXPENSE", false, 0], ["JOURNAL_REVERSAL", false, 0]]);
  assert.deepEqual([plan.unavailable, plan.missing], [[], []]);
  assert.equal(operatingModeInForce(fresh()), "NOT_CHOSEN");
});

test("a setting already explicitly in force is not saved again; temporary funding is never touched", () => {
  const policies = fresh().map((p) => p.workflowType === "CHART_OF_ACCOUNTS" ? policy("CHART_OF_ACCOUNTS", true, false, 3) : p);
  const plan = operatingModePlan("SIMPLE", policies);
  assert.deepEqual(plan.saves.map((s) => s.workflowType), ["SHAREHOLDER_CAPITAL_RECEIPT", "EXPENSE", "JOURNAL_REVERSAL"]);
  assert.equal(operatingModeInForce(policies), "MIXED");
  assert.ok(!plan.saves.some((s) => s.workflowType === "TEMPORARY_FUNDING"));
  const done = policies.map((p) => ["SHAREHOLDER_CAPITAL_RECEIPT", "EXPENSE", "JOURNAL_REVERSAL"].includes(p.workflowType) ? policy(p.workflowType, true, false, 1) : p);
  assert.equal(operatingModeInForce(done), "SIMPLE");
});

test("Advanced mode never saves ON where no approval lane exists; a changed OFF setting is moved to ON at its version", () => {
  const policies = fresh().map((p) => p.workflowType === "JOURNAL_REVERSAL" ? policy("JOURNAL_REVERSAL", false, null, 0, false)
    : p.workflowType === "EXPENSE" ? policy("EXPENSE", true, false, 2) : p);
  const plan = operatingModePlan("ADVANCED", policies);
  assert.deepEqual(plan.saves.map((s) => [s.workflowType, s.approvalRequired, s.expectedVersion]),
    [["CHART_OF_ACCOUNTS", true, 0], ["SHAREHOLDER_CAPITAL_RECEIPT", true, 0], ["EXPENSE", true, 2]]);
  assert.deepEqual(plan.unavailable, ["JOURNAL_REVERSAL"]);
});

test("a workflow an older installation lacks is reported, never invented", () => {
  const plan = operatingModePlan("SIMPLE", fresh().filter((p) => p.workflowType !== "JOURNAL_REVERSAL"));
  assert.deepEqual(plan.missing, ["JOURNAL_REVERSAL"]);
});

const account = (code: string, type: string, controlType: string | null, reviewState: string | null, extra: Partial<AccountReadinessInput> = {}): AccountReadinessInput =>
  ({ id: code, code, name: code, type, controlType, currency: "USD", status: "ACTIVE", postingAllowed: true, reviewState, ...extra });

test("required accounts: ready, waiting for review, or missing; currency, status and group accounts respected", () => {
  assert.deepEqual(requiredAccounts([], "USD").map((r) => r.state), ["MISSING", "MISSING", "MISSING"]);
  const accounts = [account("1100", "ASSET", "CASH", "NOT_REQUIRED"), account("3100", "EQUITY", "SHAREHOLDER_CAPITAL", "PENDING_REVIEW"),
    account("5000", "EXPENSE", null, "REVIEWED", { postingAllowed: false }), account("1200", "ASSET", "CASH", null, { currency: "AFN" }),
    account("5100", "EXPENSE", null, "FLAGGED")];
  assert.deepEqual(requiredAccounts(accounts, "USD").map((r) => [r.kind, r.state, r.account?.code ?? null]),
    [["CASH", "READY", "1100"], ["SHAREHOLDER_CAPITAL", "WAITING", "3100"], ["EXPENSE", "MISSING", null]]);
  assert.equal(requiredAccounts([account("1100", "ASSET", "CASH", null, { status: "INACTIVE" })], "USD")[0]?.state, "MISSING");
});

test("the first financial year is the current one, not next year", () => {
  assert.equal(suggestedFirstYear(2026, []), 2026);
  assert.equal(suggestedFirstYear(2026, [2026]), 2027);
});

test("the Finance Manager template covers every permission the Getting started steps use", () => {
  for (const permission of GETTING_STARTED_FINANCE_PERMISSIONS) assert.ok((FINANCE_MANAGER_ROLE_TEMPLATE.permissions as readonly string[]).includes(permission), permission);
  assert.ok(!FINANCE_MANAGER_ROLE_TEMPLATE.permissions.some((p) => p.startsWith("admin.users") || p.startsWith("admin.roles")), "never user or role administration");
});
