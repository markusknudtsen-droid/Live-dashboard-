import test from "node:test";
import assert from "node:assert/strict";
import { checkWithdrawalDestination } from "../server/withdrawalPolicy.js";
import { buildServerConfig } from "../server/env.js";

const ALLOWED = "5Es3873yq7yF2ZUWMc1UchDkyPzS8tZ3Kh5ntzjF1dhQ";
const OTHER = "11111111111111111111111111111111";

test("permits a withdrawal to the configured address", () => {
  assert.equal(checkWithdrawalDestination(ALLOWED, ALLOWED), null);
});

test("rejects a withdrawal to any other address", () => {
  const error = checkWithdrawalDestination(OTHER, ALLOWED);
  assert.ok(error, "a mismatched destination must be rejected");
  assert.match(error, /WITHDRAWAL_ADDRESS/);
});

test("an unset allowlist accepts any address, preserving prior behaviour", () => {
  assert.equal(checkWithdrawalDestination(OTHER, ""), null);
  assert.equal(checkWithdrawalDestination(ALLOWED, ""), null);
});

test("whitespace around the configured address does not defeat the lock", () => {
  assert.equal(checkWithdrawalDestination(ALLOWED, `  ${ALLOWED}  `), null);
  assert.ok(checkWithdrawalDestination(OTHER, `  ${ALLOWED}  `));
});

test("a whitespace-only allowlist is treated as unset, not as a blanket block", () => {
  assert.equal(checkWithdrawalDestination(OTHER, "   "), null);
});

test("base58 comparison is case-sensitive", () => {
  assert.ok(checkWithdrawalDestination(ALLOWED.toLowerCase(), ALLOWED));
});

test("buildServerConfig reads and trims WITHDRAWAL_ADDRESS", () => {
  assert.equal(buildServerConfig({ WITHDRAWAL_ADDRESS: ` ${ALLOWED} ` }).withdrawalAllowlistAddress, ALLOWED);
  assert.equal(buildServerConfig({}).withdrawalAllowlistAddress, "");
});
