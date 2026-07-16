import test from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPassword, safeCompare } from "../server/password.js";

test("hashPassword produces a verifiable salt:hash pair", () => {
  const stored = hashPassword("correct-horse-battery-staple");
  assert.match(stored, /^[0-9a-f]+:[0-9a-f]+$/);
  assert.equal(verifyPassword("correct-horse-battery-staple", stored), true);
});

test("verifyPassword rejects incorrect passwords", () => {
  const stored = hashPassword("correct-horse-battery-staple");
  assert.equal(verifyPassword("wrong-password", stored), false);
});

test("verifyPassword rejects malformed stored values", () => {
  assert.equal(verifyPassword("anything", "not-a-valid-hash"), false);
});

test("safeCompare matches equal strings and rejects differing ones", () => {
  assert.equal(safeCompare("secret-code", "secret-code"), true);
  assert.equal(safeCompare("secret-code", "other-code!"), false);
  assert.equal(safeCompare("short", "muchlonger"), false);
});
