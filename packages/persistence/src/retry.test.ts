import assert from "node:assert/strict";
import test from "node:test";
import {
  isRetryable,
  RetryBudgetExhaustedError,
  withRetry,
  type RetryAttempt
} from "./retry.ts";

/**
 * Retry is only ever correct when it is narrow. These tests pin down what is retried and, more
 * importantly, what is not: retrying a validation, permission, duplicate or policy failure would
 * turn a clear refusal into a slow one, and would paper over the idempotency conflicts the Finance
 * kernel exists to surface.
 */

const noSleep = async () => {};

test("a serialization failure and a deadlock are retried", async () => {
  for (const code of ["40001", "40P01"]) {
    let attempts = 0;
    const result = await withRetry(
      "test",
      async () => {
        attempts += 1;
        if (attempts < 3) throw sqlError(code);
        return "committed";
      },
      { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 },
      () => {},
      noSleep
    );
    assert.equal(result, "committed");
    assert.equal(attempts, 3, `${code} should have been retried twice`);
  }
});

test("validation, permission, duplicate and policy failures are never retried", async () => {
  const notRetried = [
    ["23505", "unique_violation - a duplicate semantic request"],
    ["23514", "check_violation - a policy or validation failure"],
    ["23503", "foreign_key_violation - a referential failure"],
    ["42501", "insufficient_privilege - a permission failure"],
    ["P0001", "raise_exception - every trigger refusal in this schema"]
  ] as const;

  for (const [code, description] of notRetried) {
    let attempts = 0;
    await assert.rejects(
      () =>
        withRetry(
          "test",
          async () => {
            attempts += 1;
            throw sqlError(code);
          },
          { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 2 },
          () => {},
          noSleep
        ),
      (error: unknown) => sqlStateOf(error) === code
    );
    assert.equal(attempts, 1, `${description} must be raised on the first attempt`);
  }
});

test("an error with no SQLSTATE is not retried", async () => {
  let attempts = 0;
  await assert.rejects(
    () =>
      withRetry(
        "test",
        async () => {
          attempts += 1;
          throw new Error("something else went wrong");
        },
        { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 2 },
        () => {},
        noSleep
      ),
    /something else went wrong/
  );
  assert.equal(attempts, 1);
});

test("the retry budget is bounded, and exhausting it is a typed failure", async () => {
  let attempts = 0;
  await assert.rejects(
    () =>
      withRetry(
        "postgres.transaction",
        async () => {
          attempts += 1;
          throw sqlError("40001");
        },
        { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 },
        () => {},
        noSleep
      ),
    (error: unknown) => {
      assert.ok(error instanceof RetryBudgetExhaustedError);
      assert.equal(error.attempts, 3);
      assert.equal(error.sqlState, "40001");
      assert.equal(error.operation, "postgres.transaction");
      assert.match(error.message, /was not applied/);
      return true;
    }
  );
  assert.equal(attempts, 3, "it stops at the budget rather than looping");
});

test("every retry is observable", async () => {
  const observed: RetryAttempt[] = [];
  let attempts = 0;
  await withRetry(
    "postgres.transaction",
    async () => {
      attempts += 1;
      if (attempts < 3) throw sqlError("40P01");
      return true;
    },
    { maxAttempts: 4, baseDelayMs: 4, maxDelayMs: 8 },
    (attempt) => observed.push(attempt),
    noSleep
  );
  assert.equal(observed.length, 2, "a silent retry is a retry nobody can diagnose");
  assert.deepEqual(
    observed.map((attempt) => attempt.attempt),
    [1, 2]
  );
  for (const attempt of observed) {
    assert.equal(attempt.operation, "postgres.transaction");
    assert.equal(attempt.sqlState, "40P01");
    assert.ok(attempt.delayMs >= 0 && attempt.delayMs <= 8, "backoff stays inside its cap");
  }
});

test("isRetryable recognises exactly the two transient classes", () => {
  assert.equal(isRetryable(sqlError("40001")), true);
  assert.equal(isRetryable(sqlError("40P01")), true);
  assert.equal(isRetryable(sqlError("23505")), false);
  assert.equal(isRetryable(new Error("no code")), false);
  assert.equal(isRetryable(undefined), false);
  assert.equal(isRetryable(null), false);
});

test("a policy with no attempts is rejected rather than silently doing nothing", async () => {
  await assert.rejects(
    () => withRetry("test", async () => "x", { maxAttempts: 0, baseDelayMs: 1, maxDelayMs: 1 }),
    /at least one attempt/
  );
});

function sqlError(code: string): Error & { readonly code: string } {
  return Object.assign(new Error(`SQLSTATE ${code}`), { code });
}

function sqlStateOf(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error
    ? String((error as { readonly code: unknown }).code)
    : undefined;
}
