"use client";

import Link from "next/link";
import { useState } from "react";

import { AppIcon, type AppIconName } from "@/components/AppIcon";
import { useLocale } from "@/components/LocaleProvider";
import { StageZeroContextBar, StageZeroPageHeader, WorkspaceEmptyState, WorkspaceTabs, localized } from "@/components/StageZeroWorkspace";

const financeTabs = [
  { id: "structure", label: { en: "Workspace map", fa: "نقشه فضای کاری" } },
  { id: "shareholders", label: { en: "Shareholder accounts", fa: "حساب‌های سهامداران" } },
  { id: "treasury", label: { en: "Treasury", fa: "خزانه‌داری" } },
  { id: "accounting", label: { en: "Accounting", fa: "حسابداری" } },
  { id: "reports", label: { en: "Financial reports", fa: "گزارش‌های مالی" } }
] as const;

const financeAreas: ReadonlyArray<{
  id: string;
  icon: AppIconName;
  title: { en: string; fa: string };
  subtitle: { en: string; fa: string };
  purpose: { en: string; fa: string };
  dependencies: ReadonlyArray<{ en: string; fa: string }>;
}> = [
  {
    id: "shareholders",
    icon: "sales-crm",
    title: { en: "Shareholder accounts", fa: "حساب‌های سهامداران" },
    subtitle: { en: "Ownership and contribution structure", fa: "ساختار مالکیت و مشارکت" },
    purpose: { en: "A future governed view of verified parties, ownership evidence, commitments, and approved contribution classifications.", fa: "نمای کنترل‌شده آینده از اشخاص تاییدشده، اسناد مالکیت، تعهدات و طبقه‌بندی مشارکت‌های تصویب‌شده." },
    dependencies: [
      { en: "Verified shareholder identity", fa: "هویت تاییدشده سهامدار" },
      { en: "Approved ownership and capital policy", fa: "سیاست تصویب‌شده مالکیت و سرمایه" },
      { en: "Authorized opening position", fa: "موقعیت افتتاحیه مجاز" }
    ]
  },
  {
    id: "treasury",
    icon: "coins",
    title: { en: "Treasury", fa: "خزانه‌داری" },
    subtitle: { en: "Cash, bank, and custody controls", fa: "کنترل‌های نقدی، بانکی و نگهداری" },
    purpose: { en: "A future controlled workspace for approved cash and bank accounts, receipts, payments, reconciliation, and custody.", fa: "فضای کاری کنترل‌شده آینده برای حساب‌های نقدی و بانکی تصویب‌شده، دریافت‌ها، پرداخت‌ها، تطبیق و نگهداری." },
    dependencies: [
      { en: "Authorized treasury accounts", fa: "حساب‌های مجاز خزانه" },
      { en: "Receipt and payment approval rules", fa: "قواعد تایید دریافت و پرداخت" },
      { en: "Reconciliation controls", fa: "کنترل‌های تطبیق" }
    ]
  },
  {
    id: "accounting",
    icon: "finance",
    title: { en: "Accounting", fa: "حسابداری" },
    subtitle: { en: "Controlled journal and ledger structure", fa: "ساختار کنترل‌شده دفتر و اسناد" },
    purpose: { en: "A future accounting workspace for an approved chart of accounts, balanced journals, controlled posting, and immutable audit evidence.", fa: "فضای کاری حسابداری آینده برای سرفصل‌های تصویب‌شده، اسناد متوازن، ثبت کنترل‌شده و شواهد تغییرناپذیر حسابرسی." },
    dependencies: [
      { en: "Approved chart of accounts", fa: "سرفصل‌های تصویب‌شده حساب‌ها" },
      { en: "Posting and reversal policy", fa: "سیاست ثبت و برگشت" },
      { en: "Period and audit controls", fa: "کنترل‌های دوره و حسابرسی" }
    ]
  },
  {
    id: "reports",
    icon: "reports-analytics",
    title: { en: "Financial reports", fa: "گزارش‌های مالی" },
    subtitle: { en: "Verified reporting outputs", fa: "خروجی‌های گزارش‌دهی تاییدشده" },
    purpose: { en: "A future read-only reporting layer derived from authorized, posted, and reconciled accounting records.", fa: "لایه گزارش‌دهی فقط‌خواندنی آینده که از سوابق مجاز، ثبت‌شده و تطبیق‌شده حسابداری ایجاد می‌شود." },
    dependencies: [
      { en: "Verified posted ledger", fa: "دفتر ثبت‌شده و تاییدشده" },
      { en: "Approved reporting periods", fa: "دوره‌های گزارش‌دهی تصویب‌شده" },
      { en: "Source-to-report traceability", fa: "ردیابی منبع تا گزارش" }
    ]
  }
];

const emptyCopy = {
  shareholders: {
    icon: "sales-crm" as AppIconName,
    title: { en: "No verified shareholder accounts", fa: "هیچ حساب سهامدار تاییدشده وجود ندارد" },
    description: { en: "Identities, ownership evidence, commitments, capital classifications, and opening positions require separate policy and data approval.", fa: "هویت‌ها، اسناد مالکیت، تعهدات، طبقه‌بندی سرمایه و موقعیت‌های افتتاحیه نیازمند تایید جداگانه سیاست و داده است." }
  },
  treasury: {
    icon: "coins" as AppIconName,
    title: { en: "No treasury accounts connected", fa: "هیچ حساب خزانه متصل نیست" },
    description: { en: "No cash, bank, sarafi, receipt, payment, custody, or reconciliation service is operational in Stage 0.", fa: "هیچ سرویس نقدی، بانکی، صرافی، دریافت، پرداخت، نگهداری یا تطبیق در مرحله صفر فعال نیست." }
  },
  accounting: {
    icon: "finance" as AppIconName,
    title: { en: "No accounting ledger connected", fa: "هیچ دفتر حسابداری متصل نیست" },
    description: { en: "The chart of accounts, journals, posting, reversals, periods, and audit records remain outside this interface preview.", fa: "سرفصل حساب‌ها، اسناد، ثبت، برگشت، دوره‌ها و سوابق حسابرسی خارج از این پیش‌نمایش رابط است." }
  },
  reports: {
    icon: "reports-analytics" as AppIconName,
    title: { en: "No verified financial reports", fa: "هیچ گزارش مالی تاییدشده وجود ندارد" },
    description: { en: "Reports will remain unavailable until approved source transactions are posted, reconciled, and traceable through a governed ledger.", fa: "گزارش‌ها تا زمانی که معاملات منبع تصویب، ثبت، تطبیق و از طریق دفتر کنترل‌شده قابل ردیابی نباشد، در دسترس نخواهد بود." }
  }
} as const;

export function FinanceWorkspace() {
  const { locale } = useLocale();
  const [activeTab, setActiveTab] = useState("structure");
  const [selectedArea, setSelectedArea] = useState("shareholders");
  const selected = financeAreas.find((area) => area.id === selectedArea) ?? financeAreas[0]!;

  return (
    <div className="module-workspace finance-workspace">
      <StageZeroPageHeader
        icon="finance"
        eyebrow={{ en: "Finance / Control architecture", fa: "مالی و ساختار کنترلی" }}
        title={{ en: "Finance", fa: "مالی" }}
        description={{ en: "A Stage 0 interface preview for governed shareholder, treasury, accounting, and reporting workspaces.", fa: "پیش‌نمایش رابط مرحله صفر برای فضاهای کاری کنترل‌شده سهامداران، خزانه، حسابداری و گزارش‌دهی." }}
      >
        <button className="module-quiet-button" type="button" disabled title="Financial transactions are unavailable in Stage 0"><AppIcon name="shield" size={16} />{localized({ en: "Transactions locked", fa: "معاملات قفل است" }, locale)}</button>
      </StageZeroPageHeader>

      <StageZeroContextBar section={{ en: "Finance preview", fa: "پیش‌نمایش مالی" }} />

      <section className="finance-boundary-banner" aria-label={localized({ en: "Finance Stage 0 boundary", fa: "مرز مالی مرحله صفر" }, locale)}>
        <span aria-hidden="true"><AppIcon name="shield" size={22} /></span>
        <div><p>{localized({ en: "INTERFACE PREVIEW ONLY", fa: "فقط پیش‌نمایش رابط" }, locale)}</p><strong>{localized({ en: "No real balances, capital receipts, vouchers, journals, posting, or treasury actions", fa: "بدون مانده واقعی، دریافت سرمایه، سند، ژورنال، ثبت یا عملیات خزانه" }, locale)}</strong></div>
        <em>{localized({ en: "Stage 1 not authorized", fa: "مرحله اول مجاز نیست" }, locale)}</em>
      </section>

      <section className="module-content-card" aria-labelledby="finance-workspace-title">
        <div className="module-card-heading">
          <div><p>{localized({ en: "Governed operating model", fa: "مدل عملیاتی کنترل‌شده" }, locale)}</p><h2 id="finance-workspace-title">{localized({ en: "Finance workspace structure", fa: "ساختار فضای کاری مالی" }, locale)}</h2></div>
          <span><i aria-hidden="true" />{localized({ en: "No operational finance data loaded", fa: "هیچ داده عملیاتی مالی بارگذاری نشده" }, locale)}</span>
        </div>
        <div className="module-toolbar">
          <WorkspaceTabs label="Finance workspace sections" tabs={financeTabs} active={activeTab} onChange={setActiveTab} />
        </div>

        {activeTab === "structure" ? (
          <div className="finance-structure-layout">
            <div className="finance-area-column">
              <div className="finance-control-path" aria-label={localized({ en: "Future governed finance flow", fa: "جریان کنترل‌شده آینده مالی" }, locale)}>
                {[
                  { en: "Approved setup", fa: "راه‌اندازی تصویب‌شده" },
                  { en: "Authorized source", fa: "منبع مجاز" },
                  { en: "Controlled posting", fa: "ثبت کنترل‌شده" },
                  { en: "Verified reporting", fa: "گزارش تاییدشده" }
                ].map((step, index) => <span key={step.en}><b>{index + 1}</b><small>{localized(step, locale)}</small></span>)}
              </div>
              <div className="finance-area-grid" role="list" aria-label={localized({ en: "Finance preview areas", fa: "بخش‌های پیش‌نمایش مالی" }, locale)}>
                {financeAreas.map((area) => (
                  <div role="listitem" key={area.id}>
                    <button type="button" className={selected.id === area.id ? "selected" : undefined} aria-label={`${localized(area.title, locale)} preview`} onClick={() => setSelectedArea(area.id)}>
                      <span aria-hidden="true"><AppIcon name={area.icon} size={21} /></span>
                      <strong>{localized(area.title, locale)}</strong>
                      <small>{localized(area.subtitle, locale)}</small>
                      <em>{localized({ en: "NOT CONNECTED", fa: "متصل نیست" }, locale)}</em>
                      <AppIcon name="chevron" size={15} />
                    </button>
                  </div>
                ))}
              </div>
            </div>

            <aside className="finance-detail-panel" aria-live="polite">
              <span className="finance-detail-icon" aria-hidden="true"><AppIcon name={selected.icon} size={25} /></span>
              <p>{localized({ en: "INTENDED STRUCTURE", fa: "ساختار مورد نظر" }, locale)}</p>
              <h2>{localized(selected.title, locale)}</h2>
              <h3>{localized(selected.subtitle, locale)}</h3>
              <p className="finance-detail-purpose">{localized(selected.purpose, locale)}</p>
              <strong>{localized({ en: "Required before activation", fa: "الزامات پیش از فعال‌سازی" }, locale)}</strong>
              <ul>{selected.dependencies.map((dependency) => <li key={dependency.en}><AppIcon name="shield" size={13} />{localized(dependency, locale)}</li>)}</ul>
              <div><AppIcon name="alert" size={16} /><span><b>{localized({ en: "Operational state", fa: "وضعیت عملیاتی" }, locale)}</b>{localized({ en: "Unavailable · no records or actions", fa: "در دسترس نیست · بدون سوابق یا عملیات" }, locale)}</span></div>
            </aside>
          </div>
        ) : activeTab === "treasury" ? (
          <div className="treasury-entry">
            <span aria-hidden="true"><AppIcon name="coins" size={26} /></span>
            <div>
              <p>{localized({ en: "E1 SYNTHETIC SANDBOX", fa: "محیط آزمایشی مصنوعی E1" }, locale)}</p>
              <h2>{localized({ en: "Treasury workspace", fa: "فضای کاری خزانه" }, locale)}</h2>
              <span>{localized({ en: "Office safes, independent USD and AFN accounts, cash receipts, physical counts, independent verification and handoff to Finance - on synthetic data, with no General Ledger posting from Treasury.", fa: "صندوق‌های دفتر، حساب‌های مستقل دالر و افغانی، دریافت نقد، شمارش فزیکی، تایید مستقل و تحویل به مالی - با داده‌های مصنوعی و بدون ثبت در دفتر کل از خزانه." }, locale)}</span>
            </div>
            <Link className="treasury-button" href="/finance/treasury">{localized({ en: "Open Treasury", fa: "باز کردن خزانه" }, locale)}</Link>
          </div>
        ) : (
          <WorkspaceEmptyState icon={emptyCopy[activeTab as keyof typeof emptyCopy].icon} title={emptyCopy[activeTab as keyof typeof emptyCopy].title} description={emptyCopy[activeTab as keyof typeof emptyCopy].description} />
        )}
      </section>
    </div>
  );
}
