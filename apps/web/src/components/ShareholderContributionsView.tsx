"use client";

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";

import type {
  ContributionAssetCategory, ContributionType, ShareholderContribution, ShareholderContributionsWorkspace, ShareholderWithContributions
} from "@abos/contracts";
import { CONTRIBUTION_ASSET_CATEGORIES } from "@abos/contracts";

import { AccessGate, api, errorText } from "@/components/AdminUsersWorkspace";
import { AppIcon } from "@/components/AppIcon";
import { exactDecimal } from "@/components/ExchangeRatesWorkspace";
import type { Copy } from "@/lib/access-copy";

/**
 * The simple Shareholders view (0035): shareholder → contributions → add contribution.
 * DECLARATION ONLY. Saving a contribution records what was declared; it never receives cash, values an
 * asset, classifies credit or posts anything. "None yet" saves nothing. A legacy cash capital agreement
 * is shown once, as a separate "legacy cash commitment", and is never counted with contributions.
 */

type Choice = ContributionType | "NONE";

const CHOICES: readonly { readonly id: Choice; readonly copy: Copy }[] = [
  { id: "CASH", copy: { en: "Cash", fa: "پول نقد" } },
  { id: "IN_KIND", copy: { en: "Asset", fa: "جنس یا دارایی" } },
  { id: "CREDIT", copy: { en: "Credit", fa: "اعتبار" } },
  { id: "NONE", copy: { en: "None yet", fa: "فعلاً هیچ آورده‌ای ندارد" } }
];

const TYPE_COPY: Readonly<Record<ContributionType, Copy>> = {
  CASH: { en: "Cash", fa: "پول نقد" },
  IN_KIND: { en: "Asset", fa: "جنس یا دارایی" },
  CREDIT: { en: "Credit", fa: "اعتبار" }
};

const CATEGORY_COPY: Readonly<Record<ContributionAssetCategory, Copy>> = {
  LAND_PROPERTY: { en: "Land / property", fa: "زمین / ملک" },
  EQUIPMENT_MACHINERY: { en: "Equipment / machinery", fa: "تجهیزات / ماشین‌آلات" },
  GOODS_MATERIALS: { en: "Goods / materials", fa: "جنس / مواد" },
  OTHER: { en: "Other", fa: "سایر" }
};

const RECORD_COPY: Readonly<Record<string, Copy>> = {
  DRAFT: { en: "Draft", fa: "پیش‌نویس" },
  DECLARED: { en: "Declared", fa: "اعلام‌شده" },
  APPROVED: { en: "Approved", fa: "تأییدشده" },
  CANCELLED: { en: "Cancelled", fa: "لغوشده" },
  POSTED: { en: "Posted", fa: "ثبت‌شده" }
};
/** Status of a legacy capital agreement (the earlier cash workflow). */
const AGREEMENT_STATUS_COPY: Readonly<Record<string, Copy>> = {
  DRAFT: { en: "Draft", fa: "پیش‌نویس" },
  PENDING_EVIDENCE: { en: "Waiting for evidence", fa: "در انتظار مدارک" },
  ELIGIBLE: { en: "Eligible", fa: "واجد شرایط" },
  SUSPENDED: { en: "Suspended", fa: "معلق" },
  CLOSED: { en: "Closed", fa: "بسته" }
};
const RECEIPT_COPY: Readonly<Record<string, Copy>> = {
  NOT_APPLICABLE: { en: "Not applicable", fa: "مورد ندارد" },
  NOT_RECEIVED: { en: "Not received", fa: "دریافت‌نشده" },
  PARTIALLY_RECEIVED: { en: "Partly received", fa: "بخشی دریافت‌شده" },
  RECEIVED: { en: "Received", fa: "دریافت‌شده" }
};
/** Record state as a qualifier on a summary chip ("Cash declared"), so a total never reads as money received. */
const RECORD_QUALIFIER_ORDER = ["DRAFT", "DECLARED", "APPROVED", "POSTED"] as const;
const RECORD_QUALIFIER_COPY: Readonly<Record<(typeof RECORD_QUALIFIER_ORDER)[number], Copy>> = {
  DRAFT: { en: "draft", fa: "پیش‌نویس" },
  DECLARED: { en: "declared", fa: "اعلام‌شده" },
  APPROVED: { en: "approved", fa: "تأییدشده" },
  POSTED: { en: "posted", fa: "ثبت‌شده" }
};

/**
 * Presentation only: describes the rows behind one declared total (same type and currency, not
 * cancelled) by their record and receipt states. The total itself is the server's and is unchanged.
 */
function totalQualifiers(rows: readonly ShareholderContribution[], type: string, currency: string): { readonly record: Copy; readonly receipt: Copy | null } {
  const matching = rows.filter((c) => c.type === type && c.currency === currency);
  const states = RECORD_QUALIFIER_ORDER.filter((s) => matching.some((c) => c.recordStatus === s));
  const record = {
    en: states.map((s) => RECORD_QUALIFIER_COPY[s].en).join(" / "),
    fa: states.map((s) => RECORD_QUALIFIER_COPY[s].fa).join(" / ")
  };
  const receipts = [...new Set(matching.map((c) => c.receiptStatus).filter((s) => s !== "NOT_APPLICABLE"))];
  const receiptKey = receipts.length === 0 ? null : receipts.length === 1 ? (receipts[0] ?? null) : "PARTIALLY_RECEIVED";
  const receipt = receiptKey === null ? null : RECEIPT_COPY[receiptKey] ?? null;
  return { record, receipt };
}
const VALUATION_COPY: Readonly<Record<string, Copy>> = {
  NOT_APPLICABLE: { en: "Not applicable", fa: "مورد ندارد" },
  NOT_VALUED: { en: "Not valued", fa: "ارزیابی‌نشده" },
  VALUED: { en: "Valued", fa: "ارزیابی‌شده" },
  APPROVED: { en: "Value approved", fa: "ارزش تأییدشده" }
};
const CLASSIFICATION_COPY: Readonly<Record<string, Copy>> = {
  UNCLASSIFIED: { en: "Not yet classified", fa: "هنوز طبقه‌بندی نشده" },
  CAPITAL_RECEIVABLE: { en: "Capital receivable", fa: "سرمایهٔ قابل دریافت" },
  SHAREHOLDER_LOAN: { en: "Shareholder loan", fa: "قرضهٔ سهامدار" },
  OFFSET: { en: "Offset", fa: "تهاتر" }
};
const ERROR_COPY: Readonly<Record<string, Copy>> = {
  CONTRIBUTION_INVALID: { en: "Some contribution details are missing or not valid.", fa: "برخی جزئیات آورده ناقص یا نادرست است." },
  CONTRIBUTION_NOT_EDITABLE: { en: "This contribution can no longer be changed.", fa: "این آورده دیگر قابل تغییر نیست." },
  CONTRIBUTION_PHASE_LOCKED: { en: "Approval, receipt, valuation and posting of contributions are not available yet.", fa: "تأیید، دریافت، ارزیابی و ثبت آورده‌ها هنوز فعال نیست." },
  STALE_VERSION: { en: "Someone else changed this meanwhile. Reload and try again.", fa: "شخص دیگری این را تغییر داده است. دوباره بارگذاری کنید." },
  REFERENCE_IN_USE: { en: "This reference is already used by another business party of your company.", fa: "این مرجع قبلاً برای طرف تجاری دیگری در شرکت شما استفاده شده است." },
  ALREADY_SUBMITTED_DIFFERENTLY: { en: "This form was already submitted with different details. Reload and try again.", fa: "این فرم قبلاً با جزئیات دیگری ارسال شده است. دوباره بارگذاری کنید." },
  NOT_FOUND: { en: "This record was not found for your company.", fa: "این مورد برای شرکت شما پیدا نشد." },
  VALIDATION_FAILED: { en: "Some details are missing, too long or not valid.", fa: "برخی جزئیات ناقص، بیش از حد طولانی یا نادرست است." }
};

interface Draft {
  readonly businessDate: string; readonly description: string; readonly reference: string;
  readonly amount: string; readonly currencyCode: string;
  readonly assetCategory: ContributionAssetCategory; readonly itemName: string; readonly quantity: string; readonly unit: string;
  readonly ownershipNote: string; readonly estimatedValue: string; readonly valuationCurrencyCode: string;
}

type Form =
  | { readonly kind: "new-shareholder"; readonly key: string; readonly name: string; readonly reference: string; readonly since: string }
  | { readonly kind: "add"; readonly shareholderId: string; readonly key: string; readonly choice: Choice | null; readonly draft: Draft }
  | { readonly kind: "edit"; readonly contribution: ShareholderContribution; readonly draft: Draft }
  | { readonly kind: "cancel"; readonly contribution: ShareholderContribution; readonly reason: string };

function money(amount: string, currency: string): string {
  // One convention in both languages: the currency code first, e.g. "USD 20,000".
  return `${currency} ${exactDecimal(amount)}`;
}

function emptyDraft(today: string, currency: string): Draft {
  return { businessDate: today, description: "", reference: "", amount: "", currencyCode: currency, assetCategory: "LAND_PROPERTY",
    itemName: "", quantity: "", unit: "", ownershipNote: "", estimatedValue: "", valuationCurrencyCode: "" };
}

function draftOf(c: ShareholderContribution, currency: string): Draft {
  return { businessDate: c.businessDate, description: c.description ?? "", reference: c.reference ?? "", amount: c.amount ?? "",
    currencyCode: c.currency ?? currency, assetCategory: c.assetCategory ?? "LAND_PROPERTY", itemName: c.itemName ?? "",
    quantity: c.quantity ?? "", unit: c.unit ?? "", ownershipNote: c.ownershipNote ?? "", estimatedValue: c.estimatedValue ?? "",
    valuationCurrencyCode: c.valuationCurrency ?? "" };
}

/** Only the fields of the chosen type travel to the server. */
function fieldsFor(type: ContributionType, d: Draft): Record<string, string> {
  const common = { businessDate: d.businessDate, description: d.description, reference: d.reference };
  if (type === "IN_KIND") {
    return { ...common, assetCategory: d.assetCategory, itemName: d.itemName, quantity: d.quantity, unit: d.unit,
      ownershipNote: d.ownershipNote, estimatedValue: d.estimatedValue,
      valuationCurrencyCode: d.estimatedValue.trim() === "" ? "" : d.valuationCurrencyCode };
  }
  return { ...common, amount: d.amount, currencyCode: d.currencyCode };
}

export function ShareholderContributionsView({ fa, onAdvanced }: { readonly fa: boolean; readonly onAdvanced: () => void }) {
  const t = useCallback((copy: Copy) => (fa ? copy.fa : copy.en), [fa]);
  const locale = fa ? "fa" : "en";
  const [view, setView] = useState<ShareholderContributionsWorkspace | null>(null);
  const [gate, setGate] = useState<"signed-out" | "denied" | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const apply = useCallback((result: Awaited<ReturnType<typeof api<ShareholderContributionsWorkspace>>>) => {
    if (!result.ok) {
      setGate(result.status === 401 ? "signed-out" : result.status === 403 ? "denied" : null);
      if (result.status !== 401 && result.status !== 403) setMessage({ tone: "error", text: errorText(result.error, locale) });
      return;
    }
    setGate(null);
    setView(result.data);
  }, [locale]);
  const load = useCallback(async () => apply(await api<ShareholderContributionsWorkspace>("/api/v1/shareholder/contributions")), [apply]);
  useEffect(() => {
    let current = true;
    void api<ShareholderContributionsWorkspace>("/api/v1/shareholder/contributions").then((result) => { if (current) apply(result); });
    return () => { current = false; };
  }, [apply]);

  const run = async (body: Record<string, unknown>, success: Copy) => {
    setBusy(true); setMessage(null);
    const result = await api<Record<string, unknown>>("/api/v1/shareholder/setup", "POST", body);
    setBusy(false);
    if (!result.ok) {
      if (result.status === 401) { setGate("signed-out"); return; }
      const copy = ERROR_COPY[result.error.code];
      setMessage({ tone: "error", text: copy ? t(copy) : errorText(result.error, locale) });
      return;
    }
    setForm(null);
    setMessage({ tone: "ok", text: t(success) });
    await load();
  };

  if (gate !== null) {
    return (
      <div className="contribution-gate">
        <AccessGate state={gate} fa={fa} what={{ en: "Shareholders need the “Set up shareholders and capital agreements” or “View shareholder agreements” permission.", fa: "بخش سهامداران به صلاحیت «تنظیم سهامداران و قراردادهای سرمایه» یا «مشاهده قراردادهای سهامداران» نیاز دارد." }} />
        {gate === "denied" ? <button type="button" className="treasury-button" onClick={onAdvanced}>{fa ? "جزئیات پیشرفته" : "Advanced"}</button> : null}
      </div>
    );
  }
  if (view === null) return <p className="treasury-placeholder">{fa ? "در حال بارگذاری…" : "Loading…"}</p>;
  const canManage = view.permissions.canManage;
  const base = view.legalEntity?.baseCurrency ?? view.currencies[0] ?? "USD";

  return (
    <section className="contribution-view" aria-label={fa ? "سهامداران و آورده‌ها" : "Shareholders and contributions"}>
      <p className="contribution-intro">{fa
        ? "برای هر سهامدار، آنچه آورده یا تعهد کرده را ثبت کنید: پول نقد، جنس یا دارایی، یا اعتبار. ثبت آورده فقط اعلام است و هیچ رقمی در خزانه یا دفاتر ثبت نمی‌کند."
        : "For each shareholder, record what they have contributed or committed: cash, an asset, or credit. Recording a contribution is a declaration only; nothing is recorded in Treasury or the books."}</p>
      {message ? <div className={`treasury-message ${message.tone === "ok" ? "success" : "error"}`} role="status"><AppIcon name={message.tone === "ok" ? "shield" : "alert"} size={16} /><span>{message.text}</span><button onClick={() => setMessage(null)} aria-label={fa ? "بستن" : "Dismiss"}>×</button></div> : null}
      {!canManage ? <p className="admin-hint">{fa ? "شما فقط می‌توانید ببینید." : "You can view only."}</p> : null}

      {canManage && form?.kind !== "new-shareholder" ? (
        <button type="button" className="treasury-button gold contribution-add-shareholder"
          onClick={() => { setMessage(null); setForm({ kind: "new-shareholder", key: crypto.randomUUID(), name: "", reference: "", since: view.today }); }}>
          <AppIcon name="coins" size={15} /> {fa ? "افزودن سهامدار" : "Add shareholder"}</button>
      ) : null}
      {form?.kind === "new-shareholder" ? (
        <form className="admin-form shareholder-form" aria-label={fa ? "سهامدار جدید" : "New shareholder"} onSubmit={submit(() => void run(
          { action: "create-shareholder", displayName: form.name, externalReference: form.reference, shareholderSince: form.since, idempotencyKey: form.key },
          { en: `${form.name.trim()} was added. Add a contribution now or later.`, fa: `${form.name.trim()} اضافه شد. آورده را اکنون یا بعداً ثبت کنید.` }))}>
          <h3>{fa ? "سهامدار جدید" : "New shareholder"}</h3>
          <Field label={fa ? "نام کامل" : "Full name"}><input value={form.name} maxLength={160} required onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label={fa ? "مرجع (اختیاری)" : "Reference (optional)"}><input dir="ltr" value={form.reference} maxLength={60} onChange={(e) => setForm({ ...form, reference: e.target.value })} /></Field>
          <Field label={fa ? "سهامدار از تاریخ" : "Shareholder since"}><input type="date" value={form.since} max={view.today} required onChange={(e) => setForm({ ...form, since: e.target.value })} /></Field>
          <Actions fa={fa} busy={busy} submit={{ en: "Add shareholder", fa: "افزودن سهامدار" }} onCancel={() => setForm(null)} />
        </form>
      ) : null}

      {view.shareholders.length === 0 ? <p className="treasury-placeholder">{fa ? "هنوز هیچ سهامداری ثبت نشده است." : "No shareholder has been added yet."}</p> : null}
      {view.shareholders.map((holder) => (
        <ShareholderCard key={holder.id} holder={holder} view={view} base={base} fa={fa} t={t} canManage={canManage}
          form={form} setForm={(next) => { setMessage(null); setForm(next); }} busy={busy} run={run} />
      ))}
    </section>
  );
}

function submit(handler: () => void) {
  return (event: FormEvent) => { event.preventDefault(); handler(); };
}

function Field({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return <label><span>{label}</span>{children}</label>;
}

function Actions({ fa, busy, submit: label, onCancel, extra }: { readonly fa: boolean; readonly busy: boolean; readonly submit: Copy; readonly onCancel: () => void; readonly extra?: ReactNode }) {
  return (
    <div className="rates-actions">
      <button type="submit" className="treasury-button gold" disabled={busy}>{fa ? label.fa : label.en}</button>
      {extra}
      <button type="button" className="treasury-button" onClick={onCancel}>{fa ? "لغو" : "Cancel"}</button>
    </div>
  );
}

interface CardProps {
  readonly holder: ShareholderWithContributions; readonly view: ShareholderContributionsWorkspace; readonly base: string;
  readonly fa: boolean; readonly t: (copy: Copy) => string; readonly canManage: boolean;
  readonly form: Form | null; readonly setForm: (form: Form | null) => void; readonly busy: boolean;
  readonly run: (body: Record<string, unknown>, success: Copy) => Promise<void>;
}

function ShareholderCard({ holder, view, base, fa, t, canManage, form, setForm, busy, run }: CardProps) {
  const live = holder.contributions.filter((c) => c.recordStatus !== "CANCELLED");
  const legacy = holder.legacyCashAgreements;
  // "None yet" only when there is neither a new contribution nor a legacy cash commitment.
  const noneYet = live.length === 0 && legacy.length === 0;
  const adding = form?.kind === "add" && form.shareholderId === holder.id ? form : null;
  return (
    <article className="module-content-card contribution-card" aria-label={holder.name} data-shareholder={holder.name}>
      <header className="contribution-card-head">
        <div>
          <h2>{holder.name}</h2>
          <p>{holder.reference ? <span dir="ltr">{holder.reference}</span> : null}{holder.since ? <span>{fa ? "سهامدار از" : "Shareholder since"} {holder.since}</span> : null}</p>
        </div>
        <em className="treasury-chip">{t(holder.status === "ACTIVE" ? { en: "Active", fa: "فعال" } : { en: holder.status, fa: holder.status })}</em>
      </header>

      <div className="contribution-summary" aria-label={fa ? "خلاصهٔ آورده‌ها" : "Contribution summary"}>
        {noneYet ? <span className="contribution-none">{fa ? "فعلاً هیچ آورده‌ای ندارد" : "None yet"}</span> : null}
        {legacy.map((a) => (
          <span key={a.id} className="contribution-total legacy" data-testid="legacy-commitment-chip">
            {fa ? "تعهد نقدی قبلی" : "Legacy cash commitment"}: <b dir="ltr">{money(a.committed, a.currency)}</b>
            {" · "}{t(AGREEMENT_STATUS_COPY[a.status] ?? { en: a.status, fa: a.status })}
          </span>
        ))}
        {holder.declaredTotals.map((total) => {
          const { record, receipt } = totalQualifiers(live, total.type, total.currency);
          return (
            <span key={`${total.type}-${total.currency}`} className="contribution-total" data-total={`${total.type}-${total.currency}`}>
              {t(TYPE_COPY[total.type])} {t(record)}: <b dir="ltr">{money(total.amount, total.currency)}</b>
              {receipt ? <>{" · "}{t(receipt)}</> : null}
            </span>
          );
        })}
        {holder.estimatedAssetTotals.map((total) => (
          <span key={`est-${total.currency}`} className="contribution-total estimate">
            {fa ? "ارزش تخمینی دارایی (فقط معلومات)" : "Estimated asset value (information only)"}: <b dir="ltr">{money(total.amount, total.currency)}</b>
          </span>
        ))}
      </div>

      {holder.contributions.length > 0 ? (
        <table className="shareholder-installments contribution-table">
          <thead><tr>
            <th>{fa ? "نوع" : "Type"}</th><th>{fa ? "شرح / قلم" : "Description / item"}</th><th>{fa ? "مبلغ یا ارزش" : "Amount or value"}</th>
            <th>{fa ? "اعلام" : "Declaration"}</th><th>{fa ? "دریافت" : "Receipt"}</th><th>{fa ? "ارزیابی" : "Valuation"}</th><th />
          </tr></thead>
          <tbody>{holder.contributions.map((c) => (
            <ContributionRow key={c.id} c={c} view={view} fa={fa} t={t} canManage={canManage} form={form} setForm={setForm} busy={busy} run={run} />
          ))}</tbody>
        </table>
      ) : null}

      {legacy.length > 0 ? (
        <div className="contribution-legacy" data-testid="legacy-cash-agreements">
          <p>{fa ? "تعهد نقدی قبلی" : "Legacy cash commitment"}</p>
          {/* The amount, currency and status are in the summary chip above; they are not repeated here. */}
          <ul>{legacy.map((a) => (
            <li key={a.id}>
              <strong dir="ltr">{a.reference}</strong>
              <small>{fa ? `${a.installmentCount} قسط برنامه‌ریزی‌شده` : `${a.installmentCount} installment(s) planned`}</small>
            </li>
          ))}</ul>
          <small>{fa ? "این قرارداد از روند قبلی سرمایه است؛ جداگانه نشان داده می‌شود و با آورده‌های بالا جمع نمی‌شود. جزئیات در «جزئیات پیشرفته»." : "This agreement comes from the earlier cash capital workflow. It is shown separately and is not added to the contributions above. Details are under Advanced."}</small>
        </div>
      ) : null}

      {canManage && adding === null ? (
        <button type="button" className="treasury-button gold contribution-add"
          onClick={() => setForm({ kind: "add", shareholderId: holder.id, key: crypto.randomUUID(), choice: null, draft: emptyDraft(view.today, base) })}>
          {fa ? "افزودن آورده" : "Add contribution"}</button>
      ) : null}
      {adding ? <AddContribution form={adding} holder={holder} view={view} fa={fa} t={t} busy={busy} setForm={setForm} run={run} /> : null}
    </article>
  );
}

function ContributionRow({ c, view, fa, t, canManage, form, setForm, busy, run }: Omit<CardProps, "holder" | "base"> & { readonly c: ShareholderContribution }) {
  const editing = form?.kind === "edit" && form.contribution.id === c.id ? form : null;
  const cancelling = form?.kind === "cancel" && form.contribution.id === c.id ? form : null;
  const what = c.type === "IN_KIND"
    ? `${c.assetCategory ? t(CATEGORY_COPY[c.assetCategory]) : ""} · ${c.itemName ?? ""}${c.quantity ? ` · ${exactDecimal(c.quantity)}${c.unit ? ` ${c.unit}` : ""}` : ""}`
    : c.description ?? "—";
  const value = c.type === "IN_KIND"
    ? (c.estimatedValue && c.valuationCurrency ? `${money(c.estimatedValue, c.valuationCurrency)} ${fa ? "(تخمینی)" : "(estimate)"}` : "—")
    : (c.amount && c.currency ? money(c.amount, c.currency) : "—");
  return (
    <>
      <tr className={c.recordStatus === "CANCELLED" ? "shareholder-cancelled" : undefined} data-contribution-type={c.type}>
        <td data-label={fa ? "نوع" : "Type"}><strong>{t(TYPE_COPY[c.type])}</strong>
          {c.type === "CREDIT" && c.creditClassification ? <small className="contribution-sub">{t(CLASSIFICATION_COPY[c.creditClassification] ?? { en: c.creditClassification, fa: c.creditClassification })}</small> : null}</td>
        <td data-label={fa ? "شرح / قلم" : "Description / item"}>{what}
          {c.type === "IN_KIND" && c.description ? <small className="contribution-sub">{c.description}</small> : null}
          <small className="contribution-sub">{c.businessDate}{c.reference ? ` · ${c.reference}` : ""}</small></td>
        <td data-label={fa ? "مبلغ یا ارزش" : "Amount or value"} dir="ltr">{value}</td>
        <td data-label={fa ? "اعلام" : "Declaration"}><em className="treasury-chip">{t(RECORD_COPY[c.recordStatus] ?? { en: c.recordStatus, fa: c.recordStatus })}</em></td>
        <td data-label={fa ? "دریافت" : "Receipt"}>{t(RECEIPT_COPY[c.receiptStatus] ?? { en: c.receiptStatus, fa: c.receiptStatus })}</td>
        <td data-label={fa ? "ارزیابی" : "Valuation"}>{t(VALUATION_COPY[c.valuationStatus] ?? { en: c.valuationStatus, fa: c.valuationStatus })}</td>
        <td data-label="">{canManage && c.editable && !editing && !cancelling ? (
          <span className="shareholder-row-actions">
            <button type="button" className="treasury-button" onClick={() => setForm({ kind: "edit", contribution: c, draft: draftOf(c, view.currencies[0] ?? "USD") })}>{fa ? "ویرایش" : "Edit"}</button>
            {c.recordStatus === "DRAFT" ? <button type="button" className="treasury-button" disabled={busy}
              onClick={() => void run({ action: "declare-contribution", contributionId: c.id, expectedVersion: c.version }, { en: "The contribution was declared.", fa: "آورده اعلام شد." })}>{fa ? "اعلام" : "Declare"}</button> : null}
            <button type="button" className="treasury-button" onClick={() => setForm({ kind: "cancel", contribution: c, reason: "" })}>{fa ? "لغو آورده" : "Cancel contribution"}</button>
          </span>
        ) : c.recordStatus === "CANCELLED" && c.cancellationReason ? <small className="contribution-sub">{c.cancellationReason}</small> : null}</td>
      </tr>
      {editing ? (
        <tr className="shareholder-form-row"><td colSpan={7}>
          <form className="admin-form shareholder-form" aria-label={fa ? "ویرایش آورده" : "Edit contribution"} onSubmit={submit(() => void run(
            { action: "update-contribution", contributionId: c.id, expectedVersion: c.version, ...fieldsFor(c.type, editing.draft) },
            { en: "The contribution was updated.", fa: "آورده به‌روز شد." }))}>
            <TypeFields type={c.type} draft={editing.draft} currencies={view.currencies} fa={fa} t={t} onChange={(draft) => setForm({ ...editing, draft })} />
            <Actions fa={fa} busy={busy} submit={{ en: "Save changes", fa: "ذخیرهٔ تغییرات" }} onCancel={() => setForm(null)} />
          </form>
        </td></tr>
      ) : null}
      {cancelling ? (
        <tr className="shareholder-form-row"><td colSpan={7}>
          <form className="admin-form shareholder-form" aria-label={fa ? "لغو آورده" : "Cancel contribution"} onSubmit={submit(() => void run(
            { action: "cancel-contribution", contributionId: c.id, expectedVersion: c.version, reason: cancelling.reason },
            { en: "The contribution was cancelled. It stays visible in the history.", fa: "آورده لغو شد و در سابقه باقی می‌ماند." }))}>
            <Field label={fa ? "دلیل لغو" : "Reason for cancelling"}><input value={cancelling.reason} minLength={3} maxLength={300} required onChange={(e) => setForm({ ...cancelling, reason: e.target.value })} /></Field>
            <Actions fa={fa} busy={busy} submit={{ en: "Cancel contribution", fa: "لغو آورده" }} onCancel={() => setForm(null)} />
          </form>
        </td></tr>
      ) : null}
    </>
  );
}

function AddContribution({ form, holder, view, fa, t, busy, setForm, run }: {
  readonly form: Extract<Form, { kind: "add" }>; readonly holder: ShareholderWithContributions; readonly view: ShareholderContributionsWorkspace;
  readonly fa: boolean; readonly t: (copy: Copy) => string; readonly busy: boolean; readonly setForm: (form: Form | null) => void;
  readonly run: (body: Record<string, unknown>, success: Copy) => Promise<void>;
}) {
  const save = (declare: boolean) => {
    if (form.choice === null || form.choice === "NONE") return;
    void run({ action: "create-contribution", shareholderProfileId: holder.id, contributionType: form.choice, declare,
      idempotencyKey: `${form.key}-${declare ? "declared" : "draft"}`, ...fieldsFor(form.choice, form.draft) },
      declare ? { en: "The contribution was recorded as declared. Nothing was posted.", fa: "آورده به‌عنوان اعلام‌شده ثبت شد. هیچ رقمی ثبت دفتری نشد." }
        : { en: "The contribution was saved as a draft.", fa: "آورده به‌عنوان پیش‌نویس ذخیره شد." });
  };
  return (
    <form className="admin-form shareholder-form contribution-form" aria-label={fa ? "افزودن آورده" : "Add contribution"} onSubmit={submit(() => save(true))}>
      <h3>{fa ? `آورده برای ${holder.name}` : `Contribution for ${holder.name}`}</h3>
      <fieldset className="contribution-choice" role="radiogroup" aria-label={fa ? "نوع آورده" : "Contribution type"}>
        {CHOICES.map((choice) => (
          <label key={choice.id} className={form.choice === choice.id ? "selected" : undefined}>
            <input type="radio" name={`contribution-type-${holder.id}`} value={choice.id} checked={form.choice === choice.id}
              onChange={() => setForm({ ...form, choice: choice.id })} />
            <span>{t(choice.copy)}</span>
          </label>
        ))}
      </fieldset>
      {form.choice === "NONE" ? (
        <>
          <p className="admin-hint" data-testid="none-yet-note">{fa ? "چیزی ذخیره نمی‌شود. این سهامدار بدون آورده باقی می‌ماند و هر زمان می‌توانید آورده اضافه کنید." : "Nothing is saved. This shareholder stays with no contribution, and you can add one at any time."}</p>
          <div className="rates-actions"><button type="button" className="treasury-button gold" onClick={() => setForm(null)}>{fa ? "تمام" : "Done"}</button></div>
        </>
      ) : form.choice !== null ? (
        <>
          <TypeFields type={form.choice} draft={form.draft} currencies={view.currencies} fa={fa} t={t} onChange={(draft) => setForm({ ...form, draft })} />
          <Actions fa={fa} busy={busy} submit={{ en: "Save contribution", fa: "ذخیرهٔ آورده" }} onCancel={() => setForm(null)}
            extra={<button type="button" className="treasury-button" disabled={busy} onClick={() => save(false)}>{fa ? "ذخیره به‌عنوان پیش‌نویس" : "Save as draft"}</button>} />
        </>
      ) : (
        <div className="rates-actions"><button type="button" className="treasury-button" onClick={() => setForm(null)}>{fa ? "لغو" : "Cancel"}</button></div>
      )}
    </form>
  );
}

function TypeFields({ type, draft, currencies, fa, t, onChange }: {
  readonly type: ContributionType; readonly draft: Draft; readonly currencies: readonly string[]; readonly fa: boolean;
  readonly t: (copy: Copy) => string; readonly onChange: (draft: Draft) => void;
}) {
  const set = (patch: Partial<Draft>) => onChange({ ...draft, ...patch });
  const amountPattern = "(0|[1-9][0-9]*)(\\.[0-9]+)?";
  const currency = (value: string, change: (code: string) => void, label: string, optional = false) => (
    <Field label={label}>
      <select value={value} onChange={(e) => change(e.target.value)} required={!optional}>
        {optional ? <option value="">{fa ? "—" : "—"}</option> : null}
        {currencies.map((code) => <option key={code} value={code}>{code}</option>)}
      </select>
    </Field>
  );
  const date = <Field label={fa ? "تاریخ" : "Date"}><input type="date" value={draft.businessDate} required onChange={(e) => set({ businessDate: e.target.value })} /></Field>;
  const reference = <Field label={fa ? "مرجع (اختیاری)" : "Reference (optional)"}><input dir="ltr" value={draft.reference} maxLength={100} onChange={(e) => set({ reference: e.target.value })} /></Field>;
  if (type === "IN_KIND") {
    return (
      <div className="contribution-fields" data-fields="IN_KIND">
        <Field label={fa ? "نوع دارایی" : "Category"}>
          <select value={draft.assetCategory} onChange={(e) => set({ assetCategory: e.target.value as ContributionAssetCategory })}>
            {CONTRIBUTION_ASSET_CATEGORIES.map((c) => <option key={c} value={c}>{t(CATEGORY_COPY[c])}</option>)}
          </select>
        </Field>
        <Field label={fa ? "نام قلم یا دارایی" : "Item name"}><input value={draft.itemName} maxLength={200} required onChange={(e) => set({ itemName: e.target.value })} /></Field>
        <Field label={fa ? "شرح" : "Description"}><textarea value={draft.description} maxLength={1000} rows={2} onChange={(e) => set({ description: e.target.value })} /></Field>
        <Field label={fa ? "مقدار (اختیاری)" : "Quantity (optional)"}><input dir="ltr" inputMode="decimal" pattern={amountPattern} value={draft.quantity} onChange={(e) => set({ quantity: e.target.value })} /></Field>
        <Field label={fa ? "واحد (اختیاری)" : "Unit (optional)"}><input value={draft.unit} maxLength={40} placeholder={fa ? "متر مربع، تن، عدد" : "m², tonnes, pieces"} onChange={(e) => set({ unit: e.target.value })} /></Field>
        <Field label={fa ? "ارزش تخمینی (اختیاری)" : "Estimated value (optional)"}><input dir="ltr" inputMode="decimal" pattern={amountPattern} value={draft.estimatedValue} onChange={(e) => set({ estimatedValue: e.target.value, valuationCurrencyCode: draft.valuationCurrencyCode || currencies[0] || "" })} /></Field>
        {draft.estimatedValue.trim() !== "" ? currency(draft.valuationCurrencyCode, (code) => set({ valuationCurrencyCode: code }), fa ? "واحد پول ارزش" : "Valuation currency") : null}
        <Field label={fa ? "یادداشت مالکیت یا سند (اختیاری)" : "Ownership / evidence note (optional)"}><textarea value={draft.ownershipNote} maxLength={1000} rows={2} onChange={(e) => set({ ownershipNote: e.target.value })} /></Field>
        {date}{reference}
        <p className="admin-hint contribution-note">{fa ? "ارزش تخمینی فقط برای معلومات است و پول دریافت‌شده یا سرمایه شمرده نمی‌شود." : "An estimated value is information only. It is not cash received and not counted as capital."}</p>
      </div>
    );
  }
  return (
    <div className="contribution-fields" data-fields={type}>
      <Field label={fa ? "مبلغ" : "Amount"}><input dir="ltr" inputMode="decimal" pattern={amountPattern} value={draft.amount} required onChange={(e) => set({ amount: e.target.value })} /></Field>
      {currency(draft.currencyCode, (code) => set({ currencyCode: code }), fa ? "واحد پول" : "Currency")}
      {date}
      <Field label={type === "CREDIT" ? (fa ? "شرح" : "Description") : (fa ? "شرح (اختیاری)" : "Description (optional)")}>
        <textarea value={draft.description} maxLength={1000} rows={2} required={type === "CREDIT"} onChange={(e) => set({ description: e.target.value })} />
      </Field>
      {reference}
      <p className="admin-hint contribution-note">{type === "CREDIT"
        ? (fa ? "طبقه‌بندی: هنوز طبقه‌بندی نشده. بخش مالی بعداً نوع حسابداری آن را تعیین می‌کند. اعتبار پول نقد یا سرمایه شمرده نمی‌شود." : "Classification: not yet classified. Finance decides the accounting treatment later. Credit is not cash and not capital.")
        : (fa ? "این فقط اعلام است: تا زمانی که خزانه پول را دریافت نکند، دریافت‌شده شمرده نمی‌شود." : "This is a declaration only: it does not count as received until Treasury actually receives the cash.")}</p>
    </div>
  );
}
