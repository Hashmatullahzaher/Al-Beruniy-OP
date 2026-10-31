"use client";

import type { AccountStatementView, JournalDetailView, ReportSource } from "@abos/contracts";
import { formatDual } from "@abos/calendar";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { AccessGate, api, errorText } from "@/components/AdminUsersWorkspace";
import { AppIcon } from "@/components/AppIcon";
import { useLocale } from "@/components/LocaleProvider";
import { StageZeroPageHeader } from "@/components/StageZeroWorkspace";
import { rangeLabel, reportAmount } from "@/components/TrialBalanceWorkspace";

export function dualDate(iso: string, fa: boolean): string {
  const d = formatDual(iso, fa ? "fa" : "en");
  return `${d.gregorian} · ${d.solarHijri}`;
}

/** The business source of a movement: its label, counterparty and screen, or the generic restricted text. */
export function SourceCell({ source, fa }: Readonly<{ source: ReportSource | null; fa: boolean }>) {
  if (source === null) return <span>—</span>;
  const label = fa ? source.label.fa : source.label.en;
  return <span>{source.route ? <Link href={source.route}>{label}</Link> : label}
    {source.counterparty ? <> · {source.counterparty}</> : null}
    {source.detailRestricted ? <small className="admin-hint"> {fa ? "(جزئیات محدود)" : "(details restricted)"}</small> : null}</span>;
}

export function AccountStatementWorkspace() {
  const { locale } = useLocale();
  const fa = locale === "fa";
  const [view, setView] = useState<AccountStatementView | null>(null);
  const [gate, setGate] = useState<"signed-out" | "denied" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const params = useSearchParams();
  const search = params.toString();
  const missing = !params.get("accountId");

  useEffect(() => {
    const query = new URLSearchParams(search);
    if (!query.get("accountId")) return;
    if (!query.get("periodId") && !query.get("from") && !query.get("asOf")) query.set("asOf", new Date().toISOString().slice(0, 10));
    let current = true;
    void api<AccountStatementView>(`/api/v1/finance/account-statement?${query}`).then((result) => {
      if (!current) return;
      if (result.ok) { setView(result.data); return; }
      setGate(result.status === 401 ? "signed-out" : result.status === 403 ? "denied" : null);
      if (result.status !== 401 && result.status !== 403) setError(fa ? errorText(result.error, "fa") : result.error.message || errorText(result.error, "en"));
    });
    return () => { current = false; };
  }, [fa, search]);

  if (gate) {
    return <div className="module-workspace"><AccessGate state={gate} fa={fa} what={{
      en: "Account statements need permission to read Finance reports.", fa: "صورت‌حساب به صلاحیت خواندن گزارش‌های مالی نیاز دارد."
    }} /></div>;
  }
  const title = view ? `${view.account.code} · ${view.account.name}` : (fa ? "صورت‌حساب" : "Account statement");
  return (
    <div className="module-workspace account-statement-workspace">
      <StageZeroPageHeader icon="reports-analytics" eyebrow={{ en: "Finance · Accounting", fa: "مالی · حسابداری" }}
        title={{ en: title, fa: title }}
        description={{ en: "Every posted movement of one account, with its running balance, from the opening to the closing position.",
          fa: "همه حرکات ثبت‌شدهٔ یک حساب با موجودی جاری، از موجودی افتتاحیه تا پایانی." }} />
      {missing ? <p className="admin-hint" role="note">{fa ? "حساب را از " : "Choose an account from the "}
        <Link href="/finance/trial-balance">{fa ? "بیلانس آزمایشی" : "Trial balance"}</Link>{fa ? " انتخاب کنید." : "."}</p> : null}
      {error ? <div className="treasury-message error" role="alert"><AppIcon name="alert" size={16} /><span>{error}</span></div> : null}
      {view ? (
        <section className="module-content-card" aria-label={fa ? "صورت‌حساب" : "Account statement"}>
          <h2>{rangeLabel(view.range, fa)}</h2>
          <dl className="safe-figures">
            <div><dt>{fa ? "افتتاحیه" : "Opening"}</dt><dd dir="ltr">{reportAmount(view.opening.debit)} Dr · {reportAmount(view.opening.credit)} Cr</dd></div>
            <div><dt>{fa ? "بدهکار دوره" : "Period debits"}</dt><dd dir="ltr">{reportAmount(view.periodDebit)}</dd></div>
            <div><dt>{fa ? "بستانکار دوره" : "Period credits"}</dt><dd dir="ltr">{reportAmount(view.periodCredit)}</dd></div>
            <div><dt>{fa ? "پایانی" : "Closing"}</dt><dd dir="ltr">{reportAmount(view.closing.debit)} Dr · {reportAmount(view.closing.credit)} Cr</dd></div>
          </dl>
          {view.lines.length === 0 ? <p>{fa ? "در این بازه حرکتی نیست." : "No movement in this range."}</p> : (
            <div className="table-scroll"><table className="rates-table account-statement">
              <thead><tr><th>{fa ? "تاریخ" : "Date"}</th><th>{fa ? "مرجع" : "Reference"}</th><th>{fa ? "منبع" : "Source"}</th>
                <th>{fa ? "بدهکار" : "Debit"}</th><th>{fa ? "بستانکار" : "Credit"}</th><th>{fa ? "موجودی" : "Balance"}</th><th>{fa ? "مبلغ اصلی" : "Native"}</th></tr></thead>
              <tbody>{view.lines.map((line) => (
                <tr key={`${line.journalId}-${line.lineNumber}`} className={line.restricted ? "restricted" : undefined}>
                  <td>{dualDate(line.date, fa)}</td>
                  <td dir="ltr">{line.restricted ? <span className="admin-hint">{fa ? "حرکت محدود" : "Restricted movement"}</span>
                    : <Link href={`/finance/general-ledger?journalId=${line.journalId}`}>{line.journalReference}</Link>}
                    {line.reversedBy ? <small className="admin-hint"> {fa ? "برگشت شد" : "reversed"}</small> : null}
                    {line.reverses ? <small className="admin-hint"> {fa ? "برگشتِ" : "reverses"} {line.reverses.reference}</small> : null}</td>
                  <td><SourceCell source={line.source} fa={fa} /></td>
                  <td dir="ltr" className="amount">{reportAmount(line.debit)}</td>
                  <td dir="ltr" className="amount">{reportAmount(line.credit)}</td>
                  <td dir="ltr" className="amount">{reportAmount(line.balance)}</td>
                  <td dir="ltr"><small>{line.originalCurrency} {reportAmount(line.originalAmount)}{line.rate
                    ? ` @ 1 ${line.rate.unitCurrency} = ${line.rate.rate} ${line.rate.quoteCurrency}` : ""}</small></td>
                </tr>))}</tbody>
            </table></div>
          )}
        </section>
      ) : null}
    </div>
  );
}

/** One journal, opened from a statement or the General Ledger (?journalId=). */
export function JournalDetailPanel({ journalId, fa }: Readonly<{ journalId: string; fa: boolean }>) {
  const [view, setView] = useState<JournalDetailView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    void api<JournalDetailView>(`/api/v1/finance/journals/${encodeURIComponent(journalId)}`).then((result) => {
      if (!current) return;
      if (result.ok) setView(result.data); else setError(fa ? errorText(result.error, "fa") : result.error.message || errorText(result.error, "en"));
    });
    return () => { current = false; };
  }, [journalId, fa]);
  if (error) return <div className="treasury-message error" role="alert"><AppIcon name="alert" size={16} /><span>{error}</span></div>;
  if (view === null) return <p className="treasury-placeholder">{fa ? "در حال بارگذاری…" : "Loading…"}</p>;
  return (
    <section className="module-content-card journal-detail" aria-label={fa ? "سند ژورنال" : "Journal"}>
      <h2 dir="ltr">{view.restricted ? (fa ? "حرکت محدود" : "Restricted movement") : view.reference}</h2>
      <p>{dualDate(view.date, fa)} · <SourceCell source={view.source} fa={fa} />{view.postedBy ? <> · {fa ? "ثبت توسط" : "posted by"} {view.postedBy}</> : null}</p>
      {view.reversedBy ? <p className="admin-hint">{fa ? "برگشت شد با " : "Reversed by "}
        <Link href={`/finance/general-ledger?journalId=${view.reversedBy.journalId}`} dir="ltr">{view.reversedBy.reference ?? view.reversedBy.journalId}</Link>
        {view.reversedBy.reason ? ` · ${view.reversedBy.reason}` : ""}</p> : null}
      {view.reverses ? <p className="admin-hint">{fa ? "برگشتِ " : "Reverses "}
        <Link href={`/finance/general-ledger?journalId=${view.reverses.journalId}`} dir="ltr">{view.reverses.reference ?? view.reverses.journalId}</Link></p> : null}
      <div className="table-scroll"><table className="rates-table">
        <thead><tr><th>#</th><th>{fa ? "حساب" : "Account"}</th><th>{fa ? "بدهکار" : "Debit"}</th><th>{fa ? "بستانکار" : "Credit"}</th><th>{fa ? "مبلغ اصلی" : "Native"}</th></tr></thead>
        <tbody>{view.lines.map((line) => <tr key={line.lineNumber}><td dir="ltr">{line.lineNumber}</td><td>{line.accountCode} · {line.accountName}</td>
          <td dir="ltr" className="amount">{reportAmount(line.debit)}</td><td dir="ltr" className="amount">{reportAmount(line.credit)}</td>
          <td dir="ltr"><small>{line.originalCurrency} {reportAmount(line.originalAmount)}</small></td></tr>)}</tbody>
      </table></div>
      {view.fx ? <p className="admin-hint" dir="auto">{fa ? "نرخ ثابت‌شده: " : "Frozen rate: "}<span dir="ltr">1 {view.fx.unitCurrency} = {view.fx.rate} {view.fx.quoteCurrency}</span>
        {` (${view.fx.rateDate}, ${view.fx.source})`}{view.fx.roundingMode ? ` · ${view.fx.roundingMode} / ${view.fx.baseScale}` : ""}</p> : null}
    </section>
  );
}
