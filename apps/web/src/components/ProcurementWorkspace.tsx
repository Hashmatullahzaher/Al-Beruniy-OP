"use client";

import { useState } from "react";

import { AppIcon, type AppIconName } from "@/components/AppIcon";
import { useLocale } from "@/components/LocaleProvider";
import { StageZeroContextBar, StageZeroPageHeader, WorkspaceEmptyState, WorkspaceTabs, localized } from "@/components/StageZeroWorkspace";

const procurementTabs = [
  { id: "overview", label: { en: "Status overview", fa: "نمای کلی وضعیت" } },
  { id: "suppliers", label: { en: "Suppliers", fa: "تامین‌کنندگان" } },
  { id: "requirements", label: { en: "Material requirements", fa: "نیازمندی‌های مواد" }, count: 3 },
  { id: "requests", label: { en: "Purchase requests", fa: "درخواست‌های خرید" } },
  { id: "orders", label: { en: "Purchase orders", fa: "سفارش‌های خرید" } },
  { id: "deliveries", label: { en: "Deliveries", fa: "تحویل‌ها" } }
] as const;

const procurementFixtures = [
  { id: "DEMO-MR-001", title: { en: "Facade mock-up materials", fa: "مواد نمونه نمای ساختمان" }, category: { en: "Envelope sample", fa: "نمونه پوشش" }, stage: { en: "Requirement", fa: "نیازمندی" }, owner: { en: "Design coordination fixture", fa: "نمونه هماهنگی طراحی" }, status: { en: "Draft demo", fa: "پیش‌نویس نمایشی" }, tone: "blue" },
  { id: "DEMO-MR-002", title: { en: "MEP coordination sample", fa: "نمونه هماهنگی تاسیسات" }, category: { en: "Services sample", fa: "نمونه خدمات" }, stage: { en: "Review", fa: "بررسی" }, owner: { en: "Site planning fixture", fa: "نمونه برنامه‌ریزی ساحه" }, status: { en: "Review demo", fa: "بررسی نمایشی" }, tone: "gold" },
  { id: "DEMO-MR-003", title: { en: "Interior finish sample set", fa: "مجموعه نمونه پرداخت داخلی" }, category: { en: "Quality sample", fa: "نمونه کیفیت" }, stage: { en: "Planning", fa: "برنامه‌ریزی" }, owner: { en: "Quality review fixture", fa: "نمونه بررسی کیفیت" }, status: { en: "Planned demo", fa: "برنامه نمایشی" }, tone: "cyan" }
] as const;

const emptySections: Record<string, { icon: AppIconName; title: { en: string; fa: string }; description: { en: string; fa: string } }> = {
  suppliers: { icon: "sales-crm", title: { en: "No verified suppliers connected", fa: "هیچ تامین‌کننده تاییدشده متصل نیست" }, description: { en: "Supplier identities, qualifications, commercial terms, liabilities, and approved vendor status require governed operational services.", fa: "هویت، صلاحیت، شرایط تجاری، بدهی و وضعیت تاییدشده تامین‌کنندگان نیازمند خدمات عملیاتی کنترل‌شده است." } },
  requests: { icon: "documents", title: { en: "No operational purchase requests", fa: "هیچ درخواست خرید عملیاتی وجود ندارد" }, description: { en: "Requests, approvals, quantities, budgets, and sourcing decisions are unavailable in this Stage 0 preview.", fa: "درخواست‌ها، تاییدها، مقادیر، بودجه‌ها و تصمیم‌های تامین در این پیش‌نمایش مرحله صفر در دسترس نیست." } },
  orders: { icon: "procurement", title: { en: "No authorized purchase orders", fa: "هیچ سفارش خرید مجاز وجود ندارد" }, description: { en: "This interface cannot place purchases, create commitments, establish supplier liabilities, or generate accounting entries.", fa: "این رابط نمی‌تواند خرید انجام دهد، تعهد ایجاد کند، بدهی تامین‌کننده بسازد یا سند حسابداری تولید کند." } },
  deliveries: { icon: "building", title: { en: "No verified deliveries recorded", fa: "هیچ تحویل تاییدشده ثبت نشده" }, description: { en: "Receipt, inspection, acceptance, inventory valuation, and payment matching remain outside Stage 0.", fa: "دریافت، بازرسی، پذیرش، ارزش‌گذاری موجودی و تطبیق پرداخت خارج از مرحله صفر است." } }
};

export function ProcurementWorkspace() {
  const { locale } = useLocale();
  const [activeTab, setActiveTab] = useState("overview");
  const [selectedId, setSelectedId] = useState("DEMO-MR-001");
  const selected = procurementFixtures.find((item) => item.id === selectedId) ?? procurementFixtures[0];

  return (
    <div className="module-workspace procurement-workspace">
      <StageZeroPageHeader
        icon="procurement"
        eyebrow={{ en: "Supply / Procurement visibility", fa: "تامین و دید تدارکات" }}
        title={{ en: "Procurement", fa: "تدارکات" }}
        description={{ en: "A controlled Stage 0 preview for requirements, suppliers, requests, orders, and deliveries.", fa: "پیش‌نمایش کنترل‌شده مرحله صفر برای نیازمندی‌ها، تامین‌کنندگان، درخواست‌ها، سفارش‌ها و تحویل‌ها." }}
      >
        <button className="module-quiet-button" type="button" disabled title="Purchasing is unavailable in Stage 0"><AppIcon name="shield" size={16} />{localized({ en: "Purchasing locked", fa: "خرید قفل است" }, locale)}</button>
      </StageZeroPageHeader>

      <StageZeroContextBar section={{ en: "Procurement preview", fa: "پیش‌نمایش تدارکات" }} />

      <section className="procurement-guardrail" aria-label={localized({ en: "Procurement Stage 0 boundary", fa: "مرز تدارکات مرحله صفر" }, locale)}>
        <span aria-hidden="true"><AppIcon name="shield" size={20} /></span>
        <div><p>{localized({ en: "PREVIEW WORKFLOW", fa: "روند پیش‌نمایش" }, locale)}</p><strong>{localized({ en: "No purchases, supplier liabilities, inventory valuation, payments, accounting entries, or inter-project transfers", fa: "بدون خرید، بدهی تامین‌کننده، ارزش‌گذاری موجودی، پرداخت، سند حسابداری یا انتقال بین پروژه‌ها" }, locale)}</strong></div>
        <em>DEMO DATA</em>
      </section>

      <section className="module-content-card" aria-labelledby="procurement-workspace-title">
        <div className="module-card-heading">
          <div><p>{localized({ en: "Mazar Mall presentation context", fa: "زمینه نمایشی مزار مال" }, locale)}</p><h2 id="procurement-workspace-title">{localized({ en: "Procurement workspace", fa: "فضای کاری تدارکات" }, locale)}</h2></div>
          <span><i aria-hidden="true" />{localized({ en: "Synthetic requirements only", fa: "فقط نیازمندی‌های ساختگی" }, locale)}</span>
        </div>
        <div className="module-toolbar"><WorkspaceTabs label="Procurement workspace sections" tabs={procurementTabs} active={activeTab} onChange={setActiveTab} /></div>

        {activeTab === "overview" ? (
          <div className="procurement-overview-layout">
            <div className="procurement-main-column">
              <ol className="procurement-flow" aria-label={localized({ en: "Intended procurement workflow", fa: "روند مورد نظر تدارکات" }, locale)}>
                {[
                  { en: "Requirement", fa: "نیازمندی" }, { en: "Request", fa: "درخواست" }, { en: "Approval", fa: "تایید" },
                  { en: "Order", fa: "سفارش" }, { en: "Delivery", fa: "تحویل" }, { en: "Close", fa: "بستن" }
                ].map((step, index) => <li key={step.en}><span>{index + 1}</span><small>{localized(step, locale)}</small></li>)}
              </ol>
              <div className="procurement-list" role="list" aria-label={localized({ en: "Synthetic material requirements", fa: "نیازمندی‌های ساختگی مواد" }, locale)}>
                <div className="procurement-list-heading"><span>{localized({ en: "Demo requirement", fa: "نیازمندی نمایشی" }, locale)}</span><span>{localized({ en: "Preview status", fa: "وضعیت پیش‌نمایش" }, locale)}</span></div>
                {procurementFixtures.map((item) => <div role="listitem" key={item.id}><button type="button" aria-label={`Select ${item.id} demo requirement`} className={selected.id === item.id ? "selected" : undefined} onClick={() => setSelectedId(item.id)}><span className={`procurement-item-icon ${item.tone}`}><AppIcon name="procurement" size={18} /></span><span className="procurement-item-copy"><strong>{localized(item.title, locale)}</strong><small>{item.id} · {localized(item.category, locale)}</small></span><span className="procurement-stage"><b>{localized(item.stage, locale)}</b><small>{localized(item.status, locale)}</small></span><AppIcon name="chevron" size={15} /></button></div>)}
              </div>
            </div>
            <aside className="procurement-detail-panel" aria-live="polite">
              <p>{selected.id}</p><h2>{localized(selected.title, locale)}</h2><span>{localized(selected.category, locale)}</span>
              <dl>
                <div><dt>{localized({ en: "Preview stage", fa: "مرحله پیش‌نمایش" }, locale)}</dt><dd>{localized(selected.stage, locale)}</dd></div>
                <div><dt>{localized({ en: "Responsible context", fa: "زمینه مسئول" }, locale)}</dt><dd>{localized(selected.owner, locale)}</dd></div>
                <div><dt>{localized({ en: "Verified quantity", fa: "مقدار تاییدشده" }, locale)}</dt><dd>{localized({ en: "Unavailable", fa: "در دسترس نیست" }, locale)}</dd></div>
                <div><dt>{localized({ en: "Supplier and price", fa: "تامین‌کننده و قیمت" }, locale)}</dt><dd>{localized({ en: "Not connected", fa: "متصل نیست" }, locale)}</dd></div>
              </dl>
              <div><AppIcon name="alert" size={16} /><p><strong>{localized({ en: "Demonstration boundary", fa: "مرز نمایشی" }, locale)}</strong>{localized({ en: "This fixture cannot create a request, order, delivery, liability, inventory value, payment, or accounting effect.", fa: "این نمونه نمی‌تواند درخواست، سفارش، تحویل، بدهی، ارزش موجودی، پرداخت یا اثر حسابداری ایجاد کند." }, locale)}</p></div>
            </aside>
          </div>
        ) : null}

        {activeTab === "requirements" ? <div className="procurement-requirement-cards">{procurementFixtures.map((item) => <article key={item.id}><span className={`procurement-item-icon ${item.tone}`}><AppIcon name="procurement" size={19} /></span><p>{item.id} · DEMO</p><h3>{localized(item.title, locale)}</h3><small>{localized(item.category, locale)}</small><dl><div><dt>{localized({ en: "Status", fa: "وضعیت" }, locale)}</dt><dd>{localized(item.status, locale)}</dd></div><div><dt>{localized({ en: "Quantity", fa: "مقدار" }, locale)}</dt><dd>{localized({ en: "Not verified", fa: "تایید نشده" }, locale)}</dd></div></dl></article>)}</div> : null}

        {activeTab !== "overview" && activeTab !== "requirements" ? <WorkspaceEmptyState icon={emptySections[activeTab]!.icon} title={emptySections[activeTab]!.title} description={emptySections[activeTab]!.description} /> : null}
      </section>
    </div>
  );
}
