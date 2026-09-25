import { randomBytes, randomInt, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from "node:crypto";

/**
 * Password hashing with scrypt (RFC 7914), from Node's own crypto module.
 *
 * Stored form: `scrypt$N$r$p$<salt>$<hash>`, base64url, 16-byte salt, 64-byte key. The parameters
 * travel with the hash, so they can be raised later and old hashes still verify.
 */
export const SCRYPT_PARAMETERS = { N: 32768, r: 8, p: 1 } as const;
const KEY_LENGTH = 64;
const SALT_BYTES = 16;
// 128 * N * r = 32 MiB; Node's default ceiling is exactly 32 MiB, so leave headroom.
const MAX_MEMORY = 96 * 1024 * 1024;

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

function scrypt(password: string, salt: Buffer, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password.normalize("NFKC"), salt, KEY_LENGTH, options, (error, key) => {
      if (error) reject(error); else resolve(key);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const { N, r, p } = SCRYPT_PARAMETERS;
  const key = await scrypt(password, salt, { N, r, p, maxmem: MAX_MEMORY });
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

/** Constant-time comparison. A malformed stored hash never verifies. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltText, keyText] = parts;
  const N = Number(n); const R = Number(r); const P = Number(p);
  if (![N, R, P].every((value) => Number.isInteger(value) && value > 0) || N > 1_048_576 || R > 32 || P > 16) return false;
  const salt = Buffer.from(saltText ?? "", "base64url");
  const expected = Buffer.from(keyText ?? "", "base64url");
  if (salt.length < SALT_BYTES || expected.length !== KEY_LENGTH) return false;
  const actual = await scrypt(password, salt, { N, r: R, p: P, maxmem: MAX_MEMORY });
  return timingSafeEqual(actual, expected);
}

/**
 * A fixed, valid hash of a random value, verified against when the login is unknown so an unknown
 * login costs the same time as a wrong password.
 */
let decoyHash: Promise<string> | undefined;
export function decoyPasswordHash(): Promise<string> {
  decoyHash ??= hashPassword(randomBytes(32).toString("base64url"));
  return decoyHash;
}

export type PasswordProblem = "TOO_SHORT" | "TOO_LONG" | "CONTAINS_LOGIN" | "TOO_SIMPLE";

/** Length-first policy (NIST SP 800-63B style): no forced symbol rules, reject the obvious. */
export function passwordProblems(password: string, loginIdentifier: string): readonly PasswordProblem[] {
  const problems: PasswordProblem[] = [];
  const length = [...password].length;
  if (length < PASSWORD_MIN_LENGTH) problems.push("TOO_SHORT");
  if (length > PASSWORD_MAX_LENGTH) problems.push("TOO_LONG");
  const login = loginIdentifier.trim().toLowerCase();
  if (login.length >= 3 && password.toLowerCase().includes(login)) problems.push("CONTAINS_LOGIN");
  if (new Set(password).size < 5) problems.push("TOO_SIMPLE");
  return problems;
}

const TEMPORARY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

/** A one-time temporary password, shown once to the administrator and never stored in clear. */
export function generateTemporaryPassword(length = 16): string {
  let value = "";
  for (let index = 0; index < length; index += 1) value += TEMPORARY_ALPHABET[randomInt(TEMPORARY_ALPHABET.length)];
  return value;
}
