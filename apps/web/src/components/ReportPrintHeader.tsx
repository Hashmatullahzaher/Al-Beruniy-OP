"use client";

import { useEffect, useState } from "react";

import { useSession } from "@/components/SessionProvider";
import type { Copy } from "@/lib/access-copy";

const CONFIDENTIAL = "Confidential / محرمانه";

function printedAt(date: Date, fa: boolean): string {
  return `${new Intl.DateTimeFormat(fa ? "fa-AF" : "en-GB", { timeZone: "Asia/Kabul", dateStyle: "medium", timeStyle: "short" }).format(date)} (${fa ? "کابل" : "Kabul"})`;
}

/**
 * Printed and PDF copies of a report carry the company, the report, its period and currency, when it was printed, and the Confidential
 * marking. The block is hidden on screen. It reuses the report already on the page: there is no second rendering of the figures.
 */
export function ReportPrintHeader({ title, period, currency, fa }: Readonly<{ title: Copy; period: string; currency: string | null; fa: boolean }>) {
  const session = useSession();
  const [when, setWhen] = useState(() => new Date());
  // The time is the moment of printing, not of loading the page.
  useEffect(() => {
    const now = () => setWhen(new Date());
    window.addEventListener("beforeprint", now);
    return () => window.removeEventListener("beforeprint", now);
  }, []);
  const company = session.user?.legalEntityName ?? "";
  return <header className="report-print-header print-only" dir={fa ? "rtl" : "ltr"} lang={fa ? "fa" : "en"} data-testid="report-print-header">
    <p className="report-print-confidential">{CONFIDENTIAL}</p>
    <h2>{title[fa ? "fa" : "en"]}</h2>
    <dl>
      {company ? <div><dt>{fa ? "شرکت" : "Company"}</dt><dd>{company}</dd></div> : null}
      <div><dt>{fa ? "دوره" : "Period"}</dt><dd>{period}</dd></div>
      {currency ? <div><dt>{fa ? "واحد پول" : "Currency"}</dt><dd dir="ltr">{currency}</dd></div> : null}
      <div><dt>{fa ? "زمان چاپ" : "Printed"}</dt><dd suppressHydrationWarning>{printedAt(when, fa)}</dd></div>
    </dl>
  </header>;
}

/** On every printed page of the application: the Confidential marking as a running footer. */
export function PrintConfidentialFooter() {
  return <p className="print-confidential print-only" aria-hidden="true">{CONFIDENTIAL}</p>;
}
