import { execFileSync } from "node:child_process";
import type { NextConfig } from "next";

function resolveGitSha(): string {
  if (process.env.GIT_SHA?.trim()) {
    return process.env.GIT_SHA.trim();
  }

  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8"
    }).trim();
  } catch {
    return "unknown";
  }
}

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  transpilePackages: [
    "@abos/contracts",
    "@abos/ui",
    "@abos/database",
    "@abos/finance",
    "@abos/identity",
    "@abos/persistence",
    "@abos/sandbox-auth",
    "@abos/shareholder",
    "@abos/treasury"
  ],
  // The PostgreSQL driver runs on the server only and is loaded as a plain Node package.
  serverExternalPackages: ["pg"],
  env: {
    NEXT_PUBLIC_APP_COMMIT_SHA: resolveGitSha()
  }
};

export default nextConfig;
