"use client";

import { useState } from "react";

import { AppIcon, type AppIconName } from "@/components/AppIcon";
import { useLocale } from "@/components/LocaleProvider";
import { StageZeroContextBar, StageZeroPageHeader, WorkspaceEmptyState, WorkspaceTabs, localized } from "@/components/StageZeroWorkspace";

const hrTabs = [
  { id: "overview", label: { en: "Workforce overview", fa: "نمای کلی نیروی کار" } },
  { id: "staff", label: { en: "Staff directory", fa: "فهرست کارکنان" }, count: 4 },
  { id: "roles", label: { en: "Roles", fa: "نقش‌ها" }, count: 3 },
  { id: "attendance", label: { en: "Attendance", fa: "حاضری" } },
  { id: "records", label: { en: "Workforce records", fa: "سوابق نیروی کار" } }
] as const;

const staffFixtures = [
  { id: "DEMO-EMP-001", profile: { en: "Project coordination fixture", fa: "نمونه هماهنگی پروژه" }, role: { en: "Project coordinator", fa: "هماهنگ‌کننده پروژه" }, unit: { en: "Project office", fa: "دفتر پروژه" }, attendance: { en: "Present demo", fa: "حاضر نمایشی" }, tone: "blue" },
  { id: "DEMO-EMP-002", profile: { en: "Quality review fixture", fa: "نمونه بررسی کیفیت" }, role: { en: "Quality reviewer", fa: "بررسی‌کننده کیفیت" }, unit: { en: "Site quality", fa: "کیفیت ساحه" }, attendance: { en: "Field demo", fa: "ساحه نمایشی" }, tone: "gold" },
  { id: "DEMO-EMP-003", profile: { en: "Sales support fixture", fa: "نمونه پشتیبانی فروش" }, role: { en: "Sales support", fa: "پشتیبانی فروش" }, unit: { en: "Customer office", fa: "دفتر مشتری" }, attendance: { en: "Present demo", fa: "حاضر نمایشی" }, tone: "cyan" },
  { id: "DEMO-EMP-004", profile: { en: "Document control fixture", fa: "نمونه کنترل اسناد" }, role: { en: "Document controller", fa: "کنترل‌کننده اسناد" }, unit: { en: "Operations", fa: "عملیات" }, attendance: { en: "Remote demo", fa: "دورکار نمایشی" }, tone: "green" }
] as const;

const roleFixtures = [
  { id: "DEMO-ROLE-01", title: { en: "Project coordination", fa: "هماهنگی پروژه" }, purpose: { en: "Illustrative project communication and review role", fa: "نقش نمایشی ارتباط و بررسی پروژه" }, assignments: 1 },
  { id: "DEMO-ROLE-02", title: { en: "Quality review", fa: "بررسی کیفیت" }, purpose: { en: "Illustrative field quality observation role", fa: "نقش نمایشی مشاهده کیفیت ساحه" }, assignments: 1 },
  { id: "DEMO-ROLE-03", title: { en: "Operational support", fa: "پشتیبانی عملیاتی" }, purpose: { en: "Illustrative customer and document support roles", fa: "نقش‌های نمایشی پشتیبانی مشتری و اسناد" }, assignments: 2 }
] as const;

const emptySections: Record<string, { icon: AppIconName; title: { en: string; fa: string }; description: { en: string; fa: string } }> = {
  attendance: { icon: "chart", title: { en: "No verified attendance service", fa: "هیچ سرویس حاضری تاییدشده وجود ندارد" }, description: { en: "Clock-in events, shifts, leave, approvals, and verified attendance history are not connected in Stage 0.", fa: "ورود و خروج، شیفت‌ها، رخصتی، تاییدها و تاریخچه حاضری تاییدشده در مرحله صفر متصل نیست." } },
  records: { icon: "documents", title: { en: "No operational workforce records", fa: "هیچ سابقه عملیاتی نیروی کار وجود ندارد" }, description: { en: "Personal files, contracts, compensation, payroll, employee financial records, and accounting entries remain unavailable.", fa: "پرونده‌های شخصی، قراردادها، جبران خدمات، معاش، سوابق مالی کارکنان و اسناد حسابداری در دسترس نیست." } }
};

export function HumanResourcesWorkspace() {
  const { locale } = useLocale();
  const [activeTab, setActiveTab] = useState("overview");
  const [selectedId, setSelectedId] = useState("DEMO-EMP-001");
  const selected = staffFixtures.find((item) => item.id === selectedId) ?? staffFixtures[0];

  return (
    <div className="module-workspace hr-workspace">
      <StageZeroPageHeader
        icon="human-resources"
        eyebrow={{ en: "People / Workforce visibility", fa: "افراد و دید نیروی کار" }}
        title={{ en: "Human Resources", fa: "منابع انسانی" }}
        description={{ en: "A privacy-conscious Stage 0 preview for staff, roles, attendance, and workforce structure.", fa: "پیش‌نمایش مرحله صفر با رعایت حریم خصوصی برای کارکنان، نقش‌ها، حاضری و ساختار نیروی کار." }}
      >
        <button className="module-quiet-button" type="button" disabled title="Employee creation is not connected in Stage 0"><AppIcon name="shield" size={16} />{localized({ en: "Staff actions locked", fa: "عملیات کارکنان قفل است" }, locale)}</button>
      </StageZeroPageHeader>

      <StageZeroContextBar section={{ en: "Human Resources preview", fa: "پیش‌نمایش منابع انسانی" }} />

      <section className="hr-summary" aria-label={localized({ en: "Synthetic workforce summary", fa: "خلاصه ساختگی نیروی کار" }, locale)}>
        <div><span><AppIcon name="human-resources" size={21} /></span><small>{localized({ en: "Demo profiles", fa: "پروفایل‌های نمایشی" }, locale)}</small><strong>4</strong><em>NO IDENTITIES</em></div>
        <div><span><AppIcon name="key" size={21} /></span><small>{localized({ en: "Demo role groups", fa: "گروه نقش‌های نمایشی" }, locale)}</small><strong>3</strong><em>PREVIEW</em></div>
        <div><span><AppIcon name="coins" size={21} /></span><small>{localized({ en: "Payroll records", fa: "سوابق معاش" }, locale)}</small><strong>0</strong><em>{localized({ en: "NOT CONNECTED", fa: "متصل نیست" }, locale)}</em></div>
        <p><AppIcon name="shield" size={15} />{localized({ en: "Synthetic role fixtures only · no real identities, salaries, payroll calculations, employee finance, or accounting entries", fa: "فقط نمونه نقش‌های ساختگی · بدون هویت واقعی، معاش، محاسبه حقوق، امور مالی کارکنان یا سند حسابداری" }, locale)}</p>
      </section>

      <section className="module-content-card" aria-labelledby="hr-workspace-title">
        <div className="module-card-heading">
          <div><p>{localized({ en: "Organization preview", fa: "پیش‌نمایش سازمان" }, locale)}</p><h2 id="hr-workspace-title">{localized({ en: "People and roles workspace", fa: "فضای کاری افراد و نقش‌ها" }, locale)}</h2></div>
          <span><i aria-hidden="true" />{localized({ en: "Synthetic profiles without identities", fa: "پروفایل‌های ساختگی بدون هویت" }, locale)}</span>
        </div>
        <div className="module-toolbar"><WorkspaceTabs label="Human Resources workspace sections" tabs={hrTabs} active={activeTab} onChange={setActiveTab} /></div>

        {activeTab === "overview" || activeTab === "staff" ? (
          <div className="hr-directory-layout">
            <div className="hr-staff-list" role="list" aria-label={localized({ en: "Synthetic staff directory", fa: "فهرست ساختگی کارکنان" }, locale)}>
              <div className="hr-list-heading"><span>{localized({ en: "Demo staff profile", fa: "پروفایل نمایشی کارکنان" }, locale)}</span><span>{localized({ en: "Illustrative attendance", fa: "حاضری نمایشی" }, locale)}</span></div>
              {staffFixtures.map((item) => <div role="listitem" key={item.id}><button type="button" aria-label={`Select ${item.id} demo staff profile`} className={selected.id === item.id ? "selected" : undefined} onClick={() => setSelectedId(item.id)}><span className={`hr-avatar ${item.tone}`}><AppIcon name="human-resources" size={18} /></span><span className="hr-profile-copy"><strong>{localized(item.profile, locale)}</strong><small>{item.id} · NO PERSONAL IDENTITY</small></span><span className="hr-role-copy"><b>{localized(item.role, locale)}</b><small>{localized(item.unit, locale)}</small></span><span className="hr-attendance-chip">{localized(item.attendance, locale)}</span><AppIcon name="chevron" size={15} /></button></div>)}
            </div>
            <aside className="hr-detail-panel" aria-live="polite">
              <span className={`hr-avatar ${selected.tone}`}><AppIcon name="human-resources" size={22} /></span><p>{selected.id} · DEMO</p><h2>{localized(selected.profile, locale)}</h2><small>{localized({ en: "Synthetic profile · no personal identity", fa: "پروفایل ساختگی · بدون هویت شخصی" }, locale)}</small>
              <dl>
                <div><dt>{localized({ en: "Illustrative role", fa: "نقش نمایشی" }, locale)}</dt><dd>{localized(selected.role, locale)}</dd></div>
                <div><dt>{localized({ en: "Workspace", fa: "فضای کاری" }, locale)}</dt><dd>{localized(selected.unit, locale)}</dd></div>
                <div><dt>{localized({ en: "Attendance state", fa: "وضعیت حاضری" }, locale)}</dt><dd>{localized(selected.attendance, locale)}</dd></div>
                <div><dt>{localized({ en: "Employment record", fa: "سابقه استخدام" }, locale)}</dt><dd>{localized({ en: "Not connected", fa: "متصل نیست" }, locale)}</dd></div>
              </dl>
              <div><AppIcon name="shield" size={16} /><p><strong>{localized({ en: "Privacy and payroll boundary", fa: "مرز حریم خصوصی و معاش" }, locale)}</strong>{localized({ en: "No identity documents, contracts, salaries, payroll calculations, bank data, or accounting effects are available.", fa: "هیچ سند هویتی، قرارداد، معاش، محاسبه حقوق، داده بانکی یا اثر حسابداری در دسترس نیست." }, locale)}</p></div>
            </aside>
          </div>
        ) : null}

        {activeTab === "roles" ? <div className="hr-role-cards">{roleFixtures.map((role) => <article key={role.id}><span><AppIcon name="key" size={20} /></span><p>{role.id} · DEMO</p><h3>{localized(role.title, locale)}</h3><small>{localized(role.purpose, locale)}</small><div><b>{role.assignments}</b><em>{localized({ en: "synthetic assignments", fa: "تخصیص ساختگی" }, locale)}</em></div><strong>{localized({ en: "No permissions or employment authority", fa: "بدون مجوز یا اختیار استخدام" }, locale)}</strong></article>)}</div> : null}

        {activeTab === "attendance" || activeTab === "records" ? <WorkspaceEmptyState icon={emptySections[activeTab]!.icon} title={emptySections[activeTab]!.title} description={emptySections[activeTab]!.description} /> : null}
      </section>
    </div>
  );
}
