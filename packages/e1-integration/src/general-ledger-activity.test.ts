import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before, describe } from "node:test";
import pg from "pg";
import type { SqlExecutor } from "@abos/database";
import { PostgresExecutor } from "@abos/persistence";
import { databaseUrl, MISSING_DATABASE_MESSAGE, openHarness, resetSchema, withClusterLock, type Harness } from "./harness.ts";
import { addSecondEntity, MARKER, sessionFor } from "./currency-fixtures.ts";
import { seedSyntheticWorld, type SyntheticWorld } from "./synthetic-world.ts";

/**
 * Migration 0024 (V1 backlog #19, part): per-account posted activity for a date range and keyset
 * paging of posted General Ledger lines.
 *
 * Journals are seeded as synthetic POSTED fixtures through the migration-owner connection. As in
 * security-ownership.test.ts, the fixture transaction runs with session_replication_role = replica,
 * which bypasses the posting-guard triggers solely to build read-model data (CHECK constraints still
 * apply). Nothing here exercises or weakens the posting path itself.
 */

const LOGINS = {
  finance: { name: "abos_e1_finance_runtime_test_login", password: "synthetic-finance-runtime-only-2026", role: "abos_e1_runtime" },
  treasury: { name: "abos_e1_treasury_runtime_test_login", password: "synthetic-treasury-runtime-only-2026", role: "abos_e1_treasury_runtime" },
  identity: { name: "abos_v1_identity_runtime_test_login", password: "synthetic-identity-runtime-only-2026", role: "abos_v1_identity_runtime" }
} as const;

const RANGE = ["2026-09-01", "2026-09-30"] as const;
const BIG = "12345678901234567890.123456789";
const TINY = "0.000000000000000001";
const AFN_BIG = "98765432109876543210.987654321";

interface Amounts { readonly debitTotal: string; readonly creditTotal: string; readonly net: string; readonly lineCount: string }
interface ActivityRow extends Amounts {
  readonly accountId: string; readonly accountCode: string; readonly accountName: string; readonly baseCurrency: string;
  readonly originalCurrencies: readonly (Amounts & { readonly currency: string })[];
}
interface Activity {
  readonly syntheticOnly: boolean; readonly legalEntityId: string; readonly basis: string;
  readonly isBalance: boolean; readonly openingBalancesIncluded: boolean;
  readonly accounts: readonly ActivityRow[];
  readonly currencyTotals: readonly (Amounts & { readonly baseCurrency: string; readonly accountCount: string })[];
}
interface Line {
  readonly journalId: string; readonly journalReference: string; readonly lineNumber: number; readonly accountId: string;
  readonly accountingEffectiveDate: string; readonly postedAt: string;
  readonly baseCurrency: string; readonly baseDebit: string; readonly baseCredit: string;
  readonly originalCurrency: string | null; readonly originalAmount: string | null;
}
interface Page {
  readonly syntheticOnly: boolean; readonly legalEntityId: string; readonly pageLimit: number; readonly order: string;
  readonly lines: readonly Line[]; readonly returnedLineCount: number; readonly hasMore: boolean; readonly nextCursor: string | null;
  readonly totals: readonly { readonly currency: string; readonly debits: string; readonly credits: string; readonly lineCount: string }[] | null;
}

interface FixtureLine {
  readonly accountId: string;
  readonly debit?: string;
  readonly credit?: string;
  readonly currency?: string;
  readonly projectId?: string;
  readonly departmentId?: string;
  readonly costCenterId?: string;
}

if (databaseUrl() === undefined) {
  test("V1 General Ledger activity and paging", () => assert.fail(MISSING_DATABASE_MESSAGE));
} else {
  describe("V1 General Ledger activity and paging (migration 0024)", () => {
    let harness: Harness;
    before(async () => {
      harness = await openHarness(MARKER);
      await resetSchema(harness.pool);
      await withClusterLock(harness.pool, async () => {
        for (const login of Object.values(LOGINS)) await ensureLogin(harness, login);
      });
    });
    after(async () => { await harness.close(); });

    test("catalogue: two Finance-owned entry points and one internal helper no runtime can execute", async () => {
      const rows = await harness.executor.query<{
        name: string; owner: string; definer: boolean; config: string[] | null; public_execute: boolean;
        finance: boolean; treasury: boolean; identity: boolean;
      }>(
        `SELECT p.proname AS name, r.rolname AS owner, p.prosecdef AS definer, p.proconfig AS config,
                has_function_privilege('public', p.oid, 'EXECUTE') AS public_execute,
                has_function_privilege('abos_e1_runtime', p.oid, 'EXECUTE') AS finance,
                has_function_privilege('abos_e1_treasury_runtime', p.oid, 'EXECUTE') AS treasury,
                has_function_privilege('abos_v1_identity_runtime', p.oid, 'EXECUTE') AS identity
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_roles r ON r.oid = p.proowner
          WHERE n.nspname = 'abos'
            AND p.proname IN ('finance_general_ledger_activity', 'finance_general_ledger_page', 'finance_gl_visible_lines')
          ORDER BY 1`);
      assert.deepEqual(rows.rows, [
        { name: "finance_general_ledger_activity", owner: "abos_e1_finance_owner", definer: true, config: ["search_path=pg_catalog, pg_temp"], public_execute: false, finance: true, treasury: false, identity: false },
        { name: "finance_general_ledger_page", owner: "abos_e1_finance_owner", definer: true, config: ["search_path=pg_catalog, pg_temp"], public_execute: false, finance: true, treasury: false, identity: false },
        { name: "finance_gl_visible_lines", owner: "abos_e1_finance_owner", definer: false, config: ["search_path=pg_catalog, pg_temp"], public_execute: false, finance: false, treasury: false, identity: false }
      ]);
      // 0020 keeps its exact signature: the new paging entry point is a separate function, not an overload.
      const legacy = await harness.executor.query<{ signature: string }>(
        "SELECT pg_get_function_identity_arguments(p.oid) AS signature FROM pg_proc p WHERE p.proname = 'finance_general_ledger'");
      assert.deepEqual(legacy.rows, [{ signature: "p_bearer_token text, p_from date, p_to date, p_account_id uuid" }]);
    });

    test("activity is exact decimal text per account and base currency, never combined, never a balance", async () => {
      const { world, token } = await freshWorld(harness);
      await postFixture(harness, world, "2026-09-05", "2026-09-05T08:00:00.000001Z", [
        { accountId: world.cashLedgerAccountId, debit: BIG }, { accountId: world.capitalLedgerAccountId, credit: BIG }]);
      await postFixture(harness, world, "2026-09-06", "2026-09-06T08:00:00Z", [
        { accountId: world.cashLedgerAccountId, debit: TINY }, { accountId: world.capitalLedgerAccountId, credit: TINY }]);
      await postFixture(harness, world, "2026-09-07", "2026-09-07T08:00:00Z", [
        { accountId: world.capitalLedgerAccountId, debit: "0.1" }, { accountId: world.cashLedgerAccountId, credit: "0.1" }]);
      // A synthetic AFN-based journal (AFN posting policy is still open): it must stay separate from USD,
      // even on the account that also has USD activity.
      await postFixture(harness, world, "2026-09-08", "2026-09-08T08:00:00Z", [
        { accountId: world.afnCashLedgerAccountId, debit: AFN_BIG, currency: "AFN" },
        { accountId: world.capitalLedgerAccountId, credit: AFN_BIG, currency: "AFN" }]);
      // Draft journals and journals outside the range are not activity in the range.
      await postFixture(harness, world, "2026-09-09", "2026-09-09T08:00:00Z", [
        { accountId: world.cashLedgerAccountId, debit: "7" }, { accountId: world.capitalLedgerAccountId, credit: "7" }], { status: "DRAFT" });
      await postFixture(harness, world, "2026-08-31", "2026-08-31T08:00:00Z", [
        { accountId: world.cashLedgerAccountId, debit: "5" }, { accountId: world.capitalLedgerAccountId, credit: "5" }]);

      const activity = await activityOf(token, ...RANGE);
      assert.equal(activity.syntheticOnly, true);
      assert.equal(activity.legalEntityId, world.legalEntityId);
      assert.equal(activity.basis, "POSTED_ACTIVITY_IN_RANGE");
      assert.equal(activity.isBalance, false);
      assert.equal(activity.openingBalancesIncluded, false);
      const usdCash = "12345678901234567890.123456789000000001";
      assert.deepEqual(activity.accounts.map(({ accountId, accountCode, baseCurrency, debitTotal, creditTotal, net, lineCount }) =>
        ({ accountId, accountCode, baseCurrency, debitTotal, creditTotal, net, lineCount })), [
        { accountId: world.cashLedgerAccountId, accountCode: "1010-USD", baseCurrency: "USD", debitTotal: usdCash, creditTotal: "0.1", net: "12345678901234567890.023456789000000001", lineCount: "3" },
        { accountId: world.afnCashLedgerAccountId, accountCode: "1011-AFN", baseCurrency: "AFN", debitTotal: AFN_BIG, creditTotal: "0", net: AFN_BIG, lineCount: "1" },
        { accountId: world.capitalLedgerAccountId, accountCode: "3010-USD", baseCurrency: "AFN", debitTotal: "0", creditTotal: AFN_BIG, net: `-${AFN_BIG}`, lineCount: "1" },
        { accountId: world.capitalLedgerAccountId, accountCode: "3010-USD", baseCurrency: "USD", debitTotal: "0.1", creditTotal: usdCash, net: "-12345678901234567890.023456789000000001", lineCount: "3" }
      ]);
      assert.deepEqual(activity.accounts[0]?.originalCurrencies, [
        { currency: "USD", debitTotal: usdCash, creditTotal: "0.1", net: "12345678901234567890.023456789000000001", lineCount: "3" }]);
      assert.deepEqual(activity.accounts[2]?.originalCurrencies, [
        { currency: "AFN", debitTotal: "0", creditTotal: AFN_BIG, net: `-${AFN_BIG}`, lineCount: "1" }]);
      const usdAll = "12345678901234567890.223456789000000001";
      assert.deepEqual(activity.currencyTotals, [
        { baseCurrency: "AFN", debitTotal: AFN_BIG, creditTotal: AFN_BIG, net: "0.000000000", lineCount: "2", accountCount: "2" },
        { baseCurrency: "USD", debitTotal: usdAll, creditTotal: usdAll, net: "0.000000000000000000", lineCount: "6", accountCount: "2" }
      ]);

      // The first GL page agrees with the summary and with 0020 on the same range.
      const page = await pageOf(token, ...RANGE);
      assert.deepEqual(page.totals, [
        { currency: "AFN", debits: AFN_BIG, credits: AFN_BIG, lineCount: "2" },
        { currency: "USD", debits: usdAll, credits: usdAll, lineCount: "6" }]);
      assert.deepEqual(page.totals, (await legacyOf(token, ...RANGE)).totals);
      assert.ok(page.lines.some((line) => line.baseDebit === BIG && line.originalAmount === BIG));

      // Range and account filters.
      const narrow = await activityOf(token, "2026-09-06", "2026-09-07");
      assert.deepEqual(narrow.accounts.map((row) => [row.accountCode, row.baseCurrency, row.debitTotal, row.creditTotal]), [
        ["1010-USD", "USD", TINY, "0.1"], ["3010-USD", "USD", "0.1", TINY]]);
      const capitalOnly = await activityOf(token, ...RANGE, world.capitalLedgerAccountId);
      assert.deepEqual(capitalOnly.accounts.map((row) => [row.accountCode, row.baseCurrency]), [["3010-USD", "AFN"], ["3010-USD", "USD"]]);
      assert.deepEqual((await activityOf(token, "2026-10-01", "2026-10-31")).accounts, []);
      await assert.rejects(() => activityOf(token, "2026-09-30", "2026-09-01"), sqlState("22023"));
    });

    test("project, department and cost-center scope is conjunctive and live in the summary and in every page", async () => {
      const { world, token } = await freshWorld(harness);
      const projectId = randomUUID(); const departmentId = randomUUID(); const costCenterId = randomUUID();
      await harness.executor.query("INSERT INTO abos.projects (id, legal_entity_id, code, name, active) VALUES ($1,$2,'GLA-P','Synthetic GL project',true)", [projectId, world.legalEntityId]);
      await harness.executor.query("INSERT INTO abos.departments (id, legal_entity_id, code, name, active) VALUES ($1,$2,'GLA-D','Synthetic GL department',true)", [departmentId, world.legalEntityId]);
      await harness.executor.query("INSERT INTO abos.cost_centers (id, legal_entity_id, code, name, active) VALUES ($1,$2,'GLA-C','Synthetic GL cost center',true)", [costCenterId, world.legalEntityId]);
      const dims = { projectId, departmentId, costCenterId };
      await postFixture(harness, world, "2026-09-10", "2026-09-10T08:00:00Z", [
        { accountId: world.cashLedgerAccountId, debit: "1" }, { accountId: world.capitalLedgerAccountId, credit: "1" }]);
      await postFixture(harness, world, "2026-09-11", "2026-09-11T08:00:00Z", [
        { accountId: world.cashLedgerAccountId, debit: "2", ...dims }, { accountId: world.capitalLedgerAccountId, credit: "2", ...dims }]);
      // Project only: needs the project grant, and nothing else.
      await postFixture(harness, world, "2026-09-12", "2026-09-12T08:00:00Z", [
        { accountId: world.cashLedgerAccountId, debit: "4", projectId }, { accountId: world.capitalLedgerAccountId, credit: "4", projectId }]);

      const view = async () => {
        const activity = await activityOf(token, ...RANGE);
        const lines = await walk(token, ...RANGE, undefined, 1);
        return {
          cash: activity.accounts.find((row) => row.accountCode === "1010-USD")?.debitTotal,
          lineCount: activity.currencyTotals.map((row) => row.lineCount).join(","),
          paged: lines.length,
          firstPageTotal: (await pageOf(token, ...RANGE)).totals?.[0]?.lineCount
        };
      };
      assert.deepEqual(await view(), { cash: "1", lineCount: "2", paged: 2, firstPageTotal: "2" }, "dimensioned lines are hidden without grants");
      const grantScope = (kind: string, id: string) => harness.executor.query(
        `INSERT INTO abos.user_scope_grants (user_account_id, legal_entity_id, scope_kind, scope_id, granted_by_user_account_id)
         VALUES ($1,$2,$3,$4,$5)`, [world.approverId, world.legalEntityId, kind, id, world.bootstrapUserId]);
      await grantScope("PROJECT", projectId);
      assert.deepEqual(await view(), { cash: "5", lineCount: "4", paged: 4, firstPageTotal: "4" }, "project grant alone reveals project-only lines");
      await grantScope("DEPARTMENT", departmentId);
      assert.equal((await view()).cash, "5", "two of three scopes are not enough");
      await grantScope("COST_CENTER", costCenterId);
      assert.deepEqual(await view(), { cash: "7", lineCount: "6", paged: 6, firstPageTotal: "6" }, "all live grants reveal every line");
      await harness.executor.query(
        `UPDATE abos.user_scope_grants SET revoked_at = clock_timestamp()
          WHERE user_account_id = $1 AND legal_entity_id = $2 AND scope_kind = 'COST_CENTER'`, [world.approverId, world.legalEntityId]);
      assert.deepEqual(await view(), { cash: "5", lineCount: "4", paged: 4, firstPageTotal: "4" }, "revocation hides the lines again immediately");
      // A grant held by someone else never widens this actor's view.
      await harness.executor.query(
        `INSERT INTO abos.user_scope_grants (user_account_id, legal_entity_id, scope_kind, scope_id, granted_by_user_account_id)
         VALUES ($1,$2,'COST_CENTER',$3,$4)`, [world.intentCreatorId, world.legalEntityId, costCenterId, world.bootstrapUserId]);
      assert.equal((await view()).cash, "5");
    });

    test("legal-entity isolation, account filter outside the entity, forged tokens and foreign runtimes", async () => {
      const { world, token } = await freshWorld(harness);
      await postFixture(harness, world, "2026-09-10", "2026-09-10T08:00:00Z", [
        { accountId: world.cashLedgerAccountId, debit: "3" }, { accountId: world.capitalLedgerAccountId, credit: "3" }]);
      const second = await secondEntityLedger(harness, world);
      const { cash2, capital2 } = second;
      const foreignJournal = await postFixture(harness, world, "2026-09-10", "2026-09-10T09:00:00Z", [
        { accountId: cash2, debit: "999" }, { accountId: capital2, credit: "999" }], second.fixture);

      const mine = await activityOf(token, ...RANGE);
      assert.deepEqual(mine.accounts.map((row) => [row.accountId, row.debitTotal, row.creditTotal]), [
        [world.cashLedgerAccountId, "3", "0"], [world.capitalLedgerAccountId, "0", "3"]]);
      const minePage = await pageOf(token, ...RANGE);
      assert.ok(minePage.lines.every((line) => line.journalId !== foreignJournal));
      const theirs = await activityOf(second.token, ...RANGE);
      assert.equal(theirs.legalEntityId, second.legalEntityId);
      assert.deepEqual(theirs.accounts.map((row) => [row.accountId, row.debitTotal]), [[cash2, "999"], [capital2, "0"]]);
      assert.ok((await pageOf(second.token, ...RANGE)).lines.every((line) => line.journalId === foreignJournal));

      // An account filter naming another entity's account is refused, not answered with empty data.
      await assert.rejects(() => activityOf(token, ...RANGE, cash2), sqlState("42501", /outside the current legal entity/));
      await assert.rejects(() => pageOf(token, ...RANGE, cash2), sqlState("42501", /outside the current legal entity/));
      await assert.rejects(() => activityOf(token, ...RANGE, randomUUID()), sqlState("42501", /outside the current legal entity/));

      // Forged, short and revoked tokens; a user without the report permission.
      for (const bad of ["invalid-finance-token", "x".repeat(43), ""]) {
        await assert.rejects(() => activityOf(bad, ...RANGE), sqlState("42501", /bearer credential|session is invalid/));
        await assert.rejects(() => pageOf(bad, ...RANGE), sqlState("42501", /bearer credential|session is invalid/));
      }
      const cashierToken = await sessionFor(harness.executor, world.cashierId, world.legalEntityId);
      await assert.rejects(() => activityOf(cashierToken, ...RANGE), sqlState("42501", /authority is missing/));
      await assert.rejects(() => pageOf(cashierToken, ...RANGE), sqlState("42501", /authority is missing/));
      await harness.executor.query(
        "UPDATE abos.user_permission_grants SET revoked_at = clock_timestamp() WHERE user_account_id = $1 AND permission_code = 'finance.report.operational.read'",
        [world.approverId]);
      await assert.rejects(() => activityOf(token, ...RANGE), sqlState("42501", /authority is missing/));

      // Treasury and identity runtimes cannot execute either entry point; no runtime can execute the helper.
      for (const kind of ["treasury", "identity"] as const) {
        for (const call of [
          "SELECT abos.finance_general_ledger_activity($1, DATE '2026-09-01', DATE '2026-09-30', NULL)",
          "SELECT abos.finance_general_ledger_page($1, DATE '2026-09-01', DATE '2026-09-30', NULL, NULL, 100)"
        ]) {
          await assert.rejects(() => restricted(kind, (db) => db.query(call, [token])), permissionDeniedForFunction, `${kind}: ${call}`);
        }
      }
      for (const kind of ["finance", "treasury", "identity"] as const) {
        await assert.rejects(() => restricted(kind, (db) => db.query(
          "SELECT * FROM abos.finance_gl_visible_lines($1, $2, DATE '2026-09-01', DATE '2026-09-30', NULL)",
          [second.legalEntityId, second.userId])), permissionDeniedForFunction, `${kind} cannot call the helper`);
      }
    });

    test("paging returns every line exactly once in the documented order, beyond 100 lines", async () => {
      const { world, token } = await freshWorld(harness);
      // 70 journals: every fifth has three lines, the rest two -> 154 lines. Several journals share
      // an accounting date and an identical posted-at instant, so the journal id and line number
      // tie-breakers are exercised.
      const expected: { journalId: string; date: string; postedAt: string; line: number }[] = [];
      for (let index = 0; index < 70; index += 1) {
        const date = `2026-09-${String(1 + (index % 9)).padStart(2, "0")}`;
        const postedAt = `${date}T10:00:00.${String(index % 3 === 0 ? 1 : 100 + index).padStart(6, "0")}Z`;
        const lines: FixtureLine[] = index % 5 === 0
          ? [{ accountId: world.cashLedgerAccountId, debit: "1.25" }, { accountId: world.cashLedgerAccountId, debit: "2.5" },
            { accountId: world.capitalLedgerAccountId, credit: "3.75" }]
          : [{ accountId: world.cashLedgerAccountId, debit: `${index}.000000000000000001` },
            { accountId: world.capitalLedgerAccountId, credit: `${index}.000000000000000001` }];
        const journalId = await postFixture(harness, world, date, postedAt, lines);
        lines.forEach((_, line) => expected.push({ journalId, date, postedAt, line: line + 1 }));
      }
      assert.equal(expected.length, 154);
      expected.sort((a, b) => cmp(b.date, a.date) || cmp(b.postedAt, a.postedAt) || cmp(b.journalId, a.journalId) || a.line - b.line);
      const expectedKeys = expected.map((row) => `${row.journalId}#${row.line}`);

      const first = await pageOf(token, ...RANGE);
      assert.equal(first.pageLimit, 100);
      assert.equal(first.returnedLineCount, 100);
      assert.equal(first.hasMore, true);
      assert.match(first.nextCursor ?? "", /^[A-Za-z0-9_-]+$/);
      assert.equal(first.order, "accountingEffectiveDate DESC, postedAt DESC, journalId DESC, lineNumber ASC");
      assert.deepEqual(first.totals?.map((row) => row.lineCount), ["154"]);
      // Page one is exactly what 0020 returns.
      const legacy = await legacyOf(token, ...RANGE);
      assert.deepEqual(first.lines, legacy.lines);
      assert.equal(legacy.hasMore, true);

      const second = await pageOf(token, ...RANGE, null, first.nextCursor);
      assert.equal(second.returnedLineCount, 54);
      assert.equal(second.hasMore, false);
      assert.equal(second.nextCursor, null);
      assert.equal(second.totals, null, "totals are returned with the first page only");
      assert.deepEqual([...first.lines, ...second.lines].map(key), expectedKeys);

      // Small pages: every line once, in order, with no gap or duplicate.
      for (const size of [1, 7, 100]) {
        const all = await walk(token, ...RANGE, null, size);
        assert.deepEqual(all.map(key), expectedKeys, `page size ${size}`);
        assert.equal(new Set(all.map(key)).size, 154);
      }
      // A line posted after page one was read, with a newer date, does not shift or repeat the rest.
      await postFixture(harness, world, "2026-09-30", "2026-09-30T10:00:00Z", [
        { accountId: world.cashLedgerAccountId, debit: "9" }, { accountId: world.capitalLedgerAccountId, credit: "9" }]);
      const after = await pageOf(token, ...RANGE, null, first.nextCursor);
      assert.deepEqual(after.lines.map(key), expectedKeys.slice(100));
      // Exactly one full last page ends with a null cursor.
      const exact = await pageOf(token, ...RANGE, null, null, 78);
      const rest = await pageOf(token, ...RANGE, null, exact.nextCursor, 78);
      assert.equal(rest.returnedLineCount, 78);
      assert.equal(rest.hasMore, false);
      assert.equal(rest.nextCursor, null);
      // Account filter pages the same way.
      const capital = await walk(token, ...RANGE, world.capitalLedgerAccountId, 9);
      assert.equal(capital.length, 71);
      assert.ok(capital.every((line) => line.accountId === world.capitalLedgerAccountId));

      for (const size of [0, 101, -1]) {
        await assert.rejects(() => pageOf(token, ...RANGE, null, null, size), sqlState("22023", /page size/));
      }
    });

    test("a tampered or foreign cursor is only a position and never reveals another entity's or out-of-scope lines", async () => {
      const { world, token } = await freshWorld(harness);
      const projectId = randomUUID();
      await harness.executor.query("INSERT INTO abos.projects (id, legal_entity_id, code, name, active) VALUES ($1,$2,'GLC-P','Synthetic cursor project',true)", [projectId, world.legalEntityId]);
      for (let index = 0; index < 6; index += 1) {
        await postFixture(harness, world, `2026-09-1${index}`, `2026-09-1${index}T08:00:00Z`, [
          { accountId: world.cashLedgerAccountId, debit: "1" }, { accountId: world.capitalLedgerAccountId, credit: "1" }]);
      }
      const hidden = await postFixture(harness, world, "2026-09-13", "2026-09-13T09:00:00Z", [
        { accountId: world.cashLedgerAccountId, debit: "50", projectId }, { accountId: world.capitalLedgerAccountId, credit: "50", projectId }]);
      const second = await secondEntityLedger(harness, world);
      const foreign = await postFixture(harness, world, "2026-09-12", "2026-09-12T09:00:00Z", [
        { accountId: second.cash2, debit: "777" }, { accountId: second.capital2, credit: "777" }], second.fixture);

      const visibleKeys = (await walk(token, ...RANGE, null, 100)).map(key);
      assert.equal(visibleKeys.length, 12);
      const forbidden = (line: Line) => line.journalId === foreign || line.journalId === hidden;

      // A position crafted from the foreign journal's and the hidden journal's own sort keys: the
      // caller still gets only its own visible lines after that position.
      for (const [date, postedAt, journalId] of [
        ["2026-09-12", "2026-09-12T09:00:00Z", foreign], ["2026-09-13", "2026-09-13T09:00:00Z", hidden],
        ["2099-12-31", "2099-12-31T00:00:00Z", foreign]
      ] as const) {
        const lines = await walk(token, ...RANGE, null, 5, encode({ v: 1, d: date, p: postedAt, j: journalId, l: 1 }));
        assert.ok(lines.length > 0);
        assert.ok(!lines.some(forbidden), "no foreign or out-of-scope line is returned");
        assert.deepEqual(lines.map(key), visibleKeys.slice(visibleKeys.length - lines.length));
      }
      // Another user's cursor (the second entity's) is just a position in this caller's own lines.
      const theirs = await pageOf(second.token, ...RANGE, null, null, 1);
      assert.equal(theirs.hasMore, true);
      const reused = await pageOf(token, ...RANGE, null, theirs.nextCursor, 100);
      assert.ok(!reused.lines.some(forbidden));
      // A position before the start and after the end.
      const end = await pageOf(token, ...RANGE, null, encode({ v: 1, d: "1900-01-01", p: "1900-01-01T00:00:00Z", j: randomUUID(), l: 1 }));
      assert.deepEqual(end.lines, []);
      assert.equal(end.hasMore, false);
      assert.equal(end.nextCursor, null);

      // Malformed cursors are refused with one generic message.
      const valid = (await pageOf(token, ...RANGE, null, null, 2)).nextCursor ?? "";
      const decoded = JSON.parse(Buffer.from(valid, "base64url").toString("utf8")) as Record<string, unknown>;
      for (const bad of [
        "not a cursor!", "", "A", `${valid}$`, Buffer.from("hello", "utf8").toString("base64url"),
        encode([1, 2, 3]), encode({ ...decoded, v: 2 }), encode({ ...decoded, extra: true }),
        encode({ v: decoded.v, d: decoded.d, p: decoded.p, j: decoded.j }), encode({ ...decoded, l: 0 }),
        encode({ ...decoded, j: "not-a-uuid" }), encode({ ...decoded, d: "2026-02-30" }), encode({ ...decoded, l: null }),
        "x".repeat(401)
      ]) {
        await assert.rejects(() => pageOf(token, ...RANGE, null, bad), sqlState("22023", /cursor is invalid/), bad);
      }
      // A cursor never bypasses authorization: a forged token with a valid cursor is refused first.
      await assert.rejects(() => pageOf("y".repeat(43), ...RANGE, null, valid), sqlState("42501"));
    });
  });
}

// -----------------------------------------------------------------------------------------------

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function key(line: Line): string {
  return `${line.journalId}#${line.lineNumber}`;
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function sqlState(code: string, message?: RegExp): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.equal((error as { code?: string }).code, code, String(error));
    if (message) assert.match(String(error), message);
    return true;
  };
}

function permissionDeniedForFunction(error: unknown): boolean {
  return (error as { code?: string }).code === "42501" && /permission denied for function/.test(String(error));
}

async function freshWorld(harness: Harness): Promise<{ world: SyntheticWorld; token: string }> {
  await resetSchema(harness.pool);
  // The seeded Finance approver already holds finance.report.operational.read.
  const world = await seedSyntheticWorld(harness.executor);
  return { world, token: await sessionFor(harness.executor, world.approverId, world.legalEntityId) };
}

/** A second synthetic legal entity with its own period, two accounts and a report reader. */
async function secondEntityLedger(harness: Harness, world: SyntheticWorld) {
  const second = await addSecondEntity(harness.executor, world, ["finance.report.operational.read"]);
  const periodId = randomUUID(); const cash2 = randomUUID(); const capital2 = randomUUID();
  await harness.executor.query(
    `INSERT INTO abos.accounting_periods (id, legal_entity_id, period_name, starts_on, ends_on, status, opened_by_user_account_id, opened_at)
     VALUES ($1, $2, '2026-09', '2026-09-01', '2026-09-30', 'OPEN', $3, clock_timestamp())`, [periodId, second.legalEntityId, world.bootstrapUserId]);
  for (const [id, code, type, control] of [[cash2, "1010-USD", "ASSET", "CASH"], [capital2, "3010-USD", "EQUITY", "SHAREHOLDER_CAPITAL"]] as const) {
    await harness.executor.query(
      `INSERT INTO abos.ledger_accounts (id, legal_entity_id, account_code, account_name, account_type, control_account_type, posting_allowed, account_currency_code, status)
       VALUES ($1, $2, $3, 'Synthetic second-entity account', $4, $5, true, 'USD', 'ACTIVE')`, [id, second.legalEntityId, code, type, control]);
  }
  return { ...second, cash2, capital2, fixture: { legalEntityId: second.legalEntityId, accountingPeriodId: periodId, postedBy: second.userId } };
}

/** A synthetic POSTED journal (read-model fixture; see the file comment). Returns the journal id. */
async function postFixture(
  harness: Harness, world: SyntheticWorld, date: string, postedAt: string, lines: readonly FixtureLine[],
  options: { readonly legalEntityId?: string; readonly accountingPeriodId?: string; readonly postedBy?: string; readonly status?: "POSTED" | "DRAFT" } = {}
): Promise<string> {
  const legalEntityId = options.legalEntityId ?? world.legalEntityId;
  const currency = lines[0]?.currency ?? "USD";
  const journalId = randomUUID();
  const intentId = randomUUID();
  const status = options.status ?? "POSTED";
  const total = lines.find((line) => line.debit !== undefined)?.debit ?? "1";
  await harness.executor.transaction(async (tx) => {
    await tx.query("SET LOCAL session_replication_role = replica");
    await tx.query(
      `INSERT INTO abos.posting_intents
         (id, legal_entity_id, source_type, source_id, intent_kind, original_amount, original_currency_code,
          base_amount, base_currency_code, accounting_effective_date, correlation_id, idempotency_key, status,
          created_by_user_account_id)
       VALUES ($1, $2, 'SYNTHETIC_GL_FIXTURE', $3, 'SHAREHOLDER_LOAN_RECEIPT', $4::numeric, $5, $4::numeric, $5, $6,
               $7, $8, $9, $10)`,
      [intentId, legalEntityId, randomUUID(), total, currency, date, randomUUID(), `gl-fixture-${intentId}`,
        status === "POSTED" ? "POSTED" : "APPROVED", world.intentCreatorId]);
    await tx.query(
      `INSERT INTO abos.journals
         (id, legal_entity_id, accounting_period_id, posting_intent_id, journal_reference, accounting_effective_date,
          base_currency_code, status, created_by_user_account_id, posted_by_user_account_id, posted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamptz)`,
      [journalId, legalEntityId, options.accountingPeriodId ?? world.accountingPeriodId, intentId,
        `SYN-GL-${journalId.slice(0, 13)}`, date, currency, status, world.bootstrapUserId,
        status === "POSTED" ? options.postedBy ?? world.approverId : null, status === "POSTED" ? postedAt : null]);
    let number = 0;
    for (const line of lines) {
      number += 1;
      const lineCurrency = line.currency ?? currency;
      await tx.query(
        `INSERT INTO abos.journal_lines
           (id, journal_id, legal_entity_id, line_number, ledger_account_id, project_id, department_id, cost_center_id,
            original_amount, original_currency_code, base_debit, base_credit, base_currency_code, source_type, source_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::numeric, $10, $11::numeric, $12::numeric, $10, 'SYNTHETIC_GL_FIXTURE', $13)`,
        [randomUUID(), journalId, legalEntityId, number, line.accountId, line.projectId ?? null, line.departmentId ?? null,
          line.costCenterId ?? null, line.debit ?? line.credit, lineCurrency, line.debit ?? "0", line.credit ?? "0", intentId]);
    }
  });
  return journalId;
}

async function ensureLogin(harness: Harness, login: (typeof LOGINS)[keyof typeof LOGINS]): Promise<void> {
  const exists = await harness.executor.query<{ exists: boolean }>("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists", [login.name]);
  const verb = exists.rows[0]?.exists === true ? "ALTER" : "CREATE";
  const extra = verb === "CREATE" ? " NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION" : "";
  await harness.executor.query(`${verb} ROLE ${login.name} LOGIN INHERIT${extra} PASSWORD '${login.password}'`);
  await harness.executor.query(`GRANT ${login.role} TO ${login.name}`);
}

async function restricted<T>(kind: keyof typeof LOGINS, operation: (db: SqlExecutor) => Promise<T>): Promise<T> {
  const url = new URL(databaseUrl() ?? "");
  url.username = LOGINS[kind].name; url.password = LOGINS[kind].password;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 1 });
  try {
    return await operation(new PostgresExecutor(pool, { runtimeMarker: MARKER }));
  } finally {
    await pool.end();
  }
}

async function value<T>(sql: string, parameters: readonly unknown[]): Promise<T> {
  return restricted("finance", async (db) => {
    const row = (await db.query<{ value: T }>(sql, parameters)).rows[0];
    assert.ok(row);
    return row.value;
  });
}

function activityOf(token: string, from: string, to: string, accountId: string | null = null): Promise<Activity> {
  return value<Activity>("SELECT abos.finance_general_ledger_activity($1, $2::date, $3::date, $4::uuid) AS value", [token, from, to, accountId]);
}

function pageOf(token: string, from: string, to: string, accountId: string | null = null, cursor: string | null = null, pageSize: number | null = null): Promise<Page> {
  return pageSize === null
    ? value<Page>("SELECT abos.finance_general_ledger_page($1, $2::date, $3::date, $4::uuid, $5) AS value", [token, from, to, accountId, cursor])
    : value<Page>("SELECT abos.finance_general_ledger_page($1, $2::date, $3::date, $4::uuid, $5, $6::integer) AS value", [token, from, to, accountId, cursor, pageSize]);
}

function legacyOf(token: string, from: string, to: string): Promise<{ lines: readonly Line[]; totals: Page["totals"]; hasMore: boolean }> {
  return value("SELECT abos.finance_general_ledger($1, $2::date, $3::date, NULL) AS value", [token, from, to]);
}

/** Follows nextCursor from the given start to the end and returns every line. */
async function walk(token: string, from: string, to: string, accountId: string | null | undefined, pageSize: number, start: string | null = null): Promise<Line[]> {
  const lines: Line[] = [];
  let cursor = start;
  for (let guard = 0; guard < 500; guard += 1) {
    const page = await pageOf(token, from, to, accountId ?? null, cursor, pageSize);
    assert.ok(page.returnedLineCount <= pageSize);
    assert.equal(page.hasMore, page.nextCursor !== null);
    lines.push(...page.lines);
    if (page.nextCursor === null) return lines;
    assert.equal(page.returnedLineCount, pageSize, "only the last page may be short");
    cursor = page.nextCursor;
  }
  throw new Error("paging did not terminate");
}
