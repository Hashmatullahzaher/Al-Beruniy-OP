"use client";

import { workspaceRoutes } from "@abos/contracts";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";

import { AppIcon } from "@/components/AppIcon";
import { KabulClock } from "@/components/KabulClock";
import { useLocale } from "@/components/LocaleProvider";
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

export function AppShell({ children }: AppShellProps) {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const { locale, toggleLocale } = useLocale();
  const shortSha = publicEnvironment.gitSha === "unknown" ? "unknown" : publicEnvironment.gitSha.slice(0, 12);
  const searchResults = query.trim() ? workspaceRoutes.filter((route) => route.label.toLowerCase().includes(query.trim().toLowerCase())) : [];

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

        <nav className="navigation" aria-label="Primary navigation">
          {workspaceRoutes.map((route) => {
            const active = pathname === route.path || (route.path !== "/" && pathname.startsWith(`${route.path}/`));
            return (
              <Link key={route.id} href={route.path} aria-current={active ? "page" : undefined} onClick={() => setMenuOpen(false)}>
                <span className="nav-glyph" aria-hidden="true"><AppIcon name={route.id} size={18} /></span>
                <span>{locale === "fa" ? faLabels[route.id] : route.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="sidebar-quote"><q>{locale === "fa" ? "ساختن فردای بهتر" : "Building Better Tomorrows"}</q><span /><small>AL-BERUNIY<br />DEVELOPMENTS</small></div>
        <div className="sidebar-boundary">
          <span className="boundary-dot" aria-hidden="true" />
          <span><strong>{locale === "fa" ? "مرحله صفر" : "Stage 0"}</strong><small>{locale === "fa" ? "بازبینی رابط کاربری" : "Interface review"}</small></span>
          <span className="shell-badge">DEMO</span>
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
            {searchResults.length > 0 ? (
              <div className="search-results" role="navigation" aria-label="Workspace search results">
                {searchResults.map((route) => <Link href={route.path} key={route.id} onClick={() => setQuery("")}><AppIcon name={route.id} size={16} /><span>{route.label}</span></Link>)}
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
            <Link href="/settings" className="review-context" aria-label="Stage 0 review session">
              <span aria-hidden="true">UI</span>
              <div><strong>{locale === "fa" ? "کاربر نمایشی" : "Demo Executive"}</strong><small>{locale === "fa" ? "بازبینی مرحله صفر" : "Stage 0 review"}</small></div>
            </Link>
            <KabulClock />
          </div>
        </header>

        <main id="main-content" className="main-content" tabIndex={-1}>{children}</main>
        <footer className="app-footer">
          <span>{publicEnvironment.environment}</span>
          <span>Build {shortSha}</span>
          <span>{locale === "fa" ? "هیچ سرویس عملیاتی متصل نیست" : "No operational services connected"}</span>
        </footer>
      </div>
      {menuOpen ? <button className="mobile-scrim" type="button" aria-label="Close navigation" onClick={() => setMenuOpen(false)} /> : null}
    </div>
  );
}
