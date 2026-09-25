"use client";

import { formatDual, generateFiscalYear, GREGORIAN_MONTHS, isoToSolarHijri, toDariDigits, type FiscalYearSettings } from "@abos/calendar";
import { useCallback, useEffect, useMemo, useState } from "react";

import { AccessGate, api, errorText } from "@/components/AdminUsersWorkspace";
import { AppIcon } from "@/components/AppIcon";
import { useLocale } from "@/components/LocaleProvider";
import { StageZeroPageHeader } from "@/components/StageZeroWorkspace";
import type { Copy } from "@/lib/access-copy";
import type { CalendarKind, FinanceCalendarView } from "@/server/finance-calendar";

const KIND_COPY: Readonly<Record<CalendarKind, { label: Copy; detail: Copy }>> = {
  SOLAR_HIJRI: { label: { en: "Solar Hijri", fa: "هجری شمسی" }, detail: { en: "Starts on 1 Hamal; twelve months Hamal to Hut.", fa: "از ۱ حمل آغاز می‌شود؛ دوازده ماه از حمل تا حوت." } },
  GREGORIAN: { label: { en: "Gregorian", fa: "میلادی" }, detail: { en: "January to December.", fa: "جنوری تا دسمبر." } },
  CUSTOM: { label: { en: "Custom", fa: "سفارشی" }, detail: { en: "Twelve months from a chosen Gregorian start date.", fa: "دوازده ماه از یک تاریخ آغاز میلادی انتخابی." } }
};

function today(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}`;
}

function suggestedYear(kind: CalendarKind): number {
  const iso = today();
  return kind === "SOLAR_HIJRI" ? isoToSolarHijri(iso).year + 1 : Number(iso.slice(0, 4)) + 1;
}

export function FinanceCalendarWorkspace() {
  const { locale } = useLocale();
  const fa = locale === "fa";
  const t = useCallback((copy: Copy) => copy[locale], [locale]);
  const [view, setView] = useState<FinanceCalendarView | null>(null);
  const [gate, setGate] = useState<"signed-out" | "denied" | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [kind, setKind] = useState<CalendarKind>("SOLAR_HIJRI");
  const [startMonth, setStartMonth] = useState(7);
  const [startDay, setStartDay] = useState(1);
  const [reporting, setReporting] = useState<ReadonlySet<"SOLAR_HIJRI" | "GREGORIAN">>(new Set(["SOLAR_HIJRI", "GREGORIAN"]));
  const [year, setYear] = useState<number>(suggestedYear("SOLAR_HIJRI"));

  const apply = useCallback((result: Awaited<ReturnType<typeof api<FinanceCalendarView>>>) => {
    if (!result.ok) {
      setGate(result.status === 401 ? "signed-out" : result.status === 403 ? "denied" : null);
      if (result.status !== 401 && result.status !== 403) setMessage({ tone: "error", text: errorText(result.error, locale) });
      return;
    }
    setGate(null);
    setView(result.data);
    const settings = result.data.settings;
    if (settings) {
      setKind(settings.calendarKind);
      if (settings.customStartMonth) setStartMonth(settings.customStartMonth);
      if (settings.customStartDay) setStartDay(settings.customStartDay);
      setReporting(new Set(settings.reportingCalendars));
      setYear(suggestedYear(settings.calendarKind));
    }
  }, [locale]);

  const reload = useCallback(async () => apply(await api<FinanceCalendarView>("/api/v1/finance/calendar")), [apply]);
  useEffect(() => {
    let current = true;
    void api<FinanceCalendarView>("/api/v1/finance/calendar").then((result) => { if (current) apply(result); });
    return () => { current = false; };
  }, [apply]);

  const settingsForPreview: FiscalYearSettings | null = useMemo(() => {
    const kindNow = view?.settings?.calendarKind ?? kind;
    if (kindNow === "CUSTOM") return { kind: "CUSTOM", startMonth: view?.settings?.customStartMonth ?? startMonth, startDay: view?.settings?.customStartDay ?? startDay };
    return { kind: kindNow };
  }, [kind, startDay, startMonth, view]);
  const preview = useMemo(() => {
    try { return settingsForPreview ? generateFiscalYear(settingsForPreview, year) : null; } catch { return null; }
  }, [settingsForPreview, year]);

  if (gate) return <div className="module-workspace"><AccessGate state={gate} fa={fa} what={{ en: "The financial calendar needs the “Manage financial calendar” or “View Finance inbox and journals” permission.", fa: "تقویم مالی به صلاحیت «مدیریت تقویم مالی» یا «مشاهده صندوق مالی و ژورنال‌ها» نیاز دارد." }} /></div>;

  const locked = (view?.fiscalYears.length ?? 0) > 0;
  const canManage = view?.canManage ?? false;
  const showHijri = (view?.settings?.reportingCalendars ?? ["SOLAR_HIJRI", "GREGORIAN"]).includes("SOLAR_HIJRI");
  const showGregorian = (view?.settings?.reportingCalendars ?? ["SOLAR_HIJRI", "GREGORIAN"]).includes("GREGORIAN");
  const dual = (iso: string) => {
    const value = formatDual(iso, locale);
    return [showGregorian ? value.gregorian : null, showHijri ? value.solarHijri : null].filter(Boolean).join(" · ");
  };

  const save = async () => {
    setBusy(true); setMessage(null);
    const result = await api<{ version: number }>("/api/v1/finance/calendar", "PUT", {
      calendarKind: kind, customStartMonth: kind === "CUSTOM" ? startMonth : null, customStartDay: kind === "CUSTOM" ? startDay : null,
      reportingCalendars: [...reporting], expectedVersion: view?.settings?.version ?? 0
    });
    setBusy(false);
    if (!result.ok) { setMessage({ tone: "error", text: errorText(result.error, locale) }); return; }
    setMessage({ tone: "ok", text: fa ? "تنظیمات تقویم مالی ذخیره شد." : "Financial calendar settings saved." });
    await reload();
  };

  const generate = async () => {
    setBusy(true); setMessage(null);
    const result = await api<{ id: string }>("/api/v1/finance/calendar/fiscal-years", "POST", { fiscalYear: year });
    setBusy(false);
    if (!result.ok) { setMessage({ tone: "error", text: errorText(result.error, locale) }); return; }
    setMessage({ tone: "ok", text: fa ? "سال مالی با دوازده دوره در انتظار ایجاد شد." : "Fiscal year created with twelve pending periods." });
    await reload();
  };

  return (
    <div className="module-workspace calendar-workspace">
      <StageZeroPageHeader icon="finance"
        eyebrow={{ en: `Finance · ${view?.legalEntity.name ?? ""}`, fa: `مالی · ${view?.legalEntity.name ?? ""}` }}
        title={{ en: "Financial calendar", fa: "تقویم مالی" }}
        description={{ en: "Choose how this company's financial year runs, and generate its monthly accounting periods.", fa: "تعیین کنید سال مالی این شرکت چگونه است و دوره‌های ماهانه حسابداری آن را ایجاد کنید." }} />

      <section className="finance-boundary-banner"><span><AppIcon name="shield" size={22} /></span><div>
        <p>{fa ? "دوره‌ها در حالت انتظار ایجاد می‌شوند" : "PERIODS ARE CREATED AS PENDING"}</p>
        <strong>{fa ? "هیچ ثبتی در دوره در انتظار ممکن نیست. باز و بسته کردن دوره‌ها منتظر تصمیم مدیر مالی درباره صلاحیت آن است." : "Nothing can be posted into a pending period. Opening and closing periods waits for the Finance Manager's decision on who may do it."}</strong>
      </div><em>{fa ? "واحد پول پایه" : "Base currency"} · {view?.legalEntity.baseCurrency ?? "—"}</em></section>

      {message ? <div className={`treasury-message ${message.tone === "ok" ? "success" : "error"}`} role="status"><AppIcon name={message.tone === "ok" ? "shield" : "alert"} size={16} /><span>{message.text}</span><button onClick={() => setMessage(null)} aria-label={fa ? "بستن" : "Dismiss"}>×</button></div> : null}

      {view === null ? <p className="treasury-placeholder">{fa ? "در حال بارگذاری…" : "Loading…"}</p> : (
        <section className="calendar-grid">
          <div className="module-content-card calendar-settings">
            <div className="module-card-heading"><div><p>{fa ? "تنظیمات" : "SETTINGS"}</p><h2>{fa ? "سال مالی" : "Financial year"}</h2></div></div>
            {view.settings ? (
              <p className="admin-hint">{fa ? "فعلی: " : "Current: "}<strong>{t(KIND_COPY[view.settings.calendarKind].label)}</strong>
                {view.settings.calendarKind === "CUSTOM" && view.settings.customStartMonth
                  ? ` · ${fa ? "آغاز" : "starts"} ${fa ? toDariDigits(view.settings.customStartDay ?? 1) : view.settings.customStartDay} ${GREGORIAN_MONTHS[view.settings.customStartMonth - 1]?.[locale] ?? ""}` : ""}
                {view.settings.updatedBy ? ` · ${fa ? "توسط" : "by"} ${view.settings.updatedBy}` : ""}</p>
            ) : <p className="admin-hint">{fa ? "هنوز انتخاب نشده است." : "Not chosen yet."}</p>}
            {canManage ? (
              <form className="admin-form" onSubmit={(event) => { event.preventDefault(); void save(); }} aria-label={fa ? "تنظیمات تقویم مالی" : "Financial calendar settings"}>
                <fieldset className="calendar-kinds" disabled={busy || locked}>
                  <legend>{fa ? "نوع سال مالی" : "Year type"}</legend>
                  {(Object.keys(KIND_COPY) as CalendarKind[]).map((option) => (
                    <label key={option} className={kind === option ? "chosen" : ""}>
                      <input type="radio" name="calendar-kind" checked={kind === option} onChange={() => { setKind(option); setYear(suggestedYear(option)); }} />
                      <span><strong>{t(KIND_COPY[option].label)}</strong><small>{t(KIND_COPY[option].detail)}</small></span>
                    </label>
                  ))}
                </fieldset>
                {kind === "CUSTOM" ? (
                  <div className="calendar-custom">
                    <label><span>{fa ? "ماه آغاز" : "Start month"}</span>
                      <select value={startMonth} disabled={busy || locked} onChange={(event) => setStartMonth(Number(event.target.value))}>
                        {GREGORIAN_MONTHS.map((month) => <option key={month.month} value={month.month}>{month[locale]}</option>)}
                      </select></label>
                    <label><span>{fa ? "روز آغاز (۱–۲۸)" : "Start day (1–28)"}</span>
                      <input type="number" min={1} max={28} value={startDay} disabled={busy || locked} onChange={(event) => setStartDay(Number(event.target.value))} /></label>
                  </div>
                ) : null}
                {locked ? <p className="admin-hint">{fa ? "نوع سال پس از ایجاد نخستین سال مالی ثابت است؛ فقط تقویم گزارش قابل تغییر است." : "The year type is fixed once a fiscal year exists; only the report calendars can change."}</p> : null}
                <fieldset className="admin-status-choice" disabled={busy}>
                  <legend>{fa ? "نمایش تاریخ‌ها در گزارش‌ها" : "Show dates in reports as"}</legend>
                  {(["SOLAR_HIJRI", "GREGORIAN"] as const).map((option) => (
                    <label key={option}><input type="checkbox" checked={reporting.has(option)} onChange={() => setReporting((current) => {
                      const next = new Set(current); if (next.has(option)) { if (next.size > 1) next.delete(option); } else next.add(option); return next;
                    })} />{t(KIND_COPY[option].label)}</label>
                  ))}
                </fieldset>
                <button type="submit" className="treasury-button gold" disabled={busy}>{fa ? "ذخیره تنظیمات" : "Save settings"}</button>
              </form>
            ) : <p className="admin-hint">{fa ? "شما فقط می‌توانید تقویم را ببینید." : "You can view the calendar but not change it."}</p>}
          </div>

          <div className="module-content-card calendar-generate">
            <div className="module-card-heading"><div><p>{fa ? "سال مالی جدید" : "NEW FISCAL YEAR"}</p><h2>{fa ? "ایجاد دوره‌ها" : "Generate periods"}</h2></div></div>
            {view.settings && canManage ? (
              <form className="admin-form" onSubmit={(event) => { event.preventDefault(); void generate(); }} aria-label={fa ? "ایجاد سال مالی" : "Generate fiscal year"}>
                <label><span>{view.settings.calendarKind === "SOLAR_HIJRI" ? (fa ? "سال هجری شمسی" : "Solar Hijri year") : (fa ? "سال آغاز میلادی" : "Starting Gregorian year")}</span>
                  <input type="number" value={year} onChange={(event) => setYear(Number(event.target.value))} /></label>
                {preview ? <p className="admin-hint">{fa ? "پیش‌نمایش: " : "Preview: "}<strong>{fa ? preview.labelFa : preview.label}</strong> · {dual(preview.startsOn)} → {dual(preview.endsOn)}</p>
                  : <p className="admin-hint">{fa ? "این سال معتبر نیست." : "That year is not valid."}</p>}
                <button type="submit" className="treasury-button gold" disabled={busy || preview === null}>{fa ? "ایجاد سال مالی" : "Generate fiscal year"}</button>
              </form>
            ) : <p className="admin-hint">{view.settings ? (fa ? "ایجاد سال مالی به صلاحیت مدیریت تقویم نیاز دارد." : "Generating a year needs the calendar permission.") : (fa ? "ابتدا نوع سال مالی را ذخیره کنید." : "Save the year type first.")}</p>}
          </div>
        </section>
      )}

      {view?.fiscalYears.map((fiscalYear) => (
        <section key={fiscalYear.id} className="module-content-card calendar-year">
          <div className="module-card-heading"><div><p>{t(KIND_COPY[fiscalYear.calendarKind].label)}</p><h2>{fa ? fiscalYear.labelFa : fiscalYear.labelEn}</h2></div>
            <span>{dual(fiscalYear.startsOn)} → {dual(fiscalYear.endsOn)}</span></div>
          <table className="calendar-periods">
            <thead><tr><th>#</th><th>{fa ? "دوره" : "Period"}</th><th>{fa ? "از" : "From"}</th><th>{fa ? "تا" : "To"}</th><th>{fa ? "وضعیت" : "Status"}</th></tr></thead>
            <tbody>{fiscalYear.periods.map((period) => (
              <tr key={period.sequence}>
                <td>{fa ? toDariDigits(period.sequence) : period.sequence}</td>
                <td>{fa ? period.nameFa : period.nameEn}</td>
                <td>{dual(period.startsOn)}</td>
                <td>{dual(period.endsOn)}</td>
                <td><em className="treasury-chip muted">{period.status === "PENDING" ? (fa ? "در انتظار · بسته برای ثبت" : "Pending · not open for posting") : period.status}</em></td>
              </tr>
            ))}</tbody>
          </table>
        </section>
      ))}

      {view && view.otherPeriods.length > 0 ? (
        <section className="module-content-card calendar-year">
          <div className="module-card-heading"><div><p>{fa ? "خارج از سال مالی" : "OUTSIDE A FISCAL YEAR"}</p><h2>{fa ? "دوره‌های موجود" : "Existing periods"}</h2></div></div>
          <p className="admin-hint">{fa ? "دوره‌هایی که پیش از تقویم ایجاد شده‌اند. سال مالی جدید نمی‌تواند با آن‌ها هم‌پوشانی داشته باشد." : "Periods created before the calendar. A new fiscal year may not overlap them."}</p>
          <table className="calendar-periods">
            <thead><tr><th>{fa ? "دوره" : "Period"}</th><th>{fa ? "از" : "From"}</th><th>{fa ? "تا" : "To"}</th><th>{fa ? "وضعیت" : "Status"}</th></tr></thead>
            <tbody>{view.otherPeriods.map((period) => <tr key={period.name}><td>{period.name}</td><td>{dual(period.startsOn)}</td><td>{dual(period.endsOn)}</td><td><em className="treasury-chip">{period.status}</em></td></tr>)}</tbody>
          </table>
        </section>
      ) : null}
    </div>
  );
}
