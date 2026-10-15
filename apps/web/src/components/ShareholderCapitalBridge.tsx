"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import type {
  ShareholderCapitalContributionTrace,
  ShareholderCapitalPostingCommandResult,
  ShareholderCapitalReceiptCommandResult,
  ShareholderCapitalReceiptTrace,
  ShareholderCapitalTraceReadModel,
  ShareholderContribution,
  ShareholderFinanceCapability
} from "@abos/contracts";

import { AppIcon } from "@/components/AppIcon";
import { exactDecimal } from "@/components/ExchangeRatesWorkspace";

type OperationalCapability = ShareholderFinanceCapability;

export interface CapitalBridgeState {
  readonly loading: boolean;
  readonly capability: OperationalCapability | null;
  readonly error: string | null;
  readonly reload: () => Promise<void>;
}

type ApiEnvelope<T> = { readonly ok: true; readonly data: T } | {
  readonly ok: false;
  readonly error?: { readonly code?: string; readonly message?: string };
  readonly capability?: OperationalCapability;
};

async function readEnvelope<T>(response: Response): Promise<ApiEnvelope<T>> {
  try {
    return await response.json() as ApiEnvelope<T>;
  } catch {
    return { ok: false, error: { code: "INVALID_RESPONSE", message: "The server returned an unreadable response." } };
  }
}

export function useShareholderCapitalBridge(): CapitalBridgeState {
  const [loading, setLoading] = useState(true);
  const [capability, setCapability] = useState<OperationalCapability | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    setCapability(null);
    try {
      const response = await fetch("/api/v1/shareholder/capital-bridge/capability", { cache: "no-store" });
      const body = await readEnvelope<OperationalCapability>(response);
      if (body.ok) setCapability(body.data);
      else if (body.capability) setCapability(body.capability);
      else {
        setCapability(null);
        setError(body.error?.message ?? "The capital receipt capability could not be checked.");
      }
    } catch {
      setCapability(null);
      setError("The capital receipt capability could not be checked.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let current = true;
    void fetch("/api/v1/shareholder/capital-bridge/capability", { cache: "no-store" })
      .then((response) => readEnvelope<OperationalCapability>(response))
      .then((body) => {
        if (!current) return;
        if (body.ok) setCapability(body.data);
        else if (body.capability) setCapability(body.capability);
        else setError(body.error?.message ?? "The capital receipt capability could not be checked.");
        setLoading(false);
      })
      .catch(() => {
        if (!current) return;
        setError("The capital receipt capability could not be checked.");
        setLoading(false);
      });
    return () => { current = false; };
  }, []);
  return { loading, capability, error, reload };
}

export function ShareholderCapitalBoundary({ fa, bridge }: { readonly fa: boolean; readonly bridge: CapitalBridgeState }) {
  const { loading, capability, error } = bridge;
  const operational = capability?.state === "OPERATIONAL" && capability.mutationAvailable;
  const unavailable = capability?.state === "SCHEMA_NOT_AVAILABLE" || capability === null;
  const title = loading
    ? (fa ? "بررسی مسیر دریافت سرمایه" : "CHECKING CAPITAL RECEIPT PATH")
    : operational
      ? (fa ? "مسیر عملیاتی سرمایه نقدی" : "OPERATIONAL CASH CAPITAL PATH")
      : unavailable
        ? (fa ? "مسیر دریافت سرمایه در دسترس نیست" : "CAPITAL RECEIPT PATH UNAVAILABLE")
        : (fa ? "تنظیمات سرمایه تکمیل نیست" : "CAPITAL CONFIGURATION REQUIRED");
  const detail = loading
    ? (fa ? "وضعیت پایگاه داده و صلاحیت‌های زنده در حال بررسی است." : "Checking the live database capability and permissions.")
    : operational
      ? (fa
        ? "دریافت نقدی هم‌ارز می‌تواند از اعلام آورده تا تأیید تحویل خزانه، تصویب مالی و ثبت دفتری پیش برود. هر مرحله دوباره در سرور و پایگاه داده بررسی می‌شود."
        : "Same-currency cash receipts can progress from declaration through Treasury custody verification, Finance approval and posting. Every step is re-authorized by the server and database.")
      : unavailable
        ? (error ?? capability?.reason ?? (fa ? "ساختار هماهنگ پایگاه داده نصب نشده است." : "The coordinated database capability is not installed."))
        : (fa
          ? `پیش از دریافت، پالیسی تصویب و حساب سرمایه پرداخت‌شده باید توسط مالی تنظیم شود. ${capability?.reason ?? ""}`
          : `Finance must configure the approval policy and paid-in-capital account before a receipt can be recorded. ${capability?.reason ?? ""}`);

  return <section className={`finance-boundary-banner capital-live-boundary ${operational ? "operational" : "blocked"}`} data-testid="receipt-not-operational" role="status">
    <span><AppIcon name={operational ? "coins" : "shield"} size={22} /></span>
    <div><p>{title}</p><strong>{detail}</strong></div>
    <em>{operational ? (fa ? "عملیاتی" : "Operational") : loading ? (fa ? "در حال بررسی" : "Checking") : (fa ? "بدون عملیات" : "No actions")}</em>
  </section>;
}

type ReceiptWithVersion = ShareholderCapitalReceiptTrace;
interface TraceWithVersions extends Omit<ShareholderCapitalTraceReadModel, "contribution"> {
  readonly contribution: Omit<ShareholderCapitalContributionTrace, "receipts"> & { readonly receipts: readonly ReceiptWithVersion[] };
}

type ReceiptForm = {
  readonly amount: string; readonly destination: string; readonly reference: string; readonly evidence: string;
};
type ActionForm = {
  readonly receiptId: string; readonly kind: "VERIFY" | "PREPARE" | "DECIDE";
  readonly evidence: string; readonly reason: string; readonly decision: "APPROVED" | "REJECTED";
  readonly verificationKind: "PHYSICAL_CASH_COUNT" | "BANK_CONFIRMATION" | "SARAF_CONFIRMATION" | "CONTROLLED_EVIDENCE";
  readonly effectiveDate: string;
};

function requestHeaders(idempotencyKey: string): HeadersInit {
  return { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey, "X-Correlation-Id": crypto.randomUUID() };
}

function operationError(body: ApiEnvelope<unknown>, fa: boolean): string {
  if (body.ok) return "";
  return body.error?.message ?? (fa ? "درخواست انجام نشد؛ هیچ چیزی تغییر نکرد." : "The request failed; nothing was changed.");
}

function capitalMoney(amount: string, currency: string): string {
  return `${currency} ${exactDecimal(amount)}`;
}

export function ShareholderCapitalOperations({ contribution, fa, bridge }: {
  readonly contribution: ShareholderContribution;
  readonly fa: boolean;
  readonly bridge: CapitalBridgeState;
}) {
  const capability = bridge.capability;
  const permissions = capability?.permissions ?? [];
  const operational = capability?.state === "OPERATIONAL" && capability.mutationAvailable;
  const canRead = permissions.includes("shareholder.capital-receipt.read");
  const canRecord = permissions.includes("shareholder.capital-receipt.record");
  const canVerify = permissions.includes("treasury.capital-receipt.verify");
  const canPrepare = permissions.includes("finance.capital-receipt.prepare");
  const canDecide = permissions.includes("finance.capital-receipt.approve");
  const canPost = permissions.includes("finance.capital-receipt.post");
  const relevant = canRead || canRecord || canVerify || canPrepare || canDecide || canPost;
  const [trace, setTrace] = useState<TraceWithVersions | null>(null);
  const [loadingTrace, setLoadingTrace] = useState(false);
  const [receiptForm, setReceiptForm] = useState<ReceiptForm | null>(null);
  const [actionForm, setActionForm] = useState<ActionForm | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ readonly tone: "ok" | "error"; readonly text: string } | null>(null);
  const idempotencyKeys = useRef(new Map<string, string>());

  const loadTrace = useCallback(async () => {
    if (!operational || !canRead) { setTrace(null); return; }
    setLoadingTrace(true);
    const response = await fetch(`/api/v1/finance/shareholder-capital-trace/${contribution.id}`, { cache: "no-store" });
    const body = await readEnvelope<TraceWithVersions>(response);
    setLoadingTrace(false);
    if (body.ok) setTrace(body.data);
    else setMessage({ tone: "error", text: operationError(body, fa) });
  }, [canRead, contribution.id, fa, operational]);

  useEffect(() => {
    if (!operational || !canRead) return;
    let current = true;
    void fetch(`/api/v1/finance/shareholder-capital-trace/${contribution.id}`, { cache: "no-store" })
      .then((response) => readEnvelope<TraceWithVersions>(response))
      .then((body) => {
        if (!current) return;
        if (body.ok) setTrace(body.data);
        else setMessage({ tone: "error", text: operationError(body, fa) });
      })
      .catch(() => {
        if (current) setMessage({ tone: "error", text: fa ? "سابقه دریافت بارگذاری نشد." : "Receipt history could not be loaded." });
      });
    return () => { current = false; };
  }, [canRead, contribution.id, fa, operational]);
  if (!operational || !relevant || contribution.type !== "CASH" || contribution.recordStatus !== "DECLARED" || !contribution.amount || !contribution.currency) return null;

  const run = async <T,>(url: string, bodyValue: unknown, success: string): Promise<T | null> => {
    setBusy(true); setMessage(null);
    const canonicalRequest = `${url}:${JSON.stringify(bodyValue)}`;
    const idempotencyKey = idempotencyKeys.current.get(canonicalRequest) ?? crypto.randomUUID();
    idempotencyKeys.current.set(canonicalRequest, idempotencyKey);
    try {
      const response = await fetch(url, { method: "POST", headers: requestHeaders(idempotencyKey), body: JSON.stringify(bodyValue) });
      const body = await readEnvelope<T>(response);
      if (!body.ok) { setMessage({ tone: "error", text: operationError(body, fa) }); return null; }
      idempotencyKeys.current.delete(canonicalRequest);
      setMessage({ tone: "ok", text: success });
      return body.data;
    } catch {
      setMessage({ tone: "error", text: fa ? "سرور در دسترس نیست؛ هیچ چیزی تغییر نکرد." : "The server is unavailable; nothing was changed." });
      return null;
    } finally { setBusy(false); }
  };

  const record = async (event: FormEvent) => {
    event.preventDefault();
    if (!receiptForm) return;
    const result = await run<ShareholderCapitalReceiptCommandResult>("/api/v1/shareholder/capital-receipts", {
      contributionId: contribution.id, expectedContributionVersion: contribution.version,
      amount: { amount: receiptForm.amount, currency: contribution.currency }, receiptDate: contribution.businessDate,
      treasuryDestinationId: receiptForm.destination, paymentReference: receiptForm.reference.trim() || null,
      evidenceReferenceId: receiptForm.evidence.trim() || null
    }, fa ? "دریافت ثبت شد؛ هنوز تحویل خزانه تأیید یا ثبت دفتری نشده است." : "Receipt recorded. Custody is not yet verified and nothing has been posted.");
    if (result) { setReceiptForm(null); await loadTrace(); }
  };

  const act = async (receipt: ReceiptWithVersion, form: ActionForm) => {
    if (form.kind === "VERIFY") {
      const result = await run<ShareholderCapitalReceiptCommandResult>(`/api/v1/treasury/shareholder-capital-receipts/${receipt.receiptId}/verify`, {
        expectedReceiptVersion: receipt.receiptVersion, decision: "VERIFIED", verificationKind: form.verificationKind,
        evidenceReferenceId: form.evidence, decisionReason: null
      }, fa ? "تحویل خزانه به‌صورت مستقل تأیید شد." : "Treasury custody was independently verified.");
      if (result) { setActionForm(null); await loadTrace(); }
      return;
    }
    if (form.kind === "PREPARE") {
      const result = await run<ShareholderCapitalPostingCommandResult>(`/api/v1/finance/shareholder-capital-receipts/${receipt.receiptId}/prepare`, {
        expectedReceiptVersion: receipt.receiptVersion, accountingEffectiveDate: form.effectiveDate
      }, fa ? "سند ثبت برای تصویب مالی آماده شد؛ هنوز ثبت دفتری نشده است." : "Posting was prepared for Finance approval. Nothing has been posted yet.");
      if (result) { setActionForm(null); await loadTrace(); }
      return;
    }
    if (!receipt.postingIntentId || receipt.postingIntentVersion === null) return;
    const result = await run<ShareholderCapitalPostingCommandResult>(`/api/v1/finance/shareholder-capital-postings/${receipt.postingIntentId}/decision`, {
      expectedIntentVersion: receipt.postingIntentVersion, decision: form.decision, evidenceReferenceId: form.evidence,
      decisionReason: form.reason
    }, form.decision === "APPROVED"
      ? (fa ? "ثبت توسط مالی تصویب شد؛ هنوز ژورنال ایجاد نشده است." : "Finance approved the posting. No journal has been created yet.")
      : (fa ? "ثبت توسط مالی رد شد؛ هیچ ژورنالی ایجاد نشد." : "Finance rejected the posting. No journal was created."));
    if (result) { setActionForm(null); await loadTrace(); }
  };

  const post = async (receipt: ReceiptWithVersion) => {
    if (!receipt.postingIntentId || receipt.postingIntentVersion === null) return;
    const result = await run<ShareholderCapitalPostingCommandResult>(`/api/v1/finance/shareholder-capital-postings/${receipt.postingIntentId}/post`, {
      expectedIntentVersion: receipt.postingIntentVersion
    }, fa ? "دریافت در دفتر کل ثبت شد." : "The receipt was posted to the General Ledger.");
    if (result) await loadTrace();
  };

  const receipts = trace?.contribution.receipts ?? [];
  return <div className="capital-operations" aria-label={fa ? "عملیات واقعی دریافت سرمایه" : "Operational capital receipt actions"}>
    <div className="capital-operations-head"><div><p>{fa ? "مسیر واقعی سرمایه نقدی" : "LIVE CASH CAPITAL WORKFLOW"}</p>
      <strong>{fa ? "اعلام آورده، دریافت نقدی نیست. هر مرحله مستقل ثبت می‌شود." : "A declaration is not a cash receipt. Each stage is recorded independently."}</strong></div>
      {canRead ? <button type="button" className="treasury-button quiet" disabled={loadingTrace || busy} onClick={() => void loadTrace()}>{fa ? "تازه‌سازی" : "Refresh"}</button> : null}</div>
    {message ? <div className={`treasury-message ${message.tone === "ok" ? "success" : "error"}`} role="status"><span>{message.text}</span><button type="button" onClick={() => setMessage(null)} aria-label={fa ? "بستن" : "Dismiss"}>×</button></div> : null}
    {canRecord && receiptForm === null ? <button type="button" className="treasury-button gold" onClick={() => setReceiptForm({ amount: contribution.amount ?? "", destination: "", reference: "", evidence: "" })}>{fa ? "ثبت دریافت واقعی" : "Record actual receipt"}</button> : null}
    {receiptForm ? <form className="admin-form capital-operation-form" onSubmit={(event) => void record(event)}>
      <h3>{fa ? "جزئیات دریافت نقدی" : "Cash receipt details"}</h3>
      <label><span>{fa ? "مبلغ" : "Amount"}</span><input dir="ltr" inputMode="decimal" required value={receiptForm.amount} onChange={(event) => setReceiptForm({ ...receiptForm, amount: event.target.value })} /></label>
      <label><span>{fa ? "حساب دریافت‌کننده خزانه" : "Treasury receiving account"}</span>
        <select required value={receiptForm.destination} onChange={(event) => setReceiptForm({ ...receiptForm, destination: event.target.value })}>
          <option value="">{fa ? "انتخاب حساب" : "Choose account"}</option>
          {(capability?.treasuryDestinations ?? []).map((destination) => (
            <option key={destination.id} value={destination.id}>{destination.name} · {destination.currency}</option>
          ))}
        </select>
      </label>
      <label><span>{fa ? "مرجع پرداخت (اختیاری)" : "Payment reference (optional)"}</span><input maxLength={120} value={receiptForm.reference} onChange={(event) => setReceiptForm({ ...receiptForm, reference: event.target.value })} /></label>
      <label><span>{fa ? "شناسه سند دریافت (اختیاری)" : "Receipt evidence ID (optional)"}</span><input dir="ltr" pattern="[0-9a-fA-F-]{36}" value={receiptForm.evidence} onChange={(event) => setReceiptForm({ ...receiptForm, evidence: event.target.value })} /></label>
      <p className="admin-hint">{fa ? `تاریخ دریافت ${contribution.businessDate} و واحد پول ${contribution.currency} از اعلام آورده گرفته می‌شود.` : `Receipt date ${contribution.businessDate} and currency ${contribution.currency} come from the declaration.`}</p>
      <div className="rates-actions"><button className="treasury-button gold" type="submit" disabled={busy}>{fa ? "ثبت دریافت" : "Record receipt"}</button><button className="treasury-button" type="button" onClick={() => setReceiptForm(null)}>{fa ? "لغو" : "Cancel"}</button></div>
    </form> : null}
    {canRead && loadingTrace ? <p className="admin-hint">{fa ? "در حال بارگذاری سابقه دریافت…" : "Loading receipt history…"}</p> : null}
    {canRead && !loadingTrace && receipts.length === 0 ? <p className="admin-hint">{fa ? "هنوز دریافت واقعی ثبت نشده است." : "No actual receipt has been recorded yet."}</p> : null}
    {receipts.map((receipt) => {
      const action = actionForm?.receiptId === receipt.receiptId ? actionForm : null;
      const status = receipt.postingState === "POSTED" ? (fa ? "ثبت‌شده" : "Posted") : receipt.approvalState === "APPROVED" ? (fa ? "تصویب‌شده مالی" : "Finance approved") : receipt.custodyState === "VERIFIED" ? (fa ? "تحویل خزانه تأییدشده" : "Custody verified") : (fa ? "منتظر تأیید تحویل" : "Awaiting custody verification");
      return <article className="capital-receipt" key={receipt.receiptId}><header><strong dir="ltr">{capitalMoney(receipt.amount.amount, receipt.amount.currency)}</strong><em className="treasury-chip">{status}</em></header>
        <p>{receipt.receiptDate} · {receipt.treasuryDestinationName}</p>
        <div className="shareholder-row-actions">
          {canVerify && receipt.custodyState === "PENDING_VERIFICATION" ? <button className="treasury-button" type="button" onClick={() => setActionForm({ receiptId: receipt.receiptId, kind: "VERIFY", evidence: "", reason: "", decision: "APPROVED", verificationKind: "PHYSICAL_CASH_COUNT", effectiveDate: contribution.businessDate })}>{fa ? "تأیید تحویل خزانه" : "Verify custody"}</button> : null}
          {canPrepare && receipt.custodyState === "VERIFIED" && !receipt.postingIntentId ? <button className="treasury-button" type="button" onClick={() => setActionForm({ receiptId: receipt.receiptId, kind: "PREPARE", evidence: "", reason: "", decision: "APPROVED", verificationKind: "PHYSICAL_CASH_COUNT", effectiveDate: contribution.businessDate })}>{fa ? "آماده‌سازی ثبت" : "Prepare posting"}</button> : null}
          {canDecide && receipt.postingIntentId && receipt.approvalState === "PENDING" ? <button className="treasury-button" type="button" onClick={() => setActionForm({ receiptId: receipt.receiptId, kind: "DECIDE", evidence: "", reason: "", decision: "APPROVED", verificationKind: "PHYSICAL_CASH_COUNT", effectiveDate: contribution.businessDate })}>{fa ? "بازبینی مالی" : "Finance review"}</button> : null}
          {canPost && receipt.postingIntentId && receipt.approvalState === "APPROVED" && receipt.postingState === "NOT_POSTED" ? <button className="treasury-button gold" type="button" disabled={busy} onClick={() => void post(receipt)}>{fa ? "ثبت در دفتر کل" : "Post to General Ledger"}</button> : null}
        </div>
        {action?.kind === "VERIFY" ? <form className="admin-form capital-operation-form compact" onSubmit={(event) => { event.preventDefault(); void act(receipt, action); }}>
          <label><span>{fa ? "نوع تأیید" : "Verification method"}</span><select value={action.verificationKind} onChange={(event) => setActionForm({ ...action, verificationKind: event.target.value as ActionForm["verificationKind"] })}><option value="PHYSICAL_CASH_COUNT">{fa ? "شمارش فزیکی نقد" : "Physical cash count"}</option><option value="BANK_CONFIRMATION">{fa ? "تأیید بانک" : "Bank confirmation"}</option><option value="SARAF_CONFIRMATION">{fa ? "تأیید صراف" : "Saraf confirmation"}</option><option value="CONTROLLED_EVIDENCE">{fa ? "سند کنترول‌شده" : "Controlled evidence"}</option></select></label>
          <label><span>{fa ? "شناسه سند تأیید" : "Verification evidence ID"}</span><input dir="ltr" required pattern="[0-9a-fA-F-]{36}" value={action.evidence} onChange={(event) => setActionForm({ ...action, evidence: event.target.value })} /></label>
          <div className="rates-actions"><button className="treasury-button gold" type="submit" disabled={busy}>{fa ? "تأیید مستقل" : "Verify independently"}</button><button className="treasury-button" type="button" onClick={() => setActionForm(null)}>{fa ? "لغو" : "Cancel"}</button></div>
        </form> : null}
        {action?.kind === "PREPARE" ? <form className="admin-form capital-operation-form compact" onSubmit={(event) => { event.preventDefault(); void act(receipt, action); }}>
          <label><span>{fa ? "تاریخ مؤثر حسابداری" : "Accounting effective date"}</span><input type="date" required value={action.effectiveDate} onChange={(event) => setActionForm({ ...action, effectiveDate: event.target.value })} /></label>
          <p className="admin-hint">{fa ? "حساب‌ها، دوره و پالیسی از تنظیمات تأییدشده پایگاه داده گرفته می‌شود." : "Accounts, period and policy are resolved from approved database configuration."}</p>
          <div className="rates-actions"><button className="treasury-button gold" type="submit" disabled={busy}>{fa ? "آماده‌سازی" : "Prepare"}</button><button className="treasury-button" type="button" onClick={() => setActionForm(null)}>{fa ? "لغو" : "Cancel"}</button></div>
        </form> : null}
        {action?.kind === "DECIDE" ? <form className="admin-form capital-operation-form compact" onSubmit={(event) => { event.preventDefault(); void act(receipt, action); }}>
          <label><span>{fa ? "تصمیم" : "Decision"}</span><select value={action.decision} onChange={(event) => setActionForm({ ...action, decision: event.target.value as ActionForm["decision"] })}><option value="APPROVED">{fa ? "تصویب" : "Approve"}</option><option value="REJECTED">{fa ? "رد" : "Reject"}</option></select></label>
          <label><span>{fa ? "شناسه سند بازبینی" : "Review evidence ID"}</span><input dir="ltr" required pattern="[0-9a-fA-F-]{36}" value={action.evidence} onChange={(event) => setActionForm({ ...action, evidence: event.target.value })} /></label>
          <label><span>{fa ? "یادداشت تصمیم" : "Decision note"}</span><input required minLength={3} maxLength={500} value={action.reason} onChange={(event) => setActionForm({ ...action, reason: event.target.value })} /></label>
          <div className="rates-actions"><button className="treasury-button gold" type="submit" disabled={busy}>{fa ? "ثبت تصمیم" : "Record decision"}</button><button className="treasury-button" type="button" onClick={() => setActionForm(null)}>{fa ? "لغو" : "Cancel"}</button></div>
        </form> : null}
      </article>;
    })}
  </div>;
}
