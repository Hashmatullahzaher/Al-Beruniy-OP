import { expect, test, type Page } from "@playwright/test";

// HTTP-mocked UI tests only: the first-run guidance a new company meets on an empty database (end-to-end test of 2026-11-02).
const user = (permissions: string[], roles: string[]) => ({ userAccountId: "77000000-0000-4000-8000-000000000001", loginIdentifier: "admin",
  displayName: "UI test Administrator", jobTitle: null, legalEntityName: "UI test company", permissions, roles, sessionExpiresAt: "2099-01-01T00:00:00Z" });

async function signIn(page: Page, permissions: string[], roles: string[]) {
  await page.route("**/api/v1/auth/me", (route) => route.fulfill({ json: { ok: true, data: user(permissions, roles) } }));
}

test("an administrator without Finance access is told how Finance work starts, since nobody grants access to themselves", async ({ page }) => {
  await signIn(page, ["admin.users.manage", "admin.roles.manage"], ["Super Administrator"]);
  await page.goto("/dashboard");
  const note = page.getByRole("note").filter({ hasText: "nobody can give access to themselves" });
  await expect(note).toContainText("create a Finance role in Roles & permissions, create the Finance user in Users and give them that role");
  await expect(note.getByRole("link", { name: "Roles & permissions" })).toHaveAttribute("href", "/admin/roles");
  await expect(note.getByRole("link", { name: "Users" })).toHaveAttribute("href", "/admin/users");
});

test("a Finance user does not see the administrator note", async ({ page }) => {
  await signIn(page, ["admin.users.manage", "finance.expense.create", "treasury.safe.read"], ["Finance Manager"]);
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: /Welcome/ })).toBeVisible();
  await expect(page.getByText("nobody can give access to themselves")).toHaveCount(0);
});
