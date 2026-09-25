import assert from "node:assert/strict";
import test from "node:test";

import { generateTemporaryPassword, hashPassword, passwordProblems, verifyPassword } from "./password.ts";

test("a password hash verifies the right password and nothing else", async () => {
  const hash = await hashPassword("correct horse battery staple");
  assert.match(hash, /^scrypt\$32768\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$/);
  assert.equal(await verifyPassword("correct horse battery staple", hash), true);
  assert.equal(await verifyPassword("correct horse battery stapl", hash), false);
  assert.equal(await verifyPassword("", hash), false);
});

test("the same password hashes differently each time and the clear text never appears", async () => {
  const first = await hashPassword("a-long-enough-secret");
  const second = await hashPassword("a-long-enough-secret");
  assert.notEqual(first, second);
  assert.equal(first.includes("a-long-enough-secret"), false);
});

test("malformed or tampered hashes never verify", async () => {
  const hash = await hashPassword("another long password");
  assert.equal(await verifyPassword("another long password", "plain-text"), false);
  assert.equal(await verifyPassword("another long password", hash.replace("scrypt$", "bcrypt$")), false);
  assert.equal(await verifyPassword("another long password", hash.slice(0, -4)), false);
  assert.equal(await verifyPassword("another long password", "scrypt$99999999$8$1$AAAAAAAAAAAAAAAAAAAAAA$" + "A".repeat(86)), false);
});

test("password rules reject short, login-containing and trivial passwords", () => {
  assert.deepEqual(passwordProblems("short", "cashier"), ["TOO_SHORT"]);
  assert.deepEqual(passwordProblems("aaab", "cashier"), ["TOO_SHORT", "TOO_SIMPLE"]);
  assert.deepEqual(passwordProblems("cashier-password-2026", "cashier"), ["CONTAINS_LOGIN"]);
  assert.deepEqual(passwordProblems("aaaaaaaaaaaaaaaa", "someone"), ["TOO_SIMPLE"]);
  assert.deepEqual(passwordProblems("Kabul safe count 7", "cashier"), []);
  assert.ok(passwordProblems("x".repeat(129), "someone").includes("TOO_LONG"));
});

test("temporary passwords are long, random and pass the rules", () => {
  const seen = new Set<string>();
  for (let index = 0; index < 50; index += 1) {
    const value = generateTemporaryPassword();
    assert.equal(value.length, 16);
    seen.add(value);
  }
  assert.equal(seen.size, 50);
});
