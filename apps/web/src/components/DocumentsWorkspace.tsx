"use client";

import { useMemo, useState } from "react";

import { AppIcon, type AppIconName } from "@/components/AppIcon";
import { useLocale } from "@/components/LocaleProvider";
import { StageZeroContextBar, StageZeroPageHeader, WorkspaceTabs, localized } from "@/components/StageZeroWorkspace";

type LocalizedCopy = Readonly<{ en: string; fa: string }>;
type DocumentCategory = "all" | "drawings" | "contracts" | "financial" | "project-records";

const documentTabs: ReadonlyArray<{ id: DocumentCategory; label: LocalizedCopy; count?: number }> = [
  { id: "all", label: { en: "All fixtures", fa: "همه نمونه‌ها" }, count: 4 },
  { id: "drawings", label: { en: "Drawings", fa: "نقشه‌ها" }, count: 1 },
  { id: "contracts", label: { en: "Contracts", fa: "قراردادها" }, count: 1 },
  { id: "financial", label: { en: "Financial", fa: "مالی" }, count: 1 },
  { id: "project-records", label: { en: "Project records", fa: "سوابق پروژه" }, count: 1 }
];

const categoryMeta: Record<Exclude<DocumentCategory, "all">, { label: LocalizedCopy; icon: AppIconName }> = {
  drawings: { label: { en: "Drawing sample", fa: "نمونه نقشه" }, icon: "building" },
  contracts: { label: { en: "Contract structure", fa: "ساختار قرارداد" }, icon: "documents" },
  financial: { label: { en: "Financial document structure", fa: "ساختار سند مالی" }, icon: "finance" },
  "project-records": { label: { en: "Project record sample", fa: "نمونه سابقه پروژه" }, icon: "construction" }
};

const documentFixtures: ReadonlyArray<{
  id: string;
  title: LocalizedCopy;
  description: LocalizedCopy;
  category: Exclude<DocumentCategory, "all">;
  format: string;
  revision: LocalizedCopy;
  date: LocalizedCopy;
  owner: LocalizedCopy;
  state: LocalizedCopy;
  pages: LocalizedCopy;
  availability: "preview" | "metadata";
  tone: string;
}> = [
  {
    id: "DEMO-DOC-001",
    title: { en: "Illustrative drawing register entry", fa: "مورد نمایشی ثبت نقشه" },
    description: { en: "A synthetic placeholder showing how an authorized project drawing could be indexed.", fa: "جای‌نگهدار ساختگی برای نمایش چگونگی فهرست‌شدن یک نقشه مجاز پروژه." },
    category: "drawings",
    format: "PDF · DEMO",
    revision: { en: "Sample revision A", fa: "بازنگری نمونه الف" },
    date: { en: "Illustrative date", fa: "تاریخ نمایشی" },
    owner: { en: "Document control fixture", fa: "نمونه کنترل اسناد" },
    state: { en: "Preview only", fa: "فقط پیش‌نمایش" },
    pages: { en: "Page count unavailable", fa: "تعداد صفحه در دسترس نیست" },
    availability: "preview",
    tone: "blue"
  },
  {
    id: "DEMO-DOC-002",
    title: { en: "Illustrative contract index entry", fa: "مورد نمایشی فهرست قرارداد" },
    description: { en: "A generic contract-category fixture without a party, customer, value, or binding terms.", fa: "نمونه عمومی دسته قرارداد بدون طرف، مشتری، ارزش یا شرایط الزام‌آور." },
    category: "contracts",
    format: "DOC · DEMO",
    revision: { en: "Structure sample", fa: "نمونه ساختار" },
    date: { en: "Illustrative date", fa: "تاریخ نمایشی" },
    owner: { en: "Authorized records fixture", fa: "نمونه سوابق مجاز" },
    state: { en: "Metadata only", fa: "فقط فراداده" },
    pages: { en: "Content not connected", fa: "محتوا متصل نیست" },
    availability: "metadata",
    tone: "gold"
  },
  {
    id: "DEMO-DOC-003",
    title: { en: "Illustrative financial-file index", fa: "فهرست نمایشی پرونده مالی" },
    description: { en: "A non-operational category sample with no statement, balance, voucher, or ledger data.", fa: "نمونه دسته غیرعملیاتی بدون صورت، مانده، سند یا داده دفتر." },
    category: "financial",
    format: "XLS · DEMO",
    revision: { en: "Interface fixture", fa: "نمونه رابط" },
    date: { en: "Illustrative date", fa: "تاریخ نمایشی" },
    owner: { en: "Reporting structure fixture", fa: "نمونه ساختار گزارش‌دهی" },
    state: { en: "No financial record", fa: "بدون سابقه مالی" },
    pages: { en: "Preview unavailable", fa: "پیش‌نمایش در دسترس نیست" },
    availability: "metadata",
    tone: "green"
  },
  {
    id: "DEMO-DOC-004",
    title: { en: "Illustrative project-note entry", fa: "مورد نمایشی یادداشت پروژه" },
    description: { en: "A synthetic project-record placeholder for interface and navigation review.", fa: "جای‌نگهدار ساختگی سابقه پروژه برای بررسی رابط و پیمایش." },
    category: "project-records",
    format: "PDF · DEMO",
    revision: { en: "Sample issue 01", fa: "نسخه نمونه ۰۱" },
    date: { en: "Illustrative date", fa: "تاریخ نمایشی" },
    owner: { en: "Project coordination fixture", fa: "نمونه هماهنگی پروژه" },
    state: { en: "Read-only demo", fa: "نمایش فقط‌خواندنی" },
    pages: { en: "Page count unavailable", fa: "تعداد صفحه در دسترس نیست" },
    availability: "preview",
    tone: "cyan"
  }
];

const stateOptions = [
  { id: "all", label: { en: "All preview states", fa: "همه وضعیت‌های پیش‌نمایش" } },
  { id: "preview", label: { en: "Preview available", fa: "پیش‌نمایش موجود" } },
  { id: "metadata", label: { en: "Metadata only", fa: "فقط فراداده" } }
] as const;

export function DocumentsWorkspace() {
  const { locale } = useLocale();
  const [activeCategory, setActiveCategory] = useState<DocumentCategory>("all");
  const [query, setQuery] = useState("");
  const [stateFilter, setStateFilter] = useState("all");
  const [selectedId, setSelectedId] = useState(documentFixtures[0]!.id);

  const visibleDocuments = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return documentFixtures.filter((document) => {
      const categoryMatches = activeCategory === "all" || document.category === activeCategory;
      const searchMatches = !normalizedQuery || [document.id, document.title.en, document.title.fa, document.owner.en, document.owner.fa]
        .some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
      const stateMatches = stateFilter === "all"
        || stateFilter === document.availability;
      return categoryMatches && searchMatches && stateMatches;
    });
  }, [activeCategory, query, stateFilter]);

  const selected = documentFixtures.find((document) => document.id === selectedId) ?? documentFixtures[0]!;
  const selectedCategory = categoryMeta[selected.category];

  function selectCategory(id: string) {
    const category = id as DocumentCategory;
    setActiveCategory(category);
    const nextDocument = documentFixtures.find((document) => category === "all" || document.category === category);
    if (nextDocument) setSelectedId(nextDocument.id);
  }

  return (
    <div className="module-workspace docw-workspace">
      <StageZeroPageHeader
        icon="documents"
        eyebrow={{ en: "Records / Controlled discovery", fa: "سوابق و جستجوی کنترل‌شده" }}
        title={{ en: "Documents", fa: "اسناد" }}
        description={{ en: "A Stage 0 preview for finding and reviewing authorized project-document metadata.", fa: "پیش‌نمایش مرحله صفر برای یافتن و بررسی فراداده اسناد مجاز پروژه." }}
      >
        <button className="module-quiet-button" type="button" disabled title={localized({ en: "Document actions are unavailable in Stage 0", fa: "عملیات اسناد در مرحله صفر در دسترس نیست" }, locale)}>
          <AppIcon name="shield" size={16} />{localized({ en: "Document actions locked", fa: "عملیات اسناد قفل است" }, locale)}
        </button>
      </StageZeroPageHeader>

      <StageZeroContextBar section={{ en: "Document management preview", fa: "پیش‌نمایش مدیریت اسناد" }} />

      <section className="docw-boundary" aria-label={localized({ en: "Documents Stage 0 boundary", fa: "مرز اسناد مرحله صفر" }, locale)}>
        <span aria-hidden="true"><AppIcon name="shield" size={21} /></span>
        <div>
          <p>{localized({ en: "CONTROLLED PREVIEW · DEMO DATA", fa: "پیش‌نمایش کنترل‌شده · داده نمایشی" }, locale)}</p>
          <strong>{localized({ en: "No real storage, sharing, approvals, signing, or unrestricted downloads", fa: "بدون ذخیره‌سازی واقعی، اشتراک‌گذاری، تایید، امضا یا دانلود نامحدود" }, locale)}</strong>
        </div>
        <em>DEMO DATA</em>
      </section>

      <section className="module-content-card" aria-labelledby="docw-workspace-title">
        <div className="module-card-heading">
          <div>
            <p>{localized({ en: "Mazar Mall presentation context", fa: "زمینه نمایشی مزار مال" }, locale)}</p>
            <h2 id="docw-workspace-title">{localized({ en: "Document discovery workspace", fa: "فضای کاری جستجوی اسناد" }, locale)}</h2>
          </div>
          <span><i aria-hidden="true" />{localized({ en: "Synthetic metadata only", fa: "فقط فراداده ساختگی" }, locale)}</span>
        </div>

        <div className="docw-controls" aria-label={localized({ en: "Document search and filters", fa: "جستجو و فیلتر اسناد" }, locale)}>
          <label className="docw-search" htmlFor="docw-search-input">
            <span>{localized({ en: "Search demo metadata", fa: "جستجوی فراداده نمایشی" }, locale)}</span>
            <span><AppIcon name="search" size={18} /><input id="docw-search-input" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={localized({ en: "Search title, fixture ID, or context…", fa: "جستجوی عنوان، شناسه نمونه یا زمینه…" }, locale)} /></span>
          </label>
          <label className="docw-filter">
            <span>{localized({ en: "Preview state", fa: "وضعیت پیش‌نمایش" }, locale)}</span>
            <select value={stateFilter} onChange={(event) => setStateFilter(event.target.value)}>
              {stateOptions.map((option) => <option value={option.id} key={option.id}>{localized(option.label, locale)}</option>)}
            </select>
          </label>
          <div className="docw-source-state"><AppIcon name="database" size={18} /><span><small>{localized({ en: "Repository state", fa: "وضعیت مخزن" }, locale)}</small><strong>{localized({ en: "Fixture metadata · offline", fa: "فراداده نمونه · آفلاین" }, locale)}</strong></span></div>
        </div>

        <div className="module-toolbar"><WorkspaceTabs label="Document categories" tabs={documentTabs} active={activeCategory} onChange={selectCategory} /></div>

        <div className="docw-browser-layout">
          <section className="docw-index" aria-labelledby="docw-index-title">
            <div className="docw-index-heading">
              <div><p>DEMO DATA</p><h3 id="docw-index-title">{localized({ en: "Synthetic document index", fa: "فهرست ساختگی اسناد" }, locale)}</h3></div>
              <span>{visibleDocuments.length} {localized({ en: "fixtures", fa: "نمونه" }, locale)}</span>
            </div>
            {visibleDocuments.length ? (
              <div className="docw-list" role="list" aria-label={localized({ en: "Synthetic document fixtures", fa: "نمونه‌های ساختگی اسناد" }, locale)}>
                {visibleDocuments.map((document) => {
                  const category = categoryMeta[document.category];
                  return (
                    <div role="listitem" key={document.id}>
                      <button type="button" className={selected.id === document.id ? "selected" : undefined} aria-pressed={selected.id === document.id} aria-label={`${localized({ en: "Preview", fa: "پیش‌نمایش" }, locale)} ${localized(document.title, locale)}`} onClick={() => setSelectedId(document.id)}>
                        <span className={`docw-file-icon ${document.tone}`} aria-hidden="true"><AppIcon name={category.icon} size={20} /></span>
                        <span className="docw-file-copy"><small>{document.id} · {document.format}</small><strong>{localized(document.title, locale)}</strong><em>{localized(category.label, locale)} · {localized(document.owner, locale)}</em></span>
                        <span className="docw-file-state"><b>{localized(document.state, locale)}</b><small>{localized(document.revision, locale)}</small></span>
                        <AppIcon name="chevron" size={15} />
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="docw-empty" role="status"><AppIcon name="search" size={25} /><h3>{localized({ en: "No demo metadata matches", fa: "هیچ فراداده نمایشی مطابقت ندارد" }, locale)}</h3><p>{localized({ en: "Change the search or filters to review another synthetic fixture.", fa: "جستجو یا فیلتر را تغییر دهید تا نمونه ساختگی دیگری را بررسی کنید." }, locale)}</p></div>
            )}
          </section>

          <aside className="docw-preview" aria-live="polite" aria-label={localized({ en: "Selected document preview", fa: "پیش‌نمایش سند انتخاب‌شده" }, locale)}>
            <div className="docw-preview-heading"><span className={`docw-file-icon ${selected.tone}`} aria-hidden="true"><AppIcon name={selectedCategory.icon} size={24} /></span><div><p>{selected.id} · DEMO DATA</p><h2>{localized(selected.title, locale)}</h2><small>{localized(selectedCategory.label, locale)}</small></div></div>
            <div className="docw-preview-canvas" role="img" aria-label={localized({ en: "Unavailable synthetic document preview", fa: "پیش‌نمایش سند ساختگی در دسترس نیست" }, locale)}>
              <AppIcon name="documents" size={34} />
              <strong>{localized({ en: "Preview placeholder", fa: "جای‌نگهدار پیش‌نمایش" }, locale)}</strong>
              <span>{localized({ en: "No document file is stored or connected", fa: "هیچ فایل سندی ذخیره یا متصل نیست" }, locale)}</span>
              <em>DEMO DATA</em>
            </div>
            <p className="docw-description">{localized(selected.description, locale)}</p>
            <dl className="docw-metadata">
              <div><dt>{localized({ en: "Category", fa: "دسته" }, locale)}</dt><dd>{localized(selectedCategory.label, locale)}</dd></div>
              <div><dt>{localized({ en: "Revision", fa: "بازنگری" }, locale)}</dt><dd>{localized(selected.revision, locale)}</dd></div>
              <div><dt>{localized({ en: "Date", fa: "تاریخ" }, locale)}</dt><dd>{localized(selected.date, locale)}</dd></div>
              <div><dt>{localized({ en: "Content", fa: "محتوا" }, locale)}</dt><dd>{localized(selected.pages, locale)}</dd></div>
              <div><dt>{localized({ en: "Context owner", fa: "مالک زمینه" }, locale)}</dt><dd>{localized(selected.owner, locale)}</dd></div>
              <div><dt>{localized({ en: "Verification", fa: "تایید" }, locale)}</dt><dd>{localized({ en: "Synthetic · unverified", fa: "ساختگی · تاییدنشده" }, locale)}</dd></div>
            </dl>
            <div className="docw-actions" aria-label={localized({ en: "Unavailable document actions", fa: "عملیات سند در دسترس نیست" }, locale)}>
              <button type="button" disabled><AppIcon name="shield" size={15} />{localized({ en: "Download locked", fa: "دانلود قفل است" }, locale)}</button>
              <button type="button" disabled><AppIcon name="shield" size={15} />{localized({ en: "Share locked", fa: "اشتراک قفل است" }, locale)}</button>
            </div>
            <div className="docw-safeguard"><AppIcon name="alert" size={16} /><p><strong>{localized({ en: "Stage 0 boundary", fa: "مرز مرحله صفر" }, locale)}</strong>{localized({ en: "This preview cannot upload, store, approve, sign, share, or download a document and contains no actual project or customer record.", fa: "این پیش‌نمایش نمی‌تواند سندی را بارگذاری، ذخیره، تایید، امضا، اشتراک یا دانلود کند و هیچ سابقه واقعی پروژه یا مشتری ندارد." }, locale)}</p></div>
          </aside>
        </div>
      </section>
    </div>
  );
}
