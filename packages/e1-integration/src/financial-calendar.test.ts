import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import pg from "pg";
import { generateFiscalYear, solarHijriToIso } from "@abos/calendar";
import type { LegalEntityId, UserAccountId } from "@abos/contracts";
import type { SqlExecutor } from "@abos/database";
import { PostgresExecutor } from "@abos/persistence";
import { SandboxAuthenticator } from "@abos/sandbox-auth";
import { databaseUrl, MISSING_DATABASE_MESSAGE, openHarness, resetSchema, type Harness } from "./harness.ts";
import { seedSyntheticWorld, SYNTHETIC_AUTH_CONFIGURATION, type SyntheticWorld } from "./synthetic-world.ts";

/**
 * Migration 0012: per-company financial calendar, through the restricted Finance login only.
 */

const MARKER = SYNTHETIC_AUTH_CONFIGURATION.runtimeMarker;
const FINANCE = { name: "abos_e1_finance_runtime_test_login", password: "synthetic-finance-runtime-only-2026" };

interface Period { sequence: number; nameEn: string; nameFa: string; startsOn: string; endsOn: string; status: string }
interface View {
  canManage: boolean;
  settings: { calendarKind: string; version: number; reportingCalendars: string[] } | null;
  fiscalYears: { id: string; fiscalYear: number; labelEn: string; labelFa: string; startsOn: string; endsOn: string; periods: Period[] }[];
}

if (databaseUrl() === undefined) {
  test("V1 financial calendar", () => assert.fail(MISSING_DATABASE_MESSAGE));
} else {
  describe("V1 financial calendar (migration 0012)", () => {
    let harness: Harness;
    before(async () => {
      harness = await openHarness(MARKER);
      await harness.executor.query(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${FINANCE.name}') THEN
          CREATE ROLE ${FINANCE.name} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
        END IF; END $$`);
      await harness.executor.query(`ALTER ROLE ${FINANCE.name} LOGIN PASSWORD '${FINANCE.password}'`);
    });
    after(async () => { await harness.close(); });

    test("the database and the calendar library agree on 1 Hamal for every year 1300-1500", async () => {
      await resetSchema(harness.pool);
      const rows = await harness.executor.query<{ year: number; new_year: string }>(
        "SELECT y AS year, abos.solar_hijri_new_year(y)::text AS new_year FROM generate_series(1300, 1500) AS y");
      assert.equal(rows.rows.length, 201);
      for (const row of rows.rows) assert.equal(row.new_year, solarHijriToIso(row.year, 1, 1), `1 Hamal ${row.year}`);
    });

    test("a Solar Hijri year produces twelve contiguous PENDING periods from 1 Hamal, with Dari names", async () => {
      const { manager } = await prepare(harness);
      assert.equal(await finance((db) => configure(db, manager, "SOLAR_HIJRI", null, null, ["SOLAR_HIJRI", "GREGORIAN"], 0)), 1);
      // The seeded synthetic period (September 2026) lies inside 1405 SH: two periods may never share a day.
      await assert.rejects(() => finance((db) => generate(db, manager, 1405)), /overlaps an existing period/);
      const yearId = await finance((db) => generate(db, manager, 1406));
      assert.equal(await finance((db) => generate(db, manager, 1406)), yearId, "generating the same year again is idempotent");
      const view = await finance((db) => calendarView(db, manager));
      const year = view.fiscalYears[0];
      assert.ok(year);
      assert.equal(year.labelEn, "FY 1406 SH");
      assert.equal(year.labelFa, "سال مالی ۱۴۰۶");
      assert.equal(year.startsOn, "2027-03-21");
      assert.equal(year.endsOn, "2028-03-19");
      assert.equal(year.periods.length, 12);
      assert.deepEqual(year.periods.map((period) => period.status), Array(12).fill("PENDING"));
      assert.equal(year.periods[0]?.nameEn, "Hamal 1406");
      assert.equal(year.periods[0]?.nameFa, "حمل ۱۴۰۶");
      assert.equal(year.periods[11]?.nameEn, "Hut 1406");
      assert.equal(year.periods[11]?.endsOn, "2028-03-19");
      const library = generateFiscalYear({ kind: "SOLAR_HIJRI" }, 1406);
      assert.deepEqual(year.periods.map((period) => [period.nameEn, period.nameFa, period.startsOn, period.endsOn]),
        library.periods.map((period) => [period.nameEn, period.nameFa, period.startsOn, period.endsOn]), "database periods equal the library's");
      const lengths = year.periods.map((period) => (Date.parse(period.endsOn) - Date.parse(period.startsOn)) / 86_400_000 + 1);
      assert.deepEqual(lengths.slice(0, 6), [31, 31, 31, 31, 31, 31]);
      assert.deepEqual(lengths.slice(6, 11), [30, 30, 30, 30, 30]);
      for (let index = 1; index < year.periods.length; index += 1) {
        const previous: Period | undefined = year.periods[index - 1]; const current: Period | undefined = year.periods[index];
        assert.equal(Date.parse(current?.startsOn ?? "") - Date.parse(previous?.endsOn ?? ""), 86_400_000, "no gap or overlap");
      }
    });

    test("Gregorian and custom years cover exactly one year; the structure is fixed once a year exists", async () => {
      const { manager } = await prepare(harness);
      await finance((db) => configure(db, manager, "CUSTOM", 7, 1, ["GREGORIAN"], 0));
      await finance((db) => generate(db, manager, 2027));
      const view = await finance((db) => calendarView(db, manager));
      const year = view.fiscalYears[0];
      assert.equal(year?.labelEn, "FY 2027/28");
      assert.equal(year?.startsOn, "2027-07-01");
      assert.equal(year?.endsOn, "2028-06-30");
      assert.equal(year?.periods[0]?.nameEn, "July 2027");
      assert.equal(year?.periods[11]?.nameEn, "June 2028");
      // Changing the year structure after generation is refused; changing report calendars is allowed.
      await assert.rejects(() => finance((db) => configure(db, manager, "GREGORIAN", null, null, ["GREGORIAN"], 1)), /cannot change after a fiscal year/);
      assert.equal(await finance((db) => configure(db, manager, "CUSTOM", 7, 1, ["GREGORIAN", "SOLAR_HIJRI"], 1)), 2);
      await assert.rejects(() => finance((db) => configure(db, manager, "CUSTOM", 7, 1, ["GREGORIAN"], 1)), /changed by someone else/);
      await assert.rejects(() => finance((db) => db.query("SELECT abos.finance_calendar_configure($1, 'CUSTOM', 7, 1, ARRAY['GREGORIAN'], NULL)", [manager])), /expected settings version is required/);

      const second = await prepare(harness);
      await finance((db) => configure(db, second.manager, "GREGORIAN", null, null, ["GREGORIAN", "SOLAR_HIJRI"], 0));
      await finance((db) => generate(db, second.manager, 2027));
      const gregorian = (await finance((db) => calendarView(db, second.manager))).fiscalYears[0];
      assert.equal(gregorian?.labelEn, "FY 2027");
      assert.equal(gregorian?.startsOn, "2027-01-01");
      assert.equal(gregorian?.endsOn, "2027-12-31");
      assert.equal(gregorian?.periods[1]?.endsOn, "2027-02-28");
    });

    test("only the calendar permission can change it; readers see it; nobody writes the tables directly", async () => {
      const { world, manager, reader, cashier } = await prepare(harness);
      await assert.rejects(() => finance((db) => configure(db, reader, "GREGORIAN", null, null, ["GREGORIAN"], 0)), /authority is missing/);
      await assert.rejects(() => finance((db) => calendarView(db, cashier)), /authority is missing/);
      const readerView = await finance((db) => calendarView(db, reader));
      assert.equal(readerView.canManage, false);
      assert.equal(readerView.settings, null);
      await finance((db) => configure(db, manager, "GREGORIAN", null, null, ["GREGORIAN"], 0));
      await assert.rejects(() => finance((db) => generate(db, reader, 2027)), /authority is missing/);
      // Invalid inputs are refused by the database.
      await assert.rejects(() => finance((db) => configure(db, manager, "LUNAR", null, null, ["GREGORIAN"], 1)), /unknown calendar kind/);
      await assert.rejects(() => finance((db) => configure(db, manager, "CUSTOM", 2, 30, ["GREGORIAN"], 1)), /check constraint|violates/);
      await assert.rejects(() => finance((db) => generate(db, manager, 1850)), /out of range/);
      // The restricted login has no table access at all.
      await assert.rejects(() => finance((db) => db.query("INSERT INTO abos.fiscal_years (id) VALUES (gen_random_uuid())")), /permission denied/);
      await assert.rejects(() => finance((db) => db.query("UPDATE abos.accounting_periods SET status = 'OPEN'")), /permission denied/);
      await assert.rejects(() => finance((db) => db.query("SELECT abos.solar_hijri_new_year(1405)")), /permission denied/);
      // Generated years are append-only, and even the owner cannot overlap periods.
      await finance((db) => generate(db, manager, 2027));
      await assert.rejects(() => harness.executor.query("DELETE FROM abos.fiscal_years"), /append-only/);
      await assert.rejects(() => harness.executor.query(
        `INSERT INTO abos.accounting_periods (id, legal_entity_id, period_name, starts_on, ends_on) VALUES (gen_random_uuid(), $1, 'Overlap', '2027-06-15', '2027-07-15')`,
        [world.legalEntityId]), /overlaps an existing period/);
      // The Finance owner can insert only pending periods: status and opened_* are not writable by it.
      const client = await harness.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE abos_e1_finance_owner");
        await assert.rejects(() => client.query(
          `INSERT INTO abos.accounting_periods (id, legal_entity_id, period_name, starts_on, ends_on, status, opened_by_user_account_id, opened_at)
           VALUES (gen_random_uuid(), $1, 'Sneaky', '2030-01-01', '2030-01-31', 'OPEN', $2, clock_timestamp())`,
          [world.legalEntityId, world.bootstrapUserId]), /permission denied for table accounting_periods/);
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
      // The overlap rule also holds as a constraint (any isolation level), not only as a trigger.
      const constraint = await harness.executor.query<{ ok: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'accounting_periods_no_overlap' AND contype = 'x') AS ok");
      assert.equal(constraint.rows[0]?.ok, true);
      // Years far from today cannot be generated (they would be fixed and append-only).
      await assert.rejects(() => finance((db) => generate(db, manager, 2040)), /out of range/);
      const audit = await harness.executor.query<{ action: string }>(
        "SELECT action FROM abos.audit_records WHERE entity_type IN ('FINANCIAL_CALENDAR', 'FISCAL_YEAR') ORDER BY occurred_at");
      assert.deepEqual(audit.rows.map((row) => row.action), ["FINANCIAL_CALENDAR_CONFIGURED", "FISCAL_YEAR_GENERATED"]);
    });
  });
}

// -----------------------------------------------------------------------------------------------

async function prepare(harness: Harness): Promise<{ world: SyntheticWorld; manager: string; reader: string; cashier: string }> {
  await resetSchema(harness.pool);
  await harness.executor.query("GRANT abos_e1_runtime TO abos_e1_finance_runtime_test_login");
  const world = await seedSyntheticWorld(harness.executor);
  // The synthetic intent creator is the calendar manager; the approver only reads.
  await harness.executor.query(
    `INSERT INTO abos.user_permission_grants (user_account_id, legal_entity_id, permission_code, granted_by_user_account_id)
     VALUES ($1, $2, 'finance.calendar.manage', $3)`, [world.intentCreatorId, world.legalEntityId, world.bootstrapUserId]);
  const auth = new SandboxAuthenticator(harness.executor, SYNTHETIC_AUTH_CONFIGURATION);
  const session = async (userId: string) => (await auth.issueSession({ userAccountId: userId as UserAccountId, legalEntityId: world.legalEntityId as LegalEntityId })).token;
  return { world, manager: await session(world.intentCreatorId), reader: await session(world.approverId), cashier: await session(world.cashierId) };
}

async function finance<T>(operation: (db: SqlExecutor) => Promise<T>): Promise<T> {
  const url = new URL(databaseUrl() ?? "");
  url.username = FINANCE.name; url.password = FINANCE.password;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 1 });
  try {
    return await operation(new PostgresExecutor(pool, { runtimeMarker: MARKER }));
  } finally {
    await pool.end();
  }
}

async function configure(db: SqlExecutor, token: string, kind: string, month: number | null, day: number | null, reporting: string[], version: number): Promise<number> {
  const result = await db.query<{ version: number }>(
    "SELECT abos.finance_calendar_configure($1, $2, $3, $4, $5::text[], $6) AS version", [token, kind, month, day, reporting, version]);
  return result.rows[0]?.version ?? -1;
}

async function generate(db: SqlExecutor, token: string, year: number): Promise<string> {
  const result = await db.query<{ id: string }>("SELECT abos.finance_generate_fiscal_year($1, $2) AS id", [token, year]);
  return result.rows[0]?.id ?? "";
}

async function calendarView(db: SqlExecutor, token: string): Promise<View> {
  const result = await db.query<{ value: View }>("SELECT abos.finance_calendar_view($1) AS value", [token]);
  const value = result.rows[0]?.value;
  assert.ok(value);
  return value;
}
