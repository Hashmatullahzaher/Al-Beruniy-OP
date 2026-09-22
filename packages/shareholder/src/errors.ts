import type { StageOneErrorCode } from "@abos/contracts";

export class ShareholderDomainError extends Error {
  readonly code: StageOneErrorCode;
  constructor(code: StageOneErrorCode, message: string) {
    super(message);
    this.name = "ShareholderDomainError";
    this.code = code;
  }
}

export function assertShareholder(
  condition: unknown,
  code: StageOneErrorCode,
  message: string
): asserts condition {
  if (!condition) throw new ShareholderDomainError(code, message);
}
