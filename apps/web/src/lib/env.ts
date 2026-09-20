import type { EnvironmentName } from "@abos/contracts";

function readEnvironment(value: string | undefined): EnvironmentName {
  if (value === "staging" || value === "production") {
    return value;
  }

  return "development";
}

export const publicEnvironment = {
  applicationName: process.env.NEXT_PUBLIC_APP_NAME?.trim() || "AL-BERUNIY Operating System",
  environment: readEnvironment(process.env.NEXT_PUBLIC_APP_ENV),
  gitSha: process.env.NEXT_PUBLIC_APP_COMMIT_SHA?.trim() || "unknown"
} as const;
