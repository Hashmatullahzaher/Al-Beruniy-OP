"use client";

import type { ReportRange, TrialBalanceView } from "@abos/contracts";
import { formatDual } from "@abos/calendar";
import Link from "next/link";
import { Fragment, useCallback, useEffect, useState } from "react";

import { AccessGate, api, errorText } from "@/components/AdminUsersWorkspace";
import { AppIcon } from "@/components/AppIcon";
import { useLocale } from "@/components/LocaleProvider";
import { StageZeroPageHeader } from "@/components/StageZeroWorkspace";
import type { Copy } from "@/lib/access-copy";

type Mode = "asOf" | "period" | "range";

/** Groups decimal text for display without converting any amount to a JavaScript number. */
export function reportAmount(value: string): string {
  if (value === "0" || /^0\.0+$/.test(value)) return "—";
  const negative = value.startsWith("-");
  const [whole = "0", fraction] = (negative ? value.slice(1) : value).split(".");
  return `${negative ? "−" : ""}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${fraction === undefined ? "" : `.${fraction}`}`;
}

/** The query string of a report range, shared with the account statement links. */
export function rangeQuery(range: ReportRange): string {
  if (range.mode === "PERIOD" && range.period) return `periodId=${encodeURIComponent(range.period.id)}`;
  if (range.mode === "AS_OF") return `asOf=${range.to}`;
  return `from=${range.from}&to=${range.to}`;
}

export function rangeLabel(range: ReportRange, fa: boolean): string {
  const dual = (iso: string) => { const d = formatDual(iso, fa ? "fa" : "en"); return `${d.gregorian} (${d.solarHijri})`; };
  const named = range.period ? `${fa && range.period.nameFa ? range.period.nameFa : range.period.name} · ` : "";
  return `${named}${dual(range.from)} – ${dual(range.to)}`;
}

const TYPE_COPY: Readonly<Record<string, Copy>> = {
  ASSET: { en: "Asset", fa: "دارایی" }, LIABILITY: { en: "Liability", fa: "بدهی" }, EQUITY: { en: "Equity", fa: "سرمایه" },
  REVENUE: { en: "Income", fa: "عاید" }, EXPENSE: { en: "Expense", fa: "مصرف" }
};

export function TrialBalanceWorkspace() {
  const { locale } = useLocale();
  const fa = locale === "fa";
  const t = useCallback((copy: Copy) => copy[locale], [locale]);
  const today = new Date().toISOString().slice(0, 10);
  const [mode, setMode] = useState<Mode>("asOf");
  const [asOf, setAsOf] = useState(today);
  const [from, setFrom] = useState(`${today.slice(0, 7)}-01`);
  const [to, setTo] = useState(today);
  const [periodId, setPeriodId] = useState("");
  const [includeZero, setIncludeZero] = useState(false);
  const [view, setView] = useState<TrialBalanceView | null>(null);
  const [periods, setPeriods] = useState<ReportRange["periods"]>([]);
  const [gate, setGate] = useState<"signed-out" | "denied" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const show = useCallback((result: Awaited<ReturnType<typeof api<TrialBalanceView>>>) => {
    setBusy(false);
    if (result.ok) {
      setView(result.data); setGate(null);
      setPeriods((known) => (known.length >= result.data.range.periods.length ? known : result.data.range.periods));
      return;
    }
    setGate(result.status === 401 ? "signed-out" : result.status === 403 ? "denied" : null);
    if (result.status !== 401 && result.status !== 403) setError(fa ? errorText(result.error, "fa") : result.error.message || errorText(result.error, "en"));
  }, [fa]);
  const load = async (query: string) => {
    setBusy(true); setError(null);
    show(await api<TrialBalanceView>(`/api/v1/finance/trial-balance?${query}`));
  };

  useEffect(() => {
    let current = true;
    void api<TrialBalanceView>(`/api/v1/finance/trial-balance?asOf=${today}`).then((result) => { if (current) show(result); });
    return () => { current = false; };
  }, [show, today]);

  const query = () => {
    const base = mode === "asOf" ? `asOf=${asOf}` : mode === "period" ? `periodId=${encodeURIComponent(periodId)}` : `from=${from}&to=${to}`;
    return includeZero ? `${base}&includeZero=true` : base;
  };
  const valid = mode === "asOf" ? asOf !== "" : mode === "period" ? periodId !== "" : from !== "" && to !== "" && from <= to;

  if (gate) {
    return <div className="module-workspace"><AccessGate state={gate} fa={fa} what={{
      en: "The trial balance needs permission to read Finance reports.", fa: "بیلانس آزمایشی به صلاحیت خواندن گزارش‌های مالی نیاز دارد."
    }} /></div>;
  }

  return (
    <div className="module-workspace trial-balance-workspace">
      <StageZeroPageHeader icon="reports-analytics"
        eyebrow={{ en: "Finance · Accounting", fa: "مالی · حسابداری" }}
        title={{ en: "Trial balance", fa: "بیلانس آزمایشی" }}
        description={{
          en: "Every account's opening, period and ending position in the accounting currency, from posted journals only. Debits and credits are shown separately and must agree.",
          fa: "موجودی افتتاحیه، دوره و پایانی هر حساب به واحد پول حسابداری، فقط از ژورنال‌های ثبت‌شده. بدهکار و بستانکار جدا نشان داده می‌شوند و باید برابر باشند."
        }} />

      <form className="admin-form report-filters" aria-label={fa ? "فیلتر گزارش" : "Report filters"}
        onSubmit={(event) => { event.preventDefault(); if (valid) void load(query()); }}>
        <label><span>{fa ? "گزارش برای" : "Report for"}</span>
          <select value={mode} onChange={(event) => setMode(event.target.value as Mode)}>
            <option value="asOf">{fa ? "تا تاریخ (از آغاز سال مالی)" : "As of a date (year to date)"}</option>
            <option value="period">{fa ? "یک ماه حسابداری" : "An accounting month"}</option>
            <option value="range">{fa ? "بازهٔ تاریخ" : "A date range"}</option>
          </select></label>
        {mode === "asOf" ? <label><span>{fa ? "تاریخ" : "Date"}</span>
          <input type="date" dir="ltr" value={asOf} onChange={(event) => setAsOf(event.target.value)} /></label> : null}
        {mode === "period" ? <label><span>{fa ? "ماه حسابداری" : "Accounting month"}</span>
          <select value={periodId} onChange={(event) => setPeriodId(event.target.value)}>
            <option value="">{fa ? "انتخاب کنید" : "Choose"}</option>
            {periods.map((p) => <option key={p.id} value={p.id}>{fa && p.nameFa ? p.nameFa : p.name}</option>)}
          </select></label> : null}
        {mode === "range" ? <>
          <label><span>{fa ? "از" : "From"}</span><input type="date" dir="ltr" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
          <label><span>{fa ? "تا" : "To"}</span><input type="date" dir="ltr" value={to} onChange={(event) => setTo(event.target.value)} /></label>
        </> : null}
        <label className="admin-checkbox"><input type="checkbox" checked={includeZero} onChange={(event) => setIncludeZero(event.target.checked)} />
          {" "}{fa ? "حساب‌های بدون موجودی هم نشان داده شوند" : "Include accounts with no balance"}</label>
        <div className="admin-form-actions">
          <button className="treasury-button gold" type="submit" disabled={busy || !valid}>{busy ? (fa ? "در حال بارگذاری…" : "Loading…") : (fa ? "نمایش" : "Show")}</button>
          <button className="treasury-button" type="button" onClick={() => window.print()} disabled={view === null}>{fa ? "چاپ" : "Print"}</button>
        </div>
      </form>

      {error ? <div className="treasury-message error" role="alert"><AppIcon name="alert" size={16} /><span>{error}</span></div> : null}
      {view === null ? <p className="treasury-placeholder">{fa ? "در حال بارگذاری…" : "Loading…"}</p> : (
        <section className="module-content-card" aria-label={fa ? "بیلانس آزمایشی" : "Trial balance"}>
          <h2>{rangeLabel(view.range, fa)}</h2>
          <p className={view.balanced ? "treasury-message success" : "treasury-message error"} role="status">
            {view.balanced
              ? (fa ? `متوازن: مجموع بدهکار برابر مجموع بستانکار است (${view.baseCurrency}).` : `Balanced: total debits equal total credits (${view.baseCurrency}).`)
              : (fa ? "متوازن نیست: این یک خطای جدی است؛ با مدیر مالی تماس بگیرید." : "Not balanced: this is a serious integrity problem; contact the Finance Manager.")}</p>
          {view.range.fiscalYear !== null && !view.range.fiscalYear.closed
            ? <p className="admin-hint">{fa ? "سال مالی این بازه هنوز فعال است؛ تا بسته شدن سال مالی ممکن است ثبت‌های تازه‌ای اضافه شود." : "This financial year is still active; new postings may still be added until the financial year is closed."}</p> : null}
          {view.accounts.length === 0 ? <p>{fa ? "در این بازه چیزی ثبت نشده است." : "Nothing has been posted for this range."}</p> : (
            <div className="table-scroll"><table className="rates-table trial-balance">
              <thead>
                <tr><th rowSpan={2}>{fa ? "کد" : "Code"}</th><th rowSpan={2}>{fa ? "حساب" : "Account"}</th>
                  <th colSpan={2}>{fa ? "افتتاحیه" : "Opening"}</th><th colSpan={2}>{fa ? "دوره" : "Period"}</th><th colSpan={2}>{fa ? "پایانی" : "Ending"}</th></tr>
                <tr>{[0, 1, 2].map((i) => <Fragment key={i}><th>{fa ? "بدهکار" : "Debit"}</th><th>{fa ? "بستانکار" : "Credit"}</th></Fragment>)}</tr>
              </thead>
              <tbody>{view.accounts.map((row) => <Fragment key={row.accountId}>
                <tr>
                  <td dir="ltr"><Link href={`/finance/account-statement?accountId=${row.accountId}&${rangeQuery(view.range)}`}>{row.accountCode}</Link></td>
                  <td>{row.accountName} <small className="admin-hint">{t(TYPE_COPY[row.accountType] ?? { en: row.accountType, fa: row.accountType })}</small></td>
                  {[row.openingDebit, row.openingCredit, row.periodDebit, row.periodCredit, row.endingDebit, row.endingCredit].map((value, i) =>
                    <td key={i} dir="ltr" className="amount">{reportAmount(value)}</td>)}
                </tr>
                {row.native.map((n) => <tr key={`${row.accountId}-${n.currency}`} className="native-detail">
                  <td /><td><small>{fa ? `مبلغ اصلی به ${n.currency}` : `Native ${n.currency}`}</small></td>
                  <td colSpan={2} dir="ltr" className="amount"><small>{n.currency} {reportAmount(n.openingNet)}</small></td>
                  <td dir="ltr" className="amount"><small>{reportAmount(n.periodDebit)}</small></td>
                  <td dir="ltr" className="amount"><small>{reportAmount(n.periodCredit)}</small></td>
                  <td colSpan={2} dir="ltr" className="amount"><small>{n.currency} {reportAmount(n.endingNet)}</small></td>
                </tr>)}
              </Fragment>)}</tbody>
              <tfoot><tr><th colSpan={2}>{fa ? "مجموع" : "Total"} ({view.baseCurrency})</th>
                {[view.totals.openingDebit, view.totals.openingCredit, view.totals.periodDebit, view.totals.periodCredit, view.totals.endingDebit,
                  view.totals.endingCredit].map((value, i) => <th key={i} dir="ltr" className="amount">{reportAmount(value)}</th>)}</tr></tfoot>
            </table></div>
          )}
        </section>
      )}
    </div>
  );
}
