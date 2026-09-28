"use client";

import { formatDual } from "@abos/calendar";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { AccessGate, api, errorText } from "@/components/AdminUsersWorkspace";
import { StageZeroPageHeader } from "@/components/StageZeroWorkspace";
import { useLocale } from "@/components/LocaleProvider";
import type { ChartOfAccountsView } from "@/server/chart-of-accounts";
import type { GeneralLedgerLine, GeneralLedgerView } from "@/server/general-ledger";

function initialRange(): { from: string; to: string } {
  const now = new Date();
  const to = now.toISOString().slice(0, 10);
  const from = new Date(Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth(), now.getUTCDate())).toISOString().slice(0, 10);
  return { from, to };
}

const INITIAL = initialRange();

function requestLedger(dateFrom: string, dateTo: string, selectedAccount: string) {
  const params = new URLSearchParams({ from: dateFrom, to: dateTo });
  if (selectedAccount) params.set("accountId", selectedAccount);
  return api<GeneralLedgerView>(`/api/v1/finance/general-ledger?${params}`);
}

/** Groups decimal text for display without converting any amount to a JavaScript number. */
function amount(value: string): string {
  const negative = value.startsWith("-");
  const [whole = "0", fraction] = (negative ? value.slice(1) : value).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "−" : ""}${grouped}${fraction === undefined ? "" : `.${fraction}`}`;
}

export function GeneralLedgerWorkspace() {
  const { locale } = useLocale();
  const fa = locale === "fa";
  const [from, setFrom] = useState(INITIAL.from);
  const [to, setTo] = useState(INITIAL.to);
  const [accountId, setAccountId] = useState("");
  const [accounts, setAccounts] = useState<ChartOfAccountsView["accounts"]>([]);
  const [view, setView] = useState<GeneralLedgerView | null>(null);
  const [gate, setGate] = useState<"signed-out" | "denied" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const apply = useCallback((response: Awaited<ReturnType<typeof requestLedger>>) => {
    setBusy(false);
    if (!response.ok) {
      setGate(response.status === 401 ? "signed-out" : response.status === 403 ? "denied" : null);
      setView(null);
      if (response.status !== 401 && response.status !== 403) setProblem(errorText(response.error, locale));
      return;
    }
    setGate(null);
    setView(response.data);
  }, [locale]);

  useEffect(() => {
    void requestLedger(INITIAL.from, INITIAL.to, "").then(apply);
    void api<ChartOfAccountsView>("/api/v1/finance/accounts").then((response) => {
      if (response.ok) setAccounts(response.data.accounts);
    });
  }, [apply]);

  const dual = (iso: string) => {
    const dates = formatDual(iso, locale);
    return `${dates.gregorian} · ${dates.solarHijri}`;
  };

  if (gate) return <div className="module-workspace"><AccessGate state={gate} fa={fa} what={{
    en: "Posted General Ledger activity requires the Finance operational report permission.",
    fa: "نمایش دفتر کل ثبت‌شده به صلاحیت گزارش عملیاتی مالی نیاز دارد."
  }} /></div>;

  return (
    <div className="module-workspace">
      <StageZeroPageHeader icon="finance" eyebrow={{ en: "FINANCE · POSTED ACTIVITY", fa: "مالی · فعالیت ثبت‌شده" }}
        title={{ en: "General Ledger activity", fa: "فعالیت دفتر کل" }}
        description={{ en: "Read-only journal lines posted in this legal entity, with exact amounts and source references.",
          fa: "ردیف‌های ثبت‌شدهٔ ژورنال این شرکت، همراه با مبلغ دقیق و مرجع منبع، فقط برای مشاهده." }} />

      <div className="finance-boundary-banner" role="note">
        <span aria-hidden="true">ⓘ</span>
        <div><p>{fa ? "دادهٔ مصنوعی · پیش‌نمایش عملیاتی" : "SYNTHETIC DATA · OPERATIONAL PREVIEW"}</p>
          <strong>{fa ? "این فهرست صورت مالی رسمی نیست؛ مانده‌های افتتاحیه و دوره‌های بسته‌شده هنوز تکمیل نشده‌اند." : "This activity list is not an official financial statement. Opening positions and period close are not complete."}</strong></div>
        <em>{fa ? "فقط خواندنی" : "READ ONLY"}</em>
      </div>

      <section className="module-content-card" aria-label={fa ? "فیلتر گزارش" : "Report filters"}>
        <div className="module-card-heading"><div><p>{fa ? "فیلترها" : "FILTERS"}</p><h2>{fa ? "بازه و حساب" : "Date range and account"}</h2></div></div>
        <form className="admin-form" style={{ padding: 14, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 190px), 1fr))", alignItems: "end" }}
          onSubmit={(event) => { event.preventDefault(); setBusy(true); setProblem(null); void requestLedger(from, to, accountId).then(apply); }}>
          <label><span>{fa ? "از تاریخ میلادی" : "From (Gregorian)"}</span>
            <input type="date" value={from} max={to} onChange={(event) => setFrom(event.target.value)} required /></label>
          <label><span>{fa ? "تا تاریخ میلادی" : "To (Gregorian)"}</span>
            <input type="date" value={to} min={from} onChange={(event) => setTo(event.target.value)} required /></label>
          {accounts.length > 0 ? <label><span>{fa ? "حساب" : "Account"}</span>
            <select value={accountId} onChange={(event) => setAccountId(event.target.value)}>
              <option value="">{fa ? "همه حساب‌ها" : "All accounts"}</option>
              {accounts.map((account) => <option key={account.id} value={account.id}>{account.code} · {fa && account.nameFa ? account.nameFa : account.name}</option>)}
            </select></label> : null}
          <button type="submit" className="treasury-button gold" disabled={busy || !from || !to || from > to}>
            {busy ? (fa ? "در حال بارگذاری…" : "Loading…") : (fa ? "نمایش فعالیت" : "Show activity")}
          </button>
        </form>
      </section>

      {problem ? <p className="treasury-message error" role="alert">{problem}</p> : null}

      {view ? <>
        <section className="module-content-card" aria-label={fa ? "مجموع ردیف‌ها" : "Line totals"}>
          <div className="module-card-heading"><div><p>{fa ? "مجموع دورهٔ انتخاب‌شده" : "FULL FILTERED PERIOD"}</p><h2>{fa ? "جمع بدهکار و بستانکار" : "Debit and credit totals"}</h2></div>
            <span>{dual(view.from)} → {dual(view.to)}</span></div>
          {view.totals.length === 0 ? <p className="treasury-placeholder">{fa ? "هیچ ژورنال ثبت‌شده‌ای در این بازه نیست." : "No posted journal lines in this range."}</p>
            : <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 230px), 1fr))", gap: 12, padding: 14 }}>
              {view.totals.map((total) => <div key={total.currency} className="admin-section">
                <h3>{total.currency} · {fa ? "ردیف" : "lines"} {total.lineCount}</h3>
                <p dir="ltr">{fa ? "بدهکار" : "Debit"}: {amount(total.debits)}</p>
                <p dir="ltr">{fa ? "بستانکار" : "Credit"}: {amount(total.credits)}</p>
              </div>)}
            </div>}
          {view.accountId ? <p className="admin-hint" style={{ padding: "0 14px 14px" }}>
            {fa ? "مجموع یک حساب ممکن است برابر نباشد؛ هر ژورنال کامل باید برابر باشد." : "A single account’s debit and credit totals may differ; each complete journal must balance."}
          </p> : null}
        </section>

        <section aria-label={fa ? "ردیف‌های ژورنال" : "Posted journal lines"}>
          <div className="module-card-heading"><div><p>{fa ? "ژورنال‌های ثبت‌شده" : "POSTED JOURNALS"}</p>
            <h2>{fa ? "ردیف‌های دفتر کل" : "General Ledger lines"}</h2></div>
            <span>{fa ? `حداکثر ${view.pageLimit} ردیف جدید` : `Newest ${view.pageLimit} lines at most`}</span></div>
          {view.lines.length === 0 ? <p className="treasury-placeholder">{fa ? "هیچ ردیف ثبت‌شده‌ای با این فیلتر پیدا نشد." : "No posted lines match these filters."}</p> : null}
          <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 10 }}>
            {view.lines.map((line) => <LedgerLine key={`${line.journalId}-${line.lineNumber}`} line={line} fa={fa} dual={dual} />)}
          </ol>
          {view.hasMore ? <p className="admin-hint" role="note">
            {fa ? `فهرست به ${view.returnedLineCount} ردیف تازه محدود است؛ مجموع‌ها همه ردیف‌های مطابق فیلتر را پوشش می‌دهند. بازهٔ تاریخ یا حساب را محدود کنید.` : `Showing only the newest ${view.returnedLineCount} lines. Totals include every matching line. Narrow the dates or account to inspect older lines.`}
          </p> : null}
        </section>
        <p className="admin-hint"><Link href="/finance/handoffs">{fa ? "بازکردن صندوق مالی و ردگیری منبع" : "Open Finance inbox for source trace"}</Link></p>
      </> : null}
    </div>
  );
}

function LedgerLine({ line, fa, dual }: { readonly line: GeneralLedgerLine; readonly fa: boolean; readonly dual: (iso: string) => string }) {
  return <li className="module-content-card">
    <div className="module-card-heading"><div><p>{line.journalReference} · #{line.lineNumber}</p><h2>{line.accountCode} · {line.accountName}</h2></div>
      <span>{dual(line.accountingEffectiveDate)}</span></div>
    <dl style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 165px), 1fr))", gap: 10, padding: 14, margin: 0 }}>
      <div><dt className="admin-hint">{fa ? "بدهکار" : "Debit"}</dt><dd dir="ltr" style={{ margin: 0 }}>{line.baseCurrency} {amount(line.baseDebit)}</dd></div>
      <div><dt className="admin-hint">{fa ? "بستانکار" : "Credit"}</dt><dd dir="ltr" style={{ margin: 0 }}>{line.baseCurrency} {amount(line.baseCredit)}</dd></div>
      <div><dt className="admin-hint">{fa ? "مبلغ اصلی" : "Original amount"}</dt><dd dir="ltr" style={{ margin: 0 }}>{line.originalCurrency && line.originalAmount ? `${line.originalCurrency} ${amount(line.originalAmount)}` : "—"}</dd></div>
      <div><dt className="admin-hint">{fa ? "منبع" : "Source"}</dt><dd style={{ margin: 0, overflowWrap: "anywhere" }}>{line.sourceType} · {line.sourceId}</dd></div>
      <div><dt className="admin-hint">{fa ? "شناسه ژورنال" : "Journal ID"}</dt><dd style={{ margin: 0, overflowWrap: "anywhere" }}>{line.journalId}</dd></div>
    </dl>
  </li>;
}
