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
  },
  async headers() {
    const security = [
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "same-origin" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
      ...(process.env.NODE_ENV === "production" ? [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }] : [])
    ];
    return [{ source: "/:path*", headers: security }];
  }
};

export default nextConfig;
