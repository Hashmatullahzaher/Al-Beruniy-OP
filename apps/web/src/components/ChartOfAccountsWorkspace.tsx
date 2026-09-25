"use client";

import { toDariDigits } from "@abos/calendar";
import { useCallback, useEffect, useMemo, useState } from "react";

import { AccessGate, api, errorText, formatWhen } from "@/components/AdminUsersWorkspace";
import { AppIcon } from "@/components/AppIcon";
import { useLocale } from "@/components/LocaleProvider";
import { StageZeroPageHeader } from "@/components/StageZeroWorkspace";
import type { Copy } from "@/lib/access-copy";
import type { AccountType, ChartOfAccountsView, ControlType, DuplicateWarning, LedgerAccountView } from "@/server/chart-of-accounts";

/**
 * User-managed Chart of Accounts (V1 backlog #10). No chart is shipped: people with the manage
 * permission add accounts, which are usable at once and wait in the Finance Manager's review list.
 * The database decides everything; this screen explains and asks.
 */

const TYPES: Readonly<Record<AccountType, Copy>> = {
  ASSET: { en: "Asset", fa: "دارایی" },
  LIABILITY: { en: "Liability", fa: "بدهی" },
  EQUITY: { en: "Equity", fa: "سرمایه" },
  REVENUE: { en: "Revenue", fa: "درآمد" },
  EXPENSE: { en: "Expense", fa: "مصرف" }
};
const CONTROLS: Readonly<Record<ControlType, Copy>> = {
  CASH: { en: "Cash (safe)", fa: "نقد (صندوق)" },
  SARAF: { en: "Saraf", fa: "صراف" },
  SHAREHOLDER_CAPITAL: { en: "Shareholder capital", fa: "سرمایه سهامدار" },
  SHAREHOLDER_LOAN: { en: "Shareholder loan", fa: "قرضه سهامدار" },
  AR: { en: "Receivables", fa: "حسابات دریافتنی" },
  AP: { en: "Payables", fa: "حسابات پرداختنی" },
  OTHER: { en: "Other control", fa: "کنترل دیگر" }
};
const REVIEW_COPY: Readonly<Record<string, Copy>> = {
  PENDING_REVIEW: { en: "Awaiting review", fa: "در انتظار بازبینی" },
  REVIEWED: { en: "Reviewed", fa: "بازبینی شد" },
  FLAGGED: { en: "Flagged for correction", fa: "نیاز به اصلاح" }
};
const REASON_COPY: Readonly<Record<string, Copy>> = {
  SAME_NAME: { en: "same name", fa: "نام یکسان" },
  SIMILAR_NAME: { en: "similar name", fa: "نام مشابه" },
  SIMILAR_CODE: { en: "look-alike code", fa: "کد مشابه" },
  SAME_TYPE: { en: "same type", fa: "نوع یکسان" },
  SAME_CURRENCY: { en: "same currency", fa: "واحد پول یکسان" },
  SAME_CONTROL_TYPE: { en: "same control type", fa: "نوع کنترل یکسان" }
};
const ERRORS: Readonly<Record<string, Copy>> = {
  ACCOUNT_IN_USE: { en: "This account is in use, so that change is not allowed.", fa: "این حساب در حال استفاده است و این تغییر مجاز نیست." },
  ACCOUNT_CODE_TAKEN: { en: "That account code already exists in this company.", fa: "این کد حساب قبلاً در این شرکت وجود دارد." },
  REVIEW_INDEPENDENCE: { en: "You created or last changed this account, so another reviewer must review it.", fa: "شما این حساب را ایجاد یا آخرین بار تغییر داده‌اید؛ بازبین دیگری باید آن را بازبینی کند." },
  DUPLICATE_CONFIRMATION_REQUIRED: { en: "Similar accounts exist. Check the warnings and confirm to continue.", fa: "حساب‌های مشابه وجود دارند. هشدارها را ببینید و برای ادامه تایید کنید." },
  ACCOUNT_NOT_FOUND: { en: "That account was not found.", fa: "این حساب پیدا نشد." }
};

interface FormState {
  code: string; name: string; nameFa: string; description: string; type: AccountType; controlType: ControlType | "";
  currency: string; parentId: string; postingAllowed: boolean; requiresProject: boolean; requiresDepartment: boolean; requiresCostCenter: boolean;
}
const EMPTY_FORM: FormState = {
  code: "", name: "", nameFa: "", description: "", type: "ASSET", controlType: "", currency: "USD", parentId: "",
  postingAllowed: true, requiresProject: false, requiresDepartment: false, requiresCostCenter: false
};

function formFrom(account: LedgerAccountView): FormState {
  return {
    code: account.code, name: account.name, nameFa: account.nameFa ?? "", description: account.description ?? "", type: account.type,
    controlType: account.controlType ?? "", currency: account.currency ?? "", parentId: account.parentId ?? "", postingAllowed: account.postingAllowed,
    requiresProject: account.requiresProject, requiresDepartment: account.requiresDepartment, requiresCostCenter: account.requiresCostCenter
  };
}

function payload(form: FormState) {
  return {
    code: form.code, name: form.name, nameFa: form.nameFa.trim() || null, description: form.description.trim() || null, type: form.type,
    controlType: form.controlType || null, currency: form.currency || null, parentId: form.parentId || null, postingAllowed: form.postingAllowed,
    requiresProject: form.requiresProject, requiresDepartment: form.requiresDepartment, requiresCostCenter: form.requiresCostCenter
  };
}

/** Accounts in tree order, each with its depth. Search shows a flat list of matches. */
function treeRows(accounts: readonly LedgerAccountView[], query: string): readonly { account: LedgerAccountView; depth: number }[] {
  const needle = query.trim().toLowerCase();
  if (needle) {
    return accounts.filter((account) => [account.code, account.name, account.nameFa ?? ""].some((value) => value.toLowerCase().includes(needle)))
      .map((account) => ({ account, depth: 0 }));
  }
  const ids = new Set(accounts.map((account) => account.id));
  const children = new Map<string, LedgerAccountView[]>();
  for (const account of accounts) {
    const key = account.parentId !== null && ids.has(account.parentId) ? account.parentId : "";
    children.set(key, [...(children.get(key) ?? []), account]);
  }
  const rows: { account: LedgerAccountView; depth: number }[] = [];
  const walk = (key: string, depth: number) => {
    for (const account of children.get(key) ?? []) {
      rows.push({ account, depth });
      if (depth < 8) walk(account.id, depth + 1);
    }
  };
  walk("", 0);
  return rows;
}

export function ChartOfAccountsWorkspace() {
  const { locale } = useLocale();
  const fa = locale === "fa";
  const t = useCallback((copy: Copy) => copy[locale], [locale]);
  const num = useCallback((value: number) => (fa ? toDariDigits(value) : String(value)), [fa]);
  const [view, setView] = useState<ChartOfAccountsView | null>(null);
  const [gate, setGate] = useState<"signed-out" | "denied" | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [tab, setTab] = useState<"accounts" | "review">("accounts");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | "new" | null>(null);
  const [editing, setEditing] = useState(false);

  const fail = useCallback((error: { code: string; message: string }) => {
    const copy = ERRORS[error.code];
    setMessage({ tone: "error", text: copy ? `${copy[locale]} ${locale === "en" ? error.message : ""}`.trim() : errorText(error, locale) });
  }, [locale]);

  const load = useCallback(async () => {
    const result = await api<ChartOfAccountsView>("/api/v1/finance/accounts");
    if (!result.ok) {
      setGate(result.status === 401 ? "signed-out" : result.status === 403 ? "denied" : null);
      if (result.status !== 401 && result.status !== 403) fail(result.error);
      return;
    }
    setGate(null);
    setView(result.data);
  }, [fail]);

  useEffect(() => {
    let current = true;
    void api<ChartOfAccountsView>("/api/v1/finance/accounts").then((result) => {
      if (!current) return;
      if (!result.ok) { setGate(result.status === 401 ? "signed-out" : result.status === 403 ? "denied" : null); return; }
      setView(result.data);
    });
    return () => { current = false; };
  }, []);

  const rows = useMemo(() => treeRows(view?.accounts ?? [], query), [view, query]);
  const queue = useMemo(() => (view?.accounts ?? []).filter((account) => account.reviewState === "PENDING_REVIEW" || account.reviewState === "FLAGGED"), [view]);
  const current = view?.accounts.find((account) => account.id === selected) ?? null;

  if (gate) return <div className="module-workspace"><AccessGate state={gate} fa={fa} what={{ en: "The Chart of Accounts needs the “Manage the Chart of Accounts”, “Review new accounts” or “View Finance inbox and journals” permission.", fa: "جدول حساب‌ها به صلاحیت «مدیریت جدول حساب‌ها»، «بازبینی حساب‌های جدید» یا «مشاهده صندوق مالی و ژورنال‌ها» نیاز دارد." }} /></div>;

  const saved = async (text: Copy, id: string) => {
    setMessage({ tone: "ok", text: t(text) });
    setSelected(id); setEditing(false);
    await load();
  };

  return (
    <div className="module-workspace coa-workspace">
      <StageZeroPageHeader icon="finance"
        eyebrow={{ en: `Finance · ${view?.legalEntity.name ?? ""}`, fa: `مالی · ${view?.legalEntity.name ?? ""}` }}
        title={{ en: "Chart of Accounts", fa: "جدول حساب‌ها" }}
        description={{ en: "The company's own accounts. Permitted people add accounts that can be used at once; the Finance Manager reviews each new or changed account.", fa: "حساب‌های خود شرکت. افراد مجاز حساب‌هایی اضافه می‌کنند که فوراً قابل استفاده‌اند؛ مدیر مالی هر حساب جدید یا تغییر یافته را بازبینی می‌کند." }} />

      <section className="finance-boundary-banner"><span><AppIcon name="shield" size={22} /></span><div>
        <p>{fa ? "هیچ جدول حساب ثابتی ارائه نمی‌شود" : "NO FIXED CHART IS SHIPPED"}</p>
        <strong>{fa ? "طبقه‌بندی و شماره‌گذاری حساب‌ها هنوز توسط مدیر مالی تصویب نشده است؛ کدها آزاد هستند و پنج نوع حساب تنها طبقه‌بندی ساختاری است. همه داده‌ها آزمایشی‌اند." : "Account classes and a numbering convention are not yet approved by the Finance Manager: codes are free text and the five account types are the only structural classification. All data is synthetic."}</strong>
      </div><em>{fa ? "واحد پول پایه" : "Base currency"} · {view?.legalEntity.baseCurrency ?? "—"}</em></section>

      {message ? <div className={`treasury-message ${message.tone === "ok" ? "success" : "error"}`} role="status"><AppIcon name={message.tone === "ok" ? "shield" : "alert"} size={16} /><span>{message.text}</span><button onClick={() => setMessage(null)} aria-label={fa ? "بستن" : "Dismiss"}>×</button></div> : null}

      <div className="admin-tabs" role="tablist">
        <button role="tab" aria-selected={tab === "accounts"} onClick={() => setTab("accounts")}>{fa ? "حساب‌ها" : "Accounts"}<b>{num(view?.accounts.length ?? 0)}</b></button>
        <button role="tab" aria-selected={tab === "review"} onClick={() => setTab("review")}>{fa ? "فهرست بازبینی" : "Review list"}<b>{num(view?.reviewQueue ?? 0)}</b></button>
      </div>

      {view === null ? <p className="treasury-placeholder">{fa ? "در حال بارگذاری…" : "Loading…"}</p> : tab === "accounts" ? (
        <section className="admin-grid coa-grid">
          <div className="module-content-card">
            <div className="coa-list-tools">
              <label className="admin-search"><AppIcon name="search" size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={fa ? "جستجوی کد یا نام" : "Search code or name"} aria-label={fa ? "جستجوی حساب" : "Search accounts"} /></label>
              {view.canManage ? <button className="treasury-button gold" onClick={() => { setSelected("new"); setEditing(true); setMessage(null); }}>{fa ? "حساب جدید" : "New account"}</button> : null}
            </div>
            {rows.length === 0 ? <p className="admin-hint coa-empty">{view.accounts.length === 0
              ? (fa ? "هنوز حسابی وجود ندارد. نخستین حساب را اضافه کنید." : "No accounts yet. Add the first account.")
              : (fa ? "حسابی با این جستجو پیدا نشد." : "No account matches this search.")}</p> : null}
            <div className="admin-list coa-tree" aria-label={fa ? "حساب‌ها" : "Accounts"}>
              {rows.map(({ account, depth }) => (
                <button key={account.id} className={`${selected === account.id ? "selected" : ""} ${account.status !== "ACTIVE" ? "inactive" : ""}`}
                  style={{ ["--coa-depth" as string]: depth }} onClick={() => { setSelected(account.id); setEditing(false); }}>
                  <span className="coa-code">{account.code}</span>
                  <span><strong>{fa && account.nameFa ? account.nameFa : account.name}</strong>
                    <small>{t(TYPES[account.type])}{account.controlType ? ` · ${t(CONTROLS[account.controlType])}` : ""} · {account.currency ?? (fa ? "چند واحد پول" : "multi-currency")}{account.postingAllowed ? "" : ` · ${fa ? "گروه" : "group"}`}</small></span>
                  <span className="coa-badges">
                    {account.usage.inUse ? <em className="treasury-chip gold" title={fa ? "در حال استفاده" : "In use"}>{fa ? "در استفاده" : "In use"}</em> : null}
                    {account.status !== "ACTIVE" ? <em className="treasury-chip muted">{account.status === "INACTIVE" ? (fa ? "غیرفعال" : "Inactive") : account.status}</em> : null}
                    {account.reviewState && account.reviewState !== "REVIEWED" ? <em className={`treasury-chip ${account.reviewState === "FLAGGED" ? "danger" : ""}`}>{t(REVIEW_COPY[account.reviewState] ?? { en: account.reviewState, fa: account.reviewState })}</em> : null}
                  </span>
                </button>
              ))}
            </div>
          </div>
          <div className="module-content-card admin-detail">
            {selected === "new" && view.canManage ? (
              <AccountForm key="new" view={view} account={null} fa={fa} t={t} onCancel={() => setSelected(null)} onError={fail}
                onSaved={(id) => saved({ en: "Account created. It can be used now and waits in the review list.", fa: "حساب ایجاد شد. اکنون قابل استفاده است و در فهرست بازبینی قرار دارد." }, id)} />
            ) : current && editing && view.canManage ? (
              <AccountForm key={`${current.id}-${current.version}`} view={view} account={current} fa={fa} t={t} onCancel={() => setEditing(false)} onError={fail}
                onSaved={(id) => saved({ en: "Account saved. The change waits in the review list.", fa: "حساب ذخیره شد. تغییر در فهرست بازبینی قرار دارد." }, id)} />
            ) : current ? (
              <AccountDetail key={`${current.id}-${current.version}-${current.status}`} view={view} account={current} fa={fa} t={t} num={num} onEdit={() => setEditing(true)} onError={fail}
                onChanged={(text) => saved(text, current.id)} />
            ) : <p className="admin-hint">{fa ? "حسابی را برای دیدن جزئیات انتخاب کنید." : "Choose an account to see its details."}</p>}
          </div>
        </section>
      ) : (
        <ReviewList view={view} queue={queue} fa={fa} t={t} onError={fail}
          onDecided={async (text) => { setMessage({ tone: "ok", text: t(text) }); await load(); }} />
      )}
    </div>
  );
}

function WarningList({ warnings, fa, t }: { readonly warnings: readonly DuplicateWarning[]; readonly fa: boolean; readonly t: (copy: Copy) => string }) {
  if (warnings.length === 0) return null;
  return (
    <ul className="coa-warnings" aria-label={fa ? "هشدارهای تکرار" : "Duplicate warnings"}>
      {warnings.map((warning) => (
        <li key={warning.accountId} className={warning.severity === "LIKELY" ? "likely" : ""}>
          <strong>{warning.severity === "LIKELY" ? (fa ? "احتمالاً تکراری" : "Likely duplicate") : (fa ? "مشابه" : "Similar")}: {warning.code} · {fa && warning.nameFa ? warning.nameFa : warning.name}</strong>
          <small>{t(TYPES[warning.type])} · {warning.currency ?? "—"}{warning.status !== "ACTIVE" ? ` · ${warning.status}` : ""} — {warning.reasons.map((reason) => t(REASON_COPY[reason] ?? { en: reason, fa: reason })).join(", ")}</small>
        </li>
      ))}
    </ul>
  );
}

function AccountForm({ view, account, fa, t, onCancel, onSaved, onError }: {
  readonly view: ChartOfAccountsView; readonly account: LedgerAccountView | null; readonly fa: boolean; readonly t: (copy: Copy) => string;
  readonly onCancel: () => void; readonly onSaved: (id: string) => Promise<void>; readonly onError: (error: { code: string; message: string }) => void;
}) {
  const [form, setForm] = useState<FormState>(account ? formFrom(account) : EMPTY_FORM);
  const [warnings, setWarnings] = useState<readonly DuplicateWarning[]>([]);
  const [codeTaken, setCodeTaken] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const locked = account?.usage.inUse ?? false;
  const posted = (account?.usage.postedJournalLines ?? 0) > 0;
  const hasChildren = (account?.usage.children ?? 0) > 0;
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => { setForm((currentForm) => ({ ...currentForm, [key]: value })); setConfirm(false); };

  // Live duplicate check, debounced, while the identifying fields change.
  const probe = JSON.stringify({ code: form.code, name: form.name, nameFa: form.nameFa, type: form.type, currency: form.currency, controlType: form.controlType });
  useEffect(() => {
    if (form.code.trim() === "" && form.name.trim().length < 2) return;
    let active = true;
    const timer = setTimeout(() => {
      void api<{ codeTaken: { code: string; name: string } | null; warnings: DuplicateWarning[] }>("/api/v1/finance/accounts/check", "POST",
        { account: payload(form), accountId: account?.id ?? null }).then((result) => {
        if (!active || !result.ok) return;
        setWarnings(result.data.warnings);
        setCodeTaken(result.data.codeTaken ? `${result.data.codeTaken.code} · ${result.data.codeTaken.name}` : null);
      });
    }, 350);
    return () => { active = false; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the probe string captures the fields that matter
  }, [probe, account?.id]);

  const likely = warnings.some((warning) => warning.severity === "LIKELY");
  const parents = view.accounts.filter((candidate) => candidate.type === form.type && candidate.id !== account?.id && candidate.status === "ACTIVE");

  const submit = async () => {
    setBusy(true);
    const body = payload(form);
    const result = account
      ? await api<{ account: LedgerAccountView }>(`/api/v1/finance/accounts/${account.id}`, "PATCH", { expectedVersion: account.version, changes: body, confirmDuplicates: confirm })
      : await api<{ account: LedgerAccountView }>("/api/v1/finance/accounts", "POST", { account: body, confirmDuplicates: confirm });
    setBusy(false);
    if (!result.ok) {
      const extra = (result.error as { warnings?: DuplicateWarning[] }).warnings;
      if (extra) setWarnings(extra);
      onError(result.error);
      return;
    }
    await onSaved(result.data.account.id);
  };

  return (
    <form className="admin-form coa-form" aria-label={fa ? "فرم حساب" : "Account form"} onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <h2>{account ? (fa ? `ویرایش ${account.code}` : `Edit ${account.code}`) : (fa ? "حساب جدید" : "New account")}</h2>
      {locked ? <p className="admin-hint coa-locked"><AppIcon name="key" size={14} /> {posted
        ? (fa ? "این حساب ثبت نهایی دارد؛ فقط نام دری و توضیح قابل تغییر است." : "This account has posted activity; only its Dari name and description can change.")
        : (fa ? "این حساب در حال استفاده است؛ کد، نوع، واحد پول، نوع کنترل، ثبت و ابعاد آن ثابت است." : "This account is in use; its code, type, currency, control type, posting and dimension settings are fixed.")}</p> : null}
      <div className="coa-form-grid">
        <label><span>{fa ? "کد حساب" : "Account code"}</span>
          <input value={form.code} onChange={(event) => set("code", event.target.value)} disabled={locked} required maxLength={32} dir="ltr" />
          <small>{fa ? "آزاد؛ قاعده شماره‌گذاری هنوز تصویب نشده است." : "Free text; no numbering convention is approved yet."}</small></label>
        <label><span>{fa ? "نوع حساب" : "Account type"}</span>
          <select value={form.type} onChange={(event) => { set("type", event.target.value as AccountType); set("parentId", ""); }} disabled={locked || hasChildren}>
            {(Object.keys(TYPES) as AccountType[]).map((type) => <option key={type} value={type}>{t(TYPES[type])}</option>)}
          </select></label>
        <label className="wide"><span>{fa ? "نام حساب" : "Account name"}</span>
          <input value={form.name} onChange={(event) => set("name", event.target.value)} disabled={posted} required maxLength={120} /></label>
        <label className="wide"><span>{fa ? "نام دری" : "Dari name"}</span>
          <input value={form.nameFa} onChange={(event) => set("nameFa", event.target.value)} maxLength={120} dir="rtl" /></label>
        <label><span>{fa ? "واحد پول" : "Currency"}</span>
          <select value={form.currency} onChange={(event) => set("currency", event.target.value)} disabled={locked || hasChildren}>
            {view.currencies.map((currency) => <option key={currency.code} value={currency.code}>{currency.code} · {currency.name}</option>)}
            <option value="">{fa ? "هیچ — فقط گروه" : "None — group only"}</option>
          </select></label>
        <label><span>{fa ? "نوع کنترل" : "Control type"}</span>
          <select value={form.controlType} onChange={(event) => set("controlType", event.target.value as ControlType | "")} disabled={locked}>
            <option value="">{fa ? "هیچ" : "None"}</option>
            {(Object.keys(CONTROLS) as ControlType[]).map((control) => <option key={control} value={control}>{t(CONTROLS[control])}</option>)}
          </select>
          <small>{fa ? "حساب‌های صندوق و صراف با نوع کنترل «نقد» یا «صراف» ایجاد می‌شوند." : "Safe and Saraf accounts are created here with control type Cash or Saraf."}</small></label>
        <label className="wide"><span>{fa ? "حساب مادر (اختیاری)" : "Parent account (optional)"}</span>
          <select value={form.parentId} onChange={(event) => set("parentId", event.target.value)} disabled={posted}>
            <option value="">{fa ? "بدون حساب مادر" : "No parent"}</option>
            {parents.map((parent) => <option key={parent.id} value={parent.id}>{parent.code} · {fa && parent.nameFa ? parent.nameFa : parent.name}</option>)}
          </select></label>
        <label className="wide"><span>{fa ? "توضیح" : "Description"}</span>
          <textarea value={form.description} onChange={(event) => set("description", event.target.value)} maxLength={500} rows={2} /></label>
      </div>
      <fieldset className="admin-status-choice" disabled={locked}>
        <legend>{fa ? "استفاده" : "Use"}</legend>
        <label><input type="checkbox" checked={form.postingAllowed} onChange={(event) => set("postingAllowed", event.target.checked)} />{fa ? "ثبت در این حساب مجاز است" : "Accepts postings"}</label>
        <label><input type="checkbox" checked={form.requiresProject} onChange={(event) => set("requiresProject", event.target.checked)} />{fa ? "پروژه لازم است" : "Requires a project"}</label>
        <label><input type="checkbox" checked={form.requiresDepartment} onChange={(event) => set("requiresDepartment", event.target.checked)} />{fa ? "بخش لازم است" : "Requires a department"}</label>
        <label><input type="checkbox" checked={form.requiresCostCenter} onChange={(event) => set("requiresCostCenter", event.target.checked)} />{fa ? "مرکز هزینه لازم است" : "Requires a cost centre"}</label>
      </fieldset>
      {codeTaken ? <p className="coa-error" role="alert">{fa ? "این کد قبلاً استفاده شده است: " : "This code is already used by "}{codeTaken}</p> : null}
      <WarningList warnings={warnings} fa={fa} t={t} />
      {likely ? <label className="coa-confirm"><input type="checkbox" checked={confirm} onChange={(event) => setConfirm(event.target.checked)} />
        <span>{fa ? "هشدارها را بررسی کردم؛ این حساب تکراری نیست." : "I have checked the warnings; this is not a duplicate."}</span></label> : null}
      <div className="coa-actions">
        <button type="submit" className="treasury-button gold" disabled={busy || codeTaken !== null || (likely && !confirm)}>{account ? (fa ? "ذخیره تغییرات" : "Save changes") : (fa ? "ایجاد حساب" : "Create account")}</button>
        <button type="button" className="treasury-button quiet" onClick={onCancel}>{fa ? "لغو" : "Cancel"}</button>
      </div>
    </form>
  );
}

function AccountDetail({ view, account, fa, t, num, onEdit, onChanged, onError }: {
  readonly view: ChartOfAccountsView; readonly account: LedgerAccountView; readonly fa: boolean; readonly t: (copy: Copy) => string;
  readonly num: (value: number) => string; readonly onEdit: () => void; readonly onChanged: (text: Copy) => Promise<void>;
  readonly onError: (error: { code: string; message: string }) => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const parent = view.accounts.find((candidate) => candidate.id === account.parentId);
  const usage = account.usage;
  const changeStatus = async (status: "ACTIVE" | "INACTIVE") => {
    setBusy(true);
    const result = await api<{ account: LedgerAccountView }>(`/api/v1/finance/accounts/${account.id}/status`, "POST",
      { status, expectedVersion: account.version, reason: reason.trim() || null });
    setBusy(false);
    if (!result.ok) { onError(result.error); return; }
    await onChanged(status === "INACTIVE" ? { en: "Account deactivated.", fa: "حساب غیرفعال شد." } : { en: "Account reactivated.", fa: "حساب دوباره فعال شد." });
  };
  const uses = [
    usage.safeAccounts > 0 ? `${fa ? "حساب صندوق" : "safe accounts"}: ${num(usage.safeAccounts)}` : null,
    usage.journalLines > 0 ? `${fa ? "سطرهای ژورنال" : "journal lines"}: ${num(usage.journalLines)} (${fa ? "ثبت‌شده" : "posted"} ${num(usage.postedJournalLines)})` : null,
    usage.pendingPostingIntents > 0 ? `${fa ? "ثبت در جریان" : "postings in progress"}: ${num(usage.pendingPostingIntents)}` : null,
    ...usage.references.map((reference) => (reference.startsWith("saraf") ? (fa ? "حساب صراف" : "Saraf account") : reference))
  ].filter((value): value is string => value !== null);
  return (
    <div className="admin-user-panel coa-detail">
      <header>
        <span className="coa-code large">{account.code}</span>
        <div><h2>{fa && account.nameFa ? account.nameFa : account.name}</h2>
          <small>{fa && account.nameFa ? account.name : account.nameFa ?? ""}</small></div>
        {view.canManage ? <button className="treasury-button" onClick={onEdit}>{fa ? "ویرایش" : "Edit"}</button> : null}
      </header>
      <dl className="coa-facts">
        <div><dt>{fa ? "نوع" : "Type"}</dt><dd>{t(TYPES[account.type])}</dd></div>
        <div><dt>{fa ? "واحد پول" : "Currency"}</dt><dd>{account.currency ?? (fa ? "چند واحد پول (گروه)" : "Multi-currency (group)")}</dd></div>
        <div><dt>{fa ? "نوع کنترل" : "Control type"}</dt><dd>{account.controlType ? t(CONTROLS[account.controlType]) : "—"}</dd></div>
        <div><dt>{fa ? "ثبت" : "Postings"}</dt><dd>{account.postingAllowed ? (fa ? "مجاز" : "Accepted") : (fa ? "فقط گروه" : "Group only")}</dd></div>
        <div><dt>{fa ? "حساب مادر" : "Parent"}</dt><dd>{parent ? `${parent.code} · ${parent.name}` : "—"}</dd></div>
        <div><dt>{fa ? "وضعیت" : "Status"}</dt><dd>{account.status === "ACTIVE" ? (fa ? "فعال" : "Active") : account.status === "INACTIVE" ? (fa ? "غیرفعال" : "Inactive") : account.status}</dd></div>
        <div><dt>{fa ? "بازبینی" : "Review"}</dt><dd>{account.reviewState ? t(REVIEW_COPY[account.reviewState] ?? { en: account.reviewState, fa: account.reviewState }) : (fa ? "خارج از برنامه ایجاد شده (داده آزمایشی)" : "Created outside the app (synthetic seed)")}</dd></div>
        <div><dt>{fa ? "ایجاد" : "Created"}</dt><dd>{account.createdBy ?? (fa ? "خارج از برنامه" : "outside the app")} · {formatWhen(account.createdAt, fa ? "fa" : "en")}</dd></div>
        {account.lastChangedBy ? <div><dt>{fa ? "آخرین تغییر" : "Last changed"}</dt><dd>{account.lastChangedBy}{account.lastChangedAt ? ` · ${formatWhen(account.lastChangedAt, fa ? "fa" : "en")}` : ""}</dd></div> : null}
      </dl>
      {account.description ? <p className="admin-hint">{account.description}</p> : null}
      <section className="admin-section">
        <h3>{fa ? "استفاده و حفاظت" : "Use and protection"}</h3>
        {usage.inUse ? <p className="admin-hint coa-locked"><AppIcon name="key" size={14} /> {fa ? "در حال استفاده — کد، نوع، واحد پول و نوع کنترل ثابت است: " : "In use — code, type, currency and control type are fixed: "}{uses.join(" · ")}</p>
          : <p className="admin-hint">{fa ? "هنوز استفاده نشده است؛ همه مشخصات قابل تغییر است." : "Not used yet; every attribute can still change."}</p>}
      </section>
      {account.reviews.length > 0 ? (
        <section className="admin-section">
          <h3>{fa ? "تاریخچه بازبینی" : "Review history"}</h3>
          <ul className="admin-effective">{account.reviews.map((entry) => (
            <li key={`${entry.decidedAt}-${entry.version}`}><strong>{t(REVIEW_COPY[entry.decision] ?? { en: entry.decision, fa: entry.decision })} · {entry.reviewer}</strong>
              <small>{formatWhen(entry.decidedAt, fa ? "fa" : "en")}{entry.note ? ` — ${entry.note}` : ""}</small></li>
          ))}</ul>
        </section>
      ) : null}
      {view.canManage ? (
        <section className="admin-section admin-actions">
          <h3>{account.status === "ACTIVE" ? (fa ? "غیرفعال‌سازی" : "Deactivate") : (fa ? "فعال‌سازی دوباره" : "Reactivate")}</h3>
          {account.status === "ACTIVE" ? <label className="coa-reason"><span>{fa ? "دلیل" : "Reason"}</span>
            <input value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} /></label> : null}
          <div>{account.status === "ACTIVE"
            ? <button className="treasury-button danger" disabled={busy || reason.trim().length < 3} onClick={() => void changeStatus("INACTIVE")}>{fa ? "غیرفعال کردن حساب" : "Deactivate account"}</button>
            : <button className="treasury-button" disabled={busy} onClick={() => void changeStatus("ACTIVE")}>{fa ? "فعال کردن دوباره" : "Reactivate account"}</button>}</div>
        </section>
      ) : null}
    </div>
  );
}

function ReviewList({ view, queue, fa, t, onDecided, onError }: {
  readonly view: ChartOfAccountsView; readonly queue: readonly LedgerAccountView[]; readonly fa: boolean; readonly t: (copy: Copy) => string;
  readonly onDecided: (text: Copy) => Promise<void>; readonly onError: (error: { code: string; message: string }) => void;
}) {
  const [notes, setNotes] = useState<Readonly<Record<string, string>>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const decide = async (account: LedgerAccountView, decision: "REVIEWED" | "FLAGGED") => {
    setBusy(account.id);
    const result = await api<{ account: LedgerAccountView }>(`/api/v1/finance/accounts/${account.id}/review`, "POST",
      { decision, expectedVersion: account.version, note: notes[account.id]?.trim() || null });
    setBusy(null);
    if (!result.ok) { onError(result.error); return; }
    await onDecided(decision === "REVIEWED" ? { en: `${account.code} marked as reviewed.`, fa: `${account.code} بازبینی شد.` } : { en: `${account.code} flagged for correction.`, fa: `${account.code} برای اصلاح علامت‌گذاری شد.` });
  };
  return (
    <section className="coa-review">
      <p className="admin-hint">{fa ? "حساب‌های جدید یا تغییر یافته اینجا منتظر بازبینی مدیر مالی هستند. بازبین نمی‌تواند حسابی را که خودش ایجاد یا آخرین بار تغییر داده بازبینی کند." : "New or changed accounts wait here for the Finance Manager. A reviewer can never review an account they created or last changed."}</p>
      {!view.canReview ? <p className="admin-hint">{fa ? "شما فقط می‌توانید فهرست را ببینید؛ بازبینی به صلاحیت «بازبینی حساب‌های جدید» نیاز دارد." : "You can see the list; reviewing needs the “Review new accounts” permission."}</p> : null}
      {queue.length === 0 ? <p className="treasury-placeholder">{fa ? "هیچ حسابی منتظر بازبینی نیست." : "No account is waiting for review."}</p> : null}
      {queue.map((account) => (
        <article key={account.id} className="module-content-card coa-review-card" aria-label={`${fa ? "بازبینی" : "Review"} ${account.code}`}>
          <header>
            <span className="coa-code">{account.code}</span>
            <div><strong>{account.name}</strong>{account.nameFa ? <small dir="rtl">{account.nameFa}</small> : null}</div>
            <em className={`treasury-chip ${account.reviewState === "FLAGGED" ? "danger" : "gold"}`}>{t(REVIEW_COPY[account.reviewState ?? ""] ?? { en: "", fa: "" })}</em>
          </header>
          <p className="admin-hint">{t(TYPES[account.type])} · {account.currency ?? (fa ? "چند واحد پول" : "multi-currency")}{account.controlType ? ` · ${t(CONTROLS[account.controlType])}` : ""} · {account.postingAllowed ? (fa ? "ثبت مجاز" : "accepts postings") : (fa ? "فقط گروه" : "group only")}
            {" · "}{account.reviewReason === "CHANGED" ? (fa ? "تغییر یافته توسط " : "changed by ") : (fa ? "ایجاد شده توسط " : "created by ")}{account.lastChangedBy ?? account.createdBy ?? "—"}</p>
          {account.lastReviewNote && account.reviewState === "FLAGGED" ? <p className="coa-error">{fa ? "یادداشت بازبین: " : "Reviewer's note: "}{account.lastReviewNote}</p> : null}
          {account.duplicateWarnings.length > 0 ? <>
            <p className="admin-hint">{fa ? "هشدارهایی که هنگام ذخیره نشان داده و تایید شد:" : "Warnings shown and confirmed when it was saved:"}</p>
            <WarningList warnings={account.duplicateWarnings} fa={fa} t={t} />
          </> : null}
          {view.canReview ? (account.viewerIsParticipant
            ? <p className="admin-hint coa-locked"><AppIcon name="shield" size={14} /> {fa ? "شما این حساب را ایجاد یا آخرین بار تغییر داده‌اید؛ بازبین دیگری باید آن را بازبینی کند." : "You created or last changed this account; another reviewer must review it."}</p>
            : <div className="admin-form coa-review-actions">
                <label><span>{fa ? "یادداشت (برای علامت‌گذاری لازم است)" : "Note (required to flag)"}</span>
                  <input value={notes[account.id] ?? ""} onChange={(event) => setNotes((current) => ({ ...current, [account.id]: event.target.value }))} maxLength={500} /></label>
                <div className="coa-actions">
                  <button className="treasury-button gold" disabled={busy === account.id} onClick={() => void decide(account, "REVIEWED")}>{fa ? "بازبینی شد" : "Mark reviewed"}</button>
                  <button className="treasury-button danger" disabled={busy === account.id || (notes[account.id]?.trim().length ?? 0) < 3} onClick={() => void decide(account, "FLAGGED")}>{fa ? "نیاز به اصلاح" : "Flag for correction"}</button>
                </div>
              </div>) : null}
        </article>
      ))}
    </section>
  );
}
