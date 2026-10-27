"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";

import { AccessGate, api, errorText } from "@/components/AdminUsersWorkspace";
import { exactDecimal } from "@/components/ExchangeRatesWorkspace";
import { useLocale } from "@/components/LocaleProvider";
import { kabulToday } from "@/components/OperationalFinanceShared";
import { StageZeroPageHeader } from "@/components/StageZeroWorkspace";

// Read projections only: the server owns all amounts, balances and permission decisions.
type Method = "CASH" | "HAWALA" | "ASSET" | "BILL_PAYMENT";
interface Capital { readonly currency: string; readonly contributed: string; readonly agreedTotal: string | null; readonly remaining: string | null }
interface Entry { readonly id: string; readonly date: string; readonly amount: string; readonly currency: string; readonly method: Method; readonly destination: string | null; readonly providerName: string | null; readonly itemDescription: string | null; readonly debitAccount: string | null; readonly reference: string; readonly status: "POSTED"; readonly journalId: string; readonly note: string | null; readonly paymentReference: string | null }
interface Holder { readonly id: string; readonly name: string; readonly reference: string | null; readonly note: string | null; readonly active: boolean; readonly capitals: readonly Capital[]; readonly transactions: readonly Entry[]; readonly documents: readonly { readonly id: string; readonly fileName: string; readonly version: number }[] }
interface Workspace { readonly legalEntity: { readonly id: string; readonly name: string; readonly baseCurrency: string | null }; readonly permissions: { readonly canManage: boolean; readonly canReceive: boolean }; readonly currencies: readonly { readonly code: string; readonly label: string }[]; readonly destinations: readonly { readonly id: string; readonly name: string; readonly currency: string; readonly balance: string | null }[]; readonly expenseAccounts: readonly { readonly id: string; readonly code: string; readonly name: string }[]; readonly assetAccountReady: boolean; readonly shareholders: readonly Holder[]; readonly receiveAvailable: boolean; readonly unavailableReason: string | null }
interface Result { readonly shareholderProfileId?: string; readonly receiptId?: string; readonly journalId?: string; readonly reference?: string; readonly firstReceipt?: { readonly reference: string } | null; readonly workspace: Workspace }
type Form = {
  readonly kind: "add" | "capital"; readonly shareholder: string; readonly name: string; readonly agreedTotal: string;
  readonly method: Method | ""; readonly amount: string; readonly currency: string; readonly date: string;
  readonly destination: string; readonly provider: string; readonly item: string; readonly expenseAccount: string;
  readonly reference: string; readonly note: string; readonly file: File | null;
  readonly key: string; readonly correlation: string;
};
type Upload = { shareholder: string; file: File; key: string; date: string };
const ENDPOINT = "/api/v1/shareholder/capital";
const fieldGrid = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))", gap: 12 };
const money = (amount: string, currency: string) => `${currency} ${exactDecimal(amount)}`;
const optional = (value: string) => value.trim() || null;
const cashBearing = (method: Method | "") => method === "CASH" || method === "HAWALA";

function Field({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return <label><span>{label}</span>{children}</label>;
}

export function DirectShareholderCapitalWorkspace() {
  const { locale } = useLocale();
  const fa = locale === "fa";
  const [view, setView] = useState<Workspace | null>(null);
  const [gate, setGate] = useState<"signed-out" | "denied" | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [upload, setUpload] = useState<Upload | null>(null);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [query, setQuery] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  // The ref closes the synchronous double-click window before React paints disabled controls.
  const running = useRef(false);
  const submitted = useRef<Record<string, unknown> | null>(null);
  const copy = (en: string, dari: string) => fa ? dari : en;

  const refresh = useCallback(async () => {
    const result = await api<Workspace>(ENDPOINT);
    if (result.ok) { setView(result.data); setGate(null); return; }
    setGate(result.status === 401 ? "signed-out" : result.status === 403 ? "denied" : null);
    setMessage({ ok: false, text: errorText(result.error, locale) });
  }, [locale]);
  useEffect(() => {
    let active = true;
    void api<Workspace>(ENDPOINT).then(result => {
      if (!active) return;
      if (result.ok) { setView(result.data); setGate(null); return; }
      setGate(result.status === 401 ? "signed-out" : result.status === 403 ? "denied" : null);
      setMessage({ ok: false, text: errorText(result.error, locale) });
    });
    return () => { active = false; };
  }, [locale]);

  const uploadDocument = async (attachment: Upload) => {
    const data = new FormData();
    data.set("shareholderProfileId", attachment.shareholder);
    data.set("file", attachment.file);
    data.set("idempotencyKey", attachment.key);
    data.set("documentReference", attachment.file.name);
    data.set("documentDate", attachment.date);
    setAttachmentError(null);
    let detail = "";
    try {
      const response = await fetch(`${ENDPOINT}/documents`, { method: "POST", body: data });
      const result = await response.json() as { ok: boolean; error?: { code: string; message: string } };
      if (!response.ok || !result.ok) {
        if (response.status === 401) setGate("signed-out");
        if (["TOO_LARGE", "FILE_TOO_LARGE"].includes(result.error?.code ?? "")) detail = copy("Choose a file no larger than 10 MB.", "فایل تا ۱۰ میگابایت انتخاب کنید.");
        if (result.error?.code === "INVALID_FILE") detail = copy("Choose a valid PDF, JPG or PNG file.", "فایل معتبر PDF، JPG یا PNG انتخاب کنید.");
        throw new Error(result.error ? errorText(result.error, locale) : copy("Upload did not finish.", "بارگذاری کامل نشد."));
      }
      setUpload(null);
      await refresh();
    } catch {
      // Saving the shareholder and attaching a file are independent. Keep the same upload key for retry.
      setUpload(attachment);
      setAttachmentError(`${copy("The shareholder is saved. The document was not attached; retry the upload below. Capital is unaffected.", "سهامدار ذخیره شده است. سند ضمیمه نشد؛ بارگذاری را دوباره کوشش کنید. سرمایه تغییری نمی‌کند.")} ${detail}`);
    }
  };

  const contributionBody = (current: Form) => current.method === "" ? null : {
    fundingMethod: current.method, amount: current.amount.trim(), currencyCode: current.currency,
    receiptDate: current.date,
    destinationAccountId: cashBearing(current.method) ? current.destination : null,
    providerName: current.method === "HAWALA" ? optional(current.provider) : null,
    itemDescription: cashBearing(current.method) ? null : optional(current.item),
    expenseLedgerAccountId: current.method === "BILL_PAYMENT" ? current.expenseAccount : null,
    paymentReference: optional(current.reference), note: optional(current.note)
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (running.current || !form) return;
    running.current = true; setBusy(true); setMessage(null);
    const current = form;
    const body = uncertain && submitted.current ? submitted.current : current.kind === "add" ? {
      action: "add-shareholder", displayName: current.name.trim(),
      agreedTotal: optional(current.agreedTotal), currencyCode: optional(current.agreedTotal) ? current.currency : null,
      externalReference: null, note: optional(current.note), businessDate: kabulToday(),
      firstContribution: contributionBody(current),
      idempotencyKey: current.key, correlationId: current.correlation
    } : {
      action: "add-capital", shareholderProfileId: current.shareholder, ...contributionBody(current),
      idempotencyKey: current.key, correlationId: current.correlation
    };
    submitted.current = body;
    try {
      const result = await api<Result>(ENDPOINT, "POST", body);
      if (!result.ok) {
        if (result.status === 401) setGate("signed-out");
        if (result.status === 403) setGate("denied");
        const network = result.error.code === "NETWORK" || result.status >= 500;
        setUncertain(network);
        const errors: Record<string, [string, string]> = {
          PERIOD_MISSING: ["No month in your financial year covers this date. Ask your Finance administrator to generate the year.", "هیچ ماهی از سال مالی شما این تاریخ را پوشش نمی‌دهد. از مدیر مالی بخواهید سال مالی را بسازد."],
          PERIOD_CLOSED: ["The month covering this date is closed. Choose another date.", "ماه این تاریخ بسته است. تاریخ دیگری انتخاب کنید."],
          ASSET_ACCOUNT_REQUIRED: ["Create one active “shareholder contributed assets” account in the Chart of Accounts first.", "نخست یک حساب فعال «دارایی‌های آوردهٔ سهامدار» در دفتر حساب‌ها بسازید."],
          EXPENSE_ACCOUNT_REQUIRED: ["Choose an active expense account in the accounting currency.", "یک حساب هزینهٔ فعال با واحد پول حسابداری انتخاب کنید."],
          SARAF_REQUIRED: ["Name the saraf the hawala came through.", "نام صرافی که حواله از آن آمده را بنویسید."],
          DESCRIPTION_REQUIRED: ["Describe the asset, or the bill that was paid.", "دارایی یا صورت‌حسابی که پرداخت شده را توضیح دهید."],
          CURRENCY_MISMATCH: ["Choose a Safe in the same currency.", "صندوق با همان واحد پول انتخاب کنید."],
          NETWORK: ["Confirmation was not received. Retry this same request; it will not be recorded twice.", "تأیید دریافت نشد. همین درخواست را دوباره کوشش کنید؛ دوباره ثبت نمی‌شود."]
        };
        const known = errors[result.error.code];
        setMessage({ ok: false, text: network ? copy(...errors.NETWORK!) : known ? copy(...known) : errorText(result.error, locale) });
        return;
      }
      setUncertain(false); submitted.current = null; setForm(null); setView(result.data.workspace);
      const shareholderId = current.kind === "capital" ? current.shareholder : result.data.shareholderProfileId;
      if (shareholderId) setSelected(shareholderId);
      const reference = result.data.reference ?? result.data.firstReceipt?.reference ?? "";
      setMessage({ ok: true, text: current.kind === "add"
        ? current.method === ""
          ? copy("Shareholder saved.", "سهامدار ذخیره شد.")
          : copy(`Shareholder and capital saved · ${reference}`, `سهامدار و سرمایه ذخیره شد · ${reference}`)
        : copy(`Capital recorded · ${reference}`, `سرمایه ثبت شد · ${reference}`) });
      if (current.kind === "add" && current.file && shareholderId) {
        const attachment = { shareholder: shareholderId, file: current.file, key: crypto.randomUUID(), date: kabulToday() };
        setUpload(attachment); await uploadDocument(attachment);
      }
    } finally { running.current = false; setBusy(false); }
  };

  const blank = (kind: "add" | "capital", shareholder: string): Form => ({
    kind, shareholder, name: "", agreedTotal: "", method: "CASH", amount: "",
    currency: view?.legalEntity.baseCurrency ?? view?.currencies[0]?.code ?? "", date: kabulToday(),
    destination: "", provider: "", item: "", expenseAccount: "", reference: "", note: "", file: null,
    key: crypto.randomUUID(), correlation: crypto.randomUUID()
  });
  const start = (kind: "add" | "capital", shareholder = "") => {
    submitted.current = null; setUncertain(false); setMessage(null); setForm(blank(kind, shareholder));
  };

  const holder = view?.shareholders.find(item => item.id === selected) ?? null;
  // Only the approved accounting currency can post, so only it is offered.
  const currencies = view ? view.currencies.filter(item => item.code === (view.legalEntity.baseCurrency ?? item.code)) : [];
  const destinations = view?.destinations.filter(item => item.currency === form?.currency) ?? [];
  const disabled = busy || uncertain;
  const methods: readonly { readonly value: Method; readonly label: string; readonly ready: boolean }[] = [
    { value: "CASH", label: copy("Cash into a Safe", "نقد به صندوق"), ready: destinations.length > 0 },
    { value: "HAWALA", label: copy("Hawala into a Safe", "حواله به صندوق"), ready: destinations.length > 0 },
    { value: "ASSET", label: copy("An asset (vehicle, equipment, property, stock)", "دارایی (وسیله، تجهیزات، ملک، جنس)"), ready: view?.assetAccountReady === true },
    { value: "BILL_PAYMENT", label: copy("A company bill they paid directly", "صورت‌حساب شرکت که خودش پرداخته"), ready: (view?.expenseAccounts.length ?? 0) > 0 }
  ];

  if (gate) return <div className="module-workspace"><AccessGate state={gate} fa={fa} what={{ en: "Ask your administrator for access to shareholder capital.", fa: "برای دسترسی به سرمایه سهامداران با مدیر تماس بگیرید." }} /></div>;

  return <div className="module-workspace shareholder-workspace" dir={fa ? "rtl" : "ltr"}>
    <StageZeroPageHeader icon="coins" eyebrow={{ en: view?.legalEntity.name ?? "Shareholders", fa: view?.legalEntity.name ?? "سهامداران" }} title={{ en: "Shareholders", fa: "سهامداران" }} description={{ en: "Add a shareholder and what they are putting in, in one save. Cash, hawala, an asset, or a company bill they paid.", fa: "سهامدار و آنچه می‌گذارد را با یک ذخیره ثبت کنید: نقد، حواله، دارایی، یا صورت‌حسابی که خودش پرداخته." }} />
    {message ? <div className={`treasury-message ${message.ok ? "success" : "error"}`} role={message.ok ? "status" : "alert"}>{message.text}</div> : null}
    {!view ? <p className="treasury-placeholder" role="status">{copy("Loading shareholders…", "در حال بارگذاری سهامداران…")}</p> : <>
      <div className="rates-actions" style={{ flexWrap: "wrap" }}>
        {view.permissions.canManage && !form ? <button className="treasury-button gold" onClick={() => start("add")}>{copy("Add shareholder", "افزودن سهامدار")}</button> : null}
        <button className="treasury-button" disabled={disabled} onClick={() => void refresh()}>{copy("Refresh", "تازه‌سازی")}</button>
        <Link className="treasury-button" href="/finance/general-ledger">{copy("General Ledger", "دفتر کل")}</Link>
        <Link className="treasury-button" href="/finance/setup">{copy("Finance setup", "تنظیمات مالی")}</Link>
      </div>
      {!view.receiveAvailable ? <p className="treasury-message" role="status">{copy("Recording capital is currently unavailable. Ask your Finance administrator to complete the company’s settings.", "ثبت سرمایه فعلاً در دسترس نیست. از مدیر مالی بخواهید تنظیمات شرکت را تکمیل کند.")}</p> : null}
      {form ? <form className="admin-form shareholder-form" aria-label={form.kind === "add" ? copy("Add shareholder", "افزودن سهامدار") : copy("Add money", "افزودن پول")} onSubmit={event => void submit(event)} aria-busy={busy}>
        <h2>{form.kind === "add" ? copy("Add shareholder", "افزودن سهامدار") : copy(`Add money · ${holder?.name ?? ""}`, `افزودن پول · ${holder?.name ?? ""}`)}</h2>
        <fieldset disabled={disabled} style={{ ...fieldGrid, border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          {form.kind === "add" ? <Field label={copy("Name", "نام")}><input autoFocus required maxLength={160} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></Field> : null}
          <Field label={copy("What are they putting in?", "چه می‌گذارد؟")}>
            <select value={form.method} onChange={e => setForm({ ...form, method: e.target.value as Method | "", destination: "", provider: "", item: "", expenseAccount: "" })}>
              {form.kind === "add" ? <option value="">{copy("Nothing yet", "فعلاً هیچ")}</option> : null}
              {methods.map(item => <option key={item.value} value={item.value} disabled={!item.ready}>{item.label}{item.ready ? "" : copy(" — not set up yet", " — هنوز آماده نیست")}</option>)}
            </select>
          </Field>
          {form.method === "" ? null : <>
            <Field label={copy("Amount", "مبلغ")}><input required inputMode="decimal" pattern="[0-9]+(\.[0-9]+)?" dir="ltr" value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} />{form.method === "ASSET" ? <small>{copy("The value you are putting it in at. The system records it as your stated value, not an appraisal.", "ارزشی که با آن ثبت می‌شود. سیستم آن را ارزش اعلامی شما ثبت می‌کند، نه ارزیابی رسمی.")}</small> : null}</Field>
            <Field label={copy("Currency", "واحد پول")}><select required value={form.currency} onChange={e => setForm({ ...form, currency: e.target.value, destination: "" })}>{currencies.map(item => <option key={item.code} value={item.code}>{item.label}</option>)}</select></Field>
            <Field label={copy("Date", "تاریخ")}><input type="date" required max={kabulToday()} value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} /></Field>
            {cashBearing(form.method) ? <Field label={copy("Which Safe did it go into?", "به کدام صندوق رفت؟")}>
              <select required value={form.destination} onChange={e => setForm({ ...form, destination: e.target.value })}>
                <option value="">{copy("Select a Safe", "انتخاب صندوق")}</option>
                {destinations.map(item => <option key={item.id} value={item.id}>{item.name} · {item.currency}</option>)}
              </select>
              {destinations.length === 0 ? <small>{copy("No active Safe in this currency is available.", "صندوق فعال با این واحد پول موجود نیست.")}</small> : null}
            </Field> : null}
            {form.method === "HAWALA" ? <Field label={copy("Which saraf?", "کدام صرافی؟")}><input required maxLength={160} value={form.provider} onChange={e => setForm({ ...form, provider: e.target.value })} /></Field> : null}
            {form.method === "ASSET" ? <Field label={copy("What is it?", "چیست؟")}><input required maxLength={300} value={form.item} onChange={e => setForm({ ...form, item: e.target.value })} /></Field> : null}
            {form.method === "BILL_PAYMENT" ? <>
              <Field label={copy("What was the bill for?", "صورت‌حساب برای چه بود؟")}><input required maxLength={300} value={form.item} onChange={e => setForm({ ...form, item: e.target.value })} /></Field>
              <Field label={copy("Which expense account?", "کدام حساب هزینه؟")}>
                <select required value={form.expenseAccount} onChange={e => setForm({ ...form, expenseAccount: e.target.value })}>
                  <option value="">{copy("Select an expense account", "انتخاب حساب هزینه")}</option>
                  {view.expenseAccounts.map(item => <option key={item.id} value={item.id}>{item.code} · {item.name}</option>)}
                </select>
              </Field>
            </> : null}
            <Field label={form.method === "HAWALA" ? copy("Hawala reference (optional)", "مرجع حواله (اختیاری)") : copy("Reference (optional)", "مرجع (اختیاری)")}><input maxLength={120} value={form.reference} onChange={e => setForm({ ...form, reference: e.target.value })} /></Field>
          </>}
          {form.kind === "add" ? <Field label={copy("Agreed total (optional)", "مجموع توافق‌شده (اختیاری)")}><input inputMode="decimal" pattern="[0-9]+(\.[0-9]+)?" dir="ltr" value={form.agreedTotal} onChange={e => setForm({ ...form, agreedTotal: e.target.value })} /><small>{copy("Leave empty unless you want to follow a target. Their capital is what they actually put in.", "اگر هدفی را پیگیری نمی‌کنید خالی بگذارید. سرمایهٔ او همان است که واقعاً می‌گذارد.")}</small></Field> : null}
          <Field label={copy("Note (optional)", "یادداشت (اختیاری)")}><textarea maxLength={1000} value={form.note} onChange={e => setForm({ ...form, note: e.target.value })} /></Field>
          {form.kind === "add" ? <Field label={copy("Agreement document (optional)", "سند توافق (اختیاری)")}><input type="file" accept="application/pdf,image/jpeg,image/png" onChange={e => setForm({ ...form, file: e.target.files?.[0] ?? null })} /><small>{copy("PDF, JPG or PNG, up to 10 MB. You may attach it later.", "PDF، JPG یا PNG تا ۱۰ میگابایت. می‌توانید بعداً ضمیمه کنید.")}</small></Field> : null}
        </fieldset>
        {cashBearing(form.method) && form.destination ? <p className="admin-hint">{copy("Visible recorded Safe activity", "گردش ثبت‌شدهٔ قابل مشاهدهٔ صندوق")}: <b dir="ltr">{destinations.find(item => item.id === form.destination)?.balance == null ? copy("Not available with your permissions", "با صلاحیت‌های شما قابل مشاهده نیست") : money(destinations.find(item => item.id === form.destination)!.balance!, form.currency)}</b></p> : null}
        <div className="rates-actions">
          <button type="submit" className="treasury-button gold" disabled={busy || (form.method !== "" && (!view.receiveAvailable || !view.permissions.canReceive))}>{busy ? copy("Saving…", "در حال ذخیره…") : uncertain ? copy("Retry same request", "کوشش دوبارهٔ همین درخواست") : copy("Save", "ذخیره")}</button>
          <button type="button" className="treasury-button" disabled={disabled} onClick={() => setForm(null)}>{copy("Cancel", "لغو")}</button>
        </div>
      </form> : null}
      {upload ? <section className="treasury-card admin-form" aria-label={copy("Document upload", "بارگذاری سند")} style={{ padding: 14 }}><p role={attachmentError ? "alert" : "status"}>{attachmentError ?? copy("Ready to attach document", "آمادهٔ ضمیمه‌کردن سند")}</p><p>{upload.file.name}</p><div className="rates-actions"><button className="treasury-button" disabled={busy} onClick={async () => { if (running.current) return; running.current = true; setBusy(true); try { await uploadDocument(upload); } finally { running.current = false; setBusy(false); } }}>{copy("Retry document upload", "کوشش دوبارهٔ بارگذاری سند")}</button><button className="treasury-button" disabled={busy} onClick={() => { setUpload(null); setAttachmentError(null); }}>{copy("Attach later", "بعداً ضمیمه می‌کنم")}</button></div></section> : null}
      <section className="treasury-card" style={{ padding: 14, display: "grid", gap: 14 }} aria-label={copy("Shareholders", "سهامداران")}>
        <label className="admin-search"><span>{copy("Search shareholders", "جستجوی سهامداران")}</span><input type="search" value={query} onChange={e => setQuery(e.target.value)} /></label>
        {view.shareholders.length === 0 ? <p className="treasury-placeholder">{copy("No shareholders yet. Add a shareholder to begin.", "هنوز سهامداری ثبت نشده است. برای شروع یک سهامدار اضافه کنید.")}</p> : <div className="admin-list">{view.shareholders.filter(item => `${item.name} ${item.reference ?? ""}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(item => <button key={item.id} disabled={disabled} className={selected === item.id ? "selected" : ""} aria-pressed={selected === item.id} onClick={() => { setSelected(item.id); setForm(null); }}><span>◈</span><span><strong>{item.name}</strong><small>{item.reference ?? copy("Shareholder", "سهامدار")}</small></span><span>{selected === item.id ? "−" : "+"}</span></button>)}</div>}
      </section>
      {holder ? <article className="treasury-card contribution-card" aria-label={holder.name}>
        <header className="contribution-card-head"><div><h2>{holder.name}</h2><p>{holder.reference}<span>{holder.active ? copy("Active", "فعال") : copy("Inactive", "غیرفعال")}</span></p></div>{view.permissions.canReceive && holder.active && !form ? <button className="treasury-button gold" disabled={!view.receiveAvailable || disabled} onClick={() => start("capital", holder.id)}>{copy("Add money", "افزودن پول")}</button> : null}</header>
        {holder.note ? <p className="admin-hint">{holder.note}</p> : null}
        {holder.capitals.length === 0 ? <p className="admin-hint">{copy("Nothing has been put in yet.", "هنوز چیزی گذاشته نشده است.")}</p>
          : holder.capitals.map(capital => <section key={capital.currency} aria-label={`${capital.currency} ${copy("capital", "سرمایه")}`}><dl className="shareholder-figures" style={fieldGrid}>
            <div><dt>{copy("Capital put in", "سرمایهٔ گذاشته‌شده")}</dt><dd dir="ltr">{money(capital.contributed, capital.currency)}</dd></div>
            {capital.agreedTotal !== null ? <div><dt>{copy("Agreed total", "مجموع توافق‌شده")}</dt><dd dir="ltr">{money(capital.agreedTotal, capital.currency)}</dd></div> : null}
            {capital.agreedTotal !== null && capital.remaining !== null ? <div><dt>{copy("Still to come", "باقی‌مانده")}</dt><dd dir="ltr">{money(capital.remaining, capital.currency)}</dd></div> : null}
          </dl></section>)}
        <h3>{copy("History", "تاریخچه")}</h3>
        {holder.transactions.length === 0 ? <p className="admin-hint">{copy("No capital has been recorded yet.", "هنوز سرمایه‌ای ثبت نشده است.")}</p> : <div style={{ overflowX: "auto" }}><table className="shareholder-installments contribution-table"><caption className="sr-only">{copy("Capital put in", "سرمایهٔ گذاشته‌شده")}</caption><thead><tr>{[copy("Date", "تاریخ"), copy("Amount", "مبلغ"), copy("What", "چه"), copy("Where it went", "به کجا رفت"), copy("Reference", "مرجع"), copy("Note", "یادداشت"), copy("General Ledger", "دفتر کل")].map(label => <th scope="col" key={label}>{label}</th>)}</tr></thead><tbody>{holder.transactions.map(entry => <tr key={entry.id}>
          <td><time dateTime={entry.date}>{entry.date}</time></td>
          <td dir="ltr">{money(entry.amount, entry.currency)}</td>
          <td>{entry.method === "CASH" ? copy("Cash", "نقد") : entry.method === "HAWALA" ? `${copy("Hawala", "حواله")}${entry.providerName ? ` · ${entry.providerName}` : ""}` : entry.method === "ASSET" ? `${copy("Asset", "دارایی")}${entry.itemDescription ? ` · ${entry.itemDescription}` : ""}` : `${copy("Bill paid directly", "صورت‌حساب پرداخت‌شده")}${entry.itemDescription ? ` · ${entry.itemDescription}` : ""}`}</td>
          <td>{entry.destination ?? entry.debitAccount ?? "—"}</td>
          <td>{[entry.reference, entry.paymentReference].filter(Boolean).join(" · ")}</td>
          <td>{entry.note ?? "—"}</td>
          <td><Link href={`/finance/general-ledger?journalId=${encodeURIComponent(entry.journalId)}`}>{copy("View journal", "مشاهده سند")}</Link><small style={{ display: "block", overflowWrap: "anywhere" }}>{entry.journalId}</small></td>
        </tr>)}</tbody></table></div>}
        <h3>{copy("Agreement document (optional)", "سند توافق (اختیاری)")}</h3>
        {holder.documents.length === 0 ? <p className="admin-hint">{copy("No document attached", "سندی ضمیمه نشده است")}</p> : <ul style={{ display: "grid", gap: 10, paddingInlineStart: 20 }}>{holder.documents.map(document => <li key={document.id} style={{ overflowWrap: "anywhere" }}>{copy("Document attached", "سند ضمیمه شده است")} · {document.fileName} · {copy("Version", "نسخه")} {document.version} <a href={`/api/v1/shareholder/setup/documents/${encodeURIComponent(document.id)}`} target="_blank" rel="noreferrer">{copy("View document", "مشاهده سند")}</a> · <a href={`/api/v1/shareholder/setup/documents/${encodeURIComponent(document.id)}?download=1`}>{copy("Download document", "دریافت سند")}</a></li>)}</ul>}
        {view.permissions.canManage ? <div className="admin-form"><Field label={holder.documents.length ? copy("Upload another version", "بارگذاری نسخهٔ دیگر") : copy("Upload agreement", "بارگذاری سند توافق")}><input disabled={busy || !!upload} type="file" accept="application/pdf,image/jpeg,image/png" onChange={async e => { const file = e.target.files?.[0]; if (!file || running.current) return; e.target.value = ""; running.current = true; setBusy(true); const attachment = { shareholder: holder.id, file, key: crypto.randomUUID(), date: kabulToday() }; setUpload(attachment); try { await uploadDocument(attachment); } finally { running.current = false; setBusy(false); } }} /></Field></div> : null}
      </article> : null}
      {view.destinations.length ? <section className="treasury-card contribution-card" aria-label={copy("Safe balances", "موجودی صندوق‌ها")}><h2>{copy("Visible recorded Safe activity", "گردش ثبت‌شدهٔ قابل مشاهدهٔ صندوق")}</h2><p className="admin-hint">{copy("The recorded receipts and payments you may view; not a physical cash count or verified opening balance.", "دریافت‌ها و پرداخت‌های ثبت‌شده در حدود صلاحیت شما؛ نه شمارش فیزیکی نقد یا موجودی افتتاحیهٔ تأییدشده.")}</p><dl style={fieldGrid}>{view.destinations.map(destination => <div key={destination.id}><dt>{destination.name}</dt><dd dir="ltr" style={{ marginInlineStart: 0 }}>{destination.balance === null ? copy("Not available with your permissions", "با صلاحیت‌های شما قابل مشاهده نیست") : money(destination.balance, destination.currency)}</dd></div>)}</dl></section> : null}
    </>}
  </div>;
}
