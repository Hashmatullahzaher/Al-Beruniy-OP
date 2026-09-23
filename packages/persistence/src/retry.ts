/**
 * Bounded, typed retry for transient PostgreSQL failures.
 *
 * Only two classes of failure are retried, and both mean "the database asked you to try again",
 * never "this request is wrong":
 *
 *   40001 serialization_failure  - a snapshot conflict under REPEATABLE READ or SERIALIZABLE
 *   40P01 deadlock_detected      - the deadlock detector chose this transaction as the victim
 *
 * Everything else is returned to the caller untouched. In particular a validation failure, a
 * permission failure, a duplicate semantic request (23505 unique_violation) and a policy failure
 * are NOT retried: retrying a check violation just produces the same refusal, and retrying a unique
 * violation would paper over exactly the idempotency conflicts the kernel exists to surface.
 */

/** PostgreSQL SQLSTATE codes the database itself marks as "retry the whole transaction". */
export const RETRYABLE_SQLSTATES: ReadonlySet<string> = new Set(["40001", "40P01"]);

export interface RetryPolicy {
  /** Total attempts, including the first. Must be at least 1 and is deliberately small. */
  readonly maxAttempts: number;
  /** Base backoff in milliseconds; each attempt waits baseDelayMs * 2^(attempt - 1) plus jitter. */
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 10,
  maxDelayMs: 200
};

/** One observable record per attempt, so retries are never silent. */
export interface RetryAttempt {
  readonly operation: string;
  readonly attempt: number;
  readonly sqlState: string;
  readonly delayMs: number;
  readonly message: string;
}

export type RetryObserver = (attempt: RetryAttempt) => void;

export class RetryBudgetExhaustedError extends Error {
  readonly operation: string;
  readonly attempts: number;
  readonly sqlState: string;

  constructor(operation: string, attempts: number, sqlState: string, cause: unknown) {
    super(
      `${operation} still failed with SQLSTATE ${sqlState} after ${attempts} attempts; ` +
        "the retry budget is exhausted and the transaction was not applied"
    );
    this.name = "RetryBudgetExhaustedError";
    this.operation = operation;
    this.attempts = attempts;
    this.sqlState = sqlState;
    this.cause = cause;
  }
}

export function sqlStateOf(error: unknown): string | undefined {
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

export function isRetryable(error: unknown): boolean {
  const state = sqlStateOf(error);
  return state !== undefined && RETRYABLE_SQLSTATES.has(state);
}

/**
 * Runs `operation` and retries it only on a transient conflict.
 *
 * `operation` must be the *whole* transaction, not a statement inside one: a serialization failure
 * aborts the transaction, so anything already done in it has to be redone from the start.
 */
export async function withRetry<Result>(
  name: string,
  operation: () => Promise<Result>,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  observe: RetryObserver = () => {},
  sleep: (ms: number) => Promise<void> = defaultSleep
): Promise<Result> {
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
    throw new Error("A retry policy needs at least one attempt");
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isRetryable(error)) throw error;
      lastError = error;
      const sqlState = sqlStateOf(error) ?? "unknown";
      if (attempt === policy.maxAttempts) {
        throw new RetryBudgetExhaustedError(name, attempt, sqlState, error);
      }
      const delayMs = backoff(policy, attempt);
      observe({
        operation: name,
        attempt,
        sqlState,
        delayMs,
        message: error instanceof Error ? error.message : String(error)
      });
      await sleep(delayMs);
    }
  }
  /* c8 ignore next */
  throw lastError;
}

function backoff(policy: RetryPolicy, attempt: number): number {
  const exponential = policy.baseDelayMs * 2 ** (attempt - 1);
  const capped = Math.min(exponential, policy.maxDelayMs);
  // Full jitter, so simultaneous victims do not retry in lockstep.
  return Math.floor(Math.random() * capped);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
