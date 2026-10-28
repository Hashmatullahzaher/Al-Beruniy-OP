"use client";

import type { AccountingPeriodView, PeriodClosePreview, PeriodsWorkspace as Workspace } from "@abos/contracts";
import { useCallback, useEffect, useState } from "react";

import { AccessGate, api, errorText } from "@/components/AdminUsersWorkspace";
import { AppIcon } from "@/components/AppIcon";
import { useLocale } from "@/components/LocaleProvider";
import { StageZeroPageHeader } from "@/components/StageZeroWorkspace";
import type { Copy } from "@/lib/access-copy";

const ENDPOINT = "/api/v1/finance/periods";

const STATUS_COPY: Readonly<Record<string, Copy>> = {
  PENDING: { en: "Not opened yet", fa: "هنوز باز نشده" },
  OPEN: { en: "Open", fa: "باز" },
  SOFT_CLOSED: { en: "Closing", fa: "در حال بستن" },
  CLOSED: { en: "Closed", fa: "بسته" }
};

const ACTION_COPY: Readonly<Record<string, Copy>> = {
  CLOSED: { en: "Closed", fa: "بسته شد" },
  REOPENED: { en: "Reopened", fa: "دوباره باز شد" },
  REOPEN_REQUESTED: { en: "Reopen requested", fa: "درخواست بازگشایی" },
  REOPEN_REJECTED: { en: "Reopen rejected", fa: "بازگشایی رد شد" },
  REOPEN_WITHDRAWN: { en: "Reopen request withdrawn", fa: "درخواست بازگشایی پس گرفته شد" }
};

const WARNING_COPY: Readonly<Record<string, Copy>> = {
  EARLIER_MONTH_OPEN: { en: "An earlier month is still open.", fa: "یک ماه قبلی هنوز باز است." },
  CONTAINS_TODAY: { en: "This month includes today; nothing more can be recorded in it after closing.", fa: "این ماه شامل امروز است؛ پس از بستن چیزی در آن ثبت نمی‌شود." },
  NO_POSTING: { en: "Nothing has been recorded in this month.", fa: "در این ماه چیزی ثبت نشده است." }
};

/** Dari for the refusal codes of slice5ErrorResponse. */
const ERROR_FA: Readonly<Record<string, string>> = {
  SECOND_PERSON_REQUIRED: "بازگشایی ماه به شخص دوم نیاز دارد. درخواست بازگشایی بفرستید یا شخص دیگری تصمیم بگیرد.",
  UNPOSTED_JOURNAL: "این ماه ژورنالی دارد که ثبت نهایی نشده است؛ بسته نمی‌شود.",
  NOT_OPEN: "فقط ماه باز بسته می‌شود.",
  NOT_CLOSED: "فقط ماه بسته دوباره باز می‌شود.",
  STALE_VERSION: "در این میان تغییر کرد. دوباره بارگذاری کنید.",
  ALREADY_DECIDED: "درباره این درخواست قبلاً تصمیم گرفته شده است.",
  REASON_REQUIRED: "دلیل را بنویسید.",
  NOTE_REQUIRED: "بگویید چرا رد می‌شود.",
  NOT_FOUND: "برای شرکت شما در دسترس نیست."
};

function message(error: { code: string; message: string }, fa: boolean): string {
  return fa ? ERROR_FA[error.code] ?? errorText(error, "fa") : error.message || errorText(error, "en");
}

export function PeriodsWorkspace() {
  const { locale } = useLocale();
  const fa = locale === "fa";
  const t = useCallback((copy: Copy) => copy[locale], [locale]);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [gate, setGate] = useState<"signed-out" | "denied" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Copy | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<PeriodClosePreview | null>(null);
  const [reopening, setReopening] = useState<{ id: string; reason: string } | null>(null);
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
    if (!result.ok) { setError(message(result.error, fa)); return false; }
    setWorkspace(result.data.workspace); setNotice(done); setPreview(null); setReopening(null); setRejecting(null);
    return true;
  };

  const openPreview = async (period: AccountingPeriodView) => {
    setBusy(true); setError(null); setNotice(null);
    const result = await api<PeriodClosePreview>(`${ENDPOINT}/${period.id}/close-preview`);
    setBusy(false);
    if (!result.ok) { setError(message(result.error, fa)); return; }
    setPreview(result.data);
  };

  if (gate) {
    return <div className="module-workspace"><AccessGate state={gate} fa={fa} what={{
      en: "Financial periods need permission to close or reopen accounting months.",
      fa: "دوره‌های مالی به صلاحیت بستن یا بازگشایی ماه‌های حسابداری نیاز دارد."
    }} /></div>;
  }

  const name = (item: { name: string; nameFa: string | null }) => (fa && item.nameFa ? item.nameFa : item.name);

  return (
    <div className="module-workspace periods-workspace">
      <StageZeroPageHeader icon="reports-analytics"
        eyebrow={{ en: "Finance · Accounting", fa: "مالی · حسابداری" }}
        title={{ en: "Financial periods", fa: "دوره‌های مالی" }}
        description={{
          en: "Close a month when its recording is finished. Nothing can be posted into a closed month; reopening needs a reason and is kept in the history.",
          fa: "وقتی ثبت یک ماه تمام شد آن را ببندید. در ماه بسته چیزی ثبت نمی‌شود؛ بازگشایی به دلیل نیاز دارد و در تاریخچه می‌ماند."
        }} />

      {notice ? <div className="treasury-message success" role="status"><AppIcon name="shield" size={16} /><span>{t(notice)}</span>
        <button onClick={() => setNotice(null)} aria-label={fa ? "بستن" : "Dismiss"}>×</button></div> : null}
      {error ? <div className="treasury-message error" role="alert"><AppIcon name="alert" size={16} /><span>{error}</span>
        <button onClick={() => setError(null)} aria-label={fa ? "بستن" : "Dismiss"}>×</button></div> : null}

      {workspace === null ? <p className="treasury-placeholder">{fa ? "در حال بارگذاری…" : "Loading…"}</p> : <>
        {workspace.reopenNeedsSecondPerson ? <p className="admin-hint" role="note">{fa
          ? "کنترل پیشرفته: بازگشایی ماه بسته را یک شخص درخواست می‌کند و شخص دیگری تأیید می‌کند."
          : "Advanced controls: reopening a closed month is requested by one person and confirmed by another."}</p> : null}

        {preview ? (
          <section className="module-content-card period-preview" aria-label={fa ? `بستن ${name(preview.period)}` : `Close ${name(preview.period)}`}>
            <h2>{fa ? `بستن ماه ${name(preview.period)}` : `Close ${name(preview.period)}`}</h2>
            <dl className="safe-figures">
              <div><dt>{fa ? "وضعیت" : "Status"}</dt><dd>{t(STATUS_COPY[preview.period.status] ?? { en: preview.period.status, fa: preview.period.status })}</dd></div>
              <div><dt>{fa ? "ژورنال‌های ثبت‌شده" : "Posted journals"}</dt><dd dir="ltr">{preview.summary.postedJournals}</dd></div>
              <div><dt>{fa ? "مجموع بدهکار" : "Total debits"}</dt><dd dir="ltr">{preview.summary.debits}</dd></div>
              <div><dt>{fa ? "مجموع بستانکار" : "Total credits"}</dt><dd dir="ltr">{preview.summary.credits}</dd></div>
            </dl>
            <ul className="period-pending">
              <li>{fa ? "مصارف منتظر تأیید: " : "Expenses waiting for approval: "}<strong dir="ltr">{preview.pending.expensesAwaitingApproval}</strong></li>
              <li>{fa ? "درخواست‌های برگشت باز: " : "Open reversal requests: "}<strong dir="ltr">{preview.pending.reversalRequests}</strong></li>
              <li>{fa ? "تمویل موقت منتظر تصمیم: " : "Temporary funding waiting for a decision: "}<strong dir="ltr">{preview.pending.temporaryFundingDecisions}</strong></li>
            </ul>
            {preview.pending.expensesAwaitingApproval + preview.pending.reversalRequests + preview.pending.temporaryFundingDecisions > 0
              ? <p className="admin-hint">{fa ? "موارد منتظر پس از بستن در این ماه ثبت نمی‌شوند." : "Waiting items cannot post into this month after it is closed."}</p> : null}
            {preview.warnings.map((w) => <p key={w} className="admin-hint expense-warning" role="note">{t(WARNING_COPY[w] ?? { en: w, fa: w })}</p>)}
            {preview.unpostedJournals > 0 ? <p className="treasury-message error" role="alert">{fa
              ? "این ماه ژورنالی دارد که ثبت نهایی نشده است؛ بسته نمی‌شود." : "This month has a journal that is not posted, so it cannot be closed."}</p> : null}
            <div className="admin-form-actions">
              <button className="treasury-button gold" type="button" disabled={busy || preview.unpostedJournals > 0}
                onClick={() => void post({ action: "close", periodId: preview.period.id, expectedVersion: preview.period.version },
                  { en: "Month closed.", fa: "ماه بسته شد." })}>{fa ? "تأیید بستن" : "Confirm close"}</button>
              <button className="treasury-button" type="button" disabled={busy} onClick={() => setPreview(null)}>{fa ? "لغو" : "Cancel"}</button>
            </div>
          </section>
        ) : null}

        <section className="module-content-card">
          <div className="table-scroll"><table className="rates-table periods-table"><thead><tr>
            <th>{fa ? "ماه" : "Month"}</th><th>{fa ? "از" : "From"}</th><th>{fa ? "تا" : "To"}</th>
            <th>{fa ? "وضعیت" : "Status"}</th><th>{fa ? "ثبت‌ها" : "Postings"}</th><th>{fa ? "بازگشایی" : "Reopened"}</th><th>{fa ? "اقدام" : "Action"}</th>
          </tr></thead><tbody>{workspace.periods.map((period) => {
            const request = period.reopenRequest;
            return (
              <tr key={period.id}>
                <td>{name(period)}{period.closedBy ? <small className="rates-used">{fa ? "بسته شده توسط " : "Closed by "}{period.closedBy}</small> : null}</td>
                <td dir="ltr">{period.startsOn}</td><td dir="ltr">{period.endsOn}</td>
                <td><em className={`treasury-chip ${period.status === "OPEN" ? "" : "muted"}`}>{t(STATUS_COPY[period.status] ?? { en: period.status, fa: period.status })}</em></td>
                <td dir="ltr">{period.postedJournals}</td>
                <td dir="ltr">{period.reopenCount}</td>
                <td>
                  {period.status === "OPEN" && workspace.canClose ? (
                    <button className="treasury-button" type="button" disabled={busy} onClick={() => void openPreview(period)}>{fa ? "بستن ماه" : "Close month"}</button>
                  ) : null}
                  {period.status === "CLOSED" && workspace.canReopen && !request && reopening?.id !== period.id ? (
                    <button className="treasury-button" type="button" disabled={busy} onClick={() => setReopening({ id: period.id, reason: "" })}>
                      {workspace.reopenNeedsSecondPerson ? (fa ? "درخواست بازگشایی" : "Request reopen") : (fa ? "بازگشایی" : "Reopen")}</button>
                  ) : null}
                  {reopening?.id === period.id ? (
                    <form className="admin-form rates-correction" aria-label={fa ? `بازگشایی ${name(period)}` : `Reopen ${name(period)}`}
                      onSubmit={(event) => { event.preventDefault(); void post({ action: workspace.reopenNeedsSecondPerson ? "request-reopen" : "reopen", periodId: period.id,
                        expectedVersion: period.version, reason: reopening.reason.trim() },
                        workspace.reopenNeedsSecondPerson ? { en: "Reopen requested; another person confirms it.", fa: "درخواست بازگشایی فرستاده شد؛ شخص دیگری تأیید می‌کند." }
                          : { en: "Month reopened.", fa: "ماه دوباره باز شد." }); }}>
                      <label><span>{fa ? "دلیل بازگشایی *" : "Reason for reopening *"}</span>
                        <textarea rows={2} maxLength={500} value={reopening.reason} onChange={(event) => setReopening({ id: period.id, reason: event.target.value })} /></label>
                      <div className="admin-form-actions">
                        <button className="treasury-button gold" type="submit" disabled={busy || reopening.reason.trim().length < 5}>{fa ? "ذخیره" : "Save"}</button>
                        <button className="treasury-button" type="button" onClick={() => setReopening(null)}>{fa ? "لغو" : "Cancel"}</button>
                      </div>
                    </form>
                  ) : null}
                  {request ? (
                    <div className="period-request">
                      <small>{fa ? "درخواست بازگشایی توسط " : "Reopen requested by "}{request.requestedBy}: {request.reason}</small>
                      {request.viewerIsRequester ? (
                        <button className="treasury-button" type="button" disabled={busy} onClick={() => void post({ action: "decide-reopen", requestId: request.id,
                          expectedVersion: request.version, decision: "WITHDRAWN" }, { en: "Request withdrawn.", fa: "درخواست پس گرفته شد." })}>{fa ? "پس گرفتن" : "Withdraw"}</button>
                      ) : workspace.canReopen ? <>
                        <button className="treasury-button gold" type="button" disabled={busy} onClick={() => void post({ action: "decide-reopen", requestId: request.id,
                          expectedVersion: request.version, decision: "CONFIRMED" }, { en: "Month reopened.", fa: "ماه دوباره باز شد." })}>{fa ? "تأیید بازگشایی" : "Confirm reopen"}</button>
                        {rejecting?.id === request.id ? <>
                          <input aria-label={fa ? "دلیل رد" : "Why rejected"} value={rejecting.note} maxLength={500} onChange={(event) => setRejecting({ id: request.id, note: event.target.value })} />
                          <button className="treasury-button" type="button" disabled={busy || rejecting.note.trim().length < 3} onClick={() => void post({ action: "decide-reopen",
                            requestId: request.id, expectedVersion: request.version, decision: "REJECTED", note: rejecting.note.trim() },
                            { en: "Request rejected.", fa: "درخواست رد شد." })}>{fa ? "رد" : "Reject"}</button>
                        </> : <button className="treasury-button" type="button" disabled={busy} onClick={() => setRejecting({ id: request.id, note: "" })}>{fa ? "رد" : "Reject"}</button>}
                      </> : null}
                    </div>
                  ) : null}
                </td>
              </tr>
            );
          })}</tbody></table></div>
        </section>

        <section className="module-content-card">
          <h2>{fa ? "تاریخچه" : "History"}</h2>
          {workspace.history.length === 0 ? <p>{fa ? "هنوز ماهی بسته یا باز نشده است." : "No month has been closed or reopened yet."}</p> : (
            <ul className="period-history">{workspace.history.map((event, index) => (
              <li key={`${event.at}-${index}`}><strong>{fa && event.periodNameFa ? event.periodNameFa : event.periodName}</strong>{" · "}
                {t(ACTION_COPY[event.action] ?? { en: event.action, fa: event.action })}{" · "}{event.actor}{" · "}
                <time dir="ltr" dateTime={event.at}>{new Date(event.at).toLocaleString(fa ? "fa-AF" : "en-GB")}</time>
                {event.reason ? <> · <em>{event.reason}</em></> : null}</li>))}</ul>
          )}
        </section>
      </>}
    </div>
  );
}
