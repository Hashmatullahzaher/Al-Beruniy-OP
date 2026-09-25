export type IdentityErrorCode =
  | "AUTHENTICATION_REQUIRED"
  | "INVALID_CREDENTIALS"
  | "PASSWORD_CHANGE_REQUIRED"
  | "TEMPORARY_PASSWORD_EXPIRED"
  | "ACCOUNT_INACTIVE"
  | "NO_ACCESS_ASSIGNED"
  | "THROTTLED"
  | "PERMISSION_DENIED"
  | "SELF_CHANGE_FORBIDDEN"
  | "SUPER_ADMIN_REQUIRED"
  | "LAST_SUPER_ADMIN"
  | "NOT_FOUND"
  | "DUPLICATE"
  | "VALIDATION_FAILED"
  | "STALE_VERSION";

export class IdentityError extends Error {
  readonly code: IdentityErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: IdentityErrorCode, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = "IdentityError";
    this.code = code;
    this.details = details;
  }
}

export function assertIdentity(condition: unknown, code: IdentityErrorCode, message: string, details?: Readonly<Record<string, unknown>>): asserts condition {
  if (!condition) throw new IdentityError(code, message, details);
}
