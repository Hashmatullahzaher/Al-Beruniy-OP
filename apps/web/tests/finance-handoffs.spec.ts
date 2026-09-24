import { expect, test } from "@playwright/test";

const summary = {
  id: "90000000-0000-4000-8000-000000000001", receiptId: "90000000-0000-4000-8000-000000000002",
  receiptReference: "DEMO-REC-001", shareholder: "Synthetic Shareholder", agreementReference: "DEMO-AGR-001",
  installmentSequence: 1, amount: "1000.00", currency: "USD", receivingAccount: "Demo office safe · USD",
  handedOffAt: "2026-09-24T08:00:00.000Z", stage: "HANDED_TO_FINANCE"
};
const trace = {
  ...summary, agreementId: "90000000-0000-4000-8000-000000000003", installmentId: "90000000-0000-4000-8000-000000000004",
  receivingSafe: "Demo office safe", physicalCount: { amount: "1000.00", countedBy: "Synthetic Cashier", confirmedBy: "Synthetic Verifier", evidence: "DEMO COUNT EVIDENCE" },
  receiptEvidence: "DEMO RECEIPT EVIDENCE", verifier: "Synthetic Verifier", handedOffBy: "Synthetic Verifier",
  reconciliation: { sourceStatus: "TREASURY_VERIFIED", receiptStatus: "VERIFIED", journalStatus: "NOT_POSTED" }
};

test("Finance preparer sees only the controlled prepare action", async ({ page }) => {
  await page.route("**/api/v1/finance/handoffs", route => route.fulfill({ json: { ok: true, data: { actor: { userAccountId: "a", displayName: "Finance Preparer", permissions: ["finance.posting-intent.create"], sessionExpiresAt: "2026-09-25T00:00:00Z" }, handoffs: [summary], openPeriods: [{ id: "90000000-0000-4000-8000-000000000005", label: "DEMO 2026", startsOn: "2026-01-01", endsOn: "2026-12-31" }] } } }));
  await page.route(`**/api/v1/finance/handoffs/${summary.id}`, route => route.fulfill({ json: { ok: true, data: trace } }));
  await page.goto("/finance/handoffs");
  await page.getByRole("button", { name: /DEMO-REC-001/ }).click();
  await expect(page.getByRole("button", { name: "Prepare posting intent" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Independently approve" })).toHaveCount(0);
  await expect(page.getByText("DEMO RECEIPT EVIDENCE")).toBeVisible();
});

test("Finance approver sees approval for another persona's draft and no prepare action", async ({ page }) => {
  const approvedTrace = { ...trace, stage: "PENDING_APPROVAL", postingIntent: { id: "90000000-0000-4000-8000-000000000006", status: "PENDING_APPROVAL", createdBy: "Finance Preparer", accountingEffectiveDate: "2026-09-24" } };
  await page.route("**/api/v1/finance/handoffs", route => route.fulfill({ json: { ok: true, data: { actor: { userAccountId: "b", displayName: "Independent Approver", permissions: ["finance.posting-intent.approve", "finance.journal.post"], sessionExpiresAt: "2026-09-25T00:00:00Z" }, handoffs: [{ ...summary, stage: "PENDING_APPROVAL", postingIntentId: approvedTrace.postingIntent.id }], openPeriods: [{ id: "90000000-0000-4000-8000-000000000005", label: "DEMO 2026", startsOn: "2026-01-01", endsOn: "2026-12-31" }] } } }));
  await page.route(`**/api/v1/finance/handoffs/${summary.id}`, route => route.fulfill({ json: { ok: true, data: approvedTrace } }));
  await page.goto("/finance/handoffs");
  await page.getByRole("button", { name: /DEMO-REC-001/ }).click();
  await expect(page.getByRole("button", { name: "Independently approve" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Prepare posting intent" })).toHaveCount(0);
});
