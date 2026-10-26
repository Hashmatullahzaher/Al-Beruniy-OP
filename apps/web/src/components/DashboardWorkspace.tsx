"use client";

import { RETIRED_PERMISSION_CODES } from "@abos/contracts";
import Link from "next/link";

import { AppIcon } from "@/components/AppIcon";
import { useLocale } from "@/components/LocaleProvider";
import { useSession } from "@/components/SessionProvider";
import { StageZeroPageHeader } from "@/components/StageZeroWorkspace";
import { CATEGORY_COPY, PERMISSION_COPY, type Copy } from "@/lib/access-copy";
import { operationalRoutes, sectionHeadings, type NavSection } from "@/lib/operational-routes";

/**
 * My dashboard: who is signed in, the roles they hold, and the pages their permissions open.
 * Everything comes from the session the server rebuilt for this request; nothing here calls a
 * Finance or Treasury endpoint. Balances and figures arrive with a later slice.
 */
export function DashboardWorkspace() {
  const { locale } = useLocale();
  const fa = locale === "fa";
  const t = (copy: Copy) => copy[locale];
  const session = useSession();

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
  const sections = (Object.keys(sectionHeadings) as Exclude<NavSection, "home">[])
    .map((section) => ({ section, routes: operationalRoutes.filter((route) => route.section === section && route.visible(session.can)) }))
    .filter((group) => group.routes.length > 0);
  const home = operationalRoutes.filter((route) => route.section === "home" && route.path !== "/dashboard" && route.visible(session.can));
  // Permissions retired with the preview lane (0041) still exist as grants but open nothing; they are not shown.
  const held = user.permissions.filter((code) => !RETIRED_PERMISSION_CODES.has(code));
  const grouped = Object.keys(CATEGORY_COPY).map((category) => ({
    category,
    codes: held.filter((code) => categoryOf(code) === category)
  })).filter((group) => group.codes.length > 0);
  const roles = user.roles.length > 0 ? user.roles.join(fa ? "، " : ", ") : (fa ? "هنوز نقشی تعیین نشده است." : "No role assigned yet.");

  return (
    <div className="module-workspace dashboard-workspace">
      <StageZeroPageHeader icon="overview"
        eyebrow={{ en: user.legalEntityName, fa: user.legalEntityName }}
        title={{ en: `Welcome, ${user.displayName}`, fa: `خوش آمدید، ${user.displayName}` }}
        description={{ en: "Your roles, your access and the pages you can work in, read from the system when this page opened.", fa: "نقش‌ها، دسترسی و صفحه‌هایی که می‌توانید در آن‌ها کار کنید؛ هنگام باز شدن این صفحه از سیستم خوانده شده است." }} />

      <section className="module-content-card dashboard-profile" aria-label={fa ? "حساب شما" : "Your account"}>
        <div className="module-card-heading"><div><p>{fa ? "حساب شما" : "YOUR ACCOUNT"}</p><h2>{user.displayName}</h2></div></div>
        <dl>
          <dt>{fa ? "نام کاربری" : "Username"}</dt><dd dir="ltr">{user.loginIdentifier}</dd>
          {user.jobTitle ? <><dt>{fa ? "سمت" : "Job title"}</dt><dd>{user.jobTitle}</dd></> : null}
          <dt>{fa ? "نقش‌ها" : "Roles"}</dt><dd data-testid="dashboard-roles">{roles}</dd>
          <dt>{fa ? "شرکت" : "Company"}</dt><dd>{user.legalEntityName}</dd>
        </dl>
      </section>

      {home.length > 0 || sections.length > 0 ? (
        <section className="module-content-card" aria-label={fa ? "صفحه‌های شما" : "Your pages"}>
          <div className="module-card-heading"><div><p>{fa ? "صفحه‌های شما" : "YOUR PAGES"}</p><h2>{fa ? "جایی که می‌توانید کار کنید" : "Where you can work"}</h2></div></div>
          {home.length > 0 ? <div className="dashboard-actions">{home.map((route) => <RouteLink key={route.path} route={route} fa={fa} />)}</div> : null}
          {sections.map((group) => (
            <div key={group.section}>
              <h3 className="dashboard-section-title">{t(sectionHeadings[group.section])}</h3>
              <div className="dashboard-actions">{group.routes.map((route) => <RouteLink key={route.path} route={route} fa={fa} />)}</div>
            </div>
          ))}
        </section>
      ) : (
        <p className="treasury-placeholder">{fa ? "هنوز کاری برای شما تعیین نشده است." : "No work has been assigned to you yet."}</p>
      )}

      <section className="module-content-card dashboard-access">
        <div className="module-card-heading"><div><p>{fa ? "دسترسی شما" : "YOUR ACCESS"}</p><h2>{fa ? "آنچه اجازه دارید انجام دهید" : "What you are allowed to do"}</h2></div></div>
        {grouped.length === 0 ? <p className="treasury-placeholder">{fa ? "هنوز صلاحیتی به شما داده نشده است." : "No permission has been given to you yet."}</p> : null}
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

function RouteLink({ route, fa }: { readonly route: (typeof operationalRoutes)[number]; readonly fa: boolean }) {
  return (
    <Link href={route.path} className="dashboard-action">
      <span aria-hidden="true"><AppIcon name={route.icon} size={20} /></span>
      <div><strong>{fa ? route.fa : route.en}</strong></div>
    </Link>
  );
}

function categoryOf(code: string): string {
  if (code.startsWith("admin.")) return "ADMINISTRATION";
  if (code.startsWith("shareholder.")) return "SHAREHOLDER";
  if (code.startsWith("treasury.")) return "TREASURY";
  if (code.startsWith("company.")) return "COMPANY";
  return "FINANCE";
}
