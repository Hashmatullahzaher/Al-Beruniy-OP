"use client";

import { formatDual } from "@abos/calendar";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { AccessGate, api, errorText } from "@/components/AdminUsersWorkspace";
import { StageZeroPageHeader } from "@/components/StageZeroWorkspace";
import { useLocale } from "@/components/LocaleProvider";
import type { ChartOfAccountsView } from "@/server/chart-of-accounts";
import type { AccountActivityRow, GeneralLedgerActivityView, GeneralLedgerLine, GeneralLedgerView } from "@/server/general-ledger";

function initialRange(): { from: string; to: string } {
  const now = new Date();
  const to = now.toISOString().slice(0, 10);
  const from = new Date(Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth(), now.getUTCDate())).toISOString().slice(0, 10);
  return { from, to };
}

const INITIAL = initialRange();

/** Kept as the error itself, so switching language re-renders the text without re-fetching. */
type ApiError = { readonly code: string; readonly message: string };

function ledgerParams(dateFrom: string, dateTo: string, selectedAccount: string | null): URLSearchParams {
  const params = new URLSearchParams({ from: dateFrom, to: dateTo });
  if (selectedAccount) params.set("accountId", selectedAccount);
  return params;
}

function requestLedger(dateFrom: string, dateTo: string, selectedAccount: string | null, cursor: string | null = null) {
  const params = ledgerParams(dateFrom, dateTo, selectedAccount);
  if (cursor) params.set("cursor", cursor);
  return api<GeneralLedgerView>(`/api/v1/finance/general-ledger?${params}`);
}

function requestActivity(dateFrom: string, dateTo: string, selectedAccount: string | null) {
  return api<GeneralLedgerActivityView>(`/api/v1/finance/general-ledger/activity?${ledgerParams(dateFrom, dateTo, selectedAccount)}`);
}

/** The first page of lines and the account activity for the same filters. */
function requestBoth(dateFrom: string, dateTo: string, selectedAccount: string | null) {
  return Promise.all([requestLedger(dateFrom, dateTo, selectedAccount), requestActivity(dateFrom, dateTo, selectedAccount)]);
}

/** Sums line counts (integers as text) without floating point. */
function countOf(values: readonly string[]): string {
  return values.reduce((sum, value) => sum + BigInt(value), BigInt(0)).toString();
}

/** Groups decimal text for display without converting any amount to a JavaScript number. */
function amount(value: string): string {
  const negative = value.startsWith("-");
  const [whole = "0", fraction] = (negative ? value.slice(1) : value).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "−" : ""}${grouped}${fraction === undefined ? "" : `.${fraction}`}`;
}

export function GeneralLedgerWorkspace() {
  const { locale } = useLocale();
  const fa = locale === "fa";
  const [from, setFrom] = useState(INITIAL.from);
  const [to, setTo] = useState(INITIAL.to);
  const [accountId, setAccountId] = useState("");
  const [accounts, setAccounts] = useState<ChartOfAccountsView["accounts"]>([]);
  const [view, setView] = useState<GeneralLedgerView | null>(null);
  const [activity, setActivity] = useState<GeneralLedgerActivityView | null>(null);
  const [gate, setGate] = useState<"signed-out" | "denied" | null>(null);
  const [problem, setProblem] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreProblem, setMoreProblem] = useState<ApiError | null>(null);

  const apply = useCallback(([ledger, summary]: Awaited<ReturnType<typeof requestBoth>>) => {
    setBusy(false);
    setMoreProblem(null);
    if (!ledger.ok || !summary.ok) {
      const failed = !ledger.ok ? ledger : summary.ok ? null : summary;
      if (!failed) return;
      setGate(failed.status === 401 ? "signed-out" : failed.status === 403 ? "denied" : null);
      setView(null);
      setActivity(null);
      if (failed.status !== 401 && failed.status !== 403) setProblem(failed.error);
      return;
    }
    setGate(null);
    setView(ledger.data);
    setActivity(summary.data);
  }, []);

  useEffect(() => {
    void requestBoth(INITIAL.from, INITIAL.to, null).then(apply);
    void api<ChartOfAccountsView>("/api/v1/finance/accounts").then((response) => {
      if (response.ok) setAccounts(response.data.accounts);
    });
  }, [apply]);

  /** Appends the next keyset page for the filters of the view on screen (not the edited form). */
  const loadMore = async () => {
    const cursor = view?.nextCursor;
    if (!view || !cursor) return;
    setLoadingMore(true);
    setMoreProblem(null);
    const response = await requestLedger(view.from, view.to, view.accountId, cursor);
    setLoadingMore(false);
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        setGate(response.status === 401 ? "signed-out" : "denied");
        setView(null);
        setActivity(null);
      } else {
        setMoreProblem(response.error);
      }
      return;
    }
    const page = response.data;
    // Ignore a stale page if the filters were re-applied while it was loading.
    setView((current) => current && current.nextCursor === cursor ? {
      ...current,
      lines: [...current.lines, ...page.lines],
      returnedLineCount: current.returnedLineCount + page.returnedLineCount,
      hasMore: page.hasMore,
      nextCursor: page.nextCursor
    } : current);
  };

  const dual = (iso: string) => {
    const dates = formatDual(iso, locale);
    return `${dates.gregorian} · ${dates.solarHijri}`;
  };

  if (gate) return <div className="module-workspace"><AccessGate state={gate} fa={fa} what={{
    en: "Posted General Ledger activity requires the Finance operational report permission.",
    fa: "نمایش دفتر کل ثبت‌شده به صلاحیت گزارش عملیاتی مالی نیاز دارد."
  }} /></div>;

  return (
    <div className="module-workspace">
      <StageZeroPageHeader icon="finance" eyebrow={{ en: "FINANCE · POSTED ACTIVITY", fa: "مالی · فعالیت ثبت‌شده" }}
        title={{ en: "General Ledger activity", fa: "فعالیت دفتر کل" }}
        description={{ en: "Read-only journal lines posted in this legal entity, with exact amounts and source references.",
          fa: "ردیف‌های ثبت‌شدهٔ ژورنال این شرکت، همراه با مبلغ دقیق و مرجع منبع، فقط برای مشاهده." }} />

      <div className="finance-boundary-banner" role="note">
        <span aria-hidden="true">ⓘ</span>
        <div><p>{fa ? "فعالیت ثبت‌شده · فقط خواندنی" : "POSTED ACTIVITY · READ ONLY"}</p>
          <strong>{fa ? "این فهرست صورت مالی رسمی نیست؛ مانده‌های افتتاحیه و دوره‌های بسته‌شده هنوز تکمیل نشده‌اند." : "This activity list is not an official financial statement. Opening positions and period close are not complete."}</strong></div>
        <em>{fa ? "فقط خواندنی" : "READ ONLY"}</em>
      </div>

      <section className="module-content-card" aria-label={fa ? "فیلتر گزارش" : "Report filters"}>
        <div className="module-card-heading"><div><p>{fa ? "فیلترها" : "FILTERS"}</p><h2>{fa ? "بازه و حساب" : "Date range and account"}</h2></div></div>
        <form className="admin-form" style={{ padding: 14, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 190px), 1fr))", alignItems: "end" }}
          onSubmit={(event) => { event.preventDefault(); setBusy(true); setProblem(null); void requestBoth(from, to, accountId || null).then(apply); }}>
          <label><span>{fa ? "از تاریخ میلادی" : "From (Gregorian)"}</span>
            <input type="date" value={from} max={to} onChange={(event) => setFrom(event.target.value)} required /></label>
          <label><span>{fa ? "تا تاریخ میلادی" : "To (Gregorian)"}</span>
            <input type="date" value={to} min={from} onChange={(event) => setTo(event.target.value)} required /></label>
          {accounts.length > 0 ? <label><span>{fa ? "حساب" : "Account"}</span>
            <select value={accountId} onChange={(event) => setAccountId(event.target.value)}>
              <option value="">{fa ? "همه حساب‌ها" : "All accounts"}</option>
              {accounts.map((account) => <option key={account.id} value={account.id}>{account.code} · {fa && account.nameFa ? account.nameFa : account.name}</option>)}
            </select></label> : null}
          <button type="submit" className="treasury-button gold" disabled={busy || !from || !to || from > to}>
            {busy ? (fa ? "در حال بارگذاری…" : "Loading…") : (fa ? "نمایش فعالیت" : "Show activity")}
          </button>
        </form>
      </section>

      {problem ? <p className="treasury-message error" role="alert">{errorText(problem, locale)}</p> : null}

      {view ? <>
        <section className="module-content-card" aria-label={fa ? "مجموع ردیف‌ها" : "Line totals"}>
          <div className="module-card-heading"><div><p>{fa ? "مجموع دورهٔ انتخاب‌شده" : "FULL FILTERED PERIOD"}</p><h2>{fa ? "جمع بدهکار و بستانکار" : "Debit and credit totals"}</h2></div>
            <span>{dual(view.from)} → {dual(view.to)}</span></div>
          {!view.totals || view.totals.length === 0 ? <p className="treasury-placeholder">{fa ? "هیچ ژورنال ثبت‌شده‌ای در این بازه نیست." : "No posted journal lines in this range."}</p>
            : <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 230px), 1fr))", gap: 12, padding: 14 }}>
              {(view.totals ?? []).map((total) => <div key={total.currency} className="admin-section">
                <h3>{total.currency} · {fa ? "ردیف" : "lines"} {total.lineCount}</h3>
                <p dir="ltr">{fa ? "بدهکار" : "Debit"}: {amount(total.debits)}</p>
                <p dir="ltr">{fa ? "بستانکار" : "Credit"}: {amount(total.credits)}</p>
              </div>)}
            </div>}
          {view.accountId ? <p className="admin-hint" style={{ padding: "0 14px 14px" }}>
            {fa ? "مجموع یک حساب ممکن است برابر نباشد؛ هر ژورنال کامل باید برابر باشد." : "A single account’s debit and credit totals may differ; each complete journal must balance."}
          </p> : null}
        </section>

        {activity ? <AccountActivity activity={activity} fa={fa} dual={dual} /> : null}

        <section aria-label={fa ? "ردیف‌های ژورنال" : "Posted journal lines"}>
          <div className="module-card-heading"><div><p>{fa ? "ژورنال‌های ثبت‌شده" : "POSTED JOURNALS"}</p>
            <h2>{fa ? "ردیف‌های دفتر کل" : "General Ledger lines"}</h2></div>
            <span>{fa ? `جدیدترین نخست · ${view.pageLimit} ردیف در هر صفحه` : `Newest first · ${view.pageLimit} lines per page`}</span></div>
          {view.lines.length === 0 ? <p className="treasury-placeholder">{fa ? "هیچ ردیف ثبت‌شده‌ای با این فیلتر پیدا نشد." : "No posted lines match these filters."}</p> : null}
          <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 10 }}>
            {view.lines.map((line) => <LedgerLine key={`${line.journalId}-${line.lineNumber}`} line={line} fa={fa} dual={dual} />)}
          </ol>
          {view.lines.length > 0 ? <div className="gl-activity-more">
            <p className="admin-hint" role="status">{pagingStatus(view, fa)}</p>
            {view.hasMore && view.nextCursor ? <button type="button" className="treasury-button gold" disabled={loadingMore} onClick={() => { void loadMore(); }}>
              {loadingMore ? (fa ? "در حال بارگذاری…" : "Loading…") : (fa ? "بارگذاری ردیف‌های بیشتر" : "Load more lines")}
            </button> : null}
            {moreProblem ? <p className="treasury-message error" role="alert">{errorText(moreProblem, locale)}</p> : null}
          </div> : null}
        </section>
        <p className="admin-hint"><Link href="/finance/handoffs">{fa ? "بازکردن صندوق مالی و ردگیری منبع" : "Open Finance inbox for source trace"}</Link></p>
      </> : null}
    </div>
  );
}

function pagingStatus(view: GeneralLedgerView, fa: boolean): string {
  const shown = String(view.lines.length);
  if (!view.hasMore) return fa ? `همهٔ ${shown} ردیف نمایش داده شد.` : `All ${shown} lines shown.`;
  const total = view.totals ? countOf(view.totals.map((row) => row.lineCount)) : "…";
  return fa ? `${shown} ردیف از ${total} نمایش داده شده؛ برای ردیف‌های قدیمی‌تر «بارگذاری ردیف‌های بیشتر» را بزنید.`
    : `Showing ${shown} of ${total} lines. Use “Load more lines” for older lines.`;
}

/**
 * Posted debit/credit activity per account in the selected range, grouped by base currency.
 * Deliberately not called a balance: opening balances are not imported and no period is closed.
 */
function AccountActivity({ activity, fa, dual }: {
  readonly activity: GeneralLedgerActivityView; readonly fa: boolean; readonly dual: (iso: string) => string;
}) {
  const groups = activity.currencyTotals.map((total) => ({
    total, rows: activity.accounts.filter((row) => row.baseCurrency === total.baseCurrency)
  }));
  return <section className="module-content-card gl-activity" aria-label={fa ? "فعالیت حساب‌ها" : "Account activity"}>
    <div className="module-card-heading"><div><p>{fa ? "فعالیت ثبت‌شده · مانده نیست" : "POSTED ACTIVITY · NOT A BALANCE"}</p>
      <h2>{fa ? "فعالیت هر حساب در بازهٔ انتخاب‌شده" : "Account activity in the selected range"}</h2></div>
      <span>{dual(activity.from)} → {dual(activity.to)}</span></div>
    <p className="gl-activity-basis" role="note">
      {fa ? "فعالیت ثبت‌شده در بازهٔ انتخاب‌شده — مانده نیست؛ مانده‌های افتتاحیه هنوز وارد نشده‌اند."
        : "Posted activity in the selected range — not a balance; opening balances are not yet imported."}
    </p>
    {groups.length === 0 ? <p className="treasury-placeholder gl-activity-empty">{fa ? "در این بازه فعالیت ثبت‌شده‌ای نیست." : "No posted activity in this range."}</p> : null}
    {groups.map(({ total, rows }) => <div key={total.baseCurrency} className="gl-activity-group" role="group"
      aria-label={fa ? `فعالیت به ارز پایه ${total.baseCurrency}` : `${total.baseCurrency} base-currency activity`}>
      <h3>{fa ? `ارز پایه ${total.baseCurrency}` : `Base currency ${total.baseCurrency}`} · {fa ? "حساب" : "accounts"} {total.accountCount} · {fa ? "ردیف" : "lines"} {total.lineCount}</h3>
      <ul className="gl-activity-rows">
        {rows.map((row) => <ActivityRow key={`${row.accountId}-${row.baseCurrency}`} row={row} fa={fa} />)}
      </ul>
      <dl className="gl-activity-amounts gl-activity-total">
        <div><dt>{fa ? `جمع بدهکار ${total.baseCurrency}` : `${total.baseCurrency} debits`}</dt><dd dir="ltr">{amount(total.debitTotal)}</dd></div>
        <div><dt>{fa ? `جمع بستانکار ${total.baseCurrency}` : `${total.baseCurrency} credits`}</dt><dd dir="ltr">{amount(total.creditTotal)}</dd></div>
        <div><dt>{fa ? "خالص (بدهکار − بستانکار)" : "Net (debit − credit)"}</dt><dd dir="ltr">{amount(total.net)}</dd></div>
      </dl>
    </div>)}
    {groups.length > 1 ? <p className="admin-hint gl-activity-foot">{fa ? "هر ارز جداگانه نمایش داده می‌شود؛ مبالغ با هم جمع یا تبدیل نمی‌شوند." : "Each currency is shown separately; amounts are never added together or converted."}</p> : null}
  </section>;
}

function ActivityRow({ row, fa }: { readonly row: AccountActivityRow; readonly fa: boolean }) {
  const originals = row.originalCurrencies.filter((original) => original.currency !== row.baseCurrency);
  return <li className="gl-activity-row">
    <div className="gl-activity-account"><strong><bdi>{row.accountCode}</bdi></strong><span>{row.accountName}</span>
      <small>{fa ? "ردیف" : "lines"} {row.lineCount}</small></div>
    <dl className="gl-activity-amounts">
      <div><dt>{fa ? "بدهکار" : "Debit"}</dt><dd dir="ltr">{row.baseCurrency} {amount(row.debitTotal)}</dd></div>
      <div><dt>{fa ? "بستانکار" : "Credit"}</dt><dd dir="ltr">{row.baseCurrency} {amount(row.creditTotal)}</dd></div>
      <div><dt>{fa ? "خالص (بدهکار − بستانکار)" : "Net (debit − credit)"}</dt><dd dir="ltr">{row.baseCurrency} {amount(row.net)}</dd></div>
    </dl>
    {originals.map((original) => <p key={original.currency} className="admin-hint gl-activity-original">
      {fa ? "مبلغ اصلی" : "Original amount"} {original.currency}: <bdi dir="ltr">{fa ? "بدهکار" : "Dr"} {amount(original.debitTotal)} · {fa ? "بستانکار" : "Cr"} {amount(original.creditTotal)}</bdi>
    </p>)}
  </li>;
}

function LedgerLine({ line, fa, dual }: { readonly line: GeneralLedgerLine; readonly fa: boolean; readonly dual: (iso: string) => string }) {
  return <li className="module-content-card">
    <div className="module-card-heading"><div><p>{line.journalReference} · #{line.lineNumber}</p><h2>{line.accountCode} · {line.accountName}</h2></div>
      <span>{dual(line.accountingEffectiveDate)}</span></div>
    <dl style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 165px), 1fr))", gap: 10, padding: 14, margin: 0 }}>
      <div><dt className="admin-hint">{fa ? "بدهکار" : "Debit"}</dt><dd dir="ltr" style={{ margin: 0 }}>{line.baseCurrency} {amount(line.baseDebit)}</dd></div>
      <div><dt className="admin-hint">{fa ? "بستانکار" : "Credit"}</dt><dd dir="ltr" style={{ margin: 0 }}>{line.baseCurrency} {amount(line.baseCredit)}</dd></div>
      <div><dt className="admin-hint">{fa ? "مبلغ اصلی" : "Original amount"}</dt><dd dir="ltr" style={{ margin: 0 }}>{line.originalCurrency && line.originalAmount ? `${line.originalCurrency} ${amount(line.originalAmount)}` : "—"}</dd></div>
      <div><dt className="admin-hint">{fa ? "منبع" : "Source"}</dt><dd style={{ margin: 0, overflowWrap: "anywhere" }}>{line.sourceType} · {line.sourceId}</dd></div>
      <div><dt className="admin-hint">{fa ? "شناسه ژورنال" : "Journal ID"}</dt><dd style={{ margin: 0, overflowWrap: "anywhere" }}>{line.journalId}</dd></div>
    </dl>
  </li>;
}
