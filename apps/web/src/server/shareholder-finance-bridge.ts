import { randomUUID } from "node:crypto";

import type { ShareholderFinanceCapability } from "@abos/contracts";

/**
 * Application gate for the coordinated Shareholders → Finance schema.
 *
 * There is deliberately no environment variable that can declare the schema operational. A later
 * reviewed PostgreSQL adapter must replace this capability provider with a database-backed schema,
 * function-ownership and permission probe. Until then every production command returns the same
 * explicit fail-closed state and never falls back to memory.
 */
export function shareholderFinanceCapability(
  environment: Readonly<Record<string, string | undefined>> = process.env
): ShareholderFinanceCapability {
  const reviewModeAvailable = environment.NODE_ENV !== "production"
    && environment.ABOS_SHAREHOLDER_FINANCE_REVIEW_MODE === "1";
  return {
    state: "SCHEMA_NOT_AVAILABLE",
    schemaInstalled: false,
    mutationAvailable: false,
    reviewModeAvailable,
    requiredSessionProvenance: "PASSWORD_OPERATIONAL",
    reason: "The coordinated Shareholders to Finance database capability is not installed."
  };
}

export function shareholderFinanceCapabilityResponse(request?: Request): Response {
  const capability = shareholderFinanceCapability();
  const requestedCorrelation = request?.headers.get("x-correlation-id")?.trim();
  const correlationId = requestedCorrelation && requestedCorrelation.length <= 200
    ? requestedCorrelation
    : randomUUID();
  return Response.json({
    ok: false,
    error: {
      code: capability.state,
      message: capability.reason,
      retryable: false
    },
    capability,
    correlationId
  }, { status: 503, headers: { "cache-control": "no-store" } });
}
