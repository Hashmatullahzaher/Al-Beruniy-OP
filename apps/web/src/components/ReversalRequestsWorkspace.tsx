"use client";

import { formatDual, toDariDigits } from "@abos/calendar";
import { useCallback, useEffect, useMemo, useState } from "react";

import { AccessGate, api, errorText, formatWhen } from "@/components/AdminUsersWorkspace";
import { AppIcon } from "@/components/AppIcon";
import { useLocale } from "@/components/LocaleProvider";
import { StageZeroPageHeader } from "@/components/StageZeroWorkspace";
import type { Copy } from "@/lib/access-copy";
import type { ReversalJournal, ReversalRequestView, ReversalWorkspaceView } from "@/server/reversals";

/**
 * Controlled reversals (V1 backlog #17). A Finance user asks for a posted journal to be reversed;
 * the Finance Manager approves or rejects. Posted history never changes, and posting an approved
 * reversal waits for the Finance Manager's posting policy. The database decides everything; this
 * screen explains and asks. Amounts are decimal text and are never turned into numbers.
 */

const STATUS: Readonly<Record<string, Copy>> = {
  REQUESTED: { en: "Awaiting decision", fa: "در انتظار تصمیم" },
  APPROVED: { en: "Approved · awaits posting policy", fa: "تایید شد · در انتظار پالیسی ثبت" },
  REJECTED: { en: "Rejected", fa: "رد شد" },
  WITHDRAWN: { en: "Withdrawn", fa: "پس گرفته شد" }
};
const KIND: Readonly<Record<string, Copy>> = {
  SHAREHOLDER_CAPITAL_RECEIPT: { en: "Shareholder capital receipt", fa: "دریافت سرمایه سهامدار" },
  SHAREHOLDER_LOAN_RECEIPT: { en: "Shareholder loan receipt", fa: "دریافت قرضه سهامدار" },
  REVERSAL: { en: "Reversal", fa: "برگشت" }
};
const ERRORS: Readonly<Record<string, Copy>> = {
  REVERSAL_INDEPENDENCE: { en: "Segregation of duties: this must be done by someone else.", fa: "تفکیک وظایف: این کار باید توسط شخص دیگری انجام شود." },
  REVERSAL_STATE: { en: "This request or journal is no longer in a state that allows this.", fa: "این درخواست یا ژورنال دیگر در وضعیتی نیست که این کار را اجازه دهد." },
  REVERSAL_ALREADY_OPEN: { en: "This journal already has an open or approved reversal request.", fa: "این ژورنال قبلاً درخواست برگشت باز یا تاییدشده دارد." },
  REVERSAL_VALIDATION: { en: "Check the details you entered.", fa: "جزئیات واردشده را بررسی کنید." },
  NOT_FOUND: { en: "That journal or request was not found.", fa: "این ژورنال یا درخواست پیدا نشد." },
  POSTING_POLICY_PENDING: { en: "Posting a reversal is not available yet.", fa: "ثبت برگشت هنوز در دسترس نیست." }
};
const PENDING_POLICY: Copy = {
  en: "Approved reversals wait for the Finance Manager's posting policy: the reversal date and accounting period, the evidence it needs beyond the written reason, and what happens to the source records (capital receipt, installment, commitment, safe custody). No reversal journal is created until then.",
  fa: "برگشت‌های تاییدشده منتظر پالیسی ثبتِ مدیر مالی هستند: تاریخ و دورهٔ حسابداری برگشت، اسنادی که علاوه بر دلیل نوشته‌شده لازم است، و اثر آن بر سوابق منبع (دریافت سرمایه، قسط، تعهد، نگهداری صندوق). تا آن زمان هیچ ژورنال برگشتی ایجاد نمی‌شود."
};

/** Groups decimal text for display without converting any amount to a JavaScript number. */
function amount(value: string): string {
  const negative = value.startsWith("-");
  const [whole = "0", fraction] = (negative ? value.slice(1) : value).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "−" : ""}${grouped}${fraction === undefined ? "" : `.${fraction}`}`;
}

export function ReversalRequestsWorkspace() {
  const { locale } = useLocale();
  const fa = locale === "fa";
  const t = useCallback((copy: Copy) => copy[locale], [locale]);
  const num = useCallback((value: number) => (fa ? toDariDigits(value) : String(value)), [fa]);
  const [view, setView] = useState<ReversalWorkspaceView | null>(null);
  const [gate, setGate] = useState<"signed-out" | "denied" | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [tab, setTab] = useState<"requests" | "new">("requests");

  const fail = useCallback((error: { code: string; message: string }) => {
    const copy = ERRORS[error.code];
    setMessage({ tone: "error", text: copy ? `${copy[locale]} ${locale === "en" ? error.message : ""}`.trim() : errorText(error, locale) });
  }, [locale]);

  const load = useCallback(async () => {
    const result = await api<ReversalWorkspaceView>("/api/v1/finance/reversals");
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
    void api<ReversalWorkspaceView>("/api/v1/finance/reversals").then((result) => {
      if (!current) return;
      if (!result.ok) { setGate(result.status === 401 ? "signed-out" : result.status === 403 ? "denied" : null); return; }
      setView(result.data);
    });
    return () => { current = false; };
  }, []);

  const open = useMemo(() => (view?.requests ?? []).filter((request) => request.status === "REQUESTED" || request.status === "APPROVED"), [view]);
  const closed = useMemo(() => (view?.requests ?? []).filter((request) => request.status === "REJECTED" || request.status === "WITHDRAWN"), [view]);
  const dual = useCallback((iso: string) => {
    const dates = formatDual(iso, locale);
    return `${dates.gregorian} · ${dates.solarHijri}`;
  }, [locale]);

  if (gate) return <div className="module-workspace"><AccessGate state={gate} fa={fa} what={{
    en: "Reversals need the “Request journal reversals”, “Approve journal reversals” or “View Finance inbox and journals” permission.",
    fa: "برگشت ژورنال‌ها به صلاحیت «درخواست برگشت ژورنال»، «تایید برگشت ژورنال» یا «مشاهده صندوق مالی و ژورنال‌ها» نیاز دارد."
  }} /></div>;

  const done = async (text: Copy) => {
    setMessage({ tone: "ok", text: t(text) });
    await load();
  };

  return (
    <div className="module-workspace rev-workspace">
      <StageZeroPageHeader icon="finance"
        eyebrow={{ en: `Finance · ${view?.legalEntity.name ?? ""}`, fa: `مالی · ${view?.legalEntity.name ?? ""}` }}
        title={{ en: "Journal reversals", fa: "برگشت ژورنال‌ها" }}
        description={{ en: "A Finance user asks for a posted journal to be reversed, with a written reason. The Finance Manager approves or rejects. Posted history is never changed.",
          fa: "کاربر مالی با ذکر دلیل نوشته‌شده، برگشت یک ژورنال ثبت‌شده را درخواست می‌کند. مدیر مالی آن را تایید یا رد می‌کند. تاریخچهٔ ثبت‌شده هرگز تغییر نمی‌کند." }} />

      <section className="finance-boundary-banner rev-banner" aria-label={fa ? "وضعیت ثبت برگشت" : "Reversal posting status"}>
        <span><AppIcon name="shield" size={22} /></span>
        <div>
          <p>{fa ? "ثبت برگشت هنوز فعال نیست · دادهٔ آزمایشی" : "REVERSAL POSTING IS NOT ENABLED · SYNTHETIC DATA"}</p>
          <strong>{t(PENDING_POLICY)}</strong>
        </div>
        <em>{fa ? "ثبت: در انتظار پالیسی" : "Posting: awaits policy"}</em>
      </section>

      {message ? <div className={`treasury-message ${message.tone === "ok" ? "success" : "error"}`} role="status"><AppIcon name={message.tone === "ok" ? "shield" : "alert"} size={16} /><span>{message.text}</span><button onClick={() => setMessage(null)} aria-label={fa ? "بستن" : "Dismiss"}>×</button></div> : null}

      <div className="admin-tabs" role="tablist">
        <button role="tab" aria-selected={tab === "requests"} onClick={() => setTab("requests")}>{fa ? "درخواست‌ها" : "Requests"}<b>{num(open.length)}</b></button>
        {view?.canRequest ? <button role="tab" aria-selected={tab === "new"} onClick={() => setTab("new")}>{fa ? "درخواست برگشت" : "Request a reversal"}<b>{num(view.eligibleJournals.length)}</b></button> : null}
      </div>

      {view === null ? <p className="treasury-placeholder">{fa ? "در حال بارگذاری…" : "Loading…"}</p> : tab === "new" && view.canRequest ? (
        <NewRequest view={view} fa={fa} t={t} dual={dual} onError={fail}
          onCreated={async (reference) => { setTab("requests"); await done({ en: `Reversal of ${reference} requested. It waits for the Finance Manager's decision.`, fa: `برگشت ${reference} درخواست شد و منتظر تصمیم مدیر مالی است.` }); }} />
      ) : (
        <section className="rev-list" aria-label={fa ? "درخواست‌های برگشت" : "Reversal requests"}>
          {!view.canApprove && !view.canRequest ? <p className="admin-hint">{fa ? "شما فقط می‌توانید درخواست‌ها را ببینید." : "You can see the requests; requesting or deciding needs a reversal permission."}</p> : null}
          {open.length === 0 && closed.length === 0 ? <p className="treasury-placeholder">{fa ? "هنوز هیچ درخواست برگشتی وجود ندارد." : "No reversal has been requested yet."}</p> : null}
          {open.map((request) => <RequestCard key={`${request.id}-${request.version}`} request={request} view={view} fa={fa} t={t} dual={dual} onError={fail} onDone={done} />)}
          {closed.length > 0 ? <h2 className="rev-heading">{fa ? "بسته‌شده" : "Closed"}</h2> : null}
          {closed.map((request) => <RequestCard key={`${request.id}-${request.version}`} request={request} view={view} fa={fa} t={t} dual={dual} onError={fail} onDone={done} />)}
        </section>
      )}
    </div>
  );
}

function JournalSummary({ journal, fa, t, dual }: { readonly journal: ReversalJournal; readonly fa: boolean; readonly t: (copy: Copy) => string; readonly dual: (iso: string) => string }) {
  return (
    <div className="rev-journal">
      <dl className="rev-facts">
        <div><dt>{fa ? "نوع" : "Kind"}</dt><dd>{t(KIND[journal.intentKind] ?? { en: journal.intentKind, fa: journal.intentKind })}</dd></div>
        <div><dt>{fa ? "تاریخ حسابداری" : "Accounting date"}</dt><dd>{dual(journal.accountingEffectiveDate)}</dd></div>
        <div><dt>{fa ? "ثبت‌کننده" : "Posted by"}</dt><dd>{journal.postedBy ?? "—"}{journal.postedAt ? ` · ${formatWhen(journal.postedAt, fa ? "fa" : "en")}` : ""}</dd></div>
      </dl>
      <table className="rev-lines">
        <thead><tr><th>#</th><th>{fa ? "حساب" : "Account"}</th><th>{fa ? "بدهکار" : "Debit"}</th><th>{fa ? "بستانکار" : "Credit"}</th></tr></thead>
        <tbody>
          {journal.lines.map((line) => (
            <tr key={line.lineNumber}>
              <td data-label="#">{line.lineNumber}</td>
              <td data-label={fa ? "حساب" : "Account"}><span className="coa-code">{line.accountCode}</span> {line.accountName}</td>
              <td data-label={fa ? "بدهکار" : "Debit"} dir="ltr" className="rev-amount">{line.baseCurrency} {amount(line.baseDebit)}</td>
              <td data-label={fa ? "بستانکار" : "Credit"} dir="ltr" className="rev-amount">{line.baseCurrency} {amount(line.baseCredit)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="admin-hint">{journal.totals.map((total) => `${total.currency} · ${fa ? "بدهکار" : "debits"} ${amount(total.debits)} · ${fa ? "بستانکار" : "credits"} ${amount(total.credits)}`).join(" | ")}</p>
    </div>
  );
}

function RequestCard({ request, view, fa, t, dual, onError, onDone }: {
  readonly request: ReversalRequestView; readonly view: ReversalWorkspaceView; readonly fa: boolean; readonly t: (copy: Copy) => string;
  readonly dual: (iso: string) => string; readonly onError: (error: { code: string; message: string }) => void; readonly onDone: (text: Copy) => Promise<void>;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const reference = request.journal.reference;
  const decide = async (decision: "APPROVED" | "REJECTED") => {
    setBusy(true);
    const result = await api<{ request: ReversalRequestView }>(`/api/v1/finance/reversals/${request.id}/decision`, "POST",
      { decision, expectedVersion: request.version, note: note.trim() || null });
    setBusy(false);
    if (!result.ok) { onError(result.error); return; }
    await onDone(decision === "APPROVED"
      ? { en: `Reversal of ${reference} approved. It now awaits the Finance Manager's posting policy; nothing was posted.`, fa: `برگشت ${reference} تایید شد و اکنون منتظر پالیسی ثبت مدیر مالی است؛ چیزی ثبت نشد.` }
      : { en: `Reversal of ${reference} rejected.`, fa: `برگشت ${reference} رد شد.` });
  };
  const withdraw = async () => {
    setBusy(true);
    const result = await api<{ request: ReversalRequestView }>(`/api/v1/finance/reversals/${request.id}/withdraw`, "POST",
      { expectedVersion: request.version, note: note.trim() || null });
    setBusy(false);
    if (!result.ok) { onError(result.error); return; }
    await onDone({ en: `Reversal request for ${reference} withdrawn.`, fa: `درخواست برگشت ${reference} پس گرفته شد.` });
  };
  const waiting = request.status === "REQUESTED";
  const mayDecide = waiting && view.canApprove && !request.viewerIsRequester && !request.journal.viewerIsParticipant;
  const mayWithdraw = waiting && view.canRequest && request.viewerIsRequester;
  return (
    <article className={`module-content-card rev-card status-${request.status.toLowerCase()}`} aria-label={`${fa ? "درخواست برگشت" : "Reversal request"} ${reference}`}>
      <header>
        <div><p>{fa ? "ژورنال" : "JOURNAL"}</p><h3 dir="ltr">{reference}</h3></div>
        <em className={`treasury-chip ${request.status === "APPROVED" ? "gold" : request.status === "REJECTED" ? "danger" : request.status === "WITHDRAWN" ? "muted" : ""}`}>{t(STATUS[request.status] ?? { en: request.status, fa: request.status })}</em>
      </header>
      <JournalSummary journal={request.journal} fa={fa} t={t} dual={dual} />
      <div className="rev-reason">
        <strong>{fa ? "دلیل" : "Reason"}</strong>
        <p>{request.reason}</p>
        <small>{fa ? "درخواست‌کننده" : "Requested by"} {request.viewerIsRequester ? (fa ? "شما" : "you") : request.requestedBy} · {formatWhen(request.requestedAt, fa ? "fa" : "en")}</small>
        {request.decidedBy ? <small>{request.status === "WITHDRAWN" ? (fa ? "پس گرفته شد توسط" : "Withdrawn by") : (fa ? "تصمیم‌گیرنده" : "Decided by")} {request.viewerIsDecider ? (fa ? "شما" : "you") : request.decidedBy}{request.decidedAt ? ` · ${formatWhen(request.decidedAt, fa ? "fa" : "en")}` : ""}{request.decisionNote ? ` — ${request.decisionNote}` : ""}</small> : null}
      </div>
      {request.posting.status === "AWAITING_POSTING_POLICY" ? (
        <p className="rev-awaiting" role="note"><AppIcon name="key" size={14} /> {fa
          ? "تایید شد. ثبت ژورنال برگشت منتظر پالیسی ثبت مدیر مالی است (تاریخ و دوره، اسناد، اثر بر سوابق منبع). هیچ ژورنال برگشتی ایجاد نشده و ژورنال اصلی تغییر نکرده است."
          : "Approved. Posting the reversal journal awaits the Finance Manager's posting policy (date and period, evidence, effect on source records). No reversal journal has been created and the original journal is unchanged."}</p>
      ) : null}
      {waiting && view.canApprove && request.viewerIsRequester ? <p className="admin-hint coa-locked"><AppIcon name="shield" size={14} /> {fa ? "شما این برگشت را درخواست کرده‌اید؛ شخص دیگری باید درباره آن تصمیم بگیرد." : "You requested this reversal; someone else must decide it."}</p> : null}
      {waiting && view.canApprove && !request.viewerIsRequester && request.journal.viewerIsParticipant ? <p className="admin-hint coa-locked"><AppIcon name="shield" size={14} /> {fa ? "شما در آماده‌سازی، تایید یا ثبت این ژورنال سهم داشته‌اید؛ مدیر مالی دیگری باید تصمیم بگیرد (قاعدهٔ محتاطانه تا تصمیم مدیر مالی)." : "You prepared, approved or posted this journal, so another Finance Manager must decide (a cautious rule until the Finance Manager decides otherwise)."}</p> : null}
      {mayDecide || mayWithdraw ? (
        <div className="admin-form rev-actions">
          <label><span>{mayDecide ? (fa ? "یادداشت (برای رد لازم است)" : "Note (required to reject)") : (fa ? "یادداشت (اختیاری)" : "Note (optional)")}</span>
            <input value={note} onChange={(event) => setNote(event.target.value)} maxLength={1000} /></label>
          <div className="coa-actions">
            {mayDecide ? <>
              <button className="treasury-button gold" disabled={busy} onClick={() => void decide("APPROVED")}>{fa ? "تایید برگشت" : "Approve reversal"}</button>
              <button className="treasury-button danger" disabled={busy || note.trim().length < 3} onClick={() => void decide("REJECTED")}>{fa ? "رد برگشت" : "Reject reversal"}</button>
            </> : null}
            {mayWithdraw ? <button className="treasury-button quiet" disabled={busy} onClick={() => void withdraw()}>{fa ? "پس گرفتن درخواست" : "Withdraw request"}</button> : null}
          </div>
        </div>
      ) : null}
    </article>
  );
}

function NewRequest({ view, fa, t, dual, onCreated, onError }: {
  readonly view: ReversalWorkspaceView; readonly fa: boolean; readonly t: (copy: Copy) => string; readonly dual: (iso: string) => string;
  readonly onCreated: (reference: string) => Promise<void>; readonly onError: (error: { code: string; message: string }) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const journal = view.eligibleJournals.find((candidate) => candidate.id === selected) ?? null;
  const submit = async () => {
    if (!journal) return;
    setBusy(true);
    const result = await api<{ request: ReversalRequestView; created: boolean }>("/api/v1/finance/reversals", "POST", { journalId: journal.id, reason: reason.trim() });
    setBusy(false);
    if (!result.ok) { onError(result.error); return; }
    setReason(""); setSelected(null);
    await onCreated(journal.reference);
  };
  return (
    <section className="rev-new" aria-label={fa ? "درخواست برگشت جدید" : "New reversal request"}>
      <p className="admin-hint">{fa
        ? "ژورنال ثبت‌شده‌ای را که باید برگشت داده شود انتخاب کنید و دلیل را بنویسید. ژورنال‌هایی که قبلاً برگشت داده شده یا درخواست باز دارند اینجا نیستند. کسی که ژورنالی را آماده، تایید یا ثبت کرده نمی‌تواند برگشت آن را درخواست کند (قاعدهٔ محتاطانه تا تصمیم مدیر مالی)."
        : "Choose the posted journal to reverse and write the reason. Journals already reversed or with an open request are not listed. Whoever prepared, approved or posted a journal cannot request its reversal (a cautious rule until the Finance Manager decides otherwise)."}</p>
      {view.eligibleJournals.length === 0 ? <p className="treasury-placeholder">{fa ? "هیچ ژورنال ثبت‌شده‌ای برای برگشت در دسترس نیست." : "No posted journal is available to reverse."}</p> : null}
      <div className="rev-journal-list">
        {view.eligibleJournals.map((candidate) => (
          <article key={candidate.id} className={`module-content-card rev-card ${selected === candidate.id ? "selected" : ""}`} aria-label={`${fa ? "ژورنال" : "Journal"} ${candidate.reference}`}>
            <header>
              <div><p>{t(KIND[candidate.intentKind] ?? { en: candidate.intentKind, fa: candidate.intentKind })}</p><h3 dir="ltr">{candidate.reference}</h3></div>
              {candidate.viewerIsParticipant
                ? <em className="treasury-chip muted">{fa ? "شما در این ژورنال سهم داشتید" : "You took part in this journal"}</em>
                : <button className="treasury-button" aria-pressed={selected === candidate.id} onClick={() => setSelected(candidate.id)}>{selected === candidate.id ? (fa ? "انتخاب شد" : "Selected") : (fa ? "انتخاب" : "Choose")}</button>}
            </header>
            <JournalSummary journal={candidate} fa={fa} t={t} dual={dual} />
          </article>
        ))}
      </div>
      {view.eligibleHasMore ? <p className="admin-hint" role="note">{fa ? `فقط ${toDariDigits(view.eligibleLimit)} ژورنال تازه نشان داده می‌شود.` : `Only the newest ${view.eligibleLimit} journals are shown.`}</p> : null}
      {journal ? (
        <form className="admin-form rev-form" aria-label={fa ? "فرم درخواست برگشت" : "Reversal request form"} onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <h2>{fa ? `درخواست برگشت ${journal.reference}` : `Request reversal of ${journal.reference}`}</h2>
          <label><span>{fa ? "دلیل برگشت (۱۰ تا ۱۰۰۰ حرف)" : "Reason for the reversal (10–1000 characters)"}</span>
            <textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={1000} rows={3} required /></label>
          <p className="admin-hint">{fa ? "مدیر مالی درخواست را تایید یا رد می‌کند. تایید چیزی را ثبت نمی‌کند؛ ثبت برگشت منتظر پالیسی ثبت است." : "The Finance Manager approves or rejects the request. Approval posts nothing; posting waits for the posting policy."}</p>
          <div className="coa-actions">
            <button type="submit" className="treasury-button gold" disabled={busy || reason.trim().length < 10}>{fa ? "ارسال درخواست" : "Send request"}</button>
            <button type="button" className="treasury-button quiet" onClick={() => setSelected(null)}>{fa ? "لغو" : "Cancel"}</button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
