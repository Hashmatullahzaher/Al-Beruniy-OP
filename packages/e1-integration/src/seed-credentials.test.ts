import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { SEED_CREDENTIALS_VARIABLE, seedCredentialsFile, seedSummary, writeSeedCredentials } from "./seed-credentials.ts";

const row = { name: "Synthetic Person", login: "demo.person", password: "cedar-river-lantern-abc123", role: "Finance Manager" };

test("a seed refuses to run until a credentials file is named", () => {
  assert.throws(() => seedCredentialsFile({}), /ABOS_SEED_CREDENTIALS_FILE is not set/);
  assert.throws(() => seedCredentialsFile({ [SEED_CREDENTIALS_VARIABLE]: "  " }), /never printed/);
  const outside = join(tmpdir(), "private.json");
  assert.equal(seedCredentialsFile({ [SEED_CREDENTIALS_VARIABLE]: outside }), outside);
});

test("a credentials file inside the repository is refused, so it can never be committed", () => {
  for (const file of ["private.json", resolve(import.meta.dirname, "../../../apps/web/credentials.json")]) {
    assert.throws(() => seedCredentialsFile({ [SEED_CREDENTIALS_VARIABLE]: file }), /outside the repository/);
  }
});

test("the printed summary never contains a password, in UTF-8 or UTF-16, even when handed the full record", () => {
  const summary = seedSummary("Seeded.", "private.json", [row]);
  for (const encoding of ["utf8", "utf16le"] as const) {
    assert.equal(Buffer.from(summary, encoding).includes(Buffer.from(row.password, encoding)), false, encoding);
  }
  assert.match(summary, /demo\.person/);
});

test("the credentials go to the named file only", () => {
  const dir = mkdtempSync(join(tmpdir(), "abos-seed-test-"));
  try {
    const file = join(dir, "credentials.json");
    writeSeedCredentials(file, [row]);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), [row]);
    if (process.platform === "win32") {
      const access = execFileSync("icacls", [file], { encoding: "utf8" }).split(/\r?\n/).filter((line) => line.includes(":("));
      assert.equal(access.length, 1, "only the owner may read it");
      assert.match(access[0] ?? "", new RegExp(`${process.env.USERNAME}:\\(F\\)`, "i"));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("no seed script writes a password or token to stdout or stderr", () => {
  const scripts = resolve(import.meta.dirname, "../scripts");
  for (const name of readdirSync(scripts).filter((file) => file.endsWith(".ts"))) {
    const offending = readFileSync(join(scripts, name), "utf8").split(/\r?\n/).filter((line) =>
      /(process\.std(out|err)\.write|console\.(log|error|info|warn))/.test(line) && /\$\{[^}]*(password|passphrase|token|secret)/i.test(line));
    assert.deepEqual(offending, [], `${name} prints a credential`);
  }
});
