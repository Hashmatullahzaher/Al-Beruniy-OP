"use client";

import type { FinancialYearClosePreview, FinancialYearsWorkspace as Workspace, FinancialYearView } from "@abos/contracts";
import { useCallback, useEffect, useState } from "react";

import { AccessGate, api, errorText } from "@/components/AdminUsersWorkspace";
import { AppIcon } from "@/components/AppIcon";
import { useLocale } from "@/components/LocaleProvider";
import { StageZeroPageHeader } from "@/components/StageZeroWorkspace";
import type { Copy } from "@/lib/access-copy";

const ENDPOINT = "/api/v1/finance/financial-years";

const STATUS_COPY: Readonly<Record<string, Copy>> = {
  ACTIVE: { en: "Active", fa: "فعال" },
  CLOSED: { en: "Closed", fa: "بسته" }
};

const CALENDAR_COPY: Readonly<Record<string, Copy>> = {
  GREGORIAN: { en: "Gregorian", fa: "میلادی" },
  SOLAR_HIJRI: { en: "Solar Hijri", fa: "هجری شمسی" },
  CUSTOM: { en: "Custom", fa: "سفارشی" }
};

const WARNING_COPY: Readonly<Record<string, Copy>> = {
  YEAR_NOT_ENDED: { en: "This financial year has not ended yet; nothing more can be recorded in it after closing.",
    fa: "این سال مالی هنوز تمام نشده است؛ پس از بستن چیزی در آن ثبت نمی‌شود." },
  EARLIER_YEAR_ACTIVE: { en: "An earlier financial year is still active.", fa: "یک سال مالی قبلی هنوز فعال است." }
};

/** Dari for the refusal codes of slice5ErrorResponse. */
const ERROR_FA: Readonly<Record<string, string>> = {
  UNPOSTED_JOURNAL: "این سال مالی ژورنالی دارد که ثبت نهایی نشده است؛ بسته نمی‌شود.",
  NO_MONTHS: "برای این سال مالی ماهی تنظیم نشده است؛ چیزی برای بستن نیست.",
  NOT_FOUND: "برای شرکت شما در دسترس نیست."
};

function message(error: { code: string; message: string }, fa: boolean): string {
  return fa ? ERROR_FA[error.code] ?? errorText(error, "fa") : error.message || errorText(error, "en");
}

/**
 * Financial year close (0052). Al-Beruniy closes a financial year, never a month: while a year is active, anything
 * dated in it can be recorded; closing it is the one year-end step, after a preview, and closes it for good.
 */
export function FinancialYearWorkspace() {
  const { locale } = useLocale();
  const fa = locale === "fa";
  const t = useCallback((copy: Copy) => copy[locale], [locale]);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [gate, setGate] = useState<"signed-out" | "denied" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Copy | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<FinancialYearClosePreview | null>(null);
  const [correlationId, setCorrelationId] = useState<string | null>(null);

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

  const openPreview = async (year: FinancialYearView) => {
    setBusy(true); setError(null); setNotice(null);
    const result = await api<FinancialYearClosePreview>(`${ENDPOINT}/${year.id}/close-preview`);
    setBusy(false);
    if (!result.ok) { setError(message(result.error, fa)); return; }
    // One request identity per confirmation, so a retry after a lost answer replays instead of failing.
    setPreview(result.data); setCorrelationId(crypto.randomUUID());
  };

  const close = async (year: FinancialYearView) => {
    setBusy(true); setError(null);
    const result = await api<{ workspace: Workspace }>(ENDPOINT, "POST", { fiscalYearId: year.id, correlationId });
    setBusy(false);
    if (!result.ok) { setError(message(result.error, fa)); return; }
    setWorkspace(result.data.workspace); setPreview(null); setCorrelationId(null);
    setNotice({ en: `Financial year ${year.label} closed.`, fa: `سال مالی ${year.labelFa ?? year.label} بسته شد.` });
  };

  if (gate) {
    return <div className="module-workspace"><AccessGate state={gate} fa={fa} what={{
      en: "The financial year page needs permission to close the financial year or to read Finance reports.",
      fa: "صفحه سال مالی به صلاحیت بستن سال مالی یا خواندن گزارش‌های مالی نیاز دارد."
    }} /></div>;
  }

  const label = (year: { label: string; labelFa: string | null }) => (fa && year.labelFa ? year.labelFa : year.label);

  return (
    <div className="module-workspace periods-workspace">
      <StageZeroPageHeader icon="reports-analytics"
        eyebrow={{ en: "Finance · Accounting", fa: "مالی · حسابداری" }}
        title={{ en: "Financial year", fa: "سال مالی" }}
        description={{
          en: "While a financial year is active, anything dated in it can be recorded. At year end, close the financial year: nothing more can be recorded in it, its transactions stay as they are and every report stays available.",
          fa: "تا سال مالی فعال است، هر معامله‌ای با تاریخ آن ثبت می‌شود. در پایان سال، سال مالی را ببندید: دیگر چیزی در آن ثبت نمی‌شود، معاملات آن دست نمی‌خورد و همه گزارش‌ها در دسترس می‌ماند."
        }} />

      {notice ? <div className="treasury-message success" role="status"><AppIcon name="shield" size={16} /><span>{t(notice)}</span>
        <button onClick={() => setNotice(null)} aria-label={fa ? "بستن" : "Dismiss"}>×</button></div> : null}
      {error ? <div className="treasury-message error" role="alert"><AppIcon name="alert" size={16} /><span>{error}</span>
        <button onClick={() => setError(null)} aria-label={fa ? "بستن" : "Dismiss"}>×</button></div> : null}

      {workspace === null ? <p className="treasury-placeholder">{fa ? "در حال بارگذاری…" : "Loading…"}</p> : <>
        {preview ? (
          <section className="module-content-card period-preview" aria-label={fa ? `بستن سال مالی ${label(preview.year)}` : `Close financial year ${preview.year.label}`}>
            <h2>{fa ? `بستن سال مالی ${label(preview.year)}` : `Close financial year ${preview.year.label}`}</h2>
            <dl className="safe-figures">
              <div><dt>{fa ? "دوره" : "Period"}</dt><dd dir="ltr">{preview.year.startsOn} – {preview.year.endsOn}</dd></div>
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
              ? <p className="admin-hint">{fa ? "موارد منتظر پس از بستن در این سال مالی ثبت نمی‌شوند." : "Waiting items cannot be recorded in this financial year after it is closed."}</p> : null}
            {preview.warnings.map((w) => <p key={w} className="admin-hint expense-warning" role="note">{t(WARNING_COPY[w] ?? { en: w, fa: w })}</p>)}
            <p className="admin-hint" role="note">{fa
              ? "بستن سال مالی بازگشت ندارد. معاملات آن تغییر نمی‌کند و گزارش‌ها در دسترس می‌ماند."
              : "Closing a financial year is final. Its transactions do not change and its reports stay available."}</p>
            {preview.unpostedJournals > 0 ? <p className="treasury-message error" role="alert">{fa
              ? "این سال مالی ژورنالی دارد که ثبت نهایی نشده است؛ بسته نمی‌شود." : "This financial year has a journal that is not posted, so it cannot be closed."}</p> : null}
            <div className="admin-form-actions">
              <button className="treasury-button gold" type="button" disabled={busy || preview.unpostedJournals > 0}
                onClick={() => void close(preview.year)}>{fa ? "تأیید بستن سال مالی" : "Confirm financial year close"}</button>
              <button className="treasury-button" type="button" disabled={busy} onClick={() => { setPreview(null); setCorrelationId(null); }}>{fa ? "لغو" : "Cancel"}</button>
            </div>
          </section>
        ) : null}

        <section className="module-content-card">
          {workspace.years.length === 0 ? <p>{fa
            ? "هنوز سال مالی تنظیم نشده است. از مدیر مالی بخواهید سال مالی را در تنظیمات مالی بسازد."
            : "No financial year is set up yet. Ask your Finance administrator to set up the financial year in Finance setup."}</p> : (
            <div className="table-scroll"><table className="rates-table periods-table"><thead><tr>
              <th>{fa ? "سال مالی" : "Financial year"}</th><th>{fa ? "از" : "From"}</th><th>{fa ? "تا" : "To"}</th>
              <th>{fa ? "وضعیت" : "Status"}</th><th>{fa ? "ثبت‌ها" : "Postings"}</th><th>{fa ? "اقدام" : "Action"}</th>
            </tr></thead><tbody>{workspace.years.map((year) => (
              <tr key={year.id}>
                <td>{label(year)}<small className="rates-used">{t(CALENDAR_COPY[year.calendarKind] ?? { en: year.calendarKind, fa: year.calendarKind })}</small>
                  {year.closedBy ? <small className="rates-used">{fa ? "بسته شده توسط " : "Closed by "}{year.closedBy}</small> : null}</td>
                <td dir="ltr">{year.startsOn}</td><td dir="ltr">{year.endsOn}</td>
                <td><em className={`treasury-chip ${year.status === "ACTIVE" ? "" : "muted"}`}>{t(STATUS_COPY[year.status] ?? { en: year.status, fa: year.status })}</em></td>
                <td dir="ltr">{year.postedJournals}</td>
                <td>
                  {year.status === "ACTIVE" && workspace.canClose ? (
                    <button className="treasury-button" type="button" disabled={busy} onClick={() => void openPreview(year)}>{fa ? "بستن سال مالی" : "Close financial year"}</button>
                  ) : null}
                  {year.status === "CLOSED" && year.closedAt ? (
                    <small><time dir="ltr" dateTime={year.closedAt}>{new Date(year.closedAt).toLocaleString(fa ? "fa-AF" : "en-GB")}</time></small>
                  ) : null}
                </td>
              </tr>))}</tbody></table></div>
          )}
        </section>
      </>}
    </div>
  );
}
