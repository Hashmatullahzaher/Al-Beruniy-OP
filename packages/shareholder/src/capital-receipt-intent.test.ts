import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type {
  BusinessPartyId,
  CapitalAgreementId,
  CapitalInstallmentId,
  CapitalReceiptIntent,
  CashLocationCurrencyAccountId,
  CashReceiptId,
  CorrelationId,
  DocumentId,
  EvidenceReference,
  EvidenceReferenceId,
  IdempotencyKey,
  LegalEntityId,
  Money,
  PhysicalCashCountId,
  ShareholderProfileId,
  SupportedCurrency,
  UserAccountId,
  VerifiedTreasuryReceipt
} from "@abos/contracts";
import {
  CapitalReceiptIntentService,
  assertHandoffPreservesSource
} from "./capital-receipt-intent-service.ts";
import { assessInstallmentEligibility } from "./eligibility.ts";
import { ShareholderDomainError } from "./errors.ts";
import { InMemoryShareholderRepository } from "./memory-repository.ts";
import { toContractAgreementStatus } from "./schema-divergence.ts";
import type {
  CapitalAgreementRecord,
  CapitalInstallmentRecord,
  CreateCapitalReceiptIntentCommand,
  RegistrationEvidenceRecord,
  ShareholderProfile
} from "./types.ts";

// ---------------------------------------------------------------- synthetic fixtures
// Every identifier, name and amount below is invented for the E1 sandbox. None of it represents a
// real AL-BERUNIY shareholder, agreement, safe or opening balance.

const ENTITY = "le-synthetic-001" as LegalEntityId;
const OTHER_ENTITY = "le-synthetic-002" as LegalEntityId;
const PARTY = "party-synthetic-sh-01" as BusinessPartyId;
const OTHER_PARTY = "party-synthetic-sh-02" as BusinessPartyId;
const AGREEMENT = "agr-synthetic-001" as CapitalAgreementId;
const LOAN_AGREEMENT = "agr-synthetic-loan-001" as CapitalAgreementId;
const INSTALLMENT = "inst-synthetic-001" as CapitalInstallmentId;
const SAFE_USD = "clca-synthetic-safe-usd" as CashLocationCurrencyAccountId;
const CASHIER = "user-synthetic-cashier" as UserAccountId;

function usd(amount: string): Money {
  return { amount: amount as Money["amount"], currency: "USD" as SupportedCurrency };
}
function afn(amount: string): Money {
  return { amount: amount as Money["amount"], currency: "AFN" as SupportedCurrency };
}
function evidence(kind: EvidenceReference["kind"], suffix: string): EvidenceReference {
  return {
    id: `ev-${suffix}` as EvidenceReferenceId,
    documentId: `doc-${suffix}` as DocumentId,
    kind,
    version: 1,
    sha256: "a".repeat(64),
    completedAt: "2026-09-22T08:00:00.000Z"
  };
}

const profile: ShareholderProfile = {
  id: "shp-synthetic-001" as ShareholderProfileId,
  businessPartyId: PARTY,
  legalEntityId: ENTITY,
  displayName: "Synthetic Shareholder One",
  status: "ACTIVE",
  version: 1
};

const agreement: CapitalAgreementRecord = {
  id: AGREEMENT,
  legalEntityId: ENTITY,
  shareholderPartyId: PARTY,
  agreementKind: "CAPITAL_CONTRIBUTION",
  agreementReference: "SYNTHETIC-CAP-001",
  dimensions: { scope: "COMPANY_LEVEL", legalEntityId: ENTITY, companyLevelReason: "CORPORATE_CAPITAL" },
  denominationCurrency: "USD",
  committedAmount: usd("100000"),
  partialInstallmentsAllowed: true,
  status: "APPROVED",
  version: 1
};

const registration: RegistrationEvidenceRecord = {
  agreementId: AGREEMENT,
  legalEntityId: ENTITY,
  evidence: evidence("FORMAL_REGISTRATION", "reg-001"),
  status: "VERIFIED",
  verifiedByUserAccountId: "user-synthetic-registrar" as UserAccountId,
  verifiedAt: "2026-09-22T08:05:00.000Z"
};

const installment: CapitalInstallmentRecord = {
  id: INSTALLMENT,
  agreementId: AGREEMENT,
  legalEntityId: ENTITY,
  sequenceNumber: 1,
  expectedAmount: usd("25000"),
  status: "PENDING_RECEIPT",
  version: 1
};

function command(
  overrides: Partial<CreateCapitalReceiptIntentCommand> = {}
): CreateCapitalReceiptIntentCommand {
  return {
    legalEntityId: ENTITY,
    shareholderPartyId: PARTY,
    agreementId: AGREEMENT,
    installmentId: INSTALLMENT,
    amount: usd("25000"),
    expectedDestinationAccountId: SAFE_USD,
    businessEventAt: "2026-09-22T09:00:00.000Z",
    source: {
      legalEntityId: ENTITY,
      idempotencyKey: "idem-synthetic-0001" as IdempotencyKey,
      correlationId: "corr-synthetic-0001" as CorrelationId
    },
    evidence: [evidence("CAPITAL_AGREEMENT", "agr-doc-001")],
    ...overrides
  };
}

interface Harness {
  readonly repository: InMemoryShareholderRepository;
  readonly service: CapitalReceiptIntentService;
}

function harness(
  mutate: (repository: InMemoryShareholderRepository) => void = () => {}
): Harness {
  const repository = new InMemoryShareholderRepository();
  repository.seedProfile(profile);
  repository.seedAgreement(agreement);
  repository.seedRegistration(registration);
  repository.seedInstallment(installment);
  repository.seedDocument(
    { documentId: "doc-agr-001" as DocumentId, evidence: evidence("CAPITAL_AGREEMENT", "agr-doc-001"), legalEntityId: ENTITY },
    AGREEMENT
  );
  mutate(repository);
  let counter = 0;
  const service = new CapitalReceiptIntentService(
    repository,
    () => "2026-09-22T09:00:00.000Z",
    () => `intent-synthetic-${++counter}`
  );
  return { repository, service };
}

async function expectCode(code: string, run: () => Promise<unknown>): Promise<void> {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof ShareholderDomainError, `expected ShareholderDomainError, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });
}

function verifiedReceipt(
  intent: CapitalReceiptIntent,
  overrides: Partial<VerifiedTreasuryReceipt> = {}
): VerifiedTreasuryReceipt {
  return {
    id: "receipt-synthetic-001" as CashReceiptId,
    capitalReceiptIntentId: intent.id,
    destinationType: "CASH_LOCATION",
    destinationAccountId: intent.expectedDestinationAccountId,
    physicalCashCountId: "count-synthetic-001" as PhysicalCashCountId,
    amount: intent.amount,
    cashierUserAccountId: CASHIER,
    evidence: [evidence("CASH_RECEIPT", "receipt-001")],
    verifiedAt: "2026-09-22T09:30:00.000Z",
    status: "VERIFIED",
    ...overrides
  };
}

// ---------------------------------------------------------------- happy path

test("an eligible USD installment produces an ELIGIBLE intent that does not assert cash was received", async () => {
  const { service, repository } = harness();
  const intent = await service.createCapitalReceiptIntent(command());

  assert.equal(intent.status, "ELIGIBLE");
  assert.equal(intent.amount.currency, "USD");
  assert.equal(intent.amount.amount, "25000");
  assert.equal(intent.shareholderPartyId, PARTY);
  assert.equal(intent.expectedDestinationAccountId, SAFE_USD);
  assert.equal(intent.dimensions.legalEntityId, ENTITY);
  assert.ok(Object.isFrozen(intent), "intent must be immutable");

  const history = await repository.listContributions(ENTITY, AGREEMENT);
  assert.equal(history.length, 1);
  // PENDING, not VERIFIED: creating an intent never implies a physical receipt occurred.
  assert.equal(history[0]?.state, "PENDING");
  assert.equal(history[0]?.classification, "PAID_IN_SHARE_CAPITAL");
  assert.equal(history[0]?.treasuryReceiptId, undefined);
  assert.equal(history[0]?.journalId, undefined);
});

test("contribution history distinguishes pending, verified and posted", async () => {
  const { service, repository } = harness();
  const intent = await service.createCapitalReceiptIntent(command());
  assert.equal((await repository.listContributions(ENTITY, AGREEMENT))[0]?.state, "PENDING");

  const verified = await service.markTreasuryVerified({
    legalEntityId: ENTITY,
    intentId: intent.id,
    receipt: verifiedReceipt(intent)
  });
  assert.equal(verified.status, "TREASURY_VERIFIED");
  assert.equal(verified.version, 2);
  let history = await repository.listContributions(ENTITY, AGREEMENT);
  assert.equal(history.length, 1, "history supersedes rather than duplicating");
  assert.equal(history[0]?.state, "VERIFIED");
  assert.equal(history[0]?.treasuryReceiptId, "receipt-synthetic-001");

  const posted = await service.markPosted({
    legalEntityId: ENTITY,
    intentId: intent.id,
    treasuryReceiptId: "receipt-synthetic-001",
    journalId: "journal-synthetic-001"
  });
  assert.equal(posted.status, "POSTED");
  history = await repository.listContributions(ENTITY, AGREEMENT);
  assert.equal(history[0]?.state, "POSTED");
  assert.equal(history[0]?.journalId, "journal-synthetic-001");
});

// ---------------------------------------------------------------- agreement and registration

test("a missing capital agreement is rejected", async () => {
  const { service } = harness();
  await expectCode("CAPITAL_AGREEMENT_REQUIRED", () =>
    service.createCapitalReceiptIntent(command({ agreementId: "agr-does-not-exist" as CapitalAgreementId }))
  );
});

test("a non-approved capital agreement cannot fund an installment", async () => {
  for (const status of ["DRAFT", "SUSPENDED", "CLOSED"] as const) {
    const { service } = harness((repository) =>
      repository.seedAgreement({ ...agreement, status })
    );
    await expectCode("CAPITAL_AGREEMENT_REQUIRED", () => service.createCapitalReceiptIntent(command()));
  }
});

test("missing formal registration evidence is rejected", async () => {
  const withoutRegistration = new InMemoryShareholderRepository();
  withoutRegistration.seedProfile(profile);
  withoutRegistration.seedAgreement(agreement);
  withoutRegistration.seedInstallment(installment);
  withoutRegistration.seedDocument(
    { documentId: "doc-agr-001" as DocumentId, evidence: evidence("CAPITAL_AGREEMENT", "agr-doc-001"), legalEntityId: ENTITY },
    AGREEMENT
  );
  const service = new CapitalReceiptIntentService(withoutRegistration);
  await expectCode("REGISTRATION_EVIDENCE_REQUIRED", () => service.createCapitalReceiptIntent(command()));
});

test("unverified or wrong-kind registration evidence is rejected", async () => {
  const pending = harness((repository) => repository.seedRegistration({ ...registration, status: "PENDING" }));
  await expectCode("REGISTRATION_EVIDENCE_REQUIRED", () => pending.service.createCapitalReceiptIntent(command()));

  const wrongKind = harness((repository) =>
    repository.seedRegistration({ ...registration, evidence: evidence("CASH_RECEIPT", "wrong-kind") })
  );
  await expectCode("REGISTRATION_EVIDENCE_REQUIRED", () => wrongKind.service.createCapitalReceiptIntent(command()));
});

test("a missing controlled agreement document is rejected", async () => {
  const bare = new InMemoryShareholderRepository();
  bare.seedProfile(profile);
  bare.seedAgreement(agreement);
  bare.seedRegistration(registration);
  bare.seedInstallment(installment);
  const service = new CapitalReceiptIntentService(bare);
  await expectCode("EVIDENCE_REQUIRED", () => service.createCapitalReceiptIntent(command()));
});

test("an intent without its own evidence reference is rejected", async () => {
  const { service } = harness();
  await expectCode("EVIDENCE_REQUIRED", () => service.createCapitalReceiptIntent(command({ evidence: [] })));
});

// ---------------------------------------------------------------- amounts

test("an agreement-authorized partial installment is accepted", async () => {
  const { service } = harness();
  const intent = await service.createCapitalReceiptIntent(command({ amount: usd("10000") }));
  assert.equal(intent.amount.amount, "10000");
});

test("a partial installment is rejected when the agreement forbids partials", async () => {
  const { service } = harness((repository) =>
    repository.seedAgreement({ ...agreement, partialInstallmentsAllowed: false })
  );
  await expectCode("CAPITAL_AGREEMENT_REQUIRED", () =>
    service.createCapitalReceiptIntent(command({ amount: usd("10000") }))
  );
});

test("an installment exceeding the eligible amount is rejected", async () => {
  const { service } = harness();
  await expectCode("INSTALLMENT_EXCEEDS_ELIGIBLE_AMOUNT", () =>
    service.createCapitalReceiptIntent(command({ amount: usd("25000.01") }))
  );
});

test("a zero installment is rejected", async () => {
  const { service } = harness();
  await expectCode("INSTALLMENT_EXCEEDS_ELIGIBLE_AMOUNT", () =>
    service.createCapitalReceiptIntent(command({ amount: usd("0") }))
  );
});

test("prior contributions consume the commitment and cap later eligibility", async () => {
  const nearlyFull = harness((repository) => {
    repository.seedAgreement({ ...agreement, committedAmount: usd("30000") });
    repository.seedContribution({
      intentId: "intent-earlier" as CapitalReceiptIntent["id"],
      agreementId: AGREEMENT,
      installmentId: "inst-earlier" as CapitalInstallmentId,
      shareholderPartyId: PARTY,
      legalEntityId: ENTITY,
      amount: usd("20000"),
      state: "POSTED",
      classification: "PAID_IN_SHARE_CAPITAL",
      businessEventAt: "2026-09-01T00:00:00.000Z"
    });
  });
  // 30 000 committed − 20 000 posted = 10 000 remaining, so the 25 000 installment is capped.
  await expectCode("INSTALLMENT_EXCEEDS_ELIGIBLE_AMOUNT", () =>
    nearlyFull.service.createCapitalReceiptIntent(command({ amount: usd("15000") }))
  );
  const ok = await nearlyFull.service.createCapitalReceiptIntent(command({ amount: usd("10000") }));
  assert.equal(ok.amount.amount, "10000");
});

test("a rejected contribution releases its share of the commitment", () => {
  const assessment = assessInstallmentEligibility({
    agreement: { ...agreement, committedAmount: usd("30000") },
    installment,
    registration,
    contributions: [
      {
        intentId: "intent-rejected" as CapitalReceiptIntent["id"],
        agreementId: AGREEMENT,
        installmentId: "inst-rejected" as CapitalInstallmentId,
        shareholderPartyId: PARTY,
        legalEntityId: ENTITY,
        amount: usd("20000"),
        state: "REJECTED",
        classification: "UNDETERMINED_PENDING_POLICY",
        businessEventAt: "2026-09-01T00:00:00.000Z"
      }
    ]
  });
  assert.equal(assessment.remainingEligibleAmount.amount, "30000");
});

// ---------------------------------------------------------------- scope, party type and currency

test("a wrong legal entity is rejected", async () => {
  const { service } = harness();
  await expectCode("NOT_FOUND", () =>
    service.createCapitalReceiptIntent(
      command({ legalEntityId: OTHER_ENTITY, source: { ...command().source, legalEntityId: OTHER_ENTITY } })
    )
  );
});

test("an agreement belonging to another shareholder is rejected", async () => {
  const { service } = harness((repository) =>
    repository.seedProfile({ ...profile, businessPartyId: OTHER_PARTY, id: "shp-synthetic-002" as ShareholderProfileId })
  );
  await expectCode("SCOPE_MISMATCH", () =>
    service.createCapitalReceiptIntent(command({ shareholderPartyId: OTHER_PARTY }))
  );
});

test("a non-active shareholder profile is rejected", async () => {
  for (const status of ["DRAFT", "SUSPENDED", "ARCHIVED"] as const) {
    const { service } = harness((repository) => repository.seedProfile({ ...profile, status }));
    await expectCode("CAPITAL_AGREEMENT_REQUIRED", () => service.createCapitalReceiptIntent(command()));
  }
});

test("a shareholder loan agreement cannot fund a capital contribution", async () => {
  const { service } = harness((repository) => {
    repository.seedAgreement({
      ...agreement,
      id: LOAN_AGREEMENT,
      agreementKind: "SHAREHOLDER_LOAN",
      loanTerms: {
        principal: usd("50000"),
        originalCurrency: "USD",
        repaymentTerms: "SYNTHETIC — 24 months, terms pending Finance Manager review",
        crossCurrencyRepaymentPermitted: true,
        policyDecisionsOutstanding: ["conversion basis", "interest treatment", "repayment posting rules"]
      }
    });
    repository.seedRegistration({ ...registration, agreementId: LOAN_AGREEMENT });
    repository.seedInstallment({ ...installment, agreementId: LOAN_AGREEMENT });
    repository.seedDocument(
      { documentId: "doc-loan" as DocumentId, evidence: evidence("CAPITAL_AGREEMENT", "loan-doc"), legalEntityId: ENTITY },
      LOAN_AGREEMENT
    );
  });
  await expectCode("CAPITAL_AGREEMENT_REQUIRED", () =>
    service.createCapitalReceiptIntent(command({ agreementId: LOAN_AGREEMENT }))
  );
});

test("a non-USD amount is rejected in the first slice", async () => {
  const { service } = harness();
  await expectCode("CURRENCY_MISMATCH", () => service.createCapitalReceiptIntent(command({ amount: afn("25000") })));
});

test("an amount currency differing from the agreement denomination is rejected", async () => {
  const { service } = harness((repository) =>
    repository.seedAgreement({ ...agreement, denominationCurrency: "AFN", committedAmount: afn("100000") })
  );
  await expectCode("CURRENCY_MISMATCH", () => service.createCapitalReceiptIntent(command()));
});

test("a missing Treasury destination is rejected", async () => {
  const { service } = harness();
  await expectCode("SCOPE_MISMATCH", () =>
    service.createCapitalReceiptIntent(command({ expectedDestinationAccountId: "  " as CashLocationCurrencyAccountId }))
  );
});

// ---------------------------------------------------------------- identity and idempotency

test("a missing idempotency key is rejected", async () => {
  const { service } = harness();
  await expectCode("EVIDENCE_REQUIRED", () =>
    service.createCapitalReceiptIntent(
      command({ source: { ...command().source, idempotencyKey: "   " as IdempotencyKey } })
    )
  );
});

test("replaying the same source transaction returns the same intent", async () => {
  const { service } = harness();
  const first = await service.createCapitalReceiptIntent(command());
  const second = await service.createCapitalReceiptIntent(command());
  assert.equal(second.id, first.id);
  assert.equal(second.version, first.version);
});

test("reusing an idempotency key with a different payload is a conflict", async () => {
  const { service } = harness();
  await service.createCapitalReceiptIntent(command());
  await expectCode("IDEMPOTENCY_CONFLICT", () =>
    service.createCapitalReceiptIntent(command({ amount: usd("10000") }))
  );
});

test("a second intent for the same installment under a new key is a conflict", async () => {
  const { service } = harness();
  await service.createCapitalReceiptIntent(command());
  await expectCode("IDEMPOTENCY_CONFLICT", () =>
    service.createCapitalReceiptIntent(
      command({ source: { ...command().source, idempotencyKey: "idem-synthetic-0002" as IdempotencyKey } })
    )
  );
});

test("an installment already posted cannot accept a new intent", async () => {
  const { service } = harness((repository) => repository.seedInstallment({ ...installment, status: "POSTED" }));
  await expectCode("POSTED_RECORD_IMMUTABLE", () => service.createCapitalReceiptIntent(command()));
});

// ---------------------------------------------------------------- state transitions

test("invalid state transitions are refused", async () => {
  const { service } = harness();
  const intent = await service.createCapitalReceiptIntent(command());

  // POSTED requires TREASURY_VERIFIED first.
  await expectCode("POSTED_RECORD_IMMUTABLE", () =>
    service.markPosted({
      legalEntityId: ENTITY,
      intentId: intent.id,
      treasuryReceiptId: "receipt-synthetic-001",
      journalId: "journal-synthetic-001"
    })
  );

  await service.markTreasuryVerified({ legalEntityId: ENTITY, intentId: intent.id, receipt: verifiedReceipt(intent) });
  // Double verification is refused.
  await expectCode("POSTED_RECORD_IMMUTABLE", () =>
    service.markTreasuryVerified({ legalEntityId: ENTITY, intentId: intent.id, receipt: verifiedReceipt(intent) })
  );
});

test("verifying an unknown intent is rejected", async () => {
  const { service } = harness();
  const intent = await service.createCapitalReceiptIntent(command());
  await expectCode("NOT_FOUND", () =>
    service.markTreasuryVerified({
      legalEntityId: ENTITY,
      intentId: "intent-unknown" as CapitalReceiptIntent["id"],
      receipt: verifiedReceipt(intent)
    })
  );
});

// ---------------------------------------------------------------- Treasury handoff (Antigravity)

test("the treasury handoff must preserve every identifying attribute of the source", async () => {
  const { service } = harness();
  const intent = await service.createCapitalReceiptIntent(command());

  const cases: readonly (readonly [string, Partial<VerifiedTreasuryReceipt>])[] = [
    ["SCOPE_MISMATCH", { capitalReceiptIntentId: "intent-other" as CapitalReceiptIntent["id"] }],
    ["SCOPE_MISMATCH", { destinationAccountId: "clca-other-safe" as CashLocationCurrencyAccountId }],
    ["SCOPE_MISMATCH", { amount: usd("24999") }],
    ["CURRENCY_MISMATCH", { amount: afn("25000") }],
    ["EVIDENCE_REQUIRED", { physicalCashCountId: " " as PhysicalCashCountId }],
    ["EVIDENCE_REQUIRED", { evidence: [] }]
  ];
  for (const [code, overrides] of cases) {
    assert.throws(
      () => assertHandoffPreservesSource(intent, verifiedReceipt(intent, overrides)),
      (error: unknown) => error instanceof ShareholderDomainError && error.code === code,
      `expected ${code} for ${JSON.stringify(overrides)}`
    );
  }
  assert.doesNotThrow(() => assertHandoffPreservesSource(intent, verifiedReceipt(intent)));
});

// ---------------------------------------------------------------- domain boundary

test("the shareholder domain cannot post: no Finance dependency and no posting surface", async () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  assert.deepEqual(Object.keys(manifest.dependencies ?? {}), ["@abos/contracts"]);

  const api = await import("./index.ts");
  const surface = Object.keys(api).join(" ").toLowerCase();
  for (const forbidden of ["postjournal", "postcapital", "ledgerbalance", "creditaccount", "debitaccount"]) {
    assert.ok(!surface.includes(forbidden), `public surface must not expose ${forbidden}`);
  }
  // Scan declarations only: prose in comments legitimately names what the port must not do.
  const repositoryCode = readFileSync(new URL("./repository.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  for (const forbidden of [/journal/i, /balance/i, /\bpost\w*\(/i, /ledger/i]) {
    assert.ok(
      !forbidden.test(repositoryCode),
      `repository port must declare nothing matching ${forbidden}`
    );
  }
});

test("pending registration is neither paid-in capital nor automatically a liability", () => {
  const assessment = assessInstallmentEligibility({
    agreement,
    installment,
    registration: { ...registration, status: "PENDING" },
    contributions: []
  });
  assert.equal(assessment.registrationEvidence, undefined);
  // The classification the service would record in that situation.
  const classification = assessment.registrationEvidence
    ? "PAID_IN_SHARE_CAPITAL"
    : "UNDETERMINED_PENDING_POLICY";
  assert.equal(classification, "UNDETERMINED_PENDING_POLICY");
  assert.notEqual(classification, "SHAREHOLDER_LOAN_PRINCIPAL");
});

// ---------------------------------------------------------------- schema divergence (Finance F-1)

test("the persisted agreement vocabulary maps to the contract, and the gap is explicit", () => {
  assert.equal(toContractAgreementStatus("ELIGIBLE"), "APPROVED");
  assert.equal(toContractAgreementStatus("DRAFT"), "DRAFT");
  assert.equal(toContractAgreementStatus("SUSPENDED"), "SUSPENDED");
  assert.equal(toContractAgreementStatus("CLOSED"), "CLOSED");
  assert.throws(
    () => toContractAgreementStatus("PENDING_EVIDENCE"),
    (error: unknown) =>
      error instanceof ShareholderDomainError && error.code === "POLICY_CONFIGURATION_PENDING"
  );
});
