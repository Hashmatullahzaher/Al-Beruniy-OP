"use client";

import type { FxPolicyWorkspace as Workspace, FxRoundingMode } from "@abos/contracts";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { AccessGate, api, errorText } from "@/components/AdminUsersWorkspace";
import { AppIcon } from "@/components/AppIcon";
import { useLocale } from "@/components/LocaleProvider";
import { StageZeroPageHeader } from "@/components/StageZeroWorkspace";
import type { Copy } from "@/lib/access-copy";

const ENDPOINT = "/api/v1/finance/fx-policy";

const MODE_COPY: Readonly<Record<FxRoundingMode, Copy>> = {
  HALF_UP: { en: "Round half up", fa: "گرد کردن نیم به بالا" },
  EXACT_ONLY: { en: "Exact only (refuse anything that needs rounding)", fa: "فقط دقیق (هر چیزی که گرد کردن لازم دارد رد می‌شود)" }
};

/** Dari for the refusal codes of fxErrorResponse. */
const ERROR_FA: Readonly<Record<string, string>> = {
  STALE_VERSION: "پالیسی اسعار در این میان تغییر کرد. دوباره بارگذاری کنید.",
  REASON_REQUIRED: "دلیل این پالیسی را بنویسید (۵ تا ۵۰۰ حرف).",
  FX_ACCOUNT_REQUIRED: "یک حساب عاید یا مصرف فعال به واحد پول حسابداری با کنترل «تفاوت تبادله اسعار» انتخاب کنید.",
  CURRENCY_NOT_AVAILABLE: "پالیسی اسعار برای واحد پول فعال غیر از واحد پول حسابداری ذخیره می‌شود.",
  VALIDATION_FAILED: "بعضی جزئیات ناقص یا نادرست است."
};

function message(error: { code: string; message: string }, fa: boolean): string {
  return fa ? ERROR_FA[error.code] ?? errorText(error, "fa") : error.message || errorText(error, "en");
}

type Draft = { currencyCode: string; effectiveFrom: string; roundingMode: FxRoundingMode; baseScale: number; account: string; reason: string; expectedVersion: number };

/** The FX policy per currency (0051): rounding, scale and FX difference account, effective from a date, with history. */
export function FxPolicyWorkspace() {
  const { locale } = useLocale();
  const fa = locale === "fa";
  const t = useCallback((copy: Copy) => copy[locale], [locale]);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [gate, setGate] = useState<"signed-out" | "denied" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Copy | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);

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

  const save = async () => {
    if (draft === null || busy) return;
    setBusy(true); setError(null);
    const result = await api<{ workspace: Workspace }>(ENDPOINT, "POST", { currencyCode: draft.currencyCode, effectiveFrom: draft.effectiveFrom,
      baseScale: draft.baseScale, roundingMode: draft.roundingMode, fxDifferenceLedgerAccountId: draft.account || null, reason: draft.reason.trim(),
      expectedVersion: draft.expectedVersion, correlationId: crypto.randomUUID() });
    setBusy(false);
    if (!result.ok) { setError(message(result.error, fa)); return; }
    setWorkspace(result.data.workspace); setDraft(null);
    setNotice({ en: "FX policy saved. It applies to movements dated on or after its effective date.", fa: "پالیسی اسعار ذخیره شد. برای حرکاتی که به تاریخ مؤثر یا بعد از آن ثبت می‌شوند اعمال می‌شود." });
  };

  if (gate) {
    return <div className="module-workspace"><AccessGate state={gate} fa={fa} what={{
      en: "The FX policy needs permission to manage it or to record exchange rates.",
      fa: "پالیسی اسعار به صلاحیت مدیریت آن یا ثبت نرخ اسعار نیاز دارد."
    }} /></div>;
  }

  const readyAccounts = workspace?.fxDifferenceAccounts.filter((account) => account.ready) ?? [];
  const valid = draft !== null && draft.effectiveFrom !== "" && draft.reason.trim().length >= 5;

  return (
    <div className="module-workspace fx-policy-workspace">
      <StageZeroPageHeader icon="coins"
        eyebrow={{ en: "Finance · Accounting", fa: "مالی · حسابداری" }}
        title={{ en: "FX policy", fa: "پالیسی اسعار" }}
        description={{
          en: "How money in another currency is recorded in the accounting currency: the rounding, the number of decimal places and the FX difference account. Each movement keeps its own amount, currency and the exact rate it used.",
          fa: "پول به واحد پول دیگر چگونه به واحد پول حسابداری ثبت می‌شود: گرد کردن، تعداد ارقام اعشار و حساب تفاوت تبادله اسعار. هر حرکت مبلغ، واحد پول و نرخ دقیق خود را نگه می‌دارد."
        }} />

      {notice ? <div className="treasury-message success" role="status"><AppIcon name="shield" size={16} /><span>{t(notice)}</span>
        <button onClick={() => setNotice(null)} aria-label={fa ? "بستن" : "Dismiss"}>×</button></div> : null}
      {error ? <div className="treasury-message error" role="alert"><AppIcon name="alert" size={16} /><span>{error}</span>
        <button onClick={() => setError(null)} aria-label={fa ? "بستن" : "Dismiss"}>×</button></div> : null}

      {workspace === null ? <p className="treasury-placeholder">{fa ? "در حال بارگذاری…" : "Loading…"}</p> : <>
        <section className="module-content-card" aria-label={fa ? "حساب تفاوت تبادله اسعار" : "FX difference account"}>
          <h2>{fa ? "حساب تفاوت تبادله اسعار" : "FX difference account"}</h2>
          <p className="admin-hint" role="note">{fa
            ? "دریافت، پرداخت، انتقال و مصرف عادی به افغانی به این حساب نیاز ندارند: هر کدام یک نرخ دارد و در دفاتر دقیق متوازن می‌شود. این حساب فقط برای تبادله اسعار، تسویه به نرخ دیگر و ارزیابی مجدد لازم است که هنوز ساخته نشده‌اند."
            : "Ordinary receipts, payments, transfers and expenses in AFN do not need this account: each uses one rate and balances exactly in the books. It is needed only for currency exchange, settlement at another rate and revaluation, which are not built yet."}</p>
          {workspace.fxDifference.status === "READY" && workspace.fxDifference.account ? (
            <p>{fa ? "تنظیم شده: " : "Set up: "}<span dir="ltr">{workspace.fxDifference.account.code}</span> {workspace.fxDifference.account.name}</p>
          ) : workspace.fxDifference.status === "AMBIGUOUS" ? (
            <p className="admin-hint">{fa
              ? `${workspace.fxDifference.count} حساب کنترل «تفاوت تبادله اسعار» دارند؛ پالیسی هر واحد پول می‌تواند یکی را تعیین کند.`
              : `${workspace.fxDifference.count} accounts carry the control “FX difference”; each currency's policy can name one.`}</p>
          ) : (
            <p className="admin-hint">{fa ? "هنوز حسابی با کنترل «تفاوت تبادله اسعار» نیست. می‌توانید بعداً آن را در " : "No account carries the control “FX difference” yet. You can create one later in the "}
              <Link href="/finance/accounts">{fa ? "جدول حساب‌ها" : "Chart of Accounts"}</Link>{fa ? " بسازید." : "."}</p>
          )}
          <p className="admin-hint">{fa
            ? `بدون پالیسی ذخیره‌شده: ${t(MODE_COPY[workspace.defaultPolicy.roundingMode])}، ${workspace.defaultPolicy.baseScale} رقم اعشار.`
            : `With no saved policy: ${t(MODE_COPY[workspace.defaultPolicy.roundingMode])}, ${workspace.defaultPolicy.baseScale} decimal places.`}</p>
        </section>

        {workspace.currencies.map((currency) => {
          const latest = currency.versions[0]?.version ?? 0;
          const editing = draft?.currencyCode === currency.currencyCode;
          return (
            <section key={currency.currencyCode} className="module-content-card" aria-label={`${currency.currencyCode} ${fa ? "پالیسی" : "policy"}`}>
              <h2><span dir="ltr">{currency.currencyCode}</span> · {currency.name}</h2>
              {currency.current.status === "READY" && currency.current.policy ? (
                <dl className="safe-figures">
                  <div><dt>{fa ? "در حال اجرا از" : "In force from"}</dt><dd dir="ltr">{currency.current.policy.effectiveFrom ?? (fa ? "پیش‌فرض" : "Default")}</dd></div>
                  <div><dt>{fa ? "گرد کردن" : "Rounding"}</dt><dd>{t(MODE_COPY[currency.current.policy.roundingMode])}</dd></div>
                  <div><dt>{fa ? "ارقام اعشار" : "Decimal places"}</dt><dd dir="ltr">{currency.current.policy.baseScale}</dd></div>
                  <div><dt>{fa ? "حساب تفاوت" : "FX difference"}</dt><dd>{currency.current.fxDifferenceAccount
                    ? <><span dir="ltr">{currency.current.fxDifferenceAccount.code}</span> {currency.current.fxDifferenceAccount.name}</>
                    : (fa ? "تعیین نشده (برای ثبت عادی لازم نیست)" : "Not set (not needed for ordinary postings)")}</dd></div>
                </dl>
              ) : <p className="admin-hint expense-warning" role="note">{fa ? "هنوز آماده نیست: حساب تفاوت تبادله اسعار را تنظیم کنید." : "Not ready yet: set up the FX difference account."}</p>}

              {workspace.canManage && !editing ? (
                <button className="treasury-button gold" type="button" onClick={() => setDraft({
                  currencyCode: currency.currencyCode, effectiveFrom: workspace.today, roundingMode: "HALF_UP", baseScale: 2,
                  account: readyAccounts.length === 1 ? readyAccounts[0]?.id ?? "" : "", reason: "", expectedVersion: latest })}>
                  {fa ? "ذخیرهٔ پالیسی جدید" : "Save a new policy"}</button>
              ) : null}

              {editing && draft ? (
                <form className="admin-form expense-form" aria-label={fa ? `پالیسی جدید ${currency.currencyCode}` : `New ${currency.currencyCode} policy`}
                  onSubmit={(event) => { event.preventDefault(); void save(); }}>
                  <label><span>{fa ? "مؤثر از *" : "Effective from *"}</span>
                    <input type="date" dir="ltr" value={draft.effectiveFrom} required onChange={(event) => setDraft({ ...draft, effectiveFrom: event.target.value })} /></label>
                  <label><span>{fa ? "گرد کردن *" : "Rounding *"}</span>
                    <select value={draft.roundingMode} onChange={(event) => setDraft({ ...draft, roundingMode: event.target.value as FxRoundingMode })}>
                      {(Object.keys(MODE_COPY) as FxRoundingMode[]).map((mode) => <option key={mode} value={mode}>{t(MODE_COPY[mode])}</option>)}
                    </select></label>
                  <label><span>{fa ? "ارقام اعشار *" : "Decimal places *"}</span>
                    <select value={draft.baseScale} onChange={(event) => setDraft({ ...draft, baseScale: Number(event.target.value) })}>
                      {[0, 1, 2, 3, 4, 5, 6].map((scale) => <option key={scale} value={scale}>{scale}</option>)}
                    </select></label>
                  <label className="wide"><span>{fa ? "حساب تفاوت تبادله اسعار (اختیاری)" : "FX difference account (optional)"}</span>
                    <select value={draft.account} onChange={(event) => setDraft({ ...draft, account: event.target.value })}>
                      <option value="">{fa ? "هیچ — یگانه حساب کنترل را به کار ببر" : "None — use the one account with the control"}</option>
                      {readyAccounts.map((account) => <option key={account.id} value={account.id}>{account.code} · {account.name}</option>)}
                    </select></label>
                  <label className="wide"><span>{fa ? "دلیل *" : "Reason *"}</span>
                    <textarea rows={2} maxLength={500} value={draft.reason} onChange={(event) => setDraft({ ...draft, reason: event.target.value })} /></label>
                  <p className="admin-hint wide">{fa
                    ? "پالیسی‌های قبلی نگه داشته می‌شوند؛ حرکات ثبت‌شده هرگز تغییر نمی‌کنند."
                    : "Earlier policies are kept; movements already recorded never change."}</p>
                  <div className="admin-form-actions wide">
                    <button className="treasury-button gold" type="submit" disabled={busy || !valid}>{busy ? (fa ? "در حال ذخیره…" : "Saving…") : (fa ? "ذخیره" : "Save")}</button>
                    <button className="treasury-button" type="button" disabled={busy} onClick={() => setDraft(null)}>{fa ? "لغو" : "Cancel"}</button>
                  </div>
                </form>
              ) : null}

              <h3>{fa ? "تاریخچه" : "History"}</h3>
              {currency.versions.length === 0 ? <p>{fa ? "هنوز پالیسی‌ای ذخیره نشده است؛ پیش‌فرض اعمال می‌شود." : "No policy saved yet; the default applies."}</p> : (
                <div className="table-scroll"><table className="rates-table"><thead><tr>
                  <th>{fa ? "نسخه" : "Version"}</th><th>{fa ? "مؤثر از" : "Effective from"}</th><th>{fa ? "گرد کردن" : "Rounding"}</th>
                  <th>{fa ? "ارقام" : "Places"}</th><th>{fa ? "حساب" : "Account"}</th><th>{fa ? "دلیل" : "Reason"}</th><th>{fa ? "توسط" : "By"}</th>
                </tr></thead><tbody>{currency.versions.map((version) => (
                  <tr key={version.id}>
                    <td dir="ltr">{version.version}</td><td dir="ltr">{version.effectiveFrom}</td><td>{t(MODE_COPY[version.roundingMode])}</td>
                    <td dir="ltr">{version.baseScale}</td><td dir="ltr">{version.fxDifferenceAccount?.code ?? "—"}</td><td>{version.reason}</td>
                    <td>{version.createdBy ?? "—"}</td>
                  </tr>))}</tbody></table></div>
              )}
            </section>
          );
        })}
      </>}
    </div>
  );
}
