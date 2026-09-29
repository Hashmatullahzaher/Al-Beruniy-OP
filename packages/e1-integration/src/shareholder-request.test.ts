import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before, describe } from "node:test";
import { databaseUrl, MISSING_DATABASE_MESSAGE, openHarness, resetSchema, type Harness } from "./harness.ts";
import { handOffSyntheticReceipt, recordSyntheticTreasuryReceipt, seedSyntheticWorld, simulatePriorCommitmentUsage, type SyntheticWorld } from "./synthetic-world.ts";
import {
  activateAfnAccount, addAfnAgreement, addInstallmentTo, addSecondEntity, createRequest, ensureFinanceLogin, grant, isoToday, MARKER,
  recordRate, runtime, sessionFor, shareholderWorkspace
} from "./currency-fixtures.ts";

/**
 * Migration 0016, backlog #15 (shareholder capital-request creation in the application) and #12
 * (AFN on the USD foundation): requests go through the restricted runtime login only, the existing
 * funding-policy, ceiling and uniqueness triggers still apply, AFN stays AFN end to end and is never
 * summed with USD, and an AFN request keeps an immutable snapshot of its day's rate.
 */

interface Installment { id: string; sequence: number; expectedAmount: string; currency: string; blockers: string[];
  request: { id: string; status: string; amount: string; currency: string; snapshot: { rate: string; unitCurrency: string; quoteCurrency: string } | null } | null }
interface Workspace {
  canCreate: boolean;
  agreements: { id: string; currency: string; committedAmount: string; consumedAmount: string; installments: Installment[] }[];
  totalsByCurrency: { currency: string; committed: string; requested: string }[];
  destinationAccounts: { id: string; currency: string; usable: boolean }[];
}
interface Prepared { world: SyntheticWorld; creator: string; reader: string; cashier: string; recorder: string }

if (databaseUrl() === undefined) {
  test("V1 shareholder requests", () => assert.fail(MISSING_DATABASE_MESSAGE));
} else {
  describe("V1 shareholder capital requests and AFN (migration 0016, #15 and #12)", () => {
    let harness: Harness;
    before(async () => {
      harness = await openHarness(MARKER);
      await ensureFinanceLogin(harness);
    });
    after(async () => { await harness.close(); });

    async function prepare(): Promise<Prepared> {
      await resetSchema(harness.pool);
      await harness.executor.query("GRANT abos_e1_runtime TO abos_e1_finance_runtime_test_login");
      const world = await seedSyntheticWorld(harness.executor);
      // The seed's intent creator holds the operator-provisioned (unavailable) permission; the app uses the new ACTIVE one.
      await grant(harness.executor, world, world.intentCreatorId, ["shareholder.capital-request.create"]);
      await grant(harness.executor, world, world.approverId, ["shareholder.read", "finance.exchange-rate.record"]);
      return {
        world,
        creator: await sessionFor(harness.executor, world.intentCreatorId, world.legalEntityId),
        reader: await sessionFor(harness.executor, world.approverId, world.legalEntityId),
        cashier: await sessionFor(harness.executor, world.cashierId, world.legalEntityId),
        recorder: await sessionFor(harness.executor, world.approverId, world.legalEntityId)
      };
    }

    test("a permitted user creates a USD request from an eligible installment; Treasury can take it; replays are idempotent", async () => {
      const { world, creator, reader } = await prepare();
      const key = randomUUID();
      const request = { installmentId: world.installmentId, destination: world.cashAccountId, amount: "25000.00", businessDate: isoToday(), key };
      const created = await runtime((db) => createRequest(db, creator, request));
      assert.equal(created.replayed, false);
      assert.equal(created.snapshotId, null, "a base-currency request takes no rate snapshot");
      const replay = await runtime((db) => createRequest(db, creator, request));
      assert.deepEqual(replay, { id: created.id, replayed: true, snapshotId: null });
      await assert.rejects(() => runtime((db) => createRequest(db, creator, { ...request, amount: "24000" })), /already used for a different request/);
      await assert.rejects(() => runtime((db) => createRequest(db, creator, { ...request, key: randomUUID() })), /already has a capital request/);

      const row = await harness.executor.query<{ status: string; classification: string; contribution_state: string; amount: string; currency_code: string; created_by_user_account_id: string }>(
        "SELECT status, classification, contribution_state, amount, currency_code, created_by_user_account_id FROM abos.capital_receipt_intents WHERE id = $1", [created.id]);
      assert.deepEqual(row.rows[0], { status: "ELIGIBLE", classification: "PAID_IN_SHARE_CAPITAL", contribution_state: "PENDING",
        amount: "25000.00", currency_code: "USD", created_by_user_account_id: world.intentCreatorId });
      const history = await harness.executor.query<{ count: string }>("SELECT count(*)::text AS count FROM abos.capital_receipt_intent_history WHERE capital_receipt_intent_id = $1", [created.id]);
      assert.equal(history.rows[0]?.count, "1");
      const audit = await harness.executor.query<{ actor_user_account_id: string }>(
        "SELECT actor_user_account_id FROM abos.audit_records WHERE action = 'SHAREHOLDER_CAPITAL_REQUEST_CREATED' AND entity_id = $1", [created.id]);
      assert.equal(audit.rows[0]?.actor_user_account_id, world.intentCreatorId);

      const view = await runtime((db) => shareholderWorkspace<Workspace>(db, reader));
      assert.equal(view.canCreate, false, "shareholder.read sees requests but cannot create");
      const installment = view.agreements[0]?.installments[0];
      assert.equal(installment?.request?.id, created.id);
      assert.ok(installment?.blockers.includes("HAS_REQUEST"));
      assert.equal(view.agreements[0]?.consumedAmount, "25000.00");

      // Treasury receives, counts and verifies the cash against the request, through the real services.
      const receipt = await recordSyntheticTreasuryReceipt(harness.executor, world, { capitalReceiptIntentId: created.id, amount: "25000.00" });
      const verified = await harness.executor.query<{ status: string }>("SELECT status FROM abos.cash_receipts WHERE id = $1", [receipt.cashReceiptId]);
      assert.equal(verified.rows[0]?.status, "VERIFIED");
    });

    test("eligibility, partial-installment and commitment-ceiling rules are enforced", async () => {
      const { world, creator } = await prepare();
      const today = isoToday();
      const usd = (installmentId: string, amount: string) => runtime((db) => createRequest(db, creator, { installmentId, destination: world.cashAccountId, amount, businessDate: today }));
      await assert.rejects(() => usd(world.installmentId, "25000.01"), /exceeds the expected installment amount/);
      await assert.rejects(() => usd(world.installmentId, "0"), /greater than zero/);
      await assert.rejects(() => usd(world.installmentId, "1e3"), /plain decimal/);
      await assert.rejects(() => runtime((db) => createRequest(db, creator, { installmentId: world.installmentId, destination: world.afnCashAccountId, amount: "25000", businessDate: today })),
        /never converted/);
      await assert.rejects(() => runtime((db) => createRequest(db, creator, { installmentId: world.installmentId, destination: world.cashAccountId, amount: "25000", businessDate: today, exchangeRateId: randomUUID() })),
        /takes no exchange rate/);
      const future = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
      await assert.rejects(() => runtime((db) => createRequest(db, creator, { installmentId: world.installmentId, destination: world.cashAccountId, amount: "25000", businessDate: future })), /future/);
      // Partial installments are allowed by this synthetic agreement.
      await usd(world.installmentId, "10000");
      // A valid plan: 25000 + 30000 + 30000 + 14999 = 99999 of 100000 committed (0031 invariant).
      const second = await addInstallmentTo(harness.executor, world, world.agreementId, 2, "30000", "USD");
      const third = await addInstallmentTo(harness.executor, world, world.agreementId, 3, "30000", "USD");
      const fourth = await addInstallmentTo(harness.executor, world, world.agreementId, 4, "14999", "USD");
      await usd(second, "30000");
      await usd(third, "30000");
      // 90000 already consumed (70000 here plus 20000 simulated from outside this plan): the 0003
      // commitment-usage ceiling refuses the full 14999 installment even though the plan fits.
      await simulatePriorCommitmentUsage(harness.executor, world, "90000");
      await assert.rejects(() => usd(fourth, "14999"), /exceed the committed amount/);
      const unknown = randomUUID();
      await assert.rejects(() => usd(unknown, "1"), /installment was not found/);

      // The recorded funding decision governs, not the status name.
      await harness.executor.query("UPDATE abos.capital_agreements SET status = 'SUSPENDED' WHERE id = $1", [world.agreementId]);
      const fifth = await addInstallmentTo(harness.executor, world, world.agreementId, 5, "1", "USD");
      await assert.rejects(() => usd(fifth, "1"), /not fundable/);
      const view = await runtime((db) => shareholderWorkspace<Workspace>(db, creator));
      assert.ok(view.agreements[0]?.installments.find((item) => item.id === fifth)?.blockers.includes("AGREEMENT_NOT_FUNDABLE"));

      // No verified registration: refused.
      const afn = await addAfnAgreement(harness.executor, world, { committedAmount: "100", installments: ["100"] });
      await harness.executor.query("UPDATE abos.registration_evidence SET status = 'REJECTED' WHERE capital_agreement_id = $1", [afn.agreementId]);
      await activateAfnAccount(harness.executor, world);
      await assert.rejects(() => runtime((db) => createRequest(db, creator, { installmentId: afn.installmentIds[0] ?? "", destination: world.afnCashAccountId, amount: "100", businessDate: today })),
        /registration evidence is required/);
    });

    test("unauthorized, cross-entity and direct-table requests are refused", async () => {
      const { world, creator, reader, cashier } = await prepare();
      const request = { installmentId: world.installmentId, destination: world.cashAccountId, amount: "25000", businessDate: isoToday() };
      await assert.rejects(() => runtime((db) => createRequest(db, reader, request)), /Shareholder authority is missing shareholder.capital-request.create/);
      await assert.rejects(() => runtime((db) => createRequest(db, cashier, request)), /authority is missing/);
      await assert.rejects(() => runtime((db) => shareholderWorkspace(db, cashier)), /authority is missing/);
      await assert.rejects(() => runtime((db) => createRequest(db, "y".repeat(43), request)), /session is invalid/);
      const other = await addSecondEntity(harness.executor, world, ["shareholder.capital-request.create"]);
      await assert.rejects(() => runtime((db) => createRequest(db, other.token, request)), /installment was not found/);
      const otherView = await runtime((db) => shareholderWorkspace<Workspace>(db, other.token));
      assert.deepEqual(otherView.agreements, [], "another entity's agreements are invisible");
      await assert.rejects(() => runtime((db) => db.query("SELECT * FROM abos.capital_receipt_intents")), /permission denied/);
      await assert.rejects(() => runtime((db) => db.query("SELECT abos.shareholder_runtime_authorize($1, 'shareholder.read')", [creator])), /permission denied/);
      // The legacy, unavailable catalogue permission is not enough, even when granted directly.
      await harness.executor.query("UPDATE abos.user_permission_grants SET revoked_at = clock_timestamp() WHERE user_account_id = $1 AND permission_code = 'shareholder.capital-request.create'", [world.intentCreatorId]);
      await assert.rejects(() => runtime((db) => createRequest(db, creator, request)), /authority is missing/);
      const count = await harness.executor.query<{ count: string }>("SELECT count(*)::text AS count FROM abos.capital_receipt_intents");
      assert.equal(count.rows[0]?.count, "0");
    });

    test("AFN: stays AFN in Treasury custody, keeps its day's rate, is never summed with USD and never posted", async () => {
      const { world, creator, recorder } = await prepare();
      const today = isoToday();
      const afn = await addAfnAgreement(harness.executor, world, { committedAmount: "5000000", installments: ["1782500", "1782500"] });
      const [first = "", second = ""] = afn.installmentIds;
      const request = (installmentId: string, extra: { exchangeRateId?: string } = {}) => runtime((db) => createRequest(db, creator,
        { installmentId, destination: world.afnCashAccountId, amount: "1782500", businessDate: today, ...extra }));

      // The seeded AFN safe account is DRAFT until Treasury activates it.
      await assert.rejects(() => request(first), /Treasury has not activated the AFN account/);
      let view = await runtime((db) => shareholderWorkspace<Workspace>(db, creator));
      assert.ok(view.agreements.find((item) => item.id === afn.agreementId)?.installments[0]?.blockers.includes("NO_ACTIVE_ACCOUNT"));
      await activateAfnAccount(harness.executor, world);

      // No rate for the business date: refused, and nothing is kept.
      await runtime((db) => recordRate(db, recorder, { date: "2026-09-01", rate: "70" }));
      await assert.rejects(() => request(first), (error: unknown) => (error as { code?: string }).code === "P0002" && /record that day's rate first/.test(String(error)));
      const none = await harness.executor.query<{ count: string }>("SELECT count(*)::text AS count FROM abos.capital_receipt_intents WHERE currency_code = 'AFN'");
      assert.equal(none.rows[0]?.count, "0");

      const market = await runtime((db) => recordRate(db, recorder, { date: today, rate: "71.2540" }));
      const created = await request(first);
      assert.ok(created.snapshotId);
      const snapshot = await harness.executor.query<{ exchange_rate_id: string; rate_value: string; source_id: string }>(
        "SELECT exchange_rate_id, rate_value, source_id FROM abos.exchange_rate_snapshots WHERE id = $1", [created.snapshotId]);
      assert.deepEqual(snapshot.rows[0], { exchange_rate_id: market, rate_value: "71.2540", source_id: created.id });

      // Two current rates for the day: the request must say which one it uses.
      const saraf = await runtime((db) => recordRate(db, recorder, { date: today, source: "SARAF", rate: "71.3" }));
      await assert.rejects(() => request(second), /choose which rate/);
      await assert.rejects(() => request(second, { exchangeRateId: randomUUID() }), /not a current USD\/AFN rate/);
      const chosen = await request(second, { exchangeRateId: saraf });
      assert.ok(chosen.snapshotId);

      view = await runtime((db) => shareholderWorkspace<Workspace>(db, creator));
      const afnInstallment = view.agreements.find((item) => item.id === afn.agreementId)?.installments[0];
      assert.equal(afnInstallment?.request?.currency, "AFN");
      assert.deepEqual(afnInstallment?.request?.snapshot && [afnInstallment.request.snapshot.rate, afnInstallment.request.snapshot.unitCurrency, afnInstallment.request.snapshot.quoteCurrency],
        ["71.2540", "USD", "AFN"]);
      // Per currency, never summed and never converted.
      assert.deepEqual(view.totalsByCurrency, [
        { currency: "AFN", committed: "5000000", requested: "3565000", agreements: 1 },
        { currency: "USD", committed: "100000.00", requested: "0", agreements: 1 }
      ]);

      // Treasury custody of AFN works on the same model: receipt, count and independent verification in AFN.
      const receipt = await recordSyntheticTreasuryReceipt(harness.executor, world, { capitalReceiptIntentId: created.id, amount: "1782500" });
      const stored = await harness.executor.query<{ status: string; currency_code: string; amount: string }>(
        "SELECT status, currency_code, amount FROM abos.cash_receipts WHERE id = $1", [receipt.cashReceiptId]);
      assert.deepEqual(stored.rows[0], { status: "VERIFIED", currency_code: "AFN", amount: "1782500" });
      const handoffId = await handOffSyntheticReceipt(harness.executor, world, receipt.cashReceiptId);

      // Posting AFN to the USD ledger stays blocked: the posting engine is same-currency USD only.
      const preparer = await sessionFor(harness.executor, world.intentCreatorId, world.legalEntityId);
      await assert.rejects(() => runtime((db) => db.query("SELECT abos.finance_prepare_capital_posting($1, $2, $3, $4)",
        [preparer, handoffId, world.accountingPeriodId, `afn-${randomUUID()}`])), /do not agree/);
      const journals = await harness.executor.query<{ count: string }>("SELECT count(*)::text AS count FROM abos.journal_lines WHERE original_currency_code = 'AFN' OR base_currency_code = 'AFN'");
      assert.equal(journals.rows[0]?.count, "0");
      // The snapshot of a transaction cannot be replaced by a later correction.
      await runtime((db) => db.query("SELECT abos.finance_correct_exchange_rate($1, $2, '72', 'Corrected later')", [recorder, market]));
      const kept = await harness.executor.query<{ rate_value: string }>("SELECT rate_value FROM abos.exchange_rate_snapshots WHERE id = $1", [created.snapshotId]);
      assert.equal(kept.rows[0]?.rate_value, "71.2540");
    });
  });
}
