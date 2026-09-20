"use client";

import { useMemo, useState } from "react";

import { AppIcon } from "@/components/AppIcon";
import { useLocale } from "@/components/LocaleProvider";
import { StageZeroContextBar, StageZeroPageHeader, WorkspaceEmptyState, WorkspaceTabs, localized } from "@/components/StageZeroWorkspace";

const salesTabs = [
  { id: "pipeline", label: { en: "Lead pipeline", fa: "مسیر سرنخ‌ها" }, count: 4 },
  { id: "customers", label: { en: "Customers", fa: "مشتریان" } },
  { id: "contracts", label: { en: "Contracts", fa: "قراردادها" } },
  { id: "collections", label: { en: "Collections", fa: "وصولات" } }
] as const;

const leadFixtures = [
  { id: "DEMO-L001", interest: "Residential unit", source: "Walk-in fixture", stage: "Qualified", age: "2 demo days" },
  { id: "DEMO-L002", interest: "Commercial unit", source: "Campaign fixture", stage: "Contacted", age: "4 demo days" },
  { id: "DEMO-L003", interest: "Two-bedroom unit", source: "Web fixture", stage: "New", age: "1 demo day" },
  { id: "DEMO-L004", interest: "Office unit", source: "Referral fixture", stage: "Proposal", age: "6 demo days" }
] as const;

const lifecycle = ["Lead", "Qualification", "Opportunity", "Availability", "Quotation", "Reservation", "Contract", "Installments", "Collection", "Handover"];

export function SalesCrmWorkspace() {
  const { locale } = useLocale();
  const [activeTab, setActiveTab] = useState("pipeline");
  const [query, setQuery] = useState("");
  const [selectedLead, setSelectedLead] = useState("DEMO-L001");

  const visibleLeads = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return leadFixtures.filter((lead) => !normalizedQuery || `${lead.id} ${lead.interest} ${lead.stage}`.toLowerCase().includes(normalizedQuery));
  }, [query]);
  const selected = leadFixtures.find((lead) => lead.id === selectedLead) ?? leadFixtures[0];

  return (
    <div className="module-workspace sales-workspace">
      <StageZeroPageHeader
        icon="sales-crm"
        eyebrow={{ en: "Sales / Customer lifecycle", fa: "فروش و چرخه مشتری" }}
        title={{ en: "Sales & CRM", fa: "فروش و مشتریان" }}
        description={{ en: "A governed Stage 0 view of the lead-to-ownership journey for the current project.", fa: "نمای کنترل‌شده مرحله صفر از مسیر سرنخ تا مالکیت برای پروژه فعلی." }}
      >
        <button className="module-quiet-button" type="button" disabled title="Lead creation is not connected in Stage 0"><AppIcon name="sales-crm" size={16} />{localized({ en: "New lead unavailable", fa: "سرنخ جدید در دسترس نیست" }, locale)}</button>
      </StageZeroPageHeader>

      <StageZeroContextBar section={{ en: "Sales & CRM", fa: "فروش و مشتریان" }} />

      <section className="sales-lifecycle" aria-labelledby="sales-lifecycle-title">
        <div><p>{localized({ en: "Governed journey", fa: "مسیر کنترل‌شده" }, locale)}</p><h2 id="sales-lifecycle-title">{localized({ en: "Lead to ownership", fa: "از سرنخ تا مالکیت" }, locale)}</h2></div>
        <ol>{lifecycle.map((step, index) => <li key={step}><span>{index + 1}</span><small>{step}</small></li>)}</ol>
        <span className="sales-guardrail"><AppIcon name="shield" size={16} />{localized({ en: "Preview only · no reservation, posting, receipt, or verified customer action", fa: "فقط پیش‌نمایش · بدون رزرو، ثبت مالی، رسید یا اقدام تاییدشده مشتری" }, locale)}</span>
      </section>

      <section className="module-content-card" aria-labelledby="sales-workspace-title">
        <div className="module-card-heading">
          <div><p>{localized({ en: "Current project", fa: "پروژه فعلی" }, locale)}</p><h2 id="sales-workspace-title">Mazar Mall · {localized({ en: "Sales workspace", fa: "فضای کاری فروش" }, locale)}</h2></div>
          <span><i aria-hidden="true" />{localized({ en: "Synthetic presentation fixtures", fa: "نمونه‌های نمایشی ساختگی" }, locale)}</span>
        </div>
        <div className="module-toolbar sales-toolbar">
          <WorkspaceTabs label="Sales workspace sections" tabs={salesTabs} active={activeTab} onChange={setActiveTab} />
          {activeTab === "pipeline" ? <label className="module-search-field"><span className="sr-only">{localized({ en: "Search demo leads", fa: "جستجوی سرنخ‌های نمایشی" }, locale)}</span><AppIcon name="search" size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={localized({ en: "Search demo lead…", fa: "جستجوی سرنخ نمایشی…" }, locale)} /></label> : null}
        </div>

        {activeTab === "pipeline" ? (
          <div className="sales-pipeline-layout">
            <div>
              <div className="pipeline-summary" aria-label="Synthetic pipeline summary">
                {[{ label: "New", value: 1 }, { label: "Contacted", value: 1 }, { label: "Qualified", value: 1 }, { label: "Proposal", value: 1 }].map((stage) => <span key={stage.label}><small>{stage.label}</small><strong>{stage.value}</strong><em>DEMO</em></span>)}
              </div>
              <div className="demo-data-table" role="list" aria-label={localized({ en: "Synthetic lead pipeline", fa: "مسیر ساختگی سرنخ‌ها" }, locale)}>
                <div className="demo-table-header" aria-hidden="true"><span>{localized({ en: "Demo lead", fa: "سرنخ نمایشی" }, locale)}</span><span>{localized({ en: "Interest", fa: "علاقه‌مندی" }, locale)}</span><span>{localized({ en: "Source", fa: "منبع" }, locale)}</span><span>{localized({ en: "Stage", fa: "مرحله" }, locale)}</span><span>{localized({ en: "Age", fa: "عمر" }, locale)}</span></div>
                {visibleLeads.length ? visibleLeads.map((lead) => <div role="listitem" key={lead.id}><button type="button" aria-label={`Select ${lead.id} presentation fixture`} className={selected.id === lead.id ? "selected" : undefined} onClick={() => setSelectedLead(lead.id)}><strong>{lead.id}<small>NO CUSTOMER IDENTITY</small></strong><span>{lead.interest}</span><span>{lead.source}</span><span><i className={`lead-stage ${lead.stage.toLowerCase()}`}>{lead.stage}</i></span><span>{lead.age}</span></button></div>) : <WorkspaceEmptyState icon="search" title={{ en: "No matching demo leads", fa: "سرنخ نمایشی مطابق یافت نشد" }} description={{ en: "Change the search. No operational CRM service is connected.", fa: "جستجو را تغییر دهید. سرویس عملیاتی مشتریان متصل نیست." }} />}
              </div>
            </div>

            <aside className="lead-detail-panel" aria-live="polite">
              <div className="lead-detail-heading"><span><AppIcon name="sales-crm" size={20} /></span><div><small>{localized({ en: "Selected presentation fixture", fa: "نمونه نمایشی انتخاب‌شده" }, locale)}</small><h2>{selected.id}</h2></div><em>DEMO</em></div>
              <dl><div><dt>{localized({ en: "Interest", fa: "علاقه‌مندی" }, locale)}</dt><dd>{selected.interest}</dd></div><div><dt>{localized({ en: "Pipeline stage", fa: "مرحله مسیر" }, locale)}</dt><dd>{selected.stage}</dd></div><div><dt>{localized({ en: "Customer identity", fa: "هویت مشتری" }, locale)}</dt><dd>{localized({ en: "Not created", fa: "ایجاد نشده" }, locale)}</dd></div><div><dt>{localized({ en: "Financial status", fa: "وضعیت مالی" }, locale)}</dt><dd>{localized({ en: "No posting", fa: "بدون ثبت" }, locale)}</dd></div></dl>
              <div className="project-boundary-note"><AppIcon name="shield" size={17} /><p><strong>{localized({ en: "Protected boundary", fa: "مرز محافظت‌شده" }, locale)}</strong>{localized({ en: "This fixture cannot reserve a unit, create a contract, issue a receipt, or post a balance.", fa: "این نمونه نمی‌تواند واحد رزرو کند، قرارداد بسازد، رسید صادر کند یا مانده ثبت کند." }, locale)}</p></div>
            </aside>
          </div>
        ) : activeTab === "customers" ? <WorkspaceEmptyState icon="human-resources" title={{ en: "No verified customers connected", fa: "هیچ مشتری تاییدشده متصل نیست" }} description={{ en: "Customer identities, KYC, documents, and account balances require approved services and authorization.", fa: "هویت مشتری، شناخت مشتری، اسناد و مانده حساب به خدمات و مجوز تاییدشده نیاز دارد." }} />
          : activeTab === "contracts" ? <WorkspaceEmptyState icon="documents" title={{ en: "No operational contracts connected", fa: "هیچ قرارداد عملیاتی متصل نیست" }} description={{ en: "This Stage 0 interface does not create legal agreements, installment schedules, or receivables.", fa: "این رابط مرحله صفر قرارداد حقوقی، برنامه اقساط یا حساب دریافتنی ایجاد نمی‌کند." }} />
            : <WorkspaceEmptyState icon="coins" title={{ en: "Collections are outside this checkpoint", fa: "وصولات خارج از این مرحله است" }} description={{ en: "No receipt, settlement, customer balance, or financial posting is available in Stage 0.", fa: "هیچ رسید، تسویه، مانده مشتری یا ثبت مالی در مرحله صفر در دسترس نیست." }} />}
      </section>
    </div>
  );
}
