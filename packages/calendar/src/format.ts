import { type CalendarLocale, gregorianMonthName, solarHijriMonthName, toDariDigits } from "./months.ts";
import { type CalendarDate, isoToSolarHijri, parseIso } from "./solar-hijri.ts";

export interface DualDate {
  /** e.g. "21 March 2026" or "۲۱ مارچ ۲۰۲۶" */
  readonly gregorian: string;
  /** e.g. "1 Hamal 1405" or "۱ حمل ۱۴۰۵" */
  readonly solarHijri: string;
}

function render(date: CalendarDate, monthName: string, locale: CalendarLocale): string {
  const text = `${date.day} ${monthName} ${date.year}`;
  return locale === "fa" ? toDariDigits(text) : text;
}

/** Formats an ISO Gregorian date in the Gregorian calendar. */
export function formatGregorian(isoDate: string, locale: CalendarLocale = "en"): string {
  const g = parseIso(isoDate);
  return render(g, gregorianMonthName(g.month, locale), locale);
}

/** Formats an ISO Gregorian date in the Solar Hijri calendar. */
export function formatSolarHijri(isoDate: string, locale: CalendarLocale = "en"): string {
  const sh = isoToSolarHijri(isoDate);
  return render(sh, solarHijriMonthName(sh.month, locale), locale);
}

/** Formats an ISO Gregorian date in both calendars. */
export function formatDual(isoDate: string, locale: CalendarLocale = "en"): DualDate {
  return {
    gregorian: formatGregorian(isoDate, locale),
    solarHijri: formatSolarHijri(isoDate, locale)
  };
}
