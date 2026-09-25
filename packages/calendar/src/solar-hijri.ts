/**
 * Exact Solar Hijri (Hijri Shamsi) <-> Gregorian conversion.
 *
 * Port of the jalaali-js algorithm (Borkowski's method, based on the 2820-year
 * cycle break years). Pure integer arithmetic over Julian Day Numbers; no
 * JavaScript Date objects are used, so results never depend on the host
 * timezone.
 */

/** A calendar date in either calendar. Months and days are 1-based. */
export interface CalendarDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/** First supported Solar Hijri year (inclusive). */
export const MIN_SOLAR_HIJRI_YEAR = 1300;
/** Last supported Solar Hijri year (inclusive). */
export const MAX_SOLAR_HIJRI_YEAR = 1500;

const BREAKS: readonly number[] = [
  -61, 9, 38, 199, 426, 686, 756, 818, 1111, 1181, 1210, 1635, 2060, 2097, 2192, 2262, 2324, 2394,
  2456, 3178
];

function div(a: number, b: number): number {
  return Math.trunc(a / b);
}

function mod(a: number, b: number): number {
  return a - Math.trunc(a / b) * b;
}

interface JalCalResult {
  /** Years since the last leap year (0 means `jy` is a leap year). */
  readonly leap: number;
  /** Gregorian year of the beginning of the Solar Hijri year. */
  readonly gy: number;
  /** Day in March (Gregorian) on which 1 Hamal falls. */
  readonly march: number;
}

/**
 * Determines whether a Solar Hijri year is leap and on which day of March
 * (Gregorian) it begins.
 */
export function jalCal(jy: number): JalCalResult {
  const bl = BREAKS.length;
  const gy = jy + 621;
  let leapJ = -14;
  let jp = BREAKS[0] as number;
  const last = BREAKS[bl - 1] as number;
  if (jy < jp || jy >= last) {
    throw new RangeError(`Solar Hijri year ${jy} is outside the algorithm range`);
  }
  let jump = 0;
  for (let i = 1; i < bl; i += 1) {
    const jm = BREAKS[i] as number;
    jump = jm - jp;
    if (jy < jm) break;
    leapJ = leapJ + div(jump, 33) * 8 + div(mod(jump, 33), 4);
    jp = jm;
  }
  let n = jy - jp;
  leapJ = leapJ + div(n, 33) * 8 + div(mod(n, 33) + 3, 4);
  if (mod(jump, 33) === 4 && jump - n === 4) leapJ += 1;
  const leapG = div(gy, 4) - div((div(gy, 100) + 1) * 3, 4) - 150;
  const march = 20 + leapJ - leapG;
  if (jump - n < 6) n = n - jump + div(jump + 4, 33) * 33;
  let leap = mod(mod(n + 1, 33) - 1, 4);
  if (leap === -1) leap = 4;
  return { leap, gy, march };
}

/** Gregorian date to Julian Day Number. */
export function gregorianToJd(gy: number, gm: number, gd: number): number {
  let d =
    div((gy + div(gm - 8, 6) + 100100) * 1461, 4) +
    div(153 * mod(gm + 9, 12) + 2, 5) +
    gd -
    34840408;
  d = d - div(div(gy + 100100 + div(gm - 8, 6), 100) * 3, 4) + 752;
  return d;
}

/** Julian Day Number to Gregorian date. */
export function jdToGregorian(jdn: number): CalendarDate {
  let j = 4 * jdn + 139361631;
  j = j + div(div(4 * jdn + 183187720, 146097) * 3, 4) * 4 - 3908;
  const i = div(mod(j, 1461), 4) * 5 + 308;
  const day = div(mod(i, 153), 5) + 1;
  const month = mod(div(i, 153), 12) + 1;
  const year = div(j, 1461) - 100100 + div(8 - month, 6);
  return { year, month, day };
}

/** Solar Hijri date to Julian Day Number (no validation). */
export function jalaaliToJd(jy: number, jm: number, jd: number): number {
  const r = jalCal(jy);
  return gregorianToJd(r.gy, 3, r.march) + (jm - 1) * 31 - div(jm, 7) * (jm - 7) + jd - 1;
}

/** Julian Day Number to Solar Hijri date (no range validation). */
export function jdToJalaali(jdn: number): CalendarDate {
  const gy = jdToGregorian(jdn).year;
  let jy = gy - 621;
  const r = jalCal(jy);
  const jdn1f = gregorianToJd(gy, 3, r.march);
  let k = jdn - jdn1f;
  if (k >= 0) {
    if (k <= 185) {
      return { year: jy, month: 1 + div(k, 31), day: mod(k, 31) + 1 };
    }
    k -= 186;
  } else {
    jy -= 1;
    k += 179;
    if (r.leap === 1) k += 1;
  }
  return { year: jy, month: 7 + div(k, 30), day: mod(k, 30) + 1 };
}

function assertInteger(value: number, what: string): void {
  if (!Number.isInteger(value)) {
    throw new RangeError(`${what} must be an integer, received ${String(value)}`);
  }
}

function assertSupportedSolarHijriYear(y: number): void {
  assertInteger(y, "Solar Hijri year");
  if (y < MIN_SOLAR_HIJRI_YEAR || y > MAX_SOLAR_HIJRI_YEAR) {
    throw new RangeError(
      `Solar Hijri year ${y} is outside the supported range ${MIN_SOLAR_HIJRI_YEAR}-${MAX_SOLAR_HIJRI_YEAR}`
    );
  }
}

/** True when the Solar Hijri year has 366 days (Hut has 30 days). */
export function isLeapSolarHijriYear(y: number): boolean {
  assertSupportedSolarHijriYear(y);
  return jalCal(y).leap === 0;
}

/** Number of days in a Solar Hijri month: 31 (1-6), 30 (7-11), 29/30 (12). */
export function solarHijriMonthLength(y: number, m: number): number {
  assertSupportedSolarHijriYear(y);
  assertInteger(m, "Solar Hijri month");
  if (m < 1 || m > 12) throw new RangeError(`Solar Hijri month ${m} must be between 1 and 12`);
  if (m <= 6) return 31;
  if (m <= 11) return 30;
  return isLeapSolarHijriYear(y) ? 30 : 29;
}

/** True when y/m/d is a real Solar Hijri date inside the supported range. */
export function isValidSolarHijriDate(y: number, m: number, d: number): boolean {
  if (![y, m, d].every(Number.isInteger)) return false;
  if (y < MIN_SOLAR_HIJRI_YEAR || y > MAX_SOLAR_HIJRI_YEAR) return false;
  if (m < 1 || m > 12 || d < 1) return false;
  return d <= solarHijriMonthLength(y, m);
}

/** True for proleptic-Gregorian leap years. */
export function isLeapGregorianYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

/** Number of days in a Gregorian month. */
export function gregorianMonthLength(y: number, m: number): number {
  assertInteger(y, "Gregorian year");
  assertInteger(m, "Gregorian month");
  if (m < 1 || m > 12) throw new RangeError(`Gregorian month ${m} must be between 1 and 12`);
  if (m === 2) return isLeapGregorianYear(y) ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

/** First supported Gregorian day (1 Hamal of MIN_SOLAR_HIJRI_YEAR). */
const MIN_JDN = jalaaliToJd(MIN_SOLAR_HIJRI_YEAR, 1, 1);
/** Last supported Gregorian day (last day of Hut of MAX_SOLAR_HIJRI_YEAR). */
const MAX_JDN = jalaaliToJd(MAX_SOLAR_HIJRI_YEAR + 1, 1, 1) - 1;

/** True when y/m/d is a real Gregorian date inside the supported range. */
export function isValidGregorianDate(y: number, m: number, d: number): boolean {
  if (![y, m, d].every(Number.isInteger)) return false;
  if (m < 1 || m > 12 || d < 1 || d > gregorianMonthLength(y, m)) return false;
  const jdn = gregorianToJd(y, m, d);
  return jdn >= MIN_JDN && jdn <= MAX_JDN;
}

function assertValidGregorianDate(y: number, m: number, d: number): void {
  if (!isValidGregorianDate(y, m, d)) {
    throw new RangeError(
      `Invalid or unsupported Gregorian date ${y}-${m}-${d} (supported ${formatIsoParts(jdToGregorian(MIN_JDN))} to ${formatIsoParts(jdToGregorian(MAX_JDN))})`
    );
  }
}

/** Converts a Solar Hijri date to the Gregorian calendar. */
export function toGregorian(y: number, m: number, d: number): CalendarDate {
  if (!isValidSolarHijriDate(y, m, d)) {
    throw new RangeError(`Invalid or unsupported Solar Hijri date ${y}-${m}-${d}`);
  }
  return jdToGregorian(jalaaliToJd(y, m, d));
}

/** Converts a Gregorian date to the Solar Hijri calendar. */
export function toSolarHijri(y: number, m: number, d: number): CalendarDate {
  assertValidGregorianDate(y, m, d);
  return jdToJalaali(gregorianToJd(y, m, d));
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

function formatIsoParts(date: CalendarDate): string {
  return `${pad(date.year, 4)}-${pad(date.month, 2)}-${pad(date.day, 2)}`;
}

/** Formats a Gregorian CalendarDate as an ISO `YYYY-MM-DD` string. */
export function gregorianIso(date: CalendarDate): string {
  assertValidGregorianDate(date.year, date.month, date.day);
  return formatIsoParts(date);
}

const ISO_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parses an ISO `YYYY-MM-DD` Gregorian date string, validating it strictly. */
export function parseIso(iso: string): CalendarDate {
  const match = ISO_PATTERN.exec(iso);
  if (!match) throw new RangeError(`Expected an ISO date YYYY-MM-DD, received "${iso}"`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  assertValidGregorianDate(year, month, day);
  return { year, month, day };
}

/** Solar Hijri date -> ISO Gregorian string. */
export function solarHijriToIso(y: number, m: number, d: number): string {
  return formatIsoParts(toGregorian(y, m, d));
}

/** ISO Gregorian string -> Solar Hijri date. */
export function isoToSolarHijri(iso: string): CalendarDate {
  const g = parseIso(iso);
  return toSolarHijri(g.year, g.month, g.day);
}

/** Adds (or subtracts) whole days to an ISO Gregorian date. */
export function addDaysIso(iso: string, days: number): string {
  assertInteger(days, "days");
  const g = parseIso(iso);
  const result = jdToGregorian(gregorianToJd(g.year, g.month, g.day) + days);
  return gregorianIso(result);
}

/** Number of days from `fromIso` to `toIso` (negative if `toIso` is earlier). */
export function daysBetweenIso(fromIso: string, toIso: string): number {
  const a = parseIso(fromIso);
  const b = parseIso(toIso);
  return gregorianToJd(b.year, b.month, b.day) - gregorianToJd(a.year, a.month, a.day);
}
