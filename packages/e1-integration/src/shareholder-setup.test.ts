import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test, { after, before, describe } from "node:test";
import pg from "pg";

import type {
  CapitalAgreementId, CapitalInstallmentId, CashLocationCurrencyAccountId, CorrelationId, EvidenceReference,
  IdempotencyKey, LegalEntityId, PostingIntentId, UserAccountId
} from "@abos/contracts";
import { asDecimalString } from "@abos/contracts";
import { PostgresExecutor, PostgresShareholderRepository, RestrictedCapitalPostingGateway } from "@abos/persistence";
import { identityDatabaseProof } from "@abos/sandbox-auth";
import { CapitalReceiptIntentService } from "@abos/shareholder";

import { addSecondEntity, createRequest, grant, isoToday, shareholderWorkspace } from "./currency-fixtures.ts";
import { databaseUrl, MISSING_DATABASE_MESSAGE, openHarness, resetSchema, type Harness } from "./harness.ts";
import { issueOperationalSession } from "./operational-session.ts";
import {
  handOffSyntheticReceipt, recordCapitalPostingIntent, recordSyntheticTreasuryReceipt, seedSyntheticWorld,
  SYNTHETIC_AUTH_CONFIGURATION, type SyntheticWorld
} from "./synthetic-world.ts";

/**
 * Migration 0031: shareholder master data and DRAFT capital agreement setup, through the restricted
 * Finance login exactly as the web server calls it. Every person, party and amount is synthetic.
 * Nothing here receives money: the suite also proves that no Treasury, posting, journal or
 * subledger row appears.
 */

const MARKER = SYNTHETIC_AUTH_CONFIGURATION.runtimeMarker;
const LOGIN = { name: "abos_v1_shareholder_setup_test_login", password: "synthetic-shareholder-setup-runtime-only-2026" };
const OWNER = "abos_v1_shareholder_setup_owner";
const MANAGE = "shareholder.setup.manage";
const SETUP_FUNCTIONS = [
  "shareholder_setup_create_shareholder(text,text,text,jsonb)", "shareholder_setup_correct_shareholder(text,text,text,jsonb)",
  "shareholder_setup_create_agreement(text,text,text,jsonb)", "shareholder_setup_update_agreement(text,text,text,jsonb)",
  "shareholder_setup_add_installment(text,text,text,jsonb)", "shareholder_setup_update_installment(text,text,text,jsonb)",
  "shareholder_setup_cancel_installment(text,text,text,jsonb)", "shareholder_setup_record_agreement_evidence(text,text,text,jsonb)",
  "shareholder_setup_workspace(text,text,text)"
] as const;

interface SessionArgs { readonly proof: string; readonly runtimeDigest: string; readonly tokenDigest: string }
type Json = Record<string, unknown>;
interface AgreementView {
  id: string; shareholderProfileId: string; reference: string; status: string; currency: string; committed: string; planned: string;
  requested: string; received: string; remaining: string; editable: boolean; registration: string; requestBlockers: string[];
  installments: { id: string; sequence: number; amount: string; currency: string; status: string; editable: boolean }[];
  documents: { version: number; reference: string; documentDate: string; sha256: string }[];
}
interface ShareholderView { id: string; businessPartyId: string; name: string; reference: string | null; status: string; since: string; correctable: boolean }
interface Workspace {
  permissions: { canManage: boolean }; receiptPathOperational: boolean; shareholders: ShareholderView[]; agreements: AgreementView[];
  agreementDocumentRequirement: "OPTIONAL" | "REQUIRED";
  totalsByCurrency: { currency: string; committed: string; received: string; remaining: string }[];
}

if (databaseUrl() === undefined) {
  test("V1 shareholder setup", () => assert.fail(MISSING_DATABASE_MESSAGE));
} else {
  describe("V1 shareholder setup (migration 0031)", () => {
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
      const sql = payload === undefined
        ? `SELECT abos.${fn}($1,$2,$3) AS value`
        : `SELECT abos.${fn}($1,$2,$3,$4::jsonb) AS value`;
      const parameters = payload === undefined
        ? [session.proof, session.runtimeDigest, session.tokenDigest]
        : [session.proof, session.runtimeDigest, session.tokenDigest, JSON.stringify(payload)];
      const result = await restricted.executor.query<{ value: T }>(sql, parameters);
      assert.ok(result.rows[0]);
      return result.rows[0].value;
    };
    const workspace = (session: SessionArgs) => call<Workspace>("shareholder_setup_workspace", session);
    const createShareholder = (session: SessionArgs, input: Json = {}) => call<{ shareholderProfileId: string; businessPartyId: string; replayed: boolean }>(
      "shareholder_setup_create_shareholder", session,
      { displayName: "Synthetic Shareholder Two", shareholderSince: "2026-01-15", idempotencyKey: randomUUID(), correlationId: randomUUID(), ...input });
    const createAgreement = (session: SessionArgs, profileId: string, input: Json = {}) => call<{ capitalAgreementId: string; replayed: boolean }>(
      "shareholder_setup_create_agreement", session,
      { shareholderProfileId: profileId, agreementReference: `SYN-AGR-${randomUUID().slice(0, 8)}`, committedAmount: "100000",
        currencyCode: "USD", effectiveOn: "2026-09-01", idempotencyKey: randomUUID(), correlationId: randomUUID(), ...input });
    const addInstallment = (session: SessionArgs, agreementId: string, amount: string, input: Json = {}) => call<{ capitalInstallmentId: string; sequenceNumber: number }>(
      "shareholder_setup_add_installment", session,
      { capitalAgreementId: agreementId, expectedAmount: amount, dueOn: "2026-12-01", idempotencyKey: randomUUID(), correlationId: randomUUID(), ...input });
    const recordDocument = (session: SessionArgs, agreementId: string, input: Json = {}) => call<{ agreementEvidenceId: string; evidenceReferenceId: string; version: number }>(
      "shareholder_setup_record_agreement_evidence", session,
      { capitalAgreementId: agreementId, documentReference: "Synthetic signed agreement v1", documentDate: "2026-08-30",
        sha256: "a".repeat(64), idempotencyKey: randomUUID(), correlationId: randomUUID(), ...input });

    async function manager(world: SyntheticWorld, userId = world.treasuryManagerId): Promise<SessionArgs> {
      await grant(harness.executor, world, userId, [MANAGE]);
      return sessionFor(harness, world, userId);
    }

    test("the permission is catalogued under Shareholder and held by nobody until a role grants it", async () => {
      await resetSchema(harness.pool);
      await seedSyntheticWorld(harness.executor);
      const row = (await harness.executor.query(
        `SELECT category, availability, administrative, independence_enforced FROM abos.permission_catalogue WHERE permission_code = $1`, [MANAGE])).rows[0];
      assert.deepEqual(row, { category: "SHAREHOLDER", availability: "ACTIVE", administrative: false, independence_enforced: false });
      const holders = await harness.executor.query<{ n: string }>(
        `SELECT (SELECT count(*) FROM abos.user_permission_grants WHERE permission_code = $1)
              + (SELECT count(*) FROM abos.access_role_permissions WHERE permission_code = $1) AS n`, [MANAGE]);
      assert.equal(Number(holders.rows[0]?.n), 0);
    });

    test("a shareholder is created ACTIVE with a SHAREHOLDER role from the supplied date; replay is idempotent; conflicts are refused", async () => {
      await resetSchema(harness.pool);
      const world = await seedSyntheticWorld(harness.executor);
      const session = await manager(world);
      const key = randomUUID(); const correlationId = randomUUID();
      const input = { displayName: "  Synthetic Shareholder Two  ", externalReference: " SH-TWO ", shareholderSince: "2026-01-15", idempotencyKey: key, correlationId };
      const created = await createShareholder(session, input);
      assert.equal(created.replayed, false);
      const replay = await createShareholder(session, input);
      assert.deepEqual(replay, { ...created, replayed: true }, "an identical replay returns the recorded result");
      await assert.rejects(() => createShareholder(session, { ...input, displayName: "Different name" }), /already used for different details/);
      const party = (await harness.executor.query(
        "SELECT display_name, external_reference, status FROM abos.business_parties WHERE id = $1", [created.businessPartyId])).rows[0];
      assert.deepEqual(party, { display_name: "Synthetic Shareholder Two", external_reference: "SH-TWO", status: "ACTIVE" }, "trimmed, ACTIVE");
      const role = (await harness.executor.query<{ role_code: string; effective_from: Date; effective_to: Date | null }>(
        "SELECT role_code, effective_from, effective_to FROM abos.business_party_roles WHERE business_party_id = $1", [created.businessPartyId])).rows;
      assert.equal(role.length, 1);
      assert.equal(role[0]?.role_code, "SHAREHOLDER");
      assert.equal(isoDate(role[0]?.effective_from), "2026-01-15");
      assert.equal(role[0]?.effective_to, null);
      const profile = (await harness.executor.query("SELECT status, legal_entity_id FROM abos.shareholder_profiles WHERE id = $1", [created.shareholderProfileId])).rows[0];
      assert.deepEqual(profile, { status: "ACTIVE", legal_entity_id: world.legalEntityId }, "the legal entity comes from the session");
      const audit = await harness.executor.query("SELECT actor_user_account_id FROM abos.audit_records WHERE action = 'SHAREHOLDER_CREATED' AND entity_id = $1", [created.shareholderProfileId]);
      assert.deepEqual(audit.rows, [{ actor_user_account_id: world.treasuryManagerId }]);
      await assert.rejects(() => createShareholder(session, { shareholderSince: "2999-01-01" }), /cannot be in the future/);
      await assert.rejects(() => createShareholder(session, { legalEntityId: randomUUID() }), /unknown or missing shareholder fields/, "the entity is never taken from the request");
      const view = await workspace(session);
      const listed = view.shareholders.find((shareholder) => shareholder.id === created.shareholderProfileId);
      assert.equal(listed?.since, "2026-01-15");
      assert.equal(listed?.correctable, true);
    });

    test("missing permission, a forged session or a signed-out session fails before anything is written", async () => {
      await resetSchema(harness.pool);
      const world = await seedSyntheticWorld(harness.executor);
      const plain = await sessionFor(harness, world, world.cashierId);
      const before = await footprint(harness);
      await assert.rejects(() => createShareholder(plain), /missing shareholder\.setup\.manage/);
      await assert.rejects(() => createAgreement(plain, world.shareholderProfileId), /missing shareholder\.setup\.manage/);
      await assert.rejects(() => workspace(plain), /missing shareholder\.setup\.manage or shareholder\.read/);
      await assert.rejects(() => createShareholder({ ...plain, proof: "f".repeat(64) }), /identity runtime proof is invalid/);
      await assert.rejects(() => createShareholder(sessionArgs(`forged-${randomUUID()}`)), /sign in with an active account/);
      assert.deepEqual(await footprint(harness), before, "no party, profile, agreement, idempotency or audit row");
      // Read-only holders of shareholder.read see the workspace but cannot change anything.
      await grant(harness.executor, world, world.cashierId, ["shareholder.read"]);
      const reader = await sessionFor(harness, world, world.cashierId);
      assert.equal((await workspace(reader)).permissions.canManage, false);
      await assert.rejects(() => createShareholder(reader), /missing shareholder\.setup\.manage/);
    });

    test("party references are one company namespace: trimmed, blank as none, unique case-insensitively across every party", async () => {
      await resetSchema(harness.pool);
      const world = await seedSyntheticWorld(harness.executor);
      const session = await manager(world);
      const first = await createShareholder(session, { externalReference: "SH-001" });
      await assert.rejects(() => createShareholder(session, { externalReference: "  sh-001 " }), /already used by another business party/);
      // The seeded shareholder's reference cannot be reused by a new (duplicate) identity either.
      const seeded = (await harness.executor.query<{ external_reference: string }>(
        "SELECT external_reference FROM abos.business_parties WHERE id = $1", [world.businessPartyId])).rows[0]?.external_reference ?? "";
      await assert.rejects(() => createShareholder(session, { externalReference: seeded.toLowerCase() }), /already used by another business party/);
      const blankOne = await createShareholder(session, { externalReference: "   " });
      const blankTwo = await createShareholder(session, { externalReference: "" });
      const blanks = await harness.executor.query("SELECT external_reference FROM abos.business_parties WHERE id = ANY($1::uuid[])",
        [[blankOne.businessPartyId, blankTwo.businessPartyId]]);
      assert.deepEqual(blanks.rows, [{ external_reference: null }, { external_reference: null }], "blank input is stored as no reference");
      // The database enforces it for every writer and every party role, not only this function.
      await assert.rejects(() => harness.executor.query(
        "INSERT INTO abos.business_parties (id, legal_entity_id, display_name, external_reference, status) VALUES ($1,$2,'Synthetic Saraf','Sh-001 ','ACTIVE')",
        [randomUUID(), world.legalEntityId]), /business_parties_reference_normalized/);
      // Another legal entity has its own namespace.
      const second = await addSecondEntity(harness.executor, world, [MANAGE]);
      await createShareholder(sessionArgs(second.token), { externalReference: "SH-001" });
      // Correction to another party's reference is refused; to its own (different case) is accepted.
      await assert.rejects(() => call("shareholder_setup_correct_shareholder", session,
        { shareholderProfileId: first.shareholderProfileId, displayName: "Synthetic Shareholder Two", externalReference: seeded }), /already used by another business party/);
      await call("shareholder_setup_correct_shareholder", session,
        { shareholderProfileId: first.shareholderProfileId, displayName: "Synthetic Shareholder Two (corrected)", externalReference: "sh-001" });
      const corrected = (await harness.executor.query("SELECT display_name, external_reference FROM abos.business_parties WHERE id = $1", [first.businessPartyId])).rows[0];
      assert.deepEqual(corrected, { display_name: "Synthetic Shareholder Two (corrected)", external_reference: "sh-001" });
      const audit = await harness.executor.query<{ before_state: Json; after_state: Json }>(
        "SELECT before_state, after_state FROM abos.audit_records WHERE action = 'SHAREHOLDER_CORRECTED' AND entity_id = $1", [first.shareholderProfileId]);
      assert.equal(audit.rows[0]?.before_state.reference, "SH-001");
      assert.equal(audit.rows[0]?.after_state.reference, "sh-001");
    });

    test("agreements are DRAFT, belong to the named shareholder of the same entity, and cannot cross legal entities", async () => {
      await resetSchema(harness.pool);
      const world = await seedSyntheticWorld(harness.executor);
      const session = await manager(world);
      const holder = await createShareholder(session);
      const key = randomUUID();
      const agreement = await createAgreement(session, holder.shareholderProfileId, { idempotencyKey: key, agreementReference: "SYN-AGR-001" });
      // A retry with a new correlation id is still the same request.
      const replay = await createAgreement(session, holder.shareholderProfileId, { idempotencyKey: key, agreementReference: "SYN-AGR-001" });
      assert.equal(replay.capitalAgreementId, agreement.capitalAgreementId);
      assert.equal(replay.replayed, true);
      const row = (await harness.executor.query(
        "SELECT shareholder_profile_id, status, agreement_kind, committed_amount, currency_code, legal_entity_id FROM abos.capital_agreements WHERE id = $1",
        [agreement.capitalAgreementId])).rows[0];
      assert.deepEqual(row, { shareholder_profile_id: holder.shareholderProfileId, status: "DRAFT", agreement_kind: "CAPITAL_CONTRIBUTION",
        committed_amount: "100000", currency_code: "USD", legal_entity_id: world.legalEntityId });
      const view = (await workspace(session)).agreements.find((candidate) => candidate.id === agreement.capitalAgreementId);
      assert.equal(view?.shareholderProfileId, holder.shareholderProfileId);
      assert.equal(view?.status, "DRAFT");
      assert.ok(view?.requestBlockers.includes("AGREEMENT_DRAFT"));
      await assert.rejects(() => createAgreement(session, holder.shareholderProfileId, { agreementReference: "SYN-AGR-001" }), /duplicate key|unique/i);
      await assert.rejects(() => createAgreement(session, holder.shareholderProfileId, { committedAmount: "1e5" }), /plain positive decimals/);
      await assert.rejects(() => createAgreement(session, holder.shareholderProfileId, { committedAmount: "0" }), /plain positive decimals/);
      await assert.rejects(() => createAgreement(session, holder.shareholderProfileId, { currencyCode: "EUR" }), /not enabled/);

      // Another legal entity: its user cannot see or use this entity's shareholder or agreement.
      const second = await addSecondEntity(harness.executor, world, [MANAGE]);
      const other = sessionArgs(second.token);
      await assert.rejects(() => createAgreement(other, holder.shareholderProfileId), /not an active shareholder of this legal entity/);
      await assert.rejects(() => addInstallment(other, agreement.capitalAgreementId, "1000"), /not found in this legal entity/);
      await assert.rejects(() => recordDocument(other, agreement.capitalAgreementId), /not found in this legal entity/);
      await assert.rejects(() => call("shareholder_setup_correct_shareholder", other,
        { shareholderProfileId: holder.shareholderProfileId, displayName: "Hijacked" }), /not found in this legal entity/);
      const otherView = await workspace(other);
      assert.deepEqual(otherView.agreements, []);
      assert.deepEqual(otherView.shareholders, []);
    });

    test("installments take the agreement's currency, stay within the commitment, and cancelled ones are excluded", async () => {
      await resetSchema(harness.pool);
      const world = await seedSyntheticWorld(harness.executor);
      const session = await manager(world);
      const holder = await createShareholder(session);
      const { capitalAgreementId: agreementId } = await createAgreement(session, holder.shareholderProfileId, { committedAmount: "100000", currencyCode: "AFN" });
      const first = await addInstallment(session, agreementId, "60000");
      assert.equal(first.sequenceNumber, 1);
      await assert.rejects(() => addInstallment(session, agreementId, "40000.01"), /would plan 100000\.01 against a committed capital of 100000/);
      await assert.rejects(() => addInstallment(session, agreementId, "1000", { currencyCode: "USD" }), /unknown or missing installment fields/,
        "the currency is never taken from the request");
      // The database refuses an installment in another currency than its agreement, for any writer.
      await assert.rejects(() => harness.executor.query(
        `INSERT INTO abos.capital_installments (id, legal_entity_id, capital_agreement_id, sequence_number, expected_amount, currency_code, status, created_by_user_account_id)
         VALUES ($1,$2,$3,9,1,'USD','DRAFT',$4)`, [randomUUID(), world.legalEntityId, agreementId, world.bootstrapUserId]), /foreign key/);
      const second = await addInstallment(session, agreementId, "40000");
      const currencies = await harness.executor.query("SELECT DISTINCT currency_code FROM abos.capital_installments WHERE capital_agreement_id = $1", [agreementId]);
      assert.deepEqual(currencies.rows, [{ currency_code: "AFN" }]);
      // ... and an over-plan, for any writer.
      await assert.rejects(() => harness.executor.query(
        `INSERT INTO abos.capital_installments (id, legal_entity_id, capital_agreement_id, sequence_number, expected_amount, currency_code, status, created_by_user_account_id)
         VALUES ($1,$2,$3,9,1,'AFN','DRAFT',$4)`, [randomUUID(), world.legalEntityId, agreementId, world.bootstrapUserId]), /would plan/);
      // Editing within the plan, and above it.
      await assert.rejects(() => call("shareholder_setup_update_installment", session,
        { capitalInstallmentId: second.capitalInstallmentId, expectedAmount: "40001", dueOn: "2026-12-15" }), /would plan/);
      await call("shareholder_setup_update_installment", session, { capitalInstallmentId: second.capitalInstallmentId, expectedAmount: "30000", dueOn: "2026-12-15" });
      // Cancelling releases its share of the plan; un-cancelling (raising the plan again) is checked.
      await assert.rejects(() => call("shareholder_setup_cancel_installment", session, { capitalInstallmentId: first.capitalInstallmentId, reason: "" }), /reason/);
      await call("shareholder_setup_cancel_installment", session, { capitalInstallmentId: first.capitalInstallmentId, reason: "Synthetic schedule change" });
      const replacement = await addInstallment(session, agreementId, "70000");
      assert.equal(replacement.sequenceNumber, 3);
      await assert.rejects(() => harness.executor.query("UPDATE abos.capital_installments SET status = 'DRAFT' WHERE id = $1", [first.capitalInstallmentId]), /would plan 160000/);
      await assert.rejects(() => call("shareholder_setup_update_installment", session,
        { capitalInstallmentId: first.capitalInstallmentId, expectedAmount: "1", dueOn: null }), /only a DRAFT installment/);
      // The commitment cannot be reduced below the plan.
      await assert.rejects(() => call("shareholder_setup_update_agreement", session,
        { capitalAgreementId: agreementId, agreementReference: "SYN-AGR-X", committedAmount: "99999.99", currencyCode: "AFN", effectiveOn: "2026-09-01" }),
        /cannot be reduced below the 100000 already planned/);
      await assert.rejects(() => call("shareholder_setup_update_agreement", session,
        { capitalAgreementId: agreementId, agreementReference: "SYN-AGR-X", committedAmount: "100000", currencyCode: "USD", effectiveOn: "2026-09-01" }),
        /currency cannot change once installments exist/);
      const view = (await workspace(session)).agreements.find((candidate) => candidate.id === agreementId);
      assert.equal(view?.planned, "100000");
      assert.deepEqual(view?.installments.map((installment) => [installment.sequence, installment.status]), [[1, "CANCELLED"], [2, "DRAFT"], [3, "DRAFT"]]);
    });

    test("concurrent installment writes cannot jointly exceed the commitment, through the functions or raw SQL at any isolation", async () => {
      await resetSchema(harness.pool);
      const world = await seedSyntheticWorld(harness.executor);
      const session = await manager(world);
      const holder = await createShareholder(session);
      const { capitalAgreementId: agreementId } = await createAgreement(session, holder.shareholderProfileId, { committedAmount: "100000" });
      const second = restrictedFinance();
      try {
        const payload = (amount: string) => JSON.stringify({ capitalAgreementId: agreementId, expectedAmount: amount, idempotencyKey: randomUUID(), correlationId: randomUUID() });
        const sql = "SELECT abos.shareholder_setup_add_installment($1,$2,$3,$4::jsonb) AS value";
        const args = (amount: string) => [session.proof, session.runtimeDigest, session.tokenDigest, payload(amount)];
        const outcomes = await Promise.allSettled([restricted.executor.query(sql, args("60000")), second.executor.query(sql, args("60000"))]);
        assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1, JSON.stringify(outcomes));
        assert.match(String((outcomes.find((outcome) => outcome.status === "rejected") as PromiseRejectedResult).reason), /would plan 120000|duplicate key/);
      } finally {
        await second.close();
      }
      assert.equal(await planned(harness, agreementId), "60000");

      for (const isolation of ["READ COMMITTED", "REPEATABLE READ", "SERIALIZABLE"] as const) {
        const { capitalAgreementId: target } = await createAgreement(session, holder.shareholderProfileId, { committedAmount: "100000" });
        const a = await harness.pool.connect(); const b = await harness.pool.connect();
        try {
          for (const client of [a, b]) {
            await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
            await client.query("SELECT count(*) FROM abos.capital_installments WHERE capital_agreement_id = $1", [target]);
          }
          const insert = (client: pg.PoolClient, sequence: number) => client.query(
            `INSERT INTO abos.capital_installments (id, legal_entity_id, capital_agreement_id, sequence_number, expected_amount, currency_code, status, created_by_user_account_id)
             VALUES ($1,$2,$3,$4,60000,'USD','DRAFT',$5)`, [randomUUID(), world.legalEntityId, target, sequence, world.bootstrapUserId]).then(() => client.query("COMMIT"));
          const outcomes = await Promise.allSettled([insert(a, 1), insert(b, 2)]);
          const failures = outcomes.filter((outcome) => outcome.status === "rejected") as PromiseRejectedResult[];
          assert.equal(failures.length, 1, `${isolation}: ${JSON.stringify(outcomes)}`);
          const code = (failures[0]?.reason as { code?: string }).code;
          assert.ok(code === "23514" || code === "40001", `${isolation}: ${code}`);
        } finally {
          await a.query("ROLLBACK").catch(() => undefined); await b.query("ROLLBACK").catch(() => undefined);
          a.release(); b.release();
        }
        assert.equal(await planned(harness, target), "60000", isolation);
      }
    });

    test("DRAFT-only corrections: once the agreement leaves DRAFT, agreement and installment edits are refused", async () => {
      await resetSchema(harness.pool);
      const world = await seedSyntheticWorld(harness.executor);
      const session = await manager(world);
      const holder = await createShareholder(session);
      const { capitalAgreementId: agreementId } = await createAgreement(session, holder.shareholderProfileId, { committedAmount: "50000" });
      const installment = await addInstallment(session, agreementId, "20000");
      const update = { capitalAgreementId: agreementId, agreementReference: "SYN-AGR-EDITED", committedAmount: "60000", currencyCode: "USD", effectiveOn: "2026-09-02", partialInstallmentsAllowed: true };
      await call("shareholder_setup_update_agreement", session, update);
      const edited = (await harness.executor.query(
        "SELECT agreement_reference, committed_amount, effective_on, partial_installments_allowed FROM abos.capital_agreements WHERE id = $1", [agreementId])).rows[0] as Json;
      assert.equal(edited.agreement_reference, "SYN-AGR-EDITED");
      assert.equal(edited.committed_amount, "60000");
      assert.equal(isoDate(edited.effective_on as Date), "2026-09-02");
      assert.equal(edited.partial_installments_allowed, true);
      assert.equal((await harness.executor.query("SELECT 1 FROM abos.audit_records WHERE action = 'CAPITAL_AGREEMENT_DRAFT_EDITED' AND entity_id = $1", [agreementId])).rowCount, 1);
      // The agreement leaves DRAFT (a later, separately authorized step; simulated here).
      await harness.executor.query("UPDATE abos.capital_agreements SET status = 'PENDING_EVIDENCE' WHERE id = $1", [agreementId]);
      await assert.rejects(() => call("shareholder_setup_update_agreement", session, update), /only a DRAFT capital agreement/);
      await assert.rejects(() => addInstallment(session, agreementId, "1000"), /only while the agreement is DRAFT/);
      await assert.rejects(() => call("shareholder_setup_update_installment", session,
        { capitalInstallmentId: installment.capitalInstallmentId, expectedAmount: "1000", dueOn: null }), /only a DRAFT installment of a DRAFT agreement/);
      await assert.rejects(() => call("shareholder_setup_cancel_installment", session,
        { capitalInstallmentId: installment.capitalInstallmentId, reason: "Synthetic" }), /only a DRAFT installment of a DRAFT agreement/);
      const view = (await workspace(session)).agreements.find((candidate) => candidate.id === agreementId);
      assert.equal(view?.editable, false);
      assert.equal(view?.installments[0]?.editable, false);
    });

    test("agreement documents are linked to exactly one agreement, persist their metadata, and never cross legal entities", async () => {
      await resetSchema(harness.pool);
      const world = await seedSyntheticWorld(harness.executor);
      const session = await manager(world);
      const holder = await createShareholder(session);
      const { capitalAgreementId: agreementId } = await createAgreement(session, holder.shareholderProfileId);
      const hash = "0123456789abcdef".repeat(4);
      const key = randomUUID();
      const recorded = await recordDocument(session, agreementId, { documentReference: "  Synthetic agreement AGR-7 ", documentDate: "2026-08-30", sha256: hash.toUpperCase(), idempotencyKey: key });
      assert.equal(recorded.version, 1);
      assert.deepEqual(await recordDocument(session, agreementId, { documentReference: "  Synthetic agreement AGR-7 ", documentDate: "2026-08-30", sha256: hash.toUpperCase(), idempotencyKey: key }),
        { ...recorded, replayed: true });
      const persisted = (await harness.executor.query<{ document_reference: string; document_date: Date; version: number; sha256: string; evidence_kind: string; recorded_by_user_account_id: string }>(
        `SELECT link.document_reference, link.document_date, link.version, er.sha256, er.evidence_kind, link.recorded_by_user_account_id
           FROM abos.capital_agreement_evidence link JOIN abos.evidence_references er ON er.id = link.evidence_reference_id
          WHERE link.capital_agreement_id = $1`, [agreementId])).rows;
      assert.equal(persisted.length, 1);
      assert.equal(persisted[0]?.document_reference, "Synthetic agreement AGR-7");
      assert.equal(isoDate(persisted[0]?.document_date), "2026-08-30", "the document date is stored, not discarded");
      assert.equal(persisted[0]?.sha256, hash);
      assert.equal(persisted[0]?.evidence_kind, "CAPITAL_AGREEMENT");
      assert.equal(persisted[0]?.recorded_by_user_account_id, world.treasuryManagerId);
      const second = await recordDocument(session, agreementId, { documentReference: "Synthetic amended agreement", documentDate: "2026-09-01" });
      assert.equal(second.version, 2);
      const view = (await workspace(session)).agreements.find((candidate) => candidate.id === agreementId);
      assert.deepEqual(view?.documents.map((document) => [document.version, document.documentDate]), [[1, "2026-08-30"], [2, "2026-09-01"]]);
      assert.ok(!view?.requestBlockers.includes("AGREEMENT_EVIDENCE_MISSING"));
      await assert.rejects(() => recordDocument(session, agreementId, { documentDate: "2999-01-01" }), /cannot be in the future/);
      await assert.rejects(() => recordDocument(session, agreementId, { sha256: "xyz" }), /SHA-256/);
      // Links are append-only and one document evidences one agreement.
      await assert.rejects(() => harness.executor.query("UPDATE abos.capital_agreement_evidence SET document_reference = 'x'"), /audit|immutable|not permitted|cannot/i);
      const { capitalAgreementId: otherAgreement } = await createAgreement(session, holder.shareholderProfileId);
      await assert.rejects(() => harness.executor.query(
        `INSERT INTO abos.capital_agreement_evidence (id, legal_entity_id, capital_agreement_id, evidence_reference_id, version, document_reference, document_date, recorded_by_user_account_id)
         VALUES ($1,$2,$3,$4,1,'reuse','2026-08-30',$5)`, [randomUUID(), world.legalEntityId, otherAgreement, recorded.evidenceReferenceId, world.bootstrapUserId]), /duplicate key/);
      // Only CAPITAL_AGREEMENT documents, and only of the same legal entity.
      await assert.rejects(() => harness.executor.query(
        `INSERT INTO abos.capital_agreement_evidence (id, legal_entity_id, capital_agreement_id, evidence_reference_id, version, document_reference, document_date, recorded_by_user_account_id)
         VALUES ($1,$2,$3,$4,1,'wrong kind','2026-08-30',$5)`, [randomUUID(), world.legalEntityId, otherAgreement, world.registrationEvidenceId, world.bootstrapUserId]), /only a CAPITAL_AGREEMENT document/);
      const otherEntity = await addSecondEntity(harness.executor, world, [MANAGE]);
      const foreignEvidence = randomUUID();
      await harness.executor.query(
        `INSERT INTO abos.evidence_references (id, legal_entity_id, document_id, evidence_kind, evidence_version, sha256, completed_at)
         VALUES ($1,$2,gen_random_uuid(),'CAPITAL_AGREEMENT',1,$3,clock_timestamp())`, [foreignEvidence, otherEntity.legalEntityId, "b".repeat(64)]);
      for (const entity of [world.legalEntityId, otherEntity.legalEntityId]) {
        await assert.rejects(() => harness.executor.query(
          `INSERT INTO abos.capital_agreement_evidence (id, legal_entity_id, capital_agreement_id, evidence_reference_id, version, document_reference, document_date, recorded_by_user_account_id)
           VALUES ($1,$2,$3,$4,1,'cross entity','2026-08-30',$5)`, [randomUUID(), entity, otherAgreement, foreignEvidence, world.bootstrapUserId]),
          /foreign key|only a CAPITAL_AGREEMENT document of the same legal entity/);
      }
    });

    test("the capital request path needs a document linked to that exact agreement; another agreement's document does not satisfy it", async () => {
      await resetSchema(harness.pool);
      const world = await seedSyntheticWorld(harness.executor);
      await grant(harness.executor, world, world.intentCreatorId, ["shareholder.capital-request.create"]);
      const creator = await plainSession(harness, world, world.intentCreatorId);
      // A second ELIGIBLE agreement of the same shareholder with verified registration but no own document.
      const agreementId = randomUUID(); const installmentId = randomUUID(); const registration = randomUUID();
      await harness.executor.query(
        `INSERT INTO abos.capital_agreements (id, legal_entity_id, shareholder_profile_id, agreement_reference, agreement_kind, committed_amount, currency_code, effective_on, status, partial_installments_allowed, created_by_user_account_id)
         VALUES ($1,$2,$3,'SYN-NO-DOC','CAPITAL_CONTRIBUTION',50000,'USD','2026-09-01','ELIGIBLE',false,$4)`,
        [agreementId, world.legalEntityId, world.shareholderProfileId, world.bootstrapUserId]);
      await harness.executor.query(
        `INSERT INTO abos.evidence_references (id, legal_entity_id, document_id, evidence_kind, evidence_version, sha256, completed_at)
         VALUES ($1,$2,gen_random_uuid(),'FORMAL_REGISTRATION',1,$3,clock_timestamp())`, [registration, world.legalEntityId, "c".repeat(64)]);
      await harness.executor.query(
        `INSERT INTO abos.registration_evidence (id, legal_entity_id, capital_agreement_id, evidence_reference_id, status, verified_by_user_account_id, verified_at)
         VALUES (gen_random_uuid(),$1,$2,$3,'VERIFIED',$4,clock_timestamp())`, [world.legalEntityId, agreementId, registration, world.bootstrapUserId]);
      await harness.executor.query(
        `INSERT INTO abos.capital_installments (id, legal_entity_id, capital_agreement_id, sequence_number, expected_amount, currency_code, due_on, business_event_at, status, created_by_user_account_id)
         VALUES ($1,$2,$3,1,25000,'USD','2026-09-22','2026-09-22T07:00:00Z','PENDING_RECEIPT',$4)`, [installmentId, world.legalEntityId, agreementId, world.bootstrapUserId]);
      const run = <T>(work: (db: PostgresExecutor) => Promise<T>) => work(restricted.executor);
      await assert.rejects(() => run((db) => createRequest(db, creator, { installmentId, destination: world.cashAccountId, amount: "25000", businessDate: isoToday() })),
        /CAPITAL_AGREEMENT document linked to this agreement is required/);
      const e1 = await run((db) => shareholderWorkspace<{ agreements: { installments: { id: string; blockers: string[] }[] }[] }>(db, creator));
      const blocked = e1.agreements.flatMap((agreement) => agreement.installments).find((installment) => installment.id === installmentId);
      assert.ok(blocked?.blockers.includes("AGREEMENT_EVIDENCE_MISSING"), JSON.stringify(blocked));
      // An explicit legal-entity policy removes only the agreement-document condition. It does
      // not grant a receipt, Treasury handoff, Finance approval or journal posting capability.
      await harness.executor.query(
        `INSERT INTO abos.capital_agreement_document_policies
          (legal_entity_id, document_requirement, decision_reference)
         VALUES ($1, 'OPTIONAL', 'SYNTHETIC_TEST_POLICY')`, [world.legalEntityId]);
      const optionalView = await run((db) => shareholderWorkspace<{ agreements: { installments: { id: string; blockers: string[] }[] }[] }>(db, creator));
      const optionalInstallment = optionalView.agreements.flatMap((agreement) => agreement.installments)
        .find((installment) => installment.id === installmentId);
      assert.ok(optionalInstallment && !optionalInstallment.blockers.includes("AGREEMENT_EVIDENCE_MISSING"));
      const optionalRequest = await run((db) => createRequest(db, creator,
        { installmentId, destination: world.cashAccountId, amount: "25000", businessDate: isoToday() }));
      assert.ok(optionalRequest.id, "the optional policy permits a synthetic request without a document");
      const financialRows = await harness.executor.query<{ receipts: string; journals: string }>(
        `SELECT (SELECT count(*) FROM abos.cash_receipts)::text AS receipts,
                (SELECT count(*) FROM abos.journals)::text AS journals`);
      assert.deepEqual(financialRows.rows[0], { receipts: "0", journals: "0" });
      // The world's own agreement has its linked document and still works on the synthetic path.
      const created = await run((db) => createRequest(db, creator, { installmentId: world.installmentId, destination: world.cashAccountId, amount: "25000.00", businessDate: isoToday() }));
      assert.ok(created.id);
      // The E1 TypeScript request path applies the same exact-link rule.
      const repository = new PostgresShareholderRepository(harness.executor, world.intentCreatorId as UserAccountId);
      assert.deepEqual(await repository.listDocuments(world.legalEntityId as LegalEntityId, agreementId as CapitalAgreementId)
        .then((documents) => documents.filter((document) => document.evidence.kind === "CAPITAL_AGREEMENT")), []);
    });

    test("optional policy is legal-entity scoped and draft setup needs no document", async () => {
      await resetSchema(harness.pool);
      const world = await seedSyntheticWorld(harness.executor);
      const session = await manager(world);
      const before = await moneyFootprint(harness);
      assert.equal((await workspace(session)).agreementDocumentRequirement, "REQUIRED");
      await harness.executor.query(
        `INSERT INTO abos.capital_agreement_document_policies
          (legal_entity_id, document_requirement, decision_reference)
         VALUES ($1, 'OPTIONAL', 'SYNTHETIC_TEST_POLICY')`, [world.legalEntityId]);
      const holder = await createShareholder(session, { externalReference: "OPTIONAL-DOC-HOLDER" });
      const agreement = await createAgreement(session, holder.shareholderProfileId);
      await addInstallment(session, agreement.capitalAgreementId, "25000");
      const view = await workspace(session);
      const created = view.agreements.find((candidate) => candidate.id === agreement.capitalAgreementId);
      assert.equal(view.agreementDocumentRequirement, "OPTIONAL");
      assert.deepEqual(created?.documents, []);
      assert.ok(!created?.requestBlockers.includes("AGREEMENT_EVIDENCE_MISSING"));
      const second = await addSecondEntity(harness.executor, world, [MANAGE]);
      const secondSession = sessionArgs((await issueOperationalSession(harness, second.userId, second.legalEntityId)).token);
      assert.equal((await workspace(secondSession)).agreementDocumentRequirement, "REQUIRED",
        "an optional policy never leaks into another legal entity");
      assert.deepEqual(await moneyFootprint(harness), before);
      await assert.rejects(() => restricted.executor.query("SELECT * FROM abos.capital_agreement_document_policies"), /permission denied/);
    });

    test("corrections stop once capital is posted; the read model counts only POSTED, non-reversed capital, and setup never touches money", async () => {
      await resetSchema(harness.pool);
      const world = await seedSyntheticWorld(harness.executor);
      const session = await manager(world);
      const before = await moneyFootprint(harness);
      // A complete setup sequence creates no Treasury, posting, journal or subledger row.
      const holder = await createShareholder(session, { externalReference: "SH-MONEY" });
      const { capitalAgreementId } = await createAgreement(session, holder.shareholderProfileId, { committedAmount: "70000" });
      const installment = await addInstallment(session, capitalAgreementId, "30000");
      await call("shareholder_setup_update_installment", session, { capitalInstallmentId: installment.capitalInstallmentId, expectedAmount: "35000", dueOn: "2027-01-01" });
      await recordDocument(session, capitalAgreementId);
      await call("shareholder_setup_correct_shareholder", session, { shareholderProfileId: holder.shareholderProfileId, displayName: "Synthetic Shareholder Money" });
      await call("shareholder_setup_cancel_installment", session, { capitalInstallmentId: installment.capitalInstallmentId, reason: "Synthetic" });
      assert.deepEqual(await moneyFootprint(harness), before, "no Treasury, posting, journal or subledger effect");
      const setupView = (await workspace(session)).agreements.find((candidate) => candidate.id === capitalAgreementId);
      assert.deepEqual([setupView?.committed, setupView?.requested, setupView?.received, setupView?.remaining], ["70000", "0", "0", "70000"]);
      assert.deepEqual(setupView?.requestBlockers, ["AGREEMENT_DRAFT", "REGISTRATION_NOT_VERIFIED", "RECEIPT_PATH_NOT_OPERATIONAL"],
        "the document is recorded; the other reasons why no capital can be received on it are listed");
      assert.equal(setupView?.registration, "NONE");

      // The seeded (synthetic, sandbox-authorized) shareholder: correctable until capital is posted.
      await call("shareholder_setup_correct_shareholder", session, { shareholderProfileId: world.shareholderProfileId, displayName: "Synthetic Shareholder One (checked)" });
      const journalId = await postSyntheticCapital(harness, world);
      await assert.rejects(() => call("shareholder_setup_correct_shareholder", session,
        { shareholderProfileId: world.shareholderProfileId, displayName: "Too late" }), /already has posted capital/);
      let view = await workspace(session);
      const seeded = view.agreements.find((candidate) => candidate.id === world.agreementId);
      assert.deepEqual([seeded?.committed, seeded?.requested, seeded?.received, seeded?.remaining], ["100000.00", "0", "25000.00", "75000.00"]);
      assert.equal(view.shareholders.find((shareholder) => shareholder.id === world.shareholderProfileId)?.correctable, false);
      assert.deepEqual(view.totalsByCurrency.find((total) => total.currency === "USD"),
        { currency: "USD", committed: "170000.00", received: "25000.00", remaining: "145000.00" }, "never double-counted across agreements");

      // A pending request is shown as requested, not received.
      await grant(harness.executor, world, world.intentCreatorId, ["shareholder.capital-request.create"]);
      const second = (await harness.executor.query<{ id: string }>(
        `INSERT INTO abos.capital_installments (id, legal_entity_id, capital_agreement_id, sequence_number, expected_amount, currency_code, due_on, business_event_at, status, created_by_user_account_id)
         VALUES (gen_random_uuid(),$1,$2,5,10000,'USD','2026-09-22','2026-09-22T07:00:00Z','PENDING_RECEIPT',$3) RETURNING id`,
        [world.legalEntityId, world.agreementId, world.bootstrapUserId])).rows[0]?.id ?? "";
      await createRequest(restricted.executor, await plainSession(harness, world, world.intentCreatorId),
        { installmentId: second, destination: world.cashAccountId, amount: "10000", businessDate: isoToday() });
      view = await workspace(session);
      const pending = view.agreements.find((candidate) => candidate.id === world.agreementId);
      assert.deepEqual([pending?.requested, pending?.received, pending?.remaining], ["10000", "25000.00", "75000.00"]);

      // An effective reversal removes the capital from "received" (read-model fixture: the reversal
      // link is inserted directly, since reversal posting is deliberately not operational).
      await harness.executor.transaction(async (tx) => {
        await tx.query("SET LOCAL session_replication_role = replica");
        const reversal = randomUUID();
        const reversalIntent = randomUUID();
        await tx.query(
          `INSERT INTO abos.posting_intents (id, legal_entity_id, source_type, source_id, intent_kind, original_amount, original_currency_code,
             accounting_effective_date, correlation_id, idempotency_key, status, created_by_user_account_id)
           SELECT $1::uuid, pi.legal_entity_id, 'SYNTHETIC_REVERSAL_FIXTURE', gen_random_uuid(), 'REVERSAL', pi.original_amount, pi.original_currency_code,
                  pi.accounting_effective_date, gen_random_uuid(), $3, 'POSTED', pi.created_by_user_account_id
             FROM abos.posting_intents pi JOIN abos.journals j ON j.posting_intent_id = pi.id WHERE j.id = $2`,
          [reversalIntent, journalId, `reversal-fixture-${reversalIntent}`]);
        await tx.query(
          `INSERT INTO abos.journals (id, legal_entity_id, accounting_period_id, posting_intent_id, journal_reference, accounting_effective_date,
             base_currency_code, status, created_by_user_account_id, posted_by_user_account_id, posted_at)
           SELECT $1::uuid, legal_entity_id, accounting_period_id, $4::uuid, $3, accounting_effective_date,
                  base_currency_code, 'POSTED', created_by_user_account_id, posted_by_user_account_id, clock_timestamp()
             FROM abos.journals WHERE id = $2`, [reversal, journalId, `SYN-REV-${reversal.slice(0, 8)}`, reversalIntent]);
        await tx.query(
          `INSERT INTO abos.journal_reversal_links (original_journal_id, reversal_journal_id, reason, approved_by_user_account_id, evidence_reference_id)
           VALUES ($1, $2, 'Synthetic read-model fixture', $3, $4)`, [journalId, reversal, world.approverId, world.reversalEvidenceId]);
      });
      const reversed = (await workspace(session)).agreements.find((candidate) => candidate.id === world.agreementId);
      assert.deepEqual([reversed?.received, reversed?.remaining], ["0", "100000.00"]);
    });

    test("least privilege: column-level grants only, no table, membership or destructive privilege; the runtime can only execute", async () => {
      await resetSchema(harness.pool);
      const world = await seedSyntheticWorld(harness.executor);
      const role = (await harness.executor.query(
        `SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolinherit FROM pg_catalog.pg_roles WHERE rolname = $1`, [OWNER])).rows[0];
      assert.deepEqual(role, { rolcanlogin: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false, rolinherit: false });
      assert.equal((await harness.executor.query(
        "SELECT 1 FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles r ON r.oid IN (m.member, m.roleid) WHERE r.rolname = $1", [OWNER])).rowCount, 0);
      assert.equal((await harness.executor.query(
        `SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'abos' AND pg_catalog.pg_get_userbyid(c.relowner) = $1`, [OWNER])).rowCount, 0, "owns no table");
      const tableGrants = await harness.executor.query<{ grant: string }>(
        "SELECT table_name || ':' || privilege_type AS grant FROM information_schema.role_table_grants WHERE grantee = $1 ORDER BY 1", [OWNER]);
      assert.deepEqual(tableGrants.rows.map((row) => row.grant), ["capital_agreement_evidence:SELECT"], "the only whole-table grant is reading the new link table");
      const writes = await harness.executor.query<{ grant: string }>(
        `SELECT table_name || '.' || privilege_type || '(' || string_agg(column_name, ',' ORDER BY column_name) || ')' AS grant
           FROM information_schema.column_privileges WHERE grantee = $1 AND privilege_type IN ('INSERT', 'UPDATE')
          GROUP BY table_name, privilege_type ORDER BY 1`, [OWNER]);
      assert.deepEqual(writes.rows.map((row) => row.grant), [
        "audit_records.INSERT(action,actor_user_account_id,after_state,before_state,correlation_id,entity_id,entity_type,id,legal_entity_id,metadata)",
        "business_parties.INSERT(display_name,external_reference,id,legal_entity_id,status)",
        "business_parties.UPDATE(display_name,external_reference)",
        "business_party_roles.INSERT(business_party_id,effective_from,role_code)",
        "capital_agreement_commitment_usage.INSERT(capital_agreement_id,consumed_amount,legal_entity_id)",
        "capital_agreement_commitment_usage.UPDATE(capital_agreement_id)",
        "capital_agreement_evidence.INSERT(capital_agreement_id,document_date,document_reference,evidence_reference_id,id,legal_entity_id,recorded_by_user_account_id,version)",
        "capital_agreements.INSERT(agreement_kind,agreement_reference,committed_amount,created_by_user_account_id,currency_code,effective_on,id,legal_entity_id,partial_installments_allowed,shareholder_profile_id,status)",
        "capital_agreements.UPDATE(agreement_reference,committed_amount,currency_code,effective_on,partial_installments_allowed)",
        "capital_installment_plan_revisions.INSERT(capital_agreement_id,legal_entity_id)",
        "capital_installment_plan_revisions.UPDATE(revision)",
        "capital_installments.INSERT(capital_agreement_id,created_by_user_account_id,currency_code,due_on,expected_amount,id,legal_entity_id,sequence_number,status)",
        "capital_installments.UPDATE(due_on,expected_amount,status)",
        "evidence_references.INSERT(completed_at,document_id,evidence_kind,evidence_version,id,legal_entity_id,sha256)",
        "idempotency_records.INSERT(correlation_id,idempotency_key,request_fingerprint,scope,status)",
        "idempotency_records.UPDATE(completed_at,resource_id,resource_type,response_code,response_snapshot,status)",
        "shareholder_profiles.INSERT(business_party_id,id,legal_entity_id,status)"
      ]);
      // The usage row can be locked by the owner but never changed.
      await ownerRefused(harness, `UPDATE abos.capital_agreement_commitment_usage SET capital_agreement_id = capital_agreement_id WHERE capital_agreement_id = '${world.agreementId}'`,
        /may lock but not change capital_agreement_commitment_usage/);
      for (const statement of [
        "DELETE FROM abos.business_parties", "DELETE FROM abos.capital_installments", "UPDATE abos.capital_agreements SET status = 'ELIGIBLE'",
        "UPDATE abos.shareholder_profiles SET status = 'ARCHIVED'", "UPDATE abos.business_parties SET status = 'ARCHIVED'",
        "UPDATE abos.capital_agreement_commitment_usage SET consumed_amount = 0", "INSERT INTO abos.registration_evidence (id) VALUES (gen_random_uuid())",
        "INSERT INTO abos.journals (id) VALUES (gen_random_uuid())", "SELECT * FROM abos.user_credentials", "SELECT * FROM abos.journal_lines",
        "TRUNCATE abos.capital_agreement_evidence"
      ]) await ownerRefused(harness, statement, /permission denied/);
      // The runtime executes the reviewed entry points only, and cannot touch the tables directly.
      for (const fn of SETUP_FUNCTIONS) {
        const callers = await harness.executor.query<{ role: string }>(
          `SELECT role FROM unnest(ARRAY['abos_e1_runtime','abos_e1_treasury_runtime','abos_v1_identity_runtime','public']) role
            WHERE has_function_privilege(role, $1, 'EXECUTE') ORDER BY 1`, [`abos.${fn}`]);
        assert.deepEqual(callers.rows.map((row) => row.role), ["abos_e1_runtime"], fn);
      }
      for (const helper of ["shareholder_setup_actor(text,text,text,text[])", "shareholder_setup_received(uuid,uuid)", "shareholder_setup_audit(uuid,uuid,uuid,text,text,uuid,jsonb,jsonb)"]) {
        assert.equal((await harness.executor.query<{ ok: boolean }>("SELECT has_function_privilege('abos_e1_runtime', $1, 'EXECUTE') AS ok", [`abos.${helper}`])).rows[0]?.ok, false, helper);
      }
      for (const statement of [
        `INSERT INTO abos.business_parties (id, legal_entity_id, display_name, status) VALUES (gen_random_uuid(), '${world.legalEntityId}', 'x', 'ACTIVE')`,
        "UPDATE abos.capital_agreements SET committed_amount = 1", "UPDATE abos.capital_installments SET status = 'CANCELLED'",
        "SELECT * FROM abos.capital_agreement_evidence", "DELETE FROM abos.capital_agreement_evidence"
      ]) {
        await assert.rejects(() => restricted.executor.query(statement), /permission denied/, statement);
      }
    });

    test("existing data that breaks the invariants makes the migration fail closed", async () => {
      await resetSchema(harness.pool);
      const world = await seedSyntheticWorld(harness.executor);
      const migration = await readFile(resolve(import.meta.dirname, "../../../infrastructure/database/migrations/0031_v1_shareholder_setup.sql"), "utf8");
      const preflight = migration.slice(migration.indexOf("DO $preflight$"), migration.indexOf("$preflight$;") + "$preflight$;".length);
      assert.ok(preflight.startsWith("DO $preflight$") && preflight.endsWith("$preflight$;"));
      const attempt = async (arrange: (client: pg.PoolClient) => Promise<void>, expected: RegExp) => {
        const client = await harness.pool.connect();
        try {
          await client.query("BEGIN");
          await arrange(client);
          // The complete migration, as the runner would apply it: it stops at the preflight.
          await assert.rejects(() => client.query(migration), expected);
        } finally {
          await client.query("ROLLBACK");
          client.release();
        }
      };
      // An over-planned schedule, as a pre-0031 database could hold it.
      await attempt(async (client) => {
        await client.query("ALTER TABLE abos.capital_installments DISABLE TRIGGER capital_installments_commitment_invariant");
        await client.query(
          `INSERT INTO abos.capital_installments (id, legal_entity_id, capital_agreement_id, sequence_number, expected_amount, currency_code, status, created_by_user_account_id)
           VALUES (gen_random_uuid(), $1, $2, 7, 90000, 'USD', 'DRAFT', $3)`, [world.legalEntityId, world.agreementId, world.bootstrapUserId]);
      }, /migration 0031 refused: 1 capital agreement\(s\) already plan installments above their committed capital/);
      // Cancelled installments do not count.
      const client = await harness.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("ALTER TABLE abos.capital_installments DISABLE TRIGGER capital_installments_commitment_invariant");
        await client.query(
          `INSERT INTO abos.capital_installments (id, legal_entity_id, capital_agreement_id, sequence_number, expected_amount, currency_code, status, created_by_user_account_id)
           VALUES (gen_random_uuid(), $1, $2, 7, 90000, 'USD', 'CANCELLED', $3)`, [world.legalEntityId, world.agreementId, world.bootstrapUserId]);
        await client.query(preflight);
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
      // Two parties sharing a reference that differs only in case and spacing.
      await attempt(async (client) => {
        await client.query("DROP INDEX abos.business_parties_reference_normalized");
        await client.query(
          `INSERT INTO abos.business_parties (id, legal_entity_id, display_name, external_reference, status)
           SELECT gen_random_uuid(), legal_entity_id, 'Synthetic duplicate', ' ' || lower(external_reference) || ' ', 'ACTIVE'
             FROM abos.business_parties WHERE id = $1`, [world.businessPartyId]);
      }, /migration 0031 refused: 1 party reference\(s\) are used by more than one business party/);
    });
  });
}

async function planned(harness: Harness, agreementId: string): Promise<string> {
  return (await harness.executor.query<{ total: string }>(
    "SELECT coalesce(sum(expected_amount), 0)::text AS total FROM abos.capital_installments WHERE capital_agreement_id = $1 AND status <> 'CANCELLED'",
    [agreementId])).rows[0]?.total ?? "";
}

async function footprint(harness: Harness): Promise<unknown> {
  return (await harness.executor.query(
    `SELECT (SELECT count(*) FROM abos.business_parties) AS parties, (SELECT count(*) FROM abos.shareholder_profiles) AS profiles,
            (SELECT count(*) FROM abos.capital_agreements) AS agreements, (SELECT count(*) FROM abos.idempotency_records) AS idempotency,
            (SELECT count(*) FROM abos.audit_records) AS audit`)).rows[0];
}

async function moneyFootprint(harness: Harness): Promise<unknown> {
  return (await harness.executor.query(
    `SELECT (SELECT count(*) FROM abos.cash_receipts) AS cash_receipts, (SELECT count(*) FROM abos.physical_cash_counts) AS counts,
            (SELECT count(*) FROM abos.treasury_finance_handoffs) AS handoffs, (SELECT count(*) FROM abos.capital_receipt_intents) AS requests,
            (SELECT count(*) FROM abos.posting_intents) AS posting_intents, (SELECT count(*) FROM abos.posting_approvals) AS approvals,
            (SELECT count(*) FROM abos.journals) AS journals, (SELECT count(*) FROM abos.journal_lines) AS lines,
            (SELECT count(*) FROM abos.subledger_entries) AS subledger, (SELECT count(*) FROM abos.outbox_events) AS outbox,
            (SELECT coalesce(sum(consumed_amount), 0) FROM abos.capital_agreement_commitment_usage) AS consumed`)).rows[0];
}

/** One synthetic capital receipt on the world's agreement: Treasury, hand-off, Finance approval and posting. */
async function postSyntheticCapital(harness: Harness, world: SyntheticWorld): Promise<string> {
  const service = new CapitalReceiptIntentService(new PostgresShareholderRepository(harness.executor, world.intentCreatorId as UserAccountId));
  const row = (await harness.executor.query<{ id: string; document_id: string; evidence_kind: EvidenceReference["kind"]; evidence_version: number; sha256: string; completed_at: Date | string }>(
    "SELECT id, document_id, evidence_kind, evidence_version, sha256, completed_at FROM abos.evidence_references WHERE id = $1",
    [world.agreementDocumentEvidenceId])).rows[0];
  assert.ok(row);
  const intent = await service.createCapitalReceiptIntent({
    legalEntityId: world.legalEntityId as LegalEntityId, shareholderPartyId: world.businessPartyId as never,
    agreementId: world.agreementId as CapitalAgreementId, installmentId: world.installmentId as CapitalInstallmentId,
    amount: { amount: asDecimalString(world.installmentAmount), currency: "USD" },
    expectedDestinationAccountId: world.cashAccountId as CashLocationCurrencyAccountId,
    businessEventAt: "2026-09-22T07:00:00.000Z",
    source: { legalEntityId: world.legalEntityId as LegalEntityId, idempotencyKey: `setup-${randomUUID()}` as IdempotencyKey, correlationId: randomUUID() as CorrelationId },
    evidence: [{ id: row.id as never, documentId: row.document_id as never, kind: row.evidence_kind, version: row.evidence_version, sha256: row.sha256, completedAt: new Date(row.completed_at).toISOString() }]
  });
  const receipt = await recordSyntheticTreasuryReceipt(harness.executor, world, { capitalReceiptIntentId: intent.id, amount: world.installmentAmount });
  await handOffSyntheticReceipt(harness.executor, world, receipt.cashReceiptId);
  const postingIntentId = await recordCapitalPostingIntent(harness.executor, world, {
    capitalReceiptIntentId: intent.id, cashReceiptId: receipt.cashReceiptId, amount: world.installmentAmount,
    idempotencyKey: `setup-post-${randomUUID()}`, correlationId: randomUUID()
  });
  return new RestrictedCapitalPostingGateway(harness.executor).post({
    bearerToken: await plainSession(harness, world, world.approverId), postingIntentId: postingIntentId as PostingIntentId,
    accountingPeriodId: world.accountingPeriodId as never
  });
}

async function ownerRefused(harness: Harness, statement: string, pattern: RegExp): Promise<void> {
  const client = await harness.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL ROLE ${OWNER}`);
    await assert.rejects(() => client.query(statement), pattern, statement);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
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

async function plainSession(harness: Harness, world: SyntheticWorld, userId: string): Promise<string> {
  return (await issueOperationalSession(harness, userId, world.legalEntityId)).token;
}

async function sessionFor(harness: Harness, world: SyntheticWorld, userId: string): Promise<SessionArgs> {
  return sessionArgs(await plainSession(harness, world, userId));
}

function sessionArgs(token: string): SessionArgs {
  return {
    proof: identityDatabaseProof(SYNTHETIC_AUTH_CONFIGURATION.signingSecret),
    runtimeDigest: createHash("sha256").update(token).digest("hex"),
    tokenDigest: createHmac("sha256", SYNTHETIC_AUTH_CONFIGURATION.signingSecret).update(token).digest("hex")
  };
}

function isoDate(value: Date | string | undefined): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value.slice(0, 10);
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}
