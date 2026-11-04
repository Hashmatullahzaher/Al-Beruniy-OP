import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import pg from "pg";

import { PostgresExecutor } from "@abos/persistence";
import { identityDatabaseProof } from "@abos/sandbox-auth";

import { addSyntheticSaraf, grant } from "./currency-fixtures.ts";
import { databaseUrl, openHarness, resetSchema, type Harness } from "./harness.ts";
import { issueOperationalSession } from "./operational-session.ts";
import { seedSyntheticWorld, SYNTHETIC_AUTH_CONFIGURATION, type SyntheticWorld } from "./synthetic-world.ts";

/**
 * One synthetic company for the financial reports. Setup rows are inserted directly; every business event goes through the real
 * product functions on a restricted login, so the reports are tested against what the product actually posts.
 */
const MARKER = SYNTHETIC_AUTH_CONFIGURATION.runtimeMarker;
const POLICIES = ["OTHER_INCOME", "TREASURY_TRANSFER", "SUPPLIER_PAYMENT", "SALARY_PAYMENT", "EXPENSE", "SHAREHOLDER_CAPITAL_RECEIPT"];

export const SEPT = { from: "2026-09-01", to: "2026-09-30" } as const;
export type Session = { proof: string; runtimeDigest: string; tokenDigest: string; token: string };

export function session(token: string): Session {
  return { token, proof: identityDatabaseProof(SYNTHETIC_AUTH_CONFIGURATION.signingSecret),
    runtimeDigest: createHash("sha256").update(token).digest("hex"),
    tokenDigest: createHmac("sha256", SYNTHETIC_AUTH_CONFIGURATION.signingSecret).update(token).digest("hex") };
}

/** A source id as it appears inside CAP-, RC-, PY-, TR- and OB- references. */
export const embedded = (id: string) => id.replaceAll("-", "").toUpperCase();

/** Reads a whole response as text, so a leak in any field fails, not only the fields a screen shows. */
export function assertAbsent(value: unknown, forbidden: readonly string[], who: string): void {
  const text = JSON.stringify(value);
  for (const word of forbidden) assert.equal(text.includes(word), false, `${who} must not receive ${word}`);
}

export const keys = () => ({ idempotencyKey: `rw-${randomUUID()}`, correlationId: randomUUID() });

export class ReportDatabase {
  h!: Harness;
  runtime!: PostgresExecutor;
  private pool!: pg.Pool;
  private readonly login = `abos_rw_${randomUUID().replaceAll("-", "")}`;

  async open(): Promise<void> {
    const target = new URL(databaseUrl() ?? "");
    assert.notEqual(target.port, "55432", "preserved runtime PostgreSQL is forbidden");
    assert.notEqual(decodeURIComponent(target.pathname.slice(1)), "abos_v1_local_review");
    this.h = await openHarness(MARKER);
    await resetSchema(this.h.pool);
    const password = `disposable-${randomUUID()}`;
    await this.h.pool.query(`CREATE ROLE ${this.login} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${password}'`);
    const url = new URL(databaseUrl() ?? ""); url.username = this.login; url.password = password;
    this.pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
    this.runtime = new PostgresExecutor(this.pool, { runtimeMarker: MARKER });
  }

  async close(): Promise<void> {
    await this.pool?.end();
    if (this.h !== undefined) { await resetSchema(this.h.pool); await this.h.pool.query(`DROP ROLE IF EXISTS ${this.login}`); await this.h.close(); }
  }

  /** Calls a report or command function exactly as the application does, as the restricted runtime. */
  async call<T>(name: string, s: Session, ...extra: unknown[]): Promise<T> {
    const params = [s.proof, s.runtimeDigest, s.tokenDigest, ...extra.map((x) => (typeof x === "object" && x !== null ? JSON.stringify(x) : x))];
    const marks = params.map((_, i) => `$${i + 1}${i >= 3 && typeof extra[i - 3] === "object" && extra[i - 3] !== null ? "::jsonb" : ""}`);
    const result = await this.runtime.query<{ value: T }>(`SELECT abos.${name}(${marks.join(",")}) AS value`, params);
    assert.ok(result.rows[0]); return result.rows[0].value;
  }

  private async ledger(entity: string, code: string, type: string, control: string | null, currency = "USD"): Promise<string> {
    const id = randomUUID();
    await this.h.pool.query(`INSERT INTO abos.ledger_accounts (id,legal_entity_id,account_code,account_name,account_type,control_account_type,posting_allowed,account_currency_code,status)
      VALUES ($1,$2,$3,$4,$5,$6,true,$7,'ACTIVE')`, [id, entity, code, `Synthetic ${code}`, type, control, currency]);
    return id;
  }

  private async treasury(world: SyntheticWorld, name: string, type: string, currency: string, ledgerId: string, saraf: string | null = null): Promise<string> {
    const id = randomUUID();
    await this.h.pool.query(`INSERT INTO abos.operational_treasury_accounts (id,legal_entity_id,name_en,account_type,currency_code,ledger_account_id,saraf_business_party_id,
      status,version,created_by_user_account_id,last_changed_by_user_account_id) VALUES($1,$2,$3,$4,$5,$6,$7,'ACTIVE',1,$8,$8)`,
    [id, world.legalEntityId, name, type, currency, ledgerId, saraf, world.bootstrapUserId]);
    return id;
  }

  /** A person holding exactly these permissions. */
  private async person(world: SyntheticWorld, name: string, permissions: readonly string[]): Promise<Session> {
    const id = randomUUID();
    await this.h.pool.query("INSERT INTO abos.user_accounts (id, login_identifier, display_name, status) VALUES ($1,$2,$3,'ACTIVE')",
      [id, `${name.replaceAll(" ", ".").toLowerCase()}.${id.slice(0, 8)}@synthetic.invalid`, `Synthetic ${name}`]);
    await grant(this.h.executor, world, id, [...permissions]);
    return session((await issueOperationalSession(this.h, id, world.legalEntityId)).token);
  }

  async company() {
    const { h } = this;
    await resetSchema(h.pool);
    await h.pool.query(`GRANT abos_e1_runtime TO ${this.login}`);
    const world = await seedSyntheticWorld(h.executor);
    await h.pool.query("DELETE FROM abos.sandbox_legal_entity_scopes");
    await h.pool.query("DELETE FROM abos.sandbox_authorizations");
    const e = world.legalEntityId; const u = world.bootstrapUserId;
    await grant(h.executor, world, world.intentCreatorId, ["treasury.safe.read", "treasury.receipt.record", "treasury.transfer.record", "treasury.payment.record",
      "treasury.opening-balance.record", "finance.expense.create", "finance.expense.read", "finance.report.operational.read", "finance.reversal.direct", "finance.fx-policy.manage",
      "shareholder.setup.manage", "shareholder.read", "shareholder.capital-receipt.read", "shareholder.capital-receipt.record", "finance.capital-receipt.prepare",
      "finance.capital-receipt.post", "finance.temporary-funding.record", "finance.temporary-funding.read"]);
    await grant(h.executor, world, world.treasuryApproverId, ["finance.temporary-funding.approve", "finance.temporary-funding.read"]);
    await grant(h.executor, world, world.treasuryManagerId, ["finance.temporary-funding.configure"]);
    await grant(h.executor, world, world.countConfirmerId, ["admin.users.manage", "admin.roles.manage"]);
    await grant(h.executor, world, world.treasuryReconcilerId, ["finance.temporary-funding.settle", "finance.temporary-funding.read"]);
    await grant(h.executor, world, world.counterId, ["finance.temporary-funding.settle-approve"]);
    await grant(h.executor, world, world.reverserId, ["finance.period.manage", "finance.report.operational.read"]);
    for (const workflow of POLICIES) {
      await h.pool.query(`INSERT INTO abos.finance_workflow_policy_versions (id,legal_entity_id,workflow_type,version,approval_required,configured_by_user_account_id,change_reason)
        VALUES($1,$2,$3,1,false,$4,'Synthetic Simple Mode setting')`, [randomUUID(), e, workflow, u]);
    }
    await h.pool.query(`INSERT INTO abos.finance_workflow_policy_versions (id,legal_entity_id,workflow_type,version,approval_required,configured_by_user_account_id,change_reason)
      VALUES($1,$2,'TEMPORARY_FUNDING',1,true,$3,'Synthetic funding route')`, [randomUUID(), e, u]);
    const usdSafe = await this.treasury(world, "Synthetic main Safe", "SAFE", "USD", world.cashLedgerAccountId);
    const secondLedger = await this.ledger(e, "SYN-RW-CASH-2", "ASSET", "CASH");
    const secondSafe = await this.treasury(world, "Synthetic petty cash", "PETTY_CASH", "USD", secondLedger);
    const afnLedger = await this.ledger(e, "SYN-RW-CASH-AFN", "ASSET", "CASH", "AFN");
    const afnSafe = await this.treasury(world, "Synthetic AFN Safe", "SAFE", "AFN", afnLedger);
    const sarafLedger = await this.ledger(e, "SYN-RW-SARAF", "ASSET", "SARAF");
    const saraf = await this.treasury(world, "Synthetic Saraf", "SARAF", "USD", sarafLedger, await addSyntheticSaraf(h.executor, world));
    const revenue = await this.ledger(e, "SYN-RW-INC", "REVENUE", null);
    const payable = await this.ledger(e, "SYN-RW-PAY", "LIABILITY", "AP");
    const expenseLedger = await this.ledger(e, "SYN-RW-EXP", "EXPENSE", null);
    const equity = await this.ledger(e, "SYN-RW-OBE", "EQUITY", "OPENING_BALANCE_EQUITY");
    const fxAccount = await this.ledger(e, "SYN-RW-FX", "EXPENSE", "FX_DIFFERENCE");
    const loanLedger = await this.ledger(e, "SYN-RW-LOAN", "LIABILITY", "TEMPORARY_FUNDING_PAYABLE");
    const category = randomUUID();
    await h.pool.query(`INSERT INTO abos.operational_expense_categories (id,legal_entity_id,category_code,name_en,ledger_account_id,status,version,created_by_user_account_id,last_changed_by_user_account_id)
      VALUES($1,$2,'SYN-RW','Synthetic supplies',$3,'ACTIVE',1,$4,$4)`, [category, e, expenseLedger, u]);
    const project = randomUUID();
    await h.pool.query("INSERT INTO abos.projects (id, legal_entity_id, code, name, active) VALUES ($1,$2,'RW-P','Synthetic restricted project',true)", [project, e]);
    await h.pool.query("INSERT INTO abos.user_scope_grants (user_account_id, legal_entity_id, scope_kind, scope_id, granted_by_user_account_id) VALUES ($1,$2,'PROJECT',$3,$4)",
      [world.intentCreatorId, e, project, u]);
    for (const day of ["2026-09-14", "2026-09-15", "2026-09-16"]) {
      await h.pool.query(`INSERT INTO abos.exchange_rates (id,legal_entity_id,rate_date,rate_source,unit_currency_code,quote_currency_code,rate_value,note,entered_by_user_account_id)
        VALUES ($1,$2,$3,'MARKET','USD','AFN','70','Synthetic rate',$4)`, [randomUUID(), e, day, u]);
    }
    const provider = randomUUID();
    await h.pool.query("INSERT INTO abos.business_parties (id, legal_entity_id, display_name, external_reference, status) VALUES ($1,$2,'Synthetic Outside Lender',$3,'ACTIVE')",
      [provider, e, `SYN-${provider.slice(0, 8)}`]);
    const supplier = randomUUID();
    await h.pool.query("INSERT INTO abos.business_parties (id, legal_entity_id, display_name, external_reference, status) VALUES ($1,$2,'Synthetic supplier',$3,'ACTIVE')",
      [supplier, e, `SYN-${supplier.slice(0, 8)}`]);
    await h.pool.query("INSERT INTO abos.business_party_roles (business_party_id, role_code, effective_from) VALUES ($1,'SUPPLIER','2026-01-01')", [supplier]);
    const s = async (user: string) => session((await issueOperationalSession(h, user, e)).token);
    return { world, e, u, supplier, usdSafe, secondSafe, secondLedger, afnSafe, afnLedger, saraf, sarafLedger, revenue, payable, expenseLedger, equity, fxAccount, loanLedger, category, project, provider,
      creator: await s(world.intentCreatorId), fundingApprover: await s(world.treasuryApproverId), configurer: await s(world.treasuryManagerId), identityAdmin: await s(world.countConfirmerId),
      settler: await s(world.treasuryReconcilerId), settleApprover: await s(world.counterId), manager: await s(world.reverserId),
      safeReader: await this.person(world, "Safe Reader", ["treasury.safe.read"]),
      reportReader: await this.person(world, "Report Reader", ["finance.report.operational.read"]),
      capitalReader: await this.person(world, "Capital Reader", ["shareholder.read"]),
      loanReader: await this.person(world, "Loan Reader", ["finance.temporary-funding.read"]),
      nobody: await this.person(world, "No Report Access", ["finance.expense.create"]) };
  }

  private async identity(f: ReportCompany, party: string): Promise<void> {
    await this.call("configure_temporary_funding_provider_identity", f.identityAdmin, { businessPartyId: party, expectedVersion: 0, identityMode: "NO_ABOS_USER", userAccountId: null,
      evidenceDocumentReference: "SYN-IDENTITY", evidenceSha256: "c".repeat(64), changeReason: "Synthetic provider identity", idempotencyKey: `pid-${randomUUID()}`, correlationId: randomUUID() });
  }

  /** A month of every kind of event. The comments give the expected figures, which the tests assert. */
  async populate(f: ReportCompany) {
    const c = f.creator; const call = this.call.bind(this);
    await call("configure_temporary_funding_mapping", f.configurer, { ledgerAccountId: f.loanLedger, evidenceDocumentReference: "SYN-AUTH", evidenceSha256: "a".repeat(64),
      changeReason: "Synthetic payable mapping", idempotencyKey: `cfg-${randomUUID()}`, correlationId: randomUUID() });
    await call("finance_fx_policy_set", c, { currencyCode: "AFN", effectiveFrom: "2026-09-01", baseScale: 2, roundingMode: "HALF_UP", fxDifferenceLedgerAccountId: f.fxAccount,
      reason: "Synthetic FX policy decision", expectedVersion: 0, correlationId: randomUUID() });
    await call("treasury_opening_balance_record", c, { treasuryAccountId: f.usdSafe, amount: "2500.00", currencyCode: "USD", asOfDate: "2026-09-01", reference: "RW-OPEN", note: null, ...keys() });
    const holderA = await call<{ shareholderProfileId: string }>("direct_shareholder_add", c, { displayName: "Synthetic Private Holder", agreedTotal: "5000.00", currencyCode: "USD",
      externalReference: null, note: null, businessDate: "2026-09-05", firstContribution: null, ...keys() });
    const holderB = await call<{ shareholderProfileId: string }>("direct_shareholder_add", c, { displayName: "Synthetic Second Holder", agreedTotal: null, currencyCode: "USD",
      externalReference: null, note: null, businessDate: "2026-09-05", firstContribution: null, ...keys() });
    const capitalOf = (profile: string, amount: string, day: string, reference: string) => call<{ journalId: string }>("direct_shareholder_receive", c, { shareholderProfileId: profile,
      fundingMethod: "CASH", amount, currencyCode: "USD", receiptDate: day, destinationAccountId: f.usdSafe, providerName: null, itemDescription: null, expenseLedgerAccountId: null,
      paymentReference: reference, note: "Synthetic private capital note", ...keys() });
    const capitalA = await capitalOf(holderA.shareholderProfileId, "700.00", "2026-09-06", "RW-CAP-PRIVATE");
    const capitalWrong = await capitalOf(holderA.shareholderProfileId, "300.00", "2026-09-07", "RW-CAP-WRONG");
    const capitalB = await capitalOf(holderB.shareholderProfileId, "1000.00", "2026-09-07", "RW-CAP-B");
    const capitalReversal = await call<{ reversalJournalId: string }>("finance_journal_reversal_direct", c, { journalId: capitalWrong.journalId, reason: "Synthetic capital entered twice", ...keys() });
    const partyA = (await this.h.pool.query<{ id: string }>("SELECT business_party_id AS id FROM abos.shareholder_profiles WHERE id = $1", [holderA.shareholderProfileId])).rows[0]?.id ?? "";
    const partyB = (await this.h.pool.query<{ id: string }>("SELECT business_party_id AS id FROM abos.shareholder_profiles WHERE id = $1", [holderB.shareholderProfileId])).rows[0]?.id ?? "";
    await this.identity(f, partyA);
    await this.identity(f, f.provider);
    const fund = async (payload: object) => {
      const recorded = await call<{ funding: { id: string; version: number } }>("record_temporary_funding", c, { reference: `RW-TF-${randomUUID().slice(0, 6)}`, idempotencyKey: `tf-${randomUUID()}`, correlationId: randomUUID(), ...payload });
      return (await call<{ funding: { id: string; version: number; journalId: string } }>("decide_temporary_funding", f.fundingApprover, recorded.funding.id,
        { expectedVersion: recorded.funding.version, decision: "APPROVED", decisionReason: "Synthetic independent decision", idempotencyKey: `tfd-${randomUUID()}`, correlationId: randomUUID() })).funding;
    };
    // A shareholder lends 600 into the Safe; an outside lender pays a 150 expense directly: debt, not capital, and no Treasury money.
    const loan = await fund({ fundingMode: "PROVIDER_FUNDED_SAFE", providerKind: "SHAREHOLDER", providerBusinessPartyId: partyA, treasuryAccountId: f.usdSafe,
      description: "Synthetic shareholder loan into the Safe", businessDate: "2026-09-08", amount: { amount: "600.00", currency: "USD" } });
    await fund({ fundingMode: "PROVIDER_PAID_EXPENSE_DIRECTLY", providerKind: "EXTERNAL_OTHER", providerBusinessPartyId: f.provider, expenseCategoryId: f.category,
      payeeBusinessPartyId: null, description: "Synthetic expense paid by the lender", businessDate: "2026-09-09", amount: { amount: "150.00", currency: "USD" } });
    const receipt = await call<{ journalId: string }>("treasury_receipt_record", c, { treasuryAccountId: f.usdSafe, amount: "1000.00", currencyCode: "USD", businessDate: "2026-09-10",
      payerBusinessPartyId: null, payerName: "Synthetic tenant", revenueLedgerAccountId: f.revenue, reference: "RW-RENT", note: "Synthetic rent", ...keys() });
    const expense = (amount: string, extra: object) => call<{ expense: { journalId: string } }>("operational_expense_create", c, { treasuryAccountId: f.usdSafe, expenseCategoryId: f.category,
      payeeBusinessPartyId: null, projectId: null, departmentId: null, costCenterId: null, reference: "RW-EXP", description: "Synthetic site supplies", note: null, businessDate: "2026-09-11",
      originalAmount: amount, currencyCode: "USD", exchangeRateId: null, ...keys(), ...extra });
    const supplies = await expense("200.00", {});
    const restricted = await expense("50.00", { projectId: f.project, reference: "RW-SECRET", description: "Synthetic restricted works" });
    const mistaken = await expense("30.00", { reference: "RW-EXP-WRONG" });
    await call("finance_journal_reversal_direct", c, { journalId: mistaken.expense.journalId, reason: "Synthetic mistaken expense", ...keys() });
    const payment = await call<{ journalId: string }>("treasury_payment_record", c, { treasuryAccountId: f.usdSafe, paymentKind: "SUPPLIER", payeeBusinessPartyId: f.supplier, payeeName: null,
      payableLedgerAccountId: f.payable, amount: "100.00", currencyCode: "USD", businessDate: "2026-09-12", reference: "RW-PAY", note: null, ...keys() });
    await call("finance_journal_reversal_direct", c, { journalId: payment.journalId, reason: "Synthetic duplicate supplier payment", ...keys() });
    await call("treasury_transfer_record", c, { sourceTreasuryAccountId: f.usdSafe, destinationTreasuryAccountId: f.secondSafe, amount: "300.00", currencyCode: "USD", businessDate: "2026-09-13", reference: "RW-MOVE", note: null, ...keys() });
    const wrongTransfer = await call<{ journalId: string }>("treasury_transfer_record", c, { sourceTreasuryAccountId: f.usdSafe, destinationTreasuryAccountId: f.saraf, amount: "20.00", currencyCode: "USD", businessDate: "2026-09-13", reference: "RW-MOVE-2", note: null, ...keys() });
    await call("finance_journal_reversal_direct", c, { journalId: wrongTransfer.journalId, reason: "Synthetic wrong account chosen", ...keys() });
    await call("treasury_receipt_record", c, { treasuryAccountId: f.afnSafe, amount: "7000.00", currencyCode: "AFN", businessDate: "2026-09-14", payerBusinessPartyId: null, payerName: "Synthetic AFN tenant",
      revenueLedgerAccountId: f.revenue, reference: "RW-AFN-IN", note: null, ...keys() });
    await call("treasury_payment_record", c, { treasuryAccountId: f.afnSafe, paymentKind: "SUPPLIER", payeeBusinessPartyId: f.supplier, payeeName: null, payableLedgerAccountId: f.payable,
      amount: "1400.00", currencyCode: "AFN", businessDate: "2026-09-15", reference: "RW-AFN-OUT", note: null, ...keys() });
    await call("treasury_receipt_record", c, { treasuryAccountId: f.saraf, amount: "100.00", currencyCode: "USD", businessDate: "2026-09-16", payerBusinessPartyId: null, payerName: "Synthetic Saraf client",
      revenueLedgerAccountId: f.revenue, reference: "RW-SARAF-IN", note: null, ...keys() });
    await call("treasury_payment_record", c, { treasuryAccountId: f.saraf, paymentKind: "SUPPLIER", payeeBusinessPartyId: f.supplier, payeeName: null, payableLedgerAccountId: f.payable,
      amount: "400.00", currencyCode: "USD", businessDate: "2026-09-16", reference: "RW-SARAF-OUT", note: null, ...keys() });
    // 250 of the shareholder's loan is repaid from the Safe.
    const requested = await call<{ settlement: { id: string; version: number }; funding: { version: number } }>("request_temporary_funding_settlement", f.settler, { temporaryFundingId: loan.id,
      expectedFundingVersion: loan.version, treasuryAccountId: f.usdSafe, amount: { amount: "250.00", currency: "USD" }, businessDate: "2026-09-20", reference: "RW-REPAY", idempotencyKey: `tfs-${randomUUID()}`, correlationId: randomUUID() });
    await call("decide_temporary_funding_settlement", f.settleApprover, requested.settlement.id, { expectedVersion: requested.settlement.version, decision: "APPROVED",
      decisionReason: "Synthetic settlement decision", idempotencyKey: `tsd-${randomUUID()}`, correlationId: randomUUID() });
    return { partyA, partyB, profileA: holderA.shareholderProfileId, capitalA: capitalA.journalId, capitalWrong: capitalWrong.journalId, capitalB: capitalB.journalId,
      capitalReversal: capitalReversal.reversalJournalId, loan: loan.journalId, receipt: receipt.journalId, restricted: restricted.expense.journalId, expense: supplies.expense.journalId };
  }

  /** The id of the business record behind a journal. */
  async sourceId(journal: string): Promise<string> {
    return (await this.h.pool.query<{ id: string }>("SELECT i.source_id AS id FROM abos.journals j JOIN abos.posting_intents i ON i.id = j.posting_intent_id WHERE j.id = $1", [journal])).rows[0]?.id ?? "";
  }
}

export type ReportCompany = Awaited<ReturnType<ReportDatabase["company"]>>;
export type ReportEvents = Awaited<ReturnType<ReportDatabase["populate"]>>;
