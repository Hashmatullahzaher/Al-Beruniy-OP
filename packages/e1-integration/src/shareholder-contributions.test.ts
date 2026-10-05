import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import test, { after, before, describe } from "node:test";
import pg from "pg";

import { PostgresExecutor } from "@abos/persistence";
import { identityDatabaseProof } from "@abos/sandbox-auth";

import { addSecondEntity, grant } from "./currency-fixtures.ts";
import { databaseUrl, MISSING_DATABASE_MESSAGE, openHarness, resetSchema, type Harness } from "./harness.ts";
import { issueOperationalSession } from "./operational-session.ts";
import { seedSyntheticWorld, SYNTHETIC_AUTH_CONFIGURATION, type SyntheticWorld } from "./synthetic-world.ts";

/**
 * Migration 0035: shareholder contribution DECLARATIONS, through the restricted Finance login exactly
 * as the web server calls them. Every person, party and amount is synthetic. The suite proves that no
 * declaration, edit or cancellation touches Treasury, Safe, posting, journal, subledger, receivable,
 * payable, loan or equity data, and that legacy capital agreements are shown but never copied.
 */

const MARKER = SYNTHETIC_AUTH_CONFIGURATION.runtimeMarker;
const LOGIN = { name: "abos_v1_shareholder_contrib_test_login", password: "synthetic-shareholder-contrib-runtime-only-2026" };
const OWNER = "abos_v1_shareholder_setup_owner";
const MANAGE = "shareholder.setup.manage";
const ENTRY_POINTS = [
  "shareholder_contribution_create(text,text,text,jsonb)", "shareholder_contribution_update(text,text,text,jsonb)",
  "shareholder_contribution_declare(text,text,text,jsonb)", "shareholder_contribution_cancel(text,text,text,jsonb)",
  "shareholder_contributions_workspace(text,text,text)"
] as const;
// Tables a declaration may legitimately write (or that the test itself writes). Everything else must stay identical.
const DECLARATION_TABLES = new Set([
  "shareholder_contributions", "audit_records", "idempotency_records", "sandbox_sessions", "user_credentials",
  "login_attempts", "user_permission_grants", "business_parties", "business_party_roles", "shareholder_profiles"
]);

interface SessionArgs { readonly proof: string; readonly runtimeDigest: string; readonly tokenDigest: string }
type Json = Record<string, unknown>;
interface Contribution {
  id: string; type: string; recordStatus: string; receiptStatus: string; valuationStatus: string; amount: string | null; currency: string | null;
  assetCategory: string | null; itemName: string | null; quantity: string | null; unit: string | null; estimatedValue: string | null;
  valuationCurrency: string | null; creditClassification: string | null; version: number; editable: boolean; description: string | null;
}
interface Holder {
  id: string; name: string; contributions: Contribution[];
  declaredTotals: { type: string; currency: string; amount: string }[];
  estimatedAssetTotals: { currency: string; amount: string }[];
  legacyCashAgreements: { id: string; reference: string; committed: string; currency: string; status: string; installmentCount: number; planned: string }[];
}
interface Workspace { permissions: { canManage: boolean }; shareholders: Holder[] }

if (databaseUrl() === undefined) {
  test("V1 shareholder contributions", () => assert.fail(MISSING_DATABASE_MESSAGE));
} else {
  describe("V1 shareholder contributions (migration 0035)", () => {
    let harness: Harness;
    let restricted: { executor: PostgresExecutor; close(): Promise<void> };
    before(async () => {
      harness = await openHarness(MARKER);
      await resetSchema(harness.pool);
      await ensureLogin(harness);
      restricted = restrictedFinance();
    });
    after(async () => { await restricted.close(); await harness.close(); });

    const call = async <T = Json>(fn: string, session: SessionArgs, payload?: Json): Promise<T> => {
      const sql = payload === undefined ? `SELECT abos.${fn}($1,$2,$3) AS value` : `SELECT abos.${fn}($1,$2,$3,$4::jsonb) AS value`;
      const parameters = payload === undefined
        ? [session.proof, session.runtimeDigest, session.tokenDigest]
        : [session.proof, session.runtimeDigest, session.tokenDigest, JSON.stringify(payload)];
      const result = await restricted.executor.query<{ value: T }>(sql, parameters);
      assert.ok(result.rows[0]);
      return result.rows[0].value;
    };
    const workspace = (session: SessionArgs) => call<Workspace>("shareholder_contributions_workspace", session);
    const holderOf = async (session: SessionArgs, id: string) => {
      const found = (await workspace(session)).shareholders.find((holder) => holder.id === id);
      assert.ok(found, "shareholder listed");
      return found;
    };
    const create = (session: SessionArgs, profileId: string, input: Json) => call<{ contributionId: string; recordStatus: string; version: number; replayed: boolean }>(
      "shareholder_contribution_create", session,
      { shareholderProfileId: profileId, businessDate: "2026-09-15", idempotencyKey: randomUUID(), correlationId: randomUUID(), ...input });
    const cash = (session: SessionArgs, profileId: string, input: Json = {}) =>
      create(session, profileId, { contributionType: "CASH", amount: "50000", currencyCode: "USD", description: "Synthetic cash pledge", ...input });
    const land = (session: SessionArgs, profileId: string, input: Json = {}) =>
      create(session, profileId, { contributionType: "IN_KIND", assetCategory: "LAND_PROPERTY", itemName: "Synthetic plot for Block C",
        description: "Synthetic land for one block", quantity: "1200", unit: "m2", ownershipNote: "Synthetic deed reference SYN-DEED-1",
        estimatedValue: "350000", valuationCurrencyCode: "USD", ...input });

    async function prepared(): Promise<{ world: SyntheticWorld; manager: SessionArgs; holder: string }> {
      await resetSchema(harness.pool);
      const world = await seedSyntheticWorld(harness.executor);
      await grant(harness.executor, world, world.treasuryManagerId, [MANAGE]);
      const manager = await sessionFor(harness, world, world.treasuryManagerId);
      const created = await call<{ shareholderProfileId: string }>("shareholder_setup_create_shareholder", manager,
        { displayName: "Synthetic Contributor", shareholderSince: "2026-01-10", idempotencyKey: randomUUID(), correlationId: randomUUID() });
      return { world, manager, holder: created.shareholderProfileId };
    }

    test("a shareholder with no contribution rows is simply 'none yet'; nothing is stored", async () => {
      const { manager, holder } = await prepared();
      const view = await holderOf(manager, holder);
      assert.deepEqual([view.contributions, view.declaredTotals, view.estimatedAssetTotals], [[], [], []]);
      assert.equal(await count(harness, "SELECT count(*) FROM abos.shareholder_contributions"), 0, "no zero-value row exists");
      await assert.rejects(() => create(manager, holder, { contributionType: "NONE" }), /choose a contribution type/);
      await assert.rejects(() => cash(manager, holder, { amount: "0" }), /plain positive decimals/, "no zero-value cash row either");
      assert.equal(await count(harness, "SELECT count(*) FROM abos.shareholder_contributions"), 0);
    });

    test("CASH, land, goods/materials and CREDIT declarations are recorded with separate status dimensions and no accounting effect", async () => {
      const { manager, holder } = await prepared();
      const before = await financialFingerprint(harness);
      const cashRow = await cash(manager, holder);
      const landRow = await land(manager, holder);
      const goodsRow = await create(manager, holder, { contributionType: "IN_KIND", assetCategory: "GOODS_MATERIALS",
        itemName: "Synthetic cement", quantity: "400", unit: "bags", description: "Synthetic construction material" });
      const creditRow = await create(manager, holder, { contributionType: "CREDIT", amount: "20000", currencyCode: "AFN",
        description: "Synthetic credit line, nature to be decided by Finance" });
      for (const row of [cashRow, landRow, goodsRow, creditRow]) assert.deepEqual([row.recordStatus, row.version, row.replayed], ["DECLARED", 1, false]);
      const view = await holderOf(manager, holder);
      const byId = new Map(view.contributions.map((c) => [c.id, c]));
      const c = byId.get(cashRow.contributionId); const l = byId.get(landRow.contributionId);
      const g = byId.get(goodsRow.contributionId); const r = byId.get(creditRow.contributionId);
      assert.deepEqual([c?.type, c?.amount, c?.currency, c?.receiptStatus, c?.valuationStatus, c?.creditClassification],
        ["CASH", "50000", "USD", "NOT_RECEIVED", "NOT_APPLICABLE", null], "a cash declaration is not cash received");
      assert.deepEqual([l?.type, l?.assetCategory, l?.itemName, l?.quantity, l?.unit, l?.estimatedValue, l?.valuationCurrency, l?.receiptStatus, l?.valuationStatus, l?.amount],
        ["IN_KIND", "LAND_PROPERTY", "Synthetic plot for Block C", "1200", "m2", "350000", "USD", "NOT_RECEIVED", "NOT_VALUED", null]);
      assert.deepEqual([g?.assetCategory, g?.quantity, g?.unit, g?.estimatedValue, g?.valuationStatus], ["GOODS_MATERIALS", "400", "bags", null, "NOT_VALUED"]);
      assert.deepEqual([r?.type, r?.creditClassification, r?.receiptStatus, r?.valuationStatus], ["CREDIT", "UNCLASSIFIED", "NOT_APPLICABLE", "NOT_APPLICABLE"],
        "credit is unclassified and implies no receipt");
      // Totals never mix types or currencies, and the estimate is separate from CASH and CREDIT.
      assert.deepEqual(view.declaredTotals, [{ type: "CASH", currency: "USD", amount: "50000" }, { type: "CREDIT", currency: "AFN", amount: "20000" }]);
      assert.deepEqual(view.estimatedAssetTotals, [{ currency: "USD", amount: "350000" }]);
      assert.deepEqual(await financialFingerprint(harness), before, "no Treasury, Safe, posting, journal, subledger, receivable, payable, loan or equity row");
      const audit = await harness.executor.query<{ action: string; n: string }>(
        "SELECT action, count(*)::text AS n FROM abos.audit_records WHERE entity_type = 'SHAREHOLDER_CONTRIBUTION' GROUP BY action");
      assert.deepEqual(audit.rows, [{ action: "SHAREHOLDER_CONTRIBUTION_RECORDED", n: "4" }]);
    });

    test("credit classification is never taken from the person entering it", async () => {
      const { manager, holder } = await prepared();
      await assert.rejects(() => create(manager, holder, { contributionType: "CREDIT", amount: "1", currencyCode: "USD", description: "x",
        creditClassification: "SHAREHOLDER_LOAN" }), /unknown or missing contribution fields/);
      const creator = await anyUser(harness);
      await assert.rejects(() => harness.executor.query(
        `INSERT INTO abos.shareholder_contributions (id, legal_entity_id, shareholder_profile_id, contribution_type, business_date, description, record_status,
           receipt_status, valuation_status, amount, currency_code, credit_classification, created_by_user_account_id)
         SELECT gen_random_uuid(), legal_entity_id, id, 'CREDIT', current_date, 'x', 'DECLARED', 'NOT_APPLICABLE', 'NOT_APPLICABLE', 1, 'USD', 'OFFSET', $2
           FROM abos.shareholder_profiles WHERE id = $1`, [holder, creator]), /UNCLASSIFIED/, "even a direct write starts UNCLASSIFIED");
    });

    test("a draft is edited, declared, edited again and cancelled, with versions, replays and a full audit trail", async () => {
      const { manager, holder } = await prepared();
      const draft = await cash(manager, holder, { declare: false });
      assert.equal(draft.recordStatus, "DRAFT");
      const edited = await call<{ version: number }>("shareholder_contribution_update", manager,
        { contributionId: draft.contributionId, expectedVersion: 1, businessDate: "2026-09-20", amount: "60000", currencyCode: "AFN", description: "Corrected pledge" });
      assert.equal(edited.version, 2);
      await assert.rejects(() => call("shareholder_contribution_update", manager,
        { contributionId: draft.contributionId, expectedVersion: 1, businessDate: "2026-09-20", amount: "1", currencyCode: "USD" }), /changed; reload/, "stale version refused");
      const declared = await call<{ version: number; changed: boolean }>("shareholder_contribution_declare", manager, { contributionId: draft.contributionId, expectedVersion: 2 });
      assert.deepEqual(declared, { contributionId: draft.contributionId, version: 3, changed: true });
      assert.deepEqual(await call("shareholder_contribution_declare", manager, { contributionId: draft.contributionId, expectedVersion: 2 }),
        { contributionId: draft.contributionId, version: 3, changed: false }, "declaring twice is a replay");
      await call("shareholder_contribution_update", manager,
        { contributionId: draft.contributionId, expectedVersion: 3, businessDate: "2026-09-21", amount: "65000", currencyCode: "AFN", description: "Declared, then corrected" });
      await assert.rejects(() => call("shareholder_contribution_cancel", manager, { contributionId: draft.contributionId, expectedVersion: 4, reason: "x" }), /cancellation reason/);
      const cancelled = await call<{ version: number; changed: boolean }>("shareholder_contribution_cancel", manager,
        { contributionId: draft.contributionId, expectedVersion: 4, reason: "Synthetic pledge withdrawn" });
      assert.deepEqual([cancelled.version, cancelled.changed], [5, true]);
      assert.equal((await call<{ changed: boolean }>("shareholder_contribution_cancel", manager,
        { contributionId: draft.contributionId, expectedVersion: 4, reason: "again" })).changed, false, "cancelling twice is a replay");
      const row = (await holderOf(manager, holder)).contributions[0];
      assert.deepEqual([row?.recordStatus, row?.amount, row?.editable, row?.version], ["CANCELLED", "65000", false, 5], "the cancelled row stays visible");
      assert.deepEqual((await holderOf(manager, holder)).declaredTotals, [], "cancelled rows are not counted");
      await assert.rejects(() => call("shareholder_contribution_update", manager,
        { contributionId: draft.contributionId, expectedVersion: 5, businessDate: "2026-09-21", amount: "1", currencyCode: "USD" }), /only a draft or declared contribution/);
      await assert.rejects(() => call("shareholder_contribution_declare", manager, { contributionId: draft.contributionId, expectedVersion: 5 }), /only a draft contribution/);
      const trail = await harness.executor.query<{ action: string; before_state: Json | null; after_state: Json }>(
        "SELECT action, before_state, after_state FROM abos.audit_records WHERE entity_id = $1 ORDER BY occurred_at, action", [draft.contributionId]);
      assert.deepEqual(trail.rows.map((r) => r.action), ["SHAREHOLDER_CONTRIBUTION_RECORDED", "SHAREHOLDER_CONTRIBUTION_EDITED",
        "SHAREHOLDER_CONTRIBUTION_DECLARED", "SHAREHOLDER_CONTRIBUTION_EDITED", "SHAREHOLDER_CONTRIBUTION_CANCELLED"]);
      assert.equal(trail.rows[1]?.before_state?.amount, "50000");
      assert.equal(trail.rows[1]?.after_state.amount, "60000");
    });

    test("invalid transitions and every later-phase state are refused, for the API and for direct writes", async () => {
      const { manager, holder } = await prepared();
      const row = await land(manager, holder);
      for (const [column, value] of [["record_status", "APPROVED"], ["record_status", "POSTED"], ["receipt_status", "RECEIVED"],
        ["receipt_status", "PARTIALLY_RECEIVED"], ["valuation_status", "VALUED"], ["valuation_status", "APPROVED"]] as const) {
        await assert.rejects(() => harness.executor.query(
          `UPDATE abos.shareholder_contributions SET ${column} = $2, version = version + 1 WHERE id = $1`, [row.contributionId, value]),
          /not available in this phase/, `${column} = ${value}`);
      }
      await assert.rejects(() => harness.executor.query("UPDATE abos.shareholder_contributions SET record_status = 'DRAFT', version = version + 1 WHERE id = $1",
        [row.contributionId]), /cannot change from DECLARED to DRAFT/);
      await assert.rejects(() => harness.executor.query("UPDATE abos.shareholder_contributions SET description = 'x' WHERE id = $1", [row.contributionId]),
        /increments its version/);
      await assert.rejects(() => harness.executor.query("UPDATE abos.shareholder_contributions SET contribution_type = 'CASH', version = version + 1 WHERE id = $1",
        [row.contributionId]), /type.*cannot change/);
      await assert.rejects(() => harness.executor.query("DELETE FROM abos.shareholder_contributions WHERE id = $1", [row.contributionId]), /never deleted/);
      await call("shareholder_contribution_cancel", manager, { contributionId: row.contributionId, expectedVersion: 1, reason: "Synthetic cancel" });
      await assert.rejects(() => harness.executor.query("UPDATE abos.shareholder_contributions SET record_status = 'DECLARED', version = version + 1 WHERE id = $1",
        [row.contributionId]), /cancelled contribution cannot change/, "a cancellation cannot be undone");
    });

    test("each type accepts only its own fields; amounts, currencies and dates are validated", async () => {
      const { manager, holder } = await prepared();
      await assert.rejects(() => cash(manager, holder, { itemName: "Plot" }), /asset fields do not apply/);
      await assert.rejects(() => land(manager, holder, { amount: "100", currencyCode: "USD" }), /no cash amount/);
      await assert.rejects(() => land(manager, holder, { quantity: "", unit: "m2" }), /unit needs a quantity/);
      await assert.rejects(() => land(manager, holder, { valuationCurrencyCode: "" }), /estimated value needs an enabled valuation currency/);
      await assert.rejects(() => land(manager, holder, { estimatedValue: "", valuationCurrencyCode: "USD" }), /valuation currency needs an estimated value/);
      await assert.rejects(() => land(manager, holder, { assetCategory: "VEHICLE" }), /choose an asset category/);
      await assert.rejects(() => land(manager, holder, { itemName: "" }), /item name/);
      await assert.rejects(() => cash(manager, holder, { currencyCode: "EUR" }), /enabled currency is required/);
      await assert.rejects(() => cash(manager, holder, { amount: "1e5" }), /plain positive decimals/);
      await assert.rejects(() => cash(manager, holder, { businessDate: "not-a-date" }), /not a valid date/);
      await assert.rejects(() => create(manager, holder, { contributionType: "CREDIT", amount: "5", currencyCode: "USD" }), /credit contribution needs a description/);
      await assert.rejects(() => cash(manager, holder, { legalEntityId: randomUUID() }), /unknown or missing contribution fields/, "entity never comes from the request");
      assert.equal(await count(harness, "SELECT count(*) FROM abos.shareholder_contributions"), 0);
    });

    test("idempotent submission: an identical replay returns the first result; different details are refused", async () => {
      const { manager, holder } = await prepared();
      const key = randomUUID();
      const first = await cash(manager, holder, { idempotencyKey: key });
      assert.deepEqual(await cash(manager, holder, { idempotencyKey: key, correlationId: randomUUID() }), { ...first, replayed: true });
      await assert.rejects(() => cash(manager, holder, { idempotencyKey: key, amount: "1" }), /already used for different details/);
      assert.equal(await count(harness, "SELECT count(*) FROM abos.shareholder_contributions"), 1);
    });

    test("missing permission is refused before any write; a reader can read but not write; forged sessions are refused", async () => {
      const { world, manager, holder } = await prepared();
      const plain = await sessionFor(harness, world, world.cashierId);
      const before = await count(harness, "SELECT (SELECT count(*) FROM abos.shareholder_contributions) + (SELECT count(*) FROM abos.audit_records) + (SELECT count(*) FROM abos.idempotency_records)");
      await assert.rejects(() => cash(plain, holder), /missing shareholder\.setup\.manage/);
      await assert.rejects(() => workspace(plain), /missing shareholder\.setup\.manage or shareholder\.read/);
      const row = await cash(manager, holder);
      for (const [fn, payload] of [["shareholder_contribution_update", { contributionId: row.contributionId, expectedVersion: 1, businessDate: "2026-09-01", amount: "1", currencyCode: "USD" }],
        ["shareholder_contribution_declare", { contributionId: row.contributionId, expectedVersion: 1 }],
        ["shareholder_contribution_cancel", { contributionId: row.contributionId, expectedVersion: 1, reason: "Not allowed" }]] as const) {
        await assert.rejects(() => call(fn, plain, payload), /missing shareholder\.setup\.manage/, fn);
      }
      await assert.rejects(() => cash({ ...manager, proof: "f".repeat(64) }, holder), /identity runtime proof is invalid/);
      await assert.rejects(() => cash(sessionArgs(`forged-${randomUUID()}`), holder), /sign in with an active account/);
      await grant(harness.executor, world, world.cashierId, ["shareholder.read"]);
      const reader = await sessionFor(harness, world, world.cashierId);
      assert.equal((await workspace(reader)).permissions.canManage, false);
      await assert.rejects(() => cash(reader, holder), /missing shareholder\.setup\.manage/);
      const afterCount = await count(harness, "SELECT (SELECT count(*) FROM abos.shareholder_contributions) + (SELECT count(*) FROM abos.audit_records) + (SELECT count(*) FROM abos.idempotency_records)");
      assert.equal(afterCount - before, 3, "only the permitted manager's single create wrote (row, audit, idempotency)");
    });

    test("another company can neither see nor change these contributions, and the database refuses cross-entity rows", async () => {
      const { world, manager, holder } = await prepared();
      const row = await cash(manager, holder);
      const second = await addSecondEntity(harness.executor, world, [MANAGE]);
      const other = sessionArgs(second.token);
      assert.deepEqual((await workspace(other)).shareholders, []);
      await assert.rejects(() => cash(other, holder), /not an active shareholder of this legal entity/);
      for (const [fn, payload] of [["shareholder_contribution_update", { contributionId: row.contributionId, expectedVersion: 1, businessDate: "2026-09-01", amount: "1", currencyCode: "USD" }],
        ["shareholder_contribution_declare", { contributionId: row.contributionId, expectedVersion: 1 }],
        ["shareholder_contribution_cancel", { contributionId: row.contributionId, expectedVersion: 1, reason: "Hijack attempt" }]] as const) {
        await assert.rejects(() => call(fn, other, payload), /not found in this legal entity/, fn);
      }
      await assert.rejects(() => harness.executor.query(
        `INSERT INTO abos.shareholder_contributions (id, legal_entity_id, shareholder_profile_id, contribution_type, business_date, record_status,
           receipt_status, valuation_status, amount, currency_code, created_by_user_account_id)
         VALUES (gen_random_uuid(), $1, $2, 'CASH', current_date, 'DRAFT', 'NOT_RECEIVED', 'NOT_APPLICABLE', 1, 'USD', $3)`,
        [second.legalEntityId, holder, second.userId]), /foreign key/);
      const mine = (await holderOf(manager, holder)).contributions;
      assert.deepEqual(mine.map((c) => [c.id, c.version, c.recordStatus]), [[row.contributionId, 1, "DECLARED"]], "unchanged by the other company");
    });

    test("least privilege: column grants only, no delete, runtime executes only the five entry points and cannot touch the table", async () => {
      await prepared();
      const tableGrants = await harness.executor.query<{ grantee: string; privilege_type: string }>(
        "SELECT grantee, privilege_type FROM information_schema.role_table_grants WHERE table_schema = 'abos' AND table_name = 'shareholder_contributions' AND grantee <> 'abos' ORDER BY 1, 2");
      assert.deepEqual(tableGrants.rows, [], "no whole-table grant to anyone but the migration owner");
      const owner = await harness.executor.query<{ privilege_type: string; n: string }>(
        `SELECT privilege_type, count(*)::text AS n FROM information_schema.column_privileges
          WHERE table_schema = 'abos' AND table_name = 'shareholder_contributions' AND grantee = $1 GROUP BY 1 ORDER BY 1`, [OWNER]);
      assert.deepEqual(owner.rows, [{ privilege_type: "INSERT", n: "23" }, { privilege_type: "SELECT", n: "30" }, { privilege_type: "UPDATE", n: "21" }]);
      const updatable = await harness.executor.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.column_privileges
          WHERE table_schema = 'abos' AND table_name = 'shareholder_contributions' AND grantee = $1 AND privilege_type = 'UPDATE'
            AND column_name IN ('id','legal_entity_id','shareholder_profile_id','contribution_type','created_by_user_account_id','created_at',
                                'credit_classification','receipt_status','valuation_status')`, [OWNER]);
      assert.deepEqual(updatable.rows, [], "identity, type, classification, receipt and valuation are not updatable by the owner");
      for (const fn of ENTRY_POINTS) {
        const callers = await harness.executor.query<{ role: string }>(
          `SELECT role FROM unnest(ARRAY['abos_e1_runtime','abos_e1_treasury_runtime','abos_v1_identity_runtime','public']) role
            WHERE has_function_privilege(role, $1, 'EXECUTE') ORDER BY 1`, [`abos.${fn}`]);
        assert.deepEqual(callers.rows.map((r) => r.role), ["abos_e1_runtime"], fn);
      }
      for (const helper of ["shareholder_contribution_fields(text,jsonb)", "shareholder_contribution_lock(uuid,jsonb)"]) {
        assert.equal((await harness.executor.query<{ ok: boolean }>("SELECT has_function_privilege('abos_e1_runtime', $1, 'EXECUTE') AS ok", [`abos.${helper}`])).rows[0]?.ok, false, helper);
      }
      for (const statement of ["SELECT * FROM abos.shareholder_contributions", "UPDATE abos.shareholder_contributions SET description = 'x'",
        "DELETE FROM abos.shareholder_contributions",
        "INSERT INTO abos.shareholder_contributions (id) VALUES (gen_random_uuid())"]) {
        await assert.rejects(() => restricted.executor.query(statement), /permission denied/, statement);
      }
      const client = await harness.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`SET LOCAL ROLE ${OWNER}`);
        await assert.rejects(() => client.query("DELETE FROM abos.shareholder_contributions"), /permission denied/);
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });

    test("a legacy real-style cash capital agreement stays unchanged, is shown separately and is never counted twice", async () => {
      const { manager, holder } = await prepared();
      // The same shape as the preserved company's record: a DRAFT USD capital agreement with one DRAFT installment.
      const agreement = await call<{ capitalAgreementId: string }>("shareholder_setup_create_agreement", manager,
        { shareholderProfileId: holder, agreementReference: "SYN-LEGACY-1", committedAmount: "100000", currencyCode: "USD",
          effectiveOn: "2026-09-01", idempotencyKey: randomUUID(), correlationId: randomUUID() });
      await call("shareholder_setup_add_installment", manager,
        { capitalAgreementId: agreement.capitalAgreementId, expectedAmount: "40000", dueOn: "2026-12-01", idempotencyKey: randomUUID(), correlationId: randomUUID() });
      const legacyBefore = await legacyFingerprint(harness);
      const declared = await cash(manager, holder, { amount: "25000", currencyCode: "USD" });
      await call("shareholder_contribution_update", manager, { contributionId: declared.contributionId, expectedVersion: 1, businessDate: "2026-09-16", amount: "30000", currencyCode: "USD" });
      const view = await holderOf(manager, holder);
      assert.deepEqual(view.legacyCashAgreements.map((a) => [a.reference, a.committed, a.currency, a.status, a.installmentCount, a.planned]),
        [["SYN-LEGACY-1", "100000", "USD", "DRAFT", 1, "40000"]], "the legacy agreement is visible as history");
      assert.deepEqual(view.contributions.map((c) => [c.type, c.amount]), [["CASH", "30000"]], "it is not copied into contributions");
      assert.deepEqual(view.declaredTotals, [{ type: "CASH", currency: "USD", amount: "30000" }], "and not added to the declared totals");
      assert.equal(await count(harness, "SELECT count(*) FROM abos.shareholder_contributions"), 1);
      assert.deepEqual(await legacyFingerprint(harness), legacyBefore, "capital agreements, installments and requests are byte-for-byte unchanged");
    });
  });
}

/** The first column of the first row, as a number. */
async function count(harness: Harness, sql: string): Promise<number> {
  const row = (await harness.executor.query<Record<string, unknown>>(sql)).rows[0];
  return Number(row === undefined ? 0 : Object.values(row)[0]);
}

async function anyUser(harness: Harness): Promise<string> {
  return (await harness.executor.query<{ id: string }>("SELECT id FROM abos.user_accounts ORDER BY created_at LIMIT 1")).rows[0]?.id ?? "";
}

/** Row count and content hash of every abos table a declaration must not touch. */
async function financialFingerprint(harness: Harness): Promise<Record<string, string>> {
  const tables = await harness.executor.query<{ name: string }>(
    "SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'abos' AND c.relkind = 'r' ORDER BY 1");
  const out: Record<string, string> = {};
  for (const { name } of tables.rows) {
    if (DECLARATION_TABLES.has(name)) continue;
    const row = await harness.executor.query<{ fp: string }>(
      `SELECT count(*)::text || ':' || md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS fp FROM abos.${name} t`);
    out[name] = row.rows[0]?.fp ?? "";
  }
  assert.ok(["journals", "journal_lines", "subledger_entries", "posting_intents", "cash_receipts", "capital_receipt_intents",
    "operational_expenses", "capital_agreements", "capital_installments"].every((t) => t in out), "money tables are covered");
  return out;
}

async function legacyFingerprint(harness: Harness): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of ["capital_agreements", "capital_installments", "capital_receipt_intents", "capital_agreement_commitment_usage", "capital_agreement_evidence"]) {
    const row = await harness.executor.query<{ fp: string }>(
      `SELECT count(*)::text || ':' || md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS fp FROM abos.${name} t`);
    out[name] = row.rows[0]?.fp ?? "";
  }
  return out;
}

async function ensureLogin(harness: Harness): Promise<void> {
  await harness.executor.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${LOGIN.name}') THEN
      CREATE ROLE ${LOGIN.name} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
    END IF; END $$`);
  await harness.executor.query(`ALTER ROLE ${LOGIN.name} LOGIN PASSWORD '${LOGIN.password}'`);
  await harness.executor.query(`GRANT abos_e1_runtime TO ${LOGIN.name}`);
}

function restrictedFinance(): { executor: PostgresExecutor; close(): Promise<void> } {
  const url = new URL(databaseUrl() ?? "");
  url.username = LOGIN.name;
  url.password = LOGIN.password;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 2 });
  return { executor: new PostgresExecutor(pool, { runtimeMarker: MARKER }), close: () => pool.end() };
}

async function sessionFor(harness: Harness, world: SyntheticWorld, userId: string): Promise<SessionArgs> {
  return sessionArgs((await issueOperationalSession(harness, userId, world.legalEntityId)).token);
}

function sessionArgs(token: string): SessionArgs {
  return {
    proof: identityDatabaseProof(SYNTHETIC_AUTH_CONFIGURATION.signingSecret),
    runtimeDigest: createHash("sha256").update(token).digest("hex"),
    tokenDigest: createHmac("sha256", SYNTHETIC_AUTH_CONFIGURATION.signingSecret).update(token).digest("hex")
  };
}
