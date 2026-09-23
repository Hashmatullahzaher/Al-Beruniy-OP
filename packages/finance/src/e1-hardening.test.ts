import assert from "node:assert/strict";
import test from "node:test";
import type {
  AccountingPeriodId,
  CapitalAgreementFundingPolicy,
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
  SandboxPostingGate,
  UserAccountId
} from "@abos/contracts";
import { asDecimalString, checkAgreementMayFund } from "@abos/contracts";
import { FinanceDomainError } from "./errors.ts";
import { InMemoryFinancePostingRepository } from "./memory-repository.ts";
import {
  FinancePostingService,
  type PostCapitalReceiptCommand,
  type ReverseJournalCommand
} from "./posting-service.ts";

/**
 * Tests for the E1 hardening of findings F-1 and F-3 through F-8.
 *
 * These exercise the kernel against an in-memory repository, so they prove the kernel's refusals.
 * They do NOT prove the database's refusals; those are proved separately in
 * `@abos/e1-integration` against a real PostgreSQL, and neither suite substitutes for the other.
 */

const id = <T extends string>(value: string) => value as T;

const legalEntityId = id<LegalEntityId>("10000000-0000-4000-8000-000000000001");
const otherEntityId = id<LegalEntityId>("10000000-0000-4000-8000-0000000000aa");
const cashierId = id<UserAccountId>("10000000-0000-4000-8000-000000000002");
const approverId = id<UserAccountId>("10000000-0000-4000-8000-000000000003");
const reverserId = id<UserAccountId>("10000000-0000-4000-8000-000000000017");
const confirmerId = id<UserAccountId>("10000000-0000-4000-8000-000000000016");
const cashLedgerId = id<LedgerAccountId>("10000000-0000-4000-8000-000000000004");
const capitalLedgerId = id<LedgerAccountId>("10000000-0000-4000-8000-000000000005");
const cashAccountId = id<CashLocationCurrencyAccountId>("10000000-0000-4000-8000-000000000006");
const agreementId = id<CapitalAgreementId>("10000000-0000-4000-8000-000000000007");
const installmentId = id<CapitalInstallmentId>("10000000-0000-4000-8000-000000000008");
const sourceIntentId = id<CapitalReceiptIntentId>("10000000-0000-4000-8000-000000000009");
const postingIntentId = id<PostingIntentId>("10000000-0000-4000-8000-000000000010");
const receiptId = id<CashReceiptId>("10000000-0000-4000-8000-000000000011");
const periodId = id<AccountingPeriodId>("10000000-0000-4000-8000-000000000012");
const countId = id<PhysicalCashCountId>("10000000-0000-4000-8000-000000000013");
const costCenterId = id<CostCenterId>("10000000-0000-4000-8000-000000000018");
const projectId = id<ProjectId>("10000000-0000-4000-8000-000000000019");
const departmentId = id<DepartmentId>("10000000-0000-4000-8000-00000000001a");

const SIGNATURE = "server-resolved";

// ---------------------------------------------------------------------------
// F-1. Canonical status vocabulary and the recorded funding decision.
// ---------------------------------------------------------------------------

test("F-1: with no funding decision recorded, no agreement status is fundable", () => {
  for (const status of ["DRAFT", "PENDING_EVIDENCE", "ELIGIBLE", "SUSPENDED", "CLOSED"] as const) {
    const violation = checkAgreementMayFund(status, undefined);
    assert.equal(violation?.code, "POLICY_CONFIGURATION_PENDING", `${status} must fail closed`);
  }
});

test("F-1: a funding decision cannot make a structurally unfundable status fundable", () => {
  for (const status of ["DRAFT", "SUSPENDED", "CLOSED"] as const) {
    const violation = checkAgreementMayFund(status, {
      ...syntheticFundingPolicy,
      fundableStatuses: [status]
    });
    assert.equal(violation?.code, "POLICY_CONFIGURATION_PENDING");
    assert.match(violation?.message ?? "", /can never fund an installment/);
  }
});

test("F-1: a funding decision without a durable reference is refused", () => {
  const violation = checkAgreementMayFund("ELIGIBLE", {
    ...syntheticFundingPolicy,
    decisionReference: "   "
  });
  assert.equal(violation?.code, "POLICY_CONFIGURATION_PENDING");
  assert.match(violation?.message ?? "", /durable decision reference/);
});

test("F-1: the kernel refuses to post when no funding decision is recorded", async () => {
  const { service, command } = fixture();
  await rejects(
    () =>
      service.postCapitalReceipt({
        ...command,
        configuration: { ...command.configuration, fundingPolicy: undefined }
      }),
    "POLICY_CONFIGURATION_PENDING"
  );
});

test("F-1: PENDING_EVIDENCE posts only if the recorded decision says it may", async () => {
  const refused = fixture();
  await rejects(
    () =>
      refused.service.postCapitalReceipt({
        ...refused.command,
        eligibility: {
          ...refused.command.eligibility,
          canonicalAgreementStatus: "PENDING_EVIDENCE"
        }
      }),
    "CAPITAL_AGREEMENT_REQUIRED"
  );

  const permitted = fixture();
  const journal = await permitted.service.postCapitalReceipt({
    ...permitted.command,
    eligibility: {
      ...permitted.command.eligibility,
      canonicalAgreementStatus: "PENDING_EVIDENCE"
    },
    configuration: {
      ...permitted.command.configuration,
      fundingPolicy: {
        ...syntheticFundingPolicy,
        fundableStatuses: ["PENDING_EVIDENCE", "ELIGIBLE"]
      }
    }
  });
  assert.equal(journal.status, "POSTED");
});

// ---------------------------------------------------------------------------
// F-3. The gate is server-resolved and cannot be asserted by the caller.
// ---------------------------------------------------------------------------

test("F-3: a hand-built sandbox gate is refused", async () => {
  const { service, command } = fixture();
  await rejects(
    () =>
      service.postCapitalReceipt({
        ...command,
        configuration: {
          ...command.configuration,
          gate: { ...command.configuration.gate, signature: "forged" }
        }
      }),
    "POLICY_CONFIGURATION_PENDING"
  );
});

test("F-3: a service constructed without a gate verifier cannot exist", () => {
  assert.throws(
    () =>
      new FinancePostingService(
        new InMemoryFinancePostingRepository(),
        undefined as unknown as (gate: SandboxPostingGate) => void
      ),
    (error: unknown) =>
      error instanceof FinanceDomainError && error.code === "POLICY_CONFIGURATION_PENDING"
  );
});

test("F-3: a declared policy cannot claim more than the database authorized", async () => {
  const { service, command } = fixture();
  await rejects(
    () =>
      service.postCapitalReceipt({
        ...command,
        configuration: {
          ...command.configuration,
          policy: { ...command.configuration.policy, configurationState: "CLIENT_FINANCE_APPROVED" }
        }
      }),
    "POLICY_CONFIGURATION_PENDING"
  );
});

test("F-3: an expired sandbox authorization stops posting", async () => {
  const { service, command } = fixture();
  await rejects(
    () =>
      service.postCapitalReceipt({
        ...command,
        configuration: {
          ...command.configuration,
          gate: gate({
            authorization: {
              ...command.configuration.gate.authorization,
              expiresAt: "2026-09-22T07:00:00.000Z"
            }
          })
        }
      }),
    "POLICY_CONFIGURATION_PENDING"
  );
});

test("F-3: a gate resolved for another legal entity cannot post here", async () => {
  const { service, command } = fixture();
  await rejects(
    () =>
      service.postCapitalReceipt({
        ...command,
        configuration: {
          ...command.configuration,
          gate: gate({
            scope: {
              legalEntityId: otherEntityId,
              baseCurrency: "USD",
              authorizedAt: "2026-09-01T00:00:00.000Z"
            }
          })
        }
      }),
    "SCOPE_MISMATCH"
  );
});

test("F-3: an actor context that did not come from a server session is refused", async () => {
  const withoutSession = fixture();
  const actorWithoutSession = omit(withoutSession.command.actor, "sessionId");
  await rejects(
    () =>
      withoutSession.service.postCapitalReceipt({
        ...withoutSession.command,
        actor: actorWithoutSession
      }),
    "AUTHENTICATION_REQUIRED"
  );

  const expired = fixture();
  await rejects(
    () =>
      expired.service.postCapitalReceipt({
        ...expired.command,
        actor: { ...expired.command.actor, expiresAt: "2026-09-22T07:00:00.000Z" }
      }),
    "AUTHENTICATION_REQUIRED"
  );
});

// ---------------------------------------------------------------------------
// F-4. The commitment ceiling, not just the installment amount.
// ---------------------------------------------------------------------------

test("F-4: an installment within its own expected amount but over the remaining commitment is refused", async () => {
  const { service, command } = fixture();
  await rejects(
    () =>
      service.postCapitalReceipt({
        ...command,
        eligibility: {
          ...command.eligibility,
          // The installment is fully eligible, but only 100.00 of commitment is left.
          remainingEligibleAmount: { amount: asDecimalString("100.00"), currency: "USD" }
        }
      }),
    "INSTALLMENT_EXCEEDS_ELIGIBLE_AMOUNT"
  );
});

test("F-4: remaining eligibility must be denominated in the transaction currency", async () => {
  const { service, command } = fixture();
  await rejects(
    () =>
      service.postCapitalReceipt({
        ...command,
        eligibility: {
          ...command.eligibility,
          remainingEligibleAmount: { amount: asDecimalString("25000.00"), currency: "AFN" }
        }
      }),
    "CURRENCY_MISMATCH"
  );
});

// ---------------------------------------------------------------------------
// F-5 and F-6. Reversal control.
// ---------------------------------------------------------------------------

test("F-5: the actor who posted a journal cannot reverse it", async () => {
  const { service, command } = fixture();
  const journal = await service.postCapitalReceipt(command);
  await rejects(
    () =>
      service.reverseJournal(
        reversal(command, journal.id, {
          actor: { ...command.actor, permissions: ["finance.journal.reverse"] }
        })
      ),
    "SEGREGATION_OF_DUTIES_VIOLATION"
  );
});

test("F-6: a reversal needs its own accounting date, inside the open period", async () => {
  const missing = fixture();
  const first = await missing.service.postCapitalReceipt(missing.command);
  await rejects(
    () =>
      missing.service.reverseJournal(
        reversal(missing.command, first.id, { accountingEffectiveDate: "" })
      ),
    "ACCOUNTING_PERIOD_CLOSED"
  );

  const outside = fixture();
  const second = await outside.service.postCapitalReceipt(outside.command);
  await rejects(
    () =>
      outside.service.reverseJournal(
        // Inside no period; the old code passed the period's own start date and always passed.
        reversal(outside.command, second.id, { accountingEffectiveDate: "2026-10-15" })
      ),
    "ACCOUNTING_PERIOD_CLOSED"
  );
});

// ---------------------------------------------------------------------------
// F-7. The physical cash count is validated, not trusted.
// ---------------------------------------------------------------------------

test("F-7: an unconfirmed, mismatched or self-confirmed cash count blocks posting", async () => {
  const unconfirmed = fixture();
  const countWithoutConfirmation = omit(
    unconfirmed.command.configuration.physicalCashCount,
    "confirmedByUserAccountId"
  );
  await rejects(
    () =>
      unconfirmed.service.postCapitalReceipt({
        ...unconfirmed.command,
        configuration: {
          ...unconfirmed.command.configuration,
          physicalCashCount: { ...countWithoutConfirmation, status: "RECORDED" }
        }
      }),
    "EVIDENCE_REQUIRED"
  );

  const wrongCount = fixture();
  await rejects(
    () =>
      wrongCount.service.postCapitalReceipt(
        withCount(wrongCount.command, {
          id: id<PhysicalCashCountId>("10000000-0000-4000-8000-00000000ffff")
        })
      ),
    "EVIDENCE_REQUIRED"
  );

  const wrongAccount = fixture();
  await rejects(
    () =>
      wrongAccount.service.postCapitalReceipt(
        withCount(wrongAccount.command, {
          cashLocationCurrencyAccountId: id<CashLocationCurrencyAccountId>(
            "10000000-0000-4000-8000-00000000eeee"
          )
        })
      ),
    "SCOPE_MISMATCH"
  );

  const short = fixture();
  await rejects(
    () => short.service.postCapitalReceipt(withCount(short.command, { countedAmount: "24999.99" })),
    "EVIDENCE_REQUIRED"
  );

  const selfConfirmed = fixture();
  await rejects(
    () =>
      selfConfirmed.service.postCapitalReceipt(
        withCount(selfConfirmed.command, { confirmedByUserAccountId: cashierId })
      ),
    "SEGREGATION_OF_DUTIES_VIOLATION"
  );
});

// ---------------------------------------------------------------------------
// F-8. Cost-centre scope.
// ---------------------------------------------------------------------------

test("F-8: a cost-centre-scoped posting requires cost-centre authority", async () => {
  const withoutGrant = fixture();
  await rejects(
    () => withoutGrant.service.postCapitalReceipt(projectScoped(withoutGrant.command, [])),
    "SCOPE_MISMATCH"
  );

  const granted = fixture();
  const journal = await granted.service.postCapitalReceipt(
    projectScoped(granted.command, [costCenterId])
  );
  assert.equal(journal.status, "POSTED");
});

test("F-8: an actor with no costCenterIds field at all is refused, not waved through", async () => {
  const { service, command } = fixture();
  const scoped = projectScoped(command, []);
  const actorWithoutField = omit(scoped.actor, "costCenterIds");
  await rejects(
    () => service.postCapitalReceipt({ ...scoped, actor: actorWithoutField }),
    "SCOPE_MISMATCH"
  );
});

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

const syntheticFundingPolicy: CapitalAgreementFundingPolicy = {
  vocabularyVersion: "stage1-e0-v2",
  decisionReference: "SANDBOX-SYNTHETIC-E1",
  decidedBy: "SANDBOX_SYNTHETIC",
  fundableStatuses: ["ELIGIBLE"],
  decidedAt: "2026-09-01T00:00:00.000Z"
};

function gate(overrides: Partial<SandboxPostingGate> = {}): SandboxPostingGate {
  return {
    authorization: {
      singleton: true,
      environment: "test",
      configurationState: "SYNTHETIC_TEST_ONLY",
      policyVersionId: "synthetic-test-policy-v1",
      realPostingEnabled: false,
      runtimeMarker: "synthetic-sandbox-marker",
      authorizedByUserAccountId: id<UserAccountId>("10000000-0000-4000-8000-0000000000ff"),
      authorizedAt: "2026-09-01T00:00:00.000Z",
      expiresAt: "2026-12-31T00:00:00.000Z"
    },
    scope: { legalEntityId, baseCurrency: "USD", authorizedAt: "2026-09-01T00:00:00.000Z" },
    resolvedAt: "2026-09-22T07:55:00.000Z",
    signature: SIGNATURE,
    ...overrides
  };
}

function verifier(candidate: SandboxPostingGate): void {
  if (candidate.signature !== SIGNATURE) {
    throw new FinanceDomainError(
      "POLICY_CONFIGURATION_PENDING",
      "The sandbox gate signature is invalid"
    );
  }
}

function fixture() {
  const repository = new InMemoryFinancePostingRepository();
  let sequence = 0;
  const service = new FinancePostingService(
    repository,
    verifier,
    () => "2026-09-22T08:00:00.000Z",
    () => `20000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`
  );
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
      evidence: [evidence("FORMAL_REGISTRATION", "reg"), evidence("CASH_RECEIPT", "receipt")],
      status: "APPROVED"
    },
    eligibility: {
      installmentId,
      agreementId,
      eligibleAmount: { amount: asDecimalString("25000.00"), currency: "USD" },
      canonicalAgreementStatus: "ELIGIBLE",
      remainingEligibleAmount: { amount: asDecimalString("25000.00"), currency: "USD" },
      partialInstallmentsAllowed: false,
      registrationEvidence: evidence("FORMAL_REGISTRATION", "reg")
    },
    treasuryReceipt: {
      id: receiptId,
      capitalReceiptIntentId: sourceIntentId,
      destinationType: "CASH_LOCATION",
      destinationAccountId: cashAccountId,
      physicalCashCountId: countId,
      amount: { amount: asDecimalString("25000.00"), currency: "USD" },
      cashierUserAccountId: cashierId,
      evidence: [evidence("CASH_RECEIPT", "receipt")],
      verifiedAt: "2026-09-22T07:30:00.000Z",
      status: "VERIFIED"
    },
    approval: {
      id: id<FinanceApprovalId>("10000000-0000-4000-8000-000000000014"),
      postingIntentId,
      approvedByUserAccountId: approverId,
      approvedAt: "2026-09-22T07:45:00.000Z",
      evidence: [evidence("FINANCE_APPROVAL", "approval")],
      status: "APPROVED"
    },
    actor: {
      userAccountId: approverId,
      permissions: ["finance.posting-intent.approve", "finance.journal.post"],
      legalEntityIds: [legalEntityId],
      projectIds: [] as ProjectId[],
      departmentIds: [] as DepartmentId[],
      costCenterIds: [] as CostCenterId[],
      authenticatedAt: "2026-09-22T07:40:00.000Z",
      sessionId: "30000000-0000-4000-8000-000000000001",
      expiresAt: "2026-09-22T08:15:00.000Z"
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
      gate: gate(),
      fundingPolicy: syntheticFundingPolicy,
      physicalCashCount: {
        id: countId,
        legalEntityId,
        cashLocationCurrencyAccountId: cashAccountId,
        currency: "USD",
        countedAmount: "25000.00",
        countedAt: "2026-09-22T07:25:00.000Z",
        countedByUserAccountId: cashierId,
        status: "CONFIRMED",
        confirmedByUserAccountId: confirmerId
      },
      accountingPeriod: {
        id: periodId,
        legalEntityId,
        status: "OPEN",
        startsOn: "2026-09-01",
        endsOn: "2026-09-30"
      },
      ledgerAccounts: new Map([
        [cashLedgerId, { id: cashLedgerId, legalEntityId, status: "ACTIVE" as const, postable: true }],
        [
          capitalLedgerId,
          { id: capitalLedgerId, legalEntityId, status: "ACTIVE" as const, postable: true }
        ]
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

function reversal(
  command: PostCapitalReceiptCommand,
  journalId: ReverseJournalCommand["originalJournalId"],
  overrides: Partial<ReverseJournalCommand> = {}
): ReverseJournalCommand {
  return {
    originalJournalId: journalId,
    accountingPeriod: command.configuration.accountingPeriod,
    actor: {
      ...command.actor,
      userAccountId: reverserId,
      permissions: ["finance.journal.reverse"],
      sessionId: "30000000-0000-4000-8000-000000000002"
    },
    metadata: {
      correlationId: id<CorrelationId>("reversal-correlation"),
      idempotencyKey: id<IdempotencyKey>("reversal-key")
    },
    reason: "Synthetic reversal under E1 hardening tests",
    evidence: [evidence("REVERSAL_REASON", "reversal")],
    policy: command.configuration.policy,
    gate: command.configuration.gate,
    accountingEffectiveDate: "2026-09-23",
    ledgerAccounts: command.configuration.ledgerAccounts,
    ...overrides
  };
}

function withCount(
  command: PostCapitalReceiptCommand,
  overrides: Partial<PostCapitalReceiptCommand["configuration"]["physicalCashCount"]>
): PostCapitalReceiptCommand {
  return {
    ...command,
    configuration: {
      ...command.configuration,
      physicalCashCount: { ...command.configuration.physicalCashCount, ...overrides }
    }
  };
}

/** Moves the transaction to a project/cost-centre scope and sets the actor's cost-centre grants. */
function projectScoped(
  command: PostCapitalReceiptCommand,
  costCenterIds: readonly CostCenterId[]
): PostCapitalReceiptCommand {
  const dimensions = {
    scope: "PROJECT_LEVEL",
    legalEntityId,
    projectId,
    departmentId,
    costCenterId
  } as const;
  return {
    ...command,
    intent: { ...command.intent, dimensions },
    actor: {
      ...command.actor,
      projectIds: [projectId],
      departmentIds: [departmentId],
      costCenterIds
    }
  };
}

/** Builds a copy without one optional property, to model a caller that simply did not send it. */
function omit<Value extends object, Key extends keyof Value>(
  value: Value,
  key: Key
): Omit<Value, Key> {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

function evidence(kind: EvidenceReference["kind"], suffix: string): EvidenceReference {
  return {
    id: id<EvidenceReferenceId>(`40000000-0000-4000-8000-${suffix.padEnd(12, "0").slice(0, 12)}`),
    documentId: id<DocumentId>(`50000000-0000-4000-8000-${suffix.padEnd(12, "0").slice(0, 12)}`),
    kind,
    version: 1,
    sha256: "a".repeat(64),
    completedAt: "2026-09-22T07:00:00.000Z"
  };
}

async function rejects(
  action: () => Promise<unknown>,
  code: FinanceDomainError["code"]
): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof FinanceDomainError, `expected a FinanceDomainError, got ${String(error)}`);
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    return true;
  });
}
