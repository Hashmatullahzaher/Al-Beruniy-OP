"use client";

import { generateFiscalYear, isoToSolarHijri, toDariDigits } from "@abos/calendar";
import {
  GETTING_STARTED_FINANCE_PERMISSIONS, GETTING_STARTED_PERMISSIONS, OPERATING_MODE_REASON, operatingModeInForce, operatingModePlan, requiredAccounts,
  suggestedFirstYear, type DirectCapitalResult, type DirectCapitalWorkspace, type FinanceWorkflowPolicyWorkspace, type FinancialYearsWorkspace,
  type OperatingMode, type OperationalFinanceConfigurationWorkspace, type RequiredAccountKind, type TrialBalanceView
} from "@abos/contracts";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { api, errorText, type RoleSummary } from "@/components/AdminUsersWorkspace";
import { AppIcon } from "@/components/AppIcon";
import { useLocale } from "@/components/LocaleProvider";
import { kabulToday, money } from "@/components/OperationalFinanceShared";
import { useSession } from "@/components/SessionProvider";
import { StageZeroPageHeader } from "@/components/StageZeroWorkspace";
import type { ChartOfAccountsView } from "@/server/chart-of-accounts";
import type { FinanceCalendarView } from "@/server/finance-calendar";

/**
 * Getting started: one page that takes a new company from first sign-in to its first posted transaction. It only
 * orchestrates existing commands (workflow policies, calendar, Chart of Accounts, Treasury setup, shareholder capital);
 * every step's progress is derived from what really exists, so work done on the ordinary pages counts here too.
 */

type Load<T> = { readonly state: "loading" } | { readonly state: "ok"; readonly data: T } | { readonly state: "denied" } | { readonly state: "error"; readonly message: string };
type StepKey = "mode" | "access" | "year" | "accounts" | "treasury" | "money" | "first" | "ready";
type StepState = "done" | "todo" | "waiting" | "blocked";

interface SetupData {
  readonly policies: Load<FinanceWorkflowPolicyWorkspace>;
  readonly years: Load<FinancialYearsWorkspace>;
  readonly calendar: Load<FinanceCalendarView>;
  readonly accounts: Load<ChartOfAccountsView>;
  readonly config: Load<OperationalFinanceConfigurationWorkspace>;
  readonly capital: Load<DirectCapitalWorkspace>;
  readonly trialBalance: Load<TrialBalanceView>;
  readonly roles: Load<readonly RoleSummary[]> | null;
}

const LOADING = { state: "loading" } as const;
const CASH_LIKE = ["SAFE", "CASH_BOX", "PETTY_CASH"];
const APPROVAL_PERMISSIONS = ["finance.ledger-account.review", "finance.capital-receipt.approve", "finance.expense.approve", "finance.reversal.approve"];
const keys = () => ({ idempotencyKey: crypto.randomUUID(), correlationId: crypto.randomUUID() });
const ok = <T,>(load: Load<T> | null | undefined): T | null => (load?.state === "ok" ? load.data : null);

async function fetchLoad<T>(url: string, locale: "en" | "fa"): Promise<Load<T>> {
  const result = await api<T>(url);
  if (result.ok) return { state: "ok", data: result.data };
  if (result.status === 403) return { state: "denied" };
  return { state: "error", message: errorText(result.error, locale) };
}

const STARTER_ACCOUNTS: readonly { readonly kind: RequiredAccountKind | "OPENING_BALANCE_EQUITY"; readonly code: string; readonly name: string; readonly type: string; readonly controlType: string | null }[] = [
  { kind: "CASH", code: "1100", name: "Main Cash", type: "ASSET", controlType: "CASH" },
  { kind: "SHAREHOLDER_CAPITAL", code: "3100", name: "Shareholder Capital", type: "EQUITY", controlType: "SHAREHOLDER_CAPITAL" },
  { kind: "OPENING_BALANCE_EQUITY", code: "3900", name: "Opening Balance Equity", type: "EQUITY", controlType: "OPENING_BALANCE_EQUITY" },
  { kind: "EXPENSE", code: "5100", name: "Office Expenses", type: "EXPENSE", controlType: null }
];

export function GettingStartedWorkspace() {
  const { locale } = useLocale();
  const fa = locale === "fa";
  const c = useCallback((en: string, dari: string) => (fa ? dari : en), [fa]);
  const session = useSession();
  const can = session.can;
  const canSeeRoles = can("admin.roles.manage") || can("admin.users.manage");
  const [data, setData] = useState<SetupData>({ policies: LOADING, years: LOADING, calendar: LOADING, accounts: LOADING, config: LOADING,
    capital: LOADING, trialBalance: LOADING, roles: null });
  const [selected, setSelected] = useState<StepKey | null>(null);
  const [message, setMessage] = useState<{ readonly tone: "ok" | "error"; readonly text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);

  const load = useCallback(async () => {
    const mine = ++generation.current;
    const today = kabulToday();
    const [policies, years, calendar, accounts, config, capital, trialBalance, roles] = await Promise.all([
      fetchLoad<FinanceWorkflowPolicyWorkspace>("/api/v1/admin/finance-workflows", locale),
      fetchLoad<FinancialYearsWorkspace>("/api/v1/finance/financial-years", locale),
      fetchLoad<FinanceCalendarView>("/api/v1/finance/calendar", locale),
      fetchLoad<ChartOfAccountsView>("/api/v1/finance/accounts", locale),
      fetchLoad<OperationalFinanceConfigurationWorkspace>("/api/v1/finance/operations/configuration", locale),
      fetchLoad<DirectCapitalWorkspace>("/api/v1/shareholder/capital", locale),
      fetchLoad<TrialBalanceView>(`/api/v1/finance/trial-balance?asOf=${today}`, locale),
      canSeeRoles ? fetchLoad<readonly RoleSummary[]>("/api/v1/admin/roles", locale) : Promise.resolve(null)
    ]);
    if (mine === generation.current) setData({ policies, years, calendar, accounts, config, capital, trialBalance, roles });
  }, [canSeeRoles, locale]);

  useEffect(() => {
    if (session.status !== "signed-in") return;
    void load();
    // A newer load (or leaving the page) supersedes this one: its result is then ignored.
    const supersede = generation;
    return () => { supersede.current += 1; };
  }, [load, session.status]);

  /** Runs a command through the existing API, reports its outcome and reloads every step from the real state. */
  const run = useCallback(async (work: () => Promise<{ ok: boolean; text: string }>) => {
    setBusy(true); setMessage(null);
    try {
      const outcome = await work();
      setMessage({ tone: outcome.ok ? "ok" : "error", text: outcome.text });
    } finally {
      await load();
      setBusy(false);
    }
  }, [load]);

  // ---- Derived state (never stored) ----------------------------------------------------------------------------
  const policies = ok(data.policies)?.policies ?? [];
  const mode = data.policies.state === "ok" ? operatingModeInForce(policies) : null;
  const missingPermissions = GETTING_STARTED_FINANCE_PERMISSIONS.filter((permission) => !can(permission));
  const today = ok(data.years)?.today ?? kabulToday();
  const activeYear = ok(data.years)?.years.find((year) => year.status === "ACTIVE" && year.startsOn <= today && today <= year.endsOn) ?? null;
  const baseCurrency = ok(data.accounts)?.legalEntity.baseCurrency ?? ok(data.config)?.legalEntity.baseCurrency ?? ok(data.capital)?.legalEntity.baseCurrency ?? null;
  const accountReadiness = useMemo(() => requiredAccounts(ok(data.accounts)?.accounts ?? [], baseCurrency), [data.accounts, baseCurrency]);
  const config = ok(data.config);
  const safes = (config?.treasuryAccounts ?? []).filter((account) => account.status === "ACTIVE" && CASH_LIKE.includes(account.accountType) && account.currencyCode === baseCurrency);
  const expenseTypes = (config?.expenseCategories ?? []).filter((category) => category.status === "ACTIVE");
  const trialBalance = ok(data.trialBalance);
  const capital = ok(data.capital);
  const contributed = (capital?.shareholders ?? []).flatMap((holder) => holder.capitals).some((item) => Number(item.contributed) > 0);
  const hasMoney = (trialBalance?.accounts.length ?? 0) > 0 || contributed;
  const balanced = trialBalance !== null && trialBalance.balanced && trialBalance.accounts.length > 0;

  // Advanced Controls needs a second Finance person who can approve; only an administrator can see who holds which role.
  const secondApprover = useMemo<"verified" | "missing" | "unverified">(() => {
    const roles = ok(data.roles);
    if (!roles) return "unverified";
    const holdersOf = (test: (permissions: readonly string[]) => boolean) => new Set(roles.filter((role) => role.status === "ACTIVE" && test(role.permissions))
      .flatMap((role) => role.holders.filter((holder) => holder.status === "ACTIVE").map((holder) => holder.id)));
    const approvers = holdersOf((permissions) => permissions.some((p) => APPROVAL_PERMISSIONS.includes(p)));
    const financePeople = holdersOf((permissions) => permissions.some((p) => p.startsWith("finance.") || p.startsWith("treasury.") || p.startsWith("shareholder.")));
    return approvers.size >= 1 && financePeople.size >= 2 ? "verified" : "missing";
  }, [data.roles]);

  const states: Readonly<Record<StepKey, StepState>> = {
    mode: data.policies.state === "denied" ? "blocked" : mode === "SIMPLE" || (mode === "ADVANCED" && secondApprover === "verified") ? "done" : mode === "ADVANCED" ? "waiting" : "todo",
    access: missingPermissions.length === 0 ? "done" : "blocked",
    year: activeYear ? "done" : data.years.state === "denied" ? "blocked" : "todo",
    accounts: accountReadiness.every((item) => item.state === "READY") ? "done" : accountReadiness.some((item) => item.state === "WAITING") ? "waiting"
      : data.accounts.state === "denied" ? "blocked" : "todo",
    treasury: safes.length > 0 && expenseTypes.length > 0 ? "done" : data.config.state === "denied" ? "blocked" : "todo",
    money: hasMoney ? "done" : data.trialBalance.state === "denied" && data.capital.state === "denied" ? "blocked" : "todo",
    first: hasMoney ? "done" : data.capital.state === "denied" ? "blocked" : "todo",
    ready: "todo"
  };
  const order: readonly StepKey[] = ["mode", "access", "year", "accounts", "treasury", "money", "first", "ready"];
  const coreDone = order.slice(0, 7).every((key) => states[key] === "done") && balanced;
  const finalStates: Readonly<Record<StepKey, StepState>> = { ...states, ready: coreDone ? "done" : "todo" };
  const doneCount = order.filter((key) => finalStates[key] === "done").length;
  const firstOpen = order.find((key) => finalStates[key] !== "done") ?? "ready";
  const current = selected ?? firstOpen;

  const titles: Readonly<Record<StepKey, string>> = {
    mode: c("How the company works", "شیوه کار شرکت"), access: c("Finance access", "دسترسی مالی"), year: c("Financial year", "سال مالی"),
    accounts: c("Chart of Accounts", "جدول حساب‌ها"), treasury: c("Safe and expense type", "صندوق و نوع مصرف"),
    money: c("Where the first money comes from", "پول نخست از کجا می‌آید"), first: c("First transaction", "نخستین معامله"), ready: c("Ready", "آماده")
  };
  const stateCopy: Readonly<Record<StepState, string>> = { done: c("Done", "انجام شد"), todo: c("To do", "باقی مانده"),
    waiting: c("Waiting", "در انتظار"), blocked: c("Needs access", "به دسترسی نیاز دارد") };

  if (session.status === "signed-out") {
    return <div className="module-workspace"><p className="treasury-placeholder">{c("Sign in to continue.", "برای ادامه وارد شوید.")}</p></div>;
  }

  return (
    <div className="module-workspace getting-started-workspace">
      <StageZeroPageHeader icon="settings" eyebrow={{ en: "Setup", fa: "تنظیمات" }} title={{ en: "Getting started", fa: "آغاز کار" }}
        description={{ en: "From first sign-in to your first posted transaction. Each step shows what is already set up; work done on the other pages counts here too.",
          fa: "از نخستین ورود تا نخستین معاملهٔ ثبت‌شده. هر مرحله نشان می‌دهد چه چیزی آماده است؛ کاری که در صفحه‌های دیگر انجام شود اینجا هم شمرده می‌شود." }} />

      <section className="module-content-card gs-progress" aria-label={c("Progress", "پیشرفت")}>
        <strong>{c(`${doneCount} of 8 steps done`, `${toDariDigits(doneCount)} از ۸ مرحله انجام شد`)}</strong>
        <div className="gs-progress-bar" role="progressbar" aria-valuemin={0} aria-valuemax={8} aria-valuenow={doneCount}><span style={{ width: `${(doneCount / 8) * 100}%` }} /></div>
      </section>

      {message ? <div className={`treasury-message ${message.tone === "ok" ? "success" : "error"}`} role="status">
        <AppIcon name={message.tone === "ok" ? "shield" : "alert"} size={16} /><span>{message.text}</span>
        <button type="button" onClick={() => setMessage(null)} aria-label={c("Dismiss", "بستن")}>×</button></div> : null}

      <div className="gs-layout">
        <nav aria-label={c("Setup steps", "مراحل تنظیم")}>
          <ol className="gs-steps">
            {order.map((key, index) => (
              <li key={key}>
                <button type="button" className={`gs-step ${finalStates[key]}${key === current ? " current" : ""}`} aria-current={key === current ? "step" : undefined}
                  aria-label={`${index + 1}. ${titles[key]} — ${stateCopy[finalStates[key]]}`}
                  onClick={() => { setSelected(key); setMessage(null); }}>
                  <span className="gs-step-number" aria-hidden="true">{finalStates[key] === "done" ? "✓" : index + 1}</span>
                  <span className="gs-step-title">{titles[key]}</span>
                  <em className={`treasury-chip ${finalStates[key] === "done" ? "ok" : finalStates[key] === "todo" ? "" : finalStates[key] === "waiting" ? "gold" : "danger"}`}>{stateCopy[finalStates[key]]}</em>
                </button>
              </li>
            ))}
          </ol>
        </nav>
        <section className="module-content-card gs-detail" aria-labelledby="gs-step-heading">
          <h2 id="gs-step-heading">{titles[current]}</h2>
          {current === "mode" ? <ModeStep data={data} mode={mode} secondApprover={secondApprover} canManage={ok(data.policies)?.canManage ?? false} busy={busy} run={run} c={c} fa={fa} /> : null}
          {current === "access" ? <AccessStep missing={missingPermissions} can={can} c={c} /> : null}
          {current === "year" ? <YearStep data={data} activeYear={activeYear} canManage={can("finance.calendar.manage")} busy={busy} run={run} c={c} locale={locale} /> : null}
          {current === "accounts" ? <AccountsStep data={data} readiness={accountReadiness} baseCurrency={baseCurrency} busy={busy} run={run} c={c} locale={locale} /> : null}
          {current === "treasury" ? <TreasuryStep config={config} safes={safes} expenseTypes={expenseTypes} capital={capital} baseCurrency={baseCurrency}
            readiness={accountReadiness} busy={busy} run={run} c={c} locale={locale} /> : null}
          {current === "money" ? <MoneyStep hasMoney={hasMoney} can={can} onCapital={() => setSelected("first")} c={c} /> : null}
          {current === "first" ? <FirstTransactionStep capital={capital} capitalLoad={data.capital} trialBalance={trialBalance} hasMoney={hasMoney} balanced={balanced}
            baseCurrency={baseCurrency} busy={busy} run={run} c={c} locale={locale} /> : null}
          {current === "ready" ? <ReadyStep states={finalStates} balanced={balanced} mode={mode} secondApprover={secondApprover} c={c} /> : null}
          {current !== "ready" && finalStates[current] === "done" ? <p className="gs-next">
            <button type="button" className="treasury-button gold" onClick={() => setSelected(order[order.indexOf(current) + 1] ?? "ready")}>{c("Next step", "مرحلهٔ بعد")}</button></p> : null}
        </section>
      </div>
    </div>
  );
}

type Run = (work: () => Promise<{ ok: boolean; text: string }>) => Promise<void>;
type C = (en: string, dari: string) => string;

function Done({ children }: { readonly children: ReactNode }) {
  return <p className="treasury-message success gs-done" role="note"><AppIcon name="shield" size={16} /><span>{children}</span></p>;
}

function NeedsAccess({ what, c }: { readonly what: string; readonly c: C }) {
  return <p className="admin-hint" role="note">{c(`This step needs ${what}. Ask your System Administrator; nobody can give access to themselves.`,
    `این مرحله به ${what} نیاز دارد. از مدیر سیستم بخواهید؛ هیچ‌کس به خودش دسترسی نمی‌دهد.`)}</p>;
}

function ModeStep({ data, mode, secondApprover, canManage, busy, run, c, fa }: {
  readonly data: SetupData; readonly mode: OperatingMode | "MIXED" | "NOT_CHOSEN" | null; readonly secondApprover: "verified" | "missing" | "unverified";
  readonly canManage: boolean; readonly busy: boolean; readonly run: Run; readonly c: C; readonly fa: boolean;
}) {
  const [choice, setChoice] = useState<OperatingMode | null>(null);
  const policies = ok(data.policies)?.policies ?? [];
  if (data.policies.state === "loading") return <p className="treasury-placeholder">{c("Loading…", "در حال بارگذاری…")}</p>;
  if (data.policies.state !== "ok") return <NeedsAccess what={c("the “Manage Finance workflow approvals” permission", "صلاحیت «مدیریت تأیید جریان‌های مالی»")} c={c} />;
  const plan = choice ? operatingModePlan(choice, policies) : null;
  const label = (type: string) => { const policy = policies.find((item) => item.workflowType === type); return policy ? (fa ? policy.labelFa : policy.labelEn) : type; };
  const save = (selectedMode: OperatingMode) => run(async () => {
    for (const item of operatingModePlan(selectedMode, policies).saves) {
      const result = await api("/api/v1/admin/finance-workflows", "PUT", { workflowType: item.workflowType, approvalRequired: item.approvalRequired,
        expectedVersion: item.expectedVersion, changeReason: OPERATING_MODE_REASON[selectedMode], ...keys() });
      if (!result.ok) return { ok: false, text: `${label(item.workflowType)}: ${errorText(result.error, fa ? "fa" : "en")}` };
    }
    setChoice(null);
    return { ok: true, text: c("Saved. Each setting is a new, audited policy version you can change later in Workflow approvals.",
      "ذخیره شد. هر تنظیم یک نسخهٔ تازه و ثبت‌شده از سیاست است که بعداً در «تأیید جریان‌ها» قابل تغییر است.") };
  });
  return <>
    {mode === "SIMPLE" ? <Done>{c("Simple / Single Operator is in force: everyday work is recorded in one save and corrections use a reversal with a reason.",
      "ساده / اپراتور یک‌نفره فعال است: کار روزانه با یک ذخیره ثبت می‌شود و اصلاح با برگشت همراه با دلیل انجام می‌شود.")}</Done> : null}
    {mode === "ADVANCED" ? <p className={`treasury-message ${secondApprover === "verified" ? "success" : ""}`} role="note">{secondApprover === "verified"
      ? c("Advanced Controls is in force, and a second Finance person who can approve exists.", "کنترل‌های پیشرفته فعال است و شخص مالی دومی که تأیید می‌کند وجود دارد.")
      : secondApprover === "missing" ? c("Advanced Controls is in force, but there is no second Finance person who can approve yet. Controlled work will wait until one exists: create that user in Users.",
        "کنترل‌های پیشرفته فعال است، اما هنوز شخص مالی دومی برای تأیید وجود ندارد. کار کنترل‌شده تا آن زمان منتظر می‌ماند: آن کاربر را در «کاربران» بسازید.")
        : c("Advanced Controls is in force. It needs a second Finance person who can approve; only your System Administrator can confirm that in Roles & permissions.",
          "کنترل‌های پیشرفته فعال است. به شخص مالی دومی برای تأیید نیاز دارد؛ فقط مدیر سیستم می‌تواند آن را در «نقش‌ها و صلاحیت‌ها» تأیید کند.")}</p> : null}
    {mode === "MIXED" ? <p className="admin-hint" role="note">{c("Some approval settings are already saved. Choosing a way of working saves only the settings still needed.",
      "برخی تنظیم‌های تأیید از قبل ذخیره شده‌اند. انتخاب شیوه کار فقط تنظیم‌های باقی‌مانده را ذخیره می‌کند.")}</p> : null}
    <p>{c("How will this company operate?", "این شرکت چگونه کار می‌کند؟")}</p>
    <div className="gs-choices" role="radiogroup" aria-label={c("How the company works", "شیوه کار شرکت")}>
      <label className={`gs-choice${choice === "SIMPLE" ? " chosen" : ""}`}><input type="radio" name="operating-mode" checked={choice === "SIMPLE"} disabled={!canManage || busy} onChange={() => setChoice("SIMPLE")} />
        <span><strong>{c("Simple / Single Operator", "ساده / اپراتور یک‌نفره")}</strong>
          <small>{c("For an owner or accountant who may work alone. Normal actions are recorded at once; corrections use a reversal with a written reason; no second employee is needed for everyday work.",
            "برای مالک یا محاسبی که ممکن است تنها کار کند. کارهای عادی فوراً ثبت می‌شوند؛ اصلاح با برگشت و دلیل نوشته‌شده انجام می‌شود؛ برای کار روزانه به کارمند دوم نیاز نیست.")}</small></span></label>
      <label className={`gs-choice${choice === "ADVANCED" ? " chosen" : ""}`}><input type="radio" name="operating-mode" checked={choice === "ADVANCED"} disabled={!canManage || busy} onChange={() => setChoice("ADVANCED")} />
        <span><strong>{c("Advanced Controls", "کنترل‌های پیشرفته")}</strong>
          <small>{c("For companies that need independent review. Selected work waits for a second authorised person; nobody approves their own controlled transaction.",
            "برای شرکت‌هایی که بازبینی مستقل لازم دارند. کار انتخاب‌شده منتظر شخص مجاز دوم می‌ماند؛ هیچ‌کس معامله کنترل‌شدهٔ خودش را تأیید نمی‌کند.")}</small></span></label>
    </div>
    {!canManage ? <NeedsAccess what={c("the “Manage Finance workflow approvals” permission", "صلاحیت «مدیریت تأیید جریان‌های مالی»")} c={c} /> : null}
    {plan && choice ? <div className="gs-plan">
      <p><strong>{c("What will be saved", "آنچه ذخیره می‌شود")}</strong></p>
      {plan.saves.length === 0 ? <p className="admin-hint">{c("Nothing: these settings are already in force.", "هیچ: این تنظیم‌ها از قبل فعال است.")}</p>
        : <ul>{plan.saves.map((item) => <li key={item.workflowType}>{label(item.workflowType)}: <strong>{item.approvalRequired ? c("approval ON", "تأیید روشن") : c("approval OFF", "تأیید خاموش")}</strong></li>)}</ul>}
      {plan.unavailable.length > 0 ? <p className="admin-hint">{c("Not available yet, so left unchanged: ", "هنوز در دسترس نیست و بدون تغییر می‌ماند: ")}{plan.unavailable.map(label).join(", ")}</p> : null}
      <p className="admin-hint">{c(`Every saved setting is a new policy version with the reason “${OPERATING_MODE_REASON[choice]}”. Balances, journals and the other controls are not changed.`,
        `هر تنظیم ذخیره‌شده یک نسخهٔ تازهٔ سیاست با دلیل «${OPERATING_MODE_REASON[choice]}» است. مانده‌ها، ژورنال‌ها و دیگر کنترل‌ها تغییر نمی‌کنند.`)}</p>
      {choice === "ADVANCED" ? <p className="admin-hint" role="note">{c("Advanced Controls needs at least two Finance people: one prepares, another approves.", "کنترل‌های پیشرفته دست‌کم به دو شخص مالی نیاز دارد: یکی آماده می‌کند، دیگری تأیید می‌کند.")}</p> : null}
      <button type="button" className="treasury-button gold" disabled={busy || plan.saves.length === 0} onClick={() => void save(choice)}>
        {busy ? c("Saving…", "در حال ذخیره…") : choice === "SIMPLE" ? c("Use Simple / Single Operator", "استفاده از حالت ساده") : c("Use Advanced Controls", "استفاده از کنترل‌های پیشرفته")}</button>
    </div> : null}
  </>;
}

function AccessStep({ missing, can, c }: { readonly missing: readonly string[]; readonly can: (permission: string) => boolean; readonly c: C }) {
  const areas: readonly [keyof typeof GETTING_STARTED_PERMISSIONS, string, string][] = [
    ["operatingMode", "Workflow approvals", "تأیید جریان‌ها"], ["financialYear", "Financial calendar", "تقویم مالی"], ["accounts", "Chart of Accounts", "جدول حساب‌ها"],
    ["treasury", "Safes and expense types", "صندوق‌ها و انواع مصرف"], ["firstMoney", "Shareholders and capital", "سهامداران و سرمایه"], ["reports", "Finance reports", "گزارش‌های مالی"]];
  if (missing.length === 0) return <Done>{c("You can do every Finance setup step yourself.", "شما می‌توانید همهٔ مراحل تنظیم مالی را خودتان انجام دهید.")}</Done>;
  const lacking = areas.filter(([key]) => GETTING_STARTED_PERMISSIONS[key].some((permission) => missing.includes(permission)));
  return <>
    <p>{c("Finance work is done by a Finance user. The System Administrator is not a Finance user automatically, and nobody can give access to themselves.",
      "کار مالی را کاربر مالی انجام می‌دهد. مدیر سیستم خودبه‌خود کاربر مالی نیست و هیچ‌کس به خودش دسترسی نمی‌دهد.")}</p>
    <p className="admin-hint">{c("You cannot yet use: ", "هنوز به این بخش‌ها دسترسی ندارید: ")}{lacking.map(([, en, dari]) => c(en, dari)).join(" · ")}</p>
    {can("admin.roles.manage") || can("admin.users.manage") ? <ol className="gs-actions">
      {can("admin.roles.manage") ? <li><Link className="treasury-button gold" href="/admin/roles?template=finance-manager">{c("1. Create the Finance Manager role", "۱. ساختن نقش مدیر مالی")}</Link>
        <small>{c("Opens a role prefilled from the single-operator template; you review every permission before saving.", "نقشی را از الگوی اپراتور یک‌نفره باز می‌کند؛ پیش از ذخیره همهٔ صلاحیت‌ها را بررسی می‌کنید.")}</small></li> : null}
      {can("admin.users.manage") ? <li><Link className="treasury-button" href="/admin/users">{c("2. Create the Finance user and give them the role", "۲. ساختن کاربر مالی و دادن نقش به او")}</Link>
        <small>{c("They sign in with their own password and continue Getting started.", "او با رمز خودش وارد می‌شود و «آغاز کار» را ادامه می‌دهد.")}</small></li> : null}
    </ol> : <NeedsAccess what={c("a Finance role", "یک نقش مالی")} c={c} />}
  </>;
}

function YearStep({ data, activeYear, canManage, busy, run, c, locale }: {
  readonly data: SetupData; readonly activeYear: FinancialYearsWorkspace["years"][number] | null; readonly canManage: boolean; readonly busy: boolean;
  readonly run: Run; readonly c: C; readonly locale: "en" | "fa";
}) {
  const calendar = ok(data.calendar);
  const settingsKind = calendar?.settings?.calendarKind ?? null;
  const [kind, setKind] = useState<"GREGORIAN" | "SOLAR_HIJRI">("GREGORIAN");
  const chosen = settingsKind === "GREGORIAN" || settingsKind === "SOLAR_HIJRI" ? settingsKind : kind;
  const today = kabulToday();
  const currentYear = chosen === "SOLAR_HIJRI" ? isoToSolarHijri(today).year : Number(today.slice(0, 4));
  const existing = (calendar?.fiscalYears ?? []).filter((year) => year.calendarKind === chosen).map((year) => year.fiscalYear);
  const [yearInput, setYearInput] = useState<string>("");
  const year = yearInput === "" ? suggestedFirstYear(currentYear, existing) : Number(yearInput);
  const preview = useMemo(() => { try { return generateFiscalYear({ kind: chosen }, year); } catch { return null; } }, [chosen, year]);
  if (activeYear) return <Done>{c(`${activeYear.label}: ${activeYear.startsOn} to ${activeYear.endsOn} · ${activeYear.calendarKind === "SOLAR_HIJRI" ? "Solar Hijri" : activeYear.calendarKind === "GREGORIAN" ? "Gregorian" : "Custom"} · Active`,
    `${activeYear.labelFa ?? activeYear.label}: ${activeYear.startsOn} تا ${activeYear.endsOn} · ${activeYear.calendarKind === "SOLAR_HIJRI" ? "هجری شمسی" : activeYear.calendarKind === "GREGORIAN" ? "میلادی" : "سفارشی"} · فعال`)}</Done>;
  if (!canManage) return <NeedsAccess what={c("the “Manage financial calendar” permission", "صلاحیت «مدیریت تقویم مالی»")} c={c} />;
  if (data.calendar.state === "loading") return <p className="treasury-placeholder">{c("Loading…", "در حال بارگذاری…")}</p>;
  if (settingsKind === "CUSTOM") return <p className="admin-hint">{c("This company uses a custom year; create it on the Financial calendar page.", "این شرکت سال سفارشی دارد؛ آن را در صفحهٔ «تقویم مالی» بسازید.")} <Link href="/finance/calendar">{c("Financial calendar", "تقویم مالی")}</Link></p>;
  const create = () => run(async () => {
    if (calendar?.settings === null) {
      const settings = await api("/api/v1/finance/calendar", "PUT", { calendarKind: chosen, customStartMonth: null, customStartDay: null,
        reportingCalendars: ["SOLAR_HIJRI", "GREGORIAN"], expectedVersion: 0 });
      if (!settings.ok) return { ok: false, text: errorText(settings.error, locale) };
    }
    const created = await api("/api/v1/finance/calendar/fiscal-years", "POST", { fiscalYear: year });
    return created.ok ? { ok: true, text: c("Financial year created. Transactions dated in it can now be recorded.", "سال مالی ساخته شد. اکنون معامله‌های داخل آن ثبت می‌شوند.") }
      : { ok: false, text: errorText(created.error, locale) };
  });
  return <form className="admin-form" aria-label={c("Create the financial year", "ساختن سال مالی")} onSubmit={(event) => { event.preventDefault(); void create(); }}>
    {settingsKind === null ? <fieldset className="gs-inline-choice"><legend>{c("Year type", "نوع سال")}</legend>
      <label><input type="radio" name="year-kind" checked={kind === "GREGORIAN"} onChange={() => { setKind("GREGORIAN"); setYearInput(""); }} />{c("Gregorian (January to December)", "میلادی (جنوری تا دسمبر)")}</label>
      <label><input type="radio" name="year-kind" checked={kind === "SOLAR_HIJRI"} onChange={() => { setKind("SOLAR_HIJRI"); setYearInput(""); }} />{c("Solar Hijri (Hamal to Hut)", "هجری شمسی (حمل تا حوت)")}</label>
    </fieldset> : null}
    <label><span>{c("Year", "سال")}</span><input type="number" value={year} onChange={(event) => setYearInput(event.target.value)} /></label>
    {preview ? <p className="admin-hint">{c(`Starts ${preview.startsOn}, ends ${preview.endsOn}. It becomes active at once.`, `آغاز ${preview.startsOn}، پایان ${preview.endsOn}. فوراً فعال می‌شود.`)}</p>
      : <p className="admin-hint">{c("That year is not valid.", "این سال معتبر نیست.")}</p>}
    <p className="admin-hint">{c("Months only group dates in reports; there is no monthly close. At the end of the year you close the whole year.", "ماه‌ها فقط تاریخ‌ها را در گزارش‌ها گروه‌بندی می‌کنند؛ بستن ماهانه وجود ندارد. در پایان سال، کل سال بسته می‌شود.")}</p>
    <button type="submit" className="treasury-button gold" disabled={busy || preview === null}>{c("Create the financial year", "ساختن سال مالی")}</button>
  </form>;
}

function AccountsStep({ data, readiness, baseCurrency, busy, run, c, locale }: {
  readonly data: SetupData; readonly readiness: ReturnType<typeof requiredAccounts>; readonly baseCurrency: string | null; readonly busy: boolean;
  readonly run: Run; readonly c: C; readonly locale: "en" | "fa";
}) {
  const view = ok(data.accounts);
  const [drafts, setDrafts] = useState<Readonly<Record<string, { code: string; name: string }>>>({});
  const [reasons, setReasons] = useState<Readonly<Record<string, string>>>({});
  if (data.accounts.state === "loading") return <p className="treasury-placeholder">{c("Loading…", "در حال بارگذاری…")}</p>;
  if (!view) return <NeedsAccess what={c("access to the Chart of Accounts", "دسترسی به جدول حساب‌ها")} c={c} />;
  const policyOff = view.approvalPolicy?.configured === true && view.approvalPolicy.approvalRequired === false;
  const labels: Readonly<Record<RequiredAccountKind, [string, string, string]>> = {
    CASH: ["Cash (Safe) account", "حساب نقد (صندوق)", "Where the money in your Safe is recorded."],
    SHAREHOLDER_CAPITAL: ["Shareholder capital account", "حساب سرمایهٔ سهامدار", "What shareholders have put into the company. One per currency."],
    EXPENSE: ["Expense account", "حساب مصرف", "Where everyday spending is recorded."]
  };
  const starter = STARTER_ACCOUNTS.find((item) => item.kind === "CASH");
  const create = async (body: { code: string; name: string; type: string; controlType: string | null }) => api("/api/v1/finance/accounts", "POST", {
    account: { ...body, nameFa: null, description: null, currency: baseCurrency, parentId: null, postingAllowed: true, requiresProject: false, requiresDepartment: false, requiresCostCenter: false },
    confirmDuplicates: false });
  const createStarter = () => run(async () => {
    for (const item of STARTER_ACCOUNTS) {
      const result = await create({ code: item.code, name: item.kind === "CASH" ? `${item.name} - ${baseCurrency ?? ""}`.trim() : item.name, type: item.type, controlType: item.controlType });
      if (!result.ok) return { ok: false, text: `${item.code}: ${errorText(result.error, locale)}` };
    }
    return { ok: true, text: c("Starter accounts created. You can rename them or add more in the Chart of Accounts.", "حساب‌های آغازین ساخته شدند. می‌توانید آن‌ها را در جدول حساب‌ها تغییر نام دهید یا حساب بیشتر بیفزایید.") };
  });
  return <>
    <p className="admin-hint">{c("A first capital receipt and a first expense need these three accounts in your base currency", "نخستین دریافت سرمایه و نخستین مصرف به این سه حساب به واحد پول پایه نیاز دارد")} ({baseCurrency ?? "—"}).</p>
    {view.accounts.length === 0 && view.canManage && starter ? <div className="gs-plan">
      <p><strong>{c("Use a starter Chart of Accounts (optional)", "استفاده از جدول حساب‌های آغازین (اختیاری)")}</strong></p>
      <ul>{STARTER_ACCOUNTS.map((item) => <li key={item.code}>{item.code} · {item.kind === "CASH" ? `${item.name} - ${baseCurrency ?? ""}` : item.name}</li>)}</ul>
      <p className="admin-hint">{c("Offered only because the company has no account yet. Everything stays editable; an established Chart of Accounts is never changed.",
        "فقط چون شرکت هنوز حسابی ندارد پیشنهاد می‌شود. همه‌چیز قابل ویرایش می‌ماند؛ جدول حساب‌های موجود هرگز تغییر نمی‌کند.")}</p>
      <button type="button" className="treasury-button gold" disabled={busy} onClick={() => void createStarter()}>{c("Create the starter accounts", "ساختن حساب‌های آغازین")}</button>
    </div> : null}
    <ul className="gs-checklist">
      {readiness.map((item) => {
        const [en, dari, help] = labels[item.kind];
        const fallback = STARTER_ACCOUNTS.find((starterItem) => starterItem.kind === item.kind)!;
        const draft = drafts[item.kind] ?? { code: fallback.code, name: item.kind === "CASH" ? `${fallback.name} - ${baseCurrency ?? ""}` : fallback.name };
        return <li key={item.kind} className={item.state.toLowerCase()} aria-label={c(en, dari)}>
          <strong>{item.state === "READY" ? "✓ " : ""}{c(en, dari)}</strong> <small>{c(help, help)}</small>
          {item.state === "READY" && item.account ? <p>{item.account.code} · {item.account.name}</p> : null}
          {item.state === "WAITING" && item.account ? <div>
            <p>{item.account.code} · {item.account.name} — {c("waiting for review", "در انتظار بازبینی")}</p>
            {policyOff && view.canManage ? <form className="admin-form gs-inline-form" onSubmit={(event) => { event.preventDefault(); const account = view.accounts.find((a) => a.id === item.account!.id)!;
              void run(async () => { const result = await api(`/api/v1/finance/accounts/${account.id}/reevaluate`, "POST", { expectedVersion: account.version, reason: (reasons[item.kind] ?? "").trim(), ...keys() });
                return result.ok ? { ok: true, text: c("Account revalidated and released under approval OFF. No approval was recorded.", "حساب اعتبارسنجی و طبق سیاست خاموش آزاد شد. هیچ تأییدی ثبت نشد.") } : { ok: false, text: errorText(result.error, locale) }; }); }}>
              <label><span>{c("Reason for policy-based release", "دلیل آزادسازی طبق سیاست")}</span>
                <input minLength={5} maxLength={500} required value={reasons[item.kind] ?? ""} onChange={(event) => setReasons({ ...reasons, [item.kind]: event.target.value })} /></label>
              <button type="submit" className="treasury-button gold" disabled={busy || (reasons[item.kind] ?? "").trim().length < 5}>{c("Re-evaluate under current policy", "ارزیابی دوباره طبق سیاست جاری")}</button>
              <small>{c("Approval is OFF now. All normal checks run again and the history is kept; nothing is released without this action.", "تأیید اکنون خاموش است. همه بررسی‌ها دوباره انجام می‌شود و تاریخچه حفظ می‌شود؛ بدون این اقدام چیزی آزاد نمی‌شود.")}</small>
            </form> : <p className="admin-hint">{c("Chart of Accounts approval is ON, so another person must review it in the Chart of Accounts.", "تأیید جدول حساب‌ها روشن است؛ شخص دیگری باید آن را در جدول حساب‌ها بازبینی کند.")}</p>}
          </div> : null}
          {item.state === "MISSING" && view.canManage && view.accounts.length > 0 ? <form className="admin-form gs-inline-form" onSubmit={(event) => { event.preventDefault();
            void run(async () => { const result = await create({ code: draft.code.trim(), name: draft.name.trim(), type: fallback.type, controlType: fallback.controlType });
              return result.ok ? { ok: true, text: c("Account created.", "حساب ساخته شد.") } : { ok: false, text: errorText(result.error, locale) }; }); }}>
            <label><span>{c("Code", "کد")}</span><input value={draft.code} required maxLength={32} onChange={(event) => setDrafts({ ...drafts, [item.kind]: { ...draft, code: event.target.value } })} /></label>
            <label><span>{c("Name", "نام")}</span><input value={draft.name} required maxLength={120} onChange={(event) => setDrafts({ ...drafts, [item.kind]: { ...draft, name: event.target.value } })} /></label>
            <button type="submit" className="treasury-button gold" disabled={busy || draft.code.trim() === "" || draft.name.trim().length < 2}>{c("Add this account", "افزودن این حساب")}</button>
          </form> : null}
        </li>;
      })}
    </ul>
    {!view.canManage ? <NeedsAccess what={c("the “Manage the Chart of Accounts” permission", "صلاحیت «مدیریت جدول حساب‌ها»")} c={c} /> : null}
    <p className="admin-hint"><Link href="/finance/accounts">{c("Open the full Chart of Accounts", "باز کردن جدول کامل حساب‌ها")}</Link></p>
  </>;
}

function TreasuryStep({ config, safes, expenseTypes, capital, baseCurrency, readiness, busy, run, c, locale }: {
  readonly config: OperationalFinanceConfigurationWorkspace | null; readonly safes: OperationalFinanceConfigurationWorkspace["treasuryAccounts"];
  readonly expenseTypes: OperationalFinanceConfigurationWorkspace["expenseCategories"]; readonly capital: DirectCapitalWorkspace | null; readonly baseCurrency: string | null;
  readonly readiness: ReturnType<typeof requiredAccounts>; readonly busy: boolean; readonly run: Run; readonly c: C; readonly locale: "en" | "fa";
}) {
  const cashLedgers = (config?.options.treasuryLedgerAccounts ?? []).filter((ledger) => ledger.controlType === "CASH" && ledger.currencyCode === baseCurrency);
  const expenseLedgers = config?.options.expenseLedgerAccounts ?? [];
  const readyCash = readiness.find((item) => item.kind === "CASH" && item.state === "READY")?.account?.id;
  const readyExpense = readiness.find((item) => item.kind === "EXPENSE" && item.state === "READY")?.account?.id;
  const [safe, setSafe] = useState<{ name: string; type: string; ledger: string } | null>(null);
  const [category, setCategory] = useState<{ code: string; name: string; ledger: string } | null>(null);
  const safeForm = safe ?? { name: `Main ${baseCurrency ?? ""} Safe`.replace("  ", " "), type: "SAFE", ledger: readyCash && cashLedgers.some((l) => l.id === readyCash) ? readyCash : cashLedgers[0]?.id ?? "" };
  const categoryForm = category ?? { code: "OFFICE", name: "Office supplies", ledger: readyExpense && expenseLedgers.some((l) => l.id === readyExpense) ? readyExpense : expenseLedgers[0]?.id ?? "" };
  if (!config) return <NeedsAccess what={c("the “Set up Treasury accounts for daily Finance” permission", "صلاحیت «تنظیم حساب‌های خزانه برای کار مالی روزانه»")} c={c} />;
  const balance = (id: string) => capital?.destinations.find((destination) => destination.id === id)?.balance ?? null;
  return <>
    <p className="admin-hint">{c("A Safe is where cash is held. It starts at zero; you do not need an opening balance just because a Safe exists.",
      "صندوق جایی است که پول نقد نگهداری می‌شود. از صفر آغاز می‌شود؛ فقط به خاطر داشتن صندوق به موجودی افتتاحیه نیاز ندارید.")}</p>
    {safes.length > 0 ? <ul className="gs-checklist">{safes.map((account) => <li key={account.id} className="ready">
      <strong>✓ {account.nameEn}</strong> <small>{account.accountType === "SAFE" ? c("Safe", "صندوق") : account.accountType === "CASH_BOX" ? c("Cash box", "صندوقچه") : c("Petty cash", "تنخواه")} · {account.currencyCode} · {account.ledgerAccountCode} · {account.ledgerAccountName}
        {balance(account.id) !== null ? ` · ${c("Balance", "موجودی")} ${money(balance(account.id)!, account.currencyCode)}` : ""}</small>
      <p className="admin-hint">{c("A responsible person is optional; set one on the Safes page.", "شخص مسئول اختیاری است؛ آن را در صفحهٔ صندوق‌ها تعیین کنید.")} <Link href="/finance/safes">{c("Safes", "صندوق‌ها")}</Link></p></li>)}</ul>
      : config.permissions.canManageTreasuryAccounts ? <form className="admin-form" aria-label={c("Add the first Safe", "افزودن نخستین صندوق")} onSubmit={(event) => { event.preventDefault();
        void run(async () => { const result = await api("/api/v1/finance/operations/treasury-accounts", "PUT", { nameEn: safeForm.name.trim(), nameFa: null, accountType: safeForm.type,
          currencyCode: baseCurrency, ledgerAccountId: safeForm.ledger, sarafBusinessPartyId: null, externalReference: null, status: "ACTIVE", expectedVersion: 0 });
          return result.ok ? { ok: true, text: c("Safe created with a balance of zero.", "صندوق با موجودی صفر ساخته شد.") } : { ok: false, text: errorText(result.error, locale) }; }); }}>
        <label><span>{c("Name", "نام")}</span><input value={safeForm.name} required maxLength={120} onChange={(event) => setSafe({ ...safeForm, name: event.target.value })} /></label>
        <label><span>{c("Type", "نوع")}</span><select value={safeForm.type} onChange={(event) => setSafe({ ...safeForm, type: event.target.value })}>
          <option value="SAFE">{c("Safe", "صندوق")}</option><option value="CASH_BOX">{c("Cash box", "صندوقچه")}</option><option value="PETTY_CASH">{c("Petty cash", "تنخواه")}</option></select></label>
        <label><span>{c("Currency", "واحد پول")}</span><input value={baseCurrency ?? ""} readOnly /></label>
        <label><span>{c("Cash account in the Chart of Accounts", "حساب نقد در جدول حساب‌ها")}</span><select value={safeForm.ledger} required onChange={(event) => setSafe({ ...safeForm, ledger: event.target.value })}>
          <option value="">{c("Choose", "انتخاب")}</option>{cashLedgers.map((ledger) => <option key={ledger.id} value={ledger.id}>{ledger.code} · {ledger.name}</option>)}</select></label>
        {cashLedgers.length === 0 ? <p className="admin-hint">{c("First finish the Chart of Accounts step: the Safe needs a ready Cash account.", "نخست مرحلهٔ جدول حساب‌ها را کامل کنید: صندوق به حساب نقد آماده نیاز دارد.")}</p> : null}
        <p className="admin-hint">{c("Bank and Saraf accounts are added in Finance setup.", "حساب‌های بانک و صراف در «تنظیمات مالی» افزوده می‌شوند.")} <Link href="/finance/setup">{c("Finance setup", "تنظیمات مالی")}</Link></p>
        <button type="submit" className="treasury-button gold" disabled={busy || safeForm.name.trim().length < 2 || safeForm.ledger === ""}>{c("Create the Safe", "ساختن صندوق")}</button>
      </form> : <NeedsAccess what={c("the “Set up Treasury accounts for daily Finance” permission", "صلاحیت «تنظیم حساب‌های خزانه»")} c={c} />}
    <h3>{c("Expense type", "نوع مصرف")}</h3>
    {expenseTypes.length > 0 ? <p>✓ {expenseTypes.map((type) => `${type.categoryCode} · ${type.nameEn}`).join(", ")}</p>
      : config.permissions.canManageExpenseCategories ? <form className="admin-form" aria-label={c("Add the first expense type", "افزودن نخستین نوع مصرف")} onSubmit={(event) => { event.preventDefault();
        void run(async () => { const result = await api("/api/v1/finance/operations/expense-categories", "PUT", { categoryCode: categoryForm.code.trim(), nameEn: categoryForm.name.trim(), nameFa: null,
          ledgerAccountId: categoryForm.ledger, status: "ACTIVE", expectedVersion: 0 });
          return result.ok ? { ok: true, text: c("Expense type saved.", "نوع مصرف ذخیره شد.") } : { ok: false, text: errorText(result.error, locale) }; }); }}>
        <label><span>{c("Code", "کد")}</span><input value={categoryForm.code} required maxLength={32} onChange={(event) => setCategory({ ...categoryForm, code: event.target.value })} /></label>
        <label><span>{c("Name", "نام")}</span><input value={categoryForm.name} required maxLength={120} onChange={(event) => setCategory({ ...categoryForm, name: event.target.value })} /></label>
        <label><span>{c("Expense account", "حساب مصرف")}</span><select value={categoryForm.ledger} required onChange={(event) => setCategory({ ...categoryForm, ledger: event.target.value })}>
          <option value="">{c("Choose", "انتخاب")}</option>{expenseLedgers.map((ledger) => <option key={ledger.id} value={ledger.id}>{ledger.code} · {ledger.name}</option>)}</select></label>
        <button type="submit" className="treasury-button gold" disabled={busy || categoryForm.ledger === "" || categoryForm.name.trim().length < 2}>{c("Save the expense type", "ذخیرهٔ نوع مصرف")}</button>
      </form> : <NeedsAccess what={c("the “Set up expense types” permission", "صلاحیت «تنظیم انواع مصرف»")} c={c} />}
  </>;
}

function MoneyStep({ hasMoney, can, onCapital, c }: { readonly hasMoney: boolean; readonly can: (permission: string) => boolean; readonly onCapital: () => void; readonly c: C }) {
  return <>
    {hasMoney ? <Done>{c("The company's first money is recorded.", "نخستین پول شرکت ثبت شده است.")}</Done> : null}
    <p>{c("How is the company getting its first money?", "شرکت نخستین پولش را چگونه به دست می‌آورد؟")}</p>
    <div className="gs-choices">
      <article className="gs-choice"><span><strong>{c("Shareholder capital", "سرمایهٔ سهامدار")}</strong>
        <small>{c("A shareholder is investing money into the company now. It is theirs as ownership and is not repaid.", "سهامداری اکنون پول در شرکت سرمایه‌گذاری می‌کند. این مالکیت اوست و بازپرداخت نمی‌شود.")}</small>
        <button type="button" className="treasury-button gold" onClick={onCapital}>{c("Record shareholder capital", "ثبت سرمایهٔ سهامدار")}</button></span></article>
      <article className="gs-choice"><span><strong>{c("Shareholder or provider loan", "قرض سهامدار یا تأمین‌کننده")}</strong>
        <small>{c("Money that must be repaid. It is recorded as temporary funding owed back to the provider.", "پولی که باید پس داده شود. به‌عنوان تمویل موقت که به تأمین‌کننده بدهکار هستیم ثبت می‌شود.")}</small>
        {can("finance.temporary-funding.record") ? <Link className="treasury-button" href="/finance/temporary-funding">{c("Open temporary funding", "باز کردن تمویل موقت")}</Link> : null}</span></article>
      <article className="gs-choice"><span><strong>{c("Opening balance", "موجودی افتتاحیه")}</strong>
        <small>{c("Only when the company already held this money before it started using Al-Beruniy. It is not new capital.", "فقط وقتی شرکت پیش از آغاز استفاده از البیرونی این پول را داشته است. این سرمایهٔ تازه نیست.")}</small>
        {can("treasury.opening-balance.record") ? <Link className="treasury-button" href="/finance/safes">{c("Record an opening balance on the Safes page", "ثبت موجودی افتتاحیه در صفحهٔ صندوق‌ها")}</Link> : null}</span></article>
    </div>
  </>;
}

function FirstTransactionStep({ capital, capitalLoad, trialBalance, hasMoney, balanced, baseCurrency, busy, run, c, locale }: {
  readonly capital: DirectCapitalWorkspace | null; readonly capitalLoad: Load<DirectCapitalWorkspace>; readonly trialBalance: TrialBalanceView | null; readonly hasMoney: boolean;
  readonly balanced: boolean; readonly baseCurrency: string | null; readonly busy: boolean; readonly run: Run; readonly c: C; readonly locale: "en" | "fa";
}) {
  const [form, setForm] = useState({ name: "", agreed: "", amount: "", destination: "", date: kabulToday() });
  const [confirming, setConfirming] = useState(false);
  const [reference, setReference] = useState<string | null>(null);
  const request = useRef<{ idempotencyKey: string; correlationId: string } | null>(null);
  const destinations = (capital?.destinations ?? []).filter((destination) => destination.currency === baseCurrency);
  const destination = form.destination || destinations[0]?.id || "";
  const destinationName = destinations.find((item) => item.id === destination)?.name ?? "";
  const valid = form.name.trim().length >= 2 && /^\d+(\.\d{1,2})?$/.test(form.amount.trim()) && Number(form.amount) > 0 && destination !== ""
    && (form.agreed.trim() === "" || /^\d+(\.\d{1,2})?$/.test(form.agreed.trim()));
  const safe = destinations.find((item) => item.id === destination) ?? destinations[0];
  const holders = capital?.shareholders ?? [];
  const contributedTotal = holders.flatMap((holder) => holder.capitals).filter((item) => item.currency === baseCurrency).reduce((sum, item) => sum + Number(item.contributed), 0);
  const record = () => run(async () => {
    request.current ??= keys();
    const result = await api<DirectCapitalResult>("/api/v1/shareholder/capital", "POST", {
      action: "add-shareholder", displayName: form.name.trim(), agreedTotal: form.agreed.trim() || null, currencyCode: form.agreed.trim() ? baseCurrency : null,
      externalReference: null, note: null, businessDate: kabulToday(),
      firstContribution: { fundingMethod: "CASH", amount: form.amount.trim(), currencyCode: baseCurrency, receiptDate: form.date, destinationAccountId: destination,
        providerName: null, itemDescription: null, expenseLedgerAccountId: null, paymentReference: null, note: null },
      ...request.current });
    if (!result.ok) { if (result.status !== 0 && result.error.code !== "NETWORK") request.current = null; return { ok: false, text: errorText(result.error, locale) }; }
    request.current = null; setConfirming(false);
    setReference(result.data.firstReceipt?.reference ?? result.data.reference ?? null);
    return { ok: true, text: c("Capital recorded.", "سرمایه ثبت شد.") };
  });
  if (hasMoney) return <>
    {balanced ? <Done>{c("Your first transaction is posted and balanced.", "نخستین معاملهٔ شما ثبت شد و متوازن است.")}</Done>
      : <p className="treasury-message" role="note">{c("Money is recorded, but the trial balance is not available to you or does not balance yet.", "پول ثبت شده است، اما بیلانس آزمایشی برای شما در دسترس نیست یا هنوز متوازن نیست.")}</p>}
    <dl className="gs-facts">
      {safe ? <div><dt>{c("Safe balance", "موجودی صندوق")}</dt><dd>{safe.name}: {safe.balance !== null ? money(safe.balance, safe.currency) : "—"}</dd></div> : null}
      <div><dt>{c("Capital put in", "سرمایهٔ واریزشده")}</dt><dd>{baseCurrency ? money(String(contributedTotal), baseCurrency) : "—"}</dd></div>
      {reference ? <div><dt>{c("Journal reference", "مرجع ژورنال")}</dt><dd dir="ltr">{reference}</dd></div> : null}
      <div><dt>{c("Trial balance", "بیلانس آزمایشی")}</dt><dd>{trialBalance ? (trialBalance.balanced ? c("Balanced: debits equal credits", "متوازن: بدهکار برابر بستانکار") : c("Not balanced", "نامتوازن"))
        : "—"} <Link href="/finance/trial-balance">{c("View", "دیدن")}</Link></dd></div>
    </dl>
  </>;
  if (capitalLoad.state === "loading") return <p className="treasury-placeholder">{c("Loading…", "در حال بارگذاری…")}</p>;
  if (!capital || !capital.permissions.canReceive) return <NeedsAccess what={c("permission to add shareholders and record their capital", "صلاحیت افزودن سهامدار و ثبت سرمایه")} c={c} />;
  if (!capital.receiveAvailable) return <p className="treasury-message" role="note">{c("Capital cannot be recorded yet. Finish the earlier steps: how the company works (shareholder capital), the shareholder capital account and a Safe.",
    "هنوز نمی‌توان سرمایه ثبت کرد. مرحله‌های پیشین را کامل کنید: شیوه کار (سرمایهٔ سهامدار)، حساب سرمایهٔ سهامدار و یک صندوق.")} <Link href="/shareholders">{c("Shareholders", "سهامداران")}</Link></p>;
  if (confirming) return <div className="gs-plan" role="region" aria-label={c("Confirm the capital receipt", "تأیید دریافت سرمایه")}>
    <p><strong>{c(`Record ${money(form.amount.trim(), baseCurrency ?? "")} of shareholder capital from ${form.name.trim()} into ${destinationName} on ${form.date}?`,
      `${money(form.amount.trim(), baseCurrency ?? "")} سرمایهٔ سهامدار از ${form.name.trim()} به ${destinationName} در ${form.date} ثبت شود؟`)}</strong></p>
    <p className="admin-hint">{c("This posts one balanced journal: the Safe goes up and shareholder capital goes up by the same amount. A posted journal is never edited; a mistake is corrected with a reversal.",
      "این یک ژورنال متوازن ثبت می‌کند: صندوق و سرمایهٔ سهامدار به یک اندازه افزایش می‌یابند. ژورنال ثبت‌شده هرگز ویرایش نمی‌شود؛ اشتباه با برگشت اصلاح می‌شود.")}</p>
    <button type="button" className="treasury-button gold" disabled={busy} onClick={() => void record()}>{busy ? c("Recording…", "در حال ثبت…") : c("Confirm and record", "تأیید و ثبت")}</button>{" "}
    <button type="button" className="treasury-button" disabled={busy} onClick={() => setConfirming(false)}>{c("Change", "تغییر")}</button>
  </div>;
  return <form className="admin-form" aria-label={c("Record shareholder capital", "ثبت سرمایهٔ سهامدار")} onSubmit={(event) => { event.preventDefault(); if (valid) setConfirming(true); }}>
    <label><span>{c("Shareholder name", "نام سهامدار")}</span><input value={form.name} required maxLength={160} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
    <label><span>{c("Agreed capital (optional)", "سرمایهٔ توافق‌شده (اختیاری)")}</span><input value={form.agreed} inputMode="decimal" onChange={(event) => setForm({ ...form, agreed: event.target.value })} /></label>
    <label><span>{c(`Amount received now (${baseCurrency ?? ""})`, `مبلغ دریافتی اکنون (${baseCurrency ?? ""})`)}</span><input value={form.amount} inputMode="decimal" required onChange={(event) => setForm({ ...form, amount: event.target.value })} /></label>
    <label><span>{c("Safe it went into", "صندوقی که به آن رفت")}</span><select value={destination} required onChange={(event) => setForm({ ...form, destination: event.target.value })}>
      {destinations.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.currency}</option>)}</select></label>
    <label><span>{c("Date", "تاریخ")}</span><input type="date" value={form.date} required onChange={(event) => setForm({ ...form, date: event.target.value })} /></label>
    <button type="submit" className="treasury-button gold" disabled={busy || !valid}>{c("Review", "بازبینی")}</button>
  </form>;
}

function ReadyStep({ states, balanced, mode, secondApprover, c }: {
  readonly states: Readonly<Record<StepKey, StepState>>; readonly balanced: boolean; readonly mode: OperatingMode | "MIXED" | "NOT_CHOSEN" | null;
  readonly secondApprover: "verified" | "missing" | "unverified"; readonly c: C;
}) {
  const rows: readonly [string, boolean][] = [
    [c("Financial year", "سال مالی"), states.year === "done"], [c("Chart of Accounts", "جدول حساب‌ها"), states.accounts === "done"],
    [c("Safe", "صندوق"), states.treasury === "done"], [c("Finance permissions", "صلاحیت‌های مالی"), states.access === "done"],
    [mode === "ADVANCED" ? c("Posting policy (Advanced Controls, second approver)", "سیاست ثبت (کنترل‌های پیشرفته، تأییدکنندهٔ دوم)") : c("Posting policy", "سیاست ثبت"), states.mode === "done"],
    [c("First transaction", "نخستین معامله"), states.first === "done"], [c("General Ledger balanced", "دفتر کل متوازن"), balanced]];
  const all = rows.every(([, done]) => done);
  return <>
    {all ? <Done>{c("Setup is complete. Your company is ready for daily work.", "تنظیم کامل است. شرکت شما برای کار روزانه آماده است.")}</Done> : null}
    <ul className="gs-checklist" aria-label={c("Readiness", "آمادگی")}>
      {rows.map(([label, done]) => <li key={label} className={done ? "ready" : "missing"}><strong>{done ? "✓" : "○"} {label}</strong></li>)}
    </ul>
    {mode === "ADVANCED" && secondApprover !== "verified" ? <p className="admin-hint" role="note">{c("Advanced Controls needs a second Finance person who can approve before setup counts as complete.",
      "کنترل‌های پیشرفته پیش از کامل شمردن تنظیم به شخص مالی دومی برای تأیید نیاز دارد.")}</p> : null}
    <div className="gs-ready-actions">
      <Link className="treasury-button gold" href="/finance/safes">{c("Receive money", "دریافت پول")}</Link>
      <Link className="treasury-button" href="/finance/record-expense">{c("Record expense", "ثبت مصرف")}</Link>
      <Link className="treasury-button" href="/finance/safes">{c("Transfer", "انتقال")}</Link>
      <Link className="treasury-button" href="/shareholders">{c("Add shareholder", "افزودن سهامدار")}</Link>
      <Link className="treasury-button" href="/finance/trial-balance">{c("View Trial Balance", "دیدن بیلانس آزمایشی")}</Link>
    </div>
  </>;
}
