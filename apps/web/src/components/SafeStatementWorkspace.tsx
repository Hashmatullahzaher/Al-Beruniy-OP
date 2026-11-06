"use client";

import type { TreasuryStatementLine, TreasuryStatementView } from "@abos/contracts";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { dualDate, SourceCell } from "@/components/AccountStatementWorkspace";
import { AccessGate, api, errorText } from "@/components/AdminUsersWorkspace";
import { AppIcon } from "@/components/AppIcon";
import { useLocale } from "@/components/LocaleProvider";
import { kabulToday, money } from "@/components/OperationalFinanceShared";
import { StageZeroPageHeader } from "@/components/StageZeroWorkspace";
import { rangeLabel, reportAmount } from "@/components/TrialBalanceWorkspace";

type Mode = "asOf" | "range";

const ENDPOINT = "/api/v1/finance/safe-statement";

const TYPE_COPY: Readonly<Record<string, { readonly en: string; readonly fa: string }>> = {
  SAFE: { en: "Safe", fa: "صندوق" }, CASH_BOX: { en: "Cash box", fa: "صندوقچه" }, PETTY_CASH: { en: "Petty cash", fa: "تنخواه" },
  BANK: { en: "Bank", fa: "بانک" }, SARAF: { en: "Saraf", fa: "صراف" }, OTHER: { en: "Other", fa: "دیگر" }
};

/** The business wording of one movement: a transfer names the other account, where the reader may know it. */
function Movement({ line, fa }: Readonly<{ line: TreasuryStatementLine; fa: boolean }>) {
  if (line.transferPeer) {
    const peer = fa ? line.transferPeer.fa : line.transferPeer.en;
    const out = line.moneyOut !== "0";
    return <span>{fa ? `انتقال ${out ? "به" : "از"} ${peer}` : `Transfer ${out ? "to" : "from"} ${peer}`}</span>;
  }
  return <SourceCell source={line.source} fa={fa} />;
}

export function SafeStatementWorkspace() {
  const { locale } = useLocale();
  const fa = locale === "fa";
  const params = useSearchParams();
  const router = useRouter();
  const search = params.toString();
  const accountId = params.get("accountId") ?? "";
  const today = kabulToday();
  const [view, setView] = useState<TreasuryStatementView | null>(null);
  const [gate, setGate] = useState<"signed-out" | "denied" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>(params.get("from") ? "range" : "asOf");
  const [asOf, setAsOf] = useState(params.get("asOf") ?? today);
  const [from, setFrom] = useState(params.get("from") ?? `${today.slice(0, 7)}-01`);
  const [to, setTo] = useState(params.get("to") ?? today);

  useEffect(() => {
    const query = new URLSearchParams(search);
    if (query.get("accountId") && !query.get("periodId") && !query.get("from") && !query.get("asOf")) query.set("asOf", kabulToday());
    let current = true;
    void api<TreasuryStatementView>(`${ENDPOINT}?${query}`).then((result) => {
      if (!current) return;
      if (result.ok) { setView(result.data); setError(null); return; }
      setGate(result.status === 401 ? "signed-out" : result.status === 403 ? "denied" : null);
      if (result.status !== 401 && result.status !== 403) setError(fa ? errorText(result.error, "fa") : result.error.message || errorText(result.error, "en"));
    });
    return () => { current = false; };
  }, [fa, search]);

  const open = (nextAccount: string, range: string) => router.push(`/finance/safe-statement?accountId=${encodeURIComponent(nextAccount)}${range}`);
  const rangeSearch = () => (mode === "asOf" ? `&asOf=${asOf}` : `&from=${from}&to=${to}`);
  const valid = accountId !== "" && (mode === "asOf" ? asOf !== "" : from !== "" && to !== "" && from <= to);

  if (gate) {
    return <div className="module-workspace"><AccessGate state={gate} fa={fa} what={{
      en: "Safe and Saraf statements need permission to read Safes or Finance reports.", fa: "صورت‌حساب صندوق و صراف به صلاحیت خواندن صندوق‌ها یا گزارش‌های مالی نیاز دارد."
    }} /></div>;
  }

  const statement = view?.statement ?? null;
  const currency = statement?.account.currencyCode ?? "";
  const base = view?.baseCurrency ?? "";
  const foreign = statement !== null && currency !== base;
  const name = statement ? (fa && statement.account.nameFa ? statement.account.nameFa : statement.account.nameEn) : "";
  const owedToSaraf = statement?.account.accountType === "SARAF" && statement.closing.native.startsWith("-");
  const hasTransfers = statement !== null && (statement.totals.transfersIn !== "0" || statement.totals.transfersOut !== "0");
  const hasReversals = statement !== null && (statement.totals.reversalsIn !== "0" || statement.totals.reversalsOut !== "0");

  return (
    <div className="module-workspace safe-statement-workspace">
      <StageZeroPageHeader icon="coins" eyebrow={{ en: "Finance · Treasury", fa: "مالی · خزانه" }}
        title={{ en: name || "Safe / Saraf statement", fa: name || "صورت‌حساب صندوق و صراف" }}
        description={{ en: "Every posted movement of one Safe, cash box, petty cash or Saraf, in its own currency, with its running balance.",
          fa: "همه حرکات ثبت‌شدهٔ یک صندوق، صندوقچه، تنخواه یا صراف، به واحد پول خودش و با موجودی جاری." }} />

      <form className="admin-form report-filters" aria-label={fa ? "فیلتر گزارش" : "Report filters"}
        onSubmit={(event) => { event.preventDefault(); if (valid) open(accountId, rangeSearch()); }}>
        <label><span>{fa ? "صندوق یا صراف" : "Safe or Saraf"}</span>
          <select value={accountId} onChange={(event) => { if (event.target.value) open(event.target.value, rangeSearch()); }}>
            <option value="" disabled>{fa ? "انتخاب کنید" : "Choose"}</option>
            {(view?.accounts ?? []).map((account) => <option key={account.id} value={account.id}>
              {(fa && account.nameFa ? account.nameFa : account.nameEn)} · {account.currencyCode}</option>)}
          </select></label>
        <label><span>{fa ? "گزارش برای" : "Report for"}</span>
          <select value={mode} onChange={(event) => setMode(event.target.value as Mode)}>
            <option value="asOf">{fa ? "تا تاریخ (از آغاز سال مالی)" : "As of a date (year to date)"}</option>
            <option value="range">{fa ? "بازهٔ تاریخ" : "A date range"}</option>
          </select></label>
        {mode === "asOf" ? <label><span>{fa ? "تاریخ" : "Date"}</span>
          <input type="date" dir="ltr" value={asOf} onChange={(event) => setAsOf(event.target.value)} /></label> : <>
          <label><span>{fa ? "از" : "From"}</span><input type="date" dir="ltr" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
          <label><span>{fa ? "تا" : "To"}</span><input type="date" dir="ltr" value={to} onChange={(event) => setTo(event.target.value)} /></label>
        </>}
        <div className="admin-form-actions">
          <button className="treasury-button gold" type="submit" disabled={!valid}>{fa ? "نمایش" : "Show"}</button>
          <button className="treasury-button" type="button" onClick={() => window.print()} disabled={statement === null}>{fa ? "چاپ" : "Print"}</button>
        </div>
      </form>

      {error ? <div className="treasury-message error" role="alert"><AppIcon name="alert" size={16} /><span>{error}</span></div> : null}
      {view === null && !error ? <p className="treasury-placeholder">{fa ? "در حال بارگذاری…" : "Loading…"}</p> : null}
      {view !== null && statement === null ? <p className="admin-hint" role="note">
        {view.accounts.length === 0 ? (fa ? "هنوز صندوق یا صرافی تعریف نشده است." : "No Safe or Saraf has been set up yet.")
          : (fa ? "صندوق یا صراف را انتخاب کنید." : "Choose a Safe or Saraf.")}</p> : null}

      {statement ? (
        <section className="module-content-card safe-statement" aria-label={fa ? "صورت‌حساب" : "Statement"}>
          <h2>{rangeLabel(statement.range, fa)}</h2>
          <p className="admin-hint">{TYPE_COPY[statement.account.accountType]?.[fa ? "fa" : "en"] ?? statement.account.accountType} · <span dir="ltr">{currency}</span></p>
          <dl className="safe-figures">
            <div><dt>{fa ? "موجودی افتتاحیه" : "Opening balance"}</dt><dd dir="ltr">{money(statement.opening.native, currency)}</dd></div>
            <div><dt>{fa ? "ورودی" : "Money in"}</dt><dd dir="ltr">{money(statement.totals.moneyIn, currency)}</dd></div>
            <div><dt>{fa ? "خروجی" : "Money out"}</dt><dd dir="ltr">{money(statement.totals.moneyOut, currency)}</dd></div>
            <div><dt>{fa ? "موجودی پایانی" : "Closing balance"}</dt><dd dir="ltr"><strong>{money(statement.closing.native, currency)}</strong></dd></div>
          </dl>
          {foreign ? <p className="admin-hint">{fa ? `موجودی این حساب به ${currency} است. ارزش دفتری (${base}، میانگین موزون): ` : `This account's balance is in ${currency}. Carrying value (${base}, weighted average): `}
            <span dir="ltr">{money(statement.closing.base, base)}</span></p> : null}
          {foreign && statement.carryingStatus !== "OK" ? <p className="treasury-message error" role="note">{fa
            ? "ارزش حسابداری این حساب از ثبت‌های پیش از قاعدهٔ ارزش دفتری آمده است و باید اصلاح شود."
            : "This account's accounting value comes from postings made before carrying value applied, and needs correcting."}</p> : null}
          {owedToSaraf ? <p className="admin-hint" role="note">{fa ? "موجودی منفی یعنی این مقدار به صراف بدهکار هستید." : "A negative balance is an amount owed to the Saraf."}</p> : null}
          {hasTransfers ? <p className="admin-hint">{fa ? "شامل انتقال میان حساب‌های خود شرکت: " : "Includes transfers between the company's own accounts: "}
            <span dir="ltr">{money(statement.totals.transfersIn, currency)}</span>{fa ? " ورودی، " : " in, "}
            <span dir="ltr">{money(statement.totals.transfersOut, currency)}</span>{fa ? " خروجی." : " out."}</p> : null}
          {hasReversals ? <p className="admin-hint">{fa ? "شامل برگشت‌ها: " : "Includes reversals: "}
            <span dir="ltr">{money(statement.totals.reversalsIn, currency)}</span>{fa ? " ورودی، " : " in, "}
            <span dir="ltr">{money(statement.totals.reversalsOut, currency)}</span>{fa ? " خروجی." : " out."}</p> : null}
          <p className={statement.reconciliation.matches ? "treasury-message success" : "treasury-message error"} role="status">
            {statement.reconciliation.matches ? (fa ? "با دفتر کل مطابقت دارد." : "Agrees with the General Ledger.")
              : (fa ? `با دفتر کل مطابقت ندارد. تفاوت: ${statement.reconciliation.difference} ${base}` : `Does not agree with the General Ledger. Difference: ${statement.reconciliation.difference} ${base}`)}
            {statement.account.ledgerAccount ? <> <Link href={`/finance/account-statement?accountId=${statement.account.ledgerAccount.id}`}>
              {fa ? "حساب دفتر" : "Ledger account"} <span dir="ltr">{statement.account.ledgerAccount.code}</span></Link></> : null}
          </p>
          {statement.lines.length === 0 ? <p>{fa ? "در این بازه حرکتی نیست." : "No movement in this range."}</p> : (
            <div className="table-scroll"><table className="rates-table safe-statement-table">
              <thead><tr><th>{fa ? "تاریخ" : "Date"}</th><th>{fa ? "مرجع" : "Reference"}</th><th>{fa ? "شرح" : "Details"}</th>
                <th>{fa ? "ورودی" : "Money in"}</th><th>{fa ? "خروجی" : "Money out"}</th><th>{fa ? "موجودی" : "Balance"}</th>
                {foreign ? <th>{fa ? `حرکت ارزش دفتری (${base})` : `Carrying value movement (${base})`}</th> : null}
                {foreign ? <th>{fa ? `ارزش دفتری (${base})` : `Carrying value (${base})`}</th> : null}</tr></thead>
              <tbody>{statement.lines.map((line) => (
                <tr key={line.id} className={line.restricted ? "restricted" : undefined}>
                  <td data-label={fa ? "تاریخ" : "Date"}>{dualDate(line.date, fa)}</td>
                  <td data-label={fa ? "مرجع" : "Reference"} dir="ltr">{line.restricted ? <span className="admin-hint">{fa ? "حرکت محدود" : "Restricted movement"}</span>
                    : line.journalId ? <Link href={`/finance/general-ledger?journalId=${line.journalId}`}>{line.journalReference}</Link> : line.journalReference}
                    {line.reversedBy ? <small className="admin-hint"> {fa ? "برگشت شد" : "reversed"}</small> : null}
                    {line.reverses ? <small className="admin-hint"> {fa ? "برگشتِ" : "reverses"} {line.reverses.reference}</small> : null}</td>
                  <td data-label={fa ? "شرح" : "Details"}><Movement line={line} fa={fa} />
                    {line.source?.reference ? <small className="admin-hint"> · <span dir="ltr">{line.source.reference}</span></small> : null}
                    {line.source?.description ? <small className="admin-hint"> · {line.source.description}</small> : null}</td>
                  <td data-label={fa ? "ورودی" : "Money in"} dir="ltr" className="amount">{reportAmount(line.moneyIn)}</td>
                  <td data-label={fa ? "خروجی" : "Money out"} dir="ltr" className="amount">{reportAmount(line.moneyOut)}</td>
                  <td data-label={fa ? "موجودی" : "Balance"} dir="ltr" className="amount">{money(line.balance, currency)}</td>
                  {foreign ? <td data-label={fa ? "حرکت ارزش دفتری" : "Carrying value movement"} dir="ltr" className="amount">{money(line.baseAmount, base)}
                    {line.fx ? <small className="admin-hint"> 1 {line.fx.unitCurrency} = {line.fx.rate} {line.fx.quoteCurrency} · {line.fx.rateDate}</small> : null}
                    {line.fx?.transactionBaseAmount ? <small className="admin-hint"> {fa ? "به نرخ همان روز:" : "At the day's rate:"} {money(line.fx.transactionBaseAmount, base)}</small> : null}</td> : null}
                  {foreign ? <td data-label={fa ? "ارزش دفتری" : "Carrying value"} dir="ltr" className="amount">{money(line.runningBase, base)}</td> : null}
                </tr>))}</tbody>
            </table></div>
          )}
        </section>
      ) : null}
    </div>
  );
}
