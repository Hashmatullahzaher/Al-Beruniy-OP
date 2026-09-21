"use client";

import { useState } from "react";

import { AppIcon, type AppIconName } from "@/components/AppIcon";
import { useLocale } from "@/components/LocaleProvider";
import { StageZeroContextBar, StageZeroPageHeader, WorkspaceTabs, localized } from "@/components/StageZeroWorkspace";

type LocalizedCopy = Readonly<{ en: string; fa: string }>;

const reportTabs = [
  { id: "sales", label: { en: "Sales", fa: "فروش" } },
  { id: "collections", label: { en: "Collections", fa: "وصولات" } },
  { id: "construction", label: { en: "Construction", fa: "ساخت‌وساز" } },
  { id: "procurement", label: { en: "Procurement", fa: "تدارکات" } },
  { id: "financial", label: { en: "Financial", fa: "مالی" } }
] as const;

const projects = [
  { id: "mazar-mall", label: { en: "Mazar Mall · Demo context", fa: "مزار مال · زمینه نمایشی" } },
  { id: "all-projects", label: { en: "All demo projects", fa: "همه پروژه‌های نمایشی" } }
] as const;

const periods = [
  { id: "30-days", label: { en: "Illustrative last 30 days", fa: "۳۰ روز گذشته نمایشی" } },
  { id: "quarter", label: { en: "Illustrative quarter", fa: "ربع نمایشی" } },
  { id: "year", label: { en: "Illustrative year to date", fa: "سال تا امروز نمایشی" } }
] as const;

const categoryMeta: Record<string, { icon: AppIconName; eyebrow: LocalizedCopy; title: LocalizedCopy; description: LocalizedCopy }> = {
  sales: {
    icon: "sales-crm",
    eyebrow: { en: "DEMO DATA · SALES VIEW", fa: "داده نمایشی · نمای فروش" },
    title: { en: "Sales activity preview", fa: "پیش‌نمایش فعالیت فروش" },
    description: { en: "Illustrative pipeline movement and unit interest for interface review only.", fa: "حرکت نمایشی مسیر فروش و علاقه‌مندی واحدها فقط برای بررسی رابط." }
  },
  collections: {
    icon: "coins",
    eyebrow: { en: "DEMO DATA · COLLECTIONS VIEW", fa: "داده نمایشی · نمای وصولات" },
    title: { en: "Collections visibility preview", fa: "پیش‌نمایش دید وصولات" },
    description: { en: "Illustrative schedule states without verified customer balances or receipts.", fa: "وضعیت‌های نمایشی برنامه بدون مانده تاییدشده مشتری یا رسید." }
  },
  construction: {
    icon: "construction",
    eyebrow: { en: "DEMO DATA · CONSTRUCTION VIEW", fa: "داده نمایشی · نمای ساخت‌وساز" },
    title: { en: "Construction progress preview", fa: "پیش‌نمایش پیشرفت ساخت‌وساز" },
    description: { en: "Illustrative work-area progress without certified quantities, costs, or approvals.", fa: "پیشرفت نمایشی ساحات کاری بدون مقادیر، هزینه‌ها یا تاییدهای تصدیق‌شده." }
  },
  procurement: {
    icon: "procurement",
    eyebrow: { en: "DEMO DATA · PROCUREMENT VIEW", fa: "داده نمایشی · نمای تدارکات" },
    title: { en: "Procurement status preview", fa: "پیش‌نمایش وضعیت تدارکات" },
    description: { en: "Illustrative requirement stages without purchases, liabilities, or inventory values.", fa: "مراحل نمایشی نیازمندی بدون خرید، بدهی یا ارزش موجودی." }
  },
  financial: {
    icon: "finance",
    eyebrow: { en: "DEMO DATA · FINANCIAL VIEW", fa: "داده نمایشی · نمای مالی" },
    title: { en: "Financial reporting structure", fa: "ساختار گزارش‌دهی مالی" },
    description: { en: "A non-operational report preview without official statements or a reconciled live ledger.", fa: "پیش‌نمایش غیرعملیاتی گزارش بدون صورت‌های رسمی یا دفتر زنده تطبیق‌شده." }
  }
};

const chartSeries: Record<string, ReadonlyArray<{ label: LocalizedCopy; value: number }>> = {
  sales: [
    { label: { en: "Week 1", fa: "هفته ۱" }, value: 46 }, { label: { en: "Week 2", fa: "هفته ۲" }, value: 68 },
    { label: { en: "Week 3", fa: "هفته ۳" }, value: 57 }, { label: { en: "Week 4", fa: "هفته ۴" }, value: 82 }
  ],
  collections: [
    { label: { en: "Scheduled", fa: "برنامه‌شده" }, value: 78 }, { label: { en: "Illustrative received", fa: "دریافت نمایشی" }, value: 52 },
    { label: { en: "Review", fa: "بررسی" }, value: 36 }, { label: { en: "Unverified", fa: "تاییدنشده" }, value: 21 }
  ],
  construction: [
    { label: { en: "Demo Wing A", fa: "بال نمایشی الف" }, value: 72 }, { label: { en: "Demo Wing B", fa: "بال نمایشی ب" }, value: 58 },
    { label: { en: "Services Core", fa: "هسته خدمات" }, value: 43 }, { label: { en: "Quality review", fa: "بررسی کیفیت" }, value: 31 }
  ],
  procurement: [
    { label: { en: "Requirements", fa: "نیازمندی‌ها" }, value: 75 }, { label: { en: "Review", fa: "بررسی" }, value: 48 },
    { label: { en: "Requests", fa: "درخواست‌ها" }, value: 18 }, { label: { en: "Orders", fa: "سفارش‌ها" }, value: 0 }
  ],
  financial: [
    { label: { en: "Source readiness", fa: "آمادگی منبع" }, value: 34 }, { label: { en: "Control design", fa: "طراحی کنترل" }, value: 51 },
    { label: { en: "Ledger connection", fa: "اتصال دفتر" }, value: 0 }, { label: { en: "Reconciliation", fa: "تطبیق" }, value: 0 }
  ]
};

const reportRows: Record<string, ReadonlyArray<{ id: string; subject: LocalizedCopy; category: LocalizedCopy; status: LocalizedCopy }>> = {
  sales: [
    { id: "DEMO-RPT-S01", subject: { en: "Pipeline movement sample", fa: "نمونه حرکت مسیر فروش" }, category: { en: "Illustrative activity", fa: "فعالیت نمایشی" }, status: { en: "Preview ready", fa: "پیش‌نمایش آماده" } },
    { id: "DEMO-RPT-S02", subject: { en: "Unit interest sample", fa: "نمونه علاقه‌مندی واحد" }, category: { en: "Synthetic demand", fa: "تقاضای ساختگی" }, status: { en: "Preview ready", fa: "پیش‌نمایش آماده" } }
  ],
  collections: [
    { id: "DEMO-RPT-C01", subject: { en: "Schedule status sample", fa: "نمونه وضعیت برنامه" }, category: { en: "Unverified schedule", fa: "برنامه تاییدنشده" }, status: { en: "No ledger link", fa: "بدون اتصال دفتر" } },
    { id: "DEMO-RPT-C02", subject: { en: "Exception review sample", fa: "نمونه بررسی استثنا" }, category: { en: "Illustrative exception", fa: "استثنای نمایشی" }, status: { en: "Not reconciled", fa: "تطبیق نشده" } }
  ],
  construction: [
    { id: "DEMO-RPT-B01", subject: { en: "Work-area progress sample", fa: "نمونه پیشرفت ساحه کاری" }, category: { en: "Illustrative progress", fa: "پیشرفت نمایشی" }, status: { en: "No field certification", fa: "بدون تصدیق ساحه" } },
    { id: "DEMO-RPT-B02", subject: { en: "Milestone status sample", fa: "نمونه وضعیت نقطه عطف" }, category: { en: "Synthetic schedule", fa: "برنامه ساختگی" }, status: { en: "Preview only", fa: "فقط پیش‌نمایش" } }
  ],
  procurement: [
    { id: "DEMO-RPT-P01", subject: { en: "Requirement status sample", fa: "نمونه وضعیت نیازمندی" }, category: { en: "Synthetic requirement", fa: "نیازمندی ساختگی" }, status: { en: "No purchasing action", fa: "بدون عملیات خرید" } },
    { id: "DEMO-RPT-P02", subject: { en: "Sourcing readiness sample", fa: "نمونه آمادگی تامین" }, category: { en: "Illustrative review", fa: "بررسی نمایشی" }, status: { en: "No supplier liability", fa: "بدون بدهی تامین‌کننده" } }
  ],
  financial: [
    { id: "DEMO-RPT-F01", subject: { en: "Reporting control map", fa: "نقشه کنترل گزارش‌دهی" }, category: { en: "Structure preview", fa: "پیش‌نمایش ساختار" }, status: { en: "No official statement", fa: "بدون صورت رسمی" } },
    { id: "DEMO-RPT-F02", subject: { en: "Source traceability preview", fa: "پیش‌نمایش ردیابی منبع" }, category: { en: "Control readiness", fa: "آمادگی کنترل" }, status: { en: "Ledger not connected", fa: "دفتر متصل نیست" } }
  ]
};

export function ReportsAnalyticsWorkspace() {
  const { locale } = useLocale();
  const [activeTab, setActiveTab] = useState("sales");
  const [project, setProject] = useState("mazar-mall");
  const [period, setPeriod] = useState("30-days");
  const meta = categoryMeta[activeTab] ?? categoryMeta.sales!;
  const series = chartSeries[activeTab] ?? chartSeries.sales!;
  const rows = reportRows[activeTab] ?? reportRows.sales!;

  return (
    <div className="module-workspace reports-workspace">
      <StageZeroPageHeader
        icon="reports-analytics"
        eyebrow={{ en: "Executive visibility / Report previews", fa: "دید اجرایی و پیش‌نمایش گزارش‌ها" }}
        title={{ en: "Reports & Analytics", fa: "گزارش‌ها و تحلیل‌ها" }}
        description={{ en: "A Stage 0 navigation and preview workspace for management reporting across approved operational areas.", fa: "فضای کاری مرحله صفر برای پیمایش و پیش‌نمایش گزارش‌های مدیریتی در بخش‌های عملیاتی تصویب‌شده." }}
      >
        <button className="module-quiet-button" type="button" disabled title="Report exports are unavailable in Stage 0"><AppIcon name="shield" size={16} />{localized({ en: "Official export locked", fa: "خروجی رسمی قفل است" }, locale)}</button>
      </StageZeroPageHeader>

      <StageZeroContextBar section={{ en: "Reports & Analytics preview", fa: "پیش‌نمایش گزارش‌ها و تحلیل‌ها" }} />

      <section className="reports-guardrail" aria-label={localized({ en: "Reporting Stage 0 boundary", fa: "مرز گزارش‌دهی مرحله صفر" }, locale)}>
        <span aria-hidden="true"><AppIcon name="shield" size={20} /></span>
        <div><p>{localized({ en: "EXECUTIVE PREVIEW · DEMO DATA", fa: "پیش‌نمایش اجرایی · داده نمایشی" }, locale)}</p><strong>{localized({ en: "No official statements, verified balances, live-ledger reconciliation, or operational report exports", fa: "بدون صورت رسمی، مانده تاییدشده، تطبیق دفتر زنده یا خروجی گزارش عملیاتی" }, locale)}</strong></div>
        <em>DEMO DATA</em>
      </section>

      <section className="module-content-card" aria-labelledby="reports-workspace-title">
        <div className="module-card-heading">
          <div><p>{localized({ en: "Management reporting map", fa: "نقشه گزارش‌دهی مدیریت" }, locale)}</p><h2 id="reports-workspace-title">{localized({ en: "Executive reporting workspace", fa: "فضای کاری گزارش‌دهی اجرایی" }, locale)}</h2></div>
          <span><i aria-hidden="true" />{localized({ en: "Synthetic preview data only", fa: "فقط داده پیش‌نمایش ساختگی" }, locale)}</span>
        </div>

        <div className="reports-controls" aria-label={localized({ en: "Report preview controls", fa: "کنترل‌های پیش‌نمایش گزارش" }, locale)}>
          <label><span>{localized({ en: "Project context", fa: "زمینه پروژه" }, locale)}</span><select value={project} onChange={(event) => setProject(event.target.value)}>{projects.map((item) => <option value={item.id} key={item.id}>{localized(item.label, locale)}</option>)}</select></label>
          <label><span>{localized({ en: "Date range", fa: "محدوده تاریخ" }, locale)}</span><select value={period} onChange={(event) => setPeriod(event.target.value)}>{periods.map((item) => <option value={item.id} key={item.id}>{localized(item.label, locale)}</option>)}</select></label>
          <div className="reports-control-state"><AppIcon name="database" size={17} /><span><small>{localized({ en: "Source state", fa: "وضعیت منبع" }, locale)}</small><strong>{localized({ en: "Fixtures · not connected", fa: "نمونه‌ها · متصل نیست" }, locale)}</strong></span></div>
        </div>

        <div className="module-toolbar"><WorkspaceTabs label="Report categories" tabs={reportTabs} active={activeTab} onChange={setActiveTab} /></div>

        <div className="reports-preview-layout">
          <section className="reports-chart-panel" aria-labelledby="reports-preview-heading">
            <div className="reports-panel-heading"><span aria-hidden="true"><AppIcon name={meta.icon} size={20} /></span><div><p>{localized(meta.eyebrow, locale)}</p><h3 id="reports-preview-heading">{localized(meta.title, locale)}</h3><small>{localized(meta.description, locale)}</small></div><em>DEMO DATA</em></div>
            <div className="reports-bar-chart" role="img" aria-label={localized({ en: "Synthetic demonstration bar chart; values are not operational", fa: "نمودار میله‌ای نمایشی ساختگی؛ ارقام عملیاتی نیست" }, locale)}>
              {series.map((item) => <div key={item.label.en}><span><b>{localized(item.label, locale)}</b><small>{item.value}% · DEMO</small></span><i><em style={{ width: `${item.value}%` }} /></i></div>)}
            </div>
            <p className="reports-chart-note"><AppIcon name="alert" size={15} />{localized({ en: "Illustrative interface values only. They are not verified, reconciled, or suitable for decisions or external reporting.", fa: "فقط ارقام نمایشی رابط. این ارقام تایید یا تطبیق نشده و برای تصمیم‌گیری یا گزارش بیرونی مناسب نیست." }, locale)}</p>
          </section>

          <aside className="reports-readiness-panel" aria-label={localized({ en: "Report readiness", fa: "آمادگی گزارش" }, locale)}>
            <p>{localized({ en: "REPORT READINESS", fa: "آمادگی گزارش" }, locale)}</p><h3>{localized({ en: "Preview controls", fa: "کنترل‌های پیش‌نمایش" }, locale)}</h3>
            <dl>
              <div><dt>{localized({ en: "Project", fa: "پروژه" }, locale)}</dt><dd>{localized(projects.find((item) => item.id === project)?.label ?? projects[0].label, locale)}</dd></div>
              <div><dt>{localized({ en: "Period", fa: "دوره" }, locale)}</dt><dd>{localized(periods.find((item) => item.id === period)?.label ?? periods[0].label, locale)}</dd></div>
              <div><dt>{localized({ en: "Operational source", fa: "منبع عملیاتی" }, locale)}</dt><dd>{localized({ en: "Not connected", fa: "متصل نیست" }, locale)}</dd></div>
              <div><dt>{localized({ en: "Verification state", fa: "وضعیت تایید" }, locale)}</dt><dd>{localized({ en: "Unverified demo", fa: "نمایش تاییدنشده" }, locale)}</dd></div>
            </dl>
            <div><AppIcon name="shield" size={16} /><p><strong>{localized({ en: "Read-only boundary", fa: "مرز فقط‌خواندنی" }, locale)}</strong>{localized({ en: "No report can post, approve, reconcile, certify, or change an operational record.", fa: "هیچ گزارشی نمی‌تواند سابقه عملیاتی را ثبت، تایید، تطبیق، تصدیق یا تغییر دهد." }, locale)}</p></div>
          </aside>
        </div>

        <section className="reports-table-panel" aria-labelledby="reports-table-title">
          <div className="reports-table-heading"><div><p>DEMO DATA</p><h3 id="reports-table-title">{localized({ en: "Report preview index", fa: "فهرست پیش‌نمایش گزارش" }, locale)}</h3></div><span>{localized({ en: "Read-only synthetic rows", fa: "ردیف‌های ساختگی فقط‌خواندنی" }, locale)}</span></div>
          <div className="reports-table-scroll"><table><thead><tr><th scope="col">{localized({ en: "Preview ID", fa: "شناسه پیش‌نمایش" }, locale)}</th><th scope="col">{localized({ en: "Report", fa: "گزارش" }, locale)}</th><th scope="col">{localized({ en: "Category", fa: "دسته" }, locale)}</th><th scope="col">{localized({ en: "State", fa: "وضعیت" }, locale)}</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id}><td><strong>{row.id}</strong><small>DEMO DATA</small></td><td>{localized(row.subject, locale)}</td><td>{localized(row.category, locale)}</td><td><span>{localized(row.status, locale)}</span></td></tr>)}</tbody></table></div>
        </section>
      </section>
    </div>
  );
}
