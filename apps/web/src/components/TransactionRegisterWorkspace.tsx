"use client";

import type {
  OperationalExpenseMutationResult,
  OperationalExpenseView,
  OperationalExpenseWorkspace
} from "@abos/contracts";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { AccessGate, api, formatWhen } from "@/components/AdminUsersWorkspace";
import { AppIcon } from "@/components/AppIcon";
import { useLocale } from "@/components/LocaleProvider";
import {
  EXPENSE_STATUS_COPY,
  exactAmount,
  expenseErrorText,
  firstOfMonth,
  kabulToday,
  localizedName,
  money
} from "@/components/OperationalFinanceShared";
import { StageZeroPageHeader } from "@/components/StageZeroWorkspace";

export function TransactionRegisterWorkspace() {
  const { locale } = useLocale();
  const fa = locale === "fa";
  const today = kabulToday();
  const [range, setRange] = useState({ from: firstOfMonth(today), to: today });
  const [view, setView] = useState<OperationalExpenseWorkspace | null>(null);
  const [gate, setGate] = useState<"signed-out" | "denied" | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [approving, setApproving] = useState<{ id: string; note: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (from: string, to: string) => {
    const result = await api<OperationalExpenseWorkspace>(
      `/api/v1/finance/operations/expenses?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    if (!result.ok) {
      setGate(result.status === 401 ? "signed-out" : result.status === 403 ? "denied" : null);
      if (result.status !== 401 && result.status !== 403) setMessage({ tone: "error", text: expenseErrorText(result.error, locale) });
      return;
    }
    setGate(null);
    setView(result.data);
  }, [locale]);

  useEffect(() => {
    if (range.from === "" || range.to === "" || range.from > range.to) return;
    let current = true;
    void api<OperationalExpenseWorkspace>(
      `/api/v1/finance/operations/expenses?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`
    ).then((result) => {
      if (!current) return;
      if (!result.ok) {
        setGate(result.status === 401 ? "signed-out" : result.status === 403 ? "denied" : null);
        if (result.status !== 401 && result.status !== 403) setMessage({ tone: "error", text: expenseErrorText(result.error, locale) });
        return;
      }
      setGate(null);
      setView(result.data);
    });
    return () => { current = false; };
  }, [range, locale]);

  if (gate) {
    return <div className="module-workspace"><AccessGate state={gate} fa={fa} what={{
      en: "Daily transactions need the Finance role that views expenses.",
      fa: "معاملات روزانه به نقش مالی مشاهده مصارف نیاز دارد."
    }} /></div>;
  }

  const approve = async (expense: OperationalExpenseView) => {
    if (!approving) return;
    setBusy(true);
    setMessage(null);
    const result = await api<OperationalExpenseMutationResult>(
      `/api/v1/finance/operations/expenses/${expense.id}/approve`, "POST",
      { expectedVersion: expense.version, note: approving.note.trim() });
    setBusy(false);
    if (!result.ok) { setMessage({ tone: "error", text: expenseErrorText(result.error, locale) }); return; }
    setApproving(null);
    setMessage({ tone: "ok", text: fa ? "مصرف تأیید و ثبت شد." : "Expense approved and recorded." });
    await load(range.from, range.to);
  };

  const pending = view?.expenses.filter((expense) => expense.status === "PENDING_APPROVAL") ?? [];
  const validRange = range.from !== "" && range.to !== "" && range.from <= range.to;

  return (
    <div className="module-workspace register-workspace">
      <StageZeroPageHeader icon="reports-analytics"
        eyebrow={{ en: "Finance · Daily work", fa: "مالی · کار روزانه" }}
        title={{ en: "Daily transactions", fa: "معاملات روزانه" }}
        description={{
          en: "Every expense recorded in the chosen dates, with who recorded it. Amounts are shown exactly, and currencies are never added together.",
          fa: "همه مصارف ثبت‌شده در تاریخ‌های انتخاب‌شده، با ثبت‌کننده آن‌ها. مبالغ دقیق نشان داده می‌شوند و واحدهای پول هرگز با هم جمع نمی‌شوند."
        }}>
        {view?.permissions.canCreate ? <Link className="treasury-button gold" href="/finance/record-expense">{fa ? "ثبت مصرف" : "Record expense"}</Link> : null}
      </StageZeroPageHeader>

      {message ? <div className={`treasury-message ${message.tone === "ok" ? "success" : "error"}`} role="status"><AppIcon name={message.tone === "ok" ? "shield" : "alert"} size={16} /><span>{message.text}</span><button onClick={() => setMessage(null)} aria-label={fa ? "بستن" : "Dismiss"}>×</button></div> : null}

      <section className="module-content-card register-filter">
        <form className="admin-form register-range" aria-label={fa ? "بازه تاریخ" : "Date range"} onSubmit={(event) => event.preventDefault()}>
          <label><span>{fa ? "از" : "From"}</span><input type="date" value={range.from} onChange={(event) => setRange((value) => ({ ...value, from: event.target.value }))} /></label>
          <label><span>{fa ? "تا" : "To"}</span><input type="date" value={range.to} onChange={(event) => setRange((value) => ({ ...value, to: event.target.value }))} /></label>
        </form>
        {!validRange ? <p className="admin-hint expense-warning">{fa ? "تاریخ شروع باید پیش از تاریخ پایان باشد." : "The start date must not be after the end date."}</p> : null}
      </section>

      {view === null ? <p className="treasury-placeholder">{fa ? "در حال بارگذاری…" : "Loading…"}</p> : (
        <>
          <section className="metric-grid register-totals" aria-label={fa ? "جمع‌ها" : "Totals"}>
            {view.totalsByOriginalCurrency.length === 0 ? (
              <div className="metric-card"><span className="metric-icon"><AppIcon name="coins" size={18} /></span>
                <div><h3>{fa ? "مصارف ثبت‌شده" : "Recorded expenses"}</h3><p>{fa ? "در این تاریخ‌ها چیزی ثبت نشده است." : "Nothing recorded in these dates."}</p></div></div>
            ) : view.totalsByOriginalCurrency.map((total) => (
              <div className="metric-card" key={total.currency}><span className="metric-icon"><AppIcon name="coins" size={18} /></span>
                <div><h3>{fa ? `مصارف به ${total.currency}` : `Expenses in ${total.currency}`}</h3><p className="register-figure" dir="ltr">{money(total.amount, total.currency)}</p></div></div>
            ))}
            {view.baseTotal.currency && view.totalsByOriginalCurrency.some((total) => total.currency !== view.baseTotal.currency) ? (
              <div className="metric-card"><span className="metric-icon"><AppIcon name="finance" size={18} /></span>
                <div><h3>{fa ? `معادل همه به ${view.baseTotal.currency}` : `All, in ${view.baseTotal.currency}`}</h3><p className="register-figure" dir="ltr">{money(view.baseTotal.amount, view.baseTotal.currency)}</p></div></div>
            ) : null}
          </section>

          {view.permissions.canApprove && pending.length > 0 ? (
            <section className="module-content-card">
              <div className="module-card-heading"><div><p>{fa ? "کار من" : "MY WORK"}</p><h2>{fa ? `منتظر تأیید (${pending.length})` : `Waiting for approval (${pending.length})`}</h2></div></div>
              <p className="admin-hint">{fa ? "مصرفی را که خودتان ثبت کرده‌اید نمی‌توانید تأیید کنید." : "You cannot approve an expense you recorded yourself."}</p>
            </section>
          ) : null}

          <section className="module-content-card">
            {view.expenses.length === 0 ? <p className="treasury-placeholder">{fa ? "در این تاریخ‌ها معامله‌ای ثبت نشده است." : "No transactions in these dates."}</p> : (
              <table className="rates-table register-table">
                <thead><tr>
                  <th>{fa ? "تاریخ" : "Date"}</th><th>{fa ? "مرجع" : "Reference"}</th><th>{fa ? "شرح" : "Description"}</th>
                  <th>{fa ? "نوع" : "Type"}</th><th>{fa ? "پرداخت از" : "Paid from"}</th><th>{fa ? "مبلغ" : "Amount"}</th>
                  <th>{fa ? "وضعیت" : "Status"}</th><th>{fa ? "ثبت‌کننده" : "Recorded by"}</th><th />
                </tr></thead>
                <tbody>{view.expenses.map((expense) => (
                  <tr key={expense.id}>
                    <td data-label={fa ? "تاریخ" : "Date"}>{expense.businessDate}</td>
                    <td data-label={fa ? "مرجع" : "Reference"}>{expense.reference}</td>
                    <td data-label={fa ? "شرح" : "Description"}>{expense.description}{expense.payeeName ? <small className="rates-used">{fa ? "به: " : "To: "}{expense.payeeName}</small> : null}</td>
                    <td data-label={fa ? "نوع" : "Type"}>{localizedName({ nameEn: expense.expenseCategoryNameEn, nameFa: expense.expenseCategoryNameFa }, fa)}</td>
                    <td data-label={fa ? "پرداخت از" : "Paid from"}>{localizedName({ nameEn: expense.treasuryAccountNameEn, nameFa: expense.treasuryAccountNameFa }, fa)}</td>
                    <td data-label={fa ? "مبلغ" : "Amount"} dir="ltr" className="rates-value">{money(expense.originalAmount, expense.originalCurrency)}
                      {expense.exchangeRateSnapshot && expense.baseAmount ? <small className="rates-used">= {money(expense.baseAmount, expense.baseCurrency)} · 1 {expense.exchangeRateSnapshot.unitCurrency} = {exactAmount(expense.exchangeRateSnapshot.rate)} {expense.exchangeRateSnapshot.quoteCurrency}</small> : null}</td>
                    <td data-label={fa ? "وضعیت" : "Status"}><em className={`treasury-chip ${expense.status === "POSTED" ? "" : "muted"}`}>{EXPENSE_STATUS_COPY[expense.status][locale]}</em>
                      {expense.approval ? <small className="rates-used">{fa ? "تأیید: " : "Approved by "}{expense.approval.approvedBy}</small> : null}</td>
                    <td data-label={fa ? "ثبت‌کننده" : "Recorded by"}>{expense.createdBy}<small className="rates-used">{formatWhen(expense.createdAt, locale)}</small></td>
                    <td>{view.permissions.canApprove && expense.status === "PENDING_APPROVAL" ? (approving?.id === expense.id ? (
                      <form className="admin-form rates-correction" aria-label={fa ? "تأیید مصرف" : "Approve expense"} onSubmit={(event) => { event.preventDefault(); void approve(expense); }}>
                        <label><span>{fa ? "یادداشت تأیید" : "Approval note"}</span><input value={approving.note} minLength={5} maxLength={500} required onChange={(event) => setApproving({ id: expense.id, note: event.target.value })} /></label>
                        <div className="rates-actions">
                          <button type="submit" className="treasury-button gold" disabled={busy || approving.note.trim().length < 5}>{fa ? "تأیید و ثبت" : "Approve and record"}</button>
                          <button type="button" className="treasury-button" onClick={() => setApproving(null)}>{fa ? "لغو" : "Cancel"}</button>
                        </div>
                      </form>
                    ) : <button type="button" className="treasury-button" onClick={() => setApproving({ id: expense.id, note: "" })}>{fa ? "تأیید" : "Approve"}</button>) : null}</td>
                  </tr>
                ))}</tbody>
              </table>
            )}
          </section>
        </>
      )}
    </div>
  );
}
