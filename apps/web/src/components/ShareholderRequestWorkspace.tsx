"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { AccessGate, api, errorText, formatWhen } from "@/components/AdminUsersWorkspace";
import { AppIcon } from "@/components/AppIcon";
import { exactDecimal, rateSentence } from "@/components/ExchangeRatesWorkspace";
import { useLocale } from "@/components/LocaleProvider";
import { StageZeroPageHeader } from "@/components/StageZeroWorkspace";
import type { Copy } from "@/lib/access-copy";
import type { AgreementView, CapitalRequestBlocker, InstallmentView, ShareholderWorkspaceView } from "@/server/shareholder-requests";

const BLOCKER_COPY: Readonly<Record<CapitalRequestBlocker, Copy>> = {
  HAS_REQUEST: { en: "Request created", fa: "درخواست ایجاد شده" },
  INSTALLMENT_CLOSED: { en: "Installment is closed", fa: "قسط بسته است" },
  LOAN_AGREEMENT: { en: "Loan agreement (capital only in V1 Phase 1)", fa: "قرارداد قرضه (در مرحله ۱ فقط سرمایه)" },
  SHAREHOLDER_NOT_ACTIVE: { en: "Shareholder is not active", fa: "سهامدار فعال نیست" },
  AGREEMENT_NOT_FUNDABLE: { en: "Agreement is not fundable under the recorded decision", fa: "قرارداد طبق تصمیم ثبت‌شده قابل تمویل نیست" },
  REGISTRATION_NOT_VERIFIED: { en: "Capital registration not verified", fa: "ثبت سرمایه تایید نشده" },
  AGREEMENT_EVIDENCE_MISSING: { en: "No signed agreement document is recorded for this agreement", fa: "برای این قرارداد سند امضاشده ثبت نشده است" },
  COMMITMENT_USED: { en: "Commitment fully requested", fa: "تعهد به‌طور کامل درخواست شده" },
  NO_ACTIVE_ACCOUNT: { en: "Treasury has not activated a safe account in this currency", fa: "خزانه هنوز حساب صندوقی به این واحد پول فعال نکرده است" }
};

const STATUS_COPY: Readonly<Record<string, Copy>> = {
  ELIGIBLE: { en: "Waiting for Treasury", fa: "در انتظار خزانه" },
  TREASURY_VERIFIED: { en: "Cash verified by Treasury", fa: "نقد توسط خزانه تایید شد" },
  POSTED: { en: "Posted", fa: "ثبت شد" },
  REJECTED: { en: "Rejected", fa: "رد شد" },
  DRAFT: { en: "Draft", fa: "پیش‌نویس" }
};

function kabulToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kabul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function money(amount: string, currency: string): string {
  // Display only: exact digits, grouped. Currencies are always shown separately.
  // One convention in both languages: the currency code first, e.g. "USD 20,000".
  return `${currency} ${exactDecimal(amount)}`;
}

interface Draft { installment: InstallmentView; agreement: AgreementView; destination: string; amount: string; businessDate: string; rateId: string; key: string }

/** `embedded` renders inside the Shareholders page tabs, without its own page header. */
export function ShareholderRequestWorkspace({ embedded = false }: { readonly embedded?: boolean } = {}) {
  const { locale } = useLocale();
  const fa = locale === "fa";
  const t = useCallback((copy: Copy) => copy[locale], [locale]);
  const [view, setView] = useState<ShareholderWorkspaceView | null>(null);
  const [gate, setGate] = useState<"signed-out" | "denied" | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);

  const apply = useCallback((result: Awaited<ReturnType<typeof api<ShareholderWorkspaceView>>>) => {
    if (!result.ok) {
      setGate(result.status === 401 ? "signed-out" : result.status === 403 ? "denied" : null);
      if (result.status !== 401 && result.status !== 403) setMessage({ tone: "error", text: errorText(result.error, locale) });
      return;
    }
    setGate(null);
    setView(result.data);
  }, [locale]);

  const reload = useCallback(async () => apply(await api<ShareholderWorkspaceView>("/api/v1/shareholder/capital-requests")), [apply]);
  useEffect(() => {
    let current = true;
    void api<ShareholderWorkspaceView>("/api/v1/shareholder/capital-requests").then((result) => { if (current) apply(result); });
    return () => { current = false; };
  }, [apply]);

  const base = view?.legalEntity.baseCurrency ?? "USD";
  const ratesForDraft = useMemo(() => {
    if (!draft || !view || draft.installment.currency === base) return [];
    return view.currentRates.filter((rate) => rate.rateDate === draft.businessDate
      && [rate.unitCurrency, rate.quoteCurrency].includes(draft.installment.currency));
  }, [base, draft, view]);

  if (gate) return <div className={embedded ? "shareholder-embedded" : "module-workspace"}><AccessGate state={gate} fa={fa} what={{ en: "Shareholder capital needs the “Open capital requests from installments” or “View shareholder agreements” permission.", fa: "سرمایه سهامداران به صلاحیت «باز کردن درخواست سرمایه از اقساط» یا «مشاهده قراردادهای سهامداران» نیاز دارد." }} /></div>;

  const open = (agreement: AgreementView, installment: InstallmentView) => {
    const destination = view?.destinationAccounts.find((account) => account.usable && account.currency === installment.currency)?.id ?? "";
    setMessage(null);
    setDraft({ agreement, installment, destination, amount: installment.expectedAmount, businessDate: kabulToday(), rateId: "", key: crypto.randomUUID() });
  };

  const submit = async () => {
    if (!draft) return;
    setBusy(true); setMessage(null);
    const result = await api<{ id: string; replayed: boolean; snapshotId: string | null }>("/api/v1/shareholder/capital-requests", "POST", {
      installmentId: draft.installment.id, destinationAccountId: draft.destination, amount: draft.amount.trim(),
      businessDate: draft.businessDate, exchangeRateId: draft.rateId || null, idempotencyKey: draft.key
    });
    setBusy(false);
    if (!result.ok) {
      const text = result.error.code === "RATE_MISSING"
        ? (fa ? `برای ${draft.businessDate} نرخ ${base}/${draft.installment.currency} ثبت نشده است. ابتدا مالی باید نرخ همان روز را ثبت کند.` : result.error.message)
        : result.error.code === "RATE_AMBIGUOUS" ? (fa ? "برای این روز چند نرخ جاری وجود دارد؛ یکی را انتخاب کنید." : result.error.message)
        : result.error.code === "REFUSED_BY_DATABASE" && fa ? `پایگاه داده این درخواست را رد کرد: ${result.error.message}` : errorText(result.error, locale);
      setMessage({ tone: "error", text });
      return;
    }
    setMessage({ tone: "ok", text: result.data.snapshotId
      ? (fa ? "درخواست سرمایه ایجاد شد و نرخ روز همراه آن ثابت شد. خزانه اکنون می‌تواند نقد را دریافت کند." : "Capital request created, with the day's rate kept as its snapshot. Treasury can now receive the cash.")
      : (fa ? "درخواست سرمایه ایجاد شد. خزانه اکنون می‌تواند نقد را دریافت کند." : "Capital request created. Treasury can now receive the cash.") });
    setDraft(null);
    await reload();
  };

  return (
    <div className={embedded ? "shareholder-workspace shareholder-embedded" : "module-workspace shareholder-workspace"}>
      {embedded ? null : <StageZeroPageHeader icon="coins"
        eyebrow={{ en: `Shareholders · ${view?.legalEntity.name ?? ""}`, fa: `سهامداران · ${view?.legalEntity.name ?? ""}` }}
        title={{ en: "Shareholder capital", fa: "سرمایه سهامداران" }}
        description={{ en: "Capital agreements and their installments. Open a capital request for an eligible installment so Treasury can receive the cash.", fa: "قراردادهای سرمایه و اقساط آن‌ها. برای قسط واجد شرایط درخواست سرمایه باز کنید تا خزانه نقد را دریافت کند." }} />}

      <section className="finance-boundary-banner"><span><AppIcon name="shield" size={22} /></span><div>
        <p>{fa ? "هر واحد پول جداگانه" : "EACH CURRENCY ON ITS OWN"}</p>
        <strong>{fa ? "درخواست افغانی به حساب افغانی صندوق می‌رود و نرخ روز خود را نگه می‌دارد. مبالغ هرگز تبدیل یا با دالر جمع نمی‌شوند، و ثبت افغانی در دفتر کل دالری منتظر تصمیم سیاست اسعار است." : "An AFN request goes to an AFN safe account and keeps its day's rate. Amounts are never converted or added to USD, and posting AFN to the USD ledger waits for the FX policy decisions."}</strong>
      </div><em>{fa ? "واحد پول پایه" : "Base currency"} · {base}</em></section>

      {message ? <div className={`treasury-message ${message.tone === "ok" ? "success" : "error"}`} role="status"><AppIcon name={message.tone === "ok" ? "shield" : "alert"} size={16} /><span>{message.text}</span><button onClick={() => setMessage(null)} aria-label={fa ? "بستن" : "Dismiss"}>×</button></div> : null}

      {view === null ? <p className="treasury-placeholder">{fa ? "در حال بارگذاری…" : "Loading…"}</p> : <>
        <section className="shareholder-totals" aria-label={fa ? "جمع به تفکیک واحد پول" : "Totals by currency"}>
          {view.totalsByCurrency.map((total) => (
            <div key={total.currency} className="module-content-card shareholder-total">
              <p>{total.currency}</p>
              <strong>{money(total.requested, total.currency)}</strong>
              <small>{fa ? "درخواست‌شده از تعهد" : "requested of"} {money(total.committed, total.currency)}</small>
            </div>
          ))}
          {view.totalsByCurrency.length === 0 ? <p className="treasury-placeholder">{fa ? "هیچ قرارداد سرمایه‌ای وجود ندارد." : "There is no capital agreement."}</p> : null}
        </section>
        {view.fundingPolicy?.decidedBy === "SANDBOX_SYNTHETIC" ? <p className="admin-hint">{fa ? "تصمیم تمویل: نمایشی و مصنوعی (تصمیم مالی مشتری نیست)." : "Funding decision: synthetic demonstration (not a client Finance decision)."}</p> : null}
        {!view.canCreate ? <p className="admin-hint">{fa ? "شما فقط می‌توانید قراردادها و درخواست‌ها را ببینید." : "You can view agreements and requests but not create requests."}</p> : null}

        {view.agreements.map((agreement) => (
          <section key={agreement.id} className="module-content-card shareholder-agreement" aria-label={agreement.reference}>
            <div className="module-card-heading"><div><p>{agreement.shareholder} · {agreement.currency}</p><h2>{agreement.reference}</h2></div>
              <span>{fa ? "تعهد" : "Committed"} {money(agreement.committedAmount, agreement.currency)} · {fa ? "باقی" : "remaining"} {money(agreement.remainingAmount, agreement.currency)}</span></div>
            <p className="shareholder-chips">
              <em className="treasury-chip">{agreement.status}</em>
              <em className={`treasury-chip ${agreement.registrationVerified ? "" : "muted"}`}>{agreement.registrationVerified ? (fa ? "ثبت سرمایه تایید شده" : "Registration verified") : (fa ? "ثبت تایید نشده" : "Registration not verified")}</em>
              {agreement.partialAllowed ? <em className="treasury-chip muted">{fa ? "پرداخت قسمتی مجاز" : "Partial payments allowed"}</em> : null}
            </p>
            <table className="shareholder-installments">
              <thead><tr><th>#</th><th>{fa ? "مبلغ قسط" : "Installment"}</th><th>{fa ? "سررسید" : "Due"}</th><th>{fa ? "درخواست" : "Request"}</th></tr></thead>
              <tbody>{agreement.installments.map((installment) => (
                <tr key={installment.id}>
                  <td data-label="#">{installment.sequence}</td>
                  <td data-label={fa ? "مبلغ قسط" : "Installment"}>{money(installment.expectedAmount, installment.currency)}</td>
                  <td data-label={fa ? "سررسید" : "Due"}>{installment.dueOn ?? "—"}</td>
                  <td data-label={fa ? "درخواست" : "Request"}>
                    {installment.request ? (
                      <div className="shareholder-request">
                        <strong>{money(installment.request.amount, installment.request.currency)}</strong>
                        <em className="treasury-chip">{t(STATUS_COPY[installment.request.status] ?? { en: installment.request.status, fa: installment.request.status })}</em>
                        <small>{installment.request.destination} · {installment.request.businessDate} · {installment.request.createdBy} · {formatWhen(installment.request.createdAt, locale)}</small>
                        {installment.request.snapshot ? <small className="shareholder-snapshot" dir="ltr">{fa ? "نرخ ثابت‌شده: " : "Rate snapshot: "}{rateSentence(installment.request.snapshot)} · {installment.request.snapshot.rateDate}</small> : null}
                      </div>
                    ) : installment.blockers.length > 0 ? (
                      <div className="shareholder-blockers">{installment.blockers.map((blocker) => <small key={blocker}>{t(BLOCKER_COPY[blocker])}</small>)}</div>
                    ) : view.canCreate ? (
                      <button type="button" className="treasury-button gold" onClick={() => open(agreement, installment)}>{fa ? "ایجاد درخواست" : "Create request"}</button>
                    ) : <small>{fa ? "واجد شرایط" : "Eligible"}</small>}
                  </td>
                </tr>
              ))}</tbody>
            </table>

            {draft && draft.agreement.id === agreement.id ? (
              <form className="admin-form shareholder-form" aria-label={fa ? "ایجاد درخواست سرمایه" : "Create capital request"} onSubmit={(event) => { event.preventDefault(); void submit(); }}>
                <h3>{fa ? `درخواست برای قسط ${draft.installment.sequence}` : `Request for installment ${draft.installment.sequence}`}</h3>
                <label><span>{fa ? "حساب صندوق دریافت‌کننده" : "Receiving safe account"}</span>
                  <select value={draft.destination} onChange={(event) => setDraft({ ...draft, destination: event.target.value })} required>
                    <option value="">{fa ? "انتخاب کنید" : "Choose"}</option>
                    {view.destinationAccounts.filter((account) => account.currency === draft.installment.currency).map((account) => (
                      <option key={account.id} value={account.id} disabled={!account.usable}>{account.safe} · {account.currency}{account.usable ? "" : ` (${fa ? "فعال نشده" : "not active"})`}</option>
                    ))}
                  </select></label>
                <label><span>{fa ? `مبلغ (${draft.installment.currency})` : `Amount (${draft.installment.currency})`}</span>
                  <input dir="ltr" inputMode="decimal" value={draft.amount} readOnly={!agreement.partialAllowed} onChange={(event) => setDraft({ ...draft, amount: event.target.value })} required /></label>
                <label><span>{fa ? "تاریخ کاری" : "Business date"}</span>
                  <input type="date" value={draft.businessDate} onChange={(event) => setDraft({ ...draft, businessDate: event.target.value, rateId: "" })} required /></label>
                {draft.installment.currency !== base ? (
                  <fieldset className="shareholder-rates" disabled={busy}>
                    <legend>{fa ? `نرخ ${base}/${draft.installment.currency} همین روز` : `${base}/${draft.installment.currency} rate for this day`}</legend>
                    {ratesForDraft.length === 0 ? <p className="admin-hint shareholder-rate-missing">{fa ? "برای این روز نرخی ثبت نشده است. مالی باید ابتدا نرخ همین روز را ثبت کند؛ نرخ روز دیگری استفاده نمی‌شود." : "No rate is recorded for this day. Finance must record that day's rate first; no other day's rate is used."}</p>
                      : ratesForDraft.length === 1 ? <p className="admin-hint" dir="ltr">{rateSentence(ratesForDraft[0]!)} · {ratesForDraft[0]!.source}{ratesForDraft[0]!.sarafName ? ` · ${ratesForDraft[0]!.sarafName}` : ""}</p>
                      : ratesForDraft.map((rate) => (
                        <label key={rate.id}><input type="radio" name="request-rate" checked={draft.rateId === rate.id} onChange={() => setDraft({ ...draft, rateId: rate.id })} />
                          <span dir="ltr">{rateSentence(rate)} · {rate.source}{rate.sarafName ? ` · ${rate.sarafName}` : ""}</span></label>
                      ))}
                    <small>{fa ? "این نرخ به‌صورت ثابت همراه درخواست نگه داشته می‌شود؛ مبلغ تبدیل نمی‌شود." : "This rate is kept with the request as a fixed snapshot; the amount is not converted."}</small>
                  </fieldset>
                ) : null}
                <div className="rates-actions">
                  <button type="submit" className="treasury-button gold" disabled={busy || draft.destination === "" || (ratesForDraft.length > 1 && draft.rateId === "")}>{fa ? "ایجاد درخواست سرمایه" : "Create capital request"}</button>
                  <button type="button" className="treasury-button" onClick={() => setDraft(null)}>{fa ? "لغو" : "Cancel"}</button>
                </div>
              </form>
            ) : null}
          </section>
        ))}
      </>}
    </div>
  );
}
