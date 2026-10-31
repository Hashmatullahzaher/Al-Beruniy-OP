"use client";

import type { MoneyOptions, MoneyResult, OperationalExpenseEntryOptions, PaymentKind, SafeView } from "@abos/contracts";
import Link from "next/link";
import { useEffect, useState } from "react";

import { api, errorText } from "@/components/AdminUsersWorkspace";
import { FxConversionField, type FxChoice } from "@/components/FxConversionField";
import { localizedName, money } from "@/components/OperationalFinanceShared";
import type { Copy } from "@/lib/access-copy";

export type MoneyKind = "receive" | "transfer" | "pay";

const AMOUNT = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;
const MONEY = "/api/v1/finance/money";
const EXPENSES = "/api/v1/finance/operations/expenses";

export const MONEY_ACTION_COPY: Readonly<Record<MoneyKind, Copy>> = {
  receive: { en: "Receive cash", fa: "دریافت پول" },
  transfer: { en: "Transfer", fa: "انتقال" },
  pay: { en: "Pay", fa: "پرداخت" }
};

const KIND_COPY: Readonly<Record<PaymentKind, Copy>> = {
  SUPPLIER: { en: "Supplier", fa: "تأمین‌کننده" },
  CONTRACTOR: { en: "Contractor", fa: "قراردادی" },
  SALARY: { en: "Salary", fa: "معاش" },
  OTHER: { en: "Other", fa: "دیگر" }
};

/** Dari for the refusal codes of moneyErrorResponse and the expense lane. */
export const MONEY_ERROR_FA: Readonly<Record<string, string>> = {
  INSUFFICIENT_FUNDS: "صندوق برای این کار پول کافی ندارد. صندوق، صندوقچه و تنخواه هرگز زیر صفر نمی‌رود.",
  APPROVAL_NOT_AVAILABLE: "شرکت برای این مورد تأیید لازم دارد که هنوز برای آن در دسترس نیست. برای ثبت با یک ذخیره، تأیید را در «تأیید جریان‌ها» خاموش کنید.",
  SAME_ACCOUNT: "دو حساب متفاوت انتخاب کنید.",
  CURRENCY_MISMATCH: "هر دو حساب باید یک واحد پول داشته باشند.",
  BASE_CURRENCY_ONLY: "فعلاً فقط به واحد پول حسابداری شرکت در دسترس است.",
  ACCOUNT_NOT_ACTIVE: "صندوق یا حساب صراف انتخاب‌شده فعال نیست.",
  ACCOUNT_NOT_FOUND: "این حساب برای شرکت شما در دسترس نیست.",
  INCOME_ACCOUNT_REQUIRED: "یک حساب عاید فعال به واحد پول حسابداری انتخاب کنید.",
  PAYABLE_ACCOUNT_REQUIRED: "یک حساب قابل پرداخت فعال به واحد پول حسابداری انتخاب کنید.",
  COUNTERPARTY_REQUIRED: "بگویید چه کسی پرداخت کرد یا به چه کسی پرداخت شد.",
  SUPPLIER_REQUIRED: "پرداخت در مقابل حساب‌های قابل پرداخت به شخص یا سازمانی نیاز دارد که طلبکار بود؛ آن را از فهرست انتخاب کنید.",
  PARTY_NOT_AVAILABLE: "شخص یا سازمان انتخاب‌شده در دسترس نیست.",
  DATE_IN_FUTURE: "تاریخ نمی‌تواند بعد از امروز باشد.",
  PERIOD_MISSING: "هیچ ماهی در سال مالی شما این تاریخ را پوشش نمی‌دهد. ابتدا سال مالی را بسازید.",
  PERIOD_CLOSED: "سال مالی این تاریخ بسته است. تاریخی در سال مالی فعال انتخاب کنید.",
  ALREADY_SUBMITTED_DIFFERENTLY: "این فرم قبلاً با جزئیات دیگری فرستاده شده است. دوباره شروع کنید.",
  INVALID_AMOUNT: "یک مبلغ مثبت مانند 250 یا 250.50 وارد کنید.",
  VALIDATION_FAILED: "بعضی جزئیات ناقص یا نادرست است.",
  FX_SETUP_REQUIRED: "این کار تفاوت تبادله اسعار ثبت می‌کند که به یک حساب عاید یا مصرف با کنترل «تفاوت تبادله اسعار» در جدول حساب‌ها نیاز دارد.",
  FX_SETUP_AMBIGUOUS: "چند حساب کنترل «تفاوت تبادله اسعار» دارند. در پالیسی اسعار یکی را تعیین کنید.",
  FX_SETUP_INVALID: "حساب تفاوت تبادله اسعار قابل استفاده نیست. آن را در جدول حساب‌ها یا پالیسی اسعار بررسی کنید.",
  CONVERSION_NOT_EXACT: "این مبلغ با نرخ انتخاب‌شده دقیق تبدیل نمی‌شود و پالیسی اسعار این واحد پول فقط دقیق است.",
  AMOUNT_TOO_SMALL: "این مبلغ برای تبدیل بسیار کوچک است: به واحد پول حسابداری صفر می‌شود.",
  RATE_MISSING: "برای این تاریخ نرخ اسعار ثبت نشده است. ابتدا نرخ همان روز را ثبت کنید.",
  RATE_CHOICE_REQUIRED: "برای این تاریخ چند نرخ وجود دارد. نرخ این حرکت را انتخاب کنید.",
  RATE_INVALID: "نرخ انتخاب‌شده نرخ جاری این تاریخ نیست.",
  CURRENCY_NOT_AVAILABLE: "این واحد پول برای شرکت فعال نیست.",
  NETWORK: "سرور در دسترس نیست. دوباره تلاش کنید؛ همان درخواست دوباره ثبت نمی‌شود."
};

function moneyError(error: { code: string; message: string }, locale: "en" | "fa"): string {
  if (locale === "fa") return MONEY_ERROR_FA[error.code] ?? errorText(error, locale);
  if (error.code === "NETWORK") return "The server could not be reached. Try again; the same request will not be recorded twice.";
  return error.message || errorText(error, locale);
}

function identity() {
  return { idempotencyKey: `money-${crypto.randomUUID()}`, correlationId: crypto.randomUUID() };
}

const SETTING_FOR: Readonly<Record<string, string>> = { receive: "OTHER_INCOME", transfer: "TREASURY_TRANSFER" };

/** One money movement form for one Safe; it saves once and reports the outcome to the Safes page. */
export function MoneyMovementForm({ kind, safe, options, fa, close, done }: Readonly<{
  kind: MoneyKind; safe: SafeView; options: MoneyOptions; fa: boolean; close: () => void;
  done: (message: Copy) => Promise<void>;
}>) {
  const locale = fa ? "fa" : "en";
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(options.today);
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [party, setParty] = useState("");
  const [name, setName] = useState("");
  const [account, setAccount] = useState("");
  const [destination, setDestination] = useState("");
  const [paymentKind, setPaymentKind] = useState<PaymentKind>("SUPPLIER");
  const [payFor, setPayFor] = useState<"expense" | "payable">(options.canRecordExpense ? "expense" : "payable");
  const [category, setCategory] = useState("");
  const [description, setDescription] = useState("");
  const [expenseOptions, setExpenseOptions] = useState<OperationalExpenseEntryOptions | null>(null);
  const [request, setRequest] = useState(identity);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fx, setFx] = useState<FxChoice>({ exchangeRateId: null, ready: true });
  const change = <T,>(set: (value: T) => void) => (value: T) => { set(value); setRequest(identity()); };

  useEffect(() => {
    if (kind !== "pay" || payFor !== "expense" || !options.canRecordExpense) return;
    let current = true;
    void api<OperationalExpenseEntryOptions>(`/api/v1/finance/operations/expense-options?date=${encodeURIComponent(date)}`).then((result) => {
      if (current && result.ok) setExpenseOptions(result.data);
    });
    return () => { current = false; };
  }, [kind, payFor, date, options.canRecordExpense]);

  // This form has no project, department or cost center, so it offers only expense types that need none.
  const simpleCategories = (expenseOptions?.expenseCategories ?? []).filter((item) => !item.requiresProject && !item.requiresDepartment && !item.requiresCostCenter);
  const others = options.treasuryAccounts.filter((other) => other.id !== safe.id && other.currencyCode === safe.currencyCode);
  // The expense lane (0048) reads the salary or supplier setting by kind and EXPENSE otherwise; it can wait for approval.
  const kindSetting = options.settings[paymentKind === "SALARY" ? "SALARY_PAYMENT" : "SUPPLIER_PAYMENT"];
  // 0049: an expense waits when its EXPENSE setting or its kind's setting is ON; an unsaved setting is OFF.
  const expenseSetting = expenseOptions?.approvalRequired || (paymentKind !== "OTHER" && kindSetting === "APPROVAL_REQUIRED") ? "WAITS" : "READY";
  const setting = kind === "pay"
    ? (payFor === "payable" ? kindSetting : expenseSetting)
    : options.settings[SETTING_FOR[kind] ?? ""];
  const amountValid = AMOUNT.test(amount.trim()) && /[1-9]/.test(amount);
  // Accounts payable is kept per supplier: its payee must be chosen from the list, not typed.
  const partyRequired = kind === "pay" && payFor === "payable" && options.payableAccounts.some((item) => item.id === account && item.requiresParty);
  const counterparty = party !== "" || (!partyRequired && name.trim() !== "");
  const valid = amountValid && date !== "" && date <= options.today && setting !== "APPROVAL_REQUIRED" && fx.ready && (
    kind === "receive" ? account !== "" && counterparty
      : kind === "transfer" ? destination !== ""
        : payFor === "payable" ? account !== "" && counterparty
          : category !== "" && description.trim().length >= 3 && reference.trim() !== "");
  const title = `${(fa ? MONEY_ACTION_COPY[kind].fa : MONEY_ACTION_COPY[kind].en)} — ${localizedName(safe, fa)}`;

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true); setError(null);
    const common = { amount: amount.trim(), currencyCode: safe.currencyCode, businessDate: date, reference: reference.trim() || null,
      note: note.trim() || null, exchangeRateId: fx.exchangeRateId, ...request };
    let result: Awaited<ReturnType<typeof api<unknown>>>;
    if (kind === "receive") {
      result = await api<MoneyResult>(MONEY, "POST", { action: "receive-cash", ...common, treasuryAccountId: safe.id,
        payerBusinessPartyId: party || null, payerName: party ? null : name.trim() || null, revenueLedgerAccountId: account });
    } else if (kind === "transfer") {
      result = await api<MoneyResult>(MONEY, "POST", { action: "transfer", ...common, sourceTreasuryAccountId: safe.id,
        destinationTreasuryAccountId: destination });
    } else if (payFor === "payable") {
      result = await api<MoneyResult>(MONEY, "POST", { action: "pay-payable", ...common, treasuryAccountId: safe.id, paymentKind,
        payeeBusinessPartyId: party || null, payeeName: party || partyRequired ? null : name.trim() || null, payableLedgerAccountId: account });
    } else {
      // An expense keeps its one model: the expense lane, with the payment kind choosing the approval setting.
      result = await api(EXPENSES, "POST", { treasuryAccountId: safe.id, expenseCategoryId: category, payeeBusinessPartyId: party || null,
        projectId: null, departmentId: null, costCenterId: null, reference: reference.trim(), description: description.trim(),
        note: note.trim() || null, businessDate: date, originalAmount: amount.trim(), currencyCode: safe.currencyCode, exchangeRateId: fx.exchangeRateId,
        paymentKind, correlationId: request.correlationId, idempotencyKey: request.idempotencyKey });
    }
    setBusy(false);
    if (!result.ok) { setError(moneyError(result.error, locale)); return; }
    const status = (result.data as { expense?: { status?: string } }).expense?.status;
    await done(status === "PENDING_APPROVAL"
      ? { en: "Payment recorded and waiting for approval. The Safe changes once it is approved.", fa: "پرداخت ثبت شد و منتظر تأیید است. صندوق پس از تأیید تغییر می‌کند." }
      : kind === "receive" ? { en: "Money received and recorded.", fa: "پول دریافت و ثبت شد." }
        : kind === "transfer" ? { en: "Transfer recorded.", fa: "انتقال ثبت شد." }
          : { en: "Payment recorded.", fa: "پرداخت ثبت شد." });
    close();
  };

  // The database is authoritative; this only tells the person before saving (0049).
  const cashLike = safe.accountType === "SAFE" || safe.accountType === "CASH_BOX" || safe.accountType === "PETTY_CASH";
  const spends = kind === "transfer" || kind === "pay";
  const overdraws = cashLike && spends && amountValid && Number(amount.trim()) > Number(safe.balance.book);
  const settingNotice = setting === "WAITS"
      ? (fa ? "این پرداخت پس از ذخیره منتظر تأیید می‌ماند." : "This payment will wait for approval after it is saved.")
      : setting === "APPROVAL_REQUIRED"
        ? (fa ? "شرکت برای این مورد تأیید لازم دارد که هنوز برای آن در دسترس نیست." : "The company requires approval for this, which is not available for it yet.")
        : null;

  return (
    <form className="admin-form expense-form safe-opening-form money-form" aria-label={title}
      onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      {kind === "pay" ? <>
        <label><span>{fa ? "نوع پرداخت *" : "Kind of payment *"}</span>
          <select value={paymentKind} onChange={(event) => change(setPaymentKind)(event.target.value as PaymentKind)}>
            {(Object.keys(KIND_COPY) as PaymentKind[]).map((value) => <option key={value} value={value}>{fa ? KIND_COPY[value].fa : KIND_COPY[value].en}</option>)}
          </select></label>
        <fieldset className="admin-status-choice wide">
          <legend>{fa ? "برای چه پرداخت شد؟ *" : "What was paid for? *"}</legend>
          {options.canRecordExpense ? <label><input type="radio" name={`pay-for-${safe.id}`} checked={payFor === "expense"} onChange={() => change(setPayFor)("expense")} />
            {" "}{fa ? "یک مصرف" : "An expense"}</label> : null}
          {options.canPay ? <label><input type="radio" name={`pay-for-${safe.id}`} checked={payFor === "payable"} onChange={() => change(setPayFor)("payable")} />
            {" "}{fa ? "چیزی که بدهکار بودیم (قابل پرداخت)" : "Something we owed (a payable)"}</label> : null}
        </fieldset>
      </> : null}

      {kind === "transfer" ? (
        <label className="wide"><span>{fa ? "به کدام حساب؟ *" : "To which account? *"}</span>
          <select value={destination} required onChange={(event) => change(setDestination)(event.target.value)}>
            <option value="">{fa ? "انتخاب کنید" : "Choose"}</option>
            {others.map((other) => <option key={other.id} value={other.id}>{localizedName(other, fa)} · {other.currencyCode}</option>)}
          </select>
          {others.length === 0 ? <small>{fa ? "حساب فعال دیگری با همین واحد پول وجود ندارد." : "There is no other active account in this currency."}</small> : null}</label>
      ) : (
        <>
          <label><span>{kind === "receive" ? (fa ? "از چه کسی؟" : "From whom?") : (fa ? "به چه کسی؟" : "To whom?")}</span>
            <select value={party} onChange={(event) => change(setParty)(event.target.value)}>
              <option value="">—</option>
              {options.parties.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
            </select></label>
          {!(kind === "pay" && payFor === "expense") ? (
            <label><span>{fa ? "یا نام" : "Or a name"}</span>
              <input value={name} disabled={party !== "" || partyRequired} maxLength={200} onChange={(event) => change(setName)(event.target.value)} />
              {partyRequired && party === "" ? <small>{fa ? "برای حساب‌های قابل پرداخت، شخص یا سازمان را از فهرست انتخاب کنید." : "For accounts payable, choose the person or organization from the list."}</small> : null}</label>
          ) : null}
        </>
      )}

      {kind === "receive" ? (
        <label className="wide"><span>{fa ? "حساب عاید *" : "Income account *"}</span>
          <select value={account} required onChange={(event) => change(setAccount)(event.target.value)}>
            <option value="">{fa ? "انتخاب کنید" : "Choose"}</option>
            {options.incomeAccounts.map((item) => <option key={item.id} value={item.id}>{item.code} · {item.name}</option>)}
          </select>
          {options.incomeAccounts.length === 0 ? <small>{fa ? "ابتدا یک حساب عاید در " : "Create an income account in the "}<Link href="/finance/accounts">{fa ? "جدول حساب‌ها" : "Chart of Accounts"}</Link>{fa ? " بسازید." : " first."}</small> : null}</label>
      ) : null}
      {kind === "pay" && payFor === "payable" ? (
        <label className="wide"><span>{fa ? "حساب قابل پرداخت *" : "Payable account *"}</span>
          <select value={account} required onChange={(event) => change(setAccount)(event.target.value)}>
            <option value="">{fa ? "انتخاب کنید" : "Choose"}</option>
            {options.payableAccounts.map((item) => <option key={item.id} value={item.id}>{item.code} · {item.name}</option>)}
          </select></label>
      ) : null}
      {kind === "pay" && payFor === "expense" ? <>
        <label><span>{fa ? "نوع مصرف *" : "Expense type *"}</span>
          <select value={category} required onChange={(event) => change(setCategory)(event.target.value)}>
            <option value="">{fa ? "انتخاب کنید" : "Choose"}</option>
            {simpleCategories.map((item) => <option key={item.id} value={item.id}>{localizedName(item, fa)}</option>)}
          </select>
          {simpleCategories.length < (expenseOptions?.expenseCategories.length ?? 0)
            ? <small>{fa ? "انواع مصرفی که پروژه، بخش یا مرکز هزینه لازم دارند در " : "Expense types that need a project, department or cost center are recorded in "}
              <Link href="/finance/record-expense">{fa ? "ثبت مصرف" : "Record expense"}</Link>{fa ? " ثبت می‌شوند." : "."}</small> : null}</label>
        <label><span>{fa ? "شرح *" : "Description *"}</span>
          <input value={description} maxLength={500} onChange={(event) => change(setDescription)(event.target.value)} /></label>
      </> : null}

      <label><span>{fa ? "مبلغ *" : "Amount *"}</span>
        <input inputMode="decimal" dir="ltr" value={amount} required autoComplete="off" onChange={(event) => change(setAmount)(event.target.value)} />
        {cashLike && spends ? <small>{fa ? "موجود در این صندوق: " : "Available in this Safe: "}<span dir="ltr">{money(safe.balance.book, safe.currencyCode)}</span></small> : null}
        {overdraws ? <small className="money-over" role="status">{fa ? "این مبلغ بیشتر از موجودی صندوق است؛ صندوق زیر صفر نمی‌رود." : "This is more than the Safe holds; a Safe cannot go below zero."}</small> : null}</label>
      <label><span>{fa ? "واحد پول" : "Currency"}</span><input dir="ltr" value={safe.currencyCode} readOnly aria-readonly="true" /></label>
      <label><span>{fa ? "تاریخ *" : "Date *"}</span>
        <input type="date" dir="ltr" value={date} max={options.today} required onChange={(event) => change(setDate)(event.target.value)} /></label>
      <FxConversionField currency={safe.currencyCode} baseCurrency={options.baseCurrency} date={date} amount={amount} fa={fa} onChange={setFx} />
      <label><span>{kind === "pay" && payFor === "expense" ? (fa ? "مرجع *" : "Reference *") : (fa ? "مرجع (اختیاری)" : "Reference (optional)")}</span>
        <input value={reference} maxLength={120} onChange={(event) => change(setReference)(event.target.value)} /></label>
      <label className="wide"><span>{fa ? "یادداشت (اختیاری)" : "Note (optional)"}</span>
        <textarea value={note} maxLength={1000} rows={2} onChange={(event) => change(setNote)(event.target.value)} /></label>
      {settingNotice ? <p className="admin-hint expense-warning wide" role="status">{settingNotice}</p> : null}
      {error ? <p className="treasury-message error wide" role="alert">{error}</p> : null}
      <div className="admin-form-actions wide">
        <button className="treasury-button gold" type="submit" disabled={busy || !valid}>{busy ? (fa ? "در حال ذخیره…" : "Saving…") : (fa ? "ذخیره" : "Save")}</button>
        <button className="treasury-button" type="button" onClick={close} disabled={busy}>{fa ? "لغو" : "Cancel"}</button>
      </div>
    </form>
  );
}
