"use client";

import type { ReportRange } from "@abos/contracts";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, type ReactNode } from "react";

type Mode = "asOf" | "year" | "range";

/** The query a report starts from when the address names no period: the year to date. */
export function defaultReportSearch(search: string): string {
  const query = new URLSearchParams(search);
  if (!query.get("asOf") && !query.get("from") && !query.get("fiscalYearId") && !query.get("periodId")) query.set("asOf", new Date().toISOString().slice(0, 10));
  return query.toString();
}

/** The period chooser shared by the financial reports. It only writes the address; each report reads it, so a link or refresh keeps the view. */
export function ReportFilters({ path, fa, years, canPrint, children, keep = [] }: Readonly<{
  path: string; fa: boolean; years: ReportRange["fiscalYears"]; canPrint: boolean; children?: ReactNode; keep?: readonly string[];
}>) {
  const router = useRouter();
  const params = useSearchParams();
  const today = new Date().toISOString().slice(0, 10);
  const [mode, setMode] = useState<Mode>(params.get("fiscalYearId") ? "year" : params.get("from") ? "range" : "asOf");
  const [asOf, setAsOf] = useState(params.get("asOf") ?? today);
  const [yearId, setYearId] = useState(params.get("fiscalYearId") ?? "");
  const [from, setFrom] = useState(params.get("from") ?? `${today.slice(0, 4)}-01-01`);
  const [to, setTo] = useState(params.get("to") ?? today);
  const valid = mode === "asOf" ? asOf !== "" : mode === "year" ? yearId !== "" : from !== "" && to !== "" && from <= to;

  const submit = () => {
    const query = new URLSearchParams();
    for (const name of keep) { const value = params.get(name); if (value) query.set(name, value); }
    if (mode === "asOf") query.set("asOf", asOf);
    else if (mode === "year") query.set("fiscalYearId", yearId);
    else { query.set("from", from); query.set("to", to); }
    router.push(`${path}?${query}`);
  };

  return (
    <form className="admin-form report-filters" aria-label={fa ? "فیلتر گزارش" : "Report filters"} onSubmit={(event) => { event.preventDefault(); if (valid) submit(); }}>
      {children}
      <label><span>{fa ? "گزارش برای" : "Report for"}</span>
        <select value={mode} onChange={(event) => setMode(event.target.value as Mode)}>
          <option value="asOf">{fa ? "تا تاریخ (از آغاز سال مالی)" : "As of a date (year to date)"}</option>
          {years.length > 0 ? <option value="year">{fa ? "یک سال مالی" : "A financial year"}</option> : null}
          <option value="range">{fa ? "بازهٔ تاریخ" : "A date range"}</option>
        </select></label>
      {mode === "asOf" ? <label><span>{fa ? "تاریخ" : "Date"}</span>
        <input type="date" dir="ltr" value={asOf} onChange={(event) => setAsOf(event.target.value)} /></label> : null}
      {mode === "year" ? <label><span>{fa ? "سال مالی" : "Financial year"}</span>
        <select value={yearId} onChange={(event) => setYearId(event.target.value)}>
          <option value="">{fa ? "انتخاب کنید" : "Choose"}</option>
          {years.map((year) => <option key={year.id} value={year.id}>{fa ? year.labelFa : year.label}</option>)}
        </select></label> : null}
      {mode === "range" ? <>
        <label><span>{fa ? "از" : "From"}</span><input type="date" dir="ltr" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
        <label><span>{fa ? "تا" : "To"}</span><input type="date" dir="ltr" value={to} onChange={(event) => setTo(event.target.value)} /></label>
      </> : null}
      <div className="admin-form-actions">
        <button className="treasury-button gold" type="submit" disabled={!valid}>{fa ? "نمایش" : "Show"}</button>
        <button className="treasury-button" type="button" onClick={() => window.print()} disabled={!canPrint}>{fa ? "چاپ" : "Print"}</button>
      </div>
    </form>
  );
}

/** Whether the period's figures can still change: an open financial year, a closed one, or dates outside any year. */
export function YearStatus({ range, fa }: Readonly<{ range: ReportRange; fa: boolean }>) {
  if (range.fiscalYear === null) return <span className="treasury-chip">{fa ? "خارج از سال مالی" : "Outside a financial year"}</span>;
  const label = fa ? range.fiscalYear.labelFa : range.fiscalYear.label;
  return <span className="treasury-chip">{label} · {range.fiscalYear.closed ? (fa ? "بسته" : "Closed") : (fa ? "باز" : "Open")}</span>;
}
