import type { WorkspaceModuleId } from "@abos/contracts";
import type { ReactNode } from "react";

export type AppIconName = WorkspaceModuleId | "menu" | "sparkles" | "building" | "chevron" | "shield" | "database" | "chart" | "arrow" | "search" | "bell" | "alert" | "pin" | "key" | "coins";

export function AppIcon({ name, size = 20 }: Readonly<{ name: AppIconName; size?: number }>) {
  const common = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  const paths: Record<AppIconName, ReactNode> = {
    overview: <><path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10.5V20h13v-9.5"/><path d="M9.5 20v-6h5v6"/></>,
    projects: <><rect x="4" y="3" width="6" height="18" rx="1"/><rect x="14" y="7" width="6" height="14" rx="1"/><path d="M7 7h.01M7 11h.01M7 15h.01M17 11h.01M17 15h.01"/></>,
    "sales-crm": <><circle cx="9" cy="8" r="3"/><path d="M3.5 20a5.5 5.5 0 0 1 11 0M16 7h5M18.5 4.5v5"/></>,
    finance: <><path d="M4 20h16M5 17h14M7 17V9M12 17V9M17 17V9M4 7l8-4 8 4z"/></>,
    construction: <><path d="M4 20h16M7 20V8h10v12M9 5h6M10 8V4h4v4M9.5 12h1M13.5 12h1M9.5 16h1M13.5 16h1"/></>,
    procurement: <><path d="M3 5h2l2.2 9h9.8l2-6H7"/><circle cx="9" cy="19" r="1.5"/><circle cx="17" cy="19" r="1.5"/></>,
    "human-resources": <><circle cx="9" cy="8" r="3"/><path d="M3.5 20a5.5 5.5 0 0 1 11 0M16 11a3 3 0 0 0 0-6M17 14a5 5 0 0 1 4 4.9"/></>,
    "reports-analytics": <><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></>,
    "ai-insights": <><path d="m12 3 1.4 4.1L17.5 8.5l-4.1 1.4L12 14l-1.4-4.1-4.1-1.4 4.1-1.4zM18.5 14l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/></>,
    documents: <><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h5M9 13h6M9 17h6"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6 1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1z"/></>,
    menu: <path d="M4 7h16M4 12h16M4 17h16"/>,
    sparkles: <><path d="m12 3 1.4 4.1L17.5 8.5l-4.1 1.4L12 14l-1.4-4.1-4.1-1.4 4.1-1.4z"/><path d="m18.5 15 .7 2 .8.7-2 .7-.7 2-.7-2-2-.7 2-.7z"/></>,
    building: <><rect x="5" y="3" width="14" height="18" rx="1"/><path d="M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2M10 21v-3h4v3"/></>,
    chevron: <path d="m9 18 6-6-6-6"/>,
    shield: <><path d="M12 3 5 6v5c0 4.5 2.9 8 7 10 4.1-2 7-5.5 7-10V6z"/><path d="m9 12 2 2 4-4"/></>,
    database: <><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/></>,
    chart: <><path d="M4 19V9M10 19V5M16 19v-7M22 19H2"/><path d="m4 8 6-4 6 7 5-5"/></>,
    arrow: <><path d="M5 12h14M14 7l5 5-5 5"/></>,
    search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></>,
    bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></>,
    alert: <><path d="M12 3 2.8 20h18.4z"/><path d="M12 9v4M12 17h.01"/></>,
    pin: <><path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0z"/><circle cx="12" cy="10" r="2.5"/></>,
    key: <><circle cx="8" cy="12" r="4"/><path d="m12 12 9-9M17 7l2 2M14 10l2 2"/></>,
    coins: <><ellipse cx="9" cy="7" rx="6" ry="3"/><path d="M3 7v4c0 1.7 2.7 3 6 3 1.1 0 2.1-.1 3-.4M3 11v4c0 1.7 2.7 3 6 3M15 10c3.3 0 6 1.3 6 3s-2.7 3-6 3-6-1.3-6-3 2.7-3 6-3zM9 13v4c0 1.7 2.7 3 6 3s6-1.3 6-3v-4"/></>
  };

  return <svg {...common}>{paths[name]}</svg>;
}
