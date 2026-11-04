import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Runs a seed and reads back the passwords it generated. They arrive through a file in a fresh private directory, which is
 * removed before this returns, so they never pass through a console or a test log. ABOS_SEED_CREDENTIALS_DIR overrides where
 * that directory is created.
 */
export function seedAccounts(script: "preview:seed" | "preview:first-run", environment: Record<string, string | undefined>): Record<string, string> {
  const directory = mkdtempSync(join(environment.ABOS_SEED_CREDENTIALS_DIR ?? tmpdir(), "abos-seed-"));
  const file = join(directory, "credentials.json");
  try {
    execFileSync("pnpm", ["--filter", "@abos/e1-integration", script], {
      cwd: resolve(__dirname, "../../../.."), env: { ...process.env, ...environment, ABOS_SEED_CREDENTIALS_FILE: file } as NodeJS.ProcessEnv, encoding: "utf8", shell: process.platform === "win32"
    });
    const rows = JSON.parse(readFileSync(file, "utf8")) as { readonly login: string; readonly password: string }[];
    return Object.fromEntries(rows.map((row) => [row.login, row.password]));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
