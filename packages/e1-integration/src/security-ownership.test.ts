import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before, describe } from "node:test";
import pg from "pg";
import type {
  CapitalAgreementId, CapitalInstallmentId, CashLocationCurrencyAccountId, CorrelationId, EvidenceReference,
  IdempotencyKey, LegalEntityId, PostingIntentId, UserAccountId
} from "@abos/contracts";
import { asDecimalString } from "@abos/contracts";
import type { SqlExecutor } from "@abos/database";
import { PostgresExecutor, PostgresShareholderRepository, RestrictedCapitalPostingGateway } from "@abos/persistence";
import { SandboxAuthenticator } from "@abos/sandbox-auth";
import { CapitalReceiptIntentService } from "@abos/shareholder";
import { databaseUrl, MISSING_DATABASE_MESSAGE, openHarness, resetSchema, type Harness } from "./harness.ts";
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
const OWNERS = ["abos_e1_treasury_owner", "abos_e1_finance_owner"] as const;
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
      assert.equal(rows.rows.length, 15, "every restricted entry point is accounted for (12 E1 + 3 calendar)");
      for (const fn of rows.rows) {
        assert.ok((OWNERS as readonly string[]).includes(fn.owner), `${fn.signature} is owned by ${fn.owner}`);
        assert.equal(fn.superuser, false, fn.signature);
        assert.equal(fn.bypassrls, false, fn.signature);
        assert.equal(fn.createrole, false, fn.signature);
        assert.equal(fn.can_login, false, fn.signature);
        assert.deepEqual(fn.config, ["search_path=pg_catalog, pg_temp"], `${fn.signature} pins its search path`);
        assert.equal(fn.public_execute, false, `${fn.signature} is not executable by PUBLIC`);
      }
      const expectedOwner: Record<string, string> = {
        treasury_runtime_authorize: "abos_e1_treasury_owner", treasury_secure_context: "abos_e1_treasury_owner",
        treasury_secure_query: "abos_e1_treasury_owner", treasury_secure_command: "abos_e1_treasury_owner",
        treasury_revoke_own_session: "abos_e1_treasury_owner",
        finance_runtime_authorize: "abos_e1_finance_owner", finance_handoff_workspace: "abos_e1_finance_owner",
        finance_handoff_trace: "abos_e1_finance_owner", finance_prepare_capital_posting: "abos_e1_finance_owner",
        finance_approve_capital_posting: "abos_e1_finance_owner", post_synthetic_capital_receipt: "abos_e1_finance_owner",
        require_posted_reversal_link: "abos_e1_finance_owner", finance_calendar_view: "abos_e1_finance_owner",
        finance_calendar_configure: "abos_e1_finance_owner", finance_generate_fiscal_year: "abos_e1_finance_owner"
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
        ["treasury", "SELECT abos.user_holds_permission(gen_random_uuid(), gen_random_uuid(), 'treasury.read')"],
        ["treasury", "SELECT abos.treasury_actor()"],
        ["finance", "SELECT abos.is_assigned_cashier(gen_random_uuid(), gen_random_uuid())"],
        ["identity", "SELECT abos.assert_sandbox_mutation_authorized(gen_random_uuid())"],
        ["finance", "SELECT abos.check_super_admin_remains(gen_random_uuid())"],
        ["identity", "SELECT abos.require_treasury_permission(gen_random_uuid(), gen_random_uuid(), 'treasury.read', 'x')"]
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
