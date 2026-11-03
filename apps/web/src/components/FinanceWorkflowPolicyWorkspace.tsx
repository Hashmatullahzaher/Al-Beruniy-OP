"use client";

import {
  SIMPLE_MODE_DEFAULT_WORKFLOWS,
  type FinanceWorkflowPolicy,
  type FinanceWorkflowPolicyWorkspace as PolicyWorkspace
} from "@abos/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { AccessGate, api, errorText } from "@/components/AdminUsersWorkspace";
import { AppIcon } from "@/components/AppIcon";
import { useLocale } from "@/components/LocaleProvider";
import { StageZeroPageHeader } from "@/components/StageZeroWorkspace";

interface Draft {
  /** null: nothing chosen yet for a workflow with no saved setting and no Simple Mode default. */
  readonly approvalRequired: boolean | null;
  readonly changeReason: string;
}

/** The status chip of a workflow with no saved setting and no Simple Mode default: what happens today, never an assumed OFF. */
function notConfiguredStatus(workflowType: string, fa: boolean): { readonly text: string; readonly tone: "gold" | "danger" | "ok" } {
  if (workflowType === "CHART_OF_ACCOUNTS") {
    return { tone: "gold", text: fa ? "پیکربندی نشده — فعلاً به‌طور پیش‌فرض تأیید لازم است" : "Not configured — approval is currently required by default" };
  }
  if (workflowType === "SHAREHOLDER_CAPITAL_RECEIPT") {
    return { tone: "danger", text: fa ? "پیکربندی نشده — تا این تنظیم ذخیره نشود، سرمایه ثبت نمی‌شود" : "Not configured — capital cannot be recorded until this setting is saved" };
  }
  if (workflowType === "TEMPORARY_FUNDING") {
    return { tone: "danger", text: fa ? "پیکربندی نشده — تا این تنظیم ذخیره نشود، تمویل موقت ثبت نمی‌شود" : "Not configured — temporary funding cannot be recorded until this setting is saved" };
  }
  if (workflowType === "CUSTOMER_RECEIPT") {
    return { tone: "ok", text: fa ? "پیکربندی نشده — جریان جداگانه ندارد؛ با «دریافت نقد» ثبت می‌شود" : "Not configured — no separate workflow; recorded with “Receive cash”" };
  }
  return { tone: "danger", text: fa ? "پیکربندی نشده — تا این تنظیم ذخیره نشود قابل استفاده نیست" : "Not configured — cannot be used until this setting is saved" };
}

/** What happens today when a workflow without a Simple Mode default has no saved setting (the checkbox is only a draft). */
function notConfiguredEffect(workflowType: string, fa: boolean): string {
  if (workflowType === "CHART_OF_ACCOUNTS") {
    return fa ? "تا یک تنظیم ذخیره نشود، پیش‌فرض محافظتی اعمال است: هر حساب تازه یا تغییرکرده تا بررسی شخص دیگری منتظر می‌ماند. در شرکت یک‌نفره، تأیید را خاموش ذخیره کنید."
      : "Until a setting is saved, the protective default applies: every new or changed account waits for review by another person. In a one-person company, save approval OFF.";
  }
  if (workflowType === "SHAREHOLDER_CAPITAL_RECEIPT") {
    return fa ? "تا یک تنظیم ذخیره نشود، سرمایه سهامدار ثبت نمی‌شود. خاموش: با یک ذخیره ثبت می‌شود؛ روشن: شخص دوم تأیید می‌کند."
      : "Until a setting is saved, shareholder capital cannot be recorded. OFF records it in one save; ON needs a second person.";
  }
  if (workflowType === "TEMPORARY_FUNDING") {
    return fa ? "تا یک تنظیم ذخیره نشود، تمویل موقت ثبت نمی‌شود. تمویل موقت همیشه تأیید لازم دارد: تأیید روشن را ذخیره کنید."
      : "Until a setting is saved, temporary funding cannot be recorded. Temporary funding always needs approval: save approval ON.";
  }
  if (workflowType === "CUSTOMER_RECEIPT") {
    return fa ? "دریافت از مشتری هنوز در این نسخه جریان جداگانه ندارد؛ پول دریافتی را با «دریافت نقد» در صندوق‌ها ثبت کنید."
      : "Customer receipts have no separate workflow in this version yet; record money received with “Receive cash” on the Safes page.";
  }
  return fa ? "تا یک تنظیم ذخیره نشود، این جریان قابل استفاده نیست. چک‌باکس پایین فقط پیش‌نویس است تا ذخیره شود."
    : "Until a setting is saved, this workflow cannot be used. The checkbox below is only a draft until you save it.";
}

export function FinanceWorkflowPolicyWorkspace() {
  const { locale } = useLocale();
  const fa = locale === "fa";
  const [workspace, setWorkspace] = useState<PolicyWorkspace | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [gate, setGate] = useState<"signed-out" | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const commands = useRef(new Map<string, { idempotencyKey: string; correlationId: string }>());

  const apply = useCallback((result: Awaited<ReturnType<typeof api<PolicyWorkspace>>>) => {
    if (!result.ok) {
      setGate(result.status === 401 ? "signed-out" : null);
      setMessage({ tone: "error", text: errorText(result.error, locale) });
      return;
    }
    setGate(null);
    setWorkspace(result.data);
    setDrafts(Object.fromEntries(result.data.policies.map((policy) => [policy.workflowType, {
      approvalRequired: policy.configured ? policy.approvalRequired ?? false
        : SIMPLE_MODE_DEFAULT_WORKFLOWS.includes(policy.workflowType) ? false : null,
      changeReason: ""
    }])));
  }, [locale]);

  useEffect(() => {
    let current = true;
    void api<PolicyWorkspace>("/api/v1/admin/finance-workflows").then((result) => {
      if (current) apply(result);
    });
    return () => { current = false; };
  }, [apply]);

  const save = async (policy: FinanceWorkflowPolicy) => {
    const draft = drafts[policy.workflowType];
    if (!draft || draft.approvalRequired === null) return;
    setBusy(policy.workflowType);
    setMessage(null);
    // A lost response can be retried with the same command; changed inputs get a new command.
    const fingerprint = JSON.stringify([policy.workflowType, policy.version, draft.approvalRequired, draft.changeReason.trim()]);
    let command = commands.current.get(fingerprint);
    if (!command) {
      command = { idempotencyKey: crypto.randomUUID(), correlationId: crypto.randomUUID() };
      commands.current.set(fingerprint, command);
    }
    const result = await api<PolicyWorkspace>("/api/v1/admin/finance-workflows", "PUT", {
      workflowType: policy.workflowType,
      approvalRequired: draft.approvalRequired,
      expectedVersion: policy.version,
      changeReason: draft.changeReason.trim(),
      ...command
    });
    setBusy(null);
    if (!result.ok) {
      setMessage({ tone: "error", text: errorText(result.error, locale) });
      return;
    }
    commands.current.delete(fingerprint);
    apply(result);
    setMessage({
      tone: "ok",
      text: fa ? "سیاست تأیید ثبت شد. نسخه‌های قبلی برای حسابرسی محفوظ ماند." :
        "Approval policy saved. Earlier versions remain in the audit history."
    });
  };

  if (gate === "signed-out") {
    return <div className="module-workspace"><AccessGate state="signed-out" fa={fa} what={{
      en: "Sign in to review finance workflow policy.",
      fa: "برای بازبینی سیاست جریان مالی وارد شوید."
    }} /></div>;
  }

  return (
    <div className="module-workspace workflow-policy-workspace">
      <StageZeroPageHeader
        icon="shield"
        eyebrow={{ en: "Company configuration", fa: "پیکربندی شرکت" }}
        title={{ en: "Workflow approvals", fa: "تنظیم تأیید جریان‌ها" }}
        description={{
          en: "Choose which transaction types need an independent approval. Every change creates a permanent policy version.",
          fa: "مشخص کنید کدام نوع معامله به تأیید مستقل نیاز دارد. هر تغییر یک نسخه دایمی سیاست می‌سازد."
        }}
      />

      {message ? <div className={`treasury-message ${message.tone === "ok" ? "success" : "error"}`} role="status">
        <AppIcon name={message.tone === "ok" ? "shield" : "alert"} size={16} />
        <span>{message.text}</span>
        <button type="button" onClick={() => setMessage(null)} aria-label={fa ? "بستن" : "Dismiss"}>×</button>
      </div> : null}

      <section className="module-content-card policy-boundary" aria-label={fa ? "معنای تنظیم" : "Policy meaning"}>
        <div><strong>{fa ? "خاموش" : "OFF"}</strong><p>{fa ? "تأیید جداگانه لازم نیست. دیگر کنترل‌های اعتبارسنجی و حسابداری همچنان برقرار است." : "Records do not require a separate approval step. Other validation and accounting controls remain enforced."}</p></div>
        <div><strong>{fa ? "روشن" : "ON"}</strong><p>{fa ? "تأیید جداگانه مطابق قواعد تفکیک وظایف این جریان لازم است." : "A separate approval step is required according to the workflow’s segregation-of-duties rules."}</p></div>
        <p>{fa ? "این تنظیم کنترل‌های خزانه، دسترسی، توازن ژورنال، دوره مالی، شواهد، برگشت و حسابرسی را غیرفعال نمی‌کند." : "This setting never disables Treasury custody, access control, journal balance, period, evidence, reversal or audit controls."}</p>
      </section>

      {workspace === null ? <p className="treasury-placeholder">{fa ? "در حال بارگذاری…" : "Loading…"}</p> : (
        <section className="policy-grid">
          {workspace.policies.map((policy) => {
            const simpleDefault = SIMPLE_MODE_DEFAULT_WORKFLOWS.includes(policy.workflowType);
            // A workflow with no saved setting and no Simple Mode default shows what happens today and asks for an explicit choice.
            const unset = !policy.configured && !simpleDefault;
            const draft = drafts[policy.workflowType] ?? { approvalRequired: unset ? null : false, changeReason: "" };
            const changed = draft.approvalRequired !== null && (policy.approvalRequired !== draft.approvalRequired || !policy.configured);
            const status = unset ? notConfiguredStatus(policy.workflowType, fa) : null;
            const choose = (approvalRequired: boolean) => setDrafts({ ...drafts, [policy.workflowType]: { ...draft, approvalRequired } });
            // ON cannot be chosen where the lane has no approval path yet; an existing ON can still be turned off.
            const onLocked = !policy.approvalAvailable && !draft.approvalRequired;
            return <article className="module-content-card policy-card" key={policy.workflowType}>
              <header>
                <div><p>{fa ? "نوع جریان" : "WORKFLOW"}</p><h2>{fa ? policy.labelFa : policy.labelEn}</h2></div>
                <span className={`treasury-chip ${status ? status.tone : !policy.configured ? "ok" : policy.approvalRequired ? "gold" : "ok"}`}>
                  {status ? status.text : !policy.configured ? (fa ? "تأیید خاموش (پیش‌فرض)" : "Approval OFF (default)") :
                    policy.approvalRequired ? (fa ? "تأیید روشن" : "Approval ON") : (fa ? "تأیید خاموش" : "Approval OFF")}
                </span>
              </header>

              {unset ? <p className="treasury-message" role="note">{notConfiguredEffect(policy.workflowType, fa)}</p> : null}

              {workspace.canManage ? <form className="admin-form" onSubmit={(event) => { event.preventDefault(); void save(policy); }}>
                {unset ? <fieldset className="policy-choice" aria-describedby={`policy-help-${policy.workflowType}`}>
                  <legend>{fa ? "تنظیمی که ذخیره می‌شود" : "Setting to save"}</legend>
                  <label><input type="radio" name={`policy-${policy.workflowType}`} checked={draft.approvalRequired === false} onChange={() => choose(false)} />
                    {fa ? "تأیید خاموش — با یک ذخیره ثبت می‌شود" : "Approval OFF — recorded in one save"}</label>
                  <label><input type="radio" name={`policy-${policy.workflowType}`} checked={draft.approvalRequired === true} disabled={!policy.approvalAvailable}
                    onChange={() => choose(true)} />{fa ? "تأیید روشن — شخص دوم تأیید می‌کند" : "Approval ON — a second person approves"}</label>
                </fieldset> : <label className="policy-toggle">
                  <input
                    type="checkbox"
                    checked={draft.approvalRequired === true}
                    disabled={onLocked}
                    onChange={(event) => choose(event.target.checked)}
                    aria-describedby={`policy-help-${policy.workflowType}`}
                  />
                  <span>{fa ? "تأیید لازم است" : "Approval required"}: <strong>{draft.approvalRequired ? (fa ? "روشن" : "ON") : (fa ? "خاموش" : "OFF")}</strong></span>
                </label>}
                {!policy.approvalAvailable ? <small className="policy-unavailable">{fa
                  ? "تأیید برای این جریان هنوز در دسترس نیست؛ تا افزوده شدن کنترل‌های پیشرفته با یک ذخیره ثبت می‌شود."
                  : "Approval is not available for this workflow yet. It records in one save until Advanced Controls are added."}</small> : null}
                <small id={`policy-help-${policy.workflowType}`}>{draft.approvalRequired === null ?
                  (fa ? "هنوز چیزی ذخیره نشده است. خاموش یا روشن را انتخاب کنید، دلیل بنویسید و ذخیره کنید." : "Nothing is saved yet. Choose OFF or ON, give a reason, then save.") :
                  draft.approvalRequired ?
                  (fa ? "بازبینی مستقل طبق قواعد این جریان لازم است." : "Independent review follows this workflow’s existing rules.") :
                  (fa ? "تأیید جداگانه لازم نیست؛ تحویل خزانه، شواهد، صلاحیت و دوره مالی همچنان کنترل می‌شود." : "No separate approval is required; custody, evidence, permissions and accounting-period controls still apply.")}</small>
                <label>
                  <span>{fa ? "دلیل تغییر" : "Reason for this change"}</span>
                  <textarea
                    value={draft.changeReason}
                    onChange={(event) => setDrafts({ ...drafts, [policy.workflowType]: { ...draft, changeReason: event.target.value } })}
                    minLength={5}
                    maxLength={500}
                    required
                    rows={2}
                  />
                </label>
                <button type="submit" className="treasury-button gold" disabled={busy !== null || !changed || draft.changeReason.trim().length < 5}>
                  {busy === policy.workflowType ? (fa ? "در حال ذخیره…" : "Saving…") : (fa ? "ثبت نسخه جدید" : "Save new version")}
                </button>
              </form> : <p className="admin-hint">{fa ? "این صفحه فقط خواندنی است. مدیر سیستم دارای صلاحیت می‌تواند آن را تغییر دهد." : "This page is read-only. A permitted System Administrator can change it."}</p>}

              <footer>
                <span>{fa ? "نسخه" : "Version"} <strong dir="ltr">{policy.version || "—"}</strong></span>
                <span>{policy.configuredBy ? `${fa ? "توسط" : "by"} ${policy.configuredBy}` : (fa ? "هنوز ثبت نشده" : "Not set yet")}</span>
                {policy.configuredAt ? <time dateTime={policy.configuredAt} dir="ltr">{new Date(policy.configuredAt).toLocaleString(fa ? "fa-AF" : "en-GB")}</time> : null}
              </footer>
              {policy.changeReason ? <p className="admin-hint"><strong>{fa ? "دلیل آخرین تغییر: " : "Latest change reason: "}</strong>{policy.changeReason}</p> : null}
              <p className="admin-hint">{fa ? "نسخه مرتبط با معامله‌های در جریان محفوظ می‌ماند؛ تغییر سیاست، معامله‌های تکمیل‌شده را بازنویسی نمی‌کند." : "Transactions retain their bound policy version. Changing this setting does not rewrite completed transactions."}</p>
              {policy.history.length > 0 ? <details className="policy-history">
                <summary>{fa ? "تاریخچه نسخه‌ها" : "Version history"}</summary>
                <ol>{policy.history.map((item) => <li key={item.policyVersionId}>
                  <span dir="ltr">v{item.version}</span>
                  <strong>{item.approvalRequired ? (fa ? "روشن" : "ON") : (fa ? "خاموش" : "OFF")}</strong>
                  <span>{item.changeReason}</span>
                  <small>{item.configuredBy} · <time dateTime={item.configuredAt} dir="ltr">{new Date(item.configuredAt).toLocaleString(fa ? "fa-AF" : "en-GB")}</time></small>
                </li>)}</ol>
              </details> : null}
            </article>;
          })}
        </section>
      )}
    </div>
  );
}
