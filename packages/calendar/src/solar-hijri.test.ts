import assert from "node:assert/strict";
import test from "node:test";
import {
  addDaysIso,
  daysBetweenIso,
  gregorianIso,
  gregorianToJd,
  isLeapSolarHijriYear,
  isoToSolarHijri,
  isValidGregorianDate,
  isValidSolarHijriDate,
  jdToGregorian,
  parseIso,
  solarHijriMonthLength,
  solarHijriToIso,
  toGregorian,
  toSolarHijri
} from "./index.ts";

test("known Nowruz vectors (1 Hamal)", () => {
  assert.equal(solarHijriToIso(1403, 1, 1), "2024-03-20");
  assert.equal(solarHijriToIso(1404, 1, 1), "2025-03-21");
  assert.equal(solarHijriToIso(1405, 1, 1), "2026-03-21");
  assert.deepEqual(toGregorian(1405, 1, 1), { year: 2026, month: 3, day: 21 });
  assert.deepEqual(toSolarHijri(2026, 3, 21), { year: 1405, month: 1, day: 1 });
  assert.deepEqual(isoToSolarHijri("2024-03-20"), { year: 1403, month: 1, day: 1 });
});

test("end of Hut in leap and common years", () => {
  assert.equal(isLeapSolarHijriYear(1404), false);
  assert.equal(solarHijriMonthLength(1404, 12), 29);
  assert.equal(solarHijriToIso(1404, 12, 29), "2026-03-20");
  assert.throws(() => toGregorian(1404, 12, 30), RangeError);

  assert.equal(isLeapSolarHijriYear(1403), true);
  assert.equal(solarHijriMonthLength(1403, 12), 30);
  assert.equal(solarHijriToIso(1403, 12, 30), "2025-03-20");
  assert.equal(solarHijriToIso(1399, 12, 30), "2021-03-20");
});

test("leap years follow the 33-year cycle pattern in 1395-1420", () => {
  const leaps: number[] = [];
  for (let y = 1395; y <= 1420; y += 1) if (isLeapSolarHijriYear(y)) leaps.push(y);
  assert.deepEqual(leaps, [1395, 1399, 1403, 1408, 1412, 1416, 1420]);
});

test("each SH year length equals the day gap between consecutive Nowruz dates", () => {
  for (let y = 1300; y < 1500; y += 1) {
    const gap = daysBetweenIso(solarHijriToIso(y, 1, 1), solarHijriToIso(y + 1, 1, 1));
    assert.equal(gap, isLeapSolarHijriYear(y) ? 366 : 365, `year ${y}`);
  }
});

test("round-trips every day from 1 Hamal 1400 to the end of Hut 1410", () => {
  let expectedIso = solarHijriToIso(1400, 1, 1);
  assert.equal(expectedIso, "2021-03-21");
  let count = 0;
  for (let y = 1400; y <= 1410; y += 1) {
    for (let m = 1; m <= 12; m += 1) {
      const length = solarHijriMonthLength(y, m);
      for (let d = 1; d <= length; d += 1) {
        const iso = solarHijriToIso(y, m, d);
        // Consecutive SH days map to consecutive Gregorian days.
        assert.equal(iso, expectedIso, `${y}-${m}-${d}`);
        assert.deepEqual(isoToSolarHijri(iso), { year: y, month: m, day: d });
        expectedIso = addDaysIso(iso, 1);
        count += 1;
      }
    }
  }
  assert.equal(expectedIso, solarHijriToIso(1411, 1, 1));
  assert.equal(count, daysBetweenIso("2021-03-21", solarHijriToIso(1411, 1, 1)));
});

test("Julian Day arithmetic agrees with Date.UTC", () => {
  const epoch = gregorianToJd(1970, 1, 1);
  for (const iso of ["1922-03-21", "2000-02-29", "2024-12-31", "2100-03-01", "2121-03-20"]) {
    const g = parseIso(iso);
    const utcDays = Date.UTC(g.year, g.month - 1, g.day) / 86_400_000;
    assert.equal(gregorianToJd(g.year, g.month, g.day) - epoch, utcDays, iso);
    assert.equal(gregorianIso(jdToGregorian(gregorianToJd(g.year, g.month, g.day))), iso);
  }
});

test("validation and supported range", () => {
  assert.equal(isValidSolarHijriDate(1405, 13, 1), false);
  assert.equal(isValidSolarHijriDate(1405, 7, 31), false);
  assert.equal(isValidSolarHijriDate(1299, 12, 29), false);
  assert.equal(isValidSolarHijriDate(1501, 1, 1), false);
  assert.equal(isValidSolarHijriDate(1300, 1, 1), true);
  assert.equal(isValidSolarHijriDate(1500, 12, solarHijriMonthLength(1500, 12)), true);
  assert.throws(() => toGregorian(1405, 13, 1), RangeError);
  assert.throws(() => toGregorian(1405, 0, 1), RangeError);
  assert.throws(() => toGregorian(1405, 1, 32), RangeError);
  assert.throws(() => toGregorian(1299, 1, 1), RangeError);
  assert.throws(() => toGregorian(1501, 1, 1), RangeError);
  assert.throws(() => toGregorian(1405.5, 1, 1), RangeError);
  assert.throws(() => isLeapSolarHijriYear(1200), RangeError);
  assert.throws(() => solarHijriMonthLength(1405, 13), RangeError);

  assert.equal(isValidGregorianDate(2025, 2, 29), false);
  assert.equal(isValidGregorianDate(2024, 2, 29), true);
  assert.throws(() => toSolarHijri(2025, 2, 29), RangeError);
  assert.throws(() => toSolarHijri(1900, 1, 1), RangeError);
  assert.throws(() => toSolarHijri(2200, 1, 1), RangeError);
  assert.throws(() => parseIso("2026-3-21"), RangeError);
  assert.throws(() => parseIso("2026-02-30"), RangeError);
  assert.throws(() => parseIso("2026-03-21T00:00:00Z"), RangeError);
  assert.deepEqual(parseIso("2026-03-21"), { year: 2026, month: 3, day: 21 });
});
