"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";

import { AccessGate, api, errorText } from "@/components/AdminUsersWorkspace";
import { exactDecimal } from "@/components/ExchangeRatesWorkspace";
import { useLocale } from "@/components/LocaleProvider";
import { kabulToday } from "@/components/OperationalFinanceShared";
import { StageZeroPageHeader } from "@/components/StageZeroWorkspace";

// Read projections only: the server owns all amounts, balances and permission decisions.
interface Capital { readonly currency: string; readonly total: string; readonly received: string; readonly outstanding: string; readonly available: string }
interface Receipt { readonly id: string; readonly date: string; readonly amount: string; readonly currency: string; readonly destination: string; readonly reference: string; readonly status: "POSTED"; readonly journalId: string; readonly note: string | null; readonly paymentReference: string | null }
interface Holder { readonly id: string; readonly name: string; readonly reference: string | null; readonly note: string | null; readonly ownershipPercent: string | null; readonly active: boolean; readonly capitals: readonly Capital[]; readonly transactions: readonly Receipt[]; readonly documents: readonly { readonly id: string; readonly fileName: string; readonly version: number }[] }
interface Workspace { readonly legalEntity: { readonly id: string; readonly name: string; readonly baseCurrency: string | null }; readonly permissions: { readonly canManage: boolean; readonly canReceive: boolean }; readonly currencies: readonly { readonly code: string; readonly label: string }[]; readonly destinations: readonly { readonly id: string; readonly name: string; readonly currency: string; readonly balance: string | null }[]; readonly shareholders: readonly Holder[]; readonly receiveAvailable: boolean; readonly unavailableReason: string | null }
interface Result { readonly shareholderProfileId?: string; readonly receiptId?: string; readonly journalId?: string; readonly reference?: string; readonly workspace: Workspace }
type CreateForm = { kind: "create"; name: string; amount: string; currency: string; ownership: string; reference: string; note: string; file: File | null; key: string; correlation: string };
type ReceiveForm = { kind: "receive"; shareholder: string; amount: string; currency: string; date: string; destination: string; reference: string; note: string; key: string; correlation: string };
type Form = CreateForm | ReceiveForm;
type Upload = { shareholder: string; file: File; key: string; date: string };
const ENDPOINT = "/api/v1/shareholder/capital";
const fieldGrid = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))", gap: 12 };
const money = (amount: string, currency: string) => `${currency} ${exactDecimal(amount)}`;
const optional = (value: string) => value.trim() || null;

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
      setAttachmentError(`${copy("The shareholder is saved. The document was not attached; retry the upload below. Capital can still be received.", "سهامدار ذخیره شده است. سند ضمیمه نشد؛ بارگذاری را دوباره کوشش کنید. دریافت سرمایه همچنان ممکن است.")} ${detail}`);
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (running.current || !form) return;
    running.current = true; setBusy(true); setMessage(null);
    const current = form;
    const body = uncertain && submitted.current ? submitted.current : current.kind === "create" ? {
      action: "create-shareholder", displayName: current.name.trim(), totalCapital: current.amount.trim(), currencyCode: current.currency,
      ownershipPercent: optional(current.ownership), externalReference: optional(current.reference), note: optional(current.note),
      businessDate: kabulToday(), idempotencyKey: current.key, correlationId: current.correlation
    } : {
      action: "receive-capital", shareholderProfileId: current.shareholder, amount: current.amount.trim(), currencyCode: current.currency,
      receiptDate: current.date, destinationAccountId: current.destination, paymentReference: optional(current.reference), note: optional(current.note),
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
          OVER_RECEIPT: ["The amount is greater than the capital still outstanding.", "مبلغ از سرمایهٔ باقی‌مانده بیشتر است."],
          PERIOD_NOT_OPEN: ["No open accounting period covers this date. Ask your Finance administrator.", "برای این تاریخ دورهٔ حسابداری باز وجود ندارد. با مدیر مالی تماس بگیرید."],
          CURRENCY_MISMATCH: ["Choose a Safe/account in the same currency.", "صندوق یا حساب با همان واحد پول انتخاب کنید."],
          NETWORK: ["Confirmation was not received. Retry this same request; it will not be recorded twice.", "تأیید دریافت نشد. همین درخواست را دوباره کوشش کنید؛ دوباره ثبت نمی‌شود."]
        };
        const known = errors[result.error.code];
        setMessage({ ok: false, text: network ? copy(...errors.NETWORK!) : known ? copy(...known) : errorText(result.error, locale) });
        return;
      }
      setUncertain(false); submitted.current = null; setForm(null); setView(result.data.workspace);
      const shareholderId = current.kind === "receive" ? current.shareholder : result.data.shareholderProfileId;
      if (shareholderId) setSelected(shareholderId);
      setMessage({ ok: true, text: current.kind === "create" ? copy("Shareholder saved. You can now receive capital.", "سهامدار ذخیره شد. اکنون می‌توانید سرمایه دریافت کنید.") : copy(`Capital received · ${result.data.reference ?? ""}`, `سرمایه دریافت شد · ${result.data.reference ?? ""}`) });
      if (current.kind === "create" && current.file && shareholderId) {
        const attachment = { shareholder: shareholderId, file: current.file, key: crypto.randomUUID(), date: kabulToday() };
        setUpload(attachment); await uploadDocument(attachment);
      }
    } finally { running.current = false; setBusy(false); }
  };

  const startCreate = () => {
    submitted.current = null; setUncertain(false); setMessage(null);
    setForm({ kind: "create", name: "", amount: "", currency: view?.currencies[0]?.code ?? "", ownership: "", reference: "", note: "", file: null, key: crypto.randomUUID(), correlation: crypto.randomUUID() });
  };
  const holder = view?.shareholders.find(item => item.id === selected) ?? null;
  const currencies = form?.kind === "receive" ? holder?.capitals.map(item => ({ code: item.currency, label: item.currency })) ?? [] : view?.currencies ?? [];
  const destinations = view?.destinations.filter(item => item.currency === form?.currency) ?? [];
  const disabled = busy || uncertain;

  if (gate) return <div className="module-workspace"><AccessGate state={gate} fa={fa} what={{ en: "Ask your administrator for access to shareholder capital.", fa: "برای دسترسی به سرمایه سهامداران با مدیر تماس بگیرید." }} /></div>;

  return <div className="module-workspace shareholder-workspace" dir={fa ? "rtl" : "ltr"}>
    <StageZeroPageHeader icon="coins" eyebrow={{ en: view?.legalEntity.name ?? "Shareholders", fa: view?.legalEntity.name ?? "سهامداران" }} title={{ en: "Shareholder capital", fa: "سرمایه سهامداران" }} description={{ en: "Record capital once. Follow each shareholder’s received and outstanding amounts.", fa: "سرمایه را یک‌بار ثبت کنید. مبالغ دریافت‌شده و باقی‌ماندهٔ هر سهامدار را ببینید." }} />
    {message ? <div className={`treasury-message ${message.ok ? "success" : "error"}`} role={message.ok ? "status" : "alert"}>{message.text}</div> : null}
    {!view ? <p className="treasury-placeholder" role="status">{copy("Loading shareholders…", "در حال بارگذاری سهامداران…")}</p> : <>
      <div className="rates-actions" style={{ flexWrap: "wrap" }}>
        {view.permissions.canManage && !form ? <button className="treasury-button gold" onClick={startCreate}>{copy("Add shareholder", "افزودن سهامدار")}</button> : null}
        <button className="treasury-button" disabled={busy || uncertain} onClick={() => void refresh()}>{copy("Refresh", "تازه‌سازی")}</button>
        <Link className="treasury-button" href="/finance/general-ledger">{copy("General Ledger", "دفتر کل")}</Link>
        <Link className="treasury-button" href="/finance/treasury">{copy("Safes & accounts", "صندوق‌ها و حساب‌ها")}</Link>
      </div>
      {!view.receiveAvailable ? <p className="treasury-message" role="status">{copy("Receiving capital is currently unavailable. Ask your Finance administrator to complete the company’s settings.", "دریافت سرمایه فعلاً در دسترس نیست. از مدیر مالی بخواهید تنظیمات شرکت را تکمیل کند.")}</p> : null}
      {form ? <form className="admin-form shareholder-form" aria-label={form.kind === "create" ? copy("Add shareholder", "افزودن سهامدار") : copy("Receive Capital", "دریافت سرمایه")} onSubmit={event => void submit(event)} aria-busy={busy}>
        <h2>{form.kind === "create" ? copy("Add shareholder", "افزودن سهامدار") : copy(`Receive Capital · ${holder?.name ?? ""}`, `دریافت سرمایه · ${holder?.name ?? ""}`)}</h2>
        <fieldset disabled={disabled} style={{ ...fieldGrid, border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          {form.kind === "create" ? <Field label={copy("Name", "نام")}><input autoFocus required maxLength={160} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></Field> : null}
          <Field label={form.kind === "create" ? copy("Total Capital", "مجموع سرمایه") : copy("Amount received", "مبلغ دریافت‌شده")}><input required inputMode="decimal" pattern="[0-9]+(\.[0-9]+)?" dir="ltr" value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} /></Field>
          <Field label={copy("Currency", "واحد پول")}><select required value={form.currency} onChange={e => setForm(form.kind === "receive" ? { ...form, currency: e.target.value, destination: "" } : { ...form, currency: e.target.value })}><option value="">{copy("Select currency", "انتخاب واحد پول")}</option>{currencies.map(item => <option key={item.code} value={item.code}>{item.label}</option>)}</select></Field>
          {form.kind === "create" ? <Field label={copy("Ownership % (optional)", "سهم ٪ (اختیاری)")}><input inputMode="decimal" dir="ltr" maxLength={12} value={form.ownership} onChange={e => setForm({ ...form, ownership: e.target.value })} /></Field> : <>
            <Field label={copy("Date", "تاریخ")}><input type="date" required max={kabulToday()} value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} /></Field>
            <Field label={copy("Destination Safe / account", "صندوق یا حساب مقصد")}><select required value={form.destination} onChange={e => setForm({ ...form, destination: e.target.value })}><option value="">{copy("Select destination", "انتخاب مقصد")}</option>{destinations.map(item => <option key={item.id} value={item.id}>{item.name} · {item.currency}</option>)}</select>{destinations.length === 0 ? <small>{copy("No active account in this currency is available.", "حساب فعال با این واحد پول موجود نیست.")}</small> : null}</Field>
          </>}
          <Field label={copy("Reference (optional)", "مرجع (اختیاری)")}><input maxLength={form.kind === "create" ? 60 : 120} value={form.reference} onChange={e => setForm({ ...form, reference: e.target.value })} /></Field>
          <Field label={copy("Note (optional)", "یادداشت (اختیاری)")}><textarea maxLength={1000} value={form.note} onChange={e => setForm({ ...form, note: e.target.value })} /></Field>
          {form.kind === "create" ? <Field label={copy("Agreement document (optional)", "سند توافق (اختیاری)")}><input type="file" accept="application/pdf,image/jpeg,image/png" onChange={e => setForm({ ...form, file: e.target.files?.[0] ?? null })} /><small>{copy("PDF, JPG or PNG, up to 10 MB. You may attach it later.", "PDF، JPG یا PNG تا ۱۰ میگابایت. می‌توانید بعداً ضمیمه کنید.")}</small></Field> : null}
        </fieldset>
        {form.kind === "receive" && form.destination ? <p className="admin-hint">{copy("Visible recorded Safe activity", "گردش ثبت‌شدهٔ قابل مشاهدهٔ صندوق")}: <b dir="ltr">{destinations.find(item => item.id === form.destination)?.balance == null ? copy("Not available with your permissions", "با صلاحیت‌های شما قابل مشاهده نیست") : money(destinations.find(item => item.id === form.destination)!.balance!, form.currency)}</b></p> : null}
        <div className="rates-actions"><button type="submit" className="treasury-button gold" disabled={busy || (form.kind === "receive" && (!view.receiveAvailable || !view.permissions.canReceive))}>{busy ? copy("Saving…", "در حال ذخیره…") : uncertain ? copy("Retry same request", "کوشش دوبارهٔ همین درخواست") : form.kind === "create" ? copy("Save shareholder", "ذخیره سهامدار") : copy("Save / Receive", "ذخیره / دریافت")}</button><button type="button" className="treasury-button" disabled={busy || uncertain} onClick={() => setForm(null)}>{copy("Cancel", "لغو")}</button></div>
      </form> : null}
      {upload ? <section className="treasury-card admin-form" aria-label={copy("Document upload", "بارگذاری سند")} style={{ padding: 14 }}><p role={attachmentError ? "alert" : "status"}>{attachmentError ?? copy("Ready to attach document", "آمادهٔ ضمیمه‌کردن سند")}</p><p>{upload.file.name}</p><div className="rates-actions"><button className="treasury-button" disabled={busy} onClick={async () => { if (running.current) return; running.current = true; setBusy(true); try { await uploadDocument(upload); } finally { running.current = false; setBusy(false); } }}>{copy("Retry document upload", "کوشش دوبارهٔ بارگذاری سند")}</button><button className="treasury-button" disabled={busy} onClick={() => { setUpload(null); setAttachmentError(null); }}>{copy("Attach later", "بعداً ضمیمه می‌کنم")}</button></div></section> : null}
      <section className="treasury-card" style={{ padding: 14, display: "grid", gap: 14 }} aria-label={copy("Shareholders", "سهامداران")}>
        <label className="admin-search"><span>{copy("Search shareholders", "جستجوی سهامداران")}</span><input type="search" value={query} onChange={e => setQuery(e.target.value)} /></label>
        {view.shareholders.length === 0 ? <p className="treasury-placeholder">{copy("No shareholders yet. Add a shareholder to begin.", "هنوز سهامداری ثبت نشده است. برای شروع یک سهامدار اضافه کنید.")}</p> : <div className="admin-list">{view.shareholders.filter(item => `${item.name} ${item.reference ?? ""}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(item => <button key={item.id} disabled={busy || uncertain} className={selected === item.id ? "selected" : ""} aria-pressed={selected === item.id} onClick={() => { setSelected(item.id); setForm(null); }}><span>◈</span><span><strong>{item.name}</strong><small>{item.reference ?? copy("Shareholder", "سهامدار")}</small></span><span>{selected === item.id ? "−" : "+"}</span></button>)}</div>}
      </section>
      {holder ? <article className="treasury-card contribution-card" aria-label={holder.name}>
        <header className="contribution-card-head"><div><h2>{holder.name}</h2><p>{holder.reference}{holder.ownershipPercent !== null ? <span>{copy("Ownership", "سهم")}: {exactDecimal(holder.ownershipPercent)}%</span> : null}<span>{holder.active ? copy("Active", "فعال") : copy("Inactive", "غیرفعال")}</span></p></div>{view.permissions.canReceive && holder.active && !form ? <button className="treasury-button gold" disabled={!view.receiveAvailable || busy || holder.capitals.length === 0 || uncertain} onClick={() => { submitted.current = null; setUncertain(false); setForm({ kind: "receive", shareholder: holder.id, amount: "", currency: holder.capitals[0]?.currency ?? "", destination: "", date: kabulToday(), reference: "", note: "", key: crypto.randomUUID(), correlation: crypto.randomUUID() }); }}>{copy("Receive Capital", "دریافت سرمایه")}</button> : null}</header>
        {holder.note ? <p className="admin-hint">{holder.note}</p> : null}
        {holder.capitals.map(capital => <section key={capital.currency} aria-label={`${capital.currency} ${copy("capital", "سرمایه")}`}><dl className="shareholder-figures" style={fieldGrid}>{[[copy("Total Capital", "مجموع سرمایه"), capital.total], [copy("Capital Received", "سرمایه دریافت‌شده"), capital.received], [copy("Capital Outstanding", "سرمایه باقی‌مانده"), capital.outstanding]].map(([label, amount]) => <div key={label}><dt>{label}</dt><dd dir="ltr">{money(amount!, capital.currency)}</dd></div>)}</dl></section>)}
        <h3>{copy("Transaction History", "تاریخچه تراکنش‌ها")}</h3>
        {holder.transactions.length === 0 ? <p className="admin-hint">{copy("No capital has been received yet.", "هنوز سرمایه دریافت نشده است.")}</p> : <div style={{ overflowX: "auto" }}><table className="shareholder-installments contribution-table"><caption className="sr-only">{copy("Capital receipts", "دریافت‌های سرمایه")}</caption><thead><tr>{[copy("Date", "تاریخ"), copy("Amount", "مبلغ"), copy("Destination Safe / account", "صندوق یا حساب مقصد"), copy("Reference", "مرجع"), copy("Status", "وضعیت"), copy("Note / reference", "یادداشت / مرجع"), copy("General Ledger", "دفتر کل")].map(label => <th scope="col" key={label}>{label}</th>)}</tr></thead><tbody>{holder.transactions.map(receipt => <tr key={receipt.id}><td><time dateTime={receipt.date}>{receipt.date}</time></td><td dir="ltr">{money(receipt.amount, receipt.currency)}</td><td>{receipt.destination}</td><td>{receipt.reference}</td><td>{copy("Received", "دریافت شد")}</td><td>{[receipt.paymentReference, receipt.note].filter(Boolean).join(" · ") || "—"}</td><td><Link href={`/finance/general-ledger?journalId=${encodeURIComponent(receipt.journalId)}`}>{copy("View journal", "مشاهده سند")}</Link><small style={{ display: "block", overflowWrap: "anywhere" }}>{receipt.journalId}</small></td></tr>)}</tbody></table></div>}
        <h3>{copy("Agreement document (optional)", "سند توافق (اختیاری)")}</h3>
        {holder.documents.length === 0 ? <p className="admin-hint">{copy("No document attached", "سندی ضمیمه نشده است")}</p> : <ul style={{ display: "grid", gap: 10, paddingInlineStart: 20 }}>{holder.documents.map(document => <li key={document.id} style={{ overflowWrap: "anywhere" }}>{copy("Document attached", "سند ضمیمه شده است")} · {document.fileName} · {copy("Version", "نسخه")} {document.version} <a href={`/api/v1/shareholder/setup/documents/${encodeURIComponent(document.id)}`} target="_blank" rel="noreferrer">{copy("View document", "مشاهده سند")}</a> · <a href={`/api/v1/shareholder/setup/documents/${encodeURIComponent(document.id)}?download=1`}>{copy("Download document", "دریافت سند")}</a></li>)}</ul>}
        {view.permissions.canManage ? <div className="admin-form"><Field label={holder.documents.length ? copy("Upload another version", "بارگذاری نسخهٔ دیگر") : copy("Upload agreement", "بارگذاری سند توافق")}><input disabled={busy || !!upload} type="file" accept="application/pdf,image/jpeg,image/png" onChange={async e => { const file = e.target.files?.[0]; if (!file || running.current) return; e.target.value = ""; running.current = true; setBusy(true); const attachment = { shareholder: holder.id, file, key: crypto.randomUUID(), date: kabulToday() }; setUpload(attachment); try { await uploadDocument(attachment); } finally { running.current = false; setBusy(false); } }} /></Field></div> : null}
      </article> : null}
      {view.destinations.length ? <section className="treasury-card contribution-card" aria-label={copy("Safe balances", "موجودی صندوق‌ها")}><h2>{copy("Visible recorded Safe activity", "گردش ثبت‌شدهٔ قابل مشاهدهٔ صندوق")}</h2><p className="admin-hint">{copy("The recorded receipts and payments you may view; not a physical cash count or verified opening balance.", "دریافت‌ها و پرداخت‌های ثبت‌شده در حدود صلاحیت شما؛ نه شمارش فیزیکی نقد یا موجودی افتتاحیهٔ تأییدشده.")}</p><dl style={fieldGrid}>{view.destinations.map(destination => <div key={destination.id}><dt>{destination.name}</dt><dd dir="ltr" style={{ marginInlineStart: 0 }}>{destination.balance === null ? copy("Not available with your permissions", "با صلاحیت‌های شما قابل مشاهده نیست") : money(destination.balance, destination.currency)}</dd></div>)}</dl></section> : null}
    </>}
  </div>;
}
