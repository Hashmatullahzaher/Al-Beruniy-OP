import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before, describe } from "node:test";
import { databaseUrl, MISSING_DATABASE_MESSAGE, openHarness, resetSchema, type Harness } from "./harness.ts";
import { seedSyntheticWorld, type SyntheticWorld } from "./synthetic-world.ts";
import {
  addAfnAgreement, addSecondEntity, addSyntheticSaraf, asRole, correctRate, ensureFinanceLogin, grant, isoToday, MARKER,
  ratesView, recordRate, runtime, sessionFor
} from "./currency-fixtures.ts";

/**
 * Migration 0016, backlog #13: daily market/Saraf exchange rates, stored exactly as entered,
 * append-only with superseding corrections, and immutable per-transaction snapshots.
 * Everything goes through the restricted runtime login; the owner connection only seeds.
 */

interface Prepared { world: SyntheticWorld; recorder: string; reader: string; cashier: string }

if (databaseUrl() === undefined) {
  test("V1 exchange rates", () => assert.fail(MISSING_DATABASE_MESSAGE));
} else {
  describe("V1 exchange rates and snapshots (migration 0016, #13)", () => {
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
      await grant(harness.executor, world, world.intentCreatorId, ["finance.exchange-rate.record"]);
      return {
        world,
        recorder: await sessionFor(harness.executor, world.intentCreatorId, world.legalEntityId),
        reader: await sessionFor(harness.executor, world.approverId, world.legalEntityId),
        cashier: await sessionFor(harness.executor, world.cashierId, world.legalEntityId)
      };
    }

    test("a permitted user records the day's rate exactly as entered, with an explicit quote convention and audit", async () => {
      const { world, recorder, reader } = await prepare();
      const today = isoToday();
      const id = await runtime((db) => recordRate(db, recorder, { date: today, rate: "71.254" }));
      const trailing = await runtime((db) => recordRate(db, recorder, { date: "2026-09-20", rate: "71.2540" }));
      const tiny = await runtime((db) => recordRate(db, recorder, { date: "2026-09-19", unit: "AFN", quote: "USD", rate: "0.0140340000000000012345" }));
      const view = await runtime((db) => ratesView(db, reader, "2026-09-01", null));
      assert.equal(view.canRecord, false, "a reader sees rates but cannot record");
      assert.equal(view.legalEntity.baseCurrency, "USD");
      const byId = new Map(view.rates.map((rate) => [rate.id, rate]));
      assert.equal(byId.get(id)?.rate, "71.254", "71.254 stays 71.254");
      assert.equal(byId.get(trailing)?.rate, "71.2540", "the scale is kept exactly as entered");
      assert.equal(byId.get(tiny)?.rate, "0.0140340000000000012345", "no rounding and no precision is imposed");
      assert.deepEqual([byId.get(id)?.unitCurrency, byId.get(id)?.quoteCurrency], ["USD", "AFN"], "71.254 AFN per 1 USD");
      assert.deepEqual([byId.get(tiny)?.unitCurrency, byId.get(tiny)?.quoteCurrency], ["AFN", "USD"], "the direction is stored, never inverted");
      assert.equal(byId.get(id)?.enteredBy, "Synthetic Intent Creator");
      assert.equal(byId.get(id)?.current, true);
      const stored = await harness.executor.query<{ rate_value: string; entered_by_user_account_id: string }>(
        "SELECT rate_value, entered_by_user_account_id FROM abos.exchange_rates WHERE id = $1", [id]);
      assert.deepEqual(stored.rows[0], { rate_value: "71.254", entered_by_user_account_id: world.intentCreatorId });
      const audit = await harness.executor.query<{ actor_user_account_id: string; after_state: { rate: string } }>(
        "SELECT actor_user_account_id, after_state FROM abos.audit_records WHERE action = 'EXCHANGE_RATE_RECORDED' AND entity_id = $1", [id]);
      assert.equal(audit.rows[0]?.actor_user_account_id, world.intentCreatorId, "audit names the true actor");
      assert.equal(audit.rows[0]?.after_state.rate, "71.254");
      // One original per day, source and pair (either direction): a second entry must be a correction.
      await assert.rejects(() => runtime((db) => recordRate(db, recorder, { date: today, rate: "72" })), /already recorded .* correction/);
      await assert.rejects(() => runtime((db) => recordRate(db, recorder, { date: today, unit: "AFN", quote: "USD", rate: "0.014" })), /already recorded/);
      // A Saraf rate for the same day is a separate source, optionally naming the Saraf.
      const saraf = await addSyntheticSaraf(harness.executor, world);
      await runtime((db) => recordRate(db, recorder, { date: today, source: "SARAF", saraf, rate: "71.3" }));
      await runtime((db) => recordRate(db, recorder, { date: today, source: "SARAF", rate: "71.31" }));
      const withSaraf = await runtime((db) => ratesView(db, recorder));
      assert.equal(withSaraf.canRecord, true);
      assert.deepEqual(withSaraf.sarafParties.map((party) => party.name), ["Synthetic Saraf (demonstration)"]);
      assert.equal(withSaraf.rates.filter((rate) => rate.rateDate === today).length, 3);
    });

    test("invalid rates are refused by the database and nothing is invented", async () => {
      const { world, recorder } = await prepare();
      const today = isoToday();
      for (const [rate, message] of [["0", /greater than zero/], ["-71", /plain decimal/], ["7.1e1", /plain decimal/], ["71,254", /plain decimal/],
        ["", /plain decimal/], ["071.2", /plain decimal/], ["1".repeat(41), /plain decimal/]] as const) {
        await assert.rejects(() => runtime((db) => recordRate(db, recorder, { date: today, rate })), message, `rate ${rate}`);
      }
      const future = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
      await assert.rejects(() => runtime((db) => recordRate(db, recorder, { date: future, rate: "71" })), /future date/);
      await assert.rejects(() => runtime((db) => recordRate(db, recorder, { date: today, source: "BANK", rate: "71" })), /MARKET or SARAF/);
      await assert.rejects(() => runtime((db) => recordRate(db, recorder, { date: today, unit: "AFN", quote: "AFN", rate: "1" })), /two different enabled currencies/);
      await assert.rejects(() => runtime((db) => recordRate(db, recorder, { date: today, unit: "USD", quote: "EUR", rate: "1" })), /two different enabled currencies/);
      const saraf = await addSyntheticSaraf(harness.executor, world);
      await assert.rejects(() => runtime((db) => recordRate(db, recorder, { date: today, source: "MARKET", saraf, rate: "71" })), /market rate does not name a Saraf/);
      // A party without a Saraf role cannot be named as the Saraf.
      await assert.rejects(() => runtime((db) => recordRate(db, recorder, { date: today, source: "SARAF", saraf: world.businessPartyId, rate: "71" })), /does not hold a Saraf role/);
      const count = await harness.executor.query<{ count: string }>("SELECT count(*)::text AS count FROM abos.exchange_rates");
      assert.equal(count.rows[0]?.count, "0");
    });

    test("rates are append-only: a correction supersedes the current row with a reason and keeps history", async () => {
      const { world, recorder, reader } = await prepare();
      const today = isoToday();
      const first = await runtime((db) => recordRate(db, recorder, { date: today, rate: "71.254" }));
      await assert.rejects(() => runtime((db) => correctRate(db, recorder, first, "71.26", null)), /needs a reason/);
      await assert.rejects(() => runtime((db) => correctRate(db, recorder, first, "71.2540", "same")), /does not change the rate/);
      await assert.rejects(() => runtime((db) => correctRate(db, reader, first, "71.26", "typo")), /authority is missing/);
      const second = await runtime((db) => correctRate(db, recorder, first, "71.264", "Typing error: 71.264 was quoted"));
      await assert.rejects(() => runtime((db) => correctRate(db, recorder, first, "71.27", "again")), /already been corrected/);
      const third = await runtime((db) => correctRate(db, recorder, second, "71.27", "Second correction"));
      const view = await runtime((db) => ratesView(db, reader));
      const chain = view.rates.filter((rate) => rate.rateDate === today);
      assert.equal(chain.length, 3, "every version is kept");
      assert.deepEqual(chain.filter((rate) => rate.current).map((rate) => rate.id), [third], "exactly one current rate");
      const old = chain.find((rate) => rate.id === first);
      assert.equal(old?.supersededById, second);
      assert.equal(old?.rate, "71.254", "the superseded value is unchanged");
      assert.equal(chain.find((rate) => rate.id === second)?.correctionReason, "Typing error: 71.264 was quoted");
      const audit = await harness.executor.query<{ action: string; before_state: { rate: string } | null }>(
        "SELECT action, before_state FROM abos.audit_records WHERE entity_type = 'EXCHANGE_RATE' ORDER BY occurred_at");
      assert.deepEqual(audit.rows.map((row) => row.action), ["EXCHANGE_RATE_RECORDED", "EXCHANGE_RATE_CORRECTED", "EXCHANGE_RATE_CORRECTED"]);
      assert.equal(audit.rows[1]?.before_state?.rate, "71.254");
      // Nobody can rewrite or delete a rate, not even the migration identity.
      await assert.rejects(() => harness.executor.query("UPDATE abos.exchange_rates SET rate_value = 1 WHERE id = $1", [first]), /append-only/);
      await assert.rejects(() => harness.executor.query("DELETE FROM abos.exchange_rates WHERE id = $1", [first]), /append-only/);
      // A correction may not change date, source or currencies (checked for any writer).
      await assert.rejects(() => harness.executor.query(
        `INSERT INTO abos.exchange_rates (id, legal_entity_id, rate_date, rate_source, unit_currency_code, quote_currency_code, rate_value,
           supersedes_exchange_rate_id, correction_reason, entered_by_user_account_id)
         VALUES (gen_random_uuid(), $1, $2::date - 1, 'MARKET', 'USD', 'AFN', 70, $3, 'sneaky', $4)`, [world.legalEntityId, today, third, world.intentCreatorId]),
        /changes only the rate value/);
    });

    test("unauthorized, cross-entity and direct-table access is refused", async () => {
      const { world, recorder, cashier } = await prepare();
      const today = isoToday();
      await assert.rejects(() => runtime((db) => ratesView(db, cashier)), /authority is missing/);
      await assert.rejects(() => runtime((db) => recordRate(db, cashier, { date: today, rate: "71" })), /authority is missing/);
      await assert.rejects(() => runtime((db) => recordRate(db, "x".repeat(43), { date: today, rate: "71" })), /session is invalid/);
      const other = await addSecondEntity(harness.executor, world, ["finance.exchange-rate.record"]);
      const foreign = await runtime((db) => recordRate(db, other.token, { date: today, rate: "80" }));
      await assert.rejects(() => runtime((db) => correctRate(db, recorder, foreign, "81", "cross-entity")), /was not found/);
      const mine = await runtime((db) => ratesView(db, recorder));
      assert.equal(mine.rates.length, 0, "another entity's rates are invisible");
      // The runtime login has no table privileges and cannot call internal helpers or the authorizer.
      for (const sql of [
        "SELECT * FROM abos.exchange_rates",
        "SELECT * FROM abos.exchange_rate_snapshots",
        `INSERT INTO abos.exchange_rates (id) VALUES (gen_random_uuid())`,
        "SELECT abos.capture_exchange_rate_snapshot(gen_random_uuid(), 'CAPITAL_RECEIPT_INTENT', gen_random_uuid(), 'AFN', current_date, NULL, gen_random_uuid())",
        "SELECT abos.shareholder_runtime_authorize('x', 'shareholder.read')"
      ]) {
        await assert.rejects(() => runtime((db) => db.query(sql)), (error: unknown) => (error as { code?: string }).code === "42501", sql);
      }
      // The Finance owner cannot rewrite rates (no UPDATE privilege) nor write snapshots.
      await assert.rejects(() => asRole("abos_e1_finance_owner", (client) => client.query("UPDATE abos.exchange_rates SET note = 'x'")), /permission denied/);
      await assert.rejects(() => asRole("abos_e1_finance_owner", (client) => client.query(
        "INSERT INTO abos.exchange_rate_snapshots (id) VALUES (gen_random_uuid())")), /permission denied/);
      // entered_at is the database's own: not even the owner may supply it.
      await assert.rejects(() => asRole("abos_e1_finance_owner", (client) => client.query(
        `INSERT INTO abos.exchange_rates (id, legal_entity_id, rate_date, rate_source, unit_currency_code, quote_currency_code, rate_value, entered_by_user_account_id, entered_at)
         VALUES (gen_random_uuid(), $1, current_date - 3, 'MARKET', 'USD', 'AFN', 70, $2, '2020-01-01')`, [world.legalEntityId, world.intentCreatorId])),
        /permission denied/);
    });

    test("a snapshot copies the current rate exactly, is immutable, and is refused without a rate for the date", async () => {
      const { world, recorder } = await prepare();
      const today = isoToday();
      const afn = await addAfnAgreement(harness.executor, world, { committedAmount: "5000000", installments: ["1782500"] });
      const intentId = randomUUID();
      const registration = await harness.executor.query<{ evidence_reference_id: string }>(
        "SELECT evidence_reference_id FROM abos.registration_evidence WHERE capital_agreement_id = $1", [afn.agreementId]);
      await harness.executor.query(
        `INSERT INTO abos.capital_receipt_intents
           (id, legal_entity_id, shareholder_business_party_id, capital_agreement_id, capital_installment_id, amount, currency_code,
            destination_cash_account_id, evidence_reference_id, correlation_id, idempotency_key, request_fingerprint, business_event_at,
            status, classification, contribution_state, version, created_by_user_account_id)
         VALUES ($1, $2, $3, $4, $5, 1782500, 'AFN', $6, $7, gen_random_uuid(), $8, repeat('a', 64), $9::date, 'ELIGIBLE',
                 'PAID_IN_SHARE_CAPITAL', 'PENDING', 1, $10)`,
        [intentId, world.legalEntityId, world.businessPartyId, afn.agreementId, afn.installmentIds[0], world.afnCashAccountId,
          registration.rows[0]?.evidence_reference_id, `snapshot-${intentId}`, today, world.intentCreatorId]);
      const capture = (rateId: string | null, source = intentId, currency = "AFN") => asRole("abos_e1_shareholder_owner", async (client) =>
        (await client.query<{ id: string }>("SELECT abos.capture_exchange_rate_snapshot($1, 'CAPITAL_RECEIPT_INTENT', $2, $3, $4::date, $5, $6) AS id",
          [world.legalEntityId, source, currency, today, rateId, world.intentCreatorId])).rows[0]?.id ?? "", true);

      await assert.rejects(() => capture(null), (error: unknown) => (error as { code?: string }).code === "P0002" && /no USD\/AFN exchange rate is recorded/.test(String(error)));
      // A rate for another day is never used as a fallback.
      await runtime((db) => recordRate(db, recorder, { date: "2026-09-01", rate: "70" }));
      await assert.rejects(() => capture(null), /no USD\/AFN exchange rate is recorded/);
      await assert.rejects(() => capture(null, intentId, "USD"), /base-currency transaction takes no exchange-rate snapshot/);

      const market = await runtime((db) => recordRate(db, recorder, { date: today, rate: "71.2540" }));
      const saraf = await runtime((db) => recordRate(db, recorder, { date: today, source: "SARAF", rate: "71.3" }));
      await assert.rejects(() => capture(null), (error: unknown) => (error as { code?: string }).code === "P0003" && /choose which rate/.test(String(error)));
      const snapshotId = await capture(market);
      const stored = await harness.executor.query<{ rate_value: string; unit_currency_code: string; quote_currency_code: string; exchange_rate_id: string; base_currency_code: string; transaction_currency_code: string; captured_by_user_account_id: string }>(
        "SELECT rate_value, unit_currency_code, quote_currency_code, exchange_rate_id, base_currency_code, transaction_currency_code, captured_by_user_account_id FROM abos.exchange_rate_snapshots WHERE id = $1", [snapshotId]);
      assert.deepEqual(stored.rows[0], { rate_value: "71.2540", unit_currency_code: "USD", quote_currency_code: "AFN", exchange_rate_id: market,
        base_currency_code: "USD", transaction_currency_code: "AFN", captured_by_user_account_id: world.intentCreatorId });
      // One snapshot per transaction; it can never change.
      await assert.rejects(() => capture(saraf), /duplicate key|unique/);
      await assert.rejects(() => harness.executor.query("UPDATE abos.exchange_rate_snapshots SET rate_value = 1"), /immutable/);
      await assert.rejects(() => harness.executor.query("DELETE FROM abos.exchange_rate_snapshots"), /immutable/);
      // A later correction does not touch the snapshot, and a superseded rate cannot be snapshotted.
      await runtime((db) => correctRate(db, recorder, market, "71.3", "Corrected after the transaction"));
      const after = await harness.executor.query<{ rate_value: string }>("SELECT rate_value FROM abos.exchange_rate_snapshots WHERE id = $1", [snapshotId]);
      assert.equal(after.rows[0]?.rate_value, "71.2540");
      const view = await runtime((db) => ratesView(db, recorder));
      assert.equal(view.rates.find((rate) => rate.id === market)?.snapshotCount, 1);
      // A forged or stale copy is refused whoever inserts it.
      await assert.rejects(() => harness.executor.query(
        `INSERT INTO abos.exchange_rate_snapshots (id, legal_entity_id, source_type, source_id, transaction_currency_code, base_currency_code, exchange_rate_id,
           rate_date, rate_source, unit_currency_code, quote_currency_code, rate_value, rate_entered_at, captured_by_user_account_id)
         SELECT gen_random_uuid(), legal_entity_id, 'CAPITAL_RECEIPT_INTENT', gen_random_uuid(), 'AFN', 'USD', id, rate_date, rate_source,
                unit_currency_code, quote_currency_code, 99, entered_at, entered_by_user_account_id FROM abos.exchange_rates WHERE id = $1`, [saraf]),
        /copy its exchange rate exactly/);
      await assert.rejects(() => harness.executor.query(
        `INSERT INTO abos.exchange_rate_snapshots (id, legal_entity_id, source_type, source_id, transaction_currency_code, base_currency_code, exchange_rate_id,
           rate_date, rate_source, unit_currency_code, quote_currency_code, rate_value, rate_entered_at, captured_by_user_account_id)
         SELECT gen_random_uuid(), legal_entity_id, 'CAPITAL_RECEIPT_INTENT', gen_random_uuid(), 'AFN', 'USD', id, rate_date, rate_source,
                unit_currency_code, quote_currency_code, rate_value, entered_at, entered_by_user_account_id FROM abos.exchange_rates WHERE id = $1`, [market]),
        /superseded exchange rate cannot be snapshotted/);
      await assert.rejects(() => harness.executor.query(
        `INSERT INTO abos.exchange_rate_snapshots (id, legal_entity_id, source_type, source_id, transaction_currency_code, base_currency_code, exchange_rate_id,
           rate_date, rate_source, unit_currency_code, quote_currency_code, rate_value, rate_entered_at, captured_by_user_account_id)
         SELECT gen_random_uuid(), legal_entity_id, 'CAPITAL_RECEIPT_INTENT', gen_random_uuid(), 'AFN', 'USD', id, rate_date, rate_source,
                unit_currency_code, quote_currency_code, rate_value, entered_at, entered_by_user_account_id FROM abos.exchange_rates WHERE id = $1`, [saraf]),
        /source transaction does not exist/);
      // The shareholder owner may lock but not change what it only reads.
      await assert.rejects(() => asRole("abos_e1_shareholder_owner", (client) => client.query("UPDATE abos.sandbox_legal_entity_scopes SET legal_entity_id = legal_entity_id")),
        /may lock but not change sandbox_legal_entity_scopes/);
      await assert.rejects(() => asRole("abos_e1_shareholder_owner", (client) => client.query("UPDATE abos.capital_agreements SET id = id")),
        /may lock but not change|permission denied/);
      await assert.rejects(() => asRole("abos_e1_shareholder_owner", (client) => client.query("UPDATE abos.capital_agreements SET status = 'ELIGIBLE'")),
        /permission denied/);
      await assert.rejects(() => asRole("abos_e1_shareholder_owner", (client) => client.query("INSERT INTO abos.journals (id) VALUES (gen_random_uuid())")),
        /permission denied/);
    });
  });
}
