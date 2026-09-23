import assert from "node:assert/strict";
import test from "node:test";
import { readSandboxConfiguration } from "./configuration.ts";
import { SandboxAuthError } from "./errors.ts";

/**
 * The point of these tests is the absence of defaults.
 *
 * Finding F-3 was that the synthetic-only gate could be satisfied by a caller. Part of closing it
 * is that a process which has not been explicitly configured as a sandbox cannot authenticate
 * anybody - so every one of these cases must throw rather than fall back.
 */

const VALID = {
  ABOS_ENVIRONMENT: "test",
  ABOS_SANDBOX_RUNTIME_MARKER: "synthetic-e1-sandbox-marker",
  ABOS_SANDBOX_SIGNING_SECRET: "a".repeat(32)
};

test("a fully configured sandbox process reads its configuration", () => {
  const configuration = readSandboxConfiguration(VALID);
  assert.equal(configuration.environment, "test");
  assert.equal(configuration.runtimeMarker, VALID.ABOS_SANDBOX_RUNTIME_MARKER);
  assert.equal(configuration.maxSessionSeconds, 900);
});

test("every required value fails closed when missing or blank", () => {
  for (const key of Object.keys(VALID)) {
    const missing = { ...VALID, [key]: undefined };
    assert.throws(() => readSandboxConfiguration(missing), matching(/is not configured/), `${key} missing`);
    const blank = { ...VALID, [key]: "   " };
    assert.throws(() => readSandboxConfiguration(blank), matching(/is not configured/), `${key} blank`);
  }
});

test("a production or staging environment is refused outright", () => {
  for (const environment of ["production", "staging", "prod", "Production"]) {
    assert.throws(
      () => readSandboxConfiguration({ ...VALID, ABOS_ENVIRONMENT: environment }),
      matching(/development or test only/),
      environment
    );
  }
});

test("a short marker or a short signing secret is refused", () => {
  assert.throws(
    () => readSandboxConfiguration({ ...VALID, ABOS_SANDBOX_RUNTIME_MARKER: "too-short" }),
    matching(/at least 16 characters/)
  );
  assert.throws(
    () => readSandboxConfiguration({ ...VALID, ABOS_SANDBOX_SIGNING_SECRET: "b".repeat(31) }),
    matching(/at least 32 characters/)
  );
});

test("a sandbox session cannot be configured to outlive an hour", () => {
  assert.throws(
    () => readSandboxConfiguration({ ...VALID, ABOS_SANDBOX_MAX_SESSION_SECONDS: "3601" }),
    matching(/cannot exceed 3600 seconds/)
  );
  assert.throws(
    () => readSandboxConfiguration({ ...VALID, ABOS_SANDBOX_MAX_SESSION_SECONDS: "0" }),
    matching(/positive integer/)
  );
  assert.throws(
    () => readSandboxConfiguration({ ...VALID, ABOS_SANDBOX_MAX_SESSION_SECONDS: "not-a-number" }),
    matching(/positive integer/)
  );
  assert.equal(
    readSandboxConfiguration({ ...VALID, ABOS_SANDBOX_MAX_SESSION_SECONDS: "60" }).maxSessionSeconds,
    60
  );
});

test("there is no signing secret in the source of this package", async () => {
  // A default secret is the single most likely way for a sandbox credential scheme to become
  // useless, so its absence is asserted rather than assumed.
  const { readFile } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  const source = await readFile(resolve(import.meta.dirname, "configuration.ts"), "utf8");
  assert.doesNotMatch(source, /signingSecret\s*[:=]\s*["'`]/);
  assert.doesNotMatch(source, /runtimeMarker\s*[:=]\s*["'`]/);
});

function matching(pattern: RegExp) {
  return (error: unknown) => {
    assert.ok(error instanceof SandboxAuthError, `expected SandboxAuthError, got ${String(error)}`);
    assert.match(error.message, pattern);
    return true;
  };
}
