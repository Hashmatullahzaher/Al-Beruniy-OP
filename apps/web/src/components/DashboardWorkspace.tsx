"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { AppIcon, type AppIconName } from "@/components/AppIcon";
import { useLocale } from "@/components/LocaleProvider";
import { useSession } from "@/components/SessionProvider";
import { StageZeroPageHeader } from "@/components/StageZeroWorkspace";
import { CATEGORY_COPY, PERMISSION_COPY, type Copy } from "@/lib/access-copy";
import type { FinanceHandoffWorkspaceView } from "@/lib/finance-handoff-types";
import type { TreasuryOverview } from "@/lib/treasury-types";

type Counts = ReadonlyArray<{ readonly label: Copy; readonly value: number; readonly tone: string }>;

async function load<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url, { cache: "no-store" });
    const body = await response.json() as { ok: boolean; data?: T };
    return body.ok && body.data ? body.data : null;
  } catch {
    return null;
  }
}

/** Figures below are counted from records the server returns for this person; nothing is estimated. */
function treasuryCounts(overview: TreasuryOverview): Counts {
  const stage = (...stages: string[]) => overview.receipts.filter((receipt) => stages.includes(receipt.stage)).length;
  return [
    { label: { en: "Shareholder installments open for cash", fa: "اقساط سهامدار آماده دریافت نقد" }, value: overview.sources.filter((source) => source.status === "ELIGIBLE").length, tone: "gold" },
    { label: { en: "Recorded, not yet submitted", fa: "ثبت‌شده، هنوز ارسال نشده" }, value: stage("DRAFT", "COUNTED"), tone: "blue" },
    { label: { en: "Awaiting independent verification", fa: "در انتظار تایید مستقل" }, value: stage("PENDING_VERIFICATION"), tone: "cyan" },
    { label: { en: "Verified, not yet with Finance", fa: "تاییدشده، هنوز نزد مالی نیست" }, value: stage("VERIFIED"), tone: "green" },
    { label: { en: "With Finance", fa: "نزد مالی" }, value: stage("HANDED_TO_FINANCE", "APPROVED_BY_FINANCE"), tone: "gold" },
    { label: { en: "Posted by Finance", fa: "ثبت‌شده توسط مالی" }, value: stage("POSTED_BY_FINANCE"), tone: "green" }
  ];
}

function financeCounts(view: FinanceHandoffWorkspaceView): Counts {
  const stage = (value: string) => view.handoffs.filter((item) => item.stage === value).length;
  return [
    { label: { en: "Needs preparation", fa: "نیاز به آماده‌سازی" }, value: stage("HANDED_TO_FINANCE"), tone: "gold" },
    { label: { en: "Awaiting independent approval", fa: "در انتظار تصویب مستقل" }, value: stage("PENDING_APPROVAL"), tone: "cyan" },
    { label: { en: "Approved, ready to post", fa: "تصویب‌شده، آماده ثبت" }, value: stage("APPROVED"), tone: "blue" },
    { label: { en: "Posted to the General Ledger", fa: "ثبت‌شده در دفتر کل" }, value: stage("POSTED"), tone: "green" }
  ];
}

export function DashboardWorkspace() {
  const { locale } = useLocale();
  const fa = locale === "fa";
  const t = (copy: Copy) => copy[locale];
  const session = useSession();
  const [treasury, setTreasury] = useState<Counts | null>(null);
  const [finance, setFinance] = useState<Counts | null>(null);
  const canTreasury = session.can("treasury.read");
  const canFinance = session.can("finance.report.operational.read");

  useEffect(() => {
    let current = true;
    if (canTreasury) void load<TreasuryOverview>("/api/v1/treasury/overview").then((data) => { if (current) setTreasury(data ? treasuryCounts(data) : null); });
    if (canFinance) void load<FinanceHandoffWorkspaceView>("/api/v1/finance/handoffs").then((data) => { if (current) setFinance(data ? financeCounts(data) : null); });
    return () => { current = false; };
  }, [canTreasury, canFinance]);

  if (session.status === "loading") return <div className="treasury-card treasury-placeholder">{fa ? "در حال بارگذاری…" : "Loading…"}</div>;
  if (!session.user) {
    return (
      <div className="module-workspace">
        <div className="treasury-card treasury-placeholder">
          <p>{fa ? "برای دیدن داشبورد خود وارد شوید." : "Sign in to see your dashboard."}</p>
          <Link className="treasury-button gold" href="/login?next=/dashboard">{fa ? "ورود" : "Sign in"}</Link>
        </div>
      </div>
    );
  }

  const user = session.user;
  const grouped = Object.keys(CATEGORY_COPY).map((category) => ({
    category,
    codes: user.permissions.filter((code) => categoryOf(code) === category)
  })).filter((group) => group.codes.length > 0);

  const actions: ReadonlyArray<{ readonly show: boolean; readonly href: string; readonly icon: AppIconName; readonly label: Copy; readonly note: Copy }> = [
    { show: session.can("treasury.cash-receipt.record"), href: "/finance/treasury", icon: "coins", label: { en: "Record cash received", fa: "ثبت نقد دریافتی" }, note: { en: "Treasury → Shareholder intents", fa: "خزانه ← درخواست‌های سهامداران" } },
    { show: session.can("treasury.cash-receipt.verify"), href: "/finance/treasury", icon: "shield", label: { en: "Verify receipts recorded by others", fa: "تایید رسیدهای ثبت‌شده توسط دیگران" }, note: { en: "Treasury → Receipts", fa: "خزانه ← رسیدها" } },
    { show: session.can("finance.report.operational.read"), href: "/finance/handoffs", icon: "finance", label: { en: "Open the Finance inbox", fa: "باز کردن صندوق مالی" }, note: { en: "Prepare, approve or post journals", fa: "آماده‌سازی، تصویب یا ثبت ژورنال" } },
    { show: session.can("admin.users.manage"), href: "/admin/users", icon: "human-resources", label: { en: "Manage employee accounts", fa: "مدیریت حساب‌های کارمندان" }, note: { en: "Create, suspend, assign roles", fa: "ایجاد، تعلیق، تعیین نقش" } },
    { show: session.can("admin.roles.manage"), href: "/admin/roles", icon: "shield", label: { en: "Manage roles and permissions", fa: "مدیریت نقش‌ها و صلاحیت‌ها" }, note: { en: "Build roles from the permission list", fa: "ساخت نقش از فهرست صلاحیت‌ها" } }
  ];

  return (
    <div className="module-workspace dashboard-workspace">
      <StageZeroPageHeader icon="overview"
        eyebrow={{ en: `V1 client preview · ${user.legalEntityName}`, fa: `پیش‌نمایش مشتری V1 · ${user.legalEntityName}` }}
        title={{ en: `Welcome, ${user.displayName}`, fa: `خوش آمدید، ${user.displayName}` }}
        description={{ en: "Your work and your access, read from the system when this page opened.", fa: "کار و دسترسی شما، هنگام باز شدن این صفحه از سیستم خوانده شده است." }} />

      <section className="finance-boundary-banner"><span><AppIcon name="shield" size={22}/></span><div>
        <p>{fa ? "فقط داده‌های آزمایشی مصنوعی" : "SYNTHETIC PREVIEW DATA ONLY"}</p>
        <strong>{fa ? "هیچ پول یا سوابق واقعی شرکت در این محیط نیست. ثبت واقعی مالی تا پایان بررسی امنیتی غیرفعال است." : "No real money or company records are in this environment. Real financial posting stays disabled until the security review is complete."}</strong>
      </div><em>V1 · NOT PRODUCTION</em></section>

      <section className="dashboard-actions" aria-label={fa ? "کارهای شما" : "Your work"}>
        {actions.filter((action) => action.show).map((action) => (
          <Link key={action.label.en} href={action.href} className="dashboard-action">
            <span aria-hidden="true"><AppIcon name={action.icon} size={20} /></span>
            <div><strong>{t(action.label)}</strong><small>{t(action.note)}</small></div>
          </Link>
        ))}
        {actions.every((action) => !action.show) ? <p className="treasury-placeholder">{fa ? "هنوز کاری برای شما تعیین نشده است." : "No work has been assigned to you yet."}</p> : null}
      </section>

      {canTreasury || canFinance ? (
        <section className="dashboard-counts">
          {canTreasury ? <CountPanel title={{ en: "Treasury", fa: "خزانه" }} counts={treasury} t={t} /> : null}
          {canFinance ? <CountPanel title={{ en: "Finance inbox", fa: "صندوق مالی" }} counts={finance} t={t} /> : null}
        </section>
      ) : null}

      <section className="module-content-card dashboard-access">
        <div className="module-card-heading"><div><p>{fa ? "دسترسی شما" : "YOUR ACCESS"}</p><h2>{fa ? "آنچه اجازه دارید انجام دهید" : "What you are allowed to do"}</h2></div></div>
        {grouped.map((group) => (
          <div key={group.category} className="dashboard-access-group">
            <h3>{t(CATEGORY_COPY[group.category] ?? { en: group.category, fa: group.category })}</h3>
            <ul>{group.codes.map((code) => {
              const copy = PERMISSION_COPY[code];
              return <li key={code}><strong>{copy ? t(copy.label) : code}</strong><span>{copy ? t(copy.allows) : ""}</span>
                {copy?.independence ? <em>{t(copy.independence)}</em> : null}</li>;
            })}</ul>
          </div>
        ))}
        <p className="dashboard-footnote">{fa ? "نقش‌ها توسط مدیر تعیین می‌شوند. قوانین استقلال در هر معامله توسط سرور و دیتابیس اعمال می‌شود، حتی اگر چند نقش داشته باشید." : "Roles are set by your administrator. Independence rules are enforced on every transaction by the server and database, even if you hold several roles."}</p>
      </section>
    </div>
  );
}

function CountPanel({ title, counts, t }: { readonly title: Copy; readonly counts: Counts | null; readonly t: (copy: Copy) => string }) {
  return (
    <div className="module-content-card dashboard-count-panel">
      <div className="module-card-heading"><div><h2>{t(title)}</h2></div></div>
      {counts === null ? <p className="treasury-placeholder">{t({ en: "Loading…", fa: "در حال بارگذاری…" })}</p> : (
        <ul>{counts.map((item) => <li key={item.label.en} className={`tone-${item.tone}`}><strong>{item.value}</strong><span>{t(item.label)}</span></li>)}</ul>
      )}
    </div>
  );
}

function categoryOf(code: string): string {
  if (code.startsWith("admin.")) return "ADMINISTRATION";
  if (code.startsWith("shareholder.")) return "SHAREHOLDER";
  if (code.startsWith("treasury.")) return "TREASURY";
  return "FINANCE";
}
