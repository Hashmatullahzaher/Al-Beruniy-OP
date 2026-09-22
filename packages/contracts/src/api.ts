import type { CorrelationId, IdempotencyKey } from "./ids.ts";

export type StageOneErrorCode =
  | "AUTHENTICATION_REQUIRED"
  | "PERMISSION_DENIED"
  | "SCOPE_MISMATCH"
  | "SEGREGATION_OF_DUTIES_VIOLATION"
  | "POLICY_CONFIGURATION_PENDING"
  | "ACCOUNTING_PERIOD_CLOSED"
  | "CAPITAL_AGREEMENT_REQUIRED"
  | "REGISTRATION_EVIDENCE_REQUIRED"
  | "INSTALLMENT_EXCEEDS_ELIGIBLE_AMOUNT"
  | "TREASURY_RECEIPT_NOT_VERIFIED"
  | "CASH_ACCOUNT_INACTIVE"
  | "OPENING_POSITION_NOT_APPROVED"
  | "CURRENCY_MISMATCH"
  | "JOURNAL_UNBALANCED"
  | "EVIDENCE_REQUIRED"
  | "IDEMPOTENCY_CONFLICT"
  | "POSTED_RECORD_IMMUTABLE"
  | "NOT_FOUND";

export interface RequestMetadata {
  readonly correlationId: CorrelationId;
  readonly idempotencyKey: IdempotencyKey;
}

export type ApiResult<T> =
  | { readonly ok: true; readonly data: T; readonly correlationId: CorrelationId }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: StageOneErrorCode;
        readonly message: string;
        readonly retryable: boolean;
      };
      readonly correlationId: CorrelationId;
    };
