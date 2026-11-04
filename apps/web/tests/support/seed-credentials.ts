import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Runs a seed and reads back the passwords it generated. They arrive through a file in a fresh private directory, which is
 * removed before this returns, so they never pass through a console or a test log. Every run also proves it: the seed's output
 * must not contain any password, as UTF-8 or UTF-16. ABOS_SEED_CREDENTIALS_DIR overrides where that directory is created.
 */
export function seedAccounts(script: "preview:seed" | "preview:first-run", environment: Record<string, string | undefined>): Record<string, string> {
  const directory = mkdtempSync(join(environment.ABOS_SEED_CREDENTIALS_DIR ?? tmpdir(), "abos-seed-"));
  const file = join(directory, "credentials.json");
  try {
    const run = spawnSync("pnpm", ["--filter", "@abos/e1-integration", script], {
      cwd: resolve(__dirname, "../../../.."), env: { ...process.env, ...environment, ABOS_SEED_CREDENTIALS_FILE: file } as NodeJS.ProcessEnv, shell: process.platform === "win32"
    });
    if (run.status !== 0) throw new Error(`${script} failed: ${run.stderr.toString("utf8")}`);
    const rows = JSON.parse(readFileSync(file, "utf8")) as { readonly login: string; readonly password: string }[];
    const output = Buffer.concat([run.stdout, run.stderr]);
    for (const row of rows) {
      for (const encoding of ["utf8", "utf16le"] as const) {
        if (output.includes(Buffer.from(row.password, encoding))) throw new Error(`${script} printed a credential`);
      }
    }
    return Object.fromEntries(rows.map((row) => [row.login, row.password]));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
