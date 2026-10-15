import type {
  CorrelationId,
  IdempotencyKey,
  ShareholderCapitalCustodyDecisionRequest,
  ShareholderCapitalMappingConfigureRequest,
  ShareholderCapitalPostingCommandResult,
  ShareholderCapitalPostingDecisionRequest,
  ShareholderCapitalPostingPostRequest,
  ShareholderCapitalPostingPrepareRequest,
  ShareholderCapitalReceiptCommandResult,
  ShareholderCapitalReceiptRecordRequest,
  ShareholderCapitalTraceReadModel,
  ShareholderFinanceCapability
} from "@abos/contracts";

import { FinanceDomainError } from "./errors.ts";

/** Server-only request facts. None of these values is accepted from a JSON request body. */
export interface ShareholderFinanceRequestContext {
  readonly sessionProof: string;
  readonly idempotencyKey: IdempotencyKey;
  readonly correlationId: CorrelationId;
}

export interface ShareholderFinanceReadContext {
  readonly sessionProof: string;
  readonly correlationId: CorrelationId;
}

/**
 * Future PostgreSQL adapter boundary.
 *
 * Each method must call one reviewed SECURITY DEFINER entry point. PostgreSQL resolves the current
 * PASSWORD_OPERATIONAL session, actor, legal entity, live permission, source record, policy and
 * account mapping. Implementations must never translate caller JSON into an actor context.
 */
export interface OperationalShareholderFinanceGateway {
  readonly kind: "COORDINATED_POSTGRES" | "UNAVAILABLE";
  capability(): Promise<ShareholderFinanceCapability>;
  configureMapping(context: ShareholderFinanceRequestContext, input: ShareholderCapitalMappingConfigureRequest): Promise<Readonly<Record<string, unknown>>>;
  recordReceipt(context: ShareholderFinanceRequestContext, input: ShareholderCapitalReceiptRecordRequest): Promise<ShareholderCapitalReceiptCommandResult>;
  verifyCustody(context: ShareholderFinanceRequestContext, receiptId: string, input: ShareholderCapitalCustodyDecisionRequest): Promise<ShareholderCapitalReceiptCommandResult>;
  preparePosting(context: ShareholderFinanceRequestContext, receiptId: string, input: ShareholderCapitalPostingPrepareRequest): Promise<ShareholderCapitalPostingCommandResult>;
  decidePosting(context: ShareholderFinanceRequestContext, postingIntentId: string, input: ShareholderCapitalPostingDecisionRequest): Promise<ShareholderCapitalPostingCommandResult>;
  postReceipt(context: ShareholderFinanceRequestContext, postingIntentId: string, input: ShareholderCapitalPostingPostRequest): Promise<ShareholderCapitalPostingCommandResult>;
  readTrace(context: ShareholderFinanceReadContext, contributionId: string): Promise<ShareholderCapitalTraceReadModel>;
}

export const UNAVAILABLE_SHAREHOLDER_FINANCE_CAPABILITY: ShareholderFinanceCapability = Object.freeze({
  state: "SCHEMA_NOT_AVAILABLE",
  schemaInstalled: false,
  mutationAvailable: false,
  reviewModeAvailable: false,
  requiredSessionProvenance: "PASSWORD_OPERATIONAL",
  reason: "The coordinated Shareholders to Finance database capability is not installed."
});

/** Explicit fail-closed adapter. It cannot store data and never falls back to process memory. */
export class UnavailableShareholderFinanceGateway implements OperationalShareholderFinanceGateway {
  readonly kind = "UNAVAILABLE" as const;

  async capability(): Promise<ShareholderFinanceCapability> {
    return UNAVAILABLE_SHAREHOLDER_FINANCE_CAPABILITY;
  }

  async recordReceipt(): Promise<never> { return unavailable(); }
  async configureMapping(): Promise<never> { return unavailable(); }
  async verifyCustody(): Promise<never> { return unavailable(); }
  async preparePosting(): Promise<never> { return unavailable(); }
  async decidePosting(): Promise<never> { return unavailable(); }
  async postReceipt(): Promise<never> { return unavailable(); }
  async readTrace(): Promise<never> { return unavailable(); }
}

/**
 * Production application service. Capability is checked for every call, including reads and
 * retries. A missing schema is a stable typed failure, never an in-memory success response.
 */
export class ShareholderFinanceApplicationService {
  private readonly gateway: OperationalShareholderFinanceGateway;

  constructor(gateway: OperationalShareholderFinanceGateway) {
    this.gateway = gateway;
  }

  capability(): Promise<ShareholderFinanceCapability> { return this.gateway.capability(); }

  async configureMapping(context: ShareholderFinanceRequestContext, input: ShareholderCapitalMappingConfigureRequest) {
    await this.requireOperational(); validateWriteContext(context);
    return this.gateway.configureMapping(context, input);
  }

  async recordReceipt(context: ShareholderFinanceRequestContext, input: ShareholderCapitalReceiptRecordRequest) {
    await this.requireOperational(); validateWriteContext(context);
    return this.gateway.recordReceipt(context, input);
  }

  async verifyCustody(context: ShareholderFinanceRequestContext, receiptId: string, input: ShareholderCapitalCustodyDecisionRequest) {
    await this.requireOperational(); validateWriteContext(context); validateResourceId(receiptId);
    return this.gateway.verifyCustody(context, receiptId, input);
  }

  async preparePosting(context: ShareholderFinanceRequestContext, receiptId: string, input: ShareholderCapitalPostingPrepareRequest) {
    await this.requireOperational(); validateWriteContext(context); validateResourceId(receiptId);
    return this.gateway.preparePosting(context, receiptId, input);
  }

  async decidePosting(context: ShareholderFinanceRequestContext, postingIntentId: string, input: ShareholderCapitalPostingDecisionRequest) {
    await this.requireOperational(); validateWriteContext(context); validateResourceId(postingIntentId);
    return this.gateway.decidePosting(context, postingIntentId, input);
  }

  async postReceipt(context: ShareholderFinanceRequestContext, postingIntentId: string, input: ShareholderCapitalPostingPostRequest) {
    await this.requireOperational(); validateWriteContext(context); validateResourceId(postingIntentId);
    return this.gateway.postReceipt(context, postingIntentId, input);
  }

  async readTrace(context: ShareholderFinanceReadContext, contributionId: string) {
    await this.requireOperational(); validateReadContext(context); validateResourceId(contributionId);
    return this.gateway.readTrace(context, contributionId);
  }

  private async requireOperational(): Promise<void> {
    const capability = await this.gateway.capability();
    if (capability.state !== "OPERATIONAL" || !capability.schemaInstalled || !capability.mutationAvailable
        || this.gateway.kind !== "COORDINATED_POSTGRES") {
      throw new FinanceDomainError("SCHEMA_NOT_AVAILABLE", capability.reason);
    }
  }
}

function validateWriteContext(context: ShareholderFinanceRequestContext): void {
  validateReadContext(context);
  if (context.idempotencyKey.trim().length < 8 || context.idempotencyKey.length > 200) {
    throw new FinanceDomainError("IDEMPOTENCY_CONFLICT", "A stable idempotency key is required.");
  }
}

function validateReadContext(context: ShareholderFinanceReadContext): void {
  if (context.sessionProof.trim().length === 0) {
    throw new FinanceDomainError("AUTHENTICATION_REQUIRED", "An active operational session is required.");
  }
  if (context.correlationId.trim().length < 8 || context.correlationId.length > 200) {
    throw new FinanceDomainError("IDEMPOTENCY_CONFLICT", "A correlation identifier is required.");
  }
}

function validateResourceId(value: string): void {
  if (value.trim().length === 0) throw new FinanceDomainError("NOT_FOUND", "The requested resource is unavailable.");
}

function unavailable(): never {
  throw new FinanceDomainError("SCHEMA_NOT_AVAILABLE", UNAVAILABLE_SHAREHOLDER_FINANCE_CAPABILITY.reason);
}
