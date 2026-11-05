"use client";

import type { LenderType, LoanCommandResult, LoanWorkspace } from "@abos/contracts";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { api } from "@/components/AdminUsersWorkspace";
import { useLocale } from "@/components/LocaleProvider";
import { loanErrorText } from "@/components/LoansWorkspace";
import { kabulToday } from "@/components/OperationalFinanceShared";
import { StageZeroPageHeader } from "@/components/StageZeroWorkspace";

/**
 * Add Money asks one question and hands over to the lane that answers it. It posts nothing itself: capital and opening balances keep
 * their own screens, and a loan goes to the loan lane.
 */

type Source = "SHAREHOLDER_LOAN" | "OTHER_LOAN";
const LENDER_TYPES: readonly { value: Exclude<LenderType, "SHAREHOLDER">; en: string; fa: string }[] = [
  { value: "INDIVIDUAL", en: "A person", fa: "یک شخص" }, { value: "COMPANY", en: "A company", fa: "یک شرکت" },
  { value: "SUPPLIER", en: "A supplier", fa: "یک تأمین‌کننده" }, { value: "OTHER", en: "Someone else", fa: "دیگری" }
];

function LoanForm({ source, view, fa }: Readonly<{ source: Source; view: LoanWorkspace; fa: boolean }>) {
  const shareholder = source === "SHAREHOLDER_LOAN";
  const options = view.options;
  const accounts = options?.liabilityAccounts.filter((account) => account.control === (shareholder ? "SHAREHOLDER_LOAN" : "LOAN_PAYABLE")) ?? [];
  const blank = { lenderType: "INDIVIDUAL" as Exclude<LenderType, "SHAREHOLDER">, shareholderProfileId: "", lenderBusinessPartyId: "", lenderName: "", treasuryAccountId: "", amount: "",
    businessDate: kabulToday(), reference: "", note: "", liabilityLedgerAccountId: accounts.length === 1 ? accounts[0]?.id ?? "" : "" };
  const [form, setForm] = useState(blank);
  const [saved, setSaved] = useState<LoanCommandResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const request = useRef({ idempotencyKey: `loan-${crypto.randomUUID()}`, correlationId: crypto.randomUUID() });
  const safe = options?.treasuryAccounts.find((account) => account.id === form.treasuryAccountId);
  const set = (change: Partial<typeof blank>) => setForm({ ...form, ...change });

  const submit = async () => {
    setBusy(true); setError(null);
    const result = await api<LoanCommandResult>("/api/v1/finance/loans", "POST", {
      action: "record", lenderType: shareholder ? "SHAREHOLDER" : form.lenderType,
      shareholderProfileId: shareholder ? form.shareholderProfileId : null,
      lenderBusinessPartyId: shareholder ? null : form.lenderBusinessPartyId || null,
      lenderName: shareholder || form.lenderBusinessPartyId ? null : form.lenderName,
      liabilityLedgerAccountId: form.liabilityLedgerAccountId || null, treasuryAccountId: form.treasuryAccountId, amount: form.amount, currencyCode: safe?.currencyCode ?? "",
      businessDate: form.businessDate, reference: form.reference, note: form.note, ...request.current });
    setBusy(false);
    if (!result.ok) { setError(loanErrorText(result.error, fa)); return; }
    setSaved(result.data);
  };

  if (saved) return <p className="treasury-message success" role="status">
    {saved.status === "POSTED" ? (fa ? "قرض ثبت شد." : "Loan recorded.") : (fa ? "قرض برای تأیید فرستاده شد." : "Loan sent for approval.")}{" "}
    <Link href={saved.loanId ? `/finance/loans?loanId=${saved.loanId}` : "/finance/loans"}>{fa ? "دیدن قرض" : "View the loan"}</Link></p>;
  if (accounts.length === 0) return <p className="treasury-message" role="status">
    {fa ? "نخست یک حساب بدهی قرض در " : "First create a loan liability account in the "}<Link href="/finance/accounts">{fa ? "جدول حساب‌ها" : "Chart of Accounts"}</Link>{fa ? " بسازید." : "."}</p>;
  return (
    <form className="admin-form" aria-label={fa ? "ثبت قرض" : "Record loan"} onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <div className="admin-form-grid">
        {shareholder ? <label><span>{fa ? "کدام سهامدار؟" : "Which shareholder?"}</span>
          <select required value={form.shareholderProfileId} onChange={(event) => set({ shareholderProfileId: event.target.value })}>
            <option value="">{fa ? "انتخاب کنید" : "Choose"}</option>
            {options?.shareholders.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
          </select></label> : <>
          <label><span>{fa ? "قرض‌دهنده کیست؟" : "Who lent the money?"}</span>
            <select value={form.lenderType} onChange={(event) => set({ lenderType: event.target.value as typeof form.lenderType })}>
              {LENDER_TYPES.map((type) => <option key={type.value} value={type.value}>{type[fa ? "fa" : "en"]}</option>)}
            </select></label>
          {(options?.lenders.length ?? 0) > 0 ? <label><span>{fa ? "از فهرست" : "From the list"}</span>
            <select value={form.lenderBusinessPartyId} onChange={(event) => set({ lenderBusinessPartyId: event.target.value })}>
              <option value="">{fa ? "نام تازه" : "A new name"}</option>
              {options?.lenders.map((party) => <option key={party.id} value={party.id}>{party.name}</option>)}
            </select></label> : null}
          {form.lenderBusinessPartyId ? null : <label><span>{fa ? "نام" : "Name"}</span>
            <input required maxLength={160} value={form.lenderName} onChange={(event) => set({ lenderName: event.target.value })} /></label>}
        </>}
        <label><span>{fa ? "پول به کدام صندوق رفت؟" : "Which Safe did it go into?"}</span>
          <select required value={form.treasuryAccountId} onChange={(event) => set({ treasuryAccountId: event.target.value })}>
            <option value="">{fa ? "انتخاب کنید" : "Choose"}</option>
            {options?.treasuryAccounts.map((account) => <option key={account.id} value={account.id}>{fa ? account.nameFa ?? account.nameEn : account.nameEn} · {account.currencyCode}</option>)}
          </select></label>
        <label><span>{fa ? `مبلغ${safe ? ` (${safe.currencyCode})` : ""}` : `Amount${safe ? ` (${safe.currencyCode})` : ""}`}</span>
          <input required inputMode="decimal" dir="ltr" value={form.amount} onChange={(event) => set({ amount: event.target.value })} /></label>
        <label><span>{fa ? "تاریخ" : "Date"}</span><input required type="date" dir="ltr" max={view.today} value={form.businessDate} onChange={(event) => set({ businessDate: event.target.value })} /></label>
        {accounts.length > 1 ? <label><span>{fa ? "حساب بدهی" : "Liability account"}</span>
          <select required value={form.liabilityLedgerAccountId} onChange={(event) => set({ liabilityLedgerAccountId: event.target.value })}>
            <option value="">{fa ? "انتخاب کنید" : "Choose"}</option>
            {accounts.map((account) => <option key={account.id} value={account.id}>{account.code} · {account.name}</option>)}
          </select></label> : null}
        <label><span>{fa ? "مرجع (اختیاری)" : "Reference (optional)"}</span><input maxLength={120} value={form.reference} onChange={(event) => set({ reference: event.target.value })} /></label>
        <label><span>{fa ? "یادداشت (اختیاری)" : "Note (optional)"}</span><input maxLength={1000} value={form.note} onChange={(event) => set({ note: event.target.value })} /></label>
      </div>
      {view.approvalRequired ? <p className="admin-hint" role="note">{fa ? "شخص دیگری باید این قرض را تأیید کند." : "Another person must approve this loan before it is recorded."}</p> : null}
      {error ? <p className="treasury-message error" role="alert">{error}</p> : null}
      <button className="treasury-button gold" type="submit" disabled={busy}>{fa ? "ثبت قرض" : "Record loan"}</button>
    </form>
  );
}

export function AddMoneyWorkspace() {
  const { locale } = useLocale();
  const fa = locale === "fa";
  const [view, setView] = useState<LoanWorkspace | null>(null);
  const [source, setSource] = useState<Source | null>(null);
  useEffect(() => {
    let current = true;
    void api<LoanWorkspace>("/api/v1/finance/loans").then((result) => { if (current && result.ok) setView(result.data); });
    return () => { current = false; };
  }, []);
  const canLoan = view?.permissions.canRecord === true;
  const choice = (value: Source, title: { en: string; fa: string }, hint: { en: string; fa: string }) => (
    <button key={value} type="button" className="treasury-card" aria-pressed={source === value} onClick={() => setSource(value)} disabled={!canLoan}>
      <strong>{title[fa ? "fa" : "en"]}</strong><span className="admin-hint">{hint[fa ? "fa" : "en"]}</span></button>);
  return (
    <div className="module-workspace add-money-workspace">
      <StageZeroPageHeader icon="coins" eyebrow={{ en: "Finance", fa: "مالی" }} title={{ en: "Add money", fa: "افزودن پول" }}
        description={{ en: "Where is this money coming from?", fa: "این پول از کجا می‌آید؟" }} />
      <section className="module-content-card" aria-label={fa ? "این پول از کجا می‌آید؟" : "Where is this money coming from?"}>
        <div className="add-money-choices">
          <Link className="treasury-card" href="/shareholders"><strong>{fa ? "سرمایهٔ سهامدار" : "Shareholder capital"}</strong>
            <span className="admin-hint">{fa ? "مالکیت. بازپرداخت نمی‌شود." : "Ownership. It is not repaid."}</span></Link>
          {choice("SHAREHOLDER_LOAN", { en: "Shareholder loan", fa: "قرض سهامدار" }, { en: "A shareholder lends money. It is owed back.", fa: "سهامدار پول قرض می‌دهد و باید پس داده شود." })}
          {choice("OTHER_LOAN", { en: "Other loan", fa: "قرض دیگر" }, { en: "A person, supplier or company lends money. It is owed back.", fa: "شخص، تأمین‌کننده یا شرکت پول قرض می‌دهد و باید پس داده شود." })}
          <Link className="treasury-card" href="/finance/safes"><strong>{fa ? "موجودی افتتاحیه" : "Opening balance"}</strong>
            <span className="admin-hint">{fa ? "پولی که از پیش در صندوق بود." : "Money that was already in a Safe."}</span></Link>
        </div>
      </section>
      {source && view ? <section className="module-content-card" aria-label={fa ? "جزئیات قرض" : "Loan details"}><LoanForm key={source} source={source} view={view} fa={fa} /></section> : null}
    </div>
  );
}
