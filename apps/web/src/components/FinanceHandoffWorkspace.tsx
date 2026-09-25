"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { AppIcon } from "@/components/AppIcon";
import { useLocale } from "@/components/LocaleProvider";
import { useSession } from "@/components/SessionProvider";
import { SignInPrompt } from "@/components/SignInPrompt";
import { StageZeroPageHeader, localized } from "@/components/StageZeroWorkspace";
import type { FinanceApiResponse, FinanceHandoffTraceView, FinanceHandoffWorkspaceView, FinanceWorkflowStage } from "@/lib/finance-handoff-types";

type Copy = { readonly en: string; readonly fa: string };
type Translate = (copy: Copy) => string;
type FinanceAction = "prepare" | "approve" | "post";

async function call<T>(url: string, init?: RequestInit): Promise<FinanceApiResponse<T>> {
  const response = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) }, cache: "no-store" });
  try { return await response.json() as FinanceApiResponse<T>; }
  catch { return { ok: false, error: { code: "INVALID_RESPONSE", message: `Unreadable server response (${response.status}).` } }; }
}

/**
 * The five stages an employee needs to tell apart. Recorded, Verified and Handed to Finance are
 * Treasury's; Approved and Posted are Finance's. Every receipt in this inbox has already passed the
 * first three, because only verified handoffs reach Finance.
 */
const JOURNEY: readonly { readonly key: string; readonly label: Copy; readonly owner: Copy }[] = [
  { key: "recorded", label: { en: "Recorded", fa: "ثبت شد" }, owner: { en: "Treasury cashier", fa: "صندوقدار خزانه" } },
  { key: "verified", label: { en: "Verified", fa: "تایید شد" }, owner: { en: "Independent Treasury verifier", fa: "تاییدکننده مستقل خزانه" } },
  { key: "handed", label: { en: "Handed to Finance", fa: "به مالی تحویل شد" }, owner: { en: "Treasury verifier", fa: "تاییدکننده خزانه" } },
  { key: "approved", label: { en: "Approved", fa: "تصویب شد" }, owner: { en: "Independent Finance approver", fa: "تصویب‌کننده مستقل مالی" } },
  { key: "posted", label: { en: "Posted", fa: "در دفتر ثبت شد" }, owner: { en: "Finance, through the restricted gateway", fa: "مالی، از طریق دروازه محدود" } }
];

/** How many journey stages are complete for each Finance workflow stage. */
const COMPLETED: Readonly<Record<FinanceWorkflowStage, number>> = { HANDED_TO_FINANCE: 3, PENDING_APPROVAL: 3, APPROVED: 4, POSTED: 5 };

const STAGE_COPY: Readonly<Record<FinanceWorkflowStage, Copy>> = {
  HANDED_TO_FINANCE: { en: "Handed to Finance · needs preparation", fa: "به مالی تحویل شد · نیاز به آماده‌سازی" },
  PENDING_APPROVAL: { en: "Prepared · awaiting independent approval", fa: "آماده شد · در انتظار تصویب مستقل" },
  APPROVED: { en: "Approved · ready to post", fa: "تصویب شد · آماده ثبت در دفتر" },
  POSTED: { en: "Posted to the General Ledger", fa: "در دفتر کل ثبت شد" }
};

const NEXT_STEP: Readonly<Record<FinanceWorkflowStage, Copy>> = {
  HANDED_TO_FINANCE: { en: "Next: a Finance preparer checks the evidence below and prepares the journal for approval.", fa: "گام بعدی: آماده‌کننده مالی شواهد زیر را بررسی کرده و ژورنال را برای تصویب آماده می‌کند." },
  PENDING_APPROVAL: { en: "Next: a different Finance user, who did not prepare it, reviews and approves it.", fa: "گام بعدی: کاربر دیگر مالی که آن را آماده نکرده است، بررسی و تصویب می‌کند." },
  APPROVED: { en: "Next: an authorized Finance user posts the approved journal. Posting is final.", fa: "گام بعدی: کاربر مجاز مالی ژورنال تصویب‌شده را ثبت می‌کند. ثبت نهایی است." },
  POSTED: { en: "Complete. The journal is posted and reconciles to the receipt and the shareholder installment.", fa: "تکمیل شد. ژورنال ثبت شده و با رسید و قسط سهامدار تطبیق دارد." }
};

const PERMISSION_COPY: Readonly<Record<string, Copy>> = {
  "finance.posting-intent.create": { en: "Can prepare", fa: "می‌تواند آماده کند" },
  "finance.posting-intent.approve": { en: "Can approve", fa: "می‌تواند تصویب کند" },
  "finance.journal.post": { en: "Can post", fa: "می‌تواند ثبت کند" },
  "finance.report.operational.read": { en: "Can view reports", fa: "می‌تواند گزارش‌ها را ببیند" }
};

/** Database statuses shown in the reconciliation, in words. Unknown codes are shown as they are. */
const STATUS_COPY: Readonly<Record<string, Copy>> = {
  ELIGIBLE: { en: "Open for receipt", fa: "آماده دریافت" },
  VERIFIED: { en: "Verified", fa: "تایید شد" },
  TREASURY_VERIFIED: { en: "Cash verified by Treasury", fa: "نقد توسط خزانه تایید شد" },
  POSTED: { en: "Posted", fa: "ثبت شد" },
  NOT_POSTED: { en: "Not posted yet", fa: "هنوز ثبت نشده" },
  HANDED_TO_FINANCE: { en: "With Finance", fa: "نزد مالی" },
  APPROVED_BY_FINANCE: { en: "Approved by Finance", fa: "توسط مالی تصویب شد" },
  POSTED_BY_FINANCE: { en: "Posted by Finance", fa: "توسط مالی ثبت شد" },
  PENDING_APPROVAL: { en: "Awaiting approval", fa: "در انتظار تصویب" },
  APPROVED: { en: "Approved", fa: "تصویب شد" }
};

const SUCCESS: Readonly<Record<FinanceAction, Copy>> = {
  prepare: { en: "Prepared. The journal now waits for approval by a different Finance user.", fa: "آماده شد. ژورنال اکنون منتظر تصویب کاربر دیگر مالی است." },
  approve: { en: "Approved. The journal can now be posted.", fa: "تصویب شد. اکنون ژورنال قابل ثبت است." },
  post: { en: "Posted. The journal is in the General Ledger and reconciled below.", fa: "ثبت شد. ژورنال در دفتر کل است و در پایین تطبیق شده است." }
};

export function FinanceHandoffWorkspace() {
  const { locale } = useLocale();
  const t = useCallback((copy: Copy) => localized(copy, locale), [locale]);
  const [workspace, setWorkspace] = useState<FinanceHandoffWorkspaceView | null>(null);
  const [trace, setTrace] = useState<FinanceHandoffTraceView | null>(null);
  const [state, setState] = useState<"loading" | "signed-out" | "ready" | "error">("loading");
  const [message, setMessage] = useState<{ readonly tone: "ok" | "error"; readonly text: string | Copy } | null>(null);
  const [busy, setBusy] = useState(false);
  const session = useSession();

  const applyWorkspace = useCallback((result: FinanceApiResponse<FinanceHandoffWorkspaceView>) => {
    if (result.ok) { setWorkspace(result.data); setState("ready"); }
    else { setWorkspace(null); setState(result.error.code === "AUTHENTICATION_REQUIRED" ? "signed-out" : "error"); setMessage({ tone: "error", text: result.error.message }); }
  }, []);
  const load = useCallback(async () => applyWorkspace(await call<FinanceHandoffWorkspaceView>("/api/v1/finance/handoffs")), [applyWorkspace]);
  useEffect(() => { let current = true; void call<FinanceHandoffWorkspaceView>("/api/v1/finance/handoffs").then(result => { if (current) applyWorkspace(result); }); return () => { current = false; }; }, [applyWorkspace]);

  const select = async (id: string) => {
    const result = await call<FinanceHandoffTraceView>(`/api/v1/finance/handoffs/${id}`);
    if (result.ok) setTrace(result.data); else setMessage({ tone: "error", text: result.error.message });
  };
  const act = async (action: FinanceAction) => {
    if (!trace || !workspace) return;
    const period = workspace.openPeriods[0];
    if (!period) { setMessage({ tone: "error", text: t({ en: "No open accounting period is available. Finance policy configuration is required.", fa: "هیچ دوره حسابداری باز موجود نیست. پیکربندی پالیسی مالی لازم است." }) }); return; }
    setBusy(true); setMessage(null);
    const result = await call<Record<string, string>>(`/api/v1/finance/handoffs/${trace.id}/${action}`, {
      method: "POST",
      body: JSON.stringify({ accountingPeriodId: period.id, postingIntentId: trace.postingIntent?.id ?? "", idempotencyKey: `finance-handoff:${trace.id}` })
    });
    setBusy(false);
    if (!result.ok) { setMessage({ tone: "error", text: `${refusalLead(result.error.code, t)} ${result.error.message}` }); return; }
    setMessage({ tone: "ok", text: SUCCESS[action] });
    await load(); await select(trace.id);
  };
  const signOut = async () => {
    await call("/api/v1/treasury/session", { method: "DELETE" });
    setWorkspace(null); setTrace(null); setMessage(null); setState("signed-out");
  };

  return <div className="module-workspace finance-handoff-workspace">
    <StageZeroPageHeader icon="finance" eyebrow={{ en: "Finance · E1 synthetic sandbox", fa: "مالی · محیط آزمایشی مصنوعی E1" }} title={{ en: "Treasury handoffs", fa: "تحویل‌های خزانه به مالی" }} description={{ en: "Cash that Treasury counted and verified arrives here. Finance prepares the journal, a second person approves it, and only then is it posted and reconciled.", fa: "نقدی که خزانه شمرده و تایید کرده اینجا می‌رسد. مالی ژورنال را آماده می‌کند، شخص دوم آن را تصویب می‌کند و تنها پس از آن ثبت و تطبیق می‌شود." }}>
      <Link className="module-quiet-button" href="/finance/treasury"><AppIcon name="chevron" size={15}/>{t({ en: "Treasury", fa: "خزانه" })}</Link>
    </StageZeroPageHeader>
    <section className="finance-boundary-banner"><span><AppIcon name="shield" size={22}/></span><div><p>{t({ en: "SYNTHETIC SANDBOX DATA ONLY", fa: "فقط داده‌های آزمایشی مصنوعی" })}</p><strong>{t({ en: "No real money or company records. Each step is performed by a separate person and checked by the database.", fa: "هیچ پول یا سوابق واقعی شرکت وجود ندارد. هر گام توسط شخص جداگانه انجام و توسط دیتابیس کنترل می‌شود." })}</strong></div><em>E1 · NOT PRODUCTION</em></section>
    {message ? <div className={`treasury-message ${message.tone === "ok" ? "success" : "error"}`} role="status"><AppIcon name={message.tone === "ok" ? "shield" : "alert"} size={16}/><span>{typeof message.text === "string" ? message.text : t(message.text)}</span><button onClick={() => setMessage(null)} aria-label={t({ en: "Dismiss", fa: "بستن" })}>×</button></div> : null}
    {state === "loading" ? <div className="treasury-card treasury-placeholder">{t({ en: "Loading the Finance inbox…", fa: "در حال بارگذاری صندوق مالی…" })}</div> : null}
    {state === "signed-out" ? <SignInPrompt area={{ en: "the Finance inbox", fa: "صندوق مالی" }}><FinanceSignIn onDone={async () => { setMessage(null); await load(); await session.refresh(); }} t={t}/></SignInPrompt> : null}
    {state === "error" && message ? <div className="treasury-card treasury-placeholder">{typeof message.text === "string" ? message.text : t(message.text)}</div> : null}
    {state === "ready" && workspace ? <>
      <section className="treasury-identity">
        <span className="treasury-avatar" aria-hidden="true">{signedInName(workspace.actor, session.user, t).split(" ").map(x => x[0]).slice(-2).join("")}</span>
        <div><small>{t({ en: "Signed in as", fa: "وارد شده به عنوان" })}</small><strong>{signedInName(workspace.actor, session.user, t)}</strong></div>
        <span className="finance-permissions">{workspace.actor.permissions.length === 0 ? t({ en: "No Finance permissions", fa: "بدون صلاحیت مالی" }) : workspace.actor.permissions.map(permission => <em key={permission} className="treasury-chip">{PERMISSION_COPY[permission] ? t(PERMISSION_COPY[permission]) : permission}</em>)}</span>
        <button type="button" className="treasury-button quiet" onClick={() => void signOut()}>{t({ en: "Sign out", fa: "خروج" })}</button>
      </section>
      <section className="finance-handoff-grid">
        <div className="module-content-card finance-handoff-list"><div className="module-card-heading"><div><p>{t({ en: "FINANCE INBOX", fa: "صندوق مالی" })}</p><h2>{t({ en: "Verified cash from Treasury", fa: "نقد تاییدشده از خزانه" })}</h2></div><span>{workspace.handoffs.length}</span></div>
          {workspace.handoffs.length === 0 ? <div className="treasury-placeholder">{t({ en: "Nothing has been handed to Finance yet.", fa: "هنوز چیزی به مالی تحویل نشده است." })}</div> : workspace.handoffs.map(item => <button key={item.id} className={trace?.id === item.id ? "selected" : ""} onClick={() => void select(item.id)}><span><strong>{item.receiptReference}</strong><small>{item.agreementReference} · {t({ en: "installment", fa: "قسط" })} {item.installmentSequence}</small></span><b>{item.currency} {formatAmount(item.amount)}</b><em className={`treasury-chip finance-stage-${item.stage.toLowerCase()}`}>{t(STAGE_COPY[item.stage])}</em></button>)}
        </div>
        <aside className="module-content-card finance-handoff-trace">{trace ? <Trace trace={trace} actorId={workspace.actor.userAccountId} permissions={workspace.actor.permissions} period={workspace.openPeriods[0]?.label} busy={busy} onAction={act} t={t}/> : <div className="treasury-placeholder"><AppIcon name="documents" size={24}/><p>{t({ en: "Choose a receipt on the left to see where the money came from, who counted and verified it, and what Finance has done with it.", fa: "یک رسید را از سمت چپ انتخاب کنید تا ببینید پول از کجا آمده، چه کسی آن را شمرده و تایید کرده و مالی با آن چه کرده است." })}</p></div>}</aside>
      </section>
    </> : null}
  </div>;
}

function Trace({ trace, actorId, permissions, period, busy, onAction, t }: { readonly trace: FinanceHandoffTraceView; readonly actorId: string; readonly permissions: readonly string[]; readonly period: string | undefined; readonly busy: boolean; readonly onAction: (action: FinanceAction) => Promise<void>; readonly t: Translate }) {
  const done = COMPLETED[trace.stage];
  const person = personLabeller(actorId, t);
  const rows: readonly (readonly [Copy, string])[] = [
    [{ en: "Shareholder", fa: "سهامدار" }, trace.shareholder],
    [{ en: "Capital agreement", fa: "قرارداد سرمایه" }, `${trace.agreementReference} · ${t({ en: "installment", fa: "قسط" })} ${trace.installmentSequence}`],
    [{ en: "Received into", fa: "دریافت شده در" }, trace.receivingAccount],
    [{ en: "Physically counted", fa: "شمارش فزیکی" }, `${trace.currency} ${formatAmount(trace.physicalCount.amount)}`],
    [{ en: "Counted by / confirmed by", fa: "شمرده توسط / تایید توسط" }, `${person(trace.physicalCount.countedBy)} / ${person(trace.physicalCount.confirmedBy)}`],
    [{ en: "Verified by (Treasury)", fa: "تایید توسط (خزانه)" }, person(trace.verifier)],
    [{ en: "Handed to Finance by", fa: "تحویل به مالی توسط" }, person(trace.handedOffBy)],
    [{ en: "Receipt evidence", fa: "سند رسید" }, evidenceText(trace.receiptEvidence, t)],
    [{ en: "Count evidence", fa: "سند شمارش" }, evidenceText(trace.physicalCount.evidence, t)]
  ];
  const canCreate = permissions.includes("finance.posting-intent.create") && !trace.postingIntent;
  const canApprove = permissions.includes("finance.posting-intent.approve") && trace.postingIntent?.status === "PENDING_APPROVAL";
  // A posted intent can keep its APPROVED status, so the journal itself decides whether posting is done.
  const canPost = permissions.includes("finance.journal.post") && trace.postingIntent?.status === "APPROVED" && !trace.journal;
  const balanced = trace.journal !== undefined && sameAmount(trace.journal.debit, trace.journal.credit) && sameAmount(trace.journal.debit, trace.amount);

  return <>
    <div className="module-card-heading"><div><p>{t({ en: "RECEIPT", fa: "رسید" })}</p><h2>{trace.receiptReference}</h2></div><span className="finance-amount">{trace.currency} {formatAmount(trace.amount)}</span></div>
    <ol className="finance-journey" aria-label={t({ en: "Progress", fa: "پیشرفت" })}>
      {JOURNEY.map((step, index) => <li key={step.key} className={index < done ? "done" : index === done ? "current" : ""} aria-current={index === done ? "step" : undefined}>
        <span aria-hidden="true">{index < done ? "✓" : index + 1}</span><strong>{t(step.label)}</strong><small>{t(step.owner)}</small>
      </li>)}
    </ol>
    <p className="finance-next-step"><AppIcon name="chevron" size={14}/>{t(NEXT_STEP[trace.stage])}</p>
    {person.anonymous() ? <p className="finance-names-note">{t({ en: "People are shown as Person A, B, C… so you can see that different people did each step. The Finance database does not return names yet.", fa: "اشخاص به صورت شخص الف، ب، ج… نشان داده می‌شوند تا ببینید هر گام را شخص متفاوتی انجام داده است. دیتابیس مالی هنوز نام‌ها را برنمی‌گرداند." })}</p> : null}
    <dl>{rows.map(([key, value]) => <div key={key.en}><dt>{t(key)}</dt><dd>{value}</dd></div>)}</dl>
    {trace.postingIntent || trace.approval || trace.journal ? <ul className="finance-records">
      {trace.postingIntent ? <li><strong>{t({ en: "Prepared", fa: "آماده شد" })}</strong><span>{person(trace.postingIntent.createdBy)} · {t({ en: "accounting date", fa: "تاریخ حسابداری" })} {trace.postingIntent.accountingEffectiveDate}</span></li> : null}
      {trace.approval ? <li><strong>{t({ en: "Approved", fa: "تصویب شد" })}</strong><span>{person(trace.approval.approver)} · {formatTime(trace.approval.approvedAt)}</span></li> : null}
      {trace.journal ? <li><strong>{t({ en: "Posted journal", fa: "ژورنال ثبت‌شده" })}</strong><span>{trace.journal.reference} · {formatTime(trace.journal.postedAt)}</span></li> : null}
    </ul> : null}
    {trace.journal ? <div className="finance-journal">
      <table><thead><tr><th>{t({ en: "Journal", fa: "ژورنال" })} {trace.journal.reference}</th><th>{t({ en: "Debit", fa: "بدهکار" })}</th><th>{t({ en: "Credit", fa: "بستانکار" })}</th></tr></thead>
        <tbody><tr><td>{t({ en: "Total", fa: "مجموع" })} ({trace.currency})</td><td>{formatAmount(trace.journal.debit)}</td><td>{formatAmount(trace.journal.credit)}</td></tr></tbody></table>
      <p className={balanced ? "ok" : "warn"}>{balanced ? t({ en: "Balanced: debits equal credits and equal the verified cash received.", fa: "متوازن: بدهکار برابر بستانکار و برابر نقد تاییدشده دریافتی است." }) : t({ en: "Not balanced against the verified receipt. Do not rely on this journal; report it to Finance.", fa: "با رسید تاییدشده متوازن نیست. به این ژورنال اعتماد نکنید و به مالی گزارش دهید." })}</p>
    </div> : null}
    <div className="finance-reconciliation"><strong>{t({ en: "Reconciliation", fa: "تطبیق" })}</strong>
      <span><small>{t({ en: "Shareholder installment", fa: "قسط سهامدار" })}</small>{statusText(trace.reconciliation.sourceStatus, t)}</span>
      <span><small>{t({ en: "Treasury receipt", fa: "رسید خزانه" })}</small>{statusText(trace.reconciliation.receiptStatus, t)}</span>
      <span><small>{t({ en: "General Ledger", fa: "دفتر کل" })}</small>{statusText(trace.reconciliation.journalStatus, t)}</span>
    </div>
    <div className="finance-handoff-actions">
      {canCreate ? <ActionButton busy={busy} onClick={() => void onAction("prepare")} label={{ en: "Prepare journal for approval", fa: "آماده‌سازی ژورنال برای تصویب" }} hint={period ? { en: `Accounting period ${period}`, fa: `دوره حسابداری ${period}` } : undefined} t={t}/> : null}
      {canApprove ? <ActionButton busy={busy} onClick={() => void onAction("approve")} label={{ en: "Approve (independent review)", fa: "تصویب (بررسی مستقل)" }} hint={{ en: "The database refuses approval by the person who prepared it.", fa: "دیتابیس تصویب توسط آماده‌کننده را رد می‌کند." }} t={t}/> : null}
      {canPost ? <ActionButton busy={busy} onClick={() => void onAction("post")} label={{ en: "Post to General Ledger", fa: "ثبت در دفتر کل" }} hint={{ en: "Final. A posted journal cannot be edited.", fa: "نهایی. ژورنال ثبت‌شده قابل ویرایش نیست." }} t={t}/> : null}
      {!canCreate && !canApprove && !canPost && trace.stage !== "POSTED" ? <p className="finance-waiting">{t({ en: "There is nothing for you to do on this receipt. Another Finance user must take the next step.", fa: "برای شما در این رسید کاری وجود ندارد. کاربر دیگر مالی باید گام بعدی را بردارد." })}</p> : null}
    </div>
  </>;
}

function ActionButton({ busy, onClick, label, hint, t }: { readonly busy: boolean; readonly onClick: () => void; readonly label: Copy; readonly hint: Copy | undefined; readonly t: Translate }) {
  return <div className="finance-action"><button type="button" disabled={busy} onClick={onClick}>{t(label)}</button>{hint ? <small>{t(hint)}</small> : null}</div>;
}

function FinanceSignIn({ onDone, t }: { readonly onDone: () => Promise<void>; readonly t: Translate }) {
  const [token, setToken] = useState(""); const [error, setError] = useState("");
  const submit = async (event: FormEvent) => { event.preventDefault(); const result = await call("/api/v1/treasury/session", { method: "POST", body: JSON.stringify({ token }) }); if (result.ok) await onDone(); else setError(result.error.message); };
  return <form className="treasury-card treasury-signin" onSubmit={event => void submit(event)}><AppIcon name="shield" size={24}/>
    <div><h2>{t({ en: "Developer token", fa: "توکن توسعه‌دهنده" })}</h2>
      <p>{t({ en: "Paste the test token of a synthetic Finance person. Test tokens exist only for this development sandbox; they are not how employees will sign in to the real system.", fa: "توکن آزمایشی یک شخص مصنوعی مالی را وارد کنید. توکن‌های آزمایشی فقط برای این محیط توسعه هستند و روش ورود کارمندان به سیستم واقعی نیستند." })}</p></div>
    <label><span>{t({ en: "Sandbox token", fa: "توکن آزمایشی" })}</span><input type="password" value={token} onChange={event => setToken(event.target.value)} required minLength={32} autoComplete="off"/></label>
    <button className="treasury-button" type="submit">{t({ en: "Sign in", fa: "ورود" })}</button>{error ? <p role="alert">{error}</p> : null}</form>;
}

function refusalLead(code: string, t: Translate): string {
  if (code === "SEGREGATION_OF_DUTIES_VIOLATION" || code === "PERMISSION_DENIED") return t({ en: "Refused — this needs a different person or permission.", fa: "رد شد — این کار به شخص یا صلاحیت دیگر نیاز دارد." });
  if (code === "AUTHENTICATION_REQUIRED") return t({ en: "Your session ended. Sign in again.", fa: "نشست شما پایان یافت. دوباره وارد شوید." });
  return t({ en: "Refused.", fa: "رد شد." });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LETTERS = { en: ["A", "B", "C", "D", "E", "F", "G"], fa: ["الف", "ب", "ج", "د", "ه", "و", "ز"] };

/**
 * The Finance functions return user account ids where names are expected. An id means nothing to
 * an employee, but whether two steps were done by the same person does, so ids become stable
 * "Person A/B/C" labels within one receipt, and the signed-in user becomes "you".
 */
function personLabeller(actorId: string, t: Translate): ((value: string) => string) & { readonly anonymous: () => boolean } {
  const seen = new Map<string, number>();
  let anonymous = false;
  const label = (value: string): string => {
    if (!UUID.test(value)) return value;
    anonymous = true;
    if (value === actorId) return t({ en: "You", fa: "شما" });
    if (!seen.has(value)) seen.set(value, seen.size);
    const index = seen.get(value) ?? 0;
    return t({ en: `Person ${LETTERS.en[index] ?? index + 1}`, fa: `شخص ${LETTERS.fa[index] ?? index + 1}` });
  };
  return Object.assign(label, { anonymous: () => anonymous });
}

/** The signed-in person's own name from the session when it is the same person, else a role title. */
function signedInName(actor: FinanceHandoffWorkspaceView["actor"], user: { readonly userAccountId: string; readonly displayName: string } | null, t: Translate): string {
  return user !== null && user.userAccountId === actor.userAccountId ? user.displayName : actorTitle(actor, t);
}

/** The signed-in Finance person, named when the database provides a name, otherwise by role. */
function actorTitle(actor: FinanceHandoffWorkspaceView["actor"], t: Translate): string {
  if (!actor.displayName.startsWith("Finance user ")) return actor.displayName;
  if (actor.permissions.includes("finance.posting-intent.approve")) return t({ en: "Finance approver", fa: "تصویب‌کننده مالی" });
  if (actor.permissions.includes("finance.posting-intent.create")) return t({ en: "Finance preparer", fa: "آماده‌کننده مالی" });
  return t({ en: "Finance user", fa: "کاربر مالی" });
}

/** Evidence is shown as present or missing; its internal reference is not something an employee needs. */
function evidenceText(reference: string, t: Translate): string {
  return reference && reference !== "Evidence unavailable" ? t({ en: "On file ✓", fa: "موجود است ✓" }) : t({ en: "Missing", fa: "موجود نیست" });
}

function statusText(status: string, t: Translate): string {
  const copy = STATUS_COPY[status];
  return copy ? t(copy) : status.replaceAll("_", " ").toLowerCase();
}

function formatAmount(amount: string): string {
  const [whole = "0", fraction = ""] = String(amount).split(".");
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${fraction ? `.${fraction}` : ""}`;
}

function sameAmount(left: string, right: string): boolean {
  const normalize = (value: string) => { const [whole = "0", fraction = ""] = value.split("."); return `${whole.replace(/^0+(?=\d)/, "")}.${fraction.replace(/0+$/, "")}`; };
  return normalize(left) === normalize(right);
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}
