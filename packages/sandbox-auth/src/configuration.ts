import { SandboxAuthError } from "./errors.ts";

/**
 * Process-level sandbox configuration.
 *
 * Every value is required and none has a default. There is no "if unset, assume development"
 * branch anywhere in this module: an unconfigured process cannot authenticate anybody, which is the
 * only behaviour that makes finding F-3 actually closed rather than merely documented.
 */
export interface SandboxAuthConfiguration {
  /** Must match `abos.sandbox_authorizations.runtime_marker` in the target database. */
  readonly runtimeMarker: string;
  /**
   * Peppers the session-token digest, so a database dump alone cannot be turned into a usable
   * credential. Never written to the database and never logged.
   */
  readonly signingSecret: string;
  readonly environment: "development" | "test";
  /** Upper bound on session lifetime; the database independently caps this at 60 minutes. */
  readonly maxSessionSeconds: number;
}

const MINIMUM_MARKER_LENGTH = 16;
const MINIMUM_SECRET_LENGTH = 32;
const ABSOLUTE_MAX_SESSION_SECONDS = 3600;

/**
 * Reads the configuration from an environment map, failing closed on anything missing, short,
 * blank or production-like.
 *
 * `environment` is deliberately read from the process, never from a request. A request cannot
 * declare itself to be running in a sandbox.
 */
export function readSandboxConfiguration(
  environment: Readonly<Record<string, string | undefined>> = process.env
): SandboxAuthConfiguration {
  const declared = required(environment, "ABOS_ENVIRONMENT");
  if (declared !== "development" && declared !== "test") {
    throw new SandboxAuthError(
      "POLICY_CONFIGURATION_PENDING",
      `E1 runs in development or test only; ABOS_ENVIRONMENT is ${declared}`
    );
  }

  const runtimeMarker = required(environment, "ABOS_SANDBOX_RUNTIME_MARKER");
  if (runtimeMarker.length < MINIMUM_MARKER_LENGTH) {
    throw new SandboxAuthError(
      "POLICY_CONFIGURATION_PENDING",
      `ABOS_SANDBOX_RUNTIME_MARKER must be at least ${MINIMUM_MARKER_LENGTH} characters`
    );
  }

  const signingSecret = required(environment, "ABOS_SANDBOX_SIGNING_SECRET");
  if (signingSecret.length < MINIMUM_SECRET_LENGTH) {
    throw new SandboxAuthError(
      "POLICY_CONFIGURATION_PENDING",
      `ABOS_SANDBOX_SIGNING_SECRET must be at least ${MINIMUM_SECRET_LENGTH} characters`
    );
  }

  const rawMax = environment.ABOS_SANDBOX_MAX_SESSION_SECONDS;
  const maxSessionSeconds = rawMax === undefined ? 900 : Number.parseInt(rawMax, 10);
  if (!Number.isInteger(maxSessionSeconds) || maxSessionSeconds <= 0) {
    throw new SandboxAuthError(
      "POLICY_CONFIGURATION_PENDING",
      "ABOS_SANDBOX_MAX_SESSION_SECONDS must be a positive integer when set"
    );
  }
  if (maxSessionSeconds > ABSOLUTE_MAX_SESSION_SECONDS) {
    throw new SandboxAuthError(
      "POLICY_CONFIGURATION_PENDING",
      `Sandbox sessions cannot exceed ${ABSOLUTE_MAX_SESSION_SECONDS} seconds`
    );
  }

  return { runtimeMarker, signingSecret, environment: declared, maxSessionSeconds };
}

function required(
  environment: Readonly<Record<string, string | undefined>>,
  name: string
): string {
  const value = environment[name];
  if (value === undefined || value.trim().length === 0) {
    throw new SandboxAuthError(
      "POLICY_CONFIGURATION_PENDING",
      `${name} is not configured. The E1 sandbox has no default for it.`
    );
  }
  return value;
}
