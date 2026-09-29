import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import test, { after, before, describe } from "node:test";
import pg from "pg";

import type {
  CapitalAgreementId,
  CapitalInstallmentId,
  CashLocationCurrencyAccountId,
  CorrelationId,
  EvidenceReference,
  IdempotencyKey,
  LegalEntityId,
  UserAccountId
} from "@abos/contracts";
import { asDecimalString } from "@abos/contracts";
import { PostgresExecutor, PostgresShareholderRepository } from "@abos/persistence";
import {
  identityDatabaseProof,
  SandboxAuthenticator
} from "@abos/sandbox-auth";
import { CapitalReceiptIntentService } from "@abos/shareholder";

import {
  databaseUrl,
  MISSING_DATABASE_MESSAGE,
  openHarness,
  resetSchema,
  type Harness
} from "./harness.ts";
import {
  handOffSyntheticReceipt,
  recordCapitalPostingIntent,
  recordSyntheticTreasuryReceipt,
  seedSyntheticWorld,
  SYNTHETIC_AUTH_CONFIGURATION,
  type SyntheticWorld
} from "./synthetic-world.ts";

/** Migration 0028: real PostgreSQL proof for the isolated OPERATIONAL_V1 expense lane. */

const MARKER = SYNTHETIC_AUTH_CONFIGURATION.runtimeMarker;
const LOGIN = {
  name: "abos_v1_operational_expense_test_login",
  password: "synthetic-operational-expense-runtime-only-2026"
};

interface SessionArgs {
  readonly proof: string;
  readonly runtimeDigest: string;
  readonly tokenDigest: string;
}

interface ExpenseResult {
  readonly expense: {
    readonly id: string;
    readonly status: string;
    readonly version: number;
    readonly journalId: string | null;
    readonly approvalRequired: boolean;
    readonly originalAmount: string;
    readonly originalCurrency: string;
    readonly baseAmount: string;
    readonly baseCurrency: string;
    readonly exchangeRateSnapshot: null | {
      readonly id: string;
      readonly exchangeRateId: string;
      readonly rate: string;
    };
  };
  readonly replayed: boolean;
}

interface Fixture {
  readonly world: SyntheticWorld;
  readonly treasuryId: string;
  readonly categoryId: string;
  readonly expenseLedgerId: string;
  readonly policyId: string;
  readonly creatorSession: SessionArgs;
  readonly approverSession: SessionArgs;
  readonly creatorToken: string;
  readonly approverToken: string;
  readonly executor: PostgresExecutor;
  close(): Promise<void>;
}

if (databaseUrl() === undefined) {
  test("V1 operational expense posting", () => assert.fail(MISSING_DATABASE_MESSAGE));
} else {
  describe("V1 operational expense posting (migration 0028)", () => {
    let harness: Harness;

    before(async () => { harness = await openHarness(MARKER); });
    after(async () => { await harness.close(); });

    test("legacy rows default to LEGACY_E1, relabelling fails, and the old E1 poster still posts", async () => {
      await resetSchema(harness.pool);
      const world = await seedSyntheticWorld(harness.executor);

      const defaults = await harness.executor.query<{ table_name: string; column_default: string }>(
        `SELECT table_name, column_default
           FROM information_schema.columns
          WHERE table_schema = 'abos' AND column_name = 'processing_model'
            AND table_name = ANY($1::text[])
          ORDER BY table_name`,
        [["posting_intents", "journals", "journal_lines", "subledger_entries"]]
      );
      assert.deepEqual(defaults.rows.map((row) => row.table_name), [
        "journal_lines", "journals", "posting_intents", "subledger_entries"
      ]);
      assert.ok(defaults.rows.every((row) => row.column_default.includes("LEGACY_E1")));

      const journalId = await postLegacyCapital(harness, world);
      const stored = await harness.executor.query<{ model: string; status: string }>(
        "SELECT processing_model AS model, status FROM abos.journals WHERE id = $1", [journalId]
      );
      assert.deepEqual(stored.rows[0], { model: "LEGACY_E1", status: "POSTED" });
      await assert.rejects(
        () => harness.executor.query(
          "UPDATE abos.journals SET processing_model = 'OPERATIONAL_V1' WHERE id = $1", [journalId]
        ),
        /processing model is immutable/i
      );
      await assert.rejects(
        () => harness.executor.query(
          `UPDATE abos.journal_lines SET processing_model = 'OPERATIONAL_V1'
            WHERE journal_id = $1 AND line_number = 1`,
          [journalId]
        ),
        /processing model is immutable|must match its parent/i
      );
    });

    test("runtime and PUBLIC retain the least-privilege boundary", async () => {
      await resetSchema(harness.pool);
      await ensureLogin(harness);
      const restricted = await restrictedFinance();
      try {
        for (const table of ["operational_expenses", "operational_expense_approvals", "journals"] as const) {
          await assert.rejects(
            () => restricted.executor.query(`SELECT * FROM abos.${table}`),
            /permission denied/i,
            table
          );
        }
        await assert.rejects(
          () => restricted.executor.query("SET ROLE abos_v1_operational_finance_owner"),
          /permission denied to set role/i
        );
      } finally {
        await restricted.close();
      }

      const owner = (await harness.executor.query<{
        rolcanlogin: boolean; rolsuper: boolean; rolcreatedb: boolean; rolcreaterole: boolean;
        rolreplication: boolean; rolbypassrls: boolean; rolinherit: boolean;
      }>(
        `SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole,
                rolreplication, rolbypassrls, rolinherit
           FROM pg_catalog.pg_roles WHERE rolname = 'abos_v1_operational_finance_owner'`
      )).rows[0];
      assert.deepEqual(owner, {
        rolcanlogin: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false,
        rolreplication: false, rolbypassrls: false, rolinherit: false
      });
      const memberships = await scalar(harness,
        `SELECT count(*) FROM pg_catalog.pg_auth_members membership
          JOIN pg_catalog.pg_roles member ON member.oid = membership.member
          JOIN pg_catalog.pg_roles granted ON granted.oid = membership.roleid
         WHERE member.rolname = 'abos_v1_operational_finance_owner'
            OR granted.rolname = 'abos_v1_operational_finance_owner'`);
      assert.equal(memberships, 0);
      assert.equal(await scalar(harness,
        `SELECT count(*) FROM pg_catalog.pg_class object
          JOIN pg_catalog.pg_namespace namespace ON namespace.oid = object.relnamespace
          JOIN pg_catalog.pg_roles owner ON owner.oid = object.relowner
         WHERE namespace.nspname = 'abos'
           AND owner.rolname = 'abos_v1_operational_finance_owner'`), 0);

      const publicExecute = await harness.executor.query<{ signature: string }>(
        `SELECT routine.oid::regprocedure::text AS signature
           FROM pg_catalog.pg_proc routine
           CROSS JOIN LATERAL pg_catalog.aclexplode(
             COALESCE(routine.proacl, pg_catalog.acldefault('f', routine.proowner))) privilege
          WHERE routine.pronamespace = 'abos'::regnamespace
            AND routine.proname = ANY($1::text[])
            AND privilege.grantee = 0 AND privilege.privilege_type = 'EXECUTE'`,
        [[
          "operational_expense_actor_in_scope", "operational_expense_json",
          "operational_expense_post", "operational_expense_workspace",
          "operational_expense_create", "operational_expense_approve",
          "validate_operational_journal_posting", "validate_operational_treasury_reversal_link"
        ]]
      );
      assert.deepEqual(publicExecute.rows, []);
      assert.equal(await scalar(harness,
        `SELECT count(*) FROM pg_catalog.pg_proc routine
          WHERE routine.pronamespace = 'abos'::regnamespace
            AND routine.proname LIKE 'operational%reversal%'
            AND routine.proname <> 'validate_operational_treasury_reversal_link'`), 0,
      "no operational reversal posting entry point exists");

      await roleStatementRejected(harness, "abos_v1_operational_finance_owner",
        "SELECT token_sha256 FROM abos.sandbox_sessions LIMIT 1", /permission denied/i);
    });

    test("invalid identity, permission and entity attempts leave zero financial writes", async () => {
      const fixture = await setupFixture(harness, false);
      try {
        const payload = expensePayload(fixture);
        const baseline = await financialCounts(harness);
        await assert.rejects(
          () => createExpense(fixture.executor, { ...fixture.creatorSession, proof: "f".repeat(64) }, payload),
          /identity runtime proof is invalid/i
        );
        assert.deepEqual(await financialCounts(harness), baseline);

        const noPermission = await sessionFor(harness, fixture.world, fixture.world.cashierId);
        await assert.rejects(
          () => createExpense(fixture.executor, noPermission.args, { ...payload, idempotencyKey: `deny-${randomUUID()}` }),
          /missing finance\.expense\.create/i
        );
        assert.deepEqual(await financialCounts(harness), baseline);

        await harness.executor.query(
          "UPDATE abos.sandbox_sessions SET revoked_at = clock_timestamp() WHERE id = $1",
          [noPermission.sessionId]
        );
        await assert.rejects(
          () => createExpense(fixture.executor, noPermission.args, { ...payload, idempotencyKey: `revoked-${randomUUID()}` }),
          /sign in with an active account/i
        );
        assert.deepEqual(await financialCounts(harness), baseline);

        const expired = await sessionFor(harness, fixture.world, fixture.world.intentCreatorId);
        await harness.executor.query(
          `UPDATE abos.sandbox_sessions
              SET issued_at = now() - interval '2 hours',
                  expires_at = now() - interval '1 hour' - interval '1 second'
            WHERE id = $1`,
          [expired.sessionId]
        );
        await assert.rejects(
          () => createExpense(fixture.executor, expired.args, { ...payload, idempotencyKey: `expired-${randomUUID()}` }),
          /sign in with an active account/i
        );
        assert.deepEqual(await financialCounts(harness), baseline);

        const other = await seedSyntheticWorld(harness.executor, { withoutSandboxAuthorization: true });
        const otherTreasuryId = randomUUID();
        await harness.executor.query(
          `INSERT INTO abos.operational_treasury_accounts
             (id, legal_entity_id, name_en, account_type, currency_code, ledger_account_id,
              status, version, created_by_user_account_id, last_changed_by_user_account_id)
           VALUES ($1,$2,'Other synthetic safe','SAFE','USD',$3,'ACTIVE',1,$4,$4)`,
          [otherTreasuryId, other.legalEntityId, other.cashLedgerAccountId, other.bootstrapUserId]
        );
        await assert.rejects(
          () => createExpense(fixture.executor, fixture.creatorSession, {
            ...payload, treasuryAccountId: otherTreasuryId,
            idempotencyKey: `cross-${randomUUID()}`
          }),
          /same-entity Treasury account/i
        );
        assert.deepEqual(await financialCounts(harness), baseline);
      } finally {
        await fixture.close();
      }
    });

    test("approval OFF posts once, is concurrently idempotent and records exact immutable effects", async () => {
      const fixture = await setupFixture(harness, false);
      try {
        const payload = expensePayload(fixture, { originalAmount: "125.50" });
        const [left, right] = await Promise.all([
          createExpense(fixture.executor, fixture.creatorSession, payload),
          createExpense(fixture.executor, fixture.creatorSession, payload)
        ]);
        assert.equal(left.expense.id, right.expense.id);
        assert.equal([left.replayed, right.replayed].filter(Boolean).length, 1);
        assert.equal(left.expense.status, "POSTED");
        assert.equal(await scalar(harness, "SELECT count(*) FROM abos.operational_expenses"), 1);
        assert.equal(await scalar(harness, "SELECT count(*) FROM abos.operational_expense_approvals"), 0);
        assert.equal(await scalar(harness,
          "SELECT count(*) FROM abos.journals WHERE processing_model = 'OPERATIONAL_V1'"), 1);

        const lines = await harness.executor.query<{
          line_number: number; ledger_account_id: string; debit: string; credit: string;
        }>(
          `SELECT line_number, ledger_account_id, base_debit::text AS debit,
                  base_credit::text AS credit
             FROM abos.journal_lines WHERE journal_id = $1 ORDER BY line_number`,
          [left.expense.journalId]
        );
        assert.deepEqual(lines.rows, [
          { line_number: 1, ledger_account_id: fixture.expenseLedgerId, debit: "125.50", credit: "0" },
          { line_number: 2, ledger_account_id: fixture.world.cashLedgerAccountId, debit: "0", credit: "125.50" }
        ]);
        const movement = (await harness.executor.query<{
          original: string; base: string; account_id: string;
        }>(
          `SELECT original_amount::text AS original, base_amount::text AS base,
                  operational_treasury_account_id AS account_id
             FROM abos.subledger_entries
            WHERE processing_model = 'OPERATIONAL_V1'`,
        )).rows[0];
        assert.deepEqual(movement, { original: "-125.50", base: "-125.50", account_id: fixture.treasuryId });

        await assert.rejects(
          () => createExpense(fixture.executor, fixture.creatorSession, {
            ...payload, description: "Conflicting synthetic request"
          }),
          /idempotency key was already used/i
        );
        assert.equal(await scalar(harness, "SELECT count(*) FROM abos.operational_expenses"), 1);

        await assert.rejects(
          () => harness.executor.query(
            "UPDATE abos.operational_expenses SET description = 'mutated' WHERE id = $1",
            [left.expense.id]
          ),
          /posted operational expense is immutable/i
        );
        await assert.rejects(
          () => harness.executor.query(
            "UPDATE abos.journals SET journal_reference = journal_reference || '-x' WHERE id = $1",
            [left.expense.journalId]
          ),
          /restricted operational Finance boundary/i,
          "an outside writer is refused at the operational boundary"
        );
        await roleStatementRejected(harness, "abos_v1_operational_finance_owner",
          `UPDATE abos.journals SET status = 'POSTED' WHERE id = '${left.expense.journalId}'`,
          /posted operational journal is immutable/i);
        await assert.rejects(
          () => harness.executor.query(
            "UPDATE abos.subledger_entries SET base_amount = base_amount - 1 WHERE source_id = $1",
            [left.expense.id]
          ),
          /restricted operational Finance boundary/i
        );
        // Deletes bypass the model guard, so the generic posted-ledger guards must refuse them.
        for (const [table, column, id] of [
          ["subledger_entries", "source_id", left.expense.id],
          ["journal_lines", "journal_id", left.expense.journalId],
          ["journals", "id", left.expense.journalId],
          ["operational_expenses", "id", left.expense.id]
        ] as const) {
          await assert.rejects(
            () => harness.executor.query(`DELETE FROM abos.${table} WHERE ${column} = $1`, [id]),
            (error: unknown) => /posted|immutable|permanent|cannot|append-only|violates foreign key/i.test(String(error)),
            `DELETE on ${table} must be refused`
          );
        }
        assert.equal(await scalar(harness,
          "SELECT count(*) FROM abos.subledger_entries WHERE processing_model = 'OPERATIONAL_V1'"), 1);
      } finally {
        await fixture.close();
      }
    });

    test("approval ON has no financial effect until a different permitted approver posts", async () => {
      const fixture = await setupFixture(harness, true);
      try {
        const pending = await createExpense(
          fixture.executor, fixture.creatorSession, expensePayload(fixture)
        );
        assert.equal(pending.expense.status, "PENDING_APPROVAL");
        assert.equal(pending.expense.journalId, null);
        assert.equal(await scalar(harness, "SELECT count(*) FROM abos.journals"), 0);
        assert.equal(await scalar(harness, "SELECT count(*) FROM abos.subledger_entries"), 0);
        await assert.rejects(
          () => approveExpense(
            fixture.executor, fixture.creatorSession, pending.expense.id,
            pending.expense.version, "Self approval must fail."
          ),
          /missing finance\.expense\.approve|creator cannot approve/i
        );

        const posted = await approveExpense(
          fixture.executor, fixture.approverSession, pending.expense.id,
          pending.expense.version, "Independent synthetic approval."
        );
        assert.equal(posted.expense.status, "POSTED");
        assert.ok(posted.expense.journalId);
        assert.equal(await scalar(harness, "SELECT count(*) FROM abos.operational_expense_approvals"), 1);
        assert.equal(await scalar(harness, "SELECT count(*) FROM abos.journals"), 1);
      } finally {
        await fixture.close();
      }
    });

    test("foreign exact rate is snapshotted and later correction cannot alter the posting", async () => {
      const fixture = await setupFixture(harness, false, "AFN");
      try {
        const rateId = randomUUID();
        await harness.executor.query(
          `INSERT INTO abos.exchange_rates
             (id, legal_entity_id, rate_date, rate_source, unit_currency_code,
              quote_currency_code, rate_value, note, entered_by_user_account_id)
           VALUES ($1,$2,'2026-09-22','MARKET','USD','AFN',70,'Synthetic exact rate',$3)`,
          [rateId, fixture.world.legalEntityId, fixture.world.bootstrapUserId]
        );
        const posted = await createExpense(fixture.executor, fixture.creatorSession,
          expensePayload(fixture, { originalAmount: "7000", currencyCode: "AFN", exchangeRateId: rateId }));
        assert.equal(posted.expense.baseAmount, "100");
        assert.equal(posted.expense.exchangeRateSnapshot?.exchangeRateId, rateId);
        assert.equal(posted.expense.exchangeRateSnapshot?.rate, "70");
        const snapshotId = posted.expense.exchangeRateSnapshot?.id;
        assert.ok(snapshotId);

        await harness.executor.query(
          `INSERT INTO abos.exchange_rates
             (id, legal_entity_id, rate_date, rate_source, unit_currency_code,
              quote_currency_code, rate_value, note, supersedes_exchange_rate_id,
              correction_reason, entered_by_user_account_id)
           VALUES ($1,$2,'2026-09-22','MARKET','USD','AFN',71,'Synthetic correction',$3,
                   'Synthetic correction evidence.',$4)`,
          [randomUUID(), fixture.world.legalEntityId, rateId, fixture.world.bootstrapUserId]
        );
        const snapshot = (await harness.executor.query<{ rate: string; rate_id: string }>(
          `SELECT rate_value::text AS rate, exchange_rate_id AS rate_id
             FROM abos.exchange_rate_snapshots WHERE id = $1`, [snapshotId]
        )).rows[0];
        assert.deepEqual(snapshot, { rate: "70", rate_id: rateId });
        await assert.rejects(
          () => harness.executor.query(
            "UPDATE abos.exchange_rate_snapshots SET rate_value = 71 WHERE id = $1", [snapshotId]
          ),
          /snapshot is immutable/i
        );
      } finally {
        await fixture.close();
      }
    });

    test("owner has no broad or credential access; runtimes cannot write tables or call helpers; forged sessions fail", async () => {
      const fixture = await setupFixture(harness, false);
      try {
        // The owner holds only column-level writes: no table-wide INSERT/UPDATE, and never
        // DELETE, TRUNCATE, TRIGGER or REFERENCES anywhere.
        const broad = await harness.executor.query<{ table_name: string; privilege_type: string }>(
          `SELECT table_name, privilege_type FROM information_schema.role_table_grants
            WHERE grantee = 'abos_v1_operational_finance_owner'
              AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'TRIGGER', 'REFERENCES')`);
        assert.deepEqual(broad.rows, []);
        for (const table of ["user_credentials", "sandbox_sessions", "identity_runtime_keys"]) {
          const exists = await scalar(harness,
            `SELECT count(*) FROM pg_catalog.pg_class WHERE oid = to_regclass('abos.${table}')`);
          if (exists === 0) continue;
          await roleStatementRejected(harness, "abos_v1_operational_finance_owner",
            `SELECT * FROM abos.${table} LIMIT 1`, /permission denied/i);
        }
        await roleStatementRejected(harness, "abos_v1_operational_finance_owner",
          "SELECT * FROM abos.user_accounts LIMIT 1", /permission denied/i);

        // The restricted runtime writes nothing directly.
        const baseline = await financialCounts(harness);
        for (const statement of [
          "INSERT INTO abos.operational_expenses (id) VALUES (gen_random_uuid())",
          "INSERT INTO abos.operational_expense_approvals (id) VALUES (gen_random_uuid())",
          "INSERT INTO abos.journals (id) VALUES (gen_random_uuid())",
          "UPDATE abos.subledger_entries SET base_amount = 0",
          "DELETE FROM abos.journal_lines"
        ]) {
          await assert.rejects(() => fixture.executor.query(statement), /permission denied/i, statement);
        }
        // Internal helpers are not callable by the Finance runtime; other runtimes call nothing.
        for (const call of [
          "SELECT abos.operational_expense_post(gen_random_uuid(), gen_random_uuid())",
          "SELECT abos.operational_expense_json(gen_random_uuid())",
          "SELECT abos.operational_expense_actor_in_scope(gen_random_uuid(), gen_random_uuid(), gen_random_uuid())"
        ]) {
          await assert.rejects(() => fixture.executor.query(call), /permission denied for function/i, call);
        }
        const wrongRuntime = await harness.executor.query<{ role: string; fn: string }>(
          `SELECT role, fn FROM unnest(ARRAY['abos_e1_treasury_runtime', 'abos_v1_identity_runtime']) role
             CROSS JOIN unnest(ARRAY[
               'abos.operational_expense_create(text,text,text,jsonb)',
               'abos.operational_expense_approve(text,text,text,uuid,integer,text)',
               'abos.operational_expense_workspace(text,text,text,date,date)']) fn
            WHERE has_function_privilege(role, fn, 'EXECUTE')`);
        assert.deepEqual(wrongRuntime.rows, [], "only the Finance runtime may call the entry points");

        // A forged session token (valid server proof, unknown digests) is refused before any write.
        const forged = sessionArgs(`forged-${randomUUID()}`);
        await assert.rejects(
          () => createExpense(fixture.executor, forged, expensePayload(fixture)),
          /sign in with an active account|session/i
        );
        assert.deepEqual(await financialCounts(harness), baseline);
      } finally {
        await fixture.close();
      }
    });

    test("another company's category, rate, expense and approvals are unusable and invisible", async () => {
      const fixture = await setupFixture(harness, false);
      try {
        const other = await secondCompany(harness, fixture.world, true);
        const otherRateId = randomUUID();
        await harness.executor.query(
          `INSERT INTO abos.exchange_rates
             (id, legal_entity_id, rate_date, rate_source, unit_currency_code,
              quote_currency_code, rate_value, note, entered_by_user_account_id)
           VALUES ($1,$2,'2026-09-22','MARKET','USD','AFN',70,'Synthetic other-company rate',$3)`,
          [otherRateId, other.world.legalEntityId, other.world.bootstrapUserId]);
        const baseline = await financialCounts(harness);
        await assert.rejects(
          () => createExpense(fixture.executor, fixture.creatorSession,
            expensePayload(fixture, { expenseCategoryId: other.categoryId })),
          /same-entity Treasury account and expense category/i);
        // An AFN Treasury account of our own, but the other company's rate.
        const afnTreasury = randomUUID();
        await harness.executor.query(
          `INSERT INTO abos.operational_treasury_accounts
             (id, legal_entity_id, name_en, account_type, currency_code, ledger_account_id,
              status, version, created_by_user_account_id, last_changed_by_user_account_id)
           VALUES ($1,$2,'Synthetic AFN safe','SAFE','AFN',$3,'ACTIVE',1,$4,$4)`,
          [afnTreasury, fixture.world.legalEntityId, fixture.world.afnCashLedgerAccountId, fixture.world.bootstrapUserId]);
        await assert.rejects(
          () => createExpense(fixture.executor, fixture.creatorSession, expensePayload(fixture, {
            treasuryAccountId: afnTreasury, currencyCode: "AFN", originalAmount: "7000", exchangeRateId: otherRateId })),
          /not a current USD\/AFN rate/i);
        assert.deepEqual(await financialCounts(harness), baseline, "refused attempts write nothing");

        // The other company's pending expense cannot be approved or seen from this company.
        const theirs = await createExpense(fixture.executor, other.creator, {
          ...expensePayload(fixture), treasuryAccountId: other.treasuryId, expenseCategoryId: other.categoryId });
        assert.equal(theirs.expense.status, "PENDING_APPROVAL");
        await grantPermission(harness, fixture.world, fixture.world.approverId, "finance.expense.read");
        await assert.rejects(
          () => approveExpense(fixture.executor, fixture.approverSession, theirs.expense.id,
            theirs.expense.version, "Cross-company approval attempt."),
          /not available in this legal entity/i);
        assert.equal(await scalar(harness, "SELECT count(*) FROM abos.operational_expense_approvals"), 0);
        const mine = await fixture.executor.query<{ value: { expenses: { id: string }[]; legalEntityId: string } }>(
          "SELECT abos.operational_expense_workspace($1,$2,$3,'2026-09-01','2026-09-30') AS value",
          [fixture.approverSession.proof, fixture.approverSession.runtimeDigest, fixture.approverSession.tokenDigest]);
        assert.equal(mine.rows[0]?.value.legalEntityId, fixture.world.legalEntityId);
        assert.deepEqual(mine.rows[0]?.value.expenses, []);
      } finally {
        await fixture.close();
      }
    });

    test("segregation of duties and the stored policy route hold whatever the current policy says", async () => {
      const fixture = await setupFixture(harness, true);
      try {
        // Even holding the approval permission, the creator cannot approve their own expense.
        await grantPermission(harness, fixture.world, fixture.world.intentCreatorId, "finance.expense.approve");
        const pending = await createExpense(fixture.executor, fixture.creatorSession, expensePayload(fixture));
        await assert.rejects(
          () => approveExpense(fixture.executor, fixture.creatorSession, pending.expense.id,
            pending.expense.version, "Self approval must fail."),
          /creator cannot approve/i);
        // The table guard refuses it too, whoever writes the row.
        await roleStatementRejected(harness, "abos_v1_operational_finance_owner",
          `INSERT INTO abos.operational_expense_approvals
             (id, legal_entity_id, operational_expense_id, decision, decision_note, approver_user_account_id)
           VALUES (gen_random_uuid(), '${fixture.world.legalEntityId}', '${pending.expense.id}', 'APPROVED',
                   'Forged self approval.', '${fixture.world.intentCreatorId}')`,
          /creator cannot approve/i);
        // A user without the approval permission is refused before any write.
        const reader = await sessionFor(harness, fixture.world, fixture.world.counterId);
        await grantPermission(harness, fixture.world, fixture.world.counterId, "finance.expense.read");
        await assert.rejects(
          () => approveExpense(fixture.executor, reader.args, pending.expense.id, pending.expense.version, "No authority here."),
          /missing finance\.expense\.approve/i);
        assert.equal(await scalar(harness, "SELECT count(*) FROM abos.posting_intents WHERE processing_model = 'OPERATIONAL_V1'"), 0,
          "a pending expense has no posting intent, journal or Treasury movement");

        // The company switches approval OFF: the pending expense keeps its stored route...
        await harness.executor.query(
          `INSERT INTO abos.finance_workflow_policy_versions
             (id, legal_entity_id, workflow_type, version, approval_required, configured_by_user_account_id, change_reason)
           VALUES ($1,$2,'EXPENSE',2,false,$3,'Synthetic test-only policy change.')`,
          [randomUUID(), fixture.world.legalEntityId, fixture.world.bootstrapUserId]);
        const stored = await harness.executor.query<{ approval_required: boolean; policy: string; status: string }>(
          "SELECT approval_required, workflow_policy_version_id AS policy, status FROM abos.operational_expenses WHERE id = $1",
          [pending.expense.id]);
        assert.deepEqual(stored.rows[0], { approval_required: true, policy: fixture.policyId, status: "PENDING_APPROVAL" });
        const approved = await approveExpense(fixture.executor, fixture.approverSession, pending.expense.id,
          pending.expense.version, "Independent synthetic approval.");
        assert.equal(approved.expense.status, "POSTED");
        const poster = await harness.executor.query<{ posted_by: string }>(
          "SELECT posted_by_user_account_id AS posted_by FROM abos.journals WHERE id = $1", [approved.expense.journalId]);
        assert.equal(poster.rows[0]?.posted_by, fixture.world.approverId);
        // ...and a new expense follows the new route: posted at once, with no approval row.
        const direct = await createExpense(fixture.executor, fixture.creatorSession, expensePayload(fixture));
        assert.equal(direct.expense.status, "POSTED");
        assert.equal(direct.expense.approvalRequired, false);
        assert.equal(await scalar(harness, "SELECT count(*) FROM abos.operational_expense_approvals"), 1);

        // Another user reusing an idempotency key never receives someone else's result.
        const keyed = expensePayload(fixture);
        await createExpense(fixture.executor, fixture.creatorSession, keyed);
        const approverCreates = await sessionFor(harness, fixture.world, fixture.world.approverId);
        await grantPermission(harness, fixture.world, fixture.world.approverId, "finance.expense.create");
        await assert.rejects(
          () => createExpense(fixture.executor, approverCreates.args, keyed),
          /idempotency key was already used/i);
      } finally {
        await fixture.close();
      }
    });

    test("foreign currency uses only that day's rate and refuses inexact conversion; amounts must be plain decimals", async () => {
      const fixture = await setupFixture(harness, false, "AFN");
      try {
        const yesterday = randomUUID();
        await harness.executor.query(
          `INSERT INTO abos.exchange_rates
             (id, legal_entity_id, rate_date, rate_source, unit_currency_code,
              quote_currency_code, rate_value, note, entered_by_user_account_id)
           VALUES ($1,$2,'2026-09-21','MARKET','USD','AFN',70,'Synthetic previous-day rate',$3)`,
          [yesterday, fixture.world.legalEntityId, fixture.world.bootstrapUserId]);
        const baseline = await financialCounts(harness);
        // No rate for the business date: refused, the previous day's rate is never used.
        await assert.rejects(
          () => createExpense(fixture.executor, fixture.creatorSession,
            expensePayload(fixture, { originalAmount: "7000", currencyCode: "AFN" })),
          /no USD\/AFN exchange rate is recorded for 2026-09-22/i);
        await assert.rejects(
          () => createExpense(fixture.executor, fixture.creatorSession,
            expensePayload(fixture, { originalAmount: "7000", currencyCode: "AFN", exchangeRateId: yesterday })),
          /not a current USD\/AFN rate/i);
        // A result that is not exact is refused: no rounding policy is approved.
        await harness.executor.query(
          `INSERT INTO abos.exchange_rates
             (id, legal_entity_id, rate_date, rate_source, unit_currency_code,
              quote_currency_code, rate_value, note, entered_by_user_account_id)
           VALUES ($1,$2,'2026-09-22','MARKET','USD','AFN',70,'Synthetic exact rate',$3)`,
          [randomUUID(), fixture.world.legalEntityId, fixture.world.bootstrapUserId]);
        await assert.rejects(
          () => createExpense(fixture.executor, fixture.creatorSession,
            expensePayload(fixture, { originalAmount: "100", currencyCode: "AFN" })),
          /not exact; rounding policy is not approved/i);
        for (const amount of ["NaN", "Infinity", "1e3", "-5", "0", "0.00", " 12"]) {
          await assert.rejects(
            () => createExpense(fixture.executor, fixture.creatorSession,
              expensePayload(fixture, { originalAmount: amount, currencyCode: "AFN" })),
            /plain positive decimal|complete valid expense details/i, amount);
        }
        assert.deepEqual(await financialCounts(harness), baseline, "refused attempts write nothing");
        const posted = await createExpense(fixture.executor, fixture.creatorSession,
          expensePayload(fixture, { originalAmount: "3500.00", currencyCode: "AFN" }));
        assert.equal(posted.expense.originalAmount, "3500.00");
        assert.equal(posted.expense.baseAmount, "50", "exact base amount, no spurious trailing digits");
      } finally {
        await fixture.close();
      }
    });

    test("Treasury decreases by exactly the posted expenses; correction goes through an independent reversal request", async () => {
      const fixture = await setupFixture(harness, false);
      try {
        const first = await createExpense(fixture.executor, fixture.creatorSession,
          expensePayload(fixture, { originalAmount: "125.50" }));
        await createExpense(fixture.executor, fixture.creatorSession,
          expensePayload(fixture, { originalAmount: "74.25" }));
        const treasury = await harness.executor.query<{ original: string; base: string }>(
          `SELECT sum(original_amount)::text AS original, sum(base_amount)::text AS base
             FROM abos.subledger_entries WHERE operational_treasury_account_id = $1`, [fixture.treasuryId]);
        assert.deepEqual(treasury.rows[0], { original: "-199.75", base: "-199.75" });
        const ledger = await harness.executor.query<{ debit: string; credit: string }>(
          `SELECT sum(base_debit)::text AS debit, sum(base_credit)::text AS credit
             FROM abos.journal_lines WHERE processing_model = 'OPERATIONAL_V1'`);
        assert.deepEqual(ledger.rows[0], { debit: "199.75", credit: "199.75" });

        // The creator took part in the journal, so cannot even request its reversal.
        await grantPermission(harness, fixture.world, fixture.world.intentCreatorId, "finance.reversal.request");
        await assert.rejects(
          () => reversalCall(fixture.executor, "SELECT abos.finance_reversal_request_create($1,$2,$3) AS value",
            [fixture.creatorToken, first.expense.journalId, "Synthetic: creator asks to reverse"]),
          /took part|participant|cannot request/i);
        // An independent requester and a different Finance Manager record the correction decision.
        await grantPermission(harness, fixture.world, fixture.world.reverserId, "finance.reversal.request");
        await grantPermission(harness, fixture.world, fixture.world.countConfirmerId, "finance.reversal.approve");
        const requester = await sessionFor(harness, fixture.world, fixture.world.reverserId);
        const manager = await sessionFor(harness, fixture.world, fixture.world.countConfirmerId);
        const request = await reversalCall<{ request: { id: string; status: string } }>(fixture.executor,
          "SELECT abos.finance_reversal_request_create($1,$2,$3) AS value",
          [requester.token, first.expense.journalId, "Synthetic: wrong category was used"]);
        assert.equal(request.request.status, "REQUESTED");
        const decided = await reversalCall<{ request: { status: string } }>(fixture.executor,
          "SELECT abos.finance_reversal_request_decide($1,$2,1,'APPROVED',NULL) AS value",
          [manager.token, request.request.id]);
        assert.equal(decided.request.status, "APPROVED");
        const trail = await harness.executor.query<{ reason: string; requested_by: string; decided_by: string; journal_id: string }>(
          `SELECT reason, requested_by_user_account_id AS requested_by, decided_by_user_account_id AS decided_by, journal_id
             FROM abos.journal_reversal_requests WHERE id = $1`, [request.request.id]);
        assert.deepEqual(trail.rows[0], {
          reason: "Synthetic: wrong category was used", requested_by: fixture.world.reverserId,
          decided_by: fixture.world.countConfirmerId, journal_id: first.expense.journalId });
        // Posting the reversal journal stays unavailable until the owner decides its date, period
        // and evidence policy: nothing was posted and the original is untouched.
        assert.equal(await scalar(harness, "SELECT count(*) FROM abos.journal_reversal_links"), 0);
        assert.equal(await scalar(harness,
          "SELECT count(*) FROM abos.posting_intents WHERE intent_kind = 'REVERSAL'"), 0);
        const original = await harness.executor.query<{ status: string }>(
          "SELECT status FROM abos.operational_expenses WHERE id = $1", [first.expense.id]);
        assert.equal(original.rows[0]?.status, "POSTED");
      } finally {
        await fixture.close();
      }
    });
  });
}

async function setupFixture(
  harness: Harness, approvalRequired: boolean, currencyCode: "USD" | "AFN" = "USD"
): Promise<Fixture> {
  await resetSchema(harness.pool);
  const world = await seedSyntheticWorld(harness.executor);
  const configured = await configureEntity(harness, world, approvalRequired, currencyCode);
  await ensureLogin(harness);
  const connection = await restrictedFinance();
  const creator = await sessionFor(harness, world, world.intentCreatorId);
  const approver = await sessionFor(harness, world, world.approverId);
  return {
    world, ...configured,
    creatorSession: creator.args, approverSession: approver.args,
    creatorToken: creator.token, approverToken: approver.token,
    executor: connection.executor, close: connection.close
  };
}

/** Synthetic test-only Operational Finance configuration for one legal entity. */
async function configureEntity(
  harness: Harness, world: SyntheticWorld, approvalRequired: boolean, currencyCode: "USD" | "AFN" = "USD"
): Promise<{ treasuryId: string; categoryId: string; expenseLedgerId: string; policyId: string }> {
  const expenseLedgerId = randomUUID();
  const treasuryId = randomUUID();
  const categoryId = randomUUID();
  const policyId = randomUUID();
  const treasuryLedgerId = currencyCode === "USD"
    ? world.cashLedgerAccountId : world.afnCashLedgerAccountId;
  await harness.executor.query(
    `INSERT INTO abos.ledger_accounts
       (id, legal_entity_id, account_code, account_name, account_type,
        posting_allowed, account_currency_code, status)
     VALUES ($1,$2,$3,'Synthetic Operational Expense','EXPENSE',true,'USD','ACTIVE')`,
    [expenseLedgerId, world.legalEntityId, `SYN-EXP-${expenseLedgerId.slice(0, 8)}`]
  );
  await harness.executor.query(
    `INSERT INTO abos.operational_treasury_accounts
       (id, legal_entity_id, name_en, account_type, currency_code, ledger_account_id,
        status, version, created_by_user_account_id, last_changed_by_user_account_id)
     VALUES ($1,$2,'Synthetic Operational Safe','SAFE',$3,$4,'ACTIVE',1,$5,$5)`,
    [treasuryId, world.legalEntityId, currencyCode, treasuryLedgerId, world.bootstrapUserId]
  );
  await harness.executor.query(
    `INSERT INTO abos.operational_expense_categories
       (id, legal_entity_id, category_code, name_en, ledger_account_id,
        status, version, created_by_user_account_id, last_changed_by_user_account_id)
     VALUES ($1,$2,'SYN-OPS','Synthetic Operations',$3,'ACTIVE',1,$4,$4)`,
    [categoryId, world.legalEntityId, expenseLedgerId, world.bootstrapUserId]
  );
  await harness.executor.query(
    `INSERT INTO abos.finance_workflow_policy_versions
       (id, legal_entity_id, workflow_type, version, approval_required,
        configured_by_user_account_id, change_reason)
     VALUES ($1,$2,'EXPENSE',1,$3,$4,'Synthetic test-only expense route.')`,
    [policyId, world.legalEntityId, approvalRequired, world.bootstrapUserId]
  );
  for (const [userId, permission] of [
    [world.intentCreatorId, "finance.expense.create"],
    [world.intentCreatorId, "finance.expense.read"],
    [world.approverId, "finance.expense.approve"],
    [world.approverId, "finance.expense.read"]
  ] as const) {
    await harness.executor.query(
      `INSERT INTO abos.user_permission_grants
         (user_account_id, legal_entity_id, permission_code, granted_by_user_account_id)
       VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [userId, world.legalEntityId, permission, world.bootstrapUserId]
    );
  }
  return { treasuryId, categoryId, expenseLedgerId, policyId };
}

/** A second synthetic company in the same database, with its own configuration and sessions. */
async function secondCompany(harness: Harness, first: SyntheticWorld, approvalRequired: boolean): Promise<{
  world: SyntheticWorld; treasuryId: string; categoryId: string; creator: SessionArgs;
}> {
  const world = await seedSyntheticWorld(harness.executor, { withoutSandboxAuthorization: true });
  await harness.executor.query(
    `INSERT INTO abos.sandbox_legal_entity_scopes (legal_entity_id, base_currency_code, authorized_by_user_account_id)
     VALUES ($1, 'USD', $2)`, [world.legalEntityId, first.bootstrapUserId]);
  const configured = await configureEntity(harness, world, approvalRequired);
  const creator = await sessionFor(harness, world, world.intentCreatorId);
  return { world, treasuryId: configured.treasuryId, categoryId: configured.categoryId, creator: creator.args };
}

async function grantPermission(harness: Harness, world: SyntheticWorld, userId: string, permission: string): Promise<void> {
  await harness.executor.query(
    `INSERT INTO abos.user_permission_grants (user_account_id, legal_entity_id, permission_code, granted_by_user_account_id)
     VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
    [userId, world.legalEntityId, permission, world.bootstrapUserId]);
}

async function reversalCall<T>(executor: PostgresExecutor, sql: string, parameters: readonly unknown[]): Promise<T> {
  const result = await executor.query<{ value: T }>(sql, parameters);
  assert.ok(result.rows[0]);
  return result.rows[0].value;
}

function expensePayload(fixture: Fixture, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    treasuryAccountId: fixture.treasuryId,
    expenseCategoryId: fixture.categoryId,
    payeeBusinessPartyId: null,
    projectId: null,
    departmentId: null,
    costCenterId: null,
    reference: `SYN-EXP-${randomUUID().slice(0, 8)}`,
    description: "Synthetic isolated operational expense",
    note: "Synthetic test fixture only",
    businessDate: "2026-09-22",
    originalAmount: "125.50",
    currencyCode: "USD",
    exchangeRateId: null,
    correlationId: randomUUID(),
    idempotencyKey: `expense-${randomUUID()}`,
    ...overrides
  };
}

async function createExpense(
  executor: PostgresExecutor, session: SessionArgs, payload: Record<string, unknown>
): Promise<ExpenseResult> {
  const result = await executor.query<{ value: ExpenseResult }>(
    "SELECT abos.operational_expense_create($1,$2,$3,$4::jsonb) AS value",
    [session.proof, session.runtimeDigest, session.tokenDigest, JSON.stringify(payload)]
  );
  assert.ok(result.rows[0]);
  return result.rows[0].value;
}

async function approveExpense(
  executor: PostgresExecutor, session: SessionArgs, expenseId: string,
  expectedVersion: number, note: string
): Promise<ExpenseResult> {
  const result = await executor.query<{ value: ExpenseResult }>(
    "SELECT abos.operational_expense_approve($1,$2,$3,$4,$5,$6) AS value",
    [session.proof, session.runtimeDigest, session.tokenDigest, expenseId, expectedVersion, note]
  );
  assert.ok(result.rows[0]);
  return result.rows[0].value;
}

async function ensureLogin(harness: Harness): Promise<void> {
  await harness.executor.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${LOGIN.name}') THEN
      CREATE ROLE ${LOGIN.name} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
    END IF; END $$`);
  await harness.executor.query(`ALTER ROLE ${LOGIN.name} LOGIN PASSWORD '${LOGIN.password}'`);
  await harness.executor.query(`GRANT abos_e1_runtime TO ${LOGIN.name}`);
}

async function restrictedFinance(): Promise<{
  readonly executor: PostgresExecutor; close(): Promise<void>;
}> {
  const url = new URL(databaseUrl() ?? "");
  url.username = LOGIN.name;
  url.password = LOGIN.password;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 6 });
  return {
    executor: new PostgresExecutor(pool, { runtimeMarker: MARKER }),
    close: () => pool.end()
  };
}

async function sessionFor(
  harness: Harness, world: SyntheticWorld, userId: string
): Promise<{ token: string; sessionId: string; args: SessionArgs }> {
  const authenticator = new SandboxAuthenticator(harness.executor, SYNTHETIC_AUTH_CONFIGURATION);
  const session = await authenticator.issueSession({
    userAccountId: userId as UserAccountId,
    legalEntityId: world.legalEntityId as LegalEntityId
  });
  return { token: session.token, sessionId: session.sessionId, args: sessionArgs(session.token) };
}

function sessionArgs(token: string): SessionArgs {
  return {
    proof: identityDatabaseProof(SYNTHETIC_AUTH_CONFIGURATION.signingSecret),
    runtimeDigest: createHash("sha256").update(token).digest("hex"),
    tokenDigest: createHmac("sha256", SYNTHETIC_AUTH_CONFIGURATION.signingSecret)
      .update(token).digest("hex")
  };
}

async function financialCounts(harness: Harness): Promise<Record<string, number>> {
  const result = await harness.executor.query<{
    expenses: string; approvals: string; intents: string; journals: string;
    lines: string; subledgers: string;
  }>(
    `SELECT
       (SELECT count(*) FROM abos.operational_expenses)::text AS expenses,
       (SELECT count(*) FROM abos.operational_expense_approvals)::text AS approvals,
       (SELECT count(*) FROM abos.posting_intents WHERE processing_model='OPERATIONAL_V1')::text AS intents,
       (SELECT count(*) FROM abos.journals WHERE processing_model='OPERATIONAL_V1')::text AS journals,
       (SELECT count(*) FROM abos.journal_lines WHERE processing_model='OPERATIONAL_V1')::text AS lines,
       (SELECT count(*) FROM abos.subledger_entries WHERE processing_model='OPERATIONAL_V1')::text AS subledgers`
  );
  const row = result.rows[0];
  assert.ok(row);
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value)]));
}

async function scalar(harness: Harness, sql: string): Promise<number> {
  const result = await harness.executor.query<{ count: string }>(sql);
  return Number(result.rows[0]?.count ?? "0");
}

async function roleStatementRejected(
  harness: Harness, role: string, sql: string, message: RegExp
): Promise<void> {
  const client = await harness.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL ROLE ${role}`);
    await assert.rejects(() => client.query(sql), message);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

async function postLegacyCapital(harness: Harness, world: SyntheticWorld): Promise<string> {
  const shareholder = new CapitalReceiptIntentService(
    new PostgresShareholderRepository(harness.executor, world.intentCreatorId as UserAccountId)
  );
  const evidence = (await harness.executor.query<{
    id: string; document_id: string; evidence_kind: EvidenceReference["kind"]; evidence_version: number;
    sha256: string; completed_at: Date | string;
  }>(
    `SELECT id, document_id, evidence_kind, evidence_version, sha256, completed_at
       FROM abos.evidence_references WHERE id = $1`,
    [world.agreementDocumentEvidenceId]
  )).rows[0];
  assert.ok(evidence);
  const intent = await shareholder.createCapitalReceiptIntent({
    legalEntityId: world.legalEntityId as LegalEntityId,
    shareholderPartyId: world.businessPartyId as never,
    agreementId: world.agreementId as CapitalAgreementId,
    installmentId: world.installmentId as CapitalInstallmentId,
    amount: { amount: asDecimalString(world.installmentAmount), currency: "USD" },
    expectedDestinationAccountId: world.cashAccountId as CashLocationCurrencyAccountId,
    businessEventAt: "2026-09-22T07:00:00.000Z",
    source: {
      legalEntityId: world.legalEntityId as LegalEntityId,
      idempotencyKey: `legacy-${randomUUID()}` as IdempotencyKey,
      correlationId: randomUUID() as CorrelationId
    },
    evidence: [{
      id: evidence.id as never, documentId: evidence.document_id as never,
      kind: evidence.evidence_kind, version: evidence.evidence_version, sha256: evidence.sha256,
      completedAt: new Date(evidence.completed_at).toISOString()
    }]
  });
  const receipt = await recordSyntheticTreasuryReceipt(harness.executor, world, {
    capitalReceiptIntentId: intent.id,
    amount: world.installmentAmount
  });
  await handOffSyntheticReceipt(harness.executor, world, receipt.cashReceiptId);
  const postingIntentId = await recordCapitalPostingIntent(harness.executor, world, {
    capitalReceiptIntentId: intent.id,
    cashReceiptId: receipt.cashReceiptId,
    amount: world.installmentAmount,
    idempotencyKey: `legacy-post-${randomUUID()}`,
    correlationId: randomUUID() as CorrelationId
  });
  const authenticator = new SandboxAuthenticator(harness.executor, SYNTHETIC_AUTH_CONFIGURATION);
  const session = await authenticator.issueSession({
    userAccountId: world.approverId as UserAccountId,
    legalEntityId: world.legalEntityId as LegalEntityId
  });
  const result = await harness.executor.query<{ journal_id: string }>(
    "SELECT abos.post_synthetic_capital_receipt($1,$2,$3) AS journal_id",
    [session.token, postingIntentId, world.accountingPeriodId]
  );
  assert.ok(result.rows[0]?.journal_id);
  return result.rows[0].journal_id;
}
