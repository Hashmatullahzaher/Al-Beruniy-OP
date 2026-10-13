"use client";

import type { DecimalString, JournalId } from "@abos/contracts";
import { useState, type FormEvent } from "react";

import { AppIcon } from "@/components/AppIcon";
import { useLocale } from "@/components/LocaleProvider";
import { exactAmount } from "@/components/OperationalFinanceShared";
import { StageZeroPageHeader } from "@/components/StageZeroWorkspace";
import {
  bridgeReviewFixtures,
  REVIEW_ACTORS,
  reviewContributionSummary,
  reviewDecimal,
  reviewReceiptActions,
  type BridgeReviewReceipt,
  type BridgeReviewRole
} from "@/lib/capital-bridge-review";

interface ReviewEvent { readonly at: string; readonly action: "RECORD" | "VERIFY" | "APPROVE" | "REJECT" | "POST"; readonly receiptId: string; readonly role: BridgeReviewRole; }
interface ReviewState { readonly receipts: readonly BridgeReviewReceipt[]; readonly audit: readonly ReviewEvent[]; readonly error: string | null; }
interface ReceiptForm { readonly id: string; readonly contributionId: string; readonly amount: string; readonly currency: "USD" | "AFN"; readonly date: string; readonly destination: string; readonly reference: string; readonly evidence: string; }
const DECLARATIONS = bridgeReviewFixtures();

/**
 * Isolated presentation harness only. Actions alter React memory and make no business requests.
 * The separate service kernel is the authorization/accounting test subject; this UI does not
 * establish production permissions, policies, accounts, approvals or financial transactions.
 */
export function CapitalBridgeReviewWorkspace() {
  const { locale } = useLocale();
  const fa = locale === "fa";
  const copy = (en: string, dari: string) => fa ? dari : en;
  const [role, setRole] = useState<BridgeReviewRole>("OBSERVER");
  const [configurationReady, setConfigurationReady] = useState(false);
  const [state, setState] = useState<ReviewState>({ receipts: [], audit: [], error: null });
  const [form, setForm] = useState<ReceiptForm | null>(null);
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const [rejectionReason, setRejectionReason] = useState("");

  const names: Readonly<Record<BridgeReviewRole, string>> = {
    OBSERVER: copy("Observer", "مشاهده‌کننده"),
    TREASURY_RECORDER: copy("Treasury recorder", "ثبت‌کننده خزانه"),
    TREASURY_VERIFIER: copy("Independent Treasury verifier", "تأییدکننده مستقل خزانه"),
    FINANCE_REVIEWER: copy("Independent Finance reviewer / poster", "بازبین مستقل مالی / ثبت‌کننده حسابداری")
  };

  const errors: Readonly<Record<string, string>> = {
    INVALID_AMOUNT: copy("Enter a positive decimal amount without commas or scientific notation.", "یک مبلغ مثبت اعشاری بدون ویرگول وارد کنید."),
    OVER_RECEIPT: copy("The receipt exceeds the outstanding declaration. Reduce the amount.", "مبلغ دریافت از باقی‌مانده آورده بیشتر است. مبلغ را کاهش دهید."),
    CURRENCY_MISMATCH: copy("Receipt currency must match this declaration and receiving account. No conversion is simulated.", "واحد پول دریافت باید با آورده و حساب دریافت‌کننده یکسان باشد. تبدیل اسعار شبیه‌سازی نمی‌شود."),
    INVALID_DATE: copy("Enter a valid receipt date on or after the declaration date.", "یک تاریخ دریافت معتبر، برابر یا پس از تاریخ اعلام آورده وارد کنید."),
    DESTINATION_REQUIRED: copy("Choose the illustrative receiving account.", "حساب دریافت‌کننده نمایشی را انتخاب کنید."),
    NOT_PERMITTED: copy("The selected simulated role cannot perform this action.", "نقش شبیه‌سازی‌شده انتخابی صلاحیت این کار را ندارد.")
  };

  const money = (value: { readonly amount: string; readonly currency: string }) => <bdi dir="ltr">{value.currency} {exactAmount(value.amount)}</bdi>;
  const addReceipt = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!form) return;
    const pending = form;
    const now = new Date().toISOString();
    setState((current) => {
      // The same open form has one stable submission identity; a double click cannot append it twice.
      if (current.receipts.some((receipt) => receipt.id === pending.id)) return current;
      if (role !== "TREASURY_RECORDER") return { ...current, error: "NOT_PERMITTED" };
      const declaration = DECLARATIONS.find((value) => value.id === pending.contributionId);
      if (!declaration?.amount) return { ...current, error: "NOT_PERMITTED" };
      try {
        if (reviewDecimal([pending.amount]) === "0") return { ...current, error: "INVALID_AMOUNT" };
        if (pending.currency !== declaration.amount.currency) return { ...current, error: "CURRENCY_MISMATCH" };
        reviewDecimal([reviewContributionSummary(declaration, current.receipts).outstanding.amount], [pending.amount]);
      } catch (error) {
        return { ...current, error: error instanceof Error ? error.message : "INVALID_AMOUNT" };
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(pending.date) || Number.isNaN(Date.parse(`${pending.date}T00:00:00Z`))
        || new Date(`${pending.date}T00:00:00Z`).toISOString().slice(0, 10) !== pending.date
        || pending.date < declaration.businessDate) return { ...current, error: "INVALID_DATE" };
      if (pending.destination !== "DEMO-USD-SAFE") return { ...current, error: "DESTINATION_REQUIRED" };
      const id = pending.id;
      const receipt: BridgeReviewReceipt = {
        id, legalEntityId: declaration.legalEntityId, contributionId: declaration.id,
        sourceFingerprint: `DEMO-FIXTURE-${declaration.id}-${declaration.businessDate}`,
        amount: { amount: pending.amount as DecimalString, currency: pending.currency }, receiptDate: pending.date,
        treasuryDestinationId: pending.destination, paymentReference: pending.reference.trim() || null,
        evidenceReferenceId: pending.evidence || null, receiptState: "RECORDED", approvalState: "PENDING", postingState: "NOT_POSTED",
        custodyState: "PENDING_VERIFICATION", verifiedBy: null, verifiedAt: null,
        recordedBy: REVIEW_ACTORS[role], recordedAt: now, approvedBy: null, approvedAt: null,
        rejectedBy: null, rejectedAt: null, rejectionReason: null, journalId: null, reversedByJournalId: null, version: 1
      };
      return { receipts: [...current.receipts, receipt], audit: [...current.audit, { at: now, action: "RECORD", receiptId: id, role }], error: null };
    });
    // The successful submission disappears below; failed validation retains its fields and identity.
  };

  const decide = (receiptId: string, action: "VERIFY" | "APPROVE" | "REJECT" | "POST") => {
    setState((current) => {
      const receipt = current.receipts.find((value) => value.id === receiptId);
      if (!receipt) return current;
      const allowed = reviewReceiptActions(receipt, role, configurationReady);
      if ((action === "VERIFY" && !allowed.canVerify) || (action === "APPROVE" && !allowed.canApprove) || (action === "REJECT" && (!allowed.canApprove || rejectionReason.trim().length < 5))
        || (action === "POST" && !allowed.canPost)) return { ...current, error: "NOT_PERMITTED" };
      const now = new Date().toISOString();
      const next: BridgeReviewReceipt = action === "VERIFY"
        ? { ...receipt, custodyState: "VERIFIED", verifiedBy: REVIEW_ACTORS[role], verifiedAt: now, version: receipt.version + 1 }
        : action === "POST"
        ? { ...receipt, postingState: "POSTED", journalId: `SYN-JOURNAL-${receipt.id}` as JournalId, version: receipt.version + 1 }
        : action === "APPROVE"
          ? { ...receipt, approvalState: "APPROVED", approvedBy: REVIEW_ACTORS[role], approvedAt: now, version: receipt.version + 1 }
          : { ...receipt, approvalState: "REJECTED", rejectedBy: REVIEW_ACTORS[role], rejectedAt: now, rejectionReason: rejectionReason.trim(), version: receipt.version + 1 };
      return { receipts: current.receipts.map((value) => value.id === receiptId ? next : value),
        audit: [...current.audit, { at: now, action, receiptId, role }], error: null };
    });
    setReviewingId(null);
    setRejectionReason("");
  };

  return <div className="module-workspace capital-bridge-review">
    <StageZeroPageHeader icon="finance"
      eyebrow={{ en: "Finance bridge · isolated review", fa: "پیوند مالی · بازبینی جداگانه" }}
      title={{ en: "Shareholder capital → Finance", fa: "سرمایه سهامداران ← مالی" }}
      description={{ en: "Review declarations, actual receipt details, independent approval and posting as separate steps.",
        fa: "اعلام آورده، جزئیات دریافت واقعی، تأیید مستقل و ثبت حسابداری را در مراحل جداگانه بازبینی کنید." }} />

    <section className="module-content-card bridge-notice" aria-label={copy("Isolated review boundary", "محدوده بازبینی جداگانه")}>
      <AppIcon name="shield" size={22} />
      <div><strong>DEMO DATA · {copy("Memory-only simulation", "شبیه‌سازی فقط در حافظه")}</strong>
        <p>{copy("All holders, receipts and accounts on this page are illustrative. Actions change this page only; reloading clears them. No receipt, journal, posting intent, document or Treasury record is saved.",
          "همه سهامداران، دریافت‌ها و حساب‌های این صفحه نمایشی‌اند. کارها فقط همین صفحه را تغییر می‌دهند و با بارگذاری دوباره پاک می‌شوند. هیچ دریافت، ژورنال، سند یا سابقه خزانه ذخیره نمی‌شود.")}</p>
        <p>{copy("Declared capital is not received cash. Uploading an agreement is not legal verification or permission to post.",
          "سرمایه اعلام‌شده پول دریافت‌شده نیست. بارگذاری قرارداد، تأیید قانونی یا اجازه ثبت حسابداری نیست.")}</p>
      </div>
    </section>

    <section className="module-content-card admin-form bridge-controls" aria-label={copy("Simulation controls", "کنترول‌های شبیه‌سازی")}>
      <label><span>{copy("Simulated role", "نقش شبیه‌سازی‌شده")}</span><select aria-label={copy("Simulated role", "نقش شبیه‌سازی‌شده")} value={role} onChange={(event) => {
        setRole(event.target.value as BridgeReviewRole); setForm(null); setReviewingId(null); setRejectionReason("");
      }}>{Object.entries(names).map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></label>
      <label className="bridge-policy-toggle"><input type="checkbox" checked={configurationReady} onChange={(event) => setConfigurationReady(event.target.checked)} />
        <span>{copy("Use illustrative accounting configuration", "استفاده از تنظیمات حسابداری نمایشی")}
          <small className="rates-used">{copy("Simulation only: confirmed equity recognition, mapped accounts, open period, same currency. Real policy remains unresolved.",
            "فقط شبیه‌سازی: تأیید نوع سرمایه، حساب‌های مشخص، دوره باز و واحد پول یکسان. سیاست واقعی هنوز نهایی نشده است.")}</small></span></label>
      <button type="button" className="treasury-button" onClick={() => {
        setState({ receipts: [], audit: [], error: null }); setForm(null); setReviewingId(null); setRejectionReason("");
      }}>{copy("Reset simulation", "بازنشانی شبیه‌سازی")}</button>
    </section>

    {state.error ? <p role="alert" className="treasury-message error">{errors[state.error] ?? errors.INVALID_AMOUNT}</p> : null}

    <section className="bridge-contributions" aria-label={copy("Contribution finance review", "بازبینی مالی آورده‌ها")}>
      {DECLARATIONS.map((declaration) => {
        const summary = reviewContributionSummary(declaration, state.receipts);
        const receipts = state.receipts.filter((receipt) => receipt.contributionId === declaration.id);
        const canRecord = role === "TREASURY_RECORDER" && summary.outstanding.amount !== "0";
        return <article className="module-content-card" key={declaration.id} data-contribution-id={declaration.id} aria-label={`${declaration.id} ${fa ? declaration.holderFa : declaration.holderEn}`}>
          <div className="bridge-contribution-header"><div>
            <p><bdi>{declaration.id}</bdi> · {declaration.businessDate} · {copy("Cash declaration", "اعلام آورده نقدی")}</p>
            <h2>{fa ? declaration.holderFa : declaration.holderEn}</h2>
          </div><span className="treasury-chip muted">{copy("Declared", "اعلام‌شده")}</span></div>
          <dl className="bridge-figures">
            <div data-figure="declared"><dt>{copy("Declared", "اعلام‌شده")}</dt><dd>{money(summary.declared)}</dd></div>
            <div data-figure="received"><dt>{copy("Received (simulation)", "دریافت‌شده (شبیه‌سازی)")}</dt><dd>{money(summary.received)}</dd></div>
            <div data-figure="verified"><dt>{copy("Custody verified", "تحویل خزانه تأییدشده")}</dt><dd>{money(summary.verified)}</dd></div>
            <div data-figure="approved"><dt>{copy("Finance approved", "تأییدشده مالی")}</dt><dd>{money(summary.approved)}</dd></div>
            <div data-figure="outstanding"><dt>{copy("Outstanding declaration", "باقی‌مانده آورده")}</dt><dd>{money(summary.outstanding)}</dd></div>
            <div data-figure="posted" className="bridge-posted"><dt>{copy("Posted (simulation)", "ثبت حسابداری (شبیه‌سازی)")}</dt><dd>{money(summary.posted)}</dd></div>
          </dl>
          {receipts.length === 0 ? <p className="admin-hint">{copy("Not received · Not posted. A declaration alone creates no accounting transaction.",
            "دریافت‌نشده · ثبت حسابداری نشده. اعلام آورده به‌تنهایی معامله حسابداری ایجاد نمی‌کند.")}</p> : null}
          {canRecord ? <button type="button" className="treasury-button gold" onClick={() => {
            setForm({ id: `SYN-RECEIPT-${crypto.randomUUID()}`, contributionId: declaration.id, amount: "", currency: "USD", date: declaration.businessDate,
              destination: "", reference: "", evidence: "" }); setState((current) => ({ ...current, error: null }));
          }}>{copy("Record receipt (simulation)", "ثبت دریافت (شبیه‌سازی)")}</button> : null}
          {form?.contributionId === declaration.id && !state.receipts.some((receipt) => receipt.id === form.id) ? <form className="admin-form bridge-form" aria-label={copy("Receipt details", "جزئیات دریافت")} onSubmit={addReceipt}>
            <h3>{copy("Receipt details · simulation", "جزئیات دریافت · شبیه‌سازی")}</h3>
            <div className="bridge-form-grid">
              <label><span>{copy("Amount", "مبلغ")}</span><input inputMode="decimal" autoFocus required maxLength={256} value={form.amount} onChange={(event) => setForm({ ...form, amount: event.target.value })} /></label>
              <label><span>{copy("Currency", "واحد پول")}</span><select aria-label={copy("Currency", "واحد پول")} value={form.currency} onChange={(event) => setForm({ ...form, currency: event.target.value as "USD" | "AFN" })}><option>USD</option><option>AFN</option></select></label>
              <label><span>{copy("Receipt date", "تاریخ دریافت")}</span><input type="date" required value={form.date} onChange={(event) => setForm({ ...form, date: event.target.value })} /></label>
              <label><span>{copy("Receiving account", "حساب دریافت‌کننده")}</span><select aria-label={copy("Receiving account", "حساب دریافت‌کننده")} required value={form.destination} onChange={(event) => setForm({ ...form, destination: event.target.value })}>
                <option value="">{copy("Choose an account", "حساب را انتخاب کنید")}</option><option value="DEMO-USD-SAFE">{copy("Illustrative USD safe · DEMO DATA", "صندوق دالر نمایشی · DEMO DATA")}</option></select></label>
              <label><span>{copy("Payment / receipt reference (optional)", "مرجع پرداخت / دریافت (اختیاری)")}</span><input maxLength={120} value={form.reference} onChange={(event) => setForm({ ...form, reference: event.target.value })} /></label>
              <label><span>{copy("Evidence reference (optional)", "مرجع سند (اختیاری)")}</span><select aria-label={copy("Evidence reference (optional)", "مرجع سند (اختیاری)")} value={form.evidence} onChange={(event) => setForm({ ...form, evidence: event.target.value })}>
                <option value="">{copy("No evidence reference", "بدون مرجع سند")}</option><option value="DEMO-EVIDENCE-1">{copy("Illustrative receipt evidence · DEMO DATA", "سند دریافت نمایشی · DEMO DATA")}</option></select></label>
            </div>
            <p className="admin-hint">{copy("The simulated recorder and timestamp are captured automatically. Evidence is a reference only, not a file upload or legal verification.",
              "ثبت‌کننده و زمان شبیه‌سازی به‌صورت خودکار ثبت می‌شوند. سند فقط مرجع نمایشی است، نه بارگذاری فایل یا تأیید قانونی.")}</p>
            <div className="bridge-actions"><button type="submit" className="treasury-button gold">{copy("Simulate receipt", "شبیه‌سازی دریافت")}</button>
              <button type="button" className="treasury-button" onClick={() => setForm(null)}>{copy("Done / close", "انجام شد / بستن")}</button></div>
          </form> : null}
          <div className="bridge-receipts">{receipts.map((receipt, index) => {
            const actions = reviewReceiptActions(receipt, role, configurationReady);
            const status = receipt.postingState === "POSTED" ? copy("Posted (simulation)", "ثبت حسابداری (شبیه‌سازی)")
              : receipt.approvalState === "APPROVED" ? copy("Approved · Not posted", "تأییدشده · ثبت حسابداری نشده")
                : receipt.approvalState === "REJECTED" ? copy("Rejected · Not posted", "ردشده · ثبت حسابداری نشده")
                  : receipt.custodyState === "VERIFIED" ? copy("Verified · Awaiting Finance", "تحویل تأییدشده · منتظر مالی")
                    : copy("Received · Awaiting custody verification", "دریافت‌شده · منتظر تأیید تحویل خزانه");
            return <section className="bridge-receipt" data-receipt-id={receipt.id} key={receipt.id} aria-label={`${copy("Receipt", "دریافت")} ${index + 1} ${declaration.id}`}>
              <div className="bridge-receipt-header"><strong>{copy("Receipt", "دریافت")} {index + 1} · {money(receipt.amount)}</strong><span className="treasury-chip muted">{status}</span></div>
              <p>{receipt.receiptDate} · {copy("Illustrative USD safe", "صندوق دالر نمایشی")} · {copy("Recorded by", "ثبت‌کننده")} {names.TREASURY_RECORDER}</p>
              <p><time dateTime={receipt.recordedAt}>{receipt.recordedAt}</time> · {copy("Reference", "مرجع")}: <bdi>{receipt.paymentReference ?? "—"}</bdi> · {copy("Evidence", "سند")}: <bdi>{receipt.evidenceReferenceId ?? "—"}</bdi></p>
              <p>{copy("Custody", "تحویل خزانه")}: {receipt.custodyState === "VERIFIED" ? copy("Verified independently", "به‌صورت مستقل تأیید شد") : copy("Awaiting independent verification", "منتظر تأیید مستقل")}</p>
              {receipt.rejectionReason ? <p>{copy("Review reason", "دلیل بازبینی")}: {receipt.rejectionReason}</p> : null}
              <div className="bridge-actions">
                {actions.canVerify ? <button type="button" className="treasury-button gold" onClick={() => decide(receipt.id, "VERIFY")}>{copy("Simulate custody verification", "شبیه‌سازی تأیید تحویل خزانه")}</button> : null}
                {actions.canReview ? <button type="button" className="treasury-button" onClick={() => setReviewingId(receipt.id)}>{copy("Review receipt", "بازبینی دریافت")}</button> : null}
                {actions.canPost ? <button type="button" className="treasury-button gold" onClick={() => decide(receipt.id, "POST")}>{copy("Simulate posting", "شبیه‌سازی ثبت حسابداری")}</button> : null}
                {receipt.approvalState === "APPROVED" && receipt.postingState !== "POSTED" && !configurationReady ? <small>{copy("Posting blocked: accounting configuration and policy need approval.", "ثبت حسابداری بسته است: تنظیمات و سیاست حسابداری به تأیید نیاز دارند.")}</small> : null}
                {receipt.postingState === "POSTED" ? <><button type="button" className="treasury-button" disabled>{copy("Reverse", "برگشت")}</button><small>{copy("Unavailable until reversal policy and controlled adapter are approved.", "تا تأیید سیاست برگشت و مسیر کنترول‌شده در دسترس نیست.")}</small></> : null}
              </div>
              {reviewingId === receipt.id && actions.canApprove ? <div className="admin-form bridge-review-note">
                <p>{copy("Independent Finance review. Approval does not create a journal; posting is a separate action.", "بازبینی مستقل مالی. تأیید ژورنال ایجاد نمی‌کند؛ ثبت حسابداری کار جداگانه است.")}</p>
                <label><span>{copy("Rejection reason (required to reject)", "دلیل رد (برای رد الزامی است)")}</span><input value={rejectionReason} maxLength={500} onChange={(event) => setRejectionReason(event.target.value)} /></label>
                <div className="bridge-actions"><button type="button" className="treasury-button gold" onClick={() => decide(receipt.id, "APPROVE")}>{copy("Simulate approval", "شبیه‌سازی تأیید")}</button>
                  <button type="button" className="treasury-button" disabled={rejectionReason.trim().length < 5} onClick={() => decide(receipt.id, "REJECT")}>{copy("Reject receipt", "رد دریافت")}</button>
                  <button type="button" className="treasury-button" onClick={() => setReviewingId(null)}>{copy("Close review", "بستن بازبینی")}</button></div>
              </div> : null}
            </section>;
          })}</div>
        </article>;
      })}
    </section>

    <section className="module-content-card" aria-label={copy("Preserved separate history", "تاریخچه جداگانه محفوظ")}>
      <div className="module-card-heading"><div><p>DEMO DATA</p><h2>{copy("Separate legacy history", "تاریخچه قبلی جداگانه")}</h2></div></div>
      <ul className="bridge-history">
        <li data-testid="bridge-legacy-commitment">{copy("Synthetic Shareholder B · Legacy commitment", "سهامدار آزمایشی B · تعهد قبلی")}: <bdi dir="ltr">USD 20,000</bdi> · {copy("No receipt or posting implied; excluded from the contribution figures above.", "هیچ دریافت یا ثبت حسابداری را نشان نمی‌دهد؛ در مبالغ آورده‌های بالا شامل نیست.")}</li>
        <li data-testid="bridge-cancelled-installment">{copy("Cancelled legacy installment", "قسط قبلی لغوشده")}: <bdi dir="ltr">USD 5,000</bdi> · {copy("Historical record only; never reopened by this simulation.", "فقط سابقه تاریخی؛ این شبیه‌سازی آن را دوباره باز نمی‌کند.")}</li>
        <li>{copy("Same-value declarations SYN-C1 and SYN-C2 remain separate records with separate receipt histories.", "آورده‌های هم‌مبلغ SYN-C1 و SYN-C2 سابقه‌ها و دریافت‌های جداگانه دارند.")}</li>
      </ul>
    </section>

    <section className="module-content-card" aria-label={copy("Simulation history", "تاریخچه شبیه‌سازی")}>
      <div className="module-card-heading"><div><p>{copy("THIS PAGE ONLY", "فقط همین صفحه")}</p><h2>{copy("Simulation history", "تاریخچه شبیه‌سازی")}</h2></div></div>
      {state.audit.length === 0 ? <p className="admin-hint">{copy("No receipt, approval or posting simulated yet.", "هنوز دریافت، تأیید یا ثبت حسابداری شبیه‌سازی نشده است.")}</p>
        : <ol className="bridge-audit">{state.audit.map((entry, index) => <li key={`${entry.receiptId}-${entry.action}-${index}`} data-audit-action={entry.action}>
          <time dateTime={entry.at}>{entry.at}</time>{names[entry.role]} · {({ RECORD: copy("Receipt recorded", "دریافت ثبت شد"), VERIFY: copy("Custody verified", "تحویل خزانه تأیید شد"), APPROVE: copy("Receipt approved", "دریافت تأیید شد"), REJECT: copy("Receipt rejected", "دریافت رد شد"), POST: copy("Posting simulated", "ثبت حسابداری شبیه‌سازی شد") })[entry.action]}
        </li>)}</ol>}
    </section>
  </div>;
}
