"use client";

import type { OperationalExpenseStatus } from "@abos/contracts";

import { errorText } from "@/components/AdminUsersWorkspace";
import type { Copy } from "@/lib/access-copy";

/** Today's business date in Kabul, used only as a form default. */
export function kabulToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kabul", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date());
}

export function firstOfMonth(date: string): string {
  return `${date.slice(0, 8)}01`;
}

/** Display only: digits are grouped, never rounded, padded or converted. */
export function exactAmount(value: string): string {
  const negative = value.startsWith("-");
  const [whole = "0", fraction] = (negative ? value.slice(1) : value).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "−" : ""}${fraction === undefined ? grouped : `${grouped}.${fraction}`}`;
}

export function money(value: string, currency: string): string {
  return `${exactAmount(value)} ${currency}`;
}

/** Business wording for an expense's state; internal state names never reach the screen. */
export const EXPENSE_STATUS_COPY: Readonly<Record<OperationalExpenseStatus, Copy>> = {
  DRAFT: { en: "Being recorded", fa: "در حال ثبت" },
  VALIDATED: { en: "Being recorded", fa: "در حال ثبت" },
  PENDING_APPROVAL: { en: "Waiting for approval", fa: "منتظر تأیید" },
  POSTED: { en: "Recorded", fa: "ثبت شد" }
};

/** Dari for the expense refusals the server returns (codes from operationalExpenseErrorResponse). */
const EXPENSE_ERROR_FA: Readonly<Record<string, string>> = {
  RATE_MISSING: "برای این تاریخ نرخ اسعار ثبت نشده است. ابتدا نرخ همان روز را ثبت کنید.",
  RATE_CHOICE_REQUIRED: "برای این تاریخ چند نرخ وجود دارد. نرخی را که این مصرف استفاده می‌کند انتخاب کنید.",
  RATE_INVALID: "نرخ انتخاب‌شده، نرخ جاری این تاریخ نیست.",
  CONVERSION_NOT_EXACT: "این مبلغ با نرخ انتخاب‌شده به‌طور دقیق تبدیل نمی‌شود و قواعد گردکردن هنوز تصویب نشده است.",
  PERIOD_NOT_OPEN: "هیچ دوره حسابداری باز این تاریخ را پوشش نمی‌دهد.",
  POLICY_NOT_CONFIGURED: "تنظیمات تأیید مصارف برای این شرکت هنوز انجام نشده است.",
  BASE_CURRENCY_NOT_APPROVED: "واحد پول پایه شرکت هنوز تصویب نشده است.",
  ACCOUNT_OR_CATEGORY_UNAVAILABLE: "یک حساب خزانه فعال به همان واحد پول و یک دسته مصرف فعال انتخاب کنید.",
  PAYEE_UNAVAILABLE: "دریافت‌کننده انتخاب‌شده فعال نیست.",
  ALREADY_SUBMITTED_DIFFERENTLY: "این مصرف قبلاً با جزئیات دیگری فرستاده شده است. یک مصرف تازه شروع کنید.",
  SEGREGATION_OF_DUTIES: "شما نمی‌توانید مصرفی را که خودتان ثبت کرده‌اید تأیید کنید.",
  OUTSIDE_SCOPE: "این مصرف خارج از پروژه‌ها، بخش‌ها یا مراکز هزینه‌ای است که با آن‌ها کار می‌کنید.",
  NOT_PENDING: "این مصرف دیگر منتظر تأیید نیست.",
  STALE_VERSION: "این مصرف تغییر کرده است. دوباره بارگذاری کنید و تلاش کنید.",
  NOT_FOUND: "این مصرف پیدا نشد.",
  VALIDATION_FAILED: "جزئیات وارد‌شده کامل یا درست نیست.",
  AUTHENTICATION_REQUIRED: "جلسه شما پایان یافته است. دوباره وارد شوید.",
  PERMISSION_DENIED: "شما صلاحیت این کار را ندارید.",
  NETWORK: "سرور در دسترس نیست. دوباره تلاش کنید؛ همان درخواست دوباره ثبت نمی‌شود."
};

export function expenseErrorText(error: { code: string; message: string }, locale: "en" | "fa"): string {
  if (locale === "fa") return EXPENSE_ERROR_FA[error.code] ?? errorText(error, locale);
  if (error.code === "NETWORK") {
    return "The server could not be reached. Try again; the same expense will not be recorded twice.";
  }
  return error.message || errorText(error, locale);
}

export function localizedName(item: { readonly nameEn: string; readonly nameFa: string | null }, fa: boolean): string {
  return fa && item.nameFa ? item.nameFa : item.nameEn;
}
