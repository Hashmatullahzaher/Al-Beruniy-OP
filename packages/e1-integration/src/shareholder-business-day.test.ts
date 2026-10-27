import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import test, { after, before, describe } from "node:test";
import pg from "pg";

import { applyMigrations, type SqlExecutor } from "@abos/database";
import { PostgresExecutor } from "@abos/persistence";
import { identityDatabaseProof } from "@abos/sandbox-auth";

import { grant } from "./currency-fixtures.ts";
import { databaseUrl, loadMigrations, MISSING_DATABASE_MESSAGE, openHarness, resetSchema, withClusterLock, type Harness } from "./harness.ts";
import { issueOperationalSession } from "./operational-session.ts";
import { seedSyntheticWorld, SYNTHETIC_AUTH_CONFIGURATION, type SyntheticWorld } from "./synthetic-world.ts";

/**
 * Migration 0042: the shareholder setup lane judges "today" on the Kabul business day
 * (abos.business_today()), never on PostgreSQL's current_date, which follows the session's time zone
 * (UTC on the production database). Between 00:00 and 04:30 Kabul time the two differ by a day, and a
 * shareholder dated "today" was refused as "in the future" while the money arriving that day was
 * accepted.
 *
 * The boundary is reproduced deterministically by giving the restricted login a session time zone
 * whose calendar date differs from Kabul's: UTC-12 is a day behind Kabul until 16:30 Kabul time (the
 * production direction), UTC+14 a day ahead from 14:30. At any moment at least one of them differs,
 * and the suite asserts that it really exercised a differing date.
 */

const MARKER = SYNTHETIC_AUTH_CONFIGURATION.runtimeMarker;
const MIGRATION = "0042_v1_shareholder_business_day";
const PREDECESSOR = "0041_v1_retire_synthetic_lane";
const PERMISSIONS = ["shareholder.setup.manage", "shareholder.read", "shareholder.capital-receipt.read",
  "shareholder.capital-receipt.record", "finance.capital-receipt.prepare", "finance.capital-receipt.post", "finance.report.operational.read"];
const ZONES = ["Etc/GMT+12", "Etc/GMT-14"] as const;
const RESTATED = [
  "shareholder_setup_create_shareholder(text,text,text,jsonb)",
  "shareholder_setup_record_agreement_evidence(text,text,text,jsonb)",
  "shareholder_agreement_document_finalize(text,text,text,jsonb)",
  "shareholder_contribution_fields(text,jsonb)",
  "shareholder_setup_workspace(text,text,text)",
  "shareholder_contributions_workspace(text,text,text)",
  "direct_shareholder_document_holder(text,text,text,jsonb)",
  "validate_shareholder_profile_role()"
] as const;

type Session = { proof: string; runtimeDigest: string; tokenDigest: string };
type Json = Record<string, unknown>;

if (databaseUrl() === undefined) {
  test("0042 shareholder business day", () => assert.fail(MISSING_DATABASE_MESSAGE));
} else {
  describe("0042: the shareholder setup lane uses the Kabul business day", () => {
    let h: Harness;
    const login = `abos_business_day_${randomUUID().replaceAll("-", "")}`;
    const password = `disposable-${randomUUID()}`;

    before(async () => {
      const target = new URL(databaseUrl() ?? "");
      assert.notEqual(target.port, "55432", "preserved runtime PostgreSQL is forbidden");
      assert.notEqual(decodeURIComponent(target.pathname.slice(1)), "abos_v1_local_review");
      h = await openHarness(MARKER);
      await resetSchema(h.pool);
      await h.pool.query(`CREATE ROLE ${login} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${password}'`);
      await h.pool.query(`GRANT abos_e1_runtime TO ${login}`);
    });
    after(async () => {
      if (h !== undefined) { await h.pool.query(`DROP ROLE IF EXISTS ${login}`); await h.close(); }
    });

    /** A restricted runtime connection whose session time zone is `zone`. */
    function runtimeIn(zone: string): { db: PostgresExecutor; close(): Promise<void> } {
      const url = new URL(databaseUrl() ?? ""); url.username = login; url.password = password;
      const pool = new pg.Pool({ connectionString: url.toString(), max: 2, options: `-c TimeZone=${zone}` });
      return { db: new PostgresExecutor(pool, { runtimeMarker: MARKER }), close: () => pool.end() };
    }
    async function fixture(): Promise<{ world: SyntheticWorld; actor: Session }> {
      await resetSchema(h.pool);
      await h.pool.query(`GRANT abos_e1_runtime TO ${login}`);
      const world = await seedSyntheticWorld(h.executor);
      await h.pool.query("DELETE FROM abos.sandbox_legal_entity_scopes");
      await h.pool.query("DELETE FROM abos.sandbox_authorizations");
      await grant(h.executor, world, world.intentCreatorId, PERMISSIONS);
      await h.pool.query(`INSERT INTO abos.operational_treasury_accounts
        (id,legal_entity_id,name_en,account_type,currency_code,ledger_account_id,status,version,
         created_by_user_account_id,last_changed_by_user_account_id)
        VALUES($1,$2,'Synthetic business-day Safe','SAFE','USD',$3,'ACTIVE',1,$4,$4)`,
      [randomUUID(), world.legalEntityId, world.cashLedgerAccountId, world.bootstrapUserId]);
      await h.pool.query(`INSERT INTO abos.finance_workflow_policy_versions
        (id,legal_entity_id,workflow_type,version,approval_required,configured_by_user_account_id,change_reason)
        VALUES($1,$2,'SHAREHOLDER_CAPITAL_RECEIPT',1,false,$3,'Synthetic business-day test policy')`,
      [randomUUID(), world.legalEntityId, world.bootstrapUserId]);
      const issued = await issueOperationalSession(h, world.intentCreatorId, world.legalEntityId);
      return { world, actor: {
        proof: identityDatabaseProof(SYNTHETIC_AUTH_CONFIGURATION.signingSecret),
        runtimeDigest: createHash("sha256").update(issued.token).digest("hex"),
        tokenDigest: createHmac("sha256", SYNTHETIC_AUTH_CONFIGURATION.signingSecret).update(issued.token).digest("hex")
      } };
    }
    async function call<T = Json>(db: SqlExecutor, fn: string, s: Session, payload?: Json): Promise<T> {
      const sql = payload === undefined ? `SELECT abos.${fn}($1,$2,$3) AS value` : `SELECT abos.${fn}($1,$2,$3,$4::jsonb) AS value`;
      const parameters = payload === undefined ? [s.proof, s.runtimeDigest, s.tokenDigest]
        : [s.proof, s.runtimeDigest, s.tokenDigest, JSON.stringify(payload)];
      const result = await db.query<{ value: T }>(sql, parameters);
      assert.ok(result.rows[0]); return result.rows[0].value;
    }
    const keys = () => ({ idempotencyKey: `business-day-${randomUUID()}`, correlationId: randomUUID() });
    /** The runtime session's own calendar date, and the Kabul business day (read by the operator: runtimes cannot call it). */
    async function days(db: SqlExecutor): Promise<{ session: string; kabul: string; plus: (n: number) => Promise<string> }> {
      const session = (await db.query<{ d: string }>("SELECT current_date::text AS d")).rows[0]?.d ?? "";
      const kabul = (await h.pool.query<{ d: string }>("SELECT abos.business_today()::text AS d")).rows[0]?.d ?? "";
      assert.ok(session && kabul);
      return { session, kabul,
        plus: async (n: number) => (await h.pool.query<{ d: string }>("SELECT (abos.business_today() + $1::int)::text AS d", [n])).rows[0]?.d ?? "" };
    }

    test("every rule and every 'today' of the shareholder setup lane follows the Kabul business day, whatever the session calendar", async () => {
      const { world, actor } = await fixture();
      let differing = 0;
      for (const zone of ZONES) {
        const runtime = runtimeIn(zone);
        try {
          const day = await days(runtime.db);
          if (day.session !== day.kabul) differing += 1;
          const tomorrow = await day.plus(1);
          const label = `${zone} (session date ${day.session}, Kabul ${day.kabul})`;

          // The workspaces report the business day, which the forms use as default and ceiling.
          assert.equal((await call<{ today: string }>(runtime.db, "shareholder_setup_workspace", actor)).today, day.kabul, `setup workspace today: ${label}`);
          assert.equal((await call<{ today: string }>(runtime.db, "shareholder_contributions_workspace", actor)).today, day.kabul, `contributions workspace today: ${label}`);

          // A shareholder dated the business day is accepted (setup lane and its role trigger); the next day is refused.
          const created = await call<{ shareholderProfileId: string }>(runtime.db, "shareholder_setup_create_shareholder", actor,
            { displayName: `Synthetic Business-Day Holder ${zone}`, shareholderSince: day.kabul, ...keys() });
          await assert.rejects(() => call(runtime.db, "shareholder_setup_create_shareholder", actor,
            { displayName: `Synthetic Future Holder ${zone}`, shareholderSince: tomorrow, ...keys() }), /cannot be in the future/, label);

          // The owner's one-save entry (0040) creates the shareholder through the same function and trigger.
          const direct = await call<{ shareholderProfileId: string }>(runtime.db, "direct_shareholder_add", actor, {
            displayName: `Synthetic One-Save Holder ${zone}`, agreedTotal: null, currencyCode: null, externalReference: null,
            note: null, businessDate: day.kabul, firstContribution: null, ...keys() });
          assert.ok(direct.shareholderProfileId, label);

          // Contributions are commitments that may be dated up to ten years ahead of the business day, not of the session day.
          const contribution = (businessDate: string) => call<{ contributionId: string }>(runtime.db, "shareholder_contribution_create", actor, {
            shareholderProfileId: created.shareholderProfileId, contributionType: "CASH", amount: "100", currencyCode: "USD",
            description: "Synthetic business-day pledge", businessDate, ...keys() });
          const horizon = await day.plus(3650); const beyond = await day.plus(3651);
          await contribution(day.kabul);
          await contribution(horizon);
          await assert.rejects(() => contribution(beyond), /contribution date is required/, label);

          // The attachment holder (0040) is dated the business day.
          const holder = await call<{ capitalAgreementId: string }>(runtime.db, "direct_shareholder_document_holder", actor,
            { shareholderProfileId: created.shareholderProfileId });
          const effective = (await h.pool.query<{ d: string }>("SELECT effective_on::text AS d FROM abos.capital_agreements WHERE id = $1",
            [holder.capitalAgreementId])).rows[0]?.d;
          assert.equal(effective, day.kabul, `attachment holder effective date: ${label}`);

          // An agreement document dated the business day is accepted; the next day is refused.
          const document = (documentDate: string) => call(runtime.db, "shareholder_agreement_document_finalize", actor, {
            capitalAgreementId: holder.capitalAgreementId, storageId: randomUUID(), originalFileName: "synthetic-agreement.pdf",
            mediaType: "application/pdf", byteSize: 128, documentReference: `Synthetic business-day document ${randomUUID().slice(0, 8)}`,
            documentDate, sha256: randomUUID().replaceAll("-", "").repeat(2), ...keys() });
          await document(day.kabul);
          await assert.rejects(() => document(tomorrow), /cannot be in the future/, label);
        } finally { await runtime.close(); }
      }
      assert.ok(differing >= 1, "at least one session calendar differed from the Kabul business day, so the boundary was really exercised");
      void world;
    });

    test("no restated function still reads current_date; owners, signatures, security and privileges are as before", async () => {
      await resetSchema(h.pool);
      for (const signature of RESTATED) {
        const row = (await h.pool.query<{ body: string; owner: string; definer: boolean; config: string[] | null }>(
          `SELECT pg_get_functiondef(p.oid) AS body, pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer, p.proconfig AS config
             FROM pg_proc p WHERE p.oid = $1::regprocedure`, [`abos.${signature}`])).rows[0];
        assert.ok(row, signature);
        assert.doesNotMatch(row.body, /\bcurrent_date\b/i, `${signature} no longer reads the session calendar`);
        assert.match(row.body, /abos\.business_today\(\)/, `${signature} reads the business day`);
      }
      const may = async (role: string, fn: string) => (await h.pool.query<{ ok: boolean }>(
        "SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok", [role, fn])).rows[0]?.ok;
      assert.equal(await may("abos_v1_shareholder_setup_owner", "abos.business_today()"), true, "the setup owner may read the business day");
      for (const role of ["abos_e1_runtime", "abos_e1_treasury_runtime", "abos_v1_identity_runtime", "abos_e1_frozen_lane"]) {
        assert.equal(await may(role, "abos.business_today()"), false, `${role} gains nothing`);
      }
    });

    test("upgrade from 0041 restates only the eight functions, grants only the business day to the setup owner, and changes no row", async () => {
      await withClusterLock(h.pool, async () => {
        const client = await h.pool.connect();
        try {
          await client.query("BEGIN");
          await client.query("DROP SCHEMA IF EXISTS abos CASCADE");
          const migrations = await loadMigrations();
          const index = migrations.findIndex((migration) => migration.id === MIGRATION);
          assert.ok(index > 0, "0042 is registered");
          assert.equal(migrations[index - 1]?.id, PREDECESSOR);
          assert.equal(migrations[index - 1]?.checksumSha256, "e49aa6bd788f7253c29b0a1c6abd3ac10744895ee343d5732a042f6f171dbaa6");
          await client.query(`CREATE SCHEMA abos; CREATE TABLE abos.schema_migrations (
            migration_id text PRIMARY KEY, checksum_sha256 text NOT NULL CHECK(checksum_sha256 ~ '^[0-9a-f]{64}$'),
            applied_at timestamptz NOT NULL DEFAULT clock_timestamp())`);
          for (const predecessor of migrations.slice(0, index)) {
            await client.query(predecessor.sql);
            await client.query("INSERT INTO abos.schema_migrations(migration_id,checksum_sha256) VALUES($1,$2)", [predecessor.id, predecessor.checksumSha256]);
          }
          const tx: SqlExecutor = {
            query: async <Row extends object>(sql: string, parameters: readonly unknown[] = []) => {
              const result = await client.query(sql, [...parameters]);
              return { rows: result.rows as Row[], rowCount: result.rowCount ?? 0 };
            }, transaction: async (work) => work(tx)
          };
          await client.query("SELECT set_config('abos.runtime_marker',$1,true)", [MARKER]);
          await seedSyntheticWorld(tx, { withoutSandboxAuthorization: true });
          const tables = (await client.query<{ t: string }>(
            "SELECT tablename AS t FROM pg_tables WHERE schemaname='abos' AND tablename<>'schema_migrations' ORDER BY 1")).rows.map((r) => r.t);
          const snapshot = async () => {
            const out: Record<string, string> = {};
            for (const t of tables) {
              assert.match(t, /^[a-z_0-9]+$/);
              out[t] = (await client.query<{ h: string }>(`SELECT count(*)||':'||md5(coalesce(string_agg(x::text, E'\\n' ORDER BY x::text), '')) AS h FROM abos.${t} x`)).rows[0]?.h ?? "";
            }
            return out;
          };
          const functions = async () => (await client.query<{ sig: string; owner: string; definer: boolean; config: string[] | null; acl: string | null; body: string }>(
            `SELECT p.oid::regprocedure::text AS sig, pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer, p.proconfig AS config,
                    p.proacl::text AS acl, pg_get_functiondef(p.oid) AS body
               FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'abos' ORDER BY 1`)).rows;
          const rowsBefore = await snapshot();
          const functionsBefore = await functions();
          const registryBefore = (await client.query("SELECT * FROM abos.schema_migrations ORDER BY migration_id")).rows;

          // 0042 alone, exactly as the runner executes it; later migrations are applied by the runner afterwards.
          await client.query(migrations[index]!.sql);
          await client.query("INSERT INTO abos.schema_migrations(migration_id,checksum_sha256) VALUES($1,$2)", [MIGRATION, migrations[index]!.checksumSha256]);

          assert.deepEqual(await snapshot(), rowsBefore, "every business and security table is byte-for-byte unchanged");
          assert.deepEqual((await client.query("SELECT * FROM abos.schema_migrations WHERE migration_id <> $1 ORDER BY migration_id", [MIGRATION])).rows,
            registryBefore, "0001-0041 registry rows are unchanged");
          const functionsAfter = await functions();
          assert.deepEqual(functionsAfter.map((f) => f.sig), functionsBefore.map((f) => f.sig), "no function added or removed");
          const changed: string[] = [];
          for (const [i, after] of functionsAfter.entries()) {
            const before = functionsBefore[i];
            assert.ok(before);
            const label = after.sig.replace(/^abos\./, "");
            assert.equal(after.owner, before.owner, `${label}: owner`);
            assert.equal(after.definer, before.definer, `${label}: security`);
            assert.deepEqual(after.config, before.config, `${label}: search_path`);
            if (label === "business_today()") {
              assert.notEqual(after.acl, before.acl, "business_today gains exactly one grant");
              assert.match(after.acl ?? "", /abos_v1_shareholder_setup_owner=X\//);
              assert.equal((after.acl ?? "").replace(/,?abos_v1_shareholder_setup_owner=X\/[a-z_0-9]+/, ""), before.acl ?? "");
            } else {
              assert.equal(after.acl, before.acl, `${label}: privileges`);
            }
            // Function source is stored byte-for-byte; a Windows checkout gives earlier migrations CRLF line
            // endings, so compare line content (the migration checksum normalizes line endings the same way).
            const lines = (body: string) => body.replace(/\r\n/g, "\n");
            if (lines(after.body) !== lines(before.body)) {
              changed.push(label);
              assert.equal(lines(after.body).replaceAll("abos.business_today()", "current_date"), lines(before.body), `${label}: only current_date is replaced`);
            }
          }
          assert.deepEqual(changed.sort(), [...RESTATED].sort(), "exactly the eight shareholder setup functions are restated");
          assert.deepEqual(await applyMigrations(tx, migrations), migrations.slice(index + 1).map((m) => m.id),
            "the runner accepts the recorded 0042 and applies only what follows it");
        } finally {
          await client.query("ROLLBACK");
          client.release();
        }
      });
    });
  });
}
