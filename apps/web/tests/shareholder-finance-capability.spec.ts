import { expect, test } from "@playwright/test";

test("@smoke coordinated bridge capability is explicit and non-operational", async ({ request }) => {
  const response = await request.get("/api/v1/shareholder/capital-bridge/capability");
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ ok: true, data: {
    state: "SCHEMA_NOT_AVAILABLE",
    schemaInstalled: false,
    mutationAvailable: false,
    reviewModeAvailable: true,
    requiredSessionProvenance: "PASSWORD_OPERATIONAL",
    reason: "The coordinated Shareholders to Finance database capability is not installed."
  } });
});

test("all reserved production bridge routes fail closed without a memory fallback", async ({ request }) => {
  const receipt = "11111111-1111-4111-8111-111111111111";
  const intent = "22222222-2222-4222-8222-222222222222";
  const contribution = "33333333-3333-4333-8333-333333333333";
  const calls = [
    request.post("/api/v1/shareholder/capital-receipts", { data: { contributionId: contribution } }),
    request.post(`/api/v1/treasury/shareholder-capital-receipts/${receipt}/verify`, { data: { decision: "VERIFIED" } }),
    request.post(`/api/v1/finance/shareholder-capital-receipts/${receipt}/prepare`, { data: {} }),
    request.post(`/api/v1/finance/shareholder-capital-postings/${intent}/decision`, { data: { decision: "APPROVED" } }),
    request.post(`/api/v1/finance/shareholder-capital-postings/${intent}/post`, { data: {} }),
    request.get(`/api/v1/finance/shareholder-capital-trace/${contribution}`)
  ];
  for (const response of await Promise.all(calls)) {
    expect(response.status()).toBe(503);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatchObject({ code: "SCHEMA_NOT_AVAILABLE", retryable: false });
    expect(body.capability).toMatchObject({ schemaInstalled: false, mutationAvailable: false });
  }
});

test("the isolated review route remains available only under the explicit test server gate", async ({ page }) => {
  await page.goto("/finance/capital-bridge-review");
  await expect(page.getByRole("heading", { level: 1, name: "Shareholder capital → Finance" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Isolated review boundary" })).toContainText("Memory-only simulation");
});
