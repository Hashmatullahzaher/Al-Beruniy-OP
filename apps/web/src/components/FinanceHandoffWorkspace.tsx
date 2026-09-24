"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { AppIcon } from "@/components/AppIcon";
import { useLocale } from "@/components/LocaleProvider";
import { StageZeroPageHeader, localized } from "@/components/StageZeroWorkspace";
import type { FinanceApiResponse, FinanceHandoffTraceView, FinanceHandoffWorkspaceView } from "@/lib/finance-handoff-types";

type Copy = { readonly en: string; readonly fa: string };
async function call<T>(url: string, init?: RequestInit): Promise<FinanceApiResponse<T>> {
  const response = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) }, cache: "no-store" });
  try { return await response.json() as FinanceApiResponse<T>; }
  catch { return { ok: false, error: { code: "INVALID_RESPONSE", message: `Unreadable server response (${response.status}).` } }; }
}

export function FinanceHandoffWorkspace() {
  const { locale } = useLocale();
  const t = useCallback((copy: Copy) => localized(copy, locale), [locale]);
  const [workspace, setWorkspace] = useState<FinanceHandoffWorkspaceView | null>(null);
  const [trace, setTrace] = useState<FinanceHandoffTraceView | null>(null);
  const [state, setState] = useState<"loading" | "signed-out" | "ready" | "error">("loading");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const applyWorkspace = useCallback((result: FinanceApiResponse<FinanceHandoffWorkspaceView>) => {
    if (result.ok) { setWorkspace(result.data); setState("ready"); }
    else { setWorkspace(null); setState(result.error.code === "AUTHENTICATION_REQUIRED" ? "signed-out" : "error"); setMessage(result.error.message); }
  }, []);
  const load = useCallback(async () => applyWorkspace(await call<FinanceHandoffWorkspaceView>("/api/v1/finance/handoffs")), [applyWorkspace]);
  useEffect(() => { let current = true; void call<FinanceHandoffWorkspaceView>("/api/v1/finance/handoffs").then(result => { if (current) applyWorkspace(result); }); return () => { current = false; }; }, [applyWorkspace]);

  const select = async (id: string) => {
    setMessage("");
    const result = await call<FinanceHandoffTraceView>(`/api/v1/finance/handoffs/${id}`);
    if (result.ok) setTrace(result.data); else setMessage(result.error.message);
  };
  const act = async (action: "prepare" | "approve" | "post") => {
    if (!trace || !workspace) return;
    const period = workspace.openPeriods[0];
    if (!period) { setMessage(t({ en: "No open accounting period is available. Finance policy configuration is required.", fa: "هیچ دوره حسابداری باز موجود نیست. پیکربندی پالیسی مالی لازم است." })); return; }
    setBusy(true); setMessage("");
    const result = await call<Record<string, string>>(`/api/v1/finance/handoffs/${trace.id}/${action}`, {
      method: "POST",
      body: JSON.stringify({ accountingPeriodId: period.id, postingIntentId: trace.postingIntent?.id ?? "", idempotencyKey: `finance-handoff:${trace.id}` })
    });
    setBusy(false);
    if (!result.ok) { setMessage(`${result.error.code}: ${result.error.message}`); return; }
    setMessage(t({ en: "The controlled Finance operation committed successfully.", fa: "عملیات کنترل‌شده مالی با موفقیت ثبت شد." }));
    await load(); await select(trace.id);
  };

  return <div className="module-workspace finance-handoff-workspace">
    <StageZeroPageHeader icon="finance" eyebrow={{ en: "Finance · E1 synthetic sandbox", fa: "مالی · محیط آزمایشی مصنوعی E1" }} title={{ en: "Treasury handoffs", fa: "تحویل‌های خزانه به مالی" }} description={{ en: "Prepare, independently approve, securely post, and reconcile verified capital receipts.", fa: "آماده‌سازی، تصویب مستقل، ثبت امن و تطبیق دریافت‌های سرمایه تاییدشده." }}>
      <Link className="module-quiet-button" href="/finance"><AppIcon name="chevron" size={15}/>{t({ en: "Finance overview", fa: "نمای مالی" })}</Link>
    </StageZeroPageHeader>
    <section className="finance-boundary-banner"><span><AppIcon name="shield" size={22}/></span><div><p>SYNTHETIC SANDBOX DATA ONLY</p><strong>{t({ en: "Separate Finance identities and a restricted database credential govern every operation.", fa: "هویت‌های مستقل مالی و اعتبار محدود دیتابیس هر عملیات را کنترل می‌کند." })}</strong></div><em>E1 · NOT PRODUCTION</em></section>
    {message ? <div className="treasury-message error" role="status"><AppIcon name="alert" size={16}/><span>{message}</span><button onClick={() => setMessage("")} aria-label="Dismiss">×</button></div> : null}
    {state === "loading" ? <div className="treasury-card treasury-placeholder">{t({ en: "Loading controlled Finance workspace…", fa: "در حال بارگذاری فضای کنترل‌شده مالی…" })}</div> : null}
    {state === "signed-out" ? <FinanceSignIn onDone={load}/> : null}
    {state === "error" ? <div className="treasury-card treasury-placeholder">{message}</div> : null}
    {state === "ready" && workspace ? <>
      <section className="treasury-identity"><span className="treasury-avatar">{workspace.actor.displayName.split(" ").map(x => x[0]).slice(-2).join("")}</span><div><small>{t({ en: "Acting Finance persona", fa: "شخصیت فعال مالی" })}</small><strong>{workspace.actor.displayName}</strong><span>{workspace.actor.permissions.join(" · ") || "No Finance grants"}</span></div></section>
      <section className="finance-handoff-grid">
        <div className="module-content-card finance-handoff-list"><div className="module-card-heading"><div><p>CONTROLLED INBOX</p><h2>{t({ en: "Verified Treasury handoffs", fa: "تحویل‌های تاییدشده خزانه" })}</h2></div><span>{workspace.handoffs.length} DEMO</span></div>
          {workspace.handoffs.length === 0 ? <div className="treasury-placeholder">{t({ en: "No authorized handoffs are visible in this legal entity.", fa: "هیچ تحویل مجاز در این نهاد حقوقی قابل مشاهده نیست." })}</div> : workspace.handoffs.map(item => <button key={item.id} className={trace?.id === item.id ? "selected" : ""} onClick={() => void select(item.id)}><span><strong>{item.receiptReference}</strong><small>{item.shareholder} · {item.agreementReference}</small></span><b>{item.currency} {item.amount}</b><em className={`treasury-chip stage-${item.stage.toLowerCase()}`}>{item.stage.replaceAll("_", " ")}</em></button>)}
        </div>
        <aside className="module-content-card finance-handoff-trace">{trace ? <Trace trace={trace} permissions={workspace.actor.permissions} busy={busy} onAction={act} t={t}/> : <div className="treasury-placeholder"><AppIcon name="documents" size={24}/><p>{t({ en: "Select a handoff to inspect its persisted source, custody evidence, approvals, journal, and reconciliation.", fa: "برای بررسی منبع ثبت‌شده، شواهد نگهداری، تصویب‌ها، ژورنال و تطبیق یک تحویل را انتخاب کنید." })}</p></div>}</aside>
      </section>
    </> : null}
  </div>;
}

function Trace({ trace, permissions, busy, onAction, t }: { readonly trace: FinanceHandoffTraceView; readonly permissions: readonly string[]; readonly busy: boolean; readonly onAction: (action: "prepare"|"approve"|"post") => Promise<void>; readonly t: (copy: Copy) => string }) {
  const rows = [["Shareholder", trace.shareholder], ["Agreement / installment", `${trace.agreementReference} / ${trace.installmentSequence}`], ["Receiving safe", trace.receivingSafe], ["Physical count", `${trace.currency} ${trace.physicalCount.amount}`], ["Counted / confirmed", `${trace.physicalCount.countedBy} / ${trace.physicalCount.confirmedBy}`], ["Treasury verifier", trace.verifier], ["Receipt evidence", trace.receiptEvidence], ["Count evidence", trace.physicalCount.evidence]];
  const canCreate = permissions.includes("finance.posting-intent.create") && !trace.postingIntent;
  const canApprove = permissions.includes("finance.posting-intent.approve") && trace.postingIntent?.status === "PENDING_APPROVAL";
  const canPost = permissions.includes("finance.journal.post") && trace.postingIntent?.status === "APPROVED";
  return <><div className="module-card-heading"><div><p>PERSISTED TRACE</p><h2>{trace.receiptReference}</h2></div><span>{trace.stage}</span></div><dl>{rows.map(([key,value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>
    <div className="finance-reconciliation"><strong>{t({ en: "Scoped reconciliation", fa: "تطبیق محدود" })}</strong><span>Source {trace.reconciliation.sourceStatus}</span><span>Receipt {trace.reconciliation.receiptStatus}</span><span>Journal {trace.reconciliation.journalStatus}</span></div>
    {trace.postingIntent ? <p className="finance-record">Intent {trace.postingIntent.id.slice(0,8)} · {trace.postingIntent.status} · prepared by {trace.postingIntent.createdBy}</p> : null}
    {trace.approval ? <p className="finance-record">Approval {trace.approval.id.slice(0,8)} · {trace.approval.approver}</p> : null}
    {trace.journal ? <p className="finance-record">Journal {trace.journal.reference} · debit {trace.journal.debit} / credit {trace.journal.credit} · {trace.journal.status}</p> : null}
    <div className="finance-handoff-actions">{canCreate ? <button disabled={busy} onClick={() => void onAction("prepare")}>{t({ en: "Prepare posting intent", fa: "آماده‌سازی درخواست ثبت" })}</button> : null}{canApprove ? <button disabled={busy} onClick={() => void onAction("approve")}>{t({ en: "Independently approve", fa: "تصویب مستقل" })}</button> : null}{canPost ? <button disabled={busy} onClick={() => void onAction("post")}>{t({ en: "Post approved journal", fa: "ثبت ژورنال تصویب‌شده" })}</button> : null}</div>
  </>;
}

function FinanceSignIn({ onDone }: { readonly onDone: () => Promise<void> }) {
  const [token, setToken] = useState(""); const [error, setError] = useState("");
  const submit = async (event: FormEvent) => { event.preventDefault(); const result = await call("/api/v1/treasury/session", { method: "POST", body: JSON.stringify({ token }) }); if (result.ok) await onDone(); else setError(result.error.message); };
  return <form className="treasury-card treasury-signin" onSubmit={event => void submit(event)}><AppIcon name="shield" size={24}/><div><h2>Finance sandbox sign-in</h2><p>Use a synthetic preparer or independent approver token. Tokens remain in an httpOnly cookie.</p></div><label><span>Sandbox token</span><input type="password" value={token} onChange={event => setToken(event.target.value)} required minLength={32}/></label><button className="treasury-button" type="submit">Sign in</button>{error ? <p role="alert">{error}</p> : null}</form>;
}
