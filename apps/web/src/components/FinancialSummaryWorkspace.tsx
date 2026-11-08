"use client";

import type { ManagementSummaryView, SummaryFigures } from "@abos/contracts";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { AccessGate, api, errorText } from "@/components/AdminUsersWorkspace";
import { AppIcon } from "@/components/AppIcon";
import { useLocale } from "@/components/LocaleProvider";
import { money } from "@/components/OperationalFinanceShared";
import { ReportPrintHeader } from "@/components/ReportPrintHeader";
import { defaultReportSearch, ReportFilters, YearStatus } from "@/components/ReportFilters";
import { StageZeroPageHeader } from "@/components/StageZeroWorkspace";
import { rangeLabel, rangeQuery } from "@/components/TrialBalanceWorkspace";

const isZero = (value: string) => Number(value) === 0;

function Row({ label, value, currency, strong = false }: Readonly<{ label: string; value: string; currency: string; strong?: boolean }>) {
  return <tr className={strong ? "summary-total" : undefined}><th scope="row">{label}</th><td dir="ltr" className="amount">{money(value, currency)}</td></tr>;
}

/** One currency's movement: the same table for the accounting currency and for each native currency. */
function Movement({ figures, currency, fa }: Readonly<{ figures: SummaryFigures; currency: string; fa: boolean }>) {
  return (
    <div className="table-scroll"><table className="rates-table summary-table"><tbody>
      <Row label={fa ? "موجودی ابتدای دوره" : "Opening Treasury position"} value={figures.opening} currency={currency} strong />
      <Row label={fa ? "سرمایهٔ سهامداران" : "Shareholder capital received"} value={figures.capitalReceived} currency={currency} />
      <Row label={fa ? "قرض‌های دریافتی" : "Loans received"} value={figures.loansReceived} currency={currency} />
      <Row label={fa ? "سایر دریافت‌ها" : "Other money received"} value={figures.otherReceipts} currency={currency} />
      <Row label={fa ? "مجموع پول دریافت‌شده" : "Total money received"} value={figures.moneyReceived} currency={currency} strong />
      <Row label={fa ? "مصارف" : "Expenses paid"} value={figures.expensesPaid} currency={currency} />
      <Row label={fa ? "پرداخت‌ها" : "Supplier and other payments"} value={figures.paymentsMade} currency={currency} />
      <Row label={fa ? "بازپرداخت قرض‌ها" : "Loan repayments"} value={figures.loanRepayments} currency={currency} />
      <Row label={fa ? "مجموع پول پرداخت‌شده" : "Total money paid"} value={figures.moneyPaid} currency={currency} strong />
      {!isZero(figures.openingBalancesRecorded) ? <Row label={fa ? "موجودی‌های افتتاحیهٔ ثبت‌شده" : "Opening balances recorded"} value={figures.openingBalancesRecorded} currency={currency} /> : null}
      <Row label={fa ? "موجودی پایان دوره" : "Closing Treasury position"} value={figures.closing} currency={currency} strong />
    </tbody></table></div>
  );
}

export function FinancialSummaryWorkspace() {
  const { locale } = useLocale();
  const fa = locale === "fa";
  const search = useSearchParams().toString();
  const [view, setView] = useState<ManagementSummaryView | null>(null);
  const [gate, setGate] = useState<"signed-out" | "denied" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    void api<ManagementSummaryView>(`/api/v1/finance/financial-summary?${defaultReportSearch(search)}`).then((result) => {
      if (!current) return;
      if (result.ok) { setView(result.data); setError(null); return; }
      setGate(result.status === 401 ? "signed-out" : result.status === 403 ? "denied" : null);
      if (result.status !== 401 && result.status !== 403) setError(fa ? errorText(result.error, "fa") : result.error.message || errorText(result.error, "en"));
    });
    return () => { current = false; };
  }, [fa, search]);

  if (gate) {
    return <div className="module-workspace"><AccessGate state={gate} fa={fa} what={{
      en: "The Financial summary needs permission to read Finance reports.", fa: "خلاصهٔ مالی به صلاحیت خواندن گزارش‌های مالی نیاز دارد."
    }} /></div>;
  }

  const base = view?.baseCurrency ?? "";
  const others = view ? Object.entries(view.currencies).filter(([currency]) => currency !== base) : [];
  const profit = view?.profit;
  return (
    <div className="module-workspace financial-summary-workspace">
      <StageZeroPageHeader icon="reports-analytics" eyebrow={{ en: "Finance · Reports", fa: "مالی · گزارش‌ها" }}
        title={{ en: "Financial summary", fa: "خلاصهٔ مالی" }}
        description={{ en: "Where the company's money came from and went, and the result of the period. Transfers between the company's own accounts are shown apart and never count as money received or paid.",
          fa: "پول شرکت از کجا آمد و به کجا رفت، و نتیجهٔ دوره. انتقال میان حساب‌های خود شرکت جدا نشان داده می‌شود و پول دریافتی یا پرداختی شمرده نمی‌شود." }} />
      <ReportFilters path="/finance/financial-summary" fa={fa} years={view?.range.fiscalYears ?? []} canPrint={view !== null} />
      {view ? <ReportPrintHeader fa={fa} title={{ en: "Financial summary", fa: "خلاصهٔ مالی" }} period={rangeLabel(view.range, fa)} currency={base || null} /> : null}
      {error ? <div className="treasury-message error" role="alert"><AppIcon name="alert" size={16} /><span>{error}</span></div> : null}
      {view === null && !error ? <p className="treasury-placeholder">{fa ? "در حال بارگذاری…" : "Loading…"}</p> : null}
      {view && view.base && profit ? <>
        <section className="module-content-card" aria-label={fa ? "نقدینگی" : "Treasury"}>
          <h2>{rangeLabel(view.range, fa)}</h2>
          <p><YearStatus range={view.range} fa={fa} /></p>
          <Movement figures={view.base} currency={base} fa={fa} />
          <p className={view.reconciliation.matches ? "treasury-message success" : "treasury-message error"} role="status">
            {view.reconciliation.matches ? (fa ? "موجودی پایان دوره با حساب‌های خزانه و دفتر کل مطابقت دارد." : "The closing position agrees with the Treasury accounts and the General Ledger.")
              : (fa ? "موجودی پایان دوره با دفتر کل مطابقت ندارد." : "The closing position does not agree with the General Ledger.")}</p>
        </section>

        <section className="module-content-card" aria-label={fa ? "انتقال و برگشت" : "Transfers and reversals"}>
          <h2>{fa ? "انتقال و برگشت" : "Transfers and reversals"}</h2>
          <dl className="safe-figures">
            <div><dt>{fa ? "انتقال میان حساب‌های شرکت" : "Moved between the company's own accounts"}</dt><dd dir="ltr">{money(view.base.transfersOut, base)}</dd></div>
            <div><dt>{fa ? "برگشت‌ها" : "Reversals"}</dt><dd dir="ltr">{view.base.reversalCount}</dd></div>
            <div><dt>{fa ? "برگشت به خزانه" : "Reversed back in"}</dt><dd dir="ltr">{money(view.base.reversalsIn, base)}</dd></div>
            <div><dt>{fa ? "برگشت از خزانه" : "Reversed back out"}</dt><dd dir="ltr">{money(view.base.reversalsOut, base)}</dd></div>
          </dl>
          <p className="admin-hint">{fa ? "ارقام بالا خالص برگشت‌ها هستند؛ این بخش فقط فعالیت را نشان می‌دهد." : "The figures above are already net of reversals; this only shows the activity."}</p>
        </section>

        <section className="module-content-card" aria-label={fa ? "نتیجهٔ دوره" : "Result"}>
          <h2>{fa ? "نتیجهٔ دوره" : "Result of the period"}</h2>
          <dl className="safe-figures">
            <div><dt>{fa ? "عاید" : "Income"}</dt><dd dir="ltr">{money(profit.income, base)}</dd></div>
            <div><dt>{fa ? "مصارف" : "Expenses"}</dt><dd dir="ltr">{money(profit.expenses, base)}</dd></div>
            {Number(profit.realizedFxGain) !== 0 ? <div><dt>{fa ? "مفاد تحقق‌یافتهٔ تبادله اسعار" : "Realized FX gain"}</dt><dd dir="ltr">{money(profit.realizedFxGain, base)}</dd></div> : null}
            {Number(profit.realizedFxLoss) !== 0 ? <div><dt>{fa ? "ضرر تحقق‌یافتهٔ تبادله اسعار" : "Realized FX loss"}</dt><dd dir="ltr">{money(profit.realizedFxLoss, base)}</dd></div> : null}
            <div><dt>{profit.netResult.startsWith("-") ? (fa ? "زیان خالص" : "Net loss") : (fa ? "مفاد خالص" : "Net profit")}</dt><dd dir="ltr"><strong>{money(profit.netResult, base)}</strong></dd></div>
          </dl>
          <p><Link href={`/finance/income-statement?${rangeQuery(view.range)}`}>{fa ? "صورت عاید و مصرف" : "Income statement"}</Link></p>
          <p className="admin-hint">{fa ? "از حساب‌های دفتر کل، به نرخ ثبت هر معامله. مصارف با پول خارج‌شده از خزانه یکی نیست؛ مثلاً مصرفی که قرض‌دهنده پرداخته در اینجا هست." : "From the ledger accounts, at each transaction's posted rate. Expenses here can differ from money paid: an expense paid by a lender is here but never left Treasury."}</p>
        </section>

        <section className="module-content-card" aria-label={fa ? "حساب‌های خزانه" : "Treasury accounts"}>
          <h2>{fa ? "حساب‌های خزانه" : "Treasury accounts"}</h2>
          {view.accounts.length === 0 ? <p>{fa ? "هنوز حسابی نیست." : "No accounts yet."}</p> : (
            <div className="table-scroll"><table className="rates-table">
              <thead><tr><th>{fa ? "حساب" : "Account"}</th><th>{fa ? "موجودی ابتدا" : "Opening"}</th><th>{fa ? "موجودی پایان" : "Closing"}</th><th>{fa ? `ارزش حسابداری (${base})` : `Accounting value (${base})`}</th></tr></thead>
              <tbody>{view.accounts.map((account) => <tr key={account.id}>
                <td data-label={fa ? "حساب" : "Account"}><Link href={`/finance/safe-statement?accountId=${account.id}&${defaultReportSearch(search)}`}>{fa && account.nameFa ? account.nameFa : account.nameEn}</Link></td>
                <td data-label={fa ? "موجودی ابتدا" : "Opening"} dir="ltr" className="amount">{money(account.opening, account.currency)}</td>
                <td data-label={fa ? "موجودی پایان" : "Closing"} dir="ltr" className="amount">{money(account.closing, account.currency)}</td>
                <td data-label={fa ? "ارزش حسابداری" : "Accounting value"} dir="ltr" className="amount">{money(account.baseClosing, base)}</td></tr>)}</tbody>
            </table></div>
          )}
        </section>

        {others.map(([currency, figures]) => (
          <section key={currency} className="module-content-card" aria-label={currency}>
            <h2 dir="ltr">{currency}</h2>
            <p className="admin-hint">{fa ? `همین ارقام به ${currency}، پول واقعی این واحد پول.` : `The same figures in ${currency}, the actual money in this currency.`}</p>
            <Movement figures={figures} currency={currency} fa={fa} />
          </section>))}
      </> : null}
    </div>
  );
}
