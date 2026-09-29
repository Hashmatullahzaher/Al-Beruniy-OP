"use client";

import type { CompanyDashboardSummary } from "@abos/contracts";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { api } from "@/components/AdminUsersWorkspace";
import { AppIcon, type AppIconName } from "@/components/AppIcon";
import { useLocale } from "@/components/LocaleProvider";
import type { Copy } from "@/lib/access-copy";

/**
 * The approved company dashboard layout, fed only by the protected read model
 * (abos.company_dashboard_summary, migration 0030). A figure appears only when its source exists in
 * V1; every other card, chart and panel keeps its place and says honestly that it is not connected
 * yet. There are no fallback, sample or illustrative values anywhere on this page.
 */

const NOT_CONNECTED: Copy = { en: "Not connected yet", fa: "هنوز وصل نشده" };
const NO_DATA: Copy = { en: "No data recorded yet", fa: "هنوز داده‌ای ثبت نشده" };
const MONTHS: Readonly<Record<"en" | "fa", readonly string[]>> = {
  en: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
  fa: ["جنو", "فبر", "مارچ", "اپر", "می", "جون", "جول", "اگس", "سپت", "اکت", "نوم", "دسم"]
};

interface KpiCard {
  readonly key: string;
  readonly icon: AppIconName;
  readonly tone: string;
  readonly label: Copy;
  readonly source: Copy;
  /** Present only for KPIs with a real V1 source. */
  readonly read?: (summary: CompanyDashboardSummary) => { readonly figure: string; readonly note: Copy };
}

const kpiCards: readonly KpiCard[] = [
  { key: "projects", icon: "projects", tone: "cyan", label: { en: "Active Projects", fa: "پروژه‌های فعال" },
    source: { en: "Projects register", fa: "ثبت پروژه‌ها" },
    read: (summary) => ({
      figure: String(summary.projects.active),
      note: summary.projects.total === 0 ? NO_DATA
        : { en: `${summary.projects.total} recorded in total`, fa: `در مجموع ${summary.projects.total} ثبت شده` }
    }) },
  { key: "units-sold", icon: "key", tone: "gold", label: { en: "Units Sold", fa: "واحدهای فروخته‌شده" },
    source: { en: "Sales and inventory", fa: "فروش و موجودی" } },
  { key: "units-available", icon: "overview", tone: "blue", label: { en: "Available Units", fa: "واحدهای موجود" },
    source: { en: "Inventory", fa: "موجودی" } },
  { key: "cash-collected", icon: "coins", tone: "gold", label: { en: "Cash Collected", fa: "پول دریافت‌شده" },
    source: { en: "Customer receipts", fa: "دریافت‌های مشتریان" } },
  { key: "construction", icon: "reports-analytics", tone: "cyan", label: { en: "Construction Progress", fa: "پیشرفت ساخت‌وساز" },
    source: { en: "Construction", fa: "ساخت‌وساز" } },
  { key: "overdue", icon: "alert", tone: "danger", label: { en: "Overdue Installments", fa: "اقساط معوق" },
    source: { en: "Customer installments", fa: "اقساط مشتریان" } },
  { key: "procurement", icon: "procurement", tone: "cyan", label: { en: "Procurement Commitments", fa: "تعهدات تدارکات" },
    source: { en: "Procurement", fa: "تدارکات" } },
  { key: "profit-loss", icon: "chart", tone: "cyan", label: { en: "Profit / Loss", fa: "سود / زیان" },
    source: { en: "General Ledger reports", fa: "گزارش‌های دفتر کل" } }
];

const moduleCards: readonly { readonly key: string; readonly icon: AppIconName; readonly tone: string; readonly name: Copy; readonly source: Copy }[] = [
  { key: "finance", icon: "finance", tone: "green", name: { en: "Finance", fa: "مالی" }, source: { en: "Finance reporting", fa: "گزارش‌دهی مالی" } },
  { key: "sales", icon: "sales-crm", tone: "blue", name: { en: "Sales & CRM", fa: "فروش و مشتریان" }, source: { en: "Sales contracts", fa: "قراردادهای فروش" } },
  { key: "construction", icon: "construction", tone: "gold", name: { en: "Construction", fa: "ساخت‌وساز" }, source: { en: "Construction", fa: "ساخت‌وساز" } },
  { key: "procurement", icon: "procurement", tone: "cyan", name: { en: "Procurement", fa: "تدارکات" }, source: { en: "Procurement", fa: "تدارکات" } },
  { key: "hr", icon: "human-resources", tone: "blue", name: { en: "Human Resources", fa: "منابع بشری" }, source: { en: "Human resources", fa: "منابع بشری" } }
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

  const t = (copy: Copy) => copy[locale];
  const badge = <span className="panel-state">{t(NOT_CONNECTED)}</span>;
  const emptyChart = (source: Copy) => (
    <div className="chart-empty" role="status">
      <strong>{t(NOT_CONNECTED)}</strong>
      <small>{fa ? `این نمودار پس از راه‌اندازی «${source.fa}» ارقام واقعی نشان می‌دهد.` : `This chart shows real figures once ${source.en} is running.`}</small>
    </div>
  );

  return (
    <div className="reference-dashboard company-dashboard">
      <h1 className="sr-only">{fa ? "داشبورد عمومی شرکت" : "Company dashboard"}</h1>

      <section className="reference-hero" aria-labelledby="reference-hero-title">
        <Image src="/assets/al-beruniy-background.jpg" alt="Architectural rendering of Mazar Mall and the Al-Beruniy district" fill loading="eager" sizes="(max-width: 760px) 100vw, 90vw" />
        <div className="reference-hero-shade" />
        <div className="reference-hero-copy">
          <div className="hero-label-row"><span>{fa ? "داشبورد عمومی شرکت" : "Company dashboard"}</span><em>{summary?.legalEntityName ?? (fa ? "شرکت" : "Company")}</em></div>
          <h2 id="reference-hero-title">{fa ? "مزار مال و ناحیه البرونی" : <>Mazar Mall &amp;<br />Al-Beruniy District</>}</h2>
          <p>{fa ? "زندگی مدرن، جوامع پویا." : "Modern Living. Thriving Communities."}</p>
          <i aria-hidden="true" />
          <div className="hero-feature-row">
            <span><AppIcon name="pin" size={21} /><b>{fa ? "موقعیت ممتاز" : "Prime Location"}</b><small>Mazar-e-Sharif</small></span>
            <span><AppIcon name="building" size={21} /><b>{fa ? "کاربری مختلط" : "Mixed Use"}</b><small>Retail | Residential | Offices</small></span>
            <span><AppIcon name="human-resources" size={21} /><b>{fa ? "فردای روشن‌تر" : "A Brighter"}</b><small>Tomorrow</small></span>
          </div>
        </div>
        <div className="hero-brand-panel" aria-hidden="true">
          <span>Iconic developments<br />Lasting value</span>
          <svg viewBox="0 0 48 58" fill="none"><path d="M24 3v49M18 11v41M30 11v41M12 23v29M36 23v29M7 52h34M13 39l11-9 11 9M18 25l6-8 6 8"/><path d="M5 55h38"/></svg>
          <strong>ALBERUNIY</strong><small>DEVELOPMENTS</small>
          <em>More than Buildings<br />We Build Possibilities</em>
        </div>
      </section>

      {failed ? <div className="treasury-message error" role="alert"><AppIcon name="alert" size={16} /><span>{fa ? "داشبورد بارگذاری نشد." : "The dashboard could not be loaded."}</span></div> : null}

      <section className="kpi-strip" aria-label={fa ? "ارقام شرکت" : "Company figures"}>
        {kpiCards.map((kpi) => {
          const shown = summary !== null && kpi.read !== undefined ? kpi.read(summary) : null;
          const state = kpi.read === undefined ? "not-connected" : shown === null ? "loading" : "connected";
          return (
            <article className={`reference-kpi ${kpi.tone}`} key={kpi.key} data-kpi={kpi.key} data-state={state}>
              <span className="reference-kpi-icon"><AppIcon name={kpi.icon} size={24} /></span>
              <div>
                <small>{t(kpi.label)}</small>
                {state === "connected" && shown ? <>
                  <strong dir="ltr" className="kpi-figure">{shown.figure}</strong>
                  <p>{t(shown.note)}</p>
                </> : state === "loading" ? <>
                  <strong className="kpi-empty">…</strong><p>{t(kpi.source)}</p>
                </> : <>
                  <strong className="kpi-empty">{t(NOT_CONNECTED)}</strong><p>{fa ? "منبع: " : "Source: "}{t(kpi.source)}</p>
                </>}
              </div>
            </article>
          );
        })}
      </section>

      <div className="analytics-grid">
        <section className="dashboard-panel sales-panel" aria-labelledby="sales-title" data-panel="sales">
          <header><h2 id="sales-title">{fa ? "عملکرد فروش" : "Sales Performance"} {badge}</h2></header>
          <div className="panel-summary"><div><strong className="kpi-empty">{t(NOT_CONNECTED)}</strong><small>{fa ? "ارزش مجموع فروش" : "Total Sales Value"}</small></div><div className="period-tabs" aria-hidden="true"><span className="active">{fa ? "ماهانه" : "Monthly"}</span><span>{fa ? "ربعوار" : "Quarterly"}</span><span>{fa ? "سالانه" : "Yearly"}</span></div></div>
          <div className="bar-chart chart-shell" role="img" aria-label={fa ? "نمودار فروش ماهانه — هنوز وصل نشده" : "Monthly sales chart — not connected yet"}>
            {MONTHS[locale].map((month) => <span key={month} style={{ height: 0 }}><i>{month}</i></span>)}
            {emptyChart({ en: "Sales", fa: "فروش" })}
          </div>
        </section>

        <section className="dashboard-panel progress-panel" aria-labelledby="progress-title" data-panel="projects">
          <header><h2 id="progress-title">{fa ? "پیشرفت پروژه‌ها" : "Project Progress"} {badge}</h2></header>
          <div className="project-progress-list">
            <div className="panel-empty" role="status">
              <span className="project-thumb"><Image src="/assets/al-beruniy-background.jpg" alt="" fill sizes="54px" /></span>
              <div>
                <strong>{summary === null ? "…" : fa ? `${summary.projects.active} پروژه فعال` : `${summary.projects.active} active project${summary.projects.active === 1 ? "" : "s"}`}</strong>
                <small>{fa ? "پیشرفت ساخت‌وساز پس از راه‌اندازی بخش ساخت‌وساز نشان داده می‌شود؛ هیچ درصدی تخمین زده نمی‌شود." : "Construction progress appears once the Construction module is running; no percentage is estimated."}</small>
              </div>
            </div>
          </div>
        </section>

        <section className="dashboard-panel cash-panel" aria-labelledby="cash-title" data-panel="cash">
          <header><h2 id="cash-title">{fa ? "نمای کلی جریان نقدی" : "Cash Flow Overview"} {badge}</h2></header>
          <div className="cash-summary">
            <span><strong className="kpi-empty">—</strong><small>{fa ? "دریافت‌شده" : "Collected"}</small></span>
            <span><strong className="kpi-empty">—</strong><small>{fa ? "باقی‌مانده" : "Remaining"}</small></span>
            <span><strong className="kpi-empty">—</strong><small>{fa ? "نرخ وصول" : "Collection Rate"}</small></span>
          </div>
          <div className="line-chart chart-shell" role="img" aria-label={fa ? "نمودار جریان نقدی — هنوز وصل نشده" : "Cash flow chart — not connected yet"}>
            <svg viewBox="0 0 400 145" preserveAspectRatio="none" aria-hidden="true"><g className="grid"><path d="M0 25h400M0 55h400M0 85h400M0 115h400"/><path d="M35 0v135M85 0v135M135 0v135M185 0v135M235 0v135M285 0v135M335 0v135"/></g></svg>
            <div className="month-row">{MONTHS[locale].map((month) => <span key={month}>{month}</span>)}</div>
            {emptyChart({ en: "Customer receipts", fa: "دریافت‌های مشتریان" })}
          </div>
        </section>

        <section className="dashboard-panel ai-panel" aria-labelledby="ai-title" data-panel="insights">
          <header><h2 id="ai-title">{fa ? "بینش‌ها" : "Insights"} {badge}</h2></header>
          <div className="ai-list">
            <div className="panel-empty" role="status"><span className="panel-empty-icon"><AppIcon name="ai-insights" size={20} /></span>
              <div><strong>{t(NOT_CONNECTED)}</strong><small>{fa ? "بینش‌ها فقط از داده‌های ثبت‌شده ساخته می‌شوند و هنوز فعال نیستند." : "Insights will be built only from recorded data and are not active yet."}</small></div></div>
          </div>
        </section>
      </div>

      <div className="bottom-grid">
        <section className="dashboard-panel department-panel" aria-labelledby="department-title" data-panel="departments">
          <header><h2 id="department-title">{fa ? "نمای کلی بخش‌ها" : "Department Overview"}</h2></header>
          <div className="department-list">
            {moduleCards.map((card) => (
              <article key={card.key} className={card.tone} data-state="not-connected">
                <span><AppIcon name={card.icon} size={19} /></span>
                <div><strong>{t(card.name)}</strong><p>{t(NOT_CONNECTED)}<br />{fa ? "منبع: " : "Source: "}{t(card.source)}</p></div>
              </article>
            ))}
          </div>
        </section>

        <section className="dashboard-panel alerts-panel" aria-labelledby="alerts-title" data-panel="alerts">
          <header><h2 id="alerts-title">{fa ? "آخرین هشدارها" : "Latest Alerts"} {badge}</h2></header>
          <div><div className="panel-empty" role="status"><span className="panel-empty-icon"><AppIcon name="bell" size={16} /></span>
            <div><strong>{t(NO_DATA)}</strong><small>{fa ? "هشدارهای معتبر پس از اتصال بخش‌ها اینجا می‌آیند." : "Verified alerts appear here once modules are connected."}</small></div></div></div>
        </section>

        <aside className="vision-card">
          <Image src="/assets/al-beruniy-background.jpg" alt="Al-Beruniy development skyline" fill sizes="320px" />
          <div><strong>Discipline today.<br />Extraordinary tomorrow.</strong><span /><small>AL-BERUNIY DEVELOPMENTS</small></div>
        </aside>
      </div>
    </div>
  );
}
