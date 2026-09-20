import type { ReactNode } from "react";

export interface PageHeaderProps {
  readonly eyebrow?: string;
  readonly title: string;
  readonly description: string;
}

export function PageHeader({ eyebrow = "Operational workspace", title, description }: PageHeaderProps) {
  return (
    <header className="page-header">
      <p className="eyebrow">{eyebrow}</p>
      <h1>{title}</h1>
      <p className="page-description">{description}</p>
    </header>
  );
}

export interface SurfaceProps {
  readonly title: string;
  readonly eyebrow?: string;
  readonly children: ReactNode;
}

export function Surface({ title, eyebrow, children }: SurfaceProps) {
  return (
    <section className="surface">
      <header className="surface-header">
        {eyebrow ? <p className="surface-eyebrow">{eyebrow}</p> : null}
        <h2>{title}</h2>
      </header>
      {children}
    </section>
  );
}

export interface StatePanelProps {
  readonly kind: "empty" | "loading" | "error" | "no-permission";
  readonly title: string;
  readonly description: string;
  readonly children?: ReactNode;
}

export function StatePanel({ kind, title, description, children }: StatePanelProps) {
  return (
    <div className={`state-panel state-panel--${kind}`} role={kind === "error" ? "alert" : "status"}>
      <span className="state-panel-icon" aria-hidden="true">{kind === "loading" ? "···" : kind === "error" ? "!" : kind === "no-permission" ? "×" : "○"}</span>
      <div>
        <h3>{title}</h3>
        <p>{description}</p>
        {children}
      </div>
    </div>
  );
}

export interface StatusBadgeProps {
  readonly children: ReactNode;
  readonly tone?: "neutral" | "warning" | "success";
}

export function StatusBadge({ children, tone = "neutral" }: StatusBadgeProps) {
  return <span className={`status-badge status-badge--${tone}`}>{children}</span>;
}
