"use client";

import { workspaceRoutes } from "@abos/contracts";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Fragment, useState, type ReactNode } from "react";

import { AppIcon, type AppIconName } from "@/components/AppIcon";
import { KabulClock } from "@/components/KabulClock";
import { useLocale } from "@/components/LocaleProvider";
import { useSession } from "@/components/SessionProvider";
import { publicEnvironment } from "@/lib/env";

interface AppShellProps {
  readonly children: ReactNode;
}

const faLabels: Record<string, string> = {
  overview: "نمای کلی",
  projects: "پروژه‌ها",
  "sales-crm": "فروش و مشتریان",
  finance: "مالی",
  construction: "ساخت‌وساز",
  procurement: "تدارکات",
  "human-resources": "منابع بشری",
  "reports-analytics": "گزارش‌ها و تحلیل",
  "ai-insights": "بینش هوشمند",
  documents: "اسناد",
  settings: "تنظیمات"
};

type NavSection = "home" | "daily" | "reports" | "accounting" | "setup" | "company";

/** Section headings in business language; a section appears only when it has a visible entry. */
const sectionHeadings: Readonly<Record<Exclude<NavSection, "home">, { readonly en: string; readonly fa: string }>> = {
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
const operationalRoutes: ReadonlyArray<{ readonly path: string; readonly icon: AppIconName; readonly en: string; readonly fa: string; readonly section: NavSection; readonly visible: (can: (permission: string) => boolean) => boolean }> = [
  { path: "/", icon: "overview", en: "Company dashboard", fa: "داشبورد عمومی شرکت", section: "home", visible: (can) => can("company.dashboard.read") },
  { path: "/dashboard", icon: "overview", en: "My dashboard", fa: "داشبورد من", section: "home", visible: () => true },
  // Daily Finance work.
  { path: "/finance/record-expense", icon: "coins", en: "Record expense", fa: "ثبت مصرف", section: "daily", visible: (can) => can("finance.expense.create") },
  { path: "/finance/transactions", icon: "reports-analytics", en: "Daily transactions", fa: "معاملات روزانه", section: "daily", visible: (can) => can("finance.expense.read") },
  { path: "/finance/treasury", icon: "coins", en: "Treasury", fa: "خزانه", section: "daily", visible: (can) => can("treasury.read") },
  // Reports.
  { path: "/finance/daily-report", icon: "reports-analytics", en: "Daily financial report", fa: "گزارش مالی روزانه", section: "reports", visible: (can) => can("finance.expense.read") },
  // Accounting (accountants and Finance managers).
  { path: "/finance/handoffs", icon: "finance", en: "Finance inbox", fa: "صندوق مالی", section: "accounting", visible: (can) => can("finance.report.operational.read") },
  { path: "/finance/general-ledger", icon: "reports-analytics", en: "General Ledger", fa: "دفتر کل", section: "accounting", visible: (can) => can("finance.report.operational.read") },
  { path: "/finance/accounts", icon: "finance", en: "Chart of Accounts", fa: "جدول حساب‌ها", section: "accounting", visible: (can) => can("finance.ledger-account.manage") || can("finance.ledger-account.review") || can("finance.report.operational.read") },
  { path: "/finance/calendar", icon: "reports-analytics", en: "Financial calendar", fa: "تقویم مالی", section: "accounting", visible: (can) => can("finance.calendar.manage") || can("finance.report.operational.read") },
  { path: "/finance/exchange-rates", icon: "coins", en: "Exchange rates", fa: "نرخ اسعار", section: "accounting", visible: (can) => can("finance.exchange-rate.record") || can("finance.report.operational.read") },
  { path: "/shareholders", icon: "finance", en: "Shareholder capital", fa: "سرمایه سهامداران", section: "accounting", visible: (can) => can("shareholder.capital-request.create") || can("shareholder.read") },
  { path: "/finance/reversals", icon: "finance", en: "Journal reversals", fa: "برگشت ژورنال‌ها", section: "accounting", visible: (can) => can("finance.reversal.request") || can("finance.reversal.approve") || can("finance.report.operational.read") },
  // Finance setup (Treasury accounts, expense types, accounting periods).
  { path: "/finance/setup", icon: "settings", en: "Finance setup", fa: "تنظیمات مالی", section: "setup", visible: (can) => can("treasury.operational-account.manage") || can("finance.expense-category.manage") || can("finance.period.manage") },
  // Company and administration. Company details are visible to every signed-in employee.
  { path: "/admin/company", icon: "building", en: "Company", fa: "شرکت", section: "company", visible: () => true },
  { path: "/admin/finance-workflows", icon: "shield", en: "Workflow approvals", fa: "تأیید جریان‌ها", section: "company", visible: (can) => can("admin.finance-workflow.manage") },
  { path: "/admin/users", icon: "human-resources", en: "Users", fa: "کاربران", section: "company", visible: (can) => can("admin.users.manage") },
  { path: "/admin/roles", icon: "shield", en: "Roles & permissions", fa: "نقش‌ها و صلاحیت‌ها", section: "company", visible: (can) => can("admin.roles.manage") || can("admin.users.manage") }
];

export function AppShell({ children }: AppShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const session = useSession();
  const [accountOpen, setAccountOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const { locale, toggleLocale } = useLocale();
  const shortSha = publicEnvironment.gitSha === "unknown" ? "unknown" : publicEnvironment.gitSha.slice(0, 12);
  const signedIn = session.status === "signed-in" && session.user !== null;
  const fa = locale === "fa";
  const visibleRoutes = signedIn ? operationalRoutes.filter((route) => route.visible(session.can)) : [];
  const normalizedQuery = query.trim().toLowerCase();
  const operationalSearchResults = normalizedQuery
    ? visibleRoutes.filter((route) => `${route.en} ${route.fa}`.toLowerCase().includes(normalizedQuery))
    : [];
  const demoSearchResults = normalizedQuery && !signedIn
    ? workspaceRoutes.filter((route) => route.label.toLowerCase().includes(normalizedQuery))
    : [];

  if (pathname === "/login") {
    return <main id="main-content" className="login-main" tabIndex={-1}>{children}</main>;
  }

  const signOut = async () => {
    setAccountOpen(false);
    await session.signOut();
    router.push("/login");
  };

  return (
    <div className="app-frame">
      <a className="skip-link" href="#main-content">{locale === "fa" ? "رفتن به محتوای اصلی" : "Skip to main content"}</a>
      <aside id="primary-sidebar" className="sidebar" data-open={menuOpen} aria-label="Primary navigation">
        <Link href="/" className="brand-lockup" aria-label="AL-BERUNIY Operating System home">
          <span className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 48 58" fill="none"><path d="M24 3v49M18 11v41M30 11v41M12 23v29M36 23v29M7 52h34M13 39l11-9 11 9M18 25l6-8 6 8"/><path d="M5 55h38"/></svg>
          </span>
          <span><strong>ALBERUNIY</strong><small>Developments</small></span>
        </Link>

        {signedIn ? (
          <nav className="navigation preview-navigation" aria-label={fa ? "عملیات" : "Operations"}>
            {visibleRoutes.map((route, index) => {
              const active = pathname === route.path || pathname.startsWith(`${route.path}/`);
              const heading = route.section !== "home" && visibleRoutes[index - 1]?.section !== route.section
                ? sectionHeadings[route.section] : null;
              return (
                <Fragment key={route.path}>
                  {heading ? <p className="navigation-heading">{fa ? heading.fa : heading.en}</p> : null}
                  <Link href={route.path} aria-current={active ? "page" : undefined} onClick={() => setMenuOpen(false)}>
                    <span className="nav-glyph" aria-hidden="true"><AppIcon name={route.icon} size={18} /></span>
                    <span>{fa ? route.fa : route.en}</span>
                  </Link>
                </Fragment>
              );
            })}
          </nav>
        ) : (
          <nav className="navigation" aria-label="Primary navigation">
            {workspaceRoutes.map((route) => {
              const active = pathname === route.path || (route.path !== "/" && pathname.startsWith(`${route.path}/`));
              return (
                <Link key={route.id} href={route.path} aria-current={active ? "page" : undefined} onClick={() => setMenuOpen(false)}>
                  <span className="nav-glyph" aria-hidden="true"><AppIcon name={route.id} size={18} /></span>
                  <span>{fa ? faLabels[route.id] : route.label}</span>
                </Link>
              );
            })}
            <Link href="/login" className="sign-in-link" onClick={() => setMenuOpen(false)}>
              <span className="nav-glyph" aria-hidden="true"><AppIcon name="key" size={18} /></span>
              <span>{fa ? "ورود کارمندان" : "Employee sign-in"}</span>
            </Link>
          </nav>
        )}
        <div className="sidebar-quote"><q>{locale === "fa" ? "ساختن فردای بهتر" : "Building Better Tomorrows"}</q><span /><small>AL-BERUNIY<br />DEVELOPMENTS</small></div>
        <div className="sidebar-boundary">
          <span className="boundary-dot" aria-hidden="true" />
          {signedIn
            ? <span><strong>{fa ? "عملیات" : "Operations"}</strong><small>{fa ? "دسترسی کنترل‌شده" : "Controlled access"}</small></span>
            : <span><strong>{fa ? "مرحله صفر" : "Stage 0"}</strong><small>{fa ? "بازبینی رابط کاربری" : "Interface review"}</small></span>}
          <span className="shell-badge">{signedIn ? "V1" : "DEMO"}</span>
        </div>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <button className="menu-button" type="button" aria-controls="primary-sidebar" aria-expanded={menuOpen} onClick={() => setMenuOpen((value) => !value)}>
            <AppIcon name="menu" size={21} /><span className="sr-only">Toggle navigation</span>
          </button>

          <div className="system-heading">
            <strong>{locale === "fa" ? "مرکز فرماندهی سازمانی البرونی" : "Al-Beruniy Enterprise Command Center"}</strong>
            <small>{locale === "fa" ? "مردم / مکان‌ها / پیشرفت / فردای روشن‌تر" : "People / Places / Progress / A brighter tomorrow"}</small>
          </div>

          <div className="workspace-search">
            <label className="sr-only" htmlFor="workspace-search">Search workspaces</label>
            <AppIcon name="search" size={18} />
            <input id="workspace-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={locale === "fa" ? "جستجوی پروژه‌ها، واحدها، گزارش‌ها..." : "Search projects, units, clients, reports..."} autoComplete="off" />
            {operationalSearchResults.length > 0 || demoSearchResults.length > 0 ? (
              <div className="search-results" role="navigation" aria-label="Workspace search results">
                {signedIn
                  ? operationalSearchResults.map((route) => <Link href={route.path} key={route.path} onClick={() => setQuery("")}><AppIcon name={route.icon} size={16} /><span>{fa ? route.fa : route.en}</span></Link>)
                  : demoSearchResults.map((route) => <Link href={route.path} key={route.id} onClick={() => setQuery("")}><AppIcon name={route.id} size={16} /><span>{fa ? faLabels[route.id] : route.label}</span></Link>)}
              </div>
            ) : null}
          </div>

          <div className="topbar-actions">
            <div className="notifications-control">
              <button type="button" className="notification-button" aria-label="Notifications" aria-expanded={notificationsOpen} onClick={() => setNotificationsOpen((value) => !value)}><AppIcon name="bell" size={19} /><span aria-hidden="true" /></button>
              {notificationsOpen ? <div className="notification-popover" role="status"><strong>{locale === "fa" ? "اعلان‌ها متصل نیست" : "Notifications are not connected"}</strong><p>{locale === "fa" ? "پس از اتصال خدمات، هشدارهای معتبر اینجا نمایش داده می‌شود." : "Verified operational alerts will appear here after services are connected."}</p></div> : null}
            </div>
            <button type="button" className="language-toggle" onClick={toggleLocale} aria-label={locale === "en" ? "Switch to Dari" : "Switch to English"}>
              <span className={locale === "en" ? "active" : ""}>EN</span><i aria-hidden="true" /><span className={locale === "fa" ? "active" : ""}>دری</span>
            </button>
            {signedIn && session.user ? (
              <div className="account-control">
                <button type="button" className="review-context" aria-expanded={accountOpen} aria-haspopup="menu" onClick={() => setAccountOpen((value) => !value)}>
                  <span aria-hidden="true">{session.user.displayName.split(" ").map((part) => part[0]).slice(-2).join("")}</span>
                  <div><strong>{session.user.displayName}</strong><small>{session.user.jobTitle ?? session.user.legalEntityName}</small></div>
                </button>
                {accountOpen ? (
                  <div className="account-menu" role="menu">
                    <p><small>{fa ? "شرکت" : "Company"}</small><strong>{session.user.legalEntityName}</strong></p>
                    <p><small>{fa ? "نام کاربری" : "Username"}</small><strong dir="ltr">{session.user.loginIdentifier}</strong></p>
                    <Link role="menuitem" href="/login?change=1" onClick={() => setAccountOpen(false)}>{fa ? "تغییر رمز من" : "Change my password"}</Link>
                    <button role="menuitem" type="button" onClick={() => void signOut()}>{fa ? "خروج" : "Sign out"}</button>
                  </div>
                ) : null}
              </div>
            ) : session.status === "signed-out" ? (
              <Link href="/login" className="review-context" aria-label={fa ? "ورود کارمندان" : "Employee sign-in"}>
                <span aria-hidden="true"><AppIcon name="key" size={15} /></span>
                <div><strong>{fa ? "ورود" : "Sign in"}</strong><small>{fa ? "حساب کارمند" : "Employee account"}</small></div>
              </Link>
            ) : (
              <Link href="/settings" className="review-context" aria-label="Stage 0 review session">
                <span aria-hidden="true">UI</span>
                <div><strong>{fa ? "کاربر نمایشی" : "Demo Executive"}</strong><small>{fa ? "بازبینی مرحله صفر" : "Stage 0 review"}</small></div>
              </Link>
            )}
            <KabulClock />
          </div>
        </header>

        <main id="main-content" className="main-content" tabIndex={-1}>{children}</main>
        <footer className="app-footer">
          <span>{publicEnvironment.environment}</span>
          <span>Build {shortSha}</span>
          <span>{signedIn
            ? (fa ? "دسترسی کنترل‌شده · هر کار در سرور و پایگاه داده بررسی می‌شود" : "Controlled access · every action is checked by the server and the database")
            : (fa ? "هیچ سرویس عملیاتی متصل نیست" : "No operational services connected")}</span>
        </footer>
      </div>
      {menuOpen ? <button className="mobile-scrim" type="button" aria-label="Close navigation" onClick={() => setMenuOpen(false)} /> : null}
    </div>
  );
}
