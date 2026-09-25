import { gregorianMonthName, solarHijriMonthName, toDariDigits } from "./months.ts";
import {
  addDaysIso,
  gregorianIso,
  MAX_SOLAR_HIJRI_YEAR,
  MIN_SOLAR_HIJRI_YEAR,
  parseIso,
  solarHijriMonthLength,
  solarHijriToIso
} from "./solar-hijri.ts";

/** How a company's financial year is defined (owner decision per company). */
export type FiscalYearSettings =
  | { readonly kind: "SOLAR_HIJRI" }
  | { readonly kind: "GREGORIAN" }
  | { readonly kind: "CUSTOM"; readonly startMonth: number; readonly startDay: number };

export type FiscalYearKind = FiscalYearSettings["kind"];

export interface FiscalPeriod {
  /** 1..12 */
  readonly sequence: number;
  readonly nameEn: string;
  readonly nameFa: string;
  /** Inclusive ISO Gregorian date `YYYY-MM-DD`. */
  readonly startsOn: string;
  /** Inclusive ISO Gregorian date `YYYY-MM-DD`. */
  readonly endsOn: string;
}

export interface FiscalYear {
  readonly kind: FiscalYearKind;
  readonly fiscalYear: number;
  /** English label, e.g. "FY 1405 SH", "FY 2026", "FY 2026/27". */
  readonly label: string;
  /** Dari label with Persian digits, e.g. "سال مالی ۱۴۰۵". */
  readonly labelFa: string;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly periods: readonly FiscalPeriod[];
}

/** Supported Gregorian fiscal years (kept inside the Solar Hijri support window). */
export const MIN_GREGORIAN_FISCAL_YEAR = 1922;
export const MAX_GREGORIAN_FISCAL_YEAR = 2120;

function assertIntegerInRange(value: number, min: number, max: number, what: string): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${what} must be an integer between ${min} and ${max}, received ${String(value)}`);
  }
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function generateSolarHijri(fiscalYear: number): FiscalYear {
  assertIntegerInRange(fiscalYear, MIN_SOLAR_HIJRI_YEAR, MAX_SOLAR_HIJRI_YEAR, "Solar Hijri fiscal year");
  const periods: FiscalPeriod[] = [];
  for (let month = 1; month <= 12; month += 1) {
    periods.push({
      sequence: month,
      nameEn: `${solarHijriMonthName(month, "en")} ${fiscalYear}`,
      nameFa: `${solarHijriMonthName(month, "fa")} ${toDariDigits(fiscalYear)}`,
      startsOn: solarHijriToIso(fiscalYear, month, 1),
      endsOn: solarHijriToIso(fiscalYear, month, solarHijriMonthLength(fiscalYear, month))
    });
  }
  return finish("SOLAR_HIJRI", fiscalYear, `FY ${fiscalYear} SH`, `سال مالی ${toDariDigits(fiscalYear)}`, periods);
}

function generateGregorianBased(
  kind: "GREGORIAN" | "CUSTOM",
  fiscalYear: number,
  startMonth: number,
  startDay: number
): FiscalYear {
  assertIntegerInRange(fiscalYear, MIN_GREGORIAN_FISCAL_YEAR, MAX_GREGORIAN_FISCAL_YEAR, "Gregorian fiscal year");
  assertIntegerInRange(startMonth, 1, 12, "startMonth");
  assertIntegerInRange(startDay, 1, 28, "startDay");

  const starts: string[] = [];
  for (let i = 0; i <= 12; i += 1) {
    const monthIndex = startMonth - 1 + i;
    const year = fiscalYear + Math.floor(monthIndex / 12);
    const month = (monthIndex % 12) + 1;
    starts.push(gregorianIso({ year, month, day: startDay }));
  }

  const periods: FiscalPeriod[] = [];
  for (let i = 0; i < 12; i += 1) {
    const startsOn = starts[i] as string;
    const nextStart = starts[i + 1] as string;
    const start = parseIso(startsOn);
    periods.push({
      sequence: i + 1,
      nameEn: `${gregorianMonthName(start.month, "en")} ${start.year}`,
      nameFa: `${gregorianMonthName(start.month, "fa")} ${toDariDigits(start.year)}`,
      startsOn,
      endsOn: addDaysIso(nextStart, -1)
    });
  }

  const calendarYear = startMonth === 1 && startDay === 1;
  const suffix = calendarYear ? "" : `/${pad2((fiscalYear + 1) % 100)}`;
  const label = `FY ${fiscalYear}${suffix}`;
  const labelFa = `سال مالی ${toDariDigits(`${fiscalYear}${suffix}`)}`;
  return finish(kind, fiscalYear, label, labelFa, periods);
}

function finish(
  kind: FiscalYearKind,
  fiscalYear: number,
  label: string,
  labelFa: string,
  periods: FiscalPeriod[]
): FiscalYear {
  const first = periods[0];
  const last = periods[periods.length - 1];
  if (periods.length !== 12 || !first || !last) {
    throw new Error("Internal error: a fiscal year must have exactly 12 periods");
  }
  return { kind, fiscalYear, label, labelFa, startsOn: first.startsOn, endsOn: last.endsOn, periods };
}

/**
 * Generates the 12 contiguous monthly periods of a fiscal year.
 *
 * - SOLAR_HIJRI: `fiscalYear` is the SH year; period n is SH month n.
 * - GREGORIAN: `fiscalYear` is the Gregorian year, January..December.
 * - CUSTOM: Gregorian-based year starting on startMonth/startDay of `fiscalYear`
 *   and ending the day before the same date one year later.
 *
 * @throws RangeError for invalid settings or unsupported years.
 */
export function generateFiscalYear(settings: FiscalYearSettings, fiscalYear: number): FiscalYear {
  switch (settings.kind) {
    case "SOLAR_HIJRI":
      return generateSolarHijri(fiscalYear);
    case "GREGORIAN":
      return generateGregorianBased("GREGORIAN", fiscalYear, 1, 1);
    case "CUSTOM":
      return generateGregorianBased("CUSTOM", fiscalYear, settings.startMonth, settings.startDay);
    default: {
      const unknownKind: never = settings;
      throw new RangeError(`Unknown fiscal year kind: ${JSON.stringify(unknownKind)}`);
    }
  }
}
