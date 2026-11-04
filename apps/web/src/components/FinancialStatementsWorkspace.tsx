"use client";

import type { BalanceSheetAccount, BalanceSheetView, IncomeStatementAccount, IncomeStatementView } from "@abos/contracts";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { AccessGate, api, errorText } from "@/components/AdminUsersWorkspace";
import { AppIcon } from "@/components/AppIcon";
import { useLocale } from "@/components/LocaleProvider";
import { money } from "@/components/OperationalFinanceShared";
import { defaultReportSearch, ReportFilters, YearStatus } from "@/components/ReportFilters";
import { StageZeroPageHeader } from "@/components/StageZeroWorkspace";
import { rangeLabel, rangeQuery } from "@/components/TrialBalanceWorkspace";

type Copy = { readonly en: string; readonly fa: string };

/** Loads a report for the period in the address; a link or a refresh keeps the view. */
function useReport<T>(endpoint: string) {
  const { locale } = useLocale();
  const fa = locale === "fa";
  const search = useSearchParams().toString();
  const [view, setView] = useState<T | null>(null);
  const [gate, setGate] = useState<"signed-out" | "denied" | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    void api<T>(`${endpoint}?${defaultReportSearch(search)}`).then((result) => {
      if (!current) return;
      if (result.ok) { setView(result.data); setError(null); return; }
      setGate(result.status === 401 ? "signed-out" : result.status === 403 ? "denied" : null);
      if (result.status !== 401 && result.status !== 403) setError(fa ? errorText(result.error, "fa") : result.error.message || errorText(result.error, "en"));
    });
    return () => { current = false; };
  }, [endpoint, fa, search]);
  return { fa, view, gate, error };
}

const REPORT_GATE: Copy = { en: "This statement needs permission to read Finance reports.", fa: "این صورت به صلاحیت خواندن گزارش‌های مالی نیاز دارد." };

function AccountRows({ rows, currency, query, label }: Readonly<{ rows: readonly (IncomeStatementAccount | BalanceSheetAccount)[]; currency: string; query: string; label: string }>) {
  return <>{rows.map((row) => <tr key={row.accountId}>
    <th scope="row"><Link href={`/finance/account-statement?accountId=${row.accountId}&${query}`}><span dir="ltr">{row.code}</span> {row.name}</Link>
      {row.parent ? <small className="admin-hint"> · {row.parent.name}</small> : null}</th>
    <td data-label={label} dir="ltr" className="amount">{money(row.amount, currency)}</td></tr>)}</>;
}

function Total({ label, value, currency }: Readonly<{ label: string; value: string; currency: string }>) {
  return <tr className="summary-total"><th scope="row">{label}</th><td dir="ltr" className="amount">{money(value, currency)}</td></tr>;
}

export function IncomeStatementWorkspace() {
  const { fa, view, gate, error } = useReport<IncomeStatementView>("/api/v1/finance/income-statement");
  if (gate) return <div className="module-workspace"><AccessGate state={gate} fa={fa} what={REPORT_GATE} /></div>;
  const base = view?.baseCurrency ?? "";
  const query = view ? rangeQuery(view.range) : "";
  const amount = fa ? "مبلغ" : "Amount";
  const loss = view?.netResult.startsWith("-") ?? false;
  return (
    <div className="module-workspace income-statement-workspace">
      <StageZeroPageHeader icon="reports-analytics" eyebrow={{ en: "Finance · Reports", fa: "مالی · گزارش‌ها" }}
        title={{ en: "Income statement", fa: "صورت عاید و مصرف" }}
        description={{ en: "Income less expenses, from every posting to an income or expense account, in the accounting currency at each transaction's posted rate.",
          fa: "عاید منهای مصارف، از همهٔ ثبت‌های حساب‌های عاید و مصرف، به واحد پول حسابداری و نرخ ثبت هر معامله." }} />
      <ReportFilters path="/finance/income-statement" fa={fa} years={view?.range.fiscalYears ?? []} canPrint={view !== null} />
      {error ? <div className="treasury-message error" role="alert"><AppIcon name="alert" size={16} /><span>{error}</span></div> : null}
      {view === null && !error ? <p className="treasury-placeholder">{fa ? "در حال بارگذاری…" : "Loading…"}</p> : null}
      {view ? (
        <section className="module-content-card" aria-label={fa ? "صورت عاید و مصرف" : "Income statement"}>
          <h2>{rangeLabel(view.range, fa)}</h2>
          <p><YearStatus range={view.range} fa={fa} /></p>
          <div className="table-scroll"><table className="rates-table summary-table"><tbody>
            <tr><th colSpan={2} scope="colgroup">{fa ? "عاید" : "Income"}</th></tr>
            <AccountRows rows={view.income} currency={base} query={query} label={amount} />
            <Total label={fa ? "مجموع عاید" : "Total income"} value={view.totalIncome} currency={base} />
            <tr><th colSpan={2} scope="colgroup">{fa ? "مصارف" : "Expenses"}</th></tr>
            <AccountRows rows={view.expenses} currency={base} query={query} label={amount} />
            <Total label={fa ? "مجموع مصارف" : "Total expenses"} value={view.totalExpenses} currency={base} />
            <Total label={loss ? (fa ? "زیان خالص" : "Net loss") : (fa ? "مفاد خالص" : "Net profit")} value={view.netResult} currency={base} />
          </tbody></table></div>
          <p className="admin-hint">{fa ? "از آغاز سال مالی تا این تاریخ: " : "Year to date: "}<span dir="ltr">{money(view.yearToDate.netResult, base)}</span></p>
        </section>
      ) : null}
    </div>
  );
}

export function BalanceSheetWorkspace() {
  const { fa, view, gate, error } = useReport<BalanceSheetView>("/api/v1/finance/balance-sheet");
  if (gate) return <div className="module-workspace"><AccessGate state={gate} fa={fa} what={REPORT_GATE} /></div>;
  const base = view?.baseCurrency ?? "";
  const query = view ? `asOf=${view.asOf}` : "";
  const amount = fa ? "مبلغ" : "Amount";
  const rows = (group: BalanceSheetAccount["group"]) => view?.accounts.filter((account) => account.group === group) ?? [];
  const section = (group: BalanceSheetAccount["group"], title: Copy) => rows(group).length === 0 ? null : <>
    <tr><td colSpan={2} className="admin-hint">{title[fa ? "fa" : "en"]}</td></tr>
    <AccountRows rows={rows(group)} currency={base} query={query} label={amount} /></>;
  const negativeTreasury = rows("TREASURY").some((row) => row.amount.startsWith("-"));
  return (
    <div className="module-workspace balance-sheet-workspace">
      <StageZeroPageHeader icon="reports-analytics" eyebrow={{ en: "Finance · Reports", fa: "مالی · گزارش‌ها" }}
        title={{ en: "Balance sheet", fa: "بیلانس" }}
        description={{ en: "What the company owns, what it owes and what belongs to its owners at a date, in the accounting currency at each transaction's posted rate.",
          fa: "آنچه شرکت دارد، آنچه بدهکار است و آنچه از مالکان است در یک تاریخ، به واحد پول حسابداری و نرخ ثبت هر معامله." }} />
      <ReportFilters path="/finance/balance-sheet" fa={fa} years={view?.range.fiscalYears ?? []} canPrint={view !== null} datesOnly />
      {error ? <div className="treasury-message error" role="alert"><AppIcon name="alert" size={16} /><span>{error}</span></div> : null}
      {view === null && !error ? <p className="treasury-placeholder">{fa ? "در حال بارگذاری…" : "Loading…"}</p> : null}
      {view ? (
        <section className="module-content-card" aria-label={fa ? "بیلانس" : "Balance sheet"}>
          <h2>{fa ? "به تاریخ " : "As of "}<span dir="ltr">{view.asOf}</span></h2>
          <p><YearStatus range={view.range} fa={fa} /></p>
          <p className={view.validation.balanced ? "treasury-message success" : "treasury-message error"} role="status">
            {fa ? "دارایی‌ها منهای بدهی‌ها منهای سرمایه = " : "Assets − Liabilities − Equity = "}<span dir="ltr">{view.validation.difference}</span>{" "}
            {view.validation.balanced ? (fa ? "(متوازن)" : "(balanced)") : (fa ? "(متوازن نیست)" : "(not balanced)")}</p>
          <div className="table-scroll"><table className="rates-table summary-table"><tbody>
            <tr><th colSpan={2} scope="colgroup">{fa ? "دارایی‌ها" : "Assets"}</th></tr>
            {section("TREASURY", { en: "Treasury and cash", fa: "خزانه و نقد" })}
            {section("OTHER_ASSETS", { en: "Other assets", fa: "سایر دارایی‌ها" })}
            <Total label={fa ? "مجموع دارایی‌ها" : "Total assets"} value={view.totalAssets} currency={base} />
            <tr><th colSpan={2} scope="colgroup">{fa ? "بدهی‌ها" : "Liabilities"}</th></tr>
            {section("LOANS", { en: "Shareholder and provider loans", fa: "قرض‌های سهامداران و تمویل‌کنندگان" })}
            {section("PAYABLES", { en: "Supplier payables", fa: "پرداختنی‌های تأمین‌کنندگان" })}
            {section("OTHER_LIABILITIES", { en: "Other liabilities", fa: "سایر بدهی‌ها" })}
            <Total label={fa ? "مجموع بدهی‌ها" : "Total liabilities"} value={view.totalLiabilities} currency={base} />
            <tr><th colSpan={2} scope="colgroup">{fa ? "سرمایه" : "Equity"}</th></tr>
            {section("SHAREHOLDER_CAPITAL", { en: "Shareholder capital", fa: "سرمایهٔ سهامداران" })}
            {section("OPENING_BALANCE_EQUITY", { en: "Opening balance equity", fa: "سرمایهٔ موجودی افتتاحیه" })}
            {section("OTHER_EQUITY", { en: "Other equity", fa: "سایر سرمایه" })}
            {Number(view.earlierYearsResult) !== 0 ? <tr><th scope="row">{fa ? "نتیجهٔ سال‌های گذشته" : "Result of earlier years"}</th><td dir="ltr" className="amount">{money(view.earlierYearsResult, base)}</td></tr> : null}
            <tr><th scope="row"><Link href={`/finance/income-statement?from=${view.yearStart}&to=${view.asOf}`}>{fa ? "نتیجهٔ سال جاری" : "Result of the current year"}</Link></th>
              <td dir="ltr" className="amount">{money(view.currentYearResult, base)}</td></tr>
            <Total label={fa ? "مجموع سرمایه" : "Total equity"} value={view.totalEquity} currency={base} />
            <Total label={fa ? "مجموع بدهی‌ها و سرمایه" : "Total liabilities and equity"} value={view.totalLiabilitiesAndEquity} currency={base} />
          </tbody></table></div>
          <p className="admin-hint">{fa ? "نتیجه از حساب‌های عاید و مصرف محاسبه می‌شود؛ هیچ ژورنال بسته‌شدنی ثبت نشده است." : "The result is worked out from the income and expense accounts; no closing journal has been posted."}</p>
          {negativeTreasury ? <p className="admin-hint" role="note">{fa ? "رقم منفی در خزانه یعنی این مقدار به صراف بدهکار هستید." : "A negative Treasury figure is an amount owed to a Saraf."}</p> : null}
          <p className={view.treasury.matches ? "admin-hint" : "treasury-message error"}>{view.treasury.matches ? (fa ? "حساب‌های خزانه با دفتر کل مطابقت دارند." : "The Treasury accounts agree with the General Ledger.") : (fa ? "حساب‌های خزانه با دفتر کل مطابقت ندارند." : "The Treasury accounts do not agree with the General Ledger.")}</p>
        </section>
      ) : null}
    </div>
  );
}
