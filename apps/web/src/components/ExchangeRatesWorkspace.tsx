"use client";

import { useCallback, useEffect, useState } from "react";

import { AccessGate, api, errorText, formatWhen } from "@/components/AdminUsersWorkspace";
import { AppIcon } from "@/components/AppIcon";
import { useLocale } from "@/components/LocaleProvider";
import { StageZeroPageHeader } from "@/components/StageZeroWorkspace";
import type { Copy } from "@/lib/access-copy";
import type { ExchangeRatesWorkspaceView, ExchangeRateView, RateSource } from "@/server/exchange-rates";

const SOURCE_COPY: Readonly<Record<RateSource, Copy>> = {
  MARKET: { en: "Market", fa: "بازار" },
  SARAF: { en: "Saraf", fa: "صراف" }
};

/** Display only: the digits are grouped, never rounded or padded; the value is exactly as entered. */
export function exactDecimal(value: string): string {
  const [whole = "0", fraction] = value.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}

export function rateSentence(rate: { unitCurrency: string; quoteCurrency: string; rate: string }): string {
  return `1 ${rate.unitCurrency} = ${exactDecimal(rate.rate)} ${rate.quoteCurrency}`;
}

function kabulToday(): string {
  // The user's local business day (Kabul), used only as the form's default.
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kabul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

export function ExchangeRatesWorkspace() {
  const { locale } = useLocale();
  const fa = locale === "fa";
  const t = useCallback((copy: Copy) => copy[locale], [locale]);
  const [view, setView] = useState<ExchangeRatesWorkspaceView | null>(null);
  const [gate, setGate] = useState<"signed-out" | "denied" | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [rateDate, setRateDate] = useState(kabulToday());
  const [source, setSource] = useState<RateSource>("MARKET");
  const [saraf, setSaraf] = useState("");
  const [direction, setDirection] = useState<"BASE_UNIT" | "BASE_QUOTE">("BASE_UNIT");
  const [rate, setRate] = useState("");
  const [note, setNote] = useState("");
  const [correcting, setCorrecting] = useState<string | null>(null);
  const [correction, setCorrection] = useState({ rate: "", reason: "" });

  const apply = useCallback((result: Awaited<ReturnType<typeof api<ExchangeRatesWorkspaceView>>>) => {
    if (!result.ok) {
      setGate(result.status === 401 ? "signed-out" : result.status === 403 ? "denied" : null);
      if (result.status !== 401 && result.status !== 403) setMessage({ tone: "error", text: errorText(result.error, locale) });
      return;
    }
    setGate(null);
    setView(result.data);
  }, [locale]);

  const reload = useCallback(async () => apply(await api<ExchangeRatesWorkspaceView>("/api/v1/finance/exchange-rates")), [apply]);
  useEffect(() => {
    let current = true;
    void api<ExchangeRatesWorkspaceView>("/api/v1/finance/exchange-rates").then((result) => { if (current) apply(result); });
    return () => { current = false; };
  }, [apply]);

  if (gate) return <div className="module-workspace"><AccessGate state={gate} fa={fa} what={{ en: "Exchange rates need the “Record daily exchange rates” or “View Finance inbox and journals” permission.", fa: "نرخ اسعار به صلاحیت «ثبت نرخ روزانه اسعار» یا «مشاهده صندوق مالی و ژورنال‌ها» نیاز دارد." }} /></div>;

  const base = view?.legalEntity.baseCurrency ?? "USD";
  const other = view?.currencies.find((code) => code !== base) ?? "AFN";
  const [unitCurrency, quoteCurrency] = direction === "BASE_UNIT" ? [base, other] : [other, base];

  const record = async () => {
    setBusy(true); setMessage(null);
    const result = await api<{ id: string }>("/api/v1/finance/exchange-rates", "POST", {
      rateDate, source, sarafPartyId: source === "SARAF" && saraf ? saraf : null, unitCurrency, quoteCurrency, rate: rate.trim(), note: note.trim() || null
    });
    setBusy(false);
    if (!result.ok) { setMessage({ tone: "error", text: failure(result.error) }); return; }
    setMessage({ tone: "ok", text: fa ? "نرخ دقیقاً همان‌طور که وارد شد ثبت شد." : "Rate recorded exactly as entered." });
    setRate(""); setNote("");
    await reload();
  };

  const correct = async (item: ExchangeRateView) => {
    setBusy(true); setMessage(null);
    const result = await api<{ id: string }>(`/api/v1/finance/exchange-rates/${item.id}/corrections`, "POST", { rate: correction.rate.trim(), reason: correction.reason.trim() });
    setBusy(false);
    if (!result.ok) { setMessage({ tone: "error", text: failure(result.error) }); return; }
    setMessage({ tone: "ok", text: fa ? "اصلاح ثبت شد. نرخ قبلی و معاملاتی که از آن استفاده کرده‌اند بدون تغییر باقی می‌مانند." : "Correction recorded. The previous rate, and any transaction that used it, stay unchanged." });
    setCorrecting(null); setCorrection({ rate: "", reason: "" });
    await reload();
  };

  function failure(error: { code: string; message: string }): string {
    if (error.code === "ALREADY_EXISTS") return fa ? "برای این روز، منبع و اسعار قبلاً نرخی ثبت شده است؛ به جای آن اصلاح ثبت کنید." : error.message;
    if (error.code === "REFUSED_BY_DATABASE" && fa) return `پایگاه داده این درخواست را رد کرد: ${error.message}`;
    return errorText(error, locale);
  }

  return (
    <div className="module-workspace rates-workspace">
      <StageZeroPageHeader icon="coins"
        eyebrow={{ en: `Finance · ${view?.legalEntity.name ?? ""}`, fa: `مالی · ${view?.legalEntity.name ?? ""}` }}
        title={{ en: "Exchange rates", fa: "نرخ اسعار" }}
        description={{ en: "The day's USD–AFN market or Saraf rate, recorded by a permitted user. Each AFN transaction keeps a snapshot of the rate it used.", fa: "نرخ روز دالر–افغانی بازار یا صراف که توسط کاربر مجاز ثبت می‌شود. هر معامله افغانی نسخه‌ای ثابت از نرخ استفاده‌شده را نگه می‌دارد." }} />

      <section className="finance-boundary-banner"><span><AppIcon name="shield" size={22} /></span><div>
        <p>{fa ? "هیچ تبدیلی انجام نمی‌شود" : "NOTHING IS CONVERTED"}</p>
        <strong>{fa ? "نرخ‌ها دقیقاً همان‌طور که وارد می‌شوند نگه داشته می‌شوند. تبدیل، گردکردن، سود و زیان اسعار و ارزیابی مجدد منتظر تصمیم مدیر مالی است؛ مبالغ افغانی هرگز با دالر جمع نمی‌شوند." : "Rates are kept exactly as entered. Conversion, rounding, exchange gain/loss and revaluation wait for Finance Manager decisions; AFN amounts are never added to USD."}</strong>
      </div><em>{fa ? "واحد پول پایه" : "Base currency"} · {base}</em></section>

      {message ? <div className={`treasury-message ${message.tone === "ok" ? "success" : "error"}`} role="status"><AppIcon name={message.tone === "ok" ? "shield" : "alert"} size={16} /><span>{message.text}</span><button onClick={() => setMessage(null)} aria-label={fa ? "بستن" : "Dismiss"}>×</button></div> : null}

      {view === null ? <p className="treasury-placeholder">{fa ? "در حال بارگذاری…" : "Loading…"}</p> : (
        <section className="rates-grid">
          <div className="module-content-card rates-entry">
            <div className="module-card-heading"><div><p>{fa ? "نرخ روز" : "TODAY'S RATE"}</p><h2>{fa ? "ثبت نرخ" : "Record a rate"}</h2></div></div>
            {view.canRecord ? (
              <form className="admin-form" aria-label={fa ? "ثبت نرخ اسعار" : "Record exchange rate"} onSubmit={(event) => { event.preventDefault(); void record(); }}>
                <label><span>{fa ? "تاریخ نرخ" : "Rate date"}</span>
                  <input type="date" value={rateDate} onChange={(event) => setRateDate(event.target.value)} required /></label>
                <fieldset className="admin-status-choice" disabled={busy}>
                  <legend>{fa ? "منبع" : "Source"}</legend>
                  {(["MARKET", "SARAF"] as const).map((option) => (
                    <label key={option}><input type="radio" name="rate-source" checked={source === option} onChange={() => setSource(option)} />{t(SOURCE_COPY[option])}</label>
                  ))}
                </fieldset>
                {source === "SARAF" ? (
                  <label><span>{fa ? "صراف (اختیاری)" : "Saraf (optional)"}</span>
                    <select value={saraf} onChange={(event) => setSaraf(event.target.value)}>
                      <option value="">{fa ? "صراف مشخص نشده" : "Not named"}</option>
                      {view.sarafParties.map((party) => <option key={party.id} value={party.id}>{party.name}</option>)}
                    </select></label>
                ) : null}
                <label><span>{fa ? "شیوه نرخ" : "Quote convention"}</span>
                  <select value={direction} onChange={(event) => setDirection(event.target.value as "BASE_UNIT" | "BASE_QUOTE")}>
                    <option value="BASE_UNIT">{`${other} ${fa ? "در برابر ۱" : "per 1"} ${base}`}</option>
                    <option value="BASE_QUOTE">{`${base} ${fa ? "در برابر ۱" : "per 1"} ${other}`}</option>
                  </select></label>
                <label><span>{fa ? `نرخ (${quoteCurrency} در برابر ۱ ${unitCurrency})` : `Rate (${quoteCurrency} per 1 ${unitCurrency})`}</span>
                  <input className="rates-input" inputMode="decimal" dir="ltr" value={rate} placeholder="71.254" autoComplete="off"
                    onChange={(event) => setRate(event.target.value)} required /></label>
                {rate.trim() ? <p className="admin-hint rates-preview" dir="ltr">{rateSentence({ unitCurrency, quoteCurrency, rate: rate.trim() })}</p> : null}
                <label><span>{fa ? "یادداشت (اختیاری)" : "Note (optional)"}</span>
                  <input value={note} maxLength={500} onChange={(event) => setNote(event.target.value)} /></label>
                <button type="submit" className="treasury-button gold" disabled={busy || rate.trim() === ""}>{fa ? "ثبت نرخ" : "Record rate"}</button>
              </form>
            ) : <p className="admin-hint">{fa ? "شما فقط می‌توانید نرخ‌ها را ببینید." : "You can view rates but not record them."}</p>}
          </div>

          <div className="module-content-card rates-list">
            <div className="module-card-heading"><div><p>{fa ? "تاریخچه" : "HISTORY"}</p><h2>{fa ? "نرخ‌های ثبت‌شده" : "Recorded rates"}</h2></div>
              <span>{view.range.from} → {view.range.to}</span></div>
            {view.rates.length === 0 ? <p className="treasury-placeholder">{fa ? "هنوز نرخی ثبت نشده است." : "No rate has been recorded yet."}</p> : (
              <table className="rates-table">
                <thead><tr><th>{fa ? "تاریخ" : "Date"}</th><th>{fa ? "منبع" : "Source"}</th><th>{fa ? "نرخ" : "Rate"}</th><th>{fa ? "وضعیت" : "Status"}</th><th>{fa ? "ثبت‌کننده" : "Entered by"}</th><th /></tr></thead>
                <tbody>{view.rates.map((item) => (
                  <tr key={item.id} className={item.current ? "" : "superseded"}>
                    <td data-label={fa ? "تاریخ" : "Date"}>{item.rateDate}</td>
                    <td data-label={fa ? "منبع" : "Source"}>{t(SOURCE_COPY[item.source])}{item.sarafName ? ` · ${item.sarafName}` : ""}</td>
                    <td data-label={fa ? "نرخ" : "Rate"} dir="ltr" className="rates-value">{rateSentence(item)}</td>
                    <td data-label={fa ? "وضعیت" : "Status"}>
                      <em className={`treasury-chip ${item.current ? "" : "muted"}`}>{item.current ? (fa ? "جاری" : "Current") : (fa ? "اصلاح‌شده" : "Superseded")}</em>
                      {item.snapshotCount > 0 ? <small className="rates-used">{fa ? `در ${item.snapshotCount} معامله استفاده شده` : `Used by ${item.snapshotCount} transaction${item.snapshotCount === 1 ? "" : "s"}`}</small> : null}
                      {item.correctionReason ? <small className="rates-used">{fa ? "دلیل اصلاح: " : "Correction: "}{item.correctionReason}</small> : null}
                    </td>
                    <td data-label={fa ? "ثبت‌کننده" : "Entered by"}>{item.enteredBy ?? "—"}<small className="rates-used">{formatWhen(item.enteredAt, locale)}</small></td>
                    <td>
                      {item.current && view.canRecord ? (correcting === item.id ? (
                        <form className="admin-form rates-correction" aria-label={fa ? "اصلاح نرخ" : "Correct exchange rate"} onSubmit={(event) => { event.preventDefault(); void correct(item); }}>
                          <label><span>{fa ? "نرخ درست" : "Correct rate"}</span><input dir="ltr" inputMode="decimal" value={correction.rate} onChange={(event) => setCorrection((value) => ({ ...value, rate: event.target.value }))} required /></label>
                          <label><span>{fa ? "دلیل" : "Reason"}</span><input value={correction.reason} maxLength={500} onChange={(event) => setCorrection((value) => ({ ...value, reason: event.target.value }))} required /></label>
                          <div className="rates-actions">
                            <button type="submit" className="treasury-button gold" disabled={busy}>{fa ? "ثبت اصلاح" : "Save correction"}</button>
                            <button type="button" className="treasury-button" onClick={() => setCorrecting(null)}>{fa ? "لغو" : "Cancel"}</button>
                          </div>
                        </form>
                      ) : <button type="button" className="treasury-button" onClick={() => { setCorrecting(item.id); setCorrection({ rate: item.rate, reason: "" }); }}>{fa ? "اصلاح" : "Correct"}</button>) : null}
                    </td>
                  </tr>
                ))}</tbody>
              </table>
            )}
            <p className="admin-hint">{fa ? "اصلاح، نرخ جاری را با نرخ جدید و دلیل جایگزین می‌کند. نرخ قبلی حذف نمی‌شود و معاملاتی که از آن استفاده کرده‌اند تغییر نمی‌کنند." : "A correction replaces the current rate with a new value and a reason. The earlier rate is never deleted, and transactions that used it keep it."}</p>
          </div>
        </section>
      )}
    </div>
  );
}
