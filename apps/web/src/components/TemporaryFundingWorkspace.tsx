"use client";

import type {
  TemporaryFundingCapabilityReason,
  TemporaryFundingLifecycleStatus,
  TemporaryFundingMode,
  TemporaryFundingProviderIdentityMode,
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
const SHA256 = /^[0-9a-f]{64}$/;
const ENDPOINT = "/api/v1/finance/operations/temporary-funding";

const MODE_COPY: Readonly<Record<TemporaryFundingMode, Copy>> = {
  PROVIDER_PAID_EXPENSE_DIRECTLY: { en: "Paid an expense directly", fa: "مصرف را مستقیماً پرداخت کرد" },
  PROVIDER_FUNDED_SAFE: { en: "Put cash into the Safe", fa: "نقد در صندوق گذاشت" }
};

const MODE_EFFECT: Readonly<Record<TemporaryFundingMode, Copy>> = {
  PROVIDER_PAID_EXPENSE_DIRECTLY: { en: "Safe unchanged", fa: "صندوق بدون تغییر" },
  PROVIDER_FUNDED_SAFE: { en: "Safe funded", fa: "صندوق تمویل شد" }
};

const KIND_COPY: Readonly<Record<TemporaryFundingProviderKind, Copy>> = {
  SHAREHOLDER: { en: "Shareholder", fa: "سهامدار" },
  EMPLOYEE: { en: "Employee", fa: "کارمند" },
  EXTERNAL_OTHER: { en: "Other person or organization", fa: "شخص یا سازمان دیگر" }
};

const IDENTITY_MODE_COPY: Readonly<Record<TemporaryFundingProviderIdentityMode, Copy>> = {
  ABOS_USER: { en: "Uses ABOS as", fa: "از ABOS استفاده می‌کند به‌عنوان" },
  NO_ABOS_USER: { en: "Does not use ABOS", fa: "از ABOS استفاده نمی‌کند" }
};

const VAULT_NOTE: Copy = {
  en: "The file is only fingerprinted (SHA-256) in your browser. It is not uploaded and is not kept in the ABOS document vault; keep the original safely.",
  fa: "فایل فقط در مرورگر شما اثر انگشت (SHA-256) گرفته می‌شود. فرستاده نمی‌شود و در گنجینه اسناد ABOS نگه داشته نمی‌شود؛ اصل آن را با احتیاط نگه دارید."
};

const STATUS_COPY: Readonly<Record<TemporaryFundingLifecycleStatus, Copy>> = {
  PENDING_APPROVAL: { en: "Waiting for approval", fa: "منتظر تأیید" },
  REJECTED: { en: "Rejected", fa: "رد شد" },
  POSTED: { en: "Owed — not repaid", fa: "بدهکار — بازپرداخت نشده" },
  PARTIALLY_SETTLED: { en: "Partly repaid", fa: "قسماً بازپرداخت شده" },
  SETTLED: { en: "Fully repaid", fa: "کاملاً بازپرداخت شده" }
};

const PROVIDER_STATUS_COPY: Readonly<Record<string, Copy>> = {
  OUTSTANDING: { en: "Owed", fa: "بدهکار" },
  PARTIALLY_SETTLED: { en: "Partly repaid", fa: "قسماً بازپرداخت شده" },
  SETTLED: { en: "Repaid", fa: "بازپرداخت شده" }
};

const SETTLEMENT_STATUS_COPY: Readonly<Record<TemporaryFundingSettlementView["status"], Copy>> = {
  PENDING_APPROVAL: { en: "Waiting for approval", fa: "منتظر تأیید" },
  REJECTED: { en: "Rejected", fa: "رد شد" },
  POSTED: { en: "Repaid", fa: "پرداخت شد" }
};

const CAPABILITY_COPY: Readonly<Record<TemporaryFundingCapabilityReason, Copy>> = {
  BASE_CURRENCY_NOT_APPROVED: { en: "The company's base currency is not approved yet.", fa: "واحد پول پایه شرکت هنوز تصویب نشده است." },
  POLICY_NOT_CONFIGURED: { en: "The “Temporary funding” approval setting has not been saved yet (System Administrator, Workflow approvals).", fa: "تنظیم تأیید «تمویل موقت» هنوز ذخیره نشده است (مدیر سیستم، تأیید جریان‌ها)." },
  APPROVAL_MUST_BE_REQUIRED: { en: "Temporary funding must require approval (System Administrator, Workflow approvals).", fa: "تمویل موقت باید تأیید لازم داشته باشد (مدیر سیستم، تأیید جریان‌ها)." },
  PAYABLE_MAPPING_NOT_CONFIGURED: { en: "The Temporary Funding Payable account has not been chosen.", fa: "حساب بدهی تمویل موقت هنوز انتخاب نشده است." },
  PAYABLE_MAPPING_INVALID: { en: "The chosen Temporary Funding Payable account is no longer active or valid.", fa: "حساب بدهی تمویل موقت انتخاب‌شده دیگر فعال یا معتبر نیست." }
};

/** Dari for the refusal codes returned by temporaryFundingErrorResponse. */
const ERROR_FA: Readonly<Record<string, string>> = {
  OVER_SETTLEMENT: "این بازپرداخت بیشتر از مبلغی است که هنوز به تمویل‌کننده بدهکار هستیم.",
  SEGREGATION_OF_DUTIES: "این تصمیم باید توسط کسی گرفته شود که از ثبت‌کننده و از تمویل‌کننده مستقل است.",
  PROVIDER_KIND_MISMATCH: "نقش‌های تمویل‌کننده تغییر کرده است. دوباره بارگذاری کنید و آن را ثبت کنید.",
  PROVIDER_IDENTITY_MISSING: "ابتدا مدیر ارشد باید ثبت کند که آیا این تمویل‌کننده از ABOS استفاده می‌کند.",
  PROVIDER_IDENTITY_INVALID: "هویت ABOS این تمویل‌کننده دیگر معتبر نیست. مدیر ارشد باید آن را بررسی کند.",
  PROVIDER_IDENTITY_AMBIGUOUS: "این کاربر ABOS قبلاً هویت تمویل‌کننده دیگری است.",
  PROVIDER_USER_INVALID: "یک کاربر فعال ABOS این شرکت را انتخاب کنید.",
  BASE_CURRENCY_ONLY: "فعلاً تمویل موقت فقط به واحد پول پایه شرکت ثبت می‌شود.",
  PAYABLE_NOT_CONFIGURED: "ابتدا یک حساب بدهی تمویل موقت فعال به واحد پول پایه انتخاب کنید.",
  EVIDENCE_REQUIRED: "مرجع سند صلاحیت، اثر انگشت SHA-256 آن و دلیل را وارد کنید.",
  APPROVAL_REQUIRED: "تمویل موقت باید تأیید لازم داشته باشد. از مدیر سیستم بخواهید آن را در تأیید جریان‌ها تنظیم کند.",
  PERIOD_NOT_OPEN: "هیچ سال مالی این تاریخ را پوشش نمی‌دهد. نخست سال مالی را تنظیم کنید.",
  PERIOD_CLOSED: "سال مالی این تاریخ بسته است. تاریخی در سال مالی فعال انتخاب کنید.",
  DATE_NOT_ALLOWED: "بازپرداخت نمی‌تواند قبل از تاریخ تمویل باشد.",
  TREASURY_UNAVAILABLE: "یک صندوق یا حساب بانکی فعال به واحد پول پایه انتخاب کنید.",
  NOT_PENDING: "این مورد دیگر در وضعیتی نیست که این کار را اجازه دهد.",
  STALE_VERSION: "کس دیگری در این میان آن را تغییر داد. دوباره بارگذاری کنید.",
  ALREADY_SUBMITTED_DIFFERENTLY: "این فورم قبلاً با جزئیات دیگری فرستاده شده است. دوباره شروع کنید.",
  NOT_AVAILABLE: "یکی از موارد انتخاب‌شده برای شرکت شما در دسترس نیست.",
  DIMENSION_REQUIRED: "این نوع مصرف به پروژه، بخش یا مرکز هزینه‌ای نیاز دارد که با آن کار می‌کنید.",
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
  providerBusinessPartyId: string;
  expenseCategoryId: string;
  payeeBusinessPartyId: string;
  treasuryAccountId: string;
  businessDate: string;
  amount: string;
  reference: string;
  description: string;
  note: string;
}

const EMPTY_DRAFT = (): Draft => ({
  fundingMode: "PROVIDER_PAID_EXPENSE_DIRECTLY", providerBusinessPartyId: "", expenseCategoryId: "", payeeBusinessPartyId: "", treasuryAccountId: "",
  businessDate: kabulToday(), amount: "", reference: "", description: "", note: ""
});

type Run = (body: Record<string, unknown>, done: Copy) => Promise<boolean>;

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

  const run: Run = useCallback(async (body, done) => {
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
      en: "Temporary funding needs a Finance role that records, approves, repays or views temporary funding.",
      fa: "تمویل موقت به نقش مالی نیاز دارد که تمویل موقت را ثبت، تأیید، بازپرداخت یا مشاهده کند."
    }} /></div>;
  }

  const update = (changes: Partial<Draft>) => {
    setDraft((value) => ({ ...value, ...changes }));
    setIdentity(requestIdentity());
  };
  const base = workspace?.baseCurrency ?? null;
  const operational = workspace?.capability.state === "OPERATIONAL";
  // Only providers whose identity a Super Administrator has recorded can fund; their type comes from company records.
  const parties = (workspace?.options.parties ?? []).filter((party) => party.identity !== null);
  const provider = parties.find((party) => party.id === draft.providerBusinessPartyId);
  const amountValid = AMOUNT.test(draft.amount.trim()) && /[1-9]/.test(draft.amount);
  const ready = operational && base !== null && provider !== undefined && amountValid
    && draft.reference.trim() !== "" && draft.description.trim().length >= 3
    && (draft.fundingMode === "PROVIDER_PAID_EXPENSE_DIRECTLY" ? draft.expenseCategoryId !== "" : draft.treasuryAccountId !== "");

  const submit = async () => {
    if (!ready || base === null || provider === undefined) return;
    const ok = await run({
      action: "record", fundingMode: draft.fundingMode, providerKind: provider.providerKind,
      providerBusinessPartyId: provider.id,
      expenseCategoryId: draft.fundingMode === "PROVIDER_PAID_EXPENSE_DIRECTLY" ? draft.expenseCategoryId : null,
      payeeBusinessPartyId: draft.fundingMode === "PROVIDER_PAID_EXPENSE_DIRECTLY" ? draft.payeeBusinessPartyId || null : null,
      treasuryAccountId: draft.fundingMode === "PROVIDER_FUNDED_SAFE" ? draft.treasuryAccountId : null,
      businessDate: draft.businessDate, amount: { amount: draft.amount.trim(), currency: base },
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
        {!operational && workspace.capability.reason ? (
          <div className="state-panel" role="status"><span className="state-panel-icon" aria-hidden="true">!</span><div>
            <h3>{fa ? "تمویل موقت هنوز آماده نیست" : "Temporary funding is not ready yet"}</h3>
            <p className="expense-gaps">{t(CAPABILITY_COPY[workspace.capability.reason])}</p></div></div>
        ) : null}

        <div className="tf-positions">
          <section className="module-content-card tf-panel" aria-labelledby="tf-safe-heading">
            <h2 id="tf-safe-heading"><AppIcon name="coins" size={18} /> {fa ? "صندوق فزیکی (حرکات نقد)" : "Physical Safe (cash movements)"}</h2>
            <p className="admin-hint">{fa
              ? "فقط پولی که واقعاً در صندوق گذاشته شده آن را افزایش می‌دهد. مصرفی که تمویل‌کننده مستقیماً پرداخت کرده، صندوق را تغییر نمی‌دهد. موجودی دفتری همهٔ حرکات ثبت‌شدهٔ صندوق، از جمله موجودی افتتاحیه، را حساب می‌کند."
              : "Only cash actually put into the Safe increases it. An expense the provider paid directly never changes the Safe. The book balance counts every recorded movement of the Safe, including its opening balance."}</p>
            {workspace.safePositions.length === 0 ? <p>{fa ? "هیچ حساب خزانه فعالی نیست." : "No active Treasury account."}</p> : (
              <table className="rates-table"><thead><tr>
                <th>{fa ? "حساب" : "Account"}</th>
                <th>{fa ? "موجودی دفتری" : "Book balance"}</th>
                <th>{fa ? "از تمویل موقت" : "From temporary funding"}</th>
                <th>{fa ? "بازپرداخت‌ها" : "Repayments"}</th>
              </tr></thead><tbody>{workspace.safePositions.map((position) => (
                <tr key={position.treasuryAccountId}>
                  <td>{localizedName(position, fa)}</td>
                  <td dir="ltr">{money(position.postedMovementTotal, position.currencyCode)}</td>
                  <td dir="ltr">{money(position.temporaryFundingInflow, position.currencyCode)}</td>
                  <td dir="ltr">{money(position.temporaryFundingSettlementOutflow, position.currencyCode)}</td>
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

        {workspace.permissions.canConfigure ? <ConfigurePayable workspace={workspace} fa={fa} busy={busy} run={run} /> : null}
        {workspace.permissions.canConfigureProviderIdentity
          ? <ConfigureProviderIdentity workspace={workspace} fa={fa} busy={busy} run={run} /> : null}

        {workspace.permissions.canRecord && operational ? (
          <section className="module-content-card expense-entry">
            <h2>{fa ? "ثبت تمویل موقت" : "Record temporary funding"}</h2>
            <form className="admin-form expense-form" aria-label={fa ? "ثبت تمویل موقت" : "Record temporary funding"}
              onSubmit={(event) => { event.preventDefault(); void submit(); }}>
              <fieldset className="admin-status-choice">
                <legend>{fa ? "تمویل‌کننده چه کرد؟ *" : "What did the provider do? *"}</legend>
                {(Object.keys(MODE_COPY) as TemporaryFundingMode[]).map((mode) => (
                  <label key={mode}><input type="radio" name="tf-mode" aria-label={t(MODE_COPY[mode])}
                    checked={draft.fundingMode === mode} onChange={() => update({ fundingMode: mode })} />
                    {" "}{t(MODE_COPY[mode])} — <strong>{t(MODE_EFFECT[mode])}</strong></label>))}
              </fieldset>
              <label><span>{fa ? "تمویل‌کننده *" : "Provider *"}</span>
                <select value={draft.providerBusinessPartyId} required onChange={(event) => update({ providerBusinessPartyId: event.target.value })}>
                  <option value="">{fa ? "انتخاب کنید" : "Choose"}</option>
                  {parties.map((party) => <option key={party.id} value={party.id}>{party.name}</option>)}
                </select></label>
              {provider ? <p className="admin-hint">{fa ? "نوع (از سوابق شرکت): " : "Type (from company records): "}
                <strong>{t(KIND_COPY[provider.providerKind])}</strong>{" · "}
                {provider.identity?.mode === "ABOS_USER"
                  ? `${t(IDENTITY_MODE_COPY.ABOS_USER)} ${provider.identity.userName ?? ""} — ${fa ? "هرگز نمی‌تواند این تمویل را تأیید کند" : "can never approve this funding"}`
                  : t(IDENTITY_MODE_COPY.NO_ABOS_USER)}</p> : null}
              {parties.length === 0 ? <p className="admin-hint expense-warning">{fa
                ? "تمویل‌کنندگان پس از آن نشان داده می‌شوند که مدیر ارشد ثبت کند آیا از ABOS استفاده می‌کنند."
                : "Providers appear here after a Super Administrator records whether they use ABOS."}</p> : null}
              {draft.fundingMode === "PROVIDER_PAID_EXPENSE_DIRECTLY" ? <>
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
                <p className="admin-hint tf-effect">{fa ? "صندوق بدون تغییر: مصرف ثبت می‌شود و مبلغ به تمویل‌کننده بدهکار می‌شود." : "Safe unchanged: the expense is recorded and the amount is owed to the provider."}</p>
              </> : <>
                <label><span>{fa ? "کدام صندوق؟ *" : "Which Safe? *"}</span>
                  <select value={draft.treasuryAccountId} required onChange={(event) => update({ treasuryAccountId: event.target.value })}>
                    <option value="">{fa ? "انتخاب کنید" : "Choose"}</option>
                    {workspace.options.safeAccounts.map((account) => <option key={account.id} value={account.id}>{localizedName(account, fa)}</option>)}
                  </select></label>
                <p className="admin-hint tf-effect">{fa ? "صندوق تمویل شد: نقد صندوق دقیقاً به همین مبلغ افزایش می‌یابد و همان مبلغ به تمویل‌کننده بدهکار می‌شود." : "Safe funded: Safe cash increases by exactly this amount and the same amount is owed to the provider."}</p>
              </>}
              <label><span>{fa ? "تاریخ *" : "Date *"}</span>
                <input type="date" value={draft.businessDate} required onChange={(event) => update({ businessDate: event.target.value })} /></label>
              <label><span>{fa ? `مبلغ (${base ?? ""}) *` : `Amount (${base ?? ""}) *`}</span>
                <input inputMode="decimal" dir="ltr" autoComplete="off" value={draft.amount} placeholder="0.00" required
                  onChange={(event) => update({ amount: event.target.value })} /></label>
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
              <FundingCard key={`${funding.id}-${funding.version}-${funding.settlements.length}`} funding={funding}
                workspace={workspace} fa={fa} busy={busy} run={run} />))}</ul>
          )}
        </section>
      </>}
    </div>
  );
}

async function sha256Hex(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Super Administrator only: whether a provider uses ABOS, and as which user (never approves their funding). */
function ConfigureProviderIdentity({ workspace, fa, busy, run }: { workspace: Workspace; fa: boolean; busy: boolean; run: Run }) {
  const t = (copy: Copy) => (fa ? copy.fa : copy.en);
  const [partyId, setPartyId] = useState("");
  const [mode, setMode] = useState<TemporaryFundingProviderIdentityMode>("NO_ABOS_USER");
  const [userId, setUserId] = useState("");
  const [reference, setReference] = useState("");
  const [sha, setSha] = useState("");
  const [reason, setReason] = useState("");
  const [identity, setIdentity] = useState(requestIdentity);
  const party = workspace.options.parties.find((item) => item.id === partyId);
  const touch = () => setIdentity(requestIdentity());
  const ready = party !== undefined && (mode === "NO_ABOS_USER" || userId !== "") && reference.trim() !== ""
    && SHA256.test(sha) && reason.trim().length >= 3;
  return (
    <section className="module-content-card">
      <h2>{fa ? "هویت ABOS تمویل‌کنندگان" : "Provider ABOS identities"}</h2>
      <p className="admin-hint">{fa
        ? "فقط مدیر ارشد. کاربری که اینجا برای تمویل‌کننده ثبت می‌شود هرگز نمی‌تواند تمویل یا بازپرداخت آن تمویل‌کننده را تأیید کند. تغییر بعدی، تمویل‌های قبلی را تغییر نمی‌دهد."
        : "Super Administrator only. The user recorded here for a provider can never approve that provider's fundings or repayments. A later change never alters earlier fundings."}</p>
      <form className="admin-form" aria-label={fa ? "هویت ABOS تمویل‌کننده" : "Provider ABOS identity"}
        onSubmit={(event) => { event.preventDefault(); if (!party) return; void run({
          action: "configure-provider-identity", businessPartyId: party.id, expectedVersion: party.identity?.version ?? 0,
          identityMode: mode, userAccountId: mode === "ABOS_USER" ? userId : null, evidenceDocumentReference: reference.trim(),
          evidenceSha256: sha, changeReason: reason.trim(), ...identity
        }, { en: "Provider identity saved.", fa: "هویت تمویل‌کننده ذخیره شد." }).then((ok) => {
          if (ok) { setReference(""); setSha(""); setReason(""); setIdentity(requestIdentity()); } }); }}>
        <label><span>{fa ? "تمویل‌کننده *" : "Provider *"}</span>
          <select value={partyId} required onChange={(event) => { setPartyId(event.target.value); touch(); }}>
            <option value="">{fa ? "انتخاب کنید" : "Choose"}</option>
            {workspace.options.parties.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select></label>
        {party ? <p className="admin-hint">{party.identity
          ? `${fa ? "فعلی" : "Current"} (v${party.identity.version}): ${t(IDENTITY_MODE_COPY[party.identity.mode])}${party.identity.userName ? ` ${party.identity.userName}` : ""}`
          : (fa ? "هنوز ثبت نشده است." : "Not recorded yet.")}</p> : null}
        <fieldset className="admin-status-choice">
          <legend>{fa ? "آیا تمویل‌کننده از ABOS استفاده می‌کند؟ *" : "Does the provider use ABOS? *"}</legend>
          <label><input type="radio" name="tf-identity-mode" aria-label={fa ? "از ABOS استفاده نمی‌کند" : "Does not use ABOS"}
            checked={mode === "NO_ABOS_USER"} onChange={() => { setMode("NO_ABOS_USER"); touch(); }} /> {t(IDENTITY_MODE_COPY.NO_ABOS_USER)}</label>
          <label><input type="radio" name="tf-identity-mode" aria-label={fa ? "از ABOS استفاده می‌کند" : "Uses ABOS"}
            checked={mode === "ABOS_USER"} onChange={() => { setMode("ABOS_USER"); touch(); }} /> {fa ? "از ABOS استفاده می‌کند" : "Uses ABOS"}</label>
        </fieldset>
        {mode === "ABOS_USER" ? <label><span>{fa ? "کاربر ABOS تمویل‌کننده *" : "Provider's ABOS user *"}</span>
          <select value={userId} required onChange={(event) => { setUserId(event.target.value); touch(); }}>
            <option value="">{fa ? "انتخاب کنید" : "Choose"}</option>
            {workspace.options.users.map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}
          </select></label> : null}
        <label><span>{fa ? "مرجع سند شاهد *" : "Evidence document reference *"}</span>
          <input value={reference} maxLength={200} required onChange={(event) => { setReference(event.target.value); touch(); }} /></label>
        <p className="admin-hint">{fa ? VAULT_NOTE.fa : VAULT_NOTE.en}</p>
        <label><span>{fa ? "سند شاهد (فقط اثر انگشت)" : "Evidence document (fingerprint only)"}</span>
          <input type="file" onChange={(event) => { const file = event.target.files?.[0]; if (file) void sha256Hex(file).then((value) => { setSha(value); touch(); }); }} /></label>
        <label><span>SHA-256 *</span>
          <input value={sha} dir="ltr" required pattern="[0-9a-f]{64}" onChange={(event) => { setSha(event.target.value.trim().toLowerCase()); touch(); }} /></label>
        <label><span>{fa ? "دلیل *" : "Reason *"}</span>
          <input value={reason} minLength={3} maxLength={500} required onChange={(event) => { setReason(event.target.value); touch(); }} /></label>
        <button type="submit" className="treasury-button" disabled={busy || !ready}>{fa ? "ذخیره هویت" : "Save identity"}</button>
      </form>
    </section>
  );
}

function ConfigurePayable({ workspace, fa, busy, run }: { workspace: Workspace; fa: boolean; busy: boolean; run: Run }) {
  const current = workspace.configuration.mapping;
  const [ledger, setLedger] = useState("");
  const [reference, setReference] = useState("");
  const [sha, setSha] = useState("");
  const [reason, setReason] = useState("");
  const [identity, setIdentity] = useState(requestIdentity);
  const fingerprint = async (file: File | undefined) => {
    if (!file) return;
    setSha(await sha256Hex(file));
    setIdentity(requestIdentity());
  };
  const ready = ledger !== "" && reference.trim() !== "" && SHA256.test(sha) && reason.trim().length >= 3;
  return (
    <section className="module-content-card">
      <h2>{fa ? "حساب بدهی تمویل موقت" : "Temporary Funding Payable account"}</h2>
      <p>{current ? `${current.payableLedgerAccount.code} · ${current.payableLedgerAccount.name} (v${current.version}) · ${current.evidenceDocumentReference}`
        : (fa ? "انتخاب نشده" : "Not chosen")}</p>
      <form className="admin-form" aria-label={fa ? "حساب بدهی تمویل موقت" : "Temporary Funding Payable account"}
        onSubmit={(event) => { event.preventDefault(); void run({
          action: "configure-mapping", ledgerAccountId: ledger, evidenceDocumentReference: reference.trim(),
          evidenceSha256: sha, changeReason: reason.trim(), ...identity
        }, { en: "Payable account saved with its authorization evidence.", fa: "حساب بدهی همراه با سند صلاحیت ذخیره شد." })
          .then((ok) => { if (ok) { setLedger(""); setReference(""); setSha(""); setReason(""); setIdentity(requestIdentity()); } }); }}>
        <label><span>{fa ? "حساب بدهی (کنترل: بدهی تمویل موقت) *" : "Liability account (control: Temporary funding payable) *"}</span>
          <select value={ledger} onChange={(event) => { setLedger(event.target.value); setIdentity(requestIdentity()); }} required>
            <option value="">{fa ? "انتخاب کنید" : "Choose"}</option>
            {workspace.options.payableLedgerAccounts.map((account) =>
              <option key={account.id} value={account.id}>{account.code} · {account.name}</option>)}
          </select></label>
        {workspace.options.payableLedgerAccounts.length === 0 ? <p className="admin-hint expense-warning">{fa
          ? "در جدول حساب‌ها هیچ حساب بدهی فعالی با نوع کنترل «بدهی تمویل موقت» نیست."
          : "The Chart of Accounts has no active liability account with control type “Temporary funding payable”."}</p> : null}
        <label><span>{fa ? "مرجع سند صلاحیت *" : "Authorization document reference *"}</span>
          <input value={reference} maxLength={200} required onChange={(event) => { setReference(event.target.value); setIdentity(requestIdentity()); }} /></label>
        <p className="admin-hint">{fa ? VAULT_NOTE.fa : VAULT_NOTE.en}</p>
        <label><span>{fa ? "سند صلاحیت (فقط اثر انگشت)" : "Authorization document (fingerprint only)"}</span>
          <input type="file" onChange={(event) => { void fingerprint(event.target.files?.[0]); }} /></label>
        <label><span>SHA-256 *</span>
          <input value={sha} dir="ltr" required pattern="[0-9a-f]{64}" onChange={(event) => { setSha(event.target.value.trim().toLowerCase()); setIdentity(requestIdentity()); }} /></label>
        <label><span>{fa ? "دلیل *" : "Reason *"}</span>
          <input value={reason} minLength={3} maxLength={500} required onChange={(event) => { setReason(event.target.value); setIdentity(requestIdentity()); }} /></label>
        <button type="submit" className="treasury-button" disabled={busy || !ready}>{fa ? "ذخیره" : "Save"}</button>
      </form>
    </section>
  );
}

function FundingCard({ funding, workspace, fa, busy, run }: {
  funding: TemporaryFundingView; workspace: Workspace; fa: boolean; busy: boolean; run: Run;
}) {
  const [reason, setReason] = useState("");
  const [decisionIdentity] = useState(requestIdentity);
  const [settleAmount, setSettleAmount] = useState("");
  const [settleAccount, setSettleAccount] = useState("");
  const [settleReference, setSettleReference] = useState("");
  const [settleDate, setSettleDate] = useState(kabulToday);
  const [settleIdentity, setSettleIdentity] = useState(requestIdentity);
  const t = (copy: Copy) => (fa ? copy.fa : copy.en);
  const me = workspace.actorUserAccountId;
  const can = workspace.permissions;
  const reasonOk = reason.trim().length >= 3;
  const repayable = funding.status === "POSTED"
    && Number(funding.outstandingAmount) - Number(funding.pendingSettlementAmount) > 0;
  const decide = (decision: "APPROVED" | "REJECTED") => run(
    { action: "decide", temporaryFundingId: funding.id, expectedVersion: funding.version, decision,
      decisionReason: reason.trim(), ...decisionIdentity },
    decision === "APPROVED"
      ? { en: "Approved and recorded in the books.", fa: "تأیید و در دفاتر ثبت شد." }
      : { en: "Rejected.", fa: "رد شد." });

  return (
    <li className="tf-card">
      <div className="tf-card-head">
        <strong>{funding.provider.name}</strong>
        <span className="treasury-chip">{t(KIND_COPY[funding.providerKind])}</span>
        <span className="treasury-chip">{t(MODE_COPY[funding.fundingMode])}</span>
        <span className="treasury-chip">{t(MODE_EFFECT[funding.fundingMode])}</span>
        <span className="treasury-chip tf-status">{t(STATUS_COPY[funding.lifecycleStatus])}</span>
      </div>
      <p dir="auto">{funding.businessDate} · {funding.reference} · {funding.description}</p>
      <p dir="ltr" className="tf-amounts">{money(funding.amount, funding.currencyCode)}
        {funding.status === "POSTED" ? ` · ${fa ? "باقی‌مانده" : "outstanding"} ${money(funding.outstandingAmount, funding.currencyCode)}` : ""}</p>
      {funding.expenseCategory
        ? <p className="admin-hint">{fa ? "مصرف: " : "Expense: "}{localizedName(funding.expenseCategory, fa)}{funding.payee ? ` → ${funding.payee.name}` : ""}</p> : null}
      {funding.treasuryAccount
        ? <p className="admin-hint">{fa ? "به صندوق: " : "Into: "}{localizedName(funding.treasuryAccount, fa)}</p> : null}
      {funding.decision ? <p className="admin-hint">{funding.decision.decidedBy}: {funding.decision.reason}</p> : null}

      {funding.status === "PENDING_APPROVAL" && can.canApprove && funding.createdByUserAccountId !== me
        && funding.providerUserAccountId !== me ? (
          <div className="tf-actions">
            <input value={reason} aria-label={fa ? "دلیل تصمیم" : "Decision reason"}
              placeholder={fa ? "دلیل تصمیم" : "Decision reason"} onChange={(event) => setReason(event.target.value)} maxLength={500} />
            <button className="treasury-button gold" disabled={busy || !reasonOk} onClick={() => void decide("APPROVED")}>{fa ? "تأیید و ثبت" : "Approve and record"}</button>
            <button className="treasury-button" disabled={busy || !reasonOk} onClick={() => void decide("REJECTED")}>{fa ? "رد" : "Reject"}</button>
          </div>
        ) : null}

      {funding.settlements.length > 0 ? (
        <div>
          <p className="admin-hint">{fa ? "تاریخچه بازپرداخت" : "Repayment history"}</p>
          <ul className="tf-settlements">{funding.settlements.map((settlement) => (
            <SettlementRow key={`${settlement.id}-${settlement.version}`} settlement={settlement} workspace={workspace}
              fa={fa} busy={busy} run={run} providerUserAccountId={funding.providerUserAccountId} />))}</ul>
        </div>
      ) : null}

      {repayable && can.canSettle ? (
        <form className="tf-actions" aria-label={fa ? "درخواست بازپرداخت" : "Request repayment"}
          onSubmit={(event) => { event.preventDefault(); void run({
            action: "request-settlement", temporaryFundingId: funding.id, expectedFundingVersion: funding.version,
            treasuryAccountId: settleAccount, amount: { amount: settleAmount.trim(), currency: funding.currencyCode },
            businessDate: settleDate, reference: settleReference.trim(), note: null, ...settleIdentity
          }, { en: "Repayment sent for approval.", fa: "بازپرداخت برای تأیید فرستاده شد." }).then((ok) => {
            if (ok) { setSettleAmount(""); setSettleReference(""); setSettleIdentity(requestIdentity()); } }); }}>
          <strong>{fa ? "بازپرداخت" : "Repay"}</strong>
          <select value={settleAccount} required aria-label={fa ? "از کدام حساب؟" : "From which account?"}
            onChange={(event) => { setSettleAccount(event.target.value); setSettleIdentity(requestIdentity()); }}>
            <option value="">{fa ? "از کدام حساب؟" : "From which account?"}</option>
            {workspace.options.settlementSources.map((account) => <option key={account.id} value={account.id}>{localizedName(account, fa)}</option>)}
          </select>
          <input inputMode="decimal" dir="ltr" aria-label={fa ? "مبلغ بازپرداخت" : "Repayment amount"}
            placeholder={`≤ ${funding.outstandingAmount}`} value={settleAmount} required
            onChange={(event) => { setSettleAmount(event.target.value); setSettleIdentity(requestIdentity()); }} />
          <input type="date" value={settleDate} required aria-label={fa ? "تاریخ بازپرداخت" : "Repayment date"}
            onChange={(event) => { setSettleDate(event.target.value); setSettleIdentity(requestIdentity()); }} />
          <input value={settleReference} aria-label={fa ? "مرجع بازپرداخت" : "Repayment reference"}
            placeholder={fa ? "مرجع" : "Reference"} maxLength={120} required
            onChange={(event) => { setSettleReference(event.target.value); setSettleIdentity(requestIdentity()); }} />
          <button type="submit" className="treasury-button"
            disabled={busy || settleAccount === "" || !AMOUNT.test(settleAmount.trim()) || settleReference.trim() === ""}>
            {fa ? "درخواست بازپرداخت" : "Request repayment"}</button>
        </form>
      ) : null}
    </li>
  );
}

function SettlementRow({ settlement, workspace, fa, busy, run, providerUserAccountId }: {
  settlement: TemporaryFundingSettlementView; workspace: Workspace; fa: boolean; busy: boolean; run: Run;
  providerUserAccountId: string | null;
}) {
  const [reason, setReason] = useState("");
  const [identity] = useState(requestIdentity);
  const me = workspace.actorUserAccountId;
  const status = SETTLEMENT_STATUS_COPY[settlement.status];
  const decide = (decision: "APPROVED" | "REJECTED") => run(
    { action: "decide-settlement", settlementId: settlement.id, expectedVersion: settlement.version, decision,
      decisionReason: reason.trim(), ...identity },
    decision === "APPROVED" ? { en: "Repayment approved and paid.", fa: "بازپرداخت تأیید و پرداخت شد." } : { en: "Repayment rejected.", fa: "بازپرداخت رد شد." });
  return (
    <li>
      <span dir="ltr">{money(settlement.amount, settlement.currencyCode)}</span> · {settlement.businessDate} · {localizedName(settlement.treasuryAccount, fa)}
      {" "}<span className="treasury-chip">{fa ? status.fa : status.en}</span>
      {settlement.status === "PENDING_APPROVAL" && workspace.permissions.canApproveSettlement
        && settlement.createdByUserAccountId !== me && providerUserAccountId !== me ? (
          <span className="tf-actions">
            <input value={reason} aria-label={fa ? "دلیل تصمیم بازپرداخت" : "Repayment decision reason"}
              placeholder={fa ? "دلیل" : "Reason"} onChange={(event) => setReason(event.target.value)} maxLength={500} />
            <button className="treasury-button gold" disabled={busy || reason.trim().length < 3} onClick={() => void decide("APPROVED")}>{fa ? "تأیید بازپرداخت" : "Approve repayment"}</button>
            <button className="treasury-button" disabled={busy || reason.trim().length < 3} onClick={() => void decide("REJECTED")}>{fa ? "رد" : "Reject"}</button>
          </span>
        ) : null}
    </li>
  );
}
