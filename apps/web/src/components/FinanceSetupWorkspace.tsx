"use client";

import {
  OPERATIONAL_TREASURY_ACCOUNT_TYPES,
  type FinanceWorkflowPolicyWorkspace,
  type OperationalExpenseEntryOptions,
  type OperationalAccountingPeriodView,
  type OperationalExpenseCategoryView,
  type OperationalFinanceConfigurationWorkspace,
  type OperationalTreasuryAccountType,
  type OperationalTreasuryAccountView
} from "@abos/contracts";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { AccessGate, api } from "@/components/AdminUsersWorkspace";
import { AppIcon } from "@/components/AppIcon";
import { useLocale } from "@/components/LocaleProvider";
import { kabulToday, localizedName } from "@/components/OperationalFinanceShared";
import { StageZeroPageHeader } from "@/components/StageZeroWorkspace";
import type { Copy } from "@/lib/access-copy";

const ACCOUNT_TYPE_COPY: Readonly<Record<OperationalTreasuryAccountType, Copy>> = {
  SAFE: { en: "Safe", fa: "صندوق" },
  CASH_BOX: { en: "Cash box", fa: "صندوقچه نقدی" },
  PETTY_CASH: { en: "Petty cash", fa: "تنخواه" },
  BANK: { en: "Bank account", fa: "حساب بانکی" },
  SARAF: { en: "Saraf account", fa: "حساب صراف" },
  OTHER: { en: "Other cash account", fa: "حساب نقدی دیگر" }
};

const PERIOD_STATUS_COPY: Readonly<Record<OperationalAccountingPeriodView["status"], Copy>> = {
  PENDING: { en: "Not open yet", fa: "هنوز باز نشده" },
  OPEN: { en: "Open", fa: "باز" },
  SOFT_CLOSED: { en: "Closing", fa: "در حال بستن" },
  CLOSED: { en: "Closed", fa: "بسته" }
};

/** Dari for the set-up refusals the server returns (codes from operationalFinanceErrorResponse). */
const SETUP_ERROR_FA: Readonly<Record<string, string>> = {
  CASH_ACCOUNT_REQUIRED: "صندوق، صندوقچه یا حساب بانکی را به یک حساب نقدی فعال در جدول حساب‌ها وصل کنید.",
  SARAF_ACCOUNT_REQUIRED: "حساب صراف را به یک حساب صراف فعال در جدول حساب‌ها وصل کنید.",
  SARAF_PARTY_REQUIRED: "یک صراف فعال برای این حساب انتخاب کنید.",
  LEDGER_CURRENCY_MISMATCH: "حساب جدول حساب‌ها باید همان واحد پول حساب خزانه را داشته باشد.",
  LEDGER_NOT_POSTABLE: "حساب جدول حساب‌ها باید فعال و قابل ثبت باشد.",
  TREASURY_ACCOUNT_FIXED: "نوع، واحد پول، حساب وصل‌شده و صراف یک حساب خزانه پس از ذخیره تغییر نمی‌کند.",
  EXPENSE_ACCOUNT_REQUIRED: "نوع مصرف را به یک حساب مصرف فعال در جدول حساب‌ها وصل کنید.",
  EXPENSE_TYPE_FIXED: "کد و حساب وصل‌شده یک نوع مصرف پس از ذخیره تغییر نمی‌کند.",
  PERIOD_NOT_PENDING: "فقط دوره‌ای که هنوز باز نشده است را می‌توان باز کرد.",
  STALE_VERSION: "کس دیگری در این میان آن را تغییر داده است. دوباره بارگذاری کنید و تلاش کنید.",
  NOT_FOUND: "این مورد برای شرکت شما پیدا نشد.",
  DUPLICATE: "این حساب، کد یا اتصال قبلاً استفاده شده است.",
  VALIDATION_FAILED: "جزئیات وارد‌شده کامل یا درست نیست.",
  AUTHENTICATION_REQUIRED: "جلسه شما پایان یافته است. دوباره وارد شوید.",
  PERMISSION_DENIED: "شما صلاحیت این کار را ندارید.",
  NETWORK: "سرور در دسترس نیست. دوباره تلاش کنید."
};

function setupErrorText(error: { code: string; message: string }, fa: boolean): string {
  if (fa) return SETUP_ERROR_FA[error.code] ?? "درخواست رد شد.";
  return error.message;
}

interface AccountDraft {
  readonly id: string | null;
  readonly version: number;
  readonly nameEn: string;
  readonly nameFa: string;
  readonly accountType: OperationalTreasuryAccountType;
  readonly currencyCode: string;
  readonly ledgerAccountId: string;
  readonly sarafBusinessPartyId: string;
  readonly externalReference: string;
  readonly status: "ACTIVE" | "INACTIVE";
}

interface CategoryDraft {
  readonly id: string | null;
  readonly version: number;
  readonly categoryCode: string;
  readonly nameEn: string;
  readonly nameFa: string;
  readonly ledgerAccountId: string;
  readonly status: "ACTIVE" | "INACTIVE";
}

const NEW_ACCOUNT: AccountDraft = {
  id: null, version: 0, nameEn: "", nameFa: "", accountType: "SAFE", currencyCode: "", ledgerAccountId: "",
  sarafBusinessPartyId: "", externalReference: "", status: "ACTIVE"
};
const NEW_CATEGORY: CategoryDraft = {
  id: null, version: 0, categoryCode: "", nameEn: "", nameFa: "", ledgerAccountId: "", status: "ACTIVE"
};

export function FinanceSetupWorkspace() {
  const { locale } = useLocale();
  const fa = locale === "fa";
  const [view, setView] = useState<OperationalFinanceConfigurationWorkspace | null>(null);
  const [approval, setApproval] = useState<"OFF" | "ON" | "NOT_SET" | "UNKNOWN">("UNKNOWN");
  const [gate, setGate] = useState<"signed-out" | "denied" | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [account, setAccount] = useState<AccountDraft | null>(null);
  const [category, setCategory] = useState<CategoryDraft | null>(null);
  const [opening, setOpening] = useState<{ id: string; reason: string } | null>(null);

  const apply = useCallback((result: Awaited<ReturnType<typeof api<OperationalFinanceConfigurationWorkspace>>>) => {
    if (!result.ok) {
      setGate(result.status === 401 ? "signed-out" : result.status === 403 ? "denied" : null);
      if (result.status !== 401 && result.status !== 403) setMessage({ tone: "error", text: setupErrorText(result.error, fa) });
      return false;
    }
    setGate(null);
    setView(result.data);
    return true;
  }, [fa]);

  const reload = useCallback(async () => {
    apply(await api<OperationalFinanceConfigurationWorkspace>("/api/v1/finance/operations/configuration"));
  }, [apply]);

  useEffect(() => {
    let current = true;
    void api<OperationalFinanceConfigurationWorkspace>("/api/v1/finance/operations/configuration").then((result) => {
      if (current) apply(result);
    });
    // The approval setting belongs to System Administration; it is shown here only when readable.
    // Otherwise it is read from the Record Expense options, which anyone who records expenses can see.
    void (async () => {
      const admin = await api<FinanceWorkflowPolicyWorkspace>("/api/v1/admin/finance-workflows");
      if (!current) return;
      if (admin.ok) {
        const expense = admin.data.policies.find((policy) => policy.workflowType === "EXPENSE");
        setApproval(expense?.approvalRequired === undefined || expense.approvalRequired === null ? "NOT_SET"
          : expense.approvalRequired ? "ON" : "OFF");
        return;
      }
      const entry = await api<OperationalExpenseEntryOptions>(
        `/api/v1/finance/operations/expense-options?date=${encodeURIComponent(kabulToday())}`);
      if (!current || !entry.ok) return;
      setApproval(!entry.data.policyConfigured ? "NOT_SET" : entry.data.approvalRequired ? "ON" : "OFF");
    })();
    return () => { current = false; };
  }, [apply]);

  if (gate) {
    return <div className="module-workspace"><AccessGate state={gate} fa={fa} what={{
      en: "Finance setup needs one of: set up Treasury accounts, set up expense types, or open accounting periods.",
      fa: "تنظیمات مالی به یکی از این صلاحیت‌ها نیاز دارد: تنظیم حساب‌های خزانه، تنظیم انواع مصرف یا باز کردن دوره‌های حسابداری."
    }} /></div>;
  }

  const done = async (ok: boolean, text: string) => {
    if (!ok) return;
    setMessage({ tone: "ok", text });
    await reload();
  };

  const saveAccount = async () => {
    if (!account) return;
    setBusy(true); setMessage(null);
    const result = await api<OperationalFinanceConfigurationWorkspace>("/api/v1/finance/operations/treasury-accounts", "PUT", {
      ...(account.id ? { id: account.id } : {}),
      nameEn: account.nameEn.trim(), nameFa: account.nameFa.trim() || null, accountType: account.accountType,
      currencyCode: account.currencyCode, ledgerAccountId: account.ledgerAccountId,
      sarafBusinessPartyId: account.accountType === "SARAF" ? account.sarafBusinessPartyId || null : null,
      externalReference: account.externalReference.trim() || null, status: account.status, expectedVersion: account.version
    });
    setBusy(false);
    if (!result.ok) { setMessage({ tone: "error", text: setupErrorText(result.error, fa) }); return; }
    setAccount(null);
    await done(true, fa ? "حساب خزانه ذخیره شد." : "Treasury account saved.");
  };

  const saveCategory = async () => {
    if (!category) return;
    setBusy(true); setMessage(null);
    const result = await api<OperationalFinanceConfigurationWorkspace>("/api/v1/finance/operations/expense-categories", "PUT", {
      ...(category.id ? { id: category.id } : {}),
      categoryCode: category.categoryCode.trim(), nameEn: category.nameEn.trim(), nameFa: category.nameFa.trim() || null,
      ledgerAccountId: category.ledgerAccountId, status: category.status, expectedVersion: category.version
    });
    setBusy(false);
    if (!result.ok) { setMessage({ tone: "error", text: setupErrorText(result.error, fa) }); return; }
    setCategory(null);
    await done(true, fa ? "نوع مصرف ذخیره شد." : "Expense type saved.");
  };

  const openPeriod = async (period: OperationalAccountingPeriodView) => {
    if (!opening) return;
    setBusy(true); setMessage(null);
    const result = await api<OperationalFinanceConfigurationWorkspace>(`/api/v1/finance/operations/periods/${period.id}/open`, "POST", {
      expectedVersion: period.version, reason: opening.reason.trim()
    });
    setBusy(false);
    if (!result.ok) { setMessage({ tone: "error", text: setupErrorText(result.error, fa) }); return; }
    setOpening(null);
    await done(true, fa ? "دوره حسابداری باز شد." : "Accounting period opened.");
  };

  const ledgerChoices = view === null || account === null ? [] : view.options.treasuryLedgerAccounts.filter((ledger) =>
    ledger.controlType === (account.accountType === "SARAF" ? "SARAF" : "CASH")
    && (account.currencyCode === "" || ledger.currencyCode === account.currencyCode));
  const accountValid = account !== null && account.nameEn.trim().length >= 2 && account.currencyCode !== ""
    && account.ledgerAccountId !== "" && (account.accountType !== "SARAF" || account.sarafBusinessPartyId !== "");
  const categoryValid = category !== null && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,31}$/.test(category.categoryCode.trim())
    && category.nameEn.trim().length >= 2 && category.ledgerAccountId !== "";

  const checklist: { readonly ok: boolean | null; readonly text: string; readonly href?: string; readonly link?: string }[] = view === null ? [] : [
    { ok: view.legalEntity.baseCurrency !== null,
      text: view.legalEntity.baseCurrency ? (fa ? `واحد پول پایه: ${view.legalEntity.baseCurrency}` : `Base currency: ${view.legalEntity.baseCurrency}`)
        : (fa ? "واحد پول پایه شرکت هنوز تصویب نشده است." : "The company's base currency is not approved yet.") },
    { ok: approval === "UNKNOWN" ? null : approval === "OFF" || approval === "ON",
      text: approval === "OFF" ? (fa ? "تأیید مصارف: خاموش — مصارف فوراً ثبت می‌شوند." : "Expense approval: OFF — expenses are recorded at once.")
        : approval === "ON" ? (fa ? "تأیید مصارف: روشن — هر مصرف به تأیید شخص دیگری نیاز دارد." : "Expense approval: ON — each expense needs another person's approval.")
          : approval === "NOT_SET" ? (fa ? "تنظیم تأیید مصارف هنوز انتخاب نشده است." : "The expense approval setting has not been chosen yet.")
            : (fa ? "تنظیم تأیید مصارف را مدیر سیستم در «تأیید جریان‌ها» انتخاب می‌کند." : "A System Administrator chooses the expense approval setting in Workflow approvals."),
      href: "/admin/finance-workflows", link: fa ? "تأیید جریان‌ها" : "Workflow approvals" },
    { ok: view.treasuryAccounts.some((item) => item.status === "ACTIVE"),
      text: view.options.treasuryLedgerAccounts.length === 0
        ? (fa ? "ابتدا در جدول حساب‌ها یک حساب نقدی (یا صراف) قابل ثبت بسازید." : "First add a postable cash (or Saraf) account in the Chart of Accounts.")
        : (fa ? `حساب‌های خزانه فعال: ${view.treasuryAccounts.filter((item) => item.status === "ACTIVE").length}` : `Active Treasury accounts: ${view.treasuryAccounts.filter((item) => item.status === "ACTIVE").length}`),
      href: "/finance/accounts", link: fa ? "جدول حساب‌ها" : "Chart of Accounts" },
    { ok: view.expenseCategories.some((item) => item.status === "ACTIVE"),
      text: view.options.expenseLedgerAccounts.length === 0
        ? (fa ? "ابتدا در جدول حساب‌ها یک حساب مصرف قابل ثبت بسازید." : "First add a postable expense account in the Chart of Accounts.")
        : (fa ? `انواع مصرف فعال: ${view.expenseCategories.filter((item) => item.status === "ACTIVE").length}` : `Active expense types: ${view.expenseCategories.filter((item) => item.status === "ACTIVE").length}`),
      href: "/finance/accounts", link: fa ? "جدول حساب‌ها" : "Chart of Accounts" },
    { ok: view.periods.some((item) => item.status === "OPEN"),
      text: view.periods.length === 0
        ? (fa ? "هنوز سال مالی ایجاد نشده است؛ آن را در «تقویم مالی» ایجاد کنید." : "No financial year has been generated yet; generate it in Financial calendar.")
        : view.periods.some((item) => item.status === "OPEN") ? (fa ? "دست‌کم یک دوره حسابداری باز است." : "At least one accounting period is open.")
          : (fa ? "هیچ دوره حسابداری باز نیست؛ دوره جاری را پایین‌تر باز کنید." : "No accounting period is open; open the current period below."),
      href: "/finance/calendar", link: fa ? "تقویم مالی" : "Financial calendar" }
  ];

  return (
    <div className="module-workspace setup-workspace">
      <StageZeroPageHeader icon="settings"
        eyebrow={{ en: `Finance · ${view?.legalEntity.name ?? ""}`, fa: `مالی · ${view?.legalEntity.name ?? ""}` }}
        title={{ en: "Finance setup", fa: "تنظیمات مالی" }}
        description={{
          en: "The Treasury accounts money is paid from, the expense types people choose, and the accounting periods that are open for recording.",
          fa: "حساب‌های خزانه‌ای که از آن‌ها پرداخت می‌شود، انواع مصرفی که افراد انتخاب می‌کنند، و دوره‌های حسابداری که برای ثبت باز هستند."
        }} />

      {message ? <div className={`treasury-message ${message.tone === "ok" ? "success" : "error"}`} role="status"><AppIcon name={message.tone === "ok" ? "shield" : "alert"} size={16} /><span>{message.text}</span><button onClick={() => setMessage(null)} aria-label={fa ? "بستن" : "Dismiss"}>×</button></div> : null}

      {view === null ? <p className="treasury-placeholder">{fa ? "در حال بارگذاری…" : "Loading…"}</p> : (
        <>
          <section className="module-content-card">
            <div className="module-card-heading"><div><p>{fa ? "آمادگی" : "READINESS"}</p><h2>{fa ? "برای ثبت مصارف لازم است" : "Needed before expenses can be recorded"}</h2></div></div>
            <ul className="setup-checklist">{checklist.map((item) => (
              <li key={item.text} className={item.ok === null ? "info" : item.ok ? "ready" : "missing"}>
                <span aria-hidden="true">{item.ok === null ? "i" : item.ok ? "✓" : "!"}</span>
                <span>{item.text}{item.href && item.ok === false ? <> {" "}<Link href={item.href}>{item.link}</Link></> : null}</span>
              </li>
            ))}</ul>
          </section>

          <section className="module-content-card">
            <div className="module-card-heading"><div><p>{fa ? "خزانه" : "TREASURY"}</p><h2>{fa ? "حساب‌های پرداخت" : "Accounts money is paid from"}</h2></div>
              {view.permissions.canManageTreasuryAccounts && account === null
                ? <button type="button" className="treasury-button gold" onClick={() => setAccount({ ...NEW_ACCOUNT, currencyCode: view.legalEntity.baseCurrency ?? "" })}>{fa ? "افزودن حساب" : "Add account"}</button> : null}</div>
            {account ? (
              <form className="admin-form expense-form" aria-label={fa ? "حساب خزانه" : "Treasury account"} onSubmit={(event) => { event.preventDefault(); void saveAccount(); }}>
                <label><span>{fa ? "نام (انگلیسی) *" : "Name (English) *"}</span><input value={account.nameEn} maxLength={120} required onChange={(event) => setAccount({ ...account, nameEn: event.target.value })} /></label>
                <label><span>{fa ? "نام (دری)" : "Name (Dari)"}</span><input value={account.nameFa} maxLength={120} dir="rtl" onChange={(event) => setAccount({ ...account, nameFa: event.target.value })} /></label>
                <label><span>{fa ? "نوع *" : "Type *"}</span>
                  <select value={account.accountType} disabled={account.id !== null} onChange={(event) => setAccount({ ...account, accountType: event.target.value as OperationalTreasuryAccountType, ledgerAccountId: "", sarafBusinessPartyId: "" })}>
                    {OPERATIONAL_TREASURY_ACCOUNT_TYPES.map((type) => <option key={type} value={type}>{ACCOUNT_TYPE_COPY[type][locale]}</option>)}
                  </select></label>
                <label><span>{fa ? "واحد پول *" : "Currency *"}</span>
                  <select value={account.currencyCode} disabled={account.id !== null} onChange={(event) => setAccount({ ...account, currencyCode: event.target.value, ledgerAccountId: "" })}>
                    <option value="">—</option>
                    {["USD", "AFN"].map((code) => <option key={code} value={code}>{code}</option>)}
                  </select></label>
                <label><span>{fa ? "حساب در جدول حساب‌ها *" : "Chart of Accounts account *"}</span>
                  <select value={account.ledgerAccountId} disabled={account.id !== null} required onChange={(event) => setAccount({ ...account, ledgerAccountId: event.target.value })}>
                    <option value="">{fa ? "انتخاب کنید" : "Choose"}</option>
                    {(account.id !== null ? view.treasuryAccounts.filter((item) => item.id === account.id).map((item) => ({ id: item.ledgerAccountId, code: item.ledgerAccountCode, name: item.ledgerAccountName })) : ledgerChoices)
                      .map((ledger) => <option key={ledger.id} value={ledger.id}>{ledger.code} · {ledger.name}</option>)}
                  </select></label>
                {account.id === null && ledgerChoices.length === 0 ? <p className="admin-hint expense-warning">{fa
                  ? `هیچ حساب ${account.accountType === "SARAF" ? "صراف" : "نقدی"} قابل ثبت${account.currencyCode ? ` به ${account.currencyCode}` : ""} در جدول حساب‌ها نیست.`
                  : `No postable ${account.accountType === "SARAF" ? "Saraf" : "cash"} account${account.currencyCode ? ` in ${account.currencyCode}` : ""} exists in the Chart of Accounts.`}</p> : null}
                {account.accountType === "SARAF" ? (
                  <label><span>{fa ? "صراف *" : "Saraf *"}</span>
                    <select value={account.sarafBusinessPartyId} disabled={account.id !== null} required onChange={(event) => setAccount({ ...account, sarafBusinessPartyId: event.target.value })}>
                      <option value="">{fa ? "انتخاب کنید" : "Choose"}</option>
                      {view.options.sarafs.map((saraf) => <option key={saraf.id} value={saraf.id}>{saraf.name}</option>)}
                    </select></label>
                ) : null}
                <label><span>{fa ? "شماره حساب یا مرجع (اختیاری)" : "Account number or reference (optional)"}</span><input value={account.externalReference} maxLength={120} onChange={(event) => setAccount({ ...account, externalReference: event.target.value })} /></label>
                {account.id !== null ? (
                  <label><span>{fa ? "وضعیت" : "Status"}</span>
                    <select value={account.status} onChange={(event) => setAccount({ ...account, status: event.target.value as "ACTIVE" | "INACTIVE" })}>
                      <option value="ACTIVE">{fa ? "فعال" : "Active"}</option><option value="INACTIVE">{fa ? "غیرفعال" : "Inactive"}</option>
                    </select></label>
                ) : null}
                {account.id !== null ? <p className="admin-hint">{fa ? "نوع، واحد پول، حساب وصل‌شده و صراف پس از ذخیره تغییر نمی‌کند." : "Type, currency, linked account and Saraf cannot change after saving."}</p> : null}
                <div className="rates-actions">
                  <button type="submit" className="treasury-button gold" disabled={busy || !accountValid}>{fa ? "ذخیره" : "Save"}</button>
                  <button type="button" className="treasury-button" onClick={() => setAccount(null)}>{fa ? "لغو" : "Cancel"}</button>
                </div>
              </form>
            ) : null}
            {view.treasuryAccounts.length === 0 ? <p className="treasury-placeholder">{fa ? "هنوز حساب خزانه‌ای تنظیم نشده است." : "No Treasury account has been set up yet."}</p> : (
              <table className="rates-table">
                <thead><tr><th>{fa ? "نام" : "Name"}</th><th>{fa ? "نوع" : "Type"}</th><th>{fa ? "واحد پول" : "Currency"}</th><th>{fa ? "حساب" : "Account"}</th><th>{fa ? "وضعیت" : "Status"}</th><th /></tr></thead>
                <tbody>{view.treasuryAccounts.map((item: OperationalTreasuryAccountView) => (
                  <tr key={item.id}>
                    <td data-label={fa ? "نام" : "Name"}>{localizedName(item, fa)}{item.sarafName ? <small className="rates-used">{item.sarafName}</small> : null}</td>
                    <td data-label={fa ? "نوع" : "Type"}>{ACCOUNT_TYPE_COPY[item.accountType][locale]}</td>
                    <td data-label={fa ? "واحد پول" : "Currency"}>{item.currencyCode}</td>
                    <td data-label={fa ? "حساب" : "Account"}>{item.ledgerAccountCode} · {item.ledgerAccountName}</td>
                    <td data-label={fa ? "وضعیت" : "Status"}><em className={`treasury-chip ${item.status === "ACTIVE" ? "" : "muted"}`}>{item.status === "ACTIVE" ? (fa ? "فعال" : "Active") : (fa ? "غیرفعال" : "Inactive")}</em></td>
                    <td>{view.permissions.canManageTreasuryAccounts ? <button type="button" className="treasury-button" onClick={() => setAccount({
                      id: item.id, version: item.version, nameEn: item.nameEn, nameFa: item.nameFa ?? "", accountType: item.accountType,
                      currencyCode: item.currencyCode, ledgerAccountId: item.ledgerAccountId, sarafBusinessPartyId: item.sarafBusinessPartyId ?? "",
                      externalReference: item.externalReference ?? "", status: item.status })}>{fa ? "ویرایش" : "Edit"}</button> : null}</td>
                  </tr>
                ))}</tbody>
              </table>
            )}
          </section>

          <section className="module-content-card">
            <div className="module-card-heading"><div><p>{fa ? "مصارف" : "EXPENSES"}</p><h2>{fa ? "انواع مصرف" : "Expense types"}</h2></div>
              {view.permissions.canManageExpenseCategories && category === null
                ? <button type="button" className="treasury-button gold" onClick={() => setCategory(NEW_CATEGORY)}>{fa ? "افزودن نوع مصرف" : "Add expense type"}</button> : null}</div>
            {category ? (
              <form className="admin-form expense-form" aria-label={fa ? "نوع مصرف" : "Expense type"} onSubmit={(event) => { event.preventDefault(); void saveCategory(); }}>
                <label><span>{fa ? "کد *" : "Code *"}</span><input value={category.categoryCode} maxLength={32} dir="ltr" required disabled={category.id !== null} placeholder="OFFICE" onChange={(event) => setCategory({ ...category, categoryCode: event.target.value })} /></label>
                <label><span>{fa ? "نام (انگلیسی) *" : "Name (English) *"}</span><input value={category.nameEn} maxLength={120} required onChange={(event) => setCategory({ ...category, nameEn: event.target.value })} /></label>
                <label><span>{fa ? "نام (دری)" : "Name (Dari)"}</span><input value={category.nameFa} maxLength={120} dir="rtl" onChange={(event) => setCategory({ ...category, nameFa: event.target.value })} /></label>
                <label><span>{fa ? "حساب مصرف در جدول حساب‌ها *" : "Expense account in the Chart of Accounts *"}</span>
                  <select value={category.ledgerAccountId} disabled={category.id !== null} required onChange={(event) => setCategory({ ...category, ledgerAccountId: event.target.value })}>
                    <option value="">{fa ? "انتخاب کنید" : "Choose"}</option>
                    {(category.id !== null ? view.expenseCategories.filter((item) => item.id === category.id).map((item) => ({ id: item.ledgerAccountId, code: item.ledgerAccountCode, name: item.ledgerAccountName })) : view.options.expenseLedgerAccounts)
                      .map((ledger) => <option key={ledger.id} value={ledger.id}>{ledger.code} · {ledger.name}</option>)}
                  </select></label>
                {category.id === null && view.options.expenseLedgerAccounts.length === 0 ? <p className="admin-hint expense-warning">{fa ? "هیچ حساب مصرف قابل ثبت در جدول حساب‌ها نیست." : "No postable expense account exists in the Chart of Accounts."}</p> : null}
                {category.id !== null ? (
                  <label><span>{fa ? "وضعیت" : "Status"}</span>
                    <select value={category.status} onChange={(event) => setCategory({ ...category, status: event.target.value as "ACTIVE" | "INACTIVE" })}>
                      <option value="ACTIVE">{fa ? "فعال" : "Active"}</option><option value="INACTIVE">{fa ? "غیرفعال" : "Inactive"}</option>
                    </select></label>
                ) : <p className="admin-hint">{fa ? "کد و حساب وصل‌شده پس از ذخیره تغییر نمی‌کند." : "The code and linked account cannot change after saving."}</p>}
                <div className="rates-actions">
                  <button type="submit" className="treasury-button gold" disabled={busy || !categoryValid}>{fa ? "ذخیره" : "Save"}</button>
                  <button type="button" className="treasury-button" onClick={() => setCategory(null)}>{fa ? "لغو" : "Cancel"}</button>
                </div>
              </form>
            ) : null}
            {view.expenseCategories.length === 0 ? <p className="treasury-placeholder">{fa ? "هنوز نوع مصرفی تنظیم نشده است." : "No expense type has been set up yet."}</p> : (
              <table className="rates-table">
                <thead><tr><th>{fa ? "کد" : "Code"}</th><th>{fa ? "نام" : "Name"}</th><th>{fa ? "حساب" : "Account"}</th><th>{fa ? "وضعیت" : "Status"}</th><th /></tr></thead>
                <tbody>{view.expenseCategories.map((item: OperationalExpenseCategoryView) => (
                  <tr key={item.id}>
                    <td data-label={fa ? "کد" : "Code"} dir="ltr">{item.categoryCode}</td>
                    <td data-label={fa ? "نام" : "Name"}>{localizedName(item, fa)}</td>
                    <td data-label={fa ? "حساب" : "Account"}>{item.ledgerAccountCode} · {item.ledgerAccountName}</td>
                    <td data-label={fa ? "وضعیت" : "Status"}><em className={`treasury-chip ${item.status === "ACTIVE" ? "" : "muted"}`}>{item.status === "ACTIVE" ? (fa ? "فعال" : "Active") : (fa ? "غیرفعال" : "Inactive")}</em></td>
                    <td>{view.permissions.canManageExpenseCategories ? <button type="button" className="treasury-button" onClick={() => setCategory({
                      id: item.id, version: item.version, categoryCode: item.categoryCode, nameEn: item.nameEn, nameFa: item.nameFa ?? "",
                      ledgerAccountId: item.ledgerAccountId, status: item.status })}>{fa ? "ویرایش" : "Edit"}</button> : null}</td>
                  </tr>
                ))}</tbody>
              </table>
            )}
          </section>

          <section className="module-content-card">
            <div className="module-card-heading"><div><p>{fa ? "دوره‌ها" : "PERIODS"}</p><h2>{fa ? "دوره‌های حسابداری" : "Accounting periods"}</h2></div></div>
            {view.periods.length === 0 ? <p className="treasury-placeholder">{fa ? "هنوز سال مالی ایجاد نشده است. آن را در «تقویم مالی» ایجاد کنید." : "No financial year has been generated yet. Generate it in Financial calendar."}</p> : (
              <table className="rates-table">
                <thead><tr><th>{fa ? "دوره" : "Period"}</th><th>{fa ? "از" : "From"}</th><th>{fa ? "تا" : "To"}</th><th>{fa ? "وضعیت" : "Status"}</th><th /></tr></thead>
                <tbody>{view.periods.map((period) => (
                  <tr key={period.id}>
                    <td data-label={fa ? "دوره" : "Period"}>{localizedName(period, fa)}{period.openedBy ? <small className="rates-used">{fa ? "باز شده توسط " : "Opened by "}{period.openedBy}</small> : null}</td>
                    <td data-label={fa ? "از" : "From"}>{period.startsOn}</td>
                    <td data-label={fa ? "تا" : "To"}>{period.endsOn}</td>
                    <td data-label={fa ? "وضعیت" : "Status"}><em className={`treasury-chip ${period.status === "OPEN" ? "" : "muted"}`}>{PERIOD_STATUS_COPY[period.status][locale]}</em></td>
                    <td>{view.permissions.canManagePeriods && period.status === "PENDING" ? (opening?.id === period.id ? (
                      <form className="admin-form rates-correction" aria-label={fa ? "باز کردن دوره" : "Open period"} onSubmit={(event) => { event.preventDefault(); void openPeriod(period); }}>
                        <label><span>{fa ? "دلیل" : "Reason"}</span><input value={opening.reason} minLength={5} maxLength={500} required onChange={(event) => setOpening({ id: period.id, reason: event.target.value })} /></label>
                        <div className="rates-actions">
                          <button type="submit" className="treasury-button gold" disabled={busy || opening.reason.trim().length < 5}>{fa ? "باز کردن" : "Open period"}</button>
                          <button type="button" className="treasury-button" onClick={() => setOpening(null)}>{fa ? "لغو" : "Cancel"}</button>
                        </div>
                      </form>
                    ) : <button type="button" className="treasury-button" onClick={() => setOpening({ id: period.id, reason: "" })}>{fa ? "باز کردن" : "Open"}</button>) : null}</td>
                  </tr>
                ))}</tbody>
              </table>
            )}
            <p className="admin-hint">{fa ? "بستن دوره‌ها هنوز در دسترس نیست؛ پالیسی آن باید تصویب شود." : "Closing periods is not available yet; its policy still needs approval."}</p>
          </section>
        </>
      )}
    </div>
  );
}
