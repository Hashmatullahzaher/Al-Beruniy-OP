"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { AccessGate, api, errorText } from "@/components/AdminUsersWorkspace";
import { AppIcon } from "@/components/AppIcon";
import { useLocale } from "@/components/LocaleProvider";
import { StageZeroPageHeader } from "@/components/StageZeroWorkspace";
import type { Copy } from "@/lib/access-copy";

interface CompanyProfile {
  readonly legalEntity: { readonly id: string; readonly code: string; readonly name: string; readonly baseCurrency: string | null };
  readonly profile: {
    readonly legalName: string | null; readonly registrationNumber: string | null; readonly goLiveDate: string | null;
    readonly version: number; readonly updatedAt: string | null; readonly updatedBy: string | null;
  };
  readonly currencies: readonly { readonly code: string; readonly name: string; readonly enabled: boolean }[];
  readonly calendar: { readonly calendarKind: string; readonly reportingCalendars: readonly string[] } | null;
  readonly canManage: boolean;
}

const CALENDAR_COPY: Readonly<Record<string, Copy>> = {
  SOLAR_HIJRI: { en: "Solar Hijri (from 1 Hamal)", fa: "هجری شمسی (از ۱ حمل)" },
  GREGORIAN: { en: "Gregorian (January–December)", fa: "میلادی (جنوری تا دسمبر)" },
  CUSTOM: { en: "Custom", fa: "سفارشی" }
};

export function CompanyWorkspace() {
  const { locale } = useLocale();
  const fa = locale === "fa";
  const t = useCallback((copy: Copy) => copy[locale], [locale]);
  const [company, setCompany] = useState<CompanyProfile | null>(null);
  const [gate, setGate] = useState<"signed-out" | "denied" | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [form, setForm] = useState({ legalName: "", registrationNumber: "", goLiveDate: "" });
  const [busy, setBusy] = useState(false);

  const apply = useCallback((result: Awaited<ReturnType<typeof api<CompanyProfile>>>) => {
    if (!result.ok) {
      setGate(result.status === 401 ? "signed-out" : result.status === 403 ? "denied" : null);
      if (result.status !== 401 && result.status !== 403) setMessage({ tone: "error", text: errorText(result.error, locale) });
      return;
    }
    setGate(null);
    setCompany(result.data);
    setForm({ legalName: result.data.profile.legalName ?? "", registrationNumber: result.data.profile.registrationNumber ?? "", goLiveDate: result.data.profile.goLiveDate ?? "" });
  }, [locale]);

  useEffect(() => {
    let current = true;
    void api<CompanyProfile>("/api/v1/admin/company").then((result) => { if (current) apply(result); });
    return () => { current = false; };
  }, [apply]);

  if (gate) return <div className="module-workspace"><AccessGate state={gate} fa={fa} what={{ en: "Sign in to see the company details.", fa: "برای دیدن مشخصات شرکت وارد شوید." }} /></div>;

  const pending = <em className="treasury-chip gold">{fa ? "در انتظار مالک" : "Pending from owner"}</em>;
  const save = async () => {
    if (!company) return;
    setBusy(true); setMessage(null);
    const result = await api<CompanyProfile>("/api/v1/admin/company", "PUT", { ...form, expectedVersion: company.profile.version });
    setBusy(false);
    if (!result.ok) { setMessage({ tone: "error", text: errorText(result.error, locale) }); return; }
    apply(result);
    setMessage({ tone: "ok", text: fa ? "مشخصات شرکت ذخیره شد." : "Company details saved." });
  };

  return (
    <div className="module-workspace company-workspace">
      <StageZeroPageHeader icon="building"
        eyebrow={{ en: "Company configuration", fa: "پیکربندی شرکت" }}
        title={{ en: "Company", fa: "شرکت" }}
        description={{ en: "Legal details, currencies and financial year of the company you are signed in to.", fa: "مشخصات حقوقی، واحدهای پول و سال مالی شرکتی که در آن وارد شده‌اید." }} />

      {message ? <div className={`treasury-message ${message.tone === "ok" ? "success" : "error"}`} role="status"><AppIcon name={message.tone === "ok" ? "shield" : "alert"} size={16} /><span>{message.text}</span><button onClick={() => setMessage(null)} aria-label={fa ? "بستن" : "Dismiss"}>×</button></div> : null}

      {company === null ? <p className="treasury-placeholder">{fa ? "در حال بارگذاری…" : "Loading…"}</p> : (
        <section className="company-grid">
          <div className="module-content-card company-card">
            <div className="module-card-heading"><div><p>{fa ? "مشخصات حقوقی" : "LEGAL DETAILS"}</p><h2>{company.legalEntity.name}</h2></div><span dir="ltr">{company.legalEntity.code}</span></div>
            <dl className="company-facts">
              <div><dt>{fa ? "نام حقوقی" : "Legal name"}</dt><dd>{company.profile.legalName ?? pending}</dd></div>
              <div><dt>{fa ? "شماره ثبت" : "Registration number"}</dt><dd>{company.profile.registrationNumber ?? pending}</dd></div>
              <div><dt>{fa ? "تاریخ آغاز کار" : "Go-live date"}</dt><dd>{company.profile.goLiveDate ?? pending}</dd></div>
            </dl>
            <p className="admin-hint">{fa ? "این مشخصات را فقط مالک ارائه می‌کند؛ سیستم هیچ مقداری را حدس نمی‌زند. این محیط پیش‌نمایش داده‌های مصنوعی است." : "Only the owner provides these details; the system never guesses them. This preview environment holds synthetic data."}</p>
            {company.profile.updatedBy ? <p className="admin-hint">{fa ? "آخرین تغییر توسط " : "Last changed by "}{company.profile.updatedBy}</p> : null}
            {company.canManage ? (
              <form className="admin-form" onSubmit={(event) => { event.preventDefault(); void save(); }} aria-label={fa ? "ویرایش مشخصات شرکت" : "Edit company details"}>
                <label><span>{fa ? "نام حقوقی" : "Legal name"}</span><input value={form.legalName} onChange={(event) => setForm({ ...form, legalName: event.target.value })} maxLength={200} /></label>
                <label><span>{fa ? "شماره ثبت" : "Registration number"}</span><input dir="ltr" value={form.registrationNumber} onChange={(event) => setForm({ ...form, registrationNumber: event.target.value })} maxLength={100} /></label>
                <label><span>{fa ? "تاریخ آغاز کار" : "Go-live date"}</span><input type="date" dir="ltr" value={form.goLiveDate} onChange={(event) => setForm({ ...form, goLiveDate: event.target.value })} /></label>
                <button type="submit" className="treasury-button gold" disabled={busy}>{fa ? "ذخیره" : "Save"}</button>
              </form>
            ) : null}
          </div>

          <div className="module-content-card company-card">
            <div className="module-card-heading"><div><p>{fa ? "پول و سال مالی" : "MONEY AND FINANCIAL YEAR"}</p><h2>{fa ? "تنظیمات مالی" : "Financial settings"}</h2></div></div>
            <dl className="company-facts">
              <div><dt>{fa ? "واحد پول پایه" : "Base currency"}</dt><dd dir="ltr">{company.legalEntity.baseCurrency ?? pending}</dd></div>
              <div><dt>{fa ? "واحدهای پول فعال" : "Enabled currencies"}</dt><dd>{company.currencies.filter((currency) => currency.enabled).map((currency) => <em key={currency.code} className="treasury-chip ok" dir="ltr">{currency.code}</em>)}</dd></div>
              <div><dt>{fa ? "سال مالی" : "Financial year"}</dt><dd>{company.calendar ? t(CALENDAR_COPY[company.calendar.calendarKind] ?? { en: company.calendar.calendarKind, fa: company.calendar.calendarKind }) : (fa ? "هنوز انتخاب نشده" : "Not chosen yet")}</dd></div>
            </dl>
            <p className="admin-hint">{fa ? "هر واحد پول جداگانه نگه داشته می‌شود و هرگز با دیگری جمع نمی‌شود." : "Each currency is kept separately and never added to another."}</p>
            <Link className="treasury-button quiet" href="/finance/calendar">{fa ? "تقویم مالی" : "Financial calendar"}</Link>
          </div>
        </section>
      )}
    </div>
  );
}
