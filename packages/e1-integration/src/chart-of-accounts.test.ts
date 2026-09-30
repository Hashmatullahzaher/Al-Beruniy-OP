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
import { CapitalReceiptIntentService } from "@abos/shareholder";
import { databaseUrl, MISSING_DATABASE_MESSAGE, openHarness, resetSchema, type Harness } from "./harness.ts";
import { issueOperationalSession } from "./operational-session.ts";
import {
  handOffSyntheticReceipt, recordCapitalPostingIntent, recordSyntheticTreasuryReceipt, seedSyntheticWorld,
  SYNTHETIC_AUTH_CONFIGURATION, type SyntheticWorld
} from "./synthetic-world.ts";

/**
 * Migration 0014: the user-managed Chart of Accounts, through the restricted Finance login only.
 *
 * Every account name and code below is synthetic. None is, or suggests, the client's chart.
 */

const MARKER = SYNTHETIC_AUTH_CONFIGURATION.runtimeMarker;
const FINANCE = { name: "abos_e1_finance_runtime_test_login", password: "synthetic-finance-runtime-only-2026" };

interface Warning { accountId: string; code: string; severity: "LIKELY" | "POSSIBLE"; reasons: string[]; similarity: number }
interface Usage { inUse: boolean; journalLines: number; postedJournalLines: number; safeAccounts: number; references: string[]; pendingPostingIntents: number }
interface Account {
  id: string; code: string; name: string; nameFa: string | null; type: string; controlType: string | null; currency: string | null;
  parentId: string | null; postingAllowed: boolean; status: string; origin: string; version: number;
  reviewState: string | null; reviewReason: string | null; createdBy: string | null; lastChangedBy: string | null;
  duplicateWarnings: Warning[]; viewerIsParticipant: boolean; usage: Usage;
  reviews: { decision: string; note: string | null; reviewer: string }[];
}
interface View { canManage: boolean; canReview: boolean; accounts: Account[]; reviewQueue: number; legalEntity: { id: string } }
interface Tokens { creator: string; editor: string; reviewer: string; reader: string; outsider: string }

if (databaseUrl() === undefined) {
  test("V1 chart of accounts", () => assert.fail(MISSING_DATABASE_MESSAGE));
} else {
  describe("V1 chart of accounts (migration 0014)", () => {
    let harness: Harness;
    let financePool: pg.Pool;
    let db: SqlExecutor;
    before(async () => {
      harness = await openHarness(MARKER);
      await harness.executor.query(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${FINANCE.name}') THEN
          CREATE ROLE ${FINANCE.name} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
        END IF; END $$`);
      await harness.executor.query(`ALTER ROLE ${FINANCE.name} LOGIN PASSWORD '${FINANCE.password}'`);
      const url = new URL(databaseUrl() ?? "");
      url.username = FINANCE.name; url.password = FINANCE.password;
      financePool = new pg.Pool({ connectionString: url.toString(), max: 2 });
      db = new PostgresExecutor(financePool, { runtimeMarker: MARKER });
    });
    after(async () => { await financePool.end(); await harness.close(); });

    test("a permitted user creates accounts that are usable at once, with live duplicate warnings", async () => {
      const { world, tokens } = await prepare(harness);
      const group = await create(db, tokens.creator, { code: "SYN-EXP", name: "Synthetic Operating Expenses", type: "EXPENSE", postingAllowed: false });
      assert.equal(group.account.status, "ACTIVE", "created accounts are active at once");
      assert.equal(group.account.reviewState, "PENDING_REVIEW");
      assert.equal(group.account.reviewReason, "CREATED");
      assert.equal(group.account.origin, "APP");
      assert.equal(group.account.version, 1);
      assert.equal(group.account.currency, null, "a non-posting group may hold several currencies");
      assert.equal(group.account.createdBy, "Synthetic Intent Creator");
      const rent = await create(db, tokens.creator, {
        code: "SYN-EXP-100", name: "Synthetic Office Rent", nameFa: "مصارف كرايه دفتر", type: "EXPENSE", currency: "USD",
        parentId: group.account.id, postingAllowed: true
      });
      assert.deepEqual(rent.warnings, []);
      assert.equal(rent.account.parentId, group.account.id);

      // Live check: same name, same type and currency is LIKELY; another currency only POSSIBLE.
      const same = await check(db, tokens.creator, { code: "SYN-EXP-101", name: "  synthetic OFFICE rent ", type: "EXPENSE", currency: "USD" });
      assert.equal(same.codeTaken, null);
      assert.equal(same.warnings[0]?.accountId, rent.account.id);
      assert.equal(same.warnings[0]?.severity, "LIKELY");
      assert.ok(same.warnings[0]?.reasons.includes("SAME_NAME"));
      const afn = await check(db, tokens.creator, { code: "SYN-EXP-102", name: "Synthetic Office Rent", type: "EXPENSE", currency: "AFN" });
      assert.equal(afn.warnings[0]?.severity, "POSSIBLE");
      const typo = await check(db, tokens.creator, { code: "SYN-EXP-103", name: "Synthetic Ofice Rents", type: "EXPENSE", currency: "USD" });
      assert.ok(typo.warnings[0]?.reasons.includes("SIMILAR_NAME"), JSON.stringify(typo.warnings));
      assert.equal(typo.warnings[0]?.severity, "LIKELY");
      // Dari names are compared after unifying Arabic and Persian letter forms.
      const dari = await check(db, tokens.creator, { code: "SYN-X", name: "Something Else Entirely", nameFa: "مصارف کرایه دفتر", type: "EXPENSE", currency: "USD" });
      assert.ok(dari.warnings.some((warning) => warning.accountId === rent.account.id && warning.reasons.includes("SAME_NAME")));
      // A look-alike code is a likely duplicate; an equal code (any letter case) is taken.
      const code = await check(db, tokens.creator, { code: "syn-exp100", name: "Unrelated Synthetic Name", type: "ASSET", currency: "USD" });
      assert.ok(code.warnings.some((warning) => warning.reasons.includes("SIMILAR_CODE") && warning.severity === "LIKELY"));
      const taken = await check(db, tokens.creator, { code: "syn-exp-100", name: "Unrelated", type: "EXPENSE" });
      assert.equal(taken.codeTaken?.accountId, rent.account.id);
      await refused(create(db, tokens.creator, { code: " syn-EXP-100 ", name: "Unrelated Synthetic Name", type: "EXPENSE", currency: "USD", postingAllowed: true }),
        "23505", /already exists/);
      await refused(harness.executor.query(
        `INSERT INTO abos.ledger_accounts (id, legal_entity_id, account_code, account_name, account_type) VALUES (gen_random_uuid(), $1, 'SYN-exp-100', 'Direct', 'EXPENSE')`,
        [world.legalEntityId]), "23505", /ledger_accounts_code_normalized/);

      // A likely duplicate must be confirmed; the confirmed warnings travel to the reviewer.
      await refused(create(db, tokens.creator, { code: "SYN-EXP-101", name: "Synthetic Office Rent", type: "EXPENSE", currency: "USD", parentId: group.account.id, postingAllowed: true }),
        "ABC01", /likely duplicate/);
      const confirmed = await create(db, tokens.creator, { code: "SYN-EXP-101", name: "Synthetic Office Rent", type: "EXPENSE", currency: "USD", parentId: group.account.id, postingAllowed: true }, true);
      assert.equal(confirmed.account.duplicateWarnings[0]?.accountId, rent.account.id);
      // A POSSIBLE warning alone does not need confirmation.
      const afnRent = await create(db, tokens.creator, { code: "SYN-EXP-102", name: "Synthetic Office Rent AFN", type: "EXPENSE", currency: "AFN", postingAllowed: true });
      assert.ok(afnRent.warnings.length > 0 && afnRent.warnings.every((warning) => warning.severity === "POSSIBLE"), JSON.stringify(afnRent.warnings));

      // Structure rules.
      await refused(create(db, tokens.creator, { code: "SYN-A1", name: "Synthetic Wrong Type", type: "ASSET", currency: "USD", parentId: group.account.id, postingAllowed: true }),
        "23514", /same account type as its parent/);
      await refused(create(db, tokens.creator, { code: "SYN-A2", name: "Synthetic Wrong Currency", type: "EXPENSE", currency: "AFN", parentId: rent.account.id, postingAllowed: true }),
        "23514", /parent's currency/);
      await refused(create(db, tokens.creator, { code: "SYN-A3", name: "Synthetic Cash Liability", type: "LIABILITY", controlType: "CASH", currency: "USD", postingAllowed: true }),
        "23514", /CASH control account cannot have account type LIABILITY/);
      await refused(create(db, tokens.creator, { code: "SYN-A4", name: "Synthetic No Currency", type: "EXPENSE", postingAllowed: true }),
        "23514", /needs a currency/);
      await refused(create(db, tokens.creator, { code: "SYN A5!", name: "Synthetic Bad Code", type: "EXPENSE", currency: "USD", postingAllowed: true }),
        "23514", /account code must be/);
      await refused(create(db, tokens.creator, { code: "SYN-A6", name: "Synthetic Extra", type: "EXPENSE", currency: "USD", postingAllowed: true, status: "INACTIVE" } as never),
        "22023", /unknown account fields: status/);
      await refused(create(db, tokens.creator, { code: "SYN-A7", name: "Synthetic Other Company Parent", type: "EXPENSE", currency: "USD", postingAllowed: true, parentId: randomUUID() }),
        "23503", /parent account does not exist/);
      // The synthetic posting engine resolves exactly one capital account per currency.
      await refused(create(db, tokens.creator, { code: "SYN-CAP-2", name: "Synthetic Second Capital", type: "EQUITY", controlType: "SHAREHOLDER_CAPITAL", currency: "USD", postingAllowed: true }),
        "23514", /capital posting needs exactly one/);
      // No cycles: a group cannot move under its own sub-account.
      const subgroup = await create(db, tokens.creator, { code: "SYN-EXP-SUB", name: "Synthetic Premises Costs", type: "EXPENSE", parentId: group.account.id, postingAllowed: false });
      await refused(update(db, tokens.creator, group.account.id, 1, { parentId: subgroup.account.id }), "23514", /under itself/);

      // Edits return the account to review and are version-checked.
      const renamed = await update(db, tokens.creator, rent.account.id, 1, { name: "Synthetic Office Rent - Head Office", description: "Synthetic demonstration account." }, true);
      assert.ok(renamed.warnings.some((warning) => warning.code === "SYN-EXP-101"), "an edit is checked for duplicates too");
      assert.equal(renamed.account.version, 2);
      assert.equal(renamed.account.reviewState, "PENDING_REVIEW");
      await refused(update(db, tokens.creator, rent.account.id, 1, { name: "Stale" }), "40001", /changed by someone else/);
      const unchanged = await update(db, tokens.creator, rent.account.id, 2, { name: "Synthetic Office Rent - Head Office" });
      assert.equal(unchanged.changed, false);

      // Deactivation: needs a reason, refused while active sub-accounts exist, reversible.
      await refused(setStatus(db, tokens.creator, group.account.id, 1, "INACTIVE", "Synthetic reorganisation"), "ABC02", /active sub-accounts/);
      await refused(setStatus(db, tokens.creator, rent.account.id, 2, "INACTIVE", ""), "23514", /give a reason/);
      for (const child of [rent.account, confirmed.account, subgroup.account]) {
        const version = child.id === rent.account.id ? 2 : 1;
        assert.equal((await setStatus(db, tokens.creator, child.id, version, "INACTIVE", "Synthetic reorganisation")).account.status, "INACTIVE");
      }
      assert.equal((await setStatus(db, tokens.creator, group.account.id, 1, "INACTIVE", "Synthetic reorganisation")).account.status, "INACTIVE");
      await refused(setStatus(db, tokens.creator, rent.account.id, 3, "ACTIVE", null), "23514", /active parent/);
      await setStatus(db, tokens.creator, group.account.id, 2, "ACTIVE", null);
      assert.equal((await setStatus(db, tokens.creator, rent.account.id, 3, "ACTIVE", null)).account.status, "ACTIVE");

      const view = await accountsView(db, tokens.creator);
      assert.equal(view.canManage, true);
      assert.equal(view.canReview, false);
      assert.ok(view.accounts.some((account) => account.code === "1010-USD" && account.origin === "PRE_EXISTING" && account.reviewState === null),
        "seeded accounts are listed as created outside the app");

      // Every change is audited with the true actor.
      const audit = await harness.executor.query<{ action: string; actor: string; metadata: { confirmedDuplicates?: boolean } }>(
        `SELECT action, actor_user_account_id AS actor, metadata FROM abos.audit_records
          WHERE entity_type = 'LEDGER_ACCOUNT' AND entity_id = $1 ORDER BY occurred_at`, [rent.account.id]);
      assert.deepEqual(audit.rows.map((row) => row.action),
        ["LEDGER_ACCOUNT_CREATED", "LEDGER_ACCOUNT_UPDATED", "LEDGER_ACCOUNT_DEACTIVATED", "LEDGER_ACCOUNT_REACTIVATED"]);
      assert.ok(audit.rows.every((row) => row.actor === world.intentCreatorId));
      const confirmedAudit = await harness.executor.query<{ metadata: { confirmedDuplicates: boolean; duplicateWarnings: unknown[] } }>(
        "SELECT metadata FROM abos.audit_records WHERE entity_id = $1 AND action = 'LEDGER_ACCOUNT_CREATED'", [confirmed.account.id]);
      assert.equal(confirmedAudit.rows[0]?.metadata.confirmedDuplicates, true);
      assert.equal(confirmedAudit.rows[0]?.metadata.duplicateWarnings.length, 1);
    });

    test("the Finance Manager review list, with independence the database enforces", async () => {
      const { world, tokens } = await prepare(harness);
      const first = await create(db, tokens.creator, { code: "SYN-REV-1", name: "Synthetic Review One", type: "REVENUE", currency: "USD", postingAllowed: true });
      const second = await create(db, tokens.creator, { code: "SYN-REV-2", name: "Synthetic Review Two", type: "REVENUE", currency: "AFN", postingAllowed: true });
      const reviewerView = await accountsView(db, tokens.reviewer);
      assert.equal(reviewerView.canReview, true);
      assert.equal(reviewerView.canManage, false);
      assert.equal(reviewerView.reviewQueue, 2);

      // The creator also holds the review permission here, and still cannot review their own account.
      await harness.executor.query(
        `INSERT INTO abos.user_permission_grants (user_account_id, legal_entity_id, permission_code, granted_by_user_account_id)
         VALUES ($1, $2, 'finance.ledger-account.review', $3)`, [world.intentCreatorId, world.legalEntityId, world.bootstrapUserId]);
      const creatorView = await accountsView(db, tokens.creator);
      assert.equal(creatorView.accounts.find((account) => account.id === first.account.id)?.viewerIsParticipant, true);
      await refused(review(db, tokens.creator, first.account.id, 1, "REVIEWED", null), "ABC03", /cannot be the person who created or last changed it/);

      // Whoever last changed it cannot review it either.
      const changed = await update(db, tokens.editor, first.account.id, 1, { nameFa: "درآمد آزمایشی یک" });
      assert.equal(changed.account.lastChangedBy, "Synthetic Finance Approver");
      await refused(review(db, tokens.editor, first.account.id, 2, "REVIEWED", null), "ABC03", /created or last changed/);
      // Nor by inserting a decision directly, whoever the writer is.
      await refused(harness.executor.query(
        `INSERT INTO abos.ledger_account_review_decisions (id, ledger_account_id, legal_entity_id, account_version, decision, reviewer_user_account_id)
         VALUES (gen_random_uuid(), $1, $2, 2, 'REVIEWED', $3)`, [first.account.id, world.legalEntityId, world.intentCreatorId]), "ABC03", /created or last changed/);

      // An independent reviewer decides; the decision is version-checked and final for that version.
      await refused(review(db, tokens.reviewer, first.account.id, 1, "REVIEWED", null), "40001", /changed by someone else/);
      const reviewed = await review(db, tokens.reviewer, first.account.id, 2, "REVIEWED", "Synthetic check done");
      assert.equal(reviewed.account.reviewState, "REVIEWED");
      assert.equal(reviewed.account.reviews[0]?.reviewer, "Synthetic Reversal Approver");
      await refused(review(db, tokens.reviewer, first.account.id, 3, "REVIEWED", null), "23514", /not waiting for review/);
      await refused(review(db, tokens.reviewer, second.account.id, 1, "FLAGGED", " "), "23514", /say what needs correcting/);
      const flagged = await review(db, tokens.reviewer, second.account.id, 1, "FLAGGED", "Synthetic: use a clearer name");
      assert.equal(flagged.account.reviewState, "FLAGGED");
      assert.equal((await accountsView(db, tokens.reviewer)).reviewQueue, 1, "a flagged account stays in the list until corrected and reviewed");
      // A correction sends it back for review as a change.
      const corrected = await update(db, tokens.creator, second.account.id, 2, { name: "Synthetic Review Two (AFN)" });
      assert.equal(corrected.account.reviewState, "PENDING_REVIEW");
      assert.equal(corrected.account.reviewReason, "CHANGED");
      // Decisions are append-only.
      await refused(harness.executor.query("UPDATE abos.ledger_account_review_decisions SET decision = 'REVIEWED'"), "P0001", /append-only/);
      await refused(harness.executor.query("DELETE FROM abos.ledger_account_review_decisions"), "P0001", /append-only/);
      const audit = await harness.executor.query<{ action: string; actor: string }>(
        `SELECT action, actor_user_account_id AS actor FROM abos.audit_records
          WHERE entity_type = 'LEDGER_ACCOUNT' AND action IN ('LEDGER_ACCOUNT_REVIEWED', 'LEDGER_ACCOUNT_FLAGGED') ORDER BY occurred_at`);
      assert.deepEqual(audit.rows, [
        { action: "LEDGER_ACCOUNT_REVIEWED", actor: world.reverserId },
        { action: "LEDGER_ACCOUNT_FLAGGED", actor: world.reverserId }
      ]);
    });

    test("accounts used by safes, other packages, posting intents or posted journals are protected", async () => {
      const { world, tokens } = await prepare(harness);
      const find = async (id: string) => {
        const account = (await accountsView(db, tokens.creator)).accounts.find((candidate) => candidate.id === id);
        assert.ok(account, id);
        return account;
      };
      // The seeded USD cash account backs the active synthetic safe account.
      const cash = await find(world.cashLedgerAccountId);
      assert.equal(cash.usage.inUse, true);
      assert.equal(cash.usage.safeAccounts, 1);
      for (const change of [{ code: "1010-X" }, { currency: "AFN" }, { type: "EXPENSE", controlType: null }, { controlType: "OTHER" }, { postingAllowed: false }, { requiresProject: true }]) {
        await refused(update(db, tokens.creator, cash.id, 0, change), "ABC02", /is in use/);
      }
      await refused(setStatus(db, tokens.creator, cash.id, 0, "INACTIVE", "Synthetic attempt"), "ABC02", /safe currency account/);
      // The protection holds for any writer, not only the entry points.
      await refused(harness.executor.query("UPDATE abos.ledger_accounts SET account_code = 'X' WHERE id = $1", [cash.id]), "ABC02", /is in use/);
      await refused(harness.executor.query("UPDATE abos.ledger_accounts SET status = 'INACTIVE' WHERE id = $1", [cash.id]), "ABC02", /cannot be deactivated/);
      // A DRAFT safe account also protects its account.
      await refused(setStatus(db, tokens.creator, world.afnCashLedgerAccountId, 0, "INACTIVE", "Synthetic attempt"), "ABC02", /safe currency account/);
      // Renaming is still possible, and brings a seeded account into the review list.
      const renamed = await update(db, tokens.creator, cash.id, 0, { name: "Synthetic Office Cash (USD)" });
      assert.equal(renamed.account.origin, "PRE_EXISTING");
      assert.equal(renamed.account.reviewState, "PENDING_REVIEW");
      assert.equal(renamed.account.createdBy, null);

      // A later package (for example Saraf accounts) registers its references with one trigger.
      const saraf = await create(db, tokens.creator, { code: "SYN-SARAF-1", name: "Synthetic Saraf Alpha", type: "ASSET", controlType: "SARAF", currency: "USD", postingAllowed: true });
      await harness.executor.query("CREATE TABLE abos.synthetic_saraf_like (id uuid PRIMARY KEY, ledger_account_id uuid NOT NULL)");
      await harness.executor.query(`CREATE TRIGGER synthetic_saraf_like_reference AFTER INSERT OR UPDATE OF ledger_account_id ON abos.synthetic_saraf_like
        FOR EACH ROW EXECUTE FUNCTION abos.ledger_account_mark_referenced('ledger_account_id')`);
      await harness.executor.query("INSERT INTO abos.synthetic_saraf_like (id, ledger_account_id) VALUES (gen_random_uuid(), $1)", [saraf.account.id]);
      const referenced = await find(saraf.account.id);
      assert.deepEqual(referenced.usage.references, ["synthetic_saraf_like"]);
      await refused(update(db, tokens.creator, saraf.account.id, 1, { code: "SYN-SARAF-X" }), "ABC02", /is in use/);
      await refused(setStatus(db, tokens.creator, saraf.account.id, 1, "INACTIVE", "Synthetic attempt"), "ABC02", /used by/);
      await refused(harness.executor.query("DELETE FROM abos.ledger_account_references"), "P0001", /append-only/);

      // A capital posting intent in progress depends on the single capital account.
      const prepared = await postingReady(harness, world);
      const capital = await find(world.capitalLedgerAccountId);
      assert.equal(capital.usage.pendingPostingIntents, 1);
      await refused(update(db, tokens.creator, capital.id, 0, { code: "3010-X" }), "ABC02", /is in use/);
      await refused(setStatus(db, tokens.creator, capital.id, 0, "INACTIVE", "Synthetic attempt"), "ABC02", /postings in progress/);

      // Once posted, the account's ledger attributes are final; only the Dari name and description change.
      await new RestrictedCapitalPostingGateway(db).post({
        bearerToken: prepared.approverToken, postingIntentId: prepared.postingIntentId as PostingIntentId,
        accountingPeriodId: world.accountingPeriodId as never
      });
      const posted = await find(world.capitalLedgerAccountId);
      assert.equal(posted.usage.postedJournalLines, 1);
      await refused(update(db, tokens.creator, posted.id, 0, { name: "Synthetic Capital Renamed" }), "ABC02", /posted activity/);
      await refused(setStatus(db, tokens.creator, posted.id, 0, "INACTIVE", "Synthetic attempt"), "ABC02", /posted activity/);
      const described = await update(db, tokens.creator, posted.id, 0, { nameFa: "سرمایه آزمایشی", description: "Synthetic demonstration only." });
      assert.equal(described.account.nameFa, "سرمایه آزمایشی");
      await refused(harness.executor.query("UPDATE abos.ledger_accounts SET account_name = 'X' WHERE id = $1", [posted.id]), "", /posted financial provenance is immutable/);
      await refused(harness.executor.query("DELETE FROM abos.ledger_accounts WHERE id = $1", [posted.id]), "", /immutable|violates foreign key/);
    });

    test("company isolation, authorization and the restricted login's lack of table access", async () => {
      const { world, tokens } = await prepare(harness);
      const mine = await create(db, tokens.creator, { code: "SYN-ISO-1", name: "Synthetic Isolation Account", type: "ASSET", currency: "USD", postingAllowed: true });

      // A second synthetic company, with its own Chart of Accounts manager.
      const other = await seedSyntheticWorld(harness.executor, { withoutSandboxAuthorization: true });
      await harness.executor.query(
        "INSERT INTO abos.sandbox_legal_entity_scopes (legal_entity_id, base_currency_code, authorized_by_user_account_id) VALUES ($1, 'USD', $2)",
        [other.legalEntityId, world.bootstrapUserId]);
      await grant(harness, other, other.intentCreatorId, ["finance.ledger-account.manage", "finance.ledger-account.review"]);
      const otherToken = await session(harness, other, other.intentCreatorId);
      const otherView = await accountsView(db, otherToken);
      assert.equal(otherView.legalEntity.id, other.legalEntityId);
      assert.ok(otherView.accounts.every((account) => account.id !== mine.account.id), "another company's accounts are invisible");
      assert.deepEqual((await check(db, otherToken, { code: "SYN-ISO-1", name: "Synthetic Isolation Account", type: "ASSET", currency: "USD" })),
        { codeTaken: null, warnings: [] }, "duplicates are only looked for within the company");
      const theirs = await create(db, otherToken, { code: "SYN-ISO-1", name: "Synthetic Isolation Account", type: "ASSET", currency: "USD", postingAllowed: true });
      assert.deepEqual(theirs.warnings, []);
      await refused(update(db, otherToken, mine.account.id, 1, { name: "Hijacked" }), "P0002", /not found/);
      await refused(setStatus(db, otherToken, mine.account.id, 1, "INACTIVE", "Hijack"), "P0002", /not found/);
      await refused(review(db, otherToken, mine.account.id, 1, "REVIEWED", null), "P0002", /not found/);
      await refused(create(db, otherToken, { code: "SYN-ISO-2", name: "Synthetic Cross Parent", type: "ASSET", currency: "USD", postingAllowed: true, parentId: mine.account.id }),
        "23503", /parent account does not exist in this company/);

      // Permissions: a reader views only; a reviewer cannot create; someone without Finance access sees nothing.
      const readerView = await accountsView(db, tokens.reader);
      assert.equal(readerView.canManage, false);
      assert.equal(readerView.canReview, false);
      assert.ok(readerView.accounts.length > 0);
      await refused(create(db, tokens.reader, { code: "SYN-R", name: "Synthetic Reader", type: "ASSET", currency: "USD", postingAllowed: true }), "42501", /authority is missing/);
      await refused(check(db, tokens.reader, { code: "SYN-R", name: "x", type: "ASSET" }), "42501", /authority is missing/);
      await refused(review(db, tokens.reader, mine.account.id, 1, "REVIEWED", null), "42501", /authority is missing/);
      await refused(create(db, tokens.reviewer, { code: "SYN-R", name: "Synthetic Reviewer", type: "ASSET", currency: "USD", postingAllowed: true }), "42501", /authority is missing/);
      await refused(accountsView(db, tokens.outsider), "42501", /authority is missing/);
      await refused(accountsView(db, "z".repeat(43)), "42501", /session is invalid/);

      // The restricted login reaches nothing but the entry points.
      for (const sql of [
        "SELECT * FROM abos.ledger_accounts",
        "SELECT * FROM abos.ledger_account_governance",
        "INSERT INTO abos.ledger_account_review_decisions (id) VALUES (gen_random_uuid())",
        "UPDATE abos.ledger_accounts SET status = 'INACTIVE'",
        "INSERT INTO abos.ledger_account_references (ledger_account_id, legal_entity_id, source_table) VALUES (gen_random_uuid(), gen_random_uuid(), 'x')"
      ]) await refused(db.query(sql), "42501", /permission denied for table/);
      for (const sql of [
        "SELECT abos.coa_duplicate_warnings(gen_random_uuid(), NULL, 'a', 'b', NULL, 'ASSET', 'USD', NULL)",
        "SELECT abos.ledger_account_usage(gen_random_uuid())",
        "SELECT abos.coa_account_json(gen_random_uuid(), NULL)",
        "SELECT abos.coa_normalize_name('x')"
      ]) await refused(db.query(sql), "42501", /permission denied for function/);

      // The Finance owner changes accounts only inside a Chart of Accounts entry point; Treasury never.
      await asOwner(harness, "abos_e1_finance_owner", async (client) => {
        await refused(client.query("UPDATE abos.ledger_accounts SET account_name = 'Sneaky' WHERE id = $1", [mine.account.id]), "42501",
          /abos_e1_finance_owner may lock but not change ledger_accounts/);
      });
      await asOwner(harness, "abos_e1_finance_owner", async (client) => {
        await refused(client.query("UPDATE abos.ledger_accounts SET legal_entity_id = legal_entity_id WHERE id = $1", [mine.account.id]), "42501", /permission denied/);
      });
      await asOwner(harness, "abos_e1_finance_owner", async (client) => {
        await refused(client.query("DELETE FROM abos.ledger_accounts"), "42501", /permission denied/);
      });
      await asOwner(harness, "abos_e1_treasury_owner", async (client) => {
        await refused(client.query("UPDATE abos.ledger_accounts SET account_name = 'Sneaky'"), "42501", /permission denied/);
      });
      // Nothing was changed by any refused attempt.
      const after = (await accountsView(db, tokens.creator)).accounts.find((account) => account.id === mine.account.id);
      assert.equal(after?.name, "Synthetic Isolation Account");
      assert.equal(after?.status, "ACTIVE");
    });
  });
}

// -----------------------------------------------------------------------------------------------

async function prepare(harness: Harness): Promise<{ world: SyntheticWorld; tokens: Tokens }> {
  await resetSchema(harness.pool);
  await harness.executor.query("GRANT abos_e1_runtime TO abos_e1_finance_runtime_test_login");
  const world = await seedSyntheticWorld(harness.executor);
  // Creator: manage. Editor: manage and review. Reviewer: review only. Reader: operational read only.
  await grant(harness, world, world.intentCreatorId, ["finance.ledger-account.manage"]);
  await grant(harness, world, world.approverId, ["finance.ledger-account.manage", "finance.ledger-account.review"]);
  await grant(harness, world, world.reverserId, ["finance.ledger-account.review"]);
  await grant(harness, world, world.counterId, ["finance.report.operational.read"]);
  return {
    world,
    tokens: {
      creator: await session(harness, world, world.intentCreatorId), editor: await session(harness, world, world.approverId),
      reviewer: await session(harness, world, world.reverserId), reader: await session(harness, world, world.counterId),
      outsider: await session(harness, world, world.cashierId)
    }
  };
}

async function grant(harness: Harness, world: SyntheticWorld, userId: string, permissions: readonly string[]): Promise<void> {
  for (const permission of permissions) {
    await harness.executor.query(
      `INSERT INTO abos.user_permission_grants (user_account_id, legal_entity_id, permission_code, granted_by_user_account_id)
       VALUES ($1, $2, $3, $4)`, [userId, world.legalEntityId, permission, world.bootstrapUserId]);
  }
}

async function session(harness: Harness, world: SyntheticWorld, userId: string): Promise<string> {
  return (await issueOperationalSession(harness, userId, world.legalEntityId)).token;
}

/** The promise is refused with the given SQLSTATE (when not empty) and a message matching the pattern. */
async function refused(promise: Promise<unknown>, sqlState: string, message: RegExp): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    const code = (error as { code?: string }).code;
    assert.match(String(error), message);
    if (sqlState !== "") assert.equal(code, sqlState, String(error));
    return true;
  });
}

type AccountInput = {
  code?: string; name?: string; nameFa?: string | null; description?: string | null; type?: string; controlType?: string | null;
  currency?: string | null; parentId?: string | null; postingAllowed?: boolean; requiresProject?: boolean;
};

async function one<T>(db: SqlExecutor, sql: string, parameters: readonly unknown[]): Promise<T> {
  const result = await db.query<{ value: T }>(sql, parameters);
  const value = result.rows[0]?.value;
  assert.ok(value !== undefined);
  return value;
}

function accountsView(db: SqlExecutor, token: string): Promise<View> {
  return one(db, "SELECT abos.finance_ledger_accounts_view($1) AS value", [token]);
}

function check(db: SqlExecutor, token: string, account: AccountInput, accountId: string | null = null): Promise<{ codeTaken: { accountId: string } | null; warnings: Warning[] }> {
  return one(db, "SELECT abos.finance_ledger_account_check($1, $2::jsonb, $3) AS value", [token, JSON.stringify(account), accountId]);
}

function create(db: SqlExecutor, token: string, account: AccountInput, confirm = false): Promise<{ account: Account; warnings: Warning[] }> {
  return one(db, "SELECT abos.finance_ledger_account_create($1, $2::jsonb, $3) AS value", [token, JSON.stringify(account), confirm]);
}

function update(db: SqlExecutor, token: string, id: string, version: number, changes: AccountInput, confirm = false): Promise<{ account: Account; changed: boolean; warnings: Warning[] }> {
  return one(db, "SELECT abos.finance_ledger_account_update($1, $2, $3, $4::jsonb, $5) AS value", [token, id, version, JSON.stringify(changes), confirm]);
}

function setStatus(db: SqlExecutor, token: string, id: string, version: number, status: string, reason: string | null): Promise<{ account: Account; changed: boolean }> {
  return one(db, "SELECT abos.finance_ledger_account_set_status($1, $2, $3, $4, $5) AS value", [token, id, version, status, reason]);
}

function review(db: SqlExecutor, token: string, id: string, version: number, decision: string, note: string | null): Promise<{ account: Account }> {
  return one(db, "SELECT abos.finance_ledger_account_review($1, $2, $3, $4, $5) AS value", [token, id, version, decision, note]);
}

/** Runs as an owner role inside a transaction that is always rolled back. */
async function asOwner(harness: Harness, role: string, work: (client: pg.PoolClient) => Promise<void>): Promise<void> {
  const client = await harness.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL ROLE ${role}`);
    await client.query("SELECT set_config('abos.runtime_marker', $1, true)", [MARKER]);
    await work(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

/** A capital receipt ready to post: a pending posting intent now depends on the capital account. */
async function postingReady(harness: Harness, world: SyntheticWorld): Promise<{ approverToken: string; postingIntentId: string }> {
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
    source: { legalEntityId: world.legalEntityId as LegalEntityId, idempotencyKey: `coa-${randomUUID()}` as IdempotencyKey, correlationId: randomUUID() as CorrelationId },
    evidence: [{ id: row.id as never, documentId: row.document_id as never, kind: row.evidence_kind, version: row.evidence_version, sha256: row.sha256, completedAt: new Date(row.completed_at).toISOString() }]
  });
  const receipt = await recordSyntheticTreasuryReceipt(harness.executor, world, { capitalReceiptIntentId: intent.id, amount: world.installmentAmount });
  await handOffSyntheticReceipt(harness.executor, world, receipt.cashReceiptId);
  const postingIntentId = await recordCapitalPostingIntent(harness.executor, world, {
    capitalReceiptIntentId: intent.id, cashReceiptId: receipt.cashReceiptId, amount: world.installmentAmount,
    idempotencyKey: `coa-post-${randomUUID()}`, correlationId: randomUUID()
  });
  return { approverToken: await session(harness, world, world.approverId), postingIntentId };
}
