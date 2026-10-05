import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before, describe } from "node:test";
import pg from "pg";
import type {
  AccountingPeriodId, CapitalAgreementId, CapitalInstallmentId, CashLocationCurrencyAccountId, CorrelationId, EvidenceReference,
  IdempotencyKey, LegalEntityId, PostingIntentId, UserAccountId
} from "@abos/contracts";
import { asDecimalString } from "@abos/contracts";
import type { SqlExecutor } from "@abos/database";
import { PostgresExecutor, PostgresShareholderRepository, RestrictedCapitalPostingGateway } from "@abos/persistence";
import { SandboxAuthenticator } from "@abos/sandbox-auth";
import { CapitalReceiptIntentService } from "@abos/shareholder";
import { addSyntheticSaraf } from "./currency-fixtures.ts";
import { databaseUrl, MISSING_DATABASE_MESSAGE, openHarness, resetSchema, type Harness } from "./harness.ts";
import { issueOperationalSession } from "./operational-session.ts";
import {
  handOffSyntheticReceipt, recordCapitalPostingIntent, recordSyntheticTreasuryReceipt, seedSyntheticWorld,
  SYNTHETIC_AUTH_CONFIGURATION, type SyntheticWorld
} from "./synthetic-world.ts";

/**
 * Migration 0011: least-privilege ownership of the restricted Treasury and Finance functions.
 *
 * Asserts the ownership model from the catalogue, then attacks it: owners acting outside their
 * remit, runtimes calling internal helpers, direct table writes, changes to posted records, a
 * duplicate posting and a session used in the wrong legal entity.
 */

const MARKER = SYNTHETIC_AUTH_CONFIGURATION.runtimeMarker;
const OWNERS = [
  "abos_e1_treasury_owner", "abos_e1_finance_owner", "abos_e1_shareholder_owner",
  "abos_v1_operational_finance_owner", "abos_v1_company_dashboard_owner", "abos_v1_shareholder_setup_owner"
] as const;
const FUNCTION_OWNERS = [...OWNERS, "abos_v1_identity_owner", "abos_v1_workflow_policy_owner"] as const;
const LOGINS = {
  finance: { name: "abos_e1_finance_runtime_test_login", password: "synthetic-finance-runtime-only-2026", role: "abos_e1_runtime" },
  treasury: { name: "abos_e1_treasury_runtime_test_login", password: "synthetic-treasury-runtime-only-2026", role: "abos_e1_treasury_runtime" },
  identity: { name: "abos_v1_identity_runtime_test_login", password: "synthetic-identity-runtime-only-2026", role: "abos_v1_identity_runtime" }
} as const;

if (databaseUrl() === undefined) {
  test("V1 security-definer ownership", () => assert.fail(MISSING_DATABASE_MESSAGE));
} else {
  describe("V1 security-definer ownership (migration 0011)", () => {
    let harness: Harness;
    before(async () => {
      harness = await openHarness(MARKER);
      await resetSchema(harness.pool);
      for (const login of Object.values(LOGINS)) await ensureLogin(harness, login);
    });
    after(async () => { await harness.close(); });

    test("no SECURITY DEFINER function is owned by a superuser or a role that can bypass controls", async () => {
      const rows = await harness.executor.query<{
        signature: string; name: string; owner: string; superuser: boolean; bypassrls: boolean; createrole: boolean; can_login: boolean;
        config: string[] | null; public_execute: boolean;
      }>(
        `SELECT p.oid::regprocedure::text AS signature, p.proname AS name, r.rolname AS owner, r.rolsuper AS superuser,
                r.rolbypassrls AS bypassrls, r.rolcreaterole AS createrole, r.rolcanlogin AS can_login,
                p.proconfig AS config, has_function_privilege('public', p.oid, 'EXECUTE') AS public_execute
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_roles r ON r.oid = p.proowner
          WHERE n.nspname = 'abos' AND p.prosecdef ORDER BY 1`);
      assert.equal(rows.rows.length, 76, "every restricted entry point, including operational Finance, expense posting and its read model, the company dashboard, shareholder setup and private documents, workflow policy, GL, identity and reversal requests, is accounted for");
      for (const fn of rows.rows) {
        assert.ok((FUNCTION_OWNERS as readonly string[]).includes(fn.owner), `${fn.signature} is owned by ${fn.owner}`);
        assert.equal(fn.superuser, false, fn.signature);
        assert.equal(fn.bypassrls, false, fn.signature);
        assert.equal(fn.createrole, false, fn.signature);
        assert.equal(fn.can_login, false, fn.signature);
        assert.deepEqual(fn.config, ["search_path=pg_catalog, pg_temp"], `${fn.signature} pins its search path`);
        assert.equal(fn.public_execute, false, `${fn.signature} is not executable by PUBLIC`);
      }
      const expectedOwner: Record<string, string> = {
        operational_bearer_context: "abos_v1_identity_owner",
        identity_issue_password_session: "abos_v1_identity_owner",
        identity_rotate_password_session: "abos_v1_identity_owner",
        treasury_synthetic_signin_context: "abos_e1_treasury_owner",
        treasury_runtime_authorize: "abos_e1_treasury_owner", treasury_secure_context: "abos_e1_treasury_owner",
        treasury_secure_query: "abos_e1_treasury_owner", treasury_secure_command: "abos_e1_treasury_owner",
        treasury_revoke_own_session: "abos_e1_treasury_owner",
        finance_runtime_authorize: "abos_e1_finance_owner", finance_handoff_workspace: "abos_e1_finance_owner",
        finance_handoff_trace: "abos_e1_finance_owner", finance_prepare_capital_posting: "abos_e1_finance_owner",
        finance_approve_capital_posting: "abos_e1_finance_owner", post_synthetic_capital_receipt: "abos_e1_finance_owner",
        require_posted_reversal_link: "abos_e1_finance_owner", finance_calendar_view: "abos_e1_finance_owner",
        finance_calendar_configure: "abos_e1_finance_owner", finance_generate_fiscal_year: "abos_e1_finance_owner",
        // WP-A: chart of accounts (0014)
        finance_ledger_accounts_view: "abos_e1_finance_owner", finance_ledger_account_check: "abos_e1_finance_owner",
        finance_ledger_account_create: "abos_e1_finance_owner", finance_ledger_account_update: "abos_e1_finance_owner",
        finance_ledger_account_set_status: "abos_e1_finance_owner", finance_ledger_account_review: "abos_e1_finance_owner",
        // WP-B (0015): safes, Saraf accounts and whole-safe counts.
        treasury_safes_saraf_query: "abos_e1_treasury_owner", treasury_safes_saraf_command: "abos_e1_treasury_owner",
        // WP-C (0016): exchange rates are Finance; shareholder capital requests have their own least-privilege owner.
        finance_exchange_rates_view: "abos_e1_finance_owner", finance_record_exchange_rate: "abos_e1_finance_owner",
        finance_correct_exchange_rate: "abos_e1_finance_owner", shareholder_runtime_authorize: "abos_e1_shareholder_owner",
        shareholder_capital_workspace: "abos_e1_shareholder_owner", shareholder_create_capital_request: "abos_e1_shareholder_owner",
        finance_general_ledger: "abos_e1_finance_owner",
        // WP #19 GL activity (0024): per-account posted activity and keyset paging.
        finance_general_ledger_activity: "abos_e1_finance_owner", finance_general_ledger_page: "abos_e1_finance_owner",
        identity_issue_session_context: "abos_v1_identity_owner", identity_actor_context: "abos_v1_identity_owner",
        identity_runtime_lock: "abos_v1_identity_owner", identity_runtime_command: "abos_v1_identity_owner",
        finance_workflow_policy_actor: "abos_v1_workflow_policy_owner",
        finance_workflow_policy_workspace: "abos_v1_workflow_policy_owner",
        finance_workflow_policy_set: "abos_v1_workflow_policy_owner",
        operational_finance_actor: "abos_v1_operational_finance_owner",
        operational_finance_configuration_workspace: "abos_v1_operational_finance_owner",
        operational_treasury_account_upsert: "abos_v1_operational_finance_owner",
        operational_expense_category_upsert: "abos_v1_operational_finance_owner",
        finance_open_accounting_period: "abos_v1_operational_finance_owner",
        // 0028: operational expense entry points (reviewed design, section I).
        operational_expense_workspace: "abos_v1_operational_finance_owner",
        operational_expense_create: "abos_v1_operational_finance_owner",
        operational_expense_approve: "abos_v1_operational_finance_owner",
        // 0029: read-only Record Expense options and Daily Financial Report.
        operational_expense_entry_options: "abos_v1_operational_finance_owner",
        operational_finance_daily_report: "abos_v1_operational_finance_owner",
        // 0030: aggregate-only company dashboard.
        company_dashboard_summary: "abos_v1_company_dashboard_owner",
        // 0031: shareholder master data and DRAFT capital agreement setup.
        shareholder_setup_create_shareholder: "abos_v1_shareholder_setup_owner",
        shareholder_setup_correct_shareholder: "abos_v1_shareholder_setup_owner",
        shareholder_setup_create_agreement: "abos_v1_shareholder_setup_owner",
        shareholder_setup_update_agreement: "abos_v1_shareholder_setup_owner",
        shareholder_setup_add_installment: "abos_v1_shareholder_setup_owner",
        shareholder_setup_update_installment: "abos_v1_shareholder_setup_owner",
        shareholder_setup_cancel_installment: "abos_v1_shareholder_setup_owner",
        shareholder_setup_record_agreement_evidence: "abos_v1_shareholder_setup_owner",
        shareholder_setup_workspace: "abos_v1_shareholder_setup_owner",
        // 0034: private agreement document authorization, immutable finalize and scoped reads.
        shareholder_agreement_document_prepare: "abos_v1_shareholder_setup_owner",
        shareholder_agreement_document_finalize: "abos_v1_shareholder_setup_owner",
        shareholder_agreement_document_read: "abos_v1_shareholder_setup_owner",
        shareholder_agreement_document_list: "abos_v1_shareholder_setup_owner",
        // 0035: contribution declarations (no financial effect).
        shareholder_contribution_create: "abos_v1_shareholder_setup_owner",
        shareholder_contribution_update: "abos_v1_shareholder_setup_owner",
        shareholder_contribution_declare: "abos_v1_shareholder_setup_owner",
        shareholder_contribution_cancel: "abos_v1_shareholder_setup_owner",
        shareholder_contributions_workspace: "abos_v1_shareholder_setup_owner",
        // WP #17 (0023): reversal requests (request -> Finance Manager decision; posting fail-closed).
        finance_reversal_requests_view: "abos_e1_finance_owner", finance_reversal_request_create: "abos_e1_finance_owner",
        finance_reversal_request_decide: "abos_e1_finance_owner", finance_reversal_request_withdraw: "abos_e1_finance_owner"
      };
      assert.deepEqual(Object.fromEntries(rows.rows.map((fn) => [fn.name, fn.owner])), expectedOwner);
    });

    test("owners own no table, hold no destructive privilege, and cannot write outside their remit", async () => {
      const owned = await harness.executor.query<{ relname: string }>(
        `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_roles r ON r.oid = c.relowner
          WHERE n.nspname = 'abos' AND r.rolname = ANY($1::text[])`, [OWNERS]);
      assert.deepEqual(owned.rows, []);
      const destructive = await harness.executor.query<{ grantee: string; table_name: string; privilege_type: string }>(
        `SELECT grantee, table_name, privilege_type FROM information_schema.role_table_grants
          WHERE table_schema = 'abos' AND grantee = ANY($1::text[])
            AND privilege_type IN ('DELETE', 'TRUNCATE', 'TRIGGER', 'REFERENCES')`, [OWNERS]);
      assert.deepEqual(destructive.rows, []);
      const can = async (role: string, table: string, privilege: string) => (await harness.executor.query<{ ok: boolean }>(
        "SELECT has_table_privilege($1, $2, $3) AS ok", [role, `abos.${table}`, privilege])).rows[0]?.ok;
      for (const ledger of ["journals", "journal_lines", "posting_intents", "posting_approvals", "subledger_entries", "audit_records"]) {
        assert.equal(await can("abos_e1_treasury_owner", ledger, "INSERT"), false, `Treasury cannot insert ${ledger}`);
      }
      for (const custody of ["cash_receipts", "physical_cash_counts", "cash_locations", "treasury_finance_handoffs"]) {
        assert.equal(await can("abos_e1_finance_owner", custody, "INSERT"), false, `Finance cannot insert ${custody}`);
      }
      for (const table of ["journals", "journal_lines", "posting_intents", "posting_approvals", "cash_receipts", "physical_cash_counts",
        "cash_locations", "treasury_finance_handoffs", "exchange_rates", "capital_agreements", "capital_installments"]) {
        assert.equal(await can("abos_e1_shareholder_owner", table, "INSERT"), false, `Shareholder owner cannot insert ${table}`);
      }
      for (const table of ["journals", "journal_lines", "posting_intents", "posting_approvals", "subledger_entries", "cash_receipts",
        "physical_cash_counts", "treasury_finance_handoffs", "capital_receipt_intents", "registration_evidence",
        "capital_agreement_funding_policies", "exchange_rates"]) {
        assert.equal(await can("abos_v1_shareholder_setup_owner", table, "INSERT"), false, `Shareholder setup cannot insert ${table}`);
      }
      for (const identity of ["user_credentials", "access_roles", "user_role_assignments", "login_attempts"]) {
        for (const owner of OWNERS) assert.equal(await can(owner, identity, "SELECT"), false, `${owner} cannot read ${identity}`);
      }
      const memberships = await harness.executor.query<{ member: string; role: string }>(
        `SELECT m.rolname AS member, g.rolname AS role FROM pg_auth_members a
           JOIN pg_roles m ON m.oid = a.member JOIN pg_roles g ON g.oid = a.roleid
          WHERE g.rolname = ANY($1::text[]) OR m.rolname = ANY($1::text[])`, [OWNERS]);
      assert.deepEqual(memberships.rows, [], "nobody can SET ROLE to an owner, and owners inherit nothing");
    });

    test("lock-only tables have two layers: column privileges and a trigger that refuses any change", async () => {
      const world = await seedSyntheticWorld(harness.executor);
      // Layer 1: only the key column is granted, so a real change is refused by privilege (42501).
      await refused("abos_e1_finance_owner", "UPDATE abos.user_permission_grants SET granted_at = granted_at", /permission denied for table user_permission_grants/);
      await refused("abos_e1_treasury_owner", "UPDATE abos.user_permission_grants SET revoked_at = NULL", /permission denied for table user_permission_grants/);
      await refused("abos_e1_finance_owner", "UPDATE abos.user_accounts SET status = 'ACTIVE'", /permission denied for table user_accounts/);
      await refused("abos_e1_finance_owner", "UPDATE abos.cash_receipts SET status = 'VOIDED'", /permission denied for table cash_receipts/);
      await refused("abos_e1_treasury_owner", "UPDATE abos.sandbox_sessions SET expires_at = expires_at", /permission denied for table sandbox_sessions/);
      // Layer 2: even the granted key column cannot be written; the trigger refuses it.
      await refused("abos_e1_finance_owner", `UPDATE abos.user_permission_grants SET user_account_id = user_account_id WHERE user_account_id = '${world.approverId}'`,
        /abos_e1_finance_owner may lock but not change user_permission_grants/);
      await refused("abos_e1_treasury_owner", "UPDATE abos.user_accounts SET id = id", /abos_e1_treasury_owner may lock but not change user_accounts/);
      await refused("abos_e1_finance_owner", `INSERT INTO abos.posting_approvals (id) VALUES (gen_random_uuid())
        ON CONFLICT (id) DO UPDATE SET decision = 'APPROVED'`, /permission denied|null value|violates/);
      // No destructive or structural power.
      await refused("abos_e1_finance_owner", "ALTER TABLE abos.journals DISABLE TRIGGER ALL", /must be owner of table journals/);
      await refused("abos_e1_finance_owner", "DELETE FROM abos.journals", /permission denied for table journals/);
      await refused("abos_e1_treasury_owner", "SELECT * FROM abos.user_credentials", /permission denied for table user_credentials/);
      await refused("abos_e1_treasury_owner", "CREATE TEMPORARY TABLE shadow (id int)", /permission denied to create temporary tables/);
    });

    test("catalogue-driven authorizers still refuse unknown, unavailable and cross-category permissions (0013)", async () => {
      const token = "t".repeat(43);
      for (const [role, call, message] of [
        ["abos_e1_finance_owner", "SELECT abos.finance_runtime_authorize($1, 'finance.journal.reverse')", /unsupported Finance permission/],
        ["abos_e1_finance_owner", "SELECT abos.finance_runtime_authorize($1, 'treasury.read')", /unsupported Finance permission/],
        ["abos_e1_finance_owner", "SELECT abos.finance_runtime_authorize($1, 'finance.everything')", /unsupported Finance permission/],
        ["abos_e1_treasury_owner", "SELECT abos.treasury_runtime_authorize($1, gen_random_uuid(), 'finance.journal.post')", /unsupported Treasury permission/],
        ["abos_e1_treasury_owner", "SELECT abos.treasury_runtime_authorize($1, gen_random_uuid(), 'admin.users.manage')", /unsupported Treasury permission/],
        ["abos_e1_finance_owner", "SELECT abos.finance_runtime_authorize($1, 'finance.report.operational.read')", /session is invalid/]
      ] as const) {
        await asRole(role, async (client) => {
          await assert.rejects(() => client.query(call, [token]), message, call);
        });
      }
    });

    test("runtimes can call only their entry points, never internal helpers, owners or tables", async () => {
      const token = "x".repeat(43);
      for (const [kind, call] of [
        ["finance", "SELECT abos.finance_runtime_authorize($1, 'finance.journal.post')"],
        ["treasury", "SELECT abos.treasury_runtime_authorize($1, gen_random_uuid(), 'treasury.read')"],
        ["finance", "SELECT abos.treasury_secure_context($1)"],
        ["treasury", "SELECT abos.finance_handoff_workspace($1)"],
        ["identity", "SELECT abos.finance_handoff_workspace($1)"],
        ["treasury", "SELECT abos.finance_general_ledger($1, DATE '2026-01-01', DATE '2026-12-31', NULL)"],
        ["identity", "SELECT abos.finance_general_ledger($1, DATE '2026-01-01', DATE '2026-12-31', NULL)"],
        ["treasury", "SELECT abos.user_holds_permission(gen_random_uuid(), gen_random_uuid(), 'treasury.read')"],
        ["treasury", "SELECT abos.treasury_actor()"],
        ["finance", "SELECT abos.is_assigned_cashier(gen_random_uuid(), gen_random_uuid())"],
        ["identity", "SELECT abos.assert_sandbox_mutation_authorized(gen_random_uuid())"],
        ["finance", "SELECT abos.check_super_admin_remains(gen_random_uuid())"],
        ["identity", "SELECT abos.require_treasury_permission(gen_random_uuid(), gen_random_uuid(), 'treasury.read', 'x')"],
        // WP-B (0015): the safes/Saraf entry points belong to the Treasury runtime only.
        ["finance", "SELECT abos.treasury_safes_saraf_query($1, gen_random_uuid(), 'SARAF_ACCOUNTS')"],
        ["identity", "SELECT abos.treasury_safes_saraf_command($1, gen_random_uuid(), 'RECORD_SAFE_COUNT', '{}'::jsonb)"]
      ] as const) {
        await assert.rejects(() => restricted(kind, (db) => db.query(call, call.includes("$1") ? [token] : [])),
          (error: unknown) => (error as { code?: string }).code === "42501" && /permission denied for function/.test(String(error)), `${kind}: ${call}`);
      }
      for (const kind of ["finance", "treasury", "identity"] as const) {
        await assert.rejects(() => restricted(kind, (db) => db.query("SET ROLE abos_e1_finance_owner")), /permission denied/);
        await assert.rejects(() => restricted(kind, (db) => db.query("INSERT INTO abos.journals (id) VALUES (gen_random_uuid())")), /permission denied for table journals/);
        await assert.rejects(() => restricted(kind, (db) => db.query("CREATE TEMPORARY TABLE shadow (id int)")), /permission denied to create temporary tables/);
      }
    });

    test("posting still works end to end, a duplicate posting returns the same journal, and posted records cannot change", async () => {
      const prepared = await postingReady(harness);
      const operationalSession = await issueOperationalSession(
        harness, prepared.world.approverId, prepared.world.legalEntityId
      );
      const post = () => restricted("finance", (db) => new RestrictedCapitalPostingGateway(db).post({
        bearerToken: prepared.token, postingIntentId: prepared.postingIntentId as PostingIntentId,
        accountingPeriodId: prepared.world.accountingPeriodId as never
      }));
      const first = await post();
      const second = await post();
      assert.equal(second, first, "an authenticated duplicate returns the same journal");
      const counts = await harness.executor.query<{ journals: string; lines: string }>(
        "SELECT (SELECT count(*) FROM abos.journals)::text AS journals, (SELECT count(*) FROM abos.journal_lines)::text AS lines");
      assert.deepEqual(counts.rows[0], { journals: "1", lines: "2" });

      const ledger = await restricted("finance", async (db) => (await db.query<{
        readonly value: {
          readonly syntheticOnly: boolean;
          readonly lines: readonly {
            readonly journalId: string; readonly accountId: string;
            readonly baseCurrency: string; readonly baseDebit: string; readonly baseCredit: string;
          }[];
          readonly totals: readonly { readonly currency: string; readonly debits: string; readonly credits: string; readonly lineCount: string }[];
          readonly returnedLineCount: number; readonly hasMore: boolean;
        };
      }>(
        "SELECT abos.finance_general_ledger($1, DATE '2026-01-01', DATE '2026-12-31', NULL) AS value",
        [operationalSession.token]
      )).rows[0]?.value);
      assert.equal(ledger?.syntheticOnly, false);
      assert.equal(ledger.returnedLineCount, 2);
      assert.equal(ledger.hasMore, false);
      assert.equal(new Set(ledger.lines.map((line) => line.journalId)).size, 1);
      assert.ok(ledger.lines.every((line) => line.baseCurrency === "USD"));
      assert.deepEqual(ledger.totals, [{
        currency: "USD", debits: prepared.world.installmentAmount,
        credits: prepared.world.installmentAmount, lineCount: "2"
      }]);
      assert.ok(ledger.lines.some((line) => line.baseDebit === prepared.world.installmentAmount && Number(line.baseCredit) === 0));
      assert.ok(ledger.lines.some((line) => Number(line.baseDebit) === 0 && line.baseCredit === prepared.world.installmentAmount));

      const cashAccount = await restricted("finance", async (db) => (await db.query<{ readonly value: { readonly returnedLineCount: number; readonly lines: readonly { readonly accountId: string }[] } }>(
        "SELECT abos.finance_general_ledger($1, DATE '2026-01-01', DATE '2026-12-31', $2) AS value",
        [operationalSession.token, prepared.world.cashLedgerAccountId]
      )).rows[0]?.value);
      assert.equal(cashAccount?.returnedLineCount, 1);
      assert.equal(cashAccount?.lines[0]?.accountId, prepared.world.cashLedgerAccountId);
      await assert.rejects(
        () => restricted("finance", (db) => db.query(
          "SELECT abos.finance_general_ledger($1, DATE '2026-01-01', DATE '2026-12-31', NULL)",
          ["invalid-finance-token"]
        )),
        /session is invalid|authentication|token|bearer credential/i
      );

      // Scope isolation is conjunctive: a dimensioned line remains hidden until the actor holds
      // every applicable live scope. The privileged fixture update is test-only and bypasses the
      // posted-line immutability trigger solely to exercise the read model.
      const projectId = randomUUID();
      const departmentId = randomUUID();
      const costCenterId = randomUUID();
      await harness.executor.query(
        "INSERT INTO abos.projects (id, legal_entity_id, code, name, active) VALUES ($1,$2,'GL-P','GL Project',true)",
        [projectId, prepared.world.legalEntityId]
      );
      await harness.executor.query(
        "INSERT INTO abos.departments (id, legal_entity_id, code, name, active) VALUES ($1,$2,'GL-D','GL Department',true)",
        [departmentId, prepared.world.legalEntityId]
      );
      await harness.executor.query(
        "INSERT INTO abos.cost_centers (id, legal_entity_id, code, name, active) VALUES ($1,$2,'GL-C','GL Cost Center',true)",
        [costCenterId, prepared.world.legalEntityId]
      );
      await harness.executor.transaction(async (tx) => {
        await tx.query("SET LOCAL session_replication_role = replica");
        await tx.query(
          "UPDATE abos.journal_lines SET project_id=$2, department_id=$3, cost_center_id=$4 WHERE journal_id=$1",
          [first, projectId, departmentId, costCenterId]
        );
      });
      const scopedCount = async () => restricted("finance", async (db) => (await db.query<{
        readonly value: { readonly returnedLineCount: number };
      }>("SELECT abos.finance_general_ledger($1, DATE '2026-01-01', DATE '2026-12-31', NULL) AS value", [operationalSession.token])).rows[0]?.value.returnedLineCount);
      assert.equal(await scopedCount(), 0, "dimensioned lines are hidden without scope grants");
      for (const [kind, scopeId] of [
        ["PROJECT", projectId], ["DEPARTMENT", departmentId], ["COST_CENTER", costCenterId]
      ] as const) {
        await harness.executor.query(
          `INSERT INTO abos.user_scope_grants
             (user_account_id, legal_entity_id, scope_kind, scope_id, granted_by_user_account_id)
           VALUES ($1,$2,$3,$4,$5)`,
          [prepared.world.approverId, prepared.world.legalEntityId, kind, scopeId, prepared.world.bootstrapUserId]
        );
      }
      assert.equal(await scopedCount(), 2, "all applicable live scope grants reveal the lines");
      await harness.executor.query(
        `UPDATE abos.user_scope_grants SET revoked_at=clock_timestamp()
          WHERE user_account_id=$1 AND legal_entity_id=$2 AND scope_kind='DEPARTMENT' AND scope_id=$3`,
        [prepared.world.approverId, prepared.world.legalEntityId, departmentId]
      );
      assert.equal(await scopedCount(), 0, "revoking one applicable scope hides the lines immediately");

      // Even the Finance owner, which wrote the journal, cannot alter it now that it is posted.
      await asRole("abos_e1_finance_owner", async (client) => {
        await assert.rejects(() => client.query("UPDATE abos.journals SET journal_reference = 'CHANGED' WHERE id = $1", [first]), /posted|immutable|permission/i);
      });
      await asRole("abos_e1_finance_owner", async (client) => {
        await assert.rejects(() => client.query("UPDATE abos.journal_lines SET amount = amount + 1 WHERE journal_id = $1", [first]), /posted|immutable|permission|column/i);
      });
      await asRole("abos_e1_treasury_owner", async (client) => {
        await assert.rejects(() => client.query("UPDATE abos.journals SET status = 'DRAFT' WHERE id = $1", [first]), /permission denied/);
      });
    });

    test("0032 separates operational setup and reporting while legacy capital money paths stay sandbox-gated", async () => {
      const prepared = await postingReady(harness);
      for (const permission of [
        "finance.ledger-account.manage", "finance.calendar.manage",
        "finance.exchange-rate.record", "finance.reversal.request",
        "shareholder.capital-request.create"
      ]) {
        await harness.executor.query(
          `INSERT INTO abos.user_permission_grants
             (user_account_id, legal_entity_id, permission_code, granted_by_user_account_id)
           VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
          [prepared.world.approverId, prepared.world.legalEntityId, permission, prepared.world.bootstrapUserId]
        );
      }
      await harness.executor.query(
        `INSERT INTO abos.user_permission_grants
           (user_account_id, legal_entity_id, permission_code, granted_by_user_account_id)
         VALUES ($1,$2,'finance.reversal.request',$3) ON CONFLICT DO NOTHING`,
        [prepared.world.treasuryManagerId, prepared.world.legalEntityId, prepared.world.bootstrapUserId]
      );
      const authenticator = new SandboxAuthenticator(harness.executor, SYNTHETIC_AUTH_CONFIGURATION);
      const managerSession = await issueOperationalSession(
        harness, prepared.world.treasuryManagerId, prepared.world.legalEntityId
      );
      const financeSession = await issueOperationalSession(
        harness, prepared.world.approverId, prepared.world.legalEntityId
      );
      const shareholderOperationalSession = await issueOperationalSession(
        harness, prepared.world.intentCreatorId, prepared.world.legalEntityId
      );
      const shareholderSession = await authenticator.issueSession({
        userAccountId: prepared.world.approverId as UserAccountId,
        legalEntityId: prepared.world.legalEntityId as LegalEntityId
      });
      await restricted("finance", (db) => new RestrictedCapitalPostingGateway(db).post({
        bearerToken: prepared.token, postingIntentId: prepared.postingIntentId as PostingIntentId,
        accountingPeriodId: prepared.world.accountingPeriodId as AccountingPeriodId
      }));
      const journalId = (await harness.executor.query<{ id: string }>(
        "SELECT id FROM abos.journals WHERE posting_intent_id = $1",
        [prepared.postingIntentId]
      )).rows[0]?.id;
      assert.ok(journalId);

      // This models the real-entity state requested for the slice.  Sessions and RBAC remain;
      // only the SYNTHETIC_TEST_ONLY authorization is absent.
      await harness.executor.query("DELETE FROM abos.sandbox_authorizations");

      await assert.rejects(() => authenticator.issueSession({
        userAccountId: prepared.world.approverId as UserAccountId,
        legalEntityId: prepared.world.legalEntityId as LegalEntityId
      }), /no sandbox authorization/i, "developer-token sign-in fails when the sandbox gate is absent");

      await assert.rejects(
        () => restricted("finance", (db) => db.query(
          "SELECT abos.finance_ledger_accounts_view($1)", [shareholderSession.token]
        )),
        /operational password session is required/,
        "a synthetic developer session cannot enter an operational Finance function"
      );
      await assert.rejects(
        () => restricted("treasury", (db) => db.query(
          "SELECT abos.treasury_secure_context($1)", [shareholderSession.token]
        )),
        /sandbox session is invalid/,
        "a synthetic developer session cannot enter the operational Treasury context"
      );

      const ledger = await restricted("finance", async (db) => (await db.query<{
        value: { returnedLineCount: number };
      }>(
        "SELECT abos.finance_general_ledger($1, DATE '2026-01-01', DATE '2026-12-31', NULL) AS value",
        [financeSession.token]
      )).rows[0]?.value);
      assert.equal(ledger?.returnedLineCount, 2, "posted GL reporting is operational without the sandbox row");

      const accounts = await restricted("finance", async (db) => (await db.query<{ value: { accounts: unknown[] } }>(
        "SELECT abos.finance_ledger_accounts_view($1) AS value", [financeSession.token]
      )).rows[0]?.value);
      assert.ok((accounts?.accounts.length ?? 0) >= 2);
      await restricted("finance", (db) => db.query(
        "SELECT abos.finance_ledger_account_create($1,$2::jsonb,false)",
        [financeSession.token, JSON.stringify({
          code: `OPS-${randomUUID().slice(0, 8)}`, name: "Operational gate test account",
          type: "ASSET", currency: "USD", postingAllowed: true
        })]
      ));

      await restricted("finance", (db) => db.query(
        "SELECT abos.finance_calendar_view($1)", [financeSession.token]
      ));
      await restricted("finance", (db) => db.query(
        "SELECT abos.finance_calendar_configure($1,'GREGORIAN',NULL,NULL,ARRAY['GREGORIAN'],0)",
        [financeSession.token]
      ));
      await restricted("finance", (db) => db.query(
        "SELECT abos.finance_record_exchange_rate($1,DATE '2026-09-30','MARKET',NULL,'USD','AFN','71.25','Operational gate proof')",
        [financeSession.token]
      ));
      await assert.rejects(
        () => restricted("finance", (db) => db.query(
          "SELECT abos.finance_reversal_request_create($1,$2,'Reversal policy remains fail closed')",
          [managerSession.token, journalId]
        )),
        /synthetic Finance sandbox authorization is not active/,
        "reversal requests remain on the legacy gate until the unresolved reversal policy is approved"
      );

      const context = await restricted("treasury", async (db) => (await db.query<{ value: { legalEntityId: string; syntheticAuthorized: boolean } }>(
        "SELECT abos.treasury_secure_context($1) AS value", [managerSession.token]
      )).rows[0]?.value);
      assert.ok(context);
      assert.equal(context?.legalEntityId, prepared.world.legalEntityId);
      assert.equal(context.syntheticAuthorized, false);
      await assert.rejects(() => restricted("treasury", (db) => db.query(
        "SELECT abos.treasury_synthetic_signin_context($1)", [managerSession.token]
      )), /sandbox session is invalid/);
      for (const query of ["SOURCES", "RECEIPTS", "COUNTS", "HANDOFFS", "FINANCE_PROGRESS", "EVIDENCE", "EVENTS"]) {
        await assert.rejects(() => restricted("treasury", (db) => db.query(
          "SELECT abos.treasury_secure_query($1,$2,$3,NULL)",
          [managerSession.token, prepared.world.legalEntityId, query]
        )), /synthetic Treasury sandbox authorization is not active/, query);
      }
      const locationId = randomUUID();
      const accountId = randomUUID();
      await restricted("treasury", (db) => db.query(
        "SELECT abos.treasury_secure_command($1,$2,'CREATE_LOCATION',$3::jsonb)",
        [managerSession.token, prepared.world.legalEntityId, JSON.stringify({
          id: locationId, name: "Operational gate safe",
          responsibleCashierUserAccountId: prepared.world.cashierId
        })]
      ));
      await restricted("treasury", (db) => db.query(
        "SELECT abos.treasury_secure_command($1,$2,'OPEN_ACCOUNT',$3::jsonb)",
        [managerSession.token, prepared.world.legalEntityId, JSON.stringify({
          id: accountId, cashLocationId: locationId, currency: "USD",
          ledgerAccountId: prepared.world.cashLedgerAccountId
        })]
      ));
      const locations = await restricted("treasury", async (db) => (await db.query<{ value: { id: string }[] }>(
        "SELECT abos.treasury_secure_query($1,$2,'LOCATIONS',NULL) AS value",
        [managerSession.token, prepared.world.legalEntityId]
      )).rows[0]?.value ?? []);
      assert.ok(locations.some((location) => location.id === locationId));

      await harness.executor.query(
        `INSERT INTO abos.user_permission_grants
           (user_account_id,legal_entity_id,permission_code,granted_by_user_account_id)
         VALUES ($1,$2,'treasury.saraf-account.manage',$3) ON CONFLICT DO NOTHING`,
        [prepared.world.treasuryManagerId, prepared.world.legalEntityId, prepared.world.bootstrapUserId]
      );
      for (const query of ["SARAF_ACCOUNTS", "CASH_LEDGER_CHOICES", "SARAF_LEDGER_CHOICES", "SARAF_PARTIES"]) {
        await restricted("treasury", (db) => db.query(
          "SELECT abos.treasury_safes_saraf_query($1,$2,$3,NULL)",
          [managerSession.token, prepared.world.legalEntityId, query]
        ));
      }
      for (const query of ["SAFE_COUNTS", "COUNT_EVIDENCE"]) {
        await assert.rejects(() => restricted("treasury", (db) => db.query(
          "SELECT abos.treasury_safes_saraf_query($1,$2,$3,NULL)",
          [managerSession.token, prepared.world.legalEntityId, query]
        )), /synthetic Treasury sandbox authorization is not active/, query);
      }
      for (const operation of ["RECORD_SAFE_COUNT", "CONFIRM_SAFE_COUNT"]) {
        await assert.rejects(() => restricted("treasury", (db) => db.query(
          "SELECT abos.treasury_safes_saraf_command($1,$2,$3,$4::jsonb)",
          [managerSession.token, prepared.world.legalEntityId, operation, JSON.stringify({ id: randomUUID() })]
        )), /synthetic Treasury sandbox authorization is not active/, operation);
      }
      const sarafParty = await addSyntheticSaraf(harness.executor, prepared.world);
      const sarafLedger = randomUUID();
      await harness.executor.query(
        `INSERT INTO abos.ledger_accounts
           (id, legal_entity_id, account_code, account_name, account_type, control_account_type,
            posting_allowed, account_currency_code, status)
         VALUES ($1,$2,'SYN-SARAF-GATE','Synthetic gate Saraf','ASSET','SARAF',true,'USD','ACTIVE')`,
        [sarafLedger, prepared.world.legalEntityId]
      );
      await restricted("treasury", (db) => db.query(
        "SELECT abos.treasury_safes_saraf_command($1,$2,'CREATE_SARAF_ACCOUNT',$3::jsonb)",
        [managerSession.token, prepared.world.legalEntityId, JSON.stringify({
          id: randomUUID(), businessPartyId: sarafParty, currency: "USD", ledgerAccountId: sarafLedger
        })]
      ));
      await restricted("finance", (db) => db.query(
        "SELECT abos.finance_exchange_rates_view($1,NULL,NULL)", [financeSession.token]
      ));
      for (const fn of ["finance_general_ledger_activity", "finance_general_ledger_page"]) {
        await restricted("finance", (db) => db.query(
          `SELECT abos.${fn}($1, DATE '2026-01-01', DATE '2026-12-31', NULL)`, [financeSession.token]
        ));
      }
      for (const operation of ["VOID_RECEIPT", "COUNT_RECEIPT", "VERIFY_RECEIPT", "HANDOFF_RECEIPT",
        "RECORD_COUNT", "RECONCILE_OPENING", "APPROVE_OPENING", "ACTIVATE_ACCOUNT"]) {
        await assert.rejects(() => restricted("treasury", (db) => db.query(
          "SELECT abos.treasury_secure_command($1,$2,$3,$4::jsonb)",
          [managerSession.token, prepared.world.legalEntityId, operation, JSON.stringify({ id: randomUUID(), purpose: "RECEIPT" })]
        )), /synthetic Treasury sandbox authorization is not active/, operation);
      }
      await assert.rejects(() => restricted("finance", (db) => db.query(
        "SELECT abos.finance_handoff_workspace($1)", [financeSession.token]
      )), /synthetic Finance sandbox authorization is not active/);
      await assert.rejects(() => restricted("finance", (db) => db.query(
        "SELECT abos.finance_handoff_trace($1,$2)", [financeSession.token, randomUUID()]
      )), /synthetic Finance sandbox authorization is not active/);
      await assert.rejects(() => restricted("treasury", (db) => db.query(
        "SELECT abos.treasury_secure_command($1,$2,'CREATE_LOCATION',$3::jsonb)",
        [managerSession.token, randomUUID(), JSON.stringify({ id: randomUUID() })]
      )), /out of scope/);
      await assert.rejects(() => restricted("finance", (db) => db.query(
        "SELECT abos.finance_ledger_accounts_view($1)", [managerSession.token]
      )), /current authority is missing/);
      for (const role of ["finance", "treasury"] as const) {
        await assert.rejects(() => restricted(role, (db) => db.query(
          "SELECT abos.operational_bearer_context($1,NULL)", [managerSession.token]
        )), /permission denied/);
      }
      await harness.executor.query(
        "UPDATE abos.user_credentials SET must_change_password=true WHERE user_account_id=$1",
        [prepared.world.approverId]
      );
      await assert.rejects(() => restricted("finance", (db) => db.query(
        "SELECT abos.finance_ledger_accounts_view($1)", [financeSession.token]
      )), /change the temporary password/);
      await harness.executor.query(
        "UPDATE abos.user_credentials SET must_change_password=false WHERE user_account_id=$1",
        [prepared.world.approverId]
      );
      assert.equal((await harness.executor.query<{ count: string }>("SELECT count(*)::text AS count FROM abos.journals")).rows[0]?.count, "1",
        "setup/read attempts add no journals");

      await assert.rejects(
        () => restricted("treasury", (db) => db.query(
          "SELECT abos.treasury_secure_command($1,$2,'RECORD_RECEIPT',$3::jsonb)",
          [managerSession.token, prepared.world.legalEntityId, JSON.stringify({
            id: randomUUID(), capitalReceiptIntentId: randomUUID(),
            receiptReference: "BLOCKED", businessEventAt: "2026-09-30T08:00:00Z"
          })]
        )),
        /synthetic Treasury sandbox authorization is not active/
      );
      await assert.rejects(
        () => restricted("finance", (db) => db.query(
          "SELECT abos.finance_prepare_capital_posting($1,$2,$3,$4)",
          [financeSession.token, randomUUID(), prepared.world.accountingPeriodId, `blocked-${randomUUID()}`]
        )),
        /synthetic Finance sandbox authorization is not active/
      );
      await assert.rejects(
        () => restricted("finance", (db) => db.query(
          "SELECT abos.post_synthetic_capital_receipt($1,$2,$3)",
          [financeSession.token, prepared.postingIntentId, prepared.world.accountingPeriodId]
        )),
        /synthetic sandbox authorization is not active/
      );
      await assert.rejects(
        () => restricted("finance", (db) => db.query(
          "SELECT abos.shareholder_create_capital_request($1,$2,$3,'1',DATE '2026-09-30',NULL,$4)",
          [shareholderOperationalSession.token, prepared.world.installmentId,
            prepared.world.cashAccountId, `blocked-${randomUUID()}`]
        )),
        /synthetic Shareholder sandbox authorization is not active/
      );
    });

    test("a session is refused in another legal entity, even by the functions' own owners' code", async () => {
      const prepared = await postingReady(harness);
      const other = randomUUID();
      await assert.rejects(() => restricted("treasury", (db) => db.query(
        "SELECT abos.treasury_secure_query($1, $2, 'RECEIPTS', NULL)", [prepared.treasuryToken, other])), /out of scope|not active|invalid/i);
    });
  });
}

// -----------------------------------------------------------------------------------------------

function loginUrl(kind: keyof typeof LOGINS): string {
  const url = new URL(databaseUrl() ?? "");
  url.username = LOGINS[kind].name; url.password = LOGINS[kind].password;
  return url.toString();
}

async function ensureLogin(harness: Harness, login: (typeof LOGINS)[keyof typeof LOGINS]): Promise<void> {
  const exists = await harness.executor.query<{ exists: boolean }>("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists", [login.name]);
  const verb = exists.rows[0]?.exists === true ? "ALTER" : "CREATE";
  const extra = verb === "CREATE" ? " NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION" : "";
  await harness.executor.query(`${verb} ROLE ${login.name} LOGIN INHERIT${extra} PASSWORD '${login.password}'`);
  await harness.executor.query(`GRANT ${login.role} TO ${login.name}`);
}

async function restricted<T>(kind: keyof typeof LOGINS, operation: (db: SqlExecutor) => Promise<T>): Promise<T> {
  const pool = new pg.Pool({ connectionString: loginUrl(kind), max: 1 });
  try {
    return await operation(new PostgresExecutor(pool, { runtimeMarker: MARKER }));
  } finally {
    await pool.end();
  }
}

/** The statement, run as the owner role, is refused with SQLSTATE 42501 and the given message. */
async function refused(role: string, sql: string, message: RegExp): Promise<void> {
  await asRole(role, async (client) => {
    await assert.rejects(() => client.query(sql), (error: unknown) => {
      const code = (error as { code?: string }).code;
      assert.ok(message.test(String(error)), `${role}: ${sql} -> ${String(error)}`);
      assert.ok(code === "42501" || /null value|violates/.test(String(error)), `${role}: ${sql} -> SQLSTATE ${code}`);
      return true;
    });
  });
}

/** Runs as an owner role (via the test superuser) inside a transaction that is always rolled back. */
async function asRole(role: string, work: (client: pg.PoolClient) => Promise<void>): Promise<void> {
  const pool = new pg.Pool({ connectionString: databaseUrl(), max: 1 });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL ROLE ${role}`);
    // Present the sandbox marker, so a refusal comes from the rule under test and not the gate.
    await client.query("SELECT set_config('abos.runtime_marker', $1, true)", [MARKER]);
    await client.query("SAVEPOINT attempt");
    try { await work(client); } finally { await client.query("ROLLBACK"); }
  } finally {
    client.release();
    await pool.end();
  }
}

async function postingReady(harness: Harness): Promise<{ world: SyntheticWorld; token: string; treasuryToken: string; postingIntentId: string }> {
  await resetSchema(harness.pool);
  const world = await seedSyntheticWorld(harness.executor);
  const authenticator = new SandboxAuthenticator(harness.executor, SYNTHETIC_AUTH_CONFIGURATION);
  const session = await authenticator.issueSession({ userAccountId: world.approverId as UserAccountId, legalEntityId: world.legalEntityId as LegalEntityId });
  const cashier = await authenticator.issueSession({ userAccountId: world.cashierId as UserAccountId, legalEntityId: world.legalEntityId as LegalEntityId });
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
    source: { legalEntityId: world.legalEntityId as LegalEntityId, idempotencyKey: `ownership-${randomUUID()}` as IdempotencyKey, correlationId: randomUUID() as CorrelationId },
    evidence: [{ id: row.id as never, documentId: row.document_id as never, kind: row.evidence_kind, version: row.evidence_version, sha256: row.sha256, completedAt: new Date(row.completed_at).toISOString() }]
  });
  const receipt = await recordSyntheticTreasuryReceipt(harness.executor, world, { capitalReceiptIntentId: intent.id, amount: world.installmentAmount });
  await handOffSyntheticReceipt(harness.executor, world, receipt.cashReceiptId);
  const postingIntentId = await recordCapitalPostingIntent(harness.executor, world, {
    capitalReceiptIntentId: intent.id, cashReceiptId: receipt.cashReceiptId, amount: world.installmentAmount,
    idempotencyKey: `ownership-post-${randomUUID()}`, correlationId: randomUUID()
  });
  return { world, token: session.token, treasuryToken: cashier.token, postingIntentId };
}
