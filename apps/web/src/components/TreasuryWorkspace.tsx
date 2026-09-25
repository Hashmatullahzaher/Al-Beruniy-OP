"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";

import { AppIcon } from "@/components/AppIcon";
import { useLocale } from "@/components/LocaleProvider";
import { StageZeroPageHeader, WorkspaceTabs, localized } from "@/components/StageZeroWorkspace";
import type {
  ApiResponse,
  CashAccountView,
  ReceiptStageView,
  ReceiptTraceView,
  ReceiptView,
  SourceView,
  TreasuryOverview
} from "@/lib/treasury-types";

type Copy = { readonly en: string; readonly fa: string };

const STAGE_COPY: Record<ReceiptStageView, Copy> = {
  DRAFT: { en: "Received · not counted", fa: "دریافت شد · شمارش نشده" },
  COUNTED: { en: "Counted · not submitted", fa: "شمارش شد · ارسال نشده" },
  PENDING_VERIFICATION: { en: "Awaiting independent verification", fa: "در انتظار تایید مستقل" },
  VERIFIED: { en: "Verified · not handed to Finance", fa: "تایید شد · به مالی تحویل نشده" },
  HANDED_TO_FINANCE: { en: "Handed to Finance · not approved", fa: "به مالی تحویل شد · تصویب نشده" },
  APPROVED_BY_FINANCE: { en: "Approved by Finance · not posted", fa: "توسط مالی تصویب شد · ثبت نشده" },
  REJECTED_BY_FINANCE: { en: "Rejected by Finance", fa: "توسط مالی رد شد" },
  POSTED_BY_FINANCE: { en: "Posted by Finance", fa: "توسط مالی ثبت شد" },
  VOIDED: { en: "Voided", fa: "باطل شد" }
};

const ACCOUNT_STATUS_COPY: Record<CashAccountView["status"], Copy> = {
  DRAFT: { en: "Draft · not reconciled", fa: "پیش‌نویس · تطبیق نشده" },
  RECONCILED: { en: "Reconciled · awaiting approval", fa: "تطبیق شد · در انتظار تصویب" },
  APPROVED: { en: "Approved · not active", fa: "تصویب شد · فعال نیست" },
  ACTIVE: { en: "Active", fa: "فعال" },
  BLOCKED: { en: "Blocked", fa: "مسدود" }
};

const SOURCE_STATUS_COPY: Record<SourceView["status"], Copy> = {
  DRAFT: { en: "Draft", fa: "پیش‌نویس" },
  ELIGIBLE: { en: "Eligible · awaiting cash", fa: "واجد شرایط · در انتظار وجه نقد" },
  REJECTED: { en: "Rejected", fa: "رد شد" },
  TREASURY_VERIFIED: { en: "Treasury verified", fa: "تاییدشده توسط خزانه" },
  POSTED: { en: "Posted", fa: "ثبت شد" }
};

const tabs = [
  { id: "receipts", label: { en: "Receipts", fa: "دریافت‌ها" } },
  { id: "intents", label: { en: "Shareholder intents", fa: "درخواست‌های سهامداران" } },
  { id: "safes", label: { en: "Safes & accounts", fa: "صندوق‌ها و حساب‌ها" } }
] as const;

async function call<T>(url: string, init?: RequestInit): Promise<ApiResponse<T>> {
  const response = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    cache: "no-store"
  });
  try {
    return (await response.json()) as ApiResponse<T>;
  } catch {
    return { ok: false, error: { code: "INVALID_RESPONSE", message: `The server answered ${response.status} without a readable body.` } };
  }
}

function formatAmount(amount: string, currency: string, locale: "en" | "fa"): string {
  // Display only. The stored value is exact decimal text and is never converted for arithmetic.
  const [whole = "0", fraction = ""] = amount.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const text = `${grouped}.${fraction.padEnd(2, "0").slice(0, Math.max(2, fraction.length))}`;
  return locale === "fa" ? `${text} ${currency}` : `${currency} ${text}`;
}

function formatTime(value: string | undefined, locale: "en" | "fa"): string {
  if (value === undefined || value === "") return "—";
  return new Date(value).toLocaleString(locale === "fa" ? "fa-AF" : "en-GB", { dateStyle: "medium", timeStyle: "short" });
}

export function TreasuryWorkspace() {
  const { locale } = useLocale();
  const t = useCallback((copy: Copy) => localized(copy, locale), [locale]);
  const [overview, setOverview] = useState<TreasuryOverview | null>(null);
  const [state, setState] = useState<"loading" | "signed-out" | "ready" | "unavailable" | "error">("loading");
  const [message, setMessage] = useState<{ readonly kind: "error" | "success"; readonly text: string } | null>(null);
  const [activeTab, setActiveTab] = useState<string>("receipts");
  const [selectedReceipt, setSelectedReceipt] = useState<string | null>(null);
  const [trace, setTrace] = useState<ReceiptTraceView | null>(null);
  const [busy, setBusy] = useState(false);

  const applyOverview = useCallback((result: ApiResponse<TreasuryOverview>) => {
    if (result.ok) {
      setOverview(result.data);
      setState("ready");
      return;
    }
    setOverview(null);
    if (result.error.code === "AUTHENTICATION_REQUIRED") setState("signed-out");
    else if (result.error.code === "TREASURY_UNAVAILABLE") { setState("unavailable"); setMessage({ kind: "error", text: result.error.message }); }
    else { setState("error"); setMessage({ kind: "error", text: result.error.message }); }
  }, []);

  const applyTrace = useCallback((result: ApiResponse<ReceiptTraceView>) => {
    if (result.ok) setTrace(result.data);
    else { setTrace(null); setMessage({ kind: "error", text: result.error.message }); }
  }, []);

  const load = useCallback(async () => {
    applyOverview(await call<TreasuryOverview>("/api/v1/treasury/overview"));
  }, [applyOverview]);

  const loadTrace = useCallback(async (receiptId: string) => {
    applyTrace(await call<ReceiptTraceView>(`/api/v1/treasury/receipts/${receiptId}`));
  }, [applyTrace]);

  // State is set only when a response arrives, and a response for a superseded request is dropped.
  useEffect(() => {
    let current = true;
    void call<TreasuryOverview>("/api/v1/treasury/overview").then((result) => { if (current) applyOverview(result); });
    return () => { current = false; };
  }, [applyOverview]);

  useEffect(() => {
    if (selectedReceipt === null) return;
    let current = true;
    void call<ReceiptTraceView>(`/api/v1/treasury/receipts/${selectedReceipt}`).then((result) => { if (current) applyTrace(result); });
    return () => { current = false; };
  }, [selectedReceipt, applyTrace]);

  /** Changing the selection clears the previous trace at once, so it is never shown for another receipt. */
  const selectReceipt = useCallback((receiptId: string | null) => {
    setTrace(null);
    setSelectedReceipt(receiptId);
  }, []);

  /** Runs one action and reports only what the server actually committed. */
  const act = useCallback(async (url: string, body: Record<string, unknown>, success: Copy, after?: (data: Record<string, unknown>) => void) => {
    setBusy(true);
    setMessage(null);
    const result = await call<Record<string, unknown>>(url, { method: "POST", body: JSON.stringify(body) });
    setBusy(false);
    if (!result.ok) {
      if (result.error.code === "AUTHENTICATION_REQUIRED") {
        // The server no longer recognises this session. Nothing was changed; say so plainly and
        // return to sign-in rather than leaving records on screen that can no longer be acted on.
        setOverview(null);
        setState("signed-out");
        setMessage({ kind: "error", text: t({ en: `Your sandbox session is no longer valid (${result.error.message}). Nothing was changed. Sign in again.`, fa: `جلسه آزمایشی شما دیگر معتبر نیست (${result.error.message}). هیچ تغییری انجام نشد. دوباره وارد شوید.` }) });
        return false;
      }
      setMessage({ kind: "error", text: `${result.error.code.replaceAll("_", " ")}: ${result.error.message}` });
      return false;
    }
    setMessage({ kind: "success", text: t(success) });
    after?.(result.data);
    await load();
    if (selectedReceipt !== null) await loadTrace(selectedReceipt);
    return true;
  }, [load, loadTrace, selectedReceipt, t]);

  const signOut = async () => {
    await call("/api/v1/treasury/session", { method: "DELETE" });
    selectReceipt(null);
    setMessage(null);
    setState("signed-out");
    setOverview(null);
  };

  return (
    <div className="module-workspace treasury-workspace">
      <StageZeroPageHeader
        icon="coins"
        eyebrow={{ en: "Finance / Treasury · E1 synthetic sandbox", fa: "مالی / خزانه‌داری · محیط آزمایشی مصنوعی E1" }}
        title={{ en: "Treasury", fa: "خزانه‌داری" }}
        description={{ en: "Physical cash custody: office safes, independent USD and AFN accounts, cash receipts, counts, independent verification and handoff to Finance.", fa: "نگهداری فزیکی وجه نقد: صندوق‌های دفتر، حساب‌های مستقل دالر و افغانی، دریافت نقد، شمارش، تایید مستقل و تحویل به مالی." }}
      >
        <Link className="module-quiet-button treasury-back-link" href="/finance"><AppIcon name="finance" size={16} />{t({ en: "Finance overview", fa: "نمای مالی" })}</Link>
      </StageZeroPageHeader>

      <section className="finance-boundary-banner treasury-boundary" aria-label={t({ en: "Treasury sandbox boundary", fa: "مرز محیط آزمایشی خزانه" })}>
        <span aria-hidden="true"><AppIcon name="shield" size={22} /></span>
        <div>
          <p>{t({ en: "SYNTHETIC SANDBOX DATA ONLY", fa: "فقط داده‌های مصنوعی آزمایشی" })}</p>
          <strong>{t({ en: "No real cash, balances or company records. Treasury records custody and never posts to the General Ledger.", fa: "بدون وجه نقد، مانده یا سوابق واقعی شرکت. خزانه نگهداری را ثبت می‌کند و هرگز در دفتر کل ثبت نمی‌کند." })}</strong>
        </div>
        <em>{t({ en: "E1 · not production", fa: "E1 · غیر تولیدی" })}</em>
      </section>

      {message ? (
        <div className={`treasury-message ${message.kind}`} role={message.kind === "error" ? "alert" : "status"}>
          <AppIcon name={message.kind === "error" ? "alert" : "shield"} size={16} />
          <span>{message.text}</span>
          <button type="button" onClick={() => setMessage(null)} aria-label={t({ en: "Dismiss", fa: "بستن" })}>×</button>
        </div>
      ) : null}

      {state === "loading" ? <div className="treasury-card treasury-placeholder" role="status">{t({ en: "Loading Treasury…", fa: "در حال بارگذاری خزانه…" })}</div> : null}
      {state === "signed-out" ? <SignIn onSignedIn={load} setMessage={setMessage} /> : null}
      {state === "unavailable" ? <Unavailable /> : null}
      {state === "error" ? <div className="treasury-card treasury-placeholder">{t({ en: "Treasury could not be loaded. The error above is exactly what the server reported.", fa: "خزانه بارگذاری نشد. خطای بالا دقیقاً پاسخ سرور است." })}</div> : null}

      {state === "ready" && overview ? (
        <>
          <section className="treasury-identity" aria-label={t({ en: "Signed-in sandbox identity", fa: "هویت واردشده" })}>
            <span className="treasury-avatar" aria-hidden="true">{overview.actor.displayName.split(" ").map((part) => part[0]).slice(-2).join("")}</span>
            <div>
              <small>{t({ en: "Acting as (synthetic persona)", fa: "در نقش (شخص مصنوعی)" })}</small>
              <strong>{overview.actor.displayName}</strong>
              <span>{t({ en: "Session expires", fa: "پایان جلسه" })} {formatTime(overview.actor.sessionExpiresAt, locale)}</span>
            </div>
            <ul aria-label={t({ en: "Treasury permissions", fa: "مجوزهای خزانه" })}>
              {overview.actor.treasuryPermissions.length === 0
                ? <li className="none">{t({ en: "No Treasury permission", fa: "بدون مجوز خزانه" })}</li>
                : overview.actor.treasuryPermissions.map((permission) => <li key={permission}>{permission.replace("treasury.", "")}</li>)}
            </ul>
            <button type="button" className="treasury-button quiet" onClick={() => void signOut()}>{t({ en: "Sign out", fa: "خروج" })}</button>
          </section>

          {!overview.actor.treasuryPermissions.includes("treasury.read") ? (
            <div className="treasury-card treasury-placeholder" role="status">
              <AppIcon name="shield" size={22} />
              <p>{t({ en: "This person holds no treasury.read grant, so no Treasury records are shown. This refusal comes from the server, not from the interface.", fa: "این شخص مجوز treasury.read ندارد، بنابراین هیچ سابقه خزانه نمایش داده نمی‌شود. این رد از سرور است، نه از رابط." })}</p>
            </div>
          ) : (
            <section className="module-content-card">
              <div className="module-toolbar">
                <WorkspaceTabs
                  label="Treasury sections"
                  tabs={tabs.map((tab) => ({
                    ...tab,
                    count: tab.id === "receipts" ? overview.receipts.length : tab.id === "intents" ? overview.sources.filter((source) => source.status === "ELIGIBLE").length : overview.locations.length
                  }))}
                  active={activeTab}
                  onChange={setActiveTab}
                />
              </div>
              {activeTab === "safes" ? <Safes overview={overview} /> : null}
              {activeTab === "intents" ? <Intents overview={overview} busy={busy} act={act} onOpened={(id) => { setActiveTab("receipts"); selectReceipt(id); }} /> : null}
              {activeTab === "receipts" ? (
                <Receipts overview={overview} selected={selectedReceipt} onSelect={selectReceipt} trace={trace} busy={busy} act={act} />
              ) : null}
            </section>
          )}
        </>
      ) : null}
    </div>
  );
}

function SignIn({ onSignedIn, setMessage }: { readonly onSignedIn: () => Promise<void>; readonly setMessage: (value: { kind: "error" | "success"; text: string } | null) => void }) {
  const { locale } = useLocale();
  const t = (copy: Copy) => localized(copy, locale);
  const [token, setToken] = useState("");
  const [pending, setPending] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setPending(true);
    const result = await call("/api/v1/treasury/session", { method: "POST", body: JSON.stringify({ token }) });
    setPending(false);
    if (!result.ok) {
      setMessage({ kind: "error", text: `${result.error.code.replaceAll("_", " ")}: ${result.error.message}` });
      return;
    }
    setToken("");
    setMessage(null);
    await onSignedIn();
  };

  return (
    <section className="treasury-card treasury-signin" aria-labelledby="treasury-signin-title">
      <span className="treasury-signin-icon" aria-hidden="true"><AppIcon name="shield" size={26} /></span>
      <h2 id="treasury-signin-title">{t({ en: "Sign in to the Treasury sandbox", fa: "ورود به محیط آزمایشی خزانه" })}</h2>
      <p>{t({ en: "Paste a sandbox session token. There is no default user: each token belongs to one synthetic persona, and the server rebuilds that person's permissions from the database on every request.", fa: "توکن جلسه آزمایشی را وارد کنید. کاربر پیش‌فرض وجود ندارد: هر توکن متعلق به یک شخص مصنوعی است و سرور مجوزهای او را در هر درخواست از پایگاه داده بازسازی می‌کند." })}</p>
      <form onSubmit={(event) => void submit(event)}>
        <label htmlFor="treasury-token">{t({ en: "Session token", fa: "توکن جلسه" })}</label>
        <input id="treasury-token" type="password" value={token} onChange={(event) => setToken(event.target.value)} autoComplete="off" spellCheck={false} dir="ltr" required />
        <button className="treasury-button" type="submit" disabled={pending || token.trim().length === 0}>{pending ? t({ en: "Checking…", fa: "در حال بررسی…" }) : t({ en: "Sign in", fa: "ورود" })}</button>
      </form>
      <details>
        <summary>{t({ en: "Where do tokens come from?", fa: "توکن‌ها از کجا می‌آیند؟" })}</summary>
        <code dir="ltr">pnpm --filter @abos/e1-integration sandbox:sessions</code>
      </details>
    </section>
  );
}

function Unavailable() {
  const { locale } = useLocale();
  return (
    <section className="treasury-card treasury-placeholder" role="status">
      <AppIcon name="alert" size={22} />
      <p>{localized({ en: "The Treasury sandbox is not configured on this server, so nothing is shown. This is deliberate: without a sandbox database the interface does not fall back to demo figures.", fa: "محیط آزمایشی خزانه روی این سرور پیکربندی نشده است، بنابراین چیزی نمایش داده نمی‌شود. این عمدی است: بدون پایگاه داده آزمایشی، رابط به ارقام نمایشی بازنمی‌گردد." }, locale)}</p>
    </section>
  );
}

function Safes({ overview }: { readonly overview: TreasuryOverview }) {
  const { locale } = useLocale();
  const t = (copy: Copy) => localized(copy, locale);
  if (overview.locations.length === 0) {
    return <p className="treasury-empty">{t({ en: "No cash locations exist in this sandbox.", fa: "هیچ محل نگهداری نقد در این محیط وجود ندارد." })}</p>;
  }
  return (
    <div className="treasury-safes">
      {overview.locations.map((location) => (
        <article key={location.id} className="treasury-safe">
          <header>
            <span aria-hidden="true"><AppIcon name="building" size={20} /></span>
            <div>
              <small>{t({ en: "Office safe", fa: "صندوق دفتر" })}</small>
              <h3>{location.name}</h3>
            </div>
            <span className={`treasury-chip ${location.status === "ACTIVE" ? "ok" : "muted"}`}>{location.status}</span>
          </header>
          <div className="treasury-accounts">
            {location.accounts.map((account) => (
              <div key={account.id} className={`treasury-account ${account.status === "ACTIVE" ? "active" : ""}`}>
                <strong>{account.currency}</strong>
                <span className={`treasury-chip ${account.status === "ACTIVE" ? "ok" : account.status === "BLOCKED" ? "danger" : "muted"}`}>{t(ACCOUNT_STATUS_COPY[account.status])}</span>
                <dl>
                  <dt>{t({ en: "Opening position", fa: "موقعیت افتتاحیه" })}</dt>
                  <dd>{account.openingStatus === "NOT_RECONCILED" ? t({ en: "Not counted or reconciled", fa: "شمارش یا تطبیق نشده" }) : `${account.openingStatus} · ${t({ en: "counted", fa: "شمارش‌شده" })} ${formatAmount(account.openingCountedAmount ?? "0", account.currency, locale)}`}</dd>
                  <dt>{t({ en: "Activated by", fa: "فعال‌شده توسط" })}</dt>
                  <dd>{account.activatedBy ?? "—"}</dd>
                </dl>
              </div>
            ))}
          </div>
          <footer>
            <small>{t({ en: "Assigned cashiers", fa: "صندوق‌داران تعیین‌شده" })}</small>
            <span>{location.cashiers.length === 0 ? t({ en: "None", fa: "هیچ" }) : location.cashiers.map((cashier) => cashier.displayName).join(", ")}</span>
          </footer>
          <p className="treasury-note">{t({ en: "No balance is shown. Treasury keeps counts and receipts, not a balance; a figure here would be invented.", fa: "مانده نمایش داده نمی‌شود. خزانه شمارش‌ها و دریافت‌ها را نگه می‌دارد، نه مانده را؛ هر رقمی در اینجا ساختگی می‌بود." })}</p>
        </article>
      ))}
    </div>
  );
}

function Intents({ overview, busy, act, onOpened }: {
  readonly overview: TreasuryOverview;
  readonly busy: boolean;
  readonly act: (url: string, body: Record<string, unknown>, success: Copy, after?: (data: Record<string, unknown>) => void) => Promise<boolean>;
  readonly onOpened: (receiptId: string) => void;
}) {
  const { locale } = useLocale();
  const t = (copy: Copy) => localized(copy, locale);
  const canRecord = overview.actor.treasuryPermissions.includes("treasury.cash-receipt.record");
  const [references, setReferences] = useState<Record<string, string>>({});

  if (overview.sources.length === 0) {
    return <p className="treasury-empty">{t({ en: "No shareholder capital receipt intents exist yet.", fa: "هنوز هیچ درخواست دریافت سرمایه سهامدار وجود ندارد." })}</p>;
  }
  return (
    <div className="treasury-table-wrap">
      <table className="treasury-table">
        <thead>
          <tr>
            <th>{t({ en: "Shareholder", fa: "سهامدار" })}</th>
            <th>{t({ en: "Agreement · installment", fa: "قرارداد · قسط" })}</th>
            <th>{t({ en: "Amount", fa: "مبلغ" })}</th>
            <th>{t({ en: "Destination", fa: "مقصد" })}</th>
            <th>{t({ en: "Status", fa: "وضعیت" })}</th>
            <th>{t({ en: "Treasury", fa: "خزانه" })}</th>
          </tr>
        </thead>
        <tbody>
          {overview.sources.map((source) => {
            const openable = source.status === "ELIGIBLE" && !source.hasLiveReceipt;
            return (
              <tr key={source.id}>
                <td data-label={t({ en: "Shareholder", fa: "سهامدار" })}>{source.shareholder}</td>
                <td data-label={t({ en: "Agreement", fa: "قرارداد" })}>{source.agreementReference} · #{source.installmentSequence}</td>
                <td data-label={t({ en: "Amount", fa: "مبلغ" })} className="amount">{formatAmount(source.amount, source.currency, locale)}</td>
                <td data-label={t({ en: "Destination", fa: "مقصد" })}>{source.destinationLabel}</td>
                <td data-label={t({ en: "Status", fa: "وضعیت" })}><span className={`treasury-chip ${source.status === "ELIGIBLE" ? "gold" : "muted"}`}>{t(SOURCE_STATUS_COPY[source.status])}</span></td>
                <td data-label={t({ en: "Treasury", fa: "خزانه" })}>
                  {openable ? (
                    canRecord ? (
                      <form className="treasury-inline-form" onSubmit={(event) => {
                        event.preventDefault();
                        void act("/api/v1/treasury/receipts", {
                          capitalReceiptIntentId: source.id,
                          receiptReference: references[source.id] ?? "",
                          businessEventAt: new Date().toISOString()
                        }, { en: "Cash receipt recorded. It still has to be counted, submitted and independently verified.", fa: "دریافت نقد ثبت شد. هنوز باید شمارش، ارسال و به‌طور مستقل تایید شود." },
                        (data) => { if (typeof data.receiptId === "string") onOpened(data.receiptId); });
                      }}>
                        <label className="sr-only" htmlFor={`ref-${source.id}`}>{t({ en: "Receipt reference", fa: "شماره رسید" })}</label>
                        <input id={`ref-${source.id}`} placeholder={t({ en: "Receipt ref.", fa: "شماره رسید" })} value={references[source.id] ?? ""} onChange={(event) => setReferences((current) => ({ ...current, [source.id]: event.target.value }))} required dir="ltr" />
                        <button className="treasury-button" type="submit" disabled={busy || (references[source.id] ?? "").trim().length === 0}>{t({ en: "Record cash received", fa: "ثبت دریافت نقد" })}</button>
                      </form>
                    ) : <span className="treasury-muted">{t({ en: "Requires an assigned cashier", fa: "نیازمند صندوق‌دار تعیین‌شده" })}</span>
                  ) : <span className="treasury-muted">{source.hasLiveReceipt ? t({ en: "Receipt open", fa: "رسید باز است" }) : "—"}</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Receipts({ overview, selected, onSelect, trace, busy, act }: {
  readonly overview: TreasuryOverview;
  readonly selected: string | null;
  readonly onSelect: (id: string | null) => void;
  readonly trace: ReceiptTraceView | null;
  readonly busy: boolean;
  readonly act: (url: string, body: Record<string, unknown>, success: Copy) => Promise<boolean>;
}) {
  const { locale } = useLocale();
  const t = (copy: Copy) => localized(copy, locale);
  if (overview.receipts.length === 0) {
    return <p className="treasury-empty">{t({ en: "No cash receipts yet. Open an eligible shareholder intent to record one.", fa: "هنوز دریافت نقدی نیست. برای ثبت، یک درخواست واجد شرایط سهامدار را باز کنید." })}</p>;
  }
  const waiting: readonly { readonly stages: readonly ReceiptStageView[]; readonly label: Copy; readonly tone: string }[] = [
    { stages: ["DRAFT", "COUNTED"], label: { en: "With the cashier", fa: "نزد صندوق‌دار" }, tone: "muted" },
    { stages: ["PENDING_VERIFICATION"], label: { en: "Awaiting independent verification", fa: "در انتظار تایید مستقل" }, tone: "cyan" },
    { stages: ["VERIFIED"], label: { en: "Verified · not yet with Finance", fa: "تاییدشده · هنوز نزد مالی نیست" }, tone: "ok" },
    { stages: ["HANDED_TO_FINANCE"], label: { en: "With Finance · not approved", fa: "نزد مالی · تصویب نشده" }, tone: "gold" },
    { stages: ["APPROVED_BY_FINANCE"], label: { en: "Approved · not posted", fa: "تصویب‌شده · ثبت نشده" }, tone: "gold" },
    { stages: ["POSTED_BY_FINANCE"], label: { en: "Posted by Finance", fa: "ثبت‌شده توسط مالی" }, tone: "ok" }
  ];
  return (
    <div className="treasury-receipts-wrap">
    <ul className="treasury-stage-summary" aria-label={t({ en: "Receipts by stage", fa: "رسیدها بر اساس مرحله" })}>
      {waiting.map((group) => {
        const count = overview.receipts.filter((receipt) => group.stages.includes(receipt.stage)).length;
        return (
          <li key={group.label.en} className={`tone-${group.tone}${count === 0 ? " empty" : ""}`}>
            <strong>{count}</strong><span>{t(group.label)}</span>
          </li>
        );
      })}
    </ul>
    <div className="treasury-receipts">
      <ul className="treasury-receipt-list" aria-label={t({ en: "Cash receipts", fa: "دریافت‌های نقد" })}>
        {overview.receipts.map((receipt) => (
          <li key={receipt.id}>
            <button type="button" className={selected === receipt.id ? "selected" : undefined} aria-pressed={selected === receipt.id} onClick={() => onSelect(receipt.id)}>
              <span className="ref" dir="ltr">{receipt.reference}</span>
              <strong>{formatAmount(receipt.amount, receipt.currency, locale)}</strong>
              <small>{receipt.shareholder} · {receipt.agreementReference} #{receipt.installmentSequence}</small>
              <span className={`treasury-chip stage-${receipt.stage.toLowerCase()}`}>{t(STAGE_COPY[receipt.stage])}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="treasury-detail" aria-live="polite">
        {selected === null ? <p className="treasury-empty">{t({ en: "Select a receipt to see its evidence, its trace back to the shareholder installment, and the actions available to you.", fa: "برای دیدن شواهد، ردیابی تا قسط سهامدار و اقدامات در دسترس، یک رسید را انتخاب کنید." })}</p> : null}
        {selected !== null && trace === null ? <p className="treasury-empty">{t({ en: "Loading trace…", fa: "در حال بارگذاری ردیابی…" })}</p> : null}
        {trace !== null && trace.receipt.id === selected ? <ReceiptDetail overview={overview} trace={trace} busy={busy} act={act} /> : null}
      </div>
    </div>
    </div>
  );
}

function ReceiptDetail({ overview, trace, busy, act }: {
  readonly overview: TreasuryOverview;
  readonly trace: ReceiptTraceView;
  readonly busy: boolean;
  readonly act: (url: string, body: Record<string, unknown>, success: Copy) => Promise<boolean>;
}) {
  const { locale } = useLocale();
  const t = (copy: Copy) => localized(copy, locale);
  const { receipt } = trace;
  const me = overview.actor.userAccountId;
  const perms = overview.actor.treasuryPermissions;
  const base = `/api/v1/treasury/receipts/${receipt.id}`;
  const countEvidenceOptions = overview.evidence.physicalCount.filter(
    (option) => option.capitalReceiptIntentId === receipt.sourceId
  );
  const receiptEvidenceOptions = overview.evidence.cashReceipt.filter(
    (option) => option.capitalReceiptIntentId === receipt.sourceId
  );
  const [countedAmount, setCountedAmount] = useState("");
  const [countEvidence, setCountEvidence] = useState(countEvidenceOptions[0]?.id ?? "");
  const [receiptEvidence, setReceiptEvidence] = useState(receiptEvidenceOptions[0]?.id ?? "");
  const [voidReason, setVoidReason] = useState("");

  const iReceived = receipt.receivedByUserAccountId === me;
  const iCounted = receipt.countedByUserAccountId === me;
  const blockedVerify = iReceived
    ? t({ en: "Independent verification is still required. You received this cash, so you cannot verify it; a separately authorized Treasury verifier must.", fa: "تایید مستقل هنوز لازم است. شما این وجه را دریافت کرده‌اید، بنابراین نمی‌توانید آن را تایید کنید؛ یک تاییدکننده مجاز و جداگانه خزانه باید تایید کند." })
    : iCounted ? t({ en: "You counted this cash, so you cannot verify it.", fa: "شما این وجه را شمارش کرده‌اید، بنابراین نمی‌توانید آن را تایید کنید." })
    : !perms.includes("treasury.cash-receipt.verify") ? t({ en: "Requires treasury.cash-receipt.verify.", fa: "نیازمند مجوز treasury.cash-receipt.verify." }) : null;

  const chain: readonly { readonly label: Copy; readonly value: string; readonly done: boolean }[] = [
    { label: { en: "Shareholder", fa: "سهامدار" }, value: trace.source.shareholder, done: true },
    { label: { en: "Agreement", fa: "قرارداد" }, value: trace.source.agreementReference, done: true },
    { label: { en: "Installment", fa: "قسط" }, value: `#${trace.source.installmentSequence} · ${formatAmount(trace.source.amount, trace.source.currency, locale)}`, done: true },
    { label: { en: "Capital receipt intent", fa: "درخواست دریافت سرمایه" }, value: sourceStatusText(trace.source.status, t), done: true },
    { label: { en: "Cash received", fa: "دریافت نقد" }, value: `${receipt.receivedBy} · ${receipt.destinationLabel}`, done: true },
    { label: { en: "Physical count", fa: "شمارش فزیکی" }, value: trace.count ? `${formatAmount(trace.count.countedAmount, receipt.currency, locale)} · ${trace.count.countedBy}` : t({ en: "Not counted", fa: "شمارش نشده" }), done: trace.count !== undefined },
    { label: { en: "Independent verification", fa: "تایید مستقل" }, value: receipt.verifiedBy ?? t({ en: "Not verified", fa: "تایید نشده" }), done: receipt.verifiedBy !== undefined },
    { label: { en: "Handed to Finance", fa: "تحویل به مالی" }, value: trace.handoff ? `${trace.handoff.handedOffBy} · ${formatTime(trace.handoff.handedOffAt, locale)}` : t({ en: "Not handed off", fa: "تحویل نشده" }), done: trace.handoff !== undefined },
    {
      label: { en: "Finance approval", fa: "تصویب مالی" },
      value: trace.finance.decision === "APPROVED"
        ? `${t({ en: "Approved by", fa: "تصویب توسط" })} ${trace.finance.decidedBy ?? ""} · ${formatTime(trace.finance.decidedAt, locale)}`
        : trace.finance.decision === "REJECTED"
          ? `${t({ en: "Rejected by", fa: "رد توسط" })} ${trace.finance.decidedBy ?? ""} · ${formatTime(trace.finance.decidedAt, locale)}`
          : t({ en: "Not approved", fa: "تصویب نشده" }),
      done: trace.finance.decision === "APPROVED" || trace.postedJournalId !== undefined
    },
    { label: { en: "Posted by Finance", fa: "ثبت توسط مالی" }, value: trace.postedJournalId ? `${t({ en: "Journal", fa: "ژورنال" })} ${trace.postedJournalId.slice(0, 8)}` : t({ en: "Not posted", fa: "ثبت نشده" }), done: trace.postedJournalId !== undefined }
  ];

  return (
    <article className="treasury-receipt-detail">
      <header>
        <div>
          <small dir="ltr">{receipt.reference}</small>
          <h3>{formatAmount(receipt.amount, receipt.currency, locale)}</h3>
        </div>
        <span className={`treasury-chip stage-${receipt.stage.toLowerCase()}`}>{t(STAGE_COPY[receipt.stage])}</span>
      </header>

      <ol className="treasury-chain" aria-label={t({ en: "Trace to the shareholder installment", fa: "ردیابی تا قسط سهامدار" })}>
        {chain.map((step) => (
          <li key={step.label.en} className={step.done ? "done" : "pending"}>
            <span aria-hidden="true" />
            <div><small>{t(step.label)}</small><strong>{step.value}</strong></div>
          </li>
        ))}
      </ol>

      <section className="treasury-evidence">
        <h4>{t({ en: "Evidence", fa: "شواهد" })}</h4>
        <dl>
          <dt>{t({ en: "Receipt evidence", fa: "سند دریافت" })}</dt>
          <dd><EvidenceValue label={trace.receiptEvidenceLabel} t={t} /></dd>
          <dt>{t({ en: "Count evidence", fa: "سند شمارش" })}</dt>
          <dd><EvidenceValue label={trace.count?.evidenceLabel} t={t} /></dd>
          <dt>{t({ en: "Count confirmed by", fa: "شمارش تاییدشده توسط" })}</dt>
          <dd>{trace.count?.confirmedBy ? `${trace.count.confirmedBy} · ${formatTime(trace.count.confirmedAt, locale)}` : "—"}</dd>
        </dl>
      </section>

      <section className="treasury-actions" aria-label={t({ en: "Available actions", fa: "اقدامات در دسترس" })}>
        <h4>{t({ en: "Next step", fa: "گام بعدی" })}</h4>

        {receipt.stage === "DRAFT" ? (
          perms.includes("treasury.cash-count.record") && iReceived ? (
            <form className="treasury-form" onSubmit={(event) => {
              event.preventDefault();
              void act(`${base}/count`, { countedAmount, countEvidenceReferenceId: countEvidence, receiptEvidenceReferenceId: receiptEvidence },
                { en: "Physical count recorded. Submit it for independent verification next.", fa: "شمارش فزیکی ثبت شد. گام بعدی ارسال برای تایید مستقل است." });
            }}>
              <label htmlFor="counted-amount">{t({ en: "Counted amount", fa: "مبلغ شمارش‌شده" })} ({receipt.currency})</label>
              <input id="counted-amount" inputMode="decimal" dir="ltr" value={countedAmount} onChange={(event) => setCountedAmount(event.target.value)} placeholder={receipt.amount} required />
              <label htmlFor="count-evidence">{t({ en: "Count evidence", fa: "سند شمارش" })}</label>
              <select id="count-evidence" value={countEvidence} onChange={(event) => setCountEvidence(event.target.value)} required>
                {countEvidenceOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
              </select>
              <label htmlFor="receipt-evidence">{t({ en: "Receipt evidence", fa: "سند دریافت" })}</label>
              <select id="receipt-evidence" value={receiptEvidence} onChange={(event) => setReceiptEvidence(event.target.value)} required>
                {receiptEvidenceOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
              </select>
              <p className="treasury-policy form-note">{t({ en: "Policy pending Finance Manager review: whether a count covers only the cash received or the whole safe. The sandbox requires the count to be at least the received amount.", fa: "سیاست در انتظار بررسی مدیر مالی: آیا شمارش فقط وجه دریافتی را پوشش می‌دهد یا کل صندوق را. محیط آزمایشی لازم می‌داند شمارش دست‌کم برابر مبلغ دریافتی باشد." })}</p>
              <button className="treasury-button" type="submit" disabled={busy || countedAmount.trim() === ""}>{t({ en: "Record physical count", fa: "ثبت شمارش فزیکی" })}</button>
            </form>
          ) : <p className="treasury-muted">{t({ en: "The assigned cashier who received this cash records the count.", fa: "صندوق‌دار تعیین‌شده‌ای که وجه را دریافت کرده، شمارش را ثبت می‌کند." })}</p>
        ) : null}

        {receipt.stage === "COUNTED" ? (
          iReceived ? (
            <button className="treasury-button" type="button" disabled={busy} onClick={() => void act(`${base}/submit`, {}, { en: "Submitted. An independent verifier must now confirm the count.", fa: "ارسال شد. اکنون یک تاییدکننده مستقل باید شمارش را تایید کند." })}>{t({ en: "Submit for independent verification", fa: "ارسال برای تایید مستقل" })}</button>
          ) : <p className="treasury-muted">{t({ en: "Waiting for the receiving cashier to submit it.", fa: "در انتظار ارسال توسط صندوق‌دار دریافت‌کننده." })}</p>
        ) : null}

        {receipt.stage === "PENDING_VERIFICATION" ? (
          blockedVerify === null ? (
            <button className="treasury-button" type="button" disabled={busy} onClick={() => void act(`${base}/verify`, {}, { en: "Count confirmed and receipt verified. It is not with Finance until it is handed off.", fa: "شمارش تایید و رسید تایید شد. تا زمان تحویل، نزد مالی نیست." })}>{t({ en: "Confirm count and verify receipt", fa: "تایید شمارش و رسید" })}</button>
          ) : <p className="treasury-muted">{blockedVerify}</p>
        ) : null}

        {receipt.stage === "VERIFIED" ? (
          perms.includes("treasury.handoff.create") ? (
            <>
            <p className="treasury-policy">{t({ en: "Policy pending Finance Manager review: whether the verifier may also hand a receipt to Finance.", fa: "سیاست در انتظار بررسی مدیر مالی: آیا تاییدکننده می‌تواند رسید را به مالی نیز تحویل دهد." })}</p>
            <button className="treasury-button gold" type="button" disabled={busy} onClick={() => void act(`${base}/handoff`, {}, { en: "Handed to Finance. Nothing has been posted: Finance must still approve and post it independently.", fa: "به مالی تحویل شد. هیچ چیزی ثبت نشده است: مالی باید به‌طور مستقل تصویب و ثبت کند." })}>{t({ en: "Hand verified receipt to Finance", fa: "تحویل رسید تاییدشده به مالی" })}</button>
            </>
          ) : <p className="treasury-muted">{t({ en: "Requires treasury.handoff.create.", fa: "نیازمند مجوز treasury.handoff.create." })}</p>
        ) : null}

        {receipt.stage === "HANDED_TO_FINANCE" ? (
          <p className="treasury-waiting">{t({ en: "With Finance, not yet approved. Approval and posting belong to Finance and are not performed from Treasury; this page shows each only after Finance records it.", fa: "نزد مالی، هنوز تصویب نشده. تصویب و ثبت متعلق به مالی است و از خزانه انجام نمی‌شود؛ این صفحه هر کدام را فقط پس از ثبت توسط مالی نشان می‌دهد." })}</p>
        ) : null}
        {receipt.stage === "APPROVED_BY_FINANCE" ? (
          <p className="treasury-waiting">{t({ en: "Approved by Finance, not yet posted. No journal exists for this receipt until Finance posts it.", fa: "توسط مالی تصویب شد، هنوز ثبت نشده. تا زمانی که مالی ثبت نکند، هیچ ژورنالی برای این رسید وجود ندارد." })}</p>
        ) : null}
        {receipt.stage === "REJECTED_BY_FINANCE" ? (
          <p className="treasury-muted">{t({ en: "Finance rejected this receipt. Treasury's verified record stands; what happens next is a Finance decision.", fa: "مالی این رسید را رد کرد. سابقه تاییدشده خزانه باقی می‌ماند؛ گام بعدی تصمیم مالی است." })}</p>
        ) : null}
        {receipt.stage === "POSTED_BY_FINANCE" ? <p className="treasury-waiting">{t({ en: "Posted by Finance. Treasury's record is complete.", fa: "توسط مالی ثبت شد. سابقه خزانه کامل است." })}</p> : null}
        {receipt.stage === "VOIDED" ? <p className="treasury-muted">{t({ en: "Voided:", fa: "باطل شد:" })} {receipt.voidReason}</p> : null}

        {(receipt.stage === "DRAFT" || receipt.stage === "COUNTED" || receipt.stage === "PENDING_VERIFICATION") && (iReceived || perms.includes("treasury.cash-receipt.verify")) ? (
          <form className="treasury-void" onSubmit={(event) => { event.preventDefault(); void act(`${base}/void`, { reason: voidReason }, { en: "Receipt voided. The shareholder intent can take a new receipt.", fa: "رسید باطل شد. درخواست سهامدار می‌تواند رسید جدید بگیرد." }); }}>
            <p className="treasury-policy">{t({ en: "Policy pending Finance Manager review: who may void a receipt. The sandbox allows the receiving cashier or a Treasury verifier.", fa: "سیاست در انتظار بررسی مدیر مالی: چه کسی می‌تواند رسید را باطل کند. محیط آزمایشی به صندوق‌دار دریافت‌کننده یا تاییدکننده خزانه اجازه می‌دهد." })}</p>
            <label htmlFor="void-reason">{t({ en: "Void with reason", fa: "ابطال با دلیل" })}</label>
            <input id="void-reason" value={voidReason} onChange={(event) => setVoidReason(event.target.value)} minLength={5} required />
            <button className="treasury-button danger" type="submit" disabled={busy || voidReason.trim().length < 5}>{t({ en: "Void", fa: "ابطال" })}</button>
          </form>
        ) : null}
      </section>

      <section className="treasury-history">
        <h4>{t({ en: "Audit history", fa: "تاریخچه حسابرسی" })}</h4>
        <ol>
          {trace.events.map((event) => (
            <li key={event.id}>
              <time dateTime={event.occurredAt}>{formatTime(event.occurredAt, locale)}</time>
              <span>{event.aggregate.replaceAll("_", " ").toLowerCase()}</span>
              <strong>{event.fromStatus ? `${event.fromStatus} → ` : ""}{event.toStatus ?? event.operation}</strong>
              <em>{event.actor}</em>
            </li>
          ))}
        </ol>
      </section>
    </article>
  );
}

export type { ReceiptView };

function sourceStatusText(status: string, t: (copy: Copy) => string): string {
  const copy = (SOURCE_STATUS_COPY as Readonly<Record<string, Copy | undefined>>)[status];
  return copy ? t(copy) : status;
}

/** Evidence reads as on file or missing; the document id and hash stay available for audit, folded away. */
function EvidenceValue({ label, t }: { readonly label: string | undefined; readonly t: (copy: Copy) => string }) {
  if (label === undefined || label === "") return <>{t({ en: "Missing", fa: "موجود نیست" })}</>;
  return (
    <details className="treasury-evidence-detail">
      <summary>{t({ en: "On file ✓", fa: "موجود است ✓" })}</summary>
      <code dir="ltr">{label}</code>
    </details>
  );
}
