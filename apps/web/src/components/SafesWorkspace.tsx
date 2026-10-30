"use client";

import type { MoneyOptions, SafeOpeningBalanceResult, SafeView, SafesWorkspace as Workspace } from "@abos/contracts";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { AccessGate, api, errorText } from "@/components/AdminUsersWorkspace";
import { AppIcon } from "@/components/AppIcon";
import { FxConversionField, type FxChoice } from "@/components/FxConversionField";
import { useLocale } from "@/components/LocaleProvider";
import { MONEY_ACTION_COPY, MONEY_ERROR_FA, MoneyMovementForm, type MoneyKind } from "@/components/MoneyMovementForms";
import { localizedName, money } from "@/components/OperationalFinanceShared";
import { StageZeroPageHeader } from "@/components/StageZeroWorkspace";
import type { Copy } from "@/lib/access-copy";

const ENDPOINT = "/api/v1/finance/safes";
const MONEY_ENDPOINT = "/api/v1/finance/money";
const AMOUNT = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;

const TYPE_COPY: Readonly<Record<string, Copy>> = {
  SAFE: { en: "Safe", fa: "صندوق" },
  CASH_BOX: { en: "Cash box", fa: "صندوقچه" },
  PETTY_CASH: { en: "Petty cash", fa: "تنخواه" },
  BANK: { en: "Bank account", fa: "حساب بانکی" },
  SARAF: { en: "Saraf account", fa: "حساب صراف" },
  OTHER: { en: "Other", fa: "دیگر" }
};

const STATUS_COPY: Readonly<Record<string, Copy>> = {
  ACTIVE: { en: "Active", fa: "فعال" },
  INACTIVE: { en: "Inactive", fa: "غیرفعال" },
  CLOSED: { en: "Closed", fa: "بسته" }
};

/** Business names for what moved the money; posting machinery never reaches the screen. */
const SOURCE_COPY: Readonly<Record<string, Copy>> = {
  OPENING_BALANCE: { en: "Opening balance", fa: "موجودی افتتاحیه" },
  OPERATIONAL_EXPENSE: { en: "Expense", fa: "مصرف" },
  DIRECT_SHAREHOLDER_CAPITAL: { en: "Shareholder capital", fa: "سرمایهٔ سهامدار" },
  TEMPORARY_FUNDING: { en: "Temporary funding", fa: "تمویل موقت" },
  TEMPORARY_FUNDING_SETTLEMENT: { en: "Temporary funding repaid", fa: "بازپرداخت تمویل موقت" },
  CASH_RECEIPT: { en: "Cash received", fa: "پول دریافت‌شده" },
  TREASURY_TRANSFER: { en: "Transfer", fa: "انتقال" },
  PAYMENT: { en: "Payment", fa: "پرداخت" },
  REVERSAL: { en: "Reversal", fa: "برگشت" }
};

/** Dari for the refusal codes returned by safesErrorResponse. */
const ERROR_FA: Readonly<Record<string, string>> = {
  OPENING_EXISTS: "این صندوق قبلاً موجودی افتتاحیه دارد. موجودی افتتاحیهٔ ثبت‌شده با برگشت اصلاح می‌شود، هرگز ویرایش نمی‌شود.",
  OPENING_EQUITY_MISSING: "ابتدا در جدول حساب‌ها یک حساب فعال سرمایه با کنترل «سرمایهٔ موجودی افتتاحیه» بسازید.",
  OPENING_EQUITY_AMBIGUOUS: "بیش از یک حساب فعال «سرمایهٔ موجودی افتتاحیه» وجود دارد. فقط یکی را نگه دارید.",
  OPENING_EQUITY_INVALID: "حساب «سرمایهٔ موجودی افتتاحیه» باید حساب سرمایه‌ای باشد که به واحد پول حسابداری ثبت می‌پذیرد.",
  DATE_IN_FUTURE: "تاریخ موجودی نمی‌تواند بعد از امروز باشد.",
  CURRENCY_MISMATCH: "موجودی افتتاحیه باید به واحد پول صندوق باشد.",
  FOREIGN_CURRENCY_NOT_AVAILABLE: "فعلاً موجودی افتتاحیه فقط برای صندوق‌هایی به واحد پول حسابداری شرکت ثبت می‌شود.",
  SAFE_NOT_ACTIVE: "فقط صندوق فعال موجودی افتتاحیه می‌پذیرد.",
  SAFE_NOT_FOUND: "این صندوق برای شرکت شما در دسترس نیست.",
  PERIOD_MISSING: "هیچ ماهی در سال مالی شما این تاریخ را پوشش نمی‌دهد. ابتدا سال مالی را بسازید.",
  PERIOD_CLOSED: "ماهی که این تاریخ را پوشش می‌دهد بسته است. تاریخ دیگری انتخاب کنید.",
  ALREADY_SUBMITTED_DIFFERENTLY: "این فرم قبلاً با جزئیات دیگری فرستاده شده است. دوباره شروع کنید.",
  USER_NOT_AVAILABLE: "اشخاص فعال این شرکت را انتخاب کنید.",
  INVALID_AMOUNT: "یک مبلغ مثبت مانند 2500 یا 2500.50 وارد کنید.",
  VALIDATION_FAILED: "بعضی جزئیات ناقص یا نادرست است.",
  NETWORK: "سرور در دسترس نیست. دوباره تلاش کنید؛ همان درخواست دوباره ثبت نمی‌شود."
};

function safeError(error: { code: string; message: string }, locale: "en" | "fa"): string {
  if (locale === "fa") return ERROR_FA[error.code] ?? MONEY_ERROR_FA[error.code] ?? errorText(error, locale);
  if (error.code === "NETWORK") return "The server could not be reached. Try again; the same request will not be recorded twice.";
  return error.message || errorText(error, locale);
}

function requestIdentity() {
  return { idempotencyKey: `opening-${crypto.randomUUID()}`, correlationId: crypto.randomUUID() };
}

export function SafesWorkspace() {
  const { locale } = useLocale();
  const fa = locale === "fa";
  const t = useCallback((copy: Copy) => copy[locale], [locale]);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [gate, setGate] = useState<"signed-out" | "denied" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Copy | null>(null);
  const [busy, setBusy] = useState(false);
  const [openFor, setOpenFor] = useState<string | null>(null);
  const [moneyOptions, setMoneyOptions] = useState<MoneyOptions | null>(null);
  const [moneyFor, setMoneyFor] = useState<{ safeId: string; kind: MoneyKind } | null>(null);

  const apply = useCallback((result: Awaited<ReturnType<typeof api<Workspace>>>) => {
    if (!result.ok) {
      setGate(result.status === 401 ? "signed-out" : result.status === 403 ? "denied" : null);
      if (result.status !== 401 && result.status !== 403) setError(safeError(result.error, locale));
      return;
    }
    setGate(null);
    setWorkspace(result.data);
  }, [locale]);

  useEffect(() => {
    let current = true;
    void api<Workspace>(ENDPOINT).then((result) => { if (current) apply(result); });
    return () => { current = false; };
  }, [apply]);

  // Money movement options; without any movement permission the Safes stay read-only.
  const loadMoney = useCallback(async () => {
    const result = await api<MoneyOptions>(MONEY_ENDPOINT);
    setMoneyOptions(result.ok ? result.data : null);
  }, []);
  useEffect(() => {
    let current = true;
    void api<MoneyOptions>(MONEY_ENDPOINT).then((result) => { if (current) setMoneyOptions(result.ok ? result.data : null); });
    return () => { current = false; };
  }, []);

  const moneyDone = useCallback(async (done: Copy) => {
    const result = await api<Workspace>(ENDPOINT);
    apply(result);
    await loadMoney();
    setError(null);
    setNotice(done);
  }, [apply, loadMoney]);

  const post = useCallback(async (body: Record<string, unknown>, done: Copy): Promise<boolean> => {
    setBusy(true);
    setError(null);
    const result = await api<{ workspace: Workspace } & Partial<SafeOpeningBalanceResult>>(ENDPOINT, "POST", body);
    setBusy(false);
    if (!result.ok) {
      if (result.status === 401) setGate("signed-out");
      setError(safeError(result.error, locale));
      return false;
    }
    setWorkspace(result.data.workspace);
    setNotice(done);
    return true;
  }, [locale]);

  if (gate) {
    return <div className="module-workspace"><AccessGate state={gate} fa={fa} what={{
      en: "Safes need permission to see Safes, or a Safe you are responsible for.",
      fa: "صندوق‌ها به صلاحیت دیدن صندوق‌ها، یا صندوقی که مسئول آن هستید، نیاز دارد."
    }} /></div>;
  }

  const equityReady = workspace?.openingEquity.status === "READY";

  return (
    <div className="module-workspace safes-workspace">
      <StageZeroPageHeader icon="coins"
        eyebrow={{ en: "Finance · Daily work", fa: "مالی · کار روزانه" }}
        title={{ en: "Safes", fa: "صندوق‌ها" }}
        description={{
          en: "Each Safe shows its real book balance: its opening balance plus every recorded movement in and out. Nobody types a balance.",
          fa: "هر صندوق موجودی واقعی دفتری خود را نشان می‌دهد: موجودی افتتاحیه به‌علاوهٔ هر حرکت ثبت‌شدهٔ ورودی و خروجی. هیچ‌کس موجودی را تایپ نمی‌کند."
        }} />

      {notice ? <div className="treasury-message success" role="status"><AppIcon name="shield" size={16} /><span>{t(notice)}</span>
        <button onClick={() => setNotice(null)} aria-label={fa ? "بستن" : "Dismiss"}>×</button></div> : null}
      {error ? <div className="treasury-message error" role="alert"><AppIcon name="alert" size={16} /><span>{error}</span>
        <button onClick={() => setError(null)} aria-label={fa ? "بستن" : "Dismiss"}>×</button></div> : null}

      {workspace === null ? <p className="treasury-placeholder">{fa ? "در حال بارگذاری…" : "Loading…"}</p> : <>
        {workspace.canRecordOpeningBalance && !equityReady ? (
          <div className="state-panel" role="status"><span className="state-panel-icon" aria-hidden="true">!</span><div>
            <h3>{fa ? "موجودی افتتاحیه هنوز آماده نیست" : "Opening balances are not ready yet"}</h3>
            <p className="expense-gaps">{workspace.openingEquity.status === "AMBIGUOUS"
              ? (fa ? "بیش از یک حساب فعال «سرمایهٔ موجودی افتتاحیه» وجود دارد. در جدول حساب‌ها فقط یکی را فعال نگه دارید."
                : "More than one active account is marked “Opening balance equity”. Keep exactly one active in the Chart of Accounts.")
              : workspace.openingEquity.status === "INVALID"
                ? (fa ? `حساب «سرمایهٔ موجودی افتتاحیه» باید حساب سرمایه‌ای باشد که به ${workspace.baseCurrency} ثبت می‌پذیرد.`
                  : `The “Opening balance equity” account must be an Equity account that accepts postings in ${workspace.baseCurrency}.`)
                : (fa ? "در جدول حساب‌ها یک حساب سرمایه با کنترل «سرمایهٔ موجودی افتتاحیه» بسازید؛ موجودی افتتاحیه در مقابل آن ثبت می‌شود."
                  : "Create one Equity account with the control “Opening balance equity” in the Chart of Accounts; opening balances are recorded against it.")}
              {" "}<Link href="/finance/accounts">{fa ? "جدول حساب‌ها" : "Chart of Accounts"}</Link></p></div></div>
        ) : null}

        {workspace.safes.length === 0 ? (
          <section className="module-content-card"><p>{fa
            ? "هنوز صندوقی ثبت نشده است. صندوق‌ها در تنظیمات مالی ساخته می‌شوند."
            : "No Safe has been set up yet. Safes are created in Finance setup."}
            {workspace.canManageSafes ? <> <Link href="/finance/setup">{fa ? "تنظیمات مالی" : "Finance setup"}</Link></> : null}</p></section>
        ) : (
          <div className="safes-list">{workspace.safes.map((safe) => (
            <SafeCard key={safe.id} safe={safe} workspace={workspace} fa={fa} t={t} busy={busy}
              formOpen={openFor === safe.id} toggleForm={() => setOpenFor(openFor === safe.id ? null : safe.id)}
              post={post} closeForm={() => setOpenFor(null)} moneyOptions={moneyOptions}
              moneyKind={moneyFor?.safeId === safe.id ? moneyFor.kind : null}
              openMoney={(kind) => { setNotice(null); setMoneyFor(moneyFor?.safeId === safe.id && moneyFor.kind === kind ? null : { safeId: safe.id, kind }); }}
              // A save that finishes later closes only its own form, never one opened since.
              closeMoney={(kind) => setMoneyFor((open) => (open?.safeId === safe.id && open.kind === kind ? null : open))} moneyDone={moneyDone} />))}</div>
        )}
      </>}
    </div>
  );
}

function SafeCard({ safe, workspace, fa, t, busy, formOpen, toggleForm, closeForm, post, moneyOptions, moneyKind, openMoney, closeMoney, moneyDone }: Readonly<{
  safe: SafeView; workspace: Workspace; fa: boolean; t: (copy: Copy) => string; busy: boolean; formOpen: boolean;
  toggleForm: () => void; closeForm: () => void; post: (body: Record<string, unknown>, done: Copy) => Promise<boolean>;
  moneyOptions: MoneyOptions | null; moneyKind: MoneyKind | null; openMoney: (kind: MoneyKind) => void; closeMoney: (kind: MoneyKind) => void;
  moneyDone: (done: Copy) => Promise<void>;
}>) {
  const name = localizedName(safe, fa);
  const headingId = `safe-${safe.id}`;
  const canOpen = workspace.canRecordOpeningBalance && safe.status === "ACTIVE" && (safe.openingBalance === null || safe.openingBalance.reversal !== undefined)
    && workspace.openingEquity.status === "READY";
  // 0051: movements are offered on active accounts in the accounting currency or a foreign currency the company holds;
  // a foreign-currency form shows the day's rate and the accounting amount, or what setup is missing.
  const movable = moneyOptions !== null && safe.status === "ACTIVE"
    && (safe.currencyCode === moneyOptions.baseCurrency || moneyOptions.fx.some((item) => item.currencyCode === safe.currencyCode));
  const foreign = workspace.baseCurrency !== null && safe.currencyCode !== workspace.baseCurrency;
  const moneyKinds: MoneyKind[] = !movable ? [] : [
    ...(moneyOptions.canReceive ? ["receive" as const] : []),
    ...(moneyOptions.canTransfer ? ["transfer" as const] : []),
    ...(moneyOptions.canPay || moneyOptions.canRecordExpense ? ["pay" as const] : [])
  ];
  return (
    <section className="module-content-card safe-card" aria-labelledby={headingId}>
      <header className="safe-card-head">
        <div>
          <h2 id={headingId}><AppIcon name="coins" size={18} /> {name}</h2>
          <p className="admin-hint">
            <span className="treasury-chip">{t(TYPE_COPY[safe.accountType] ?? { en: safe.accountType, fa: safe.accountType })}</span>{" "}
            <span className={`treasury-chip safe-status-${safe.status.toLowerCase()}`}>{t(STATUS_COPY[safe.status] ?? { en: safe.status, fa: safe.status })}</span>{" "}
            <span dir="ltr">{safe.currencyCode}</span>{" · "}
            {fa ? "حساب دفتر: " : "Ledger account: "}<span dir="ltr">{safe.ledgerAccount.code}</span> {safe.ledgerAccount.name}
          </p>
        </div>
        <div className="safe-book" aria-label={fa ? "موجودی دفتری" : "Book balance"}>
          <span>{fa ? "موجودی دفتری" : "Book balance"}</span>
          <strong dir="ltr">{money(safe.balance.book, safe.currencyCode)}</strong>
          {foreign && safe.balance.baseBook !== undefined && workspace.baseCurrency ? <small>{fa ? "در دفاتر: " : "In the books: "}
            <span dir="ltr">{money(safe.balance.baseBook, workspace.baseCurrency)}</span></small> : null}
        </div>
      </header>

      <dl className="safe-figures">
        <div><dt>{fa ? "موجودی افتتاحیه" : "Opening balance"}</dt><dd dir="ltr">{money(safe.balance.opening, safe.currencyCode)}</dd></div>
        <div><dt>{fa ? "ورودی" : "Money in"}</dt><dd dir="ltr">{money(safe.balance.inflows, safe.currencyCode)}</dd></div>
        <div><dt>{fa ? "خروجی" : "Money out"}</dt><dd dir="ltr">{money(safe.balance.outflows, safe.currencyCode)}</dd></div>
        <div><dt>{fa ? "آخرین حرکت" : "Last movement"}</dt><dd dir="ltr">{safe.balance.lastMovementDate ?? "—"}</dd></div>
      </dl>

      <p className="safe-opening-state">
        {safe.openingBalance
          ? <>{fa ? "موجودی افتتاحیه ثبت شد: " : "Opening balance recorded: "}<strong dir="ltr">{money(safe.openingBalance.amount, safe.openingBalance.currencyCode)}</strong>
            {fa ? " به تاریخ " : " as of "}<span dir="ltr">{safe.openingBalance.asOfDate}</span>
            {safe.openingBalance.reference ? <> · {safe.openingBalance.reference}</> : null}
            {safe.openingBalance.reversal ? <> — {fa ? "برگشت شد به تاریخ " : "reversed on "}<span dir="ltr">{safe.openingBalance.reversal.date}</span>
              {" · "}<span dir="ltr">{safe.openingBalance.reversal.reference}</span>{" · "}{safe.openingBalance.reversal.reason}{". "}
              {fa ? "موجودی افتتاحیهٔ مؤثر: " : "Effective opening balance: "}<strong dir="ltr">{money(safe.balance.opening, safe.currencyCode)}</strong></> : null}</>
          : (fa ? "هنوز موجودی افتتاحیه ثبت نشده است." : "No opening balance has been recorded yet.")}
        {canOpen && !formOpen ? <> <button className="treasury-button gold" type="button" onClick={toggleForm}>{fa ? "ثبت موجودی افتتاحیه" : "Set opening balance"}</button></> : null}
      </p>

      {canOpen && formOpen ? <OpeningBalanceForm safe={safe} today={workspace.today} baseCurrency={workspace.baseCurrency} fa={fa} busy={busy} post={post}
        close={closeForm} /> : null}

      {moneyKinds.length > 0 ? (
        <div className="money-actions" role="group" aria-label={fa ? `حرکت پول — ${name}` : `Move money — ${name}`}>
          {moneyKinds.map((kind) => (
            <button key={kind} className={`treasury-button${moneyKind === kind ? " gold" : ""}`} type="button" aria-pressed={moneyKind === kind}
              onClick={() => openMoney(kind)}>{t(MONEY_ACTION_COPY[kind])}</button>))}
        </div>
      ) : null}
      {moneyOptions && moneyKind && moneyKinds.includes(moneyKind) ? (
        <MoneyMovementForm key={moneyKind} kind={moneyKind} safe={safe} options={moneyOptions} fa={fa} close={() => closeMoney(moneyKind)} done={moneyDone} />
      ) : null}

      {safe.responsibles.length > 0 || workspace.canManageSafes ? (
        <Responsibles safe={safe} workspace={workspace} fa={fa} busy={busy} post={post} />
      ) : null}

      {safe.legacyLink ? <p className="admin-hint">{fa
        ? `همان صندوق در سوابق قدیمی: «${safe.legacyLink.locationName}» (فقط برای مشاهده؛ هیچ موجودی از آن ساخته نمی‌شود).`
        : `Same Safe in the old records: “${safe.legacyLink.locationName}” (for reference only; no balance is taken from it).`}</p> : null}

      <h3>{fa ? "حرکات اخیر" : "Recent movements"}</h3>
      {safe.movements.length === 0 ? <p>{fa ? "هنوز حرکتی ثبت نشده است." : "No movement has been recorded yet."}</p> : (
        <div className="table-scroll"><table className="rates-table safe-movements"><thead><tr>
          <th>{fa ? "تاریخ" : "Date"}</th>
          <th>{fa ? "ورودی / خروجی" : "In / out"}</th>
          <th>{fa ? "مبلغ" : "Amount"}</th>
          <th>{fa ? "نوع" : "What"}</th>
          <th>{fa ? "مرجع" : "Reference"}</th>
        </tr></thead><tbody>{safe.movements.map((movement) => (
          <tr key={`${movement.journalId}-${movement.direction}`}>
            <td dir="ltr">{movement.date}</td>
            <td><span className={`safe-direction ${movement.direction === "IN" ? "in" : "out"}`}>{movement.direction === "IN" ? (fa ? "ورودی" : "In") : (fa ? "خروجی" : "Out")}</span></td>
            <td dir="ltr">{money(movement.amount, safe.currencyCode)}</td>
            <td>{t(SOURCE_COPY[movement.sourceType] ?? { en: "Other", fa: "دیگر" })}</td>
            <td>{movement.restricted
              ? <span className="admin-hint">{fa ? "جزئیات خارج از محدودهٔ شما" : "Details outside your scope"}</span>
              : workspace.canOpenLedger && movement.reference
                ? <Link href="/finance/general-ledger" dir="ltr">{movement.reference}</Link>
                : <span dir="ltr">{movement.reference ?? "—"}</span>}</td>
          </tr>))}</tbody></table></div>
      )}
    </section>
  );
}

function OpeningBalanceForm({ safe, today, baseCurrency, fa, busy, post, close }: Readonly<{
  safe: SafeView; today: string; baseCurrency: string | null; fa: boolean; busy: boolean;
  post: (body: Record<string, unknown>, done: Copy) => Promise<boolean>; close: () => void;
}>) {
  const [amount, setAmount] = useState("");
  const [asOfDate, setAsOfDate] = useState(today);
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  // One request identity per filled-in form: a retry after an unknown outcome replays instead of doubling.
  const [identity, setIdentity] = useState(requestIdentity);
  const change = <T,>(set: (value: T) => void) => (value: T) => { set(value); setIdentity(requestIdentity()); };
  const [fx, setFx] = useState<FxChoice>({ exchangeRateId: null, ready: true });
  const valid = AMOUNT.test(amount.trim()) && /[1-9]/.test(amount) && asOfDate !== "" && asOfDate <= today && fx.ready;
  const label = fa ? `موجودی افتتاحیهٔ ${localizedName(safe, fa)}` : `Opening balance of ${localizedName(safe, fa)}`;
  return (
    <form className="admin-form expense-form safe-opening-form" aria-label={label}
      onSubmit={async (event) => {
        event.preventDefault();
        if (!valid) return;
        const ok = await post({ action: "record-opening-balance", treasuryAccountId: safe.id, amount: amount.trim(),
          currencyCode: safe.currencyCode, asOfDate, reference: reference.trim() || null, note: note.trim() || null,
          exchangeRateId: fx.exchangeRateId, ...identity },
        { en: "Opening balance recorded. The Safe now shows its real book balance.", fa: "موجودی افتتاحیه ثبت شد. صندوق اکنون موجودی واقعی دفتری خود را نشان می‌دهد." });
        if (ok) close();
      }}>
      <label><span>{fa ? "مبلغ *" : "Amount *"}</span>
        <input inputMode="decimal" dir="ltr" value={amount} required autoComplete="off"
          onChange={(event) => change(setAmount)(event.target.value)} /></label>
      <label><span>{fa ? "واحد پول" : "Currency"}</span>
        <input dir="ltr" value={safe.currencyCode} readOnly aria-readonly="true" /></label>
      <label><span>{fa ? "به تاریخ *" : "As of *"}</span>
        <input type="date" dir="ltr" value={asOfDate} max={today} required onChange={(event) => change(setAsOfDate)(event.target.value)} /></label>
      <FxConversionField currency={safe.currencyCode} baseCurrency={baseCurrency} date={asOfDate} amount={amount} fa={fa} onChange={setFx} />
      <label><span>{fa ? "مرجع (اختیاری)" : "Reference (optional)"}</span>
        <input value={reference} maxLength={120} onChange={(event) => change(setReference)(event.target.value)} /></label>
      <label className="wide"><span>{fa ? "یادداشت (اختیاری)" : "Note (optional)"}</span>
        <textarea value={note} maxLength={1000} rows={2} onChange={(event) => change(setNote)(event.target.value)} /></label>
      <p className="admin-hint wide">{fa
        ? "پس از ذخیره، این مبلغ در دفاتر ثبت می‌شود و قابل ویرایش نیست؛ اشتباه با برگشت اصلاح می‌شود."
        : "Once saved, this amount is recorded in the books and cannot be edited; a mistake is corrected by reversal."}</p>
      <div className="admin-form-actions wide">
        <button className="treasury-button gold" type="submit" disabled={busy || !valid}>{busy ? (fa ? "در حال ذخیره…" : "Saving…") : (fa ? "ذخیره" : "Save")}</button>
        <button className="treasury-button" type="button" onClick={close} disabled={busy}>{fa ? "لغو" : "Cancel"}</button>
      </div>
    </form>
  );
}

function Responsibles({ safe, workspace, fa, busy, post }: Readonly<{
  safe: SafeView; workspace: Workspace; fa: boolean; busy: boolean;
  post: (body: Record<string, unknown>, done: Copy) => Promise<boolean>;
}>) {
  const [editing, setEditing] = useState(false);
  const [chosen, setChosen] = useState<readonly string[]>(safe.responsibles.map((person) => person.userAccountId));
  const names = safe.responsibles.map((person) => person.displayName).join(", ");
  return (
    <div className="safe-responsibles">
      <p><strong>{fa ? "مسئولان: " : "Responsible: "}</strong>{names || (fa ? "تعیین نشده (اختیاری)" : "Not assigned (optional)")}
        {workspace.canManageSafes && safe.status !== "CLOSED" && !editing
          ? <> <button className="treasury-button" type="button" onClick={() => setEditing(true)}>{fa ? "تغییر" : "Change"}</button></> : null}</p>
      {editing ? (
        <fieldset className="admin-status-choice">
          <legend>{fa ? "چه کسانی مسئول این صندوق هستند؟" : "Who is responsible for this Safe?"}</legend>
          {workspace.assignableUsers.map((user) => (
            <label key={user.userAccountId}><input type="checkbox" checked={chosen.includes(user.userAccountId)}
              onChange={(event) => setChosen(event.target.checked ? [...chosen, user.userAccountId] : chosen.filter((id) => id !== user.userAccountId))} />
              {" "}{user.displayName}</label>))}
          <div className="admin-form-actions">
            <button className="treasury-button gold" type="button" disabled={busy} onClick={async () => {
              if (await post({ action: "set-responsibles", treasuryAccountId: safe.id, userAccountIds: chosen },
                { en: "Responsible people saved.", fa: "مسئولان ذخیره شدند." })) setEditing(false);
            }}>{fa ? "ذخیره" : "Save"}</button>
            <button className="treasury-button" type="button" disabled={busy} onClick={() => setEditing(false)}>{fa ? "لغو" : "Cancel"}</button>
          </div>
        </fieldset>
      ) : null}
    </div>
  );
}
