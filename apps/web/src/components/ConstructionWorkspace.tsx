"use client";

import { useState } from "react";

import { AppIcon } from "@/components/AppIcon";
import { useLocale } from "@/components/LocaleProvider";
import { StageZeroContextBar, StageZeroPageHeader, WorkspaceTabs, localized } from "@/components/StageZeroWorkspace";

const constructionTabs = [
  { id: "overview", label: { en: "Progress overview", fa: "نمای کلی پیشرفت" } },
  { id: "milestones", label: { en: "Milestones", fa: "نقاط عطف" }, count: 4 },
  { id: "areas", label: { en: "Work areas", fa: "ساحات کاری" }, count: 3 },
  { id: "updates", label: { en: "Site updates", fa: "به‌روزرسانی ساحه" }, count: 3 }
] as const;

const workAreas = [
  { id: "DEMO-WA-01", name: { en: "Demo Wing A", fa: "بال نمایشی الف" }, discipline: { en: "Structural envelope", fa: "پوشش سازه‌ای" }, progress: 72, state: { en: "Illustrative on track", fa: "نمایشی مطابق برنامه" }, tone: "blue" },
  { id: "DEMO-WA-02", name: { en: "Demo Wing B", fa: "بال نمایشی ب" }, discipline: { en: "Interior coordination", fa: "هماهنگی داخلی" }, progress: 58, state: { en: "Illustrative review", fa: "بررسی نمایشی" }, tone: "gold" },
  { id: "DEMO-WA-03", name: { en: "Demo Services Core", fa: "هسته خدمات نمایشی" }, discipline: { en: "MEP coordination", fa: "هماهنگی تاسیسات" }, progress: 43, state: { en: "Illustrative planned", fa: "برنامه نمایشی" }, tone: "cyan" }
] as const;

const milestones = [
  { id: "DEMO-M01", name: { en: "Envelope coordination review", fa: "بررسی هماهنگی پوشش" }, timing: { en: "Illustrative · Week 1", fa: "نمایشی · هفته ۱" }, state: { en: "Demo complete", fa: "تکمیل نمایشی" } },
  { id: "DEMO-M02", name: { en: "Typical floor mock-up review", fa: "بررسی نمونه طبقه معمول" }, timing: { en: "Illustrative · Week 2", fa: "نمایشی · هفته ۲" }, state: { en: "Demo in review", fa: "بررسی نمایشی" } },
  { id: "DEMO-M03", name: { en: "Services coordination checkpoint", fa: "نقطه کنترل هماهنگی خدمات" }, timing: { en: "Illustrative · Week 3", fa: "نمایشی · هفته ۳" }, state: { en: "Demo planned", fa: "برنامه نمایشی" } },
  { id: "DEMO-M04", name: { en: "Quality walk-through", fa: "بازدید کیفیت" }, timing: { en: "Illustrative · Week 4", fa: "نمایشی · هفته ۴" }, state: { en: "Demo planned", fa: "برنامه نمایشی" } }
] as const;

const siteUpdates = [
  { id: "DEMO-U01", area: { en: "Demo Wing A", fa: "بال نمایشی الف" }, title: { en: "Coordination review recorded", fa: "بررسی هماهنگی ثبت شد" }, detail: { en: "Illustrative note · no verified field record", fa: "یادداشت نمایشی · بدون سابقه تاییدشده ساحه" } },
  { id: "DEMO-U02", area: { en: "Demo Wing B", fa: "بال نمایشی ب" }, title: { en: "Mock-up review prepared", fa: "بررسی نمونه آماده شد" }, detail: { en: "Illustrative note · no approval workflow", fa: "یادداشت نمایشی · بدون روند تایید" } },
  { id: "DEMO-U03", area: { en: "Demo Services Core", fa: "هسته خدمات نمایشی" }, title: { en: "Coordination checkpoint outlined", fa: "نقطه کنترل هماهنگی مشخص شد" }, detail: { en: "Illustrative note · no operational schedule", fa: "یادداشت نمایشی · بدون برنامه عملیاتی" } }
] as const;

export function ConstructionWorkspace() {
  const { locale } = useLocale();
  const [activeTab, setActiveTab] = useState("overview");
  const [selectedArea, setSelectedArea] = useState("DEMO-WA-01");
  const selected = workAreas.find((area) => area.id === selectedArea) ?? workAreas[0];

  return (
    <div className="module-workspace construction-workspace">
      <StageZeroPageHeader
        icon="construction"
        eyebrow={{ en: "Delivery / Site visibility", fa: "تحویل و دید ساحه" }}
        title={{ en: "Construction", fa: "ساخت‌وساز" }}
        description={{ en: "A project-scoped Stage 0 preview for progress, milestones, work areas, and site updates.", fa: "پیش‌نمایش مرحله صفر در سطح پروژه برای پیشرفت، نقاط عطف، ساحات کاری و به‌روزرسانی ساحه." }}
      >
        <button className="module-quiet-button" type="button" disabled title="Site update creation is not connected in Stage 0"><AppIcon name="construction" size={16} />{localized({ en: "New update unavailable", fa: "به‌روزرسانی جدید در دسترس نیست" }, locale)}</button>
      </StageZeroPageHeader>

      <StageZeroContextBar section={{ en: "Construction preview", fa: "پیش‌نمایش ساخت‌وساز" }} />

      <section className="construction-summary" aria-label={localized({ en: "Synthetic construction summary", fa: "خلاصه ساخت‌وساز ساختگی" }, locale)}>
        <div><span aria-hidden="true"><AppIcon name="construction" size={22} /></span><small>{localized({ en: "Demo work areas", fa: "ساحات کاری نمایشی" }, locale)}</small><strong>3</strong><em>DEMO</em></div>
        <div><span aria-hidden="true"><AppIcon name="pin" size={22} /></span><small>{localized({ en: "Demo milestones", fa: "نقاط عطف نمایشی" }, locale)}</small><strong>4</strong><em>DEMO</em></div>
        <div><span aria-hidden="true"><AppIcon name="database" size={22} /></span><small>{localized({ en: "Operational records", fa: "سوابق عملیاتی" }, locale)}</small><strong>0</strong><em>{localized({ en: "NOT CONNECTED", fa: "متصل نیست" }, locale)}</em></div>
        <p><AppIcon name="shield" size={15} />{localized({ en: "Illustrative progress only · no certified quantities, costs, approvals, or financial posting", fa: "فقط پیشرفت نمایشی · بدون مقادیر تاییدشده، هزینه، تایید یا ثبت مالی" }, locale)}</p>
      </section>

      <section className="module-content-card" aria-labelledby="construction-workspace-title">
        <div className="module-card-heading">
          <div><p>{localized({ en: "Mazar Mall presentation context", fa: "زمینه نمایشی مزار مال" }, locale)}</p><h2 id="construction-workspace-title">{localized({ en: "Construction workspace", fa: "فضای کاری ساخت‌وساز" }, locale)}</h2></div>
          <span><i aria-hidden="true" />{localized({ en: "Synthetic presentation fixtures", fa: "نمونه‌های نمایشی ساختگی" }, locale)}</span>
        </div>
        <div className="module-toolbar">
          <WorkspaceTabs label="Construction workspace sections" tabs={constructionTabs} active={activeTab} onChange={setActiveTab} />
        </div>

        {activeTab === "overview" ? (
          <div className="construction-overview-layout">
            <div className="construction-area-list" role="list" aria-label={localized({ en: "Synthetic work area progress", fa: "پیشرفت ساختگی ساحات کاری" }, locale)}>
              <div className="construction-list-heading"><span>{localized({ en: "Demo work area", fa: "ساحه کاری نمایشی" }, locale)}</span><span>{localized({ en: "Illustrative progress", fa: "پیشرفت نمایشی" }, locale)}</span></div>
              {workAreas.map((area) => <div role="listitem" key={area.id}><button type="button" className={selected.id === area.id ? "selected" : undefined} aria-label={`Select ${area.id} demo work area`} onClick={() => setSelectedArea(area.id)}><span className={`construction-area-icon ${area.tone}`}><AppIcon name="building" size={19} /></span><span className="construction-area-copy"><strong>{localized(area.name, locale)}</strong><small>{area.id} · {localized(area.discipline, locale)}</small></span><span className="construction-progress"><b>{area.progress}%</b><i><em style={{ width: `${area.progress}%` }} /></i><small>{localized(area.state, locale)}</small></span><AppIcon name="chevron" size={15} /></button></div>)}
            </div>
            <aside className="construction-detail-panel" aria-live="polite">
              <p>{selected.id}</p><h2>{localized(selected.name, locale)}</h2><span>{localized(selected.discipline, locale)}</span>
              <div className="construction-detail-meter"><strong>{selected.progress}%</strong><small>{localized({ en: "Illustrative progress", fa: "پیشرفت نمایشی" }, locale)}</small><i><em style={{ width: `${selected.progress}%` }} /></i></div>
              <dl>
                <div><dt>{localized({ en: "Current state", fa: "وضعیت فعلی" }, locale)}</dt><dd>{localized(selected.state, locale)}</dd></div>
                <div><dt>{localized({ en: "Schedule source", fa: "منبع برنامه" }, locale)}</dt><dd>{localized({ en: "Not connected", fa: "متصل نیست" }, locale)}</dd></div>
                <div><dt>{localized({ en: "Verified field evidence", fa: "شواهد تاییدشده ساحه" }, locale)}</dt><dd>{localized({ en: "Unavailable", fa: "در دسترس نیست" }, locale)}</dd></div>
              </dl>
              <div><AppIcon name="shield" size={16} /><p><strong>{localized({ en: "Stage 0 boundary", fa: "مرز مرحله صفر" }, locale)}</strong>{localized({ en: "No quantities, costs, contractor certifications, approvals, or accounting effects are connected.", fa: "هیچ مقدار، هزینه، تصدیق قراردادی، تایید یا اثر حسابداری متصل نیست." }, locale)}</p></div>
            </aside>
          </div>
        ) : null}

        {activeTab === "milestones" ? <div className="construction-record-list" aria-label={localized({ en: "Synthetic milestones", fa: "نقاط عطف ساختگی" }, locale)}>{milestones.map((item, index) => <article key={item.id}><span>{index + 1}</span><div><p>{item.id} · DEMO</p><h3>{localized(item.name, locale)}</h3><small>{localized(item.timing, locale)}</small></div><em>{localized(item.state, locale)}</em></article>)}</div> : null}

        {activeTab === "areas" ? <div className="construction-area-cards">{workAreas.map((area) => <article key={area.id}><span className={`construction-area-icon ${area.tone}`}><AppIcon name="building" size={21} /></span><p>{area.id} · DEMO</p><h3>{localized(area.name, locale)}</h3><small>{localized(area.discipline, locale)}</small><div><b>{area.progress}%</b><i><em style={{ width: `${area.progress}%` }} /></i></div><strong>{localized({ en: "No verified field data", fa: "بدون داده تاییدشده ساحه" }, locale)}</strong></article>)}</div> : null}

        {activeTab === "updates" ? <div className="construction-record-list site-update-list" aria-label={localized({ en: "Synthetic site updates", fa: "به‌روزرسانی ساختگی ساحه" }, locale)}>{siteUpdates.map((item) => <article key={item.id}><span><AppIcon name="documents" size={17} /></span><div><p>{item.id} · {localized(item.area, locale)}</p><h3>{localized(item.title, locale)}</h3><small>{localized(item.detail, locale)}</small></div><em>{localized({ en: "READ-ONLY DEMO", fa: "نمایش فقط‌خواندنی" }, locale)}</em></article>)}</div> : null}
      </section>
    </div>
  );
}
