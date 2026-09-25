import assert from "node:assert/strict";
import test from "node:test";
import {
  addDaysIso,
  daysBetweenIso,
  type FiscalYear,
  formatDual,
  generateFiscalYear,
  GREGORIAN_MONTHS,
  gregorianMonthName,
  SOLAR_HIJRI_MONTHS,
  solarHijriMonthName,
  toDariDigits
} from "./index.ts";

function days(startsOn: string, endsOn: string): number {
  return daysBetweenIso(startsOn, endsOn) + 1;
}

function assertContiguous(fy: FiscalYear): void {
  assert.equal(fy.periods.length, 12);
  fy.periods.forEach((period, index) => {
    assert.equal(period.sequence, index + 1);
    assert.ok(period.startsOn <= period.endsOn, `period ${period.sequence} is non-empty`);
    const next = fy.periods[index + 1];
    if (next) assert.equal(next.startsOn, addDaysIso(period.endsOn, 1), `gap after ${period.sequence}`);
  });
  assert.equal(fy.startsOn, fy.periods[0]?.startsOn);
  assert.equal(fy.endsOn, fy.periods[11]?.endsOn);
  const total = fy.periods.reduce((sum, p) => sum + days(p.startsOn, p.endsOn), 0);
  assert.equal(total, days(fy.startsOn, fy.endsOn));
}

test("SOLAR_HIJRI 1405", () => {
  const fy = generateFiscalYear({ kind: "SOLAR_HIJRI" }, 1405);
  assertContiguous(fy);
  assert.equal(fy.label, "FY 1405 SH");
  assert.equal(fy.labelFa, "سال مالی ۱۴۰۵");
  assert.equal(fy.startsOn, "2026-03-21");
  assert.equal(fy.endsOn, "2027-03-20");
  const lengths = fy.periods.map((p) => days(p.startsOn, p.endsOn));
  assert.deepEqual(lengths.slice(0, 6), [31, 31, 31, 31, 31, 31]);
  assert.deepEqual(lengths.slice(6, 11), [30, 30, 30, 30, 30]);
  assert.ok(lengths[11] === 29 || lengths[11] === 30);
  assert.equal(fy.periods[0]?.nameEn, "Hamal 1405");
  assert.equal(fy.periods[0]?.nameFa, "حمل ۱۴۰۵");
  assert.equal(fy.periods[11]?.nameEn, "Hut 1405");
});

test("SOLAR_HIJRI leap year 1403 ends on 30 Hut", () => {
  const fy = generateFiscalYear({ kind: "SOLAR_HIJRI" }, 1403);
  assertContiguous(fy);
  assert.equal(fy.startsOn, "2024-03-20");
  assert.equal(fy.endsOn, "2025-03-20");
  assert.equal(days(fy.startsOn, fy.endsOn), 366);
});

test("GREGORIAN 2026", () => {
  const fy = generateFiscalYear({ kind: "GREGORIAN" }, 2026);
  assertContiguous(fy);
  assert.equal(fy.label, "FY 2026");
  assert.equal(fy.labelFa, "سال مالی ۲۰۲۶");
  assert.equal(fy.startsOn, "2026-01-01");
  assert.equal(fy.endsOn, "2026-12-31");
  assert.deepEqual(fy.periods[1], {
    sequence: 2,
    nameEn: "February 2026",
    nameFa: "فبروری ۲۰۲۶",
    startsOn: "2026-02-01",
    endsOn: "2026-02-28"
  });
});

test("CUSTOM July-June 2026/27", () => {
  const fy = generateFiscalYear({ kind: "CUSTOM", startMonth: 7, startDay: 1 }, 2026);
  assertContiguous(fy);
  assert.equal(fy.label, "FY 2026/27");
  assert.equal(fy.labelFa, "سال مالی ۲۰۲۶/۲۷");
  assert.equal(fy.startsOn, "2026-07-01");
  assert.equal(fy.endsOn, "2027-06-30");
  assert.equal(fy.periods[0]?.nameEn, "July 2026");
  assert.equal(fy.periods[0]?.nameFa, "جولای ۲۰۲۶");
  assert.equal(fy.periods[11]?.nameEn, "June 2027");
});

test("CUSTOM mid-month start across a leap February", () => {
  const fy = generateFiscalYear({ kind: "CUSTOM", startMonth: 12, startDay: 21 }, 2027);
  assertContiguous(fy);
  assert.equal(fy.label, "FY 2027/28");
  assert.equal(fy.startsOn, "2027-12-21");
  assert.equal(fy.endsOn, "2028-12-20");
  assert.equal(fy.periods[1]?.startsOn, "2028-01-21");
  assert.equal(fy.periods[1]?.endsOn, "2028-02-20");
  assert.equal(fy.periods[2]?.endsOn, "2028-03-20");
  assert.equal(days(fy.startsOn, fy.endsOn), 366);
});

test("CUSTOM starting 1 January is labelled like a calendar year", () => {
  const fy = generateFiscalYear({ kind: "CUSTOM", startMonth: 1, startDay: 1 }, 2026);
  assert.equal(fy.label, "FY 2026");
  assert.deepEqual(fy.periods, generateFiscalYear({ kind: "GREGORIAN" }, 2026).periods);
});

test("invalid fiscal-year inputs throw RangeError", () => {
  assert.throws(() => generateFiscalYear({ kind: "CUSTOM", startMonth: 7, startDay: 29 }, 2026), RangeError);
  assert.throws(() => generateFiscalYear({ kind: "CUSTOM", startMonth: 13, startDay: 1 }, 2026), RangeError);
  assert.throws(() => generateFiscalYear({ kind: "CUSTOM", startMonth: 0, startDay: 1 }, 2026), RangeError);
  assert.throws(() => generateFiscalYear({ kind: "CUSTOM", startMonth: 7, startDay: 0 }, 2026), RangeError);
  assert.throws(() => generateFiscalYear({ kind: "CUSTOM", startMonth: 7.5, startDay: 1 }, 2026), RangeError);
  assert.throws(() => generateFiscalYear({ kind: "SOLAR_HIJRI" }, 1299), RangeError);
  assert.throws(() => generateFiscalYear({ kind: "SOLAR_HIJRI" }, 1501), RangeError);
  assert.throws(() => generateFiscalYear({ kind: "SOLAR_HIJRI" }, 2026), RangeError);
  assert.throws(() => generateFiscalYear({ kind: "GREGORIAN" }, 1405), RangeError);
  assert.throws(() => generateFiscalYear({ kind: "GREGORIAN" }, 3000), RangeError);
});

test("every supported SH year and a spread of custom years are contiguous", () => {
  for (let y = 1300; y <= 1500; y += 1) assertContiguous(generateFiscalYear({ kind: "SOLAR_HIJRI" }, y));
  for (let month = 1; month <= 12; month += 1) {
    for (const day of [1, 15, 28]) {
      assertContiguous(generateFiscalYear({ kind: "CUSTOM", startMonth: month, startDay: day }, 2027));
    }
  }
});

test("month names and Dari digits", () => {
  assert.equal(SOLAR_HIJRI_MONTHS.length, 12);
  assert.equal(GREGORIAN_MONTHS.length, 12);
  assert.equal(solarHijriMonthName(6), "Sunbula");
  assert.equal(solarHijriMonthName(10, "fa"), "جدی");
  assert.equal(gregorianMonthName(9, "fa"), "سپتمبر");
  assert.throws(() => solarHijriMonthName(13), RangeError);
  assert.throws(() => gregorianMonthName(0), RangeError);
  assert.equal(toDariDigits(1405), "۱۴۰۵");
  assert.equal(toDariDigits("2026-07-01"), "۲۰۲۶-۰۷-۰۱");
});

test("formatDual in English and Dari", () => {
  assert.deepEqual(formatDual("2026-03-21", "en"), { gregorian: "21 March 2026", solarHijri: "1 Hamal 1405" });
  assert.deepEqual(formatDual("2026-03-21", "fa"), { gregorian: "۲۱ مارچ ۲۰۲۶", solarHijri: "۱ حمل ۱۴۰۵" });
  assert.deepEqual(formatDual("2025-03-20"), { gregorian: "20 March 2025", solarHijri: "30 Hut 1403" });
  assert.throws(() => formatDual("2026-02-30"), RangeError);
});
