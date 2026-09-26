import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test, { after, before, describe } from "node:test";
import pg from "pg";
import type {
  CapitalAgreementId, CapitalInstallmentId, CashLocationCurrencyAccountId, CorrelationId,
  IdempotencyKey, LegalEntityId, UserAccountId
} from "@abos/contracts";
import { asDecimalString } from "@abos/contracts";
import {
  PostgresExecutor, PostgresShareholderRepository, RestrictedTreasuryGateway, RestrictedTreasuryRepository,
  RestrictedTreasurySafesRepository
} from "@abos/persistence";
import { SandboxAuthenticator } from "@abos/sandbox-auth";
import { CapitalReceiptIntentService } from "@abos/shareholder";
import { TreasuryDomainError, TreasuryService, TreasurySafesService, type TreasuryActor } from "@abos/treasury";
import { databaseUrl, MISSING_DATABASE_MESSAGE, openHarness, resetSchema, type Harness } from "./harness.ts";
import { recordSyntheticTreasuryReceipt, seedSyntheticWorld, SYNTHETIC_AUTH_CONFIGURATION, type SyntheticWorld } from "./synthetic-world.ts";

/**
 * WP-B (migration 0015): safes created and activated in the app, Saraf accounts, and whole-safe
 * counts, all through the restricted Treasury login. Every name and amount is synthetic.
 */

const MARKER = SYNTHETIC_AUTH_CONFIGURATION.runtimeMarker;
const LOGIN = "abos_e1_treasury_runtime_test_login";
const PASSWORD = "synthetic-treasury-runtime-only-2026";

interface Person {
  readonly id: string;
  readonly token: string;
  readonly actor: TreasuryActor;
  readonly treasury: TreasuryService;
  readonly safes: TreasurySafesService;
  readonly gateway: RestrictedTreasuryGateway;
}

interface Fixture {
  readonly world: SyntheticWorld;
  readonly manager: Person;       // manage safes, manage Saraf accounts
  readonly sarafReviewer: Person; // manage Saraf accounts + approve safe accounts
  readonly counter: Person;       // counts
  readonly reconciler: Person;    // reconciles
  readonly approver: Person;      // approves, confirms counts, activates, blocks
  readonly dual: Person;          // counts, reconciles and approves: used to prove the database SoD rules
  readonly cashier: Person;       // no safe-management permission at all
  readonly sarafPartyId: string;
  readonly sarafUsdLedgerId: string;
  readonly sarafAfnLedgerId: string;
  readonly otherSarafUsdLedgerId: string;
  readonly inactiveSarafLedgerId: string;
  readonly nonSarafPartyId: string;
  evidence(kind: "PHYSICAL_CASH_COUNT" | "OPENING_RECONCILIATION"): Promise<string>;
}

let restrictedPool: pg.Pool | undefined;

if (databaseUrl() === undefined) {
  test("WP-B safes and Saraf accounts", () => assert.fail(MISSING_DATABASE_MESSAGE));
} else {
  describe("WP-B safes, Saraf accounts and whole-safe counts (restricted Treasury login)", () => {
    let harness: Harness;
    let f: Fixture;
    before(async () => {
      harness = await openHarness(MARKER);
      f = await prepare(harness);
    });
    after(async () => {
      await restrictedPool?.end();
      await harness.close();
    });

    test("a safe is created, its USD and AFN accounts opened against chosen CASH accounts, counted, reconciled, approved and activated with segregation of duties", async () => {
      const { manager, counter, reconciler, approver, dual, world } = f;
      const safeId = await manager.treasury.createOfficeSafe(manager.actor, {
        name: "Synthetic Branch Safe (demo)", responsibleCashierUserAccountId: world.cashierId as UserAccountId
      });
      await manager.treasury.activateSafe(manager.actor, safeId);
      const usd = await manager.safes.openCurrencyAccount(manager.actor, { cashLocationId: safeId, currency: "USD", ledgerAccountId: world.cashLedgerAccountId });
      const afn = await manager.safes.openCurrencyAccount(manager.actor, { cashLocationId: safeId, currency: "AFN", ledgerAccountId: world.afnCashLedgerAccountId });
      await refusedDomain(manager.safes.openCurrencyAccount(manager.actor, { cashLocationId: safeId, currency: "USD", ledgerAccountId: world.cashLedgerAccountId }), "IDEMPOTENCY_CONFLICT");
      // Cashier assignment is preserved.
      await manager.treasury.assignCashier(manager.actor, { cashLocationId: safeId, userAccountId: world.cashierId as UserAccountId });

      // Opening count by the counter; the counter cannot confirm (permission) and a person who holds
      // both permissions cannot confirm their own count (service and database).
      const usdEvidence = await f.evidence("PHYSICAL_CASH_COUNT");
      await counter.safes.assertUnusedEvidence(counter.actor, usdEvidence, "PHYSICAL_CASH_COUNT");
      const usdCount = await counter.treasury.recordOpeningCount(counter.actor, { cashAccountId: usd, countedAmount: "1500.25", evidenceReferenceId: usdEvidence });
      await assert.rejects(counter.safes.assertUnusedEvidence(counter.actor, usdEvidence, "PHYSICAL_CASH_COUNT"), /already belongs/);
      await refusedDomain(counter.treasury.confirmOpeningCount(counter.actor, usdCount), "PERMISSION_DENIED");
      const afnCount = await dual.treasury.recordOpeningCount(dual.actor, { cashAccountId: afn, countedAmount: "0", evidenceReferenceId: await f.evidence("PHYSICAL_CASH_COUNT") });
      await refusedDomain(dual.treasury.confirmOpeningCount(dual.actor, afnCount), "SEGREGATION_OF_DUTIES_VIOLATION");
      await refusedDb(dual.gateway.command(authority(dual), "CONFIRM_OPENING_COUNT", { id: afnCount }), /check constraint|confirmed/);

      await approver.treasury.confirmOpeningCount(approver.actor, usdCount);
      await approver.treasury.confirmOpeningCount(approver.actor, afnCount);
      await reconciler.treasury.reconcileOpening(reconciler.actor, { cashAccountId: usd, physicalCashCountId: usdCount, reconciliationEvidenceReferenceId: await f.evidence("OPENING_RECONCILIATION") });
      await dual.treasury.reconcileOpening(dual.actor, { cashAccountId: afn, physicalCashCountId: afnCount, reconciliationEvidenceReferenceId: await f.evidence("OPENING_RECONCILIATION") });

      // The counter (and reconciler) of an opening cannot approve it; the reconciler cannot activate.
      await refusedDomain(dual.treasury.approveOpening(dual.actor, afn), "SEGREGATION_OF_DUTIES_VIOLATION");
      await refusedDb(dual.gateway.command(authority(dual), "APPROVE_OPENING", { id: afn }), /counted the opening cash|check constraint/);
      await refusedDomain(reconciler.treasury.approveOpening(reconciler.actor, usd), "PERMISSION_DENIED");
      await approver.treasury.approveOpening(approver.actor, usd);
      await approver.treasury.approveOpening(approver.actor, afn);
      await refusedDomain(dual.treasury.activateAccount(dual.actor, afn), "SEGREGATION_OF_DUTIES_VIOLATION");
      const afnOpening = await dual.treasury["repository"].findOpening(world.legalEntityId as LegalEntityId, afn);
      await refusedDb(dual.gateway.command(authority(dual), "ACTIVATE_ACCOUNT", { id: afn, evidenceReferenceId: afnOpening?.reconciliationEvidenceReferenceId }), /reconciled the opening position cannot activate/);
      await approver.treasury.activateAccount(approver.actor, usd);
      await approver.treasury.activateAccount(approver.actor, afn);

      const accounts = await approver.treasury["repository"].findAccount(world.legalEntityId as LegalEntityId, usd);
      assert.equal(accounts?.status, "ACTIVE");
      // Blocking needs the approve permission and is recorded.
      await refusedDomain(manager.safes.blockAccount(manager.actor, afn), "PERMISSION_DENIED");
      await approver.safes.blockAccount(approver.actor, afn);
      assert.equal((await approver.treasury["repository"].findAccount(world.legalEntityId as LegalEntityId, afn))?.status, "BLOCKED");
      const events = await harness.executor.query<{ to_status: string }>(
        "SELECT to_status FROM abos.treasury_events WHERE aggregate_type='CASH_ACCOUNT' AND aggregate_id=$1 ORDER BY occurred_at", [afn]);
      assert.deepEqual(events.rows.map((row) => row.to_status), ["DRAFT", "RECONCILED", "APPROVED", "ACTIVE", "BLOCKED"]);
    });

    test("a safe account only links an active CASH ledger account in its own currency", async () => {
      const { manager, world } = f;
      const safeId = await manager.treasury.createOfficeSafe(manager.actor, {
        name: "Synthetic Currency Check Safe (demo)", responsibleCashierUserAccountId: world.cashierId as UserAccountId
      });
      // AFN safe account with a USD ledger account: refused by the service and by the database.
      await refusedDomain(manager.safes.openCurrencyAccount(manager.actor, { cashLocationId: safeId, currency: "AFN", ledgerAccountId: world.cashLedgerAccountId }), "CURRENCY_MISMATCH");
      await refusedDb(manager.gateway.command(authority(manager), "OPEN_ACCOUNT", {
        id: randomUUID(), cashLocationId: safeId, currency: "AFN", ledgerAccountId: world.cashLedgerAccountId
      }), /cannot link a USD ledger account/);
      // A USD ledger account that is not CASH (the synthetic capital account, or a SARAF account).
      await refusedDomain(manager.safes.openCurrencyAccount(manager.actor, { cashLocationId: safeId, currency: "USD", ledgerAccountId: world.capitalLedgerAccountId }), "POLICY_CONFIGURATION_PENDING");
      for (const ledgerAccountId of [world.capitalLedgerAccountId, f.sarafUsdLedgerId]) {
        await refusedDb(manager.gateway.command(authority(manager), "OPEN_ACCOUNT", {
          id: randomUUID(), cashLocationId: safeId, currency: "USD", ledgerAccountId
        }), /must link an ACTIVE posting CASH ledger account/);
      }
      const choices = await manager.safes["safes"].listCashLedgerChoices(world.legalEntityId as LegalEntityId);
      assert.deepEqual(choices.map((choice) => [choice.accountCode, choice.currency]), [["1010-USD", "USD"], ["1011-AFN", "AFN"]]);
    });

    test("a Saraf account links a current Saraf to a SARAF ledger account in one currency, and is activated by someone else", async () => {
      const { manager, sarafReviewer, cashier, world } = f;
      const entity = world.legalEntityId as LegalEntityId;
      const parties = await manager.safes["safes"].listSarafParties(entity);
      assert.deepEqual(parties.map((party) => party.id), [f.sarafPartyId]);

      // SARAF control type, currency and role are enforced.
      await refusedDomain(manager.safes.createSarafAccount(manager.actor, { businessPartyId: f.sarafPartyId, currency: "USD", ledgerAccountId: world.cashLedgerAccountId }), "POLICY_CONFIGURATION_PENDING");
      await refusedDb(manager.gateway.safesCommand(authority(manager), "CREATE_SARAF_ACCOUNT", {
        id: randomUUID(), businessPartyId: f.sarafPartyId, currency: "USD", ledgerAccountId: world.cashLedgerAccountId
      }), /SARAF control ledger account/);
      await refusedDomain(manager.safes.createSarafAccount(manager.actor, { businessPartyId: f.sarafPartyId, currency: "AFN", ledgerAccountId: f.sarafUsdLedgerId }), "CURRENCY_MISMATCH");
      await refusedDb(manager.gateway.safesCommand(authority(manager), "CREATE_SARAF_ACCOUNT", {
        id: randomUUID(), businessPartyId: f.sarafPartyId, currency: "AFN", ledgerAccountId: f.sarafUsdLedgerId
      }), /foreign key|SARAF control ledger account/);
      await refusedDb(manager.gateway.safesCommand(authority(manager), "CREATE_SARAF_ACCOUNT", {
        id: randomUUID(), businessPartyId: f.sarafPartyId, currency: "USD", ledgerAccountId: f.inactiveSarafLedgerId
      }), /must be ACTIVE/);
      await refusedDomain(manager.safes.createSarafAccount(manager.actor, { businessPartyId: f.nonSarafPartyId, currency: "USD", ledgerAccountId: f.sarafUsdLedgerId }), "NOT_FOUND");
      await refusedDb(manager.gateway.safesCommand(authority(manager), "CREATE_SARAF_ACCOUNT", {
        id: randomUUID(), businessPartyId: f.nonSarafPartyId, currency: "USD", ledgerAccountId: f.sarafUsdLedgerId
      }), /current SARAF role/);
      // Without treasury.saraf-account.manage nothing happens.
      await refusedDomain(cashier.safes.createSarafAccount(cashier.actor, { businessPartyId: f.sarafPartyId, currency: "USD", ledgerAccountId: f.sarafUsdLedgerId }), "PERMISSION_DENIED");
      await refusedDb(cashier.gateway.safesCommand(authority(cashier), "CREATE_SARAF_ACCOUNT", {
        id: randomUUID(), businessPartyId: f.sarafPartyId, currency: "USD", ledgerAccountId: f.sarafUsdLedgerId
      }), /current Treasury authority is missing/);

      const usd = await manager.safes.createSarafAccount(manager.actor, { businessPartyId: f.sarafPartyId, currency: "USD", ledgerAccountId: f.sarafUsdLedgerId });
      const afn = await manager.safes.createSarafAccount(manager.actor, { businessPartyId: f.sarafPartyId, currency: "AFN", ledgerAccountId: f.sarafAfnLedgerId });
      await refusedDomain(manager.safes.createSarafAccount(manager.actor, { businessPartyId: f.sarafPartyId, currency: "USD", ledgerAccountId: f.otherSarafUsdLedgerId }), "IDEMPOTENCY_CONFLICT");
      await refusedDb(manager.gateway.safesCommand(authority(manager), "CREATE_SARAF_ACCOUNT", {
        id: randomUUID(), businessPartyId: f.sarafPartyId, currency: "USD", ledgerAccountId: f.otherSarafUsdLedgerId
      }), /duplicate key|saraf_accounts_one_live/);

      // The creator cannot activate, not even by calling the database directly.
      await refusedDomain(manager.safes.activateSarafAccount(manager.actor, usd), "SEGREGATION_OF_DUTIES_VIOLATION");
      await refusedDb(manager.gateway.safesCommand(authority(manager), "ACTIVATE_SARAF_ACCOUNT", { id: usd }), /created a Saraf account cannot activate it/);
      await sarafReviewer.safes.activateSarafAccount(sarafReviewer.actor, usd);
      await sarafReviewer.safes.activateSarafAccount(sarafReviewer.actor, afn);
      await manager.safes.deactivateSarafAccount(manager.actor, afn);
      await refusedDomain(manager.safes.deactivateSarafAccount(manager.actor, afn), "IDEMPOTENCY_CONFLICT");
      await sarafReviewer.safes.activateSarafAccount(sarafReviewer.actor, afn);

      const listed = await manager.safes["safes"].listSarafAccounts(entity);
      assert.deepEqual(listed.map((item) => [item.currency, item.status, item.ledgerAccountCode, item.activatedByUserAccountId]),
        [["AFN", "ACTIVE", "2310-AFN", sarafReviewer.id], ["USD", "ACTIVE", "2300-USD", sarafReviewer.id]]);
      const audit = await harness.executor.query<{ to_status: string; actor_user_account_id: string }>(
        "SELECT to_status, actor_user_account_id FROM abos.treasury_events WHERE aggregate_type='SARAF_ACCOUNT' AND aggregate_id=$1 ORDER BY occurred_at", [afn]);
      assert.deepEqual(audit.rows.map((row) => [row.to_status, row.actor_user_account_id]),
        [["DRAFT", manager.id], ["ACTIVE", sarafReviewer.id], ["INACTIVE", manager.id], ["ACTIVE", sarafReviewer.id]]);
      // Nothing about a Saraf account touches the ledger.
      const journals = await harness.executor.query<{ n: string }>("SELECT count(*)::text AS n FROM abos.journals");
      assert.equal(journals.rows[0]?.n, "0");
    });

    test("a whole-safe count is recorded with the database's custody total and difference, and confirmed by someone else", async () => {
      const { counter, approver, dual, world } = f;
      const entity = world.legalEntityId as LegalEntityId;
      const account = world.cashAccountId as CashLocationCurrencyAccountId;

      // A verified 25,000.00 receipt into the synthetic safe's USD account (opening 0.00).
      const intentId = await createIntent(harness, world);
      await recordSyntheticTreasuryReceipt(harness.executor, world, { capitalReceiptIntentId: intentId, amount: world.installmentAmount });

      // A DRAFT account (no approved opening) cannot be whole-safe counted.
      await refusedDomain(counter.safes.recordSafeCount(counter.actor, { cashAccountId: world.afnCashAccountId as CashLocationCurrencyAccountId, countedAmount: "10", evidenceReferenceId: await f.evidence("PHYSICAL_CASH_COUNT") }), "OPENING_POSITION_NOT_APPROVED");
      await refusedDb(counter.gateway.safesCommand(authority(counter), "RECORD_SAFE_COUNT", {
        id: randomUUID(), cashAccountId: world.afnCashAccountId, currency: "AFN", countedAmount: "10", evidenceReferenceId: await f.evidence("PHYSICAL_CASH_COUNT")
      }), /opening position is approved/);
      // Evidence of the wrong kind is refused.
      await refusedDb(counter.gateway.safesCommand(authority(counter), "RECORD_SAFE_COUNT", {
        id: randomUUID(), cashAccountId: account, currency: "USD", countedAmount: "10", evidenceReferenceId: await f.evidence("OPENING_RECONCILIATION")
      }), /requires PHYSICAL_CASH_COUNT evidence/);
      // The currency must be the account's; a caller cannot shape the snapshot.
      await refusedDb(counter.gateway.safesCommand(authority(counter), "RECORD_SAFE_COUNT", {
        id: randomUUID(), cashAccountId: account, currency: "AFN", countedAmount: "10", evidenceReferenceId: await f.evidence("PHYSICAL_CASH_COUNT")
      }), /count currency must be the account currency/);

      const evidenceId = await f.evidence("PHYSICAL_CASH_COUNT");
      const exact = await counter.safes.recordSafeCount(counter.actor, { cashAccountId: account, countedAmount: "25000.00", evidenceReferenceId: evidenceId, note: "Synthetic end-of-day count" });
      const short = await counter.safes.recordSafeCount(counter.actor, { cashAccountId: account, countedAmount: "24990.5", evidenceReferenceId: await f.evidence("PHYSICAL_CASH_COUNT") });
      const counts = await counter.safes["safes"].listSafeCounts(entity);
      const byId = new Map(counts.map((count) => [count.id, count]));
      assert.deepEqual(pick(byId.get(exact)), { opening: "0.00", verified: "25000.00", receipts: 1, custody: "25000.00", difference: "0.00", status: "RECORDED" });
      assert.deepEqual(pick(byId.get(short)), { opening: "0.00", verified: "25000.00", receipts: 1, custody: "25000.00", difference: "-9.50", status: "RECORDED" });

      // The same count sheet cannot evidence a second count of any kind.
      await refusedDb(counter.gateway.safesCommand(authority(counter), "RECORD_SAFE_COUNT", {
        id: randomUUID(), cashAccountId: account, currency: "USD", countedAmount: "1", evidenceReferenceId: evidenceId
      }), /already belongs/);
      await refusedDb(counter.gateway.command(authority(counter), "RECORD_COUNT", {
        id: randomUUID(), cashAccountId: world.afnCashAccountId, currency: "AFN", countedAmount: "1", evidenceReferenceId: evidenceId, purpose: "OPENING"
      }), /already belongs to a whole-safe count/);

      // Self-confirmation is refused by the service and by the database; another person confirms.
      const own = await dual.safes.recordSafeCount(dual.actor, { cashAccountId: account, countedAmount: "25000", evidenceReferenceId: await f.evidence("PHYSICAL_CASH_COUNT") });
      await refusedDomain(dual.safes.confirmSafeCount(dual.actor, own), "SEGREGATION_OF_DUTIES_VIOLATION");
      await refusedDb(dual.gateway.safesCommand(authority(dual), "CONFIRM_SAFE_COUNT", { id: own }), /counted the safe cannot confirm/);
      await refusedDomain(counter.safes.confirmSafeCount(counter.actor, exact), "PERMISSION_DENIED");
      await approver.safes.confirmSafeCount(approver.actor, exact);
      await refusedDomain(approver.safes.confirmSafeCount(approver.actor, exact), "POSTED_RECORD_IMMUTABLE");
      await refusedDb(approver.gateway.safesCommand(authority(approver), "CONFIRM_SAFE_COUNT", { id: exact }), /recorded whole-safe count not found/);
      const confirmed = await counter.safes["safes"].findSafeCount(entity, exact);
      assert.equal(confirmed?.confirmedByUserAccountId, approver.id);

      // Recorded, confirmed and audited; nothing posted.
      const audit = await harness.executor.query<{ to_status: string }>(
        "SELECT to_status FROM abos.treasury_events WHERE aggregate_type='SAFE_COUNT' AND aggregate_id=$1 ORDER BY occurred_at", [exact]);
      assert.deepEqual(audit.rows.map((row) => row.to_status), ["RECORDED", "CONFIRMED"]);
      const journals = await harness.executor.query<{ n: string }>("SELECT count(*)::text AS n FROM abos.journals");
      assert.equal(journals.rows[0]?.n, "0");
      // Even the owner connection cannot rewrite or delete a count.
      await assert.rejects(harness.executor.query("DELETE FROM abos.cash_safe_counts WHERE id=$1", [short]), /permanent records/);
    });

    test("another legal entity, a forged token and direct table access are refused", async () => {
      const { manager, counter } = f;
      const other = { bearerToken: manager.token, legalEntityId: randomUUID() as LegalEntityId };
      await refusedDb(manager.gateway.safesQuery(other, "SARAF_ACCOUNTS"), /out of scope/);
      await refusedDb(manager.gateway.safesCommand(other, "CREATE_SARAF_ACCOUNT", {
        id: randomUUID(), businessPartyId: f.sarafPartyId, currency: "USD", ledgerAccountId: f.sarafUsdLedgerId
      }), /out of scope/);
      await refusedDb(counter.gateway.safesQuery({ bearerToken: "f".repeat(43), legalEntityId: f.world.legalEntityId as LegalEntityId }, "SAFE_COUNTS"), /invalid, expired/);
      await refusedDb(manager.gateway.safesCommand(authority(manager), "NOT_AN_OPERATION" as never, { id: randomUUID() }), /unsupported Treasury safes operation/);

      const pool = restricted();
      for (const sql of [
        "SELECT * FROM abos.saraf_accounts", "SELECT * FROM abos.cash_safe_counts",
        `INSERT INTO abos.saraf_accounts (id) VALUES ('${randomUUID()}')`,
        "UPDATE abos.cash_safe_counts SET status = 'CONFIRMED'",
        "SELECT abos.guard_saraf_account()"
      ]) {
        await assert.rejects(pool.query(sql), /permission denied/, sql);
      }
      const privileges = await harness.executor.query<{ grantee: string }>(
        `SELECT grantee FROM information_schema.role_table_grants
          WHERE table_schema='abos' AND table_name IN ('saraf_accounts','cash_safe_counts')
            AND grantee IN ('abos_e1_treasury_runtime','abos_e1_runtime','abos_v1_identity_runtime','PUBLIC')`);
      assert.deepEqual(privileges.rows, []);
      const catalogue = await harness.executor.query<{ category: string; catalogue_version: number; independence_enforced: boolean; sort_order: number }>(
        "SELECT category, catalogue_version, independence_enforced, sort_order FROM abos.permission_catalogue WHERE permission_code='treasury.saraf-account.manage'");
      assert.deepEqual(catalogue.rows[0], { category: "TREASURY", catalogue_version: 3, independence_enforced: true, sort_order: 220 });
    });
  });
}

function pick(count: { openingAmount: string; verifiedReceiptsAmount: string; verifiedReceiptCount: number; custodyTotal: string; difference: string; status: string } | undefined) {
  assert.ok(count);
  return { opening: count.openingAmount, verified: count.verifiedReceiptsAmount, receipts: count.verifiedReceiptCount,
    custody: count.custodyTotal, difference: count.difference, status: count.status };
}

function authority(person: Person) {
  return { bearerToken: person.token, legalEntityId: person.actor.legalEntityId };
}

async function refusedDomain(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof TreasuryDomainError, `expected a domain refusal, got ${String(error)}`);
    assert.equal(error.code, code, error.message);
    return true;
  });
}

async function refusedDb(promise: Promise<unknown>, message: RegExp): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof Error && !(error instanceof TreasuryDomainError), `expected a database refusal, got ${String(error)}`);
    assert.match(error.message, message);
    return true;
  });
}

function restricted(): pg.Pool {
  if (restrictedPool === undefined) {
    const configured = databaseUrl(); assert.ok(configured);
    const url = new URL(configured); url.username = LOGIN; url.password = PASSWORD;
    restrictedPool = new pg.Pool({ connectionString: url.toString(), max: 4 });
  }
  return restrictedPool;
}

async function prepare(harness: Harness): Promise<Fixture> {
  await resetSchema(harness.pool);
  const world = await seedSyntheticWorld(harness.executor);
  const q = (sql: string, parameters: readonly unknown[] = []) => harness.executor.query(sql, parameters);
  const grant = async (userId: string, permissions: readonly string[]) => {
    for (const permission of permissions) {
      await q(`INSERT INTO abos.user_permission_grants (user_account_id, legal_entity_id, permission_code, granted_by_user_account_id)
               VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`, [userId, world.legalEntityId, permission, world.bootstrapUserId]);
    }
  };
  const newUser = async (name: string) => {
    const id = randomUUID();
    await q("INSERT INTO abos.user_accounts (id, login_identifier, display_name, status) VALUES ($1, $2, $3, 'ACTIVE')",
      [id, `${name.toLowerCase().replace(/\s+/g, ".")}.${id.slice(0, 8)}@synthetic.invalid`, name]);
    return id;
  };
  await grant(world.treasuryManagerId, ["treasury.saraf-account.manage"]);
  await grant(world.treasuryApproverId, ["treasury.saraf-account.manage"]);
  const dualId = await newUser("Synthetic Dual Role Tester");
  await grant(dualId, ["treasury.read", "treasury.cash-count.record", "treasury.cash-account.reconcile", "treasury.cash-account.approve"]);

  // Synthetic Chart of Accounts entries (test-only owner connection; the app never creates them).
  const ledger = async (code: string, currency: string, status = "ACTIVE") => {
    const id = randomUUID();
    await q(`INSERT INTO abos.ledger_accounts (id, legal_entity_id, account_code, account_name, account_type, control_account_type,
               posting_allowed, account_currency_code, status)
             VALUES ($1, $2, $3, $4, 'ASSET', 'SARAF', true, $5, $6)`,
      [id, world.legalEntityId, code, `Synthetic Saraf control ${code} (demo)`, currency, status]);
    return id;
  };
  const sarafUsdLedgerId = await ledger("2300-USD", "USD");
  const sarafAfnLedgerId = await ledger("2310-AFN", "AFN");
  const otherSarafUsdLedgerId = await ledger("2301-USD", "USD");
  const inactiveSarafLedgerId = await ledger("2302-USD", "USD", "DRAFT");

  const sarafPartyId = randomUUID();
  await q("INSERT INTO abos.business_parties (id, legal_entity_id, display_name, status) VALUES ($1, $2, 'Synthetic Saraf House (demo)', 'ACTIVE')",
    [sarafPartyId, world.legalEntityId]);
  await q("INSERT INTO abos.business_party_roles (business_party_id, role_code, effective_from) VALUES ($1, 'SARAF', current_date - 1)", [sarafPartyId]);
  // A former Saraf: role ended yesterday.
  const nonSarafPartyId = randomUUID();
  await q("INSERT INTO abos.business_parties (id, legal_entity_id, display_name, status) VALUES ($1, $2, 'Synthetic Former Saraf (demo)', 'ACTIVE')",
    [nonSarafPartyId, world.legalEntityId]);
  await q("INSERT INTO abos.business_party_roles (business_party_id, role_code, effective_from, effective_to) VALUES ($1, 'SARAF', current_date - 30, current_date - 1)", [nonSarafPartyId]);

  await ensureLogin(harness);
  const executor = new PostgresExecutor(restricted(), { runtimeMarker: MARKER });
  const gateway = new RestrictedTreasuryGateway(executor);
  const auth = new SandboxAuthenticator(harness.executor, SYNTHETIC_AUTH_CONFIGURATION);
  const person = async (id: string): Promise<Person> => {
    const session = await auth.issueSession({ userAccountId: id as UserAccountId, legalEntityId: world.legalEntityId as LegalEntityId });
    const context = await gateway.context(session.token);
    const actor: TreasuryActor = {
      userAccountId: id as UserAccountId, legalEntityId: world.legalEntityId as LegalEntityId,
      treasuryPermissions: context.treasuryPermissions as TreasuryActor["treasuryPermissions"], sessionId: session.sessionId
    };
    const authority = { bearerToken: session.token, legalEntityId: world.legalEntityId as LegalEntityId };
    const repository = new RestrictedTreasuryRepository(gateway, authority);
    return { id, token: session.token, actor, gateway, treasury: new TreasuryService(repository),
      safes: new TreasurySafesService(new RestrictedTreasurySafesRepository(gateway, authority), repository) };
  };
  return {
    world,
    manager: await person(world.treasuryManagerId),
    sarafReviewer: await person(world.treasuryApproverId),
    counter: await person(world.counterId),
    reconciler: await person(world.treasuryReconcilerId),
    approver: await person(world.treasuryApproverId),
    dual: await person(dualId),
    cashier: await person(world.cashierId),
    sarafPartyId, sarafUsdLedgerId, sarafAfnLedgerId, otherSarafUsdLedgerId, inactiveSarafLedgerId, nonSarafPartyId,
    evidence: async (kind) => {
      const id = randomUUID();
      await q(`INSERT INTO abos.evidence_references (id, legal_entity_id, document_id, evidence_kind, evidence_version, sha256, completed_at)
               VALUES ($1, $2, $3, $4, 1, $5, clock_timestamp())`,
        [id, world.legalEntityId, randomUUID(), kind, createHash("sha256").update(id).digest("hex")]);
      return id;
    }
  };
}

async function createIntent(harness: Harness, world: SyntheticWorld): Promise<string> {
  const evidence = (await harness.executor.query<{ id: string; document_id: string; sha256: string; completed_at: Date }>(
    "SELECT id, document_id, sha256, completed_at FROM abos.evidence_references WHERE id=$1", [world.agreementDocumentEvidenceId])).rows[0];
  assert.ok(evidence);
  const service = new CapitalReceiptIntentService(new PostgresShareholderRepository(harness.executor, world.intentCreatorId as UserAccountId));
  const intent = await service.createCapitalReceiptIntent({
    legalEntityId: world.legalEntityId as LegalEntityId, shareholderPartyId: world.businessPartyId as never,
    agreementId: world.agreementId as CapitalAgreementId, installmentId: world.installmentId as CapitalInstallmentId,
    amount: { amount: asDecimalString(world.installmentAmount), currency: "USD" },
    expectedDestinationAccountId: world.cashAccountId as CashLocationCurrencyAccountId,
    businessEventAt: "2026-09-22T07:00:00.000Z",
    source: { legalEntityId: world.legalEntityId as LegalEntityId, idempotencyKey: `wp-b-${randomUUID()}` as IdempotencyKey, correlationId: randomUUID() as CorrelationId },
    evidence: [{ id: evidence.id as never, documentId: evidence.document_id as never, kind: "CAPITAL_AGREEMENT", version: 1, sha256: evidence.sha256, completedAt: evidence.completed_at.toISOString() }]
  });
  return intent.id;
}

async function ensureLogin(harness: Harness): Promise<void> {
  const exists = await harness.executor.query<{ exists: boolean }>("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=$1) AS exists", [LOGIN]);
  if (exists.rows[0]?.exists === true) {
    await harness.executor.query(`ALTER ROLE ${LOGIN} LOGIN INHERIT PASSWORD '${PASSWORD}'`);
  } else {
    await harness.executor.query(`CREATE ROLE ${LOGIN} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${PASSWORD}'`);
  }
  await harness.executor.query(`GRANT abos_e1_treasury_runtime TO ${LOGIN}`);
}

