"use client";

import { useState } from "react";

import { AppIcon, type AppIconName } from "@/components/AppIcon";
import { useLocale } from "@/components/LocaleProvider";
import { StageZeroContextBar, StageZeroPageHeader, WorkspaceTabs, localized } from "@/components/StageZeroWorkspace";

type LocalizedCopy = Readonly<{ en: string; fa: string }>;

const settingsTabs = [
  { id: "overview", label: { en: "Settings overview", fa: "نمای کلی تنظیمات" } },
  { id: "preferences", label: { en: "Interface preferences", fa: "ترجیحات رابط" } },
  { id: "profile", label: { en: "Profile preview", fa: "پیش‌نمایش پروفایل" } },
  { id: "access", label: { en: "Roles & permissions", fa: "نقش‌ها و مجوزها" } },
  { id: "system", label: { en: "System configuration", fa: "پیکربندی سیستم" } }
] as const;

const overviewAreas: ReadonlyArray<{
  id: string;
  icon: AppIconName;
  title: LocalizedCopy;
  description: LocalizedCopy;
  state: LocalizedCopy;
}> = [
  {
    id: "preferences",
    icon: "settings",
    title: { en: "Interface preferences", fa: "ترجیحات رابط" },
    description: { en: "Review language, reading direction, density, and motion preferences for this local session.", fa: "زبان، جهت خواندن، تراکم و ترجیحات حرکت را برای این نشست محلی بررسی کنید." },
    state: { en: "Local preview", fa: "پیش‌نمایش محلی" }
  },
  {
    id: "profile",
    icon: "human-resources",
    title: { en: "User profile preview", fa: "پیش‌نمایش پروفایل کاربر" },
    description: { en: "Inspect the synthetic review identity displayed in the Stage 0 application shell.", fa: "هویت ساختگی بازبینی را که در پوسته برنامه مرحله صفر نمایش داده می‌شود، بررسی کنید." },
    state: { en: "Demo identity", fa: "هویت نمایشی" }
  },
  {
    id: "access",
    icon: "key",
    title: { en: "Roles and permissions", fa: "نقش‌ها و مجوزها" },
    description: { en: "Preview the intended access-control structure without assigning or changing authority.", fa: "ساختار موردنظر کنترل دسترسی را بدون تخصیص یا تغییر اختیار پیش‌نمایش کنید." },
    state: { en: "Read-only map", fa: "نقشه فقط‌خواندنی" }
  },
  {
    id: "system",
    icon: "database",
    title: { en: "System configuration", fa: "پیکربندی سیستم" },
    description: { en: "Review future configuration categories while all operational settings remain disconnected.", fa: "دسته‌های پیکربندی آینده را در حالی بررسی کنید که همه تنظیمات عملیاتی قطع هستند." },
    state: { en: "Not connected", fa: "متصل نیست" }
  }
];

const rolePreviews: ReadonlyArray<{
  id: string;
  title: LocalizedCopy;
  scope: LocalizedCopy;
  capabilities: ReadonlyArray<LocalizedCopy>;
}> = [
  {
    id: "DEMO-ROLE-EXEC",
    title: { en: "Executive review", fa: "بازبینی اجرایی" },
    scope: { en: "Cross-workspace visibility preview", fa: "پیش‌نمایش دید میان فضاهای کاری" },
    capabilities: [
      { en: "View interface previews", fa: "مشاهده پیش‌نمایش رابط‌ها" },
      { en: "Review synthetic summaries", fa: "بررسی خلاصه‌های ساختگی" }
    ]
  },
  {
    id: "DEMO-ROLE-PROJECT",
    title: { en: "Project coordination", fa: "هماهنگی پروژه" },
    scope: { en: "Project and construction preview", fa: "پیش‌نمایش پروژه و ساخت‌وساز" },
    capabilities: [
      { en: "View project context", fa: "مشاهده زمینه پروژه" },
      { en: "Review demonstration updates", fa: "بررسی به‌روزرسانی‌های نمایشی" }
    ]
  },
  {
    id: "DEMO-ROLE-CONTROL",
    title: { en: "Control review", fa: "بازبینی کنترلی" },
    scope: { en: "Finance and reporting structure preview", fa: "پیش‌نمایش ساختار مالی و گزارش‌دهی" },
    capabilities: [
      { en: "View locked finance structure", fa: "مشاهده ساختار مالی قفل‌شده" },
      { en: "Inspect report preview states", fa: "بررسی وضعیت پیش‌نمایش گزارش" }
    ]
  }
];

const systemCategories: ReadonlyArray<{
  icon: AppIconName;
  title: LocalizedCopy;
  description: LocalizedCopy;
  unavailable: LocalizedCopy;
}> = [
  {
    icon: "building",
    title: { en: "Organization and projects", fa: "سازمان و پروژه‌ها" },
    description: { en: "Legal entity, project registry, project structure, and organizational master records.", fa: "نهاد حقوقی، ثبت پروژه، ساختار پروژه و سوابق اصلی سازمانی." },
    unavailable: { en: "No master-data service", fa: "بدون سرویس داده اصلی" }
  },
  {
    icon: "shield",
    title: { en: "Security and access", fa: "امنیت و دسترسی" },
    description: { en: "Authentication, roles, approvals, session policy, and access-control administration.", fa: "احراز هویت، نقش‌ها، تاییدها، سیاست نشست و مدیریت کنترل دسترسی." },
    unavailable: { en: "No security administration", fa: "بدون مدیریت امنیت" }
  },
  {
    icon: "finance",
    title: { en: "Finance configuration", fa: "پیکربندی مالی" },
    description: { en: "Currencies, periods, account structure, posting controls, and financial policy.", fa: "ارزها، دوره‌ها، ساختار حساب، کنترل‌های ثبت و سیاست مالی." },
    unavailable: { en: "Stage 1 not authorized", fa: "مرحله اول مجاز نیست" }
  },
  {
    icon: "database",
    title: { en: "Services and integrations", fa: "خدمات و یکپارچه‌سازی‌ها" },
    description: { en: "Storage, notifications, external services, audit events, and environment connections.", fa: "ذخیره‌سازی، اعلان‌ها، خدمات بیرونی، رویدادهای حسابرسی و اتصال محیط‌ها." },
    unavailable: { en: "Services not connected", fa: "خدمات متصل نیست" }
  }
];

export function SettingsWorkspace() {
  const { locale, setLocale } = useLocale();
  const [activeTab, setActiveTab] = useState("overview");
  const [density, setDensity] = useState<"comfortable" | "compact">("comfortable");
  const [motion, setMotion] = useState<"standard" | "reduced">("standard");
  const [preferenceNotice, setPreferenceNotice] = useState<LocalizedCopy>({
    en: "Preferences are held in this browser session only.",
    fa: "ترجیحات فقط در این نشست مرورگر نگهداری می‌شوند."
  });

  const updateDensity = (value: "comfortable" | "compact") => {
    setDensity(value);
    setPreferenceNotice({
      en: `${value === "comfortable" ? "Comfortable" : "Compact"} density selected for this local preview.`,
      fa: `تراکم ${value === "comfortable" ? "راحت" : "فشرده"} برای این پیش‌نمایش محلی انتخاب شد.`
    });
  };

  const updateMotion = (value: "standard" | "reduced") => {
    setMotion(value);
    setPreferenceNotice({
      en: `${value === "standard" ? "Standard" : "Reduced"} motion selected for this local preview.`,
      fa: `حرکت ${value === "standard" ? "معمولی" : "کاهش‌یافته"} برای این پیش‌نمایش محلی انتخاب شد.`
    });
  };

  const updateLanguage = (value: "en" | "fa") => {
    setLocale(value);
    setPreferenceNotice(value === "fa"
      ? { en: "Dari selected for this local preview.", fa: "دری برای این پیش‌نمایش محلی انتخاب شد." }
      : { en: "English selected for this local preview.", fa: "انگلیسی برای این پیش‌نمایش محلی انتخاب شد." });
  };

  return (
    <div className="module-workspace setw-workspace" data-density={density} data-motion={motion}>
      <StageZeroPageHeader
        icon="settings"
        eyebrow={{ en: "Administration / Interface preview", fa: "مدیریت و پیش‌نمایش رابط" }}
        title={{ en: "Settings", fa: "تنظیمات" }}
        description={{ en: "A Stage 0 workspace for local interface preferences and a read-only preview of future governed configuration.", fa: "فضای کاری مرحله صفر برای ترجیحات محلی رابط و پیش‌نمایش فقط‌خواندنی پیکربندی کنترل‌شده آینده." }}
      >
        <button className="module-quiet-button" type="button" disabled title="Operational configuration is unavailable in Stage 0"><AppIcon name="shield" size={16} />{localized({ en: "Operational changes locked", fa: "تغییرات عملیاتی قفل است" }, locale)}</button>
      </StageZeroPageHeader>

      <StageZeroContextBar section={{ en: "Settings preview", fa: "پیش‌نمایش تنظیمات" }} />

      <section className="setw-boundary" aria-label={localized({ en: "Settings Stage 0 boundary", fa: "مرز تنظیمات مرحله صفر" }, locale)}>
        <span aria-hidden="true"><AppIcon name="shield" size={21} /></span>
        <div><p>{localized({ en: "LOCAL INTERFACE PREVIEW", fa: "پیش‌نمایش محلی رابط" }, locale)}</p><strong>{localized({ en: "No permissions, security policy, organization records, system services, or financial configuration can be changed", fa: "هیچ مجوز، سیاست امنیتی، سابقه سازمانی، سرویس سیستم یا پیکربندی مالی قابل تغییر نیست" }, locale)}</strong></div>
        <em>{localized({ en: "Stage 0 · Read only", fa: "مرحله صفر · فقط‌خواندنی" }, locale)}</em>
      </section>

      <section className="module-content-card setw-card" aria-labelledby="setw-workspace-title">
        <div className="module-card-heading">
          <div><p>{localized({ en: "Application administration", fa: "مدیریت برنامه" }, locale)}</p><h2 id="setw-workspace-title">{localized({ en: "Settings and access workspace", fa: "فضای کاری تنظیمات و دسترسی" }, locale)}</h2></div>
          <span><i aria-hidden="true" />{localized({ en: "Only interface preferences are interactive", fa: "فقط ترجیحات رابط تعاملی است" }, locale)}</span>
        </div>

        <div className="module-toolbar"><WorkspaceTabs label="Settings workspace sections" tabs={settingsTabs} active={activeTab} onChange={setActiveTab} /></div>

        {activeTab === "overview" ? (
          <div className="setw-overview-layout">
            <section className="setw-context-panel" aria-labelledby="setw-context-title">
              <div className="setw-panel-heading"><span aria-hidden="true"><AppIcon name="building" size={21} /></span><div><p>{localized({ en: "DEMO CONTEXT", fa: "زمینه نمایشی" }, locale)}</p><h3 id="setw-context-title">{localized({ en: "Organization and project", fa: "سازمان و پروژه" }, locale)}</h3></div></div>
              <dl>
                <div><dt>{localized({ en: "Organization", fa: "سازمان" }, locale)}</dt><dd>AL-BERUNIY Developments <small>DEMO CONTEXT</small></dd></div>
                <div><dt>{localized({ en: "Current project", fa: "پروژه فعلی" }, locale)}</dt><dd>Mazar Mall <small>{localized({ en: "Presentation fixture", fa: "نمونه نمایشی" }, locale)}</small></dd></div>
                <div><dt>{localized({ en: "Operating location", fa: "موقعیت عملیاتی" }, locale)}</dt><dd>Mazar-e-Sharif <small>{localized({ en: "Display context only", fa: "فقط زمینه نمایش" }, locale)}</small></dd></div>
                <div><dt>{localized({ en: "Record authority", fa: "مرجع سابقه" }, locale)}</dt><dd>{localized({ en: "Not connected", fa: "متصل نیست" }, locale)} <small>{localized({ en: "No master-data changes", fa: "بدون تغییر داده اصلی" }, locale)}</small></dd></div>
              </dl>
              <p className="setw-context-note"><AppIcon name="shield" size={15} />{localized({ en: "This context identifies the interface fixture. It is not a verified legal or operational organization record.", fa: "این زمینه نمونه رابط را مشخص می‌کند و سابقه حقوقی یا عملیاتی تاییدشده سازمان نیست." }, locale)}</p>
            </section>

            <div className="setw-area-grid" role="list" aria-label={localized({ en: "Settings preview areas", fa: "بخش‌های پیش‌نمایش تنظیمات" }, locale)}>
              {overviewAreas.map((area) => (
                <div role="listitem" key={area.id}>
                  <button type="button" onClick={() => setActiveTab(area.id)} aria-label={localized({ en: `Open ${area.title.en}`, fa: `بازکردن ${area.title.fa}` }, locale)}>
                    <span aria-hidden="true"><AppIcon name={area.icon} size={21} /></span>
                    <strong>{localized(area.title, locale)}</strong>
                    <small>{localized(area.description, locale)}</small>
                    <em>{localized(area.state, locale)}</em>
                    <AppIcon name="chevron" size={15} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {activeTab === "preferences" ? (
          <div className="setw-preferences-layout">
            <section className="setw-preference-panel" aria-labelledby="setw-language-title">
              <div className="setw-panel-heading"><span aria-hidden="true"><AppIcon name="settings" size={21} /></span><div><p>{localized({ en: "LOCAL PREFERENCE", fa: "ترجیح محلی" }, locale)}</p><h3 id="setw-language-title">{localized({ en: "Language and reading direction", fa: "زبان و جهت خواندن" }, locale)}</h3></div></div>
              <div className="setw-choice-group" role="group" aria-label={localized({ en: "Interface language", fa: "زبان رابط" }, locale)}>
                <button type="button" aria-pressed={locale === "en"} onClick={() => updateLanguage("en")}><strong>English</strong><small>Left to right</small></button>
                <button type="button" aria-pressed={locale === "fa"} onClick={() => updateLanguage("fa")}><strong>دری</strong><small>راست به چپ</small></button>
              </div>
              <p>{localized({ en: "Language changes the current interface session and does not update an account, organization, or server record.", fa: "زبان نشست فعلی رابط را تغییر می‌دهد و حساب، سازمان یا سابقه سرور را به‌روزرسانی نمی‌کند." }, locale)}</p>
            </section>

            <section className="setw-preference-panel" aria-labelledby="setw-density-title">
              <div className="setw-panel-heading"><span aria-hidden="true"><AppIcon name="documents" size={21} /></span><div><p>{localized({ en: "DISPLAY PREVIEW", fa: "پیش‌نمایش نمایش" }, locale)}</p><h3 id="setw-density-title">{localized({ en: "Information density", fa: "تراکم اطلاعات" }, locale)}</h3></div></div>
              <div className="setw-choice-group" role="group" aria-label={localized({ en: "Information density", fa: "تراکم اطلاعات" }, locale)}>
                <button type="button" aria-pressed={density === "comfortable"} onClick={() => updateDensity("comfortable")}><strong>{localized({ en: "Comfortable", fa: "راحت" }, locale)}</strong><small>{localized({ en: "More spacing", fa: "فاصله بیشتر" }, locale)}</small></button>
                <button type="button" aria-pressed={density === "compact"} onClick={() => updateDensity("compact")}><strong>{localized({ en: "Compact", fa: "فشرده" }, locale)}</strong><small>{localized({ en: "Tighter preview", fa: "پیش‌نمایش فشرده‌تر" }, locale)}</small></button>
              </div>
              <p>{localized({ en: "This selection is demonstrated inside Settings only; approved workspace layouts remain unchanged.", fa: "این انتخاب فقط در تنظیمات نمایش داده می‌شود؛ چیدمان فضاهای کاری تصویب‌شده بدون تغییر می‌ماند." }, locale)}</p>
            </section>

            <section className="setw-preference-panel" aria-labelledby="setw-motion-title">
              <div className="setw-panel-heading"><span aria-hidden="true"><AppIcon name="sparkles" size={21} /></span><div><p>{localized({ en: "ACCESSIBILITY PREVIEW", fa: "پیش‌نمایش دسترس‌پذیری" }, locale)}</p><h3 id="setw-motion-title">{localized({ en: "Interface motion", fa: "حرکت رابط" }, locale)}</h3></div></div>
              <div className="setw-choice-group" role="group" aria-label={localized({ en: "Interface motion", fa: "حرکت رابط" }, locale)}>
                <button type="button" aria-pressed={motion === "standard"} onClick={() => updateMotion("standard")}><strong>{localized({ en: "Standard", fa: "معمولی" }, locale)}</strong><small>{localized({ en: "Default transitions", fa: "انتقال‌های پیش‌فرض" }, locale)}</small></button>
                <button type="button" aria-pressed={motion === "reduced"} onClick={() => updateMotion("reduced")}><strong>{localized({ en: "Reduced", fa: "کاهش‌یافته" }, locale)}</strong><small>{localized({ en: "Fewer transitions", fa: "انتقال‌های کمتر" }, locale)}</small></button>
              </div>
              <p>{localized({ en: "System reduced-motion preferences remain respected independently of this illustrative control.", fa: "ترجیحات کاهش حرکت سیستم مستقل از این کنترل نمایشی رعایت می‌شود." }, locale)}</p>
            </section>

            <aside className="setw-preference-status" role="status" aria-live="polite"><AppIcon name="shield" size={18} /><div><strong>{localized({ en: "Session preview updated", fa: "پیش‌نمایش نشست به‌روز شد" }, locale)}</strong><p>{localized(preferenceNotice, locale)}</p><small>{localized({ en: "Nothing was saved to a user account or operational service.", fa: "هیچ چیزی در حساب کاربر یا سرویس عملیاتی ذخیره نشد." }, locale)}</small></div></aside>
          </div>
        ) : null}

        {activeTab === "profile" ? (
          <div className="setw-profile-layout">
            <section className="setw-profile-card" aria-labelledby="setw-profile-title">
              <div className="setw-avatar" aria-hidden="true">DE</div>
              <p>DEMO PROFILE · NO VERIFIED IDENTITY</p>
              <h3 id="setw-profile-title">{localized({ en: "Demo Executive", fa: "کاربر نمایشی" }, locale)}</h3>
              <span>{localized({ en: "Stage 0 interface reviewer", fa: "بازبین رابط مرحله صفر" }, locale)}</span>
              <dl>
                <div><dt>{localized({ en: "Profile source", fa: "منبع پروفایل" }, locale)}</dt><dd>{localized({ en: "Synthetic fixture", fa: "نمونه ساختگی" }, locale)}</dd></div>
                <div><dt>{localized({ en: "Account status", fa: "وضعیت حساب" }, locale)}</dt><dd>{localized({ en: "No identity service", fa: "بدون سرویس هویت" }, locale)}</dd></div>
                <div><dt>{localized({ en: "Current project", fa: "پروژه فعلی" }, locale)}</dt><dd>Mazar Mall · DEMO</dd></div>
                <div><dt>{localized({ en: "Preferred language", fa: "زبان ترجیحی" }, locale)}</dt><dd>{locale === "fa" ? "دری" : "English"}</dd></div>
              </dl>
              <button type="button" disabled><AppIcon name="shield" size={16} />{localized({ en: "Profile editing unavailable", fa: "ویرایش پروفایل در دسترس نیست" }, locale)}</button>
            </section>

            <aside className="setw-profile-boundary" aria-label={localized({ en: "Profile preview boundary", fa: "مرز پیش‌نمایش پروفایل" }, locale)}>
              <span aria-hidden="true"><AppIcon name="human-resources" size={22} /></span>
              <p>{localized({ en: "IDENTITY BOUNDARY", fa: "مرز هویت" }, locale)}</p>
              <h3>{localized({ en: "No operational user account", fa: "بدون حساب کاربری عملیاتی" }, locale)}</h3>
              <ul>
                <li>{localized({ en: "No verified name, email, phone, or identity document", fa: "بدون نام، ایمیل، تلفن یا سند هویت تاییدشده" }, locale)}</li>
                <li>{localized({ en: "No password, authentication method, or active session administration", fa: "بدون رمز، روش احراز هویت یا مدیریت نشست فعال" }, locale)}</li>
                <li>{localized({ en: "No assigned operational role or delegated authority", fa: "بدون نقش عملیاتی تخصیص‌یافته یا اختیار تفویض‌شده" }, locale)}</li>
              </ul>
            </aside>
          </div>
        ) : null}

        {activeTab === "access" ? (
          <div className="setw-access-layout">
            <div className="setw-access-heading"><div><p>{localized({ en: "DEMO ROLE MAP", fa: "نقشه نقش نمایشی" }, locale)}</p><h3>{localized({ en: "Roles and permissions overview", fa: "نمای کلی نقش‌ها و مجوزها" }, locale)}</h3></div><span><AppIcon name="shield" size={15} />{localized({ en: "No assignments or permission changes", fa: "بدون تخصیص یا تغییر مجوز" }, locale)}</span></div>
            <div className="setw-role-grid" role="list" aria-label={localized({ en: "Illustrative role structure", fa: "ساختار نمایشی نقش‌ها" }, locale)}>
              {rolePreviews.map((role) => (
                <article role="listitem" key={role.id}>
                  <span aria-hidden="true"><AppIcon name="key" size={20} /></span>
                  <p>{role.id}</p>
                  <h3>{localized(role.title, locale)}</h3>
                  <small>{localized(role.scope, locale)}</small>
                  <ul>{role.capabilities.map((capability) => <li key={capability.en}><AppIcon name="shield" size={14} />{localized(capability, locale)}</li>)}</ul>
                  <strong>{localized({ en: "STRUCTURE PREVIEW · NOT ASSIGNED", fa: "پیش‌نمایش ساختار · تخصیص نیافته" }, locale)}</strong>
                </article>
              ))}
            </div>
            <div className="setw-access-note"><AppIcon name="alert" size={17} /><p><strong>{localized({ en: "Authorization is not operational", fa: "مجوزدهی عملیاتی نیست" }, locale)}</strong>{localized({ en: "These fixtures explain a possible role structure. They grant no access, bypass no policy, and cannot change a user or record.", fa: "این نمونه‌ها ساختار احتمالی نقش را توضیح می‌دهند. هیچ دسترسی نمی‌دهند، هیچ سیاستی را دور نمی‌زنند و کاربر یا سابقه‌ای را تغییر نمی‌دهند." }, locale)}</p></div>
          </div>
        ) : null}

        {activeTab === "system" ? (
          <div className="setw-system-layout">
            <div className="setw-system-heading"><div><p>{localized({ en: "FUTURE CONFIGURATION MAP", fa: "نقشه پیکربندی آینده" }, locale)}</p><h3>{localized({ en: "Governed system categories", fa: "دسته‌های کنترل‌شده سیستم" }, locale)}</h3></div><span>{localized({ en: "All operational controls locked", fa: "همه کنترل‌های عملیاتی قفل است" }, locale)}</span></div>
            <div className="setw-system-grid" role="list" aria-label={localized({ en: "Unavailable system configuration categories", fa: "دسته‌های پیکربندی سیستم در دسترس نیست" }, locale)}>
              {systemCategories.map((category) => (
                <article role="listitem" key={category.title.en}>
                  <span aria-hidden="true"><AppIcon name={category.icon} size={21} /></span>
                  <h3>{localized(category.title, locale)}</h3>
                  <p>{localized(category.description, locale)}</p>
                  <div><i aria-hidden="true" /><strong>{localized(category.unavailable, locale)}</strong></div>
                  <button type="button" disabled>{localized({ en: "Configuration locked", fa: "پیکربندی قفل است" }, locale)}</button>
                </article>
              ))}
            </div>
            <aside className="setw-system-boundary"><AppIcon name="database" size={18} /><p><strong>{localized({ en: "No persistence or connected services", fa: "بدون ذخیره‌سازی یا خدمات متصل" }, locale)}</strong>{localized({ en: "This page does not write organization records, security policy, financial setup, environment values, integrations, or audit events.", fa: "این صفحه سوابق سازمان، سیاست امنیتی، تنظیم مالی، مقادیر محیط، یکپارچه‌سازی‌ها یا رویدادهای حسابرسی را ثبت نمی‌کند." }, locale)}</p></aside>
          </div>
        ) : null}
      </section>
    </div>
  );
}
