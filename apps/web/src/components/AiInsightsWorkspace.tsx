"use client";

import Link from "next/link";
import { FormEvent, useState } from "react";

import { AppIcon, type AppIconName } from "@/components/AppIcon";
import { useLocale } from "@/components/LocaleProvider";
import { StageZeroContextBar, StageZeroPageHeader, WorkspaceTabs, localized } from "@/components/StageZeroWorkspace";

const insightTabs = [
  { id: "insights", label: { en: "Illustrative insights", fa: "بینش‌های نمایشی" }, count: 4 },
  { id: "ask", label: { en: "Ask a question", fa: "طرح پرسش" } },
  { id: "sources", label: { en: "Sources & context", fa: "منابع و زمینه" }, count: 4 }
] as const;

const insightFixtures: ReadonlyArray<{
  id: string;
  icon: AppIconName;
  category: { en: string; fa: string };
  title: { en: string; fa: string };
  summary: { en: string; fa: string };
  interpretation: { en: string; fa: string };
  source: { en: string; fa: string };
  route: string;
  routeLabel: { en: string; fa: string };
  tone: string;
}> = [
  {
    id: "DEMO-INSIGHT-01",
    icon: "sales-crm",
    category: { en: "Sales & CRM", fa: "فروش و ارتباط با مشتری" },
    title: { en: "Pipeline composition review", fa: "بررسی ترکیب مسیر فروش" },
    summary: { en: "A future insight could compare verified lead stages and identify where management review may be needed.", fa: "یک بینش آینده می‌تواند مراحل تاییدشده سرنخ‌ها را مقایسه کرده و محل نیاز به بررسی مدیریت را مشخص سازد." },
    interpretation: { en: "Illustrative narrative only. No customer, lead, or conversion record was analyzed.", fa: "فقط روایت نمایشی است. هیچ سابقه مشتری، سرنخ یا تبدیل تحلیل نشده است." },
    source: { en: "Synthetic Sales & CRM fixture", fa: "نمونه ساختگی فروش و ارتباط با مشتری" },
    route: "/sales-crm",
    routeLabel: { en: "Open Sales & CRM", fa: "بازکردن فروش و مشتری" },
    tone: "blue"
  },
  {
    id: "DEMO-INSIGHT-02",
    icon: "construction",
    category: { en: "Construction", fa: "ساخت‌وساز" },
    title: { en: "Milestone review pattern", fa: "الگوی بررسی نقاط عطف" },
    summary: { en: "A future insight could highlight verified milestones whose supporting site updates require authorized review.", fa: "یک بینش آینده می‌تواند نقاط عطف تاییدشده‌ای را برجسته سازد که گزارش‌های ساحوی آن نیازمند بررسی مجاز است." },
    interpretation: { en: "Illustrative narrative only. No schedule, site evidence, or progress claim was verified.", fa: "فقط روایت نمایشی است. هیچ برنامه، سند ساحوی یا ادعای پیشرفت تایید نشده است." },
    source: { en: "Synthetic Construction fixture", fa: "نمونه ساختگی ساخت‌وساز" },
    route: "/construction",
    routeLabel: { en: "Open Construction", fa: "بازکردن ساخت‌وساز" },
    tone: "gold"
  },
  {
    id: "DEMO-INSIGHT-03",
    icon: "procurement",
    category: { en: "Procurement", fa: "تدارکات" },
    title: { en: "Supply status review", fa: "بررسی وضعیت تامین" },
    summary: { en: "A future insight could summarize approved requirements, orders, and delivery evidence for an authorized project team.", fa: "یک بینش آینده می‌تواند نیازمندی‌ها، سفارش‌ها و اسناد تحویل تصویب‌شده را برای تیم مجاز پروژه خلاصه کند." },
    interpretation: { en: "Illustrative narrative only. No supplier, purchase, liability, or delivery record was analyzed.", fa: "فقط روایت نمایشی است. هیچ سابقه تامین‌کننده، خرید، بدهی یا تحویل تحلیل نشده است." },
    source: { en: "Synthetic Procurement fixture", fa: "نمونه ساختگی تدارکات" },
    route: "/procurement",
    routeLabel: { en: "Open Procurement", fa: "بازکردن تدارکات" },
    tone: "cyan"
  },
  {
    id: "DEMO-INSIGHT-04",
    icon: "reports-analytics",
    category: { en: "Reports & Analytics", fa: "گزارش‌ها و تحلیل" },
    title: { en: "Reporting coverage check", fa: "بررسی پوشش گزارش‌دهی" },
    summary: { en: "A future insight could identify which governed reports have complete, traceable, and permission-appropriate sources.", fa: "یک بینش آینده می‌تواند مشخص سازد کدام گزارش‌های کنترل‌شده منابع کامل، قابل ردیابی و متناسب با مجوز دارند." },
    interpretation: { en: "Illustrative narrative only. No report was reconciled and no financial statement was generated.", fa: "فقط روایت نمایشی است. هیچ گزارشی تطبیق نشده و هیچ صورت مالی تولید نشده است." },
    source: { en: "Synthetic reporting fixture", fa: "نمونه ساختگی گزارش‌دهی" },
    route: "/reports-analytics",
    routeLabel: { en: "Open Reports & Analytics", fa: "بازکردن گزارش‌ها و تحلیل" },
    tone: "green"
  }
];

const suggestedQuestions = [
  { en: "Which project milestones may need management review?", fa: "کدام نقاط عطف پروژه ممکن است به بررسی مدیریت نیاز داشته باشد؟" },
  { en: "What source records support the sales pipeline overview?", fa: "کدام سوابق منبع از نمای کلی مسیر فروش پشتیبانی می‌کند؟" },
  { en: "Which report categories are available for this project?", fa: "کدام دسته‌های گزارش برای این پروژه در دسترس است؟" }
] as const;

export function AiInsightsWorkspace() {
  const { locale } = useLocale();
  const [activeTab, setActiveTab] = useState("insights");
  const [selectedId, setSelectedId] = useState(insightFixtures[0]!.id);
  const [question, setQuestion] = useState("");
  const [stagedQuestion, setStagedQuestion] = useState("");
  const selected = insightFixtures.find((insight) => insight.id === selectedId) ?? insightFixtures[0]!;

  function stageQuestion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedQuestion = question.trim();
    if (trimmedQuestion) {
      setStagedQuestion(trimmedQuestion);
    }
  }

  return (
    <div className="module-workspace aiw-workspace">
      <StageZeroPageHeader
        icon="ai-insights"
        eyebrow={{ en: "Intelligence / Governed preview", fa: "هوشمندی و پیش‌نمایش کنترل‌شده" }}
        title={{ en: "AI Insights", fa: "بینش‌های هوش مصنوعی" }}
        description={{ en: "A Stage 0 preview of authorized questions, illustrative insights, supporting context, and module navigation.", fa: "پیش‌نمایش مرحله صفر پرسش‌های مجاز، بینش‌های نمایشی، زمینه پشتیبان و هدایت به بخش‌ها." }}
      >
        <button className="module-quiet-button" type="button" disabled title={localized({ en: "No live AI model is connected in Stage 0", fa: "هیچ مدل زنده هوش مصنوعی در مرحله صفر متصل نیست" }, locale)}>
          <AppIcon name="shield" size={16} />{localized({ en: "Live AI offline", fa: "هوش مصنوعی زنده آفلاین" }, locale)}
        </button>
      </StageZeroPageHeader>

      <StageZeroContextBar section={{ en: "AI Insights preview", fa: "پیش‌نمایش بینش‌های هوشمند" }} />

      <section className="aiw-boundary-banner" aria-label={localized({ en: "AI Insights Stage 0 boundary", fa: "مرز بینش هوشمند مرحله صفر" }, locale)}>
        <span aria-hidden="true"><AppIcon name="sparkles" size={22} /></span>
        <div>
          <p>{localized({ en: "ILLUSTRATIVE EXPERIENCE ONLY", fa: "فقط تجربه نمایشی" }, locale)}</p>
          <strong>{localized({ en: "No live model, verified findings, permission bypass, or executable actions", fa: "بدون مدل زنده، یافته تاییدشده، دورزدن مجوز یا عملیات اجرایی" }, locale)}</strong>
        </div>
        <em>DEMO DATA</em>
      </section>

      <section className="module-content-card" aria-labelledby="aiw-workspace-title">
        <div className="module-card-heading">
          <div>
            <p>{localized({ en: "Authorized decision support", fa: "پشتیبانی مجاز تصمیم‌گیری" }, locale)}</p>
            <h2 id="aiw-workspace-title">{localized({ en: "Insights review workspace", fa: "فضای کاری بررسی بینش‌ها" }, locale)}</h2>
          </div>
          <span><i aria-hidden="true" />{localized({ en: "Synthetic narratives · not AI findings", fa: "روایت‌های ساختگی · نه یافته هوش مصنوعی" }, locale)}</span>
        </div>

        <div className="module-toolbar">
          <WorkspaceTabs label="AI Insights workspace sections" tabs={insightTabs} active={activeTab} onChange={setActiveTab} />
        </div>

        {activeTab === "insights" ? (
          <div className="aiw-insights-layout">
            <div className="aiw-insight-list" role="list" aria-label={localized({ en: "Illustrative insight list", fa: "فهرست بینش‌های نمایشی" }, locale)}>
              <div className="aiw-list-heading">
                <span>{localized({ en: "Sample management narrative", fa: "روایت نمونه مدیریتی" }, locale)}</span>
                <strong>DEMO DATA</strong>
              </div>
              {insightFixtures.map((insight) => (
                <div role="listitem" key={insight.id}>
                  <button type="button" className={selected.id === insight.id ? "selected" : undefined} aria-pressed={selected.id === insight.id} aria-label={`${localized({ en: "Select", fa: "انتخاب" }, locale)} ${localized(insight.title, locale)} ${localized({ en: "illustrative insight", fa: "بینش نمایشی" }, locale)}`} onClick={() => setSelectedId(insight.id)}>
                    <span className={`aiw-insight-icon ${insight.tone}`} aria-hidden="true"><AppIcon name={insight.icon} size={19} /></span>
                    <span className="aiw-insight-copy">
                      <small>{localized(insight.category, locale)} · {insight.id}</small>
                      <strong>{localized(insight.title, locale)}</strong>
                      <em>{localized(insight.summary, locale)}</em>
                    </span>
                    <span className="aiw-illustrative-chip">{localized({ en: "ILLUSTRATIVE", fa: "نمایشی" }, locale)}</span>
                    <AppIcon name="chevron" size={15} />
                  </button>
                </div>
              ))}
            </div>

            <aside className="aiw-insight-detail" aria-live="polite">
              <div className="aiw-detail-heading">
                <span className={`aiw-insight-icon ${selected.tone}`} aria-hidden="true"><AppIcon name={selected.icon} size={23} /></span>
                <div><p>{selected.id} · DEMO DATA</p><h2>{localized(selected.title, locale)}</h2></div>
              </div>
              <p className="aiw-detail-summary">{localized(selected.summary, locale)}</p>
              <div className="aiw-context-block">
                <span><AppIcon name="database" size={17} /></span>
                <div><small>{localized({ en: "Illustrative supporting source", fa: "منبع پشتیبان نمایشی" }, locale)}</small><strong>{localized(selected.source, locale)}</strong><p>{localized({ en: "This fixture is not verified evidence and is not connected to an operational service.", fa: "این نمونه سند تاییدشده نیست و به سرویس عملیاتی متصل نمی‌باشد." }, locale)}</p></div>
              </div>
              <div className="aiw-caution-block">
                <AppIcon name="alert" size={17} />
                <p><strong>{localized({ en: "Interpretation boundary", fa: "مرز تفسیر" }, locale)}</strong>{localized(selected.interpretation, locale)}</p>
              </div>
              <Link className="aiw-module-link" href={selected.route}><span>{localized(selected.routeLabel, locale)}</span><AppIcon name="arrow" size={16} /></Link>
            </aside>
          </div>
        ) : null}

        {activeTab === "ask" ? (
          <div className="aiw-ask-layout">
            <section className="aiw-question-panel" aria-labelledby="aiw-question-title">
              <p>{localized({ en: "AUTHORIZED QUESTION PREVIEW", fa: "پیش‌نمایش پرسش مجاز" }, locale)}</p>
              <h2 id="aiw-question-title">{localized({ en: "Ask about approved project information", fa: "درباره اطلاعات تصویب‌شده پروژه بپرسید" }, locale)}</h2>
              <span>{localized({ en: "Questions are staged in this browser only. Nothing is sent to an AI model, saved, or executed.", fa: "پرسش‌ها فقط در این مرورگر آماده می‌شود. هیچ چیزی به مدل هوش مصنوعی ارسال، ذخیره یا اجرا نمی‌شود." }, locale)}</span>
              <form onSubmit={stageQuestion}>
                <label htmlFor="aiw-question">{localized({ en: "Management question", fa: "پرسش مدیریتی" }, locale)}</label>
                <div>
                  <AppIcon name="search" size={18} />
                  <input id="aiw-question" value={question} onChange={(event) => setQuestion(event.target.value)} placeholder={localized({ en: "Ask about a project, report, or operational area...", fa: "درباره پروژه، گزارش یا بخش عملیاتی بپرسید..." }, locale)} />
                  <button type="submit" disabled={!question.trim()}>{localized({ en: "Stage question", fa: "آماده‌سازی پرسش" }, locale)}<AppIcon name="arrow" size={15} /></button>
                </div>
              </form>
              <div className="aiw-suggestions" aria-label={localized({ en: "Suggested demonstration questions", fa: "پرسش‌های نمایشی پیشنهادی" }, locale)}>
                <small>{localized({ en: "Suggested questions", fa: "پرسش‌های پیشنهادی" }, locale)}</small>
                <div>{suggestedQuestions.map((suggestion) => <button type="button" key={suggestion.en} onClick={() => { setQuestion(localized(suggestion, locale)); setStagedQuestion(""); }}>{localized(suggestion, locale)}</button>)}</div>
              </div>
            </section>

            <aside className="aiw-response-preview" role="status" aria-live="polite">
              <span aria-hidden="true"><AppIcon name="ai-insights" size={25} /></span>
              <p>{localized({ en: "RESPONSE PREVIEW", fa: "پیش‌نمایش پاسخ" }, locale)}</p>
              <h2>{stagedQuestion ? localized({ en: "Question staged locally", fa: "پرسش به‌صورت محلی آماده شد" }, locale) : localized({ en: "No question staged", fa: "هیچ پرسشی آماده نشده" }, locale)}</h2>
              {stagedQuestion ? <blockquote>{stagedQuestion}</blockquote> : <small>{localized({ en: "Choose a suggestion or enter a question to preview the future interaction.", fa: "یک پیشنهاد را انتخاب کنید یا پرسشی وارد نمایید تا تعامل آینده را پیش‌نمایش کنید." }, locale)}</small>}
              <div><AppIcon name="shield" size={16} /><p><strong>{localized({ en: "No AI response generated", fa: "هیچ پاسخ هوش مصنوعی تولید نشد" }, locale)}</strong>{localized({ en: "A future governed service must enforce authorization, cite traceable sources, and keep all resulting actions separate and approval-controlled.", fa: "سرویس کنترل‌شده آینده باید مجوزها را اعمال کند، منابع قابل ردیابی را ذکر نماید و تمام عملیات نتیجه‌شده را جدا و تحت تایید نگه دارد." }, locale)}</p></div>
            </aside>
          </div>
        ) : null}

        {activeTab === "sources" ? (
          <div className="aiw-source-layout">
            <div className="aiw-source-intro">
              <span aria-hidden="true"><AppIcon name="database" size={23} /></span>
              <div><p>{localized({ en: "SOURCE TRANSPARENCY", fa: "شفافیت منبع" }, locale)}</p><h2>{localized({ en: "Illustrative context register", fa: "ثبت زمینه نمایشی" }, locale)}</h2><small>{localized({ en: "These entries demonstrate future traceability. They are synthetic fixtures, not live records or verified evidence.", fa: "این موارد ردیابی آینده را نمایش می‌دهد. آن‌ها نمونه‌های ساختگی‌اند، نه سوابق زنده یا اسناد تاییدشده." }, locale)}</small></div>
            </div>
            <div className="aiw-source-table" role="table" aria-label={localized({ en: "Illustrative insight sources", fa: "منابع بینش نمایشی" }, locale)}>
              <div role="row" className="aiw-source-row aiw-source-header"><span role="columnheader">{localized({ en: "Source fixture", fa: "نمونه منبع" }, locale)}</span><span role="columnheader">{localized({ en: "Module", fa: "بخش" }, locale)}</span><span role="columnheader">{localized({ en: "Evidence state", fa: "وضعیت سند" }, locale)}</span><span role="columnheader">{localized({ en: "Access", fa: "دسترسی" }, locale)}</span></div>
              {insightFixtures.map((insight) => <div role="row" className="aiw-source-row" key={insight.id}><span role="cell"><b>{localized(insight.source, locale)}</b><small>{insight.id}</small></span><span role="cell">{localized(insight.category, locale)}</span><span role="cell"><em>{localized({ en: "Synthetic · unverified", fa: "ساختگی · تاییدنشده" }, locale)}</em></span><span role="cell"><Link href={insight.route}>{localized({ en: "View module", fa: "مشاهده بخش" }, locale)}<AppIcon name="chevron" size={14} /></Link></span></div>)}
            </div>
            <div className="aiw-source-note"><AppIcon name="shield" size={17} /><p><strong>{localized({ en: "Permission-aware by design", fa: "طراحی مبتنی بر مجوز" }, locale)}</strong>{localized({ en: "A future AI service may cite only records the current user is independently authorized to view. This preview does not test or bypass permissions.", fa: "سرویس هوش مصنوعی آینده فقط می‌تواند سوابقی را ذکر کند که کاربر فعلی مستقلاً مجاز به مشاهده آن است. این پیش‌نمایش مجوزها را آزمایش یا دور نمی‌زند." }, locale)}</p></div>
          </div>
        ) : null}
      </section>
    </div>
  );
}
