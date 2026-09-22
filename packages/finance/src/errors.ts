import type { StageOneErrorCode } from "@abos/contracts";

export class FinanceDomainError extends Error {
  readonly code: StageOneErrorCode;
  constructor(code: StageOneErrorCode, message: string) {
    super(message);
    this.name = "FinanceDomainError";
    this.code = code;
  }
}

export function assertFinance(condition: unknown, code: StageOneErrorCode, message: string): asserts condition {
  if (!condition) throw new FinanceDomainError(code, message);
}
