import assert from "node:assert/strict";
import test from "node:test";
import type {
  AccountingPeriodId,
  CapitalAgreementId,
  CapitalInstallmentId,
  CapitalReceiptIntentId,
  CashLocationCurrencyAccountId,
  CashLocationId,
  CashReceiptId,
  CorrelationId,
  CostCenterId,
  DepartmentId,
  DocumentId,
  EvidenceReference,
  EvidenceReferenceId,
  FinanceApprovalId,
  IdempotencyKey,
  LedgerAccountId,
  LegalEntityId,
  PhysicalCashCountId,
  PostingIntentId,
  ProjectId,
  UserAccountId
} from "@abos/contracts";
import { asDecimalString } from "@abos/contracts";
import { ExactDecimal } from "./decimal.ts";
import { FinanceDomainError } from "./errors.ts";
import { InMemoryFinancePostingRepository } from "./memory-repository.ts";
import {
  FinancePostingService,
  type PostCapitalReceiptCommand,
  type ReverseJournalCommand
} from "./posting-service.ts";
import { reconcileCapitalReceipt } from "./reconciliation.ts";

const id = <T extends string>(value: string) => value as T;

const legalEntityId = id<LegalEntityId>("10000000-0000-4000-8000-000000000001");
const cashierId = id<UserAccountId>("10000000-0000-4000-8000-000000000002");
const approverId = id<UserAccountId>("10000000-0000-4000-8000-000000000003");
const cashLedgerId = id<LedgerAccountId>("10000000-0000-4000-8000-000000000004");
const capitalLedgerId = id<LedgerAccountId>("10000000-0000-4000-8000-000000000005");
const cashAccountId = id<CashLocationCurrencyAccountId>("10000000-0000-4000-8000-000000000006");
const agreementId = id<CapitalAgreementId>("10000000-0000-4000-8000-000000000007");
const installmentId = id<CapitalInstallmentId>("10000000-0000-4000-8000-000000000008");
const sourceIntentId = id<CapitalReceiptIntentId>("10000000-0000-4000-8000-000000000009");
const postingIntentId = id<PostingIntentId>("10000000-0000-4000-8000-000000000010");
const receiptId = id<CashReceiptId>("10000000-0000-4000-8000-000000000011");
const periodId = id<AccountingPeriodId>("10000000-0000-4000-8000-000000000012");

const registrationEvidence = evidence("FORMAL_REGISTRATION", "reg");
const receiptEvidence = evidence("CASH_RECEIPT", "receipt");
const approvalEvidence = evidence("FINANCE_APPROVAL", "approval");

test("exact decimal arithmetic does not use floating point", () => {
  assert.equal(ExactDecimal.parse("0.1").add(ExactDecimal.parse("0.2")).toString(), "0.3");
  assert.equal(ExactDecimal.parse("100.00").compare(ExactDecimal.parse("100")), 0);
  assert.throws(() => ExactDecimal.parse("1e3"));
});

test("posts one balanced synthetic USD capital receipt and reconciles all projections", async () => {
  const { service, repository, command } = fixture();
  const journal = await service.postCapitalReceipt(command);
  assert.equal(journal.lines.length, 2);
  assert.equal(journal.lines[0]?.debitBase, "25000.00");
  assert.equal(journal.lines[1]?.creditBase, "25000.00");
  assert.equal(repository.listJournals().length, 1);
  const result = reconcileCapitalReceipt({
    sourceAmount: command.intent.originalAmount,
    treasuryAmount: command.treasuryReceipt.amount,
    shareholderPostedAmount: command.intent.originalAmount,
    journal
  });
  assert.equal(result.reconciled, true);
  assert.equal(result.scope, "FIRST_CAPITAL_RECEIPT_OPERATIONAL_SLICE");
});

test("same idempotency key and payload returns the original journal", async () => {
  const { service, repository, command } = fixture();
  const first = await service.postCapitalReceipt(command);
  const second = await service.postCapitalReceipt(command);
  assert.equal(first.id, second.id);
  assert.equal(repository.listJournals().length, 1);
});

test("concurrent identical retries return one journal and concurrent source conflicts are typed", async () => {
  const identical = fixture();
  const [first, second] = await Promise.all([
    identical.service.postCapitalReceipt(identical.command),
    identical.service.postCapitalReceipt(identical.command)
  ]);
  assert.equal(first.id, second.id);
  assert.equal(identical.repository.listJournals().length, 1);

  const conflicting = fixture();
  const anotherKey = {
    ...conflicting.command,
    metadata: { ...conflicting.command.metadata, idempotencyKey: id<IdempotencyKey>("concurrent-other-key") }
  };
  const outcomes = await Promise.allSettled([
    conflicting.service.postCapitalReceipt(conflicting.command),
    conflicting.service.postCapitalReceipt(anotherKey)
  ]);
  const rejection = outcomes.find((outcome) => outcome.status === "rejected");
  assert.equal(rejection?.status, "rejected");
  assert.equal(rejection?.status === "rejected" && rejection.reason instanceof FinanceDomainError, true);
  assert.equal(rejection?.status === "rejected" && rejection.reason.code, "IDEMPOTENCY_CONFLICT");
});

test("same idempotency key with a different amount is rejected", async () => {
  const { service, command } = fixture();
  await service.postCapitalReceipt(command);
  const changed = withAmount(command, "24000.00");
  await rejectsCode(() => service.postCapitalReceipt(changed), "IDEMPOTENCY_CONFLICT");
});

test("idempotent replay rechecks authorization and hashes stable business fields", async () => {
  const first = fixture();
  await first.service.postCapitalReceipt(first.command);
  await rejectsCode(
    () => first.service.postCapitalReceipt({ ...first.command, actor: { ...first.command.actor, permissions: [] } }),
    "PERMISSION_DENIED"
  );

  const second = fixture();
  await second.service.postCapitalReceipt(second.command);
  await rejectsCode(
    () => second.service.postCapitalReceipt({ ...second.command, accountingEffectiveDate: "2026-09-21" }),
    "IDEMPOTENCY_CONFLICT"
  );

  const refreshed = fixture();
  const original = await refreshed.service.postCapitalReceipt(refreshed.command);
  const replay = await refreshed.service.postCapitalReceipt({
    ...refreshed.command,
    actor: { ...refreshed.command.actor, authenticatedAt: "2026-09-22T08:30:00.000Z" },
    metadata: { ...refreshed.command.metadata, correlationId: id<CorrelationId>("refreshed-correlation") }
  });
  assert.equal(replay.id, original.id);
});

test("different idempotency key cannot post the same source twice", async () => {
  const { service, command } = fixture();
  await service.postCapitalReceipt(command);
  const changed = {
    ...command,
    metadata: { ...command.metadata, idempotencyKey: id<IdempotencyKey>("second-key") }
  };
  await rejectsCode(() => service.postCapitalReceipt(changed), "IDEMPOTENCY_CONFLICT");
});

test("a second posting intent cannot post the same capital source", async () => {
  const { service, command } = fixture();
  await service.postCapitalReceipt(command);
  const secondIntent = {
    ...command,
    intent: {
      ...command.intent,
      id: id<PostingIntentId>("10000000-0000-4000-8000-000000000099")
    },
    approval: {
      ...command.approval,
      id: id<FinanceApprovalId>("10000000-0000-4000-8000-000000000098"),
      postingIntentId: id<PostingIntentId>("10000000-0000-4000-8000-000000000099")
    },
    metadata: { ...command.metadata, idempotencyKey: id<IdempotencyKey>("second-intent-key") }
  };
  await rejectsCode(() => service.postCapitalReceipt(secondIntent), "IDEMPOTENCY_CONFLICT");
});

test("cashier cannot approve or post their own receipt", async () => {
  const { service, command } = fixture();
  const selfApproved = {
    ...command,
    actor: { ...command.actor, userAccountId: cashierId },
    approval: { ...command.approval, approvedByUserAccountId: cashierId }
  };
  await rejectsCode(() => service.postCapitalReceipt(selfApproved), "SEGREGATION_OF_DUTIES_VIOLATION");
});

test("approval is bound to the approved posting intent", async () => {
  const first = fixture();
  await rejectsCode(
    () => first.service.postCapitalReceipt({
      ...first.command,
      approval: {
        ...first.command.approval,
        postingIntentId: id<PostingIntentId>("10000000-0000-4000-8000-000000000097")
      }
    }),
    "SCOPE_MISMATCH"
  );
  const second = fixture();
  await rejectsCode(
    () => second.service.postCapitalReceipt({
      ...second.command,
      intent: { ...second.command.intent, status: "PENDING_APPROVAL" }
    }),
    "POLICY_CONFIGURATION_PENDING"
  );
});

test("missing agreement approval or registration evidence fails closed", async () => {
  const first = fixture();
  await rejectsCode(
    () => first.service.postCapitalReceipt({ ...first.command, eligibility: { ...first.command.eligibility, agreementStatus: "DRAFT" } }),
    "CAPITAL_AGREEMENT_REQUIRED"
  );
  const second = fixture();
  const withoutRegistration = {
    installmentId: second.command.eligibility.installmentId,
    agreementId: second.command.eligibility.agreementId,
    eligibleAmount: second.command.eligibility.eligibleAmount,
    agreementStatus: second.command.eligibility.agreementStatus
  };
  await rejectsCode(
    () => second.service.postCapitalReceipt({ ...second.command, eligibility: withoutRegistration }),
    "REGISTRATION_EVIDENCE_REQUIRED"
  );
});

test("installment above remaining eligible amount is rejected", async () => {
  const { service, command } = fixture();
  const excessive = withAmount(command, "25000.01");
  await rejectsCode(() => service.postCapitalReceipt(excessive), "INSTALLMENT_EXCEEDS_ELIGIBLE_AMOUNT");
});

test("eligibility and receipt currencies must match exactly", async () => {
  const { service, command } = fixture();
  await rejectsCode(
    () => service.postCapitalReceipt({
      ...command,
      eligibility: {
        ...command.eligibility,
        eligibleAmount: { amount: asDecimalString("2500000"), currency: "AFN" }
      }
    }),
    "CURRENCY_MISMATCH"
  );
});

test("inactive or unreconciled safe USD account is rejected", async () => {
  const first = fixture();
  await rejectsCode(
    () => first.service.postCapitalReceipt({
      ...first.command,
      configuration: { ...first.command.configuration, cashLocationAccount: { ...first.command.configuration.cashLocationAccount, status: "APPROVED" } }
    }),
    "CASH_ACCOUNT_INACTIVE"
  );
  const second = fixture();
  await rejectsCode(
    () => second.service.postCapitalReceipt({
      ...second.command,
      configuration: { ...second.command.configuration, cashLocationAccount: { ...second.command.configuration.cashLocationAccount, openingPositionApproved: false } }
    }),
    "OPENING_POSITION_NOT_APPROVED"
  );
});

test("closed period, wrong legal entity scope, and missing permission are rejected", async () => {
  const closed = fixture();
  await rejectsCode(
    () => closed.service.postCapitalReceipt({
      ...closed.command,
      configuration: { ...closed.command.configuration, accountingPeriod: { ...closed.command.configuration.accountingPeriod, status: "CLOSED" } }
    }),
    "ACCOUNTING_PERIOD_CLOSED"
  );
  const scoped = fixture();
  await rejectsCode(
    () => scoped.service.postCapitalReceipt({ ...scoped.command, actor: { ...scoped.command.actor, legalEntityIds: [] } }),
    "SCOPE_MISMATCH"
  );
  const unauthorized = fixture();
  await rejectsCode(
    () => unauthorized.service.postCapitalReceipt({ ...unauthorized.command, actor: { ...unauthorized.command.actor, permissions: [] } }),
    "PERMISSION_DENIED"
  );
});

test("project-level posting enforces project and department scopes", async () => {
  const { service, command } = fixture();
  const projectId = id<ProjectId>("10000000-0000-4000-8000-000000000090");
  const departmentId = id<DepartmentId>("10000000-0000-4000-8000-000000000091");
  const costCenterId = id<CostCenterId>("10000000-0000-4000-8000-000000000092");
  const projectCommand = {
    ...command,
    intent: {
      ...command.intent,
      dimensions: { scope: "PROJECT_LEVEL" as const, legalEntityId, projectId, departmentId, costCenterId }
    }
  };
  await rejectsCode(() => service.postCapitalReceipt(projectCommand), "SCOPE_MISMATCH");
  await rejectsCode(
    () => service.postCapitalReceipt({
      ...projectCommand,
      actor: { ...projectCommand.actor, projectIds: [projectId], departmentIds: [] }
    }),
    "SCOPE_MISMATCH"
  );
});

test("company-level department tags enforce department scope", async () => {
  const { service, command } = fixture();
  const departmentId = id<DepartmentId>("10000000-0000-4000-8000-000000000093");
  await rejectsCode(
    () => service.postCapitalReceipt({
      ...command,
      intent: {
        ...command.intent,
        dimensions: {
          ...command.intent.dimensions,
          departmentId
        }
      }
    }),
    "SCOPE_MISMATCH"
  );
});

test("AFN and owner-provisional policy cannot enter the first posting slice", async () => {
  const currency = fixture();
  const afn = {
    ...currency.command,
    intent: { ...currency.command.intent, originalAmount: { amount: asDecimalString("25000"), currency: "AFN" as const } }
  };
  await rejectsCode(() => currency.service.postCapitalReceipt(afn), "CURRENCY_MISMATCH");

  const provisional = fixture();
  await rejectsCode(
    () => provisional.service.postCapitalReceipt({
      ...provisional.command,
      configuration: {
        ...provisional.command.configuration,
        policy: { ...provisional.command.configuration.policy, configurationState: "OWNER_PROVISIONAL" }
      }
    }),
    "POLICY_CONFIGURATION_PENDING"
  );
});

test("production posting is hard-disabled throughout E0", async () => {
  const { service, command } = fixture();
  await rejectsCode(
    () => service.postCapitalReceipt({
      ...command,
      configuration: {
        ...command.configuration,
        policy: {
          ...command.configuration.policy,
          environment: "production",
          configurationState: "CLIENT_FINANCE_APPROVED",
          realPostingEnabled: true
        }
      }
    }),
    "POLICY_CONFIGURATION_PENDING"
  );
});

test("staging and non-synthetic policy states are hard-disabled throughout E0", async () => {
  const staging = fixture();
  await rejectsCode(
    () => staging.service.postCapitalReceipt({
      ...staging.command,
      configuration: {
        ...staging.command.configuration,
        policy: { ...staging.command.configuration.policy, environment: "staging" }
      }
    }),
    "POLICY_CONFIGURATION_PENDING"
  );
  const approved = fixture();
  await rejectsCode(
    () => approved.service.postCapitalReceipt({
      ...approved.command,
      configuration: {
        ...approved.command.configuration,
        policy: { ...approved.command.configuration.policy, configurationState: "CLIENT_FINANCE_APPROVED" }
      }
    }),
    "POLICY_CONFIGURATION_PENDING"
  );
});

test("posted journal owns an immutable deep copy of nested money and dimensions", async () => {
  const { service, command } = fixture();
  const journal = await service.postCapitalReceipt(command);
  const mutableAmount = command.intent.originalAmount as { amount: string };
  mutableAmount.amount = "1.00";
  assert.equal(journal.lines[0]?.originalAmount.amount, "25000.00");
  assert.equal(Object.isFrozen(journal.lines[0]?.originalAmount), true);
  assert.equal(Object.isFrozen(journal.lines[0]?.dimensions), true);
});

test("controlled reversal requires evidence, swaps lines, and cannot repeat", async () => {
  const { service, command } = fixture();
  const journal = await service.postCapitalReceipt(command);
  const base: ReverseJournalCommand = {
    originalJournalId: journal.id,
    accountingPeriod: command.configuration.accountingPeriod,
    actor: { ...command.actor, permissions: ["finance.journal.reverse"] },
    metadata: {
      correlationId: id<CorrelationId>("reverse-correlation"),
      idempotencyKey: id<IdempotencyKey>("reverse-key")
    },
    reason: "Cash receipt classification correction",
    evidence: [],
    policy: command.configuration.policy,
    ledgerAccounts: command.configuration.ledgerAccounts
  };
  await rejectsCode(() => service.reverseJournal(base), "EVIDENCE_REQUIRED");
  const reversal = await service.reverseJournal({ ...base, evidence: [evidence("REVERSAL_REASON", "reversal")] });
  assert.equal(reversal.reversalOfJournalId, journal.id);
  assert.equal(reversal.lines[0]?.creditBase, journal.lines[0]?.debitBase);
  const replay = await service.reverseJournal({ ...base, evidence: [evidence("REVERSAL_REASON", "reversal")] });
  assert.equal(replay.id, reversal.id);
  const refreshedReplay = await service.reverseJournal({
    ...base,
    actor: { ...base.actor, authenticatedAt: "2026-09-22T09:00:00.000Z" },
    metadata: { ...base.metadata, correlationId: id<CorrelationId>("reverse-refreshed-correlation") },
    evidence: [evidence("REVERSAL_REASON", "reversal")]
  });
  assert.equal(refreshedReplay.id, reversal.id);
  await rejectsCode(
    () => service.reverseJournal({
      ...base,
      metadata: { ...base.metadata, idempotencyKey: id<IdempotencyKey>("another-reversal-key") },
      evidence: [evidence("REVERSAL_REASON", "reversal-2")]
    }),
    "POSTED_RECORD_IMMUTABLE"
  );
});

test("concurrent identical reversal retries return the stored reversal", async () => {
  const { service, command, repository } = fixture();
  const journal = await service.postCapitalReceipt(command);
  const reversalCommand: ReverseJournalCommand = {
    originalJournalId: journal.id,
    accountingPeriod: command.configuration.accountingPeriod,
    actor: { ...command.actor, permissions: ["finance.journal.reverse"] },
    metadata: {
      correlationId: id<CorrelationId>("concurrent-reversal-correlation"),
      idempotencyKey: id<IdempotencyKey>("concurrent-reversal-key")
    },
    reason: "Concurrent synthetic reversal",
    evidence: [evidence("REVERSAL_REASON", "concurrent-reversal")],
    policy: command.configuration.policy,
    ledgerAccounts: command.configuration.ledgerAccounts
  };
  const [first, second] = await Promise.all([
    service.reverseJournal(reversalCommand),
    service.reverseJournal(reversalCommand)
  ]);
  assert.equal(first.id, second.id);
  assert.equal(repository.listJournals().length, 2);
});

function fixture() {
  const repository = new InMemoryFinancePostingRepository();
  let sequence = 0;
  const service = new FinancePostingService(repository, () => "2026-09-22T08:00:00.000Z", () => `20000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`);
  const command: PostCapitalReceiptCommand = {
    intent: {
      id: postingIntentId,
      sourceType: "SHAREHOLDER_CAPITAL_INSTALLMENT",
      sourceIntentId,
      agreementId,
      installmentId,
      treasuryReceiptId: receiptId,
      dimensions: { scope: "COMPANY_LEVEL", legalEntityId, companyLevelReason: "CORPORATE_CAPITAL" },
      originalAmount: { amount: asDecimalString("25000.00"), currency: "USD" },
      baseAmount: { amount: asDecimalString("25000.00"), currency: "USD" },
      destinationAccountId: cashAccountId,
      debitLedgerAccountId: cashLedgerId,
      creditLedgerAccountId: capitalLedgerId,
      accountingPeriodId: periodId,
      cashierUserAccountId: cashierId,
      evidence: [registrationEvidence, receiptEvidence],
      status: "APPROVED"
    },
    eligibility: {
      installmentId,
      agreementId,
      eligibleAmount: { amount: asDecimalString("25000.00"), currency: "USD" },
      agreementStatus: "APPROVED",
      registrationEvidence
    },
    treasuryReceipt: {
      id: receiptId,
      capitalReceiptIntentId: sourceIntentId,
      destinationType: "CASH_LOCATION",
      destinationAccountId: cashAccountId,
      physicalCashCountId: id<PhysicalCashCountId>("10000000-0000-4000-8000-000000000013"),
      amount: { amount: asDecimalString("25000.00"), currency: "USD" },
      cashierUserAccountId: cashierId,
      evidence: [receiptEvidence],
      verifiedAt: "2026-09-22T07:30:00.000Z",
      status: "VERIFIED"
    },
    approval: {
      id: id<FinanceApprovalId>("10000000-0000-4000-8000-000000000014"),
      postingIntentId,
      approvedByUserAccountId: approverId,
      approvedAt: "2026-09-22T07:45:00.000Z",
      evidence: [approvalEvidence],
      status: "APPROVED"
    },
    actor: {
      userAccountId: approverId,
      permissions: ["finance.posting-intent.approve", "finance.journal.post"],
      legalEntityIds: [legalEntityId],
      projectIds: [] as ProjectId[],
      departmentIds: [],
      authenticatedAt: "2026-09-22T07:40:00.000Z"
    },
    metadata: {
      correlationId: id<CorrelationId>("capital-receipt-correlation"),
      idempotencyKey: id<IdempotencyKey>("capital-receipt-key")
    },
    accountingEffectiveDate: "2026-09-22",
    configuration: {
      policy: {
        environment: "test",
        configurationState: "SYNTHETIC_TEST_ONLY",
        policyVersionId: "synthetic-test-policy-v1",
        baseCurrency: "USD",
        realPostingEnabled: false
      },
      accountingPeriod: {
        id: periodId,
        legalEntityId,
        status: "OPEN",
        startsOn: "2026-09-01",
        endsOn: "2026-09-30"
      },
      ledgerAccounts: new Map([
        [cashLedgerId, { id: cashLedgerId, legalEntityId, status: "ACTIVE", postable: true }],
        [capitalLedgerId, { id: capitalLedgerId, legalEntityId, status: "ACTIVE", postable: true }]
      ]),
      cashLocationAccount: {
        id: cashAccountId,
        cashLocationId: id<CashLocationId>("10000000-0000-4000-8000-000000000015"),
        currency: "USD",
        status: "ACTIVE",
        openingPositionApproved: true,
        responsibleCashierUserAccountId: cashierId,
        activationEvidence: [evidence("OPENING_RECONCILIATION", "opening")],
        version: 1
      },
      configuredCashLedgerAccountId: cashLedgerId,
      configuredPaidInCapitalLedgerAccountId: capitalLedgerId
    }
  };
  return { repository, service, command };
}

function withAmount(command: PostCapitalReceiptCommand, amount: string): PostCapitalReceiptCommand {
  return {
    ...command,
    intent: {
      ...command.intent,
      originalAmount: { amount: asDecimalString(amount), currency: "USD" },
      baseAmount: { amount: asDecimalString(amount), currency: "USD" }
    },
    treasuryReceipt: {
      ...command.treasuryReceipt,
      amount: { amount: asDecimalString(amount), currency: "USD" }
    }
  };
}

function evidence(kind: EvidenceReference["kind"], suffix: string): EvidenceReference {
  return {
    id: id<EvidenceReferenceId>(`evidence-${suffix}`),
    documentId: id<DocumentId>(`document-${suffix}`),
    kind,
    version: 1,
    sha256: "a".repeat(64),
    completedAt: "2026-09-22T07:00:00.000Z"
  };
}

async function rejectsCode(action: () => Promise<unknown>, code: FinanceDomainError["code"]): Promise<void> {
  await assert.rejects(action, (error: unknown) => error instanceof FinanceDomainError && error.code === code);
}
