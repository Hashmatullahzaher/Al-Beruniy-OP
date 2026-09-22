import { expect, test } from "@playwright/test";

test("@smoke Stage 1 Finance foundation reports every operational gate as closed", async ({ request }) => {
  const response = await request.get("/api/v1/finance/foundation");
  expect(response.ok()).toBeTruthy();
  expect(response.headers()["x-abos-operational-status"]).toBe("foundation-only");
  await expect(response.json()).resolves.toMatchObject({
    stage: "E0_FOUNDATION",
    postingAvailable: false,
    productionPostingAuthorized: false,
    transactionCurrencies: ["USD", "AFN"]
  });
});
