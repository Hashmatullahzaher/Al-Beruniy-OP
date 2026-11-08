"use client";

import type { ShareholderStatementView, ShareholderTransaction } from "@abos/contracts";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { dualDate, SourceCell } from "@/components/AccountStatementWorkspace";
import { AccessGate, api, errorText } from "@/components/AdminUsersWorkspace";
import { AppIcon } from "@/components/AppIcon";
import { useLocale } from "@/components/LocaleProvider";
import { money } from "@/components/OperationalFinanceShared";
import { ReportPrintHeader } from "@/components/ReportPrintHeader";
import { defaultReportSearch, ReportFilters } from "@/components/ReportFilters";
import { StageZeroPageHeader } from "@/components/StageZeroWorkspace";
import { rangeLabel } from "@/components/TrialBalanceWorkspace";

const PATH = "/finance/shareholder-statement";

const KIND_COPY: Readonly<Record<ShareholderTransaction["kind"], { readonly en: string; readonly fa: string }>> = {
  CAPITAL_RECEIVED: { en: "Capital received", fa: "سرمایهٔ دریافت‌شده" }, CAPITAL_REVERSAL: { en: "Capital reversed", fa: "برگشت سرمایه" },
  LOAN_RECEIVED: { en: "Loan received", fa: "قرض دریافت‌شده" }, LOAN_REPAID: { en: "Loan repaid", fa: "قرض بازپرداخت‌شده" }, LOAN_REVERSAL: { en: "Loan reversed", fa: "برگشت قرض" }
};

function Transactions({ lines, fa, title, query }: Readonly<{ lines: readonly ShareholderTransaction[]; fa: boolean; title: string; query: string }>) {
  if (lines.length === 0) return <p>{fa ? "در این بازه معامله‌ای نیست." : "No transactions in this range."}</p>;
  return (
    <div className="table-scroll"><table className="rates-table" aria-label={title}>
      <thead><tr><th>{fa ? "تاریخ" : "Date"}</th><th>{fa ? "نوع" : "Type"}</th><th>{fa ? "مرجع" : "Reference"}</th><th>{fa ? "شرح" : "Details"}</th><th>{fa ? "صندوق" : "Safe"}</th>
        <th>{fa ? "مبلغ" : "Amount"}</th><th>{fa ? "موجودی" : "Balance"}</th></tr></thead>
      <tbody>{lines.map((line) => <tr key={line.id} className={line.restricted ? "restricted" : undefined}>
        <td data-label={fa ? "تاریخ" : "Date"}>{dualDate(line.date, fa)}</td>
        <td data-label={fa ? "نوع" : "Type"}>{KIND_COPY[line.kind][fa ? "fa" : "en"]}{line.reversedBy ? <small className="admin-hint"> {fa ? "برگشت شد" : "reversed"}</small> : null}</td>
        <td data-label={fa ? "مرجع" : "Reference"} dir="ltr">{line.restricted ? <span className="admin-hint">{fa ? "حرکت محدود" : "Restricted movement"}</span>
          : line.journalId ? <Link href={`/finance/general-ledger?journalId=${line.journalId}`}>{line.journalReference}</Link> : line.journalReference}</td>
        <td data-label={fa ? "شرح" : "Details"}><SourceCell source={line.source} fa={fa} />
          {line.source?.reference ? <small className="admin-hint"> · <span dir="ltr">{line.source.reference}</span></small> : null}
          {line.source?.description ? <small className="admin-hint"> · {line.source.description}</small> : null}</td>
        <td data-label={fa ? "صندوق" : "Safe"}>{line.safe ? <Link href={`/finance/safe-statement?accountId=${line.safe.id}&${query}`}>{fa && line.safe.nameFa ? line.safe.nameFa : line.safe.nameEn}</Link> : "—"}</td>
        <td data-label={fa ? "مبلغ" : "Amount"} dir="ltr" className="amount">{money(line.amount, line.currency)}</td>
        <td data-label={fa ? "موجودی" : "Balance"} dir="ltr" className="amount">{money(line.balance, line.currency)}</td></tr>)}</tbody>
    </table></div>
  );
}

export function ShareholderStatementWorkspace() {
  const { locale } = useLocale();
  const fa = locale === "fa";
  const params = useSearchParams();
  const router = useRouter();
  const search = params.toString();
  const partyId = params.get("partyId") ?? "";
  const [view, setView] = useState<ShareholderStatementView | null>(null);
  const [gate, setGate] = useState<"signed-out" | "denied" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    void api<ShareholderStatementView>(`/api/v1/finance/shareholder-statement?${defaultReportSearch(search)}`).then((result) => {
      if (!current) return;
      if (result.ok) { setView(result.data); setError(null); return; }
      setGate(result.status === 401 ? "signed-out" : result.status === 403 ? "denied" : null);
      if (result.status !== 401 && result.status !== 403) setError(fa ? errorText(result.error, "fa") : result.error.message || errorText(result.error, "en"));
    });
    return () => { current = false; };
  }, [fa, search]);

  if (gate) {
    return <div className="module-workspace"><AccessGate state={gate} fa={fa} what={{
      en: "Shareholder statements need permission to read shareholders, loans or Finance reports.", fa: "صورت‌حساب سهامدار به صلاحیت خواندن سهامداران، قرض‌ها یا گزارش‌های مالی نیاز دارد."
    }} /></div>;
  }

  const choose = (id: string) => {
    const query = new URLSearchParams(search);
    if (id) query.set("partyId", id); else query.delete("partyId");
    router.push(`${PATH}?${query}`);
  };
  const statement = view?.statement ?? null;
  const base = view?.baseCurrency ?? "";
  const reportQuery = (() => { const query = new URLSearchParams(defaultReportSearch(search)); query.delete("partyId"); return query.toString(); })();
  const capitalLines = statement?.transactions.filter((t) => t.section === "CAPITAL") ?? [];
  const loanLines = statement?.transactions.filter((t) => t.section === "LOAN") ?? [];
  return (
    <div className="module-workspace shareholder-statement-workspace">
      <StageZeroPageHeader icon="reports-analytics" eyebrow={{ en: "Finance · Reports", fa: "مالی · گزارش‌ها" }}
        title={{ en: statement?.party.name ?? "Shareholder statement", fa: statement?.party.name ?? "صورت‌حساب سهامدار" }}
        description={{ en: "What a shareholder has put in as capital and, separately, what the company owes them as a loan. Capital is equity and a loan is debt: they are never added together.",
          fa: "آنچه سهامدار به‌عنوان سرمایه گذاشته و، جداگانه، آنچه شرکت به‌عنوان قرض به او بدهکار است. سرمایه ملکیت است و قرض بدهی؛ هرگز با هم جمع نمی‌شوند." }} />
      <ReportFilters path={PATH} fa={fa} years={view?.range.fiscalYears ?? []} canPrint={view !== null} keep={["partyId"]}>
        {view && view.people.length > 0 ? <label><span>{fa ? "شخص" : "Person"}</span>
          <select value={partyId} onChange={(event) => choose(event.target.value)}>
            <option value="">{fa ? "همه (مجموع شرکت)" : "All (company totals)"}</option>
            {view.people.map((person) => <option key={person.partyId} value={person.partyId}>{person.name}</option>)}
          </select></label> : null}
      </ReportFilters>
      {view ? <ReportPrintHeader fa={fa} title={{ en: "Shareholder statement", fa: "صورت‌حساب سهامدار" }} period={rangeLabel(view.range, fa)} currency={base || null} /> : null}
      {error ? <div className="treasury-message error" role="alert"><AppIcon name="alert" size={16} /><span>{error}</span></div> : null}
      {view === null && !error ? <p className="treasury-placeholder">{fa ? "در حال بارگذاری…" : "Loading…"}</p> : null}

      {view && statement === null ? (
        <section className="module-content-card" aria-label={fa ? "مجموع شرکت" : "Company totals"}>
          <h2>{rangeLabel(view.range, fa)}</h2>
          <dl className="safe-figures">
            {view.totals.capital ? (view.totals.capital.length === 0 ? <div><dt>{fa ? "سرمایهٔ مؤثر" : "Effective capital"}</dt><dd dir="ltr">{money("0", base)}</dd></div>
              : view.totals.capital.map((t) => <div key={t.currency}><dt>{fa ? "سرمایهٔ مؤثر" : "Effective capital"}</dt><dd dir="ltr">{money(t.effective, t.currency)}</dd></div>)) : null}
            {view.totals.loans ? (view.totals.loans.length === 0 ? <div><dt>{fa ? "قرض باقی‌مانده" : "Loans outstanding"}</dt><dd dir="ltr">{money("0", base)}</dd></div>
              : view.totals.loans.map((t) => <div key={t.currency}><dt>{fa ? "قرض باقی‌مانده" : "Loans outstanding"}</dt><dd dir="ltr">{money(t.outstanding, t.currency)}</dd></div>)) : null}
          </dl>
          {[view.reconciliation.capital, view.reconciliation.loans].every((r) => r === null || r.matches)
            ? <p className="treasury-message success" role="status">{fa ? "با دفتر کل مطابقت دارد." : "Agrees with the General Ledger."}</p>
            : <p className="treasury-message error" role="status">{fa ? "با دفتر کل مطابقت ندارد." : "Does not agree with the General Ledger."}</p>}
          {view.people.length > 0 ? (
            <div className="table-scroll"><table className="rates-table">
              <thead><tr><th>{fa ? "شخص" : "Person"}</th>{view.canReadCapital ? <th>{fa ? "سرمایهٔ مؤثر" : "Effective capital"}</th> : null}{view.canReadLoans ? <th>{fa ? "قرض باقی‌مانده" : "Loan outstanding"}</th> : null}</tr></thead>
              <tbody>{view.people.map((person) => <tr key={person.partyId}>
                <td data-label={fa ? "شخص" : "Person"}><button type="button" className="link-button" onClick={() => choose(person.partyId)}>{person.name}</button></td>
                {view.canReadCapital ? <td data-label={fa ? "سرمایه" : "Capital"} dir="ltr" className="amount">{(person.capital ?? []).map((c) => money(c.effective, c.currency)).join(" · ") || "—"}</td> : null}
                {view.canReadLoans ? <td data-label={fa ? "قرض" : "Loan"} dir="ltr" className="amount">{(person.loans ?? []).map((l) => money(l.outstanding, l.currency)).join(" · ") || "—"}</td> : null}
              </tr>)}</tbody>
            </table></div>
          ) : <p className="admin-hint" role="note">{fa ? "نام افراد به صلاحیت خواندن سهامداران یا قرض‌ها نیاز دارد." : "Reading individual people needs permission to read shareholders or loans."}</p>}
        </section>
      ) : null}

      {view && statement ? <>
        {statement.capital !== null ? (
          <section className="module-content-card" aria-label={fa ? "سرمایه (ملکیت)" : "Capital (equity)"}>
            <h2>{fa ? "سرمایه (ملکیت)" : "Capital (equity)"}</h2>
            <p className="admin-hint">{rangeLabel(view.range, fa)}</p>
            {statement.capital.length === 0 ? <p>{fa ? "سرمایه‌ای ثبت نشده است." : "No capital recorded."}</p> : statement.capital.map((c) => (
              <dl className="safe-figures" key={c.currency}>
                {c.agreed !== null ? <div><dt>{fa ? "سرمایهٔ توافق‌شده" : "Agreed capital"}</dt><dd dir="ltr">{money(c.agreed, c.currency)}</dd></div> : null}
                <div><dt>{fa ? "دریافت‌شده" : "Received"}</dt><dd dir="ltr">{money(c.received, c.currency)}</dd></div>
                <div><dt>{fa ? "برگشت‌شده" : "Reversed"}</dt><dd dir="ltr">{money(c.reversed, c.currency)}</dd></div>
                <div><dt>{fa ? "سرمایهٔ مؤثر" : "Effective capital"}</dt><dd dir="ltr"><strong>{money(c.effective, c.currency)}</strong></dd></div>
                {c.outstanding !== null ? <div><dt>{fa ? "باقی‌مانده از توافق" : "Outstanding against agreed"}</dt><dd dir="ltr">{money(c.outstanding, c.currency)}</dd></div> : null}
              </dl>))}
            {statement.capital.some((c) => c.agreed !== null) ? <p className="admin-hint">{fa ? "رقم توافق فقط برای اطلاع است؛ سرمایهٔ مؤثر از ثبت‌های دفتر می‌آید." : "The agreed figure is for information; effective capital comes from what was posted."}</p> : null}
            <Transactions lines={capitalLines} fa={fa} title={fa ? "معاملات سرمایه" : "Capital transactions"} query={reportQuery} />
          </section>) : null}
        {statement.loans !== null ? (
          <section className="module-content-card" aria-label={fa ? "قرض (بدهی)" : "Loans (debt)"}>
            <h2>{fa ? "قرض (بدهی)" : "Loans (debt)"}</h2>
            {statement.loans.length === 0 ? <p>{fa ? "قرضی ثبت نشده است." : "No loans recorded."}</p> : statement.loans.map((l) => (
              <dl className="safe-figures" key={l.currency}>
                <div><dt>{fa ? "دریافت‌شده" : "Received"}</dt><dd dir="ltr">{money(l.received, l.currency)}</dd></div>
                <div><dt>{fa ? "بازپرداخت‌شده" : "Repaid"}</dt><dd dir="ltr">{money(l.repaid, l.currency)}</dd></div>
                <div><dt>{fa ? "باقی‌مانده" : "Outstanding"}</dt><dd dir="ltr"><strong>{money(l.outstanding, l.currency)}</strong></dd></div>
              </dl>))}
            <Transactions lines={loanLines} fa={fa} title={fa ? "معاملات قرض" : "Loan transactions"} query={reportQuery} />
          </section>) : null}
      </> : null}
    </div>
  );
}
