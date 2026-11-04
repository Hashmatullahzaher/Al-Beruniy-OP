import { chmodSync, writeFileSync } from "node:fs";

/**
 * Credentials a seed creates. They never reach stdout or stderr: output is captured by shells, logs and tools, in whatever
 * encoding, and redacting it afterwards is not reliable. A seed writes them only to the file its operator names.
 */
export interface SeedCredential {
  readonly name: string;
  readonly login: string;
  readonly password: string;
  readonly role: string;
}

export interface SeedSession {
  readonly name: string;
  readonly role: string;
  readonly token: string;
}

export const SEED_CREDENTIALS_VARIABLE = "ABOS_SEED_CREDENTIALS_FILE";

/** The file the operator named. Called before a seed changes anything, so a missing setting costs nothing. */
export function seedCredentialsFile(environment: Readonly<Record<string, string | undefined>>): string {
  const file = environment[SEED_CREDENTIALS_VARIABLE]?.trim();
  if (!file) throw new Error(`${SEED_CREDENTIALS_VARIABLE} is not set: name a private file for the generated passwords; they are never printed`);
  return file;
}

export function writeSeedCredentials(file: string, credentials: readonly (SeedCredential | SeedSession)[]): void {
  writeFileSync(file, `${JSON.stringify(credentials, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(file, 0o600);
}

/** What a seed may print: who exists and where the passwords went, never a password. */
export function seedSummary(heading: string, file: string, credentials: readonly Omit<SeedCredential, "password">[]): string {
  const rows = credentials.map((row) => `${row.name.padEnd(30)}${row.login.padEnd(26)}${row.role}`);
  return [`\n${heading}`, `Passwords were written to ${file} and are not printed.\n`, `${"Person".padEnd(30)}${"Username".padEnd(26)}Role`, ...rows, ""].join("\n");
}
