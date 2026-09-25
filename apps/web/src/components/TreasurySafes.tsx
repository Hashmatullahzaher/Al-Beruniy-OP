"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";

import { AppIcon } from "@/components/AppIcon";
import { useLocale } from "@/components/LocaleProvider";
import { localized } from "@/components/StageZeroWorkspace";
import type { ApiResponse } from "@/lib/treasury-types";
import type { SafeAccountView, SafeCountView, SafeView, SafesWorkspaceView, SarafAccountView } from "@/server/treasury-safes";

/**
 * WP-B: the Safes & accounts tab. Safes are created and opened in the app; Saraf accounts are set up;
 * cash is counted as money received (the receipt workflow) or as the whole safe. Every button only
 * asks the server; the server and the database decide, and a refusal is shown as it was given.
 */

type Copy = { readonly en: string; readonly fa: string };
type Act = (url: string, body: Record<string, unknown>, success: Copy) => Promise<boolean>;
type Section = "safes" | "saraf" | "counts";

const ACCOUNT_STATUS: Record<SafeAccountView["status"], Copy> = {
  DRAFT: { en: "Draft · not reconciled", fa: "پیش‌نویس · تطبیق نشده" },
  RECONCILED: { en: "Reconciled · awaiting approval", fa: "تطبیق شد · در انتظار تصویب" },
  APPROVED: { en: "Approved · not active", fa: "تصویب شد · فعال نیست" },
  ACTIVE: { en: "Active", fa: "فعال" },
  BLOCKED: { en: "Blocked", fa: "مسدود" }
};

const SARAF_STATUS: Record<SarafAccountView["status"], Copy> = {
  DRAFT: { en: "Draft · awaiting activation", fa: "پیش‌نویس · در انتظار فعال‌سازی" },
  ACTIVE: { en: "Active", fa: "فعال" },
  INACTIVE: { en: "Inactive", fa: "غیرفعال" }
};

const SAFE_STATUS: Record<SafeView["status"], Copy> = {
  DRAFT: { en: "Draft", fa: "پیش‌نویس" },
  ACTIVE: { en: "Active", fa: "فعال" },
  INACTIVE: { en: "Inactive", fa: "غیرفعال" }
};

async function load(): Promise<ApiResponse<SafesWorkspaceView>> {
  const response = await fetch("/api/v1/treasury/cash-locations", { cache: "no-store", headers: { "Content-Type": "application/json" } });
  try {
    return (await response.json()) as ApiResponse<SafesWorkspaceView>;
  } catch {
    return { ok: false, error: { code: "INVALID_RESPONSE", message: `The server answered ${response.status} without a readable body.` } };
  }
}

function formatAmount(amount: string, currency: string, locale: "en" | "fa"): string {
  // Display only: the stored value is exact decimal text and is never converted for arithmetic.
  const negative = amount.startsWith("-");
  const [whole = "0", fraction = ""] = (negative ? amount.slice(1) : amount).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const text = `${negative ? "−" : ""}${grouped}.${fraction.padEnd(2, "0").slice(0, Math.max(2, fraction.length))}`;
  return locale === "fa" ? `${text} ${currency}` : `${currency} ${text}`;
}

function formatTime(value: string | undefined, locale: "en" | "fa"): string {
  if (value === undefined || value === "") return "—";
  return new Date(value).toLocaleString(locale === "fa" ? "fa-AF" : "en-GB", { dateStyle: "medium", timeStyle: "short" });
}

function isZero(amount: string): boolean {
  return /^-?0*(\.0*)?$/.test(amount);
}

export function TreasurySafesPanel({ act, busy, onOpenReceipts }: { readonly act: Act; readonly busy: boolean; readonly onOpenReceipts: () => void }) {
  const { locale } = useLocale();
  const t = useCallback((copy: Copy) => localized(copy, locale), [locale]);
  const [view, setView] = useState<SafesWorkspaceView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [section, setSection] = useState<Section>("safes");

  const refresh = useCallback(async () => {
    const result = await load();
    if (result.ok) { setView(result.data); setError(null); } else setError(`${result.error.code.replaceAll("_", " ")}: ${result.error.message}`);
  }, []);

  useEffect(() => {
    let current = true;
    void load().then((result) => {
      if (!current) return;
      if (result.ok) { setView(result.data); setError(null); } else setError(`${result.error.code.replaceAll("_", " ")}: ${result.error.message}`);
    });
    return () => { current = false; };
  }, []);

  /** Runs one action through the workspace (which reports it) and then re-reads this tab. */
  const run = useCallback<Act>(async (url, body, success) => {
    const ok = await act(url, body, success);
    await refresh();
    return ok;
  }, [act, refresh]);

  if (error !== null) return <p className="treasury-empty" role="alert">{error}</p>;
  if (view === null) return <p className="treasury-empty" role="status">{t({ en: "Loading safes…", fa: "در حال بارگذاری صندوق‌ها…" })}</p>;

  const sections: readonly { readonly id: Section; readonly label: Copy; readonly count: number }[] = [
    { id: "safes", label: { en: "Safes", fa: "صندوق‌ها" }, count: view.locations.length },
    { id: "saraf", label: { en: "Saraf accounts", fa: "حساب‌های صراف" }, count: view.sarafAccounts.length },
    { id: "counts", label: { en: "Cash counts", fa: "شمارش نقد" }, count: view.safeCounts.length }
  ];

  return (
    <div className="wpb-safes">
      <nav className="wpb-switch" aria-label={t({ en: "Safes and accounts sections", fa: "بخش‌های صندوق‌ها و حساب‌ها" })}>
        {sections.map((item) => (
          <button key={item.id} type="button" aria-pressed={section === item.id} className={section === item.id ? "selected" : undefined} onClick={() => setSection(item.id)}>
            {t(item.label)} <span>{item.count}</span>
          </button>
        ))}
      </nav>
      {section === "safes" ? <Safes view={view} busy={busy} run={run} /> : null}
      {section === "saraf" ? <Saraf view={view} busy={busy} run={run} /> : null}
      {section === "counts" ? <Counts view={view} busy={busy} run={run} onOpenReceipts={onOpenReceipts} /> : null}
    </div>
  );
}

// ------------------------------------------------------------------------------------------ safes

function Safes({ view, busy, run }: { readonly view: SafesWorkspaceView; readonly busy: boolean; readonly run: Act }) {
  const { locale } = useLocale();
  const t = (copy: Copy) => localized(copy, locale);
  const [name, setName] = useState("");
  const [responsible, setResponsible] = useState("");
  const [assign, setAssign] = useState<Record<string, string>>({});

  const create = (event: FormEvent) => {
    event.preventDefault();
    void run("/api/v1/treasury/cash-locations", { name, responsibleCashierUserAccountId: responsible },
      { en: "Safe created as a draft. Activate it, then open its USD and AFN accounts.", fa: "صندوق به صورت پیش‌نویس ایجاد شد. آن را فعال کنید، سپس حساب‌های دالر و افغانی آن را باز کنید." })
      .then((ok) => { if (ok) { setName(""); setResponsible(""); } });
  };

  return (
    <div className="treasury-safes">
      {view.can.manageSafes ? (
        <form className="wpb-card wpb-form" aria-label={t({ en: "New safe", fa: "صندوق جدید" })} onSubmit={create}>
          <h3><AppIcon name="building" size={16} />{t({ en: "New safe", fa: "صندوق جدید" })}</h3>
          <label>
            <span>{t({ en: "Safe name", fa: "نام صندوق" })}</span>
            <input value={name} onChange={(event) => setName(event.target.value)} minLength={3} required placeholder={t({ en: "e.g. Branch safe (demo)", fa: "مثلاً صندوق شعبه (نمایشی)" })} />
          </label>
          <label>
            <span>{t({ en: "Responsible cashier", fa: "صندوق‌دار مسئول" })}</span>
            <select value={responsible} onChange={(event) => setResponsible(event.target.value)} required>
              <option value="">{t({ en: "Choose a person…", fa: "یک شخص را انتخاب کنید…" })}</option>
              {view.people.map((person) => <option key={person.userAccountId} value={person.userAccountId}>{person.displayName}</option>)}
            </select>
          </label>
          <button className="treasury-button gold" type="submit" disabled={busy || name.trim().length < 3 || responsible === ""}>{t({ en: "Create safe", fa: "ایجاد صندوق" })}</button>
        </form>
      ) : null}
      {view.locations.length === 0 ? <p className="treasury-empty">{t({ en: "No cash locations exist in this sandbox.", fa: "هیچ محل نگهداری نقد در این محیط وجود ندارد." })}</p> : null}
      {view.locations.map((location) => (
        <article key={location.id} className="treasury-safe" aria-label={location.name}>
          <header>
            <span aria-hidden="true"><AppIcon name="building" size={20} /></span>
            <div>
              <small>{t({ en: "Office safe", fa: "صندوق دفتر" })} · {t({ en: "responsible", fa: "مسئول" })} {location.responsibleCashier}</small>
              <h3>{location.name}</h3>
            </div>
            <span className={`treasury-chip ${location.status === "ACTIVE" ? "ok" : "muted"}`}>{t(SAFE_STATUS[location.status])}</span>
          </header>
          {location.status === "DRAFT" && view.can.manageSafes ? (
            <div className="wpb-actions">
              <button type="button" className="treasury-button" disabled={busy} onClick={() => void run(`/api/v1/treasury/cash-locations/${location.id}/activate`, {},
                { en: "Safe activated. Its accounts still need an approved opening before they can receive cash.", fa: "صندوق فعال شد. حساب‌های آن هنوز پیش از دریافت نقد به افتتاحیه تصویب‌شده نیاز دارند." })}>
                {t({ en: "Activate safe", fa: "فعال‌سازی صندوق" })}
              </button>
            </div>
          ) : null}
          <div className="treasury-accounts">
            {location.accounts.map((account) => <SafeAccount key={account.id} view={view} location={location} account={account} busy={busy} run={run} />)}
          </div>
          {view.can.manageSafes ? <OpenAccount view={view} location={location} busy={busy} run={run} /> : null}
          <footer>
            <small>{t({ en: "Assigned cashiers", fa: "صندوق‌داران تعیین‌شده" })}</small>
            <span>{location.cashiers.length === 0 ? t({ en: "None", fa: "هیچ" }) : location.cashiers.map((cashier) => cashier.displayName).join(", ")}</span>
          </footer>
          {view.can.manageSafes ? (
            <form className="treasury-inline-form treasury-assign" onSubmit={(event) => {
              event.preventDefault();
              const userAccountId = assign[location.id] ?? "";
              if (!userAccountId) return;
              void run(`/api/v1/treasury/cash-locations/${location.id}/cashiers`, { userAccountId },
                { en: "Cashier assigned to this safe. They can now record cash received into it.", fa: "صندوق‌دار به این صندوق تعیین شد. اکنون می‌تواند نقد دریافتی را در آن ثبت کند." });
            }}>
              <label htmlFor={`assign-${location.id}`}>{t({ en: "Give custody of this safe to", fa: "سپردن این صندوق به" })}</label>
              <select id={`assign-${location.id}`} value={assign[location.id] ?? ""} onChange={(event) => setAssign((current) => ({ ...current, [location.id]: event.target.value }))}>
                <option value="">{t({ en: "Choose a person…", fa: "یک شخص را انتخاب کنید…" })}</option>
                {view.people.filter((person) => !location.cashiers.some((cashier) => cashier.userAccountId === person.userAccountId))
                  .map((person) => <option key={person.userAccountId} value={person.userAccountId}>{person.displayName}</option>)}
              </select>
              <button className="treasury-button" type="submit" disabled={busy || !assign[location.id]}>{t({ en: "Assign as cashier", fa: "تعیین به عنوان صندوق‌دار" })}</button>
            </form>
          ) : null}
          <p className="treasury-note">{t({ en: "No balance is shown. Treasury keeps counts and receipts, not a balance; a figure here would be invented.", fa: "مانده نمایش داده نمی‌شود. خزانه شمارش‌ها و دریافت‌ها را نگه می‌دارد، نه مانده را؛ هر رقمی در اینجا ساختگی می‌بود." })}</p>
        </article>
      ))}
    </div>
  );
}

function OpenAccount({ view, location, busy, run }: { readonly view: SafesWorkspaceView; readonly location: SafeView; readonly busy: boolean; readonly run: Act }) {
  const { locale } = useLocale();
  const t = (copy: Copy) => localized(copy, locale);
  const missing = (["USD", "AFN"] as const).filter((currency) => !location.accounts.some((account) => account.currency === currency));
  const [currency, setCurrency] = useState<string>(missing[0] ?? "");
  const [ledger, setLedger] = useState("");
  if (missing.length === 0) return null;
  const chosenCurrency = missing.includes(currency as "USD" | "AFN") ? currency : missing[0] ?? "";
  const ledgers = view.cashLedgers.filter((choice) => choice.currency === chosenCurrency);
  return (
    <form className="wpb-form wpb-inline" aria-label={t({ en: "Open a currency account", fa: "باز کردن حساب ارزی" })} onSubmit={(event) => {
      event.preventDefault();
      void run(`/api/v1/treasury/cash-locations/${location.id}/open-account`, { currency: chosenCurrency, ledgerAccountId: ledger },
        { en: "Account opened as a draft. It needs an opening count, independent confirmation, reconciliation, approval and activation.", fa: "حساب به صورت پیش‌نویس باز شد. به شمارش افتتاحیه، تایید مستقل، تطبیق، تصویب و فعال‌سازی نیاز دارد." })
        .then((ok) => { if (ok) setLedger(""); });
    }}>
      <label>
        <span>{t({ en: "Currency", fa: "ارز" })}</span>
        <select value={chosenCurrency} onChange={(event) => { setCurrency(event.target.value); setLedger(""); }}>
          {missing.map((item) => <option key={item} value={item}>{item}</option>)}
        </select>
      </label>
      <label>
        <span>{t({ en: "Cash account in the Chart of Accounts", fa: "حساب نقد در جدول حساب‌ها" })}</span>
        <select value={ledger} onChange={(event) => setLedger(event.target.value)} required>
          <option value="">{ledgers.length === 0 ? t({ en: "No active CASH account in this currency", fa: "حساب نقد فعال به این ارز وجود ندارد" }) : t({ en: "Choose an account…", fa: "یک حساب را انتخاب کنید…" })}</option>
          {ledgers.map((choice) => <option key={choice.id} value={choice.id}>{choice.label}</option>)}
        </select>
      </label>
      <button className="treasury-button" type="submit" disabled={busy || ledger === ""}>{t({ en: "Open account", fa: "باز کردن حساب" })}</button>
      {ledgers.length === 0 ? <p className="treasury-note">{t({ en: "Treasury does not create ledger accounts. A permitted user adds the CASH account in the Chart of Accounts first.", fa: "خزانه حساب دفتر کل ایجاد نمی‌کند. ابتدا یک کاربر مجاز حساب نقد را در جدول حساب‌ها اضافه می‌کند." })}</p> : null}
    </form>
  );
}

function SafeAccount({ view, location, account, busy, run }: {
  readonly view: SafesWorkspaceView; readonly location: SafeView; readonly account: SafeAccountView; readonly busy: boolean; readonly run: Act;
}) {
  const { locale } = useLocale();
  const t = (copy: Copy) => localized(copy, locale);
  const [amount, setAmount] = useState("");
  const [countEvidence, setCountEvidence] = useState("");
  const [reconcileEvidence, setReconcileEvidence] = useState("");
  const base = `/api/v1/treasury/cash-locations/${location.id}/accounts/${account.id}`;
  const me = view.me;
  const count = account.openingCount;
  const opening = account.opening;

  let step: React.ReactNode = null;
  const wait = (copy: Copy) => <p className="wpb-wait"><AppIcon name="shield" size={14} />{t(copy)}</p>;
  if (account.status === "DRAFT" && count === undefined) {
    step = view.can.count ? (
      <form className="wpb-form wpb-inline" aria-label={t({ en: `Opening count ${account.currency}`, fa: `شمارش افتتاحیه ${account.currency}` })} onSubmit={(event) => {
        event.preventDefault();
        void run(`${base}/opening-count`, { countedAmount: amount, evidenceReferenceId: countEvidence },
          { en: "Opening count recorded. Another person must confirm it.", fa: "شمارش افتتاحیه ثبت شد. شخص دیگری باید آن را تایید کند." });
      }}>
        <label><span>{t({ en: "Opening count amount", fa: "مبلغ شمارش افتتاحیه" })} ({account.currency})</span>
          <input inputMode="decimal" dir="ltr" value={amount} onChange={(event) => setAmount(event.target.value)} required pattern="(0|[1-9][0-9]*)(\.[0-9]{1,6})?" /></label>
        <EvidenceSelect label={{ en: "Count sheet", fa: "برگه شمارش" }} options={view.evidence.count} value={countEvidence} onChange={setCountEvidence} />
        <button className="treasury-button" type="submit" disabled={busy || amount.trim() === "" || countEvidence === ""}>{t({ en: "Record opening count", fa: "ثبت شمارش افتتاحیه" })}</button>
      </form>
    ) : wait({ en: "Waiting for a person with the Count cash permission to count the opening cash.", fa: "در انتظار شمارش نقد افتتاحیه توسط شخص دارای صلاحیت شمارش نقد." });
  } else if (account.status === "DRAFT" && count?.status === "RECORDED") {
    step = view.can.approve && me !== count.countedByUserAccountId ? (
      <button type="button" className="treasury-button" disabled={busy} onClick={() => void run(`${base}/confirm-opening-count`, { physicalCashCountId: count.id },
        { en: "Opening count independently confirmed.", fa: "شمارش افتتاحیه به‌طور مستقل تایید شد." })}>{t({ en: "Confirm opening count", fa: "تایید شمارش افتتاحیه" })}</button>
    ) : wait(me === count.countedByUserAccountId
      ? { en: "You counted this cash, so someone else must confirm the count.", fa: "شما این نقد را شمرده‌اید، بنابراین شخص دیگری باید شمارش را تایید کند." }
      : { en: "Awaiting independent confirmation of the count (Approve and activate safe accounts).", fa: "در انتظار تایید مستقل شمارش (تصویب و فعال‌سازی حساب صندوق)." });
  } else if (account.status === "DRAFT" && count?.status === "CONFIRMED") {
    step = view.can.reconcile ? (
      <form className="wpb-form wpb-inline" aria-label={t({ en: `Reconcile opening ${account.currency}`, fa: `تطبیق افتتاحیه ${account.currency}` })} onSubmit={(event) => {
        event.preventDefault();
        void run(`${base}/reconcile`, { physicalCashCountId: count.id, reconciliationEvidenceReferenceId: reconcileEvidence },
          { en: "Opening reconciled. It now needs independent approval.", fa: "افتتاحیه تطبیق شد. اکنون به تصویب مستقل نیاز دارد." });
      }}>
        <EvidenceSelect label={{ en: "Reconciliation evidence", fa: "سند تطبیق" }} options={view.evidence.reconciliation} value={reconcileEvidence} onChange={setReconcileEvidence} />
        <button className="treasury-button" type="submit" disabled={busy || reconcileEvidence === ""}>{t({ en: "Reconcile opening", fa: "تطبیق افتتاحیه" })}</button>
      </form>
    ) : wait({ en: "Counted and confirmed. Awaiting reconciliation.", fa: "شمرده و تایید شد. در انتظار تطبیق." });
  } else if (account.status === "RECONCILED" && opening !== undefined) {
    const independent = me !== opening.countedByUserAccountId && me !== opening.reconciledByUserAccountId;
    step = view.can.approve && independent ? (
      <button type="button" className="treasury-button gold" disabled={busy} onClick={() => void run(`${base}/approve`, {},
        { en: "Opening approved.", fa: "افتتاحیه تصویب شد." })}>{t({ en: "Approve opening", fa: "تصویب افتتاحیه" })}</button>
    ) : wait({ en: "Awaiting approval by someone who neither counted nor reconciled.", fa: "در انتظار تصویب توسط کسی که نه شمرده و نه تطبیق داده است." });
  } else if (account.status === "APPROVED" && opening !== undefined) {
    step = view.can.approve && me !== opening.reconciledByUserAccountId ? (
      location.status === "ACTIVE" ? (
        <button type="button" className="treasury-button gold" disabled={busy} onClick={() => void run(`${base}/activate`, {},
          { en: "Account activated. It can now receive cash.", fa: "حساب فعال شد. اکنون می‌تواند نقد دریافت کند." })}>{t({ en: "Activate account", fa: "فعال‌سازی حساب" })}</button>
      ) : wait({ en: "Activate the safe first.", fa: "ابتدا صندوق را فعال کنید." })
    ) : wait({ en: "Awaiting activation by someone who did not reconcile.", fa: "در انتظار فعال‌سازی توسط کسی که تطبیق نداده است." });
  }
  const blockable = view.can.approve && (account.status === "RECONCILED" || account.status === "APPROVED" || account.status === "ACTIVE");

  return (
    <div className={`treasury-account ${account.status === "ACTIVE" ? "active" : ""}`}>
      <strong>{account.currency}</strong>
      <span className={`treasury-chip ${account.status === "ACTIVE" ? "ok" : account.status === "BLOCKED" ? "danger" : "muted"}`}>{t(ACCOUNT_STATUS[account.status])}</span>
      <dl>
        <dt>{t({ en: "Ledger account", fa: "حساب دفتر کل" })}</dt>
        <dd>{account.ledgerLabel}</dd>
        <dt>{t({ en: "Opening position", fa: "موقعیت افتتاحیه" })}</dt>
        <dd>{opening !== undefined
          ? `${opening.status} · ${t({ en: "counted", fa: "شمارش‌شده" })} ${formatAmount(opening.amount, account.currency, locale)}`
          : count !== undefined
            ? `${t({ en: "Counted", fa: "شمرده‌شده" })} ${formatAmount(count.amount, account.currency, locale)} · ${count.countedBy}${count.confirmedBy ? ` · ${t({ en: "confirmed by", fa: "تایید توسط" })} ${count.confirmedBy}` : ""}`
            : t({ en: "Not counted or reconciled", fa: "شمارش یا تطبیق نشده" })}</dd>
        {opening !== undefined ? <><dt>{t({ en: "Reconciled · approved by", fa: "تطبیق · تصویب توسط" })}</dt><dd>{opening.reconciledBy} · {opening.approvedBy ?? "—"}</dd></> : null}
        <dt>{t({ en: "Activated by", fa: "فعال‌شده توسط" })}</dt>
        <dd>{account.activatedBy ?? "—"}</dd>
      </dl>
      {step !== null || blockable ? (
        <div className="wpb-actions">
          {step}
          {blockable ? (
            <button type="button" className="treasury-button danger" disabled={busy} onClick={() => void run(`${base}/block`, {},
              { en: "Account blocked. It cannot receive cash.", fa: "حساب مسدود شد. نمی‌تواند نقد دریافت کند." })}>{t({ en: "Block account", fa: "مسدود کردن حساب" })}</button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function EvidenceSelect({ label, options, value, onChange }: {
  readonly label: Copy; readonly options: readonly { readonly id: string; readonly label: string }[]; readonly value: string; readonly onChange: (value: string) => void;
}) {
  const { locale } = useLocale();
  const t = (copy: Copy) => localized(copy, locale);
  return (
    <label>
      <span>{t(label)}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)} required>
        <option value="">{options.length === 0
          ? t({ en: "No unused evidence provisioned", fa: "سند استفاده‌نشده‌ای فراهم نشده است" })
          : t({ en: "Choose evidence…", fa: "سند را انتخاب کنید…" })}</option>
        {options.map((option) => <option key={option.id} value={option.id} dir="ltr">{option.label}</option>)}
      </select>
    </label>
  );
}

// ------------------------------------------------------------------------------------------ Saraf

function Saraf({ view, busy, run }: { readonly view: SafesWorkspaceView; readonly busy: boolean; readonly run: Act }) {
  const { locale } = useLocale();
  const t = (copy: Copy) => localized(copy, locale);
  const [party, setParty] = useState("");
  const [currency, setCurrency] = useState<"USD" | "AFN">("USD");
  const [ledger, setLedger] = useState("");
  const ledgers = view.sarafLedgers.filter((choice) => choice.currency === currency);

  return (
    <div className="wpb-saraf">
      <p className="wpb-intro">{t({ en: "A Saraf account links a Saraf (a business party with a current Saraf role) to a SARAF control account from the Chart of Accounts, in one currency. This is account set-up only: V1 has no Saraf transactions, transfers or balances.", fa: "حساب صراف یک صراف (طرف تجاری دارای نقش فعلی صراف) را به یک حساب کنترل صراف از جدول حساب‌ها، به یک ارز، وصل می‌کند. این فقط ایجاد حساب است: نسخه V1 معامله، انتقال یا مانده صراف ندارد." })}</p>
      {view.can.manageSaraf ? (
        <form className="wpb-card wpb-form" aria-label={t({ en: "New Saraf account", fa: "حساب صراف جدید" })} onSubmit={(event) => {
          event.preventDefault();
          void run("/api/v1/treasury/saraf-accounts", { businessPartyId: party, currency, ledgerAccountId: ledger },
            { en: "Saraf account created as a draft. Another person must activate it.", fa: "حساب صراف به صورت پیش‌نویس ایجاد شد. شخص دیگری باید آن را فعال کند." })
            .then((ok) => { if (ok) setLedger(""); });
        }}>
          <h3><AppIcon name="coins" size={16} />{t({ en: "New Saraf account", fa: "حساب صراف جدید" })}</h3>
          <label><span>{t({ en: "Saraf", fa: "صراف" })}</span>
            <select value={party} onChange={(event) => setParty(event.target.value)} required>
              <option value="">{view.sarafParties.length === 0 ? t({ en: "No business party holds a current Saraf role", fa: "هیچ طرف تجاری نقش فعلی صراف ندارد" }) : t({ en: "Choose a Saraf…", fa: "یک صراف را انتخاب کنید…" })}</option>
              {view.sarafParties.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select></label>
          <label><span>{t({ en: "Currency", fa: "ارز" })}</span>
            <select value={currency} onChange={(event) => { setCurrency(event.target.value === "AFN" ? "AFN" : "USD"); setLedger(""); }}>
              <option value="USD">USD</option><option value="AFN">AFN</option>
            </select></label>
          <label><span>{t({ en: "Saraf control account in the Chart of Accounts", fa: "حساب کنترل صراف در جدول حساب‌ها" })}</span>
            <select value={ledger} onChange={(event) => setLedger(event.target.value)} required>
              <option value="">{ledgers.length === 0 ? t({ en: "No active SARAF account in this currency", fa: "حساب صراف فعال به این ارز وجود ندارد" }) : t({ en: "Choose an account…", fa: "یک حساب را انتخاب کنید…" })}</option>
              {ledgers.map((choice) => <option key={choice.id} value={choice.id}>{choice.label}</option>)}
            </select></label>
          <button className="treasury-button gold" type="submit" disabled={busy || party === "" || ledger === ""}>{t({ en: "Create Saraf account", fa: "ایجاد حساب صراف" })}</button>
        </form>
      ) : null}
      {view.sarafAccounts.length === 0 ? <p className="treasury-empty">{t({ en: "No Saraf accounts yet.", fa: "هنوز حساب صرافی وجود ندارد." })}</p> : (
        <ul className="saraf-accounts" aria-label={t({ en: "Saraf accounts", fa: "حساب‌های صراف" })}>
          {view.sarafAccounts.map((account) => {
            const mine = account.createdByUserAccountId === view.me;
            return (
              <li key={account.id} className={`saraf-account status-${account.status.toLowerCase()}`}>
                <header>
                  <strong>{account.partyName}</strong>
                  <span className="wpb-currency">{account.currency}</span>
                  <span className={`treasury-chip ${account.status === "ACTIVE" ? "ok" : account.status === "DRAFT" ? "gold" : "muted"}`}>{t(SARAF_STATUS[account.status])}</span>
                </header>
                <dl>
                  <dt>{t({ en: "Ledger account", fa: "حساب دفتر کل" })}</dt><dd>{account.ledgerLabel}</dd>
                  <dt>{t({ en: "Created by", fa: "ایجاد توسط" })}</dt><dd>{account.createdBy} · {formatTime(account.createdAt, locale)}</dd>
                  <dt>{t({ en: "Activated by", fa: "فعال‌شده توسط" })}</dt><dd>{account.activatedBy ? `${account.activatedBy} · ${formatTime(account.activatedAt, locale)}` : "—"}</dd>
                </dl>
                {view.can.manageSaraf ? (
                  <div className="wpb-actions">
                    {account.status !== "ACTIVE" ? (mine
                      ? <p className="wpb-wait"><AppIcon name="shield" size={14} />{t({ en: "You created this account, so another person must activate it.", fa: "شما این حساب را ایجاد کرده‌اید، بنابراین شخص دیگری باید آن را فعال کند." })}</p>
                      : <button type="button" className="treasury-button" disabled={busy} onClick={() => void run(`/api/v1/treasury/saraf-accounts/${account.id}/activate`, {},
                        { en: "Saraf account activated.", fa: "حساب صراف فعال شد." })}>{t({ en: "Activate Saraf account", fa: "فعال‌سازی حساب صراف" })}</button>) : null}
                    {account.status !== "INACTIVE" ? (
                      <button type="button" className="treasury-button quiet" disabled={busy} onClick={() => void run(`/api/v1/treasury/saraf-accounts/${account.id}/deactivate`, {},
                        { en: "Saraf account deactivated.", fa: "حساب صراف غیرفعال شد." })}>{t({ en: "Deactivate", fa: "غیرفعال‌سازی" })}</button>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------ counts

function Counts({ view, busy, run, onOpenReceipts }: { readonly view: SafesWorkspaceView; readonly busy: boolean; readonly run: Act; readonly onOpenReceipts: () => void }) {
  const { locale } = useLocale();
  const t = (copy: Copy) => localized(copy, locale);
  const [mode, setMode] = useState<"received" | "whole">("whole");
  const [account, setAccount] = useState("");
  const [amount, setAmount] = useState("");
  const [evidence, setEvidence] = useState("");
  const [note, setNote] = useState("");
  const countable = view.locations.flatMap((location) => location.accounts
    .filter((item) => item.opening?.status === "APPROVED")
    .map((item) => ({ id: item.id, label: `${location.name} · ${item.currency}` })));

  return (
    <div className="wpb-counts">
      <fieldset className="wpb-mode">
        <legend>{t({ en: "Count mode", fa: "نوع شمارش" })}</legend>
        <label className={mode === "received" ? "selected" : undefined}>
          <input type="radio" name="wpb-count-mode" checked={mode === "received"} onChange={() => setMode("received")} />
          <span><strong>{t({ en: "Money received only", fa: "فقط پول دریافتی" })}</strong><small>{t({ en: "Count the cash of one receipt, as part of recording it.", fa: "شمارش نقد یک رسید، هنگام ثبت آن." })}</small></span>
        </label>
        <label className={mode === "whole" ? "selected" : undefined}>
          <input type="radio" name="wpb-count-mode" checked={mode === "whole"} onChange={() => setMode("whole")} />
          <span><strong>{t({ en: "Whole safe", fa: "کل صندوق" })}</strong><small>{t({ en: "Count everything in one currency account of a safe at a point in time.", fa: "شمارش همه نقد یک حساب ارزی صندوق در یک لحظه." })}</small></span>
        </label>
      </fieldset>

      {mode === "received" ? (
        <div className="wpb-card">
          <p>{t({ en: "Money received is counted on the receipt itself: open the receipt, record its physical count, and submit it for independent verification.", fa: "پول دریافتی روی خود رسید شمرده می‌شود: رسید را باز کنید، شمارش فزیکی آن را ثبت کنید و برای تایید مستقل ارسال کنید." })}</p>
          <button type="button" className="treasury-button" onClick={onOpenReceipts}>{t({ en: "Go to receipts", fa: "رفتن به رسیدها" })}</button>
        </div>
      ) : (
        <>
          {view.can.count ? (
            <form className="wpb-card wpb-form" aria-label={t({ en: "Whole-safe count", fa: "شمارش کل صندوق" })} onSubmit={(event) => {
              event.preventDefault();
              void run("/api/v1/treasury/safe-counts", { cashAccountId: account, countedAmount: amount, evidenceReferenceId: evidence, note },
                { en: "Whole-safe count recorded. Another person must confirm it.", fa: "شمارش کل صندوق ثبت شد. شخص دیگری باید آن را تایید کند." })
                .then((ok) => { if (ok) { setAmount(""); setEvidence(""); setNote(""); } });
            }}>
              <h3><AppIcon name="coins" size={16} />{t({ en: "Record a whole-safe count", fa: "ثبت شمارش کل صندوق" })}</h3>
              <label><span>{t({ en: "Safe account", fa: "حساب صندوق" })}</span>
                <select value={account} onChange={(event) => setAccount(event.target.value)} required>
                  <option value="">{countable.length === 0 ? t({ en: "No account with an approved opening", fa: "حسابی با افتتاحیه تصویب‌شده وجود ندارد" }) : t({ en: "Choose an account…", fa: "یک حساب را انتخاب کنید…" })}</option>
                  {countable.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                </select></label>
              <label><span>{t({ en: "Whole-safe counted amount", fa: "مبلغ شمارش کل صندوق" })}</span>
                <input inputMode="decimal" dir="ltr" value={amount} onChange={(event) => setAmount(event.target.value)} required pattern="(0|[1-9][0-9]*)(\.[0-9]{1,6})?" /></label>
              <EvidenceSelect label={{ en: "Count sheet", fa: "برگه شمارش" }} options={view.evidence.count} value={evidence} onChange={setEvidence} />
              <label><span>{t({ en: "Note (optional)", fa: "یادداشت (اختیاری)" })}</span>
                <input value={note} maxLength={500} onChange={(event) => setNote(event.target.value)} /></label>
              <button className="treasury-button gold" type="submit" disabled={busy || account === "" || amount.trim() === "" || evidence === ""}>{t({ en: "Record whole-safe count", fa: "ثبت شمارش کل صندوق" })}</button>
            </form>
          ) : null}
          <p className="treasury-note">{t({ en: "When a count is recorded, the database takes a snapshot of the custody total Treasury can derive: the approved opening count plus receipts verified up to that moment. The difference is shown only. What to do about a difference (tolerance, investigation, adjustment) is not yet decided by the Finance Manager, so nothing is posted or adjusted.", fa: "هنگام ثبت شمارش، پایگاه داده از مجموع نگهداری قابل استخراج خزانه عکس‌برداری می‌کند: شمارش افتتاحیه تصویب‌شده به‌علاوه رسیدهای تاییدشده تا همان لحظه. تفاوت فقط نمایش داده می‌شود. اقدام در برابر تفاوت (حد مجاز، بررسی، تعدیل) هنوز توسط مدیر مالی تعیین نشده است، بنابراین هیچ ثبت یا تعدیلی انجام نمی‌شود." })}</p>
          {view.safeCounts.length === 0 ? <p className="treasury-empty">{t({ en: "No whole-safe counts yet.", fa: "هنوز شمارش کل صندوق وجود ندارد." })}</p> : (
            <ul className="safe-counts" aria-label={t({ en: "Whole-safe counts", fa: "شمارش‌های کل صندوق" })}>
              {view.safeCounts.map((count) => <SafeCount key={count.id} count={count} view={view} busy={busy} run={run} />)}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function SafeCount({ count, view, busy, run }: { readonly count: SafeCountView; readonly view: SafesWorkspaceView; readonly busy: boolean; readonly run: Act }) {
  const { locale } = useLocale();
  const t = (copy: Copy) => localized(copy, locale);
  const even = isZero(count.difference);
  const mine = count.countedByUserAccountId === view.me;
  return (
    <li className={`safe-count ${even ? "even" : "different"}`}>
      <header>
        <div><small>{count.accountLabel}</small><strong>{formatAmount(count.countedAmount, count.currency, locale)}</strong></div>
        <span className={`treasury-chip ${count.status === "CONFIRMED" ? "ok" : "gold"}`}>{count.status === "CONFIRMED" ? t({ en: "Confirmed", fa: "تاییدشده" }) : t({ en: "Awaiting independent confirmation", fa: "در انتظار تایید مستقل" })}</span>
      </header>
      <dl>
        <dt>{t({ en: "Custody total at count time", fa: "مجموع نگهداری هنگام شمارش" })}</dt>
        <dd>{formatAmount(count.custodyTotal, count.currency, locale)} <small>({t({ en: "opening", fa: "افتتاحیه" })} {formatAmount(count.openingAmount, count.currency, locale)} + {count.verifiedReceiptCount} {t({ en: "verified receipts", fa: "رسید تاییدشده" })} {formatAmount(count.verifiedReceiptsAmount, count.currency, locale)})</small></dd>
        <dt>{t({ en: "Difference (counted − custody total)", fa: "تفاوت (شمرده‌شده − مجموع نگهداری)" })}</dt>
        <dd className={even ? "wpb-even" : "wpb-different"}>{even ? t({ en: "No difference", fa: "بدون تفاوت" }) : formatAmount(count.difference, count.currency, locale)}</dd>
        {count.unverifiedReceiptCount > 0 ? <><dt>{t({ en: "Not in the total", fa: "خارج از مجموع" })}</dt><dd>{count.unverifiedReceiptCount} {t({ en: "receipt(s) recorded but not yet verified", fa: "رسید ثبت‌شده اما هنوز تاییدنشده" })}</dd></> : null}
        <dt>{t({ en: "Counted by", fa: "شمارش توسط" })}</dt><dd>{count.countedBy} · {formatTime(count.countedAt, locale)}</dd>
        <dt>{t({ en: "Confirmed by", fa: "تایید توسط" })}</dt><dd>{count.confirmedBy ? `${count.confirmedBy} · ${formatTime(count.confirmedAt, locale)}` : "—"}</dd>
        <dt>{t({ en: "Evidence", fa: "سند" })}</dt><dd dir="ltr">{count.evidenceLabel}</dd>
        {count.note ? <><dt>{t({ en: "Note", fa: "یادداشت" })}</dt><dd>{count.note}</dd></> : null}
      </dl>
      {count.status === "RECORDED" ? (
        <div className="wpb-actions">
          {view.can.approve && !mine ? (
            <button type="button" className="treasury-button" disabled={busy} onClick={() => void run(`/api/v1/treasury/safe-counts/${count.id}/confirm`, {},
              { en: "Whole-safe count independently confirmed. The difference is recorded, not resolved.", fa: "شمارش کل صندوق به‌طور مستقل تایید شد. تفاوت ثبت شد، نه حل." })}>{t({ en: "Confirm whole-safe count", fa: "تایید شمارش کل صندوق" })}</button>
          ) : <p className="wpb-wait"><AppIcon name="shield" size={14} />{mine
            ? t({ en: "You counted this safe, so another person must confirm the count.", fa: "شما این صندوق را شمرده‌اید، بنابراین شخص دیگری باید شمارش را تایید کند." })
            : t({ en: "Awaiting confirmation by a person with Approve and activate safe accounts.", fa: "در انتظار تایید توسط شخص دارای صلاحیت تصویب و فعال‌سازی حساب صندوق." })}</p>}
        </div>
      ) : null}
    </li>
  );
}
