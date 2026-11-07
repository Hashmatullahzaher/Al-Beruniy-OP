"use client";

import type { AttachedDocument, DocumentListView, DocumentScanStatus, DocumentSubjectType } from "@abos/contracts";
import { useEffect, useRef, useState } from "react";

import { api } from "@/components/AdminUsersWorkspace";

/**
 * The documents attached to one record. It says nothing at all to someone who may neither read nor attach. A correction is a new document
 * beside the old one: nothing here replaces or removes a file. A file can be opened only after it passes its security check.
 */

const ENDPOINT = "/api/v1/documents";

function size(bytes: number, fa: boolean): string {
  const text = bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return fa ? text.replace("KB", "کیلوبایت").replace("MB", "مگابایت") : text;
}

function uploadError(code: string | undefined, fa: boolean): string {
  if (code === "TOO_LARGE") return fa ? "فایل نباید بیشتر از ۱۰ مگابایت باشد." : "Files cannot exceed 10 MB.";
  if (code === "INVALID_FILE") return fa ? "تنها فایل‌های واقعی PDF، JPEG و PNG پذیرفته می‌شوند." : "Only genuine PDF, JPEG and PNG files are accepted.";
  return fa ? "سند ذخیره نشد. دوباره کوشش کنید." : "The document was not saved. Try again.";
}

export function DocumentsPanel({ subjectType, subjectId, fa }: Readonly<{ subjectType: DocumentSubjectType; subjectId: string | null; fa: boolean }>) {
  const query = `subjectType=${subjectType}${subjectId ? `&subjectId=${subjectId}` : ""}`;
  const [view, setView] = useState<DocumentListView | null>(null);
  const [title, setTitle] = useState("");
  const [documentDate, setDocumentDate] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<DocumentScanStatus | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  // One identity per filled-in form, so a retry replays instead of attaching twice.
  const request = useRef(`document-${crypto.randomUUID()}`);

  const [version, setVersion] = useState(0);
  useEffect(() => {
    let current = true;
    void api<DocumentListView>(`${ENDPOINT}?${query}`).then((result) => { if (current) setView(result.ok ? result.data : null); });
    return () => { current = false; };
  }, [query, version]);

  const upload = async () => {
    if (file === null) return;
    setBusy(true); setError(null); setSaved(null);
    const form = new FormData();
    form.set("file", file); form.set("title", title); form.set("documentDate", documentDate); form.set("subjectType", subjectType);
    form.set("subjectId", subjectId ?? ""); form.set("idempotencyKey", request.current);
    const response = await fetch(ENDPOINT, { method: "POST", body: form }).catch(() => null);
    const body = response === null ? null : await response.json().catch(() => null) as { ok?: boolean; data?: { scanStatus?: DocumentScanStatus }; error?: { code?: string } } | null;
    setBusy(false);
    if (body?.ok !== true) { setError(uploadError(body?.error?.code, fa)); return; }
    setTitle(""); setDocumentDate(""); setFile(null); setSaved(body.data?.scanStatus ?? "PENDING");
    if (input.current) input.current.value = "";
    request.current = `document-${crypto.randomUUID()}`;
    setVersion((value) => value + 1);
  };

  const checkAgain = async (id: string) => {
    setChecking(id); setError(null);
    const response = await fetch(`${ENDPOINT}/${id}/scan`, { method: "POST" }).catch(() => null);
    setChecking(null);
    if (response === null || !response.ok) setError(fa ? "بررسی امنیتی انجام نشد. دوباره کوشش کنید." : "The security check could not run. Try again.");
    setVersion((value) => value + 1);
  };

  if (view === null) return null;
  const row = (document: AttachedDocument) => <li key={document.id}>
    <strong>{document.title}</strong> <span className="admin-hint" dir="ltr">{document.fileName} · {size(document.byteSize, fa)}{document.documentDate ? ` · ${document.documentDate}` : ""}</span>{" "}
    {document.scanStatus === "CLEAN" ? <>
      <a href={`${ENDPOINT}/${document.id}`} target="_blank" rel="noreferrer">{fa ? "دیدن" : "View"}</a>{" "}
      <a href={`${ENDPOINT}/${document.id}?download=1`}>{fa ? "دانلود" : "Download"}</a>
    </> : document.scanStatus === "INFECTED" ? <em className="treasury-chip muted">{fa ? "مسدود: در بررسی امنیتی رد شد و باز نمی‌شود" : "Blocked: failed its security check and cannot be opened"}</em>
      : <>
        <em className="treasury-chip muted">{fa ? "قفل است تا بررسی امنیتی تمام شود" : "Locked until its security check passes"}</em>{" "}
        {view.canAttach ? <button type="button" className="treasury-button quiet" disabled={checking === document.id} onClick={() => void checkAgain(document.id)}>{fa ? "بررسی دوباره" : "Check again"}</button> : null}
      </>}
  </li>;
  return (
    <section className="module-content-card" aria-label={fa ? "اسناد" : "Documents"}>
      <h3>{fa ? "اسناد" : "Documents"}</h3>
      {view.canRead ? (view.documents.length === 0 ? <p className="admin-hint">{fa ? "سندی پیوست نشده است." : "No documents attached."}</p>
        : <ul className="period-pending">{view.documents.map(row)}</ul>) : null}
      {view.canAttach ? (
        <form className="admin-form" aria-label={fa ? "پیوست سند" : "Attach a document"} onSubmit={(event) => { event.preventDefault(); void upload(); }}>
          <div className="admin-form-grid">
            <label><span>{fa ? "عنوان" : "Title"}</span><input required maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
            <label><span>{fa ? "تاریخ سند (اختیاری)" : "Document date (optional)"}</span><input type="date" dir="ltr" value={documentDate} onChange={(event) => setDocumentDate(event.target.value)} /></label>
            <label><span>{fa ? "فایل PDF یا تصویر (حداکثر ۱۰ مگابایت)" : "PDF or image file (up to 10 MB)"}</span>
              <input ref={input} required type="file" accept="application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png" onChange={(event) => setFile(event.target.files?.[0] ?? null)} /></label>
          </div>
          <p className="admin-hint">{fa ? "سند پیوست‌شده جایگزین یا حذف نمی‌شود. برای اصلاح، سند تازه‌ای پیوست کنید." : "An attached document is never replaced or removed. To correct one, attach a new document."}</p>
          {error ? <p className="treasury-message error" role="alert">{error}</p> : null}
          {saved === "CLEAN" ? <p className="treasury-message success" role="status">{fa ? "سند پیوست شد." : "Document attached."}</p> : null}
          {saved === "PENDING" ? <p className="treasury-message" role="status">{fa ? "سند پیوست شد و تا پایان بررسی امنیتی قفل می‌ماند." : "Document attached. It stays locked until its security check passes."}</p> : null}
          {saved === "INFECTED" ? <p className="treasury-message error" role="alert">{fa ? "این فایل در بررسی امنیتی رد شد. نگهداری می‌شود و باز نمی‌شود." : "This file failed its security check. It is kept, and it cannot be opened."}</p> : null}
          <button className="treasury-button gold" type="submit" disabled={busy || file === null || title.trim() === ""}>{busy ? (fa ? "در حال ذخیره…" : "Saving…") : (fa ? "پیوست سند" : "Attach document")}</button>
        </form>
      ) : null}
    </section>
  );
}
