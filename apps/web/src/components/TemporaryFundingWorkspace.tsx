"use client";

import type {
  TemporaryFundingLifecycleStatus,
  TemporaryFundingMode,
  TemporaryFundingProviderKind,
  TemporaryFundingResult,
  TemporaryFundingSettlementView,
  TemporaryFundingView,
  TemporaryFundingWorkspace as Workspace
} from "@abos/contracts";
import { useCallback, useEffect, useState } from "react";

import { AccessGate, api, errorText } from "@/components/AdminUsersWorkspace";
import { AppIcon } from "@/components/AppIcon";
import { useLocale } from "@/components/LocaleProvider";
import { kabulToday, localizedName, money } from "@/components/OperationalFinanceShared";
import { StageZeroPageHeader } from "@/components/StageZeroWorkspace";
import type { Copy } from "@/lib/access-copy";

const AMOUNT = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;
const ENDPOINT = "/api/v1/finance/operations/temporary-funding";

const MODE_COPY: Readonly<Record<TemporaryFundingMode, Copy>> = {
  PROVIDER_PAID_EXPENSE: { en: "Paid an expense directly", fa: "مصرف را مستقیماً پرداخت کرد" },
  PROVIDER_FUNDED_SAFE: { en: "Put cash into the Safe", fa: "نقد در صندوق گذاشت" }
};

const KIND_COPY: Readonly<Record<TemporaryFundingProviderKind, Copy>> = {
  SHAREHOLDER: { en: "Shareholder", fa: "سهامدار" },
  EMPLOYEE_OFFICER: { en: "Employee or officer", fa: "کارمند یا مسئول" },
  OTHER_PERSON: { en: "Other person", fa: "شخص دیگر" },
  ORGANIZATION: { en: "Organization", fa: "سازمان" }
};

const STATUS_COPY: Readonly<Record<TemporaryFundingLifecycleStatus, Copy>> = {
  PENDING_APPROVAL: { en: "Waiting for approval", fa: "منتظر تأیید" },
  REJECTED: { en: "Rejected", fa: "رد شد" },
  CANCELLED: { en: "Cancelled", fa: "لغو شد" },
  POSTED: { en: "Owed — not repaid", fa: "بدهکار — بازپرداخت نشده" },
  PARTIALLY_SETTLED: { en: "Partly repaid", fa: "قسماً بازپرداخت شده" },
  SETTLED: { en: "Fully repaid", fa: "کاملاً بازپرداخت شده" },
  REVERSED: { en: "Reversed", fa: "برگشت داده شد" }
};

const PROVIDER_STATUS_COPY: Readonly<Record<string, Copy>> = {
  OUTSTANDING: { en: "Owed", fa: "بدهکار" },
  PARTIALLY_SETTLED: { en: "Partly repaid", fa: "قسماً بازپرداخت شده" },
  SETTLED: { en: "Repaid", fa: "بازپرداخت شده" }
};

/** Dari for the refusal codes returned by temporaryFundingErrorResponse. */
const ERROR_FA: Readonly<Record<string, string>> = {
  INSUFFICIENT_CASH: "صندوق نقد ثبت‌شده کافی برای این پرداخت ندارد. به‌جای آن تمویل موقت ثبت کنید.",
  OVER_SETTLEMENT: "این بازپرداخت بیشتر از مبلغی است که هنوز به تمویل‌کننده بدهکار هستیم.",
  HAS_SETTLEMENTS: "تمویلی که بازپرداخت دارد قابل برگشت نیست.",
  SEGREGATION_OF_DUTIES: "این تصمیم باید توسط کسی گرفته شود که از این درخواست و از تمویل‌کننده مستقل است.",
  PROVIDER_KIND_MISMATCH: "نوع تمویل‌کننده با نقش این شخص یا سازمان مطابقت ندارد.",
  BASE_CURRENCY_ONLY: "فعلاً تمویل موقت فقط به واحد پول پایه شرکت ثبت می‌شود.",
  PAYABLE_NOT_CONFIGURED: "ابتدا یک حساب بدهی فعال برای تمویل موقت انتخاب کنید.",
  POLICY_NOT_CONFIGURED: "تنظیم تأیید تمویل موقت برای این شرکت هنوز انجام نشده است.",
  PERIOD_NOT_OPEN: "هیچ دوره حسابداری باز این تاریخ را پوشش نمی‌دهد.",
  DATE_NOT_ALLOWED: "یک تاریخ بعدتر انتخاب کنید.",
  REVERSAL_PENDING: "برگشت این تمویل قبلاً منتظر تصمیم است.",
  NOT_PENDING: "این مورد دیگر در وضعیتی نیست که این کار را اجازه دهد.",
  STALE_VERSION: "کس دیگری در این میان آن را تغییر داد. دوباره بارگذاری کنید.",
  ALREADY_SUBMITTED_DIFFERENTLY: "این فورم قبلاً با جزئیات دیگری فرستاده شده است. دوباره شروع کنید.",
  IN_PROGRESS: "این درخواست هنوز در حال پردازش است. لحظه‌ای بعد دوباره تلاش کنید.",
  NOT_CREATOR: "فقط کسی که آن را ثبت کرده می‌تواند آن را لغو کند.",
  NOT_AVAILABLE: "یکی از موارد انتخاب‌شده برای شرکت شما در دسترس نیست.",
  INVALID_AMOUNT: "یک مبلغ مثبت مانند 250 یا 250.50 وارد کنید.",
  VALIDATION_FAILED: "بعضی جزئیات ناقص یا نادرست است.",
  NETWORK: "سرور در دسترس نیست. دوباره تلاش کنید؛ همان درخواست دوباره ثبت نمی‌شود."
};

function fundingError(error: { code: string; message: string }, locale: "en" | "fa"): string {
  if (locale === "fa") return ERROR_FA[error.code] ?? errorText(error, locale);
  if (error.code === "NETWORK") return "The server could not be reached. Try again; the same request will not be recorded twice.";
  return error.message || errorText(error, locale);
}

function requestIdentity() {
  return { idempotencyKey: `tf-${crypto.randomUUID()}`, correlationId: crypto.randomUUID() };
}

interface Draft {
  fundingMode: TemporaryFundingMode;
  providerKind: TemporaryFundingProviderKind;
  providerBusinessPartyId: string;
  expenseCategoryId: string;
  payeeBusinessPartyId: string;
  treasuryAccountId: string;
  businessDate: string;
  originalAmount: string;
  reference: string;
  description: string;
  note: string;
}

const EMPTY_DRAFT = (): Draft => ({
  fundingMode: "PROVIDER_PAID_EXPENSE", providerKind: "OTHER_PERSON", providerBusinessPartyId: "",
  expenseCategoryId: "", payeeBusinessPartyId: "", treasuryAccountId: "", businessDate: kabulToday(),
  originalAmount: "", reference: "", description: "", note: ""
});

/** Which live party roles fit each provider kind (the database checks the same rule on the funding date). */
function partyFits(roles: readonly string[], kind: TemporaryFundingProviderKind): boolean {
  if (kind === "SHAREHOLDER") return roles.includes("SHAREHOLDER");
  if (kind === "EMPLOYEE_OFFICER") return roles.includes("EMPLOYEE");
  return !roles.includes("SHAREHOLDER") && !roles.includes("EMPLOYEE");
}

export function TemporaryFundingWorkspace() {
  const { locale } = useLocale();
  const fa = locale === "fa";
  const t = useCallback((copy: Copy) => copy[locale], [locale]);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [gate, setGate] = useState<"signed-out" | "denied" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Copy | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [identity, setIdentity] = useState(requestIdentity);

  const apply = useCallback((result: Awaited<ReturnType<typeof api<Workspace>>>) => {
    if (!result.ok) {
      setGate(result.status === 401 ? "signed-out" : result.status === 403 ? "denied" : null);
      if (result.status !== 401 && result.status !== 403) setError(fundingError(result.error, locale));
      return;
    }
    setGate(null);
    setWorkspace(result.data);
  }, [locale]);
  const load = useCallback(async () => apply(await api<Workspace>(ENDPOINT)), [apply]);

  useEffect(() => {
    let current = true;
    void api<Workspace>(ENDPOINT).then((result) => { if (current) apply(result); });
    return () => { current = false; };
  }, [apply]);

  const run = useCallback(async (body: Record<string, unknown>, done: Copy): Promise<boolean> => {
    setBusy(true);
    setError(null);
    const result = await api<TemporaryFundingResult>(ENDPOINT, "POST", body);
    setBusy(false);
    if (!result.ok) {
      if (result.status === 401) setGate("signed-out");
      setError(fundingError(result.error, locale));
      return false;
    }
    setNotice(done);
    await load();
    return true;
  }, [load, locale]);

  if (gate) {
    return <div className="module-workspace"><AccessGate state={gate} fa={fa} what={{
      en: "Temporary funding needs a Finance role that records, approves or views temporary funding.",
      fa: "تمویل موقت به نقش مالی نیاز دارد که تمویل موقت را ثبت، تأیید یا مشاهده کند."
    }} /></div>;
  }

  const update = (changes: Partial<Draft>) => {
    setDraft((value) => ({ ...value, ...changes }));
    setIdentity(requestIdentity());
  };
  const base = workspace?.baseCurrency ?? null;
  const parties = (workspace?.options.parties ?? []).filter((party) => partyFits(party.roles, draft.providerKind));
  const safes = (workspace?.options.treasuryAccounts ?? []).filter((account) =>
    ["SAFE", "CASH_BOX", "PETTY_CASH"].includes(account.accountType));
  const amountValid = AMOUNT.test(draft.originalAmount.trim()) && /[1-9]/.test(draft.originalAmount);
  const configured = workspace?.configuration.mapping !== null && workspace?.configuration.policy !== null;
  const ready = workspace !== null && configured && base !== null && draft.providerBusinessPartyId !== "" && amountValid
    && draft.reference.trim() !== "" && draft.description.trim().length >= 3
    && (draft.fundingMode === "PROVIDER_PAID_EXPENSE" ? draft.expenseCategoryId !== "" : draft.treasuryAccountId !== "");

  const submit = async () => {
    if (!ready || base === null) return;
    const ok = await run({
      action: "create", fundingMode: draft.fundingMode, providerKind: draft.providerKind,
      providerBusinessPartyId: draft.providerBusinessPartyId,
      expenseCategoryId: draft.fundingMode === "PROVIDER_PAID_EXPENSE" ? draft.expenseCategoryId : null,
      payeeBusinessPartyId: draft.fundingMode === "PROVIDER_PAID_EXPENSE" ? draft.payeeBusinessPartyId || null : null,
      treasuryAccountId: draft.fundingMode === "PROVIDER_FUNDED_SAFE" ? draft.treasuryAccountId : null,
      businessDate: draft.businessDate, originalAmount: draft.originalAmount.trim(), currencyCode: base,
      reference: draft.reference.trim(), description: draft.description.trim(), note: draft.note.trim() || null,
      ...identity
    }, { en: "Temporary funding sent for approval. Nothing is recorded in the books until it is approved.",
      fa: "تمویل موقت برای تأیید فرستاده شد. تا تأیید نشود، چیزی در دفاتر ثبت نمی‌شود." });
    // A failed or unknown outcome keeps the same request identity, so retrying replays instead of doubling.
    if (ok) { setDraft(EMPTY_DRAFT()); setIdentity(requestIdentity()); }
  };

  return (
    <div className="module-workspace temporary-funding-workspace">
      <StageZeroPageHeader icon="coins"
        eyebrow={{ en: "Finance · Daily work", fa: "مالی · کار روزانه" }}
        title={{ en: "Temporary funding", fa: "تمویل موقت" }}
        description={{
          en: "When a person or organization pays for the company or puts cash into the Safe, the company owes it back. This is a separate debt — never shareholder capital, and never negative Safe cash.",
          fa: "وقتی یک شخص یا سازمان برای شرکت پرداخت می‌کند یا نقد در صندوق می‌گذارد، شرکت آن را بدهکار است. این یک بدهی جداگانه است — هرگز سرمایه سهامدار نیست و هرگز نقد منفی صندوق نیست."
        }} />

      {notice ? <div className="treasury-message success" role="status"><AppIcon name="shield" size={16} /><span>{t(notice)}</span>
        <button onClick={() => setNotice(null)} aria-label={fa ? "بستن" : "Dismiss"}>×</button></div> : null}
      {error ? <div className="treasury-message error" role="alert"><AppIcon name="alert" size={16} /><span>{error}</span>
        <button onClick={() => setError(null)} aria-label={fa ? "بستن" : "Dismiss"}>×</button></div> : null}

      {workspace === null ? <p className="treasury-placeholder">{fa ? "در حال بارگذاری…" : "Loading…"}</p> : <>
        <div className="tf-positions">
          <section className="module-content-card tf-panel" aria-labelledby="tf-safe-heading">
            <h2 id="tf-safe-heading"><AppIcon name="coins" size={18} /> {fa ? "صندوق فزیکی (نقد موجود)" : "Physical Safe (cash on hand)"}</h2>
            <p className="admin-hint">{fa
              ? "فقط پولی که واقعاً در صندوق گذاشته شده آن را افزایش می‌دهد. مصرفی که تمویل‌کننده مستقیماً پرداخت کرده، صندوق را تغییر نمی‌دهد."
              : "Only cash actually put into the Safe increases it. An expense the provider paid directly never changes the Safe."}</p>
            {workspace.safePositions.length === 0 ? <p>{fa ? "هیچ حساب خزانه فعالی نیست." : "No active Treasury account."}</p> : (
              <table className="rates-table"><thead><tr>
                <th>{fa ? "حساب" : "Account"}</th>
                <th>{fa ? "حرکات ثبت‌شده" : "Recorded movements"}</th>
                <th>{fa ? "از تمویل موقت" : "From temporary funding"}</th>
                <th>{fa ? "بازپرداخت‌ها" : "Repayments"}</th>
                <th>{fa ? "نقد منفی" : "Negative cash"}</th>
              </tr></thead><tbody>{workspace.safePositions.map((position) => (
                <tr key={position.treasuryAccountId}>
                  <td>{localizedName(position, fa)}</td>
                  <td dir="ltr">{position.cashControl
                    ? money(position.cashControl.recordedCash, position.currencyCode)
                    : money(position.postedMovementTotal, position.currencyCode)}</td>
                  <td dir="ltr">{money(position.temporaryFundingInflow, position.currencyCode)}</td>
                  <td dir="ltr">{money(position.temporaryFundingSettlementOutflow, position.currencyCode)}</td>
                  <td>{position.nonNegativeEnforced
                    ? (fa ? "مسدود (افتتاحیه تأیید شده)" : "Blocked (opening approved)")
                    : (fa ? "هنوز کنترل نمی‌شود — موجودی افتتاحیه تأیید نشده" : "Not yet enforced — no approved opening balance")}</td>
                </tr>))}</tbody></table>
            )}
          </section>

          <section className="module-content-card tf-panel tf-payable" aria-labelledby="tf-payable-heading">
            <h2 id="tf-payable-heading"><AppIcon name="finance" size={18} /> {fa ? "بدهی تمویل موقت (بدهکار به تمویل‌کنندگان)" : "Temporary Funding Payable (owed to providers)"}</h2>
            <p className="tf-total" dir="ltr">{base ? money(workspace.payableTotal, base) : workspace.payableTotal}</p>
            <p className="admin-hint">{fa ? "این بدهی است، نه سرمایه سهامدار." : "This is a liability, not shareholder capital."}</p>
            {workspace.providers.length === 0 ? <p>{fa ? "هنوز تمویل موقتی ثبت نشده است." : "No temporary funding has been recorded yet."}</p> : (
              <table className="rates-table"><thead><tr>
                <th>{fa ? "تمویل‌کننده" : "Provider"}</th>
                <th>{fa ? "تمویل‌شده" : "Funded"}</th>
                <th>{fa ? "بازپرداخت‌شده" : "Repaid"}</th>
                <th>{fa ? "باقی‌مانده" : "Outstanding"}</th>
                <th>{fa ? "وضعیت" : "Status"}</th>
              </tr></thead><tbody>{workspace.providers.map((provider) => (
                <tr key={provider.businessPartyId}>
                  <td>{provider.name}<br /><small>{provider.providerKinds.map((kind) => t(KIND_COPY[kind])).join(" · ")}</small></td>
                  <td dir="ltr">{money(provider.fundedAmount, base ?? "")}</td>
                  <td dir="ltr">{money(provider.settledAmount, base ?? "")}</td>
                  <td dir="ltr"><strong>{money(provider.outstandingAmount, base ?? "")}</strong></td>
                  <td><span className="treasury-chip">{t(PROVIDER_STATUS_COPY[provider.status] ?? { en: provider.status, fa: provider.status })}</span></td>
                </tr>))}</tbody></table>
            )}
          </section>
        </div>

        {!configured ? (
          <div className="state-panel" role="status"><span className="state-panel-icon" aria-hidden="true">!</span><div>
            <h3>{fa ? "تمویل موقت هنوز آماده نیست" : "Temporary funding is not ready yet"}</h3>
            <ul className="expense-gaps">
              {workspace.configuration.mapping === null ? <li>{fa ? "حساب بدهی تمویل موقت انتخاب نشده است." : "The temporary funding liability account has not been chosen."}</li> : null}
              {workspace.configuration.policy === null ? <li>{fa ? "تنظیم تأیید «تمویل موقت» هنوز انجام نشده است (مدیر سیستم)." : "The “Temporary funding” approval setting has not been saved yet (System Administrator)."}</li> : null}
            </ul></div></div>
        ) : null}

        {workspace.permissions.canConfigure ? <ConfigurePayable workspace={workspace} fa={fa} busy={busy} run={run} /> : null}

        {workspace.permissions.canCreate && configured ? (
          <section className="module-content-card expense-entry">
            <h2>{fa ? "ثبت تمویل موقت" : "Record temporary funding"}</h2>
            <form className="admin-form expense-form" aria-label={fa ? "ثبت تمویل موقت" : "Record temporary funding"}
              onSubmit={(event) => { event.preventDefault(); void submit(); }}>
              <fieldset className="admin-status-choice">
                <legend>{fa ? "تمویل‌کننده چه کرد؟ *" : "What did the provider do? *"}</legend>
                {(Object.keys(MODE_COPY) as TemporaryFundingMode[]).map((mode) => (
                  <label key={mode}><input type="radio" name="tf-mode" checked={draft.fundingMode === mode}
                    onChange={() => update({ fundingMode: mode })} /> {t(MODE_COPY[mode])}</label>))}
              </fieldset>
              <label><span>{fa ? "نوع تمویل‌کننده *" : "Provider type *"}</span>
                <select value={draft.providerKind} onChange={(event) => update({
                  providerKind: event.target.value as TemporaryFundingProviderKind, providerBusinessPartyId: "" })}>
                  {(Object.keys(KIND_COPY) as TemporaryFundingProviderKind[]).map((kind) =>
                    <option key={kind} value={kind}>{t(KIND_COPY[kind])}</option>)}
                </select></label>
              <label><span>{fa ? "تمویل‌کننده *" : "Provider *"}</span>
                <select value={draft.providerBusinessPartyId} required onChange={(event) => update({ providerBusinessPartyId: event.target.value })}>
                  <option value="">{fa ? "انتخاب کنید" : "Choose"}</option>
                  {parties.map((party) => <option key={party.id} value={party.id}>{party.name}</option>)}
                </select></label>
              {draft.fundingMode === "PROVIDER_PAID_EXPENSE" ? <>
                <label><span>{fa ? "نوع مصرف *" : "Expense type *"}</span>
                  <select value={draft.expenseCategoryId} required onChange={(event) => update({ expenseCategoryId: event.target.value })}>
                    <option value="">{fa ? "انتخاب کنید" : "Choose"}</option>
                    {workspace.options.expenseCategories.map((category) =>
                      <option key={category.id} value={category.id}>{localizedName(category, fa)}</option>)}
                  </select></label>
                <label><span>{fa ? "پرداخت به (اختیاری)" : "Paid to (optional)"}</span>
                  <select value={draft.payeeBusinessPartyId} onChange={(event) => update({ payeeBusinessPartyId: event.target.value })}>
                    <option value="">—</option>
                    {workspace.options.parties.map((party) => <option key={party.id} value={party.id}>{party.name}</option>)}
                  </select></label>
                <p className="admin-hint">{fa ? "صندوق تغییر نمی‌کند؛ مصرف ثبت می‌شود و مبلغ به تمویل‌کننده بدهکار می‌شود." : "The Safe does not change; the expense is recorded and the amount is owed to the provider."}</p>
              </> : <>
                <label><span>{fa ? "کدام صندوق؟ *" : "Which Safe? *"}</span>
                  <select value={draft.treasuryAccountId} required onChange={(event) => update({ treasuryAccountId: event.target.value })}>
                    <option value="">{fa ? "انتخاب کنید" : "Choose"}</option>
                    {safes.map((account) => <option key={account.id} value={account.id}>{localizedName(account, fa)}</option>)}
                  </select></label>
                <p className="admin-hint">{fa ? "نقد صندوق افزایش می‌یابد و همان مبلغ به تمویل‌کننده بدهکار می‌شود. مصرف بعدی به‌طور عادی ثبت می‌شود." : "Safe cash increases and the same amount is owed to the provider. A later expense is recorded the normal way."}</p>
              </>}
              <label><span>{fa ? "تاریخ *" : "Date *"}</span>
                <input type="date" value={draft.businessDate} required onChange={(event) => update({ businessDate: event.target.value })} /></label>
              <label><span>{fa ? `مبلغ (${base ?? ""}) *` : `Amount (${base ?? ""}) *`}</span>
                <input inputMode="decimal" dir="ltr" autoComplete="off" value={draft.originalAmount} placeholder="0.00" required
                  onChange={(event) => update({ originalAmount: event.target.value })} /></label>
              <label><span>{fa ? "شماره رسید یا مرجع *" : "Receipt or reference number *"}</span>
                <input value={draft.reference} maxLength={120} required onChange={(event) => update({ reference: event.target.value })} /></label>
              <label><span>{fa ? "برای چه بود؟ *" : "What was it for? *"}</span>
                <input value={draft.description} minLength={3} maxLength={500} required onChange={(event) => update({ description: event.target.value })} /></label>
              <label><span>{fa ? "یادداشت (اختیاری)" : "Note (optional)"}</span>
                <textarea value={draft.note} maxLength={1000} rows={2} onChange={(event) => update({ note: event.target.value })} /></label>
              <button type="submit" className="treasury-button gold" disabled={busy || !ready}>
                {busy ? (fa ? "در حال فرستادن…" : "Sending…") : (fa ? "فرستادن برای تأیید" : "Send for approval")}</button>
            </form>
          </section>
        ) : null}

        <section className="module-content-card">
          <h2>{fa ? "تمویل‌ها" : "Fundings"}</h2>
          {workspace.fundings.length === 0 ? <p>{fa ? "چیزی برای نمایش نیست." : "Nothing to show yet."}</p> : (
            <ul className="tf-list">{workspace.fundings.map((funding) => (
              <FundingCard key={funding.id} funding={funding} workspace={workspace} fa={fa} busy={busy} run={run} />))}</ul>
          )}
        </section>
      </>}
    </div>
  );
}

type Run = (body: Record<string, unknown>, done: Copy) => Promise<boolean>;

function ConfigurePayable({ workspace, fa, busy, run }: { workspace: Workspace; fa: boolean; busy: boolean; run: Run }) {
  const current = workspace.configuration.mapping;
  const [ledger, setLedger] = useState("");
  const [reason, setReason] = useState("");
  return (
    <section className="module-content-card">
      <h2>{fa ? "حساب بدهی تمویل موقت" : "Temporary funding liability account"}</h2>
      <p>{current ? `${current.payableLedgerAccount.code} · ${current.payableLedgerAccount.name} (v${current.version})`
        : (fa ? "انتخاب نشده" : "Not chosen")}</p>
      <form className="admin-form" onSubmit={(event) => { event.preventDefault(); void run({
        action: "configure", payableLedgerAccountId: ledger, expectedVersion: current?.version ?? 0, changeReason: reason
      }, { en: "Liability account saved.", fa: "حساب بدهی ذخیره شد." }).then((ok) => { if (ok) { setLedger(""); setReason(""); } }); }}>
        <label><span>{fa ? "حساب بدهی" : "Liability account"}</span>
          <select value={ledger} onChange={(event) => setLedger(event.target.value)} required>
            <option value="">{fa ? "انتخاب کنید" : "Choose"}</option>
            {workspace.options.payableLedgerAccounts.map((account) =>
              <option key={account.id} value={account.id}>{account.code} · {account.name}</option>)}
          </select></label>
        <label><span>{fa ? "دلیل" : "Reason"}</span>
          <input value={reason} minLength={5} maxLength={500} required onChange={(event) => setReason(event.target.value)} /></label>
        <button type="submit" className="treasury-button" disabled={busy || ledger === "" || reason.trim().length < 5}>
          {fa ? "ذخیره" : "Save"}</button>
      </form>
    </section>
  );
}

function FundingCard({ funding, workspace, fa, busy, run }: {
  funding: TemporaryFundingView; workspace: Workspace; fa: boolean; busy: boolean; run: Run;
}) {
  const [note, setNote] = useState("");
  const [settleAmount, setSettleAmount] = useState("");
  const [settleAccount, setSettleAccount] = useState("");
  const [settleReference, setSettleReference] = useState("");
  const [settleDate, setSettleDate] = useState(kabulToday);
  const [settleIdentity, setSettleIdentity] = useState(requestIdentity);
  const [reversalIdentity] = useState(requestIdentity);
  const t = (copy: Copy) => (fa ? copy.fa : copy.en);
  const me = workspace.actorUserAccountId;
  const can = workspace.permissions;
  const noteOk = note.trim().length >= 5;
  const remaining = Number(funding.outstandingAmount) - Number(funding.pendingSettlementAmount);
  const reversal = funding.reversal;
  const decide = (decision: "APPROVED" | "REJECTED") => run(
    { action: "decide", temporaryFundingId: funding.id, expectedVersion: funding.version, decision, note },
    decision === "APPROVED"
      ? { en: "Approved and recorded in the books.", fa: "تأیید و در دفاتر ثبت شد." }
      : { en: "Rejected.", fa: "رد شد." });

  return (
    <li className="tf-card">
      <div className="tf-card-head">
        <strong>{funding.provider.name}</strong>
        <span className="treasury-chip">{t(KIND_COPY[funding.providerKind])}</span>
        <span className="treasury-chip">{t(MODE_COPY[funding.fundingMode])}</span>
        <span className="treasury-chip tf-status">{t(STATUS_COPY[funding.lifecycleStatus])}</span>
      </div>
      <p dir="auto">{funding.businessDate} · {funding.reference} · {funding.description}</p>
      <p dir="ltr" className="tf-amounts">{money(funding.amount, funding.currencyCode)}
        {funding.status === "POSTED" ? ` · ${fa ? "باقی‌مانده" : "outstanding"} ${money(funding.outstandingAmount, funding.currencyCode)}` : ""}</p>
      {funding.fundingMode === "PROVIDER_PAID_EXPENSE" && funding.expenseCategory
        ? <p className="admin-hint">{fa ? "مصرف: " : "Expense: "}{localizedName(funding.expenseCategory, fa)}{funding.payee ? ` → ${funding.payee.name}` : ""}</p> : null}
      {funding.fundingMode === "PROVIDER_FUNDED_SAFE" && funding.treasuryAccount
        ? <p className="admin-hint">{fa ? "به صندوق: " : "Into: "}{localizedName(funding.treasuryAccount, fa)}</p> : null}
      {funding.decision ? <p className="admin-hint">{funding.decision.decidedBy}: {funding.decision.note}</p> : null}

      {funding.status === "PENDING_APPROVAL" ? (
        <div className="tf-actions">
          <input value={note} placeholder={fa ? "یادداشت تصمیم (حداقل ۵ حرف)" : "Decision note (at least 5 characters)"}
            onChange={(event) => setNote(event.target.value)} maxLength={500} />
          {can.canApprove && funding.createdByUserAccountId !== me && funding.providerUserAccountId !== me ? <>
            <button className="treasury-button gold" disabled={busy || !noteOk} onClick={() => void decide("APPROVED")}>{fa ? "تأیید و ثبت" : "Approve and record"}</button>
            <button className="treasury-button" disabled={busy || !noteOk} onClick={() => void decide("REJECTED")}>{fa ? "رد" : "Reject"}</button>
          </> : null}
          {funding.createdByUserAccountId === me ? (
            <button className="treasury-button" disabled={busy || !noteOk} onClick={() => void run(
              { action: "cancel", temporaryFundingId: funding.id, expectedVersion: funding.version, reason: note },
              { en: "Cancelled.", fa: "لغو شد." })}>{fa ? "لغو" : "Cancel"}</button>) : null}
        </div>
      ) : null}

      {funding.settlements.length > 0 ? (
        <ul className="tf-settlements">{funding.settlements.map((settlement) => (
          <SettlementRow key={settlement.id} settlement={settlement} workspace={workspace} fa={fa} busy={busy} run={run}
            providerUserAccountId={funding.providerUserAccountId} />))}</ul>
      ) : null}

      {funding.status === "POSTED" && can.canSettle && remaining > 0 && reversal?.status !== "REQUESTED" ? (
        <form className="tf-actions" onSubmit={(event) => { event.preventDefault(); void run({
          action: "settlement-create", temporaryFundingId: funding.id, treasuryAccountId: settleAccount,
          originalAmount: settleAmount.trim(), businessDate: settleDate, reference: settleReference.trim(), note: null,
          ...settleIdentity
        }, { en: "Repayment sent for approval.", fa: "بازپرداخت برای تأیید فرستاده شد." }).then((ok) => {
          if (ok) { setSettleAmount(""); setSettleReference(""); setSettleIdentity(requestIdentity()); } }); }}>
          <strong>{fa ? "بازپرداخت" : "Repay"}</strong>
          <select value={settleAccount} required onChange={(event) => { setSettleAccount(event.target.value); setSettleIdentity(requestIdentity()); }}>
            <option value="">{fa ? "از کدام حساب؟" : "From which account?"}</option>
            {workspace.options.treasuryAccounts.map((account) => <option key={account.id} value={account.id}>{localizedName(account, fa)}</option>)}
          </select>
          <input inputMode="decimal" dir="ltr" placeholder={`≤ ${funding.outstandingAmount}`} value={settleAmount} required
            onChange={(event) => { setSettleAmount(event.target.value); setSettleIdentity(requestIdentity()); }} />
          <input type="date" value={settleDate} required onChange={(event) => { setSettleDate(event.target.value); setSettleIdentity(requestIdentity()); }} />
          <input value={settleReference} placeholder={fa ? "مرجع" : "Reference"} maxLength={120} required
            onChange={(event) => { setSettleReference(event.target.value); setSettleIdentity(requestIdentity()); }} />
          <button type="submit" className="treasury-button" disabled={busy || settleAccount === "" || !AMOUNT.test(settleAmount.trim()) || settleReference.trim() === ""}>
            {fa ? "درخواست بازپرداخت" : "Request repayment"}</button>
        </form>
      ) : null}

      {funding.status === "POSTED" && can.canReverse && funding.settlements.every((s) => s.status === "REJECTED" || s.status === "CANCELLED") ? (
        reversal?.status === "REQUESTED" ? (
          <div className="tf-actions">
            <span>{fa ? `برگشت درخواست شد: ${reversal.reason}` : `Reversal requested: ${reversal.reason}`}</span>
            {reversal.requestedByUserAccountId !== me && funding.createdByUserAccountId !== me ? <>
              <input value={note} placeholder={fa ? "یادداشت تصمیم" : "Decision note"} onChange={(event) => setNote(event.target.value)} maxLength={500} />
              <button className="treasury-button gold" disabled={busy || !noteOk} onClick={() => void run(
                { action: "reversal-decide", reversalId: reversal.id, expectedVersion: reversal.version, decision: "APPROVED", note },
                { en: "Reversed with an exact mirror journal.", fa: "با ژورنال قرینه دقیق برگشت داده شد." })}>{fa ? "تأیید برگشت" : "Approve reversal"}</button>
              <button className="treasury-button" disabled={busy || !noteOk} onClick={() => void run(
                { action: "reversal-decide", reversalId: reversal.id, expectedVersion: reversal.version, decision: "REJECTED", note },
                { en: "Reversal rejected.", fa: "برگشت رد شد." })}>{fa ? "رد برگشت" : "Reject reversal"}</button>
            </> : null}
          </div>
        ) : (
          <div className="tf-actions">
            <input value={note} placeholder={fa ? "دلیل برگشت (حداقل ۵ حرف)" : "Reason for reversal (at least 5 characters)"}
              onChange={(event) => setNote(event.target.value)} maxLength={1000} />
            <button className="treasury-button" disabled={busy || !noteOk} onClick={() => void run({
              action: "reversal-request", temporaryFundingId: funding.id, reversalDate: kabulToday(), reason: note, ...reversalIdentity
            }, { en: "Reversal requested.", fa: "برگشت درخواست شد." })}>{fa ? "درخواست برگشت" : "Request reversal"}</button>
          </div>
        )
      ) : null}
    </li>
  );
}

function SettlementRow({ settlement, workspace, fa, busy, run, providerUserAccountId }: {
  settlement: TemporaryFundingSettlementView; workspace: Workspace; fa: boolean; busy: boolean; run: Run;
  providerUserAccountId: string | null;
}) {
  const [note, setNote] = useState("");
  const me = workspace.actorUserAccountId;
  const status: Copy = settlement.status === "POSTED" ? { en: "Repaid", fa: "پرداخت شد" }
    : settlement.status === "PENDING_APPROVAL" ? { en: "Waiting for approval", fa: "منتظر تأیید" }
      : settlement.status === "REJECTED" ? { en: "Rejected", fa: "رد شد" } : { en: "Cancelled", fa: "لغو شد" };
  const decide = (decision: "APPROVED" | "REJECTED") => run(
    { action: "settlement-decide", settlementId: settlement.id, expectedVersion: settlement.version, decision, note },
    decision === "APPROVED" ? { en: "Repayment approved and paid.", fa: "بازپرداخت تأیید و پرداخت شد." } : { en: "Repayment rejected.", fa: "بازپرداخت رد شد." });
  return (
    <li>
      <span dir="ltr">{money(settlement.amount, settlement.currencyCode)}</span> · {settlement.businessDate} · {localizedName(settlement.treasuryAccount, fa)}
      {" "}<span className="treasury-chip">{fa ? status.fa : status.en}</span>
      {settlement.status === "PENDING_APPROVAL" ? (
        <span className="tf-actions">
          <input value={note} placeholder={fa ? "یادداشت" : "Note"} onChange={(event) => setNote(event.target.value)} maxLength={500} />
          {workspace.permissions.canApproveSettlement && settlement.createdByUserAccountId !== me && providerUserAccountId !== me ? <>
            <button className="treasury-button gold" disabled={busy || note.trim().length < 5} onClick={() => void decide("APPROVED")}>{fa ? "تأیید" : "Approve"}</button>
            <button className="treasury-button" disabled={busy || note.trim().length < 5} onClick={() => void decide("REJECTED")}>{fa ? "رد" : "Reject"}</button>
          </> : null}
          {settlement.createdByUserAccountId === me ? (
            <button className="treasury-button" disabled={busy || note.trim().length < 5} onClick={() => void run(
              { action: "settlement-cancel", settlementId: settlement.id, expectedVersion: settlement.version, reason: note },
              { en: "Repayment cancelled.", fa: "بازپرداخت لغو شد." })}>{fa ? "لغو" : "Cancel"}</button>) : null}
        </span>
      ) : null}
    </li>
  );
}
