"use client";

import type {
  OperationalExpenseEntryOptions,
  OperationalExpenseMutationResult,
  OperationalExpenseView
} from "@abos/contracts";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { AccessGate, api } from "@/components/AdminUsersWorkspace";
import { AppIcon } from "@/components/AppIcon";
import { useLocale } from "@/components/LocaleProvider";
import {
  exactAmount,
  expenseErrorText,
  kabulToday,
  localizedName,
  money
} from "@/components/OperationalFinanceShared";
import { StageZeroPageHeader } from "@/components/StageZeroWorkspace";

interface Draft {
  readonly businessDate: string;
  readonly treasuryAccountId: string;
  readonly expenseCategoryId: string;
  readonly originalAmount: string;
  readonly exchangeRateId: string;
  readonly payeeBusinessPartyId: string;
  readonly projectId: string;
  readonly departmentId: string;
  readonly costCenterId: string;
  readonly reference: string;
  readonly description: string;
  readonly note: string;
}

const EMPTY: Omit<Draft, "businessDate"> = {
  treasuryAccountId: "", expenseCategoryId: "", originalAmount: "", exchangeRateId: "",
  payeeBusinessPartyId: "", projectId: "", departmentId: "", costCenterId: "",
  reference: "", description: "", note: ""
};

const AMOUNT = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;

/** One request identity per filled-in form: a retry of the same details is replayed, never doubled. */
function newRequestIdentity(): { readonly idempotencyKey: string; readonly correlationId: string } {
  return { idempotencyKey: `expense-${crypto.randomUUID()}`, correlationId: crypto.randomUUID() };
}

export function RecordExpenseWorkspace() {
  const { locale } = useLocale();
  const fa = locale === "fa";
  const [draft, setDraft] = useState<Draft>({ businessDate: kabulToday(), ...EMPTY });
  const [options, setOptions] = useState<OperationalExpenseEntryOptions | null>(null);
  const [gate, setGate] = useState<"signed-out" | "denied" | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recorded, setRecorded] = useState<OperationalExpenseView | null>(null);
  const [identity, setIdentity] = useState(newRequestIdentity);

  const load = useCallback(async (date: string) => {
    const result = await api<OperationalExpenseEntryOptions>(
      `/api/v1/finance/operations/expense-options?date=${encodeURIComponent(date)}`);
    if (!result.ok) {
      setGate(result.status === 401 ? "signed-out" : result.status === 403 ? "denied" : null);
      if (result.status !== 401 && result.status !== 403) setLoadError(expenseErrorText(result.error, locale));
      return;
    }
    setGate(null);
    setLoadError(null);
    setOptions(result.data);
  }, [locale]);

  useEffect(() => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.businessDate)) return;
    let current = true;
    void api<OperationalExpenseEntryOptions>(
      `/api/v1/finance/operations/expense-options?date=${encodeURIComponent(draft.businessDate)}`
    ).then((result) => {
      if (!current) return;
      if (!result.ok) {
        setGate(result.status === 401 ? "signed-out" : result.status === 403 ? "denied" : null);
        if (result.status !== 401 && result.status !== 403) setLoadError(expenseErrorText(result.error, locale));
        return;
      }
      setGate(null);
      setLoadError(null);
      setOptions(result.data);
    });
    return () => { current = false; };
  }, [draft.businessDate, locale]);

  const account = options?.treasuryAccounts.find((item) => item.id === draft.treasuryAccountId);
  const category = options?.expenseCategories.find((item) => item.id === draft.expenseCategoryId);
  const base = options?.baseCurrency ?? null;
  const currency = account?.currencyCode ?? null;
  const foreign = currency !== null && base !== null && currency !== base;
  const rates = useMemo(() => (options?.exchangeRates ?? []).filter((rate) =>
    currency !== null && base !== null
      && [rate.unitCurrency, rate.quoteCurrency].includes(currency)
      && [rate.unitCurrency, rate.quoteCurrency].includes(base)), [options, currency, base]);
  const chosenRateId = foreign ? (rates.length === 1 ? rates[0]?.id ?? "" : draft.exchangeRateId) : "";
  const needs = {
    project: Boolean(account?.requiresProject || category?.requiresProject),
    department: Boolean(account?.requiresDepartment || category?.requiresDepartment),
    costCenter: Boolean(account?.requiresCostCenter || category?.requiresCostCenter)
  };

  const update = (changes: Partial<Draft>) => {
    setDraft((value) => ({ ...value, ...changes }));
    setIdentity(newRequestIdentity());
    setError(null);
  };

  if (gate) {
    return <div className="module-workspace"><AccessGate state={gate} fa={fa} what={{
      en: "Recording expenses needs the Finance role that records daily expenses.",
      fa: "ثبت مصارف به نقش مالی ثبت مصارف روزانه نیاز دارد."
    }} /></div>;
  }

  const setupGaps: string[] = [];
  if (options) {
    if (!options.policyConfigured) setupGaps.push(fa ? "تنظیم تأیید مصارف هنوز انتخاب نشده است (مدیر سیستم)." : "The expense approval setting has not been chosen yet (System Administrator).");
    if (!options.baseCurrency) setupGaps.push(fa ? "واحد پول پایه شرکت هنوز تصویب نشده است." : "The company's base currency is not approved yet.");
    if (options.treasuryAccounts.length === 0) setupGaps.push(fa ? "هیچ حساب خزانه فعالی (صندوق، بانک یا صراف) تنظیم نشده است." : "No active Treasury account (safe, bank or Saraf) is set up.");
    if (options.expenseCategories.length === 0) setupGaps.push(fa ? "هیچ دسته مصرف فعالی تنظیم نشده است." : "No active expense category is set up.");
  }
  const periodClosed = options !== null && options.openPeriod === null;
  const rateMissing = foreign && rates.length === 0;
  const dimensionMissing = (needs.project && (options?.projects.length ?? 0) === 0)
    || (needs.department && (options?.departments.length ?? 0) === 0)
    || (needs.costCenter && (options?.costCenters.length ?? 0) === 0);
  const amountValid = AMOUNT.test(draft.originalAmount.trim()) && /[1-9]/.test(draft.originalAmount);
  const ready = options !== null && setupGaps.length === 0 && !periodClosed && !rateMissing && !dimensionMissing
    && account !== undefined && category !== undefined && amountValid
    && draft.reference.trim().length > 0 && draft.description.trim().length >= 3
    && (!foreign || chosenRateId !== "")
    && (!needs.project || draft.projectId !== "") && (!needs.department || draft.departmentId !== "")
    && (!needs.costCenter || draft.costCenterId !== "");

  const submit = async () => {
    if (!ready || !account) return;
    setBusy(true);
    setError(null);
    const result = await api<OperationalExpenseMutationResult>("/api/v1/finance/operations/expenses", "POST", {
      treasuryAccountId: draft.treasuryAccountId,
      expenseCategoryId: draft.expenseCategoryId,
      payeeBusinessPartyId: draft.payeeBusinessPartyId || null,
      projectId: draft.projectId || null,
      departmentId: draft.departmentId || null,
      costCenterId: draft.costCenterId || null,
      reference: draft.reference.trim(),
      description: draft.description.trim(),
      note: draft.note.trim() || null,
      businessDate: draft.businessDate,
      originalAmount: draft.originalAmount.trim(),
      currencyCode: account.currencyCode,
      exchangeRateId: foreign ? chosenRateId : null,
      ...identity
    });
    setBusy(false);
    if (!result.ok) {
      // A network failure leaves the outcome unknown: keep the same request identity so that
      // trying again replays the recorded result instead of recording the expense twice.
      if (result.status === 401) setGate("signed-out");
      setError(expenseErrorText(result.error, locale));
      return;
    }
    setRecorded(result.data.expense);
    setDraft((value) => ({ ...value, ...EMPTY, treasuryAccountId: value.treasuryAccountId,
      expenseCategoryId: value.expenseCategoryId }));
    setIdentity(newRequestIdentity());
    await load(draft.businessDate);
  };

  const choose = (label: string, value: string, onChange: (value: string) => void,
    items: readonly { id: string; label: string }[], required: boolean, placeholder: string) => (
    <label><span>{label}{required ? " *" : ""}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)} required={required}>
        <option value="">{placeholder}</option>
        {items.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
      </select></label>
  );

  return (
    <div className="module-workspace expense-workspace">
      <StageZeroPageHeader icon="coins"
        eyebrow={{ en: "Finance · Daily work", fa: "مالی · کار روزانه" }}
        title={{ en: "Record expense", fa: "ثبت مصرف" }}
        description={{
          en: "Record money paid out from a safe, bank or Saraf account. The Treasury balance and the books update when it is recorded.",
          fa: "پولی را که از صندوق، بانک یا حساب صراف پرداخت شده ثبت کنید. با ثبت آن، موجودی خزانه و دفاتر به‌روز می‌شوند."
        }} />

      {recorded ? (
        <div className="treasury-message success" role="status">
          <AppIcon name="shield" size={16} />
          <span>{recorded.status === "POSTED"
            ? (fa ? `مصرف ثبت شد: ${money(recorded.originalAmount, recorded.originalCurrency)} از ${localizedName({ nameEn: recorded.treasuryAccountNameEn, nameFa: recorded.treasuryAccountNameFa }, fa)}.`
              : `Expense recorded: ${money(recorded.originalAmount, recorded.originalCurrency)} from ${recorded.treasuryAccountNameEn}.`)
            : (fa ? "مصرف برای تأیید فرستاده شد. تا تأیید نشود، موجودی خزانه تغییر نمی‌کند."
              : "Expense sent for approval. The Treasury balance does not change until it is approved.")}
            {" "}<Link href="/finance/transactions">{fa ? "دیدن معاملات روزانه" : "See daily transactions"}</Link></span>
          <button onClick={() => setRecorded(null)} aria-label={fa ? "بستن" : "Dismiss"}>×</button>
        </div>
      ) : null}
      {error ? <div className="treasury-message error" role="alert"><AppIcon name="alert" size={16} /><span>{error}</span><button onClick={() => setError(null)} aria-label={fa ? "بستن" : "Dismiss"}>×</button></div> : null}
      {loadError ? <div className="treasury-message error" role="alert"><AppIcon name="alert" size={16} /><span>{loadError}</span></div> : null}

      {options === null ? <p className="treasury-placeholder">{fa ? "در حال بارگذاری…" : "Loading…"}</p> : (
        <section className="module-content-card expense-entry">
          {setupGaps.length > 0 ? (
            <div className="state-panel" role="status">
              <span className="state-panel-icon" aria-hidden="true">!</span>
              <div><h3>{fa ? "ثبت مصارف هنوز آماده نیست" : "Expense recording is not ready yet"}</h3>
                <ul className="expense-gaps">{setupGaps.map((gap) => <li key={gap}>{gap}</li>)}</ul></div>
            </div>
          ) : null}

          <form className="admin-form expense-form" aria-label={fa ? "ثبت مصرف" : "Record expense"}
            onSubmit={(event) => { event.preventDefault(); void submit(); }}>
            <label><span>{fa ? "تاریخ *" : "Date *"}</span>
              <input type="date" value={draft.businessDate} required
                onChange={(event) => update({ businessDate: event.target.value, exchangeRateId: "" })} /></label>
            {periodClosed ? <p className="admin-hint expense-warning" role="status">{fa ? "این تاریخ در یک دوره حسابداری باز نیست." : "This date is not in an open accounting period."}</p> : null}

            {choose(fa ? "پرداخت از" : "Paid from", draft.treasuryAccountId,
              (value) => update({ treasuryAccountId: value, exchangeRateId: "" }),
              options.treasuryAccounts.map((item) => ({ id: item.id, label: `${localizedName(item, fa)} · ${item.currencyCode}` })),
              true, fa ? "حساب خزانه را انتخاب کنید" : "Choose a Treasury account")}
            {choose(fa ? "نوع مصرف" : "Expense type", draft.expenseCategoryId,
              (value) => update({ expenseCategoryId: value }),
              options.expenseCategories.map((item) => ({ id: item.id, label: localizedName(item, fa) })),
              true, fa ? "نوع مصرف را انتخاب کنید" : "Choose an expense type")}

            <label><span>{fa ? `مبلغ${currency ? ` (${currency})` : ""} *` : `Amount${currency ? ` (${currency})` : ""} *`}</span>
              <input inputMode="decimal" dir="ltr" autoComplete="off" value={draft.originalAmount} placeholder="0.00" required
                onChange={(event) => update({ originalAmount: event.target.value })} /></label>
            {draft.originalAmount.trim() !== "" && !amountValid
              ? <p className="admin-hint expense-warning">{fa ? "مبلغ را فقط با رقم و نقطه اعشار بنویسید، مثلاً 1250.50" : "Use digits and a decimal point only, for example 1250.50"}</p> : null}

            {foreign ? (rateMissing ? (
              <p className="admin-hint expense-warning" role="status">{fa
                ? `برای ${draft.businessDate} نرخ ${base}/${currency} ثبت نشده است. ابتدا نرخ همان روز باید ثبت شود.`
                : `No ${base}/${currency} rate is recorded for ${draft.businessDate}. The day's rate must be recorded first.`}</p>
            ) : rates.length === 1 && rates[0] ? (
              <p className="admin-hint" dir="ltr">{fa ? "نرخ روز: " : "Day's rate: "}1 {rates[0].unitCurrency} = {exactAmount(rates[0].rate)} {rates[0].quoteCurrency}</p>
            ) : (
              <fieldset className="admin-status-choice">
                <legend>{fa ? "نرخ این معامله *" : "Rate for this expense *"}</legend>
                {rates.map((rate) => (
                  <label key={rate.id}><input type="radio" name="expense-rate" checked={draft.exchangeRateId === rate.id}
                    onChange={() => update({ exchangeRateId: rate.id })} />
                    <span dir="ltr">1 {rate.unitCurrency} = {exactAmount(rate.rate)} {rate.quoteCurrency}</span>
                    {" · "}{rate.rateSource === "SARAF" ? `${fa ? "صراف" : "Saraf"}${rate.sarafName ? ` ${rate.sarafName}` : ""}` : (fa ? "بازار" : "Market")}</label>
                ))}
              </fieldset>
            )) : null}
            {foreign && !rateMissing ? <p className="admin-hint">{fa ? `معادل ${base} هنگام ثبت دقیقاً با همین نرخ محاسبه می‌شود.` : `The ${base} equivalent is calculated exactly at this rate when you record.`}</p> : null}

            {choose(fa ? "پرداخت به (اختیاری)" : "Paid to (optional)", draft.payeeBusinessPartyId,
              (value) => update({ payeeBusinessPartyId: value }),
              options.payees.map((item) => ({ id: item.id, label: item.name })), false, fa ? "—" : "—")}
            {needs.project || options.projects.length > 0 ? choose(fa ? "پروژه" : "Project", draft.projectId,
              (value) => update({ projectId: value }),
              options.projects.map((item) => ({ id: item.id, label: `${item.code} · ${item.name}` })), needs.project, "—") : null}
            {needs.department || options.departments.length > 0 ? choose(fa ? "بخش" : "Department", draft.departmentId,
              (value) => update({ departmentId: value }),
              options.departments.map((item) => ({ id: item.id, label: `${item.code} · ${item.name}` })), needs.department, "—") : null}
            {needs.costCenter || options.costCenters.length > 0 ? choose(fa ? "مرکز هزینه" : "Cost center", draft.costCenterId,
              (value) => update({ costCenterId: value }),
              options.costCenters.map((item) => ({ id: item.id, label: `${item.code} · ${item.name}` })), needs.costCenter, "—") : null}
            {dimensionMissing ? <p className="admin-hint expense-warning" role="status">{fa
              ? "این حساب یا نوع مصرف به پروژه، بخش یا مرکز هزینه نیاز دارد، اما چنین دسترسی‌ای به شما داده نشده است."
              : "This account or expense type needs a project, department or cost center, but none is assigned to you."}</p> : null}

            <label><span>{fa ? "شماره رسید یا مرجع *" : "Receipt or reference number *"}</span>
              <input value={draft.reference} maxLength={120} required onChange={(event) => update({ reference: event.target.value })} /></label>
            <label><span>{fa ? "برای چه بود؟ *" : "What was it for? *"}</span>
              <input value={draft.description} minLength={3} maxLength={500} required onChange={(event) => update({ description: event.target.value })} /></label>
            <label><span>{fa ? "یادداشت (اختیاری)" : "Note (optional)"}</span>
              <textarea value={draft.note} maxLength={1000} rows={2} onChange={(event) => update({ note: event.target.value })} /></label>

            <button type="submit" className="treasury-button gold" disabled={busy || !ready}>
              {busy ? (fa ? "در حال ثبت…" : "Recording…")
                : options.approvalRequired ? (fa ? "فرستادن برای تأیید" : "Send for approval")
                  : (fa ? "ثبت مصرف" : "Record expense")}
            </button>
          </form>
        </section>
      )}
    </div>
  );
}
