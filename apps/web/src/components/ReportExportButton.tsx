"use client";

import { useEffect, useRef, useState } from "react";

import { errorText } from "@/components/AdminUsersWorkspace";
import type { Copy } from "@/lib/access-copy";

const REFUSALS: Readonly<Record<string, Copy>> = {
  TOO_MANY_LINES: { en: "This statement is too long. Choose a shorter period.", fa: "این صورت‌حساب خیلی طولانی است. دورهٔ کوتاه‌تری انتخاب کنید." },
  NOT_FOUND: { en: "That is not available for your company.", fa: "این برای شرکت شما در دسترس نیست." },
  CHANGED_DURING_EXPORT: { en: "The General Ledger changed while the export was being prepared. Try again.", fa: "دفتر کل هنگام آماده‌سازی فایل تغییر کرد. دوباره امتحان کنید." },
  UNAVAILABLE: { en: "The export could not be prepared. Try again.", fa: "فایل آماده نشد. دوباره امتحان کنید." },
  UNREACHABLE: { en: "The server could not be reached.", fa: "ارتباط با سرور برقرار نشد." }
};

/**
 * Downloads the report on the screen as CSV for Excel. The query is the one the screen was loaded with, so the file is the same payload.
 * The server checks access again, records the export and refuses anything the screen would refuse; a refusal is shown here, not downloaded.
 * The label never calls the file native Excel.
 */
export function ReportExportButton({ report, query, fa, disabled = false }: Readonly<{ report: string; query: string; fa: boolean; disabled?: boolean }>) {
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<{ readonly code: string; readonly message: string } | null>(null);
  const link = useRef<string | null>(null);
  useEffect(() => () => { if (link.current) URL.revokeObjectURL(link.current); }, []);

  const download = async () => {
    setBusy(true); setRefusal(null);
    try {
      const response = await fetch(`/api/v1/finance/report-export?report=${report}&format=csv&lang=${fa ? "fa" : "en"}&${query}`, { cache: "no-store" });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: { code: string; message: string } } | null;
        setRefusal(body?.error ?? { code: "UNAVAILABLE", message: "The export could not be prepared. Try again." });
        return;
      }
      const name = /filename="([^"]+)"/.exec(response.headers.get("Content-Disposition") ?? "")?.[1] ?? "report.csv";
      if (link.current) URL.revokeObjectURL(link.current);
      link.current = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = link.current; anchor.download = name; anchor.hidden = true;
      document.body.append(anchor); anchor.click(); anchor.remove();
    } catch {
      setRefusal({ code: "UNREACHABLE", message: "The server could not be reached." });
    } finally {
      setBusy(false);
    }
  };

  const message = refusal === null ? null : REFUSALS[refusal.code]?.[fa ? "fa" : "en"] ?? (fa ? errorText(refusal, "fa") : refusal.message || errorText(refusal, "en"));
  return <span className="report-export no-print">
    <button className="treasury-button" type="button" onClick={() => void download()} disabled={disabled || busy}
      title={fa ? "فایل CSV که در Excel باز می‌شود. محرمانه است." : "A CSV file that opens in Excel. It is confidential."}>
      {busy ? (fa ? "در حال آماده‌سازی…" : "Preparing…") : (fa ? "CSV (سازگار با Excel)" : "CSV (Excel-compatible)")}
    </button>
    {message ? <span className="treasury-message error" role="alert">{message}</span> : null}
  </span>;
}
