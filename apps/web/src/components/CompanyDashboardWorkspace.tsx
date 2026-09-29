"use client";

import type { CompanyDashboardSummary } from "@abos/contracts";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { api } from "@/components/AdminUsersWorkspace";
import { AppIcon, type AppIconName } from "@/components/AppIcon";
import { useLocale } from "@/components/LocaleProvider";
import { StageZeroPageHeader } from "@/components/StageZeroWorkspace";
import type { Copy } from "@/lib/access-copy";

/**
 * Every company KPI and its authoritative source. A figure is shown only when its source exists in
 * V1 and has been read through the protected read model; otherwise the card says so. No KPI has a
 * fallback or illustrative value.
 */
interface KpiDefinition {
  readonly key: string;
  readonly icon: AppIconName;
  readonly label: Copy;
  readonly source: Copy;
  readonly value?: (summary: CompanyDashboardSummary) => { readonly figure: string; readonly note: Copy };
}

const KPIS: readonly KpiDefinition[] = [
  { key: "projects", icon: "projects", label: { en: "Active projects", fa: "پروژه‌های فعال" },
    source: { en: "Projects register", fa: "ثبت پروژه‌ها" },
    value: (summary) => ({
      figure: String(summary.projects.active),
      note: summary.projects.total === 0
        ? { en: "No data recorded yet", fa: "هنوز داده‌ای ثبت نشده" }
        : { en: `${summary.projects.total} recorded in total`, fa: `در مجموع ${summary.projects.total} ثبت شده` }
    }) },
  { key: "units-sold", icon: "key", label: { en: "Units sold", fa: "واحدهای فروخته‌شده" },
    source: { en: "Sales and inventory", fa: "فروش و موجودی" } },
  { key: "units-available", icon: "overview", label: { en: "Available units", fa: "واحدهای موجود" },
    source: { en: "Inventory", fa: "موجودی" } },
  { key: "sales-value", icon: "sales-crm", label: { en: "Total sales value", fa: "ارزش مجموع فروش" },
    source: { en: "Sales contracts", fa: "قراردادهای فروش" } },
  { key: "cash-collected", icon: "coins", label: { en: "Cash collected", fa: "پول دریافت‌شده" },
    source: { en: "Customer receipts", fa: "دریافت‌های مشتریان" } },
  { key: "overdue", icon: "alert", label: { en: "Overdue installments", fa: "اقساط معوق" },
    source: { en: "Customer installments", fa: "اقساط مشتریان" } },
  { key: "construction", icon: "construction", label: { en: "Construction progress", fa: "پیشرفت ساخت‌وساز" },
    source: { en: "Construction", fa: "ساخت‌وساز" } },
  { key: "procurement", icon: "procurement", label: { en: "Procurement commitments", fa: "تعهدات تدارکات" },
    source: { en: "Procurement", fa: "تدارکات" } },
  { key: "team", icon: "human-resources", label: { en: "Team members", fa: "اعضای تیم" },
    source: { en: "Human resources", fa: "منابع بشری" } },
  { key: "profit-loss", icon: "chart", label: { en: "Profit / loss", fa: "سود / زیان" },
    source: { en: "General Ledger reports", fa: "گزارش‌های دفتر کل" } }
];

export function CompanyDashboardWorkspace() {
  const { locale } = useLocale();
  const fa = locale === "fa";
  const router = useRouter();
  const [summary, setSummary] = useState<CompanyDashboardSummary | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let current = true;
    void api<CompanyDashboardSummary>("/api/v1/company/dashboard").then((result) => {
      if (!current) return;
      if (result.ok) { setSummary(result.data); return; }
      // Access can change after the page was served: follow the server's decision at once.
      if (result.status === 401) { router.replace("/login"); return; }
      if (result.status === 403) { router.replace("/dashboard"); return; }
      setFailed(true);
    });
    return () => { current = false; };
  }, [router]);

  return (
    <div className="module-workspace company-dashboard">
      <StageZeroPageHeader icon="overview"
        eyebrow={{ en: summary?.legalEntityName ?? "Company", fa: summary?.legalEntityName ?? "شرکت" }}
        title={{ en: "Company dashboard", fa: "داشبورد عمومی شرکت" }}
        description={{
          en: "Summary figures from the modules connected so far. A module that is not connected yet shows no figure.",
          fa: "ارقام خلاصه از بخش‌هایی که تا کنون وصل شده‌اند. بخشی که هنوز وصل نشده هیچ رقمی نشان نمی‌دهد."
        }} />

      {failed ? <div className="treasury-message error" role="alert"><AppIcon name="alert" size={16} /><span>{fa ? "داشبورد بارگذاری نشد." : "The dashboard could not be loaded."}</span></div> : null}

      <section className="metric-grid company-kpis" aria-label={fa ? "ارقام شرکت" : "Company figures"}>
        {KPIS.map((kpi) => {
          const connected = kpi.value !== undefined;
          const shown = summary !== null && kpi.value !== undefined ? kpi.value(summary) : null;
          return (
            <article key={kpi.key} className={`metric-card company-kpi ${connected ? "connected" : "not-connected"}`} data-kpi={kpi.key}>
              <span className="metric-icon"><AppIcon name={kpi.icon} size={18} /></span>
              <div>
                <h3>{kpi.label[locale]}</h3>
                {connected ? (
                  shown ? <>
                    <p className="company-kpi-figure" dir="ltr">{shown.figure}</p>
                    <p>{shown.note[locale]}</p>
                  </> : <p className="company-kpi-loading">{fa ? "در حال بارگذاری…" : "Loading…"}</p>
                ) : <p className="company-kpi-state">{fa ? "هنوز وصل نشده" : "Not connected yet"}</p>}
                <p className="company-kpi-source">{fa ? "منبع: " : "Source: "}{kpi.source[locale]}</p>
              </div>
            </article>
          );
        })}
      </section>
      <p className="admin-hint">{fa
        ? "هیچ رقمی تخمین زده یا نمایشی نیست. هر بخش پس از راه‌اندازی در V1 ارقام واقعی خود را نشان می‌دهد."
        : "No figure here is estimated or illustrative. Each module shows its real figures once it is running in V1."}</p>
    </div>
  );
}
