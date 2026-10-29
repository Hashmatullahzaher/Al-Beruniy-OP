"use client";

import type { JournalReversalWorkspace as Workspace, ReversibleJournalView } from "@abos/contracts";
import { useCallback, useEffect, useState } from "react";

import { AccessGate, api, errorText } from "@/components/AdminUsersWorkspace";
import { AppIcon } from "@/components/AppIcon";
import { useLocale } from "@/components/LocaleProvider";
import { money } from "@/components/OperationalFinanceShared";
import { StageZeroPageHeader } from "@/components/StageZeroWorkspace";
import type { Copy } from "@/lib/access-copy";

const ENDPOINT = "/api/v1/finance/journal-reversals";

const SOURCE_COPY: Readonly<Record<string, Copy>> = {
  OPERATIONAL_EXPENSE: { en: "Expense", fa: "مصرف" },
  CASH_RECEIPT: { en: "Cash received", fa: "پول دریافت‌شده" },
  TREASURY_TRANSFER: { en: "Transfer", fa: "انتقال" },
  PAYMENT: { en: "Payment", fa: "پرداخت" },
  OPENING_BALANCE: { en: "Opening balance", fa: "موجودی افتتاحیه" },
  DIRECT_SHAREHOLDER_CAPITAL: { en: "Shareholder capital", fa: "سرمایهٔ سهامدار" }
};

const STATUS_COPY: Readonly<Record<string, Copy>> = {
  REQUESTED: { en: "Waiting for approval", fa: "منتظر تأیید" },
  APPROVED: { en: "Approved", fa: "تأیید شد" },
  REJECTED: { en: "Rejected", fa: "رد شد" },
  WITHDRAWN: { en: "Withdrawn", fa: "پس گرفته شد" }
};

const ERROR_FA: Readonly<Record<string, string>> = {
  INSUFFICIENT_FUNDS: "برگشت این مورد صندوق را زیر صفر می‌برد. صندوق، صندوقچه و تنخواه هرگز زیر صفر نمی‌رود.",
  APPROVAL_REQUIRED: "شرکت شما برای برگشت، درخواست تأییدشده لازم دارد. درخواست برگشت بفرستید.",
  SECOND_PERSON_REQUIRED: "شخص دیگری باید درباره این درخواست تصمیم بگیرد.",
  PARTICIPANT: "کسی که این معامله را آماده، تأیید یا ثبت کرده نمی‌تواند آن را برگشت دهد، درخواست کند یا تصمیم بگیرد.",
  ALREADY_REVERSED: "این معامله قبلاً برگشت داده شده است.",
  IS_REVERSAL: "این خودش یک برگشت است؛ دوباره برگشت داده نمی‌شود.",
  NOT_REVERSIBLE: "این نوع معامله هنوز برگشت داده نمی‌شود.",
  OPEN_REQUEST: "این معامله درخواست برگشت باز دارد؛ درباره همان تصمیم بگیرید.",
  PERIOD_CLOSED: "ماه جاری بسته یا موجود نیست؛ برگشت جایی برای ثبت ندارد.",
  STALE_VERSION: "در این میان تغییر کرد. دوباره بارگذاری کنید.",
  ALREADY_DECIDED: "درباره این درخواست قبلاً تصمیم گرفته شده است.",
  REASON_REQUIRED: "دلیل را بنویسید (دست‌کم ۱۰ حرف).",
  NOTE_REQUIRED: "بگویید چرا رد می‌شود.",
  NOT_FOUND: "برای شرکت شما در دسترس نیست."
};

function message(error: { code: string; message: string }, fa: boolean): string {
  return fa ? ERROR_FA[error.code] ?? errorText(error, "fa") : error.message || errorText(error, "en");
}

function identity() {
  return { idempotencyKey: `reversal-${crypto.randomUUID()}`, correlationId: crypto.randomUUID() };
}

export function JournalReversalsWorkspace() {
  const { locale } = useLocale();
  const fa = locale === "fa";
  const t = useCallback((copy: Copy) => copy[locale], [locale]);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [gate, setGate] = useState<"signed-out" | "denied" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Copy | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<{ id: string; reason: string; request: ReturnType<typeof identity> } | null>(null);
  const [rejecting, setRejecting] = useState<{ id: string; note: string } | null>(null);

  useEffect(() => {
    let current = true;
    void api<Workspace>(ENDPOINT).then((result) => {
      if (!current) return;
      if (result.ok) { setWorkspace(result.data); setGate(null); return; }
      setGate(result.status === 401 ? "signed-out" : result.status === 403 ? "denied" : null);
      if (result.status !== 401 && result.status !== 403) setError(message(result.error, fa));
    });
    return () => { current = false; };
  }, [fa]);

  const post = async (body: Record<string, unknown>, done: Copy) => {
    setBusy(true); setError(null);
    const result = await api<{ workspace: Workspace }>(ENDPOINT, "POST", body);
    setBusy(false);
    if (!result.ok) { setError(message(result.error, fa)); return; }
    setWorkspace(result.data.workspace); setNotice(done); setOpen(null); setRejecting(null);
  };

  if (gate) {
    return <div className="module-workspace"><AccessGate state={gate} fa={fa} what={{
      en: "Journal reversals need permission to reverse, request or approve reversals.",
      fa: "برگشت ژورنال‌ها به صلاحیت برگشت، درخواست یا تأیید برگشت نیاز دارد."
    }} /></div>;
  }

  const direct = workspace?.canReverseDirectly ?? false;
  const action = (journal: ReversibleJournalView): "reverse" | "request" | null => {
    if (!workspace || journal.reversal || journal.blocker) return null;
    // Simple Mode: the permitted person may correct their own entry (recorded as a self-correction).
    if (direct) return "reverse";
    // Advanced Mode: whoever recorded or approved it can neither ask for nor approve its reversal.
    return workspace.canRequest && !journal.viewerIsParticipant ? "request" : null;
  };
  const why = (journal: ReversibleJournalView): string | null => {
    if (journal.reversal) return null;
    if (journal.blocker === "OPEN_REQUEST" || journal.blocker === "APPROVED_REQUEST") return fa ? "درخواست برگشت دارد" : "Has a reversal request";
    if (journal.viewerIsParticipant) return fa ? "شما آن را ثبت کرده‌اید؛ در حالت تأیید شخص دیگری باید برگشت دهد" : "You recorded it; with approvals on, another person must reverse it";
    return null;
  };

  return (
    <div className="module-workspace reversals-workspace">
      <StageZeroPageHeader icon="finance"
        eyebrow={{ en: "Finance · Accounting", fa: "مالی · حسابداری" }}
        title={{ en: "Journal reversals", fa: "برگشت ژورنال‌ها" }}
        description={{
          en: "A mistaken transaction is corrected by an exact reversal. The original stays as it was; the reversal is linked to it and posted on its date while that month is open, otherwise today.",
          fa: "معاملهٔ اشتباه با برگشت دقیق اصلاح می‌شود. اصل همان‌طور می‌ماند؛ برگشت به آن وصل است و تا ماه آن باز است در همان تاریخ، وگرنه امروز ثبت می‌شود."
        }} />

      {notice ? <div className="treasury-message success" role="status"><AppIcon name="shield" size={16} /><span>{t(notice)}</span>
        <button onClick={() => setNotice(null)} aria-label={fa ? "بستن" : "Dismiss"}>×</button></div> : null}
      {error ? <div className="treasury-message error" role="alert"><AppIcon name="alert" size={16} /><span>{error}</span>
        <button onClick={() => setError(null)} aria-label={fa ? "بستن" : "Dismiss"}>×</button></div> : null}

      {workspace === null ? <p className="treasury-placeholder">{fa ? "در حال بارگذاری…" : "Loading…"}</p> : <>
        <p className="admin-hint" role="note">{workspace.approvalRequired
          ? (fa ? "کنترل پیشرفته: هر برگشت درخواست می‌شود و شخص دیگری آن را تأیید و ثبت می‌کند." : "Advanced controls: every reversal is requested, then another person approves it and it posts.")
          : (fa ? "حالت ساده: شخص مجاز با نوشتن دلیل، مستقیم برگشت می‌دهد." : "Simple mode: a permitted person reverses directly with a written reason.")}</p>

        <section className="module-content-card">
          <h2>{fa ? "معاملات اخیر" : "Recent transactions"}</h2>
          {workspace.journals.length === 0 ? <p>{fa ? "هنوز معامله‌ای ثبت نشده است." : "Nothing has been recorded yet."}</p> : (
            <div className="table-scroll"><table className="rates-table reversals-table"><thead><tr>
              <th>{fa ? "تاریخ" : "Date"}</th><th>{fa ? "مرجع" : "Reference"}</th><th>{fa ? "نوع" : "What"}</th>
              <th>{fa ? "مبلغ" : "Amount"}</th><th>{fa ? "ثبت توسط" : "Posted by"}</th><th>{fa ? "برگشت" : "Reversal"}</th>
            </tr></thead><tbody>{workspace.journals.map((journal) => {
              const kind = action(journal);
              return [
                <tr key={journal.id}>
                  <td dir="ltr">{journal.date}</td><td dir="ltr">{journal.reference}</td>
                  <td>{t(SOURCE_COPY[journal.sourceType] ?? { en: journal.sourceType, fa: journal.sourceType })}</td>
                  <td dir="ltr">{money(journal.amount, journal.currency)}</td><td>{journal.postedBy ?? "—"}</td>
                  <td>{journal.reversal ? <span>{fa ? "برگشت شد: " : "Reversed: "}<span dir="ltr">{journal.reversal.reference}</span> · <span dir="ltr">{journal.reversal.date}</span>
                      {journal.reversal.selfReversal ? <> · <em>{fa ? "اصلاح توسط خود ثبت‌کننده" : "self-correction"}</em></> : null}</span>
                    : kind ? <button className="treasury-button" type="button" disabled={busy} onClick={() => setOpen({ id: journal.id, reason: "", request: identity() })}>
                        {kind === "reverse" ? (fa ? "برگشت" : "Reverse") : (fa ? "درخواست برگشت" : "Request reversal")}</button>
                      : <small className="admin-hint">{why(journal) ?? "—"}</small>}</td>
                </tr>,
                open?.id === journal.id && kind ? (
                  <tr key={`${journal.id}-form`}><td colSpan={6}>
                    <form className="admin-form reversal-form" aria-label={fa ? `برگشت ${journal.reference}` : `Reverse ${journal.reference}`}
                      onSubmit={(event) => { event.preventDefault(); void post(kind === "reverse"
                        ? { action: "reverse", journalId: journal.id, reason: open.reason.trim(), ...open.request }
                        : { action: "request", journalId: journal.id, reason: open.reason.trim() },
                        kind === "reverse" ? { en: "Reversal posted.", fa: "برگشت ثبت شد." } : { en: "Reversal requested; another person approves it.", fa: "برگشت درخواست شد؛ شخص دیگری تأیید می‌کند." }); }}>
                      <table className="rates-table reversal-lines"><thead><tr><th>{fa ? "حساب" : "Account"}</th><th>{fa ? "بدهکار ← بستانکار" : "Debit → credit"}</th></tr></thead>
                        <tbody>{journal.lines.map((line) => (
                          <tr key={line.lineNumber}><td><span dir="ltr">{line.accountCode}</span> {line.accountName}</td>
                            <td dir="ltr">{line.debit !== "0" ? `Dr ${line.debit} → Cr ${line.debit}` : `Cr ${line.credit} → Dr ${line.credit}`}</td></tr>))}</tbody></table>
                      <p className="admin-hint">{journal.periodStatus === "OPEN"
                        ? (fa ? `برگشت در همان تاریخ ${journal.date} ثبت می‌شود.` : `The reversal posts on the same date, ${journal.date}.`)
                        : (fa ? `ماه آن بسته است؛ برگشت امروز (${workspace.today}) در ماه جاری ثبت می‌شود و اصل دست نمی‌خورد.`
                          : `Its month is closed: the reversal posts today (${workspace.today}) in the current month; the original stays as it is.`)}</p>
                      {kind === "reverse" && journal.viewerIsParticipant ? <p className="admin-hint" role="note">{fa
                        ? "این اصلاح ثبت خود شماست و به‌عنوان «اصلاح توسط خود ثبت‌کننده» در حسابرسی می‌ماند."
                        : "This corrects your own entry; it is recorded in the audit trail as a self-correction."}</p> : null}
                      <label><span>{fa ? "دلیل *" : "Reason *"}</span>
                        <textarea rows={2} maxLength={1000} value={open.reason} onChange={(event) => setOpen({ ...open, reason: event.target.value, request: identity() })} /></label>
                      <div className="admin-form-actions">
                        <button className="treasury-button gold" type="submit" disabled={busy || open.reason.trim().length < 10}>{fa ? "ذخیره" : "Save"}</button>
                        <button className="treasury-button" type="button" onClick={() => setOpen(null)}>{fa ? "لغو" : "Cancel"}</button>
                      </div>
                    </form>
                  </td></tr>
                ) : null
              ];
            })}</tbody></table></div>
          )}
        </section>

        <section className="module-content-card">
          <h2>{fa ? "درخواست‌های برگشت" : "Reversal requests"}</h2>
          {workspace.requests.length === 0 ? <p>{fa ? "درخواستی نیست." : "No requests."}</p> : (
            <ul className="reversal-requests">{workspace.requests.map((request) => (
              <li key={request.id}>
                <strong dir="ltr">{request.journalReference}</strong> · {t(STATUS_COPY[request.status] ?? { en: request.status, fa: request.status })}
                {" · "}{request.requestedBy}: <em>{request.reason}</em>
                {request.decisionNote ? <> · {request.decisionNote}</> : null}
                {request.status === "REQUESTED" && request.viewerIsRequester ? (
                  <button className="treasury-button" type="button" disabled={busy} onClick={() => void post({ action: "withdraw", requestId: request.id,
                    expectedVersion: request.version }, { en: "Request withdrawn.", fa: "درخواست پس گرفته شد." })}>{fa ? "پس گرفتن" : "Withdraw"}</button>
                ) : null}
                {request.status === "REQUESTED" && workspace.canApprove && !request.viewerIsRequester && !request.viewerIsParticipant ? <>
                  <button className="treasury-button gold" type="button" disabled={busy} onClick={() => void post({ action: "decide", requestId: request.id,
                    expectedVersion: request.version, decision: "APPROVED" }, { en: "Approved and reversal posted.", fa: "تأیید شد و برگشت ثبت شد." })}>
                    {fa ? "تأیید و ثبت برگشت" : "Approve and post"}</button>
                  {rejecting?.id === request.id ? <>
                    <input aria-label={fa ? "دلیل رد" : "Why rejected"} value={rejecting.note} maxLength={1000} onChange={(event) => setRejecting({ id: request.id, note: event.target.value })} />
                    <button className="treasury-button" type="button" disabled={busy || rejecting.note.trim().length < 3} onClick={() => void post({ action: "decide",
                      requestId: request.id, expectedVersion: request.version, decision: "REJECTED", note: rejecting.note.trim() },
                      { en: "Request rejected.", fa: "درخواست رد شد." })}>{fa ? "رد" : "Reject"}</button>
                  </> : <button className="treasury-button" type="button" disabled={busy} onClick={() => setRejecting({ id: request.id, note: "" })}>{fa ? "رد" : "Reject"}</button>}
                </> : null}
                {request.status === "APPROVED" && !request.reversalJournalId && workspace.canApprove && !request.viewerIsRequester ? (
                  <button className="treasury-button gold" type="button" disabled={busy} onClick={() => void post({ action: "post-approved", requestId: request.id },
                    { en: "Reversal posted.", fa: "برگشت ثبت شد." })}>{fa ? "ثبت برگشت" : "Post reversal"}</button>
                ) : null}
              </li>))}</ul>
          )}
        </section>
      </>}
    </div>
  );
}
