"use client";

import type { ReactNode } from "react";

import { AppIcon, type AppIconName } from "@/components/AppIcon";
import { useLocale } from "@/components/LocaleProvider";

interface LocalizedCopy {
  readonly en: string;
  readonly fa: string;
}

export function localized(copy: LocalizedCopy, locale: "en" | "fa"): string {
  return locale === "fa" ? copy.fa : copy.en;
}

export function StageZeroPageHeader({
  eyebrow,
  title,
  description,
  icon,
  children
}: Readonly<{
  eyebrow: LocalizedCopy;
  title: LocalizedCopy;
  description: LocalizedCopy;
  icon: AppIconName;
  children?: ReactNode;
}>) {
  const { locale } = useLocale();

  return (
    <header className="module-page-heading">
      <span className="module-heading-icon" aria-hidden="true"><AppIcon name={icon} size={23} /></span>
      <div>
        <p>{localized(eyebrow, locale)}</p>
        <h1>{localized(title, locale)}</h1>
        <span>{localized(description, locale)}</span>
      </div>
      {children ? <div className="module-heading-actions">{children}</div> : null}
    </header>
  );
}

export function StageZeroContextBar({ section }: Readonly<{ section: LocalizedCopy }>) {
  const { locale } = useLocale();

  return (
    <section className="module-context-bar" aria-label={localized({ en: "Current project context", fa: "زمینه پروژه فعلی" }, locale)}>
      <div className="context-project-mark" aria-hidden="true"><AppIcon name="building" size={21} /></div>
      <div className="context-project-copy">
        <small>{localized({ en: "Current project", fa: "پروژه فعلی" }, locale)}</small>
        <strong>Mazar Mall</strong>
        <span>Mazar-e-Sharif · {localized({ en: "Presentation fixture", fa: "نمونه نمایشی" }, locale)}</span>
      </div>
      <div className="context-divider" />
      <div className="context-section-copy">
        <small>{localized({ en: "Workspace", fa: "فضای کاری" }, locale)}</small>
        <strong>{localized(section, locale)}</strong>
      </div>
      <div className="context-data-state">
        <span className="status-dot" aria-hidden="true" />
        <div><small>{localized({ en: "Data source", fa: "منبع داده" }, locale)}</small><strong>{localized({ en: "Services not connected", fa: "خدمات متصل نیست" }, locale)}</strong></div>
      </div>
      <span className="demo-data-badge">DEMO DATA</span>
    </section>
  );
}

export function WorkspaceTabs({
  label,
  tabs,
  active,
  onChange
}: Readonly<{
  label: string;
  tabs: ReadonlyArray<{ id: string; label: LocalizedCopy; count?: number }>;
  active: string;
  onChange: (id: string) => void;
}>) {
  const { locale } = useLocale();

  return (
    <div className="workspace-tabs" role="tablist" aria-label={label}>
      {tabs.map((tab) => (
        <button
          type="button"
          role="tab"
          aria-selected={active === tab.id}
          className={active === tab.id ? "active" : undefined}
          key={tab.id}
          onClick={() => onChange(tab.id)}
        >
          {localized(tab.label, locale)}{typeof tab.count === "number" ? <span>{tab.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function WorkspaceEmptyState({ icon, title, description }: Readonly<{ icon: AppIconName; title: LocalizedCopy; description: LocalizedCopy }>) {
  const { locale } = useLocale();
  return (
    <div className="workspace-empty-state" role="status">
      <span aria-hidden="true"><AppIcon name={icon} size={27} /></span>
      <h2>{localized(title, locale)}</h2>
      <p>{localized(description, locale)}</p>
      <em>{localized({ en: "Stage 0 · No operational records", fa: "مرحله صفر · بدون سوابق عملیاتی" }, locale)}</em>
    </div>
  );
}
