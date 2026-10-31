import { TEMPORARY_FUNDING_PERMISSIONS } from "@abos/contracts";

import type { AppIconName } from "@/components/AppIcon";

/**
 * The operational navigation, shared by the application shell and "My dashboard". Each entry is
 * visible only to people whose live permissions need it; the server and database still authorize
 * every request. The E1 Treasury and Finance-inbox screens were retired with migration 0041.
 */

export type NavSection = "home" | "daily" | "reports" | "accounting" | "setup" | "company";

/** Section headings in business language; a section appears only when it has a visible entry. */
export const sectionHeadings: Readonly<Record<Exclude<NavSection, "home">, { readonly en: string; readonly fa: string }>> = {
  daily: { en: "Daily work", fa: "کار روزانه" },
  reports: { en: "Reports", fa: "گزارش‌ها" },
  accounting: { en: "Accounting", fa: "حسابداری" },
  setup: { en: "Setup", fa: "تنظیمات" },
  company: { en: "Company", fa: "شرکت" }
};

/**
 * Operational workspaces, grouped by business responsibility. Each entry appears only for people
 * whose live permissions need it; visibility helps the user, while the server and database still
 * authorize every request.
 */
export const operationalRoutes: ReadonlyArray<{ readonly path: string; readonly icon: AppIconName; readonly en: string; readonly fa: string; readonly section: NavSection; readonly visible: (can: (permission: string) => boolean) => boolean }> = [
  { path: "/", icon: "overview", en: "Company dashboard", fa: "داشبورد عمومی شرکت", section: "home", visible: (can) => can("company.dashboard.read") },
  { path: "/dashboard", icon: "overview", en: "My dashboard", fa: "داشبورد من", section: "home", visible: () => true },
  // Daily Finance work.
  { path: "/finance/record-expense", icon: "coins", en: "Record expense", fa: "ثبت مصرف", section: "daily", visible: (can) => can("finance.expense.create") },
  // Safes: real book balances and opening balances (0045/0046).
  { path: "/finance/safes", icon: "coins", en: "Safes", fa: "صندوق‌ها", section: "daily", visible: (can) => can("treasury.safe.read") || can("treasury.opening-balance.record") },
  { path: "/finance/transactions", icon: "reports-analytics", en: "Daily transactions", fa: "معاملات روزانه", section: "daily", visible: (can) => can("finance.expense.read") },
  // Temporary funding stays reachable by its own route and permissions, but is kept out of ordinary
  // navigation until the owner asks for it; a one-person company does not need the extra lane.
  { path: "/finance/temporary-funding", icon: "coins", en: "Temporary funding", fa: "تمویل موقت", section: "daily", visible: (can) => TEMPORARY_FUNDING_PERMISSIONS.some((permission) => can(permission)) },
  // Reports.
  { path: "/finance/daily-report", icon: "reports-analytics", en: "Daily financial report", fa: "گزارش مالی روزانه", section: "reports", visible: (can) => can("finance.expense.read") },
  // Accounting (accountants and Finance managers).
  { path: "/finance/trial-balance", icon: "reports-analytics", en: "Trial balance", fa: "بیلانس آزمایشی", section: "accounting", visible: (can) => can("finance.report.operational.read") },
  { path: "/finance/general-ledger", icon: "reports-analytics", en: "General Ledger", fa: "دفتر کل", section: "accounting", visible: (can) => can("finance.report.operational.read") },
  { path: "/finance/accounts", icon: "finance", en: "Chart of Accounts", fa: "جدول حساب‌ها", section: "accounting", visible: (can) => can("finance.ledger-account.manage") || can("finance.ledger-account.review") || can("finance.report.operational.read") },
  { path: "/finance/calendar", icon: "reports-analytics", en: "Financial calendar", fa: "تقویم مالی", section: "accounting", visible: (can) => can("finance.calendar.manage") || can("finance.report.operational.read") },
  { path: "/finance/exchange-rates", icon: "coins", en: "Exchange rates", fa: "نرخ اسعار", section: "accounting", visible: (can) => can("finance.exchange-rate.record") || can("finance.report.operational.read") },
  { path: "/finance/fx-policy", icon: "coins", en: "FX policy", fa: "پالیسی اسعار", section: "accounting", visible: (can) => can("finance.fx-policy.manage") || can("finance.exchange-rate.record") },
  { path: "/shareholders", icon: "finance", en: "Shareholders", fa: "سهامداران", section: "accounting", visible: (can) => can("shareholder.setup.manage") || can("shareholder.read") || can("shareholder.capital-receipt.read") || can("shareholder.capital-receipt.record") || can("finance.capital-receipt.prepare") || can("finance.capital-receipt.post") },
  { path: "/finance/reversals", icon: "finance", en: "Journal reversals", fa: "برگشت ژورنال‌ها", section: "accounting", visible: (can) => can("finance.reversal.direct") || can("finance.reversal.request") || can("finance.reversal.approve") },
  { path: "/finance/financial-year", icon: "reports-analytics", en: "Financial year", fa: "سال مالی", section: "accounting", visible: (can) => can("finance.period.manage") || can("finance.report.operational.read") },
  // Finance setup (Treasury accounts, expense types, the financial year's months).
  { path: "/finance/setup", icon: "settings", en: "Finance setup", fa: "تنظیمات مالی", section: "setup", visible: (can) => can("treasury.operational-account.manage") || can("finance.expense-category.manage") || can("finance.period.manage") },
  // Company and administration. Company details are visible to every signed-in employee.
  { path: "/admin/company", icon: "building", en: "Company", fa: "شرکت", section: "company", visible: () => true },
  { path: "/admin/finance-workflows", icon: "shield", en: "Workflow approvals", fa: "تأیید جریان‌ها", section: "company", visible: (can) => can("admin.finance-workflow.manage") },
  { path: "/admin/users", icon: "human-resources", en: "Users", fa: "کاربران", section: "company", visible: (can) => can("admin.users.manage") },
  { path: "/admin/roles", icon: "shield", en: "Roles & permissions", fa: "نقش‌ها و صلاحیت‌ها", section: "company", visible: (can) => can("admin.roles.manage") || can("admin.users.manage") }
];
