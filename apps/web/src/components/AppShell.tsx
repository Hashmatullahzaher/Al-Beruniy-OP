"use client";

import { emptyWorkspaceContext, workspaceRoutes } from "@abos/contracts";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

import { publicEnvironment } from "@/lib/env";

interface AppShellProps {
  readonly children: ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const [direction, setDirection] = useState<"ltr" | "rtl">("ltr");

  useEffect(() => {
    document.documentElement.dir = direction;
    document.documentElement.lang = direction === "rtl" ? "fa" : "en";
  }, [direction]);

  const shortSha = publicEnvironment.gitSha === "unknown" ? "unknown" : publicEnvironment.gitSha.slice(0, 12);

  return (
    <div className="app-frame" data-direction={direction}>
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <aside id="primary-sidebar" className="sidebar" data-open={menuOpen} aria-label="Primary navigation">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">AB</span>
          <span><strong>AL-BERUNIY</strong><small>Operating System</small></span>
        </div>
        <nav className="navigation" aria-label="Primary navigation">
          {(["operate", "manage", "govern"] as const).map((group) => (
            <div className="nav-group" key={group}>
              <p>{group}</p>
              {workspaceRoutes.filter((route) => route.group === group).map((route) => {
                const active = pathname === route.path;
                return (
                  <Link key={route.id} href={route.path} aria-current={active ? "page" : undefined} onClick={() => setMenuOpen(false)}>
                    <span className="nav-glyph" aria-hidden="true">{route.shortLabel}</span>
                    <span>{route.label}</span>
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="sidebar-boundary">
          <span className="boundary-dot" aria-hidden="true" />
          <span><strong>Stage 0</strong><small>Foundation only</small></span>
        </div>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <button className="menu-button" type="button" aria-controls="primary-sidebar" aria-expanded={menuOpen} onClick={() => setMenuOpen((value) => !value)}>
            <span aria-hidden="true">☰</span><span className="sr-only">Toggle navigation</span>
          </button>
          <div className="context-summary" aria-label="Active workspace context">
            <span><small>Company</small><strong>{emptyWorkspaceContext.company.status === "unavailable" ? "Not connected" : "Selected"}</strong></span>
            <span><small>Project</small><strong>{emptyWorkspaceContext.project.status === "unavailable" ? "Not connected" : "Selected"}</strong></span>
          </div>
          <div className="topbar-actions">
            <Link href="/ai-insights" className="ai-entry"><span aria-hidden="true">✦</span> AI Insights <em>Shell</em></Link>
            <button type="button" className="direction-toggle" onClick={() => setDirection((value) => value === "ltr" ? "rtl" : "ltr")} aria-label="Toggle English and Dari layout direction">
              {direction === "ltr" ? "دری" : "English"}
            </button>
          </div>
        </header>

        <main id="main-content" className="main-content" tabIndex={-1}>{children}</main>
        <footer className="app-footer">
          <span>{publicEnvironment.environment}</span>
          <span>Build {shortSha}</span>
          <span>No operational services connected</span>
        </footer>
      </div>
      {menuOpen ? <button className="mobile-scrim" type="button" aria-label="Close navigation" onClick={() => setMenuOpen(false)} /> : null}
    </div>
  );
}
