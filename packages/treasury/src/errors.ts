import type { StageOneErrorCode } from "@abos/contracts";

export class TreasuryDomainError extends Error {
  readonly code: StageOneErrorCode;

  constructor(code: StageOneErrorCode, message: string) {
    super(message);
    this.name = "TreasuryDomainError";
    this.code = code;
  }
}

export function assertTreasury(
  condition: unknown,
  code: StageOneErrorCode,
  message: string
): asserts condition {
  if (!condition) throw new TreasuryDomainError(code, message);
}
