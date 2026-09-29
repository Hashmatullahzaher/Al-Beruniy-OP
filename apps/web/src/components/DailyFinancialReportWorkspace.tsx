"use client";

import type { OperationalFinanceDailyReport } from "@abos/contracts";
import { useEffect, useState } from "react";

import { AccessGate, api } from "@/components/AdminUsersWorkspace";
import { AppIcon } from "@/components/AppIcon";
import { useLocale } from "@/components/LocaleProvider";
import { expenseErrorText, kabulToday, localizedName, money } from "@/components/OperationalFinanceShared";
import { StageZeroPageHeader } from "@/components/StageZeroWorkspace";

export function DailyFinancialReportWorkspace() {
  const { locale } = useLocale();
  const fa = locale === "fa";
  const [date, setDate] = useState(kabulToday());
  const [report, setReport] = useState<OperationalFinanceDailyReport | null>(null);
  const [gate, setGate] = useState<"signed-out" | "denied" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    let current = true;
    void api<OperationalFinanceDailyReport>(
      `/api/v1/finance/operations/daily-report?date=${encodeURIComponent(date)}`
    ).then((result) => {
      if (!current) return;
      if (!result.ok) {
        setGate(result.status === 401 ? "signed-out" : result.status === 403 ? "denied" : null);
        if (result.status !== 401 && result.status !== 403) setError(expenseErrorText(result.error, locale));
        return;
      }
      setGate(null);
      setError(null);
      setReport(result.data);
    });
    return () => { current = false; };
  }, [date, locale]);

  if (gate) {
    return <div className="module-workspace"><AccessGate state={gate} fa={fa} what={{
      en: "The daily report needs the Finance role that views expenses.",
      fa: "گزارش روزانه به نقش مالی مشاهده مصارف نیاز دارد."
    }} /></div>;
  }

  const showBase = report !== null && report.totalsByCurrency.some((total) => total.currency !== report.baseCurrency);

  return (
    <div className="module-workspace daily-report-workspace">
      <StageZeroPageHeader icon="reports-analytics"
        eyebrow={{ en: "Finance · Reports", fa: "مالی · گزارش‌ها" }}
        title={{ en: "Daily financial report", fa: "گزارش مالی روزانه" }}
        description={{
          en: "What was paid out on one day, by expense type and by Treasury account. Figures come only from recorded transactions.",
          fa: "آنچه در یک روز پرداخت شده، به تفکیک نوع مصرف و حساب خزانه. ارقام فقط از معاملات ثبت‌شده می‌آیند."
        }} />

      {error ? <div className="treasury-message error" role="alert"><AppIcon name="alert" size={16} /><span>{error}</span></div> : null}

      <section className="module-content-card register-filter">
        <form className="admin-form register-range" aria-label={fa ? "تاریخ گزارش" : "Report date"} onSubmit={(event) => event.preventDefault()}>
          <label><span>{fa ? "تاریخ" : "Date"}</span><input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label>
        </form>
      </section>

      {report === null ? <p className="treasury-placeholder">{fa ? "در حال بارگذاری…" : "Loading…"}</p> : (
        <>
          <section className="metric-grid register-totals" aria-label={fa ? "جمع روز" : "Day totals"}>
            {report.totalsByCurrency.length === 0 ? (
              <div className="metric-card"><span className="metric-icon"><AppIcon name="coins" size={18} /></span>
                <div><h3>{fa ? "مصارف روز" : "Expenses of the day"}</h3><p>{fa ? "در این روز مصرفی ثبت نشده است." : "No expense was recorded on this day."}</p></div></div>
            ) : report.totalsByCurrency.map((total) => (
              <div className="metric-card" key={total.currency}><span className="metric-icon"><AppIcon name="coins" size={18} /></span>
                <div><h3>{fa ? `مصارف به ${total.currency} (${total.count})` : `Expenses in ${total.currency} (${total.count})`}</h3>
                  <p className="register-figure" dir="ltr">{money(total.amount, total.currency)}</p></div></div>
            ))}
            {showBase ? (
              <div className="metric-card"><span className="metric-icon"><AppIcon name="finance" size={18} /></span>
                <div><h3>{fa ? `همه، معادل ${report.baseCurrency}` : `All, in ${report.baseCurrency}`}</h3>
                  <p className="register-figure" dir="ltr">{money(report.baseTotal.amount, report.baseTotal.currency)}</p></div></div>
            ) : null}
            {report.pendingApproval.count > 0 ? (
              <div className="metric-card"><span className="metric-icon"><AppIcon name="alert" size={18} /></span>
                <div><h3>{fa ? "منتظر تأیید" : "Waiting for approval"}</h3><p className="register-figure">{report.pendingApproval.count}</p></div></div>
            ) : null}
          </section>

          <section className="module-content-card">
            <div className="module-card-heading"><div><p>{fa ? "مصارف" : "EXPENSES"}</p><h2>{fa ? "به تفکیک نوع مصرف" : "By expense type"}</h2></div></div>
            {report.expensesByCategory.length === 0 ? <p className="treasury-placeholder">{fa ? "چیزی برای نمایش نیست." : "Nothing to show."}</p> : (
              <table className="rates-table">
                <thead><tr><th>{fa ? "نوع مصرف" : "Expense type"}</th><th>{fa ? "تعداد" : "Count"}</th><th>{fa ? "مبلغ" : "Amount"}</th>{showBase ? <th>{fa ? `معادل ${report.baseCurrency}` : `In ${report.baseCurrency}`}</th> : null}</tr></thead>
                <tbody>{report.expensesByCategory.map((row) => (
                  <tr key={`${row.categoryId}-${row.currency}`}>
                    <td data-label={fa ? "نوع مصرف" : "Expense type"}>{localizedName(row, fa)}</td>
                    <td data-label={fa ? "تعداد" : "Count"}>{row.count}</td>
                    <td data-label={fa ? "مبلغ" : "Amount"} dir="ltr" className="rates-value">{money(row.amount, row.currency)}</td>
                    {showBase ? <td data-label={fa ? `معادل ${report.baseCurrency}` : `In ${report.baseCurrency}`} dir="ltr" className="rates-value">{money(row.baseAmount, report.baseCurrency)}</td> : null}
                  </tr>
                ))}</tbody>
              </table>
            )}
          </section>

          <section className="module-content-card">
            <div className="module-card-heading"><div><p>{fa ? "خزانه" : "TREASURY"}</p><h2>{fa ? "حرکت‌ها به تفکیک حساب" : "Movements by account"}</h2></div></div>
            {report.treasuryMovements.length === 0 ? <p className="treasury-placeholder">{fa ? "هنوز حساب خزانه‌ای تنظیم نشده است." : "No Treasury account is set up yet."}</p> : (
              <table className="rates-table">
                <thead><tr><th>{fa ? "حساب" : "Account"}</th><th>{fa ? "پیش از این روز" : "Before this day"}</th><th>{fa ? "این روز" : "This day"}</th><th>{fa ? "پس از این روز" : "After this day"}</th></tr></thead>
                <tbody>{report.treasuryMovements.map((row) => (
                  <tr key={row.treasuryAccountId}>
                    <td data-label={fa ? "حساب" : "Account"}>{localizedName(row, fa)} · {row.currency}</td>
                    <td data-label={fa ? "پیش از این روز" : "Before this day"} dir="ltr" className="rates-value">{money(row.before, row.currency)}</td>
                    <td data-label={fa ? "این روز" : "This day"} dir="ltr" className="rates-value">{money(row.day, row.currency)}</td>
                    <td data-label={fa ? "پس از این روز" : "After this day"} dir="ltr" className="rates-value">{money(row.after, row.currency)}</td>
                  </tr>
                ))}</tbody>
              </table>
            )}
            <p className="admin-hint">{fa
              ? "این ارقام فقط پرداخت‌هایی را نشان می‌دهند که در این سیستم ثبت شده‌اند. موجودی‌های آغازین هنوز وارد نشده‌اند، پس این‌ها موجودی واقعی صندوق یا بانک نیستند."
              : "These figures show only payments recorded in this system. Opening balances have not been loaded yet, so they are not the actual safe or bank balances."}</p>
          </section>
        </>
      )}
    </div>
  );
}
