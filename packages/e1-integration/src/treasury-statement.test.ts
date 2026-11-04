import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import test, { after, before, describe } from "node:test";
import pg from "pg";

import { PostgresExecutor } from "@abos/persistence";
import { identityDatabaseProof, SandboxAuthenticator } from "@abos/sandbox-auth";

import { addSyntheticSaraf, grant } from "./currency-fixtures.ts";
import { databaseUrl, MISSING_DATABASE_MESSAGE, openHarness, resetSchema, type Harness } from "./harness.ts";
import { issueOperationalSession } from "./operational-session.ts";
import { seedSyntheticWorld, SYNTHETIC_AUTH_CONFIGURATION, type SyntheticWorld } from "./synthetic-world.ts";

/**
 * Migration 0057 (Slice 7 part 2): the Safe and Saraf statement, and one rule for what a reader may learn about a journal's
 * source. The statement is native currency first, takes its balances from the one Treasury balance, and must agree with the
 * ledger, the trial balance and the account statement. Confidentiality hides detail, never money.
 */

const MARKER = SYNTHETIC_AUTH_CONFIGURATION.runtimeMarker;
const POLICIES = ["OTHER_INCOME", "TREASURY_TRANSFER", "SUPPLIER_PAYMENT", "SALARY_PAYMENT", "EXPENSE", "SHAREHOLDER_CAPITAL_RECEIPT"];
const SEPT = { from: "2026-09-01", to: "2026-09-30" };

type Session = { proof: string; runtimeDigest: string; tokenDigest: string; token: string };
type Source = { type: string; id: string | null; label: { en: string }; route: string | null; counterparty: string | null; detailRestricted?: boolean;
  detail?: { en: string } | null; reference?: string | null; description?: string | null };
type Link = { journalId: string | null; reference: string; date: string };
type Line = { id: string; date: string; moneyIn: string; moneyOut: string; balance: string; currency: string; baseAmount: string; restricted: boolean;
  kind: "EXTERNAL" | "TRANSFER" | "OPENING"; isReversal: boolean; journalId: string | null; journalReference: string | null; source: Source;
  fx: { rate: string; unitCurrency: string; quoteCurrency: string; rateDate: string; source: string; policyVersionId: string | null; roundingMode: string | null } | null;
  transferPeer: { en: string } | null; reversedBy: Link | null; reverses: Link | null };
type Statement = { canOpenLedger: boolean; range: { from: string; to: string };
  account: { id: string; currencyCode: string; accountType: string; ledgerAccount: { id: string } | null };
  opening: { native: string; base: string }; closing: { native: string; base: string };
  totals: { moneyIn: string; moneyOut: string; transfersIn: string; transfersOut: string; reversalsIn: string; reversalsOut: string; movementCount: number };
  lines: Line[]; reconciliation: { treasuryBase: string; ledgerBase: string; difference: string; matches: boolean } };
type View = { baseCurrency: string; accounts: { id: string; nameEn: string }[]; statement: Statement | null };

function session(token: string): Session {
  return { token, proof: identityDatabaseProof(SYNTHETIC_AUTH_CONFIGURATION.signingSecret),
    runtimeDigest: createHash("sha256").update(token).digest("hex"),
    tokenDigest: createHmac("sha256", SYNTHETIC_AUTH_CONFIGURATION.signingSecret).update(token).digest("hex") };
}

/** A source id as it appears inside CAP-, RC-, PY-, TR- and OB- references. */
const embedded = (id: string) => id.replaceAll("-", "").toUpperCase();

if (databaseUrl() === undefined) {
  test("0057 Safe and Saraf statement", () => assert.fail(MISSING_DATABASE_MESSAGE));
} else {
  describe("0057: Safe and Saraf statement and source confidentiality", () => {
    let h: Harness; let runtime: PostgresExecutor; let runtimePool: pg.Pool;
    const login = `abos_ts_${randomUUID().replaceAll("-", "")}`;

    before(async () => {
      const target = new URL(databaseUrl() ?? "");
      assert.notEqual(target.port, "55432", "preserved runtime PostgreSQL is forbidden");
      assert.notEqual(decodeURIComponent(target.pathname.slice(1)), "abos_v1_local_review");
      h = await openHarness(MARKER);
      await resetSchema(h.pool);
      const password = `disposable-${randomUUID()}`;
      await h.pool.query(`CREATE ROLE ${login} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${password}'`);
      const url = new URL(databaseUrl() ?? ""); url.username = login; url.password = password;
      runtimePool = new pg.Pool({ connectionString: url.toString(), max: 4 });
      runtime = new PostgresExecutor(runtimePool, { runtimeMarker: MARKER });
    });
    after(async () => {
      await runtimePool?.end();
      if (h !== undefined) { await resetSchema(h.pool); await h.pool.query(`DROP ROLE IF EXISTS ${login}`); await h.close(); }
    });

    const ledger = async (entity: string, code: string, type: string, control: string | null, currency = "USD") => {
      const id = randomUUID();
      await h.pool.query(`INSERT INTO abos.ledger_accounts (id,legal_entity_id,account_code,account_name,account_type,control_account_type,posting_allowed,account_currency_code,status)
        VALUES ($1,$2,$3,$4,$5,$6,true,$7,'ACTIVE')`, [id, entity, code, `Synthetic ${code}`, type, control, currency]);
      return id;
    };
    const treasury = async (world: SyntheticWorld, name: string, type: string, currency: string, ledgerId: string, saraf: string | null = null) => {
      const id = randomUUID();
      await h.pool.query(`INSERT INTO abos.operational_treasury_accounts (id,legal_entity_id,name_en,account_type,currency_code,ledger_account_id,saraf_business_party_id,
        status,version,created_by_user_account_id,last_changed_by_user_account_id) VALUES($1,$2,$3,$4,$5,$6,$7,'ACTIVE',1,$8,$8)`,
      [id, world.legalEntityId, name, type, currency, ledgerId, saraf, world.bootstrapUserId]);
      return id;
    };

    async function fixture() {
      await resetSchema(h.pool);
      await h.pool.query(`GRANT abos_e1_runtime TO ${login}`);
      const world = await seedSyntheticWorld(h.executor);
      await h.pool.query("DELETE FROM abos.sandbox_legal_entity_scopes");
      await h.pool.query("DELETE FROM abos.sandbox_authorizations");
      const e = world.legalEntityId; const u = world.bootstrapUserId;
      await grant(h.executor, world, world.intentCreatorId, ["treasury.safe.read", "treasury.receipt.record", "treasury.transfer.record",
        "treasury.payment.record", "treasury.opening-balance.record", "finance.expense.create", "finance.expense.read", "finance.report.operational.read",
        "finance.reversal.direct", "finance.fx-policy.manage", "shareholder.setup.manage", "shareholder.read", "shareholder.capital-receipt.read", "shareholder.capital-receipt.record",
        "finance.capital-receipt.prepare", "finance.capital-receipt.post"]);
      // Four readers, each holding one kind of authority.
      await grant(h.executor, world, world.cashierId, ["treasury.safe.read"]);
      await grant(h.executor, world, world.approverId, ["finance.report.operational.read"]);
      await grant(h.executor, world, world.reverserId, ["finance.period.manage", "finance.report.operational.read"]);
      await grant(h.executor, world, world.counterId, ["finance.reversal.request", "finance.report.operational.read"]);
      for (const workflow of POLICIES) {
        await h.pool.query(`INSERT INTO abos.finance_workflow_policy_versions (id,legal_entity_id,workflow_type,version,approval_required,configured_by_user_account_id,change_reason)
          VALUES($1,$2,$3,1,false,$4,'Synthetic Simple Mode setting')`, [randomUUID(), e, workflow, u]);
      }
      const usdSafe = await treasury(world, "Synthetic main Safe", "SAFE", "USD", world.cashLedgerAccountId);
      const secondLedger = await ledger(e, "SYN-TS-CASH-2", "ASSET", "CASH");
      const secondSafe = await treasury(world, "Synthetic petty cash", "PETTY_CASH", "USD", secondLedger);
      const afnLedger = await ledger(e, "SYN-TS-CASH-AFN", "ASSET", "CASH", "AFN");
      const afnSafe = await treasury(world, "Synthetic AFN Safe", "SAFE", "AFN", afnLedger);
      const sarafLedger = await ledger(e, "SYN-TS-SARAF", "ASSET", "SARAF");
      const saraf = await treasury(world, "Synthetic Saraf", "SARAF", "USD", sarafLedger, await addSyntheticSaraf(h.executor, world));
      const revenue = await ledger(e, "SYN-TS-INC", "REVENUE", null);
      const payable = await ledger(e, "SYN-TS-PAY", "LIABILITY", null);
      const expenseLedger = await ledger(e, "SYN-TS-EXP", "EXPENSE", null);
      await ledger(e, "SYN-TS-OBE", "EQUITY", "OPENING_BALANCE_EQUITY");
      const fxAccount = await ledger(e, "SYN-TS-FX", "EXPENSE", "FX_DIFFERENCE");
      const category = randomUUID();
      await h.pool.query(`INSERT INTO abos.operational_expense_categories (id,legal_entity_id,category_code,name_en,ledger_account_id,status,version,created_by_user_account_id,last_changed_by_user_account_id)
        VALUES($1,$2,'SYN-TS','Synthetic supplies',$3,'ACTIVE',1,$4,$4)`, [category, e, expenseLedger, u]);
      const project = randomUUID();
      await h.pool.query("INSERT INTO abos.projects (id, legal_entity_id, code, name, active) VALUES ($1,$2,'TS-P','Synthetic restricted project',true)", [project, e]);
      await h.pool.query("INSERT INTO abos.user_scope_grants (user_account_id, legal_entity_id, scope_kind, scope_id, granted_by_user_account_id) VALUES ($1,$2,'PROJECT',$3,$4)",
        [world.intentCreatorId, e, project, u]);
      for (const day of ["2026-09-14", "2026-09-15", "2026-09-16"]) {
        await h.pool.query(`INSERT INTO abos.exchange_rates (id,legal_entity_id,rate_date,rate_source,unit_currency_code,quote_currency_code,rate_value,note,entered_by_user_account_id)
          VALUES ($1,$2,$3,'MARKET','USD','AFN','70','Synthetic rate',$4)`, [randomUUID(), e, day, u]);
      }
      const s = async (user: string) => session((await issueOperationalSession(h, user, e)).token);
      return { world, e, usdSafe, secondSafe, secondLedger, afnSafe, afnLedger, saraf, sarafLedger, revenue, payable, expenseLedger, category, project, fxAccount,
        creator: await s(world.intentCreatorId), safeReader: await s(world.cashierId), reportReader: await s(world.approverId),
        manager: await s(world.reverserId), requester: await s(world.counterId), responsibleId: world.treasuryManagerId,
        responsible: await s(world.treasuryManagerId) };
    }
    type Fixture = Awaited<ReturnType<typeof fixture>>;
    async function call<T>(name: string, s: Session, ...extra: unknown[]): Promise<T> {
      const params = [s.proof, s.runtimeDigest, s.tokenDigest, ...extra.map((x) => (typeof x === "object" && x !== null ? JSON.stringify(x) : x))];
      const marks = params.map((_, i) => `$${i + 1}${i >= 3 && typeof extra[i - 3] === "object" && extra[i - 3] !== null ? "::jsonb" : ""}`);
      const result = await runtime.query<{ value: T }>(`SELECT abos.${name}(${marks.join(",")}) AS value`, params);
      assert.ok(result.rows[0]); return result.rows[0].value;
    }
    const keys = () => ({ idempotencyKey: `ts-${randomUUID()}`, correlationId: randomUUID() });
    const view = (s: Session, payload: object) => call<View>("treasury_account_statement", s, payload);
    const statement = async (s: Session, accountId: string, range: object = SEPT) => {
      const result = await view(s, { accountId, ...range }); assert.ok(result.statement); return result.statement;
    };
    const line = (lines: Line[], label: string) => lines.find((l) => l.source.label.en === label);

    /** A month of every kind of movement. */
    async function populate(f: Fixture) {
      const c = f.creator;
      await call("treasury_opening_balance_record", c, { treasuryAccountId: f.usdSafe, amount: "2500.00", currencyCode: "USD", asOfDate: "2026-09-01",
        reference: "TS-OPEN", note: "Synthetic opening note", ...keys() });
      const holder = await call<{ shareholderProfileId: string }>("direct_shareholder_add", c, { displayName: "Synthetic Private Holder", agreedTotal: null,
        currencyCode: "USD", externalReference: null, note: null, businessDate: "2026-09-05", firstContribution: null, ...keys() });
      const capital = await call<{ journalId: string; receiptId?: string }>("direct_shareholder_receive", c, { shareholderProfileId: holder.shareholderProfileId,
        fundingMethod: "CASH", amount: "700.00", currencyCode: "USD", receiptDate: "2026-09-06", destinationAccountId: f.usdSafe, providerName: null,
        itemDescription: null, expenseLedgerAccountId: null, paymentReference: "TS-CAP-PRIVATE", note: "Synthetic private capital note", ...keys() });
      const receipt = await call<{ journalId: string }>("treasury_receipt_record", c, { treasuryAccountId: f.usdSafe, amount: "1000.00", currencyCode: "USD",
        businessDate: "2026-09-10", payerBusinessPartyId: null, payerName: "Synthetic tenant", revenueLedgerAccountId: f.revenue, reference: "TS-RENT", note: "Synthetic rent", ...keys() });
      const expense = (amount: string, extra: object) => call<{ expense: { journalId: string; id: string } }>("operational_expense_create", c, { treasuryAccountId: f.usdSafe,
        expenseCategoryId: f.category, payeeBusinessPartyId: null, projectId: null, departmentId: null, costCenterId: null, reference: "TS-EXP",
        description: "Synthetic site supplies", note: null, businessDate: "2026-09-11", originalAmount: amount, currencyCode: "USD", exchangeRateId: null, ...keys(), ...extra });
      const supplies = await expense("200.00", {});
      const restricted = await expense("50.00", { projectId: f.project, reference: "TS-SECRET", description: "Synthetic restricted works" });
      const payment = await call<{ journalId: string }>("treasury_payment_record", c, { treasuryAccountId: f.usdSafe, paymentKind: "SUPPLIER", payeeBusinessPartyId: null,
        payeeName: "Synthetic supplier", payableLedgerAccountId: f.payable, amount: "100.00", currencyCode: "USD", businessDate: "2026-09-12", reference: "TS-PAY", note: null, ...keys() });
      const transfer = await call<{ journalId: string }>("treasury_transfer_record", c, { sourceTreasuryAccountId: f.usdSafe, destinationTreasuryAccountId: f.secondSafe,
        amount: "300.00", currencyCode: "USD", businessDate: "2026-09-13", reference: "TS-MOVE", note: null, ...keys() });
      const reversal = await call<{ reversalJournalId: string }>("finance_journal_reversal_direct", c, { journalId: payment.journalId, reason: "Synthetic duplicate supplier payment", ...keys() });
      const smallTransfer = await call<{ journalId: string }>("treasury_transfer_record", c, { sourceTreasuryAccountId: f.usdSafe, destinationTreasuryAccountId: f.secondSafe,
        amount: "20.00", currencyCode: "USD", businessDate: "2026-09-13", reference: "TS-MOVE-2", note: null, ...keys() });
      const transferReversal = await call<{ reversalJournalId: string }>("finance_journal_reversal_direct", c, { journalId: smallTransfer.journalId, reason: "Synthetic wrong Safe chosen", ...keys() });
      await call("finance_fx_policy_set", c, { currencyCode: "AFN", effectiveFrom: "2026-09-01", baseScale: 2, roundingMode: "HALF_UP", fxDifferenceLedgerAccountId: f.fxAccount,
        reason: "Synthetic FX policy decision", expectedVersion: 0, correlationId: randomUUID() });
      await call("treasury_receipt_record", c, { treasuryAccountId: f.afnSafe, amount: "7000.00", currencyCode: "AFN", businessDate: "2026-09-14",
        payerBusinessPartyId: null, payerName: "Synthetic AFN tenant", revenueLedgerAccountId: f.revenue, reference: "TS-AFN-IN", note: null, ...keys() });
      const afnPayment = await call<{ journalId: string }>("treasury_payment_record", c, { treasuryAccountId: f.afnSafe, paymentKind: "SUPPLIER", payeeBusinessPartyId: null, payeeName: "Synthetic AFN supplier",
        payableLedgerAccountId: f.payable, amount: "1400.00", currencyCode: "AFN", businessDate: "2026-09-15", reference: "TS-AFN-OUT", note: null, ...keys() });
      // A Saraf may legitimately go negative: the company owes it.
      await call("treasury_receipt_record", c, { treasuryAccountId: f.saraf, amount: "100.00", currencyCode: "USD", businessDate: "2026-09-16",
        payerBusinessPartyId: null, payerName: "Synthetic Saraf client", revenueLedgerAccountId: f.revenue, reference: "TS-SARAF-IN", note: null, ...keys() });
      await call("treasury_payment_record", c, { treasuryAccountId: f.saraf, paymentKind: "SUPPLIER", payeeBusinessPartyId: null, payeeName: "Synthetic Saraf supplier",
        payableLedgerAccountId: f.payable, amount: "400.00", currencyCode: "USD", businessDate: "2026-09-16", reference: "TS-SARAF-OUT", note: null, ...keys() });
      return { capital: capital.journalId, receipt: receipt.journalId, payment: payment.journalId, reversal: reversal.reversalJournalId, transfer: transfer.journalId,
        transferReversal: transferReversal.reversalJournalId, afnPayment: afnPayment.journalId, restricted: restricted.expense.journalId, expense: supplies.expense.journalId, holder: holder.shareholderProfileId };
    }
    /** The id of the business record behind a journal. */
    const sourceId = async (journal: string) => (await h.pool.query<{ id: string }>(
      "SELECT i.source_id AS id FROM abos.journals j JOIN abos.posting_intents i ON i.id = j.posting_intent_id WHERE j.id = $1", [journal])).rows[0]?.id ?? "";
    /** Reads the whole response as text, so a leak in any field fails, not only the fields a screen shows. */
    const assertAbsent = (value: unknown, forbidden: readonly string[], who: string) => {
      const text = JSON.stringify(value);
      for (const word of forbidden) assert.equal(text.includes(word), false, `${who} must not receive ${word}`);
    };

    test("every active posting source is named by the readability test, which refuses any other", async () => {
      await fixture();
      const sources = await h.pool.query<{ source_type: string }>("SELECT source_type FROM abos.posting_sources WHERE status = 'ACTIVE'");
      const all = JSON.stringify(["shareholder.read", "finance.temporary-funding.read", "finance.expense.read", "treasury.safe.read"]);
      for (const { source_type: type } of sources.rows) {
        const readable = await h.pool.query<{ ok: boolean }>("SELECT abos.report_source_readable($1, $2::jsonb) AS ok", [type, all]);
        assert.equal(readable.rows[0]?.ok, true, `${type} is readable with its module's permission`);
        const none = await h.pool.query<{ ok: boolean }>("SELECT abos.report_source_readable($1, '[]'::jsonb) AS ok", [type]);
        assert.equal(none.rows[0]?.ok, type === "REVERSAL", `${type} without any permission`);
      }
      const unknown = await h.pool.query<{ ok: boolean }>("SELECT abos.report_source_readable('A_FUTURE_SOURCE', $1::jsonb) AS ok", [all]);
      assert.equal(unknown.rows[0]?.ok, false, "a source nobody named fails closed");
    });

    test("no accountId lists the accounts; an account with no movement is an empty, reconciled statement", async () => {
      const f = await fixture();
      const list = await view(f.creator, {});
      assert.equal(list.statement, null);
      assert.deepEqual(new Set(list.accounts.map((a) => a.id)), new Set([f.usdSafe, f.secondSafe, f.afnSafe, f.saraf]));
      const empty = await statement(f.creator, f.usdSafe);
      assert.deepEqual([empty.opening.native, empty.closing.native, empty.lines, empty.totals.movementCount, empty.reconciliation.matches], ["0", "0", [], 0, true]);
    });

    test("a USD Safe: opening, every movement in order with its running balance, closing equal to the one Treasury balance", async () => {
      const f = await fixture();
      await populate(f);
      const sept = await statement(f.creator, f.usdSafe);
      assert.equal(sept.opening.native, "0");
      // 2,500 + 700 + 1,000 - 200 - 50 - 100 - 300 + 100 - 20 + 20 = 3,650.
      assert.equal(Number(sept.closing.native), 3650);
      assert.equal(Number(sept.lines.at(-1)?.balance), 3650, "the last running balance is the closing");
      const book = await h.pool.query<{ book: string }>("SELECT book_balance::text AS book FROM abos.treasury_account_balances($1, '2026-09-30', $2)", [f.e, f.usdSafe]);
      assert.equal(Number(book.rows[0]?.book), Number(sept.closing.native), "the closing is the canonical Treasury balance");
      let running = Number(sept.opening.native);
      for (const l of sept.lines) {
        running += Number(l.moneyIn) - Number(l.moneyOut);
        assert.equal(Number(l.balance), running, "each line carries the running balance");
        assert.equal(Number(l.baseAmount), Number(l.moneyIn) - Number(l.moneyOut), "a USD movement has the same accounting amount");
        assert.ok(Number(l.moneyIn) === 0 || Number(l.moneyOut) === 0, "a movement is in or out, never both");
      }
      assert.equal(Number(sept.opening.native) + Number(sept.totals.moneyIn) - Number(sept.totals.moneyOut), Number(sept.closing.native));
      const opening = line(sept.lines, "Opening balance");
      assert.deepEqual([opening?.kind, opening?.moneyIn, opening?.source.reference, opening?.source.description], ["OPENING", "2500.00", "TS-OPEN", "Synthetic opening note"]);
      const rent = line(sept.lines, "Money received");
      assert.deepEqual([rent?.kind, rent?.source.counterparty, rent?.source.reference, rent?.source.description], ["EXTERNAL", "Synthetic tenant", "TS-RENT", "Synthetic rent"]);
      assert.equal(sept.lines.find((l) => l.source.reference === "TS-EXP")?.source.detail?.en, "TS-EXP — Synthetic supplies");
      assert.equal(sept.lines.every((l) => l.currency === "USD" && l.fx === null), true);
    });

    test("period boundaries: September's closing is October's opening; a date range and a month agree; August is empty", async () => {
      const f = await fixture();
      await populate(f);
      const sept = await statement(f.creator, f.usdSafe);
      const month = await statement(f.creator, f.usdSafe, { periodId: f.world.accountingPeriodId });
      assert.deepEqual([month.closing, month.lines.length], [sept.closing, sept.lines.length]);
      const october = await statement(f.creator, f.usdSafe, { from: "2026-10-01", to: "2026-10-31" });
      assert.deepEqual([october.opening, october.closing, october.lines], [sept.closing, sept.closing, []]);
      const august = await statement(f.creator, f.usdSafe, { from: "2026-08-01", to: "2026-08-31" });
      assert.deepEqual([august.opening.native, august.closing.native, august.lines], ["0", "0", []]);
      const firstHalf = await statement(f.creator, f.usdSafe, { from: "2026-09-01", to: "2026-09-10" });
      const secondHalf = await statement(f.creator, f.usdSafe, { from: "2026-09-11", to: "2026-09-30" });
      assert.deepEqual(secondHalf.opening, firstHalf.closing, "the day after the end carries the closing forward");
      assert.equal(firstHalf.lines.length + secondHalf.lines.length, sept.lines.length, "the last day is in, the next day is out");
    });

    test("a transfer is money out of one account and money in to the other, marked internal, and its reversal stays internal", async () => {
      const f = await fixture();
      const j = await populate(f);
      const source = await statement(f.creator, f.usdSafe);
      const destination = await statement(f.creator, f.secondSafe);
      const out = source.lines.find((l) => l.source.reference === "TS-MOVE");
      const incoming = destination.lines.find((l) => l.source.reference === "TS-MOVE");
      assert.deepEqual([out?.moneyOut, out?.moneyIn, out?.kind, out?.transferPeer?.en], ["300.00", "0", "TRANSFER", "Synthetic petty cash"]);
      assert.deepEqual([incoming?.moneyIn, incoming?.moneyOut, incoming?.kind, incoming?.transferPeer?.en], ["300.00", "0", "TRANSFER", "Synthetic main Safe"]);
      const reversed = source.lines.find((l) => l.journalId === j.transferReversal);
      assert.deepEqual([reversed?.kind, reversed?.isReversal, reversed?.moneyIn], ["TRANSFER", true, "20.00"], "the reversal of a transfer is still internal");
      // 300 + 20 out and the 20 back: none of it is outside money.
      assert.deepEqual([Number(source.totals.transfersOut), Number(source.totals.transfersIn)], [320, 20]);
      assert.deepEqual([Number(destination.totals.transfersIn), Number(destination.totals.transfersOut)], [320, 20]);
      assert.equal(Number(destination.closing.native), 300);
    });

    test("a reversal keeps both movements visible: the original marked reversed, the reversal linked, the running balance through both", async () => {
      const f = await fixture();
      const j = await populate(f);
      const sept = await statement(f.creator, f.usdSafe);
      const original = sept.lines.find((l) => l.journalId === j.payment);
      const reversal = sept.lines.find((l) => l.journalId === j.reversal);
      assert.deepEqual([original?.moneyOut, original?.reversedBy?.journalId, original?.isReversal], ["100.00", j.reversal, false]);
      assert.deepEqual([reversal?.moneyIn, reversal?.reverses?.journalId, reversal?.isReversal, reversal?.source.label.en], ["100.00", j.payment, true, "Reversal"]);
      assert.equal(Number(reversal?.balance), Number(sept.lines[sept.lines.indexOf(reversal as Line) - 1]?.balance) + 100);
      assert.deepEqual([Number(sept.totals.reversalsIn), Number(sept.totals.reversalsOut)], [120, 0]);
    });

    test("an AFN Safe: AFN is the balance; USD is secondary, from the frozen conversion, with the rate and policy kept", async () => {
      const f = await fixture();
      const j = await populate(f);
      const afn = await statement(f.creator, f.afnSafe);
      assert.equal(afn.account.currencyCode, "AFN");
      assert.deepEqual([Number(afn.closing.native), Number(afn.closing.base)], [5600, 80], "5,600 AFN is the balance; 80 USD is its accounting value");
      const incoming = afn.lines[0]; const outgoing = afn.lines[1];
      assert.deepEqual([incoming?.currency, incoming?.moneyIn, Number(incoming?.baseAmount), incoming?.fx?.rate, incoming?.fx?.unitCurrency, incoming?.fx?.quoteCurrency,
        incoming?.fx?.rateDate, incoming?.fx?.source], ["AFN", "7000.00", 100, "70", "USD", "AFN", "2026-09-14", "MARKET"]);
      assert.ok(incoming?.fx?.policyVersionId, "the FX policy version is kept");
      assert.ok(incoming?.fx?.roundingMode, "the rounding rule is kept");
      assert.deepEqual([outgoing?.moneyOut, Number(outgoing?.baseAmount), outgoing?.fx?.rateDate], ["1400.00", -20, "2026-09-15"]);
      assert.equal(afn.reconciliation.matches, true);
      // Reversing the AFN payment restores both figures exactly, at the rate it was posted at: nothing is revalued.
      await call("finance_journal_reversal_direct", f.creator, { journalId: j.afnPayment, reason: "Synthetic wrong AFN supplier", ...keys() });
      const reversed = await statement(f.creator, f.afnSafe);
      assert.deepEqual([Number(reversed.closing.native), Number(reversed.closing.base), reversed.reconciliation.matches], [7000, 100, true]);
    });

    test("a reversed opening balance nets naturally: the report's opening is posted movements, never the opening balance record", async () => {
      const f = await fixture();
      const opening = await call<{ journalId: string }>("treasury_opening_balance_record", f.creator, { treasuryAccountId: f.secondSafe, amount: "900.00", currencyCode: "USD",
        asOfDate: "2026-09-02", reference: "TS-OPEN-2", note: null, ...keys() });
      const before = await statement(f.creator, f.secondSafe, { from: "2026-09-03", to: "2026-09-30" });
      assert.deepEqual([before.opening.native, before.lines], ["900.00", []], "a later report opens with the posted movement");
      const reversal = await call<{ reversalJournalId: string }>("finance_journal_reversal_direct", f.creator, { journalId: opening.journalId, reason: "Synthetic wrong opening balance", ...keys() });
      const sept = await statement(f.creator, f.secondSafe);
      assert.deepEqual(sept.lines.map((l) => [l.moneyIn, l.moneyOut, l.balance, l.kind, l.isReversal]), [["900.00", "0", "900.00", "OPENING", false], ["0", "900.00", "0.00", "OPENING", true]]);
      assert.equal(sept.lines[0]?.reversedBy?.journalId, reversal.reversalJournalId);
      assert.equal(Number(sept.closing.native), 0);
      const october = await statement(f.creator, f.secondSafe, { from: "2026-10-01", to: "2026-10-31" });
      assert.deepEqual([Number(october.opening.native), october.lines], [0, []], "after the reversal the next period opens at zero");
      const card = (await call<{ safes: { id: string; balance: { book: string; opening: string } }[] }>("treasury_safes_workspace", f.creator)).safes.find((s) => s.id === f.secondSafe);
      assert.deepEqual([Number(card?.balance.book), Number(card?.balance.opening)], [0, 0], "the Safes page agrees");
    });

    test("a Saraf keeps its negative balance, line by line and at the close", async () => {
      const f = await fixture();
      await populate(f);
      const saraf = await statement(f.creator, f.saraf);
      assert.equal(saraf.account.accountType, "SARAF");
      assert.deepEqual(saraf.lines.map((l) => Number(l.balance)), [100, -300]);
      assert.deepEqual([Number(saraf.closing.native), Number(saraf.closing.base)], [-300, -300]);
      assert.equal(saraf.reconciliation.matches, true);
    });

    test("cross-report reconciliation: every account agrees with the ledger, the trial balance and the account statement", async () => {
      const f = await fixture();
      await populate(f);
      const tb = await call<{ accounts: { accountId: string; endingDebit: string; endingCredit: string }[]; balanced: boolean }>("finance_trial_balance", f.creator, SEPT);
      assert.equal(tb.balanced, true);
      const accounts = [[f.usdSafe, f.world.cashLedgerAccountId], [f.secondSafe, f.secondLedger], [f.afnSafe, f.afnLedger], [f.saraf, f.sarafLedger]] as const;
      for (const [safe, ledgerId] of accounts) {
        const s = await statement(f.creator, safe);
        assert.deepEqual([s.reconciliation.matches, Number(s.reconciliation.difference)], [true, 0], "the statement proves itself against the ledger");
        const row = tb.accounts.find((r) => r.accountId === ledgerId);
        assert.equal(Number(row?.endingDebit ?? 0) - Number(row?.endingCredit ?? 0), Number(s.closing.base), "trial balance = Treasury accounting value");
        const account = await call<{ closing: { net: string } }>("finance_account_statement", f.creator, { accountId: ledgerId, ...SEPT });
        assert.equal(Number(account.closing.net), Number(s.closing.base), "account statement = Treasury accounting value");
        const raw = await h.pool.query<{ n: string }>(`SELECT COALESCE(sum(l.base_debit) - sum(l.base_credit), 0)::text AS n FROM abos.journal_lines l JOIN abos.journals j ON j.id = l.journal_id
          WHERE l.ledger_account_id = $1 AND j.status = 'POSTED' AND j.accounting_effective_date <= '2026-09-30'`, [ledgerId]);
        assert.equal(Number(raw.rows[0]?.n), Number(s.closing.base), "posted journal lines are the truth");
      }
    });

    test("the Safes workspace shows the same balance and accounting value as the statement", async () => {
      const f = await fixture();
      await populate(f);
      const workspace = await call<{ safes: { id: string; balance: { book: string; baseBook: string } }[] }>("treasury_safes_workspace", f.creator);
      for (const safe of [f.usdSafe, f.afnSafe, f.saraf]) {
        const card = workspace.safes.find((s) => s.id === safe);
        const s = await statement(f.creator, safe, { from: "2026-01-01", to: "2026-12-31" });
        assert.deepEqual([Number(card?.balance.book), Number(card?.balance.baseBook)], [Number(s.closing.native), Number(s.closing.base)]);
      }
    });

    test("a Safe reader without shareholder permission: the correct 700 and balance, and nothing about the capital", async () => {
      const f = await fixture();
      const j = await populate(f);
      const full = await statement(f.creator, f.usdSafe);
      const masked = await statement(f.safeReader, f.usdSafe);
      assert.deepEqual([masked.closing, masked.totals], [full.closing, full.totals], "confidentiality never changes money");
      assert.deepEqual(masked.lines.map((l) => l.balance), full.lines.map((l) => l.balance));
      const capital = line(masked.lines, "Capital received");
      assert.deepEqual([capital?.moneyIn, capital?.source.id, capital?.source.route, capital?.source.counterparty, capital?.source.reference, capital?.source.description,
        capital?.source.detailRestricted, capital?.journalId], ["700.00", null, null, null, null, null, true, null]);
      assert.match(capital?.journalReference ?? "", /^JRN-[0-9A-F]{12}$/);
      const receipt = await sourceId(j.capital);
      assertAbsent(masked, ["Synthetic Private Holder", "TS-CAP-PRIVATE", "Synthetic private capital note", receipt, embedded(receipt), j.holder, "CAP-", "/shareholders"], "a Safe reader");
      // Treasury records are theirs to read; expenses are not.
      assert.equal(line(masked.lines, "Money received")?.source.counterparty, "Synthetic tenant");
      const expense = masked.lines.find((l) => l.source.label.en === "Expense" && !l.restricted);
      assert.deepEqual([expense?.source.id, expense?.source.reference, expense?.source.detail ?? null], [null, null, null]);
      assert.equal(masked.canOpenLedger, false);
      assert.equal(masked.account.ledgerAccount, null);
      assert.equal(masked.lines.every((l) => l.journalId === null), true, "no ledger link without report permission");
    });

    test("a report-only reader: all the mathematics, and generic labels for every source", async () => {
      const f = await fixture();
      const j = await populate(f);
      const full = await statement(f.creator, f.usdSafe);
      const reader = await statement(f.reportReader, f.usdSafe);
      assert.deepEqual([reader.closing, reader.totals, reader.reconciliation], [full.closing, full.totals, full.reconciliation]);
      const secrets = ["Synthetic Private Holder", "TS-CAP-PRIVATE", "Synthetic tenant", "Synthetic rent", "TS-RENT", "Synthetic supplier", "TS-PAY", "TS-EXP", "TS-OPEN", "Synthetic site supplies"];
      assertAbsent(reader, secrets, "a report-only reader");
      for (const id of [await sourceId(j.capital), await sourceId(j.receipt), await sourceId(j.payment), await sourceId(j.transfer)]) assertAbsent(reader, [id, embedded(id)], "a report-only reader");
      assert.equal(reader.lines.every((l) => l.transferPeer === null), true);
      assert.equal(reader.lines.find((l) => l.kind === "TRANSFER")?.source.label.en, "Transfer between accounts", "the kind is still clear");
      assert.ok(reader.lines.every((l) => l.restricted || l.journalId !== null), "the journal itself stays reachable");
    });

    test("the same rule holds in the existing reports: account statement, journal detail, sources, reversals and the Safes page", async () => {
      const f = await fixture();
      const j = await populate(f);
      const receipt = await sourceId(j.capital);
      const forbidden = ["Synthetic Private Holder", "TS-CAP-PRIVATE", "Synthetic private capital note", receipt, embedded(receipt), j.holder];
      assertAbsent(await call("finance_account_statement", f.reportReader, { accountId: f.world.cashLedgerAccountId, ...SEPT }), forbidden, "the account statement");
      assertAbsent(await call("finance_journal_detail", f.reportReader, j.capital), forbidden, "the journal detail");
      const sources = await runtime.query<{ value: Record<string, { journalReference: string }> }>("SELECT abos.finance_journal_sources($1,$2,$3,$4::uuid[]) AS value",
        [f.reportReader.proof, f.reportReader.runtimeDigest, f.reportReader.tokenDigest, [j.capital, j.receipt]]);
      assertAbsent(sources.rows[0]?.value, forbidden, "the General Ledger sources");
      assert.match(sources.rows[0]?.value[j.capital]?.journalReference ?? "", /^JRN-[0-9A-F]{12}$/);
      assertAbsent(await call("finance_journal_reversal_workspace", f.requester), forbidden, "the reversal list");
      assertAbsent(await call("treasury_safes_workspace", f.safeReader), forbidden, "the Safes page");
      const detail = await call<{ reference: string }>("finance_journal_detail", f.reportReader, j.capital);
      assert.match(detail.reference, /^JRN-[0-9A-F]{12}$/);
      const expenseId = await sourceId(j.expense);
      const line = (await call<{ lines: { journalId: string; source: Source }[] }>("finance_account_statement", f.reportReader, { accountId: f.expenseLedger, ...SEPT }))
        .lines.find((l) => l.journalId === j.expense);
      assert.deepEqual([line?.source.label.en, line?.source.id, line?.source.route, line?.source.counterparty, line?.source.detailRestricted], ["Expense", null, null, null, true]);
      assert.notEqual(expenseId, "");
      // A person holding the permission keeps everything.
      const named = await call<{ reference: string; source: Source }>("finance_journal_detail", f.creator, j.capital);
      assert.match(named.reference, new RegExp(`^CAP-20260906-${embedded(receipt)}`));
      assert.deepEqual([named.source.counterparty, named.source.reference, named.source.description], ["Synthetic Private Holder", "TS-CAP-PRIVATE", "Synthetic private capital note"]);
    });

    test("a movement outside the reader's scope keeps its date and amount and hides everything else", async () => {
      const f = await fixture();
      const j = await populate(f);
      const named = await statement(f.creator, f.usdSafe);
      const reader = await statement(f.safeReader, f.usdSafe);
      assert.equal(named.lines.find((l) => l.journalId === j.restricted)?.restricted, false, "the creator holds the project");
      const hidden = reader.lines.filter((l) => l.restricted);
      assert.equal(hidden.length, 1);
      assert.deepEqual([hidden[0]?.moneyOut, hidden[0]?.source.type, hidden[0]?.journalReference, hidden[0]?.journalId], ["50.00", "RESTRICTED", null, null]);
      const sources = await runtime.query<{ value: Record<string, { type: string; journalReference: string | null }> }>("SELECT abos.finance_journal_sources($1,$2,$3,$4::uuid[]) AS value",
        [f.reportReader.proof, f.reportReader.runtimeDigest, f.reportReader.tokenDigest, [j.restricted]]);
      assert.deepEqual([sources.rows[0]?.value[j.restricted]?.type, sources.rows[0]?.value[j.restricted]?.journalReference], ["RESTRICTED", null], "the General Ledger gets no reference either");
      assertAbsent(reader, ["TS-SECRET", "Synthetic restricted works"], "a reader outside the project");
      assert.deepEqual(reader.closing, named.closing);
    });

    test("a person responsible for one Safe opens that Safe only, and reads its Treasury sources", async () => {
      const f = await fixture();
      await populate(f);
      await assert.rejects(() => view(f.responsible, {}), /current authority is missing treasury\.safe\.read/);
      await h.pool.query(`INSERT INTO abos.operational_treasury_account_responsibles (legal_entity_id, operational_treasury_account_id, user_account_id, assigned_by_user_account_id)
        VALUES ($1,$2,$3,$4)`, [f.e, f.secondSafe, f.responsibleId, f.world.bootstrapUserId]);
      const list = await view(f.responsible, {});
      assert.deepEqual(list.accounts.map((a) => a.id), [f.secondSafe]);
      const own = await statement(f.responsible, f.secondSafe);
      assert.equal(Number(own.closing.native), 300);
      assert.equal(own.lines.find((l) => l.kind === "TRANSFER")?.source.reference, "TS-MOVE");
      assert.equal(own.lines.every((l) => l.transferPeer === null), true, "the name of a Safe they may not open stays hidden");
      await assert.rejects(() => view(f.responsible, { accountId: f.usdSafe, ...SEPT }), /Treasury account was not found in this legal entity/);
    });

    test("another company, a synthetic session, bad requests and a closed financial year", async () => {
      const f = await fixture();
      await populate(f);
      await assert.rejects(() => view(f.creator, { accountId: randomUUID(), ...SEPT }), /Treasury account was not found in this legal entity/);
      await assert.rejects(() => view(f.creator, { accountId: "not-a-uuid", ...SEPT }), /choose a valid account/);
      await assert.rejects(() => view(f.creator, { accountId: f.usdSafe, surprise: true, ...SEPT }), /unknown report fields/);
      await assert.rejects(() => view(f.creator, { accountId: f.usdSafe }), /choose one: a period, a date range or an as-of date/);
      await assert.rejects(() => view(f.creator, { accountId: f.usdSafe, from: "2026-09-30", to: "2026-09-01" }), /choose a valid period or valid dates/);
      const other = randomUUID();
      await h.pool.query(`INSERT INTO abos.legal_entities (id, company_id, code, name, base_currency_code, currency_policy_status)
        VALUES ($1,$2,$3,'Synthetic Other Company','USD','APPROVED')`, [other, f.world.companyId, `TS2-${other.slice(0, 8)}`]);
      const foreignSafe = await treasury({ ...f.world, legalEntityId: other }, "Synthetic foreign Safe", "SAFE", "USD", await ledger(other, "OTH-CASH", "ASSET", "CASH"));
      await assert.rejects(() => view(f.creator, { accountId: foreignSafe, ...SEPT }), /Treasury account was not found in this legal entity/);
      assert.equal((await view(f.creator, {})).accounts.some((a) => a.id === foreignSafe), false, "another company's Safe is not listed");
      await h.pool.query(`INSERT INTO abos.sandbox_authorizations(singleton,environment,configuration_state,policy_version_id,
        runtime_marker,authorized_by_user_account_id,authorized_at,expires_at)
        VALUES(true,'test','SYNTHETIC_TEST_ONLY',$1,$2,$3,clock_timestamp(),clock_timestamp()+interval '1 day')`, [f.world.policyVersionId, MARKER, f.world.bootstrapUserId]);
      await h.pool.query("INSERT INTO abos.sandbox_legal_entity_scopes(legal_entity_id,base_currency_code,authorized_by_user_account_id) VALUES($1,'USD',$2)",
        [f.e, f.world.bootstrapUserId]);
      const developer = session((await new SandboxAuthenticator(h.executor, SYNTHETIC_AUTH_CONFIGURATION).issueSession({
        userAccountId: f.world.intentCreatorId as never, legalEntityId: f.e as never })).token);
      await assert.rejects(() => view(developer, { accountId: f.usdSafe, ...SEPT }), /sign in with an active account/);
      // A closed financial year reports the same figures forever.
      await h.pool.query("DELETE FROM abos.sandbox_legal_entity_scopes");
      await h.pool.query("DELETE FROM abos.sandbox_authorizations");
      const before = await statement(f.creator, f.usdSafe);
      const year = randomUUID();
      await h.pool.query(`INSERT INTO abos.fiscal_years(id,legal_entity_id,calendar_kind,fiscal_year,label_en,label_fa,starts_on,ends_on,generated_by_user_account_id)
        VALUES($1,$2,'GREGORIAN',2026,'FY 2026','سال مالی ۲۰۲۶','2026-01-01','2026-12-31',$3)`, [year, f.e, f.world.bootstrapUserId]);
      await call("finance_financial_year_close", f.manager, { fiscalYearId: year, correlationId: randomUUID() });
      const after = await statement(f.creator, f.usdSafe);
      assert.deepEqual([after.opening, after.closing, after.totals, after.lines.map((l) => l.balance)],
        [before.opening, before.closing, before.totals, before.lines.map((l) => l.balance)]);
    });

    test("the statement writes nothing: no journal, no line and no row from reading it", async () => {
      const f = await fixture();
      await populate(f);
      const count = async () => (await h.pool.query<{ j: string; l: string; s: string }>(
        "SELECT (SELECT count(*) FROM abos.journals)::text j, (SELECT count(*) FROM abos.journal_lines)::text l, (SELECT count(*) FROM abos.subledger_entries)::text s")).rows[0];
      const before = await count();
      await statement(f.creator, f.usdSafe); await statement(f.safeReader, f.saraf); await view(f.creator, {});
      assert.deepEqual(await count(), before);
      const definer = await h.pool.query<{ owner: string; volatile: string; definer: boolean }>(`SELECT p.proowner::regrole::text AS owner, p.provolatile AS volatile, p.prosecdef AS definer
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'abos' AND p.proname = 'treasury_account_statement'`);
      assert.deepEqual([definer.rows[0]?.owner, definer.rows[0]?.definer], ["abos_v1_operational_finance_owner", true]);
    });
  });
}
