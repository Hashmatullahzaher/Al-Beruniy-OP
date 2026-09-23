import type { StageOneErrorCode } from "@abos/contracts";

export class SandboxAuthError extends Error {
  readonly code: StageOneErrorCode;

  constructor(code: StageOneErrorCode, message: string) {
    super(message);
    this.name = "SandboxAuthError";
    this.code = code;
  }
}

export function assertSandbox(
  condition: unknown,
  code: StageOneErrorCode,
  message: string
): asserts condition {
  if (!condition) throw new SandboxAuthError(code, message);
}
