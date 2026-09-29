"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";

import type {
  ShareholderSetupAgreement, ShareholderSetupBlocker, ShareholderSetupInstallment, ShareholderSetupShareholder, ShareholderSetupWorkspace as SetupView
} from "@abos/contracts";

import { AccessGate, api, errorText, formatWhen } from "@/components/AdminUsersWorkspace";
import { AppIcon } from "@/components/AppIcon";
import { exactDecimal } from "@/components/ExchangeRatesWorkspace";
import { useLocale } from "@/components/LocaleProvider";
import { ShareholderRequestWorkspace } from "@/components/ShareholderRequestWorkspace";
import { StageZeroPageHeader } from "@/components/StageZeroWorkspace";
import type { Copy } from "@/lib/access-copy";

/**
 * Shareholders | Capital Agreements | Installments | Capital Requests (migration 0031).
 * Setup is master data and DRAFT agreements only: nothing here receives or records money. The
 * existing capital request workspace is reused unchanged for the fourth area.
 */

type Tab = "shareholders" | "agreements" | "installments" | "requests";
const TABS: readonly { readonly id: Tab; readonly copy: Copy }[] = [
  { id: "shareholders", copy: { en: "Shareholders", fa: "سهامداران" } },
  { id: "agreements", copy: { en: "Capital Agreements", fa: "قراردادهای سرمایه" } },
  { id: "installments", copy: { en: "Installments", fa: "اقساط" } },
  { id: "requests", copy: { en: "Capital Requests", fa: "درخواست‌های سرمایه" } }
];

const BLOCKER_COPY: Readonly<Record<ShareholderSetupBlocker, Copy>> = {
  AGREEMENT_DRAFT: { en: "The agreement is still a draft", fa: "قرارداد هنوز پیش‌نویس است" },
  AGREEMENT_EVIDENCE_MISSING: { en: "No signed agreement document is recorded", fa: "سند امضاشدهٔ قرارداد ثبت نشده است" },
  REGISTRATION_NOT_VERIFIED: { en: "Formal capital registration is not verified", fa: "ثبت رسمی سرمایه تایید نشده است" },
  NO_FUNDING_DECISION: { en: "Finance has not recorded a funding decision", fa: "مالی هنوز تصمیم تمویل را ثبت نکرده است" },
  RECEIPT_PATH_NOT_OPERATIONAL: { en: "Receiving capital is not operational on company data yet", fa: "دریافت سرمایه هنوز روی داده‌های شرکت فعال نیست" }
};

const STATUS_COPY: Readonly<Record<string, Copy>> = {
  ACTIVE: { en: "Active", fa: "فعال" },
  DRAFT: { en: "Draft", fa: "پیش‌نویس" },
  PENDING_EVIDENCE: { en: "Waiting for evidence", fa: "در انتظار مدارک" },
  ELIGIBLE: { en: "Eligible", fa: "واجد شرایط" },
  SUSPENDED: { en: "Suspended", fa: "معلق" },
  CLOSED: { en: "Closed", fa: "بسته" },
  ARCHIVED: { en: "Archived", fa: "بایگانی" },
  PENDING_RECEIPT: { en: "Waiting for receipt", fa: "در انتظار دریافت" },
  RECEIVED_PENDING_APPROVAL: { en: "Received, waiting for approval", fa: "دریافت شده، در انتظار تایید" },
  POSTED: { en: "Posted", fa: "ثبت شده" },
  REVERSED: { en: "Reversed", fa: "برگشت خورده" },
  CANCELLED: { en: "Cancelled", fa: "لغو شده" }
};

const REGISTRATION_COPY: Readonly<Record<ShareholderSetupAgreement["registration"], Copy>> = {
  VERIFIED: { en: "Registration verified", fa: "ثبت رسمی تایید شده" },
  PENDING: { en: "Registration pending", fa: "ثبت رسمی در انتظار" },
  NONE: { en: "No formal registration yet", fa: "هنوز ثبت رسمی ندارد" }
};

const SETUP_ERROR_COPY: Readonly<Record<string, Copy>> = {
  REFERENCE_IN_USE: { en: "This reference is already used by another business party of your company.", fa: "این مرجع قبلاً برای طرف تجاری دیگری در شرکت شما استفاده شده است." },
  AGREEMENT_REFERENCE_IN_USE: { en: "Another capital agreement already uses this reference.", fa: "قرارداد سرمایهٔ دیگری همین مرجع را دارد." },
  SHAREHOLDER_HAS_POSTED_CAPITAL: { en: "This shareholder already has posted capital, so their details can no longer be corrected here.", fa: "برای این سهامدار سرمایه ثبت شده است؛ بنابراین مشخصات او دیگر در اینجا اصلاح نمی‌شود." },
  NOT_DRAFT: { en: "Only draft agreements and installments can be changed here.", fa: "فقط قراردادها و اقساط پیش‌نویس در اینجا قابل تغییرند." },
  PLAN_EXCEEDS_COMMITMENT: { en: "The installments would plan more than the committed capital.", fa: "مجموع اقساط از سرمایهٔ تعهدشده بیشتر می‌شود." },
  COMMITMENT_BELOW_PLAN: { en: "The committed capital cannot be lower than the installments already planned.", fa: "سرمایهٔ تعهدشده نمی‌تواند از اقساط برنامه‌ریزی‌شده کمتر باشد." },
  CURRENCY_FIXED: { en: "The currency cannot change once installments exist.", fa: "پس از ثبت اقساط، واحد پول تغییر نمی‌کند." },
  CURRENCY_NOT_ENABLED: { en: "This currency is not enabled.", fa: "این واحد پول فعال نیست." },
  FUTURE_DATE: { en: "This date cannot be in the future.", fa: "این تاریخ نمی‌تواند در آینده باشد." },
  INVALID_AMOUNT: { en: "Enter a positive amount such as 25000 or 25000.50.", fa: "مبلغ مثبت وارد کنید، مانند 25000 یا 25000.50." },
  INVALID_DOCUMENT: { en: "Enter the document reference, its date and its 64-character SHA-256 fingerprint.", fa: "مرجع سند، تاریخ آن و اثر انگشت ۶۴ حرفی SHA-256 آن را وارد کنید." },
  ALREADY_SUBMITTED_DIFFERENTLY: { en: "This form was already submitted with different details. Reload and try again.", fa: "این فرم قبلاً با جزئیات دیگری ارسال شده است. دوباره بارگذاری کنید." },
  IN_PROGRESS: { en: "This request is still being processed. Try again in a moment.", fa: "این درخواست هنوز در حال پردازش است. لحظه‌ای بعد دوباره تلاش کنید." },
  NOT_FOUND: { en: "This record was not found for your company.", fa: "این مورد برای شرکت شما پیدا نشد." },
  VALIDATION_FAILED: { en: "Some details are missing, too long or not valid.", fa: "برخی جزئیات ناقص، بیش از حد طولانی یا نادرست است." },
  DUPLICATE: { en: "This record already exists.", fa: "این مورد قبلاً وجود دارد." }
};

function kabulToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kabul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function money(amount: string, currency: string, fa: boolean): string {
  return fa ? `${exactDecimal(amount)} ${currency}` : `${currency} ${exactDecimal(amount)}`;
}

type Form =
  | { kind: "new-shareholder"; key: string; name: string; reference: string; since: string }
  | { kind: "correct-shareholder"; id: string; name: string; reference: string }
  | { kind: "new-agreement"; key: string; shareholder: string; reference: string; amount: string; currency: string; effectiveOn: string; partial: boolean }
  | { kind: "edit-agreement"; id: string; reference: string; amount: string; currency: string; effectiveOn: string; partial: boolean }
  | { kind: "document"; id: string; key: string; reference: string; date: string; sha256: string }
  | { kind: "new-installment"; key: string; agreement: string; amount: string; dueOn: string }
  | { kind: "edit-installment"; id: string; amount: string; dueOn: string }
  | { kind: "cancel-installment"; id: string; reason: string };

export function ShareholderSetupWorkspace() {
  const { locale } = useLocale();
  const fa = locale === "fa";
  const t = useCallback((copy: Copy) => copy[locale], [locale]);
  const [view, setView] = useState<SetupView | null>(null);
  const [gate, setGate] = useState<"signed-out" | "denied" | null>(null);
  const [tab, setTab] = useState<Tab>("shareholders");
  const [form, setForm] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const apply = useCallback((result: Awaited<ReturnType<typeof api<SetupView>>>, first: boolean) => {
    if (!result.ok) {
      const next = result.status === 401 ? "signed-out" : result.status === 403 ? "denied" : null;
      setGate(next);
      // People who may only open capital requests land on that area.
      if (next === "denied" && first) setTab("requests");
      if (next === null) setMessage({ tone: "error", text: errorText(result.error, locale) });
      return;
    }
    setGate(null);
    setView(result.data);
    // Someone who opens capital requests but does not set up shareholders starts on their own work.
    if (first && !result.data.permissions.canManage && result.data.permissions.canCreateRequests) setTab("requests");
  }, [locale]);

  const reload = useCallback(async () => apply(await api<SetupView>("/api/v1/shareholder/setup"), false), [apply]);
  useEffect(() => {
    let current = true;
    void api<SetupView>("/api/v1/shareholder/setup").then((result) => { if (current) apply(result, true); });
    return () => { current = false; };
  }, [apply]);

  const run = async (body: Record<string, unknown>, success: Copy) => {
    setBusy(true); setMessage(null);
    const result = await api<Record<string, unknown>>("/api/v1/shareholder/setup", "POST", body);
    setBusy(false);
    if (!result.ok) {
      if (result.status === 401) { setGate("signed-out"); return; }
      const copy = SETUP_ERROR_COPY[result.error.code];
      setMessage({ tone: "error", text: copy ? t(copy) : errorText(result.error, locale) });
      return;
    }
    setForm(null);
    setMessage({ tone: "ok", text: t(success) });
    await reload();
  };

  if (gate === "signed-out") {
    return <div className="module-workspace"><AccessGate state="signed-out" fa={fa} what={{ en: "", fa: "" }} /></div>;
  }

  const canManage = view?.permissions.canManage === true;
  const today = view?.today ?? kabulToday();

  return (
    <div className="module-workspace shareholder-workspace shareholder-setup">
      <StageZeroPageHeader icon="coins"
        eyebrow={{ en: `Shareholders · ${view?.legalEntity?.name ?? ""}`, fa: `سهامداران · ${view?.legalEntity?.name ?? ""}` }}
        title={{ en: "Shareholder capital", fa: "سرمایه سهامداران" }}
        description={{ en: "Shareholders, their capital agreements and installment plans, and capital requests.", fa: "سهامداران، قراردادهای سرمایه و برنامهٔ اقساط آن‌ها، و درخواست‌های سرمایه." }} />

      <section className="finance-boundary-banner" data-testid="receipt-not-operational"><span><AppIcon name="shield" size={22} /></span><div>
        <p>{fa ? "هنوز هیچ پولی دریافت نمی‌شود" : "NO MONEY IS RECEIVED YET"}</p>
        <strong>{fa
          ? "دریافت سرمایه (درخواست سرمایه ← خزانه ← مالی ← دفتر کل) روی داده‌های واقعی شرکت هنوز فعال نیست و فقط در محیط آزمایشی مصنوعی اجرا می‌شود. قراردادهایی که اینجا تنظیم می‌کنید پیش‌نویس می‌مانند و هیچ رقمی در خزانه یا دفاتر ثبت نمی‌شود."
          : "Receiving capital (Capital Request → Treasury → Finance → General Ledger) is not operational on real company data yet; it runs only in the synthetic sandbox. Agreements set up here stay draft, and nothing is recorded in Treasury or the books."}</strong>
      </div><em>{fa ? "فقط تنظیمات" : "Setup only"}</em></section>

      {message ? <div className={`treasury-message ${message.tone === "ok" ? "success" : "error"}`} role="status"><AppIcon name={message.tone === "ok" ? "shield" : "alert"} size={16} /><span>{message.text}</span><button onClick={() => setMessage(null)} aria-label={fa ? "بستن" : "Dismiss"}>×</button></div> : null}

      <div className="admin-tabs shareholder-tabs" role="tablist" aria-label={fa ? "بخش‌های سهامداران" : "Shareholder areas"}>
        {TABS.map((entry) => (
          <button key={entry.id} role="tab" id={`shareholder-tab-${entry.id}`} aria-selected={tab === entry.id} aria-controls={`shareholder-panel-${entry.id}`}
            onClick={() => { setTab(entry.id); setForm(null); setMessage(null); }}>
            {t(entry.copy)}
            {view && entry.id === "shareholders" ? <b>{view.shareholders.length}</b> : null}
            {view && entry.id === "agreements" ? <b>{view.agreements.length}</b> : null}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`shareholder-panel-${tab}`} aria-labelledby={`shareholder-tab-${tab}`}>
        {tab === "requests" ? (
          <>
            <p className="admin-hint shareholder-request-note">{fa
              ? "درخواست‌های سرمایه همان روند قبلی است. تا تأیید جداگانه، دریافت نقد و ثبت آن فقط برای داده‌های آزمایشی مصنوعی کار می‌کند؛ قراردادهای پیش‌نویس اینجا درخواست‌پذیر نیستند."
              : "Capital requests are the existing workflow. Until separately approved, receiving and posting the cash works for synthetic sandbox data only; draft agreements set up here cannot be requested."}</p>
            <ShareholderRequestWorkspace embedded />
          </>
        ) : gate === "denied" ? (
          <AccessGate state="denied" fa={fa} what={{ en: "Shareholders need the “Set up shareholders and capital agreements” or “View shareholder agreements” permission.", fa: "بخش سهامداران به صلاحیت «تنظیم سهامداران و قراردادهای سرمایه» یا «مشاهده قراردادهای سهامداران» نیاز دارد." }} />
        ) : view === null ? (
          <p className="treasury-placeholder">{fa ? "در حال بارگذاری…" : "Loading…"}</p>
        ) : (
          <>
            {!canManage ? <p className="admin-hint">{fa ? "شما فقط می‌توانید ببینید؛ تنظیم به صلاحیت «تنظیم سهامداران و قراردادهای سرمایه» نیاز دارد." : "You can view only; making changes needs the “Set up shareholders and capital agreements” permission."}</p> : null}
            {tab === "shareholders" ? <ShareholdersArea view={view} fa={fa} t={t} locale={locale} canManage={canManage} today={today} form={form} setForm={setForm} busy={busy} run={run} /> : null}
            {tab === "agreements" ? <AgreementsArea view={view} fa={fa} t={t} locale={locale} canManage={canManage} today={today} form={form} setForm={setForm} busy={busy} run={run} /> : null}
            {tab === "installments" ? <InstallmentsArea view={view} fa={fa} t={t} locale={locale} canManage={canManage} today={today} form={form} setForm={setForm} busy={busy} run={run} /> : null}
          </>
        )}
      </div>
    </div>
  );
}

interface AreaProps {
  readonly view: SetupView; readonly fa: boolean; readonly t: (copy: Copy) => string; readonly locale: "en" | "fa";
  readonly canManage: boolean; readonly today: string; readonly form: Form | null; readonly setForm: (form: Form | null) => void;
  readonly busy: boolean; readonly run: (body: Record<string, unknown>, success: Copy) => Promise<void>;
}

function submitWith(handler: () => void) {
  return (event: FormEvent) => { event.preventDefault(); handler(); };
}

function FormActions({ fa, busy, submit, onCancel }: { readonly fa: boolean; readonly busy: boolean; readonly submit: Copy; readonly onCancel: () => void }) {
  return (
    <div className="rates-actions">
      <button type="submit" className="treasury-button gold" disabled={busy}>{fa ? submit.fa : submit.en}</button>
      <button type="button" className="treasury-button" onClick={onCancel}>{fa ? "لغو" : "Cancel"}</button>
    </div>
  );
}

function Field({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return <label><span>{label}</span>{children}</label>;
}

function ShareholdersArea({ view, fa, t, canManage, today, form, setForm, busy, run }: AreaProps) {
  const active = form?.kind === "new-shareholder" ? form : null;
  const correcting = form?.kind === "correct-shareholder" ? form : null;
  return (
    <section className="shareholder-area" aria-label={fa ? "سهامداران" : "Shareholders"}>
      {canManage && active === null ? (
        <button type="button" className="treasury-button gold shareholder-add" onClick={() => setForm({ kind: "new-shareholder", key: crypto.randomUUID(), name: "", reference: "", since: today })}>
          <AppIcon name="coins" size={15} /> {fa ? "افزودن سهامدار" : "Add shareholder"}</button>
      ) : null}
      {active ? (
        <form className="admin-form shareholder-form" aria-label={fa ? "سهامدار جدید" : "New shareholder"} onSubmit={submitWith(() => void run(
          { action: "create-shareholder", displayName: active.name, externalReference: active.reference, shareholderSince: active.since, idempotencyKey: active.key },
          { en: `${active.name.trim()} was added as an active shareholder.`, fa: `${active.name.trim()} به‌عنوان سهامدار فعال اضافه شد.` }))}>
          <h3>{fa ? "سهامدار جدید" : "New shareholder"}</h3>
          <Field label={fa ? "نام کامل" : "Full name"}><input value={active.name} maxLength={160} required onChange={(event) => setForm({ ...active, name: event.target.value })} /></Field>
          <Field label={fa ? "مرجع (اختیاری، در کل شرکت یکتا)" : "Reference (optional, unique in the company)"}><input dir="ltr" value={active.reference} maxLength={60} onChange={(event) => setForm({ ...active, reference: event.target.value })} /></Field>
          <Field label={fa ? "سهامدار از تاریخ" : "Shareholder since"}><input type="date" value={active.since} max={today} required onChange={(event) => setForm({ ...active, since: event.target.value })} /></Field>
          <FormActions fa={fa} busy={busy} submit={{ en: "Add shareholder", fa: "افزودن سهامدار" }} onCancel={() => setForm(null)} />
        </form>
      ) : null}
      {view.shareholders.length === 0 ? <p className="treasury-placeholder">{fa ? "هنوز هیچ سهامداری ثبت نشده است." : "No shareholder has been added yet."}</p> : (
        <table className="shareholder-installments shareholder-list">
          <thead><tr><th>{fa ? "نام" : "Name"}</th><th>{fa ? "مرجع" : "Reference"}</th><th>{fa ? "از تاریخ" : "Since"}</th><th>{fa ? "وضعیت" : "Status"}</th><th>{fa ? "قراردادها" : "Agreements"}</th><th /></tr></thead>
          <tbody>{view.shareholders.map((holder) => (
            <ShareholderRow key={holder.id} holder={holder} fa={fa} t={t} canManage={canManage} correcting={correcting?.id === holder.id ? correcting : null}
              setForm={setForm} busy={busy} run={run} />
          ))}</tbody>
        </table>
      )}
    </section>
  );
}

function ShareholderRow({ holder, fa, t, canManage, correcting, setForm, busy, run }: {
  readonly holder: ShareholderSetupShareholder; readonly fa: boolean; readonly t: (copy: Copy) => string; readonly canManage: boolean;
  readonly correcting: Extract<Form, { kind: "correct-shareholder" }> | null; readonly setForm: (form: Form | null) => void;
  readonly busy: boolean; readonly run: AreaProps["run"];
}) {
  return (
    <>
      <tr>
        <td data-label={fa ? "نام" : "Name"}><strong>{holder.name}</strong></td>
        <td data-label={fa ? "مرجع" : "Reference"} dir="ltr">{holder.reference ?? "—"}</td>
        <td data-label={fa ? "از تاریخ" : "Since"}>{holder.since ?? "—"}</td>
        <td data-label={fa ? "وضعیت" : "Status"}><em className="treasury-chip">{t(STATUS_COPY[holder.status] ?? { en: holder.status, fa: holder.status })}</em></td>
        <td data-label={fa ? "قراردادها" : "Agreements"}>{holder.agreementCount}</td>
        <td data-label="">
          {canManage && holder.correctable ? (
            <button type="button" className="treasury-button" onClick={() => setForm({ kind: "correct-shareholder", id: holder.id, name: holder.name, reference: holder.reference ?? "" })}>{fa ? "اصلاح" : "Correct"}</button>
          ) : !holder.correctable ? <small className="shareholder-locked">{fa ? "سرمایه ثبت شده؛ اصلاح بسته است" : "Capital posted; corrections closed"}</small> : null}
        </td>
      </tr>
      {correcting ? (
        <tr className="shareholder-form-row"><td colSpan={6}>
          <form className="admin-form shareholder-form" aria-label={fa ? "اصلاح سهامدار" : "Correct shareholder"} onSubmit={submitWith(() => void run(
            { action: "correct-shareholder", shareholderProfileId: holder.id, displayName: correcting.name, externalReference: correcting.reference },
            { en: "The shareholder's details were corrected.", fa: "مشخصات سهامدار اصلاح شد." }))}>
            <Field label={fa ? "نام کامل" : "Full name"}><input value={correcting.name} maxLength={160} required onChange={(event) => setForm({ ...correcting, name: event.target.value })} /></Field>
            <Field label={fa ? "مرجع" : "Reference"}><input dir="ltr" value={correcting.reference} maxLength={60} onChange={(event) => setForm({ ...correcting, reference: event.target.value })} /></Field>
            <p className="admin-hint">{fa ? "اصلاح فقط تا پیش از ثبت نخستین سرمایه ممکن است و در سابقهٔ بررسی ثبت می‌شود." : "Corrections are possible only before any capital is posted, and are kept in the audit trail."}</p>
            <FormActions fa={fa} busy={busy} submit={{ en: "Save correction", fa: "ذخیرهٔ اصلاح" }} onCancel={() => setForm(null)} />
          </form>
        </td></tr>
      ) : null}
    </>
  );
}

function AgreementsArea({ view, fa, t, locale, canManage, today, form, setForm, busy, run }: AreaProps) {
  const creating = form?.kind === "new-agreement" ? form : null;
  const activeHolders = view.shareholders.filter((holder) => holder.status === "ACTIVE");
  return (
    <section className="shareholder-area" aria-label={fa ? "قراردادهای سرمایه" : "Capital agreements"}>
      <section className="shareholder-totals" aria-label={fa ? "جمع به تفکیک واحد پول" : "Totals by currency"}>
        {view.totalsByCurrency.map((total) => (
          <div key={total.currency} className="module-content-card shareholder-total">
            <p>{total.currency}</p>
            <strong>{money(total.committed, total.currency, fa)}</strong>
            <small>{fa ? "دریافت‌شده" : "received"} {money(total.received, total.currency, fa)} · {fa ? "باقی" : "remaining"} {money(total.remaining, total.currency, fa)}</small>
          </div>
        ))}
      </section>
      {canManage && creating === null ? (
        <button type="button" className="treasury-button gold shareholder-add" disabled={activeHolders.length === 0}
          onClick={() => setForm({ kind: "new-agreement", key: crypto.randomUUID(), shareholder: activeHolders[0]?.id ?? "", reference: "", amount: "",
            currency: view.legalEntity?.baseCurrency ?? view.currencies[0] ?? "USD", effectiveOn: today, partial: false })}>
          <AppIcon name="coins" size={15} /> {fa ? "قرارداد سرمایهٔ جدید" : "New capital agreement"}</button>
      ) : null}
      {canManage && activeHolders.length === 0 ? <p className="admin-hint">{fa ? "ابتدا یک سهامدار اضافه کنید." : "Add a shareholder first."}</p> : null}
      {creating ? (
        <form className="admin-form shareholder-form" aria-label={fa ? "قرارداد سرمایهٔ جدید" : "New capital agreement"} onSubmit={submitWith(() => void run(
          { action: "create-agreement", shareholderProfileId: creating.shareholder, agreementReference: creating.reference, committedAmount: creating.amount.trim(),
            currencyCode: creating.currency, effectiveOn: creating.effectiveOn, partialInstallmentsAllowed: creating.partial, idempotencyKey: creating.key },
          { en: `Draft agreement ${creating.reference.trim()} was created.`, fa: `پیش‌نویس قرارداد ${creating.reference.trim()} ایجاد شد.` }))}>
          <h3>{fa ? "قرارداد سرمایهٔ جدید (پیش‌نویس)" : "New capital agreement (draft)"}</h3>
          <Field label={fa ? "سهامدار" : "Shareholder"}>
            <select value={creating.shareholder} required onChange={(event) => setForm({ ...creating, shareholder: event.target.value })}>
              {activeHolders.map((holder) => <option key={holder.id} value={holder.id}>{holder.name}{holder.reference ? ` · ${holder.reference}` : ""}</option>)}
            </select></Field>
          <AgreementFields fa={fa} currencies={view.currencies} value={creating} onChange={(next) => setForm({ ...creating, ...next })} />
          <FormActions fa={fa} busy={busy} submit={{ en: "Create draft agreement", fa: "ایجاد پیش‌نویس قرارداد" }} onCancel={() => setForm(null)} />
        </form>
      ) : null}
      {view.agreements.length === 0 ? <p className="treasury-placeholder">{fa ? "هنوز هیچ قرارداد سرمایه‌ای وجود ندارد." : "There is no capital agreement yet."}</p> : null}
      {view.agreements.map((agreement) => (
        <AgreementCard key={agreement.id} agreement={agreement} view={view} fa={fa} t={t} locale={locale} canManage={canManage} today={today} form={form} setForm={setForm} busy={busy} run={run} />
      ))}
    </section>
  );
}

function AgreementFields({ fa, currencies, value, onChange, currencyLocked = false }: {
  readonly fa: boolean; readonly currencies: readonly string[];
  readonly value: { reference: string; amount: string; currency: string; effectiveOn: string; partial: boolean };
  readonly onChange: (next: Partial<{ reference: string; amount: string; currency: string; effectiveOn: string; partial: boolean }>) => void;
  readonly currencyLocked?: boolean;
}) {
  return (
    <>
      <Field label={fa ? "مرجع قرارداد" : "Agreement reference"}><input dir="ltr" value={value.reference} maxLength={60} required onChange={(event) => onChange({ reference: event.target.value })} /></Field>
      <Field label={fa ? "سرمایهٔ تعهدشده" : "Committed capital"}><input dir="ltr" inputMode="decimal" value={value.amount} required pattern="(0|[1-9][0-9]*)(\.[0-9]+)?" onChange={(event) => onChange({ amount: event.target.value })} /></Field>
      <Field label={fa ? "واحد پول" : "Currency"}>
        <select value={value.currency} disabled={currencyLocked} onChange={(event) => onChange({ currency: event.target.value })}>
          {currencies.map((code) => <option key={code} value={code}>{code}</option>)}
        </select></Field>
      <Field label={fa ? "تاریخ اعتبار" : "Effective on"}><input type="date" value={value.effectiveOn} required onChange={(event) => onChange({ effectiveOn: event.target.value })} /></Field>
      <label className="shareholder-check"><input type="checkbox" checked={value.partial} onChange={(event) => onChange({ partial: event.target.checked })} />
        <span>{fa ? "پرداخت قسمتی یک قسط مجاز است" : "Partial payment of an installment is allowed"}</span></label>
    </>
  );
}

function AgreementCard({ agreement, view, fa, t, locale, canManage, today, form, setForm, busy, run }: AreaProps & { readonly agreement: ShareholderSetupAgreement }) {
  const editing = form?.kind === "edit-agreement" && form.id === agreement.id ? form : null;
  const document = form?.kind === "document" && form.id === agreement.id ? form : null;
  const figures: readonly [Copy, string][] = [
    [{ en: "Committed", fa: "تعهدشده" }, agreement.committed],
    [{ en: "Planned in installments", fa: "برنامه‌ریزی در اقساط" }, agreement.planned],
    [{ en: "Requested, not received", fa: "درخواست‌شده، دریافت‌نشده" }, agreement.requested],
    [{ en: "Received (posted)", fa: "دریافت‌شده (ثبت‌شده)" }, agreement.received],
    [{ en: "Remaining", fa: "باقی‌مانده" }, agreement.remaining]
  ];
  return (
    <article className="module-content-card shareholder-agreement" aria-label={agreement.reference} data-agreement={agreement.reference}>
      <div className="module-card-heading"><div><p>{agreement.shareholderName} · {agreement.currency}</p><h2 dir="ltr">{agreement.reference}</h2></div>
        <span>{fa ? "از" : "Effective"} {agreement.effectiveOn}</span></div>
      <p className="shareholder-chips">
        <em className="treasury-chip">{t(STATUS_COPY[agreement.status] ?? { en: agreement.status, fa: agreement.status })}</em>
        <em className={`treasury-chip ${agreement.registration === "VERIFIED" ? "" : "muted"}`}>{t(REGISTRATION_COPY[agreement.registration])}</em>
        {agreement.partialAllowed ? <em className="treasury-chip muted">{fa ? "پرداخت قسمتی مجاز" : "Partial payments allowed"}</em> : null}
      </p>
      <dl className="shareholder-figures">
        {figures.map(([label, amount]) => <div key={label.en}><dt>{t(label)}</dt><dd dir="ltr">{money(amount, agreement.currency, false)}</dd></div>)}
      </dl>
      <div className="shareholder-why" aria-label={fa ? "چرا هنوز سرمایه دریافت نمی‌شود" : "Why no capital can be received yet"}>
        <p>{fa ? "چرا هنوز سرمایه دریافت نمی‌شود" : "Why no capital can be received yet"}</p>
        <ul>{agreement.requestBlockers.map((blocker) => <li key={blocker}>{t(BLOCKER_COPY[blocker])}</li>)}</ul>
      </div>
      <div className="shareholder-documents">
        <p>{fa ? "سند امضاشدهٔ قرارداد" : "Signed agreement document"}</p>
        {agreement.documents.length === 0 ? <small>{fa ? "هنوز سندی ثبت نشده است." : "No document recorded yet."}</small> : (
          <ul>{agreement.documents.map((doc) => (
            <li key={doc.id}><strong>v{doc.version} · {doc.reference}</strong>
              <small>{fa ? "تاریخ سند" : "Document date"} {doc.documentDate} · {doc.recordedBy} · {formatWhen(doc.recordedAt, locale)}</small>
              <code dir="ltr" title="SHA-256">{doc.sha256}</code></li>
          ))}</ul>
        )}
        <small>{fa ? "فقط مرجع، تاریخ و اثر انگشت سند نگه داشته می‌شود؛ فایل ذخیره نمی‌شود. ثبت رسمی سرمایه جداگانه است." : "Only the reference, date and fingerprint are kept; no file is stored. Formal capital registration is separate."}</small>
      </div>
      {canManage && !editing && !document ? (
        <div className="rates-actions">
          {agreement.editable ? <button type="button" className="treasury-button" onClick={() => setForm({ kind: "edit-agreement", id: agreement.id, reference: agreement.reference,
            amount: agreement.committed, currency: agreement.currency, effectiveOn: agreement.effectiveOn, partial: agreement.partialAllowed })}>{fa ? "ویرایش پیش‌نویس" : "Edit draft"}</button> : null}
          {["DRAFT", "PENDING_EVIDENCE"].includes(agreement.status) ? <button type="button" className="treasury-button" onClick={() => setForm({ kind: "document", id: agreement.id, key: crypto.randomUUID(), reference: "", date: today, sha256: "" })}>
            {fa ? "ثبت سند قرارداد" : "Record agreement document"}</button> : null}
          {!agreement.editable ? <small className="shareholder-locked">{fa ? "قرارداد دیگر پیش‌نویس نیست؛ ویرایش بسته است." : "No longer a draft; editing is closed."}</small> : null}
        </div>
      ) : null}
      {editing ? (
        <form className="admin-form shareholder-form" aria-label={fa ? "ویرایش پیش‌نویس قرارداد" : "Edit draft agreement"} onSubmit={submitWith(() => void run(
          { action: "update-agreement", capitalAgreementId: agreement.id, agreementReference: editing.reference, committedAmount: editing.amount.trim(),
            currencyCode: editing.currency, effectiveOn: editing.effectiveOn, partialInstallmentsAllowed: editing.partial },
          { en: "The draft agreement was updated.", fa: "پیش‌نویس قرارداد به‌روز شد." }))}>
          <AgreementFields fa={fa} currencies={view.currencies} value={editing} currencyLocked={agreement.installments.length > 0} onChange={(next) => setForm({ ...editing, ...next })} />
          {agreement.installments.length > 0 ? <p className="admin-hint">{fa ? "پس از ثبت اقساط، واحد پول ثابت است." : "The currency is fixed once installments exist."}</p> : null}
          <FormActions fa={fa} busy={busy} submit={{ en: "Save draft", fa: "ذخیرهٔ پیش‌نویس" }} onCancel={() => setForm(null)} />
        </form>
      ) : null}
      {document ? (
        <form className="admin-form shareholder-form" aria-label={fa ? "ثبت سند قرارداد" : "Record agreement document"} onSubmit={submitWith(() => void run(
          { action: "record-agreement-document", capitalAgreementId: agreement.id, documentReference: document.reference, documentDate: document.date,
            sha256: document.sha256.trim(), idempotencyKey: document.key },
          { en: "The agreement document was recorded for this agreement.", fa: "سند قرارداد برای همین قرارداد ثبت شد." }))}>
          <Field label={fa ? "مرجع سند" : "Document reference"}><input value={document.reference} maxLength={200} required onChange={(event) => setForm({ ...document, reference: event.target.value })} /></Field>
          <Field label={fa ? "تاریخ امضای سند" : "Signing date"}><input type="date" value={document.date} max={today} required onChange={(event) => setForm({ ...document, date: event.target.value })} /></Field>
          <Field label={fa ? "اثر انگشت SHA-256 (۶۴ حرف)" : "SHA-256 fingerprint (64 characters)"}><input dir="ltr" value={document.sha256} required pattern="[0-9a-fA-F]{64}" maxLength={64} onChange={(event) => setForm({ ...document, sha256: event.target.value })} /></Field>
          <FormActions fa={fa} busy={busy} submit={{ en: "Record document", fa: "ثبت سند" }} onCancel={() => setForm(null)} />
        </form>
      ) : null}
    </article>
  );
}

function InstallmentsArea({ view, fa, t, canManage, form, setForm, busy, run }: AreaProps) {
  const drafts = view.agreements.filter((agreement) => agreement.editable);
  const adding = form?.kind === "new-installment" ? form : null;
  const target = useMemo(() => view.agreements.find((agreement) => agreement.id === adding?.agreement), [adding?.agreement, view.agreements]);
  return (
    <section className="shareholder-area" aria-label={fa ? "اقساط" : "Installments"}>
      {canManage && adding === null ? (
        <button type="button" className="treasury-button gold shareholder-add" disabled={drafts.length === 0}
          onClick={() => setForm({ kind: "new-installment", key: crypto.randomUUID(), agreement: drafts[0]?.id ?? "", amount: "", dueOn: "" })}>
          <AppIcon name="coins" size={15} /> {fa ? "افزودن قسط" : "Add installment"}</button>
      ) : null}
      {canManage && drafts.length === 0 ? <p className="admin-hint">{fa ? "اقساط فقط برای قرارداد پیش‌نویس برنامه‌ریزی می‌شوند." : "Installments can be planned only for a draft agreement."}</p> : null}
      {adding ? (
        <form className="admin-form shareholder-form" aria-label={fa ? "قسط جدید" : "New installment"} onSubmit={submitWith(() => void run(
          { action: "add-installment", capitalAgreementId: adding.agreement, expectedAmount: adding.amount.trim(), dueOn: adding.dueOn, idempotencyKey: adding.key },
          { en: "The installment was added to the plan.", fa: "قسط به برنامه اضافه شد." }))}>
          <Field label={fa ? "قرارداد پیش‌نویس" : "Draft agreement"}>
            <select value={adding.agreement} required onChange={(event) => setForm({ ...adding, agreement: event.target.value })}>
              {drafts.map((agreement) => <option key={agreement.id} value={agreement.id}>{agreement.reference} · {agreement.shareholderName} · {agreement.currency}</option>)}
            </select></Field>
          <Field label={fa ? `مبلغ قسط (${target?.currency ?? ""})` : `Installment amount (${target?.currency ?? ""})`}>
            <input dir="ltr" inputMode="decimal" value={adding.amount} required pattern="(0|[1-9][0-9]*)(\.[0-9]+)?" onChange={(event) => setForm({ ...adding, amount: event.target.value })} /></Field>
          <Field label={fa ? "سررسید (اختیاری)" : "Due date (optional)"}><input type="date" value={adding.dueOn} onChange={(event) => setForm({ ...adding, dueOn: event.target.value })} /></Field>
          {target ? <p className="admin-hint" dir={fa ? "rtl" : "ltr"}>{fa ? "هنوز قابل برنامه‌ریزی:" : "Still available to plan:"} <span dir="ltr">{money(subtract(target.committed, target.planned), target.currency, false)}</span> · {fa ? "واحد پول از قرارداد گرفته می‌شود." : "The currency comes from the agreement."}</p> : null}
          <FormActions fa={fa} busy={busy} submit={{ en: "Add installment", fa: "افزودن قسط" }} onCancel={() => setForm(null)} />
        </form>
      ) : null}
      {view.agreements.length === 0 ? <p className="treasury-placeholder">{fa ? "هنوز هیچ قرارداد سرمایه‌ای وجود ندارد." : "There is no capital agreement yet."}</p> : null}
      {view.agreements.map((agreement) => (
        <article key={agreement.id} className="module-content-card shareholder-agreement" aria-label={`${agreement.reference} installments`}>
          <div className="module-card-heading"><div><p>{agreement.shareholderName} · {agreement.currency}</p><h2 dir="ltr">{agreement.reference}</h2></div>
            <span dir="ltr">{money(agreement.planned, agreement.currency, false)} / {money(agreement.committed, agreement.currency, false)}</span></div>
          {agreement.installments.length === 0 ? <p className="treasury-placeholder">{fa ? "هنوز قسطی برنامه‌ریزی نشده است." : "No installment planned yet."}</p> : (
            <table className="shareholder-installments">
              <thead><tr><th>#</th><th>{fa ? "مبلغ" : "Amount"}</th><th>{fa ? "سررسید" : "Due"}</th><th>{fa ? "وضعیت" : "Status"}</th><th /></tr></thead>
              <tbody>{agreement.installments.map((installment) => (
                <InstallmentRow key={installment.id} installment={installment} fa={fa} t={t} canManage={canManage} form={form} setForm={setForm} busy={busy} run={run} />
              ))}</tbody>
            </table>
          )}
        </article>
      ))}
    </section>
  );
}

function InstallmentRow({ installment, fa, t, canManage, form, setForm, busy, run }: {
  readonly installment: ShareholderSetupInstallment; readonly fa: boolean; readonly t: (copy: Copy) => string; readonly canManage: boolean;
  readonly form: Form | null; readonly setForm: (form: Form | null) => void; readonly busy: boolean; readonly run: AreaProps["run"];
}) {
  const editing = form?.kind === "edit-installment" && form.id === installment.id ? form : null;
  const cancelling = form?.kind === "cancel-installment" && form.id === installment.id ? form : null;
  return (
    <>
      <tr className={installment.status === "CANCELLED" ? "shareholder-cancelled" : undefined}>
        <td data-label="#">{installment.sequence}</td>
        <td data-label={fa ? "مبلغ" : "Amount"} dir="ltr">{money(installment.amount, installment.currency, false)}</td>
        <td data-label={fa ? "سررسید" : "Due"}>{installment.dueOn ?? "—"}</td>
        <td data-label={fa ? "وضعیت" : "Status"}><em className="treasury-chip">{t(STATUS_COPY[installment.status] ?? { en: installment.status, fa: installment.status })}</em></td>
        <td data-label="">{canManage && installment.editable && !editing && !cancelling ? (
          <span className="shareholder-row-actions">
            <button type="button" className="treasury-button" onClick={() => setForm({ kind: "edit-installment", id: installment.id, amount: installment.amount, dueOn: installment.dueOn ?? "" })}>{fa ? "ویرایش" : "Edit"}</button>
            <button type="button" className="treasury-button" onClick={() => setForm({ kind: "cancel-installment", id: installment.id, reason: "" })}>{fa ? "لغو قسط" : "Cancel installment"}</button>
          </span>) : null}</td>
      </tr>
      {editing ? (
        <tr className="shareholder-form-row"><td colSpan={5}>
          <form className="admin-form shareholder-form" aria-label={fa ? "ویرایش قسط" : "Edit installment"} onSubmit={submitWith(() => void run(
            { action: "update-installment", capitalInstallmentId: installment.id, expectedAmount: editing.amount.trim(), dueOn: editing.dueOn },
            { en: "The installment was updated.", fa: "قسط به‌روز شد." }))}>
            <Field label={fa ? `مبلغ (${installment.currency})` : `Amount (${installment.currency})`}><input dir="ltr" inputMode="decimal" value={editing.amount} required onChange={(event) => setForm({ ...editing, amount: event.target.value })} /></Field>
            <Field label={fa ? "سررسید" : "Due date"}><input type="date" value={editing.dueOn} onChange={(event) => setForm({ ...editing, dueOn: event.target.value })} /></Field>
            <FormActions fa={fa} busy={busy} submit={{ en: "Save installment", fa: "ذخیرهٔ قسط" }} onCancel={() => setForm(null)} />
          </form>
        </td></tr>
      ) : null}
      {cancelling ? (
        <tr className="shareholder-form-row"><td colSpan={5}>
          <form className="admin-form shareholder-form" aria-label={fa ? "لغو قسط" : "Cancel installment"} onSubmit={submitWith(() => void run(
            { action: "cancel-installment", capitalInstallmentId: installment.id, reason: cancelling.reason },
            { en: "The installment was cancelled; it no longer counts toward the plan.", fa: "قسط لغو شد و دیگر در برنامه شمرده نمی‌شود." }))}>
            <Field label={fa ? "دلیل لغو" : "Reason for cancelling"}><input value={cancelling.reason} minLength={3} maxLength={300} required onChange={(event) => setForm({ ...cancelling, reason: event.target.value })} /></Field>
            <p className="admin-hint">{fa ? "قسط حذف نمی‌شود؛ به‌عنوان لغوشده باقی می‌ماند." : "The installment is not deleted; it stays visible as cancelled."}</p>
            <FormActions fa={fa} busy={busy} submit={{ en: "Cancel installment", fa: "لغو قسط" }} onCancel={() => setForm(null)} />
          </form>
        </td></tr>
      ) : null}
    </>
  );
}

/** Exact decimal subtraction for display (a >= b), without floating point. */
function subtract(a: string, b: string): string {
  const scale = Math.max((a.split(".")[1] ?? "").length, (b.split(".")[1] ?? "").length);
  const units = (value: string) => BigInt(value.replace(".", "") + "0".repeat(scale - (value.split(".")[1] ?? "").length));
  const difference = units(a) - units(b);
  const negative = difference < 0n;
  const digits = (negative ? -difference : difference).toString().padStart(scale + 1, "0");
  const whole = scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  return `${negative ? "-" : ""}${whole}`;
}
