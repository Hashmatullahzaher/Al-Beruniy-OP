/** Display locale: English or Dari (Afghan Persian). */
export type CalendarLocale = "en" | "fa";

export interface MonthName {
  readonly month: number;
  readonly en: string;
  readonly fa: string;
}

/** Afghan (Dari) Solar Hijri month names, 1 Hamal .. 12 Hut. */
export const SOLAR_HIJRI_MONTHS: readonly MonthName[] = [
  { month: 1, en: "Hamal", fa: "حمل" },
  { month: 2, en: "Sawr", fa: "ثور" },
  { month: 3, en: "Jawza", fa: "جوزا" },
  { month: 4, en: "Saratan", fa: "سرطان" },
  { month: 5, en: "Asad", fa: "اسد" },
  { month: 6, en: "Sunbula", fa: "سنبله" },
  { month: 7, en: "Mizan", fa: "میزان" },
  { month: 8, en: "Aqrab", fa: "عقرب" },
  { month: 9, en: "Qaws", fa: "قوس" },
  { month: 10, en: "Jadi", fa: "جدی" },
  { month: 11, en: "Dalw", fa: "دلو" },
  { month: 12, en: "Hut", fa: "حوت" }
];

/** Gregorian month names in English and in Afghan Dari usage. */
export const GREGORIAN_MONTHS: readonly MonthName[] = [
  { month: 1, en: "January", fa: "جنوری" },
  { month: 2, en: "February", fa: "فبروری" },
  { month: 3, en: "March", fa: "مارچ" },
  { month: 4, en: "April", fa: "اپریل" },
  { month: 5, en: "May", fa: "می" },
  { month: 6, en: "June", fa: "جون" },
  { month: 7, en: "July", fa: "جولای" },
  { month: 8, en: "August", fa: "اگست" },
  { month: 9, en: "September", fa: "سپتمبر" },
  { month: 10, en: "October", fa: "اکتوبر" },
  { month: 11, en: "November", fa: "نومبر" },
  { month: 12, en: "December", fa: "دسمبر" }
];

function lookup(table: readonly MonthName[], month: number, locale: CalendarLocale): string {
  const entry = Number.isInteger(month) ? table[month - 1] : undefined;
  if (!entry) throw new RangeError(`Month ${month} must be an integer between 1 and 12`);
  return locale === "fa" ? entry.fa : entry.en;
}

export function solarHijriMonthName(month: number, locale: CalendarLocale = "en"): string {
  return lookup(SOLAR_HIJRI_MONTHS, month, locale);
}

export function gregorianMonthName(month: number, locale: CalendarLocale = "en"): string {
  return lookup(GREGORIAN_MONTHS, month, locale);
}

const DARI_DIGITS = "۰۱۲۳۴۵۶۷۸۹";

/** Replaces ASCII digits with Eastern Arabic-Indic (Persian) digits ۰-۹. */
export function toDariDigits(value: string | number): string {
  return String(value).replace(/[0-9]/g, (digit) => DARI_DIGITS[Number(digit)] ?? digit);
}
