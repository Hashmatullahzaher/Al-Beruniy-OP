"use client";

import type {
  FinanceWorkflowPolicy,
  FinanceWorkflowPolicyWorkspace as PolicyWorkspace
} from "@abos/contracts";
import { useCallback, useEffect, useState } from "react";

import { AccessGate, api, errorText } from "@/components/AdminUsersWorkspace";
import { AppIcon } from "@/components/AppIcon";
import { useLocale } from "@/components/LocaleProvider";
import { StageZeroPageHeader } from "@/components/StageZeroWorkspace";

interface Draft {
  readonly approvalRequired: boolean;
  readonly changeReason: string;
}

export function FinanceWorkflowPolicyWorkspace() {
  const { locale } = useLocale();
  const fa = locale === "fa";
  const [workspace, setWorkspace] = useState<PolicyWorkspace | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [gate, setGate] = useState<"signed-out" | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const apply = useCallback((result: Awaited<ReturnType<typeof api<PolicyWorkspace>>>) => {
    if (!result.ok) {
      setGate(result.status === 401 ? "signed-out" : null);
      setMessage({ tone: "error", text: errorText(result.error, locale) });
      return;
    }
    setGate(null);
    setWorkspace(result.data);
    setDrafts(Object.fromEntries(result.data.policies.map((policy) => [policy.workflowType, {
      approvalRequired: policy.approvalRequired ?? false,
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
    if (!draft) return;
    setBusy(policy.workflowType);
    setMessage(null);
    const result = await api<PolicyWorkspace>("/api/v1/admin/finance-workflows", "PUT", {
      workflowType: policy.workflowType,
      approvalRequired: draft.approvalRequired,
      expectedVersion: policy.version,
      changeReason: draft.changeReason
    });
    setBusy(null);
    if (!result.ok) {
      setMessage({ tone: "error", text: errorText(result.error, locale) });
      return;
    }
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
        title={{ en: "Finance workflow approvals", fa: "تأیید جریان‌های مالی" }}
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
        <div><strong>{fa ? "خاموش" : "OFF"}</strong><p>{fa ? "کاربر مجاز معامله را پس از اعتبارسنجی مستقیماً نهایی می‌کند." : "An authorized user finalizes the transaction directly after validation."}</p></div>
        <div><strong>{fa ? "روشن" : "ON"}</strong><p>{fa ? "یک کاربر مجاز دیگر باید پیش از ثبت نهایی تأیید کند." : "A different authorized user must approve before final posting."}</p></div>
        <p>{fa ? "این تنظیم کنترل‌های خزانه، دسترسی، توازن ژورنال، دوره مالی، شواهد، برگشت و حسابرسی را غیرفعال نمی‌کند." : "This setting never disables Treasury custody, access control, journal balance, period, evidence, reversal or audit controls."}</p>
      </section>

      {workspace === null ? <p className="treasury-placeholder">{fa ? "در حال بارگذاری…" : "Loading…"}</p> : (
        <section className="policy-grid">
          {workspace.policies.map((policy) => {
            const draft = drafts[policy.workflowType] ?? { approvalRequired: false, changeReason: "" };
            const changed = policy.approvalRequired !== draft.approvalRequired || !policy.configured;
            return <article className="module-content-card policy-card" key={policy.workflowType}>
              <header>
                <div><p>{fa ? "نوع جریان" : "WORKFLOW"}</p><h2>{fa ? policy.labelFa : policy.labelEn}</h2></div>
                <span className={`treasury-chip ${!policy.configured ? "danger" : policy.approvalRequired ? "gold" : "ok"}`}>
                  {!policy.configured ? (fa ? "پیکربندی نشده" : "Not configured") :
                    policy.approvalRequired ? (fa ? "تأیید روشن" : "Approval ON") : (fa ? "تأیید خاموش" : "Approval OFF")}
                </span>
              </header>

              {workspace.canManage ? <form className="admin-form" onSubmit={(event) => { event.preventDefault(); void save(policy); }}>
                <label className="policy-toggle">
                  <input
                    type="checkbox"
                    checked={draft.approvalRequired}
                    onChange={(event) => setDrafts({ ...drafts, [policy.workflowType]: { ...draft, approvalRequired: event.target.checked } })}
                    aria-describedby={`policy-help-${policy.workflowType}`}
                  />
                  <span>{draft.approvalRequired ? (fa ? "تأیید مستقل لازم است" : "Independent approval required") : (fa ? "ثبت مستقیم پس از اعتبارسنجی" : "Post directly after validation")}</span>
                </label>
                <small id={`policy-help-${policy.workflowType}`}>{draft.approvalRequired ?
                  (fa ? "ثبت‌کننده نمی‌تواند معامله خودش را تأیید کند." : "The person who enters the transaction cannot approve it.") :
                  (fa ? "فقط کاربری که اجازه این معامله را دارد می‌تواند آن را نهایی کند." : "Only a user permitted for this transaction can finalize it.")}</small>
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
