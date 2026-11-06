"use client";

import type { LenderType, LoanCommandResult, LoanStatementView, LoanView, LoanWorkspace } from "@abos/contracts";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { AccessGate, api, errorText } from "@/components/AdminUsersWorkspace";
import { AppIcon } from "@/components/AppIcon";
import { LoanReadinessPanel } from "@/components/LoanReadinessPanel";
import { useLocale } from "@/components/LocaleProvider";
import { kabulToday, money } from "@/components/OperationalFinanceShared";
import { StageZeroPageHeader } from "@/components/StageZeroWorkspace";

const ENDPOINT = "/api/v1/finance/loans";
const identity = () => ({ idempotencyKey: `loan-${crypto.randomUUID()}`, correlationId: crypto.randomUUID() });

const LENDER_LABEL: Record<LenderType, { en: string; fa: string }> = {
  SHAREHOLDER: { en: "Shareholder", fa: "سهامدار" },
  INDIVIDUAL: { en: "Person", fa: "شخص" },
  SUPPLIER: { en: "Supplier", fa: "تأمین‌کننده" },
  COMPANY: { en: "Company", fa: "شرکت" },
  OTHER: { en: "Other", fa: "دیگر" }
};
const STATUS_LABEL = { PENDING_APPROVAL: { en: "Waiting for approval", fa: "منتظر تأیید" }, REJECTED: { en: "Rejected", fa: "رد شد" }, POSTED: { en: "Recorded", fa: "ثبت شد" } } as const;
const KIND_LABEL = {
  RECEIPT: { en: "Loan received", fa: "قرض دریافت‌شده" }, REPAYMENT: { en: "Repayment", fa: "بازپرداخت" },
  RECEIPT_REVERSAL: { en: "Loan reversed", fa: "برگشت قرض" }, REPAYMENT_REVERSAL: { en: "Repayment reversed", fa: "برگشت بازپرداخت" }
} as const;

/** A readable refusal for the lane's own errors; everything else keeps the shared wording. */
export function loanErrorText(error: { code: string; message: string }, fa: boolean): string {
  const known: Record<string, [string, string]> = {
    LOAN_ACCOUNT_REQUIRED: ["Create a loan liability account in the Chart of Accounts first.", "نخست یک حساب بدهی قرض در جدول حساب‌ها بسازید."],
    LOAN_ACCOUNT_CHOICE: ["Choose which liability account this loan is owed on.", "انتخاب کنید این قرض روی کدام حساب بدهی است."],
    REPAYMENT_EXCEEDS_OUTSTANDING: ["This is more than is outstanding on the loan.", "این مبلغ بیشتر از باقی‌ماندهٔ قرض است."],
    REALIZED_FX_GAIN_ACCOUNT_REQUIRED: ["This repayment realizes an FX gain. Create a Realized FX Gain account first. Nothing was recorded.", "این بازپرداخت مفاد تبادله اسعار دارد. نخست حساب «مفاد تحقق‌یافتهٔ تبادله اسعار» را بسازید. چیزی ثبت نشد."],
    REALIZED_FX_LOSS_ACCOUNT_REQUIRED: ["This repayment realizes an FX loss. Create a Realized FX Loss account first. Nothing was recorded.", "این بازپرداخت ضرر تبادله اسعار دارد. نخست حساب «ضرر تحقق‌یافتهٔ تبادله اسعار» را بسازید. چیزی ثبت نشد."],
    REALIZED_FX_ACCOUNT_INVALID: ["Keep exactly one active Realized FX Gain and one Realized FX Loss account, in the accounting currency, without dimensions. Nothing was recorded.", "دقیقاً یک حساب فعال مفاد و یک حساب فعال ضرر تبادله اسعار، به واحد پول حسابداری و بدون ابعاد، نگه دارید. چیزی ثبت نشد."],
    LOAN_REPAY_IN_FULL: ["So little accounting value remains on this loan that it can only be repaid in full.", "ارزش حسابداری این قرض آن‌قدر کم است که تنها به‌طور کامل بازپرداخت می‌شود."],
    INSUFFICIENT_FUNDS: ["The Safe does not hold enough money for this.", "صندوق پول کافی برای این کار ندارد."]
  };
  const copy = known[error.code];
  return copy ? copy[fa ? 1 : 0] : errorText(error, fa ? "fa" : "en");
}

/** Where a refusal can be fixed, when a repayment needs an account that is not there. */
const SETUP_LINK: Readonly<Record<string, string>> = {
  REALIZED_FX_GAIN_ACCOUNT_REQUIRED: "/finance/accounts?new=REALIZED_FX_GAIN",
  REALIZED_FX_LOSS_ACCOUNT_REQUIRED: "/finance/accounts?new=REALIZED_FX_LOSS",
  REALIZED_FX_ACCOUNT_INVALID: "/finance/accounts"
};

/** What a posted repayment realized, in words. Nothing is said when there was no difference. */
function realizedText(value: string | undefined, currency: string, fa: boolean): string {
  const amount = Number(value ?? 0);
  if (amount === 0) return "";
  const figure = money(String(Math.abs(amount)), currency);
  return amount > 0 ? (fa ? ` مفاد تبادله اسعار: ${figure}.` : ` Realized FX gain: ${figure}.`) : (fa ? ` ضرر تبادله اسعار: ${figure}.` : ` Realized FX loss: ${figure}.`);
}

function RepayForm({ loan, view, fa, onDone }: Readonly<{ loan: LoanView; view: LoanWorkspace; fa: boolean; onDone: (message: string) => void }>) {
  const safes = view.options?.treasuryAccounts.filter((account) => account.currencyCode === loan.currency) ?? [];
  const [form, setForm] = useState({ treasuryAccountId: safes.length === 1 ? safes[0]?.id ?? "" : "", amount: "", businessDate: kabulToday(), reference: "", note: "" });
  const [error, setError] = useState<string | null>(null);
  const [setup, setSetup] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const request = useRef(identity());
  const submit = async () => {
    setBusy(true); setError(null); setSetup(null);
    const result = await api<LoanCommandResult>(ENDPOINT, "POST", { action: "repay", loanId: loan.id, ...form, ...request.current });
    setBusy(false);
    if (!result.ok) { setError(loanErrorText(result.error, fa)); setSetup(SETUP_LINK[result.error.code] ?? null); return; }
    onDone(result.data.status === "POSTED" ? `${fa ? "بازپرداخت ثبت شد." : "Repayment recorded."}${realizedText(result.data.realizedFx, view.baseCurrency, fa)}` : (fa ? "بازپرداخت برای تأیید فرستاده شد." : "Repayment sent for approval."));
  };
  return (
    <form className="admin-form" aria-label={fa ? "بازپرداخت قرض" : "Repay loan"} onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <div className="admin-form-grid">
        <label><span>{fa ? "از کدام صندوق؟" : "From which Safe?"}</span>
          <select required value={form.treasuryAccountId} onChange={(event) => setForm({ ...form, treasuryAccountId: event.target.value })}>
            <option value="">{fa ? "انتخاب کنید" : "Choose"}</option>
            {safes.map((account) => <option key={account.id} value={account.id}>{fa ? account.nameFa ?? account.nameEn : account.nameEn}</option>)}
          </select></label>
        <label><span>{fa ? `مبلغ (${loan.currency})` : `Amount (${loan.currency})`}</span>
          <input required inputMode="decimal" dir="ltr" value={form.amount} onChange={(event) => setForm({ ...form, amount: event.target.value })} /></label>
        <label><span>{fa ? "تاریخ" : "Date"}</span><input required type="date" dir="ltr" max={view.today} value={form.businessDate} onChange={(event) => setForm({ ...form, businessDate: event.target.value })} /></label>
        <label><span>{fa ? "مرجع (اختیاری)" : "Reference (optional)"}</span><input maxLength={120} value={form.reference} onChange={(event) => setForm({ ...form, reference: event.target.value })} /></label>
      </div>
      {error ? <p className="treasury-message error" role="alert">{error}{setup ? <> <Link href={setup}>{setup.includes("?new=") ? (fa ? "ساختن حساب" : "Create the account") : (fa ? "جدول حساب‌ها" : "Chart of Accounts")}</Link></> : null}</p> : null}
      <button className="treasury-button gold" type="submit" disabled={busy}>{fa ? "ثبت بازپرداخت" : "Record repayment"}</button>
    </form>
  );
}

function Statement({ loanId, fa, base }: Readonly<{ loanId: string; fa: boolean; base: string }>) {
  const [view, setView] = useState<LoanStatementView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    void api<LoanStatementView>(`${ENDPOINT}/statement?loanId=${loanId}&asOf=${kabulToday()}`).then((result) => {
      if (!current) return;
      if (result.ok) setView(result.data); else setError(loanErrorText(result.error, fa));
    });
    return () => { current = false; };
  }, [loanId, fa]);
  if (error) return <p className="treasury-message error" role="alert">{error}</p>;
  if (view === null) return <p className="treasury-placeholder">{fa ? "در حال بارگذاری…" : "Loading…"}</p>;
  const currency = view.loan.currency;
  const realized = view.lines.some((line) => Number(line.realizedFx) !== 0);
  return (
    <section className="module-content-card" aria-label={fa ? "صورت‌حساب قرض" : "Loan statement"}>
      <h3>{fa ? "صورت‌حساب قرض" : "Loan statement"}</h3>
      <p className={view.reconciliation.matches ? "treasury-message success" : "treasury-message error"} role="status">
        {view.reconciliation.matches ? (fa ? "با حساب بدهی مطابقت دارد." : "Agrees with the liability account.") : (fa ? "با حساب بدهی مطابقت ندارد." : "Does not agree with the liability account.")}</p>
      <div className="table-scroll"><table className="rates-table">
        <thead><tr><th>{fa ? "تاریخ" : "Date"}</th><th>{fa ? "حرکت" : "Movement"}</th><th>{fa ? "صندوق" : "Safe"}</th><th>{fa ? "مبلغ" : "Amount"}</th>{realized ? <th>{fa ? "تبادله اسعار" : "Realized FX"}</th> : null}<th>{fa ? "باقی‌مانده" : "Outstanding"}</th></tr></thead>
        <tbody>
          <tr><td colSpan={realized ? 5 : 4}>{fa ? "افتتاحیه" : "Opening"}</td><td dir="ltr" className="amount">{money(view.opening.native, currency)}</td></tr>
          {view.lines.map((line) => <tr key={line.journalId}>
            <td dir="ltr">{line.date}</td>
            <td><Link href={`/finance/general-ledger?journalId=${line.journalId}`}>{KIND_LABEL[line.kind][fa ? "fa" : "en"]}</Link> <small className="admin-hint" dir="ltr">{line.reference}</small></td>
            <td>{line.treasury ? (fa ? line.treasury.nameFa ?? line.treasury.nameEn : line.treasury.nameEn) : ""}</td>
            <td dir="ltr" className="amount">{money(line.amount, currency)}</td>
            {realized ? <td dir="ltr" className="amount">{Number(line.realizedFx) === 0 ? "" : money(line.realizedFx, base)}</td> : null}
            <td dir="ltr" className="amount">{money(line.balance, currency)}</td></tr>)}
          <tr className="summary-total"><th scope="row" colSpan={realized ? 5 : 4}>{fa ? "باقی‌مانده" : "Outstanding"}</th><td dir="ltr" className="amount">{money(view.closing.native, currency)}</td></tr>
        </tbody></table></div>
      {currency !== base ? <p className="admin-hint" role="note">
        {fa ? `ارزش حسابداری باقی‌مانده: ${money(view.closing.base, base)}.` : `Accounting value still owed: ${money(view.closing.base, base)}.`}
        {realized ? (fa ? ` تبادله اسعار تحقق‌یافته در این دوره: ${money(view.realizedFx, base)}.` : ` Realized FX in this period: ${money(view.realizedFx, base)}.`) : ""}</p> : null}
    </section>
  );
}

export function LoansWorkspace() {
  const { locale } = useLocale();
  const fa = locale === "fa";
  const router = useRouter();
  const selected = useSearchParams().get("loanId");
  const [view, setView] = useState<LoanWorkspace | null>(null);
  const [gate, setGate] = useState<"signed-out" | "denied" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [repaying, setRepaying] = useState<string | null>(null);

  const [revision, setRevision] = useState(0);
  const load = () => setRevision((value) => value + 1);
  useEffect(() => {
    let current = true;
    void api<LoanWorkspace>(ENDPOINT).then((result) => {
      if (!current) return;
      if (result.ok) { setView(result.data); setError(null); return; }
      setGate(result.status === 401 ? "signed-out" : result.status === 403 ? "denied" : null);
      if (result.status !== 401 && result.status !== 403) setError(loanErrorText(result.error, fa));
    });
    return () => { current = false; };
  }, [fa, revision]);

  const decide = async (kind: "LOAN" | "REPAYMENT", id: string, decision: "APPROVED" | "REJECTED") => {
    const reason = decision === "REJECTED" ? window.prompt(fa ? "دلیل رد کردن" : "Reason for rejecting") : null;
    if (decision === "REJECTED" && !reason) return;
    const result = await api<LoanCommandResult>(ENDPOINT, "POST", { action: "decide", kind, id, decision, reason, ...identity() });
    if (!result.ok) { setError(loanErrorText(result.error, fa)); return; }
    setMessage(decision === "APPROVED" ? (fa ? "تأیید و ثبت شد." : "Approved and recorded.") : (fa ? "رد شد." : "Rejected."));
    load();
  };

  if (gate) return <div className="module-workspace"><AccessGate state={gate} fa={fa} what={{ en: "Loans need permission to read or record loans.", fa: "قرض‌ها به صلاحیت خواندن یا ثبت قرض نیاز دارد." }} /></div>;
  const loans = view?.loans ?? [];
  const pending = loans.filter((loan) => loan.status === "PENDING_APPROVAL");
  const open = selected ? loans.find((loan) => loan.id === selected) : undefined;
  return (
    <div className="module-workspace loans-workspace">
      <StageZeroPageHeader icon="coins" eyebrow={{ en: "Finance", fa: "مالی" }} title={{ en: "Loans", fa: "قرض‌ها" }}
        description={{ en: "Money lent to the company, what has been repaid and what is still owed. A loan is debt, never capital.", fa: "پولی که به شرکت قرض داده شده، آنچه بازپرداخت شده و آنچه هنوز باقی است. قرض بدهی است، نه سرمایه." }} />
      {view ? <LoanReadinessPanel fa={fa} /> : null}
      {view?.permissions.canRecord ? <p><Link className="treasury-button gold" href="/finance/add-money">{fa ? "افزودن پول" : "Add money"}</Link></p> : null}
      {message ? <p className="treasury-message success" role="status">{message}</p> : null}
      {error ? <div className="treasury-message error" role="alert"><AppIcon name="alert" size={16} /><span>{error}</span></div> : null}
      {view === null && !error ? <p className="treasury-placeholder">{fa ? "در حال بارگذاری…" : "Loading…"}</p> : null}
      {view && view.permissions.canApprove && (pending.length > 0 || (view.pendingRepayments?.length ?? 0) > 0) ? (
        <section className="module-content-card" aria-label={fa ? "منتظر تأیید" : "Waiting for approval"}>
          <h2>{fa ? "منتظر تأیید" : "Waiting for approval"}</h2>
          <ul className="period-pending">
            {pending.map((loan) => <li key={loan.id}>{loan.lender.name} · <span dir="ltr">{money(loan.principal, loan.currency)}</span>{" "}
              <button className="treasury-button" type="button" onClick={() => void decide("LOAN", loan.id, "APPROVED")}>{fa ? "تأیید" : "Approve"}</button>{" "}
              <button className="treasury-button" type="button" onClick={() => void decide("LOAN", loan.id, "REJECTED")}>{fa ? "رد" : "Reject"}</button></li>)}
            {view.pendingRepayments?.map((payment) => <li key={payment.id}>{fa ? "بازپرداخت" : "Repayment"} · {payment.lender} · <span dir="ltr">{money(payment.amount, payment.currency)}</span>{" "}
              <button className="treasury-button" type="button" onClick={() => void decide("REPAYMENT", payment.id, "APPROVED")}>{fa ? "تأیید" : "Approve"}</button>{" "}
              <button className="treasury-button" type="button" onClick={() => void decide("REPAYMENT", payment.id, "REJECTED")}>{fa ? "رد" : "Reject"}</button></li>)}
          </ul>
        </section>) : null}
      {view ? (
        <section className="module-content-card" aria-label={fa ? "قرض‌ها" : "Loans"}>
          {loans.length === 0 ? <p>{fa ? "هنوز قرضی ثبت نشده است." : "No loans recorded yet."}</p> : (
            <div className="table-scroll"><table className="rates-table">
              <thead><tr><th>{fa ? "قرض‌دهنده" : "Lender"}</th><th>{fa ? "نوع" : "Type"}</th><th>{fa ? "تاریخ" : "Date"}</th><th>{fa ? "قرض" : "Loan"}</th><th>{fa ? "بازپرداخت" : "Repaid"}</th><th>{fa ? "باقی‌مانده" : "Outstanding"}</th><th>{fa ? "وضعیت" : "Status"}</th></tr></thead>
              <tbody>{loans.map((loan) => <tr key={loan.id} className={loan.id === selected ? "selected" : undefined}>
                <th scope="row"><Link href={`/finance/loans?loanId=${loan.id}`}>{loan.lender.name}</Link></th>
                <td>{LENDER_LABEL[loan.lenderType][fa ? "fa" : "en"]}</td>
                <td dir="ltr">{loan.date}</td>
                <td dir="ltr" className="amount">{money(loan.principal, loan.currency)}</td>
                <td dir="ltr" className="amount">{money(loan.repaid, loan.currency)}</td>
                <td dir="ltr" className="amount">{money(loan.outstanding, loan.currency)}</td>
                <td>{loan.reversed ? (fa ? "برگشت شد" : "Reversed") : STATUS_LABEL[loan.status][fa ? "fa" : "en"]}</td></tr>)}</tbody>
            </table></div>)}
        </section>) : null}
      {open && view ? <>
        <h2>{open.lender.name}</h2>
        {view.permissions.canRepay && open.status === "POSTED" && Number(open.outstanding) > 0 ? (repaying === open.id
          ? <RepayForm key={open.id} loan={open} view={view} fa={fa} onDone={(text) => { setRepaying(null); setMessage(text); load(); router.refresh(); }} />
          : <button className="treasury-button gold" type="button" onClick={() => setRepaying(open.id)}>{fa ? "بازپرداخت" : "Repay"}</button>) : null}
        {open.status === "POSTED" && view.permissions.canRead ? <Statement key={`${open.id}-${open.outstanding}`} loanId={open.id} fa={fa} base={view.baseCurrency} /> : null}
      </> : null}
    </div>
  );
}
